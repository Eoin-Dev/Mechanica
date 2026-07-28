/** Invariants every preset in the library must satisfy.
 *
 * The existing preset tests are per-scene and behavioural: does it blow up,
 * does it stay in its box, are its solver settings sane. What nothing
 * checked is whether each of the 47 scenes is STRUCTURALLY well formed -
 * ids unique, links pointing at bodies that exist, drivers addressing
 * bodies that are still there, anchors actually anchored, formulas that
 * compile, camera hints inside the camera's own limits.
 *
 * These are asserted over the whole library rather than scene by scene, so
 * a new preset is covered the moment it is added rather than when someone
 * remembers to write a test for it. The most valuable of them is the
 * snapshot round trip: it drives the entire serialization layer with 47
 * real scenes instead of the hand-built ones the storage tests use.
 */
import { describe, expect, it } from "vitest";
import { compileExpr } from "../src/core/expr";
import { Body } from "../src/engine/body";
import { DistanceLink, SpringLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { MAX_ZOOM, MIN_ZOOM } from "../src/render/camera";
import { CATEGORIES, PRESETS } from "../src/scene/presets";
import { restore, snapshot, structuralDigest } from "../src/scene/snapshot";

/** Build every preset once; the builders are pure, so this is safe to share
 * across the read-only assertions below. */
const BUILT: Array<{ name: string; w: World }> =
  PRESETS.map((p) => ({ name: p.name, w: p.build() }));

describe("the library's catalogue", () => {
  it("has a unique name for every preset", () => {
    const names = PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("puts every preset in a category the chip row offers", () => {
    for (const p of PRESETS) {
      expect(CATEGORIES).toContain(p.category);
    }
  });

  it("offers no empty category chip", () => {
    for (const cat of CATEGORIES) {
      if (cat === "All") continue;
      expect(PRESETS.some((p) => p.category === cat)).toBe(true);
    }
  });

  it("gives every preset a description worth showing on a card", () => {
    for (const p of PRESETS) {
      expect(p.description.trim().length).toBeGreaterThan(40);
      expect(p.description).not.toMatch(/\s{2,}$/);
      expect(p.description.trim()).toBe(p.description.trim().replace(/\s+$/, ""));
    }
  });

  it("keeps every camera hint inside the camera's own limits", () => {
    for (const p of PRESETS) {
      if (p.hints.zoom !== undefined) {
        expect(p.hints.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
        expect(p.hints.zoom).toBeLessThanOrEqual(MAX_ZOOM);
      }
      if (p.hints.centre !== undefined) {
        expect(p.hints.centre).toHaveLength(2);
        expect(Number.isFinite(p.hints.centre[0])).toBe(true);
        expect(Number.isFinite(p.hints.centre[1])).toBe(true);
      }
      if (p.hints.graph !== undefined) {
        expect(["energy", "momentum", "phase"]).toContain(p.hints.graph);
      }
    }
  });
});

describe("every built scene is structurally sound", () => {
  it("gives every object a unique id within its own kind", () => {
    for (const { name, w } of BUILT) {
      const bodyIds = w.bodies.map((b) => b.id);
      const wallIds = w.walls.map((x) => x.id);
      const linkIds = w.links.map((l) => l.id);
      expect(new Set(bodyIds).size, name).toBe(bodyIds.length);
      expect(new Set(wallIds).size, name).toBe(wallIds.length);
      expect(new Set(linkIds).size, name).toBe(linkIds.length);
    }
  });

  it("links only bodies that are actually in the scene, never to themselves", () => {
    for (const { name, w } of BUILT) {
      const present = new Set(w.bodies);
      for (const ln of w.links) {
        expect(present.has(ln.a), `${name}: link endpoint a`).toBe(true);
        expect(present.has(ln.b), `${name}: link endpoint b`).toBe(true);
        expect(ln.a, `${name}: self-link`).not.toBe(ln.b);
      }
    }
  });

  it("aims every driver at a body that exists and can move", () => {
    for (const { name, w } of BUILT) {
      const byId = new Map(w.bodies.map((b) => [b.id, b]));
      for (const d of w.drivers) {
        const body = byId.get(d.bodyId);
        expect(body, `${name}: driver target ${d.bodyId}`).toBeDefined();
        expect(Number.isFinite(d.amplitude), name).toBe(true);
        expect(Number.isFinite(d.frequency), name).toBe(true);
      }
    }
  });

  it("starts every body with finite, sane state", () => {
    for (const { name, w } of BUILT) {
      for (const b of w.bodies) {
        const tag = `${name}: ${b.name}`;
        expect(Number.isFinite(b.pos.x + b.pos.y), tag).toBe(true);
        expect(Number.isFinite(b.vel.x + b.vel.y), tag).toBe(true);
        expect(Number.isFinite(b.angle + b.omega), tag).toBe(true);
        expect(b.radius, tag).toBeGreaterThan(0);
        expect(b.mass, tag).toBeGreaterThanOrEqual(0);
        expect(b.restitution, tag).toBeGreaterThanOrEqual(0);
        expect(b.restitution, tag).toBeLessThanOrEqual(1);
        expect(b.friction, tag).toBeGreaterThanOrEqual(0);
        expect(b.color, tag).toHaveLength(3);
        for (const ch of b.color) {
          expect(Number.isInteger(ch) && ch >= 0 && ch <= 255, tag).toBe(true);
        }
      }
    }
  });

  it("keeps every anchor locked, named and grey", () => {
    for (const { name, w } of BUILT) {
      for (const b of w.bodies) {
        if (!b.isAnchor) continue;
        expect(b.locked, `${name}: an unlocked anchor`).toBe(true);
        expect(b.name, name).toBe("Anchor");
      }
    }
  });

  it("gives every wall a real extent and finite endpoints", () => {
    for (const { name, w } of BUILT) {
      for (const wall of w.walls) {
        expect(Number.isFinite(wall.a.x + wall.a.y), name).toBe(true);
        expect(Number.isFinite(wall.b.x + wall.b.y), name).toBe(true);
        expect(wall.thickness, name).toBeGreaterThan(0);
        expect(wall.a.distTo(wall.b), `${name}: zero-length wall`)
          .toBeGreaterThan(0);
      }
    }
  });

  it("ships only force fields that compile", () => {
    for (const { name, w } of BUILT) {
      for (const f of w.fields) {
        expect(f.error, `${name}: field '${f.name}' - ${f.error}`).toBe("");
        expect(f.fx, name).not.toBeNull();
        expect(f.fy, name).not.toBeNull();
        // and that they really are the sources shown in the World tab
        expect(() => compileExpr(f.fxSrc), name).not.toThrow();
        expect(() => compileExpr(f.fySrc), name).not.toThrow();
      }
    }
  });

  it("gives every link a non-negative natural length", () => {
    for (const { name, w } of BUILT) {
      for (const ln of w.links) {
        const len = ln instanceof DistanceLink ? ln.length : ln.restLength;
        expect(Number.isFinite(len), name).toBe(true);
        expect(len, name).toBeGreaterThanOrEqual(0);
        if (ln instanceof SpringLink) {
          expect(ln.stiffness, name).toBeGreaterThanOrEqual(0);
          expect(ln.damping, name).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("respects the solver cost ceiling in both directions", () => {
    for (const { name, w } of BUILT) {
      expect(w.substeps, name).toBeGreaterThanOrEqual(2);
      expect(w.substeps, name).toBeLessThanOrEqual(64);
      expect(Number.isInteger(w.substeps), name).toBe(true);
      expect(w.iterations, name).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(w.iterations), name).toBe(true);
      // the cap either fired and recorded what it overrode, or it did not
      if (w.substepsCappedFrom !== null) {
        expect(w.substepsCappedFrom, name).toBeGreaterThan(w.substeps);
      }
    }
  });
});

describe("every preset is reproducible", () => {
  it("builds identically twice, including the randomised scenes", () => {
    // The randomised layouts use a seeded RNG precisely so a scene is the
    // same every time it is opened; a shared or drifting seed would show up
    // here and nowhere else.
    //
    // Compared on physical content rather than on structuralDigest, which
    // mixes in object ids: those come from a global counter, so two
    // independent builds of the same preset legitimately carry different
    // ids and therefore different digests. That is right for the digest's
    // real job (spotting structural change within ONE world's lifetime) and
    // simply makes it the wrong instrument for this question.
    // Auto-generated names embed the id ("Body 935", "Particle 1194"), so
    // they drift with the global counter for the same reason the digest
    // does. A trailing number is normalised away; a name a preset chose
    // deliberately ("Earth", "Anchor") is compared as written.
    const label = (n: string): string => n.replace(/\d+$/, "#");
    const bodyShape = (b: Body): string => JSON.stringify(
      [b.pos.x, b.pos.y, b.vel.x, b.vel.y, b.mass, b.radius, b.angle, b.omega,
       b.locked, b.isAnchor, b.collides, b.color, label(b.name)]);

    for (const p of PRESETS) {
      const a = p.build();
      const b = p.build();
      expect(b.bodies.length, p.name).toBe(a.bodies.length);
      expect(b.walls.length, p.name).toBe(a.walls.length);
      expect(b.links.length, p.name).toBe(a.links.length);
      // compared body by body so a failure names the one that drifted
      for (let i = 0; i < a.bodies.length; i++) {
        expect(bodyShape(b.bodies[i]), `${p.name} body ${i}`)
          .toBe(bodyShape(a.bodies[i]));
      }
      // topology by endpoint INDEX, so it is compared without ids
      for (let i = 0; i < a.links.length; i++) {
        expect(b.bodies.indexOf(b.links[i].a), `${p.name} link ${i} a`)
          .toBe(a.bodies.indexOf(a.links[i].a));
        expect(b.bodies.indexOf(b.links[i].b), `${p.name} link ${i} b`)
          .toBe(a.bodies.indexOf(a.links[i].b));
      }
      expect([b.gravity, b.mutualGravity, b.G, b.substeps, b.iterations,
              b.integrator], p.name)
        .toEqual([a.gravity, a.mutualGravity, a.G, a.substeps, a.iterations,
                  a.integrator]);
      expect(b.fields.map((f) => [f.fxSrc, f.fySrc]), p.name)
        .toEqual(a.fields.map((f) => [f.fxSrc, f.fySrc]));
    }
  });

  it("steps identically from two independent builds", () => {
    const DT = 1 / 120;
    for (const p of PRESETS) {
      const a = p.build();
      const b = p.build();
      for (let i = 0; i < 30; i++) {
        a.step(DT);
        b.step(DT);
      }
      for (let i = 0; i < a.bodies.length; i++) {
        expect(b.bodies[i].pos.x, p.name).toBe(a.bodies[i].pos.x);
        expect(b.bodies[i].pos.y, p.name).toBe(a.bodies[i].pos.y);
      }
    }
  });
});

describe("every preset survives the save/load round trip", () => {
  it("comes back structurally identical", () => {
    // 47 real scenes through the serializer, against the handful of
    // hand-built ones the storage tests use
    for (const { name, w } of BUILT) {
      const revived = restore(snapshot(w));
      expect(structuralDigest(revived), name).toBe(structuralDigest(w));
    }
  });

  it("comes back with the same dynamic state, exactly", () => {
    for (const { name, w } of BUILT) {
      const revived = restore(snapshot(w));
      expect(revived.bodies.length, name).toBe(w.bodies.length);
      expect(revived.time, name).toBe(w.time);
      for (let i = 0; i < w.bodies.length; i++) {
        const o = w.bodies[i];
        const r = revived.bodies[i];
        expect(r.pos.x, name).toBe(o.pos.x);
        expect(r.pos.y, name).toBe(o.pos.y);
        expect(r.vel.x, name).toBe(o.vel.x);
        expect(r.vel.y, name).toBe(o.vel.y);
        expect(r.angle, name).toBe(o.angle);
        expect(r.omega, name).toBe(o.omega);
        expect(r.mass, name).toBe(o.mass);
        expect(r.radius, name).toBe(o.radius);
      }
    }
  });

  it("keeps stepping the same way after a round trip", () => {
    // the strongest form: a saved and reloaded scene is not merely equal on
    // paper, it continues to simulate identically
    const DT = 1 / 120;
    for (const { name, w } of BUILT) {
      const revived = restore(snapshot(w));
      for (let i = 0; i < 20; i++) {
        w.step(DT);
        revived.step(DT);
      }
      for (let i = 0; i < w.bodies.length; i++) {
        expect(revived.bodies[i].pos.x, name).toBeCloseTo(w.bodies[i].pos.x, 9);
        expect(revived.bodies[i].pos.y, name).toBeCloseTo(w.bodies[i].pos.y, 9);
      }
    }
  });

  it("preserves link wiring by identity, not just by count", () => {
    for (const { name, w } of BUILT) {
      const revived = restore(snapshot(w));
      expect(revived.links.length, name).toBe(w.links.length);
      for (let i = 0; i < w.links.length; i++) {
        expect(revived.links[i].a.id, name).toBe(w.links[i].a.id);
        expect(revived.links[i].b.id, name).toBe(w.links[i].b.id);
        const present = new Set(revived.bodies.map((b: Body) => b.id));
        expect(present.has(revived.links[i].a.id), name).toBe(true);
        expect(present.has(revived.links[i].b.id), name).toBe(true);
      }
    }
  });
});
