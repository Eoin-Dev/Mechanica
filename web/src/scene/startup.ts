/** Fresh startup selection; ordinary reload recovery is handled separately. */
import type { App } from "../app";
import { PRESETS, type Preset } from "./presets";
import { listScenes, loadScene } from "./snapshot";
import type { World } from "../engine/world";

export type StartingScene = { preset: Preset } | { world: World; name: string };

export function startingScene(random = false, rng: () => number = Math.random): StartingScene {
  const fallback = PRESETS.find(preset => preset.name === "Pulley on an incline") ?? PRESETS[0];
  if (!random) return { preset: fallback };
  let names: string[];
  try { names = listScenes(); } catch { names = []; }
  const candidates: (Preset | string)[] = [...PRESETS, ...names];
  while (candidates.length) {
    const sample = rng();
    const index = Math.min(candidates.length - 1, Math.max(0, Math.floor((Number.isFinite(sample) ? sample : 0) * candidates.length)));
    const candidate = candidates[index];
    if (typeof candidate !== "string") return { preset: candidate };
    const saved = loadScene(candidate);
    if (saved.status === "loaded") return { world: saved.world, name: candidate };
    // Damaged or unavailable saved scenes cannot make a fresh visit fail.
    candidates.splice(index, 1);
  }
  return { preset: fallback };
}

export function initializeStartingScene(app: App): string {
  const random = app.settings.random_start_scene ?? true;
  const scene = startingScene(app.settings.startup_seen === true && random);
  app.settings.random_start_scene = random;
  if ("preset" in scene) {
    app.initializePreset(scene.preset);
    if (scene.preset.name === "Pulley on an incline") {
      const particle = app.world.bodies.find(body => body.showForceComponents && !body.isAnchor);
      if (particle) app.setSelection([particle]);
    }
  } else app.loadWorld(scene.world, scene.name, false);
  app.settings.startup_seen = true;
  app.saveSettings();
  return "preset" in scene ? scene.preset.name : scene.name;
}

/** The one-use URL flag survives pagehide checkpoints without destroying saved scenes. */
export function freshStartURL(href: string): string {
  const url = new URL(href); url.searchParams.set("start", "fresh"); return url.href;
}

export function consumeFreshStart(): boolean {
  const url = new URL(window.location.href);
  if (url.searchParams.get("start") !== "fresh") return false;
  url.searchParams.delete("start"); window.history.replaceState(null, "", url.href);
  return true;
}

export function restartApplication(): void { window.location.assign(freshStartURL(window.location.href)); }
