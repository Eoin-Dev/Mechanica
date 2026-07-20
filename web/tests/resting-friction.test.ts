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
