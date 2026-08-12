/** The global keyboard map.
 *
 * Lifted out of main.ts so it can be exercised directly. It was previously a
 * closure inside the entry point, reachable only by constructing the entire
 * app against a real DOM, so nothing tested it - and a regression that made
 * Space unusable on every focused button in the app went unnoticed by the
 * whole suite. What it needs from the app is small and stated in
 * `ShortcutHost`, so the handler can be driven with a stub.
 */
import type { App, GraphMode } from "../app";
import { TOOL_KEYS } from "../interact/tools";

/** An overlay the keyboard has to yield to while it is open. */
export interface Dismissable {
  visible: boolean;
  close(): void;
}

/** Everything the key map touches beyond the app itself. */
export interface ShortcutHost {
  app: App;
  /** The tour owns the keyboard outright while it is up. */
  tour: { visible: boolean };
  /** Modal overlays: while any is open, only the close keys do anything. */
  overlays: Dismissable[];
  toggleLibrary(): void;
  toggleHelp(): void;
  toggleInspector(): void;
}

/** Elements that own the keys they are given and must not be shadowed.
 *
 * `target` is whatever the event carried, which is NOT guaranteed to be an
 * element: a keydown dispatched on `document` itself (automation, an
 * extension, a future refactor that listens somewhere else) hands over the
 * Document, which has no `getAttribute`. Calling it there threw inside the
 * listener - where the browser swallows the exception - so the shortcut was
 * dropped, every shortcut, silently, with nothing in the console. Optional
 * calls make an unusual target simply "not an element that owns keys",
 * which is the right answer for one. */
function ownsKey(target: EventTarget | null | undefined, key: string): boolean {
  // `!target` rather than `=== null`: an event object built by hand (a test,
  // a polyfill, a synthetic dispatch) can carry `undefined` just as easily
  // as `null`, and only one of those was being caught.
  if (!target) return false;
  const el = target as { tagName?: string;
                         getAttribute?: (name: string) => string | null };
  const tag = el.tagName;
  // text entry of every kind keeps all of its keys
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "MATH-FIELD" ||
      tag === "SELECT") {
    return true;
  }
  // A focused button owns Space and Enter: they are how the browser activates
  // it. Without this the global handler took Space, played or paused, and
  // preventDefault'd the activation - so no button in the app could be
  // pressed from the keyboard at all, which quietly undid the whole point of
  // freeing Tab. A mouse click still blurs the button (see main.ts), so Space
  // keeps working as play/pause for anyone who is not tabbing through the
  // controls.
  if ((tag === "BUTTON" || el.getAttribute?.("role") === "button") &&
      (key === " " || key === "Enter")) {
    return true;
  }
  return false;
}

/** Handle one keydown. Returns true if the key was consumed (the caller has
 * already had preventDefault called on the event in that case). */
export function handleShortcut(e: KeyboardEvent, host: ShortcutHost): boolean {
  const { app } = host;
  if (ownsKey(e.target, e.key)) return false;

  const key = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (key === "z") {
      if (e.shiftKey) app.redo();
      else app.undo();
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
      return false;
    }
    e.preventDefault();
    return true;
  }

  // the tour owns the keyboard while it is up (it handles Esc and the
  // arrows itself, in the capture phase); nothing else should also fire
  if (host.tour.visible) return false;

  // overlays swallow everything except their own close keys
  if (host.overlays.some((o) => o.visible)) {
    if (e.key === "Escape" || key === "l" || e.key === "F1") {
      for (const o of host.overlays) o.close();
      e.preventDefault();
      return true;
    }
    return false;
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
    // NOT Tab. Binding Tab here (and preventing its default) meant focus
    // could never leave the document body, so nothing in the app was
    // reachable by keyboard at all - no tool button, no checkbox, no
    // slider. Backslash is unclaimed and adjacent to the same hand.
    case "\\":
      host.toggleInspector();
      break;
    case "F1":
      host.toggleHelp();
      break;
    case "ArrowLeft":
      app.stepBack();
      break;
    case "ArrowRight":
      app.stepOnce();
      break;
    default: {
      if (key in TOOL_KEYS) { // TOOL_KEYS deliberately contains neither d nor c
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
      } else if (key === "4") {
        app.toggleGraph("Drift" as GraphMode);
      } else if (key === "-") {
        app.bumpSpeed(0.5);
      } else if (key === "=" || key === "+") {
        app.bumpSpeed(2.0);
      } else if (key === "0") {
        app.resetSpeed();
      } else if (key === "c") {
        app.toggleFollow();
      } else if (key === "l") {
        host.toggleLibrary();
      } else {
        return false;
      }
    }
  }
  e.preventDefault();
  return true;
}
