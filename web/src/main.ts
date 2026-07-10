/** Entry point: builds the App, panels and overlays, wires keyboard
 * shortcuts and toasts, and starts the main loop. */
import "./style.css";
import { App, PRESETS } from "./app";
import { GraphMode } from "./app";
import { TOOL_KEYS } from "./interact/tools";
import { Inspector } from "./ui/inspector";
import { Library, Help } from "./ui/overlays";
import { GraphDock, HintBar, Palette, Toolbar, overlayToggles } from "./ui/panels";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const canvas = $("canvas") as HTMLCanvasElement;
const app = new App(canvas);

// ------------------------------------------------------------------- toasts
const toastsEl = $("toasts");
app.toastFn = (msg: string) => {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
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
overlayToggles["library"] = () => library.toggle();
overlayToggles["help"] = () => help.toggle();

const runningDot = $("running-dot");
const overloadEl = $("overload-warning");
app.panels = [toolbar, palette, inspector, dock, hintbar, {
  refresh() {
    runningDot.hidden = !app.playing;
    overloadEl.hidden = !(app.overloaded && app.playing);
  },
}];

// --------------------------------------------------------------- keyboard
document.addEventListener("keydown", (e) => {
  // let form fields keep their keys (widgets stopPropagation, but be safe)
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

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
  if (library.visible || help.visible) {
    if (e.key === "Escape" || key === "l" || e.key === "F1") {
      library.close();
      help.close();
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
    case "ArrowUp":
      app.nudgeSelection(0, 1);
      break;
    case "ArrowDown":
      app.nudgeSelection(0, -1);
      break;
    case "ArrowLeft":
      app.nudgeSelection(-1, 0);
      break;
    case "ArrowRight":
      app.nudgeSelection(1, 0);
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

// ------------------------------------------------------------------- start
app.loadPreset(PRESETS[0], false);
app.start();
app.toast("Welcome! Press L for the library, F1 for help.");

// dev-only hook for driving the app from tests/tooling
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__mechanica =
    { app, library, help, inspector };
}
