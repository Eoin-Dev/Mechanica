import type { World } from "../engine/world";
import { restore } from "./snapshot";

export const RECOVERY_KEY = "mechanica.tab-recovery";
export const MAX_RECOVERY_CHARS = 1024 * 1024;

export type RecoveryRead =
  | { status: "loaded"; world: World; presentation?: unknown; initial?: World }
  | { status: "missing" | "invalid" | "too-large" | "unavailable" };
export type RecoveryWrite = "saved" | "unchanged" | "too-large" | "unavailable";

/** One bounded checkpoint per browser tab. Session storage isolates tabs and
 * survives reloads without consuming the quota reserved for named scenes. */
export class TabRecovery {
  private previous: string | null = null;

  constructor(private storage: () => Pick<Storage, "getItem" | "setItem">) {}

  read(): RecoveryRead {
    let state: string | null;
    try {
      state = this.storage().getItem(RECOVERY_KEY);
    } catch {
      return { status: "unavailable" };
    }
    if (state === null) return { status: "missing" };
    if (state.length > MAX_RECOVERY_CHARS) return { status: "too-large" };
    try {
      const data: unknown = JSON.parse(state);
      const envelope = data !== null && typeof data === "object" && !Array.isArray(data)
        ? data as Record<string, unknown> : null;
      if (envelope?.kind === "mechanica-tab") {
        if (envelope.version !== 1 || typeof envelope.scene !== "string") return { status: "invalid" };
        const world = restore(envelope.scene);
        let initial: World | undefined;
        if (typeof envelope.initial === "string") {
          try { initial = restore(envelope.initial); } catch { /* Keep the valid live scene. */ }
        }
        this.previous = state;
        return { status: "loaded", world, presentation: envelope.presentation, initial };
      }
      const world = restore(state);
      this.previous = state;
      return { status: "loaded", world };
    } catch {
      return { status: "invalid" };
    }
  }

  write(scene: string, presentation?: unknown, initial?: string | null): RecoveryWrite {
    let state: string;
    try {
      state = presentation === undefined ? scene : JSON.stringify({
        kind: "mechanica-tab", version: 1, scene, presentation, initial,
      });
    } catch { return "unavailable"; }
    if (state === this.previous) return "unchanged";
    if (state.length > MAX_RECOVERY_CHARS) return "too-large";
    try {
      this.storage().setItem(RECOVERY_KEY, state);
      this.previous = state;
      return "saved";
    } catch {
      return "unavailable";
    }
  }
}
