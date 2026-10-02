import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("wheel readings and separate tension arrows calculate immediately and survive stepping and rewind", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, theme: "light" }));
    const painted: string[] = [];
    Object.defineProperty(window, "pulleyForceText", { value: painted });
    const clear = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function(x, y, width, height) {
      if (this.canvas.id === "canvas" && x === 0 && y === 0 && width > 100 && height > 100) painted.length = 0;
      clear.call(this, x, y, width, height);
    };
    const text = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(value, x, y, maxWidth) {
      if (this.canvas.id === "canvas" && (value.startsWith("F =") || value.includes("⎣"))) painted.push(value);
      if (maxWidth === undefined) text.call(this, value, x, y);
      else text.call(this, value, x, y, maxWidth);
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  const radius = 0.38, x = 0.22;
  await (await choosing).setFiles({ name: "Stationary pulley.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 9.81, substeps: 8 }, bodies: [
      { id: 1, name: "Free mass", pos: [-x, -2], mass: 2, color: [50, 170, 150], collides: false },
      { id: 2, name: "Stopped mass", pos: [x, 1 - Math.sqrt(radius ** 2 - x ** 2)], mass: 1,
        color: [220, 130, 90], collides: false },
      { id: 3, name: "Wheel", pos: [0, 1], is_pulley: true },
    ], links: [{ type: "pulley", id: 1, a: 1, b: 2, pulley: 3 }] })) });
  await expect(library).toBeHidden();
  const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
  while (await dismiss.count()) await dismiss.first().click();
  const canvas = page.locator("#canvas");
  let point: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    point = await canvas.evaluate(element => {
      const c = element as HTMLCanvasElement;
      const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let sumX = 0, sumY = 0, count = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (Math.abs(data[i] - 50) <= 1 && Math.abs(data[i + 1] - 170) <= 1 && Math.abs(data[i + 2] - 150) <= 1) {
          sumX += x; sumY += y; count++;
        }
      }
      return count ? { x: sumX / count * c.clientWidth / c.width,
        y: sumY / count * c.clientHeight / c.height } : null;
    });
    return point !== null;
  }).toBe(true);
  await canvas.click({ position: point! });
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  const inspector = page.locator("#inspector");
  await inspector.getByRole("button", { name: "Select pulley wheel", exact: true }).click();
  const readout = inspector.getByRole("group", { name: "Pulley force and motion", exact: true });
  const values = readout.locator(".pulley-reading-value");
  await expect(values.nth(0)).toHaveText("19.620 N");
  await expect(values.nth(4)).toHaveText("(0.00, 29.43) N");
  await expect(readout.locator(".pulley-reading-name").first()).toHaveAttribute("title", /Current forces/);
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  await expect(clock).toHaveValue("0.00");
  await inspector.getByRole("checkbox", { name: "Tension vectors", exact: true }).check();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + point!.x, box.y + point!.y);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { pulleyForceText: string[] }).pulleyForceText.join(" "))).toContain("19.62");
  await expect(clock).toHaveValue("0.00");
  await canvas.focus(); await page.keyboard.press(".");
  await expect(values.nth(0)).toHaveText("19.620 N");
  await expect(values.nth(4)).toHaveText("(0.00, 29.43) N");
  await expect(readout.locator(".pulley-reading-name").first()).toHaveAttribute("title", /Average forces/);
  await page.keyboard.press("."); await page.keyboard.press(",");
  await expect(values.nth(0)).toHaveText("19.620 N");
  await expect(values.nth(4)).toHaveText("(0.00, 29.43) N");
  await expect(clock).toHaveValue("0.02");
  expect((await new AxeBuilder({ page }).include("#inspector")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("pulley-complete-readings.png") });
  expect(errors).toEqual([]);
});
