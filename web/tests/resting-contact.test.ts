/** Resting-contact performance: bodies held in place by contacts must not
 * trigger the close-encounter time-slicing machinery (their acceleration is
 * cancelled by contact impulses, not free-flight motion). A resting
 * mutual-gravity cluster used to cost ~50x more per step than the same
 * bodies spread apart; these tests pin down the fix without giving up the
 * adaptive accuracy that free-flying encounters rely on.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { Wall } from "../src/engine/body";
import { World } from "../src/engine/world";

const DT = 1.0 / 120.0;

function particle(w: World, x: number, y: number, r = 0.15, m = 1.0): Body {
  const b = new Body(new Vec2(x, y), r, m);
  w.bodies.push(b);
  return b;
}

describe("resting contact", () => {
  it("a resting mutual-gravity cluster steps fast and stays put", () => {
    const w = new World();
    w.substeps = 8;
    w.gravity = 0.0;
    w.mutualGravity = true;
    w.G = 1.0;
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 4; j++) particle(w, -1.5 + i * 0.30, j * 0.30);
    }
    for (let i = 0; i < 120; i++) w.step(DT); // settle into contact
    const before = w.bodies.map((b) => [b.pos.x, b.pos.y]);
    const t0 = performance.now();
    for (let i = 0; i < 120; i++) w.step(DT);
    const msPerStep = (performance.now() - t0) / 120;
    // was ~85 ms/step when contact-held bodies were sliced as encounters;
    // generous bound so slow CI machines never flake
    expect(msPerStep).toBeLessThan(15.0);
    // and the cluster is genuinely at rest, not jittering
    w.bodies.forEach((b, i) => {
      expect(Math.hypot(b.pos.x - before[i][0], b.pos.y - before[i][1]))
        .toBeLessThan(0.02);
    });
  });

  it("a pile under plain gravity stays cheap and settled on its wall", () => {
    const w = new World();
    w.substeps = 8;
    w.walls.push(new Wall(new Vec2(-4, 0), new Vec2(4, 0), 0.1));
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 4; j++) particle(w, -1.5 + i * 0.31, 0.21 + j * 0.31);
    }
    for (let i = 0; i < 240; i++) w.step(DT); // settle
    const t0 = performance.now();
    for (let i = 0; i < 120; i++) w.step(DT);
    expect((performance.now() - t0) / 120).toBeLessThan(10.0);
    for (const b of w.bodies) expect(b.pos.y).toBeGreaterThan(0.0);
  });

  it("free-flying deep encounters still get adaptive slicing (energy safe)", () => {
    // a close two-body flyby never touches, so the touching-flag skip must
    // not affect it: energy through the violent swing stays conserved
    const w = new World();
    w.substeps = 8;
    w.gravity = 0.0;
    w.mutualGravity = true;
    w.pointGravity = true; // hardest case: the near-singular pass
    w.G = 1.0;
    w.softening = 0.01;
    const a = particle(w, -4.0, 0.02, 0.05, 2.0);
    const b = particle(w, 4.0, -0.02, 0.05, 2.0);
    a.vel.set(1.5, 0.0);
    b.vel.set(-1.5, 0.0);
    a.collides = false;
    b.collides = false;
    const e0 = w.energy().total;
    for (let i = 0; i < 720; i++) w.step(DT);
    const e1 = w.energy().total;
    expect(Math.abs(e1 - e0) / Math.abs(e0)).toBeLessThan(0.02);
  });

  it("collision accuracy is preserved under mutual gravity", () => {
    // symmetric head-on elastic impact: exact momentum, conserved energy,
    // mirror-image exit velocities to several decimal places
    const w = new World();
    w.substeps = 8;
    w.gravity = 0.0;
    w.mutualGravity = true;
    w.G = 1.0;
    const a = particle(w, -1.5, 0.0);
    const b = particle(w, 1.5, 0.0);
    a.restitution = 1.0;
    b.restitution = 1.0;
    a.friction = 0.0;
    b.friction = 0.0;
    a.vel.set(2.0, 0.0);
    b.vel.set(-2.0, 0.0);
    const e0 = w.energy().total;
    for (let i = 0; i < 300; i++) w.step(DT); // approach, bounce, separate
    expect(a.pos.x).toBeLessThan(-0.3); // they really did bounce apart
    // momentum stays exactly zero by symmetry
    expect(Math.abs(a.mass * a.vel.x + b.mass * b.vel.x)).toBeLessThan(1e-9);
    // mirror symmetry of the pair holds to high precision
    expect(a.vel.x).toBeCloseTo(-b.vel.x, 9);
    expect(a.pos.x).toBeCloseTo(-b.pos.x, 9);
    // elastic bounce with equal masses: energy conserved through the hit.
    // (~1% drift here is pre-existing impact bookkeeping - verified
    // bit-identical with and without the touching-flag optimisation)
    expect(Math.abs(w.energy().total - e0) / Math.abs(e0)).toBeLessThan(0.02);
  });
});
