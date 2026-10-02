import { describe, expect, it, vi } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall, PULLEY_RADIUS } from "../src/engine/body";
import { DistanceLink, PulleyLink, SpringLink } from "../src/engine/links";
import { Driver, ForceField, INTEGRATORS, World } from "../src/engine/world";
import { forceSymbols, type ForceEntry } from "../src/engine/force-diagnostics";
import { forceLedger, projectForce, slopeBasis } from "../src/education/analysis";

function particle(world: World, x: number, y: number, mass = 1) {
  const body = new Body(new Vec2(x, y), 0.2, mass);
  body.showForceComponents = true;
  body.noRotation = true;
  body.restitution = body.friction = 0;
  world.bodies.push(body);
  return body;
}

function floor(world: World, y = 0) {
  const wall = new Wall(new Vec2(-4, y), new Vec2(4, y));
  wall.thickness = 0.1;
  wall.restitution = wall.friction = 0;
  wall.name = "Floor";
  world.walls.push(wall);
  return wall;
}

function pulley(world: World, massA = 2, massB = 3) {
  const wheel = new Body(new Vec2(0, 2), PULLEY_RADIUS, 0);
  wheel.isPulley = wheel.locked = true; wheel.collides = false;
  world.bodies.push(wheel);
  const a = particle(world, -PULLEY_RADIUS, 0, massA);
  const b = particle(world, PULLEY_RADIUS, 0, massB);
  a.radius = b.radius = 0.16;
  const link = new PulleyLink(a, b, wheel);
  world.links.push(link);
  return { a, b, wheel, link };
}

function entry(world: World, body: Body, id: string) {
  return forceLedger(world, body).entries.find(force => force.id === id);
}

describe("immediate, isolated force calculations", () => {
  it("shows weight and a floor reaction at exact tangency before any step", () => {
    const world = new World();
    const body = particle(world, 0, 0.25, 2);
    const wall = floor(world);
    const ledger = forceLedger(world, body);
    expect(ledger.mode).toBe("current");
    expect(ledger.interval).toBeNull();
    expect(ledger.entries.map(force => force.id)).toEqual(["weight", `reaction-wall-${wall.id}`]);
    expect(ledger.entries[1].fy).toBeCloseTo(19.62, 10);
    expect(ledger.resultant.fx).toBeCloseTo(0, 10);
    expect(ledger.resultant.fy).toBeCloseTo(0, 10);
    expect(world.time).toBe(0); expect(world.stepCount).toBe(0);
    expect(body.pos.y).toBe(0.25); expect(body.vel.length()).toBe(0);
    expect(body.forceSnapshot).toBeNull(); expect(world.contacts).toEqual([]);
  });

  it.each(["underside", "endpoint"])("supports an exact capsule contact at its %s", face => {
    const world = new World(); world.gravity = 0;
    const wall = floor(world);
    const body = particle(world, face === "endpoint" ? 4.25 : 0, face === "underside" ? -0.25 : 0);
    body.constForce.set(face === "endpoint" ? -5 : 0, face === "underside" ? 5 : 0);
    const reaction = entry(world, body, `reaction-wall-${wall.id}`)!;
    expect(reaction.fx).toBeCloseTo(-body.constForce.x, 10);
    expect(reaction.fy).toBeCloseTo(-body.constForce.y, 10);
  });

  it("retains three separate reactions when two opposing neighbour forces cancel", () => {
    const world = new World();
    const left = particle(world, -0.4, 0.25); left.name = "Left"; left.constForce.x = 2;
    const middle = particle(world, 0, 0.25); middle.name = "Middle";
    const right = particle(world, 0.4, 0.25); right.name = "Right"; right.locked = true;
    const wall = floor(world);
    const ledger = forceLedger(world, middle);
    expect(entry(world, middle, `reaction-body-${left.id}`)?.fx).toBeCloseTo(2, 5);
    expect(entry(world, middle, `reaction-body-${right.id}`)?.fx).toBeCloseTo(-2, 5);
    expect(entry(world, middle, `reaction-wall-${wall.id}`)?.fy).toBeCloseTo(9.81, 10);
    expect(ledger.entries.filter(force => force.kind === "reaction")).toHaveLength(3);
    const symbols = forceSymbols(ledger.entries);
    expect(ledger.entries.filter(force => force.kind === "reaction").map(force => symbols.get(force.id)))
      .toEqual(["R₁", "R₂", "R₃"]);
    expect(ledger.resultant.fx).toBeCloseTo(0, 5);
    expect(ledger.resultant.fy).toBeCloseTo(0, 10);
  });

  it("separates the normal reaction and static friction on an inclined plane", () => {
    const world = new World(); const theta = Math.PI / 6;
    const wall = new Wall(new Vec2(-3 * Math.cos(theta), -3 * Math.sin(theta)),
      new Vec2(3 * Math.cos(theta), 3 * Math.sin(theta)));
    wall.thickness = 0.1; wall.restitution = 0; wall.friction = 1;
    world.walls.push(wall);
    const body = particle(world, -0.25 * Math.sin(theta), 0.25 * Math.cos(theta));
    body.friction = 1;
    const basis = slopeBasis(wall, body)!;
    const normal = projectForce(entry(world, body, `reaction-wall-${wall.id}`)!, basis);
    const friction = projectForce(entry(world, body, `friction-wall-${wall.id}`)!, basis);
    expect(normal.normal).toBeCloseTo(9.81 * Math.cos(theta), 6);
    expect(normal.parallel).toBeCloseTo(0, 10);
    expect(friction.parallel).toBeCloseTo(9.81 * Math.sin(theta), 6);
    expect(friction.normal).toBeCloseTo(0, 10);
    expect(forceLedger(world, body).resultant.fy).toBeCloseTo(0, 6);
  });

  it("does not invent a neighbour reaction from unloaded touching geometry", () => {
    const world = new World(); world.gravity = 0;
    const a = particle(world, 0, 0); const b = particle(world, 0.4, 0);
    expect(forceLedger(world, a).entries).toEqual([]);
    expect(forceLedger(world, b).entries).toEqual([]);
  });

  it.each([false, true])("calculates loaded neighbour reactions on a 25 degree slope (lower particle fixed=%s)", fixed => {
    const world = new World(); const theta = 25 * Math.PI / 180;
    const tx = Math.cos(theta), ty = -Math.sin(theta), nx = -ty, ny = tx;
    const wall = new Wall(new Vec2(-3 * tx, -3 * ty), new Vec2(3 * tx, 3 * ty));
    wall.thickness = 0.1; wall.restitution = wall.friction = 0; world.walls.push(wall);
    const bodies = [-0.4, 0, 0.4].map(s => particle(world, s * tx + 0.25 * nx, s * ty + 0.25 * ny));
    bodies[2].locked = fixed;
    const [upper, middle, lower] = bodies;
    const ledger = forceLedger(world, middle);
    const basis = slopeBasis(wall, middle)!;
    expect(projectForce(entry(world, middle, `reaction-wall-${wall.id}`)!, basis).normal)
      .toBeCloseTo(world.gravity * Math.cos(theta), 6);
    if (fixed) {
      expect(projectForce(entry(world, middle, `reaction-body-${upper.id}`)!, basis).parallel)
        .toBeCloseTo(world.gravity * Math.sin(theta), 6);
      expect(projectForce(entry(world, middle, `reaction-body-${lower.id}`)!, basis).parallel)
        .toBeCloseTo(-2 * world.gravity * Math.sin(theta), 6);
      expect(ledger.entries.filter(force => force.kind === "reaction")).toHaveLength(3);
      expect(ledger.resultant.fx).toBeCloseTo(0, 6); expect(ledger.resultant.fy).toBeCloseTo(0, 6);
    } else {
      expect(ledger.entries.filter(force => force.id.startsWith("reaction-body-"))).toEqual([]);
      expect(projectForce(ledger.resultant, basis).parallel).toBeCloseTo(world.gravity * Math.sin(theta), 6);
    }
  });

  it("keeps immediate support available for a sleeping Performance particle", () => {
    const world = new World(); world.performance = true; world.performanceLevel = 3;
    const body = particle(world, 0, 0.25, 2); body.perfSleeping = true; body.perfSleepFrames = 50;
    const wall = floor(world);
    expect(entry(world, body, `reaction-wall-${wall.id}`)?.fy).toBeCloseTo(19.62, 10);
    expect(forceLedger(world, body).resultant.fy).toBeCloseTo(0, 10);
    expect(body.perfSleeping).toBe(true); expect(body.perfSleepFrames).toBe(50);
  });

  it("updates cached sources after a rename, material edit or removed support", () => {
    const world = new World(); const body = particle(world, 0, 0.25); const wall = floor(world);
    body.constForce.x = 2;
    expect(forceLedger(world, body).resultant.fx).toBeCloseTo(2, 10);
    body.friction = wall.friction = 1;
    expect(entry(world, body, `friction-wall-${wall.id}`)?.fx).toBeCloseTo(-2, 10);
    wall.name = "Renamed support";
    expect(entry(world, body, `reaction-wall-${wall.id}`)?.label).toBe("Reaction from Renamed support");
    world.walls.length = 0;
    expect(forceLedger(world, body).entries.map(force => force.kind)).toEqual(["weight", "applied"]);
    expect(forceLedger(world, body).resultant.fy).toBeCloseTo(-9.81, 10);
  });

  it("retains the two neighbours and the floor as separate sources in completed intervals", () => {
    const world = new World(); world.integrator = "Symplectic Euler"; world.substeps = 4;
    const left = particle(world, -0.3999, 0.25); left.constForce.x = 2;
    const middle = particle(world, 0, 0.25); const right = particle(world, 0.3999, 0.25); right.locked = true;
    const wall = floor(world);
    for (let i = 0; i < 10; i++) world.step(1 / 120);
    const ledger = forceLedger(world, middle);
    expect(ledger.mode).toBe("step-average");
    expect(entry(world, middle, `reaction-body-${left.id}`)?.fx).toBeGreaterThan(1.9);
    expect(entry(world, middle, `reaction-body-${right.id}`)?.fx).toBeLessThan(-1.9);
    expect(entry(world, middle, `reaction-wall-${wall.id}`)?.fy).toBeCloseTo(9.81, 1);
    expect(ledger.entries.filter(force => force.kind === "reaction")).toHaveLength(3);
    const resultant = ledger.entries.reduce((sum, force) => sum.add(new Vec2(force.fx, force.fy)), new Vec2());
    expect(resultant.x).toBeCloseTo(middle.netForce.x, 9); expect(resultant.y).toBeCloseTo(middle.netForce.y, 9);
  });

  it("does not invent support for a separated or non-colliding particle", () => {
    const world = new World(); const body = particle(world, 0, 0.3); floor(world);
    expect(forceLedger(world, body).entries.map(force => force.kind)).toEqual(["weight"]);
    body.pos.y = 0.25; body.collides = false;
    expect(forceLedger(world, body).entries.map(force => force.kind)).toEqual(["weight"]);
  });

  it.each([false, true])("calculates a taut vertical link immediately (inelastic string=%s)", rope => {
    const world = new World(); const body = particle(world, 0, 0, 2); body.collides = false;
    const anchor = particle(world, 0, 2); anchor.locked = anchor.isAnchor = true; anchor.collides = false;
    const link = new DistanceLink(body, anchor, 2, rope); world.links.push(link);
    expect(entry(world, body, `distance-${link.id}`)?.fy).toBeCloseTo(19.62, 10);
    expect(forceLedger(world, body).resultant.fy).toBeCloseTo(0, 10);
    expect(link.mu).toBe(0);
    if (rope) {
      link.length = 3;
      expect(entry(world, body, `distance-${link.id}`)).toBeUndefined();
      expect(forceLedger(world, body).resultant.fy).toBeCloseTo(-19.62, 10);
    }
  });

  it.each([false, true])("calculates spring compression or elastic-string slack (tensionOnly=%s)", tensionOnly => {
    const world = new World(); world.gravity = 0;
    const a = particle(world, 0, 0); const b = particle(world, 1, 0);
    a.collides = b.collides = false;
    const link = new SpringLink(a, b, 2, 10, 0, tensionOnly); world.links.push(link);
    if (tensionOnly) expect(forceLedger(world, a).entries).toEqual([]);
    else {
      expect(entry(world, a, `spring-${link.id}`)?.fx).toBeCloseTo(-10, 10);
      expect(entry(world, a, `spring-${link.id}`)?.label).toBe("Spring thrust");
    }
    b.pos.x = 3;
    expect(entry(world, a, `spring-${link.id}`)?.fx).toBeCloseTo(10, 10);
    expect(entry(world, b, `spring-${link.id}`)?.fx).toBeCloseTo(-10, 10);
  });

  it("calculates equal Atwood tension without moving either particle", () => {
    const world = new World(); const { a, b, link } = pulley(world);
    const expected = 2 * 2 * 3 / 5 * world.gravity;
    expect(entry(world, a, `pulley-${link.id}`)?.fy).toBeCloseTo(expected, 8);
    expect(entry(world, b, `pulley-${link.id}`)?.fy).toBeCloseTo(expected, 8);
    expect(forceLedger(world, a).resultant.fy / a.mass).toBeCloseTo(world.gravity / 5, 8);
    expect(forceLedger(world, b).resultant.fy / b.mass).toBeCloseTo(-world.gravity / 5, 8);
    expect(a.pos.y).toBe(0); expect(b.pos.y).toBe(0); expect(link.mu).toBe(0);
  });

  it("shares a floor support with pulley tension rather than solving each load independently", () => {
    const world = new World(); const { a, b, link } = pulley(world, 3, 1);
    const wall = new Wall(new Vec2(-2, -0.18), new Vec2(-0.01, -0.18));
    wall.thickness = 0.04; wall.restitution = wall.friction = 0; world.walls.push(wall);
    expect(entry(world, a, `pulley-${link.id}`)?.fy).toBeCloseTo(9.81, 5);
    expect(entry(world, b, `pulley-${link.id}`)?.fy).toBeCloseTo(9.81, 5);
    expect(entry(world, a, `reaction-wall-${wall.id}`)?.fy).toBeCloseTo(19.62, 5);
    expect(forceLedger(world, a).resultant.fy).toBeCloseTo(0, 5);
    expect(forceLedger(world, b).resultant.fy).toBeCloseTo(0, 5);
  });

  it("samples fields and drivers at the current time and caches unchanged reads", () => {
    const world = new World(); world.gravity = 0; world.time = 0.25;
    const body = particle(world, 0, 1); body.collides = false; body.vel.x = 2;
    const field = new ForceField("Current time", "2*t+vx", "0");
    field.fx = vi.fn(field.fx!); world.fields.push(field);
    world.drivers.push(new Driver(body.id, 3, 1, 0, 0));
    const first = world.currentForceSnapshot(body)!;
    expect(first.entries.find(force => force.kind === "field")?.fx).toBe(2.5);
    expect(first.entries.find(force => force.kind === "driver")?.fx).toBe(3);
    expect(world.currentForceSnapshot(body)).toBe(first);
    expect(field.fx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(field.fx!).mock.calls[0][0].t).toBe(0.25);
    body.constForce.x = 4;
    const changed = world.currentForceSnapshot(body)!;
    expect(changed).not.toBe(first); expect(changed.fx).toBeCloseTo(first.fx + 4, 10);
    field.fx = () => 8;
    expect(world.currentForceSnapshot(body)?.entries.find(force => force.kind === "field")?.fx).toBe(8);
    expect(world.time).toBe(0.25); expect(world.stepCount).toBe(0);
  });

  it("preserves all live inputs, transients, caches, object identities and ID counters", () => {
    const world = new World(); const { a, b, link } = pulley(world);
    floor(world, -0.2); world.step(1 / 120);
    a.perfSleeping = true; a.perfSleepFrames = 50;
    b.speedCap = 3; b.kinematicCorrectionRate = 4;
    const before = world.toDict(); const bodyState = world.bodies.map(body => structuredClone(body));
    const linkState = structuredClone(world.links);
    const ids = [Body.nextId, Wall.nextId, DistanceLink.nextId, SpringLink.nextId, PulleyLink.nextId];
    const bodies = world.bodies; const links = world.links; const walls = world.walls;
    const contactCache = (world as unknown as { contactCache: Map<string, unknown> }).contactCache;
    const cache = structuredClone(contactCache); const contacts = world.contacts;
    const sample = a.forceSnapshot; const step = vi.spyOn(world, "step");
    const preview = world.currentForceSnapshot(a)!;
    expect(preview).not.toBeNull(); expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.entries)).toBe(true);
    expect(world.toDict()).toEqual(before);
    expect(world.bodies.map(body => structuredClone(body))).toEqual(bodyState);
    expect(structuredClone(world.links)).toEqual(linkState);
    expect(world.bodies).toBe(bodies); expect(world.links).toBe(links); expect(world.walls).toBe(walls);
    expect(link.a).toBe(a); expect(link.b).toBe(b); expect(a.forceSnapshot).toBe(sample);
    expect(world.contacts).toBe(contacts); expect(contactCache).toEqual(cache);
    expect([Body.nextId, Wall.nextId, DistanceLink.nextId, SpringLink.nextId, PulleyLink.nextId]).toEqual(ids);
    expect(step).not.toHaveBeenCalled();
  });

  it("does no force calculation for disabled or foreign particles", () => {
    const world = new World(); const body = particle(world, 0, 1);
    const field = new ForceField("Counter", "1", "0"); field.fx = vi.fn(field.fx!); world.fields.push(field);
    body.showForceComponents = false;
    expect(world.currentForceSnapshot(body)).toBeNull();
    const foreign = new Body(new Vec2()); foreign.showForceComponents = true;
    expect(world.currentForceSnapshot(foreign)).toBeNull(); expect(field.fx).not.toHaveBeenCalled();
  });

  for (const integrator of INTEGRATORS) {
    it.each([false, true])(`${integrator} keeps subsequent motion bit-identical with repeated queries (Performance=%s)`, performance => {
      const world = new World(); const { a } = pulley(world); floor(world, -0.4);
      world.integrator = integrator; world.performance = performance; world.performanceLevel = 3;
      a.vel.y = 0.1;
      const reference = World.fromDict(world.toDict()); reference.performance = performance; reference.performanceLevel = 3;
      for (let i = 0; i < 15; i++) {
        world.currentForceSnapshot(a);
        world.step(1 / 120); reference.step(1 / 120);
        expect(world.toDict()).toEqual(reference.toDict());
        expect(world.bodies.map(body => [body.netForce.x, body.netForce.y, body.touching, body.perfSleeping]))
          .toEqual(reference.bodies.map(body => [body.netForce.x, body.netForce.y, body.touching, body.perfSleeping]));
      }
    });
  }
});

describe("force source symbols", () => {
  it("distinguishes duplicate reaction, friction, tension and applied-force arrows including multi-digit indices", () => {
    const entries: ForceEntry[] = Array.from({ length: 12 }, (_, i) =>
      ({ id: `reaction-${i}`, label: `Reaction ${i}`, kind: "reaction", fx: i + 1, fy: 0 }));
    for (const kind of ["friction", "string", "applied"] as const) {
      for (let i = 0; i < 2; i++) entries.push({ id: `${kind}-${i}`, label: kind, kind, fx: 1, fy: 0 });
    }
    const symbols = forceSymbols(entries);
    expect(symbols.get("reaction-0")).toBe("R₁"); expect(symbols.get("reaction-11")).toBe("R₁₂");
    expect(symbols.get("friction-1")).toBe("f₂"); expect(symbols.get("string-1")).toBe("T₂");
    expect(symbols.get("applied-1")).toBe("F₂"); expect(new Set(symbols.values()).size).toBe(entries.length);
  });
});
