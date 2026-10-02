import { afterEach, describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { Contact } from "../src/engine/contacts";
import { INTEGRATORS, World } from "../src/engine/world";
import { forceLedger } from "../src/education/analysis";
import { RewindBuffer, snapshot } from "../src/scene/snapshot";

const initialBudget = RewindBuffer.BUDGET_BYTES;
afterEach(() => { RewindBuffer.BUDGET_BYTES = initialBudget; });

function impact(integrator: typeof INTEGRATORS[number], performance: boolean) {
  const world = new World(); world.gravity = 0; world.substeps = 4;
  world.integrator = integrator; world.performance = performance; world.performanceLevel = 3;
  const body = new Body(new Vec2(0, 0.23), 0.2, 1);
  body.vel.y = -3; body.restitution = 1; body.friction = 0; body.showForceComponents = true;
  const wall = new Wall(new Vec2(-3, 0), new Vec2(3, 0), 0.04);
  wall.restitution = 1; wall.friction = 0;
  world.bodies.push(body); world.walls.push(wall);
  return { world, body };
}

function show(world: World) { for (const body of world.bodies) body.showForceComponents = true; }

describe("rewound diagnostic ownership", () => {
  for (const integrator of INTEGRATORS) {
    it.each([false, true])(`preserves a completed ${integrator} impact after contact has ended (Performance %s)`, performance => {
      const { world, body } = impact(integrator, performance);
      const buffer = new RewindBuffer(); buffer.push(world);
      world.step(1 / 60); buffer.push(world);
      const original = forceLedger(world, body);
      expect(original.mode).toBe("step-average");
      expect(original.entries.find(e => e.kind === "reaction")!.fy).toBeCloseTo(360, 9);
      expect(body.vel.y).toBeCloseTo(3, 9);
      if (!performance) expect(world.contacts).toHaveLength(0);
      const state = snapshot(world);
      world.step(1 / 60); buffer.push(world);
      const restored = buffer.back()!; show(restored);
      expect(snapshot(restored)).toBe(state);
      expect(forceLedger(restored, restored.bodies[0])).toEqual(original);
      expect(Object.isFrozen(restored.bodies[0].forceSnapshot)).toBe(true);
      expect(restored.bodies[0].forceSnapshot!.entries.every(Object.isFrozen)).toBe(true);
    });
  }

  it("owns source data independently of subsequent live steps and body deletion", () => {
    const { world, body } = impact("RK4", false);
    world.step(1 / 60);
    const original = body.forceSnapshot!;
    const buffer = new RewindBuffer(); buffer.push(world);
    body.name = "Renamed after collision"; world.removeBody(body); buffer.push(world);
    const restored = buffer.back()!; show(restored);
    expect(restored.bodies[0].forceSnapshot).toEqual(original);
    expect(restored.bodies[0].forceSnapshot!.entries.find(e => e.kind === "reaction")!.contactNy).toBe(-1);
    expect(snapshot(restored)).not.toContain("forceSnapshot");
  });

  it("restores independent contact records including zero and absent identities", () => {
    const world = new World(); world.bodies.push(new Body(new Vec2(0, 2)));
    world.contacts.push(new Contact(1, 2, 0, 1, 3, 0, 0, null, -4),
      new Contact(5, 6, -1, 0, 7, 0, null, 0, 8));
    const expected = world.contacts.map(contact => ({ ...contact }));
    const buffer = new RewindBuffer(); buffer.push(world);
    world.contacts[0].impulse = 900; world.contacts[1].wallId = 99;
    world.contacts.length = 0; world.time = 1; buffer.push(world);
    const restored = buffer.back()!;
    expect(restored.contacts.map(contact => ({ ...contact }))).toEqual(expected);
    expect(restored.contacts.every(contact => contact instanceof Contact)).toBe(true);
    restored.contacts[0].impulse = 700;
    world.time = 2; buffer.push(world);
    expect(buffer.back()!.contacts.map(contact => ({ ...contact }))).toEqual(expected);
  });

  it("freezes an owned copy of an externally supplied mutable source record", () => {
    const { world, body } = impact("RK4", false); world.step(1 / 60);
    const original = body.forceSnapshot!;
    const mutable = { ...original, entries: original.entries.map(entry => ({ ...entry })) };
    body.forceSnapshot = mutable;
    const buffer = new RewindBuffer(); buffer.push(world);
    mutable.entries[0].label = "Changed after capture";
    mutable.entries[0].fy = 0; mutable.endTime = 99;
    world.step(1 / 60); buffer.push(world);
    const restored = buffer.back()!; show(restored);
    expect(restored.bodies[0].forceSnapshot).toEqual(original);
    expect(Object.isFrozen(restored.bodies[0].forceSnapshot!.entries)).toBe(true);
  });

  it("charges contact storage to the same history budget and reclaims it on rewind", () => {
    const world = new World(); world.bodies.push(new Body(new Vec2(0, 2)));
    const baseline = new RewindBuffer(); baseline.push(world); const baseBytes = baseline.bytesUsed;
    world.contacts.push(new Contact(0, 0, 0, 1, 4, world.bodies[0].id));
    const buffer = new RewindBuffer(); buffer.push(world);
    expect(buffer.bytesUsed).toBeGreaterThan(baseBytes);
    const firstBytes = buffer.bytesUsed;
    world.contacts.push(new Contact(1, 0, 1, 0, 2, world.bodies[0].id)); buffer.push(world);
    expect(buffer.bytesUsed).toBeGreaterThan(firstBytes);
    expect(buffer.back()!.contacts).toHaveLength(1);
    expect(buffer.bytesUsed).toBe(firstBytes);
    RewindBuffer.BUDGET_BYTES = baseBytes;
    expect(new RewindBuffer().push(world)).toBe("too-large");
  });

  it("charges named-source storage including strings to the history budget", () => {
    const { world, body } = impact("RK4", false); world.step(1 / 60);
    const sample = body.forceSnapshot!; body.forceSnapshot = null;
    const baseline = new RewindBuffer(); baseline.push(world); const baseBytes = baseline.bytesUsed;
    body.forceSnapshot = sample; const buffer = new RewindBuffer(); buffer.push(world);
    expect(buffer.bytesUsed).toBeGreaterThan(baseBytes);
    RewindBuffer.BUDGET_BYTES = baseBytes;
    const rejected = new RewindBuffer(); expect(rejected.push(world)).toBe("too-large");
    expect(rejected.bytesUsed).toBe(0); expect(rejected.length).toBe(0);
  });

  it("restored diagnostics do not alter future solver motion", () => {
    const { world } = impact("RK4", false); world.step(1 / 60);
    const buffer = new RewindBuffer(); buffer.push(world);
    const input = snapshot(world); world.step(1 / 60); buffer.push(world);
    const restored = buffer.back()!; const control = World.fromDict(JSON.parse(input));
    show(restored); show(control);
    for (let i = 0; i < 20; i++) {
      restored.step(1 / 120); control.step(1 / 120);
      expect(snapshot(restored)).toBe(snapshot(control));
    }
  });

  it("restored resting contacts remain diagnostic and do not change continued motion", () => {
    const world = new World();
    const body = new Body(new Vec2(0, 0.249), 0.2, 2);
    body.showForceComponents = true; body.restitution = 0; body.friction = 0.6;
    const floor = new Wall(new Vec2(-3, 0), new Vec2(3, 0), 0.1);
    floor.restitution = 0; floor.friction = 0.6;
    world.bodies.push(body); world.walls.push(floor); world.step(1 / 120);
    expect(world.contacts.length).toBeGreaterThan(0);
    const input = snapshot(world); const originalContacts = world.contacts.map(contact => ({ ...contact }));
    const buffer = new RewindBuffer(); buffer.push(world); world.step(1 / 120); buffer.push(world);
    const restored = buffer.back()!; const control = World.fromDict(JSON.parse(input));
    expect(restored.contacts.map(contact => ({ ...contact }))).toEqual(originalContacts);
    show(restored); show(control);
    for (let k = 0; k < 20; k++) {
      restored.step(1 / 120); control.step(1 / 120);
      expect(snapshot(restored)).toBe(snapshot(control));
    }
  });

  it("trims analysis-bearing frames within the shared budget and retains exact intervals", () => {
    const world = new World(); world.gravity = 0;
    const body = new Body(new Vec2(0, 2), 0.2, 1);
    body.collides = false; body.showForceComponents = true; body.constForce.x = 1;
    world.bodies.push(body); world.step(1 / 120);
    const sizing = new RewindBuffer(); sizing.push(world); const firstBytes = sizing.bytesUsed;
    world.step(1 / 120); sizing.push(world); const frameCost = sizing.bytesUsed - firstBytes;
    RewindBuffer.BUDGET_BYTES = firstBytes + 2 * frameCost;
    const buffer = new RewindBuffer();
    for (let k = 0; k < 10; k++) {
      expect(buffer.push(world)).toBe("stored");
      expect(buffer.bytesUsed).toBeLessThanOrEqual(RewindBuffer.BUDGET_BYTES);
      expect(buffer.length).toBeLessThanOrEqual(3);
      world.step(1 / 120);
    }
    const restored = buffer.back()!; show(restored);
    expect(forceLedger(restored, restored.bodies[0]).mode).toBe("step-average");
    expect(forceLedger(restored, restored.bodies[0]).resultant.fx).toBeCloseTo(1, 12);
    expect(restored.bodies[0].forceSnapshot!.endTime).toBe(restored.time);
  });
});
