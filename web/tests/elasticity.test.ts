import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { SpringLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { analyseElasticLink, elasticModulus, stiffnessForModulus } from "../src/education/elasticity";
import { restore, snapshot } from "../src/scene/snapshot";

function fixture(length = 2.5, string = true) {
  const a = new Body(new Vec2(0, 0), 0.1, 2);
  const b = new Body(new Vec2(length, 0), 0.1, 2);
  const link = new SpringLink(a, b, 2, 30, 0, string);
  return { a, b, link };
}

describe("Modulus and ideal elastic diagnostics", () => {
  it("converts 60 N over 2 m to 30 N/m and agrees with the engine force and energy", () => {
    const { a, b, link } = fixture();
    expect(stiffnessForModulus(60, 2)).toBe(30);
    expect(elasticModulus(link)).toBe(60);
    const before = link.toDict();
    expect(analyseElasticLink(link)).toEqual({ length: 2.5, extension: 0.5,
      force: 15, energy: 3.75, state: "taut" });
    expect(link.toDict()).toEqual(before);
    link.applyForces();
    expect(a.acc.x * a.mass).toBe(15);
    expect(b.acc.x * b.mass).toBe(-15);
    expect(link.potentialEnergy()).toBe(3.75);
  });

  it.each([
    [1.5, true, 0, 0, "slack"], [2, true, 0, 0, "slack"],
    [1.5, false, -15, 3.75, "compressed"], [2, false, 0, 0, "natural"],
    [2.5, false, 15, 3.75, "stretched"],
  ] as const)("handles length %s and string=%s", (length, string, force, energy, state) => {
    const { link } = fixture(length, string);
    expect(analyseElasticLink(link)).toMatchObject({ extension: length - 2, force, energy, state });
    link.applyForces();
    expect(link.axialForce).toBe(force);
    expect(link.potentialEnergy()).toBe(energy);
  });

  it.each([[-1, 2], [Infinity, 2], [NaN, 2], [60, 0], [60, -1], [60, Infinity],
    [60, NaN], [1e9 + 1, 1], [1, Number.MIN_VALUE]])("rejects λ=%s, l=%s without clamping", (modulus, length) => {
    expect(stiffnessForModulus(modulus, length)).toBeNull();
  });

  it("accepts zero and the exact scene stiffness ceiling", () => {
    expect(stiffnessForModulus(0, 2)).toBe(0);
    expect(stiffnessForModulus(1e15, 1e6)).toBe(1e9);
    const { link } = fixture();
    link.restLength = 0;
    expect(elasticModulus(link)).toBeNull();
    link.restLength = 2;
    link.stiffness = 0;
    expect(elasticModulus(link)).toBe(0);
  });

  it("uses authored values independently of damping and stale solver coefficients", () => {
    const { link } = fixture();
    link.damping = 100;
    link.kEff = 2;
    link.cEff = 50;
    expect(analyseElasticLink(link)).toMatchObject({ force: 15, energy: 3.75 });
    expect(link.potentialEnergy()).toBe(0.25);
  });

  it("round-trips modulus exactly through the existing scene format", () => {
    const { a, b, link } = fixture();
    const world = new World();
    world.bodies.push(a, b);
    world.links.push(link);
    const saved = snapshot(world);
    const loaded = restore(saved).links[0] as SpringLink;
    expect(elasticModulus(loaded)).toBe(60);
    expect(analyseElasticLink(loaded)).toEqual(analyseElasticLink(link));
    expect(Object.keys(JSON.parse(saved).links[0])).not.toContain("modulus");
  });

  it("models vertical equilibrium x = m g l / λ", () => {
    const { a, b, link } = fixture();
    a.locked = true;
    a.collides = false;
    b.collides = false;
    b.pos.set(0, -3);
    link.stiffness = stiffnessForModulus(39.2, 2)!;
    const world = new World();
    world.gravity = 9.8;
    world.integrator = "RK4";
    world.substeps = 4;
    world.bodies.push(a, b);
    world.links.push(link);
    world.step(1 / 120);
    expect(b.pos.y).toBeCloseTo(-3, 10);
    expect(b.vel.y).toBeCloseTo(0, 10);
    expect(analyseElasticLink(link)).toMatchObject({ extension: 1, force: 19.6, energy: 9.8 });
  });

  it("reaches maximum extension 2 m g l / λ after release at natural length", () => {
    const { a, b, link } = fixture();
    a.locked = true;
    a.collides = false;
    b.collides = false;
    b.pos.set(0, -2);
    link.stiffness = stiffnessForModulus(39.2, 2)!;
    const world = new World();
    world.gravity = 9.8;
    world.integrator = "RK4";
    world.substeps = 4;
    world.bodies.push(a, b);
    world.links.push(link);
    // Sample the analytic turning time rather than missing it between frames.
    const turningTime = Math.PI * Math.sqrt(b.mass / link.stiffness);
    const frames = Math.floor(turningTime * 120);
    for (let i = 0; i < frames; i++) {
      world.step(1 / 120);
    }
    world.step(turningTime - frames / 120);
    expect(analyseElasticLink(link).extension).toBeCloseTo(2, 8);
    expect(b.vel.y).toBeCloseTo(0, 7);
  });
});
