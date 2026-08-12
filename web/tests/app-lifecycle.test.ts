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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, PHYSICS_DT } from "../src/app";
import { Body } from "../src/engine/body";
import { PRESETS } from "../src/scene/presets";
import { Vec2 } from "../src/core/vec";
import { listScenes, snapshot } from "../src/scene/snapshot";

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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
    localStorage.setItem("mechanica.settings",
      '{"theme":"light","studio_mode":true,"cull":false}');
    const app = makeApp();
    expect(app.settings.theme).toBe("light");
    expect(app.settings.studio_mode).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.studio).toBe("true");
    expect(app.cullEnabled).toBe(false);
  });
});

describe("time jump", () => {
  it("continues from the CURRENT state, not the start snapshot", () => {
    // The root of the bug, stated without reference to any budget: a
    // forward jump must carry the world it is looking at forward. Proven by
    // making the live world differ from the initial snapshot in a way a
    // restart would erase - nothing pushes the body sideways, so x survives
    // a continuation and is lost by a restart.
    const app = makeApp();
    const b = new Body(new Vec2(0, 0), 0.2, 1);
    app.world.bodies.push(b);
    app.ensureInitial();
    b.pos.set(5, 0);
    app.commitTimeJump("1");
    expect(app.world.time).toBeCloseTo(1, 6);
    expect(app.world.bodies[0].pos.x).toBeCloseTo(5, 6);
  });

  it("resumes an interrupted jump, one bounded chunk at a time", () => {
    // A target beyond what one press can cover used to leave the clock
    // where the work ran out and then, on every later press, re-run the
    // same bounded work from the same start and stop in the same place: the
    // box did nothing at all from the second attempt onward.
    //
    // Sized against the STEP cap rather than the wall-clock budget, which
    // makes the amount of progress per press exact. An earlier version of
    // this test used a heavy scene and so measured whichever run the
    // machine happened to give the most time to - it passed and failed on
    // the same code depending on load, which is worse than no test.
    const perPress = 20000 * PHYSICS_DT; // TIME_JUMP_MAX_STEPS
    const app = makeApp();
    app.world.bodies.push(new Body(new Vec2(0, 0), 0.2, 1)); // cheap to step
    app.ensureInitial();

    app.commitTimeJump("400");
    expect(app.world.time).toBeCloseTo(perPress, 6);
    app.commitTimeJump("400");
    expect(app.world.time).toBeCloseTo(2 * perPress, 6);
    app.commitTimeJump("400");
    expect(app.world.time).toBeCloseTo(400, 6); // the last press arrives
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
    for (const bad of ["", "abc", "-1", "NaN", "1e999x", "1second", "Infinity",
                       "0x10", "0b10", "0o10", "--1"]) {
      expect(app.commitTimeJump(bad)).toBe(false);
    }
    expect(app.world.time).toBe(0);
  });

  it("rejects targets earlier than a non-zero scene baseline", () => {
    const app = makeApp();
    app.world.time = 5;
    app.ensureInitial();
    expect(app.commitTimeJump("4.99")).toBe(false);
    expect(app.world.time).toBe(5);
  });

  it("installs the restored baseline even when rounding needs zero steps", () => {
    const app = makeApp();
    const body = new Body(new Vec2(0, 0), 0.2, 1);
    app.world.bodies.push(body);
    app.ensureInitial();
    body.pos.x = 9;
    app.world.time = PHYSICS_DT * 0.25;
    expect(app.commitTimeJump("0")).toBe(true);
    expect(app.world.time).toBe(0);
    expect(app.world.bodies[0].pos.x).toBe(0);
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

  it("reset preserves an evolved angle beyond one turn exactly", () => {
    const app = makeApp();
    app.world.gravity = 0;
    const body = new Body(new Vec2(0, 0), 0.2, 1);
    body.collides = false;
    body.omega = 1000;
    app.world.bodies.push(body);
    app.world.step(PHYSICS_DT);
    app.ensureInitial();
    const expected = body.angle;
    expect(Math.abs(expected)).toBeGreaterThan(2 * Math.PI);

    body.angle = 0;
    app.resetSim();

    expect(app.world.bodies[0].angle).toBe(expected);
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

  it("undo restores the exact live state immediately before an edit", () => {
    const app = makeApp();
    app.world.bodies.push(new Body(new Vec2(0, 4), 0.2, 1));
    app.pushUndo();
    app.stepOnce();
    const before = snapshot(app.world);
    app.beginEdit();
    app.world.bodies[0].mass = 42;
    expect(app.commitEdit()).toBe("stored");
    app.undo();
    expect(snapshot(app.world)).toBe(before);
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

  it("makes a preset replacement undoable", () => {
    const app = makeApp();
    app.loadPreset(PRESETS[0], false);
    const before = snapshot(app.world);
    app.loadPreset(PRESETS[1], false);
    app.undo();
    expect(snapshot(app.world)).toBe(before);
  });

  it("startup preset initialization is the only history-resetting load", () => {
    const app = makeApp();
    app.initializePreset(PRESETS[0]);
    expect(app.undoStack.canUndo).toBe(false);
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

describe("failure containment", () => {
  it("stops a batch at the first divergence and emits one diagnostic", () => {
    const app = makeApp();
    const messages: string[] = [];
    app.toastFn = (message) => messages.push(message);
    const step = vi.fn(() => { app.world.diverged = ["Alpha", "Beta"]; });
    app.world.step = step;
    app.playing = true;
    app.accumulator = 3;

    app.stepOnce();

    expect(step).toHaveBeenCalledTimes(1);
    expect(app.playing).toBe(false);
    expect(app.accumulator).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Alpha.*Beta/);
  });

  it("stops retrying after an unexpected solver exception", () => {
    const app = makeApp();
    const messages: string[] = [];
    app.toastFn = (message) => messages.push(message);
    const body = new Body(new Vec2(0, 0), 0.2, 1);
    app.world.bodies.push(body);
    app.ensureInitial(); // primes the pre-step derived-energy cache
    const energy = vi.spyOn(app.world, "energy");
    const step = vi.fn(() => {
      body.vel.x = 5; // throwing steps can partially mutate before failing
      throw new Error("solver failed");
    });
    app.world.step = step;

    app.stepOnce();

    expect(step).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/unexpected solver error/i);
    expect(app.energyNow().ke).toBeCloseTo(body.kineticEnergy(), 12);
    expect(energy).toHaveBeenCalledTimes(1);
  });
});

describe("quick save", () => {
  it("uses milliseconds and never overwrites a same-instant save", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 4, 12, 34, 56, 789));
    const app = makeApp();
    app.quickSave();
    app.quickSave();
    expect(listScenes()).toEqual([
      "Scene 2026-08-04 123456-789",
      "Scene 2026-08-04 123456-789-2",
    ]);
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

describe("Performance-mode trails", () => {
  it("removes trail work while preserving the Normal-mode preference", () => {
    const app = makeApp();
    const body = new Body(new Vec2(0, 0), 0.2, 1);
    body.vel.x = 1;
    app.world.gravity = 0;
    app.world.bodies.push(body);
    app.setTrails(true);
    app.stepOnce();
    expect(app.trails.size).toBe(1);

    const toast = vi.fn();
    app.toast = toast;
    app.world.traceSpacing = 4;
    app.setPerfMode(true);
    expect(app.view.trails).toBe(true);
    expect(app.trails.size).toBe(0);
    expect(app.world.traceSpacing).toBe(0);
    app.stepOnce();
    expect(app.trails.size).toBe(0);

    app.setTrails(false); // keyboard/programmatic routes are inert too
    expect(app.view.trails).toBe(true);
    expect(toast).toHaveBeenCalledWith(
      "Motion trails are not available in performance mode");

    app.setPerfMode(false);
    app.stepOnce();
    expect(app.trails.size).toBe(1);
  });
});

describe("energy bookkeeping", () => {
  it("does not repeat mutual-gravity energy work on paused display frames", () => {
    const app = makeApp();
    app.world.mutualGravity = true;
    app.world.bodies.push(
      new Body(new Vec2(-1, 0), 0.2, 1),
      new Body(new Vec2(1, 0), 0.2, 1),
    );
    app.ensureInitial();
    const energy = vi.spyOn(app.world, "energy");
    app.invalidateEnergy();
    app.panels.push({ refresh: () => { app.energyDriftText(); } });

    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("Path2D", class {
      moveTo() {} lineTo() {} closePath() {} arc() {} rect() {}
      quadraticCurveTo() {} bezierCurveTo() {}
    });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const timers: Array<() => void> = [];
    vi.spyOn(window, "setTimeout").mockImplementation(((cb: TimerHandler) => {
      if (typeof cb === "function") timers.push(() => cb());
      return timers.length;
    }) as typeof window.setTimeout);
    const base = performance.now();
    app.start();
    for (let i = 1; i <= 12; i++) {
      frames.shift()!(base + i * 50);
      timers.shift()?.();
    }

    expect(app.playing).toBe(false);
    expect(energy).toHaveBeenCalledTimes(1);
  });

  it("shares a time-zero edit baseline with the following drift readout", () => {
    const app = makeApp();
    const body = new Body(new Vec2(0, 2), 0.2, 1);
    app.world.bodies.push(body);
    const energy = vi.spyOn(app.world, "energy");

    app.beginEdit();
    body.mass = 2;
    expect(app.commitEdit()).toBe("stored");
    app.energyDriftText();
    expect(energy).toHaveBeenCalledTimes(1);

    // Legacy immediate callers mutate first and use pushUndo as the boundary.
    body.mass = 3;
    app.pushUndo();
    app.energyDriftText();
    expect(energy).toHaveBeenCalledTimes(2);
  });

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

describe("graph recording", () => {
  /** A scene with motion in both axes and genuine spin, so every channel of
   * every series has a non-zero value to record. */
  function movingScene(app: App): void {
    const a = new Body(new Vec2(-1, 2), 0.2, 1);
    a.vel.set(1.3, 0.7);
    a.omega = 4;
    const b = new Body(new Vec2(1.5, -0.5), 0.25, 3);
    b.vel.set(-0.4, 1.1);
    b.omega = -2;
    app.world.bodies.push(a, b);
    app.ensureInitial();
  }

  it("reuses energy across unchanged frames and invalidates every state route", () => {
    const app = makeApp();
    movingScene(app);
    // Keep later edits from redefining the time-zero baseline, whose direct
    // baseline measurement is deliberately independent from the live cache.
    app.world.time = PHYSICS_DT;
    const energy = vi.spyOn(app.world, "energy");
    app.invalidateEnergy();

    app.energyNow();
    app.energyDriftText();
    app.energyNow();
    expect(energy).toHaveBeenCalledTimes(1);

    // Presentation-only changes do not dirty a physical derived quantity.
    app.camera.panPixels(12, -8);
    app.invalidateCanvas();
    app.energyDriftText();
    expect(energy).toHaveBeenCalledTimes(1);

    app.beginEdit();
    app.world.bodies[0].pos.x += 0.5;
    expect(app.commitEdit()).toBe("stored");
    app.energyDriftText();
    expect(energy).toHaveBeenCalledTimes(2);

    app.stepOnce();
    // Graph sampling and the later drift reader share the post-step value.
    app.energyDriftText();
    expect(energy).toHaveBeenCalledTimes(3);

    app.stepBack();
    const rewoundEnergy = vi.spyOn(app.world, "energy");
    app.energyDriftText();
    expect(energy).toHaveBeenCalledTimes(3);
    expect(rewoundEnergy).toHaveBeenCalledTimes(1);
  });

  it("fills every channel the series declares", () => {
    // The App hands each series a plain object keyed by channel NAME, and
    // TimeSeries silently substitutes 0 for any key it does not find. So a
    // renamed channel on either side does not fail - it plots a flat zero
    // line forever, which reads as a physics result rather than a wiring
    // mistake. Nothing connected the two lists before this.
    const app = makeApp();
    movingScene(app);
    app.setGraphMode("Energy");
    for (let i = 0; i < 40; i++) app.stepOnce();

    for (const series of [app.energySeries, app.momentumSeries]) {
      expect(series.count).toBeGreaterThan(0);
      for (const channel of series.channels) {
        const vals = series.values(channel);
        expect(vals.length, channel).toBe(series.count);
        expect(vals.every((v) => Number.isFinite(v)), channel).toBe(true);
        // every channel of this scene is genuinely non-zero, so an all-zero
        // column means the name did not match, not that the physics is flat
        expect(vals.some((v) => v !== 0), `channel '${channel}' is all zero`)
          .toBe(true);
      }
    }
  });

  it("records energy that matches the world's own accounting", () => {
    const app = makeApp();
    movingScene(app);
    app.setGraphMode("Energy");
    for (let i = 0; i < 10; i++) app.stepOnce();
    const e = app.world.energy();
    const ke = app.energySeries.values("KE").at(-1)!;
    const total = app.energySeries.values("Total").at(-1)!;
    expect(ke).toBeCloseTo(e.ke, 9);
    expect(total).toBeCloseTo(e.total, 9);
  });

  it("records momentum that matches the world's own accounting", () => {
    const app = makeApp();
    movingScene(app);
    app.setGraphMode("Mom.");
    for (let i = 0; i < 10; i++) app.stepOnce();
    const p = app.world.momentum();
    expect(app.momentumSeries.values("px").at(-1)!).toBeCloseTo(p.x, 9);
    expect(app.momentumSeries.values("py").at(-1)!).toBeCloseTo(p.y, 9);
    expect(app.momentumSeries.values("L").at(-1)!)
      .toBeCloseTo(app.world.angularMomentum(), 9);
  });

  it("keeps sampling after a rewind instead of going quiet", () => {
    // the sampler throttles on simulated time, so a backward jump must not
    // leave it waiting for a clock that has gone away
    const app = makeApp();
    movingScene(app);
    app.setGraphMode("Energy");
    for (let i = 0; i < 30; i++) app.stepOnce();
    const before = app.energySeries.count;
    app.stepBack();
    app.stepBack();
    for (let i = 0; i < 10; i++) app.stepOnce();
    expect(app.energySeries.count).toBeGreaterThan(0);
    expect(Number.isFinite(app.energySeries.lastT)).toBe(true);
    expect(before).toBeGreaterThan(0);
  });

  it("truncates timestamped phase samples when rewinding", () => {
    const app = makeApp();
    movingScene(app);
    app.setSelection([app.world.bodies[0]]);
    app.setGraphMode("Phase");
    for (let i = 0; i < 12; i++) app.stepOnce();
    expect(app.phasePlot.points.length).toBeGreaterThan(2);
    app.stepBack();
    app.stepBack();
    expect(app.phasePlot.points.every((point) => point[4] <= app.world.time)).toBe(true);
  });

  it("replaces a paused phase trace as soon as the selected body changes", () => {
    const app = makeApp();
    movingScene(app);
    const [first, second] = app.world.bodies;
    app.setSelection([first]);
    app.setGraphMode("Phase");
    for (let i = 0; i < 8; i++) app.stepOnce();
    expect(app.phasePlot.points.length).toBeGreaterThan(1);

    app.setSelection([second]);

    expect(app.playing).toBe(false);
    expect(app.phasePlot.points).toHaveLength(1);
    expect(app.phasePlot.points[0].slice(0, 4)).toEqual([
      second.pos.x, second.vel.x, second.pos.y, second.vel.y,
    ]);
    expect(app.phasePlot.points[0][4]).toBe(app.world.time);
  });

  it("clears the graphs when the world is replaced", () => {
    const app = makeApp();
    movingScene(app);
    app.setGraphMode("Energy");
    for (let i = 0; i < 20; i++) app.stepOnce();
    expect(app.energySeries.count).toBeGreaterThan(1);
    app.loadPreset(PRESETS[0], false);
    // a fresh world seeds one sample; it must not carry the old world's
    expect(app.energySeries.lastT).toBeLessThanOrEqual(app.world.time + 1e-9);
  });
});
