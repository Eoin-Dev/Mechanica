/** Live plots: rolling time-series (energy, momentum) and phase-space plot. */
import { Color } from "../engine/body";
import { fmt3g as fmt, isTouch, reducedMotion } from "./dom";
import * as theme from "./theme";
import { css } from "./theme";

// The two channel colours beyond the theme's semantic four. Module-level
// because they are constant; the theme colours are read per call so a
// runtime theme change is picked up by the next draw.
const EXTRA_SERIES: readonly Color[] = [[170, 140, 230], [110, 200, 210]];

/** Per-channel line colour. */
export function seriesColor(i: number): Color {
  const k = i % (4 + EXTRA_SERIES.length);
  if (k === 0) return theme.ACCENT;
  if (k === 1) return theme.GOOD;
  if (k === 2) return theme.WARN;
  if (k === 3) return theme.BAD;
  return EXTRA_SERIES[k - 4];
}

interface LegendHit {
  x: number;
  y: number;
  w: number;
  h: number;
  channel: string;
}

/** Default view span: how much simulation time the live plot shows.
 * Scrolling starts once this span is filled, so it doubles as "how long
 * the plot squeezes before it starts moving". Zooming changes it. */
export const GRAPH_WINDOW_S = 15.0;

/** Vertex budget for one view span - roughly one sample per pixel on a
 * wide plot. The app derives its sampling cadence from this so drawing
 * cost is bounded no matter the display's refresh rate. */
export const GRAPH_MAX_POINTS = 1200;

/** How much history is retained for scrolling back. Bounded so a
 * simulation left running for hours cannot grow memory without limit:
 * at the sampling cadence this is ~10k samples per channel. */
export const GRAPH_HISTORY_S = 120.0;

/** How many expired samples may sit at the front of the backing arrays
 * before they are collected. This is a memory-reclaim threshold only: an
 * expired sample is already invisible to every reader the moment it
 * expires, so the retained span is unaffected by how large this is. */
const COMPACT_BLOCK = 512;

/** How far the phase plot may overrun its point cap before compacting.
 * Unlike TimeSeries it exposes no retention guarantee - it is a shape, not
 * a time axis - so it can trade a little slack for O(1) amortised adds. */
const EVICT_BLOCK = 256;

/** The time range a plot draws: `end` is the time at the right edge
 * (null = follow the live edge) and `span` is the visible duration. */
export interface GraphView {
  end: number | null;
  span: number;
}

/** Rolling window of named channels sampled against simulation time.
 *
 * Channels can be toggled on/off by clicking their legend entries; hidden
 * channels are excluded from the autoscale so the visible ones fill the
 * plot.
 */
export class TimeSeries {
  channels: string[];
  // Backing storage. Samples before `head` have expired and are logically
  // gone - `count`, `firstT` and every accessor below skip them - but the
  // memory is only reclaimed in blocks (see evict). Splitting the logical
  // window from the physical array is what lets eviction be O(1) while the
  // retained span stays EXACTLY historyS: dropping a sample costs one
  // increment, not a shift of every element in four channel arrays.
  private ts: number[] = [];
  private data: Map<string, number[]>;
  private head = 0;
  hidden = new Set<string>();
  /** Bumped on every mutation so renderers can skip unchanged frames. */
  rev = 0;
  /** True while the autoscale is still animating toward its target. */
  easing = false;
  private historyS: number;
  private maxlen: number;
  private legendHits: LegendHit[] = [];
  private view: [number, number] | null = null; // smoothed y-range

  constructor(channels: string[], historyS = GRAPH_HISTORY_S, maxlen = 10000) {
    this.channels = channels;
    this.historyS = historyS;
    this.maxlen = maxlen;
    this.data = new Map(channels.map((c) => [c, []]));
  }

  /** Number of live (unexpired) samples. */
  get count(): number { return this.ts.length - this.head; }

  /** Time of the i-th live sample, oldest first. */
  timeAt(i: number): number { return this.ts[this.head + i]; }

  /** Value of `channel` at the i-th live sample, oldest first. */
  valueAt(channel: string, i: number): number {
    return this.data.get(channel)![this.head + i];
  }

  /** Every live value of one channel, oldest first (tests and callers that
   * want a plain array; the draw path uses valueAt and never allocates). */
  values(channel: string): number[] {
    return this.data.get(channel)!.slice(this.head);
  }

  /** Live sample times, oldest first. */
  times(): number[] { return this.ts.slice(this.head); }

  /** Oldest / newest retained sample time (NaN when empty). */
  get firstT(): number { return this.count > 0 ? this.ts[this.head] : NaN; }
  get lastT(): number {
    return this.count > 0 ? this.ts[this.ts.length - 1] : NaN;
  }

  clear(): void {
    this.ts.length = 0;
    for (const d of this.data.values()) d.length = 0;
    this.head = 0;
    this.view = null;
    this.rev++;
  }

  /** Drop samples newer than time t (stepping the simulation back). */
  truncate(t: number): void {
    while (this.count > 0 && this.ts[this.ts.length - 1] > t + 1e-9) {
      this.ts.pop();
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
    if (this.count > 0 && t < this.ts[this.ts.length - 1]) {
      this.clear(); // simulation was reset/rewound
    }
    // a re-sample at the same time (seeding an opened graph, or a frame
    // where the clock didn't advance) updates in place instead of stacking
    // duplicate points
    const last = this.ts.length - 1;
    if (this.count > 0 && t === this.ts[last]) {
      for (const c of this.channels) {
        this.data.get(c)![last] = values[c] ?? 0.0;
      }
      this.rev++;
      return;
    }
    this.ts.push(t);
    for (const c of this.channels) {
      this.data.get(c)!.push(values[c] ?? 0.0);
    }
    this.evict(t);
    this.rev++;
  }

  /** Drop samples older than the retention window.
   *
   * Retain the last historyS seconds (the scroll-back buffer) and no more,
   * so an all-day run cannot grow memory without bound; maxlen is a hard
   * safety cap on top.
   *
   * Exact AND cheap. Expiring a sample only advances `head`, so the
   * retained span is precisely historyS from the first add onward - the
   * span is a user-visible guarantee (it is exactly how far back the graph
   * scrolls), so it is not something to trade away. Reclaiming the memory
   * is the expensive half, and that is the part deferred: once the dead
   * prefix is worth collecting, one splice drops the lot.
   *
   * The previous version shifted every element of five arrays on every
   * add. Past the first two minutes a sample expires on essentially every
   * add, so that was ~50k element moves per sample for the rest of the
   * run. */
  private evict(now: number): void {
    const cutoff = now - this.historyS;
    const n = this.ts.length;
    // keep at least two live samples so a line always has something to draw
    while (this.head < n - 2 && this.ts[this.head] < cutoff) this.head++;
    if (n - this.head > this.maxlen) this.head = n - this.maxlen;
    if (this.head < COMPACT_BLOCK) return;
    this.ts.splice(0, this.head);
    for (const d of this.data.values()) d.splice(0, this.head);
    this.head = 0;
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
      const val = this.count > 0 ? d[d.length - 1] : 0.0;
      const off = this.hidden.has(c);
      const lbl = `${c}: ${fmt(val)}`;
      const tw = ctx.measureText(lbl).width;
      lx -= tw + 18;
      const col = seriesColor(ci);
      ctx.fillStyle = css(off ? theme.TEXT_FAINT : col);
      ctx.fillRect(lx, 9, 10, 3);
      ctx.fillStyle = css(off ? theme.TEXT_FAINT : theme.TEXT_DIM);
      ctx.fillText(lbl, lx + 14, 14);
      this.legendHits.push({ x: lx - 4, y: 2, w: tw + 20, h: 16, channel: c });
    }
  }

  /** First LIVE index with t >= tv (binary search; times ascending). */
  private lowerBound(tv: number): number {
    let a = this.head;
    let b = this.ts.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (this.ts[m] < tv) a = m + 1;
      else b = m;
    }
    return a - this.head;
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, title: string,
       view?: GraphView): void {
    ctx.clearRect(0, 0, w, h);
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillStyle = css(theme.TEXT_DIM);
    ctx.fillText(title, 10, 15);
    ctx.font = "11px system-ui, sans-serif";
    this.drawLegend(ctx, w);
    if (this.count === 0) {
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
    // i0/i1 below are LIVE indices (0 = oldest unexpired sample); H turns
    // one into an index in the backing arrays
    const ts = this.ts;
    const H = this.head;
    const n = this.count;
    // Visible time range. Live (end null): right edge follows the newest
    // sample, and while the data is younger than the span the plot
    // stretches what exists (the familiar early squeeze). Detached
    // (scrolled back / zoomed): the exact requested range, frozen.
    const span = view?.span ?? GRAPH_WINDOW_S;
    const detached = view !== undefined && view.end !== null;
    const t1 = detached ? (view.end as number) : ts[ts.length - 1];
    const t0 = detached ? t1 - span : Math.max(ts[H], t1 - span);
    // indices covering [t0, t1] plus one sample either side so the line
    // enters and exits the plot instead of stopping at the first sample
    const i0 = Math.max(0, this.lowerBound(t0) - 1);
    const i1 = Math.min(n - 1, this.lowerBound(t1 + 1e-12));
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of visible) {
      const d = this.data.get(c)!;
      for (let i = i0; i <= i1; i++) {
        const v = d[H + i];
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
    // A viewer who asked for reduced motion gets the axis snapped to its
    // target instead of creeping toward it. The plotted data still moves -
    // that is the measurement - but the frame around it stops sliding.
    if (this.view !== null && !reducedMotion()) {
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

    // Draw the exact polyline through every visible sample. Decimation is
    // tempting when samples outnumber pixels, but both flavours artefact:
    // every-Nth stride skips peaks (they flicker and snap as the window
    // scrolls), and per-pixel min/max renders each column as a vertical
    // bar, which turns steep smooth curves into a scalloped sawtooth. The
    // visible index range is bounded by the sampling cadence, so stroking
    // all of it stays cheap. Samples are never split into separate
    // strokes: an irregular spacing (a frame stall, a backgrounded tab)
    // is a legitimate continuation of the run, not a recording gap -
    // splitting there drew broken lines after tab switches.
    // A freshly-seeded plot has a single sample (zero time span): show it
    // as a dot per channel so the graph is alive before the sim starts.
    const xScale = plot.w / Math.max(t1 - t0, 1e-9);
    const yScale = plot.h / (hi - lo);
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x - 1, 0, plot.w + 2, h); // boundary samples overhang
    ctx.clip();
    ctx.lineWidth = 1.2;
    for (const c of visible) {
      const ci = this.channels.indexOf(c);
      ctx.strokeStyle = css(seriesColor(ci));
      const d = this.data.get(c)!;
      if (i1 === i0) {
        // single visible sample: a stroke needs two points, so mark it
        const px = plot.x + (ts[H + i0] - t0) * xScale;
        ctx.fillStyle = css(seriesColor(ci));
        ctx.beginPath();
        ctx.arc(Math.max(plot.x, Math.min(plot.x + plot.w, px)),
                plotBottom - (d[H + i0] - lo) * yScale, 2.5, 0, 2 * Math.PI);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const px = plot.x + (ts[H + i] - t0) * xScale;
        const py = plotBottom - (d[H + i] - lo) * yScale;
        if (i === i0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();
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
      // batched like TimeSeries.evict: a per-sample shift() is O(n) and
      // this runs on every graph sample for the whole run
      if (this.points.length > this.maxlen + EVICT_BLOCK) {
        this.points.splice(0, this.points.length - this.maxlen);
      }
      this.rev++;
    }
  }

  draw(ctx: CanvasRenderingContext2D, ox: number, oy: number,
       w: number, h: number, axis: "x" | "y"): void {
    ctx.strokeStyle = css(theme.OUTLINE);
    ctx.fillStyle = css(theme.BG);
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
