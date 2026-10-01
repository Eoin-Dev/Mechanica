/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { World } from "../src/engine/world";
import * as snap from "../src/scene/snapshot";
import { Library } from "../src/ui/overlays";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

function setup() {
  const app = { world: new World(), toast: vi.fn() } as unknown as App;
  const root = document.createElement("div");
  root.hidden = true;
  document.body.replaceChildren(root);
  const library = new Library(app, root);
  library.open();
  root.querySelector<HTMLButtonElement>("#library-tab-scenes")!.click();
  const button = (name: string): HTMLButtonElement => {
    const result = [...root.querySelectorAll<HTMLButtonElement>("button")]
      .find(candidate => candidate.getAttribute("aria-label") === name || candidate.textContent === name);
    if (result === undefined) throw new Error(`Missing button: ${name}`);
    return result;
  };
  const field = (): HTMLInputElement | HTMLTextAreaElement =>
    root.querySelector<HTMLInputElement | HTMLTextAreaElement>("#scene-editor-value")!;
  const type = (value: string): void => {
    field().value = value;
    field().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const submit = (): void => {
    root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };
  return { app, root, library, button, field, type, submit };
}

describe("Library import lifecycle", () => {
  it("does not install a late file after the Library closes", async () => {
    let finish!: (result: snap.SceneReadResult) => void;
    vi.spyOn(snap, "uploadScene").mockImplementation(() =>
      new Promise(resolve => { finish = resolve; }));
    const { app, library, button } = setup();
    app.loadWorld = vi.fn();
    button("Import .json").click();
    library.close();
    finish({ status: "loaded", world: new World(), name: "Old import" });
    await Promise.resolve();
    expect(app.loadWorld).not.toHaveBeenCalled();
    expect(app.toast).not.toHaveBeenCalled();
    library.open();
    expect(button("Import .json").disabled).toBe(false);
  });

  it("keeps a new import busy when an older cancelled request finishes", async () => {
    const pending: Array<{ signal: AbortSignal | undefined;
      finish: (result: snap.SceneReadResult) => void }> = [];
    vi.spyOn(snap, "uploadScene").mockImplementation(signal => new Promise(resolve => {
      pending.push({ signal, finish: resolve });
    }));
    const { app, library, button } = setup();
    app.loadWorld = vi.fn();
    button("Import .json").click();
    library.close();
    expect(pending[0].signal?.aborted).toBe(true);
    library.open();
    button("Import .json").click();
    expect(pending).toHaveLength(2);
    pending[0].finish({ status: "invalid", name: "Old import" });
    await Promise.resolve();
    expect(app.toast).not.toHaveBeenCalled();
    expect(button("Import .json").disabled).toBe(true);
    expect(button("Import .json").getAttribute("aria-busy")).toBe("true");
    const world = new World();
    pending[1].finish({ status: "loaded", world, name: "New import" });
    await Promise.resolve();
    expect(app.loadWorld).toHaveBeenCalledExactlyOnceWith(world, "New import");
    expect(library.visible).toBe(false);
  });

  it("recovers from picker errors and suppresses errors from an old request", async () => {
    let fail!: (reason: Error) => void;
    const upload = vi.spyOn(snap, "uploadScene")
      .mockRejectedValueOnce(new Error("Picker blocked"))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue({ status: "cancelled" });
    const { app, library, button } = setup();
    button("Import .json").click();
    await Promise.resolve();
    expect(app.toast).toHaveBeenCalledExactlyOnceWith("Could not import the scene file. Try again.");
    expect(button("Import .json").disabled).toBe(false);
    button("Import .json").click();
    library.close();
    library.open();
    fail(new Error("Old picker failed"));
    await Promise.resolve();
    expect(app.toast).toHaveBeenCalledTimes(1);
    button("Import .json").click();
    await Promise.resolve();
    expect(upload).toHaveBeenCalledTimes(3);
    expect(button("Import .json").disabled).toBe(false);
  });
});

describe("saved-scene editor", () => {
  it("previews the stored name and saves without a browser prompt", () => {
    const prompt = vi.spyOn(window, "prompt");
    const { root, button, type, submit } = setup();
    button("Save current scene").click();
    type("Run #1");
    expect(root.querySelector("#scene-editor-help")!.textContent).toContain("Saved as “Run 1”");
    submit();
    expect(snap.listScenes()).toEqual(["Run 1"]);
    expect(document.activeElement).toBe(button("Load Run 1"));
    expect(prompt).not.toHaveBeenCalled();
  });

  it("requires replacement confirmation for the current normalized name", () => {
    const one = new World();
    one.gravity = 1;
    snap.saveScene(one, "Run 1");
    snap.saveScene(one, "Other");
    const { app, root, button, type, submit } = setup();
    app.world.gravity = 7;
    button("Save current scene").click();
    type("Run #1");
    submit();
    expect(button("Replace scene")).toBeDefined();
    expect(document.activeElement).toBe(button("Cancel"));
    expect(localStorage.getItem("mechanica.scene.Run 1")).toContain('"gravity":1');
    type("Other");
    expect(button("Save scene")).toBeDefined();
    submit();
    expect(root.querySelector(".scene-editor-warning")!.textContent).toContain("“Other”");
    expect(localStorage.getItem("mechanica.scene.Other")).toContain('"gravity":1');
    submit();
    expect(localStorage.getItem("mechanica.scene.Other")).toContain('"gravity":7');
    expect(localStorage.getItem("mechanica.scene.Run 1")).toContain('"gravity":1');
  });

  it("keeps empty and colliding names available for correction", () => {
    snap.saveScene(new World(), "Original");
    snap.saveScene(new World(), "Taken");
    const { root, button, field, type, submit } = setup();
    button("Rename Original").click();
    type(" ");
    submit();
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(root.querySelector('[role="alert"]')!.textContent).toBe("Enter a scene name.");
    type("Taken");
    submit();
    expect(field().value).toBe("Taken");
    expect(document.activeElement).toBe(field());
    expect(snap.listScenes()).toEqual(["Original", "Taken"]);
    type("Renamed");
    submit();
    expect(snap.listScenes()).toEqual(["Renamed", "Taken"]);
  });

  it("retains a draft on storage failure and allows retry", () => {
    const save = vi.spyOn(snap, "saveScene")
      .mockImplementationOnce(() => { throw new snap.SceneSaveError("Browser storage is full"); });
    const { app, root, button, field, type, submit } = setup();
    button("Save current scene").click();
    type("Keep this draft");
    submit();
    expect(field().value).toBe("Keep this draft");
    expect(root.querySelector('[role="alert"]')!.textContent).toBe("Browser storage is full");
    expect(app.toast).not.toHaveBeenCalled();
    submit();
    expect(save).toHaveBeenCalledTimes(2);
    expect(snap.listScenes()).toEqual(["Keep this draft"]);
  });

  it("edits multiline descriptions and cancels with Escape within the Library", () => {
    snap.saveScene(new World(), "Notes");
    snap.setSceneDescription("Notes", "Original");
    const { library, button, field, type, submit } = setup();
    button("Edit description for Notes").click();
    expect(field().tagName).toBe("TEXTAREA");
    type("Changed\nTwo lines");
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    field().dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(library.visible).toBe(true);
    expect(snap.sceneDescription("Notes")).toBe("Original");
    button("Edit description for Notes").click();
    type("Changed\nTwo lines");
    submit();
    expect(snap.sceneDescription("Notes")).toBe("Changed\nTwo lines");
  });

  it("focuses Cancel before deletion and preserves both keys on cancellation", () => {
    snap.saveScene(new World(), "Keep");
    snap.setSceneDescription("Keep", "Description");
    const { button, submit } = setup();
    button("Delete saved scene Keep").click();
    expect(document.activeElement).toBe(button("Cancel"));
    button("Cancel").click();
    expect(snap.listScenes()).toEqual(["Keep"]);
    expect(snap.sceneDescription("Keep")).toBe("Description");
    button("Delete saved scene Keep").click();
    submit();
    expect(snap.listScenes()).toEqual([]);
    expect(snap.sceneDescription("Keep")).toBe("");
    expect(document.activeElement).toBe(button("Save current scene"));
  });

  it("preserves a draft through section changes and discards it on close", () => {
    const { root, library, button, field, type } = setup();
    button("Save current scene").click();
    type("Draft");
    root.querySelector<HTMLButtonElement>("#library-tab-examples")!.click();
    root.querySelector<HTMLButtonElement>("#library-tab-scenes")!.click();
    expect(field().value).toBe("Draft");
    library.close();
    library.open();
    expect(root.querySelector(".scene-editor")).toBeNull();
    expect(snap.listScenes()).toEqual([]);
  });
});
