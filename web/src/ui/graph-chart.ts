/** Geometry for detached graph snapshots; rendering never changes measurements. */
import type { GraphDataSnapshot } from "./graph-data";

export interface ChartAxes {
  x: number;
  ys: readonly number[];
  xLabel: string;
  yLabel: string;
  timeSeries: boolean;
}
export interface ChartRange { min: number; max: number }
export interface ChartPoint { row: number; column: number; x: number; y: number; time: number }

/** A normalized visible interval, bounded by the complete retained domain. */
export function zoomChartWindow(window: ChartRange, factor: number, anchor = 0.5): ChartRange {
  if (!Number.isFinite(factor) || factor <= 0) return { ...window };
  const span = window.max - window.min;
  const next = Math.max(1e-6, Math.min(1, span / factor));
  const at = Math.max(0, Math.min(1, anchor));
  const min = Math.max(0, Math.min(1 - next, window.min + span * at - next * at));
  return { min, max: min + next };
}

/** Move a normalized viewport without changing its scale or stored samples. */
export function panChartWindow(window: ChartRange, delta: number): ChartRange {
  if (!Number.isFinite(delta)) return { ...window };
  const span = window.max - window.min;
  const min = Math.max(0, Math.min(1 - span, window.min + delta));
  return { min, max: min + span };
}

/** Momentum dimensions and phase pairs deliberately use separate views. */
export function graphAxes(data: GraphDataSnapshot, variant = 0): ChartAxes {
  if (data.filename === "mechanica-phase.csv") return variant === 1
    ? { x: 3, ys: [4], xLabel: "y (m)", yLabel: "vy (m/s)", timeSeries: false }
    : { x: 1, ys: [2], xLabel: "x (m)", yLabel: "vx (m/s)", timeSeries: false };
  const yLabel = data.filename === "mechanica-momentum.csv"
    ? variant === 1 ? "Angular momentum (kg m²/s)" : "Linear momentum (kg m/s)"
    : data.filename === "mechanica-energy.csv" ? "Energy (J)"
    : data.filename === "mechanica-velocity.csv" ? "Velocity (m/s)"
    : data.filename === "mechanica-distance.csv" ? "Distance travelled (m)" : "Displacement (m)";
  return { x: 0, ys: data.filename === "mechanica-momentum.csv"
    ? variant === 1 ? [4] : [1, 2, 3] : data.columns.slice(1).map((_, i) => i + 1),
    xLabel: "Time (s)", yLabel, timeSeries: true };
}

function expand(min: number, max: number): ChartRange {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 };
  const span = max / 2 - min / 2;
  const padding = span > 0 ? span * 0.1 : min === 0 ? 1 : Math.abs(min) * 0.05;
  const lo = min - padding, hi = max + padding;
  return { min: Number.isFinite(lo) ? lo : min, max: Number.isFinite(hi) ? hi : max };
}

export function chartRange(data: GraphDataSnapshot, columns: readonly number[]): ChartRange {
  let min = Infinity, max = -Infinity;
  for (const row of data.rows) for (const column of columns) {
    const value = row[column];
    if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
  }
  return expand(min, max);
}

/** Scaling before subtraction avoids overflow for opposite large finite values. */
export function graphFraction(value: number, range: ChartRange): number {
  const scale = Math.max(Math.abs(range.min), Math.abs(range.max), Number.MIN_VALUE);
  const lo = range.min / scale, hi = range.max / scale;
  return hi > lo ? (value / scale - lo) / (hi - lo) : 0.5;
}

export function graphValue(fraction: number, range: ChartRange): number {
  return (1 - fraction) * range.min + fraction * range.max;
}

export function chartTicks(range: ChartRange, count: number): number[] {
  const intervals = Math.max(1, Math.min(10, Math.trunc(count) - 1));
  const ideal = range.max / intervals - range.min / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(ideal));
  const ratio = ideal / magnitude;
  const step = magnitude * (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10);
  const start = Math.ceil(range.min / step) * step;
  const ticks: number[] = [];
  if (Number.isFinite(start) && Number.isFinite(step) && step > 0) {
    for (let i = 0; i <= 12; i++) {
      const value = start + i * step;
      if (!Number.isFinite(value) || value > range.max) break;
      if (value >= range.min && (ticks.length === 0 || value > ticks.at(-1)!)) ticks.push(value);
    }
  }
  return ticks.length >= 2 ? ticks :
    Array.from({ length: intervals + 1 }, (_, i) => graphValue(i / intervals, range));
}

/** Keep both endpoints and each bucket's extrema, in original time order.
 * Full snapshot rows remain available to hover, paging and exports. */
export function chartIndices(data: GraphDataSnapshot, column: number, budget = 1600): number[] {
  const length = data.rows.length, limit = Math.max(4, Math.trunc(budget));
  if (length <= limit) return Array.from({ length }, (_, i) => i);
  const buckets = Math.floor((limit - 2) / 2);
  const result = [0];
  for (let b = 0; b < buckets; b++) {
    const start = 1 + Math.floor(b * (length - 2) / buckets);
    const end = 1 + Math.floor((b + 1) * (length - 2) / buckets);
    let lo = start, hi = start;
    for (let i = start + 1; i < end; i++) {
      if (data.rows[i][column] < data.rows[lo][column]) lo = i;
      if (data.rows[i][column] > data.rows[hi][column]) hi = i;
    }
    result.push(Math.min(lo, hi));
    if (lo !== hi) result.push(Math.max(lo, hi));
  }
  result.push(length - 1);
  return result;
}

/** Select a stored point. Time plots search the nearest clock samples;
 * unordered phase curves examine their bounded retained points in 2D. */
export function nearestChartPoint(data: GraphDataSnapshot, axes: ChartAxes,
                                  x: number, y: number, width: number, height: number,
                                  ranges?: { x: ChartRange; y: ChartRange }): ChartPoint | null {
  if (!data.rows.length || !axes.ys.length) return null;
  const xr = ranges?.x ?? chartRange(data, [axes.x]), yr = ranges?.y ?? chartRange(data, axes.ys);
  let start = 0, end = data.rows.length;
  if (axes.timeSeries) {
    const target = graphValue(x, xr);
    let lo = 0, hi = data.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (data.rows[mid][axes.x] < target) lo = mid + 1; else hi = mid;
    }
    start = Math.max(0, lo - 1); end = Math.min(data.rows.length, lo + 1);
  }
  let best: ChartPoint | null = null, distance = Infinity;
  for (let i = start; i < end; i++) for (const column of axes.ys) {
    const row = data.rows[i];
    if (!Number.isFinite(row[axes.x]) || !Number.isFinite(row[column]) || !Number.isFinite(row[0])) continue;
    const dx = (graphFraction(row[axes.x], xr) - x) * width;
    const dy = (graphFraction(row[column], yr) - y) * height;
    const d = dx * dx + dy * dy;
    if (d < distance) {
      distance = d; best = { row: i, column, x: row[axes.x], y: row[column], time: row[0] };
    }
  }
  return best;
}
