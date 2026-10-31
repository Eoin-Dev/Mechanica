import { expect, test, type Page } from "@playwright/test";

type SavedScene = { settings: { time: number }; bodies: unknown[];
  fields: { fx: string; fy: string; enabled: boolean }[] };

async function scene(page: Page): Promise<SavedScene> {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).scene);
  });
}

test("formula guide keeps readable source after a stylesheet failure and recovers after reload", async ({ page, context }) => {
  const errors: string[] = [], aborted: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const asset = /\/mathlive-static-[^/]+\.css(?:\?.*)?$/;
  await context.route(asset, async route => {
    aborted.push(route.request().url()); await route.abort("internetdisconnected");
  });
  await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({
    tour_done: true, theme: "light", studio_mode: true, random_start_scene: false,
  })));
  await page.goto("/");
  await page.getByRole("tab", { name: "World", exact: true }).click();
  await page.getByRole("button", { name: "Add force field", exact: true }).click();
  // Load the editor first so its independent font stylesheet and JS have
  // settled. Only the guide's static layout stylesheet is unavailable.
  await expect(page.locator(".math-edit math-field")).toHaveCount(2);
  await page.getByRole("button", { name: "Formula guide", exact: true }).click();
  const guide = page.getByRole("dialog", { name: "Force-field formula guide", exact: true });
  await expect.poll(() => aborted.length).toBeGreaterThan(0);
  for (const section of ["Functions", "Recipes"] as const) {
    await guide.getByRole("tab", { name: section, exact: true }).click();
    await page.evaluate(async () => {
      for (let frame = 0; frame < 6; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    const formulas = guide.locator(".guide-math");
    expect(await formulas.count()).toBeGreaterThan(0);
    expect(await formulas.evaluateAll(nodes => nodes.every(node => node.hasAttribute("data-latex") &&
      node.textContent!.trim().length > 0 && node.children.length === 0))).toBe(true);
  }
  await guide.getByRole("button", { name: "Add Anti-gravity", exact: true }).click();
  await page.keyboard.press("Escape");
  const edited = await scene(page); expect(edited.fields).toHaveLength(2);
  await context.unroute(asset);
  await page.reload(); await page.getByRole("tab", { name: "World", exact: true }).click();
  await expect(page.locator(".math-edit math-field")).toHaveCount(4);
  await page.getByRole("button", { name: "Formula guide", exact: true }).click();
  await guide.getByRole("tab", { name: "Recipes", exact: true }).click();
  await expect(guide.locator(".guide-math[data-latex]")).toHaveCount(0);
  expect(await guide.locator(".guide-math").count()).toBeGreaterThan(0);
  expect(await guide.locator(".guide-math").evaluateAll(nodes => nodes.every(node => node.children.length > 0))).toBe(true);
  expect(await scene(page)).toEqual(edited); expect(errors).toEqual([]);
});

for (const failure of ["none", "script", "css"] as const) {
  test(`formula corrections retain focus and scene state with ${failure} download failure`, async ({ page, context }) => {
    const errors: string[] = [], warnings: string[] = [], aborted: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "warning" && /math editor unavailable/.test(message.text())) warnings.push(message.text());
    });
    const asset = /\/mathlive(?:\.min-[^/]+\.js|-fonts-[^/]+\.css)(?:\?.*)?$/;
    await context.route(asset, async route => {
      const url = route.request().url();
      if ((failure === "script" && /\.js(?:\?|$)/.test(url)) ||
          (failure === "css" && /\.css(?:\?|$)/.test(url))) {
        aborted.push(url); await route.abort("internetdisconnected");
      } else await route.continue();
    });
    await page.addInitScript(() => localStorage.setItem("mechanica.settings", JSON.stringify({
      tour_done: true, theme: "light", studio_mode: true, random_start_scene: false,
    })));
    await page.goto("/");
    const initial = await scene(page);
    await page.getByRole("tab", { name: "World", exact: true }).click();
    await page.getByRole("button", { name: "Add force field", exact: true }).click();
    if (failure === "none") {
      await expect(page.locator(".math-edit math-field")).toHaveCount(2);
      for (const axis of ["Fx", "Fy"] as const) {
        const row = page.locator("#inspector .num-row").filter({
          has: page.locator(`math-field[aria-label="${axis} formula"]`),
        });
        await row.getByRole("button", { name: "Edit as plain text.", exact: true }).click();
        await expect(page.locator(`#inspector input[aria-label="${axis} formula"]`)).toBeVisible();
      }
    } else {
      await expect.poll(() => aborted.length).toBeGreaterThan(0);
      await expect.poll(() => warnings.length).toBeGreaterThan(0);
    }
    for (const axis of ["Fx", "Fy"] as const) {
      const attr = axis === "Fx" ? "fx" : "fy";
      const input = page.locator(`#inspector input[aria-label="${axis} formula"]`);
      await input.fill("2*m"); await input.press("Enter");
      await expect.poll(async () => (await scene(page)).fields[0][attr]).toBe("2*m");
      await input.fill("sqrt("); await input.press("Enter");
      await expect.poll(async () => (await scene(page)).fields[0][attr]).toBe("sqrt(");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      const description = await input.getAttribute("aria-describedby");
      expect(description).toBeTruthy();
      await expect(page.locator(`#${description}[role="alert"]`)).toContainText("syntax error");
      await input.click(); await expect(input).toBeFocused();
      const editor = await input.elementHandle();
      await page.keyboard.press("Control+a"); await page.keyboard.type("3*m");
      // Keep a real draft through several animation frames and the periodic
      // Inspector refresh. A second rebuild used to detach this editor.
      await page.evaluate(async () => {
        for (let frame = 0; frame < 6; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
      expect(await editor!.evaluate(node => node.isConnected && document.activeElement === node)).toBe(true);
      await expect(input).toHaveValue("3*m"); await page.keyboard.press("Enter");
      await expect.poll(async () => (await scene(page)).fields[0][attr]).toBe("3*m");
      await expect(page.locator("#inspector [role=alert]")).toHaveCount(0);
      if (failure !== "none") await expect(page.locator(".math-edit math-field")).toHaveCount(0);
    }
    const edited = await scene(page);
    expect(edited.bodies).toEqual(initial.bodies); expect(edited.settings.time).toBe(initial.settings.time);
    await context.unroute(asset);
    await page.reload(); await page.getByRole("tab", { name: "World", exact: true }).click();
    await expect(page.locator(".math-edit math-field")).toHaveCount(2);
    expect(await scene(page)).toEqual(edited); expect(errors).toEqual([]);
  });
}
