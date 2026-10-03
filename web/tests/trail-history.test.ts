import { describe, expect, it } from "vitest";
import { Trail } from "../src/render/trail";
import { TrailHistory } from "../src/render/trail-history";

const rows = (trail: Trail) => Array.from({ length: trail.count }, (_, k) =>
  [trail.x(k), trail.y(k), trail.time(k), trail.firstSerial + k]);

describe("bounded trail history", () => {
  it("restores old points after the display ring has overwritten and expired them", () => {
    const tape = new TrailHistory(48 * 50), ring = new Trail(5);
    for (let k = 0; k < 20; k++) {
      tape.push(7, ring.firstSerial + ring.count, k, -k, k / 10);
      ring.push(k, -k, k / 10);
    }
    ring.expireBefore(3); expect(ring.count).toBe(0);
    tape.truncateAfter(0.3); tape.restoreTrail(7, ring, 0, 0.3);
    expect(rows(ring)).toEqual([[0, -0, 0, 0], [1, -1, 0.1, 1], [2, -2, 0.2, 2], [3, -3, 0.3, 3]]);
  });

  it("preserves sample serials and the newest display subset through a capacity change", () => {
    const tape = new TrailHistory(48 * 20), ring = new Trail(3);
    for (let k = 0; k < 15; k++) tape.push(1, k, k, 0, k);
    tape.restoreTrail(1, ring, 0, 10);
    expect(rows(ring)).toEqual([[8, 0, 8, 8], [9, 0, 9, 9], [10, 0, 10, 10]]);
    ring.setCapacity(6); tape.restoreTrail(1, ring, 0, 10);
    expect(rows(ring).map(row => row[3])).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it("removes an abandoned future from every body before a branch continues", () => {
    const tape = new TrailHistory(48 * 30), ring = new Trail(20);
    for (let k = 0; k < 8; k++) for (const id of [1, 2]) tape.push(id, k, k * id, 0, k);
    tape.truncateAfter(3); tape.push(1, 4, -4, 0, 4);
    tape.restoreTrail(1, ring, 0, 8);
    expect(rows(ring).map(row => row[0])).toEqual([0, 1, 2, 3, -4]);
    tape.restoreTrail(2, ring, 0, 8);
    expect(rows(ring).map(row => row[0])).toEqual([0, 2, 4, 6]);
  });

  it("allocates only when used and releases retained storage and body indices on clear", () => {
    const tape = new TrailHistory(48 * 7);
    expect(tape.bytesUsed).toBe(0);
    for (let k = 0; k < 100; k++) tape.push(k, 0, k, 0, k);
    expect(tape.count).toBe(7); expect(tape.bodyCount).toBe(7);
    expect(tape.bytesUsed).toBe(48 * 7); expect(tape.earliestTime).toBe(93);
    tape.clear(); expect(tape.bytesUsed).toBe(0); expect(tape.bodyCount).toBe(0);
    expect(tape.earliestTime).toBeNull();
  });

  it.each([0, -1, 47, Infinity, NaN])("rejects invalid storage budget %s", budget => {
    expect(() => new TrailHistory(budget)).toThrow(RangeError);
  });

  it.each([1, 2, 7, 129, 400])("matches an independent chronological array with %s retained slots", capacity => {
    const tape = new TrailHistory(capacity * 48), ring = new Trail(30);
    let expected: number[][] = [], time = 0, seed = 740391;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let step = 0; step < 2000; step++) {
      const op = Math.floor(random() * 10);
      if (op < 7) {
        time += Math.floor(random() * 3) * 0.01;
        const id = Math.floor(random() * 21), x = step * 0.001, y = -id;
        const serial = (expected.filter(row => row[0] === id).at(-1)?.[4] ?? -1) + 1;
        tape.push(id, serial, x, y, time); expected.push([id, x, y, time, serial]);
        if (expected.length > capacity) expected.shift();
      } else if (op === 7) {
        time = Math.max(0, time - random() * 0.15);
        tape.truncateAfter(time); expected = expected.filter(row => row[3] <= time + 1e-12);
      } else if (op === 8) {
        const threshold = Math.max(0, time - random() * 0.2);
        tape.expireBefore(threshold); expected = expected.filter(row => row[3] >= threshold);
      }
      const id = Math.floor(random() * 21), cutoff = Math.max(0, time - random() * 0.2);
      tape.restoreTrail(id, ring, cutoff, time);
      expect(rows(ring)).toEqual(expected.filter(row => row[0] === id &&
        row[3] >= cutoff && row[3] <= time + 1e-12).slice(-ring.capacity)
        .map(row => [row[1], row[2], row[3], row[4]]));
      expect(tape.count).toBe(expected.length);
      expect(tape.bodyCount).toBe(new Set(expected.map(row => row[0])).size);
      expect(tape.bytesUsed).toBeLessThanOrEqual(capacity * 48);
    }
  });
});