import { expect, test, type Locator, type Page } from "@playwright/test";

const layouts: Array<{ name: string; theme: string; studio: boolean; width: number;
  height?: number; scale?: number; dyslexic?: boolean; textScale?: number }> = [
  { name: "dark desktop", theme: "dark", studio: false, width: 1440 },
  { name: "light Studio desktop", theme: "light", studio: true, width: 1440, scale: 1.2 },
  { name: "void phone", theme: "void", studio: false, width: 390 },
  { name: "dyslexic Studio phone", theme: "light", studio: true, width: 390, scale: 1.2, dyslexic: true },
  { name: "double-text small phone", theme: "dark", studio: true, width: 320, textScale: 2 },
  { name: "landscape", theme: "light", studio: true, width: 844, height: 390 },
];

async function recoveredScene(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).scene);
  });
}

async function centred(notice: Locator) {
  await expect(notice).toBeVisible();
  await notice.hover(); // Keep the actual notice available while measuring it.
  const geometry = await notice.evaluate(root => {
    const message = root.querySelector<HTMLElement>(".toast-message")!;
    const indicator = root.querySelector<HTMLElement>(".toast-indicator")!;
    const close = root.querySelector<HTMLElement>(".toast-close")!;
    const box = root.getBoundingClientRect(), text = message.getBoundingClientRect();
    const icon = indicator.getBoundingClientRect(), button = close.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(message);
    const lines = [...range.getClientRects()].filter(line => line.width > 0 && line.height > 0);
    return { text: message.textContent, align: getComputedStyle(message).textAlign,
      font: getComputedStyle(message).fontFamily, lines: lines.length,
      horizontalError: Math.abs((text.left + text.right - box.left - box.right) / 2),
      verticalError: Math.abs((text.top + text.bottom - box.top - box.bottom) / 2),
      lineErrors: lines.map(line => Math.abs((line.left + line.right - box.left - box.right) / 2)),
      iconError: Math.abs((icon.top + icon.bottom - box.top - box.bottom) / 2),
      closeError: Math.abs((button.top + button.bottom - box.top - box.bottom) / 2),
      left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      viewport: [innerWidth, innerHeight], clipped: root.scrollWidth > root.clientWidth + 1 ||
        message.scrollWidth > message.clientWidth + 1,
      textClear: text.left >= icon.right && text.right <= button.left,
    };
  });
  expect(geometry.align).toBe("center");
  expect(geometry.lines).toBeGreaterThan(0);
  for (const error of [geometry.horizontalError, geometry.verticalError, geometry.iconError,
    geometry.closeError, ...geometry.lineErrors]) expect(error).toBeLessThanOrEqual(1.1);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport[0]);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport[1]);
  expect(geometry.clipped).toBe(false);
  expect(geometry.textClear).toBe(true);
  return geometry;
}

for (const layout of layouts) test.describe(layout.name, () => {
  test.use({ viewport: { width: layout.width, height: layout.height ?? 900 } });

  test("ordinary and real event-paused messages stay centred and dismissible", async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(settings => localStorage.setItem("mechanica.settings", JSON.stringify(settings)),
      { tour_done: true, scene_load_hint_seen: true, theme: layout.theme, studio_mode: layout.studio,
        font_scale: layout.scale ?? 1 });
    await page.goto("/");
    if (layout.dyslexic) {
      await page.locator("#btn-settings").click();
      await page.getByRole("checkbox", { name: "Dyslexia-friendly font", exact: true }).check();
      await page.keyboard.press("Escape");
      await page.evaluate(() => document.fonts.ready);
    }
    const enlarge = async () => {
      if (layout.textScale) await page.evaluate(value => document.documentElement.style.setProperty("--fs", String(value)), layout.textScale);
    };
    await enlarge();
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Library", exact: true });
    await library.getByRole("searchbox").fill("Balanced beam");
    await library.getByRole("button", { name: "Load Balanced beam", exact: true }).click();
    const loaded = page.locator(".toast-plain").filter({ hasText: "Loaded 'Balanced beam'" });
    const ordinary = await centred(loaded);
    if (layout.dyslexic) expect(ordinary.font).toContain("OpenDyslexic");
    await page.screenshot({ path: info.outputPath("ordinary-centred.png") });
    await loaded.getByRole("button", { name: "Dismiss notification", exact: true }).click();
    await expect(loaded).toHaveCount(0);

    await page.getByRole("button", { name: "Library", exact: true }).click();
    await library.getByRole("tab", { name: "My scenes", exact: true }).click();
    const choosing = page.waitForEvent("filechooser");
    await library.getByRole("button", { name: "Import .json", exact: true }).click();
    const bodyName = "Projectile α 📐 with a long name for reading a wrapped playback event message";
    await (await choosing).setFiles({ name: "Notification geometry.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ settings: { gravity: 9.81 }, bodies: [
        { id: 1, name: bodyName, pos: [0, 0], vel: [0, 2], radius: .15, mass: 1 },
      ] })) });
    await expect(library).toBeHidden();
    const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
    while (await dismiss.count()) await dismiss.first().click();
    const hide = page.getByRole("button", { name: "Hide Inspector", exact: true });
    if (await hide.isVisible()) await hide.click();
    const canvas = page.locator("#canvas"), box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    const open = page.getByRole("button", { name: /^(Open|Show) Inspector$/ });
    if (await open.isVisible()) await open.click();
    await page.getByRole("tab", { name: "Selection", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(bodyName);
    await page.getByRole("tab", { name: "World", exact: true }).click();
    await page.getByRole("combobox", { name: "Pause playback at event", exact: true }).click();
    await page.getByRole("option", { name: "Apex", exact: true }).click();
    if (layout.width < 900 && await hide.isVisible()) await hide.click();
    await enlarge();
    await page.getByRole("button", { name: "Start the simulation (Space).", exact: true }).click();
    const pausedNotice = page.locator(".toast-plain").filter({ hasText: /Paused at .* reached an apex/ });
    await expect(pausedNotice).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Start the simulation (Space).", exact: true })).toBeVisible();
    const paused = await recoveredScene(page);
    expect(paused.settings.time).toBeCloseTo(2 / 9.81, 2);
    expect(Math.abs(paused.bodies[0].vel[1])).toBeLessThan(.05);
    const event = await centred(pausedNotice);
    expect(event.lines).toBeGreaterThan(1);
    expect(event.text).toContain(bodyName);
    expect(await recoveredScene(page)).toEqual(paused);
    await info.attach("notification-geometry", { body: JSON.stringify({ ordinary, event }), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath("event-paused-centred.png") });
    await pausedNotice.getByRole("button", { name: "Dismiss notification", exact: true }).click();
    await expect(pausedNotice).toHaveCount(0);
    expect(await recoveredScene(page)).toEqual(paused);
    expect(errors).toEqual([]);
  });
});
