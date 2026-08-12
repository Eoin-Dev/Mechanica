/** Tiny DOM helpers and the reusable controls the panels are built from.
 *
 * Controls read their value through a getter and write through a setter
 * (matching the desktop widget design), and register a `refresh` that the
 * app calls on its panel cadence so live state remains current without
 * monitor-rate DOM polling, unless the user is actively editing.
 */

type Child = Node | string | null | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(c);
  }
  return node;
}

export interface Control {
  root: HTMLElement;
  refresh?: () => void;
}

/** A media query kept as one live MediaQueryList.
 *
 * The predicates below are polled on display/panel updates (the hint bar and the tool
 * hint both ask isTouch, the camera easing asks reducedMotion), and
 * `matchMedia()` builds a fresh MediaQueryList each call - measured at
 * 1.5 us against 105 ns for reading `.matches` off a kept one. The object
 * stays live, so this caches the query, never the answer: rotating a
 * phone or toggling the system setting is still picked up immediately,
 * with no reload. */
function media(query: string): () => boolean {
  let mql: MediaQueryList | null = null;
  return () => {
    // Test what is actually about to be CALLED, not merely that a window
    // object exists. The guard was meant to let this run outside a browser
    // and checked the wrong thing: any host with a window but no
    // matchMedia - jsdom, an old webview - threw a TypeError out of the
    // first predicate, which happens inside the Inspector's constructor and
    // so took the whole app down rather than degrading.
    if (typeof window === "undefined" ||
        typeof window.matchMedia !== "function") return false;
    if (mql === null) mql = window.matchMedia(query);
    return mql.matches;
  };
}

/** Subscribe to a media query starting or stopping matching.
 *
 * Exists so nothing has to reach for `matchMedia` itself. The Inspector did,
 * unguarded, right next to its use of the guarded predicates below - so a
 * host with a window but no matchMedia still threw out of its constructor
 * even after `media()` learned to cope. One capability, one place that
 * checks for it. */
export function onMediaChange(query: string, fn: () => void): void {
  if (typeof window === "undefined" ||
      typeof window.matchMedia !== "function") return;
  window.matchMedia(query).addEventListener("change", fn);
}

/** The CSS mobile breakpoint, shared by the predicate below and by anything
 * subscribing to it, so the two cannot drift apart. */
export const PHONE_QUERY = "(max-width: 760px)";

/** Phone-sized viewport (matches the CSS mobile breakpoint). Gates LAYOUT
 * choices (the inspector drawer, toolbar trims). */
export const isPhone = media(PHONE_QUERY);

/** Touch-first device (phones AND tablets - no hover, no mouse buttons,
 * usually no keyboard). Gates WORDING and content: touch hints, no
 * keyboard/mouse references, no cursor readouts. */
export const isTouch = media("(pointer: coarse)");

/** The viewer has asked the system for reduced motion.
 *
 * Gates DECORATIVE movement only - the easing on the auto-fit camera, the
 * graph's autoscale, UI fades. The simulation itself keeps moving: it is
 * the content, not an animation, and freezing it would leave nothing to
 * look at. */
export const reducedMotion = media("(prefers-reduced-motion: reduce)");

/** Collects controls so a panel can refresh them all each frame. */
export class RefreshGroup {
  private items: Array<{ el: HTMLElement; fn: () => void; visible: boolean }> = [];
  private byEl = new Map<Element, { visible: boolean }>();
  private io: IntersectionObserver | null = null;

  /** Skip refreshing controls scrolled out of view inside `scrollRoot`.
   * A long panel (hundreds of driver/field rows) otherwise refreshes
   * every control on every panel poll, which shows up as a slowdown just from
   * having the panel open. */
  cullWithin(scrollRoot: HTMLElement): void {
    if (typeof IntersectionObserver === "undefined") return;
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const item = this.byEl.get(e.target);
        if (item === undefined) continue;
        // "Not intersecting" covers two situations that could not be more
        // different, and only one of them is what this culling is for.
        //
        // A control SCROLLED out of the panel has a box, somewhere outside
        // the root, and skipping its refresh is free performance. A control
        // that is HIDDEN has no box at all, and the observer reports it as a
        // zero rect. Culling that one is a trap with teeth: a control that
        // decides its own visibility hides itself inside its own refresh, so
        // culling it at that moment means the refresh never runs again and it
        // can never come back.
        //
        // Three controls in the Inspector were stuck exactly there - the
        // performance-mode banner, the capped-substeps note and the
        // long-trail warning - each appearing only when a rebuild (a tab
        // switch, a selection change) happened to catch it at a moment it
        // should already be visible. Collapsing the whole panel does the same
        // thing to every control in it, but that case rights itself: the
        // boxes come back on expand and the observer says so. A self-hiding
        // control has nothing to give it a box back.
        const r = e.boundingClientRect;
        item.visible = e.isIntersecting || (r.width === 0 && r.height === 0);
      }
    }, { root: scrollRoot, rootMargin: "80px" });
  }

  add<T extends Control>(c: T): T {
    if (c.refresh) {
      // visible until the observer reports otherwise, so nothing is
      // stale during the first frames after a rebuild
      const item = { el: c.root, fn: c.refresh, visible: true };
      this.items.push(item);
      this.byEl.set(c.root, item);
      this.io?.observe(c.root);
    }
    return c;
  }

  refreshAll(): void {
    for (const item of this.items) {
      if (item.visible) item.fn();
    }
  }

  clear(): void {
    this.io?.disconnect();
    this.items = [];
    this.byEl.clear();
  }
}

// ------------------------------------------------------------------ splitter
/** Bounds of the resizable panes.
 *
 * Exported because THREE places need to agree on them and previously did
 * not: the splitter that enforces them while dragging, the code that
 * re-applies a saved size on load, and the settings guard that decides
 * which saved sizes are usable at all. A stored width the splitter could
 * never have produced would otherwise be honoured on load and only snap
 * back the next time the splitter was touched. */
export const INSPECTOR_W_MIN = 240;
export const INSPECTOR_W_MAX = 620;
export const DOCK_H_MIN = 110;
export const DOCK_H_MAX = 1200;

/** Wire a splitter element as a drag-to-resize handle.
 *
 * `onMove` applies the new size, `onCommit` persists it once the gesture
 * ends. Shared by the Inspector's width splitter and the graph dock's
 * height splitter, which had grown identical copies of this - and the same
 * two gaps in both:
 *
 *   - A cancelled drag (a system gesture on touch, a pointer lost to a
 *     window switch) fires `pointercancel`, never `pointerup`, so the
 *     "dragging" flag stayed true. From then on merely HOVERING over the
 *     splitter went on resizing the panel with no button held. The graph
 *     canvas in the same file already handled pointercancel, so the two
 *     halves of one panel disagreed about the same gesture.
 *   - `setPointerCapture` throws if the pointer is already gone by the time
 *     the handler runs; uncaught, that aborted the gesture's setup and left
 *     the flag set with no capture to release.
 */
export interface SplitterKeyboardOptions {
  orientation: "horizontal" | "vertical";
  label: string;
  getValue: () => number;
  setValue: (value: number) => void;
  min: number | (() => number);
  max: number | (() => number);
  increaseKeys: readonly string[];
  decreaseKeys: readonly string[];
}

/** Pointer resizing plus the ARIA separator keyboard pattern.
 *
 * Arrow keys move by 10 CSS pixels, Shift+Arrow by 32, and Home/End select
 * the available limits. `increaseKeys` is explicit because a pane on the
 * right grows when its separator moves left, while a bottom pane grows when
 * its separator moves up. */
export function splitterDrag(splitter: HTMLElement,
                             onMove: (e: PointerEvent) => void,
                             onCommit: () => void,
                             keyboard?: SplitterKeyboardOptions): () => void {
  const bound = (v: number | (() => number)): number =>
    typeof v === "function" ? v() : v;
  const syncAria = (): void => {
    if (keyboard === undefined) return;
    const set = (name: string, value: number): void => {
      const text = String(Math.round(value));
      if (splitter.getAttribute(name) !== text) splitter.setAttribute(name, text);
    };
    set("aria-valuemin", bound(keyboard.min));
    set("aria-valuemax", bound(keyboard.max));
    set("aria-valuenow", keyboard.getValue());
  };
  if (keyboard !== undefined) {
    splitter.tabIndex = 0;
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-orientation", keyboard.orientation);
    splitter.setAttribute("aria-label", keyboard.label);
    syncAria();
    splitter.addEventListener("keydown", (e) => {
      let next: number | null = null;
      const lo = bound(keyboard.min);
      const hi = bound(keyboard.max);
      if (e.key === "Home") next = lo;
      else if (e.key === "End") next = hi;
      else {
        const step = e.shiftKey ? 32 : 10;
        if (keyboard.increaseKeys.includes(e.key)) next = keyboard.getValue() + step;
        else if (keyboard.decreaseKeys.includes(e.key)) next = keyboard.getValue() - step;
      }
      if (next === null) return;
      keyboard.setValue(Math.max(lo, Math.min(hi, next)));
      syncAria();
      onCommit();
      e.preventDefault();
      e.stopPropagation();
    });
  }
  let dragging = false;
  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    onCommit();
  };
  splitter.addEventListener("pointerdown", (e) => {
    dragging = true;
    try {
      splitter.setPointerCapture(e.pointerId);
    } catch {
      // pointer already released: the drag just won't track off-element
    }
  });
  splitter.addEventListener("pointermove", (e) => {
    if (dragging) {
      onMove(e);
      syncAria();
    }
  });
  splitter.addEventListener("pointerup", end);
  splitter.addEventListener("pointercancel", end);
  // fires after pointerup too, but `end` is idempotent; it is here for the
  // case where capture is lost without either of the events above
  splitter.addEventListener("lostpointercapture", end);
  // A splitter may be wired while its pane is hidden, so its initial measured
  // value can be zero. Owners call this after revealing or externally resizing
  // the pane to keep the separator's announced range truthful.
  return syncAria;
}

// ---------------------------------------------------------------------- tabs
/** Install the WAI-ARIA tab keyboard model on a stable set of buttons.
 * Selection follows focus for Left/Right and Home/End, and only the selected
 * tab stays in the page's Tab order. */
export function wireTabs<T extends string>(list: HTMLElement,
                                            buttons: Map<T, HTMLButtonElement>,
                                            activate: (tab: T) => void): void {
  list.setAttribute("role", "tablist");
  for (const b of buttons.values()) b.setAttribute("role", "tab");
  list.addEventListener("keydown", (e) => {
    const entries = [...buttons.entries()];
    const index = entries.findIndex(([, b]) => b === document.activeElement);
    if (index < 0) return;
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % entries.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + entries.length) % entries.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = entries.length - 1;
    else return;
    const [tab, button] = entries[next];
    activate(tab);
    button.focus();
    e.preventDefault();
    e.stopPropagation();
  });
}

/** Synchronize visual and semantic tab state without per-frame writes. */
export function refreshTabs<T extends string>(buttons: Map<T, HTMLButtonElement>,
                                               active: T,
                                               panel?: HTMLElement): void {
  for (const [tab, b] of buttons) {
    const on = tab === active;
    b.classList.toggle("active", on);
    const selected = String(on);
    if (b.getAttribute("aria-selected") !== selected) {
      b.setAttribute("aria-selected", selected);
    }
    b.tabIndex = on ? 0 : -1;
    if (on && panel !== undefined && b.id) {
      panel.setAttribute("aria-labelledby", b.id);
    }
  }
}

// --------------------------------------------------------------- modal a11y
const FOCUSABLE = [
  "button:not([disabled])", "input:not([disabled])", "select:not([disabled])",
  "textarea:not([disabled])", "a[href]", "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Keyboard containment for an overlay.
 *
 * A modal has to hold the focus ring while it is up: without this, tabbing
 * out of an open dialog walks invisibly through the toolbar and inspector
 * underneath it, and closing the dialog drops focus back to the document
 * body so the next Tab restarts from the top of the page. Marks the panel
 * as a dialog for assistive tech at the same time, which the overlays were
 * missing entirely.
 */
export class ModalFocus {
  private previous: Element | null = null;
  private panel: HTMLElement;

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Tab") return;
    const items = [...this.panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    // wrap at both ends, and pull focus in if it somehow escaped
    if (e.shiftKey && (active === first || !this.panel.contains(active))) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && (active === last || !this.panel.contains(active))) {
      first.focus();
      e.preventDefault();
    }
  };

  constructor(panel: HTMLElement, label: string) {
    this.panel = panel;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", label);
  }

  enter(): void {
    this.previous = document.activeElement;
    document.addEventListener("keydown", this.onKey, true);
    // focus the panel itself rather than its first control: landing on a
    // button makes Enter feel pre-armed, and on a scrollable body it also
    // jumps the scroll position to wherever that control happens to be
    this.panel.tabIndex = -1;
    this.panel.focus({ preventScroll: true });
  }

  exit(): void {
    document.removeEventListener("keydown", this.onKey, true);
    const prev = this.previous;
    this.previous = null;
    if (typeof HTMLElement !== "undefined" &&
        prev instanceof HTMLElement && prev.isConnected) {
      prev.focus({ preventScroll: true });
    }
    // `body.focus()` is a no-op, so a dialog opened by a shortcut rather
    // than a click would keep the focus ring inside a now-hidden panel and
    // the next Tab would resume from nowhere. Drop it explicitly.
    if (typeof this.panel.contains === "function" &&
        this.panel.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
  }
}

// -------------------------------------------------------------------- button
export interface ButtonOpts {
  icon?: string;               // inner SVG markup
  style?: "primary" | "danger" | "ghost";
  tooltip?: string;
  isActive?: () => boolean;
  isEnabled?: () => boolean;
  class?: string;
}

export function button(label: string, onClick: () => void,
                       opts: ButtonOpts = {}): Control {
  const b = el("button");
  if (opts.icon) {
    b.insertAdjacentHTML("beforeend", opts.icon);
    if (!label) b.classList.add("icon");
  }
  if (label) b.append(label);
  if (opts.style) b.classList.add(opts.style);
  if (opts.class) b.classList.add(...opts.class.split(" "));
  if (opts.tooltip) b.title = opts.tooltip;
  // `title` is not a dependable accessible name once visible shortcut text
  // is appended to an icon button. Give every icon-only control an explicit
  // name while keeping the tooltip as its mouse affordance.
  if (!label && opts.tooltip) b.setAttribute("aria-label", opts.tooltip);
  b.addEventListener("click", onClick);
  // A button that reports an active state is a TOGGLE, and its state was
  // carried by a CSS class alone - visible to a viewer, invisible to
  // assistive tech. That covers every tool in the palette and the auto-fit
  // and play buttons: a screen-reader user could not tell which tool was
  // selected, only that there were nine buttons.
  if (opts.isActive) b.setAttribute("aria-pressed", String(opts.isActive()));
  const refresh = (opts.isActive || opts.isEnabled)
    ? () => {
        if (opts.isActive) {
          const on = opts.isActive();
          b.classList.toggle("active", on);
          const s = String(on);
          if (b.getAttribute("aria-pressed") !== s) {
            b.setAttribute("aria-pressed", s); // guarded: this runs per frame
          }
        }
        if (opts.isEnabled) b.disabled = !opts.isEnabled();
      }
    : undefined;
  return { root: b, refresh };
}

// -------------------------------------------------------------------- slider
export interface SliderOpts {
  unit?: string;
  fmt?: (v: number) => string;
  log?: boolean;
  /** Blend between linear (0) and logarithmic (1) track placement. */
  logBlend?: number;
  /** Positive first nonzero value for a logarithmic slider whose min is 0. */
  logFloor?: number;
  step?: number;         // value-space rounding (e.g. 1 for integers)
  onCommit?: () => void;
  tooltip?: string;
  disabled?: () => boolean; // greyed and non-interactive while true
}

/** Fixed 3-decimal-place formatting, for positions and velocities. */
export function fmt3dp(v: number): string {
  return v.toFixed(3);
}

const RESOLUTION = 2000;

export function fmt3g(v: number): string {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e-4 && abs < 1e6) return String(parseFloat(v.toPrecision(3)));
  return v.toExponential(2);
}

/** Labelled slider with a live value readout. Log scaling maps the range
 * geometrically so masses (0.001–10000 kg) stay controllable. */
export function slider(label: string, get: () => number,
                       set: (v: number) => void, min: number, max: number,
                       opts: SliderOpts = {}): Control {
  const fmt = opts.fmt ?? fmt3g;
  // aria-label, because the visible caption is a sibling <span>, not a
  // <label for>: nothing associates the two, so assistive tech announced
  // every slider in the app as an unnamed one. The Inspector is built almost
  // entirely out of these, so that was most of the app's controls.
  const input = el("input", { type: "range", min: "0", max: String(RESOLUTION),
                              "aria-label": label });
  // The value readout doubles as a text field: click it to type an exact value.
  const val = el("input", { class: "val", type: "text", inputmode: "decimal",
                            "aria-label": `${label} (type an exact value)`,
                            title: "Click to type an exact value" });
  const row = el("div", { class: "row" },
                 el("span", { class: "lbl", text: label }), input, val);
  if (opts.tooltip) row.title = opts.tooltip;

  const zeroLogFloor = (opts.log ?? false) && min === 0 &&
    Number.isFinite(opts.logFloor) && (opts.logFloor ?? 0) > 0 &&
    (opts.logFloor ?? Infinity) < max ? opts.logFloor! : null;
  const useLog = (opts.log ?? false) && (min > 0 || zeroLogFloor !== null);
  const positiveMin = zeroLogFloor ?? min;
  const logBlend = Math.max(0, Math.min(1, opts.logBlend ?? 1));
  const valueFraction = (v: number): number => {
    const clamped = Math.max(positiveMin, Math.min(max, v));
    const linear = (clamped - positiveMin) / (max - positiveMin);
    const logarithmic = Math.log(clamped / positiveMin) /
                        Math.log(max / positiveMin);
    return linear * (1 - logBlend) + logarithmic * logBlend;
  };
  const toPos = (v: number): number => {
    if (zeroLogFloor !== null && v <= 0) return 0;
    const f = useLog ? valueFraction(v) : (v - min) / (max - min);
    const first = zeroLogFloor === null ? 0 : 1;
    return first + Math.round(Math.max(0, Math.min(1, f)) *
                              (RESOLUTION - first));
  };
  const toValue = (pos: number): number => {
    if (zeroLogFloor !== null && pos <= 0) return 0;
    const first = zeroLogFloor === null ? 0 : 1;
    const f = (pos - first) / (RESOLUTION - first);
    if (f <= 0) return positiveMin;
    if (f >= 1) return max;
    let v: number;
    if (!useLog) {
      v = min + (max - min) * f;
    } else if (logBlend === 1) {
      v = positiveMin * (max / positiveMin) ** f;
    } else {
      // Invert the monotonic linear/log blend without adding a second
      // approximation contract to the control's public behavior.
      let lo = positiveMin;
      let hi = max;
      for (let i = 0; i < 32; i++) {
        const mid = (lo + hi) / 2;
        if (valueFraction(mid) < f) lo = mid;
        else hi = mid;
      }
      v = (lo + hi) / 2;
    }
    if (opts.step) v = Math.round(v / opts.step) * opts.step;
    return v;
  };

  let dragging = false;
  let editing = false;
  const show = (v: number) => {
    if (editing) return; // don't clobber what the user is typing
    const s = opts.unit ? `${fmt(v)} ${opts.unit}` : fmt(v);
    if (val.value !== s) val.value = s; // avoid per-frame DOM writes
    // The range input's own value is a POSITION on a 0..RESOLUTION track,
    // which is what assistive tech reads out unless told otherwise - so a
    // mass of 3.2 kg was announced as "1400". aria-valuetext replaces that
    // with the quantity the user is actually setting, units and all. Guarded
    // like the write above so it is not a DOM write every frame.
    if (input.getAttribute("aria-valuetext") !== s) {
      input.setAttribute("aria-valuetext", s);
    }
  };
  input.addEventListener("input", () => {
    // A disabled control must not write, whatever route the event arrived by.
    // The browser blocks pointer and keyboard interaction with a disabled
    // input but not a programmatic dispatch, and for a control the app has
    // deliberately taken away, ignoring the event is the only safe reading.
    if (input.disabled) return;
    dragging = true;
    const v = toValue(Number(input.value));
    set(v);
    show(v);
  });
  const finishDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    opts.onCommit?.();
  };
  input.addEventListener("change", finishDrag);
  input.addEventListener("pointercancel", finishDrag);

  // The readout is a text field: clicking it lets you type an exact value.
  // Typed values are clamped to the slider's range (and its step, if any).
  val.addEventListener("focus", () => {
    editing = true;
    val.value = fmt(get()); // drop the unit so only the number is edited
    val.select();
  });
  val.addEventListener("blur", () => {
    editing = false;
    // Disabling a focused field makes the browser blur it, so this handler is
    // how a control that has just been taken away would commit the half-typed
    // value it was taken away with. Drop it and re-sync instead.
    if (val.disabled) {
      refresh();
      return;
    }
    const raw = parseFloat(val.value);
    if (Number.isFinite(raw)) {
      let v = Math.max(min, Math.min(max, raw));
      if (opts.step) v = Math.round(v / opts.step) * opts.step;
      set(v);
      opts.onCommit?.();
    }
    // unparseable input needs no error state: refresh() below rewrites the
    // field with the value that is actually in effect, which is the clearer
    // answer to "that is not a number"
    refresh(); // reformat readout and re-sync the slider knob
  });
  val.addEventListener("keydown", (e) => {
    if (e.key === "Enter") val.blur();
    else if (e.key === "Escape") { val.value = fmt(get()); val.blur(); }
    e.stopPropagation(); // keep global shortcuts from firing while typing
  });

  const refresh = () => {
    // The enabled/disabled state is settled first and unconditionally, ahead
    // of the drag guard below. It is the one thing that must not wait for an
    // interaction to finish: a control disabled while a drag is in flight
    // would otherwise stay live until the drag ended, and a drag that never
    // delivers its `change` (pointer released off-window, cancelled touch)
    // would leave it live indefinitely.
    const dis = opts.disabled?.() ?? false;
    if (input.disabled !== dis) {
      input.disabled = dis;
      val.disabled = dis;
      row.classList.toggle("disabled", dis);
      if (dis) {
        dragging = false;
        editing = false;
      }
    }
    if (dragging || editing) return;
    const v = get();
    const pos = String(toPos(v));
    if (input.value !== pos) input.value = pos;
    show(v);
  };
  refresh();
  return { root: row, refresh };
}

// ------------------------------------------------------------------ numEdit
/** Small numeric field committing on Enter/blur; shows live value otherwise. */
export function numEdit(label: string, get: () => number,
                        set: (v: number) => void, unit = "",
                        onCommit?: () => void,
                        fmt: (v: number) => string = fmt3g): Control {
  // same reasoning as slider(): the caption beside it is a plain <span>, so
  // without this the field has no name for assistive tech at all
  const input = el("input", { type: "text", inputmode: "decimal",
                              "aria-label": unit ? `${label} (${unit})` : label });
  const wrap = el("div", { class: "num-row" },
                  el("span", { class: "lbl", text: label }), input,
                  unit ? el("span", { class: "unit", text: unit }) : null);
  let focused = false;
  input.addEventListener("focus", () => {
    focused = true;
    input.select();
  });
  const commit = () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) {
      set(v);
      onCommit?.();
      input.classList.remove("error");
    } else {
      input.classList.add("error");
    }
  };
  input.addEventListener("blur", () => {
    focused = false;
    commit();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
      input.value = fmt(get());
      input.blur();
    }
    e.stopPropagation();
  });
  const refresh = () => {
    if (focused) return;
    const s = fmt(get());
    if (input.value !== s) {
      input.value = s;
      // The field has been rewritten with the real value, so whatever the
      // user typed that failed to parse is gone - keeping the red border
      // left it flagging an error against text that is no longer there.
      input.classList.remove("error");
    }
  };
  refresh();
  return { root: wrap, refresh };
}

// ----------------------------------------------------------------- checkbox
export function checkbox(label: string, get: () => boolean,
                         set: (v: boolean) => void, tooltip = "",
                         disabled?: () => boolean): Control {
  const input = el("input", { type: "checkbox" });
  const lab = el("label", { class: "checkbox" }, input, label);
  if (tooltip) lab.title = tooltip;
  input.addEventListener("change", () => {
    if (!input.disabled) set(input.checked);
  });
  const refresh = () => {
    const dis = disabled?.() ?? false;
    if (input.disabled !== dis) input.disabled = dis;
    lab.classList.toggle("disabled", dis);
    const v = get();
    if (input.checked !== v) input.checked = v;
  };
  refresh();
  return { root: lab, refresh };
}

// ---------------------------------------------------------------- segmented
/** Radio strip. `disabled` greys the whole strip and makes it inert, matching
 * what slider() does with the same option - a browser ignores clicks on a
 * disabled button, so the handler needs no guard of its own. */
export function segmented(options: string[], get: () => string,
                          set: (v: string) => void, tooltip = "",
                          disabled?: () => boolean): Control {
  // role=group so the strip reads as one control rather than as loose
  // buttons; the chosen option was marked with a CSS class only, so which
  // one was selected did not reach assistive tech at all
  const wrap = el("div", { class: "segmented", role: "group" });
  if (tooltip) {
    wrap.title = tooltip;
    wrap.setAttribute("aria-label", tooltip);
  }
  const btns = options.map((opt) => {
    const b = el("button", { text: opt });
    b.addEventListener("click", () => {
      set(opt);
      refresh();
    });
    wrap.append(b);
    return b;
  });
  const refresh = () => {
    const dis = disabled?.() ?? false;
    wrap.classList.toggle("disabled", dis);
    const cur = get();
    btns.forEach((b, i) => {
      const on = options[i] === cur;
      b.classList.toggle("active", on);
      const s = String(on);
      if (b.getAttribute("aria-pressed") !== s) b.setAttribute("aria-pressed", s);
      if (b.disabled !== dis) b.disabled = dis;
    });
  };
  refresh();
  return { root: wrap, refresh };
}

// ----------------------------------------------------------------- textEdit
/** Free-text field (names, formulas). commit returns false to flag an error. */
export function textEdit(get: () => string, commit: (s: string) => boolean,
                         placeholder = "", label = ""): Control {
  // `label` names the field for assistive tech. A placeholder is not a
  // name - it disappears the moment anything is typed - and the object-name
  // field had neither, so it announced as an unlabelled text box.
  const input = el("input", { type: "text", placeholder });
  if (label) input.setAttribute("aria-label", label);
  let focused = false;
  input.addEventListener("focus", () => {
    focused = true;
  });
  input.addEventListener("blur", () => {
    focused = false;
    input.classList.toggle("error", !commit(input.value));
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
      input.value = get();
      input.blur();
    }
    e.stopPropagation();
  });
  const refresh = () => {
    if (!focused) input.value = get();
  };
  refresh();
  return { root: input, refresh };
}

// --------------------------------------------------------------- colourEdit
/** #rrggbb for an 0-255 RGB triple, and back. The native colour input
 * speaks hex only, while bodies and walls store integer channels. */
export function rgbToHex(c: readonly number[]): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Colour swatch backed by the native picker, plus optional preset chips.
 *
 * `input` fires continuously as the user drags through the colour field,
 * so the value is applied live (you want to see it on the canvas) but the
 * undo entry is only pushed on `change`, once they settle - otherwise a
 * single pick would bury the undo stack under a hundred near-identical
 * states. */
export function colourEdit(label: string, get: () => readonly number[],
                           set: (c: [number, number, number]) => void,
                           opts: { presets?: readonly (readonly number[])[];
                                   onCommit?: () => void;
                                   tooltip?: string } = {}): Control {
  const input = el("input", { type: "color", class: "colour-well",
                              title: "Open the colour picker" });
  // the hex is editable text, so a colour can be typed or pasted exactly -
  // the native picker alone gives no way to enter a known value
  const hex = el("input", { class: "colour-hex", type: "text",
                            spellcheck: "false", maxlength: "7",
                            title: "Type or paste a hex colour" });
  const row = el("div", { class: "row" },
                 el("span", { class: "lbl", text: label }), input, hex);
  if (opts.tooltip) row.title = opts.tooltip;

  const apply = (c: [number, number, number], commit: boolean): void => {
    set(c);
    if (commit) opts.onCommit?.();
    refresh();
  };
  // `input` fires continuously while dragging through the colour field, so
  // the value is applied live; the undo entry waits for `change`, or one
  // pick would bury the stack under a hundred near-identical states
  input.addEventListener("input", () => apply(hexToRgb(input.value), false));
  input.addEventListener("change", () => apply(hexToRgb(input.value), true));

  let typing = false;
  hex.addEventListener("focus", () => { typing = true; hex.select(); });
  hex.addEventListener("blur", () => {
    typing = false;
    const ok = /^#?[0-9a-f]{6}$/i.test(hex.value.trim());
    hex.classList.toggle("error", !ok);
    if (ok) apply(hexToRgb(hex.value), true);
    else refresh();
  });
  hex.addEventListener("keydown", (e) => {
    if (e.key === "Enter") hex.blur();
    else if (e.key === "Escape") { refresh(); hex.blur(); }
    e.stopPropagation();
  });

  let chips: HTMLElement | null = null;
  const chipList: Array<{ el: HTMLElement; hex: string }> = [];
  if (opts.presets && opts.presets.length > 0) {
    chips = el("div", { class: "swatch-row colour-presets", role: "group",
                         "aria-label": `${label} presets` });
    for (const c of opts.presets) {
      const ph = rgbToHex(c);
      const b = el("button", { class: "swatch", title: `Use ${ph}`,
                                "aria-label": `Use ${ph}` });
      b.append(el("span", { class: "dot", style: `background:${ph}` }));
      b.addEventListener("click", () => apply(hexToRgb(ph), true));
      chips.append(b);
      chipList.push({ el: b, hex: ph });
    }
  }

  const wrap = chips ? el("div", { class: "colour-edit" }, row, chips) : row;
  const refresh = (): void => {
    const cur = rgbToHex(get());
    if (input.value !== cur) input.value = cur;
    if (!typing && hex.value !== cur) {
      hex.value = cur;
      hex.classList.remove("error");
    }
    // mark the palette entry in use, so the chips read as a choice rather
    // than as eight buttons that do something unrelated
    for (const c of chipList) {
      const on = c.hex === cur;
      c.el.classList.toggle("active", on);
      c.el.setAttribute("aria-pressed", String(on));
    }
  };
  refresh();
  return { root: wrap, refresh };
}

// ------------------------------------------------------------------ layout
export function section(title: string): HTMLElement {
  return el("div", { class: "section", text: title });
}

export function halfRow(...items: HTMLElement[]): HTMLElement {
  return el("div", { class: "row-half" }, ...items);
}
