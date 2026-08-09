import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import {
  Body, SCENE_MAX_COORDINATE, SCENE_MAX_FORCE, SCENE_MAX_FRICTION,
  SCENE_MAX_MASS, SCENE_MAX_SIZE, SCENE_MAX_SURFACE_SPEED,
  SCENE_MAX_VELOCITY, Wall,
} from "../src/engine/body";
import { DistanceLink, SpringLink } from "../src/engine/links";
import { PERF_MAX_MOVE_RADII, PerfSolver } from "../src/engine/perf";
import {
  Driver, ForceField, SCENE_MAX_BODIES, SCENE_MAX_DRIVERS, SCENE_MAX_FIELDS,
  SCENE_MAX_LINKS, SCENE_MAX_WALLS, SceneCollection, SceneLimitError, World,
} from "../src/engine/world";

const DT = 1 / 120;

describe("world step input contract", () => {
  it("makes zero and positive-underflow strict no-ops", () => {
    const world = new World();
    world.substeps = 1;
    world.performance = true;
    const body = new Body(new Vec2(1, 2));
    const other = new Body(new Vec2(2, 2));
    body.vel.set(3, 4);
    other.vel.set(-2, 1);
    world.bodies.push(body, other);
    world.links.push(new DistanceLink(body, other, 1),
                     new SpringLink(body, other, 1, 100, 1));
    world.diverged = ["keep"];
    const before = world.toDict();
    world.step(0);
    world.step(Number.MIN_VALUE);
    world.step(1e-160); // h^2 survives, but its reciprocal still overflows
    expect(world.toDict()).toEqual(before);
    expect(world.time).toBe(0);
    expect(world.stepCount).toBe(0);
    expect(world.diverged).toEqual(["keep"]);
  });

  it("rejects negative and non-finite timesteps", () => {
    const world = new World();
    for (const bad of [-1, -Number.MIN_VALUE, Number.NaN, Infinity, -Infinity]) {
      expect(() => world.step(bad), String(bad)).toThrow(RangeError);
    }
  });
});

describe("scene load resource and numeric bounds", () => {
  it("throws a typed error before mapping an over-limit collection", () => {
    const cases: Array<[SceneCollection, number]> = [
      ["bodies", SCENE_MAX_BODIES], ["walls", SCENE_MAX_WALLS],
      ["links", SCENE_MAX_LINKS], ["fields", SCENE_MAX_FIELDS],
      ["drivers", SCENE_MAX_DRIVERS],
    ];
    for (const [collection, limit] of cases) {
      const payload = { [collection]: Array(limit + 1).fill(null) };
      try {
        World.fromDict(payload);
        throw new Error("expected a scene limit failure");
      } catch (error) {
        expect(error).toBeInstanceOf(SceneLimitError);
        const limitError = error as SceneLimitError;
        expect(limitError.collection).toBe(collection);
        expect(limitError.limit).toBe(limit);
        expect(limitError.actual).toBe(limit + 1);
      }
    }
  });

  it("clamps imported bodies, walls and driver angles to shared bounds", () => {
    const body = Body.fromDict({
      id: 1, pos: [-Infinity, 2e9], vel: [-2e9, 2e9], radius: 2e9,
      mass: 2e20, friction: 2e20, const_force: [-2e20, 2e20],
      angle: 123456, omega: 2e20,
    } as never);
    expect(body.pos.x).toBe(0); // a non-finite value uses the safe fallback
    expect(body.pos.y).toBe(SCENE_MAX_COORDINATE);
    expect(body.vel.x).toBe(-SCENE_MAX_VELOCITY);
    expect(body.vel.y).toBe(SCENE_MAX_VELOCITY);
    expect(body.radius).toBe(SCENE_MAX_SIZE);
    expect(body.mass).toBe(SCENE_MAX_MASS);
    expect(body.friction).toBe(SCENE_MAX_FRICTION);
    expect(body.constForce.x).toBe(-SCENE_MAX_FORCE);
    expect(body.constForce.y).toBe(SCENE_MAX_FORCE);
    expect(body.angle).toBeGreaterThanOrEqual(-Math.PI);
    expect(body.angle).toBeLessThan(Math.PI);
    expect(Math.abs(body.omega) * body.radius).toBeLessThanOrEqual(SCENE_MAX_SURFACE_SPEED);
    expect(Body.fromDict({ mass: 0 } as never).mass).toBe(0);
    expect(Body.fromDict({ mass: -1 } as never).mass).toBeGreaterThan(0);
    expect(Body.fromDict({ angle: 0.1 } as never).angle).toBe(0.1);

    const wall = Wall.fromDict({
      a: [-2e9, 2e9], b: [2e9, -2e9], thickness: 2e9, friction: 2e9,
    } as never);
    expect(wall.a.x).toBe(-SCENE_MAX_COORDINATE);
    expect(wall.b.x).toBe(SCENE_MAX_COORDINATE);
    expect(wall.thickness).toBe(SCENE_MAX_SIZE);
    expect(wall.friction).toBe(SCENE_MAX_FRICTION);

    const driver = Driver.fromDict({ body_id: 1, phase: 1e100, angle: -1e100 } as never);
    expect(driver.phase).toBeGreaterThanOrEqual(-Math.PI);
    expect(driver.phase).toBeLessThan(Math.PI);
    expect(driver.angle).toBeGreaterThanOrEqual(-Math.PI);
    expect(driver.angle).toBeLessThan(Math.PI);
  });

  it("freezes non-finite angle and excessive surface spin at runtime", () => {
    const world = new World();
    world.gravity = 0;
    const angle = new Body(new Vec2(0, 0), 1, 1);
    const spin = new Body(new Vec2(3, 0), 2, 1);
    angle.angle = Number.NaN;
    spin.omega = SCENE_MAX_SURFACE_SPEED;
    world.bodies.push(angle, spin);
    world.step(DT);
    expect(world.diverged).toEqual([angle.name, spin.name]);
    expect(angle.angle).toBe(0);
    expect(spin.omega).toBe(0);
  });

  it("does not flag an imported surface spin clamped exactly at the limit", () => {
    const world = World.fromDict({
      settings: { gravity: 0, substeps: 1 },
      bodies: [{ id: 1, radius: 9.000108999109, omega: 1e100 }],
    } as never);
    world.step(DT);
    expect(world.diverged).toEqual([]);
  });

  it("preserves trusted snapshot angles while normalizing imported angles", () => {
    const raw = {
      bodies: [{ id: 1, angle: 8 * Math.PI + 0.1 }],
      drivers: [{ body_id: 1, angle: Math.PI, phase: 7 }],
    };
    const imported = World.fromDict(raw as never);
    const trusted = World.fromDict(raw as never, true);
    expect(imported.bodies[0].angle).toBeCloseTo(0.1, 12);
    expect(imported.drivers[0].angle).toBe(-Math.PI);
    expect(trusted.bodies[0].angle).toBe(raw.bodies[0].angle);
    expect(trusted.drivers[0].angle).toBe(Math.PI);
    expect(trusted.drivers[0].phase).toBe(7);
  });
});

describe("contact and performance-mode correction bounds", () => {
  it("does not world-pin a freely translating static-contact pair", () => {
    const world = new World();
    world.gravity = 0;
    world.substeps = 2;
    world.iterations = 12;
    const a = new Body(new Vec2(-0.19, 0), 0.2, 1);
    const b = new Body(new Vec2(0.19, 0), 0.2, 1);
    for (const body of [a, b]) {
      body.noRotation = true;
      body.friction = 2;
      body.restitution = 0;
      body.vel.set(0, 1);
    }
    a.constForce.x = 10;
    b.constForce.x = -10;
    world.bodies.push(a, b);
    for (let i = 0; i < 120; i++) world.step(DT);
    expect(a.pos.y).toBeGreaterThan(0.95);
    expect(b.pos.y).toBeGreaterThan(0.95);
    expect(Math.abs(a.pos.y - b.pos.y)).toBeLessThan(1e-8);
  });

  it("does not treat a held moving body as fixed structural support", () => {
    const world = new World();
    world.gravity = 0;
    world.substeps = 2;
    world.iterations = 12;
    const held = new Body(new Vec2(0, 0), 0.2, 1);
    held.held = true;
    held.noRotation = true;
    held.friction = 2;
    held.restitution = 0;
    held.vel.x = 1;
    const top = new Body(new Vec2(0, 0.38), 0.2, 1);
    top.noRotation = true;
    top.friction = 2;
    top.restitution = 0;
    top.vel.x = 1;
    top.constForce.y = -10;
    world.bodies.push(held, top);

    for (let i = 0; i < 120; i++) {
      held.pos.x += DT;
      held.vel.x = 1;
      world.step(DT);
    }

    expect(top.pos.x).toBeGreaterThan(0.95);
    expect(Math.abs(top.pos.x - held.pos.x)).toBeLessThan(1e-3);
    expect(top.vel.x).toBeCloseTo(1, 6);
  });

  it("keeps spring and elastic-string endpoints collidable in both modes", () => {
    for (const performance of [false, true]) {
      for (const tensionOnly of [false, true]) {
        const world = new World();
        world.gravity = 0;
        world.substeps = 1;
        world.performance = performance;
        const a = new Body(new Vec2(-0.2, 0), 0.3, 1);
        const b = new Body(new Vec2(0.2, 0), 0.3, 1);
        world.bodies.push(a, b);
        world.links.push(new SpringLink(a, b, 0.4, 0, 0, tensionOnly));
        world.step(DT);
        expect(world.contacts.length, `${performance}/${tensionOnly}`).toBeGreaterThan(0);
      }
    }
  });

  it("still excludes an impossible short distance constraint", () => {
    const world = new World();
    world.gravity = 0;
    world.substeps = 1;
    const a = new Body(new Vec2(-0.2, 0), 0.3, 1);
    const b = new Body(new Vec2(0.2, 0), 0.3, 1);
    world.bodies.push(a, b);
    world.links.push(new DistanceLink(a, b, 0.4));
    world.step(DT);
    expect(world.contacts).toHaveLength(0);
  });

  it("applies one final combined movement cap after strain recovery", () => {
    const a = new Body(new Vec2(-50, 0), 0.1, 1);
    const b = new Body(new Vec2(50, 0), 0.1, 1);
    const spring = new SpringLink(a, b, 0.1, 100_000, 0);
    const ax = a.pos.x;
    const bx = b.pos.x;
    new PerfSolver().solve([spring], DT, 4);
    const allowance = a.radius * PERF_MAX_MOVE_RADII;
    expect(Math.abs(a.pos.x - ax)).toBeLessThanOrEqual(allowance + 1e-12);
    expect(Math.abs(b.pos.x - bx)).toBeLessThanOrEqual(allowance + 1e-12);
  });
});

describe("generalized Velocity Verlet", () => {
  it("preserves the conservative-force arithmetic path and reuses scratch", () => {
    const world = new World();
    world.gravity = 9.81;
    world.substeps = 1;
    const body = new Body(new Vec2(1, 2), 0.1, 2);
    body.collides = false;
    body.vel.set(3, 4);
    body.constForce.set(5, -7);
    world.bodies.push(body);

    const h = 0.125;
    const half = 0.5 * h;
    const ax = 5 / 2;
    const ay = -7 / 2 - 9.81;
    const halfVx = 3 + ax * half;
    const halfVy = 4 + ay * half;
    world.step(h);
    expect(body.pos.x).toBe(1 + halfVx * h);
    expect(body.pos.y).toBe(2 + halfVy * h);
    expect(body.vel.x).toBe(halfVx + ax * half);
    expect(body.vel.y).toBe(halfVy + ay * half);

    type VerletScratch = { verletHalfVelocity: Float64Array };
    const first = (world as unknown as VerletScratch).verletHalfVelocity;
    world.step(h);
    expect((world as unknown as VerletScratch).verletHalfVelocity).toBe(first);

    for (let i = 0; i < 8; i++) {
      const extra = new Body(new Vec2(10 + i, 0), 0.1, 1);
      extra.collides = false;
      world.bodies.push(extra);
    }
    world.step(h);
    const grown = (world as unknown as VerletScratch).verletHalfVelocity;
    expect(grown).not.toBe(first);
    expect(grown.length).toBeGreaterThanOrEqual(2 * world.bodies.length);
    world.step(h);
    expect((world as unknown as VerletScratch).verletHalfVelocity).toBe(grown);
  });

  function integrate(make: () => { world: World; body: Body }, dt: number): Body {
    const { world, body } = make();
    const steps = Math.round(1 / dt);
    for (let i = 0; i < steps; i++) world.step(dt);
    return body;
  }

  function expectSecondOrder(
    make: () => { world: World; body: Body }, expectedX: number,
  ): void {
    const coarse = Math.abs(integrate(make, 0.1).pos.x - expectedX);
    const fine = Math.abs(integrate(make, 0.05).pos.x - expectedX);
    expect(fine).toBeLessThan(coarse / 3);
  }

  it("converges at second order for built-in linear drag", () => {
    const make = () => {
      const world = new World();
      world.gravity = 0;
      world.dragLinear = 1;
      world.substeps = 1;
      const body = new Body(new Vec2(), 0.1, 1);
      body.collides = false;
      body.vel.x = 1;
      world.bodies.push(body);
      return { world, body };
    };
    expectSecondOrder(make, 1 - Math.exp(-1));
  });

  it("converges at second order for a damped spring", () => {
    const k = 4;
    const damping = 0.6;
    const gamma = damping / 2;
    const omega = Math.sqrt(k - gamma * gamma);
    const expected = Math.exp(-gamma) *
      (Math.cos(omega) + (gamma / omega) * Math.sin(omega));
    const make = () => {
      const world = new World();
      world.gravity = 0;
      world.substeps = 1;
      const anchor = new Body(new Vec2(), 0.01, 1);
      anchor.locked = true;
      anchor.isAnchor = true;
      const body = new Body(new Vec2(1, 0), 0.01, 1);
      body.collides = false;
      world.bodies.push(anchor, body);
      world.links.push(new SpringLink(anchor, body, 0, k, damping));
      return { world, body };
    };
    expectSecondOrder(make, expected);
  });

  it("converges at second order for a velocity-dependent custom field", () => {
    const make = () => {
      const world = new World();
      world.gravity = 0;
      world.substeps = 1;
      world.fields.push(new ForceField("drag", "-vx", "0"));
      const body = new Body(new Vec2(), 0.1, 1);
      body.collides = false;
      body.vel.x = 1;
      world.bodies.push(body);
      return { world, body };
    };
    expectSecondOrder(make, 1 - Math.exp(-1));
  });
});
