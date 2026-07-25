/** The example library has to run on a school laptop.
 *
 * Presets are the first thing anyone loads, usually before they know what
 * substeps are, and often on hardware far weaker than the machine they were
 * authored on. These guard the solver settings each scene ships with: cheap
 * enough to run, not so cheap that the scene stops doing what its card
 * promises.
 *
 * The cost check is STRUCTURAL rather than timed. Wall-clock assertions are
 * flaky on shared CI and would have to be loose enough to be meaningless;
 * substeps x work is deterministic and is the thing actually being chosen.
 */
import { describe, expect, it } from "vitest";
import {
  PRESETS, SOLVER_WORK_BUDGET, sceneWork,
} from "../src/scene/presets";
import { DistanceLink, SpringLink } from "../src/engine/links";

const DT = 1 / 120;
const find = (n: string) => PRESETS.find((p) => p.name === n)!;

describe("preset solver settings", () => {
  it("every scene is affordable on a modest machine", () => {
    const over: string[] = [];
    for (const p of PRESETS) {
      const w = p.build();
      const cost = w.substeps * sceneWork(w);
      // the floor of 2 substeps can push the smallest scenes over; that is
      // deliberate, so allow exactly that much slack and no more
      const ceiling = Math.max(SOLVER_WORK_BUDGET, 2 * sceneWork(w));
      if (cost > ceiling) over.push(`${p.name}: ${cost} > ${ceiling}`);
    }
    expect(over).toEqual([]);
  });

  it("no scene is stepped so coarsely it turns to mush", () => {
    for (const p of PRESETS) {
      const w = p.build();
      expect(w.substeps, `${p.name} substeps`).toBeGreaterThanOrEqual(2);
      expect(w.iterations, `${p.name} iterations`).toBeGreaterThanOrEqual(4);
      expect(w.substeps, `${p.name} substeps`).toBeLessThanOrEqual(64);
    }
  });

  it("every scene survives ten seconds without a body blowing up", () => {
    const broken: string[] = [];
    for (const p of PRESETS) {
      const w = p.build();
      for (let i = 0; i < 1200; i++) {
        w.step(DT);
        if (w.diverged.length > 0) { broken.push(`${p.name}: ${w.diverged}`); break; }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("preset behaviour at the shipped settings", () => {
  // Cheaper solver settings are only acceptable while the scene still shows
  // what it is there to show. These are the ones whose settings were cut.

  it("Newton's cradle still passes one ball straight through", () => {
    const w = find("Newton's cradle").build();
    const bobs = w.bodies.filter((b) => !b.locked);
    for (let i = 0; i < 240; i++) w.step(DT);
    const speeds = bobs.map((b) => b.vel.length()).sort((a, b) => b - a);
    // one moving fast, the rest essentially dead: the whole point of the toy
    expect(speeds[0]).toBeGreaterThan(1.0);
    expect(speeds[1]).toBeLessThan(speeds[0] * 0.1);
  });

  it("the wrecking ball still demolishes the tower", () => {
    const w = find("Wrecking ball").build();
    const bricks = w.bodies.filter((b) => b.mass === 0.4);
    const startX = bricks.map((b) => b.pos.x);
    const startTop = Math.max(...bricks.map((b) => b.pos.y));
    for (let i = 0; i < 900; i++) w.step(DT);
    const moved = bricks.filter((b, i) => Math.abs(b.pos.x - startX[i]) > 0.15);
    expect(moved.length).toBeGreaterThan(bricks.length / 2);
    expect(Math.max(...bricks.map((b) => b.pos.y))).toBeLessThan(startTop * 0.75);
  });

  it("the trampoline still throws the gymnast back up", () => {
    const w = find("Trampoline").build();
    const g = w.bodies.find((b) => b.name === "Gymnast")!;
    let lowest = Infinity;
    let reboundTop = -Infinity;
    for (let i = 0; i < 600; i++) {
      w.step(DT);
      lowest = Math.min(lowest, g.pos.y);
      if (g.pos.y < lowest + 1e-9) reboundTop = g.pos.y;
      else reboundTop = Math.max(reboundTop, g.pos.y);
    }
    expect(lowest).toBeLessThan(0);            // it really loads the bed
    expect(reboundTop).toBeGreaterThan(1.5);   // and is really thrown back
  });

  it("the jelly block keeps its shape at its reduced substep count", () => {
    const w = find("Jelly block").build();
    const soft = w.bodies.filter((b) => b.softBody);
    const span = (): [number, number] => {
      const xs = soft.map((b) => b.pos.x);
      const ys = soft.map((b) => b.pos.y);
      return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    };
    const [w0, h0] = span();
    for (let i = 0; i < 600; i++) w.step(DT);
    const [w1, h1] = span();
    // a lattice that has gone soft splays out or collapses; this one holds
    expect(w1).toBeGreaterThan(w0 * 0.6);
    expect(w1).toBeLessThan(w0 * 1.6);
    expect(h1).toBeGreaterThan(h0 * 0.5);
  });

  it("dense scenes keep every particle inside the box", () => {
    for (const name of ["Gas in a box (200)", "Brownian motion"]) {
      const w = find(name).build();
      for (let i = 0; i < 900; i++) w.step(DT);
      const escaped = w.bodies.filter(
        (b) => Math.abs(b.pos.x) > 20 || Math.abs(b.pos.y) > 20);
      expect(escaped.length, `${name} leaked ${escaped.length}`).toBe(0);
    }
  });
});

describe("solver iterations are a ceiling, not a dial", () => {
  // Measured across every preset with contacts or rigid links, at 4, 8, 16
  // and 32 iterations: worst body overlap was 0.5 mm and worst rod length
  // error 0.00 mm in ALL of them, at every count. 0.5 mm is exactly
  // PENETRATION_SLOP, the overlap the projection pass is told to tolerate.
  //
  // The reason is that nothing actually spends its budget: the contact
  // solver exits once a sweep's largest correction falls below a thousandth
  // of the first sweep's, the XPBD pass exits at sub-nanometre residual,
  // warm starting carries converged impulses between substeps, and
  // solveContacts sheds iterations by itself under heavy contact load.
  //
  // So raising iterations buys nothing here, and the reductions
  // capSolverCost makes on dense scenes cost nothing. This test exists so
  // that finding does not have to be rediscovered.
  /** Worst body overlap and worst rigid-link error after 5 s, in metres. */
  const errorsAt = (name: string, iterations: number): [number, number] => {
    const w = find(name).build();
    w.iterations = iterations;
    for (let i = 0; i < 600; i++) w.step(DT);
    let pen = 0;
    const bs = w.bodies.filter((b) => b.collides);
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        if (bs[i].invMass === 0 && bs[j].invMass === 0) continue;
        const o = bs[i].radius + bs[j].radius - bs[i].pos.distTo(bs[j].pos);
        if (o > pen) pen = o;
      }
    }
    let rod = 0;
    for (const ln of w.links) {
      if (!(ln instanceof DistanceLink) || ln.isRope) continue;
      const e = Math.abs(ln.a.pos.distTo(ln.b.pos) - ln.length);
      if (e > rod) rod = e;
    }
    return [pen, rod];
  };

  it("costs nothing in accuracy to run a contact scene at 4 instead of 32", () => {
    // NOT the same trajectory - a tower coming down is chaotic, and any
    // difference at all in the impulses amplifies. What is equivalent is
    // the constraint error, which is what iterations are there to reduce.
    for (const name of ["Wrecking ball", "Chain bridge", "Swinging rope"]) {
      const [lean, leanRod] = errorsAt(name, 4);
      const [rich, richRod] = errorsAt(name, 32);
      expect(lean, `${name} overlap at 4`).toBeLessThan(Math.max(rich, 0.0005) * 2 + 1e-6);
      expect(leanRod, `${name} rod error at 4`).toBeLessThan(Math.max(richRod, 1e-5) * 2 + 1e-9);
    }
  });

  it("no preset penetrates further than the projection slop allows", () => {
    for (const name of ["Wrecking ball", "Billiard break", "Brownian motion"]) {
      const w = find(name).build();
      for (let i = 0; i < 600; i++) w.step(DT);
      const bs = w.bodies.filter((b) => b.collides);
      let worst = 0;
      for (let i = 0; i < bs.length; i++) {
        for (let j = i + 1; j < bs.length; j++) {
          if (bs[i].invMass === 0 && bs[j].invMass === 0) continue;
          const overlap = bs[i].radius + bs[j].radius - bs[i].pos.distTo(bs[j].pos);
          if (overlap > worst) worst = overlap;
        }
      }
      expect(worst, `${name} overlap ${(worst * 1000).toFixed(2)} mm`)
        .toBeLessThan(0.002); // 2 mm: four times the slop, still invisible
    }
  });
});

describe("preset descriptions tell the truth", () => {
  // The card text is the teaching material - someone reads "period 2.46 s"
  // and times it against the clock in the toolbar. A description that
  // drifts from its builder is worse than no description, because it is
  // believed. Every falsifiable number in the library is checked here.
  //
  // Auditing all 47 turned up exactly one: Jelly smash advertised "200-odd
  // springs" and builds 153.

  it("quotes the right pendulum period", () => {
    const w = find("Simple pendulum").build();
    const rod = w.links.find((l): l is DistanceLink => l instanceof DistanceLink)!;
    expect(rod.length).toBeCloseTo(1.5, 6);           // "this 1.5 m rod"
    const T = 2 * Math.PI * Math.sqrt(rod.length / w.gravity);
    expect(T).toBeCloseTo(2.46, 2);                   // "roughly 2.46 s"
  });

  it("quotes the right spring period", () => {
    const w = find("Mass on a spring").build();
    const sp = w.links.find((l): l is SpringLink => l instanceof SpringLink)!;
    const m = [sp.a, sp.b].find((b) => b.invMass !== 0)!.mass;
    expect(2 * Math.PI * Math.sqrt(m / sp.stiffness)).toBeCloseTo(1.26, 2);
  });

  it("builds the counts and values the cards quote", () => {
    const ladder = find("Restitution ladder").build().bodies.filter((b) => !b.locked);
    expect(ladder.length).toBe(6);                    // "Six balls"
    const es = ladder.map((b) => b.restitution).sort((a, b) => a - b);
    expect(es[0]).toBeCloseTo(0.5, 6);                // "restitution 0.5 to 1.0"
    expect(es[es.length - 1]).toBeCloseTo(1.0, 6);

    const ramp = find("Friction ramp").build();
    expect(ramp.bodies.length).toBe(3);               // "Three balls"
    const slope = Math.abs(Math.atan2(ramp.walls[0].b.y - ramp.walls[0].a.y,
                                      ramp.walls[0].b.x - ramp.walls[0].a.x) * 180 / Math.PI);
    expect(slope).toBeCloseTo(25, 1);                 // "25 degree ramp"

    const galileo = find("Galileo's drop").build().bodies.map((b) => b.mass).sort((a, b) => b - a);
    expect(galileo).toEqual([10, 0.5]);               // "A 10 kg ball and a 0.5 kg ball"

    const which = find("Which lands first?").build();
    expect(Math.max(...which.bodies.map((b) => Math.abs(b.vel.x)))).toBeCloseTo(6, 6);

    const angles = find("Projectile angles").build();
    expect(angles.bodies.length).toBe(4);             // "Four launches"
    for (const b of angles.bodies) expect(b.vel.length()).toBeCloseTo(10, 6);
    const degs = angles.bodies.map((b) => Math.round(Math.atan2(b.vel.y, b.vel.x) * 180 / Math.PI));
    expect(degs).toContain(30);                       // "the 30/60 pair"
    expect(degs).toContain(45);                       // "45 degrees flies farthest"
    expect(degs).toContain(60);

    const term = find("Terminal velocity").build().bodies.map((b) => b.mass).sort((a, b) => b - a);
    expect(term[0] / term[1]).toBeCloseTo(10, 6);     // "the 10x heavier ball"

    const wreck = find("Wrecking ball").build();
    expect(Math.max(...wreck.bodies.map((b) => b.mass))).toBe(22); // "A 22 kg pendulum ball"

    const pyth = find("Pythagorean three-body").build().bodies.map((b) => b.mass).sort();
    expect(pyth).toEqual([3, 4, 5]);                  // "masses 3, 4 and 5"

    expect(find("Gas in a box (200)").build().bodies.length).toBe(200);
    expect(find("Gas in a box (50)").build().bodies.length).toBe(50);
  });

  it("builds the lattices the soft-body cards describe", () => {
    const block = find("Jelly block").build();
    expect(block.bodies.filter((b) => b.softBody).length).toBe(63); // "9 x 7 lattice"

    // "150-odd springs" - the number that was wrong, now pinned
    const smash = find("Jelly smash").build();
    expect(smash.links.length).toBeGreaterThan(120);
    expect(smash.links.length).toBeLessThan(200);

    const butterfly = find("Butterfly effect").build();
    expect(butterfly.bodies.length).toBe(9);          // three pivots + six bobs
    expect(butterfly.links.length).toBe(6);           // "Three double pendulums"
  });

  it("gives Brownian motion one heavy grain in a light swarm", () => {
    const ms = find("Brownian motion").build().bodies
      .map((b) => b.mass).sort((a, b) => b - a);
    expect(ms[0]).toBeGreaterThan(ms[1] * 50); // "A heavy grain ... light particles"
    expect(ms.length).toBeGreaterThan(50);     // "a swarm"
  });
});
