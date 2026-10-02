import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function selectPair(page: Page): Promise<void> {
  await clearSelection(page);
  await selectPaintedBody(page, [86, 156, 214]);
  await page.keyboard.down("Shift");
  try { await selectPaintedBody(page, [220, 130, 90]); }
  finally { await page.keyboard.up("Shift"); }
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Restitution (type an exact value)", exact: true })).toHaveValue("0.60");
}

async function clearSelection(page: Page): Promise<void> {
  // Clicking an already-selected particle retains its group for dragging.
  await page.locator("#canvas").click({ position: { x: 20, y: 20 } });
}

async function selectPaintedBody(page: Page, colour: [number, number, number]): Promise<void> {
  const canvas = page.locator("#canvas");
  await page.mouse.move(0, 0);
  let position: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    position = await canvas.evaluate((element, rgb) => {
      const scene = element as HTMLCanvasElement;
      const pixels = scene.getContext("2d")!.getImageData(0, 0, scene.width, scene.height).data;
      const matches = (x: number, y: number) => {
        const i = (y * scene.width + x) * 4;
        return Math.abs(pixels[i] - rgb[0]) <= 1 && Math.abs(pixels[i + 1] - rgb[1]) <= 1 &&
          Math.abs(pixels[i + 2] - rgb[2]) <= 1;
      };
      // A solid interior patch identifies the disc even when another
      // particle's thin selection rim shares this colour.
      for (let y = 3; y < scene.height - 3; y++) for (let x = 3; x < scene.width - 3; x++) {
        if (!matches(x, y)) continue;
        let solid = true;
        for (let dy = -3; dy <= 3 && solid; dy++) for (let dx = -3; dx <= 3; dx++) {
          if (!matches(x + dx, y + dy)) { solid = false; break; }
        }
        if (solid) return { x: x * scene.clientWidth / scene.width,
          y: y * scene.clientHeight / scene.height };
      }
      return null;
    }, colour);
    return position !== null;
  }).toBe(true);
  await canvas.click({ position: position! });
}

test("compact material sliders offer hover guidance and the worked collision matches its velocities", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({
    tour_done: true, theme: "light", studio_mode: true, adaptive_dt: false,
  })));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("searchbox", { name: "Search examples", exact: true }).fill("direct collision");
  await library.getByRole("button", { name: "Load Direct collision", exact: true }).press("Enter");
  await expect(library).toBeHidden();
  const notifications = page.getByRole("button", { name: "Dismiss notification", exact: true });
  while (await notifications.count()) await notifications.first().click();
  await selectPair(page);
  await expect(page.getByText("Collision model", { exact: true })).toHaveCount(0);
  const restitution = page.getByRole("textbox", { name: "Restitution (type an exact value)", exact: true });
  const friction = page.getByRole("textbox", { name: "Friction (type an exact value)", exact: true });
  for (const [label, term] of [["Restitution", "relative separation"], ["Friction", "√(μ₁ × μ₂)"]] as const) {
    const range = page.getByRole("slider", { name: label, exact: true });
    const caption = range.locator("..").locator(".lbl");
    await caption.hover();
    expect(await caption.getAttribute("title")).toContain(term);
    await expect(range).toHaveAttribute("title", await caption.getAttribute("title") ?? "");
    await expect(range).toHaveAttribute("aria-description", await caption.getAttribute("title") ?? "");
    await range.hover();
  }
  await restitution.fill("0.8"); await restitution.press("Enter");
  await expect(restitution).toHaveValue("0.80");
  await page.locator("#canvas").focus(); await page.keyboard.press("Control+z");
  await selectPair(page);
  await friction.fill("0.7"); await friction.press("Enter");
  await expect(friction).toHaveValue("0.70");
  await page.locator("#canvas").focus(); await page.keyboard.press("Control+z");
  await selectPair(page);
  await expect(friction).toHaveValue("0.00");
  const frictionRange = page.getByRole("slider", { name: "Friction", exact: true });
  await frictionRange.focus(); await frictionRange.press("End");
  await expect(friction).toHaveValue("10.00");
  await expect(frictionRange).toHaveAttribute("aria-valuetext", "10.00");
  // Canvas has no tab stop: focus() would leave the range owning Ctrl+Z.
  await clearSelection(page); await page.keyboard.press("Control+z");
  await selectPair(page);
  await expect(friction).toHaveValue("0.00");

  let previousWidth = 1440;
  for (const [layout, width, theme, studio, scale] of [
    ["light-studio", 1440, "Light", true, 1],
    ["dark-studio", 1440, "Dark", true, 1],
    ["void-classic", 1440, "Void", false, 1.2],
    ["phone-enlarged", 390, "Light", true, 1.2],
    ["narrow-double-text", 320, "Dark", false, 2],
  ] as const) {
    await page.locator("#btn-settings").click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: theme, exact: true }).click();
    await settings.getByRole("checkbox", { name: "Studio mode", exact: true }).setChecked(studio);
    await settings.getByRole("button", { name: scale === 1 ? "100%" : "120%", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width, height: 900 });
    if (scale === 2) await page.evaluate(() => document.documentElement.style.setProperty("--fs", "2"));
    const open = page.getByRole("button", { name: "Open Inspector", exact: true });
    if (width <= 760 && previousWidth > 760) await expect(open).toBeVisible();
    if (await open.isVisible()) await open.click();
    previousWidth = width;
    await restitution.scrollIntoViewIfNeeded();
    const group = page.locator(".material-controls");
    const geometry = await group.evaluate(element => [...element.querySelectorAll(".material-control")].map(row => {
      const caption = row.querySelector(".lbl")!;
      const value = row.querySelector(".val")!;
      const track = row.querySelector('input[type="range"]')!;
      const c = caption.getBoundingClientRect(), v = value.getBoundingClientRect(), t = track.getBoundingClientRect();
      return { client: row.clientWidth, scroll: row.scrollWidth, captionHeight: c.height,
        captionSize: parseFloat(getComputedStyle(caption).fontSize), captionY: (c.top + c.bottom) / 2,
        valueY: (v.top + v.bottom) / 2, trackY: (t.top + t.bottom) / 2,
        trackLeft: t.left, trackWidth: t.width, leftGap: t.left - c.right, rightGap: v.left - t.right };
    }));
    expect(geometry).toHaveLength(2);
    for (const row of geometry) {
      expect(row.scroll).toBeLessThanOrEqual(row.client + 1);
      expect(row.captionHeight, `complete material caption in ${layout}`).toBeLessThan(row.captionSize * 1.6);
      expect(Math.abs(row.captionY - row.trackY), `inline label and track in ${layout}`).toBeLessThan(1);
      expect(Math.abs(row.valueY - row.trackY), `inline value and track in ${layout}`).toBeLessThan(1);
      expect(row.leftGap).toBeLessThanOrEqual(5); expect(row.rightGap).toBeLessThanOrEqual(5);
      expect(row.trackWidth).toBeGreaterThanOrEqual(24);
    }
    expect(geometry[0].trackLeft).toBeCloseTo(geometry[1].trackLeft, 1);
    expect(geometry[0].trackWidth).toBeCloseTo(geometry[1].trackWidth, 1);
    if (scale === 1) expect(geometry[0].trackWidth).toBeGreaterThan(120);
    await page.locator("#inspector").screenshot({ path: testInfo.outputPath(`collision-material-${layout}.png`) });
    const superball = page.getByRole("button", { name: "Superball", exact: true });
    await superball.scrollIntoViewIfNeeded();
    const word = await superball.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return { height: range.getBoundingClientRect().height,
        size: parseFloat(getComputedStyle(element).fontSize) };
    });
    expect(word.height, `complete material name in ${layout}`).toBeLessThan(word.size * 1.6);
    await page.locator("#inspector").screenshot({ path: testInfo.outputPath(`collision-material-names-${layout}.png`) });
    const scan = await new AxeBuilder({ page }).include("#inspector")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
    expect(scan.violations).toEqual([]);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.style.removeProperty("--fs"));
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  await clock.fill("1"); await clock.press("Enter");
  await expect(clock).toHaveAttribute("aria-busy", "false");
  await expect(clock).toHaveValue("1.00");
  await expect(page.getByRole("textbox", { name: "Restitution (type an exact value)", exact: true })).toHaveValue("0.60");
  await clearSelection(page);
  await selectPaintedBody(page, [86, 156, 214]);
  await expect(page.getByRole("textbox", { name: "vx", exact: true })).toHaveValue("-0.800");
  await clearSelection(page);
  await selectPaintedBody(page, [220, 130, 90]);
  await expect(page.getByRole("textbox", { name: "vx", exact: true })).toHaveValue("2.200");
  await selectPair(page);
  await page.screenshot({ path: testInfo.outputPath("direct-collision-after-impact.png") });
  expect(errors).toEqual([]);
});
