import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

async function loadFlight(page: Page) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Trail rewind.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0 },
      bodies: [{ id: 1, name: "Trail particle", pos: [-2, 1], vel: [2, 0],
        radius: 0.06, mass: 1, collides: false, color: [50, 170, 150] }],
      walls: [{ id: 1, name: "Reference platform", a: [-3, -1], b: [3, -1], thickness: 0.04 }] })) });
  await expect(library).toBeHidden();
  const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
  while (await dismiss.count()) await dismiss.first().click();
  await page.getByRole("tab", { name: "View", exact: true }).click();
  await page.getByRole("checkbox", { name: "Motion trails", exact: true }).check();
  const range = page.getByRole("slider", { name: "Trail length", exact: true });
  const exactLength = page.getByRole("textbox", { name: "Trail length (type an exact value)", exact: true });
  await exactLength.fill("10"); await exactLength.press("Enter");
  await expect(range).toHaveAttribute("aria-valuetext", "10 pts");
  await page.mouse.move(0, 0);
}

async function paintedPath(page: Page) {
  return page.locator("#canvas").evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const rgba = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    const pixels: number[] = [];
    // The scale-bar caption can contain coloured subpixel text fringes on
    // Windows. This horizontal-flight fixture is well above its bottom strip.
    const end = Math.floor(canvas.height - 80 * canvas.height / canvas.clientHeight) * canvas.width * 4;
    for (let k = 0; k < end; k += 4) {
      if (rgba[k + 1] > rgba[k] + 2 && rgba[k + 2] > rgba[k] + 2 && rgba[k + 1] > rgba[k + 2]) pixels.push(k / 4);
    }
    return pixels;
  });
}

for (const theme of ["dark", "light"]) {
  test(`rewind repaints an overwritten trail and preserves its camera (${theme})`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem("mechanica.settings",
      JSON.stringify({ tour_done: true, theme, adaptive_dt: false })), theme);
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
    await loadFlight(page);
    const canvas = page.locator("#canvas"), clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
    await expect.poll(async () => (await paintedPath(page)).length).toBeGreaterThan(50);
    const initialMask = await paintedPath(page), nativeWidth = await canvas.evaluate(element => (element as HTMLCanvasElement).width);
    const inkWidth = (mask: number[]) => {
      const xs = mask.map(pixel => pixel % nativeWidth);
      return Math.max(...xs) - Math.min(...xs);
    };
    const forward = page.getByRole("button", { name: "Advance one frame (Right arrow or .).", exact: true });
    for (let k = 0; k < 6; k++) await forward.click();
    await expect(clock).toHaveValue("0.10");
    const camera = await page.evaluate(() => {
      window.dispatchEvent(new Event("pagehide"));
      return JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).presentation.camera;
    });
    let before: number[] = [];
    await expect.poll(async () => { before = await paintedPath(page); return before.length; }).toBeGreaterThan(50);
    // A painted tail extends beyond the disc; pixel counts alone vary as
    // the circular edge crosses subpixels, especially in the light theme.
    expect(inkWidth(before)).toBeGreaterThan(inkWidth(initialMask) + 2);
    await page.screenshot({ path: testInfo.outputPath(`trail-before-${theme}.png`) });
    for (let k = 0; k < 40; k++) await page.keyboard.press(".");
    await expect(clock).toHaveValue("0.77");
    const oldMask = new Set(before), currentMask = await paintedPath(page);
    const shared = currentMask.filter(pixel => oldMask.has(pixel));
    const diagnostics = await canvas.evaluate((element, indices) => {
      const c = element as HTMLCanvasElement, data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      return { width: c.width, height: c.height, shared: indices.map(k =>
        ({ x: k % c.width, y: Math.floor(k / c.width), rgb: Array.from(data.slice(k * 4, k * 4 + 3)) })) };
    }, shared.slice(0, 100));
    await writeFile(testInfo.outputPath("trail-pixel-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
    await expect.poll(async () => (await paintedPath(page)).some(pixel => before.includes(pixel))).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`trail-overwritten-${theme}.png`) });
    for (let k = 0; k < 40; k++) await page.keyboard.press(",");
    await expect(clock).toHaveValue("0.10");
    await expect.poll(() => paintedPath(page)).toEqual(before);
    const restoredCamera = await page.evaluate(() => {
      window.dispatchEvent(new Event("pagehide"));
      return JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).presentation.camera;
    });
    expect(restoredCamera).toEqual(camera);
    await page.screenshot({ path: testInfo.outputPath(`trail-restored-${theme}.png`) });
    for (let k = 0; k < 6; k++) await page.keyboard.press(",");
    await expect(clock).toHaveValue("0.00");
    for (let k = 0; k < 6; k++) await page.keyboard.press(".");
    await expect.poll(() => paintedPath(page)).toEqual(before);
    expect(errors).toEqual([]);
  });
}

test("Performance mode clears visible trails and disables recording controls", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("mechanica.settings",
    JSON.stringify({ tour_done: true, theme: "dark", adaptive_dt: false })));
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
  await loadFlight(page);
  const forward = page.getByRole("button", { name: "Advance one frame (Right arrow or .).", exact: true });
  for (let k = 0; k < 6; k++) await forward.click();
  const before = await paintedPath(page);
  await page.locator("#btn-settings").click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("checkbox", { name: "Performance mode", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("checkbox", { name: "Motion trails", exact: true })).toBeDisabled();
  await expect(page.getByRole("slider", { name: "Trail length", exact: true })).toBeDisabled();
  await expect.poll(async () => (await paintedPath(page)).length).toBeLessThan(before.length);
  await page.screenshot({ path: testInfo.outputPath("trail-performance.png") });
});
