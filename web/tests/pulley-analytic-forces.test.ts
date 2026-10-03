/** Independent equilibrium and Newton-law checks for coupled pulley loads. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, PULLEY_RADIUS, Wall } from "../src/engine/body";
import type { ForceKind, ForceSnapshot } from "../src/engine/force-diagnostics";
import { PulleyLink } from "../src/engine/links";
import { INTEGRATORS, World } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";

function assembly(massA: number, massB = 1, stopped = false) {
  const world = new World();
  world.substeps = 8; world.iterations = 10;
  const wheel = new Body(new Vec2(0, 1), PULLEY_RADIUS);
  wheel.isPulley = wheel.isAnchor = wheel.locked = true;
  wheel.collides = false;
  const a = new Body(new Vec2(-PULLEY_RADIUS, -2.5), 0.12, massA);
  const b = new Body(new Vec2(PULLEY_RADIUS, -0.25), 0.12, massB);
  a.collides = b.collides = false;
  a.noRotation = b.noRotation = true;
  a.showForceComponents = b.showForceComponents = true;
  const link = new PulleyLink(a, b, wheel);
  // Explicit link diagnostics remain available in every Performance tier.
  link.showTensionVectors = true;
  if (stopped) {
    // PulleyLink owns particle radii. Establish exact tangency after construction.
    b.pos.y = wheel.pos.y - Math.sqrt((wheel.radius + b.radius) ** 2 - PULLEY_RADIUS ** 2);
    expect(b.pos.distTo(wheel.pos)).toBeCloseTo(wheel.radius + b.radius, 12);
    link.length = link.currentLength();
  }
  world.bodies.push(wheel, a, b); world.links.push(link);
  return { world, wheel, a, b, link };
}

function magnitude(snapshot: ForceSnapshot, kind: ForceKind): number {
  return snapshot.entries.filter(entry => entry.kind === kind)
    .reduce((sum, entry) => sum + Math.hypot(entry.fx, entry.fy), 0);
}

function closure(snapshot: ForceSnapshot): void {
  const sum = snapshot.entries.reduce((value, entry) =>
    new Vec2(value.x + entry.fx, value.y + entry.fy), new Vec2());
  expect(sum.x).toBeCloseTo(snapshot.fx, 8);
  expect(sum.y).toBeCloseTo(snapshot.fy, 8);
}

describe("pulley forces against independent mathematical answers", () => {
  it.each(INTEGRATORS)("retains taut-string tension at a valid guide boundary with %s", integrator => {
    const world = new World(); world.gravity = 0; world.integrator = integrator;
    const wheel = new Body(new Vec2(), PULLEY_RADIUS);
    const a = new Body(new Vec2(-2, 0), 0.16, 1), b = new Body(new Vec2(2, -2), 0.16, 1);
    a.collides = b.collides = false; a.showForceComponents = b.showForceComponents = true;
    b.constForce.set(0, -1);
    const link = new PulleyLink(a, b, wheel); world.bodies.push(wheel, a, b); world.links.push(link);
    const geometry = link.geometry();
    expect(geometry.nay).toBeLessThan(0);
    // A's guide removes the vertical response. Newton's equations plus
    // zero string-length acceleration determine the common tension directly.
    const tension = -geometry.nby / (geometry.nax ** 2 + geometry.nbx ** 2 + geometry.nby ** 2);
    const current = world.currentForceSnapshot(a)!;
    expect(magnitude(current, "pulley")).toBeCloseTo(tension, 9);
    expect(current.fx).toBeCloseTo(-tension * geometry.nax, 9);
    expect(current.fy).toBeCloseTo(0, 9);
    expect(current.entries.find(entry => entry.kind === "reaction")!.fy).toBeCloseTo(tension * geometry.nay, 9);
    for (let i = 0; i < 10; i++) world.step(1e-5);
    expect(link.branchDistance("a")).toBeGreaterThanOrEqual(-1e-12);
    expect(magnitude(a.forceSnapshot!, "pulley")).toBeCloseTo(tension, 5);
    expect(magnitude(a.forceSnapshot!, "correction")).toBeLessThan(1e-5);
  });
  for (const integrator of INTEGRATORS) {
    it.each([1, 2, 10, 100, 10_000])(`${integrator} calculates both tensions at a terminal stop (mass=%s)`, mass => {
      const { world, wheel, a, b, link } = assembly(mass, 1, true);
      world.integrator = integrator;
      const before = world.toDict();
      const transients = [link.mu, link.lambda, a.acc.copy(), b.acc.copy(), world.contacts.slice()];
      const sa = world.currentForceSnapshot(a)!;
      const sb = world.currentForceSnapshot(b)!;
      // The free hanging mass is stationary: T=m_A*g. At the stop,
      // W_B + T + R = 0, so the matching downward support is (m_A-m_B)*g.
      expect(magnitude(sa, "pulley")).toBeCloseTo(mass * world.gravity, 7);
      expect(magnitude(sb, "pulley")).toBeCloseTo(mass * world.gravity, 7);
      expect(sa.fx).toBeCloseTo(0, 7); expect(sa.fy).toBeCloseTo(0, 7);
      expect(sb.fx).toBeCloseTo(0, 7); expect(sb.fy).toBeCloseTo(0, 7);
      const reactions = sb.entries.filter(entry => entry.kind === "reaction");
      if (mass === 1) expect(reactions).toEqual([]);
      else {
        expect(reactions).toHaveLength(1);
        expect(reactions[0].id).toBe(`pulley-frame-${wheel.id}`);
        expect(reactions[0].fy).toBeCloseTo(-(mass - 1) * world.gravity, 7);
        const towardWheel = wheel.pos.sub(b.pos).div(wheel.pos.distTo(b.pos));
        expect(reactions[0].contactNx).toBeCloseTo(towardWheel.x, 10);
        expect(reactions[0].contactNy).toBeCloseTo(towardWheel.y, 10);
      }
      closure(sa); closure(sb);
      expect(magnitude(sa, "correction") + magnitude(sb, "correction")).toBe(0);
      expect(world.toDict()).toEqual(before);
      expect([link.mu, link.lambda, a.acc, b.acc, world.contacts]).toEqual(transients);
      expect(world.time).toBe(0); expect(world.stepCount).toBe(0);
      expect(a.forceSnapshot).toBeNull(); expect(b.forceSnapshot).toBeNull();
      expect(world.currentForceSnapshot(a)).toBe(sa);
    });

    it.each([2, 10, 100, 10_000])(`${integrator} shares a frictionless ceiling support with both string legs (mass=%s)`, mass => {
      const { world, a, b } = assembly(mass);
      world.integrator = integrator;
      b.collides = true; b.friction = b.restitution = 0;
      const y = b.pos.y + b.radius + 0.02;
      const ceiling = new Wall(new Vec2(0.01, y), new Vec2(2, y), 0.04);
      ceiling.friction = ceiling.restitution = 0;
      world.walls.push(ceiling);
      const before = world.toDict();
      for (const body of [a, b]) {
        const snapshot = world.currentForceSnapshot(body)!;
        expect(magnitude(snapshot, "pulley")).toBeCloseTo(mass * world.gravity, 6);
        expect(snapshot.fx).toBeCloseTo(0, 6); expect(snapshot.fy).toBeCloseTo(0, 6);
        expect(magnitude(snapshot, "correction")).toBe(0);
        closure(snapshot);
      }
      const support = world.currentForceSnapshot(b)!.entries.filter(entry => entry.kind === "reaction");
      expect(support).toHaveLength(1);
      expect(support[0].id).toBe(`reaction-wall-${ceiling.id}`);
      expect(support[0].fy).toBeCloseTo(-(mass - 1) * world.gravity, 6);
      expect(support[0].contactNx).toBeCloseTo(0, 10);
      expect(support[0].contactNy).toBeCloseTo(1, 10);
      expect(world.toDict()).toEqual(before); expect(world.time).toBe(0);
    });

    it.each([1 / 60, 1 / 120, 1 / 240])(`${integrator} attributes the incline's complete string load (dt=%s)`, dt => {
      const world = PRESETS.find(preset => preset.name === "Pulley on an incline")!.build();
      world.integrator = integrator;
      const link = world.links.find(candidate => candidate instanceof PulleyLink) as PulleyLink;
      link.a.showForceComponents = link.b.showForceComponents = true;
      const ramp = world.walls[0];
      const direction = ramp.b.sub(ramp.a); const distance = direction.length();
      const sin = direction.y / distance, cos = direction.x / distance;
      expect(link.a.mass).toBe(2); expect(link.b.mass).toBe(1.1);
      expect(link.a.friction).toBe(0.05); expect(ramp.friction).toBe(0.05);
      // T - m_A*g*sin(theta) - mu*m_A*g*cos(theta) = m_A*a
      // m_B*g - T = m_B*a, with the hanging mass moving downward.
      const reaction = link.a.mass * world.gravity * cos;
      const friction = link.a.friction * reaction;
      const acceleration = (link.b.mass * world.gravity - link.a.mass * world.gravity * sin - friction) /
        (link.a.mass + link.b.mass);
      const tension = link.b.mass * (world.gravity - acceleration);
      const initial = world.currentForceSnapshot(link.a)!;
      expect(magnitude(initial, "pulley")).toBeCloseTo(tension, 5);
      expect(magnitude(initial, "reaction")).toBeCloseTo(reaction, 5);
      expect(magnitude(initial, "friction")).toBeCloseTo(friction, 6);
      for (let frame = 0; frame < Math.round(0.5 / dt); frame++) world.step(dt);
      const a = link.a.forceSnapshot!, b = link.b.forceSnapshot!;
      expect(magnitude(a, "pulley")).toBeCloseTo(tension, 3);
      expect(magnitude(b, "pulley")).toBeCloseTo(tension, 3);
      // Capsule penetration slop slightly tilts the string during motion.
      // Check the perpendicular Newton equation with that measured direction,
      // alongside the independent tension answer above.
      const pull = a.entries.find(entry => entry.kind === "pulley")!;
      const supportedLoad = reaction - (-sin * pull.fx + cos * pull.fy);
      expect(magnitude(a, "reaction")).toBeCloseTo(supportedLoad, 7);
      expect(magnitude(a, "friction")).toBeCloseTo(link.a.friction * supportedLoad, 7);
      expect(magnitude(a, "correction") + magnitude(b, "correction")).toBeLessThan(1e-6);
      expect(link.currentLength()).toBeCloseTo(link.length, 7);
      // An accuracy bound is separate from force-ledger closure.
      expect(Math.abs(-link.b.vel.y / world.time - acceleration)).toBeLessThan(0.002);
      closure(a); closure(b);
    });

    it(`${integrator} preserves equal terminal-stop tension in completed intervals`, () => {
      const { world, a, b, wheel } = assembly(2, 1, true);
      world.integrator = integrator;
      for (let frame = 0; frame < 60; frame++) world.step(1 / 120);
      expect(magnitude(a.forceSnapshot!, "pulley")).toBeCloseTo(2 * world.gravity, 5);
      expect(magnitude(b.forceSnapshot!, "pulley")).toBeCloseTo(2 * world.gravity, 5);
      const reaction = b.forceSnapshot!.entries.filter(entry => entry.kind === "reaction");
      expect(reaction).toHaveLength(1);
      expect(reaction[0].id).toBe(`pulley-frame-${wheel.id}`);
      expect(reaction[0].fy).toBeCloseTo(-world.gravity, 5);
      expect(reaction[0].contactNx).toBeDefined(); expect(reaction[0].contactNy).toBeDefined();
      expect(magnitude(a.forceSnapshot!, "correction") + magnitude(b.forceSnapshot!, "correction"))
        .toBeLessThan(1e-6);
      closure(a.forceSnapshot!); closure(b.forceSnapshot!);
    });

    it(`${integrator} keeps a taut stopped assembly stationary in position and velocity`, () => {
      const { world, a, b, link } = assembly(2, 1, true);
      world.integrator = integrator;
      const startA = a.pos.copy(), startB = b.pos.copy();
      for (let frame = 0; frame < 60; frame++) {
        world.step(1 / 120);
        expect(a.pos.distTo(startA)).toBeLessThan(1e-8);
        expect(b.pos.distTo(startB)).toBeLessThan(1e-8);
        expect(a.vel.length() + b.vel.length()).toBeLessThan(1e-8);
        const geometry = link.geometry();
        const rate = a.vel.x * geometry.nax + a.vel.y * geometry.nay +
          b.vel.x * geometry.nbx + b.vel.y * geometry.nby;
        expect(rate).toBeLessThan(1e-8);
      }
    });
  }

  it("includes the stopped partner's support when only the moving particle has a diagram", () => {
    const { world, a, b } = assembly(100, 1, true);
    b.showForceComponents = false;
    const snapshot = world.currentForceSnapshot(a)!;
    expect(magnitude(snapshot, "pulley")).toBeCloseTo(100 * world.gravity, 7);
    expect(snapshot.fy).toBeCloseTo(0, 7);
    expect(world.currentForceSnapshot(b)).toBeNull();
  });

  it.each([0, 0.4, 1])("includes a fixed body's normal support with only the free leg's diagram (friction=%s)", friction => {
    const { world, a, b } = assembly(100);
    b.collides = true; b.friction = friction; b.showForceComponents = false;
    const support = new Body(b.pos.add(new Vec2(0, b.radius + 0.2)), 0.2, 1);
    support.locked = true; support.friction = friction; support.restitution = b.restitution = 0;
    world.bodies.push(support);
    const before = world.toDict();
    const snapshot = world.currentForceSnapshot(a)!;
    expect(magnitude(snapshot, "pulley")).toBeCloseTo(100 * world.gravity, 6);
    expect(snapshot.fy).toBeCloseTo(0, 6);
    expect(world.toDict()).toEqual(before);
    b.showForceComponents = true;
    const supported = world.currentForceSnapshot(b)!;
    const reaction = supported.entries.find(entry => entry.id === `reaction-body-${support.id}`)!;
    expect(reaction.fy).toBeCloseTo(-99 * world.gravity, 6);
    expect(reaction.contactNx).toBeCloseTo(0, 10); expect(reaction.contactNy).toBeCloseTo(1, 10);
    expect(magnitude(supported, "friction")).toBe(0);
  });

  it("clears cached terminal reactions when the endpoint leaves the stop", () => {
    const { world, a, b, link } = assembly(2, 1, true);
    const supported = world.currentForceSnapshot(b)!;
    expect(supported.entries.some(entry => entry.kind === "reaction")).toBe(true);
    b.pos.y -= 0.05; link.length = link.currentLength();
    const free = world.currentForceSnapshot(b)!;
    // Ordinary Atwood: a=g*(m_A-m_B)/(m_A+m_B), T=2*m_A*m_B*g/(m_A+m_B).
    expect(magnitude(free, "pulley")).toBeCloseTo(4 * world.gravity / 3, 9);
    expect(free.fy).toBeCloseTo(world.gravity / 3, 9);
    expect(free.entries.filter(entry => entry.kind === "reaction")).toEqual([]);
    expect(magnitude(world.currentForceSnapshot(a)!, "pulley")).toBeCloseTo(4 * world.gravity / 3, 9);
    expect(world.time).toBe(0);
  });

  it("does not reuse tension or reactions after a string becomes slack", () => {
    const { world, a, b, link } = assembly(2);
    expect(magnitude(world.currentForceSnapshot(a)!, "pulley")).toBeGreaterThan(0);
    link.length += 0.5;
    for (const body of [a, b]) {
      const snapshot = world.currentForceSnapshot(body)!;
      expect(snapshot.entries.map(entry => entry.kind)).toEqual(["weight"]);
      expect(snapshot.fy).toBeCloseTo(-body.mass * world.gravity, 10);
    }
  });

  for (const mode of ["normal", 0, 1, 2, 3] as const) {
    it.each([2, 10, 100, 10_000])(`keeps the stopped equilibrium at solver mode ${mode} (mass=%s)`, mass => {
      const { world, a, b } = assembly(mass, 1, true);
      world.performance = mode !== "normal";
      world.performanceLevel = mode === "normal" ? 0 : mode;
      expect(world.performance).toBe(mode !== "normal");
      expect(world.effectiveIntegrator).toBe(mode === "normal" ? "Velocity Verlet" : "Symplectic Euler");
      expect(world.effectiveSubsteps).toBe(mode === "normal" ? 8 : mode < 2 ? 2 : 1);
      for (let frame = 0; frame < 30; frame++) world.step(1 / 60);
      expect(a.vel.length() + b.vel.length()).toBeLessThan(1e-8);
      expect(magnitude(a.forceSnapshot!, "pulley")).toBeCloseTo(mass * world.gravity, 5);
      expect(magnitude(b.forceSnapshot!, "pulley")).toBeCloseTo(mass * world.gravity, 5);
      expect(magnitude(b.forceSnapshot!, "reaction")).toBeCloseTo((mass - 1) * world.gravity, 5);
      closure(a.forceSnapshot!); closure(b.forceSnapshot!);
    });

    it(`removes a non-stretching string's separating velocity without creating energy (${mode})`, () => {
      const { world, a, b, link } = assembly(1, 2);
      world.gravity = 0;
      world.performance = mode !== "normal";
      world.performanceLevel = mode === "normal" ? 0 : mode;
      a.vel.y = b.vel.y = -2;
      const initialEnergy = world.energy().ke;
      // One inelastic tension impulse J gives v_A=-2+J, v_B=-2+J/2.
      // The taut-string velocity condition v_A+v_B=0 therefore gives J=8/3.
      world.step(1 / 120);
      expect(a.vel.y).toBeCloseTo(2 / 3, 8);
      expect(b.vel.y).toBeCloseTo(-2 / 3, 8);
      expect(world.energy().ke).toBeCloseTo(2 / 3, 8);
      expect(world.energy().ke).toBeLessThan(initialEnergy);
      expect(link.currentLength()).toBeCloseTo(link.length, 8);
      expect(magnitude(a.forceSnapshot!, "pulley")).toBeCloseTo(320, 6);
      expect(magnitude(b.forceSnapshot!, "pulley")).toBeCloseTo(320, 6);
      expect(magnitude(a.forceSnapshot!, "correction") + magnitude(b.forceSnapshot!, "correction"))
        .toBeLessThan(1e-6);
    });
  }
});
