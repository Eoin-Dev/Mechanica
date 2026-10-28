import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import type { ForceEntry, ForceKind, ForceSnapshot } from "../src/engine/force-diagnostics";
import { World } from "../src/engine/world";
import { ForcePresentation } from "../src/render/force-invalidation";

function sample(entries: readonly ForceEntry[]): ForceSnapshot {
  return Object.freeze({ entries: Object.freeze(entries), startTime: 0, endTime: 1 / 120,
    stepCount: 1, x: 0, y: 0, vx: 0, vy: 0, mass: 1, fx: 0, fy: 0 });
}

function setup(kind: ForceKind = "friction") {
  const world = new World(), body = new Body(new Vec2());
  body.showForceComponents = true;
  const entry: ForceEntry = { id: "source", label: "Source", kind, fx: 1, fy: 0 };
  body.forceSnapshot = sample([entry]); world.bodies.push(body);
  const presentation = new ForcePresentation(); presentation.mark(world, false);
  return { world, body, entry, presentation };
}

describe("visible force presentation invalidation", () => {
  const kinds: ForceKind[] = ["weight", "applied", "drag", "gravity", "driver", "field",
    "spring", "string", "rod", "pulley", "reaction", "friction", "correction"];
  it.each(kinds)("repaints a changing %s vector even when the particle and resultant stay still", kind => {
    const { world, body, entry, presentation } = setup(kind);
    body.forceSnapshot = sample([{ ...entry, fx: 1.5 }]);
    expect(presentation.changed(world, 5, false)).toBe(true);
    presentation.mark(world, false);
    expect(presentation.changed(world, 5, false)).toBe(false);
  });

  it("does not continuously repaint identical immutable force samples", () => {
    const { world, body, entry, presentation } = setup();
    for (let i = 0; i < 100; i++) {
      body.forceSnapshot = sample([{ ...entry }]);
      expect(presentation.changed(world, 5, false)).toBe(false);
    }
  });

  it("accumulates small unpainted vector changes instead of losing every increment", () => {
    const { world, body, entry, presentation } = setup();
    body.forceSnapshot = sample([{ ...entry, fy: 0.005 }]);
    expect(presentation.changed(world, 5, false)).toBe(false);
    body.forceSnapshot = sample([{ ...entry, fy: 0.009 }]);
    expect(presentation.changed(world, 5, false)).toBe(false);
    body.forceSnapshot = sample([{ ...entry, fy: 0.011 }]);
    expect(presentation.changed(world, 5, false)).toBe(true);
  });

  it("updates a changed numerical caption even below the geometric threshold", () => {
    const { world, body, entry, presentation } = setup();
    body.forceSnapshot = sample([{ ...entry, fx: 1.01 }]);
    expect(presentation.changed(world, 0.001, false)).toBe(true);
  });

  it("preserves real discontinuities including force appearance, disappearance and contact-origin changes", () => {
    const { world, body, entry, presentation } = setup();
    body.forceSnapshot = sample([{ ...entry, contactNx: 0, contactNy: -1 }]);
    expect(presentation.changed(world, 0.001, false)).toBe(true);
    presentation.mark(world, false);
    body.forceSnapshot = sample([]);
    expect(presentation.changed(world, 0.001, false)).toBe(true);
    presentation.mark(world, false);
    body.forceSnapshot = sample([entry]);
    expect(presentation.changed(world, 0.001, false)).toBe(true);
    presentation.mark(world, false);
    body.forceSnapshot = null;
    expect(presentation.changed(world, 0.001, false)).toBe(true);
  });

  it("tracks enabled particles across deletion, disablement and replacement", () => {
    const { world, body, presentation } = setup();
    body.showForceComponents = false;
    expect(presentation.changed(world, 5, false)).toBe(true);
    presentation.mark(world, false);
    expect(presentation.changed(world, 5, false)).toBe(false);
    body.showForceComponents = true;
    expect(presentation.changed(world, 5, false)).toBe(true);
    presentation.mark(world, false);
    world.bodies[0] = Body.fromDict(body.toDict());
    world.bodies[0].showForceComponents = true;
    expect(presentation.changed(world, 5, false)).toBe(true);
    presentation.mark(world, false);
    world.bodies.length = 0;
    expect(presentation.changed(world, 5, false)).toBe(true);
  });

  it("omits anchor and hidden endpoint diagnostics", () => {
    const { world, body, presentation } = setup();
    body.isAnchor = true; presentation.mark(world, false);
    expect(presentation.changed(world, 5, false)).toBe(false);
    body.isAnchor = false; body.isRodEndpoint = true;
    expect(presentation.changed(world, 5, false)).toBe(false);
  });

  it.each([0, 1, 2, 3])("does not read force snapshots in Performance tier %s", level => {
    const { world, body, presentation } = setup(); world.performance = true; world.performanceLevel = level;
    Object.defineProperty(body, "forceSnapshot", { get: () => { throw new Error("Dormant diagnostic was read"); } });
    expect(presentation.changed(world, 5, true)).toBe(false);
    expect(() => presentation.mark(world, true)).not.toThrow();
  });
});
