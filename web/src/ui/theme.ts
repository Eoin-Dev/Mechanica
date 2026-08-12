/** Visual theme shared by canvas drawing and (via CSS custom properties)
 * the DOM chrome.
 *
 * Four palettes: "dark" (neutral dark greys, the default), "void", "light",
 * and "studio" (quiet modern productivity chrome). setTheme swaps
 * every exported binding in place - importers read them per draw, so the
 * next frame picks the new palette up - and mirrors the chrome colours
 * into CSS variables.
 */
import { Color } from "../engine/body";

export type ThemeName = "dark" | "void" | "light" | "studio";

interface Palette {
  BG: Color; PANEL: Color; PANEL_LIGHT: Color; PANEL_HOVER: Color;
  OUTLINE: Color; ACCENT: Color; ACCENT_HOT: Color; ACCENT_DARK: Color;
  TEXT: Color; TEXT_DIM: Color; TEXT_FAINT: Color;
  GOOD: Color; WARN: Color; BAD: Color;
  GRID: Color; GRID_MAJOR: Color; AXIS: Color; SELECTION: Color;
  VEL_COLOR: Color; ACC_COLOR: Color; FORCE_COLOR: Color;
}

// Every surface/text grey is exactly neutral (equal RGB): no blue cast
// anywhere - only the accent and semantic colours carry hue.
const DARK: Palette = {
  BG: [18, 18, 18], PANEL: [28, 28, 28], PANEL_LIGHT: [38, 38, 38],
  PANEL_HOVER: [49, 49, 49], OUTLINE: [58, 58, 58], ACCENT: [92, 156, 214],
  ACCENT_HOT: [125, 180, 235], ACCENT_DARK: [52, 88, 122],
  TEXT: [229, 229, 229], TEXT_DIM: [156, 156, 156], TEXT_FAINT: [145, 145, 145],
  GRID: [27, 27, 27], GRID_MAJOR: [42, 42, 42], AXIS: [70, 70, 70],
  GOOD: [120, 190, 120], WARN: [230, 200, 90], BAD: [230, 110, 110],
  SELECTION: [110, 180, 240], VEL_COLOR: [120, 210, 130],
  ACC_COLOR: [235, 170, 90], FORCE_COLOR: [235, 110, 110],
};

// Void: dark taken further - near-black surfaces and hard, unmixed greys.
// Text stays bright and outlines stay visible so the contrast reads as
// deliberate rather than murky.
const VOID: Palette = {
  BG: [8, 8, 8], PANEL: [16, 16, 16], PANEL_LIGHT: [25, 25, 25],
  PANEL_HOVER: [36, 36, 36], OUTLINE: [48, 48, 48], ACCENT: [92, 156, 214],
  ACCENT_HOT: [130, 185, 240], ACCENT_DARK: [40, 72, 102],
  TEXT: [238, 238, 238], TEXT_DIM: [152, 152, 152], TEXT_FAINT: [137, 137, 137],
  GRID: [17, 17, 17], GRID_MAJOR: [32, 32, 32], AXIS: [64, 64, 64],
  GOOD: [110, 195, 110], WARN: [235, 200, 80], BAD: [235, 95, 95],
  SELECTION: [120, 190, 245], VEL_COLOR: [110, 215, 125],
  ACC_COLOR: [240, 170, 80], FORCE_COLOR: [235, 95, 95],
};

const LIGHT: Palette = {
  BG: [246, 247, 249], PANEL: [255, 255, 255], PANEL_LIGHT: [240, 242, 245],
  PANEL_HOVER: [227, 230, 235], OUTLINE: [203, 208, 216], ACCENT: [35, 110, 180],
  ACCENT_HOT: [25, 95, 170], ACCENT_DARK: [200, 222, 242],
  TEXT: [28, 32, 38], TEXT_DIM: [96, 103, 113], TEXT_FAINT: [105, 111, 120],
  GOOD: [40, 145, 60], WARN: [185, 145, 15], BAD: [200, 55, 55],
  GRID: [233, 235, 239], GRID_MAJOR: [216, 219, 225], AXIS: [152, 158, 168],
  SELECTION: [25, 118, 210], VEL_COLOR: [25, 145, 60],
  ACC_COLOR: [205, 125, 25], FORCE_COLOR: [200, 55, 55],
};

// Studio: a quiet, tool-first workspace. Near-neutral layered surfaces,
// low-contrast dividers and restrained monochrome selection states follow the
// modern desktop productivity language without borrowing product branding.
// Physics vectors retain semantic hues so the simulator remains legible.
const STUDIO: Palette = {
  BG: [20, 20, 20], PANEL: [29, 29, 29], PANEL_LIGHT: [41, 41, 41],
  PANEL_HOVER: [52, 52, 52], OUTLINE: [53, 53, 53], ACCENT: [205, 205, 205],
  ACCENT_HOT: [235, 235, 235], ACCENT_DARK: [58, 58, 58],
  TEXT: [235, 235, 235], TEXT_DIM: [171, 171, 171], TEXT_FAINT: [151, 151, 151],
  GOOD: [117, 190, 130], WARN: [226, 190, 92], BAD: [226, 108, 108],
  GRID: [28, 28, 28], GRID_MAJOR: [39, 39, 39], AXIS: [66, 66, 66],
  SELECTION: [215, 215, 215], VEL_COLOR: [120, 210, 130],
  ACC_COLOR: [235, 170, 90], FORCE_COLOR: [235, 110, 110],
};

const PALETTES: Record<ThemeName, Palette> = {
  dark: DARK, void: VOID, light: LIGHT, studio: STUDIO,
};

export const THEME_NAMES = Object.keys(PALETTES) as ThemeName[];

/** The theme this name refers to, or the default when it names none.
 *
 * The name arrives from persisted settings, so it can be anything a past or
 * future build of the app wrote there - and an unknown one used to index
 * PALETTES to `undefined` and throw on the first field read. That happens
 * inside the App constructor, before anything is on screen and on EVERY
 * reload, so a single stale value left the app a permanently blank page
 * with no route back except clearing browser storage by hand. */
export function asThemeName(name: unknown): ThemeName {
  // hasOwn, not `in`: `in` walks the prototype chain, so "toString" and
  // "constructor" would both pass as theme names and index PALETTES to a
  // function, whose .BG is undefined - the very crash this guards against.
  return typeof name === "string" && Object.hasOwn(PALETTES, name)
    ? (name as ThemeName) : "dark";
}

// live bindings, swapped by setTheme; pre-bootstrap defaults match Dark.
export let BG = DARK.BG;
export let PANEL = DARK.PANEL;
export let PANEL_LIGHT = DARK.PANEL_LIGHT;
export let PANEL_HOVER = DARK.PANEL_HOVER;
export let OUTLINE = DARK.OUTLINE;
export let ACCENT = DARK.ACCENT;
export let ACCENT_HOT = DARK.ACCENT_HOT;
export let ACCENT_DARK = DARK.ACCENT_DARK;
/** Accent-derived colours reserved for small text and keyboard focus. They
 * are adjusted toward black or white when a custom accent would disappear
 * against the current surfaces. */
export let ACCENT_TEXT = DARK.ACCENT;
export let FOCUS = DARK.ACCENT;
export let ACCENT_INK: Color = [0, 0, 0];
export let ACCENT_DARK_INK: Color = [255, 255, 255];
export let TEXT = DARK.TEXT;
export let TEXT_DIM = DARK.TEXT_DIM;
export let TEXT_FAINT = DARK.TEXT_FAINT;
export let GOOD = DARK.GOOD;
export let WARN = DARK.WARN;
export let BAD = DARK.BAD;
export let GRID = DARK.GRID;
export let GRID_MAJOR = DARK.GRID_MAJOR;
export let AXIS = DARK.AXIS;
export let SELECTION = DARK.SELECTION;
export let VEL_COLOR = DARK.VEL_COLOR;
export let ACC_COLOR = DARK.ACC_COLOR;
export let FORCE_COLOR = DARK.FORCE_COLOR;

export let themeName: ThemeName = "dark";
/** Monotonic palette identity for retained Canvas consumers. */
export let paletteRevision = 0;

/** Parse "#rrggbb" into a Color (null on anything else). */
export function parseHex(hex: string): Color | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** The accent a theme ships with (for the "theme default" swatch). */
export function defaultAccent(name: ThemeName): Color {
  return PALETTES[asThemeName(name)].ACCENT;
}

/** WCAG relative luminance and contrast, exported so the palette matrix can
 * be verified without depending on browser-computed styles. */
export function relativeLuminance(c: Color): number {
  const linear = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
}

export function contrastRatio(a: Color, b: Color): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(a: Color, b: Color, f: number): Color {
  return [Math.round(a[0] + (b[0] - a[0]) * f),
          Math.round(a[1] + (b[1] - a[1]) * f),
          Math.round(a[2] + (b[2] - a[2]) * f)];
}

/** Preserve the chosen hue as far as possible, then move it only as far as
 * needed toward the contrast direction that works across every surface. */
function contrastSafe(base: Color, surfaces: readonly Color[], minimum: number): Color {
  const score = (c: Color): number =>
    Math.min(...surfaces.map((surface) => contrastRatio(c, surface)));
  if (score(base) >= minimum) return [...base] as Color;
  const black: Color = [0, 0, 0];
  const white: Color = [255, 255, 255];
  for (let i = 1; i <= 100; i++) {
    const f = i / 100;
    const dark = mix(base, black, f);
    const light = mix(base, white, f);
    const darkScore = score(dark);
    const lightScore = score(light);
    if (darkScore >= minimum || lightScore >= minimum) {
      if (darkScore >= minimum && lightScore >= minimum) {
        return darkScore >= lightScore ? dark : light;
      }
      return darkScore >= minimum ? dark : light;
    }
  }
  return score(black) >= score(white) ? black : white;
}

/** Black or white, whichever remains clearest on one filled control surface. */
function surfaceInk(surface: Color): Color {
  const black: Color = [0, 0, 0];
  const white: Color = [255, 255, 255];
  return contrastRatio(black, surface) >= contrastRatio(white, surface)
    ? black : white;
}

// user accent override (settings): null = the theme's own accent
let accentOverride: Color | null = null;

/** Override the UI accent colour (hex, or null to restore the theme's
 * default). Applies to chrome and highlights only - physics object
 * colours are untouched. */
export function setAccent(hex: string | null): void {
  accentOverride = hex === null ? null : parseHex(hex);
  setTheme(themeName);
}

/** Swap the active palette and mirror it into the DOM's CSS variables. */
export function setTheme(requested: ThemeName): void {
  const name = asThemeName(requested);
  const p = PALETTES[name];
  themeName = name;
  BG = p.BG; PANEL = p.PANEL; PANEL_LIGHT = p.PANEL_LIGHT;
  PANEL_HOVER = p.PANEL_HOVER; OUTLINE = p.OUTLINE; ACCENT = p.ACCENT;
  ACCENT_HOT = p.ACCENT_HOT; ACCENT_DARK = p.ACCENT_DARK; TEXT = p.TEXT;
  TEXT_DIM = p.TEXT_DIM; TEXT_FAINT = p.TEXT_FAINT; GOOD = p.GOOD;
  WARN = p.WARN; BAD = p.BAD; GRID = p.GRID; GRID_MAJOR = p.GRID_MAJOR;
  AXIS = p.AXIS; SELECTION = p.SELECTION; VEL_COLOR = p.VEL_COLOR;
  ACC_COLOR = p.ACC_COLOR; FORCE_COLOR = p.FORCE_COLOR;
  if (accentOverride !== null) {
    const a = accentOverride;
    ACCENT = a;
    ACCENT_HOT = lighten(a, 30);
    // active/pressed shade: light themes tint toward white, dark toward black
    ACCENT_DARK = name === "light"
      ? [Math.round(a[0] + (255 - a[0]) * 0.75),
         Math.round(a[1] + (255 - a[1]) * 0.75),
         Math.round(a[2] + (255 - a[2]) * 0.75)]
      : scale(a, 0.58);
    SELECTION = lighten(a, 25); // the canvas highlight follows the accent
  }
  ACCENT_TEXT = contrastSafe(ACCENT, [PANEL, PANEL_LIGHT], 4.5);
  FOCUS = contrastSafe(ACCENT, [BG, PANEL, PANEL_LIGHT, PANEL_HOVER], 3.0);
  ACCENT_INK = surfaceInk(ACCENT);
  ACCENT_DARK_INK = surfaceInk(ACCENT_DARK);
  paletteRevision++;
  if (typeof document === "undefined") return; // node (tests)
  const s = document.documentElement.style;
  const set = (v: string, c: Color) => s.setProperty(v, css(c));
  set("--bg", BG); set("--panel", PANEL); set("--panel-light", PANEL_LIGHT);
  set("--panel-hover", PANEL_HOVER); set("--outline", OUTLINE);
  set("--accent", ACCENT); set("--accent-hot", ACCENT_HOT);
  set("--accent-dark", ACCENT_DARK); set("--accent-text", ACCENT_TEXT);
  set("--focus", FOCUS); set("--accent-ink", ACCENT_INK);
  set("--accent-dark-ink", ACCENT_DARK_INK); set("--text", TEXT);
  set("--text-dim", TEXT_DIM); set("--text-faint", TEXT_FAINT);
  set("--good", GOOD); set("--warn", WARN); set("--bad", BAD);
  set("--selection", SELECTION);
  // Translucent shades of the warning colour, for the "a mode is overriding
  // your settings" banner. Alpha rather than a pre-mixed opaque colour so the
  // banner sits correctly on whichever panel shade is behind it.
  s.setProperty("--warn-soft", `rgba(${WARN[0]}, ${WARN[1]}, ${WARN[2]}, 0.13)`);
  s.setProperty("--warn-edge", `rgba(${WARN[0]}, ${WARN[1]}, ${WARN[2]}, 0.4)`);
  document.documentElement.dataset.theme = name;
}

// Opaque colours memoised by their packed 24-bit value. The renderer asks
// for the same handful of strings several times per body per frame - fill,
// edge, ring, marker, label - and building each one from a template
// literal was a fresh string allocation every time. Scenes use a small
// palette, so the table stays tiny; it is capped anyway in case a scene
// generates colours procedurally.
const CSS_CACHE = new Map<number, string>();
const CSS_CACHE_MAX = 4096;

/** rgb()/rgba() string for canvas fill/stroke styles. */
export function css(c: Color, alpha = 1.0): string {
  if (alpha < 1.0) return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  const r = c[0];
  const g = c[1];
  const b = c[2];
  // the packed key is only faithful for whole 0-255 channels; anything
  // else (a hand-built colour, a fractional blend) is built as before so
  // two different colours can never share a cache entry
  if (!((r | 0) === r && (g | 0) === g && (b | 0) === b &&
        r >= 0 && r < 256 && g >= 0 && g < 256 && b >= 0 && b < 256)) {
    return `rgb(${r},${g},${b})`;
  }
  const key = (r << 16) | (g << 8) | b;
  let s = CSS_CACHE.get(key);
  if (s === undefined) {
    s = `rgb(${c[0]},${c[1]},${c[2]})`;
    if (CSS_CACHE.size >= CSS_CACHE_MAX) CSS_CACHE.clear();
    CSS_CACHE.set(key, s);
  }
  return s;
}

export function lighten(c: Color, amount: number): Color {
  return [Math.min(255, c[0] + amount), Math.min(255, c[1] + amount),
          Math.min(255, c[2] + amount)];
}

export function scale(c: Color, f: number): Color {
  return [Math.floor(c[0] * f), Math.floor(c[1] * f), Math.floor(c[2] * f)];
}
