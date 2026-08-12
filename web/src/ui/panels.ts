/** Toolbar, tool palette, hint bar and graph dock (DOM). */
import { App, GraphMode, Panel } from "../app";
import { Body } from "../engine/body";
import { SpringLink } from "../engine/links";
import { TOOL_INFO, TOOL_KEYS, Tool } from "../interact/tools";
import { DOCK_H_MAX, DOCK_H_MIN, RefreshGroup, button, countNoun, el, isTouch,
         fmt3g, segmented, slider, splitterDrag } from "./dom";
import { ICONS } from "./icons";
import { GRAPH_HISTORY_S, GRAPH_WINDOW_S, SeriesSample, TimeSeries,
         seriesColor } from "./plots";
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

    const speedWrap = el("div", { class: "speed-ctrl", style: "width:200px;flex:none;" });
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
      if (!timeFocused) {
        const value = app.world.time.toFixed(2);
        if (this.timeInput.value !== value) this.timeInput.value = value;
      }
    } });
    root.append(el("span", { class: "dim", text: "t =" }), this.timeInput,
                el("span", { class: "dim", text: "s" }));

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
    if (this.lastPlaying !== this.app.playing) {
      this.lastPlaying = this.app.playing;
      this.playBtn.innerHTML = this.app.playing ? ICONS.pause : ICONS.play;
      const action = this.app.playing
        ? "Pause the simulation (Space)." : "Start the simulation (Space).";
      this.playBtn.title = action;
      this.playBtn.setAttribute("aria-label", action);
    }
    // Paused state deliberately polls at 20 Hz and wakes on pointer events.
    // Reporting that wake cadence as FPS makes an idle optimisation look like
    // a performance failure (and makes the number follow mouse speed).
    const fps = this.app.playing ? `${this.app.fpsNow.toFixed(0)} fps` : "Idle";
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
    for (const b of app.world.bodies) b.isAnchor ? nAnchors++ : nBodies++;
    const nLinks = app.world.links.length;
    const drift = app.energyDriftText();
    // Performance mode changes what the numbers beside it MEAN - the drift
    // readout will wander, and the substeps in the inspector are not what is
    // running - so it says so rather than leaving that a mystery.
    const items = [countNoun(nBodies, "body", "bodies"),
                   countNoun(nAnchors, "anchor"),
                   countNoun(nLinks, "link"),
                   countNoun(app.world.contacts.length, "contact")];
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
  private hintEl: HTMLElement;
  private liveBtn: HTMLButtonElement;
  private channelBar: HTMLElement;
  private readoutEl: HTMLElement;
  private pinBtn: HTMLButtonElement;
  private clearPinsBtn: HTMLButtonElement;
  private group = new RefreshGroup();
  private syncSplitterAria: () => void = () => {};
  // time-axis view: zoom (span) and scroll-back position (end; null=live)
  private viewSpan = GRAPH_WINDOW_S;
  private viewEnd: number | null = null;
  private driftPercent = true;
  private cursor: SeriesSample | null = null;
  private pins: number[] = [];
  private lastMode: GraphMode = "Off";

  constructor(app: App, root: HTMLElement, splitter: HTMLElement) {
    this.app = app;
    this.root = root;
    this.splitter = splitter;

    const header = el("div", { class: "dock-header" });
    header.append(this.group.add(segmented(["Energy", "Mom.", "Phase", "Drift"],
      () => app.graphMode,
      (v) => app.setGraphMode(v as GraphMode),
      "Which live graph to display (keys 1, 2, 3, 4)")).root);
    this.hintEl = el("span", { class: "dock-hint" });
    header.append(this.hintEl);
    this.liveBtn = el("button", { class: "primary", text: "Live" });
    this.liveBtn.title = "Jump back to the present and follow new data";
    this.liveBtn.hidden = true;
    this.liveBtn.addEventListener("click", () => { this.viewEnd = null; });
    header.append(this.liveBtn);
    header.append(this.group.add(button("", () => this.clearData(),
      { icon: ICONS.trash, style: "ghost",
        tooltip: "Discard all recorded graph data." })).root);
    header.append(this.group.add(button("", () => app.setGraphMode("Off"),
      { icon: ICONS.close, style: "ghost",
        tooltip: "Close the graph dock." })).root);

    this.channelBar = el("div", { class: "graph-controls",
      "aria-label": "Graph channels and units" });
    this.buildChannelControls();

    this.canvas = el("canvas", { tabindex: "0", role: "img",
      "aria-label": "Interactive live graph. Use Left and Right arrows to inspect samples, Enter to pin a point, and Escape to clear measurements." });
    this.readoutEl = el("div", { class: "graph-readout", role: "status",
      "aria-live": "polite", "aria-atomic": "true" });
    this.pinBtn = el("button", { class: "graph-pin-btn", text: "Pin point" });
    this.pinBtn.type = "button";
    this.pinBtn.disabled = true;
    this.pinBtn.addEventListener("click", () => this.pinCursor());
    this.clearPinsBtn = el("button", { class: "graph-pin-btn", text: "Clear points" });
    this.clearPinsBtn.type = "button";
    this.clearPinsBtn.disabled = true;
    this.clearPinsBtn.addEventListener("click", () => this.clearMeasurements());
    const tools = el("div", { class: "graph-measure-tools" },
      this.pinBtn, this.clearPinsBtn);
    const wrap = el("div", { class: "dock-canvas-wrap" }, this.canvas,
      this.readoutEl, tools);
    this.ctx = this.canvas.getContext("2d")!;
    root.append(header, this.channelBar, wrap);

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

  /** Real DOM channel controls replace the old click-only canvas legend.
   * They expose state to assistive technology and remain usable when the
   * graph is too narrow to paint a readable legend. */
  private buildChannelControls(): void {
    const addSeries = (mode: GraphMode, series: TimeSeries,
                       channels: readonly string[], label?: string): void => {
      const group = el("div", { class: "graph-channel-group", "data-mode": mode });
      if (label !== undefined) group.append(el("span", {
        class: "graph-channel-label", text: label,
      }));
      channels.forEach((channel) => {
        const index = series.channels.indexOf(channel);
        const swatch = el("span", { class: "graph-channel-swatch",
          "aria-hidden": "true" });
        swatch.style.background = css(seriesColor(index));
        const control = el("button", { class: "graph-channel", type: "button",
          "data-channel": channel, "aria-pressed": "true",
          "aria-label": `Hide ${channel} channel` }, swatch,
          el("span", { text: channel }));
        control.addEventListener("click", () => {
          series.toggleChannel(channel);
          this.updateChannelControls();
        });
        group.append(control);
      });
      this.channelBar.append(group);
    };
    addSeries("Energy", this.app.energySeries, ["KE", "PE", "Total"]);
    addSeries("Mom.", this.app.momentumSeries, ["|p|", "px", "py"], "Linear");
    addSeries("Mom.", this.app.momentumSeries, ["L"], "Angular");

    const unitGroup = el("div", { class: "graph-channel-group graph-unit-group",
      "data-mode": "Drift" }, el("span", {
        class: "graph-channel-label", text: "Units",
      }));
    for (const [label, percent] of [["%", true], ["J", false]] as const) {
      const control = el("button", { class: "graph-channel graph-unit",
        type: "button", text: label, "data-unit": percent ? "percent" : "joules" });
      control.addEventListener("click", () => {
        this.driftPercent = percent;
        this.cursor = null;
        this.pins = [];
        this.lastDrawSig = "";
        this.updateChannelControls();
      });
      unitGroup.append(control);
    }
    this.channelBar.append(unitGroup);
  }

  private updateChannelControls(): void {
    for (const group of this.channelBar.querySelectorAll<HTMLElement>("[data-mode]")) {
      group.hidden = group.dataset.mode !== this.app.graphMode;
    }
    for (const control of this.channelBar.querySelectorAll<HTMLButtonElement>(
      ".graph-channel[data-channel]")) {
      const channel = control.dataset.channel!;
      const series = control.closest<HTMLElement>("[data-mode]")?.dataset.mode === "Energy"
        ? this.app.energySeries : this.app.momentumSeries;
      const visible = series.isChannelVisible(channel);
      control.setAttribute("aria-pressed", String(visible));
      control.setAttribute("aria-label", `${visible ? "Hide" : "Show"} ${channel} channel`);
    }
    for (const control of this.channelBar.querySelectorAll<HTMLButtonElement>(".graph-unit")) {
      const active = (control.dataset.unit === "percent") === this.driftPercent;
      control.classList.toggle("active", active);
      control.setAttribute("aria-pressed", String(active));
    }
  }

  /** Wheel zooms the time axis, drag scrolls retained history, hover/focus
   * inspects exact samples, and click/Enter pins a two-point measurement. */
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
      if (dragId !== e.pointerId) {
        this.setCursorFromClientX(e.clientX);
        return;
      }
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
        this.setCursorFromClientX(e.clientX);
        this.pinCursor();
      }
    };
    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", () => { dragId = null; });
    this.canvas.addEventListener("pointerleave", () => {
      if (document.activeElement !== this.canvas) this.setCursor(null);
    });
    this.canvas.addEventListener("keydown", (e) => {
      const series = this.activeSeries();
      if (series === undefined || series.count === 0) return;
      if (e.key === "Escape") {
        this.clearMeasurements();
        e.preventDefault();
        return;
      }
      if (e.key === "Enter") {
        this.pinCursor();
        e.preventDefault();
        return;
      }
      let index = this.cursor?.index ?? series.count - 1;
      if (e.key === "ArrowLeft") index--;
      else if (e.key === "ArrowRight") index++;
      else if (e.key === "Home") index = 0;
      else if (e.key === "End") index = series.count - 1;
      else return;
      index = Math.max(0, Math.min(series.count - 1, index));
      this.setCursor(series.nearest(series.timeAt(index), this.activeChannels()));
      e.preventDefault();
    });
  }

  private graphView() { return { end: this.viewEnd, span: this.viewSpan }; }

  private activeChannels(): string[] {
    if (this.app.graphMode === "Energy") return ["KE", "PE", "Total"];
    if (this.app.graphMode === "Mom.") return ["|p|", "px", "py", "L"];
    if (this.app.graphMode === "Drift") return ["dE"];
    return [];
  }

  private setCursorFromClientX(clientX: number): void {
    const series = this.activeSeries();
    if (series === undefined || series.count === 0) {
      this.setCursor(null);
      return;
    }
    const r = this.canvas.getBoundingClientRect();
    let localX = clientX - r.left;
    let localW = r.width;
    if (this.app.graphMode === "Mom." && r.width >= 620) {
      const panelW = (r.width - 8) / 2;
      if (localX > panelW + 8) localX -= panelW + 8;
      localW = panelW;
    }
    const left = localW < 360 ? 42 : 52;
    const frac = (localX - left) / Math.max(1, localW - left - 10);
    this.setCursor(series.nearestAtFraction(frac, this.graphView(), this.activeChannels()));
  }

  private setCursor(sample: SeriesSample | null): void {
    if (this.cursor?.t === sample?.t && this.cursor?.index === sample?.index) return;
    this.cursor = sample;
    this.lastDrawSig = "";
    this.updateMeasurementReadout();
  }

  private pinCursor(): void {
    if (this.cursor === null) return;
    if (this.pins.length >= 2) this.pins = [];
    this.pins.push(this.cursor.t);
    this.lastDrawSig = "";
    this.updateMeasurementReadout();
  }

  private clearMeasurements(): void {
    this.cursor = null;
    this.pins = [];
    this.lastDrawSig = "";
    this.updateMeasurementReadout();
  }

  private updateMeasurementReadout(): void {
    const series = this.activeSeries();
    this.pinBtn.disabled = this.cursor === null;
    this.clearPinsBtn.disabled = this.pins.length === 0 && this.cursor === null;
    if (series === undefined) {
      this.readoutEl.textContent = "";
      return;
    }
    const channels = this.activeChannels().filter((c) => series.isChannelVisible(c));
    const sampleText = (sample: SeriesSample): string => {
      const values = channels.map((c) => `${c} ${fmt3g(sample.values[c])}`).join(" · ");
      return `t ${fmt3g(sample.t)} s${values ? ` · ${values}` : ""}`;
    };
    const parts: string[] = [];
    if (this.cursor !== null) parts.push(sampleText(this.cursor));
    const a = this.pins[0] === undefined ? null : series.nearest(this.pins[0], channels);
    const b = this.pins[1] === undefined ? null : series.nearest(this.pins[1], channels);
    if (a !== null && b === null) parts.push(`A: ${sampleText(a)}`);
    if (a !== null && b !== null) {
      const deltas = channels.map((c) => `Delta ${c} ${fmt3g(b.values[c] - a.values[c])}`).join(" · ");
      parts.push(`A-B: Delta t ${fmt3g(b.t - a.t)} s${deltas ? ` · ${deltas}` : ""}`);
    }
    this.readoutEl.textContent = parts.join("   |   ");
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
    this.app.energyDriftPercentSeries.clear();
    this.app.energyDriftAbsoluteSeries.clear();
    this.app.phasePlot.clear();
    this.viewEnd = null;
    this.clearMeasurements();
  }

  /** The time series the current mode plots, or undefined for Phase/Off. */
  private activeSeries(): TimeSeries | undefined {
    if (this.app.graphMode === "Energy") return this.app.energySeries;
    if (this.app.graphMode === "Mom.") return this.app.momentumSeries;
    if (this.app.graphMode === "Drift") {
      return this.driftPercent
        ? this.app.energyDriftPercentSeries : this.app.energyDriftAbsoluteSeries;
    }
    return undefined;
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
    if (app.graphMode === "Drift") {
      const drift = this.driftPercent
        ? app.energyDriftPercentSeries : app.energyDriftAbsoluteSeries;
      const stats = drift.stats("dE");
      if (stats !== null) {
        const unit = this.driftPercent ? "%" : " J";
        return `${app.perfMode ? "Approx. · " : ""}` +
          `Current ${fmt3g(stats.current)}${unit} · max |dE| ` +
          `${fmt3g(stats.maxAbs)}${unit} · 5 s mean |dE| ` +
          `${fmt3g(stats.rollingAbs)}${unit}`;
      }
      return app.perfMode ? "Performance mode uses approximate energy diagnostics"
        : "Numerical energy change relative to this scene's starting state";
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
    if (this.lastMode !== app.graphMode) {
      this.lastMode = app.graphMode;
      this.cursor = null;
      this.pins = [];
      this.viewEnd = null;
      this.lastDrawSig = "";
    }
    // A zero-energy baseline has no meaningful percentage denominator.
    if (app.graphMode === "Drift" && this.driftPercent &&
        Math.abs(app.baselineEnergy ?? 0) < 1e-9) {
      this.driftPercent = false;
    }
    this.updateChannelControls();
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
    this.updateMeasurementReadout();

    // redraw only when something it depends on changed - between throttled
    // samples and while paused the canvas is already correct. An easing
    // autoscale keeps redrawing static data until the animation settles.
    const phaseBody = app.selection.find((o): o is Body => o instanceof Body);
    const rev = series !== undefined ? series.rev
      : `${app.phasePlot.rev}:${phaseBody?.name ?? ""}`;
    const sig = `${app.graphMode}:${bw}x${bh}:${rev}:p${theme.paletteRevision}:` +
                 `${this.viewEnd ?? "live"}:${this.viewSpan}:u${this.driftPercent}:` +
                 `c${this.cursor?.t ?? "-"}:m${this.pins.join(",")}`;
    if (sig === this.lastDrawSig && !(series?.easing ?? false)) return;
    this.lastDrawSig = sig;

    const graphView = { end: this.viewEnd, span: this.viewSpan };
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (app.graphMode === "Energy") {
      app.energySeries.draw(ctx, w, h, "Energy (J)", graphView,
        ["KE", "PE", "Total"], false);
    } else if (app.graphMode === "Mom.") {
      // Linear and angular momentum have different dimensions and normally
      // very different magnitudes. Small multiples prevent either from
      // flattening the other against a shared, physically meaningless scale.
      const gap = 8;
      if (w >= 620) {
        const leftW = Math.floor((w - gap) / 2);
        const rightW = w - leftW - gap;
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, leftW, h); ctx.clip();
        app.momentumSeries.draw(ctx, leftW, h, "Linear momentum (kg m/s)",
          graphView, ["|p|", "px", "py"], false, false);
        ctx.restore();
        ctx.save();
        ctx.translate(leftW + gap, 0);
        ctx.beginPath(); ctx.rect(0, 0, rightW, h); ctx.clip();
        app.momentumSeries.draw(ctx, rightW, h, "Angular momentum (kg m2/s)",
          graphView, ["L"], false, true);
        ctx.restore();
      } else {
        const topH = Math.max(1, Math.floor((h - gap) / 2));
        const bottomH = Math.max(1, h - topH - gap);
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, w, topH); ctx.clip();
        app.momentumSeries.draw(ctx, w, topH, "Linear momentum (kg m/s)",
          graphView, ["|p|", "px", "py"], false, false);
        ctx.restore();
        ctx.save();
        ctx.translate(0, topH + gap);
        ctx.beginPath(); ctx.rect(0, 0, w, bottomH); ctx.clip();
        app.momentumSeries.draw(ctx, w, bottomH, "Angular momentum (kg m2/s)",
          graphView, ["L"], false, true);
        ctx.restore();
      }
    } else if (app.graphMode === "Drift") {
      const drift = this.driftPercent
        ? app.energyDriftPercentSeries : app.energyDriftAbsoluteSeries;
      drift.draw(ctx, w, h, this.driftPercent ? "Energy drift (%)" : "Energy drift (J)",
        graphView, ["dE"], false, false, true);
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
    }
    this.drawMeasurementLines(ctx, w, h, series, graphView);
  }

  private drawMeasurementLines(ctx: CanvasRenderingContext2D, w: number, h: number,
                               series: TimeSeries | undefined,
                               view: { end: number | null; span: number }): void {
    if (series === undefined || series.count === 0) return;
    const t1 = view.end ?? series.lastT;
    const t0 = view.end === null
      ? Math.max(series.firstT, t1 - view.span) : t1 - view.span;
    const ranges: Array<[number, number]> = [];
    if (this.app.graphMode === "Mom." && w >= 620) {
      const panelW = Math.floor((w - 8) / 2);
      const left = panelW < 360 ? 42 : 52;
      ranges.push([left, panelW - 10], [panelW + 8 + left, w - 10]);
    } else {
      const left = w < 360 ? 42 : 52;
      ranges.push([left, w - 10]);
    }
    const xFor = (t: number, range: [number, number]): number => range[0] +
      ((t - t0) / Math.max(1e-9, t1 - t0)) * (range[1] - range[0]);
    ctx.save();
    ctx.lineWidth = 1;
    for (let i = 0; i < this.pins.length; i++) {
      for (const range of ranges) {
        const x = xFor(this.pins[i], range);
        if (x < range[0] || x > range[1]) continue;
        ctx.strokeStyle = css(i === 0 ? theme.WARN : theme.ACCENT);
        ctx.setLineDash([5, 3]);
        ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, h - 18); ctx.stroke();
      }
    }
    if (this.cursor !== null) {
      for (const range of ranges) {
        const x = xFor(this.cursor.t, range);
        if (x < range[0] || x > range[1]) continue;
        ctx.strokeStyle = css(theme.TEXT_DIM);
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, h - 18); ctx.stroke();
      }
    }
    ctx.restore();
  }
}
