/** Point-particle bodies: noRotation zeroes rotational inertia so contact
 * friction produces no torque. Such a body rests in limiting equilibrium on
 * a slope (mu >= tan theta) instead of rolling like a rigid disc. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { World } from "../src/engine/world";

const DT = 1.0 / 120.0;

function slopeRun(thetaDeg: number, mu: number, noRotation: boolean): {
  slid: number; omega: number;
} {
  const th = (thetaDeg * Math.PI) / 180;
  const w = new World();
  w.substeps = 8;
  w.iterations = 15;
  const dir = new Vec2(Math.cos(th), -Math.sin(th)); // down-slope unit
  const wall = new Wall(dir.mul(-4), dir.mul(4), 0.1);
  wall.friction = mu;
  wall.restitution = 0.0;
  w.walls.push(wall);
  const r = 0.15;
  const nrm = new Vec2(Math.sin(th), Math.cos(th)); // up-slope normal
  const disc = new Body(nrm.mul(r + 0.05), r, 1.0);
  disc.friction = mu;
  disc.restitution = 0.0;
  disc.noRotation = noRotation;
  w.bodies.push(disc);
  const along = () => disc.pos.x * dir.x + disc.pos.y * dir.y;
  const s0 = along();
  for (let i = 0; i < 240; i++) w.step(DT); // 2 seconds
  return { slid: along() - s0, omega: disc.omega };
}

describe("no-rotation (point particle) bodies", () => {
  it("zeroes rotational inertia while keeping mass", () => {
    const b = new Body(new Vec2(0, 0), 0.2, 3.0);
    expect(b.invInertia).toBeGreaterThan(0);
    b.noRotation = true;
    expect(b.invInertia).toBe(0);
    expect(b.invMass).toBeCloseTo(1 / 3, 12); // translation unaffected
  });

  it("rests in limiting equilibrium at mu >= tan(theta)", () => {
    // mu = 1 -> holds up to 45 deg
    const hold = slopeRun(40, 1.0, true); // tan40 = 0.84 < 1
    const slide = slopeRun(50, 1.0, true); // tan50 = 1.19 > 1
    expect(Math.abs(hold.slid)).toBeLessThan(0.01); // essentially static
    expect(hold.omega).toBe(0); // never rotates
    expect(slide.slid).toBeGreaterThan(0.3); // clearly slides down
    expect(slide.omega).toBe(0); // slides without spinning
  });

  it("a normal disc rolls where the point particle would hold", () => {
    const disc = slopeRun(40, 1.0, false); // rolls down
    const point = slopeRun(40, 1.0, true); // holds
    expect(Math.abs(disc.slid)).toBeGreaterThan(0.3);
    expect(Math.abs(disc.omega)).toBeGreaterThan(1.0); // it spun up
    expect(Math.abs(point.slid)).toBeLessThan(0.01);
  });

  it("survives a serialization round-trip and clears any spin", () => {
    const b = new Body(new Vec2(1, 2), 0.15, 1.0);
    b.noRotation = true;
    b.omega = 5.0; // stale spin
    const restored = Body.fromDict(b.toDict());
    expect(restored.noRotation).toBe(true);
    expect(restored.omega).toBe(0);
    expect(restored.invInertia).toBe(0);
    // legacy scenes (no field) default to a normal rotating disc
    const legacy = b.toDict();
    delete legacy.no_rotation;
    expect(Body.fromDict(legacy).noRotation).toBe(false);
  });
});
