import { afterEach, describe, expect, it } from "vitest";
import type { Color } from "../src/engine/body";
import * as theme from "../src/ui/theme";
import css from "../src/style.css?raw";

afterEach(() => {
  theme.setAccent(null);
  theme.setTheme("dark");
});

describe("theme contrast invariants", () => {
  it("layers Studio styling over the three base palettes", () => {
    expect(theme.THEME_NAMES).toEqual(["dark", "void", "light"]);
    expect(theme.THEME_NAMES).not.toContain("original");
    expect(css).toContain(':root[data-studio="true"]');
    expect(css).not.toContain(':root[data-theme="studio"]');
  });

  it("keeps the actual Studio selected-control colours readable", () => {
    const selectors = [".tool-btn.active", ".segmented button.active", ".tabs button.active"];
    for (const name of theme.THEME_NAMES) for (const accent of [null, "#000000", "#ffffff", "#ff00ff"]) {
      theme.setTheme(name); theme.setAccent(accent);
      const values: Record<string, Color> = {
        "accent-text": theme.ACCENT_TEXT, "accent-dark-ink": theme.ACCENT_DARK_INK,
        "text": theme.TEXT, "panel": theme.PANEL, "panel-light": theme.PANEL_LIGHT,
        "accent-dark": theme.ACCENT_DARK,
      };
      for (const selector of selectors) {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const block = new RegExp(`\\[data-studio="true"\\] ${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
        expect(block, selector).toBeDefined();
        const foreground = /(?:^|;)\s*color:\s*var\(--([\w-]+)\)/.exec(block!)?.[1];
        const background = /(?:^|;)\s*background:\s*var\(--([\w-]+)\)/.exec(block!)?.[1];
        expect(values[foreground!], selector).toBeDefined();
        expect(values[background!], selector).toBeDefined();
        expect(theme.contrastRatio(values[foreground!], values[background!]), `${name} ${accent} ${selector}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps faint normal text readable on both panel surfaces", () => {
    for (const name of theme.THEME_NAMES) {
      theme.setAccent(null);
      theme.setTheme(name);
      expect(theme.contrastRatio(theme.TEXT_FAINT, theme.PANEL), name)
        .toBeGreaterThanOrEqual(4.5);
      expect(theme.contrastRatio(theme.TEXT_FAINT, theme.PANEL_LIGHT), name)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it("makes Light controls, axes and motion vectors distinguishable from their surfaces", () => {
    theme.setTheme("light");
    for (const surface of [theme.PANEL, theme.PANEL_LIGHT, theme.PANEL_HOVER]) {
      expect(theme.contrastRatio(theme.OUTLINE, surface)).toBeGreaterThanOrEqual(3);
      for (const text of [theme.TEXT, theme.TEXT_DIM, theme.TEXT_FAINT])
        expect(theme.contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5);
    }
    for (const ink of [theme.AXIS, theme.VEL_COLOR, theme.ACC_COLOR, theme.FORCE_COLOR])
      expect(theme.contrastRatio(ink, theme.BG)).toBeGreaterThanOrEqual(3);
  });

  it("keeps the selected-object cue visible with extreme custom accents", () => {
    for (const name of theme.THEME_NAMES) for (const accent of ["#000000", "#ffffff"]) {
      theme.setTheme(name); theme.setAccent(accent);
      for (const surface of [theme.BG, theme.PANEL])
        expect(theme.contrastRatio(theme.SELECTION, surface), `${name} ${accent}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("derives safe text, filled-control ink and focus colours from custom accents", () => {
    for (const name of theme.THEME_NAMES) {
      theme.setTheme(name);
      for (const accent of ["#000000", "#ffffff", "#777777", "#ff00ff"]) {
        theme.setAccent(accent);
        const tint = (surface: Color, weight: number): Color => [
          Math.round(theme.ACCENT[0] * weight + surface[0] * (1 - weight)),
          Math.round(theme.ACCENT[1] * weight + surface[1] * (1 - weight)),
          Math.round(theme.ACCENT[2] * weight + surface[2] * (1 - weight)),
        ];
        for (const surface of [theme.BG, theme.PANEL, theme.PANEL_LIGHT, theme.PANEL_HOVER,
          tint(theme.PANEL_LIGHT, 0.14), tint(theme.PANEL_HOVER, 0.08)]) {
          expect(theme.contrastRatio(theme.ACCENT_TEXT, surface), `${name} ${accent} text`)
            .toBeGreaterThanOrEqual(4.5);
        }
        for (const surface of [theme.BG, theme.PANEL, theme.PANEL_LIGHT,
                               theme.PANEL_HOVER]) {
          expect(theme.contrastRatio(theme.FOCUS, surface), `${name} ${accent} focus`)
            .toBeGreaterThanOrEqual(3);
        }
        expect(theme.contrastRatio(theme.ACCENT_INK, theme.ACCENT),
               `${name} ${accent} ink`).toBeGreaterThanOrEqual(4.5);
        expect(theme.contrastRatio(theme.ACCENT_DARK_INK, theme.ACCENT_DARK),
               `${name} ${accent} dark ink`).toBeGreaterThanOrEqual(4.5);
        for (const surface of [theme.PANEL_LIGHT, theme.PANEL_HOVER]) {
          expect(theme.contrastRatio(theme.TEXT, surface),
                 `${name} ${accent} ordinary button ink`)
            .toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("wires safe ink and an inset focus cue to the surfaces controls draw", () => {
    expect(css).toMatch(/button\.primary\s*\{[^}]*background:\s*var\(--accent-dark\)[^}]*color:\s*var\(--accent-dark-ink\)/s);
    expect(css).toMatch(/button\.primary:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--accent\)[^}]*color:\s*var\(--accent-ink\)/s);
    expect(css).toMatch(/button\.active\s*\{[^}]*background:\s*var\(--accent-dark\)[^}]*color:\s*var\(--accent-dark-ink\)/s);
    expect(css).toMatch(/\.segmented button\.active\s*\{[^}]*background:\s*var\(--accent-dark\)[^}]*color:\s*var\(--accent-dark-ink\)/s);
    expect(css).toMatch(/button:focus-visible\s*\{[^}]*box-shadow:\s*inset[^}]*currentColor/s);
  });
});
