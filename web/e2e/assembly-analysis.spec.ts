import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Configure the setup size before creating the page; keep loaded-app resizes below.
test.use({ viewport: { width: 1440, height: 900 } });

async function state(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    const data = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
    return { scene: JSON.parse(data.scene), view: data.presentation };
  });
}
async function at(page: Page, x: number, y: number) {
  let previous = "";
  await expect.poll(async () => {
    const key = (await state(page)).view.camera.map((value: number) => value.toFixed(5)).join(",");
    const settled = key === previous; previous = key; return settled;
  }, { intervals: [50, 100, 200] }).toBe(true);
  const camera = (await state(page)).view.camera;
  const box = (await page.locator("#canvas").boundingBox())!;
  return { x: box.x + box.width / 2 + (x - camera[0]) * camera[2],
    y: box.y + box.height / 2 - (y - camera[1]) * camera[2] };
}
async function dismiss(page: Page) {
  const button = page.getByRole("button", { name: "Dismiss notification", exact: true });
  while (await button.count()) await button.first().click();
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, scene_load_hint_seen: true, theme: "light" }));
    const captions: string[] = [];
    Object.defineProperty(window, "analysisCaptions", { value: captions });
    const positions: Record<string, Array<{ x: number; y: number }>> = {};
    Object.defineProperty(window, "analysisPositions", { value: positions });
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function(x, y, w, h) {
      if (this.canvas.id === "canvas" && x === 0 && y === 0 && w > 100 && h > 100) captions.length = 0;
      fill.call(this, x, y, w, h);
    };
    const text = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(value, x, y, maxWidth) {
      if (this.canvas.id === "canvas" && /^[JWRF] /.test(value)) captions.push(value);
      if (this.canvas.id === "canvas" && /^[WRFf] /.test(value)) {
        const samples = positions[value] ?? (positions[value] = []);
        samples.push({ x, y }); if (samples.length > 240) samples.shift();
      }
      if (maxWidth === undefined) text.call(this, value, x, y); else text.call(this, value, x, y, maxWidth);
    };
  });
  await page.goto("/");
});

test("paused collision impulses appear when diagrams are enabled and survive closing the Inspector and rewind", async ({ page }, info) => {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Impact.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({
    settings: { gravity: 0, substeps: 8 }, bodies: [{ id: 1, name: "Impact load", pos: [0, .2499],
      vel: [0, -2], radius: .2, mass: 2, restitution: 1, friction: 0 }],
    walls: [{ id: 1, name: "Floor", a: [-2, 0], b: [2, 0], thickness: .1, restitution: 1, friction: 0 }],
  })) });
  await expect(library).toBeHidden(); await dismiss(page);
  const point = await at(page, 0, .2499); await page.mouse.click(point.x, point.y);
  await page.locator("#canvas").focus(); await page.keyboard.press(".");
  const panel = page.locator("#inspector");
  await panel.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
  await expect(panel.locator(".force-impulses")).toContainText("Jy 8.00 N·s");
  await expect(panel.locator(".force-interval-note")).toHaveText("Current forces.");
  const captions = () => page.evaluate(() => (window as unknown as { analysisCaptions: string[] }).analysisCaptions.slice());
  await expect.poll(captions).toContain("J 8.00 N·s");
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  const time = await clock.inputValue();
  await panel.getByRole("button", { name: "Hide Inspector", exact: true }).click();
  await expect.poll(captions).toContain("J 8.00 N·s"); await expect(clock).toHaveValue(time);
  await page.screenshot({ path: info.outputPath("paused-impulse-panel-hidden.png") });
  await page.getByRole("button", { name: "Show Inspector", exact: true }).click();
  await expect(panel.locator(".force-impulses")).toContainText("Jy 8.00 N·s");
  await page.locator("#canvas").focus(); await page.keyboard.press(".");
  await expect.poll(captions).not.toContain("J 8.00 N·s");
  await page.keyboard.press(","); await expect.poll(captions).toContain("J 8.00 N·s");
  expect((await new AxeBuilder({ page }).include("#inspector").analyze()).violations).toEqual([]);
});

test("a supported particle at one substep keeps reaction forces without repeated impact arrows", async ({ page }, info) => {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Supported.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({
    settings: { gravity: 20, substeps: 1 }, bodies: [{ id: 1, name: "Supported load", pos: [0, .2499],
      vel: [0, 0], radius: .2, mass: 2, restitution: 0, friction: 0 }],
    walls: [{ id: 1, name: "Floor", a: [-2, 0], b: [2, 0], thickness: .1, restitution: 0, friction: 0 }],
  })) });
  await expect(library).toBeHidden(); await dismiss(page);
  const point = await at(page, 0, .2499); await page.mouse.click(point.x, point.y);
  const panel = page.locator("#inspector");
  await panel.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
  for (let frame = 0; frame < 5; frame++) {
    await page.locator("#canvas").focus(); await page.keyboard.press(".");
    await expect(panel.locator(".force-impulses")).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as unknown as { analysisCaptions: string[] })
      .analysisCaptions.includes("R 40.00 N"))).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { analysisCaptions: string[] })
      .analysisCaptions.some(caption => caption.startsWith("J ")))).toBe(false);
  }
  await page.screenshot({ path: info.outputPath("supported-no-impulse.png") });
});

test("force captions stay beside their sources through small live value changes", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Caption values.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({
    settings: { gravity: 10, substeps: 4 }, bodies: [{ id: 1, name: "Stationary load", pos: [0, .2499],
      vel: [0, 0], radius: .2, mass: 2, restitution: 0, friction: 1, no_rotation: true, const_force: [1, 0] }],
    walls: [{ id: 1, name: "Floor", a: [-3, 0], b: [3, 0], thickness: .1, restitution: 0, friction: 1 }],
  })) });
  await expect(library).toBeHidden(); await dismiss(page);
  const point = await at(page, 0, .2499); await page.mouse.click(point.x, point.y);
  const panel = page.locator("#inspector");
  await panel.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
  const play = page.getByRole("group", { name: "Simulation playback", exact: true }).getByRole("button").first();
  await play.click();
  const samples: Array<{ x: number; y: number }> = [];
  for (const value of [1, 1.01, .99, 1.02, .98, 1]) {
    const force = panel.getByRole("textbox", { name: "Fx (N)", exact: true });
    await force.fill(String(value)); await force.press("Enter");
    const caption = `f ${value.toFixed(2)} N`;
    await expect.poll(() => page.evaluate(text => (window as unknown as {
      analysisPositions: Record<string, Array<{ x: number; y: number }>>;
    }).analysisPositions[text]?.length ?? 0, caption)).toBeGreaterThan(0);
    samples.push(await page.evaluate(text => (window as unknown as {
      analysisPositions: Record<string, Array<{ x: number; y: number }>>;
    }).analysisPositions[text].at(-1)!, caption));
  }
  await play.click();
  const range = (key: "x" | "y") => Math.max(...samples.map(point => point[key])) - Math.min(...samples.map(point => point[key]));
  expect(range("x")).toBeLessThan(5); expect(range("y")).toBeLessThan(5);
  const load = (await state(page)).scene.bodies[0]; expect(Math.hypot(...load.vel)).toBeLessThan(.001);
  await info.attach("caption-live-samples", { body: Buffer.from(JSON.stringify(samples)), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("stable-live-force-captions.png") });
  expect(errors).toEqual([]);
});

test("rod component navigation persists for particles and pivot and exposes signed moments", async ({ page }, info) => {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("button", { name: "Load Balanced beam", exact: true }).click();
  await expect(library).toBeHidden(); await dismiss(page);
  const point = await at(page, -1, 0); await page.mouse.click(point.x, point.y);
  const panel = page.locator("#inspector"), assembly = panel.locator(".rod-assembly");
  await expect(assembly.getByRole("button")).toHaveCount(4);
  await panel.getByRole("checkbox", { name: "Rod moments", exact: true }).check();
  await expect(panel.locator(".force-moments")).toContainText("Moments about Anchor");
  await expect(panel.locator(".force-moments")).toContainText("19.60 N·m");
  await assembly.getByRole("button", { name: "Select rod particle: 1 kg · 2 m right", exact: true }).click();
  await expect(assembly.getByRole("button")).toHaveCount(4);
  await panel.getByRole("checkbox", { name: "Rod moments", exact: true }).check();
  await expect(panel.locator(".force-moments")).toContainText("−");
  await expect(panel.locator(".force-moments")).toContainText("-19.60 N·m");
  await assembly.getByRole("button", { name: "Select rod anchor: Anchor", exact: true }).click();
  await expect(assembly.getByRole("button")).toHaveCount(4);
  await assembly.getByRole("button", { name: "Select rod: Rod 1", exact: true }).click();
  await expect(assembly.getByRole("button")).toHaveCount(4);
  await expect(page.getByRole("textbox", { name: "Simulation time in seconds", exact: true })).toHaveValue("0.00");
  expect((await new AxeBuilder({ page }).include("#inspector").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("rod-component-navigation.png") });
});

test("Balanced beam with a spawned pulley's right particle attached keeps physics advancing", async ({ page }, info) => {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("button", { name: "Load Balanced beam", exact: true }).click();
  await expect(library).toBeHidden(); await dismiss(page);
  await page.locator("#canvas").focus(); await page.keyboard.press("p");
  const centre = await at(page, -2, 1.35); await page.mouse.click(centre.x, centre.y);
  await page.keyboard.press("v");
  const setup = (await state(page)).scene;
  const link = setup.links.find((link: { type: string }) => link.type === "pulley");
  const particle = setup.bodies.find((body: { id: number }) => body.id === link.b);
  const start = await at(page, particle.pos[0], particle.pos[1]), end = await at(page, -1.5, 0);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  // Rod attachment deliberately requires a slow approach. Protocol-generated
  // moves without elapsed time can exceed that speed in faster browser drivers.
  const moves = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 4));
  for (let step = 1; step <= moves; step++) {
    await page.waitForTimeout(25);
    await page.mouse.move(start.x + (end.x - start.x) * step / moves,
      start.y + (end.y - start.y) * step / moves);
  }
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).scene.bodies.find((body: { id: number }) => body.id === particle.id).rod_id).not.toBeNull();
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  const play = page.getByRole("group", { name: "Simulation playback", exact: true }).getByRole("button").first();
  const wallStart = Date.now(); await play.click();
  await expect.poll(async () => Number(await clock.inputValue()), { timeout: 10000 }).toBeGreaterThan(2);
  const elapsed = Date.now() - wallStart; await play.click();
  await info.attach("combined-assembly-timing", { body: Buffer.from(JSON.stringify({ elapsedMs: elapsed, simTime: await clock.inputValue() })), contentType: "application/json" });
  expect(elapsed).toBeLessThan(5000);
  await page.screenshot({ path: info.outputPath("combined-assembly-playing.png") });
});

for (const integrator of ["Velocity Verlet", "Symplectic Euler", "RK4"]) test(
  `heavy beam and pulley follow independent mechanics through a time jump and reset (${integrator})`, async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Library", exact: true });
    await library.getByRole("tab", { name: "My scenes", exact: true }).click();
    const choosing = page.waitForEvent("filechooser");
    await library.getByRole("button", { name: "Import .json", exact: true }).click();
    await (await choosing).setFiles({ name: "Heavy coupled beam.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({
      settings: { gravity: 9.8, substeps: 8, iterations: 12, integrator },
      bodies: [
        ...[-2, 2].map((x, i) => ({ id: i + 1, name: "Rod endpoint", pos: [x, 0], mass: .001,
          radius: .04, is_rod_endpoint: true, no_rotation: true, collides: false })),
        { id: 3, name: "Pivot", pos: [0, 0], locked: true, is_anchor: true, is_pivot: true, collides: false, rod_id: 1, rod_position: .5 },
        { id: 4, name: "Left load", pos: [-1, 0], mass: 2, collides: false, no_rotation: true, rod_id: 1, rod_position: .25 },
        { id: 5, name: "Right load", pos: [2, 0], mass: 1, collides: false, no_rotation: true, rod_id: 1, rod_position: 1 },
        { id: 6, name: "Counterweight", pos: [-.25, .7], mass: 1e6, collides: false },
        { id: 7, name: "Mounted particle", pos: [-1.7, 0], mass: 1, collides: false, rod_id: 1, rod_position: .075 },
        { id: 8, name: "Wheel", pos: [.3, 2.5], is_pulley: true },
      ],
      links: [{ id: 1, type: "rod", a: 1, b: 2, length: 4 },
        { id: 2, type: "pulley", a: 6, b: 7, pulley: 8, length: 5.878502557979201, wrap_sweep: -Math.PI, wrap_turns: 0 }],
    })) });
    await expect(library).toBeHidden(); await dismiss(page);
    const load = await at(page, -.25, .7); await page.mouse.click(load.x, load.y);
    await page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
    const before = (await state(page)).scene;
    const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
    await clock.fill("1"); await clock.press("Enter");
    await expect.poll(async () => (await state(page)).scene.settings.time).toBeCloseTo(1, 10);
    const after = (await state(page)).scene;
    type SavedBody = { id: number; mass: number; pos: number[]; vel: number[]; omega: number;
      locked: boolean; is_anchor: boolean; is_rod_endpoint: boolean };
    const physical = (after.bodies as SavedBody[]).filter(body => !body.locked && !body.is_anchor && !body.is_rod_endpoint);
    const counterweight = physical.find(body => body.id === 6)!;
    const energy = physical.reduce((sum, body) => sum + .5 * body.mass * (body.vel[0] ** 2 + body.vel[1] ** 2) +
      9.8 * body.mass * body.pos[1], 0);
    expect(physical.every(body => Math.abs(body.omega) < 1e-10)).toBe(true);
    expect(energy - 6860000).toBeLessThan(686);
    expect(Math.abs(energy - 6860000) / 6860000).toBeLessThan(integrator === "Symplectic Euler" ? .01 : 1e-4);
    const reference = [.05121851442110228, -.24824997237893234, 1.0654092257508347, 4.177384070613309];
    const actual = [...counterweight.pos, ...counterweight.vel];
    actual.forEach((value, i) => expect(Math.abs(value - reference[i])).toBeLessThan(integrator === "Symplectic Euler" ? .02 : 1e-4));
    await expect(page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true })).toBeChecked();
    await page.screenshot({ path: info.outputPath("heavy-coupled-reference.png") });
    await clock.fill("0"); await clock.press("Enter");
    await expect.poll(async () => (await state(page)).scene.settings.time).toBe(0);
    const restored = (await state(page)).scene;
    expect(restored.bodies).toEqual(before.bodies); expect(restored.links).toEqual(before.links);
    expect(errors).toEqual([]);
  });
