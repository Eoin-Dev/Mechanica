/** Tiny DOM helpers and the reusable controls the panels are built from.
 *
 * Controls read their value through a getter and write through a setter
 * (matching the desktop widget design), and register a `refresh` that the
 * app calls every frame so the UI always reflects live simulation state —
 * unless the user is actively editing that control.
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

/** Phone-sized viewport (matches the CSS mobile breakpoint). Checked live
 * so rotation and window resizing are picked up. Gates LAYOUT choices
 * (the inspector drawer, toolbar trims). */
export function isPhone(): boolean {
  return typeof window !== "undefined" &&
         window.matchMedia("(max-width: 760px)").matches;
}

/** Touch-first device (phones AND tablets - no hover, no mouse buttons,
 * usually no keyboard). Gates WORDING and content: touch hints, no
 * keyboard/mouse references, no cursor readouts. */
export function isTouch(): boolean {
  return typeof window !== "undefined" &&
         window.matchMedia("(pointer: coarse)").matches;
}

/** Collects controls so a panel can refresh them all each frame. */
export class RefreshGroup {
  private items: Array<{ el: HTMLElement; fn: () => void; visible: boolean }> = [];
  private byEl = new Map<Element, { visible: boolean }>();
  private io: IntersectionObserver | null = null;

  /** Skip refreshing controls scrolled out of view inside `scrollRoot`.
   * A long panel (hundreds of driver/field rows) otherwise refreshes
   * every control every frame, which shows up as an fps drop just from
   * having the panel open. */
  cullWithin(scrollRoot: HTMLElement): void {
    if (typeof IntersectionObserver === "undefined") return;
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const item = this.byEl.get(e.target);
        if (item) item.visible = e.isIntersecting;
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
    if (prev instanceof HTMLElement && prev.isConnected) {
      prev.focus({ preventScroll: true });
    }
    // `body.focus()` is a no-op, so a dialog opened by a shortcut rather
    // than a click would keep the focus ring inside a now-hidden panel and
    // the next Tab would resume from nowhere. Drop it explicitly.
    if (this.panel.contains(document.activeElement)) {
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
  b.addEventListener("click", onClick);
  const refresh = (opts.isActive || opts.isEnabled)
    ? () => {
        if (opts.isActive) b.classList.toggle("active", opts.isActive());
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
  const input = el("input", { type: "range", min: "0", max: String(RESOLUTION) });
  // The value readout doubles as a text field: click it to type an exact value.
  const val = el("input", { class: "val", type: "text", inputmode: "decimal",
                            title: "Click to type an exact value" });
  const row = el("div", { class: "row" },
                 el("span", { class: "lbl", text: label }), input, val);
  if (opts.tooltip) row.title = opts.tooltip;

  const useLog = (opts.log ?? false) && min > 0;
  const toPos = (v: number): number => {
    const f = useLog
      ? Math.log(v / min) / Math.log(max / min)
      : (v - min) / (max - min);
    return Math.round(Math.max(0, Math.min(1, f)) * RESOLUTION);
  };
  const toValue = (pos: number): number => {
    const f = pos / RESOLUTION;
    let v = useLog ? min * (max / min) ** f : min + (max - min) * f;
    if (opts.step) v = Math.round(v / opts.step) * opts.step;
    return v;
  };

  let dragging = false;
  let editing = false;
  const show = (v: number) => {
    if (editing) return; // don't clobber what the user is typing
    const s = opts.unit ? `${fmt(v)} ${opts.unit}` : fmt(v);
    if (val.value !== s) val.value = s; // avoid per-frame DOM writes
  };
  input.addEventListener("input", () => {
    dragging = true;
    const v = toValue(Number(input.value));
    set(v);
    show(v);
  });
  input.addEventListener("change", () => {
    dragging = false;
    opts.onCommit?.();
  });

  // The readout is a text field: clicking it lets you type an exact value.
  // Typed values are clamped to the slider's range (and its step, if any).
  val.addEventListener("focus", () => {
    editing = true;
    val.value = fmt(get()); // drop the unit so only the number is edited
    val.select();
  });
  val.addEventListener("blur", () => {
    editing = false;
    const raw = parseFloat(val.value);
    if (Number.isFinite(raw)) {
      let v = Math.max(min, Math.min(max, raw));
      if (opts.step) v = Math.round(v / opts.step) * opts.step;
      set(v);
      opts.onCommit?.();
    }
    val.classList.remove("error");
    refresh(); // reformat readout and re-sync the slider knob
  });
  val.addEventListener("keydown", (e) => {
    if (e.key === "Enter") val.blur();
    else if (e.key === "Escape") { val.value = fmt(get()); val.blur(); }
    e.stopPropagation(); // keep global shortcuts from firing while typing
  });

  const refresh = () => {
    if (dragging || editing) return;
    const dis = opts.disabled?.() ?? false;
    if (input.disabled !== dis) {
      input.disabled = dis;
      val.disabled = dis;
      row.classList.toggle("disabled", dis);
    }
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
  const input = el("input", { type: "text", inputmode: "decimal" });
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
                         set: (v: boolean) => void, tooltip = ""): Control {
  const input = el("input", { type: "checkbox" });
  const lab = el("label", { class: "checkbox" }, input, label);
  if (tooltip) lab.title = tooltip;
  input.addEventListener("change", () => set(input.checked));
  const refresh = () => {
    const v = get();
    if (input.checked !== v) input.checked = v;
  };
  refresh();
  return { root: lab, refresh };
}

// ---------------------------------------------------------------- segmented
export function segmented(options: string[], get: () => string,
                          set: (v: string) => void, tooltip = ""): Control {
  const wrap = el("div", { class: "segmented" });
  if (tooltip) wrap.title = tooltip;
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
    const cur = get();
    btns.forEach((b, i) => b.classList.toggle("active", options[i] === cur));
  };
  refresh();
  return { root: wrap, refresh };
}

// ----------------------------------------------------------------- textEdit
/** Free-text field (names, formulas). commit returns false to flag an error. */
export function textEdit(get: () => string, commit: (s: string) => boolean,
                         placeholder = ""): Control {
  const input = el("input", { type: "text", placeholder });
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
  const input = el("input", { type: "color", class: "colour-well" });
  const row = el("div", { class: "row" },
                 el("span", { class: "lbl", text: label }), input);
  if (opts.tooltip) row.title = opts.tooltip;
  input.addEventListener("input", () => set(hexToRgb(input.value)));
  input.addEventListener("change", () => {
    set(hexToRgb(input.value));
    opts.onCommit?.();
  });

  let chips: HTMLElement | null = null;
  if (opts.presets && opts.presets.length > 0) {
    chips = el("div", { class: "swatch-row colour-presets" });
    for (const c of opts.presets) {
      const hex = rgbToHex(c);
      const b = el("button", { class: "swatch", title: hex });
      b.append(el("span", { class: "dot", style: `background:${hex}` }));
      b.addEventListener("click", () => {
        set(hexToRgb(hex));
        opts.onCommit?.();
      });
      chips.append(b);
    }
  }

  const wrap = chips ? el("div", {}, row, chips) : row;
  const refresh = () => {
    const hex = rgbToHex(get());
    if (input.value !== hex) input.value = hex;
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
