import { expect, test, type Page } from "@playwright/test";

async function importScene(page: Page, bodies: unknown[]): Promise<void> {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Arrow bounds.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0 }, bodies })) });
  await expect(library).toBeHidden();
}

async function saved(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    const state = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
    return { scene: state.scene as string, camera: state.presentation.camera as [number, number, number],
      vectorScale: state.presentation.view.vectorScale as number };
  });
}

for (const theme of ["light", "dark"] as const) for (const dpr of [1, 2]) {
  test.describe(`${theme}, DPR ${dpr}`, () => {
    test.use({ viewport: { width: 1440, height: 1280 }, deviceScaleFactor: dpr });

    test("free-body arrow tips stay within their physical envelope at every direction and scale", async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(theme => {
        localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, theme,
          studio_mode: true, adaptive_dt: false }));
        // Mirror only explicit solid paths on the scene canvas. This fixture
        // has no links or trails, so these are force shafts, heads and their
        // contrasting outlines; captions and particle painting stay separate.
        const state = { canvas: document.createElement("canvas"), revision: 0,
          transform: { a: 1, d: 1, e: 0, f: 0 } };
        Object.defineProperty(window, "arrowTipInk", { value: state });
        const mirror = (source: CanvasRenderingContext2D, paint: (target: CanvasRenderingContext2D) => void) => {
          const target = state.canvas.getContext("2d")!;
          const matrix = source.getTransform();
          state.transform = { a: matrix.a, d: matrix.d, e: matrix.e, f: matrix.f };
          target.setTransform(matrix);
          target.lineWidth = source.lineWidth; target.lineJoin = source.lineJoin;
          target.lineCap = source.lineCap; target.miterLimit = source.miterLimit;
          target.fillStyle = source.fillStyle; target.strokeStyle = source.strokeStyle;
          target.globalAlpha = source.globalAlpha;
          target.setLineDash([]);
          paint(target);
        };
        const fillRect = CanvasRenderingContext2D.prototype.fillRect;
        CanvasRenderingContext2D.prototype.fillRect = function(x, y, w, h) {
          if (this.canvas.id === "canvas" && x === 0 && y === 0 && w > 100 && h > 100) {
            state.canvas.width = this.canvas.width; state.canvas.height = this.canvas.height;
            state.revision++;
          }
          fillRect.call(this, x, y, w, h);
        };
        const stroke = CanvasRenderingContext2D.prototype.stroke;
        CanvasRenderingContext2D.prototype.stroke = function(...args: unknown[]) {
          if (this.canvas.id === "canvas" && args[0] instanceof Path2D && this.getLineDash().length === 0) {
            mirror(this, target => Reflect.apply(stroke, target, args));
          }
          Reflect.apply(stroke, this, args);
        };
        const fill = CanvasRenderingContext2D.prototype.fill;
        CanvasRenderingContext2D.prototype.fill = function(...args: unknown[]) {
          if (this.canvas.id === "canvas" && args[0] instanceof Path2D) {
            mirror(this, target => Reflect.apply(fill, target, args));
          }
          Reflect.apply(fill, this, args);
        };
      }, theme);
      await page.goto("/");
      const samples = [.75, 6, 12, 36].flatMap(length =>
        [0, 45, 90, 135, 180, 225, 270, 315].map(angle => ({ length, angle })));
      const bodies = samples.map((_, index) => ({ id: index + 1, name: `Vector ${index + 1}`,
        pos: [(index % 4) * 2 - 3, 7 - Math.floor(index / 4) * 2],
        radius: .08, mass: 1, color: [90, 90, 90], collides: false, const_force: [0, 0] }));
      await importScene(page, bodies);
      const initial = await saved(page);
      // Fit once with the same positions; authored force magnitude does not
      // affect camera bounds. Then choose exact desired CSS vector lengths.
      const zoom = initial.camera[2];
      bodies.forEach((body, index) => {
        const { length, angle } = samples[index], radians = angle * Math.PI / 180;
        const force = length / (.05 * zoom * initial.vectorScale);
        body.const_force = [force * Math.cos(radians), -force * Math.sin(radians)];
      });
      await importScene(page, bodies);
      const before = await saved(page);
      expect(before.camera).toEqual(initial.camera);
      expect(before.vectorScale).toBe(initial.vectorScale);
      const area = (await page.locator("#canvas").boundingBox())!;
      await page.mouse.move(area.x + 8, area.y + 8);
      await page.mouse.down();
      await page.mouse.move(area.x + area.width - 8, area.y + area.height - 8, { steps: 8 });
      await page.mouse.up();
      await page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
      const revision = await page.evaluate(() => (window as unknown as { arrowTipInk: { revision: number } }).arrowTipInk.revision);
      await page.locator("#canvas").hover({ position: { x: 8, y: 8 } });
      await expect.poll(() => page.evaluate(() => (window as unknown as { arrowTipInk: { revision: number } }).arrowTipInk.revision))
        .toBeGreaterThan(revision);

      const inspect = () => page.evaluate(({ bodies, samples, camera }) => {
        const state = (window as unknown as { arrowTipInk: { canvas: HTMLCanvasElement; revision: number;
          transform: { a: number; d: number; e: number; f: number } } }).arrowTipInk;
        const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
        const { a, d, e, f } = state.transform;
        const pixels = state.canvas.getContext("2d")!.getImageData(0, 0, state.canvas.width, state.canvas.height).data;
        return bodies.map((body, index) => {
          const startX = (body.pos[0] - camera[0]) * camera[2] + canvas.clientWidth / 2;
          const startY = (camera[1] - body.pos[1]) * camera[2] + canvas.clientHeight / 2;
          const radians = samples[index].angle * Math.PI / 180, ux = Math.cos(radians), uy = Math.sin(radians);
          const reach = 46;
          let count = 0, minAlong = Infinity, maxAlong = -Infinity, maxAcross = 0;
          for (let y = Math.max(0, Math.floor((startY - reach) * d + f)); y < Math.min(state.canvas.height, (startY + reach) * d + f); y++) {
            for (let x = Math.max(0, Math.floor((startX - reach) * a + e)); x < Math.min(state.canvas.width, (startX + reach) * a + e); x++) {
              if (!pixels[(y * state.canvas.width + x) * 4 + 3]) continue;
              count++;
              const dx = (x + .5 - e) / a - startX, dy = (y + .5 - f) / d - startY;
              const along = dx * ux + dy * uy, across = -dx * uy + dy * ux;
              minAlong = Math.min(minAlong, along); maxAlong = Math.max(maxAlong, along);
              maxAcross = Math.max(maxAcross, Math.abs(across));
            }
          }
          return { ...samples[index], count, minAlong, maxAlong, maxAcross,
            availableSpace: Math.min(startX, startY, canvas.clientWidth - startX, canvas.clientHeight - startY),
            allowance: 1.5 / Math.min(a, d), revision: state.revision };
        });
      }, { bodies, samples, camera: before.camera });
      await expect.poll(async () => (await inspect()).filter(item => item.count > 0).length).toBe(samples.length);
      const geometry = await inspect();
      await info.attach("arrow-ink-bounds.json", { contentType: "application/json", body: JSON.stringify(geometry) });
      for (const item of geometry) {
        const context = `${item.length}px, ${item.angle}°, ${theme}, DPR ${dpr}`;
        expect(item.availableSpace, `unclipped fixture: ${context}`).toBeGreaterThan(item.length + 12);
        // An origin marker occupies a 4px radius. The outline may extend
        // 1.5px beyond a long vector; allow native pixel antialiasing.
        // A stroked triangular tip with a protruding miter exceeds this bound.
        expect(item.minAlong, context).toBeGreaterThanOrEqual(-4 - item.allowance);
        expect(item.maxAlong, context).toBeLessThanOrEqual(Math.max(4, item.length + 1.5) + item.allowance);
        expect(item.maxAcross, context).toBeLessThanOrEqual(6 + item.allowance);
        if (item.length >= 6) expect(item.maxAlong, `tip reaches its force-scaled endpoint: ${context}`)
          .toBeGreaterThanOrEqual(item.length - item.allowance);
      }
      expect((await saved(page)).scene).toBe(before.scene);
      await page.screenshot({ path: info.outputPath("free-body-arrow-envelope.png") });
      expect(errors).toEqual([]);
    });
  });
}
