/** Formula guide: a paged overlay documenting the whole force-field
 * formula system — variables, operators, functions, logic, the typeset
 * math editor, and ready-made recipes that can be added to the world with
 * one click.
 *
 * Examples are shown both ways, mirroring the editor itself: rendered as
 * typeset math (via MathLive's static renderer, loaded lazily and shared
 * with the editor's chunk) with the plain-text source underneath. If the
 * renderer isn't available the source alone still documents everything.
 */
import { App } from "../app";
import { isMathRenderable, sourceToLatex } from "../core/mathfmt";
import { ForceField } from "../engine/world";
import { button, el, isTouch } from "./dom";
import { RECIPES } from "./guide-recipes";
import { ICONS } from "./icons";

// ------------------------------------------------------- typeset rendering
type Typeset = (latex: string) => string;
let typesetLoading: Promise<Typeset> | null = null;

function loadTypeset(): Promise<Typeset> {
  if (!typesetLoading) {
    typesetLoading = Promise.all([
      import("mathlive"),
      import("mathlive/static.css"),
      import("mathlive/fonts.css"),
    ]).then(([m]) => {
      m.MathfieldElement.fontsDirectory = null;
      return (latex: string) => m.convertLatexToMarkup(latex);
    });
  }
  return typesetLoading;
}

/** A formula shown the "nice" way: typeset once MathLive is available,
 * with the plain source always underneath (or alone when the formula is
 * text-only). */
function formula(source: string): HTMLElement {
  const wrap = el("div", { class: "guide-formula" });
  if (isMathRenderable(source)) {
    const math = el("div", { class: "guide-math", text: source });
    math.dataset.latex = sourceToLatex(source);
    wrap.append(math, el("div", { class: "guide-src", text: source }));
  } else {
    wrap.append(el("div", { class: "guide-src only", text: source }));
  }
  return wrap;
}

/** Upgrade every pending .guide-math in `root` to typeset markup. */
function upgradeMath(root: HTMLElement): void {
  loadTypeset().then((render) => {
    for (const n of root.querySelectorAll<HTMLElement>(".guide-math[data-latex]")) {
      try {
        n.innerHTML = render(n.dataset.latex!);
        delete n.dataset.latex;
      } catch {
        /* keep the source text */
      }
    }
  }, () => { /* offline: source text remains, which is fully readable */ });
}

// ------------------------------------------------------------ page helpers
function para(text: string): HTMLElement {
  return el("p", { class: "guide-p", text });
}

function heading(text: string): HTMLElement {
  return el("h3", { class: "guide-h", text });
}

/** Two-column reference table: code | description. */
function refTable(rows: Array<[string, string]>): HTMLElement {
  const t = el("table", { class: "guide-table" });
  for (const [code, desc] of rows) {
    t.append(el("tr", {},
      el("td", { class: "code", text: code }),
      el("td", { class: "desc", text: desc })));
  }
  return t;
}

/** An inline worked example: formula (typeset + source) with a caption. */
function example(source: string, caption: string): HTMLElement {
  return el("div", { class: "guide-example" },
    formula(source), el("div", { class: "guide-caption", text: caption }));
}

// ------------------------------------------------------------------- pages
const PAGES = ["Basics", "Functions", "Logic", "Math editor", "Recipes"] as const;
type Page = (typeof PAGES)[number];

export class FormulaGuide {
  visible = false;
  private root: HTMLElement;
  private body: HTMLElement;
  private chips = new Map<Page, HTMLButtonElement>();
  private page: Page = "Basics";
  private app: App;

  constructor(app: App, root: HTMLElement) {
    this.app = app;
    this.root = root;
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) this.close();
    });

    const header = el("div", { class: "overlay-header" },
      el("h2", { text: "Force-field formulas" }));
    header.append(button("", () => this.close(),
      { icon: ICONS.close, style: "ghost", tooltip: "Close (Esc)" }).root);

    const chipRow = el("div", { class: "cat-chips" });
    for (const p of PAGES) {
      const b = el("button", { text: p });
      b.addEventListener("click", () => {
        this.page = p;
        this.render();
      });
      this.chips.set(p, b);
      chipRow.append(b);
    }

    this.body = el("div", { class: "overlay-body guide-body" });
    root.append(el("div", { class: "overlay-panel" }, header, chipRow, this.body));
  }

  open(page: Page = this.page): void {
    this.page = page;
    this.visible = true;
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    this.visible = false;
    this.root.hidden = true;
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }

  private render(): void {
    for (const [p, b] of this.chips) b.classList.toggle("active", p === this.page);
    this.body.replaceChildren();
    switch (this.page) {
      case "Basics": this.buildBasics(); break;
      case "Functions": this.buildFunctions(); break;
      case "Logic": this.buildLogic(); break;
      case "Math editor": this.buildMathEditor(); break;
      case "Recipes": this.buildRecipes(); break;
    }
    this.body.scrollTop = 0;
    upgradeMath(this.body);
  }

  // ------------------------------------------------------------------ pages
  private buildBasics(): void {
    this.body.append(
      para("A force field applies a force, in newtons, to every body on " +
           "every physics step. Each field is two formulas - Fx and Fy, " +
           "the force components - re-evaluated for each body, so the " +
           "variables below describe the body currently being pushed."),
      para("Because it is a force (F = ma), the same field accelerates a " +
           "light body more than a heavy one. Multiply by m when you want " +
           "every body to accelerate equally."),
      heading("Variables (per body)"),
      refTable([
        ["x,  y", "Position (m)"],
        ["vx,  vy", "Velocity (m/s)"],
        ["t", "Simulation time (s)"],
        ["m", "Mass (kg)"],
        ["r", "Distance from the origin (m): r = sqrt(x^2 + y^2)"],
      ]),
      heading("Constants"),
      refTable([
        ["pi", "3.14159... (half a turn, in radians)"],
        ["tau", "6.28318... = 2*pi (one full turn)"],
        ["e", "2.71828... (Euler's number)"],
        ["g", "9.81 (standard gravity, m/s^2)"],
      ]),
      heading("Operators"),
      refTable([
        ["+  -  *  /", "Arithmetic. Multiplication is explicit: 3*x, not 3x " +
                       "(the math editor accepts 3x and inserts the * for you)"],
        ["^  or  **", "Power: x^2 is x squared. -x^2 means -(x^2); " +
                      "2^-3 works; x^(1/3) is a cube root"],
        ["%", "Remainder, sign follows the divisor (Python style)"],
        ["//", "Floor division: 7 // 2 is 3"],
        ["( )", "Grouping"],
        ["1.5,  0.02,  1e-3", "Numbers, scientific notation included"],
      ]),
      heading("When something is wrong"),
      para("A formula that does not parse - or that evaluates to NaN, like " +
           "sqrt of a negative - disables its field, and the reason appears " +
           "in red underneath. The text stays so you can fix it in place."),
      example("-9*y*exp(-r/5)/(r+0.15) - 3*x/(r+0.3)",
              "Fx of the Cyclone preset: a swirl that fades with distance " +
              "plus an inward pull. Every piece is explained in this guide."));
  }

  private buildFunctions(): void {
    this.body.append(
      para("All angles are in radians (tau is one full turn). A function " +
           "outside its domain - sqrt of a negative, log of zero - gives " +
           "NaN, which shows as an error under the formula."),
      heading("Trigonometry"),
      refTable([
        ["sin(a)  cos(a)  tan(a)", "The classics"],
        ["asin(a)  acos(a)  atan(a)", "Their inverses"],
        ["atan2(y, x)", "Angle of the point (x, y), correct in all quadrants " +
                        "- unlike atan(y/x)"],
      ]),
      heading("Powers & growth"),
      refTable([
        ["sqrt(a)", "Square root"],
        ["exp(a)", "e to the power a"],
        ["log(a)", "Natural logarithm (base e)"],
        ["hypot(x, y)", "sqrt(x^2 + y^2), without overflow"],
      ]),
      heading("Shaping"),
      refTable([
        ["abs(a)", "Absolute value"],
        ["sign(a)", "-1, 0 or 1"],
        ["floor(a)  ceil(a)", "Round down / up to a whole number"],
        ["min(a, b, ...)  max(a, b, ...)", "Smallest / largest of any count " +
                                           "of arguments"],
      ]),
      heading("Worked examples"),
      example("sin(atan2(y, x))", "The y-component of the unit vector " +
              "pointing at the body - handy for direction-only forces."),
      example("min(r, 3)/3", "Ramps from 0 at the origin up to 1 at r = 3, " +
              "then stays flat - a clamped ramp."),
      example("exp(-(r/2)^2)", "A Gaussian bump: 1 at the centre, fading " +
              "smoothly, practically gone past r = 4."));
  }

  private buildLogic(): void {
    this.body.append(
      para("Comparisons and logic turn formulas into machines with zones, " +
           "switches and states. They follow Python's rules exactly. These " +
           "constructs have no standard math notation, so rows using them " +
           "are edited as plain text - the toggle next to the row shows " +
           "when that is the case."),
      heading("Comparisons give 1 or 0"),
      refTable([
        ["<  <=  >  >=  ==  !=", "Result is 1.0 when true, 0.0 when false"],
        ["0 < x < 5", "Chaining works like in Python: both parts must hold"],
      ]),
      example("-0.4*m*(y > 2)", "A force that exists only above y = 2: the " +
              "comparison multiplies the force by 1 inside the zone, 0 outside."),
      heading("Either/or"),
      refTable([
        ["a if cond else b", "a when cond is non-zero, otherwise b. " +
                             "Nests: a if p else (b if q else c)"],
        ["and  or", "Short-circuit like Python, returning an operand: " +
                    "(x > 0) and 5 is 5 or 0"],
        ["not a", "1 when a is zero, else 0"],
      ]),
      example("5 if y > 2 else -5", "Push up above the line, down below it - " +
              "a hard switch."),
      heading("Cycles and steps"),
      refTable([
        ["floor(t) % 2", "Alternates 0, 1, 0, 1... every second"],
        ["t % 3", "A sawtooth ramping 0 to 3, repeating"],
      ]),
      heading("Smooth alternatives"),
      para("A hard switch kicks bodies discontinuously, and it keeps the " +
           "formula out of the typeset editor. These stay smooth - and " +
           "typeset - while doing nearly the same job:"),
      example("exp(-(r/0.7)^4)", "Nearly 1 inside r = 0.7, nearly 0 " +
              "outside: a smooth (r < 0.7). The Cyclone preset uses this."),
      example("1/(1+exp(-10*(y-2)))", "A sigmoid: 0 below y = 2, 1 above, " +
              "with a soft transition. Raise the 10 to sharpen it."));
  }

  private buildMathEditor(): void {
    const touch = isTouch();
    this.body.append(
      para("Formulas made of plain arithmetic - numbers, variables, " +
           "+ - * / ^, and functions - are edited as real typeset math. " +
           "Rows using logic, comparisons, if/else, // or % switch to a " +
           "plain text box instead, and the button beside each row swaps " +
           "between the two views whenever both are possible."),
      heading("Typing math"),
      refTable(touch ? [
        ["^", "Starts a superscript: x^2 shows as x squared"],
        ["/", "Builds a real fraction; the keyboard's arrows move between " +
              "numerator and denominator"],
        ["sqrt(", "Draws a radical you type inside"],
        ["vx, vy", "Become subscripts as you type"],
        ["pi, tau", "Become Greek letters"],
        ["sin, cos, min...", "Function names format themselves"],
      ] : [
        ["^", "Jumps into a superscript: type x^2 and the 2 rises. " +
              "Right-arrow steps back out"],
        ["/", "Builds a real fraction and puts the cursor in the " +
              "denominator. Right-arrow steps out"],
        ["sqrt(", "Draws a radical you type inside"],
        ["vx, vy", "Become subscripts as you type"],
        ["pi, tau", "Become Greek letters"],
        ["sin, cos, min...", "Function names format themselves"],
        ["2x, 3sin(t)", "Implicit multiplication is understood"],
      ]),
      heading("Committing and escaping"),
      refTable(touch ? [
        ["Tap away", "Commits the formula"],
        ["Return", "Commits the formula"],
      ] : [
        ["Enter or click away", "Commits the formula"],
        ["Escape", "Restores the stored formula, discarding the edit"],
      ]),
      heading("One formula, two views"),
      para("Both editors edit the same underlying text. Scenes, saves and " +
           "the physics engine only ever see the plain-text form, so " +
           "nothing about a scene changes based on which editor was used. " +
           "Switching views never alters what the formula computes."),
      para("The only text-only numbers are scientific-notation constants " +
           "like 1.5e-7: splitting one into a typeset power of ten could " +
           "change its last decimal digit, so those rows stay as text " +
           "rather than risk it."),
      heading("Reading the toggle"),
      refTable([
        ["Radical icon", "Switch this row to typeset math"],
        ["T icon", "Switch this row to plain text"],
        ["Greyed out", "The formula uses text-only features (logic, " +
                       "if/else, // or %), so typeset editing is unavailable"],
      ]));
  }

  private buildRecipes(): void {
    this.body.append(para(
      "Ready-made fields to drop into the world and take apart. Each " +
      "button adds the recipe as a new force field (undo removes it); " +
      "open the World tab to see and edit what arrived."));
    const grid = el("div", { class: "card-grid guide-recipes" });
    for (const r of RECIPES) {
      const card = el("div", { class: "preset-card guide-recipe" },
        el("h3", { text: r.name }));
      const fx = el("div", { class: "guide-recipe-row" },
        el("span", { class: "guide-recipe-lbl", text: "Fx" }), formula(r.fx));
      const fy = el("div", { class: "guide-recipe-row" },
        el("span", { class: "guide-recipe-lbl", text: "Fy" }), formula(r.fy));
      card.append(fx, fy, el("p", { text: r.blurb }));
      const addBtn = button("Add as field", () => {
        this.app.world.fields.push(new ForceField(r.name, r.fx, r.fy));
        this.app.pushUndo();
        this.app.toast(`Added force field "${r.name}" - see the World tab`);
      }, { icon: ICONS.plus, style: "ghost", class: "guide-add" });
      card.append(addBtn.root);
      grid.append(card);
    }
    this.body.append(grid);
  }
}
