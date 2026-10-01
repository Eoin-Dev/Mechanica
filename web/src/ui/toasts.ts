import { button, el } from "./dom";
import { ICONS } from "./icons";

interface Notice {
  root: HTMLElement;
  remove: () => void;
}

/** Bounded feedback that stays available while the user reads or dismisses it. */
export class Toasts {
  private notices: Notice[] = [];

  constructor(private host: HTMLElement) {}

  show(message: string): void {
    const opener = document.activeElement;
    const root = el("div", { class: "toast" });
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
    root.append(text, button("", remove, {
      icon: ICONS.close, style: "ghost", class: "toast-close",
      tooltip: "Dismiss notification",
    }).root);
    root.addEventListener("pointerenter", () => { hovering = true; clear(); });
    root.addEventListener("pointerleave", () => { hovering = false; resume(); });
    root.addEventListener("focusin", clear);
    root.addEventListener("focusout", () => queueMicrotask(resume));
    this.notices.push({ root, remove });
    this.host.append(root);
    while (this.notices.length > 3) this.notices[0].remove();
    this.host.scrollTop = this.host.scrollHeight;
    resume();
  }
}
