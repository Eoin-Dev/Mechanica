/** World snapshots: undo/redo history, reset-to-start, and JSON save/load.
 *
 * The desktop app wrote scene files to a scenes/ directory; on the web,
 * saved scenes live in localStorage (instant, survives reloads) and can
 * also be exported as .json downloads / imported from files, using the
 * exact same JSON format - desktop scene files load unchanged.
 */
import { World, WorldDict } from "../engine/world";

const SCENE_PREFIX = "mechanica.scene.";
// per-scene user metadata (description, ...) lives under a separate key so
// the scene payload itself stays byte-compatible with the desktop app
const META_PREFIX = "mechanica.scenemeta.";

export function snapshot(world: World): string {
  return JSON.stringify(world.toDict());
}

export function restore(snap: string): World {
  return World.fromDict(JSON.parse(snap) as WorldDict);
}

/** Snapshot-based undo/redo. Push after every committed edit. */
export class UndoStack {
  static LIMIT = 120;

  private stack: string[];
  private index = 0;

  constructor(world: World) {
    this.stack = [snapshot(world)];
  }

  push(world: World): void {
    const snap = snapshot(world);
    if (snap === this.stack[this.index]) return;
    this.stack.length = this.index + 1;
    this.stack.push(snap);
    if (this.stack.length > UndoStack.LIMIT) this.stack.shift();
    this.index = this.stack.length - 1;
  }

  reset(world: World): void {
    this.stack = [snapshot(world)];
    this.index = 0;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.stack.length - 1;
  }

  undo(): World | null {
    if (!this.canUndo) return null;
    this.index--;
    return restore(this.stack[this.index]);
  }

  redo(): World | null {
    if (!this.canRedo) return null;
    this.index++;
    return restore(this.stack[this.index]);
  }
}

// ------------------------------------------------------- local scene storage
function safeName(name: string): string {
  const cleaned = [...name.trim()]
    .filter((ch) => /[A-Za-z0-9 _-]/.test(ch))
    .join("");
  return cleaned || "scene";
}

/** True if a saved scene already uses this (sanitized) name. Callers ask
 * before saving so an existing scene is never silently overwritten -
 * `safeName` strips punctuation, so two different-looking names can also
 * collide without the user seeing why. */
export function sceneExists(name: string): boolean {
  return localStorage.getItem(SCENE_PREFIX + safeName(name)) !== null;
}

export class SceneSaveError extends Error {}

/** Save (or overwrite) a scene in browser storage.
 *
 * Throws SceneSaveError when the browser refuses the write - a full quota
 * (scenes are the biggest thing this app stores), private-mode storage, or
 * a blocked origin. It used to throw the raw DOMException straight through
 * the click handler, which surfaced as nothing at all: the save silently
 * did not happen and the user was told it had. */
export function saveScene(world: World, name: string): string {
  const safe = safeName(name);
  try {
    localStorage.setItem(SCENE_PREFIX + safe, snapshot(world));
  } catch (exc) {
    const full = exc instanceof DOMException &&
      (exc.name === "QuotaExceededError" || exc.code === 22);
    throw new SceneSaveError(full
      ? "Browser storage is full - delete a saved scene and try again"
      : "This browser refused to save (private mode blocks storage)");
  }
  return safe;
}

export function listScenes(): string[] {
  const names: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null && key.startsWith(SCENE_PREFIX)) {
      names.push(key.slice(SCENE_PREFIX.length));
    }
  }
  return names.sort();
}

export function loadScene(name: string): World | null {
  const snap = localStorage.getItem(SCENE_PREFIX + name);
  return snap === null ? null : restore(snap);
}

export function deleteScene(name: string): void {
  localStorage.removeItem(SCENE_PREFIX + name);
  localStorage.removeItem(META_PREFIX + name);
}

/** Rename a saved scene (metadata moves with it). Returns the safe name,
 * or null if the target name is already taken. */
export function renameScene(oldName: string, newName: string): string | null {
  const safe = safeName(newName);
  if (safe === oldName) return safe;
  if (localStorage.getItem(SCENE_PREFIX + safe) !== null) return null;
  const payload = localStorage.getItem(SCENE_PREFIX + oldName);
  if (payload === null) return null;
  localStorage.setItem(SCENE_PREFIX + safe, payload);
  const meta = localStorage.getItem(META_PREFIX + oldName);
  if (meta !== null) localStorage.setItem(META_PREFIX + safe, meta);
  deleteScene(oldName);
  return safe;
}

export function sceneDescription(name: string): string {
  try {
    const meta = JSON.parse(localStorage.getItem(META_PREFIX + name) ?? "{}");
    return typeof meta.description === "string" ? meta.description : "";
  } catch {
    return "";
  }
}

export function setSceneDescription(name: string, description: string): void {
  if (description.trim() === "") {
    localStorage.removeItem(META_PREFIX + name);
  } else {
    localStorage.setItem(META_PREFIX + name,
                         JSON.stringify({ description: description.trim() }));
  }
}

// -------------------------------------------------------- file import/export
/** Offer the scene as a .json download (same format as the desktop app). */
export function downloadScene(world: World, name: string): void {
  const blob = new Blob([JSON.stringify(world.toDict(), null, 1)],
                        { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName(name)}.json`;
  a.click();
  // Revoking synchronously races the browser's own fetch of the blob:
  // Chrome usually wins, Firefox and Safari can end up saving an empty
  // file. One turn of the event loop is enough for the download to start.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Prompt for a .json scene file and parse it into a World. */
export function uploadScene(): Promise<{ world: World; name: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        const world = restore(await file.text());
        resolve({ world, name: file.name.replace(/\.json$/i, "") });
      } catch {
        resolve(null);
      }
    };
    // cancelling the picker fires no event; resolve on focus return as a
    // best effort so callers are not left hanging forever
    input.oncancel = () => resolve(null);
    input.click();
  });
}
