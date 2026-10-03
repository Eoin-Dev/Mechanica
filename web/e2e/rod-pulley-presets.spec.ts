import { expect, test, type Page } from "@playwright/test";

const examples = ["Atwood machine", "Rough table and pulley", "Balanced beam",
  "Loaded rod pendulum", "Rod rotor", "Swinging Atwood machine"];

async function state(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    const saved = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
    return { scene: JSON.parse(saved.scene), presentation: saved.presentation };
  });
}

for (const [theme, width] of [["dark", 1440], ["light", 390]] as const) {
  for (const name of examples) {
    test(`${name} is discoverable, framed and graph-free (${theme}, ${width}px)`, async ({ page }, testInfo) => {
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(theme => localStorage.setItem("mechanica.settings",
        JSON.stringify({ tour_done: true, theme, studio_mode: false, adaptive_dt: false })), theme);
      await page.setViewportSize({ width, height: 900 }); await page.goto("/");
      await page.getByRole("button", { name: "Library", exact: true }).click();
      const library = page.getByRole("dialog", { name: "Library", exact: true });
      await library.getByRole("button", { name: "Rods & Pulleys", exact: true }).click();
      await expect(library.locator(".preset-card")).toHaveCount(6);
      const card = library.locator(`[data-preset-name="${name}"]`);
      await card.scrollIntoViewIfNeeded();
      const sizes = await card.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
      await library.screenshot({ path: testInfo.outputPath("rod-pulley-library.png") });
      await card.getByRole("button", { name: `Load ${name}`, exact: true }).click();
      await expect(library).toBeHidden(); await expect(page.locator("#dock")).toBeHidden();
      const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
      while (await dismiss.count()) await dismiss.first().click();
      const canvas = page.locator("#canvas"); await canvas.focus();
      // Both the shipped view and an explicit Fit must contain the loads.
      await page.mouse.move(0, 0);
      const initial = await state(page), [ix, iy, iz] = initial.presentation.camera;
      const initialSize = await canvas.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
      for (const load of initial.scene.bodies.filter((body: { is_anchor: boolean; is_rod_endpoint: boolean }) =>
        !body.is_anchor && !body.is_rod_endpoint)) {
        const x = initialSize.width / 2 + (load.pos[0] - ix) * iz;
        const y = initialSize.height / 2 + (iy - load.pos[1]) * iz;
        expect(x).toBeGreaterThan(load.radius * iz);
        expect(x).toBeLessThan(initialSize.width - load.radius * iz);
        expect(y).toBeGreaterThan(load.radius * iz);
        expect(y).toBeLessThan(initialSize.height - load.radius * iz);
      }
      await page.screenshot({ path: testInfo.outputPath("rod-pulley-default.png") });
      await page.keyboard.press("f");
      const before = await state(page), [cx, cy, zoom] = before.presentation.camera;
      const canvasSize = await canvas.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
      const loads = before.scene.bodies.filter((body: { is_anchor: boolean; is_rod_endpoint: boolean }) =>
        !body.is_anchor && !body.is_rod_endpoint);
      expect(loads).toHaveLength(2);
      for (const load of loads) {
        const x = canvasSize.width / 2 + (load.pos[0] - cx) * zoom;
        const y = canvasSize.height / 2 + (cy - load.pos[1]) * zoom;
        expect(x).toBeGreaterThan(load.radius * zoom);
        expect(x).toBeLessThan(canvasSize.width - load.radius * zoom);
        expect(y).toBeGreaterThan(load.radius * zoom);
        expect(y).toBeLessThan(canvasSize.height - load.radius * zoom);
      }
      await page.screenshot({ path: testInfo.outputPath("rod-pulley-fit.png") });
      // Select the real blue load, then verify immediate diagnostics on
      // exam models without stepping or changing the authored physics.
      const blue = loads[0];
      await canvas.click({ position: { x: canvasSize.width / 2 + (blue.pos[0] - cx) * zoom,
        y: canvasSize.height / 2 + (cy - blue.pos[1]) * zoom } });
      const open = page.getByRole("button", { name: "Open Inspector", exact: true });
      if (await open.isVisible()) await open.click();
      await page.getByRole("tab", { name: "Selection", exact: true }).click();
      const forces = page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true });
      const exam = ["Atwood machine", "Rough table and pulley", "Balanced beam"].includes(name);
      if (exam) {
        await expect(forces).toBeChecked();
        await page.locator(".force-values summary").click();
        if (name === "Atwood machine") await expect(page.locator(".force-value-list")).toContainText("23.52 N");
        if (name === "Rough table and pulley") {
          for (const text of ["7.84 N", "19.60 N", "3.92 N"]) {
            await expect(page.locator(".force-value-list")).toContainText(text);
          }
        }
        if (name === "Balanced beam") await expect(page.locator(".force-value-list")).toContainText("19.60 N");
      } else await expect(forces).not.toBeChecked();
      await page.screenshot({ path: testInfo.outputPath("rod-pulley-inspector.png") });
      expect((await state(page)).scene).toEqual(before.scene);
      // Advance through the toolbar clock; the rotor completes a quarter
      // turn, while the connected-particle models remain before their stops.
      const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
      await clock.fill(name === "Rod rotor" ? String(Math.PI / 2) : "0.3");
      await clock.press("Enter");
      await expect.poll(async () => (await state(page)).scene.settings.time).toBeGreaterThan(0.29);
      await expect(clock).toHaveAttribute("aria-busy", "false");
      const moved = await state(page);
      expect(moved.scene.settings.time).toBeGreaterThan(0.29);
      const movingBlue = moved.scene.bodies.find((body: { id: number }) => body.id === blue.id)!;
      if (name === "Balanced beam") expect(movingBlue.pos).toEqual(blue.pos);
      else expect(Math.hypot(movingBlue.pos[0] - blue.pos[0], movingBlue.pos[1] - blue.pos[1])).toBeGreaterThan(0.03);
      await page.screenshot({ path: testInfo.outputPath("rod-pulley-motion.png") });
      expect(errors).toEqual([]);
    });
  }
}
