import { expect, test, type Page } from "@playwright/test";

async function model(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).scene);
  });
}

async function selectParticle(page: Page, colour: number[], add = false) {
  const hide = page.getByRole("button", { name: "Hide Inspector", exact: true });
  if (await hide.isVisible()) await hide.click();
  const canvas = page.locator("#canvas"); await canvas.focus(); await canvas.press("f");
  let point: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    point = await canvas.evaluate((element, colour) => {
      const canvas = element as HTMLCanvasElement;
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let xSum = 0, ySum = 0, count = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (data[i] === colour[0] && data[i+1] === colour[1] && data[i+2] === colour[2]) {
          xSum += x; ySum += y; count++;
        }
      }
      return count ? { x: xSum/count * canvas.clientWidth/canvas.width, y: ySum/count * canvas.clientHeight/canvas.height } : null;
    }, colour);
    return point !== null;
  }).toBe(true);
  await canvas.click({ position: point!, modifiers: add ? ["Shift"] : [] });
}

async function setup(page: Page, theme: string, studio: boolean, scale: number, group: boolean) {
  await page.addInitScript(settings => localStorage.setItem("mechanica.settings", JSON.stringify(settings)),
    { tour_done: true, theme, studio_mode: studio, font_scale: scale });
  await page.goto("/");
  // Persisted preferences cap at 120%; stress larger text explicitly.
  await page.evaluate(scale => document.documentElement.style.setProperty("--fs", String(scale)), scale);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("tab", { name: "My scenes", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Import .json", exact: true }).click();
  await (await choosing).setFiles({ name: "Contact choices.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ settings: { gravity: 9.81 }, bodies: [
      { id: 1, name: "Corner load", pos: [.25,.25], radius: .2, mass: 1, color: [50,170,150] },
      { id: 2, name: "Floor load", pos: [-1,.25], radius: .2, mass: 2, color: [230,130,20] },
    ], walls: [
      { id: 1, name: "Floor plane", a: [-2,0], b: [2,0], thickness: .1 },
      { id: 2, name: "Side plane", a: [0,-2], b: [0,2], thickness: .1 },
    ] })) });
  await expect(library).toBeHidden();
  await selectParticle(page, [50,170,150]);
  if (group) await selectParticle(page, [230,130,20], true);
  const open = page.getByRole("button", { name: /^(Open|Show) Inspector$/ });
  if (await open.isVisible()) await open.click();
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  expect(await page.evaluate(()=>Number(getComputedStyle(document.documentElement).getPropertyValue("--fs")))).toBe(scale);
}

for (const [theme,studio,width,scale] of [["light",false,1440,1],["dark",true,390,1.2],["light",true,320,2]] as const) {
  test.describe(`${theme}, Studio=${studio}, ${width}px, scale=${scale}`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const group of [false, true]) {
      test(`${group ? "group" : "single-particle"} contact references use themed menus and preserve physical state`, async ({ page }, info) => {
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        await setup(page, theme, studio, scale, group);
        const before = await model(page);
        const resolve = page.getByRole("checkbox", { name: "Resolve weight on slope", exact: true });
        await resolve.check();
        const name = group ? "Slope reference for Corner load" : "Resolve forces relative to a slope";
        const choice = page.getByRole("combobox", { name, exact: true });
        await expect(choice).toBeVisible();
        expect(await choice.evaluate(el => el.tagName)).toBe("BUTTON");
        await expect(choice).toHaveAttribute("data-value", "");
        await choice.click();
        const menu = page.getByRole("listbox", { name, exact: true });
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("option")).toHaveCount(3);
        const geometry = await menu.evaluate(el => {
          const box = el.getBoundingClientRect(), style = getComputedStyle(el);
          const token = "--panel";
          return { fits: box.left >= 7 && box.right <= innerWidth-7 && box.top >= 3 && box.bottom <= innerHeight-3,
            background: style.backgroundColor.replace(/\s/g,""), expected: style.getPropertyValue(token).trim().replace(/\s/g,"") };
        });
        expect(geometry.fits).toBe(true); expect(geometry.background).toBe(geometry.expected);
        await info.attach("contact-menu-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
        await page.screenshot({ path: info.outputPath("contact-reference-menu.png") });
        await menu.getByRole("option", { name: "Side plane", exact: true }).click();
        await expect(choice).toHaveAttribute("data-value", "2"); await expect(choice).toBeFocused();
        await choice.press("f"); await choice.press("Enter");
        await expect(choice).toHaveAttribute("data-value", "1");
        await choice.press("s"); await choice.press("Escape");
        await expect(choice).toHaveAttribute("data-value", "1");
        await choice.press("s"); await choice.press("Enter");
        await expect(choice).toHaveAttribute("data-value", "2");
        await choice.press("Enter");
        await resolve.uncheck();
        await expect(menu).toBeHidden(); await expect(choice).toBeHidden();
        await resolve.check(); await choice.click(); await expect(menu).toBeVisible();
        await page.getByRole("tab", { name: "World", exact: true }).click();
        await expect(menu).toBeHidden();
        expect(await model(page)).toEqual(before); expect(errors).toEqual([]);
      });
    }
  });
}
