import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function selectWall(page: Page) {
  const canvas = page.locator("#canvas");
  await canvas.focus(); await page.keyboard.press("f");
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  const opener = page.getByRole("button", { name: "Open Inspector", exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Angle (°)", exact: true })).toBeVisible();
}

async function loadWall(page: Page, width = 1440, theme = "dark", scale = 1) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ theme, scale }) => {
    localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, theme,
      studio_mode: true, font_scale: scale }));
  }, { theme, scale });
  await page.goto("/");
  await page.evaluate(scale => document.documentElement.style.setProperty("--fs", String(scale)), scale);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Angle study.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0 }, bodies: [],
      walls: [{ id: 1, name: "Angle study", a: [-2, 0], b: [2, 0], thickness: 0.1 }] })) });
  await expect(library).toBeHidden(); await selectWall(page);
  return page.getByRole("textbox", { name: "Angle (°)", exact: true });
}

async function capturedScene(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).scene);
  });
}

test("wall angles accept signed, wrapped and exact values with reversible saved geometry", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const angle = await loadWall(page);
  for (const [text, direction] of [["30", 30], ["-450", -90], ["720", 0],
    ["3.9e2", 30], ["1e300", 1e300 % 360], ["-1e300", -1e300 % 360]] as const) {
    await angle.fill(text); await angle.press("Enter");
    await expect(angle).not.toHaveAttribute("aria-invalid", "true");
    const wall = (await capturedScene(page)).walls[0];
    const radians = direction * Math.PI / 180;
    expect(wall.a[0] + wall.b[0]).toBeCloseTo(0, 12);
    expect(wall.a[1] + wall.b[1]).toBeCloseTo(0, 12);
    expect(Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1])).toBeCloseTo(4, 12);
    expect(wall.b[0] - wall.a[0]).toBeCloseTo(4 * Math.cos(radians), 12);
    expect(wall.b[1] - wall.a[1]).toBeCloseTo(4 * Math.sin(radians), 12);
  }
  await angle.fill("30"); await angle.press("Enter");
  const before = (await capturedScene(page)).walls[0];
  await angle.fill("45"); await angle.press("Escape");
  expect((await capturedScene(page)).walls[0]).toEqual(before);
  await angle.fill("1e309"); await angle.press("Enter");
  await expect(angle).toHaveAttribute("aria-invalid", "true");
  expect((await capturedScene(page)).walls[0]).toEqual(before);
  await angle.focus(); await angle.press("Escape");
  await angle.fill("-90"); await angle.press("Enter");
  await page.locator("#canvas").focus(); await page.keyboard.press("Control+z");
  await selectWall(page); await expect(angle).toHaveValue("30");
  expect((await capturedScene(page)).walls[0]).toEqual(before);
  await page.locator("#canvas").focus(); await page.keyboard.press("Control+Shift+z");
  await selectWall(page); await expect(angle).toHaveValue("-90");
  const after = (await capturedScene(page)).walls[0];
  expect(after.a).toEqual([0, 2]); expect(after.b).toEqual([0, -2]);

  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  await library.getByRole("button", { name: "Save current scene", exact: true }).click();
  const name = library.getByRole("textbox", { name: "Scene name", exact: true });
  await name.fill("Wall angles"); await name.press("Enter");
  const downloading = page.waitForEvent("download");
  await library.getByRole("button", { name: "Download Wall angles as a .json file", exact: true }).click();
  const saved = JSON.parse(await readFile((await (await downloading).path())!, "utf8"));
  expect(saved.walls[0]).toEqual(after); expect(saved.walls[0]).not.toHaveProperty("angle");
  await library.getByRole("button", { name: "Load Wall angles", exact: true }).click();
  await selectWall(page); await expect(angle).toHaveValue("-90");
  expect((await capturedScene(page)).walls[0]).toEqual(after);
  expect(errors).toEqual([]);
});

for (const [layout, width, theme, scale] of [
  ["desktop-dark", 1440, "dark", 1],
  ["desktop-light", 1440, "light", 1],
  ["phone", 390, "dark", 1],
  ["large-text", 320, "light", 2],
] as const) {
  test("wall angle matches the Inspector and remains accessible in " + layout, async ({ page }, testInfo) => {
    const angle = await loadWall(page, width, theme, scale);
    await angle.fill("-30"); await angle.press("Enter");
    await expect(angle).toHaveValue("-30");
    const inspector = page.locator("#inspector");
    const angleRow = angle.locator("..");
    await angle.scrollIntoViewIfNeeded();
    const box = (await angleRow.boundingBox())!, panel = (await inspector.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(panel.x);
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
    const geometry = await angle.evaluate(input => {
      const row = input.parentElement!, label = row.querySelector(".lbl")!;
      const unit = row.querySelector(".unit")!;
      const b = input.getBoundingClientRect(), l = label.getBoundingClientRect(), u = unit.getBoundingClientRect();
      return { labelFits: l.right <= b.left + 1, unitFits: b.right <= u.left + 1,
        font: getComputedStyle(input).fontSize,
        coordinateFont: getComputedStyle(document.querySelector('[aria-label="x1 (m)"]')!).fontSize };
    });
    expect(geometry.labelFits).toBe(true); expect(geometry.unitFits).toBe(true);
    expect(geometry.font).toBe(geometry.coordinateFont);
    const thickness = await inspector.locator(".wall-thickness").evaluate(row => {
      const label = row.querySelector(".lbl")!, value = row.querySelector<HTMLInputElement>(".val")!;
      const canvas = document.createElement("canvas").getContext("2d")!;
      const css = getComputedStyle(value), labelCss = getComputedStyle(label);
      canvas.font = labelCss.fontSize + " " + labelCss.fontFamily;
      const labelFits = canvas.measureText(label.textContent!).width <= label.clientWidth + 1;
      canvas.font = css.fontSize + " " + css.fontFamily;
      return { labelFits, valueFits: canvas.measureText(value.value).width <=
        value.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight) + 1 };
    });
    expect(thickness).toEqual({ labelFits: true, valueFits: true });
    const accessibility = await new AxeBuilder({ page }).include("#inspector")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("wall-angle-" + layout + ".png") });
  });
}