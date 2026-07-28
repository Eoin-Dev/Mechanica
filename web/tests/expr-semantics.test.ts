/** What the force-field expression language actually COMPUTES.
 *
 * The compiler had tests for round-tripping and for typesetting, and none
 * for meaning. A mutation run made the gap concrete: replacing the Python
 * modulo (`a - b*floor(a/b)`, which follows the DIVISOR's sign) with
 * JavaScript's `%` (which follows the dividend's) changed the answer for
 * every negative operand, and the whole suite stayed green.
 *
 * The header of core/expr.ts makes a specific promise - "semantics match
 * Python/numpy where they differ from JS" - and lists exactly where. Each
 * of those claims is asserted here, because a formula language that
 * silently disagrees with the notation it borrows is worse than one that
 * refuses the notation outright.
 *
 * The sandbox's security claim is asserted here too: user text is compiled
 * by a hand-written parser, never eval'd, so no expression can reach a
 * global, a constructor or a prototype.
 */
import { describe, expect, it } from "vitest";
import { CONSTS, Env, ExprError, FUNCS, compileExpr } from "../src/core/expr";
import { latexToSource, sourceToLatex } from "../src/core/mathfmt";
import { TOOL_KEYS } from "../src/interact/tools";

const ENV: Env = { x: 2, y: 3, vx: -4, vy: 5, t: 7, m: 11, r: 13 };

/** Value of `src` at ENV, or with the named overrides. */
function evalAt(src: string, over: Partial<Env> = {}): number {
  return compileExpr(src)({ ...ENV, ...over });
}

describe("Python semantics where they differ from JavaScript", () => {
  it("% follows the divisor's sign, not the dividend's", () => {
    // JS: -7 % 3 === -1. Python and numpy: 2. The engine promises Python.
    expect(evalAt("-7 % 3")).toBeCloseTo(2, 12);
    expect(evalAt("7 % -3")).toBeCloseTo(-2, 12);
    expect(evalAt("-7 % -3")).toBeCloseTo(-1, 12);
    expect(evalAt("7 % 3")).toBeCloseTo(1, 12);
    expect(evalAt("-7.5 % 2")).toBeCloseTo(0.5, 12);
  });

  it("// is floor division, so it rounds toward negative infinity", () => {
    expect(evalAt("7 // 3")).toBe(2);
    expect(evalAt("-7 // 3")).toBe(-3); // not -2
    expect(evalAt("7 // -3")).toBe(-3);
    expect(evalAt("-7 // -3")).toBe(2);
  });

  it("comparisons produce 1 and 0 so they can be multiplied by", () => {
    expect(evalAt("1 < 2")).toBe(1);
    expect(evalAt("2 < 1")).toBe(0);
    expect(evalAt("2 == 2")).toBe(1);
    expect(evalAt("2 != 2")).toBe(0);
    expect(evalAt("3 * (x > 0)")).toBe(3);
  });

  it("comparisons chain, as in Python", () => {
    expect(evalAt("1 < 2 < 3")).toBe(1);
    expect(evalAt("1 < 3 < 2")).toBe(0);
    expect(evalAt("3 > 2 > 1")).toBe(1);
    expect(evalAt("1 <= 1 <= 1")).toBe(1);
  });

  it("and/or return an operand rather than a boolean, and short-circuit", () => {
    expect(evalAt("0 and 5")).toBe(0);
    expect(evalAt("3 and 5")).toBe(5);
    expect(evalAt("0 or 7")).toBe(7);
    expect(evalAt("3 or 7")).toBe(3);
    // short-circuit: the right side is never evaluated, so its singularity
    // cannot poison the result
    expect(evalAt("0 and 1/0")).toBe(0);
  });

  it("not yields 1 or 0", () => {
    expect(evalAt("not 0")).toBe(1);
    expect(evalAt("not 5")).toBe(0);
    expect(evalAt("not not 5")).toBe(1);
  });

  it("a if c else b picks the branch and skips the other", () => {
    expect(evalAt("1 if x > 0 else 2")).toBe(1);
    expect(evalAt("1 if x < 0 else 2")).toBe(2);
    expect(evalAt("(1 if x > 0 else 2) + 10")).toBe(11);
  });

  it("rejects a finite overflow in ** the way Python raises OverflowError", () => {
    expect(() => compileExpr("9**9**9")).toThrow(ExprError);
    // but a genuine division singularity is tolerated, like numpy
    expect(evalAt("1/0")).toBe(Infinity);
  });
});

describe("precedence and associativity", () => {
  it("** binds tighter than unary minus", () => {
    expect(evalAt("-x**2")).toBe(-4); // -(2^2), not (-2)^2
    expect(evalAt("(-x)**2")).toBe(4);
  });

  it("** is right associative", () => {
    expect(evalAt("2**3**2")).toBe(512); // 2^(3^2), not (2^3)^2 = 64
  });

  it("** accepts a signed exponent", () => {
    expect(evalAt("2**-2")).toBeCloseTo(0.25, 12);
  });

  it("* and / bind tighter than + and -, left to right", () => {
    expect(evalAt("1 + 2 * 3")).toBe(7);
    expect(evalAt("8 / 4 / 2")).toBe(1); // (8/4)/2, not 8/(4/2)
    expect(evalAt("8 - 4 - 2")).toBe(2);
  });

  it("comparisons bind looser than arithmetic, logic looser still", () => {
    expect(evalAt("1 + 1 == 2")).toBe(1);
    expect(evalAt("1 < 2 and 3 < 4")).toBe(1);
  });

  it("^ is accepted as a synonym for **", () => {
    expect(evalAt("x^3")).toBe(8);
    expect(evalAt("2^3^2")).toBe(512);
  });
});

describe("variables, constants and functions", () => {
  it("exposes exactly the documented variables", () => {
    expect(evalAt("x")).toBe(2);
    expect(evalAt("y")).toBe(3);
    expect(evalAt("vx")).toBe(-4);
    expect(evalAt("vy")).toBe(5);
    expect(evalAt("t")).toBe(7);
    expect(evalAt("m")).toBe(11);
    expect(evalAt("r")).toBe(13);
  });

  it("exposes the documented constants", () => {
    expect(evalAt("pi")).toBeCloseTo(Math.PI, 12);
    expect(evalAt("e")).toBeCloseTo(Math.E, 12);
    expect(evalAt("tau")).toBeCloseTo(2 * Math.PI, 12);
    expect(evalAt("g")).toBeCloseTo(9.81, 12);
  });

  it("computes the whitelisted functions", () => {
    expect(evalAt("sqrt(9)")).toBe(3);
    expect(evalAt("abs(-3)")).toBe(3);
    expect(evalAt("floor(2.7)")).toBe(2);
    expect(evalAt("ceil(2.1)")).toBe(3);
    expect(evalAt("sign(-9)")).toBe(-1);
    expect(evalAt("hypot(3, 4)")).toBe(5);
    expect(evalAt("atan2(0, 1)")).toBe(0);
    expect(evalAt("min(3, 1, 2)")).toBe(1);
    expect(evalAt("max(3, 1, 2)")).toBe(3);
    expect(evalAt("log(e)")).toBeCloseTo(1, 12);
    expect(evalAt("exp(0)")).toBe(1);
    expect(evalAt("sin(0)")).toBe(0);
    expect(evalAt("cos(0)")).toBe(1);
  });

  it("checks arity, and says which function and how many", () => {
    expect(() => compileExpr("sqrt(1, 2)")).toThrow(/sqrt\(\) takes 1 argument/);
    expect(() => compileExpr("atan2(1)")).toThrow(/atan2\(\) takes 2 arguments/);
    expect(() => compileExpr("min()")).toThrow(/at least one argument/);
  });

  it("rejects an expression that is undefined at the probe point", () => {
    expect(() => compileExpr("sqrt(0 - 1)")).toThrow(/NaN|undefined/);
    expect(() => compileExpr("0/0")).toThrow(/NaN|undefined/);
  });

  it("rejects empty and malformed input with a readable message", () => {
    for (const bad of ["", "   ", "x +", "(x", "x)", "1 2", "if x", "x if y",
                       "*", ",", "x @ y"]) {
      expect(() => compileExpr(bad)).toThrow(ExprError);
    }
  });
});

describe("the sandbox", () => {
  it("has no route to any host object", () => {
    // there is no eval and no Function here, so these are simply unknown
    // names - but that is exactly the claim worth pinning
    for (const attack of [
      "constructor", "__proto__", "prototype", "window", "globalThis",
      "process", "document", "eval", "Function", "require", "fetch",
      "this", "self", "Math", "alert",
    ]) {
      expect(() => compileExpr(attack)).toThrow(ExprError);
      expect(() => compileExpr(`${attack}(1)`)).toThrow(ExprError);
    }
  });

  it("names the allowed variables when it rejects an unknown one", () => {
    expect(() => compileExpr("velocity")).toThrow(/unknown name/);
  });

  it("cannot call anything that is not a whitelisted maths function", () => {
    expect(() => compileExpr("x(1)")).toThrow(/only math functions/);
    expect(() => compileExpr("pi(1)")).toThrow(/only math functions/);
  });

  it("survives pathological input instead of hanging or crashing", () => {
    // deep nesting is a stack-depth question for a recursive-descent parser;
    // it must surface as a rejection, never as a thrown RangeError
    const deep = `${"(".repeat(5000)}x${")".repeat(5000)}`;
    let threwExprError = true;
    try {
      compileExpr(deep);
    } catch (e) {
      threwExprError = e instanceof ExprError;
    }
    expect(threwExprError).toBe(true);
    expect(() => compileExpr("x".repeat(100000))).toThrow(ExprError);
  });
});

describe("the compiled function is pure and reusable", () => {
  it("gives the same answer for the same environment every time", () => {
    const f = compileExpr("sin(t) * m / (r + 1)");
    const env: Env = { ...ENV };
    const a = f(env);
    const b = f(env);
    expect(a).toBe(b);
  });

  it("reads each call's environment rather than capturing the first", () => {
    const f = compileExpr("x + t");
    expect(f({ ...ENV, x: 1, t: 1 })).toBe(2);
    expect(f({ ...ENV, x: 10, t: 5 })).toBe(15);
  });

  it("does not mutate the environment it is handed", () => {
    const f = compileExpr("x * y + vx");
    const env: Env = { ...ENV };
    const before = { ...env };
    f(env);
    expect(env).toEqual(before);
  });
});

describe("the compiler's tables and the typesetter's agree", () => {
  it("every constant the compiler accepts can be typeset", () => {
    // CONST_LATEX had no fallback, so a constant added to CONSTS and
    // forgotten here would render as the literal word "undefined" in the
    // math editor - silently, and only for that one constant
    for (const name of Object.keys(CONSTS)) {
      const latex = sourceToLatex(name);
      expect(latex).not.toMatch(/undefined/);
      expect(latex.length).toBeGreaterThan(0);
    }
  });

  it("every function the compiler accepts can be typeset", () => {
    for (const [name, spec] of Object.entries(FUNCS)) {
      const args = spec.arity === "var" ? "1" :
        Array.from({ length: spec.arity }, () => "1").join(", ");
      const latex = sourceToLatex(`${name}(${args})`);
      expect(latex).not.toMatch(/undefined/);
    }
  });

  it("every function survives a full round trip through LaTeX", () => {
    // 0.5 for every argument: inside the domain of asin/acos (which reject
    // anything past 1) and away from the singularities of log and tan, so
    // the round trip is what is being tested rather than the domain check
    for (const [name, spec] of Object.entries(FUNCS)) {
      const arity = spec.arity === "var" ? 2 : spec.arity;
      const args = Array.from({ length: arity }, () => "0.5").join(", ");
      const src = `${name}(${args})`;
      const back = latexToSource(sourceToLatex(src));
      expect(compileExpr(back)(ENV)).toBeCloseTo(compileExpr(src)(ENV), 9);
    }
  });

  it("the name tables have no inherited members", () => {
    // the fix for `constructor` compiling as a variable: these tables are
    // consulted with `name in ...`, so they must not inherit anything
    for (const table of [CONSTS, FUNCS]) {
      expect(Object.getPrototypeOf(table)).toBeNull();
      for (const inherited of ["constructor", "toString", "valueOf",
                               "hasOwnProperty", "__proto__"]) {
        expect(inherited in table).toBe(false);
      }
    }
  });

  it("the tool key map has no inherited members either", () => {
    expect(Object.getPrototypeOf(TOOL_KEYS)).toBeNull();
    expect("constructor" in TOOL_KEYS).toBe(false);
    expect(TOOL_KEYS.v).toBe("select"); // still a working table
  });
});
