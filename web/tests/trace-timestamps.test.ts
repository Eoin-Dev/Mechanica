import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { ENCOUNTER_ANGLE, World } from "../src/engine/world";
import { Trail } from "../src/render/trail";

function orbit(trace: boolean, performance = false) {
  const world = new World(); world.gravity = 0; world.mutualGravity = true;
  world.G = 1; world.softening = 0; world.substeps = 8; world.integrator = "RK4";
  world.encounterAngle = ENCOUNTER_ANGLE / 10; world.traceSpacing = trace ? 0.001 : 0;
  world.performance = performance; world.performanceLevel = 3;
  const a = new Body(new Vec2(-0.2, 0), 0.05, 1);
  const b = new Body(new Vec2(0.2, 0), 0.05, 1);
  a.vel.y = -Math.sqrt(1.25); b.vel.y = Math.sqrt(1.25);
  world.bodies.push(a, b); return world;
}

describe("adaptive trail sample clocks", () => {
  it("uses each captured position's simulation time across multiple steps", () => {
    const world = orbit(true); const speed = Math.sqrt(1.25) / 0.2;
    for (let step = 0; step < 4; step++) {
      const begin = world.time; world.step(1 / 120);
      expect(world.trace.length).toBeGreaterThan(0);
      const last = new Map<number, number>();
      for (const point of world.trace) {
        expect(point).toHaveLength(4);
        const [id, x, y, time] = point;
        expect(Number.isFinite(time)).toBe(true);
        expect(time).toBeGreaterThanOrEqual(begin);
        expect(time).toBeLessThan(world.time);
        expect(time).toBeGreaterThanOrEqual(last.get(id) ?? begin); last.set(id, time);
        const direction = id === world.bodies[0].id ? -1 : 1;
        expect(x).toBeCloseTo(direction * 0.2 * Math.cos(speed * time), 7);
        expect(y).toBeCloseTo(direction * 0.2 * Math.sin(speed * time), 7);
      }
      world.trace.length = 0;
    }
  });

  it("keeps intermediate samples on the past side of a mid-step rewind", () => {
    const world = orbit(true); world.step(1 / 120);
    const samples = world.trace.filter(point => point[0] === world.bodies[0].id);
    const trail = new Trail(100); for (const [, x, y, time] of samples) trail.push(x, y, time);
    const target = 1 / 240;
    const expected = samples.filter(point => point[3] <= target + 1e-12);
    expect(expected.length).toBeGreaterThan(0); expect(expected.length).toBeLessThan(samples.length);
    trail.truncateAfter(target);
    expect(trail.count).toBe(expected.length);
    for (let k = 0; k < trail.count; k++) {
      expect([trail.x(k), trail.y(k), trail.time(k)]).toEqual(expected[k].slice(1));
    }
  });

  it.each([false, true])("tracing preserves identical Normal solver motion (Performance %s)", performance => {
    const enabled = orbit(true, performance); const disabled = World.fromDict(enabled.toDict());
    disabled.performance = performance; disabled.performanceLevel = 3;
    disabled.encounterAngle = enabled.encounterAngle; disabled.traceSpacing = 0;
    for (let k = 0; k < 10; k++) {
      enabled.step(1 / 120); disabled.step(1 / 120);
      expect(enabled.toDict()).toEqual(disabled.toDict());
      if (performance) expect(enabled.trace).toHaveLength(0);
      enabled.trace.length = 0;
    }
  });
});
