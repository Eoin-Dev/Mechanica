import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type Caption = { text: string; left: number; right: number; top: number; bottom: number };

async function loadScene(page: Page, scene: unknown) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Contact investigation.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(scene)) });
  await expect(library).toBeHidden();
}

async function pickParticle(page: Page, colour: number[]) {
  const canvas = page.locator("#canvas");
  let point: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    point = await canvas.evaluate((element, colour) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let xSum = 0, ySum = 0, count = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (colour.every((channel, c) => Math.abs(pixels[i + c] - channel) <= 1)) {
          xSum += x; ySum += y; count++;
        }
      }
      return count ? { x: xSum / count * canvas.clientWidth / canvas.width,
        y: ySum / count * canvas.clientHeight / canvas.height } : null;
    }, colour);
    return point !== null;
  }).toBe(true);
  await canvas.click({ position: point! });
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, theme: "light" }));
    const captions: Caption[] = [];
    Object.defineProperty(window, "contactCaptions", { value: captions });
    const clear = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function(x, y, w, h) {
      if (this.canvas.id === "canvas" && x === 0 && y === 0 && w > 100 && h > 100) captions.length = 0;
      clear.call(this, x, y, w, h);
    };
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
      if (this.canvas.id === "canvas" && /^(?:[WRTf]|F[∥⊥])[₀-₉]*\s.*N$/.test(text)) {
        const metrics = this.measureText(text);
        captions.push({ text, left: x - metrics.actualBoundingBoxLeft,
          right: x + metrics.actualBoundingBoxRight, top: y - metrics.actualBoundingBoxAscent,
          bottom: y + metrics.actualBoundingBoxDescent });
      }
      if (maxWidth === undefined) fill.call(this, text, x, y);
      else fill.call(this, text, x, y, maxWidth);
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
});

test("current diagrams show all loaded slope contacts and update immediately through editing and undo", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const theta = 25 * Math.PI / 180, tx = Math.cos(theta), ty = -Math.sin(theta);
  await loadScene(page, { settings: { gravity: 9.81 },
    bodies: [-0.4, 0, 0.4].map((s, i) => ({ id: i + 1, name: ["Upper", "Middle", "Lower"][i],
      pos: [s * tx - 0.25 * ty, s * ty + 0.25 * tx], radius: 0.2, mass: 1,
      no_rotation: true, friction: 0, restitution: 0, locked: i === 2,
      color: [[110, 200, 210], [120, 190, 120], [220, 130, 90]][i] })),
    walls: [{ id: 1, name: "Slope", a: [-3 * tx, -3 * ty], b: [3 * tx, 3 * ty],
      thickness: 0.1, friction: 0, restitution: 0 }] });
  await pickParticle(page, [120, 190, 120]);
  const toggle = page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true });
  await toggle.check();
  const summary = page.locator(".force-values > summary");
  await expect(summary).toBeVisible();
  await summary.focus(); await page.keyboard.press("Enter");
  const sources = page.getByRole("list", { name: "Force values and sources", exact: true });
  await expect(sources.getByRole("listitem")).toHaveCount(5);
  for (const name of ["R₁: Reaction from Upper", "R₂: Reaction from Lower", "R₃: Reaction from Slope"]) {
    await expect(sources).toContainText(name);
  }
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  await expect(clock).toHaveValue("0.00");
  await expect(page.locator(".force-interval-note")).toContainText("Current forces.");
  await expect(page.locator(".force-interval-note")).not.toContainText("Step once");
  const slope = page.getByRole("combobox", { name: "Resolve forces relative to a slope", exact: true });
  await slope.selectOption("1");
  const readCaptions = () => page.evaluate(() =>
    (window as unknown as { contactCaptions: Caption[] }).contactCaptions.slice());
  await expect.poll(async () => (await readCaptions()).map(caption => caption.text).sort())
    .toEqual(["R₁ 4.15 N", "R₂ 8.29 N", "R₃ 8.89 N", "W 9.81 N"].sort());
  const mass = page.getByRole("textbox", { name: "Mass (type an exact value)", exact: true });
  await mass.fill("2"); await mass.press("Enter");
  await expect.poll(async () => (await readCaptions()).map(caption => caption.text).sort())
    .toEqual(["R₁ 4.15 N", "R₂ 12.44 N", "R₃ 17.78 N", "W 19.62 N"].sort());
  await expect(clock).toHaveValue("0.00");
  await page.locator("#canvas").click({ position: { x: 15, y: 15 } });
  await page.keyboard.press("Control+z");
  await pickParticle(page, [120, 190, 120]);
  await expect(toggle).toBeChecked(); await expect(mass).toHaveValue("1 kg");
  await expect.poll(async () => (await readCaptions()).map(caption => caption.text).sort())
    .toEqual(["R₁ 4.15 N", "R₂ 8.29 N", "R₃ 8.89 N", "W 9.81 N"].sort());
  for (const [layout, width, theme] of [
    ["light", 1440, "Light"], ["dark", 1440, "Dark"], ["void", 1440, "Void"],
    ["phone-enlarged", 390, "Light"],
  ] as const) {
    await page.locator("#btn-settings").click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: theme, exact: true }).click();
    if (width === 390) await settings.getByRole("button", { name: "120%", exact: true }).click();
    await page.keyboard.press("Escape"); await page.setViewportSize({ width, height: 900 });
    const hide = page.getByRole("button", { name: "Hide Inspector", exact: true });
    if (width === 390 && await hide.isVisible()) await hide.click();
    await expect.poll(async () => (await readCaptions()).filter(caption => /^R[₁₂₃] /.test(caption.text)).length).toBe(3);
    const bounds = await page.locator("#canvas").evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
    const captions = await readCaptions();
    for (const caption of captions) {
      expect(caption.left).toBeGreaterThanOrEqual(0); expect(caption.right).toBeLessThanOrEqual(bounds.width);
      expect(caption.top).toBeGreaterThanOrEqual(0); expect(caption.bottom).toBeLessThanOrEqual(bounds.height);
    }
    for (let i = 0; i < captions.length; i++) for (let j = i + 1; j < captions.length; j++) {
      const a = captions[i], b = captions[j];
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath(`immediate-contact-diagram-${layout}.png`) });
    expect((await new AxeBuilder({ page }).include("#inspector")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze()).violations).toEqual([]);
    await expect(clock).toHaveValue("0.00");
  }
  expect(errors).toEqual([]);
});

test("a floor-supported pulley displays its coupled tension and reaction without a first step", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await loadScene(page, { settings: { gravity: 9.81 }, bodies: [
    { id: 1, name: "Supported mass", pos: [-0.22, 0], mass: 3, color: [50, 170, 150] },
    { id: 2, name: "Hanging mass", pos: [0.22, 0], mass: 1, color: [220, 130, 90] },
    { id: 3, name: "Wheel", pos: [0, 2], is_pulley: true },
  ], walls: [{ id: 1, name: "Floor", a: [-2, -0.18], b: [-0.01, -0.18], thickness: 0.04,
    restitution: 0, friction: 0 }], links: [{ type: "pulley", id: 1, a: 1, b: 2, pulley: 3 }] });
  await pickParticle(page, [50, 170, 150]);
  await page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
  await page.locator(".force-values > summary").click();
  const sources = page.getByRole("list", { name: "Force values and sources", exact: true });
  await expect(sources).toContainText("T: Pulley-string tension");
  await expect(sources.getByRole("listitem").filter({ hasText: "Pulley-string tension" })).toContainText("Fy 9.81 N");
  await expect(sources.getByRole("listitem").filter({ hasText: "Reaction from Floor" })).toContainText("Fy 19.62 N");
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  await expect(clock).toHaveValue("0.00");
  await page.screenshot({ path: testInfo.outputPath("immediate-supported-pulley.png") });
  expect((await new AxeBuilder({ page }).include("#inspector")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(errors).toEqual([]);
});
