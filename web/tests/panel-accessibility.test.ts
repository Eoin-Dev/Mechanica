/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { Palette, Toolbar } from "../src/ui/panels";

function appStub(): App {
  return {
    playing: false,
    speed: 1,
    fpsNow: 60,
    world: { time: 0 },
    undoStack: { canUndo: false, canRedo: false },
    view: { autoFit: false },
    controller: { tool: "select", setTool() {} },
    togglePlay() {}, stepBack() {}, stepOnce() {}, resetSim() {}, resetSpeed() {},
    commitTimeJump() {}, undo() {}, redo() {}, newScene() {}, zoomToFit() {},
    toggleAutoFit() {}, setSelection() {},
  } as unknown as App;
}

describe("toolbar and palette semantics", () => {
  it("announces the play state and keeps a level-one heading", () => {
    const app = appStub();
    const root = document.createElement("div");
    const toolbar = new Toolbar(app, root);
    toolbar.refresh();

    const heading = root.querySelector<HTMLElement>("[role=heading]");
    const play = root.querySelector<HTMLButtonElement>("[aria-pressed]")!;
    expect(heading?.getAttribute("aria-level")).toBe("1");
    expect(play.getAttribute("aria-label")).toMatch(/^Start the simulation/);
    expect(play.getAttribute("aria-pressed")).toBe("false");

    app.playing = true;
    toolbar.refresh();
    expect(play.getAttribute("aria-label")).toMatch(/^Pause the simulation/);
    expect(play.getAttribute("aria-pressed")).toBe("true");
  });

  it("hides shortcut badges from accessible-name computation", () => {
    const app = appStub();
    const root = document.createElement("div");
    const palette = new Palette(app, root);
    palette.refresh();
    const badges = [...root.querySelectorAll<HTMLElement>(".key-badge")];
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.every((badge) => badge.getAttribute("aria-hidden") === "true"))
      .toBe(true);
    expect(root.querySelector<HTMLButtonElement>("button.tool-btn")
      ?.hasAttribute("aria-label")).toBe(true);
  });
});
