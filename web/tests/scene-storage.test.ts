/** Saved scenes: the localStorage layer.
 *
 * This is user data - the scenes someone built and expects to still be
 * there - and none of it was covered. `safeName` in particular is subtle:
 * it decides the storage key, so two names that look different can collide
 * and silently overwrite one another, which is exactly why saveScene grew a
 * "does this already exist?" check for callers to ask first.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { SCENE_MAX_BODIES, World } from "../src/engine/world";
import {
  MAX_SCENE_FILE_BYTES, SceneSaveError, deleteScene, listScenes, loadScene,
  readSceneFile, renameScene, saveScene, sceneDescription, sceneExists,
  setSceneDescription,
} from "../src/scene/snapshot";

/** Minimal localStorage, with a settable byte budget so the quota path is
 * reachable. The real one is a browser API the suite has no access to. */
class MemoryStorage {
  private map = new Map<string, string>();
  limit = Infinity;
  failNextSetKey: string | null = null;
  failNextRemoveKey: string | null = null;

  get length(): number { return this.map.size; }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  removeItem(k: string): void {
    if (this.failNextRemoveKey === k) {
      this.failNextRemoveKey = null;
      throw new DOMException("storage blocked", "SecurityError");
    }
    this.map.delete(k);
  }
  clear(): void { this.map.clear(); }

  setItem(k: string, v: string): void {
    if (this.failNextSetKey === k) {
      this.failNextSetKey = null;
      throw new DOMException("storage blocked", "SecurityError");
    }
    let used = 0;
    for (const [mk, mv] of this.map) {
      if (mk !== k) used += mk.length + mv.length;
    }
    if (used + k.length + v.length > this.limit) {
      // a real DOMException, because that is what saveScene tests for when
      // deciding between "storage is full" and "this browser refused"
      throw new DOMException("quota exceeded", "QuotaExceededError");
    }
    this.map.set(k, v);
  }
}

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  (globalThis as Record<string, unknown>).localStorage = store;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

function scene(x = 1.5): World {
  const w = new World();
  w.bodies.push(new Body(new Vec2(x, 2.5), 0.2, 3.0));
  w.gravity = 4.25;
  return w;
}

function loaded(name: string): World {
  const result = loadScene(name);
  expect(result.status).toBe("loaded");
  if (result.status !== "loaded") throw new Error(`Scene '${name}' did not load`);
  return result.world;
}

describe("name sanitisation", () => {
  it("keeps letters and digits in any script", () => {
    for (const name of ["Épreuve", "実験", "Опыт", "μ test", "Ball 3"]) {
      expect(saveScene(scene(), name)).toBe(name);
    }
  });

  it("strips punctuation and control characters", () => {
    expect(saveScene(scene(), "Run #1")).toBe("Run 1");
    expect(saveScene(scene(), "a/b\\c:d")).toBe("abcd");
    // tabs and newlines are dropped outright rather than folded to a space:
    // only the literal space survives the character filter, and the
    // whitespace collapse afterwards has nothing left to collapse
    expect(saveScene(scene(), "tab\there")).toBe("tabhere");
    expect(saveScene(scene(), "a\0b")).toBe("ab");
  });

  it("keeps space, underscore and hyphen", () => {
    expect(saveScene(scene(), "my_scene-2 v")).toBe("my_scene-2 v");
  });

  it("collapses runs of whitespace and trims the ends", () => {
    expect(saveScene(scene(), "  a   b  ")).toBe("a b");
  });

  it("caps the length so one name cannot fill the quota", () => {
    const saved = saveScene(scene(), "x".repeat(500));
    expect(saved.length).toBe(80);
  });

  it("falls back to 'scene' when nothing survives", () => {
    for (const name of ["", "   ", "###", "!!!"]) {
      expect(saveScene(scene(), name)).toBe("scene");
    }
  });
});

describe("collisions", () => {
  it("reports when a different-looking name lands on the same key", () => {
    // the whole reason callers ask before saving: sanitisation makes these
    // one and the same scene
    saveScene(scene(), "Run #1");
    expect(sceneExists("Run 1")).toBe(true);
    expect(sceneExists("Run: 1")).toBe(true);
    expect(sceneExists("Run 2")).toBe(false);
  });

  it("does not report a name that has never been saved", () => {
    expect(sceneExists("nothing here")).toBe(false);
  });

  it("overwrites on a repeat save rather than duplicating", () => {
    saveScene(scene(1.0), "dup");
    saveScene(scene(9.0), "dup");
    expect(listScenes().filter((n) => n === "dup")).toHaveLength(1);
    expect(loaded("dup").bodies[0].pos.x).toBe(9.0);
  });
});

describe("save and load round trip", () => {
  it("restores the world that was saved", () => {
    saveScene(scene(3.25), "round trip");
    const back = loaded("round trip");
    expect(back.bodies).toHaveLength(1);
    expect(back.bodies[0].pos.x).toBe(3.25);
    expect(back.bodies[0].mass).toBe(3.0);
    expect(back.gravity).toBe(4.25);
  });

  it("reports a scene that is not there as missing", () => {
    expect(loadScene("missing").status).toBe("missing");
  });

  it("lists saved scenes in sorted order and nothing else", () => {
    store.setItem("mechanica.settings", "{}"); // an unrelated key must not appear
    saveScene(scene(), "beta");
    saveScene(scene(), "alpha");
    expect(listScenes()).toEqual(["alpha", "beta"]);
  });

  it("reports a full quota as a message the caller can show", () => {
    store.limit = 200; // smaller than any real scene payload
    expect(() => saveScene(scene(), "too big")).toThrow(SceneSaveError);
    try {
      saveScene(scene(), "too big");
    } catch (exc) {
      expect((exc as Error).message).toMatch(/storage is full/i);
    }
    // and nothing was half-written
    expect(listScenes()).toEqual([]);
  });

  it("distinguishes a rejected storage read from missing data", () => {
    store.getItem = () => { throw new DOMException("blocked", "SecurityError"); };
    const result = loadScene("blocked");
    expect(result.status).toBe("storage-error");
    if (result.status === "storage-error") expect(result.message).toMatch(/refused/i);
  });
});

describe("file import", () => {
  const file = (name: string, text: string, size = text.length) => ({
    name, size, text: async () => text,
  });

  it("rejects a file before reading when it exceeds 10 MiB", async () => {
    let read = false;
    const result = await readSceneFile({
      name: "huge.json",
      size: MAX_SCENE_FILE_BYTES + 1,
      text: async () => { read = true; return "{}"; },
    });
    expect(result.status).toBe("too-large");
    expect(read).toBe(false);
  });

  it("distinguishes damaged JSON from a valid scene", async () => {
    expect((await readSceneFile(file("broken.json", "{"))).status).toBe("invalid");
    const result = await readSceneFile(file("valid.json", '{"bodies":[]}'));
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") expect(result.name).toBe("valid");
  });

  it("reports engine collection limits as too-large", async () => {
    const text = JSON.stringify({ bodies: Array(SCENE_MAX_BODIES + 1).fill({}) });
    const result = await readSceneFile(file("crowded.json", text));
    expect(result.status).toBe("too-large");
    if (result.status === "too-large") expect(result.message).toMatch(/bodies/i);
  });
});

describe("descriptions", () => {
  it("stores and returns a description", () => {
    saveScene(scene(), "described");
    setSceneDescription("described", "  a pendulum  ");
    expect(sceneDescription("described")).toBe("a pendulum");
  });

  it("has no description until one is set", () => {
    saveScene(scene(), "bare");
    expect(sceneDescription("bare")).toBe("");
  });

  it("removes the description when set to empty", () => {
    saveScene(scene(), "clearable");
    setSceneDescription("clearable", "text");
    setSceneDescription("clearable", "   ");
    expect(sceneDescription("clearable")).toBe("");
  });

  it("survives corrupted metadata instead of throwing", () => {
    store.setItem("mechanica.scenemeta.broken", "{not json");
    expect(sceneDescription("broken")).toBe("");
    store.setItem("mechanica.scenemeta.wrongtype", JSON.stringify({ description: 7 }));
    expect(sceneDescription("wrongtype")).toBe("");
  });

  it("reports a rejected write and preserves the previous description", () => {
    saveScene(scene(), "described");
    setSceneDescription("described", "original");
    store.failNextSetKey = "mechanica.scenemeta.described";
    expect(() => setSceneDescription("described", "replacement"))
      .toThrow(SceneSaveError);
    expect(sceneDescription("described")).toBe("original");
  });
});

/** Corrupted metadata was handled; a corrupted SCENE was not.
 *
 * The two failure modes look alike and are not: a description that will not
 * parse costs a caption, whereas a payload that will not parse threw out of
 * loadScene, past the card's own "Could not load" toast, and into the click
 * handler - so clicking the scene appeared to do nothing at all. A partial
 * write from a full quota, or an entry edited by hand in devtools, gets you
 * there.
 */
describe("a damaged scene payload is reported, not thrown", () => {
  it("reports text that is not JSON as invalid", () => {
    store.setItem("mechanica.scene.broken", "{\"bodies\": [");
    expect(loadScene("broken").status).toBe("invalid");
  });

  it("reports an empty or truncated entry as invalid", () => {
    store.setItem("mechanica.scene.empty", "");
    store.setItem("mechanica.scene.cut", '{"bodies":[{"id":1,"pos":[0,');
    expect(loadScene("empty").status).toBe("invalid");
    expect(loadScene("cut").status).toBe("invalid");
  });

  it("still loads a scene whose JSON is valid but whose SHAPE is wrong", () => {
    // valid JSON is not a parse failure, so the loader must absorb it and
    // hand back a usable (empty) world rather than refusing
    store.setItem("mechanica.scene.odd", '{"bodies":"nope","walls":7}');
    const w = loaded("odd");
    expect(w.bodies).toEqual([]);
    expect(() => w.step(1 / 120)).not.toThrow();
  });

  it("leaves a damaged entry in place rather than deleting it", () => {
    // the user may still want to recover it by hand
    store.setItem("mechanica.scene.broken", "{not json");
    loadScene("broken");
    expect(store.getItem("mechanica.scene.broken")).toBe("{not json");
    expect(listScenes()).toContain("broken");
  });
});

describe("rename", () => {
  it("moves the payload and the description together", () => {
    saveScene(scene(7.5), "before");
    setSceneDescription("before", "note");
    expect(renameScene("before", "after")).toBe("after");
    expect(loadScene("before").status).toBe("missing");
    expect(loaded("after").bodies[0].pos.x).toBe(7.5);
    expect(sceneDescription("after")).toBe("note");
    expect(listScenes()).toEqual(["after"]);
  });

  it("refuses to overwrite an existing scene", () => {
    saveScene(scene(1), "one");
    saveScene(scene(2), "two");
    expect(renameScene("one", "two")).toBeNull();
    // both survive, untouched
    expect(loaded("one").bodies[0].pos.x).toBe(1);
    expect(loaded("two").bodies[0].pos.x).toBe(2);
  });

  it("refuses to rename a scene that does not exist", () => {
    expect(renameScene("ghost", "somewhere")).toBeNull();
  });

  it("sanitises the new name, and is a no-op when that changes nothing", () => {
    saveScene(scene(), "Run 1");
    expect(renameScene("Run 1", "Run #1")).toBe("Run 1"); // same key after cleaning
    expect(listScenes()).toEqual(["Run 1"]);
  });

  it("carries no stale description into a name that had none", () => {
    saveScene(scene(), "plain");
    renameScene("plain", "renamed");
    expect(sceneDescription("renamed")).toBe("");
  });

  it("rolls back when moving metadata is rejected", () => {
    saveScene(scene(4.5), "before");
    setSceneDescription("before", "keep me");
    store.failNextSetKey = "mechanica.scenemeta.after";
    expect(() => renameScene("before", "after")).toThrow(SceneSaveError);
    expect(loaded("before").bodies[0].pos.x).toBe(4.5);
    expect(sceneDescription("before")).toBe("keep me");
    expect(loadScene("after").status).toBe("missing");
    expect(sceneDescription("after")).toBe("");
  });

  it("removes orphaned target metadata when the source has none", () => {
    saveScene(scene(), "plain");
    store.setItem("mechanica.scenemeta.renamed", JSON.stringify({ description: "orphan" }));
    expect(renameScene("plain", "renamed")).toBe("renamed");
    expect(sceneDescription("renamed")).toBe("");
  });
});

describe("delete", () => {
  it("removes the payload and the description", () => {
    saveScene(scene(), "doomed");
    setSceneDescription("doomed", "note");
    deleteScene("doomed");
    expect(loadScene("doomed").status).toBe("missing");
    expect(sceneDescription("doomed")).toBe("");
    expect(listScenes()).toEqual([]);
  });

  it("leaves other scenes alone", () => {
    saveScene(scene(), "keep");
    saveScene(scene(), "drop");
    deleteScene("drop");
    expect(listScenes()).toEqual(["keep"]);
  });

  it("restores both keys when a storage failure interrupts deletion", () => {
    saveScene(scene(6), "kept");
    setSceneDescription("kept", "still here");
    store.failNextRemoveKey = "mechanica.scenemeta.kept";
    expect(() => deleteScene("kept")).toThrow(SceneSaveError);
    expect(loaded("kept").bodies[0].pos.x).toBe(6);
    expect(sceneDescription("kept")).toBe("still here");
  });
});
