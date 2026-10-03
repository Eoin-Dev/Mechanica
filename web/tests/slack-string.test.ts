import { describe, expect, it } from "vitest";
import { addSlackString, MAX_SLACK_EXTENT_PX, slackStringDistance } from "../src/render/slack-string";

function curve(ax: number, ay: number, bx: number, by: number, extra: number,
               avoidX?: number, avoidY?: number) {
  const commands: number[][] = [];
  const path = { moveTo: (...v: number[]) => commands.push([0, ...v]),
    lineTo: (...v: number[]) => commands.push([1, ...v]),
    quadraticCurveTo: (...v: number[]) => commands.push([2, ...v]),
    bezierCurveTo: (...v: number[]) => commands.push([3, ...v]) } as unknown as Path2D;
  addSlackString(path, ax, ay, bx, by, extra, avoidX, avoidY);
  return commands;
}

describe("visual slack cue geometry", () => {
  it.each([0, -1, NaN, Infinity])("retains the straight endpoints without usable slack %s", extra => {
    expect(curve(10, 20, 80, 20, extra)).toEqual([[0, 10, 20], [1, 80, 20]]);
  });

  it("grows monotonically with extra length and stays within a fixed screen budget", () => {
    let previous = 0;
    for (const extra of [0.00001, 0.001, 0.01, 0.1, 1, 5, 10, 100, 1e9, 1e300]) {
      const c = curve(10, 20, 110, 20, extra);
      expect(c[0]).toEqual([0, 10, 20]); expect(c.at(-1)!.slice(-2)).toEqual([110, 20]);
      // Independent cubic midpoint evaluation from recorded controls.
      const y = (20 + 3 * c[1][2] + 3 * c[1][4] + 20) / 8, depth = y - 20;
      expect(depth).toBeGreaterThanOrEqual(previous); expect(depth).toBeGreaterThan(0);
      expect(depth).toBeLessThanOrEqual(MAX_SLACK_EXTENT_PX / 2); previous = depth;
      expect(c.flat().every(Number.isFinite)).toBe(true);
    }
  });

  it("keeps the outward cue clear of either side of a pulley", () => {
    for (const side of [-1, 1]) {
      const x = side * 22, c = curve(x, 100, x, 0, 30, 0, 0);
      const midpointX = (x + 3 * c[1][1] + 3 * c[1][3] + x) / 8;
      expect(midpointX * side).toBeGreaterThan(22);
      expect(c.at(-1)!.slice(-2)).toEqual([x, 0]);
    }
  });

  it("shows coincident ends as a finite loop with exact closing endpoints", () => {
    for (const extra of [0.001, 10, 1e300]) {
      const c = curve(30, 40, 30, 40, extra);
      expect(c).toHaveLength(3); expect(c.at(-1)!.slice(-2)).toEqual([30, 40]);
      expect(c.flat().every(Number.isFinite)).toBe(true);
      expect(c[1][1]).toBeGreaterThan(30); expect(c[2][1]).toBeLessThan(30);
      for (const command of c) {
        for (let k = 1; k < command.length; k++) expect(Math.abs(command[k] - (k % 2 ? 30 : 40)))
          .toBeLessThanOrEqual(MAX_SLACK_EXTENT_PX);
      }
    }
  });

  it("retains the same deterministic curve and translation over repeated reads", () => {
    const initial = curve(-13, 17, 91, -8, 0.04);
    for (let k = 0; k < 100; k++) expect(curve(-13, 17, 91, -8, 0.04)).toEqual(initial);
    const shifted = curve(-13 + 123, 17 - 44, 91 + 123, -8 - 44, 0.04);
    for (let i = 0; i < initial.length; i++) for (let k = 1; k < initial[i].length; k++) {
      expect(shifted[i][k]).toBeCloseTo(initial[i][k] + (k % 2 ? 123 : -44), 10);
    }
  });
});


describe("matching slack-string picking", () => {
  it.each([[0, 0, 200, 0, 100], [20, 100, 20, 0, 30], [30, 40, 30, 40, 10]])(
    "contains actual painted samples for endpoints %s,%s to %s,%s", (ax, ay, bx, by, extra) => {
      const c = curve(ax, ay, bx, by, extra); let x = ax, y = ay;
      for (const command of c.slice(1)) {
        const [, cx, cy] = command;
        const [endX, endY] = command.slice(-2);
        for (let k = 0; k <= 100; k++) {
          const t = k / 100, u = 1 - t;
          const sx = command[0] === 3 ? u ** 3 * x + 3 * u * u * t * cx + 3 * u * t * t * command[3] + t ** 3 * endX :
            u * u * x + 2 * u * t * cx + t * t * endX;
          const sy = command[0] === 3 ? u ** 3 * y + 3 * u * u * t * cy + 3 * u * t * t * command[4] + t ** 3 * endY :
            u * u * y + 2 * u * t * cy + t * t * endY;
          expect(slackStringDistance(sx, sy, ax, ay, bx, by, extra)).toBeLessThan(0.7);
        }
        x = endX; y = endY;
      }
      expect(slackStringDistance(1000, 1000, ax, ay, bx, by, extra)).toBeGreaterThan(100);
    });
});
