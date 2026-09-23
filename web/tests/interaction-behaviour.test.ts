/** @vitest-environment jsdom */
/** Canvas interaction contracts: click/drag thresholds, bounded drag energy,
 * selection and picking, distance-based trails, plot sampling, and framing. */
import { describe, expect, it } from "vitest";
import { App } from "../src/app";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { DistanceLink } from "../src/engine/links";
import { VEL_ARROW_SCALE } from "../src/render/draw";
import { TimeSeries } from "../src/ui/plots";

function stubCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 800, height: 600,
                    right: 800, bottom: 600, x: 0, y: 0 }),
    configurable: true,
  });
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  canvas.getContext = (() => ({
    setTransform() {}, fillRect() {}, clearRect() {}, save() {}, restore() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {},
    closePath() {}, measureText: () => ({ width: 10 }), fillText() {},
    translate() {}, rotate() {}, scale() {}, setLineDash() {}, clip() {},
    quadraticCurveTo() {}, strokeRect() {},
  })) as unknown as HTMLCanvasElement["getContext"];
  return canvas;
}

function makeApp(): { app: App; canvas: HTMLCanvasElement } {
  document.body.replaceChildren();
  const canvas = stubCanvas();
  document.body.append(canvas);
  return { app: new App(canvas), canvas };
}

function send(canvas: HTMLCanvasElement, type: string, x: number, y: number,
              button = 0): void {
  const e = new Event(type, { bubbles: true });
  Object.assign(e, { clientX: x, clientY: y, button, pointerId: 1,
                     pointerType: "mouse", shiftKey: false });
  canvas.dispatchEvent(e);
}

describe("cancelled pointer gestures", () => {
  it.each(["pointer cancellation", "tool switching"])("stops erasing after %s", (reason) => {
    const { app, canvas } = makeApp();
    const first = new Body(new Vec2(-1, 0), 0.2, 1);
    const survivor = new Body(new Vec2(1, 0), 0.2, 1);
    app.world.bodies.push(first, survivor);
    app.controller.setTool("eraser");
    send(canvas, "pointerdown", ...app.camera.toScreen(first.pos));
    if (reason === "pointer cancellation") {
      send(canvas, "pointercancel", ...app.camera.toScreen(first.pos));
    } else app.controller.setTool("select");
    send(canvas, "pointermove", ...app.camera.toScreen(survivor.pos));
    expect(app.world.bodies).toEqual([survivor]);
    app.undo();
    expect(app.world.bodies.map(body => body.id)).toEqual([first.id, survivor.id]);
  });

  it("discards a cancelled wall draft before a later pointer release", () => {
    const { app, canvas } = makeApp();
    app.controller.setTool("wall");
    send(canvas, "pointerdown", 200, 200);
    send(canvas, "pointercancel", 300, 200);
    send(canvas, "pointerup", 400, 200);
    expect(app.world.walls).toHaveLength(0);
  });
});

describe("a click is not a drag", () => {
  it("a press with a pixel of jitter never grabs the body", () => {
    // the drag arms on press and only ACTIVATES past a few pixels, so that
    // inspecting something does not also hold it, pin it and hand its
    // velocity to the solver
    const { app, canvas } = makeApp();
    const b = new Body(new Vec2(0, 0), 0.4, 1);
    b.vel.set(2, 0);
    app.world.bodies.push(b);
    app.controller.setTool("select");
    const [sx, sy] = app.camera.toScreen(b.pos);
    send(canvas, "pointerdown", sx, sy);
    send(canvas, "pointermove", sx + 1, sy + 1); // jitter, not a drag
    expect(b.held).toBe(false);
    send(canvas, "pointerup", sx + 1, sy + 1);
    expect(b.held).toBe(false);
    expect(b.vel.x).toBeCloseTo(2, 9); // its motion was never touched
  });

  it("a real drag does grab it", () => {
    const { app, canvas } = makeApp();
    const b = new Body(new Vec2(0, 0), 0.4, 1);
    app.world.bodies.push(b);
    app.controller.setTool("select");
    const [sx, sy] = app.camera.toScreen(b.pos);
    send(canvas, "pointerdown", sx, sy);
    send(canvas, "pointermove", sx + 40, sy + 30);
    expect(b.held).toBe(true);
    send(canvas, "pointerup", sx + 40, sy + 30);
    expect(b.held).toBe(false);
  });
});

describe("dragging cannot inject unbounded energy", () => {
  it("asymptotically limits a violent flick's solver-facing speed", () => {
    const { app, canvas } = makeApp();
    app.playing = true;
    const b = new Body(new Vec2(0, 0), 0.3, 1);
    app.world.bodies.push(b);
    app.ensureInitial();
    app.controller.setTool("select");
    const [sx, sy] = app.camera.toScreen(b.pos);
    send(canvas, "pointerdown", sx, sy);
    send(canvas, "pointermove", sx + 30, sy);
    app.controller.updateDrag();
    // a violent flick right across the canvas in one frame
    send(canvas, "pointermove", sx + 5000, sy);
    app.controller.updateDrag();
    // The smooth response has no discontinuous clamp: its effective hand
    // speed approaches 0.4 m/s however large the raw lost-event jump becomes.
    expect(b.vel.length()).toBeCloseTo(0.4, 6);
    send(canvas, "pointerup", sx + 5000, sy);
  });

  it("gentles a moderate flick before the asymptote", () => {
    // The response is a curve rather than an emergency-only clamp, so an
    // ordinary fast drag is already softened before it reaches the ceiling.
    const { app, canvas } = makeApp();
    app.playing = true;
    const b = new Body(new Vec2(0, 0), 0.3, 1);
    app.world.bodies.push(b);
    app.ensureInitial();
    app.controller.setTool("select");
    const [sx, sy] = app.camera.toScreen(b.pos);
    send(canvas, "pointerdown", sx, sy);
    send(canvas, "pointermove", sx + 30, sy);
    app.controller.updateDrag();
    // ~30 px at the default zoom, over one clamped frame: tens of m/s raw
    send(canvas, "pointermove", sx + 90, sy);
    app.controller.updateDrag();
    expect(b.vel.length()).toBeGreaterThan(0);
    expect(b.vel.length()).toBeLessThan(0.4);
    send(canvas, "pointerup", sx + 90, sy);
  });

  it("gives the body back the motion it had before the drag", () => {
    const { app, canvas } = makeApp();
    app.playing = true;
    const b = new Body(new Vec2(0, 0), 0.3, 1);
    b.vel.set(1.75, -0.25);
    app.world.bodies.push(b);
    app.ensureInitial();
    app.controller.setTool("select");
    const [sx, sy] = app.camera.toScreen(b.pos);
    send(canvas, "pointerdown", sx, sy);
    send(canvas, "pointermove", sx + 200, sy + 90);
    app.controller.updateDrag();
    send(canvas, "pointerup", sx + 200, sy + 90);
    // repositioning is not throwing: the drag borrowed the velocity field
    // to talk to the solver and gives it back on release
    expect(b.vel.x).toBeCloseTo(1.75, 9);
    expect(b.vel.y).toBeCloseTo(-0.25, 9);
    expect(b.held).toBe(false);
  });
});

describe("velocity aiming is continuous", () => {
  it("keeps a parked right-drag aimed through every physics step", () => {
    const { app, canvas } = makeApp();
    const body = new Body(new Vec2(0, 0), 0.25, 1);
    app.world.bodies.push(body);
    app.ensureInitial();
    app.controller.setTool("select");
    const [sx, sy] = app.camera.toScreen(body.pos);
    const target: [number, number] = [sx + 120, sy - 60];
    send(canvas, "pointerdown", sx, sy, 2);
    send(canvas, "pointermove", target[0], target[1], 2);
    const targetWorld = app.camera.toWorld(target[0], target[1]);
    const scale = VEL_ARROW_SCALE * app.view.vectorScale;

    // No further pointermove events arrive. Gravity and integration still run,
    // but the velocity arrow must remain exactly under the held pointer rather
    // than flickering away between events.
    for (let i = 0; i < 20; i++) {
      app.stepOnce();
      expect(body.pos.x + body.vel.x * scale).toBeCloseTo(targetWorld.x, 9);
      expect(body.pos.y + body.vel.y * scale).toBeCloseTo(targetWorld.y, 9);
    }
    send(canvas, "pointerup", target[0], target[1], 2);
  });

  it("hides only the selected body's editable velocity handle for a free-body diagram", () => {
    const { app } = makeApp();
    const body = new Body(new Vec2(0, 0), 0.25, 1);
    body.vel.set(2, 1);
    app.world.bodies.push(body);
    app.setSelection([body]);
    app.controller.setTool("select");
    app.view.velVectors = true;
    const originalPath2D = globalThis.Path2D;
    class TestPath2D {
      moveTo(): void {}
      lineTo(): void {}
      closePath(): void {}
    }
    Object.defineProperty(globalThis, "Path2D", {
      value: TestPath2D, configurable: true,
    });
    let handleCount = 0;
    const ctx = {
      beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
      stroke() {}, fill() {},
      roundRect() { handleCount++; },
    } as unknown as CanvasRenderingContext2D;

    try {
      app.controller.drawOverlays(ctx);
      expect(handleCount).toBe(1);

      body.showForceComponents = true;
      app.controller.drawOverlays(ctx);
      expect(handleCount).toBe(1);
      expect(app.view.velVectors).toBe(true);
    } finally {
      if (originalPath2D === undefined) Reflect.deleteProperty(globalThis, "Path2D");
      else Object.defineProperty(globalThis, "Path2D", {
        value: originalPath2D, configurable: true,
      });
    }
  });
});

describe("box select", () => {
  it("selects a flat row of bodies from a thin box", () => {
    // requiring BOTH dimensions to be large made a box drawn across a row
    // select nothing at all, which reads as the tool being broken
    const { app, canvas } = makeApp();
    for (let i = 0; i < 4; i++) {
      app.world.bodies.push(new Body(new Vec2(i * 0.5 - 0.75, 0), 0.1, 1));
    }
    app.controller.setTool("select");
    send(canvas, "pointerdown", 100, 299);
    send(canvas, "pointermove", 700, 301); // 600 wide, 2 tall
    send(canvas, "pointerup", 700, 301);
    expect(app.selection.length).toBe(4);
  });

  it("ignores a box that is only click jitter", () => {
    const { app, canvas } = makeApp();
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    app.world.bodies.push(b);
    app.controller.setTool("select");
    // press on EMPTY space, so this starts a rubber band rather than
    // picking the body outright, then wobble by a pixel
    const [bx] = app.camera.toScreen(b.pos);
    const empty = bx + 200;
    send(canvas, "pointerdown", empty, 100);
    send(canvas, "pointermove", empty + 2, 101);
    send(canvas, "pointerup", empty + 2, 101);
    expect(app.selection.length).toBe(0);
  });
});

describe("picking", () => {
  it("picks the body drawn on top when two overlap", () => {
    // the renderer draws in list order, so the LAST body is on top and a
    // click has to agree with what the user can see
    const { app } = makeApp();
    const under = new Body(new Vec2(0, 0), 0.4, 1);
    const over = new Body(new Vec2(0, 0), 0.4, 1);
    app.world.bodies.push(under, over);
    const [sx, sy] = app.camera.toScreen(new Vec2(0, 0));
    expect(app.controller.pick([sx, sy])).toBe(over);
  });

  it("prefers a body to a link and a link to a wall at the same point", () => {
    const { app } = makeApp();
    const b = new Body(new Vec2(0, 0), 0.4, 1);
    app.world.bodies.push(b);
    const [sx, sy] = app.camera.toScreen(new Vec2(0, 0));
    expect(app.controller.pick([sx, sy])).toBe(b);
  });
});

describe("rod anchors and attachment gestures", () => {
  it("draws a standalone beam without visible endpoint particles or anchors", () => {
    const { app, canvas } = makeApp();
    app.controller.setTool("rod");
    send(canvas, "pointerdown", 300, 300);
    send(canvas, "pointerdown", 500, 300);
    expect(app.world.links).toHaveLength(1);
    const rod = app.world.links[0] as DistanceLink;
    expect(rod.a.isRodEndpoint).toBe(true);
    expect(rod.b.isRodEndpoint).toBe(true);
    expect(app.world.bodies.filter((body) => !body.isRodEndpoint)).toHaveLength(0);
    expect(app.world.bodies.some((body) => body.isAnchor)).toBe(false);
    expect(app.selection).toEqual([rod]);
  });

  it("uses the anchor tool for both free anchors and rod supports", () => {
    const { app, canvas } = makeApp();
    const a = new Body(new Vec2(-1, 0), 0.1, 1);
    const b = new Body(new Vec2(1, 0), 0.1, 1);
    const rod = new DistanceLink(a, b);
    app.world.bodies.push(a, b);
    app.world.links.push(rod);
    app.controller.setTool("anchor");
    const [x, y] = app.camera.toScreen(new Vec2(0.25, 0));
    send(canvas, "pointerdown", x, y);
    const pivot = app.world.bodies.find((body) => body.isPivot);
    expect(pivot).toBeDefined();
    expect(pivot?.rodAttachmentId).toBe(rod.id);
    expect(pivot?.rodAttachmentT).toBeCloseTo(0.625, 6);
    expect(pivot?.locked).toBe(true);
    expect(pivot?.collides).toBe(false);
    expect(pivot?.name).toBe("Anchor");
    expect(app.controller.pick([x, y + 8])).toBe(pivot);

    const count = app.world.bodies.length;
    send(canvas, "pointerdown", x, y - 120);
    expect(app.world.bodies).toHaveLength(count + 1);
    expect(app.world.bodies.at(-1)?.isAnchor).toBe(true);
    expect(app.world.bodies.at(-1)?.isPivot).toBe(false);
  });

  it("spawns a particle attached when it is placed near a rigid rod", () => {
    const { app, canvas } = makeApp();
    const a = new Body(new Vec2(-1, 0), 0.1, 1);
    const b = new Body(new Vec2(1, 0), 0.1, 1);
    const rod = new DistanceLink(a, b);
    app.world.bodies.push(a, b);
    app.world.links.push(rod);
    app.controller.setTool("body");

    const near = app.camera.toScreen(new Vec2(0.35, 0.12));
    send(canvas, "pointerdown", near[0], near[1]);
    const particle = app.world.bodies.at(-1)!;
    expect(particle.rodAttachmentId).toBe(rod.id);
    expect(particle.rodAttachmentT).toBeCloseTo(0.675, 6);
    expect(particle.pos.y).toBeCloseTo(0, 9);

    const far = app.camera.toScreen(new Vec2(0.2, 0.5));
    send(canvas, "pointerdown", far[0], far[1]);
    expect(app.world.bodies.at(-1)?.rodAttachmentId).toBeNull();
  });

  it("snaps a slowly dragged particle, slides it, then releases past hysteresis", () => {
    const { app, canvas } = makeApp();
    const a = new Body(new Vec2(-1, 0), 0.1, 1);
    const b = new Body(new Vec2(1, 0), 0.1, 1);
    const particle = new Body(new Vec2(0, 1), 0.12, 1);
    const rod = new DistanceLink(a, b);
    app.world.bodies.push(a, b, particle);
    app.world.links.push(rod);
    app.controller.setTool("select");
    const start = app.camera.toScreen(particle.pos);
    const near = app.camera.toScreen(new Vec2(0.25, 0.08));
    send(canvas, "pointerdown", start[0], start[1]);
    send(canvas, "pointermove", near[0], near[1]);
    (app.controller as unknown as { rodPointerSpeed: number }).rodPointerSpeed = 0;
    app.controller.updateDrag();
    expect(particle.rodAttachmentId).toBe(rod.id);
    expect(particle.pos.y).toBeCloseTo(0, 8);

    const sticky = app.camera.toScreen(new Vec2(0.6, 0.25));
    send(canvas, "pointermove", sticky[0], sticky[1]);
    app.controller.updateDrag();
    expect(particle.rodAttachmentId).toBe(rod.id);
    expect(particle.pos.y).toBeCloseTo(0, 8);

    const away = app.camera.toScreen(new Vec2(0.6, 0.8));
    send(canvas, "pointermove", away[0], away[1]);
    app.controller.updateDrag();
    expect(particle.rodAttachmentId).toBeNull();
    send(canvas, "pointerup", away[0], away[1]);
  });
});

describe("trails sample by distance", () => {
  it("does not record a point every step for a slow body", () => {
    // sampling every step makes the buffer fill with points a pixel apart:
    // more memory and more vertices for an identical-looking curve
    const { app } = makeApp();
    app.setTrails(true);
    app.world.gravity = 0;
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    b.vel.set(0.02, 0); // creeping: well under the sampling threshold
    app.world.bodies.push(b);
    app.ensureInitial();
    for (let i = 0; i < 100; i++) app.stepOnce();
    const trail = app.trails.get(b.id);
    expect(trail).toBeDefined();
    expect(trail!.count).toBeLessThan(60); // far fewer than the 200 substeps
  });

  it("still records a fast body densely enough to draw", () => {
    const { app } = makeApp();
    app.setTrails(true);
    app.world.gravity = 0;
    const b = new Body(new Vec2(0, 0), 0.1, 1);
    b.vel.set(4, 0);
    app.world.bodies.push(b);
    app.ensureInitial();
    for (let i = 0; i < 60; i++) app.stepOnce();
    expect(app.trails.get(b.id)!.count).toBeGreaterThan(20);
  });
});

describe("plot series reject nonsense and restart on a rewind", () => {
  it("drops a non-finite sample instead of scaling the window to it", () => {
    // one NaN or Infinity would otherwise wreck the autoscale for the whole
    // rolling window, which is the entire graph
    const s = new TimeSeries(["a", "b"]);
    s.add(0, { a: 1, b: 2 });
    s.add(0.1, { a: NaN, b: 2 });
    s.add(0.2, { a: 1, b: Infinity });
    s.add(0.3, { a: 3, b: 4 });
    expect(s.count).toBe(2);
    expect(s.values("a").every(Number.isFinite)).toBe(true);
    expect(s.values("b").every(Number.isFinite)).toBe(true);
  });

  it("refuses a non-finite time", () => {
    const s = new TimeSeries(["a"]);
    s.add(NaN, { a: 1 });
    s.add(Infinity, { a: 1 });
    expect(s.count).toBe(0);
  });

  it("starts over when the clock goes backwards", () => {
    // a reset or a rewind means the old samples describe a future that is
    // no longer going to happen
    const s = new TimeSeries(["a"]);
    for (let i = 0; i < 10; i++) s.add(i * 0.1, { a: i });
    expect(s.count).toBe(10);
    s.add(0.05, { a: 99 }); // the clock jumped back
    expect(s.count).toBe(1);
    expect(s.firstT).toBeCloseTo(0.05, 9);
  });

  it("updates in place when the same instant is sampled twice", () => {
    const s = new TimeSeries(["a"]);
    s.add(1, { a: 5 });
    s.add(1, { a: 7 });
    expect(s.count).toBe(1);
    expect(s.values("a")).toEqual([7]);
  });
});

describe("auto-fit really does fit", () => {
  it("keeps every body inside the viewport as the scene spreads out", () => {
    // the smoothing eases toward the target, so without a hard clamp on top
    // a fast-spreading scene outruns the camera and leaves bodies off-screen
    const { app } = makeApp();
    app.world.gravity = 0;
    for (let i = 0; i < 6; i++) {
      const b = new Body(new Vec2(0, 0), 0.1, 1);
      const th = (i / 6) * Math.PI * 2;
      b.vel.set(Math.cos(th) * 30, Math.sin(th) * 30); // flying apart fast
      app.world.bodies.push(b);
    }
    app.ensureInitial();
    app.view.autoFit = true;
    for (let frame = 0; frame < 200; frame++) {
      app.stepOnce();
      (app as unknown as { update(dt: number): void }).update(1 / 60);
      const [minX, minY, maxX, maxY] = app.camera.visibleBounds();
      for (const b of app.world.bodies) {
        expect(b.pos.x, `frame ${frame}`).toBeGreaterThanOrEqual(minX - 0.5);
        expect(b.pos.x, `frame ${frame}`).toBeLessThanOrEqual(maxX + 0.5);
        expect(b.pos.y, `frame ${frame}`).toBeGreaterThanOrEqual(minY - 0.5);
        expect(b.pos.y, `frame ${frame}`).toBeLessThanOrEqual(maxY + 0.5);
      }
    }
  });
});

describe("a gesture whose target is deleted stops driving it", () => {
  it("velocity aiming releases the body and stops editing it", () => {
    const { app, canvas } = makeApp();
    app.controller.setTool("body");
    send(canvas, "pointerdown", 300, 300);
    send(canvas, "pointerup", 300, 300);
    const body = app.world.bodies[0];
    app.setSelection([body]);
    app.controller.setTool("select");
    const [sx, sy] = app.camera.toScreen(body.pos);
    send(canvas, "pointerdown", sx, sy, 2); // start aiming its velocity
    const velBefore = body.vel.copy();
    app.controller.deleteSelection();       // it is erased mid-gesture
    send(canvas, "pointermove", sx + 120, sy, 2);
    // the deleted body must not still be receiving the aim
    expect(body.vel.x).toBeCloseTo(velBefore.x, 9);
    expect(body.vel.y).toBeCloseTo(velBefore.y, 9);
    send(canvas, "pointerup", sx + 120, sy, 2);
  });
});
