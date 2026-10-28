import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Configure the setup size before creating the page; keep loaded-app resizes below.
test.use({ viewport: { width: 1440, height: 900 } });

async function scene(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    const recovery = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
    return { world: JSON.parse(recovery.scene), camera: recovery.presentation.camera };
  });
}
async function point(page: Page, x: number, y: number) {
  let previous = "";
  await expect.poll(async () => {
    const key = (await scene(page)).camera.map((n: number) => n.toFixed(5)).join(",");
    const settled = previous === key; previous = key; return settled;
  }, { intervals: [50, 100, 200] }).toBe(true);
  const camera = (await scene(page)).camera, box = (await page.locator("#canvas").boundingBox())!;
  return { x: box.x + box.width / 2 + (x - camera[0]) * camera[2],
    y: box.y + box.height / 2 - (y - camera[1]) * camera[2] };
}
async function dismiss(page: Page) {
  const notices = page.getByRole("button", { name: "Dismiss notification", exact: true });
  while (await notices.count()) await notices.first().click();
}
async function importScene(page: Page, world: unknown) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Delete zones.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(world)) });
  await expect(library).toBeHidden(); await dismiss(page);
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, scene_load_hint_seen: true })));
  await page.goto("/");
});

test("draws, edits, moves and restores all three persistent delete-zone shapes", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await importScene(page, { settings: { gravity: 0 }, bodies: [] });
  const panel = page.locator("#inspector"), shapes = ["Circle", "Rectangle", "Capsule"];
  for (const [index, shape] of shapes.entries()) {
    await page.locator("#canvas").focus(); await page.keyboard.press("x");
    await panel.getByRole("button", { name: `${shape} zone`, exact: true }).click();
    if (index === 0) await page.screenshot({ path: info.outputPath("delete-tool-shape-modes.png") });
    const start = await point(page, -2 + index * 2, 1), end = await point(page, -1 + index * 2, 0);
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
    await expect(panel.getByRole("group", { name: "Delete zone properties", exact: true })).toBeVisible();
    await expect.poll(async () => (await scene(page)).world.delete_zones.length).toBe(index + 1);
  }
  const width = panel.getByRole("textbox", { name: "Width (type an exact value)", exact: true });
  await width.fill("1.4"); await width.press("Enter");
  await expect.poll(async () => (await scene(page)).world.delete_zones[2].width).toBeCloseTo(1.4, 6);
  const before = (await scene(page)).world.delete_zones[2];
  const from = await point(page, before.pos[0], before.pos[1]), to = await point(page, before.pos[0], before.pos[1] - 1.2);
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up();
  // Browser pointer coordinates may quantize to a CSS pixel; use that physical
  // input resolution while requiring undo to restore the exact authored value.
  const zoom = (await scene(page)).camera[2];
  await expect.poll(async () => Math.abs((await scene(page)).world.delete_zones[2].pos[1] -
    (before.pos[1] - 1.2))).toBeLessThan(1.5 / zoom);
  await page.locator("#canvas").focus(); await page.keyboard.press("Control+z");
  await expect.poll(async () => (await scene(page)).world.delete_zones[2].pos[1]).toBeCloseTo(before.pos[1], 4);
  const saved = (await scene(page)).world.delete_zones;
  await page.reload(); await expect.poll(async () => (await scene(page)).world.delete_zones).toEqual(saved);
  expect((await new AxeBuilder({ page }).include("#inspector").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("editable-delete-zones.png") }); expect(errors).toEqual([]);
});

test("phone users can choose a shape, draw with the panel hidden and edit the resulting zone", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await importScene(page, { settings: { gravity: 0 }, bodies: [] });
  await page.locator("#canvas").focus(); await page.keyboard.press("x");
  const panel = page.locator("#inspector");
  const open = page.getByRole("button", { name: "Open Inspector", exact: true });
  if (await open.isVisible()) await open.click();
  await panel.getByRole("button", { name: "Rectangle zone", exact: true }).click();
  const modes = await panel.locator(".delete-zone-modes").evaluate(root => {
    const parent = root.getBoundingClientRect();
    return [...root.querySelectorAll("button")].map(button => {
      const box = button.getBoundingClientRect();
      return { fits: box.left >= parent.left && box.right <= parent.right + 1,
        textFits: button.scrollWidth <= button.clientWidth + 1 };
    });
  });
  expect(modes).toHaveLength(4);
  for (const mode of modes) expect(mode).toEqual({ fits: true, textFits: true });
  await page.screenshot({ path: info.outputPath("phone-delete-tool-modes.png") });
  await panel.getByRole("button", { name: "Hide Inspector", exact: true }).click();
  const start = await point(page, -.6, .3), end = await point(page, .6, -.3);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await scene(page)).world.delete_zones?.length ?? 0).toBe(1);
  if (await open.isVisible()) await open.click();
  await expect(panel.getByRole("group", { name: "Delete zone properties", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include("#inspector").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("phone-delete-zone-properties.png") });
});

test("pool pockets remove a shot particle, preserve cushions and restore it on rewind", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("button", { name: "Load Billiard break", exact: true }).click();
  await expect(library).toBeHidden(); await dismiss(page);
  const pool = (await scene(page)).world;
  expect(pool.delete_zones).toHaveLength(6); expect(pool.walls).toHaveLength(6);
  await page.screenshot({ path: info.outputPath("pool-table-six-pockets.png") });
  pool.bodies = [{ id: 1, name: "Pocket shot", pos: [0, 1.3], vel: [0, 2], radius: .11, mass: .17,
    restitution: .95, friction: .05 }];
  await importScene(page, pool); await page.locator("#canvas").focus();
  for (let frame = 0; frame < 20 && (await scene(page)).world.bodies.length; frame++) await page.keyboard.press(".");
  const pocketed = (await scene(page)).world;
  expect(pocketed.bodies).toHaveLength(0); expect(pocketed.walls).toHaveLength(6); expect(pocketed.delete_zones).toHaveLength(6);
  await page.keyboard.press(","); await expect.poll(async () => (await scene(page)).world.bodies.length).toBe(1);
  expect((await scene(page)).world.delete_zones).toEqual(pool.delete_zones);
  await page.screenshot({ path: info.outputPath("pocket-shot-rewound.png") }); expect(errors).toEqual([]);
});

test("fast rods and strings crossing a zone are removed while their clear endpoints survive and rewind", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  for (const kind of ["rod", "rope", "spring", "elastic"]) {
    const spring = kind === "spring" || kind === "elastic";
    await importScene(page, { settings: { gravity: 0, substeps: 1 },
      bodies: [-1.5, 1.5].map((x, index) => ({ id: index + 1, name: `Endpoint ${index + 1}`,
        pos: [x, -1], vel: [0, 120], radius: .05, mass: 1, collides: false })),
      links: [{ id: 1, type: spring ? "spring" : "rod", a: 1, b: 2,
        length: 3, is_rope: kind === "rope", rest_length: 3, stiffness: 0,
        damping: 0, tension_only: kind === "elastic" }],
      delete_zones: [{ id: 1, pos: [0, 0], shape: "rectangle", width: .1, height: .1 }] });
    const before = (await scene(page)).world;
    await page.locator("#canvas").focus(); await page.keyboard.press(".");
    await expect.poll(async () => (await scene(page)).world.links.length).toBe(0);
    const after = (await scene(page)).world;
    expect(after.bodies).toHaveLength(2); expect(after.delete_zones).toHaveLength(1);
    for (const body of after.bodies) { expect(body.pos[1]).toBeCloseTo(1, 8); expect(body.vel[1]).toBe(120); }
    await page.keyboard.press(",");
    const restored = (await scene(page)).world;
    expect(restored.links).toEqual(before.links); expect(restored.bodies).toEqual(before.bodies);
  }
  await page.screenshot({ path: info.outputPath("swept-links-restored.png") }); expect(errors).toEqual([]);
});

test("swept pulley legs and route release delete coherently while chord-only misses survive", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  for (const scenario of [
    { name: "wrapped leg", wheelY: 3, turns: 0, xs: [-1.5, 1.5], y: -1, vy: 120, zoneX: -1.3, zoneY: 0, hits: true },
    { name: "released string", wheelY: 3, turns: -1, xs: [-1.5, 1.5], y: -1, vy: 120, zoneX: 0, zoneY: 0, hits: true },
    { name: "wrap release", wheelY: 0, turns: -1, xs: [1.5, -1.5], y: -.1, vy: -120, zoneX: 0, zoneY: -1, hits: true },
    { name: "chord-only miss", wheelY: 3, turns: 0, xs: [-1.5, 1.5], y: -1, vy: 120, zoneX: 0, zoneY: 0, hits: false },
  ]) {
    await importScene(page, { settings: { gravity: 0, substeps: 1 },
      bodies: [
        ...scenario.xs.map((x, index) => ({ id: index + 1, name: `Particle ${index + 1}`,
          pos: [x, scenario.y], vel: [0, scenario.vy], mass: 1, collides: false })),
        { id: 3, name: "Wheel", pos: [0, scenario.wheelY], is_pulley: true },
      ],
      links: [{ id: 1, type: "pulley", a: 1, b: 2, pulley: 3, length: 20,
        wrap_sweep: -Math.PI, wrap_turns: scenario.turns }],
      delete_zones: [{ id: 1, pos: [scenario.zoneX, scenario.zoneY], shape: "circle", width: .04, height: .04 }] });
    const before = (await scene(page)).world;
    await page.locator("#canvas").focus(); await page.keyboard.press(".");
    await expect.poll(async () => (await scene(page)).world.settings.time).toBeGreaterThan(.016);
    const after = (await scene(page)).world;
    expect(after.links, scenario.name).toHaveLength(scenario.hits ? 0 : 1);
    expect(after.bodies, scenario.name).toHaveLength(scenario.hits ? 2 : 3);
    for (const body of after.bodies) if (!body.is_pulley) {
      expect(body.pos[1], scenario.name).toBeCloseTo(scenario.y + scenario.vy / 60, 8);
      expect(body.vel[1], scenario.name).toBe(scenario.vy);
    }
    await page.keyboard.press(",");
    const restored = (await scene(page)).world;
    expect(restored.links).toEqual(before.links); expect(restored.bodies).toEqual(before.bodies);
  }
  await page.screenshot({ path: info.outputPath("routed-zone-crossings-restored.png") }); expect(errors).toEqual([]);
});
