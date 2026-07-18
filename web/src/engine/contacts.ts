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
 * lists, link exclusions); pass a fresh object at the start of every step. */
export interface ContactStatic {
  noCollide?: Set<string>;
  colliders?: Body[];
  movers?: Body[];
}

/** Persistent per-contact cache carried between substeps: [pn, pt] for warm
 * starting, optionally followed by [ax, ay] - a tangential position anchor for
 * static resting friction (see solveStaticFriction). */
export type ContactCache = Map<string, number[]>;

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
  pn = 0.0;
  pt = 0.0;
  // static-friction position anchor (world contact point) carried from the
  // previous substep; `anchored` is false for a brand-new contact
  ax = 0.0;
  ay = 0.0;
  anchored = false;
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
    const invMa = a.invMass;
    const invIa = a.invInertia;
    let invMb = 0.0;
    let invIb = 0.0;
    if (b !== null) {
      invMb = b.invMass;
      invIb = b.invInertia;
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

    // restitution bias from the pre-solve approach speed
    const vn0 = this.normalVelocity();
    this.targetVn = vn0 < -RESTING_SPEED ? -e * vn0 : 0.0;
    this.key = b !== null ? `${a.id},${b.id}` : `${a.id},0`;
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
        const maxF = m.mu * m.pn;
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
 * exactly the point-particle behaviour the user expects. */
function solveStaticFriction(manifolds: Manifold[]): void {
  for (const m of manifolds) {
    if (!m.anchored) continue;           // no reference point yet (new contact)
    if (m.pn <= 0.0) continue;           // not pressed together
    if (Math.abs(m.pt) >= m.mu * m.pn * (1 - 1e-6)) continue; // sliding: let it
    const a = m.a;
    const b = m.b;
    const aFix = a.invInertia === 0.0 && a.invMass > 0.0;
    const bFix = b !== null && b.invInertia === 0.0 && b.invMass > 0.0;
    const invSum = (aFix ? a.invMass : 0.0) + (bFix ? b!.invMass : 0.0);
    if (invSum <= 0.0) continue;
    // current contact point tracks each fixable body's centre (its arm is
    // fixed for a non-rotating body); drift is its tangential slip from anchor
    const tx = -m.ny;
    const ty = m.nx;
    const cx = a.pos.x + m.rax; // material contact point on a, this step
    const cy = a.pos.y + m.ray;
    const driftT = (cx - m.ax) * tx + (cy - m.ay) * ty;
    if (driftT === 0.0) continue;
    const corr = driftT / invSum;
    if (aFix) {
      a.pos.x -= corr * a.invMass * tx;
      a.pos.y -= corr * a.invMass * ty;
    }
    if (bFix) {
      b!.pos.x += corr * b!.invMass * tx;
      b!.pos.y += corr * b!.invMass * ty;
    }
  }
}

function pairKey(idA: number, idB: number): string {
  return idA < idB ? `${idA},${idB}` : `${idB},${idA}`;
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

function detectBodies(bodies: Body[], out: Manifold[],
                      staticState: ContactStatic): void {
  let colliders = staticState.colliders;
  if (colliders === undefined) {
    staticState.colliders = colliders = bodies.filter((b) => b.collides);
  }
  if (colliders.length < 2) return;
  const excl = staticState.noCollide ?? null;
  const finite = colliders.filter(
    (b) => Number.isFinite(b.pos.x) && Number.isFinite(b.pos.y));
  const n = finite.length;
  if (n < 2) return;
  if (n <= 6) {
    for (let i = 0; i < n; i++) {
      const a = finite[i];
      for (let j = i + 1; j < n; j++) pairManifold(a, finite[j], out, excl);
    }
    return;
  }

  // split off outsize bodies so they don't inflate the hash cells
  const radii = finite.map((b) => b.radius).sort((x, y) => x - y);
  const rMed = radii[n >> 1];
  const bigCut = 3.0 * rMed;
  const small: Body[] = [];
  const large: Body[] = [];
  for (const b of finite) (b.radius > bigCut ? large : small).push(b);

  for (let i = 0; i < large.length; i++) {
    const a = large[i];
    for (let j = i + 1; j < large.length; j++) pairManifold(a, large[j], out, excl);
    for (const b of small) pairManifold(a, b, out, excl);
  }

  if (small.length < 2) return;
  let maxR = 0.0;
  for (const b of small) if (b.radius > maxR) maxR = b.radius;
  const cell = 2.0 * maxR;
  if (cell <= 1e-9) return;
  const invCell = 1.0 / cell;
  const grid = new Map<string, Body[]>();
  const coords = new Map<string, [number, number]>();
  for (const b of small) {
    const gx = Math.floor(b.pos.x * invCell);
    const gy = Math.floor(b.pos.y * invCell);
    const key = `${gx},${gy}`;
    const bucket = grid.get(key);
    if (bucket === undefined) {
      grid.set(key, [b]);
      coords.set(key, [gx, gy]);
    } else {
      bucket.push(b);
    }
  }
  // forward half-neighbourhood: every unordered cell pair visited once
  const OFFSETS: ReadonlyArray<readonly [number, number]> =
    [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (const [key, bucket] of grid) {
    const ln = bucket.length;
    for (let i = 0; i < ln; i++) {
      const a = bucket[i];
      for (let j = i + 1; j < ln; j++) pairManifold(a, bucket[j], out, excl);
    }
    const [gx, gy] = coords.get(key)!;
    for (const [ox, oy] of OFFSETS) {
      const other = grid.get(`${gx + ox},${gy + oy}`);
      if (other !== undefined) {
        for (const a of bucket) {
          for (const b of other) pairManifold(a, b, out, excl);
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
    const [pn, pt] = cached;
    m.pn = pn;
    m.pt = pt;
    if (cached.length >= 4) { // a static-friction anchor from last substep
      m.ax = cached[2];
      m.ay = cached[3];
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
  solveVelocity(manifolds, iterations);
  solvePosition(manifolds);
  solveStaticFriction(manifolds);
  for (const m of manifolds) {
    contacts.push(new Contact(m.px, m.py, m.nx, m.ny, m.pn));
    if (cache === null) continue;
    const aFix = m.a.invInertia === 0.0 && m.a.invMass > 0.0;
    const bFix = m.b !== null && m.b.invInertia === 0.0 && m.b.invMass > 0.0;
    if (!aFix && !bFix) {
      cache.set(m.key, [m.pn, m.pt]); // no anchor needed (rotating/immovable)
      continue;
    }
    // keep the anchor while a static contact persists; (re)set it to the
    // current contact point on a new contact or once friction is sliding
    const saturated = Math.abs(m.pt) >= m.mu * m.pn * (1 - 1e-6);
    if (m.anchored && !saturated && m.pn > 0.0) {
      cache.set(m.key, [m.pn, m.pt, m.ax, m.ay]);
    } else {
      cache.set(m.key, [m.pn, m.pt, m.px, m.py]);
    }
  }
}
