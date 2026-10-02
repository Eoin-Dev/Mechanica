import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test("centre-of-mass coordinates are accessible and follow scene evolution", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const { model, x, y } = await prepareCentre(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.style.removeProperty("--fs"));
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  await clock.fill("1"); await clock.press("Enter");
  await expect(clock).toHaveAttribute("aria-busy", "false");
  await expect(clock).toHaveValue("1.00");
  await expect(x).toHaveText("0.8 m");
  await expect(y).toHaveText("-0.2 m");
  await page.locator("#canvas").focus(); await page.keyboard.press("f");
  await model.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("centre-after-seek.png") });
  await page.getByRole("checkbox", { name: "Centre of mass", exact: true }).uncheck();
  await expect(model).toBeHidden();
  expect(errors).toEqual([]);
});

async function prepareCentre(page: Page) {
  await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({
    tour_done: true, theme: "light", studio_mode: true, adaptive_dt: false,
  })));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Centre investigation.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0 }, bodies: [
      { id: 1, name: "A", pos: [-2, 1], vel: [1, 0], mass: 2, collides: false },
      { id: 2, name: "B", pos: [2, -1], mass: 3, collides: false },
      { id: 3, name: "Fixed obstacle", pos: [0, 4], mass: 100, locked: true },
    ] })) });
  await expect(library).toBeHidden();
  const notices = page.getByRole("button", { name: "Dismiss notification", exact: true });
  while (await notices.count()) await notices.first().click();
  await page.getByRole("tab", { name: "View", exact: true }).click();
  const model = page.getByRole("group", { name: "Centre of mass coordinates", exact: true });
  await expect(model).toBeHidden();
  await page.getByRole("checkbox", { name: "Centre of mass", exact: true }).check();
  const x = model.getByRole("status", { name: "Centre of mass x", exact: true });
  const y = model.getByRole("status", { name: "Centre of mass y", exact: true });
  await expect(x).toHaveText("0.4 m");
  await expect(y).toHaveText("-0.2 m");
  await expect(x).toHaveAttribute("aria-live", "off");
  await x.focus();
  await expect(x).toHaveAttribute("aria-description", "Full stored value: 0.4 m.");
  await x.press("Tab");
  await expect(y).toBeFocused();
  const centreToggle = page.getByRole("checkbox", { name: "Centre of mass", exact: true });
  await expect(centreToggle.locator("..")).toHaveAttribute("title", /Walls|walls/);

  return { model, x, y };
}

for (const [layout, width, theme, studio, scale, dyslexic] of [
    ["light-studio", 1440, "Light", true, 1, false],
    ["dark-studio", 1440, "Dark", true, 1, false],
    ["void-classic", 1440, "Void", false, 1.2, false],
    ["phone-enlarged", 390, "Light", true, 1.2, false],
    ["narrow-double-text", 320, "Dark", false, 2, false],
    ["dyslexic-enlarged", 390, "Light", true, 1.2, true],
  ] as const) {
  test(`centre-of-mass coordinates remain readable in ${layout}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const { model, x, y } = await prepareCentre(page);
    await page.locator("#btn-settings").click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: theme, exact: true }).click();
    await settings.getByRole("checkbox", { name: "Studio mode", exact: true }).setChecked(studio);
    await settings.getByRole("checkbox", { name: "Dyslexia-friendly font", exact: true }).setChecked(dyslexic);
    await settings.getByRole("button", { name: scale === 1 ? "100%" : "120%", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await page.setViewportSize({ width, height: 900 });
    if (scale === 2) await page.evaluate(() => document.documentElement.style.setProperty("--fs", "2"));
    await page.evaluate(() => document.fonts.ready);
    const open = page.getByRole("button", { name: "Open Inspector", exact: true });
    if (width <= 760) await expect(open).toBeVisible();
    if (await open.isVisible()) await open.click();
    await model.scrollIntoViewIfNeeded();
    const fit = await model.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.client + 1);
    for (const coordinate of [x, y]) {
      await coordinate.scrollIntoViewIfNeeded();
      await expect(coordinate).toBeInViewport({ ratio: 1 });
    }
    await page.locator("#inspector").screenshot({ path: testInfo.outputPath(`centre-model-${layout}.png`) });
    const scan = await new AxeBuilder({ page }).include("#inspector")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
    expect(scan.violations).toEqual([]);
    expect(errors).toEqual([]);
  });
}
