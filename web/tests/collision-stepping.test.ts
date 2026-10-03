/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app";
import { Body, Wall } from "../src/engine/body";
import { Vec2 } from "../src/core/vec";
import { EventTracker, forceLedger } from "../src/education/analysis";
import { World } from "../src/engine/world";
import { RewindBuffer, snapshot } from "../src/scene/snapshot";

function scene(integrator: "Symplectic Euler" | "Velocity Verlet" | "RK4", substeps: number, profile: number): App {
  document.body.replaceChildren();
  const canvas = document.createElement("canvas"); document.body.append(canvas);
  Object.defineProperty(canvas, "clientWidth", { value: 800 });
  Object.defineProperty(canvas, "clientHeight", { value: 600 });
  canvas.getContext = (() => ({ setTransform() {}, fillRect() {}, clearRect() {}, save() {}, restore() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {}, closePath() {},
    measureText: () => ({ width: 10 }), fillText() {}, translate() {}, rotate() {}, scale() {},
    setLineDash() {}, clip() {}, quadraticCurveTo() {}, bezierCurveTo() {}, rect() {}, ellipse() {},
  })) as unknown as HTMLCanvasElement["getContext"];
  const app = new App(canvas); app.newScene(); app.adaptiveDt = false;
  app.world.gravity = 0; app.world.integrator = integrator; app.world.substeps = substeps;
  const body = new Body(new Vec2(0, 0.23), 0.2, 1);
  body.vel.y = -3; body.restitution = 1; body.friction = 0; body.showForceComponents = true;
  const floor = new Wall(new Vec2(-3, 0), new Vec2(3, 0), 0.04);
  floor.restitution = 1; floor.friction = 0;
  app.world.bodies.push(body); app.world.walls.push(floor); app.setSelection([body]);
  if (profile >= 0) {
    app.setPerfMode(true);
    (app as unknown as { setPerformanceLevel(level: number): void }).setPerformanceLevel(profile);
    expect(app.world.performanceLevel).toBe(profile);
  }
  return app;
}

beforeEach(() => localStorage.clear());

describe("collision-time frame stepping", () => {
  it("refines an impact sampled at the end of the displayed interval", () => {
    const app = scene("Velocity Verlet", 1, -1);
    app.ensureInitial(); app.playing = true;
    (app as unknown as { update(dt: number): void }).update(1 / 120);
    expect(app.world.time).toBeCloseTo(1 / 120, 10);
    app.stepBack(); expect(app.world.time).toBeCloseTo(1 / 300, 9);
  });

  it("chooses the earliest simultaneous detection independent of particle order", () => {
    const app = scene("Velocity Verlet", 1, -1);
    const later = app.world.bodies[0]; later.pos.y = 0.2395;
    const earlier = new Body(new Vec2(1, 0.23), 0.2, 1);
    earlier.vel.y = -3; earlier.restitution = 1; earlier.friction = 0;
    app.world.bodies.push(earlier);
    app.stepOnce(); expect(app.world.time).toBeCloseTo(1 / 300, 9);
    app.stepOnce(); expect(app.world.time).toBeCloseTo(0.0065, 9);
    app.stepBack(); expect(app.world.time).toBeCloseTo(1 / 300, 9);
    app.stepBack(); expect(app.world.time).toBe(0);
  });

  it("rewinds through two impacts within the same playback step", () => {
    const app = scene("Velocity Verlet", 1, -1);
    const later = new Body(new Vec2(1, 0.2395), 0.2, 1);
    later.vel.y = -3; later.restitution = 1; later.friction = 0;
    app.world.bodies.push(later);
    app.ensureInitial(); app.playing = true;
    (app as unknown as { update(dt: number): void }).update(1 / 60);
    app.stepBack(); expect(app.world.time).toBeCloseTo(0.0065, 9);
    app.stepBack(); expect(app.world.time).toBeCloseTo(1 / 300, 9);
    app.stepBack(); expect(app.world.time).toBe(0);
  });

  it("does not halt repeatedly on a particle already resting on a surface", () => {
    const app = scene("Velocity Verlet", 8, -1);
    app.world.bodies[0].pos.y = 0.22; app.world.bodies[0].vel.y = 0;
    app.world.gravity = 9.81; app.world.bodies[0].restitution = 0;
    app.world.walls[0].restitution = 0;
    for (let k = 1; k <= 12; k++) {
      app.stepOnce(); expect(app.world.time).toBeCloseTo(k / 60, 9);
    }
  });

  it("does not miss an elastic impact when collision auto-pause is armed", () => {
    const app = scene("Velocity Verlet", 8, -1);
    app.ensureInitial(); app.playing = true; app.pauseOnEvent = "contact";
    (app as unknown as { update(dt: number): void }).update(1 / 60);
    expect(app.playing).toBe(false); expect(app.world.time).toBeCloseTo(1 / 300, 9);
    expect(app.playbackEvents.events.filter(event => event.kind === "contact"))
      .toHaveLength(1);
  });

  it.each([-1, 0, 3])("finds a collision in a coarse Performance checkpoint (profile %s)", profile => {
    const app = scene("Velocity Verlet", 8, profile);
    app.ensureInitial(); app.playing = true;
    (app as unknown as { update(dt: number): void }).update(1 / 60);
    app.stepBack(); expect(app.world.time).toBeCloseTo(1 / 300, 9);
    app.stepBack(); expect(app.world.time).toBe(0);
  });

  it("still finds a later collision while another particle is initially resting", () => {
    const app = scene("Velocity Verlet", 8, -1);
    const resting = app.world.bodies[0]; resting.pos.y = 0.22; resting.vel.y = 0;
    const incoming = new Body(new Vec2(1, 0.23), 0.2, 1);
    incoming.vel.y = -3; incoming.restitution = 1; incoming.friction = 0;
    app.world.bodies.push(incoming);
    app.stepOnce(); expect(app.world.time).toBeCloseTo(1 / 300, 9);
    expect(app.world.bodies.find(body => body.id === incoming.id)!.vel.y).toBeCloseTo(3, 9);
  });

  for (const integrator of ["Symplectic Euler", "Velocity Verlet", "RK4"] as const) {
    it(`resolves an unequal-mass particle impact at contact (${integrator})`, () => {
      const app = scene(integrator, 4, -1), moving = app.world.bodies[0];
      app.world.walls.length = 0; moving.pos.set(-0.41, 1); moving.vel.set(3, 0);
      const target = new Body(new Vec2(0, 1), 0.2, 2);
      target.restitution = 1; target.friction = 0; app.world.bodies.push(target);
      app.stepOnce(); expect(app.world.time).toBeCloseTo(1 / 300, 9);
      expect(app.world.bodies[0].pos.x).toBeCloseTo(-0.4, 9);
      expect(app.world.bodies[0].vel.x).toBeCloseTo(-1, 9);
      expect(app.world.bodies[1].vel.x).toBeCloseTo(2, 9);
      const impulse = app.world.bodies[0].forceSnapshot!;
      expect(impulse.fx * (impulse.endTime - impulse.startTime)).toBeCloseTo(-4, 9);
    });
  }

  it.each([false, true])("refines oblique surfaces and rounded wall endpoints (endpoint %s)", endpoint => {
    const app = scene("Velocity Verlet", 8, -1), body = app.world.bodies[0];
    const normal = endpoint ? new Vec2(1, 0) : new Vec2(-Math.SQRT1_2, Math.SQRT1_2);
    const wall = app.world.walls[0];
    wall.a.set(endpoint ? 0 : -3, endpoint ? 0 : -3);
    wall.b.set(endpoint ? 0 : 3, endpoint ? 0 : 3);
    body.pos.set(normal.x * 0.23, normal.y * 0.23);
    body.vel.set(-normal.x * 3, -normal.y * 3);
    app.stepOnce(); expect(app.world.time).toBeCloseTo(1 / 300, 9);
    expect(app.world.bodies[0].pos.x).toBeCloseTo(normal.x * 0.22, 9);
    expect(app.world.bodies[0].pos.y).toBeCloseTo(normal.y * 0.22, 9);
    expect(app.world.bodies[0].vel.x).toBeCloseTo(normal.x * 3, 9);
    expect(app.world.bodies[0].vel.y).toBeCloseTo(normal.y * 3, 9);
  });

  for (const integrator of ["Symplectic Euler", "Velocity Verlet", "RK4"] as const) {
    for (const substeps of [1, 4, 8]) {
      it.each([-1, 0, 3])(`stops at the analytic wall impact (${integrator}, ${substeps} substeps, profile %s)`, profile => {
        const app = scene(integrator, substeps, profile);
        const id = app.world.bodies[0].id;
        app.stepOnce();
        expect(app.world.time).toBeCloseTo(1 / 300, 9);
        const body = app.world.bodies.find(b => b.id === id)!;
        expect(body.pos.y).toBeCloseTo(0.22, 8); expect(body.vel.y).toBeCloseTo(3, 9);
        expect(app.selection).toEqual([body]); expect(body.showForceComponents).toBe(true);
        const forces = forceLedger(app.world, body);
        if (profile < 0) {
          expect(forces.mode).toBe("step-average");
          const interval = body.forceSnapshot!.endTime - body.forceSnapshot!.startTime;
          const reaction = forces.entries.find(entry => entry.kind === "reaction")!;
          expect(reaction.fy * interval).toBeCloseTo(6, 8);
        } else expect(body.forceSnapshot).toBeNull();
        const impactTime = app.world.time;
        app.stepOnce();
        expect(app.world.time).toBeCloseTo(impactTime + 1 / 60, 9);
        app.stepBack(); expect(app.world.time).toBeCloseTo(impactTime, 9);
        expect(forceLedger(app.world, app.world.bodies[0])).toEqual(forces);
        app.stepBack(); expect(app.world.time).toBe(0);
        app.stepOnce(); expect(app.world.time).toBeCloseTo(impactTime, 9);
      });

      it(`finds an impact inside an ordinary playback frame when rewinding (${integrator}, ${substeps})`, () => {
        const app = scene(integrator, substeps, -1);
        app.ensureInitial(); app.playing = true;
        (app as unknown as { update(dt: number): void }).update(1 / 60);
        expect(app.world.time).toBeCloseTo(1 / 60, 10);
        app.stepBack();
        expect(app.world.time).toBeCloseTo(1 / 300, 9);
        expect(app.world.bodies[0].pos.y).toBeCloseTo(0.22, 8);
        expect(app.world.bodies[0].vel.y).toBeCloseTo(3, 9);
        expect(forceLedger(app.world, app.world.bodies[0]).entries.some(entry => entry.kind === "reaction")).toBe(true);
        app.stepBack(); expect(app.world.time).toBe(0);
      });
    }
  }
});

describe("contact observations and replay ownership", () => {
  it("keeps contact beginnings and ends inside a step without duplicate observations", () => {
    const app = scene("Velocity Verlet", 8, -1), world = app.world;
    world.trackContactEvents = true;
    const tracker = new EventTracker(); tracker.prime(world);
    world.step(1 / 60);
    expect(world.contacts).toHaveLength(0);
    const rows = tracker.observe(world).filter(event => event.kind.startsWith("contact"));
    expect(rows.map(event => event.kind)).toEqual(["contact", "contact-end"]);
    expect(rows[0].time).toBeLessThan(rows[1].time);
    expect(tracker.observe(world)).toEqual([]);
    expect(tracker.events.filter(event => event.kind.startsWith("contact"))).toHaveLength(2);
  });

  it.each(["Symplectic Euler", "Velocity Verlet", "RK4"] as const)(
    "does not change %s physics when contact observations are enabled", integrator => {
      const app = scene(integrator, 8, -1), observed = app.world;
      const control = World.fromDict(observed.toDict()); observed.trackContactEvents = true;
      for (let k = 0; k < 100; k++) {
        observed.step(1 / 120); control.step(1 / 120);
        expect(snapshot(observed)).toBe(snapshot(control));
      }
    });

  it("owns replay recipes, charges their storage, and releases them on rewind", () => {
    const world = new World(), buffer = new RewindBuffer(); buffer.push(world);
    const baseline = buffer.bytesUsed;
    world.time = 0.01;
    const interval = { steps: [{ dt: 0.01, performance: false, performanceLevel: 0 }],
      contacts: [{ step: 0, time: 0.005, key: "wall:0:0" }] };
    buffer.push(world, interval); expect(buffer.bytesUsed).toBeGreaterThan(baseline);
    interval.steps[0].dt = 100; interval.contacts[0].key = "changed";
    const detached = buffer.previousInterval()!;
    expect(detached.interval.steps[0].dt).toBe(0.01);
    expect(detached.interval.contacts[0].key).toBe("wall:0:0");
    detached.interval.steps[0].dt = 200;
    expect(buffer.previousInterval()!.interval.steps[0].dt).toBe(0.01);
    expect(buffer.back()!.time).toBe(0); expect(buffer.bytesUsed).toBe(baseline);
  });
});
