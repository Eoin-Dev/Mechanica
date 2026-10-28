import { expect, test, type Page } from "@playwright/test";

type Badge = { x: number; y: number; width: number; height: number; colour: string };
type Frame = { width: number; height: number; badges: Badge[]; text: { value: string; x: number; y: number }[] };
const colours = ["#56ace6", "#f59146"];

async function savedState(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!) as {
      scene: string; presentation: { camera: [number, number, number] };
    };
  });
}
const overlap = (a: Badge, b: Badge): boolean => a.x < b.x + b.width && a.x + a.width > b.x &&
  a.y < b.y + b.height && a.y + a.height > b.y;
const bodyBadges = (frame: Frame): Badge[] => colours.map(colour =>
  frame.badges.filter(badge => badge.colour === colour).at(-1)!);

test.describe(() => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("nearby friction diagrams keep owner identities separate through zoom, themes and source hover", async ({ page }, info) => {
    test.setTimeout(90000);
    await page.addInitScript(() => {
      localStorage.setItem("mechanica.settings", JSON.stringify({ tour_done: true, theme: "dark",
        studio_mode: true, inspector_visible: true }));
      const target = window as unknown as { forceOwners: Frame };
      target.forceOwners = { width: 0, height: 0, badges: [], text: [] };
      const fill = CanvasRenderingContext2D.prototype.fillRect;
      CanvasRenderingContext2D.prototype.fillRect = function(x, y, width, height) {
        if (this.canvas.id === "canvas") {
          if (x === 0 && y === 0 && width > 100 && height > 100) target.forceOwners = { width, height, badges: [], text: [] };
          const scale = Number(this.font.match(/([\d.]+)px/)?.[1]) / 12;
          if (Math.abs(height - 16 * scale) < 0.01 && width >= 18 * scale) {
            target.forceOwners.badges.push({ x, y, width, height, colour: String(this.fillStyle) });
          }
        }
        fill.call(this, x, y, width, height);
      };
      const text = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(value, x, y, maxWidth) {
        if (this.canvas.id === "canvas") target.forceOwners.text.push({ value, x, y });
        if (maxWidth === undefined) text.call(this, value, x, y); else text.call(this, value, x, y, maxWidth);
      };
    });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Library", exact: true });
    await library.getByRole("tab", { name: "My scenes", exact: true }).click();
    const choosing = page.waitForEvent("filechooser");
    await library.getByRole("button", { name: "Import .json", exact: true }).click();
    await (await choosing).setFiles({ name: "Close force owners.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ settings: { gravity: 9.81 }, bodies: [
        { id: 1, name: "Left slider", pos: [0, 0.25], radius: 0.2, mass: 3, no_rotation: true,
          friction: 1, const_force: [20, 0], color: [86, 172, 230] },
        { id: 2, name: "Right slider", pos: [0.42, 0.25], radius: 0.2, mass: 4, no_rotation: true,
          friction: 1, const_force: [20, 0], color: [245, 145, 70] },
      ], walls: [{ id: 1, name: "Rough floor", a: [-4, 0], b: [4, 0], thickness: 0.1,
        friction: 1, restitution: 0 }] })) });
    await expect(library).toBeHidden();
    // A persistent welcome notice can cover the phone's captions. Dismiss it
    // through its public control before checking canvas pointer interactions.
    const notices = page.getByRole("button", { name: "Dismiss notification", exact: true });
    for (let count = 0; count < 3 && await notices.count(); count++) await notices.first().click();
    await expect(notices).toHaveCount(0);
    const original = (await savedState(page)).scene, canvas = page.locator("#canvas");
    for (const [id, shift] of [[1, false], [2, true]] as const) {
      const saved = await savedState(page), [cx, cy, zoom] = saved.presentation.camera;
      const body = (JSON.parse(saved.scene).bodies as { id: number; pos: [number, number] }[]).find(body => body.id === id)!;
      const size = await canvas.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
      if (shift) await page.keyboard.down("Shift");
      try { await canvas.click({ position: { x: size.width / 2 + (body.pos[0] - cx) * zoom,
        y: size.height / 2 + (cy - body.pos[1]) * zoom } }); }
      finally { if (shift) await page.keyboard.up("Shift"); }
    }
    await page.getByRole("tab", { name: "Selection", exact: true }).click();
    await page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).check();
    const observed = () => page.evaluate(() => (window as unknown as { forceOwners: Frame }).forceOwners);
    await expect.poll(async () => (await observed()).text.filter(row => row.value === "F 20.00 N").length).toBe(2);
    expect((await observed()).badges).toHaveLength(0);
    await page.getByRole("tab", { name: "View", exact: true }).click();
    const numbers = page.getByRole("checkbox", { name: "Force diagram numbers", exact: true });
    await expect(numbers).not.toBeChecked(); await numbers.check();
    await expect.poll(async () => (await observed()).badges.length).toBeGreaterThan(0);
    await savedState(page); await page.reload();
    await expect(numbers).toBeChecked();
    await expect.poll(async () => (await observed()).badges.length).toBeGreaterThan(0);
    await canvas.click({ position: { x: 20, y: 20 } });
    let saved = await savedState(page);
    const canvasBox = (await canvas.boundingBox())!;
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    for (let count = 0; count < 25 && saved.presentation.camera[2] > 20; count++) {
      const previous = saved.presentation.camera[2];
      await page.mouse.wheel(0, 250);
      await expect.poll(async () => (await savedState(page)).presentation.camera[2]).toBeLessThan(previous);
      saved = await savedState(page);
    }
    expect(saved.presentation.camera[2]).toBeLessThanOrEqual(20);
    // The centres remain physically separate; the pixel spacing is smaller
    // than the badge width. This reproduces the old overpaint without overlap.
    const pair = JSON.parse(saved.scene).bodies as { pos: [number, number]; radius: number }[];
    expect(Math.hypot(pair[1].pos[0] - pair[0].pos[0], pair[1].pos[1] - pair[0].pos[1]))
      .toBeGreaterThan(pair[0].radius + pair[1].radius);
    const frame = () => page.evaluate(() => (window as unknown as { forceOwners: Frame }).forceOwners);
    for (const [layout, theme, width, uiScale, canvasScale] of [["desktop", "Dark", 1440, 1, 1],
      ["phone-double-text", "Light", 390, 2, 1.2], ["desktop-return", "Dark", 1440, 1, 1]] as const) {
      await page.locator("#btn-settings").click();
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      await settings.getByRole("button", { name: `${Math.round(canvasScale * 100)}%`, exact: true }).click();
      await settings.getByRole("button", { name: theme, exact: true }).click();
      await page.keyboard.press("Escape"); await page.setViewportSize({ width, height: 900 });
      // Exercise the supported canvas font setting, with additional 200% DOM
      // text stress on the phone. CSS alone does not change canvas fonts.
      await page.evaluate(scale => document.documentElement.style.setProperty("--fs", String(scale)), uiScale);
      expect(await page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--fs")))).toBe(uiScale);
      await page.mouse.move(5, 5);
      let previous = "", stableFrames = 0;
      await expect.poll(async () => {
        const current = await frame(), badges = bodyBadges(current);
        const size = await canvas.evaluate(element => ({ w: element.clientWidth, h: element.clientHeight }));
        const geometry = JSON.stringify(current);
        stableFrames = previous === geometry ? stableFrames + 1 : 0; previous = geometry;
        return current.width === size.w && current.height === size.h && stableFrames >= 2 &&
          badges.length === 2 && badges.every(Boolean) && badges.every(badge => Math.abs(badge.height - 16 * canvasScale) < 0.01 &&
          badge.x >= 0 && badge.y >= 0 && badge.x + badge.width <= size.w && badge.y + badge.height <= size.h) && !overlap(badges[0], badges[1]);
      }).toBe(true);
      const current = await frame(), badges = bodyBadges(current);
      expect(current.text.filter(row => row.value === "F 20.00 N")).toHaveLength(2);
      await page.screenshot({ path: info.outputPath(`owner-markers-${layout}.png`) });
      for (let i = 0; i < colours.length; i++) {
        const captionBadge = (await frame()).badges.find(badge => badge.colour === colours[i])!;
        const box = (await canvas.boundingBox())!;
        const point = { x: box.x + captionBadge.x + captionBadge.width / 2, y: box.y + captionBadge.y + captionBadge.height / 2 };
        await info.attach(`hover-${layout}-${i}.json`, { contentType: "application/json", body: JSON.stringify({
          point, box, captionBadge, frame: await frame(),
          target: await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.outerHTML.slice(0, 350), point),
        }) });
        await page.mouse.move(point.x, point.y);
        await expect.poll(async () => (await frame()).text.map(row => row.value).join(" "))
          .toContain(`on ${i === 0 ? "Left" : "Right"} slider`);
        const hovered = bodyBadges(await frame());
        for (let j = 0; j < badges.length; j++) {
          expect(hovered[j].x).toBeCloseTo(badges[j].x, 5); expect(hovered[j].y).toBeCloseTo(badges[j].y, 5);
        }
        await page.mouse.move(5, 5);
      }
      expect((await savedState(page)).scene).toBe(original);
    }
    await expect(page.getByRole("textbox", { name: "Simulation time in seconds", exact: true })).toHaveValue("0.00");
    await page.getByRole("tab", { name: "View", exact: true }).click();
    await numbers.uncheck();
    await expect.poll(async () => (await observed()).badges.length).toBe(0);
    await page.reload();
    await expect.poll(async () => (await observed()).text.filter(row => row.value === "F 20.00 N").length).toBe(2);
    expect((await observed()).badges).toHaveLength(0);
    expect((await savedState(page)).scene).toBe(original);
    expect(errors).toEqual([]);
  });
});
