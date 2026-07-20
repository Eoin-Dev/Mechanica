/** Deleting objects must not leave them selected.
 *
 * Removing a body cascade-deletes every link attached to it, so a
 * selected spring could outlive its own existence in the selection and
 * the inspector would keep editing an object no longer in the world. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { DistanceLink, SpringLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { CanvasController } from "../src/interact/tools";
import { Selectable } from "../src/render/draw";
import type { App } from "../src/app";

/** The slice of App the deletion path touches - no DOM needed. */
function makeApp(): { app: App; controller: CanvasController } {
  const stub = {
    world: new World(),
    trails: new Map<number, unknown>(),
    selection: [] as Selectable[],
    setSelection(sel: Selectable[]) { stub.selection = sel; },
  };
  const app = stub as unknown as App;
  return { app, controller: new CanvasController(app) };
}

describe("selection after deletion", () => {
  it("drops a deleted body from the selection", () => {
    const { app, controller } = makeApp();
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    app.world.bodies.push(b);
    app.setSelection([b]);
    controller.deleteObject(b);
    expect(app.selection).toEqual([]);
  });

  it("drops links cascade-deleted with their endpoint body", () => {
    const { app, controller } = makeApp();
    const a = new Body(new Vec2(0, 0), 0.1, 1);
    const b = new Body(new Vec2(1, 0), 0.1, 1);
    const spring = new SpringLink(a, b);
    app.world.bodies.push(a, b);
    app.world.links.push(spring);
    // the spring is what the user had selected; erasing an endpoint
    // deletes the spring too
    app.setSelection([spring]);
    controller.deleteObject(a);
    expect(app.world.links).toEqual([]);
    expect(app.selection).toEqual([]);
  });

  it("keeps surviving objects selected", () => {
    const { app, controller } = makeApp();
    const a = new Body(new Vec2(0, 0), 0.1, 1);
    const b = new Body(new Vec2(1, 0), 0.1, 1);
    const wall = new Wall(new Vec2(-1, -1), new Vec2(1, -1));
    app.world.bodies.push(a, b);
    app.world.walls.push(wall);
    app.setSelection([a, b, wall]);
    controller.deleteObject(a);
    expect(app.selection).toEqual([b, wall]);
  });

  it("handles rods and inelastic strings the same way", () => {
    for (const isRope of [false, true]) {
      const { app, controller } = makeApp();
      const a = new Body(new Vec2(0, 0), 0.1, 1);
      const b = new Body(new Vec2(1, 0), 0.1, 1);
      const link = new DistanceLink(a, b, null, isRope);
      app.world.bodies.push(a, b);
      app.world.links.push(link);
      app.setSelection([link, b]);
      controller.deleteObject(b); // cascades the link away
      expect(app.selection).toEqual([]);
    }
  });
});
