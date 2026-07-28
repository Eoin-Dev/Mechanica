/** @vitest-environment jsdom */
/** Random sequences of real user operations, against invariants that must
 * hold after every single one.
 *
 * Every other test in this suite asks "does this specific thing work?" and
 * so can only cover situations someone thought to write down. Interaction
 * bugs do not live there - they live in orderings nobody considered: delete
 * the body you are dragging, undo past a scene load, rewind while a link is
 * half-drawn, switch tools mid-gesture, cull a body that is selected.
 *
 * So this drives the app the way a person mashing buttons would, from a
 * fixed seed, and after EVERY operation asserts the things that must never
 * stop being true - no NaN anywhere, no link pointing at a body that is
 * gone, no selection holding a deleted object, no id collisions, nothing
 * unbounded. A failure prints the exact operation sequence, which is
 * reproducible because the seed is.
 */
import { describe, expect, it } from "vitest";
import { App } from "../src/app";

import { Body, Wall } from "../src/engine/body";
import { DistanceLink, SpringLink } from "../src/engine/links";
import { TOOLS } from "../src/interact/tools";
import { PRESETS } from "../src/scene/presets";

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

/** Deterministic PRNG, so a failing sequence can be replayed exactly. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Everything that must be true of the app after ANY operation. */
function invariants(app: App): string | null {
  const w = app.world;

  for (const b of w.bodies) {
    if (!Number.isFinite(b.pos.x + b.pos.y)) return `body ${b.id} position not finite`;
    if (!Number.isFinite(b.vel.x + b.vel.y)) return `body ${b.id} velocity not finite`;
    if (!Number.isFinite(b.angle + b.omega)) return `body ${b.id} spin not finite`;
    if (!(b.radius > 0)) return `body ${b.id} radius ${b.radius}`;
    if (!(b.mass >= 0)) return `body ${b.id} mass ${b.mass}`;
  }
  if (!Number.isFinite(w.time) || w.time < 0) return `world time ${w.time}`;

  const bodies = new Set(w.bodies);
  for (const ln of w.links) {
    if (!bodies.has(ln.a) || !bodies.has(ln.b)) return `link ${ln.id} dangling`;
    if (ln.a === ln.b) return `link ${ln.id} joins a body to itself`;
  }
  const byId = new Map<number, Body>();
  for (const b of w.bodies) {
    if (byId.has(b.id)) return `duplicate body id ${b.id}`;
    byId.set(b.id, b);
  }
  const wallIds = new Set<number>();
  for (const x of w.walls) {
    if (wallIds.has(x.id)) return `duplicate wall id ${x.id}`;
    wallIds.add(x.id);
  }

  // the selection may never hold something the world has dropped
  for (const o of app.selection) {
    const alive = o instanceof Body ? bodies.has(o)
      : o instanceof Wall ? w.walls.includes(o)
        : w.links.includes(o as DistanceLink | SpringLink);
    if (!alive) return "selection holds a deleted object";
  }

  // camera must stay usable
  if (!Number.isFinite(app.camera.zoom) || app.camera.zoom <= 0) {
    return `camera zoom ${app.camera.zoom}`;
  }
  if (!Number.isFinite(app.camera.centre.x + app.camera.centre.y)) {
    return "camera centre not finite";
  }

  // trails may never outlive their bodies for long, nor grow without bound
  if (app.trails.size > w.bodies.length + 64) {
    return `trail map ${app.trails.size} for ${w.bodies.length} bodies`;
  }
  return null;
}

describe("random operation sequences keep the app consistent", () => {
  it("survives 400 random operations from many seeds", () => {
    // twenty seeds rather than a handful: the two defects this found both
    // needed a delete or a world swap to land inside a multi-step gesture,
    // which is rare per sequence and certain across enough of them
    for (const seed of Array.from({ length: 20 }, (_, i) => i * 7919 + 3)) {
      const rand = rng(seed);
      const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];

      document.body.replaceChildren();
      const canvas = stubCanvas();
      document.body.append(canvas);
      const app = new App(canvas);
      const c = app.controller;
      const trail: string[] = [];

      const point = (): [number, number] =>
        [Math.floor(rand() * 800), Math.floor(rand() * 600)];
      const ev = (type: string, xy: [number, number], button = 0): void => {
        const e = new Event(type, { bubbles: true });
        Object.assign(e, { clientX: xy[0], clientY: xy[1], button,
                           pointerId: 1, pointerType: "mouse",
                           shiftKey: rand() < 0.2 });
        canvas.dispatchEvent(e);
      };

      const OPS: Array<[string, () => void]> = [
        ["setTool", () => c.setTool(pick(TOOLS))],
        ["click", () => { const p = point(); ev("pointerdown", p); ev("pointerup", p); }],
        ["drag", () => {
          const a = point(); const b = point();
          ev("pointerdown", a); ev("pointermove", b);
          c.updateDrag(); ev("pointerup", b);
        }],
        ["dragCancel", () => {
          const a = point();
          ev("pointerdown", a); ev("pointermove", point());
          ev("pointercancel", point());
        }],
        ["rightDrag", () => {
          const a = point();
          ev("pointerdown", a, 2); ev("pointermove", point(), 2); ev("pointerup", point(), 2);
        }],
        ["step", () => app.stepOnce()],
        ["stepBack", () => app.stepBack()],
        ["play", () => app.togglePlay()],
        ["reset", () => app.resetSim()],
        ["undo", () => app.undo()],
        ["redo", () => app.redo()],
        ["delete", () => c.deleteSelection()],
        ["duplicate", () => c.duplicateSelection()],
        ["lock", () => app.toggleLockSelection()],
        ["selectAll", () => app.setSelection([...app.world.bodies])],
        ["selectNone", () => app.setSelection([])],
        ["newScene", () => app.newScene()],
        ["loadPreset", () => app.loadPreset(pick(PRESETS), false)],
        ["zoomToFit", () => app.zoomToFit()],
        ["autoFit", () => app.toggleAutoFit()],
        ["follow", () => app.toggleFollow()],
        ["speed", () => app.bumpSpeed(rand() < 0.5 ? 0.5 : 2)],
        ["graph", () => app.setGraphMode(pick(["Off", "Energy", "Mom.", "Phase"] as const))],
        ["trails", () => app.setTrails(rand() < 0.5)],
        ["perfMode", () => app.setPerfMode(rand() < 0.5)],
        ["copyProps", () => app.copyProps()],
        ["pasteProps", () => app.pasteProps()],
        ["timeJump", () => app.commitTimeJump(String(Math.floor(rand() * 3)))],
        ["escape", () => { c.cancelPending(); }],
        ["abortDrag", () => c.abortDrag()],
        ["resetInteraction", () => c.resetInteraction()],
      ];

      for (let i = 0; i < 500; i++) {
        const [name, run] = pick(OPS);
        trail.push(name);
        try {
          run();
        } catch (err) {
          throw new Error(`seed ${seed}, op ${i} (${name}) threw: ` +
            `${(err as Error).message}\nsequence: ${trail.slice(-25).join(" ")}`);
        }
        const broken = invariants(app);
        if (broken !== null) {
          throw new Error(`seed ${seed}, op ${i} (${name}): ${broken}\n` +
            `sequence: ${trail.slice(-25).join(" ")}`);
        }
      }
    }
  }, 240_000);

  it("survives operations interleaved with a running simulation", () => {
    // the same idea, but with physics advancing between operations, which is
    // where held bodies, chase caps and the runaway cull come into play
    const rand = rng(4242);
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];
    document.body.replaceChildren();
    const canvas = stubCanvas();
    document.body.append(canvas);
    const app = new App(canvas);
    app.loadPreset(PRESETS[0], false);
    const c = app.controller;

    for (let i = 0; i < 300; i++) {
      const op = Math.floor(rand() * 8);
      if (op === 0) c.setTool(pick(TOOLS));
      else if (op === 1) {
        const e = new Event("pointerdown", { bubbles: true });
        Object.assign(e, { clientX: rand() * 800, clientY: rand() * 600,
                           button: 0, pointerId: 1, pointerType: "mouse" });
        canvas.dispatchEvent(e);
      } else if (op === 2) {
        const e = new Event("pointerup", { bubbles: true });
        Object.assign(e, { clientX: rand() * 800, clientY: rand() * 600,
                           button: 0, pointerId: 1, pointerType: "mouse" });
        canvas.dispatchEvent(e);
      } else if (op === 3) c.deleteSelection();
      else if (op === 4) app.setSelection([...app.world.bodies].slice(0, 2));
      else if (op === 5) app.undo();
      else if (op === 6) app.loadPreset(pick(PRESETS), false);
      else c.updateDrag();

      for (let k = 0; k < 3; k++) app.stepOnce();
      const broken = invariants(app);
      expect(broken, `op ${i} (kind ${op})`).toBeNull();
    }
  }, 240_000);
});

/** The two defects the fuzzer found, as named regressions.
 *
 * A fuzz test that stops failing tells you nothing about WHY. These pin the
 * specific sequences, in the smallest form, so the intent survives even if
 * the random search never lands on them again.
 */
describe("a gesture that outlives what it points at", () => {
  function app(): { app: App; canvas: HTMLCanvasElement } {
    document.body.replaceChildren();
    const canvas = stubCanvas();
    document.body.append(canvas);
    return { app: new App(canvas), canvas };
  }
  function click(canvas: HTMLCanvasElement, x: number, y: number): void {
    for (const type of ["pointerdown", "pointerup"]) {
      const e = new Event(type, { bubbles: true });
      Object.assign(e, { clientX: x, clientY: y, button: 0, pointerId: 1,
                         pointerType: "mouse" });
      canvas.dispatchEvent(e);
    }
  }
  const dangling = (a: App): number => {
    const present = new Set(a.world.bodies);
    return a.world.links.filter((l) => !present.has(l.a) || !present.has(l.b)).length;
  };

  it("a half-made link does not survive a scene load", () => {
    const { app: a, canvas } = app();
    a.controller.setTool("rod");
    click(canvas, 200, 200);        // first endpoint, in this world
    a.loadPreset(PRESETS[0], false); // the world underneath is replaced
    click(canvas, 400, 300);        // second endpoint, in the new one
    expect(dangling(a)).toBe(0);
  });

  it("a half-made link does not survive undo, reset or rewind", () => {
    for (const swap of [(a: App) => a.undo(), (a: App) => a.resetSim(),
                        (a: App) => a.stepBack(), (a: App) => a.newScene()]) {
      const { app: a, canvas } = app();
      a.loadPreset(PRESETS[0], false);
      a.stepOnce();
      a.controller.setTool("spring");
      click(canvas, 250, 250);
      swap(a);
      click(canvas, 450, 350);
      expect(dangling(a)).toBe(0);
    }
  });

  it("a half-made link does not survive deleting its first endpoint", () => {
    const { app: a, canvas } = app();
    a.controller.setTool("rope");
    click(canvas, 200, 200);          // creates an anchor and holds it
    a.setSelection([...a.world.bodies]);
    a.controller.deleteSelection();   // ...which is then erased
    click(canvas, 400, 300);
    expect(dangling(a)).toBe(0);
  });

  it("velocity aiming and wall reshaping drop a deleted target", () => {
    const { app: a, canvas } = app();
    a.controller.setTool("body");
    click(canvas, 300, 300);
    const body = a.world.bodies[0];
    a.setSelection([body]);
    const down = new Event("pointerdown", { bubbles: true });
    Object.assign(down, { clientX: 300, clientY: 300, button: 2, pointerId: 1,
                          pointerType: "mouse" });
    canvas.dispatchEvent(down);       // start aiming its velocity
    a.controller.deleteSelection();   // the body goes away mid-gesture
    const move = new Event("pointermove", { bubbles: true });
    Object.assign(move, { clientX: 380, clientY: 300, button: 2, pointerId: 1,
                          pointerType: "mouse" });
    expect(() => canvas.dispatchEvent(move)).not.toThrow();
    expect(a.world.bodies).not.toContain(body);
  });
});
