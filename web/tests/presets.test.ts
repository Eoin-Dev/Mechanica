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
