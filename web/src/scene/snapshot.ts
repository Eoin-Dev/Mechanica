/** World snapshots: undo/redo history, reset-to-start, and JSON save/load.
 *
 * The desktop app wrote scene files to a scenes/ directory; on the web,
 * saved scenes live in localStorage (instant, survives reloads) and can
 * also be exported as .json downloads / imported from files, using the
 * exact same JSON format - desktop scene files load unchanged.
 */
import { SceneLimitError, World, WorldDict } from "../engine/world";

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

/** Rebuild a snapshot produced by this running application without applying
 * import normalization. Runtime angles deliberately accumulate beyond one
 * turn, so undo, rewind, reset, and time-jump copies must preserve them
 * exactly. Saved and uploaded scenes continue through {@link restore}, the
 * untrusted-input boundary. */
export function restoreSnapshot(snap: string): World {
  return World.fromDict(JSON.parse(snap) as WorldDict, true);
}

// ------------------------------------------------------------ rewind buffer
/** Numbers of dynamic state stored per body: position, velocity, angle,
 * spin. Everything else a body serializes is edited by the user, never by
 * the simulation. */
const DYN_STRIDE = 6;

// Scratch for hashing a double exactly: writing it and reading the two
// halves back is the cheapest way to fold a float's full precision into an
// integer hash, and this runs over every non-dynamic field every frame.
const HASH_F64 = new Float64Array(1);
const HASH_U32 = new Uint32Array(HASH_F64.buffer);

function mixNumber(h: number, v: number): number {
  HASH_F64[0] = v;
  h = Math.imul(h ^ HASH_U32[0], 2654435761);
  return Math.imul(h ^ HASH_U32[1], 2246822519) | 0;
}

function mixString(h: number, s: string): number {
  h = Math.imul(h ^ s.length, 2654435761);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 2246822519);
  return h | 0;
}

type StructuralValue = number | string;

/** Visit every serialized value that a compact rewind frame does not carry.
 * The digest, exact keyframe comparison, and captured structural state all
 * share this traversal so none of them can silently omit a field. */
function visitStructuralValues(world: World,
                               visit: (value: StructuralValue) => boolean): boolean {
  if (!visit(world.gravity)) return false;
  if (!visit(world.mutualGravity ? 1 : 0)) return false;
  if (!visit(world.pointGravity ? 1 : 0)) return false;
  if (!visit(world.G)) return false;
  if (!visit(world.softening)) return false;
  if (!visit(world.dragLinear)) return false;
  if (!visit(world.dragQuadratic)) return false;
  if (!visit(world.globalDamping)) return false;
  if (!visit(world.integrator)) return false;
  if (!visit(world.substeps)) return false;
  if (!visit(world.iterations)) return false;
  if (!visit(world.bodies.length)) return false;
  for (const b of world.bodies) {
    if (!visit(b.id)) return false;
    if (!visit(b.name)) return false;
    if (!visit(b.mass)) return false;
    if (!visit(b.radius)) return false;
    if (!visit(b.restitution)) return false;
    if (!visit(b.friction)) return false;
    if (!visit(b.constForce.x)) return false;
    if (!visit(b.constForce.y)) return false;
    if (!visit((b.locked ? 1 : 0) | (b.collides ? 2 : 0) |
               (b.noRotation ? 4 : 0) | (b.isAnchor ? 8 : 0))) return false;
    if (!visit(b.color[0])) return false;
    if (!visit(b.color[1])) return false;
    if (!visit(b.color[2])) return false;
  }
  if (!visit(world.walls.length)) return false;
  for (const w of world.walls) {
    if (!visit(w.id)) return false;
    if (!visit(w.name)) return false;
    if (!visit(w.a.x)) return false;
    if (!visit(w.a.y)) return false;
    if (!visit(w.b.x)) return false;
    if (!visit(w.b.y)) return false;
    if (!visit(w.thickness)) return false;
    if (!visit(w.restitution)) return false;
    if (!visit(w.friction)) return false;
    if (!visit(w.color[0])) return false;
    if (!visit(w.color[1])) return false;
    if (!visit(w.color[2])) return false;
  }
  if (!visit(world.links.length)) return false;
  for (const ln of world.links) {
    if (!visit(ln.id)) return false;
    if (!visit(ln.a.id)) return false;
    if (!visit(ln.b.id)) return false;
    if ("stiffness" in ln) {
      if (!visit(1)) return false;
      if (!visit(ln.restLength)) return false;
      if (!visit(ln.stiffness)) return false;
      if (!visit(ln.damping)) return false;
      if (!visit(ln.tensionOnly ? 1 : 0)) return false;
    } else {
      if (!visit(2)) return false;
      if (!visit(ln.length)) return false;
      if (!visit(ln.isRope ? 1 : 0)) return false;
      if (!visit(ln.compliance)) return false;
    }
  }
  if (!visit(world.fields.length)) return false;
  for (const f of world.fields) {
    if (!visit(f.name)) return false;
    if (!visit(f.fxSrc)) return false;
    if (!visit(f.fySrc)) return false;
    if (!visit(f.enabled ? 1 : 0)) return false;
  }
  if (!visit(world.drivers.length)) return false;
  for (const d of world.drivers) {
    if (!visit(d.bodyId)) return false;
    if (!visit(d.amplitude)) return false;
    if (!visit(d.frequency)) return false;
    if (!visit(d.phase)) return false;
    if (!visit(d.angle)) return false;
    if (!visit(d.enabled ? 1 : 0)) return false;
  }
  return true;
}

/** Fast, non-authoritative hash of structural state. Rewind uses it to skip
 * an exact comparison when structures obviously differ; matching hashes are
 * always confirmed value-for-value before a dynamic delta is stored. */
export function structuralDigest(world: World): number {
  let h = 0x9e3779b9;
  visitStructuralValues(world, (value) => {
    h = typeof value === "number" ? mixNumber(h, value) : mixString(h, value);
    return true;
  });
  return h;
}

function captureStructure(world: World): StructuralValue[] {
  const values: StructuralValue[] = [];
  visitStructuralValues(world, (value) => { values.push(value); return true; });
  return values;
}

function structureMatches(world: World, expected: readonly StructuralValue[]): boolean {
  let i = 0;
  const complete = visitStructuralValues(world, (value) => {
    if (i >= expected.length || value !== expected[i]) return false;
    i++;
    return true;
  });
  return complete && i === expected.length;
}

interface Frame {
  key: number;             // index into `keys` of the snapshot this rests on
  dyn: Float64Array | null; // null when the frame IS the keyframe's state
}

export type RewindStoreResult = "stored" | "too-large";

/** Rolling per-frame rewind history.
 *
 * A full JSON snapshot per frame was, on the densest scenes, five times
 * the cost of the physics step it recorded - not because of the object
 * graph (that is 3% of it) but because `JSON.stringify` must render every
 * double as shortest-round-trip text, which is a couple of hundred
 * nanoseconds apiece and there are thousands of them.
 *
 * Only six numbers per body actually change as the simulation runs, so a
 * frame normally stores just those, as a flat Float64Array, against the
 * last full snapshot. A new snapshot is taken when the structural digest
 * differs or an exact value comparison rejects a matching digest. A compact
 * delta is therefore stored only when every omitted value still equals its
 * keyframe value.
 *
 * The buffer is bounded in bytes rather than frames, since one scene's
 * frame can cost a thousand times another's.
 */
export class RewindBuffer {
  /** Roughly 48 MB: generous for rewind, small enough not to eat the heap. */
  static BUDGET_BYTES = 48_000_000;
  static MAX_FRAMES = 3000;

  private frames: Frame[] = [];
  private keys: string[] = [];
  private keyBase = 0;      // index of keys[0] in the original numbering
  private digest = 0;
  private haveDigest = false;
  private structure: StructuralValue[] = [];
  private bytes = 0;

  constructor(private readonly digestWorld: (world: World) => number = structuralDigest) {}

  get length(): number { return this.frames.length; }
  get bytesUsed(): number { return this.bytes; }

  clear(): void {
    this.frames.length = 0;
    this.keys.length = 0;
    this.keyBase = 0;
    this.haveDigest = false;
    this.structure.length = 0;
    this.bytes = 0;
  }

  push(world: World): RewindStoreResult {
    const digest = this.digestWorld(world);
    const sameStructure = this.haveDigest && digest === this.digest &&
      structureMatches(world, this.structure);
    if (!sameStructure || this.keys.length === 0) {
      const state = snapshot(world);
      if (state.length * 2 > RewindBuffer.BUDGET_BYTES) {
        this.clear();
        return "too-large";
      }
      this.keys.push(state);
      this.bytes += state.length * 2;
      this.digest = digest;
      this.haveDigest = true;
      this.structure = captureStructure(world);
      this.frames.push({ key: this.keyBase + this.keys.length - 1, dyn: null });
    } else {
      const dyn = new Float64Array(world.bodies.length * DYN_STRIDE + 1);
      if (dyn.byteLength > RewindBuffer.BUDGET_BYTES) {
        this.clear();
        return "too-large";
      }
      let i = 0;
      for (const b of world.bodies) {
        dyn[i] = b.pos.x;
        dyn[i + 1] = b.pos.y;
        dyn[i + 2] = b.vel.x;
        dyn[i + 3] = b.vel.y;
        dyn[i + 4] = b.angle;
        dyn[i + 5] = b.omega;
        i += DYN_STRIDE;
      }
      dyn[i] = world.time;
      this.bytes += dyn.byteLength;
      this.frames.push({ key: this.keyBase + this.keys.length - 1, dyn });
    }
    this.trim();
    // A single delta still owns its keyframe. If that pair cannot fit the
    // byte budget, retain the latest state as one ordinary keyframe and
    // start collecting rewind history again from there.
    if (this.bytes > RewindBuffer.BUDGET_BYTES) {
      const state = snapshot(world);
      this.clear();
      if (state.length * 2 > RewindBuffer.BUDGET_BYTES) return "too-large";
      this.keys.push(state);
      this.bytes = state.length * 2;
      this.digest = digest;
      this.haveDigest = true;
      this.structure = captureStructure(world);
      this.frames.push({ key: 0, dyn: null });
    }
    return "stored";
  }

  /** Bytes a frame owns outright. A keyframe's string is shared with every
   * delta resting on it, so it is charged to the key, not to the frame. */
  private frameBytes(f: Frame): number {
    return f.dyn === null ? 0 : f.dyn.byteLength;
  }

  private trim(): void {
    while (this.frames.length > RewindBuffer.MAX_FRAMES ||
           (this.frames.length > 1 && this.bytes > RewindBuffer.BUDGET_BYTES)) {
      this.bytes -= this.frameBytes(this.frames.shift()!);
      // a keyframe is reclaimable once no surviving frame rests on it
      const oldest = this.frames.length > 0 ? this.frames[0].key : this.keyBase;
      while (this.keyBase < oldest && this.keys.length > 0) {
        this.bytes -= this.keys.shift()!.length * 2;
        this.keyBase++;
      }
    }
  }

  /** Rebuild the world recorded by frame `i`. */
  private at(i: number): World {
    const frame = this.frames[i];
    const world = restoreSnapshot(this.keys[frame.key - this.keyBase]);
    const dyn = frame.dyn;
    // Exact structural comparison guarantees the body list matches its
    // keyframe. Keep the length guard as a final corruption boundary rather
    // than reading past the end of a damaged array.
    if (dyn !== null && dyn.length === world.bodies.length * DYN_STRIDE + 1) {
      let k = 0;
      for (const b of world.bodies) {
        b.pos.x = dyn[k];
        b.pos.y = dyn[k + 1];
        b.vel.x = dyn[k + 2];
        b.vel.y = dyn[k + 3];
        b.angle = dyn[k + 4];
        b.omega = dyn[k + 5];
        k += DYN_STRIDE;
      }
      world.time = dyn[k];
    }
    return world;
  }

  /** Drop the frame the caller is on and return the one before it, or null
   * when there is no earlier frame to go back to. */
  back(): World | null {
    if (this.frames.length < 2) return null;
    this.bytes -= this.frameBytes(this.frames.pop()!);
    const newestKey = this.frames[this.frames.length - 1].key;
    while (this.keys.length > 0 &&
           this.keyBase + this.keys.length - 1 > newestKey) {
      this.bytes -= this.keys.pop()!.length * 2;
    }
    // Future pushes compare against the latest surviving keyframe, not the
    // structural state of the frame that was just discarded.
    const current = this.at(this.frames.length - 1);
    this.digest = this.digestWorld(current);
    this.haveDigest = true;
    this.structure = captureStructure(current);
    return current;
  }
}

/** Result of storing a committed edit in snapshot history. */
export type HistoryStoreResult = "unchanged" | "stored" | "too-large";

/** Snapshot-based undo/redo. Push after every committed edit. */
export class UndoStack {
  static LIMIT = 120;
  /** Full snapshots are UTF-16 strings in the JavaScript heap. */
  static BUDGET_BYTES = 48_000_000;

  private stack: string[];
  private index = 0;
  private bytes = 0;

  constructor(world: World) {
    const state = snapshot(world);
    this.stack = [state];
    this.bytes = UndoStack.cost(state);
  }

  private static cost(state: string): number {
    return state.length * 2;
  }

  get bytesUsed(): number { return this.bytes; }

  private replaceWith(state: string): void {
    this.stack = [state];
    this.index = 0;
    this.bytes = UndoStack.cost(state);
  }

  private dropRedo(): void {
    for (let i = this.index + 1; i < this.stack.length; i++) {
      this.bytes -= UndoStack.cost(this.stack[i]);
    }
    this.stack.length = this.index + 1;
  }

  private append(state: string): void {
    this.stack.push(state);
    this.bytes += UndoStack.cost(state);
    this.index = this.stack.length - 1;
  }

  private trim(): void {
    while (this.stack.length > 1 &&
           (this.stack.length > UndoStack.LIMIT ||
            this.bytes > UndoStack.BUDGET_BYTES)) {
      this.bytes -= UndoStack.cost(this.stack.shift()!);
      this.index--;
    }
  }

  push(world: World): HistoryStoreResult {
    return this.pushSnapshot(snapshot(world));
  }

  pushSnapshot(state: string): HistoryStoreResult {
    if (state === this.stack[this.index]) return "unchanged";
    if (UndoStack.cost(state) > UndoStack.BUDGET_BYTES) {
      this.replaceWith(state);
      return "too-large";
    }
    this.dropRedo();
    this.append(state);
    this.trim();
    return "stored";
  }

  /** Record an edit atomically, including the live state immediately before
   * it. That state may differ from the last committed entry because physics
   * can advance between edits. */
  pushTransition(before: string, after: string): HistoryStoreResult {
    if (before === after) return "unchanged";
    const beforeCost = UndoStack.cost(before);
    const afterCost = UndoStack.cost(after);
    if (beforeCost > UndoStack.BUDGET_BYTES ||
        afterCost > UndoStack.BUDGET_BYTES ||
        beforeCost + afterCost > UndoStack.BUDGET_BYTES) {
      this.replaceWith(after);
      return "too-large";
    }
    this.dropRedo();
    if (before !== this.stack[this.index]) this.append(before);
    this.append(after);
    this.trim();
    return "stored";
  }

  reset(world: World): HistoryStoreResult {
    const state = snapshot(world);
    this.replaceWith(state);
    return UndoStack.cost(state) > UndoStack.BUDGET_BYTES ? "too-large" : "stored";
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
    return restoreSnapshot(this.stack[this.index]);
  }

  redo(): World | null {
    if (!this.canRedo) return null;
    this.index++;
    return restoreSnapshot(this.stack[this.index]);
  }
}

// ------------------------------------------------------- local scene storage
/** Sanitize a user-supplied scene name into a storage key.
 *
 * Letters and digits in ANY script are kept: these are localStorage keys,
 * not filesystem paths, so there is no reason to restrict them to ASCII -
 * and doing so silently mangled perfectly ordinary names ("Épreuve" saved
 * as "preuve", "実験" as "scene"), which also made unrelated names collide
 * and overwrite one another. What is stripped is only what makes a key
 * ambiguous or unreadable: control characters, and punctuation beyond
 * space/underscore/hyphen. Length is capped so one name cannot fill the
 * storage quota on its own. The .json download path re-sanitizes for the
 * filesystem separately. */
function safeName(name: string): string {
  const cleaned = [...name.normalize("NFC").trim()]
    .filter((ch) => /[\p{L}\p{N} _-]/u.test(ch))
    .join("")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
  return cleaned || "scene";
}

/** True if a saved scene already uses this (sanitized) name. Callers ask
 * before saving so an existing scene is never silently overwritten -
 * `safeName` strips punctuation, so two different-looking names can also
 * collide without the user seeing why. */
export function sceneExists(name: string): boolean {
  try {
    return localStorage.getItem(SCENE_PREFIX + safeName(name)) !== null;
  } catch (exc) {
    throw storageError(exc, "read");
  }
}

export class SceneSaveError extends Error {}

export const MAX_SCENE_FILE_BYTES = 10 * 1024 * 1024;

export type SceneReadResult =
  | { status: "loaded"; world: World; name: string }
  | { status: "cancelled" }
  | { status: "missing"; name: string }
  | { status: "invalid"; name: string }
  | { status: "too-large"; name: string; message: string }
  | { status: "storage-error"; name: string; message: string };

function sceneLimitMessage(error: SceneLimitError): string {
  return `Scene has ${error.actual.toLocaleString()} ${error.collection}; ` +
    `the limit is ${error.limit.toLocaleString()}`;
}

function storageError(exc: unknown, action: string): SceneSaveError {
  const full = exc instanceof DOMException &&
    (exc.name === "QuotaExceededError" || exc.code === 22);
  return new SceneSaveError(full
    ? "Browser storage is full - delete a saved scene and try again"
    : `This browser refused to ${action} the scene`);
}

/** Restore a small set of local-storage keys after a multi-key operation
 * fails. Cleanup is deliberately best-effort because the same browser policy
 * that rejected the original operation may reject rollback too. Writes are
 * ordered so ordinary quota failures occur before source data is removed. */
function restoreKeys(entries: ReadonlyArray<readonly [string, string | null]>): void {
  for (const [key, value] of entries) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // The original SceneSaveError remains the useful failure for the UI.
    }
  }
}

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
    throw storageError(exc, "save");
  }
  return safe;
}

export function listScenes(): string[] {
  try {
    const names: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(SCENE_PREFIX)) {
        names.push(key.slice(SCENE_PREFIX.length));
      }
    }
    return names.sort();
  } catch (exc) {
    throw storageError(exc, "read");
  }
}

/** Read a saved scene without conflating absence, damaged data, resource
 * limits, and a browser storage rejection. */
export function loadScene(name: string): SceneReadResult {
  let state: string | null;
  try {
    state = localStorage.getItem(SCENE_PREFIX + name);
  } catch (exc) {
    return { status: "storage-error", name,
             message: storageError(exc, "read").message };
  }
  if (state === null) return { status: "missing", name };
  try {
    return { status: "loaded", world: restore(state), name };
  } catch (exc) {
    if (exc instanceof SceneLimitError) {
      return { status: "too-large", name, message: sceneLimitMessage(exc) };
    }
    return { status: "invalid", name };
  }
}

export function deleteScene(name: string): void {
  const payloadKey = SCENE_PREFIX + name;
  const metaKey = META_PREFIX + name;
  let payload: string | null;
  let meta: string | null;
  try {
    payload = localStorage.getItem(payloadKey);
    meta = localStorage.getItem(metaKey);
  } catch (exc) {
    throw storageError(exc, "delete");
  }
  try {
    localStorage.removeItem(payloadKey);
    localStorage.removeItem(metaKey);
  } catch (exc) {
    restoreKeys([[payloadKey, payload], [metaKey, meta]]);
    throw storageError(exc, "delete");
  }
}

/** Rename a saved scene (metadata moves with it). Returns the safe name,
 * or null if the target name is already taken. */
export function renameScene(oldName: string, newName: string): string | null {
  const safe = safeName(newName);
  if (safe === oldName) return safe;
  const oldPayloadKey = SCENE_PREFIX + oldName;
  const oldMetaKey = META_PREFIX + oldName;
  const newPayloadKey = SCENE_PREFIX + safe;
  const newMetaKey = META_PREFIX + safe;
  let payload: string | null;
  let meta: string | null;
  let previousTargetMeta: string | null;
  try {
    if (localStorage.getItem(newPayloadKey) !== null) return null;
    payload = localStorage.getItem(oldPayloadKey);
    meta = localStorage.getItem(oldMetaKey);
    previousTargetMeta = localStorage.getItem(newMetaKey);
  } catch (exc) {
    throw storageError(exc, "rename");
  }
  if (payload === null) return null;
  try {
    // Finish every potentially quota-consuming write before deleting the
    // source. An unreferenced metadata key at the destination must not leak
    // into a renamed scene that has no description.
    localStorage.setItem(newPayloadKey, payload);
    if (meta === null) localStorage.removeItem(newMetaKey);
    else localStorage.setItem(newMetaKey, meta);
    localStorage.removeItem(oldPayloadKey);
    localStorage.removeItem(oldMetaKey);
  } catch (exc) {
    // Remove the copies first so restoring the source has the same quota
    // footprint as it did before the operation began.
    restoreKeys([[newPayloadKey, null], [newMetaKey, previousTargetMeta],
                 [oldPayloadKey, payload], [oldMetaKey, meta]]);
    throw storageError(exc, "rename");
  }
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
  const key = META_PREFIX + name;
  let previous: string | null;
  try {
    previous = localStorage.getItem(key);
  } catch (exc) {
    throw storageError(exc, "update");
  }
  try {
    if (description.trim() === "") {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key,
                           JSON.stringify({ description: description.trim() }));
    }
  } catch (exc) {
    restoreKeys([[key, previous]]);
    throw storageError(exc, "update");
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
  // the storage key may hold any script; a download name additionally has
  // to survive a filesystem, so fold anything exotic to an underscore -
  // falling back to "scene" rather than handing over a row of them
  const folded = safeName(name).replace(/[^A-Za-z0-9 _-]/g, "_");
  a.download = `${/[A-Za-z0-9]/.test(folded) ? folded : "scene"}.json`;
  a.click();
  // Revoking synchronously races the browser's own fetch of the blob:
  // Chrome usually wins, Firefox and Safari can end up saving an empty
  // file. One turn of the event loop is enough for the download to start.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Parse the browser file selected by uploadScene. Kept separate so size and
 * failure behavior are testable without opening a native file picker. */
export async function readSceneFile(
  file: Pick<File, "name" | "size" | "text">,
): Promise<SceneReadResult> {
  const name = file.name.replace(/\.json$/i, "");
  if (file.size > MAX_SCENE_FILE_BYTES) {
    return { status: "too-large", name,
             message: `Scene file exceeds the ${MAX_SCENE_FILE_BYTES / (1024 * 1024)} MiB limit` };
  }
  try {
    const world = restore(await file.text());
    return { status: "loaded", world, name };
  } catch (exc) {
    if (exc instanceof SceneLimitError) {
      return { status: "too-large", name, message: sceneLimitMessage(exc) };
    }
    return { status: "invalid", name };
  }
}

/** Prompt for a size-bounded .json scene file and parse it into a World. */
export function uploadScene(): Promise<SceneReadResult> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve({ status: "cancelled" });
        return;
      }
      resolve(await readSceneFile(file));
    };
    // Cancelling the picker fires no `change`, only `cancel`. Every current
    // browser sends it; on one that does not, the promise simply never
    // settles and the caller's toast never fires - which is the quiet
    // failure, not a hang: nothing is awaiting it but the toast.
    input.oncancel = () => resolve({ status: "cancelled" });
    input.click();
  });
}
