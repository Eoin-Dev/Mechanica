/** A single outline around the true union of a tour's spotlight rectangles. */
export interface SpotlightRect { x: number; y: number; w: number; h: number; }
export interface SpotlightPoint { x: number; y: number; }

/** Trace exposed cell edges, so overlapping or nested targets have no seams. */
export function spotlightContours(rects: readonly SpotlightRect[]): SpotlightPoint[][] {
  if (!rects.length) return [];
  const xs = [...new Set(rects.flatMap(r => [r.x, r.x + r.w]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap(r => [r.y, r.y + r.h]))].sort((a, b) => a - b);
  const covered = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= xs.length - 1 || j >= ys.length - 1) return false;
    const x = (xs[i] + xs[i + 1]) / 2, y = (ys[j] + ys[j + 1]) / 2;
    return rects.some(r => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h);
  };
  type Edge = { start: SpotlightPoint; end: SpotlightPoint; direction: number; used: boolean };
  const edges: Edge[] = [];
  const key = (p: SpotlightPoint): string => `${p.x},${p.y}`;
  const outgoing = new Map<string, Edge[]>();
  const add = (x: number, y: number, ex: number, ey: number, direction: number): void => {
    const edge = { start: { x, y }, end: { x: ex, y: ey }, direction, used: false };
    edges.push(edge);
    const id = key(edge.start), list = outgoing.get(id) ?? [];
    list.push(edge); outgoing.set(id, list);
  };
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    if (!covered(i, j)) continue;
    const x = xs[i], y = ys[j], right = xs[i + 1], bottom = ys[j + 1];
    if (!covered(i, j - 1)) add(x, y, right, y, 0);
    if (!covered(i + 1, j)) add(right, y, right, bottom, 1);
    if (!covered(i, j + 1)) add(right, bottom, x, bottom, 2);
    if (!covered(i - 1, j)) add(x, bottom, x, y, 3);
  }
  const contours: SpotlightPoint[][] = [];
  for (const first of edges) {
    if (first.used) continue;
    const points: SpotlightPoint[] = [];
    let edge = first;
    while (!edge.used) {
      edge.used = true; points.push(edge.start);
      if (key(edge.end) === key(first.start)) break;
      const candidates = (outgoing.get(key(edge.end)) ?? []).filter(next => !next.used);
      // A right turn keeps rectangles touching at a single point separate.
      const turnOrder = [1, 0, 3, 2];
      const next = candidates.sort((a, b) =>
        turnOrder.indexOf((a.direction - edge.direction + 4) % 4) -
        turnOrder.indexOf((b.direction - edge.direction + 4) % 4))[0];
      if (!next) break;
      edge = next;
    }
    const corners = points.filter((p, i) => {
      const before = points[(i + points.length - 1) % points.length], after = points[(i + 1) % points.length];
      return (p.x - before.x) * (after.y - p.y) !== (p.y - before.y) * (after.x - p.x);
    });
    if (corners.length >= 4) contours.push(corners);
  }
  return contours;
}

/** Round actual union corners rather than drawing intersecting rounded boxes. */
export function spotlightOutline(rects: readonly SpotlightRect[]): string {
  return spotlightContours(rects).map(points => {
    const turns = points.map((p, i) => {
      const before = points[(i + points.length - 1) % points.length], after = points[(i + 1) % points.length];
      const incoming = Math.hypot(before.x - p.x, before.y - p.y);
      const outgoing = Math.hypot(after.x - p.x, after.y - p.y);
      const radius = Math.min(8, incoming / 2, outgoing / 2);
      return { p, start: { x: p.x + (before.x - p.x) * radius / incoming,
        y: p.y + (before.y - p.y) * radius / incoming },
      end: { x: p.x + (after.x - p.x) * radius / outgoing,
        y: p.y + (after.y - p.y) * radius / outgoing } };
    });
    let path = `M${turns[0].start.x},${turns[0].start.y}`;
    turns.forEach((turn, i) => {
      const next = turns[(i + 1) % turns.length];
      path += `Q${turn.p.x},${turn.p.y} ${turn.end.x},${turn.end.y}L${next.start.x},${next.start.y}`;
    });
    return path + "Z";
  }).join(" ");
}
