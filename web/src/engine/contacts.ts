/** Collision detection and response.
 *
 * Broadphase: uniform spatial hash rebuilt per substep. Bodies of typical
 * size are binned into cells (one cell each, cell = largest small-body
 * diameter) and pairs are found by scanning each cell against itself and its
 * four forward neighbours, so no pair is tested twice. The few bodies much
 * larger than the median (planets among dust, the Brownian grain) would
 * bloat the cells, so they are tested by brute force instead.
 *
 * Narrowphase: circle-circle and circle-capsule (wall) tests.
 *
 * Response: iterated sequential impulses with accumulated-impulse clamping
 * (the Box2D scheme). Restitution enters as a velocity bias captured before
 * the solve, so stacked/simultaneous contacts converge to a consistent
 * solution instead of depending on resolution order. Friction impulses act
 * at the contact point and produce torque, so rolling emerges naturally.
 * Penetration is removed afterwards by split-impulse positional projection,
 * which does not change velocities and therefore cannot inject kinetic
 * energy.
 *
 * The desktop version had a second, numpy-vectorized candidate search for
 * dense scenes; JIT-compiled JS loops make the scalar path fast enough that
 * the engine needs only one code path here.
 */
import { Body, Wall } from "./body";

// Below this approach speed a bounce is treated as perfectly inelastic, which
// stops resting objects from jittering on the floor.
export const RESTING_SPEED = 0.10;
const PENETRATION_SLOP = 0.0005; // m of overlap tolerated before projection
const PROJECTION_PERCENT = 0.8;  // fraction of the remaining overlap removed per pass
const POSITION_ITERATIONS = 3;   // projection passes per substep (stacks settle)
const IMPULSE_EPSILON = 1e-9;    // convergence threshold for early exit

/** A resolved contact, kept for visualization/diagnostics. */
export class Contact {
  constructor(
    public px: number,
    public py: number,
    public nx: number,
    public ny: number,
    public impulse: number,
  ) {}
}

/** Per-step detection state that cannot change within a step (collider
 * lists, link exclusions); pass a fresh object at the start of every step.
 *
 * The size split and hash cell below are functions of the radii and the
 * `collides` flags alone - neither of which a substep can change - so they
 * are derived once per step rather than rebuilt (with a sort and four
 * throwaway arrays) on every one of them. */
export interface ContactStatic {
  noCollide?: Set<string>;
  colliders?: Body[];
  movers?: Body[];
  small?: Body[];
  large?: Body[];
  cell?: number;
}

/** Closest point to `p` on the segment a-b.
 *
 * The capsule narrowphase's core query, shared with the kinematic sweep
 * below. */
export function closestOnSegment(px: number, py: number,
                                 ax: number, ay: number,
                                 bx: number, by: number): [number, number] {
  const sx = bx - ax;
  const sy = by - ay;
  const len2 = sx * sx + sy * sy;
  let t = 0.0;
  if (len2 > 0.0) {
    t = ((px - ax) * sx + (py - ay) * sy) / len2;
    if (t < 0.0) t = 0.0;
    else if (t > 1.0) t = 1.0;
  }
  return [ax + sx * t, ay + sy * t];
}

// Work bound for the kinematic sweep below. At half a radius per step this
// covers 8 m of travel for a 0.25 m body in one frame - about 480 m/s of
// dragging - so it only bites on a wild jump.
const MAX_SWEEP_STEPS = 64;

/** Push `p` out of every wall a disc of `radius` would overlap there.
 *
 * `prev` is the last position known to be legal. It decides which SIDE of
 * a wall to leave by: resolving to the nearer face instead is what lets a
 * body walk through, one step at a time, once it is past the centreline.
 * It also disambiguates the normal when the disc sits exactly on the
 * segment, where there is no nearer face at all. */
export function clearOfWalls(walls: Wall[], px: number, py: number,
                             radius: number,
                             prev?: readonly [number, number]): [number, number] {
  if (walls.length === 0) return [px, py];
  let x = px;
  let y = py;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const w of walls) {
      const reach = radius + w.thickness * 0.5;
      const [cx, cy] = closestOnSegment(x, y, w.a.x, w.a.y, w.b.x, w.b.y);
      let dx = x - cx;
      let dy = y - cy;
      let d = Math.hypot(dx, dy);
      if (d >= reach) continue;
      if (d < 1e-9) {
        // dead centre on the segment: the surface normal is ambiguous
        const sx = w.b.x - w.a.x;
        const sy = w.b.y - w.a.y;
        const len = Math.hypot(sx, sy) || 1.0;
        dx = -sy / len;
        dy = sx / len;
        d = 1.0;
      }
      if (prev !== undefined) {
        const pdx = prev[0] - cx;
        const pdy = prev[1] - cy;
        if (pdx * pdx + pdy * pdy > 1e-18 && dx * pdx + dy * pdy < 0.0) {
          d = Math.hypot(pdx, pdy);
          dx = pdx;
          dy = pdy;
        }
      }
      x = cx + (dx / d) * reach;
      y = cy + (dy / d) * reach;
      moved = true;
    }
    if (!moved) break;
  }
  return [x, y];
}

/** Move a disc of `radius` from `from` toward `to` without entering a wall.
 *
 * This is the kinematic counterpart to the contact solver, for a body whose
 * position is being written directly rather than integrated - i.e. one the
 * user is dragging. Such a body is infinite mass so that it tracks the
 * cursor exactly, and infinite mass is also how the solver recognises a
 * wall, so the pair has no solution and the narrowphase skips it: giving it
 * a contact would not help, because neither side can be pushed.
 *
 * Resolving the overlap at the destination is not enough on its own. A
 * quick flick covers more than a wall's thickness in one frame, so the body
 * lands genuinely clear on the far side and stays there. The path is
 * therefore MARCHED in steps smaller than the disc, and each step advances
 * from where the body actually got to rather than to an absolute point on
 * the line - otherwise a blocked step is simply skipped and the body
 * teleports past. Sliding along a wall and wedging into a corner fall out
 * of the same loop.
 */
export function sweepClearOfWalls(walls: Wall[], from: { x: number; y: number },
                                  to: { x: number; y: number },
                                  radius: number): [number, number] {
  if (walls.length === 0) return [to.x, to.y];
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  // Step no further than half a radius, so nothing thinner than the disc
  // can be skipped, and bound the count so one absurd jump (dragging across
  // the screen while zoomed all the way out) cannot cost unbounded work.
  // Past that budget the TRAVEL is shortened rather than the resolution
  // coarsened: lagging the cursor for a frame is a far smaller lie than
  // passing through a wall, and the next frame closes the gap.
  const step = radius * 0.5;
  const steps = Math.min(MAX_SWEEP_STEPS, Math.max(1, Math.ceil(dist / step)));
  const reach = Math.min(dist, steps * step);
  const scale = dist > 1e-12 ? reach / (dist * steps) : 0.0;
  const sx = (to.x - from.x) * scale;
  const sy = (to.y - from.y) * scale;
  let cur = clearOfWalls(walls, from.x, from.y, radius);
  for (let i = 0; i < steps; i++) {
    cur = clearOfWalls(walls, cur[0] + sx, cur[1] + sy, radius, cur);
  }
  return cur;
}

/** Persistent data carried between substeps for warm starting and supported
 * static-friction anchoring. A structured entry prevents a missing/shifted
 * array slot from silently changing the meaning of the cache. */
export interface ContactCacheEntry {
  normalImpulse: number;
  tangentImpulse: number;
  anchorX: number;
  anchorY: number;
  anchored: boolean;
  fixedSupport: boolean;
}
export type ContactCache = Map<string, ContactCacheEntry>;

/** Identity of an unordered body pair, and so of the contact between them.
 *
 * Order-INDEPENDENT on purpose. Which of two bodies the narrowphase calls
 * `a` depends on the order the broadphase happens to visit them, and in the
 * spatial-hash path that ordering can swap between substeps as bodies move
 * from one cell to another. A detection-ordered key therefore turned a
 * persistent resting contact into a fresh one whenever its pair flipped,
 * throwing away the accumulated impulse the warm start exists to carry.
 *
 * Re-keying is safe because both cached scalars are invariant under a flip:
 * the normal reverses with the pair, so the same non-negative `pn` produces
 * the same physical push either way, and `pt` reverses along with the
 * tangent for the same reason. Walls key on their own (negative) id, which
 * cannot collide with a body id.
 */
function pairKey(idA: number, idB: number): string {
  return idA < idB ? `${idA},${idB}` : `${idB},${idA}`;
}

/** One contact point with precomputed effective masses and accumulators.
 *
 * The normal (nx, ny) points from body a toward body b; for walls b is null
 * and the normal points from the body into the wall (infinite mass side).
 */
class Manifold {
  a: Body;
  b: Body | null;
  nx: number;
  ny: number;
  px: number;
  py: number;
  pen: number;
  mu: number;
  invMa: number;
  invMb: number;
  invIa: number;
  invIb: number;
  invMSum: number;
  raXn: number;
  rbXn: number;
  kN: number;
  raXt: number;
  rbXt: number;
  kT: number;
  rax: number;
  ray: number;
  rbx: number;
  rby: number;
  targetVn: number;
  e: number;
  pn = 0.0;
  pt = 0.0;
  /** Impulse applied by the one-shot impact pass (not warm-started, not
   * retractable by the clamped sweeps; counted for the friction limit). */
  pnBounce = 0.0;
  // static-friction position anchor (world contact point) carried from the
  // previous substep; `anchored` is false for a brand-new contact
  ax = 0.0;
  ay = 0.0;
  anchored = false;
  /** Whether the cached anchor belonged to a fixed-supported contact. */
  cachedFixedSupport = false;
  /** Recomputed from this substep's static contact graph. */
  fixedSupport = false;
  sepBase: number;
  key: string;

  constructor(a: Body, b: Body | null, nx: number, ny: number,
              pen: number, px: number, py: number, e: number, mu: number) {
    this.a = a;
    this.b = b;
    this.nx = nx;
    this.ny = ny;
    this.px = px;
    this.py = py;
    this.pen = pen;
    this.mu = mu;
    let invMa = a.invMass;
    const invIa = a.invInertia;
    let invMb = 0.0;
    let invIb = 0.0;
    if (b !== null) {
      invMb = b.invMass;
      invIb = b.invInertia;
      // Performance mode only: a soft-body particle presents some of the
      // inertia of the spring network holding it, up to parity with whatever
      // hit it (see Body.contactMassGain). Everywhere else both gains are 1
      // and this is a pair of comparisons that change nothing.
      //
      // Without it a 64 kg gymnast landing on a trampoline whose bed
      // particles weigh 100 g each feels 100 g: the contact impulse is split
      // by inverse mass, so the gymnast keeps 639/640 of its momentum and
      // walks straight through the bed. The accurate solver gets away with
      // treating the particle as 100 g because the bed's spring FORCES
      // accelerate it to over 100 m/s, so it hammers the gymnast upwards; a
      // position projection has no such velocity to give, which is the one
      // thing it cannot substitute for. Lending the particle mass is the
      // cheapest honest stand-in - and it is arguably the more faithful
      // reading of the situation anyway, since the particle really is bolted
      // to a bed that is anchored at both ends.
      if (invMa > 0.0 && invMb > 0.0) {
        if (invMa > invMb && a.contactMassGain > 1.0) {
          invMa = Math.max(invMa / a.contactMassGain, invMb);
        } else if (invMb > invMa && b.contactMassGain > 1.0) {
          invMb = Math.max(invMb / b.contactMassGain, invMa);
        }
      }
    }
    this.invMa = invMa;
    this.invMb = invMb;
    this.invIa = invIa;
    this.invIb = invIb;
    this.invMSum = invMa + invMb;

    const rax = px - a.pos.x;
    const ray = py - a.pos.y;
    let rbx = 0.0;
    let rby = 0.0;
    if (b !== null) {
      rbx = px - b.pos.x;
      rby = py - b.pos.y;
    }
    this.rax = rax;
    this.ray = ray;
    this.rbx = rbx;
    this.rby = rby;

    const raXn = rax * ny - ray * nx;
    const rbXn = rbx * ny - rby * nx;
    this.raXn = raXn;
    this.rbXn = rbXn;
    this.kN = this.invMSum + raXn * raXn * invIa + rbXn * rbXn * invIb;
    const tx = -ny;
    const ty = nx;
    const raXt = rax * ty - ray * tx;
    const rbXt = rbx * ty - rby * tx;
    this.raXt = raXt;
    this.rbXt = rbXt;
    this.kT = this.invMSum + raXt * raXt * invIa + rbXt * rbXt * invIb;

    // restitution bias from the pre-solve approach speed (it can rise
    // during the velocity solve as impulse chains propagate - see
    // solveVelocity)
    this.e = e;
    const vn0 = this.normalVelocity();
    this.targetVn = vn0 < -RESTING_SPEED ? -e * vn0 : 0.0;
    // wall manifolds overwrite this with the wall's own key (see wallManifold)
    this.key = b !== null ? pairKey(a.id, b.id) : "";
    // separation along n measured from current positions, so the position
    // pass can track how much overlap remains as bodies get pushed apart:
    // pen_now = pen + sepBase - ((b - a) . n)
    if (b !== null) {
      this.sepBase = (b.pos.x - a.pos.x) * nx + (b.pos.y - a.pos.y) * ny;
    } else {
      this.sepBase = -(a.pos.x * nx + a.pos.y * ny);
    }
  }

  normalVelocity(): number {
    const a = this.a;
    const b = this.b;
    const vax = a.vel.x - a.omega * this.ray;
    const vay = a.vel.y + a.omega * this.rax;
    let vbx = 0.0;
    let vby = 0.0;
    if (b !== null) {
      vbx = b.vel.x - b.omega * this.rby;
      vby = b.vel.y + b.omega * this.rbx;
    }
    return (vbx - vax) * this.nx + (vby - vay) * this.ny;
  }
}

/** Iterated sequential impulses with accumulated clamping.
 *
 * Exits early once the largest correction of a sweep falls below a small
 * fraction of the first sweep's largest correction: grinding contact
 * piles (e.g. a collapsed soft body) then converge in a few sweeps
 * instead of always burning the full iteration budget. */
/** Sequential pairwise impact resolution (restitution propagation).
 *
 * The clamped solver below treats its restitution bias as a persistent
 * velocity constraint, which is right for a single impact but wrong for a
 * touching CHAIN: interior contacts capture zero pre-solve approach speed
 * (inelastic smear), while re-raising their bias mid-solve would force
 * pairs that already handed their impulse on to keep separating - both
 * distort a Newton's cradle and the latter injects energy.
 *
 * Stiff bodies physically resolve chained impacts as a sequence of
 * pairwise collisions. This pass does exactly that: any contact closing
 * faster than the resting threshold gets the exact two-body collision
 * impulse -(1+e)vn/kN, repeated in sweeps so the impulse propagates down
 * the chain (one ball in, one ball out). Every one-shot is a real
 * two-body collision, so energy is conserved (e=1) or dissipated (e<1),
 * never created. The contact's persistent bias is then zeroed: its bounce
 * has happened, and the clamped sweeps treat it as a resting contact. */
function solveImpacts(manifolds: Manifold[]): void {
  const passes = Math.min(32, manifolds.length + 4);
  for (let pass = 0; pass < passes; pass++) {
    let any = false;
    for (const m of manifolds) {
      const vn = m.normalVelocity();
      if (vn >= -RESTING_SPEED) continue;
      const dpn = (-(1.0 + m.e) * vn) / m.kN;
      m.pnBounce += dpn;
      m.targetVn = 0.0; // its bounce is spent; no persistent separation bias
      const a = m.a;
      const b = m.b;
      a.vel.x -= dpn * m.nx * m.invMa;
      a.vel.y -= dpn * m.ny * m.invMa;
      a.omega -= m.raXn * dpn * m.invIa;
      if (b !== null) {
        b.vel.x += dpn * m.nx * m.invMb;
        b.vel.y += dpn * m.ny * m.invMb;
        b.omega += m.rbXn * dpn * m.invIb;
      }
      any = true;
    }
    if (!any) break;
  }
}

function solveVelocity(manifolds: Manifold[], iterations: number): void {
  let worst0 = 0.0;
  for (let sweep = 0; sweep < iterations; sweep++) {
    let worst = 0.0;
    for (const m of manifolds) {
      const a = m.a;
      const b = m.b;
      const nx = m.nx;
      const ny = m.ny;
      const rax = m.rax;
      const ray = m.ray;
      const rbx = m.rbx;
      const rby = m.rby;
      const invMa = m.invMa;
      const invMb = m.invMb;
      const invIa = m.invIa;
      const invIb = m.invIb;

      // --- normal impulse ---------------------------------------------
      let vax = a.vel.x - a.omega * ray;
      let vay = a.vel.y + a.omega * rax;
      let vbx = 0.0;
      let vby = 0.0;
      if (b !== null) {
        vbx = b.vel.x - b.omega * rby;
        vby = b.vel.y + b.omega * rbx;
      }
      const vn = (vbx - vax) * nx + (vby - vay) * ny;
      let dpn = -(vn - m.targetVn) / m.kN;
      let newPn = m.pn + dpn;
      if (newPn < 0.0) newPn = 0.0;
      dpn = newPn - m.pn;
      m.pn = newPn;
      if (dpn !== 0.0) {
        a.vel.x -= dpn * nx * invMa;
        a.vel.y -= dpn * ny * invMa;
        a.omega -= m.raXn * dpn * invIa;
        if (b !== null) {
          b.vel.x += dpn * nx * invMb;
          b.vel.y += dpn * ny * invMb;
          b.omega += m.rbXn * dpn * invIb;
        }
        const d = dpn > 0.0 ? dpn : -dpn;
        if (d > worst) worst = d;
      }

      // --- friction impulse --------------------------------------------
      if (m.mu > 0.0) {
        vax = a.vel.x - a.omega * ray;
        vay = a.vel.y + a.omega * rax;
        if (b !== null) {
          vbx = b.vel.x - b.omega * rby;
          vby = b.vel.y + b.omega * rbx;
        } else {
          vbx = 0.0;
          vby = 0.0;
        }
        const tx = -ny;
        const ty = nx;
        const vt = (vbx - vax) * tx + (vby - vay) * ty;
        let dpt = -vt / m.kT;
        const maxF = m.mu * (m.pn + m.pnBounce);
        let newPt = m.pt + dpt;
        if (newPt > maxF) newPt = maxF;
        else if (newPt < -maxF) newPt = -maxF;
        dpt = newPt - m.pt;
        m.pt = newPt;
        if (dpt !== 0.0) {
          a.vel.x -= dpt * tx * invMa;
          a.vel.y -= dpt * ty * invMa;
          a.omega -= m.raXt * dpt * invIa;
          if (b !== null) {
            b.vel.x += dpt * tx * invMb;
            b.vel.y += dpt * ty * invMb;
            b.omega += m.rbXt * dpt * invIb;
          }
          const d = dpt > 0.0 ? dpt : -dpt;
          if (d > worst) worst = d;
        }
      }
    }
    if (sweep === 0) worst0 = worst;
    if (worst < IMPULSE_EPSILON || worst < 1e-3 * worst0) break;
  }
}

/** Split-impulse projection: push overlapping bodies apart without
 * touching velocities. Iterated so stacks resolve mutual overlap. */
function solvePosition(manifolds: Manifold[]): void {
  for (let pass = 0; pass < POSITION_ITERATIONS; pass++) {
    let done = true;
    for (const m of manifolds) {
      const a = m.a;
      const b = m.b;
      const nx = m.nx;
      const ny = m.ny;
      let sep: number;
      if (b !== null) {
        sep = (b.pos.x - a.pos.x) * nx + (b.pos.y - a.pos.y) * ny;
      } else {
        sep = -(a.pos.x * nx + a.pos.y * ny);
      }
      const depth = m.pen + m.sepBase - sep - PENETRATION_SLOP;
      if (depth <= 0.0) continue;
      done = false;
      const corr = depth * PROJECTION_PERCENT / m.invMSum;
      a.pos.x -= corr * nx * m.invMa;
      a.pos.y -= corr * ny * m.invMa;
      if (b !== null) {
        b.pos.x += corr * nx * m.invMb;
        b.pos.y += corr * ny * m.invMb;
      }
    }
    if (done) break;
  }
}

/** Split-impulse static friction: hold a resting contact in place tangentially.
 *
 * The velocity solve drives tangential *velocity* to zero each substep, but the
 * body has already been integrated forward by the gravity-along-slope velocity
 * that friction then cancels, so its *position* creeps down-slope a little every
 * substep. This pins the contact point back to an anchor while friction is
 * static (unsaturated), removing the drift without touching velocities (so no
 * energy is injected).
 *
 * Only bodies that cannot rotate (invInertia == 0: point particles, blocks)
 * are pinned. A rotating disc is *supposed* to move along the slope - it rolls -
 * and its contact friction is also unsaturated, so pinning it would wrongly
 * freeze the roll. Non-rotating bodies have no such motion, so anchoring is
 * exactly the point-particle behaviour the user expects.
 *
 * A world-space anchor is valid only for a static-contact component connected
 * to fixed furniture. Freely translating blocks can have zero relative slip
 * without being fixed in world space; pinning that unsupported pair violates
 * Galilean invariance. `markFixedSupport` identifies supported components in
 * O(contacts), and cached anchors are rebased whenever support is absent or
 * newly acquired.
 */
function solveStaticFriction(manifolds: Manifold[]): void {
  const STILL = 0.02; // m/s: far below anything visible, well above solver noise
  for (const m of manifolds) {
    if (!m.anchored || !m.fixedSupport || !m.cachedFixedSupport) continue;
    if (m.pn <= 0.0) continue;           // not pressed together
    if (Math.abs(m.pt) >= m.mu * m.pn * (1 - 1e-6)) continue; // sliding: let it
    const a = m.a;
    const b = m.b;
    const aFix = a.invInertia === 0.0 && a.invMass > 0.0;
    const bFix = b !== null && b.invInertia === 0.0 && b.invMass > 0.0;
    if (!aFix && !bFix) continue;
    const tx = -m.ny;
    const ty = m.nx;
    // Each body carries its own material contact point (the arm is fixed for
    // a non-rotating body), so each has its own tangential slip from the
    // shared anchor, and each is pushed straight back along it.
    if (aFix) {
      const drift = (a.pos.x + m.rax - m.ax) * tx + (a.pos.y + m.ray - m.ay) * ty;
      a.pos.x -= drift * tx;
      a.pos.y -= drift * ty;
    }
    if (bFix) {
      const drift = (b!.pos.x + m.rbx - m.ax) * tx + (b!.pos.y + m.rby - m.ay) * ty;
      b!.pos.x -= drift * tx;
      b!.pos.y -= drift * ty;
    }
    // The anchor pins the position, so any residual velocity below the
    // stillness threshold is pure solver noise - it flickers sign each
    // substep in the inspector readouts of a body in limiting
    // equilibrium. Zeroing it cannot change a trajectory the anchor
    // already controls; a real force that saturates friction releases
    // the anchor and restores normal physics untouched.
    if (aFix && a.vel.length2() < STILL * STILL) a.vel.set(0.0, 0.0);
    if (bFix && b!.vel.length2() < STILL * STILL) b!.vel.set(0.0, 0.0);
  }
}

function fixableBody(b: Body): boolean {
  return b.invInertia === 0.0 && b.invMass > 0.0;
}

/** A structural root does not move as part of physics. `held` is deliberately
 * excluded: a held body is kinematic user input, not world-fixed furniture. */
function fixedRoot(b: Body): boolean {
  return !b.held && (b.locked || b.mass <= 0.0);
}

function staticCandidate(m: Manifold): boolean {
  return m.pn > 0.0 &&
    Math.abs(m.pt) < m.mu * m.pn * (1 - 1e-6);
}

/** Mark every unsaturated, non-rotating static-contact component reachable
 * from a wall or structurally immovable body. Each manifold is inserted into
 * at most two adjacency lists and traversed at most twice. */
function markFixedSupport(manifolds: Manifold[]): void {
  const adjacency = new Map<Body, Array<[Body, Manifold]>>();
  const supported = new Set<Body>();
  const queue: Body[] = [];
  const addSupport = (body: Body, manifold: Manifold): void => {
    manifold.fixedSupport = true;
    if (!supported.has(body)) {
      supported.add(body);
      queue.push(body);
    }
  };
  const addEdge = (from: Body, to: Body, manifold: Manifold): void => {
    let edges = adjacency.get(from);
    if (edges === undefined) adjacency.set(from, edges = []);
    edges.push([to, manifold]);
  };

  for (const m of manifolds) {
    m.fixedSupport = false;
    if (!staticCandidate(m)) continue;
    const aFix = fixableBody(m.a);
    const b = m.b;
    if (b === null) {
      if (aFix) addSupport(m.a, m);
      continue;
    }
    const bFix = fixableBody(b);
    if (fixedRoot(m.a) && bFix) addSupport(b, m);
    if (fixedRoot(b) && aFix) addSupport(m.a, m);
    if (aFix && bFix) {
      addEdge(m.a, b, m);
      addEdge(b, m.a, m);
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const body = queue[head];
    for (const [other, manifold] of adjacency.get(body) ?? []) {
      manifold.fixedSupport = true;
      if (!supported.has(other)) {
        supported.add(other);
        queue.push(other);
      }
    }
  }
}

function pairManifold(a: Body, b: Body, out: Manifold[],
                      excl: Set<string> | null): void {
  if (excl !== null && excl.size > 0 && excl.has(pairKey(a.id, b.id))) {
    return; // directly linked: the link governs their separation
  }
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const rSum = a.radius + b.radius;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rSum * rSum) return;
  if (a.invMass === 0.0 && b.invMass === 0.0) return;
  const d = Math.sqrt(d2);
  let nx: number;
  let ny: number;
  if (d < 1e-9) {
    nx = 1.0;
    ny = 0.0;
  } else {
    nx = dx / d;
    ny = dy / d;
  }
  const penetration = rSum - d;
  const px = a.pos.x + nx * (a.radius - penetration * 0.5);
  const py = a.pos.y + ny * (a.radius - penetration * 0.5);
  const e = a.restitution < b.restitution ? a.restitution : b.restitution;
  const mu = Math.sqrt(a.friction * b.friction);
  out.push(new Manifold(a, b, nx, ny, penetration, px, py, e, mu));
}

/** A body whose position the broadphase can safely compare.
 *
 * A NaN coordinate fails every comparison, so an unguarded pair test with
 * one would report "not overlapping" and "overlapping" in different places
 * and could emit a NaN manifold into the solver. Non-finite bodies are
 * frozen by World.sanitize at the end of the step; until then they simply
 * do not collide. */
function placed(b: Body): boolean {
  return Number.isFinite(b.pos.x) && Number.isFinite(b.pos.y);
}

// forward half-neighbourhood: every unordered cell pair visited once.
// Flat pairs rather than nested arrays so the scan below indexes numbers
// instead of destructuring a tuple per cell per offset.
const OFF_X = [1, 1, 0, -1];
const OFF_Y = [0, 1, 1, 1];

/** Uniform spatial hash over the small bodies, in flat integer arrays.
 *
 * Replaces a `Map` keyed by `"gx,gy"` strings. That map was the single
 * most expensive thing in the densest scenes: the 200-particle gas built
 * 200 key strings and then did ~750 string-hashed lookups (four
 * neighbours per occupied cell) at roughly 120 ns each, which came to
 * 0.12 ms per substep to discover 182 candidate pairs and two actual
 * contacts. Integer hashing with open addressing does the same work
 * without allocating anything at all, and every buffer here is reused
 * between calls.
 *
 * Cell coordinates are kept as float64 rather than int32 so the identity
 * check is exact even for the enormous indices a tiny body's cell size can
 * produce (a 0.1 mm body at the edge of the world is cell 5e9, well past
 * int32). The hash itself may wrap - it only has to spread, not identify.
 *
 * Bodies are grouped by a counting sort, which keeps each cell's members
 * and the cells themselves in first-seen order, exactly as the map's
 * insertion order did: the narrowphase visits identical pairs in an
 * identical sequence, so the solver sees no change at all.
 */
class SpatialHash {
  cells = 0;
  cellGx = new Float64Array(0);
  cellGy = new Float64Array(0);
  cellStart = new Int32Array(0); // first slot of the cell's run in `items`
  cellEnd = new Int32Array(0);   // one past its last slot
  items = new Int32Array(0);     // body indices, grouped by cell
  private table = new Int32Array(0); // hash slot -> cell index, -1 empty
  private mask = 0;
  private bodyCell = new Int32Array(0);

  private ensure(n: number): void {
    if (this.bodyCell.length >= n && this.mask + 1 >= 2 * n) return;
    const cap = Math.max(32, 1 << (32 - Math.clz32(Math.max(1, n) - 1)));
    this.bodyCell = new Int32Array(cap);
    this.items = new Int32Array(cap);
    this.cellGx = new Float64Array(cap);
    this.cellGy = new Float64Array(cap);
    this.cellStart = new Int32Array(cap);
    this.cellEnd = new Int32Array(cap);
    const slots = cap * 4; // load factor 0.25: probes stay very short
    this.table = new Int32Array(slots);
    this.mask = slots - 1;
  }

  /** Cell index holding (gx, gy), or -1. */
  find(gx: number, gy: number): number {
    let h = (Math.imul(gx | 0, 73856093) ^ Math.imul(gy | 0, 19349663)) & this.mask;
    const table = this.table;
    for (;;) {
      const c = table[h];
      if (c === -1) return -1;
      if (this.cellGx[c] === gx && this.cellGy[c] === gy) return c;
      h = (h + 1) & this.mask;
    }
  }

  /** Bin `small` (skipping non-finite positions) into cells of `1/invCell`. */
  build(small: Body[], invCell: number): void {
    const n = small.length;
    this.ensure(n);
    const table = this.table;
    table.fill(-1);
    const bodyCell = this.bodyCell;
    const cellGx = this.cellGx;
    const cellGy = this.cellGy;
    const cellEnd = this.cellEnd;
    let cells = 0;
    for (let i = 0; i < n; i++) {
      const b = small[i];
      const px = b.pos.x;
      const py = b.pos.y;
      if (!Number.isFinite(px) || !Number.isFinite(py)) {
        bodyCell[i] = -1;
        continue;
      }
      const gx = Math.floor(px * invCell);
      const gy = Math.floor(py * invCell);
      let h = (Math.imul(gx | 0, 73856093) ^ Math.imul(gy | 0, 19349663)) & this.mask;
      let c = table[h];
      while (c !== -1 && (cellGx[c] !== gx || cellGy[c] !== gy)) {
        h = (h + 1) & this.mask;
        c = table[h];
      }
      if (c === -1) {
        c = cells++;
        table[h] = c;
        cellGx[c] = gx;
        cellGy[c] = gy;
        cellEnd[c] = 0;
      }
      bodyCell[i] = c;
      cellEnd[c]++;
    }
    this.cells = cells;
    // prefix sum into run starts, then place each body in original order
    const cellStart = this.cellStart;
    let at = 0;
    for (let c = 0; c < cells; c++) {
      cellStart[c] = at;
      at += cellEnd[c];
      cellEnd[c] = cellStart[c]; // reuse as the fill cursor
    }
    const items = this.items;
    for (let i = 0; i < n; i++) {
      const c = bodyCell[i];
      if (c >= 0) items[cellEnd[c]++] = i;
    }
  }
}

// One hash reused for the whole session. Contact detection is never
// re-entered (no workers, no recursion), so a module-level instance is
// safe and keeps every buffer warm across frames.
const GRID = new SpatialHash();

function detectBodies(bodies: Body[], out: Manifold[],
                      staticState: ContactStatic): void {
  let colliders = staticState.colliders;
  if (colliders === undefined) {
    staticState.colliders = colliders = bodies.filter((b) => b.collides);
  }
  if (colliders.length < 2) return;
  const excl = staticState.noCollide ?? null;
  const n = colliders.length;
  if (n <= 6) {
    for (let i = 0; i < n; i++) {
      const a = colliders[i];
      if (!placed(a)) continue;
      for (let j = i + 1; j < n; j++) {
        const b = colliders[j];
        if (placed(b)) pairManifold(a, b, out, excl);
      }
    }
    return;
  }

  // split off outsize bodies so they don't inflate the hash cells; the
  // split and the cell size come from the radii, so they are derived once
  // per step and reused by every substep
  let small = staticState.small;
  let large = staticState.large;
  let cell = staticState.cell;
  if (small === undefined || large === undefined || cell === undefined) {
    const radii = colliders.map((b) => b.radius).sort((x, y) => x - y);
    const bigCut = 3.0 * radii[n >> 1];
    small = [];
    large = [];
    for (const b of colliders) (b.radius > bigCut ? large : small).push(b);
    let maxR = 0.0;
    for (const b of small) if (b.radius > maxR) maxR = b.radius;
    cell = 2.0 * maxR;
    staticState.small = small;
    staticState.large = large;
    staticState.cell = cell;
  }

  for (let i = 0; i < large.length; i++) {
    const a = large[i];
    if (!placed(a)) continue;
    for (let j = i + 1; j < large.length; j++) {
      const b = large[j];
      if (placed(b)) pairManifold(a, b, out, excl);
    }
    for (const b of small) {
      if (placed(b)) pairManifold(a, b, out, excl);
    }
  }

  if (small.length < 2 || cell <= 1e-9) return;
  GRID.build(small, 1.0 / cell);
  const { cells, cellGx, cellGy, cellStart, cellEnd, items } = GRID;
  for (let c = 0; c < cells; c++) {
    const lo = cellStart[c];
    const hi = cellEnd[c];
    for (let i = lo; i < hi; i++) {
      const a = small[items[i]];
      for (let j = i + 1; j < hi; j++) {
        pairManifold(a, small[items[j]], out, excl);
      }
    }
    const gx = cellGx[c];
    const gy = cellGy[c];
    for (let o = 0; o < 4; o++) {
      const other = GRID.find(gx + OFF_X[o], gy + OFF_Y[o]);
      if (other < 0) continue;
      const olo = cellStart[other];
      const ohi = cellEnd[other];
      for (let i = lo; i < hi; i++) {
        const a = small[items[i]];
        for (let j = olo; j < ohi; j++) {
          pairManifold(a, small[items[j]], out, excl);
        }
      }
    }
  }
}

/** Narrowphase circle-vs-capsule test; appends a manifold on overlap. */
function wallManifold(body: Body, w: Wall, ax: number, ay: number,
                      sx: number, sy: number, segLen2: number,
                      halfT: number, out: Manifold[]): void {
  const px = body.pos.x;
  const py = body.pos.y;
  // closest point on the segment to the body centre
  let t: number;
  if (segLen2 > 0.0) {
    t = ((px - ax) * sx + (py - ay) * sy) / segLen2;
    if (t < 0.0) t = 0.0;
    else if (t > 1.0) t = 1.0;
  } else {
    t = 0.0;
  }
  const cx = ax + sx * t;
  const cy = ay + sy * t;
  const dx = px - cx;
  const dy = py - cy;
  const reach = body.radius + halfT;
  const d2 = dx * dx + dy * dy;
  if (d2 >= reach * reach) return;
  const d = Math.sqrt(d2);
  let nx: number;
  let ny: number;
  if (d < 1e-9) {
    // centre exactly on the segment: push out along the normal
    const inv = segLen2 > 0 ? 1.0 / Math.sqrt(segLen2) : 1.0;
    nx = -sy * inv;
    ny = sx * inv;
  } else {
    nx = dx / d;
    ny = dy / d;
  }
  const penetration = reach - d;
  const cpx = px - nx * (body.radius - penetration * 0.5);
  const cpy = py - ny * (body.radius - penetration * 0.5);
  const e = body.restitution < w.restitution ? body.restitution : w.restitution;
  const mu = Math.sqrt(body.friction * w.friction);
  // manifold normal points from the body (a) into the wall
  const m = new Manifold(body, null, -nx, -ny, penetration, cpx, cpy, e, mu);
  m.key = `${body.id},${-w.id}`;
  out.push(m);
}

function detectWalls(bodies: Body[], walls: Wall[], out: Manifold[],
                     staticState: ContactStatic): void {
  if (walls.length === 0) return;
  let movers = staticState.movers;
  if (movers === undefined) {
    // NaN positions drop out of the box comparisons on their own
    staticState.movers = movers =
      bodies.filter((b) => b.collides && b.invMass !== 0.0);
  }
  if (movers.length === 0) return;

  let maxR = 0.0;
  for (const b of movers) if (b.radius > maxR) maxR = b.radius;
  for (const w of walls) {
    const ax = w.a.x;
    const ay = w.a.y;
    const bx = w.b.x;
    const by = w.b.y;
    const sx = bx - ax;
    const sy = by - ay;
    const segLen2 = sx * sx + sy * sy;
    const halfT = w.thickness * 0.5;
    const reachMax = maxR + halfT;
    const loX = (ax < bx ? ax : bx) - reachMax;
    const hiX = (ax > bx ? ax : bx) + reachMax;
    const loY = (ay < by ? ay : by) - reachMax;
    const hiY = (ay > by ? ay : by) + reachMax;
    for (const body of movers) {
      const px = body.pos.x;
      const py = body.pos.y;
      if (loX <= px && px <= hiX && loY <= py && py <= hiY) {
        wallManifold(body, w, ax, ay, sx, sy, segLen2, halfT, out);
      }
    }
  }
}

/** Re-apply the impulses each persistent contact carried last substep.
 *
 * Resting stacks then start each substep already near equilibrium, so a
 * couple of polish iterations converge instead of rebuilding the whole
 * load-bearing impulse chain from zero every substep (Box2D's scheme). */
function warmStart(manifolds: Manifold[], cache: ContactCache): void {
  for (const m of manifolds) {
    const cached = cache.get(m.key);
    if (cached === undefined) continue;
    const pn = cached.normalImpulse;
    const pt = cached.tangentImpulse;
    m.pn = pn;
    m.pt = pt;
    m.cachedFixedSupport = cached.fixedSupport;
    if (cached.anchored) {
      m.ax = cached.anchorX;
      m.ay = cached.anchorY;
      m.anchored = true;
    }
    const nx = m.nx;
    const ny = m.ny;
    const ix = pn * nx - pt * ny;
    const iy = pn * ny + pt * nx;
    const a = m.a;
    const b = m.b;
    a.vel.x -= ix * m.invMa;
    a.vel.y -= iy * m.invMa;
    a.omega -= (m.raXn * pn + m.raXt * pt) * m.invIa;
    if (b !== null) {
      b.vel.x += ix * m.invMb;
      b.vel.y += iy * m.invMb;
      b.omega += (m.rbXn * pn + m.rbXt * pt) * m.invIb;
    }
  }
}

/** Detect all contacts this substep and resolve them together.
 *
 * `cache` is an optional persistent map carrying accumulated impulses
 * between substeps (warm starting); pass the same map every substep.
 * `staticState` is a per-step object for detection state that cannot
 * change within a step; pass a fresh object at the start of every step.
 */
export function solveContacts(bodies: Body[], walls: Wall[],
                              contacts: Contact[], iterations: number,
                              cache: ContactCache | null = null,
                              staticState: ContactStatic = {}): void {
  const manifolds: Manifold[] = [];
  detectBodies(bodies, manifolds, staticState);
  detectWalls(bodies, walls, manifolds, staticState);
  // refresh the persistent-contact flags the adaptive-timestep heuristics
  // read: a body held by contacts is not in a gravitational close encounter
  for (const b of bodies) b.touching = false;
  for (const m of manifolds) {
    m.a.touching = true;
    if (m.b !== null) m.b.touching = true;
  }
  if (cache !== null) {
    if (manifolds.length > 0) warmStart(manifolds, cache);
    cache.clear();
  }
  if (manifolds.length === 0) return;
  // under very heavy contact load (collapsed lattices, dense piles) trade
  // iterations for speed: warm starting carries the converged impulses
  // between substeps, so a few polish sweeps are enough to stay stable
  if (manifolds.length * iterations > 400) {
    iterations = Math.max(4, Math.floor(400 / manifolds.length));
  }
  solveImpacts(manifolds);
  solveVelocity(manifolds, iterations);
  solvePosition(manifolds);
  markFixedSupport(manifolds);
  solveStaticFriction(manifolds);
  for (const m of manifolds) {
    contacts.push(new Contact(m.px, m.py, m.nx, m.ny, m.pn + m.pnBounce));
    if (cache === null) continue;
    const aFix = m.a.invInertia === 0.0 && m.a.invMass > 0.0;
    const bFix = m.b !== null && m.b.invInertia === 0.0 && m.b.invMass > 0.0;
    const base = {
      normalImpulse: m.pn,
      tangentImpulse: m.pt,
      anchorX: m.px,
      anchorY: m.py,
      anchored: false,
      fixedSupport: false,
    } satisfies ContactCacheEntry;
    if (!aFix && !bFix) {
      cache.set(m.key, base); // no anchor needed (rotating/immovable)
      continue;
    }
    // Unsupported contacts deliberately rebase on every substep. A newly
    // supported contact also rebases once before it may pin, so motion while
    // unsupported can never be corrected back to a stale world point.
    const preserve = m.anchored && m.cachedFixedSupport && m.fixedSupport;
    cache.set(m.key, {
      ...base,
      anchorX: preserve ? m.ax : m.px,
      anchorY: preserve ? m.ay : m.py,
      anchored: true,
      fixedSupport: m.fixedSupport,
    });
  }
}
