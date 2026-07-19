/** Time-series graph rendering: the plot must stroke the exact polyline
 * through every sample. Decimation schemes artefacted: every-Nth stride
 * skipped peaks (they flickered and snapped as the window scrolled), and
 * per-pixel min/max drew each column as a vertical bar, turning steep
 * smooth curves into a scalloped sawtooth once the window got squished. */
import { describe, expect, it } from "vitest";
import * as theme from "../src/ui/theme";
import { css } from "../src/ui/theme";
import { TimeSeries } from "../src/ui/plots";

const gridCss = css(theme.GRID_MAJOR);

/** Records every stroked vertex, tagged with its stroke colour so data
 * lines can be told apart from the gridlines. */
function recCtx() {
  const pts: Array<{ x: number; y: number; stroke: string }> = [];
  const dots: Array<{ x: number; y: number }> = [];
  const texts: string[] = [];
  let stroke = "";
  const base: Record<string, unknown> = {
    measureText: () => ({ width: 0 }),
    beginPath() {}, stroke() {}, clearRect() {}, fillRect() {}, fill() {},
    fillText(t: string) { texts.push(t); },
    arc(x: number, y: number) { dots.push({ x, y }); },
    moveTo(x: number, y: number) { pts.push({ x, y, stroke }); },
    lineTo(x: number, y: number) { pts.push({ x, y, stroke }); },
  };
  const ctx = new Proxy(base, {
    get(t, p) { if (p === "strokeStyle") return stroke; return (p in t) ? t[p as string] : () => {}; },
    set(_t, p, v) { if (p === "strokeStyle") stroke = v as string; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, pts, dots, texts };
}

function dataVertices(series: TimeSeries, w: number, h: number) {
  const { ctx, pts } = recCtx();
  series.draw(ctx, w, h, "Energy");
  return pts.filter((p) => p.stroke !== gridCss && p.stroke !== "");
}

describe("time-series rendering", () => {
  it("keeps a sharp peak at a stable height while the window scrolls", () => {
    const s = new TimeSeries(["E"]);
    // narrow plot so there are many samples per pixel
    const W = 120, H = 90;
    let t = 0;
    const push = (v: number) => s.add((t += 1 / 120), { E: v });
    for (let i = 0; i < 40; i++) push(0); // baseline
    push(100);                             // one-sample spike
    // let the autoscale settle to include the spike
    const peakY = () => Math.min(...dataVertices(s, W, H).map((p) => p.y));
    for (let i = 0; i < 5; i++) peakY();
    const settled = peakY();

    // scroll the spike across the plot by appending many baseline samples;
    // record the peak's screen height at each step
    const heights: number[] = [];
    for (let scroll = 0; scroll < 200; scroll++) {
      push(0);
      heights.push(peakY());
    }
    const min = Math.min(...heights), max = Math.max(...heights);
    // the spike stays well above the baseline (near the top of the plot)...
    expect(settled).toBeLessThan(H * 0.5);
    // ...and its height barely moves as the window scrolls (no flicker/snap).
    // A couple of px of drift from autoscale easing is fine; stride
    // decimation swung by tens of pixels as it dropped/regained the peak.
    expect(max - min).toBeLessThan(4);
  });

  it("strokes every sample exactly once, in order (dense data)", () => {
    // Any per-pixel bucketing turns steep smooth curves into a scalloped
    // sawtooth once samples outnumber pixels: the faithful rendering is one
    // vertex per sample with x never decreasing.
    const s = new TimeSeries(["E"]);
    let t = 0;
    const n = 2500;
    for (let i = 0; i < n; i++) {
      t += 1 / 240;
      s.add(t, { E: Math.sin(t * 4) + 0.3 * Math.sin(t * 9) });
    }
    const data = dataVertices(s, 300, 120);
    expect(data.length).toBe(n);
    for (let i = 1; i < data.length; i++) {
      expect(data[i].x).toBeGreaterThanOrEqual(data[i - 1].x);
    }
  });

  it("renders sparse data as an exact polyline through every sample", () => {
    const s = new TimeSeries(["E"]);
    let t = 0;
    for (let i = 0; i < 50; i++) {
      s.add((t += 0.1), { E: Math.sin(i * 0.2) });
    }
    const data = dataVertices(s, 600, 200);
    expect(data.length).toBe(50);
    for (let i = 1; i < data.length; i++) {
      expect(data[i].x).toBeGreaterThan(data[i - 1].x);
    }
  });

  it("draws a seeded single sample as a dot, not the placeholder", () => {
    // Opening a graph seeds one sample of the current state; the plot must
    // show it immediately (legend, grid, a dot per channel) instead of
    // "run the simulation" - otherwise there is a visible dead period
    // between pressing play and the graph appearing.
    const s = new TimeSeries(["KE", "PE"]);
    s.add(0, { KE: 3, PE: 7 });
    const { ctx, dots, texts } = recCtx();
    s.draw(ctx, 300, 120, "Energy");
    expect(dots.length).toBe(2); // one marker per channel
    expect(texts.join(" ")).not.toMatch(/[Rr]un the simulation/);
  });

  it("re-adding a sample at the same time updates it in place", () => {
    const s = new TimeSeries(["E"]);
    s.add(1.0, { E: 5 });
    s.add(1.0, { E: 9 }); // seeded again (e.g. graph toggled twice)
    expect(s.t.length).toBe(1);
    expect(s.data.get("E")).toEqual([9]);
    s.add(1.5, { E: 4 });
    expect(s.t).toEqual([1.0, 1.5]);
  });

  it("draws a smooth wave's full vertical extent (peaks kept)", () => {
    const s = new TimeSeries(["E"]);
    let t = 0;
    for (let i = 0; i < 2000; i++) {
      s.add((t += 1 / 120), { E: Math.sin(i * 0.05) });
    }
    const ys = dataVertices(s, 300, 120).map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(20);
  });

  it("retains only the bounded history however long the sim runs", () => {
    const s = new TimeSeries(["E"], 10); // 10 s of retained history
    let t = 0;
    for (let i = 0; i < 60 * 60; i++) {
      s.add((t += 1 / 60), { E: Math.sin(i * 0.1) }); // a 60 s run
    }
    const span = s.t[s.t.length - 1] - s.t[0];
    expect(span).toBeLessThanOrEqual(10 + 1e-9);
    expect(span).toBeGreaterThan(10 * 0.95);
    // memory stays bounded: samples for the retained span only
    expect(s.t.length).toBeLessThanOrEqual(10 * 60 + 2);
  });

  it("draws only the requested view range when zoomed/scrolled back", () => {
    const s = new TimeSeries(["E"]);
    let t = 0;
    for (let i = 0; i < 40 * 60; i++) {
      s.add((t += 1 / 60), { E: Math.sin(i * 0.05) }); // 40 s at 60 Hz
    }
    // detached view: 5 s ending at t=20 s (well inside the history)
    const { ctx, pts } = recCtx();
    s.draw(ctx, 600, 200, "Energy", { end: 20, span: 5 });
    const data = pts.filter((p) => p.stroke !== gridCss && p.stroke !== "");
    // ~5 s at 60 Hz plus the one-sample overhang each side
    expect(data.length).toBeGreaterThan(5 * 60 - 2);
    expect(data.length).toBeLessThan(5 * 60 + 4);
  });

  it("connects across irregular sample spacing (no tab-switch gaps)", () => {
    const s = new TimeSeries(["E"]);
    s.add(0.0, { E: 0 });
    s.add(0.0125, { E: 1 });
    s.add(0.5, { E: 2 }); // a stalled frame / backgrounded tab
    s.add(0.5125, { E: 3 });
    const { ctx, pts } = recCtx();
    s.draw(ctx, 300, 120, "Energy");
    const data = pts.filter((p) => p.stroke !== gridCss && p.stroke !== "");
    // one unbroken polyline through all four samples
    expect(data.length).toBe(4);
  });

  it("bumps rev on mutations so renderers can skip unchanged frames", () => {
    const s = new TimeSeries(["E"]);
    const r0 = s.rev;
    s.add(1, { E: 2 });
    expect(s.rev).toBeGreaterThan(r0);
    const r1 = s.rev;
    s.clear();
    expect(s.rev).toBeGreaterThan(r1);
  });
});
