/** Adaptive time resolution.
 *
 * Both knobs are functions of the simulation state ALONE - never of frame
 * timing (see App.pickResolution for why: a step size chosen from machine
 * load makes the same scene integrate differently from run to run).
 * `subdivisionNeed` picks whole extra steps from path curvature, and
 * `encounterAngle` governs slicing inside one substep.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { ENCOUNTER_ANGLE, World } from "../src/engine/world";

const DT = 1.0 / 120.0;

describe("adaptive quality", () => {
  it("subdivision tracks curvature, not speed", () => {
    const curving = (force: number) => {
      const w = new World();
      w.gravity = 0.0;
      const b = new Body(new Vec2(0, 0), 0.15, 1.0);
      b.constForce.set(force, 0.0); // acc = force / 1 kg
      w.bodies.push(b);
      w.step(DT); // populate b.acc
      return w.subdivisionNeed(DT);
    };
    expect(curving(200.0)).toBe(1);                  // sagitta below tolerance
    expect(curving(60000.0)).toBeGreaterThan(1);     // deviates within a step
  });

  it("never subdivides straight-line/idle motion", () => {
    const w = new World();
    w.gravity = 0.0;
    const b = new Body(new Vec2(0, 0), 0.15, 1.0);
    b.vel.set(50.0, 0.0); // fast but dead straight: nothing to smooth
    w.bodies.push(b);
    w.step(DT);
    expect(w.subdivisionNeed(DT)).toBe(1);
  });

  it("subdivision is capped at maxQ however violent the curve", () => {
    const w = new World();
    w.gravity = 0.0;
    const b = new Body(new Vec2(0, 0), 0.15, 1.0);
    // large enough to demand far more than maxQ, but not so large that
    // sanitize() freezes the body and zeroes the acceleration we read
    b.constForce.set(1e6, 0.0);
    w.bodies.push(b);
    w.step(DT);
    expect(w.subdivisionNeed(DT, 16)).toBe(16);
  });

  it("lower encounterAngle engages in-substep slicing at moderate swings", () => {
    const orbit = (angle: number) => {
      const w = new World();
      w.gravity = 0.0;
      w.mutualGravity = true;
      w.G = 1.0;
      w.substeps = 8;
      w.encounterAngle = angle;
      w.traceSpacing = 0.001; // capture the in-slice path densely
      const a = new Body(new Vec2(-0.2, 0), 0.05, 1.0);
      const b = new Body(new Vec2(0.2, 0), 0.05, 1.0);
      // circular two-body orbit at separation 0.4: a moderate, steady swing.
      // F = G m^2/d^2 = 6.25 N; v = sqrt(F r / m) with r = 0.2 -> 1.118 m/s
      const v = Math.sqrt(6.25 * 0.2);
      a.vel.set(0, -v);
      b.vel.set(0, v);
      w.bodies.push(a, b);
      const e0 = w.energy().total;
      for (let i = 0; i < 120; i++) w.step(DT);
      return { trace: w.trace.length,
               drift: Math.abs(w.energy().total - e0) / Math.abs(e0) };
    };
    const coarse = orbit(ENCOUNTER_ANGLE);        // default: no slicing here
    const fine = orbit(ENCOUNTER_ANGLE / 10.0);   // tightened: slices
    expect(coarse.trace).toBe(0);
    expect(fine.trace).toBeGreaterThan(0);        // in-slice path captured
    expect(fine.drift).toBeLessThan(0.01);        // and accuracy stays tight
  });

  it("encounterAngle is runtime tuning, not scene state", () => {
    const w = new World();
    w.encounterAngle = ENCOUNTER_ANGLE / 5.0;
    const restored = World.fromDict(w.toDict());
    expect(restored.encounterAngle).toBe(ENCOUNTER_ANGLE);
  });
});
