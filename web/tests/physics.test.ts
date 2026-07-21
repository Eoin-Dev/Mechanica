/** Physics verification suite (headless port of mechanica/tests_physics.py).
 *
 * Checks the engine against analytic results: projectile motion, orbital
 * energy conservation, collision conservation laws, pendulum and spring
 * periods, constraint drift, N-body momentum, the expression sandbox and
 * serialization round-trips. Tolerances match the desktop suite.
 */
import { describe, expect, it } from "vitest";
import { ExprError, compileExpr } from "../src/core/expr";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { DistanceLink, SpringLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";

const DT = 1.0 / 120.0;

interface BodyOpts {
  r?: number;
  m?: number;
  vx?: number;
  vy?: number;
  locked?: boolean;
}

function body(w: World, x: number, y: number, opts: BodyOpts = {}): Body {
  const b = new Body(new Vec2(x, y), opts.r ?? 0.1, opts.m ?? 1.0);
  b.vel.set(opts.vx ?? 0.0, opts.vy ?? 0.0);
  b.locked = opts.locked ?? false;
  w.bodies.push(b);
  return b;
}

function run(w: World, seconds: number): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) w.step(DT);
}

function preset(name: string): World {
  const p = PRESETS.find((p) => p.name === name);
  if (!p) throw new Error(`no preset named '${name}'`);
  return p.build();
}

// ---------------------------------------------------------------- projectile
describe("projectile", () => {
  it.each([
    ["Velocity Verlet", 1e-6],
    ["Symplectic Euler", 0.05],
    ["RK4", 1e-6],
  ] as const)("matches SUVAT (%s)", (integrator, tol) => {
    const w = new World();
    w.integrator = integrator;
    w.substeps = 4;
    const b = body(w, 0, 0, { vx: 3.0, vy: 8.0 });
    b.collides = false;
    const t = 2.0;
    run(w, t);
    const exactX = 3.0 * t;
    const exactY = 8.0 * t - 0.5 * 9.81 * t * t;
    const err = Math.hypot(b.pos.x - exactX, b.pos.y - exactY);
    expect(err).toBeLessThan(tol);
  });

  it("linear drag matches exponential decay (RK4)", () => {
    // RK4 with linear drag vs the exact solution v(t) = v0 e^(-ct/m), g=0
    const w = new World();
    w.integrator = "RK4";
    w.substeps = 2;
    w.gravity = 0.0;
    w.dragLinear = 0.7;
    const b = body(w, 0, 0, { vx: 5.0 });
    b.collides = false;
    const t = 3.0;
    run(w, t);
    const exactVx = 5.0 * Math.exp(-0.7 * t);
    const exactX = (5.0 / 0.7) * (1 - Math.exp(-0.7 * t));
    expect(Math.abs(b.vel.x - exactVx)).toBeLessThan(1e-6);
    expect(Math.abs(b.pos.x - exactX)).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------- collisions
describe("collisions", () => {
  it("elastic collision conserves momentum and energy, matches analytic velocities", () => {
    const w = new World();
    w.gravity = 0.0;
    const a = body(w, -1, 0, { r: 0.1, m: 1.0, vx: 2.0 });
    const b = body(w, 1, 0, { r: 0.1, m: 3.0, vx: -1.0 });
    a.restitution = b.restitution = 1.0;
    a.friction = b.friction = 0.0;
    const p0 = w.momentum().x;
    const e0 = w.energy().total;
    run(w, 2.0);
    const p1 = w.momentum().x;
    const e1 = w.energy().total;
    // analytic 1D elastic result
    const v1 = ((1 - 3) / 4) * 2.0 + ((2 * 3) / 4) * -1.0; // -2.5
    const v2 = ((2 * 1) / 4) * 2.0 + ((3 - 1) / 4) * -1.0; // 0.5
    expect(Math.abs(p1 - p0)).toBeLessThan(1e-9);
    expect(Math.abs(e1 - e0) / Math.abs(e0)).toBeLessThan(5e-3);
    expect(Math.abs(a.vel.x - v1)).toBeLessThan(0.05);
    expect(Math.abs(b.vel.x - v2)).toBeLessThan(0.05);
  });

  it("perfectly inelastic equal masses end at a common velocity", () => {
    const w = new World();
    w.gravity = 0.0;
    const a = body(w, -1, 0, { r: 0.1, m: 1.0, vx: 2.0 });
    const b = body(w, 1, 0, { r: 0.1, m: 1.0, vx: 0.0 });
    a.restitution = b.restitution = 0.0;
    a.friction = b.friction = 0.0;
    run(w, 2.0);
    expect(Math.abs(a.vel.x - 1.0)).toBeLessThan(0.05);
    expect(Math.abs(b.vel.x - 1.0)).toBeLessThan(0.05);
  });
});

// -------------------------------------------------------------------- orbits
describe("orbits", () => {
  it("circular orbit conserves energy and radius over 60 s", () => {
    const w = new World();
    w.gravity = 0.0;
    w.mutualGravity = true;
    w.G = 1.0;
    w.softening = 0.0001;
    w.substeps = 8;
    const star = body(w, 0, 0, { r: 0.3, m: 1000.0, locked: true });
    star.collides = false;
    const d = 3.0;
    const p = body(w, d, 0, { r: 0.05, m: 1.0, vy: Math.sqrt(1000.0 / d) });
    p.collides = false;
    const e0 = w.energy().total;
    const r0 = p.pos.length();
    run(w, 60.0); // many orbital periods
    const e1 = w.energy().total;
    const r1 = p.pos.length();
    expect(Math.abs(e1 - e0) / Math.abs(e0)).toBeLessThan(1e-3);
    expect(Math.abs(r1 - r0) / r0).toBeLessThan(0.01);
  });

  it("three-body: total momentum conserved", () => {
    const w = new World();
    w.gravity = 0.0;
    w.mutualGravity = true;
    w.G = 5.0;
    w.substeps = 8;
    const a = body(w, -1, 0.3, { m: 4.0, vy: 0.5 });
    const b = body(w, 1.5, -0.2, { m: 2.0, vy: -1.0 });
    const c = body(w, 0.2, 1.2, { m: 1.0, vx: 0.4 });
    for (const x of [a, b, c]) x.collides = false;
    const p0 = w.momentum();
    run(w, 10.0);
    const p1 = w.momentum();
    expect(Math.hypot(p1.x - p0.x, p1.y - p0.y)).toBeLessThan(1e-9);
  });
});

// ----------------------------------------------------------------- pendulums
describe("pendulums", () => {
  it("simple pendulum period matches 2*pi*sqrt(L/g)", () => {
    const w = new World();
    w.substeps = 8;
    const length = 1.5;
    const theta0 = (5 * Math.PI) / 180;
    const pivot = body(w, 0, 0, { r: 0.05, locked: true });
    const bob = body(w, length * Math.sin(theta0), -length * Math.cos(theta0),
                     { r: 0.08 });
    bob.collides = pivot.collides = false;
    w.links.push(new DistanceLink(pivot, bob));
    // measure the period from successive positive-going zero crossings of x
    const crossings: number[] = [];
    let prevX = bob.pos.x;
    let t = 0.0;
    while (t < 15.0) {
      w.step(DT);
      t += DT;
      if (prevX < 0 && bob.pos.x >= 0) crossings.push(t);
      prevX = bob.pos.x;
    }
    const periods = crossings.slice(1).map((b, i) => b - crossings[i]);
    const measured = periods.reduce((a, b) => a + b, 0) / periods.length;
    const exact = 2 * Math.PI * Math.sqrt(length / 9.81) * (1 + theta0 ** 2 / 16);
    expect(Math.abs(measured - exact) / exact).toBeLessThan(0.01);
  });

  it("double pendulum: rod drift < 0.1% and energy drift < 0.5% over 20 s", () => {
    const w = new World();
    w.substeps = 12;
    const pivot = body(w, 0, 1, { r: 0.05, locked: true });
    const b1 = body(w, 0.9, 1, { r: 0.08 });
    const b2 = body(w, 1.8, 1, { r: 0.08 });
    for (const x of [pivot, b1, b2]) x.collides = false;
    const l1 = new DistanceLink(pivot, b1);
    const l2 = new DistanceLink(b1, b2);
    w.links.push(l1, l2);
    const e0 = w.energy().total;
    run(w, 20.0); // chaotic double pendulum
    const err1 = Math.abs(pivot.pos.distTo(b1.pos) - l1.length) / l1.length;
    const err2 = Math.abs(b1.pos.distTo(b2.pos) - l2.length) / l2.length;
    expect(Math.max(err1, err2)).toBeLessThan(1e-3);
    const e1 = w.energy().total;
    expect(Math.abs(e1 - e0) / Math.abs(e0)).toBeLessThan(5e-3);
  });

  it.each([
    ["Simple pendulum", 60.0, 1e-3],
    ["Triple pendulum", 30.0, 5e-3],
  ] as const)("%s: energy conserved", (name, seconds, tol) => {
    // The flagship fix: rigid-link systems must not bleed energy.
    const w = preset(name);
    const e0 = w.energy().total;
    run(w, seconds);
    const e1 = w.energy().total;
    const drift = Math.abs(e1 - e0) / Math.max(Math.abs(e0), 1e-9);
    expect(drift).toBeLessThan(tol);
  });

  it("swinging rope (damped strings): energy only dissipates", () => {
    // the rope is a chain of *damped* elastic strings, so its physical
    // invariant is dissipation: energy may only ever go down, never up
    const w = preset("Swinging rope");
    const e0 = w.energy().total;
    let peak = e0;
    for (let i = 0; i < Math.round(15.0 / DT); i++) {
      w.step(DT);
      const e = w.energy().total;
      if (e > peak) peak = e;
    }
    const e1 = w.energy().total;
    const scale = Math.max(Math.abs(e0), 1e-9);
    expect(peak).toBeLessThanOrEqual(e0 + scale * 5e-3);
    expect(e1).toBeLessThanOrEqual(e0);
  });

  it("Newton's cradle: one ball in, one ball out", () => {
    const w = preset("Newton's cradle");
    run(w, 1.2); // first ball swings down and strikes the row
    const balls = w.bodies.filter((b) => !b.locked);
    const moving = balls.filter((b) => b.vel.length() > 0.3).length;
    expect(moving).toBe(1);
  });
});

// -------------------------------------------------------------------- spring
describe("springs and stacks", () => {
  it("spring-mass period matches 2*pi*sqrt(m/k)", () => {
    const w = new World();
    w.gravity = 0.0;
    w.substeps = 8;
    const anchor = body(w, 0, 0, { locked: true });
    const bob = body(w, 1.5, 0, { m: 1.0 }); // stretched 0.5 beyond rest length 1.0
    bob.collides = anchor.collides = false;
    w.links.push(new SpringLink(anchor, bob, 1.0, 25.0));
    const crossings: number[] = [];
    let prev = bob.pos.x - 1.0;
    let t = 0.0;
    while (t < 10.0) {
      w.step(DT);
      t += DT;
      const cur = bob.pos.x - 1.0;
      if (prev < 0 && cur >= 0) crossings.push(t);
      prev = cur;
    }
    const periods = crossings.slice(1).map((b, i) => b - crossings[i]);
    const measured = periods.reduce((a, b) => a + b, 0) / periods.length;
    const exact = 2 * Math.PI * Math.sqrt(1.0 / 25.0);
    expect(Math.abs(measured - exact) / exact).toBeLessThan(0.01);
  });

  it("stacked tower comes to rest (no jitter)", () => {
    const w = new World();
    w.substeps = 8;
    const floor = new Wall(new Vec2(-3, 0), new Vec2(3, 0), 0.12);
    floor.friction = 0.7;
    floor.restitution = 0.05;
    w.walls.push(floor);
    const r = 0.16;
    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 5; row++) {
        const b = body(w, col * (2 * r + 0.01), r + row * (2 * r + 0.005),
                       { r, m: 0.4 });
        b.restitution = 0.1;
        b.friction = 0.6;
      }
    }
    run(w, 4.0);
    const vmax = Math.max(...w.bodies.map((b) => b.vel.length()));
    expect(vmax).toBeLessThan(0.01);
  });

  it("dropped ball rebounds to e^2 of its drop height", () => {
    const w = new World();
    w.substeps = 8;
    const floor = new Wall(new Vec2(-2, 0), new Vec2(2, 0), 0.1);
    floor.restitution = 1.0;
    w.walls.push(floor);
    const b = body(w, 0, 1.0 + 0.15 + 0.05, { r: 0.15 });
    b.restitution = 0.9;
    b.friction = 0.0;
    let peak = 0.0;
    let bounced = false;
    for (let i = 0; i < Math.floor(3.0 / DT); i++) {
      w.step(DT);
      if (b.vel.y > 0) bounced = true;
      if (bounced) peak = Math.max(peak, b.pos.y);
    }
    const rebound = (peak - 0.15 - 0.05) / 1.0;
    expect(Math.abs(rebound - 0.81)).toBeLessThan(0.02);
  });

  it("non-finite body state is contained, not fatal", () => {
    const w = new World();
    const b1 = body(w, Infinity, 0);
    const b2 = body(w, 0, 0);
    run(w, 0.5);
    expect(Number.isFinite(b1.pos.x)).toBe(true);
    expect(Number.isFinite(b2.pos.y)).toBe(true);
  });
});

// ------------------------------------------------------------------- rolling
describe("friction and rolling", () => {
  it("sliding disc settles at exactly (2/3) v0, then rolls without slipping", () => {
    // Coulomb friction + contact torque vs the classic analytic result:
    // a disc sliding at v0 without spin decelerates at mu*g while friction
    // torque spins it up; they meet at exactly v = (2/3) v0.
    const w = new World();
    w.substeps = 8;
    const floor = new Wall(new Vec2(-50, 0), new Vec2(50, 0), 0.12);
    floor.friction = 0.5;
    floor.restitution = 0.0;
    w.walls.push(floor);
    const b = body(w, 0, 0.26, { r: 0.2, m: 1.0, vx: 3.0 });
    b.friction = 0.5;
    b.restitution = 0.0;
    run(w, 3.0); // well past t* = v0/(3 mu g) = 0.204 s
    const vExact = (2.0 / 3.0) * 3.0;
    expect(Math.abs(b.vel.x - vExact) / vExact).toBeLessThan(0.005);
    const roll = Math.abs(-b.omega * b.radius - b.vel.x) / Math.max(b.vel.x, 1e-9);
    expect(roll).toBeLessThan(0.005);
  });

  it("ball rolls down a rough ramp (|omega| r ~ |v|)", () => {
    const w = new World();
    w.substeps = 8;
    const ang = (-20 * Math.PI) / 180;
    const wall = new Wall(new Vec2(0, 0),
                          new Vec2(10 * Math.cos(ang), 10 * Math.sin(ang)), 0.1);
    wall.friction = 1.0;
    wall.restitution = 0.0;
    w.walls.push(wall);
    const n = new Vec2(-Math.sin(ang), Math.cos(ang));
    const start = new Vec2(0.5 * Math.cos(ang), 0.5 * Math.sin(ang))
      .add(n.mul(0.05 + 0.15));
    const b = body(w, start.x, start.y, { r: 0.15, m: 1.0 });
    b.friction = 0.8;
    b.restitution = 0.0;
    run(w, 1.5);
    const speed = b.vel.length();
    const ratio = (Math.abs(b.omega) * b.radius) / Math.max(speed, 1e-9);
    expect(speed).toBeGreaterThan(0.5);
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.3);
  });
});

// ---------------------------------------------------------------- soft bodies
describe("soft bodies", () => {
  it.each([
    "Jelly block", "Squishy ball",
    "Trampoline", "Soft wheel", "Jelly smash",
  ])("preset '%s' stays coherent over 3 s", (name) => {
    const w = preset(name);
    run(w, 3.0);
    const spans = w.bodies.map((b) => Math.abs(b.pos.x) + Math.abs(b.pos.y));
    expect(spans.every((s) => Number.isFinite(s))).toBe(true);
    expect(Math.max(...spans)).toBeLessThan(50.0);
    expect(w.diverged).toHaveLength(0);
  });

  it("soft lattice: internal spring forces conserve momentum", () => {
    const w = new World();
    w.gravity = 0.0;
    w.substeps = 8;
    const bodies: Body[] = [];
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 6; i++) {
        bodies.push(body(w, i * 0.3, j * 0.3, { r: 0.1, m: 0.2, vx: 1.0, vy: 0.5 }));
      }
    }
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 6; i++) {
        const a = bodies[j * 6 + i];
        if (i + 1 < 6) {
          w.links.push(new SpringLink(a, bodies[j * 6 + i + 1], null, 150.0, 0.5));
        }
        if (j + 1 < 5) {
          w.links.push(new SpringLink(a, bodies[(j + 1) * 6 + i], null, 150.0, 0.5));
        }
      }
    }
    const p0 = w.momentum();
    run(w, 5.0);
    const p1 = w.momentum();
    expect(Math.hypot(p1.x - p0.x, p1.y - p0.y)).toBeLessThan(1e-9);
  });

  it("speedCap clamps a body every substep", () => {
    const w = new World();
    w.gravity = 0.0;
    const b = body(w, 0, 0, { vx: 100.0, vy: -40.0 });
    b.collides = false;
    b.speedCap = 5.0;
    w.step(DT);
    expect(Math.hypot(b.vel.x, b.vel.y)).toBeLessThanOrEqual(5.0 + 1e-9);
    b.speedCap = Infinity;
  });

  const whipJelly = (speed: number): { maxSpeed: number; parts: Body[]; w: World } => {
    // Drive one particle round a circle at `speed` m/s while its neighbours
    // simulate under the chase clamp the controller applies. Returns the
    // peak neighbour speed seen and the settled world.
    const w = preset("Jelly block");
    const parts = w.bodies.filter((b) => !b.locked);
    const grab = parts[Math.floor(parts.length / 2)];
    grab.held = true;
    for (const b of parts) if (b !== grab) b.speedCap = 20.0;
    const rr = 0.4;
    const omega = speed / rr;
    const cx = grab.pos.x;
    const cy = grab.pos.y;
    let maxSpeed = 0.0;
    for (let i = 0; i < Math.floor(1.0 / DT); i++) {
      const ang = omega * i * DT;
      grab.pos.set(cx + rr * Math.sin(ang), cy + rr * (1 - Math.cos(ang)));
      grab.vel.set(speed * Math.cos(ang), speed * Math.sin(ang));
      w.step(DT);
      for (const b of parts) {
        if (b !== grab) maxSpeed = Math.max(maxSpeed, Math.hypot(b.vel.x, b.vel.y));
      }
    }
    grab.held = false;
    for (const b of parts) b.speedCap = Infinity;
    run(w, 6.0);
    return { maxSpeed, parts, w };
  };

  it("even a violent jelly whip stays finite and clamp-bounded", () => {
    // Left-dragging a soft body deliberately deforms it (a fast whip may
    // scramble it - that is why the app hints to right-drag instead). The
    // engine's job is only to keep it BOUNDED: never NaN, never past the
    // chase clamp, never a blow-up.
    const { maxSpeed, parts } = whipJelly(30.0);
    expect(parts.every((b) => Number.isFinite(b.pos.x + b.pos.y + b.vel.x + b.vel.y)))
      .toBe(true);
    expect(maxSpeed).toBeLessThanOrEqual(20.0 + 1e-6);
  });

  it("a normal-speed jelly drag jiggles and springs back to shape", () => {
    // At speeds the chase clamp can follow, the lattice deforms then
    // recovers cleanly once released - real link physics, no scramble.
    const { w } = whipJelly(9.0);
    const springs = w.links.filter((ln): ln is SpringLink => ln instanceof SpringLink);
    const worst = Math.max(...springs.map(
      (ln) => Math.abs(ln.a.pos.distTo(ln.b.pos) - ln.restLength) / ln.restLength));
    expect(worst).toBeLessThan(0.25);
  });

  it("pushing a held body into a resting one stays gentle", () => {
    // A slow drag straight into a neighbour: with the capped velocity
    // signal and split-impulse depenetration, the neighbour is nudged
    // aside at roughly the drag speed - never ejected
    const w = new World();
    w.gravity = 0.0;
    const a = body(w, 0, 0, { r: 0.2, m: 1.0 });
    const b = body(w, 0.5, 0, { r: 0.2, m: 1.0 });
    a.held = true;
    const dragSpeed = 0.6; // slow cursor
    for (let i = 0; i < Math.floor(1.0 / DT); i++) {
      a.vel.set(dragSpeed, 0.0);
      a.pos.set(a.pos.x + dragSpeed * DT, 0.0);
      w.step(DT);
    }
    a.held = false;
    // b was pushed away smoothly: comparable to the drag speed, not a fling
    expect(Math.hypot(b.vel.x, b.vel.y)).toBeLessThan(4.0 * dragSpeed);
    expect(b.pos.x).toBeGreaterThan(0.5); // it did get pushed along
  });

  it("dragging a pendulum anchor then stopping lets the bob lunge", () => {
    // Drag an anchor sideways under real link physics, then stop dead: the
    // bob must have built genuine momentum and keep swinging (the "lunge"),
    // not float to a halt with the anchor - and still stay bounded.
    const w = new World();
    w.gravity = 9.81;
    const anchor = body(w, 0, 3, { locked: true });
    const bob = body(w, 0, 2, { r: 0.1, m: 1.0 });
    w.links.push(new DistanceLink(anchor, bob));
    anchor.held = true;
    bob.speedCap = 20.0; // the chase clamp the controller applies
    // sweep the anchor sideways for half a second, then hold it still
    const v = 3.0;
    for (let i = 0; i < Math.floor(0.5 / DT); i++) {
      anchor.pos.set(anchor.pos.x + v * DT, 3.0);
      anchor.vel.set(v, 0.0);
      w.step(DT);
    }
    anchor.vel.set(0.0, 0.0);
    const bobSpeedAtStop = Math.hypot(bob.vel.x, bob.vel.y);
    // the bob carried real momentum from the drag (not floating: well above
    // zero) yet stayed within the clamp
    expect(bobSpeedAtStop).toBeGreaterThan(0.5);
    expect(bobSpeedAtStop).toBeLessThanOrEqual(20.0 + 1e-6);
    // let go: it keeps moving (lunges) rather than freezing in place
    const x0 = bob.pos.x;
    anchor.held = false;
    bob.speedCap = Infinity;
    w.step(DT * 4);
    expect(Math.abs(bob.pos.x - x0)).toBeGreaterThan(1e-3);
  });
});

describe("gravity slingshot", () => {
  it("probe gains speed in a clean flyby behind the planet", () => {
    const w = preset("Gravity slingshot");
    const probe = w.bodies.find((b) => b.name === "Probe")!;
    const planet = w.bodies.find((b) => b.name === "Planet")!;
    const v0 = probe.vel.length();
    let minD = Infinity;
    for (let i = 0; i < 1080; i++) { // 9 s
      w.step(DT);
      minD = Math.min(minD, probe.pos.distTo(planet.pos));
    }
    const v1 = probe.vel.length();
    expect(minD).toBeGreaterThan(1.0);  // a flyby, not a graze or capture
    expect(v1 / v0).toBeGreaterThan(1.3); // leaves at least 30% faster
    expect(probe.vel.x).toBeLessThan(0);  // flung along the planet's motion
    expect(w.diverged).toHaveLength(0);
  });
});

describe("force-field showcase", () => {
  it("Cyclone: formulas compile and the swarm stays bound", () => {
    const w = preset("Cyclone");
    expect(w.fields).toHaveLength(1);
    expect(w.fields[0].error).toBe("");
    run(w, 5.0);
    const spans = w.bodies.map((b) => Math.abs(b.pos.x) + Math.abs(b.pos.y));
    expect(spans.every((s) => Number.isFinite(s))).toBe(true);
    expect(Math.max(...spans)).toBeLessThan(30.0);
    expect(w.diverged).toHaveLength(0);
  });
});

// -------------------------------------------------------------- infrastructure
describe("expression sandbox", () => {
  it("valid force compiles and evaluates", () => {
    const f = compileExpr("-0.5*vx + sin(t)*2");
    const val = f({ x: 0, y: 0, vx: 2.0, vy: 0, t: 0, m: 1, r: 0 });
    expect(Math.abs(val - -1.0)).toBeLessThan(1e-12);
  });

  it("supports ^ as power with paper precedence", () => {
    const f = compileExpr("x^2 + 1");
    expect(f({ x: 3, y: 0, vx: 0, vy: 0, t: 0, m: 1, r: 3 })).toBe(10);
  });

  it("supports Python-style conditionals and comparisons", () => {
    const f = compileExpr("(m > 1) * -0.35 * vx");
    expect(f({ x: 0, y: 0, vx: 2, vy: 0, t: 0, m: 1.001, r: 0 })).toBeCloseTo(-0.7, 12);
    expect(f({ x: 0, y: 0, vx: 2, vy: 0, t: 0, m: 1.0, r: 0 })).toBe(-0);
    const g = compileExpr("1 if x > 0 else -1");
    expect(g({ x: 5, y: 0, vx: 0, vy: 0, t: 0, m: 1, r: 5 })).toBe(1);
    expect(g({ x: -5, y: 0, vx: 0, vy: 0, t: 0, m: 1, r: 5 })).toBe(-1);
  });

  it.each([
    "__import__('os').system('x')",
    "().__class__",
    "x.__dict__",
    "open('f')",
    "[1 for _ in range(9)]",
    "lambda: 1",
    "9**9**9",
    "'a'*99999999",
  ])("rejects: %s", (bad) => {
    expect(() => compileExpr(bad)).toThrow(ExprError);
  });
});

describe("serialization", () => {
  it("all presets serialize round-trip losslessly", () => {
    for (const p of PRESETS) {
      const w = p.build();
      const d1 = w.toDict();
      const w2 = World.fromDict(JSON.parse(JSON.stringify(d1)));
      const d2 = w2.toDict();
      expect(d2, `mismatch in '${p.name}'`).toEqual(JSON.parse(JSON.stringify(d1)));
    }
  });

  it("simulation is deterministic", () => {
    const signature = (): [number, number] => {
      const w = preset("Double pendulum");
      run(w, 3.0);
      const b = w.bodies[w.bodies.length - 1];
      return [b.pos.x, b.pos.y];
    };
    expect(signature()).toEqual(signature());
  });
});
