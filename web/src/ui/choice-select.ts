/** Theme-owned select-only combobox; native keyboard and popup ownership are explicit. */
import { el, type Control } from "./dom";
import { ICONS } from "./icons";

export interface Choice { value: string; label: string; description?: string; }
let nextId = 0;
export function choiceSelect(name: string, options: readonly Choice[] | (() => readonly Choice[]),
    get: () => string, set: (value: string) => void,
    opts: { tooltip?: string; disabled?: () => boolean } = {}): Control {
  const id = `choice-${++nextId}`;
  const label = el("span", { class: "choice-value" });
  const arrow = el("span", { class: "choice-chevron", "aria-hidden": "true" });
  arrow.innerHTML = ICONS.chev_down;
  const trigger = el("button", { type: "button", role: "combobox", class: "choice-trigger",
    "aria-label": name, "aria-haspopup": "listbox", "aria-expanded": "false", "aria-controls": id }, label, arrow);
  const menu = el("div", { id, role: "listbox", class: "choice-menu", "aria-label": name, popover: "manual" });
  menu.hidden = true;
  const root = el("div", { class: "choice-select" }, trigger, menu);
  let choices: readonly Choice[] = [], rows: HTMLElement[] = [], key = "", open = false, active = 0;
  let typed = "", typedAt = 0;
  const values = (): readonly Choice[] => typeof options === "function" ? options() : options;
  const position = (): void => {
    if (!open) return;
    const bounds = trigger.getBoundingClientRect();
    const style = getComputedStyle(menu);
    const textScale = Math.max(1, Number.parseFloat(style.getPropertyValue("--fs")) || 1);
    const width = Math.max(0, Math.min(window.innerWidth - 16, Math.max(bounds.width, 180 * textScale)));
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, bounds.left))}px`;
    const below = window.innerHeight - bounds.bottom - 12, above = bounds.top - 12;
    // Measure wrapped/enlarged options instead of assuming a fixed row height,
    // then cap the popup to the space on the side actually chosen.
    const border = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
    const desired = Math.min(300, menu.scrollHeight + border);
    const down = below >= desired || below >= above;
    menu.style.maxHeight = `${Math.max(0, Math.min(300, down ? below : above))}px`;
    menu.style.top = down ? `${bounds.bottom + 4}px` : "auto";
    menu.style.bottom = down ? "auto" : `${window.innerHeight - bounds.top + 4}px`;
    // Follow clipping, rather than hit-testing: a transient notification over
    // a focused control must not cancel keyboard navigation in its popup.
    const x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2;
    if (bounds.width > 0 && bounds.height > 0) {
      if (x < 0 || x >= window.innerWidth || y < 0 || y >= window.innerHeight) { close(); return; }
      for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
        const clip = parent.getBoundingClientRect(), overflow = getComputedStyle(parent);
        if ((/auto|scroll|hidden|clip/.test(overflow.overflowX) && (x < clip.left || x >= clip.right)) ||
            (/auto|scroll|hidden|clip/.test(overflow.overflowY) && (y < clip.top || y >= clip.bottom))) { close(); return; }
      }
    }
  };
  const mark = (): void => {
    rows.forEach((row, i) => {
      row.classList.toggle("choice-active", i === active);
      row.setAttribute("aria-selected", String(choices[i].value === get()));
    });
    if (open && rows[active]) { trigger.setAttribute("aria-activedescendant", rows[active].id); rows[active].scrollIntoView?.({ block: "nearest" }); }
  };
  const close = (): void => {
    open = false;
    typed = ""; typedAt = 0;
    try { if (menu.matches(":popover-open")) menu.hidePopover?.(); } catch { /* Unsupported selector/API. */ }
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false"); trigger.removeAttribute("aria-activedescendant");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("focusin", focusOut);
    window.removeEventListener("resize", position); document.removeEventListener("scroll", position, true);
    window.removeEventListener("blur", close);
  };
  const outside = (event: PointerEvent): void => { if (event.target instanceof Node && !root.contains(event.target)) close(); };
  const focusOut = (event: FocusEvent): void => { if (event.target instanceof Node && !root.contains(event.target)) close(); };
  const choose = (index: number): void => {
    const value = choices[index]?.value;
    if (value === undefined || trigger.disabled) return;
    close(); set(value); refresh(); if (trigger.isConnected) trigger.focus({ preventScroll: true });
  };
  const refresh = (): void => {
    choices = values();
    const signature = JSON.stringify(choices);
    if (signature !== key) {
      key = signature;
      rows = choices.map((choice, i) => {
        const row = el("div", { id: `${id}-${i}`, role: "option", class: "choice-option",
          "data-value": choice.value, text: choice.label });
        if (choice.description) row.title = choice.description;
        row.addEventListener("pointerdown", event => event.preventDefault());
        row.addEventListener("click", () => choose(i));
        row.addEventListener("pointermove", () => { if (active !== i) { active = i; mark(); } });
        return row;
      });
      menu.replaceChildren(...rows);
    }
    trigger.disabled = (opts.disabled?.() ?? false) || choices.length === 0;
    const selected = choices.find(choice => choice.value === get());
    const text = selected?.label ?? choices[0]?.label ?? "No options";
    if (label.textContent !== text) label.textContent = text;
    trigger.dataset.value = get();
    trigger.title = selected?.description ?? opts.tooltip ?? "";
    active = Math.max(0, Math.min(choices.length - 1, active)); mark();
    if (open && (!root.isConnected || trigger.disabled || root.closest("[hidden], [inert]"))) close();
    else if (open) position();
  };
  const show = (): void => {
    refresh(); if (trigger.disabled || !root.isConnected) return;
    trigger.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    open = true; active = Math.max(0, choices.findIndex(choice => choice.value === get()));
    menu.hidden = false;
    try { menu.showPopover?.(); } catch { /* Fixed popup also works without the top layer. */ }
    trigger.setAttribute("aria-expanded", "true"); position(); if (!open) return; mark();
    document.addEventListener("pointerdown", outside, true); document.addEventListener("focusin", focusOut);
    window.addEventListener("resize", position); document.addEventListener("scroll", position, true);
    window.addEventListener("blur", close);
  };
  trigger.addEventListener("click", () => open ? close() : show());
  trigger.addEventListener("keydown", event => {
    if (event.ctrlKey || event.metaKey || event.isComposing) return;
    const k = event.key;
    if (["ArrowDown", "ArrowUp", "Home", "End", " ", "Enter", "Escape"].includes(k)) {
      event.preventDefault(); event.stopPropagation();
      if (k === "Escape") { close(); return; }
      if (k === " " || k === "Enter") { if (open) choose(active); else show(); return; }
      if (!open) show();
      else if (k === "ArrowDown") active = Math.min(rows.length - 1, active + 1);
      else if (k === "ArrowUp") active = Math.max(0, active - 1);
      if (k === "Home") active = 0;
      if (k === "End") active = rows.length - 1;
      mark();
    } else if (k === "Tab") close();
    else if (k.length === 1 && !event.altKey) {
      event.preventDefault(); event.stopPropagation();
      if (!open) show();
      const now = performance.now(); typed = now - typedAt < 700 ? typed + k : k; typedAt = now;
      const match = choices.findIndex(choice => choice.label.toLowerCase().startsWith(typed.toLowerCase()));
      if (match >= 0) { active = match; mark(); }
    }
  });
  refresh();
  return { root, refresh, cancelInteraction: close, dispose: close };
}
