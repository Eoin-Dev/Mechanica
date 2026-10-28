/** Bounded visual slack only. Physics continues to use the authored straight
 * segments; picking follows the curve so the visible string remains selectable. */
const MAX_BOW_PX = 48;
export const MAX_SLACK_EXTENT_PX = 3 * MAX_BOW_PX;

/** Stable, allocation-free bowed segment with unchanged endpoints.
 * Excess length determines the cue strength; it is not an arc-length model.
 * Optional wheel coordinates choose the outward side of a pulley leg. */
export function addSlackString(path: Path2D, ax: number, ay: number,
                               bx: number, by: number, extraPx: number,
                               avoidX?: number, avoidY?: number): void {
  path.moveTo(ax, ay);
  if (!(extraPx > 0) || !Number.isFinite(extraPx)) { path.lineTo(bx, by); return; }
  const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
  const bow = MAX_BOW_PX * (1 - Math.exp(-Math.sqrt(extraPx * (2 * length + extraPx)) / (2 * MAX_BOW_PX)));
  if (length < 1e-3) {
    // Coincident ends still need an identifiable loop, rather than a point.
    path.quadraticCurveTo(ax + bow * 2, ay + bow * 2, ax, ay + bow * 2);
    path.quadraticCurveTo(ax - bow * 2, ay + bow * 2, bx, by);
    return;
  }
  const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
  // A single downward sag, gently outward for vertical pulley legs. Avoid
  // the old S reversal and upward arch on a horizontal loose string.
  const nx = avoidX !== undefined && avoidY !== undefined
    ? (Math.sign(mx - avoidX) || 1) * Math.abs(dy) / length
    : -Math.sign(dx || -1) * dy / length;
  const ny = Math.abs(dx) / length;
  path.quadraticCurveTo(mx + nx * bow * 2, my + ny * bow * 2, bx, by);

}


function segmentDistance(px: number, py: number, ax: number, ay: number,
                         bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
  const t = length2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

function quadraticDistance(px: number, py: number, ax: number, ay: number,
                           cx: number, cy: number, bx: number, by: number): number {
  let nearest = Infinity, x = ax, y = ay;
  // With bounded control offsets, 16 chords keep screen error below one
  // pixel, well inside the six-pixel picking tolerance. No cached path needed.
  for (let k = 1; k <= 16; k++) {
    const t = k / 16, u = 1 - t;
    const nextX = u * u * ax + 2 * u * t * cx + t * t * bx;
    const nextY = u * u * ay + 2 * u * t * cy + t * t * by;
    nearest = Math.min(nearest, segmentDistance(px, py, x, y, nextX, nextY));
    x = nextX; y = nextY;
  }
  return nearest;
}

/** Picking follows the same bounded visual curve; physics stays straight. */
export function slackStringDistance(px: number, py: number, ax: number, ay: number,
                                    bx: number, by: number, extraPx: number,
                                    avoidX?: number, avoidY?: number): number {
  if (!(extraPx > 0) || !Number.isFinite(extraPx)) return segmentDistance(px, py, ax, ay, bx, by);
  const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
  const bow = MAX_BOW_PX * (1 - Math.exp(-Math.sqrt(extraPx * (2 * length + extraPx)) / (2 * MAX_BOW_PX)));
  if (length < 1e-3) return Math.min(
    quadraticDistance(px, py, ax, ay, ax + bow * 2, ay + bow * 2, ax, ay + bow * 2),
    quadraticDistance(px, py, ax, ay + bow * 2, ax - bow * 2, ay + bow * 2, bx, by));
  const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
  const nx = avoidX !== undefined && avoidY !== undefined
    ? (Math.sign(mx - avoidX) || 1) * Math.abs(dy) / length
    : -Math.sign(dx || -1) * dy / length;
  const ny = Math.abs(dx) / length;
  return quadraticDistance(px, py, ax, ay, mx + nx * bow * 2, my + ny * bow * 2, bx, by);
}
