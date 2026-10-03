/** Relative label scrubbing for tunable quantities, independent of application state. */
export interface ScrubOptions {
  sensitivity: number | ((value: number) => number);
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
}

export type NumericEditPhase = "start" | "live" | "cancel";
export const NUMERIC_EDIT_EVENT = "mechanica-numeric-edit";

interface NumericScrubControl {
  root: HTMLElement;
  handle: HTMLElement;
  input: HTMLInputElement;
  get: () => number;
  set: (value: number) => void | boolean;
  refresh: () => void;
  commit?: () => void;
  disabled: () => boolean;
}

/** Pointer enhancement: the associated input remains the keyboard/text control.
 * All writes use the owner's setter. Owners can listen for numeric-edit phases
 * to capture a transaction before mutation and restore linked/grouped state. */
export function numericScrub(control: NumericScrubControl, options: ScrubOptions): {
  dispose: () => void;
  cancelIfDisabled: () => void;
  cancel: () => void;
} {
  const { root, handle, input, get, set, refresh, commit, disabled } = control;
  let gesture: { id: number; startX: number; x: number; initial: number;
    raw: number; sensitivity: number; active: boolean; started: boolean } | null = null;
  let frame: number | null = null;
  const minimum = options.min ?? -Infinity, maximum = options.max ?? Infinity;
  const step = options.step ?? 10 ** -(options.precision ?? 3);
  const phase = (value: NumericEditPhase): void => {
    root.dispatchEvent(new CustomEvent(NUMERIC_EDIT_EVENT, { bubbles: true, detail: value }));
  };
  const rounded = (value: number): number => {
    const finite = Math.max(minimum, Math.min(maximum, value));
    const result = Math.round(finite / step) * step;
    return Math.max(minimum, Math.min(maximum, Number(result.toPrecision(15))));
  };
  const flush = (): void => {
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    if (gesture === null || !gesture.active || disabled()) return;
    const value = rounded(gesture.raw);
    if (!Number.isFinite(value) || value === get()) return;
    if (!gesture.started) { gesture.started = true; phase("start"); }
    phase("live");
    if (set(value) === false) gesture.raw = get();
    else {
      const accepted = get();
      // A setter may impose dependent bounds beyond the control's metadata.
      if (accepted !== value) gesture.raw = accepted;
    }
    refresh();
  };
  const end = (cancelled: boolean): void => {
    const previous = gesture;
    if (previous === null) return;
    if (!cancelled) flush();
    gesture = null;
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    handle.classList.remove("is-scrubbing");
    document.documentElement.classList.remove("numeric-scrubbing");
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("keydown", escape, true);
    window.removeEventListener("blur", cancel);
    try { if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id); } catch { /* Released by the browser. */ }
    if (previous.started) {
      if (cancelled) {
        // Restore the local value first; a transaction owner then restores
        // any heterogeneous group values and dependent properties exactly.
        if (get() !== previous.initial) set(previous.initial);
        phase("cancel");
      } else if (get() !== previous.initial) commit?.();
      else phase("cancel");
      refresh();
    } else if (!previous.active && !cancelled && !disabled() && input.isConnected) {
      input.focus({ preventScroll: true }); input.select();
    }
  };
  const move = (event: PointerEvent): void => {
    if (gesture === null || event.pointerId !== gesture.id) return;
    if (disabled() || !root.isConnected) { end(true); return; }
    if (!gesture.active && Math.abs(event.clientX - gesture.startX) < 3) return;
    if (!gesture.active) {
      gesture.active = true;
      handle.classList.add("is-scrubbing");
      document.documentElement.classList.add("numeric-scrubbing");
      try { handle.setPointerCapture(event.pointerId); } catch { /* Document listeners still track the pointer. */ }
    }
    const multiplier = (event.shiftKey ? 10 : 1) * (event.altKey ? 0.1 : 1);
    // Incremental deltas let modifier changes and clamp reversals respond
    // immediately, without reinterpreting earlier movement.
    gesture.raw = Math.max(minimum, Math.min(maximum,
      gesture.raw + (event.clientX - gesture.x) * gesture.sensitivity * multiplier));
    gesture.x = event.clientX;
    if (frame === null) frame = requestAnimationFrame(flush);
    event.preventDefault();
  };
  const up = (event: PointerEvent): void => { if (event.pointerId === gesture?.id) end(false); };
  const cancel = (): void => end(true);
  const escape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || gesture === null) return;
    event.preventDefault(); event.stopImmediatePropagation(); end(true);
  };
  const down = (event: PointerEvent): void => {
    if (event.button !== 0 || event.pointerType === "touch" || disabled()) return;
    if (document.activeElement === input) input.blur();
    const initial = get();
    const sensitivity = typeof options.sensitivity === "function" ? options.sensitivity(initial) : options.sensitivity;
    if (!root.isConnected || !Number.isFinite(initial) || !(sensitivity > 0) || !Number.isFinite(sensitivity)) return;
    end(true);
    gesture = { id: event.pointerId, startX: event.clientX, x: event.clientX,
      initial, raw: initial, sensitivity, active: false, started: false };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    event.preventDefault(); event.stopPropagation();
  };
  const key = (event: KeyboardEvent): void => {
    if (disabled() || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const increment = step * (event.shiftKey ? 10 : 1) * (event.altKey ? 0.1 : 1);
    const value = rounded(get() + (event.key === "ArrowUp" ? increment : -increment));
    event.preventDefault(); event.stopImmediatePropagation();
    if (!Number.isFinite(value) || value === get()) return;
    phase("start");
    if (set(value) !== false) { refresh(); commit?.(); }
    else phase("cancel");
  };
  handle.classList.add("numeric-scrub-handle");
  input.setAttribute("aria-description", "Drag the label to adjust. Shift adjusts faster; Alt adjusts more finely. Arrow keys adjust the value.");
  handle.addEventListener("pointerdown", down);
  handle.addEventListener("lostpointercapture", cancel);
  input.addEventListener("keydown", key, true);
  return {
    cancel,
    cancelIfDisabled: () => { if (disabled()) end(true); },
    dispose: () => {
      end(true);
      handle.removeEventListener("pointerdown", down);
      handle.removeEventListener("lostpointercapture", cancel);
      input.removeEventListener("keydown", key, true);
    },
  };
}
