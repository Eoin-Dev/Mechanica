import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/core/vec";
import { Body, PULLEY_RADIUS } from "../src/engine/body";
import { PulleyLink } from "../src/engine/links";
import { INTEGRATORS, World } from "../src/engine/world";
import { analysePulley } from "../src/education/analysis";
import { RewindBuffer, structuralDigest } from "../src/scene/snapshot";

function seam(side = -1, mirror = 1) {
  const world = new World(); world.gravity = 0;
  const wheel = new Body(new Vec2(), PULLEY_RADIUS);
  const distance = 2, alpha = Math.acos(PULLEY_RADIUS / distance);
  const angleA = -0.1, angleB = angleA - 2 * alpha + side * 1e-5;
  const a = new Body(new Vec2(distance * Math.cos(angleA), mirror * distance * Math.sin(angleA)), 0.16, 1);
  const b = new Body(new Vec2(distance * Math.cos(angleB), mirror * distance * Math.sin(angleB)), 0.16, 1);
  a.collides = b.collides = false;
  const link = new PulleyLink(a, b, wheel, null, 0,
    new Vec2(-PULLEY_RADIUS, 0), new Vec2(PULLEY_RADIUS, 0), -mirror * Math.PI);
  world.bodies.push(wheel, a, b); world.links.push(link);
  return { world, wheel, a, b, link, angleB, distance };
}

function released() {
  const made = seam();
  made.a.pos.set(-2, -0.5); made.b.pos.set(2, -0.5);
  made.link.length = made.link.currentLength(); made.link.captureSafePositions();
  return made;
}

describe("continuous pulley routing", () => {
  it.each([-1, 1])("releases a vanishing wrap continuously, mirror %s", mirror => {
    const { link, b, angleB, distance } = seam(-1, mirror);
    const before = link.currentLength();
    b.pos.set(distance * Math.cos(angleB + 2e-5), mirror * distance * Math.sin(angleB + 2e-5));
    // Moving one endpoint by 40 micrometres cannot add a wheel circumference.
    expect(Math.abs(link.currentLength() - before)).toBeLessThanOrEqual(4.0001e-5);
    expect(link.geometry().wrapped).toBe(false);
  });

  it.each([-1, 1])("retains a full turn continuously, mirror %s", mirror => {
    const { link, b, angleB, distance } = seam(1, mirror);
    const before = link.currentLength();
    b.pos.set(distance * Math.cos(angleB - 2e-5), mirror * distance * Math.sin(angleB - 2e-5));
    expect(Math.abs(link.currentLength() - before)).toBeLessThanOrEqual(4.0001e-5);
    expect(Math.abs(link.geometry().sweep)).toBeGreaterThan(2 * Math.PI);
  });

  it("reattaches below the wheel instead of passing through it", () => {
    const { link, a, b } = released();
    expect(link.geometry().wrapped).toBe(false);
    expect(link.currentLength()).toBe(4);
    a.pos.y = b.pos.y = -0.1;
    const distance = Math.hypot(2, 0.1);
    // Symmetric shortest path below a circle: two tangent lengths and the
    // lower arc. No force calculation or implementation path is the oracle.
    const expected = 2 * Math.sqrt(distance ** 2 - PULLEY_RADIUS ** 2) +
      2 * PULLEY_RADIUS * (Math.acos(0.1 / distance) - Math.acos(PULLEY_RADIUS / distance));
    const g = link.geometry();
    expect(g.wrapped).toBe(true); expect(g.sweep).toBeGreaterThan(0);
    expect(g.ga.y).toBeLessThan(0); expect(g.gb.y).toBeLessThan(0);
    expect(g.totalLength).toBeCloseTo(expected, 12);
    for (const height of [PULLEY_RADIUS - 1e-6, PULLEY_RADIUS, PULLEY_RADIUS + 1e-6]) {
      a.pos.y = b.pos.y = -height;
      expect(link.currentLength()).toBeCloseTo(4, 10);
      expect(Math.abs(link.geometry().nax + 1)).toBeLessThan(1e-8);
    }
  });

  it("uses relative velocity for a straight string and adds no wheel load", () => {
    const { world, link, a, b } = released();
    a.vel.set(0.3, 0.15); b.vel.set(0.3, 0.15);
    const before = world.toDict(), nextId = PulleyLink.nextId;
    const p = analysePulley(link, world);
    expect(p.tension).toBe(0); expect(p.axleReaction).toBe(0);
    expect(world.toDict()).toEqual(before); expect(PulleyLink.nextId).toBe(nextId);
    a.vel.set(0, 1); b.vel.set(0, -1);
    // Relative transverse speed 2 m/s, length 4 m, reduced mass 1/2 kg:
    // T = (1/2) * 2^2 / 4 = 1/2 N.
    const spinning = analysePulley(link, world);
    expect(spinning.tension).toBeCloseTo(0.5, 12);
    expect(spinning.axleReaction).toBeCloseTo(0, 12);
  });

  it("owns the route through export and rewind after the full-turn seam", () => {
    const { world, link, b, angleB, distance } = seam(1);
    const history = new RewindBuffer(); history.push(world);
    b.pos.set(distance * Math.cos(angleB - 2e-5), distance * Math.sin(angleB - 2e-5));
    world.time = 0.1; history.push(world);
    const length = link.currentLength(), digest = structuralDigest(world);
    const restored = World.fromDict(JSON.parse(JSON.stringify(world.toDict())));
    expect((restored.links[0] as PulleyLink).currentLength()).toBe(length);
    expect(structuralDigest(restored)).toBe(digest);
    expect(Math.abs((restored.links[0] as PulleyLink).geometry().sweep)).toBeGreaterThan(2 * Math.PI);
    b.pos.y -= 0.01; world.time = 0.2; history.push(world);
    const rewound = history.back()!;
    expect(rewound.time).toBe(0.1);
    expect((rewound.links[0] as PulleyLink).currentLength()).toBe(length);
    expect(structuralDigest(rewound)).toBe(digest);
    expect(history.back()!.time).toBe(0);
  });

  it("keeps a legacy scene's initial small wrap and authored string length", () => {
    const { world, link } = seam();
    const document = world.toDict();
    const data = document.links[0];
    if (data.type !== "pulley") throw new Error("Expected pulley");
    delete data.wrap_turns;
    const restored = World.fromDict(JSON.parse(JSON.stringify(document)));
    const back = restored.links[0] as PulleyLink;
    expect(back.length).toBe(link.length);
    expect(back.currentLength()).toBeCloseTo(link.currentLength(), 12);
    expect(Math.abs(back.geometry().sweep)).toBeLessThan(2e-5);
  });

  it("defaults an imported missing length to the actual tangent path", () => {
    const { world, link } = seam();
    const document = world.toDict();
    const data = document.links[0];
    if (data.type !== "pulley") throw new Error("Expected pulley");
    delete (data as Partial<typeof data>).length;
    const restored = World.fromDict(JSON.parse(JSON.stringify(document)));
    expect((restored.links[0] as PulleyLink).length).toBeCloseTo(link.currentLength(), 12);
  });

  it("includes the authored route in current-query and rewind invalidation", () => {
    const { world, link, a, b } = released();
    a.vel.set(0.3, 0.15); b.vel.set(0.3, 0.15);
    expect(analysePulley(link, world).tension).toBe(0);
    const digest = structuralDigest(world);
    link.wrapTurns = 0;
    expect(structuralDigest(world)).not.toBe(digest);
    expect(analysePulley(link, world).tension).toBeGreaterThan(0);
  });

  it("normalizes zero route turns through JSON without changing structural identity", () => {
    const { world, link } = seam(1);
    expect(Object.is(link.wrapTurns, -0)).toBe(false);
    const document = world.toDict();
    const data = document.links[0];
    if (data.type !== "pulley") throw new Error("Expected pulley");
    data.wrap_turns = -0;
    const back = World.fromDict(document);
    expect(Object.is((back.links[0] as PulleyLink).wrapTurns, -0)).toBe(false);
    expect(structuralDigest(back)).toBe(structuralDigest(world));
  });

  it("checks gradients, directional curvature and clear straight paths across varied ports", () => {
    let seed = 29029;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    let direct = 0, reverse = 0;
    for (let i = 0; i < 1500; i++) {
      const sigma = random() < 0.5 ? -1 : 1, aa = random() * 2 * Math.PI;
      const span = 0.1 + random() * (2 * Math.PI - 0.2), ab = aa + sigma * span;
      const wheel = new Body(new Vec2(0.1, -0.2), PULLEY_RADIUS);
      const a = new Body(new Vec2(), 0.16, 1), b = new Body(new Vec2(), 0.16, 1);
      for (const [body, guide, sign] of [[a, aa, -sigma], [b, ab, sigma]] as const) {
        const angle = guide + sign * (0.03 + random() * (Math.PI - 0.06)), distance = 0.5 + random() * 5;
        body.pos.set(wheel.pos.x + distance * Math.cos(angle), wheel.pos.y + distance * Math.sin(angle));
        body.vel.set((random() - 0.5) * 4, (random() - 0.5) * 4);
      }
      const link = new PulleyLink(a, b, wheel, null, 0,
        new Vec2(PULLEY_RADIUS * Math.cos(aa), PULLEY_RADIUS * Math.sin(aa)),
        new Vec2(PULLEY_RADIUS * Math.cos(ab), PULLEY_RADIUS * Math.sin(ab)), sigma * span);
      if (i % 3 === 0) link.wrapTurns = -1;
      else if (i % 3 === 1) link.wrapTurns = 0;
      const g = link.geometry(), h = 1e-5;
      for (const [body, nx, ny] of [[a, g.nax, g.nay], [b, g.nbx, g.nby]] as const) {
        for (const [axis, expected] of [["x", nx], ["y", ny]] as const) {
          const old = body.pos[axis]; body.pos[axis] = old + h; const plus = link.currentLength();
          body.pos[axis] = old - h; const minus = link.currentLength(); body.pos[axis] = old;
          expect(Math.abs((plus - minus) / (2 * h) - expected)).toBeLessThan(1e-7);
        }
      }
      if (!g.wrapped) {
        direct++;
        const d = b.pos.sub(a.pos), t = Math.max(0, Math.min(1, wheel.pos.sub(a.pos).dot(d) / d.length2()));
        expect(a.pos.add(d.mul(t)).distTo(wheel.pos)).toBeGreaterThanOrEqual(PULLEY_RADIUS - 1e-9);
      } else if (Math.sign(g.sweep) !== sigma) reverse++;
      const expected = g.wrapped ?
        (a.vel.x * g.nay - a.vel.y * g.nax) ** 2 / g.da +
        (b.vel.x * g.nby - b.vel.y * g.nbx) ** 2 / g.db :
        ((a.vel.x - b.vel.x) * g.nay - (a.vel.y - b.vel.y) * g.nax) ** 2 / g.totalLength;
      const pa = a.pos.copy(), pb = b.pos.copy(), hh = 1e-4, zero = link.currentLength();
      a.pos = pa.add(a.vel.mul(hh)); b.pos = pb.add(b.vel.mul(hh)); const plus = link.currentLength();
      a.pos = pa.sub(a.vel.mul(hh)); b.pos = pb.sub(b.vel.mul(hh)); const minus = link.currentLength();
      a.pos = pa; b.pos = pb;
      expect(Math.abs((plus - 2 * zero + minus) / (hh * hh) - expected) / Math.max(1, expected)).toBeLessThan(1e-4);
    }
    expect(direct).toBeGreaterThan(100); expect(reverse).toBeGreaterThan(10);
  });

  const cases = INTEGRATORS.flatMap(integrator => [1 / 60, 1 / 120, 1 / 240].flatMap(dt =>
    (["normal", 0, 1, 2, 3] as const).map(mode => ({ integrator, dt, mode }))));
  it.each(cases)("does not inject energy across the seam: $integrator, $dt, $mode", ({ integrator, dt, mode }) => {
    const { world, a, b, link, distance, angleB } = seam();
    world.integrator = integrator; world.performance = mode !== "normal";
    world.performanceLevel = mode === "normal" ? 0 : mode;
    a.showForceComponents = b.showForceComponents = true;
    b.vel.set(-distance * Math.sin(angleB) * 0.004, distance * Math.cos(angleB) * 0.004);
    const g = link.geometry(), rate = b.vel.x * g.nbx + b.vel.y * g.nby;
    a.vel.set(-rate * g.nax, -rate * g.nay);
    const initial = world.energy().ke;
    expect(world.performance).toBe(mode !== "normal");
    expect(world.effectiveIntegrator).toBe(mode === "normal" ? integrator : "Symplectic Euler");
    if (mode !== "normal") expect(world.performanceLevel).toBe(mode);
    for (let i = 0; i < 12; i++) {
      world.step(dt);
      expect(world.energy().ke).toBeLessThanOrEqual(initial + 1e-10);
      expect(link.currentLength()).toBeLessThanOrEqual(link.length + 1e-8);
      expect(a.vel.length()).toBeLessThan(0.01); expect(b.vel.length()).toBeLessThan(0.01);
      for (const body of [a, b]) for (const entry of body.forceSnapshot?.entries ?? []) {
        if (entry.kind === "pulley") expect(entry.axialForce ?? 0).toBeLessThan(1e-3);
        expect(entry.kind).not.toBe("correction");
      }
    }
  });
});
