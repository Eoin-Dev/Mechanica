/** Visual theme: the desktop app's dark palette, shared by canvas drawing
 * and (via CSS custom properties in style.css) the DOM chrome. */
import { Color } from "../engine/body";

export const BG: Color = [24, 26, 31];
export const PANEL: Color = [33, 36, 43];
export const PANEL_LIGHT: Color = [43, 47, 56];
export const PANEL_HOVER: Color = [52, 57, 68];
export const OUTLINE: Color = [58, 63, 74];
export const ACCENT: Color = [86, 156, 214];
export const ACCENT_HOT: Color = [120, 180, 235];
export const ACCENT_DARK: Color = [50, 90, 125];
export const TEXT: Color = [226, 229, 234];
export const TEXT_DIM: Color = [152, 158, 168];
export const TEXT_FAINT: Color = [105, 111, 122];
export const GOOD: Color = [120, 190, 120];
export const WARN: Color = [230, 200, 90];
export const BAD: Color = [230, 110, 110];
export const GRID: Color = [33, 36, 42];
export const GRID_MAJOR: Color = [44, 48, 56];
export const AXIS: Color = [66, 72, 84];
export const SELECTION: Color = [110, 180, 240];
export const VEL_COLOR: Color = [120, 210, 130];
export const ACC_COLOR: Color = [235, 170, 90];
export const FORCE_COLOR: Color = [235, 110, 110];

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
