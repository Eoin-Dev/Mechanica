import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function skipFirstRunTour(page: Page, settings: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((stored) => {
    localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, ...stored }));
  }, settings);
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
  await skipFirstRunTour(page, { theme: "studio" });
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

test("phone inspector is transient and desktop preference survives", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await skipFirstRunTour(page, { inspector_visible: true, theme: "studio" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "studio");

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
  await skipFirstRunTour(page, { theme: "studio" });
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
});
