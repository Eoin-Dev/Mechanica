import { ScrubPointer } from "./scrub-pointer";
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
  let pointer: ScrubPointer | null = null;
  let motionTime = 0;
  let adaptive = true, gain = 1, continuous = true;
  const unavailable = (): boolean => disabled() || !root.isConnected || root.closest("[inert]") !== null;
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
    pointer?.finish(); pointer = null;
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    handle.classList.remove("is-scrubbing");
    document.documentElement.classList.remove("numeric-scrubbing");
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("mouseup", relativeUp, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("keydown", escape, true);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("pagehide", cancel);
    document.removeEventListener("visibilitychange", hidden);
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
  const adjust = (event: MouseEvent, dx: number): void => {
    if (!gesture || !Number.isFinite(dx)) return;
    const dt = event.timeStamp - motionTime;
    motionTime = event.timeStamp;
    const speed = dt > 0 ? Math.abs(dx) * 1000 / Math.max(4, dt) : 160;
    const acceleration = adaptive ? Math.max(0.25, Math.min(3, Math.sqrt(speed / 160))) : 1;
    const multiplier = (event.shiftKey ? 10 : 1) * (event.altKey ? 0.1 : 1);
    gesture.raw = Math.max(minimum, Math.min(maximum,
      gesture.raw + dx * gesture.sensitivity * gain * acceleration * multiplier));
    if (frame === null) frame = requestAnimationFrame(flush);
    event.preventDefault();
  };
  const relativeMove = (event: PointerEvent): void => {
    if (!pointer?.active || !gesture) return;
    if (unavailable()) { end(true); return; }
    // Recover if the release event was lost while capture or lock changed.
    if ((event.buttons & 1) === 0) { end(false); return; }
    pointer.move(event.movementX, event.movementY);
    adjust(event, event.movementX);
  };
  const relativeUp = (event: MouseEvent): void => {
    if (pointer?.active && event.button === 0) end(false);
  };
  const move = (event: PointerEvent): void => {
    if (gesture === null || event.pointerId !== gesture.id) return;
    if (unavailable()) { end(true); return; }
    // A browser recenter can precede the lock-change event as well as follow
    // it. Empty recenter motion is not evidence that the user released.
    if (pointer?.acquiring && event.buttons === 0 && event.movementX === 0 && event.movementY === 0) return;
    if (pointer?.active) {
      // Firefox suppresses compatibility mousemove after pointerdown is
      // prevented. Use relative PointerEvent motion once, in every browser.
      // Lock acquisition may emit a zero-delta recenter with buttons=0; it
      // carries no drag/release information. Real release is handled by up
      // or by the next nonzero motion with the button no longer held.
      if (event.movementX !== 0 || event.movementY !== 0) relativeMove(event);
      return;
    }
    // Recover if the release event was lost while capture or lock changed.
    if ((event.buttons & 1) === 0) { end(false); return; }
    if (!gesture.active && Math.abs(event.clientX - gesture.startX) < 3) return;
    if (!gesture.active) {
      gesture.active = true;
      handle.classList.add("is-scrubbing");
      document.documentElement.classList.add("numeric-scrubbing");
      try { handle.setPointerCapture(event.pointerId); } catch { /* Document listeners still track the pointer. */ }
      if (continuous && event.isTrusted && event.pointerType === "mouse") {
        pointer = new ScrubPointer(handle, event.clientX, event.clientY, () => end(true));
        pointer.request();
      }
    }
    const dx = event.clientX - gesture.x;
    gesture.x = event.clientX;
    adjust(event, dx);
  };
  const up = (event: PointerEvent): void => { if (event.pointerId === gesture?.id) end(false); };
  const cancel = (event?: Event): void => {
    // A second touch/pen may be cancelled by the browser while the captured
    // primary pointer is still live. It does not own this transaction.
    if (event?.type === "lostpointercapture" && (pointer?.active || pointer?.acquiring)) return;
    if (event && "pointerId" in event && event.pointerId !== gesture?.id) return;
    end(true);
  };
  const escape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || gesture === null) return;
    event.preventDefault(); event.stopImmediatePropagation(); end(true);
  };
  const hidden = (): void => { if (document.hidden) end(true); };
  const down = (event: PointerEvent): void => {
    if (event.button !== 0 || event.isPrimary === false || event.pointerType === "touch" || disabled()) return;
    // Cancellation may restore a whole linked/grouped model. Read the new
    // baseline only afterwards, and recheck the control if an owner rebuilt it.
    end(true);
    if (unavailable()) return;
    if (document.activeElement === input) input.blur();
    const initial = get();
    const sensitivity = typeof options.sensitivity === "function" ? options.sensitivity(initial) : options.sensitivity;
    if (!root.isConnected || !Number.isFinite(initial) || !(sensitivity > 0) || !Number.isFinite(sensitivity)) return;
    adaptive = document.documentElement.dataset.adaptiveScrub !== "false";
    continuous = document.documentElement.dataset.continuousScrub !== "false";
    gain = Math.max(0.25, Math.min(4, Number(document.documentElement.dataset.scrubSpeed) || 1));
    motionTime = event.timeStamp;
    gesture = { id: event.pointerId, startX: event.clientX, x: event.clientX,
      initial, raw: initial, sensitivity, active: false, started: false };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("mouseup", relativeUp, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("pagehide", cancel);
    document.addEventListener("visibilitychange", hidden);
    event.preventDefault(); event.stopPropagation();
  };
  const key = (event: KeyboardEvent): void => {
    if (disabled() || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    // Never round an entire key press away. The declared quantum is the
    // smallest legal adjustment, including integer-only properties.
    const increment = Math.max(step, step * (event.shiftKey ? 10 : 1) * (event.altKey ? 0.1 : 1));
    const value = rounded(get() + (event.key === "ArrowUp" ? increment : -increment));
    event.preventDefault(); event.stopImmediatePropagation();
    if (!Number.isFinite(value) || value === get()) return;
    phase("start");
    if (set(value) !== false) { refresh(); commit?.(); }
    else phase("cancel");
  };
  handle.classList.add("numeric-scrub-handle");
  input.setAttribute("aria-description", "Drag the label to adjust; slow motion is finer and fast motion is coarser. Shift adjusts faster; Alt adjusts more finely. Arrow keys adjust the value.");
  handle.addEventListener("pointerdown", down);
  handle.addEventListener("lostpointercapture", cancel);
  input.addEventListener("keydown", key, true);
  return {
    cancel,
    cancelIfDisabled: () => { if (gesture !== null && unavailable()) end(true); },
    dispose: () => {
      end(true);
      handle.removeEventListener("pointerdown", down);
      handle.removeEventListener("lostpointercapture", cancel);
      input.removeEventListener("keydown", key, true);
    },
  };
}
