import { expect, test, type Page } from "@playwright/test";

async function state(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).scene);
  });
}
async function restart(page: Page) {
  await Promise.all([page.waitForEvent("domcontentloaded"),
    page.getByRole("button", { name: "Mechanica", exact: true }).click()]);
  await expect(page.locator(".toast-refresh .toast-title")).toHaveText("Page refreshed");
}
async function simulationSettings(page: Page) {
  await page.locator("#btn-settings").click();
  const panel = page.getByRole("dialog", { name: "Settings", exact: true });
  await panel.getByRole("tab", { name: "Simulation", exact: true }).click();
  return panel;
}

test("first browser visit is the incline, subsequent starts are random, recovery and named restart notices agree", async ({ page, context }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    Math.random = () => .999999;
    if (!localStorage.getItem("mechanica.settings")) localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true }));
    if (!localStorage.getItem("mechanica.scene.Teacher example")) localStorage.setItem("mechanica.scene.Teacher example", JSON.stringify({ settings: { gravity: 0 }, bodies: [{ id: 1, name: "Teacher example particle", pos: [3, 4], vel: [1, 0], mass: 7, collides: false }] }));
  });
  await page.goto("/");
  const initial = await state(page);
  expect(initial.bodies.map((body: { name: string }) => body.name)).toContain("2.0 kg on slope");
  const settings = await simulationSettings(page);
  await expect(settings.getByRole("checkbox", { name: "Random starting scene", exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  await clock.fill("0.1"); await clock.press("Enter");
  await expect.poll(async () => (await state(page)).settings.time).toBeCloseTo(.1, 8);
  const edited = await state(page); await page.reload(); expect(await state(page)).toEqual(edited);
  await restart(page);
  await expect(page.locator(".toast-refresh .toast-message")).toHaveText("Loaded “Teacher example”");
  const random = await state(page); expect(random.bodies).toHaveLength(1);
  expect(random.bodies[0].name).toBe("Teacher example particle");
  const other = await context.newPage(); other.on("pageerror", error => errors.push(error.message));
  await other.addInitScript(() => { Math.random = () => .999999; });
  await other.goto("/"); expect(await state(other)).toEqual(random); await other.close();
  const simulation = await simulationSettings(page);
  await simulation.getByRole("checkbox", { name: "Random starting scene", exact: true }).uncheck();
  await page.keyboard.press("Escape"); await restart(page);
  await expect(page.locator(".toast-refresh .toast-message")).toHaveText("Loaded “Pulley on an incline”");
  expect(await state(page)).toEqual(initial);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mechanica.settings")!).random_start_scene)).toBe(false);
  await page.screenshot({ path: info.outputPath("named-incline-restart.png") });
  expect(errors).toEqual([]);
});

test("Studio transport stays on the top row and compact Settings remain usable at narrow and enlarged sizes", async ({ page }, info) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, studio_mode: true, theme: "light" })));
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
  for (const width of [1440, 1280, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.locator("#toolbar").evaluate(el => {
      const toolbar = el.getBoundingClientRect(), transport = el.querySelector(".toolbar-transport")!.getBoundingClientRect();
      return toolbar.height <= 68 && transport.top <= toolbar.top + 9 && transport.bottom <= toolbar.bottom && el.scrollWidth <= el.clientWidth;
    })).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: info.outputPath("compact-studio-top-row.png") });
  await page.locator("#btn-settings").click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const panel = settings;
  expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(562);
  await expect.poll(() => panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await settings.screenshot({ path: info.outputPath("compact-settings.png") });
  await settings.getByRole("checkbox", { name: "Dyslexia-friendly font", exact: true }).check();
  await settings.getByRole("button", { name: "120%", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => panel.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.left >= -.5 && rect.right <= innerWidth + .5 && el.scrollWidth <= el.clientWidth + 1;
  })).toBe(true);
  for (const name of ["Appearance", "Interaction", "Simulation"]) {
    await settings.getByRole("tab", { name, exact: true }).click();
    await expect(settings.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
  }
  await settings.screenshot({ path: info.outputPath("narrow-dyslexic-settings.png") });
  await page.keyboard.press("Escape"); await expect(settings).toBeHidden();
  expect(errors).toEqual([]);
});
