import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function measurements(page: Page, theme = "light", studio = true) {
  await page.addInitScript(({ theme, studio }) => {
    localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, theme, studio_mode: studio }));
  }, { theme, studio });
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Graph measurements.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0 }, bodies: [{
      id: 1, name: "Measured particle", pos: [7, -4], vel: [-3, 4], radius: 0.2, mass: 2,
    }] })) });
  await expect(library).toBeHidden();
  await page.getByRole("tab", { name: "View", exact: true }).click();
  await page.getByRole("combobox", { name: "Graph shown in the dock", exact: true }).selectOption("Displacement");
  const canvas = page.locator("#canvas"); await canvas.focus(); await page.keyboard.press("f");
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  for (let i = 0; i < 30; i++) await page.keyboard.press(".");
  await page.locator("#dock").getByRole("button", { name: "Data", exact: true }).click();
  return page.getByRole("dialog", { name: "Graph data", exact: true });
}

test("graph inspection, zoom, navigation and both exports retain exact measurements", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const dialog = await measurements(page);
  await expect(dialog.getByRole("heading", { name: "Displacement", exact: true })).toBeVisible();
  await expect(dialog.locator(".graph-data-kind")).toHaveText("Graph data · 4 of 6");
  await expect(dialog.locator(".graph-data-table-region")).toBeHidden();
  const chart = dialog.locator(".graph-chart-surface"), reading = dialog.locator(".graph-chart-reading");
  await expect(chart.locator("svg")).toContainText("Time (s)");
  await expect(chart.locator("svg")).toContainText("Displacement (m)");
  await chart.focus(); await chart.press("End");
  await expect(reading).toContainText("Time (s): 0.5");
  await expect(reading).toContainText("sx (m): -1.5");
  await chart.press("ArrowDown"); await expect(reading).toContainText("sy (m): 2");
  await dialog.getByRole("button", { name: "Zoom in graph", exact: true }).click();
  await expect(dialog.locator(".graph-zoom-level")).toHaveText("2×");
  await chart.focus(); await chart.press("+");
  await expect(dialog.locator(".graph-zoom-level")).toHaveText("4×");
  await chart.press("0"); await expect(dialog.locator(".graph-zoom-level")).toHaveText("1×");
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await expect(reading).toContainText("Point");
  await page.mouse.wheel(0, -120);
  await expect(dialog.locator(".graph-zoom-level")).not.toHaveText("1×");
  const beforePan = await chart.locator('[data-channel="sx_m"]').getAttribute("d");
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 6 });
  await page.mouse.up();
  await expect(chart.locator('[data-channel="sx_m"]')).not.toHaveAttribute("d", beforePan!);
  await expect(chart).not.toHaveClass(/panning/);
  await chart.focus(); await chart.press("Shift+ArrowLeft");
  await expect(chart.locator("g[clip-path] path[data-channel]")).toHaveCount(2);
  await expect(chart.locator("g[clip-path] path[data-channel]")).toHaveCount(2);
  const receivingImage = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export PNG", exact: true }).click();
  const image = await receivingImage; expect(await image.failure()).toBeNull();
  expect(image.suggestedFilename()).toBe("mechanica-displacement.png");
  const png = await readFile((await image.path())!);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([2400, 1440]);
  await dialog.getByRole("button", { name: "Numbers", exact: true }).click();
  await expect(dialog.locator("tbody tr")).toHaveCount(25);
  const receivingCSV = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export CSV", exact: true }).click();
  const csv = await readFile((await (await receivingCSV).path())!, "utf8");
  const rows = csv.trimEnd().split("\r\n"); expect(rows).toHaveLength(32);
  const last = rows.at(-1)!.split(",").map(Number);
  expect(last[0]).toBeCloseTo(0.5, 12); expect(last[1]).toBeCloseTo(-1.5, 12);
  expect(last[2]).toBeCloseTo(2, 12); expect(last.slice(-4)).toEqual([1, 0, 7, -4]);
  await dialog.getByRole("button", { name: "Graph", exact: true }).click();
  for (const title of ["Distance travelled", "Velocity", "Energy", "Momentum", "Phase space", "Displacement"]) {
    await dialog.getByRole("button", { name: "Next graph", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(dialog.locator(".graph-zoom-level")).toHaveText("1×");
    if (title === "Momentum") {
      await dialog.getByRole("button", { name: "Angular", exact: true }).click();
      await expect(chart.locator("svg")).toContainText("Angular momentum");
      await expect(chart.locator("path[data-channel]")).toHaveCount(1);
    }
    if (title === "Phase space") {
      await dialog.getByRole("button", { name: "y–vy", exact: true }).click();
      await expect(chart.locator("svg")).toContainText("vy (m/s)");
      await chart.focus(); await chart.press("End");
      await expect(reading).toContainText("y (m): -2");
      await expect(reading).toContainText("vy (m/s): 4");
    }
  }
  await page.screenshot({ path: testInfo.outputPath("graph-viewer-interaction.png") });
  expect(errors).toEqual([]);
});

for (const [name, theme, width, scale, studio] of [
  ["light", "light", 1440, 1, true], ["dark", "dark", 1440, 1, true],
  ["void", "void", 1440, 1, true], ["phone", "light", 390, 1, true],
  ["enlarged", "dark", 320, 2, true], ["classic", "light", 320, 2, false],
] as const) {
  test(`graph viewer remains readable and accessible in ${name}`, async ({ page }, testInfo) => {
    const dialog = await measurements(page, theme, studio);
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(scale => document.documentElement.style.setProperty("--fs", String(scale)), scale);
    await expect(dialog.locator(".graph-chart-surface svg text").first()).toHaveAttribute("font-size", String(12 * scale));
    const geometry = await dialog.evaluate(panel => {
      const bounds = panel.getBoundingClientRect();
      return { contained: bounds.left >= 0 && bounds.right <= innerWidth,
        tabs: [...panel.querySelectorAll<HTMLElement>(".graph-switch")].every(tab => {
          const box = tab.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth;
        }), bodyFits: panel.querySelector<HTMLElement>(".graph-data-body")!.scrollWidth <=
          panel.querySelector<HTMLElement>(".graph-data-body")!.clientWidth,
        choices: [...panel.querySelectorAll<HTMLElement>(".graph-data-view-buttons button")].every(button =>
          getComputedStyle(button).borderLeftWidth === "0px" && getComputedStyle(button).borderRightWidth === "0px") };
    });
    expect(geometry).toEqual({ contained: true, tabs: true, bodyFits: true, choices: true });
    await expect(dialog.locator(".graph-chart-surface svg")).toBeVisible();
    expect((await new AxeBuilder({ page }).include("#graph-data")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`graph-viewer-${name}.png`) });
  });
}
