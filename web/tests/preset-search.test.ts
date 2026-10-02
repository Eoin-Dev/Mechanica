/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { World } from "../src/engine/world";
import { Library } from "../src/ui/overlays";
import { PRESETS } from "../src/scene/presets";
import { buildPresetSearchIndex, normalizeExampleSearch, searchPresets } from "../src/scene/preset-search";

beforeEach(() => localStorage.clear());

function setup() {
  const app = { world: new World(), loadPreset: vi.fn(), toast: vi.fn() } as unknown as App;
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const library = new Library(app, root);
  library.open();
  const search = () => root.querySelector<HTMLInputElement>('[aria-label="Search examples"]')!;
  const query = (value: string) => {
    search().focus();
    search().value = value;
    search().dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { app, root, library, search, query };
}

describe("Study-term example discovery", () => {
  it.each([
    ["SHM", "Mass on a spring"], ["SUVAT", "Galileo's drop"],
    ["Newton’s cradle", "Newton's cradle"], ["Képler", "Kepler ellipse"],
    ["λ", "Elastic string release"], ["elastic energy", "Elastic string release"],
    ["restitution", "Restitution ladder"],
  ])("finds %s and names the matching example %s", (term, expected) => {
    const { root, search, query } = setup();
    query(term);
    expect(root.querySelector(`[data-preset-name="${expected}"]`)).not.toBeNull();
    expect(document.activeElement).toBe(search());
  });

  it("finds hidden category matches without discarding the query", () => {
    const { root, search, query } = setup();
    root.querySelector<HTMLButtonElement>('[data-category="Oscillators"]')!.click();
    query("SUVAT");
    expect(root.querySelectorAll(".preset-card")).toHaveLength(0);
    const all = [...root.querySelectorAll("button")].find(button => button.textContent === "Search all categories");
    expect(all).not.toBeUndefined();
    all!.click();
    expect(search().value).toBe("SUVAT");
    expect(document.activeElement).toBe(search());
    expect(root.querySelector('[data-category="All"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector('[data-preset-name="Galileo\'s drop"]')).not.toBeNull();
  });

  it("requires every query word, preserves registry order and keeps category constraints", () => {
    const index = buildPresetSearchIndex(PRESETS);
    expect(searchPresets(index, "  EARTH   moon ").map(preset => preset.name))
      .toEqual(PRESETS.filter(preset => /earth/i.test(preset.name + preset.description) &&
        /moon/i.test(preset.name + preset.description)).map(preset => preset.name));
    expect(searchPresets(index, "modulus nonsense")).toEqual([]);
    expect(searchPresets(index, "constant acceleration").map(preset => preset.name))
      .toEqual(["Galileo's drop", "Which lands first?", "Projectile angles"]);
    expect(searchPresets(index, "SUVAT", "Oscillators")).toEqual([]);
    expect(searchPresets(index, "   ")).toEqual(PRESETS);
    expect(normalizeExampleSearch("Ｎｅｗｔｏｎ’s  λ – Képler")).toBe("newtons  lambda   kepler");
  });

  it("keeps genuine topic differences and associates labels with the card action", () => {
    const { root, query, app } = setup();
    query("SHM");
    const card = root.querySelector('[data-preset-name="Mass on a spring"]')!;
    const topics = card.querySelector(".preset-topics")!;
    expect(topics.getAttribute("role")).toBe("group");
    expect(topics.textContent).toContain("SHM");
    expect(topics.textContent).toContain("Modulus λ");
    const load = card.querySelector<HTMLButtonElement>(".preset-card-hit")!;
    expect(load.getAttribute("aria-describedby")!.split(" ")).toContain(topics.id);
    load.click();
    expect(app.loadPreset).toHaveBeenCalledExactlyOnceWith(PRESETS.find(preset => preset.name === "Mass on a spring"));
    expect(searchPresets(buildPresetSearchIndex(PRESETS), "SUVAT")
      .some(preset => preset.name === "Projectile drag race")).toBe(false);
  });
});
