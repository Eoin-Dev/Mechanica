import { expect, test, type Page } from "@playwright/test";

async function savedState(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    const state = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
    return { scene: JSON.parse(state.scene), camera: state.presentation.camera as number[] };
  });
}

for (const mode of ["string", "wheel", "wall", "performance"] as const) {
  test(`pointer dragging stops at the permitted pulley position (${mode})`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(perf => localStorage.setItem("mechanica.settings", JSON.stringify({
      tour_done: true, theme: perf ? "light" : "dark", adaptive_dt: false, perf_mode: perf,
      drag_hits_walls: true,
    })), mode === "performance");
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Library", exact: true });
    await library.getByRole("tab", { name: "My scenes", exact: true }).click();
    const choosing = page.waitForEvent("filechooser");
    await library.getByRole("button", { name: "Import .json", exact: true }).click();
    await (await choosing).setFiles({ name: "Pulley drag.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0 }, bodies: [
        { id: 1, name: "Left particle", pos: [-0.22, -0.25], mass: 1, color: [50, 170, 150] },
        { id: 2, name: "Right particle", pos: [0.22, -0.25], mass: 1, color: [220, 130, 90] },
        { id: 3, name: "Wheel", pos: [0, 1], is_pulley: true },
      ], walls: [
        { id: 1, name: "Reference platform", a: [-2, -2.8], b: [2, -2.8], thickness: 0.04 },
        { id: 2, name: "Reference edge", a: [-2, 3.5], b: [-1.9, 3.5], thickness: 0.04 },
        ...(mode === "wall" ? [{ id: 3, name: "Partner ceiling", a: [0, 0.3], b: [2, 0.3], thickness: 0.04 }] : []),
      ], links: [{ type: "pulley", id: 1, a: 1, b: 2, pulley: 3,
        length: 2.5 + Math.PI * 0.22 + (mode === "wheel" ? 10 : 0.4) }] })) });
    await expect(library).toBeHidden();
    const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
    while (await dismiss.count()) await dismiss.first().click();
    const canvas = page.locator("#canvas"), bounds = (await canvas.boundingBox())!;
    const initial = await savedState(page), [cx, cy, zoom] = initial.camera;
    const screen = (x: number, y: number) => ({ x: bounds.x + bounds.width / 2 + (x - cx) * zoom,
      y: bounds.y + bounds.height / 2 - (y - cy) * zoom });
    const start = screen(-0.22, -0.25), target = screen(-0.22, mode === "wheel" ? 3 : -2.25);
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 12 });
    const terminalB = mode === "wall" ? 0.3 - 0.02 - 0.16 : 1 - Math.sqrt(0.38 ** 2 - 0.22 ** 2);
    const expectedA = mode === "wheel" ? terminalB : -0.65 - (terminalB + 0.25);
    await expect.poll(async () => (await savedState(page)).scene.bodies.find((body: { id: number }) => body.id === 1).pos[1])
      .toBeCloseTo(expectedA, mode === "performance" ? 5 : 8);
    // Captured motion beyond the stop cannot move the particle through it.
    await page.mouse.move(target.x, target.y + (mode === "wheel" ? -30 : 30));
    await expect.poll(async () => (await savedState(page)).scene.bodies.find((body: { id: number }) => body.id === 1).pos[1])
      .toBeCloseTo(expectedA, mode === "performance" ? 5 : 8);
    await page.mouse.up();
    const atStop = await savedState(page), a = atStop.scene.bodies.find((body: { id: number }) => body.id === 1),
      b = atStop.scene.bodies.find((body: { id: number }) => body.id === 2);
    expect(a.vel).toEqual([0, 0]); expect(atStop.scene.settings.time).toBe(0);
    if (mode !== "wheel") expect(b.pos[1]).toBeCloseTo(terminalB, mode === "performance" ? 5 : 8);
    expect(atStop.camera).toEqual(initial.camera);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath(`pulley-stop-${mode}.png`) });
    await page.getByRole("button", { name: "Undo the last edit (Ctrl+Z).", exact: true }).click();
    await expect.poll(async () => (await savedState(page)).scene.bodies.find((body: { id: number }) => body.id === 1).pos[1]).toBe(-0.25);
    const restored = await savedState(page);
    expect(restored.scene.bodies.find((body: { id: number }) => body.id === 2).pos[1]).toBe(-0.25);
    await page.getByRole("button", { name: "Redo the last undone edit (Ctrl+Y).", exact: true }).click();
    await expect.poll(async () => (await savedState(page)).scene.bodies.find((body: { id: number }) => body.id === 1).pos[1])
      .toBeCloseTo(expectedA, mode === "performance" ? 5 : 8);
    expect(errors).toEqual([]);
  });
}
