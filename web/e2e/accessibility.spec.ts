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

for (const layout of [
  { width: 1440, height: 900, theme: "light", scale: 1 },
  { width: 390, height: 844, theme: "dark", scale: 1 },
  { width: 320, height: 844, theme: "dark", scale: 2 },
]) {
  test(`Library search at ${layout.width}px and ${layout.scale * 100}% text`, async ({ page }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await skipFirstRunTour(page, { theme: layout.theme, studio_mode: true });
    await page.goto("/");
    await page.evaluate(scale => document.documentElement.style.setProperty("--fs", String(scale)), layout.scale);
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Library" });
    const search = library.getByRole("searchbox", { name: "Search examples" });
    const cards = library.locator(".preset-card");
    const allCount = await cards.count();
    expect(allCount).toBeGreaterThan(20);
    await expect(library.getByRole("button", { name: "Clear example search", exact: true })).not.toBeVisible();
    await search.focus();
    await expect(search).toBeFocused();
    expect(await library.locator(".library-search-field").evaluate(field => {
      const style = getComputedStyle(field);
      return { style: style.outlineStyle, width: style.outlineWidth };
    })).toEqual({ style: "solid", width: "2px" });
    await search.fill("  EARTH   moon ");
    await expect(cards).toHaveCount(2);
    await expect(library.locator(".library-result-count")).toHaveText("2 examples");
    await expect(search).toBeFocused();
    await library.getByRole("button", { name: "Pendulums", exact: true }).click();
    await expect(cards).toHaveCount(0);
    await expect(library.getByText("No examples match this search in the selected category.")).toBeVisible();
    await library.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    await expect(library.getByRole("button", { name: "Load Simple pendulum", exact: true })).toBeVisible();
    await library.getByRole("button", { name: "All", exact: true }).click();
    await expect(cards).toHaveCount(allCount);
    await search.fill("moon");
    const inputBox = await search.boundingBox();
    await page.mouse.click(inputBox!.x + inputBox!.width - 8, inputBox!.y + inputBox!.height / 2);
    // Clicking the end of the text field places the caret; only the themed
    // Clear button should clear it, without a second native cancel affordance.
    await expect(search).toHaveValue("moon");
    const dimensions = await library.locator(".library-search").evaluate(row => ({
      fits: row.scrollWidth <= row.clientWidth,
      fieldWidth: row.querySelector("input")!.getBoundingClientRect().width,
    }));
    expect(dimensions.fits).toBe(true);
    expect(dimensions.fieldWidth).toBeGreaterThanOrEqual(150);
    expect(await search.evaluate(field => getComputedStyle(field).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    expect(await search.evaluate(field => parseFloat(getComputedStyle(field).fontSize)))
      .toBeGreaterThanOrEqual(11 * layout.scale);
    const result = await new AxeBuilder({ page }).disableRules(["meta-viewport"])
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`library-${layout.width}.png`) });
    await library.getByRole("button", { name: "Clear example search", exact: true }).click();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    await search.fill("moon");
    await library.getByRole("button", { name: "Load Earth & Moon", exact: true }).click();
    await expect(library).not.toBeVisible();
    await expect(page.locator("#status-text")).toContainText("bodies");
  });
}

test("unsaved tab recovery restores playback paused and remains isolated from other tabs", async ({ page, context }) => {
  await skipFirstRunTour(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Load Triple pendulum", exact: true }).click();
  await expect(page.locator("#status-text")).toContainText("3 bodies");
  await page.getByRole("button", { name: /Start the simulation/ }).click();
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds" });
  await expect.poll(async () => Number(await clock.inputValue())).toBeGreaterThan(0.1);
  await page.getByRole("button", { name: /Pause the simulation/ }).click();
  const before = await page.evaluate(() => sessionStorage.getItem("mechanica.tab-recovery"));
  expect(before).not.toBeNull();
  await page.reload();
  await expect(page.locator("#status-text")).toContainText("3 bodies");
  await expect(page.getByRole("button", { name: /Start the simulation/ })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#toasts")).toContainText("Previous tab restored and paused");
  expect(await page.evaluate(() => sessionStorage.getItem("mechanica.tab-recovery"))).toBe(before);
  const other = await context.newPage();
  await skipFirstRunTour(other);
  await other.goto("/");
  await expect(other.locator("#status-text")).toContainText("2 bodies");
  await other.close();
});

test("damaged tab recovery does not break startup or overwrite saved scenes", async ({ page }) => {
  await skipFirstRunTour(page);
  await page.addInitScript(() => {
    sessionStorage.setItem("mechanica.tab-recovery", '{"notes":"unrelated"}');
    localStorage.setItem("mechanica.scene.Saved experiment", "keep this payload");
  });
  await page.goto("/");
  await expect(page.locator("#status-text")).toContainText("2 bodies");
  await expect(page.locator("#toasts")).toContainText("Could not restore the previous tab");
  expect(await page.evaluate(() => localStorage.getItem("mechanica.scene.Saved experiment")))
    .toBe("keep this payload");
});

test("long phone notifications wrap, remain readable, and can be dismissed by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await skipFirstRunTour(page, { studio_mode: true });
  await page.addInitScript(() => {
    sessionStorage.setItem("mechanica.tab-recovery", '{"notes":"unrelated"}');
  });
  await page.goto("/");
  await page.evaluate(() => document.documentElement.style.setProperty("--fs", "2"));
  const notice = page.locator(".toast").filter({ hasText: "Could not restore the previous tab" });
  await expect(notice).toBeVisible();
  const dimensions = await notice.evaluate(root => {
    const text = root.querySelector(".toast-message")!;
    const bounds = root.getBoundingClientRect();
    const style = getComputedStyle(text);
    return {
      inside: bounds.left >= 0 && bounds.right <= innerWidth,
      textFits: text.scrollWidth <= text.clientWidth,
      wraps: text.getBoundingClientRect().height > parseFloat(style.lineHeight),
      overflow: style.textOverflow,
    };
  });
  expect(dimensions).toEqual({ inside: true, textFits: true, wraps: true, overflow: "clip" });
  const dismiss = notice.getByRole("button", { name: "Dismiss notification" });
  await dismiss.focus();
  await page.waitForTimeout(4000);
  await expect(notice).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("notifications-320.png") });
  await dismiss.press("Enter");
  await expect(notice).toHaveCount(0);
});

for (const layout of [
  { width: 1440, height: 900, theme: "dark", scale: 1 },
  { width: 390, height: 844, theme: "void", scale: 1 },
  { width: 320, height: 844, theme: "light", scale: 2 },
]) {
  test(`overload notice fits the canvas at ${layout.width}px and ${layout.scale * 100}% text`, async ({ page }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await skipFirstRunTour(page, { theme: layout.theme, studio_mode: true, inspector_visible: false });
    await page.goto("/");
    // The first panel refresh initializes the real notice. Wait for that
    // pass before injecting presentation text so it cannot clear the fixture.
    await expect(page.locator("#status-text")).toContainText("bodies");
    await page.evaluate(scale => {
      document.documentElement.style.setProperty("--fs", String(scale));
      // Exercise the production notice's longest text without relying on
      // machine-dependent overload timing to make the presentation visible.
      const notice = document.getElementById("overload-warning")!;
      notice.textContent = "Drawing is running slowly at maximum Performance speed. Try fewer bodies or a smaller window.";
      notice.hidden = false;
    }, layout.scale);
    const notice = page.locator("#overload-warning");
    await expect(notice).toBeVisible();
    const dimensions = await notice.evaluate(root => {
      const wrap = document.getElementById("canvas-wrap")!.getBoundingClientRect();
      const bounds = root.getBoundingClientRect();
      const style = getComputedStyle(root);
      return {
        inside: bounds.left >= wrap.left && bounds.right <= wrap.right && bounds.top >= wrap.top && bounds.bottom <= wrap.bottom,
        fits: root.scrollWidth <= root.clientWidth,
        fontSize: parseFloat(style.fontSize),
        textColor: style.color,
        themeText: getComputedStyle(document.documentElement).getPropertyValue("--text").trim(),
      };
    });
    expect(dimensions.inside).toBe(true);
    expect(dimensions.fits).toBe(true);
    expect(dimensions.fontSize).toBe(12 * layout.scale);
    expect(normalizeCssColor(dimensions.textColor)).toBe(normalizeCssColor(dimensions.themeText));
    const speed = page.getByRole("slider", { name: "Speed", exact: true });
    const speedBounds = await speed.boundingBox();
    expect(speedBounds!.width).toBeGreaterThanOrEqual(64);
    expect(speedBounds!.height).toBeGreaterThanOrEqual(24);
    const result = await new AxeBuilder({ page }).disableRules(["meta-viewport"])
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`overload-${layout.width}.png`) });
  });
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

test("dialogs isolate scene edits and Escape cancels typeset edits", async ({ page }) => {
  await skipFirstRunTour(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Load Simple pendulum", exact: true }).click();
  await expect(page.locator("#status-text")).toContainText("1 body");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.keyboard.press("Control+z");
  await expect(page.locator("#status-text")).toContainText("1 body");
  await expect(page.getByRole("dialog", { name: "Library" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#status-text")).toContainText("2 bodies");

  await page.getByRole("tab", { name: "World", exact: true }).click();
  await page.getByRole("button", { name: "Add force field", exact: true }).click();
  const formula = page.locator('math-field[aria-label="Fx formula"]');
  await expect(formula).toBeVisible();
  const before = await formula.evaluate((field) =>
    (field as HTMLElement & { getValue(): string }).getValue());
  await formula.click();
  // MathLive transfers focus to its keyboard sink asynchronously.
  await expect(formula).toBeFocused();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("5x");
  await expect.poll(() => formula.evaluate((field) =>
    (field as HTMLElement & { getValue(): string }).getValue())).not.toBe(before);
  await page.keyboard.press("Escape");
  await expect.poll(() => formula.evaluate((field) =>
    (field as HTMLElement & { getValue(): string }).getValue())).toBe(before);
});

test("destructive Inspector controls keep readable hover text in the light theme", async ({ page }) => {
  await skipFirstRunTour(page, { theme: "light" });
  await page.goto("/");
  const canvas = page.locator("#canvas");
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2 - 121.8, y: box.height / 2 } });
  await page.locator("#inspector").getByRole("button", { name: "Delete", exact: true }).hover();
  const result = await new AxeBuilder({ page }).include("#inspector button.danger")
    .withRules(["color-contrast"]).analyze();
  expect(result.violations).toEqual([]);
});

test("narrow graph controls remain reachable with enlarged application text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await skipFirstRunTour(page, { theme: "light", studio_mode: true });
  await page.goto("/");
  await page.evaluate(() => document.documentElement.style.setProperty("--fs", "2"));
  const dock = page.locator("#dock");
  for (const name of ["Energy", "Mom.", "Phase", "Distance", "Velocity"]) {
    const button = dock.getByRole("button", { name, exact: true });
    await button.click();
    const rect = await button.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(320);
  }
  const close = page.getByRole("button", { name: "Close the graph dock." });
  const rect = await close.boundingBox();
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(320);
  await close.click();
  await expect(dock).toBeHidden();
});

test("pulley preset and tool expose a complete editable-string assembly", async ({ page }) => {
  await skipFirstRunTour(page, { theme: "dark", studio_mode: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("button", { name: "Load Pulley on an incline", exact: true }).click();
  await expect(page.locator("#status-text")).toContainText("2 bodies");
  await expect(page.locator("#status-text")).toContainText("1 pulley");
  await expect(page.locator("#status-text")).toContainText("1 link");

  await page.getByRole("button", { name: /Add pulley \(P\)/ }).click();
  const canvas = page.locator("#canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ position: { x: box!.width * 0.7, y: box!.height * 0.35 } });
  await expect(page.locator("#status-text")).toContainText("4 bodies");
  await expect(page.locator("#status-text")).toContainText("2 pulleys");
  await expect(page.locator("#status-text")).toContainText("2 links");
  await expect(page.locator("#inspector-panel")).toContainText("Pulley string (inelastic)");
  await expect(page.getByText("Nat. len", { exact: true })).toBeVisible();
  const tensionVectors = page.getByRole("checkbox", { name: "Tension vectors" });
  await expect(tensionVectors).toBeVisible();
  await tensionVectors.check();
  await expect(tensionVectors).toBeChecked();
});

test("mechanics analysis is integrated into graphs, particles, rods, and playback", async ({ page }) => {
  await skipFirstRunTour(page, { theme: "dark", studio_mode: true });
  await page.goto("/");

  await page.getByRole("button", { name: "Distance", exact: true }).click();
  await expect(page.locator(".dock-hint")).toContainText("Select a particle");
  await expect(page.getByRole("button", { name: "Velocity", exact: true }))
    .toBeVisible();
  const graphAxe = await new AxeBuilder({ page })
    .disableRules(["meta-viewport"])
    .include("#dock")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  expect(graphAxe.violations).toEqual([]);
  await page.getByRole("button", { name: "Close the graph dock." }).click();

  await page.getByRole("button", { name: "Remove everything from the scene. Ctrl+Z restores it." }).click();
  const canvas = page.locator("#canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const first = { x: box!.width * 0.32, y: box!.height * 0.42 };
  const second = { x: box!.width * 0.70, y: box!.height * 0.52 };
  await page.getByRole("button", { name: /Add body \(B\)/ }).click();
  await canvas.click({ position: first });
  await canvas.click({ position: second });
  await page.getByRole("button", { name: /Draw rod \(R\)/ }).click();
  await canvas.click({ position: first });
  await canvas.click({ position: second });
  await page.getByRole("button", { name: /Add anchor \(A\)/ }).click();
  await canvas.click({ position: {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  } });
  await expect(page.locator("#status-text")).toContainText("1 rod anchor");
  await expect(page.locator("#inspector-panel")).toContainText("Rod anchor");

  await page.getByRole("button", { name: /Select \(V\)/ }).click();
  await canvas.click({ position: first });
  await page.getByRole("checkbox", { name: "Free-body forces on canvas" }).check();
  await expect(page.getByText("Forces on canvas", { exact: true })).toBeVisible();

  await canvas.click({ position: {
    x: box!.width * 0.434,
    y: box!.height * 0.45,
  } });
  await expect(page.getByText("Rod coordinates", { exact: true })).toBeVisible();
  await expect(page.getByText("Attached to rod", { exact: true })).toBeVisible();
  await expect(page.locator(".rod-attachment-item")).toContainText("Anchor");

  await page.getByRole("tab", { name: "World" }).click();
  await expect(page.getByText("Playback events", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Pause playback at event" })).toBeVisible();
  await expect(page.locator(".event-history")).toBeHidden();
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.locator(".event-history")).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeFocused();

  await page.getByRole("button", { name: "Skip" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeFocused();
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
  await expect.poll(async () => (await page.locator(".dock-canvas-wrap canvas").boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(100);

  await page.getByRole("button", { name: "Library" }).click();
  const library = page.getByRole("dialog", { name: "Library" });
  const libraryLayout = await library.evaluate((dialog) => {
    const header = dialog.querySelector<HTMLElement>(".library-header")!;
    const chips = dialog.querySelector<HTMLElement>(".cat-chips")!;
    const widths = (element: Element) => ({
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

test.describe("dense particle rendering", () => {
  test.use({ deviceScaleFactor: 2 });

  test("imported tiny particles stay visible and return to vector drawing when enlarged", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await skipFirstRunTour(page, { inspector_visible: false });
    await page.addInitScript(() => {
      const counts = { copies: 0, arcs: 0 };
      (window as unknown as { particleDrawing: typeof counts }).particleDrawing = counts;
      const prototype = CanvasRenderingContext2D.prototype;
      const copy = prototype.drawImage;
      prototype.drawImage = function (image: CanvasImageSource, ...dimensions: number[]) {
        if (this.canvas.id === "canvas" && dimensions.length === 8 && image instanceof HTMLCanvasElement) counts.copies++;
        return Reflect.apply(copy, this, [image, ...dimensions]);
      };
      const arc = prototype.arc;
      prototype.arc = function (...args: Parameters<typeof arc>) {
        if (this.canvas.id === "canvas") counts.arcs++;
        return arc.apply(this, args);
      };
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByRole("tab", { name: "My scenes", exact: true }).click();
    const choosing = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Import .json", exact: true }).click();
    const chooser = await choosing;
    await chooser.setFiles({ name: "Dense particles.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0 }, bodies: Array.from({ length: 600 }, (_, index) => ({
        id: index + 1, pos: [index % 40 * 0.1, Math.floor(index / 40) * 0.1],
        radius: 0.005, mass: 1, collides: false, color: [86, 156, 214],
      })) })) });
    await expect(page.locator("#status-text")).toContainText("600 bodies");
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { particleDrawing: { copies: number } }).particleDrawing.copies)).toBeGreaterThanOrEqual(500);
    // Read pixels only after drawing; GPU/readback timing is not a performance assertion.
    const bluePixels = await page.locator("#canvas").evaluate(element => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] === 86 && pixels[index + 1] === 156 && pixels[index + 2] === 214) count++;
      }
      return count;
    });
    expect(bluePixels).toBeGreaterThan(600 * 10);
    await page.screenshot({ path: test.info().outputPath("dense-particles.png") });
    const canvas = await page.locator("#canvas").boundingBox();
    await page.mouse.move(canvas!.x + canvas!.width / 2, canvas!.y + canvas!.height / 2);
    await page.mouse.wheel(0, -5000);
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      const counts = (window as unknown as { particleDrawing: { copies: number; arcs: number } }).particleDrawing;
      counts.copies = counts.arcs = 0;
    });
    await page.mouse.wheel(0, 20);
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { particleDrawing: { arcs: number } }).particleDrawing.arcs)).toBeGreaterThan(0);
    expect(await page.evaluate(() =>
      (window as unknown as { particleDrawing: { copies: number } }).particleDrawing.copies)).toBe(0);
    expect(errors).toEqual([]);
  });
});
