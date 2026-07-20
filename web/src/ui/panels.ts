/** Toolbar, tool palette, hint bar and graph dock (DOM). */
import { App, GraphMode, Panel } from "../app";
import { Body } from "../engine/body";
import { SpringLink } from "../engine/links";
import { TOOLS, TOOL_INFO, TOOL_KEYS, Tool } from "../interact/tools";
import { RefreshGroup, button, el, isTouch, segmented, slider } from "./dom";
import { ICONS } from "./icons";
import { GRAPH_HISTORY_S, GRAPH_WINDOW_S, TimeSeries } from "./plots";
import * as theme from "./theme";
import { css } from "./theme";

// ------------------------------------------------------------------ toolbar
export class Toolbar implements Panel {
  private group = new RefreshGroup();
  private playBtn: HTMLButtonElement;
  private timeInput: HTMLInputElement;
  private fps: HTMLElement;
  private app: App;
  private lastPlaying: boolean | null = null;
  private lastFps = "";

  constructor(app: App, root: HTMLElement) {
    this.app = app;
    const g = this.group;

    root.append(el("span", { class: "brand", text: "Mechanica" }));

    const play = g.add(button("", () => app.togglePlay(),
      { icon: ICONS.play, style: "primary", tooltip: "Play / pause (Space)" }));
    this.playBtn = play.root as HTMLButtonElement;
    root.append(play.root);
    root.append(g.add(button("", () => app.stepBack(),
      { icon: ICONS.step_back, tooltip: "Step one frame back (Left arrow or ,)" })).root);
    root.append(g.add(button("", () => app.stepOnce(),
      { icon: ICONS.step, tooltip: "Advance one frame (Right arrow or .)" })).root);
    root.append(g.add(button("", () => app.resetSim(),
      { icon: ICONS.reset, tooltip: "Reset to the initial state (Ctrl+R)" })).root);

    const speedWrap = el("div", { class: "speed-ctrl", style: "width:200px;flex:none;" });
    speedWrap.append(g.add(slider("Speed", () => app.speed,
      (v) => { app.speed = v; }, 0.01, 16.0,
      { unit: "x", log: true, fmt: (v) => v.toFixed(2),
        tooltip: "Simulation speed multiplier. Keys: + and - double/halve, " +
                 "0 resets." })).root);
    root.append(speedWrap);
    root.append(g.add(button("1x", () => app.resetSpeed(),
      { tooltip: "Reset the speed to 1x - press 0" })).root);

    // simulation clock: type a time to re-simulate to it
    this.timeInput = el("input", {
      type: "text", inputmode: "decimal",
      style: "width:76px;flex:none;text-align:right;",
      title: "Simulation clock (s). Type a time to re-simulate to it.",
    });
    let timeFocused = false;
    this.timeInput.addEventListener("focus", () => {
      timeFocused = true;
      this.timeInput.select();
    });
    this.timeInput.addEventListener("blur", () => {
      timeFocused = false;
      app.commitTimeJump(this.timeInput.value);
    });
    this.timeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.timeInput.blur();
      else if (e.key === "Escape") {
        this.timeInput.value = app.world.time.toFixed(2);
        this.timeInput.blur();
      }
      e.stopPropagation();
    });
    this.group.add({ root: this.timeInput, refresh: () => {
      if (!timeFocused) this.timeInput.value = app.world.time.toFixed(2);
    } });
    root.append(el("span", { class: "dim", text: "t =" }), this.timeInput,
                el("span", { class: "dim", text: "s" }));

    root.append(el("div", { class: "toolbar-spacer" }));

    root.append(g.add(button("", () => app.undo(),
      { icon: ICONS.undo, tooltip: "Undo (Ctrl+Z)",
        isEnabled: () => app.undoStack.canUndo })).root);
    root.append(g.add(button("", () => app.redo(),
      { icon: ICONS.redo, tooltip: "Redo (Ctrl+Y)",
        isEnabled: () => app.undoStack.canRedo })).root);
    root.append(g.add(button("", () => app.newScene(),
      { icon: ICONS.trash, tooltip: "Clear the scene (undo-able)" })).root);
    root.append(g.add(button("", () => app.zoomToFit(),
      { icon: ICONS.fit, tooltip: "Zoom to fit the scene once (F)" })).root);
    root.append(g.add(button("", () => app.toggleAutoFit(),
      { icon: ICONS.autofit, isActive: () => app.view.autoFit,
        tooltip: "Auto-fit camera: continuously keep the whole scene framed (Shift+F)" })).root);
    root.append(g.add(button("Library", () => toggleOverlay("library"),
      { icon: ICONS.library, tooltip: "Example simulations and saved scenes (L)" })).root);
    root.append(g.add(button("", () => toggleOverlay("settings"),
      { icon: ICONS.gear,
        tooltip: "Settings - theme, font, performance, help" })).root);

    this.fps = el("span", { id: "fps" });
    root.append(this.fps);
  }

  refresh(): void {
    // only touch the DOM when state changes: replacing the icon while the
    // user's pointer is mid-click would destroy the element under the
    // cursor and make the browser swallow the click
    if (this.lastPlaying !== this.app.playing) {
      this.lastPlaying = this.app.playing;
      this.playBtn.innerHTML = this.app.playing ? ICONS.pause : ICONS.play;
      this.playBtn.classList.toggle("active", this.app.playing);
    }
    const fps = `${this.app.fpsNow.toFixed(0)} fps`;
    if (fps !== this.lastFps) {
      this.lastFps = fps;
      this.fps.textContent = fps;
    }
    this.group.refreshAll();
  }
}

/** Overlays register their open/close functions here (set by main.ts). */
export const overlayToggles: Record<string, () => void> = {};

function toggleOverlay(name: string): void {
  overlayToggles[name]?.();
}

// ------------------------------------------------------------------ palette
const TOOL_GROUPS: Tool[][] = [["select", "pan"], ["body", "anchor", "wall"],
                               ["rod", "rope", "spring"], ["eraser"]];

export class Palette implements Panel {
  private group = new RefreshGroup();

  constructor(app: App, root: HTMLElement) {
    const keyOf: Record<string, string> = {};
    for (const [k, t] of Object.entries(TOOL_KEYS)) keyOf[t] = k.toUpperCase();
    TOOL_GROUPS.forEach((tools, gi) => {
      if (gi > 0) root.append(el("hr"));
      for (const tool of tools) {
        const [name, desc] = TOOL_INFO[tool];
        const b = this.group.add(button("", () => app.controller.setTool(tool), {
          icon: ICONS[tool], style: "ghost", class: "tool-btn",
          tooltip: `${name} - ${desc}`,
          isActive: () => app.controller.tool === tool,
        }));
        b.root.append(el("span", { class: "key-badge", text: keyOf[tool] ?? "" }));
        root.append(b.root);
      }
    });
    void TOOLS;
  }

  refresh(): void {
    this.group.refreshAll();
  }
}

// ------------------------------------------------------------------ hint bar
export class HintBar implements Panel {
  private hint: HTMLElement;
  private status: HTMLElement;
  private app: App;
  private lastHint = "";
  private lastBarW = 0;

  constructor(app: App, hint: HTMLElement, status: HTMLElement) {
    this.app = app;
    this.hint = hint;
    this.status = status;
  }

  /** Shrink only the tool-hint text until it fits beside the stats (down
   * to a floor, after which it ellipsizes); the stats keep their size. */
  private fitHint(): void {
    let size = 12;
    this.hint.style.fontSize = "";
    while (size > 9 && this.hint.scrollWidth > this.hint.clientWidth) {
      size--;
      this.hint.style.fontSize = `${size}px`;
    }
  }

  refresh(): void {
    const app = this.app;
    const hint = app.controller.hint();
    let nBodies = 0;
    let nAnchors = 0;
    for (const b of app.world.bodies) b.isAnchor ? nAnchors++ : nBodies++;
    const nLinks = app.world.links.length;
    const drift = app.energyDriftText();
    const res = app.playing && app.qNow > 1 ? `dt/${app.qNow}   ` : "";
    const stats = `${nBodies} bodies   ${nAnchors} anchors   ${nLinks} links   ` +
                  `${app.world.contacts.length} contacts   ${res}${drift}`;
    // the cursor position is a hover readout - meaningless on any touch
    // device, and the room is better spent on the counts
    if (isTouch()) {
      this.status.textContent = stats;
    } else {
      const [mx, my] = app.controller.mouse;
      const wp = app.camera.toWorld(mx, my);
      this.status.textContent =
        `${wp.x.toFixed(2)}, ${wp.y.toFixed(2)} m   |   ${stats}`;
    }
    const barW = this.hint.parentElement?.clientWidth ?? 0;
    if (hint !== this.lastHint || barW !== this.lastBarW) {
      this.lastHint = hint;
      this.lastBarW = barW;
      this.hint.textContent = hint;
      this.hint.title = hint; // hover reveals the full text when clipped
      this.fitHint();
    }
  }
}

// ---------------------------------------------------------------- graph dock
export class GraphDock implements Panel {
  private app: App;
  private root: HTMLElement;
  private splitter: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hintEl: HTMLElement;
  private liveBtn: HTMLButtonElement;
  private group = new RefreshGroup();
  private lastMode: GraphMode = "Off";
  // time-axis view: zoom (span) and scroll-back position (end; null=live)
  private viewSpan = GRAPH_WINDOW_S;
  private viewEnd: number | null = null;

  constructor(app: App, root: HTMLElement, splitter: HTMLElement) {
    this.app = app;
    this.root = root;
    this.splitter = splitter;

    const header = el("div", { class: "dock-header" });
    header.append(this.group.add(segmented(["Energy", "Mom.", "Phase"],
      () => app.graphMode,
      (v) => app.setGraphMode(v as GraphMode),
      "Which live graph to display (keys 1, 2, 3)")).root);
    this.hintEl = el("span", { class: "dock-hint" });
    header.append(this.hintEl);
    this.liveBtn = el("button", { class: "primary", text: "Live" });
    this.liveBtn.title = "Jump back to the present and follow new data";
    this.liveBtn.hidden = true;
    this.liveBtn.addEventListener("click", () => { this.viewEnd = null; });
    header.append(this.liveBtn);
    header.append(this.group.add(button("", () => this.clearData(),
      { icon: ICONS.trash, style: "ghost", tooltip: "Clear all collected graph data" })).root);
    header.append(this.group.add(button("", () => app.setGraphMode("Off"),
      { icon: ICONS.close, style: "ghost", tooltip: "Close the graph dock" })).root);

    this.canvas = el("canvas");
    const wrap = el("div", { class: "dock-canvas-wrap" }, this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    root.append(header, wrap);

    this.attachViewControls();

    // resizable via the splitter above the dock
    const saved = app.settings.dock_h;
    if (typeof saved === "number") root.style.height = `${Math.max(110, saved)}px`;
    let dragging = false;
    splitter.addEventListener("pointerdown", (e) => {
      dragging = true;
      splitter.setPointerCapture(e.pointerId);
    });
    splitter.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const main = root.parentElement!;
      const h = Math.max(110, Math.min(main.clientHeight - 160,
        main.getBoundingClientRect().bottom - e.clientY));
      root.style.height = `${h}px`;
      app.resizeCanvas();
    });
    splitter.addEventListener("pointerup", () => {
      dragging = false;
      app.settings.dock_h = root.clientHeight;
      app.saveSettings();
    });
  }

  /** Wheel = zoom the time axis, drag = scroll back through the retained
   * history (detaching from the live edge), plain click = legend toggle. */
  private attachViewControls(): void {
    const spanFor = (px: number): number => this.viewSpan * (px / Math.max(1, this.canvas.clientWidth));

    this.canvas.addEventListener("wheel", (e) => {
      const series = this.activeSeries();
      if (series === undefined || series.t.length === 0) return;
      e.preventDefault();
      const factor = 1.1 ** (-e.deltaY / 100);
      const newSpan = Math.min(GRAPH_HISTORY_S,
        Math.max(0.5, this.viewSpan / factor));
      if (this.viewEnd !== null) {
        // detached: keep the time under the cursor fixed while zooming
        const r = this.canvas.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
        const tCursor = this.viewEnd - this.viewSpan * (1 - frac);
        this.setViewEnd(tCursor + (1 - frac) * newSpan, series);
      }
      // live: the right edge stays anchored and keeps following
      this.viewSpan = newSpan;
    }, { passive: false });

    let dragId: number | null = null;
    let lastX = 0;
    let moved = false;
    this.canvas.addEventListener("pointerdown", (e) => {
      dragId = e.pointerId;
      lastX = e.clientX;
      moved = false;
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // pointer already gone: the drag simply won't extend off-canvas
      }
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (dragId !== e.pointerId) return;
      const dx = e.clientX - lastX;
      if (!moved && Math.abs(dx) < 4) return; // not a drag yet
      const series = this.activeSeries();
      if (series === undefined || series.t.length === 0) return;
      moved = true;
      lastX = e.clientX;
      this.setViewEnd((this.viewEnd ?? series.lastT) - spanFor(dx), series);
    });
    const endDrag = (e: PointerEvent) => {
      if (dragId !== e.pointerId) return;
      dragId = null;
      if (!moved) {
        // a plain click: toggle legend channels
        const r = this.canvas.getBoundingClientRect();
        this.activeSeries()?.legendClick(e.clientX - r.left, e.clientY - r.top);
      }
    };
    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", () => { dragId = null; });
  }

  /** Clamp a requested right-edge time to the retained history and snap
   * back to live when it reaches the newest sample. */
  private setViewEnd(end: number, series: TimeSeries): void {
    const latest = series.lastT;
    const minEnd = Math.min(latest, series.firstT + this.viewSpan);
    end = Math.max(minEnd, Math.min(latest, end));
    this.viewEnd = end >= latest - 1e-9 ? null : end;
  }

  private clearData(): void {
    this.app.energySeries.clear();
    this.app.momentumSeries.clear();
    this.app.phasePlot.clear();
    this.viewEnd = null;
  }

  private activeSeries() {
    return { Energy: this.app.energySeries, "Mom.": this.app.momentumSeries }[
      this.app.graphMode as string];
  }

  /** Why the plotted conserved quantity may legitimately change. */
  private hint(): string {
    const app = this.app;
    const w = app.world;
    if (app.graphMode === "Mom.") {
      const ext: string[] = [];
      if (w.gravity !== 0.0) ext.push("gravity");
      if (w.bodies.some((b) => b.invMass === 0.0)) ext.push("fixed anchors");
      if (w.walls.length > 0) ext.push("walls");
      if (w.dragLinear || w.dragQuadratic || w.globalDamping) ext.push("drag/damping");
      if (w.drivers.some((d) => d.enabled) || w.fields.some((f) => f.enabled)) {
        ext.push("drivers/fields");
      }
      if (ext.length > 0) {
        return "Momentum is only conserved in isolation - " + ext.join(", ") +
               " exert external forces here";
      }
      return "Isolated system: total momentum should stay constant";
    }
    if (app.graphMode === "Energy") {
      const lossy: string[] = [];
      if (w.dragLinear || w.dragQuadratic) lossy.push("air drag");
      if (w.globalDamping) lossy.push("global damping");
      if (w.links.some((ln) => ln instanceof SpringLink && ln.damping > 0)) {
        lossy.push("spring damping");
      }
      if (lossy.length > 0) return "Energy is removed by " + lossy.join(", ");
    }
    return "";
  }

  /** What the last canvas draw depended on; redraws are skipped while
   * this stays the same (paused sim, throttled sampling frames). */
  private lastDrawSig = "";

  refresh(): void {
    const app = this.app;
    const visible = app.graphMode !== "Off";
    if (visible !== !this.root.hidden) {
      this.root.hidden = !visible;
      this.splitter.hidden = !visible;
      app.resizeCanvas();
    }
    if (!visible) {
      this.lastMode = "Off";
      return;
    }
    if (app.graphMode !== this.lastMode) this.lastMode = app.graphMode;
    this.group.refreshAll();
    const dockHint = this.hint();
    if (this.hintEl.textContent !== dockHint) {
      this.hintEl.textContent = dockHint;
      this.hintEl.title = dockHint; // hover reveals the full text when clipped
    }

    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }

    // Scrolled-back view whose whole range has been evicted from the
    // bounded history: rejoin the live edge and tell the user why.
    const series = this.activeSeries();
    if (this.viewEnd !== null && series !== undefined &&
        series.t.length > 0 && this.viewEnd <= series.firstT) {
      this.viewEnd = null;
      app.toast("That part of the graph history has expired - back to live");
    }
    this.liveBtn.hidden = this.viewEnd === null || series === undefined;

    // redraw only when something it depends on changed - between throttled
    // samples and while paused the canvas is already correct. An easing
    // autoscale keeps redrawing static data until the animation settles.
    const body = app.selection.find((o): o is Body => o instanceof Body);
    const rev = series !== undefined ? series.rev
      : `${app.phasePlot.rev}:${body?.name ?? ""}`;
    const sig = `${app.graphMode}:${bw}x${bh}:${rev}:` +
                `${this.viewEnd ?? "live"}:${this.viewSpan}`;
    if (sig === this.lastDrawSig && !(series?.easing ?? false)) return;
    this.lastDrawSig = sig;

    const graphView = { end: this.viewEnd, span: this.viewSpan };
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (app.graphMode === "Energy") {
      app.energySeries.draw(ctx, w, h, "Energy (J)", graphView);
    } else if (app.graphMode === "Mom.") {
      app.momentumSeries.draw(ctx, w, h,
        "Momentum p (kg m/s) and angular momentum L", graphView);
    } else if (app.graphMode === "Phase") {
      const body = app.selection.find((o): o is Body => o instanceof Body);
      const name = body ? body.name : "select a body";
      // the body name once, centred above both plots (not repeated in each)
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.fillStyle = css(theme.TEXT_DIM);
      ctx.textAlign = "center";
      ctx.fillText(name, w / 2, 14);
      ctx.textAlign = "left";
      // two SQUARE plots (x-vx and y-vy) so orbits aren't stretched
      const top = 20;
      const side = Math.min(h - top - 4, (w - 12) / 2);
      const x0 = (w - (2 * side + 12)) / 2;
      app.phasePlot.draw(ctx, x0, top, side, side, "x");
      app.phasePlot.draw(ctx, x0 + side + 12, top, side, side, "y");
    }
  }
}
