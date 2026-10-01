/** Resource limits, exact geometry and graceful vector fallback for glyphs. */
import { describe, expect, it, vi } from "vitest";
import type { Color } from "../src/engine/body";
import { ParticleAtlas } from "../src/render/particle-atlas";

const colour: Color = [86, 156, 214];

function fixture(dpr = 2) {
  const matrix = { a: dpr, d: dpr, b: 0, c: 0, e: 0, f: 0 };
  const target = {
    getTransform: () => matrix, globalAlpha: 1, globalCompositeOperation: "source-over",
    drawImage: vi.fn(),
  };
  const bitmaps: HTMLCanvasElement[] = [];
  const circles: Array<{ x: number; y: number; radius: number }> = [];
  let transform = [1, 0, 0, 1, 0, 0];
  const painter = {
    setTransform: vi.fn((...values: number[]) => { transform = values; }),
    beginPath: vi.fn(),
    arc: vi.fn((x: number, y: number, radius: number) => {
      circles.push({ x: transform[4] + x * transform[0],
        y: transform[5] + y * transform[3], radius: radius * transform[0] });
    }),
    fill: vi.fn(), stroke: vi.fn(),
  };
  const factory = vi.fn(() => {
    const bitmap = { width: 0, height: 0, getContext: () => painter } as unknown as HTMLCanvasElement;
    bitmaps.push(bitmap);
    return bitmap;
  });
  const atlas = new ParticleAtlas(factory);
  const ctx = target as unknown as CanvasRenderingContext2D;
  const world = {};
  atlas.begin(ctx, 100, world, 500);
  const draw = (x = 10, y = 10, radius = 2, tint = colour) =>
    atlas.draw(ctx, x, y, radius, tint);
  return { atlas, ctx, target, matrix, world, factory, bitmaps, painter, circles, draw };
}

describe("tiny particle atlas", () => {
  it("reuses a colour's subpixel glyphs without repainting or allocating per body", () => {
    const f = fixture();
    expect(f.draw()).toBe(true);
    expect(f.painter.arc).toHaveBeenCalledTimes(64);
    for (let index = 0; index < 1000; index++) expect(f.draw(index / 13, -index / 11)).toBe(true);
    expect(f.factory).toHaveBeenCalledOnce();
    expect(f.painter.arc).toHaveBeenCalledTimes(64);
    expect(f.target.drawImage).toHaveBeenCalledTimes(1001);
  });

  it("keeps centres within one sixteenth of a device pixel and preserves radii", () => {
    const f = fixture(2.5);
    for (const [x, y] of [[-12.999, -0.02], [0.999, -0.999], [3.0123, 8.981], [0, 0]]) {
      expect(f.draw(x, y, 3.5)).toBe(true);
      const [, sx, sy, width, height, dx, dy, targetWidth, targetHeight] = f.target.drawImage.mock.calls.at(-1)!;
      const circle = f.circles.find(value => value.x >= sx && value.x < sx + width && value.y >= sy && value.y < sy + height)!;
      expect(circle.radius).toBe(3.5 * 2.5);
      expect(Math.abs(dx * 2.5 + circle.x - sx - x * 2.5)).toBeLessThanOrEqual(1 / 16 + 1e-12);
      expect(Math.abs(dy * 2.5 + circle.y - sy - y * 2.5)).toBeLessThanOrEqual(1 / 16 + 1e-12);
      expect(targetWidth * 2.5).toBe(width);
      expect(targetHeight * 2.5).toBe(height);
    }
  });

  it("bounds bitmap count and colour capacity without evicting useful glyphs", () => {
    const f = fixture(2.5);
    for (const radius of [2, 4.99]) {
      for (let red = 0; red < 16; red++) expect(f.draw(10, 10, radius, [red, 100, 100])).toBe(true);
      expect(f.draw(10, 10, radius, [17, 100, 100])).toBe(false);
      expect(f.draw(10, 10, radius, [0, 100, 100])).toBe(true);
    }
    expect(f.draw(10, 10, 3)).toBe(false);
    expect(f.bitmaps).toHaveLength(2);
    expect(f.bitmaps.every(bitmap => bitmap.width * bitmap.height < 1024 * 1024)).toBe(true);
  });

  it("releases old bitmaps when zoom, DPR or world identity changes", () => {
    const f = fixture();
    f.draw();
    f.atlas.begin(f.ctx, 100, f.world, 500);
    expect(f.bitmaps[0].width).toBeGreaterThan(0);
    f.atlas.begin(f.ctx, 101, f.world, 500);
    expect(f.bitmaps[0].width).toBe(0);
    expect(f.bitmaps[0].height).toBe(0);
    f.draw();
    f.matrix.a = f.matrix.d = 2.5;
    f.atlas.begin(f.ctx, 101, f.world, 500);
    expect(f.bitmaps[1].width).toBe(0);
    f.draw();
    f.atlas.begin(f.ctx, 101, {}, 500);
    expect(f.bitmaps[2].width).toBe(0);
  });

  it("retains vector drawing for small scenes, unsupported transforms and compositing", () => {
    const f = fixture();
    for (const count of [0, 499]) {
      f.atlas.begin(f.ctx, 100, f.world, count);
      expect(f.draw()).toBe(false);
    }
    for (const dpr of [1, 3]) {
      f.matrix.a = f.matrix.d = dpr;
      f.atlas.begin(f.ctx, 100, f.world, 500);
      expect(f.draw()).toBe(false);
    }
    f.matrix.a = f.matrix.d = 2;
    for (const field of ["b", "c", "e", "f"] as const) {
      f.matrix[field] = 1;
      f.atlas.begin(f.ctx, 100, f.world, 500);
      expect(f.draw()).toBe(false);
      f.matrix[field] = 0;
    }
    f.target.globalAlpha = 0.5;
    f.atlas.begin(f.ctx, 100, f.world, 500);
    expect(f.draw()).toBe(false);
    f.target.globalAlpha = 1;
    f.target.globalCompositeOperation = "multiply";
    f.atlas.begin(f.ctx, 100, f.world, 500);
    expect(f.draw()).toBe(false);
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("rejects invalid geometry and colours without allocating or aliasing glyphs", () => {
    const f = fixture();
    for (const radius of [0, 1.99, 5, NaN, Infinity]) expect(f.draw(10, 10, radius)).toBe(false);
    expect(f.draw(NaN)).toBe(false);
    expect(f.draw(10, Infinity)).toBe(false);
    expect(f.draw(Number.MAX_VALUE)).toBe(false);
    expect(f.draw(10, -Number.MAX_VALUE)).toBe(false);
    for (const tint of [[-1, 0, 0], [256, 0, 0], [1.5, 0, 0], [NaN, 0, 0]] as Color[]) {
      expect(f.draw(10, 10, 2, tint)).toBe(false);
    }
    expect(f.factory).not.toHaveBeenCalled();
    const mutable: Color = [10, 100, 100];
    expect(f.draw(10, 10, 2, mutable)).toBe(true);
    mutable[0] = 20;
    expect(f.draw(10, 10, 2, mutable)).toBe(true);
    expect(f.painter.arc).toHaveBeenCalledTimes(128);
  });

  it("falls back after bitmap allocation fails and retries after context identity changes", () => {
    const f = fixture();
    const factory = vi.fn(() => null as HTMLCanvasElement | null);
    const atlas = new ParticleAtlas(factory);
    atlas.begin(f.ctx, 100, f.world, 500);
    expect(atlas.draw(f.ctx, 10, 10, 2, colour)).toBe(false);
    atlas.begin(f.ctx, 100, f.world, 500);
    expect(atlas.draw(f.ctx, 10, 10, 2, colour)).toBe(false);
    expect(factory).toHaveBeenCalledOnce();
    factory.mockImplementation(f.factory);
    atlas.begin(f.ctx, 101, f.world, 500);
    expect(atlas.draw(f.ctx, 10, 10, 2, colour)).toBe(true);
  });
});
