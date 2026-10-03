import { describe, expect, it } from "vitest";
import { Body } from "../src/engine/body";
import { DistanceLink, PulleyLink } from "../src/engine/links";
import { INTEGRATORS } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";
import { restore, snapshot } from "../src/scene/snapshot";

const names = ["Atwood machine", "Rough table and pulley", "Balanced beam",
  "Loaded rod pendulum", "Rod rotor", "Swinging Atwood machine"];
const preset = (name: string) => PRESETS.find(p => p.name === name)!;
const build = (name: string) => preset(name).build();
const loadBodies = (bodies: Body[]) => bodies.filter(b => !b.isAnchor && !b.isRodEndpoint);

describe("rod and pulley investigations", () => {
  it("offers a dedicated section with unobstructed graph-free starting views", () => {
    expect(PRESETS.filter(p => p.category === "Rods & Pulleys").map(p => p.name)).toEqual(names);
    for (const name of names) expect(preset(name).hints.graph).toBeUndefined();
  });

  it.each([1 / 120, 1 / 240, 0.01763])("matches the Atwood acceleration and tension at dt=%s", dt => {
    const w = build("Atwood machine"), string = w.links[0] as PulleyLink;
    const { a, b } = string, a0 = a.pos.copy(), b0 = b.pos.copy();
    const acceleration = (b.mass - a.mass) * w.gravity / (a.mass + b.mass);
    const tension = 2 * a.mass * b.mass * w.gravity / (a.mass + b.mass);
    const queryA = w.currentForceSnapshot(a)!;
    const queryB = w.currentForceSnapshot(b)!;
    expect(queryA.entries.find(f => f.kind === "pulley")!.fy).toBeCloseTo(tension, 8);
    expect(queryB.entries.find(f => f.kind === "pulley")!.fy).toBeCloseTo(tension, 8);
    for (let i = 0; i < Math.floor(0.5 / dt); i++) w.step(dt);
    const t = w.time;
    expect(a.vel.y).toBeCloseTo(acceleration * t, 7);
    expect(b.vel.y).toBeCloseTo(-acceleration * t, 7);
    expect(a.pos.y - a0.y).toBeCloseTo(acceleration * t * t / 2, 7);
    expect(b.pos.y - b0.y).toBeCloseTo(-acceleration * t * t / 2, 7);
    expect(a.pos.x).toBeCloseTo(a0.x, 10);
    expect(b.pos.x).toBeCloseTo(b0.x, 10);
    expect(string.currentLength()).toBeCloseTo(string.length, 9);
    for (const body of [a, b]) {
      expect(body.forceSnapshot!.entries.find(f => f.kind === "pulley")!.axialForce)
        .toBeCloseTo(tension, 6);
      const correction = body.forceSnapshot!.entries.find(f => f.kind === "correction");
      expect(correction ? Math.hypot(correction.fx, correction.fy) : 0).toBeLessThan(1e-6);
    }
  });

  it.each(INTEGRATORS)("matches rough-table Newton equations with %s", integrator => {
    const w = build("Rough table and pulley"); w.integrator = integrator;
    const string = w.links[0] as PulleyLink, { a, b } = string;
    const reaction = a.mass * w.gravity, friction = 0.2 * reaction;
    const acceleration = (b.mass * w.gravity - friction) / (a.mass + b.mass);
    const tension = b.mass * (w.gravity - acceleration);
    const initial = snapshot(w);
    const query = w.currentForceSnapshot(a)!;
    expect(query.entries.find(f => f.kind === "reaction")!.fy).toBeCloseTo(reaction, 7);
    expect(query.entries.find(f => f.kind === "friction")!.fx).toBeCloseTo(-friction, 7);
    expect(query.entries.find(f => f.kind === "pulley")!.fx).toBeCloseTo(tension, 7);
    expect(snapshot(w)).toBe(initial);
    for (let i = 0; i < 60; i++) w.step(1 / 120);
    expect(a.vel.x).toBeCloseTo(acceleration * w.time, 3);
    expect(b.vel.y).toBeCloseTo(-acceleration * w.time, 3);
    expect(Math.abs(a.vel.y)).toBeLessThan(1e-6);
    expect(string.currentLength()).toBeCloseTo(string.length, 7);
    const forces = a.forceSnapshot!;
    // The contact solver permits 0.5 mm penetration. Its small consequent
    // string inclination perturbs the later support forces by under 0.01 N;
    // the initial exact tangent configuration is checked above independently.
    expect(Math.abs(forces.entries.find(f => f.kind === "reaction")!.fy - reaction)).toBeLessThan(0.01);
    expect(Math.abs(forces.entries.find(f => f.kind === "friction")!.fx + friction)).toBeLessThan(0.002);
    expect(Math.abs(forces.entries.find(f => f.kind === "pulley")!.axialForce! - tension)).toBeLessThan(0.005);
  });

  it.each(INTEGRATORS)("catches the descending Atwood load before either wheel stop with %s", integrator => {
    const w = build("Atwood machine"); w.integrator = integrator;
    const string = w.links[0] as PulleyLink, floor = w.walls[0];
    const contactY = floor.a.y + floor.thickness / 2 + string.b.radius;
    const acceleration = (string.b.mass - string.a.mass) * w.gravity / (string.a.mass + string.b.mass);
    const impactTime = Math.sqrt(2 * (string.b.pos.y - contactY) / acceleration);
    let caught = false;
    while (w.time < impactTime + 0.05) {
      w.step(1 / 240);
      expect(string.a.pos.distTo(string.pulley.pos)).toBeGreaterThan(0.22 + string.a.radius + 0.1);
      if (Math.abs(string.b.pos.y - contactY) < 0.001 && Math.abs(string.b.vel.y) < 0.01) {
        caught = true; break;
      }
    }
    expect(caught).toBe(true);
    expect(Math.abs(w.time - impactTime)).toBeLessThan(1 / 240 + 0.001);
    // The rising light load coasts while the cord is slack. Retension can
    // lift B again, so the first floor impact is not an immediate equilibrium.
    // Successive inelastic impacts dissipate that remaining kinetic energy.
    for (let i = 0; i < 10 * 240; i++) w.step(1 / 240);
    // Contact projection intentionally permits 0.5 mm of resting overlap.
    expect(Math.abs(string.b.pos.y - contactY)).toBeLessThan(0.000501);
    expect(string.b.vel.length()).toBeLessThan(0.001);
    expect(w.diverged).toHaveLength(0);
  });

  it.each([false, 0, 1, 2, 3] as const)("preserves balanced moments (Performance=%s)", level => {
    const w = build("Balanced beam"); w.performance = level !== false;
    if (level !== false) w.performanceLevel = level;
    const rod = w.links[0] as DistanceLink, pivot = w.bodies.find(b => b.isPivot)!;
    const loads = loadBodies(w.bodies), starts = w.bodies.map(b => b.pos.copy());
    const moment = loads.reduce((sum, b) => sum + b.mass * w.gravity * (b.pos.x - pivot.pos.x), 0);
    expect(moment).toBeCloseTo(0, 12);
    for (let i = 0; i < 1200; i++) w.step(1 / 120);
    expect(rod.a.pos.distTo(rod.b.pos)).toBeCloseTo(rod.length, 7);
    for (let i = 0; i < w.bodies.length; i++) {
      expect(w.bodies[i].pos.distTo(starts[i])).toBeLessThan(1e-6);
      expect(w.bodies[i].vel.length()).toBeLessThan(1e-6);
    }
  });

  it("starts the loaded rod with the physical-pendulum angular acceleration", () => {
    const w = build("Loaded rod pendulum"), rod = w.links[0] as DistanceLink;
    const moving = loadBodies(w.bodies);
    const inertia = moving.reduce((sum, b) => sum + b.mass * b.pos.length2(), 0);
    const torque = moving.reduce((sum, b) => sum - b.mass * w.gravity * b.pos.x, 0);
    w.step(1e-4);
    const axis = rod.b.pos.sub(rod.a.pos), relative = rod.b.vel.sub(rod.a.vel);
    const omega = (axis.x * relative.y - axis.y * relative.x) / axis.length2();
    expect(omega / w.time).toBeCloseTo(torque / inertia, 3);
  });

  it("retains loaded-rod rigidity and mechanical energy across repeated swings", () => {
    const w = build("Loaded rod pendulum"), rod = w.links[0] as DistanceLink;
    const energy = w.energy().total;
    let energyError = 0, attachmentError = 0;
    for (let i = 0; i < 20 * 120; i++) {
      w.step(1 / 120);
      energyError = Math.max(energyError, Math.abs(w.energy().total - energy));
      for (const body of loadBodies(w.bodies)) {
        const point = rod.a.pos.add(rod.b.pos.sub(rod.a.pos).mul(body.rodAttachmentT));
        attachmentError = Math.max(attachmentError, body.pos.distTo(point));
      }
    }
    expect(attachmentError).toBeLessThan(1e-6);
    expect(energyError).toBeLessThan(0.02);
    expect(w.diverged).toHaveLength(0);
  });

  it("keeps a zero-gravity rotor's angular speed and centripetal acceleration", () => {
    const w = build("Rod rotor"), loads = loadBodies(w.bodies), energy = w.energy().total;
    const start = loads[0].pos.copy(); loads[0].showForceComponents = true;
    const initial = w.currentForceSnapshot(loads[0])!;
    expect(initial.fx).toBeCloseTo(-loads[0].mass * start.x, 5);
    expect(initial.fy).toBeCloseTo(0, 8);
    for (let i = 0; i < 10 * 120; i++) w.step(1 / 120);
    for (const body of loads) {
      expect(body.pos.length()).toBeCloseTo(1.5, 6);
      expect(body.vel.length()).toBeCloseTo(1.5, 3);
      expect(body.pos.dot(body.vel)).toBeCloseTo(0, 6);
    }
    const expectedX = start.x * Math.cos(w.time), expectedY = start.x * Math.sin(w.time);
    expect(loads[0].pos.x).toBeCloseTo(expectedX, 3);
    expect(loads[0].pos.y).toBeCloseTo(expectedY, 3);
    expect(Math.abs(w.energy().total - energy)).toBeLessThan(0.005);
  });

  it("preserves the swinging pulley constraint and energy before any impact", () => {
    const w = build("Swinging Atwood machine"), string = w.links[0] as PulleyLink;
    const energy = w.energy().total, start = string.a.pos.copy();
    let error = 0;
    for (let i = 0; i < 120; i++) {
      w.step(1 / 120);
      if (w.contacts.length > 0) break;
      error = Math.max(error, Math.abs(w.energy().total - energy));
      expect(string.currentLength()).toBeLessThanOrEqual(string.length + 1e-7);
    }
    expect(w.time).toBeGreaterThan(0.2);
    expect(string.a.pos.distTo(start)).toBeGreaterThan(0.2);
    expect(error).toBeLessThan(0.005);
  });

  it.each(names)("round-trips and continues %s without changing its mechanics", name => {
    const w = build(name);
    for (let i = 0; i < 20; i++) w.step(1 / 120);
    const copy = restore(snapshot(w));
    for (let i = 0; i < 40; i++) { w.step(1 / 120); copy.step(1 / 120); }
    for (let i = 0; i < w.bodies.length; i++) {
      expect(copy.bodies[i].pos.distTo(w.bodies[i].pos)).toBeLessThan(1e-7);
      expect(copy.bodies[i].vel.distTo(w.bodies[i].vel)).toBeLessThan(1e-7);
    }
  });

  it.each([false, 0, 1, 2, 3] as const)("keeps every new model finite and rigid across ten seconds (Performance=%s)", level => {
    for (const name of names) {
      const w = build(name); w.performance = level !== false;
      if (level !== false) w.performanceLevel = level;
      for (let i = 0; i < 1200; i++) {
        w.step(1 / 120);
        for (const link of w.links) {
          if (link instanceof DistanceLink) expect(link.a.pos.distTo(link.b.pos), name).toBeCloseTo(link.length, 6);
          else if (link instanceof PulleyLink) expect(link.currentLength(), name).toBeLessThanOrEqual(link.length + 1e-6);
        }
      }
      expect(w.diverged, name).toHaveLength(0);
      for (const body of w.bodies) {
        expect(Number.isFinite(body.pos.x + body.pos.y + body.vel.x + body.vel.y), name).toBe(true);
        expect(body.vel.length(), name).toBeLessThan(30);
      }
    }
  });
});
