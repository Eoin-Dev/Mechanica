/** Position-based static friction: a non-rotating body at rest on a slope
 * must not creep down-slope (the operator-split drift the velocity solver
 * leaves behind), while still sliding once the slope exceeds the friction
 * limit - and without disturbing a rotating disc, which correctly rolls. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { World } from "../src/engine/world";

const DT = 1.0 / 120.0;

function slope(thetaDeg: number, mu: number, noRotation: boolean, seconds = 5) {
  const th = (thetaDeg * Math.PI) / 180;
  const w = new World();
  w.substeps = 8;
  w.iterations = 15;
  const dir = new Vec2(Math.cos(th), -Math.sin(th)); // down-slope unit
  const wall = new Wall(dir.mul(-4), dir.mul(4), 0.1);
  wall.friction = mu;
  wall.restitution = 0.0;
  w.walls.push(wall);
  const nrm = new Vec2(Math.sin(th), Math.cos(th));
  const disc = new Body(nrm.mul(0.2), 0.15, 1.0);
  disc.friction = mu;
  disc.restitution = 0.0;
  disc.noRotation = noRotation;
  w.bodies.push(disc);
  const along = () => disc.pos.x * dir.x + disc.pos.y * dir.y;
  for (let i = 0; i < 12; i++) w.step(DT); // seat
  const s0 = along();
  for (let i = 0; i < seconds * 120; i++) w.step(DT);
  return { slid: along() - s0, omega: disc.omega, vel: disc.vel.length() };
}

describe("resting static friction (no creep)", () => {
  it("a non-rotating body does not creep on a shallow slope", () => {
    for (const deg of [3, 10, 20, 30, 40]) {
      const { slid } = slope(deg, 1.0, true); // all below the 45deg limit
      expect(Math.abs(slid)).toBeLessThan(1e-4); // < 0.1 mm over 5 s
    }
  });

  it("still slides once the slope passes the friction limit", () => {
    const { slid } = slope(50, 1.0, true); // tan50 = 1.19 > mu = 1
    expect(slid).toBeGreaterThan(1.0); // clearly runs down the slope
  });

  it("respects the friction coefficient: lower mu holds a gentler slope only", () => {
    // mu = 0.3 -> holds up to atan(0.3) = 16.7 deg
    expect(Math.abs(slope(10, 0.3, true).slid)).toBeLessThan(1e-4); // holds
    expect(slope(30, 0.3, true).slid).toBeGreaterThan(0.5);         // slides
  });

  it("does not freeze a rotating disc: it still rolls down", () => {
    const { slid, omega } = slope(30, 1.0, false, 2);
    expect(Math.abs(slid)).toBeGreaterThan(0.5); // rolled a long way
    expect(Math.abs(omega)).toBeGreaterThan(5.0); // and spun up
  });

  it("holds position across a stationary rest (no slow drift accumulation)", () => {
    const short = slope(25, 1.0, true, 1).slid;
    const long = slope(25, 1.0, true, 8).slid;
    // drift must not grow with time - both are ~zero, not 8x apart
    expect(Math.abs(long)).toBeLessThan(1e-4);
    expect(Math.abs(short)).toBeLessThan(1e-4);
  });

  it("reads exactly zero velocity at rest (no solver-noise flicker)", () => {
    // in limiting equilibrium the readout used to flicker with tiny
    // sign-alternating solver noise; a body the anchor pins is STILL
    for (const deg of [3, 20, 40]) {
      expect(slope(deg, 1.0, true).vel).toBe(0);
    }
  });
});

/** Two non-rotating blocks stacked on a ramp, well inside the friction
 * limit. Both ends of the block-on-block contact are pinnable, which is the
 * case the anchor used to get wrong: it measured the LOWER block's drift and
 * then split a correction between the two in opposite directions, driving
 * them apart along the surface a little more every substep. */
function stackOnSlope(thetaDeg: number, mu: number, seconds: number) {
  const th = (thetaDeg * Math.PI) / 180;
  const w = new World();
  w.substeps = 4;
  w.iterations = 12;
  const dir = new Vec2(Math.cos(th), -Math.sin(th)); // down-slope unit
  const nrm = new Vec2(Math.sin(th), Math.cos(th));
  const wall = new Wall(dir.mul(-4), dir.mul(4), 0.12);
  wall.friction = mu;
  wall.restitution = 0.0;
  w.walls.push(wall);
  const block = (up: number, m: number): Body => {
    const p = nrm.mul(0.06 + 0.2 + up);
    const b = new Body(new Vec2(p.x, p.y), 0.2, m);
    b.noRotation = true;
    b.friction = mu;
    b.restitution = 0.0;
    w.bodies.push(b);
    return b;
  };
  const lower = block(0.0, 2.0);
  const upper = block(0.4, 1.0);
  for (let i = 0; i < 12; i++) w.step(DT); // seat
  const slip = (): number =>
    (upper.pos.x - lower.pos.x) * dir.x + (upper.pos.y - lower.pos.y) * dir.y;
  const s0 = slip();
  const along = (b: Body): number => b.pos.x * dir.x + b.pos.y * dir.y;
  const l0 = along(lower);
  for (let i = 0; i < seconds * 120; i++) w.step(DT);
  return { slip: slip() - s0, lowerSlid: along(lower) - l0, world: w };
}

describe("static friction with both ends pinnable", () => {
  it("a stacked pair does not slide apart on a slope", () => {
    // At 15 degrees with mu = 2 the friction angle is 63 degrees: nothing
    // should move at all. This used to reach 0.28 m of relative slip inside
    // one second - 800 times what the same scene drifts with the anchor
    // switched off entirely, i.e. the creep-remover was the creep.
    const { slip } = stackOnSlope(15, 2.0, 5);
    expect(Math.abs(slip)).toBeLessThan(1e-3);
  });

  it("neither block creeps down-slope either", () => {
    const { lowerSlid } = stackOnSlope(15, 2.0, 5);
    expect(Math.abs(lowerSlid)).toBeLessThan(1e-3);
  });

  it("holds indefinitely rather than drifting with time", () => {
    // the artifact grew every substep, so it showed up as a slip that
    // scaled with the run length; a real pin does not
    const short = Math.abs(stackOnSlope(15, 2.0, 1).slip);
    const long = Math.abs(stackOnSlope(15, 2.0, 8).slip);
    expect(long).toBeLessThan(1e-3);
    expect(long).toBeLessThan(Math.max(short, 1e-5) * 3);
  });

  it("holds across a range of slopes inside the friction limit", () => {
    for (const deg of [5, 10, 20, 30]) {
      const { slip, lowerSlid } = stackOnSlope(deg, 2.0, 3);
      expect(Math.abs(slip), `${deg} deg slip`).toBeLessThan(1e-3);
      expect(Math.abs(lowerSlid), `${deg} deg creep`).toBeLessThan(1e-3);
    }
  });

  it("still lets the pair slide once the slope beats the friction limit", () => {
    // the pin must not become a weld: past the friction angle both blocks
    // run down the slope as they should
    const { lowerSlid } = stackOnSlope(50, 0.3, 3);
    expect(lowerSlid).toBeGreaterThan(1.0);
  });

  it("keeps a level stack exactly put", () => {
    const { slip, lowerSlid } = stackOnSlope(0, 1.0, 5);
    expect(slip).toBe(0);
    expect(lowerSlid).toBe(0);
  });
});
