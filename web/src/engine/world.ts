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
 */
import { CompiledExpr, ExprError, compileExpr } from "../core/expr";
import { Vec2 } from "../core/vec";
import { Body, BodyDict, Wall, WallDict } from "./body";
import { Contact, ContactCache, ContactStatic, solveContacts } from "./contacts";
import { DistanceLink, Link, LinkDict, SpringLink, linkFromDict } from "./links";

export const INTEGRATORS = ["Velocity Verlet", "Symplectic Euler", "RK4"] as const;
export type Integrator = (typeof INTEGRATORS)[number];

// Gauss-Seidel passes for the acceleration-level rod tension solve. Warm
// starting makes a handful of passes enough even for long chains.
const ROD_FORCE_PASSES = 4;

// Adaptive close-encounter integration (mutual-gravity scenes only): a
// substep is marched through in slices sized so that no body's velocity
// direction swings more than ENCOUNTER_ANGLE radians per slice, with at
// most ENCOUNTER_MAX_SLICES-fold refinement. Deep two-body encounters
// (which would otherwise blow up the energy) then get automatically and
// smoothly resolved down to microsecond slices, while calm stretches take
// a single slice at zero extra cost.
const ENCOUNTER_ANGLE = 0.02;       // rad of velocity swing per slice
const ENCOUNTER_MAX_SLICES = 1024;  // floor: slice >= h / this

// Mouse-drag speed limit tuning: a held body may not chase the cursor faster
// than DRAG_GAMMA * rest_length * omega of its stiffest attached spring, so a
// fast drag can never stretch a spring faster than it can respond - which is
// what used to scramble soft bodies. The floor keeps dragging responsive
// even on extremely stiff/light lattices.
const DRAG_GAMMA = 0.3;
const DRAG_SPEED_FLOOR = 2.5; // m/s

/** Maximum speed at which `body` may be dragged through the world.
 *
 * `base` is the caller's scale-derived cap (e.g. a few screen-widths per
 * second); it is tightened for bodies with springs attached so the drag
 * cannot outrun the spring response of whatever it is anchored to.
 */
export function safeDragSpeed(world: World, body: Body, base: number): number {
  let v = base;
  for (const ln of world.links) {
    if (!(ln instanceof SpringLink)) continue;
    let other: Body;
    if (ln.a === body) other = ln.b;
    else if (ln.b === body) other = ln.a;
    else continue;
    const iw = other.invMass;
    if (iw <= 0.0 || ln.stiffness <= 0.0) continue; // anchored to something immovable
    const omega = Math.sqrt(ln.stiffness * iw);
    v = Math.min(v, DRAG_GAMMA * Math.max(ln.restLength, 0.05) * omega);
  }
  return Math.max(v, DRAG_SPEED_FLOOR);
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
    const f = new ForceField(d.name, d.fx, d.fy);
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
    const drv = new Driver(d.body_id, d.amplitude, d.frequency, d.phase, d.angle);
    drv.enabled = d.enabled ?? true;
    return drv;
  }
}

export interface WorldDict {
  settings: {
    gravity: number;
    mutual_gravity: boolean;
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

interface RodRow {
  ln: DistanceLink;
  a: Body;
  b: Body;
  wa: number;
  wb: number;
  wSum: number;
  nx: number;
  ny: number;
  d: number;
  mu: number;
}

export class World {
  bodies: Body[] = [];
  walls: Wall[] = [];
  links: Link[] = [];
  fields: ForceField[] = [];
  drivers: Driver[] = [];

  gravity = 9.81;          // m/s^2, downward (negative = upward)
  mutualGravity = false;   // pairwise Newtonian attraction
  G = 1.0;                 // gravitational constant (scaled units)
  softening = 0.01;        // m, avoids the r->0 singularity
  dragLinear = 0.0;        // N*s/m         (F = -c1 v)
  dragQuadratic = 0.0;     // N*s^2/m^2     (F = -c2 |v| v)
  globalDamping = 0.0;     // 1/s, exponential velocity decay

  integrator: Integrator = "Velocity Verlet";
  substeps = 4;
  iterations = 8;          // solver iterations (links and contacts)

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
  // transient mouse-drag pins: held body -> [target_x, target_y, v_max].
  // Each substep the body travels toward its target at up to v_max, so a
  // fast drag stays a smooth, bounded motion instead of a teleport.
  dragPins = new Map<Body, [number, number, number]>();
  private contactCache: ContactCache = new Map(); // warm-start impulses between substeps
  private rods: DistanceLink[] = [];  // per-step caches, see prepareStep()
  private movers: Body[] = [];
  private contactStatic: ContactStatic = {};

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
      const a = ln.a.id;
      const b = ln.b.id;
      noCollide.add(a < b ? `${a},${b}` : `${b},${a}`);
    }
    this.rods = rods;
    // Stability clamp: an explicit spring is only stable while h*omega stays
    // small (omega^2 = k*(1/ma + 1/mb)), and likewise h*c*(1/ma + 1/mb) for
    // damping. Clamp the *effective* k and c to those limits each substep so
    // extreme user settings behave like "as stiff as this timestep can
    // carry" instead of blowing up.
    const h2 = h * h;
    for (const s of springs) {
      const wSum = s.a.invMass + s.b.invMass;
      let k = s.stiffness;
      let c = s.damping > 0.0 ? s.damping : 0.0;
      if (wSum > 0.0) {
        const kLim = 1.0 / (h2 * wSum); // keeps h*omega <= 1
        if (k > kLim) k = kLim;
        const cLim = 0.5 / (h * wSum);  // no single-step overshoot
        if (c > cLim) c = cLim;
      }
      s.kEff = k;
      s.cEff = c;
    }
    this.movers = this.bodies.filter((b) => b.invMass !== 0.0);
    // directly linked bodies never collide with each other (their link
    // already governs their separation); everything else does, which is
    // what stops soft bodies from tangling through themselves
    this.contactStatic = { noCollide };
  }

  /** Fill body.acc with the total smooth acceleration at the current state. */
  private accumulateForces(t: number): void {
    const g = this.gravity;
    const c1 = this.dragLinear;
    const c2 = this.dragQuadratic;
    for (const b of this.bodies) {
      if (b.invMass === 0.0) {
        b.acc.set(0.0, 0.0);
        continue;
      }
      const invM = b.invMass;
      let ax = b.constForce.x * invM;
      let ay = b.constForce.y * invM - g;
      if (c1 !== 0.0 || c2 !== 0.0) {
        const vx = b.vel.x;
        const vy = b.vel.y;
        const speed = Math.sqrt(vx * vx + vy * vy);
        const drag = (c1 + c2 * speed) * invM;
        ax -= drag * vx;
        ay -= drag * vy;
      }
      b.acc.set(ax, ay);
    }

    if (this.mutualGravity && this.G !== 0.0) {
      const bodies = this.bodies;
      const n = bodies.length;
      const G = this.G;
      const eps2 = this.softening * this.softening;
      for (let i = 0; i < n; i++) {
        const bi = bodies[i];
        if (bi.isAnchor) continue; // anchors neither pull nor are pulled
        const bix = bi.pos.x;
        const biy = bi.pos.y;
        const biAcc = bi.acc;
        const biMovable = bi.invMass !== 0.0;
        const biMass = bi.mass;
        for (let j = i + 1; j < n; j++) {
          const bj = bodies[j];
          if (bj.isAnchor) continue;
          const dx = bj.pos.x - bix;
          const dy = bj.pos.y - biy;
          const d2 = dx * dx + dy * dy + eps2;
          const s = G / (d2 * Math.sqrt(d2)); // G / d^3
          if (biMovable) {
            const m = s * bj.mass;
            biAcc.x += m * dx;
            biAcc.y += m * dy;
          }
          if (bj.invMass !== 0.0) {
            const m = s * biMass;
            bj.acc.x -= m * dx;
            bj.acc.y -= m * dy;
          }
        }
      }
    }

    for (const link of this.links) {
      if (link instanceof SpringLink) link.applyForces();
    }

    if (this.drivers.length > 0) {
      const byId = new Map<number, Body>();
      for (const b of this.bodies) byId.set(b.id, b);
      const TAU = 2 * Math.PI;
      for (const drv of this.drivers) {
        if (!drv.enabled) continue;
        const b = byId.get(drv.bodyId);
        if (b === undefined || b.invMass === 0.0) continue;
        const f = drv.amplitude * Math.sin(TAU * drv.frequency * t + drv.phase);
        b.acc.x += f * Math.cos(drv.angle) * b.invMass;
        b.acc.y += f * Math.sin(drv.angle) * b.invMass;
      }
    }

    for (const field of this.fields) {
      if (!field.enabled || field.fx === null || field.fy === null) continue;
      const fx = field.fx;
      const fy = field.fy;
      for (const b of this.bodies) {
        if (b.invMass === 0.0) continue;
        const env = {
          x: b.pos.x, y: b.pos.y, vx: b.vel.x, vy: b.vel.y,
          t, m: b.mass,
          r: Math.sqrt(b.pos.x * b.pos.x + b.pos.y * b.pos.y),
        };
        try {
          const ax = fx(env) * b.invMass;
          const ay = fy(env) * b.invMass;
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

    this.solveRodForces();
  }

  /** Add the analytic rod/rope constraint forces to the accelerations.
   *
   * Solves d^2C/dt^2 = n.(a_b - a_a) + |v_t|^2/d = 0 for every rod's
   * tension with warm-started Gauss-Seidel. The warm start (last solve's
   * tension as the initial guess) makes a few passes sufficient even for
   * long chains; the XPBD position pass mops up the O(h^2) residual.
   */
  private solveRodForces(): void {
    const rows: RodRow[] = [];
    for (const ln of this.rods) {
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
      rows.push({ ln, a, b, wa, wb, wSum, nx, ny, d, mu });
    }
    if (rows.length === 0) return;
    for (let pass = 0; pass < ROD_FORCE_PASSES; pass++) {
      let worst = 0.0;
      for (const row of rows) {
        const { ln, a, b, wa, wb, wSum, nx, ny, d } = row;
        const rvx = b.vel.x - a.vel.x;
        const rvy = b.vel.y - a.vel.y;
        const vn = rvx * nx + rvy * ny;
        const vt2 = rvx * rvx + rvy * rvy - vn * vn;
        const an = (b.acc.x - a.acc.x) * nx + (b.acc.y - a.acc.y) * ny;
        let newMu = row.mu + (an + vt2 / d) / wSum;
        if (ln.isRope && newMu < 0.0) newMu = 0.0;
        const dmu = newMu - row.mu;
        row.mu = newMu;
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
    for (const row of rows) row.ln.mu = row.mu;
  }

  // -------------------------------------------------------------- integrators
  /** Largest a/|v| over the moving bodies: how fast (rad/s) the
   * fastest-turning body's velocity direction is being swung by the
   * current accelerations. Spikes during gravitational close passes. */
  private maxSwingRate(): number {
    let worst = 0.0;
    for (const b of this.bodies) {
      if (b.invMass === 0.0) continue;
      const a2 = b.acc.x * b.acc.x + b.acc.y * b.acc.y;
      if (a2 === 0.0) continue;
      const v = Math.sqrt(b.vel.x * b.vel.x + b.vel.y * b.vel.y);
      const w = Math.sqrt(a2) / (v + 0.05);
      if (w > worst) worst = w;
    }
    return worst;
  }

  /** March through one substep in adaptively sized slices.
   *
   * Each slice is capped at ENCOUNTER_ANGLE / (max a/|v|), re-evaluated
   * from the freshest accelerations after every slice, so a close
   * encounter deepening mid-substep keeps getting finer resolution
   * (down to h/ENCOUNTER_MAX_SLICES). This is what keeps the energy of
   * near-collision N-body orbits from exploding, at no cost to calm
   * scenes. */
  private integrateAdaptive(h: number): void {
    let remaining = h;
    const floor = h / ENCOUNTER_MAX_SLICES;
    let guard = 2 * ENCOUNTER_MAX_SLICES; // hard bound on work
    const spacing = this.traceSpacing;
    while (remaining > 1e-12 && guard > 0) {
      guard--;
      const w = this.maxSwingRate();
      let hh = w <= 0.0 ? remaining : Math.min(remaining, ENCOUNTER_ANGLE / w);
      if (hh < floor) hh = floor;
      const sliced = hh < remaining;
      if (sliced && spacing > 0.0) {
        // capture the path inside the slicing so trails show the
        // encounter's curve instead of a step-to-step corner
        for (const b of this.movers) {
          const last = this.traceLast.get(b.id);
          if (last === undefined ||
              Math.abs(last[0] - b.pos.x) + Math.abs(last[1] - b.pos.y) >= spacing) {
            this.traceLast.set(b.id, [b.pos.x, b.pos.y]);
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
        this.integrateRk4(hh);
      } else {
        this.integrate(hh);
      }
      remaining -= hh;
    }
  }

  private integrate(h: number): void {
    const name = this.integrator;
    const movers = this.movers;
    if (name === "RK4") {
      this.integrateRk4(h);
    } else if (name === "Symplectic Euler") {
      this.accumulateForces(this.time);
      for (const b of movers) {
        b.angle += b.omega * h;
        b.vel.x += b.acc.x * h;
        b.vel.y += b.acc.y * h;
        b.pos.x += b.vel.x * h;
        b.pos.y += b.vel.y * h;
      }
    } else { // Velocity Verlet
      this.accumulateForces(this.time);
      const half = 0.5 * h;
      for (const b of movers) {
        b.angle += b.omega * h;
        b.vel.x += b.acc.x * half;
        b.vel.y += b.acc.y * half;
        b.pos.x += b.vel.x * h;
        b.pos.y += b.vel.y * h;
      }
      this.accumulateForces(this.time + h);
      for (const b of movers) {
        b.vel.x += b.acc.x * half;
        b.vel.y += b.acc.y * half;
      }
    }
  }

  private integrateRk4(h: number): void {
    const movers = this.movers;
    const n = movers.length;
    if (n === 0) return;
    for (const b of movers) b.angle += b.omega * h;
    // state and derivative arrays: [px, py, vx, vy] per mover
    const x0 = new Float64Array(4 * n);
    for (let i = 0; i < n; i++) {
      const b = movers[i];
      x0[4 * i] = b.pos.x;
      x0[4 * i + 1] = b.pos.y;
      x0[4 * i + 2] = b.vel.x;
      x0[4 * i + 3] = b.vel.y;
    }

    const evalAcc = (t: number, out: Float64Array): void => {
      // derivative of [px, py, vx, vy] is [vx, vy, ax, ay]
      this.accumulateForces(t);
      for (let i = 0; i < n; i++) {
        const b = movers[i];
        out[4 * i] = b.vel.x;
        out[4 * i + 1] = b.vel.y;
        out[4 * i + 2] = b.acc.x;
        out[4 * i + 3] = b.acc.y;
      }
    };
    const load = (base: Float64Array, deriv: Float64Array, scale: number): void => {
      for (let i = 0; i < n; i++) {
        const b = movers[i];
        b.pos.x = base[4 * i] + scale * deriv[4 * i];
        b.pos.y = base[4 * i + 1] + scale * deriv[4 * i + 1];
        b.vel.x = base[4 * i + 2] + scale * deriv[4 * i + 2];
        b.vel.y = base[4 * i + 3] + scale * deriv[4 * i + 3];
      }
    };

    const k1 = new Float64Array(4 * n);
    const k2 = new Float64Array(4 * n);
    const k3 = new Float64Array(4 * n);
    const k4 = new Float64Array(4 * n);
    evalAcc(this.time, k1);
    load(x0, k1, 0.5 * h);
    evalAcc(this.time + 0.5 * h, k2);
    load(x0, k2, 0.5 * h);
    evalAcc(this.time + 0.5 * h, k3);
    load(x0, k3, h);
    evalAcc(this.time + h, k4);

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
    const n = Math.max(1, this.substeps);
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
    const iters = this.iterations;
    // N-body scenes get adaptive slice-marching inside each substep so
    // close encounters can't blow up; everything else is untouched
    const adaptive = this.mutualGravity && this.G !== 0.0;
    for (let s = 0; s < n; s++) {
      if (this.dragPins.size > 0) this.moveDragPins(h, invH);

      // (spin integration happens inside the integrator body loops;
      // torque only arises from contacts, applied there)
      if (adaptive) this.integrateAdaptive(h);
      else this.integrate(h);

      if (rigid.length > 0) this.solveRodPositions(rigid, invH, iters);

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

      this.time += h;
    }
    this.sanitize();
    this.stepCount++;
  }

  /** Advance held bodies toward their drag targets, at most v_max each.
   *
   * The body keeps infinite mass (nothing can push it) but moves
   * kinematically with a real velocity, so springs stretch smoothly,
   * spring damping sees the true relative speed, and contacts treat it
   * like a moving platform that carries other bodies along.
   */
  private moveDragPins(h: number, invH: number): void {
    for (const [b, [tx, ty, vMax]] of this.dragPins) {
      if (!b.held) continue; // released this frame; controller clears soon
      const dx = tx - b.pos.x;
      const dy = ty - b.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const stepLen = vMax * h;
      if (dist <= stepLen) {
        b.pos.set(tx, ty);
        b.vel.set(dx * invH, dy * invH);
      } else {
        const s = stepLen / dist;
        const mx = dx * s;
        const my = dy * s;
        b.pos.x += mx;
        b.pos.y += my;
        b.vel.set(mx * invH, my * invH);
      }
    }
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
   */
  subdivisionNeed(dt: number, maxQ = 16): number {
    let q = 1;
    const k = dt * dt * 0.125;
    for (const b of this.bodies) {
      if (b.invMass === 0.0) continue;
      const ax = b.acc.x;
      const ay = b.acc.y;
      const dev = Math.sqrt(ax * ax + ay * ay) * k;
      let tol = b.radius * 0.04;
      if (tol < 0.002) tol = 0.002;
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
          peN -= this.G * bi.mass * bj.mass /
            Math.sqrt(dx * dx + dy * dy + eps2);
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
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
    this.links = this.links.filter((ln) => ln.a !== body && ln.b !== body);
    this.drivers = this.drivers.filter((d) => d.bodyId !== body.id);
  }

  removeWall(wall: Wall): void {
    const i = this.walls.indexOf(wall);
    if (i >= 0) this.walls.splice(i, 1);
  }

  removeLink(link: Link): void {
    const i = this.links.indexOf(link);
    if (i >= 0) this.links.splice(i, 1);
  }

  // ----------------------------------------------------------- serialization
  toDict(): WorldDict {
    return {
      settings: {
        gravity: this.gravity, mutual_gravity: this.mutualGravity,
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
    w.gravity = s.gravity ?? 9.81;
    w.mutualGravity = s.mutual_gravity ?? false;
    w.G = s.G ?? 1.0;
    w.softening = s.softening ?? 0.01;
    w.dragLinear = s.drag_linear ?? 0.0;
    w.dragQuadratic = s.drag_quadratic ?? 0.0;
    w.globalDamping = s.global_damping ?? 0.0;
    const integ = s.integrator ?? "Velocity Verlet";
    w.integrator = (INTEGRATORS as readonly string[]).includes(integ)
      ? (integ as Integrator) : "Velocity Verlet";
    w.substeps = Math.max(1, Math.min(64, Math.trunc(s.substeps ?? 4)));
    w.iterations = Math.trunc(s.iterations ?? 8);
    w.time = s.time ?? 0.0;
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
