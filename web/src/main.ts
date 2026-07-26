/** Entry point: builds the App, panels and overlays, wires keyboard
 * shortcuts and toasts, and starts the main loop. */
import "./style.css";
import { App, PRESETS } from "./app";
import { Inspector } from "./ui/inspector";
import { FormulaGuide } from "./ui/guide";
import { Help, Library, SettingsPanel } from "./ui/overlays";
import { GraphDock, HintBar, Palette, Toolbar, overlayToggles } from "./ui/panels";
import { handleShortcut } from "./ui/shortcuts";
import { Tour } from "./ui/tour";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const canvas = $("canvas") as HTMLCanvasElement;
const app = new App(canvas);
// dev-only console handle, e.g. for driving the app when the tab is
// backgrounded and requestAnimationFrame is suspended
if (import.meta.env.DEV) (window as unknown as { __mech: App }).__mech = app;

// ------------------------------------------------------------------- toasts
const toastsEl = $("toasts");
app.toastFn = (msg: string) => {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  t.title = msg; // hover reveals the full text if the toast is clipped
  toastsEl.append(t);
  while (toastsEl.children.length > 3) toastsEl.firstChild!.remove();
  setTimeout(() => {
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 320);
  }, 3200);
};

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
overlayToggles["library"] = () => library.toggle();
overlayToggles["help"] = () => help.toggle();
overlayToggles["settings"] = () => settingsPanel.toggle();
overlayToggles["formula-guide"] = () => formulaGuide.toggle();

const overloadEl = $("overload-warning");
app.panels = [toolbar, palette, inspector, dock, hintbar, {
  refresh() {
    overloadEl.hidden = !(app.overloaded && app.playing);
  },
}];

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
  handleShortcut(e, {
    app,
    tour,
    overlays: [library, help, settingsPanel, formulaGuide],
    toggleLibrary: () => library.toggle(),
    toggleHelp: () => help.toggle(),
    toggleInspector: () => inspector.toggleCollapsed(),
  });
});

// ---------------------------------------------------------------- resizing
const resize = () => app.resizeCanvas();
new ResizeObserver(resize).observe($("canvas-wrap"));
window.addEventListener("resize", resize);
resize();

// --------------------------------------------------------------- page zoom
// Zooming belongs to the simulation view and the graph, which handle their
// own wheel/pinch gestures. Anywhere else the browser's page zoom would
// scale the whole app - scrollbars, clipped panels, a canvas that no
// longer lines up with the pointer - so suppress every route into it
// outside those two surfaces.
const zoomable = (target: EventTarget | null): boolean => {
  const el = target instanceof Element ? target : null;
  return el !== null && el.closest("#canvas-wrap, #dock") !== null;
};
document.addEventListener("wheel", (e) => {
  if (e.ctrlKey && !zoomable(e.target)) e.preventDefault(); // trackpad pinch
}, { passive: false });
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("gesturechange", (e) => e.preventDefault());
document.addEventListener("keydown", (e) => {
  // Ctrl/Cmd +/-/0 page zoom
  if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "_", "0"].includes(e.key)) {
    e.preventDefault();
  }
}, { capture: true });

// ------------------------------------------------------------------- start
app.loadPreset(PRESETS[0], false);
app.start();
// First visit gets the guided tour instead of a toast that scrolls away
// before it has been read; afterwards, the toast is the reminder.
if (app.settings.tour_done === true) {
  app.toast("Welcome back! Press L for the library, F1 for help.");
} else {
  tour.maybeAutoStart();
}

// dev-only hook for driving the app from tests/tooling
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__mechanica =
    { app, library, help, inspector, tour, settingsPanel };
}
