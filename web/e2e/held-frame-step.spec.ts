import { expect, test, type Locator, type Page } from "@playwright/test";

async function current(page: Page) {
  return page.evaluate(() => JSON.parse(JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).scene) as {
    settings: { time: number }; bodies: Array<{ pos: number[]; vel: number[] }>;
  });
}

async function press(page: Page, button: Locator, mode: string) {
  if (mode === "pointer") {
    await button.hover(); await page.mouse.down();
  } else {
    await button.focus(); await page.keyboard.down(mode);
  }
}

async function release(page: Page, mode: string) {
  if (mode === "pointer") await page.mouse.up();
  else await page.keyboard.up(mode);
}

for (const mode of ["pointer", "Space", "Enter"]) {
  test(`held frame stepping accelerates in both directions and stops cleanly (${mode})`, async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.clock.install();
    await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true })));
    await page.goto("/");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Library", exact: true });
    await library.getByRole("tab", { name: "My scenes", exact: true }).click();
    const choosing = page.waitForEvent("filechooser");
    await library.getByRole("button", { name: "Import .json", exact: true }).click();
    await (await choosing).setFiles({ name: "Uniform motion.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0 }, bodies: [
        { id: 1, name: "Uniform particle", pos: [0, 0], vel: [1, 0], mass: 1, collides: false },
      ] })) });
    await expect(library).toBeHidden();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    expect((await current(page)).settings.time).toBe(0);
    const forward = page.getByRole("button", { name: "Advance one frame (Right arrow or .).", exact: true });
    const back = page.getByRole("button", { name: "Step one frame back (Left arrow or ,).", exact: true });
    const measurements: unknown[] = [];
    for (const [button, sign] of [[forward, 1], [back, -1]] as const) {
      const start = (await current(page)).settings.time;
      await press(page, button, mode);
      const immediate = (await current(page)).settings.time;
      expect(sign * (immediate - start)).toBeCloseTo(1 / 60, 10);
      if (mode !== "pointer") {
        await page.keyboard.down(mode); // Native repeated keydown must not double-step.
        expect((await current(page)).settings.time).toBe(immediate);
      }
      await expect(button).toHaveClass(/holding/);
      await page.clock.runFor(1000);
      const first = (await current(page)).settings.time;
      await page.clock.runFor(2000);
      const beforeLast = (await current(page)).settings.time;
      await page.clock.runFor(1000);
      const end = await current(page);
      const early = sign * (first - immediate), late = sign * (end.settings.time - beforeLast);
      expect(early).toBeGreaterThan(0); expect(late).toBeGreaterThan(early);
      expect(late).toBeLessThanOrEqual(25 / 60 + 1e-10);
      expect(end.bodies[0].pos[0]).toBeCloseTo(end.settings.time, 9);
      expect(end.bodies[0].pos[1]).toBe(0);
      await release(page, mode);
      await page.clock.runFor(1000);
      expect(await current(page)).toEqual(end);
      await expect(button).not.toHaveClass(/holding/);
      measurements.push({ direction: sign, early, late, finalTime: end.settings.time });
    }
    expect((await current(page)).settings.time).toBeCloseTo(0, 10);
    await press(page, forward, mode); await page.clock.runFor(500);
    const cancelled = await current(page);
    await page.keyboard.press("Escape"); await page.clock.runFor(2000);
    expect(await current(page)).toEqual(cancelled);
    await release(page, mode); await page.clock.runFor(1000);
    expect(await current(page)).toEqual(cancelled);
    await expect(forward).not.toHaveClass(/holding/);
    await info.attach("held-step-measurements", { body: JSON.stringify(measurements), contentType: "application/json" });
    expect(errors).toEqual([]);
  });
}
