import { afterEach, describe, expect, it } from "vitest";
import { analysisNumber, analysisForceColour, drawAnalysisOverlays, type AnalysisLabel } from "../src/render/analysis-overlays";
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
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {}, setLineDash() {},
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
  it.each(theme.THEME_NAMES)("keeps force ink distinct and visible over its %s contour", name => {
    theme.setTheme(name);
    const contour: [number, number, number] = name === "light" ? [255, 255, 255] : [8, 8, 8];
    const colours = ["weight", "reaction", "friction", "applied", "spring", "drag", "correction"] as const;
    for (const kind of colours) {
      expect(theme.contrastRatio(analysisForceColour(kind), contour)).toBeGreaterThanOrEqual(3);
    }
    expect(new Set(colours.map(kind => theme.css(analysisForceColour(kind)))).size).toBe(colours.length);
  });

  it("identifies a force source when hovering its shaft without adding permanent copy", () => {
    const label = { text: "F 2.00 N", source: "Friction from Floor", x: 300, y: 200,
      color: theme.WARN, right: true };
    const vector = { x1: 200, y1: 200, x2: 300, y2: 200 };
    const idle = recorder();
    drawAnalysisOverlays(idle.ctx, [label], [vector], 600, 400);
    expect(idle.text.map(row => row.text)).toEqual(["F 2.00 N"]);
    const hovered = recorder();
    drawAnalysisOverlays(hovered.ctx, [label], [vector], 600, 400, 1, [250, 202]);
    expect(hovered.text.map(row => row.text)).toContain("Friction from Floor");
    const away = recorder();
    drawAnalysisOverlays(away.ctx, [label], [vector], 600, 400, 1, [250, 210]);
    expect(away.text.map(row => row.text)).toEqual(["F 2.00 N"]);
  });

  it("identifies a source from its caption and bounds long-source hover surfaces", () => {
    const label = { text: "R 9.81 N", source: "Reaction from " + "a long wall name ".repeat(100),
      x: 220, y: 120, color: theme.GOOD, right: true };
    const idle = recorder();
    drawAnalysisOverlays(idle.ctx, [label], [], 268, 220, 1.2);
    const caption = idle.surfaces.find(box => box.colour === theme.css(theme.PANEL))!;
    const hovered = recorder();
    drawAnalysisOverlays(hovered.ctx, [label], [], 268, 220, 1.2,
      [caption.x + caption.width / 2, caption.y + caption.height / 2]);
    expect(hovered.text.length).toBeGreaterThan(1);
    expect(hovered.text.length).toBeLessThanOrEqual(5);
    for (const box of hovered.surfaces.filter(box => box.colour === theme.css(theme.PANEL))) {
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(268);
      expect(box.y + box.height).toBeLessThanOrEqual(220);
    }
    const popup = hovered.surfaces.filter(box => box.colour === theme.css(theme.PANEL)).at(-1)!;
    expect(popup.x + popup.width).toBeLessThanOrEqual(268 - 30);
  });
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

  it.each([1, 1.2, 2])("keeps weight captions clear of other arrow tips and diagonal shafts at scale %s", scale => {
    const capture = recorder();
    const vectors = [
      { x1: 400, y1: 220, x2: 400, y2: 390 },
      { x1: 400, y1: 220, x2: 330, y2: 365 },
      { x1: 400, y1: 220, x2: 480, y2: 260 },
    ];
    drawAnalysisOverlays(capture.ctx, [
      { text: "W 9.81 N", x: 400, y: 390, color: theme.BAD, right: false },
      { text: "F⊥ -8.89 N", x: 330, y: 365, color: theme.ACC_COLOR, right: false },
      { text: "F∥ 4.15 N", x: 480, y: 260, color: theme.SELECTION, right: true },
    ], vectors, 800, 600, scale);
    const boxes = capture.surfaces.filter(box => box.colour === theme.css(theme.PANEL));
    expect(boxes).toHaveLength(3);
    for (const box of boxes) for (const vector of vectors) {
      // Sample the rendered shaft independently of the layout's clipping code.
      for (let step = 0; step <= 40; step++) {
        const x = vector.x1 + (vector.x2 - vector.x1) * step / 40;
        const y = vector.y1 + (vector.y2 - vector.y1) * step / 40;
        const dx = Math.max(box.x - x, 0, x - box.x - box.width);
        const dy = Math.max(box.y - y, 0, y - box.y - box.height);
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(7 * scale - 1e-9);
      }
    }
    expect(capture.text.some(row => row.text.includes("Slope components"))).toBe(false);
  });

  it("keeps large and small signed component arrow labels complete on a narrow canvas", () => {
    const capture = recorder();
    drawAnalysisOverlays(capture.ctx, [
      { text: "F∥ -1.23e+8 N", x: 230, y: 150, color: theme.SELECTION, right: true },
      { text: "F⊥ 4.00e-4 N", x: 230, y: 150, color: theme.ACC_COLOR, right: true },
    ], [], 268, 220, 1.2);
    expect(capture.text.map(row => row.text)).toEqual(["F∥ -1.23e+8 N", "F⊥ 4.00e-4 N"]);
    for (const row of capture.text) {
      expect(row.x).toBeGreaterThanOrEqual(0);
      expect(row.y).toBeGreaterThanOrEqual(0);
      expect(row.x + row.width).toBeLessThanOrEqual(268);
      expect(row.y + row.height).toBeLessThanOrEqual(220);
      expect(row.background).toBe(theme.css(theme.PANEL));
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
