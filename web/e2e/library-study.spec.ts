import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("study topics are discoverable and the elastic-string investigation matches its card", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("mechanica.settings",
    JSON.stringify({ tour_done: true, theme: "light", studio_mode: true, adaptive_dt: false })));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  const search = library.getByRole("searchbox", { name: "Search examples", exact: true });
  await search.fill("SHM");
  await expect(library.getByRole("button", { name: "Load Mass on a spring", exact: true })).toBeVisible();
  await expect(library.locator('[data-preset-name="Mass on a spring"] .preset-topics')).toContainText("SHM");
  await expect(search).toBeFocused();
  await library.getByRole("button", { name: "Oscillators", exact: true }).click();
  await search.fill("SUVAT");
  await expect(library.locator(".preset-card")).toHaveCount(0);
  await library.getByRole("button", { name: "Search all categories", exact: true }).press("Enter");
  await expect(search).toHaveValue("SUVAT");
  await expect(search).toBeFocused();
  await expect(library.locator(".preset-card")).toHaveCount(3);
  await expect(library.locator('[data-category="All"]')).toHaveAttribute("aria-pressed", "true");
  await search.fill("Newton’s cradle");
  await expect(library.locator(".preset-card")).toHaveCount(1);
  await search.fill("Képler");
  await expect(library.getByRole("button", { name: "Load Kepler ellipse", exact: true })).toBeVisible();
  await search.fill("λ");
  await expect(library.locator(".preset-card")).toHaveCount(2);
  const release = library.locator('[data-preset-name="Elastic string release"]');
  await expect(release).toContainText("39.2 N");


  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.style.removeProperty("--fs"));
  await library.getByRole("button", { name: "Load Elastic string release", exact: true }).press("Enter");
  await expect(library).toBeHidden();
  await expect(page.locator("#dock")).toBeVisible();
  await expect(page.getByRole("button", {
    name: "Keep the whole scene framed as it spreads out (Shift+F).", exact: true,
  })).toHaveAttribute("aria-pressed", "true");
  const notices = page.getByRole("button", { name: "Dismiss notification", exact: true });
  while (await notices.count()) await notices.first().click();
  const canvas = page.locator("#canvas");
  await canvas.focus();
  await page.keyboard.press("f");
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  const model = page.locator(".elastic-model");
  await expect(model.getByRole("textbox", { name: "Modulus λ (N)", exact: true })).toHaveValue("39.2");
  await expect(model.locator("dd").nth(1)).toHaveText("0.00 m");
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  await clock.fill(String(Math.PI / Math.sqrt(9.8)));
  await clock.press("Enter");
  await expect(clock).toHaveAttribute("aria-busy", "false");
  await expect(model.locator("dd").nth(1)).toHaveText("2.00 m");
  await expect(model.locator("dd").nth(2)).toHaveText("39.20 N tension");
  await expect(model.locator("dd").nth(3)).toHaveText("39.20 J");
  // Wait for the real canvas to paint the expanded scene. The blue load
  // must have a substantial visible disc fully inside the backing canvas;
  // updated text and a pressed auto-fit control alone do not establish that.
  await expect.poll(() => canvas.evaluate(element => {
    const scene = element as HTMLCanvasElement;
    const pixels = scene.getContext("2d")!.getImageData(0, 0, scene.width, scene.height).data;
    let count = 0;
    let left = scene.width;
    let right = 0;
    let top = scene.height;
    let bottom = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (Math.abs(pixels[i] - 86) > 1 || Math.abs(pixels[i + 1] - 156) > 1 ||
          Math.abs(pixels[i + 2] - 214) > 1) continue;
      const x = (i / 4) % scene.width;
      const y = Math.floor(i / 4 / scene.width);
      count++;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    return count > 100 && left > 2 && right < scene.width - 3 &&
      top > 2 && bottom < scene.height - 3;
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("elastic-release-turning-point.png") });
  expect(errors).toEqual([]);
});

for (const [layout, width, height, theme, studio, scale] of [
    ["light-studio", 1440, 900, "Light", true, 1],
    ["dark-studio", 1440, 900, "Dark", true, 1],
    ["void-classic", 1440, 900, "Void", false, 1.2],
    ["phone-enlarged", 390, 900, "Light", true, 1.2],
    ["narrow-double-text", 320, 900, "Dark", false, 2],
    ["short-landscape", 1440, 380, "Light", true, 1.2],
  ] as const) {
  test(`study Library remains readable in ${layout}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("mechanica.settings",
      JSON.stringify({ tour_done: true, theme: "light", studio_mode: true })));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Library", exact: true });
    const search = library.getByRole("searchbox", { name: "Search examples", exact: true });
    await search.fill("λ");
    const release = library.locator('[data-preset-name="Elastic string release"]');
    await library.getByRole("button", { name: "Close (Esc)", exact: true }).click();
    await page.locator("#btn-settings").click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: theme, exact: true }).click();
    await settings.getByRole("checkbox", { name: "Studio mode", exact: true }).setChecked(studio);
    await settings.getByRole("button", { name: scale === 1 ? "100%" : "120%", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await page.setViewportSize({ width, height });
    if (scale === 2) await page.evaluate(() => document.documentElement.style.setProperty("--fs", "2"));
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(search).toHaveValue("λ");
    await expect(release).toBeVisible();
    await release.scrollIntoViewIfNeeded();
    const fit = await release.evaluate(card => ({ client: card.clientWidth, scroll: card.scrollWidth,
      topics: [...card.querySelectorAll(".preset-topics span")].map(topic => ({
        left: topic.getBoundingClientRect().left, right: topic.getBoundingClientRect().right,
        parentLeft: card.getBoundingClientRect().left, parentRight: card.getBoundingClientRect().right,
        client: topic.clientWidth, scroll: topic.scrollWidth,
        size: parseFloat(getComputedStyle(topic).fontSize),
      })) }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.client + 1);
    for (const topic of fit.topics) {
      expect(topic.left).toBeGreaterThanOrEqual(topic.parentLeft);
      expect(topic.right).toBeLessThanOrEqual(topic.parentRight);
      expect(topic.scroll).toBeLessThanOrEqual(topic.client + 1);
      expect(topic.size).toBeCloseTo(10 * scale, 1);
    }
    if (width <= 600 || height <= 500) {
      await search.fill("");
      const readingArea = await library.evaluate(dialog => {
        const body = dialog.querySelector<HTMLElement>(".overlay-body")!;
        body.scrollTop = body.scrollHeight;
        return { top: body.getBoundingClientRect().top,
          categoriesBottom: dialog.querySelector(".cat-chips")!.getBoundingClientRect().bottom };
      });
      expect(readingArea.categoriesBottom).toBeLessThanOrEqual(readingArea.top + 1);
      await search.fill("λ");
      await release.scrollIntoViewIfNeeded();
    }
    await library.screenshot({ path: testInfo.outputPath(`study-library-${layout}.png`) });
    const scan = await new AxeBuilder({ page }).include("#library")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
    expect(scan.violations).toEqual([]);
    expect(errors).toEqual([]);
  });
}
