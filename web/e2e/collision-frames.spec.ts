import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

for (const theme of ["light", "dark"]) {
  test(`collision stepping preserves painted forces, selection and exact exported time (${theme})`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem("mechanica.settings",
      JSON.stringify({ tour_done: true, theme, adaptive_dt: false })), theme);
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Library", exact: true });
    await library.getByRole("tab", { name: "My scenes", exact: true }).click();
    const choosing = page.waitForEvent("filechooser");
    await library.getByRole("button", { name: "Import .json", exact: true }).click();
    await (await choosing).setFiles({ name: "Collision time.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0, substeps: 8 },
        bodies: [{ id: 1, name: "Impact particle", pos: [0, 0.23], vel: [0, -3],
          radius: 0.2, mass: 1, restitution: 1, friction: 0, color: [50, 170, 150] }],
        walls: [{ id: 1, name: "Floor", a: [-3, 0], b: [3, 0], thickness: 0.04,
          restitution: 1, friction: 0 }] })) });
    await expect(library).toBeHidden();
    const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
    while (await dismiss.count()) await dismiss.first().click();
    const canvas = page.locator("#canvas");
    let point: { x: number; y: number } | null = null;
    await expect.poll(async () => {
      point = await canvas.evaluate(element => {
        const c = element as HTMLCanvasElement;
        const pixels = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let xSum = 0, ySum = 0, count = 0;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (Math.abs(pixels[i] - 50) <= 1 && Math.abs(pixels[i + 1] - 170) <= 1 &&
              Math.abs(pixels[i + 2] - 150) <= 1) { xSum += x; ySum += y; count++; }
        }
        return count ? { x: xSum / count * c.clientWidth / c.width,
          y: ySum / count * c.clientHeight / c.height } : null;
      });
      return point !== null;
    }).toBe(true);
    await canvas.click({ position: point! });
    await page.getByRole("tab", { name: "Selection", exact: true }).click();
    const inspector = page.locator("#inspector");
    await inspector.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
    await page.locator(".force-values > summary").click();
    const forward = page.getByRole("button", { name: "Advance one frame (Right arrow or .).", exact: true });
    const back = page.getByRole("button", { name: "Step one frame back (Left arrow or ,).", exact: true });
    const y = inspector.getByRole("textbox", { name: "y (m)", exact: true });
    const vy = inspector.getByRole("textbox", { name: "vy", exact: true });
    const sources = page.getByRole("list", { name: "Force values and sources", exact: true });
    await forward.click();
    const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
    await expect(clock).toHaveValue("0.003333");
    await expect(y).toHaveValue("0.220"); await expect(vy).toHaveValue("3.000");
    await expect(sources).toContainText("R: Reaction from Floor");
    await expect(sources).toContainText("Fy 1800.00 N");
    await expect(page.locator(".force-interval-note")).toContainText("Average forces: 0.000–0.003 s.");
    await forward.click(); await expect(y).toHaveValue("0.270");
    await back.click(); await expect(y).toHaveValue("0.220");
    await expect(clock).toHaveValue("0.003333");
    await expect(sources).toContainText("Fy 1800.00 N");
    expect((await new AxeBuilder({ page }).include("#inspector")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
      .analyze()).violations).toEqual([]);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath(`collision-frame-${theme}.png`) });
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await library.getByRole("tab", { name: "My scenes", exact: true }).click();
    await library.getByRole("button", { name: "Save current scene", exact: true }).click();
    const name = library.getByRole("textbox", { name: "Scene name", exact: true });
    await name.fill("Exact impact"); await name.press("Enter");
    const downloading = page.waitForEvent("download");
    await library.getByRole("button", { name: "Download Exact impact as a .json file", exact: true }).click();
    const data = JSON.parse(await readFile((await (await downloading).path())!, "utf8"));
    expect(data.settings.time).toBeCloseTo(1 / 300, 9);
    expect(data.bodies[0].pos[1]).toBeCloseTo(0.22, 9);
    expect(data.bodies[0].vel[1]).toBeCloseTo(3, 9);
    await page.keyboard.press("Escape");
    await back.click(); await expect(y).toHaveValue("0.230"); await expect(vy).toHaveValue("-3.000");
    await forward.click(); await expect(y).toHaveValue("0.220"); await expect(vy).toHaveValue("3.000");
    expect(errors).toEqual([]);
  });
}
