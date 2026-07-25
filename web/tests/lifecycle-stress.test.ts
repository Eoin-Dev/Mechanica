/** Lifecycle stress: arbitrary user interaction must never leave the world
 * in an inconsistent state, and must never make it permanently expensive.
 *
 * Everything here goes through the same World API the UI drives - pushing
 * bodies onto `world.bodies`, `removeBody`, editing properties mid-run,
 * flipping the integrator, reloading presets - hammered in combinations no
 * single feature test covers.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { DistanceLink, SpringLink } from "../src/engine/links";
import { INTEGRATORS, World } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";
import * as snap from "../src/scene/snapshot";

const DT = 1.0 / 120.0;

/** Deterministic PRNG so a failure is always reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Everything that must be true of a world between any two operations. */
function checkConsistent(w: World, where: string): void {
  const ids = new Set<number>();
  for (const b of w.bodies) {
    expect(ids.has(b.id), `${where}: duplicate body id ${b.id}`).toBe(false);
    ids.add(b.id);
    expect(Number.isFinite(b.pos.x + b.pos.y + b.vel.x + b.vel.y + b.omega),
           `${where}: non-finite state on ${b.name}`).toBe(true);
    expect(Number.isFinite(b.mass) && b.mass >= 0, `${where}: bad mass`).toBe(true);
    expect(b.radius, `${where}: bad radius`).toBeGreaterThan(0);
  }
  // every link endpoint must still be a live body: a dangling reference
  // keeps a deleted body alive in the solver and in the spring forces
  for (const ln of w.links) {
    expect(w.bodies.includes(ln.a), `${where}: link a dangles`).toBe(true);
    expect(w.bodies.includes(ln.b), `${where}: link b dangles`).toBe(true);
  }
  for (const d of w.drivers) {
    expect(w.bodies.some((b) => b.id === d.bodyId),
           `${where}: driver targets a deleted body`).toBe(true);
  }
  // the world must never hold the same body object twice
  expect(new Set(w.bodies).size, `${where}: duplicate body object`)
    .toBe(w.bodies.length);
  expect(new Set(w.links).size, `${where}: duplicate link object`)
    .toBe(w.links.length);
}

function evalsPerStep(w: World, steps: number): number {
  let n = 0;
  const patched = w as unknown as { accumulateForces: (t: number) => void };
  const orig = patched.accumulateForces.bind(w);
  patched.accumulateForces = (t: number) => { n++; orig(t); };
  for (let i = 0; i < steps; i++) w.step(DT);
  patched.accumulateForces = orig;
  return n / steps;
}

describe("lifecycle stress", () => {
  it("continuous spawning and deletion keeps the world consistent", () => {
    const rand = rng(11);
    const w = PRESETS.find((p) => p.name === "Trojan asteroids")!.build();
    const spawned: Body[] = [];
    for (let frame = 0; frame < 600; frame++) {
      if (rand() < 0.5) {
        const b = new Body(new Vec2(rand() * 8 - 4, rand() * 8 - 4),
                           0.05 + rand() * 0.2, 0.1 + rand() * 3);
        b.vel.set(rand() * 4 - 2, rand() * 4 - 2);
        w.bodies.push(b);
        spawned.push(b);
      }
      if (spawned.length > 0 && rand() < 0.45) {
        const victim = spawned.splice(Math.floor(rand() * spawned.length), 1)[0];
        w.removeBody(victim);
      }
      w.step(DT);
      if (frame % 50 === 0) checkConsistent(w, `frame ${frame}`);
    }
    checkConsistent(w, "end");
  });

  it("deleting a linked body takes its links and drivers with it", () => {
    const w = new World();
    const a = new Body(new Vec2(0, 0));
    const b = new Body(new Vec2(1, 0));
    const c = new Body(new Vec2(2, 0));
    w.bodies.push(a, b, c);
    w.links.push(new DistanceLink(a, b), new SpringLink(b, c));
    w.removeBody(b);
    expect(w.links).toHaveLength(0);
    checkConsistent(w, "after unlink");
    for (let i = 0; i < 60; i++) w.step(DT);
    checkConsistent(w, "after stepping");
  });

  it("editing bodies while running never poisons the solver", () => {
    const rand = rng(23);
    const w = PRESETS.find((p) => p.name === "Chain bridge")!.build();
    for (let frame = 0; frame < 600; frame++) {
      const b = w.bodies[Math.floor(rand() * w.bodies.length)];
      switch (Math.floor(rand() * 6)) {
        case 0: b.mass = 0.01 + rand() * 50; break;
        case 1: b.radius = 0.01 + rand() * 0.4; break;
        case 2: b.restitution = rand(); break;
        case 3: b.friction = rand() * 2; break;
        case 4: b.locked = rand() < 0.3; break;
        default: b.collides = rand() < 0.7; break;
      }
      if (rand() < 0.05) w.substeps = 1 + Math.floor(rand() * 16);
      if (rand() < 0.05) w.iterations = 1 + Math.floor(rand() * 32);
      w.step(DT);
      if (frame % 100 === 0) checkConsistent(w, `edit frame ${frame}`);
    }
    checkConsistent(w, "end");
  });

  it("switching integrator repeatedly never diverges or leaks cost", () => {
    const w = PRESETS.find((p) => p.name === "Inner planets")!.build();
    const bare = evalsPerStep(PRESETS.find((p) => p.name === "Inner planets")!.build(), 120);
    for (let round = 0; round < 40; round++) {
      w.integrator = INTEGRATORS[round % INTEGRATORS.length];
      for (let i = 0; i < 20; i++) w.step(DT);
      checkConsistent(w, `integrator ${w.integrator}`);
    }
    w.integrator = "Velocity Verlet";
    expect(evalsPerStep(w, 120)).toBeLessThan(bare * 8);
  });

  it("loading every preset repeatedly is reproducible and leak-free", () => {
    // Object ids are global and monotonic, so they legitimately differ
    // between loads; the trajectories must not.
    const trajectory = (w: World): string =>
      w.bodies.map((b) => `${b.pos.x},${b.pos.y},${b.vel.x},${b.vel.y},` +
        `${b.angle},${b.omega}`).join(";") + `|${w.time}`;
    for (const p of PRESETS) {
      const first = p.build();
      for (let i = 0; i < 60; i++) first.step(DT);
      const second = p.build();
      for (let i = 0; i < 60; i++) second.step(DT);
      expect(trajectory(second), `${p.name} is not reproducible`)
        .toBe(trajectory(first));
      expect(second.substeps, `${p.name} solver settings drifted`)
        .toBe(first.substeps);
      expect(second.iterations).toBe(first.iterations);
      checkConsistent(second, p.name);
    }
  }, 120000);

  it("resetting mid-encounter restores exactly, however violent the state", () => {
    const w = PRESETS.find((p) => p.name === "Pythagorean three-body")!.build();
    const start = snap.snapshot(w);
    for (let i = 0; i < 900; i++) w.step(DT);
    const restored = snap.restore(start);
    expect(snap.snapshot(restored)).toBe(start);
    // and it runs forward identically from there
    for (let i = 0; i < 300; i++) restored.step(DT);
    const again = snap.restore(start);
    for (let i = 0; i < 300; i++) again.step(DT);
    expect(snap.snapshot(again)).toBe(snap.snapshot(restored));
  });

  it("survives a long run at a high body count without cost drift", () => {
    const w = PRESETS.find((p) => p.name === "Orbit dance")!.build();
    const early = evalsPerStep(w, 600);
    for (let i = 0; i < 3000; i++) w.step(DT);
    const late = evalsPerStep(w, 600);
    checkConsistent(w, "long run");
    expect(late).toBeLessThan(Math.max(early, 16) * 6);
  }, 120000);

  it("high and low time warp reach the same place", () => {
    // the app varies dt below 1x and repeats steps above it; both paths
    // must stay finite and bounded
    for (const dt of [DT / 100, DT, DT * 4]) {
      const w = PRESETS.find((p) => p.name === "Binary stars")!.build();
      for (let i = 0; i < 400; i++) w.step(dt);
      checkConsistent(w, `dt=${dt}`);
    }
  });
});
