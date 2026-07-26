/** The physics world: bodies, walls, links, force generators and the stepper.
 *
 * Stepping pipeline (per substep of length h):
 *   1. Evaluate smooth forces (gravity, N-body, drag, springs, drivers,
 *      custom fields), then solve rod/rope tensions at the acceleration
 *      level (warm-started Gauss-Seidel). Integrate with the selected
 *      integrator:
 *        - Symplectic Euler: 1st order, symplectic. Very robust.
 *        - Velocity Verlet:  2nd order, symplectic. Default -- excellent
 *          long-term energy behaviour for orbits and oscillators.
 *        - RK4: 4th order, non-symplectic. Best short-term accuracy for
 *          smooth systems; may slowly drift on orbits.
 *   2. Remove the tiny residual link drift with an XPBD position solve and
 *      feed the corrections back into velocities.
 *   3. Detect all contacts, then resolve them together with iterated
 *      sequential impulses (restitution + Coulomb friction) and
 *      split-impulse positional projection.
 *   4. Apply global velocity damping, advance time.
 *
 * Solving the rod tension as a *force* before integrating (step 1) rather
 * than only projecting positions afterwards is what makes pendulums and
 * chains energy-conserving: pure projection would systematically discard
 * the radial velocity gained within each substep and drain energy.
 *
 * Performance mode changes one thing about that pipeline and one thing only:
 * springs leave step 1 and become position constraints solved between steps 2
 * and 3, because a spring is the one element here whose FORCE treatment
 * cannot be made unconditionally stable. Everything else it does is a cap on
 * an existing dial. See engine/perf.ts.
 */
import { CompiledExpr, ExprError, compileExpr } from "../core/expr";
import { intIn, numIn, numOr } from "../core/guards";
import { Vec2 } from "../core/vec";
import { Body, BodyDict, Wall, WallDict } from "./body";
import { Contact, ContactCache, ContactStatic, solveContacts } from "./contacts";
import { DistanceLink, Link, LinkDict, SpringLink, linkFromDict } from "./links";
import {
  PERF_ITERATIONS, PERF_MAX_SPEED, PERF_SPRING_PASSES,
  PERF_SPRUNG_CONTACT_GAIN, PERF_SUBSTEPS, PerfSolver, clampSpeeds,
} from "./perf";

export const INTEGRATORS = ["Velocity Verlet", "Symplectic Euler", "RK4"] as const;
export type Integrator = (typeof INTEGRATORS)[number];

// Gauss-Seidel passes for the acceleration-level rod tension solve. Warm
// starting makes a handful of passes enough even for long chains.
const ROD_FORCE_PASSES = 4;

// Adaptive close-encounter integration (mutual-gravity scenes only): a
// substep is marched through in slices sized so that no body's
// acceleration changes by more than a fraction ENCOUNTER_ANGLE of itself
// per slice, with at most ENCOUNTER_MAX_SLICES-fold refinement. Deep
// two-body encounters (which would otherwise blow up the energy) then get
// automatically and smoothly resolved down to microsecond slices, while
// calm stretches take a single slice at zero extra cost.
//
// The name is historical but still apt: for a body in a circular orbit the
// acceleration vector rotates with it, so a 2% relative change per slice is
// 0.02 rad of arc. What it is NOT is a function of how fast the body
// happens to be moving - see World.maxAccelChangeRate for why that
// distinction is the whole ballgame.
//
// The slice size is a function of the simulation state alone, never of
// measured frame times, so a scene integrates identically however busy the
// machine is (see App.pickResolution for the same rule at the step level).
// Performance is handled by advancing less simulated time, not by
// integrating differently.
export const ENCOUNTER_ANGLE = 0.02; // relative change of a per slice
const ENCOUNTER_MAX_SLICES = 256;    // floor: slice >= h / this

// Hard ceiling on the slicing WORK one step() may spend, in units of
// body-force-evaluations (one RK4 slice costs 4 x the per-evaluation body
// count). Slicing is the only part of the pipeline whose cost is decided
// by the state rather than by the scene's size, so without a ceiling a
// single unlucky body can make one step cost hundreds of times a normal
// one - which is exactly the failure this budget exists to bound. It is a
// function of the scene alone (never of measured time), so the simulation
// stays reproducible: a step that runs out of budget integrates its
// remaining slices at the substep's own resolution, which is the same
// answer the non-adaptive path would have given.
const SLICE_WORK_BUDGET = 24_000;

/** How far a body may deviate from its straight chord within a step before
 * the path is worth resolving more finely: a small fraction of the body's
 * own size, with a floor for point-like bodies. */
function deviationTol(b: Body): number {
  const tol = b.radius * 0.04;
  return tol < 0.002 ? 0.002 : tol;
}

/** Centre the runaway test on the scene's fixed furniture (walls,
 * anchors, locked bodies), falling back to the origin. Never the camera:
 * panning away to inspect something must not condemn everything else. */
export function sceneAnchorPoint(world: World): { x: number; y: number } {
  let x = 0.0;
  let y = 0.0;
  let n = 0;
  for (const w of world.walls) {
    x += (w.a.x + w.b.x) * 0.5;
    y += (w.a.y + w.b.y) * 0.5;
    n++;
  }
  for (const b of world.bodies) {
    if (b.locked || b.isAnchor) {
      x += b.pos.x;
      y += b.pos.y;
      n++;
    }
  }
  return n > 0 ? { x: x / n, y: y / n } : { x: 0.0, y: 0.0 };
}

/** Bodies that have escaped for good and can be deleted.
 *
 * A body qualifies only if it is beyond `limit` from the scene anchor AND
 * still moving further away (or its state has gone non-finite). The
 * outward test is what protects a body at the far end of a wide bound
 * orbit: it is far away, but it is on its way back, so it survives.
 * Anchors, locked bodies and anything the user is holding are never
 * touched.
 */
export function escapedBodies(world: World, limit: number): Body[] {
  const c = sceneAnchorPoint(world);
  const limit2 = limit * limit;
  const out: Body[] = [];
  for (const b of world.bodies) {
    if (b.locked || b.isAnchor || b.held) continue;
    const dx = b.pos.x - c.x;
    const dy = b.pos.y - c.y;
    const d2 = dx * dx + dy * dy;
    if (!Number.isFinite(d2)) {
      out.push(b); // diverged: it is never coming back
      continue;
    }
    if (d2 <= limit2) continue;
    if (dx * b.vel.x + dy * b.vel.y > 0.0) out.push(b); // heading further out
  }
  return out;
}

export interface FieldDict {
  name: string;
  fx: string;
  fy: string;
  enabled: boolean;
}

/** User-defined force field F(x, y, vx, vy, t, m, r) applied to all bodies. */
export class ForceField {
  name: string;
  fxSrc: string;
  fySrc: string;
  enabled = true;
  error = "";
  fx: CompiledExpr | null = null;
  fy: CompiledExpr | null = null;

  constructor(name = "Field", fxSrc = "0", fySrc = "0") {
    this.name = name;
    this.fxSrc = fxSrc;
    this.fySrc = fySrc;
    this.compile();
  }

  compile(): boolean {
    try {
      this.fx = compileExpr(this.fxSrc);
      this.fy = compileExpr(this.fySrc);
      this.error = "";
      return true;
    } catch (exc) {
      if (!(exc instanceof ExprError)) throw exc;
      this.error = exc.message;
      this.fx = this.fy = null;
      return false;
    }
  }

  toDict(): FieldDict {
    return { name: this.name, fx: this.fxSrc, fy: this.fySrc, enabled: this.enabled };
  }

  static fromDict(d: FieldDict): ForceField {
    // The sources must be strings before they reach the compiler: it
    // trims them, so a number or a null where a formula was expected threw
    // a TypeError rather than an ExprError, which compile() deliberately
    // re-throws - taking the whole scene load down with it.
    const str = (v: unknown, fallback: string): string =>
      typeof v === "string" ? v : fallback;
    const f = new ForceField(str(d.name, "Field"), str(d.fx, "0"), str(d.fy, "0"));
    f.enabled = d.enabled ?? true;
    return f;
  }
}

export interface DriverDict {
  body_id: number;
  amplitude: number;
  frequency: number;
  phase: number;
  angle: number;
  enabled: boolean;
}

/** Sinusoidal driving force on one body: F(t) = A sin(2*pi*f*t + phase). */
export class Driver {
  bodyId: number;
  amplitude: number; // N
  frequency: number; // Hz
  phase: number;     // rad
  angle: number;     // direction of the force, rad from +x
  enabled = true;

  constructor(bodyId: number, amplitude = 5.0, frequency = 1.0,
              phase = 0.0, angle = 0.0) {
    this.bodyId = bodyId;
    this.amplitude = amplitude;
    this.frequency = frequency;
    this.phase = phase;
    this.angle = angle;
  }

  toDict(): DriverDict {
    return {
      body_id: this.bodyId, amplitude: this.amplitude,
      frequency: this.frequency, phase: this.phase,
      angle: this.angle, enabled: this.enabled,
    };
  }

  static fromDict(d: DriverDict): Driver {
    const drv = new Driver(numOr(d.body_id, -1),
                           numIn(d.amplitude, 5.0, -1e9, 1e9),
                           numIn(d.frequency, 1.0, 0.0, 1e6),
                           numIn(d.phase, 0.0, -1e6, 1e6),
                           numIn(d.angle, 0.0, -1e6, 1e6));
    drv.enabled = d.enabled ?? true;
    return drv;
  }
}

export interface WorldDict {
  settings: {
    gravity: number;
    mutual_gravity: boolean;
    point_gravity?: boolean;
    G: number;
    softening: number;
    drag_linear: number;
    drag_quadratic: number;
    global_damping: number;
    integrator: string;
    substeps: number;
    iterations: number;
    time: number;
  };
  bodies: BodyDict[];
  walls: WallDict[];
  links: LinkDict[];
  fields: FieldDict[];
  drivers: DriverDict[];
}

export class World {
  bodies: Body[] = [];
  walls: Wall[] = [];
  links: Link[] = [];
  fields: ForceField[] = [];
  drivers: Driver[] = [];

  gravity = 9.81;          // m/s^2, downward (negative = upward)
  mutualGravity = false;   // pairwise Newtonian attraction
  // true: each body's whole mass acts from its centre even when bodies
  // overlap (a point-mass singularity - overlapping pairs can slingshot).
  // false (default): bodies attract like solid uniform discs, so inside an
  // overlap the pull ramps linearly to zero at the centre, as in reality.
  pointGravity = false;
  G = 1.0;                 // gravitational constant (scaled units)
  softening = 0.01;        // m, avoids the r->0 singularity
  dragLinear = 0.0;        // N*s/m         (F = -c1 v)
  dragQuadratic = 0.0;     // N*s^2/m^2     (F = -c2 |v| v)
  globalDamping = 0.0;     // 1/s, exponential velocity decay

  integrator: Integrator = "Velocity Verlet";
  substeps = 4;
  iterations = 8;          // solver iterations (links and contacts)
  // How much velocity swing one adaptive slice may carry (not serialized).
  // A field rather than a bare constant so tests can tighten or loosen the
  // slicing; nothing in the app varies it at runtime, deliberately.
  encounterAngle = ENCOUNTER_ANGLE;

  // transient: set when a preset asked for more substeps than its size
  // could afford, so the inspector can say so rather than just showing a
  // smaller number than the scene was authored with. Never serialized -
  // saving a scene saves the settings it is actually running.
  substepsCappedFrom: number | null = null;

  // transient: run the robust solver (see perf.ts). A preference of the
  // browser, not of the scene, so it is NEVER serialized: the scene keeps the
  // substeps, iterations and integrator it was authored with, and this
  // overrides them only while stepping. The inspector shows the authored
  // numbers with a note saying what is actually running - writing the cheap
  // values into the world would save them into the user's scene file.
  performance = false;

  /** Substeps this step will actually take. */
  get effectiveSubsteps(): number {
    const n = Math.max(1, this.substeps);
    return this.performance ? Math.min(n, PERF_SUBSTEPS) : n;
  }

  /** Solver iterations this step will actually use. */
  get effectiveIterations(): number {
    return this.performance ? Math.min(this.iterations, PERF_ITERATIONS)
                            : this.iterations;
  }

  /** Integrator this step will actually use. Performance mode drops to
   * Symplectic Euler, which evaluates the forces once per step instead of
   * twice (Verlet) or four times (RK4). */
  get effectiveIntegrator(): Integrator {
    return this.performance ? "Symplectic Euler" : this.integrator;
  }

  time = 0.0;
  contacts: Contact[] = [];
  stepCount = 0;
  diverged: string[] = []; // names of bodies frozen this step
  // sub-step path samples for motion trails: when the adaptive integrator
  // slices through a close encounter, the U-turn happens *inside* one step,
  // so the UI sets traceSpacing (world units) and drains `trace` after each
  // step to keep trails smooth through it
  trace: Array<[number, number, number]> = [];
  traceSpacing = 0.0; // 0 = tracing off
  private traceLast = new Map<number, [number, number]>();
  // Base timestep the spring/damper stability clamps are measured
  // against (see prepareSprings). Must match the app's PHYSICS_DT: it is
  // what makes a clamped spring behave identically however finely the
  // scheduler subdivides a frame.
  clampDt = 1.0 / 120.0;
  private contactCache: ContactCache = new Map(); // warm-start impulses between substeps
  private rods: DistanceLink[] = [];  // per-step caches, see prepareStep()
  private springs: SpringLink[] = [];
  private perf = new PerfSolver();    // performance mode's spring projection
  private movers: Body[] = [];
  private moverInvMass = new Float64Array(0);
  // Enabled drivers, resolved against their (movable) body and flattened
  // once per step: the id->body lookup, the inverse mass and the direction's
  // sine and cosine are all fixed for the step, and a force evaluation
  // happens up to four times per slice.
  private driven: Array<{
    body: Body; amplitude: number; frequency: number; phase: number;
    ax: number; ay: number; // unit direction already divided by mass
  }> = [];
  private contactStatic: ContactStatic = {};
  // slices the current step may still spend (see SLICE_WORK_BUDGET)
  private sliceBudget = 0;
  // interval separating each body's `acc` from its `accPrev` sample
  private accSampleDt = 0.0;

  // ------------------------------------------------------------------ forces
  /** Rebuild the per-step caches. Body/link lists cannot change during a
   * step, so quantities that only the UI edits (mass, stiffness, ...) are
   * gathered once here instead of every force evaluation. */
  private prepareStep(h: number): void {
    const springs: SpringLink[] = [];
    const rods: DistanceLink[] = [];
    const noCollide = new Set<string>();
    for (const ln of this.links) {
      if (ln instanceof DistanceLink) rods.push(ln);
      else springs.push(ln);
      // Linked bodies DO collide with each other: a ball on a string
      // still bounces off the ball it is tied to. The only exception is
      // a link whose natural length is shorter than the bodies' combined
      // radii - there the link holds them permanently overlapped, so the
      // contact could never be satisfied and the two solvers would fight
      // each other forever (constant jitter).
      const gap = ln instanceof DistanceLink ? ln.length : ln.restLength;
      if (gap < ln.a.radius + ln.b.radius) {
        const a = ln.a.id;
        const b = ln.b.id;
        noCollide.add(a < b ? `${a},${b}` : `${b},${a}`);
      }
    }
    this.rods = rods;
    this.springs = springs;
    this.prepareSprings(h, springs);
    // Flag the spring endpoints for subdivisionNeed. Doing it here rather
    // than in the force loop keeps it out of the per-evaluation path: the
    // link list cannot change within a step.
    for (const b of this.bodies) {
      b.sprung = false;
      b.contactMassGain = 1.0;
    }
    const gain = this.performance ? PERF_SPRUNG_CONTACT_GAIN : 1.0;
    for (const s of springs) {
      s.a.sprung = true;
      s.b.sprung = true;
      s.a.contactMassGain = gain;
      s.b.contactMassGain = gain;
    }
    // `invMass` is a getter with three branches and a division, and the
    // force loops want it once per body per EVALUATION - four times a
    // slice under RK4. It cannot change within a step (mass, locked and
    // held are all edited between frames), so it is read once here and
    // the loops index this array alongside `movers`.
    const movers = this.bodies.filter((b) => b.invMass !== 0.0);
    this.movers = movers;
    if (this.moverInvMass.length < movers.length) {
      this.moverInvMass = new Float64Array(Math.max(16, movers.length * 2));
    }
    for (let i = 0; i < movers.length; i++) {
      this.moverInvMass[i] = movers[i].invMass;
    }
    // The trace anchors are keyed by body id and ids are never reused, so
    // without pruning the map keeps an entry for every body that has ever
    // been culled, erased or duplicated - a slow leak in a debris-heavy
    // scene, and a growing cost on every sliced substep. Only worth a pass
    // once it has clearly outgrown the live set.
    if (this.traceLast.size > this.movers.length * 2 + 16) {
      const live = new Set<number>();
      for (const b of this.movers) live.add(b.id);
      for (const id of this.traceLast.keys()) {
        if (!live.has(id)) this.traceLast.delete(id);
      }
    }
    this.driven.length = 0;
    if (this.drivers.length > 0) {
      const byId = new Map<number, Body>();
      for (const b of this.bodies) byId.set(b.id, b);
      for (const drv of this.drivers) {
        if (!drv.enabled) continue;
        const b = byId.get(drv.bodyId);
        if (b === undefined) continue;
        const invM = b.invMass;
        if (invM === 0.0) continue;
        // the direction is fixed for the step, so its sine and cosine are
        // taken once here rather than on every force evaluation
        this.driven.push({
          body: b, amplitude: drv.amplitude, frequency: drv.frequency,
          phase: drv.phase,
          ax: Math.cos(drv.angle) * invM, ay: Math.sin(drv.angle) * invM,
        });
      }
    }
    this.contactStatic = { noCollide };
  }

  /** Set each spring's effective stiffness and damping for this step.
   *
   * Performance mode does not integrate springs at all - they are position
   * constraints there (see perf.ts) - so there is no explicit stability
   * limit to clamp against and nothing to clamp. Passing k and c through
   * untouched is what keeps the stiffness slider meaningful right to its top
   * instead of saturating at whatever the timestep could carry, and it keeps
   * potentialEnergy() reporting the spring the user asked for.
   *
   * Otherwise the spring IS a force, and an explicit spring is only stable
   * while h*omega stays small (omega^2 = k*(1/ma + 1/mb)), and likewise
   * h*c*(1/ma + 1/mb) for damping. Clamp the effective k and c to those
   * limits so extreme user settings behave like "as stiff as this timestep
   * can carry" instead of blowing up.
   *
   * Note this is a PER-SPRING limit, and it is not sufficient for a node
   * that several springs meet at: their stiffnesses add, so a soft-body
   * particle on twelve of them sits well past the margin each one was
   * clamped to individually. That is the failure performance mode used to
   * inherit, and why it now takes the branch above rather than a tighter
   * version of this one.
   *
   * Clamp against a FIXED reference substep, not the one this step happens
   * to be using. The app subdivides its timestep adaptively, and how far it
   * subdivides depends on measured frame times - i.e. on how busy the
   * machine is. Clamping against the live h therefore made a clamped
   * spring's *effective* stiffness and damping vary with performance: the
   * same scene, reset and replayed, could ring on one run and sit dead still
   * on the next. Anchoring the limits to the base timestep makes them a
   * property of the scene alone.
   *
   * Taking the larger of the two keeps this conservative: the app only ever
   * steps finer than the reference (so the reference governs), while a
   * caller stepping coarser clamps harder still, as stability at that step
   * size demands.
   */
  private prepareSprings(h: number, springs: SpringLink[]): void {
    if (this.performance) {
      for (const s of springs) {
        s.kEff = s.stiffness;
        s.cEff = s.damping > 0.0 ? s.damping : 0.0;
      }
      return;
    }
    const refH = Math.max(h, this.clampDt / Math.max(1, this.substeps));
    const refH2 = refH * refH;
    for (const s of springs) {
      const wSum = s.a.invMass + s.b.invMass;
      let k = s.stiffness;
      let c = s.damping > 0.0 ? s.damping : 0.0;
      if (wSum > 0.0) {
        const kLim = 1.0 / (refH2 * wSum); // keeps h*omega <= 1
        if (k > kLim) k = kLim;
        const cLim = 0.5 / (refH * wSum);  // no single-step overshoot
        if (c > cLim) c = cLim;
      }
      s.kEff = k;
      s.cEff = c;
    }
  }

  /** Fill body.acc with the total smooth acceleration at the current state. */
  private accumulateForces(t: number): void {
    const g = this.gravity;
    const c1 = this.dragLinear;
    const c2 = this.dragQuadratic;
    const movers = this.movers;
    const invMass = this.moverInvMass;
    // Immovable bodies contribute nothing and are simply cleared; the
    // movers below assign outright, so zeroing them here is redundant but
    // costs two stores against a getter call it avoids.
    for (const b of this.bodies) {
      b.acc.x = 0.0;
      b.acc.y = 0.0;
    }
    const drag = c1 !== 0.0 || c2 !== 0.0;
    for (let i = 0; i < movers.length; i++) {
      const b = movers[i];
      const invM = invMass[i];
      let ax = b.constForce.x * invM;
      let ay = b.constForce.y * invM - g;
      if (drag) {
        const vx = b.vel.x;
        const vy = b.vel.y;
        const speed = Math.sqrt(vx * vx + vy * vy);
        const d = (c1 + c2 * speed) * invM;
        ax -= d * vx;
        ay -= d * vy;
      }
      b.acc.x = ax;
      b.acc.y = ay;
    }

    if (this.mutualGravity && this.G !== 0.0) this.accumulateGravity();

    // Performance mode's springs are position constraints solved after the
    // integrator, not forces fed into it - which is the whole reason it can
    // no longer be exploded by a stiffness setting. See perf.ts.
    if (!this.performance) {
      for (const s of this.springs) s.applyForces();
    }
    this.applyDriversAndFields(t);
  }

  // Flat scratch for the O(n^2) attraction pass, grown geometrically and
  // reused. See accumulateGravity for why the bodies are packed at all.
  private nbCap = 0;
  private nbX = new Float64Array(0);
  private nbY = new Float64Array(0);
  private nbMass = new Float64Array(0);
  private nbRadius = new Float64Array(0);
  private nbAx = new Float64Array(0);
  private nbAy = new Float64Array(0);
  private nbMovable = new Uint8Array(0);
  private nbBody: Body[] = [];

  /** Pairwise Newtonian attraction between every non-anchor body.
   *
   * This is the hottest loop in the engine - it is the only O(n^2) term,
   * and every integrator runs it once to four times per slice. It reads
   * from flat typed arrays rather than straight off the bodies because
   * the object form was costing 88 ns per pair at 400 bodies, roughly
   * twenty times the arithmetic in it. Two things were responsible:
   *
   *   - `invMass` is a GETTER (three branches and a division), and it was
   *     being evaluated once per PAIR for the inner body;
   *   - every coordinate came through two hops, Body -> Vec2 -> number,
   *     scattering the reads across as many small objects as there are
   *     bodies times five.
   *
   * Packing is O(n) and disappears next to the O(n^2) it feeds. The
   * accumulators are SEEDED with each body's existing acceleration rather
   * than with zero, so every addition happens in the same order and on the
   * same running total as the straightforward object loop: the result is
   * bit-for-bit identical, not merely equivalent (see the reference
   * comparison in gravity.test.ts).
   */
  private accumulateGravity(): void {
    const bodies = this.bodies;
    const total = bodies.length;
    if (total < 2) return;
    if (this.nbCap < total) {
      let cap = this.nbCap > 0 ? this.nbCap : 16;
      while (cap < total) cap *= 2;
      this.nbCap = cap;
      this.nbX = new Float64Array(cap);
      this.nbY = new Float64Array(cap);
      this.nbMass = new Float64Array(cap);
      this.nbRadius = new Float64Array(cap);
      this.nbAx = new Float64Array(cap);
      this.nbAy = new Float64Array(cap);
      this.nbMovable = new Uint8Array(cap);
      this.nbBody = new Array<Body>(cap);
    }
    const px = this.nbX;
    const py = this.nbY;
    const mass = this.nbMass;
    const radius = this.nbRadius;
    const ax = this.nbAx;
    const ay = this.nbAy;
    const movable = this.nbMovable;
    const ref = this.nbBody;

    let n = 0;
    for (let k = 0; k < total; k++) {
      const b = bodies[k];
      if (b.isAnchor) continue; // anchors neither pull nor are pulled
      px[n] = b.pos.x;
      py[n] = b.pos.y;
      mass[n] = b.mass;
      radius[n] = b.radius;
      movable[n] = b.invMass !== 0.0 ? 1 : 0;
      ax[n] = b.acc.x; // seeded, not zeroed: see the note above
      ay[n] = b.acc.y;
      ref[n] = b;
      n++;
    }
    if (n < 2) return;

    const G = this.G;
    const eps2 = this.softening * this.softening;
    if (this.pointGravity) {
      // point masses: the whole mass acts from the centre, singular as r->0
      for (let i = 0; i < n; i++) {
        const bix = px[i];
        const biy = py[i];
        const biMass = mass[i];
        const biMovable = movable[i];
        for (let j = i + 1; j < n; j++) {
          const dx = px[j] - bix;
          const dy = py[j] - biy;
          const d2 = dx * dx + dy * dy + eps2;
          const s = G / (d2 * Math.sqrt(d2)); // G / d^3
          if (biMovable !== 0) {
            const m = s * mass[j];
            ax[i] += m * dx;
            ay[i] += m * dy;
          }
          if (movable[j] !== 0) {
            const m = s * biMass;
            ax[j] -= m * dx;
            ay[j] -= m * dy;
          }
        }
      }
    } else {
      // solid uniform bodies: once the discs overlap the pull ramps
      // linearly to zero at the centre (interior field of a uniform body)
      // instead of diverging like a point-mass singularity
      for (let i = 0; i < n; i++) {
        const bix = px[i];
        const biy = py[i];
        const biMass = mass[i];
        const biR = radius[i];
        const biMovable = movable[i];
        for (let j = i + 1; j < n; j++) {
          const dx = px[j] - bix;
          const dy = py[j] - biy;
          let r2 = dx * dx + dy * dy;
          const R = biR + radius[j];
          const R2 = R * R;
          if (r2 < R2) r2 = R2;
          const d2 = r2 + eps2;
          const s = G / (d2 * Math.sqrt(d2)); // G / d^3
          if (biMovable !== 0) {
            const m = s * mass[j];
            ax[i] += m * dx;
            ay[i] += m * dy;
          }
          if (movable[j] !== 0) {
            const m = s * biMass;
            ax[j] -= m * dx;
            ay[j] -= m * dy;
          }
        }
      }
    }

    for (let k = 0; k < n; k++) {
      const acc = ref[k].acc;
      acc.x = ax[k];
      acc.y = ay[k];
    }
  }

  /** Sinusoidal drivers, user force fields and the rod tension solve - the
   * tail of accumulateForces, split out only to keep that function short
   * enough to read alongside the packed attraction pass above. */
  private applyDriversAndFields(t: number): void {
    if (this.driven.length > 0) {
      const TAU = 2 * Math.PI;
      for (const d of this.driven) {
        // amplitude/direction/inverse mass are all resolved in prepareStep:
        // only the phase actually varies with t, and the two trig calls for
        // the direction used to be redone on every force evaluation
        const f = d.amplitude * Math.sin(TAU * d.frequency * t + d.phase);
        const b = d.body;
        b.acc.x += f * d.ax;
        b.acc.y += f * d.ay;
      }
    }

    if (this.fields.length > 0) this.applyFields(t);
    this.solveRodForces();
  }

  // One environment record, refilled per body rather than rebuilt. It is
  // handed to the compiled expression tree, which only ever reads it.
  private fieldEnv = { x: 0, y: 0, vx: 0, vy: 0, t: 0, m: 0, r: 0 };

  /** User force fields: F(x, y, vx, vy, t, m, r) newtons on every body.
   *
   * The most expensive per-body work in the engine when a scene has one
   * (three quarters of the Cyclone preset's step), so the loop around the
   * compiled expressions is kept as bare as it can be: movers only, the
   * inverse mass read from the per-step table rather than through the
   * getter three times, and a single environment record refilled in place
   * instead of an object literal allocated per body per field per
   * evaluation. */
  private applyFields(t: number): void {
    const movers = this.movers;
    const invMass = this.moverInvMass;
    const env = this.fieldEnv;
    env.t = t;
    for (const field of this.fields) {
      if (!field.enabled || field.fx === null || field.fy === null) continue;
      const fx = field.fx;
      const fy = field.fy;
      for (let i = 0; i < movers.length; i++) {
        const b = movers[i];
        const px = b.pos.x;
        const py = b.pos.y;
        env.x = px;
        env.y = py;
        env.vx = b.vel.x;
        env.vy = b.vel.y;
        env.m = b.mass;
        env.r = Math.sqrt(px * px + py * py);
        const invM = invMass[i];
        try {
          const ax = fx(env) * invM;
          const ay = fy(env) * invM;
          // singular samples (e.g. 1/r at the origin) are skipped, matching
          // the desktop engine's per-body and vectorized treatments
          if (Number.isFinite(ax) && Number.isFinite(ay)) {
            b.acc.x += ax;
            b.acc.y += ay;
          }
        } catch {
          // singular point (e.g. overflow): skip this sample
        }
      }
    }
  }

  /** Add the analytic rod/rope constraint forces to the accelerations.
   *
   * Solves d^2C/dt^2 = n.(a_b - a_a) + |v_t|^2/d = 0 for every rod's
   * tension with warm-started Gauss-Seidel. The warm start (last solve's
   * tension as the initial guess) makes a few passes sufficient even for
   * long chains; the XPBD position pass mops up the O(h^2) residual.
   */
  // Rod solve rows, in parallel flat arrays reused between calls. A force
  // evaluation happens up to four times per slice and this used to build a
  // fresh array of row objects on each one, which in a chain scene is tens
  // of thousands of short-lived objects a second for a solve whose actual
  // arithmetic is a handful of multiplies per rod.
  private rodLink: DistanceLink[] = [];
  private rodA: Body[] = [];
  private rodB: Body[] = [];
  private rodNum = new Float64Array(0); // wa, wb, wSum, nx, ny, d, mu
  private static ROD_W = 7;

  private solveRodForces(): void {
    const links = this.rods;
    if (links.length === 0) return;
    const W = World.ROD_W;
    if (this.rodNum.length < links.length * W) {
      this.rodNum = new Float64Array(Math.max(16, links.length * 2) * W);
    }
    const num = this.rodNum;
    const rodLink = this.rodLink;
    const rodA = this.rodA;
    const rodB = this.rodB;
    let n = 0;
    for (const ln of links) {
      const a = ln.a;
      const b = ln.b;
      const wa = a.invMass;
      const wb = b.invMass;
      const wSum = wa + wb;
      if (wSum === 0.0) continue;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1e-18) continue;
      const d = Math.sqrt(d2);
      if (ln.isRope && d < ln.length - 1e-9) {
        ln.mu = 0.0; // slack: no tension, drop the warm start
        continue;
      }
      const nx = dx / d;
      const ny = dy / d;
      let mu = ln.mu;
      if (ln.isRope && mu < 0.0) mu = 0.0;
      if (mu !== 0.0) { // apply the warm-start guess immediately
        a.acc.x += mu * wa * nx;
        a.acc.y += mu * wa * ny;
        b.acc.x -= mu * wb * nx;
        b.acc.y -= mu * wb * ny;
      }
      rodLink[n] = ln;
      rodA[n] = a;
      rodB[n] = b;
      const o = n * W;
      num[o] = wa;
      num[o + 1] = wb;
      num[o + 2] = wSum;
      num[o + 3] = nx;
      num[o + 4] = ny;
      num[o + 5] = d;
      num[o + 6] = mu;
      n++;
    }
    if (n === 0) return;
    for (let pass = 0; pass < ROD_FORCE_PASSES; pass++) {
      let worst = 0.0;
      for (let i = 0; i < n; i++) {
        const o = i * W;
        const a = rodA[i];
        const b = rodB[i];
        const wa = num[o];
        const wb = num[o + 1];
        const nx = num[o + 3];
        const ny = num[o + 4];
        const rvx = b.vel.x - a.vel.x;
        const rvy = b.vel.y - a.vel.y;
        const vn = rvx * nx + rvy * ny;
        const vt2 = rvx * rvx + rvy * rvy - vn * vn;
        const an = (b.acc.x - a.acc.x) * nx + (b.acc.y - a.acc.y) * ny;
        const mu = num[o + 6];
        let newMu = mu + (an + vt2 / num[o + 5]) / num[o + 2];
        if (rodLink[i].isRope && newMu < 0.0) newMu = 0.0;
        const dmu = newMu - mu;
        num[o + 6] = newMu;
        if (dmu !== 0.0) {
          a.acc.x += dmu * wa * nx;
          a.acc.y += dmu * wa * ny;
          b.acc.x -= dmu * wb * nx;
          b.acc.y -= dmu * wb * ny;
          const dAbs = dmu > 0.0 ? dmu : -dmu;
          if (dAbs > worst) worst = dAbs;
        }
      }
      if (worst < 1e-9) break;
    }
    for (let i = 0; i < n; i++) rodLink[i].mu = num[i * W + 6];
    // deliberately NOT truncated: emptying and regrowing these every call
    // makes V8 reallocate the backing store each time, which cost more
    // than the row objects they replaced. `n` alone bounds what is live.
  }

  // -------------------------------------------------------------- integrators
  /** How fast (1/s) the acceleration acting on the worst-affected body is
   * CHANGING along its trajectory: max |da/dt| / |a|, estimated by
   * differencing each body's acceleration against the one recorded a
   * slice ago.
   *
   * This is the quantity the slicer actually needs. Every integrator here
   * is exact for constant acceleration and accurate to its own order while
   * the acceleration varies slowly; what breaks a close encounter is that
   * the force changes by a large factor within one step, which no fixed
   * step size can follow. Differencing measures precisely that, and it
   * subsumes the "velocity swing" the criterion was named for: in a
   * circular orbit the acceleration vector rotates at the orbital rate, so
   * ENCOUNTER_ANGLE keeps its original meaning of radians per slice.
   *
   * The previous form, |a| / (|v| + 0.05), measured neither. It grew
   * without bound as a body merely slowed down, so a single particle
   * resting on a heavy star - a completely static configuration, with an
   * acceleration that barely changes at all - pinned the slicer at its
   * refinement floor for as long as the particle existed and multiplied
   * the cost of the entire scene by two orders of magnitude. Its
   * replacement reports ~0 there and still resolves a genuine near-
   * singular flyby down to microsecond slices.
   *
   * `dt` is the interval the two samples are separated by. Bodies in
   * persistent contact are skipped: the contact impulses discard their
   * acceleration each substep, so its history says nothing about their
   * path. Bodies whose acceleration is negligible next to the scene's
   * largest are skipped too, so that a distant coasting body's rounding
   * noise cannot divide its way to a huge relative rate.
   */
  private maxAccelChangeRate(dt: number): number {
    const movers = this.movers;
    let aMax = 0.0;
    for (const b of movers) {
      const a2 = b.acc.x * b.acc.x + b.acc.y * b.acc.y;
      if (a2 > aMax) aMax = a2;
    }
    if (aMax === 0.0 || dt <= 0.0) return 0.0;
    const floor2 = aMax * 1e-8; // (1e-4 of the largest acceleration)^2
    const invDt = 1.0 / dt;
    let worst = 0.0;
    for (const b of movers) {
      if (b.touching) continue;
      const ax = b.acc.x;
      const ay = b.acc.y;
      const a2 = ax * ax + ay * ay;
      if (a2 <= floor2) continue;
      // an exactly zero reference means no history yet (a body added this
      // step, or the very first step of a scene), not an infinitely fast
      // change: a real acceleration is never exactly zero for long, and
      // treating the seeding sample as a jump used to slice the first
      // substep of every scene for no reason
      if (b.accPrevX === 0.0 && b.accPrevY === 0.0) continue;
      const dx = ax - b.accPrevX;
      const dy = ay - b.accPrevY;
      const d2 = dx * dx + dy * dy;
      if (d2 === 0.0) continue;
      const rate = Math.sqrt(d2 / a2) * invDt;
      if (rate > worst) worst = rate;
    }
    return worst;
  }

  /** Record the current accelerations as the reference the next slice's
   * change rate is measured against. */
  private noteAccel(): void {
    for (const b of this.movers) {
      b.accPrevX = b.acc.x;
      b.accPrevY = b.acc.y;
    }
  }

  /** March through one substep in adaptively sized slices, starting at
   * simulated time `t0`.
   *
   * Each slice is capped at ENCOUNTER_ANGLE / (rate of change of the
   * acceleration), re-evaluated
   * from the freshest accelerations after every slice, so a close
   * encounter deepening mid-substep keeps getting finer resolution
   * (down to h/ENCOUNTER_MAX_SLICES). This is what keeps the energy of
   * near-collision N-body orbits from exploding, at no cost to calm
   * scenes.
   *
   * `this.sliceBudget` bounds the total refinement one step() may buy, so
   * the cost of a step stays within a constant factor of the scene's size
   * however the state evolves. Slices are charged against it across all of
   * the step's substeps; once it is spent the remainder integrates at the
   * substep's own resolution.
   */
  private integrateAdaptive(h: number, t0: number): void {
    let remaining = h;
    const floor = h / ENCOUNTER_MAX_SLICES;
    let guard = 2 * ENCOUNTER_MAX_SLICES; // hard bound on work
    const spacing = this.traceSpacing;
    let elapsed = 0.0;
    while (remaining > 1e-12 && guard > 0) {
      guard--;
      const w = this.sliceBudget > 0
        ? this.maxAccelChangeRate(this.accSampleDt) : 0.0;
      let hh = w <= 0.0 ? remaining : Math.min(remaining, this.encounterAngle / w);
      if (hh < floor) hh = floor;
      if (hh > remaining) hh = remaining;
      const sliced = hh < remaining;
      // the accelerations standing now become the reference the next
      // slice's change rate is differenced against
      this.noteAccel();
      this.accSampleDt = hh;
      if (sliced && spacing > 0.0) {
        // capture the path inside the slicing so trails show the
        // encounter's curve instead of a step-to-step corner
        for (const b of this.movers) {
          const last = this.traceLast.get(b.id);
          if (last === undefined ||
              Math.abs(last[0] - b.pos.x) + Math.abs(last[1] - b.pos.y) >= spacing) {
            if (last === undefined) this.traceLast.set(b.id, [b.pos.x, b.pos.y]);
            else { last[0] = b.pos.x; last[1] = b.pos.y; }
            this.trace.push([b.id, b.pos.x, b.pos.y]);
          }
        }
      }
      if (sliced) {
        // actually slicing: use RK4 for the slices. A symplectic integrator
        // loses its energy-conserving magic the moment the step size varies,
        // so mid-encounter it has no edge - while RK4's O(h^5) local error
        // makes the brief violent stretch essentially exact, and it is too
        // short for RK4's long-term drift to matter.
        this.sliceBudget--;
        this.integrateRk4(hh, t0 + elapsed);
      } else {
        this.integrate(hh, t0 + elapsed);
      }
      remaining -= hh;
      elapsed += hh;
    }
  }

  /** Advance every mover by `h`, evaluating time-dependent forces from
   * simulated time `t0`. `t0` is passed rather than read from `this.time`
   * because the slicer marches several of these through one substep, and
   * a driver or a force field containing `t` must see each slice's own
   * time rather than the substep's start for all of them. */
  private integrate(h: number, t0: number): void {
    const name = this.effectiveIntegrator;
    const movers = this.movers;
    if (name === "RK4") {
      this.integrateRk4(h, t0);
    } else if (name === "Symplectic Euler") {
      this.accumulateForces(t0);
      for (const b of movers) {
        b.angle += b.omega * h;
        b.vel.x += b.acc.x * h;
        b.vel.y += b.acc.y * h;
        b.pos.x += b.vel.x * h;
        b.pos.y += b.vel.y * h;
      }
    } else { // Velocity Verlet
      this.accumulateForces(t0);
      const half = 0.5 * h;
      for (const b of movers) {
        b.angle += b.omega * h;
        b.vel.x += b.acc.x * half;
        b.vel.y += b.acc.y * half;
        b.pos.x += b.vel.x * h;
        b.pos.y += b.vel.y * h;
      }
      this.accumulateForces(t0 + h);
      for (const b of movers) {
        b.vel.x += b.acc.x * half;
        b.vel.y += b.acc.y * half;
      }
    }
  }

  // RK4 scratch: [px, py, vx, vy] per mover for the base state and the four
  // stage derivatives. Reused across calls and grown geometrically, because
  // the slicer can invoke RK4 hundreds of times inside a single step and
  // allocating five typed arrays plus two closures per call made the garbage
  // collector, not the physics, the dominant cost of a close encounter.
  private rkScratch: Float64Array[] = [];
  private rkCapacity = 0;

  private rkEnsure(n: number): void {
    if (this.rkCapacity >= n) return;
    let cap = this.rkCapacity > 0 ? this.rkCapacity : 8;
    while (cap < n) cap *= 2;
    this.rkCapacity = cap;
    this.rkScratch = [0, 1, 2, 3, 4].map(() => new Float64Array(4 * cap));
  }

  /** One RK4 stage: evaluate the derivative of [px, py, vx, vy] at time
   * `t` into `out`. */
  private rkDeriv(t: number, out: Float64Array): void {
    this.accumulateForces(t);
    const movers = this.movers;
    for (let i = 0; i < movers.length; i++) {
      const b = movers[i];
      const o = 4 * i;
      out[o] = b.vel.x;
      out[o + 1] = b.vel.y;
      out[o + 2] = b.acc.x;
      out[o + 3] = b.acc.y;
    }
  }

  /** Write base + scale * deriv back into the bodies (an RK4 trial state). */
  private rkLoad(base: Float64Array, deriv: Float64Array, scale: number): void {
    const movers = this.movers;
    for (let i = 0; i < movers.length; i++) {
      const b = movers[i];
      const o = 4 * i;
      b.pos.x = base[o] + scale * deriv[o];
      b.pos.y = base[o + 1] + scale * deriv[o + 1];
      b.vel.x = base[o + 2] + scale * deriv[o + 2];
      b.vel.y = base[o + 3] + scale * deriv[o + 3];
    }
  }

  private integrateRk4(h: number, t0: number): void {
    const movers = this.movers;
    const n = movers.length;
    if (n === 0) return;
    for (const b of movers) b.angle += b.omega * h;
    this.rkEnsure(n);
    const [x0, k1, k2, k3, k4] = this.rkScratch;
    for (let i = 0; i < n; i++) {
      const b = movers[i];
      const o = 4 * i;
      x0[o] = b.pos.x;
      x0[o + 1] = b.pos.y;
      x0[o + 2] = b.vel.x;
      x0[o + 3] = b.vel.y;
    }

    this.rkDeriv(t0, k1);
    this.rkLoad(x0, k1, 0.5 * h);
    this.rkDeriv(t0 + 0.5 * h, k2);
    this.rkLoad(x0, k2, 0.5 * h);
    this.rkDeriv(t0 + 0.5 * h, k3);
    this.rkLoad(x0, k3, h);
    this.rkDeriv(t0 + h, k4);

    const sixth = h / 6.0;
    for (let i = 0; i < n; i++) {
      const b = movers[i];
      const o = 4 * i;
      b.pos.x = x0[o] + sixth * (k1[o] + 2 * k2[o] + 2 * k3[o] + k4[o]);
      b.pos.y = x0[o + 1] + sixth * (k1[o + 1] + 2 * k2[o + 1] + 2 * k3[o + 1] + k4[o + 1]);
      b.vel.x = x0[o + 2] + sixth * (k1[o + 2] + 2 * k2[o + 2] + 2 * k3[o + 2] + k4[o + 2]);
      b.vel.y = x0[o + 3] + sixth * (k1[o + 3] + 2 * k2[o + 3] + 2 * k3[o + 3] + k4[o + 3]);
    }
  }

  // ------------------------------------------------------------------- step
  /** Advance the world by dt seconds using the configured substeps. */
  step(dt: number): void {
    const n = this.effectiveSubsteps;
    const h = dt / n;
    const invH = 1.0 / h;
    this.prepareStep(h);
    this.contacts = [];
    this.diverged = [];
    for (const b of this.bodies) {
      b.prev.x = b.pos.x;
      b.prev.y = b.pos.y;
    }
    const rigid = this.rods;
    const iters = this.effectiveIterations;
    // Performance mode's springs: projected, damped and strain-limited after
    // the integrator instead of being integrated (see perf.ts).
    const projected = this.performance ? this.springs : null;
    // N-body scenes get adaptive slice-marching inside each substep so
    // close encounters can't blow up; everything else is untouched.
    // Performance mode gives it up: the slicer is the single largest
    // multiplier in the engine, and a scene being played with rather than
    // measured does not need a near-exact flyby.
    const adaptive = this.mutualGravity && this.G !== 0.0 && !this.performance;
    if (adaptive) {
      // One evaluation costs roughly (bodies + pairs); one slice is four of
      // them. Spending the budget in work rather than in slices lets a
      // three-body choreography refine deeply - it is nearly free - while a
      // crowded cloud, where the same refinement would cost a hundred times
      // as much, keeps its frame.
      const nb = this.bodies.length;
      const perEval = nb + (nb * (nb - 1)) / 2;
      // No floor: a scene too large to afford even one slice gets none,
      // and integrates at its substep resolution exactly as it would with
      // adaptive resolution switched off. A floor of a few slices sounds
      // harmless and is not - at 400 bodies each one costs four O(n^2)
      // evaluations, which quadrupled the cost of the step it was meant to
      // be a rounding error on.
      this.sliceBudget = Math.min(ENCOUNTER_MAX_SLICES * n,
        Math.floor(SLICE_WORK_BUDGET / (4 * Math.max(1, perEval))));
    }
    for (let s = 0; s < n; s++) {
      // (spin integration happens inside the integrator body loops;
      // torque only arises from contacts, applied there)
      if (adaptive) this.integrateAdaptive(h, this.time);
      else this.integrate(h, this.time);

      // Springs first, rods second: a rod is an exact constraint and must
      // have the final say where an assembly mixes the two.
      if (projected !== null && projected.length > 0) {
        this.perf.solve(projected, h, PERF_SPRING_PASSES);
      }
      if (rigid.length > 0) this.solveRodPositions(rigid, invH, iters);

      // `contacts` is a snapshot of the contacts that exist NOW, for the
      // overlay and the status-bar count - so each substep replaces the
      // last rather than appending. Accumulating meant a 4-substep step
      // reported (and drew) every contact four times over.
      this.contacts.length = 0;
      solveContacts(this.bodies, this.walls, this.contacts, iters,
                    this.contactCache, this.contactStatic);

      if (this.globalDamping > 0.0) {
        const decay = Math.max(0.0, 1.0 - this.globalDamping * h);
        for (const b of this.bodies) {
          b.vel.x *= decay;
          b.vel.y *= decay;
          b.omega *= decay;
        }
      }

      // interactive speed caps (drag tone-down): clamping at the end of
      // every substep bounds whatever the integrator, springs, rods and
      // contacts injected this substep, so a dragged assembly can chase
      // and jiggle but never run away
      for (const b of this.bodies) {
        const cap = b.speedCap;
        if (cap !== Infinity) {
          const v2 = b.vel.x * b.vel.x + b.vel.y * b.vel.y;
          if (v2 > cap * cap) {
            const s = cap / Math.sqrt(v2);
            b.vel.x *= s;
            b.vel.y *= s;
          }
        }
      }

      // Performance mode's last guard, applied where it bounds everything the
      // substep did rather than only the springs: a hard speed ceiling, so
      // nothing can walk out to the range sanitize() has to freeze.
      if (projected !== null) clampSpeeds(this.bodies, PERF_MAX_SPEED);

      this.time += h;
    }
    this.sanitize();
    this.stepCount++;
  }

  /** XPBD position solve for the residual link drift, with the
   * corrections fed back into velocities. */
  private solveRodPositions(rigid: DistanceLink[], invH: number,
                            iterations: number): void {
    interface Row {
      ln: DistanceLink;
      a: Body;
      b: Body;
      wa: number;
      wb: number;
      wSum: number;
      alpha: number;
    }
    const rows: Row[] = [];
    for (const ln of rigid) {
      const a = ln.a;
      const b = ln.b;
      const wa = a.invMass;
      const wb = b.invMass;
      if (wa + wb === 0.0) continue;
      ln.lambda = 0.0;
      rows.push({ ln, a, b, wa, wb, wSum: wa + wb,
                  alpha: ln.compliance * invH * invH });
    }
    if (rows.length === 0) return;
    const touched = new Map<number, Body>();
    for (const { a, b } of rows) {
      if (!touched.has(a.id)) {
        touched.set(a.id, a);
        a.corrX = 0.0;
        a.corrY = 0.0;
      }
      if (!touched.has(b.id)) {
        touched.set(b.id, b);
        b.corrX = 0.0;
        b.corrY = 0.0;
      }
    }
    for (let pass = 0; pass < iterations; pass++) {
      let worst = 0.0;
      for (const { ln, a, b, wa, wb, wSum, alpha } of rows) {
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1e-12) continue;
        const c = dist - ln.length;
        if (ln.isRope && c <= 0.0) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        const dlam = (-c - alpha * ln.lambda) / (wSum + alpha);
        ln.lambda += dlam;
        const d = dlam > 0.0 ? dlam : -dlam;
        if (d > worst) worst = d;
        const ax = -wa * dlam * nx;
        const ay = -wa * dlam * ny;
        const bx = wb * dlam * nx;
        const by = wb * dlam * ny;
        a.pos.x += ax;
        a.pos.y += ay;
        b.pos.x += bx;
        b.pos.y += by;
        a.corrX += ax;
        a.corrY += ay;
        b.corrX += bx;
        b.corrY += by;
      }
      if (worst < 1e-10) break; // converged: links are exact to sub-nanometre
    }
    for (const body of touched.values()) {
      if (body.corrX !== 0.0 || body.corrY !== 0.0) {
        body.vel.x += body.corrX * invH;
        body.vel.y += body.corrY * invH;
      }
    }
  }

  /** Freeze any body whose state became non-finite or absurdly large
   * (a numerical blow-up, e.g. from an extreme custom field) instead of
   * crashing. The size bounds also keep positions inside the range the
   * renderer can draw. */
  private sanitize(): void {
    for (const b of this.bodies) {
      // any inf/nan component makes the sum non-finite; huge-but-finite
      // values are just as fatal one step later, so they count too
      if (Number.isFinite(b.pos.x + b.pos.y + b.vel.x + b.vel.y + b.omega) &&
          b.pos.x > -1e6 && b.pos.x < 1e6 && b.pos.y > -1e6 && b.pos.y < 1e6 &&
          b.vel.x > -1e7 && b.vel.x < 1e7 && b.vel.y > -1e7 && b.vel.y < 1e7) {
        continue;
      }
      if (Number.isFinite(b.prev.x) && Number.isFinite(b.prev.y) &&
          b.prev.x > -1e6 && b.prev.x < 1e6 && b.prev.y > -1e6 && b.prev.y < 1e6) {
        b.pos.setVec(b.prev);
      } else {
        b.pos.set(0.0, 0.0);
      }
      b.vel.set(0.0, 0.0);
      b.omega = 0.0;
      b.acc.set(0.0, 0.0);
      this.diverged.push(b.name);
    }
  }

  // ------------------------------------------------------------- diagnostics
  /** How many equal slices `dt` should be cut into for smooth motion.
   *
   * Sagitta criterion (the N-body adaptive-timestep idea a la Aarseth):
   * a body under acceleration a deviates from its straight chord by
   * about a*dt^2/8 over one step. When that deviation grows past a
   * small fraction of the body's own size - exactly what happens in
   * fast close encounters - the step wants subdividing; the deviation
   * shrinks quadratically with dt, so calm scenes report 1.
   *
   * Uses the accelerations left by the previous force evaluation, so
   * it costs one O(n) pass and no extra physics.
   *
   * Bodies held by contacts or by springs are excluded. Both keep a large
   * acceleration that is immediately cancelled - by the contact impulse on
   * one side, by the opposing spring on the other - so neither is the
   * free-flying curvature this criterion is looking for. For springs there
   * is a second, stronger reason: prepareStep clamps every spring's
   * effective stiffness so that h*omega <= 1 at the scene's own substep, so
   * a spring is resolved stably by construction and subdividing further buys
   * nothing at all.
   *
   * Leaving springs in was expensive. The Trampoline's bed particles are
   * 5.5 cm across (a 2.2 mm tolerance) on springs clamped to k = 100 000
   * carrying a 64 kg gymnast, which drove this to the maxQ of 16 through
   * every bounce - a sixteenfold multiplier on the whole scene's physics for
   * accuracy that the spring clamp had already guaranteed. That is what made
   * the "physics can't keep up" warning fire on a scene whose actual solver
   * cost is 215 us a step.
   */
  subdivisionNeed(dt: number, maxQ = 16): number {
    let q = 1;
    const k = dt * dt * 0.125;
    for (const b of this.bodies) {
      if (b.invMass === 0.0 || b.touching || b.sprung) continue;
      const ax = b.acc.x;
      const ay = b.acc.y;
      const dev = Math.sqrt(ax * ax + ay * ay) * k;
      const tol = deviationTol(b);
      if (dev > tol * q * q) { // only beat the current best
        const need = Math.floor(Math.sqrt(dev / tol)) + 1;
        if (need >= maxQ) return maxQ;
        q = need;
      }
    }
    return q;
  }

  energy(): { ke: number; pe: number; total: number } {
    let ke = 0.0;
    let peG = 0.0;
    for (const b of this.bodies) {
      if (b.invMass === 0.0) continue;
      ke += b.kineticEnergy();
      peG += b.mass * this.gravity * b.pos.y;
    }
    let peS = 0.0;
    for (const ln of this.links) {
      if (ln instanceof SpringLink) peS += ln.potentialEnergy();
    }
    let peN = 0.0;
    if (this.mutualGravity && this.G !== 0.0) {
      // softened potential, consistent with the softened force
      const bodies = this.bodies;
      const eps2 = this.softening * this.softening;
      for (let i = 0; i < bodies.length; i++) {
        const bi = bodies[i];
        if (bi.isAnchor) continue; // consistent with the force: no anchor PE
        for (let j = i + 1; j < bodies.length; j++) {
          const bj = bodies[j];
          if (bj.isAnchor) continue;
          const dx = bj.pos.x - bi.pos.x;
          const dy = bj.pos.y - bi.pos.y;
          const r2 = dx * dx + dy * dy;
          const R = bi.radius + bj.radius;
          if (!this.pointGravity && r2 < R * R) {
            // potential of the linear interior force, continuous with the
            // exterior branch at r = R (keeps the energy graph honest
            // while overlapping bodies pass through each other)
            const D2 = R * R + eps2;
            const D = Math.sqrt(D2);
            peN -= this.G * bi.mass * bj.mass *
              (1.0 / D + (R * R - r2) / (2.0 * D2 * D));
          } else {
            peN -= this.G * bi.mass * bj.mass / Math.sqrt(r2 + eps2);
          }
        }
      }
    }
    return { ke, pe: peG + peS + peN, total: ke + peG + peS + peN };
  }

  momentum(): Vec2 {
    const p = new Vec2();
    for (const b of this.bodies) {
      if (b.invMass !== 0.0) {
        p.x += b.mass * b.vel.x;
        p.y += b.mass * b.vel.y;
      }
    }
    return p;
  }

  centreOfMass(): Vec2 | null {
    let mTotal = 0.0;
    let cx = 0.0;
    let cy = 0.0;
    for (const b of this.bodies) {
      if (b.invMass !== 0.0) {
        mTotal += b.mass;
        cx += b.mass * b.pos.x;
        cy += b.mass * b.pos.y;
      }
    }
    if (mTotal === 0.0) return null;
    return new Vec2(cx / mTotal, cy / mTotal);
  }

  /** Total angular momentum about the centre of mass (spin + orbital). */
  angularMomentum(): number {
    const com = this.centreOfMass();
    if (com === null) return 0.0;
    let total = 0.0;
    for (const b of this.bodies) {
      if (b.invMass === 0.0) continue;
      const rx = b.pos.x - com.x;
      const ry = b.pos.y - com.y;
      total += b.mass * (rx * b.vel.y - ry * b.vel.x);
      total += b.inertia * b.omega;
    }
    return total;
  }

  // ------------------------------------------------------------ bookkeeping
  bodyById(bid: number): Body | null {
    for (const b of this.bodies) {
      if (b.id === bid) return b;
    }
    return null;
  }

  removeBody(body: Body): void {
    this.removeBodies(new Set([body]));
  }

  /** Remove every body in `gone`, and with them the links they anchor and
   * the drivers that address them.
   *
   * One pass over each list, whatever the size of `gone`. Removing bodies
   * one at a time is O(k*n) in the splices alone and rebuilds the whole
   * link array per body, which the two callers that delete in bulk - the
   * runaway cull, which can bin hundreds inside a single frame while the
   * simulation runs, and the Inspector's bulk-delete buttons - both pay in
   * full. `indexOf` on top of that made it the dominant cost of a debris
   * storm rather than a rounding error on it.
   */
  removeBodies(gone: ReadonlySet<Body>): void {
    if (gone.size === 0) return;
    this.bodies = this.bodies.filter((b) => !gone.has(b));
    this.links = this.links.filter((ln) => !gone.has(ln.a) && !gone.has(ln.b));
    if (this.drivers.length > 0) {
      const ids = new Set<number>();
      for (const b of gone) ids.add(b.id);
      this.drivers = this.drivers.filter((d) => !ids.has(d.bodyId));
    }
  }

  removeWall(wall: Wall): void {
    const i = this.walls.indexOf(wall);
    if (i >= 0) this.walls.splice(i, 1);
  }

  removeWalls(gone: ReadonlySet<Wall>): void {
    if (gone.size === 0) return;
    this.walls = this.walls.filter((w) => !gone.has(w));
  }

  removeLink(link: Link): void {
    const i = this.links.indexOf(link);
    if (i >= 0) this.links.splice(i, 1);
  }

  removeLinks(gone: ReadonlySet<Link>): void {
    if (gone.size === 0) return;
    this.links = this.links.filter((ln) => !gone.has(ln));
  }

  // ----------------------------------------------------------- serialization
  toDict(): WorldDict {
    return {
      settings: {
        gravity: this.gravity, mutual_gravity: this.mutualGravity,
        point_gravity: this.pointGravity,
        G: this.G, softening: this.softening,
        drag_linear: this.dragLinear,
        drag_quadratic: this.dragQuadratic,
        global_damping: this.globalDamping,
        integrator: this.integrator, substeps: this.substeps,
        iterations: this.iterations, time: this.time,
      },
      bodies: this.bodies.map((b) => b.toDict()),
      walls: this.walls.map((w) => w.toDict()),
      links: this.links.map((ln) => ln.toDict()),
      fields: this.fields.map((f) => f.toDict()),
      drivers: this.drivers.map((d) => d.toDict()),
    };
  }

  static fromDict(data: Partial<WorldDict>): World {
    const w = new World();
    const s = data.settings ?? ({} as Partial<WorldDict["settings"]>);
    // Every setting is guarded, not just the two loop bounds. `?? default`
    // only catches a missing field: a NaN gravity or a `"G": "abc"` from a
    // hand-edited file passed straight into the force loop, where one
    // non-finite acceleration reaches every body within a step. The scene
    // then froze on load and blamed the user's own forces for it.
    w.gravity = numIn(s.gravity, 9.81, -1e6, 1e6);
    w.mutualGravity = s.mutual_gravity ?? false;
    w.pointGravity = s.point_gravity ?? false;
    w.G = numIn(s.G, 1.0, -1e12, 1e12);
    w.softening = numIn(s.softening, 0.01, 0.0, 1e6);
    w.dragLinear = numIn(s.drag_linear, 0.0, 0.0, 1e9);
    w.dragQuadratic = numIn(s.drag_quadratic, 0.0, 0.0, 1e9);
    w.globalDamping = numIn(s.global_damping, 0.0, 0.0, 1e9);
    const integ = s.integrator ?? "Velocity Verlet";
    w.integrator = (INTEGRATORS as readonly string[]).includes(integ)
      ? (integ as Integrator) : "Velocity Verlet";
    // clamped to the same 1-64 the inspector offers: an out-of-range value
    // from a hand-edited or corrupted file used to go straight into the
    // solver loop bounds, where a large one hangs the tab outright
    w.substeps = intIn(s.substeps, 4, 1, 64);
    w.iterations = intIn(s.iterations, 8, 1, 64);
    w.time = numOr(s.time, 0.0);
    w.bodies = (data.bodies ?? []).map((d) => Body.fromDict(d));
    w.walls = (data.walls ?? []).map((d) => Wall.fromDict(d));
    const byId = new Map<number, Body>();
    for (const b of w.bodies) byId.set(b.id, b);
    w.links = (data.links ?? [])
      .filter((d) => byId.has(d.a) && byId.has(d.b))
      .map((d) => linkFromDict(d, byId));
    w.fields = (data.fields ?? []).map((d) => ForceField.fromDict(d));
    w.drivers = (data.drivers ?? []).map((d) => Driver.fromDict(d));
    return w;
  }
}
