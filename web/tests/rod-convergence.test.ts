/** Rod length error and energy drift under demanding chain loads.
 * Horizontal heavy chains exercise the acceleration-level tension solve and
 * XPBD correction. Contacts are disabled to isolate rod convergence. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { DistanceLink } from "../src/engine/links";
import { World } from "../src/engine/world";

const DT = 1 / 120;

function chain(n: number, mass: number, substeps: number) {
  const w = new World();
  w.substeps = substeps;
  const anchor = new Body(new Vec2(0, 0), 0.05, 1);
  anchor.isAnchor = true;
  anchor.locked = true;
  w.bodies.push(anchor);
  let prev: Body = anchor;
  const links: DistanceLink[] = [];
  for (let i = 1; i <= n; i++) {
    const b = new Body(new Vec2(i * 0.25, 0), 0.06, mass);
    b.collides = false;
    w.bodies.push(b);
    const ln = new DistanceLink(prev, b, 0.25);
    w.links.push(ln);
    links.push(ln);
    prev = b;
  }
  return { w, links };
}

/** Worst link-length error and worst energy excursion over `seconds`. */
function measure(n: number, mass: number, substeps: number, seconds: number) {
  const { w, links } = chain(n, mass, substeps);
  const e0 = w.energy().total;
  let lenErr = 0;
  let dE = 0;
  let diverged = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    w.step(DT);
    diverged += w.diverged.length;
    for (const ln of links) {
      const err = Math.abs(ln.a.pos.distTo(ln.b.pos) - ln.length);
      if (err > lenErr) lenErr = err;
    }
    const d = Math.abs(w.energy().total - e0);
    if (d > dE) dE = d;
  }
  return { lenErr, dE, diverged };
}

describe("a rod chain is exact and conserves energy", () => {
  it("holds every link's length to microns at a well-resolved timestep", () => {
    const { lenErr, diverged } = measure(8, 1, 16, 10);
    expect(diverged).toBe(0);
    expect(lenErr).toBeLessThan(1e-5);
  });

  it("conserves energy through a full swing", () => {
    // released horizontally, so the whole 78 J of potential swings through
    // kinetic and back; anything the solver injects or drains shows here
    const { dE } = measure(8, 1, 16, 10);
    expect(dE).toBeLessThan(0.6);
  });

  it("never blows up even badly under-resolved", () => {
    const { diverged, lenErr } = measure(20, 3, 4, 10);
    expect(diverged).toBe(0);
    expect(lenErr).toBeLessThan(0.05); // 5 cm on a 25 cm link: ugly, not broken
  });
});

describe("the solver converges with the timestep", () => {
  it("finer substeps give strictly better link lengths", () => {
    // the property that distinguishes a converging solver from one that has
    // simply been tuned to look right at one setting
    const coarse = measure(8, 1, 4, 6).lenErr;
    const medium = measure(8, 1, 8, 6).lenErr;
    const fine = measure(8, 1, 16, 6).lenErr;
    expect(medium).toBeLessThan(coarse);
    expect(fine).toBeLessThan(medium);
    // and by a real margin, not a rounding difference
    expect(fine * 4).toBeLessThan(coarse);
  });

  it("finer substeps give strictly better energy conservation", () => {
    const coarse = measure(8, 1, 4, 6).dE;
    const fine = measure(8, 1, 16, 6).dE;
    expect(fine).toBeLessThan(coarse);
  });
});

describe("a rope is one-sided where a rod is not", () => {
  it("a rope goes slack instead of pushing its ends apart", () => {
    const w = new World();
    w.substeps = 8;
    const anchor = new Body(new Vec2(0, 0), 0.05, 1);
    anchor.isAnchor = true;
    anchor.locked = true;
    const bob = new Body(new Vec2(0, -0.5), 0.06, 1);
    bob.collides = false;
    w.bodies.push(anchor, bob);
    // natural length 2 m, but the bob starts 0.5 m away: deeply slack
    w.links.push(new DistanceLink(anchor, bob, 2.0, true));
    for (let i = 0; i < 30; i++) w.step(DT);
    // it must simply fall; a rope that pushed would fling it downward faster
    // than gravity, and one that pulled would hold it up
    const t = 30 * DT;
    expect(bob.vel.y).toBeCloseTo(-9.81 * t, 1);
  });

  it("a rope still stops the fall once it comes taut", () => {
    const w = new World();
    w.substeps = 8;
    const anchor = new Body(new Vec2(0, 0), 0.05, 1);
    anchor.isAnchor = true;
    anchor.locked = true;
    const bob = new Body(new Vec2(0, -0.5), 0.06, 1);
    bob.collides = false;
    w.bodies.push(anchor, bob);
    w.links.push(new DistanceLink(anchor, bob, 1.0, true));
    for (let i = 0; i < Math.round(5 / DT); i++) w.step(DT);
    expect(anchor.pos.distTo(bob.pos)).toBeLessThan(1.0 + 1e-3);
  });
});
