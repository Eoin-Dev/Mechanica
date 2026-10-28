/** Requested premade presentation defaults checked against independent mechanics. */
import { describe, expect, it } from "vitest";
import { analysePulley } from "../src/education/analysis";
import type { ForceKind, ForceSnapshot } from "../src/engine/force-diagnostics";
import { PulleyLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { CATEGORIES, PRESETS } from "../src/scene/presets";

const preset = (name: string) => PRESETS.find(candidate => candidate.name === name)!;
const magnitude = (reading: ForceSnapshot, kind: ForceKind): number => reading.entries
  .filter(entry => entry.kind === kind).reduce((sum, entry) => sum + Math.hypot(entry.fx, entry.fy), 0);

describe("requested ramp and pulley defaults", () => {
  it("opens graphs only for explicit phase, elastic-energy and momentum investigations", () => {
    expect(PRESETS.filter(preset => preset.hints.graph !== undefined).map(preset => preset.name))
      .toEqual(["Mass on a spring", "Elastic string release", "Elastic vs inelastic", "Direct collision"]);
  });
  it("shows each friction-ramp particle against its own plane with physical static or limiting friction", () => {
    const world = preset("Friction ramp").build();
    const theta = 25 * Math.PI / 180;
    world.bodies.forEach((body, index) => {
      const ramp = world.walls[index * 3];
      expect(body.showForceComponents).toBe(true);
      expect(body.resolveWeightOnSlope).toBe(true);
      expect(body.forceSlopeWallId).toBe(ramp.id);
      const reading = world.currentForceSnapshot(body)!;
      const reaction = body.mass * world.gravity * Math.cos(theta);
      const alongSlope = body.mass * world.gravity * Math.sin(theta);
      const friction = Math.min(alongSlope, Math.sqrt(body.friction * ramp.friction) * reaction);
      expect(magnitude(reading, "reaction")).toBeCloseTo(reaction, 8);
      expect(magnitude(reading, "friction")).toBeCloseTo(friction, 8);
      const tangentX = Math.cos(theta), tangentY = -Math.sin(theta);
      expect((reading.fx * tangentX + reading.fy * tangentY) / body.mass)
        .toBeCloseTo((alongSlope - friction) / body.mass, 8);
    });
    expect(world.time).toBe(0);
  });

  it("opens both incline-pulley diagrams with resolved slope weight, ordinary hanging weight and tension enabled", () => {
    const selected = preset("Pulley on an incline"), world = selected.build();
    const link = world.links[0] as PulleyLink, ramp = world.walls[0];
    expect(selected.category).toBe("Rods & Pulleys");
    expect(selected.hints.graph).toBeUndefined();
    expect(link.a.showForceComponents && link.b.showForceComponents).toBe(true);
    expect(link.a.resolveWeightOnSlope).toBe(true);
    expect(link.a.forceSlopeWallId).toBe(ramp.id);
    expect(link.b.resolveWeightOnSlope).toBe(false);
    expect(link.b.forceSlopeWallId).toBeNull();
    expect(link.showTensionVectors).toBe(true);
    const direction = ramp.b.sub(ramp.a), distance = direction.length();
    const sin = direction.y / distance, cos = direction.x / distance;
    const reaction = link.a.mass * world.gravity * cos;
    expect(link.a.mass).toBe(2); expect(link.b.mass).toBe(2);
    expect(link.a.friction).toBe(0.25); expect(ramp.friction).toBe(0.25);
    const friction = 0.25 * reaction;
    const acceleration = (link.b.mass * world.gravity - link.a.mass * world.gravity * sin - friction) /
      (link.a.mass + link.b.mass);
    const tension = link.b.mass * (world.gravity - acceleration);
    expect(acceleration).toBeGreaterThan(1);
    expect(friction).toBeGreaterThan(4);
    const reading = world.currentForceSnapshot(link.a)!;
    expect(magnitude(reading, "reaction")).toBeCloseTo(reaction, 5);
    expect(magnitude(reading, "friction")).toBeCloseTo(friction, 6);
    expect(magnitude(reading, "pulley")).toBeCloseTo(tension, 5);
  });

  it.each([false, 0, 1, 2, 3] as const)("calculates paused tension immediately with diagrams off (Performance=%s)", level => {
    const world = preset("Pulley on an incline").build(), link = world.links[0] as PulleyLink;
    world.performance = level !== false;
    if (level !== false) world.performanceLevel = level;
    link.a.showForceComponents = link.b.showForceComponents = false;
    link.showTensionVectors = false;
    link.showTensionVectors = true;
    const before = world.toDict();
    const reading = analysePulley(link, world);
    expect(reading.tension).toBeGreaterThan(0);
    expect(Math.hypot(reading.forceAX, reading.forceAY)).toBeCloseTo(reading.tension, 8);
    expect(Math.hypot(reading.forceBX, reading.forceBY)).toBeCloseTo(reading.tension, 8);
    expect(reading.forceMode).toBe("current");
    expect(reading.forceInterval).toBeNull();
    expect(world.time).toBe(0); expect(world.stepCount).toBe(0);
    expect(world.toDict()).toEqual(before);
    expect(link.mu).toBe(0); expect(link.lambda).toBe(0);
  });

  it("keeps the same library count and categories while grouping the incline pulley once", () => {
    expect(PRESETS.filter(candidate => candidate.name === "Pulley on an incline")).toHaveLength(1);
    expect(PRESETS.filter(candidate => candidate.category === "Rods & Pulleys")).toHaveLength(7);
    expect(PRESETS.filter(candidate => candidate.category === "Projectiles & Friction")).toHaveLength(9);
    expect(CATEGORIES).toHaveLength(10);
  });

  it("sets Which lands first? to quarter-speed presentation with the unchanged physical launch", () => {
    const selected = preset("Which lands first?"), world = selected.build();
    expect(selected.hints.speed).toBe(0.25);
    expect(world.bodies.map(body => body.vel.x)).toEqual([0, 6]);
    expect(world.bodies[0].pos.y).toBe(world.bodies[1].pos.y);
    expect(world.gravity).toBe(9.81);
  });
});

describe("soft-body premade spin defaults", () => {
  it.each(PRESETS.filter(p => p.category === "Soft Bodies").map(p => [p.name, p] as const))(
    "%s locks every particle, including rigid loads, and preserves the default in portable scenes", (_name, example) => {
      const world = example.build(); expect(world.bodies.length).toBeGreaterThan(0);
      expect(world.bodies.every(body => body.noRotation && body.omega === 0)).toBe(true);
      const restored = World.fromDict(world.toDict());
      for (let i = 0; i < 12; i++) restored.step(1 / 120);
      expect(restored.bodies.every(body => body.noRotation && body.omega === 0)).toBe(true);
    });
  it("leaves ordinary rigid-particle examples free to rotate", () => {
    expect(preset("Projectile drag race").build().bodies.every(body => !body.noRotation)).toBe(true);
  });
});
