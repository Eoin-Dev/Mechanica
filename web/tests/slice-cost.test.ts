/** Cost stability of the in-substep close-encounter slicer.
 *
 * The slicer is the only part of the pipeline whose cost is chosen by the
 * simulation STATE rather than by the scene's size, so it is also the only
 * part that can make an ordinary scene suddenly a hundred times more
 * expensive. These tests pin the two properties that keeps it honest:
 *
 *   - what it costs depends on whether the acceleration is genuinely
 *     changing fast, not on whether some body happens to be slow. A single
 *     particle dropped into a heavy star used to pin the slicer at its
 *     refinement floor forever, taking the whole scene from 12 to ~1800
 *     force evaluations per step (0.08 ms -> 15 ms);
 *   - the cost is the same whichever integrator is selected. Switching
 *     integrator and back used to "fix" the slowdown, purely because the
 *     perturbed trajectory fell out of the pathological state.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { INTEGRATORS, World } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";

const DT = 1.0 / 120.0;

/** Mean force evaluations per step: a machine-independent cost measure. */
function evalsPerStep(w: World, steps: number): number {
  let n = 0;
  const patched = w as unknown as { accumulateForces: (t: number) => void };
  const orig = patched.accumulateForces.bind(w);
  patched.accumulateForces = (t: number) => { n++; orig(t); };
  for (let i = 0; i < steps; i++) w.step(DT);
  patched.accumulateForces = orig;
  return n / steps;
}

function trojans(): World {
  return PRESETS.find((p) => p.name === "Trojan asteroids")!.build();
}

describe("close-encounter slicing cost", () => {
  it("a body spawned into an orbital scene does not blow up the cost", () => {
    const bare = evalsPerStep(trojans(), 400);
    const w = trojans();
    w.bodies.push(new Body(new Vec2(1.4, 1.1))); // the Add-body tool's default
    const spawned = evalsPerStep(w, 400);
    // it falls into the Sun and settles on it; a real close pass on the way
    // in is worth some slicing, a permanent tax is not
    expect(spawned).toBeLessThan(bare * 4);
  });

  it("stays bounded however many bodies are dropped in", () => {
    const w = trojans();
    for (let k = 0; k < 12; k++) {
      w.bodies.push(new Body(new Vec2(-1.2 + k * 0.2, 1.3 - k * 0.05)));
    }
    expect(evalsPerStep(w, 400)).toBeLessThan(200);
  });

  it("costs the same whichever integrator is selected", () => {
    const cost = new Map<string, number>();
    for (const integ of INTEGRATORS) {
      const w = trojans();
      w.integrator = integ;
      w.bodies.push(new Body(new Vec2(1.4, 1.1)));
      // per-slice evaluation count differs by integrator by construction
      // (Euler 1, Verlet 2, RK4 4), so compare against each one's own floor
      const floor = { "Symplectic Euler": 1, "Velocity Verlet": 2, RK4: 4 }[integ];
      cost.set(integ, evalsPerStep(w, 400) / (floor * w.substeps));
    }
    for (const perSlice of cost.values()) expect(perSlice).toBeLessThan(4);
  });

  it("switching integrator and back leaves no state behind", () => {
    // Switching perturbs the trajectory, and these orbits are chaotic, so
    // the two segments are not the same simulation and their costs are not
    // expected to match. What must hold is that neither is anywhere near
    // the pathological regime - the cost is a property of the dynamics,
    // never of a stale flag that a switch happens to clear.
    const w = trojans();
    w.bodies.push(new Body(new Vec2(1.4, 1.1)));
    evalsPerStep(w, 300); // settle
    const before = evalsPerStep(w, 200);
    w.integrator = "RK4";
    evalsPerStep(w, 60);
    w.integrator = "Velocity Verlet";
    evalsPerStep(w, 60);
    const after = evalsPerStep(w, 200);
    const bare = evalsPerStep(trojans(), 200);
    expect(before).toBeLessThan(bare * 10);
    expect(after).toBeLessThan(bare * 10);
  });

  it("a body at rest in a very strong field is not mistaken for an encounter", () => {
    // the reduced case: nothing here changes, so nothing needs resolving
    const w = new World();
    w.gravity = 0.0;
    w.mutualGravity = true;
    w.G = 1.0;
    w.substeps = 6;
    const star = new Body(new Vec2(0, 0), 0.5, 1000.0);
    star.locked = true;
    w.bodies.push(star);
    w.bodies.push(new Body(new Vec2(0.0, 1.2), 0.15, 1.0));
    for (let i = 0; i < 600; i++) w.step(DT); // fall in and settle
    expect(evalsPerStep(w, 300)).toBeLessThan(6 * 2 * 3);
  });

  it("a dense cloud spends its whole budget on the pairs, not on slices", () => {
    // 400 mutually attracting bodies cost ~80 000 pair evaluations each
    // time the forces are evaluated, so an extra slice is four of those.
    // The budget must scale the refinement down to nothing rather than
    // keep a floor that multiplies the step several times over.
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const w = new World();
    w.gravity = 0;
    w.mutualGravity = true;
    w.G = 0.05;
    w.substeps = 2;
    for (let i = 0; i < 400; i++) {
      const b = new Body(new Vec2(rand() * 20 - 10, rand() * 20 - 10), 0.08, 1);
      b.vel.set(rand() * 2 - 1, rand() * 2 - 1);
      w.bodies.push(b);
    }
    for (let i = 0; i < 60; i++) w.step(DT);
    // Velocity Verlet's floor is 2 evaluations per substep; anything much
    // above that is the slicer refusing to scale down (it was 20).
    expect(evalsPerStep(w, 200)).toBeLessThanOrEqual(2 * w.substeps + 2);
  }, 120000);

  it("still resolves a genuine near-singular flyby", () => {
    // the accuracy this machinery exists for: energy across the pass
    const build = (): World => {
      const w = new World();
      w.substeps = 8;
      w.gravity = 0.0;
      w.mutualGravity = true;
      w.pointGravity = true;
      w.G = 1.0;
      w.softening = 0.01;
      const a = new Body(new Vec2(-4.0, 0.02), 0.05, 2.0);
      const b = new Body(new Vec2(4.0, -0.02), 0.05, 2.0);
      a.vel.set(1.5, 0.0);
      b.vel.set(-1.5, 0.0);
      a.collides = b.collides = false;
      w.bodies.push(a, b);
      return w;
    };
    const w = build();
    const e0 = w.energy().total;
    // the pass costs real work, and that is exactly what it is for
    expect(evalsPerStep(w, 720)).toBeGreaterThan(8 * 2);
    expect(Math.abs(w.energy().total - e0) / Math.abs(e0)).toBeLessThan(0.02);
  });
});
