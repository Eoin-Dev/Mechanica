import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { World } from "../src/engine/world";
import { forceLedger } from "../src/education/analysis";
import { forceSymbols } from "../src/engine/force-diagnostics";

describe("force contact origins", () => {
  it.each([0, 25, 90, 180])("locates the supporting contact on a %s-degree surface without advancing", degrees => {
    const theta = degrees * Math.PI / 180;
    const tx = Math.cos(theta), ty = Math.sin(theta), nx = -ty, ny = tx;
    const world = new World(); world.gravity = 0;
    const body = new Body(new Vec2(nx * 0.25, ny * 0.25), 0.2, 1);
    body.showForceComponents = true; body.noRotation = true;
    body.constForce.set(-nx * 10 + tx * 2, -ny * 10 + ty * 2);
    body.friction = 1; body.restitution = 0;
    const wall = new Wall(new Vec2(-tx * 3, -ty * 3), new Vec2(tx * 3, ty * 3), 0.1);
    wall.friction = 1; wall.restitution = 0;
    world.bodies.push(body); world.walls.push(wall);
    const before = world.toDict();
    const ledger = forceLedger(world, body);
    for (const id of [`reaction-wall-${wall.id}`, `friction-wall-${wall.id}`]) {
      const force = ledger.entries.find(entry => entry.id === id)!;
      expect(force).toBeDefined();
      expect(force.contactNx).toBeCloseTo(-nx, 10);
      expect(force.contactNy).toBeCloseTo(-ny, 10);
      expect(Object.isFrozen(force)).toBe(true);
    }
    expect(ledger.entries.find(entry => entry.kind === "applied")?.contactNx).toBeUndefined();
    expect(world.toDict()).toEqual(before);
    expect(world.time).toBe(0);
  });

  it.each([false, true])("locates a capsule end contact, including a point wall (%s)", point => {
    const world = new World(); world.gravity = 0;
    const body = new Body(new Vec2(0.25, 0), 0.2, 1);
    body.showForceComponents = true; body.noRotation = true; body.friction = 1;
    body.constForce.set(-10, 2);
    const wall = new Wall(new Vec2(point ? 0 : -3, 0), new Vec2(0, 0), 0.1);
    wall.friction = 1; wall.restitution = 0;
    world.bodies.push(body); world.walls.push(wall);
    for (const kind of ["reaction", "friction"]) {
      const force = forceLedger(world, body).entries.find(entry => entry.kind === kind)!;
      expect(force.contactNx).toBeCloseTo(-1, 12); expect(force.contactNy).toBeCloseTo(0, 12);
    }
  });

  it("keeps body contact origins opposite on the two surfaces during an impact", () => {
    const world = new World(); world.gravity = 0; world.substeps = 1;
    const a = new Body(new Vec2(-0.201, 0), 0.2, 1);
    const b = new Body(new Vec2(0.201, 0), 0.2, 1);
    a.vel.x = 1; b.vel.x = -1;
    a.restitution = b.restitution = 1; a.friction = b.friction = 0;
    a.showForceComponents = b.showForceComponents = true;
    world.bodies.push(a, b); world.step(0.002);
    const ra = forceLedger(world, a).entries.find(entry => entry.kind === "reaction")!;
    const rb = forceLedger(world, b).entries.find(entry => entry.kind === "reaction")!;
    expect(ra.contactNx).toBeCloseTo(1, 12); expect(ra.contactNy).toBeCloseTo(0, 12);
    expect(rb.contactNx).toBeCloseTo(-1, 12); expect(rb.contactNy).toBeCloseTo(0, 12);
    expect(ra.fx).toBeLessThan(0); expect(rb.fx).toBeGreaterThan(0);
  });

  it("locates floor friction at the rim with the same torque sign as the spinning body", () => {
    const world = new World(); world.substeps = 1;
    const body = new Body(new Vec2(0, 0.249), 0.2, 2);
    body.vel.x = 2; body.noRotation = false; body.friction = 0.7;
    body.restitution = 0; body.showForceComponents = true;
    const floor = new Wall(new Vec2(-3, 0), new Vec2(3, 0), 0.1);
    floor.friction = 0.7; floor.restitution = 0;
    world.bodies.push(body); world.walls.push(floor); world.step(1 / 120);
    const friction = forceLedger(world, body).entries.find(entry => entry.kind === "friction")!;
    const moment = body.radius * (friction.contactNx! * friction.fy - friction.contactNy! * friction.fx);
    expect(friction.contactNx).toBeCloseTo(0, 12); expect(friction.contactNy).toBeCloseTo(-1, 12);
    expect(moment).toBeLessThan(0); expect(body.omega).toBeLessThan(0);
    expect(forceLedger(world, body).entries.find(entry => entry.kind === "weight")?.contactNx).toBeUndefined();
  });

  it("reserves unindexed F for friction and lowercase indexed f for applied forces", () => {
    const entries = [
      { id: "friction-wall-1", label: "Friction from floor", kind: "friction" as const, fx: -2, fy: 0 },
      { id: "friction-body-1", label: "Friction from neighbour", kind: "friction" as const, fx: 0, fy: 3 },
      { id: "applied", label: "Applied", kind: "applied" as const, fx: 1, fy: 0 },
      { id: "field-1", label: "Wind", kind: "field" as const, fx: 0, fy: 1 },
    ];
    expect([...forceSymbols(entries).values()]).toEqual(["F", "F", "f₁", "f₂"]);
  });
});
