import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

interface Caption {
  text: string; left: number; right: number; top: number; bottom: number;
  fontSize: number; ink: number[]; background: number[];
}

function contrast(a: number[], b: number[]): number {
  const luminance = (colour: number[]): number => colour.slice(0, 3).reduce((sum, value, i) => {
    const channel = value / 255;
    return sum + [0.2126, 0.7152, 0.0722][i] *
      (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  }, 0);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("scientific canvas captions remain readable, separate and contained", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, theme: "light" }));
    const captions: Caption[] = [];
    const componentRows: Caption[] = [];
    Object.defineProperty(window, "analysisCaptions", { value: captions });
    Object.defineProperty(window, "analysisComponentRows", { value: componentRows });
    const clear = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function(x, y, w, h) {
      if (this.canvas.id === "canvas" && x === 0 && y === 0 && w > 100 && h > 100) {
        captions.length = 0; componentRows.length = 0;
      }
      clear.call(this, x, y, w, h);
    };
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
      const isCaption = /^(?:[WFRCDTSf]|fₛ|F[∥⊥])[₀-₉]*\s.*N$/.test(text);
      const isComponent = /^(?:Slope components \(N\)|∥ Along|⊥ Normal|[WFRCDTS]|fₛ|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/.test(text);
      if (this.canvas.id === "canvas" && (isCaption || isComponent)) {
        const metrics = this.measureText(text);
        const fontSize = Number(this.font.match(/([\d.]+)px/)?.[1]);
        const left = x - metrics.actualBoundingBoxLeft, right = x + metrics.actualBoundingBoxRight;
        const top = y - metrics.actualBoundingBoxAscent, bottom = y + metrics.actualBoundingBoxDescent;
        const matrix = this.getTransform();
        const px = Math.round(((left + right) / 2) * matrix.a + matrix.e);
        const py = Math.round(((top + bottom) / 2) * matrix.d + matrix.f);
        const background = Array.from(this.getImageData(px, py, 1, 1).data);
        const ink = String(this.fillStyle).startsWith("#")
          ? [1, 3, 5].map(offset => parseInt(String(this.fillStyle).slice(offset, offset + 2), 16))
          : (String(this.fillStyle).match(/[\d.]+/g) ?? []).map(Number);
        const row = { text, left, right, top, bottom, fontSize, ink, background };
        if (isCaption) captions.push(row);
        if (isComponent) componentRows.push(row);
      }
      if (maxWidth === undefined) fill.call(this, text, x, y);
      else fill.call(this, text, x, y, maxWidth);
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Caption investigation.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 9.8 },
      bodies: [{ id: 1, name: "Force investigation", pos: [0, 0], radius: 4, mass: 2,
        const_force: [3, 0], color: [125, 80, 190], collides: false }],
      walls: [{ id: 1, name: "Reference slope", a: [-2, -2], b: [2, -1] }],
      fields: [{ name: "Matching horizontal force", fx: "3+120*t", fy: "0", enabled: true }],
    })) });
  await expect(library).toBeHidden();
  const canvas = page.locator("#canvas");
  await canvas.focus();
  await page.keyboard.press("f");
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  await page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
  const outcomes: Array<{ layout: string; width: number; height: number; scale: number; captions: Caption[] }> = [];
  for (const [layout, width, theme, scale] of [
    ["light-desktop", 1440, "Light", 1], ["dark-desktop", 1440, "Dark", 1],
    ["void-desktop", 1440, "Void", 1], ["phone-enlarged", 390, "Light", 1.2],
  ] as const) {
    await page.locator("#btn-settings").click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: theme, exact: true }).click();
    await settings.getByRole("button", { name: scale === 1 ? "100%" : "120%", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width, height: 900 });
    if (width <= 760) await expect(page.getByRole("button", { name: "Open Inspector", exact: true })).toBeVisible();
    await canvas.focus();
    await page.keyboard.press("f");
    await expect.poll(() => page.evaluate(() => (window as unknown as { analysisCaptions: Caption[] }).analysisCaptions.length))
      .toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: testInfo.outputPath(`analysis-captions-${layout}.png`) });
    const result = await canvas.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight,
      captions: (window as unknown as { analysisCaptions: Caption[] }).analysisCaptions.slice() }));
    outcomes.push({ layout, scale, ...result });
  }
  const metricsPath = testInfo.outputPath("caption-metrics.json");
  await writeFile(metricsPath, JSON.stringify(outcomes, null, 2));
  await testInfo.attach("caption-metrics", { path: metricsPath, contentType: "application/json" });
  for (const outcome of outcomes) {
    for (const caption of outcome.captions) {
      expect(caption.left, `${outcome.layout}: ${caption.text} left`).toBeGreaterThanOrEqual(0);
      expect(caption.right, `${outcome.layout}: ${caption.text} right`).toBeLessThanOrEqual(outcome.width);
      expect(caption.top, `${outcome.layout}: ${caption.text} top`).toBeGreaterThanOrEqual(0);
      expect(caption.bottom, `${outcome.layout}: ${caption.text} bottom`).toBeLessThanOrEqual(outcome.height);
      expect(caption.fontSize, `${outcome.layout}: scalable caption`).toBeGreaterThanOrEqual(12 * outcome.scale);
      expect(contrast(caption.ink, caption.background), `${outcome.layout}: ${caption.text} contrast`).toBeGreaterThanOrEqual(4.5);
    }
    const matching = outcome.captions.filter(caption => /^f[₁₂] 3\.00 N$/.test(caption.text));
    expect(matching).toHaveLength(2);
    expect(matching.map(caption => caption.text).sort()).toEqual(["f₁ 3.00 N", "f₂ 3.00 N"]);
    const [a, b] = matching;
    expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
      `${outcome.layout}: matching forces must have separate captions`).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  const disclosure = page.locator(".force-values > summary");
  await disclosure.focus();
  await page.keyboard.press("Enter");
  const sources = page.getByRole("list", { name: "Force values and sources", exact: true });
  await expect(sources).toBeVisible();
  await expect(sources.getByRole("listitem")).toHaveCount(4);
  await expect(sources).toContainText("Matching horizontal force");
  await expect(sources.locator(".force-resultant")).toContainText("Fx 6.00 N");
  await expect(sources.locator(".force-resultant")).toContainText("Fy -19.60 N");
  await expect(disclosure).toBeFocused();
  await page.setViewportSize({ width: 320, height: 500 });
  const openInspector = page.getByRole("button", { name: "Open Inspector", exact: true });
  await expect(openInspector).toBeVisible();
  await openInspector.click();
  await page.locator("#inspector-panel").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => page.locator(".force-interval-note").evaluate(element =>
    element.getBoundingClientRect().bottom - document.getElementById("inspector-panel")!.getBoundingClientRect().top))
    .toBeLessThan(-80);
  await canvas.focus();
  await page.keyboard.press(".");
  const changingSource = sources.getByRole("listitem").filter({ hasText: "Matching horizontal force" });
  await expect(changingSource).toContainText("Fx 4.50 N");
  await expect(sources.locator(".force-resultant")).toContainText("Fx 7.50 N");
  await page.setViewportSize({ width: 1440, height: 900 });
  const fx = page.getByRole("textbox", { name: "Fx (N)", exact: true });
  await fx.fill("-1000000");
  await fx.press("Enter");
  const fy = page.getByRole("textbox", { name: "Fy (N)", exact: true });
  await fy.fill("-0.0004");
  await fy.press("Enter");
  await expect(sources).toContainText("Fx -1.00e+6 N");
  await expect(sources).toContainText("Fy -4.00e-4 N");
  const slope = page.getByRole("combobox", { name: "Resolve forces relative to a slope", exact: true });
  await expect(slope).toBeDisabled();
  await expect(slope).toHaveAttribute("title", "No slope in contact.");
  await page.getByRole("checkbox", { name: "Collides", exact: true }).setChecked(true);
  await slope.scrollIntoViewIfNeeded();
  await expect(slope).toBeEnabled();
  await slope.selectOption("1");
  await expect(sources).toContainText("∥ -9.70e+5 N");
  await expect(sources).toContainText("⊥ 2.43e+5 N");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const open = page.getByRole("button", { name: "Open Inspector", exact: true });
    if (width === 390) await expect(open).toBeVisible();
    if (await open.isVisible()) await open.click();
    await sources.scrollIntoViewIfNeeded();
    await expect(sources.getByRole("listitem")).toHaveCount(4);
    const bounds = await sources.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
    const components = await sources.locator(".force-component").evaluateAll(elements => elements.map(element => ({
      client: element.clientWidth, scroll: element.scrollWidth, whiteSpace: getComputedStyle(element).whiteSpace,
    })));
    for (const component of components) {
      expect(component.whiteSpace).toBe("nowrap");
      expect(component.scroll).toBeLessThanOrEqual(component.client + 1);
    }
    await page.screenshot({ path: testInfo.outputPath(`force-sources-${width}.png`) });
    if (width <= 760) await page.getByRole("button", { name: "Hide Inspector", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { analysisComponentRows: Caption[] }).analysisComponentRows.length))
      .toBe(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { analysisCaptions: Caption[] }).analysisCaptions.some(row => row.text.startsWith("F∥ ")))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`slope-components-${width}.png`) });
    const metrics = await canvas.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight,
      rows: [...(window as unknown as { analysisComponentRows: Caption[] }).analysisComponentRows,
        ...(window as unknown as { analysisCaptions: Caption[] }).analysisCaptions] }));
    for (const row of metrics.rows) {
      expect(row.left, `${width}: ${row.text} left`).toBeGreaterThanOrEqual(0);
      expect(row.right, `${width}: ${row.text} right`).toBeLessThanOrEqual(metrics.width);
      expect(row.top, `${width}: ${row.text} top`).toBeGreaterThanOrEqual(0);
      expect(row.bottom, `${width}: ${row.text} bottom`).toBeLessThanOrEqual(metrics.height);
      expect(contrast(row.ink, row.background), `${width}: ${row.text} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(errors).toEqual([]);
});
