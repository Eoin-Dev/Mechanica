/** Responsive, detached graph inspection and portable image rendering. */
import type { GraphDataSnapshot } from "./graph-data";
import { chartIndices, chartRange, chartTicks, graphAxes, graphFraction, graphValue, zoomChartWindow, panChartWindow,
         nearestChartPoint, type ChartAxes, type ChartPoint, type ChartRange } from "./graph-chart";
import { button, el } from "./dom";
import * as theme from "./theme";

const NS = "http://www.w3.org/2000/svg";
const DASHES = ["", "8 4", "2 4", "10 4 2 4"];
let nextClipId = 0;
interface ChartLayout {
  width: number; height: number; font: number;
  left: number; top: number; plotWidth: number; plotHeight: number;
  x: ChartRange; y: ChartRange;
}
function svgNode<K extends keyof SVGElementTagNameMap>(tag: K,
              attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function colour(index: number): string {
  return (theme.themeName === "light"
    ? ["#005fa5", "#1d7a3d", "#916b00", "#ae2d60"]
    : ["#72c0ff", "#79d29a", "#ffd366", "#ff8fc1"])[index % 4];
}
function tick(value: number): string { return String(Number(value.toPrecision(3))); }
function value(value: number): string { return String(Number(value.toPrecision(12))); }
function layout(data: GraphDataSnapshot, axes: ChartAxes, width: number, height: number, font: number,
                windows?: { x: ChartRange; y: ChartRange }): ChartLayout {
  const visible = (range: ChartRange, window?: ChartRange): ChartRange => window
    ? { min: graphValue(window.min, range), max: graphValue(window.max, range) } : range;
  const y = visible(chartRange(data, axes.ys), windows?.y);
  const x = visible(chartRange(data, [axes.x]), windows?.x);
  const maxTick = Math.max(...chartTicks(y, 5).map(n => tick(n).length));
  const left = Math.min(width * 0.42, maxTick * font * 0.6 + 16);
  const wrapped = axes.yLabel.length * font * 0.57 > width - 24;
  const top = 18 + font * (wrapped ? 3 : 2), bottom = 18 + font * 3;
  return { width, height, font, left, top,
    plotWidth: Math.max(1, width - left - 16), plotHeight: Math.max(1, height - top - bottom), x, y };
}
function px(n: number, m: ChartLayout): number { return m.left + graphFraction(n, m.x) * m.plotWidth; }
function py(n: number, m: ChartLayout): number { return m.top + (1 - graphFraction(n, m.y)) * m.plotHeight; }

/** Explicit paint attributes also make the exported SVG independent of page CSS. */
function paint(data: GraphDataSnapshot, axes: ChartAxes, m: ChartLayout,
               fontFamily = "system-ui, sans-serif"): SVGSVGElement {
  const svg = svgNode("svg", { xmlns: NS, viewBox: `0 0 ${m.width} ${m.height}`,
    width: m.width, height: m.height, role: "img", "aria-label": `${data.title}: ${axes.xLabel} against ${axes.yLabel}` });
  const bg = theme.css(theme.PANEL_LIGHT), grid = theme.css(theme.OUTLINE), text = theme.css(theme.TEXT);
  svg.append(svgNode("rect", { width: m.width, height: m.height, fill: bg, rx: 8 }));
  const textNode = (x: number, y: number, content: string, anchor = "start", size = m.font): SVGTextElement =>
    svgNode("text", { x, y, fill: text, "font-size": size, "font-family": fontFamily,
      "text-anchor": anchor }, content);
  const split = /^(.*) (\([^)]*\))$/.exec(axes.yLabel);
  if (split && axes.yLabel.length * m.font * 0.57 > m.width - 24) {
    svg.append(textNode(12, 8 + m.font, split[1]), textNode(12, 12 + m.font * 2, split[2]));
  } else svg.append(textNode(12, 8 + m.font, axes.yLabel));
  svg.append(textNode(m.left + m.plotWidth / 2, m.height - 9, axes.xLabel, "middle"));
  const count = Math.max(2, Math.min(6, Math.floor(m.plotWidth / (m.font * 7))));
  for (const n of chartTicks(m.x, count)) {
    const x = px(n, m);
    svg.append(svgNode("line", { x1: x, x2: x, y1: m.top, y2: m.top + m.plotHeight, stroke: grid }),
      textNode(x, m.top + m.plotHeight + m.font + 8, tick(n),
        x < m.left + 4 ? "start" : x > m.left + m.plotWidth - 4 ? "end" : "middle"));
  }
  for (const n of chartTicks(m.y, 5)) {
    const y = py(n, m);
    svg.append(svgNode("line", { x1: m.left, x2: m.left + m.plotWidth, y1: y, y2: y, stroke: grid }),
      textNode(m.left - 8, y + m.font * 0.35, tick(n), "end"));
  }
  for (const [isX, range] of [[true, m.x], [false, m.y]] as const) if (range.min <= 0 && range.max >= 0) {
    const at = isX ? px(0, m) : py(0, m);
    svg.append(svgNode("line", { x1: isX ? at : m.left, x2: isX ? at : m.left + m.plotWidth,
      y1: isX ? m.top : at, y2: isX ? m.top + m.plotHeight : at,
      stroke: theme.css(theme.TEXT_DIM), "stroke-opacity": 0.65, "stroke-dasharray": "3 4" }));
  }
  svg.append(svgNode("path", { d: `M${m.left} ${m.top}V${m.top + m.plotHeight}H${m.left + m.plotWidth}`,
    fill: "none", stroke: theme.css(theme.TEXT_DIM), "stroke-width": 1.3 }));
  const clipId = `graph-plot-clip-${nextClipId++}`;
  const clip = svgNode("clipPath", { id: clipId });
  clip.append(svgNode("rect", { x: m.left, y: m.top, width: m.plotWidth, height: m.plotHeight }));
  svg.append(svgNode("defs", {}, undefined)); svg.lastChild!.appendChild(clip);
  const curves = svgNode("g", { "clip-path": `url(#${clipId})` }); svg.append(curves);
  for (const column of axes.ys) {
    const indices = chartIndices(data, column, axes.timeSeries ? 1600 : 2000);
    let path = "", count = 0;
    for (const i of indices) {
      const row = data.rows[i];
      if (!Number.isFinite(row[axes.x]) || !Number.isFinite(row[column])) { count = 0; continue; }
      path += `${count++ === 0 ? "M" : "L"}${px(row[axes.x], m).toFixed(2)} ${py(row[column], m).toFixed(2)}`;
    }
    curves.append(svgNode("path", { d: path, fill: "none", stroke: colour(column - 1),
      "stroke-width": 2.3, "stroke-linejoin": "round", "stroke-linecap": "round",
      "stroke-dasharray": DASHES[(column - 1) % 4], "data-channel": data.columns[column].csv }));
    if (data.rows.length === 1) curves.append(svgNode("circle", {
      cx: px(data.rows[0][axes.x], m), cy: py(data.rows[0][column], m), r: 3.5, fill: colour(column - 1) }));
  }
  return svg;
}

export class GraphSnapshotChart {
  readonly root: HTMLElement;
  onChange: () => void = () => {};
  get canExport(): boolean { return Boolean(this.data?.rows.length && this.axes?.ys.length); }
  private host: HTMLElement;
  private legend: HTMLElement;
  private reading: HTMLElement;
  private data: GraphDataSnapshot | null = null;
  private variant = 0;
  private hidden = new Set<number>();
  private axes: ChartAxes | null = null;
  private geometry: ChartLayout | null = null;
  private svg: SVGSVGElement | null = null;
  private marker: SVGGElement | null = null;
  private selected: ChartPoint | null = null;
  private observer: ResizeObserver | null = null;
  private preferences: MutationObserver | null = null;
  private windows = { x: { min: 0, max: 1 }, y: { min: 0, max: 1 } };
  private zoomIn: HTMLButtonElement;
  private zoomOut: HTMLButtonElement;
  private resetZoom: HTMLButtonElement;
  private zoomLevel: HTMLElement;
  private pan: { pointer: number; x: number; y: number; width: number; height: number;
    windows: { x: ChartRange; y: ChartRange } } | null = null;
  private panFrame = 0;

  constructor() {
    this.host = el("div", { class: "graph-chart-surface", tabindex: "0", role: "group" });
    this.legend = el("div", { class: "graph-chart-legend", role: "group", "aria-label": "Graph channels" });
    this.reading = el("div", { class: "graph-chart-reading", "aria-live": "off", "aria-atomic": "true" });
    this.zoomIn = button("+", () => this.zoom(2), { tooltip: "Zoom in graph" }).root as HTMLButtonElement;
    this.zoomOut = button("−", () => this.zoom(0.5), { tooltip: "Zoom out graph" }).root as HTMLButtonElement;
    this.resetZoom = button("Fit", () => this.fit(), { tooltip: "Reset graph zoom" }).root as HTMLButtonElement;
    this.zoomIn.setAttribute("aria-label", "Zoom in graph");
    this.zoomOut.setAttribute("aria-label", "Zoom out graph");
    this.resetZoom.setAttribute("aria-label", "Fit graph to all samples");
    this.zoomLevel = el("span", { class: "dim graph-zoom-level", text: "1×", "aria-live": "polite" });
    const tools = el("div", { class: "graph-chart-tools", role: "group", "aria-label": "Graph zoom" },
      this.zoomOut, this.zoomIn, this.resetZoom, this.zoomLevel);
    this.root = el("div", { class: "graph-chart" }, tools, this.host, this.legend, this.reading);
    this.host.addEventListener("pointerdown", event => this.startPan(event));
    this.host.addEventListener("pointermove", event => {
      if (this.pan !== null) this.movePan(event); else this.inspect(event);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
      this.host.addEventListener(type, event => { if (this.pan?.pointer === event.pointerId) this.endPan(); });
    }
    this.host.addEventListener("pointerleave", () => { if (this.pan === null) this.showPoint(null); });
    this.host.addEventListener("keydown", event => this.key(event));
    this.host.addEventListener("wheel", event => this.wheel(event), { passive: false });
    this.host.addEventListener("blur", () => this.showPoint(null));
  }

  set(data: GraphDataSnapshot, variant: number): void {
    this.endPan();
    this.data = data; this.variant = variant; this.hidden.clear(); this.selected = null;
    this.windows = { x: { min: 0, max: 1 }, y: { min: 0, max: 1 } };
    this.host.setAttribute("aria-label", `${data.title} graph. Use arrow keys to inspect recorded points. Zoom in to drag the graph; Shift and arrow keys also pan.`);
    this.legend.replaceChildren();
    for (const column of graphAxes(data, variant).ys) {
      const control = button(data.columns[column].label, () => {
        if (this.hidden.has(column)) this.hidden.delete(column); else this.hidden.add(column);
        control.setAttribute("aria-pressed", String(!this.hidden.has(column)));
        this.draw();
      }).root;
      control.setAttribute("aria-pressed", "true");
      control.classList.add("graph-chart-channel");
      const key = el("span", { class: "graph-chart-key", "aria-hidden": "true" });
      key.style.borderColor = colour(column - 1);
      key.style.borderStyle = column === 1 ? "solid" : column === 2 ? "dashed" : "dotted";
      control.prepend(key); this.legend.append(control);
    }
    this.draw();
  }

  observe(): void {
    if (typeof ResizeObserver !== "undefined" && this.observer === null) {
      this.observer = new ResizeObserver(() => { if (this.data && !this.root.hidden) this.draw(); });
      this.observer.observe(this.host);
    }
    if (typeof MutationObserver !== "undefined" && this.preferences === null) {
      this.preferences = new MutationObserver(() => { if (this.data && !this.root.hidden) this.draw(); });
      this.preferences.observe(document.documentElement, {
        attributes: true, attributeFilter: ["style", "data-theme", "data-studio"],
      });
      this.preferences.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });
    }
    this.draw();
  }

  clear(): void {
    this.endPan();
    this.observer?.disconnect(); this.observer = null;
    this.preferences?.disconnect(); this.preferences = null;
    this.data = null; this.axes = null; this.geometry = null; this.svg = null;
    this.marker = null; this.selected = null; this.hidden.clear();
    this.host.replaceChildren(); this.legend.replaceChildren(); this.reading.replaceChildren();
    this.zoomIn.disabled = this.zoomOut.disabled = this.resetZoom.disabled = true;
  }

  private draw(): void {
    if (this.data === null) return;
    const base = graphAxes(this.data, this.variant);
    this.legend.querySelectorAll<HTMLElement>(".graph-chart-key").forEach((key, index) => {
      key.style.borderColor = colour(base.ys[index] - 1);
    });
    this.axes = { ...base, ys: base.ys.filter(column => !this.hidden.has(column)) };
    const style = getComputedStyle(this.host);
    const fontScale = Number(style.getPropertyValue("--fs")) || 1;
    this.geometry = layout(this.data, this.axes, this.host.clientWidth || 640,
      this.host.clientHeight || 320, 12 * Math.max(1, Math.min(2, fontScale)), this.windows);
    this.svg = paint(this.data, this.axes, this.geometry, style.fontFamily || "system-ui, sans-serif");
    this.marker = svgNode("g", { "aria-hidden": "true", "pointer-events": "none",
      "clip-path": `url(#${this.svg.querySelector("clipPath")!.id})` });
    this.svg.append(this.marker); this.host.replaceChildren(this.svg);
    this.showPoint(null); this.onChange();
    const factor = 1 / (this.windows.x.max - this.windows.x.min);
    this.host.classList.toggle("can-pan", factor > 1);
    this.zoomLevel.textContent = `${Number(factor.toPrecision(3))}×`;
    this.zoomOut.disabled = !this.canExport || factor <= 1;
    this.resetZoom.disabled = factor <= 1;
    this.zoomIn.disabled = !this.canExport || factor >= 1e6;
    if (!this.data.rows.length || !this.axes.ys.length) {
      this.reading.textContent = this.data.rows.length ? "Choose a channel to display its graph." : "No recorded points.";
    }
  }

  private inspect(event: PointerEvent): void {
    if (!this.data || !this.axes || !this.geometry || !this.svg) return;
    const rect = this.svg.getBoundingClientRect(), m = this.geometry;
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) * m.width / rect.width;
    const y = (event.clientY - rect.top) * m.height / rect.height;
    if (x < m.left || x > m.left + m.plotWidth || y < m.top || y > m.top + m.plotHeight) {
      this.showPoint(null); return;
    }
    this.reading.setAttribute("aria-live", "off");
    this.showPoint(nearestChartPoint(this.data, this.axes, (x - m.left) / m.plotWidth,
      1 - (y - m.top) / m.plotHeight, m.plotWidth, m.plotHeight, { x: m.x, y: m.y }));
  }

  private key(event: KeyboardEvent): void {
    if (!this.data?.rows.length || !this.axes?.ys.length) return;
    if (event.shiftKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); this.endPan();
      const dx = (this.windows.x.max - this.windows.x.min) * 0.1;
      const dy = (this.windows.y.max - this.windows.y.min) * 0.1;
      this.windows = {
        x: panChartWindow(this.windows.x, event.key === "ArrowLeft" ? -dx : event.key === "ArrowRight" ? dx : 0),
        y: panChartWindow(this.windows.y, event.key === "ArrowDown" ? -dy : event.key === "ArrowUp" ? dy : 0),
      };
      this.draw(); return;
    }
    if (["+", "=", "-", "0"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "0") this.fit(); else this.zoom(event.key === "-" ? 0.5 : 2);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    let index = this.selected?.row ?? 0;
    let channel = this.axes.ys.indexOf(this.selected?.column ?? this.axes.ys[0]);
    if (event.key === "ArrowLeft") index--;
    if (event.key === "ArrowRight") index++;
    if (event.key === "Home") index = 0;
    if (event.key === "End") index = this.data.rows.length - 1;
    if (event.key === "ArrowUp") channel--;
    if (event.key === "ArrowDown") channel++;
    index = Math.max(0, Math.min(this.data.rows.length - 1, index));
    channel = (channel + this.axes.ys.length) % this.axes.ys.length;
    const column = this.axes.ys[channel], row = this.data.rows[index];
    this.reading.setAttribute("aria-live", "polite");
    this.showPoint({ row: index, column, x: row[this.axes.x], y: row[column], time: row[0] });
  }

  private zoom(factor: number, x = 0.5, y = 0.5): void {
    if (!this.canExport) return;
    this.endPan();
    this.windows = { x: zoomChartWindow(this.windows.x, factor, x),
      y: zoomChartWindow(this.windows.y, factor, y) };
    this.draw();
  }

  private fit(): void {
    this.endPan();
    this.windows = { x: { min: 0, max: 1 }, y: { min: 0, max: 1 } }; this.draw();
  }

  private wheel(event: WheelEvent): void {
    if (!this.geometry || !this.svg || !this.canExport || event.deltaY === 0) return;
    const rect = this.svg.getBoundingClientRect(), m = this.geometry;
    if (!rect.width || !rect.height) return;
    const x = ((event.clientX - rect.left) * m.width / rect.width - m.left) / m.plotWidth;
    const y = 1 - ((event.clientY - rect.top) * m.height / rect.height - m.top) / m.plotHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    event.preventDefault();
    this.zoom(Math.exp(-Math.max(-500, Math.min(500, event.deltaY)) * 0.003), x, y);
  }

  private startPan(event: PointerEvent): void {
    if (event.button !== 0 || this.pan !== null || !this.geometry || !this.svg ||
        !this.canExport || this.windows.x.max - this.windows.x.min >= 1) return;
    const rect = this.svg.getBoundingClientRect(), m = this.geometry;
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) * m.width / rect.width;
    const y = (event.clientY - rect.top) * m.height / rect.height;
    if (x < m.left || x > m.left + m.plotWidth || y < m.top || y > m.top + m.plotHeight) return;
    event.preventDefault(); event.stopPropagation();
    this.host.focus({ preventScroll: true });
    this.pan = { pointer: event.pointerId, x: event.clientX, y: event.clientY,
      width: m.plotWidth * rect.width / m.width, height: m.plotHeight * rect.height / m.height,
      windows: { x: { ...this.windows.x }, y: { ...this.windows.y } } };
    this.host.setPointerCapture?.(event.pointerId);
    this.host.classList.add("panning"); this.showPoint(null);
  }

  private movePan(event: PointerEvent): void {
    const pan = this.pan;
    if (pan === null || event.pointerId !== pan.pointer) return;
    event.preventDefault();
    this.windows = {
      x: panChartWindow(pan.windows.x, -(event.clientX - pan.x) / pan.width * (pan.windows.x.max - pan.windows.x.min)),
      y: panChartWindow(pan.windows.y, (event.clientY - pan.y) / pan.height * (pan.windows.y.max - pan.windows.y.min)),
    };
    // Pointer events can arrive faster than paints. Keep one redraw per frame.
    if (!this.panFrame) this.panFrame = requestAnimationFrame(() => { this.panFrame = 0; this.draw(); });
  }

  private endPan(): void {
    const pan = this.pan;
    this.pan = null;
    if (this.panFrame) { cancelAnimationFrame(this.panFrame); this.panFrame = 0; this.draw(); }
    this.host.classList.remove("panning");
    if (pan && this.host.hasPointerCapture?.(pan.pointer)) this.host.releasePointerCapture(pan.pointer);
  }

  private showPoint(point: ChartPoint | null): void {
    this.selected = point; this.marker?.replaceChildren();
    if (!point || !this.data || !this.axes || !this.geometry || !this.marker) {
      this.reading.textContent = "Hover or use arrow keys to inspect recorded points." +
        (this.windows.x.max - this.windows.x.min < 1 ? " Drag to pan; Shift + arrows also pan." : ""); return;
    }
    const m = this.geometry, x = px(point.x, m), y = py(point.y, m), ink = colour(point.column - 1);
    this.marker.append(svgNode("line", { x1: x, x2: x, y1: m.top, y2: m.top + m.plotHeight,
      stroke: theme.css(theme.TEXT_DIM), "stroke-dasharray": "3 4" }),
      svgNode("circle", { cx: x, cy: y, r: 5, fill: theme.css(theme.PANEL_LIGHT), stroke: ink, "stroke-width": 2.5 }));
    this.reading.replaceChildren(el("span", { class: "dim", text: `Point ${point.row + 1}:` }),
      el("strong", { text: `${this.data.columns[this.axes.x].label}: ${value(point.x)}`,
        title: String(point.x) }),
      el("strong", { text: `${this.data.columns[point.column].label}: ${value(point.y)}`,
        title: String(point.y) }));
    if (!this.axes.timeSeries) this.reading.append(el("span", { text: `Time (s): ${value(point.time)}`, title: String(point.time) }));
  }

  async image(): Promise<Blob> {
    if (!this.data?.rows.length || !this.axes?.ys.length) throw new Error("There are no visible samples to export.");
    const data = this.data, axes = this.axes;
    const m = layout(data, axes, 1200, 620, 15, this.windows);
    const svg = paint(data, axes, m);
    svg.setAttribute("height", "720"); svg.setAttribute("viewBox", "0 0 1200 720");
    svg.insertBefore(svgNode("rect", { width: 1200, height: 720, fill: theme.css(theme.PANEL_LIGHT) }), svg.firstChild);
    const label = (x: number, y: number, text: string): SVGTextElement => svgNode("text", {
      x, y, fill: theme.css(theme.TEXT), "font-family": "system-ui, sans-serif", "font-size": 16 }, text);
    svg.append(label(24, 651, `${data.title} · ${data.rows.length} recorded samples`));
    let x = 24;
    for (const column of axes.ys) {
      svg.append(svgNode("line", { x1: x, x2: x + 32, y1: 676, y2: 676,
        stroke: colour(column - 1), "stroke-width": 3, "stroke-dasharray": DASHES[(column - 1) % 4] }),
        label(x + 42, 681, data.columns[column].label));
      x += 260;
    }
    if (data.body) svg.append(label(24, 708, `Particle ID ${data.body.id}` + (data.body.reference
      ? ` · Reference: ${value(data.body.reference.time)} s; (${value(data.body.reference.x)}, ${value(data.body.reference.y)}) m` : "")));
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve(); image.onerror = () => reject(new Error("Could not render the graph image."));
        image.src = url;
      });
      const canvas = document.createElement("canvas"); canvas.width = 2400; canvas.height = 1440;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Graph image export is unavailable.");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
        if (blob) resolve(blob); else reject(new Error("Could not encode the graph image."));
      }, "image/png"));
    } finally { URL.revokeObjectURL(url); }
  }
}
