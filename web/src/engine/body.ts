/** Physical objects: dynamic circular bodies and static wall segments. */
import { boolOr, clamp01, colorOr, idOr, numIn, numOr as num, strOr } from "../core/guards";
import { Vec2 } from "../core/vec";

export type Color = [number, number, number];

const WALL_GREY: Color = [150, 155, 165];

/** Bounds applied at the untrusted scene-data boundary and reused by the
 * world's runtime divergence guard. */
export const SCENE_MAX_COORDINATE = 1e6;
export const SCENE_MAX_VELOCITY = 1e7;
export const SCENE_MIN_SIZE = 1e-4;
export const SCENE_MAX_SIZE = 1e6;
export const SCENE_MIN_MASS = 1e-9;
export const SCENE_MAX_MASS = 1e12;
export const SCENE_MAX_FRICTION = 1e6;
export const SCENE_MAX_FORCE = 1e9;
export const SCENE_MAX_SURFACE_SPEED = 1e7;
export const PULLEY_RADIUS = 0.22;

/** Canonical angle representation used for imported body and driver data. */
export function normalizeAngle(value: unknown, fallback = 0.0): number {
  const angle = num(value, fallback);
  // Preserve canonical inputs exactly. Besides avoiding needless floating
  // point noise, this keeps serialize -> deserialize snapshots byte-stable
  // for undo, redo and rewind.
  if (angle >= -Math.PI && angle < Math.PI) return angle;
  const tau = 2.0 * Math.PI;
  return ((angle + Math.PI) % tau + tau) % tau - Math.PI;
}

function boundedMass(value: unknown): number {
  const mass = num(value, 1.0);
  if (mass === 0.0) return 0.0;
  if (mass < SCENE_MIN_MASS) return SCENE_MIN_MASS;
  return mass > SCENE_MAX_MASS ? SCENE_MAX_MASS : mass;
}

function boundedOmega(value: unknown, radius: number): number {
  const limit = SCENE_MAX_SURFACE_SPEED / radius;
  return numIn(value, 0.0, -limit, limit);
}

// Material presets: [restitution, friction]. Restitution combines with min(),
// friction with sqrt(mu_a * mu_b) at contact time.
export const MATERIALS: Record<string, [number, number]> = {
  Custom: [0.8, 0.4],
  Rubber: [0.9, 0.9],
  Steel: [0.75, 0.25],
  Wood: [0.5, 0.45],
  Ice: [0.3, 0.02],
  Clay: [0.05, 0.6],
  Superball: [1.0, 0.5],
};

export const BODY_PALETTE: Color[] = [
  [86, 156, 214], [220, 130, 90], [120, 190, 120], [200, 110, 180],
  [230, 200, 90], [110, 200, 210], [170, 140, 230], [235, 120, 120],
  [140, 200, 160], [210, 160, 100],
];

export interface BodyDict {
  id: number;
  name: string;
  pos: [number, number];
  vel: [number, number];
  angle: number;
  omega: number;
  mass: number;
  radius: number;
  restitution: number;
  friction: number;
  const_force: [number, number];
  locked: boolean;
  collides: boolean;
  no_rotation?: boolean;
  is_anchor?: boolean;
  is_pulley?: boolean;
  color: number[];
}

/** A dynamic disc with translational and rotational state.
 *
 * A body with locked=true behaves as infinite mass/inertia: it never moves
 * but still participates in collisions and constraints (e.g. pendulum pivots).
 */
export class Body {
  static nextId = 1;

  id: number;
  name: string;
  pos: Vec2;
  vel = new Vec2();
  angle = 0.0;
  omega = 0.0; // rad/s
  mass: number;
  radius: number;
  restitution = 0.8;
  friction = 0.4;
  constForce = new Vec2(); // user-applied constant force, N
  locked = false;
  collides = true;
  // true: the body cannot spin (infinite rotational inertia), so contact
  // friction produces no torque and it behaves like a point particle - which
  // means it can rest in limiting equilibrium on a slope (mu >= tan theta)
  // instead of rolling. Distinct from `locked`, which freezes translation too.
  noRotation = false;
  // An anchor is a fixed attachment point (for rods/strings/springs). It is
  // always locked and, unlike a locked massive body, exerts no gravitational
  // pull and is not counted among the bodies. Always named "Anchor".
  isAnchor = false;
  // The fixed axle of a pulley assembly. It is stored as a body because links
  // and selection already use body identities, but it is never an editable or
  // colliding physical disc. Deleting it has assembly-specific semantics in
  // World.removeBodies.
  isPulley = false;
  // transient: true while the user holds the mouse on this body. A held
  // body acts as infinite mass (it stays pinned under the cursor) but
  // everything else still collides with it. Never serialized.
  held = false;
  // transient: rate used to convert rod position corrections back into
  // velocity while this body is moved kinematically by a pointer. A finite
  // value is measured from the pointer interval, not the much shorter solver
  // substep, preventing a display-frame position jump from becoming a huge
  // artificial impulse. Propagated across its rigid-link component. Never
  // serialized.
  kinematicCorrectionRate = Infinity;
  // transient: speed limit (m/s) enforced at the end of every substep
  // while finite. The drag controller sets it on everything link-connected
  // to a grabbed body so user interaction - which is not physical anyway -
  // can tug, jiggle and throw without ever pumping unbounded energy into
  // the assembly. Infinity = no limit. Never serialized.
  speedCap = Infinity;
  // transient: this body is one particle of a soft-body lattice (set by
  // the preset builders). Drives a one-time hint suggesting a right-drag
  // (velocity drag, no deformation) the first time one is left-dragged.
  // Not physics; never serialized.
  softBody = false;
  // transient: had a contact last substep (set by the contact solver).
  // Used by the adaptive-timestep heuristics: a body held in place by
  // contacts keeps a large gravitational acceleration that the contact
  // impulses cancel, so it must not be mistaken for a violent close
  // encounter and trigger fine time-slicing forever. Never serialized.
  touching = false;
  // transient: an endpoint of at least one spring (set per step by
  // World.prepareStep). The same exclusion as `touching`, for the same
  // reason: a stiff spring produces an enormous acceleration that is
  // mostly cancelled by the spring on the other side, and the engine
  // already clamps every spring so the scene's own substep resolves it
  // (see World.prepareSprings and subdivisionNeed). Never serialized.
  sprung = false;
  // transient: how much of its network's inertia this body may present to a
  // contact, as a multiple of its own mass (set per step by
  // World.prepareStep). 1 everywhere except performance mode, where a
  // soft-body particle borrows mass so that something far heavier landing on
  // it is actually resisted - see the Manifold constructor for why a position
  // projection needs the loan and the force solver does not. Never
  // serialized.
  contactMassGain = 1.0;
  color: Color;
  // scratch state used by the solver
  acc = new Vec2();
  /** Realised step-average net force, including contact and constraint
   * impulses. This is transient analysis state and is never serialized. */
  netForce = new Vec2();
  prev = new Vec2();
  corrX = 0.0;
  corrY = 0.0;
  // Where this body sits in performance mode's packed spring solve, and a
  // stamp saying which substep put it there. That solve copies its endpoints
  // into flat arrays and works on those (see PerfSolver), so it needs "is
  // this body already packed, and at what index" answered a few hundred times
  // per substep without allocating a set to answer it. Never serialized.
  perfSlot = 0;
  perfStamp = 0;
  // Maximum-performance sleeping state. Resting unlinked bodies can present
  // zero inverse mass until disturbed; the state is transient and is always
  // cleared outside the aggressive browser-selected Performance levels.
  perfSleeping = false;
  perfSleepFrames = 0;
  // acceleration at the previous adaptive slice boundary, and nothing else:
  // the in-substep slicer sizes its slices from how fast the acceleration
  // is CHANGING along the trajectory (see World.maxAccelChangeRate), which
  // needs one earlier sample to difference against. Never serialized.
  accPrevX = 0.0;
  accPrevY = 0.0;

  constructor(pos: Vec2, radius = 0.15, mass = 1.0, color: Color | null = null) {
    this.id = Body.nextId++;
    this.name = `Body ${this.id}`;
    this.pos = pos;
    this.mass = mass;
    this.radius = radius;
    // copy, never alias: handing out a reference into BODY_PALETTE means an
    // in-place edit (the inspector's colour picker) would repaint every
    // other body that landed on the same palette slot
    this.color = color !== null ? [...color]
                                : [...BODY_PALETTE[this.id % BODY_PALETTE.length]];
  }

  // --- derived quantities ---------------------------------------------------
  get invMass(): number {
    return this.locked || this.held || this.perfSleeping || this.mass <= 0.0
      ? 0.0 : 1.0 / this.mass;
  }

  /** Moment of inertia of a uniform disc: I = mr^2/2. */
  get inertia(): number {
    return 0.5 * this.mass * this.radius * this.radius;
  }

  /** 1/I, or 0 for anything that must not spin.
   *
   * Derived from `inertia` rather than restating the formula. The two used
   * to be written out independently - I = mr^2/2 here, 1/I = 2/(mr^2)
   * there - which made them free to disagree, and only one of them drives
   * the simulation. The solver reads invInertia; `inertia` is read only by
   * the energy and angular-momentum readouts. So a wrong `inertia` would
   * not change how anything MOVES, it would quietly misreport the energy of
   * everything that spins, which is the kind of error a physics sandbox
   * exists to not make. (Found by mutating the formula: the whole suite
   * still passed.) */
  get invInertia(): number {
    if (this.locked || this.held || this.perfSleeping || this.noRotation ||
        this.mass <= 0.0 || this.radius <= 0.0) return 0.0;
    return 1.0 / this.inertia;
  }

  kineticEnergy(): number {
    if (this.locked) return 0.0;
    return 0.5 * this.mass * this.vel.length2() +
      0.5 * this.inertia * this.omega * this.omega;
  }

  // --- serialization ----------------------------------------------------------
  toDict(): BodyDict {
    return {
      id: this.id, name: this.name,
      pos: [this.pos.x, this.pos.y], vel: [this.vel.x, this.vel.y],
      angle: this.angle, omega: this.omega,
      mass: this.mass, radius: this.radius,
      restitution: this.restitution, friction: this.friction,
      const_force: [this.constForce.x, this.constForce.y],
      locked: this.locked, collides: this.collides,
      no_rotation: this.noRotation,
      is_anchor: this.isAnchor,
      is_pulley: this.isPulley,
      color: [...this.color],
    };
  }

  static fromDict(d: BodyDict, preserveAngle = false): Body {
    // Every field is defaulted and finite-checked: scene .json can come
    // from an import, a hand-edited file or an older/newer version, and a
    // single missing or non-numeric field used to reach the solver as
    // undefined -> NaN, which silently froze the whole scene on step 1
    // with no message the user could act on.
    const b = new Body(
      new Vec2(numIn(d.pos?.[0], 0, -SCENE_MAX_COORDINATE, SCENE_MAX_COORDINATE),
               numIn(d.pos?.[1], 0, -SCENE_MAX_COORDINATE, SCENE_MAX_COORDINATE)),
      numIn(d.radius, 0.15, SCENE_MIN_SIZE, SCENE_MAX_SIZE),
      boundedMass(d.mass),
    );
    if (d.color !== undefined) b.color = colorOr(d.color, b.color);
    b.id = idOr(d.id, b.id);
    Body.nextId = Math.max(Body.nextId, b.id + 1);
    b.name = strOr(d.name, `Body ${b.id}`);
    b.vel = new Vec2(
      numIn(d.vel?.[0], 0, -SCENE_MAX_VELOCITY, SCENE_MAX_VELOCITY),
      numIn(d.vel?.[1], 0, -SCENE_MAX_VELOCITY, SCENE_MAX_VELOCITY),
    );
    b.angle = preserveAngle ? num(d.angle, 0) : normalizeAngle(d.angle);
    b.omega = boundedOmega(d.omega, b.radius);
    b.restitution = clamp01(num(d.restitution, 0.8));
    b.friction = numIn(d.friction, 0.4, 0, SCENE_MAX_FRICTION);
    const cf = d.const_force ?? [0, 0];
    b.constForce = new Vec2(
      numIn(cf[0], 0, -SCENE_MAX_FORCE, SCENE_MAX_FORCE),
      numIn(cf[1], 0, -SCENE_MAX_FORCE, SCENE_MAX_FORCE),
    );
    b.locked = boolOr(d.locked, false);
    b.collides = boolOr(d.collides, true);
    b.noRotation = boolOr(d.no_rotation, false);
    if (b.noRotation) b.omega = 0.0; // a non-rotating body never spins
    b.isPulley = boolOr(d.is_pulley, false);
    b.isAnchor = b.isPulley || boolOr(d.is_anchor, false);
    if (b.isAnchor) {
      b.locked = true;
      b.name = b.isPulley ? "Pulley" : "Anchor";
    }
    if (b.isPulley) {
      b.collides = false;
      b.radius = PULLEY_RADIUS;
      b.constForce.set(0, 0);
      b.noRotation = true;
      b.vel.set(0, 0);
      b.omega = 0.0;
    }
    return b;
  }
}

export interface WallDict {
  id: number;
  name: string;
  a: [number, number];
  b: [number, number];
  thickness: number;
  restitution: number;
  friction: number;
  color: number[];
}

/** A static capsule segment (line with thickness) that bodies collide with. */
export class Wall {
  static nextId = 1;

  id: number;
  name: string;
  a: Vec2;
  b: Vec2;
  thickness: number;
  restitution = 0.8;
  friction = 0.5;
  color: Color = [...WALL_GREY];

  constructor(a: Vec2, b: Vec2, thickness = 0.08) {
    this.id = Wall.nextId++;
    this.name = `Wall ${this.id}`;
    this.a = a;
    this.b = b;
    this.thickness = thickness;
  }

  toDict(): WallDict {
    return {
      id: this.id, name: this.name,
      a: [this.a.x, this.a.y], b: [this.b.x, this.b.y],
      thickness: this.thickness, restitution: this.restitution,
      friction: this.friction, color: [...this.color],
    };
  }

  static fromDict(d: WallDict): Wall {
    const w = new Wall(
      new Vec2(numIn(d.a?.[0], 0, -SCENE_MAX_COORDINATE, SCENE_MAX_COORDINATE),
               numIn(d.a?.[1], 0, -SCENE_MAX_COORDINATE, SCENE_MAX_COORDINATE)),
      new Vec2(numIn(d.b?.[0], 0, -SCENE_MAX_COORDINATE, SCENE_MAX_COORDINATE),
               numIn(d.b?.[1], 0, -SCENE_MAX_COORDINATE, SCENE_MAX_COORDINATE)),
      numIn(d.thickness, 0.08, SCENE_MIN_SIZE, SCENE_MAX_SIZE),
    );
    w.id = idOr(d.id, w.id);
    Wall.nextId = Math.max(Wall.nextId, w.id + 1);
    w.name = strOr(d.name, `Wall ${w.id}`);
    w.restitution = clamp01(num(d.restitution, 0.8));
    w.friction = numIn(d.friction, 0.5, 0, SCENE_MAX_FRICTION);
    w.color = colorOr(d.color, WALL_GREY);
    return w;
  }
}
