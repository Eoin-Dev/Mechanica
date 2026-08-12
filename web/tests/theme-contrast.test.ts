import { afterEach, describe, expect, it } from "vitest";
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
    expect(css).toMatch(/\[data-studio="true"\] button\s*\{[^}]*border-color:\s*var\(--outline\)/s);
    expect(css).toMatch(/\[data-studio="true"\] \.tool-btn\.active[^}]*inset 3px 0 var\(--accent\)/s);
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

  it("derives safe text, filled-control ink and focus colours from custom accents", () => {
    for (const name of theme.THEME_NAMES) {
      theme.setTheme(name);
      for (const accent of ["#000000", "#ffffff", "#777777", "#ff00ff"]) {
        theme.setAccent(accent);
        for (const surface of [theme.PANEL, theme.PANEL_LIGHT]) {
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
