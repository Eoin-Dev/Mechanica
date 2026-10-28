/** Persistent non-colliding regions that remove touched scene objects. */
import { boolOr, idOr, numIn, strOr } from "../core/guards";
import { Vec2 } from "../core/vec";
import { SCENE_MAX_COORDINATE, SCENE_MAX_SIZE, SCENE_MIN_SIZE, normalizeAngle } from "./body";

export const DELETE_ZONE_SHAPES = ["circle", "rectangle", "capsule"] as const;
export type DeleteZoneShape = typeof DELETE_ZONE_SHAPES[number];
export interface DeleteZoneDict {
  id: number; name: string; shape: DeleteZoneShape; pos: [number, number];
  width: number; height: number; angle: number; enabled: boolean;
}
const clamp = (n: number) => Math.max(0, Math.min(1, n));
function pointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function segmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y;
  const cross = ux * vy - uy * vx;
  if (Math.abs(cross) > 1e-15) {
    const dx = c.x - a.x, dy = c.y - a.y;
    const t = (dx * vy - dy * vx) / cross, s = (dx * uy - dy * ux) / cross;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1) return 0;
  }
  return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b));
}
const turn = Math.PI * 2;
function onArc(angle: number, start: number, sweep: number): boolean {
  const relative = ((Math.sign(sweep) * (angle - start)) % turn + turn) % turn;
  return relative <= Math.abs(sweep) + 1e-12 || turn - relative < 1e-12;
}
function arcPoint(centre: Vec2, radius: number, angle: number): Vec2 {
  return new Vec2(centre.x + radius * Math.cos(angle), centre.y + radius * Math.sin(angle));
}

/** Isolate real roots on [0,1] by monotone intervals. Only degrees <=3
 * are needed for the stationary times of squared moving-line clearance. */
function unitRoots(coefficients: number[]): number[] {
  while (coefficients.length > 1 && coefficients.at(-1) === 0) coefficients.pop();
  const degree = coefficients.length - 1;
  if (degree === 0) return [];
  if (degree === 1) {
    const root = -coefficients[0] / coefficients[1];
    return root >= 0 && root <= 1 ? [root] : [];
  }
  const scale = Math.max(...coefficients.map(Math.abs));
  const c = coefficients.map(value => value / scale);
  const valueAt = (t: number): number => c.reduceRight((value, coefficient) => value * t + coefficient, 0);
  const cuts = [0, ...unitRoots(c.slice(1).map((value, index) => value * (index + 1))), 1].sort((a, b) => a - b);
  const roots = cuts.filter(t => Math.abs(valueAt(t)) <= 32 * Number.EPSILON);
  for (let index = 1; index < cuts.length; index++) {
    let left = cuts[index - 1], right = cuts[index], lv = valueAt(left), rv = valueAt(right);
    if (!(lv < 0 && rv > 0 || lv > 0 && rv < 0)) continue;
    for (let iteration = 0; iteration < 60; iteration++) {
      const middle = (left + right) / 2;
      if (middle === left || middle === right) break;
      const mv = valueAt(middle);
      if (mv === 0) { left = right = middle; break; }
      if ((mv < 0) === (lv < 0)) { left = middle; lv = mv; }
      else right = middle;
    }
    roots.push((left + right) / 2);
  }
  return roots;
}

/** Endpoint paths are checked separately. Any remaining disk entry is an
 * interior line contact. Its clearance polynomial f(t)^2-r^2|D(t)|^2
 * has a stationary time in every contact interval. Testing the actual finite
 * segment at those times rejects infinite-line and folded-hull false hits. */
function movingSegmentDiskTimes(a: Vec2, b: Vec2, nextA: Vec2, nextB: Vec2, centre: Vec2, radius: number): number[] {
  const ax = a.x - centre.x, ay = a.y - centre.y;
  const vx = nextA.x - a.x, vy = nextA.y - a.y;
  const dx = b.x - a.x, dy = b.y - a.y;
  const ux = nextB.x - b.x - vx, uy = nextB.y - b.y - vy;
  const f0 = dx * ay - dy * ax;
  const f1 = dx * vy - dy * vx + ux * ay - uy * ax;
  const f2 = ux * vy - uy * vx;
  const r2 = radius * radius, g1 = 2 * (dx * ux + dy * uy), g2 = ux * ux + uy * uy;
  return unitRoots([2 * f0 * f1 - r2 * g1,
    2 * (f1 * f1 + 2 * f0 * f2 - r2 * g2), 6 * f1 * f2, 4 * f2 * f2]);
}
function movingSegmentDisk(a: Vec2, b: Vec2, nextA: Vec2, nextB: Vec2, centre: Vec2, radius: number): boolean {
  const vx = nextA.x - a.x, vy = nextA.y - a.y;
  return movingSegmentDiskTimes(a, b, nextA, nextB, centre, radius).some(t =>
    pointSegment(centre, new Vec2(a.x + t * vx, a.y + t * vy),
    new Vec2(b.x + t * (nextB.x - b.x), b.y + t * (nextB.y - b.y))) <= radius);
}

export class DeleteZone {
  static nextId = 1;
  id = DeleteZone.nextId++;
  name = "Delete zone";
  enabled = true;
  angle = 0;
  constructor(public pos = new Vec2(), public shape: DeleteZoneShape = "circle",
              public width = 1, public height = 1) {}

  private local(point: Vec2): Vec2 { return point.sub(this.pos).rotated(-this.angle); }
  private get tolerance(): number {
    return 32 * Number.EPSILON * Math.max(1, Math.abs(this.pos.x), Math.abs(this.pos.y), this.width, this.height);
  }
  private capsule(): [Vec2, Vec2, number] {
    const r = Math.min(this.width, this.height) / 2;
    const x = Math.max(0, this.width / 2 - r), y = Math.max(0, this.height / 2 - r);
    return [new Vec2(-x, -y), new Vec2(x, y), r];
  }
  private rectangle(): Vec2[] {
    const x = this.width / 2, y = this.height / 2;
    return [new Vec2(-x, -y), new Vec2(x, -y), new Vec2(x, y), new Vec2(-x, y)];
  }
  /** Closed-shape intersection, including the object's radius or wall thickness. */
  intersectsSegment(from: Vec2, to: Vec2, padding = 0): boolean {
    const reach = (this.shape === "circle" ? this.width : Math.hypot(this.width, this.height)) / 2 + padding + this.tolerance;
    if (Math.max(from.x, to.x) < this.pos.x - reach || Math.min(from.x, to.x) > this.pos.x + reach ||
        Math.max(from.y, to.y) < this.pos.y - reach || Math.min(from.y, to.y) > this.pos.y + reach) return false;
    const a = this.local(from), b = from === to ? a : this.local(to);
    if (this.shape === "circle") return pointSegment(new Vec2(), a, b) <= this.width / 2 + padding + this.tolerance;
    if (this.shape === "capsule") {
      const [c, d, r] = this.capsule(); return segmentDistance(a, b, c, d) <= r + padding + this.tolerance;
    }
    const inside = (p: Vec2) => Math.abs(p.x) <= this.width / 2 && Math.abs(p.y) <= this.height / 2;
    if (inside(a) || inside(b)) return true;
    const corners = this.rectangle();
    return corners.some((p, i) => segmentDistance(a, b, p, corners[(i + 1) % 4]) <= padding + this.tolerance);
  }
  contains(point: Vec2, padding = 0): boolean { return this.intersectsSegment(point, point, padding); }

  /** Continuous intersection for linearly moving segment endpoints during one
   * solver slice. The swept region may fold: its convex hull is not sufficient. */
  intersectsSweptSegment(a: Vec2, b: Vec2, nextA: Vec2, nextB: Vec2): boolean {
    const tolerance = Math.max(this.tolerance, 32 * Number.EPSILON * Math.max(1,
      Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y),
      Math.abs(nextA.x), Math.abs(nextA.y), Math.abs(nextB.x), Math.abs(nextB.y)));
    const reach = (this.shape === "circle" ? this.width : Math.hypot(this.width, this.height)) / 2 + this.tolerance;
    if (Math.max(a.x, b.x, nextA.x, nextB.x) < this.pos.x - reach ||
        Math.min(a.x, b.x, nextA.x, nextB.x) > this.pos.x + reach ||
        Math.max(a.y, b.y, nextA.y, nextB.y) < this.pos.y - reach ||
        Math.min(a.y, b.y, nextA.y, nextB.y) > this.pos.y + reach) return false;
    if (this.intersectsSegment(a, b) || this.intersectsSegment(nextA, nextB) ||
        this.intersectsSegment(a, nextA) || this.intersectsSegment(b, nextB)) return true;
    const first = this.local(a), second = this.local(b), endFirst = this.local(nextA), endSecond = this.local(nextB);
    const disk = (centre: Vec2, radius: number) =>
      movingSegmentDisk(first, second, endFirst, endSecond, centre, radius + tolerance);
    if (this.shape === "circle") return disk(new Vec2(), this.width / 2);
    if (this.shape === "capsule") {
      const [start, end, radius] = this.capsule(); return disk(start, radius) || disk(end, radius);
    }
    return this.rectangle().some(corner => disk(corner, 0));
  }

  /** Continuous routed-string queries with a fixed wheel and linearly moving
   * particles. Candidate contacts come from common tangents, wheel/boundary
   * intersections and straight-route stationary times. Every candidate checks
   * the actual angular sheet, finite legs and wrapped arc; no guide chord is
   * substituted for a curved tangent-point path or a released route. */
  intersectsSweptPulley(a: Vec2, b: Vec2, nextA: Vec2, nextB: Vec2, wheel: Vec2, radius: number,
      routeAt: (a: Vec2, b: Vec2) => { ga: Vec2; gb: Vec2; wrapped: boolean; sweep: number }): boolean {
    const reach = (this.shape === "circle" ? this.width : Math.hypot(this.width, this.height)) / 2 + this.tolerance;
    if (Math.max(a.x, b.x, nextA.x, nextB.x, wheel.x + radius) < this.pos.x - reach ||
        Math.min(a.x, b.x, nextA.x, nextB.x, wheel.x - radius) > this.pos.x + reach ||
        Math.max(a.y, b.y, nextA.y, nextB.y, wheel.y + radius) < this.pos.y - reach ||
        Math.min(a.y, b.y, nextA.y, nextB.y, wheel.y - radius) > this.pos.y + reach) return false;
    if (this.intersectsSegment(a, nextA) || this.intersectsSegment(b, nextB)) return true;
    const intersectsAt = (t: number): boolean => {
      const pa = new Vec2(a.x + (nextA.x - a.x) * t, a.y + (nextA.y - a.y) * t);
      const pb = new Vec2(b.x + (nextB.x - b.x) * t, b.y + (nextB.y - b.y) * t);
      const route = routeAt(pa, pb);
      return route.wrapped ? this.intersectsSegment(pa, route.ga) || this.intersectsSegment(pb, route.gb) ||
        this.intersectsArc(wheel, radius, Math.atan2(route.ga.y - wheel.y, route.ga.x - wheel.x), route.sweep) :
        this.intersectsSegment(pa, pb);
    };
    if (intersectsAt(0) || intersectsAt(1)) return true;
    const first = this.local(a), second = this.local(b), endFirst = this.local(nextA), endSecond = this.local(nextB);
    const centre = this.local(wheel), times = new Set<number>();
    const paths = [
      { start: first, dx: endFirst.x - first.x, dy: endFirst.y - first.y },
      { start: second, dx: endSecond.x - second.x, dy: endSecond.y - second.y },
    ];
    const addNormal = (nx: number, ny: number): void => {
      for (const path of paths) {
        const denominator = nx * path.dx + ny * path.dy;
        if (denominator === 0) continue;
        const t = (radius - nx * (path.start.x - centre.x) - ny * (path.start.y - centre.y)) / denominator;
        if (t >= -32 * Number.EPSILON && t <= 1 + 32 * Number.EPSILON) times.add(clamp(t));
      }
    };
    const normalsAtDot = (dx: number, dy: number, distance: number, dot: number): void => {
      if (!(distance > 0)) return;
      const cosine = dot / distance;
      if (Math.abs(cosine) > 1 + 32 * Number.EPSILON) return;
      const c = Math.max(-1, Math.min(1, cosine)), s = Math.sqrt(Math.max(0, 1 - c * c));
      const x = dx / distance, y = dy / distance;
      addNormal(c * x - s * y, c * y + s * x);
      addNormal(c * x + s * y, c * y - s * x);
    };
    const disk = (point: Vec2, r: number): void => {
      for (const t of movingSegmentDiskTimes(first, second, endFirst, endSecond, point, r)) times.add(t);
      const dx = point.x - centre.x, dy = point.y - centre.y, distance = Math.hypot(dx, dy);
      // A unit normal n has n·(point-wheel)=R±r on a common tangent.
      normalsAtDot(dx, dy, distance, radius + r);
      normalsAtDot(dx, dy, distance, radius - r);
      // Arc entry/exit occurs when a tangent point crosses a shape boundary.
      normalsAtDot(dx, dy, distance, (radius * radius + distance * distance - r * r) / (2 * radius));
    };
    let corners: Vec2[] = [];
    if (this.shape === "circle") disk(new Vec2(), this.width / 2);
    else if (this.shape === "rectangle") { corners = this.rectangle(); for (const point of corners) disk(point, 0); }
    else {
      const [start, end, r] = this.capsule(); disk(start, r); disk(end, r);
      const n = this.width >= this.height ? new Vec2(0, r) : new Vec2(r, 0);
      corners = [start.add(n), end.add(n), end.sub(n), start.sub(n)];
    }
    for (let edge = 0; edge < corners.length; edge++) {
      const start = corners[edge], end = corners[(edge + 1) % corners.length];
      const dx = end.x - start.x, dy = end.y - start.y, x = start.x - centre.x, y = start.y - centre.y;
      const aa = dx * dx + dy * dy, bb = 2 * (x * dx + y * dy), cc = x * x + y * y - radius * radius;
      const discriminant = bb * bb - 4 * aa * cc;
      if (aa === 0 || discriminant < -32 * Number.EPSILON * (bb * bb + Math.abs(4 * aa * cc))) continue;
      for (const sign of [-1, 1]) {
        const u = (-bb + sign * Math.sqrt(Math.max(0, discriminant))) / (2 * aa);
        if (u >= 0 && u <= 1) addNormal((x + u * dx) / radius, (y + u * dy) / radius);
      }
    }
    // A rounded boundary time can land just outside a very brief overlap on
    // a long path. Event-interval interiors retain that overlap without
    // widening the zone or imposing a fixed trajectory sampling grid.
    times.add(0); times.add(1);
    const events = [...times].sort((a, b) => a - b);
    for (let index = 1; index < events.length; index++) {
      if (intersectsAt(events[index]) || intersectsAt((events[index - 1] + events[index]) / 2)) return true;
    }
    return false;
  }

  /** Exact routed-string arc intersection: the chord is not the string path. */
  intersectsArc(worldCentre: Vec2, radius: number, worldStart: number, sweep: number): boolean {
    const centre = this.local(worldCentre), start = worldStart - this.angle;
    const disk = (point: Vec2, r: number): boolean => {
      const angle = Math.atan2(point.y - centre.y, point.x - centre.x);
      const distance = onArc(angle, start, sweep) ? Math.abs(point.distTo(centre) - radius) :
        Math.min(point.distTo(arcPoint(centre, radius, start)), point.distTo(arcPoint(centre, radius, start + sweep)));
      return distance <= r + this.tolerance;
    };
    if (this.shape === "circle") return disk(new Vec2(), this.width / 2);
    if (this.contains(arcPoint(worldCentre, radius, worldStart)) ||
        this.contains(arcPoint(worldCentre, radius, worldStart + sweep))) return true;
    let corners = this.rectangle();
    if (this.shape === "capsule") {
      const [a, b, r] = this.capsule();
      if (disk(a, r) || disk(b, r)) return true;
      const n = this.width >= this.height ? new Vec2(0, r) : new Vec2(r, 0);
      corners = [a.add(n), b.add(n), b.sub(n), a.sub(n)];
    }
    return corners.some((a, i) => {
      const b = corners[(i + 1) % 4], dx = b.x - a.x, dy = b.y - a.y;
      const px = a.x - centre.x, py = a.y - centre.y;
      const aa = dx * dx + dy * dy, bb = 2 * (px * dx + py * dy);
      const cc = px * px + py * py - radius * radius, discriminant = bb * bb - 4 * aa * cc;
      if (aa === 0 || discriminant < 0) return false;
      return [-1, 1].some(sign => {
        const t = (-bb + sign * Math.sqrt(discriminant)) / (2 * aa);
        return t >= 0 && t <= 1 && onArc(Math.atan2(py + t * dy, px + t * dx), start, sweep);
      });
    });
  }

  toDict(): DeleteZoneDict {
    return { id: this.id, name: this.name, shape: this.shape, pos: [this.pos.x, this.pos.y],
      width: this.width, height: this.height, angle: this.angle, enabled: this.enabled };
  }
  static fromDict(data: Partial<DeleteZoneDict>): DeleteZone {
    const shape = DELETE_ZONE_SHAPES.includes(data.shape as DeleteZoneShape) ? data.shape! : "circle";
    const pos = Array.isArray(data.pos) ? data.pos : [];
    const zone = new DeleteZone(new Vec2(numIn(pos[0], 0, -SCENE_MAX_COORDINATE, SCENE_MAX_COORDINATE),
      numIn(pos[1], 0, -SCENE_MAX_COORDINATE, SCENE_MAX_COORDINATE)), shape,
      numIn(data.width, 1, SCENE_MIN_SIZE, SCENE_MAX_SIZE), numIn(data.height, 1, SCENE_MIN_SIZE, SCENE_MAX_SIZE));
    zone.id = idOr(data.id, zone.id); DeleteZone.nextId = Math.max(DeleteZone.nextId, zone.id + 1);
    zone.name = strOr(data.name, "Delete zone"); zone.enabled = boolOr(data.enabled, true);
    zone.angle = normalizeAngle(data.angle); return zone;
  }
}
