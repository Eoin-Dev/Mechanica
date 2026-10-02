import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { PULLEY_RADIUS, PulleyLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { analysePulley, EventTracker, forceLedger, projectForce, slopeBasis, touchingSlopeWall } from "../src/education/analysis";
import { Contact } from "../src/engine/contacts";

describe("playback event identity and chronology", () => {
  it("sorts interpolated events by time and removes every future row on rewind", () => {
    const world = new World();
    const late = new Body(new Vec2());
    const early = new Body(new Vec2());
    late.vel.y = 0.8;
    early.vel.y = 0.2;
    world.bodies.push(late, early);
    const tracker = new EventTracker();
    tracker.prime(world);
    world.time = 1;
    late.vel.y = -0.2;
    early.vel.y = -0.8;
    const added = tracker.observe(world);
    expect(added.map(event => event.time)).toEqual([0.2, 0.8]);
    tracker.rewindTo(0.5, world);
    expect(tracker.events.map(event => event.bodyIds)).toEqual([[early.id]]);
  });

  it("does not invent contact transitions when body detection order changes", () => {
    const world = new World();
    const tracker = new EventTracker();
    world.contacts = [new Contact(0, 0, 1, 0, 1, 10, 20)];
    tracker.prime(world);
    world.contacts = [new Contact(0, 0, -1, 0, 1, 20, 10)];
    world.time = 1;
    expect(tracker.observe(world)).toEqual([]);
  });

  it("distinguishes wall zero from body zero and reports only actual body IDs", () => {
    const world = new World();
    const body = new Body(new Vec2());
    body.id = 1;
    body.name = "Particle";
    const zero = new Body(new Vec2());
    zero.id = 0;
    zero.name = "Body zero";
    const wall = new Wall(new Vec2(), new Vec2(1, 0));
    wall.id = 0;
    wall.name = "Wall zero";
    world.bodies.push(body, zero);
    world.walls.push(wall);
    const tracker = new EventTracker();
    tracker.prime(world);
    world.time = 1;
    world.contacts = [new Contact(0, 0, 1, 0, 1, 1, 0),
      new Contact(0, 0, 0, 1, 1, 1, null, 0)];
    const events = tracker.observe(world);
    expect(events).toHaveLength(2);
    expect(events.find(event => event.value.includes("Wall zero"))?.bodyIds).toEqual([1]);
  });
});

describe("education analysis", () => {
  it("recognises current wall contact on either face and at a rounded endpoint without stepping", () => {
    const wall = new Wall(new Vec2(-2, 0), new Vec2(2, 0));
    wall.thickness = 0.1;
    const body = new Body(new Vec2(0, 0.25), 0.2);
    expect(touchingSlopeWall(body, wall)).toBe(true);
    body.pos.y = -0.25;
    expect(touchingSlopeWall(body, wall)).toBe(true);
    body.pos.set(2.25, 0);
    expect(touchingSlopeWall(body, wall)).toBe(true);
    body.pos.x += 0.00001;
    expect(touchingSlopeWall(body, wall)).toBe(false);
    body.pos.set(0, 0.25); body.collides = false;
    expect(touchingSlopeWall(body, wall)).toBe(false);
    body.collides = true; wall.b.setVec(wall.a);
    expect(touchingSlopeWall(body, wall)).toBe(false);
  });

  it("rejects a separated or foreign slope reference in the force ledger", () => {
    const world = new World();
    const wall = new Wall(new Vec2(-2, 0), new Vec2(2, 0));
    wall.thickness = 0.1;
    const body = new Body(new Vec2(0, 0.25), 0.2);
    world.bodies.push(body); world.walls.push(wall);
    expect(forceLedger(world, body, wall).basis?.wallId).toBe(wall.id);
    body.pos.y = 1;
    expect(forceLedger(world, body, wall).basis).toBeNull();
    body.pos.y = 0.25; world.walls.length = 0;
    expect(forceLedger(world, body, wall).basis).toBeNull();
    expect(world.time).toBe(0);
  });

  it("decomposes named forces and closes exactly to the realised resultant", () => {
    const world = new World();
    world.gravity = 9.8;
    world.dragLinear = 0.5;
    const body = new Body(new Vec2(0, 1), 0.2, 2);
    body.vel.set(4, 0);
    body.constForce.set(3, 5);
    body.showForceComponents = true;
    body.collides = false;
    world.bodies.push(body);
    world.step(1 / 60);

    const ledger = forceLedger(world, body);
    const sum = ledger.entries.reduce(
      (value, entry) => ({ x: value.x + entry.fx, y: value.y + entry.fy }),
      { x: 0, y: 0 });
    expect(sum.x).toBeCloseTo(body.netForce.x, 12);
    expect(sum.y).toBeCloseTo(body.netForce.y, 12);
    expect(ledger.entries.map((entry) => entry.label)).toEqual([
      "Weight", "Applied force", "Air resistance",
    ]);
  });

  it("uses an uphill tangent and outward normal for slope components", () => {
    const wall = new Wall(new Vec2(-2, -1), new Vec2(2, 1));
    const body = new Body(new Vec2(0, 1), 0.2, 1);
    const basis = slopeBasis(wall, body)!;
    expect(basis.tx).toBeGreaterThan(0);
    expect(basis.ny).toBeGreaterThan(0);
    const weight = projectForce({ fx: 0, fy: -9.8 }, basis);
    expect(weight.parallel).toBeLessThan(0);
    expect(weight.normal).toBeLessThan(0);
  });

  it("reports equal pulley tension and the balancing axle reaction", () => {
    const world = new World();
    const wheel = new Body(new Vec2(0, 1), PULLEY_RADIUS, 0);
    const a = new Body(new Vec2(-PULLEY_RADIUS, 0), 0.16, 2);
    const b = new Body(new Vec2(PULLEY_RADIUS, 0), 0.16, 1);
    const link = new PulleyLink(a, b, wheel);
    world.bodies.push(wheel, a, b); world.links.push(link);
    link.mu = 7.5; // An old solver output must not define a fresh reading.
    const analysis = analysePulley(link, world);
    const expected = 4 * world.gravity / 3;
    expect(analysis.tension).toBeCloseTo(expected, 10);
    const g = link.geometry();
    expect(analysis.axleReactionX).toBeCloseTo(-expected * (g.nax + g.nbx), 10);
    expect(analysis.axleReactionY).toBeCloseTo(-expected * (g.nay + g.nby), 10);
  });
});
