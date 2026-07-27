/** Persisted preferences are validated before anything reads them.
 *
 * Settings are the most dangerous thing this app stores. A scene is loaded
 * on demand and a bad one can simply be abandoned; settings are read in the
 * App constructor on EVERY load, before a single pixel is drawn. So a value
 * this build cannot use is not a bad session - it is a blank page on every
 * reload, with no route back from inside the app, because the value that
 * causes it is exactly the value that survives the reload.
 *
 * Two fields could do that outright before this guard existed:
 *
 *   - `theme`: an unknown name indexed the palette table to `undefined` and
 *     threw on the first field read, inside `applyUiSettings`. Renaming or
 *     removing a theme in a future version is enough to cause it - no
 *     corruption or attacker required.
 *   - `custom_accents`: anything not iterable threw when the settings panel
 *     looped over it to build the swatches.
 *
 * `font_scale` is the quieter version of the same problem: it multiplies
 * every size in the stylesheet, so an out-of-range value does not crash but
 * does make the app unreadable - and persists, so reloading cannot undo it.
 */
import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "../src/app";
import { THEME_NAMES, setTheme } from "../src/ui/theme";

describe("sanitizeSettings", () => {
  it("returns empty defaults for anything that is not a plain object", () => {
    for (const bad of [null, undefined, 42, "x", true, [], [1, 2]]) {
      expect(sanitizeSettings(bad)).toEqual({});
    }
  });

  it("drops a theme this build does not have", () => {
    // the crash: PALETTES["midnight"] is undefined, and setTheme reads .BG
    expect(sanitizeSettings({ theme: "midnight" }).theme).toBeUndefined();
    expect(sanitizeSettings({ theme: 7 }).theme).toBeUndefined();
    expect(sanitizeSettings({ theme: null }).theme).toBeUndefined();
  });

  it("keeps every theme this build does have", () => {
    for (const name of THEME_NAMES) {
      expect(sanitizeSettings({ theme: name }).theme).toBe(name);
    }
  });

  it("setTheme survives a name that is not a theme at all", () => {
    // belt and braces: the guard above stops the value being stored, and
    // this stops it mattering if one ever reaches setTheme by another route
    expect(() => setTheme("midnight" as never)).not.toThrow();
    setTheme("dark");
  });

  it("does not mistake an inherited property for a theme", () => {
    // `name in PALETTES` walks the prototype chain, so "toString" and
    // "constructor" pass it and then index the table to a FUNCTION, whose
    // .BG is undefined - reintroducing the exact crash being guarded
    // against. The membership test has to be an own-property one.
    for (const inherited of ["toString", "constructor", "valueOf",
                             "hasOwnProperty", "__proto__"]) {
      expect(sanitizeSettings({ theme: inherited }).theme).toBeUndefined();
      expect(() => setTheme(inherited as never)).not.toThrow();
    }
    setTheme("dark");
  });

  it("keeps only well-formed hex accents", () => {
    expect(sanitizeSettings({ accent: "#8b5cf6" }).accent).toBe("#8b5cf6");
    for (const bad of ["red", "#fff", "#8b5cf", "", 0, null,
                       "#8b5cf6;position:fixed"]) {
      expect(sanitizeSettings({ accent: bad }).accent).toBeUndefined();
    }
  });

  it("makes custom_accents a list of hex colours or nothing", () => {
    expect(sanitizeSettings({ custom_accents: "abc" }).custom_accents)
      .toBeUndefined();
    expect(sanitizeSettings({ custom_accents: 5 }).custom_accents)
      .toBeUndefined();
    expect(sanitizeSettings({ custom_accents: ["#112233", "nope", 7] })
      .custom_accents).toEqual(["#112233"]);
    // the panel keeps the last six; a file claiming more cannot grow the row
    const many = Array.from({ length: 40 }, () => "#112233");
    expect(sanitizeSettings({ custom_accents: many }).custom_accents)
      .toHaveLength(6);
  });

  it("clamps the font scale to the range the panel offers", () => {
    expect(sanitizeSettings({ font_scale: 1.1 }).font_scale).toBe(1.1);
    expect(sanitizeSettings({ font_scale: 40 }).font_scale).toBe(1.2);
    expect(sanitizeSettings({ font_scale: 0 }).font_scale).toBe(0.9);
    expect(sanitizeSettings({ font_scale: NaN }).font_scale).toBeUndefined();
    expect(sanitizeSettings({ font_scale: "big" }).font_scale).toBeUndefined();
  });

  it("clamps pane sizes so a stale one cannot hide the canvas", () => {
    expect(sanitizeSettings({ inspector_w: 1e9 }).inspector_w).toBe(1200);
    expect(sanitizeSettings({ inspector_w: -5 }).inspector_w).toBe(240);
    expect(sanitizeSettings({ dock_h: 1e9 }).dock_h).toBe(1200);
    expect(sanitizeSettings({ dock_h: 0 }).dock_h).toBe(80);
    expect(sanitizeSettings({ inspector_w: "wide" }).inspector_w).toBeUndefined();
  });

  it("takes booleans only, so a truthy string cannot flip a mode on", () => {
    expect(sanitizeSettings({ perf_mode: true }).perf_mode).toBe(true);
    expect(sanitizeSettings({ perf_mode: false }).perf_mode).toBe(false);
    expect(sanitizeSettings({ perf_mode: "yes" }).perf_mode).toBeUndefined();
    expect(sanitizeSettings({ cull: 1 }).cull).toBeUndefined();
  });

  it("ignores fields it does not know about", () => {
    expect(sanitizeSettings({ evil: "x", __proto__: { polluted: true } }))
      .toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("round-trips a full, valid settings object unchanged", () => {
    const full = {
      adaptive_dt: true, inspector_visible: false, inspector_w: 320,
      dock_h: 200, tour_done: true, theme: "light", dyslexic_font: false,
      cull: true, perf_mode: false, drag_hits_walls: true,
      accent: "#24427c", custom_accents: ["#b81f1f"], font_scale: 1.1,
    };
    expect(sanitizeSettings(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });
});
