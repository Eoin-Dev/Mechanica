/** Recipe physics must agree with its advertised model, not just compile. */
import { describe, expect, it } from "vitest";
import { compileExpr, type Env } from "../src/core/expr";
import { Vec2 } from "../src/core/vec";
import { Body } from "../src/engine/body";
import { ForceField, World } from "../src/engine/world";
import { RECIPES, recipeSources } from "../src/ui/guide-recipes";

function recipe(name: string) { return RECIPES.find(candidate => candidate.name === name)!; }
function env(overrides: Partial<Env> = {}): Env {
  const values = { x: 0, y: 0, vx: 0, vy: 0, t: 0, m: 1, ...overrides };
  return { ...values, r: overrides.r ?? Math.hypot(values.x, values.y) };
}
function force(name: string, values: Partial<Env>): Vec2 {
  const source = recipe(name);
  return new Vec2(compileExpr(source.fx)(env(values)), compileExpr(source.fy)(env(values)));
}

describe("quadratic drag recipe", () => {
  it.each([[3, 4], [-4, 3], [-3, -4], [1.25, -7.5], [0, 5], [5, 0], [0, 0]])
    ("opposes velocity (%s, %s) with magnitude proportional to speed squared", (vx, vy) => {
      const value = force("Quadratic drag", { vx, vy });
      const speed = Math.hypot(vx, vy);
      expect(value.x).toBeCloseTo(-0.3 * speed * vx, 12);
      expect(value.y).toBeCloseTo(-0.3 * speed * vy, 12);
      expect(value.length()).toBeCloseTo(0.3 * speed * speed, 12);
    });

  it("rotates with the velocity without selecting a preferred direction", () => {
    const base = new Vec2(3, 4);
    const original = force("Quadratic drag", { vx: base.x, vy: base.y });
    for (const angle of [Math.PI / 6, Math.PI / 3, Math.PI / 2, 5 * Math.PI / 4]) {
      const c = Math.cos(angle), s = Math.sin(angle);
      const turned = force("Quadratic drag", { vx: c * base.x - s * base.y, vy: s * base.x + c * base.y });
      expect(turned.x).toBeCloseTo(c * original.x - s * original.y, 12);
      expect(turned.y).toBeCloseTo(s * original.x + c * original.y, 12);
    }
  });

  it("removes energy at c times speed cubed and scales quadratically", () => {
    const velocity = new Vec2(-3, 4);
    const value = force("Quadratic drag", { vx: velocity.x, vy: velocity.y });
    expect(value.dot(velocity)).toBeCloseTo(-0.3 * velocity.length() ** 3, 12);
    const doubled = force("Quadratic drag", { vx: 2 * velocity.x, vy: 2 * velocity.y });
    expect(doubled.x).toBeCloseTo(4 * value.x, 12);
    expect(doubled.y).toBeCloseTo(4 * value.y, 12);
  });

  it("matches the built-in drag during off-axis motion", () => {
    const worlds = [new World(), new World()];
    worlds.forEach(world => {
      world.gravity = 0;
      world.integrator = "RK4";
      const body = new Body(new Vec2(1, -3), 0.2, 0.75);
      body.collides = false;
      body.vel.set(3, -4);
      world.bodies.push(body);
    });
    worlds[0].dragQuadratic = 0.3;
    const source = recipe("Quadratic drag");
    worlds[1].fields.push(new ForceField(source.name, source.fx, source.fy));
    for (let i = 0; i < 120; i++) worlds.forEach(world => world.step(1 / 120));
    const [builtIn, field] = worlds.map(world => world.bodies[0]);
    expect(field.pos.x).toBeCloseTo(builtIn.pos.x, 12);
    expect(field.pos.y).toBeCloseTo(builtIn.pos.y, 12);
    expect(field.vel.x).toBeCloseTo(builtIn.vel.x, 12);
    expect(field.vel.y).toBeCloseTo(builtIn.vel.y, 12);
  });

  it("follows the analytic speed and distance for free motion", () => {
    const world = new World();
    world.gravity = 0;
    world.integrator = "RK4";
    const body = new Body(new Vec2(0, 0), 0.2, 0.75);
    body.vel.set(3, 4);
    world.bodies.push(body);
    const source = recipe("Quadratic drag");
    world.fields.push(new ForceField(source.name, source.fx, source.fy));
    for (let i = 0; i < 120; i++) world.step(1 / 120);
    // dv/dt = -(c/m)|v|v gives v = v0/(1 + c|v0|t/m).
    expect(body.vel.x).toBeCloseTo(1, 7);
    expect(body.vel.y).toBeCloseTo(4 / 3, 7);
    expect(body.pos.x).toBeCloseTo(1.5 * Math.log(3), 7);
    expect(body.pos.y).toBeCloseTo(2 * Math.log(3), 7);
  });
});

describe("anti-gravity recipe", () => {
  it.each([0, 9.8, 9.81, 10, -4.2, 1.62, 1e-7])
    ("balances current world gravity %s for every mass", gravity => {
      const world = new World();
      world.gravity = gravity;
      const source = recipe("Anti-gravity");
      const resolved = recipeSources(source, gravity);
      world.fields.push(new ForceField(source.name, resolved.fx, resolved.fy));
      [0.001, 1, 7.3, 10000].forEach((mass, i) => {
        const body = new Body(new Vec2(i, -2), 0.2, mass);
        body.collides = false;
        world.bodies.push(body);
      });
      for (let i = 0; i < 120; i++) world.step(1 / 120);
      world.bodies.forEach((body, i) => {
        expect(body.vel.y).toBeCloseTo(0, 12);
        expect(body.pos.x).toBe(i);
        expect(body.pos.y).toBeCloseTo(-2, 12);
      });
    });

  it("captures gravity in portable scene data and does not follow later changes", () => {
    const source = recipe("Anti-gravity");
    const captured = recipeSources(source, 1.62);
    const restored = ForceField.fromDict(JSON.parse(JSON.stringify(
      new ForceField(source.name, captured.fx, captured.fy).toDict())));
    const world = new World();
    world.gravity = 10;
    const body = new Body(new Vec2(0, 0), 0.2, 2);
    world.bodies.push(body);
    world.fields.push(restored);
    expect(restored.error).toBe("");
    world.step(0.01);
    expect(body.vel.y).toBeCloseTo((1.62 - 10) * 0.01, 12);
    expect(recipeSources(source, 9.8)).not.toEqual(captured);
    expect(captured).toEqual({ fx: "0", fy: "m*(1.62)" });
    expect(source.fy).toBe("m*g");
  });

  it.each([123.45678901234567, -123.45678901234567, 1e-7, -1e-7, 0, -0])
    ("preserves gravity %s without rounding", gravity => {
      const { fy } = recipeSources(recipe("Anti-gravity"), gravity);
      expect(compileExpr(fy)(env({ m: 7.3 })) === gravity * 7.3).toBe(true);
    });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite gravity %s", gravity => {
    expect(() => recipeSources(recipe("Anti-gravity"), gravity)).toThrow(RangeError);
  });
});

describe("other recipe models", () => {
  it("adds only the requested context to recipes", () => {
    for (const source of RECIPES.filter(candidate => !candidate.captureGravity)) {
      expect(recipeSources(source, 1.62)).toEqual({ fx: source.fx, fy: source.fy });
    }
  });

  it("keeps every recipe finite at the origin and at rest", () => {
    for (const source of RECIPES) {
      const resolved = recipeSources(source, 9.8);
      expect(Number.isFinite(compileExpr(resolved.fx)(env())), source.name).toBe(true);
      expect(Number.isFinite(compileExpr(resolved.fy)(env())), source.name).toBe(true);
    }
  });

  it("has linear drag opposite motion, dissipating power proportional to speed squared", () => {
    const velocity = new Vec2(-3, 4);
    const value = force("Air drag", { vx: velocity.x, vy: velocity.y });
    expect(value).toEqual(new Vec2(1.5, -2));
    expect(value.dot(velocity)).toBe(-0.5 * velocity.length() ** 2);
  });

  it("places the spring equilibrium below the origin under uniform gravity", () => {
    for (const mass of [0.5, 1, 7.3]) {
      const value = force("Spring to centre", { m: mass, x: 0, y: -mass * 9.8 / 10 });
      expect(value.x).toBeCloseTo(0, 12);
      expect(value.y - mass * 9.8).toBeCloseTo(0, 12);
    }
  });

  it("pulls the gravity well radially and approaches inverse-square scaling", () => {
    const value = force("Gravity well", { x: 3, y: 4 });
    expect(value.x * 4 - value.y * 3).toBeCloseTo(0, 12);
    expect(value.dot(new Vec2(3, 4))).toBeLessThan(0);
    const far = force("Gravity well", { x: 1000, y: 0 }).length();
    const farther = force("Gravity well", { x: 2000, y: 0 }).length();
    expect(far / farther).toBeCloseTo(4, 8);
  });

  it("applies vortex torque without a radial force", () => {
    const radius = new Vec2(3, -4);
    const value = force("Vortex", { x: radius.x, y: radius.y });
    expect(value.dot(radius)).toBeCloseTo(0, 12);
    expect(radius.x * value.y - radius.y * value.x).toBeGreaterThan(0);
  });

  it("gives the cyclone eye a smooth positive tail rather than a cutoff", () => {
    expect(force("Cyclone eye", { x: 0.7, y: 0 }).x / (6 * 0.7)).toBeCloseTo(1 / Math.E, 12);
    expect(force("Cyclone eye", { x: 1, y: 0 }).x).toBeGreaterThan(0);
    expect(force("Cyclone eye", { x: 1.4, y: 0 }).x).toBeLessThan(0.001);
  });

  it("repeats the gust in pi seconds and reaches its stated force range", () => {
    expect(force("Gusty wind", { t: Math.PI / 4 }).x).toBe(4);
    expect(force("Gusty wind", { t: 3 * Math.PI / 4 }).x).toBe(-2);
    for (const t of [0.1, 0.7, 1.2, 8.6]) {
      expect(force("Gusty wind", { t: t + Math.PI }).x).toBeCloseTo(force("Gusty wind", { t }).x, 12);
    }
  });

  it("applies the ceiling only strictly above the threshold", () => {
    expect(force("Ceiling push", { y: 2, m: 3 }).y).toBeCloseTo(0, 12);
    expect(force("Ceiling push", { y: 2.0001, m: 3 }).y).toBeCloseTo(-1.2, 12);
    expect(force("Ceiling push", { y: 1.9999, m: 3 }).y).toBeCloseTo(0, 12);
  });

  it("switches the blinker at each whole second", () => {
    for (const [t, expected] of [[0, 4], [0.9999, 4], [1, -4], [1.9999, -4], [2, 4]]) {
      expect(force("Blinker", { t }).x).toBe(expected);
    }
  });
});
