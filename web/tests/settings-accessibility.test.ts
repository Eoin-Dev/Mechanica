/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { SettingsPanel } from "../src/ui/overlays";

function appStub(): App {
  const app = {
    settings: {},
    dragHitsWalls: false,
    perfMode: false,
    adaptiveDt: true,
    saveSettings() {},
    applyUiSettings() {},
    setDragHitsWalls(value: boolean) { this.dragHitsWalls = value; },
    setPerfMode(value: boolean) { this.perfMode = value; },
    setAdaptiveDt(value: boolean) { this.adaptiveDt = value; },
  };
  return app as unknown as App;
}

describe("accent swatch semantics", () => {
  it("exposes selection and preserves keyboard focus across rerenders", () => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const settings = new SettingsPanel(appStub(), root, () => {}, () => {});
    settings.open();
    const chosen = root.querySelector<HTMLButtonElement>(
      '[data-accent-choice="#8b5cf6"]')!;
    chosen.focus();
    chosen.click();

    const replacement = root.querySelector<HTMLButtonElement>(
      '[data-accent-choice="#8b5cf6"]')!;
    expect(replacement).not.toBe(chosen);
    expect(replacement.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(replacement);
  });
});
