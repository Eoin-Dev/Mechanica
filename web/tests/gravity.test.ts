/** Gravity model: point-mass (singularity) vs solid uniform bodies.
 *
 * In solid mode (the default) the mutual-gravity pull ramps linearly to
 * zero inside an overlap, so non-colliding bodies pass through each other
 * without the huge numerical slingshots a 1/r^2 singularity produces.
 * Point-mass mode preserves the old behaviour for fine-tuned scenes.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { World } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";

const DT = 1.0 / 120.0;

/** Two heavy non-colliding bodies launched at each other off-centre. */
function passThroughWorld(pointGravity: boolean): { w: World; a: Body; b: Body } {
  const w = new World();
  w.gravity = 0.0;
  w.mutualGravity = true;
  w.pointGravity = pointGravity;
  w.G = 1.0;
  w.softening = 0.01;
  w.substeps = 8;
  const a = new Body(new Vec2(-3.0, 0.0), 0.5, 5.0);
  const b = new Body(new Vec2(3.0, 0.05), 0.5, 5.0); // slight offset: slingshot geometry
  a.vel.set(1.0, 0.0);
  b.vel.set(-1.0, 0.0);
  a.collides = false;
  b.collides = false;
  w.bodies.push(a, b);
  return { w, a, b };
}

describe("gravity model", () => {
  it("solid mode caps the pull inside an overlap; point mode slingshots", () => {
    const run = (point: boolean) => {
      const { w, a } = passThroughWorld(point);
      let vMax = 0.0;
      for (let i = 0; i < 720; i++) {
        w.step(DT);
        vMax = Math.max(vMax, a.vel.length());
      }
      return vMax;
    };
    const vSolid = run(false);
    const vPoint = run(true);
    // solid: peak speed bounded by the finite centre potential (~2.8 m/s here)
    expect(vSolid).toBeLessThan(4.0);
    // point-mass singularity produces far larger speeds in the same pass
    expect(vPoint).toBeGreaterThan(3.0 * vSolid);
  });

  it("solid mode conserves energy through a pass-through encounter", () => {
    const { w } = passThroughWorld(false);
    const e0 = w.energy().total;
    for (let i = 0; i < 720; i++) w.step(DT);
    const e1 = w.energy().total;
    expect(Math.abs(e1 - e0) / Math.abs(e0)).toBeLessThan(0.01);
  });

  it("solid and point modes agree while bodies do not overlap", () => {
    const runFor = (point: boolean) => {
      const { w, a } = passThroughWorld(point);
      for (let i = 0; i < 120; i++) w.step(DT); // 1 s: still ~4 m apart
      return [a.pos.x, a.pos.y, a.vel.x, a.vel.y];
    };
    const s = runFor(false);
    const p = runFor(true);
    for (let k = 0; k < 4; k++) expect(s[k]).toBeCloseTo(p[k], 12);
  });

  it("defaults to the solid model; delicate presets opt into point masses", () => {
    expect(new World().pointGravity).toBe(false);
    const flagged = ["Three-body figure-8", "Choreography: moth",
                     "Choreography: butterfly", "Lagrange's triangle",
                     "Pythagorean three-body"];
    for (const name of flagged) {
      const preset = PRESETS.find((pr) => pr.name === name)!;
      expect(preset.build().pointGravity).toBe(true);
    }
    // an orbital scene without overlaps stays on the default
    expect(PRESETS.find((pr) => pr.name === "Earth & Moon")!.build()
      .pointGravity).toBe(false);
  });

  it("round-trips through serialization and defaults old scenes to solid", () => {
    const w = new World();
    w.pointGravity = true;
    expect(World.fromDict(w.toDict()).pointGravity).toBe(true);
    const legacy = w.toDict();
    delete legacy.settings.point_gravity; // scene saved before this setting
    expect(World.fromDict(legacy).pointGravity).toBe(false);
  });
});

/** The attraction pass, written the obvious way: straight off the objects,
 * one pair at a time. World.accumulateGravity runs the same arithmetic over
 * packed typed arrays because the object form cost ~20x more per pair; this
 * is the reference it has to keep agreeing with, exactly. */
function referenceGravity(w: World): Array<[number, number]> {
  const bodies = w.bodies;
  const n = bodies.length;
  const G = w.G;
  const eps2 = w.softening * w.softening;
  const solid = !w.pointGravity;
  const acc = bodies.map((b): [number, number] => [b.acc.x, b.acc.y]);
  for (let i = 0; i < n; i++) {
    const bi = bodies[i];
    if (bi.isAnchor) continue;
    const bix = bi.pos.x;
    const biy = bi.pos.y;
    const biMovable = bi.invMass !== 0.0;
    for (let j = i + 1; j < n; j++) {
      const bj = bodies[j];
      if (bj.isAnchor) continue;
      const dx = bj.pos.x - bix;
      const dy = bj.pos.y - biy;
      let r2 = dx * dx + dy * dy;
      if (solid) {
        const R = bi.radius + bj.radius;
        if (r2 < R * R) r2 = R * R;
      }
      const d2 = r2 + eps2;
      const s = G / (d2 * Math.sqrt(d2));
      if (biMovable) {
        const m = s * bj.mass;
        acc[i][0] += m * dx;
        acc[i][1] += m * dy;
      }
      if (bj.invMass !== 0.0) {
        const m = s * bi.mass;
        acc[j][0] -= m * dx;
        acc[j][1] -= m * dy;
      }
    }
  }
  return acc;
}

describe("packed attraction pass", () => {
  it("matches the reference implementation bit for bit", () => {
    let seed = 991;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (const point of [false, true]) {
      for (const n of [2, 3, 17, 64]) {
        const w = new World();
        w.gravity = 0.0;
        w.mutualGravity = true;
        w.pointGravity = point;
        w.G = 1.7;
        w.softening = 0.013;
        for (let i = 0; i < n; i++) {
          const b = new Body(new Vec2(rand() * 12 - 6, rand() * 12 - 6),
                             0.03 + rand() * 0.6, 0.2 + rand() * 40);
          b.vel.set(rand() * 3 - 1.5, rand() * 3 - 1.5);
          // a mix of movable, locked and anchor bodies: each takes a
          // different branch in the pass
          if (i % 11 === 3) b.locked = true;
          if (i % 13 === 5) { b.isAnchor = true; b.locked = true; }
          w.bodies.push(b);
        }
        const proto = Object.getPrototypeOf(w);
        proto.prepareStep.call(w, DT);
        // base accelerations only, so the reference starts where the
        // packed pass starts
        for (const b of w.bodies) b.acc.set(b.locked ? 0 : 0.25, b.locked ? 0 : -0.5);
        const want = referenceGravity(w);
        proto.accumulateGravity.call(w);
        w.bodies.forEach((b, i) => {
          expect(b.acc.x, `n=${n} point=${point} body ${i} ax`).toBe(want[i][0]);
          expect(b.acc.y, `n=${n} point=${point} body ${i} ay`).toBe(want[i][1]);
        });
      }
    }
  });

  it("stays correct as bodies are added and removed between passes", () => {
    const w = new World();
    w.gravity = 0.0;
    w.mutualGravity = true;
    w.G = 1.0;
    const proto = Object.getPrototypeOf(w);
    for (let round = 0; round < 40; round++) {
      if (round % 3 !== 2 || w.bodies.length < 2) {
        w.bodies.push(new Body(new Vec2(round * 0.37 - 5, round * 0.11), 0.1, 1 + round));
      } else {
        w.removeBody(w.bodies[round % w.bodies.length]);
      }
      proto.prepareStep.call(w, DT);
      for (const b of w.bodies) b.acc.set(0, 0);
      const want = referenceGravity(w);
      proto.accumulateGravity.call(w);
      w.bodies.forEach((b, i) => {
        expect(b.acc.x).toBe(want[i][0]);
        expect(b.acc.y).toBe(want[i][1]);
      });
    }
  });
});
