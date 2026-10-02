import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("wall dragging defaults on and pulley navigation, readings and contact choices remain usable", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem("mechanica.settings")) localStorage.setItem("mechanica.settings",
      JSON.stringify({ tour_done: true, theme: "light", studio_mode: true }));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#btn-settings").click();
  let settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const dragName = "Dragged objects collide with walls";
  await expect(settings.getByRole("checkbox", { name: dragName, exact: true })).toBeChecked();
  await settings.getByRole("checkbox", { name: dragName, exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await page.reload();
  await page.locator("#btn-settings").click();
  settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings.getByRole("checkbox", { name: dragName, exact: true })).not.toBeChecked();
  await settings.getByRole("checkbox", { name: dragName, exact: true }).check();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Pulley contacts.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 9.81 }, bodies: [
      { id: 1, name: "Left mass", pos: [-1, -1], mass: 2, color: [50, 170, 150] },
      { id: 2, name: "Right mass", pos: [1, -1], mass: 3, color: [220, 130, 90] },
      { id: 3, name: "Wheel", pos: [0, 1], is_pulley: true },
    ], walls: [
      { id: 1, name: "Contact plane", a: [-2, -1.19], b: [-0.5, -1.19], thickness: 0.06 },
      { id: 2, name: "Distant plane", a: [-2, -4], b: [2, -4] },
    ], links: [{ type: "pulley", id: 1, a: 1, b: 2, pulley: 3, length: 5 }] })) });
  await expect(library).toBeHidden();
  const canvas = page.locator("#canvas");
  await expect.poll(async () => canvas.evaluate(element => {
    const c = element as HTMLCanvasElement, data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let sx = 0, sy = 0, count = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (Math.abs(data[i] - 50) <= 1 && Math.abs(data[i + 1] - 170) <= 1 && Math.abs(data[i + 2] - 150) <= 1) {
        sx += x; sy += y; count++;
      }
    }
    if (!count) return false;
    c.dataset.particlePoint = JSON.stringify({ x: sx / count * c.clientWidth / c.width,
      y: sy / count * c.clientHeight / c.height });
    return true;
  })).toBe(true);
  await canvas.click({ position: JSON.parse(await canvas.getAttribute("data-particle-point") ?? "null") });
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  const inspector = page.locator("#inspector");
  const slope = inspector.getByRole("combobox", { name: "Resolve forces relative to a slope", exact: true });
  await expect(slope).toBeEnabled();
  expect(await slope.locator("option").allTextContents()).toEqual(["No slope selected", "Contact plane"]);
  await slope.selectOption("1");
  await inspector.getByRole("button", { name: "Select pulley wheel", exact: true }).click();
  const readout = inspector.getByRole("group", { name: "Pulley force and motion", exact: true });
  await expect(readout).toBeVisible();
  expect(await readout.locator(".pulley-reading-name").allTextContents()).toEqual([
    "Tension:", "Path:", "Leg rates:", "Constraint rate:", "Axle reaction:",
  ]);
  for (const label of await readout.locator(".pulley-reading-name").all()) {
    await label.hover();
    expect(await label.getAttribute("title")).toBe(await label.getAttribute("aria-description"));
  }
  for (const [layout, width, theme] of [
    ["light-desktop", 1440, "Light"], ["dark-desktop", 1440, "Dark"],
    ["void-desktop", 1440, "Void"], ["phone-enlarged", 390, "Light"],
  ] as const) {
    await page.locator("#btn-settings").click();
    settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: theme, exact: true }).click();
    if (width === 390) await settings.getByRole("button", { name: "120%", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width, height: 900 });
    const open = page.getByRole("button", { name: "Open Inspector", exact: true });
    if (width === 390) await expect(open).toBeVisible();
    if (await open.isVisible()) await open.click();
    const panel = page.locator("#inspector-panel");
    expect(await panel.locator(":scope > *").first().textContent()).toBe("Pulley assembly");
    await readout.scrollIntoViewIfNeeded();
    const bounds = await readout.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
    await inspector.screenshot({ path: testInfo.outputPath(`pulley-readings-${layout}.png`) });
    for (const destination of ["Select pulley string", "Select particle B: Right mass", "Select particle A: Left mass", "Select pulley wheel"]) {
      await inspector.getByRole("button", { name: destination, exact: true }).click();
      expect(await panel.locator(":scope > *").first().textContent()).toBe("Pulley assembly");
    }
    const scan = await new AxeBuilder({ page }).include("#inspector")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
    expect(scan.violations).toEqual([]);
  }
  await inspector.getByRole("button", { name: "Select particle B: Right mass", exact: true }).click();
  await slope.scrollIntoViewIfNeeded();
  await expect(slope).toBeDisabled();
  await expect(slope).toHaveAttribute("title", "No slope in contact.");
  await slope.locator("..").hover();
  await inspector.screenshot({ path: testInfo.outputPath("pulley-no-slope-contact.png") });
  await inspector.getByRole("button", { name: "Select particle A: Left mass", exact: true }).click();
  await expect(slope).toHaveValue("1");
  const y = inspector.getByRole("textbox", { name: "y (m)", exact: true });
  await y.fill("0"); await y.press("Enter");
  await slope.scrollIntoViewIfNeeded();
  await expect(slope).toBeDisabled();
  await expect(slope).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Simulation time in seconds", exact: true })).toHaveValue("0.00");
  expect(errors).toEqual([]);
});
