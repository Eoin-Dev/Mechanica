/** Physical measurements must not depend on solver work-suppression flags. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { World } from "../src/engine/world";
import { snapshot } from "../src/scene/snapshot";

describe("Sleeping-particle system measurements", () => {
  it.each([[0, 0], [1000, -300]])("retains a resting particle's mass with origin translated by (%s, %s)", (dx, dy) => {
    const world = new World();
    const moving = new Body(new Vec2(-2 + dx, dy), 0.15, 2);
    const resting = new Body(new Vec2(2 + dx, dy), 0.15, 3);
    moving.vel.set(0, 1);
    world.bodies.push(moving, resting);
    for (const sleeping of [false, true, false]) {
      resting.perfSleeping = sleeping;
      expect(world.centreOfMass()!.x).toBeCloseTo(0.4 + dx, 10);
      expect(world.centreOfMass()!.y).toBeCloseTo(dy, 10);
      expect(world.angularMomentum()).toBeCloseTo(-4.8, 10);
      expect(world.momentum()).toEqual(new Vec2(0, 2));
    }
  });

  it("retains a weighted centre when every physical particle sleeps", () => {
    const world = new World();
    const a = new Body(new Vec2(-2, 1), 0.15, 2);
    const b = new Body(new Vec2(2, -1), 0.15, 3);
    a.perfSleeping = b.perfSleeping = true;
    world.bodies.push(a, b);
    expect(world.centreOfMass()).toEqual(new Vec2(0.4, -0.2));
    expect(world.angularMomentum()).toBe(0);
    expect(world.momentum()).toEqual(new Vec2());
  });

  it("matches independent mass and angular accounting through real floor sleep and wake", () => {
    const world = new World();
    world.performance = true;
    world.performanceLevel = 3;
    world.walls.push(new Wall(new Vec2(-5, 0), new Vec2(5, 0), 0.2));
    const moving = new Body(new Vec2(-2, 10), 0.1, 2);
    moving.vel.set(1, 0);
    const resting = new Body(new Vec2(2, 0.2), 0.1, 3);
    resting.restitution = 0;
    world.bodies.push(moving, resting);
    for (let i = 0; i < 80 && !resting.perfSleeping; i++) world.step(1 / 120);
    expect(resting.perfSleeping).toBe(true);
    expect(resting.vel).toEqual(new Vec2());
    const x = (2 * moving.pos.x + 3 * resting.pos.x) / 5;
    const y = (2 * moving.pos.y + 3 * resting.pos.y) / 5;
    const angular = 2 * ((moving.pos.x - x) * moving.vel.y -
      (moving.pos.y - y) * moving.vel.x) + moving.inertia * moving.omega;
    const state = snapshot(world);
    for (let i = 0; i < 2; i++) {
      expect(world.centreOfMass()!.x).toBeCloseTo(x, 12);
      expect(world.centreOfMass()!.y).toBeCloseTo(y, 12);
      expect(world.angularMomentum()).toBeCloseTo(angular, 12);
      expect(world.momentum().x).toBeCloseTo(2 * moving.vel.x, 12);
      expect(world.momentum().y).toBeCloseTo(2 * moving.vel.y, 12);
      world.wakePerformanceBodies();
      expect(snapshot(world)).toBe(state);
    }
    expect(resting.perfSleeping).toBe(false);
  });

  it("keeps locked, held, zero-mass and internal solver objects outside dynamic diagnostics", () => {
    const world = new World();
    const body = new Body(new Vec2(7, -3), 0.15, 2);
    body.vel.set(3, -4); body.omega = 2;
    const excluded = ["locked", "held", "zero", "internal", "anchor"].map(kind => {
      const item = new Body(new Vec2(1000, 1000), 10, 500);
      item.vel.set(100, 100); item.omega = 100;
      if (kind === "locked") item.locked = true;
      if (kind === "held") item.held = true;
      if (kind === "zero") item.mass = 0;
      if (kind === "internal") item.isRodEndpoint = true;
      if (kind === "anchor") { item.isAnchor = true; item.locked = true; }
      return item;
    });
    world.bodies.push(body, ...excluded);
    expect(world.centreOfMass()).toEqual(new Vec2(7, -3));
    expect(world.momentum()).toEqual(new Vec2(6, -8));
    expect(world.angularMomentum()).toBeCloseTo(0.045, 12);
  });

  it.each(["empty", "fixed only"])("has no dynamic centre for %s scenes", kind => {
    const world = new World();
    if (kind === "fixed only") {
      const anchor = new Body(new Vec2(10, 20), 0.1, 2);
      anchor.isAnchor = anchor.locked = true;
      world.bodies.push(anchor);
    }
    expect(world.centreOfMass()).toBeNull();
    expect(world.angularMomentum()).toBe(0);
    expect(world.momentum()).toEqual(new Vec2());
  });
});
