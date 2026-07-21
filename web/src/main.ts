/** Entry point: builds the App, panels and overlays, wires keyboard
 * shortcuts and toasts, and starts the main loop. */
import "./style.css";
import { App, PRESETS } from "./app";
import { GraphMode } from "./app";
import { TOOL_KEYS } from "./interact/tools";
import { Inspector } from "./ui/inspector";
import { FormulaGuide } from "./ui/guide";
import { Help, Library, SettingsPanel } from "./ui/overlays";
import { GraphDock, HintBar, Palette, Toolbar, overlayToggles } from "./ui/panels";

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
const help = new Help($("help"));
const settingsPanel = new SettingsPanel(app, $("settings"), () => help.open());
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
document.addEventListener("keydown", (e) => {
  // let form fields keep their keys (widgets stopPropagation, but be safe)
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
      target.tagName === "MATH-FIELD") return;

  const key = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (key === "z") {
      e.shiftKey ? app.redo() : app.undo();
    } else if (key === "y") {
      app.redo();
    } else if (key === "d") {
      app.controller.duplicateSelection();
    } else if (key === "r") {
      app.resetSim();
    } else if (key === "c") {
      app.copyProps();
    } else if (key === "v") {
      app.pasteProps();
    } else if (key === "s") {
      app.quickSave();
    } else {
      return;
    }
    e.preventDefault();
    return;
  }

  // overlays swallow everything except their own close keys
  if (library.visible || help.visible || settingsPanel.visible ||
      formulaGuide.visible) {
    if (e.key === "Escape" || key === "l" || e.key === "F1") {
      library.close();
      help.close();
      settingsPanel.close();
      formulaGuide.close();
      e.preventDefault();
    }
    return;
  }

  switch (e.key) {
    case " ":
      app.togglePlay();
      break;
    case ".":
      app.stepOnce();
      break;
    case ",":
      app.stepBack();
      break;
    case "Delete":
    case "Backspace":
      app.controller.deleteSelection();
      break;
    case "Escape":
      // cancel an in-progress link/wall first, then clear the selection
      if (!app.controller.cancelPending()) app.setSelection([]);
      break;
    case "Tab":
      inspector.toggleCollapsed();
      break;
    case "F1":
      help.toggle();
      break;
    case "ArrowLeft":
      app.stepBack();
      break;
    case "ArrowRight":
      app.stepOnce();
      break;
    default: {
      if (key in TOOL_KEYS && key !== "d" && key !== "c") {
        // d/c only reach here when not a tool key; TOOL_KEYS has neither
        app.controller.setTool(TOOL_KEYS[key]);
      } else if (key === "n") {
        app.view.snap = !app.view.snap;
        app.toast(`Snap to grid ${app.view.snap ? "on" : "off"}`);
      } else if (key === "t") {
        app.setTrails(!app.view.trails);
      } else if (key === "g") {
        app.view.spatialGrid = !app.view.spatialGrid;
      } else if (key === "f") {
        if (e.shiftKey) app.toggleAutoFit();
        else app.zoomToFit();
      } else if (key === "d") {
        app.view.velVectors = !app.view.velVectors;
        app.toast(`Velocity vectors ${app.view.velVectors ? "on" : "off"}`);
      } else if (key === "k") {
        app.toggleLockSelection();
      } else if (key === "1") {
        app.toggleGraph("Energy" as GraphMode);
      } else if (key === "2") {
        app.toggleGraph("Mom." as GraphMode);
      } else if (key === "3") {
        app.toggleGraph("Phase" as GraphMode);
      } else if (key === "-") {
        app.bumpSpeed(0.5);
      } else if (key === "=" || key === "+") {
        app.bumpSpeed(2.0);
      } else if (key === "0") {
        app.resetSpeed();
      } else if (key === "c") {
        app.toggleFollow();
      } else if (key === "l") {
        library.toggle();
      } else {
        return;
      }
    }
  }
  e.preventDefault();
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
app.toast("Welcome! Press L for the library, F1 for help.");

// dev-only hook for driving the app from tests/tooling
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__mechanica =
    { app, library, help, inspector };
}
