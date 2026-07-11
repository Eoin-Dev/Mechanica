/** Anchor semantics: a fixed attachment point that is locked, exerts no
 * gravitational pull, is excluded from energy accounting, and is counted
 * separately from bodies. Also checks preset pivots became anchors while
 * locked massive gravity sources stayed bodies. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { World } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";

const preset = (name: string) => PRESETS.find((p) => p.name === name)!.build();
const counts = (w: World) => ({
  anchors: w.bodies.filter((b) => b.isAnchor).length,
  bodies: w.bodies.filter((b) => !b.isAnchor).length,
});

const DT = 1.0 / 120.0;

function add(w: World, x: number, y: number, m: number, opts: { anchor?: boolean; locked?: boolean } = {}): Body {
  const b = new Body(new Vec2(x, y), 0.1, m);
  b.locked = opts.locked ?? false;
  if (opts.anchor) { b.isAnchor = true; b.locked = true; b.name = "Anchor"; }
  w.bodies.push(b);
  return b;
}

describe("anchors", () => {
  it("an anchor exerts NO mutual-gravity pull, a locked massive body DOES", () => {
    // Scene A: probe next to a heavy ANCHOR
    const a = new World();
    a.gravity = 0.0; a.mutualGravity = true; a.G = 1.0; a.softening = 0.001; a.substeps = 4;
    add(a, 0, 0, 1000, { anchor: true });
    const probeA = add(a, 2, 0, 1);
    a.step(DT);

    // Scene B: identical but the heavy body is a locked BODY (not an anchor)
    const b = new World();
    b.gravity = 0.0; b.mutualGravity = true; b.G = 1.0; b.softening = 0.001; b.substeps = 4;
    add(b, 0, 0, 1000, { locked: true });
    const probeB = add(b, 2, 0, 1);
    b.step(DT);

    // Probe near the anchor feels no pull at all.
    expect(probeA.vel.x).toBe(0);
    expect(probeA.pos.x).toBe(2);
    // Probe near the locked massive body is pulled inward (toward -x).
    expect(probeB.vel.x).toBeLessThan(0);
  });

  it("anchors are excluded from energy accounting", () => {
    const w = new World();
    w.gravity = 0.0; w.mutualGravity = true; w.G = 1.0; w.softening = 0.001;
    add(w, 0, 0, 1000, { anchor: true });
    add(w, 2, 0, 1);
    // With the only pair being (anchor, body), mutual PE must be zero.
    const e = w.energy();
    expect(e.pe).toBe(0);
  });

  it("pendulum/cradle presets create anchors named 'Anchor', not bodies", () => {
    const pend = preset("Simple pendulum");
    const c = counts(pend);
    expect(c.anchors).toBe(1);          // the pivot is an anchor
    expect(c.bodies).toBe(1);           // just the bob counts as a body
    expect(pend.bodies.filter((b) => b.isAnchor).every((b) => b.name === "Anchor" && b.locked)).toBe(true);

    // Newton's cradle: 5 pivots (anchors) + 5 balls (bodies)
    const cradle = counts(preset("Newton's cradle"));
    expect(cradle.anchors).toBe(5);
    expect(cradle.bodies).toBe(5);
  });

  it("gravity presets keep their locked massive star as a BODY, not an anchor", () => {
    // "Kepler ellipse" has a fixed central star that must still attract.
    const kep = preset("Kepler ellipse");
    expect(kep.bodies.some((b) => b.isAnchor)).toBe(false);
    expect(kep.bodies.some((b) => b.locked && !b.isAnchor)).toBe(true);
  });

  it("isAnchor survives a serialization round-trip and forces the name", () => {
    const b = new Body(new Vec2(1, 2), 0.08, 1);
    b.isAnchor = true; b.locked = true; b.name = "Anchor";
    const restored = Body.fromDict(b.toDict());
    expect(restored.isAnchor).toBe(true);
    expect(restored.name).toBe("Anchor");
  });
});
