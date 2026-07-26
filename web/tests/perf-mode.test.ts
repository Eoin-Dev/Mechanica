/** Performance mode: robust everywhere, and invisible to saved scenes.
 *
 * The mode has two jobs and this file covers both. The first is to stay
 * strictly out of the scene's own data: the scene keeps the substeps,
 * iterations and integrator it was authored with, and the mode overrides them
 * for the duration of a step and nothing else.
 *
 * The second is the one it exists for - to be unconditionally stable. Springs
 * are position constraints here rather than forces (see engine/perf.ts), so
 * the tests below drive stiffness and damping to the ends of their sliders and
 * past them, on the densest lattices in the library, and assert that nothing
 * moves faster or stretches further than a scene running its authored settings
 * does. Those are regression tests for a real failure: with springs integrated
 * as forces and clamped per spring rather than per node, every soft-body
 * preset in the library reached ~1e7 m/s within three seconds of being played.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { SpringLink } from "../src/engine/links";
import {
  PERF_ITERATIONS, PERF_MAX_SPEED, PERF_MAX_STRETCH, PERF_SUBSTEPS,
} from "../src/engine/perf";
import { PRESETS } from "../src/scene/presets";
import { World, WorldDict } from "../src/engine/world";

const DT = 1 / 120;

/** Every preset that has at least one spring in it. */
function springPresets(): Array<[string, () => World]> {
  return PRESETS
    .filter((p) => p.build().links.some((l) => l instanceof SpringLink))
    .map((p) => [p.name, () => p.build()] as [string, () => World]);
}

/** Run `steps` and report the worst speed, and the worst spring length seen
 * as a multiple of its natural length. */
function stress(w: World, steps: number): { speed: number; ratio: number } {
  let speed = 0.0;
  let ratio = 0.0;
  for (let i = 0; i < steps; i++) {
    w.step(DT);
    for (const b of w.bodies) {
      const v = Math.hypot(b.vel.x, b.vel.y);
      if (v > speed) speed = v;
    }
    for (const ln of w.links) {
      if (!(ln instanceof SpringLink) || ln.restLength <= 0.0) continue;
      const s = ln.a.pos.distTo(ln.b.pos) / ln.restLength;
      if (s > ratio) ratio = s;
    }
  }
  return { speed, ratio };
}

/** A soft-body lattice: the shape that broke the old mode. Every interior
 * particle carries twelve springs, which is the whole point - the per-spring
 * stability clamp it used to rely on is blind to how many meet at a node. */
function lattice(cols: number, rows: number, k: number, c: number): World {
  const w = new World();
  w.substeps = 8;
  w.iterations = 8;
  const floor = new Wall(new Vec2(-4, 0), new Vec2(4, 0), 0.14);
  floor.friction = 0.6;
  floor.restitution = 0.1;
  w.walls.push(floor);
  const spacing = 0.225;
  const grid: Body[][] = [];
  for (let j = 0; j < rows; j++) {
    const line: Body[] = [];
    for (let i = 0; i < cols; i++) {
      const b = new Body(new Vec2(-1 + i * spacing, 1.6 + j * spacing),
                         spacing * 0.35, 4.0 / (cols * rows));
      b.restitution = 0.2;
      b.friction = 0.5;
      w.bodies.push(b);
      line.push(b);
    }
    grid.push(line);
  }
  const link = (a: Body, b: Body, stiffness: number): void => {
    w.links.push(new SpringLink(a, b, a.pos.distTo(b.pos), stiffness, c));
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (i + 1 < cols) link(grid[j][i], grid[j][i + 1], k);
      if (j + 1 < rows) link(grid[j][i], grid[j + 1][i], k);
      if (i + 1 < cols && j + 1 < rows) {
        link(grid[j][i], grid[j + 1][i + 1], k);
        link(grid[j][i + 1], grid[j + 1][i], k);
      }
      if (i + 2 < cols) link(grid[j][i], grid[j][i + 2], k * 0.25);
      if (j + 2 < rows) link(grid[j][i], grid[j + 2][i], k * 0.25);
    }
  }
  return w;
}

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

// ------------------------------------------------------------- robustness
describe("springs cannot destabilise the mode", () => {
  // The numbers here are deliberately loose. They are not a description of
  // how a jelly ought to behave - the mode makes no claim about that - they
  // are the line between "playing with a soft body" and "the scene came
  // apart", and the failure they guard against missed them by six orders of
  // magnitude, not by a few percent.
  const SANE_SPEED = 60.0;   // m/s; the library's soft bodies peak near 10

  it("survives the whole stiffness slider on a dense lattice", () => {
    // 0.01 and 100000 are the ends of the Inspector's own slider; 1e9 is
    // what a hand-edited scene file can carry through the guards in
    // linkFromDict. None of them may behave differently in kind.
    for (const k of [0.01, 1.0, 100.0, 1000.0, 20000.0, 100000.0, 1e9]) {
      const w = lattice(9, 7, k, 3.0);
      w.performance = true;
      const { speed } = stress(w, 900);
      expect(w.diverged, `k=${k}`).toEqual([]);
      expect(speed, `k=${k}`).toBeLessThan(SANE_SPEED);
    }
  });

  it("survives the whole damping slider too, at maximum stiffness", () => {
    // Damping is the half of the old failure that is easy to overlook: the
    // per-spring limit allowed no single spring to overshoot in a step, but
    // twelve of them meeting at one particle removed more than all of its
    // velocity, which reverses it and grows.
    for (const c of [0.0, 1.0, 50.0, 500.0, 1e9]) {
      const w = lattice(9, 7, 100000.0, c);
      w.performance = true;
      const { speed } = stress(w, 900);
      expect(w.diverged, `c=${c}`).toEqual([]);
      expect(speed, `c=${c}`).toBeLessThan(SANE_SPEED);
    }
  });

  it("holds a stiff lattice's shape instead of softening it away", () => {
    // Saturating safely would be worthless if it saturated at "mush": the
    // point of using compliance rather than a clamp is that high stiffness
    // stays meaningful. A lattice at the top of the slider must deform less
    // than the same lattice near the bottom.
    const worstStretch = (k: number): number => {
      const w = lattice(9, 7, k, 3.0);
      w.performance = true;
      return stress(w, 600).ratio - 1.0;
    };
    const soft = worstStretch(20.0);
    const stiff = worstStretch(100000.0);
    expect(stiff).toBeLessThan(soft * 0.5);
    expect(stiff).toBeLessThan(0.2); // within 20% of natural length throughout
  });

  it("bounds how far a spring can stretch, however it is abused", () => {
    // The limiter runs inside the substep, so a body can still fly past the
    // bound during the integration that follows it - one substep at the speed
    // ceiling is 2 m - and the assertion allows for exactly that. What it does
    // not allow is the bound failing to hold at all, which is the difference
    // between a lattice that snaps back and one that has come apart.
    const w = lattice(9, 7, 100000.0, 3.0);
    w.performance = true;
    for (let burst = 0; burst < 6; burst++) {
      w.bodies[0].vel.set(400, 400);
      w.bodies[w.bodies.length - 1].vel.set(-400, 300);
      const { ratio } = stress(w, 150);
      expect(ratio).toBeLessThan(PERF_MAX_STRETCH * 1.5);
    }
    expect(w.diverged).toEqual([]);
    // and once the abuse stops it recovers to something like a lattice again
    const settled = stress(w, 600);
    expect(settled.ratio).toBeLessThan(1.5);
  });

  it("caps speed well below the range that freezes a body", () => {
    const w = lattice(5, 5, 100000.0, 0.0);
    w.performance = true;
    w.fields.push({ // a singular field: 1/r^3 through the origin
      name: "blow up", fxSrc: "", fySrc: "", enabled: true, error: "",
      fx: (e: { x: number }) => 1e7 / (e.x * e.x * e.x + 1e-9),
      fy: () => 1e7,
      compile: () => true,
      toDict: () => ({ name: "blow up", fx: "0", fy: "0", enabled: true }),
    } as never);
    const { speed } = stress(w, 300);
    expect(speed).toBeLessThanOrEqual(PERF_MAX_SPEED + 1e-6);
  });

  it("keeps every spring preset in the library coherent for 15 seconds", () => {
    for (const [name, build] of springPresets()) {
      const w = build();
      w.performance = true;
      const { speed } = stress(w, 1800);
      expect(w.diverged, name).toEqual([]);
      for (const b of w.bodies) {
        expect(Number.isFinite(b.pos.x + b.pos.y + b.vel.x + b.vel.y), name)
          .toBe(true);
      }
      expect(speed, name).toBeLessThan(SANE_SPEED);
    }
  });

  it("bounces the Trampoline's gymnast instead of dropping it through", () => {
    // A 64 kg gymnast on 100 g bed particles is the worst mass ratio in the
    // library, and a position projection has no large velocity to hand the
    // contact solver the way a spring force does. Body.contactMassGain is
    // what closes that gap; without it the gymnast falls through the bed and
    // never comes back.
    const preset = PRESETS.find((p) => p.name === "Trampoline")!;
    const w = preset.build();
    w.performance = true;
    const gym = w.bodies.find((b) => b.name === "Gymnast")!;
    let lowest = Infinity;
    let rebound = -Infinity;
    for (let i = 0; i < 1200; i++) {
      w.step(DT);
      lowest = Math.min(lowest, gym.pos.y);
      rebound = Math.max(rebound, gym.vel.y);
    }
    expect(lowest).toBeGreaterThan(-1.5); // stayed on the bed, not below it
    expect(rebound).toBeGreaterThan(2.0); // and was thrown back up
  });

  it("does not turn a lattice inside out", () => {
    // The failure mode a soft body shows before it shows numbers: a cell
    // whose winding has flipped satisfies all of its springs exactly as well
    // as the correct cell does, so it stays inverted (which is why the
    // presets carry second-neighbour bend springs - see softGrid). Stability
    // that arrived at the cost of the shape would not be worth having.
    const cols = 9;
    const rows = 7;
    for (const k of [1000.0, 100000.0]) {
      for (const whip of [0.0, 9.0, 20.0]) {
        const w = lattice(cols, rows, k, 3.0);
        w.performance = true;
        w.bodies[0].vel.set(whip, whip * 0.5);
        for (let i = 0; i < 900; i++) w.step(DT);
        let bad = 0;
        for (let j = 0; j + 1 < rows; j++) {
          for (let i = 0; i + 1 < cols; i++) {
            const a = w.bodies[j * cols + i];
            const b = w.bodies[j * cols + i + 1];
            const c = w.bodies[(j + 1) * cols + i];
            const cross = (b.pos.x - a.pos.x) * (c.pos.y - a.pos.y) -
                          (b.pos.y - a.pos.y) * (c.pos.x - a.pos.x);
            if (cross <= 0.0) bad++;
          }
        }
        expect(bad, `k=${k} whip=${whip}`).toBe(0);
      }
    }
  });

  it("leaves scenes with no springs alone", () => {
    // The guards are targeted: the sprung-body dissipation and the borrowed
    // contact mass must not touch an orbit or a projectile, which had nothing
    // to do with the failure they exist for.
    const build = (): World => {
      const w = new World();
      w.substeps = 2;
      w.gravity = 0;
      w.mutualGravity = true;
      w.G = 1;
      const sun = new Body(new Vec2(0, 0), 0.2, 1000);
      const planet = new Body(new Vec2(3, 0), 0.05, 0.001);
      planet.vel.set(0, Math.sqrt(1000 / 3));
      w.bodies.push(sun, planet);
      return w;
    };
    const a = build();
    const b = build();
    b.performance = true;
    for (let i = 0; i < 600; i++) {
      a.step(DT);
      b.step(DT);
    }
    // Euler against Verlet will not agree exactly, but the orbit must not be
    // bled away: no dissipation is applied to a body with no springs on it.
    const rA = Math.hypot(a.bodies[1].pos.x, a.bodies[1].pos.y);
    const rB = Math.hypot(b.bodies[1].pos.x, b.bodies[1].pos.y);
    expect(rB).toBeGreaterThan(rA * 0.9);
    expect(rB).toBeLessThan(rA * 1.1);
    for (const body of b.bodies) expect(body.contactMassGain).toBe(1.0);
  });
});

describe("the projection is a spring, not a rod", () => {
  /** One mass hanging from an anchor on a single spring. */
  const hanger = (k: number): World => {
    const w = new World();
    w.substeps = 2;
    const anchor = new Body(new Vec2(0, 2), 0.05, 1);
    anchor.isAnchor = true;
    anchor.locked = true;
    const bob = new Body(new Vec2(0, 1), 0.05, 1);
    bob.collides = false;
    w.bodies.push(anchor, bob);
    w.links.push(new SpringLink(anchor, bob, 1.0, k, 0.5));
    w.performance = true;
    return w;
  };

  it("sags less as the stiffness rises, right across the slider", () => {
    // The whole reason stiffness enters as XPBD compliance rather than as a
    // clamp: the slider has to keep meaning something at the top, where an
    // explicit spring can only saturate at whatever the timestep can carry.
    let previous = Infinity;
    for (const k of [1.0, 10.0, 100.0, 1000.0, 100000.0]) {
      const w = hanger(k);
      for (let i = 0; i < 600; i++) w.step(DT);
      const sag = 2.0 - w.bodies[1].pos.y - 1.0; // extension past rest length
      expect(sag, `k=${k}`).toBeGreaterThanOrEqual(-1e-6);
      expect(sag, `k=${k}`).toBeLessThan(previous);
      previous = sag;
    }
    expect(previous).toBeLessThan(0.01); // at the top it hangs nearly rigid
  });

  it("still oscillates rather than snapping rigid", () => {
    const w = hanger(50.0);
    w.links[0] = new SpringLink(w.bodies[0], w.bodies[1], 1.0, 50.0, 0.0);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 600; i++) {
      w.step(DT);
      lo = Math.min(lo, w.bodies[1].pos.y);
      hi = Math.max(hi, w.bodies[1].pos.y);
    }
    expect(hi - lo).toBeGreaterThan(0.05); // it is visibly bouncing
  });
});
