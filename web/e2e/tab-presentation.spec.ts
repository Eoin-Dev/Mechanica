import { expect, test, type Page } from "@playwright/test";

async function loadRoughPlane(page: Page) {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Load Rough inclined plane", exact: true }).click();
  await expect(page.locator("#dock")).toBeHidden();
  const canvas = page.locator("#canvas");
  let point: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    point = await canvas.evaluate(element => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let xSum = 0, ySum = 0, count = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (pixels[i] === 86 && pixels[i + 1] === 157 && pixels[i + 2] === 214) {
          xSum += x; ySum += y; count++;
        }
      }
      return count ? { x: xSum / count * canvas.clientWidth / canvas.width,
        y: ySum / count * canvas.clientHeight / canvas.height } : null;
    });
    return point !== null;
  }).toBe(true);
  await canvas.click({ position: point! });
  const open = page.getByRole("button", { name: "Open Inspector", exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
}

async function checkpoint(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mechanica.settings",
    JSON.stringify({ tour_done: true, theme: "dark", studio_mode: true })));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
});

test("rough-plane defaults, actual tab reload and repeated Reset retain diagram choices and the original baseline",
  async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await loadRoughPlane(page);
  const forces = page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true });
  const slope = page.getByRole("checkbox", { name: "Resolve weight on slope", exact: true });
  await expect(forces).toBeChecked(); await expect(slope).toBeChecked();
  await page.locator(".force-values summary").click();
  await expect(page.locator(".force-value-list")).toContainText("∥ 4.90 N");
  await expect(page.locator(".force-value-list")).toContainText("⊥ -8.50 N");
  await page.screenshot({ path: testInfo.outputPath("rough-plane-default.png") });
  const canvas = page.locator("#canvas"), box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
  await page.mouse.wheel(0, -240);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  await page.getByRole("button", { name: /Advance one frame/ }).click();
  const before = await checkpoint(page);
  expect(before.kind).toBe("mechanica-tab");
  expect(JSON.parse(before.scene).settings.time).toBeGreaterThan(0);
  expect(JSON.parse(before.initial).settings.time).toBe(0);
  await page.reload();
  await expect(forces).toBeChecked(); await expect(slope).toBeChecked();
  await expect(page.locator(".force-values")).toHaveAttribute("open", "");
  await expect(page.locator("#dock")).toBeHidden();
  const after = await checkpoint(page);
  expect(after.scene).toBe(before.scene);
  expect(after.initial).toBe(before.initial);
  expect(after.presentation).toEqual(before.presentation);
  await page.screenshot({ path: testInfo.outputPath("rough-plane-restored-view.png") });
  const reset = page.getByRole("button", { name: /Return the scene to its starting state/ });
  for (let i = 0; i < 2; i++) {
    await reset.click();
    await expect(forces).toBeChecked(); await expect(slope).toBeChecked();
    await expect(page.getByRole("textbox", { name: "Simulation time in seconds" })).toHaveValue("0.00");
  }
  await slope.uncheck(); await forces.uncheck(); await reset.click();
  await expect(forces).not.toBeChecked(); await expect(slope).not.toBeChecked();
  await page.reload();
  await expect(forces).not.toBeChecked(); await expect(slope).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("loading a non-graph preset closes the preceding graph and preserves Library order", async ({ page }) => {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Load Mass on a spring", exact: true }).click();
  await expect(page.locator("#dock")).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("button", { name: "Projectiles & Friction", exact: true }).click();
  await expect(library.locator(".preset-card").first()).toContainText("Rough inclined plane");
  await page.getByRole("button", { name: "Load Rough inclined plane", exact: true }).click();
  await expect(page.locator("#dock")).toBeHidden();
});
