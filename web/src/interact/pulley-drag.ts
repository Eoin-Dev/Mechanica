import { Vec2 } from "../core/vec";
import { Body, PULLEY_RADIUS, Wall } from "../engine/body";
import { sweepClearOfWalls } from "../engine/contacts";
import { DistanceLink, Link, PulleyLink } from "../engine/links";

export interface PulleyDragPlan {
  target: Vec2;
  partners: Array<{ body: Body; target: Vec2 }>;
}

/** First hit of the finite wheel frame along a proposed straight edit. */
function wheelFraction(start: Vec2, target: Vec2, wheel: Body, radius: number): number {
  const sx = start.x - wheel.pos.x, sy = start.y - wheel.pos.y;
  const dx = target.x - start.x, dy = target.y - start.y;
  const move2 = dx * dx + dy * dy, toward = sx * dx + sy * dy;
  const gap = sx * sx + sy * sy - radius * radius;
  if (move2 < 1e-24 || toward >= 0) return 1;
  // A legacy overlapping position may move outwards, but never further in.
  if (gap < -1e-10) return 0;
  const nonnegativeGap = Math.max(0, gap);
  const discriminant = toward * toward - move2 * nonnegativeGap;
  if (discriminant < 0) return 1;
  // The rationalized root stays precise near contact, even for long jumps.
  return Math.max(0, Math.min(1, nonnegativeGap / (-toward + Math.sqrt(discriminant))));
}

/** The assembly keeps each endpoint on its assigned side of the guide ray. */
function guideFraction(link: PulleyLink, body: Body, start: Vec2, target: Vec2): number {
  const offset = body === link.a ? link.guideAOffset : link.guideBOffset;
  const sigma = link.wrapSweep < 0 ? -1 : 1;
  const side = body === link.a ? -sigma : sigma;
  const nx = -offset.y * side, ny = offset.x * side;
  const from = (start.x - link.pulley.pos.x) * nx + (start.y - link.pulley.pos.y) * ny;
  const to = (target.x - link.pulley.pos.x) * nx + (target.y - link.pulley.pos.y) * ny;
  return to >= 0 ? 1 : from > 0 ? Math.max(0, Math.min(1, from / (from - to))) : 0;
}

/** Read-only direct-edit plan: preserve natural length without stepping.
 * A free partner takes up only the extra length, along its current straight
 * string leg; held/locked/rod-attached/rigid-linked partners remain fixed.
 * Pre-existing extension may shorten, but this edit never makes it worse. */
export function pulleyParticleDragPlan(links: readonly Link[], body: Body, proposed: Vec2,
                                       walls: Wall[] = [], iterations = 40,
                                       radialPointer: Vec2 | null = null): PulleyDragPlan | null {
  const incident = links.filter((link): link is PulleyLink =>
    link instanceof PulleyLink && (link.a === body || link.b === body));
  if (incident.length === 0) return null;
  const start = body.pos, dx = proposed.x - start.x, dy = proposed.y - start.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { target: start.copy(), partners: [] };
  let fraction = 1;
  const queries = incident.map(link => {
    fraction = Math.min(fraction, wheelFraction(start, proposed, link.pulley, PULLEY_RADIUS + body.radius),
      guideFraction(link, body, start, proposed));
    const other = link.a === body ? link.b : link.a;
    // Constructor-free views own candidate positions and share only read inputs.
    const trial = Object.create(link) as PulleyLink;
    const endpoint = Object.create(body) as Body, partner = Object.create(other) as Body;
    endpoint.pos = start.copy(); partner.pos = other.pos.copy();
    if (link.a === body) { trial.a = endpoint; trial.b = partner; }
    else { trial.b = endpoint; trial.a = partner; }
    const limit = Math.max(link.length, trial.currentLength());
    const movable = !other.locked && !other.held && !other.isAnchor && !other.isRodEndpoint &&
      other.rodAttachmentId === null &&
      !links.some(candidate => candidate !== link && (candidate.a === other || candidate.b === other) &&
        (candidate instanceof PulleyLink || candidate instanceof DistanceLink));
    const at = (x: number, y: number): { feasible: boolean; target: Vec2 | null } => {
      endpoint.pos.set(x, y);
      partner.pos.setVec(other.pos);
      const geom = trial.geometry();
      if (!Number.isFinite(limit) || !Number.isFinite(geom.totalLength)) return { feasible: false, target: null };
      const excess = geom.totalLength - limit;
      if (excess <= 1e-10) return { feasible: true, target: null };
      if (!movable) return { feasible: false, target: null };
      // Walking inwards on a straight tangent leg (or direct string) shortens
      // that same path by the walked distance, until a physical stop intervenes.
      const nx = link.a === other ? geom.nax : geom.nbx;
      const ny = link.a === other ? geom.nay : geom.nby;
      const raw = new Vec2(other.pos.x - nx * excess, other.pos.y - ny * excess);
      const wheelLimit = Math.min(wheelFraction(other.pos, raw, link.pulley, PULLEY_RADIUS + other.radius),
        guideFraction(link, other, other.pos, raw));
      let target = new Vec2(other.pos.x + (raw.x - other.pos.x) * wheelLimit,
        other.pos.y + (raw.y - other.pos.y) * wheelLimit);
      if (walls.length && other.collides) {
        const [x, y] = sweepClearOfWalls(walls, other.pos, target, other.radius);
        target = new Vec2(x, y);
      }
      partner.pos.setVec(target);
      return { feasible: trial.currentLength() <= limit + 1e-10, target };
    };
    return { other, at, limit };
  });
  // At the outer reach limit, an incremental chord from the previous stop
  // has zero permitted travel in many new directions. Project onto the actual
  // pointer ray instead, so even a tiny angular change slides along the edge.
  // Rod attachments and different axle centres retain their own edit geometry.
  if (radialPointer !== null && body.rodAttachmentId === null && !body.isRodEndpoint &&
      incident.every(link => link.pulley === incident[0].pulley) &&
      queries.some(query => !query.at(proposed.x, proposed.y).feasible)) {
    const axle = incident[0].pulley, rx = radialPointer.x - axle.pos.x, ry = radialPointer.y - axle.pos.y;
    const distance = Math.hypot(rx, ry), rim = PULLEY_RADIUS + body.radius;
    if (Number.isFinite(distance) && distance > rim) {
      const nx = rx / distance, ny = ry / distance;
      const point = (radius: number) => new Vec2(axle.pos.x + nx * radius, axle.pos.y + ny * radius);
      const minimum = point(rim);
      const feasible = (position: Vec2) => queries.every(query => query.at(position.x, position.y).feasible);
      // Both wrapped and released paths have a finite radial bound: their
      // selected leg is at least r-R, or their direct distance at least r-rOther.
      // This also bounds bisection precision independently of cursor overshoot.
      let upper = distance;
      for (const query of queries) upper = Math.min(upper,
        query.limit + PULLEY_RADIUS + query.other.pos.distTo(axle.pos));
      if (incident.every(link => guideFraction(link, body, minimum, radialPointer) === 1) &&
          feasible(minimum) && upper >= rim && !feasible(point(upper))) {
        let lo = rim, hi = upper;
        for (let k = 0; k < iterations; k++) {
          const middle = (lo + hi) * 0.5;
          if (feasible(point(middle))) lo = middle; else hi = middle;
        }
        const target = point(lo);
        const clear = walls.length && body.collides ? sweepClearOfWalls(walls, start, target, body.radius) : [target.x, target.y];
        if (Math.hypot(clear[0] - target.x, clear[1] - target.y) < 1e-10) {
          const partners: PulleyDragPlan["partners"] = [];
          for (const query of queries) {
            const answer = query.at(target.x, target.y);
            if (answer.target !== null) partners.push({ body: query.other, target: answer.target });
          }
          return { target, partners };
        }
      }
    }
  }
  for (const query of queries) {
    if (query.at(start.x + dx * fraction, start.y + dy * fraction).feasible) continue;
    let lo = 0, hi = fraction;
    for (let k = 0; k < iterations; k++) {
      const mid = (lo + hi) * 0.5;
      if (query.at(start.x + dx * mid, start.y + dy * mid).feasible) lo = mid; else hi = mid;
    }
    fraction = lo;
  }
  const partners: PulleyDragPlan["partners"] = [];
  for (const query of queries) {
    const answer = query.at(start.x + dx * fraction, start.y + dy * fraction);
    if (!answer.feasible) return { target: start.copy(), partners: [] };
    if (answer.target !== null) partners.push({ body: query.other, target: answer.target });
  }
  return { target: fraction === 1 ? proposed : new Vec2(start.x + dx * fraction, start.y + dy * fraction), partners };
}
