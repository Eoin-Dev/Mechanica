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
  render(): void;
  update(dt: number): void;
  renderMs: number;
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
