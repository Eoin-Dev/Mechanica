import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function openParticle(page: Page) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const file = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  const theta = 25 * Math.PI / 180;
  await (await file).setFiles({ name: "Weight controls.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 9.81 }, bodies: [{
      id: 1, name: "Slope particle", mass: 1, radius: 0.2,
      color: [50, 170, 150],
      pos: [0.25 * Math.sin(theta), 0.25 * Math.cos(theta)], no_rotation: true, friction: 0,
    }], walls: [{ id: 1, name: "25° plane", thickness: 0.1, friction: 0,
      a: [-3 * Math.cos(theta), 3 * Math.sin(theta)], b: [3 * Math.cos(theta), -3 * Math.sin(theta)] }] })) });
  await expect(library).toBeHidden();
  const canvas = page.locator("#canvas"); await canvas.focus(); await canvas.press("f");
  // The scene has a single particle; find its painted colour without relying
  // on a test-only application object or fixed camera coordinates.
  let point: { x: number; y: number } | null = null;
  await expect.poll(async () => {
  point = await canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let xSum = 0, ySum = 0, count = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      if (pixels[i] === 50 && pixels[i + 1] === 170 && pixels[i + 2] === 150) { xSum += x; ySum += y; count++; }
    }
    return count ? { x: xSum / count * canvas.clientWidth / canvas.width, y: ySum / count * canvas.clientHeight / canvas.height } : null;
  });
  return point !== null;
  }).toBe(true);
  await canvas.click({ position: point! });
  const open = page.getByRole("button", { name: "Open Inspector", exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
}

for (const [name, theme, studio, width, scale] of [
  ["dark", "dark", false, 1440, 1], ["light-studio", "light", true, 1440, 1],
  ["void", "void", false, 1440, 1], ["phone", "dark", true, 390, 1.2],
  ["large-text", "light", false, 320, 2],
] as const) {
  test(`force controls and colour fields fit in ${name}`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ theme, studio }) => localStorage.setItem("mechanica.settings",
      JSON.stringify({ theme, studio_mode: studio, tour_done: true })), { theme, studio });
    await page.setViewportSize({ width, height: 900 }); await page.goto("/");
    await openParticle(page);
    await page.evaluate(scale => document.documentElement.style.setProperty("--fs", String(scale)), scale);
    const controls = page.locator(".force-controls");
    await page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
    const weight = page.getByRole("checkbox", { name: "Resolve weight on slope", exact: true });
    await weight.check();
    await expect(page.locator(".weight-resolve-note")).toContainText("25° plane: W∥ and W⊥ replace W");
    await expect(page.locator(".weight-slope-row")).toBeHidden();
    await controls.locator("summary").click();
    await expect(controls.locator(".force-value-list")).toContainText("∥ 4.15 N");
    await expect(controls.locator(".force-value-list")).toContainText("⊥ -8.89 N");
    expect(await controls.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const colours = await page.locator(".colour-row").evaluate(row => {
      const well = row.querySelector(".colour-well")!.getBoundingClientRect();
      const hex = row.querySelector(".colour-hex")!.getBoundingClientRect();
      return { top: Math.abs(well.top - hex.top), height: Math.abs(well.height - hex.height),
        fits: row.scrollWidth <= row.clientWidth };
    });
    expect(colours.top).toBeLessThan(0.5); expect(colours.height).toBeLessThan(0.5); expect(colours.fits).toBe(true);
    await controls.screenshot({ path: testInfo.outputPath(`force-controls-${name}.png`) });
    await page.locator(".colour-edit").screenshot({ path: testInfo.outputPath(`colour-controls-${name}.png`) });
    expect((await new AxeBuilder({ page }).include("#inspector").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze()).violations).toEqual([]);
    await weight.uncheck(); await expect(page.locator(".weight-resolve-note")).toBeHidden();
    expect(errors).toEqual([]);
  });
}

for (const width of [1440, 390, 320]) {
  test(`library header stays anchored across tabs and filtering at ${width}px`, async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, theme: "void" })));
    await page.setViewportSize({ width, height: 800 }); await page.goto("/");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Library", exact: true });
    const top = async () => (await library.locator(".overlay-header").boundingBox())!.y;
    const initial = await top();
    await library.getByRole("tab", { name: "My scenes", exact: true }).click();
    expect(await top()).toBeCloseTo(initial, 5);
    await page.screenshot({ path: testInfo.outputPath(`library-my-scenes-${width}.png`) });
    await library.getByRole("tab", { name: "Examples", exact: true }).click();
    expect(await top()).toBeCloseTo(initial, 5);
    await library.getByRole("searchbox").fill("no such example 12345");
    expect(await top()).toBeCloseTo(initial, 5);
    await page.screenshot({ path: testInfo.outputPath(`library-empty-filter-${width}.png`) });
  });
}
