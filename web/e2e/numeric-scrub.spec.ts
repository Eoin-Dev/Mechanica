import { expect, test, type Page } from "@playwright/test";

async function state(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    const saved = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
    return { scene: JSON.parse(saved.scene), presentation: saved.presentation };
  });
}
async function load(page: Page, name: string) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("searchbox").fill(name);
  await library.getByRole("button", { name: `Load ${name}`, exact: true }).click();
  await expect(library).toBeHidden();
}
async function selectBlue(page: Page) {
  const before = await state(page), [cx, cy, zoom] = before.presentation.camera;
  const canvas = page.locator("#canvas"), size = await canvas.evaluate(el => ({ w: el.clientWidth, h: el.clientHeight }));
  const blue = before.scene.bodies.find((body: { color: number[] }) => body.color?.[0] === 86);
  await canvas.click({ position: { x: size.w / 2 + (blue.pos[0] - cx) * zoom,
    y: size.h / 2 + (cy - blue.pos[1]) * zoom } });
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  return blue.id as number;
}

for (const [theme, studio, scale] of [["dark", false, 1], ["light", true, 2], ["void", false, 1]] as const) {
  test(`scrubbing, undo and concise scene feedback (${theme}, DPR ${scale})`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale });
    try {
      const page = await context.newPage(), errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(({ theme, studio }) => {
        if (localStorage.getItem("mechanica.settings") === null) localStorage.setItem("mechanica.settings",
          JSON.stringify({ tour_done: true, theme, studio_mode: studio }));
      }, { theme, studio });
      await page.goto("/"); await load(page, "Atwood machine");
      await expect(page.locator("#toasts")).toContainText("Loaded 'Atwood machine' — Ctrl+Z restores the previous scene");
      const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
      while (await dismiss.count()) await dismiss.first().click();
      const id = await selectBlue(page);
      await expect(page.locator(".force-notation abbr")).toHaveText(["W", "T"]);
      await page.locator(".force-notation abbr").first().hover();
      expect(await page.locator(".force-notation abbr").first().evaluate(el => getComputedStyle(el).cursor)).toBe("default");
      const label = page.locator('.row:has(input[type="range"][aria-label="Mass"]) .lbl');
      await label.scrollIntoViewIfNeeded(); await label.hover();
      expect(await label.evaluate(el => getComputedStyle(el).cursor)).toBe("ew-resize");
      const bounds = (await label.boundingBox())!, x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      const mass = async () => (await state(page)).scene.bodies.find((body: { id: number }) => body.id === id).mass;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y);
      await expect.poll(mass).toBeCloseTo(2.8, 8);
      await page.keyboard.down("Shift"); await page.mouse.move(x + 50, y); await page.keyboard.up("Shift");
      await expect.poll(mass).toBeCloseTo(4.8, 8);
      await page.keyboard.down("Alt"); await page.mouse.move(x + 60, y); await page.keyboard.up("Alt");
      await page.mouse.up(); await expect.poll(mass).toBeCloseTo(4.82, 8);
      await page.locator("#canvas").focus(); await page.keyboard.press("Control+z"); await expect.poll(mass).toBe(2);
      await page.keyboard.press("Control+Shift+z"); await expect.poll(mass).toBeCloseTo(4.82, 8);
      await selectBlue(page); await label.scrollIntoViewIfNeeded();
      const next = (await label.boundingBox())!;
      await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2); await page.mouse.down();
      await page.mouse.move(next.x + next.width / 2 + 30, next.y + next.height / 2);
      await expect.poll(mass).toBeGreaterThan(4.82);
      await page.keyboard.press("Escape"); await page.mouse.up();
      await expect.poll(mass).toBeCloseTo(4.82, 8);
      expect(await page.evaluate(() => document.documentElement.classList.contains("numeric-scrubbing"))).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`numeric-scrub-${theme}.png`) });
      await load(page, "Balanced beam");
      await expect(page.locator("#toasts")).toContainText("Loaded 'Balanced beam'");
      await expect(page.locator("#toasts")).not.toContainText("Ctrl+Z restores the previous scene");
      while (await dismiss.count()) await dismiss.first().click();
      const before = await state(page), [cx, cy, zoom] = before.presentation.camera;
      const canvas = page.locator("#canvas"), size = await canvas.evaluate(el => ({ w: el.clientWidth, h: el.clientHeight }));
      await canvas.click({ position: { x: size.w / 2 + (-0.5 - cx) * zoom, y: size.h / 2 + cy * zoom } });
      await page.screenshot({ path: testInfo.outputPath(`rod-endpoint-centres-${theme}.png`) });
      await page.reload(); await load(page, "Rod rotor");
      await expect(page.locator("#toasts")).toContainText("Loaded 'Rod rotor'");
      await expect(page.locator("#toasts")).not.toContainText("Ctrl+Z restores the previous scene");
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}
