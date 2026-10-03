import { describe, expect, it } from "vitest";
import { chartIndices, chartRange, chartTicks, graphAxes, graphFraction, nearestChartPoint, zoomChartWindow, panChartWindow } from "../src/ui/graph-chart";
import type { GraphDataSnapshot } from "../src/ui/graph-data";

function data(name: string, rows: number[][]): GraphDataSnapshot {
  return { title: "Measurement", filename: `mechanica-${name}.csv`,
    columns: ["time", "a", "b", "c", "d"].map(csv => ({ label: csv, csv })), rows };
}

describe("detached graph geometry", () => {
  it("pans at a fixed scale and stops at both retained-domain edges", () => {
    const range = { min: 0.25, max: 0.75 };
    expect(panChartWindow(range, -1)).toEqual({ min: 0, max: 0.5 });
    expect(panChartWindow(range, 1)).toEqual({ min: 0.5, max: 1 });
    expect(panChartWindow(range, 0.125)).toEqual({ min: 0.375, max: 0.875 });
    expect(range).toEqual({ min: 0.25, max: 0.75 });
    for (const invalid of [NaN, Infinity, -Infinity]) expect(panChartWindow(range, invalid)).toEqual(range);
    expect(panChartWindow({ min: 0, max: 1 }, 0.5)).toEqual({ min: 0, max: 1 });
  });
  it("zooms around the pointer without moving its domain coordinate", () => {
    const next = zoomChartWindow({ min: 0.1, max: 0.9 }, 2, 0.25);
    expect(next.min).toBeCloseTo(0.2, 12); expect(next.max).toBeCloseTo(0.6, 12);
    expect(next.min + (next.max - next.min) * 0.25).toBeCloseTo(0.3, 12);
  });
  it("bounds zoom and returns to the complete measured domain", () => {
    expect(zoomChartWindow({ min: 0.25, max: 0.75 }, 0.1)).toEqual({ min: 0, max: 1 });
    const tiny = zoomChartWindow({ min: 0, max: 1 }, 1e30, 0);
    expect(tiny).toEqual({ min: 0, max: 1e-6 });
    expect(zoomChartWindow({ min: 0, max: 1 }, 2, 1)).toEqual({ min: 0.5, max: 1 });
  });
  it("ignores invalid zoom factors instead of corrupting the view", () => {
    for (const factor of [0, -1, Infinity, NaN]) {
      expect(zoomChartWindow({ min: 0.2, max: 0.4 }, factor)).toEqual({ min: 0.2, max: 0.4 });
    }
  });
  it("separates linear and angular momentum units", () => {
    const source = data("momentum", []);
    expect(graphAxes(source).ys).toEqual([1, 2, 3]);
    expect(graphAxes(source, 1).ys).toEqual([4]);
    expect(graphAxes(source, 1).yLabel).toBe("Angular momentum (kg m²/s)");
  });
  it("pairs each phase position with its own velocity", () => {
    const source = data("phase", []);
    expect([graphAxes(source).x, ...graphAxes(source).ys]).toEqual([1, 2]);
    expect([graphAxes(source, 1).x, ...graphAxes(source, 1).ys]).toEqual([3, 4]);
  });
  it("gives constant measurements a finite range", () => {
    expect(chartRange(data("energy", [[0, 5], [1, 5]]), [1])).toEqual({ min: 4.75, max: 5.25 });
  });
  it("keeps tiny measured values distinct", () => {
    const range = chartRange(data("energy", [[0, 1e-200], [1, 2e-200]]), [1]);
    expect(range.min).toBeGreaterThan(0); expect(range.max).toBeLessThan(3e-200);
    expect(graphFraction(2e-200, range)).toBeGreaterThan(graphFraction(1e-200, range));
  });
  it("maps opposite large finite values without overflow", () => {
    const range = chartRange(data("energy", [[0, -1e308], [1, 1e308]]), [1]);
    expect(graphFraction(0, range)).toBe(0.5);
    expect(Number.isFinite(graphFraction(1e308, range))).toBe(true);
    expect(chartTicks(range, 5).every(Number.isFinite)).toBe(true);
  });
  it("uses readable scientific tick increments", () => {
    expect(chartTicks({ min: -0.05, max: 1.05 }, 6)).toEqual([0, 0.5, 1]);
  });
  it("retains endpoints and both narrow spike directions within the vertex budget", () => {
    const rows = Array.from({ length: 10000 }, (_, i) => [i, 0]);
    rows[4312][1] = 17; rows[4313][1] = -21;
    const indices = chartIndices(data("energy", rows), 1, 1000);
    for (const index of [0, 9999, 4312, 4313]) expect(indices).toContain(index);
    expect(indices.length).toBeLessThanOrEqual(1000);
    expect(indices.every((index, i) => i === 0 || index > indices[i - 1])).toBe(true);
  });
  it("keeps every point in a small measurement", () => {
    expect(chartIndices(data("energy", [[0, 1], [1, 2], [2, 3]]), 1)).toEqual([0, 1, 2]);
  });
  it("time hover selects a stored point instead of an interpolated value", () => {
    const source = data("energy", [[0, 0, 0, 0], [1, 10, 5, 15], [2, 0, 0, 0]]);
    const point = nearestChartPoint(source, graphAxes(source), 0.5, 10 / 16.5, 600, 300)!;
    expect(point.row).toBe(1); expect(point.x).toBe(1); expect(point.y).toBe(source.rows[1][point.column]);
  });
  it("phase hover searches unordered positions on a circular orbit", () => {
    const rows = Array.from({ length: 600 }, (_, i) => {
      const theta = 2 * Math.PI * i / 600;
      return [i / 60, Math.cos(theta), -Math.sin(theta), Math.sin(theta), Math.cos(theta)];
    });
    const source = data("phase", rows);
    const point = nearestChartPoint(source, graphAxes(source), 0.5, 1 / 22, 400, 400)!;
    expect(point.row).toBe(150); expect(point.time).toBe(2.5);
  });
  it("does not invent hover values for empty or hidden channels", () => {
    const source = data("energy", []);
    expect(nearestChartPoint(source, graphAxes(source), 0, 0, 1, 1)).toBeNull();
    expect(nearestChartPoint(data("energy", [[0, 1]]), { ...graphAxes(source), ys: [] }, 0, 0, 1, 1)).toBeNull();
  });
  it("cached ranges preserve the selected measurement", () => {
    const source = data("phase", [[0, 0, 2, 1, -1], [1, 1, -1, 0, 2]]), axes = graphAxes(source);
    expect(nearestChartPoint(source, axes, 0.2, 0.8, 500, 350)).toEqual(
      nearestChartPoint(source, axes, 0.2, 0.8, 500, 350,
        { x: chartRange(source, [axes.x]), y: chartRange(source, axes.ys) }));
  });
});
