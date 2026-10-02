/** Prepared, headless search for example names, explanations and study topics. */
import type { Preset } from "./presets";

const TOPIC_ALIASES: Readonly<Record<string, string>> = {
  SHM: "simple harmonic motion",
  SUVAT: "constant acceleration kinematics",
};

export function normalizeExampleSearch(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[’']/g, "").replace(/λ/g, "lambda")
    .replace(/[-–—]/g, " ").trim();
}

export interface PresetSearchEntry {
  readonly preset: Preset;
  readonly text: string;
}

/** Normalize immutable catalogue text once rather than on every keystroke. */
export function buildPresetSearchIndex(presets: readonly Preset[]): readonly PresetSearchEntry[] {
  return presets.map(preset => ({ preset, text: normalizeExampleSearch(
    [preset.name, preset.category, preset.description, ...preset.topics,
      ...preset.topics.map(topic => TOPIC_ALIASES[topic] ?? "")].join(" ")) }));
}

/** All query words must match; category filtering preserves catalogue order. */
export function searchPresets(index: readonly PresetSearchEntry[], query: string,
                              category = "All"): Preset[] {
  const words = normalizeExampleSearch(query).split(/\s+/).filter(Boolean);
  return index.filter(entry => (category === "All" || entry.preset.category === category) &&
    words.every(word => entry.text.includes(word))).map(entry => entry.preset);
}
