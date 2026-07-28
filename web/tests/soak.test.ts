/** @vitest-environment jsdom */
/** Long runs: what grows, and what drifts.
 *
 * Everything else here measures a second or two of simulated time. The way
 * this app is actually used is a scene left running while someone watches
 * it, which is a different question: over minutes, does anything accumulate
 * that is never released, and does the answer stay the answer?
 *
 * Both failure modes are invisible in short tests by construction. A cache
 * keyed by body id looks fine until enough ids have existed; a rewind buffer
 * looks fine until it has had time to fill; energy drift of 0.01% per second
 * looks like nothing until it has had a thousand seconds to compound.
 */
import { describe, expect, it } from "vitest";
import { App, PHYSICS_DT } from "../src/app";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { DistanceLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";
import { RewindBuffer, UndoStack, snapshot } from "../src/scene/snapshot";

function stubCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: 600, configurable: true });
  canvas.getContext = (() => ({
    setTransform() {}, fillRect() {}, clearRect() {}, save() {}, restore() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {},
    closePath() {}, measureText: () => ({ width: 10 }), fillText() {},
    translate() {}, rotate() {}, scale() {}, setLineDash() {}, clip() {},
    quadraticCurveTo() {},
  })) as unknown as HTMLCanvasElement["getContext"];
  return canvas;
}

function makeApp(): App {
  document.body.replaceChildren();
  const canvas = stubCanvas();
  document.body.append(canvas);
  return new App(canvas);
}

describe("nothing grows without bound", () => {
  it("the rewind buffer stays inside its own frame and byte budgets", () => {
    const buf = new RewindBuffer();
    const w = PRESETS.find((p) => p.name === "Jelly block")!.build();
    for (let i = 0; i < RewindBuffer.MAX_FRAMES + 800; i++) {
      w.step(PHYSICS_DT);
      buf.push(w);
    }
    expect(buf.length).toBeLessThanOrEqual(RewindBuffer.MAX_FRAMES);
    // and it can still rewind after all that churn
    expect(buf.back()).not.toBeNull();
  });

  it("the rewind buffer reclaims keyframes when the scene keeps changing", () => {
    // every structural change writes a new full snapshot; if those were
    // never released the buffer would hold one per edit for the session
    const buf = new RewindBuffer();
    const w = new World();
    for (let i = 0; i < 1500; i++) {
      if (i % 3 === 0) w.bodies.push(new Body(new Vec2(i * 0.01, 0), 0.1, 1));
      if (i % 7 === 0 && w.bodies.length > 0) w.bodies.pop();
      w.step(PHYSICS_DT);
      buf.push(w);
    }
    expect(buf.length).toBeLessThanOrEqual(RewindBuffer.MAX_FRAMES);
  });

  it("the undo stack never exceeds its limit however many edits happen", () => {
    const w = new World();
    const stack = new UndoStack(w);
    for (let i = 0; i < UndoStack.LIMIT * 4; i++) {
      w.bodies.push(new Body(new Vec2(i, 0), 0.1, 1));
      stack.push(w);
    }
    let depth = 0;
    while (stack.canUndo && depth < 10_000) {
      stack.undo();
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(UndoStack.LIMIT);
  });

  it("trail buffers are released when their bodies are culled", () => {
    // ids are never reused, so a trail map that is not swept keeps one
    // buffer per body that has EVER existed - megabytes in a debris scene
    const app = makeApp();
    app.view.trails = true;
    app.world.gravity = 0;
    for (let round = 0; round < 25; round++) {
      for (let i = 0; i < 8; i++) {
        app.world.bodies.push(new Body(new Vec2(i * 0.4 - 1.5, round), 0.1, 1));
      }
      for (let s = 0; s < 6; s++) app.stepOnce();
      app.world.bodies.length = 0; // everything vanishes at once
      for (let s = 0; s < 3; s++) app.stepOnce();
    }
    expect(app.trails.size).toBeLessThanOrEqual(8);
  });

  it("plot series stay inside their retention window over a long run", () => {
    const app = makeApp();
    app.world.bodies.push(new Body(new Vec2(0, 4), 0.2, 1));
    app.ensureInitial();
    app.setGraphMode("Energy");
    for (let i = 0; i < 12_000; i++) app.stepOnce();
    for (const series of [app.energySeries, app.momentumSeries]) {
      expect(series.count).toBeLessThanOrEqual(11_000);
      const span = series.lastT - series.firstT;
      expect(span).toBeLessThanOrEqual(130); // GRAPH_HISTORY_S plus slack
    }
  });

  it("the contact warm-start cache does not accumulate dead pairs", () => {
    // keyed by body-pair id; bodies come and go constantly in a debris scene
    const w = new World();
    w.walls.push(new Wall(new Vec2(-6, 0), new Vec2(6, 0), 0.2));
    const cacheSize = (): number => {
      const c = (w as unknown as { contactCache: Map<string, number[]> }).contactCache;
      return c.size;
    };
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 6; i++) {
        w.bodies.push(new Body(new Vec2(i * 0.5 - 1.5, 1 + i * 0.5), 0.2, 1));
      }
      for (let s = 0; s < 30; s++) w.step(PHYSICS_DT);
      w.bodies.length = 0;
      w.step(PHYSICS_DT);
    }
    expect(cacheSize()).toBeLessThan(50);
  });

  it("the world's per-step scratch does not grow with history", () => {
    // the trace anchors are keyed by body id and pruned against the live set
    const w = new World();
    w.traceSpacing = 0.01;
    for (let round = 0; round < 60; round++) {
      w.bodies.push(new Body(new Vec2(round * 0.1, 0), 0.1, 1));
      for (let s = 0; s < 5; s++) {
        w.step(PHYSICS_DT);
        w.trace.length = 0;
      }
      if (round % 2 === 0) w.bodies.shift();
    }
    const traceLast = (w as unknown as { traceLast: Map<number, unknown> }).traceLast;
    expect(traceLast.size).toBeLessThanOrEqual(w.bodies.length * 2 + 20);
  });
});

describe("long-run numerical behaviour", () => {
  it("a circular orbit keeps its radius over 2000 seconds", () => {
    // a symplectic integrator should not spiral; a bug in the force or the
    // integrator shows as a slow, monotone drift that only time reveals
    const w = new World();
    w.gravity = 0;
    w.mutualGravity = true;
    w.G = 1;
    w.softening = 0;
    w.substeps = 8;
    const sun = new Body(new Vec2(0, 0), 0.1, 1000);
    sun.locked = true;
    const r = 5;
    const planet = new Body(new Vec2(r, 0), 0.05, 1e-6);
    planet.vel.set(0, Math.sqrt(1000 / r)); // circular speed for G=1
    w.bodies.push(sun, planet);

    let minR = Infinity;
    let maxR = -Infinity;
    const steps = Math.round(2000 / PHYSICS_DT);
    for (let i = 0; i < steps; i++) {
      w.step(PHYSICS_DT);
      if (i % 50 === 0) {
        const d = planet.pos.length();
        if (d < minR) minR = d;
        if (d > maxR) maxR = d;
      }
    }
    expect(Number.isFinite(planet.pos.x)).toBe(true);
    expect((maxR - minR) / r).toBeLessThan(0.02); // under 2% breathing
  });

  it("a pendulum's energy does not creep over 1000 seconds", () => {
    const w = new World();
    w.substeps = 8;
    const pivot = new Body(new Vec2(0, 0), 0.05, 1);
    pivot.isAnchor = true;
    pivot.locked = true;
    const bob = new Body(new Vec2(1, 0), 0.05, 1);
    bob.collides = false;
    w.bodies.push(pivot, bob);
    w.links.push(new DistanceLink(pivot, bob, 1));
    const e0 = w.energy().total;
    for (let i = 0; i < Math.round(1000 / PHYSICS_DT); i++) w.step(PHYSICS_DT);
    const drift = Math.abs(w.energy().total - e0) / Math.abs(e0 || 1);
    expect(drift).toBeLessThan(0.02);
  });

  it("a resting stack stays exactly at rest for a long time", () => {
    // creep is the classic long-run contact bug: invisible per step,
    // obvious after a minute
    const w = new World();
    w.substeps = 8;
    w.walls.push(new Wall(new Vec2(-10, 0), new Vec2(10, 0), 0.2));
    for (let i = 0; i < 5; i++) {
      const b = new Body(new Vec2(0, 0.35 + i * 0.42), 0.2, 1);
      b.friction = 0.6;
      b.restitution = 0.1;
      w.bodies.push(b);
    }
    for (let i = 0; i < Math.round(3 / PHYSICS_DT); i++) w.step(PHYSICS_DT); // settle
    const settled = w.bodies.map((b) => b.pos.copy());
    for (let i = 0; i < Math.round(60 / PHYSICS_DT); i++) w.step(PHYSICS_DT);
    for (let i = 0; i < w.bodies.length; i++) {
      expect(w.bodies[i].pos.distTo(settled[i]),
             `body ${i} crept`).toBeLessThan(0.01);
    }
  });

  it("a snapshot of a long-running scene stays a sane size", () => {
    const w = PRESETS.find((p) => p.name === "Gas in a box (50)")!.build();
    const before = snapshot(w).length;
    for (let i = 0; i < Math.round(120 / PHYSICS_DT); i++) w.step(PHYSICS_DT);
    const after = snapshot(w).length;
    // the scene has the same objects, so its serialized size must not have
    // wandered (a leak into a serialized field would show here)
    expect(after).toBeLessThan(before * 1.6);
  });
});
