// @vitest-environment jsdom
/** Real DOM ancestry must preserve editor ownership and non-editable islands. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { handleShortcut, ShortcutHost } from "../src/ui/shortcuts";

const togglePlay = vi.fn();
const host: ShortcutHost = {
  app: { togglePlay } as unknown as App,
  tour: { visible: false }, overlays: [],
  toggleLibrary() {}, toggleHelp() {}, toggleInspector() {},
};

beforeEach(() => {
  togglePlay.mockClear();
  document.body.replaceChildren();
});

function press(markup: string): boolean {
  document.body.innerHTML = markup;
  const target = document.getElementById("target")!;
  const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  target.addEventListener("keydown", e => handleShortcut(e, host));
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("contenteditable shortcut ownership", () => {
  it.each(["true", "", "plaintext-only", "TRUE", "PLAINTEXT-ONLY"])(
    "leaves Space to a descendant of contenteditable=%s", value => {
      expect(press(`<div contenteditable="${value}"><span id="target">Text</span></div>`)).toBe(false);
      expect(togglePlay).not.toHaveBeenCalled();
    });

  it("allows shortcuts inside a non-editable island", () => {
    expect(press('<div contenteditable="true"><div contenteditable="FALSE"><span id="target"></span></div></div>')).toBe(true);
    expect(togglePlay).toHaveBeenCalledOnce();
  });

  it("allows an editor to resume inside a non-editable island", () => {
    expect(press('<div contenteditable="true"><div contenteditable="false"><span contenteditable="" id="target"></span></div></div>')).toBe(false);
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it("inherits through invalid attribute values", () => {
    expect(press('<div contenteditable="true"><div contenteditable="invalid"><span id="target"></span></div></div>')).toBe(false);
    expect(togglePlay).not.toHaveBeenCalled();
  });

  it("does not treat an invalid attribute as an editor on its own", () => {
    expect(press('<div contenteditable="invalid"><span id="target"></span></div>')).toBe(true);
    expect(togglePlay).toHaveBeenCalledOnce();
  });

  it("uses native editability when the browser supplies it", () => {
    const target = document.createElement("div");
    target.setAttribute("contenteditable", "true");
    Object.defineProperty(target, "isContentEditable", { value: false });
    document.body.append(target);
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    target.addEventListener("keydown", e => handleShortcut(e, host));
    target.dispatchEvent(event);
    expect(togglePlay).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });
});
