import type { World } from "../engine/world";
import { restore } from "./snapshot";

export const RECOVERY_KEY = "mechanica.tab-recovery";
export const MAX_RECOVERY_CHARS = 1024 * 1024;

export type RecoveryRead =
  | { status: "loaded"; world: World }
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
      const world = restore(state);
      this.previous = state;
      return { status: "loaded", world };
    } catch {
      return { status: "invalid" };
    }
  }

  write(state: string): RecoveryWrite {
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
