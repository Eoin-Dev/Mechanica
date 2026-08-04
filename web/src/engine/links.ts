/** Links between bodies: rigid rods / ropes (constraints) and springs.
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
 * The engine clamps each spring's effective k and c per substep to its
 * explicit-integration stability limit (see World.prepareSprings), so absurd
 * user settings soften instead of exploding the simulation. That clamp is
 * per spring and is therefore not enough on its own for a node where several
 * springs meet; performance mode drops the force treatment entirely and
 * projects springs as position constraints instead, which has no stability
 * limit to respect (see engine/perf.ts).
 */
import { boolOr, idOr, numIn } from "../core/guards";
import { Body } from "./body";

export interface RodDict {
  type: "rod";
  id: number;
  a: number;
  b: number;
  length: number;
  is_rope: boolean;
  compliance: number;
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

export type LinkDict = RodDict | SpringDict;

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

export type Link = DistanceLink | SpringLink;

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
  if (d.type === "spring") {
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
    link.id = idOr(d.id, link.id);
    DistanceLink.nextId = Math.max(DistanceLink.nextId, link.id + 1);
  }
  return link;
}
