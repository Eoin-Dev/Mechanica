import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { PULLEY_RADIUS, PulleyLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { analysePulley, EventTracker, forceLedger, projectForce, slopeBasis } from "../src/education/analysis";
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
  it("decomposes named forces and closes exactly to the realised resultant", () => {
    const world = new World();
    world.gravity = 9.8;
    world.dragLinear = 0.5;
    const body = new Body(new Vec2(0, 1), 0.2, 2);
    body.vel.set(4, 0);
    body.constForce.set(3, 5);
    body.netForce.set(1, -14.6);
    world.bodies.push(body);
    world.stepCount = 1;

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
    const wheel = new Body(new Vec2(0, 1), PULLEY_RADIUS, 0);
    const a = new Body(new Vec2(-1, 0), 0.16, 2);
    const b = new Body(new Vec2(1, 0), 0.16, 1);
    const link = new PulleyLink(a, b, wheel);
    link.mu = 7.5;
    const analysis = analysePulley(link);
    expect(analysis.tension).toBe(7.5);
    const g = link.geometry();
    expect(analysis.axleReactionX).toBeCloseTo(-7.5 * (g.nax + g.nbx), 12);
    expect(analysis.axleReactionY).toBeCloseTo(-7.5 * (g.nay + g.nby), 12);
  });
});
