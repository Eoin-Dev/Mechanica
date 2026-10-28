import { expect, test, type Page } from "@playwright/test";
import { CATEGORIES, PRESETS } from "../src/scene/presets";

async function state(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    const saved = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
    return { scene: JSON.parse(saved.scene), presentation: saved.presentation };
  });
}

/** A bounded jump can stop early on a slower engine; follow its continuation notice. */
async function reachTenSeconds(page: Page, name: string) {
  const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
  let previous = (await state(page)).scene.settings.time;
  for (let attempt = 0; attempt < 3; attempt++) {
    await clock.fill("10"); await clock.press("Enter");
    await expect.poll(async () => (await state(page)).scene.settings.time,
      { timeout: 45_000, message: `${name}: jump must install forward progress` }).toBeGreaterThan(previous);
    await expect(clock).toHaveAttribute("aria-busy", "false");
    const reached = (await state(page)).scene.settings.time;
    if (Math.abs(reached - 10) < 5e-9) return;
    expect(reached, name).toBeLessThan(10);
    await expect(page.locator(".toast-message").last()).toContainText("enter that time again to carry on from here");
    previous = reached;
  }
  expect((await state(page)).scene.settings.time, `${name}: three bounded attempts`).toBeCloseTo(10, 8);
}

for (const category of CATEGORIES.filter(name => name !== "All")) {
  test.describe(() => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test(`every ${category} card loads its model and completes ten seconds`, async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem("mechanica.settings",
        JSON.stringify({ tour_done: true, theme: "dark", studio_mode: false, adaptive_dt: false })));
      await page.goto("/");
      const examples = PRESETS.filter(p => p.category === category);
      for (const [index, example] of examples.entries()) {
        await page.getByRole("button", { name: "Library", exact: true }).click();
        const library = page.getByRole("dialog", { name: "Library", exact: true });
        await library.getByRole("button", { name: category, exact: true }).click();
        await expect(library.locator(".preset-card")).toHaveCount(examples.length);
        const card = library.locator(`[data-preset-name="${example.name}"]`);
        await card.scrollIntoViewIfNeeded();
        await card.getByRole("button", { name: `Load ${example.name}`, exact: true }).click();
        await expect(library).toBeHidden();
        const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
        while (await dismiss.count()) await dismiss.first().click();
        const initial = await state(page);
        expect(initial.scene.settings.time, example.name).toBe(0);
        expect(initial.scene.bodies.length, example.name).toBe(example.build().bodies.length);
        if (category === "Soft Bodies") expect(initial.scene.bodies.every((body: { no_rotation: boolean; omega: number }) => body.no_rotation && body.omega === 0), example.name).toBe(true);
        if (example.hints.graph) await expect(page.locator("#dock")).toBeVisible();
        else await expect(page.locator("#dock")).toBeHidden();
        const stem = `${index}-${example.name.replace(/[^a-z0-9]+/gi, "-")}`;
        await page.screenshot({ path: testInfo.outputPath(`${stem}-initial.png`) });
        await reachTenSeconds(page, example.name);
        const final = await state(page);
        expect(final.scene.settings.time, example.name).toBeCloseTo(10, 8);
        if (category === "Soft Bodies") expect(final.scene.bodies.every((body: { no_rotation: boolean; omega: number }) => body.no_rotation && body.omega === 0), example.name).toBe(true);
        for (const body of final.scene.bodies) {
          expect([...body.pos, ...body.vel].every(Number.isFinite), `${example.name}: ${body.name}`).toBe(true);
        }
        await page.screenshot({ path: testInfo.outputPath(`${stem}-ten-seconds.png`) });
        expect(errors, example.name).toEqual([]);
      }
    });
  });
}

for (const name of ["Friction ramp", "Projectile drag race", "Projectile angles", "Jelly smash"]) {
  test.describe(() => {
    test.use({ viewport: { width: 390, height: 900 } });

    test(`repaired ${name} fits a phone without opening a graph`, async ({ page }, testInfo) => {
      await page.addInitScript(() => localStorage.setItem("mechanica.settings",
        JSON.stringify({ tour_done: true, theme: "light", studio_mode: false, adaptive_dt: false })));
      await page.goto("/");
      await page.getByRole("button", { name: "Library", exact: true }).click();
      const library = page.getByRole("dialog", { name: "Library", exact: true });
      await library.getByRole("searchbox").fill(name);
      await library.getByRole("button", { name: `Load ${name}`, exact: true }).click();
      await expect(library).toBeHidden(); await expect(page.locator("#dock")).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath("phone-initial.png") });
      await reachTenSeconds(page, name);
      await page.screenshot({ path: testInfo.outputPath("phone-ten-seconds.png") });
    });
  });
}
