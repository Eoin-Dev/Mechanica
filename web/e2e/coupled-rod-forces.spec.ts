import { expect, test } from "@playwright/test";

for (const pulley of [false, true]) for (const [theme, width] of [["dark", 1440], ["light", 390]] as const) {
  test(`a rod-connected ${pulley ? "pulley" : "string"} uses the beam inertia (${theme}, ${width}px)`, async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem("mechanica.settings",
      JSON.stringify({ tour_done: true, theme, adaptive_dt: false })), theme);
    await page.setViewportSize({ width, height: 900 }); await page.goto("/");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Library", exact: true });
    await library.getByRole("tab", { name: "My scenes", exact: true }).click();
    const choosing = page.waitForEvent("filechooser");
    await library.getByRole("button", { name: "Import .json", exact: true }).click();
    await (await choosing).setFiles({ name: "Loaded beam investigation.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ settings: { gravity: 0, substeps: 8 }, bodies: [
        { id: 1, pos: [-2, 0], mass: 0.001, radius: 0.04, is_rod_endpoint: true, collides: false },
        { id: 2, pos: [2, 0], mass: 0.001, radius: 0.04, is_rod_endpoint: true, collides: false },
        { id: 3, name: "Left load", pos: [-1.5, 0], mass: 2, collides: false, color: [86, 149, 210],
          rod_id: 1, rod_position: 0.125 },
        { id: 4, name: "Right load", pos: [1.5, 0], mass: 2, collides: false, color: [220, 130, 90],
          rod_id: 1, rod_position: 0.875 },
        { id: 5, name: "Fixed support", pos: [0, 0], is_anchor: true, is_pivot: true, locked: true,
          rod_id: 1, rod_position: 0.5 },
        { id: 6, name: "Partner", pos: pulley ? [3.22, -2] : [1.5, -2], mass: 1000, collides: false,
          const_force: [0, -1000], color: [50, 170, 150] },
        ...(pulley ? [{ id: 7, pos: [3, 2], is_pulley: true }] : []),
      ], links: [
        { type: "rod", id: 1, a: 1, b: 2, length: 4 },
        pulley ? { type: "pulley", id: 2, a: 4, b: 6, pulley: 7 } :
          { type: "rod", id: 2, a: 4, b: 6, length: 2, is_rope: true },
      ] })) });
    await expect(library).toBeHidden();
    const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
    while (await dismiss.count()) await dismiss.first().click();
    const canvas = page.locator("#canvas");
    let point: { x: number; y: number } | null = null;
    await expect.poll(async () => {
      point = await canvas.evaluate(el => {
        const c = el as HTMLCanvasElement, pixels = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let x = 0, y = 0, count = 0;
        for (let py = 0; py < c.height; py++) for (let px = 0; px < c.width; px++) {
          const i = (py * c.width + px) * 4;
          if ([50, 170, 150].every((value, channel) => Math.abs(pixels[i + channel] - value) <= 1)) {
            x += px; y += py; count++;
          }
        }
        return count ? { x: x / count * c.clientWidth / c.width, y: y / count * c.clientHeight / c.height } : null;
      });
      return point !== null;
    }).toBe(true);
    await canvas.click({ position: point! });
    const open = page.getByRole("button", { name: "Open Inspector", exact: true });
    if (await open.isVisible()) await open.click();
    await page.getByRole("tab", { name: "Selection", exact: true }).click();
    await page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
    await page.locator(".force-values summary").click();
    const values = page.locator(".force-value-list");
    await expect(values).toContainText(pulley ? "Tension 5.51 N" : "Fy 3.98 N");
    await expect(page.locator(".force-notation abbr")).toHaveText(["f", "T"]);
    const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
    await expect(clock).toHaveValue("0.00");
    await page.screenshot({ path: info.outputPath("coupled-current-forces.png") });
    if (width === 390) {
      await page.getByRole("button", { name: "Hide Inspector", exact: true }).click();
    }
    await canvas.focus(); await page.keyboard.press("."); await expect(clock).toHaveValue("0.02");
    await page.keyboard.press(","); await expect(clock).toHaveValue("0.00");
    if (width === 390) await page.getByRole("button", { name: "Open Inspector", exact: true }).click();
    await expect(values).toContainText(pulley ? "Tension 5.51 N" : "Fy 3.98 N");
    await page.screenshot({ path: info.outputPath("coupled-rewound-forces.png") });
    expect(errors).toEqual([]);
  });
}
