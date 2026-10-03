import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, PULLEY_RADIUS } from "../src/engine/body";
import { DistanceLink, PulleyLink } from "../src/engine/links";
import { INTEGRATORS, World } from "../src/engine/world";
import { snapshot } from "../src/scene/snapshot";

function assembly(supported: boolean, tip: boolean, mass: number, angle = 0,
                  obliquity = 0, coordinateMass = 0.001, rightArm = 1.5) {
  const world = new World(); world.gravity = 0; world.substeps = 8;
  const centre = new Vec2(13, -7), e = new Vec2(Math.cos(angle), Math.sin(angle));
  const n = new Vec2(Math.sin(angle + obliquity), -Math.cos(angle + obliquity));
  const position = (x: number) => centre.add(e.mul(x));
  const a = new Body(position(-2), 0.04, coordinateMass), b = new Body(position(2), 0.04, coordinateMass);
  a.isRodEndpoint = b.isRodEndpoint = true; a.collides = b.collides = false;
  const beam = new DistanceLink(a, b, 4); world.bodies.push(a, b); world.links.push(beam);
  const loads = [-1.5, rightArm].map(x => {
    const body = new Body(position(x), 0.15, 2); body.collides = false; body.showForceComponents = true;
    body.rodAttachmentId = beam.id; body.rodAttachmentT = (x + 2) / 4;
    world.bodies.push(body); return body;
  });
  if (supported) {
    const pivot = new Body(centre.copy()); pivot.locked = pivot.isAnchor = pivot.isPivot = true;
    pivot.collides = false; pivot.rodAttachmentId = beam.id; pivot.rodAttachmentT = 0.5;
    world.bodies.push(pivot);
  }
  const attachment = tip ? b : loads[1];
  const end = new Body(attachment.pos.add(n.mul(2)), 0.15, mass);
  end.collides = false; end.showForceComponents = true; end.constForce.set(n.x * mass, n.y * mass);
  const rope = new DistanceLink(attachment, end, 2, true);
  world.bodies.push(end); world.links.push(rope);
  // Independent Newton/Euler answer. Equal 2 kg loads have total mass 4 kg.
  // About a fixed pivot I = 2(1.5² + rightArm²); about the free COM
  // I = 4((1.5 + rightArm)/2)². Torque is the force's lever arm times T.
  const origin = supported ? centre : position((rightArm - 1.5) / 2);
  const inertia = supported ? 2 * (1.5 ** 2 + rightArm ** 2) : (1.5 + rightArm) ** 2;
  const r = attachment.pos.sub(origin), cross = r.x * n.y - r.y * n.x;
  const mobility = (supported ? 0 : 0.25) + cross ** 2 / inertia;
  const tension = 1 / (mobility + 1 / mass);
  return { world, beam, loads, attachment, end, rope, n, tension };
}

function pulleyAssembly(mass: number) {
  const model = assembly(true, false, mass), { world, loads, end, rope } = model;
  world.links.splice(world.links.indexOf(rope), 1);
  const wheel = new Body(loads[1].pos.add(new Vec2(1.5, 2)), PULLEY_RADIUS);
  end.pos.setVec(wheel.pos.add(new Vec2(PULLEY_RADIUS, -4))); end.constForce.set(0, -mass);
  const pulley = new PulleyLink(loads[1], end, wheel);
  world.bodies.push(wheel); world.links.push(pulley);
  return { ...model, wheel, pulley };
}

/** Independent six-coordinate Newton/Euler reference for the stress case.
 * theta keeps the beam rigid by construction; no particle projection, hidden
 * endpoint mass, engine force method, or shared linear solver is used here. */
function reducedReference(steps: number): number[] {
  const mass = 1000, arm = 1.5, inertia = 9, ax = Math.sin(0.6), ay = -Math.cos(0.6), dt = 1 / steps;
  let state = [0, 0, arm + 2 * ax, 2 * ay, 0, 0];
  const derivative = (q: number[]): number[] => {
    const [theta, omega, x, y, vx, vy] = q, rx = arm * Math.cos(theta), ry = arm * Math.sin(theta);
    const dx = x - rx, dy = y - ry, distance = Math.hypot(dx, dy), nx = dx / distance, ny = dy / distance;
    const rvx = vx + omega * ry, rvy = vy - omega * rx, normalSpeed = nx * rvx + ny * rvy;
    const lever = rx * ny - ry * nx;
    const tension = (nx * ax + ny * ay + omega ** 2 * (rx * nx + ry * ny) +
      (rvx ** 2 + rvy ** 2 - normalSpeed ** 2) / distance) / (lever ** 2 / inertia + 1 / mass);
    if (!(tension > 0)) throw new Error("Reference string became slack");
    return [omega, tension * lever / inertia, vx, vy, ax - tension * nx / mass, ay - tension * ny / mass];
  };
  for (let i = 0; i < steps; i++) {
    const a = derivative(state), b = derivative(state.map((value, j) => value + dt * a[j] / 2));
    const c = derivative(state.map((value, j) => value + dt * b[j] / 2));
    const d = derivative(state.map((value, j) => value + dt * c[j]));
    state = state.map((value, j) => value + dt * (a[j] + 2 * b[j] + 2 * c[j] + d[j]) / 6);
  }
  return state;
}

function stringForce(body: Body): number {
  return body.forceSnapshot!.entries.filter(f => f.kind === "string")
    .reduce((sum, f) => sum + Math.hypot(f.fx, f.fy), 0);
}

describe("loaded rod and external string equations of motion", () => {
  for (const supported of [false, true]) for (const tip of [false, true]) {
    for (const mass of [1, 1000]) for (const angle of [0, 0.7]) for (const obliquity of [0, 0.6]) {
      it(`matches Newton/Euler: supported=${supported}, tip=${tip}, m=${mass}, angle=${angle}, obliquity=${obliquity}`, () => {
        const { world, end, n, tension } = assembly(supported, tip, mass, angle, obliquity);
        const before = snapshot(world), forces = world.currentForceSnapshot(end)!;
        const actual = forces.entries.filter(f => f.kind === "string")
          .reduce((sum, f) => sum + Math.hypot(f.fx, f.fy), 0);
        expect(actual).toBeCloseTo(tension, 9);
        expect(forces.fx / mass).toBeCloseTo(n.x * (1 - tension / mass), 9);
        expect(forces.fy / mass).toBeCloseTo(n.y * (1 - tension / mass), 9);
        expect(snapshot(world)).toBe(before);
      });
    }
  }

  it.each([1e-9, 0.001, 1, 1e6])("excludes internal coordinate mass %s from rod-tip inertia", coordinateMass => {
    const { world, end, tension } = assembly(true, true, 1000, 0.7, 0.6, coordinateMass);
    const force = world.currentForceSnapshot(end)!.entries.find(f => f.kind === "string")!;
    expect(Math.hypot(force.fx, force.fy)).toBeCloseTo(tension, 9);
  });

  it.each([0.001, 0.01, 0.75])("retains the physical response with a %s m lever arm", rightArm => {
    const { world, end, tension } = assembly(true, false, 1000, 0, 0, 0.001, rightArm);
    expect(world.currentForceSnapshot(end)!.entries.find(f => f.kind === "string")!.fy).toBeCloseTo(tension, 7);
  });

  for (const integrator of INTEGRATORS) for (const tip of [false, true]) {
    it(`retains the force answer through a complete ${integrator} frame (tip=${tip})`, () => {
      const { world, end, n, tension } = assembly(true, tip, 1000, 0.7, 0.6);
      world.integrator = integrator; world.step(1e-5);
      expect(stringForce(end)).toBeCloseTo(tension, 5);
      expect(end.vel.x / world.time).toBeCloseTo(n.x * (1 - tension / end.mass), 5);
      expect(end.vel.y / world.time).toBeCloseTo(n.y * (1 - tension / end.mass), 5);
    });
  }

  for (const mass of [1, 10]) for (const tip of [false, true]) {
    it(`retains length and work-energy over one second (m=${mass}, tip=${tip})`, () => {
      const { world, beam, end, attachment, rope } = assembly(true, tip, mass, 0.7, 0.6);
      const start = end.pos.copy(), energy = world.energy().total;
      for (let i = 0; i < 120; i++) {
        world.step(1 / 120);
        expect(Math.max(0, attachment.pos.distTo(end.pos) - rope.length)).toBeLessThan(1e-9);
        expect(beam.a.pos.distTo(beam.b.pos)).toBeCloseTo(4, 9);
      }
      const work = end.constForce.dot(end.pos.sub(start));
      expect(Math.abs(world.energy().total - energy - work) / Math.abs(work)).toBeLessThan(1e-6);
    });
  }

  it.each([0, 1, 2, 3])("retains bounded rigid geometry in Performance tier %s", level => {
    const { world, beam, end, attachment, rope } = assembly(true, true, 10, 0.7, 0.6);
    world.performance = true; world.performanceLevel = level;
    for (let i = 0; i < 120; i++) {
      world.step(1 / 120);
      expect(beam.a.pos.distTo(beam.b.pos)).toBeCloseTo(4, 8);
      expect(Math.max(0, attachment.pos.distTo(end.pos) - rope.length)).toBeLessThan(1e-8);
      expect([end.pos.x, end.pos.y, end.vel.x, end.vel.y].every(Number.isFinite)).toBe(true);
    }
  });

  it.each([[1, 1000], [1000, 1000], [0.001, 1e6]])("couples two ropes with partner masses %s and %s", (massA, massB) => {
    const { world, end, loads, rope } = assembly(true, false, massA);
    const other = new Body(loads[0].pos.add(new Vec2(0, 2)), 0.15, massB);
    other.collides = false; other.showForceComponents = true; other.constForce.set(0, massB);
    const second = new DistanceLink(loads[0], other, 2, true);
    world.bodies.push(other); world.links.push(second);
    // Both strings turn the beam in the same direction. Each load therefore
    // has acceleration magnitude (T_A+T_B)/4; Newton's equations give
    // T_i = m_i / (1+(m_A+m_B)/4), not two isolated tension answers.
    const divisor = 1 + (massA + massB) / 4;
    world.currentForceSnapshot(end, [other]);
    const a = world.currentForceSnapshot(end)!.entries.find(f => f.kind === "string")!;
    const b = world.currentForceSnapshot(other)!.entries.find(f => f.kind === "string")!;
    expect(Math.hypot(a.fx, a.fy)).toBeCloseTo(massA / divisor, 8);
    expect(Math.hypot(b.fx, b.fy)).toBeCloseTo(massB / divisor, 8);
    expect(rope.mu).toBe(0); expect(second.mu).toBe(0); // Pure preview.
  });

  it.each([1, 10, 1000])("uses physical rod inertia for a pulley leg (partner mass=%s)", mass => {
    const { world, loads, end, pulley } = pulleyAssembly(mass);
    const geometry = pulley.geometry();
    // The loaded beam can rotate but its contact point cannot translate
    // horizontally. A's path response is n_Ay²/4; B is a free mass.
    const tension = -geometry.nby / (geometry.nay ** 2 / 4 + 1 / mass);
    const force = world.currentForceSnapshot(end)!.entries.find(f => f.kind === "pulley")!;
    expect(Math.hypot(force.fx, force.fy)).toBeCloseTo(tension, 8);
    const onBeam = world.currentForceSnapshot(loads[1])!;
    expect(onBeam.fx).toBeCloseTo(0, 8);
    expect(onBeam.fy / 2).toBeCloseTo(-tension * geometry.nay / 4, 8);
  });
  it.each([[1, 1000], [1000, 1000], [0.001, 1e6]])("couples a rod's pulley and direct string (masses=%s,%s)", (massA, massB) => {
    const { world, loads, end, pulley } = pulleyAssembly(massB);
    const other = new Body(loads[0].pos.add(new Vec2(0, -2)), 0.15, massA);
    other.collides = false; other.showForceComponents = true; other.constForce.set(0, -massA);
    world.bodies.push(other); world.links.push(new DistanceLink(loads[0], other, 2, true));
    const g = pulley.geometry();
    const routedAcceleration = -g.nay / -g.nby;
    end.constForce.set(0, -massB * routedAcceleration);
    // Invert the independent two-row Newton/Euler equations.
    const aa = 0.25 + 1 / massA, bb = g.nay ** 2 / 4 + 1 / massB, ab = -g.nay / 4;
    const determinant = aa * bb - ab * ab;
    const directTension = (bb + ab * g.nby * routedAcceleration) / determinant;
    const pulleyTension = (-aa * g.nby * routedAcceleration - ab) / determinant;
    const direct = world.currentForceSnapshot(other)!, routed = world.currentForceSnapshot(end)!;
    expect(Math.hypot(...[direct.entries.find(f => f.kind === "string")!.fx,
      direct.entries.find(f => f.kind === "string")!.fy])).toBeCloseTo(directTension, 8);
    expect(Math.hypot(routed.entries.find(f => f.kind === "pulley")!.fx,
      routed.entries.find(f => f.kind === "pulley")!.fy)).toBeCloseTo(pulleyTension, 8);
  });

  for (const integrator of INTEGRATORS) for (const mass of [1, 1000]) {
    it(`keeps the pulley/beam acceleration through ${integrator} (m=${mass})`, () => {
      const { world, end, loads, pulley } = pulleyAssembly(mass), g = pulley.geometry();
      const tension = -g.nby / (g.nay ** 2 / 4 + 1 / mass);
      world.integrator = integrator; world.step(1e-3);
      expect(end.vel.y / world.time).toBeCloseTo(-1 - tension * g.nby / mass, 5);
      expect(loads[1].vel.y / world.time).toBeCloseTo(-tension * g.nay / 4, 5);
      expect(pulley.currentLength()).toBeLessThanOrEqual(pulley.length + 1e-9);
    });
  }

  for (const mass of [1, 10]) {
    it(`keeps a rod-connected pulley rigid and conserves work-energy for a second (m=${mass})`, () => {
      const { world, beam, end, pulley } = pulleyAssembly(mass);
      const start = end.pos.copy(), energy = world.energy().total;
      for (let i = 0; i < 120; i++) {
        world.step(1 / 120);
        expect(Math.max(0, pulley.currentLength() - pulley.length)).toBeLessThan(1e-8);
        expect(beam.a.pos.distTo(beam.b.pos)).toBeCloseTo(4, 9);
      }
      const work = end.constForce.dot(end.pos.sub(start));
      expect(Math.abs(world.energy().total - energy - work) / Math.abs(work)).toBeLessThan(1e-5);
    });
  }

  it.each([1, 10, 1000])("balances a mounted pulley load when the free leg reaches its wheel stop (m=%s)", mass => {
    const { world, loads, end, wheel, pulley } = pulleyAssembly(mass);
    end.pos.set(wheel.pos.x + PULLEY_RADIUS, wheel.pos.y -
      Math.sqrt((PULLEY_RADIUS + end.radius) ** 2 - PULLEY_RADIUS ** 2));
    end.constForce.set(0, 0); loads[1].constForce.set(0, -2);
    pulley.length = pulley.currentLength();
    const g = pulley.geometry(), tension = -2 / g.nay;
    const onBeam = world.currentForceSnapshot(loads[1])!, onStop = world.currentForceSnapshot(end)!;
    expect(Math.hypot(onBeam.entries.find(f => f.kind === "pulley")!.fx,
      onBeam.entries.find(f => f.kind === "pulley")!.fy)).toBeCloseTo(tension, 8);
    expect(onBeam.fx).toBeCloseTo(0, 8); expect(onBeam.fy).toBeCloseTo(0, 8);
    expect(onStop.fx).toBeCloseTo(0, 8); expect(onStop.fy).toBeCloseTo(0, 8);
    world.step(1e-3);
    expect(end.vel.length()).toBeLessThan(1e-8); expect(loads[1].vel.length()).toBeLessThan(1e-8);
  });

  it.each([1, 10, 1000])("transmits guide support through a beam rather than bending it (m=%s)", mass => {
    const { world, loads, end, wheel, pulley } = pulleyAssembly(mass);
    wheel.pos.setVec(loads[1].pos.add(new Vec2(2, 0)));
    end.pos.setVec(wheel.pos.add(new Vec2(PULLEY_RADIUS, -4)));
    pulley.captureSafePositions(); pulley.length = pulley.currentLength();
    const current = world.currentForceSnapshot(loads[1])!;
    expect(current.fx).toBeCloseTo(0, 8); expect(current.fy).toBeCloseTo(0, 8);
    const force = current.entries.find(f => f.kind === "pulley")!;
    expect(Math.hypot(force.fx, force.fy)).toBeCloseTo(mass, 8);
    world.step(1e-3);
    expect(loads[1].vel.length()).toBeLessThan(1e-8); expect(end.vel.length()).toBeLessThan(1e-8);
    expect(pulley.branchDistance("a")).toBeGreaterThanOrEqual(-1e-10);
  });

  it.each([0, 1, 2, 3])("keeps mounted pulley geometry bounded in Performance tier %s", level => {
    const { world, beam, pulley, end } = pulleyAssembly(10);
    world.performance = true; world.performanceLevel = level;
    for (let i = 0; i < 120; i++) {
      world.step(1 / 120);
      expect(Math.max(0, pulley.currentLength() - pulley.length)).toBeLessThan(1e-8);
      expect(beam.a.pos.distTo(beam.b.pos)).toBeCloseTo(4, 8);
      expect([end.pos.x, end.pos.y, end.vel.x, end.vel.y].every(Number.isFinite)).toBe(true);
    }
  });

  it.each([1, 1000])("retains rigid velocities and cannot create energy at string retension (m=%s)", mass => {
    const { world, loads, end, beam, pulley } = pulleyAssembly(mass);
    end.constForce.set(0, 0); end.vel.set(0, -1);
    const energy = world.energy().total;
    world.step(1e-4);
    const omega = (beam.b.vel.y - beam.a.vel.y) / beam.length;
    expect(loads[1].vel.x).toBeCloseTo(-omega * (loads[1].pos.y - (loads[0].pos.y + loads[1].pos.y) / 2), 8);
    expect(loads[1].vel.y).toBeCloseTo(omega * (loads[1].pos.x - (loads[0].pos.x + loads[1].pos.x) / 2), 8);
    expect(pulley.currentLength()).toBeLessThanOrEqual(pulley.length + 1e-8);
    expect(world.energy().total).toBeLessThanOrEqual(energy + 1e-8);
  });

  it("resolves a heavy partner's nearly aligned string against an independent reduced-coordinate reference", () => {
    const { world, beam, end, rope } = assembly(true, false, 1000, 0, 0.6);
    // Six-coordinate Newton/Euler integration at 30,000 and 60,000 Hz agrees
    // within 4e-11 per coordinate. The independent reference keeps the beam
    // rigid by theta, and never uses endpoint XPBD or this engine's matrices.
    const reference = [-0.8126518293759479, 2.815228086224109, -1.9935065309119027,
      -0.8503257931016732, 0.16815008856055916];
    const start = end.pos.copy(), energy = world.energy().total;
    for (let i = 0; i < 120; i++) {
      world.step(1 / 120);
      expect(rope.mu).toBeGreaterThan(0);
    }
    expect(Math.atan2(beam.b.pos.y - beam.a.pos.y, beam.b.pos.x - beam.a.pos.x)).toBeCloseTo(reference[0], 4);
    expect(end.pos.x - 13).toBeCloseTo(reference[1], 4);
    expect(end.pos.y + 7).toBeCloseTo(reference[2], 4);
    expect(end.vel.x).toBeCloseTo(reference[3], 4); expect(end.vel.y).toBeCloseTo(reference[4], 4);
    const work = end.constForce.dot(end.pos.sub(start));
    expect(Math.abs(world.energy().total - energy - work) / work).toBeLessThan(1e-5);
  });

  it.each(INTEGRATORS)("keeps actual slack strings force-free through %s trial stages", integrator => {
    const { world, end, rope, loads } = assembly(true, false, 1000);
    rope.length += 0.5; world.integrator = integrator;
    expect(world.currentForceSnapshot(end)!.entries.filter(f => f.kind === "string")).toEqual([]);
    world.step(1 / 120);
    expect(rope.mu).toBe(0); expect(stringForce(end)).toBe(0);
    expect(loads[1].vel.length()).toBeCloseTo(0, 10);
    expect(end.vel.y).toBeCloseTo(-world.time, 10);
  });

  it.each(INTEGRATORS)("releases a taut string instead of pushing when its load reverses (%s)", integrator => {
    const { world, end, rope, loads, n } = assembly(true, false, 1000);
    world.integrator = integrator; end.constForce.set(-n.x * end.mass, -n.y * end.mass);
    world.step(1 / 120);
    expect(rope.mu).toBe(0); expect(stringForce(end)).toBe(0);
    expect(loads[1].vel.length()).toBeCloseTo(0, 10);
    expect(end.pos.distTo(loads[1].pos)).toBeLessThan(rope.length);
  });

  it("skips adaptive force sampling in every Performance tier", () => {
    for (const level of [0, 1, 2, 3]) {
      const { world } = assembly(true, false, 1000, 0, 0.6);
      world.performance = true; world.performanceLevel = level;
      const engine = world as unknown as { coupledConstraintSlice: (h: number) => number };
      engine.coupledConstraintSlice = () => { throw new Error("Unexpected accurate-mode refinement"); };
      world.step(1 / 120);
    }
  });

  it("reproduces and converges the independent heavy-load reference", () => {
    const coarse = reducedReference(30_000), fine = reducedReference(60_000);
    for (let i = 0; i < fine.length; i++) expect(Math.abs(coarse[i] - fine[i])).toBeLessThan(5e-11);
    expect(fine[0]).toBeCloseTo(-0.8126518293759479, 10);
    expect(fine[2]).toBeCloseTo(2.815228086224109, 10);
    expect(fine[3]).toBeCloseTo(-1.9935065309119027, 10);
  });

});
