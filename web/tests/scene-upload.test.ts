/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { World } from "../src/engine/world";
import { readSceneFile, uploadScene } from "../src/scene/snapshot";

afterEach(() => vi.restoreAllMocks());

function picker() {
  let input!: HTMLInputElement;
  const click = vi.spyOn(HTMLInputElement.prototype, "click")
    .mockImplementation(function (this: HTMLInputElement) { input = this; });
  const select = (file?: Pick<File, "name" | "size" | "text">): void => {
    Object.defineProperty(input, "files", { configurable: true, value: file ? [file] : [] });
    input.dispatchEvent(new Event("change"));
  };
  return { click, select, get input() { return input; } };
}

describe("scene file picker lifecycle", () => {
  it("does not open the picker or read a file for an already aborted request", async () => {
    const view = picker();
    const request = new AbortController();
    request.abort();
    await expect(uploadScene(request.signal)).resolves.toEqual({ status: "cancelled" });
    const text = vi.fn();
    await expect(readSceneFile({ name: "old.json", size: 1, text }, request.signal))
      .resolves.toEqual({ status: "cancelled" });
    expect(view.click).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it.each(["cancel", "empty selection", "abort"] as const)(
    "settles %s quietly and releases the picker handlers", async action => {
      const view = picker();
      const request = new AbortController();
      const remove = vi.spyOn(request.signal, "removeEventListener");
      const result = uploadScene(request.signal);
      expect(view.input.accept).toBe(".json,application/json");
      if (action === "cancel") view.input.dispatchEvent(new Event("cancel"));
      else if (action === "empty selection") view.select();
      else request.abort();
      await expect(result).resolves.toEqual({ status: "cancelled" });
      expect(view.input.onchange).toBeNull();
      expect(view.input.oncancel).toBeNull();
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    },
  );

  it("settles a slow read immediately on abort and never parses its late text", async () => {
    const view = picker();
    const request = new AbortController();
    let finish!: (text: string) => void;
    const text = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const parse = vi.spyOn(World, "fromDict");
    const result = uploadScene(request.signal);
    view.select({ name: "old.json", size: 2, text });
    expect(text).toHaveBeenCalledOnce();
    request.abort();
    await expect(result).resolves.toEqual({ status: "cancelled" });
    finish('{"bodies":[]}');
    await Promise.resolve();
    await Promise.resolve();
    expect(parse).not.toHaveBeenCalled();
    expect(view.input.onchange).toBeNull();
    expect(view.input.oncancel).toBeNull();
  });

  it("ignores a late read failure after cancellation", async () => {
    const view = picker();
    const request = new AbortController();
    let fail!: (error: Error) => void;
    const result = uploadScene(request.signal);
    view.select({ name: "old.json", size: 2,
      text: () => new Promise<string>((_resolve, reject) => { fail = reject; }) });
    request.abort();
    await expect(result).resolves.toEqual({ status: "cancelled" });
    fail(new Error("File is no longer readable"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("loads one selected file and cleans up after success", async () => {
    const view = picker();
    const request = new AbortController();
    const result = uploadScene(request.signal);
    const text = vi.fn().mockResolvedValue('{"bodies":[],"settings":{"gravity":4}}');
    view.select({ name: "Chosen.JSON", size: 30, text });
    view.select({ name: "Ignored.json", size: 30, text });
    const loaded = await result;
    expect(loaded.status).toBe("loaded");
    if (loaded.status !== "loaded") throw new Error("Expected the selected scene");
    expect(loaded.name).toBe("Chosen");
    expect(loaded.world.gravity).toBe(4);
    expect(text).toHaveBeenCalledOnce();
    expect(view.input.onchange).toBeNull();
    expect(view.input.oncancel).toBeNull();
    request.abort();
    await expect(result).resolves.toBe(loaded);
  });

  it("releases listeners if the browser refuses to open the picker", async () => {
    const request = new AbortController();
    const remove = vi.spyOn(request.signal, "removeEventListener");
    let input!: HTMLInputElement;
    vi.spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(function (this: HTMLInputElement) {
        input = this;
        throw new DOMException("Picker blocked", "SecurityError");
      });
    await expect(uploadScene(request.signal)).rejects.toThrow("Picker blocked");
    expect(input.onchange).toBeNull();
    expect(input.oncancel).toBeNull();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    request.abort();
  });
});
