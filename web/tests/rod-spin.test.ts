import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { DistanceLink, PulleyLink } from "../src/engine/links";
import { World, INTEGRATORS } from "../src/engine/world";
import { restoreSnapshot, snapshot } from "../src/scene/snapshot";

function assembly(pulley: boolean) {
  const world = new World(); world.gravity = 0;
  const a = new Body(new Vec2(-1, 0)), b = new Body(new Vec2(1, 0));
  a.isRodEndpoint = b.isRodEndpoint = true; a.collides = b.collides = false;
  const rod = new DistanceLink(a, b, 2), mass = new Body(new Vec2(0, 0));
  mass.rodAttachmentId = rod.id; mass.rodAttachmentT = 0.5; mass.collides = false;
  world.bodies.push(a, b, mass); world.links.push(rod);
  if (pulley) {
    const wheel = new Body(new Vec2(2, 1)), other = new Body(new Vec2(2.22, -1));
    const string = new PulleyLink(mass, other, wheel); string.length += 1;
    world.bodies.push(wheel, other); world.links.push(string);
  }
  mass.noRotation = false; mass.omega = 3; mass.angle = 0.2;
  return { world, mass };
}
for (const pulley of [false, true]) {
  describe(`independent mounted-particle spin (pulley=${pulley})`, () => {
    it.each(INTEGRATORS)("advances angular orientation with %s without moving the mount", integrator => {
      const { world, mass } = assembly(pulley); world.integrator = integrator;
      const initial = snapshot(world); world.currentForceSnapshot(mass); expect(snapshot(world)).toBe(initial);
      for (let i = 0; i < 60; i++) world.step(1 / 120);
      expect(mass.omega).toBe(3); expect(mass.angle).toBeCloseTo(1.7, 11);
      expect(mass.pos.x).toBeCloseTo(0, 10); expect(mass.pos.y).toBeCloseTo(0, 10);
      const restored = restoreSnapshot(snapshot(world)), copy = restored.bodies.find(body => body.id === mass.id)!;
      expect(copy.noRotation).toBe(false); expect(copy.omega).toBe(3); expect(copy.angle).toBe(mass.angle);
      restored.step(0.1); expect(copy.angle).toBeCloseTo(2, 11);
    });
  });
}
