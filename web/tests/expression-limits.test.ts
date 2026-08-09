import { describe, expect, it } from "vitest";
import {
  EXPR_MAX_ARGUMENTS, EXPR_MAX_DEPTH, EXPR_MAX_NODES,
  EXPR_MAX_SOURCE_CHARS, EXPR_MAX_TOKENS, ExprError, ExprNode,
  assertExprBudget, compileExpr,
} from "../src/core/expr";
import { isMathRenderable, latexToAst, sourceToLatex } from "../src/core/mathfmt";
import { ForceField, World } from "../src/engine/world";

function balancedSum(leaves: number): string {
  let level = Array.from({ length: leaves }, () => "x");
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? `(${level[i]}+${level[i + 1]})` : level[i]);
    }
    level = next;
  }
  return level[0];
}

describe("force-field expression resource budgets", () => {
  it("accepts the source-character boundary and rejects one character more", () => {
    const exact = "x".padEnd(EXPR_MAX_SOURCE_CHARS, " ");
    expect(compileExpr(exact)({ x: 2, y: 0, vx: 0, vy: 0, t: 0, m: 1, r: 2 })).toBe(2);
    expect(() => compileExpr(`${exact} `)).toThrow(/too long/);
  });

  it("enforces the token budget before parsing the AST", () => {
    // 512 leaves + 511 operators + 1,022 balancing parentheses = 2,045
    // tokens. One wrapper remains under the limit; two cross it without
    // changing AST node count or depth.
    const base = balancedSum(512);
    const allowed = `(${base})`;
    const rejected = `((${base}))`;
    expect(EXPR_MAX_TOKENS).toBe(2_048);
    expect(() => compileExpr(allowed)).not.toThrow();
    expect(() => compileExpr(rejected)).toThrow(/too many tokens/);
  });

  it("enforces node, depth and function-argument budgets on any AST", () => {
    const num = (): ExprNode => ({ kind: "num", value: 1 });
    const compare = (count: number): ExprNode => ({
      kind: "compare",
      ops: Array.from({ length: count - 1 }, () => "<" as const),
      operands: Array.from({ length: count }, num),
    });
    expect(() => assertExprBudget(compare(EXPR_MAX_NODES - 1))).not.toThrow();
    expect(() => assertExprBudget(compare(EXPR_MAX_NODES))).toThrow(/too many terms/);

    let atDepth: ExprNode = num();
    for (let i = 1; i < EXPR_MAX_DEPTH; i++) atDepth = { kind: "neg", operand: atDepth };
    expect(() => assertExprBudget(atDepth)).not.toThrow();
    const tooDeep: ExprNode = { kind: "neg", operand: atDepth };
    expect(() => assertExprBudget(tooDeep)).toThrow(/nested too deeply/);

    const args = Array.from({ length: EXPR_MAX_ARGUMENTS + 1 }, num);
    expect(() => assertExprBudget({ kind: "call", name: "min", args })).toThrow(/arguments/);
    expect(() => compileExpr(`min(${Array(EXPR_MAX_ARGUMENTS + 1).fill("1").join(",")})`))
      .toThrow(/arguments/);
  });

  it("keeps field compilation atomic and scene loading total", () => {
    const field = new ForceField("atomic", "x", "y");
    field.fxSrc = "x + 1";
    field.fySrc = "(";
    expect(field.compile()).toBe(false);
    expect(field.fx).toBeNull();
    expect(field.fy).toBeNull();
    expect(field.error).not.toBe("");

    const pathological = Array(20_000).fill("x").join("+");
    let world: World | null = null;
    expect(() => {
      world = World.fromDict({ fields: [{ name: "large", fx: pathological, fy: "0", enabled: true }] });
    }).not.toThrow();
    expect(world!.fields[0].fx).toBeNull();
    expect(world!.fields[0].fy).toBeNull();
    expect(world!.fields[0].error).toMatch(/too long/);
  });

  it("applies the same safe boundary to math rendering", () => {
    const tooLong = "x".repeat(EXPR_MAX_SOURCE_CHARS + 1);
    expect(isMathRenderable(tooLong)).toBe(false);
    expect(() => sourceToLatex(tooLong)).toThrow(ExprError);
    expect(() => latexToAst(tooLong)).toThrow(ExprError);
  });
});
