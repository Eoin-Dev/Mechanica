/** Links between bodies: rods/ropes, springs/elastic strings, and pulleys.
 *
 * Rods and ropes are solved in two phases by the world stepper:
 *
 *   1. Force phase: the analytic constraint force (rod tension) is solved at
 *      the acceleration level with warm-started Gauss-Seidel and added to the
 *      accelerations before integrating. This is what keeps pendulums and
 *      chains energy-conserving -- pure position projection would silently
 *      drain energy every substep.
 *   2. Position phase: an XPBD solve removes the tiny O(h^2) residual drift so
 *      link lengths stay exact, and the corrections are fed back into the
 *      velocities.
 *
 * Springs are smooth forces (Hooke's law F = -k*extension plus optional axial
 * damping F = -c*v_rel) handled by the integrator, which is the physically
 * accurate treatment for oscillators.
 *
 * Strings are tension-only springs (`tensionOnly=true`): they pull when
 * stretched beyond their natural length and go completely slack when shorter.
 * An *inelastic* string is the same one-sided idea taken to infinite
 * stiffness: a DistanceLink with `isRope=true`, rigid in tension, free when
 * slack.
 *
 * A PulleyLink routes one inextensible, tension-only string over a finite
 * fixed wheel. Its two contact points move to stay tangent as the ordinary
 * particle endpoints swing; one shared multiplier gives equal tension.
 *
 * The engine clamps each spring's effective k and c per substep to its
 * explicit-integration stability limit (see World.prepareSprings), so absurd
 * user settings soften instead of exploding the simulation. That clamp is
 * per spring and is therefore not enough on its own for a node where several
 * springs meet; performance mode drops the force treatment entirely and
 * projects springs as position constraints instead, which has no stability
 * limit to respect (see engine/perf.ts).
 */
import { boolOr, idOr, intIn, numIn } from "../core/guards";
import { Vec2 } from "../core/vec";
import { Body, PULLEY_PARTICLE_RADIUS, PULLEY_RADIUS } from "./body";
export { PULLEY_PARTICLE_RADIUS, PULLEY_RADIUS } from "./body";

export interface RodDict {
  type: "rod";
  id: number;
  a: number;
  b: number;
  length: number;
  is_rope: boolean;
  compliance: number;
  origin_at_a?: boolean;
}

export interface SpringDict {
  type: "spring";
  id: number;
  a: number;
  b: number;
  rest_length: number;
  stiffness: number;
  damping: number;
  tension_only: boolean;
}

export interface PulleyDict {
  type: "pulley";
  id: number;
  a: number;
  b: number;
  pulley: number;
  length: number;
  compliance: number;
  guide_a: [number, number];
  guide_b: [number, number];
  wrap_sweep: number;
  wrap_turns?: number;
  wall_id?: number | null;
  wall_end?: number;
  wall_normal_sign?: number;
}

export type LinkDict = RodDict | SpringDict | PulleyDict;

/** Rigid rod (or, with isRope, an inelastic string) between two bodies. */
export class DistanceLink {
  static nextId = 1;

  id: number;
  a: Body;
  b: Body;
  length: number;
  compliance: number; // m/N; 0 = perfectly rigid
  isRope: boolean;
  lambda = 0.0; // XPBD accumulator (per substep)
  mu = 0.0;     // warm-start guess for the constraint force
  /** Transient per-link analysis overlay; display state is not scene physics. */
  showTensionVectors = false;
  /** Which endpoint the Inspector calls zero for attachment distances. */
  originAtA = true;

  constructor(a: Body, b: Body, length: number | null = null,
              isRope = false, compliance = 0.0) {
    this.id = DistanceLink.nextId++;
    this.a = a;
    this.b = b;
    this.length = length ?? a.pos.distTo(b.pos);
    this.compliance = compliance;
    this.isRope = isRope;
  }

  toDict(): RodDict {
    return {
      type: "rod", id: this.id, a: this.a.id, b: this.b.id,
      length: this.length, is_rope: this.isRope, compliance: this.compliance,
      origin_at_a: this.originAtA,
    };
  }
}

/** Hookean spring (optionally damped) between two bodies.
 *
 * With `tensionOnly=true` it behaves as an elastic string: it pulls when
 * stretched past its natural length and is completely slack otherwise.
 * `kEff`/`cEff` are the per-substep stability-clamped coefficients the
 * solver actually applies; World.prepareStep refreshes them every step.
 */
export class SpringLink {
  static nextId = 1;

  id: number;
  a: Body;
  b: Body;
  restLength: number;
  stiffness: number; // spring constant k, N/m
  damping: number;   // damping coefficient c, N*s/m, axial
  tensionOnly: boolean;
  kEff: number;
  cEff: number;
  /** Signed axial force actually applied by the latest solver evaluation.
   * Positive pulls the endpoints together; negative pushes them apart. */
  axialForce = 0.0;
  /** Transient per-link analysis overlay; display state is not serialized. */
  showTensionVectors = false;

  constructor(a: Body, b: Body, restLength: number | null = null,
              stiffness = 20.0, damping = 0.0, tensionOnly = false) {
    this.id = SpringLink.nextId++;
    this.a = a;
    this.b = b;
    this.restLength = restLength ?? a.pos.distTo(b.pos);
    this.stiffness = stiffness;
    this.damping = damping;
    this.tensionOnly = tensionOnly;
    this.kEff = stiffness;
    this.cEff = Math.max(damping, 0.0);
  }

  applyForces(): void {
    this.axialForce = 0.0;
    const a = this.a;
    const b = this.b;
    const dx = b.pos.x - a.pos.x;
    const dy = b.pos.y - a.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-9) return;
    const ext = dist - this.restLength;
    if (this.tensionOnly && ext <= 0.0) return; // slack string: no push, no damping
    const nx = dx / dist;
    const ny = dy / dist;
    let f = this.kEff * ext;
    if (this.cEff > 0.0) {
      const vrel = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny;
      f += this.cEff * vrel;
    }
    // A string pulls or it does nothing - it can never push, and the
    // slackness test above is not enough to guarantee that once a damper is
    // involved. While the ends APPROACH, vrel is negative, so a barely
    // stretched string has a damping term that outweighs its tension and
    // flips the total force: with the string tool's own defaults (k = 1000,
    // c = 2) anything stretched by less than 2 mm at 1 m/s of closing speed
    // pushed its ends apart instead of pulling them together - and a
    // swinging string crosses that boundary on every cycle. This is the
    // same one-sidedness DistanceLink already enforces on the rigid rope by
    // clamping its multiplier at zero.
    //
    // Tested on the total rather than inside the damping branch, so it also
    // covers a negative stiffness (which no slider offers, but which the
    // clamp in prepareSprings only bounds from above).
    if (this.tensionOnly && f < 0.0) return;
    this.axialForce = f;
    // positive f pulls the ends together
    a.acc.x += f * nx * a.invMass;
    a.acc.y += f * ny * a.invMass;
    b.acc.x -= f * nx * b.invMass;
    b.acc.y -= f * ny * b.invMass;
  }

  potentialEnergy(): number {
    const ext = this.a.pos.distTo(this.b.pos) - this.restLength;
    if (this.tensionOnly && ext <= 0.0) return 0.0;
    // kEff, not stiffness: the solver applies the stability-clamped
    // constant, so reporting the raw one made the energy plot of a
    // clamped spring disagree with the force actually doing the work
    // (a steady bogus drift the user had no way to explain).
    return 0.5 * this.kEff * ext * ext;
  }

  toDict(): SpringDict {
    return {
      type: "spring", id: this.id, a: this.a.id, b: this.b.id,
      rest_length: this.restLength, stiffness: this.stiffness,
      damping: this.damping, tension_only: this.tensionOnly,
    };
  }
}

/** One light string passing over an ideal fixed pulley.
 *
 * `length` is the complete natural length: both straight tangent legs plus the
 * live wrapped arc around the wheel. Retaining the wrapped part makes Inspector
 * edits and pulley removal preserve the physical amount of string. The
 * constraint is one-sided, like every other string here: it pulls with equal
 * tension on both particles when taut and cannot push when slack.
 */
export class PulleyLink {
  static nextId = 1;

  id: number;
  a: Body;
  b: Body;
  pulley: Body;
  length: number;
  compliance: number;
  guideAOffset: Vec2;
  guideBOffset: Vec2;
  wrapSweep: number;
  /** Integer sheet of the angular path, owned by the authored route. */
  wrapTurns = 0;
  mountWallId: number | null;
  mountWallEnd: 0 | 1;
  mountNormalSign: -1 | 1;
  lambda = 0.0;
  mu = 0.0;
  /** Transient per-link analysis overlay; display state is not serialized. */
  showTensionVectors = false;
  // Start of the current solver substep for continuous particle/wheel impact
  // detection. One sample per endpoint avoids any hot-loop allocation.
  safeAX = 0.0;
  safeAY = 0.0;
  safeBX = 0.0;
  safeBY = 0.0;
  safePX = 0.0;
  safePY = 0.0;

  constructor(a: Body, b: Body, pulley: Body, length: number | null = null,
              compliance = 0.0,
              guideAOffset = new Vec2(-PULLEY_RADIUS, 0),
              guideBOffset = new Vec2(PULLEY_RADIUS, 0),
              wrapSweep = -Math.PI, wrapTurns: number | null = null) {
    this.id = PulleyLink.nextId++;
    this.a = a;
    this.b = b;
    this.pulley = pulley;
    // These two bodies are point particles for as long as the routed pulley
    // exists. A fixed size keeps the wheel stop and tangent geometry stable;
    // dismantling the pulley turns them back into ordinary editable bodies.
    this.normalizeParticles();
    pulley.isPulley = true;
    pulley.isAnchor = true;
    pulley.locked = true;
    pulley.collides = false;
    pulley.noRotation = true;
    pulley.radius = PULLEY_RADIUS;
    pulley.name = "Pulley";
    pulley.color = [65, 72, 88];
    pulley.vel.set(0, 0);
    pulley.omega = 0.0;
    this.compliance = compliance;
    const sizeA = guideAOffset.length(), sizeB = guideBOffset.length();
    this.guideAOffset = sizeA > 0 && Number.isFinite(sizeA) ? guideAOffset.copy() : new Vec2(-PULLEY_RADIUS, 0);
    this.guideBOffset = sizeB > 0 && Number.isFinite(sizeB) ? guideBOffset.copy() : new Vec2(PULLEY_RADIUS, 0);
    this.wrapSweep = wrapSweep;
    this.mountWallId = null;
    this.mountWallEnd = 0;
    this.mountNormalSign = 1;
    this.resetRouting();
    if (wrapTurns !== null) this.wrapTurns = intIn(wrapTurns, this.wrapTurns, -1e6, 1e6) || 0;
    this.length = length ?? this.currentLength();
    this.captureSafePositions();
  }

  /** Preserve the initially authored route without modulo jumps during motion. */
  resetRouting(): void {
    this.safeAX = this.a.pos.x; this.safeAY = this.a.pos.y;
    this.safeBX = this.b.pos.x; this.safeBY = this.b.pos.y;
    this.safePX = this.pulley.pos.x; this.safePY = this.pulley.pos.y;
    this.wrapTurns = 0;
    const sigma = this.wrapSweep < 0 ? -1 : 1;
    const angle = sigma * this.geometry().routeSweep;
    const turns = -Math.floor(angle / (2 * Math.PI));
    this.wrapTurns = turns === 0 ? 0 : turns;
  }

  private portAngle(x: number, y: number, guide: Vec2): number {
    return Math.atan2(guide.x * y - guide.y * x, guide.x * x + guide.y * y);
  }

  /** Resolve the current angular sheet without changing the accepted sweep sample. */
  currentWrapTurns(): number {
    const tau = 2 * Math.PI, sigma = this.wrapSweep < 0 ? -1 : 1;
    const a = this.portAngle(this.a.pos.x - this.pulley.pos.x, this.a.pos.y - this.pulley.pos.y, this.guideAOffset);
    const b = this.portAngle(this.b.pos.x - this.pulley.pos.x, this.b.pos.y - this.pulley.pos.y, this.guideBOffset);
    const sa = this.portAngle(this.safeAX - this.safePX, this.safeAY - this.safePY, this.guideAOffset);
    const sb = this.portAngle(this.safeBX - this.safePX, this.safeBY - this.safePY, this.guideBOffset);
    return (this.wrapTurns + sigma * (Math.round((sb - b) / tau) - Math.round((sa - a) / tau))) || 0;
  }

  /** Commit the route at a step/edit boundary, then retain its reference positions. */
  captureSafePositions(): void {
    this.wrapTurns = this.currentWrapTurns();
    this.safeAX = this.a.pos.x;
    this.safeAY = this.a.pos.y;
    this.safeBX = this.b.pos.x;
    this.safeBY = this.b.pos.y;
    this.safePX = this.pulley.pos.x; this.safePY = this.pulley.pos.y;
  }

  /** Reassert the point-particle shape at the step boundary. This also
   * protects headless callers and a stale Inspector control left alive while
   * an endpoint becomes part of a newly loaded pulley. */
  normalizeParticles(): void {
    this.a.radius = PULLEY_PARTICLE_RADIUS;
    this.a.noRotation = true;
    this.a.omega = 0.0;
    this.b.radius = PULLEY_PARTICLE_RADIUS;
    this.b.noRotation = true;
    this.b.omega = 0.0;
  }

  /** Current tangent geometry around the finite wheel.
   *
   * Contact points move as either particle swings. This is not decorative:
   * the path length includes the changing wrapped arc, and each gradient is
   * the straight rope direction at its tangent. The stored guide offsets are
   * only topology/fallback hints (and define the initial wall-aligned layout).
   */
  geometry(): {
    ga: Vec2; gb: Vec2; da: number; db: number;
    nax: number; nay: number; nbx: number; nby: number;
    aRadialX: number; aRadialY: number;
    bRadialX: number; bRadialY: number;
    aTangentCoeff: number; bTangentCoeff: number;
    sweep: number; routeSweep: number; wrapped: boolean; wrapLength: number; totalLength: number;
  } {
    const sigma = this.wrapSweep < 0 ? -1 : 1;
    const leg = (body: Body, branch: number, fallback: Vec2) => {
      const qx = body.pos.x - this.pulley.pos.x;
      const qy = body.pos.y - this.pulley.pos.y;
      const d = Math.hypot(qx, qy);
      if (d <= PULLEY_RADIUS + 1e-9) {
        const fd = Math.max(1e-9, fallback.length());
        const gx = this.pulley.pos.x + fallback.x * PULLEY_RADIUS / fd;
        const gy = this.pulley.pos.y + fallback.y * PULLEY_RADIUS / fd;
        const sx = body.pos.x - gx;
        const sy = body.pos.y - gy;
        const straight = Math.max(1e-9, Math.hypot(sx, sy));
        return {
          guide: new Vec2(gx, gy), straight,
          nx: sx / straight, ny: sy / straight,
          radialX: d > 1e-9 ? qx / d : fallback.x / fd,
          radialY: d > 1e-9 ? qy / d : fallback.y / fd,
          tangentCoeff: 0.0, offset: 0, alpha: 0,
          angle: Math.atan2(gy - this.pulley.pos.y, gx - this.pulley.pos.x),
        };
      }
      const radialX = qx / d;
      const radialY = qy / d;
      const phi = Math.atan2(qy, qx);
      const alpha = Math.acos(PULLEY_RADIUS / d);
      const angle = phi + branch * alpha;
      const gx = this.pulley.pos.x + Math.cos(angle) * PULLEY_RADIUS;
      const gy = this.pulley.pos.y + Math.sin(angle) * PULLEY_RADIUS;
      const straight = Math.sqrt(d * d - PULLEY_RADIUS * PULLEY_RADIUS);
      return {
        guide: new Vec2(gx, gy), straight,
        nx: (body.pos.x - gx) / straight,
        ny: (body.pos.y - gy) / straight,
        radialX, radialY,
        // B in gradient = A*e_r + B*e_phi. The a and b arc
        // derivatives have opposite signs.
        tangentCoeff: -branch * PULLEY_RADIUS / d,
        angle, alpha,
        offset: this.portAngle(qx, qy, fallback) + branch * alpha,
      };
    };
    let la = leg(this.a, sigma, this.guideAOffset);
    let lb = leg(this.b, -sigma, this.guideBOffset);
    const tau = 2 * Math.PI;
    const positive = (angle: number): number => ((angle % tau) + tau) % tau;
    const aa = Math.atan2(this.guideAOffset.y, this.guideAOffset.x);
    const ab = Math.atan2(this.guideBOffset.y, this.guideBOffset.x);
    const reference = sigma > 0 ? positive(ab - aa) : -positive(aa - ab);
    const routeSweep = reference + lb.offset - la.offset + sigma * tau * this.currentWrapTurns();
    const routedArc = sigma * routeSweep;
    // Trial positions lift their angles to the closest accepted sweep sample.
    // Only step/edit boundaries commit that sheet; reads remain observational.
    // Within the interval between the two tangent families the string is
    // clear of the wheel. Past its other boundary it contacts the opposite
    // side. Keep the angular sheet fixed: reducing each live angle modulo a
    // turn would replace a continuous route by a different physical path.
    const reverseArc = -routedArc - 2 * (la.alpha + lb.alpha);
    if (routedArc <= 0 && reverseArc <= 0) {
      const x = this.a.pos.x - this.b.pos.x, y = this.a.pos.y - this.b.pos.y;
      const length = Math.hypot(x, y), inv = length > 1e-12 ? 1 / length : 0;
      const midpoint = new Vec2((this.a.pos.x + this.b.pos.x) * 0.5,
        (this.a.pos.y + this.b.pos.y) * 0.5);
      return { ga: midpoint, gb: midpoint.copy(), da: length / 2, db: length / 2,
        nax: x * inv, nay: y * inv, nbx: -x * inv, nby: -y * inv,
        aRadialX: la.radialX, aRadialY: la.radialY,
        bRadialX: lb.radialX, bRadialY: lb.radialY,
        aTangentCoeff: 0, bTangentCoeff: 0,
        sweep: 0, routeSweep, wrapped: false, wrapLength: 0, totalLength: length };
    }
    if (routedArc < 0) {
      la = leg(this.a, -sigma, this.guideAOffset);
      lb = leg(this.b, sigma, this.guideBOffset);
    }
    const sweep = routedArc >= 0 ? routeSweep : -sigma * reverseArc;
    const wrapLength = Math.abs(sweep) * PULLEY_RADIUS;
    return {
      ga: la.guide, gb: lb.guide, da: la.straight, db: lb.straight,
      nax: la.nx, nay: la.ny, nbx: lb.nx, nby: lb.ny,
      aRadialX: la.radialX, aRadialY: la.radialY,
      bRadialX: lb.radialX, bRadialY: lb.radialY,
      aTangentCoeff: la.tangentCoeff,
      bTangentCoeff: lb.tangentCoeff,
      sweep, routeSweep, wrapped: true, wrapLength,
      totalLength: la.straight + lb.straight + wrapLength,
    };
  }

  guideA(): Vec2 { return this.geometry().ga; }
  guideB(): Vec2 { return this.geometry().gb; }
  get wrapLength(): number { return this.geometry().wrapLength; }
  get legLimit(): number { return Math.max(0.0, this.length - this.wrapLength); }
  currentLength(): number { return this.geometry().totalLength; }

  /** Signed clearance from the endpoint's assembly routing limit.
   * Simulation and direct edits keep each particle on its assigned side. */
  branchDistance(endpoint: "a" | "b"): number {
    const offset = endpoint === "a" ? this.guideAOffset : this.guideBOffset;
    const body = endpoint === "a" ? this.a : this.b;
    const d = Math.max(1e-12, offset.length());
    const rx = body.pos.x - this.pulley.pos.x;
    const ry = body.pos.y - this.pulley.pos.y;
    const sigma = this.wrapSweep < 0 ? -1 : 1;
    const side = endpoint === "a" ? -sigma : sigma;
    return side * (offset.x * ry - offset.y * rx) / d;
  }

  toDict(): PulleyDict {
    return {
      type: "pulley", id: this.id, a: this.a.id, b: this.b.id,
      pulley: this.pulley.id, length: this.length,
      compliance: this.compliance,
      guide_a: [this.guideAOffset.x, this.guideAOffset.y],
      guide_b: [this.guideBOffset.x, this.guideBOffset.y],
      wrap_sweep: this.wrapSweep,
      wrap_turns: this.currentWrapTurns(),
      wall_id: this.mountWallId,
      wall_end: this.mountWallEnd,
      wall_normal_sign: this.mountNormalSign,
    };
  }
}

export type Link = DistanceLink | SpringLink | PulleyLink;

/** Build a link from a scene file.
 *
 * Every number is guarded to the range the Inspector's own sliders offer.
 * A rod whose `length` arrived as NaN - one absent or mistyped field in a
 * hand-edited scene - put a NaN straight into the constraint solve, which
 * spread to every connected body within a step and froze the whole scene
 * on load. Bodies and walls have been guarded like this since the port;
 * links were the gap.
 *
 * A missing length falls back to the bodies' current separation, which is
 * what the constructors do for a link created interactively.
 */
export function linkFromDict(d: LinkDict, bodiesById: Map<number, Body>): Link {
  const a = bodiesById.get(d.a)!;
  const b = bodiesById.get(d.b)!;
  const natural = a.pos.distTo(b.pos);
  let link: Link;
  if (d.type === "pulley") {
    const pulley = bodiesById.get(d.pulley)!;
    const ga = new Vec2(
      numIn(d.guide_a?.[0], -PULLEY_RADIUS, -1e6, 1e6),
      numIn(d.guide_a?.[1], 0.0, -1e6, 1e6),
    );
    const gb = new Vec2(
      numIn(d.guide_b?.[0], PULLEY_RADIUS, -1e6, 1e6),
      numIn(d.guide_b?.[1], 0.0, -1e6, 1e6),
    );
    link = new PulleyLink(a, b, pulley, null,
      numIn(d.compliance, 0.0, 0.0, 1e9), ga, gb,
      numIn(d.wrap_sweep, -Math.PI, -2 * Math.PI, 2 * Math.PI));
    link.wrapTurns = intIn(d.wrap_turns, link.wrapTurns, -1e6, 1e6) || 0;
    link.length = numIn(d.length, link.currentLength(), 0.0, 1e6);
    link.mountWallId = d.wall_id === null || d.wall_id === undefined
      ? null : idOr(d.wall_id, -1) >= 0 ? idOr(d.wall_id, -1) : null;
    link.mountWallEnd = intIn(d.wall_end, 0, 0, 1) as 0 | 1;
    link.mountNormalSign = numIn(d.wall_normal_sign, 1, -1, 1) < 0 ? -1 : 1;
    link.id = idOr(d.id, link.id);
    PulleyLink.nextId = Math.max(PulleyLink.nextId, link.id + 1);
  } else if (d.type === "spring") {
    link = new SpringLink(a, b,
                          numIn(d.rest_length, natural, 0.0, 1e6),
                          numIn(d.stiffness, 20.0, 0.0, 1e9),
                          numIn(d.damping, 0.0, 0.0, 1e9),
                          boolOr(d.tension_only, false));
    link.id = idOr(d.id, link.id);
    SpringLink.nextId = Math.max(SpringLink.nextId, link.id + 1);
  } else {
    link = new DistanceLink(a, b,
                            numIn(d.length, natural, 0.0, 1e6),
                            boolOr(d.is_rope, false),
                            numIn(d.compliance, 0.0, 0.0, 1e9));
    link.originAtA = boolOr(d.origin_at_a, true);
    link.id = idOr(d.id, link.id);
    DistanceLink.nextId = Math.max(DistanceLink.nextId, link.id + 1);
  }
  return link;
}
