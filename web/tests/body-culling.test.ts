/** Runaway-body culling: debris that has escaped for good is deleted,
 * anything that can still come back is kept. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { World, escapedBodies, sceneAnchorPoint } from "../src/engine/world";

const LIMIT = 1000;

function bodyAt(w: World, x: number, y: number,
                vx = 0, vy = 0): Body {
  const b = new Body(new Vec2(x, y), 0.1, 1);
  b.vel.set(vx, vy);
  w.bodies.push(b);
  return b;
}

describe("runaway body culling", () => {
  it("keeps everything inside the limit", () => {
    const w = new World();
    bodyAt(w, 0, 0, 5, 5);
    bodyAt(w, LIMIT * 0.9, 0, 100, 0); // far, fast, but still in range
    expect(escapedBodies(w, LIMIT)).toEqual([]);
  });

  it("deletes a body far outside and still receding", () => {
    const w = new World();
    const gone = bodyAt(w, 0, -LIMIT * 2, 0, -30); // falling away forever
    const near = bodyAt(w, 1, 1);
    expect(escapedBodies(w, LIMIT)).toEqual([gone]);
    expect(escapedBodies(w, LIMIT)).not.toContain(near);
  });

  it("keeps a far body that is heading back (wide bound orbit)", () => {
    const w = new World();
    // at the far end of an orbit, already moving back toward the centre
    bodyAt(w, LIMIT * 3, 0, -12, 0);
    expect(escapedBodies(w, LIMIT)).toEqual([]);
  });

  it("never removes anchors, locked bodies or a held body", () => {
    const w = new World();
    const anchor = bodyAt(w, LIMIT * 5, 0, 50, 0);
    anchor.isAnchor = true;
    const locked = bodyAt(w, 0, LIMIT * 5, 0, 50);
    locked.locked = true;
    const held = bodyAt(w, -LIMIT * 5, 0, -50, 0);
    held.held = true;
    expect(escapedBodies(w, LIMIT)).toEqual([]);
  });

  it("removes a body whose state has gone non-finite", () => {
    const w = new World();
    const blown = bodyAt(w, 0, 0);
    blown.pos.set(NaN, NaN);
    expect(escapedBodies(w, LIMIT)).toEqual([blown]);
  });

  it("measures from the scene's fixed furniture, not the origin", () => {
    const w = new World();
    // a scene built far from the origin: its own bodies must survive
    const hub = new Vec2(10000, 10000);
    w.walls.push(new Wall(hub.add(new Vec2(-1, 0)), hub.add(new Vec2(1, 0))));
    const local = bodyAt(w, hub.x, hub.y + 2, 0, 3);
    expect(sceneAnchorPoint(w).x).toBeCloseTo(hub.x, 6);
    expect(escapedBodies(w, LIMIT)).toEqual([]);
    // something that leaves THAT scene is still culled
    const runaway = bodyAt(w, hub.x, hub.y + LIMIT * 2, 0, 40);
    expect(escapedBodies(w, LIMIT)).toEqual([runaway]);
    expect(escapedBodies(w, LIMIT)).not.toContain(local);
  });
});
