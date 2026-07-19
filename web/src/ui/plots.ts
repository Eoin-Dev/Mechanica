/** Live plots: rolling time-series (energy, momentum) and phase-space plot. */
import { Color } from "../engine/body";
import { isTouch } from "./dom";
import * as theme from "./theme";
import { css } from "./theme";

export const SERIES_COLORS: Color[] = [
  theme.ACCENT, theme.GOOD, theme.WARN, theme.BAD,
  [170, 140, 230], [110, 200, 210],
];

function fmt(v: number): string {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e-4 && abs < 1e6) return String(parseFloat(v.toPrecision(3)));
  return v.toExponential(2);
}

interface LegendHit {
  x: number;
  y: number;
  w: number;
  h: number;
  channel: string;
}

/** How much simulation time the rolling window shows. Scrolling starts
 * once this span is filled, so it doubles as "how long the plot squeezes
 * before it starts moving". */
export const GRAPH_WINDOW_S = 15.0;

/** Vertex budget for the window - roughly one sample per pixel on a wide
 * plot. The app derives its sampling cadence from this so drawing cost is
 * bounded no matter the display's refresh rate. */
export const GRAPH_MAX_POINTS = 1200;

/** Rolling window of named channels sampled against simulation time.
 *
 * Channels can be toggled on/off by clicking their legend entries; hidden
 * channels are excluded from the autoscale so the visible ones fill the
 * plot.
 */
export class TimeSeries {
  channels: string[];
  t: number[] = [];
  data: Map<string, number[]>;
  hidden = new Set<string>();
  /** Bumped on every mutation so renderers can skip unchanged frames. */
  rev = 0;
  /** True while the autoscale is still animating toward its target. */
  easing = false;
  private windowS: number;
  private maxlen: number;
  private legendHits: LegendHit[] = [];
  private view: [number, number] | null = null; // smoothed y-range

  constructor(channels: string[], windowS = GRAPH_WINDOW_S, maxlen = 3000) {
    this.channels = channels;
    this.windowS = windowS;
    this.maxlen = maxlen;
    this.data = new Map(channels.map((c) => [c, []]));
  }

  clear(): void {
    this.t.length = 0;
    for (const d of this.data.values()) d.length = 0;
    this.view = null;
    this.rev++;
  }

  /** Drop samples newer than time t (stepping the simulation back). */
  truncate(t: number): void {
    while (this.t.length > 0 && this.t[this.t.length - 1] > t + 1e-9) {
      this.t.pop();
      for (const d of this.data.values()) d.pop();
      this.rev++;
    }
  }

  add(t: number, values: Record<string, number>): void {
    // a single inf/NaN sample (a body mid-blow-up) would wreck the
    // autoscale for the whole rolling window: drop it instead
    if (!Number.isFinite(t)) return;
    for (const v of Object.values(values)) {
      if (!Number.isFinite(v)) return;
    }
    if (this.t.length > 0 && t < this.t[this.t.length - 1]) {
      this.clear(); // simulation was reset/rewound
    }
    // a re-sample at the same time (seeding an opened graph, or a frame
    // where the clock didn't advance) updates in place instead of stacking
    // duplicate points
    const last = this.t.length - 1;
    if (last >= 0 && t === this.t[last]) {
      for (const c of this.channels) {
        this.data.get(c)![last] = values[c] ?? 0.0;
      }
      this.rev++;
      return;
    }
    this.t.push(t);
    for (const c of this.channels) {
      this.data.get(c)!.push(values[c] ?? 0.0);
    }
    // Evict by TIME first: the window shows the last windowS seconds, so
    // scrolling starts after that span instead of after thousands of
    // samples' worth of ever-tighter squeezing. maxlen stays as a hard
    // safety cap on the per-frame drawing cost.
    const cutoff = t - this.windowS;
    while (this.t.length > this.maxlen ||
           (this.t.length > 2 && this.t[0] < cutoff)) {
      this.t.shift();
      for (const d of this.data.values()) d.shift();
    }
    this.rev++;
  }

  /** Toggle a channel's visibility when its legend entry is clicked. */
  legendClick(x: number, y: number): boolean {
    for (const hit of this.legendHits) {
      if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
        if (this.hidden.has(hit.channel)) this.hidden.delete(hit.channel);
        else this.hidden.add(hit.channel);
        this.rev++;
        return true;
      }
    }
    return false;
  }

  private drawLegend(ctx: CanvasRenderingContext2D, w: number): void {
    this.legendHits = [];
    ctx.font = "11px system-ui, sans-serif";
    let lx = w - 10;
    for (let ci = this.channels.length - 1; ci >= 0; ci--) {
      const c = this.channels[ci];
      const d = this.data.get(c)!;
      const val = d.length > 0 ? d[d.length - 1] : 0.0;
      const off = this.hidden.has(c);
      const lbl = `${c}: ${fmt(val)}`;
      const tw = ctx.measureText(lbl).width;
      lx -= tw + 18;
      const col = SERIES_COLORS[ci % SERIES_COLORS.length];
      ctx.fillStyle = css(off ? theme.TEXT_FAINT : col);
      ctx.fillRect(lx, 9, 10, 3);
      ctx.fillStyle = css(off ? theme.TEXT_FAINT : theme.TEXT_DIM);
      ctx.fillText(lbl, lx + 14, 14);
      this.legendHits.push({ x: lx - 4, y: 2, w: tw + 20, h: 16, channel: c });
    }
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, title: string): void {
    ctx.clearRect(0, 0, w, h);
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillStyle = css(theme.TEXT_DIM);
    ctx.fillText(title, 10, 15);
    ctx.font = "11px system-ui, sans-serif";
    this.drawLegend(ctx, w);
    if (this.t.length === 0) {
      ctx.fillStyle = css(theme.TEXT_FAINT);
      ctx.textAlign = "center";
      ctx.fillText("Run the simulation to collect data", w / 2, h / 2);
      ctx.textAlign = "left";
      return;
    }
    const visible = this.channels.filter((c) => !this.hidden.has(c));
    if (visible.length === 0) {
      ctx.fillStyle = css(theme.TEXT_FAINT);
      ctx.textAlign = "center";
      ctx.fillText(`All channels hidden - ${isTouch() ? "tap" : "click"} the ` +
                   "legend to show one", w / 2, h / 2);
      ctx.textAlign = "left";
      return;
    }
    const plot = { x: 8, y: 26, w: w - 16, h: h - 42 };
    if (plot.w < 20 || plot.h < 16) return;
    const ts = this.t;
    const t0 = ts[0];
    const t1 = ts[ts.length - 1];
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of visible) {
      for (const v of this.data.get(c)!) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (hi - lo < 1e-12) {
      hi += 1;
      lo -= 1;
    }
    const pad = (hi - lo) * 0.08;
    hi += pad;
    lo -= pad;

    // autoscale with hysteresis: grow instantly to fit new data, shrink
    // slowly - otherwise spiky data entering and leaving the rolling window
    // rescales the whole plot every frame, which reads as vibration
    const targetLo = lo;
    const targetHi = hi;
    if (this.view !== null) {
      let [vlo, vhi] = this.view;
      vlo = lo < vlo ? lo : vlo + (lo - vlo) * 0.04;
      vhi = hi > vhi ? hi : vhi + (hi - vhi) * 0.04;
      lo = vlo;
      hi = vhi;
    }
    this.view = [lo, hi];
    // still easing toward the target range? renderers keep redrawing
    // static data until the animation settles, then stop
    const eps = 1e-3 * Math.max(1e-12, targetHi - targetLo);
    this.easing = Math.abs(lo - targetLo) > eps || Math.abs(hi - targetHi) > eps;

    // horizontal gridlines with value labels (count adapts to height)
    const nSeg = plot.h < 70 ? 2 : plot.h < 130 ? 3 : 4;
    const plotBottom = plot.y + plot.h;
    ctx.strokeStyle = css(theme.GRID_MAJOR);
    ctx.lineWidth = 1;
    ctx.fillStyle = css(theme.TEXT_FAINT);
    ctx.font = "10px system-ui, sans-serif";
    for (let i = 0; i <= nSeg; i++) {
      const frac = i / nSeg;
      const y = plotBottom - frac * plot.h;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
      // the topmost label sits below its line so it stays inside the plot
      ctx.fillText(fmt(lo + frac * (hi - lo)), plot.x + 2,
                   i === nSeg ? y + 10 : y - 3);
    }

    // time axis labels along the bottom edge
    for (const [frac, align] of [[0, "left"], [0.5, "center"], [1, "right"]] as const) {
      const tv = t0 + frac * (t1 - t0);
      ctx.textAlign = align;
      ctx.fillText(`${fmt(tv)} s`, plot.x + frac * plot.w, plotBottom + 11);
    }
    ctx.textAlign = "left";

    // Draw the exact polyline through every sample. Decimation is tempting
    // when samples outnumber pixels, but both flavours artefact: every-Nth
    // stride skips peaks (they flicker and snap as the window scrolls), and
    // per-pixel min/max renders each column as a vertical bar, which turns
    // steep smooth curves into a scalloped sawtooth once the window gets
    // long and squished. The rolling window is capped at maxlen samples, so
    // stroking all of them stays cheap - and it is the only rendering that
    // is faithful at every sample density.
    // A freshly-seeded plot has a single sample (zero time span): show it
    // as a dot per channel so the graph is alive before the sim starts.
    const span = Math.max(t1 - t0, 1e-9);
    const xScale = plot.w / span;
    const yScale = plot.h / (hi - lo);
    // Break the polyline across genuine recording gaps rather than drawing
    // a bogus connecting segment. The threshold is relative to the data's
    // own mean sample spacing - a pixel-based threshold breaks EVERY
    // segment while the window is young and sparse (few samples spread
    // wide), which blanked the graph for the first moments after play.
    const gap = (8.0 * span) / Math.max(ts.length - 1, 1);
    ctx.lineWidth = 1.2;
    for (const c of visible) {
      const ci = this.channels.indexOf(c);
      ctx.strokeStyle = css(SERIES_COLORS[ci % SERIES_COLORS.length]);
      const d = this.data.get(c)!;
      if (ts.length === 1) {
        // single seeded sample: a stroke needs two points, so mark it
        ctx.fillStyle = css(SERIES_COLORS[ci % SERIES_COLORS.length]);
        ctx.beginPath();
        ctx.arc(plot.x, plotBottom - (d[0] - lo) * yScale, 2.5, 0, 2 * Math.PI);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      let started = false;
      let prevT: number | null = null;
      for (let i = 0; i < ts.length; i++) {
        const ti = ts[i];
        const px = plot.x + (ti - t0) * xScale;
        const py = plotBottom - (d[i] - lo) * yScale;
        if (prevT !== null && ti - prevT > gap) {
          ctx.stroke();
          ctx.beginPath();
          started = false;
        }
        prevT = ti;
        if (started) ctx.lineTo(px, py);
        else {
          ctx.moveTo(px, py);
          started = true;
        }
      }
      ctx.stroke();
    }
  }
}

/** Position-velocity trajectory of a selected body.
 *
 * Both axes are recorded; draw() plots one chosen pair (x-vx or y-vy) in
 * a square area so the orbit's shape isn't stretched by the panel's
 * aspect ratio.
 */
export class PhasePlot {
  points: Array<[number, number, number, number]> = [];
  /** Bumped on every mutation so renderers can skip unchanged frames. */
  rev = 0;
  private maxlen: number;

  constructor(maxlen = 1500) {
    this.maxlen = maxlen;
  }

  clear(): void {
    this.points.length = 0;
    this.rev++;
  }

  add(x: number, vx: number, y: number, vy: number): void {
    if (Number.isFinite(x + vx + y + vy)) {
      this.points.push([x, vx, y, vy]);
      if (this.points.length > this.maxlen) this.points.shift();
      this.rev++;
    }
  }

  draw(ctx: CanvasRenderingContext2D, ox: number, oy: number,
       w: number, h: number, axis: "x" | "y"): void {
    ctx.strokeStyle = css(theme.OUTLINE);
    ctx.fillStyle = "rgb(28,30,36)";
    ctx.beginPath();
    ctx.roundRect(ox, oy, w, h, 6);
    ctx.fill();
    ctx.stroke();
    if (this.points.length < 2) {
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillStyle = css(theme.TEXT_FAINT);
      ctx.textAlign = "center";
      ctx.fillText("Select a body and run", ox + w / 2, oy + h / 2);
      ctx.textAlign = "left";
      return;
    }
    const plot = { x: ox + 20, y: oy + 8, w: w - 30, h: h - 30 };
    const xi = axis === "y" ? 2 : 0;
    const yi = axis === "y" ? 3 : 1;
    const xlabel = axis === "y" ? "y (m)" : "x (m)";
    const ylabel = axis === "y" ? "vy (m/s)" : "vx (m/s)";
    let loX = Infinity;
    let hiX = -Infinity;
    let loY = Infinity;
    let hiY = -Infinity;
    for (const p of this.points) {
      if (p[xi] < loX) loX = p[xi];
      if (p[xi] > hiX) hiX = p[xi];
      if (p[yi] < loY) loY = p[yi];
      if (p[yi] > hiY) hiY = p[yi];
    }
    if (hiX - loX < 1e-9) {
      loX -= 1;
      hiX += 1;
    }
    if (hiY - loY < 1e-9) {
      loY -= 1;
      hiY += 1;
    }
    const mx = (hiX - loX) * 0.06;
    const my = (hiY - loY) * 0.06;
    loX -= mx;
    hiX += mx;
    loY -= my;
    hiY += my;

    const toPx = (px: number): number => plot.x + ((px - loX) / (hiX - loX)) * plot.w;
    const toPy = (py: number): number => plot.y + plot.h - ((py - loY) / (hiY - loY)) * plot.h;

    // zero axes if inside range
    ctx.strokeStyle = css(theme.GRID_MAJOR);
    ctx.lineWidth = 1;
    if (loX < 0 && 0 < hiX) {
      ctx.beginPath();
      ctx.moveTo(toPx(0), plot.y);
      ctx.lineTo(toPx(0), plot.y + plot.h);
      ctx.stroke();
    }
    if (loY < 0 && 0 < hiY) {
      ctx.beginPath();
      ctx.moveTo(plot.x, toPy(0));
      ctx.lineTo(plot.x + plot.w, toPy(0));
      ctx.stroke();
    }

    ctx.strokeStyle = css(theme.ACCENT);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (i === 0) ctx.moveTo(toPx(p[xi]), toPy(p[yi]));
      else ctx.lineTo(toPx(p[xi]), toPy(p[yi]));
    }
    ctx.stroke();
    const last = this.points[this.points.length - 1];
    ctx.fillStyle = css(theme.WARN);
    ctx.beginPath();
    ctx.arc(toPx(last[xi]), toPy(last[yi]), 3, 0, 2 * Math.PI);
    ctx.fill();
    // Each label sits alongside its own axis so there is no ambiguity: the
    // position component runs along the bottom (horizontal axis) and the
    // velocity component up the left (vertical axis, rotated to match).
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = css(theme.TEXT_FAINT);
    ctx.textAlign = "center";
    ctx.fillText(xlabel, plot.x + plot.w / 2, oy + h - 6);
    ctx.save();
    ctx.translate(ox + 11, plot.y + plot.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(ylabel, 0, 0);
    ctx.restore();
    ctx.textAlign = "left";
  }
}
