/** Physical objects: dynamic circular bodies and static wall segments. */
import { Vec2 } from "../core/vec";

export type Color = [number, number, number];

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
  // transient: true while the user holds the mouse on this body. A held
  // body acts as infinite mass (it stays pinned under the cursor) but
  // everything else still collides with it. Never serialized.
  held = false;
  color: Color;
  // scratch state used by the solver
  acc = new Vec2();
  prev = new Vec2();
  corrX = 0.0;
  corrY = 0.0;

  constructor(pos: Vec2, radius = 0.15, mass = 1.0, color: Color | null = null) {
    this.id = Body.nextId++;
    this.name = `Body ${this.id}`;
    this.pos = pos;
    this.mass = mass;
    this.radius = radius;
    this.color = color ?? BODY_PALETTE[this.id % BODY_PALETTE.length];
  }

  // --- derived quantities ---------------------------------------------------
  get invMass(): number {
    return this.locked || this.held || this.mass <= 0.0 ? 0.0 : 1.0 / this.mass;
  }

  /** Moment of inertia of a uniform disc: I = mr^2/2. */
  get inertia(): number {
    return 0.5 * this.mass * this.radius * this.radius;
  }

  get invInertia(): number {
    if (this.locked || this.held || this.mass <= 0.0 || this.radius <= 0.0) return 0.0;
    return 2.0 / (this.mass * this.radius * this.radius);
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
      color: [...this.color],
    };
  }

  static fromDict(d: BodyDict): Body {
    const b = new Body(new Vec2(...d.pos), d.radius, d.mass,
                       d.color as Color);
    b.id = d.id;
    Body.nextId = Math.max(Body.nextId, b.id + 1);
    b.name = d.name ?? `Body ${b.id}`;
    b.vel = new Vec2(...d.vel);
    b.angle = d.angle ?? 0.0;
    b.omega = d.omega ?? 0.0;
    b.restitution = d.restitution;
    b.friction = d.friction;
    const cf = d.const_force ?? [0, 0];
    b.constForce = new Vec2(cf[0], cf[1]);
    b.locked = d.locked;
    b.collides = d.collides ?? true;
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
  color: Color = [150, 155, 165];

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
    const w = new Wall(new Vec2(...d.a), new Vec2(...d.b), d.thickness);
    w.id = d.id;
    Wall.nextId = Math.max(Wall.nextId, w.id + 1);
    w.name = d.name ?? `Wall ${w.id}`;
    w.restitution = d.restitution;
    w.friction = d.friction;
    w.color = (d.color as Color) ?? [150, 155, 165];
    return w;
  }
}
