/** The world <-> screen transform.
 *
 * This had no tests whatsoever, which a mutation run made obvious: moving
 * the screen centre in `toWorld` from 0.5 to 0.4 of the canvas width - so
 * every click lands on a different world point than the one drawn under the
 * cursor - left the entire suite green.
 *
 * Every pick, drag, box-select, zoom-to-cursor and trail vertex goes through
 * these four functions, so an error here is not subtle in USE even though it
 * is invisible to a physics test: objects stop being where they look.
 */
import { describe, expect, it } from "vitest";
import { Camera, MAX_ZOOM, MIN_ZOOM, formatG, niceNumber } from "../src/render/camera";
import { Vec2 } from "../src/core/vec";

const cam = (w = 800, h = 600): Camera => new Camera(w, h);

describe("world <-> screen round trip", () => {
  it("is an exact inverse at any zoom, centre and point", () => {
    const c = cam();
    for (const zoom of [MIN_ZOOM, 12.5, 88, 400, MAX_ZOOM]) {
      for (const centre of [[0, 0], [13.5, -7.25], [-1e3, 1e3]] as const) {
        c.zoom = zoom;
        c.centre.set(centre[0], centre[1]);
        for (const p of [[0, 0], [1, -1], [123.5, 456.75], [-9.5, 0.25]] as const) {
          const [sx, sy] = c.toScreenXY(p[0], p[1]);
          const back = c.toWorld(sx, sy);
          expect(back.x).toBeCloseTo(p[0], 9);
          expect(back.y).toBeCloseTo(p[1], 9);
        }
      }
    }
  });

  it("puts the camera centre at the middle of the canvas", () => {
    const c = cam(800, 600);
    c.centre.set(5, -3);
    const [sx, sy] = c.toScreenXY(5, -3);
    expect(sx).toBeCloseTo(400, 9);
    expect(sy).toBeCloseTo(300, 9);
  });

  it("uses screen y-down against world y-up", () => {
    const c = cam();
    const [, above] = c.toScreenXY(0, 1);
    const [, below] = c.toScreenXY(0, -1);
    expect(above).toBeLessThan(below);
  });

  it("scales by exactly `zoom` pixels per metre", () => {
    const c = cam();
    c.zoom = 137;
    const [x0] = c.toScreenXY(0, 0);
    const [x1] = c.toScreenXY(1, 0);
    expect(x1 - x0).toBeCloseTo(137, 9);
  });

  it("toScreen and toScreenXY agree", () => {
    const c = cam();
    c.centre.set(2, 3);
    c.zoom = 55;
    expect(c.toScreen(new Vec2(-4, 8))).toEqual(c.toScreenXY(-4, 8));
  });
});

describe("panning", () => {
  it("moves the world under the cursor by exactly the pixels given", () => {
    const c = cam();
    c.zoom = 100;
    const before = c.toWorld(400, 300);
    c.panPixels(50, -25);
    const after = c.toWorld(450, 275);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("is reversible", () => {
    const c = cam();
    const start = c.centre.copy();
    c.panPixels(37, -12);
    c.panPixels(-37, 12);
    expect(c.centre.x).toBeCloseTo(start.x, 9);
    expect(c.centre.y).toBeCloseTo(start.y, 9);
  });
});

describe("zoom at the cursor", () => {
  it("keeps the world point under the cursor fixed", () => {
    for (const [sx, sy] of [[400, 300], [0, 0], [800, 600], [123, 45]] as const) {
      const c = cam();
      c.centre.set(2, -1);
      const before = c.toWorld(sx, sy);
      c.zoomAt(sx, sy, 1.7);
      const after = c.toWorld(sx, sy);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it("clamps to the zoom limits and stays finite there", () => {
    const c = cam();
    for (let i = 0; i < 200; i++) c.zoomAt(400, 300, 1.5);
    expect(c.zoom).toBe(MAX_ZOOM);
    expect(Number.isFinite(c.centre.x)).toBe(true);
    for (let i = 0; i < 400; i++) c.zoomAt(400, 300, 0.5);
    expect(c.zoom).toBe(MIN_ZOOM);
    expect(Number.isFinite(c.centre.x)).toBe(true);
  });

  it("a zoom in and back out returns the same view", () => {
    const c = cam();
    c.centre.set(1.5, 2.5);
    const z0 = c.zoom;
    const p0 = c.toWorld(200, 100);
    c.zoomAt(200, 100, 2);
    c.zoomAt(200, 100, 0.5);
    expect(c.zoom).toBeCloseTo(z0, 9);
    const p1 = c.toWorld(200, 100);
    expect(p1.x).toBeCloseTo(p0.x, 6);
    expect(p1.y).toBeCloseTo(p0.y, 6);
  });
});

describe("visible bounds", () => {
  it("are exactly the corners the transform maps to", () => {
    const c = cam(800, 600);
    c.zoom = 40;
    c.centre.set(-2, 6);
    const [minX, minY, maxX, maxY] = c.visibleBounds();
    const topLeft = c.toWorld(0, 0);
    const bottomRight = c.toWorld(800, 600);
    expect(minX).toBeCloseTo(topLeft.x, 9);
    expect(maxY).toBeCloseTo(topLeft.y, 9);
    expect(maxX).toBeCloseTo(bottomRight.x, 9);
    expect(minY).toBeCloseTo(bottomRight.y, 9);
  });

  it("track a resize", () => {
    const c = cam(800, 600);
    c.resize(400, 300);
    const [minX, , maxX] = c.visibleBounds();
    expect(maxX - minX).toBeCloseTo(400 / c.zoom, 9);
  });
});

describe("scale bar", () => {
  it("picks a 1/2/5 x 10^k length that spans a readable pixel width", () => {
    const c = cam();
    for (const zoom of [MIN_ZOOM, 5, 20, 88, 300, 1200, MAX_ZOOM]) {
      c.zoom = zoom;
      const [metres, label] = c.niceScaleLength();
      const mant = metres / 10 ** Math.floor(Math.log10(metres));
      expect([1, 2, 5].some((m) => Math.abs(mant - m) < 1e-9)).toBe(true);
      expect(metres * zoom).toBeGreaterThan(20);
      expect(metres * zoom).toBeLessThan(400);
      expect(label).toMatch(/\d.*(mm|m)$/);
    }
  });

  it("niceNumber only ever returns 1/2/5 x 10^k", () => {
    for (const target of [0.003, 0.07, 0.4, 1, 3, 17, 260, 9000]) {
      const n = niceNumber(target);
      const mant = n / 10 ** Math.round(Math.log10(n));
      expect([0.1, 0.2, 0.5, 1, 2, 5].some((m) => Math.abs(mant - m) < 1e-9)).toBe(true);
    }
  });

  it("formatG stays compact and never says NaN for a real number", () => {
    expect(formatG(0)).toBe("0");
    expect(formatG(1)).toBe("1");
    expect(formatG(0.5)).toBe("0.5");
    expect(formatG(1234.5)).toBe("1234.5");
    expect(formatG(1e-9)).toMatch(/e/);
    expect(formatG(-2.5)).toBe("-2.5");
  });
});
