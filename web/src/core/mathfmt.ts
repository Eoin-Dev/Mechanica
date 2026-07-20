/** Converts force-field formulas between source text and LaTeX.
 *
 * The typeset math editor (MathLive) speaks LaTeX; the engine speaks the
 * expression language in expr.ts. Source text stays the single source of
 * truth — scenes always store it, and LaTeX exists only inside the editor
 * widget — so these converters are the whole bridge:
 *
 *   sourceToLatex  render a stored formula into the math editor
 *   latexToSource  turn what the user typed back into source on commit
 *   isMathRenderable  gate: only the "clean" subset of the language
 *                     (arithmetic, powers, functions) is offered typeset
 *                     editing; if/else, and/or/not, // and % have no
 *                     sensible math notation and stay in the text editor.
 *
 * Both directions go through the expr.ts AST, and the LaTeX parser
 * validates names/arity with the same rules as the source parser, so a
 * successful conversion always yields compilable source. Conversions
 * never touch precision: numbers are re-emitted from the parsed double.
 */
import { CONSTS, ExprError, ExprNode, FUNCS, VAR_NAMES, checkArity,
         parseSource } from "./expr";

// ------------------------------------------------------- renderable subset
/** True if `source` parses and uses only constructs the typeset editor can
 * show (arithmetic, powers, unary minus, function calls). */
export function isMathRenderable(source: string): boolean {
  let node: ExprNode;
  try {
    node = parseSource(source);
  } catch {
    return false; // broken source can only be fixed as text
  }
  return renderable(node);
}

function renderable(node: ExprNode): boolean {
  switch (node.kind) {
    case "num":
      // e-notation literals (1.5e-7) have no exact typeset form — LaTeX
      // would have to split them into mantissa*10^n, and re-multiplying
      // is not guaranteed to reproduce the same double. Text mode only.
      return !String(node.value).includes("e");
    case "var":
    case "const":
      return true;
    case "neg":
      return renderable(node.operand);
    case "call":
      return node.args.every(renderable);
    case "binary":
      return node.op !== "//" && node.op !== "%" &&
             renderable(node.left) && renderable(node.right);
    default: // compare, logic, not, ternary
      return false;
  }
}

// ------------------------------------------------------------ AST → LaTeX
// How functions typeset. Everything else falls back to \operatorname{}.
const FUNC_LATEX: Record<string, string> = {
  sin: "\\sin", cos: "\\cos", tan: "\\tan",
  asin: "\\arcsin", acos: "\\arccos", atan: "\\arctan",
  exp: "\\exp", log: "\\ln", // our log IS natural log; \ln says so
  min: "\\min", max: "\\max",
};
const CONST_LATEX: Record<string, string> = {
  pi: "\\pi", tau: "\\tau", e: "e", g: "g",
};

/** Emission precedence. Fractions and calls render as visually closed
 * boxes, so they count as atoms and never need parentheses themselves. */
function latexPrec(node: ExprNode): number {
  switch (node.kind) {
    case "binary":
      if (node.op === "/") return 9; // \frac is an atom
      if (node.op === "**") return 8;
      return node.op === "+" || node.op === "-" ? 5 : 6;
    case "neg": return 7;
    default: return 9;
  }
}

function numToLatex(v: number): string {
  const s = String(v);
  // e-notation literals are gated out by isMathRenderable (splitting them
  // into mantissa*10^n could round differently); guard anyway
  if (s.includes("e")) throw new ExprError("formula uses features the math editor can't show");
  return s;
}

/** Can `right` be juxtaposed after `left` without a \cdot? Safe cases only:
 * a numeric coefficient before a variable, constant, power-of-variable or
 * function call (0.5v_x, 2\pi, 3\sin(t)), or any factor before one of those
 * non-digit-leading shapes (x\,y re-parses via the letter-run rule). */
function implicitOk(left: ExprNode, right: ExprNode): boolean {
  const rightBare = right.kind === "var" || right.kind === "const" ||
    right.kind === "call" ||
    (right.kind === "binary" && right.op === "**" &&
     (right.left.kind === "var" || right.left.kind === "const"));
  if (!rightBare) return false;
  // left side: anything except shapes whose emission could end in a digit
  // directly before a digit — right never starts with one here, so all good
  void left;
  return true;
}

function emitLatex(node: ExprNode, minPrec: number): string {
  const s = latexNode(node);
  if (latexPrec(node) < minPrec) return `\\left(${s}\\right)`;
  return s;
}

function latexNode(node: ExprNode): string {
  switch (node.kind) {
    case "num": return numToLatex(node.value);
    case "var":
      if (node.name === "vx") return "v_{x}";
      if (node.name === "vy") return "v_{y}";
      return node.name;
    case "const": return CONST_LATEX[node.name];
    case "neg": return `-${emitLatex(node.operand, 7)}`;
    case "call": {
      if (node.name === "sqrt") return `\\sqrt{${emitLatex(node.args[0], 0)}}`;
      if (node.name === "abs") return `\\left|${emitLatex(node.args[0], 0)}\\right|`;
      const head = FUNC_LATEX[node.name] ?? `\\operatorname{${node.name}}`;
      const args = node.args.map((a) => emitLatex(a, 0)).join(",");
      return `${head}\\left(${args}\\right)`;
    }
    case "binary": {
      const { op, left, right } = node;
      if (op === "/") return `\\frac{${emitLatex(left, 0)}}{${emitLatex(right, 0)}}`;
      if (op === "**") {
        // base must read as a closed atom: 2^{x}, x^{2}, \sin(x)^{2}, but
        // \left(-x\right)^{2} and \left(\frac{a}{b}\right)^{2}
        const closed = left.kind === "num" || left.kind === "var" ||
          left.kind === "const" ||
          (left.kind === "call" && left.name !== "sqrt");
        const base = closed ? latexNode(left) : `\\left(${latexNode(left)}\\right)`;
        return `${base}^{${emitLatex(right, 0)}}`;
      }
      if (op === "+" || op === "-") {
        // right operand keeps parens when it is same-precedence or a unary
        // minus, so the exact grouping (and float rounding) survives
        return `${emitLatex(left, 5)}${op}${emitLatex(right, 6)}`;
      }
      // "*" — juxtapose when unambiguous, \cdot otherwise. The space is
      // load-bearing: it stops a trailing command from swallowing the next
      // letter (\pi x, not \pix) and renders as nothing in math mode.
      const l = emitLatex(left, 6);
      const r = emitLatex(right, 7);
      return implicitOk(left, right) ? `${l} ${r}` : `${l}\\cdot ${r}`;
    }
    default:
      throw new ExprError("formula uses features the math editor can't show");
  }
}

/** Render source text as LaTeX for the math editor.
 * Throws ExprError if the source is invalid or outside the math subset. */
export function sourceToLatex(source: string): string {
  return emitLatex(parseSource(source), 0);
}

// ----------------------------------------------------------- AST → source
function srcPrec(node: ExprNode): number {
  switch (node.kind) {
    case "ternary": return 0;
    case "logic": return node.op === "or" ? 1 : 2;
    case "not": return 3;
    case "compare": return 4;
    case "binary":
      if (node.op === "**") return 8;
      return node.op === "+" || node.op === "-" ? 5 : 6;
    case "neg": return 7;
    default: return 9;
  }
}

function emitSrc(node: ExprNode, minPrec: number): string {
  const s = srcNode(node);
  if (srcPrec(node) < minPrec) return `(${s})`;
  return s;
}

function srcNode(node: ExprNode): string {
  switch (node.kind) {
    case "num": return String(node.value);
    case "var": return node.name;
    case "const": return node.name;
    case "neg": return `-${emitSrc(node.operand, 7)}`;
    case "not": return `not ${emitSrc(node.operand, 3)}`;
    case "call":
      return `${node.name}(${node.args.map((a) => emitSrc(a, 0)).join(", ")})`;
    case "binary": {
      const { op, left, right } = node;
      if (op === "**") {
        // right-assoc, and the right side may be unary: 2^-3
        return `${emitSrc(left, 9)}^${emitSrc(right, 7)}`;
      }
      const prec = op === "+" || op === "-" ? 5 : 6;
      return `${emitSrc(left, prec)}${op}${emitSrc(right, prec + 1)}`;
    }
    case "compare": {
      let out = emitSrc(node.operands[0], 5);
      for (let i = 0; i < node.ops.length; i++) {
        out += ` ${node.ops[i]} ${emitSrc(node.operands[i + 1], 5)}`;
      }
      return out;
    }
    case "logic": {
      const prec = node.op === "or" ? 1 : 2;
      return `${emitSrc(node.left, prec)} ${node.op} ${emitSrc(node.right, prec + 1)}`;
    }
    case "ternary":
      return `${emitSrc(node.body, 1)} if ${emitSrc(node.cond, 1)}` +
             ` else ${emitSrc(node.orelse, 0)}`;
  }
}

/** Linearize an AST back into source text (used after LaTeX parsing and in
 * round-trip tests). Always yields text `parseSource` accepts. */
export function astToSource(node: ExprNode): string {
  return emitSrc(node, 0);
}

// ------------------------------------------------------------ LaTeX → AST
// A small recursive-descent parser for the LaTeX MathLive produces for the
// math subset. Digits arrive as individual tokens (as in real TeX) so a
// braceless superscript can take exactly one: x^22 is x^2 * 2.
type LTok =
  | { kind: "cmd"; name: string }
  | { kind: "digit"; ch: string }   // 0-9 or .
  | { kind: "letter"; ch: string }
  | { kind: "sym"; ch: string };

const SKIP_CMDS = new Set([",", ";", "!", ":", " ", "enspace", "quad", "qquad",
                           "mspace", "hspace", "space", "displaystyle"]);
// commands that read as a function head
const CMD_FUNCS: Record<string, string> = {
  sin: "sin", cos: "cos", tan: "tan",
  arcsin: "asin", arccos: "acos", arctan: "atan",
  ln: "log", log: "log", exp: "exp", min: "min", max: "max",
};
const CMD_CONSTS: Record<string, string> = {
  pi: "pi", tau: "tau", exponentialE: "e",
};

function lexLatex(latex: string): LTok[] {
  const toks: LTok[] = [];
  let i = 0;
  const n = latex.length;
  while (i < n) {
    const c = latex[i];
    if (c === " " || c === "\t" || c === "\n" || c === "~") { i++; continue; }
    if (c === "\\") {
      const m = /^\\([A-Za-z]+|.)/.exec(latex.slice(i));
      if (!m) throw new ExprError("stray '\\' in formula");
      if (!SKIP_CMDS.has(m[1])) toks.push({ kind: "cmd", name: m[1] });
      i += m[0].length;
      continue;
    }
    if ((c >= "0" && c <= "9") || c === ".") {
      toks.push({ kind: "digit", ch: c });
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      toks.push({ kind: "letter", ch: c });
      i++;
      continue;
    }
    if ("{}()[]^_+-*/|,".includes(c)) {
      toks.push({ kind: "sym", ch: c });
      i++;
      continue;
    }
    if (c === "<" || c === ">" || c === "=") {
      throw new ExprError("comparisons and if/else need the text editor");
    }
    if (c === "!") throw new ExprError("factorials aren't supported");
    throw new ExprError(`unexpected '${c}' in formula`);
  }
  return toks;
}

class LatexParser {
  private pos = 0;
  constructor(private toks: LTok[]) {}

  private peek(): LTok | undefined { return this.toks[this.pos]; }
  private next(): LTok | undefined { return this.toks[this.pos++]; }
  private isSym(ch: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === "sym" && t.ch === ch;
  }
  private isCmd(...names: string[]): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === "cmd" && names.includes(t.name);
  }

  parse(): ExprNode {
    const node = this.expr();
    if (this.pos < this.toks.length) {
      throw new ExprError("unexpected trailing input");
    }
    return node;
  }

  /** True if the next token can begin a factor — drives implicit
   * multiplication (2x, x\sin(t), 3(x+1)). */
  private startsFactor(): boolean {
    const t = this.peek();
    if (t === undefined) return false;
    if (t.kind === "digit" || t.kind === "letter") return true;
    // "|" is excluded: it closes as often as it opens, so it can never
    // start an implicitly multiplied factor
    if (t.kind === "sym") return t.ch === "(" || t.ch === "[" || t.ch === "{";
    // any command except the ones that terminate or join expressions
    return !["right", "mright", "cdot", "times", "ast", "div"].includes(t.name);
  }

  private expr(): ExprNode {
    let left = this.term(); // a leading sign is handled by factor()
    while (this.isSym("+") || this.isSym("-")) {
      const op = (this.next() as { ch: string }).ch as "+" | "-";
      left = { kind: "binary", op, left, right: this.term() };
    }
    return left;
  }

  private term(): ExprNode {
    let left = this.factor();
    for (;;) {
      if (this.isCmd("cdot", "times", "ast") || this.isSym("*")) {
        this.next();
        left = { kind: "binary", op: "*", left, right: this.factor() };
      } else if (this.isCmd("div") || this.isSym("/")) {
        this.next();
        left = { kind: "binary", op: "/", left, right: this.factor() };
      } else if (this.startsFactor()) {
        left = { kind: "binary", op: "*", left, right: this.factor() };
      } else {
        return left;
      }
    }
  }

  /** factor := ('-'|'+')* postfix — signs can appear after \cdot etc. */
  private factor(): ExprNode {
    if (this.isSym("-")) {
      this.next();
      const operand = this.factor();
      if (operand.kind === "binary" && operand.op === "/") {
        // -\frac{1}{2} reads as -1/2, not -(1/2). Bit-exact: IEEE division
        // is sign-symmetric, so -(a/b) === (-a)/b always.
        return { ...operand, left: { kind: "neg", operand: operand.left } };
      }
      return { kind: "neg", operand };
    }
    if (this.isSym("+")) {
      this.next();
      return this.factor();
    }
    return this.postfix();
  }

  /** An atom with any trailing superscripts applied. */
  private postfix(): ExprNode {
    let node = this.atom();
    while (this.isSym("^")) {
      this.next();
      node = { kind: "binary", op: "**", left: node, right: this.scriptArg() };
    }
    return node;
  }

  /** The argument of ^ or _: a braced group or exactly one token. */
  private scriptArg(): ExprNode {
    if (this.isSym("{")) return this.group();
    if (this.isSym("-")) { // x^-2 (rare but harmless to accept)
      this.next();
      return { kind: "neg", operand: this.scriptArg() };
    }
    const t = this.next();
    if (t === undefined) throw new ExprError("missing value");
    if (t.kind === "digit" && t.ch !== ".") {
      return { kind: "num", value: parseInt(t.ch, 10) };
    }
    if (t.kind === "letter") {
      if (VAR_NAMES.has(t.ch)) return { kind: "var", name: t.ch };
      if (t.ch in CONSTS) return { kind: "const", name: t.ch };
      throw new ExprError(`unknown name '${t.ch}' (use x, y, vx, vy, t, m, r)`);
    }
    if (t.kind === "cmd" && t.name in CMD_CONSTS) {
      return { kind: "const", name: CMD_CONSTS[t.name] };
    }
    throw new ExprError("missing value");
  }

  /** `{ expr }` including the braces. */
  private group(): ExprNode {
    this.expectSym("{");
    if (this.isSym("}")) throw new ExprError("the formula has an empty box — fill it in");
    const node = this.expr();
    this.expectSym("}");
    return node;
  }

  /** A \frac/\sqrt argument: braced group or, as in real TeX, exactly one
   * token (\frac12 is 1/2, not 12/...). */
  private cmdArg(): ExprNode {
    if (this.isSym("{")) return this.group();
    return this.scriptArg();
  }

  private expectSym(ch: string): void {
    if (!this.isSym(ch)) throw new ExprError(`expected '${ch}'`);
    this.next();
  }

  private atom(): ExprNode {
    const t = this.peek();
    if (t === undefined) throw new ExprError("the formula ends too soon");

    if (t.kind === "digit") return this.number();
    if (t.kind === "letter") return this.letterAtom();
    if (t.kind === "sym") {
      if (t.ch === "(" || t.ch === "[") {
        this.next();
        const inner = this.expr();
        this.expectSym(t.ch === "(" ? ")" : "]");
        return inner;
      }
      if (t.ch === "{") return this.group();
      if (t.ch === "|") {
        this.next();
        const inner = this.expr();
        this.expectSym("|");
        return { kind: "call", name: "abs", args: [inner] };
      }
      throw new ExprError(`unexpected '${t.ch}'`);
    }

    // commands
    const name = t.name;
    this.next();
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const num = this.cmdArg();
      const den = this.cmdArg();
      return { kind: "binary", op: "/", left: num, right: den };
    }
    if (name === "sqrt") {
      if (this.isSym("[")) {
        throw new ExprError("nth roots aren't supported — write x^(1/3)");
      }
      return { kind: "call", name: "sqrt", args: [this.cmdArg()] };
    }
    if (name === "left" || name === "mleft") return this.fenced();
    if (name in CMD_CONSTS) return { kind: "const", name: CMD_CONSTS[name] };
    if (name in CMD_FUNCS) return this.callArgs(CMD_FUNCS[name]);
    if (name === "operatorname" || name === "mathrm" || name === "mathit" ||
        name === "text" || name === "mathop") {
      return this.namedValue(this.bracedName());
    }
    if (name === "vert" || name === "lvert") {
      const inner = this.expr();
      if (!this.isCmd("vert", "rvert")) throw new ExprError("expected '|'");
      this.next();
      return { kind: "call", name: "abs", args: [inner] };
    }
    if (name === "placeholder") {
      throw new ExprError("the formula has an empty box — fill it in");
    }
    if (name === "le" || name === "ge" || name === "ne" || name === "lt" ||
        name === "gt" || name === "leq" || name === "geq" || name === "neq") {
      throw new ExprError("comparisons and if/else need the text editor");
    }
    throw new ExprError(`'\\${name}' isn't supported in formulas`);
  }

  /** \left<fence> expr \right<fence> — parens or |…| for abs. */
  private fenced(): ExprNode {
    const open = this.next();
    if (open === undefined) throw new ExprError("the formula ends too soon");
    const isAbs = (open.kind === "sym" && open.ch === "|") ||
                  (open.kind === "cmd" && (open.name === "vert" || open.name === "lvert"));
    const inner = this.expr();
    if (!this.isCmd("right", "mright")) throw new ExprError("expected closing bracket");
    this.next();
    this.next(); // the closing fence character itself (or '.')
    if (isAbs) return { kind: "call", name: "abs", args: [inner] };
    return inner;
  }

  /** The letters inside \operatorname{...} and friends. */
  private bracedName(): string {
    this.expectSym("{");
    let s = "";
    for (;;) {
      const t = this.next();
      if (t === undefined) throw new ExprError("expected '}'");
      if (t.kind === "sym" && t.ch === "}") break;
      if (t.kind === "letter") s += t.ch;
      else if (t.kind === "digit") s += t.ch;
      else throw new ExprError("unexpected content in name");
    }
    return s;
  }

  /** Merge consecutive digit tokens into one number literal. */
  private number(): ExprNode {
    let s = "";
    while (this.peek()?.kind === "digit") {
      s += (this.next() as { ch: string }).ch;
    }
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) throw new ExprError(`bad number '${s}'`);
    return { kind: "num", value: parseFloat(s) };
  }

  // Multi-letter names the greedy matcher recognizes in an italic letter
  // run: functions (typed or pasted as plain letters) and the multi-letter
  // variables/constants. Longest first, so `exp` beats `e` and `tau`
  // beats `t`.
  private static MULTI_NAMES: string[] = [
    ...Object.keys(FUNCS), ...Object.keys(CMD_FUNCS), "vx", "vy", "pi", "tau",
  ].filter((n, i, a) => n.length >= 2 && a.indexOf(n) === i)
   .sort((a, b) => b.length - a.length);

  /** Resolve one value starting at a letter. A subscript binds first
   * (v_x → vx); otherwise the longest known name starting here wins
   * (sin, vx, pi, tau); otherwise a single-letter variable/constant.
   * Only ONE name is consumed — adjacent leftovers re-enter the term
   * loop as implicit multiplication, keeping products left-associated
   * (2xy → (2*x)*y, exactly as typed source would parse). */
  private letterAtom(): ExprNode {
    const first = this.next() as { kind: "letter"; ch: string };
    // subscript on this single letter: v_x, v_y
    if (this.isSym("_")) {
      this.next();
      const combined = first.ch + this.subscriptName(); // v + x → vx
      if (!VAR_NAMES.has(combined)) {
        throw new ExprError("only v_x and v_y subscripts are supported");
      }
      return { kind: "var", name: combined };
    }
    // longest known multi-letter name (lookahead only; consume on match).
    // A letter that owns a following subscript is never swallowed, since
    // no known name's tail letter also starts a subscripted variable.
    let run = first.ch;
    for (let j = this.pos; run.length < 12; j++) {
      const t = this.toks[j];
      if (t === undefined || t.kind !== "letter") break;
      run += t.ch;
    }
    for (const name of LatexParser.MULTI_NAMES) {
      if (run.startsWith(name)) {
        this.pos += name.length - 1; // first letter was already consumed
        return this.namedValue(name);
      }
    }
    // single letter: a variable or constant
    if (VAR_NAMES.has(first.ch)) return { kind: "var", name: first.ch };
    if (first.ch in CONSTS) return { kind: "const", name: first.ch };
    throw new ExprError(`unknown name '${run}' (use x, y, vx, vy, t, m, r)`);
  }

  /** A resolved name: function head (arguments follow) or value. */
  private namedValue(name: string): ExprNode {
    if (name in FUNCS || name in CMD_FUNCS) {
      return this.callArgs(name in FUNCS ? name : CMD_FUNCS[name]);
    }
    if (VAR_NAMES.has(name)) return { kind: "var", name };
    if (name in CONSTS) return { kind: "const", name };
    // \operatorname{foo}(...) — same complaint as the source parser
    throw new ExprError("only math functions like sin, cos, sqrt may be called");
  }

  /** The single character (or braced single name) after `_`. */
  private subscriptName(): string {
    if (this.isSym("{")) {
      this.next();
      let s = "";
      while (this.peek()?.kind === "letter") s += (this.next() as { ch: string }).ch;
      this.expectSym("}");
      return s;
    }
    const t = this.next();
    if (t === undefined || t.kind !== "letter") {
      throw new ExprError("only v_x and v_y subscripts are supported");
    }
    return t.ch;
  }

  /** Parenthesized argument list for a function head. */
  private callArgs(fname: string): ExprNode {
    if (this.isSym("^")) {
      throw new ExprError(`write ${fname}(...)^2 rather than ${fname}^2(...)`);
    }
    const args: ExprNode[] = [];
    if (this.isCmd("left", "mleft")) {
      this.next();
      if (!this.isSym("(")) throw new ExprError(`${fname} needs parentheses: ${fname}(...)`);
      this.next();
      args.push(this.expr());
      while (this.isSym(",")) {
        this.next();
        args.push(this.expr());
      }
      if (!this.isCmd("right", "mright")) throw new ExprError("expected ')'");
      this.next();
      this.expectSym(")");
    } else if (this.isSym("(")) {
      this.next();
      args.push(this.expr());
      while (this.isSym(",")) {
        this.next();
        args.push(this.expr());
      }
      this.expectSym(")");
    } else if (this.isSym("{")) {
      args.push(this.group());
    } else {
      throw new ExprError(`${fname} needs parentheses: ${fname}(...)`);
    }
    checkArity(fname, args.length);
    return { kind: "call", name: fname, args };
  }
}

/** Parse the math editor's LaTeX into an expression AST.
 * Throws ExprError with a friendly message when the content is incomplete
 * or uses notation outside the formula language. */
export function latexToAst(latex: string): ExprNode {
  const toks = lexLatex(latex);
  if (toks.length === 0) throw new ExprError("empty expression");
  return new LatexParser(toks).parse();
}

/** Convert the math editor's LaTeX back into formula source text. */
export function latexToSource(latex: string): string {
  return astToSource(latexToAst(latex));
}
