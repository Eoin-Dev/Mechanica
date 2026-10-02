import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

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

test("a legacy vanishing-wrap pulley stays continuous through stepping, rewind and export", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("mechanica.settings",
    JSON.stringify({ tour_done: true, theme: "dark" })));
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  const radius = 0.22, distance = 2, angleA = -0.1;
  const angleB = angleA - 2 * Math.acos(radius / distance) - 1e-5;
  const vb = [-distance * Math.sin(angleB) * 0.004, distance * Math.cos(angleB) * 0.004];
  const gradientA = angleA + Math.asin(radius / distance), gradientB = angleB - Math.asin(radius / distance);
  const rate = vb[0] * Math.cos(gradientB) + vb[1] * Math.sin(gradientB);
  await (await choosing).setFiles({ name: "Continuous route.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0, substeps: 8 }, bodies: [
      { id: 1, name: "Mass A", pos: [distance * Math.cos(angleA), distance * Math.sin(angleA)],
        vel: [-rate * Math.cos(gradientA), -rate * Math.sin(gradientA)], mass: 1,
        color: [50, 170, 150], collides: false },
      { id: 2, name: "Mass B", pos: [distance * Math.cos(angleB), distance * Math.sin(angleB)],
        vel: vb, mass: 1, color: [220, 130, 90], collides: false },
      { id: 3, pos: [0, 0], is_pulley: true },
    ], links: [{ type: "pulley", id: 1, a: 1, b: 2, pulley: 3,
      length: 2 * Math.sqrt(distance ** 2 - radius ** 2) + radius * 1e-5 }] })) });
  await expect(library).toBeHidden();
  const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
  while (await dismiss.count()) await dismiss.first().click();
  const canvas = page.locator("#canvas");
  let point: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    point = await canvas.evaluate(element => {
      const c = element as HTMLCanvasElement, data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let sx = 0, sy = 0, count = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (Math.abs(data[i] - 50) <= 1 && Math.abs(data[i + 1] - 170) <= 1 && Math.abs(data[i + 2] - 150) <= 1) {
          sx += x; sy += y; count++;
        }
      }
      return count ? { x: sx / count * c.clientWidth / c.width, y: sy / count * c.clientHeight / c.height } : null;
    }); return point !== null;
  }).toBe(true);
  await canvas.click({ position: point! });
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  const inspector = page.locator("#inspector");
  await inspector.getByRole("button", { name: "Select pulley wheel", exact: true }).click();
  const values = inspector.getByRole("group", { name: "Pulley force and motion", exact: true })
    .locator(".pulley-reading-value");
  await expect(values.nth(0)).toHaveText("0.000 N");
  await expect(values.nth(1)).toHaveText("3.976 / 3.976 m");
  await inspector.getByRole("checkbox", { name: "Tension vectors", exact: true }).check();
  await canvas.focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press(".");
  await expect(values.nth(0)).toHaveText("0.000 N");
  await expect(values.nth(1)).toHaveText("3.976 / 3.976 m");
  await page.keyboard.press(","); await page.keyboard.press(".");
  await expect(values.nth(0)).toHaveText("0.000 N");
  await inspector.getByRole("button", { name: "Select particle A: Mass A", exact: true }).click();
  await expect(inspector.getByRole("textbox", { name: "x (m)", exact: true })).toHaveValue("1.990");
  await expect(inspector.getByRole("textbox", { name: "y (m)", exact: true })).toHaveValue("-0.200");
  expect(Math.abs(Number(await inspector.getByRole("textbox", { name: "vx", exact: true }).inputValue()))).toBeLessThan(0.01);
  expect(Math.abs(Number(await inspector.getByRole("textbox", { name: "vy", exact: true }).inputValue()))).toBeLessThan(0.01);
  await page.screenshot({ path: testInfo.outputPath("pulley-continuous-route.png") });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  await library.getByRole("button", { name: "Save current scene", exact: true }).click();
  const name = library.getByRole("textbox", { name: "Scene name", exact: true });
  await name.fill("Continuous route"); await name.press("Enter");
  const downloading = page.waitForEvent("download");
  await library.getByRole("button", { name: "Download Continuous route as a .json file", exact: true }).click();
  const document = JSON.parse(await readFile((await (await downloading).path())!, "utf8"));
  expect(document.links[0].wrap_turns).toBe(-1);
  expect(document.bodies.find((body: { id: number }) => body.id === 1).pos[0]).toBeCloseTo(distance * Math.cos(angleA), 3);
  expect(errors).toEqual([]);
});


test("a slack particle crosses the guide freely with current forces and rewind", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("mechanica.settings",
    JSON.stringify({ tour_done: true, theme: "dark" })));
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Slack free flight.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0, substeps: 8 }, bodies: [
      { id: 1, name: "Moving mass", pos: [-2, -0.01], vel: [0, 0.2], const_force: [0, 0.5],
        mass: 1, color: [50, 170, 150], collides: false },
      { id: 2, name: "Mass B", pos: [2, -2], mass: 1, color: [220, 130, 90], collides: false },
      { id: 3, pos: [0, 0], is_pulley: true },
    ], links: [{ type: "pulley", id: 1, a: 1, b: 2, pulley: 3, length: 20 }] })) });
  await expect(library).toBeHidden();
  const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
  while (await dismiss.count()) await dismiss.first().click();
  const canvas = page.locator("#canvas");
  let point: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    point = await canvas.evaluate(element => {
      const c = element as HTMLCanvasElement, data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let sx = 0, sy = 0, count = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (Math.abs(data[i] - 50) <= 1 && Math.abs(data[i + 1] - 170) <= 1 && Math.abs(data[i + 2] - 150) <= 1) {
          sx += x; sy += y; count++;
        }
      }
      return count ? { x: sx / count * c.clientWidth / c.width, y: sy / count * c.clientHeight / c.height } : null;
    }); return point !== null;
  }).toBe(true);
  await canvas.click({ position: point! });
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  const inspector = page.locator("#inspector");
  await inspector.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
  await inspector.locator(".force-values > summary").click();
  const sources = inspector.getByRole("list", { name: "Force values and sources", exact: true });
  await expect(sources.getByRole("listitem")).toHaveCount(2);
  await expect(sources).toContainText("Fy 0.50 N");
  await expect(sources).not.toContainText(/reaction|correction/i);
  const y = inspector.getByRole("textbox", { name: "y (m)", exact: true });
  const vy = inspector.getByRole("textbox", { name: "vy", exact: true });
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  await expect(clock).toHaveValue("0.00"); await canvas.focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press(".");
  await expect(clock).toHaveValue("0.20");
  await expect(y).toHaveValue("0.040"); await expect(vy).toHaveValue("0.300");
  await expect(sources).not.toContainText(/reaction|correction/i);
  await canvas.focus(); await page.keyboard.press(",");
  await expect(clock).toHaveValue("0.18"); await expect(vy).toHaveValue("0.292");
  await page.keyboard.press(".");
  await expect(y).toHaveValue("0.040"); await expect(vy).toHaveValue("0.300");
  await expect(sources.getByRole("listitem")).toHaveCount(2);
  expect((await new AxeBuilder({ page }).include("#inspector")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("pulley-free-guide-motion.png") });
  expect(errors).toEqual([]);
});
