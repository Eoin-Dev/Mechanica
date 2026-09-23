/** Shared validation for scene JSON fields.
 * Missing, non-finite, or incorrectly typed values use explicit defaults
 * before bodies, links, walls, and world settings reach the solver. */

/** A finite number, or `fallback` when the value is absent, not a number,
 * or not finite. */
export function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** As numOr, additionally clamped to [lo, hi]. */
export function numIn(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = numOr(v, fallback);
  return n < lo ? lo : n > hi ? hi : n;
}

/** An integer in [lo, hi], or `fallback`. Used on every deserialized solver
 * setting: an out-of-range iteration count from a corrupted file goes
 * straight into a solver loop bound, where a large one hangs the tab. */
export function intIn(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

/** A boolean, or `fallback` when the value has any other runtime type.
 * Strings and numbers are deliberately not coerced: `"false"` and `0`
 * commonly appear in hand-edited JSON, but JavaScript truthiness would give
 * them the opposite or an implicit meaning rather than rejecting bad input. */
export function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Return a bounded string or fallback; names are used in UI, digests,
 * storage, and download filenames. */
export function strOr(v: unknown, fallback: string, maxLen = 200): string {
  return typeof v === "string" ? v.slice(0, maxLen) : fallback;
}

/** Maximum imported ID. Loaders advance nextId beyond imported values;
 * a 2^40 ceiling leaves headroom below the 2^53 exact-integer limit. */
const MAX_ID = 2 ** 40;

/** A usable object id, or `fallback` (normally a freshly allocated one).
 *
 * Rejects rather than clamps on purpose: two different out-of-range ids
 * clamped to the same ceiling would collide, whereas handing each a fresh
 * id keeps them distinct. Negative ids are refused because the contact
 * cache keys a body-wall pair as `id,-wallId`, which a negative body id can
 * make indistinguishable from a body-body pair. */
export function idOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_ID
    ? v : fallback;
}

/** The value if it is an array, otherwise an empty one.
 *
 * `data.bodies ?? []` only defends against the field being absent: a scene
 * whose `bodies` arrived as a string or an object threw
 * "(data.bodies ?? []).map is not a function" out of the loader, past the
 * caller that was ready to report a bad file and into the click handler,
 * where it surfaced as nothing happening at all. */
export function arrayOr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Validate three integer RGB channels in [0, 255], otherwise use fallback. */
export function colorOr(v: unknown, fallback: readonly [number, number, number]):
  [number, number, number] {
  if (!Array.isArray(v) || v.length < 3) return [...fallback];
  const ch = (i: number): number => {
    const n = numOr(v[i], NaN);
    if (!Number.isFinite(n)) return NaN;
    return n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
  };
  const r = ch(0);
  const g = ch(1);
  const b = ch(2);
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)
    ? [r, g, b] : [...fallback];
}
