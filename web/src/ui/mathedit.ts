/** Typeset formula editor for force fields, backed by MathLive.
 *
 * Presents a formula as real math — typing ^ jumps into a superscript,
 * / builds a fraction, sqrt draws a radical — while the engine keeps
 * seeing plain source text: the widget renders `get()` through
 * sourceToLatex and converts the user's LaTeX back with latexToSource on
 * commit (Enter or blur), exactly mirroring textEdit's contract.
 *
 * MathLive (~200 KB) is loaded on demand the first time a math row is
 * built, so it never weighs on the initial page load; until it arrives
 * the row shows a plain text input that is fully functional. Fonts come
 * through the bundled stylesheet, so nothing is fetched at runtime.
 *
 * Editing rules that keep the widget honest:
 *  - the field is never rewritten while focused or showing a conversion
 *    error, so a formula cannot change under the caret;
 *  - committing unchanged content is a no-op (no undo spam, no
 *    re-normalization);
 *  - Escape restores the stored formula, like every other control.
 */
import { latexToSource, sourceToLatex } from "../core/mathfmt";
import { Control, el, textEdit } from "./dom";

type Mathlive = typeof import("mathlive");
let loading: Promise<Mathlive> | null = null;

function loadMathlive(): Promise<Mathlive> {
  if (!loading) {
    loading = Promise.all([
      import("mathlive"),
      import("mathlive/fonts.css"), // vite bundles the woff2 assets
    ]).then(([m]) => {
      m.MathfieldElement.fontsDirectory = null;  // fonts come from the css
      m.MathfieldElement.soundsDirectory = null; // no keypress plonks
      return m;
    });
  }
  return loading;
}

/** Typing shortcuts for names MathLive doesn't know: our variables, and
 * functions that convert to their standard mathematical notation as you
 * type — exp becomes e^□, abs becomes |□|, floor/ceil become ⌊□⌋/⌈□⌉
 * (#? is a placeholder box the caret lands in). (sin, sqrt, pi are built
 * in. atan is left out on purpose: an eager atan → arctan conversion
 * would make atan2 impossible to type; plain-letter atan still parses.) */
const SHORTCUTS: Record<string, string> = {
  vx: "v_{x}", vy: "v_{y}", tau: "\\tau",
  asin: "\\arcsin", acos: "\\arccos",
  atan2: "\\operatorname{atan2}", hypot: "\\operatorname{hypot}",
  sign: "\\operatorname{sign}",
  exp: "\\exponentialE^{#?}",
  abs: "\\left|#?\\right|",
  floor: "\\left\\lfloor#?\\right\\rfloor",
  ceil: "\\left\\lceil#?\\right\\rceil",
};

/** Typeset math field over source-text state; commit returns false to flag
 * an error (same contract as textEdit). */
export function mathEdit(get: () => string, commit: (s: string) => boolean,
                         tooltip = ""): Control {
  const wrap = el("div", { class: "math-edit" });
  const errText = el("div", { class: "error-text" });
  errText.hidden = true;

  // Fully working stand-in until MathLive arrives (first open only).
  const interim = textEdit(get, commit, "");
  wrap.append(interim.root);
  let refreshActive: () => void = () => interim.refresh?.();

  const attach = (m: Mathlive): void => {
    // never yank a field out from under a mid-edit
    if (document.activeElement === interim.root) {
      interim.root.addEventListener("blur", () => attach(m), { once: true });
      return;
    }
    const mf = new m.MathfieldElement();
    if (tooltip) mf.title = tooltip;

    let focused = false;
    let errored = false;           // conversion failed; keep user content
    let lastSrc: string | null = null; // source currently rendered
    let lastLatex = "";                // what we last wrote into the field

    const refresh = (): void => {
      if (focused || errored) return;
      const src = get();
      if (src === lastSrc) return;
      let latex: string;
      try {
        latex = sourceToLatex(src);
      } catch {
        // source left the math subset; the inspector rebuild swaps this
        // row to the text editor, so just leave the field as it is
        return;
      }
      lastSrc = src;
      lastLatex = latex;
      mf.setValue(latex, { silenceNotifications: true });
    };

    const commitNow = (): void => {
      const latex = mf.getValue();
      if (!errored && latex === lastLatex) return; // untouched
      try {
        const src = latexToSource(latex);
        errored = false;
        errText.hidden = true;
        mf.classList.toggle("error", !commit(src));
        lastSrc = null; // show the normalized form on the next refresh
      } catch (exc) {
        // not convertible (empty box, half-typed function...): flag it and
        // keep the user's content so they can fix it in place
        errored = true;
        mf.classList.add("error");
        errText.textContent = (exc as Error).message;
        errText.hidden = false;
      }
    };

    const revert = (): void => {
      errored = false;
      mf.classList.remove("error");
      errText.hidden = true;
      lastSrc = null;
      refresh();
      mf.blur(); // commitNow sees unchanged content and does nothing
    };

    mf.addEventListener("focus", () => { focused = true; });
    mf.addEventListener("blur", () => {
      focused = false;
      commitNow();
    });
    // Enter commits: both as the host keydown and as MathLive's "change"
    // event (fired on Return) — whichever arrives first blurs, and blur
    // does the actual commit, so the two paths cannot double-fire
    mf.addEventListener("change", () => mf.blur());
    mf.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        mf.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        revert();
      }
      e.stopPropagation(); // keep global shortcuts from firing while typing
    });

    wrap.replaceChildren(mf, errText);
    // options only work on a mounted field (the getters throw otherwise)
    mf.inlineShortcuts = { ...mf.inlineShortcuts, ...SHORTCUTS };
    mf.menuItems = []; // no context menu / hamburger in a one-line field
    // stay inside a superscript until the user arrows/clicks out — the
    // default hops out after a single digit, which reads as a glitch
    mf.smartSuperscript = false;
    refreshActive = refresh;
    refresh();
  };

  // .catch (not a rejection arg) so a throw inside attach lands here too;
  // on any failure the interim text input simply stays, fully usable
  loadMathlive().then(attach).catch((err) => {
    console.warn("math editor unavailable, using plain text:", err);
  });

  return { root: wrap, refresh: () => refreshActive() };
}
