import { button, el } from "./dom";
import { ICONS } from "./icons";

interface Notice {
  root: HTMLElement;
  remove: () => void;
  plainMessage?: string;
  severity?: "error";
  renew: () => void;
}

/** Bounded feedback that stays available while the user reads or dismisses it. */
export class Toasts {
  private notices: Notice[] = [];

  constructor(private host: HTMLElement) {}

  show(message: string, options?: { title?: string; icon?: string; refresh?: boolean; severity?: "error";
    action?: { label: string; run: () => void } }): void {
    // Repeated help keeps its existing focus/hover state and gets fresh reading
    // time. Special notices remain separate so actions and refresh cues survive.
    const special = options?.title !== undefined;
    if (!special) {
      const existing = this.notices.find(notice => notice.plainMessage === message && notice.severity === options?.severity);
      if (existing) { existing.renew(); return; }
    }
    const opener = document.activeElement;
    const root = el("div", { class: "toast" });
    if (options?.severity === "error") {
      root.classList.add("toast-error"); root.setAttribute("role", "alert");
    }
    const text = el("span", { class: "toast-message", text: message });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hovering = false;
    let removed = false;
    const duration = Math.min(12_000, Math.max(3200, 1400 + message.length * 40));
    const clear = (): void => {
      clearTimeout(timer);
      timer = undefined;
      root.style.opacity = "";
    };
    const remove = (): void => {
      if (removed) return;
      removed = true;
      clear();
      const focused = root.contains(document.activeElement);
      root.remove();
      this.notices = this.notices.filter(notice => notice.root !== root);
      if (focused) {
        const next = this.notices.at(-1)?.root.querySelector("button");
        if (next) next.focus();
        else if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      }
    };
    const resume = (): void => {
      clear();
      if (removed || hovering || root.contains(document.activeElement)) return;
      timer = setTimeout(() => {
        root.style.opacity = "0";
        timer = setTimeout(remove, 320);
      }, duration);
    };
    if (special) {
      root.classList.add("toast-special");
      const icon = el("span", { class: "toast-symbol", "aria-hidden": "true" });
      if (options.icon) icon.innerHTML = options.icon;
      root.append(icon);
      const heading = el("strong", { class: "toast-title", text: options?.title ?? "" });
      if (options.refresh) root.classList.add("toast-refresh");
      const copy = el("div", { class: "toast-copy" }, heading, message ? text : null);
      root.append(copy);
      if (options.action) root.append(button(options.action.label, () => {
        remove(); options.action!.run();
      }, { style: "ghost", class: "toast-action" }).root);
    } else {
      root.classList.add("toast-plain");
      // The neutral information glyph balances the equally sized dismiss
      // control, keeping both short and wrapped messages truly centred.
      const indicator = el("span", { class: "toast-indicator", "aria-hidden": "true" });
      indicator.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/>' +
        '<path d="M12 11 V16"/><circle class="fill" cx="12" cy="7.5" r="1"/></svg>';
      root.append(indicator, text);
    }
    root.append(button("", remove, {
      icon: ICONS.close, style: "ghost", class: "toast-close",
      tooltip: "Dismiss notification",
    }).root);
    root.addEventListener("pointerenter", () => { hovering = true; clear(); });
    root.addEventListener("pointerleave", () => { hovering = false; resume(); });
    root.addEventListener("focusin", clear);
    root.addEventListener("focusout", () => queueMicrotask(resume));
    this.notices.push({ root, remove, plainMessage: special ? undefined : message,
      severity: options?.severity, renew: resume });
    this.host.append(root);
    while (this.notices.length > 3) this.notices[0].remove();
    this.host.scrollTop = this.host.scrollHeight;
    resume();
  }
}
