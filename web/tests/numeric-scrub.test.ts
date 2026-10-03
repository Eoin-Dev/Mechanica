/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefreshGroup, fmt3dp, numEdit, slider, tunableNumEdit, type Control } from "../src/ui/dom";
import { NUMERIC_EDIT_EVENT } from "../src/ui/numeric-scrub";

const controls: Control[] = [];
beforeEach(() => {
  document.body.replaceChildren(); vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 1));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => {
  for (const control of controls.splice(0)) control.dispose?.();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function send(target: EventTarget, type: string, x: number, extras: Record<string, unknown> = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x,
    button: 0, buttons: type === "pointerup" ? 0 : 1, ...extras });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" },
    ...Object.fromEntries(Object.entries(extras).filter(([key]) => key.startsWith("pointer")).map(([key, value]) => [key, { value }])) });
  target.dispatchEvent(event);
  return event;
}
function fixture(initial = 5, custom?: (value: number) => boolean) {
  let value = initial, disabled = false;
  const set = vi.fn((next: number) => { if (custom && !custom(next)) return false; value = next; });
  const commit = vi.fn();
  const control = tunableNumEdit("Value", () => value, set, "m", commit, fmt3dp,
    { disabled: () => disabled, scrub: { sensitivity: 0.1, step: 0.01, min: 0, max: 10 } });
  controls.push(control); document.body.append(control.root);
  const label = control.root.querySelector<HTMLElement>(".lbl")!, input = control.root.querySelector<HTMLInputElement>("input")!;
  let capture = false;
  label.setPointerCapture = vi.fn(() => { capture = true; });
  label.hasPointerCapture = () => capture;
  label.releasePointerCapture = vi.fn(() => { capture = false; });
  const phases: string[] = [];
  control.root.addEventListener(NUMERIC_EDIT_EVENT, e => phases.push((e as CustomEvent).detail));
  const move = (x: number, extras = {}) => { send(document, "pointermove", x, extras); vi.advanceTimersByTime(1); };
  return { control, label, input, set, commit, phases, move, value: () => value,
    disable: () => { disabled = true; control.refresh?.(); } };
}

describe("quantity label scrubbing", () => {
  it("preserves clicks and ignores sub-threshold movement", () => {
    const f = fixture(); send(f.label, "pointerdown", 100); f.move(102); send(document, "pointerup", 102);
    expect(f.value()).toBe(5); expect(f.set).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(f.input); expect(f.phases).toEqual([]);
  });
  it("tracks both directions beyond the panel and commits once", () => {
    const f = fixture(); send(f.label, "pointerdown", 100); f.move(140); f.move(-20);
    expect(f.value()).toBe(0); expect(f.input.value).toBe("0.000");
    expect(f.label.setPointerCapture).toHaveBeenCalledWith(1);
    send(document, "pointerup", -20);
    expect(f.commit).toHaveBeenCalledOnce(); expect(f.phases.filter(p => p === "start")).toHaveLength(1);
    expect(document.documentElement.classList.contains("numeric-scrubbing")).toBe(false);
  });
  it("changes modifiers incrementally without jumps", () => {
    const f = fixture(); send(f.label, "pointerdown", 100);
    f.move(110); expect(f.value()).toBe(6);
    f.move(111, { shiftKey: true }); expect(f.value()).toBe(7);
    f.move(121, { altKey: true }); expect(f.value()).toBe(7.1);
    f.move(122); expect(f.value()).toBe(7.2); send(document, "pointerup", 122);
  });
  it("reverses immediately after either boundary without overshoot debt", () => {
    const f = fixture(); send(f.label, "pointerdown", 0);
    f.move(1000); expect(f.value()).toBe(10);
    f.move(999); expect(f.value()).toBe(9.9);
    f.move(-1000); expect(f.value()).toBe(0);
    f.move(-999); expect(f.value()).toBe(0.1); send(document, "pointerup", -999);
  });
  it("coalesces pointer events and flushes the final value before committing", () => {
    const f = fixture(); send(f.label, "pointerdown", 0);
    for (let x = 3; x <= 40; x++) send(document, "pointermove", x);
    expect(f.set).not.toHaveBeenCalled(); vi.advanceTimersByTime(1);
    expect(f.set).toHaveBeenCalledOnce(); expect(f.value()).toBe(9);
    send(document, "pointermove", 42); send(document, "pointerup", 42);
    expect(f.value()).toBe(9.2); expect(f.commit).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10); expect(f.set).toHaveBeenCalledTimes(2);
  });
  it.each(["pointercancel", "lostpointercapture", "blur", "escape"])("rolls back on %s and restores pointer state", reason => {
    const f = fixture(); send(f.label, "pointerdown", 0); f.move(20); expect(f.value()).toBe(7);
    if (reason === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else if (reason === "blur") window.dispatchEvent(new Event("blur"));
    else if (reason === "lostpointercapture") f.label.dispatchEvent(new Event(reason));
    else send(document, reason, 20);
    expect(f.value()).toBe(5); expect(f.commit).not.toHaveBeenCalled(); expect(f.phases.at(-1)).toBe("cancel");
    expect(document.documentElement.classList.contains("numeric-scrubbing")).toBe(false);
    f.move(40); expect(f.value()).toBe(5);
  });
  it("cancels live scrubbing when disabled and prevents later writes", () => {
    const f = fixture(); send(f.label, "pointerdown", 0); f.move(20); f.disable();
    expect(f.value()).toBe(5); expect(f.input.disabled).toBe(true);
    send(f.label, "pointerdown", 0); f.move(40); expect(f.value()).toBe(5);
  });
  it.each(["touch", "secondary", "readonly", "other-pointer"])("ignores %s gestures", kind => {
    const f = fixture(); if (kind === "readonly") f.input.readOnly = true;
    send(f.label, "pointerdown", 0, kind === "touch" ? { pointerType: "touch" } : kind === "secondary" ? { button: 2 } : {});
    f.move(30, kind === "other-pointer" ? { pointerId: 2 } : {});
    expect(f.value()).toBe(5); expect(f.commit).not.toHaveBeenCalled();
  });
  it("supports pen input and keeps fractional values free of binary artifacts", () => {
    const f = fixture(0.1); send(f.label, "pointerdown", 0, { pointerType: "pen" });
    f.move(3); expect(f.value()).toBe(0.4); expect(f.input.value).toBe("0.400");
    send(document, "pointerup", 3);
  });
  it("uses the canonical rejection path without accumulating rejected movement", () => {
    const f = fixture(5, value => value <= 6);
    send(f.label, "pointerdown", 0); f.move(20); expect(f.value()).toBe(5);
    f.move(19); expect(f.value()).toBe(4.9); send(document, "pointerup", 19);
  });
  it("disposes a live control before removing its DOM", () => {
    const f = fixture(), group = new RefreshGroup(); group.add(f.control);
    send(f.label, "pointerdown", 0); f.move(20); group.clear(); f.control.root.remove();
    expect(f.value()).toBe(5); expect(f.phases.at(-1)).toBe("cancel");
    expect(document.documentElement.classList.contains("numeric-scrubbing")).toBe(false);
  });
  it("keeps exact text and keyboard adjustments working without a second blur commit", () => {
    const f = fixture(); f.input.focus(); f.input.value = "6.250"; f.input.blur();
    expect(f.value()).toBe(6.25); expect(f.commit).toHaveBeenCalledTimes(1);
    f.input.focus(); f.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(f.value()).toBe(6.26); expect(f.input.value).toBe("6.260"); f.input.blur();
    expect(f.commit).toHaveBeenCalledTimes(2);
  });
  it("does not expose a scrub handle on a non-opted-in exact input", () => {
    const control = numEdit("Identifier", () => 5, () => {}); controls.push(control);
    expect(control.root.querySelector(".numeric-scrub-handle")).toBeNull();
  });
  it("retains integer slider steps and its native range control", () => {
    let value = 5; const commit = vi.fn();
    const control = slider("Iterations", () => value, next => { value = next; }, 1, 100,
      { step: 1, scrub: { sensitivity: 1, step: 1 }, onCommit: commit });
    controls.push(control); document.body.append(control.root);
    const label = control.root.querySelector<HTMLElement>(".lbl")!;
    send(label, "pointerdown", 0); send(document, "pointermove", 3.4); send(document, "pointerup", 3.4);
    expect(value).toBe(8); expect(commit).toHaveBeenCalledOnce();
    expect(control.root.querySelector('input[type="range"]')).not.toBeNull();
  });
});
