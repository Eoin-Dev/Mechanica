/** A native button with bounded, accelerating press-and-hold activation. */
import { button, type ButtonOpts, type Control } from "./dom";

export function repeatButton(label: string, action: () => void, opts: ButtonOpts = {}): Control {
  const control = button(label, action, opts);
  const root = control.root as HTMLButtonElement;
  root.setAttribute("aria-description", "Press and hold to repeat, gradually faster. Release to stop.");
  root.title += " Press and hold to repeat, gradually faster.";
  let owner: number | string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = 0, suppressPointerClick = false;
  const available = (): boolean => root.isConnected && !root.disabled &&
    !root.closest("[inert]") && !document.hidden && (opts.isEnabled?.() ?? true);
  const stop = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const pointer = owner;
    if (typeof pointer === "number") suppressPointerClick = true;
    owner = null;
    root.classList.remove("holding");
    document.removeEventListener("pointerup", pointerEnd, true);
    document.removeEventListener("pointercancel", pointerEnd, true);
    document.removeEventListener("keyup", keyEnd, true);
    document.removeEventListener("keydown", escape, true);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("blur", stop);
    if (typeof pointer === "number") {
      try { root.releasePointerCapture(pointer); } catch { /* Capture can already be lost. */ }
    }
  };
  const tick = (): void => {
    timer = null;
    if (owner === null || !available()) { stop(); return; }
    action();
    // One frame per callback, with no catch-up burst if a solver step is slow.
    if (owner !== null) timer = setTimeout(tick,
      Math.max(40, 220 * Math.exp(-(performance.now() - started) / 1500)));
  };
  const start = (next: number | string): void => {
    if (owner !== null || !available()) return;
    suppressPointerClick = false;
    owner = next; started = performance.now();
    root.classList.add("holding");
    document.addEventListener("pointerup", pointerEnd, true);
    document.addEventListener("pointercancel", pointerEnd, true);
    document.addEventListener("keyup", keyEnd, true);
    document.addEventListener("keydown", escape, true);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", stop);
    action();
    if (owner !== null) timer = setTimeout(tick, 350);
  };
  const pointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== owner) return;
    // The pointerup's native click would otherwise add another frame.
    stop();
  };
  const keyEnd = (event: KeyboardEvent): void => {
    if (event.key !== owner) return;
    event.preventDefault(); event.stopPropagation(); stop();
  };
  const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") stop(); };
  const visibility = (): void => { if (document.hidden) stop(); };
  const down = (event: PointerEvent): void => {
    if (event.button !== 0 || event.isPrimary === false) return;
    start(event.pointerId);
    if (owner === event.pointerId) {
      try { root.setPointerCapture(event.pointerId); } catch { /* Document release is the fallback. */ }
    }
  };
  const keyDown = (event: KeyboardEvent): void => {
    if ((event.key !== " " && event.key !== "Enter") || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) start(event.key);
  };
  const click = (event: MouseEvent): void => {
    if (event.detail > 0 && suppressPointerClick) {
      event.preventDefault(); event.stopImmediatePropagation(); suppressPointerClick = false;
    }
  };
  const lost = (event: PointerEvent): void => { if (event.pointerId === owner) stop(); };
  const blur = (): void => { if (typeof owner === "string") stop(); };
  root.addEventListener("pointerdown", down);
  root.addEventListener("lostpointercapture", lost);
  root.addEventListener("keydown", keyDown);
  root.addEventListener("click", click, true);
  root.addEventListener("blur", blur);
  root.style.touchAction = "none";
  return { ...control, cancelInteraction: stop, dispose: () => {
    stop(); root.removeEventListener("pointerdown", down);
    root.removeEventListener("lostpointercapture", lost);
    root.removeEventListener("keydown", keyDown); root.removeEventListener("click", click, true);
    root.removeEventListener("blur", blur);
  } };
}
