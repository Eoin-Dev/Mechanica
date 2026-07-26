/** Performance mode: cheap everywhere, and invisible to saved scenes.
 *
 * It is not a second solver. Every lever it pulls already existed - the
 * integrator, the substep count, the solver iterations, the adaptive
 * machinery - and the mode's only job is to pull them together and to stay
 * strictly out of the scene's own data while doing it. The scene keeps the
 * settings it was authored with; the mode overrides them for the duration of
 * a step and nothing else.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { SpringLink } from "../src/engine/links";
import {
  PERF_ITERATIONS, PERF_SUBSTEPS, World, WorldDict,
} from "../src/engine/world";

const DT = 1 / 120;

/** A scene authored with expensive settings, so overriding them shows. */
function authored(): World {
  const w = new World();
  w.substeps = 16;
  w.iterations = 32;
  w.integrator = "RK4";
  const a = new Body(new Vec2(0, 1), 0.1, 1.0);
  const b = new Body(new Vec2(0, 0), 0.1, 1.0);
  w.bodies.push(a, b);
  w.links.push(new SpringLink(a, b, 1.0, 50, 1));
  return w;
}

/** Bodies piled into mutual contact on a floor - the load the mode is for. */
function pile(n: number): World {
  const w = new World();
  w.substeps = 8;
  w.iterations = 16;
  const floor = new Wall(new Vec2(-6, 0), new Vec2(6, 0), 0.2);
  floor.friction = 0.6;
  floor.restitution = 0.1;
  w.walls.push(floor);
  for (let i = 0; i < n; i++) {
    const b = new Body(new Vec2(-3 + (i % 30) * 0.2, 0.3 + Math.floor(i / 30) * 0.2),
                       0.09, 0.5);
    b.restitution = 0.1;
    b.friction = 0.6;
    w.bodies.push(b);
  }
  return w;
}

describe("effective solver settings", () => {
  it("leaves everything alone when the mode is off", () => {
    const w = authored();
    expect(w.performance).toBe(false); // off by default
    expect(w.effectiveSubsteps).toBe(16);
    expect(w.effectiveIterations).toBe(32);
    expect(w.effectiveIntegrator).toBe("RK4");
  });

  it("caps substeps, iterations and the integrator when on", () => {
    const w = authored();
    w.performance = true;
    expect(w.effectiveSubsteps).toBe(PERF_SUBSTEPS);
    expect(w.effectiveIterations).toBe(PERF_ITERATIONS);
    expect(w.effectiveIntegrator).toBe("Symplectic Euler");
  });

  it("caps rather than raises: a cheaper scene stays cheaper", () => {
    const w = new World();
    w.substeps = 1;
    w.iterations = 2;
    w.performance = true;
    expect(w.effectiveSubsteps).toBe(1);
    expect(w.effectiveIterations).toBe(2);
  });

  it("never lets substeps reach zero", () => {
    const w = new World();
    w.substeps = 0; // a hand-edited scene; step() must still advance
    w.performance = true;
    expect(w.effectiveSubsteps).toBeGreaterThanOrEqual(1);
  });
});

describe("the scene's own data is untouched", () => {
  it("does not rewrite the authored settings", () => {
    const w = authored();
    w.performance = true;
    for (let i = 0; i < 120; i++) w.step(DT);
    // what the inspector shows and what a save writes
    expect(w.substeps).toBe(16);
    expect(w.iterations).toBe(32);
    expect(w.integrator).toBe("RK4");
  });

  it("is absent from the serialized scene", () => {
    const w = authored();
    w.performance = true;
    const dict = w.toDict() as WorldDict & { settings: Record<string, unknown> };
    expect("performance" in dict.settings).toBe(false);
    expect(JSON.stringify(dict)).not.toContain("performance");
    // and the authored settings are what round-trip
    const back = World.fromDict(JSON.parse(JSON.stringify(dict)));
    expect(back.substeps).toBe(16);
    expect(back.iterations).toBe(32);
    expect(back.integrator).toBe("RK4");
  });

  it("loads a scene with the mode off, whatever the file says", () => {
    // a shared scene must never impose the mode on whoever opens it
    const back = World.fromDict({
      settings: { substeps: 8, performance: true },
    } as never);
    expect(back.performance).toBe(false);
  });
});

describe("it actually steps, and cheaply", () => {
  it("advances the clock the same amount", () => {
    for (const perf of [false, true]) {
      const w = authored();
      w.performance = perf;
      for (let i = 0; i < 120; i++) w.step(DT);
      expect(w.time).toBeCloseTo(1.0, 9);
    }
  });

  it("keeps a piled scene finite and settled", () => {
    const w = pile(120);
    w.performance = true;
    for (let i = 0; i < 600; i++) w.step(DT);
    expect(w.diverged).toEqual([]);
    for (const b of w.bodies) {
      expect(Number.isFinite(b.pos.x + b.pos.y + b.vel.x + b.vel.y)).toBe(true);
      expect(b.pos.y).toBeGreaterThan(-0.5); // nothing fell through the floor
    }
  });

  it("does no more solver work than the caps allow", () => {
    // A structural check rather than a timed one: count force evaluations by
    // counting how often a custom field is asked for a value. Euler evaluates
    // once per substep where Verlet does twice and RK4 four times, so the
    // product with the substep cap is the whole cost story.
    const evals = (perf: boolean): number => {
      const w = authored();
      w.performance = perf;
      let n = 0;
      // a field is evaluated once per body per force evaluation
      w.fields.push({
        name: "count", fxSrc: "0", fySrc: "0", enabled: true, error: "",
        fx: () => { n++; return 0; },
        fy: () => 0,
        compile: () => true,
        toDict: () => ({ name: "count", fx: "0", fy: "0", enabled: true }),
      } as never);
      w.step(DT);
      return n / w.bodies.length; // evaluations per body for one step
    };
    const off = evals(false);
    const on = evals(true);
    // RK4 x 16 substeps = 64; Euler x 2 substeps = 2
    expect(off).toBe(64);
    expect(on).toBe(PERF_SUBSTEPS);
    expect(on).toBeLessThan(off / 8);
  });

  it("gives up in-substep slicing under mutual gravity", () => {
    // the slicer is the largest multiplier in the engine; the mode's whole
    // point is not to pay it
    const build = (perf: boolean): World => {
      const w = new World();
      w.gravity = 0;
      w.mutualGravity = true;
      w.G = 1;
      w.pointGravity = true;
      w.softening = 0.001;
      w.substeps = 4;
      w.performance = perf;
      // a deliberately close, fast two-body encounter
      const a = new Body(new Vec2(-0.5, 0.02), 0.02, 100);
      const b = new Body(new Vec2(0.5, -0.02), 0.02, 100);
      a.vel.set(6, 0);
      b.vel.set(-6, 0);
      a.collides = b.collides = false;
      w.bodies.push(a, b);
      return w;
    };
    const count = (perf: boolean): number => {
      const w = build(perf);
      let n = 0;
      w.fields.push({
        name: "count", fxSrc: "0", fySrc: "0", enabled: true, error: "",
        fx: () => { n++; return 0; }, fy: () => 0, compile: () => true,
        toDict: () => ({ name: "count", fx: "0", fy: "0", enabled: true }),
      } as never);
      for (let i = 0; i < 30; i++) w.step(DT);
      return n;
    };
    const sliced = count(false);
    const flat = count(true);
    expect(flat).toBeLessThan(sliced / 4); // the slicing is genuinely gone
  });
});
