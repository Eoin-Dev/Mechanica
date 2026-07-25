/** Guards for things that used to fail quietly.
 *
 * Every case here is a bug that produced no error message: a scene that
 * froze on load, an energy graph that drifted for no visible reason, a
 * status bar counting the same collision several times. Silent wrongness is
 * the expensive kind in a teaching tool, so each one gets a test.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { BODY_PALETTE, Body, Wall } from "../src/engine/body";
import { closestOnSegment, sweepClearOfWalls } from "../src/engine/contacts";
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

describe("per-object colour", () => {
  it("a new body owns its colour instead of aliasing the palette", () => {
    // the picker writes a fresh array, but a body that ALIASED a palette
    // slot would still let any in-place edit repaint every body sharing it
    const a = new Body(new Vec2(0, 0));
    const b = new Body(new Vec2(1, 0));
    for (const slot of BODY_PALETTE) {
      expect(a.color).not.toBe(slot); // identity, not value
      expect(b.color).not.toBe(slot);
    }
    a.color[0] = 1;
    expect(BODY_PALETTE.some((c) => c[0] === 1)).toBe(false);
  });

  it("colour survives a save/load round trip", () => {
    const b = new Body(new Vec2(0, 0));
    b.color = [12, 34, 56];
    const w = new World();
    w.bodies.push(b);
    const back = World.fromDict(JSON.parse(JSON.stringify(w.toDict())));
    expect(back.bodies[0].color).toEqual([12, 34, 56]);
    expect(back.bodies[0].color).not.toBe(b.color);
  });
});

describe("closestOnSegment", () => {
  it("clamps to the endpoints and finds the perpendicular foot", () => {
    expect(closestOnSegment(0, 5, -1, 0, 1, 0)).toEqual([0, 0]);   // above middle
    expect(closestOnSegment(-9, 3, -1, 0, 1, 0)).toEqual([-1, 0]); // past end a
    expect(closestOnSegment(9, 3, -1, 0, 1, 0)).toEqual([1, 0]);   // past end b
  });

  it("degenerate (zero-length) segments return the point itself", () => {
    expect(closestOnSegment(3, 4, 2, 2, 2, 2)).toEqual([2, 2]);
  });
});

describe("solid drag (kinematic wall sweep)", () => {
  // floor along y=0 and a left wall at x=-2, both 0.2 thick. A 0.25 m disc
  // therefore rests at y = 0.1 + 0.25 = 0.35, and against x = -2 + 0.35.
  const scene = () => [new Wall(new Vec2(-2, 0), new Vec2(2, 0), 0.2),
                       new Wall(new Vec2(-2, 0), new Vec2(-2, 3), 0.2)];
  const R = 0.25;
  const sweep = (fx: number, fy: number, tx: number, ty: number) =>
    sweepClearOfWalls(scene(), { x: fx, y: fy }, { x: tx, y: ty }, R)
      .map((v) => +v.toFixed(3));

  it("rests a body pushed gently into the floor on its surface", () => {
    expect(sweep(0, 0.5, 0, 0.2)).toEqual([0, 0.35]);
  });

  it("does not let a fast flick tunnel through", () => {
    // the whole point: 4.5 m of travel in one frame, straight down through
    // a 0.2 m floor. Resolving only at the destination lands it at -3.
    expect(sweep(0, 1.5, 0, -3.0)).toEqual([0, 0.35]);
  });

  it("holds against a jump far beyond the step budget", () => {
    // travel is shortened rather than resolution coarsened, so even an
    // absurd jump cannot cross
    expect(sweep(0, 1.5, 0, -500)).toEqual([0, 0.35]);
  });

  it("lags rather than blocks when a huge jump is unobstructed", () => {
    const [, y] = sweep(0, 5, 0, 500);
    expect(y).toBeGreaterThan(5);   // it moved
    expect(y).toBeLessThan(500);    // but not the whole way, this frame
  });

  it("slides along a surface instead of sticking", () => {
    expect(sweep(0, 0.35, 1.5, 0.1)).toEqual([1.5, 0.35]);
    expect(sweep(-1, 1.2, 1, -2)).toEqual([1, 0.35]);
  });

  it("wedges into a corner against both walls", () => {
    expect(sweep(0, 1.0, -5, -5)).toEqual([-1.65, 0.35]);
  });

  it("leaves an unobstructed drag exactly where it was aimed", () => {
    expect(sweep(0, 2.0, 1, 2.5)).toEqual([1, 2.5]);
    expect(sweep(0, 1, 0, 1)).toEqual([0, 1]);   // zero-length move
    expect(sweep(3, 1.0, 3, -1.0)).toEqual([3, -1]); // past the wall's end
  });

  it("keeps a body that started on the far side on that side", () => {
    // it is legitimately under the floor; it must not be teleported up
    expect(sweep(0, -1.0, 0, -0.2)).toEqual([0, -0.35]);
  });

  it("is a no-op with no walls in the scene", () => {
    expect(sweepClearOfWalls([], { x: 0, y: 5 }, { x: 1, y: -5 }, R))
      .toEqual([1, -5]);
  });
});
