import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { DistanceLink } from "../src/engine/links";
import { INTEGRATORS, World } from "../src/engine/world";
import { snapshot } from "../src/scene/snapshot";

/** Two equal 2 kg loads at ±1.5 m: I = 9 kg m². A 6 N tangential
 * force on the right gives torque 9 N m, hence alpha = 1 rad/s².
 * The initial angular speed 0.7 gives inward acceleration 0.49*r. */
function fixture(angle: number, centre: Vec2, supported: boolean, coordinateMass = 0.001) {
  const w = new World(); w.gravity = 9.8; w.substeps = 8;
  const n = new Vec2(Math.cos(angle), Math.sin(angle));
  const position = (distance: number) => centre.add(n.mul(distance));
  const a = new Body(position(-2), 0.04, coordinateMass);
  const b = new Body(position(2), 0.04, coordinateMass);
  a.isRodEndpoint = b.isRodEndpoint = true; a.collides = b.collides = false;
  const rod = new DistanceLink(a, b, 4); w.bodies.push(a, b); w.links.push(rod);
  const loads = [-1.5, 1.5].map(distance => {
    const load = new Body(position(distance), 0.15, 2);
    load.rodAttachmentId = rod.id; load.rodAttachmentT = (distance + 2) / 4;
    load.showForceComponents = true; load.collides = false; load.noRotation = true;
    w.bodies.push(load); return load;
  });
  loads[1].constForce.set(-6 * n.y, 6 * n.x);
  if (supported) {
    const pivot = new Body(centre.copy()); pivot.isAnchor = pivot.isPivot = pivot.locked = true;
    pivot.collides = false; pivot.rodAttachmentId = rod.id; pivot.rodAttachmentT = 0.5;
    w.bodies.push(pivot);
  }
  for (const body of [a, b, ...loads]) {
    const r = body.pos.sub(centre);
    body.vel.set(-0.7 * r.y + (supported ? 0 : 1.2), 0.7 * r.x + (supported ? 0 : -0.3));
  }
  const expected = [-1.5, 1.5].map(distance => {
    const r = n.mul(distance);
    const translationX = supported ? 0 : -1.5 * n.y;
    const translationY = supported ? 0 : 1.5 * n.x - w.gravity;
    return new Vec2(translationX - r.y - 0.49 * r.x, translationY + r.x - 0.49 * r.y);
  });
  return { w, rod, loads, expected, centre };
}

describe("standalone rod Newton-Euler mechanics", () => {
  for (const supported of [false, true]) {
    for (const [angle, x, y] of [[0, 0, 0], [Math.PI / 2, -12.7, 4.2], [0.3, 300, -50], [-2, 4, -5]]) {
      it(`solves ${supported ? "supported" : "free"} loads at angle ${angle} and origin ${x},${y}`, () => {
        const { w, loads, expected } = fixture(angle, new Vec2(x, y), supported);
        const before = snapshot(w);
        for (let i = 0; i < loads.length; i++) {
          const forces = w.currentForceSnapshot(loads[i])!;
          expect(forces.fx / loads[i].mass).toBeCloseTo(expected[i].x, 8);
          expect(forces.fy / loads[i].mass).toBeCloseTo(expected[i].y, 8);
          expect(forces.entries.some(f => f.kind === "correction")).toBe(false);
        }
        expect(snapshot(w)).toBe(before);
      });
    }
  }

  it.each(INTEGRATORS)("retains the equation of motion through an integrated frame with %s", integrator => {
    const { w, loads, expected } = fixture(0.3, new Vec2(0, 0), true);
    w.integrator = integrator;
    const initial = loads.map(b => b.vel.copy()); w.step(1e-5);
    for (let i = 0; i < loads.length; i++) {
      const acceleration = loads[i].vel.sub(initial[i]).div(w.time);
      expect(acceleration.x).toBeCloseTo(expected[i].x, 3);
      expect(acceleration.y).toBeCloseTo(expected[i].y, 3);
    }
  });

  it.each([1e-9, 0.001, 1, 1e6])("does not turn hidden solver-coordinate mass %s into physical inertia", mass => {
    const { w, loads, expected } = fixture(0.3, new Vec2(0, 0), true, mass);
    for (let i = 0; i < loads.length; i++) {
      const forces = w.currentForceSnapshot(loads[i])!;
      expect(forces.fx / loads[i].mass).toBeCloseTo(expected[i].x, 8);
      expect(forces.fy / loads[i].mass).toBeCloseTo(expected[i].y, 8);
    }
  });

  it("allows rotation with coincident supports and stops it with spatially separate supports", () => {
    const { w, rod, loads, expected, centre } = fixture(0, new Vec2(0, 0), true);
    const support = new Body(centre.copy()); support.locked = support.isAnchor = support.isPivot = true;
    support.collides = false; support.rodAttachmentId = rod.id; support.rodAttachmentT = 0.5;
    w.bodies.push(support);
    expect(w.currentForceSnapshot(loads[0])!.fy / 2).toBeCloseTo(expected[0].y, 8);
    w.step(1e-4); expect(loads[0].vel.length()).toBeGreaterThan(1);
    support.rodAttachmentT = 0.75;
    support.pos.setVec(rod.a.pos.add(rod.b.pos.sub(rod.a.pos).mul(0.75)));
    for (const load of loads) load.vel.set(0, 0);
    const initial = loads.map(b => b.pos.copy());
    for (let i = 0; i < 120; i++) w.step(1 / 120);
    for (let i = 0; i < loads.length; i++) {
      expect(loads[i].pos.distTo(initial[i])).toBeLessThan(1e-7);
      expect(loads[i].vel.length()).toBeLessThan(1e-7);
    }
  });

  it("keeps free-beam centre-of-mass momentum and kinetic energy through drift correction", () => {
    const { w, loads } = fixture(0.3, new Vec2(0, 0), false);
    w.gravity = 0; loads[1].constForce.set(0, 0);
    const initialMomentum = w.momentum(), energy = w.energy().total;
    for (let i = 0; i < 1200; i++) w.step(1 / 120);
    expect(w.momentum().distTo(initialMomentum)).toBeLessThan(1e-7);
    expect(Math.abs(w.energy().total - energy)).toBeLessThan(0.001);
  });

  it("retains nonzero compliance's existing free-beam axial stretch", () => {
    const { w, rod } = fixture(0, new Vec2(0, 0), false);
    w.gravity = 0; rod.compliance = 0.1;
    for (const body of w.bodies) {
      body.constForce.set(0, 0); body.vel.set(0, 0);
      body.pos.x *= 1.025;
    }
    w.step(1 / 120);
    expect(rod.a.pos.distTo(rod.b.pos)).toBeGreaterThan(4.09);
  });

  it("retains a small but nonzero physical inertia instead of suppressing rotation", () => {
    const { w, rod, loads } = fixture(0, new Vec2(0, 0), true);
    w.gravity = 0; rod.length = 0.04;
    for (const body of w.bodies) {
      body.pos.x *= 0.01; body.pos.y *= 0.01;
      body.vel.set(-10 * body.pos.y, 10 * body.pos.x);
      body.constForce.set(0, 0);
    }
    for (const load of loads) load.mass = 1e-9;
    for (let i = 0; i < 10; i++) w.step(1 / 120);
    for (const load of loads) {
      expect(load.pos.length()).toBeCloseTo(0.015, 10);
      expect(load.vel.length()).toBeGreaterThan(0.1499);
      expect(load.vel.length()).toBeLessThan(0.1501);
    }
  });
});
