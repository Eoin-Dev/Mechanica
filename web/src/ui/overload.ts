/** Persistent overload advice that follows the active simulation mode. */
import type { App, Panel } from "../app";

export class OverloadNotice implements Panel {
  private previous: string | null = null;

  constructor(private app: Pick<App, "slowReason" | "perfMode">, private root: HTMLElement) {}

  refresh(): void {
    const reason = this.app.slowReason();
    const message = reason === null ? "" : reason === "physics"
      ? this.app.perfMode
        ? "Physics is running slowly at maximum Performance speed. Try fewer bodies."
        : "Physics is running slowly. Reduce substeps, iterations or body count."
      : this.app.perfMode
        ? "Drawing is running slowly at maximum Performance speed. Try fewer bodies or a smaller window."
        : "Drawing is running slowly. Reduce trails or enable Performance mode in Settings.";
    if (message === this.previous) return;
    this.previous = message;
    this.root.hidden = message === "";
    this.root.textContent = message;
  }
}
