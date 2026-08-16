/** Ideal-pulley physics, persistence, placement and dismantling semantics. */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, PULLEY_RADIUS, Wall } from "../src/engine/body";
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
        // A zero-restitution stop removes motion into the wheel without
        // constraining a physically valid tangential slide.
        expect(a.vel.dot(outward)).toBeGreaterThanOrEqual(-1e-7);
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

    wall.b.set(0.5, 1.5);
    world.syncPulleyMounts();
    expect(wheel.pos.x).toBe(0.5);
    expect(wheel.pos.y).toBe(1.5);
    const guideNormal = string.guideAOffset;
    const wallDirection = wall.a.sub(wall.b);
    expect(guideNormal.dot(wallDirection)).toBeCloseTo(0, 12);
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
    expect(link.pulley.pos.x).toBe(wall.b.x);
    expect(link.pulley.pos.y).toBe(wall.b.y);
    expect(link.pulley.isPulley).toBe(true);
    expect(link.pulley.collides).toBe(false);
    const along = link.a.pos.sub(link.guideA());
    const wallAlong = wall.a.sub(wall.b);
    expect(along.x * wallAlong.y - along.y * wallAlong.x).toBeCloseTo(0, 10);
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
    privateController.release([199, -100]);

    expect(wheel.pos.x).toBe(wall.b.x);
    expect(wheel.pos.y).toBe(wall.b.y);
    expect(string.mountWallId).toBe(wall.id);
    expect(string.mountWallEnd).toBe(1);
    expect(wheel.locked).toBe(true);
    expect(wheel.collides).toBe(false);
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
