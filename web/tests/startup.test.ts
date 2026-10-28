/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRESETS } from "../src/scene/presets";
import { startingScene, initializeStartingScene, freshStartURL, consumeFreshStart } from "../src/scene/startup";
import { saveScene } from "../src/scene/snapshot";
import { World } from "../src/engine/world";
import { Body } from "../src/engine/body";
import { Vec2 } from "../src/core/vec";
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
describe("fresh startup and reload acknowledgement", () => {
  it("keeps the deterministic incline fallback and can choose every built-in scene", () => {
    expect(startingScene()).toHaveProperty("preset.name", "Pulley on an incline");
    PRESETS.forEach((preset, index) => expect(startingScene(true, () => (index + 0.5) / PRESETS.length)).toEqual({ preset }));
  });
  it("includes saved scenes in the random pool with their actual authored data", () => {
    const world = new World(); const body = new Body(new Vec2(8, 9)); body.name = "Saved particle"; world.bodies.push(body);
    saveScene(world, "My startup scene");
    const scene = startingScene(true, () => 0.999999);
    expect("world" in scene).toBe(true);
    if ("world" in scene) { expect(scene.name).toBe("My startup scene"); expect(scene.world.bodies[0].pos).toEqual(body.pos); }
  });
  it("skips a damaged saved random candidate while retaining a valid saved scene", () => {
    const world = new World(); world.bodies.push(new Body(new Vec2(3, 4)));
    saveScene(world, "A valid saved scene");
    localStorage.setItem("mechanica.scene.Z damaged saved scene", "broken");
    const scene = startingScene(true, () => 1);
    expect("world" in scene).toBe(true);
    if ("world" in scene) expect(scene.name).toBe("A valid saved scene");
    expect(localStorage.getItem("mechanica.scene.Z damaged saved scene")).toBe("broken");
  });
  it("uses a one-use recovery bypass without losing unrelated URL state", () => {
    const url = freshStartURL(new URL('?theme=dark#canvas', window.location.href).href);
    window.history.replaceState(null, "", url); expect(consumeFreshStart()).toBe(true);
    expect(window.location.search).toBe("?theme=dark"); expect(window.location.hash).toBe("#canvas");
    expect(consumeFreshStart()).toBe(false);
  });
});

function startupApp(settings: import("../src/app").Settings = {}) {
  const app = {
    settings, world: new World(), saveSettings: vi.fn(), setSelection: vi.fn(),
    initializePreset(preset: (typeof PRESETS)[number]) { app.world = preset.build(); },
    loadWorld(world: World) { app.world = world; },
  };
  return app;
}

describe("first-visit and returning-browser startup", () => {
  it("enables random starts by default but introduces a new browser with the incline scene", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    const app = startupApp();
    expect(initializeStartingScene(app as unknown as import("../src/app").App)).toBe("Pulley on an incline");
    expect(app.settings).toMatchObject({ random_start_scene: true, startup_seen: true });
    expect(app.saveSettings).toHaveBeenCalledOnce();
    expect(app.setSelection).toHaveBeenCalledWith([expect.objectContaining({ name: "2.0 kg on slope" })]);
  });
  it("chooses an actual saved model on subsequent fresh starts and returns its name for the notice", () => {
    const world = new World(); const body = new Body(new Vec2(8, 9)); body.name = "A classroom model";
    world.bodies.push(body); saveScene(world, "Classroom Δ");
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    const app = startupApp({ startup_seen: true });
    expect(initializeStartingScene(app as unknown as import("../src/app").App)).toBe("Classroom Δ");
    expect(app.world.bodies[0].name).toBe("A classroom model");
    expect(app.world.bodies[0].pos).toEqual(new Vec2(8, 9));
  });
  it("honours an explicit random-start opt-out on returning visits", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    const app = startupApp({ startup_seen: true, random_start_scene: false });
    expect(initializeStartingScene(app as unknown as import("../src/app").App)).toBe("Pulley on an incline");
    expect(app.settings.random_start_scene).toBe(false);
  });
});
