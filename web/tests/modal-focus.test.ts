/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { button, ModalFocus } from "../src/ui/dom";

beforeEach(() => document.body.replaceChildren());

function dialog(label = "Dialog") {
  const panel = document.createElement("div");
  document.body.append(panel);
  return { panel, focus: new ModalFocus(panel, label) };
}

describe("modal opener ownership", () => {
  it("restores a clicked opener even when the browser does not focus the button", () => {
    const input = document.createElement("input");
    const modal = dialog();
    const opener = button("Open", () => modal.focus.enter()).root;
    document.body.append(input, opener);
    input.focus();
    opener.click(); // jsdom, like WebKit's mouse click, does not focus the button.
    expect(document.activeElement).toBe(modal.panel);
    modal.focus.exit();
    expect(document.activeElement).toBe(opener);

    // The callback's opener must not leak into a later shortcut opening.
    input.focus();
    modal.focus.enter();
    modal.focus.exit();
    expect(document.activeElement).toBe(input);
  });

  it("keeps previous focus for dialogs opened by a shortcut", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const modal = dialog();
    input.focus();
    modal.focus.enter();
    modal.focus.exit();
    expect(document.activeElement).toBe(input);
  });

  it("returns a replacement dialog to the original opener instead of a hidden replay button", () => {
    const settings = dialog("Settings"), tour = dialog("Tour");
    const opener = button("Settings", () => settings.focus.enter()).root;
    const replay = button("Replay", () => {
      settings.panel.hidden = true;
      settings.focus.exit();
      tour.focus.enter();
    }).root;
    settings.panel.append(replay);
    document.body.append(opener);
    opener.click();
    replay.click();
    expect(document.activeElement).toBe(tour.panel);
    tour.focus.exit();
    expect(document.activeElement).toBe(opener);
  });

  it("restores the outer opener after nested synchronous button actions", () => {
    const inner = dialog("Inner"), outer = dialog("Outer");
    const innerButton = button("Inner", () => inner.focus.enter()).root;
    const outerButton = button("Outer", () => {
      innerButton.click();
      inner.focus.exit();
      outer.focus.enter();
    }).root;
    document.body.append(innerButton, outerButton);
    outerButton.click();
    outer.focus.exit();
    expect(document.activeElement).toBe(outerButton);
  });

  it("falls back to existing focus when the clicked opener is removed", () => {
    const modal = dialog();
    const input = document.createElement("input");
    const opener = button("Replace", () => {
      opener.remove();
      modal.focus.enter();
    }).root;
    document.body.append(input, opener);
    input.focus();
    opener.click();
    modal.focus.exit();
    expect(document.activeElement).toBe(input);
  });
});
