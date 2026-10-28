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
  const blue = before.scene.bodies.find((body: { color: number[]; is_anchor: boolean; is_rod_endpoint: boolean }) =>
    body.color?.[0] === 86 && !body.is_anchor && !body.is_rod_endpoint);
  await canvas.click({ position: { x: size.w / 2 + (blue.pos[0] - cx) * zoom,
    y: size.h / 2 + (cy - blue.pos[1]) * zoom } });
  const open = page.getByRole("button", { name: "Open Inspector", exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  return blue.id as number;
}

for (const [theme, studio, width, scale] of [["dark", false, 1440, 1], ["light", true, 390, 1.2]] as const) {
  test.describe(() => {
    test.use({ viewport: { width, height: 900 } });

    test(`rod positions stay read-only through keyboard, attachment edits and detachment (${theme}, ${width}px)`, async ({ page }, info) => {
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(settings => localStorage.setItem("mechanica.settings", JSON.stringify(settings)),
        { tour_done: true, theme, studio_mode: studio, font_scale: scale });
      await page.goto("/");
      await load(page, "Balanced beam");
      const id = await selectBlue(page);
      const open = page.getByRole("button", { name: "Open Inspector", exact: true });
      if (await open.isVisible()) await open.click();
      const x = page.getByRole("textbox", { name: "x (m)", exact: true });
      const y = page.getByRole("textbox", { name: "y (m)", exact: true });
      const particle = async () => (await state(page)).scene.bodies.find((body: { id: number }) => body.id === id);
      const initial = await particle(), initialX = await x.inputValue();
      await expect(x).toHaveJSProperty("readOnly", true); await expect(y).toHaveJSProperty("readOnly", true);
      await x.click();
      await expect(page.locator("#toasts")).toContainText("Detach from the rod to edit position freely.");
      await x.press("Control+a"); await x.press("1"); await x.press("2"); await x.press("Enter");
      await expect(x).toHaveValue(initialX);
      await x.focus(); await x.press("Tab"); await expect(y).toBeFocused();
      await y.press("9"); await y.press("Alt+ArrowUp"); await y.press("Enter");
      expect((await particle()).pos).toEqual(initial.pos);
      const help = page.locator("#toasts .toast").filter({ hasText: "Detach from the rod to edit position freely." });
      await expect(help).toHaveCount(1);
      await page.screenshot({ path: info.outputPath("rod-read-only-help.png") });
      await help.getByRole("button", { name: "Dismiss notification", exact: true }).click({ timeout: 4000 });
      await expect(help).toHaveCount(0);
      await x.focus(); await y.focus();
      await expect(help).toHaveCount(1);
      const attachment = page.getByRole("group", { name: "Rod attachment", exact: true });
      const distance = attachment.getByRole("textbox", { name: "Position along rod (m)", exact: true });
      const range = attachment.getByRole("slider", { name: "Position along rod", exact: true });
      await expect(range).toBeEnabled();
      const positionOrder = await x.evaluate((el) => {
        const section = document.querySelector(".rod-attachment-editor")!;
        const velocity = document.querySelector('input[aria-label="vx"]')!;
        return Boolean(el.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          Boolean(section.compareDocumentPosition(velocity) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      expect(positionOrder).toBe(true);
      expect((await distance.boundingBox())!.width).toBeLessThan(150 * scale);
      await distance.fill("1.234"); await distance.press("Enter");
      await expect.poll(async () => (await particle()).pos[0]).toBeCloseTo(-0.766, 9);
      await expect(x).toHaveValue("-0.766"); await expect(x).toHaveJSProperty("readOnly", true);
      const detach = attachment.getByRole("button", { name: "Detach from rod", exact: true });
      expect(await detach.evaluate(el => Number.parseFloat(getComputedStyle(el).borderTopWidth))).toBeGreaterThan(0);
      await page.screenshot({ path: info.outputPath("rod-read-only-attachment.png") });
      await detach.click();
      await expect(x).toHaveJSProperty("readOnly", false); await expect(attachment).toHaveCount(0);
      await x.fill("-0.5"); await x.press("Enter");
      await expect.poll(async () => (await particle()).pos[0]).toBe(-0.5);
      expect((await particle()).rod_id).toBeNull();
      expect((await state(page)).scene.settings.time).toBe(0);
      expect(errors).toEqual([]);
    });
  });
}

for (const [theme, studio, scale] of [["dark", false, 1], ["light", true, 2], ["void", false, 1]] as const) {
  test(`scrubbing, undo and concise scene feedback (${theme}, DPR ${scale})`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale });
    try {
      const page = await context.newPage(), errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(({ theme, studio }) => {
        if (localStorage.getItem("mechanica.settings") === null) localStorage.setItem("mechanica.settings",
          JSON.stringify({ tour_done: true, theme, studio_mode: studio, adaptive_scrub: false, continuous_scrub: false }));
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
      const mass = async () => {
        // pagehide is a real cancellation boundary; inspect the live readout
        // during a gesture, then the recovered model once it has ended.
        if (await page.evaluate(() => document.documentElement.classList.contains("numeric-scrubbing")))
          return Number.parseFloat(await page.getByRole("textbox", { name: "Mass (type an exact value)", exact: true }).inputValue());
        return (await state(page)).scene.bodies.find((body: { id: number }) => body.id === id).mass;
      };
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
      const readout = page.getByRole("textbox", { name: "Mass (type an exact value)", exact: true });
      await readout.focus(); await page.keyboard.press("Alt+ArrowUp");
      await expect.poll(mass).toBeCloseTo(4.8201, 8);
      await readout.blur();
      await page.locator("#canvas").focus(); await page.keyboard.press("Control+z");
      await expect.poll(mass).toBeCloseTo(4.82, 8);
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
