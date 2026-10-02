import { describe, expect, it, vi } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, PULLEY_RADIUS } from "../src/engine/body";
import { PulleyLink } from "../src/engine/links";
import { INTEGRATORS, World } from "../src/engine/world";
import { ForceRecorder } from "../src/engine/force-diagnostics";
import { analysePulley, forceLedger } from "../src/education/analysis";
import { RewindBuffer } from "../src/scene/snapshot";

function assembly(stopped = false) {
  const world = new World();
  const wheel = new Body(new Vec2(0, 1), PULLEY_RADIUS);
  wheel.isPulley = wheel.isAnchor = wheel.locked = true; wheel.collides = false;
  const a = new Body(new Vec2(-PULLEY_RADIUS, -2), 0.12, 2);
  const b = new Body(new Vec2(PULLEY_RADIUS, -0.25), 0.12, 1);
  a.collides = b.collides = false;
  const link = new PulleyLink(a, b, wheel);
  if (stopped) {
    b.pos.y = 1 - Math.sqrt((wheel.radius + b.radius) ** 2 - PULLEY_RADIUS ** 2);
    link.length = link.currentLength();
  }
  world.bodies.push(wheel, a, b); world.links.push(link);
  return { world, a, b, wheel, link };
}

describe("pulley diagnostic consistency", () => {
  it("calculates immediate Atwood tension without enabling diagrams or stepping", () => {
    const { world, a, b, link } = assembly();
    const before = world.toDict(); const liveMu = link.mu;
    const step = vi.spyOn(World.prototype, "step");
    const p = analysePulley(link, world);
    // T = 2*mA*mB*g/(mA+mB), with upward string forces on both particles.
    expect(p.tension).toBeCloseTo(2 * 2 * 1 * world.gravity / 3, 10);
    expect(p.axleReactionY).toBeCloseTo(2 * p.tension, 10);
    expect(p.forceMode).toBe("current"); expect(p.forceInterval).toBeNull();
    expect(p.accelerationA).toBeCloseTo(world.gravity / 3, 10);
    expect(p.accelerationB).toBeCloseTo(-world.gravity / 3, 10);
    expect(world.toDict()).toEqual(before); expect(link.mu).toBe(liveMu);
    expect(a.forceSnapshot).toBeNull(); expect(b.forceSnapshot).toBeNull();
    expect(a.showForceComponents).toBe(false); expect(b.showForceComponents).toBe(false);
    expect(step).not.toHaveBeenCalled(); step.mockRestore();
  });

  it("includes the frame contact in axle support at an immediate terminal stop", () => {
    const { world, link } = assembly(true);
    const p = analysePulley(link, world);
    expect(p.tension).toBeCloseTo(2 * world.gravity, 9);
    // All three bodies are stationary: the axle supports both particle weights.
    expect(p.axleReactionX).toBeCloseTo(0, 9);
    expect(p.axleReactionY).toBeCloseTo(3 * world.gravity, 9);
  });

  it("ignores a stale solver multiplier when the edited string is slack", () => {
    const { world, link } = assembly(); link.mu = 123; link.length += 1;
    const p = analysePulley(link, world);
    expect(p.slack).toBe(true); expect(p.tension).toBe(0);
    expect(p.axleReaction).toBe(0); expect(link.mu).toBe(123);
  });

  it("invalidates hidden query measurements after an authored mass edit", () => {
    const { world, a, link } = assembly();
    expect(analysePulley(link, world).tension).toBeCloseTo(4 * world.gravity / 3, 9);
    a.mass = 5;
    expect(analysePulley(link, world).tension).toBeCloseTo(10 * world.gravity / 6, 9);
    expect(world.time).toBe(0); expect(world.stepCount).toBe(0);
  });

  it("shares hidden query work without changing the default display gate", () => {
    const { world, a, b } = assembly();
    const begin = vi.spyOn(ForceRecorder.prototype, "begin");
    const first = world.currentForceSnapshot(a, [a, b]);
    const calls = begin.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(world.currentForceSnapshot(b, [a, b])).not.toBeNull();
    expect(world.currentForceSnapshot(a, [a, b])).toBe(first);
    expect(begin).toHaveBeenCalledTimes(calls);
    expect(world.currentForceSnapshot(b)).toBeNull();
    begin.mockRestore();
  });

  it("adds a requested hidden partner to an existing visible preview", () => {
    const { world, a, b } = assembly(); a.showForceComponents = true;
    expect(world.currentForceSnapshot(a)).not.toBeNull();
    expect(world.currentForceSnapshot(b)).toBeNull();
    const second = world.currentForceSnapshot(b, [a, b]);
    expect(second).not.toBeNull();
    expect(world.currentForceSnapshot(b, [a, b])).toBe(second);
    expect(b.showForceComponents).toBe(false);
  });

  it("uses a current reading when no completed force interval was recorded", () => {
    const { world, a, b, link } = assembly(); world.step(1 / 60);
    const before = world.toDict(); const p = analysePulley(link, world);
    expect(p.forceMode).toBe("current"); expect(p.forceInterval).toBeNull();
    expect(p.tension).toBeCloseTo(4 * world.gravity / 3, 9);
    expect(world.toDict()).toEqual(before);
    expect(a.forceSnapshot).toBeNull(); expect(b.forceSnapshot).toBeNull();
  });

  it("balances a fixed endpoint without manufacturing acceleration or enabling its diagram", () => {
    const { world, a, b, link } = assembly(); b.locked = true;
    const p = analysePulley(link, world);
    expect(p.tension).toBeCloseTo(a.mass * world.gravity, 10);
    expect(p.axleReactionY).toBeCloseTo(2 * a.mass * world.gravity, 10);
    expect(p.accelerationA).toBeCloseTo(0, 10); expect(p.accelerationB).toBe(0);
    expect(b.showForceComponents).toBe(false); expect(b.forceSnapshot).toBeNull();
  });

  it.each([2, 10, 100, 10_000])("balances the whole stationary axle at mass %s", mass => {
    const { world, a, b, link } = assembly(true); a.mass = mass;
    const p = analysePulley(link, world);
    expect(p.tension).toBeCloseTo(mass * world.gravity, 7);
    expect(p.axleReactionY).toBeCloseTo((mass + b.mass) * world.gravity, 7);
  });

  it("does not use detached link measurements in an unrelated world", () => {
    const { link } = assembly(); link.mu = 123;
    const p = analysePulley(link, new World());
    expect(p.tension).toBe(0); expect(p.axleReaction).toBe(0);
    expect(p.forceMode).toBe("current");
  });

  for (const integrator of INTEGRATORS) {
    it(`${integrator} uses the entire tightening impulse for separate vectors without diagrams`, () => {
      const { world, a, b, link } = assembly();
      a.mass = 1; b.mass = 2; world.gravity = 0; world.integrator = integrator;
      a.vel.y = b.vel.y = -2; link.showTensionVectors = true;
      world.step(1 / 120);
      const p = analysePulley(link, world);
      // The shared impulse is 8/3 Ns; 320 N is its average over 1/120 s.
      expect(p.tension).toBeCloseTo(320, 7);
      expect(p.forceAY).toBeCloseTo(320, 7); expect(p.forceBY).toBeCloseTo(320, 7);
      expect(p.forceMode).toBe("step-average");
      expect(p.forceInterval).toEqual({ start: 0, end: world.time });
      expect(a.showForceComponents).toBe(false); expect(b.showForceComponents).toBe(false);
    });

    it(`${integrator} records both leg measurements when only one diagram is enabled`, () => {
      const { world, a, b, link } = assembly(true); world.integrator = integrator;
      a.showForceComponents = true; world.step(1 / 60);
      const p = analysePulley(link, world);
      expect(p.tension).toBeCloseTo(19.62, 7);
      expect(p.axleReactionY).toBeCloseTo(29.43, 7);
      expect(p.forceMode).toBe("step-average");
      expect(p.forceAY).toBeCloseTo(forceLedger(world, a).entries.find(e => e.kind === "pulley")!.fy, 10);
      expect(b.forceSnapshot).not.toBeNull(); expect(b.showForceComponents).toBe(false);
    });
  }

  it("keeps averaged scalar tension separate from an averaged swinging vector", () => {
    const { world, a, b, link } = assembly();
    a.pos.set(-1.1, -1.5); b.mass = a.mass = 1;
    link.length = link.currentLength(); link.showTensionVectors = true;
    for (let i = 0; i < 60; i++) world.step(1 / 60);
    const p = analysePulley(link, world);
    const entry = a.forceSnapshot!.entries.find(e => e.kind === "pulley")!;
    expect(p.tension).toBe(entry.axialForce);
    expect(p.forceAX).toBe(entry.fx); expect(p.forceAY).toBe(entry.fy);
    expect(p.tension).toBeGreaterThanOrEqual(Math.hypot(p.forceAX, p.forceAY));
  });

  it("retains hidden link measurements and scalar tension through rewind", () => {
    const { world, a, b, link } = assembly();
    world.gravity = 0; a.mass = 1; b.mass = 2;
    a.vel.y = b.vel.y = -2; link.showTensionVectors = true;
    const history = new RewindBuffer();
    world.step(1 / 120); history.push(world);
    const wanted = analysePulley(link, world);
    world.step(1 / 120); history.push(world);
    const restored = history.back()!; const restoredLink = restored.links[0] as PulleyLink;
    expect(analysePulley(restoredLink, restored)).toEqual(wanted);
    expect(restoredLink.a.forceSnapshot?.entries.find(e => e.kind === "pulley")?.axialForce).toBeCloseTo(320, 7);
    expect(restoredLink.a.showForceComponents).toBe(false);
  });

  it("does not record hidden endpoints when every force display is disabled", () => {
    const { world, a, b } = assembly(); world.step(1 / 60);
    expect(a.forceSnapshot).toBeNull(); expect(b.forceSnapshot).toBeNull();
  });
});
