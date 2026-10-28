import { expect, test } from "@playwright/test";

for (const name of ["Mass on a spring", "Coupled oscillators"]) {
  test(`loads ${name} with a populated particle phase plot`, async ({ page }, info) => {
    await page.addInitScript(() => localStorage.setItem("mechanica.settings",
      JSON.stringify({ tour_done: true })));
    await page.goto("/");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Library", exact: true });
    await library.getByRole("searchbox").fill(name);
    await library.getByRole("button", { name: `Load ${name}`, exact: true }).click();
    await expect(library).toBeHidden();
    if (name === "Coupled oscillators") {
      await expect(page.locator("#dock")).toBeHidden();
      await page.locator("#canvas").focus(); await page.keyboard.press("1");
      await page.locator("#dock").getByRole("button", { name: "Phase", exact: true }).click();
      const selected = await page.evaluate(() => {
        window.dispatchEvent(new Event("pagehide"));
        const recovery = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
        const world = JSON.parse(recovery.scene);
        const body = world.bodies.find((body: { is_anchor: boolean }) => !body.is_anchor);
        return { pos: body.pos, camera: recovery.presentation.camera };
      });
      const canvas = page.locator("#canvas"), box = (await canvas.boundingBox())!;
      const [cx, cy, zoom] = selected.camera;
      await canvas.click({ position: { x: box.width / 2 + (selected.pos[0] - cx) * zoom,
        y: box.height / 2 + (cy - selected.pos[1]) * zoom } });
    }
    const canvas = page.locator("#canvas");
    await canvas.focus(); await page.keyboard.press(".");
    await page.getByRole("button", { name: "Data", exact: true }).click();
    const data = page.getByRole("dialog", { name: "Graph data", exact: true });
    await expect(data).toBeVisible();
    await expect(data).toContainText("Phase space");
    await expect(data.locator(".graph-data-empty")).toBeHidden();
    await data.getByRole("button", { name: "Numbers", exact: true }).click();
    await expect(data.locator("tbody tr")).not.toHaveCount(0);
    await data.getByRole("button", { name: "Graph", exact: true }).click();
    if (name === "Mass on a spring") await data.getByRole("button", { name: "y–vy", exact: true }).click();
    await page.screenshot({ path: info.outputPath("populated-phase-preset.png") });
  });
}
