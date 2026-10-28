import { clickSceneAction } from "./scene-actions";
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

// Configure the setup size before creating the page; keep loaded-app resizes below.
test.use({ viewport: { width: 1000, height: 900 } });

async function saved(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    const recovery = JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!);
    return { scene: JSON.parse(recovery.scene), camera: recovery.presentation.camera as number[] };
  });
}
async function massControl(page: Page, adaptive: boolean, continuous: boolean) {
  await page.addInitScript(settings => localStorage.setItem("mechanica.settings", JSON.stringify(settings)),
    { tour_done: true, adaptive_scrub: adaptive, continuous_scrub: continuous, theme: "dark" });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library", exact: true });
  await library.getByRole("searchbox").fill("Atwood machine");
  await library.getByRole("button", { name: "Load Atwood machine", exact: true }).click();
  const before = await saved(page), [cx, cy, zoom] = before.camera;
  const particle = before.scene.bodies.find((body: { color: number[]; is_anchor: boolean }) => body.color[0] === 86 && !body.is_anchor);
  const canvas = page.locator("#canvas"), size = await canvas.evaluate(el => ({ w: el.clientWidth, h: el.clientHeight }));
  await canvas.click({ position: { x: size.w / 2 + (particle.pos[0] - cx) * zoom,
    y: size.h / 2 + (cy - particle.pos[1]) * zoom } });
  const label = page.locator('.row:has(input[type="range"][aria-label="Mass"]) .lbl');
  await label.scrollIntoViewIfNeeded();
  const exact = page.getByRole("textbox", { name: "Mass (type an exact value)", exact: true });
  const mass = async () => {
    if (await page.evaluate(() => document.documentElement.classList.contains("numeric-scrubbing")))
      return Number.parseFloat(await exact.inputValue());
    return (await saved(page)).scene.bodies.find((body: { id: number }) => body.id === particle.id).mass as number;
  };
  const select = async () => {
    const current = await saved(page), [cx, cy, zoom] = current.camera;
    const body = current.scene.bodies.find((body: { id: number }) => body.id === particle.id);
    await canvas.click({ position: { x: size.w / 2 + (body.pos[0] - cx) * zoom,
      y: size.h / 2 + (cy - body.pos[1]) * zoom } });
  };
  return { label, mass, select, exact, id: particle.id as number };
}

test("native slow and fast label drags have adaptive precision and one undo entry", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const { label, mass, select } = await massControl(page, true, false);
  const initial = await mass();
  const drag = async (slow: boolean) => {
    const bounds = (await label.boundingBox())!, x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    if (slow) for (let dx = 2; dx <= 40; dx += 2) {
      await page.waitForTimeout(50); await page.mouse.move(x + dx, y);
    } else await page.mouse.move(x + 40, y);
    await page.mouse.up();
    return (await mass()) - initial;
  };
  const slow = await drag(true); expect(slow).toBeGreaterThan(0);
  await page.locator("#canvas").focus(); await page.keyboard.press("Control+z");
  await expect.poll(mass).toBe(initial); await select();
  const fast = await drag(false); expect(fast).toBeGreaterThan(slow * 1.5);
  await page.screenshot({ path: info.outputPath("adaptive-numeric-drag.png") });
  await page.locator("#canvas").focus(); await page.keyboard.press("Control+z");
  await expect.poll(mass).toBe(initial);
  await page.keyboard.press("Control+Shift+z"); await expect.poll(mass).toBeCloseTo(initial + fast, 8);
  await info.attach("native-speed-comparison", { body: JSON.stringify({ initial, slow, fast }), contentType: "application/json" });
  expect(await page.locator(".numeric-scrub-cursor").count()).toBe(0);
  expect(await page.evaluate(() => Boolean(document.pointerLockElement))).toBe(false);
  expect(errors).toEqual([]);
});

type MotionProbe = { supported: boolean; rejected: boolean; locked: boolean;
  requests: { at: number; target: string; focused: boolean; visibility: string; continuous: string | undefined;
    arguments: number; returned?: string; settled?: string; settledAt?: number; error?: string }[];
  origin: number[] | null; moves: { dx: number; dy: number; trusted: boolean }[];
  events: { type: string; time?: number; target?: string; buttons?: number; locked: boolean; dx?: number; dy?: number; x?: number; y?: number; trusted?: boolean; id?: number; pointerType?: string }[] };

test("native continuous scrubbing wraps only its cursor and cleans up on release and Escape", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const browserMessages: { type: string; text: string }[] = [];
  page.on("console", message => { if (["warning", "error"].includes(message.type()) || /pointer|lock/i.test(message.text()))
    browserMessages.push({ type: message.type(), text: message.text().slice(0,2000) }); });
  const { label, mass, exact, select } = await massControl(page, false, true);
  await exact.fill("50"); await exact.press("Enter"); await expect.poll(mass).toBe(50);
  await page.evaluate(() => {
    const probe: MotionProbe = { supported: "requestPointerLock" in HTMLElement.prototype,
      rejected: false, locked: false, requests: [], origin: null, moves: [], events: [] };
    Object.defineProperty(window, "__scrubMotion", { value: probe, configurable: true });
    const request = HTMLElement.prototype.requestPointerLock;
    if (request) HTMLElement.prototype.requestPointerLock = function(this: HTMLElement, ...args: Parameters<HTMLElement["requestPointerLock"]>) {
      const observation: MotionProbe["requests"][number] = { at: performance.now(), target: this.outerHTML.slice(0,400),
        focused: document.hasFocus(), visibility: document.visibilityState,
        continuous: document.documentElement.dataset.continuousScrub, arguments: args.length };
      probe.requests.push(observation);
      try {
        // The current DOM signature is promise-based; legacy engines return void.
        const result = request.apply(this, args) as Promise<void> | undefined;
        observation.returned = result ? "promise" : "void";
        if (result) void result.then(() => { observation.settled = "resolved"; observation.settledAt = performance.now(); }, error => {
          observation.settled = "rejected"; observation.settledAt = performance.now(); observation.error = String(error); probe.rejected = true;
        });
        return result as Promise<void>;
      } catch (error) {
        observation.settled = "threw"; observation.settledAt = performance.now(); observation.error = String(error); probe.rejected = true; throw error;
      }
    };
    document.addEventListener("pointerlockerror", event => { probe.rejected = true;
      probe.events.push({ type: "pointerlockerror", time: event.timeStamp, locked: Boolean(document.pointerLockElement) }); });
    window.addEventListener("blur", event => probe.events.push({ type: "blur", time: event.timeStamp, locked: Boolean(document.pointerLockElement) }));
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture", "mousemove", "mouseup"]) {
      document.addEventListener(type, event => probe.events.push({ type, time: event.timeStamp,
        target: event.target instanceof Element ? event.target.outerHTML.slice(0,300) : String(event.target), buttons: (event as MouseEvent).buttons,
        locked: Boolean(document.pointerLockElement), dx: (event as MouseEvent).movementX, dy: (event as MouseEvent).movementY,
        x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, trusted: event.isTrusted,
        id: (event as PointerEvent).pointerId, pointerType: (event as PointerEvent).pointerType }), true);
    }
    document.addEventListener("pointerlockchange", event => {
      probe.locked = Boolean(document.pointerLockElement);
      probe.events.push({ type: "pointerlockchange", time: event.timeStamp, locked: probe.locked });
      if (probe.locked) queueMicrotask(() => {
        const cursor = document.querySelector<HTMLElement>(".numeric-scrub-cursor");
        if (cursor) { const matrix = new DOMMatrixReadOnly(cursor.style.transform); probe.origin = [matrix.m41, matrix.m42]; }
      });
    });
    document.addEventListener("pointermove", event => {
      if (document.pointerLockElement && (event.buttons & 1) !== 0)
        probe.moves.push({ dx: event.movementX, dy: event.movementY, trusted: event.isTrusted });
    }, true);
  });
  const probe = () => page.evaluate<MotionProbe>("window.__scrubMotion");
  const bounds = (await label.boundingBox())!, x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 6, y);
  try {
    await expect.poll(async () => { const p = await probe(); return !p.supported || p.rejected || p.locked; }).toBe(true);
  } finally {
    const acquisition = { ...await page.evaluate(() => ({
      probe: (window as unknown as { __scrubMotion: MotionProbe }).__scrubMotion,
      observedAt: performance.now(),
      actualLock: document.pointerLockElement?.outerHTML.slice(0,400) ?? null,
      focused: document.hasFocus(), visibility: document.visibilityState,
      continuous: document.documentElement.dataset.continuousScrub,
      scrubbing: document.documentElement.classList.contains("numeric-scrubbing"),
      cursor: document.querySelector(".numeric-scrub-cursor")?.outerHTML ?? null,
      mass: document.querySelector<HTMLInputElement>('[aria-label="Mass (type an exact value)"]')?.value,
    })), browserMessages };
    // Keep the raw outcome even if a larger run is interrupted before JSON reporting.
    const path = info.outputPath("native-acquisition.json");
    await writeFile(path, JSON.stringify(acquisition, null, 2));
    await info.attach("native-acquisition", { path, contentType: "application/json" });
  }
  const locked = (await probe()).locked;
  if (locked) {
    await expect(page.locator(".numeric-scrub-cursor")).toHaveCount(1);
    await page.evaluate(() => {
      const probe = (window as unknown as { __scrubMotion: MotionProbe }).__scrubMotion;
      const cursor = document.querySelector<HTMLElement>(".numeric-scrub-cursor")!;
      const matrix = new DOMMatrixReadOnly(cursor.style.transform);
      probe.origin = [matrix.m41, matrix.m42]; probe.moves = [];
    });
    await page.mouse.move(950, y + 15); await page.mouse.move(949, y + 20);
    await page.mouse.move(950, y + 15); await page.mouse.move(949, y + 20);
    const inside = await probe();
    await info.attach("native-in-viewport-motion", { body: JSON.stringify(inside), contentType: "application/json" });
    // Firefox recentres locked motion between commands; these inside-viewport
    // inputs can already cross an entire virtual screen. Other drivers need
    // further physical coordinates to produce the same cumulative distance.
    if (Math.abs(inside.moves.reduce((total, move) => total + move.dx, 0)) <= 1000) {
      await page.mouse.move(x + 1100, y + 40); await page.mouse.move(x + 1800, y - 50);
    }
    await info.attach("native-cumulative-motion", { body: JSON.stringify(await probe()), contentType: "application/json" });
    const p = await probe(); expect(p.origin).not.toBeNull(); expect(p.moves.length).toBeGreaterThan(0);
    expect(p.moves.every(move => move.trusted)).toBe(true);
    const dx = p.moves.reduce((total, move) => total + move.dx, 0), dy = p.moves.reduce((total, move) => total + move.dy, 0);
    expect(Math.abs(dx)).toBeGreaterThan(1000);
    const actual = await page.locator(".numeric-scrub-cursor").evaluate(el => {
      const matrix = new DOMMatrixReadOnly((el as HTMLElement).style.transform); return [matrix.m41, matrix.m42];
    });
    const wrap = (value: number, edge: number) => ((value % edge) + edge) % edge;
    expect(actual[0]).toBeCloseTo(wrap(p.origin![0] + dx, 1000), 3);
    expect(actual[1]).toBeCloseTo(wrap(p.origin![1] + dy, 900), 3);
    await page.screenshot({ path: info.outputPath("continuous-wrapped-cursor.png") });
  } else {
    await expect(page.locator(".numeric-scrub-cursor")).toHaveCount(0);
    await page.mouse.move(x + 80, y);
  }
  await page.mouse.up(); await expect.poll(mass).not.toBe(50);
  const committed = await mass();
  await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(false);
  await expect(page.locator(".numeric-scrub-cursor")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.classList.contains("numeric-scrubbing"))).toBe(false);
  await page.locator("#canvas").focus(); await page.keyboard.press("Control+z"); await expect.poll(mass).toBe(50);
  await page.keyboard.press("Control+Shift+z"); await expect.poll(mass).toBe(committed);
  await select(); await label.scrollIntoViewIfNeeded();
  const next = (await label.boundingBox())!;
  await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2); await page.mouse.down();
  await page.mouse.move(next.x + next.width / 2 - 12, next.y + next.height / 2);
  await expect.poll(mass).not.toBe(committed);
  await page.keyboard.press("Escape"); await page.mouse.up(); await expect.poll(mass).toBe(committed);
  await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(false);
  await expect(page.locator(".numeric-scrub-cursor")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.classList.contains("numeric-scrubbing"))).toBe(false);
  await info.attach("native-pointer-support", { body: JSON.stringify({ mode: locked ? "locked" : "fallback", ...await probe() }), contentType: "application/json" });
  expect(errors).toEqual([]);
});


test("enabling No rotation during a numeric spin gesture releases the pointer and preserves the lock", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const { id } = await massControl(page, false, true);
  const rotation = page.getByRole("checkbox", { name: "No rotation", exact: true });
  await rotation.uncheck();
  const spin = page.getByRole("textbox", { name: "Spin (type an exact value)", exact: true });
  await spin.fill("5"); await spin.press("Enter");
  const label = page.locator('.row:has(input[type="range"][aria-label="Spin"]) .lbl');
  await label.scrollIntoViewIfNeeded(); await rotation.focus();
  const bounds = (await label.boundingBox())!, x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 16, y);
  await expect.poll(async () => Number.parseFloat(await spin.inputValue())).toBeGreaterThan(5);
  await page.keyboard.press("Space");
  await expect(rotation).toBeChecked();
  await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(false);
  await expect(page.locator(".numeric-scrub-cursor")).toHaveCount(0);
  await page.mouse.up();
  const body = (await saved(page)).scene.bodies.find((body: { id: number }) => body.id === id);
  expect(body.no_rotation).toBe(true); expect(body.omega).toBe(0);
  await expect(spin).toBeDisabled();
  await clickSceneAction(page, "Undo the last edit (Ctrl+Z).");
  await expect.poll(async () => {
    const body = (await saved(page)).scene.bodies.find((body: { id: number }) => body.id === id);
    return [body.no_rotation, body.omega];
  }).toEqual([false, 5]);
  await clickSceneAction(page, "Redo the last undone edit (Ctrl+Y).");
  await expect.poll(async () => {
    const body = (await saved(page)).scene.bodies.find((body: { id: number }) => body.id === id);
    return [body.no_rotation, body.omega];
  }).toEqual([true, 0]);
  expect(await page.evaluate(() => document.documentElement.classList.contains("numeric-scrubbing"))).toBe(false);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Library", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("spin-lock-after-scrub.png") });
  expect(errors).toEqual([]);
});

test("a lost mouse-up cannot keep numeric pointer lock or apply an extra value change", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const { label, mass } = await massControl(page, false, true);
  const initial = await mass();
  await page.evaluate(() => {
    // Deliberately lose release delivery to the app while preserving trusted
    // mouse input and the browser's own pointer/capture lifecycle.
    for (const type of ["pointerup", "mouseup"]) document.addEventListener(type,
      event => event.stopImmediatePropagation(), { capture: true, once: true });
  });
  const box = (await label.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 16, y);
  await expect.poll(mass).toBeGreaterThan(initial);
  const preview = await mass(), locked = await page.evaluate(() => Boolean(document.pointerLockElement));
  await page.mouse.up();
  await page.mouse.move(x + 40, y + 4);
  await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(false);
  await expect(page.locator(".numeric-scrub-cursor")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.classList.contains("numeric-scrubbing"))).toBe(false);
  // An owned lock commits the last preview when button-free motion arrives.
  // Fallback capture loss cancels safely and restores the original value.
  await expect.poll(mass).toBe(locked ? preview : initial);
  if (locked) {
    await clickSceneAction(page, "Undo the last edit (Ctrl+Z).");
    await expect.poll(mass).toBe(initial);
    await clickSceneAction(page, "Redo the last undone edit (Ctrl+Y).");
    await expect.poll(mass).toBe(preview);
  }
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Library", exact: true })).toBeVisible();
  await info.attach("lost-release-cleanup", { body: JSON.stringify({ mode: locked ? "locked" : "fallback", initial, preview }), contentType: "application/json" });
  expect(errors).toEqual([]);
});

for (const continuous of [false, true]) for (const hideBy of ["shortcut", "responsive layout"] as const) {
  test(`hiding the Inspector cancels the numeric edit (continuous=${continuous}, ${hideBy})`, async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const { label, mass, exact, select } = await massControl(page, false, continuous);
    const original = await mass();
    await exact.fill("50"); await exact.press("Enter");
    const baseline = (await saved(page)).scene;
    await label.scrollIntoViewIfNeeded();
    const box = (await label.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 12, y);
    await expect.poll(mass).not.toBe(50);
    const beforeHide = await page.evaluate(() => ({
      locked: Boolean(document.pointerLockElement),
      mass: document.querySelector<HTMLInputElement>('[aria-label="Mass (type an exact value)"]')!.value,
    }));
    if (hideBy === "shortcut") await page.keyboard.press("Backslash");
    else await page.setViewportSize({ width: 600, height: 900 });
    await expect(page.locator("#inspector-panel")).toBeHidden();
    // Do not call saved()/dispatch pagehide until cancellation is verified:
    // pagehide itself cancels an edit and would hide this regression.
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("numeric-scrubbing"))).toBe(false);
    await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(false);
    await expect(page.locator(".numeric-scrub-cursor")).toHaveCount(0);
    expect(Number.parseFloat(await page.getByRole("textbox", { name: "Mass (type an exact value)", exact: true, includeHidden: true }).inputValue())).toBe(50);
    await page.mouse.move(Math.min(500, x + 40), y + 5); await page.mouse.up();
    expect((await saved(page)).scene).toEqual(baseline);
    if (hideBy === "responsive layout") await page.setViewportSize({ width: 1000, height: 900 });
    else await page.getByRole("button", { name: "Show Inspector", exact: true }).click();
    await expect(label).toBeVisible();
    await page.locator("#canvas").focus(); await page.keyboard.press("Control+z");
    await expect.poll(mass).toBe(original); // The cancelled drag added no undo entry.
    await page.keyboard.press("Control+Shift+z"); await expect.poll(mass).toBe(50); await select();
    await label.scrollIntoViewIfNeeded();
    const next = (await label.boundingBox())!;
    await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2);
    await page.mouse.down(); await page.mouse.move(next.x + next.width / 2 + 12, next.y + next.height / 2);
    await expect.poll(mass).not.toBe(50); await page.mouse.up();
    const committed = await mass();
    await page.locator("#canvas").focus(); await page.keyboard.press("Control+z"); await expect.poll(mass).toBe(50);
    await page.keyboard.press("Control+Shift+z"); await expect.poll(mass).toBe(committed);
    await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(false);
    await expect(page.locator(".numeric-scrub-cursor")).toHaveCount(0);
    await info.attach("hidden-control-cancellation", { body: JSON.stringify({ continuous, hideBy, beforeHide, original, committed }), contentType: "application/json" });
    expect(errors).toEqual([]);
  });
}
