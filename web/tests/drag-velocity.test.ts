/** Left-dragging repositions a body; it never throws it.
 *
 * While a body is held it reports its cursor displacement as its velocity,
 * because the contact and constraint solvers read relative velocities - a
 * dragged body has to be able to shove a pile, and a dragged anchor has to
 * carry its bob. That reported value is scaffolding: on release the body
 * gets back exactly the velocity it was grabbed with, so putting something
 * somewhere does not also fling it. Setting a velocity on purpose is the
 * right-drag / green-arrow gesture, which is untouched.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { DistanceLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { CanvasController } from "../src/interact/tools";
import { Selectable } from "../src/render/draw";
import type { App } from "../src/app";

/** Pixels per metre for the stub camera.
 *
 * A realistic zoom matters: the picker's tolerance is `6 / zoom` world units,
 * so at zoom 1 a click reaches six metres and grabs whichever body happens to
 * be nearest in the list rather than the one under the cursor. 100 px/m is
 * the app's own default order of magnitude and keeps the tolerance at 6 cm.
 */
const ZOOM = 100;

/** World position for a screen point, matching the real Camera at centre
 * (0, 0) on a zero-size canvas. */
const worldAt = (sx: number, sy: number): Vec2 =>
  new Vec2(sx / ZOOM, -sy / ZOOM);

/** The slice of App a drag touches. */
function makeApp(playing: boolean) {
  const world = new World();
  const stub = {
    world,
    playing,
    trails: new Map<number, unknown>(),
    selection: [] as Selectable[],
    view: { snap: false, vectorScale: 1 },
    dragHitsWalls: false,
    softBodyHintArmed: false,
    undos: 0,
    camera: {
      zoom: ZOOM,
      toWorld: (sx: number, sy: number) => worldAt(sx, sy),
      toScreen: (p: Vec2): [number, number] => [p.x * ZOOM, -p.y * ZOOM],
      toScreenXY: (x: number, y: number): [number, number] =>
        [x * ZOOM, -y * ZOOM],
    },
    setSelection(sel: Selectable[]) { stub.selection = sel; },
    pushUndo() { stub.undos++; },
    toast() {},
  };
  const app = stub as unknown as App;
  return { app, world, stub, controller: new CanvasController(app) };
}

/** Press at `from`, drag to `to` (in steps), release. Returns the body. */
function dragBody(opts: {
  playing: boolean;
  vel0: [number, number];
  from: [number, number];
  to: [number, number];
  locked?: boolean;
  stepWorld?: boolean;
}): { body: Body; app: App; controller: CanvasController; undos: () => number } {
  const { app, world, stub, controller } = makeApp(opts.playing);
  const start = worldAt(opts.from[0], opts.from[1]);
  const body = new Body(new Vec2(start.x, start.y), 0.2, 1.0);
  body.vel.set(opts.vel0[0], opts.vel0[1]);
  body.locked = opts.locked ?? false;
  world.bodies.push(body);
  app.setSelection([body]);

  const press = controller as unknown as {
    press(m: [number, number]): void;
    motion(m: [number, number]): void;
    release(m: [number, number]): void;
  };
  press.press(opts.from);
  // walk the cursor there in a few moves, past the activation threshold
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const m: [number, number] = [
      opts.from[0] + ((opts.to[0] - opts.from[0]) * i) / steps,
      opts.from[1] + ((opts.to[1] - opts.from[1]) * i) / steps,
    ];
    controller.mouse = m;
    press.motion(m);
    controller.updateDrag();
    if (opts.stepWorld) world.step(1 / 120);
  }
  controller.mouse = opts.to;
  press.release(opts.to);
  return { body, app, controller, undos: () => stub.undos };
}

describe("left-drag preserves velocity", () => {
  it.each([true, false])("restores the grabbed velocity (playing=%s)", (playing) => {
    const { body } = dragBody({
      playing, vel0: [3.5, -1.25], from: [0, 0], to: [40, 25],
    });
    expect(body.vel.x).toBeCloseTo(3.5, 12);
    expect(body.vel.y).toBeCloseTo(-1.25, 12);
  });

  it("still moves the body to the cursor", () => {
    const { body } = dragBody({
      playing: true, vel0: [3.5, -1.25], from: [0, 0], to: [400, 250],
    });
    const want = worldAt(400, 250); // the grab offset is zero
    expect(body.pos.x).toBeCloseTo(want.x, 6);
    expect(body.pos.y).toBeCloseTo(want.y, 6);
  });

  it("restores a zero velocity rather than inventing one", () => {
    // the old behaviour released at the cursor speed, so a body at rest came
    // out of a drag moving - the single most visible symptom
    const { body } = dragBody({
      playing: true, vel0: [0, 0], from: [0, 0], to: [120, 0],
    });
    expect(body.vel.length()).toBe(0);
  });

  it("keeps the velocity it had at the moment of the press", () => {
    // the world keeps running between press and release, so what is restored
    // is the motion the body had when the pointer went down
    const { body } = dragBody({
      playing: true, vel0: [2, 0], from: [0, 0], to: [30, 0], stepWorld: true,
    });
    expect(body.vel.x).toBeCloseTo(2, 12);
    expect(body.vel.y).toBeCloseTo(0, 12);
  });

  it("reports a real velocity to the solver WHILE held", () => {
    // the restore must not be achieved by never writing a velocity: a held
    // body has to be able to push what it is dragged into
    const { app, world, controller } = makeApp(true);
    const body = new Body(new Vec2(0, 0), 0.2, 1.0);
    world.bodies.push(body);
    app.setSelection([body]);
    const c = controller as unknown as {
      press(m: [number, number]): void; motion(m: [number, number]): void;
    };
    c.press([0, 0]);
    for (const m of [[10, 0], [20, 0], [30, 0]] as Array<[number, number]>) {
      controller.mouse = m;
      c.motion(m);
      controller.updateDrag();
    }
    expect(body.held).toBe(true);
    expect(body.vel.length()).toBeGreaterThan(0); // scaffolding is in place
  });

  it("releases the hold, so the body is dynamic again", () => {
    const { body } = dragBody({
      playing: true, vel0: [1, 1], from: [0, 0], to: [20, 20],
    });
    expect(body.held).toBe(false);
    expect(body.invMass).toBeGreaterThan(0);
    expect(body.speedCap).toBe(Infinity);
  });

  it("restores every body of a group selection", () => {
    const { app, world, controller } = makeApp(true);
    const vels: Array<[number, number]> = [[1, 2], [-3, 0.5], [0, 0]];
    const bodies = vels.map(([vx, vy], i) => {
      const b = new Body(new Vec2(i, 0), 0.2, 1.0);
      b.vel.set(vx, vy);
      world.bodies.push(b);
      return b;
    });
    app.setSelection([...bodies]);
    const c = controller as unknown as {
      press(m: [number, number]): void; motion(m: [number, number]): void;
      release(m: [number, number]): void;
    };
    c.press([0, 0]); // lands on body 0; the rest come along as a group
    for (const m of [[150, 50], [300, 100], [450, 150]] as Array<[number, number]>) {
      controller.mouse = m;
      c.motion(m);
      controller.updateDrag();
    }
    c.release([450, 150]);
    for (const [i, b] of bodies.entries()) {
      expect(b.vel.x, `body ${i} vx`).toBeCloseTo(vels[i][0], 12);
      expect(b.vel.y, `body ${i} vy`).toBeCloseTo(vels[i][1], 12);
      expect(b.held).toBe(false);
    }
    // and the whole group really moved together, keeping its spacing
    const end = worldAt(450, 150);
    for (const [i, b] of bodies.entries()) {
      expect(b.pos.x, `body ${i} x`).toBeCloseTo(end.x + i, 6);
      expect(b.pos.y, `body ${i} y`).toBeCloseTo(end.y, 6);
    }
  });

  it("leaves a locked body's velocity alone as before", () => {
    // a locked body never integrates, so a velocity written during a drag
    // would just sit in its state and fire it off when unlocked
    const { body } = dragBody({
      playing: true, vel0: [0, 0], from: [0, 0], to: [500, 0], locked: true,
    });
    expect(body.vel.length()).toBe(0);
    expect(body.pos.x).toBeCloseTo(worldAt(500, 0).x, 6);
  });

  it("restores on an aborted drag too (window blur, world swap)", () => {
    const { app, world, controller } = makeApp(true);
    const body = new Body(new Vec2(0, 0), 0.2, 1.0);
    body.vel.set(4, -2);
    world.bodies.push(body);
    app.setSelection([body]);
    const c = controller as unknown as {
      press(m: [number, number]): void; motion(m: [number, number]): void;
    };
    c.press([0, 0]);
    for (const m of [[10, 0], [20, 0]] as Array<[number, number]>) {
      controller.mouse = m;
      c.motion(m);
      controller.updateDrag();
    }
    controller.abortDrag();
    expect(body.held).toBe(false);
    expect(body.vel.x).toBeCloseTo(4, 12);
    expect(body.vel.y).toBeCloseTo(-2, 12);
  });

  it("does not disturb an inspect-click that never moved", () => {
    const { app, world, controller } = makeApp(true);
    const body = new Body(new Vec2(0, 0), 0.2, 1.0);
    body.vel.set(7, 7);
    world.bodies.push(body);
    app.setSelection([body]);
    const c = controller as unknown as {
      press(m: [number, number]): void; motion(m: [number, number]): void;
      release(m: [number, number]): void;
    };
    c.press([0, 0]);
    c.motion([1, 1]); // inside the activation threshold: not a drag
    controller.updateDrag();
    c.release([1, 1]);
    expect(body.held).toBe(false);
    expect(body.pos.x).toBe(0); // never moved
    expect(body.vel.x).toBe(7);
    expect(body.vel.y).toBe(7);
  });

  it("still lets a dragged body carry a linked neighbour", () => {
    // Restoring the held body's velocity must not cut the link: the rod has
    // to keep transmitting the drag, and the neighbour keeps whatever motion
    // that gave it rather than being restored to anything.
    //
    // What is checked here is that the neighbour is carried and the rod holds
    // - not how fast it ends up. This loop drives updateDrag by hand, whose
    // dt comes from the wall clock, so the velocity it reports does not match
    // the fixed step the world is advanced by and the split between positional
    // and velocity transport is not representative. The lunge itself is
    // pinned properly by "dragging a pendulum anchor then stopping lets the
    // bob lunge" in physics.test.ts, which drives the anchor directly.
    const { app, world, controller } = makeApp(true);
    world.gravity = 0;
    const held = new Body(new Vec2(0, 0), 0.1, 1.0);
    const bob = new Body(new Vec2(0, -1), 0.1, 1.0);
    world.bodies.push(held, bob);
    world.links.push(new DistanceLink(held, bob));
    app.setSelection([held]);
    const c = controller as unknown as {
      press(m: [number, number]): void; motion(m: [number, number]): void;
      release(m: [number, number]): void;
    };
    c.press([0, 0]); // the bob is a metre away, well outside the pick radius
    for (let i = 1; i <= 30; i++) {
      const m: [number, number] = [i * 20, 0]; // 0.2 m per frame
      controller.mouse = m;
      c.motion(m);
      controller.updateDrag();
      world.step(1 / 120);
    }
    const heldEnd = held.pos.x;
    c.release([600, 0]);
    // the bob was carried most of the way along with the body it is tied to
    expect(bob.pos.x).toBeGreaterThan(heldEnd - 1.0);
    expect(bob.pos.x).toBeGreaterThan(0.5);
    // the rod still holds its length, so nothing was torn apart
    expect(held.pos.distTo(bob.pos)).toBeCloseTo(1, 3);
    // the held body itself came back to rest, as it was grabbed
    expect(held.vel.length()).toBe(0);
    // and the bob was NOT restored to anything: it is free, uncapped physics
    expect(bob.speedCap).toBe(Infinity);
    expect(bob.held).toBe(false);
  });
});
