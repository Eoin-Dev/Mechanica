/** Performance mode's solver: engineered for robustness, not for accuracy.
 *
 * The rest of the engine treats a spring as what it physically is - a smooth
 * force, F = -k*extension, handed to an explicit integrator. That is the
 * accurate treatment, and it is also the one that cannot be made
 * unconditionally stable: an explicit scheme only survives while h*omega
 * stays small, so every stiffness has a timestep it will explode at.
 * World.prepareSprings therefore clamps each spring's effective k and c down
 * to that limit.
 *
 * The clamp is computed PER SPRING, from that one spring's reduced mass, and
 * that is where performance mode came apart. A soft-body particle is not on
 * one spring; an interior particle of a lattice is on twelve - four
 * structural, four shear, four bend - and the stiffness they present to the
 * node is their sum. Clamping each one to the single-spring margin leaves the
 * node itself at roughly 4.5 times it, so h*omega lands near 1.5, and the
 * per-spring damping limit (chosen so no ONE spring overshoots in a step)
 * exceeds 1 when summed - which is an explicit-damping instability with
 * nothing to stop it. The Jelly block, Jelly smash and Trampoline presets all
 * reached ~1e7 m/s within three seconds of being played in performance mode,
 * and raising the stiffness slider only moved the explosion earlier.
 *
 * So this mode stops integrating springs at all. Every spring becomes a
 * POSITION CONSTRAINT solved by projection (XPBD), and the whole class of
 * failure above disappears rather than being tuned around:
 *
 *   - A projection can only move an endpoint TOWARDS satisfying its
 *     constraint, by at most the constraint error itself. There is no
 *     h*omega, no growth factor and therefore no stability limit: the
 *     stiffness slider can be pushed to its maximum, or a hand-edited scene
 *     can ask for 1e9, and the spring simply becomes a rigid rod.
 *   - Stiffness enters as XPBD compliance, 1/k, so it stays meaningful and
 *     monotone across the whole slider: soft springs barely correct, stiff
 *     ones correct almost fully, and the two ends saturate instead of
 *     diverging.
 *   - Damping is applied as a bounded velocity projection - remove at most
 *     100% of a pair's relative axial velocity - so it can never reverse a
 *     velocity, which is exactly how explicit damping blows up.
 *
 * On top of that sit three cheap guards that make "never catastrophically
 * explodes" a property of the code rather than a hope, and which also cover
 * the parts of the pipeline this module does not own (contacts, force fields,
 * the N-body encounters the mode declines to slice):
 *
 *   - a hard strain limit, so a lattice physically cannot come apart;
 *   - a speed ceiling, so no body can reach the range where positions stop
 *     being representable;
 *   - a small dissipation applied only to spring-connected bodies, so any
 *     residual energy the projections inject bleeds away instead of
 *     accumulating - and soft bodies settle, which is what "smooth and
 *     consistent" looks like.
 *
 * Everything here is deliberately non-physical. A jelly is squishier than its
 * stiffness says, a trampoline dissipates more than it should, and the energy
 * graph is not worth reading. That is the trade this mode exists to make; the
 * accurate path is one checkbox away and untouched.
 */
import { Body } from "./body";
import { SpringLink } from "./links";

// Performance mode's solver ceilings. Deliberately blunt: they are not a
// tuning of the accuracy/cost curve but a decision to stop paying for
// accuracy at all, for the scenes where nobody was measuring anything - a
// soft body being poked, a hundred particles piled on a planet.
//
// Measured on Earth & Moon plus 200 loose particles all in mutual contact
// (415 simultaneous contacts): 15.8 ms of physics per displayed frame at the
// authored settings, which does not fit in a 60 Hz frame at all, against
// 1.9 ms here. Symplectic Euler halves the force evaluations on top, and
// dropping the adaptive machinery removes a multiplier that reached 16x.
export const PERF_SUBSTEPS = 2;
export const PERF_ITERATIONS = 4;

// Gauss-Seidel passes for the spring projection.
//
// Under-converging is safe here in a way it is not for an explicit force: it
// makes a lattice softer and laggier, never unstable. So this is purely a
// quality-for-cost knob, and it was measured rather than guessed - the worst
// strain the Jelly block, Squishy ball and Soft wheel reach over 7.5 s at the
// maximum stiffness the inspector offers is the same to three decimal places
// at 4, 6 and 8 passes (0.199 / 0.197 / 0.196 for the Jelly block). Extra
// passes buy nothing because PERF_MAX_MOVE_RADII bounds the recovery per
// substep anyway, and they are what made this mode SLOWER than the model it
// replaces on a 300-spring lattice: 209 us a step at 8, 152 us at 4, against
// the accurate solver's 158 us.
export const PERF_SPRING_PASSES = 4;

// Hard speed ceiling, m/s. Nothing in the shipped library moves faster than
// about 120 m/s (the Trampoline's bed particles mid-bounce) and most scenes
// stay under 20, so this is far above anything legitimate; it exists so that
// a singular force field, a deep N-body encounter this mode declines to
// slice, or a contact resolved in four iterations instead of thirty-two
// cannot walk a body out to the 1e7 range where sanitize() has to freeze it.
export const PERF_MAX_SPEED = 500.0;

// How far a spring may be stretched or squashed before it is projected back
// by force, as a multiple of its natural length.
//
// Very generous on purpose: this is a catastrophe bound, not a shaping tool,
// and the projection above already makes it dead code in every scene that
// behaves. A tight bound here is actively harmful - the Trampoline's bed sits
// at 2.3x its natural length in its own authored REST shape, because the rest
// lengths are deliberately shorter than the anchor spacing - and a limit of 3x
// pinned every segment against the ceiling from the first frame.
//
// The compressive floor exists for a different reason: it keeps a folded
// lattice out of the degenerate near-zero-length state where the constraint
// normal stops being meaningful. It does not apply to tension-only springs,
// whose normal state is slack.
export const PERF_MAX_STRETCH = 10.0;
export const PERF_MIN_SQUASH = 0.05;

// How far the projection may move one body in a single substep, as a
// multiple of that body's own radius.
//
// A position solve knows nothing about collisions, so without a bound it can
// teleport a body straight through another one. That is not a theoretical
// worry: it is what broke the Trampoline. The gymnast pressed the bed down,
// the near-rigid projection snapped a 5.5 cm bed particle 37 cm back up in
// one substep - through the 60 cm gymnast - and from then on the bed was
// above the gymnast instead of under it, so the gymnast simply kept falling.
// Clamped, the same recovery takes a dozen substeps and the particle stays on
// the side of the contact it belongs on.
//
// Half a radius per substep is far more than ordinary deformation asks for
// (for the Jelly block's particles it is 9.5 m/s of recovery speed) and well
// under the radius that a tunnelling test would need. The floor beside it is
// for scenes built from very small particles: at the 0.1 mm minimum radius a
// body may have, half a radius would let the projection recover at 1 cm/s,
// which reads as the springs having stopped working. A body that small
// tunnels through things at any speed, so bounding it by its own size buys
// nothing worth having anyway.
export const PERF_MAX_MOVE_RADII = 0.5;
export const PERF_MIN_MOVE = 0.01; // m

// Ceiling on the fraction of a pair's relative axial velocity that spring
// damping may remove in one substep. Half, not all of it: removing all of it
// is stable but leaves a lattice completely dead, and the coarse substep this
// mode runs at already multiplies whatever fraction is chosen.
export const PERF_MAX_DAMP_FRACTION = 0.5;

// How much of its network's inertia a spring-connected body may present to a
// contact, as a multiple of its own mass (see the Manifold constructor, which
// also caps it at parity with whatever it is in contact with, so it can never
// make the lighter body the heavier one).
//
// Sixty-four is chosen from the worst ratio in the library: the Trampoline's
// 64 kg gymnast against 100 g bed particles. It brings the particle to 6.4 kg,
// which transfers about a fifth of the approach speed per substep of contact -
// enough to turn the gymnast around over the dozen substeps it is in contact,
// without pretending the bed is a solid floor.
export const PERF_SPRUNG_CONTACT_GAIN = 64.0;

// Velocity decay (1/s) applied ONLY to spring-connected bodies. Gentle
// enough to be invisible on a bouncing jelly - the soft-body presets already
// carry spring damping an order of magnitude stronger - and it is the reason
// no slow accumulation of projection energy can turn into a fast one. It is
// restricted to sprung bodies so that orbits, pendulums and projectiles,
// which have nothing to do with the failure this mode is being hardened
// against, keep the trajectories they would have had.
export const PERF_SPRUNG_DAMPING = 0.5;

/** How far the projection may move this body within one substep. */
function moveAllowance(b: Body): number {
  const byRadius = b.radius * PERF_MAX_MOVE_RADII;
  return byRadius > PERF_MIN_MOVE ? byRadius : PERF_MIN_MOVE;
}

/** The whole spring stage of a performance-mode substep, over packed arrays.
 *
 * One instance per World. Everything between `gather` and `scatter` runs on
 * flat typed arrays rather than off the bodies, for the same reason
 * World.accumulateGravity packs its O(n^2) attraction pass: this is the one
 * part of the mode that runs thousands of times per step, and reaching a
 * coordinate through Body -> Vec2 -> number scatters every read across as
 * many small objects as there are bodies. Packing is O(springs) and buys back
 * several times its own cost - at an equal eight passes it took the Jelly
 * block's spring stage from 285 us a step to 130 us, and settling on four
 * (see PERF_SPRING_PASSES) took it to 75. Between them they are the
 * difference between this mode being faster than the force model it replaces
 * and being three times slower than it.
 *
 * The arrays are grown geometrically and never shrunk; `nRows` and `nPack`
 * alone bound what is live.
 */
export class PerfSolver {
  // body pack: every endpoint at least one spring can move
  private pBody: Body[] = [];
  private px = new Float64Array(0);  // position, mutated by the projection
  private py = new Float64Array(0);
  private px0 = new Float64Array(0); // position as the substep's solve began
  private py0 = new Float64Array(0);
  private pvx = new Float64Array(0);
  private pvy = new Float64Array(0);
  private pw = new Float64Array(0);  // inverse mass
  private pmove = new Float64Array(0); // per-substep displacement allowance
  private nPack = 0;
  // spring rows, indexing into the pack
  private ia = new Int32Array(0);
  private ib = new Int32Array(0);
  private row = new Float64Array(0);
  private nRows = 0;
  private stamp = 0;
  // row layout: alpha, rest, lambda, gamma, maxLen, minLen, tensionOnly
  private static W = 7;

  /** Project, damp and strain-limit every spring for one substep of `h`. */
  solve(springs: SpringLink[], h: number, passes: number): void {
    if (!this.gather(springs, h)) return;
    this.project(passes);
    this.applyVelocities(h);
    this.limitStrain();
    this.scatter();
  }

  /** Pack the springs and their endpoints. Returns false if there is nothing
   * to solve. */
  private gather(springs: SpringLink[], h: number): boolean {
    const W = PerfSolver.W;
    const maxRows = springs.length;
    if (this.row.length < maxRows * W) {
      const cap = Math.max(16, maxRows * 2);
      this.row = new Float64Array(cap * W);
      this.ia = new Int32Array(cap);
      this.ib = new Int32Array(cap);
    }
    if (this.px.length < maxRows * 2) {
      const cap = Math.max(32, maxRows * 4);
      this.px = new Float64Array(cap);
      this.py = new Float64Array(cap);
      this.px0 = new Float64Array(cap);
      this.py0 = new Float64Array(cap);
      this.pvx = new Float64Array(cap);
      this.pvy = new Float64Array(cap);
      this.pw = new Float64Array(cap);
      this.pmove = new Float64Array(cap);
    }
    const row = this.row;
    const ia = this.ia;
    const ib = this.ib;
    const px = this.px;
    const py = this.py;
    const px0 = this.px0;
    const py0 = this.py0;
    const pvx = this.pvx;
    const pvy = this.pvy;
    const pw = this.pw;
    const pmove = this.pmove;
    const pBody = this.pBody;
    // A stamp rather than a Set or a Map: all this needs is "is this body
    // already in the pack, and where", which two numbers on the body answer
    // without allocating anything per substep.
    const stamp = ++this.stamp;
    const invH2 = 1.0 / (h * h);
    let n = 0;
    let nPack = 0;
    for (const s of springs) {
      const a = s.a;
      const b = s.b;
      const wa = a.invMass;
      const wb = b.invMass;
      const wSum = wa + wb;
      if (wSum === 0.0) continue;   // both ends immovable
      const k = s.kEff;
      if (!(k > 0.0)) continue;     // k = 0 or NaN: no constraint at all
      const rest = s.restLength;
      if (!(rest >= 0.0)) continue; // NaN rest length: nothing to project to
      if (a.perfStamp !== stamp) {
        a.perfStamp = stamp;
        a.perfSlot = nPack;
        px[nPack] = px0[nPack] = a.pos.x;
        py[nPack] = py0[nPack] = a.pos.y;
        pvx[nPack] = a.vel.x;
        pvy[nPack] = a.vel.y;
        pw[nPack] = wa;
        pmove[nPack] = moveAllowance(a);
        pBody[nPack] = a;
        nPack++;
      }
      if (b.perfStamp !== stamp) {
        b.perfStamp = stamp;
        b.perfSlot = nPack;
        px[nPack] = px0[nPack] = b.pos.x;
        py[nPack] = py0[nPack] = b.pos.y;
        pvx[nPack] = b.vel.x;
        pvy[nPack] = b.vel.y;
        pw[nPack] = wb;
        pmove[nPack] = moveAllowance(b);
        pBody[nPack] = b;
        nPack++;
      }
      ia[n] = a.perfSlot;
      ib[n] = b.perfSlot;
      const o = n * W;
      row[o] = invH2 / k; // XPBD alpha-tilde = compliance / h^2
      row[o + 1] = rest;
      row[o + 2] = 0.0;   // lambda accumulates within this substep only
      // Damping as the FRACTION of the pair's relative axial velocity to
      // remove, capped at all of it. The force form, F = -c*v_rel, is what
      // an explicit integrator overshoots on: one step of it can reverse the
      // velocity it was meant to reduce, and a node on twelve springs applies
      // it twelve times. A capped fraction is a convex blend towards the
      // pair's common velocity instead, and blends towards means cannot
      // amplify - whatever the damping, the timestep or the node's valence.
      const c = s.cEff;
      const gamma = c > 0.0 ? c * h * wSum : 0.0;
      row[o + 3] = gamma > PERF_MAX_DAMP_FRACTION ? PERF_MAX_DAMP_FRACTION : gamma;
      // A spring whose natural length is zero (only reachable from a scene
      // file - the Inspector's slider bottoms out at 1 cm) has no meaningful
      // multiple of itself, and taking one literally would have the limiter
      // force its endpoints to be exactly coincident. Switch it off instead;
      // the projection handles a zero-rest spring correctly on its own.
      if (rest > 1e-9) {
        row[o + 4] = rest * PERF_MAX_STRETCH;
        row[o + 5] = rest * PERF_MIN_SQUASH;
      } else {
        row[o + 4] = Infinity;
        row[o + 5] = -1.0;
      }
      row[o + 6] = s.tensionOnly ? 1.0 : 0.0;
      n++;
    }
    this.nRows = n;
    this.nPack = nPack;
    return n > 0;
  }

  /** Gauss-Seidel XPBD passes over the packed rows.
   *
   * Each constraint is solved in XPBD form with compliance 1/k:
   *
   *   dlambda = (-C - alpha*lambda) / (wa + wb + alpha),  alpha = 1/(k*h^2)
   *
   * which reduces to a rigid distance projection as k grows and to no
   * correction at all as k falls. `dlambda` is bounded by C for every k, so
   * no stiffness, timestep or mass ratio can make this step grow: that is
   * the entire point of doing it here rather than in the force pass.
   */
  private project(passes: number): void {
    const W = PerfSolver.W;
    const n = this.nRows;
    const row = this.row;
    const ia = this.ia;
    const ib = this.ib;
    const px = this.px;
    const py = this.py;
    const pw = this.pw;
    for (let pass = 0; pass < passes; pass++) {
      let worst = 0.0;
      for (let i = 0; i < n; i++) {
        const o = i * W;
        const A = ia[i];
        const B = ib[i];
        const dx = px[B] - px[A];
        const dy = py[B] - py[A];
        const d2 = dx * dx + dy * dy;
        if (d2 < 1e-24) continue; // coincident: no direction to correct along
        const dist = Math.sqrt(d2);
        const c = dist - row[o + 1];
        if (c <= 0.0 && row[o + 6] !== 0.0) continue; // slack string
        const alpha = row[o];
        const lam = row[o + 2];
        const wa = pw[A];
        const wb = pw[B];
        const dlam = (-c - alpha * lam) / (wa + wb + alpha);
        row[o + 2] = lam + dlam;
        const mag = dlam > 0.0 ? dlam : -dlam;
        if (mag > worst) worst = mag;
        const sa = (-wa * dlam) / dist;
        const sb = (wb * dlam) / dist;
        px[A] += sa * dx;
        py[A] += sa * dy;
        px[B] += sb * dx;
        py[B] += sb * dy;
      }
      if (worst < 1e-10) break; // converged
    }
  }

  /** Bound each body's total displacement, turn it into velocity, then damp.
   *
   * The displacement is what actually moved these bodies this substep, so
   * discarding it would make the lattice behave like treacle: a compressed
   * spring would push its endpoints apart and they would arrive with no
   * momentum at all. Damping is applied afterwards, against the velocities
   * the projection just produced.
   *
   * Clamping the displacement (see PERF_MAX_MOVE_RADII) is what stops the
   * projection teleporting a body through something it should have collided
   * with. It is applied to the total, after all the passes, so a body pulled
   * hard by several constraints at once is bounded by where it ended up
   * rather than by each constraint's share.
   */
  private applyVelocities(h: number): void {
    const invH = 1.0 / h;
    const nPack = this.nPack;
    const px = this.px;
    const py = this.py;
    const px0 = this.px0;
    const py0 = this.py0;
    const pvx = this.pvx;
    const pvy = this.pvy;
    const pmove = this.pmove;
    for (let i = 0; i < nPack; i++) {
      let dx = px[i] - px0[i];
      let dy = py[i] - py0[i];
      const limit = pmove[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > limit * limit) {
        const scale = limit / Math.sqrt(d2);
        dx *= scale;
        dy *= scale;
        px[i] = px0[i] + dx;
        py[i] = py0[i] + dy;
      }
      pvx[i] += dx * invH;
      pvy[i] += dy * invH;
    }
    const W = PerfSolver.W;
    const n = this.nRows;
    const row = this.row;
    const ia = this.ia;
    const ib = this.ib;
    const pw = this.pw;
    for (let i = 0; i < n; i++) {
      const o = i * W;
      const gamma = row[o + 3];
      if (gamma === 0.0) continue;
      const A = ia[i];
      const B = ib[i];
      const dx = px[B] - px[A];
      const dy = py[B] - py[A];
      const d2 = dx * dx + dy * dy;
      if (d2 < 1e-24) continue;
      const dist = Math.sqrt(d2);
      if (row[o + 6] !== 0.0 && dist <= row[o + 1]) continue; // slack: no damping
      const nx = dx / dist;
      const ny = dy / dist;
      const vn = (pvx[B] - pvx[A]) * nx + (pvy[B] - pvy[A]) * ny;
      if (vn === 0.0) continue;
      const wa = pw[A];
      const wb = pw[B];
      const j = (-gamma * vn) / (wa + wb);
      pvx[A] -= j * wa * nx;
      pvy[A] -= j * wa * ny;
      pvx[B] += j * wb * nx;
      pvy[B] += j * wb * ny;
    }
  }

  /** Hard geometric bound on every spring: the last line of defence.
   *
   * The projection above is already unconditionally stable, so in a scene
   * that behaves this never fires at all. It is here for everything else that
   * shares these endpoints - a contact resolved in four iterations instead of
   * thirty-two, a force field with a singularity, a body the user flings
   * across the canvas - and it makes "a soft body cannot come apart" true by
   * construction rather than by argument.
   *
   * Only the velocity that is making the violation WORSE is removed. Killing
   * the relative velocity outright sounds safer and is not: it also cancels
   * the motion that would recover the violation, so a spring pinned against
   * the limit stays pinned, which is far more visible than the overshoot it
   * was guarding against.
   */
  private limitStrain(): void {
    const W = PerfSolver.W;
    const n = this.nRows;
    const row = this.row;
    const ia = this.ia;
    const ib = this.ib;
    const px = this.px;
    const py = this.py;
    const pvx = this.pvx;
    const pvy = this.pvy;
    const pw = this.pw;
    for (let i = 0; i < n; i++) {
      const o = i * W;
      const A = ia[i];
      const B = ib[i];
      const dx = px[B] - px[A];
      const dy = py[B] - py[A];
      const d2 = dx * dx + dy * dy;
      if (d2 < 1e-24) continue;
      const dist = Math.sqrt(d2);
      let target = 0.0;
      let worsening = 0.0; // sign of relative normal velocity that worsens it
      if (dist > row[o + 4]) {
        target = row[o + 4];
        worsening = 1.0; // separating
      } else if (dist < row[o + 5] && row[o + 6] === 0.0) {
        // a tension-only spring is an elastic string: slack is its normal
        // state, so only the stretch bound applies to it
        target = row[o + 5];
        worsening = -1.0; // approaching
      } else continue;
      const wa = pw[A];
      const wb = pw[B];
      const wSum = wa + wb;
      const nx = dx / dist;
      const ny = dy / dist;
      const corr = (dist - target) / wSum;
      px[A] += wa * corr * nx;
      py[A] += wa * corr * ny;
      px[B] -= wb * corr * nx;
      py[B] -= wb * corr * ny;
      const vn = (pvx[B] - pvx[A]) * nx + (pvy[B] - pvy[A]) * ny;
      if (vn * worsening <= 0.0) continue; // already recovering: leave it
      const j = -vn / wSum;
      pvx[A] -= j * wa * nx;
      pvy[A] -= j * wa * ny;
      pvx[B] += j * wb * nx;
      pvy[B] += j * wb * ny;
    }
  }

  /** Write the pack back onto the bodies. */
  private scatter(): void {
    const nPack = this.nPack;
    const pBody = this.pBody;
    const px = this.px;
    const py = this.py;
    const pvx = this.pvx;
    const pvy = this.pvy;
    const pw = this.pw;
    for (let i = 0; i < nPack; i++) {
      if (pw[i] === 0.0) continue; // an anchor the solve could not move
      const b = pBody[i];
      b.pos.x = px[i];
      b.pos.y = py[i];
      b.vel.x = pvx[i];
      b.vel.y = pvy[i];
    }
  }
}

/** Cap every body's speed at `cap` m/s, direction preserved. */
export function clampSpeeds(bodies: Body[], cap: number): void {
  const cap2 = cap * cap;
  for (const b of bodies) {
    const v2 = b.vel.x * b.vel.x + b.vel.y * b.vel.y;
    if (v2 > cap2) {
      // a non-finite v2 fails this comparison, and sanitize() owns that case
      const s = cap / Math.sqrt(v2);
      b.vel.x *= s;
      b.vel.y *= s;
    }
    // spin is bounded against the same ceiling at the body's own radius, so
    // a small particle is not allowed an absurd surface speed either
    const wCap = b.radius > 1e-6 ? cap / b.radius : cap * 1e6;
    if (b.omega > wCap) b.omega = wCap;
    else if (b.omega < -wCap) b.omega = -wCap;
  }
}

/** Bleed a little energy out of spring-connected bodies each substep. */
export function bleedSprungBodies(bodies: Body[], h: number): void {
  const decay = 1.0 - PERF_SPRUNG_DAMPING * h;
  if (decay >= 1.0 || decay < 0.0) return;
  for (const b of bodies) {
    if (!b.sprung) continue;
    b.vel.x *= decay;
    b.vel.y *= decay;
    b.omega *= decay;
  }
}
