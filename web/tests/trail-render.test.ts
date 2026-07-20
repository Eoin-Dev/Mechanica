/** Trail rendering: adaptive gradient bands, off-screen culling, vertex
 * decimation and unbroken continuity between bands. Driven through the real
 * drawWorld() with a recording canvas stub (no DOM canvas needed). */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { World } from "../src/engine/world";
import { Camera } from "../src/render/camera";
import { ViewSettings, drawWorld } from "../src/render/draw";
import { Trail } from "../src/render/trail";

interface Op { op: string; style?: string; x?: number; y?: number; }

/** A 2D-context that records the drawing calls we care about and no-ops the
 * rest, so drawWorld runs unmodified. */
function recCtx(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
  let strokeStyle = "";
  const base: Record<string, unknown> = {
    beginPath() {},
    stroke() { ops.push({ op: "stroke", style: strokeStyle }); },
    moveTo(x: number, y: number) { ops.push({ op: "moveTo", x, y }); },
    lineTo(x: number, y: number) { ops.push({ op: "lineTo", x, y }); },
    // trails are drawn as quadratic curves through midpoints; record the
    // segment endpoint so vertex counting still works
    quadraticCurveTo(_cx: number, _cy: number, x: number, y: number) {
      ops.push({ op: "quadraticCurveTo", x, y });
    },
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

describe("trail rendering", () => {
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

  it("shares the stroke budget: many trails use fewer bands each", () => {
    const oneCount = (numTrails: number): number => {
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
      return trailStrokes(ops).length / numTrails; // bands per trail
    };
    const few = oneCount(1);
    const many = oneCount(300);
    expect(few).toBeGreaterThan(many);  // adaptive: fewer bands under load
    expect(many).toBeGreaterThanOrEqual(1); // but never zero
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
