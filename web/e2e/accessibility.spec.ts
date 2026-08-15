import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function skipFirstRunTour(page: Page, settings: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((stored) => {
    localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, ...stored }));
  }, settings);
}

function normalizeCssColor(value: string): string {
  return value.replace(/\s+/g, "");
}

test("boots cleanly and has no unwaived automated WCAG A/AA violations", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await skipFirstRunTour(page);

  await page.goto("/");
  await expect(page.locator("#canvas")).toBeVisible();
  await expect(page.locator("#status-text")).toContainText("bodies");

  const result = await new AxeBuilder({ page })
    // The product deliberately disables browser page zoom so zoom belongs
    // only to the simulation and graph. Axe correctly classifies that chosen
    // viewport policy as a WCAG 1.4.4 violation; keep every other A/AA rule
    // enforced and pin the policy itself in zoom-accessibility.test.ts.
    .disableRules(["meta-viewport"])
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("keyboard controls expose state, tabs, and splitter values", async ({ page }) => {
  await skipFirstRunTour(page);
  await page.goto("/");

  const play = page.getByRole("button", { name: /Start the simulation/ });
  await expect(play).toHaveAttribute("aria-pressed", "false");
  await play.focus();
  await page.keyboard.press("Enter");
  const pause = page.getByRole("button", { name: /Pause the simulation/ });
  await expect(pause).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: /Start the simulation/ }))
    .toHaveAttribute("aria-pressed", "false");

  const selectionTab = page.getByRole("tab", { name: "Selection" });
  await selectionTab.focus();
  await page.keyboard.press("ArrowRight");
  const worldTab = page.getByRole("tab", { name: "World" });
  await expect(worldTab).toBeFocused();
  await expect(worldTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "View" })).toBeFocused();

  const splitter = page.getByRole("separator", { name: "Resize Inspector" });
  const before = Number(await splitter.getAttribute("aria-valuenow"));
  await splitter.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Number(await splitter.getAttribute("aria-valuenow")))
    .toBe(before + 10);
  await page.keyboard.press("Home");
  await expect(splitter).toHaveAttribute("aria-valuenow", await splitter.getAttribute("aria-valuemin") ?? "");

  await page.getByRole("button", { name: "Library" }).click();
  await expect(page.getByRole("dialog", { name: "Library" })).toBeVisible();
  const earthCardLoad = page.getByRole("button", {
    name: "Load Earth & Moon", exact: true,
  });
  await expect(earthCardLoad).toBeVisible();
  await expect(earthCardLoad).toHaveText("");
  await expect(page.getByRole("button", { name: "All", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
});

test("scene replacement is recoverable with undo", async ({ page }) => {
  await skipFirstRunTour(page);
  await page.goto("/");
  await expect(page.locator("#status-text")).toContainText("2 bodies");

  await page.getByRole("button", { name: "Library" }).click();
  const pendulumCard = page.locator('[data-preset-name="Simple pendulum"]');
  await pendulumCard.click({ position: { x: 18, y: 18 } });
  await expect(page.locator("#toasts")).toContainText("Ctrl+Z restores the previous scene");
  await expect(page.locator("#status-text")).toContainText("1 body");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#status-text")).toContainText("2 bodies");
});

test("canvas pointer coordinates select the rendered body", async ({ page }) => {
  await skipFirstRunTour(page, { theme: "dark", studio_mode: true });
  await page.goto("/");
  const canvas = page.locator("#canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  // Earth & Moon is framed at 60 CSS px/m around the bounds centre x=2.03.
  // Earth's rendered centre is therefore 121.8 CSS px left of the canvas
  // centre; clicking that rendered point must reach the same world point.
  await canvas.click({ position: { x: box!.width / 2 - 121.8, y: box!.height / 2 } });
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Earth");
});

test("paused Jelly zoom reports painted FPS without lowering physical quality", async ({ page }) => {
  await skipFirstRunTour(page, { perf_mode: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("button", { name: "Load Jelly block", exact: true }).click();

  const fps = page.locator("#fps");
  await expect(fps).toHaveText("Idle", { timeout: 1000 });
  await expect(page.locator("#status-text")).toContainText("perf fast");

  const canvas = page.locator("#canvas");
  await canvas.hover();
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -80);
    await page.waitForTimeout(16);
  }
  await expect(fps).toHaveText(/\d+ fps/);
  await expect(fps).toHaveText("Idle", { timeout: 1000 });
  await expect(page.locator("#status-text")).toContainText("perf fast");
});

test("phone inspector is transient and desktop preference survives", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await skipFirstRunTour(page,
    { inspector_visible: true, theme: "dark", studio_mode: true });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-studio", "true");

  const handle = page.getByRole("button", { name: "Open Inspector" });
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  await handle.click();
  await expect(page.locator("#inspector")).toBeVisible();

  await page.setViewportSize({ width: 1000, height: 844 });
  const hide = page.getByRole("button", { name: "Hide Inspector" });
  await expect(hide).toBeVisible();
  await hide.click();
  await expect(page.getByRole("button", { name: "Show Inspector" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Open Inspector" })).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 844 });
  await expect(page.getByRole("button", { name: "Show Inspector" })).toBeVisible();
});

test("Studio accents and Library controls remain distinct on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await skipFirstRunTour(page, {
    theme: "dark",
    studio_mode: true,
    accent: "#000000",
    custom_accents: ["#112233"],
  });
  await page.goto("/");

  const accentText = normalizeCssColor(await page.locator("html").evaluate((root) =>
    getComputedStyle(root).getPropertyValue("--accent-text").trim()));
  const select = page.getByRole("button", { name: /^Select \(V\)/ });
  await expect.poll(async () => select.evaluate((button) =>
    getComputedStyle(button).color.replace(/\s+/g, ""))).toBe(accentText);

  await page.getByRole("button", { name: "Library" }).click();
  const library = page.getByRole("dialog", { name: "Library" });
  const close = library.getByRole("button", { name: "Close (Esc)" });
  await expect(close).toBeVisible();
  const closeBox = await close.boundingBox();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.x).toBeGreaterThanOrEqual(0);
  expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(390);

  const headerFits = await library.locator(".library-header").evaluate((header) =>
    header.scrollWidth <= header.clientWidth);
  expect(headerFits).toBe(true);
  const tabs = library.locator(".library-tabs");
  expect(await tabs.evaluate((node) => parseFloat(getComputedStyle(node).borderRadius)))
    .toBeGreaterThan(0);
  for (const target of [
    library.getByRole("tab", { name: "Examples" }),
    library.locator(".preset-card .cat").first(),
  ]) {
    await expect.poll(async () => target.evaluate((node) =>
      getComputedStyle(node).color.replace(/\s+/g, ""))).toBe(accentText);
  }

  const libraryAxe = await new AxeBuilder({ page })
    .disableRules(["meta-viewport"])
    .include("#library")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  expect(libraryAxe.violations).toEqual([]);

  await close.click();
  await page.locator("#btn-settings").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const swatch = settings.locator("button.swatch").first();
  const fill = swatch.locator(".dot");
  const swatchGeometry = await swatch.evaluate((button) => {
    const dot = button.querySelector<HTMLElement>(".dot")!;
    const outer = button.getBoundingClientRect();
    const inner = dot.getBoundingClientRect();
    return {
      outerWidth: outer.width,
      outerHeight: outer.height,
      innerWidth: inner.width,
      innerHeight: inner.height,
      padding: getComputedStyle(button).padding,
    };
  });
  expect(swatchGeometry.padding).toBe("0px");
  expect(swatchGeometry.outerWidth).toBe(swatchGeometry.outerHeight);
  expect(Math.abs(swatchGeometry.innerWidth - swatchGeometry.outerWidth)).toBeLessThan(0.5);
  expect(Math.abs(swatchGeometry.innerHeight - swatchGeometry.outerHeight)).toBeLessThan(0.5);
  await expect(fill).toBeVisible();

  await settings.getByRole("button", { name: "Create a custom accent colour" }).click();
  const create = settings.getByRole("button", { name: "Create", exact: true });
  const primaryTokens = await page.locator("html").evaluate((root) => {
    const style = getComputedStyle(root);
    return {
      accent: style.getPropertyValue("--accent").trim(),
      accentDark: style.getPropertyValue("--accent-dark").trim(),
      accentInk: style.getPropertyValue("--accent-ink").trim(),
    };
  });
  await expect.poll(async () => create.evaluate((button) =>
    getComputedStyle(button).backgroundColor.replace(/\s+/g, "")))
    .toBe(normalizeCssColor(primaryTokens.accentDark));
  await create.hover();
  await expect.poll(async () => create.evaluate((button) =>
    getComputedStyle(button).backgroundColor.replace(/\s+/g, "")))
    .toBe(normalizeCssColor(primaryTokens.accent));
  await expect.poll(async () => create.evaluate((button) =>
    getComputedStyle(button).color.replace(/\s+/g, "")))
    .toBe(normalizeCssColor(primaryTokens.accentInk));
});

test("guided tour is modal, traps focus, and restores its opener", async ({ page }) => {
  await skipFirstRunTour(page);
  await page.goto("/");
  const settings = page.locator("#btn-settings");
  await settings.click();
  await page.getByRole("button", { name: "Replay the tour" }).click();

  const dialog = page.getByRole("dialog", { name: "Guided tour" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#app")).toHaveJSProperty("inert", true);
  await expect(dialog.locator(".tour-step")).toHaveText(/1 of \d+/);
  await expect(page.getByRole("button", { name: "Next" })).toBeFocused();

  await page.getByRole("button", { name: "Skip" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Next" })).toBeFocused();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#app")).toHaveJSProperty("inert", false);
  await expect(settings).toBeFocused();
});

test("320 CSS pixels and 200% application text remain contained", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await skipFirstRunTour(page, { theme: "dark", studio_mode: true });
  await page.goto("/");
  await page.evaluate(() => document.documentElement.style.setProperty("--fs", "2"));

  await expect(page.locator("#canvas")).toBeVisible();
  const contained = await page.evaluate(() => ({
    documentFits: document.documentElement.scrollWidth <= window.innerWidth,
    canvasFits: (() => {
      const box = document.getElementById("canvas")!.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth;
    })(),
  }));
  expect(contained).toEqual({ documentFits: true, canvasFits: true });

  await page.getByRole("button", { name: "Library" }).click();
  const library = page.getByRole("dialog", { name: "Library" });
  const libraryLayout = await library.evaluate((dialog) => {
    const header = dialog.querySelector<HTMLElement>(".library-header")!;
    const chips = dialog.querySelector<HTMLElement>(".cat-chips")!;
    const widths = (element: HTMLElement) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    });
    const cards = [...dialog.querySelectorAll<HTMLElement>(".preset-card")]
      .slice(0, 2).map((card) => card.getBoundingClientRect());
    const controls = [
      dialog.querySelector<HTMLElement>("#library-tab-examples")!,
      dialog.querySelector<HTMLElement>("#library-tab-scenes")!,
      dialog.querySelector<HTMLElement>("button[aria-label='Close (Esc)']")!,
    ].map((control) => control.getBoundingClientRect());
    return {
      dialog: widths(dialog),
      header: widths(header),
      chips: widths(chips),
      controlsFit: controls.every((box) => box.left >= 0 && box.right <= innerWidth),
      cardsStack: cards.length === 2 && Math.abs(cards[0].left - cards[1].left) < 1 &&
        cards[1].top > cards[0].bottom,
    };
  });
  expect(libraryLayout.dialog.scroll).toBeLessThanOrEqual(libraryLayout.dialog.client);
  expect(libraryLayout.header.scroll).toBeLessThanOrEqual(libraryLayout.header.client);
  expect(libraryLayout.chips.scroll).toBeLessThanOrEqual(libraryLayout.chips.client);
  expect(libraryLayout.controlsFit).toBe(true);
  expect(libraryLayout.cardsStack).toBe(true);

  await library.getByRole("button", { name: "Close (Esc)" }).click();
  await page.locator("#btn-settings").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const settingsLayout = await settings.evaluate((dialog) => ({
    dialogFits: dialog.scrollWidth <= dialog.clientWidth,
    fontScaleDisplay: getComputedStyle(
      dialog.querySelector<HTMLElement>(".font-scale-options")!).display,
  }));
  expect(settingsLayout).toEqual({ dialogFits: true, fontScaleDisplay: "grid" });
});
