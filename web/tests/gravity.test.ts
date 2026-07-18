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
