/** Elastic strings must never push, including while damped ends approach.
 * Tests cover slackness and cases where damping exceeds elastic tension. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { SpringLink } from "../src/engine/links";
import { World } from "../src/engine/world";

const DT = 1 / 120;

/** Two unit bodies `gap` apart on the x axis, closing at `closing` m/s. */
function pair(gap: number, closing: number): [Body, Body] {
  const a = new Body(new Vec2(0, 0), 0.1, 1);
  const b = new Body(new Vec2(gap, 0), 0.1, 1);
  a.vel = new Vec2(closing * 0.5, 0);
  b.vel = new Vec2(-closing * 0.5, 0);
  return [a, b];
}

/** Axial force the link applies, positive when it pulls the ends together. */
function axialPull(a: Body, b: Body, s: SpringLink): number {
  a.acc.set(0, 0);
  b.acc.set(0, 0);
  s.applyForces();
  return a.acc.x; // a sits left of b, so a pull accelerates it in +x
}

describe("a damped string is one-sided", () => {
  it("never pushes, however fast its ends are closing", () => {
    // the rope tool's own defaults
    for (const closing of [0.1, 1, 5, 50, 500]) {
      for (const gap of [1.0, 1.0002, 1.0005, 1.001, 1.01, 1.2]) {
        const [a, b] = pair(gap, closing);
        const s = new SpringLink(a, b, 1.0, 1000.0, 2.0, true);
        expect(axialPull(a, b, s)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("still pulls when genuinely stretched and slow", () => {
    const [a, b] = pair(1.2, 0);
    const s = new SpringLink(a, b, 1.0, 1000.0, 2.0, true);
    expect(axialPull(a, b, s)).toBeCloseTo(200, 6); // k * ext = 1000 * 0.2
    expect(s.axialForce).toBeCloseTo(200, 6);
  });

  it("still damps a stretch that is getting worse", () => {
    // separating at 1 m/s: v_rel is positive, so damping ADDS to the pull
    const [a, b] = pair(1.2, -1);
    const s = new SpringLink(a, b, 1.0, 1000.0, 2.0, true);
    expect(axialPull(a, b, s)).toBeCloseTo(202, 6); // 1000*0.2 + 2*1
  });

  it("never pushes even undamped, whatever the stiffness", () => {
    // the guard sits on the TOTAL force rather than inside the damping
    // branch, so a negative stiffness (no slider offers one, and the
    // stability clamp only bounds k from above) cannot push either
    const [a, b] = pair(1.2, 0);
    const s = new SpringLink(a, b, 1.0, -500.0, 0.0, true);
    expect(axialPull(a, b, s)).toBeGreaterThanOrEqual(0);
  });

  it("leaves an ordinary two-sided spring free to push", () => {
    const [a, b] = pair(0.8, 0); // compressed by 0.2 m
    const s = new SpringLink(a, b, 1.0, 1000.0, 2.0, false);
    expect(axialPull(a, b, s)).toBeCloseTo(-200, 6);
    expect(s.axialForce).toBeCloseTo(-200, 6);
  });

  it.each([false, true])("publishes one independent force for every link in a chain (performance=%s)",
    (performance) => {
      const w = new World();
      w.gravity = 0;
      w.performance = performance;
      const a = new Body(new Vec2(0, 0), 0.1, 1);
      const b = new Body(new Vec2(1.2, 0), 0.1, 1);
      const c = new Body(new Vec2(2.5, 0), 0.1, 1);
      const left = new SpringLink(a, b, 1, 100, 0, true);
      const right = new SpringLink(b, c, 1, 100, 0, true);
      w.bodies.push(a, b, c);
      w.links.push(left, right);
      w.step(DT);

      expect(left.axialForce).toBeGreaterThan(0);
      expect(right.axialForce).toBeGreaterThan(left.axialForce);
      expect(Number.isFinite(left.axialForce)).toBe(true);
      expect(Number.isFinite(right.axialForce)).toBe(true);
    });

  it("a hanging damped string never lifts its bob", () => {
    // The failure was visible, not theoretical: a bob on a string that is
    // being overtaken by its anchor got shoved downward-outward instead of
    // simply going slack.
    const w = new World();
    const anchor = new Body(new Vec2(0, 0), 0.05, 1);
    anchor.isAnchor = true;
    anchor.locked = true;
    const bob = new Body(new Vec2(0, -1), 0.1, 1);
    w.bodies.push(anchor, bob);
    w.links.push(new SpringLink(anchor, bob, 1.0, 1000.0, 2.0, true));
    let highest = bob.pos.y;
    for (let i = 0; i < 600; i++) {
      w.step(DT);
      if (bob.pos.y > highest) highest = bob.pos.y;
    }
    // it may hang and stretch, but it can never be pushed ABOVE the anchor
    expect(highest).toBeLessThan(0);
    expect(Number.isFinite(bob.pos.y)).toBe(true);
  });
});
