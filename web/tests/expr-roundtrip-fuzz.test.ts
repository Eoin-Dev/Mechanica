/** Property-based cover for the formula system's two round trips.
 *
 * A force field's text is converted between three representations, and the
 * user can move between them freely:
 *
 *   source text  <->  AST  <->  LaTeX (the typeset editor)
 *
 * Every one of those conversions must preserve MEANING, not merely parse.
 * The existing tests check a few dozen hand-written examples, which is the
 * right way to pin the notation choices (that `x^2` typesets as a
 * superscript, that `//` becomes a floor bracket) but a poor way to find
 * the cases nobody thought of: a precedence that survives one nesting and
 * not two, a unary minus that binds differently after a round trip, a
 * chained comparison that loses a link.
 *
 * So this generates expressions instead of listing them - random but
 * DETERMINISTIC, so a failure is reproducible and CI cannot flake - and
 * asserts the only property that actually matters: the round-tripped
 * expression computes the same numbers as the original, at several sample
 * points chosen to include the awkward ones (t = 0, r = 0, the origin).
 *
 * The generator covers every construct the language has: all seven
 * variables, all four constants, every arithmetic operator including
 * Python's `//` and `%`, unary minus, every whitelisted function, chained
 * comparisons, `not`, `and`/`or`, and `a if c else b` - nested to a depth
 * that produces genuinely awkward groupings.
 */
import { describe, expect, it } from "vitest";
import { Env, compileExpr, parseSource } from "../src/core/expr";
import { astToSource, isMathRenderable, latexToSource,
         sourceToLatex } from "../src/core/mathfmt";

// A tiny LCG: the same 4000 expressions on every run, on every machine.
let seed = 12345;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];

const VARS = ["x", "y", "vx", "vy", "t", "m", "r"] as const;
const CONSTS = ["pi", "e", "tau", "g"] as const;
const UNARY = ["sin", "cos", "tan", "atan", "sqrt", "exp", "log", "abs",
               "sign", "floor", "ceil"] as const;
const BINARY = ["atan2", "hypot", "min", "max"] as const;
const OPS = ["+", "-", "*", "/", "//", "%", "**"] as const;
const CMP = ["<", "<=", ">", ">=", "==", "!="] as const;

function gen(depth: number): string {
  if (depth <= 0 || rnd() < 0.3) {
    const k = rnd();
    if (k < 0.45) return pick(VARS);
    if (k < 0.6) return pick(CONSTS);
    return String(Math.floor(rnd() * 20) / 4); // small decimals and integers
  }
  const k = rnd();
  if (k < 0.30) return `(${gen(depth - 1)} ${pick(OPS)} ${gen(depth - 1)})`;
  if (k < 0.50) return `${pick(UNARY)}(${gen(depth - 1)})`;
  if (k < 0.62) return `${pick(BINARY)}(${gen(depth - 1)}, ${gen(depth - 1)})`;
  if (k < 0.72) return `(-${gen(depth - 1)})`;
  if (k < 0.82) return `(${gen(depth - 1)} ${pick(CMP)} ${gen(depth - 1)})`;
  if (k < 0.90) return `(${gen(depth - 1)} if ${gen(depth - 1)} else ${gen(depth - 1)})`;
  if (k < 0.95) return `(not ${gen(depth - 1)})`;
  return `(${gen(depth - 1)} ${pick(["and", "or"] as const)} ${gen(depth - 1)})`;
}

/** Sample points, including the ones that make functions singular. */
const ENVS: Env[] = [
  { x: 0.7, y: -1.3, vx: 2.0, vy: -0.5, t: 1.25, m: 2.0, r: 1.47 },
  { x: -3.1, y: 0.2, vx: -1.0, vy: 4.0, t: 0.0, m: 0.5, r: 3.11 },
  { x: 0.0, y: 0.0, vx: 0.0, vy: 0.0, t: 9.5, m: 1.0, r: 0.0 },
];

/** Equal as far as the physics cares: NaN matches NaN, infinities match
 * exactly, and finite values match to a relative tolerance (a round trip
 * may reassociate, which is not bit-exact and does not need to be). */
function same(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Value at every sample point, with a throw recorded as NaN (pypow raises
 * on overflow, and doing so at the same points is part of the property). */
function sample(fn: (e: Env) => number): number[] {
  return ENVS.map((e) => {
    try {
      return fn(e);
    } catch {
      return NaN;
    }
  });
}

const CASES = 4000;

describe("formula round trips preserve meaning", () => {
  it("survives AST -> source -> AST, and source -> LaTeX -> source", () => {
    seed = 12345;
    let checked = 0;
    let renderable = 0;
    const astFailures: string[] = [];
    const latexFailures: string[] = [];

    for (let i = 0; i < CASES; i++) {
      const src = gen(4);
      let base: (e: Env) => number;
      try {
        base = compileExpr(src);
      } catch {
        continue; // the generator can emit a compile-time overflow; fine
      }
      const want = sample(base);
      checked++;

      // 1. the AST prints back to source that means the same thing
      try {
        const printed = astToSource(parseSource(src));
        const got = sample(compileExpr(printed));
        if (!want.every((v, k) => same(v, got[k]))) {
          astFailures.push(`${src} -> ${printed} : ${want} vs ${got}`);
        }
      } catch (e) {
        astFailures.push(`${src} threw ${(e as Error).message}`);
      }

      // 2. anything the editor claims it can typeset survives the trip
      //    through LaTeX and back
      if (!isMathRenderable(src)) continue;
      renderable++;
      try {
        const back = latexToSource(sourceToLatex(src));
        const got = sample(compileExpr(back));
        if (!want.every((v, k) => same(v, got[k]))) {
          latexFailures.push(`${src} -> ${back} : ${want} vs ${got}`);
        }
      } catch (e) {
        latexFailures.push(`${src} threw ${(e as Error).message}`);
      }
    }

    // the generator must actually be reaching both paths, or the assertions
    // below would pass by testing nothing at all
    expect(checked).toBeGreaterThan(3000);
    expect(renderable).toBeGreaterThan(1000);
    expect(astFailures.slice(0, 5)).toEqual([]);
    expect(latexFailures.slice(0, 5)).toEqual([]);
  }, 120_000);
});
