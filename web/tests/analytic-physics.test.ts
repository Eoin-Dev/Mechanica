/** The engine against closed-form answers it has not been checked against.
 *
 * The existing suite already pins the pendulum period, the spring period,
 * the elastic-collision velocities, the (2/3)v0 rolling result and orbital
 * energy. What it does not do is check the RESULTS that follow from those
 * laws once they interact: terminal velocity (drag against gravity),
 * Kepler's third law (period against orbit size), the vis-viva relation
 * (speed against radius), an inclined plane (gravity against friction), the
 * projectile range formula, and the damped-oscillator envelope.
 *
 * These are the checks that tell you the engine is RIGHT rather than merely
 * stable: a simulation can conserve energy beautifully and still put the
 * planet in the wrong place.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { SpringLink } from "../src/engine/links";
import { World } from "../src/engine/world";

const DT = 1 / 120;
const G_EARTH = 9.81;

function run(w: World, seconds: number): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) w.step(DT);
}

describe("drag against gravity: terminal velocity", () => {
  it("linear drag settles at v = mg/c", () => {
    // m dv/dt = mg - c v  =>  v_terminal = mg/c
    for (const [m, c] of [[1, 2], [2.5, 3], [0.4, 0.9]] as const) {
      const w = new World();
      w.substeps = 8;
      w.dragLinear = c;
      const b = new Body(new Vec2(0, 0), 0.1, m);
      b.collides = false;
      w.bodies.push(b);
      run(w, 30); // many time constants (tau = m/c)
      expect(-b.vel.y, `m=${m} c=${c}`).toBeCloseTo((m * G_EARTH) / c, 3);
    }
  });

  it("quadratic drag settles at v = sqrt(mg/c)", () => {
    // m dv/dt = mg - c v^2  =>  v_terminal = sqrt(mg/c)
    for (const [m, c] of [[1, 0.5], [3, 2], [0.8, 1.5]] as const) {
      const w = new World();
      w.substeps = 8;
      w.dragQuadratic = c;
      const b = new Body(new Vec2(0, 0), 0.1, m);
      b.collides = false;
      w.bodies.push(b);
      run(w, 40);
      expect(-b.vel.y, `m=${m} c=${c}`)
        .toBeCloseTo(Math.sqrt((m * G_EARTH) / c), 2);
    }
  });

  it("approaches terminal velocity on the analytic exponential", () => {
    // v(t) = v_t (1 - e^(-t/tau)), tau = m/c
    const m = 1;
    const c = 2;
    const w = new World();
    w.substeps = 8;
    w.dragLinear = c;
    const b = new Body(new Vec2(0, 0), 0.1, m);
    b.collides = false;
    w.bodies.push(b);
    const vT = (m * G_EARTH) / c;
    const tau = m / c;
    for (const t of [0.25, 0.5, 1.0, 2.0]) {
      const wq = new World();
      wq.substeps = 8;
      wq.dragLinear = c;
      const bq = new Body(new Vec2(0, 0), 0.1, m);
      bq.collides = false;
      wq.bodies.push(bq);
      run(wq, t);
      expect(-bq.vel.y, `t=${t}`).toBeCloseTo(vT * (1 - Math.exp(-t / tau)), 2);
    }
  });
});

/** A star heavy enough that the orbiter does not move it. */
function orbitWorld(): { w: World; M: number } {
  const w = new World();
  w.gravity = 0;
  w.mutualGravity = true;
  w.G = 1;
  w.softening = 0;
  w.substeps = 12;
  const M = 4000;
  const sun = new Body(new Vec2(0, 0), 0.2, M);
  sun.locked = true;
  sun.collides = false;
  w.bodies.push(sun);
  return { w, M };
}

describe("orbital mechanics", () => {
  it("obeys Kepler's third law: T^2 proportional to a^3", () => {
    // T = 2*pi*sqrt(a^3 / GM) for a circular orbit
    const periods: Array<[number, number]> = [];
    for (const r of [3, 5, 8]) {
      const { w, M } = orbitWorld();
      const p = new Body(new Vec2(r, 0), 0.05, 1e-4);
      p.collides = false;
      p.vel.set(0, Math.sqrt(M / r)); // circular speed, G = 1
      w.bodies.push(p);
      const analytic = 2 * Math.PI * Math.sqrt(r ** 3 / M);
      // Time one revolution by the upward crossing of y = 0, ignoring
      // crossings before half a period (the body STARTS on y = 0). The
      // threshold has to scale with the orbit: a fixed "after 1 second"
      // guard skipped the first crossing entirely on the small orbits,
      // whose whole period is half a second, and measured exactly two.
      let t = 0;
      let prevY = p.pos.y;
      let period = 0;
      for (let i = 0; i < 400_000 && period === 0; i++) {
        w.step(DT);
        t += DT;
        if (t > analytic * 0.5 && prevY < 0 && p.pos.y >= 0) {
          // interpolate to the exact crossing rather than the step after it
          period = t - DT * (p.pos.y / (p.pos.y - prevY));
        }
        prevY = p.pos.y;
      }
      expect(period, `r=${r}`).toBeGreaterThan(0);
      periods.push([r, period]);
      expect(period / analytic, `r=${r}`).toBeCloseTo(1, 2);
    }
    // and the ratio T^2/a^3 is the same constant for all of them
    const k = periods.map(([r, T]) => (T * T) / r ** 3);
    for (const v of k) expect(v / k[0]).toBeCloseTo(1, 2);
  });

  it("obeys the vis-viva relation on an elliptical orbit", () => {
    // v^2 = GM (2/r - 1/a); launched slower than circular, so a < r0
    const { w, M } = orbitWorld();
    const r0 = 6;
    const p = new Body(new Vec2(r0, 0), 0.05, 1e-4);
    p.collides = false;
    const vCirc = Math.sqrt(M / r0);
    p.vel.set(0, vCirc * 0.8);
    w.bodies.push(p);
    // specific orbital energy fixes the semi-major axis: a = 1/(2/r - v^2/GM)
    const v0 = p.vel.length();
    const a = 1 / (2 / r0 - (v0 * v0) / M);
    for (let i = 0; i < 12_000; i++) {
      w.step(DT);
      if (i % 400 === 0) {
        const r = p.pos.length();
        const v2 = p.vel.length2();
        expect(v2 / (M * (2 / r - 1 / a)), `step ${i}`).toBeCloseTo(1, 2);
      }
    }
  });

  it("sweeps equal areas in equal times (Kepler's second law)", () => {
    const { w, M } = orbitWorld();
    const p = new Body(new Vec2(6, 0), 0.05, 1e-4);
    p.collides = false;
    p.vel.set(0, Math.sqrt(M / 6) * 0.75); // eccentric, so r really varies
    w.bodies.push(p);
    const areas: number[] = [];
    let swept = 0;
    let prev = p.pos.copy();
    for (let i = 0; i < 9000; i++) {
      w.step(DT);
      // triangle swept from the focus: |r x dr| / 2
      swept += Math.abs(prev.x * p.pos.y - prev.y * p.pos.x) * 0.5;
      prev = p.pos.copy();
      if ((i + 1) % 1500 === 0) { areas.push(swept); swept = 0; }
    }
    const rMin = Math.min(...areas);
    const rMax = Math.max(...areas);
    expect(areas.length).toBe(6);
    expect((rMax - rMin) / rMax).toBeLessThan(0.02);
  });

  it("conserves angular momentum in a central force", () => {
    const { w } = orbitWorld();
    const p = new Body(new Vec2(6, 0), 0.05, 1e-4);
    p.collides = false;
    p.vel.set(0, 20);
    w.bodies.push(p);
    const L = () => p.mass * (p.pos.x * p.vel.y - p.pos.y * p.vel.x);
    const L0 = L();
    for (let i = 0; i < 20_000; i++) w.step(DT);
    expect(L() / L0).toBeCloseTo(1, 4);
  });
});

describe("gravity against friction: the inclined plane", () => {
  it("accelerates at g(sin θ − μ cos θ) down a rough slope", () => {
    for (const [deg, mu] of [[30, 0.2], [40, 0.1], [25, 0.15]] as const) {
      const th = (deg * Math.PI) / 180;
      const w = new World();
      w.substeps = 16;
      w.iterations = 24;
      // a long ramp descending to the right
      const len = 40;
      const ramp = new Wall(new Vec2(-len * Math.cos(th), len * Math.sin(th)),
                            new Vec2(len * Math.cos(th), -len * Math.sin(th)), 0.2);
      ramp.friction = mu;
      ramp.restitution = 0;
      w.walls.push(ramp);
      const b = new Body(new Vec2(0, 0.2 / 2 + 0.2), 0.2, 1);
      b.noRotation = true; // slide, do not roll: this is the block result
      b.friction = mu;
      b.restitution = 0;
      // seat it exactly on the surface
      b.pos.set(0, 0.1 + 0.2);
      w.bodies.push(b);
      run(w, 1.0); // let it settle onto the ramp and start moving
      const v0 = b.vel.copy();
      run(w, 1.0);
      const along = (v: Vec2): number => v.x * Math.cos(th) - v.y * Math.sin(th);
      const measured = along(b.vel) - along(v0);
      const analytic = G_EARTH * (Math.sin(th) - mu * Math.cos(th)) * 1.0;
      expect(measured / analytic, `${deg}deg mu=${mu}`).toBeCloseTo(1, 1);
    }
  });
});

describe("projectiles", () => {
  it("lands at the analytic range R = v^2 sin(2θ)/g", () => {
    for (const [v0, deg] of [[12, 45], [9, 30], [15, 60]] as const) {
      const th = (deg * Math.PI) / 180;
      const w = new World();
      w.substeps = 8;
      const b = new Body(new Vec2(0, 0), 0.05, 1);
      b.collides = false;
      b.vel.set(v0 * Math.cos(th), v0 * Math.sin(th));
      w.bodies.push(b);
      // Fly until it returns to launch height, then interpolate to the
      // exact crossing. Taking the position of the step AFTER the crossing
      // overshoots by one step of horizontal travel - 0.065 m here, which
      // is 0.9% of the range and swamps the tolerance being tested.
      let prevY = b.pos.y;
      let prevX = b.pos.x;
      let x = 0;
      for (let i = 0; i < 200_000; i++) {
        w.step(DT);
        if (prevY > 0 && b.pos.y <= 0) {
          const frac = prevY / (prevY - b.pos.y);
          x = prevX + frac * (b.pos.x - prevX);
          break;
        }
        prevY = b.pos.y;
        prevX = b.pos.x;
      }
      const analytic = (v0 * v0 * Math.sin(2 * th)) / G_EARTH;
      expect(x / analytic, `v=${v0} ${deg}deg`).toBeCloseTo(1, 2);
    }
  });

  it("peaks at the analytic height H = (v sinθ)^2 / 2g", () => {
    const v0 = 14;
    const th = Math.PI / 3;
    const w = new World();
    w.substeps = 8;
    const b = new Body(new Vec2(0, 0), 0.05, 1);
    b.collides = false;
    b.vel.set(v0 * Math.cos(th), v0 * Math.sin(th));
    w.bodies.push(b);
    let peak = 0;
    for (let i = 0; i < 100_000; i++) {
      w.step(DT);
      if (b.pos.y > peak) peak = b.pos.y;
      if (b.vel.y < 0 && b.pos.y < peak - 0.5) break;
    }
    expect(peak).toBeCloseTo((v0 * Math.sin(th)) ** 2 / (2 * G_EARTH), 1);
  });
});

describe("collisions between unequal masses", () => {
  it("matches the restitution definition exactly", () => {
    // e = -(v1' - v2') / (v1 - v2)
    for (const [m1, m2, e] of [[1, 3, 0.8], [5, 1, 0.5], [2, 2, 0.9]] as const) {
      const w = new World();
      w.gravity = 0;
      w.substeps = 8;
      const a = new Body(new Vec2(-1, 0), 0.2, m1);
      const b = new Body(new Vec2(1, 0), 0.2, m2);
      a.restitution = e;
      b.restitution = e;
      a.friction = 0;
      b.friction = 0;
      a.vel.set(4, 0);
      b.vel.set(-1, 0);
      const approach = a.vel.x - b.vel.x;
      w.bodies.push(a, b);
      run(w, 2);
      const separation = b.vel.x - a.vel.x;
      expect(separation / approach, `m ${m1}/${m2} e=${e}`).toBeCloseTo(e, 1);
    }
  });

  it("conserves momentum exactly through an unequal collision", () => {
    const w = new World();
    w.gravity = 0;
    w.substeps = 8;
    const a = new Body(new Vec2(-1, 0), 0.2, 1);
    const b = new Body(new Vec2(1, 0), 0.3, 7);
    a.friction = b.friction = 0;
    a.vel.set(6, 0);
    w.bodies.push(a, b);
    const p0 = w.momentum().x;
    run(w, 3);
    expect(w.momentum().x).toBeCloseTo(p0, 6);
  });

  it("leaves the centre of mass moving at constant velocity", () => {
    // no external force, so the COM must not accelerate at all
    const w = new World();
    w.gravity = 0;
    w.mutualGravity = true;
    w.G = 2;
    w.substeps = 8;
    for (let i = 0; i < 4; i++) {
      const b = new Body(new Vec2(i * 0.8 - 1.2, (i % 2) * 0.6), 0.15, 1 + i);
      b.vel.set(0.3 * i - 0.4, 0.2);
      w.bodies.push(b);
    }
    const com0 = w.centreOfMass()!;
    const p = w.momentum();
    const mTotal = w.bodies.reduce((s, b) => s + b.mass, 0);
    const vCom = new Vec2(p.x / mTotal, p.y / mTotal);
    run(w, 5);
    const com = w.centreOfMass()!;
    expect(com.x).toBeCloseTo(com0.x + vCom.x * 5, 3);
    expect(com.y).toBeCloseTo(com0.y + vCom.y * 5, 3);
  });
});

describe("the damped oscillator", () => {
  it("decays on the analytic envelope and at the damped frequency", () => {
    // m x'' = -k x - c x'  =>  envelope e^(-gamma t), omega_d = sqrt(w0^2 - gamma^2)
    const m = 1;
    const k = 40;
    const c = 0.4;
    const w = new World();
    w.gravity = 0;
    w.substeps = 8;
    const anchor = new Body(new Vec2(0, 0), 0.05, 1);
    anchor.isAnchor = true;
    anchor.locked = true;
    const bob = new Body(new Vec2(1.5, 0), 0.05, m);
    bob.collides = false;
    w.bodies.push(anchor, bob);
    const rest = 1.0;
    const spring = new SpringLink(anchor, bob, rest, k, c);
    w.links.push(spring);
    expect(spring.kEff).toBeCloseTo(k, 9); // not clamped, so the maths applies
    expect(spring.cEff).toBeCloseTo(c, 9);

    const A0 = 0.5; // initial extension
    const gamma = c / (2 * m);
    const omega0 = Math.sqrt(k / m);
    const omegaD = Math.sqrt(omega0 * omega0 - gamma * gamma);

    // peak amplitudes over time must follow A0 * e^(-gamma t)
    let lastX = bob.pos.x;
    let rising = false;
    const peaks: Array<[number, number]> = [];
    for (let i = 0; i < Math.round(6 / DT); i++) {
      w.step(DT);
      const x = bob.pos.x - rest;
      if (rising && x < lastX) peaks.push([(i + 1) * DT, lastX]);
      rising = x > lastX;
      lastX = x;
    }
    expect(peaks.length).toBeGreaterThan(4);
    for (const [t, amp] of peaks.slice(0, 5)) {
      expect(amp / (A0 * Math.exp(-gamma * t)), `t=${t.toFixed(2)}`)
        .toBeCloseTo(1, 1);
    }
    // and the spacing of the peaks is the damped period
    const gaps = peaks.slice(1, 5).map((p, i) => p[0] - peaks[i][0]);
    for (const gap of gaps) {
      expect(gap).toBeCloseTo((2 * Math.PI) / omegaD, 1);
    }
  });
});
