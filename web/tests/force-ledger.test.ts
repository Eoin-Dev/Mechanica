import { describe, expect, it, vi } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, PULLEY_RADIUS, Wall } from "../src/engine/body";
import { DistanceLink, PulleyLink, SpringLink } from "../src/engine/links";
import { Driver, ForceField, INTEGRATORS, World } from "../src/engine/world";
import { forceLedger } from "../src/education/analysis";

function freeParticle() {
  const world = new World();
  world.gravity = 0;
  const body = new Body(new Vec2(0, 1), 0.2, 2);
  body.collides = false;
  body.showForceComponents = true;
  world.bodies.push(body);
  return { world, body };
}

function expectClosure(world: World, body: Body) {
  const ledger = forceLedger(world, body);
  expect(ledger.mode).toBe("step-average");
  const sum = ledger.entries.reduce((s, force) => ({
    x: s.x + force.fx, y: s.y + force.fy,
  }), { x: 0, y: 0 });
  expect(sum.x).toBeCloseTo(body.netForce.x, 9);
  expect(sum.y).toBeCloseTo(body.netForce.y, 9);
  return ledger;
}

describe("force-diagram time consistency", () => {
  for (const integrator of INTEGRATORS) {
    it.each([1, 4])(`${integrator} averages a changing field over %s substeps without inventing a reaction`, substeps => {
      const { world, body } = freeParticle();
      world.integrator = integrator;
      world.substeps = substeps;
      world.fields.push(new ForceField("Ramping force", "120*t", "0"));
      world.step(1 / 60);
      const ledger = forceLedger(world, body);
      const expected = integrator === "Symplectic Euler" ? (substeps - 1) / substeps : 1;
      expect(ledger.entries.find(entry => entry.kind === "field")?.fx ?? 0).toBeCloseTo(expected, 12);
      expect(ledger.resultant.fx).toBeCloseTo(expected, 12);
      expect(ledger.entries.filter(entry => entry.kind === "reaction")).toEqual([]);
      expect(world.contacts).toEqual([]);
    });

    it(`${integrator} reports the drag that produced free motion without a contact force`, () => {
      const { world, body } = freeParticle();
      world.integrator = integrator;
      world.substeps = 4;
      world.dragLinear = 0.5;
      world.dragQuadratic = 0.3;
      body.vel.set(3, 4);
      world.step(1 / 60);
      const ledger = forceLedger(world, body);
      const drag = ledger.entries.find(entry => entry.kind === "drag")!;
      expect(drag.fx).toBeCloseTo(body.netForce.x, 12);
      expect(drag.fy).toBeCloseTo(body.netForce.y, 12);
      expect(ledger.entries.filter(entry => entry.kind === "reaction")).toEqual([]);
      expect(world.contacts).toEqual([]);
    });
  }

  it("shows current authored forces before the first step", () => {
    const { world, body } = freeParticle();
    world.gravity = 9.8;
    body.constForce.set(3, 5);
    const ledger = forceLedger(world, body);
    expect(ledger.entries.map(entry => entry.label)).toEqual(["Weight", "Applied force"]);
    expect(ledger.resultant).toEqual({ fx: 3, fy: -14.600000000000001 });
  });

  it("skips an entire singular field sample rather than displaying its valid axis", () => {
    const { world, body } = freeParticle();
    body.pos.x = -1;
    world.fields.push(new ForceField("Singularity", "sqrt(x)", "2"));
    world.step(1 / 60);
    expect(forceLedger(world, body).entries).toEqual([]);
  });
});

describe("force-diagram impulses and constraints", () => {
  for (const integrator of INTEGRATORS) {
    it(`${integrator} retains an earlier collision when the final substep is contact-free`, () => {
      const { world, body } = freeParticle();
      world.integrator = integrator;
      world.substeps = 4;
      body.collides = true;
      body.pos.y = 0.21;
      body.vel.y = -3;
      body.restitution = 1;
      body.friction = 0;
      const floor = new Wall(new Vec2(-5, 0), new Vec2(5, 0));
      floor.restitution = 1;
      floor.friction = 0;
      world.walls.push(floor);
      world.step(0.1);
      const ledger = expectClosure(world, body);
      expect(world.contacts).toEqual([]);
      expect(ledger.entries.map(entry => entry.id)).toEqual(["contact"]);
      expect(ledger.entries[0].fy).toBeCloseTo(120, 9);
      expect(body.vel.y).toBeCloseTo(3, 9);
    });

    it(`${integrator} distinguishes global damping from a reaction`, () => {
      const { world, body } = freeParticle();
      world.integrator = integrator;
      world.globalDamping = 3;
      world.substeps = 4;
      body.vel.set(3, 4);
      world.step(0.1);
      const ledger = expectClosure(world, body);
      expect(ledger.entries.map(entry => entry.label)).toEqual(["Global damping"]);
      const decay = Math.pow(1 - 3 * 0.1 / 4, 4);
      expect(ledger.entries[0].fx).toBeCloseTo(2 * 3 * (decay - 1) / 0.1, 10);
    });

    it(`${integrator} names an interactive speed clamp as a correction`, () => {
      const { world, body } = freeParticle();
      world.integrator = integrator;
      body.vel.set(3, 4);
      body.speedCap = 2;
      world.step(0.1);
      const ledger = expectClosure(world, body);
      expect(ledger.entries.map(entry => entry.id)).toEqual(["speed-limit"]);
      expect(ledger.entries[0].kind).toBe("correction");
      expect(ledger.entries[0].fx).toBeCloseTo(-36, 12);
      expect(ledger.entries[0].fy).toBeCloseTo(-48, 12);
      expect(body.vel.length()).toBeCloseTo(2, 12);
    });

    it.each([false, true])(`${integrator} records link forces without a false support reaction (rope=%s)`, rope => {
      const { world, body } = freeParticle();
      world.integrator = integrator;
      world.substeps = 4;
      const support = new Body(new Vec2(0, 2), 0.1, 1);
      support.locked = true;
      support.isAnchor = true;
      support.collides = false;
      body.constForce.y = -20;
      world.bodies.push(support);
      world.links.push(new DistanceLink(support, body, 1, rope));
      world.step(1 / 60);
      const ledger = expectClosure(world, body);
      const linkForce = ledger.entries.find(entry => entry.kind === (rope ? "string" : "rod"))!;
      expect(linkForce.fy).toBeCloseTo(20, 9);
      expect(ledger.entries.some(entry => entry.kind === "reaction")).toBe(false);
      expect(body.netForce.y).toBeCloseTo(0, 9);
    });

    it(`${integrator} averages spring force through its changing geometry`, () => {
      const { world, body } = freeParticle();
      world.integrator = integrator;
      world.substeps = 4;
      const support = new Body(new Vec2(0, 0));
      support.locked = true;
      support.isAnchor = true;
      const spring = new SpringLink(support, body, 0.5, 20, 0.4);
      world.bodies.push(support);
      world.links.push(spring);
      world.step(0.1);
      const ledger = expectClosure(world, body);
      expect(ledger.entries.map(entry => entry.label)).toEqual(["Spring tension"]);
      expect(ledger.entries[0].fy).toBeCloseTo(body.netForce.y, 11);
      expect(Math.abs(ledger.entries[0].fy + spring.axialForce)).toBeGreaterThan(0.01);
    });

    it(`${integrator} preserves equal averaged tension for an Atwood machine`, () => {
      const world = new World();
      world.integrator = integrator;
      world.substeps = 4;
      const wheel = new Body(new Vec2(0, 1), PULLEY_RADIUS);
      wheel.locked = wheel.isAnchor = wheel.isPulley = true;
      wheel.collides = false;
      const a = new Body(new Vec2(-PULLEY_RADIUS, -0.25), 0.16, 1);
      const b = new Body(new Vec2(PULLEY_RADIUS, -0.25), 0.16, 2);
      a.showForceComponents = b.showForceComponents = true;
      world.bodies.push(wheel, a, b);
      world.links.push(new PulleyLink(a, b, wheel));
      world.step(1 / 1200);
      const first = expectClosure(world, a);
      const second = expectClosure(world, b);
      const tensionA = first.entries.find(entry => entry.kind === "pulley")!;
      const tensionB = second.entries.find(entry => entry.kind === "pulley")!;
      expect(tensionA.fy).toBeCloseTo(4 * world.gravity / 3, 8);
      expect(tensionA.fy).toBeCloseTo(tensionB.fy, 12);
      expect(first.entries.some(entry => entry.kind === "reaction")).toBe(false);
    });
  }

  it("uses actual projected spring impulses in Performance mode", () => {
    const { world, body } = freeParticle();
    world.performance = true;
    const support = new Body(new Vec2(0, 0));
    support.locked = support.isAnchor = true;
    world.bodies.push(support);
    world.links.push(new SpringLink(support, body, 0.5, 20, 0.4));
    world.step(1 / 60);
    const ledger = expectClosure(world, body);
    expect(ledger.entries.map(entry => entry.label)).toEqual(["Performance spring force"]);
    expect(ledger.entries[0].kind).toBe("spring");
  });
});

describe("force recording lifecycle and determinism", () => {
  it("does not evaluate a compiled formula again to display its recorded forces", () => {
    const { world, body } = freeParticle();
    world.integrator = "RK4";
    world.substeps = 4;
    const field = new ForceField("Varying", "120*t", "x+vy");
    field.fx = vi.fn(field.fx!);
    field.fy = vi.fn(field.fy!);
    world.fields.push(field);
    world.step(1 / 60);
    expect(field.fx).toHaveBeenCalledTimes(16);
    expect(field.fy).toHaveBeenCalledTimes(16);
    for (let i = 0; i < 20; i++) expectClosure(world, body);
    expect(field.fx).toHaveBeenCalledTimes(16);
    expect(field.fy).toHaveBeenCalledTimes(16);
  });

  it("keeps completed snapshots immutable and clears them when the diagram is disabled", () => {
    const { world, body } = freeParticle();
    body.constForce.x = 2;
    world.step(0.1);
    const first = body.forceSnapshot!;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(Object.isFrozen(first.entries[0])).toBe(true);
    world.step(0.1);
    expect(body.forceSnapshot).not.toBe(first);
    expect(first.stepCount).toBe(1);
    expect(first.entries[0].fx).toBeCloseTo(2, 12);
    expect(forceLedger(world, body).interval!.start).toBeCloseTo(0.1, 12);
    expect(forceLedger(world, body).interval!.end).toBeCloseTo(0.2, 12);
    body.showForceComponents = false;
    world.step(0.1);
    expect(body.forceSnapshot).toBeNull();
    body.showForceComponents = true;
    expect(forceLedger(world, body).mode).toBe("current");
  });

  it("drops recorded forces on explicit edits, direct kinematic changes, and scene restoration", () => {
    const { world, body } = freeParticle();
    body.constForce.x = 3;
    world.step(0.1);
    body.pos.x += 1;
    expect(forceLedger(world, body).mode).toBe("current");
    world.step(0.1);
    body.constForce.x = 7;
    world.clearForceDiagnostics();
    expect(forceLedger(world, body).resultant.fx).toBe(7);
    expect(body.forceSnapshot).toBeNull();
    world.step(0.1);
    const restored = World.fromDict(world.toDict());
    const restoredBody = restored.bodies[0];
    restoredBody.showForceComponents = true;
    expect(restoredBody.forceSnapshot).toBeNull();
    expect(forceLedger(restored, restoredBody).mode).toBe("current");
    expect(JSON.stringify(world.toDict())).not.toMatch(/forceSnapshot|step-average|numerical-correction/);
  });

  it.each([0, Number.MIN_VALUE])("retains the last interval for a strict no-op step of %s", dt => {
    const { world, body } = freeParticle();
    body.constForce.x = 2;
    world.step(0.1);
    const sample = body.forceSnapshot;
    world.step(dt);
    expect(body.forceSnapshot).toBe(sample);
    expect(forceLedger(world, body).mode).toBe("step-average");
  });

  for (const integrator of INTEGRATORS) {
    it.each(["normal", "performance", "maximum", "adaptive"])(`${integrator} leaves physical state bit-identical with force recording in %s mode`, mode => {
      const { world: original, body } = freeParticle();
      body.showForceComponents = false;
      body.vel.set(2, -1);
      body.constForce.set(2, 3);
      original.gravity = 9.8;
      original.dragLinear = 0.2;
      original.dragQuadratic = 0.1;
      original.globalDamping = 0.05;
      original.integrator = integrator;
      original.substeps = 4;
      original.performance = mode === "performance" || mode === "maximum";
      original.performanceLevel = mode === "maximum" ? 3 : 0;
      original.mutualGravity = mode === "adaptive";
      original.G = 0.7;
      const partner = new Body(new Vec2(2, 1), 0.2, 3);
      partner.collides = false;
      original.bodies.push(partner);
      original.links.push(new SpringLink(body, partner, 1.5, 12, 0.2));
      original.fields.push(new ForceField("Time and velocity", "sin(3*t)-0.2*vx", "0.3*y"));
      original.drivers.push(new Driver(body.id, 4, 2, 0.3, 0.7));
      const recorded = World.fromDict(original.toDict());
      // Performance profile is application view state, outside scene JSON.
      recorded.performance = original.performance;
      recorded.performanceLevel = original.performanceLevel;
      recorded.bodies.forEach(b => { b.showForceComponents = true; });
      for (let i = 0; i < 30; i++) {
        original.step(1 / 120);
        recorded.step(1 / 120);
        expect(recorded.toDict()).toEqual(original.toDict());
        expect(recorded.bodies.map(b => [b.netForce.x, b.netForce.y]))
          .toEqual(original.bodies.map(b => [b.netForce.x, b.netForce.y]));
        recorded.bodies.forEach(b => expectClosure(recorded, b));
      }
      expect(original.bodies.every(b => b.forceSnapshot === null)).toBe(true);
    });
  }
});

describe("force-diagram source ownership", () => {
  it("averages mounted-particle support forces without mislabelling them as contact", () => {
    const { world, body } = freeParticle();
    world.gravity = 9.8;
    const a = new Body(new Vec2(-1, 1), 0.04, 1e-3);
    const b = new Body(new Vec2(1, 1), 0.04, 1e-3);
    a.isRodEndpoint = b.isRodEndpoint = true;
    a.collides = b.collides = false;
    a.locked = b.locked = true;
    const rod = new DistanceLink(a, b, 2);
    body.rodAttachmentId = rod.id;
    body.rodAttachmentT = 0.5;
    world.bodies.push(a, b);
    world.links.push(rod);
    world.step(1 / 60);
    const ledger = expectClosure(world, body);
    expect(ledger.entries.map(entry => entry.label)).toEqual(["Weight", "Rod attachment reaction"]);
    expect(ledger.entries[1].fy).toBeCloseTo(19.6, 12);
    expect(world.contacts).toEqual([]);
  });

  it("captures the actual approximated gravity in maximum Performance mode", () => {
    const { world, body } = freeParticle();
    world.performance = true;
    world.performanceLevel = 3;
    world.mutualGravity = true;
    world.G = 0.01;
    for (let i = 0; i < 140; i++) {
      const source = new Body(new Vec2(10 + (i % 14), 10 + Math.floor(i / 14)), 0.1, 1);
      source.collides = false;
      source.locked = true;
      world.bodies.push(source);
    }
    world.step(1 / 120);
    const ledger = expectClosure(world, body);
    expect(ledger.entries.map(entry => entry.kind)).toEqual(["gravity"]);
    expect(ledger.entries[0].fx).toBeCloseTo(body.netForce.x, 12);
    expect(ledger.entries[0].fy).toBeCloseTo(body.netForce.y, 12);
  });

  it.each([false, true])("omits hidden rod endpoint gravity (stepped=%s)", stepped => {
    const { world, body } = freeParticle();
    world.mutualGravity = true;
    world.G = 200;
    const a = new Body(new Vec2(-1, 0), 0.04, 1e-3);
    const b = new Body(new Vec2(1, 0), 0.04, 1e-3);
    a.isRodEndpoint = b.isRodEndpoint = true;
    a.collides = b.collides = false;
    const rod = new DistanceLink(a, b, 2);
    world.bodies.push(a, b);
    world.links.push(rod);
    if (stepped) world.step(1 / 60);
    expect(body.netForce.length()).toBe(0);
    expect(forceLedger(world, body).entries).toEqual([]);
    expect(forceLedger(world, body).resultant).toEqual({ fx: 0, fy: 0 });
  });
});
