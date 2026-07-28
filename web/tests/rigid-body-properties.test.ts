/** Physical properties that nothing pinned, found by mutation testing.
 *
 * Each block here corresponds to a deliberate bug that the suite failed to
 * notice: the moment of inertia could be given the wrong constant, a
 * dragged body could stop acting as infinite mass, restitution could be
 * scaled by 20%, the resting threshold could be raised tenfold and global
 * damping could be doubled - all with 650 tests still green.
 *
 * These are user-visible physical claims (how high a ball bounces, whether
 * a stack sits still, whether dragging shoves things), so they are asserted
 * against closed-form answers rather than against recorded output.
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, Wall } from "../src/engine/body";
import { RESTING_SPEED } from "../src/engine/contacts";
import { DistanceLink } from "../src/engine/links";
import { UndoStack } from "../src/scene/snapshot";
import { World } from "../src/engine/world";

const DT = 1 / 120;

function floorWorld(): World {
  const w = new World();
  const floor = new Wall(new Vec2(-50, 0), new Vec2(50, 0), 0.12);
  floor.friction = 0.5;
  floor.restitution = 1.0; // the ball's own e governs (they combine with min)
  w.walls.push(floor);
  w.substeps = 8;
  return w;
}

function run(w: World, seconds: number): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) w.step(DT);
}

describe("moment of inertia", () => {
  it("invInertia is exactly the reciprocal of inertia", () => {
    // They were written out as two independent formulas - I = mr^2/2 and
    // 1/I = 2/(mr^2) - and only invInertia drives the solver, so a wrong
    // `inertia` would not change how anything moves, it would silently
    // misreport the energy and angular momentum of everything spinning.
    for (const [m, r] of [[1, 0.2], [0.05, 0.01], [640, 3.5], [2, 1]] as const) {
      const b = new Body(new Vec2(), r, m);
      expect(b.invInertia).toBeCloseTo(1 / b.inertia, 12);
      expect(b.inertia).toBeCloseTo(0.5 * m * r * r, 12);
    }
  });

  it("is zero-inverse for everything that must not spin", () => {
    const mk = (): Body => new Body(new Vec2(), 0.2, 1);
    const locked = mk(); locked.locked = true;
    const held = mk(); held.held = true;
    const fixed = mk(); fixed.noRotation = true;
    const massless = new Body(new Vec2(), 0.2, 0);
    const pointlike = new Body(new Vec2(), 0, 1);
    for (const b of [locked, held, fixed, massless, pointlike]) {
      expect(b.invInertia).toBe(0);
    }
  });

  it("sets the rolling speed a sliding disc settles at", () => {
    // v_final = v0 / (k + 1) for I = k m r^2, so the disc's k = 1/2 is what
    // makes the classic (2/3) v0 result come out. This pins the constant
    // through the DYNAMICS rather than through the getter.
    const w = floorWorld();
    const b = new Body(new Vec2(0, 0.2), 0.2, 1);
    b.vel.set(3, 0);
    b.friction = 0.5;
    b.restitution = 0;
    w.bodies.push(b);
    run(w, 3);
    expect(b.vel.x).toBeCloseTo(2, 2); // (2/3) * 3
    // rolling without slipping: contact point is stationary
    expect(Math.abs(-b.omega * b.radius - b.vel.x)).toBeLessThan(0.02);
  });

  it("rotational kinetic energy uses the same inertia the solver does", () => {
    const b = new Body(new Vec2(), 0.3, 2);
    b.omega = 5;
    expect(b.kineticEnergy()).toBeCloseTo(0.5 * b.inertia * 25, 12);
  });
});

describe("restitution", () => {
  it("rebounds to about e^2 of the drop height", () => {
    // Energy after a bounce is e^2 of the energy before it, so the ball
    // returns to e^2 of the height it fell from. Heights are measured
    // against the CONTACT height (floor half-thickness + radius), which is
    // where the fall actually ends.
    const REST_Y = 0.06 + 0.2; // floor thickness 0.12, radius 0.2
    for (const e of [0.9, 0.6, 0.3]) {
      const w = floorWorld();
      const dropFrom = 1.5;
      const b = new Body(new Vec2(0, dropFrom), 0.2, 1);
      b.restitution = e;
      b.friction = 0;
      w.bodies.push(b);

      // fall until the first bounce turns the velocity upward
      let bounced = false;
      for (let i = 0; i < Math.round(5 / DT) && !bounced; i++) {
        w.step(DT);
        if (b.vel.y > 0) bounced = true;
      }
      expect(bounced).toBe(true);
      // then climb to the apex, which is where the velocity turns back down
      let peak = b.pos.y;
      for (let i = 0; i < Math.round(5 / DT); i++) {
        w.step(DT);
        if (b.pos.y > peak) peak = b.pos.y;
        if (b.vel.y <= 0) break;
      }
      const fell = dropFrom - REST_Y;
      const rose = peak - REST_Y;
      expect(rose / fell).toBeGreaterThan(0.75 * e * e);
      expect(rose / fell).toBeLessThan(1.15 * e * e);
    }
  });

  it("a perfectly elastic ball keeps its speed through a bounce", () => {
    const w = floorWorld();
    const b = new Body(new Vec2(0, 0.5), 0.2, 1);
    b.restitution = 1;
    b.friction = 0;
    w.gravity = 0;
    b.vel.set(0, -3);
    w.bodies.push(b);
    run(w, 0.5);
    expect(b.vel.y).toBeGreaterThan(0);
    expect(Math.abs(b.vel.y)).toBeCloseTo(3, 1);
  });

  it("a dead ball does not bounce at all", () => {
    const w = floorWorld();
    const b = new Body(new Vec2(0, 0.5), 0.2, 1);
    b.restitution = 0;
    b.friction = 0;
    w.gravity = 0;
    b.vel.set(0, -3);
    w.bodies.push(b);
    run(w, 0.5);
    expect(b.vel.y).toBeLessThan(0.05);
  });
});

describe("the resting threshold", () => {
  // Absolute speeds, deliberately NOT expressed as multiples of
  // RESTING_SPEED. A test written against the constant it is meant to pin
  // moves WITH that constant and can never detect a change to it - which is
  // exactly what happened: the first version of this test imported
  // RESTING_SPEED, and raising it tenfold (turning visibly bouncy balls
  // dead) still passed.
  const bounceSpeedAfter = (approach: number): number => {
    const w = floorWorld();
    w.gravity = 0;
    const b = new Body(new Vec2(0, 0.261), 0.2, 1);
    b.restitution = 1;
    b.friction = 0;
    b.vel.set(0, -approach);
    w.bodies.push(b);
    run(w, 0.3);
    return b.vel.y;
  };

  it("is 0.10 m/s: below it a contact is inelastic", () => {
    expect(RESTING_SPEED).toBeCloseTo(0.1, 12);
    expect(bounceSpeedAfter(0.05)).toBeLessThan(0.05);
  });

  it("above it, a perfectly elastic ball really does bounce", () => {
    expect(bounceSpeedAfter(1.0)).toBeGreaterThan(0.5);
  });

  it("the threshold sits between those two cases", () => {
    // a ball just under bounces far less than one just over
    expect(bounceSpeedAfter(0.08)).toBeLessThan(bounceSpeedAfter(0.5));
  });
});

describe("the undo stack", () => {
  it("remembers far more than a handful of edits", () => {
    // UndoStack.LIMIT is the promise "Ctrl+Z gets you back"; dropping it to
    // 2 was invisible to every test
    const w = new World();
    const stack = new UndoStack(w);
    for (let i = 0; i < 100; i++) {
      w.bodies.push(new Body(new Vec2(i, 0), 0.1, 1));
      stack.push(w);
    }
    let undone = 0;
    while (stack.canUndo) {
      stack.undo();
      undone++;
      if (undone > 500) break; // never loop forever
    }
    expect(undone).toBeGreaterThanOrEqual(100);
  });

  it("redo walks all the way forward again", () => {
    const w = new World();
    const stack = new UndoStack(w);
    for (let i = 0; i < 20; i++) {
      w.bodies.push(new Body(new Vec2(i, 0), 0.1, 1));
      stack.push(w);
    }
    while (stack.canUndo) stack.undo();
    let redone = 0;
    while (stack.canRedo) {
      stack.redo();
      redone++;
    }
    expect(redone).toBe(20);
    expect(stack.redo()).toBeNull();
  });

  it("drops the oldest states rather than growing without bound", () => {
    const w = new World();
    const stack = new UndoStack(w);
    for (let i = 0; i < UndoStack.LIMIT + 60; i++) {
      w.bodies.push(new Body(new Vec2(i, 0), 0.1, 1));
      stack.push(w);
    }
    let depth = 0;
    while (stack.canUndo) {
      stack.undo();
      depth++;
      if (depth > 1000) break;
    }
    expect(depth).toBeLessThanOrEqual(UndoStack.LIMIT);
    expect(depth).toBeGreaterThan(50);
  });

  it("a push that changes nothing is not recorded", () => {
    const w = new World();
    w.bodies.push(new Body(new Vec2(1, 1), 0.1, 1));
    const stack = new UndoStack(w);
    stack.push(w);
    stack.push(w);
    expect(stack.canUndo).toBe(false);
  });
});

describe("a held body is infinite mass", () => {
  it("has zero inverse mass while held, and its own again after", () => {
    const b = new Body(new Vec2(), 0.2, 4);
    expect(b.invMass).toBeCloseTo(0.25, 12);
    b.held = true;
    expect(b.invMass).toBe(0);
    b.held = false;
    expect(b.invMass).toBeCloseTo(0.25, 12);
  });

  it("is not shifted by something heavy slamming into it", () => {
    // this is what makes "hold it still and everything else collides with
    // it" true; dropping `held` from invMass left the grabbed body being
    // shoved out from under the cursor
    const w = new World();
    w.gravity = 0;
    const held = new Body(new Vec2(0, 0), 0.2, 1);
    held.held = true;
    const hammer = new Body(new Vec2(-2, 0), 0.3, 500);
    hammer.vel.set(12, 0);
    w.bodies.push(held, hammer);
    run(w, 1.0);
    expect(Math.abs(held.pos.x)).toBeLessThan(1e-9);
    expect(Math.abs(held.vel.x)).toBeLessThan(1e-9);
    expect(hammer.vel.x).toBeLessThan(0); // it bounced off
  });

  it("still blocks the thing that hit it", () => {
    const w = new World();
    w.gravity = 0;
    const held = new Body(new Vec2(1, 0), 0.2, 1);
    held.held = true;
    const ball = new Body(new Vec2(-1, 0), 0.2, 1);
    ball.vel.set(4, 0);
    w.bodies.push(held, ball);
    run(w, 1.5);
    expect(ball.pos.x).toBeLessThan(held.pos.x); // never passed through
  });
});

describe("global damping", () => {
  it("decays speed at the rate the setting names", () => {
    // v(t) = v0 * exp(-lambda t); doubling lambda internally was invisible
    for (const lambda of [0.5, 2.0]) {
      const w = new World();
      w.gravity = 0;
      w.globalDamping = lambda;
      const b = new Body(new Vec2(), 0.2, 1);
      b.vel.set(10, 0);
      w.bodies.push(b);
      run(w, 1.0);
      const expected = 10 * Math.exp(-lambda);
      expect(b.vel.x).toBeGreaterThan(expected * 0.93);
      expect(b.vel.x).toBeLessThan(expected * 1.07);
    }
  });

  it("damps spin as well as travel", () => {
    const w = new World();
    w.gravity = 0;
    w.globalDamping = 1.0;
    const b = new Body(new Vec2(), 0.2, 1);
    b.omega = 10;
    w.bodies.push(b);
    run(w, 1.0);
    expect(b.omega).toBeLessThan(10 * Math.exp(-1) * 1.07);
    expect(b.omega).toBeGreaterThan(10 * Math.exp(-1) * 0.93);
  });

  it("does nothing at all when it is off", () => {
    const w = new World();
    w.gravity = 0;
    const b = new Body(new Vec2(), 0.2, 1);
    b.vel.set(7, -3);
    w.bodies.push(b);
    run(w, 2.0);
    expect(b.vel.x).toBeCloseTo(7, 9);
    expect(b.vel.y).toBeCloseTo(-3, 9);
  });
});

describe("rod and constraint convergence", () => {
  it("a hanging rod holds its length to sub-millimetre over a minute", () => {
    // reducing the force solver's passes, or defeating the XPBD position
    // loop's convergence exit, both left this green - nothing pinned how
    // exact a rod actually is
    const w = new World();
    const anchor = new Body(new Vec2(0, 0), 0.05, 1);
    anchor.isAnchor = true;
    anchor.locked = true;
    const bob = new Body(new Vec2(1.5, 0), 0.1, 2);
    w.bodies.push(anchor, bob);
    w.links.push(new DistanceLink(anchor, bob, 1.5));
    run(w, 60);
    const len = anchor.pos.distTo(bob.pos);
    expect(Math.abs(len - 1.5)).toBeLessThan(1e-3);
  });
});
