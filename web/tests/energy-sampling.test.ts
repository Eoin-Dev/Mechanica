import { describe, expect, it } from "vitest";
import { World } from "../src/engine/world";
import { Body } from "../src/engine/body";
import { Vec2 } from "../src/core/vec";

/** Independent softened point-pair sum for separated particles. */
function expectedPotential(bodies: readonly Body[], G: number, softening: number): number {
  let sum = 0;
  for (let i = 0; i < bodies.length; i++) {
    if (bodies[i].isAnchor || bodies[i].isRodEndpoint) continue;
    for (let j = i + 1; j < bodies.length; j++) {
      if (bodies[j].isAnchor || bodies[j].isRodEndpoint) continue;
      const a = bodies[i], b = bodies[j];
      sum -= G * a.mass * b.mass / Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y, softening);
    }
  }
  return sum;
}

function alternatingMasses(heavyParity: number): World {
  const w = new World(); w.gravity = 0; w.G = 1; w.softening = 0.1; w.mutualGravity = true;
  for (let i = 0; i < 200; i++)
    w.bodies.push(new Body(new Vec2(i % 20, Math.floor(i / 20)), 0.05, i % 2 === heavyParity ? 1 : 0.01));
  return w;
}

describe("bounded mutual-energy estimates", () => {
  for (const heavyParity of [0, 1]) {
    it.each([2000, 4000, 8000, 12000])(`samples both mass parities against a pair-sum oracle (heavy ${heavyParity}, budget %s)`, budget => {
      const w = alternatingMasses(heavyParity);
      const expected = expectedPotential(w.bodies, w.G, w.softening);
      const estimate = w.energy(budget);
      // Finite sampling has variance; this fixture rejects systematic parity
      // omission without claiming exact energy from an approximate mode.
      expect(Math.abs(estimate.pe - expected) / Math.abs(expected)).toBeLessThan(0.08);
      expect(w.energy().pe).toBeCloseTo(expected, 9);
      expect(w.energy(budget)).toEqual(estimate);
    });
  }

  it("excludes internal coordinates from the sampled population but retains locked physical masses", () => {
    const w = alternatingMasses(1);
    w.bodies[1].locked = true;
    for (const internalRod of [false, true]) {
      const internal = new Body(new Vec2(0, 0), 0.05, 1e6);
      internal.isAnchor = !internalRod; internal.isRodEndpoint = internalRod;
      w.bodies.unshift(internal);
    }
    const expected = expectedPotential(w.bodies, w.G, w.softening);
    expect(w.energy().pe).toBeCloseTo(expected, 9);
    expect(Math.abs(w.energy(8000).pe - expected) / Math.abs(expected)).toBeLessThan(0.08);
  });

  it("bounds work by the pair budget without mutating physical inputs or identities", () => {
    const w = alternatingMasses(1);
    const before = JSON.stringify(w.toDict()), nextId = Body.nextId;
    let xReads = 0;
    for (const b of w.bodies) {
      const x = b.pos.x;
      Object.defineProperty(b.pos, "x", { configurable: true, get: () => { xReads++; return x; } });
    }
    w.energy(512);
    expect(xReads).toBe(1024);
    expect(JSON.stringify(w.toDict())).toBe(before);
    expect(Body.nextId).toBe(nextId);
  });

  it.each([0, 1, 2, 3])("keeps the exact path when its pair count fits the budget (count %s)", count => {
    const w = new World(); w.gravity = 0; w.G = -2; w.softening = 0.2; w.mutualGravity = true;
    for (let i = 0; i < count; i++) w.bodies.push(new Body(new Vec2(i * 2, i), 0.05, i + 1));
    const expected = expectedPotential(w.bodies, w.G, w.softening);
    expect(w.energy(Math.max(1, count * (count - 1) / 2)).pe).toBeCloseTo(expected, 12);
  });
});
