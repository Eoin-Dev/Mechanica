/** The global keyboard map.
 *
 * Nothing tested this before, and the gap cost a real regression: the
 * handler swallowed Space on a focused button, so no button in the app could
 * be activated from the keyboard, and 339 passing tests said nothing about
 * it. The map is small, entirely decidable, and the surface a keyboard-only
 * user depends on, so it is checked key by key here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { TOOLS } from "../src/interact/tools";
import { Dismissable, ShortcutHost, handleShortcut } from "../src/ui/shortcuts";

/** Records what the map asked the app to do, without any of it happening. */
interface Log { calls: string[]; }

function stubApp(log: Log): App {
  const note = (name: string) => (...args: unknown[]) => {
    log.calls.push(args.length ? `${name}(${args.join(",")})` : name);
  };
  const view = { snap: false, trails: false, spatialGrid: false, velVectors: false };
  return {
    view,
    undo: note("undo"), redo: note("redo"), resetSim: note("resetSim"),
    copyProps: note("copyProps"), pasteProps: note("pasteProps"),
    quickSave: note("quickSave"), togglePlay: note("togglePlay"),
    stepOnce: note("stepOnce"), stepBack: note("stepBack"),
    setSelection: note("setSelection"), toast: () => {},
    setTrails: (v: boolean) => { view.trails = v; log.calls.push(`setTrails(${v})`); },
    toggleAutoFit: note("toggleAutoFit"), zoomToFit: note("zoomToFit"),
    toggleLockSelection: note("toggleLock"), toggleGraph: note("toggleGraph"),
    bumpSpeed: note("bumpSpeed"), resetSpeed: note("resetSpeed"),
    toggleFollow: note("toggleFollow"),
    controller: {
      duplicateSelection: note("duplicate"),
      deleteSelection: note("deleteSelection"),
      cancelPending: () => { log.calls.push("cancelPending"); return false; },
      setTool: note("setTool"),
    },
  } as unknown as App;
}

function overlay(): Dismissable {
  return { visible: false, close() { this.visible = false; } };
}

let log: Log;
let host: ShortcutHost;
let overlays: Dismissable[];

beforeEach(() => {
  log = { calls: [] };
  overlays = [overlay(), overlay()];
  host = {
    app: stubApp(log),
    tour: { visible: false },
    overlays,
    toggleLibrary: () => log.calls.push("toggleLibrary"),
    toggleHelp: () => log.calls.push("toggleHelp"),
    toggleInspector: () => log.calls.push("toggleInspector"),
  };
});

/** A keydown that records whether the map claimed its default. */
function press(key: string, opts: {
  ctrl?: boolean; meta?: boolean; shift?: boolean; tag?: string; role?: string;
} = {}): { consumed: boolean; prevented: boolean } {
  let prevented = false;
  const target = {
    tagName: opts.tag ?? "BODY",
    getAttribute: (n: string) => (n === "role" ? opts.role ?? null : null),
  };
  const e = {
    key,
    ctrlKey: opts.ctrl ?? false,
    metaKey: opts.meta ?? false,
    shiftKey: opts.shift ?? false,
    target,
    preventDefault() { prevented = true; },
  } as unknown as KeyboardEvent;
  const consumed = handleShortcut(e, host);
  return { consumed, prevented };
}

describe("focused controls keep the keys they own", () => {
  it("leaves Space and Enter to a focused button", () => {
    // the regression: the map played/paused and preventDefault'd the
    // activation, so no button in the app could be pressed from the keyboard
    for (const key of [" ", "Enter"]) {
      const r = press(key, { tag: "BUTTON" });
      expect(r.consumed, key).toBe(false);
      expect(r.prevented, key).toBe(false);
    }
    expect(log.calls).toEqual([]);
  });

  it("treats role=button the same as a real button", () => {
    const r = press(" ", { tag: "DIV", role: "button" });
    expect(r.consumed).toBe(false);
    expect(log.calls).toEqual([]);
  });

  it("still takes non-activation keys from a focused button", () => {
    // Tab must reach the browser, but a tool key on a focused button is
    // still a tool key - only Space and Enter activate
    press("v", { tag: "BUTTON" });
    expect(log.calls).toEqual(["setTool(select)"]);
  });

  it("leaves every key to text entry", () => {
    for (const tag of ["INPUT", "TEXTAREA", "MATH-FIELD", "SELECT"]) {
      for (const key of [" ", "v", "Delete", "Escape", "1"]) {
        expect(press(key, { tag }).consumed, `${tag}/${key}`).toBe(false);
      }
    }
    expect(log.calls).toEqual([]);
  });

  it("still plays and pauses when nothing is focused", () => {
    const r = press(" ");
    expect(r.consumed).toBe(true);
    expect(r.prevented).toBe(true);
    expect(log.calls).toEqual(["togglePlay"]);
  });
});

describe("edit shortcuts", () => {
  it.each([
    ["z", {}, "undo"],
    ["z", { shift: true }, "redo"],
    ["y", {}, "redo"],
    ["d", {}, "duplicate"],
    ["r", {}, "resetSim"],
    ["c", {}, "copyProps"],
    ["v", {}, "pasteProps"],
    ["s", {}, "quickSave"],
  ] as const)("Ctrl+%s%s runs %s", (key, mods, expected) => {
    const r = press(key, { ...mods, ctrl: true });
    expect(r.consumed).toBe(true);
    expect(log.calls).toEqual([expected]);
  });

  it("maps the Cmd variants identically (macOS)", () => {
    press("z", { meta: true });
    expect(log.calls).toEqual(["undo"]);
  });

  it("passes unclaimed Ctrl combinations through to the browser", () => {
    // Ctrl+A, Ctrl+F, Ctrl+P and friends stay the browser's
    for (const key of ["a", "f", "p", "t", "w", "k"]) {
      const r = press(key, { ctrl: true });
      expect(r.consumed, key).toBe(false);
      expect(r.prevented, key).toBe(false);
    }
    expect(log.calls).toEqual([]);
  });
});

describe("tool keys", () => {
  it.each([
    ["v", "select"], ["h", "pan"], ["b", "body"], ["a", "anchor"],
    ["w", "wall"], ["r", "rod"], ["e", "rope"], ["s", "spring"], ["x", "eraser"],
  ])("%s selects the %s tool", (key, tool) => {
    press(key);
    expect(log.calls).toEqual([`setTool(${tool})`]);
  });

  it("covers every tool the palette offers", () => {
    const reached = new Set<string>();
    for (const key of "abcdefghijklmnopqrstuvwxyz") {
      log.calls.length = 0;
      press(key);
      const m = /^setTool\((.+)\)$/.exec(log.calls[0] ?? "");
      if (m) reached.add(m[1]);
    }
    expect([...reached].sort()).toEqual([...TOOLS].sort());
  });

  it("is case-insensitive, so Shift or Caps Lock still works", () => {
    press("V");
    expect(log.calls).toEqual(["setTool(select)"]);
  });
});

describe("view and playback keys", () => {
  it.each([
    [".", "stepOnce"], [",", "stepBack"],
    ["ArrowRight", "stepOnce"], ["ArrowLeft", "stepBack"],
    ["Delete", "deleteSelection"], ["Backspace", "deleteSelection"],
    ["k", "toggleLock"], ["c", "toggleFollow"],
    ["0", "resetSpeed"], ["F1", "toggleHelp"], ["\\", "toggleInspector"],
    ["l", "toggleLibrary"],
  ])("%s runs %s", (key, expected) => {
    press(key);
    expect(log.calls).toEqual([expected]);
  });

  it("toggles the view flags it owns", () => {
    press("n");
    expect(host.app.view.snap).toBe(true);
    press("g");
    expect(host.app.view.spatialGrid).toBe(true);
    press("d");
    expect(host.app.view.velVectors).toBe(true);
    press("t");
    expect(log.calls).toContain("setTrails(true)");
  });

  it("splits zoom-to-fit from auto-fit on Shift", () => {
    press("f");
    expect(log.calls).toEqual(["zoomToFit"]);
    log.calls.length = 0;
    press("f", { shift: true });
    expect(log.calls).toEqual(["toggleAutoFit"]);
  });

  it("maps the three graph keys", () => {
    for (const [key, mode] of [["1", "Energy"], ["2", "Mom."], ["3", "Phase"]]) {
      log.calls.length = 0;
      press(key);
      expect(log.calls).toEqual([`toggleGraph(${mode})`]);
    }
  });

  it("halves and doubles the speed", () => {
    press("-");
    expect(log.calls).toEqual(["bumpSpeed(0.5)"]);
    log.calls.length = 0;
    press("=");
    press("+");
    expect(log.calls).toEqual(["bumpSpeed(2)", "bumpSpeed(2)"]);
  });

  it("clears the selection with Escape once nothing is pending", () => {
    press("Escape");
    expect(log.calls).toEqual(["cancelPending", "setSelection()"]);
  });

  it("ignores keys it does not claim", () => {
    for (const key of ["q", "z", "j", "5", "]", "Home", "PageUp"]) {
      const r = press(key);
      expect(r.consumed, key).toBe(false);
      expect(r.prevented, key).toBe(false);
    }
    expect(log.calls).toEqual([]);
  });
});

describe("modal precedence", () => {
  it("gives the tour the keyboard outright", () => {
    host.tour.visible = true;
    for (const key of [" ", "v", "Escape", "F1", "l"]) {
      expect(press(key).consumed, key).toBe(false);
    }
    expect(log.calls).toEqual([]);
  });

  it("still allows Ctrl shortcuts to reach the app during the tour", () => {
    // undo/redo are not the tour's to swallow, and the tour handles its own
    // Esc and arrows in the capture phase before this ever runs
    host.tour.visible = true;
    press("z", { ctrl: true });
    expect(log.calls).toEqual(["undo"]);
  });

  it("lets an open overlay swallow everything but its close keys", () => {
    overlays[0].visible = true;
    for (const key of [" ", "v", "1", "t", "Delete"]) {
      expect(press(key).consumed, key).toBe(false);
    }
    expect(log.calls).toEqual([]);
  });

  it.each(["Escape", "l", "F1"])("closes every overlay on %s", (key) => {
    overlays[0].visible = true;
    overlays[1].visible = true;
    const r = press(key);
    expect(r.consumed).toBe(true);
    expect(overlays.every((o) => !o.visible)).toBe(true);
  });

  it("does not fire the underlying action for a close key", () => {
    // "l" closes the overlay; it must not also re-open the library
    overlays[0].visible = true;
    press("l");
    expect(log.calls).toEqual([]);
  });
});

/** A keydown whose target is not an element must not disable the keyboard.
 *
 * `ownsKey` asks the target whether it owns the key, and did so by calling
 * `getAttribute` on it directly. Real keydowns always carry an element (the
 * focused one, or the body), but a keydown dispatched on `document` itself -
 * automation, a browser extension, a refactor that listens somewhere else -
 * carries the Document, which has no `getAttribute`. That threw INSIDE the
 * listener, where the browser swallows the exception, so the key was dropped:
 * every shortcut in the app dead, silently, with nothing in the console, for
 * as long as events kept arriving that way.
 */
describe("an unusual event target", () => {
  /** A keydown carrying `target` verbatim, bypassing `press`'s element stub. */
  function pressAt(target: unknown, key = "b"): boolean {
    const e = {
      key, ctrlKey: false, metaKey: false, shiftKey: false, target,
      preventDefault() {}, stopPropagation() {},
    } as unknown as KeyboardEvent;
    return handleShortcut(e, host);
  }

  it("is handled rather than throwing, whatever shape the target has", () => {
    for (const target of [null, undefined, {}, { tagName: "BODY" },
                          { nodeType: 9 }, { tagName: undefined }]) {
      expect(() => pressAt(target)).not.toThrow();
    }
  });

  it("still routes the key when the target cannot own it", () => {
    expect(pressAt({ nodeType: 9 }, "b")).toBe(true);
    expect(log.calls).toContain("setTool(body)");
  });

  it("still routes the key for a target with no properties at all", () => {
    expect(pressAt({}, "w")).toBe(true);
    expect(log.calls).toContain("setTool(wall)");
  });

  it("still lets a real button keep its Space", () => {
    expect(pressAt({ tagName: "BUTTON", getAttribute: () => null }, " ")).toBe(false);
    expect(log.calls).toEqual([]);
  });

  it("still lets an ARIA button keep its Space", () => {
    const aria = { tagName: "DIV", getAttribute: (n: string) => (n === "role" ? "button" : null) };
    expect(pressAt(aria, " ")).toBe(false);
    expect(log.calls).toEqual([]);
  });

  it("still lets a text field keep every key", () => {
    expect(pressAt({ tagName: "INPUT" }, "b")).toBe(false);
    expect(log.calls).toEqual([]);
  });
});
