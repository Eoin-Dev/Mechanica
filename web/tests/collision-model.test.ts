/** Isolated exam-style collision laws at the actual solver settings. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { World } from "../src/engine/world";

function run(world: World, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 120); i++) world.step(1 / 120);
}

function pair(e: number) {
  const world = new World();
  world.gravity = 0;
  world.substeps = 4;
  const a = new Body(new Vec2(-2, 0), 0.15, 2);
  const b = new Body(new Vec2(2, 0), 0.15, 3);
  a.vel.set(4, 2); b.vel.set(-1, 2);
  a.restitution = e; b.restitution = 1;
  a.friction = b.friction = 0;
  a.noRotation = b.noRotation = true;
  world.bodies.push(a, b);
  return { world, a, b };
}

describe("Isolated restitution", () => {
  it.each([0, 0.6, 1])("matches unequal-mass momentum and relative normal speed for e=%s", e => {
    const { world, a, b } = pair(e);
    const initial = world.momentum().copy();
    const before = world.energy().ke;
    run(world, 2);
    const separation = e * 5;
    const expectedA = (initial.x - b.mass * separation) / (a.mass + b.mass);
    const expectedB = expectedA + separation;
    expect(a.vel.x).toBeCloseTo(expectedA, 10);
    expect(b.vel.x).toBeCloseTo(expectedB, 10);
    expect(b.vel.x - a.vel.x).toBeCloseTo(separation, 10);
    expect(a.vel.y).toBeCloseTo(2, 10);
    expect(b.vel.y).toBeCloseTo(2, 10);
    expect(world.momentum().x).toBeCloseTo(initial.x, 10);
    expect(world.momentum().y).toBeCloseTo(initial.y, 10);
    const reducedMass = a.mass * b.mass / (a.mass + b.mass);
    expect(before - world.energy().ke).toBeCloseTo(0.5 * reducedMass * (1 - e * e) * 25, 10);
  });

  it.each([[1, 0.5], [0.5, 1]])("uses the lower body/wall coefficient (%s, %s) and leaves smooth tangential motion unchanged", (bodyE, wallE) => {
    const world = new World();
    world.gravity = 0;
    world.substeps = 4;
    const wall = new Wall(new Vec2(-20, 0), new Vec2(20, 0), 0.1);
    wall.restitution = wallE; wall.friction = 0;
    const body = new Body(new Vec2(0, 2), 0.15, 2);
    body.restitution = bodyE; body.friction = 0;
    body.vel.set(4, -3); body.noRotation = true;
    world.bodies.push(body); world.walls.push(wall);
    run(world, 1);
    expect(body.vel.x).toBeCloseTo(4, 10);
    expect(body.vel.y).toBeCloseTo(1.5, 10);
    expect(body.mass * (body.vel.y + 3)).toBeCloseTo(9, 10);
    expect(body.pos.y).toBeGreaterThan(body.radius + wall.thickness / 2);
  });

  it("does not join zero-restitution bodies when a later force separates them", () => {
    const { world, a, b } = pair(0);
    run(world, 2);
    expect(a.vel.x).toBeCloseTo(b.vel.x, 10);
    const separation = b.pos.x - a.pos.x;
    b.constForce.x = 3;
    run(world, 0.5);
    expect(b.vel.x - a.vel.x).toBeCloseTo(0.5, 10);
    expect(b.pos.x - a.pos.x).toBeGreaterThan(separation + 0.1);
    expect(world.links).toHaveLength(0);
  });
});
