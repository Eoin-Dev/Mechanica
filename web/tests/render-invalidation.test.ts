/** @vitest-environment jsdom */
/** App canvas invalidation and backing-store lifecycle. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { Body } from "../src/engine/body";
import { Vec2 } from "../src/core/vec";

class FakePath2D {
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  arc(): void {}
  rect(): void {}
  quadraticCurveTo(): void {}
  bezierCurveTo(): void {}
}

interface Harness {
  app: App;
  canvas: HTMLCanvasElement;
  setCssSize(w: number, h: number): void;
  fillCount(): number;
  widthWrites(): number;
  heightWrites(): number;
  contextOptions(): CanvasRenderingContext2DSettings | undefined;
}

function harness(): Harness {
  let cssW = 800;
  let cssH = 600;
  let backingW = 0;
  let backingH = 0;
  let writesW = 0;
  let writesH = 0;
  let fills = 0;
  let options: CanvasRenderingContext2DSettings | undefined;
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { get: () => cssW, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { get: () => cssH, configurable: true });
  Object.defineProperty(canvas, "width", {
    get: () => backingW,
    set: (value: number) => { backingW = value; writesW++; },
    configurable: true,
  });
  Object.defineProperty(canvas, "height", {
    get: () => backingH,
    set: (value: number) => { backingH = value; writesH++; },
    configurable: true,
  });
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: cssW, height: cssH,
                    right: cssW, bottom: cssH, x: 0, y: 0 }),
    configurable: true,
  });
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  const ctx = {
    setTransform() {},
    fillRect() { fills++; },
    clearRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {},
    lineTo() {}, stroke() {}, fill() {}, arc() {}, closePath() {},
    measureText: () => ({ width: 10 }), fillText() {}, translate() {},
    rotate() {}, scale() {}, setLineDash() {}, clip() {}, quadraticCurveTo() {},
    bezierCurveTo() {}, rect() {}, roundRect() {}, ellipse() {}, strokeRect() {},
  } as unknown as CanvasRenderingContext2D;
  canvas.getContext = ((kind: string, config?: CanvasRenderingContext2DSettings) => {
    expect(kind).toBe("2d");
    options = config;
    return ctx;
  }) as HTMLCanvasElement["getContext"];
  document.body.replaceChildren(canvas);
  const app = new App(canvas);
  app.view.grid = false;
  return {
    app,
    canvas,
    setCssSize(w, h) { cssW = w; cssH = h; },
    fillCount: () => fills,
    widthWrites: () => writesW,
    heightWrites: () => writesH,
    contextOptions: () => options,
  };
}

type AppInternals = {
  render(): boolean;
  update(dt: number): void;
  tunePerformance(now: number): void;
  updateDisplayFps(now: number, painted: boolean): void;
  renderMs: number;
  physicsMs: number;
  performanceBadSince: number | null;
};

function internals(app: App): AppInternals {
  return app as unknown as AppInternals;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("Path2D", FakePath2D);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("retained App canvas", () => {
  it("idles below monitor rate while paused and wakes immediately on invalidation", () => {
    const frames: FrameRequestCallback[] = [];
    const timers: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return 1;
    });
    vi.spyOn(window, "setTimeout").mockImplementation(((cb: TimerHandler) => {
      if (typeof cb === "function") timers.push(() => cb());
      return 7;
    }) as typeof window.setTimeout);
    const clear = vi.spyOn(window, "clearTimeout").mockImplementation(() => {});
    const h = harness();
    h.app.start();
    expect(frames).toHaveLength(1);
    frames.shift()!(performance.now() + 16);
    expect(frames).toHaveLength(0);
    expect(timers).toHaveLength(1);

    h.app.invalidateCanvas();
    expect(clear).toHaveBeenCalledWith(7);
    expect(frames).toHaveLength(1);
  });

  it("uses an opaque context and does not reset unchanged backing dimensions", () => {
    const h = harness();
    expect(h.contextOptions()).toEqual({ alpha: false });

    h.app.resizeCanvas();
    expect([h.widthWrites(), h.heightWrites()]).toEqual([1, 1]);
    h.app.resizeCanvas();
    expect([h.widthWrites(), h.heightWrites()]).toEqual([1, 1]);

    h.setCssSize(640, 600);
    h.app.resizeCanvas();
    expect([h.widthWrites(), h.heightWrites()]).toEqual([2, 1]);
    expect([h.app.camera.screenW, h.app.camera.screenH]).toEqual([640, 600]);
  });

  it("reduces only the simulation backing density as adaptive pressure rises", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const h = harness();
    h.app.resizeCanvas();
    expect(h.canvas.width).toBe(1600);
    expect(h.canvas.height).toBe(1200);

    h.app.setPerfMode(true);
    expect(h.app.performanceLevel).toBe(1);
    expect(h.canvas.width).toBe(1000); // 800 CSS px at the 1.25 cap
    expect(h.canvas.height).toBe(750);

    const raw = internals(h.app);
    h.app.playing = true;
    h.app.fpsNow = 25;
    h.app.overloaded = true;
    raw.renderMs = 20;
    raw.physicsMs = 20;
    raw.tunePerformance(1000);
    raw.tunePerformance(1300);
    raw.tunePerformance(1600);
    expect(h.app.performanceLevel).toBe(3);
    expect(h.canvas.width).toBe(800);
    expect(h.canvas.height).toBe(600);
    expect(h.app.world.performanceLevel).toBe(3);
  });

  it("presents alternate frames only when maximum mode remains overloaded", () => {
    const h = harness();
    const raw = internals(h.app);
    h.app.setPerfMode(true);
    h.app.performanceLevel = 3;
    h.app.world.performanceLevel = 3;
    h.app.playing = true;
    h.app.overloaded = true;
    raw.performanceBadSince = performance.now() - 1000;
    h.app.invalidateCanvas();
    raw.render();
    expect(h.fillCount()).toBe(0);
    raw.render();
    expect(h.fillCount()).toBe(1);
  });

  it("measures paused paints but lets unchanged paused callbacks return to Idle", () => {
    const app = harness().app;
    const raw = internals(app);

    raw.updateDisplayFps(1000, true);
    expect(app.displayActive).toBe(true);
    expect(app.displayFpsNow).toBe(0); // first paint starts a fresh sample
    raw.updateDisplayFps(1020, true);
    expect(app.displayFpsNow).toBeCloseTo(50, 10);

    raw.updateDisplayFps(1249, false);
    expect(app.displayActive).toBe(true);
    raw.updateDisplayFps(1270, false);
    expect(app.displayActive).toBe(false);
    expect(app.displayFpsNow).toBe(0);
  });

  it("does not treat the paused idle cadence as Performance-mode pressure", () => {
    const app = harness().app;
    const raw = internals(app);
    app.setPerfMode(true);
    app.fpsNow = 20; // the intentional paused timer frequency
    raw.renderMs = 20;
    raw.physicsMs = 0;

    raw.tunePerformance(1000);
    raw.tunePerformance(1400);
    raw.tunePerformance(1800);

    expect(app.playing).toBe(false);
    expect(app.performanceLevel).toBe(1);
  });

  it("defers overload feedback until adaptive Performance mode reaches maximum", () => {
    const h = harness();
    h.app.setPerfMode(true);
    h.app.playing = true;
    h.app.overloaded = true;
    h.app.performanceLevel = 2;
    expect(h.app.slowReason()).toBeNull();
    h.app.performanceLevel = 3;
    expect(h.app.slowReason()).toBeNull();
    internals(h.app).performanceBadSince = performance.now() - 1000;
    expect(h.app.slowReason()).toBe("physics");
  });

  it("skips unchanged and empty-playback frames but redraws every visual route", () => {
    const h = harness();
    const app = h.app;
    const raw = internals(app);

    raw.render();
    const initial = h.fillCount();
    raw.render();
    expect(h.fillCount()).toBe(initial);

    raw.renderMs = 20;
    raw.render();
    expect(raw.renderMs).toBeCloseTo(17, 10);

    app.playing = true;
    raw.update(1 / 60);
    raw.render();
    expect(app.world.time).toBeGreaterThan(0);
    expect(h.fillCount()).toBe(initial);
    app.playing = false;

    app.camera.panPixels(10, -5);
    raw.render();
    expect(h.fillCount()).toBeGreaterThan(initial);
    let painted = h.fillCount();

    app.view.labels = true;
    raw.render();
    expect(h.fillCount()).toBeGreaterThan(painted);
    painted = h.fillCount();

    app.edit(() => { app.world.gravity = 0; });
    raw.render();
    expect(h.fillCount()).toBeGreaterThan(painted);
    painted = h.fillCount();

    const body = new Body(new Vec2(0, 0), 0.2, 1);
    body.vel.x = 1;
    app.edit(() => { app.world.bodies.push(body); });
    raw.render();
    painted = h.fillCount();
    app.stepOnce();
    raw.render();
    expect(body.pos.x).toBeGreaterThan(0);
    expect(h.fillCount()).toBeGreaterThan(painted);
    painted = h.fillCount();

    app.setSelection([body]);
    raw.render();
    expect(h.fillCount()).toBeGreaterThan(painted);
    painted = h.fillCount();

    const move = new Event("pointermove", { bubbles: true });
    Object.assign(move, { clientX: 5, clientY: 5, pointerId: 1,
                          pointerType: "mouse", shiftKey: false });
    h.canvas.dispatchEvent(move);
    raw.render();
    expect(h.fillCount()).toBeGreaterThan(painted);

    painted = h.fillCount();
    h.setCssSize(700, 500);
    app.resizeCanvas();
    raw.render();
    expect(h.fillCount()).toBeGreaterThan(painted);
  });

  it("keeps a fully static scene retained while its simulation clock advances", () => {
    const h = harness();
    const app = h.app;
    const raw = internals(app);
    const fixed = new Body(new Vec2(0, 0), 0.25, 1);
    fixed.locked = true;
    app.edit(() => { app.world.bodies.push(fixed); });
    raw.render();
    const painted = h.fillCount();

    app.playing = true;
    raw.update(1 / 60);
    raw.render();
    expect(app.world.time).toBeGreaterThan(0);
    expect(h.fillCount()).toBe(painted);
  });
});
