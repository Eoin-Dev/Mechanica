import { expect, test, type Page } from "@playwright/test";

async function savedState(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    const state = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
    return { scene: JSON.parse(state.scene), camera: state.presentation.camera as number[] };
  });
}

// Independent tangent-circle geometry for the upper wrapped path in this
// fixture. This reads no engine internals and includes the changing arc.
function wrappedLength(a: number[], b: number[]): number {
  const radius = 0.22, ra = Math.hypot(a[0], a[1] - 1), rb = Math.hypot(b[0], b[1] - 1);
  const tangentA = Math.atan2(a[1] - 1, a[0]) - Math.acos(radius / ra);
  const tangentB = Math.atan2(b[1] - 1, b[0]) + Math.acos(radius / rb);
  const arc = ((tangentA - tangentB) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return Math.sqrt(ra * ra - radius * radius) + Math.sqrt(rb * rb - radius * radius) + radius * arc;
}

function rayBoundary(pointer: number[], partner: number[], length: number): number[] {
  const distance = Math.hypot(pointer[0], pointer[1] - 1), nx = pointer[0] / distance, ny = (pointer[1] - 1) / distance;
  let lo = 0.38, hi = distance;
  for (let i = 0; i < 80; i++) {
    const middle = (lo + hi) / 2;
    if (wrappedLength([nx * middle, 1 + ny * middle], partner) <= length) lo = middle;
    else hi = middle;
  }
  return [nx * lo, 1 + ny * lo];
}

for (const mode of ["string", "wheel", "wall", "performance", "locked"] as const) {
  test.describe(() => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test(`pointer dragging stops at the permitted pulley position (${mode})`, async ({ page }, testInfo) => {
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(perf => localStorage.setItem("mechanica.settings", JSON.stringify({
        tour_done: true, theme: perf ? "light" : "dark", adaptive_dt: false, perf_mode: perf,
        drag_hits_walls: true,
      })), mode === "performance");
      await page.addInitScript(() => {
        document.addEventListener("pointermove", event => {
          (window as unknown as { pulleyTestPointer: number[] }).pulleyTestPointer = [event.clientX, event.clientY];
        }, true);
      });
      await page.goto("/");
      await page.getByRole("button", { name: "Library", exact: true }).click();
      const library = page.getByRole("dialog", { name: "Library", exact: true });
      await library.getByRole("tab", { name: "My scenes", exact: true }).click();
      const choosing = page.waitForEvent("filechooser");
      await library.getByRole("button", { name: "Import .json", exact: true }).click();
      await (await choosing).setFiles({ name: "Pulley drag.json", mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0 }, bodies: [
          { id: 1, name: "Left particle", pos: [-0.22, -0.25], mass: 1, color: [50, 170, 150] },
          { id: 2, name: "Right particle", pos: [0.22, -0.25], mass: 1, color: [220, 130, 90], locked: mode === "locked" },
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
      // Native pointer events quantize requested CSS coordinates differently
      // across browsers. Compare the physics to the coordinates actually
      // delivered to the app, preserving the tight geometric tolerance.
      const pointer = () => page.evaluate(({ bounds, cx, cy, zoom }) => {
        const [x, y] = (window as unknown as { pulleyTestPointer: number[] }).pulleyTestPointer;
        return [cx + (x - bounds.x - bounds.width / 2) / zoom,
          cy - (y - bounds.y - bounds.height / 2) / zoom];
      }, { bounds, cx, cy, zoom });
      // The locked fixture grabs off centre: its constrained position must use
      // the real pointer ray, without retaining the initial grab offset.
      const start = screen(mode === "locked" ? -0.14 : -0.22, -0.25);
      const target = screen(-0.22, mode === "wheel" ? 3 : -2.25);
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 12 });
      const terminalB = mode === "locked" ? -0.25 : mode === "wall" ? 0.3 - 0.02 - 0.16 : 1 - Math.sqrt(0.38 ** 2 - 0.22 ** 2);
      const length = 2.5 + Math.PI * 0.22 + 0.4;
      let expectedA = mode === "wheel" ? [-0.22, terminalB] : rayBoundary(await pointer(), [0.22, terminalB], length);
      const particle = async () => (await savedState(page)).scene.bodies.find((body: { id: number }) => body.id === 1);
      const precision = mode === "performance" ? 5 : 7;
      const expectPosition = async (expected: number[]) => {
        for (const axis of [0, 1]) await expect.poll(async () => (await particle()).pos[axis]).toBeCloseTo(expected[axis], precision);
      };
      await expectPosition(expectedA);
      if (mode === "wheel") {
        await page.mouse.move(target.x, target.y - 30);
        await expectPosition(expectedA);
      } else {
        // More distance on the requested ray leaves the boundary unchanged
        // within one CSS pixel; Firefox/WebKit quantize native mouse positions
        // to whole pixels, so the delivered ray can differ by a fraction of one.
        const beyond = screen(-0.22 * 1.1, 1 + (-2.25 - 1) * 1.1);
        await page.mouse.move(beyond.x, beyond.y);
        const beyondExpected = rayBoundary(await pointer(), [0.22, terminalB], length);
        await expectPosition(beyondExpected);
        const beyondActual = (await particle()).pos;
        expect(Math.hypot(beyondActual[0] - expectedA[0], beyondActual[1] - expectedA[1]) * zoom).toBeLessThan(1);
        let previous = expectedA;
        // Small changes must move immediately around the edge, in both
        // directions, even after the pointer has been parked outside the reach.
        for (const x of [-0.23, -0.24, -0.22]) {
          const cursor = screen(x, -2.25);
          await page.mouse.move(cursor.x, cursor.y);
          const delivered = await pointer(), expected = rayBoundary(delivered, [0.22, terminalB], length);
          await expectPosition(expected);
          const a = (await particle()).pos;
          expect(Math.hypot(a[0] - previous[0], a[1] - previous[1])).toBeGreaterThan(0.0001);
          expect(Math.abs(a[0] * (delivered[1] - 1) - (a[1] - 1) * delivered[0])).toBeLessThan(1e-9);
          expect(wrappedLength(a, [0.22, terminalB])).toBeCloseTo(length, precision);
          previous = a;
          expectedA = expected;
        }
      }
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
      await expectPosition(expectedA);
      expect(errors).toEqual([]);
    });
  });
}
