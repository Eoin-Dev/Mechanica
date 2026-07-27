/** A string pulls, or it does nothing. It never pushes.
 *
 * `tensionOnly` springs are the app's elastic strings: the rope tool (E)
 * builds one with k = 1000 and c = 2, the Inspector's "make this a string"
 * conversion builds the same, and two shipped presets use damped ones.
 *
 * Slackness alone does not make such a spring one-sided once it is damped.
 * The total axial force is k*ext + c*v_rel, and while the ends APPROACH,
 * v_rel is negative - so a barely stretched string has a damping term that
 * outweighs its tension and the total force changes sign. At the tool's own
 * defaults that happens below 2 mm of stretch at 1 m/s of closing speed,
 * which a swinging string crosses on every cycle: instead of going slack it
 * shoved its endpoints apart.
 *
 * The rigid rope (DistanceLink with isRope) has always clamped its
 * multiplier at zero for exactly this reason, and performance mode's
 * position-constraint form skips a slack string outright. This pins the
 * same one-sidedness on the accurate force path, which was the outlier.
 */
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
