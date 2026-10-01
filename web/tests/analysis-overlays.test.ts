import { afterEach, describe, expect, it } from "vitest";
import { analysisNumber, drawAnalysisOverlays, type AnalysisLabel } from "../src/render/analysis-overlays";
import * as theme from "../src/ui/theme";

interface Box { x: number; y: number; width: number; height: number; colour: string; }
interface Text extends Box { text: string; fontSize: number; background?: string; }
function recorder(): { ctx: CanvasRenderingContext2D; text: Text[]; surfaces: Box[] } {
  const text: Text[] = [], surfaces: Box[] = [];
  const state = { font: "12px sans-serif", fillStyle: "", strokeStyle: "", lineWidth: 1,
    textAlign: "left", textBaseline: "alphabetic" };
  const fontSize = (): number => Number(state.font.match(/([\d.]+)px/)?.[1]);
  const width = (value: string): number => Array.from(value).length * fontSize() * 0.6;
  const methods = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {},
    measureText(value: string) { return { width: width(value) }; },
    fillRect(x: number, y: number, w: number, h: number) {
      surfaces.push({ x, y, width: w, height: h, colour: state.fillStyle });
    },
    fillText(value: string, x: number, y: number) {
      const w = width(value), size = fontSize();
      const underneath = [...surfaces].reverse().find(box => x + w / 2 >= box.x && x + w / 2 <= box.x + box.width &&
        y - size / 2 >= box.y && y - size / 2 <= box.y + box.height);
      text.push({ text: value, x, y: y - size, width: w, height: size,
        colour: state.fillStyle, fontSize: size, background: underneath?.colour });
    },
  };
  const ctx = new Proxy({ ...state, ...methods }, {
    get(target, key) { return key in state ? state[key as keyof typeof state] : Reflect.get(target, key); },
    set(_target, key, value) { Reflect.set(state, key, value); return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, text, surfaces };
}
afterEach(() => { theme.setTheme("dark"); });

describe("scientific canvas annotations", () => {
  it.each(theme.THEME_NAMES)("puts readable complete force values on an opaque %s surface", name => {
    theme.setTheme(name);
    const capture = recorder();
    drawAnalysisOverlays(capture.ctx, [
      { text: "W 19.60 N", x: 150, y: 90, color: theme.BAD, right: true },
      { text: "T 4.20 N", x: 150, y: 90, color: theme.WARN, right: false },
    ], [], 400, 300);
    expect(capture.text.map(row => row.text)).toEqual(["W 19.60 N", "T 4.20 N"]);
    for (const row of capture.text) {
      expect(row.colour).toBe(theme.css(theme.TEXT));
      expect(row.background).toBe(theme.css(theme.PANEL));
      expect(theme.contrastRatio(theme.TEXT, theme.PANEL)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([[0, 0], [240, 0], [0, 160], [240, 160], [-20000, 50000], [20000, -50000]])(
    "keeps full captions inside the canvas near (%s, %s)", (x, y) => {
      const capture = recorder();
      drawAnalysisOverlays(capture.ctx, [{ text: "F 1.23e+8 N", x, y, color: theme.WARN, right: x > 100 }],
        [], 240, 160, 1.2);
      expect(capture.text).toHaveLength(1);
      const row = capture.text[0];
      expect(row.text).toBe("F 1.23e+8 N");
      expect(row.fontSize).toBeGreaterThanOrEqual(14.4 - 1e-10);
      expect(row.x).toBeGreaterThanOrEqual(0);
      expect(row.y).toBeGreaterThanOrEqual(0);
      expect(row.x + row.width).toBeLessThanOrEqual(240);
      expect(row.y + row.height).toBeLessThanOrEqual(160);
    });

  it("separates collinear force captions and keeps arrow association cues", () => {
    const capture = recorder();
    const labels: AnalysisLabel[] = Array.from({ length: 4 }, () =>
      ({ text: "F 3.00 N", x: 200, y: 140, color: theme.ACCENT_HOT, right: true }));
    drawAnalysisOverlays(capture.ctx, labels, [], 600, 400);
    expect(capture.text).toHaveLength(4);
    for (let i = 0; i < capture.text.length; i++) for (let j = i + 1; j < capture.text.length; j++) {
      const a = capture.text[i], b = capture.text[j];
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x ||
        a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
    expect(capture.surfaces.filter(box => box.colour === theme.css(theme.ACCENT_HOT))).toHaveLength(4);
  });

  it("keeps large and small signed slope components complete on a narrow canvas", () => {
    const capture = recorder();
    drawAnalysisOverlays(capture.ctx, [], [{ x: 230, y: 150, rows: [
      { symbol: "F", parallel: -1.23e8, normal: 0.0004, color: theme.ACCENT_HOT },
      { symbol: "W", parallel: 12.5, normal: -19.6, color: theme.BAD },
    ] }], 268, 220, 1.2);
    expect(capture.text.map(row => row.text)).toEqual([
      "Slope components (N)", "∥ Along", "⊥ Normal", "F", "-1.23e+8", "4.00e-4", "W", "12.50", "-19.60",
    ]);
    for (const row of capture.text) {
      expect(row.x).toBeGreaterThanOrEqual(0);
      expect(row.y).toBeGreaterThanOrEqual(0);
      expect(row.x + row.width).toBeLessThanOrEqual(268);
      expect(row.y + row.height).toBeLessThanOrEqual(220);
      expect(row.background).toBe(theme.css(theme.PANEL));
    }
  });

  it("bounds an overfull component card and explicitly reports omitted rows", () => {
    const capture = recorder();
    const rows = Array.from({ length: 64 }, () => ({ symbol: "F", parallel: 3, normal: 4, color: theme.ACCENT_HOT }));
    drawAnalysisOverlays(capture.ctx, [], [{ x: 10, y: 10, rows }], 320, 240);
    expect(capture.text.some(row => /^\+\d+ more forces$/.test(row.text))).toBe(true);
    expect(capture.text.some(row => row.text === "Open Force values")).toBe(true);
    expect(rows).toHaveLength(64);
    for (const row of capture.text) {
      expect(row.y + row.height).toBeLessThanOrEqual(240);
      expect(row.x + row.width).toBeLessThanOrEqual(320);
    }
  });

  it("stacks component pairs at enlarged text instead of clipping their columns", () => {
    const capture = recorder();
    drawAnalysisOverlays(capture.ctx, [], [{ x: 120, y: 120, rows: [
      { symbol: "F", parallel: -1.23e8, normal: 0.0004, color: theme.ACCENT_HOT },
    ] }], 268, 400, 2);
    expect(capture.text.map(row => row.text)).toContain("∥ -1.23e+8");
    expect(capture.text.map(row => row.text)).toContain("⊥ 4.00e-4");
    for (const row of capture.text) {
      expect(row.x + row.width).toBeLessThanOrEqual(268);
      expect(row.y + row.height).toBeLessThanOrEqual(400);
    }
  });

  it("leaves ordinary rendering untouched when no scientific annotations are enabled", () => {
    const capture = recorder();
    drawAnalysisOverlays(capture.ctx, [], [], 800, 600);
    expect(capture.text).toEqual([]);
    expect(capture.surfaces).toEqual([]);
  });

  it.each([0.0004, -0.0004, 1.23e8, -1.23e8, 3, -19.6, 0])(
    "formats %s without erasing its sign or small magnitude", value => {
      const displayed = Number(analysisNumber(value));
      expect(Math.abs(displayed - value)).toBeLessThanOrEqual(Math.max(0.005, Math.abs(value) * 0.005));
      expect(Math.sign(displayed)).toBe(Math.sign(value));
      expect(analysisNumber(value)).not.toBe("-0.00");
    });
});
