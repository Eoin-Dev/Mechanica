/** @vitest-environment jsdom */
/** App-level behaviour, under a real DOM.
 *
 * Everything here was previously untestable. `App` needs a canvas, a
 * document and a storage backend to construct, the suite ran under plain
 * Node, and so the entire top layer of the program - the frame loop's
 * bookkeeping, playback, undo/redo, the time jump, scene replacement - had
 * no coverage at all. That is exactly where the two worst defects this
 * audit found were living, and neither could have been caught by a test
 * that could not build an App.
 *
 * jsdom gives no 2D canvas context, so `getContext("2d")` returns null.
 * Nothing here draws - `render()` is only called from the rAF loop, which
 * is never started - so a stub context is enough to let construction
 * through, and it keeps the environment honest about what is faked.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { App, PHYSICS_DT } from "../src/app";
import { Body } from "../src/engine/body";
import { PRESETS } from "../src/scene/presets";
import { Vec2 } from "../src/core/vec";

/** The handful of 2D-context members construction and resizing touch. */
function stubCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: 600, configurable: true });
  canvas.getContext = (() => ({
    setTransform() {}, fillRect() {}, clearRect() {}, save() {}, restore() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {},
    closePath() {}, measureText: () => ({ width: 10 }), fillText() {},
    translate() {}, rotate() {}, scale() {}, setLineDash() {}, clip() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, rect() {}, ellipse() {},
  })) as unknown as HTMLCanvasElement["getContext"];
  return canvas;
}

function makeApp(): App {
  document.body.replaceChildren();
  const canvas = stubCanvas();
  document.body.append(canvas);
  return new App(canvas);
}

beforeEach(() => {
  localStorage.clear();
});

describe("App construction", () => {
  it("builds against a real document without throwing", () => {
    const app = makeApp();
    expect(app.world).toBeDefined();
    expect(app.playing).toBe(false);
  });

  it("survives every kind of corrupt persisted settings", () => {
    // The regression that motivated the whole guard: these are read in the
    // constructor, so a bad one is a blank page on every reload rather than
    // one bad session. Asserting it at the level where it actually failed.
    for (const bad of ['{"theme":"midnight"}', '{"custom_accents":"nope"}',
                       '{"theme":"toString"}', '{"font_scale":"huge"}',
                       "not json at all", "null", "[1,2,3]", '"a string"']) {
      localStorage.setItem("mechanica.settings", bad);
      expect(() => makeApp()).not.toThrow();
    }
  });

  it("keeps a valid persisted setting", () => {
    localStorage.setItem("mechanica.settings", '{"theme":"light","cull":false}');
    const app = makeApp();
    expect(app.settings.theme).toBe("light");
    expect(app.cullEnabled).toBe(false);
  });
});

describe("time jump", () => {
  it("resumes from where it stopped instead of restarting", () => {
    // The bug: a target too far to reach in one budget left the clock where
    // the budget ran out, and asking AGAIN re-ran the same bounded work from
    // the same start snapshot and stopped at the same place. From the second
    // attempt onward the box appeared to do nothing at all.
    const app = makeApp();
    app.loadPreset(PRESETS.find((p) => p.name === "Jelly block")!, false);
    const seen: number[] = [app.world.time];
    for (let i = 0; i < 3; i++) {
      app.commitTimeJump("500");
      seen.push(app.world.time);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    }
  });

  it("reaches a target it can afford, exactly", () => {
    const app = makeApp();
    expect(app.commitTimeJump("1.5")).toBe(true);
    expect(app.world.time).toBeCloseTo(1.5, 6);
  });

  it("goes backwards by re-simulating from the start", () => {
    const app = makeApp();
    app.commitTimeJump("2");
    expect(app.world.time).toBeCloseTo(2, 6);
    app.commitTimeJump("0.5");
    expect(app.world.time).toBeCloseTo(0.5, 6);
  });

  it("continuing lands where one long jump would have", () => {
    // why resuming is legitimate rather than merely convenient: the step
    // sequence is the same fixed PHYSICS_DT either way, so 0->1->2 and 0->2
    // are the same simulation
    const a = makeApp();
    a.commitTimeJump("2");
    const b = makeApp();
    b.commitTimeJump("1");
    b.commitTimeJump("2");
    expect(b.world.time).toBeCloseTo(a.world.time, 9);
    expect(b.world.bodies.length).toBe(a.world.bodies.length);
    for (let i = 0; i < a.world.bodies.length; i++) {
      expect(b.world.bodies[i].pos.x).toBeCloseTo(a.world.bodies[i].pos.x, 9);
      expect(b.world.bodies[i].pos.y).toBeCloseTo(a.world.bodies[i].pos.y, 9);
    }
  });

  it("refuses input that is not a time", () => {
    const app = makeApp();
    for (const bad of ["", "abc", "-1", "NaN", "1e999x"]) {
      expect(app.commitTimeJump(bad)).toBe(false);
    }
    expect(app.world.time).toBe(0);
  });
});

describe("playback and history", () => {
  it("step/reset returns the scene to its start state", () => {
    const app = makeApp();
    const b = new Body(new Vec2(0, 5), 0.2, 1);
    app.world.bodies.push(b);
    app.pushUndo();
    app.stepOnce();
    expect(app.world.time).toBeGreaterThan(0);
    app.resetSim();
    expect(app.world.time).toBe(0);
    expect(app.world.bodies[0].pos.y).toBeCloseTo(5, 9);
  });

  it("undo and redo round-trip an edit", () => {
    const app = makeApp();
    const before = app.world.bodies.length;
    app.world.bodies.push(new Body(new Vec2(1, 1), 0.2, 1));
    app.pushUndo();
    expect(app.world.bodies.length).toBe(before + 1);
    app.undo();
    expect(app.world.bodies.length).toBe(before);
    app.redo();
    expect(app.world.bodies.length).toBe(before + 1);
  });

  it("stepping back rewinds the clock and never goes below the start", () => {
    const app = makeApp();
    app.world.bodies.push(new Body(new Vec2(0, 5), 0.2, 1));
    app.pushUndo();
    for (let i = 0; i < 5; i++) app.stepOnce();
    const t = app.world.time;
    app.stepBack();
    expect(app.world.time).toBeLessThan(t);
    for (let i = 0; i < 40; i++) app.stepBack();
    expect(app.world.time).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(app.world.time)).toBe(true);
  });

  it("loads every preset without throwing", () => {
    const app = makeApp();
    for (const p of PRESETS) {
      expect(() => app.loadPreset(p, false)).not.toThrow();
      expect(app.world.bodies.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("clearing the scene is undoable", () => {
    const app = makeApp();
    app.loadPreset(PRESETS[0], false);
    const had = app.world.bodies.length;
    expect(had).toBeGreaterThan(0);
    app.newScene();
    expect(app.world.bodies.length).toBe(0);
    app.undo();
    expect(app.world.bodies.length).toBe(had);
  });

  it("a world swap drops the selection and any held body", () => {
    const app = makeApp();
    app.loadPreset(PRESETS[0], false);
    const body = app.world.bodies[0];
    app.setSelection([body]);
    body.held = true;
    app.loadPreset(PRESETS[1], false);
    expect(app.selection).toEqual([]);
    expect(app.world.bodies.includes(body)).toBe(false);
  });
});

describe("speed control", () => {
  it("stays inside its advertised range however far it is bumped", () => {
    const app = makeApp();
    for (let i = 0; i < 40; i++) app.bumpSpeed(2);
    expect(app.speed).toBe(16);
    for (let i = 0; i < 80; i++) app.bumpSpeed(0.5);
    expect(app.speed).toBeCloseTo(0.01, 9);
    app.resetSpeed();
    expect(app.speed).toBe(1);
  });
});

describe("settings persistence", () => {
  it("round-trips through localStorage", () => {
    const app = makeApp();
    app.setPerfMode(true);
    app.setAdaptiveDt(false);
    const revived = makeApp();
    expect(revived.perfMode).toBe(true);
    expect(revived.adaptiveDt).toBe(false);
  });

  it("a blocked storage backend does not stop the app working", () => {
    const app = makeApp();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    try {
      expect(() => app.setPerfMode(true)).not.toThrow();
      expect(app.perfMode).toBe(true); // still applied in memory
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe("energy bookkeeping", () => {
  it("reports drift against the state the scene started in", () => {
    const app = makeApp();
    app.world.bodies.push(new Body(new Vec2(0, 5), 0.2, 1));
    app.ensureInitial();
    expect(app.energyDriftText()).toMatch(/dE/);
    for (let i = 0; i < 10; i++) app.stepOnce();
    // free fall under the default integrator conserves energy closely
    const pct = parseFloat(app.energyDriftText().replace(/[^\d.+-]/g, ""));
    expect(Math.abs(pct)).toBeLessThan(1);
  });

  it("PHYSICS_DT is the quantum the clock actually advances by", () => {
    const app = makeApp();
    app.stepOnce();
    expect(app.world.time).toBeCloseTo(2 * PHYSICS_DT, 9);
  });
});
