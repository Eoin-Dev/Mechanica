import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function selectLink(page: Page): Promise<void> {
  const canvas = page.locator("#canvas");
  await canvas.focus();
  await page.keyboard.press("f");
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  await expect(page.locator(".elastic-model")).toBeVisible();
}

test("elastic modulus supports exact edits, history and saved scenes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const { library, card, modulus } = await loadElasticStudy(page);
  await expect(modulus).toHaveValue("20");
  await modulus.fill("-60");
  await modulus.press("Enter");
  await expect(modulus).toHaveAttribute("aria-invalid", "true");
  await expect(modulus).toHaveValue("-60");
  await expect(card.getByRole("alert")).toBeVisible();
  await modulus.focus();
  await modulus.press("Escape");
  await expect(modulus).toHaveValue("20");
  await expect(modulus).not.toHaveAttribute("aria-invalid", "true");
  await modulus.fill("6e1");
  await modulus.press("Enter");
  await expect(modulus).toHaveValue("60");
  await expect(card.locator("dd").nth(1)).toHaveText("0.50 m");
  await expect(card.locator("dd").nth(2)).toHaveText("15.00 N tension");
  await expect(card.locator("dd").nth(3)).toHaveText("3.75 J");
  const explanation = card.locator(".elastic-explanation > summary");
  await explanation.focus();
  await explanation.press("Enter");
  await expect(card.locator(".elastic-explanation")).toHaveAttribute("open", "");
  await expect(card.locator(".elastic-explanation")).toContainText("Changing natural length keeps stiffness k");
  await expect(explanation).toBeFocused();
  await explanation.press("Enter");
  const stiffness = page.getByRole("textbox", { name: "Stiffness (type an exact value)", exact: true });
  await expect(stiffness).toHaveValue("30 N/m");
  await page.locator("#canvas").focus();
  await page.keyboard.press("Control+z");
  await selectLink(page);
  await expect(modulus).toHaveValue("20");
  await page.locator("#canvas").focus();
  await page.keyboard.press("Control+Shift+z");
  await selectLink(page);
  await expect(modulus).toHaveValue("60");
  await card.getByRole("button", { name: "Set damping to zero", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Damping (type an exact value)", exact: true })).toHaveValue("0.00 Ns/m");
  await expect(card.getByRole("button", { name: "Set damping to zero", exact: true })).toBeHidden();


  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.style.removeProperty("--fs"));
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  await library.getByRole("button", { name: "Save current scene", exact: true }).click();
  const name = library.getByRole("textbox", { name: "Scene name", exact: true });
  await name.fill("Elastic study");
  await name.press("Enter");
  const downloading = page.waitForEvent("download");
  await library.getByRole("button", { name: "Download Elastic study as a .json file", exact: true }).click();
  const saved = JSON.parse(await readFile((await (await downloading).path())!, "utf8"));
  expect(saved.links[0]).toMatchObject({ rest_length: 2, stiffness: 30, damping: 0, tension_only: true });
  expect(saved.links[0]).not.toHaveProperty("modulus");
  await library.getByRole("button", { name: "Load Elastic study", exact: true }).click();
  await selectLink(page);
  await expect(modulus).toHaveValue("60");
  expect(errors).toEqual([]);
});

async function loadElasticStudy(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, theme: "light", studio_mode: true }));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Elastic study.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0 }, bodies: [
      { id: 1, pos: [0, 0], radius: 0.1, is_anchor: true, collides: false },
      { id: 2, name: "Elastic load", pos: [2.5, 0], radius: 0.1, mass: 2, collides: false },
    ], links: [{ type: "spring", id: 1, a: 1, b: 2, rest_length: 2, stiffness: 10, damping: 2, tension_only: true }] })) });
  await expect(library).toBeHidden();
  await selectLink(page);
  const card = page.locator(".elastic-model");
  const modulus = card.getByRole("textbox", { name: "Modulus λ (N)", exact: true });
  return { library, card, modulus };
}

for (const [layout, width, theme, studio, scale] of [
    ["light-studio", 1440, "Light", true, 1],
    ["dark-studio", 1440, "Dark", true, 1],
    ["void-classic", 1440, "Void", false, 1.2],
    ["phone-enlarged", 390, "Light", true, 1.2],
    ["narrow-double-text", 320, "Dark", false, 2],
  ] as const) {
  test(`elastic study readouts remain readable in ${layout}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const { card, modulus } = await loadElasticStudy(page);
    await modulus.fill("60"); await modulus.press("Enter");
    await expect(modulus).toHaveValue("60");
    await card.getByRole("button", { name: "Set damping to zero", exact: true }).click();
    await page.locator("#btn-settings").click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: theme, exact: true }).click();
    await settings.getByRole("checkbox", { name: "Studio mode", exact: true }).setChecked(studio);
    await settings.getByRole("button", { name: scale === 1 ? "100%" : "120%", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await page.setViewportSize({ width, height: 900 });
    if (scale === 2) await page.evaluate(() => document.documentElement.style.setProperty("--fs", "2"));
    const open = page.getByRole("button", { name: "Open Inspector", exact: true });
    if (width <= 760) await expect(open).toBeVisible();
    if (await open.isVisible()) await open.click();
    await modulus.scrollIntoViewIfNeeded();
    await expect(modulus).toHaveValue("60");
    const bounds = await card.evaluate(element => ({
      client: element.clientWidth, scroll: element.scrollWidth,
      background: getComputedStyle(element).backgroundColor,
      inputFont: parseFloat(getComputedStyle(element.querySelector("input")!).fontSize),
      fields: [...element.querySelectorAll("input, dd, dt, p")].map(field => ({
        right: field.getBoundingClientRect().right, cardRight: element.getBoundingClientRect().right,
        client: field.clientWidth, scroll: field.scrollWidth,
      })),
    }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
    expect(bounds.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(bounds.inputFont).toBeCloseTo(12 * scale, 1);
    for (const field of bounds.fields) {
      if (field.client === 0) continue;
      expect(field.right).toBeLessThanOrEqual(field.cardRight + 1);
      expect(field.scroll).toBeLessThanOrEqual(field.client + 1);
    }
    await expect(page.locator("#inspector-panel")).toHaveJSProperty("scrollLeft", 0);
    await card.screenshot({ path: testInfo.outputPath(`elastic-model-${layout}.png`) });
    const scan = await new AxeBuilder({ page }).include("#inspector")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
    expect(scan.violations).toEqual([]);
    expect(errors).toEqual([]);
  });
}
