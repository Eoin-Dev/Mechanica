/** Every number read off a scene file is guarded.
 *
 * Bodies and walls have been checked since the port; links, world settings
 * and colours were not, and each gap had the same shape: one malformed
 * field became a NaN, the NaN reached the solver, and World.sanitize froze
 * every body in the scene and reported "hit a numerical blow-up - check
 * extreme forces or fields". The scene was dead on load and the message
 * blamed the user's physics for it.
 *
 * A guard is only worth having if it is exercised, so each case here loads
 * a deliberately broken scene and then STEPS it: the assertion is that the
 * simulation survives, not merely that a field holds a plausible number.
 */
import { describe, expect, it } from "vitest";
import { colorOr, intIn, numIn, numOr } from "../src/core/guards";
import { Body, Wall } from "../src/engine/body";
import { DistanceLink, SpringLink } from "../src/engine/links";
import { World, WorldDict } from "../src/engine/world";

const DT = 1 / 120;

/** Two bodies a metre apart, plus whatever the caller wants to break. */
function scene(extra: Partial<WorldDict>): World {
  return World.fromDict({
    bodies: [
      { id: 1, pos: [0, 0] }, { id: 2, pos: [1, 0] },
    ] as never,
    ...extra,
  });
}

function steps(w: World, n = 60): World {
  for (let i = 0; i < n; i++) w.step(DT);
  return w;
}

function allFinite(w: World): boolean {
  return w.bodies.every((b) =>
    Number.isFinite(b.pos.x + b.pos.y + b.vel.x + b.vel.y + b.omega));
}

describe("guard primitives", () => {
  it("numOr falls back on anything that is not a finite number", () => {
    expect(numOr(2.5, 9)).toBe(2.5);
    for (const bad of [NaN, Infinity, -Infinity, "3", null, undefined, {}, []]) {
      expect(numOr(bad, 9)).toBe(9);
    }
  });

  it("numIn and intIn clamp as well as default", () => {
    expect(numIn(50, 1, 0, 10)).toBe(10);
    expect(numIn(-50, 1, 0, 10)).toBe(0);
    expect(numIn("x", 1, 0, 10)).toBe(1);
    expect(intIn(3.9, 1, 1, 64)).toBe(3);
    expect(intIn(1e9, 4, 1, 64)).toBe(64);
    expect(intIn(NaN, 4, 1, 64)).toBe(4);
  });

  it("colorOr rejects anything that is not three whole channels", () => {
    expect(colorOr([1, 2, 3], [9, 9, 9])).toEqual([1, 2, 3]);
    expect(colorOr([1.6, -5, 300], [9, 9, 9])).toEqual([2, 0, 255]);
    for (const bad of [[1, 2], "abc", null, undefined, 7, [1, 2, NaN]]) {
      expect(colorOr(bad, [9, 9, 9])).toEqual([9, 9, 9]);
    }
  });

  it("colorOr copies, so two objects never share one array", () => {
    const fallback: [number, number, number] = [9, 9, 9];
    const a = colorOr(null, fallback);
    const b = colorOr(null, fallback);
    a[0] = 1;
    expect(b[0]).toBe(9);
    expect(fallback[0]).toBe(9);
  });
});

describe("world settings", () => {
  it("survives non-finite and non-numeric settings", () => {
    const w = scene({
      settings: {
        gravity: NaN, G: "abc", softening: NaN, drag_linear: NaN,
        drag_quadratic: Infinity, global_damping: NaN, time: NaN,
      },
    } as never);
    // a string in G used to reach the O(n^2) attraction loop directly
    expect(Number.isFinite(w.gravity)).toBe(true);
    expect(Number.isFinite(w.G)).toBe(true);
    expect(Number.isFinite(w.softening)).toBe(true);
    expect(Number.isFinite(w.dragLinear + w.dragQuadratic)).toBe(true);
    expect(Number.isFinite(w.globalDamping)).toBe(true);
    expect(w.time).toBe(0);
    steps(w);
    expect(w.diverged).toEqual([]);
    expect(allFinite(w)).toBe(true);
  });

  it("keeps every legitimate setting exactly", () => {
    const w = scene({
      settings: {
        gravity: -3.5, mutual_gravity: true, point_gravity: true, G: 6.7,
        softening: 0.25, drag_linear: 1.5, drag_quadratic: 2.5,
        global_damping: 0.75, integrator: "RK4", substeps: 7,
        iterations: 12, time: 4.25,
      },
    } as never);
    expect(w.gravity).toBe(-3.5);
    expect(w.G).toBe(6.7);
    expect(w.softening).toBe(0.25);
    expect(w.dragLinear).toBe(1.5);
    expect(w.dragQuadratic).toBe(2.5);
    expect(w.globalDamping).toBe(0.75);
    expect(w.integrator).toBe("RK4");
    expect(w.substeps).toBe(7);
    expect(w.iterations).toBe(12);
    expect(w.time).toBe(4.25);
  });
});

describe("links", () => {
  it("a rod with a broken length falls back to the current separation", () => {
    const w = scene({ links: [{ type: "rod", id: 1, a: 1, b: 2, length: NaN }] as never });
    const rod = w.links[0] as DistanceLink;
    expect(rod.length).toBeCloseTo(1.0, 12); // the bodies are 1 m apart
    steps(w);
    expect(w.diverged).toEqual([]);
    expect(allFinite(w)).toBe(true);
  });

  it("a spring with broken numbers still steps", () => {
    const w = scene({
      links: [{ type: "spring", id: 1, a: 1, b: 2, rest_length: NaN,
                stiffness: NaN, damping: Infinity }] as never,
    });
    const sp = w.links[0] as SpringLink;
    expect(Number.isFinite(sp.restLength + sp.stiffness + sp.damping)).toBe(true);
    steps(w);
    expect(w.diverged).toEqual([]);
    expect(allFinite(w)).toBe(true);
  });

  it("negative stiffness and compliance clamp to zero rather than invert", () => {
    const w = scene({
      links: [{ type: "spring", id: 1, a: 1, b: 2, rest_length: 1,
                stiffness: -500, damping: -5 }] as never,
    });
    const sp = w.links[0] as SpringLink;
    expect(sp.stiffness).toBe(0);
    expect(sp.damping).toBe(0);
  });

  it("round-trips a valid link untouched", () => {
    const src = new World();
    src.bodies = [Body.fromDict({ id: 1, pos: [0, 0] } as never),
                  Body.fromDict({ id: 2, pos: [1.5, 0] } as never)];
    src.links = [new SpringLink(src.bodies[0], src.bodies[1], 1.25, 42.5, 3.5, true),
                 new DistanceLink(src.bodies[0], src.bodies[1], 1.75, true, 1e-4)];
    const w = World.fromDict(JSON.parse(JSON.stringify(src.toDict())));
    const sp = w.links[0] as SpringLink;
    const rod = w.links[1] as DistanceLink;
    expect([sp.restLength, sp.stiffness, sp.damping, sp.tensionOnly])
      .toEqual([1.25, 42.5, 3.5, true]);
    expect([rod.length, rod.isRope, rod.compliance]).toEqual([1.75, true, 1e-4]);
  });
});

describe("fields and drivers", () => {
  it("a non-string formula does not take the whole scene load down", () => {
    // compile() re-throws anything that is not an ExprError, and a number
    // reaching the parser throws a TypeError on .trim()
    const w = scene({ fields: [{ name: 5, fx: 7, fy: null, enabled: true }] as never });
    expect(w.fields).toHaveLength(1);
    steps(w);
    expect(w.diverged).toEqual([]);
  });

  it("a driver with broken numbers is inert rather than poisonous", () => {
    const w = scene({
      drivers: [{ body_id: 1, amplitude: NaN, frequency: NaN, phase: NaN,
                  angle: NaN, enabled: true }] as never,
    });
    steps(w);
    expect(w.diverged).toEqual([]);
    expect(allFinite(w)).toBe(true);
  });
});

describe("colours", () => {
  it("a short or junk body colour becomes a drawable one", () => {
    // [1,2] survived load and then rendered as rgb(1,2,undefined), which
    // canvas ignores - the body drew in whatever colour was set last
    for (const bad of [[1, 2], "red", [NaN, 0, 0], null]) {
      const b = Body.fromDict({ id: 1, pos: [0, 0], color: bad } as never);
      expect(b.color).toHaveLength(3);
      expect(b.color.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)).toBe(true);
    }
  });

  it("a junk wall colour becomes the default grey", () => {
    const w = Wall.fromDict({ a: [0, 0], b: [1, 0], color: [1, 2] } as never);
    expect(w.color).toEqual([150, 155, 165]);
  });

  it("a valid colour is preserved exactly", () => {
    const b = Body.fromDict({ id: 1, pos: [0, 0], color: [12, 34, 56] } as never);
    expect(b.color).toEqual([12, 34, 56]);
  });
});
