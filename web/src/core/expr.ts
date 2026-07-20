/** Safe mathematical expression compiler for user-defined force fields.
 *
 * Compiles the same restricted expression language the desktop app accepts
 * (arithmetic, comparisons, `a if cond else b` ternaries, and/or/not, and
 * whitelisted math functions) into a fast callable. The compiler is a real
 * tokenizer + recursive-descent parser producing an AST that is then folded
 * into a closure tree — user text is never passed to eval/new Function, so
 * it cannot execute arbitrary code and works under any Content-Security-Policy.
 *
 * The AST is exposed (`parseSource`) so the UI can re-render formulas in
 * other notations (the typeset math editor); the engine only ever calls
 * `compileExpr`.
 *
 * Allowed variables: x, y (position, m), vx, vy (velocity, m/s),
 * t (time, s), m (mass, kg), r (distance from origin, m).
 * `^` is accepted as the power operator (rewritten to `**`), so users can
 * write x^2 the way they would on paper.
 *
 * Semantics match Python/numpy where they differ from JS: `%` follows the
 * divisor's sign, `//` is floor division, comparisons yield 1.0/0.0,
 * `and`/`or` return an operand (short-circuit on truthiness of the value),
 * and `**` overflowing to infinity from finite operands is an error (so
 * 9**9**9 is rejected at compile time, like Python's OverflowError).
 */

export type Env = {
  x: number; y: number; vx: number; vy: number;
  t: number; m: number; r: number;
};
export type CompiledExpr = (env: Env) => number;

export class ExprError extends Error {}

type Fn = (env: Env) => number;

const VAR_GETTERS: Record<string, Fn> = {
  x: (e) => e.x, y: (e) => e.y, vx: (e) => e.vx, vy: (e) => e.vy,
  t: (e) => e.t, m: (e) => e.m, r: (e) => e.r,
};

export const VAR_NAMES: ReadonlySet<string> = new Set(Object.keys(VAR_GETTERS));

export const CONSTS: Record<string, number> = {
  pi: Math.PI, e: Math.E, tau: 2 * Math.PI, g: 9.81,
};

function reduceMin(...a: number[]): number {
  let out = a[0];
  for (let i = 1; i < a.length; i++) out = Math.min(out, a[i]);
  return out;
}
function reduceMax(...a: number[]): number {
  let out = a[0];
  for (let i = 1; i < a.length; i++) out = Math.max(out, a[i]);
  return out;
}

export const FUNCS: Record<string, { fn: (...a: number[]) => number; arity: number | "var" }> = {
  sin: { fn: Math.sin, arity: 1 }, cos: { fn: Math.cos, arity: 1 },
  tan: { fn: Math.tan, arity: 1 }, asin: { fn: Math.asin, arity: 1 },
  acos: { fn: Math.acos, arity: 1 }, atan: { fn: Math.atan, arity: 1 },
  atan2: { fn: Math.atan2, arity: 2 }, sqrt: { fn: Math.sqrt, arity: 1 },
  exp: { fn: Math.exp, arity: 1 }, log: { fn: Math.log, arity: 1 },
  abs: { fn: Math.abs, arity: 1 },
  min: { fn: reduceMin, arity: "var" }, max: { fn: reduceMax, arity: "var" },
  sign: { fn: Math.sign, arity: 1 }, floor: { fn: Math.floor, arity: 1 },
  ceil: { fn: Math.ceil, arity: 1 }, hypot: { fn: Math.hypot, arity: 2 },
};

/** Validate a call's argument count, throwing the same message everywhere
 * a call can be built (the text parser and the math-editor converter). */
export function checkArity(name: string, argCount: number): void {
  const spec = FUNCS[name];
  if (!spec) throw new ExprError("only math functions like sin, cos, sqrt may be called");
  if (spec.arity === "var") {
    if (argCount < 1) throw new ExprError(`${name}() needs at least one argument`);
  } else if (argCount !== spec.arity) {
    throw new ExprError(`${name}() takes ${spec.arity} argument${spec.arity === 1 ? "" : "s"}`);
  }
}

// Python float % and //: result follows the divisor's sign.
function pymod(a: number, b: number): number {
  return a - b * Math.floor(a / b);
}
// Python `**` raises OverflowError when finite operands overflow; mirroring
// that lets the compile-time probe reject 9**9**9 while a genuine division
// singularity (which yields Infinity, like numpy) is still tolerated.
function pypow(a: number, b: number): number {
  const r = a ** b;
  if (!Number.isFinite(r) && Number.isFinite(a) && Number.isFinite(b) && !Number.isNaN(r)) {
    throw new ExprError("numeric overflow in power");
  }
  return r;
}

// --------------------------------------------------------------------- AST
export type BinOp = "+" | "-" | "*" | "/" | "//" | "%" | "**";
export type CmpOp = "<" | "<=" | ">" | ">=" | "==" | "!=";

export type ExprNode =
  | { kind: "num"; value: number }
  | { kind: "var"; name: string }
  | { kind: "const"; name: string }
  | { kind: "call"; name: string; args: ExprNode[] }
  | { kind: "neg"; operand: ExprNode }
  | { kind: "not"; operand: ExprNode }
  | { kind: "binary"; op: BinOp; left: ExprNode; right: ExprNode }
  | { kind: "compare"; ops: CmpOp[]; operands: ExprNode[] }
  | { kind: "logic"; op: "and" | "or"; left: ExprNode; right: ExprNode }
  | { kind: "ternary"; body: ExprNode; cond: ExprNode; orelse: ExprNode };

// ---------------------------------------------------------------- tokenizer
type Token =
  | { kind: "num"; value: number }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string }
  | { kind: "end" };

const KEYWORDS = new Set(["if", "else", "and", "or", "not"]);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if ((c >= "0" && c <= "9") || (c === "." && i + 1 < n && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError(`bad number at position ${i}`);
      tokens.push({ kind: "num", value: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ kind: "name", value: m[0] });
      i += m[0].length;
      continue;
    }
    const three = src.slice(i, i + 2);
    if (three === "**" || three === "//" || three === "<=" || three === ">=" ||
        three === "==" || three === "!=") {
      tokens.push({ kind: "op", value: three });
      i += 2;
      continue;
    }
    if ("+-*/%(),<>".includes(c)) {
      tokens.push({ kind: "op", value: c });
      i++;
      continue;
    }
    throw new ExprError(`unexpected character '${c}'`);
  }
  tokens.push({ kind: "end" });
  return tokens;
}

// ------------------------------------------------------------------- parser
// Grammar (Python precedence):
//   ternary    := or_expr ('if' or_expr 'else' ternary)?
//   or_expr    := and_expr ('or' and_expr)*
//   and_expr   := not_expr ('and' not_expr)*
//   not_expr   := 'not' not_expr | comparison
//   comparison := arith (cmpop arith)*        (chained, Python style)
//   arith      := term (('+'|'-') term)*
//   term       := unary (('*'|'/'|'//'|'%') unary)*
//   unary      := ('+'|'-') unary | power
//   power      := atom ('**' unary)?          (right-assoc; -x**2 = -(x**2))
//   atom       := number | name | name '(' args ')' | '(' ternary ')'
class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token { return this.tokens[this.pos]; }
  private next(): Token { return this.tokens[this.pos++]; }

  private isOp(v: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.value === v;
  }
  private isKeyword(v: string): boolean {
    const t = this.peek();
    return t.kind === "name" && t.value === v;
  }
  private expectOp(v: string): void {
    if (!this.isOp(v)) throw new ExprError(`expected '${v}'`);
    this.next();
  }

  parse(): ExprNode {
    const node = this.ternary();
    if (this.peek().kind !== "end") throw new ExprError("unexpected trailing input");
    return node;
  }

  private ternary(): ExprNode {
    const body = this.orExpr();
    if (this.isKeyword("if")) {
      this.next();
      const cond = this.orExpr();
      if (!this.isKeyword("else")) throw new ExprError("'if' expression needs an 'else'");
      this.next();
      const orelse = this.ternary();
      return { kind: "ternary", body, cond, orelse };
    }
    return body;
  }

  private orExpr(): ExprNode {
    let left = this.andExpr();
    while (this.isKeyword("or")) {
      this.next();
      left = { kind: "logic", op: "or", left, right: this.andExpr() };
    }
    return left;
  }

  private andExpr(): ExprNode {
    let left = this.notExpr();
    while (this.isKeyword("and")) {
      this.next();
      left = { kind: "logic", op: "and", left, right: this.notExpr() };
    }
    return left;
  }

  private notExpr(): ExprNode {
    if (this.isKeyword("not")) {
      this.next();
      return { kind: "not", operand: this.notExpr() };
    }
    return this.comparison();
  }

  private comparison(): ExprNode {
    const first = this.arith();
    const ops: CmpOp[] = [];
    const operands: ExprNode[] = [first];
    while (this.peek().kind === "op" &&
           ["<", "<=", ">", ">=", "==", "!="].includes((this.peek() as { value: string }).value)) {
      ops.push((this.next() as { kind: "op"; value: string }).value as CmpOp);
      operands.push(this.arith());
    }
    if (ops.length === 0) return first;
    return { kind: "compare", ops, operands };
  }

  private arith(): ExprNode {
    let left = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.next() as { kind: "op"; value: string }).value as BinOp;
      left = { kind: "binary", op, left, right: this.term() };
    }
    return left;
  }

  private term(): ExprNode {
    let left = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("//") || this.isOp("%")) {
      const op = (this.next() as { kind: "op"; value: string }).value as BinOp;
      left = { kind: "binary", op, left, right: this.unary() };
    }
    return left;
  }

  private unary(): ExprNode {
    if (this.isOp("-")) {
      this.next();
      return { kind: "neg", operand: this.unary() };
    }
    if (this.isOp("+")) {
      this.next();
      return this.unary();
    }
    return this.power();
  }

  private power(): ExprNode {
    const base = this.atom();
    if (this.isOp("**")) {
      this.next();
      // right side may carry unary minus: 2**-3
      return { kind: "binary", op: "**", left: base, right: this.unary() };
    }
    return base;
  }

  private atom(): ExprNode {
    const t = this.peek();
    if (t.kind === "num") {
      this.next();
      return { kind: "num", value: t.value };
    }
    if (t.kind === "op" && t.value === "(") {
      this.next();
      const inner = this.ternary();
      this.expectOp(")");
      return inner;
    }
    if (t.kind === "name") {
      const name = t.value;
      if (KEYWORDS.has(name)) throw new ExprError(`unexpected '${name}'`);
      this.next();
      if (this.isOp("(")) {
        this.next();
        const args: ExprNode[] = [];
        if (!this.isOp(")")) {
          args.push(this.ternary());
          while (this.isOp(",")) {
            this.next();
            args.push(this.ternary());
          }
        }
        this.expectOp(")");
        checkArity(name, args.length);
        return { kind: "call", name, args };
      }
      if (name in VAR_GETTERS) return { kind: "var", name };
      if (name in CONSTS) return { kind: "const", name };
      throw new ExprError(`unknown name '${name}' (use x, y, vx, vy, t, m, r)`);
    }
    throw new ExprError("syntax error: expected a value");
  }
}

// ----------------------------------------------------------------- compiler
/** Fold an AST into a closure tree evaluating it against an environment. */
function compileNode(node: ExprNode): Fn {
  switch (node.kind) {
    case "num": {
      const v = node.value;
      return () => v;
    }
    case "var":
      return VAR_GETTERS[node.name];
    case "const": {
      const v = CONSTS[node.name];
      return () => v;
    }
    case "call": {
      const fn = FUNCS[node.name].fn;
      const args = node.args.map(compileNode);
      if (args.length === 1) {
        const a0 = args[0];
        return (e) => fn(a0(e));
      }
      if (args.length === 2) {
        const a0 = args[0];
        const a1 = args[1];
        return (e) => fn(a0(e), a1(e));
      }
      return (e) => fn(...args.map((a) => a(e)));
    }
    case "neg": {
      const operand = compileNode(node.operand);
      return (e) => -operand(e);
    }
    case "not": {
      const operand = compileNode(node.operand);
      return (e) => (operand(e) !== 0 ? 0.0 : 1.0);
    }
    case "binary": {
      const l = compileNode(node.left);
      const r = compileNode(node.right);
      switch (node.op) {
        case "+": return (e) => l(e) + r(e);
        case "-": return (e) => l(e) - r(e);
        case "*": return (e) => l(e) * r(e);
        case "/": return (e) => l(e) / r(e);
        case "//": return (e) => Math.floor(l(e) / r(e));
        case "%": return (e) => pymod(l(e), r(e));
        case "**": return (e) => pypow(l(e), r(e));
      }
      break;
    }
    case "compare": {
      const ops = node.ops;
      const operands = node.operands.map(compileNode);
      return (e) => {
        let prev = operands[0](e);
        for (let i = 0; i < ops.length; i++) {
          const cur = operands[i + 1](e);
          let ok: boolean;
          switch (ops[i]) {
            case "<": ok = prev < cur; break;
            case "<=": ok = prev <= cur; break;
            case ">": ok = prev > cur; break;
            case ">=": ok = prev >= cur; break;
            case "==": ok = prev === cur; break;
            default: ok = prev !== cur;
          }
          if (!ok) return 0.0;
          prev = cur;
        }
        return 1.0;
      };
    }
    case "logic": {
      const l = compileNode(node.left);
      const r = compileNode(node.right);
      if (node.op === "and") return (e) => { const a = l(e); return a !== 0 ? r(e) : a; };
      return (e) => { const a = l(e); return a !== 0 ? a : r(e); };
    }
    case "ternary": {
      const body = compileNode(node.body);
      const cond = compileNode(node.cond);
      const orelse = compileNode(node.orelse);
      return (e) => (cond(e) !== 0 ? body(e) : orelse(e));
    }
  }
  // unreachable: every kind returns above (the switch is exhaustive)
  throw new ExprError("internal: unhandled expression node");
}

/** Parse `source` into an AST without compiling or probing it.
 *
 * Names and arities are validated during the parse, so a returned tree
 * only contains known variables, constants and well-formed calls.
 * Throws ExprError with a human-readable message on invalid input.
 */
export function parseSource(source: string): ExprNode {
  source = source.trim();
  if (!source) throw new ExprError("empty expression");
  // mathy convenience: `^` means power (x^2 == x**2). Substituted in the
  // text before parsing so it gets **'s precedence.
  source = source.replaceAll("^", "**");
  try {
    return new Parser(tokenize(source)).parse();
  } catch (exc) {
    if (exc instanceof ExprError) throw exc;
    throw new ExprError(`syntax error: ${(exc as Error).message}`);
  }
}

/** Compile `source` into a function of an environment.
 *
 * Throws ExprError with a human-readable message on invalid input.
 */
export function compileExpr(source: string): CompiledExpr {
  const fn = compileNode(parseSource(source));

  // Probe once so obviously broken expressions fail at compile time.
  const probe: Env = { x: 0.1, y: 0.1, vx: 0.0, vy: 0.0, t: 0.0, m: 1.0, r: 0.14 };
  let val: number;
  try {
    val = fn(probe);
  } catch (exc) {
    if (exc instanceof ExprError) throw exc;
    throw new ExprError(String((exc as Error).message ?? exc));
  }
  if (Number.isNaN(val)) {
    // domain errors (sqrt of a negative, log of zero) surface as NaN
    throw new ExprError("expression is undefined (NaN) at the test point");
  }
  return fn;
}
