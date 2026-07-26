/** Input guards for everything read off a scene file.
 *
 * Scene `.json` can come from an import, a hand-edited file, an older or a
 * newer version of the app, or a desktop export - so no field in it can be
 * trusted to be present, numeric, or finite. A single bad value used to
 * reach the solver as NaN, where it propagates through the whole scene in
 * one step: every body is then frozen by World.sanitize and reported as
 * "hit a numerical blow-up - check extreme forces or fields", which points
 * the user at their own physics when the actual cause was a malformed file.
 *
 * These live in one place because bodies, walls, links and world settings
 * all need the same discipline, and it was previously applied to only the
 * first two.
 */

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

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** A well-formed [r, g, b] triple of whole 0-255 channels.
 *
 * Anything else - a short array, a string, a channel that is NaN - is
 * replaced by `fallback`. A two-element colour used to survive load and
 * then render as `rgb(1,2,undefined)`, which canvas rejects silently: the
 * body simply drew in whatever colour happened to be set last.
 */
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
