/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { PhasePlot, TimeSeries } from "../src/ui/plots";
import { GraphDock, HintBar, Palette, Toolbar } from "../src/ui/panels";
import * as theme from "../src/ui/theme";

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
    expect(root.querySelector("#fps")?.textContent).toBe("Idle");

    app.playing = true;
    toolbar.refresh();
    expect(play.getAttribute("aria-label")).toMatch(/^Pause the simulation/);
    expect(play.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector("#fps")?.textContent).toBe("60 fps");
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

  it("does not rewrite an unchanged simulation clock value", () => {
    const app = appStub();
    const root = document.createElement("div");
    const toolbar = new Toolbar(app, root);
    const clock = root.querySelector<HTMLInputElement>(
      'input[aria-label="Simulation time in seconds"]')!;
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, "value")!;
    let writes = 0;
    Object.defineProperty(clock, "value", {
      configurable: true,
      get: () => descriptor.get!.call(clock) as string,
      set: (value: string) => {
        writes++;
        descriptor.set!.call(clock, value);
      },
    });

    toolbar.refresh();
    toolbar.refresh();
    expect(clock.value).toBe("0.00");
    expect(writes).toBe(1);

    app.world.time = 1.25;
    toolbar.refresh();
    toolbar.refresh();
    expect(clock.value).toBe("1.25");
    expect(writes).toBe(2);
  });
});

describe("status readouts", () => {
  it("removes technical quality readouts and separates grammatical status items", () => {
    const hint = document.createElement("div");
    const status = document.createElement("div");
    const stub = {
      controller: { hint: () => "", mouse: [0, 0] },
      world: { bodies: [], links: [], contacts: [] },
      camera: { toWorld: () => ({ x: 0, y: 0 }) },
      energyDriftText: () => "",
      playing: false,
      qNow: 1,
      view: { trails: true },
      trailQuality: 6,
      perfMode: false,
      performanceQualityLabel: "Maximum",
    };
    const app = stub as unknown as App;
    const bar = new HintBar(app, hint, status);
    bar.refresh();
    expect(status.textContent).not.toContain("trail");
    expect(status.textContent).not.toContain("dt/");
    expect(status.textContent).toContain("0 bodies");
    expect(status.querySelectorAll(".status-item")).toHaveLength(5);

    stub.perfMode = true;
    bar.refresh();
    expect(status.textContent).not.toContain("trail");
    expect(status.textContent).toContain("perf Maximum");
    expect(status.querySelectorAll(".status-item")).toHaveLength(6);

    stub.world.bodies = [{ isAnchor: false }] as never[];
    stub.world.links = [{}] as never[];
    stub.world.contacts = [{}] as never[];
    bar.refresh();
    expect(status.textContent).toContain("1 body");
    expect(status.textContent).not.toContain("1 bodies");
    expect(status.textContent).toContain("1 link");
    expect(status.textContent).toContain("1 contact");
  });
});

describe("graph dock retained state", () => {
  it("resynchronises a revealed splitter and redraws after palette changes", () => {
    let clears = 0;
    const ctx = new Proxy({
      clearRect() { clears++; },
      measureText: () => ({ width: 10 }),
    } as Record<string, unknown>, {
      get(target, key) {
        return key in target ? target[key as string] : () => {};
      },
      set() { return true; },
    }) as unknown as CanvasRenderingContext2D;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctx);
    const originalTheme = theme.themeName;
    try {
      const app = {
        graphMode: "Energy",
        settings: {},
        selection: [],
        world: {
          gravity: 0, bodies: [], walls: [], links: [], fields: [], drivers: [],
          dragLinear: 0, dragQuadratic: 0, globalDamping: 0,
        },
        energySeries: new TimeSeries(["KE", "PE", "Total"]),
        momentumSeries: new TimeSeries(["|p|", "px", "py", "L"]),
        phasePlot: new PhasePlot(),
        resizeCanvas() {}, saveSettings() {}, toast() {}, setGraphMode() {},
      } as unknown as App;
      app.energySeries.add(0, { KE: 1, PE: 2, Total: 3 });

      const main = document.createElement("div");
      const splitter = document.createElement("div");
      const root = document.createElement("div");
      root.hidden = true;
      splitter.hidden = true;
      let mainHeight = 800;
      Object.defineProperty(main, "clientHeight", { get: () => mainHeight });
      Object.defineProperty(root, "clientHeight", {
        get: () => root.hidden ? 0 : 220,
      });
      main.append(splitter, root);
      document.body.replaceChildren(main);
      const dock = new GraphDock(app, root, splitter);
      const canvas = root.querySelector("canvas")!;
      Object.defineProperty(canvas, "clientWidth", { value: 500 });
      Object.defineProperty(canvas, "clientHeight", { value: 180 });

      dock.refresh();
      expect(splitter.getAttribute("aria-valuenow")).toBe("220");
      expect(Number(splitter.getAttribute("aria-valuenow")))
        .toBeGreaterThanOrEqual(Number(splitter.getAttribute("aria-valuemin")));
      const firstDraw = clears;
      dock.refresh();
      expect(clears).toBe(firstDraw);

      mainHeight = 700;
      dock.refresh();
      expect(splitter.getAttribute("aria-valuemax")).toBe("540");
      expect(clears).toBe(firstDraw);

      theme.setTheme(originalTheme === "light" ? "dark" : "light");
      dock.refresh();
      expect(clears).toBeGreaterThan(firstDraw);
    } finally {
      theme.setTheme(originalTheme);
      getContext.mockRestore();
    }
  });
});
