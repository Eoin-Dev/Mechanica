import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { DistanceLink } from "../src/engine/links";
import { World } from "../src/engine/world";

function attachedWorld(pivot = true): { world: World; a: Body; b: Body; mount: Body; rod: DistanceLink } {
  const world = new World();
  world.gravity = 0;
  world.substeps = 8;
  world.iterations = 16;
  const a = new Body(new Vec2(-1, 0), 0.1, 1);
  const b = new Body(new Vec2(1, 0), 0.1, 1);
  const rod = new DistanceLink(a, b, 2);
  const mount = new Body(new Vec2(0, 0), 0.07, 1);
  mount.rodAttachmentId = rod.id;
  mount.rodAttachmentT = 0.5;
  if (pivot) {
    mount.isPivot = true;
    mount.isAnchor = true;
    mount.locked = true;
    mount.collides = false;
    mount.name = "Pivot";
  }
  world.bodies.push(a, b, mount);
  world.links.push(rod);
  return { world, a, b, mount, rod };
}

describe("rod attachments", () => {
  it.each([false, true])(
    "keeps a pivoted standalone rod with several masses rigid and energy-bounded (performance=%s)",
    (performance) => {
      const world = new World();
      world.gravity = 9.8;
      world.substeps = 4;
      world.iterations = 8;
      world.performance = performance;
      world.performanceLevel = performance ? 3 : 0;
      const a = new Body(new Vec2(0, -2.5), 0.04, 1e-3);
      const b = new Body(new Vec2(0, 2.5), 0.04, 1e-3);
      a.isRodEndpoint = b.isRodEndpoint = true;
      a.collides = b.collides = false;
      const rod = new DistanceLink(a, b, 5);
      const pivot = new Body(new Vec2(0, 0), 0.07, 1);
      pivot.isPivot = pivot.isAnchor = pivot.locked = true;
      pivot.collides = false;
      pivot.rodAttachmentId = rod.id;
      pivot.rodAttachmentT = 0.5;
      const masses = [
        [0.12, 1.0], [0.68, 1.7], [0.92, 0.8],
      ].map(([t, mass]) => {
        const body = new Body(new Vec2(0, -2.5 + 5 * t), 0.15, mass);
        body.restitution = 0.8;
        body.friction = 0.4;
        body.rodAttachmentId = rod.id;
        body.rodAttachmentT = t;
        return body;
      });
      world.bodies.push(a, b, pivot, ...masses);
      world.links.push(rod);
      const energy0 = world.energy().total;
      let maximumEnergy = Math.abs(energy0);
      let maximumSpeed = 0;
      for (let i = 0; i < 30 * 120; i++) {
        world.step(1 / 120);
        maximumEnergy = Math.max(maximumEnergy, Math.abs(world.energy().total));
        for (const body of masses) maximumSpeed = Math.max(maximumSpeed, body.vel.length());
      }
      let maximumAttachmentError = 0;
      for (const body of masses) {
        const t = body.rodAttachmentT;
        const point = a.pos.mul(1 - t).add(b.pos.mul(t));
        maximumAttachmentError = Math.max(maximumAttachmentError,
          body.pos.distTo(point));
      }
      expect(maximumSpeed, "attached-particle speed").toBeLessThan(20);
      expect(maximumEnergy, "total mechanical energy")
        .toBeLessThan(Math.abs(energy0) + 50);
      expect(maximumAttachmentError, "rod attachment drift")
        .toBeLessThan(performance ? 0.02 : 1e-5);
    },
  );

  it.each([false, true])(
    "keeps a supported standalone rod finite with a particle (performance=%s)",
    (performance) => {
      const world = new World();
      world.gravity = 9.8;
      world.substeps = 8;
      world.iterations = 16;
      world.performance = performance;
      world.performanceLevel = performance ? 3 : 0;
      const a = new Body(new Vec2(-1, 0), 0.04, 1e-3);
      const b = new Body(new Vec2(1, 0), 0.04, 1e-3);
      a.isRodEndpoint = b.isRodEndpoint = true;
      a.collides = b.collides = false;
      const rod = new DistanceLink(a, b, 2);
      const pivot = new Body(new Vec2(0, 0), 0.05, 1);
      pivot.isPivot = pivot.isAnchor = pivot.locked = true;
      pivot.collides = false;
      pivot.rodAttachmentId = rod.id;
      pivot.rodAttachmentT = 0.5;
      const particle = new Body(new Vec2(0.6, 0), 0.12, 1);
      particle.rodAttachmentId = rod.id;
      particle.rodAttachmentT = 0.8;
      world.bodies.push(a, b, pivot, particle);
      world.links.push(rod);
      for (let i = 0; i < 480; i++) world.step(1 / 240);
      for (const body of world.bodies) {
        expect(Number.isFinite(body.pos.x)).toBe(true);
        expect(Number.isFinite(body.pos.y)).toBe(true);
        expect(body.vel.length()).toBeLessThan(100);
      }
      expect(Math.abs(a.pos.distTo(b.pos) - 2)).toBeLessThan(performance ? 0.01 : 1e-4);
      const mounted = a.pos.add(b.pos.sub(a.pos).mul(0.8));
      expect(particle.pos.distTo(mounted)).toBeLessThan(performance ? 0.01 : 1e-5);
    },
  );

  it.each([false, true])(
    "transfers a collision through a supported rod without deformation or energy growth (performance=%s)",
    (performance) => {
      const world = new World();
      world.gravity = 0;
      world.substeps = 4;
      world.iterations = 8;
      world.performance = performance;
      world.performanceLevel = performance ? 3 : 0;
      const a = new Body(new Vec2(-1.5, 0), 0.04, 1e-3);
      const b = new Body(new Vec2(1.5, 0), 0.04, 1e-3);
      a.isRodEndpoint = b.isRodEndpoint = true;
      a.collides = b.collides = false;
      const rod = new DistanceLink(a, b, 3);
      const support = new Body(new Vec2(0, 0), 0.07, 1);
      support.isPivot = support.isAnchor = support.locked = true;
      support.collides = false;
      support.rodAttachmentId = rod.id;
      support.rodAttachmentT = 0.5;
      const mounted = new Body(new Vec2(0.9, 0), 0.18, 1.5);
      mounted.restitution = 0.8;
      mounted.friction = 0.4;
      mounted.rodAttachmentId = rod.id;
      mounted.rodAttachmentT = 0.8;
      const projectile = new Body(new Vec2(0.9, 1.1), 0.18, 1);
      projectile.restitution = 0.8;
      projectile.friction = 0.4;
      projectile.vel.set(0, -5);
      world.bodies.push(a, b, support, mounted, projectile);
      world.links.push(rod);
      const energy0 = world.energy().total;
      let maximumEnergy = energy0;
      let maximumSpeed = 0;
      let maximumAttachmentError = 0;
      for (let i = 0; i < 3 * 240; i++) {
        world.step(1 / 240);
        maximumEnergy = Math.max(maximumEnergy, world.energy().total);
        maximumSpeed = Math.max(maximumSpeed, mounted.vel.length(), projectile.vel.length());
        const point = a.pos.mul(0.2).add(b.pos.mul(0.8));
        maximumAttachmentError = Math.max(maximumAttachmentError,
          mounted.pos.distTo(point));
      }
      expect(maximumSpeed, "impact speed").toBeLessThan(12);
      expect(maximumEnergy, "post-impact mechanical energy")
        .toBeLessThanOrEqual(energy0 + 0.1);
      expect(maximumAttachmentError, "impact attachment drift")
        .toBeLessThan(performance ? 0.01 : 1e-5);
    },
  );

  it("keeps a supported point on the rod while endpoint forces rotate it", () => {
    const { world, a, b, mount } = attachedWorld();
    b.constForce.set(0, -8);
    for (let i = 0; i < 240; i++) world.step(1 / 240);
    expect(a.pos.distTo(b.pos)).toBeCloseTo(2, 7);
    expect((a.pos.x + b.pos.x) / 2).toBeCloseTo(mount.pos.x, 7);
    expect((a.pos.y + b.pos.y) / 2).toBeCloseTo(mount.pos.y, 7);
    expect(Math.abs(b.pos.y)).toBeGreaterThan(0.05);
  });

  it("lets an attached particle's mass and force act through the rod", () => {
    const { world, a, b, mount } = attachedWorld(false);
    a.locked = true;
    mount.rodAttachmentT = 0.6;
    mount.constForce.set(0, -5);
    for (let i = 0; i < 60; i++) world.step(1 / 240);
    const x = a.pos.x + 0.6 * (b.pos.x - a.pos.x);
    const y = a.pos.y + 0.6 * (b.pos.y - a.pos.y);
    expect(mount.pos.x).toBeCloseTo(x, 6);
    expect(mount.pos.y).toBeCloseTo(y, 6);
    expect(b.pos.y).toBeLessThan(-0.001);
  });

  it("round-trips pivot identity, attachment position, and rod origin", () => {
    const { world, mount, rod } = attachedWorld();
    mount.rodAttachmentT = 0.3;
    rod.originAtA = false;
    const restored = World.fromDict(JSON.parse(JSON.stringify(world.toDict())));
    const pivot = restored.bodies.find((body) => body.isPivot)!;
    const restoredRod = restored.links.find((link): link is DistanceLink =>
      link instanceof DistanceLink)!;
    expect(pivot.name).toBe("Anchor");
    expect(pivot.rodAttachmentId).toBe(restoredRod.id);
    expect(pivot.rodAttachmentT).toBeCloseTo(0.3);
    expect(restoredRod.originAtA).toBe(false);
  });

  it("releases an attachment safely when its rod is deleted", () => {
    const { world, mount, rod } = attachedWorld();
    world.removeLink(rod);
    expect(mount.rodAttachmentId).toBeNull();
    expect(mount.isPivot).toBe(false);
    expect(mount.isAnchor).toBe(true);
    expect(mount.name).toBe("Anchor");
  });

  it("deletes a standalone beam's hidden endpoints with the rod", () => {
    const { world, a, b, rod } = attachedWorld(false);
    a.isRodEndpoint = b.isRodEndpoint = true;
    world.removeLink(rod);
    expect(world.links).not.toContain(rod);
    expect(world.bodies).not.toContain(a);
    expect(world.bodies).not.toContain(b);
  });

  it("does not let coincident rod attachments fight collision resolution", () => {
    const { world, a, b, mount, rod } = attachedWorld(false);
    mount.rodAttachmentT = 0;
    mount.pos.setVec(a.pos);
    const second = new Body(a.pos.copy(), 0.12, 2);
    second.rodAttachmentId = rod.id;
    second.rodAttachmentT = 0;
    world.bodies.push(second);
    for (let i = 0; i < 120; i++) world.step(1 / 240);
    for (const body of world.bodies) {
      expect(Number.isFinite(body.pos.x)).toBe(true);
      expect(Number.isFinite(body.pos.y)).toBe(true);
      expect(body.vel.length()).toBeLessThan(1);
    }
    expect(mount.pos.distTo(a.pos)).toBeLessThan(1e-7);
    expect(second.pos.distTo(a.pos)).toBeLessThan(1e-7);
    expect(b.pos.distTo(a.pos)).toBeCloseTo(2, 7);
  });
});
