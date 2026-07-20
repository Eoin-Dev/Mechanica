/** Trail ring buffer: O(1) appends, newest-N retention, capacity changes and
 * the bounding box used for off-screen culling. */
import { describe, expect, it } from "vitest";
import { Trail } from "../src/render/trail";

const points = (t: Trail): Array<[number, number]> =>
  Array.from({ length: t.count }, (_, k) => [t.x(k), t.y(k)] as [number, number]);

describe("Trail ring buffer", () => {
  it("keeps points in chronological order below capacity", () => {
    const t = new Trail(5);
    t.push(0, 0); t.push(1, 10); t.push(2, 20);
    expect(t.count).toBe(3);
    expect(points(t)).toEqual([[0, 0], [1, 10], [2, 20]]);
  });

  it("evicts oldest, keeping the newest `capacity` points in order", () => {
    const t = new Trail(3);
    for (let i = 0; i < 7; i++) t.push(i, i * i);
    expect(t.count).toBe(3);
    expect(points(t)).toEqual([[4, 16], [5, 25], [6, 36]]);
  });

  it("tracks a bounding box that contains every retained point", () => {
    const t = new Trail(4);
    for (let i = 0; i < 20; i++) t.push(Math.sin(i) * 3, Math.cos(i) * 2);
    const pts = points(t);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    // box must contain all retained points and never be looser than the
    // recompute bound (recompute fires every `capacity` pushes)
    expect(t.minX).toBeLessThanOrEqual(Math.min(...xs));
    expect(t.maxX).toBeGreaterThanOrEqual(Math.max(...xs));
    expect(t.minY).toBeLessThanOrEqual(Math.min(...ys));
    expect(t.maxY).toBeGreaterThanOrEqual(Math.max(...ys));
  });

  it("shrinks capacity, keeping the newest points", () => {
    const t = new Trail(6);
    for (let i = 0; i < 6; i++) t.push(i, -i);
    t.setCapacity(3);
    expect(t.capacity).toBe(3);
    expect(points(t)).toEqual([[3, -3], [4, -4], [5, -5]]);
    t.push(6, -6);
    expect(points(t)).toEqual([[4, -4], [5, -5], [6, -6]]);
  });

  it("grows capacity, keeping existing points and order", () => {
    const t = new Trail(3);
    for (let i = 0; i < 5; i++) t.push(i, i); // holds [2,3,4]
    t.setCapacity(6);
    expect(t.capacity).toBe(6);
    expect(points(t)).toEqual([[2, 2], [3, 3], [4, 4]]);
    for (let i = 5; i < 9; i++) t.push(i, i);
    expect(points(t)).toEqual([[3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8]]);
  });

  it("expires points older than a cut-off (decay while standing still)", () => {
    const t = new Trail(100);
    for (let i = 0; i < 10; i++) t.push(i, i, i * 0.1); // t = 0.0 .. 0.9
    t.expireBefore(0.45);
    expect(points(t)).toEqual([[5, 5], [6, 6], [7, 7], [8, 8], [9, 9]]);
    // a body that stopped records nothing new, so the trail keeps
    // shrinking as its points age out - and eventually vanishes
    t.expireBefore(10.0);
    expect(t.count).toBe(0);
  });

  it("keeps serials monotonic through eviction and resizing", () => {
    const t = new Trail(3);
    expect(t.firstSerial).toBe(0);
    for (let i = 0; i < 5; i++) t.push(i, i, i); // evicts 2
    expect(t.firstSerial).toBe(2);
    t.expireBefore(3); // drops the point stamped t=2
    expect(t.firstSerial).toBe(3);
    t.setCapacity(1); // keeps only the newest
    expect(t.firstSerial).toBe(4);
  });

  it("append cost stays O(1): 200 trails * 350 cap is fast", () => {
    const trails = Array.from({ length: 200 }, () => new Trail(350));
    const t0 = performance.now();
    for (let s = 0; s < 2000; s++) {
      for (const t of trails) t.push(Math.sin(s), Math.cos(s));
    }
    // was ~1700 ms with the splice-array approach; ring buffer is ~50 ms
    expect(performance.now() - t0).toBeLessThan(400);
  });
});
