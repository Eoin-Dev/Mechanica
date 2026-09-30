/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";
import { snapshot } from "../src/scene/snapshot";
import { MAX_RECOVERY_CHARS, RECOVERY_KEY, TabRecovery } from "../src/scene/recovery";

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
const recovery = () => new TabRecovery(() => sessionStorage);

describe("tab recovery", () => {
  it("restores an edited running scene across a new recovery instance", () => {
    const world = PRESETS.find(preset => preset.name === "Double pendulum")!.build();
    world.step(1 / 120);
    const state = snapshot(world);
    expect(recovery().write(state)).toBe("saved");
    const read = recovery().read();
    expect(read.status).toBe("loaded");
    if (read.status !== "loaded") throw new Error("Expected recovery");
    expect(snapshot(read.world)).toBe(state);
  });

  it("keeps an intentionally empty scene and does not alter named scenes", () => {
    localStorage.setItem("mechanica.scene.My experiment", "protected");
    expect(recovery().write(snapshot(new World()))).toBe("saved");
    const read = recovery().read();
    expect(read.status).toBe("loaded");
    if (read.status === "loaded") expect(read.world.bodies).toHaveLength(0);
    expect(localStorage.getItem("mechanica.scene.My experiment")).toBe("protected");
  });

  it.each(["null", "[]", "{}", '{"notes":"unrelated"}', "broken"])("rejects damaged recovery %s without deleting it", state => {
    sessionStorage.setItem(RECOVERY_KEY, state);
    expect(recovery().read().status).toBe("invalid");
    expect(sessionStorage.getItem(RECOVERY_KEY)).toBe(state);
  });

  it("rejects oversized recovery before parsing or replacing an earlier checkpoint", () => {
    const saved = snapshot(new World());
    const store = recovery();
    store.write(saved);
    const oversized = " ".repeat(MAX_RECOVERY_CHARS + 1);
    expect(store.write(oversized)).toBe("too-large");
    expect(sessionStorage.getItem(RECOVERY_KEY)).toBe(saved);
    sessionStorage.setItem(RECOVERY_KEY, oversized);
    expect(recovery().read().status).toBe("too-large");
  });

  it("does not repeat unchanged writes after a reload", () => {
    const state = snapshot(new World());
    recovery().write(state);
    const write = vi.fn((key, value) => sessionStorage.setItem(key, value));
    const store = new TabRecovery(() => ({ getItem: key => sessionStorage.getItem(key), setItem: write }));
    expect(store.read().status).toBe("loaded");
    expect(store.write(state)).toBe("unchanged");
    expect(write).not.toHaveBeenCalled();
  });

  it("contains blocked storage access and quota failures, allowing a later retry", () => {
    const blocked = new TabRecovery(() => { throw new DOMException("Blocked", "SecurityError"); });
    expect(blocked.read().status).toBe("unavailable");
    expect(blocked.write("{}")).toBe("unavailable");
    const write = vi.fn().mockImplementationOnce(() => { throw new DOMException("Full", "QuotaExceededError"); })
      .mockImplementation((key, value) => sessionStorage.setItem(key, value));
    const store = new TabRecovery(() => ({ getItem: key => sessionStorage.getItem(key), setItem: write }));
    const state = snapshot(new World());
    expect(store.write(state)).toBe("unavailable");
    expect(store.write(state)).toBe("saved");
  });
});
