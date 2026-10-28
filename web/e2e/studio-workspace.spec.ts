import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const layouts = [
  { name: "light desktop", theme: "light", width: 1440, height: 900 },
  { name: "dark desktop", theme: "dark", width: 1440, height: 900 },
  { name: "void desktop", theme: "void", width: 1440, height: 900 },
  { name: "laptop", theme: "light", width: 1280, height: 720 },
  { name: "tablet", theme: "dark", width: 1024, height: 768, touch: true },
  { name: "phone", theme: "light", width: 390, height: 844, touch: true, scale: 1.2 },
  { name: "small phone", theme: "dark", width: 320, height: 640, touch: true, scale: 1.2 },
  { name: "landscape", theme: "dark", width: 844, height: 390, touch: true },
  { name: "dyslexic", theme: "light", width: 1024, height: 768, dyslexic: true, scale: 1.2 },
  { name: "double text", theme: "light", width: 320, height: 640, touch: true, textScale: 2 },
  { name: "custom accent", theme: "dark", width: 1440, height: 900, accent: "#000000" },
  { name: "reduced effects", theme: "light", width: 1440, height: 900, reduced: true },
];

for (const layout of layouts) {
  test.describe(`Studio ${layout.name}`, () => {
    test.use({ viewport: { width: layout.width, height: layout.height }, hasTouch: layout.touch ?? false,
      contextOptions: { reducedMotion: layout.reduced ? "reduce" : "no-preference", contrast: layout.reduced ? "more" : "no-preference" } });
    test("workspace commands remain reachable and switching modes preserves the experiment", async ({ page }, info) => {
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(settings => localStorage.setItem("mechanica.settings", JSON.stringify(settings)), {
        tour_done: true, studio_mode: true, theme: layout.theme, font_scale: layout.scale ?? 1,
        dyslexic_font: layout.dyslexic ?? false, accent: layout.accent,
      });
      await page.goto("/");
      const enlarge = async () => { if (layout.textScale) await page.evaluate(value => document.documentElement.style.setProperty("--fs", String(value)), layout.textScale); };
      await enlarge();
      const scene = async () => page.evaluate(() => {
        window.dispatchEvent(new Event("pagehide"));
        return JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).scene as string;
      });
      const initial = await scene();
      await expect(page.getByText(/Welcome back!/)).toHaveCount(0);
      const toolbar = page.locator("#toolbar"), more = page.getByRole("button", { name: "Scene actions", exact: true });
      const commands = page.getByRole("group", { name: "Scene actions", exact: true });
      const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
      const fits = async () => toolbar.evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth;
      });
      await expect.poll(fits).toBe(true);
      await expect.poll(() => toolbar.evaluate(el => {
        const boxes = [...el.querySelectorAll<HTMLElement>("button.brand, .toolbar-more, #btn-library, #btn-settings")]
          .filter(button => button.getClientRects().length).map(button => button.getBoundingClientRect());
        return boxes.every((a, i) => boxes.slice(i + 1).every(b =>
          Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
          Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) < .5));
      })).toBe(true);
      for (const target of [page.locator("#btn-library"), page.locator("#btn-settings"), clock,
        toolbar.getByRole("button", { name: "Start the simulation (Space).", exact: true })]) {
        await expect(target).toBeInViewport({ ratio: 1 });
      }
      if (layout.width <= 1100) {
        await expect(more).toBeVisible(); await more.click();
        await expect(commands).toBeVisible();
        await expect(commands.locator("#fps")).toBeVisible();
        await expect(commands.getByRole("button", { name: /Remove everything from the scene/ })).toBeFocused();
        await commands.getByRole("button", { name: /Remove everything from the scene/ }).press("ArrowRight");
        expect(await clock.inputValue()).toBe("0.00");
        await page.keyboard.press("Escape");
        await expect(commands).toBeHidden(); await expect(more).toBeFocused();
        await more.click();
        await expect.poll(() => commands.evaluate(el => {
          const r = el.getBoundingClientRect(); return r.left >= 11 && r.right <= innerWidth - 11 && r.top >= 11 && r.bottom <= innerHeight - 11;
        })).toBe(true);
        if (layout.name === "landscape") {
          await page.setViewportSize({ width: layout.width, height: 260 });
          // Native resize delivery is asynchronous: wait for the real overflow
          // before asking the popup to scroll, then verify the scroll is retained.
          await expect.poll(() => commands.evaluate(el => innerHeight === 260 &&
            el.scrollHeight > el.clientHeight + 20 && el.getBoundingClientRect().bottom <= innerHeight - 11)).toBe(true);
          await commands.evaluate(el => { el.scrollTop = el.scrollHeight; });
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await expect.poll(() => commands.evaluate(el => el.scrollTop)).toBeGreaterThan(20);
          await page.screenshot({ path: info.outputPath("studio-commands-scrolled.png") });
          await page.setViewportSize({ width: layout.width, height: layout.height });
        }
        await page.screenshot({ path: info.outputPath("studio-commands.png") });
        await commands.getByRole("button", { name: /Frame the whole scene once/ }).click();
        await expect(commands).toBeHidden();
      } else {
        await expect(more).toBeHidden(); await expect(commands).toBeInViewport({ ratio: 1 });
      }
      if (layout.name === "tablet") {
        await more.click();
        const clear = commands.getByRole("button", { name: /Remove everything from the scene/ });
        await expect(clear).toBeFocused();
        await page.setViewportSize({ width: 1440, height: layout.height });
        await expect(more).toBeHidden(); await expect(clear).toBeFocused();
        const panel = page.locator("#inspector"), bounds = (await panel.boundingBox())!;
        const split = (await page.getByRole("separator", { name: "Resize Inspector", exact: true }).boundingBox())!;
        await page.mouse.move(split.x + split.width / 2, split.y + split.height / 2);
        await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width - 350, split.y + split.height / 2, { steps: 5 });
        await page.mouse.up();
        await expect.poll(async () => Math.abs((await panel.boundingBox())!.width - 350)).toBeLessThan(1.1);
        await page.setViewportSize({ width: layout.width, height: layout.height });
        await expect(more).toBeVisible();
      }
      await page.screenshot({ path: info.outputPath("studio-stage.png") });
      const open = page.getByRole("button", { name: "Open Inspector", exact: true });
      if (await open.isVisible()) await open.click();
      const inspector = page.locator("#inspector");
      await expect.poll(() => inspector.evaluate(el => {
        const r = el.getBoundingClientRect(), header = document.getElementById("toolbar")!.getBoundingClientRect();
        return r.top >= header.bottom - .5 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
      })).toBe(true);
      await page.screenshot({ path: info.outputPath("studio-inspector.png") });
      await page.locator("#btn-settings").click();
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      const studio = settings.getByRole("checkbox", { name: "Studio mode", exact: true });
      await studio.uncheck(); await expect(page.locator("html")).toHaveAttribute("data-studio", "false");
      await studio.check(); await expect(page.locator("html")).toHaveAttribute("data-studio", "true");
      await enlarge();
      const report = await new AxeBuilder({ page }).include("#settings").disableRules(["meta-viewport"])
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
      expect(report.violations).toEqual([]);
      await page.screenshot({ path: info.outputPath("studio-settings.png") });
      await page.keyboard.press("Escape");
      expect(await scene()).toBe(initial);
      await expect.poll(fits).toBe(true);
      await page.locator("#btn-library").click();
      const library = page.getByRole("dialog", { name: "Library", exact: true });
      await expect(library.getByRole("searchbox", { name: "Search examples", exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath("studio-library.png") });
      await page.keyboard.press("Escape");
      expect(errors).toEqual([]);
    });
  });
}
