import { expect, test, type Page } from "@playwright/test";

async function state(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    const recovery = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
    return { scene: JSON.parse(recovery.scene), presentation: recovery.presentation };
  });
}

async function load(page: Page, extra: number) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Slack strings.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0 }, bodies: [
      { id: 1, name: "Rope A", pos: [-2, -1], color: [70, 150, 210] },
      { id: 2, name: "Rope B", pos: [0, -1], color: [120, 190, 120] },
      { id: 3, name: "Elastic A", pos: [0.5, -1], color: [70, 150, 210] },
      { id: 4, name: "Elastic B", pos: [2.5, -1], color: [120, 190, 120] },
      { id: 5, name: "Pulley A", pos: [-0.22, 1], color: [50, 170, 150] },
      { id: 6, name: "Pulley B", pos: [0.22, 1], color: [220, 130, 90] },
      { id: 7, name: "Wheel", pos: [0, 2], is_pulley: true },
    ], walls: [{ id: 1, name: "Reference platform", a: [-3, -2.5], b: [3, -2.5], thickness: 0.04 }],
    links: [{ type: "rod", id: 1, a: 1, b: 2, is_rope: true, length: 2 + extra },
      { type: "spring", id: 1, a: 3, b: 4, tension_only: true, rest_length: 2 + extra, stiffness: 20 },
      { type: "pulley", id: 1, a: 5, b: 6, pulley: 7, length: 2 + Math.PI * 0.22 + extra }] })) });
  await expect(library).toBeHidden();
  const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
  while (await dismiss.count()) await dismiss.first().click();
  await page.mouse.move(0, 0);
}

async function ropeInk(page: Page) {
  const recovery = await state(page), [cx, cy, zoom] = recovery.presentation.camera;
  return page.locator("#canvas").evaluate((element, { cx, cy, zoom }) => {
    const canvas = element as HTMLCanvasElement, sx = canvas.width / canvas.clientWidth,
      sy = canvas.height / canvas.clientHeight, middleX = canvas.clientWidth / 2 + (-1 - cx) * zoom,
      baseY = canvas.clientHeight / 2 + (cy + 1) * zoom;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let depth = -Infinity, count = 0;
    for (let y = Math.max(0, Math.floor((baseY - 2) * sy)); y < Math.min(canvas.height, (baseY + 220) * sy); y++) {
      for (let x = Math.max(0, Math.floor((middleX - zoom * 0.5) * sx)); x < Math.min(canvas.width, (middleX + zoom * 0.5) * sx); x++) {
        const k = (y * canvas.width + x) * 4;
        if (data[k] > data[k + 1] + 4 && data[k + 1] > data[k + 2] + 5) {
          count++; depth = Math.max(depth, y / sy - baseY);
        }
      }
    }
    return { depth, count, middleX, baseY };
  }, { cx, cy, zoom });
}

for (const theme of ["dark", "light"]) {
  test(`slack grows visibly, stays selectable and disappears in Performance (${theme})`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem("mechanica.settings",
      JSON.stringify({ tour_done: true, theme, adaptive_dt: false, perf_mode: false })), theme);
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
    let previous = 0;
    for (const extra of [0.005, 0.03, 0.2]) {
      await load(page, extra);
      await expect.poll(async () => (await ropeInk(page)).count).toBeGreaterThan(10);
      const before = await state(page), ink = await ropeInk(page);
      expect(ink.depth).toBeGreaterThan(previous + 1); previous = ink.depth;
      expect(ink.depth).toBeLessThanOrEqual(110); // 108 px sag plus antialiasing
      await page.screenshot({ path: testInfo.outputPath(`slack-${extra}-${theme}.png`) });
      const after = await state(page); expect(after.scene).toEqual(before.scene);
      expect(after.presentation.camera).toEqual(before.presentation.camera);
    }
    const ink = await ropeInk(page), canvas = page.locator("#canvas");
    await canvas.click({ position: { x: ink.middleX, y: ink.baseY + ink.depth - 0.5 } });
    await expect(page.locator("#inspector").getByRole("slider", { name: "Nat. len", exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.locator("#btn-settings").click();
    await page.getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("checkbox", { name: "Performance mode", exact: true }).check();
    await page.keyboard.press("Escape");
    // Deselect the string so the same gold ink can be measured in both modes.
    await canvas.click({ position: { x: 30, y: 30 } }); await page.mouse.move(0, 0);
    await expect.poll(async () => (await ropeInk(page)).depth).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath(`slack-performance-${theme}.png`) });
    expect((await state(page)).scene.settings.time).toBe(0);
    expect(errors).toEqual([]);
  });
}
