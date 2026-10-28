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

describe("force-owner identity markers", () => {
  const colours: [number, number, number][] = [[86, 172, 230], [245, 145, 70]];
  const intersects = (a: Box, b: { x: number; y: number; width: number; height: number }): boolean =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  function nearbyLabels(): AnalysisLabel[] {
    return colours.map((color, i) => ({ id: `body-${i}:friction`, text: "F 4.00 N",
      source: `Friction on particle ${i + 1}`, x: 420, y: 220 + i * 70, color: theme.WARN, right: false,
      owner: { tag: String(i + 1), x: 80 + i * 8, y: 100, radius: 3, color } }));
  }
  // The final copy of each identity badge is the one beside its body;
  // preceding copies belong to force-caption cards.
  const markers = (capture: ReturnType<typeof recorder>): Box[] => colours.map(color =>
    capture.surfaces.filter(box => box.colour === theme.css(color)).at(-1)!);

  it.each([1, 1.2, 2])("separates nearby body identities from each other, captions and HUD at scale %s", scale => {
    const capture = recorder(), hud = { x: 70, y: 65, width: 90, height: 32 };
    drawAnalysisOverlays(capture.ctx, nearbyLabels(), [], 600, 360, scale, null, [hud]);
    const badges = markers(capture), captions = capture.surfaces.filter(box => box.colour === theme.css(theme.PANEL));
    expect(badges).toHaveLength(2);
    expect(intersects(badges[0], badges[1])).toBe(false);
    for (const badge of badges) {
      expect(intersects(badge, hud)).toBe(false);
      expect(captions.some(caption => intersects(badge, caption))).toBe(false);
      expect(badge.x).toBeGreaterThanOrEqual(0); expect(badge.y).toBeGreaterThanOrEqual(0);
      expect(badge.x + badge.width).toBeLessThanOrEqual(600);
      expect(badge.y + badge.height).toBeLessThanOrEqual(360);
    }
  });

  it.each([1, 2])("keeps the full width of a long owner index inside the canvas at scale %s", scale => {
    const capture = recorder(), owner = { tag: "1234", x: 599, y: 100, radius: 3, color: colours[0] };
    drawAnalysisOverlays(capture.ctx, [{ id: "edge:weight", text: "W 9.81 N", x: 250, y: 260,
      color: theme.WARN, right: false, owner }], [], 600, 360, scale);
    const badge = markers(capture)[0];
    expect(badge.x + badge.width).toBeLessThanOrEqual(600);
    const glyph = capture.text.filter(row => row.text === "1234").at(-1)!;
    expect(glyph.x + glyph.width).toBeLessThanOrEqual(badge.x + badge.width);
  });

  it("retains unblocked body-marker positions through source reordering and small motion", () => {
    const capture = recorder(), labels = nearbyLabels();
    drawAnalysisOverlays(capture.ctx, labels, [], 600, 360);
    const first = markers(capture).map(box => ({ ...box }));
    capture.text.length = 0; capture.surfaces.length = 0;
    const shifted = [...labels].reverse().map(label => ({ ...label, x: label.x + 0.1,
      owner: { ...label.owner!, x: label.owner!.x + 0.1 } }));
    drawAnalysisOverlays(capture.ctx, shifted, [], 600, 360);
    const second = markers(capture);
    for (let i = 0; i < second.length; i++) {
      expect(second[i].x - first[i].x).toBeCloseTo(0.1, 7);
      expect(second[i].y).toBeCloseTo(first[i].y, 7);
    }
  });

  it("connects displaced identity markers before painting arrow ink", () => {
    const capture = recorder(), order: string[] = [];
    capture.ctx.stroke = () => order.push(capture.ctx.strokeStyle === theme.css(theme.TEXT_DIM) ? "owner-leader" : "caption-leader");
    drawAnalysisOverlays(capture.ctx, nearbyLabels(), [], 600, 360, 1, null,
      [{ x: 70, y: 65, width: 90, height: 32 }], () => order.push("vectors"));
    expect(order).toContain("owner-leader");
    expect(order.lastIndexOf("owner-leader")).toBeLessThan(order.indexOf("vectors"));
  });

  it("removes old identity placements and follows a reused tag to its current owner", () => {
    const capture = recorder();
    drawAnalysisOverlays(capture.ctx, nearbyLabels(), [], 600, 360);
    capture.text.length = 0; capture.surfaces.length = 0;
    const label = { ...nearbyLabels()[0], x: 100, y: 160,
      owner: { tag: "1", x: 480, y: 220, radius: 3, color: colours[0] } };
    drawAnalysisOverlays(capture.ctx, [label], [], 600, 360);
    const badge = markers(capture)[0];
    expect(Math.hypot(badge.x - label.owner.x, badge.y - label.owner.y)).toBeLessThan(100);
    expect(capture.text.filter(row => row.text === "2")).toHaveLength(0);
  });
});

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
      const powers: Record<string, string> = { "⁻": "-", "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9" };
      const displayed = Number(analysisNumber(value).replace(" × 10", "e")
        .replace(/[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]/g, digit => powers[digit]));
      expect(Math.abs(displayed - value)).toBeLessThanOrEqual(Math.max(0.005, Math.abs(value) * 0.005));
      expect(Math.sign(displayed)).toBe(Math.sign(value));
      expect(analysisNumber(value)).not.toBe("-0.00");
    });

  it("uses multiplication and superscript powers in scientific notation", () => {
    expect(analysisNumber(8.2e-11)).toBe("8.20 × 10⁻¹¹");
    expect(analysisNumber(-1.23e8)).toBe("-1.23 × 10⁸");
  });
});

describe("annotation layout reuse", () => {
  it("retains source placement and width through tip jitter, padding changes and source reorder", () => {
    const capture = recorder();
    const a: AnalysisLabel = { id: "body-1:friction", source: "Friction from Floor",
      text: "F 1.00 N", x: 200, y: 200, color: theme.WARN, right: true };
    const b: AnalysisLabel = { id: "body-2:reaction", source: "Reaction from Floor",
      text: "R 9.81 N", x: 440, y: 100, color: theme.GOOD, right: true };
    let wide = true;
    capture.ctx.measureText = value => ({ width: value === a.text ? (wide ? 62.5 : 60.5) : 40 }) as TextMetrics;
    const render = (labels: AnalysisLabel[], vectors: { x1: number; y1: number; x2: number; y2: number }[]) => {
      capture.text.length = 0; capture.surfaces.length = 0;
      drawAnalysisOverlays(capture.ctx, labels, vectors, 700, 400);
      return capture.surfaces.filter(box => box.colour === theme.css(theme.PANEL));
    };
    const first = render([a, b], [{ x1: 215, y1: 180, x2: 400, y2: 180 }]);
    const offset = { x: first[0].x - a.x, y: first[0].y - a.y };
    expect(offset.y).toBeGreaterThan(0);
    for (let frame = 0; frame < 40; frame++) {
      const reversed = frame % 2 === 0; wide = !reversed;
      a.x = 200 + (frame % 3 - 1) * .2; a.y = 200 + (frame % 3 - 1) * .2;
      const boxes = render(reversed ? [b, a] : [a, b],
        [{ x1: 215, y1: 196 + (frame % 2 ? .5 : -.5), x2: 400, y2: 196 + (frame % 2 ? .5 : -.5) }]);
      const box = boxes[reversed ? 1 : 0];
      expect(box.width).toBe(first[0].width);
      expect(box.x - a.x).toBeCloseTo(offset.x, 9);
      expect(box.y - a.y).toBeCloseTo(offset.y, 9);
      expect(capture.text[reversed ? 1 : 0].text).toBe(a.text);
    }
  });

  it("moves a retained source when its caption is blocked and resets for a new viewport or scale", () => {
    const capture = recorder();
    const label: AnalysisLabel = { id: "weight", text: "W 9.81 N", x: 220, y: 130,
      color: theme.BAD, right: true };
    const render = (width: number, height: number, scale = 1, reserved: Box[] = []) => {
      capture.text.length = 0; capture.surfaces.length = 0;
      drawAnalysisOverlays(capture.ctx, [label], [], width, height, scale, null, reserved);
      return capture.surfaces.find(box => box.colour === theme.css(theme.PANEL))!;
    };
    const first = render(600, 400), blocked = render(600, 400, 1, [first]);
    expect(blocked.y + blocked.height <= first.y || blocked.y >= first.y + first.height ||
      blocked.x + blocked.width <= first.x || blocked.x >= first.x + first.width).toBe(true);
    theme.setTheme("light");
    const resized = render(260, 160, 1.2);
    expect(resized.x).toBeGreaterThanOrEqual(0); expect(resized.y).toBeGreaterThanOrEqual(0);
    expect(resized.x + resized.width).toBeLessThanOrEqual(260);
    expect(resized.y + resized.height).toBeLessThanOrEqual(160);
    expect(capture.text[0].text).toBe(label.text);
    expect(capture.text[0].fontSize).toBeCloseTo(14.4, 10);
  });

  it("matches a fresh layout after viewport, font, text, arrow and preference changes", () => {
    const pooled = recorder();
    const labels: AnalysisLabel[] = [
      { text: "W 9.81 N", source: "Weight", x: 210, y: 140, color: theme.BAD, right: true },
      { text: "R 8.50 N", source: "Plane", x: 210, y: 140, color: theme.GOOD, right: false },
    ];
    const vectors = [{ x1: 170, y1: 100, x2: 210, y2: 140 }];
    let width = 450, height = 320, scale = 1, metrics = 1;
    const compare = () => {
      pooled.text.length = 0; pooled.surfaces.length = 0;
      const fresh = recorder();
      for (const capture of [pooled, fresh])
        capture.ctx.measureText = value => ({ width: value.length * 12 * scale * 0.6 * metrics }) as TextMetrics;
      drawAnalysisOverlays(pooled.ctx, labels, vectors, width, height, scale, [190, 120]);
      drawAnalysisOverlays(fresh.ctx, labels, vectors, width, height, scale, [190, 120]);
      expect(pooled.text).toEqual(fresh.text); expect(pooled.surfaces).toEqual(fresh.surfaces);
    };
    compare(); compare();
    labels[0].text = "W 1.23 N"; labels[0].source = "Updated source"; labels[0].color = theme.WARN; compare();
    labels[0].x += 10; compare(); labels[0].right = false; compare();
    vectors[0].x2 += 20; compare();
    width = 280; height = 190; compare();
    scale = 1.2; compare(); metrics = 1.4; compare();
    theme.setTheme("light"); compare();
    labels.push({ ...labels[0], text: "T 2.00 N" }); compare();
    vectors.push({ x1: 1, y1: 1, x2: 270, y2: 180 }); compare();
  });
});


describe("canvas HUD separation", () => {
  const hud = { x: 460, y: 258, width: 116, height: 30 };
  const label: AnalysisLabel = { text: "f 1000.00 N", source: "Applied force",
    x: 480, y: 290, color: theme.WARN, right: true };
  const intersects = (a: Box, b: typeof hud) => a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;

  it.each([1, 1.2, 2])("keeps force captions and hover sources off the scale marker at text scale %s", scale => {
    const capture = recorder();
    drawAnalysisOverlays(capture.ctx, [label], [], 600, 300, scale, [482, 289], [hud]);
    const panels = capture.surfaces.filter(box => box.colour === theme.css(theme.PANEL));
    expect(panels.length).toBeGreaterThanOrEqual(1);
    expect(panels.every(box => !intersects(box, hud))).toBe(true);
    // Hovering the relocated caption still resolves the correct source.
    const caption = panels[0];
    const source = recorder();
    drawAnalysisOverlays(source.ctx, [label], [], 600, 300, scale,
      [caption.x + 3, caption.y + 3], [hud]);
    expect(source.text.some(row => row.text === "Applied force")).toBe(true);
    expect(source.surfaces.filter(box => box.colour === theme.css(theme.PANEL))
      .every(box => !intersects(box, hud))).toBe(true);
  });

  it("invalidates a retained layout when HUD geometry changes without scene changes", () => {
    const pooled = recorder();
    const shifted = { x: 350, y: 200, width: 226, height: 88 };
    for (const obstacles of [[hud], [shifted], []]) {
      pooled.text.length = 0; pooled.surfaces.length = 0;
      const fresh = recorder();
      drawAnalysisOverlays(pooled.ctx, [label], [], 600, 300, 1, null, obstacles);
      drawAnalysisOverlays(fresh.ctx, [label], [], 600, 300, 1, null, obstacles);
      expect(pooled.surfaces).toEqual(fresh.surfaces);
      expect(pooled.text).toEqual(fresh.text);
      const panels = pooled.surfaces.filter(box => box.colour === theme.css(theme.PANEL));
      expect(panels.every(box => obstacles.every(obstacle => !intersects(box, obstacle)))).toBe(true);
    }
  });
});

it("removes owner badges and shrinks their caption space when numbering is turned off", () => {
  const capture = recorder();
  const label: AnalysisLabel = { id: "weight", text: "W 9.81 N", x: 200, y: 100, color: theme.ACCENT,
    right: true, owner: { tag: "1", x: 100, y: 100, radius: 10, color: [86, 172, 230] } };
  drawAnalysisOverlays(capture.ctx, [label], [], 600, 300);
  const previous = capture.surfaces.find(box => box.colour === theme.css(theme.PANEL))!.width;
  capture.surfaces.length = 0; capture.text.length = 0;
  drawAnalysisOverlays(capture.ctx, [{ ...label, owner: undefined }], [], 600, 300);
  expect(capture.text.map(text => text.text)).toEqual(["W 9.81 N"]);
  expect(capture.surfaces.find(box => box.colour === theme.css(theme.PANEL))!.width).toBeLessThan(previous);
});
