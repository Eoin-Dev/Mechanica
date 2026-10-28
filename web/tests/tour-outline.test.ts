import { describe, expect, it } from "vitest";
import { spotlightContours, spotlightOutline, type SpotlightPoint } from "../src/ui/tour-spotlight";

function area(points: SpotlightPoint[]): number {
  return Math.abs(points.reduce((sum, p, i) => {
    const next = points[(i + 1) % points.length];
    return sum + p.x * next.y - p.y * next.x;
  }, 0)) / 2;
}

describe("tour spotlight union", () => {
  it("joins the scene and footer without highlighting the side panels between them", () => {
    const contours = spotlightContours([{ x: 80, y: 70, w: 1100, h: 700 },
      { x: 2, y: 766, w: 1276, h: 32 }]);
    expect(contours).toHaveLength(1);
    expect(contours[0]).toHaveLength(8);
    expect(area(contours[0])).toBe(1100 * 700 + 1276 * 32 - 1100 * 4);
  });

  it("removes the shared seam between adjacent canvas and Inspector highlights", () => {
    const contours = spotlightContours([{ x: 2, y: 70, w: 1004, h: 700 },
      { x: 998, y: 70, w: 280, h: 700 }]);
    expect(contours).toHaveLength(1);
    expect(contours[0]).toHaveLength(4);
    expect(area(contours[0])).toBe(1276 * 700);
  });

  it("keeps separate buttons separate and leaves the gap dimmed", () => {
    const contours = spotlightContours([{ x: 1100, y: 8, w: 90, h: 44 },
      { x: 1200, y: 8, w: 44, h: 44 }]);
    expect(contours).toHaveLength(2);
    expect(contours.map(area).sort((a, b) => a - b)).toEqual([44 * 44, 90 * 44]);
  });

  it("does not draw duplicate outlines for nested or identical targets", () => {
    const outer = { x: 2, y: 2, w: 200, h: 300 };
    const contours = spotlightContours([outer, outer, { x: 20, y: 40, w: 40, h: 50 }]);
    expect(contours).toHaveLength(1);
    expect(contours[0]).toHaveLength(4);
    expect(area(contours[0])).toBe(60000);
  });

  it("keeps rectangles touching only at a corner as independent closed contours", () => {
    const contours = spotlightContours([{ x: 2, y: 2, w: 20, h: 20 },
      { x: 22, y: 22, w: 20, h: 20 }]);
    expect(contours).toHaveLength(2);
    expect(contours.map(area)).toEqual([400, 400]);
  });

  it("rounds the actual union corners and handles an empty spotlight", () => {
    expect(spotlightOutline([])).toBe("");
    const path = spotlightOutline([{ x: 2, y: 2, w: 100, h: 50 }]);
    expect(path).not.toMatch(/NaN|Infinity/);
    expect(path.match(/Q/g)).toHaveLength(4);
    expect(path.startsWith("M")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
  });
});
