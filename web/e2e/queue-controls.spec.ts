import { expect, test, type Page } from "@playwright/test";

async function graphMode(page: Page): Promise<string> {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).presentation.graph as string;
  });
}

test.describe(() => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("all six graph shortcuts toggle their real dock and yield to editing and modal controls", async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true })));
    await page.goto("/");
    const dock = page.locator("#dock");
    for (const [key, mode] of [["1", "Energy"], ["2", "Mom."], ["3", "Phase"],
      ["4", "Displacement"], ["5", "Distance"], ["6", "Velocity"]]) {
      await page.keyboard.press(key);
      await expect.poll(() => graphMode(page)).toBe(mode);
      await expect(dock).toBeVisible();
      await expect(dock.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true");
      if (key === "6") await page.screenshot({ path: info.outputPath("sixth-graph-shortcut.png") });
      await page.keyboard.press(key);
      await expect.poll(() => graphMode(page)).toBe("Off");
      await expect(dock).toBeHidden();
    }
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    const original = await name.inputValue();
    await name.fill(""); await name.pressSequentially("456");
    await expect(name).toHaveValue("456"); await expect.poll(() => graphMode(page)).toBe("Off");
    await name.press("Escape"); await expect(name).toHaveValue(original);
    await page.getByRole("button", { name: "Settings: appearance, interaction, accuracy and help.", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    await page.keyboard.press("4"); await page.keyboard.press("5"); await page.keyboard.press("6");
    await expect.poll(() => graphMode(page)).toBe("Off");
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });
});

test("Settings shortcut and Help reference reflect current commands without stealing edit or modal keys", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true })));
  await page.goto("/");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await page.keyboard.press("Control+,"); await expect(settings).toBeVisible();
  await page.keyboard.down("Control"); await page.keyboard.down(","); await page.keyboard.down(",");
  await page.keyboard.up(","); await page.keyboard.up("Control");
  await expect(settings).toBeVisible(); await page.keyboard.press("Escape");
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.focus(); await name.press("Control+,"); await expect(settings).toBeHidden();
  await page.locator("#canvas").click({ position: { x: 10, y: 10 } });
  await page.keyboard.press("l");
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await expect(library).toBeVisible(); await page.keyboard.press("Control+,");
  await expect(library).toBeVisible(); await expect(settings).toBeHidden();
  await page.keyboard.press("Escape"); await page.keyboard.press("F1");
  const help = page.getByRole("dialog", { name: "Help and shortcuts", exact: true });
  await expect(help).toBeVisible();
  for (const [keys, description] of [["1 / 2 / 3", "Energy / momentum / phase graph"],
    ["4 / 5 / 6", "Displacement / distance / velocity graph"], ["Ctrl+,", "Settings"],
    ["Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z", "Undo / redo"],
    ["R / E / S / P", "Draw rod / connect string / spring; add pulley"]]) {
    const row = help.locator(".shortcut-row").filter({ hasText: keys });
    await expect(row.locator(".keys")).toHaveText(keys);
    await expect(row.locator(".what")).toHaveText(description);
  }
  await expect(help.locator(".shortcut-row").filter({ hasText: "Mini graph" })).toContainText("Return to live");
  await page.screenshot({ path: info.outputPath("current-shortcut-reference.png") });
  expect(errors).toEqual([]);
});

for (const [theme, studio, width, scale] of [["dark", false, 1440, 1], ["light", true, 390, 1.2]] as const) {
  test.describe(() => {
    test.use({ viewport: { width, height: 900 } });

    test(`grouped Settings fit and retain customization (${theme}, Studio=${studio}, ${width}px)`, async ({ page }, info) => {
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(settings => {
        if (!localStorage.getItem("mechanica.settings")) localStorage.setItem("mechanica.settings", JSON.stringify(settings));
      }, { tour_done: true, theme, studio_mode: studio, font_scale: scale });
      await page.goto("/");
      await page.keyboard.press("Control+,");
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      await expect(settings).toBeVisible();
      await expect(settings.getByRole("region", { name: "Appearance", exact: true })).toBeVisible();
      await expect(settings.locator(".settings-group:visible")).toHaveCount(1);
      await settings.getByRole("button", { name: "80%", exact: true }).click();
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mechanica.settings")!).font_scale)).toBe(0.8);
      await settings.getByRole("button", { name: `${Math.round(scale * 100)}%`, exact: true }).click();
      const fits = async () => settings.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { width: rect.right <= innerWidth && rect.left >= 0,
          height: rect.top >= 0 && rect.bottom <= innerHeight,
          content: el.scrollWidth <= el.clientWidth,
          page: document.documentElement.scrollWidth <= innerWidth };
      });
      await expect.poll(fits).toEqual({ width: true, height: true, content: true, page: true });
      await page.screenshot({ path: info.outputPath("settings-appearance.png") });
      await settings.getByRole("tab", { name: "Appearance", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(settings.getByRole("tab", { name: "Interaction", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(settings.locator(".settings-group:visible")).toHaveCount(2);
      const adaptive = settings.getByRole("checkbox", { name: "Adaptive scrubbing", exact: true });
      await adaptive.uncheck();
      await settings.getByRole("button", { name: "Fine", exact: true }).click();
      await expect.poll(() => page.evaluate(() => [document.documentElement.dataset.adaptiveScrub,
        document.documentElement.dataset.scrubSpeed])).toEqual(["false", "0.5"]);
      await page.screenshot({ path: info.outputPath("settings-interaction.png") });
      await adaptive.focus(); await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      await page.keyboard.press("Control+,");
      await expect(adaptive).not.toBeChecked();
      await settings.getByRole("tab", { name: "Simulation", exact: true }).click();
      await expect(settings.getByRole("region", { name: "New scene defaults", exact: true })).toBeVisible();
      await expect(settings.getByRole("region", { name: "Accuracy & performance", exact: true })).toBeVisible();
      await expect(settings.getByRole("region", { name: "Appearance", exact: true })).toBeHidden();
      await expect.poll(fits).toEqual({ width: true, height: true, content: true, page: true });
      await page.screenshot({ path: info.outputPath("settings-simulation.png") });
      await page.keyboard.press("Escape"); await page.reload();
      await page.keyboard.press("Control+,");
      await settings.getByRole("tab", { name: "Interaction", exact: true }).click();
      await expect(adaptive).not.toBeChecked();
      await expect(settings.getByRole("button", { name: "Fine", exact: true })).toHaveAttribute("aria-pressed", "true");
      expect(errors).toEqual([]);
    });
  });
}

for (const layout of [{ theme: "dark", width: 1440, touch: false, scale: 1 },
  { theme: "light", width: 390, touch: true, scale: 1.2 },
  { theme: "dark", width: 320, touch: true, scale: 1.2, textScale: 2, height: 640 }] as const) {
  test.describe(`tutorial ${layout.theme} ${layout.width}px`, () => {
    test.use({ viewport: { width: layout.width, height: layout.height ?? 844 }, hasTouch: layout.touch });
    test("tutorial walk covers current workflows and diagrams with reachable controls", async ({ page }, info) => {
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(settings => localStorage.setItem("mechanica.settings", JSON.stringify(settings)),
        { tour_done: true, theme: layout.theme, font_scale: layout.scale });
      await page.goto("/");
      if ("textScale" in layout) await page.evaluate(value => {
        document.documentElement.style.setProperty("--fs", String(value));
      }, layout.textScale);
      const settingsButton = page.locator("#btn-settings"); await settingsButton.click();
      await page.getByRole("button", { name: "Replay the tour", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Guided tour", exact: true });
      await expect(dialog).toBeVisible();
      const headings: string[] = [];
      for (let i = 0; i < 10; i++) {
        await expect(dialog.locator(".tour-step")).toHaveText(`${i + 1} of 10`);
        expect(await page.locator("#app").evaluate(el => (el as HTMLElement).inert)).toBe(true);
        const title = await dialog.locator("h3").innerText(); headings.push(title);
        await expect.poll(() => page.locator(".tour-ring").evaluateAll(rings => rings.every(ring => {
          const paths = ring instanceof SVGSVGElement ? [...ring.querySelectorAll("path")] : [ring];
          return paths.every(path => {
            if (path instanceof SVGGraphicsElement) {
              // Firefox's client rect already includes a conservative stroke
              // bound. Project the un-stroked SVG geometry before adding ink.
              const box = path.getBBox(), matrix = path.getScreenCTM();
              if (box.width === 0 || box.height === 0) return true;
              if (!matrix) return false;
              const points = [[box.x, box.y], [box.x + box.width, box.y],
                [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
                .map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
              const bleed = parseFloat(getComputedStyle(path).strokeWidth) / 2 *
                Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
              return Math.min(...points.map(p => p.x)) - bleed >= 0 &&
                Math.min(...points.map(p => p.y)) - bleed >= 0 &&
                Math.max(...points.map(p => p.x)) + bleed <= innerWidth &&
                Math.max(...points.map(p => p.y)) + bleed <= innerHeight;
            }
            const box = path.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) return true;
            const style = getComputedStyle(path);
            const bleed = parseFloat(style.outlineWidth);
            return box.left - bleed >= 0 && box.top - bleed >= 0 &&
              box.right + bleed <= innerWidth && box.bottom + bleed <= innerHeight;
          });
        }))).toBe(true);
        const body = dialog.locator("p");
        if (layout.touch) await expect(body).not.toContainText(/cursor|right-drag|middle-drag|spacebar/i);
        if (title === "The scene") await expect(body).toContainText("Friction and drag can physically remove energy");
        if (title === "Build your own") {
          await expect(body).toContainText("two points to draw a rod");
          await expect(body).toContainText("slowly drag a particle onto it");
          await page.screenshot({ path: info.outputPath("tutorial-build.png") });
        }
        if (title === "Read a free-body diagram") {
          await expect(page.getByRole("tab", { name: "Selection", exact: true })).toHaveAttribute("aria-selected", "true");
          await expect(page.locator(".force-toggle")).toBeInViewport({ ratio: 0.95 });
          await expect(body).toContainText("parallel W∥ and perpendicular W⊥");
          await expect(body).toContainText("other arrows stay unchanged");
          await page.screenshot({ path: info.outputPath("tutorial-free-body.png") });
        }
        if (title === "Measure the motion") {
          await expect(page.getByRole("tab", { name: "View", exact: true })).toHaveAttribute("aria-selected", "true");
          await expect(page.getByRole("combobox", { name: "Graph shown in the dock", exact: true })).toBeInViewport({ ratio: 0.95 });
        }
        if (title === "Write your own physics") {
          await expect(page.getByRole("tab", { name: "World", exact: true })).toHaveAttribute("aria-selected", "true");
          await expect(page.getByRole("button", { name: "Add force field", exact: true })).toBeInViewport({ ratio: 0.95 });
        }
        const next = dialog.getByRole("button", { name: i === 9 ? "Get started" : "Next", exact: true });
        if (await dialog.evaluate(el => el.scrollHeight > el.clientHeight + 1)) {
          await expect(dialog).toBeFocused();
          await expect(dialog.locator("h3")).toBeInViewport({ ratio: 1 });
        } else await expect(next).toBeFocused();
        await expect.poll(() => dialog.evaluate(el => {
          const r = el.getBoundingClientRect(); return r.left >= -0.1 && r.top >= -0.1 &&
            r.right <= innerWidth + 0.1 && r.bottom <= innerHeight + 0.1 && el.scrollWidth <= el.clientWidth;
        })).toBe(true);
        await next.click();
      }
      expect(headings).toContain("Read a free-body diagram");
      expect(headings).toContain("Measure the motion");
      await expect(dialog).toBeHidden();
      expect(await page.locator("#app").evaluate(el => (el as HTMLElement).inert)).toBe(false);
      await expect(settingsButton).toBeFocused();
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mechanica.settings")!).tour_done)).toBe(true);
      expect(errors).toEqual([]);
    });
  });
}


test.describe(() => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("mini graph right-drag holds history and Return to live follows new samples", async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true })));
    await page.goto("/");
    await page.keyboard.press("1");
    const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
    // A time jump intentionally installs a single final sample. Collect real
    // playback history so there is a past interval for the user to pan into.
    for (let i = 0; i < 4; i++) await page.keyboard.press("+");
    const play = page.locator("#toolbar button.primary"); await play.click();
    await expect.poll(async () => Number(await clock.inputValue())).toBeGreaterThan(3);
    await play.click();
    const pausedTime = Number(await clock.inputValue());
    const dock = page.locator("#dock"), plot = dock.locator("canvas");
    const live = dock.getByRole("button", { name: "Return to live", exact: true });
    await expect(live).toBeHidden(); const r = (await plot.boundingBox())!;
    await plot.evaluate(el => el.addEventListener("contextmenu", event => {
      (el as HTMLElement).dataset.contextMenuCancelled = String(event.defaultPrevented);
    }));
    await page.mouse.move(r.x + r.width * 0.45, r.y + r.height * 0.6);
    await page.mouse.wheel(0, -3000);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(r.x + r.width * 0.65, r.y + r.height * 0.6, { steps: 8 });
    await page.mouse.up({ button: "right" });
    await expect(plot).toHaveAttribute("data-context-menu-cancelled", "true");
    await expect(live).toBeVisible();
    await page.screenshot({ path: info.outputPath("historical-mini-graph.png") });
    await page.keyboard.press(".");
    await expect.poll(async () => Number(await clock.inputValue())).toBeGreaterThan(pausedTime);
    await expect(live).toBeVisible(); await live.click(); await expect(live).toBeHidden();
    const steppedTime = Number(await clock.inputValue());
    await page.locator("#canvas").click({ position: { x: 10, y: 10 } });
    await page.keyboard.press(".");
    await expect.poll(async () => Number(await clock.inputValue())).toBeGreaterThan(steppedTime);
    await expect(live).toBeHidden();
    expect(errors).toEqual([]);
  });
});
