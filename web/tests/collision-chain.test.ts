/** Impulse propagation through touching chains (Newton's cradle physics).
 *
 * With the restitution bias frozen at pre-solve velocities, interior
 * contacts of a touching chain resolve as perfectly inelastic and the
 * incoming impulse smears across the chain (several balls drift out
 * slowly). Restitution propagation raises a contact's bias when a genuine
 * approach speed appears mid-solve, so impulses hand down the chain
 * pairwise: one ball in, one ball out. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { World } from "../src/engine/world";

const DT = 1.0 / 120.0;

/** A striker flying into a row of touching, identical, elastic balls. */
function cradle(nChain: number, e: number, strikerVx = 2.0) {
  const w = new World();
  w.gravity = 0.0;
  w.substeps = 8;
  w.iterations = 15;
  const r = 0.15;
  const mk = (x: number): Body => {
    const b = new Body(new Vec2(x, 0), r, 1.0);
    b.restitution = e;
    b.friction = 0.0;
    w.bodies.push(b);
    return b;
  };
  // touching chain at x = 0, 2r, 4r, ...; striker approaches from the left
  for (let i = 0; i < nChain; i++) mk(i * 2 * r);
  const striker = mk(-2 * r - 0.1);
  striker.vel.x = strikerVx;
  const momentum = () => w.bodies.reduce((s, b) => s + b.mass * b.vel.x, 0);
  const ke = () => w.bodies.reduce(
    (s, b) => s + 0.5 * b.mass * (b.vel.x ** 2 + b.vel.y ** 2), 0);
  const p0 = momentum();
  const ke0 = ke();
  for (let i = 0; i < 60; i++) w.step(DT); // 0.5 s: impact + separation
  return { w, striker, p0, ke0, momentum, ke };
}

describe("collision chains", () => {
  it("Newton's cradle: one ball in, one ball out", () => {
    const { w, striker, p0, ke0, momentum, ke } = cradle(4, 1.0);
    const chain = w.bodies.filter((b) => b !== striker);
    const last = chain[chain.length - 1];
    // the far ball carries (nearly) all the incoming speed...
    expect(last.vel.x).toBeGreaterThan(2.0 * 0.9);
    // ...and everything else is left (nearly) at rest
    for (const b of [striker, ...chain.slice(0, -1)]) {
      expect(Math.abs(b.vel.x)).toBeLessThan(2.0 * 0.1);
    }
    // conservation: momentum exact, energy not injected
    expect(momentum()).toBeCloseTo(p0, 6);
    expect(ke()).toBeLessThanOrEqual(ke0 * 1.001);
    expect(ke()).toBeGreaterThan(ke0 * 0.9);
  });

  it("never injects energy, even for lossy chains", () => {
    for (const e of [0.0, 0.5, 0.9]) {
      const { p0, ke0, momentum, ke } = cradle(4, e);
      expect(momentum()).toBeCloseTo(p0, 6);
      expect(ke()).toBeLessThanOrEqual(ke0 * 1.001);
    }
  });
});
