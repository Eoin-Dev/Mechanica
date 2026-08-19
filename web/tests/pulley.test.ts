/** Ideal-pulley physics, persistence, placement and dismantling semantics. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, PULLEY_PARTICLE_RADIUS, PULLEY_RADIUS, Wall } from "../src/engine/body";
import { DistanceLink, PulleyLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { CanvasController } from "../src/interact/tools";
import { structuralDigest } from "../src/scene/snapshot";
import type { App } from "../src/app";
import type { Selectable } from "../src/render/draw";

function assembly(mA = 1, mB = 2): {
  world: World; a: Body; b: Body; wheel: Body; string: PulleyLink;
} {
  const world = new World();
  world.substeps = 4;
  world.iterations = 8;
  const wheel = new Body(new Vec2(0, 1), PULLEY_RADIUS);
  wheel.isPulley = true;
  wheel.isAnchor = true;
  wheel.locked = true;
  wheel.collides = false;
  wheel.name = "Pulley";
  const a = new Body(new Vec2(-PULLEY_RADIUS, -0.25), 0.12, mA);
  const b = new Body(new Vec2(PULLEY_RADIUS, -0.25), 0.12, mB);
  a.noRotation = true;
  b.noRotation = true;
  const string = new PulleyLink(a, b, wheel);
  world.bodies.push(wheel, a, b);
  world.links.push(string);
  return { world, a, b, wheel, string };
}

describe("ideal pulley constraint", () => {
  it("couples unequal masses with equal-tension Atwood acceleration", () => {
    const { world, a, b, string } = assembly(1, 2);
    world.integrator = "Symplectic Euler";
    const expected = world.gravity * (2 - 1) / (2 + 1);
    world.step(1 / 1200);
    // a is the light mass and moves up; b is the heavy mass and moves down.
    expect(a.vel.y).toBeCloseTo(expected / 1200, 5);
    expect(b.vel.y).toBeCloseTo(-expected / 1200, 5);
    expect(string.currentLength()).toBeCloseTo(string.length, 8);
  });

  it("never pushes when there is slack", () => {
    const { world, a, b, string } = assembly(1, 2);
    string.length += 0.5;
    world.integrator = "Symplectic Euler";
    world.step(1 / 120);
    expect(a.vel.y).toBeCloseTo(-world.gravity / 120, 10);
    expect(b.vel.y).toBeCloseTo(-world.gravity / 120, 10);
    expect(string.mu).toBe(0);
  });

  it("moves the wheel contact points as either particle swings", () => {
    const { world, a, b, wheel, string } = assembly(1, 1.4);
    a.vel.x = -1.2;
    b.vel.x = 0.8;
    for (let i = 0; i < 240; i++) world.step(1 / 480);
    const geom = string.geometry();
    const radialA = geom.ga.sub(wheel.pos);
    const legA = a.pos.sub(geom.ga);
    const radialB = geom.gb.sub(wheel.pos);
    const legB = b.pos.sub(geom.gb);
    // Radius and tangent are perpendicular at both moving contact points.
    expect(radialA.dot(legA)).toBeCloseTo(0, 8);
    expect(radialB.dot(legB)).toBeCloseTo(0, 8);
    expect(string.currentLength()).toBeLessThanOrEqual(string.length + 2e-5);
  });

  it("stops a rising particle at the wheel without an energy explosion", () => {
    const { world, a, b, wheel } = assembly(1, 1);
    world.integrator = "Symplectic Euler";
    a.vel.y = 3.0;
    b.vel.y = -3.0;
    const initialKinetic = world.energy().ke;
    let touched = false;
    let peakKinetic = initialKinetic;
    for (let i = 0; i < 960; i++) {
      world.step(1 / 960);
      const d = a.pos.distTo(wheel.pos);
      const limit = wheel.radius + a.radius;
      expect(d).toBeGreaterThanOrEqual(limit - 1e-9);
      if (d <= limit + 1e-7) {
        touched = true;
        const outward = a.pos.sub(wheel.pos).div(d);
        // The terminal block preserves only motion directly away from the
        // wheel. It cannot retain a tangent component and skate around it.
        expect(a.vel.dot(outward)).toBeGreaterThanOrEqual(-1e-7);
        expect(Math.abs(a.vel.x * outward.y - a.vel.y * outward.x))
          .toBeLessThan(1e-7);
      }
      const kinetic = world.energy().ke;
      expect(Number.isFinite(kinetic)).toBe(true);
      peakKinetic = Math.max(peakKinetic, kinetic);
    }
    expect(touched).toBe(true);
    // Equal masses exchange height before contact, so gravity supplies no net
    // energy. The stop may dissipate it but must never create a spike.
    expect(peakKinetic).toBeLessThanOrEqual(initialKinetic * 1.01);
  });

  it.each([false, true])("sweeps fast particles before they tunnel through the wheel (performance=%s)",
    (performance) => {
      const { world, a, wheel, string } = assembly(1, 1);
      world.gravity = 0;
      world.performance = performance;
      world.performanceLevel = 3;
      string.length = 100; // isolate the wheel stop from string tension
      a.pos.set(-1, 1);
      a.vel.set(240, 0);
      const initial = world.energy().ke;

      world.step(1 / 60);

      expect(a.pos.x).toBeLessThan(0);
      expect(a.pos.distTo(wheel.pos)).toBeGreaterThanOrEqual(
        wheel.radius + a.radius - 1e-9);
      expect(a.vel.x).toBeLessThanOrEqual(1e-9);
      expect(world.energy().ke).toBeLessThanOrEqual(initial * 1.000001);
    });

  it.each([false, true])("blocks an outside-disc route to the opposite side (performance=%s)",
    (performance) => {
      const { world, a, b, wheel, string } = assembly(1, 1);
      world.gravity = 0;
      world.performance = performance;
      world.performanceLevel = 3;
      string.length = 100; // isolate the topology guard from tension
      a.pos.set(-2, wheel.pos.y - 0.5);
      a.vel.set(0, 180); // misses the wheel, but crosses the A-side route
      b.vel.set(0, 0);
      const initial = world.energy().ke;

      world.step(1 / 60);

      expect(string.branchDistance("a")).toBeGreaterThanOrEqual(-1e-10);
      expect(a.pos.y).toBeLessThanOrEqual(wheel.pos.y + 1e-10);
      expect(a.vel.length()).toBeLessThan(1e-9);
      expect(b.vel.length()).toBeLessThan(1e-9);
      expect(world.energy().ke).toBeLessThanOrEqual(initial * 1.000001);
    });

  it.each([
    ["Velocity Verlet", false], ["Symplectic Euler", false], ["RK4", false],
    ["Velocity Verlet", true], ["Symplectic Euler", true], ["RK4", true],
  ] as const)("remains finite under a hostile stop (%s, performance=%s)",
    (integrator, performance) => {
      const { world, a, b, wheel, string } = assembly(0.01, 100);
      world.gravity = 0;
      world.integrator = integrator;
      world.performance = performance;
      world.performanceLevel = 3;
      a.pos.set(-PULLEY_RADIUS, wheel.pos.y - 0.42);
      b.pos.set(PULLEY_RADIUS, wheel.pos.y - 2.2);
      string.length = string.currentLength();
      a.vel.set(0, 45);
      b.vel.set(0, -0.0045); // approximately constraint-compatible momentum
      const initial = world.energy().ke;
      let peak = initial;

      for (let i = 0; i < 180; i++) {
        world.step(1 / 720);
        for (const body of [a, b]) {
          expect(Number.isFinite(body.pos.x)).toBe(true);
          expect(Number.isFinite(body.pos.y)).toBe(true);
          expect(Number.isFinite(body.vel.x)).toBe(true);
          expect(Number.isFinite(body.vel.y)).toBe(true);
          expect(body.pos.distTo(wheel.pos)).toBeGreaterThanOrEqual(
            wheel.radius + body.radius - 1e-8);
        }
        expect(string.branchDistance("a")).toBeGreaterThanOrEqual(-1e-8);
        expect(string.branchDistance("b")).toBeGreaterThanOrEqual(-1e-8);
        peak = Math.max(peak, world.energy().ke);
      }
      expect(peak).toBeLessThanOrEqual(initial * 1.02 + 1e-8);
    });

  it("stops tangent motion at the wheel instead of orbiting around it", () => {
    const { world, a, wheel, string } = assembly(1, 1);
    world.gravity = 0;
    string.length = 100;
    a.pos.set(wheel.pos.x, wheel.pos.y - wheel.radius - a.radius);
    a.vel.set(80, 0);

    world.step(1 / 60);

    expect(a.pos.x).toBeCloseTo(wheel.pos.x, 12);
    expect(a.vel.length()).toBeLessThan(1e-9);
    expect(a.pos.distTo(wheel.pos)).toBeCloseTo(wheel.radius + a.radius, 10);
  });

  it("reports realised net force after support impulses", () => {
    const world = new World();
    world.substeps = 8;
    const body = new Body(new Vec2(0, 0.1), 0.1, 1);
    body.noRotation = true;
    body.restitution = 0;
    const floor = new Wall(new Vec2(-2, 0), new Vec2(2, 0), 0);
    floor.restitution = 0;
    world.bodies.push(body);
    world.walls.push(floor);
    for (let i = 0; i < 120; i++) world.step(1 / 120);

    expect(body.acc.y).toBeLessThan(-9); // smooth-force sample still has gravity
    expect(Math.abs(body.netForce.y)).toBeLessThan(0.1); // support cancels it
  });

  it.each([0, 1, 2, 3])("stays taut and finite at Performance level %s", (level) => {
    const { world, string } = assembly(0.75, 3.5);
    world.performance = true;
    world.performanceLevel = level;
    for (let i = 0; i < 360; i++) world.step(1 / 240);
    expect(world.bodies.every((body) =>
      Number.isFinite(body.pos.x) && Number.isFinite(body.pos.y) &&
      Number.isFinite(body.vel.x) && Number.isFinite(body.vel.y))).toBe(true);
    // Contact resolution runs after link projection, as it does for rods, so
    // a final contact may leave a sub-millimetre residual for the next step.
    expect(string.currentLength()).toBeLessThanOrEqual(string.length + 5e-4);
  });
});

describe("pulley lifecycle", () => {
  it("deleting only the wheel preserves both particles and the full string", () => {
    const { world, a, b, wheel, string } = assembly();
    const total = string.length;
    world.removeBody(wheel);
    expect(world.bodies).toEqual([a, b]);
    expect(world.links).toHaveLength(1);
    const released = world.links[0];
    expect(released).toBeInstanceOf(DistanceLink);
    expect((released as DistanceLink).isRope).toBe(true);
    expect((released as DistanceLink).length).toBe(total);
  });

  it("deleting the string removes only the wheel", () => {
    const { world, a, b, wheel, string } = assembly();
    world.removeLink(string);
    expect(world.links).toEqual([]);
    expect(world.bodies).toEqual([a, b]);
    expect(world.bodies).not.toContain(wheel);
  });

  it.each(["a", "b"] as const)("deleting particle %s dismantles everything except its partner", (key) => {
    const made = assembly();
    const gone = made[key];
    const survivor = key === "a" ? made.b : made.a;
    made.world.removeBody(gone);
    expect(made.world.links).toEqual([]);
    expect(made.world.bodies).toEqual([survivor]);
  });
});

describe("wall mounting and persistence", () => {
  it("keeps the wall-side leg parallel and follows an edited endpoint", () => {
    const { world, a, string, wheel } = assembly();
    const wall = new Wall(new Vec2(-2, 0), new Vec2(0, 1));
    world.walls.push(wall);
    world.mountPulley(string, wall, 1);
    const inward = wall.a.sub(wall.b);
    const inwardUnit = inward.div(inward.length());
    a.pos = wheel.pos.add(string.guideAOffset).add(inwardUnit.mul(1.35));
    const leg = a.pos.sub(string.guideA());
    expect(leg.x * inward.y - leg.y * inward.x).toBeCloseTo(0, 12);
    const wallDirection0 = wall.b.sub(wall.a);
    const centreOffset0 = a.pos.sub(wall.b);
    const planeDistance0 = Math.abs(wallDirection0.x * centreOffset0.y -
      wallDirection0.y * centreOffset0.x) / wallDirection0.length();
    expect(planeDistance0).toBeCloseTo(wall.thickness * 0.5 + a.radius, 12);

    wall.b.set(0.5, 1.5);
    world.syncPulleyMounts();
    const guideNormal = string.guideAOffset;
    const wallDirection = wall.a.sub(wall.b);
    expect(guideNormal.dot(wallDirection)).toBeCloseTo(0, 12);
    const normal = guideNormal.div(guideNormal.length());
    const axleOffset = wall.thickness * 0.5 + PULLEY_PARTICLE_RADIUS - PULLEY_RADIUS;
    expect(wheel.pos.x).toBeCloseTo(wall.b.x + normal.x * axleOffset, 12);
    expect(wheel.pos.y).toBeCloseTo(wall.b.y + normal.y * axleOffset, 12);
  });

  it("owns both particle radii while routed and releases them after dismantling", () => {
    const { world, a, b, string } = assembly();
    expect(a.radius).toBe(PULLEY_PARTICLE_RADIUS);
    expect(b.radius).toBe(PULLEY_PARTICLE_RADIUS);
    a.radius = 3;
    b.radius = 0.01;
    world.step(1 / 120);
    expect(a.radius).toBe(PULLEY_PARTICLE_RADIUS);
    expect(b.radius).toBe(PULLEY_PARTICLE_RADIUS);

    world.removeLink(string);
    a.radius = 0.3;
    expect(world.isPulleyParticle(a)).toBe(false);
    expect(a.radius).toBe(0.3);
  });

  it("round-trips the assembly and includes its structure in rewind digests", () => {
    const { world, string } = assembly();
    const wall = new Wall(new Vec2(-2, 0), new Vec2(0, 1));
    world.walls.push(wall);
    world.mountPulley(string, wall, 1);
    const before = structuralDigest(world);
    const restored = World.fromDict(JSON.parse(JSON.stringify(world.toDict())));
    const back = restored.links[0];
    expect(back).toBeInstanceOf(PulleyLink);
    expect((back as PulleyLink).pulley.isPulley).toBe(true);
    expect((back as PulleyLink).pulley.locked).toBe(true);
    expect((back as PulleyLink).pulley.collides).toBe(false);
    expect(structuralDigest(restored)).toBe(before);
    (back as PulleyLink).length += 0.1;
    expect(structuralDigest(restored)).not.toBe(before);
  });

  it("rejects shared axles, ordinary axle links, axle drivers and orphan wheels", () => {
    const { world, wheel } = assembly();
    const document = world.toDict();
    const routed = document.links[0];
    document.links.push({ ...routed, id: routed.id + 100 });
    document.links.push({
      type: "rod", id: 9001, a: wheel.id, b: document.bodies[1].id,
      length: 1, is_rope: false, compliance: 0,
    });
    document.drivers.push({
      body_id: wheel.id, amplitude: 5, frequency: 1, phase: 0,
      angle: 0, enabled: true,
    });
    const orphan = new Body(new Vec2(4, 4), PULLEY_RADIUS).toDict();
    orphan.id += 10000;
    orphan.is_pulley = true;
    document.bodies.push(orphan);

    const restored = World.fromDict(document);
    expect(restored.links).toHaveLength(1);
    expect(restored.links[0]).toBeInstanceOf(PulleyLink);
    expect(restored.drivers).toEqual([]);
    expect(restored.bodies.filter((body) => body.isPulley)).toHaveLength(1);
  });
});

describe("pulley tool", () => {
  it("places a complete assembly and snaps to a nearby wall endpoint", () => {
    const world = new World();
    const wall = new Wall(new Vec2(-2, 0), new Vec2(0, 1));
    world.walls.push(wall);
    const stub = {
      world,
      view: { snap: false, vectorScale: 1 },
      selection: [] as Selectable[],
      trails: new Map<number, unknown>(),
      camera: {
        zoom: 100,
        toWorld: (x: number, y: number) => new Vec2(x / 100, -y / 100),
        toScreen: (p: Vec2): [number, number] => [p.x * 100, -p.y * 100],
      },
      beginEdit() {},
      commitEdit() { return "stored" as const; },
      setSelection(value: Selectable[]) { stub.selection = value; },
      invalidateCanvas() {},
      invalidateEnergy() {},
      toast() {},
    };
    const controller = new CanvasController(stub as unknown as App);
    controller.tool = "pulley";
    (controller as unknown as { press(point: [number, number]): void })
      .press([1, -99]); // one screen pixel from wall.b

    expect(world.bodies).toHaveLength(3);
    expect(world.links).toHaveLength(1);
    const link = world.links[0] as PulleyLink;
    expect(link).toBeInstanceOf(PulleyLink);
    expect(link.mountWallId).toBe(wall.id);
    const guideNormal = link.guideAOffset.div(link.guideAOffset.length());
    const axleOffset = wall.thickness * 0.5 + PULLEY_PARTICLE_RADIUS - PULLEY_RADIUS;
    expect(link.pulley.pos.x).toBeCloseTo(wall.b.x + guideNormal.x * axleOffset, 12);
    expect(link.pulley.pos.y).toBeCloseTo(wall.b.y + guideNormal.y * axleOffset, 12);
    expect(link.pulley.isPulley).toBe(true);
    expect(link.pulley.collides).toBe(false);
    const along = link.a.pos.sub(link.guideA());
    const wallAlong = wall.a.sub(wall.b);
    expect(along.x * wallAlong.y - along.y * wallAlong.x).toBeCloseTo(0, 10);
    const centreOffset = link.a.pos.sub(wall.b);
    const planeDistance = Math.abs(wallAlong.x * centreOffset.y -
      wallAlong.y * centreOffset.x) / wallAlong.length();
    expect(planeDistance).toBeCloseTo(wall.thickness * 0.5 + link.a.radius, 12);
    expect(link.b.pos.x).toBeCloseTo(link.guideB().x, 12);
    expect(stub.selection).toEqual([link]);
  });

  it("drags an existing wheel and mounts it when released near a wall end", () => {
    const { world, wheel, string } = assembly();
    const wall = new Wall(new Vec2(1, 0), new Vec2(2, 1));
    world.walls.push(wall);
    const stub = {
      world,
      playing: false,
      dragHitsWalls: false,
      softBodyHintArmed: false,
      view: { snap: false, vectorScale: 1 },
      selection: [] as Selectable[],
      trails: new Map<number, unknown>(),
      camera: {
        zoom: 100,
        toWorld: (x: number, y: number) => new Vec2(x / 100, -y / 100),
        toScreen: (p: Vec2): [number, number] => [p.x * 100, -p.y * 100],
      },
      beginEdit() {},
      commitEdit() { return "stored" as const; },
      setSelection(value: Selectable[]) { stub.selection = value; },
      invalidateCanvas() {},
      invalidateEnergy() {},
      toast() {},
    };
    const controller = new CanvasController(stub as unknown as App);
    controller.tool = "select";
    const privateController = controller as unknown as {
      mouse: [number, number];
      pressSelect(mouse: [number, number], world: Vec2): void;
      motion(mouse: [number, number]): void;
      release(mouse: [number, number]): void;
    };
    privateController.pressSelect([0, -100], wheel.pos.copy());
    privateController.mouse = [199, -100];
    privateController.motion([199, -100]);
    controller.updateDrag();
    // The latch is visible during the gesture, not deferred until pointer-up.
    const expectedMounted = wheel.pos.copy();
    expect(expectedMounted.distTo(wall.b)).toBeCloseTo(
      Math.abs(wall.thickness * 0.5 + PULLEY_PARTICLE_RADIUS - PULLEY_RADIUS), 12);
    expect(string.mountWallId).toBe(wall.id);

    // A wider 34 px breakaway threshold prevents threshold chatter while
    // still letting the user pull the wheel free deliberately.
    privateController.mouse = [240, -100];
    privateController.motion([240, -100]);
    controller.updateDrag();
    expect(wheel.pos.x).toBeCloseTo(2.4, 10);
    expect(string.mountWallId).toBeNull();

    privateController.mouse = [199, -100];
    privateController.motion([199, -100]);
    controller.updateDrag();
    privateController.release([199, -100]);

    expect(wheel.pos.x).toBeCloseTo(expectedMounted.x, 12);
    expect(wheel.pos.y).toBeCloseTo(expectedMounted.y, 12);
    expect(string.mountWallId).toBe(wall.id);
    expect(string.mountWallEnd).toBe(1);
    expect(wheel.locked).toBe(true);
    expect(wheel.collides).toBe(false);
  });

  it("consumes slack then carries both particles during a paused axle drag", () => {
    const { world, a, b, wheel, string } = assembly();
    string.length += 0.25;
    const oldA = a.pos.copy();
    const oldB = b.pos.copy();
    world.movePulleyForEdit(string, wheel.pos.add(new Vec2(2, 0)));

    expect(string.currentLength()).toBeLessThanOrEqual(string.length + 2e-6);
    expect(a.pos.x).toBeGreaterThan(oldA.x);
    expect(b.pos.x).toBeGreaterThan(oldB.x);
    expect(a.vel.length2()).toBe(0);
    expect(b.vel.length2()).toBe(0);
  });

  it("does not preload the string during a running axle drag", () => {
    const { world, a, wheel, string } = assembly();
    const oldA = a.pos.copy();
    const stub = {
      world,
      playing: true,
      perfMode: false,
      dragHitsWalls: false,
      softBodyHintArmed: false,
      view: { snap: false, vectorScale: 1 },
      selection: [] as Selectable[],
      trails: new Map<number, unknown>(),
      camera: {
        zoom: 100,
        toWorld: (x: number, y: number) => new Vec2(x / 100, -y / 100),
        toScreen: (p: Vec2): [number, number] => [p.x * 100, -p.y * 100],
      },
      beginEdit() {},
      commitEdit() { return "stored" as const; },
      setSelection(value: Selectable[]) { stub.selection = value; },
      invalidateCanvas() {},
      invalidateEnergy() {},
      toast() {},
    };
    const controller = new CanvasController(stub as unknown as App);
    controller.tool = "select";
    const privateController = controller as unknown as {
      mouse: [number, number];
      pressSelect(mouse: [number, number], world: Vec2): void;
      motion(mouse: [number, number]): void;
      release(mouse: [number, number]): void;
    };
    privateController.pressSelect([0, -100], wheel.pos.copy());
    privateController.mouse = [200, -100];
    privateController.motion([200, -100]);
    controller.updateDrag();

    expect(string.currentLength()).toBeLessThanOrEqual(string.length + 2e-6);
    expect(a.pos.x).toBeGreaterThan(oldA.x);
    privateController.release([200, -100]);
  });

  it("box-selects a complete pulley when every other type filter is off", () => {
    const { world, wheel, string } = assembly();
    const stub = {
      world,
      boxFilter: {
        bodies: false, anchors: false, pulleys: true, walls: false,
        springs: false, rods: false,
      },
      camera: {
        toScreen: (p: Vec2): [number, number] => [p.x, p.y],
      },
    };
    const controller = new CanvasController(stub as unknown as App);
    const selected = (controller as unknown as {
      boxContents(rect: { x: number; y: number; w: number; h: number }): Selectable[];
    }).boxContents({ x: -2, y: -2, w: 4, h: 4 });
    expect(selected).toEqual([wheel, string]);
  });
});
