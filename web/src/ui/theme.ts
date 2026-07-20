/** Visual theme shared by canvas drawing and (via CSS custom properties)
 * the DOM chrome.
 *
 * Three palettes: "dark" (neutral dark greys, the default), "light", and
 * "original" (the desktop app's blue-tinted dark palette). setTheme swaps
 * every exported binding in place - importers read them per draw, so the
 * next frame picks the new palette up - and mirrors the chrome colours
 * into CSS variables.
 */
import { Color } from "../engine/body";

export type ThemeName = "original" | "dark" | "light";

interface Palette {
  BG: Color; PANEL: Color; PANEL_LIGHT: Color; PANEL_HOVER: Color;
  OUTLINE: Color; ACCENT: Color; ACCENT_HOT: Color; ACCENT_DARK: Color;
  TEXT: Color; TEXT_DIM: Color; TEXT_FAINT: Color;
  GOOD: Color; WARN: Color; BAD: Color;
  GRID: Color; GRID_MAJOR: Color; AXIS: Color; SELECTION: Color;
  VEL_COLOR: Color; ACC_COLOR: Color; FORCE_COLOR: Color;
}

const ORIGINAL: Palette = {
  BG: [24, 26, 31], PANEL: [33, 36, 43], PANEL_LIGHT: [43, 47, 56],
  PANEL_HOVER: [52, 57, 68], OUTLINE: [58, 63, 74], ACCENT: [86, 156, 214],
  ACCENT_HOT: [120, 180, 235], ACCENT_DARK: [50, 90, 125],
  TEXT: [226, 229, 234], TEXT_DIM: [152, 158, 168], TEXT_FAINT: [105, 111, 122],
  GOOD: [120, 190, 120], WARN: [230, 200, 90], BAD: [230, 110, 110],
  GRID: [33, 36, 42], GRID_MAJOR: [44, 48, 56], AXIS: [66, 72, 84],
  SELECTION: [110, 180, 240], VEL_COLOR: [120, 210, 130],
  ACC_COLOR: [235, 170, 90], FORCE_COLOR: [235, 110, 110],
};

// Every surface/text grey is exactly neutral (equal RGB): no blue cast
// anywhere - only the accent and semantic colours carry hue.
const DARK: Palette = {
  BG: [18, 18, 18], PANEL: [28, 28, 28], PANEL_LIGHT: [38, 38, 38],
  PANEL_HOVER: [49, 49, 49], OUTLINE: [58, 58, 58], ACCENT: [92, 156, 214],
  ACCENT_HOT: [125, 180, 235], ACCENT_DARK: [52, 88, 122],
  TEXT: [229, 229, 229], TEXT_DIM: [156, 156, 156], TEXT_FAINT: [110, 110, 110],
  GRID: [27, 27, 27], GRID_MAJOR: [42, 42, 42], AXIS: [70, 70, 70],
  GOOD: [120, 190, 120], WARN: [230, 200, 90], BAD: [230, 110, 110],
  SELECTION: [110, 180, 240], VEL_COLOR: [120, 210, 130],
  ACC_COLOR: [235, 170, 90], FORCE_COLOR: [235, 110, 110],
};

const LIGHT: Palette = {
  BG: [246, 247, 249], PANEL: [255, 255, 255], PANEL_LIGHT: [240, 242, 245],
  PANEL_HOVER: [227, 230, 235], OUTLINE: [203, 208, 216], ACCENT: [35, 110, 180],
  ACCENT_HOT: [25, 95, 170], ACCENT_DARK: [200, 222, 242],
  TEXT: [28, 32, 38], TEXT_DIM: [96, 103, 113], TEXT_FAINT: [142, 148, 158],
  GOOD: [40, 145, 60], WARN: [185, 145, 15], BAD: [200, 55, 55],
  GRID: [233, 235, 239], GRID_MAJOR: [216, 219, 225], AXIS: [152, 158, 168],
  SELECTION: [25, 118, 210], VEL_COLOR: [25, 145, 60],
  ACC_COLOR: [205, 125, 25], FORCE_COLOR: [200, 55, 55],
};

const PALETTES: Record<ThemeName, Palette> = {
  original: ORIGINAL, dark: DARK, light: LIGHT,
};

// live bindings, swapped by setTheme; defaults match the "original"
// palette so nothing changes until the app applies a theme
export let BG = ORIGINAL.BG;
export let PANEL = ORIGINAL.PANEL;
export let PANEL_LIGHT = ORIGINAL.PANEL_LIGHT;
export let PANEL_HOVER = ORIGINAL.PANEL_HOVER;
export let OUTLINE = ORIGINAL.OUTLINE;
export let ACCENT = ORIGINAL.ACCENT;
export let ACCENT_HOT = ORIGINAL.ACCENT_HOT;
export let ACCENT_DARK = ORIGINAL.ACCENT_DARK;
export let TEXT = ORIGINAL.TEXT;
export let TEXT_DIM = ORIGINAL.TEXT_DIM;
export let TEXT_FAINT = ORIGINAL.TEXT_FAINT;
export let GOOD = ORIGINAL.GOOD;
export let WARN = ORIGINAL.WARN;
export let BAD = ORIGINAL.BAD;
export let GRID = ORIGINAL.GRID;
export let GRID_MAJOR = ORIGINAL.GRID_MAJOR;
export let AXIS = ORIGINAL.AXIS;
export let SELECTION = ORIGINAL.SELECTION;
export let VEL_COLOR = ORIGINAL.VEL_COLOR;
export let ACC_COLOR = ORIGINAL.ACC_COLOR;
export let FORCE_COLOR = ORIGINAL.FORCE_COLOR;

export let themeName: ThemeName = "original";

/** Parse "#rrggbb" into a Color (null on anything else). */
export function parseHex(hex: string): Color | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function toHex(c: Color): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** The accent a theme ships with (for the "theme default" swatch). */
export function defaultAccent(name: ThemeName): Color {
  return PALETTES[name].ACCENT;
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
export function setTheme(name: ThemeName): void {
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
  if (typeof document === "undefined") return; // node (tests)
  const s = document.documentElement.style;
  const set = (v: string, c: Color) => s.setProperty(v, css(c));
  set("--bg", BG); set("--panel", PANEL); set("--panel-light", PANEL_LIGHT);
  set("--panel-hover", PANEL_HOVER); set("--outline", OUTLINE);
  set("--accent", ACCENT); set("--accent-hot", ACCENT_HOT);
  set("--accent-dark", ACCENT_DARK); set("--text", TEXT);
  set("--text-dim", TEXT_DIM); set("--text-faint", TEXT_FAINT);
  set("--good", GOOD); set("--warn", WARN); set("--bad", BAD);
  set("--selection", SELECTION);
  document.documentElement.dataset.theme = name;
}

/** rgb()/rgba() string for canvas fill/stroke styles. */
export function css(c: Color, alpha = 1.0): string {
  return alpha >= 1.0
    ? `rgb(${c[0]},${c[1]},${c[2]})`
    : `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

export function lighten(c: Color, amount: number): Color {
  return [Math.min(255, c[0] + amount), Math.min(255, c[1] + amount),
          Math.min(255, c[2] + amount)];
}

export function scale(c: Color, f: number): Color {
  return [Math.floor(c[0] * f), Math.floor(c[1] * f), Math.floor(c[2] * f)];
}

/** Blend from BG toward `c` by fraction f (used for fading trails). */
export function towardBg(c: Color, f: number): Color {
  return [Math.floor(BG[0] + (c[0] - BG[0]) * f),
          Math.floor(BG[1] + (c[1] - BG[1]) * f),
          Math.floor(BG[2] + (c[2] - BG[2]) * f)];
}
