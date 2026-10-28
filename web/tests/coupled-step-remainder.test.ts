import { expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { DistanceLink, PulleyLink } from "../src/engine/links";
import { INTEGRATORS } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";

// Independent theta,x,y Newton/Euler integration with differentiated geometric
// path length, constant diagonal generalized mass and adaptive step doubling.
// Tightening its tolerance from 1e-10 to 1e-12 agrees to <2e-8 per coordinate;
// no engine force solver, body projection or engine curvature formula is used.
const REFERENCE: Record<number, readonly number[]> = {
  1000: [-2.930467952429353, .049683609752829004, -.26223135046219953,
    -2.57111358150633, 1.0616441644228956, 4.203200584028122],
  1000000: [-2.9390151515297966, .05121851442110228, -.24824997237893234,
    -2.5600732189495052, 1.0654092257508347, 4.177384070613309],
};

it.each(INTEGRATORS.flatMap(integrator => [
  [integrator, 1000, false, false], [integrator, 1000, true, true],
  [integrator, 1e6, false, true], [integrator, 1e6, true, false],
] as const))("cannot create energy in a feasible heavy pulley/beam (%s, mass=%s, diagrams=%s, authored arithmetic=%s)",
  (integrator, mass, diagrams, arithmetic) => {
    const world = PRESETS.find(preset => preset.name === "Balanced beam")!.build();
    world.integrator = integrator;
    for (const body of world.bodies) body.showForceComponents = diagrams;
    const beam = world.links[0] as DistanceLink;
    const mounted = new Body(new Vec2(-1.7, 0), .15, 1);
    mounted.collides = false; mounted.rodAttachmentId = beam.id; mounted.rodAttachmentT = .075;
    const wheel = new Body(new Vec2(.3, 2.5));
    // Equivalent authored positions differ by a rounding bit; neither may
    // manufacture a physical impulse from a tiny adaptive remainder.
    const free = new Body(arithmetic ? wheel.pos.add(new Vec2(-.55, -1.8)) : new Vec2(-.25, .7), .15, mass);
    free.collides = false; free.showForceComponents = mounted.showForceComponents = diagrams;
    const pulley = new PulleyLink(free, mounted, wheel);
    world.bodies.push(free, mounted, wheel); world.links.push(pulley);
    expect(pulley.branchDistance("a")).toBeGreaterThan(0); expect(pulley.branchDistance("b")).toBeGreaterThan(0);
    expect(pulley.currentLength()).toBe(pulley.length);
    // Independent point-mass energy, excluding massless solver coordinates
    // and the fixed supports. No external force, driver, damping or contact
    // can do positive work. A wheel stop may only dissipate kinetic energy.
    const energy = () => world.bodies.filter(body => !body.locked && !body.isRodEndpoint)
      .reduce((sum, body) => sum + .5 * body.mass * body.vel.length2() + body.mass * world.gravity * body.pos.y, 0);
    expect(world.bodies.every(body => body.constForce.length2() === 0 && body.omega === 0)).toBe(true);
    expect(world.fields).toHaveLength(0); expect(world.drivers).toHaveLength(0); expect(world.walls).toHaveLength(0);
    const initial = energy(); let peakGain = 0, absoluteError = 0;
    for (let frame = 0; frame < 120; frame++) {
      world.step(1 / 120); peakGain = Math.max(peakGain, energy() - initial);
      absoluteError = Math.max(absoluteError, Math.abs(energy() - initial));
      expect(world.bodies.every(body => [body.pos.x, body.pos.y, body.vel.x, body.vel.y].every(Number.isFinite))).toBe(true);
      expect(Math.abs(beam.a.pos.distTo(beam.b.pos) - beam.length)).toBeLessThan(1e-7);
      expect(Math.max(0, pulley.currentLength() - pulley.length)).toBeLessThan(1e-7);
    }
    expect(world.time).toBeCloseTo(1, 10);
    expect(peakGain / Math.max(1, Math.abs(initial))).toBeLessThan(1e-4);
    // This reference trajectory never reaches a stop or releases its string.
    // Bound loss too: merely destroying the extra energy is not a repair.
    expect(absoluteError / Math.max(1, Math.abs(initial))).toBeLessThan(integrator === "Symplectic Euler" ? .01 : 1e-4);
    const theta = Math.atan2(beam.b.pos.y - beam.a.pos.y, beam.b.pos.x - beam.a.pos.x);
    const omega = world.bodies.filter(body => !body.locked && !body.isRodEndpoint && body !== free)
      .reduce((sum, body) => sum + body.mass * (body.pos.x * body.vel.y - body.pos.y * body.vel.x), 0) / 8.89;
    const state = [theta, free.pos.x, free.pos.y, omega, free.vel.x, free.vel.y];
    for (let i = 0; i < state.length; i++) {
      const error = i === 0 ? Math.atan2(Math.sin(state[i] - REFERENCE[mass][i]), Math.cos(state[i] - REFERENCE[mass][i])) :
        state[i] - REFERENCE[mass][i];
      expect(Math.abs(error)).toBeLessThan(integrator === "Symplectic Euler" ? .02 : 1e-5);
    }
  });
