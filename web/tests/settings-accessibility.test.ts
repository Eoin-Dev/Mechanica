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
});

describe("built-in preset cards", () => {
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
