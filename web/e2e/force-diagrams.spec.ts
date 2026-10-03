import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type Caption = { text: string; left: number; right: number; top: number; bottom: number };

async function loadScene(page: Page, scene: unknown) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Contact investigation.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(scene)) });
  await expect(library).toBeHidden();
}

async function pickParticle(page: Page, colour: number[]) {
  const canvas = page.locator("#canvas");
  let point: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    point = await canvas.evaluate((element, colour) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let xSum = 0, ySum = 0, count = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (colour.every((channel, c) => Math.abs(pixels[i + c] - channel) <= 1)) {
          xSum += x; ySum += y; count++;
        }
      }
      return count ? { x: xSum / count * canvas.clientWidth / canvas.width,
        y: ySum / count * canvas.clientHeight / canvas.height } : null;
    }, colour);
    return point !== null;
  }).toBe(true);
  await canvas.click({ position: point! });
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, theme: "light" }));
    const captions: Caption[] = [];
    Object.defineProperty(window, "contactCaptions", { value: captions });
    const paint = { width: 0, height: 0 };
    Object.defineProperty(window, "contactPaint", { value: paint });
    const clear = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function(x, y, w, h) {
      if (this.canvas.id === "canvas" && x === 0 && y === 0 && w > 100 && h > 100) {
        paint.width = w; paint.height = h; captions.length = 0;
      }
      clear.call(this, x, y, w, h);
    };
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
      if (this.canvas.id === "canvas" && /^[WRTFPfC][₀-₉]*[∥⊥]?\s.*N$/.test(text)) {
        const metrics = this.measureText(text);
        captions.push({ text, left: x - metrics.actualBoundingBoxLeft,
          right: x + metrics.actualBoundingBoxRight, top: y - metrics.actualBoundingBoxAscent,
          bottom: y + metrics.actualBoundingBoxDescent });
      }
      if (maxWidth === undefined) fill.call(this, text, x, y);
      else fill.call(this, text, x, y, maxWidth);
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
});

test("current diagrams show all loaded slope contacts and update immediately through editing and undo", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const theta = 25 * Math.PI / 180, tx = Math.cos(theta), ty = -Math.sin(theta);
  await loadScene(page, { settings: { gravity: 9.81 },
    bodies: [-0.4, 0, 0.4].map((s, i) => ({ id: i + 1, name: ["Upper", "Middle", "Lower"][i],
      pos: [s * tx - 0.25 * ty, s * ty + 0.25 * tx], radius: 0.2, mass: 1,
      no_rotation: true, friction: 0, restitution: 0, locked: i === 2,
      color: [[110, 200, 210], [120, 190, 120], [220, 130, 90]][i] })),
    walls: [{ id: 1, name: "Slope", a: [-3 * tx, -3 * ty], b: [3 * tx, 3 * ty],
      thickness: 0.1, friction: 0, restitution: 0 }] });
  await pickParticle(page, [120, 190, 120]);
  const toggle = page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true });
  await toggle.check();
  const summary = page.locator(".force-values > summary");
  await expect(summary).toBeVisible();
  await summary.focus(); await page.keyboard.press("Enter");
  const sources = page.getByRole("list", { name: "Force values and sources", exact: true });
  await expect(sources.getByRole("listitem")).toHaveCount(5);
  for (const name of ["R₁: Reaction from Upper", "R₂: Reaction from Lower", "R₃: Reaction from Slope"]) {
    await expect(sources).toContainText(name);
  }
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  await expect(clock).toHaveValue("0.00");
  await expect(page.locator(".force-interval-note")).toContainText("Current forces.");
  await expect(page.locator(".force-interval-note")).not.toContainText("Step once");
  await page.getByRole("checkbox", { name: "Resolve weight on slope", exact: true }).check();
  const readCaptions = () => page.evaluate(() =>
    (window as unknown as { contactCaptions: Caption[] }).contactCaptions.slice());
  await expect.poll(async () => (await readCaptions()).map(caption => caption.text).sort())
    .toEqual(["R₁ 4.15 N", "R₂ 8.29 N", "R₃ 8.89 N", "W∥ 4.15 N", "W⊥ 8.89 N"].sort());
  const mass = page.getByRole("textbox", { name: "Mass (type an exact value)", exact: true });
  await mass.fill("2"); await mass.press("Enter");
  await expect.poll(async () => (await readCaptions()).map(caption => caption.text).sort())
    .toEqual(["R₁ 4.15 N", "R₂ 12.44 N", "R₃ 17.78 N", "W∥ 8.29 N", "W⊥ 17.78 N"].sort());
  await expect(clock).toHaveValue("0.00");
  await page.locator("#canvas").click({ position: { x: 15, y: 15 } });
  await page.keyboard.press("Control+z");
  await pickParticle(page, [120, 190, 120]);
  await expect(toggle).toBeChecked(); await expect(mass).toHaveValue("1 kg");
  await expect.poll(async () => (await readCaptions()).map(caption => caption.text).sort())
    .toEqual(["R₁ 4.15 N", "R₂ 8.29 N", "R₃ 8.89 N", "W∥ 4.15 N", "W⊥ 8.89 N"].sort());
  for (const [layout, width, theme] of [
    ["light", 1440, "Light"], ["dark", 1440, "Dark"], ["void", 1440, "Void"],
    ["phone-enlarged", 390, "Light"],
  ] as const) {
    await page.locator("#btn-settings").click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: theme, exact: true }).click();
    if (width === 390) await settings.getByRole("button", { name: "120%", exact: true }).click();
    await page.keyboard.press("Escape"); await page.setViewportSize({ width, height: 900 });
    const hide = page.getByRole("button", { name: "Hide Inspector", exact: true });
    if (width === 390 && await hide.isVisible()) await hide.click();
    await expect.poll(() => page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
      const frame = window as unknown as { contactPaint: { width: number; height: number }; contactCaptions: Caption[] };
      return frame.contactPaint.width === canvas.clientWidth && frame.contactPaint.height === canvas.clientHeight &&
        frame.contactCaptions.filter(caption => /^R[₁₂₃] /.test(caption.text)).length === 3;
    })).toBe(true);
    const bounds = await page.locator("#canvas").evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
    const captions = await readCaptions();
    for (const caption of captions) {
      expect(caption.left).toBeGreaterThanOrEqual(0); expect(caption.right).toBeLessThanOrEqual(bounds.width);
      expect(caption.top).toBeGreaterThanOrEqual(0); expect(caption.bottom).toBeLessThanOrEqual(bounds.height);
    }
    for (let i = 0; i < captions.length; i++) for (let j = i + 1; j < captions.length; j++) {
      const a = captions[i], b = captions[j];
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath(`immediate-contact-diagram-${layout}.png`) });
    expect((await new AxeBuilder({ page }).include("#inspector")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze()).violations).toEqual([]);
    await expect(clock).toHaveValue("0.00");
  }
  expect(errors).toEqual([]);
});

test("a floor-supported pulley displays its coupled tension and reaction without a first step", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await loadScene(page, { settings: { gravity: 9.81 }, bodies: [
    { id: 1, name: "Supported mass", pos: [-0.22, 0], mass: 3, color: [50, 170, 150] },
    { id: 2, name: "Hanging mass", pos: [0.22, 0], mass: 1, color: [220, 130, 90] },
    { id: 3, name: "Wheel", pos: [0, 2], is_pulley: true },
  ], walls: [{ id: 1, name: "Floor", a: [-2, -0.18], b: [-0.01, -0.18], thickness: 0.04,
    restitution: 0, friction: 0 }], links: [{ type: "pulley", id: 1, a: 1, b: 2, pulley: 3 }] });
  await pickParticle(page, [50, 170, 150]);
  await page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
  await page.locator(".force-values > summary").click();
  const sources = page.getByRole("list", { name: "Force values and sources", exact: true });
  await expect(sources).toContainText("T: Pulley-string tension");
  await expect(sources.getByRole("listitem").filter({ hasText: "Pulley-string tension" })).toContainText("Fy 9.81 N");
  await expect(sources.getByRole("listitem").filter({ hasText: "Reaction from Floor" })).toContainText("Fy 19.62 N");
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  await expect(clock).toHaveValue("0.00");
  await page.screenshot({ path: testInfo.outputPath("immediate-supported-pulley.png") });
  expect((await new AxeBuilder({ page }).include("#inspector")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("a terminal pulley stop displays matching tensions and its rim reaction immediately", async ({ page }, testInfo) => {
  const stoppedY = 1 - Math.sqrt(0.38 ** 2 - 0.22 ** 2);
  await loadScene(page, { settings: { gravity: 9.81, substeps: 8, integrator: "Velocity Verlet" },
    bodies: [
      { id: 1, name: "Free mass", pos: [-0.22, -2.5], mass: 2, collides: false,
        color: [50, 170, 150] },
      { id: 2, name: "Stopped mass", pos: [0.22, stoppedY], mass: 1, collides: false,
        color: [220, 130, 90] },
      { id: 3, name: "Wheel", pos: [0, 1], is_pulley: true },
    ], links: [{ type: "pulley", id: 1, a: 1, b: 2, pulley: 3 }] });
  const toggle = page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true });
  const sources = page.getByRole("list", { name: "Force values and sources", exact: true });
  const summary = page.locator(".force-values > summary");
  await pickParticle(page, [50, 170, 150]); await toggle.check(); await summary.click();
  await expect(sources.getByRole("listitem").filter({ hasText: "Pulley-string tension" })).toContainText("Fy 19.62 N");
  await pickParticle(page, [220, 130, 90]); await toggle.check();
  await expect(page.locator(".force-values")).toHaveJSProperty("open", true);
  const tension = sources.getByRole("listitem").filter({ hasText: "Pulley-string tension" });
  const reaction = sources.getByRole("listitem").filter({ hasText: "Pulley-frame reaction" });
  await expect(tension).toContainText("Fy 19.62 N");
  await expect(reaction).toContainText("Fy -9.81 N");
  await expect(sources).not.toContainText("correction");
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  await expect(clock).toHaveValue("0.00");
  await page.locator("#canvas").focus(); await page.keyboard.press(".");
  await expect(clock).toHaveValue("0.02");
  await expect(tension).toContainText("Fy 19.62 N");
  await expect(reaction).toContainText("Fy -9.81 N");
  await expect(sources).not.toContainText("correction");
  await page.screenshot({ path: testInfo.outputPath("terminal-pulley-forces.png") });
  expect((await new AxeBuilder({ page }).include("#inspector")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze()).violations).toEqual([]);
});

test("rewinding restores completed impact captions and their measured interval after separation", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("mechanica.settings", JSON.stringify({
      tour_done: true, theme: "light", adaptive_dt: false,
    }));
  });
  await page.reload();
  await loadScene(page, { settings: { gravity: 0, integrator: "RK4", substeps: 4 },
    bodies: [{ id: 1, name: "Bouncing particle", pos: [0, 0.26], vel: [0, -3],
      radius: 0.2, mass: 1, restitution: 1, friction: 0, color: [120, 190, 120] }],
    walls: [{ id: 1, name: "Impact floor", a: [-3, 0], b: [3, 0], thickness: 0.04,
      restitution: 1, friction: 0 }] });
  await pickParticle(page, [120, 190, 120]);
  const toggle = page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true });
  await toggle.check();
  await page.locator(".force-values > summary").click();
  const sources = page.getByRole("list", { name: "Force values and sources", exact: true });
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  const captions = () => page.evaluate(() =>
    (window as unknown as { contactCaptions: Caption[] }).contactCaptions.map(caption => caption.text));
  const canvas = page.locator("#canvas");
  await canvas.focus(); await page.keyboard.press(".");
  await expect(clock).toHaveValue("0.013333");
  await expect(page.locator(".force-interval-note")).toContainText("Average forces: 0.008–0.013 s.");
  await expect(sources.getByRole("listitem").filter({ hasText: "Reaction from Impact floor" })).toContainText("Fy 1200.00 N");
  await expect.poll(captions).toContain("R 1200.00 N");
  await page.screenshot({ path: testInfo.outputPath("completed-impact-before-rewind.png") });

  await page.keyboard.press(".");
  await expect(clock).toHaveValue("0.03");
  await expect(sources).not.toContainText("Reaction from Impact floor");
  await expect.poll(captions).not.toContain("R 1200.00 N");
  await page.keyboard.press(",");
  await expect(clock).toHaveValue("0.013333"); await expect(toggle).toBeChecked();
  const disclosure = page.locator(".force-values");
  await expect(disclosure).toHaveJSProperty("open", true);
  await expect(page.locator(".force-interval-note")).toContainText("Average forces: 0.008–0.013 s.");
  await expect(sources.getByRole("listitem").filter({ hasText: "Reaction from Impact floor" })).toContainText("Fy 1200.00 N");
  await expect.poll(captions).toContain("R 1200.00 N");
  await page.screenshot({ path: testInfo.outputPath("completed-impact-restored.png") });
  expect(errors).toEqual([]);
});

test("surface forces start at the contact and identify their source across force colours and themes", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    type Segment = { x1: number; y1: number; x2: number; y2: number; colour: string; width: number };
    const frame = { width: 0, height: 0, segments: [] as Segment[],
      circles: [] as { x: number; y: number; r: number }[], text: [] as string[] };
    Object.defineProperty(window, "forceGeometry", { value: frame });
    const paths = new WeakMap<Path2D, { x: number; y: number; segments: Omit<Segment, "colour" | "width">[] }>();
    const move = Path2D.prototype.moveTo, line = Path2D.prototype.lineTo;
    Path2D.prototype.moveTo = function(x, y) {
      const state = paths.get(this) ?? { x, y, segments: [] };
      state.x = x; state.y = y; paths.set(this, state); move.call(this, x, y);
    };
    Path2D.prototype.lineTo = function(x, y) {
      const state = paths.get(this);
      if (state) { state.segments.push({ x1: state.x, y1: state.y, x2: x, y2: y }); state.x = x; state.y = y; }
      line.call(this, x, y);
    };
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function(x, y, w, h) {
      if (this.canvas.id === "canvas" && x === 0 && y === 0 && w > 100 && h > 100) {
        frame.width = w; frame.height = h;
        frame.segments.length = 0; frame.circles.length = 0; frame.text.length = 0;
      }
      fill.call(this, x, y, w, h);
    };
    const stroke: (this: CanvasRenderingContext2D, path?: Path2D) => void = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function(path?: Path2D) {
      if (this.canvas.id === "canvas" && path) for (const segment of paths.get(path)?.segments ?? []) {
        frame.segments.push({ ...segment, colour: String(this.strokeStyle), width: this.lineWidth });
      }
      if (path === undefined) stroke.call(this); else stroke.call(this, path);
    };
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function(x, y, r, a, b, anticlockwise) {
      if (this.canvas.id === "canvas" && r > 5) frame.circles.push({ x, y, r });
      arc.call(this, x, y, r, a, b, anticlockwise);
    };
    const text = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(value, x, y, maxWidth) {
      if (this.canvas.id === "canvas") frame.text.push(value);
      if (maxWidth === undefined) text.call(this, value, x, y); else text.call(this, value, x, y, maxWidth);
    };
  });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.reload();
  await loadScene(page, { settings: { gravity: 9.81 }, bodies: [
    { id: 1, name: "Sliding particle", pos: [0, 0.25], radius: 0.2, mass: 1,
      no_rotation: true, friction: 1, restitution: 0, const_force: [2, 0], color: [80, 225, 245] },
  ], walls: [{ id: 1, name: "Rough floor", a: [-1.2, 0], b: [1.2, 0], thickness: 0.1,
    friction: 1, restitution: 0 }] });
  await pickParticle(page, [80, 225, 245]);
  await page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
  await page.locator(".force-values > summary").click();
  const sources = page.getByRole("list", { name: "Force values and sources", exact: true });
  await expect(sources).toContainText("F: Friction from Rough floor");
  await expect(sources).toContainText("f: Applied force");
  const canvas = page.locator("#canvas");
  type Frame = { width: number; height: number;
    segments: { x1: number; y1: number; x2: number; y2: number; colour: string; width: number }[];
    circles: { x: number; y: number; r: number }[]; text: string[] };
  const geometry = () => page.evaluate(() => (window as unknown as { forceGeometry: Frame }).forceGeometry);
  for (const [name, width, weightColour, reactionColour, frictionColour] of [
    ["Dark", 1440, "#ff74a5", "#50e1f5", "#e8b5ff"],
    ["Void", 1440, "#ff74a5", "#50e1f5", "#e8b5ff"],
    ["Light", 390, "#af2350", "#005fa5", "#732da5"],
  ] as const) {
    await page.locator("#btn-settings").click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name, exact: true }).click();
    if (width === 390) await settings.getByRole("button", { name: "120%", exact: true }).click();
    await page.keyboard.press("Escape"); await page.setViewportSize({ width, height: 900 });
    const hide = page.getByRole("button", { name: "Hide Inspector", exact: true });
    if (width === 390 && await hide.isVisible()) await hide.click();
    let previous: number[] = [];
    let stableFrames = 0;
    await expect.poll(async () => {
      const frame = await geometry();
      const size = await canvas.evaluate(element => [element.clientWidth, element.clientHeight]);
      const friction = frame.segments.filter(s => s.colour === frictionColour && s.width === 2.5);
      if (frame.width !== size[0] || frame.height !== size[1] || friction.length !== 1) {
        previous = []; stableFrames = 0; return false;
      }
      const values = [friction[0].x1, friction[0].y1, friction[0].x2, friction[0].y2];
      stableFrames = previous.length && values.every((value, i) => Math.abs(value - previous[i]) < 0.05)
        ? stableFrames + 1 : 0;
      previous = values;
      return stableFrames >= 2;
    }).toBe(true);
    const frame = await geometry();
    const w = frame.segments.find(s => s.colour === weightColour && s.width === 2.5)!;
    const r = frame.segments.find(s => s.colour === reactionColour && s.width === 2.5)!;
    const f = frame.segments.find(s => s.colour === frictionColour && s.width === 2.5)!;
    const circle = frame.circles.filter(c => Math.abs(c.x - w.x1) < 0.01 && Math.abs(c.y - w.y1) < 0.01)
      .sort((a, b) => a.r - b.r)[0];
    expect(circle).toBeDefined(); expect(r.x1).toBeCloseTo(w.x1, 6);
    expect(r.y1 - w.y1).toBeCloseTo(circle.r, 6);
    expect(f.x1).toBeCloseTo(r.x1, 6); expect(f.y1).toBeCloseTo(r.y1, 6);
    expect(r.y2).toBeLessThan(r.y1); expect(f.x2).toBeLessThan(f.x1);
    expect(frame.segments.some(s => s.width === 6)).toBe(true);
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + (f.x1 + f.x2) / 2, box.y + f.y1);
    await expect.poll(async () => (await geometry()).text).toContain("Friction from Rough floor");
    await page.screenshot({ path: testInfo.outputPath(`contact-origin-hover-${name.toLowerCase()}.png`) });
    await page.mouse.move(5, 5);
    await expect.poll(async () => (await geometry()).text).not.toContain("Friction from Rough floor");
    await page.screenshot({ path: testInfo.outputPath(`contact-origin-${name.toLowerCase()}.png`) });
  }
  await expect(page.getByRole("textbox", { name: "Simulation time in seconds", exact: true })).toHaveValue("0.00");
  expect(errors).toEqual([]);
});
