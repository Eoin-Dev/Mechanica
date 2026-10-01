/** Entry point: builds the App, panels and overlays, wires keyboard
 * shortcuts and toasts, and starts the main loop. */
import "./style.css";
import { App, PRESETS } from "./app";
import { Vec2 } from "./core/vec";
import { Body } from "./engine/body";
import { World } from "./engine/world";
import { Preset, gasWorld } from "./scene/presets";
import { TabRecovery } from "./scene/recovery";
import { snapshot } from "./scene/snapshot";
import { Inspector } from "./ui/inspector";
import { FormulaGuide } from "./ui/guide";
import { GraphDataDialog } from "./ui/graph-data";
import { Help, Library, SettingsPanel } from "./ui/overlays";
import { GraphDock, HintBar, Palette, Toolbar, overlayToggles } from "./ui/panels";
import { handleShortcut } from "./ui/shortcuts";
import { Tour } from "./ui/tour";
import { Toasts } from "./ui/toasts";
import { OverloadNotice } from "./ui/overload";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const canvas = $("canvas") as HTMLCanvasElement;
const app = new App(canvas);
// dev-only console handle, e.g. for driving the app when the tab is
// backgrounded and requestAnimationFrame is suspended
if (import.meta.env.DEV) (window as unknown as { __mech: App }).__mech = app;

// ------------------------------------------------------------------- toasts
const toasts = new Toasts($("toasts"));
app.toastFn = (message) => toasts.show(message);

// ------------------------------------------------------------------- panels
const toolbar = new Toolbar(app, $("toolbar"));
const palette = new Palette(app, $("palette"));
const inspector = new Inspector(app, $("inspector"), $("inspector-splitter"));
const dock = new GraphDock(app, $("dock"), $("dock-splitter"));
const hintbar = new HintBar(app, $("hint-text"), $("status-text"));
const library = new Library(app, $("library"));
const tour = new Tour(app);
const help = new Help($("help"), () => tour.start());
const settingsPanel = new SettingsPanel(app, $("settings"), () => help.open(),
                                        () => tour.start());
const formulaGuide = new FormulaGuide(app, $("formula-guide"));
const graphData = new GraphDataDialog(app, $("graph-data"));
overlayToggles["library"] = () => library.toggle();
overlayToggles["help"] = () => help.toggle();
overlayToggles["settings"] = () => settingsPanel.toggle();
overlayToggles["formula-guide"] = () => formulaGuide.toggle();
overlayToggles["graph-data"] = () => graphData.open();

app.panels = [toolbar, palette, inspector, dock, hintbar,
  new OverloadNotice(app, $("overload-warning"))];

// A mouse-clicked button keeps focus, so the next global shortcut key flips
// the browser's :focus-visible heuristic into "keyboard mode" and paints a
// stray outline on whatever was last clicked. It also means the next Space
// re-toggles that control (a focused checkbox) or is swallowed by it (a
// focused slider) instead of playing/pausing. Drop focus after a mouse click
// (detail >= 1) on any non-text control to prevent both; keyboard activation
// (Enter/Space, detail 0) keeps its focus ring so Tab navigation stays
// visible, and text fields are left alone so typing (and Space) still works.
document.addEventListener("click", (e) => {
  if (e.detail === 0) return; // keyboard-triggered click: leave focus alone
  const el = (e.target as Element | null)?.closest?.(
    "button, input[type=checkbox], input[type=range]");
  if (el instanceof HTMLElement) el.blur();
});

// --------------------------------------------------------------- keyboard
// The map itself lives in ui/shortcuts.ts so it can be tested without
// standing up the whole app against a real DOM.
document.addEventListener("keydown", (e) => {
  // The simulation and graph canvases own the application's zoom. Suppress
  // the browser page-zoom shortcuts before shortcut dispatch so Ctrl/Cmd +,
  // -, and 0 cannot change the CSS/input coordinate system underneath them.
  if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "_", "0"].includes(e.key)) {
    e.preventDefault();
    return;
  }
  handleShortcut(e, {
    app,
    tour,
    overlays: [library, help, settingsPanel, formulaGuide, graphData],
    toggleLibrary: () => library.toggle(),
    toggleHelp: () => help.toggle(),
    toggleInspector: () => inspector.toggleCollapsed(),
  });
});

// Trackpad pinch is delivered as a modified wheel in Chromium/Firefox and as
// gesture events in Safari. Neither may page-zoom the application; ordinary
// wheel/pinch input over the simulation and graph remains locally handled by
// those canvases.
document.addEventListener("wheel", (e) => {
  if (e.ctrlKey || e.metaKey) e.preventDefault();
}, { passive: false });
const suppressPageGesture = (e: Event): void => e.preventDefault();
document.addEventListener("gesturestart", suppressPageGesture, { passive: false });
document.addEventListener("gesturechange", suppressPageGesture, { passive: false });

// ---------------------------------------------------------------- resizing
const resize = () => app.resizeCanvas();
new ResizeObserver(resize).observe($("canvas-wrap"));
window.addEventListener("resize", resize);
resize();

// ------------------------------------------------------------------- start
app.initializePreset(PRESETS.find((preset) => preset.name === "Earth & Moon") ?? PRESETS[0]);
const recovery = new TabRecovery(() => window.sessionStorage);
const recovered = recovery.read();
if (recovered.status === "loaded") {
  app.loadWorld(recovered.world, "previous tab", false);
} else if (recovered.status === "invalid" || recovered.status === "too-large") {
  app.toast("Could not restore the previous tab. Saved scenes are available in Library.");
}
let recoveryWarning = false;
const checkpoint = (state: string): void => {
  const status = recovery.write(state);
  if ((status === "unavailable" || status === "too-large") && !recoveryWarning) {
    recoveryWarning = true;
    app.toast(status === "too-large"
      ? "This scene is too large for tab recovery. Save or download it in Library."
      : "Tab recovery is unavailable. Save or download your scene in Library.");
  }
};
app.onSceneCheckpoint = checkpoint;
const checkpointLive = (): void => {
  try { checkpoint(snapshot(app.world)); }
  catch { /* Recovery must not interrupt the live simulation. */ }
};
setInterval(() => { if (app.playing) checkpointLive(); }, 5000);
window.addEventListener("pagehide", checkpointLive);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") checkpointLive();
});
app.start();
// First visit gets the guided tour instead of a toast that scrolls away
// before it has been read; afterwards, the toast is the reminder.
if (app.settings.tour_done === true) {
  app.toast(recovered.status === "loaded"
    ? "Previous tab restored and paused. Press Space to run, L to save."
    : "Welcome back! Press L for the library, F1 for help.");
} else {
  tour.maybeAutoStart();
}

// dev-only hook for driving the app from tests/tooling
if (import.meta.env.DEV) {
  const benchmark = {
    loadEmpty(): void {
      app.replaceWorld(new World());
    },
    loadSimpleCollision(): void {
      const world = new World();
      world.gravity = 0;
      const left = new Body(new Vec2(-1, 0), 0.25, 1);
      const right = new Body(new Vec2(1, 0), 0.25, 1);
      left.vel.x = 0.6;
      right.vel.x = -0.6;
      left.restitution = right.restitution = 1;
      world.bodies.push(left, right);
      app.replaceWorld(world);
    },
    loadPreset(name: string): void {
      const preset = PRESETS.find((candidate) => candidate.name === name);
      if (preset === undefined) throw new Error(`Unknown benchmark preset: ${name}`);
      app.loadPreset(preset, false);
    },
    loadGas(count: number): void {
      const n = Math.max(1, Math.min(2000, Math.round(count)));
      const half = Math.max(2, 6 * Math.sqrt(n / 200));
      const zoom = Math.max(14, Math.min(130, 540 / (2 * half)));
      app.loadPreset(new Preset(`Benchmark gas (${n})`, "Benchmark", "",
        () => gasWorld(n, half, 0x4d454348), { zoom }), false);
    },
    forcePerformanceLevel(level: number): void {
      if (!app.perfMode) app.setPerfMode(true);
      app.performanceLevel = Math.max(0, Math.min(3, Math.round(level)));
      app.world.performanceLevel = app.performanceLevel;
      app.invalidateEnergy();
      app.resizeCanvas();
      app.invalidateCanvas();
    },
    snapshot: () => app.performanceSnapshot(),
  };
  (window as unknown as Record<string, unknown>).__mechanica =
    { app, library, help, inspector, tour, settingsPanel, benchmark };
}
