/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPopover } from "../src/ui/command-popover";

function setup() {
  const trigger = document.createElement("button"), panel = document.createElement("div");
  panel.id = "commands";
  const disabled = document.createElement("button"), undo = document.createElement("button"), fit = document.createElement("button");
  disabled.disabled = true; panel.append(disabled, undo, fit);
  document.body.replaceChildren(trigger, panel);
  return { trigger, panel, undo, fit, commands: new CommandPopover(trigger, panel) };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("responsive scene commands", () => {
  it("keeps inline controls and moves focus through enabled popup actions without simulation keys escaping", () => {
    const { trigger, panel, undo, fit, commands } = setup();
    expect(trigger.hidden).toBe(true); expect(panel.hidden).toBe(false);
    commands.setCompact(true); expect(panel.hidden).toBe(true);
    trigger.click(); expect(document.activeElement).toBe(undo);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const leaked = vi.fn(); document.addEventListener("keydown", leaked);
    try {
      undo.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      expect(document.activeElement).toBe(fit); expect(leaked).not.toHaveBeenCalled();
      fit.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      expect(document.activeElement).toBe(undo);
      undo.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(panel.hidden).toBe(true); expect(document.activeElement).toBe(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    } finally { document.removeEventListener("keydown", leaked); }
  });

  it("runs the original command once and dismisses the popup without duplicating buttons", () => {
    const { trigger, panel, undo, commands } = setup(), action = vi.fn();
    undo.addEventListener("click", action); commands.setCompact(true);
    trigger.click(); undo.click();
    expect(action).toHaveBeenCalledOnce(); expect(panel.hidden).toBe(true);
    expect(panel.querySelectorAll("button")).toHaveLength(3);
    expect(document.activeElement).toBe(trigger);
    commands.setCompact(false);
    expect(trigger.hidden).toBe(true); expect(panel.hidden).toBe(false);
    undo.click(); expect(action).toHaveBeenCalledTimes(2);
  });

  it("keeps keyboard context when a closed popup trigger becomes an inline group", () => {
    const { trigger, panel, commands } = setup(); commands.setCompact(true);
    trigger.focus(); commands.setCompact(false);
    expect(document.activeElement).toBe(panel);
    expect(trigger.hidden).toBe(true); expect(panel.hidden).toBe(false);
  });

  it("retains an internal action through the browser's temporary focus gap and closes for a real outside destination", async () => {
    const { trigger, panel, undo, fit, commands } = setup(), action = vi.fn();
    fit.addEventListener("click", action); commands.setCompact(true); trigger.click();
    const focus = vi.spyOn(document, "activeElement", "get").mockReturnValue(document.body);
    undo.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: fit }));
    await Promise.resolve();
    expect(panel.hidden).toBe(false);
    focus.mockRestore(); fit.click();
    expect(action).toHaveBeenCalledOnce(); expect(panel.hidden).toBe(true);
    trigger.click();
    panel.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }));
    await Promise.resolve(); expect(panel.hidden).toBe(false);
    const outside = document.createElement("button"); document.body.append(outside); outside.focus();
    expect(panel.hidden).toBe(true); expect(document.activeElement).toBe(outside);
  });

  it("light-dismisses outside clicks and restores the inline group on layout changes", () => {
    const { trigger, panel, commands } = setup(); commands.setCompact(true);
    trigger.click();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(panel.hidden).toBe(true); expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click(); commands.setCompact(false);
    expect(panel.hidden).toBe(false); expect(panel.classList.contains("command-popover")).toBe(false);
    expect(trigger.hidden).toBe(true);
  });
});
