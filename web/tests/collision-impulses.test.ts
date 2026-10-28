import { describe, expect, it } from "vitest";
import { Body, Wall } from "../src/engine/body";
import { World } from "../src/engine/world";
import { Vec2 } from "../src/core/vec";
import { RewindBuffer, snapshot } from "../src/scene/snapshot";
import { forceLedger, sustainedForceLedger, rodMomentAnalysis } from "../src/education/analysis";
import { PRESETS } from "../src/scene/presets";

function collision(e: number, diagrams = false) {
  const world = new World(); world.gravity = 0; world.substeps = 8;
  const body = new Body(new Vec2(0, .26), .2, 2);
  const floor = new Wall(new Vec2(-2, 0), new Vec2(2, 0), .1);
  body.vel.y = -2; body.noRotation = true; body.restitution = floor.restitution = e;
  body.friction = floor.friction = 0; body.showForceComponents = diagrams;
  world.bodies.push(body); world.walls.push(floor);
  world.step(.02); return { world, body, floor };
}

describe("measured collision impulses", () => {
  it.each([0, .5, 1])("records J=m(v-u) for restitution %s even with diagrams off", e => {
    const { world, body } = collision(e);
    expect(body.forceSnapshot).toBeNull(); expect(world.collisionImpulses).toHaveLength(1);
    const impulse = world.collisionImpulses[0];
    expect(impulse.jx).toBeCloseTo(0, 10); expect(impulse.jy).toBeCloseTo(4 * (1 + e), 10);
    expect(impulse.jy).toBeCloseTo(body.mass * (body.vel.y + 2), 10);
    expect(impulse.contactNy).toBe(-1);
    expect(impulse.time).toBeGreaterThan(0); expect(impulse.time).toBeLessThanOrEqual(world.time);
  });
  it("keeps the impact after contact has vanished and restores it from rewind without putting it in scene JSON", () => {
    const { world } = collision(1);
    expect(world.contacts).toHaveLength(0);
    const history = new RewindBuffer(); history.push(world);
    const measured = world.collisionImpulses[0]; world.step(.02); history.push(world);
    const restored = history.back()!;
    expect(restored.collisionImpulses).toEqual([measured]);
    expect(snapshot(world)).not.toContain("collisionImpulses");
    expect(world.collisionImpulses).toHaveLength(0);
    expect(restored.collisionImpulses[0]).toEqual(measured);
    restored.clearForceDiagnostics(); expect(restored.collisionImpulses).toHaveLength(0);
  });
  it("separates impacts from sustained forces without changing raw momentum accounting", () => {
    const { world, body } = collision(1, true);
    const raw = forceLedger(world, body), before = body.forceSnapshot;
    expect(raw.resultant.fy).toBeCloseTo(400, 8);
    const sustained = sustainedForceLedger(world, body, raw);
    expect(sustained.resultant.fy).toBeCloseTo(0, 8);
    expect(sustained.entries).toHaveLength(0); expect(body.forceSnapshot).toBe(before);
    body.showCollisionImpulses = false;
    expect(sustainedForceLedger(world, body, raw)).toBe(raw);
  });
  it("records equal and opposite impulses for simultaneous independent contacts", () => {
    const world = new World(); world.gravity = 0; world.substeps = 1;
    for (const y of [-1, 1]) {
      const a = new Body(new Vec2(-.199, y), .2, 1), b = new Body(new Vec2(.199, y), .2, 1);
      a.vel.x = 1; b.vel.x = -1; a.restitution = b.restitution = 1;
      a.friction = b.friction = 0; world.bodies.push(a, b);
    }
    world.step(.001); expect(world.collisionImpulses).toHaveLength(4);
    for (let i = 0; i < 4; i += 2) {
      const a = world.collisionImpulses.find(entry => entry.bodyId === world.bodies[i].id)!;
      const b = world.collisionImpulses.find(entry => entry.bodyId === world.bodies[i + 1].id)!;
      expect(a.jx).toBeCloseTo(-2, 9); expect(b.jx).toBeCloseTo(2, 9);
      expect(a.jx + b.jx).toBeCloseTo(0, 12);
    }
  });
  it.each([1, 4, 8])("does not classify ordinary resting support as an impact at %s substeps", substeps => {
    const world = new World(); world.substeps = substeps;
    const body = new Body(new Vec2(0, .2499), .2);
    const floor = new Wall(new Vec2(-2, 0), new Vec2(2, 0), .1);
    body.restitution = floor.restitution = 0; world.bodies.push(body); world.walls.push(floor);
    for (let i = 0; i < 60; i++) { world.step(1 / 60); expect(world.collisionImpulses).toHaveLength(0); }
  });
  it.each([.03, .3, 2])("records a new slow or fast inelastic impact at %s m/s", speed => {
    const world = new World(); world.gravity = 0; world.substeps = 1;
    const body = new Body(new Vec2(0, .25001), .2, 2);
    const floor = new Wall(new Vec2(-2, 0), new Vec2(2, 0), .1);
    body.vel.y = -speed; body.noRotation = true;
    body.restitution = floor.restitution = 0; body.friction = floor.friction = 0;
    world.bodies.push(body); world.walls.push(floor);
    world.step(.01);
    expect(world.collisionImpulses).toHaveLength(1);
    expect(world.collisionImpulses[0].jy).toBeCloseTo(2 * speed, 10);
    expect(body.vel.y).toBeCloseTo(0, 10);
    world.step(.01); expect(world.collisionImpulses).toHaveLength(0);
    // The contact remains cached, but a new approach is another real impact.
    body.vel.y = -speed; world.step(.01);
    expect(world.collisionImpulses).toHaveLength(1);
    expect(world.collisionImpulses[0].jy).toBeCloseTo(2 * speed, 10);
  });
  it("does not turn a supported stack's gravity load into collision arrows", () => {
    const world = new World(); world.substeps = 1; world.iterations = 32;
    const floor = new Wall(new Vec2(-2, 0), new Vec2(2, 0), .1); floor.restitution = 0;
    for (const y of [.2499, .6498, 1.0497]) {
      const body = new Body(new Vec2(0, y), .2); body.noRotation = true;
      body.restitution = 0; world.bodies.push(body);
    }
    world.walls.push(floor);
    for (let i = 0; i < 60; i++) {
      world.step(1 / 60); expect(world.collisionImpulses).toHaveLength(0);
    }
  });
  it("records an arrival accelerated from rest above the floor", () => {
    const world = new World(); world.substeps = 1;
    const body = new Body(new Vec2(0, .2501), .2, 2);
    const floor = new Wall(new Vec2(-2, 0), new Vec2(2, 0), .1);
    body.restitution = floor.restitution = 0;
    world.bodies.push(body); world.walls.push(floor); world.step(.01);
    expect(world.collisionImpulses).toHaveLength(1);
    expect(world.collisionImpulses[0].jy).toBeCloseTo(2 * world.gravity * .01, 10);
  });
  it.each([.03, 2])("observes an inelastic impulse propagated through touching particles at %s m/s", speed => {
    const world = new World(); world.gravity = 0; world.substeps = 1; world.iterations = 64;
    for (const x of [0, .3999, .7998]) {
      const body = new Body(new Vec2(x, 0), .2, 1);
      body.restitution = body.friction = 0; body.noRotation = true; world.bodies.push(body);
    }
    world.bodies[0].vel.x = speed; world.step(.001);
    expect(world.collisionImpulses).toHaveLength(4);
    for (const body of world.bodies) {
      const impulse = world.collisionImpulses.filter(entry => entry.bodyId === body.id)
        .reduce((sum, entry) => sum + entry.jx, 0);
      expect(impulse).toBeCloseTo(body.mass * (body.vel.x - (body === world.bodies[0] ? speed : 0)), 9);
      expect(body.vel.x).toBeCloseTo(speed / 3, 4);
    }
  });
});

describe("rod moments", () => {
  it("shows signed weight moments about the balanced beam pivot", () => {
    const world = PRESETS.find(preset => preset.name === "Balanced beam")!.build();
    const loads = world.bodies.filter(body => !body.isAnchor && !body.isRodEndpoint);
    const readings = loads.map(body => rodMomentAnalysis(world, body, forceLedger(world, body))!);
    expect(readings.map(reading => reading.reference)).toEqual(["Anchor", "Anchor"]);
    const moments = readings.map(reading => reading.entries.find(entry => entry.id === "weight")!.moment);
    expect(moments[0]).toBeCloseTo(19.6, 10); expect(moments[1]).toBeCloseTo(-19.6, 10);
    expect(moments[0] + moments[1]).toBeCloseTo(0, 10);
  });
  it("uses physical centre of mass for a free rod and contact application points for friction", () => {
    const world = PRESETS.find(preset => preset.name === "Balanced beam")!.build();
    world.bodies = world.bodies.filter(body => !body.isPivot);
    const body = world.bodies.find(body => !body.isRodEndpoint)!;
    const ledger = { ...forceLedger(world, body), entries: [{ id: "friction", label: "Friction", kind: "friction" as const,
      fx: 3, fy: 0, contactNx: 0, contactNy: -1 }] };
    const moment = rodMomentAnalysis(world, body, ledger)!;
    expect(moment.reference).toBe("Rod centre of mass"); expect(moment.x).toBeCloseTo(0, 10);
    expect(moment.moment).toBeCloseTo(body.radius * 3, 10);
  });
});
