import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, PULLEY_RADIUS, Wall } from "../src/engine/body";
import { DistanceLink, PulleyLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { pulleyParticleDragPlan } from "../src/interact/pulley-drag";
import { PRESETS } from "../src/scene/presets";
import { snapshot } from "../src/scene/snapshot";

function setup(slack = 0) {
  const world = new World(), wheel = new Body(new Vec2(0, 1)),
    a = new Body(new Vec2(-PULLEY_RADIUS, -0.25)), b = new Body(new Vec2(PULLEY_RADIUS, -0.25));
  const string = new PulleyLink(a, b, wheel); string.length += slack;
  world.bodies.push(a, b, wheel); world.links.push(string);
  return { world, a, b, wheel, string };
}

function apply(world: World, body: Body, target: Vec2, walls: Wall[] = [], iterations = 40) {
  const before = snapshot(world), clock = world.time;
  const plan = pulleyParticleDragPlan(world.links, body, target, walls, iterations)!;
  expect(snapshot(world)).toBe(before); expect(world.time).toBe(clock);
  for (const partner of plan.partners) partner.body.pos.setVec(partner.target);
  body.pos.setVec(plan.target);
  for (const link of world.links) if (link instanceof PulleyLink) link.captureSafePositions();
  return plan;
}

describe("pulley direct-edit geometry", () => {
  it.each(["free", "locked", "held"] as const)("preserves the independent vertical-length answer with a %s partner", state => {
    for (let k = 0; k < 48; k++) {
      const slack = k % 5 * 0.1, distance = k * 0.085, { world, a, b, wheel, string } = setup(slack);
      b.locked = state === "locked"; b.held = state === "held";
      const angle = k * Math.PI / 17, c = Math.cos(angle), s = Math.sin(angle), origin = new Vec2(7, -3);
      const rotate = (v: Vec2) => new Vec2(c * v.x - s * v.y, s * v.x + c * v.y);
      for (const body of world.bodies) body.pos.setVec(rotate(body.pos).add(origin));
      string.guideAOffset.setVec(rotate(string.guideAOffset));
      string.guideBOffset.setVec(rotate(string.guideBOffset)); string.resetRouting();
      const oldA = a.pos.copy(), oldB = b.pos.copy(), down = rotate(new Vec2(0, -1));
      const freeTravel = state === "free" ? 1.25 - Math.sqrt((PULLEY_RADIUS + b.radius) ** 2 - PULLEY_RADIUS ** 2) : 0;
      const moved = Math.min(distance, slack + freeTravel), paid = Math.max(0, moved - slack);
      apply(world, a, oldA.add(down.mul(distance)));
      expect(a.pos.distTo(oldA.add(down.mul(moved)))).toBeLessThan(2e-9);
      expect(b.pos.distTo(oldB.sub(down.mul(paid)))).toBeLessThan(2e-9);
      expect(string.currentLength()).toBeLessThanOrEqual(string.length + 2e-9);
      expect(a.pos.distTo(wheel.pos)).toBeGreaterThanOrEqual(PULLEY_RADIUS + a.radius - 1e-9);
    }
  });

  it.each([40, 24, 22, 20, 18])("keeps a conservative stop with %s search iterations", iterations => {
    const { world, a, b, string } = setup(0.3), start = a.pos.copy();
    const stop = -0.25 - 0.3 - (1.25 - Math.sqrt((PULLEY_RADIUS + b.radius) ** 2 - PULLEY_RADIUS ** 2));
    apply(world, a, start.add(new Vec2(0, -20)), [], iterations);
    expect(a.pos.y).toBeGreaterThanOrEqual(stop - 1e-9);
    expect(a.pos.y - stop).toBeLessThan(20 / 2 ** iterations + 2e-9);
    expect(string.currentLength()).toBeLessThanOrEqual(string.length + 2e-9);
    expect(b.pos.y).toBeGreaterThan(-0.25);
  });

  it("stops a partner at a wall and gives the selected particle only the remaining travel", () => {
    const { world, a, b, string } = setup(0.4), wall = new Wall(new Vec2(-2, 0.3), new Vec2(2, 0.3), 0.04);
    const stopB = 0.3 - wall.thickness / 2 - b.radius;
    apply(world, a, a.pos.add(new Vec2(0, -4)), [wall]);
    expect(b.pos.y).toBeCloseTo(stopB, 8);
    expect(a.pos.y).toBeCloseTo(-0.65 - (stopB + 0.25), 8);
    expect(string.currentLength()).toBeLessThanOrEqual(string.length + 2e-9);
  });

  it("keeps the existing inclined-plane contact while the other particle is lowered", () => {
    const world = PRESETS.find(preset => preset.name === "Pulley on an incline")!.build();
    const link = world.links.find(link => link instanceof PulleyLink) as PulleyLink;
    const geom = link.geometry(), startA = link.a.pos.copy(), startB = link.b.pos.copy();
    apply(world, link.b, startB.add(new Vec2(0, -0.1)), world.walls);
    expect(link.a.pos.distTo(startA.sub(new Vec2(geom.nax, geom.nay).mul(0.1)))).toBeLessThan(1e-8);
    expect(link.b.pos.distTo(startB.add(new Vec2(0, -0.1)))).toBeLessThan(1e-8);
    expect(link.currentLength()).toBeLessThanOrEqual(link.length + 2e-9);
  });

  it("uses the first expanded-disc intersection for a very long cursor jump", () => {
    const { world, a, wheel } = setup(10000), start = a.pos.copy();
    apply(world, a, new Vec2(start.x, 1000));
    const hit = wheel.pos.y - Math.sqrt((PULLEY_RADIUS + a.radius) ** 2 - PULLEY_RADIUS ** 2);
    expect(a.pos.y).toBeCloseTo(hit, 10);
    expect(a.pos.distTo(wheel.pos)).toBeCloseTo(PULLEY_RADIUS + a.radius, 10);
  });

  it("allows shortening an imported overlong path without adding further extension", () => {
    const { world, a, b, string } = setup(); string.length *= 0.5; b.locked = true;
    const initial = string.currentLength(), start = a.pos.copy();
    apply(world, a, start.add(new Vec2(0, -2)));
    expect(a.pos.distTo(start)).toBeLessThan(2e-9); expect(string.currentLength()).toBeCloseTo(initial, 8);
    apply(world, a, start.add(new Vec2(0, 0.2)));
    expect(a.pos.y).toBeCloseTo(start.y + 0.2, 10);
    expect(string.currentLength()).toBeLessThan(initial);
  });

  it("rejects non-finite targets without changing state and leaves unrelated bodies alone", () => {
    const { world, a } = setup(); const before = snapshot(world);
    const bad = pulleyParticleDragPlan(world.links, a, new Vec2(NaN, Infinity))!;
    expect(bad.target).toEqual(a.pos); expect(bad.partners).toEqual([]); expect(snapshot(world)).toBe(before);
    const other = new Body(new Vec2(3, 3));
    expect(pulleyParticleDragPlan(world.links, other, new Vec2(4, 4))).toBeNull();
  });
});


describe("pulley edit boundaries and assembly ownership", () => {
  it.each(["anchor", "rod endpoint", "rod attachment", "rod", "rope", "another pulley"])(
    "does not silently displace a partner protected by %s", role => {
      const { world, a, b, string } = setup(0.2), oldB = b.pos.copy();
      const support = new Body(new Vec2(2, -0.25));
      world.bodies.push(support);
      if (role === "anchor") b.isAnchor = true;
      else if (role === "rod endpoint") b.isRodEndpoint = true;
      else if (role === "rod attachment") b.rodAttachmentId = 123;
      else if (role === "another pulley") {
        const wheel = new Body(new Vec2(3, 1)); world.bodies.push(wheel);
        world.links.push(new PulleyLink(b, support, wheel));
      } else world.links.push(new DistanceLink(b, support, null, role === "rope"));
      apply(world, a, a.pos.add(new Vec2(0, -2)));
      expect(a.pos.y).toBeCloseTo(-0.45, 8); expect(b.pos).toEqual(oldB);
      expect(string.currentLength()).toBeLessThanOrEqual(string.length + 2e-9);
    });

  it("finds one permitted position for a particle in two separate pulleys", () => {
    const { world, a, b, wheel, string } = setup(0.2);
    const c = new Body(b.pos.copy()), second = new PulleyLink(a, c, wheel);
    second.length += 0.05; c.held = true;
    world.bodies.push(c); world.links.push(second);
    apply(world, a, a.pos.add(new Vec2(0, -2)));
    expect(a.pos.y).toBeCloseTo(-0.30, 8); expect(b.pos.y).toBe(-0.25);
    for (const link of [string, second]) expect(link.currentLength()).toBeLessThanOrEqual(link.length + 2e-9);
  });

  it("allows a lifted particle to make slack without pushing its partner down", () => {
    const { world, a, b, string } = setup(), initialB = b.pos.copy();
    apply(world, a, a.pos.add(new Vec2(0, 0.2)));
    expect(a.pos.y).toBeCloseTo(-0.05, 10); expect(b.pos).toEqual(initialB);
    expect(string.currentLength()).toBeLessThan(string.length);
  });

  it("can reverse away from the rim after arbitrarily many parked cursor updates", () => {
    const { world, a, wheel } = setup(10), target = new Vec2(a.pos.x, 3);
    apply(world, a, target); const contact = a.pos.copy();
    for (let k = 0; k < 100; k++) apply(world, a, target);
    expect(a.pos.distTo(contact)).toBeLessThan(1e-12);
    apply(world, a, contact.sub(new Vec2(0, 0.1)));
    expect(a.pos.y).toBeCloseTo(contact.y - 0.1, 10);
    expect(a.pos.distTo(wheel.pos)).toBeGreaterThan(PULLEY_RADIUS + a.radius);
  });

  it("permits escape from a legacy rim overlap without increasing penetration", () => {
    const { world, a, wheel, string } = setup(10);
    a.pos.set(wheel.pos.x, wheel.pos.y - PULLEY_RADIUS - a.radius * 0.5);
    string.captureSafePositions(); const initial = a.pos.copy();
    apply(world, a, initial.add(new Vec2(0, 0.05)));
    expect(a.pos).toEqual(initial);
    apply(world, a, initial.sub(new Vec2(0, 0.1)));
    expect(a.pos.y).toBeCloseTo(initial.y - 0.1, 10);
  });

  it("preserves velocities, multipliers, clock and accepted route while planning", () => {
    const { world, a, b, wheel, string } = setup(0.3);
    world.time = 7; a.vel.set(0.7, -0.3); b.vel.set(-1, 2); string.lambda = 2; string.mu = 3;
    const before = { json: snapshot(world), safe: [string.safeAX, string.safeAY, string.safeBX,
      string.safeBY, string.safePX, string.safePY], turns: string.wrapTurns,
      lambda: string.lambda, mu: string.mu, wheel: wheel.pos.copy() };
    const plan = pulleyParticleDragPlan(world.links, a, a.pos.add(new Vec2(0, -8)))!;
    expect(plan.partners).toHaveLength(1);
    expect({ json: snapshot(world), safe: [string.safeAX, string.safeAY, string.safeBX,
      string.safeBY, string.safePX, string.safePY], turns: string.wrapTurns,
      lambda: string.lambda, mu: string.mu, wheel: wheel.pos.copy() }).toEqual(before);
  });
});
