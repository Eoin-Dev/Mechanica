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

/** Hash of everything a world serializes EXCEPT the per-body dynamic state
 * and the clock.
 *
 * The rewind buffer stores a full snapshot only when this changes, and a
 * flat array of the dynamic numbers otherwise. That is exact rather than
 * approximate: if the digest is unchanged, every field the delta does not
 * carry is by construction the same as in the keyframe it is applied to.
 *
 * It is worth the pass because the alternative is not "no work" but
 * `JSON.stringify`, which has to render three thousand doubles as
 * shortest-round-trip text at a couple of hundred nanoseconds each. Hashing
 * the same values costs single-digit nanoseconds apiece.
 */
export function structuralDigest(world: World): number {
  let h = 0x9e3779b9;
  h = mixNumber(h, world.gravity);
  h = mixNumber(h, world.mutualGravity ? 1 : 0);
  h = mixNumber(h, world.pointGravity ? 1 : 0);
  h = mixNumber(h, world.G);
  h = mixNumber(h, world.softening);
  h = mixNumber(h, world.dragLinear);
  h = mixNumber(h, world.dragQuadratic);
  h = mixNumber(h, world.globalDamping);
  h = mixString(h, world.integrator);
  h = mixNumber(h, world.substeps);
  h = mixNumber(h, world.iterations);
  h = mixNumber(h, world.bodies.length);
  for (const b of world.bodies) {
    h = mixNumber(h, b.id);
    h = mixString(h, b.name);
    h = mixNumber(h, b.mass);
    h = mixNumber(h, b.radius);
    h = mixNumber(h, b.restitution);
    h = mixNumber(h, b.friction);
    h = mixNumber(h, b.constForce.x);
    h = mixNumber(h, b.constForce.y);
    h = mixNumber(h, (b.locked ? 1 : 0) | (b.collides ? 2 : 0) |
                     (b.noRotation ? 4 : 0) | (b.isAnchor ? 8 : 0));
    h = mixNumber(h, b.color[0] * 65536 + b.color[1] * 256 + b.color[2]);
  }
  h = mixNumber(h, world.walls.length);
  for (const w of world.walls) {
    h = mixNumber(h, w.id);
    h = mixString(h, w.name);
    h = mixNumber(h, w.a.x);
    h = mixNumber(h, w.a.y);
    h = mixNumber(h, w.b.x);
    h = mixNumber(h, w.b.y);
    h = mixNumber(h, w.thickness);
    h = mixNumber(h, w.restitution);
    h = mixNumber(h, w.friction);
    h = mixNumber(h, w.color[0] * 65536 + w.color[1] * 256 + w.color[2]);
  }
  h = mixNumber(h, world.links.length);
  for (const ln of world.links) {
    h = mixNumber(h, ln.id);
    h = mixNumber(h, ln.a.id);
    h = mixNumber(h, ln.b.id);
    if ("stiffness" in ln) {
      h = mixNumber(h, 1);
      h = mixNumber(h, ln.restLength);
      h = mixNumber(h, ln.stiffness);
      h = mixNumber(h, ln.damping);
      h = mixNumber(h, ln.tensionOnly ? 1 : 0);
    } else {
      h = mixNumber(h, 2);
      h = mixNumber(h, ln.length);
      h = mixNumber(h, ln.isRope ? 1 : 0);
      h = mixNumber(h, ln.compliance);
    }
  }
  h = mixNumber(h, world.fields.length);
  for (const f of world.fields) {
    h = mixString(h, f.name);
    h = mixString(h, f.fxSrc);
    h = mixString(h, f.fySrc);
    h = mixNumber(h, f.enabled ? 1 : 0);
  }
  h = mixNumber(h, world.drivers.length);
  for (const d of world.drivers) {
    h = mixNumber(h, d.bodyId);
    h = mixNumber(h, d.amplitude);
    h = mixNumber(h, d.frequency);
    h = mixNumber(h, d.phase);
    h = mixNumber(h, d.angle);
    h = mixNumber(h, d.enabled ? 1 : 0);
  }
  return h;
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
 * last full snapshot. A new snapshot is taken only when the structural
 * digest changes - a body added or deleted, a property edited, a wall
 * moved - which makes the delta exact rather than approximate: any field
 * a delta does not carry provably still holds the keyframe's value.
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
  private bytes = 0;

  get length(): number { return this.frames.length; }

  clear(): void {
    this.frames.length = 0;
    this.keys.length = 0;
    this.keyBase = 0;
    this.haveDigest = false;
    this.bytes = 0;
  }

  push(world: World): void {
    const digest = structuralDigest(world);
    if (!this.haveDigest || digest !== this.digest || this.keys.length === 0) {
      const state = snapshot(world);
      this.keys.push(state);
      this.bytes += state.length * 2;
      this.digest = digest;
      this.haveDigest = true;
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
    // The digest guarantees the body list matches its keyframe, so this
    // only ever fails if that invariant is broken; fall back to the
    // keyframe rather than reading past the end of the array.
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
