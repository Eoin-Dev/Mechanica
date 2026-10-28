import { expect, test, type Page } from "@playwright/test";

type SavedBody = { name: string; mass: number; pos: number[]; vel: number[] };
type SavedWorld = { settings: { time: number }; bodies: SavedBody[]; links: { type: string }[] };

async function scene(page: Page): Promise<SavedWorld> {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).scene);
  });
}

async function restart(page: Page) {
  const title = page.getByRole("button", { name: "Mechanica", exact: true });
  await title.scrollIntoViewIfNeeded();
  await expect(title).toBeInViewport();
  expect(await title.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return rect.width >= 24 && rect.height >= 24 && (hit === el || (hit !== null && el.contains(hit)));
  })).toBe(true);
  const touch = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    touch ? title.tap() : title.click(),
  ]);
  await expect(page.getByRole("textbox", { name: "Simulation time in seconds", exact: true })).toHaveValue("0.00");
  expect(new URL(page.url()).searchParams.has("start")).toBe(false);
}

for (const [theme, studio, width] of [["dark", false, 1440], ["dark", false, 390], ["light", true, 390]] as const) {
  test.describe(`${theme}, Studio=${studio}, ${width}px`, () => {
  test.use({ viewport: { width, height: 900 }, hasTouch: width < 760 });
  test.describe(() => {
    test.use({ viewport: { width, height: 900 } });

    test(`fresh incline startup, ordinary reload and title restart keep their distinct behavior (${theme}, ${width}px)`,
      async ({ page }, info) => {
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript(settings => localStorage.setItem("mechanica.settings", JSON.stringify(settings)),
          { tour_done: true, theme, studio_mode: studio, random_start_scene: false });

        await page.goto("/?startup-proof=keep#canvas");
        const initial = await scene(page);
        expect(initial.settings.time).toBe(0);
        expect(initial.bodies.map(body => body.name)).toEqual(expect.arrayContaining(["2.0 kg on slope", "2.0 kg hanging"]));
        expect(initial.links.map(link => link.type)).toEqual(["pulley"]);
        await expect(page.locator("#dock")).toBeHidden();
        const open = page.getByRole("button", { name: "Open Inspector", exact: true });
        if (await open.isVisible()) await open.click();
        const name = page.getByRole("textbox", { name: "Name", exact: true });
        await expect(name).toHaveValue("2.0 kg on slope");
        await expect(page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true })).toBeChecked();
        await expect(page.getByRole("checkbox", { name: "Resolve weight on slope", exact: true })).toBeChecked();
        await name.fill("Edited before restarting"); await name.press("Enter");
        const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
        await clock.fill("0.1"); await clock.press("Enter");
        await expect.poll(async () => (await scene(page)).settings.time).toBeGreaterThan(0.09);
        const edited = await scene(page);
        await page.reload();
        expect(await scene(page)).toEqual(edited);
        await expect(page.locator(".toast-refresh .toast-title")).toHaveText("Page refreshed");
        await restart(page);
        expect(await scene(page)).toEqual(initial);
        expect(new URL(page.url()).searchParams.get("startup-proof")).toBe("keep");
        expect(new URL(page.url()).hash).toBe("#canvas");
        await page.reload();
        expect(await scene(page)).toEqual(initial);

        await page.getByRole("button", { name: "Settings: appearance, interaction, accuracy and help.", exact: true }).click();
        const settings = page.getByRole("dialog", { name: "Settings", exact: true });
        await settings.getByRole("tab", { name: "Simulation", exact: true }).click();
        await expect(settings.getByRole("checkbox", { name: "Random starting scene", exact: true })).not.toBeChecked();
        await expect(settings).toContainText("First visit: Pulley on an incline.");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Library", exact: true }).click();
        const library = page.getByRole("dialog", { name: "Library", exact: true });
        await library.getByRole("button", { name: "Projectiles & Friction", exact: true }).click();
        await expect(library.locator('[data-preset-name="Pulley on an incline"]')).toHaveCount(0);
        await library.getByRole("button", { name: "Rods & Pulleys", exact: true }).click();
        await expect(library.getByRole("button", { name: "Load Pulley on an incline", exact: true })).toBeVisible();
        await page.screenshot({ path: info.outputPath("startup-category.png") });
        expect(errors).toEqual([]);
      });
  });

  for (const damaged of [false, true]) {
    test.describe(() => {
      test.use({ viewport: { width, height: 900 } });

      test(`random startup includes saved models and title restart obeys Settings (damaged neighbor=${damaged}, ${theme}, ${width}px)`,
        async ({ page }, info) => {
          const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
          const payload = JSON.stringify({ settings: { gravity: 0 }, bodies: [
            { id: 1, name: "Saved startup particle", pos: [3, 4], vel: [.5, -.25], mass: 7, collides: false },
          ] });
          await page.addInitScript(({ payload, damaged, settings }) => {
            // Choose the saved end of the real candidate pool deterministically.
            // A damaged later-sorted neighbor must be skipped without deletion.
            Math.random = () => .999999;
            if (!localStorage.getItem("mechanica.settings"))
              localStorage.setItem("mechanica.settings", JSON.stringify(settings));
            if (!localStorage.getItem("mechanica.test.startup-seeded")) {
              localStorage.setItem("mechanica.scene.A startup fixture", payload);
              if (damaged) localStorage.setItem("mechanica.scene.Z damaged neighbor", "broken");
              localStorage.setItem("mechanica.test.startup-seeded", "true");
            }
          }, { payload, damaged, settings: { tour_done: true, theme, studio_mode: studio, random_start_scene: true, startup_seen: true } });
          await page.goto("/");
          const initial = await scene(page);
          expect(initial.bodies).toHaveLength(1);
          expect(initial.bodies[0]).toMatchObject({ name: "Saved startup particle", mass: 7, pos: [3, 4], vel: [.5, -.25] });
          const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
          await clock.fill("1"); await clock.press("Enter");
          await expect.poll(async () => (await scene(page)).settings.time).toBeCloseTo(1, 9);
          const advanced = await scene(page);
          expect(advanced.bodies[0].pos[0]).toBeCloseTo(3.5, 9);
          expect(advanced.bodies[0].pos[1]).toBeCloseTo(3.75, 9);
          await page.reload();
          expect(await scene(page)).toEqual(advanced);
          await restart(page);
          expect(await scene(page)).toEqual(initial);
          const saved = await page.evaluate(() => ({
            valid: localStorage.getItem("mechanica.scene.A startup fixture"),
            damaged: localStorage.getItem("mechanica.scene.Z damaged neighbor"),
          }));
          expect(saved).toEqual({ valid: payload, damaged: damaged ? "broken" : null });

          await page.getByRole("button", { name: "Settings: appearance, interaction, accuracy and help.", exact: true }).click();
          const settings = page.getByRole("dialog", { name: "Settings", exact: true });
          await settings.getByRole("tab", { name: "Simulation", exact: true }).click();
          await settings.getByRole("checkbox", { name: "Random starting scene", exact: true }).uncheck();
          await page.keyboard.press("Escape");
          await restart(page);
          const defaultScene = await scene(page);
          expect(defaultScene.bodies.map(body => body.name)).toContain("2.0 kg on slope");
          expect(defaultScene.bodies.map(body => body.name)).not.toContain("Saved startup particle");
          expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mechanica.settings")!).random_start_scene)).toBe(false);
          await page.screenshot({ path: info.outputPath("random-startup-setting-applied.png") });
          expect(errors).toEqual([]);
        });
    });
  }
  });
}
