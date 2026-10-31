/** Relative mouse motion during one scrub. Never warps the operating-system pointer. */
export class ScrubPointer {
  private pending = false;
  private ended = false;
  private locked = false;
  private cursor: HTMLElement | null = null;
  private acquisitionMotion = true;
  private recentering = false;
  private nativeX: number;
  private nativeY: number;
  private readonly originX: number;
  private readonly originY: number;
  constructor(private handle: HTMLElement, private x: number, private y: number,
              private onExit: () => void) {
    this.originX = this.nativeX = x; this.originY = this.nativeY = y;
  }

  request(): void {
    if (this.ended || this.pending || this.locked || !this.handle.requestPointerLock || document.pointerLockElement) return;
    this.pending = true;
    document.addEventListener("pointerlockchange", this.change);
    document.addEventListener("pointerlockerror", this.error);
    try {
      const result = this.handle.requestPointerLock();
      // Legacy implementations return void rather than a promise.
      if (result) void result.catch(this.error);
    } catch { this.error(); }
  }

  get active(): boolean { return this.locked && document.pointerLockElement === this.handle; }
  get acquiring(): boolean { return this.pending; }

  consumeRecenter(event: PointerEvent): boolean {
    // Linux Chromium reports internal warps to (0, 0) with buttons=0 and
    // the client coordinates fixed at the lock origin or moved to (0, 0).
    // The latter can arrive before the lock grant. After acquisition the warp
    // may repeat between held moves. Require the exact inverse native delta
    // so ordinary released-button motion still ends the gesture.
    const atOrigin = Math.abs(event.clientX - this.originX) <= 0.5 && Math.abs(event.clientY - this.originY) <= 0.5;
    const atAcquisitionZero = this.pending && Math.abs(event.clientX) <= 0.5 && Math.abs(event.clientY) <= 0.5;
    if ((!this.acquisitionMotion && !this.recentering) || (!this.pending && !this.active) || !event.isTrusted || event.buttons !== 0 ||
        (event.movementX === 0 && event.movementY === 0) ||
        (!atOrigin && !atAcquisitionZero) ||
        Math.abs(event.movementX + this.nativeX) > 0.5 || Math.abs(event.movementY + this.nativeY) > 0.5) return false;
    this.acquisitionMotion = false;
    this.recentering = true;
    this.nativeX = this.nativeY = 0;
    return true;
  }

  move(dx: number, dy: number): void {
    if (!this.active || !this.cursor) return;
    if (dx !== 0 || dy !== 0) this.acquisitionMotion = false;
    this.nativeX += dx; this.nativeY += dy;
    const width = Math.max(1, window.innerWidth), height = Math.max(1, window.innerHeight);
    this.x = ((this.x + dx) % width + width) % width;
    this.y = ((this.y + dy) % height + height) % height;
    this.cursor.style.transform = `translate(${this.x}px, ${this.y}px)`;
  }

  finish(): void {
    this.ended = true;
    this.cursor?.remove(); this.cursor = null;
    if (document.pointerLockElement === this.handle) document.exitPointerLock();
    // A request can finish after release/disposal. Keep its listener until
    // it settles, so that a late grant is immediately released as well.
    if (!this.pending) this.clean();
  }

  private change = (): void => {
    this.pending = false;
    if (document.pointerLockElement === this.handle) {
      if (this.ended) { document.exitPointerLock(); this.clean(); return; }
      if (this.locked) return;
      this.locked = true;
      this.cursor = document.createElement("div");
      this.cursor.className = "numeric-scrub-cursor";
      this.cursor.setAttribute("aria-hidden", "true");
      document.body.append(this.cursor);
      this.move(0, 0);
    } else {
      const wasLocked = this.locked;
      this.locked = false;
      this.cursor?.remove(); this.cursor = null; this.clean();
      if (wasLocked && !this.ended) this.onExit();
    }
  };
  private error = (): void => { this.pending = false; this.clean(); };
  private clean(): void {
    document.removeEventListener("pointerlockchange", this.change);
    document.removeEventListener("pointerlockerror", this.error);
  }
}
