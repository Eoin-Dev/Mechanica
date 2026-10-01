/** Toolbar, tool palette, hint bar and graph dock (DOM). */
import { App, GraphMode, Panel } from "../app";
import { Body } from "../engine/body";
import { SpringLink } from "../engine/links";
import { TOOL_INFO, TOOL_KEYS, Tool } from "../interact/tools";
import { DOCK_H_MAX, DOCK_H_MIN, RefreshGroup, button, countNoun, el, fmt3g, isTouch,
         segmented, slider, splitterDrag } from "./dom";
import { ICONS } from "./icons";
import { GRAPH_HISTORY_S, GRAPH_WINDOW_S, TimeSeries } from "./plots";
import * as theme from "./theme";
import { css } from "./theme";

// ------------------------------------------------------------------ toolbar
export class Toolbar implements Panel {
  private group = new RefreshGroup();
  private playBtn: HTMLButtonElement;
  private timeInput: HTMLInputElement;
  private timeControls: HTMLElement;
  private timeJumpCancel: HTMLButtonElement;
  private fps: HTMLElement;
  private app: App;
  private lastPlaying: boolean | null = null;
  private lastSeeking: boolean | null = null;
  private lastFps = "";

  constructor(app: App, root: HTMLElement) {
    this.app = app;
    const g = this.group;

    // the app's title: a heading for assistive tech (the page had h2s but no
    // h1 at all), styled by .brand exactly as before
    root.append(el("span", { class: "brand", text: "Mechanica",
                             role: "heading", "aria-level": "1" }));

    const play = g.add(button("", () => app.togglePlay(),
      { icon: ICONS.play, style: "primary",
        tooltip: "Start the simulation (Space).",
        isActive: () => app.playing }));
    this.playBtn = play.root as HTMLButtonElement;
    root.append(play.root);
    root.append(g.add(button("", () => app.stepBack(),
      { icon: ICONS.step_back,
        tooltip: "Step one frame back (Left arrow or ,)." })).root);
    root.append(g.add(button("", () => app.stepOnce(),
      { icon: ICONS.step,
        tooltip: "Advance one frame (Right arrow or .)." })).root);
    root.append(g.add(button("", () => app.resetSim(),
      { icon: ICONS.reset,
        tooltip: "Return the scene to its starting state (Ctrl+R)." })).root);

    const speedWrap = el("div", { class: "speed-ctrl" });
    speedWrap.append(g.add(slider("Speed", () => app.speed,
      (v) => { app.speed = v; }, 0.01, 16.0,
      { unit: "x", log: true, logBlend: 0.6, fmt: (v) => v.toFixed(2),
        tooltip: "How fast simulated time runs against real time. " +
                 "+ and - double or halve it, 0 resets." })).root);
    root.append(speedWrap);
    root.append(g.add(button("1x", () => app.resetSpeed(),
      { tooltip: "Reset the speed to real time (0)." })).root);

    // simulation clock: type a time to re-simulate to it
    this.timeInput = el("input", {
      type: "text", inputmode: "decimal",
      style: "width:76px;flex:none;text-align:right;",
      title: "Simulation clock (s). Type a time to re-simulate to it.",
      "aria-label": "Simulation time in seconds",
    });
    let timeFocused = false;
    let timeEditText = "";
    let timeCancelled = false;
    this.timeInput.addEventListener("focus", () => {
      timeFocused = true;
      timeEditText = this.timeInput.value;
      timeCancelled = false;
      this.timeInput.select();
    });
    this.timeInput.addEventListener("blur", () => {
      timeFocused = false;
      if (!timeCancelled && this.timeInput.value !== timeEditText) {
        void app.requestTimeJump(this.timeInput.value).catch(() => {
          app.toast("Could not seek to that time. Try again.");
        });
      }
      this.timeInput.value = app.world.time.toFixed(2);
    });
    this.timeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.timeInput.blur();
      else if (e.key === "Escape") {
        timeCancelled = true;
        app.cancelTimeJump();
        this.timeInput.blur();
      }
      e.stopPropagation();
    });
    this.group.add({ root: this.timeInput, refresh: () => {
      if (!timeFocused) {
        const value = (app.seeking ? app.seekingTime : app.world.time).toFixed(2);
        if (this.timeInput.value !== value) this.timeInput.value = value;
      }
    } });
    this.timeControls = el("div", { class: "time-ctrl", role: "group",
      "aria-label": "Simulation time" });
    this.timeControls.append(el("span", { class: "dim", text: "t =" }), this.timeInput,
                             el("span", { class: "dim", text: "s" }));
    this.timeJumpCancel = button("Cancel", () => app.cancelTimeJump(),
      { icon: ICONS.close, style: "ghost",
        tooltip: "Cancel time jump and keep the current scene." }).root as HTMLButtonElement;
    this.timeJumpCancel.hidden = true;
    this.timeControls.append(this.timeJumpCancel);
    root.append(this.timeControls);

    root.append(el("div", { class: "toolbar-spacer" }));

    root.append(g.add(button("", () => app.undo(),
      { icon: ICONS.undo, tooltip: "Undo the last edit (Ctrl+Z).",
        isEnabled: () => app.undoStack.canUndo })).root);
    root.append(g.add(button("", () => app.redo(),
      { icon: ICONS.redo, tooltip: "Redo the last undone edit (Ctrl+Y).",
        isEnabled: () => app.undoStack.canRedo })).root);
    root.append(g.add(button("", () => app.newScene(),
      { icon: ICONS.trash,
        tooltip: "Remove everything from the scene. Ctrl+Z restores it." })).root);
    root.append(g.add(button("", () => app.zoomToFit(),
      { icon: ICONS.fit, tooltip: "Frame the whole scene once (F)." })).root);
    root.append(g.add(button("", () => app.toggleAutoFit(),
      { icon: ICONS.autofit, isActive: () => app.view.autoFit,
        tooltip: "Keep the whole scene framed as it spreads out (Shift+F)." })).root);
    // ids so the guided tour can spotlight these two specifically rather
    // than the whole toolbar strip
    const libraryBtn = g.add(button("Library", () => toggleOverlay("library"),
      { icon: ICONS.library,
        tooltip: "Example simulations and saved scenes (L)." }));
    libraryBtn.root.id = "btn-library";
    root.append(libraryBtn.root);
    const settingsBtn = g.add(button("", () => toggleOverlay("settings"),
      { icon: ICONS.gear,
        tooltip: "Settings: appearance, interaction, accuracy and help." }));
    settingsBtn.root.id = "btn-settings";
    root.append(settingsBtn.root);

    this.fps = el("span", { id: "fps" });
    root.append(this.fps);
  }

  refresh(): void {
    // only touch the DOM when state changes: replacing the icon while the
    // user's pointer is mid-click would destroy the element under the
    // cursor and make the browser swallow the click
    if (this.lastPlaying !== this.app.playing || this.lastSeeking !== this.app.seeking) {
      this.lastPlaying = this.app.playing;
      this.lastSeeking = this.app.seeking;
      this.playBtn.innerHTML = this.app.seeking ? ICONS.close
        : this.app.playing ? ICONS.pause : ICONS.play;
      const action = this.app.seeking ? "Cancel time jump (Space or Escape)."
        : this.app.playing ? "Pause the simulation (Space)." : "Start the simulation (Space).";
      this.playBtn.title = action;
      this.playBtn.setAttribute("aria-label", action);
      this.timeInput.setAttribute("aria-busy", String(Boolean(this.app.seeking)));
      this.timeJumpCancel.hidden = !this.app.seeking;
      if (this.app.seeking) this.timeControls.scrollIntoView?.({ block: "nearest", inline: "center" });
    }
    // Simulation playback and canvas presentation are separate. A paused,
    // unchanged canvas is genuinely Idle; while zooming/panning/editing it
    // reports the cadence of actual paints rather than the 20 Hz idle timer.
    const measured = this.app.playing ? this.app.fpsNow : this.app.displayFpsNow;
    const active = this.app.playing || this.app.displayActive;
    const fps = this.app.seeking ? "Seeking…" : active
      ? measured > 0 ? `${measured.toFixed(0)} fps` : "Rendering"
      : "Idle";
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
                               ["rod", "rope", "spring", "pulley"], ["eraser"]];

export class Palette implements Panel {
  private group = new RefreshGroup();

  constructor(app: App, root: HTMLElement) {
    // Reaching for a tool means you are done with the thing you just
    // placed. It stayed selected otherwise, so the inspector went on
    // editing it - and its selection ring stayed on the canvas - while you
    // drew something else entirely. Anywhere on the strip counts, not just
    // the buttons: the gaps between them are part of the same gesture.
    root.addEventListener("pointerdown", () => app.setSelection([]));

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
        b.root.append(el("span", { class: "key-badge", text: keyOf[tool] ?? "",
                                   "aria-hidden": "true" }));
        root.append(b.root);
      }
    });
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
  private lastStatus = "";
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
    let nPivots = 0;
    let nPulleys = 0;
    for (const b of app.world.bodies) {
      if (b.isRodEndpoint) continue;
      if (b.isPulley) nPulleys++;
      else if (b.isPivot) nPivots++;
      else if (b.isAnchor) nAnchors++;
      else nBodies++;
    }
    const nLinks = app.world.links.length;
    const drift = app.energyDriftText();
    // Performance mode changes what the numbers beside it MEAN - the drift
    // readout will wander, and the substeps in the inspector are not what is
    // running - so it says so rather than leaving that a mystery.
    const items = [countNoun(nBodies, "body", "bodies"),
                   countNoun(nAnchors, "anchor")];
    if (nPivots > 0) items.push(countNoun(nPivots, "rod anchor"));
    if (nPulleys > 0) items.push(countNoun(nPulleys, "pulley"));
    items.push(countNoun(nLinks, "link"),
               countNoun(app.world.contacts.length, "contact"));
    if (app.perfMode) items.push(`perf ${app.performanceQualityLabel}`);
    if (drift.trim() !== "") items.push(drift.trim());
    // the cursor position is a hover readout - meaningless on any touch
    // device, and the room is better spent on the counts
    if (!isTouch()) {
      const [mx, my] = app.controller.mouse;
      const wp = app.camera.toWorld(mx, my);
      items.unshift(`${wp.x.toFixed(2)}, ${wp.y.toFixed(2)} m`);
    }
    // only touch the DOM when the text actually changed - a paused scene
    // rewrote this identical string sixty times a second
    const signature = items.join("\u0000");
    if (signature !== this.lastStatus) {
      this.lastStatus = signature;
      this.status.replaceChildren(...items.map((text, index) =>
        el("span", { class: `status-item${index === 0 ? " status-first" : ""}`,
                     text })));
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
  private canvasWrap: HTMLElement;
  private header: HTMLElement;
  private legendControls: HTMLElement;
  private legendButtons = new Map<string, HTMLButtonElement>();
  private legendSeries: TimeSeries | undefined;
  private hintEl: HTMLElement;
  private liveBtn: HTMLButtonElement;
  private clearBtn!: HTMLButtonElement;
  private group = new RefreshGroup();
  private syncSplitterAria: () => void = () => {};
  // time-axis view: zoom (span) and scroll-back position (end; null=live)
  private viewSpan = GRAPH_WINDOW_S;
  private viewEnd: number | null = null;

  constructor(app: App, root: HTMLElement, splitter: HTMLElement) {
    this.app = app;
    this.root = root;
    this.splitter = splitter;

    const header = this.header = el("div", { class: "dock-header" });
    const modes = this.group.add(segmented(["Energy", "Mom.", "Phase", "Displacement", "Distance", "Velocity"],
      () => app.graphMode,
      (v) => app.setGraphMode(v as GraphMode),
      "Which live graph to display. Displacement, distance and velocity follow the selected particle."));
    modes.root.classList.add("graph-modes");
    header.append(modes.root);
    this.hintEl = el("span", { class: "dock-hint" });
    header.append(this.hintEl);
    this.liveBtn = el("button", { class: "primary", text: "Live" });
    this.liveBtn.title = "Jump back to the present and follow new data";
    this.liveBtn.hidden = true;
    this.liveBtn.addEventListener("click", () => { this.viewEnd = null; });
    header.append(this.liveBtn);
    const clear = this.group.add(button("", () => this.clearData(),
      { icon: ICONS.trash, style: "ghost",
        tooltip: "Discard all recorded graph data." }));
    this.clearBtn = clear.root as HTMLButtonElement;
    header.append(clear.root);
    header.append(this.group.add(button("", () => app.setGraphMode("Off"),
      { icon: ICONS.close, style: "ghost",
        tooltip: "Close the graph dock." })).root);

    this.canvas = el("canvas");
    this.legendControls = el("div", { class: "graph-legend-controls",
      role: "group", "aria-label": "Graph channels" });
    this.canvasWrap = el("div", { class: "dock-canvas-wrap" }, this.canvas, this.legendControls);
    this.ctx = this.canvas.getContext("2d")!;
    root.append(header, this.canvasWrap);

    this.attachViewControls();

    // resizable via the splitter above the dock
    const saved = app.settings.dock_h;
    if (typeof saved === "number") {
      root.style.height =
        `${Math.max(DOCK_H_MIN, Math.min(DOCK_H_MAX, saved))}px`;
    }
    const applyHeight = (h: number): void => {
      root.style.height = `${h}px`;
      app.resizeCanvas();
    };
    const dockMax = (): number => Math.max(DOCK_H_MIN,
      Math.min(DOCK_H_MAX, (root.parentElement?.clientHeight ?? DOCK_H_MAX) - 160));
    this.syncSplitterAria = splitterDrag(splitter, (e) => {
      const main = root.parentElement!;
      const h = Math.max(DOCK_H_MIN, Math.min(main.clientHeight - 160,
        main.getBoundingClientRect().bottom - e.clientY));
      applyHeight(h);
    }, () => {
      app.settings.dock_h = root.clientHeight;
      app.saveSettings();
    }, {
      orientation: "horizontal",
      label: "Resize graph dock",
      getValue: () => root.clientHeight,
      setValue: applyHeight,
      min: DOCK_H_MIN,
      max: dockMax,
      increaseKeys: ["ArrowUp"],
      decreaseKeys: ["ArrowDown"],
    });
  }

  /** Wheel = zoom the time axis, drag = scroll back through the retained
   * history (detaching from the live edge), plain click = legend toggle. */
  private attachViewControls(): void {
    const spanFor = (px: number): number => this.viewSpan * (px / Math.max(1, this.canvas.clientWidth));

    this.canvas.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) return; // reserved; document blocks page zoom
      const series = this.activeSeries();
      if (series === undefined || series.count === 0) return;
      e.preventDefault();
      const factor = 1.1 ** (-e.deltaY / 100);
      const newSpan = Math.min(GRAPH_HISTORY_S,
        Math.max(0.5, this.viewSpan / factor));
      const oldSpan = this.viewSpan;
      this.viewSpan = newSpan;
      if (this.viewEnd !== null) {
        // detached: keep the time under the cursor fixed while zooming
        const r = this.canvas.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
        const tCursor = this.viewEnd - oldSpan * (1 - frac);
        this.setViewEnd(tCursor + (1 - frac) * newSpan, series);
      }
      // live: the right edge stays anchored and keeps following
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
      if (series === undefined || series.count === 0) return;
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
    this.app.clearGraphData();
    this.viewEnd = null;
  }

  /** Match native controls to the painted legend without replacing focused
   * buttons when fresh samples change their values or measured widths. */
  private syncLegendControls(series: TimeSeries | undefined): void {
    if (series !== this.legendSeries) {
      this.legendControls.replaceChildren();
      this.legendButtons.clear();
      this.legendSeries = series;
    }
    this.legendControls.hidden = series === undefined;
    const legendBottom = Math.max(0, ...series?.legendEntries.map(hit => hit.y + hit.h) ?? []);
    const minimumHeight = `${Math.max(100, legendBottom + 70)}px`;
    if (this.canvasWrap.style.minHeight !== minimumHeight) {
      this.canvasWrap.style.minHeight = minimumHeight;
    }
    const style = getComputedStyle(this.root);
    const number = (value: string): number => parseFloat(value) || 0;
    const dockMinimum = `${this.header.offsetHeight + parseFloat(minimumHeight) +
      number(style.paddingTop) + number(style.paddingBottom) + number(style.rowGap) +
      number(style.borderTopWidth) + number(style.borderBottomWidth)}px`;
    if (this.root.style.minHeight !== dockMinimum) this.root.style.minHeight = dockMinimum;
    if (series === undefined) return;
    for (const hit of series.legendEntries) {
      let control = this.legendButtons.get(hit.channel);
      if (control === undefined) {
        control = el("button", { type: "button", class: "graph-legend-toggle",
          "aria-label": `${hit.channel} series` });
        control.addEventListener("click", () => series.toggleChannel(hit.channel));
        this.legendButtons.set(hit.channel, control);
        this.legendControls.append(control);
      }
      const pressed = String(!series.hidden.has(hit.channel));
      if (control.getAttribute("aria-pressed") !== pressed) {
        control.setAttribute("aria-pressed", pressed);
      }
      const unit = this.app.graphMode === "Energy" ? "J"
        : this.app.graphMode === "Mom." ? hit.channel === "L" ? "kg m²/s" : "kg m/s"
        : this.app.graphMode === "Velocity" ? "m/s" : "m";
      const direction = this.app.graphMode !== "Displacement" ? ""
        : hit.channel === "sx" ? " Horizontal displacement; right is positive."
        : " Vertical displacement; up is positive.";
      const description = series.count === 0 ? "No samples."
        : `Current value: ${fmt3g(series.valueAt(hit.channel, series.count - 1))} ${unit} at ${fmt3g(series.lastT)} s.${direction}`;
      if (control.getAttribute("aria-description") !== description) {
        control.setAttribute("aria-description", description);
        control.title = description;
      }
      const position = `left:${hit.x}px;top:${hit.y}px;width:${hit.w}px;height:${hit.h}px`;
      if (control.dataset.position !== position) {
        control.style.cssText = position;
        control.dataset.position = position;
      }
    }
  }

  /** The time series the current mode plots, or undefined for Phase/Off. */
  private activeSeries(): TimeSeries | undefined {
    if (this.app.graphMode === "Energy") return this.app.energySeries;
    if (this.app.graphMode === "Mom.") return this.app.momentumSeries;
    if (this.app.graphMode === "Displacement") return this.app.displacementSeries;
    if (this.app.graphMode === "Distance") return this.app.distanceSeries;
    if (this.app.graphMode === "Velocity") return this.app.velocitySeries;
    return undefined;
  }

  /** Why the plotted conserved quantity may legitimately change. */
  private hint(): string {
    const app = this.app;
    const w = app.world;
    if (app.graphMode === "Displacement") {
      return app.displacementSeries.count === 0
        ? "Select a particle to plot its signed displacement"
        : "From selection or Clear: sx is positive right; sy is positive up";
    }
    if (app.graphMode === "Distance") {
      return app.distanceSeries.count === 0
        ? "Select a particle to plot its distance travelled"
        : "Total travel since selection or Clear; turning back still adds distance";
    }
    if (app.graphMode === "Velocity") {
      return app.velocitySeries.count === 0
        ? "Select a particle to plot its velocity"
        : "Signed vx/vy and speed: right/up are positive; speed is the magnitude";
    }
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
      if (visible) this.syncSplitterAria();
    }
    if (!visible) return;
    this.clearBtn.hidden = false;
    // The dock maximum follows its parent height. Attribute writes are
    // internally guarded, so this cheap poll also keeps metadata current after
    // viewport/layout changes without creating DOM churn on stable frames.
    this.syncSplitterAria();
    this.group.refreshAll();
    const dockHint = this.hint();
    if (this.hintEl.textContent !== dockHint) {
      this.hintEl.textContent = dockHint;
      this.hintEl.title = dockHint; // hover reveals the full text when clipped
    }
    this.syncLegendControls(this.activeSeries());

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
        series.count > 0 && this.viewEnd <= series.firstT) {
      this.viewEnd = null;
      app.toast("That part of the graph history has expired - back to live");
    }
    this.liveBtn.hidden = this.viewEnd === null || series === undefined;

    // redraw only when something it depends on changed - between throttled
    // samples and while paused the canvas is already correct. An easing
    // autoscale keeps redrawing static data until the animation settles.
    const phaseBody = app.selection.find((o): o is Body => o instanceof Body);
    const rev = series !== undefined ? series.rev
      : `${app.phasePlot.rev}:${phaseBody?.name ?? ""}`;
    const sig = `${app.graphMode}:${bw}x${bh}:${rev}:p${theme.paletteRevision}:` +
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
      const name = phaseBody ? phaseBody.name : "select a body";
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
    } else if (app.graphMode === "Displacement") {
      app.displacementSeries.draw(ctx, w, h, "Displacement (m)", graphView,
        "Select a particle to plot displacement");
    } else if (app.graphMode === "Distance") {
      app.distanceSeries.draw(ctx, w, h, "Distance travelled (m)", graphView,
        "Select a particle to plot distance travelled");
    } else if (app.graphMode === "Velocity") {
      app.velocitySeries.draw(ctx, w, h, "Velocity (m/s)", graphView,
        "Select a particle to plot velocity");
    }
    this.syncLegendControls(series);
  }
}
