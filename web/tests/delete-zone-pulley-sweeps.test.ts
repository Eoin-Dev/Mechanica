import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, PULLEY_RADIUS } from "../src/engine/body";
import { DeleteZone, DELETE_ZONE_SHAPES } from "../src/engine/delete-zone";
import { PulleyLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { RewindBuffer } from "../src/scene/snapshot";

function movingPulley(substeps = 1, wheelY = 3, flat = false) {
  const world = new World(); world.gravity = 0; world.substeps = substeps;
  const a = new Body(new Vec2(-1.5, -1)), b = new Body(new Vec2(1.5, -1));
  a.collides = b.collides = false; a.vel.y = b.vel.y = 200;
  const wheel = new Body(new Vec2(0, wheelY)), link = new PulleyLink(a, b, wheel, 20);
  if (flat) { link.wrapTurns = -1; link.captureSafePositions(); }
  world.bodies.push(a, b, wheel); world.links.push(link);
  return { world, a, b, wheel, link };
}
function touches(zone: DeleteZone, link: PulleyLink) {
  const g = link.geometry();
  return g.wrapped ? zone.intersectsSegment(link.a.pos, g.ga) || zone.intersectsSegment(link.b.pos, g.gb) ||
    zone.intersectsArc(link.pulley.pos, g.ga.distTo(link.pulley.pos),
      Math.atan2(g.ga.y - link.pulley.pos.y, g.ga.x - link.pulley.pos.x), g.sweep) :
    zone.intersectsSegment(link.a.pos, link.b.pos);
}
function sampledCrossing(zone: DeleteZone, link: PulleyLink) {
  const a = link.a.pos.copy(), b = link.b.pos.copy();
  const nextA = a.add(link.a.vel.mul(.01)), nextB = b.add(link.b.vel.mul(.01));
  let hit = false;
  for (let sample = 1; sample < 200; sample++) {
    const t = sample / 200;
    link.a.pos.set(a.x + (nextA.x - a.x) * t, a.y + (nextA.y - a.y) * t);
    link.b.pos.set(b.x + (nextB.x - b.x) * t, b.y + (nextB.y - b.y) * t);
    hit ||= touches(zone, link);
  }
  link.a.pos.set(a.x, a.y); link.b.pos.set(b.x, b.y);
  return hit;
}
function swept(zone: DeleteZone, link: PulleyLink, nextA: Vec2, nextB: Vec2) {
  return zone.intersectsSweptPulley(link.a.pos, link.b.pos, nextA, nextB,
    link.pulley.pos, PULLEY_RADIUS, (a, b) => link.geometry(a, b));
}

describe("routed pulley Delete-zone sweeps", () => {
  it.each([1, 4].flatMap(substeps => [-1, 1].flatMap(side => DELETE_ZONE_SHAPES.map(shape =>
    [substeps, side, shape] as const))))(
    "removes a %s-substep pulley whose side %s tangent leg crosses a %s zone", (substeps, side, shape) => {
      const { world, a, b, wheel, link } = movingPulley(substeps);
      const zone = new DeleteZone(new Vec2(side * 1.3, 0), shape, .04, .04);
      expect(link.geometry().wrapped).toBe(true);
      expect(touches(zone, link)).toBe(false);
      expect(sampledCrossing(zone, link)).toBe(true);
      for (const body of [a, b]) expect(zone.intersectsSegment(body.pos, body.pos.add(new Vec2(0, 2)), body.radius)).toBe(false);
      expect(zone.contains(wheel.pos, wheel.radius)).toBe(false);
      world.deleteZones.push(zone); world.step(.01);
      expect(world.links).toHaveLength(0);
      expect(world.bodies).toEqual([a, b]);
      expect(a.pos.y).toBeCloseTo(1, 9); expect(b.pos.y).toBeCloseTo(1, 9);
    });
  it.each([1, 4])("removes a released straight pulley string crossing between %s substeps", substeps => {
    const { world, a, b, link } = movingPulley(substeps, 3, true);
    const zone = new DeleteZone(new Vec2(), "circle", .04);
    expect(link.geometry().wrapped).toBe(false); expect(touches(zone, link)).toBe(false);
    expect(link.branchDistance("a")).toBeGreaterThan(0); expect(link.branchDistance("b")).toBeGreaterThan(0);
    expect(sampledCrossing(zone, link)).toBe(true);
    world.deleteZones.push(zone); world.step(.01);
    expect(world.links).toHaveLength(0); expect(world.bodies).toEqual([a, b]);
    expect(a.pos.y).toBeCloseTo(1, 9); expect(b.pos.y).toBeCloseTo(1, 9);
    expect(a.vel.y).toBe(200); expect(b.vel.y).toBe(200);
  });
  it("retains a wrapped string when only the particle-to-particle chord crosses the zone", () => {
    const { world, a, b, link } = movingPulley();
    const zone = new DeleteZone(new Vec2(), "circle", .04);
    expect(zone.intersectsSweptSegment(a.pos, b.pos, a.pos.add(new Vec2(0, 2)), b.pos.add(new Vec2(0, 2)))).toBe(true);
    expect(sampledCrossing(zone, link)).toBe(false);
    world.deleteZones.push(zone); world.step(.01);
    expect(world.links).toEqual([link]); expect(world.bodies).toHaveLength(3);
  });
  it.each(DELETE_ZONE_SHAPES)("observes crossings while a wrapped route releases into a straight %s-zone crossing", shape => {
    const { world, a, b, link } = movingPulley(1, 0);
    a.pos.set(1.5, -.1); b.pos.set(-1.5, -.1); a.vel.y = b.vel.y = -200; link.resetRouting();
    // Match the authored sheet used by the imported browser fixture.
    expect(link.toDict().wrap_turns).toBe(-1);
    const zone = new DeleteZone(new Vec2(0, -1), shape, .04, .04);
    expect(link.geometry().wrapped).toBe(true); expect(touches(zone, link)).toBe(false);
    expect(link.branchDistance("a")).toBeGreaterThan(0); expect(link.branchDistance("b")).toBeGreaterThan(0);
    expect(sampledCrossing(zone, link)).toBe(true);
    a.pos.y = b.pos.y = -2.1;
    expect(link.geometry().wrapped).toBe(false); expect(touches(zone, link)).toBe(false);
    a.pos.y = b.pos.y = -.1;
    world.deleteZones.push(zone); world.step(.01);
    expect(world.links).toHaveLength(0); expect(world.bodies).toEqual([a, b]);
    expect(a.pos.y).toBeCloseTo(-2.1, 9); expect(b.pos.y).toBeCloseTo(-2.1, 9);
    expect(a.vel.y).toBe(-200); expect(b.vel.y).toBe(-200);
  });
  it.each([false, true])("detects an arc-only swept contact, exterior tangency=%s", tangent => {
    const wheel = new Body(new Vec2()), distance = 2, alpha = Math.acos(PULLEY_RADIUS / distance);
    const a = new Body(new Vec2(distance * Math.cos(.1), distance * Math.sin(.1)));
    const angleB = .1 - 2 * alpha - .2;
    const b = new Body(new Vec2(distance * Math.cos(angleB), distance * Math.sin(angleB)));
    const link = new PulleyLink(a, b, wheel, 20);
    const nextA = a.pos.rotated(.5), nextB = b.pos.rotated(.5);
    const pa = a.pos.add(nextA).mul(.5), pb = b.pos.add(nextB).mul(.5), middle = link.geometry(pa, pb);
    expect(middle.wrapped).toBe(true);
    const angle = Math.atan2(middle.ga.y, middle.ga.x) + middle.sweep / 2;
    const r = .0005, distanceToZone = PULLEY_RADIUS + (tangent ? r : 0);
    const zone = new DeleteZone(new Vec2(distanceToZone * Math.cos(angle), distanceToZone * Math.sin(angle)), "circle", r * 2);
    expect(touches(zone, link)).toBe(false);
    expect(zone.intersectsSegment(pa, middle.ga)).toBe(false); expect(zone.intersectsSegment(pb, middle.gb)).toBe(false);
    expect(zone.intersectsArc(wheel.pos, PULLEY_RADIUS, Math.atan2(middle.ga.y, middle.ga.x), middle.sweep)).toBe(true);
    const end = link.geometry(nextA, nextB);
    expect(zone.intersectsSegment(nextA, end.ga) || zone.intersectsSegment(nextB, end.gb) ||
      zone.intersectsArc(wheel.pos, PULLEY_RADIUS, Math.atan2(end.ga.y, end.ga.x), end.sweep)).toBe(false);
    expect(swept(zone, link, nextA, nextB)).toBe(true);
  });
  it("queries trial poses without moving bodies or committing the route sheet", () => {
    const { world, a, b, link } = movingPulley(), before = world.toDict();
    const state = () => [link.safeAX, link.safeAY, link.safeBX, link.safeBY, link.safePX, link.safePY, link.wrapTurns];
    const saved = state(), aPosition = a.pos, bPosition = b.pos;
    for (const t of [0, .3, .5, .9, 1]) {
      const pa = a.pos.add(new Vec2(0, 2 * t)), pb = b.pos.add(new Vec2(0, 2 * t));
      const query = link.geometry(pa, pb), oldA = a.pos.copy(), oldB = b.pos.copy();
      a.pos.set(pa.x, pa.y); b.pos.set(pb.x, pb.y);
      expect(link.geometry()).toEqual(query);
      a.pos.set(oldA.x, oldA.y); b.pos.set(oldB.x, oldB.y);
    }
    swept(new DeleteZone(new Vec2(-1.3, 0), "rectangle", .04, .04), link,
      a.pos.add(new Vec2(0, 2)), b.pos.add(new Vec2(0, 2)));
    expect(world.toDict()).toEqual(before); expect(state()).toEqual(saved);
    expect(a.pos).toBe(aPosition); expect(b.pos).toBe(bPosition);
  });
  it.each(DELETE_ZONE_SHAPES)("finds a very brief %s-zone contact on a long particle path", shape => {
    let seed = 8117;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let sample = 0; sample < 40; sample++) {
      const { a, b, wheel, link } = movingPulley();
      a.pos.x = -1.5 - random() * 1.5; b.pos.x = -a.pos.x;
      a.pos.y = b.pos.y = -1e5 - random() * 8e5; link.captureSafePositions();
      const endY = 1e5 + random() * 8e5;
      const point = new Vec2(a.pos.x + .3 + random() * .7, random() * 2 - 1);
      const zone = new DeleteZone(point, shape, .0001, .0001); zone.angle = random() * 6;
      // Independently construct the left tangent through the target centre.
      const q = point.sub(wheel.pos), d2 = q.length() ** 2;
      const factor = PULLEY_RADIUS * Math.sqrt(d2 - PULLEY_RADIUS ** 2) / d2;
      const guide = wheel.pos.add(q.mul(PULLEY_RADIUS ** 2 / d2))
        .sub(new Vec2(-q.y, q.x).mul(factor));
      const y = point.y + (a.pos.x - point.x) * (guide.y - point.y) / (guide.x - point.x);
      const pa = new Vec2(a.pos.x, y), pb = new Vec2(b.pos.x, y), g = link.geometry(pa, pb);
      expect(zone.intersectsSegment(pa, g.ga)).toBe(true);
      expect(swept(zone, link, new Vec2(a.pos.x, endY), new Vec2(b.pos.x, endY)), `${shape} sample ${sample}`).toBe(true);
    }
  });
  it("finds hidden routed contacts constructed at independent intermediate poses", () => {
    let seed = 72191, checked = 0, transitions = 0;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (const shape of DELETE_ZONE_SHAPES) for (let sample = 0; sample < 80; sample++) {
      const { a, b, link } = movingPulley(1, 0);
      a.pos.set(-.8 - random() * 1.5, random() * 4 - 2);
      b.pos.set(.8 + random() * 1.5, random() * 4 - 2); link.resetRouting();
      const nextA = new Vec2(-.8 - random() * 1.5, random() * 4 - 2);
      const nextB = new Vec2(.8 + random() * 1.5, random() * 4 - 2);
      const t = .15 + random() * .7, pa = a.pos.mul(1 - t).add(nextA.mul(t)), pb = b.pos.mul(1 - t).add(nextB.mul(t));
      const g = link.geometry(pa, pb), fraction = .25 + random() * .5;
      const point = pa.mul(1 - fraction).add((g.wrapped ? g.ga : pb).mul(fraction));
      const zone = new DeleteZone(point, shape, .006, .004); zone.angle = random() * 6;
      if (touches(zone, link) || zone.intersectsSegment(a.pos, nextA) || zone.intersectsSegment(b.pos, nextB)) continue;
      const end = link.geometry(nextA, nextB);
      if (end.wrapped ? zone.intersectsSegment(nextA, end.ga) || zone.intersectsSegment(nextB, end.gb) ||
        zone.intersectsArc(link.pulley.pos, PULLEY_RADIUS, Math.atan2(end.ga.y, end.ga.x), end.sweep) :
        zone.intersectsSegment(nextA, nextB)) continue;
      checked++; if (link.geometry().wrapped !== end.wrapped) transitions++;
      expect(swept(zone, link, nextA, nextB), `${shape} contact at t=${t}`).toBe(true);
      expect(zone.intersectsSweptPulley(nextA, nextB, a.pos, b.pos, link.pulley.pos, PULLEY_RADIUS,
        (pa, pb) => link.geometry(pa, pb))).toBe(true);
    }
    expect(checked).toBeGreaterThan(100); expect(transitions).toBeGreaterThan(10);
  });
  it.each([false, 0, 1, 2, 3] as const)("preserves endpoint motion and owned rewind in performance mode %s", mode => {
    const { world, a, b } = movingPulley(); a.vel.y = b.vel.y = 50;
    const control = World.fromDict(world.toDict());
    world.performance = control.performance = mode !== false;
    world.performanceLevel = control.performanceLevel = mode === false ? 0 : mode;
    world.deleteZones.push(new DeleteZone(new Vec2(-1.3, 0), "circle", .04));
    const before = world.toDict(), history = new RewindBuffer(); history.push(world);
    world.step(.04); control.step(.04); history.push(world);
    expect(world.links).toHaveLength(0); expect(world.bodies).toEqual([a, b]);
    expect(world.bodies.map(body => body.toDict())).toEqual(control.bodies.filter(body => !body.isPulley).map(body => body.toDict()));
    expect(history.back()!.toDict()).toEqual(before);
  });
  it("retains wheel-only deletion as an ordinary released string", () => {
    const { world, a, b, wheel } = movingPulley();
    world.deleteZones.push(new DeleteZone(wheel.pos.copy(), "circle", .04));
    world.step(.01);
    expect(world.bodies).toEqual([a, b]); expect(world.links).toHaveLength(1);
    expect(world.links[0].toDict()).toMatchObject({ type: "rod", is_rope: true });
  });
});
