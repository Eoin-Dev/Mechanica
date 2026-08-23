import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { PULLEY_RADIUS, PulleyLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { analysePulley, forceLedger, projectForce, slopeBasis } from "../src/education/analysis";

describe("education analysis", () => {
  it("decomposes named forces and closes exactly to the realised resultant", () => {
    const world = new World();
    world.gravity = 9.8;
    world.dragLinear = 0.5;
    const body = new Body(new Vec2(0, 1), 0.2, 2);
    body.vel.set(4, 0);
    body.constForce.set(3, 5);
    body.netForce.set(1, -14.6);
    world.bodies.push(body);
    world.stepCount = 1;

    const ledger = forceLedger(world, body);
    const sum = ledger.entries.reduce(
      (value, entry) => ({ x: value.x + entry.fx, y: value.y + entry.fy }),
      { x: 0, y: 0 });
    expect(sum.x).toBeCloseTo(body.netForce.x, 12);
    expect(sum.y).toBeCloseTo(body.netForce.y, 12);
    expect(ledger.entries.map((entry) => entry.label)).toEqual([
      "Weight", "Applied force", "Air resistance",
    ]);
  });

  it("uses an uphill tangent and outward normal for slope components", () => {
    const wall = new Wall(new Vec2(-2, -1), new Vec2(2, 1));
    const body = new Body(new Vec2(0, 1), 0.2, 1);
    const basis = slopeBasis(wall, body)!;
    expect(basis.tx).toBeGreaterThan(0);
    expect(basis.ny).toBeGreaterThan(0);
    const weight = projectForce({ fx: 0, fy: -9.8 }, basis);
    expect(weight.parallel).toBeLessThan(0);
    expect(weight.normal).toBeLessThan(0);
  });

  it("reports equal pulley tension and the balancing axle reaction", () => {
    const wheel = new Body(new Vec2(0, 1), PULLEY_RADIUS, 0);
    const a = new Body(new Vec2(-1, 0), 0.16, 2);
    const b = new Body(new Vec2(1, 0), 0.16, 1);
    const link = new PulleyLink(a, b, wheel);
    link.mu = 7.5;
    const analysis = analysePulley(link);
    expect(analysis.tension).toBe(7.5);
    const g = link.geometry();
    expect(analysis.axleReactionX).toBeCloseTo(-7.5 * (g.nax + g.nbx), 12);
    expect(analysis.axleReactionY).toBeCloseTo(-7.5 * (g.nay + g.nby), 12);
  });
});
