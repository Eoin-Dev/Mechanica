import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function selectPair(page: Page): Promise<void> {
  await clearSelection(page);
  await selectPaintedBody(page, [86, 156, 214]);
  await page.keyboard.down("Shift");
  try { await selectPaintedBody(page, [220, 130, 90]); }
  finally { await page.keyboard.up("Shift"); }
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  await expect(page.locator(".collision-pair")).toHaveText("Material pair e = 0.6");
}

async function clearSelection(page: Page): Promise<void> {
  // Clicking an already-selected particle retains its group for dragging.
  await page.locator("#canvas").click({ position: { x: 20, y: 20 } });
}

async function selectPaintedBody(page: Page, colour: [number, number, number]): Promise<void> {
  const canvas = page.locator("#canvas");
  await page.mouse.move(0, 0);
  let position: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    position = await canvas.evaluate((element, rgb) => {
      const scene = element as HTMLCanvasElement;
      const pixels = scene.getContext("2d")!.getImageData(0, 0, scene.width, scene.height).data;
      const matches = (x: number, y: number) => {
        const i = (y * scene.width + x) * 4;
        return Math.abs(pixels[i] - rgb[0]) <= 1 && Math.abs(pixels[i + 1] - rgb[1]) <= 1 &&
          Math.abs(pixels[i + 2] - rgb[2]) <= 1;
      };
      // A solid interior patch identifies the disc even when another
      // particle's thin selection rim shares this colour.
      for (let y = 3; y < scene.height - 3; y++) for (let x = 3; x < scene.width - 3; x++) {
        if (!matches(x, y)) continue;
        let solid = true;
        for (let dy = -3; dy <= 3 && solid; dy++) for (let dx = -3; dx <= 3; dx++) {
          if (!matches(x + dx, y + dy)) { solid = false; break; }
        }
        if (solid) return { x: x * scene.clientWidth / scene.width,
          y: y * scene.clientHeight / scene.height };
      }
      return null;
    }, colour);
    return position !== null;
  }).toBe(true);
  await canvas.click({ position: position! });
}

test("collision materials explain relative restitution and the worked example matches its velocities", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({
    tour_done: true, theme: "light", studio_mode: true, adaptive_dt: false,
  })));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("searchbox", { name: "Search examples", exact: true }).fill("direct collision");
  await library.getByRole("button", { name: "Load Direct collision", exact: true }).press("Enter");
  await expect(library).toBeHidden();
  const notifications = page.getByRole("button", { name: "Dismiss notification", exact: true });
  while (await notifications.count()) await notifications.first().click();
  await selectPair(page);
  const model = page.locator(".collision-model");
  const details = model.locator("details");
  const summary = model.locator("summary");
  await summary.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await expect(model).toContainText("relative separation speed / relative approach speed");
  await expect(model).toContainText("not joined");
  await expect(summary).toBeFocused();
  await summary.press("Enter");
  const restitution = page.getByRole("textbox", { name: "Restitution e (type an exact value)", exact: true });
  await restitution.fill("0.8");
  await restitution.press("Enter");
  await model.scrollIntoViewIfNeeded();
  await expect(page.locator(".collision-pair")).toHaveText("Material pair e = 0.8");
  await page.locator("#canvas").focus();
  await page.keyboard.press("Control+z");
  await selectPair(page);

  let previousWidth = 1440;
  for (const [layout, width, theme, studio, scale] of [
    ["light-studio", 1440, "Light", true, 1],
    ["dark-studio", 1440, "Dark", true, 1],
    ["void-classic", 1440, "Void", false, 1.2],
    ["phone-enlarged", 390, "Light", true, 1.2],
    ["narrow-double-text", 320, "Dark", false, 2],
  ] as const) {
    await page.locator("#btn-settings").click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: theme, exact: true }).click();
    await settings.getByRole("checkbox", { name: "Studio mode", exact: true }).setChecked(studio);
    await settings.getByRole("button", { name: scale === 1 ? "100%" : "120%", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width, height: 900 });
    if (scale === 2) await page.evaluate(() => document.documentElement.style.setProperty("--fs", "2"));
    const open = page.getByRole("button", { name: "Open Inspector", exact: true });
    if (width <= 760 && previousWidth > 760) await expect(open).toBeVisible();
    if (await open.isVisible()) await open.click();
    previousWidth = width;
    await model.scrollIntoViewIfNeeded();
    if ((await details.getAttribute("open")) === null) await summary.press("Enter");
    const fit = await model.evaluate(card => ({ client: card.clientWidth, scroll: card.scrollWidth,
      size: parseFloat(getComputedStyle(card.querySelector(".collision-help")!).fontSize) }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.client + 1);
    expect(fit.size).toBeCloseTo(11 * scale, 1);
    await page.locator("#inspector").screenshot({ path: testInfo.outputPath(`collision-model-${layout}.png`) });
    await restitution.scrollIntoViewIfNeeded();
    const row = restitution.locator("..");
    const geometry = await row.evaluate(element => {
      const caption = element.querySelector(".lbl")!;
      const value = element.querySelector(".val")!;
      const track = element.querySelector('input[type="range"]')!;
      return { client: element.clientWidth, scroll: element.scrollWidth,
        captionHeight: caption.getBoundingClientRect().height,
        captionSize: parseFloat(getComputedStyle(caption).fontSize),
        captionBottom: caption.getBoundingClientRect().bottom,
        valueBottom: value.getBoundingClientRect().bottom,
        trackTop: track.getBoundingClientRect().top };
    });
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    expect(geometry.captionHeight, `complete restitution caption in ${layout}`).toBeLessThan(geometry.captionSize * 1.6);
    expect(geometry.trackTop).toBeGreaterThanOrEqual(Math.max(geometry.captionBottom, geometry.valueBottom));
    await page.locator("#inspector").screenshot({ path: testInfo.outputPath(`collision-material-${layout}.png`) });
    const scan = await new AxeBuilder({ page }).include("#inspector")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
    expect(scan.violations).toEqual([]);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.style.removeProperty("--fs"));
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  await clock.fill("1"); await clock.press("Enter");
  await expect(clock).toHaveAttribute("aria-busy", "false");
  await expect(clock).toHaveValue("1.00");
  await expect(page.locator(".collision-pair")).toHaveText("Material pair e = 0.6");
  await clearSelection(page);
  await selectPaintedBody(page, [86, 156, 214]);
  await expect(page.getByRole("textbox", { name: "vx", exact: true })).toHaveValue("-0.800");
  await clearSelection(page);
  await selectPaintedBody(page, [220, 130, 90]);
  await expect(page.getByRole("textbox", { name: "vx", exact: true })).toHaveValue("2.200");
  await selectPair(page);
  await page.screenshot({ path: testInfo.outputPath("direct-collision-after-impact.png") });
  expect(errors).toEqual([]);
});
