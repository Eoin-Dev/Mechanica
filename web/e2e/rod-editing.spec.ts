import { expect, test, type Page } from "@playwright/test";

type BodyState = { id: number; name: string; pos: number[]; vel: number[]; mass: number; radius: number;
  color: number[]; rod_id: number | null; is_rod_endpoint: boolean; is_anchor: boolean; angle: number; omega: number; no_rotation: boolean };
type SceneState = { settings: { time: number }; bodies: BodyState[]; links: Array<{ id: number; a: number; b: number; name: string }> };

async function state(page: Page): Promise<{ scene: SceneState; presentation: { camera: number[] } }> {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    const saved = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
    return { scene: JSON.parse(saved.scene), presentation: saved.presentation };
  });
}

async function selectLoad(page: Page, id?: number) {
  const before = await state(page), [cx, cy, zoom] = before.presentation.camera;
  const body = id === undefined ? before.scene.bodies.find(body => body.name === "2 kg · 1 m left")! :
    before.scene.bodies.find(body => body.id === id)!;
  const canvas = page.locator("#canvas"), size = await canvas.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
  await canvas.click({ position: { x: size.width / 2 + (body.pos[0]-cx)*zoom,
    y: size.height / 2 + (cy-body.pos[1])*zoom } });
  const open = page.getByRole("button", { name: "Open Inspector", exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole("tab", { name: "Selection", exact: true }).click();
  return body.id;
}

async function prepare(page: Page, settings: { theme: string; studio_mode: boolean; font_scale: number }) {
  await page.addInitScript(settings => {
    localStorage.setItem("mechanica.settings", JSON.stringify(settings));
    Object.defineProperty(window, "rodPaintedScene", { value: "", writable: true });
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function(x,y,width,height) {
      if (this.canvas.id === "canvas" && x === 0 && y === 0 && width > 100 && height > 100) {
        const saved = sessionStorage.getItem("mechanica.tab-recovery");
        if (saved) (window as unknown as { rodPaintedScene:string }).rodPaintedScene = JSON.parse(saved).scene;
      }
      fill.call(this,x,y,width,height);
    };
  }, { tour_done: true, ...settings });
  await page.goto("/");
  // Persisted preferences cap at 120%; stress larger text explicitly.
  await page.evaluate(scale => document.documentElement.style.setProperty("--fs", String(scale)), settings.font_scale);
  expect(await page.evaluate(()=>Number(getComputedStyle(document.documentElement).getPropertyValue("--fs")))).toBe(settings.font_scale);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("searchbox").fill("Balanced beam");
  await library.getByRole("button", { name: "Load Balanced beam", exact: true }).click();
  await expect(library).toBeHidden();
  const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
  while (await dismiss.count()) await dismiss.first().click();
  return selectLoad(page);
}

async function undo(page: Page) {
  await page.locator("#canvas").focus(); await page.keyboard.press("Control+z");
}

for (const [theme, studio, width, scale] of [["dark", false, 1440, 1], ["light", true, 390, 1.2], ["dark", false, 320, 2]] as const) {
  test.describe(`${theme}, Studio=${studio}, ${width}px, scale=${scale}`, () => {
    test.use({ viewport: { width, height: 900 } });
    test("mounted particle and whole-beam duplicates retain independent ownership and undo", async ({ page }, info) => {
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      const id = await prepare(page, { theme, studio_mode: studio, font_scale: scale });
      const initial = (await state(page)).scene, original = initial.bodies.find(body => body.id === id)!;
      for (const label of ["x (m)","y (m)"]) {
        const caption = page.getByRole("textbox", { name:label,exact:true }).locator("..").locator(".lbl");
        await caption.hover();
        expect(await caption.evaluate(el => ({
          scrub:el.classList.contains("numeric-scrub-handle"),
          cursor:getComputedStyle(el).cursor, background:getComputedStyle(el).backgroundColor,
        }))).toEqual({ scrub:false,cursor:"default",background:"rgba(0, 0, 0, 0)" });
      }
      expect((await state(page)).scene).toEqual(initial);
      await page.getByRole("button", { name: "Duplicate", exact: true }).click();
      const withCopy = (await state(page)).scene;
      const copy = withCopy.bodies.find(body => !initial.bodies.some(old => old.id === body.id))!;
      expect(withCopy.bodies).toHaveLength(initial.bodies.length+1);
      expect(withCopy.links).toEqual(initial.links);
      expect(copy.rod_id).toBeNull();
      expect(copy.mass).toBe(original.mass);
      expect(withCopy.bodies.find(body => body.id === id)).toEqual(original);
      const x = page.getByRole("textbox", { name: "x (m)", exact: true });
      await expect(x).toHaveJSProperty("readOnly", false);
      await x.fill("0.3"); await x.press("Enter");
      expect((await state(page)).scene.bodies.find(body => body.id === copy.id)!.pos[0]).toBe(.3);
      expect((await state(page)).scene.bodies.find(body => body.id === id)).toEqual(original);
      await undo(page); await undo(page);
      expect((await state(page)).scene).toEqual(initial);
      const hide = page.getByRole("button", { name: "Hide Inspector", exact: true });
      if (width < 760 && await hide.isVisible()) await hide.click();
      await selectLoad(page,id);
      await page.getByRole("button", { name: /^Select rod: / }).click();
      await page.locator("#canvas").focus(); await page.keyboard.press("Control+d");
      const whole = (await state(page)).scene;
      expect(whole.bodies).toHaveLength(initial.bodies.length*2);
      expect(whole.links).toHaveLength(2);
      const copiedRod = whole.links.find(link => link.id !== initial.links[0].id)!;
      const copies = whole.bodies.filter(body => !initial.bodies.some(old => old.id === body.id));
      expect(copies.map(body => body.id)).toEqual(expect.arrayContaining([copiedRod.a,copiedRod.b]));
      expect(copies.filter(body => !body.is_rod_endpoint).every(body => body.rod_id === copiedRod.id)).toBe(true);
      for (const body of initial.bodies) expect(whole.bodies.find(other => other.id === body.id)).toEqual(body);
      await undo(page); expect((await state(page)).scene).toEqual(initial);
      await page.keyboard.press("Control+y"); expect((await state(page)).scene).toEqual(whole);
      await page.screenshot({ path: info.outputPath("independent-beam-copy.png") });
      expect(errors).toEqual([]);
    });

    test("mounted particle spin visibly advances independently of the balanced beam", async ({ page }, info) => {
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      const id = await prepare(page, { theme, studio_mode: studio, font_scale: scale });
      await page.getByRole("checkbox", { name: "Free-body forces on canvas", exact: true }).uncheck();
      await page.getByRole("checkbox", { name: "No rotation", exact: true }).uncheck();
      const spin = page.getByRole("textbox", { name: "Spin (type an exact value)", exact: true });
      await spin.fill("3"); await spin.press("Enter");
      if (width < 760) await page.getByRole("button", { name: "Hide Inspector", exact: true }).click();
      const before = await state(page), body = before.scene.bodies.find(body => body.id === id)!;
      await expect.poll(() => page.evaluate(() => (window as unknown as { rodPaintedScene:string }).rodPaintedScene))
        .toBe(JSON.stringify(before.scene));
      const pixels = async () => {
        const saved = await state(page), [cx,cy,zoom] = saved.presentation.camera;
        const target = saved.scene.bodies.find(body => body.id === id)!;
        return page.locator("#canvas").evaluate((el, { cx,cy,zoom,target }) => {
          const canvas = el as HTMLCanvasElement, ratio = canvas.width/canvas.clientWidth;
          const x = canvas.clientWidth/2+(target.pos[0]-cx)*zoom, y = canvas.clientHeight/2+(cy-target.pos[1])*zoom;
          const radius = Math.ceil(target.radius*zoom*ratio)+2;
          return [...canvas.getContext("2d")!.getImageData(Math.round(x*ratio)-radius,
            Math.round(y*ratio)-radius,2*radius,2*radius).data];
        }, { cx,cy,zoom,target });
      };
      const initialPixels = await pixels();
      const clock = page.getByRole("textbox", { name: "Simulation time in seconds", exact: true });
      await clock.fill("0.5"); await clock.press("Enter");
      await expect.poll(async () => (await state(page)).scene.settings.time).toBeCloseTo(.5,9);
      const after = await state(page), moving = after.scene.bodies.find(body => body.id === id)!;
      expect(moving.angle-body.angle).toBeCloseTo(1.5,9); expect(moving.omega).toBe(3);
      for (const original of before.scene.bodies)
        expect(after.scene.bodies.find(other => other.id === original.id)!.pos).toEqual(original.pos);
      expect(after.presentation.camera).toEqual(before.presentation.camera);
      await expect.poll(() => page.evaluate(() => (window as unknown as { rodPaintedScene:string }).rodPaintedScene))
        .toBe(JSON.stringify(after.scene));
      await expect.poll(async () => (await pixels()).filter((value,index) => value !== initialPixels[index]).length).toBeGreaterThan(10);
      await page.screenshot({ path: info.outputPath("independent-particle-spin.png") });
      if (width < 760) await page.getByRole("button", { name: "Open Inspector", exact: true }).click();
      await page.getByRole("checkbox", { name: "No rotation", exact: true }).check();
      await expect(spin).toBeDisabled();
      await clock.fill("0.7"); await clock.press("Enter");
      await expect.poll(async () => (await state(page)).scene.settings.time).toBeCloseTo(.7,9);
      const locked = (await state(page)).scene.bodies.find(body => body.id === id)!;
      expect(locked.omega).toBe(0); expect(locked.angle).toBe(moving.angle);
      expect(errors).toEqual([]);
    });

    test("particle colour presets stay on one inset row", async ({ page }, info) => {
      const id = await prepare(page, { theme, studio_mode: studio, font_scale: scale });
      const before = (await state(page)).scene;
      const group = page.getByRole("group", { name: "Colour presets", exact: true });
      await group.scrollIntoViewIfNeeded();
      for (const narrow of (width >= 760 ? [false,true] : [false])) {
      if (narrow) {
        await page.locator("#inspector-splitter").focus(); await page.keyboard.press("Home");
        await group.scrollIntoViewIfNeeded();
      }
      const metrics = await group.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const chips = [...el.querySelectorAll("button")].map(button => button.getBoundingClientRect());
        return { count:chips.length, rows:new Set(chips.map(chip => Math.round(chip.top))).size,
          left:Math.min(...chips.map(chip => chip.left))-rect.left,
          right:rect.right-Math.max(...chips.map(chip => chip.right)),
          minWidth:Math.min(...chips.map(chip => chip.width)),
          requiredWidth:chips.reduce((sum,chip) => sum+chip.width,0)+6,
          availableWidth:el.clientWidth,
          fits:el.scrollWidth <= el.clientWidth };
      });
      await info.attach(`colour-row-metrics-${narrow ? "minimum" : "default"}`, { body:JSON.stringify(metrics),contentType:"application/json" });
      expect(metrics.count).toBeGreaterThan(1); expect(metrics.rows).toBe(1);
      expect(metrics.left).toBeGreaterThanOrEqual(2);
      expect(metrics.minWidth).toBeGreaterThanOrEqual(24);
      if (metrics.requiredWidth <= metrics.availableWidth) {
        expect(metrics.right).toBeGreaterThanOrEqual(2); expect(metrics.fits).toBe(true);
      } else {
        const buttons = group.getByRole("button");
        await buttons.first().focus();
        for (let i=1;i<metrics.count;i++) await page.keyboard.press("Tab");
        await expect(buttons.last()).toBeFocused();
        await expect.poll(() => group.evaluate(el => {
          const edge = el.getBoundingClientRect(), last = el.querySelector("button:last-child")!.getBoundingClientRect();
          return last.left >= edge.left && last.right <= edge.right;
        })).toBe(true);
        await page.screenshot({ path:info.outputPath("keyboard-colour-presets.png") });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const last = group.getByRole("button").last();
      const hex = /#[0-9a-f]{6}$/i.exec((await last.getAttribute("aria-label"))!)![0];
      await last.click();
      expect((await state(page)).scene.bodies.find(body => body.id === id)!.color)
        .toEqual([1,3,5].map(index => Number.parseInt(hex.slice(index,index+2),16)));
      await undo(page); expect((await state(page)).scene).toEqual(before);
      const hide = page.getByRole("button", { name: "Hide Inspector", exact: true });
      if (width < 760 && await hide.isVisible()) await hide.click();
      await selectLoad(page,id); await group.scrollIntoViewIfNeeded();
      await page.screenshot({ path:info.outputPath("inset-colour-presets.png") });
      }
    });
  });
}
