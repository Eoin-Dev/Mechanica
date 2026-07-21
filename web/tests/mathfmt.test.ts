/** Conversion suite for the typeset formula editor bridge (mathfmt.ts).
 *
 * The math editor is only safe if source → LaTeX → source round trips
 * preserve a formula's value exactly and converge after one pass (so a
 * formula never keeps rewriting itself), and if the LaTeX MathLive emits
 * for keyboard input maps back to the source the user meant.
 */
import { describe, expect, it } from "vitest";
import { Env, ExprError, compileExpr, parseSource } from "../src/core/expr";
import { astToSource, isMathRenderable, latexToAst, latexToSource,
         sourceToLatex } from "../src/core/mathfmt";
import { PRESETS } from "../src/scene/presets";
import { RECIPES } from "../src/ui/guide-recipes";

/** Environments the equivalence checks sample — off-axis, signed, mixed
 * magnitudes, so precedence mistakes can't hide behind symmetry. */
const PROBES: Env[] = [
  { x: 0.7, y: -1.3, vx: 2.1, vy: -0.4, t: 0.9, m: 2.5, r: 1.6 },
  { x: -3.2, y: 0.11, vx: -0.7, vy: 5.0, t: 4.2, m: 0.3, r: 3.9 },
  { x: 1.0, y: 1.0, vx: 1.0, vy: 1.0, t: 1.0, m: 1.0, r: 1.4142 },
  { x: 12.0, y: -7.5, vx: 0.0, vy: -9.81, t: 0.016, m: 100.0, r: 14.15 },
];

/** Assert two sources are bit-identical on every probe. */
function expectSameValue(a: string, b: string): void {
  const fa = compileExpr(a);
  const fb = compileExpr(b);
  for (const env of PROBES) {
    expect(fb(env), `'${a}' vs '${b}' at ${JSON.stringify(env)}`).toBe(fa(env));
  }
}

// ------------------------------------------------------------- round trips
describe("source -> latex -> source round trips", () => {
  const SOURCES = [
    "0",
    "-x*10",
    "-0.5*vx",
    "x^2",
    "-x^2",
    "(-x)^2",
    "2^-3",
    "x^(y+1)",
    "(x^2)^3",
    "x^2^3",
    "1/2",
    "-x/2",
    "(x+1)/(y-2)",
    "1/(1+x^2)",
    "x/y/t",
    "x/(y/t)",
    "x-(y+t)",
    "x-(y-t)",
    "x-y-t",
    "x+-y",
    "2*x",
    "0.5*vx*vy",
    "x*(y+1)",
    "2*(x+1)",
    "-(x*y)",
    "2*3",
    "2*10^6",
    "x*2",
    "sin(x)",
    "sin(x)^2",
    "cos(2*pi*t)",
    "atan2(y, x)",
    "hypot(x, y)",
    "min(x, y, t)",
    "max(1, r)",
    "sqrt(x^2+y^2)",
    "sqrt(2)*x",
    "abs(x)",
    "abs(x-y)",
    "sign(vx)*5",
    "floor(t)",
    "ceil(r)",
    "log(r+1)",
    "exp(-t)",
    "asin(x/10)",
    "acos(x/10)",
    "atan(y)",
    "tan(t)",
    "e^-t",
    "g*m",
    "tau*r",
    "pi*e",
    "x*e",
    "1e6*x", // String(1e6) is "1000000", so this stays renderable
    "-9.81*m",
    "x*y",
    "e*e",
    "-0.5*vx*abs(vx)",
    "m*g*sin(t)",
    "-x*10/(r+0.1)",
    "3*sin(2*t)+0.5*cos(x)",
  ];

  it.each(SOURCES)("'%s' survives the round trip", (src) => {
    const latex = sourceToLatex(src);
    const back = latexToSource(latex);
    expectSameValue(src, back);
    // idempotence: a second pass must be a fixed point, or the editor
    // would visibly rewrite the formula on every open/blur
    const latex2 = sourceToLatex(back);
    expect(latexToSource(latex2)).toBe(back);
    expect(latex2).toBe(latex);
  });

  it("keeps float grouping exactly (no re-association)", () => {
    // 0.1+0.2+0.3 groups differently left vs right; conversion must not move it
    expectSameValue("x+(y+t)", latexToSource(sourceToLatex("x+(y+t)")));
    expectSameValue("(x+y)+t", latexToSource(sourceToLatex("(x+y)+t")));
    const right = latexToSource(sourceToLatex("x+(y+t)"));
    expect(parseSource(right)).toEqual(parseSource("x+(y+t)"));
  });

  it("refuses e-notation literals rather than risk rounding them", () => {
    // 1.5e-7 would have to typeset as 1.5*10^-7, and that product is not
    // guaranteed to be the same double — so such formulas stay text-only
    expect(isMathRenderable("1.5e-7")).toBe(false);
    expect(isMathRenderable("2.5e21*m")).toBe(false);
    expect(() => sourceToLatex("1.5e-7")).toThrowError(ExprError);
  });
});

// -------------------------------------------- what MathLive actually emits
describe("latex from the math editor maps to the right source", () => {
  const CASES: Array<[string, string]> = [
    // typed with the keyboard: fractions, powers, functions
    ["\\frac{-x}{2}", "-x/2"],
    ["\\frac12", "1/2"],
    ["\\frac\\pi2", "pi/2"],
    ["x^2", "x^2"],
    ["x^{2}", "x^2"],
    ["x^{22}", "x^22"],
    ["x^22", "x^2*2"], // TeX: a braceless superscript is one token
    ["x^-2", "x^-2"],
    ["2x", "2*x"],
    ["2xy", "2*x*y"],
    ["0.5v_x", "0.5*vx"],
    ["v_{y}", "vy"],
    ["xv_x", "x*vx"],
    ["\\sin\\left(t\\right)", "sin(t)"],
    ["\\sin(t)", "sin(t)"],
    ["3\\sin\\left(2t\\right)", "3*sin(2*t)"],
    ["\\arcsin\\left(x\\right)", "asin(x)"],
    ["\\ln\\left(r\\right)", "log(r)"],
    ["\\log\\left(r\\right)", "log(r)"],
    ["\\exp\\left(-t\\right)", "exp(-t)"],
    ["\\operatorname{atan2}\\left(y,x\\right)", "atan2(y, x)"],
    ["\\operatorname{hypot}\\left(x,y\\right)", "hypot(x, y)"],
    ["\\operatorname{floor}\\left(t\\right)", "floor(t)"],
    ["\\min\\left(x,y,t\\right)", "min(x, y, t)"],
    ["\\sqrt{x^2+y^2}", "sqrt(x^2+y^2)"],
    ["\\sqrt2", "sqrt(2)"],
    ["\\left|x-y\\right|", "abs(x-y)"],
    ["|x|", "abs(x)"],
    ["\\pi", "pi"],
    ["\\tau r", "tau*r"],
    ["2\\pi", "2*pi"],
    ["\\exponentialE^{-t}", "e^-t"],
    ["x\\cdot y", "x*y"],
    ["x\\times y", "x*y"],
    ["x/y", "x/y"],
    ["x\\div y", "x/y"],
    ["-x-1", "-x-1"],
    ["-\\frac{1}{2}v_x", "-1/2*vx"],
    ["\\left(x+1\\right)^{2}", "(x+1)^2"],
    ["10^{-7}", "10^-7"],
    ["1.5\\cdot10^{-7}", "1.5*10^-7"],
    // pasted plain text becomes italic letter runs
    ["vx", "vx"],
    ["vxy", "vx*y"],
    ["pi", "pi"],
    ["exp\\left(t\\right)", "exp(t)"],
    // stray spacing commands are ignored
    ["x\\, y", "x*y"],
    ["\\mathrm{vx}", "vx"],
  ];

  it.each(CASES)("%s -> %s", (latex, src) => {
    expect(latexToSource(latex)).toBe(src);
  });

  it("letter runs bind subscripts to the last letter", () => {
    expect(latexToSource("xv_x")).toBe("x*vx");
    expect(latexToSource("v_xv_y")).toBe("vx*vy");
  });
});

// ------------------------------------------------------------- error paths
describe("latex the editor cannot mean anything by", () => {
  const BAD: Array<[string, RegExp]> = [
    ["", /empty/],
    ["\\frac{x}{\\placeholder{}}", /empty box/],
    ["\\placeholder{}", /empty box/],
    ["x+", /ends too soon/],
    ["\\frac{x}{}", /empty box/],
    ["\\int x", /isn't supported/],
    ["x!", /factorial/i],
    ["x<2", /text editor/],
    ["x\\le2", /text editor/],
    ["\\sqrt[3]{x}", /nth roots/],
    ["q", /unknown name 'q'/],
    ["\\operatorname{foo}\\left(x\\right)", /only math functions/],
    ["\\sin^2\\left(x\\right)", /sin\(\.\.\.\)\^2/],
    ["\\sin x", /parentheses/],
    ["\\operatorname{atan2}\\left(x\\right)", /takes 2 arguments/],
    ["z_2", /subscripts/],
  ];

  it.each(BAD)("%s is rejected clearly", (latex, msg) => {
    expect(() => latexToSource(latex)).toThrowError(ExprError);
    expect(() => latexToSource(latex)).toThrowError(msg);
  });

  it("conversion output always compiles", () => {
    // the invariant the inspector relies on: successful conversion never
    // produces source that then fails to parse
    const latexes = ["\\frac{v_x}{m}", "\\sqrt{\\left|x\\right|}",
                     "\\operatorname{sign}\\left(v_y\\right)g"];
    for (const l of latexes) {
      expect(() => compileExpr(latexToSource(l))).not.toThrow();
    }
  });
});

// -------------------------------------------------------- renderable gate
describe("isMathRenderable", () => {
  it.each([
    "0", "-x*10", "sin(x)^2", "1/(1+x^2)", "min(x, y)", "2*10^6",
  ])("math subset: '%s'", (src) => {
    expect(isMathRenderable(src)).toBe(true);
  });

  it.each([
    "x if y > 0 else -x",   // ternary
    "x and y",              // logic
    "not x",                // not
    "x // 2",               // floor division
    "x % 2",                // modulo
    "x < y",                // comparison
    "x +",                  // broken source
    "wat(x)",               // unknown function
    "",                     // empty
  ])("text-only: '%s'", (src) => {
    expect(isMathRenderable(src)).toBe(false);
  });
});

// --------------------------------------------- shipped formulas stay valid
describe("shipped content", () => {
  it("the Cyclone preset's formulas are typeset-renderable and round-trip", () => {
    const preset = PRESETS.find((p) => p.name === "Cyclone")!;
    const world = preset.build();
    expect(world.fields.length).toBe(1);
    const f = world.fields[0];
    expect(f.error).toBe("");
    for (const src of [f.fxSrc, f.fySrc]) {
      expect(isMathRenderable(src), src).toBe(true);
      expectSameValue(src, latexToSource(sourceToLatex(src)));
    }
  });

  it("every guide recipe compiles, and typeset ones round-trip exactly", () => {
    for (const r of RECIPES) {
      for (const src of [r.fx, r.fy]) {
        expect(() => compileExpr(src), `${r.name}: ${src}`).not.toThrow();
        if (isMathRenderable(src)) {
          expectSameValue(src, latexToSource(sourceToLatex(src)));
        }
      }
    }
    // the two advertised text-only recipes really are text-only
    expect(isMathRenderable("-0.4*m*(y > 2)")).toBe(false);
    expect(isMathRenderable("4 if floor(t) % 2 == 0 else -4")).toBe(false);
  });
});

// --------------------------------------------------------- ast level checks
describe("astToSource shapes", () => {
  it("emits minimal parentheses that still re-parse identically", () => {
    for (const src of ["-(x+y)*t", "x-(y-t)", "(x/y)^2", "-(x^2)", "2^-3"]) {
      const printed = astToSource(parseSource(src));
      expect(parseSource(printed)).toEqual(parseSource(src));
    }
  });

  it("prints the full language, not just the math subset", () => {
    const src = "x if t < 5 and not m else -x % 2";
    const printed = astToSource(parseSource(src));
    expect(parseSource(printed)).toEqual(parseSource(src));
  });

  it("latexToAst validates arity like the source parser", () => {
    expect(() => latexToAst("\\min\\left(\\right)")).toThrowError(ExprError);
  });
});
