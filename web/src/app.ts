/** Mechanica application: canvas, main loop, playback and app-level state.
 *
 * The fixed-timestep accumulator, adaptive time resolution, rewind history,
 * trails and graph recording are direct ports of the desktop app; rendering
 * happens on requestAnimationFrame and the UI chrome lives in the DOM.
 */
import { Body } from "./engine/body";
import { World, escapedBodies } from "./engine/world";
import { Camera, MAX_ZOOM, MIN_ZOOM } from "./render/camera";
import { Selectable, ViewSettings, drawGrid, drawScaleBar, drawWorld } from "./render/draw";
import { Trail } from "./render/trail";
import * as snap from "./scene/snapshot";
import { PRESETS, Preset } from "./scene/presets";
import { CanvasController } from "./interact/tools";
import { GRAPH_MAX_POINTS, GRAPH_WINDOW_S, PhasePlot, TimeSeries } from "./ui/plots";
import { DOCK_H_MAX, DOCK_H_MIN, INSPECTOR_W_MAX, INSPECTOR_W_MIN,
         reducedMotion } from "./ui/dom";
import * as theme from "./ui/theme";
import { THEME_NAMES, ThemeName, css, setAccent, setTheme } from "./ui/theme";

export const PHYSICS_DT = 1.0 / 120.0;

// A body is "gone" once it is this many max-zoom-out viewports from the
// scene. Generous on purpose: the point is to bin debris that is never
// coming back, not to clip anything the user might still want.
const CULL_VIEWPORTS = 4.0;
// Bounds catch-up work per frame. It must comfortably clear the worst
// legitimate demand - 16x speed on a 30 Hz display needs 64 quanta - or the
// top of the speed slider is unreachable by construction: the accumulator
// can never drain, `overloaded` latches on however fast the machine is, and
// after four seconds the sustained-overload guard resets the speed to 1x.
// The real protection against a heavy scene is PHYSICS_BUDGET_S below,
// which is measured wall-clock rather than a step count.
const MAX_STEPS_PER_FRAME = 64;
// wall-clock ceiling for physics per frame: however heavy the scene, the
// UI keeps redrawing and stays clickable (the sim just runs slower than
// real time, with the existing "can't keep up" warning)
const PHYSICS_BUDGET_S = 0.045;
// How much simulated time one frame may be asked to catch up, as a multiple
// of the frame it is nominally worth.
//
// The accumulator is fed real elapsed time, so a slow frame asks for
// proportionally MORE physics - which makes the frame slower still. That is a
// positive feedback loop, and it is how a merely sluggish renderer turns into
// the "can't keep up" warning: a 33 ms frame demands four 1/120 s quanta
// instead of two, and if adaptive resolution is also multiplying each quantum
// the physics budget breaks and the accumulator never drains again.
//
// Clamping the catch-up breaks the loop. Beyond this multiple the simulation
// simply runs slower than real time - which is what a machine that cannot
// keep up should do - instead of trying to sprint and falling further behind
// every frame. Three frames' worth is enough to ride out an ordinary hitch
// (a garbage collection, a tab switch) without any visible dilation.
const MAX_CATCHUP_FRAMES = 3.0;
const SETTINGS_KEY = "mechanica.settings";

export type GraphMode = "Off" | "Energy" | "Mom." | "Phase";

export interface Settings {
  adaptive_dt?: boolean;
  inspector_visible?: boolean;
  inspector_w?: number;
  dock_h?: number;
  tour_done?: boolean;
  theme?: ThemeName;
  dyslexic_font?: boolean;
  cull?: boolean;
  perf_mode?: boolean;       // cheap solver and simplified drawing
  drag_hits_walls?: boolean; // a dragged body is stopped by walls
  accent?: string;           // hex UI accent; unset = the theme's default
  custom_accents?: string[]; // user-picked accents shown as extra swatches
  font_scale?: number;       // UI font-size multiplier (0.9 - 1.2)
}

/** Every boolean preference, so loadSettings can validate them in one pass
 * and a new one cannot be added to `Settings` and forgotten here. */
const BOOL_SETTINGS = [
  "adaptive_dt", "inspector_visible", "tour_done", "dyslexic_font",
  "cull", "perf_mode", "drag_hits_walls",
] as const satisfies ReadonlyArray<keyof Settings>;

/** A "#rrggbb" colour, the only shape the accent settings may hold. Values
 * from storage are interpolated straight into an inline `background:` on
 * the swatches, so nothing else may reach them. */
function isHex(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
}

/** Keep only the persisted preferences this build can actually use.
 *
 * Scene files have been guarded field by field since the port; settings
 * were not, and they are the more dangerous of the two. A scene is loaded
 * on demand and a bad one can be abandoned, whereas settings are read in
 * the App constructor on EVERY load - so one unusable value is not a bad
 * session but a permanently blank page, with no route back from inside the
 * app. Two fields could do it outright: a `theme` this build does not have
 * threw on the first palette read, and a `custom_accents` that was not an
 * array threw when the settings panel iterated it. Neither needs an
 * attacker - renaming a theme in a future version is enough.
 *
 * Anything unrecognised is DROPPED rather than repaired, so the field falls
 * back to its default exactly as if it had never been written. A pure
 * function of the parsed JSON, so it can be tested without standing up an
 * App (which needs a canvas, a document and a storage backend).
 */
export function sanitizeSettings(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const s: Settings = {};
  // hasOwn rather than a bare read: `raw` always comes from JSON.parse in
  // the app (which makes "__proto__" an ordinary own key rather than the
  // setter, so it cannot pollute), but a caller handing over an object
  // literal should not be able to smuggle a mode in through the prototype.
  for (const k of BOOL_SETTINGS) {
    if (Object.hasOwn(r, k) && typeof r[k] === "boolean") s[k] = r[k];
  }
  // Pane sizes are clamped to exactly what the splitters themselves allow
  // (the same constants they enforce), so a stale value from a much larger
  // window - or one the splitter could never have produced - cannot hide
  // the canvas or be honoured on load and then snap back on first drag.
  if (typeof r.inspector_w === "number" && Number.isFinite(r.inspector_w)) {
    s.inspector_w = Math.min(INSPECTOR_W_MAX, Math.max(INSPECTOR_W_MIN, r.inspector_w));
  }
  if (typeof r.dock_h === "number" && Number.isFinite(r.dock_h)) {
    s.dock_h = Math.min(DOCK_H_MAX, Math.max(DOCK_H_MIN, r.dock_h));
  }
  if (typeof r.theme === "string" && (THEME_NAMES as string[]).includes(r.theme)) {
    s.theme = r.theme as ThemeName;
  }
  // The font scale multiplies every size in the stylesheet, so an
  // out-of-range one is not a cosmetic problem: it makes the app unreadable
  // AND persists, so reloading cannot undo it.
  if (typeof r.font_scale === "number" && Number.isFinite(r.font_scale)) {
    s.font_scale = Math.min(1.2, Math.max(0.9, r.font_scale));
  }
  if (isHex(r.accent)) s.accent = r.accent;
  if (Array.isArray(r.custom_accents)) {
    s.custom_accents = r.custom_accents.filter(isHex).slice(0, 6);
  }
  return s;
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
  // Adaptive time resolution: extra, smaller physics steps during fast
  // close encounters. Chosen from the simulation state alone, so the
  // result never depends on how busy the machine is (see pickResolution).
  adaptiveDt = true;
  qNow = 1;               // what actually ran this frame (for the UI)

  // Adaptive trail detail: a multiplier on the renderer's vertex budget,
  // raised while frames are cheap and lowered when they are not.
  //
  // Note this is the opposite call from pickResolution, which deliberately
  // ignores frame timing. The difference is that the physics step size
  // decides the ANSWER - letting machine load choose it makes the same
  // scene integrate differently from run to run - whereas the trail vertex
  // count only decides how finely an already-computed path is drawn. No
  // simulation state depends on it, so spending spare frame time here is
  // free accuracy rather than a source of nondeterminism.
  trailQuality = 1.0;
  private renderMs = 4.0; // EMA of measured render cost, ms
  // Aim to leave the rest of a 60 Hz frame alone. Trails are the only part
  // of rendering that can be scaled, so this is the whole render budget.
  private static RENDER_TARGET_MS = 6.0;
  private static TRAIL_QUALITY_MIN = 0.35;
  private static TRAIL_QUALITY_MAX = 6.0;

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
  private history = new snap.RewindBuffer(); // per-frame rewind (rolling)
  private overloadSince: number | null = null;
  private overloadHintAt = 0.0;
  private divergeCooldown = 0.0;
  private lastFrame = 0.0;
  private fpsSmoothed = 0.0;

  // true while a soft-body preset is loaded and the user has not yet been
  // shown the "right-drag instead" hint; the controller consumes it on the
  // first left-drag of a soft-body particle
  softBodyHintArmed = false;

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
    this.applyUiSettings();
  }

  // --------------------------------------------------------------- settings
  private loadSettings(): Settings {
    try {
      return sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}"));
    } catch {
      return {}; // unparseable JSON: start from defaults
    }
  }

  saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // storage full or blocked: settings just don't persist
    }
  }

  /** Apply the persisted appearance settings (theme defaults to dark). */
  applyUiSettings(): void {
    setAccent(this.settings.accent ?? null); // re-applies the theme too
    setTheme(this.settings.theme ?? "dark");
    document.body.classList.toggle("dyslexic", this.settings.dyslexic_font ?? false);
    document.documentElement.style.setProperty(
      "--fs", String(this.settings.font_scale ?? 1));
  }

  /** Delete bodies that have escaped for good (recommended; default on). */
  get cullEnabled(): boolean {
    return this.settings.cull ?? true;
  }

  /** Whether a body being dragged is stopped by walls.
   *
   * Off by default, which is the long-standing behaviour: a held body is
   * infinite mass so it tracks the cursor exactly, and the contact solver
   * skips infinite-mass-vs-wall pairs, so it passes through scenery. That
   * is genuinely useful for placing something on the far side of a wall,
   * and it is also how every existing scene was built - so it stays the
   * default and the solid behaviour is opt-in. */
  get dragHitsWalls(): boolean {
    return this.settings.drag_hits_walls ?? false;
  }

  setDragHitsWalls(on: boolean): void {
    this.settings.drag_hits_walls = on;
    this.saveSettings();
  }

  /** Trade accuracy for stability and frame rate, everywhere at once.
   *
   * Off by default. A preference of this browser rather than of the scene, so
   * it is never saved into a scene file and a shared scene never imposes it -
   * the same reasoning as adaptive resolution.
   *
   * Most of it is the existing levers pushed the cheap way together:
   * Symplectic Euler, capped substeps and solver iterations, no adaptive time
   * resolution and no in-substep slicing, and a renderer that draws springs as
   * lines and skips spin markers.
   *
   * Springs are the exception, and they are why this is a genuinely different
   * solver rather than a cheaper dial setting. Cheap dials made them WORSE:
   * an explicit spring's stability limit tightens with the square of the
   * timestep, so halving the substeps was enough to blow up every soft body in
   * the library. In this mode they are position constraints instead, which
   * cannot be destabilised by any stiffness, damping or mass ratio at all -
   * see engine/perf.ts for the whole argument.
   */
  get perfMode(): boolean {
    return this.settings.perf_mode ?? false;
  }

  setPerfMode(on: boolean): void {
    this.settings.perf_mode = on;
    this.saveSettings();
    this.applySolverMode(this.world);
  }

  /** Point a world at the current solver mode. Called on every world the app
   * steps, so no path can forget it. */
  applySolverMode(world: World): void {
    world.performance = this.perfMode;
  }

  /** How far a body must stray before it counts as gone: several times
   * the widest view the camera can ever show (MIN_ZOOM), so anything the
   * user could still zoom out to see is always safe. */
  private cullLimit(): number {
    const halfW = this.camera.screenW / (2 * MIN_ZOOM);
    const halfH = this.camera.screenH / (2 * MIN_ZOOM);
    return CULL_VIEWPORTS * Math.max(halfW, halfH, 1);
  }

  /** Bin runaway bodies.
   *
   * Debris dropped into empty space (or flung off a collision) otherwise
   * accumulates forever: it costs physics time on every step and drags
   * auto-fit out to nothing, while being impossible to see or reach.
   * Only bodies far beyond any usable view AND still receding qualify,
   * so a wide bound orbit is never touched.
   */
  private cullEscaped(): void {
    if (!this.cullEnabled) return;
    const gone = escapedBodies(this.world, this.cullLimit());
    if (gone.length === 0) return;
    // a debris storm can bin hundreds at once, on a frame that is also
    // running the simulation: one batched edit and one reconciliation
    this.controller.deleteObjects(gone);
    this.culledTotal += gone.length;
    // one throttled note rather than a stream of them
    const nowS = performance.now() / 1000;
    if (nowS > this.cullCooldown) {
      this.cullCooldown = nowS + 8.0;
      const n = this.culledTotal;
      this.toast(`Removed ${n} object${n !== 1 ? "s" : ""} that drifted out ` +
                 "of reach - turn off in Settings");
      this.culledTotal = 0;
    }
  }

  private cullCooldown = 0.0;
  private culledTotal = 0;

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
      world.performance = this.perfMode; // every stepping path, no exceptions
      world.step(dt);
      return true;
    } catch {
      if (world.diverged.length === 0) world.diverged.push("a body");
      return false;
    }
  }

  /** Path spacing (world units) for the sub-step trail samples the adaptive
   * integrator captures, or 0 when trails are off. Half a pixel at the
   * current zoom, matching what recordTrails asks of the bodies. */
  private syncTraceSpacing(): void {
    this.world.traceSpacing = this.view.trails ? 0.5 / this.camera.zoom : 0.0;
  }

  stepOnce(): void {
    this.ensureInitial();
    this.playing = false;
    // Frame-stepping is what you do to study a close encounter, so it needs
    // the same in-slice path capture as playing does; this used to be set
    // only on the playing path, so single-stepping through an encounter
    // drew the trail as a step-to-step corner (or, in a scene that had
    // never been played, not at all).
    this.syncTraceSpacing();
    // One 60 Hz frame, run through the SAME path as play: same quantum
    // count, same adaptive subdivision. Stepping used to take two flat
    // PHYSICS_DT steps, so frame-stepping through a close encounter - the
    // exact thing anyone steps frame by frame to study - integrated more
    // coarsely than just watching it, and the two disagreed.
    for (let q = 0; q < 2; q++) {
      const n = this.pickResolution(PHYSICS_DT);
      const h = PHYSICS_DT / n;
      for (let i = 0; i < n; i++) {
        this.safeStep(this.world, h);
        this.recordTrails();
      }
    }
    this.afterPhysics();
  }

  /** Rewind the simulation by one displayed frame (,). */
  stepBack(): void {
    this.playing = false;
    let world = this.history.back();
    if (world === null) {
      if (this.initialSnapshot === null) return;
      this.clearHistory();
      world = snap.restore(this.initialSnapshot);
    }
    this.frameSeq++; // the world is about to be swapped: drop cached energy
    const selIds = new Set(this.selection
      .filter((o): o is Body => o instanceof Body).map((o) => o.id));
    this.world = world;
    this.controller.hover = null;
    // a rewind swaps the world just as much as a load does, so the same
    // in-progress gestures have to go with it (see resetInteraction)
    this.controller.resetInteraction();
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
    // keepInitial: resetting must not consume the thing it resets TO.
    // Without it the second Ctrl+R in a row did nothing at all (no toast,
    // no feedback) and the dE readout went blank until the next play.
    this.replaceWorld(snap.restore(this.initialSnapshot), true);
    this.playing = false;
    this.toast("Reset to the initial state");
  }

  /** Simulate the scene to `text` seconds.
   *
   * Two things decide how this behaves, and they interact:
   *
   * WHERE IT STARTS. A target ahead of the clock is reached by continuing
   * from the CURRENT state; only a target behind it has to go back to the
   * start snapshot and re-simulate, because the solver cannot run
   * backwards. The result is identical either way - the step sequence is
   * the same fixed PHYSICS_DT either way, so 0->10 then 10->20 lands
   * exactly where 0->20 does - but continuing does not redo work already
   * done, and, crucially, it is what makes an interrupted jump RESUMABLE.
   *
   * Restarting from t = 0 every time was the old behaviour and it hid a
   * trap: a target too far to reach in one go left the clock wherever the
   * budget ran out, and asking again re-ran the same bounded work from the
   * same start and stopped at the same place. The jump appeared to do
   * nothing at all from the second attempt onward, however many times it
   * was asked.
   *
   * HOW LONG IT MAY RUN. The jump is synchronous - there is no partial
   * world to show and nothing useful to draw halfway - so the tab is
   * unresponsive throughout. A step cap alone does not bound that: 20 000
   * steps is 2.6 s frozen on the Trampoline and 6.4 s on the Jelly block on
   * a desktop, and several times that on a phone, which is long enough for
   * the browser to offer to kill the page. So the work is bounded in
   * WALL-CLOCK time too, and falling short is reported rather than implied,
   * with the fact that asking again continues.
   */
  commitTimeJump(text: string): boolean {
    const target = parseFloat(text);
    if (!Number.isFinite(target) || target < 0) return false;
    this.ensureInitial();
    // Work on a copy either way, so a blow-up part-way through cannot leave
    // the live scene half-stepped.
    const forward = target >= this.world.time;
    const world = snap.restore(forward ? snap.snapshot(this.world)
                                       : this.initialSnapshot!);
    const steps = Math.round((target - world.time) / PHYSICS_DT);
    if (steps <= 0) return true;
    const t0 = performance.now();
    let ran = 0;
    let blewUp = false;
    for (; ran < steps && ran < App.TIME_JUMP_MAX_STEPS; ran++) {
      if (!this.safeStep(world, PHYSICS_DT)) {
        blewUp = true;
        break;
      }
      // the clock is only read every 64th step: at ~0.1 ms a step that is
      // a check every 6 ms, far finer than the budget, for no measurable cost
      if ((ran & 63) === 63 &&
          performance.now() - t0 > App.TIME_JUMP_BUDGET_MS) {
        ran++;
        break;
      }
    }
    this.replaceWorld(world, true);
    this.playing = false;
    if (blewUp) {
      this.toast(`Stopped at ${world.time.toFixed(2)} s - the scene blew up`);
    } else if (ran < steps) {
      // "enter it again", not "press Enter again": the box refreshes to the
      // time actually reached, so the target has to be typed afresh
      this.toast(`Reached ${world.time.toFixed(2)} s of ${target.toFixed(2)} s ` +
                 "- enter that time again to carry on from here");
    }
    return true;
  }

  /** Wall-clock ceiling on one time jump. The tab is frozen for this long,
   * so it trades responsiveness against how far a single press gets: an
   * interrupted jump now resumes, so the ceiling costs presses rather than
   * reach. */
  private static TIME_JUMP_BUDGET_MS = 3000;

  /** Hard ceiling on a time jump's steps, on top of the wall-clock budget:
   * a cheap scene must not be able to buy an unbounded jump either. */
  private static TIME_JUMP_MAX_STEPS = 20000;

  replaceWorld(world: World, keepInitial = false): void {
    this.world = world;
    // any world swap (undo, reset, clear, load) disarms the soft-body drag
    // hint; loadPreset re-arms it afterwards only for soft-body presets, so
    // clearing the scene can never surface it
    this.softBodyHintArmed = false;
    this.setSelection([]);
    this.controller.hover = null;
    // resetInteraction, not abortDrag: a half-made link holds a BODY from
    // the world being replaced, so finishing it afterwards wired the new
    // world to an object that is not in it (see resetInteraction).
    this.controller.resetInteraction();
    this.trails.clear();
    this.energySeries.clear();
    this.momentumSeries.clear();
    this.phasePlot.clear();
    this.clearHistory();
    this.frameSeq++; // new world: any cached energy belongs to the old one
    if (!keepInitial) {
      this.initialSnapshot = null;
      this.baselineEnergy = null;
      // A world that is already at t = 0 IS a start state, so adopt it
      // immediately rather than waiting for the next play. Undoing back to
      // the beginning otherwise left Ctrl+R inert and the dE readout blank.
      if (world.time === 0.0) this.ensureInitial();
    }
    // an open graph should show the new world's state straight away (the
    // sampling throttle is reset - the old world's clock is meaningless)
    this.lastGraphSampleT = -Infinity;
    if (this.graphMode !== "Off") this.recordGraphSample();
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
    // view toggles follow the preset, so a scene always loads looking the
    // way it is meant to be read (vectors are symmetric with trails: a
    // preset that does not ask for them turns them off)
    this.view.trails = hints.trails ?? false;
    this.view.autoFit = hints.autoFit ?? false;
    this.view.velVectors = hints.vectors ?? false;
    if (hints.graph) {
      const mode = { energy: "Energy", momentum: "Mom.", phase: "Phase" }[hints.graph];
      this.setGraphMode(mode as GraphMode);
    }
    this.framePreset(hints.zoom, hints.centre);
    this.ensureInitial();
    // arm the one-time "right-drag a soft body" hint for soft-body scenes
    this.softBodyHintArmed = this.world.bodies.some((b) => b.softBody);
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

  quickSave(): void {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `Scene ${now.getFullYear()}-${pad(now.getMonth() + 1)}-` +
      `${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}` +
      `${pad(now.getSeconds())}`;
    try {
      const saved = snap.saveScene(this.world, name);
      this.toast(`Saved scene '${saved}' - press L to browse scenes`);
    } catch (exc) {
      this.toast(exc instanceof snap.SceneSaveError ? exc.message
                                                    : "Could not save the scene");
    }
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
    this.speed = Math.min(16.0, Math.max(0.01, this.speed * factor));
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
    // seed the plot with the current state so it draws immediately, even
    // before the simulation is started
    if (mode !== "Off") this.recordGraphSample();
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

  /** `world.energy()` for the current frame, computed at most once.
   *
   * It is O(n^2) under mutual gravity and had two callers per frame - the
   * graph sampler and the status-bar drift readout - so an N-body scene
   * paid for it twice. The cache is scoped to one animation frame, and
   * everything that can change the energy (a step, an inspector edit)
   * happens between frames, so a reader can never see a stale value. */
  private energyFrame = -1;
  private energyCached: { ke: number; pe: number; total: number } | null = null;

  energyNow(): { ke: number; pe: number; total: number } {
    if (this.energyCached === null || this.energyFrame !== this.frameSeq) {
      this.energyFrame = this.frameSeq;
      this.energyCached = this.world.energy();
    }
    return this.energyCached;
  }

  private frameSeq = 0;

  energyDriftText(): string {
    if (this.baselineEnergy === null) return "";
    const e = this.energyNow().total;
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
      this.frameSeq++; // invalidates the per-frame energy cache
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
    if (this.playing) {
      // Below 1x, keep stepping at the normal 120 Hz real-time rate but
      // with a proportionally smaller dt: slow motion then produces a
      // fresh state every frame (glassy smooth, and *more* accurate)
      // instead of one full-size step every few frames (choppy).
      const effDt = PHYSICS_DT * Math.min(this.speed, 1.0);
      this.syncTraceSpacing();
      // Clamp the catch-up so a slow frame cannot buy itself more work than
      // it can afford (see MAX_CATCHUP_FRAMES). Measured against the frame
      // the display is actually delivering, floored at 60 Hz so a fast
      // display is not held to its own short frame.
      const nominal = Math.max(dtFrame, 1 / 60);
      this.accumulator = Math.min(this.accumulator + dtFrame * this.speed,
                                  nominal * this.speed * MAX_CATCHUP_FRAMES);
      let quanta = 0;
      let qUsed = 1;
      const t0 = performance.now();
      while (this.accumulator >= effDt && quanta < MAX_STEPS_PER_FRAME) {
        // resolution is re-chosen per quantum from the freshest
        // accelerations, so a close encounter that flares up mid-frame
        // is caught within 1/120 s
        const q = this.pickResolution(effDt);
        if (q > qUsed) qUsed = q;
        const h = effDt / q;
        for (let i = 0; i < q; i++) {
          this.safeStep(this.world, h);
          this.recordTrails();
        }
        this.accumulator -= effDt;
        quanta++;
        if (performance.now() - t0 > PHYSICS_BUDGET_S * 1000) {
          break; // frame-time ceiling: stay responsive, dilate time
        }
      }
      this.qNow = qUsed;
      this.overloaded = this.accumulator >= effDt;
      if (this.overloaded) this.accumulator = 0.0;
      this.checkSustainedOverload();
      this.cullEscaped();
      this.afterPhysics();
      const nowS = performance.now() / 1000;
      if (this.world.diverged.length > 0 && nowS > this.divergeCooldown) {
        this.divergeCooldown = nowS + 5.0;
        const names = this.world.diverged.slice(0, 3).join(", ");
        this.toast(`${names} hit a numerical blow-up and was frozen ` +
                   "- check extreme forces or fields");
      }
    }

    // A camera that glides is decoration on top of the simulation, and
    // glide is exactly what a viewer asking for reduced motion is asking
    // not to have. Snapping still tracks the scene perfectly; it just
    // arrives immediately. The simulation itself is untouched - it is the
    // content, and freezing it would leave nothing to look at.
    const instant = reducedMotion();
    if (this.view.autoFit) {
      const target = this.fitTarget();
      if (target !== null) {
        const cam = this.camera;
        // the user may zoom OUT below the fit level (ratio < 1); auto-fit
        // then keeps tracking at that wider framing and never zooms back
        // in on its own
        const desired = target[2] * this.autofitRatio;
        const rate = desired < cam.zoom ? 10.0 : 3.0;
        const k = instant ? 1.0 : Math.min(1.0, dtFrame * rate);
        cam.zoom *= (desired / cam.zoom) ** k;
        const blend = instant ? 1.0 : Math.min(1.0, dtFrame * 10.0);
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
        const blend = instant ? 1.0 : Math.min(1.0, dtFrame * 8.0);
        cam.centre.x += (body.pos.x - cam.centre.x) * blend;
        cam.centre.y += (body.pos.y - cam.centre.y) * blend;
      }
    }
  }

  /** How finely to subdivide this quantum: how many extra, smaller
   * physics steps to run in place of each normal one.
   *
   * This is a function of the simulation state ALONE - never of frame
   * timing or measured cost. The step size decides the numerical answer,
   * so letting the machine's load pick it made a scene integrate
   * differently from run to run: the same setup, reset and replayed,
   * could ring on one attempt and sit still on the next.
   *
   * Performance is handled without touching the physics: a frame that
   * runs out of budget simply advances less simulated time (the
   * MAX_STEPS_PER_FRAME / PHYSICS_BUDGET_S ceilings in update()), so a
   * slow machine runs the same simulation slower rather than a different
   * simulation at speed. */
  private pickResolution(effDt: number): number {
    // Performance mode gives up adaptive resolution outright. It is the
    // largest single multiplier in the engine - it reached 16x on the
    // Trampoline - and resolving a trajectory finely is exactly the accuracy
    // this mode exists to stop paying for.
    if (!this.adaptiveDt || this.perfMode) return 1;
    return this.world.subdivisionNeed(effDt, 16);
  }

  /** Why the app cannot hold real time, or null when it can.
   *
   * The warning used to say "physics can't keep up - reduce substeps or
   * bodies" for every cause, which is actively misleading when the constraint
   * is DRAWING: a 300-spring soft body costs about a millisecond of solver
   * and far more than that in draw calls, and telling someone to cut
   * substeps sends them to fix the half that was already fast. Rendering
   * being the bottleneck is also the whole reason the same scene behaves
   * differently between a small window and a maximised one.
   */
  slowReason(): "physics" | "render" | null {
    if (!this.playing) return null;
    // Render-bound: the frame is genuinely bad AND drawing owns most of it.
    // Judged against a 40 Hz frame so an ordinary 50 Hz display, or a single
    // hitch, never trips it.
    const frameMs = this.fpsNow > 1 ? 1000 / this.fpsNow : 0;
    if (frameMs > 25 && this.renderMs > 0.5 * frameMs) return "render";
    // Physics-bound: the accumulator could not be drained inside the
    // wall-clock budget even with the catch-up clamped.
    return this.overloaded ? "physics" : null;
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
    const now = this.world.time;
    const threshold = 0.5 / this.camera.zoom;
    const trailFor = (bid: number): Trail => {
      let t = this.trails.get(bid);
      if (t === undefined) {
        t = new Trail(maxlen);
        this.trails.set(bid, t);
      } else if (t.capacity !== maxlen) {
        t.setCapacity(maxlen); // the user changed Trail length
      }
      // stepping back / re-simulating leaves points stamped in the
      // future; they would never expire and would draw a path the body
      // has not taken yet, so drop them
      if (t.count > 0 && t.time(t.count - 1) > now + 1e-9) t.clear();
      return t;
    };
    // sub-step path samples captured inside the adaptive integrator
    // (close encounters turn around within a single step)
    if (this.world.trace.length > 0) {
      for (const [bid, x, y] of this.world.trace) trailFor(bid).push(x, y, now);
      this.world.trace.length = 0;
    }
    for (const b of this.world.bodies) {
      if (b.locked) continue;
      const t = trailFor(b.id);
      const n = t.count;
      if (n === 0 ||
          Math.abs(t.x(n - 1) - b.pos.x) + Math.abs(t.y(n - 1) - b.pos.y) > threshold) {
        t.push(b.pos.x, b.pos.y, now);
      }
    }
  }

  /** Age out trail points and drop the trails of bodies that no longer
   * exist.
   *
   * Split out of recordTrails and run once per displayed frame rather than
   * once per physics step. Recording has to happen every step - that is
   * what makes an adaptively subdivided close encounter draw as a smooth
   * curve - but the housekeeping does not, and a frame can contain up to
   * MAX_STEPS_PER_FRAME x the subdivision factor of those steps. Doing a
   * live-set build and a full scan of the trail map inside that loop cost
   * a thousandfold what it needed to at high speed multipliers.
   *
   * Ids are never reused, so without the sweep the map grows for the whole
   * session: every culled runaway, every erased body and every duplicate
   * would leave its buffers behind - a steady leak of megabytes in a
   * debris-heavy scene. */
  private sweepTrails(): void {
    if (!this.view.trails || this.trails.size === 0) return;
    // The trail is a window on the last trailLen x PHYSICS_DT seconds of
    // SIMULATED time, so it decays even while a body sits still (a
    // stationary body used to keep a frozen line forever) and covers the
    // same amount of motion whatever the speed multiplier. trailLen stays
    // the hard memory and drawing bound.
    const cutoff = this.world.time - this.view.trailLen * PHYSICS_DT;
    const live = this.trailLive;
    live.clear();
    for (const b of this.world.bodies) {
      if (!b.locked) live.add(b.id);
    }
    for (const [bid, t] of this.trails) {
      if (live.has(bid)) t.expireBefore(cutoff);
      else this.trails.delete(bid);
    }
  }

  private trailLive = new Set<number>();

  private afterPhysics(): void {
    // the world just moved, so anything cached against the old state is
    // stale - including a single-step (`.`) outside the animation frame
    this.frameSeq++;
    this.sweepTrails();
    // rolling per-frame history so the user can step backwards (,)
    this.history.push(this.world);
    this.recordGraphSample();
  }

  private clearHistory(): void {
    this.history.clear();
  }

  private lastGraphSampleT = -Infinity;

  /** Sample the current state into every graph series. Runs after each
   * physics frame, and immediately when a graph is enabled or the world
   * changes, so an opened graph shows data from the very first frame
   * instead of waiting for the simulation to produce a backlog. */
  recordGraphSample(): void {
    // Cap the cadence in SIM time: the window shows GRAPH_WINDOW_S seconds
    // in at most GRAPH_MAX_POINTS samples, so anything finer is sub-pixel.
    // This bounds both the sampling cost (energy() is O(n^2) with mutual
    // gravity) and the number of vertices stroked per frame, independent
    // of the display's refresh rate. Backward jumps (rewind/reset) always
    // sample so the throttle can never go quiet after a rewind.
    const minDt = GRAPH_WINDOW_S / GRAPH_MAX_POINTS;
    const dt = this.world.time - this.lastGraphSampleT;
    if (dt >= 0 && dt < minDt) return;
    this.lastGraphSampleT = this.world.time;
    // every series records continuously whatever the dock shows, so
    // switching graph views never leaves gaps in the data
    const e = this.energyNow();
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
  /** Nudge the trail vertex budget toward whatever this machine can hold.
   *
   * Climbs slowly and falls fast: overshooting costs dropped frames, while
   * undershooting only costs a little smoothness for a few frames more.
   * Only runs while trails are actually drawn, so the factor cannot drift
   * up to its ceiling during a cheap frame and then blow the first frame
   * after they are switched on. */
  private tuneTrailQuality(): void {
    if (!this.view.trails) return;
    const target = App.RENDER_TARGET_MS;
    if (this.renderMs < target * 0.6) {
      this.trailQuality = Math.min(App.TRAIL_QUALITY_MAX, this.trailQuality * 1.04);
    } else if (this.renderMs > target) {
      this.trailQuality = Math.max(App.TRAIL_QUALITY_MIN, this.trailQuality * 0.85);
    }
  }

  private render(): void {
    const t0 = performance.now();
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.camera.screenW;
    const h = this.camera.screenH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css(theme.BG);
    ctx.fillRect(0, 0, w, h);
    if (this.view.grid) drawGrid(ctx, this.camera, w, h);
    drawWorld(ctx, this.camera, this.world, this.view, this.selection,
              this.controller.hover, this.trails, w, h, this.trailQuality,
              this.perfMode);
    this.controller.drawOverlays(ctx);
    drawScaleBar(ctx, this.camera, w, h);
    this.renderMs = 0.85 * this.renderMs + 0.15 * (performance.now() - t0);
    this.tuneTrailQuality();
  }
}

export { PRESETS };
