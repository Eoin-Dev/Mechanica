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

/** Collects controls so a panel can refresh them all each frame. */
export class RefreshGroup {
  private fns: Array<() => void> = [];

  add<T extends Control>(c: T): T {
    if (c.refresh) this.fns.push(c.refresh);
    return c;
  }

  refreshAll(): void {
    for (const fn of this.fns) fn();
  }

  clear(): void {
    this.fns = [];
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
  const val = el("span", { class: "val" });
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
  const show = (v: number) => {
    val.textContent = opts.unit ? `${fmt(v)} ${opts.unit}` : fmt(v);
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
  const refresh = () => {
    if (dragging) return;
    const v = get();
    input.value = String(toPos(v));
    show(v);
  };
  refresh();
  return { root: row, refresh };
}

// ------------------------------------------------------------------ numEdit
/** Small numeric field committing on Enter/blur; shows live value otherwise. */
export function numEdit(label: string, get: () => number,
                        set: (v: number) => void, unit = "",
                        onCommit?: () => void): Control {
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
      input.value = fmt3g(get());
      input.blur();
    }
    e.stopPropagation();
  });
  const refresh = () => {
    if (!focused) input.value = fmt3g(get());
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
    input.checked = get();
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

// ------------------------------------------------------------------ layout
export function section(title: string): HTMLElement {
  return el("div", { class: "section", text: title });
}

export function halfRow(...items: HTMLElement[]): HTMLElement {
  return el("div", { class: "row-half" }, ...items);
}
