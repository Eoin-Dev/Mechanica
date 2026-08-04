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

  clear(): void {
    this.frames.length = 0;
    this.keys.length = 0;
    this.keyBase = 0;
    this.haveDigest = false;
    this.structure.length = 0;
    this.bytes = 0;
  }

  push(world: World): void {
    const digest = this.digestWorld(world);
    const sameStructure = this.haveDigest && digest === this.digest &&
      structureMatches(world, this.structure);
    if (!sameStructure || this.keys.length === 0) {
      const state = snapshot(world);
      this.keys.push(state);
      this.bytes += state.length * 2;
      this.digest = digest;
      this.haveDigest = true;
      this.structure = captureStructure(world);
      this.frames.push({ key: this.keyBase + this.keys.length - 1, dyn: null });
    } else {
      const dyn = new Float64Array(world.bodies.length * DYN_STRIDE + 1);
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
  }

  /** Bytes a frame owns outright. A keyframe's string is shared with every
   * delta resting on it, so it is charged to the key, not to the frame. */
  private frameBytes(f: Frame): number {
    return f.dyn === null ? 0 : f.dyn.byteLength;
  }

  private trim(): void {
    while (this.frames.length > RewindBuffer.MAX_FRAMES ||
           (this.frames.length > 2 && this.bytes > RewindBuffer.BUDGET_BYTES)) {
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
    const world = restore(this.keys[frame.key - this.keyBase]);
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
    return this.at(this.frames.length - 1);
  }
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

/** A saved scene, or null when there is none by that name OR the stored
 * text is not usable JSON.
 *
 * `World.fromDict` tolerates any SHAPE, but `JSON.parse` still rejects
 * damaged text - a write truncated by a full quota, or an entry edited by
 * hand through devtools. That threw straight out of the card's click
 * handler, so the "Could not load" toast sitting right below this call
 * could never fire and the card simply did nothing when clicked. */
export function loadScene(name: string): World | null {
  try {
    const snap = localStorage.getItem(SCENE_PREFIX + name);
    if (snap === null) return null;
    return restore(snap);
  } catch {
    return null;
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
    // Cancelling the picker fires no `change`, only `cancel`. Every current
    // browser sends it; on one that does not, the promise simply never
    // settles and the caller's toast never fires - which is the quiet
    // failure, not a hang: nothing is awaiting it but the toast.
    input.oncancel = () => resolve(null);
    input.click();
  });
}
