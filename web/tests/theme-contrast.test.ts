import { afterEach, describe, expect, it } from "vitest";
import * as theme from "../src/ui/theme";

afterEach(() => {
  theme.setAccent(null);
  theme.setTheme("original");
});

describe("theme contrast invariants", () => {
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

  it("derives safe text and focus colours from extreme custom accents", () => {
    for (const name of theme.THEME_NAMES) {
      theme.setTheme(name);
      for (const accent of ["#000000", "#ffffff", "#777777"]) {
        theme.setAccent(accent);
        for (const surface of [theme.PANEL, theme.PANEL_LIGHT]) {
          expect(theme.contrastRatio(theme.ACCENT_TEXT, surface), `${name} ${accent} text`)
            .toBeGreaterThanOrEqual(4.5);
        }
        for (const surface of [theme.BG, theme.PANEL, theme.PANEL_LIGHT]) {
          expect(theme.contrastRatio(theme.FOCUS, surface), `${name} ${accent} focus`)
            .toBeGreaterThanOrEqual(3);
        }
        expect(theme.contrastRatio(theme.ACCENT_INK, theme.ACCENT),
               `${name} ${accent} ink`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
