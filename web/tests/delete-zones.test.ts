import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { DeleteZone, DELETE_ZONE_SHAPES } from "../src/engine/delete-zone";
import { DistanceLink, PulleyLink, SpringLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { RewindBuffer, restore, snapshot, structuralDigest } from "../src/scene/snapshot";
import { PRESETS } from "../src/scene/presets";

describe("delete-zone geometry", () => {
  it.each(DELETE_ZONE_SHAPES)("includes touching surfaces and fast crossings for %s", shape => {
    const zone = new DeleteZone(new Vec2(1, 2), shape, 2, 1);
    expect(zone.contains(new Vec2(1, 2))).toBe(true);
    expect(zone.intersectsSegment(new Vec2(-4, 2), new Vec2(5, 2))).toBe(true);
    const edge = shape === "circle" ? 3 : 2.5;
    expect(zone.contains(new Vec2(1, edge + .1), .1)).toBe(true);
    expect(zone.contains(new Vec2(1, edge + .101), .1)).toBe(false);
    zone.angle = Math.PI / 2;
    expect(zone.intersectsSegment(new Vec2(1, -4), new Vec2(1, 7))).toBe(true);
  });
  it("uses a rounded rectangle offset, retaining a near-corner miss", () => {
    const zone = new DeleteZone(new Vec2(), "rectangle", 2, 2);
    expect(zone.contains(new Vec2(1.08, 1.08), .1)).toBe(false);
    expect(zone.contains(new Vec2(1.06, 1.06), .1)).toBe(true);
  });
  it.each(DELETE_ZONE_SHAPES)("checks a routed arc rather than its chord for %s", shape => {
    const zone = new DeleteZone(new Vec2(0, -1), shape, .1, .1);
    expect(zone.intersectsArc(new Vec2(), 1, Math.PI, Math.PI)).toBe(true);
    expect(zone.intersectsArc(new Vec2(), 1, 0, Math.PI)).toBe(false);
    zone.pos.set(0, 0);
    expect(zone.intersectsArc(new Vec2(), 1, Math.PI, Math.PI)).toBe(false);
  });
  it.each(DELETE_ZONE_SHAPES)("finds interior swept hits without filling folded empty space for %s", shape => {
    const zone = new DeleteZone(new Vec2(.7, .7), shape, .1, .1); zone.angle = .37;
    expect(zone.intersectsSweptSegment(new Vec2(-2, 0), new Vec2(2, 0), new Vec2(0, -2), new Vec2(0, 2))).toBe(true);
    zone.pos.set(0, .5);
    // These endpoints sweep two opposing triangles, leaving the centre-top gap
    // untouched even though it lies inside their convex hull.
    expect(zone.intersectsSweptSegment(new Vec2(-1, -1), new Vec2(1, 1), new Vec2(-1, 1), new Vec2(1, -1))).toBe(false);
    expect(zone.intersectsSweptSegment(new Vec2(-1, -1), new Vec2(1, -1), new Vec2(-1, .4), new Vec2(1, .4))).toBe(false);
  });
  it.each(DELETE_ZONE_SHAPES)("retains small swept targets at large translations for %s", shape => {
    const zone = new DeleteZone(new Vec2(500000, -400000), shape, .0001, .0001);
    const a = new Vec2(499000, -400001), b = new Vec2(501000, -400001);
    const nextA = new Vec2(499000, -399999), nextB = new Vec2(501000, -399999);
    expect(zone.intersectsSweptSegment(a, b, nextA, nextB)).toBe(true);
    zone.pos.y += 2.0001;
    expect(zone.intersectsSweptSegment(a, b, nextA, nextB)).toBe(false);
  });
  it("agrees with independently sampled segment poses and with reversed traversal", () => {
    let seed = 1279;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    let sampledHits = 0;
    for (const shape of DELETE_ZONE_SHAPES) for (let sample = 0; sample < 30; sample++) {
      const zone = new DeleteZone(new Vec2(random() - .5, random() - .5), shape, .3, .2); zone.angle = random() * 6;
      const points = Array.from({ length: 4 }, () => new Vec2(random() * 4 - 2, random() * 4 - 2));
      const [a, b, nextA, nextB] = points, result = zone.intersectsSweptSegment(a, b, nextA, nextB);
      expect(zone.intersectsSweptSegment(nextA, nextB, a, b)).toBe(result);
      expect(zone.intersectsSweptSegment(b, a, nextB, nextA)).toBe(result);
      for (let frame = 0; frame <= 1000; frame++) {
        const t = frame / 1000;
        if (!zone.intersectsSegment(a.mul(1 - t).add(nextA.mul(t)), b.mul(1 - t).add(nextB.mul(t)))) continue;
        sampledHits++;
        expect(result, `${shape}: sampled contact at ${t}`).toBe(true);
        break;
      }
    }
    expect(sampledHits).toBeGreaterThan(20);
  });
});

describe("persistent delete zones", () => {
  it.each([1, 4].flatMap(substeps => ["rod", "rope", "spring", "elastic"].flatMap(kind =>
    DELETE_ZONE_SHAPES.map(shape => [substeps, kind, shape] as const))))(
    "removes a translating %s-substep %s crossing a %s zone while its endpoints miss", (substeps, kind, shape) => {
    const world = new World(); world.gravity = 0; world.substeps = substeps;
    const a = new Body(new Vec2(-1.5, -1), .05), b = new Body(new Vec2(1.5, -1), .05);
    for (const body of [a, b]) { body.vel.y = 200; body.collides = false; }
    const link = kind === "rod" || kind === "rope" ? new DistanceLink(a, b, 3, kind === "rope") :
      new SpringLink(a, b, 3, 0, 0, kind === "elastic");
    world.bodies.push(a, b); world.links.push(link);
    world.deleteZones.push(new DeleteZone(new Vec2(), shape, .1, .1));
    world.step(.01);
    // Uniform translation puts the entire link through y=0 at t=.005 s.
    // The two endpoint paths stay 1.5 m away from the zone throughout.
    expect(world.links).toHaveLength(0);
    expect(world.bodies).toEqual([a, b]);
    expect(a.pos.y).toBeCloseTo(1, 10); expect(b.pos.y).toBeCloseTo(1, 10);
  });
  it("releases a swept standalone rod and restores its owned assembly on rewind", () => {
    const world = new World(); world.gravity = 0; world.substeps = 1;
    const a = new Body(new Vec2(-1.5, -1), .05), b = new Body(new Vec2(1.5, -1), .05);
    a.isRodEndpoint = b.isRodEndpoint = true;
    const rod = new DistanceLink(a, b, 3), load = new Body(new Vec2(.9, -1), .05);
    for (const endpoint of [a, b]) { endpoint.name = "Rod endpoint"; endpoint.noRotation = true; }
    load.rodAttachmentId = rod.id; load.rodAttachmentT = .8;
    for (const body of [a, b, load]) { body.vel.y = 200; body.collides = false; }
    world.bodies.push(a, b, load); world.links.push(rod);
    world.deleteZones.push(new DeleteZone(new Vec2(), "capsule", .1, .1));
    const before = world.toDict(), history = new RewindBuffer(); history.push(world);
    world.step(.01); history.push(world);
    expect(world.links).toHaveLength(0); expect(world.bodies).toEqual([load]);
    expect(load.rodAttachmentId).toBeNull(); expect(load.vel.y).toBeCloseTo(200, 9);
    expect(history.back()!.toDict()).toEqual(before);
  });
  it("pockets balls through each of the six open cushion gaps without deleting the cushions", () => {
    for (let index = 0; index < 6; index++) {
      const world = PRESETS.find(preset => preset.name === "Billiard break")!.build();
      const pocket = world.deleteZones[index], direction = pocket.pos.mul(1 / pocket.pos.length());
      const ball = new Body(pocket.pos.sub(direction.mul(.7)), .11, .17);
      ball.vel = direction.mul(2); world.bodies = [ball]; world.globalDamping = 0;
      for (let frame = 0; frame < 60; frame++) world.step(1 / 120);
      expect(world.bodies, `Pocket ${index + 1}`).toHaveLength(0);
      expect(world.walls).toHaveLength(6); expect(world.deleteZones).toHaveLength(6);
    }
  });
  it("does not mutate a zero-duration step and catches a fast particle crossing in a real step", () => {
    const world = new World(); world.gravity = 0; world.substeps = 1;
    const body = new Body(new Vec2(-1, 0), .05); body.vel.x = 200;
    world.bodies.push(body); world.deleteZones.push(new DeleteZone(new Vec2(), "circle", .1));
    world.step(0); expect(world.bodies).toEqual([body]);
    world.step(.01); expect(world.bodies).toHaveLength(0); expect(world.deleteZones).toHaveLength(1);
  });
  it("keeps disabled zones inert and deletes independent of collision flags", () => {
    const world = new World(), body = new Body(new Vec2(), .1);
    body.collides = false; world.bodies.push(body);
    const zone = new DeleteZone(); zone.enabled = false; world.deleteZones.push(zone);
    world.step(.01); expect(world.bodies).toEqual([body]);
    zone.enabled = true; world.step(.01); expect(world.bodies).toHaveLength(0);
  });
  it("removes walls and crossing links, releasing attached rod bodies coherently", () => {
    const world = new World(); world.gravity = 0;
    const a = new Body(new Vec2(-2, 0), .1), b = new Body(new Vec2(2, 0), .1);
    a.isRodEndpoint = b.isRodEndpoint = true;
    const rod = new DistanceLink(a, b), load = new Body(new Vec2(1, 0));
    load.rodAttachmentId = rod.id; load.rodAttachmentT = .75;
    world.bodies.push(a, b, load); world.links.push(rod);
    world.walls.push(new Wall(new Vec2(0, -2), new Vec2(0, 2)));
    world.deleteZones.push(new DeleteZone(new Vec2(), "circle", .1)); world.applyDeleteZones();
    expect(world.links).toHaveLength(0); expect(world.walls).toHaveLength(0);
    expect(world.bodies).toEqual([load]); expect(load.rodAttachmentId).toBeNull();
  });
  it("dismantles a pulley when a particle is pocketed, preserving its opposite particle", () => {
    const world = new World(), a = new Body(new Vec2(-1, 0)), b = new Body(new Vec2(1, 0));
    const wheel = new Body(new Vec2(0, 2)), pulley = new PulleyLink(a, b, wheel);
    world.bodies.push(a, b, wheel); world.links.push(pulley);
    world.deleteZones.push(new DeleteZone(a.pos.copy(), "circle", .1)); world.applyDeleteZones();
    expect(world.links).toHaveLength(0); expect(world.bodies).toEqual([b]);
  });
  it("removes a spring crossing a zone without deleting its untouched endpoints", () => {
    const world = new World(), a = new Body(new Vec2(-2, 0)), b = new Body(new Vec2(2, 0));
    world.bodies.push(a, b); world.links.push(new SpringLink(a, b));
    world.deleteZones.push(new DeleteZone(new Vec2(), "rectangle", .1, .1)); world.applyDeleteZones();
    expect(world.links).toHaveLength(0); expect(world.bodies).toEqual([a, b]);
  });
  it("owns scene and rewind state and detects zone edits as structural changes", () => {
    const world = new World(); world.gravity = 0;
    const zone = new DeleteZone(new Vec2(2, 1), "capsule", 3, .5); zone.angle = .6;
    world.deleteZones.push(zone); const saved = snapshot(world), hash = structuralDigest(world);
    const history = new RewindBuffer(); history.push(world);
    zone.width = 4; expect(structuralDigest(world)).not.toBe(hash); history.push(world);
    expect(history.back()!.deleteZones[0].width).toBe(3);
    const loaded = restore(saved); expect(loaded.deleteZones[0].toDict()).toEqual({ ...zone.toDict(), width: 3 });
    loaded.deleteZones[0].pos.x = 99; expect(zone.pos.x).toBe(2);
  });
  it("guards malformed dimensions, duplicate IDs and excessive zone collections", () => {
    const world = World.fromDict({ delete_zones: [{ id: 1, shape: "capsule", width: -5, height: Infinity },
      { id: 1, pos: "bad" }] } as unknown as Parameters<typeof World.fromDict>[0]);
    expect(world.deleteZones[0].width).toBe(.0001); expect(world.deleteZones[0].height).toBe(1);
    expect(new Set(world.deleteZones.map(zone => zone.id)).size).toBe(2);
    expect(() => World.fromDict({ delete_zones: Array(129).fill({}) })).toThrow("delete_zones");
  });
});
