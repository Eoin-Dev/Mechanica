/** Responsive command group: inline on desktop, a light-dismiss popup when compact. */
export class CommandPopover {
  private compact: boolean | null = null;
  private open = false;
  private native: boolean;
  private outside = (event: PointerEvent): void => {
    if (event.target instanceof Node && !this.panel.contains(event.target) &&
        !this.trigger.contains(event.target)) this.close(false);
  };
  private reposition = (): void => { if (this.open) this.position(); };

  constructor(private trigger: HTMLButtonElement, private panel: HTMLElement) {
    this.native = typeof panel.showPopover === "function";
    panel.tabIndex = -1;
    trigger.setAttribute("aria-controls", panel.id);
    trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener("click", () => this.open ? this.close() : this.show());
    panel.addEventListener("click", event => {
      if (event.target instanceof Element && event.target.closest("button")) this.close();
    });
    panel.addEventListener("toggle", event => {
      if ((event as Event & { newState?: string }).newState === "closed" && this.open) this.close();
    });
    panel.addEventListener("keydown", event => {
      if (!this.open) return;
      // These keys belong to the popup, never to simulation stepping/playback.
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); this.close(); return; }
      const buttons = [...panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | undefined;
      if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
      if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = buttons.length - 1;
      if (next !== undefined && buttons[next]) { event.preventDefault(); buttons[next].focus(); }
    });
    panel.addEventListener("focusout", event => {
      // Browsers may expose BODY between blur and focus, even at a microtask
      // checkpoint. The destination keeps a pointer click inside this group
      // alive until its action runs. Outside pointer presses dismiss separately.
      const next = event.relatedTarget;
      if (this.open && next instanceof Node && !panel.contains(next) && next !== trigger) this.close(false);
    });
    this.setCompact(false);
  }

  setCompact(compact: boolean): void {
    if (this.compact === compact) return;
    const triggerFocused = document.activeElement === this.trigger;
    const focused = this.panel.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    this.close(false);
    this.compact = compact;
    this.trigger.hidden = !compact;
    this.panel.hidden = compact;
    this.panel.classList.toggle("command-popover", compact);
    if (compact && this.native) this.panel.setAttribute("popover", "auto");
    else this.panel.removeAttribute("popover");
    for (const key of ["left", "top", "max-height"]) this.panel.style.removeProperty(key);
    if (focused?.isConnected) (compact ? this.trigger : focused).focus({ preventScroll: true });
    else if (!compact && triggerFocused) this.panel.focus({ preventScroll: true });
  }

  private show(): void {
    if (!this.compact) return;
    this.open = true;
    this.panel.hidden = false;
    if (this.native) this.panel.showPopover();
    this.trigger.setAttribute("aria-expanded", "true");
    this.position();
    this.panel.scrollTop = 0;
    this.panel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", this.outside, true);
    window.addEventListener("resize", this.reposition);
    window.addEventListener("scroll", this.reposition, true);
  }

  private close(restoreFocus = true): void {
    if (!this.open) return;
    this.open = false;
    if (this.native) {
      try { if (this.panel.matches(":popover-open")) this.panel.hidePopover(); } catch { /* Older DOMs use the hidden fallback. */ }
    }
    this.panel.hidden = Boolean(this.compact);
    this.trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.outside, true);
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
    if (restoreFocus && this.compact && this.trigger.isConnected) this.trigger.focus({ preventScroll: true });
  }

  private position(): void {
    const edge = 12, gap = 8, trigger = this.trigger.getBoundingClientRect();
    const box = this.panel.getBoundingClientRect();
    const desired = this.panel.scrollHeight + 2;
    const below = innerHeight - trigger.bottom - gap - edge;
    const above = trigger.top - gap - edge;
    const down = desired <= below || below >= above;
    const height = Math.max(24, Math.min(desired, down ? below : above));
    this.panel.style.maxHeight = `${height}px`;
    this.panel.style.left = `${Math.max(edge, Math.min(innerWidth - box.width - edge, trigger.right - box.width))}px`;
    this.panel.style.top = `${Math.max(edge, down ? trigger.bottom + gap : trigger.top - gap - height)}px`;
  }
}
