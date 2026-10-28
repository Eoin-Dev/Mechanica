/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repeatButton } from "../src/ui/repeat-button";
import type { Control } from "../src/ui/dom";

let control: Control;
function pointer(root: HTMLElement | Document, type: string, pointerId = 1, button = 0): void {
  const event = new MouseEvent(type, { bubbles: true, button, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } });
  root.dispatchEvent(event);
}
function setup() {
  const action = vi.fn();
  control = repeatButton("Frame", action);
  document.body.replaceChildren(control.root);
  return { action, root: control.root };
}
beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });
afterEach(() => { control?.dispose?.(); vi.useRealTimers(); document.body.replaceChildren(); });
describe("accelerating frame buttons", () => {
  it("takes one immediate frame and suppresses the release click", () => {
    const { action, root } = setup();
    pointer(root, "pointerdown"); expect(action).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(100); pointer(document, "pointerup");
    root.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    vi.advanceTimersByTime(5000); expect(action).toHaveBeenCalledOnce();
    root.click(); expect(action).toHaveBeenCalledTimes(2);
  });
  it("gradually increases the rate with one frame per callback and stops on release", () => {
    const { action, root } = setup(); pointer(root, "pointerdown");
    vi.advanceTimersByTime(1000); const early = action.mock.calls.length - 1;
    vi.advanceTimersByTime(2000); const before = action.mock.calls.length;
    vi.advanceTimersByTime(1000); const late = action.mock.calls.length - before;
    expect(early).toBeGreaterThan(0); expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThanOrEqual(25);
    pointer(document, "pointerup"); const end = action.mock.calls.length;
    vi.advanceTimersByTime(20_000); expect(action).toHaveBeenCalledTimes(end);
    expect(root.classList.contains("holding")).toBe(false);
  });
  it("ignores a secondary release and rejects non-left presses", () => {
    const { action, root } = setup(); pointer(root, "pointerdown", 7, 2);
    expect(action).not.toHaveBeenCalled(); pointer(root, "pointerdown", 1);
    pointer(document, "pointercancel", 2); vi.advanceTimersByTime(350);
    expect(action).toHaveBeenCalledTimes(2); pointer(document, "pointercancel", 1);
    vi.advanceTimersByTime(1000); expect(action).toHaveBeenCalledTimes(2);
  });
  it.each(["blur", "escape", "lost capture", "hidden", "disabled", "removed", "disposed"])(
    "stops without a queued burst after %s", reason => {
      const { action, root } = setup(); pointer(root, "pointerdown");
      if (reason === "blur") window.dispatchEvent(new Event("blur"));
      if (reason === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      if (reason === "lost capture") pointer(root, "lostpointercapture");
      if (reason === "hidden") { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); }
      if (reason === "disabled") (root as HTMLButtonElement).disabled = true;
      if (reason === "removed") root.remove();
      if (reason === "disposed") control.dispose!();
      vi.advanceTimersByTime(10_000); expect(action).toHaveBeenCalledOnce();
    });
  it.each([" ", "Enter"])("uses %s hold without native key-repeat duplication", key => {
    const { action, root } = setup();
    root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    root.dispatchEvent(new KeyboardEvent("keydown", { key, repeat: true, bubbles: true, cancelable: true }));
    expect(action).toHaveBeenCalledOnce(); vi.advanceTimersByTime(350);
    expect(action).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new KeyboardEvent("keyup", { key, cancelable: true }));
    vi.advanceTimersByTime(1000); expect(action).toHaveBeenCalledTimes(2);
  });
  it("never adds a release frame after an Escape-cancelled pointer hold", () => {
    const { action, root } = setup(); pointer(root, "pointerdown");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    vi.advanceTimersByTime(5000); pointer(document, "pointerup");
    root.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(action).toHaveBeenCalledOnce();
    pointer(root, "pointerdown"); expect(action).toHaveBeenCalledTimes(2);
  });
});
