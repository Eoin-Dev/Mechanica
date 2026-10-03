import { describe, expect, it } from "vitest";
import { ConstraintForceSolve } from "../src/engine/constraint-forces";

describe("coupled constraint force linear systems", () => {
  it.each([1, 10, 1000, 1e9])("solves strongly coupled loads with mass %s", mass => {
    const solve = new ConstraintForceSolve(); solve.prepare(2);
    solve.matrix.set([0.25 + 1 / mass, 0.25, 0.25, 0.25 + 1 / mass]);
    solve.rhs.set([1, 1]);
    expect(solve.solve(2)).toBe(true);
    const tension = mass / (1 + mass / 2);
    // A matrix condition near 5e8 has an appropriately looser floating-point
    // tolerance; both equations must still close independently.
    const tolerance = mass > 1e6 ? 1e-7 : 1e-10;
    for (let i = 0; i < 2; i++) {
      expect(Math.abs(solve.solution[i] - tension)).toBeLessThan(tolerance);
      expect(Math.abs(solve.matrix[i * 2] * solve.solution[0] + solve.matrix[i * 2 + 1] * solve.solution[1] - 1)).toBeLessThan(1e-12);
    }
  });

  it("allows compression in a rod while making an inward-driven rope slack", () => {
    const solve = new ConstraintForceSolve(); solve.prepare(2);
    solve.matrix.set([2, 0.5, 0.5, 1]); solve.rhs.set([-1, 1]);
    expect(solve.solve(2)).toBe(true);
    expect(solve.solution[0]).toBe(0); expect(solve.solution[1]).toBe(1);
    solve.bilateral[0] = 1;
    expect(solve.solve(2)).toBe(true);
    expect(solve.solution[0]).toBeCloseTo(-6 / 7, 12);
    expect(solve.solution[1]).toBeCloseTo(10 / 7, 12);
  });

  for (const n of [1, 2, 8, 32, 64]) for (const seed of [1, 2, 17]) {
    it(`satisfies a known complementary solution with ${n} rows (seed=${seed})`, () => {
      const solve = new ConstraintForceSolve(); solve.prepare(n);
      let state = seed;
      const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 - 0.5; };
      const factors = Array.from({ length: n }, () => Array.from({ length: n }, random));
      const expected = Array.from({ length: n }, (_, i) => i % 3 === 0 ? 0 : i % 3 === 1 ? 0.7 : -1.2);
      for (let i = 0; i < n; i++) {
        solve.bilateral[i] = i % 3 === 2 ? 1 : 0;
        for (let j = 0; j < n; j++) {
          let value = i === j ? 0.5 : 0;
          for (let k = 0; k < n; k++) value += factors[k][i] * factors[k][j];
          solve.matrix[i * n + j] = value;
        }
        solve.rhs[i] = expected[i] === 0 ? -0.25 : 0;
        for (let j = 0; j < n; j++) solve.rhs[i] += solve.matrix[i * n + j] * expected[j];
      }
      expect(solve.solve(n)).toBe(true);
      for (let i = 0; i < n; i++) expect(solve.solution[i]).toBeCloseTo(expected[i], 10);
    });
  }

  it("reuses storage when the active row count changes", () => {
    const solve = new ConstraintForceSolve(); solve.prepare(4); const matrix = solve.matrix, rhs = solve.rhs;
    solve.prepare(1); solve.matrix[0] = 2; solve.rhs[0] = 3;
    expect(solve.solve(1)).toBe(true); expect(solve.solution[0]).toBe(1.5);
    solve.prepare(2); solve.matrix.set([2, 0, 0, 4]); solve.rhs.set([4, 8]);
    expect(solve.solve(2)).toBe(true); expect([...solve.solution.slice(0, 2)]).toEqual([2, 2]);
    expect(solve.matrix).toBe(matrix); expect(solve.rhs).toBe(rhs);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 65])("rejects unsupported row count %s before allocating", count => {
    const solve = new ConstraintForceSolve(); expect(() => solve.prepare(count)).toThrow(RangeError);
    expect(solve.matrix.length).toBe(0); expect(solve.solve(count)).toBe(false);
  });

  it.each([NaN, Infinity, 0])("requests fallback for a nonfinite or singular system (%s)", value => {
    const solve = new ConstraintForceSolve(); solve.prepare(1); solve.matrix[0] = value; solve.rhs[0] = 1;
    expect(solve.solve(1)).toBe(false);
  });
});
