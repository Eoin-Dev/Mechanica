/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import css from "../src/style.css?raw";
import * as snap from "../src/scene/snapshot";
import { Help, Library, SettingsPanel } from "../src/ui/overlays";

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

  it("keeps accent choices full-bleed and circular in every appearance", () => {
    expect(css).toMatch(
      /button\.swatch\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*padding:\s*0;[^}]*border-radius:\s*50%/s);
    expect(css).toMatch(
      /\.swatch \.dot\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*border-radius:\s*50%/s);
    expect(css).toMatch(/button\.swatch-add\s*\{[^}]*border-radius:\s*50%/s);
    expect(css).toMatch(
      /\[data-studio="true"\] button\.swatch,[\s\S]*?\[data-studio="true"\] button\.swatch-add\s*\{[^}]*border-radius:\s*50%/s);
    expect(css).toMatch(/\.swatch-remove\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px/s);
  });
});

describe("appearance choices", () => {
  it("offers three base themes with Studio as a following toggle", () => {
    const app = appStub();
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const settings = new SettingsPanel(app, root, () => {}, () => {});
    settings.open();

    const themeGroup = root.querySelector<HTMLElement>(
      '.settings-group:first-child .segmented')!;
    const choices = [...themeGroup.querySelectorAll<HTMLButtonElement>("button")];
    expect(choices.map((choice) => choice.textContent)).toEqual(
      ["Void", "Dark", "Light"]);
    expect(root.textContent).not.toContain("Original");

    choices[2].click();
    expect(app.settings.theme).toBe("light");

    const studioLabel = [...root.querySelectorAll<HTMLLabelElement>("label.checkbox")]
      .find((candidate) => candidate.textContent?.includes("Studio mode"))!;
    const studioToggle = studioLabel.querySelector<HTMLInputElement>(
      'input[type="checkbox"]')!;
    expect(themeGroup.compareDocumentPosition(studioLabel) &
      Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    studioToggle.click();
    expect(app.settings.studio_mode).toBe(true);
  });
});

describe("built-in preset cards", () => {
  it("uses a dedicated responsive Library header without inline sizing", () => {
    const root = document.createElement("div");
    root.hidden = true;
    document.body.replaceChildren(root);
    const library = new Library(appStub(), root);
    library.open();

    const header = root.querySelector<HTMLElement>(".library-header")!;
    const tabs = header.querySelector<HTMLElement>(".library-tabs")!;
    expect(header).not.toBeNull();
    expect(tabs.getAttribute("style")).toBeNull();
    expect(tabs.getAttribute("role")).toBe("tablist");
    expect(css).toMatch(/\.library-header\s*\{[^}]*display:\s*grid/s);
    expect(css).toMatch(
      /@media \(max-width:\s*760px\)[\s\S]*?\.library-header > \.library-tabs\s*\{[^}]*grid-column:\s*1 \/ -1/s);
  });

  it("uses a visually label-free native button as the whole-card hit target", () => {
    const app = appStub();
    let loaded = "";
    app.loadPreset = (preset) => { loaded = preset.name; };
    const root = document.createElement("div");
    root.hidden = true;
    document.body.replaceChildren(root);
    const library = new Library(app, root);
    library.open();

    const card = root.querySelector<HTMLElement>(
      '[data-preset-name="Earth & Moon"]')!;
    const hit = card.querySelector<HTMLButtonElement>("button.preset-card-hit")!;
    expect(hit.textContent).toBe("");
    expect(hit.getAttribute("aria-label")).toBe("Load Earth & Moon");
    expect(hit.getAttribute("aria-describedby")).toBe(
      card.querySelector("p")!.id);

    hit.click();
    expect(loaded).toBe("Earth & Moon");
    expect(root.hidden).toBe(true);
  });

  it("keeps the description toggle separate from loading and expanded-state aware", () => {
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.tagName === "P" ? 100 : 0;
      });
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.tagName === "P" ? 20 : 0;
      });
    try {
      const app = appStub();
      let loads = 0;
      app.loadPreset = () => { loads++; };
      const root = document.createElement("div");
      root.hidden = true;
      document.body.replaceChildren(root);
      const library = new Library(app, root);
      library.open();

      const card = root.querySelector<HTMLElement>(
        '[data-preset-name="Earth & Moon"]')!;
      const more = card.querySelector<HTMLButtonElement>("button.card-more")!;
      expect(card.classList.contains("has-more")).toBe(true);
      expect(card.lastElementChild).toBe(more);
      expect(more.getAttribute("aria-expanded")).toBe("false");
      expect(more.getAttribute("aria-controls")).toBe(card.querySelector("p")!.id);

      more.click();
      expect(loads).toBe(0);
      expect(card.classList.contains("expanded")).toBe(true);
      expect(more.textContent).toBe("Show less");
      expect(more.getAttribute("aria-expanded")).toBe("true");
    } finally {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });
});

describe("scene import activation", () => {
  it("stays disabled across Library rerenders while the same file read is pending", async () => {
    let finish!: (result: snap.SceneReadResult) => void;
    const upload = vi.spyOn(snap, "uploadScene").mockImplementation(() =>
      new Promise((resolve) => { finish = resolve; }));
    try {
      const root = document.createElement("div");
      root.hidden = true;
      document.body.replaceChildren(root);
      const library = new Library(appStub(), root);
      library.open();
      root.querySelector<HTMLButtonElement>("#library-tab-scenes")!.click();

      const importAction = (): HTMLButtonElement =>
        [...root.querySelectorAll<HTMLButtonElement>("button")]
          .find((candidate) => candidate.textContent?.includes("Import .json"))!;
      importAction().click();
      expect(upload).toHaveBeenCalledTimes(1);

      root.querySelector<HTMLButtonElement>("#library-tab-examples")!.click();
      root.querySelector<HTMLButtonElement>("#library-tab-scenes")!.click();
      const replacement = importAction();
      expect(replacement.disabled).toBe(true);
      expect(replacement.getAttribute("aria-busy")).toBe("true");
      replacement.click();
      expect(upload).toHaveBeenCalledTimes(1);

      finish({ status: "cancelled" });
      await Promise.resolve();
      expect(replacement.disabled).toBe(false);
      expect(replacement.getAttribute("aria-busy")).toBe("false");
    } finally {
      upload.mockRestore();
    }
  });
});

describe("compact checkbox and preset-card styling", () => {
  it("keeps the old 14px checkbox visual inside a 24px label target", () => {
    expect(css).toMatch(/label\.checkbox\s*\{[^}]*min-height:\s*24px/s);
    expect(css).toMatch(
      /label\.checkbox input\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;/s);
  });

  it("stretches the invisible load control across the card and pins More bottom-right", () => {
    expect(css).toMatch(
      /button\.preset-card-hit\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s);
    expect(css).toMatch(
      /\.card-more\s*\{[^}]*position:\s*absolute;[^}]*right:\s*6px;[^}]*bottom:\s*6px;/s);
    expect(css).toMatch(/\.card-more\s*\{[^}]*min-height:\s*24px/s);
    expect(css).toMatch(
      /\[data-studio="true"\]\s+button\.preset-card-hit[^}]*\{[^}]*padding:\s*0;[^}]*background:\s*transparent;[^}]*border-radius:\s*inherit/s);
    expect(css).toMatch(
      /\.preset-card:has\(button\.preset-card-hit:focus-visible\)/s);
  });
});

describe("Help links", () => {
  it("opens production notices without navigating away from the live scene", () => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    new Help(root, () => {});

    const notices = [...root.querySelectorAll<HTMLAnchorElement>("a")]
      .find((link) => link.textContent === "Third-party notices")!;
    expect(notices.getAttribute("href")).toBe("./THIRD_PARTY_NOTICES.txt");
    expect(notices.target).toBe("_blank");
    expect(notices.relList.contains("noopener")).toBe(true);
  });
});
