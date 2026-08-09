/** Deleting objects must not leave them selected.
 *
 * Removing a body cascade-deletes every link attached to it, so a
 * selected spring could outlive its own existence in the selection and
 * the inspector would keep editing an object no longer in the world. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { DistanceLink, SpringLink } from "../src/engine/links";
import { Driver, World } from "../src/engine/world";
import { CanvasController } from "../src/interact/tools";
import { Selectable } from "../src/render/draw";
import type { App } from "../src/app";

/** The slice of App the deletion/duplication paths touch - no DOM needed. */
function makeApp(): { app: App; controller: CanvasController; undos: number } {
  const stub = {
    world: new World(),
    trails: new Map<number, unknown>(),
    selection: [] as Selectable[],
    undos: 0,
    setSelection(sel: Selectable[]) { stub.selection = sel; },
    invalidateEnergy() {},
    beginEdit() {},
    cancelEdit() {},
    commitEdit() { stub.undos++; return "stored" as const; },
    pushUndo() { stub.undos++; },
  };
  const app = stub as unknown as App;
  return { app, controller: new CanvasController(app), get undos() { return stub.undos; } };
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

describe("batched deletion", () => {
  /** Bodies, all selected: the shape every bulk-delete button produces. */
  function populated(n: number): ReturnType<typeof makeApp> {
    const made = makeApp();
    for (let i = 0; i < n; i++) {
      made.app.world.bodies.push(new Body(new Vec2(i * 0.01, 0), 0.05, 1));
    }
    made.app.setSelection([...made.app.world.bodies]);
    return made;
  }

  it("leaves the same world as the per-object path", () => {
    const perObject = populated(20);
    for (const o of [...perObject.app.world.bodies]) {
      perObject.controller.deleteObject(o);
    }
    const batched = populated(20);
    batched.controller.deleteObjects([...batched.app.world.bodies]);
    for (const { app } of [perObject, batched]) {
      expect(app.world.bodies).toEqual([]);
      expect(app.selection).toEqual([]);
    }
  });

  it("takes a body's links and drivers with it, like the single path", () => {
    const { app, controller } = makeApp();
    const a = new Body(new Vec2(0, 0), 0.1, 1);
    const b = new Body(new Vec2(1, 0), 0.1, 1);
    const c = new Body(new Vec2(2, 0), 0.1, 1);
    app.world.bodies.push(a, b, c);
    app.world.links.push(new SpringLink(a, b), new SpringLink(b, c));
    app.world.drivers.push(new Driver(a.id), new Driver(c.id));
    controller.deleteObjects([a]);
    expect(app.world.bodies).toEqual([b, c]);
    expect(app.world.links).toHaveLength(1);   // only b-c survives
    expect(app.world.links[0].a).toBe(b);
    expect(app.world.drivers).toHaveLength(1); // a's driver went with it
    expect(app.world.drivers[0].bodyId).toBe(c.id);
  });

  it("edits each of the world's lists once, whatever the selection size", () => {
    // What made bulk deletion quadratic was doing the world's own list
    // edits per object: an indexOf and a splice over the body array, plus
    // a full rebuild of the link and driver arrays, for every body - on
    // top of a reconciliation scan per surviving selected reference. At a
    // thousand objects that was 50 ms of dropped frame and at two thousand
    // a quarter of a second, and the runaway cull pays it mid-simulation.
    //
    // The property is "one pass per list, regardless of n", so that is what
    // is asserted. Timing this instead looks tempting and is a trap: both
    // measurements are sub-millisecond and dominated by allocator noise,
    // which makes the ratio flap on a loaded machine.
    for (const n of [1, 50, 1000]) {
      const { app, controller } = populated(n);
      const world = app.world;
      const calls = { bodies: 0, walls: 0, links: 0 };
      const real = {
        bodies: world.removeBodies.bind(world),
        walls: world.removeWalls.bind(world),
        links: world.removeLinks.bind(world),
      };
      world.removeBodies = (g) => { calls.bodies++; real.bodies(g); };
      world.removeWalls = (g) => { calls.walls++; real.walls(g); };
      world.removeLinks = (g) => { calls.links++; real.links(g); };

      controller.deleteObjects([...world.bodies]);

      expect(calls, `${n} objects`).toEqual({ bodies: 1, walls: 1, links: 1 });
      expect(world.bodies).toEqual([]);
    }
  });

  it("hands the whole batch to the world in one set", () => {
    const { app, controller } = populated(64);
    const world = app.world;
    const seen: number[] = [];
    const real = world.removeBodies.bind(world);
    world.removeBodies = (g) => { seen.push(g.size); real(g); };
    controller.deleteObjects([...world.bodies]);
    expect(seen).toEqual([64]); // one call carrying all of them
  });
});

describe("duplication", () => {
  it("carries links between two duplicated bodies", () => {
    const { app, controller } = makeApp();
    const a = new Body(new Vec2(0, 0), 0.1, 1);
    const b = new Body(new Vec2(1, 0), 0.1, 1);
    app.world.bodies.push(a, b);
    app.world.links.push(new SpringLink(a, b, 1.0, 30, 2, false));
    app.setSelection([a, b]);
    controller.duplicateSelection();
    expect(app.world.bodies).toHaveLength(4);
    expect(app.world.links).toHaveLength(2);
    const copy = app.world.links[1] as SpringLink;
    expect(copy.a).not.toBe(a); // wired to the clones, not the originals
    expect(copy.b).not.toBe(b);
    expect([copy.restLength, copy.stiffness, copy.damping]).toEqual([1.0, 30, 2]);
  });

  it("carries the driver of a duplicated body", () => {
    // A driver is as much a property of its body as a link is of its
    // endpoints. Copying the springs but dropping the driver left a
    // duplicated oscillator sitting dead beside a running one.
    const { app, controller } = makeApp();
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    app.world.bodies.push(b);
    app.world.drivers.push(new Driver(b.id, 7.5, 2.25, 0.5, 1.25));
    app.setSelection([b]);
    controller.duplicateSelection();
    expect(app.world.bodies).toHaveLength(2);
    expect(app.world.drivers).toHaveLength(2);
    const clone = app.world.bodies[1];
    const copy = app.world.drivers.find((d) => d.bodyId === clone.id);
    expect(copy).toBeDefined();
    expect([copy!.amplitude, copy!.frequency, copy!.phase, copy!.angle])
      .toEqual([7.5, 2.25, 0.5, 1.25]);
    // and the original's driver still points at the original
    expect(app.world.drivers[0].bodyId).toBe(b.id);
  });

  it("leaves an undriven body undriven", () => {
    const { app, controller } = makeApp();
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    app.world.bodies.push(b);
    app.setSelection([b]);
    controller.duplicateSelection();
    expect(app.world.drivers).toEqual([]);
  });
});
