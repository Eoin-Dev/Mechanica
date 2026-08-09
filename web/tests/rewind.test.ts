/** The rewind buffer.
 *
 * A full JSON snapshot per displayed frame cost about five times the
 * physics step it recorded on the densest scenes - almost entirely in
 * `JSON.stringify` rendering thousands of doubles as text. The buffer
 * therefore stores a full snapshot only when the scene's STRUCTURE changes
 * and a flat array of the six dynamic numbers per body otherwise.
 *
 * That is only sound if the structural digest notices every field the
 * delta does not carry. These tests hold it to that: a rewound frame must
 * be indistinguishable from the full snapshot it replaces, whatever the
 * user edited in between.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { DistanceLink, SpringLink } from "../src/engine/links";
import { Driver, ForceField, World } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";
import { RewindBuffer, UndoStack, snapshot, structuralDigest } from "../src/scene/snapshot";

const DT = 1.0 / 120.0;

function scene(): World {
  const w = new World();
  w.gravity = 3.0;
  const a = new Body(new Vec2(0, 2), 0.2, 1.5);
  const b = new Body(new Vec2(1, 2), 0.15, 0.5);
  const anchor = new Body(new Vec2(0, 4), 0.08, 1);
  anchor.isAnchor = true;
  anchor.locked = true;
  anchor.name = "Anchor"; // as every real anchor is: fromDict enforces it
  a.vel.set(0.7, -0.2);
  b.omega = 1.3;
  w.bodies.push(a, b, anchor);
  w.walls.push(new Wall(new Vec2(-3, 0), new Vec2(3, 0), 0.1));
  w.links.push(new DistanceLink(anchor, a), new SpringLink(a, b));
  w.fields.push(new ForceField("F", "0.2*vy", "-0.1*x"));
  w.drivers.push(new Driver(b.id, 2, 0.5, 0.1, 0.3));
  return w;
}

describe("rewind buffer", () => {
  it("replays a run frame for frame, exactly", () => {
    const w = scene();
    const buf = new RewindBuffer();
    const expected: string[] = [];
    for (let i = 0; i < 40; i++) {
      buf.push(w);
      expected.push(snapshot(w));
      w.step(DT);
    }
    // walk back through every frame; each must match what a full snapshot
    // of that moment would have produced, byte for byte
    for (let i = expected.length - 2; i >= 0; i--) {
      const got = buf.back();
      expect(got, `frame ${i}`).not.toBeNull();
      expect(snapshot(got!), `frame ${i}`).toBe(expected[i]);
    }
    expect(buf.back()).toBeNull(); // nothing left to go back to
  });

  it("only one frame in a steady run needs a full snapshot", () => {
    const w = PRESETS.find((p) => p.name === "Gas in a box (200)")!.build();
    const before = structuralDigest(w);
    for (let i = 0; i < 200; i++) w.step(DT);
    // stepping alone must never disturb the digest, or every frame would
    // fall back to a full snapshot and the buffer would buy nothing
    expect(structuralDigest(w)).toBe(before);
  });

  it("notices every kind of edit the delta cannot carry", () => {
    const edits: Array<[string, (w: World) => void]> = [
      ["mass", (w) => { w.bodies[0].mass = 9; }],
      ["radius", (w) => { w.bodies[0].radius = 0.9; }],
      ["restitution", (w) => { w.bodies[0].restitution = 0.1; }],
      ["friction", (w) => { w.bodies[0].friction = 0.9; }],
      ["const force", (w) => { w.bodies[0].constForce.x = 4; }],
      ["locked", (w) => { w.bodies[0].locked = true; }],
      ["collides", (w) => { w.bodies[0].collides = false; }],
      ["no rotation", (w) => { w.bodies[0].noRotation = true; }],
      ["colour", (w) => { w.bodies[0].color = [1, 2, 3]; }],
      ["name", (w) => { w.bodies[0].name = "renamed"; }],
      ["body added", (w) => { w.bodies.push(new Body(new Vec2(5, 5))); }],
      ["body removed", (w) => { w.removeBody(w.bodies[1]); }],
      ["wall moved", (w) => { w.walls[0].a.x = -9; }],
      ["wall thickness", (w) => { w.walls[0].thickness = 0.5; }],
      ["wall material", (w) => { w.walls[0].friction = 0.01; }],
      ["wall added", (w) => { w.walls.push(new Wall(new Vec2(0, 9), new Vec2(1, 9))); }],
      ["rod length", (w) => { (w.links[0] as DistanceLink).length = 3; }],
      ["rod rope flag", (w) => { (w.links[0] as DistanceLink).isRope = true; }],
      ["spring stiffness", (w) => { (w.links[1] as SpringLink).stiffness = 999; }],
      ["spring damping", (w) => { (w.links[1] as SpringLink).damping = 7; }],
      ["link removed", (w) => { w.removeLink(w.links[0]); }],
      ["field formula", (w) => { w.fields[0].fxSrc = "1"; }],
      ["field enabled", (w) => { w.fields[0].enabled = false; }],
      ["field added", (w) => { w.fields.push(new ForceField("G", "1", "1")); }],
      ["driver amplitude", (w) => { w.drivers[0].amplitude = 40; }],
      ["driver enabled", (w) => { w.drivers[0].enabled = false; }],
      ["gravity", (w) => { w.gravity = -1; }],
      ["mutual gravity", (w) => { w.mutualGravity = true; }],
      ["G", (w) => { w.G = 5; }],
      ["softening", (w) => { w.softening = 0.5; }],
      ["linear drag", (w) => { w.dragLinear = 2; }],
      ["quadratic drag", (w) => { w.dragQuadratic = 2; }],
      ["global damping", (w) => { w.globalDamping = 2; }],
      ["integrator", (w) => { w.integrator = "RK4"; }],
      ["substeps", (w) => { w.substeps = 31; }],
      ["iterations", (w) => { w.iterations = 21; }],
    ];
    for (const [what, edit] of edits) {
      const w = scene();
      const before = structuralDigest(w);
      edit(w);
      expect(structuralDigest(w), `${what} went unnoticed`).not.toBe(before);
    }
  });

  it("an edit mid-run still rewinds to the pre-edit values", () => {
    const w = scene();
    const buf = new RewindBuffer();
    const expected: string[] = [];
    for (let i = 0; i < 12; i++) {
      buf.push(w);
      expected.push(snapshot(w));
      w.step(DT);
    }
    w.bodies[0].mass = 42;          // the kind of edit a delta cannot carry
    w.bodies[1].color = [9, 9, 9];
    for (let i = 0; i < 12; i++) {
      buf.push(w);
      expected.push(snapshot(w));
      w.step(DT);
    }
    for (let i = expected.length - 2; i >= 0; i--) {
      const got = buf.back()!;
      expect(snapshot(got), `frame ${i}`).toBe(expected[i]);
    }
  });

  it("verifies structure exactly even when the fast digest collides", () => {
    const w = scene();
    const buf = new RewindBuffer(() => 12345);
    buf.push(w);
    w.bodies[0].mass = 42;
    buf.push(w);
    w.bodies[0].pos.x += 3;
    buf.push(w);

    const edited = buf.back();
    expect(edited).not.toBeNull();
    expect(edited!.bodies[0].mass).toBe(42);
  });

  it("clear() empties it", () => {
    const w = scene();
    const buf = new RewindBuffer();
    for (let i = 0; i < 5; i++) { buf.push(w); w.step(DT); }
    expect(buf.length).toBe(5);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.back()).toBeNull();
  });

  it("stays bounded on a long run of a heavy scene", () => {
    const w = PRESETS.find((p) => p.name === "Gas in a box (200)")!.build();
    const buf = new RewindBuffer();
    for (let i = 0; i < 4000; i++) {
      buf.push(w);
      w.step(DT);
    }
    buf.push(w); // newest frame is now the world's current state
    expect(buf.length).toBeLessThanOrEqual(RewindBuffer.MAX_FRAMES);
    // and it still rewinds correctly after all that recycling
    const want = snapshot(w);
    w.step(DT);
    buf.push(w);
    const got = buf.back()!;
    expect(snapshot(got)).toBe(want);
  }, 120000);

  it("keeps working when bodies are culled mid-run", () => {
    const w = scene();
    const buf = new RewindBuffer();
    const expected: string[] = [];
    for (let i = 0; i < 30; i++) {
      if (i === 10) w.removeBody(w.bodies[0]);
      if (i === 20) w.bodies.push(new Body(new Vec2(2, 2), 0.1, 1));
      buf.push(w);
      expected.push(snapshot(w));
      w.step(DT);
    }
    for (let i = expected.length - 2; i >= 0; i--) {
      expect(snapshot(buf.back()!), `frame ${i}`).toBe(expected[i]);
    }
  });

  it("rejects an individual frame that cannot fit its byte budget", () => {
    const original = RewindBuffer.BUDGET_BYTES;
    try {
      RewindBuffer.BUDGET_BYTES = 16;
      const buf = new RewindBuffer();
      expect(buf.push(scene())).toBe("too-large");
      expect(buf.length).toBe(0);
      expect(buf.bytesUsed).toBe(0);
    } finally {
      RewindBuffer.BUDGET_BYTES = original;
    }
  });

  it("reclaims a newer structural keyframe when rewinding past it", () => {
    const w = scene();
    const buf = new RewindBuffer();
    buf.push(w);
    const firstBytes = buf.bytesUsed;
    w.bodies[0].mass = 99;
    buf.push(w);
    expect(buf.bytesUsed).toBeGreaterThan(firstBytes);
    expect(buf.back()).not.toBeNull();
    expect(buf.bytesUsed).toBe(firstBytes);
  });

  it("preserves an evolved angle beyond one turn exactly", () => {
    const w = new World();
    w.gravity = 0;
    const body = new Body(new Vec2(0, 0), 0.2, 1);
    body.collides = false;
    body.omega = 1000;
    w.bodies.push(body);
    w.step(DT);
    expect(Math.abs(body.angle)).toBeGreaterThan(2 * Math.PI);

    const buf = new RewindBuffer();
    const expected = snapshot(w);
    buf.push(w);
    w.step(DT);
    buf.push(w);

    expect(snapshot(buf.back()!)).toBe(expected);
  });
});

describe("undo byte budget", () => {
  it("records a live before/after transition as one exact undo boundary", () => {
    const w = scene();
    const stack = new UndoStack(w);
    w.step(DT);
    const before = snapshot(w);
    w.bodies[0].mass = 77;
    expect(stack.pushTransition(before, snapshot(w))).toBe("stored");
    expect(snapshot(stack.undo()!)).toBe(before);
  });

  it("preserves an evolved angle beyond one turn through undo and redo", () => {
    const w = new World();
    w.gravity = 0;
    const body = new Body(new Vec2(0, 0), 0.2, 1);
    body.collides = false;
    body.omega = 1000;
    w.bodies.push(body);
    w.step(DT);
    expect(Math.abs(body.angle)).toBeGreaterThan(2 * Math.PI);

    const stack = new UndoStack(w);
    const before = snapshot(w);
    body.mass = 2;
    const after = snapshot(w);
    expect(stack.pushTransition(before, after)).toBe("stored");
    expect(snapshot(stack.undo()!)).toBe(before);
    expect(snapshot(stack.redo()!)).toBe(after);
  });

  it("resets to an oversized current state and reports undo unavailable", () => {
    const w = new World();
    const stack = new UndoStack(w);
    const original = UndoStack.BUDGET_BYTES;
    try {
      UndoStack.BUDGET_BYTES = 32;
      w.bodies.push(new Body(new Vec2(1, 2)));
      expect(stack.push(w)).toBe("too-large");
      expect(stack.canUndo).toBe(false);
      expect(stack.bytesUsed).toBeGreaterThan(UndoStack.BUDGET_BYTES);
    } finally {
      UndoStack.BUDGET_BYTES = original;
    }
  });
});
