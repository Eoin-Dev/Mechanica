/** Mechanica application: canvas, main loop, playback and app-level state.
 *
 * The fixed-timestep accumulator, adaptive time resolution, rewind history,
 * trails and graph recording are direct ports of the desktop app; rendering
 * happens on requestAnimationFrame and the UI chrome lives in the DOM.
 */
import { Body, Wall } from "./engine/body";
import { World } from "./engine/world";
import { Camera, MAX_ZOOM, MIN_ZOOM } from "./render/camera";
import { Selectable, ViewSettings, drawGrid, drawScaleBar, drawWorld, snapStep } from "./render/draw";
import { Trail } from "./render/trail";
import * as snap from "./scene/snapshot";
import { PRESETS, Preset } from "./scene/presets";
import { CanvasController } from "./interact/tools";
import { PhasePlot, TimeSeries } from "./ui/plots";
import * as theme from "./ui/theme";
import { css } from "./ui/theme";

export const PHYSICS_DT = 1.0 / 120.0;
const MAX_STEPS_PER_FRAME = 24; // bounds catch-up work per frame at high speeds
// wall-clock ceiling for physics per frame: however heavy the scene, the
// UI keeps redrawing and stays clickable (the sim just runs slower than
// real time, with the existing "can't keep up" warning)
const PHYSICS_BUDGET_S = 0.045;
const SETTINGS_KEY = "mechanica.settings";

export type GraphMode = "Off" | "Energy" | "Mom." | "Phase";

interface Settings {
  adaptive_dt?: boolean;
  inspector_visible?: boolean;
  inspector_w?: number;
  dock_h?: number;
  tour_done?: boolean;
}

/** Panels register here; the app pokes them once per frame. */
export interface Panel {
  refresh(): void;
}

export class App {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  world = new World();
  camera = new Camera(800, 600);
  view = new ViewSettings();
  selection: Selectable[] = [];
  boxFilter = { bodies: true, anchors: true, walls: true, springs: true, rods: true };
  controller: CanvasController;

  playing = false;
  speed = 1.0;
  accumulator = 0.0;
  fpsNow = 0.0;
  overloaded = false;
  // adaptive time resolution: extra, smaller physics steps during fast
  // close encounters, budgeted against real frame headroom
  adaptiveDt = true;
  private physRes = 1;    // current subdivision (with hysteresis)
  qNow = 1;               // what actually ran this frame (for the UI)
  private stepMs = 0.2;   // EMA of wall-clock ms per world step
  private lastPhysMs = 0.0;

  undoStack = new snap.UndoStack(this.world);
  initialSnapshot: string | null = null;
  baselineEnergy: number | null = null;
  clipboardProps: Record<string, number | boolean> | null = null;

  trails = new Map<number, Trail>();
  energySeries = new TimeSeries(["KE", "PE", "Total"]);
  momentumSeries = new TimeSeries(["|p|", "px", "py", "L"]);
  phasePlot = new PhasePlot();
  private phaseBodyId: number | null = null;
  graphMode: GraphMode = "Off";

  settings: Settings = {};
  private autofitRatio = 1.0; // user zoom-out factor while auto-fitting
  private history: string[] = []; // per-frame rewind states (rolling)
  private overloadSince: number | null = null;
  private overloadHintAt = 0.0;
  private nudgeDirty = false;
  private nudgeDeadline = 0.0;
  private divergeCooldown = 0.0;
  private lastFrame = 0.0;
  private fpsSmoothed = 0.0;

  // wired up by main.ts after the panels are constructed
  panels: Panel[] = [];
  onSelectionChange: () => void = () => {};
  onWorldReplaced: () => void = () => {};
  toastFn: (msg: string) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.controller = new CanvasController(this);
    this.controller.attach(canvas);
    this.settings = this.loadSettings();
    this.adaptiveDt = this.settings.adaptive_dt ?? true;
  }

  // --------------------------------------------------------------- settings
  private loadSettings(): Settings {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Settings;
    } catch {
      return {};
    }
  }

  saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // storage full or blocked: settings just don't persist
    }
  }

  // ----------------------------------------------------------------- layout
  get canvasWidth(): number {
    return this.canvas.clientWidth;
  }

  resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.camera.resize(w, h);
  }

  // --------------------------------------------------------------- playback
  togglePlay(): void {
    this.ensureInitial();
    this.playing = !this.playing;
  }

  /** Step the world, converting a mid-step numerical blow-up into frozen
   * bodies via sanitize instead of crashing the app. */
  private safeStep(world: World, dt: number): boolean {
    try {
      world.step(dt);
      return true;
    } catch {
      if (world.diverged.length === 0) world.diverged.push("a body");
      return false;
    }
  }

  stepOnce(): void {
    this.ensureInitial();
    this.playing = false;
    // one 60 Hz frame, stepped at the normal rate so accuracy matches play
    for (let i = 0; i < 2; i++) {
      this.safeStep(this.world, PHYSICS_DT);
      this.recordTrails();
    }
    this.afterPhysics();
  }

  /** Rewind the simulation by one displayed frame (,). */
  stepBack(): void {
    this.playing = false;
    let state: string | null = null;
    if (this.history.length >= 2) {
      this.history.pop();                           // the frame we are on
      state = this.history[this.history.length - 1]; // the one before it
    } else if (this.initialSnapshot !== null) {
      this.history.length = 0;
      state = this.initialSnapshot;
    }
    if (state === null) return;
    const selIds = new Set(this.selection
      .filter((o): o is Body => o instanceof Body).map((o) => o.id));
    const world = snap.restore(state);
    this.world = world;
    this.controller.hover = null;
    this.controller.abortDrag();
    this.setSelection(world.bodies.filter((b) => selIds.has(b.id)));
    // trim graphs back to the rewound time instead of wiping them
    this.energySeries.truncate(world.time);
    this.momentumSeries.truncate(world.time);
  }

  ensureInitial(): void {
    if (this.initialSnapshot === null) {
      this.initialSnapshot = snap.snapshot(this.world);
      this.baselineEnergy = this.world.energy().total;
    }
  }

  resetSim(): void {
    if (this.initialSnapshot === null) return;
    this.replaceWorld(snap.restore(this.initialSnapshot));
    this.playing = false;
    this.toast("Reset to the initial state");
  }

  commitTimeJump(text: string): boolean {
    const target = parseFloat(text);
    if (!Number.isFinite(target) || target < 0) return false;
    this.ensureInitial();
    const world = snap.restore(this.initialSnapshot!);
    let steps = Math.round((target - world.time) / PHYSICS_DT);
    if (steps < 0) return false;
    if (steps > 20000) {
      steps = 20000;
      this.toast(`Time jump capped at ${(world.time + steps * PHYSICS_DT).toFixed(0)} s`);
    }
    for (let i = 0; i < steps; i++) {
      if (!this.safeStep(world, PHYSICS_DT)) break;
    }
    this.replaceWorld(world, true);
    this.playing = false;
    return true;
  }

  replaceWorld(world: World, keepInitial = false): void {
    this.world = world;
    this.setSelection([]);
    this.controller.hover = null;
    this.controller.abortDrag();
    this.trails.clear();
    this.energySeries.clear();
    this.momentumSeries.clear();
    this.phasePlot.clear();
    this.history.length = 0;
    if (!keepInitial) {
      this.initialSnapshot = null;
      this.baselineEnergy = null;
    }
    this.onWorldReplaced();
  }

  setSelection(sel: Selectable[]): void {
    this.selection = sel;
    this.onSelectionChange();
  }

  // -------------------------------------------------------------- undo/redo
  pushUndo(): void {
    this.undoStack.push(this.world);
    if (this.world.time === 0.0) {
      this.initialSnapshot = snap.snapshot(this.world);
      this.baselineEnergy = this.world.energy().total;
    }
    this.onSelectionChange(); // structure may have changed: rebuild inspector
  }

  undo(): void {
    const world = this.undoStack.undo();
    if (world !== null) {
      this.replaceWorld(world);
      this.playing = false;
    }
  }

  redo(): void {
    const world = this.undoStack.redo();
    if (world !== null) {
      this.replaceWorld(world);
      this.playing = false;
    }
  }

  // -------------------------------------------------------------- scene ops
  newScene(): void {
    this.replaceWorld(new World());
    this.playing = false;
    this.pushUndo();
    this.toast("Scene cleared (Ctrl+Z restores it)");
  }

  loadPreset(preset: Preset, announce = true): void {
    this.replaceWorld(preset.build());
    this.playing = false;
    this.undoStack.reset(this.world);
    const hints = preset.hints;
    this.view.trails = hints.trails ?? false;
    this.view.autoFit = hints.autoFit ?? false;
    if (hints.vectors) this.view.velVectors = true;
    if (hints.graph) {
      const mode = { energy: "Energy", momentum: "Mom.", phase: "Phase" }[hints.graph];
      this.setGraphMode(mode as GraphMode);
    }
    this.framePreset(hints.zoom, hints.centre);
    this.ensureInitial();
    this.onWorldReplaced();
    if (announce) this.toast(`Loaded '${preset.name}' - press Space to run`);
  }

  /** Frame a freshly loaded preset so nothing starts off-screen.
   *
   * The zoom is never tighter than a full fit of the initial scene; a
   * hint zoom may only widen it (anticipating where the action will go). */
  private framePreset(hintZoom?: number, hintCentre?: [number, number]): void {
    const cam = this.camera;
    this.autofitRatio = 1.0;
    const bounds = this.sceneBounds();
    if (bounds === null) {
      cam.centre.set(hintCentre?.[0] ?? 0, hintCentre?.[1] ?? 0);
      cam.zoom = hintZoom ?? 88.0;
      return;
    }
    const fit = this.frameForBounds(bounds);
    const zoom = Math.min(hintZoom ?? fit[2], fit[2]);
    let [cx, cy] = this.frameForBounds(bounds, zoom);
    if (hintCentre) {
      const [hx, hy] = hintCentre;
      const [minX, maxX, minY, maxY] = bounds;
      const w = this.camera.screenW;
      const h = this.camera.screenH;
      cx = Math.min(Math.max(hx, maxX - (w * 0.5) / zoom), minX + (w * 0.5) / zoom);
      cy = Math.min(Math.max(hy, maxY - (h * 0.5) / zoom), minY + (h * 0.5) / zoom);
    }
    cam.zoom = zoom;
    cam.centre.set(cx, cy);
  }

  // --------------------------------------------------- property clipboard
  static COPYABLE = ["mass", "radius", "restitution", "friction",
                     "locked", "collides"] as const;

  copyProps(): void {
    const body = this.selection.find((o): o is Body => o instanceof Body && !o.isAnchor);
    if (body === undefined) {
      this.toast("Select a body to copy properties from");
      return;
    }
    this.clipboardProps = {};
    for (const k of App.COPYABLE) {
      this.clipboardProps[k] = body[k] as number | boolean;
    }
    this.toast(`Copied properties of ${body.name}`);
  }

  pasteProps(): void {
    if (this.clipboardProps === null) return;
    const bodies = this.selection.filter((o): o is Body => o instanceof Body && !o.isAnchor);
    for (const b of bodies) {
      Object.assign(b, this.clipboardProps);
    }
    if (bodies.length > 0) {
      this.pushUndo();
      this.toast(`Pasted properties onto ${bodies.length} body(ies)`);
    }
  }

  // ------------------------------------------------------------ view helpers
  /** [min_x, max_x, min_y, max_y] enclosing every body and wall. */
  private sceneBounds(): [number, number, number, number] | null {
    const pts: Array<[number, number, number]> = []; // (x, y, pad radius)
    for (const b of this.world.bodies) {
      if (Number.isFinite(b.pos.x) && Number.isFinite(b.pos.y)) {
        pts.push([b.pos.x, b.pos.y, b.radius]);
      }
    }
    for (const w of this.world.walls) {
      const half = w.thickness * 0.5;
      pts.push([w.a.x, w.a.y, half]);
      pts.push([w.b.x, w.b.y, half]);
    }
    if (pts.length === 0) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y, r] of pts) {
      if (x - r < minX) minX = x - r;
      if (x + r > maxX) maxX = x + r;
      if (y - r < minY) minY = y - r;
      if (y + r > maxY) maxY = y + r;
    }
    return [minX, maxX, minY, maxY];
  }

  /** Camera (centre_x, centre_y, zoom) framing `bounds` in the canvas. */
  private frameForBounds(bounds: [number, number, number, number],
                         zoom: number | null = null): [number, number, number] {
    const [minX, maxX, minY, maxY] = bounds;
    if (zoom === null) {
      const spanX = Math.max(maxX - minX, 1e-6);
      const spanY = Math.max(maxY - minY, 1e-6);
      zoom = Math.min(this.camera.screenW / spanX, this.camera.screenH / spanY) * 0.85;
      zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    }
    return [(minX + maxX) * 0.5, (minY + maxY) * 0.5, zoom];
  }

  private fitTarget(): [number, number, number] | null {
    const bounds = this.sceneBounds();
    return bounds === null ? null : this.frameForBounds(bounds);
  }

  /** Frame every body and wall in the canvas (F). */
  zoomToFit(): void {
    const cam = this.camera;
    const target = this.fitTarget();
    if (target === null) {
      cam.centre.set(0.0, 0.0);
      cam.zoom = 88.0;
      return;
    }
    cam.centre.set(target[0], target[1]);
    cam.zoom = target[2];
  }

  /** Move selected bodies and walls one small step with the arrow keys. */
  nudgeSelection(dx: number, dy: number): void {
    const bodies = this.selection.filter((o): o is Body => o instanceof Body);
    const walls = this.selection.filter((o): o is Wall => o instanceof Wall);
    if (bodies.length === 0 && walls.length === 0) return;
    const step = this.view.snap ? snapStep(this.camera.zoom) : 8.0 / this.camera.zoom;
    for (const b of bodies) {
      b.pos.x += dx * step;
      b.pos.y += dy * step;
    }
    for (const w of walls) {
      w.a.x += dx * step;
      w.a.y += dy * step;
      w.b.x += dx * step;
      w.b.y += dy * step;
    }
    // commit to undo once the burst of key repeats ends
    this.nudgeDirty = true;
    this.nudgeDeadline = performance.now() / 1000 + 0.5;
  }

  quickSave(): void {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `scene ${now.getFullYear()}-${pad(now.getMonth() + 1)}-` +
      `${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}` +
      `${pad(now.getSeconds())}`;
    const saved = snap.saveScene(this.world, name);
    this.toast(`Saved scene '${saved}' - press L to browse scenes`);
  }

  toggleFollow(): void {
    this.view.follow = !this.view.follow;
    if (this.view.follow && !this.selection.some((o) => o instanceof Body)) {
      this.toast("Camera follow is on - select a body to track");
    } else {
      this.toast(`Camera follow ${this.view.follow ? "on" : "off"}`);
    }
  }

  toggleAutoFit(): void {
    this.view.autoFit = !this.view.autoFit;
    this.autofitRatio = 1.0;
    this.toast("Auto-fit camera " +
      (this.view.autoFit ? "on - framing the whole scene (scroll out any time)" : "off"));
  }

  /** Called after a manual scroll-zoom. With auto-fit active the user may
   * zoom out freely (auto-fit keeps tracking at that wider framing) but
   * can never zoom in tighter than the current fit level. */
  noteUserZoom(): void {
    if (!this.view.autoFit) return;
    const target = this.fitTarget();
    if (target === null) return;
    const zt = target[2];
    if (this.camera.zoom > zt) this.camera.zoom = zt;
    this.autofitRatio = Math.max(0.02, Math.min(1.0, this.camera.zoom / zt));
  }

  /** Zoom out and shift the camera just enough that every body and wall
   * is inside the canvas right now. */
  private clampCameraToBounds(): void {
    const bounds = this.sceneBounds();
    if (bounds === null) return;
    const [minX, maxX, minY, maxY] = bounds;
    const cam = this.camera;
    const spanX = Math.max(maxX - minX, 1e-9);
    const spanY = Math.max(maxY - minY, 1e-9);
    const fit = Math.min(cam.screenW / spanX, cam.screenH / spanY) * 0.98;
    if (cam.zoom > fit) cam.zoom = Math.max(fit, MIN_ZOOM);
    const z = cam.zoom;
    let lo = maxX - (cam.screenW * 0.5) / z;
    let hi = minX + (cam.screenW * 0.5) / z;
    if (lo <= hi) cam.centre.x = Math.min(Math.max(cam.centre.x, lo), hi);
    lo = maxY - (cam.screenH * 0.5) / z;
    hi = minY + (cam.screenH * 0.5) / z;
    if (lo <= hi) cam.centre.y = Math.min(Math.max(cam.centre.y, lo), hi);
  }

  bumpSpeed(factor: number): void {
    this.speed = Math.min(20.0, Math.max(0.01, this.speed * factor));
    this.toast(`Speed ${parseFloat(this.speed.toPrecision(3))}x`);
  }

  resetSpeed(): void {
    this.speed = 1.0;
    this.toast("Speed 1x");
  }

  toggleGraph(mode: GraphMode): void {
    this.setGraphMode(this.graphMode === mode ? "Off" : mode);
  }

  toggleLockSelection(): void {
    // Anchors are permanently locked; never toggle them.
    const bodies = this.selection.filter((o): o is Body => o instanceof Body && !o.isAnchor);
    if (bodies.length === 0) {
      this.toast("Select one or more bodies to lock (K)");
      return;
    }
    const target = !bodies.every((b) => b.locked);
    for (const b of bodies) b.locked = target;
    this.pushUndo();
    const n = bodies.length;
    this.toast(`${target ? "Locked" : "Unlocked"} ${n} ${n !== 1 ? "bodies" : "body"}`);
  }

  // ----------------------------------------------------------------- misc UI
  setGraphMode(mode: GraphMode): void {
    this.graphMode = mode;
    this.onWorldReplaced(); // panels re-check dock visibility
  }

  setAdaptiveDt(on: boolean): void {
    this.adaptiveDt = on;
    this.settings.adaptive_dt = on;
    this.saveSettings();
  }

  toast(msg: string): void {
    this.toastFn(msg);
  }

  energyDriftText(): string {
    if (this.baselineEnergy === null) return "";
    const e = this.world.energy().total;
    const base = this.baselineEnergy;
    if (Math.abs(base) < 1e-9) {
      const d = e - base;
      return `dE ${d >= 0 ? "+" : ""}${parseFloat(d.toPrecision(3))} J`;
    }
    const pct = (100 * (e - base)) / Math.abs(base);
    return `dE ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  }

  setTrails(on: boolean): void {
    // Re-enabling starts fresh, so no bogus straight line joins where
    // recording stopped to where it resumed.
    if (on && !this.view.trails) this.trails.clear();
    this.view.trails = on;
    if (!on) this.world.trace.length = 0;
  }

  // --------------------------------------------------------------- main loop
  start(): void {
    this.lastFrame = performance.now();
    const frame = (now: number) => {
      const dtFrame = Math.min(0.25, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      if (dtFrame > 0) {
        const inst = 1 / dtFrame;
        this.fpsSmoothed = this.fpsSmoothed * 0.9 + inst * 0.1;
        this.fpsNow = this.fpsSmoothed;
      }
      this.controller.updateDrag(); // keep held bodies pinned while parked
      this.update(dtFrame);
      this.render();
      for (const p of this.panels) p.refresh();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private update(dtFrame: number): void {
    if (this.nudgeDirty && performance.now() / 1000 > this.nudgeDeadline) {
      this.nudgeDirty = false;
      this.pushUndo();
    }

    if (this.playing) {
      // Below 1x, keep stepping at the normal 120 Hz real-time rate but
      // with a proportionally smaller dt: slow motion then produces a
      // fresh state every frame (glassy smooth, and *more* accurate)
      // instead of one full-size step every few frames (choppy).
      const effDt = PHYSICS_DT * Math.min(this.speed, 1.0);
      this.world.traceSpacing = this.view.trails ? 0.5 / this.camera.zoom : 0.0;
      this.accumulator += dtFrame * this.speed;
      let quanta = 0;
      let smallSteps = 0;
      let qUsed = 1;
      const t0 = performance.now();
      while (this.accumulator >= effDt && quanta < MAX_STEPS_PER_FRAME) {
        // resolution is re-chosen per quantum from the freshest
        // accelerations, so a close encounter that flares up mid-frame
        // is caught within 1/120 s
        const q = this.pickResolution(effDt, dtFrame);
        if (q > qUsed) qUsed = q;
        const h = effDt / q;
        for (let i = 0; i < q; i++) {
          this.safeStep(this.world, h);
          this.recordTrails();
          smallSteps++;
        }
        this.accumulator -= effDt;
        quanta++;
        if (performance.now() - t0 > PHYSICS_BUDGET_S * 1000) {
          break; // frame-time ceiling: stay responsive, dilate time
        }
      }
      const elapsed = performance.now() - t0;
      this.lastPhysMs = elapsed;
      if (smallSteps > 0) {
        this.stepMs = 0.9 * this.stepMs + (0.1 * elapsed) / smallSteps;
      }
      this.qNow = qUsed;
      this.overloaded = this.accumulator >= effDt;
      if (this.overloaded) this.accumulator = 0.0;
      this.checkSustainedOverload();
      this.afterPhysics();
      const nowS = performance.now() / 1000;
      if (this.world.diverged.length > 0 && nowS > this.divergeCooldown) {
        this.divergeCooldown = nowS + 5.0;
        const names = this.world.diverged.slice(0, 3).join(", ");
        this.toast(`${names} hit a numerical blow-up and was frozen ` +
                   "- check extreme forces or fields");
      }
    }

    if (this.view.autoFit) {
      const target = this.fitTarget();
      if (target !== null) {
        const cam = this.camera;
        // the user may zoom OUT below the fit level (ratio < 1); auto-fit
        // then keeps tracking at that wider framing and never zooms back
        // in on its own
        const desired = target[2] * this.autofitRatio;
        const rate = desired < cam.zoom ? 10.0 : 3.0;
        const k = Math.min(1.0, dtFrame * rate);
        cam.zoom *= (desired / cam.zoom) ** k;
        const blend = Math.min(1.0, dtFrame * 10.0);
        cam.centre.x += (target[0] - cam.centre.x) * blend;
        cam.centre.y += (target[1] - cam.centre.y) * blend;
        // hard guarantee on top of the smoothing: nothing that exists
        // right now may be off-screen, however fast it moves
        this.clampCameraToBounds();
      }
    } else if (this.view.follow) {
      const body = this.selection.find((o): o is Body =>
        o instanceof Body && Number.isFinite(o.pos.x) && Number.isFinite(o.pos.y));
      if (body !== undefined) {
        const cam = this.camera;
        const blend = Math.min(1.0, dtFrame * 8.0);
        cam.centre.x += (body.pos.x - cam.centre.x) * blend;
        cam.centre.y += (body.pos.y - cam.centre.y) * blend;
      }
    }
  }

  /** Time-resolution multiplier for this frame: how many extra, smaller
   * physics steps to run in place of each normal one.
   *
   * Need comes from the physics (world.subdivisionNeed: fast close
   * encounters want finer time slicing); affordability comes from the
   * measured step cost and frame headroom, so the extra work never pulls
   * the frame rate below ~48 fps. */
  private pickResolution(effDt: number, dtFrame: number): number {
    if (!this.adaptiveDt) {
      this.physRes = 1;
      return 1;
    }
    const need = this.world.subdivisionNeed(effDt);
    if (need > this.physRes) this.physRes = need; // react to spikes immediately...
    else if (this.physRes > need) this.physRes--; // ...but relax gradually
    let q = this.physRes;
    if (q > 1) {
      const baseSteps = Math.max(1.0, (dtFrame * this.speed) / effDt);
      const renderMs = Math.max(0.0, dtFrame * 1000.0 - this.lastPhysMs);
      const budgetMs = Math.max(1.0, 1000.0 / 48 - renderMs);
      const afford = Math.floor(budgetMs / Math.max(this.stepMs * baseSteps, 1e-3));
      q = Math.max(1, Math.min(q, afford));
    }
    return q;
  }

  /** After several seconds of continuous overload the lag clearly won't
   * recover on its own, so intervene: a fast-forward multiplier is the
   * usual culprit (reset it); otherwise tell the user what will help. */
  private checkSustainedOverload(): void {
    if (!this.overloaded) {
      this.overloadSince = null;
      return;
    }
    const now = performance.now() / 1000;
    if (this.overloadSince === null) {
      this.overloadSince = now;
      return;
    }
    if (now - this.overloadSince > 4.0 && now > this.overloadHintAt) {
      this.overloadHintAt = now + 30.0;
      if (this.speed > 1.0) {
        this.speed = 1.0;
        this.toast("Physics can't keep up - speed reset to 1x");
      } else {
        this.toast("Scene too heavy for real time (running in slow motion). " +
                   "Fewer substeps, iterations or bodies will speed it up.");
      }
    }
  }

  /** Append trail points; called after every physics step so extra
   * adaptive steps show up as extra trail resolution. */
  private recordTrails(): void {
    if (!this.view.trails) {
      this.world.trace.length = 0;
      return;
    }
    const maxlen = this.view.trailLen;
    const threshold = 0.5 / this.camera.zoom;
    const trailFor = (bid: number): Trail => {
      let t = this.trails.get(bid);
      if (t === undefined) {
        t = new Trail(maxlen);
        this.trails.set(bid, t);
      } else if (t.capacity !== maxlen) {
        t.setCapacity(maxlen); // the user changed Trail length
      }
      return t;
    };
    // sub-step path samples captured inside the adaptive integrator
    // (close encounters turn around within a single step)
    if (this.world.trace.length > 0) {
      for (const [bid, x, y] of this.world.trace) trailFor(bid).push(x, y);
      this.world.trace.length = 0;
    }
    for (const b of this.world.bodies) {
      if (b.locked) continue;
      const t = trailFor(b.id);
      const n = t.count;
      if (n === 0 ||
          Math.abs(t.x(n - 1) - b.pos.x) + Math.abs(t.y(n - 1) - b.pos.y) > threshold) {
        t.push(b.pos.x, b.pos.y);
      }
    }
  }

  private afterPhysics(): void {
    // rolling per-frame history so the user can step backwards (,)
    this.history.push(snap.snapshot(this.world));
    if (this.history.length > 600) this.history.shift();
    // graphs: every series records continuously whatever the dock shows,
    // so switching graph views never leaves gaps in the data
    const e = this.world.energy();
    this.energySeries.add(this.world.time, { KE: e.ke, PE: e.pe, Total: e.total });
    const p = this.world.momentum();
    this.momentumSeries.add(this.world.time, {
      "|p|": p.length(), px: p.x, py: p.y, L: this.world.angularMomentum(),
    });
    const body = this.selection.find((o): o is Body => o instanceof Body);
    if (body !== undefined) {
      if (body.id !== this.phaseBodyId) {
        this.phaseBodyId = body.id;
        this.phasePlot.clear();
      }
      this.phasePlot.add(body.pos.x, body.vel.x, body.pos.y, body.vel.y);
    }
  }

  // ------------------------------------------------------------------ render
  private render(): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.camera.screenW;
    const h = this.camera.screenH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css(theme.BG);
    ctx.fillRect(0, 0, w, h);
    if (this.view.grid) drawGrid(ctx, this.camera, w, h);
    drawWorld(ctx, this.camera, this.world, this.view, this.selection,
              this.controller.hover, this.trails, w, h);
    this.controller.drawOverlays(ctx);
    drawScaleBar(ctx, this.camera, w, h);
  }
}

export { PRESETS };
