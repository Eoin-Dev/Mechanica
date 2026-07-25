/** Guards for things that used to fail quietly.
 *
 * Every case here is a bug that produced no error message: a scene that
 * froze on load, an energy graph that drifted for no visible reason, a
 * status bar counting the same collision several times. Silent wrongness is
 * the expensive kind in a teaching tool, so each one gets a test.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { SpringLink } from "../src/engine/links";
import { World, WorldDict } from "../src/engine/world";

const DT = 1.0 / 120.0;

describe("scene deserialization", () => {
  it("fills in missing body fields instead of poisoning the solver", () => {
    // a hand-written or older scene file, missing most optional fields
    const b = Body.fromDict({ pos: [1, 2] } as never);
    expect(Number.isFinite(b.restitution)).toBe(true);
    expect(Number.isFinite(b.friction)).toBe(true);
    expect(Number.isFinite(b.mass)).toBe(true);
    expect(b.radius).toBeGreaterThan(0);
    expect(b.locked).toBe(false);
    expect(b.pos.x).toBe(1);
  });

  it("rejects non-finite values in a scene file", () => {
    const b = Body.fromDict({
      pos: [Number.NaN, 0], vel: [0, Number.POSITIVE_INFINITY],
      mass: Number.NaN, radius: Number.NaN, restitution: Number.NaN,
    } as never);
    expect(Number.isFinite(b.pos.x + b.pos.y + b.vel.x + b.vel.y)).toBe(true);
    expect(Number.isFinite(b.mass + b.radius + b.restitution)).toBe(true);
  });

  it("a body missing every field still steps without freezing", () => {
    const w = new World();
    w.bodies.push(Body.fromDict({ pos: [0, 1] } as never));
    w.walls.push(Wall.fromDict({ a: [-1, 0], b: [1, 0] } as never));
    for (let i = 0; i < 240; i++) w.step(DT);
    expect(w.diverged).toEqual([]);
    expect(Number.isFinite(w.bodies[0].pos.y)).toBe(true);
  });

  it("clamps solver settings to the range the inspector offers", () => {
    const wild = { settings: { substeps: 1e9, iterations: 1e9 } };
    const a = World.fromDict(wild as Partial<WorldDict>);
    expect(a.substeps).toBe(64);
    expect(a.iterations).toBe(64); // unclamped, this hung the tab outright
    const junk = { settings: { substeps: Number.NaN, iterations: -5 } };
    const b = World.fromDict(junk as Partial<WorldDict>);
    expect(b.substeps).toBe(4);
    expect(b.iterations).toBe(1);
  });
});

describe("reported state", () => {
  it("counts each live contact once, not once per substep", () => {
    const w = new World();
    w.substeps = 8;
    w.walls.push(new Wall(new Vec2(-2, 0), new Vec2(2, 0), 0.1));
    const b = new Body(new Vec2(0, 0.1), 0.1, 1.0);
    b.restitution = 0.0;
    w.bodies.push(b);
    for (let i = 0; i < 240; i++) w.step(DT); // let it settle on the wall
    expect(w.contacts.length).toBe(1); // was 8: one per substep, all drawn
  });

  it("spring energy matches the stiffness the solver actually applies", () => {
    // k far above what an explicit integrator can carry: prepareStep clamps
    // it, and the reported PE has to follow the clamp or the energy plot
    // shows a drift with no physical cause
    const w = new World();
    w.gravity = 0.0;
    const a = new Body(new Vec2(0, 0), 0.05, 1.0);
    const b = new Body(new Vec2(1.5, 0), 0.05, 1.0);
    a.locked = true;
    const s = new SpringLink(a, b, 1.0, 1e9, 0.0);
    w.bodies.push(a, b);
    w.links.push(s);
    w.step(DT);
    expect(s.kEff).toBeLessThan(s.stiffness); // the clamp engaged
    const ext = a.pos.distTo(b.pos) - s.restLength;
    expect(s.potentialEnergy()).toBeCloseTo(0.5 * s.kEff * ext * ext, 6);
    // the raw stiffness is thousands of times larger: reporting it was the
    // whole bug, so make sure the two really are far apart here
    expect(s.potentialEnergy()).toBeLessThan(0.5 * s.stiffness * ext * ext * 0.01);

    // and the total energy of the clamped oscillator stays put
    const e0 = w.energy().total;
    for (let i = 0; i < 600; i++) w.step(DT);
    expect(Math.abs(w.energy().total - e0) / Math.abs(e0)).toBeLessThan(0.05);
  });
});
