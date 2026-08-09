/** The keyboard focus ring survives the cascade.
 *
 * There is one `:focus-visible` rule that draws the ring for the whole app,
 * and it is a bare pseudo-class - specificity (0,1,0). Any rule that sets
 * `outline: none` with so much as one element or class in front of a `:focus`
 * outranks it and silently deletes the ring for everything it matches.
 *
 * That is exactly what `input:focus { outline: none }` did: (0,1,1) beats
 * (0,1,0), so every input in the app - checkbox, slider, text field, colour
 * well - had no keyboard cue at all, while buttons kept theirs because
 * nothing competed for them. Verified in the browser before the fix: a
 * focused checkbox computed `outline-style: none` where it now computes
 * `solid 2px`.
 *
 * A unit test cannot run the cascade, but it can hold the invariant that let
 * the bug in: an outline may only be suppressed for states that are NOT
 * keyboard focus. Anything else has to be an explicit, named exception.
 */
import { describe, expect, it } from "vitest";
import css from "../src/style.css?raw";
import { PHONE_QUERY } from "../src/ui/dom";

/** Declaration blocks that turn the outline off, with their selectors. */
function outlineSuppressors(): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  // strip comments so a commented-out rule is not mistaken for a live one
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(clean)) !== null) {
    const selector = m[1].trim();
    const body = m[2];
    if (/outline\s*:\s*(none|0)\b/.test(body)) out.push({ selector, body });
  }
  return out;
}

/** Selectors allowed to kill the ring outright, and why. */
const EXCEPTIONS: Array<[pattern: RegExp, why: string]> = [
  [/^\.overlay-panel:focus-visible,\s*\.overlay-panel:focus$/,
    "a modal takes focus itself; a ring round the whole dialog is noise"],
];

describe("focus ring cascade", () => {
  it("suppresses the outline only for non-keyboard focus", () => {
    const offenders: string[] = [];
    for (const { selector } of outlineSuppressors()) {
      if (EXCEPTIONS.some(([re]) => re.test(selector))) continue;
      // A rule may only remove the outline if it excludes keyboard focus.
      // Rules that never mention focus at all are resetting a default (e.g.
      // a custom-styled element's own chrome) and are fine.
      const touchesFocus = /:focus\b|:focus-visible\b|:focus-within\b/.test(selector);
      const excludesKeyboard = /:not\(\s*:focus-visible\s*\)/.test(selector);
      if (touchesFocus && !excludesKeyboard) {
        offenders.push(selector);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("draws the ring itself in exactly one place", () => {
    // One rule owns the ring's colour and width, so there is a single thing
    // to change and a single thing that can be outranked. (The tour's
    // spotlight outline is not a focus ring and is not in scope.)
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rings = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => /outline\s*:\s*\d/.test(m[2]))
      .map((m) => m[1].trim())
      .filter((sel) => /:focus/.test(sel));
    expect(rings).toEqual([":focus-visible"]);
  });

  it("keeps the input border tint, which is the cue while typing", () => {
    // dropping this alongside the outline fix would leave text fields with
    // no indication at all during mouse-driven editing
    expect(css).toMatch(/input:focus\s*\{[^}]*border-color:\s*var\(--focus\)/);
  });

  it("tightens the ring on the controls that sit flush against neighbours", () => {
    // a 2px offset on a 14px checkbox overlaps its own label text
    for (const sel of ["label.checkbox input:focus-visible",
                       'input[type="range"]:focus-visible']) {
      expect(css).toContain(sel);
    }
  });
});

/** The mobile breakpoint is declared in two languages and must agree.
 *
 * `PHONE_QUERY` in ui/dom.ts decides BEHAVIOUR - whether the Inspector
 * becomes a slide-over drawer and whether the toolbar trims itself - while
 * the stylesheet decides what that state LOOKS like. They are the same
 * threshold written twice, in two files, with nothing connecting them.
 *
 * Changing one alone opens a band of viewport widths where the app is in
 * drawer mode but is not styled as a drawer (or the reverse): the panel
 * would be positioned as a fixed overlay with no width rule, or laid out
 * inline while the code believes it is hidden. It fails silently, only
 * between two specific widths, which is exactly the kind of thing nobody
 * finds by clicking around on a desktop.
 */
describe("the mobile breakpoint", () => {
  it("is the same width in the stylesheet as in the code", () => {
    const inCode = /\(max-width:\s*(\d+)px\)/.exec(PHONE_QUERY);
    expect(inCode, "PHONE_QUERY should be a max-width query").not.toBeNull();
    const px = inCode![1];
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const queries = [...clean.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)]
      .map((m) => m[1]);
    expect(queries, `no @media (max-width: ${px}px) block in style.css`)
      .toContain(px);
  });

  it("styles the inspector as a drawer inside that block", () => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const px = /\(max-width:\s*(\d+)px\)/.exec(PHONE_QUERY)![1];
    const at = clean.indexOf(`@media (max-width: ${px}px)`);
    expect(at).toBeGreaterThanOrEqual(0);
    // the drawer rules live in that block; take a generous slice of it
    const block = clean.slice(at, at + 2000);
    expect(block).toMatch(/#inspector/);
  });
});
