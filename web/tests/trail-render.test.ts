/** Trail rendering: adaptive gradient bands, off-screen culling, vertex
 * decimation and unbroken continuity between bands. Driven through the real
 * drawWorld() with a recording canvas stub (no DOM canvas needed). */
import { describe, expect, it, vi } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { DistanceLink, PulleyLink, SpringLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { Camera } from "../src/render/camera";
import { ViewSettings, drawGrid, drawWorld } from "../src/render/draw";
import { snapshot } from "../src/scene/snapshot";
import { Trail } from "../src/render/trail";
import { analysisForceColour } from "../src/render/analysis-overlays";
import { ACC_COLOR, FORCE_COLOR, VEL_COLOR, WARN, css } from "../src/ui/theme";
import { setTheme, THEME_NAMES } from "../src/ui/theme";

interface Op { op: string; style?: string; x?: number; y?: number;
               cx?: number; cy?: number; text?: string; }

/** Stand-in for the DOM Path2D, which Node does not provide.
 *
 * Everything drawn in bulk - trails by colour band, and links, bodies and
 * vector arrows by style - is built into a Path2D and stroked or filled once
 * per style rather than once per object. This records the geometry so the
 * recording context below can replay it into the op stream at stroke time,
 * in the same order the calls were originally made against the context. */
class FakePath2D {
  ops: Op[] = [];
  moveTo(x: number, y: number): void { this.ops.push({ op: "moveTo", x, y }); }
  lineTo(x: number, y: number): void { this.ops.push({ op: "lineTo", x, y }); }
  closePath(): void { this.ops.push({ op: "closePath" }); }
  arc(cx: number, cy: number, r: number): void {
    this.ops.push({ op: "arc", cx, cy, x: r, y: r });
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.ops.push({ op: "quadraticCurveTo", x, y, cx, cy });
  }
}
(globalThis as unknown as { Path2D: unknown }).Path2D = FakePath2D;

/** A 2D-context that records the drawing calls we care about and no-ops the
 * rest, so drawWorld runs unmodified. */
function recCtx(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
  let strokeStyle = "";
  const base: Record<string, unknown> = {
    beginPath() {},
    stroke(path?: FakePath2D) {
      if (path !== undefined) ops.push(...path.ops.map(op => ({ ...op, style: strokeStyle })));
      ops.push({ op: "stroke", style: strokeStyle });
    },
    fill(path?: FakePath2D) {
      if (path !== undefined) ops.push(...path.ops);
      ops.push({ op: "fill" });
    },
    moveTo(x: number, y: number) { ops.push({ op: "moveTo", x, y }); },
    lineTo(x: number, y: number) { ops.push({ op: "lineTo", x, y }); },
    arc(cx: number, cy: number, r: number) {
      ops.push({ op: "arc", cx, cy, x: r, y: r });
    },
    // Trails are drawn as quadratic curves through midpoints: the endpoint
    // is a midpoint and the CONTROL point is the retained trail sample.
    // Both are recorded - decimation behaviour can only be checked against
    // the control points, since midpoints move whenever the stride does.
    quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
      ops.push({ op: "quadraticCurveTo", x, y, cx, cy });
    },
    fillText(text: string, x: number, y: number) {
      ops.push({ op: "fillText", text, x, y });
    },
    measureText(text: string) { return { width: text.length * 7 }; },
  };
  const ctx = new Proxy(base, {
    get(t, p) {
      if (p === "strokeStyle") return strokeStyle;
      if (p in t) return t[p as string];
      return () => {}; // no-op any other canvas method
    },
    set(_t, p, v) { if (p === "strokeStyle") strokeStyle = v as string; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}

function worldWith(...bodies: Body[]): World {
  const w = new World();
  for (const b of bodies) w.bodies.push(b);
  return w;
}

function trailStrokes(ops: Op[]): Op[] {
  // links/walls/bodies also stroke; the trail strokes are the ones whose
  // moveTo starts a run of lineTos, but simplest: count stroke ops that
  // follow at least one moveTo. Here we just return every stroke op.
  return ops.filter((o) => o.op === "stroke");
}

const view = (): ViewSettings => { const v = new ViewSettings(); v.trails = true; v.grid = false; return v; };

describe("grid rendering", () => {
  it("keeps every grid line in a bounded current path", () => {
    const pathArgs: Array<FakePath2D | undefined> = [];
    const segmentsPerStroke: number[] = [];
    const stylesPerStroke: string[] = [];
    let segments = 0;
    let begins = 0;
    let strokeStyle = "";
    let lineWidth = 0;
    const base: Record<string, unknown> = {
      beginPath() { begins++; segments = 0; },
      moveTo() {},
      lineTo() { segments++; },
      stroke(path?: FakePath2D) {
        pathArgs.push(path);
        segmentsPerStroke.push(segments);
        stylesPerStroke.push(strokeStyle);
      },
    };
    const ctx = new Proxy(base, {
      get(t, p) { return p in t ? t[p as string] : undefined; },
      set(_t, p, value) {
        if (p === "strokeStyle") strokeStyle = String(value);
        if (p === "lineWidth") lineWidth = Number(value);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;

    drawGrid(ctx, new Camera(1200, 650), 1200, 650);

    // A full-canvas Path2D per colour caused raster cost to grow with canvas
    // backing area. The bounded grid contains at most 402 individual lines;
    // each must be a one-segment current path with no Path2D stroke argument.
    expect(pathArgs.length).toBeGreaterThan(3);
    expect(pathArgs.length).toBeLessThanOrEqual(402);
    expect(pathArgs.every((path) => path === undefined)).toBe(true);
    expect(segmentsPerStroke.every((count) => count === 1)).toBe(true);
    expect(begins).toBe(pathArgs.length);
    expect(lineWidth).toBe(1);
    expect(new Set(stylesPerStroke).size).toBe(3); // minor, major and axis

    const detailedLines = pathArgs.length;
    pathArgs.length = 0;
    segmentsPerStroke.length = 0;
    stylesPerStroke.length = 0;
    begins = 0;
    drawGrid(ctx, new Camera(1200, 650), 1200, 650, true);
    expect(pathArgs.length).toBeLessThan(detailedLines / 2);
    expect(pathArgs.every((path) => path === undefined)).toBe(true);
    expect(segmentsPerStroke.every((count) => count === 1)).toBe(true);
    expect(new Set(stylesPerStroke).size).toBe(2); // major and axis only
  });

  it("keeps spatial-debug lines out of a disjoint full-canvas Path2D", () => {
    const pathArgs: Array<FakePath2D | undefined> = [];
    const segmentsPerStroke: number[] = [];
    const stylesPerStroke: string[] = [];
    let segments = 0;
    let begins = 0;
    let strokeStyle = "";
    let lineWidth = 0;
    const base: Record<string, unknown> = {
      beginPath() { begins++; segments = 0; },
      moveTo() {},
      lineTo() { segments++; },
      stroke(path?: FakePath2D) {
        pathArgs.push(path);
        segmentsPerStroke.push(segments);
        stylesPerStroke.push(strokeStyle);
      },
      fill() {},
    };
    const ctx = new Proxy(base, {
      get(t, p) { return p in t ? t[p as string] : () => {}; },
      set(_t, p, value) {
        if (p === "strokeStyle") strokeStyle = String(value);
        if (p === "lineWidth") lineWidth = Number(value);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const body = new Body(new Vec2(1000, 1000), 0.1, 1); // enables grid, remains culled
    const world = worldWith(body);
    const debugView = new ViewSettings();
    debugView.grid = false;
    debugView.trails = false;
    debugView.spatialGrid = true;

    drawWorld(ctx, new Camera(800, 600), world, debugView, [], null,
              new Map(), 800, 600);

    expect(pathArgs.length).toBeGreaterThan(3);
    expect(pathArgs.length).toBeLessThanOrEqual(201);
    expect(pathArgs.every((path) => path === undefined)).toBe(true);
    expect(segmentsPerStroke.every((count) => count === 1)).toBe(true);
    expect(begins).toBe(pathArgs.length);
    expect(lineWidth).toBe(1);
    expect(new Set(stylesPerStroke).size).toBe(1);
  });
});

describe("body rendering", () => {
  it.each(THEME_NAMES)("replaces weight with slope components and keeps other forces in %s", themeName => {
    setTheme(themeName);
    const theta = 25 * Math.PI / 180, t = new Vec2(Math.cos(theta), -Math.sin(theta));
    const body = new Body(new Vec2(-t.y * 0.25, t.x * 0.25), 0.2, 1);
    body.showForceComponents = true; body.noRotation = true; body.friction = 0; body.constForce.x = 2;
    const world = worldWith(body); world.gravity = 9.81;
    const slope = new Wall(t.mul(-3), t.mul(3), 0.1); slope.friction = 0; world.walls.push(slope);
    body.forceSlopeWallId = slope.id;
    const camera = new Camera(800, 600); camera.zoom = 100;
    const { ctx, ops } = recCtx(); const before = world.toDict();
    drawWorld(ctx, camera, world, view(), [body], null, new Map(), 800, 600);
    const labels = ops.filter(op => op.op === "fillText").map(op => op.text);
    expect(labels).toContain("W∥ 4.15 N"); expect(labels).toContain("W⊥ 8.89 N");
    expect(labels).toContain("f 2.00 N"); expect(labels.some(text => text?.startsWith("R "))).toBe(true);
    expect(labels.some(text => text?.startsWith("W ") || text?.startsWith("F∥") || text?.startsWith("F⊥"))).toBe(false);
    expect(world.toDict()).toEqual(before);
    body.forceSlopeWallId = null; ops.length = 0;
    drawWorld(ctx, camera, world, view(), [body], null, new Map(), 800, 600);
    expect(ops.some(op => op.text === "W 9.81 N")).toBe(true);
    expect(ops.some(op => op.text?.startsWith("W∥") || op.text?.startsWith("W⊥"))).toBe(false);
    setTheme("dark");
  });

  it.each([0, 1, 2, 3])("omits all diagram work and keeps particle geometry at Performance tier %s", level => {
    const body = new Body(new Vec2(0, 0), 0.2, 1); body.showForceComponents = true;
    const world = worldWith(body); world.performance = true; world.performanceLevel = level;
    world.step(1 / 120); expect(body.forceSnapshot).toBeNull();
    const query = vi.spyOn(world, "currentForceSnapshot");
    const { ctx, ops } = recCtx(); const camera = new Camera(800, 600); camera.zoom = 100;
    drawWorld(ctx, camera, world, view(), [body], null, new Map(), 800, 600, 1, true, level === 3);
    expect(ops.some(op => op.op === "arc")).toBe(true);
    expect(ops.some(op => op.text?.startsWith("W "))).toBe(false); expect(query).not.toHaveBeenCalled();
    expect(body.showForceComponents).toBe(true);
  });
  it.each(THEME_NAMES)("draws reaction/friction at the rim and weight at the centre in %s", name => {
    setTheme(name);
    try {
      const body = new Body(new Vec2(0, 0.25), 0.2, 1);
      body.showForceComponents = true; body.noRotation = true; body.friction = 1;
      body.constForce.x = 2; body.color = analysisForceColour("reaction");
      const floor = new Wall(new Vec2(-3, 0), new Vec2(3, 0), 0.1);
      floor.friction = 1; floor.restitution = 0;
      const world = worldWith(body); world.walls.push(floor);
      const camera = new Camera(800, 600); camera.zoom = 100;
      for (const performance of [false, true]) {
        const { ctx, ops } = recCtx();
        drawWorld(ctx, camera, world, new ViewSettings(), [body], null, new Map(),
          800, 600, 1, performance, performance);
        if (performance) {
          expect(ops.some(op => op.text?.startsWith("W ") || op.text?.startsWith("R ") || op.text?.startsWith("F "))).toBe(false);
          continue;
        }
        for (const kind of ["reaction", "friction", "weight"] as const) {
          const starts = ops.filter(op => op.op === "moveTo" && op.style === css(analysisForceColour(kind)));
          expect(starts).toContainEqual(expect.objectContaining({ x: 400, y: kind === "weight" ? 275 : 295 }));
        }
        expect(ops.filter(op => op.op === "stroke" && op.style === (name === "light" ? "rgb(255,255,255)" : "rgb(8,8,8)")).length)
          .toBeGreaterThan(0);
        expect(ops.some(op => op.text === "F 2.00 N")).toBe(true);
        expect(ops.some(op => op.text === "f 2.00 N")).toBe(true);
        expect(world.time).toBe(0);
      }
    } finally { setTheme("dark"); }
  });

  it("does not pin an off-screen particle's force captions to the visible canvas", () => {
    const body = new Body(new Vec2(10000, 10000), 0.2, 2);
    body.showForceComponents = true;
    body.constForce.set(3, 0);
    const { ctx, ops } = recCtx();
    drawWorld(ctx, new Camera(800, 600), worldWith(body), new ViewSettings(), [body], null,
      new Map(), 800, 600);
    expect(ops.filter(op => op.op === "fillText")).toEqual([]);
  });

  it("retains a sleeping body's weight and contact reaction on returning to Normal rendering", () => {
    const body = new Body(new Vec2(0, 0), 0.1, 1);
    body.showForceComponents = true;
    body.perfSleeping = true;
    expect(body.invMass).toBe(0);
    const world = worldWith(body);
    world.stepCount = 1;
    const floor = new Wall(new Vec2(-2, -0.15), new Vec2(2, -0.15));
    floor.thickness = 0.1;
    world.walls.push(floor);
    const { ctx, ops } = recCtx();
    drawWorld(ctx, new Camera(800, 600), world, new ViewSettings(), [body], null,
      new Map(), 800, 600, 1, false);
    expect(ops.some(op => op.text?.startsWith("W "))).toBe(true);
    expect(ops.some(op => op.text?.startsWith("R "))).toBe(true);
  });

  it("paints the mass-weighted centre when a particle sleeps", () => {
    const a = new Body(new Vec2(-2, 1), 0.15, 2);
    const b = new Body(new Vec2(2, -1), 0.15, 3);
    b.perfSleeping = true;
    const world = worldWith(a, b);
    const camera = new Camera(800, 600);
    camera.zoom = 100;
    const settings = new ViewSettings();
    settings.com = true;
    const { ctx, ops } = recCtx();
    drawWorld(ctx, camera, world, settings, [], null, new Map(), 800, 600);
    // CoM = (0.4, -0.2); the label is 10px right and 14px below its marker.
    expect(ops.find(op => op.text === "COM")).toMatchObject({ x: 450, y: 334 });
  });

  it("keeps disjoint bodies in bounded current paths", () => {
    const strokeArgs: Array<FakePath2D | undefined> = [];
    const fillArgs: Array<FakePath2D | undefined> = [];
    const base: Record<string, unknown> = {
      beginPath() {}, moveTo() {}, lineTo() {}, arc() {},
      stroke(path?: FakePath2D) { strokeArgs.push(path); },
      fill(path?: FakePath2D) { fillArgs.push(path); },
    };
    const ctx = new Proxy(base, {
      get(t, p) { return p in t ? t[p as string] : () => {}; },
      set() { return true; },
    }) as unknown as CanvasRenderingContext2D;
    const world = new World();
    for (let i = 0; i < 200; i++) {
      world.bodies.push(new Body(new Vec2((i % 20) * 0.25 - 2.5,
        Math.floor(i / 20) * 0.25 - 1.2), 0.08, 1));
    }
    const noTrails = new ViewSettings();
    noTrails.grid = false;
    drawWorld(ctx, new Camera(1200, 650), world, noTrails, [], null,
      new Map(), 1200, 650);

    expect(strokeArgs.length).toBe(200);
    expect(fillArgs.length).toBe(200);
    expect(strokeArgs.every((path) => path === undefined)).toBe(true);
    expect(fillArgs.every((path) => path === undefined)).toBe(true);
  });

  it("retains sub-four-pixel analytical vectors only in Normal mode", () => {
    const body = new Body(new Vec2(0, 0), 0.1, 1);
    // At the 100 px/m camera below, each scaled vector is 0.75 CSS px long:
    // visible in Normal mode but intentionally beneath Performance's 4 px
    // dense-scene cutoff.
    body.vel.set(0.05, 0);
    body.acc.set(0.15, 0);
    body.netForce.set(0.15, 0);
    const analytical = new ViewSettings();
    analytical.grid = false;
    analytical.velVectors = true;
    analytical.accVectors = true;
    analytical.forceVectors = true;
    const cam = new Camera(800, 600);
    cam.zoom = 100;
    const normal = recCtx();
    drawWorld(normal.ctx, cam, worldWith(body), analytical, [], null,
      new Map(), 800, 600);

    for (const color of [VEL_COLOR, ACC_COLOR, FORCE_COLOR]) {
      expect(normal.ops.some((op) =>
        op.op === "stroke" && op.style === css(color))).toBe(true);
    }

    const performance = recCtx();
    drawWorld(performance.ctx, cam, worldWith(body), analytical, [], null,
      new Map(), 800, 600, 1, true);

    for (const color of [VEL_COLOR, ACC_COLOR, FORCE_COLOR]) {
      expect(performance.ops.some((op) =>
        op.op === "stroke" && op.style === css(color))).toBe(false);
    }
  });
});

describe("link rendering", () => {
  it("classifies slack links without per-link distance square roots", () => {
    const distance = vi.spyOn(Vec2.prototype, "distTo");
    try {
      const a = new Body(new Vec2(-1, 0), 0.1, 1);
      const b = new Body(new Vec2(0, 0), 0.1, 1);
      const c = new Body(new Vec2(1, 0), 0.1, 1);
      const world = worldWith(a, b, c);
      world.links.push(new SpringLink(a, b, 10, 0, 2, true));
      const rope = new DistanceLink(b, c, 2);
      rope.isRope = true;
      world.links.push(rope);
      const noTrails = new ViewSettings();
      noTrails.grid = false;
      drawWorld(recCtx().ctx, new Camera(800, 600), world, noTrails, [], null,
        new Map(), 800, 600);
      expect(distance).not.toHaveBeenCalled();
    } finally {
      distance.mockRestore();
    }
  });

  it("caps zoom-driven coil detail in dense spring lattices", () => {
    const a = new Body(new Vec2(-0.1, 0), 0.02, 1);
    const b = new Body(new Vec2(0.1, 0), 0.02, 1);
    a.softBody = b.softBody = true;
    const noTrails = new ViewSettings();
    noTrails.grid = false;
    const cam = new Camera(800, 600);
    cam.zoom = 1000;

    const detailed = worldWith(a, b);
    detailed.links.push(new SpringLink(a, b, 0.2, 1000, 3));
    const detailedRecorder = recCtx();
    drawWorld(detailedRecorder.ctx, cam, detailed, noTrails, [], null,
      new Map(), 800, 600);
    const detailedSegments = detailedRecorder.ops
      .filter((op) => op.op === "lineTo").length;

    const dense = worldWith(a, b);
    for (let i = 0; i < 96; i++) {
      dense.links.push(new SpringLink(a, b, 0.2, 1000, 3));
    }
    const denseRecorder = recCtx();
    drawWorld(denseRecorder.ctx, cam, dense, noTrails, [], null,
      new Map(), 800, 600);
    const denseSegments = denseRecorder.ops
      .filter((op) => op.op === "lineTo").length;

    expect(detailedSegments).toBeGreaterThan(6);
    expect(denseSegments).toBe(96 * 6 + 2); // plus one spin marker per body
  });

  it("draws four pulley tension arrows only when enabled and exposes a column vector", () => {
    const a = new Body(new Vec2(-1, -1), 0.12, 1);
    const b = new Body(new Vec2(1, -1), 0.12, 1);
    const wheel = new Body(new Vec2(0, 0), 0.22, Infinity);
    const link = new PulleyLink(a, b, wheel);
    link.mu = 10;
    const world = worldWith(a, b, wheel);
    world.links.push(link);
    const cam = new Camera(800, 600);
    const noTrails = new ViewSettings();
    noTrails.grid = false;
    const pointer = cam.toScreen(a.pos);
    const disabled = recCtx();
    drawWorld(disabled.ctx, cam, world, noTrails, [], null,
      new Map(), 800, 600, 1, false, false, pointer);
    expect(disabled.ops.some((op) =>
      op.op === "stroke" && op.style === css(WARN))).toBe(false);

    link.showTensionVectors = true;
    const { ctx, ops } = recCtx();

    drawWorld(ctx, cam, world, noTrails, [], null,
      new Map(), 800, 600, 1, false, false, pointer);

    const warningStroke = ops.findIndex((op) =>
      op.op === "stroke" && op.style === css(WARN));
    expect(warningStroke).toBeGreaterThan(0);
    let groupStart = warningStroke - 1;
    while (groupStart >= 0 && ops[groupStart].op !== "stroke" &&
           ops[groupStart].op !== "fill") groupStart--;
    const shafts = ops.slice(groupStart + 1, warningStroke)
      .filter((op) => op.op === "lineTo");
    expect(shafts).toHaveLength(4);
    expect(ops.filter((op) => op.op === "fillText").map((op) => op.text))
      .toEqual([expect.stringContaining("F ="), expect.stringContaining("⎣")]);
  });

  it("retains sub-four-pixel link-force arrows only in Normal mode", () => {
    const a = new Body(new Vec2(-1, 0), 0.12, 1);
    const b = new Body(new Vec2(1, 0), 0.12, 1);
    const spring = new SpringLink(a, b, 2, 1);
    spring.axialForce = 0.15;
    spring.showTensionVectors = true;
    const world = worldWith(a, b);
    world.links.push(spring);
    const cam = new Camera(800, 600);
    cam.zoom = 100;
    const analytical = new ViewSettings();
    analytical.grid = false;

    const normal = recCtx();
    drawWorld(normal.ctx, cam, world, analytical, [], null,
      new Map(), 800, 600);
    expect(normal.ops.some((op) =>
      op.op === "stroke" && op.style === css(WARN))).toBe(true);

    const performance = recCtx();
    drawWorld(performance.ctx, cam, world, analytical, [], null,
      new Map(), 800, 600, 1, true);
    expect(performance.ops.some((op) =>
      op.op === "stroke" && op.style === css(WARN))).toBe(false);
  });
});

describe("trail rendering", () => {
  it("does not draw trail geometry in Performance mode", () => {
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    const t = new Trail(20);
    for (let i = 0; i < 20; i++) t.push(i * 0.02, Math.sin(i * 0.1));
    const { ctx, ops } = recCtx();

    drawWorld(ctx, new Camera(800, 600), worldWith(b), view(), [], null,
              new Map([[b.id, t]]), 800, 600, 1, true);

    expect(ops.filter((op) => op.op === "lineTo" ||
      op.op === "quadraticCurveTo")).toHaveLength(0);
  });

  it("renders a visible trail as a connected, faded polyline", () => {
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    const t = new Trail(400);
    for (let i = 0; i < 300; i++) t.push(i * 0.01 - 1.5, Math.sin(i * 0.05));
    const trails = new Map([[b.id, t]]);
    const { ctx, ops } = recCtx();
    const cam = new Camera(800, 600);
    drawWorld(ctx, cam, worldWith(b), view(), [], null, trails, 800, 600);

    const moveTos = ops.filter((o) => o.op === "moveTo").length;
    const segs = ops.filter((o) => o.op === "lineTo" ||
                                   o.op === "quadraticCurveTo").length;
    const strokes = trailStrokes(ops).length;
    expect(strokes).toBeGreaterThan(1);          // multiple gradient bands
    expect(segs).toBeGreaterThan(moveTos);       // real paths, not dots
    // bands connect: consecutive bands share their boundary vertex
    const distinctStyles = new Set(trailStrokes(ops).map((o) => o.style));
    expect(distinctStyles.size).toBeGreaterThan(1); // it actually fades
  });

  it("culls trails whose bounding box is entirely off-screen", () => {
    const onId = 1, offId = 2;
    const onT = new Trail(50);
    for (let i = 0; i < 50; i++) onT.push(i * 0.02 - 0.5, 0); // near origin: visible
    const offT = new Trail(50);
    for (let i = 0; i < 50; i++) offT.push(1000 + i, 1000); // far away: off-screen
    const trails = new Map([[onId, onT], [offId, offT]]);
    const bodies = [new Body(new Vec2(0, 0), 0.1, 1), new Body(new Vec2(1000, 1000), 0.1, 1)];
    bodies[0].id = onId; bodies[1].id = offId;
    const { ctx, ops } = recCtx();
    const cam = new Camera(800, 600);
    drawWorld(ctx, cam, worldWith(...bodies), view(), [], null, trails, 800, 600);
    // every recorded vertex must be for the on-screen trail (roughly within
    // a screen of the viewport); nothing near the off-screen 1000,1000 world
    const verts = ops.filter((o) => o.op === "moveTo" || o.op === "lineTo" || o.op === "quadraticCurveTo");
    const offScreenVerts = verts.filter((o) => (o.x ?? 0) > 2000 || (o.y ?? 0) > 2000
      || (o.x ?? 0) < -2000 || (o.y ?? 0) < -2000);
    expect(offScreenVerts.length).toBe(0);
    expect(verts.length).toBeGreaterThan(0); // the visible one still drew
  });

  it("bounds the total stroke count however many trails there are", () => {
    // A stroke costs roughly the same whatever geometry it carries, so the
    // frame cost is set by the NUMBER of strokes. Trails sharing a colour
    // are stroked together, one stroke per band for the whole set, so the
    // count tracks the number of distinct colours - not the number of
    // trails. 300 trails must not cost 300 times what one does.
    const drawN = (numTrails: number): { strokes: number; verts: number } => {
      const trails = new Map<number, Trail>();
      const world = new World();
      for (let n = 0; n < numTrails; n++) {
        const b = new Body(new Vec2(0, 0), 0.1, 1);
        world.bodies.push(b);
        const t = new Trail(200);
        for (let i = 0; i < 200; i++) t.push(i * 0.01 - 1, Math.sin(i * 0.1));
        trails.set(b.id, t);
      }
      const { ctx, ops } = recCtx();
      drawWorld(ctx, new Camera(800, 600), world, view(), [], null, trails, 800, 600);
      return {
        strokes: trailStrokes(ops).length,
        verts: ops.filter((o) => o.op === "quadraticCurveTo").length,
      };
    };
    const one = drawN(1);
    const many = drawN(300);
    expect(one.strokes).toBeGreaterThan(1);         // it really is banded
    // 300x the trails for well under 30x the strokes (the palette gives
    // them ten distinct colours, so ten groups rather than three hundred)
    expect(many.strokes).toBeLessThan(one.strokes * 30);
    // and every one of them still drew
    expect(many.verts).toBeGreaterThan(one.verts * 50);
  });

  it("decimates very long trails to a bounded vertex count", () => {
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    const t = new Trail(10000);
    for (let i = 0; i < 10000; i++) t.push((i / 10000) * 4 - 2, Math.sin(i * 0.01));
    const trails = new Map([[b.id, t]]);
    const { ctx, ops } = recCtx();
    drawWorld(ctx, new Camera(800, 600), worldWith(b), view(), [], null, trails, 800, 600);
    const verts = ops.filter((o) => o.op === "moveTo" || o.op === "lineTo" || o.op === "quadraticCurveTo").length;
    // 10k points must not become 10k segments; the per-trail vertex
    // ceiling caps it well below the raw count
    expect(verts).toBeLessThan(6000);
    expect(verts).toBeGreaterThan(50); // still a detailed curve
  });

  it("keeps the drawn path stable as the trail scrolls (no shimmer)", () => {
    // Decimation must select the same physical points as the ring
    // scrolls. Keying it on the ring index re-picks a different subset
    // every frame, which reads as the trail warping in place.
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    const t = new Trail(4000);
    const pt = (i: number): [number, number] =>
      [Math.cos(i * 0.002) * 1.5, Math.sin(i * 0.002) * 1.5];
    for (let i = 0; i < 4000; i++) t.push(...pt(i));
    const cam = new Camera(800, 600);
    const draw = (): Array<[number, number]> => {
      const { ctx, ops } = recCtx();
      drawWorld(ctx, cam, worldWith(b), view(), [], null,
                new Map([[b.id, t]]), 800, 600);
      return ops.filter((o) => o.op === "quadraticCurveTo")
                .map((o) => [o.x ?? 0, o.y ?? 0]);
    };
    const before = draw();
    // scroll the ring by a whole stride's worth of new points
    for (let i = 4000; i < 4000 + 12; i++) t.push(...pt(i));
    const after = draw();
    // the overlapping tail of the two frames must contain the same
    // vertices (shifted), not a freshly re-sampled set
    const keyOf = (p: [number, number]): string =>
      `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
    const beforeKeys = new Set(before.map(keyOf));
    const shared = after.filter((p) => beforeKeys.has(keyOf(p))).length;
    expect(shared).toBeGreaterThan(after.length * 0.85);
  });
});

/** The specific rendering defects behind "it glitches between the sharp
 * turns and the smooth curve drawn between them". */
describe("trail curve fidelity", () => {
  /** Every drawn vertex, in order, for one trail. */
  const vertsOf = (t: Trail, b: Body, cam = new Camera(800, 600),
                   quality = 1): Array<[number, number]> => {
    const { ctx, ops } = recCtx();
    drawWorld(ctx, cam, worldWith(b), view(), [], null,
              new Map([[b.id, t]]), 800, 600, quality);
    return ops.filter((o) => o.op === "moveTo" || o.op === "lineTo" ||
                             o.op === "quadraticCurveTo")
              .map((o) => [o.x ?? 0, o.y ?? 0]);
  };

  it("draws no straight chord where the rest of the line curves", () => {
    // Bands used to be cut on RAW indices while decimation was applied
    // separately, so a band could retain no points at all and fall back to
    // a single lineTo spanning it - a straight chord sitting between two
    // smoothly curved neighbours, in a different place every frame.
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    const t = new Trail(6000);
    for (let i = 0; i < 6000; i++) {
      t.push(Math.cos(i * 0.001) * 1.5, Math.sin(i * 0.001) * 1.5);
    }
    const { ctx, ops } = recCtx();
    drawWorld(ctx, new Camera(800, 600), worldWith(b), view(), [], null,
              new Map([[b.id, t]]), 800, 600);
    const curves = ops.filter((o) => o.op === "quadraticCurveTo").length;
    const lines = ops.filter((o) => o.op === "lineTo").length;
    const strokes = ops.filter((o) => o.op === "stroke").length;
    expect(strokes).toBeGreaterThan(4);   // it really is banded
    expect(curves).toBeGreaterThan(100);  // and really is curved
    // a smooth circle has no corners, so the only lineTo is the final
    // segment of each trail - never one per band
    expect(lines).toBeLessThan(strokes);
  });

  it("cuts every colour band on the curve, never across it", () => {
    // Each band is its own stroke, so a band boundary is a moveTo. That
    // moveTo has to land exactly on the point the previous band finished
    // at - a point that lies ON the curve - or the colour cut introduces a
    // kink whose position drifts along the line as the trail scrolls.
    // Every band must also actually be curved: bands used to be cut on raw
    // indices while decimation ran separately, so a band could retain no
    // points and degenerate into one straight chord.
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    const t = new Trail(4000);
    for (let i = 0; i < 4000; i++) {
      t.push(Math.cos(i * 0.0015) * 1.5, Math.sin(i * 0.0015) * 1.5);
    }
    const { ctx, ops } = recCtx();
    drawWorld(ctx, new Camera(800, 600), worldWith(b), view(), [], null,
              new Map([[b.id, t]]), 800, 600);

    // split the op stream into sub-paths, one per stroke, then keep the
    // trail's. Quadratic curves identify them: trails are the only thing
    // drawn with them - links are straight, bodies are arcs - and links and
    // bodies now batch by style, so their geometry shares the stream.
    const allPaths: Op[][] = [];
    let cur: Op[] = [];
    for (const o of ops) {
      if (o.op === "stroke") { allPaths.push(cur); cur = []; }
      else cur.push(o);
    }
    const paths = allPaths.filter((p) => p.some((o) => o.op === "quadraticCurveTo"));
    expect(paths.length).toBeGreaterThan(4); // genuinely banded

    let joins = 0;
    for (let i = 1; i < paths.length; i++) {
      const prev = paths[i - 1];
      const here = paths[i];
      if (prev.length === 0 || here.length === 0) continue;
      const tail = prev[prev.length - 1];
      const head = here[0];
      expect(head.op).toBe("moveTo");
      expect(head.x).toBeCloseTo(tail.x ?? 0, 6); // seamless, and on-curve
      expect(head.y).toBeCloseTo(tail.y ?? 0, 6);
      joins++;
      // a smooth circle: every band carries real curvature, no bare chords
      expect(here.some((o) => o.op === "quadraticCurveTo")).toBe(true);
    }
    expect(joins).toBeGreaterThan(3);
  });

  it("keeps a genuine sharp corner instead of rounding it off", () => {
    // a bounce: straight in, straight back out at a right angle
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    const t = new Trail(200);
    for (let i = 0; i < 50; i++) t.push(-1 + i * 0.02, 0);   // travel +x
    for (let i = 0; i < 50; i++) t.push(0, i * 0.02);        // turn to +y
    const cam = new Camera(800, 600);
    const verts = vertsOf(t, b, cam);
    // the corner itself must be one of the drawn vertices; a midpoint-only
    // curve cuts it off and never touches the actual turning point
    const [cx, cy] = cam.toScreenXY(0, 0);
    const hit = verts.some(([x, y]) =>
      Math.abs(x - cx) < 0.51 && Math.abs(y - cy) < 0.51);
    expect(hit).toBe(true);
  });

  it("spends a larger vertex budget when quality is raised", () => {
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    const t = new Trail(8000);
    for (let i = 0; i < 8000; i++) {
      t.push(Math.cos(i * 0.0008) * 1.5, Math.sin(i * 0.0008) * 1.5);
    }
    const cam = new Camera(800, 600);
    const lean = vertsOf(t, b, cam, 0.35).length;
    const rich = vertsOf(t, b, cam, 4.0).length;
    expect(rich).toBeGreaterThan(lean * 1.5);
    // detail is bought from the samples that exist, never invented: even
    // an unlimited budget draws at most one vertex per recorded point
    // (plus one moveTo and one closing lineTo per colour band)
    expect(rich).toBeLessThanOrEqual(8000 + 2 * 24);
    expect(lean).toBeLessThan(8000);
  });

  it("nests the retained points as the budget changes", () => {
    // Power-of-two strides mean a change in budget adds or removes points
    // rather than reshuffling which ones are drawn - an arbitrary stride
    // re-picks the whole set and the line twitches.
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    const t = new Trail(4000);
    for (let i = 0; i < 4000; i++) {
      t.push(Math.cos(i * 0.0015) * 1.5, Math.sin(i * 0.0015) * 1.5);
    }
    const cam = new Camera(800, 600);
    // Compare CONTROL points, which are the retained samples themselves.
    // The drawn endpoints are midpoints between consecutive retained
    // points, so they necessarily move when the stride does even though
    // the underlying selection is nested.
    const controls = (quality: number): Set<string> => {
      const { ctx, ops } = recCtx();
      drawWorld(ctx, cam, worldWith(b), view(), [], null,
                new Map([[b.id, t]]), 800, 600, quality);
      return new Set(ops.filter((o) => o.op === "quadraticCurveTo")
        .map((o) => `${(o.cx ?? 0).toFixed(2)},${(o.cy ?? 0).toFixed(2)}`));
    };
    const coarse = controls(0.5);
    const fine = controls(2.0);
    expect(fine.size).toBeGreaterThan(coarse.size);
    // nearly every point the coarse pass drew is still drawn by the fine
    // one: raising the budget ADDS detail rather than re-picking it
    const kept = [...coarse].filter((k) => fine.has(k)).length;
    expect(kept).toBeGreaterThan(coarse.size * 0.9);
  });
});


describe("short trail fade coverage", () => {
  it.each(THEME_NAMES.flatMap(name => [3, 4, 7, 10, 25, 100].map(count => [name, count] as const)))(
    "uses the recent-end colour in %s with %s samples", (name, count) => {
    setTheme(name);
    const body = new Body(new Vec2(1000, 1000), 0.1, 1);
    body.color = [50, 170, 150];
    const trail = new Trail(count);
    for (let k = 0; k < count; k++) trail.push(-1 + 2 * k / (count - 1), 0, k / 100);
    const cam = new Camera(800, 600), { ctx, ops } = recCtx();
    drawWorld(ctx, cam, worldWith(body), view(), [], null, new Map([[body.id, trail]]), 800, 600);
    const [x, y] = cam.toScreen(new Vec2(1, 0));
    const end = ops.find(op => op.op === "lineTo" && op.x === x && op.y === y)!;
    const colour = (end.style?.match(/\d+/g) ?? []).map(Number);
    expect(colour).toHaveLength(3);
    // The most recent position must reach the coloured end of the fade,
    // including when there are fewer samples than available colour bands.
    expect(Math.max(...colour.map((value, k) => Math.abs(value - body.color[k])))).toBeLessThanOrEqual(5);
    expect(trail.count).toBe(count); expect(trail.x(count - 1)).toBe(1);
    setTheme("dark");
  });
});


describe("adaptive slack strings", () => {
  function scene(kind: "rope" | "elastic" | "pulley", extra: number) {
    const a = new Body(new Vec2(-1, 0)), b = new Body(new Vec2(1, 0)), world = worldWith(a, b);
    let link: DistanceLink | SpringLink | PulleyLink;
    if (kind === "pulley") {
      const wheel = new Body(new Vec2(0, 1)); world.bodies.push(wheel);
      link = new PulleyLink(a, b, wheel); link.length += extra;
    } else if (kind === "elastic") link = new SpringLink(a, b, 2 + extra, 20, 0, true);
    else link = new DistanceLink(a, b, 2 + extra, true);
    world.links.push(link); return { world, link };
  }
  const kinds = ["rope", "elastic", "pulley"] as const;

  it.each(kinds)("adds stable increasing curvature to a %s without altering physical state", kind => {
    const { world, link } = scene(kind, 0), cam = new Camera(800, 600); cam.zoom = 100;
    let previous = 0;
    for (const extra of [0.005, 0.03, 0.2]) {
      if (link instanceof SpringLink) link.restLength = 2 + extra;
      else link.length = (link instanceof PulleyLink ? link.currentLength() : 2) + extra;
      const before = snapshot(world), normal = recCtx(), repeated = recCtx();
      drawWorld(normal.ctx, cam, world, new ViewSettings(), [], null, new Map(), 800, 600);
      drawWorld(repeated.ctx, cam, world, new ViewSettings(), [], null, new Map(), 800, 600);
      expect(snapshot(world)).toBe(before); expect(repeated.ops).toEqual(normal.ops);
      const curves = normal.ops.filter(op => op.op === "quadraticCurveTo" && op.style === "rgb(140,125,100)");
      expect(curves).toHaveLength(kind === "pulley" ? 2 : 1);
      // With these fixed horizontal/angled endpoints, increased excess moves
      // the control further from the taut segment. No solver quantity changes.
      const magnitude = kind === "pulley" ? Math.abs(curves[0].cx! - 400) : curves[0].cy! - 300;
      expect(magnitude).toBeGreaterThan(previous); previous = magnitude;
    }
  });

  it.each(kinds)("leaves a taut %s straight", kind => {
    const { world } = scene(kind, 0), recorder = recCtx();
    drawWorld(recorder.ctx, new Camera(800, 600), world, new ViewSettings(), [], null, new Map(), 800, 600);
    expect(recorder.ops.some(op => op.op === "quadraticCurveTo")).toBe(false);
  });

  it.each([false, true])("draws a released slack pulley as one string (performance=%s)", performance => {
    const angleA = -0.1, angleB = angleA - 2 * Math.acos(0.22 / 2) - 1e-5;
    const a = new Body(new Vec2(2 * Math.cos(angleA), 2 * Math.sin(angleA))),
      b = new Body(new Vec2(2 * Math.cos(angleB), 2 * Math.sin(angleB))),
      wheel = new Body(new Vec2()), link = new PulleyLink(a, b, wheel), world = worldWith(a, b, wheel);
    a.pos.set(-2, -0.5); b.pos.set(2, -0.5); link.captureSafePositions();
    link.length = link.currentLength() + 0.2; world.links.push(link);
    expect(link.geometry().wrapped).toBe(false);
    const recorder = recCtx(), before = snapshot(world);
    drawWorld(recorder.ctx, new Camera(800, 600), world, new ViewSettings(), [], null,
      new Map(), 800, 600, 1, performance);
    expect(recorder.ops.filter(op => op.op === "quadraticCurveTo")).toHaveLength(performance ? 0 : 1);
    expect(snapshot(world)).toBe(before);
  });

  it.each([0, 1, 2, 3])("omits all slack-curve work in actual Performance profile %s", level => {
    for (const kind of kinds) {
      const { world } = scene(kind, 0.5); world.performance = true; world.performanceLevel = level;
      const recorder = recCtx();
      drawWorld(recorder.ctx, new Camera(800, 600), world, new ViewSettings(), [], null,
        new Map(), 800, 600, 1, true, level === 3);
      expect(recorder.ops.some(op => op.op === "quadraticCurveTo")).toBe(false);
      expect(recorder.ops.some(op => op.op === "lineTo" && op.style === "rgb(140,125,100)")).toBe(true);
    }
  });

  it("retains a visible slack bow when both endpoints lie outside the viewport", () => {
    const a = new Body(new Vec2(-1, 1.7)), b = new Body(new Vec2(1, 1.7)), world = worldWith(a, b);
    world.links.push(new DistanceLink(a, b, 2.2, true));
    const cam = new Camera(400, 300); cam.zoom = 100; const recorder = recCtx();
    drawWorld(recorder.ctx, cam, world, new ViewSettings(), [], null, new Map(), 400, 300);
    const q = recorder.ops.find(op => op.op === "quadraticCurveTo" && op.style === "rgb(140,125,100)")!;
    expect(q).toBeDefined(); expect((-20 + 2 * q.cy! - 20) / 4).toBeGreaterThan(0);
  });

  it.each([false, true])("retains the wrapped wheel arc at the viewport edge (simplify=%s)", simplify => {
    const a = new Body(new Vec2(-2.6, -0.5)), b = new Body(new Vec2(-2.6, 0.5)),
      wheel = new Body(new Vec2(-2.21, 0)), world = worldWith(a, b, wheel);
    const link = new PulleyLink(a, b, wheel); link.wrapTurns = 1; link.length = link.currentLength();
    world.links.push(link); const cam = new Camera(400, 300); cam.zoom = 100; const recorder = recCtx();
    expect(link.geometry().wrapped).toBe(true);
    drawWorld(recorder.ctx, cam, world, new ViewSettings(), [], null, new Map(), 400, 300, 1, simplify);
    expect(recorder.ops.some(op => op.op === "arc" && op.style === "rgb(170,150,115)")).toBe(true);
  });
});
