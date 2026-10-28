import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function state(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    const data = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
    return { scene: JSON.parse(data.scene), presentation: data.presentation };
  });
}
async function load(page: Page, name: string) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("button", { name: `Load ${name}`, exact: true }).click();
  await expect(library).toBeHidden();
}

for (const [theme, studio, width] of [["dark", false, 1440], ["light", true, 1440],
  ["light", true, 390]] as const) {
  test.describe(() => {
    test.use({ viewport: { width, height: 900 } });

    test(`incline force controls integrate with the app (${theme}, Studio=${studio}, ${width}px)`, async ({ page }, info) => {
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(settings => localStorage.setItem("mechanica.settings", JSON.stringify(settings)),
        { tour_done: true, theme, studio_mode: studio });
      await page.goto("/");
      const open = page.getByRole("button", { name: "Open Inspector", exact: true });
      if (await open.isVisible()) await open.click();
      const panel = page.locator("#inspector");
      await expect(panel.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true })).toBeChecked();
      await expect(panel.getByRole("checkbox", { name: "Resolve weight on slope", exact: true })).toBeChecked();
      await expect(panel.locator(".weight-resolve-note")).toHaveText("W∥ and W⊥ replace W");
      const details = panel.locator(".force-values"), result = panel.locator(".force-resultant");
      await expect(result).toBeVisible();
      expect(await details.evaluate(el => (el as HTMLDetailsElement).open)).toBe(false);
      expect(await panel.locator(".force-controls").evaluate(el => {
        const css = getComputedStyle(el); return [css.borderTopWidth, css.backgroundColor];
      })).toEqual(["0px", "rgba(0, 0, 0, 0)"]);
      const first = await state(page);
      expect(first.scene.bodies.filter((body: { mass: number; is_pulley?: boolean }) => !body.is_pulley)
        .map((body: { mass: number }) => body.mass)).toEqual([2, 2]);
      expect(first.presentation.graph).toBe("Off");
      if (theme === "light") expect(await page.locator("#canvas").evaluate(el => {
        const canvas = el as HTMLCanvasElement;
        return [...canvas.getContext("2d")!.getImageData(3, 3, 1, 1).data].slice(0, 3);
      })).toEqual([248, 248, 248]);
      await result.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("incline-forces.png") });
      expect((await new AxeBuilder({ page }).include("#inspector")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}

test.describe(() => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("live friction edits release a stopped incline pulley without pressing Play again", async ({ page }, info) => {
    await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true })));
    await page.goto("/");
    const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
    const friction = page.getByRole("textbox", { name: "Friction (type an exact value)", exact: true });
    const play = page.getByRole("group", { name: "Simulation playback", exact: true }).getByRole("button").first();
    await play.click(); await expect.poll(async () => Number(await clock.inputValue())).toBeGreaterThan(0.15);
    await friction.fill("10"); await friction.press("Enter");
    await expect.poll(async () => {
      const scene = (await state(page)).scene;
      return Math.hypot(...scene.bodies.find((body: { name: string }) => body.name === "2.0 kg on slope").vel);
    }).toBeLessThan(0.001);
    await friction.fill("0"); await friction.press("Enter");
    await expect.poll(async () => (await state(page)).scene.bodies
      .find((body: { name: string }) => body.name === "2.0 kg on slope").vel[0]).toBeGreaterThan(0.1);
    await expect(play).toHaveAttribute("aria-pressed", "true"); await play.click();
    await page.screenshot({ path: info.outputPath("friction-released.png") });
  });
});

test("graph-free billiards replace a graph scene and loaded notices remain neutral", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("mechanica.settings",
    JSON.stringify({ tour_done: true, scene_load_hint_seen: true })));
  await page.goto("/"); await load(page, "Elastic string release"); await expect(page.locator("#dock")).toBeVisible();
  await load(page, "Billiard break"); await expect(page.locator("#dock")).toBeHidden();
  const notice = page.locator(".toast").filter({ hasText: "Loaded 'Billiard break'" });
  await expect(notice).toBeVisible(); await expect(notice).not.toHaveClass(/toast-error/);
  expect(await notice.evaluate(el => {
    const icon = el.querySelector(".toast-indicator")!;
    return [getComputedStyle(icon).color, getComputedStyle(el).borderTopColor];
  })).not.toEqual(["rgb(220, 99, 99)", "rgb(185, 28, 28)"]);
  expect((await state(page)).scene.settings.global_damping).toBe(0.28);
  await page.screenshot({ path: info.outputPath("billiards-neutral-notice.png") });
});

test("quarter-speed Which lands first records both simultaneous contacts", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true })));
  await page.goto("/"); await load(page, "Which lands first?");
  expect((await state(page)).presentation.speed).toBe(0.25);
  await page.getByRole("tab", { name: "World", exact: true }).click();
  await page.locator(".event-history-toggle").click();
  const play = page.getByRole("group", { name: "Simulation playback", exact: true }).getByRole("button").first();
  await play.click();
  await expect.poll(async () => Number(await page.getByRole("textbox", { name: "Simulation time in seconds", exact: true }).inputValue()))
    .toBeGreaterThan(0.85);
  await play.click();
  await expect(page.locator(".inspector-event-row").filter({ hasText: "Contact began" })).toHaveCount(2);
  await page.locator(".event-history").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("simultaneous-contact-history.png") });
});
