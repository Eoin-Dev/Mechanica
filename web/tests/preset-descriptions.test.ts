/** Every falsifiable claim in every preset description, pinned to its builder.
 *
 * The card text is the teaching material: someone reads "period 2.46 s" and
 * times it against the toolbar clock, or "9 x 7 lattice" and counts. A
 * description that drifts from its builder is worse than no description,
 * because it is believed.
 *
 * This used to be a handful of hand-picked cards inside one grab-bag
 * assertion, which is how "Swinging rope" came to advertise twelve segments
 * while building twenty-four: the audit was per-card and ad hoc, so a card
 * nobody had thought to include was simply never checked. The table below is
 * keyed by preset name and every entry names the phrase it checks, so the
 * coverage test at the bottom can insist that each card carrying a countable
 * claim has an entry - a new preset cannot arrive unaudited.
 */
import { describe, expect, it } from "vitest";
import { Body } from "../src/engine/body";
import { DistanceLink, PulleyLink, SpringLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { CATEGORIES, PRESETS } from "../src/scene/presets";

const find = (n: string): World => {
  const p = PRESETS.find((x) => x.name === n);
  if (!p) throw new Error(`no preset named '${n}'`);
  return p.build();
};

const movers = (w: World): Body[] => w.bodies.filter((b) => b.invMass !== 0);
const fixed = (w: World): Body[] => w.bodies.filter((b) => b.invMass === 0);
const anchors = (w: World): Body[] => w.bodies.filter((b) => b.isAnchor);
const springs = (w: World): SpringLink[] =>
  w.links.filter((l): l is SpringLink => l instanceof SpringLink);
const rods = (w: World): DistanceLink[] =>
  w.links.filter((l): l is DistanceLink => l instanceof DistanceLink);
const deg = (rad: number): number => (rad * 180) / Math.PI;
const heaviest = (bs: Body[]): Body => bs.reduce((a, b) => (a.mass > b.mass ? a : b));
const lightest = (bs: Body[]): Body => bs.reduce((a, b) => (a.mass < b.mass ? a : b));

type Claim = [phrase: string, check: (w: World) => void];

const CARD_CLAIMS: Record<string, Claim[]> = {
  "Earth & Moon": [
    ["Momentum is balanced so the pair orbits its centre of mass",
      (w) => expect(w.momentum().length()).toBeLessThan(1e-9)],
  ],

  "Kepler ellipse": [
    ["Launching a planet below circular speed", (w) => {
      const star = fixed(w)[0];
      const p = movers(w)[0];
      const r = p.pos.distTo(star.pos);
      expect(p.vel.length()).toBeLessThan(Math.sqrt((w.G * star.mass) / r));
    }],
  ],

  "Inner planets": [
    ["Four planets", (w) => expect(movers(w)).toHaveLength(4)],
    ["on circular orbits", (w) => {
      const star = fixed(w)[0];
      for (const p of movers(w)) {
        const r = p.pos.distTo(star.pos);
        expect(p.vel.length()).toBeCloseTo(Math.sqrt((w.G * star.mass) / r), 9);
      }
    }],
    ["Orbital period grows with radius", (w) => {
      const star = fixed(w)[0];
      const rs = movers(w).map((p) => p.pos.distTo(star.pos));
      expect(new Set(rs).size).toBe(rs.length); // four distinct radii
    }],
  ],

  "Binary stars": [
    ["Two equal stars", (w) => {
      const ms = movers(w).map((b) => b.mass).sort((a, b) => b - a);
      expect(ms[0]).toBe(ms[1]);
      expect(ms[2]).toBeLessThan(ms[1]);
    }],
    ["a distant planet circles the pair", (w) => {
      const bs = movers(w);
      const planet = lightest(bs);
      const stars = bs.filter((b) => b !== planet);
      const nearest = Math.min(...stars.map((s) => planet.pos.distTo(s.pos)));
      expect(nearest).toBeGreaterThan(2 * stars[0].pos.distTo(stars[1].pos));
    }],
  ],

  "Gravity slingshot": [
    ["A tiny probe ... a moving planet", (w) => {
      const bs = movers(w);
      expect(bs).toHaveLength(2);
      const probe = lightest(bs);
      const planet = heaviest(bs);
      expect(probe.mass).toBeLessThan(planet.mass / 1000);
      expect(planet.vel.length()).toBeGreaterThan(0);
    }],
  ],

  "Newton's cannon": [
    ["past sqrt(2) times that, it escapes forever", (w) => {
      const planet = fixed(w)[0];
      const shots = movers(w);
      const vCirc = Math.sqrt((w.G * planet.mass) / shots[0].pos.distTo(planet.pos));
      const ratios = shots.map((b) => b.vel.length() / vCirc);
      expect(Math.max(...ratios)).toBeGreaterThan(Math.SQRT2);
      // exactly one shot is above escape speed, as the labels claim
      expect(ratios.filter((r) => r > Math.SQRT2)).toHaveLength(1);
    }],
    ["fire a cannonball sideways from a mountain", (w) => {
      for (const b of movers(w)) expect(b.vel.y).toBe(0);
    }],
    ["at circular speed it orbits", (w) => {
      const planet = fixed(w)[0];
      const shots = movers(w);
      const vCirc = Math.sqrt((w.G * planet.mass) / shots[0].pos.distTo(planet.pos));
      const ratios = shots.map((b) => b.vel.length() / vCirc);
      expect(ratios.some((r) => Math.abs(r - 1) < 1e-9)).toBe(true);
    }],
  ],

  "Trojan asteroids": [
    ["60 degrees ahead (L4) and behind (L5)", (w) => {
      const bs = movers(w);
      const jupiter = heaviest(bs);
      const jAng = Math.atan2(jupiter.pos.y, jupiter.pos.x);
      const lead: number[] = [];
      const trail: number[] = [];
      for (const b of bs) {
        if (b === jupiter) continue;
        let d = deg(Math.atan2(b.pos.y, b.pos.x) - jAng);
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        (d > 0 ? lead : trail).push(d);
      }
      expect(lead).toHaveLength(6);  // "the swarms", one at each point
      expect(trail).toHaveLength(6);
      // the builder jitters by +-0.15 rad (8.6 deg) about the exact angles
      for (const d of lead) expect(Math.abs(d - 60)).toBeLessThan(10);
      for (const d of trail) expect(Math.abs(d + 60)).toBeLessThan(10);
    }],
    ["Asteroids sharing Jupiter's orbit", (w) => {
      const bs = movers(w);
      const jupiter = heaviest(bs);
      const a = jupiter.pos.length();
      for (const b of bs) {
        if (b === jupiter) continue;
        expect(Math.abs(b.pos.length() / a - 1)).toBeLessThan(0.05);
      }
    }],
  ],

  "Sun, Earth & Moon": [
    ["All three move around their shared barycentre", (w) => {
      const bodies = movers(w);
      expect(bodies).toHaveLength(3);
      expect(fixed(w)).toHaveLength(0);
      const mass = bodies.reduce((sum, b) => sum + b.mass, 0);
      const cx = bodies.reduce((sum, b) => sum + b.mass * b.pos.x, 0) / mass;
      const cy = bodies.reduce((sum, b) => sum + b.mass * b.pos.y, 0) / mass;
      expect(cx).toBeCloseTo(0, 14);
      expect(cy).toBeCloseTo(0, 14);
      expect(w.momentum().length()).toBeLessThan(1e-12);
    }],
    ["the Moon sits deep inside Earth's Hill sphere", (w) => {
      const [sun, earth, moon] = movers(w).sort((a, b) => b.mass - a.mass);
      const hill = earth.pos.distTo(sun.pos) * Math.cbrt(earth.mass / (3 * sun.mass));
      expect(earth.pos.distTo(moon.pos)).toBeLessThan(hill * 0.5);
    }],
  ],

  "Three-body figure-8": [
    ["three equal masses", (w) => {
      const ms = movers(w).map((b) => b.mass);
      expect(ms).toHaveLength(3);
      expect(new Set(ms).size).toBe(1);
    }],
    ["the celebrated choreography (G = m = 1, point masses)", (w) => {
      expect(w.G).toBe(1);
      expect(movers(w)[0].mass).toBe(1);
      expect(w.pointGravity).toBe(true);
    }],
  ],

  "Lagrange's triangle": [
    ["three bodies at an equilateral triangle", (w) => {
      const bs = movers(w);
      expect(bs).toHaveLength(3);
      const sides = [bs[0].pos.distTo(bs[1].pos), bs[1].pos.distTo(bs[2].pos),
                     bs[2].pos.distTo(bs[0].pos)];
      for (const s of sides) expect(s).toBeCloseTo(sides[0], 9);
    }],
    ["For equal masses it is unstable",
      (w) => expect(new Set(movers(w).map((b) => b.mass)).size).toBe(1)],
  ],

  "Choreography: moth": [
    ["three equal masses", (w) => {
      expect(movers(w)).toHaveLength(3);
      expect(new Set(movers(w).map((b) => b.mass)).size).toBe(1);
    }],
  ],

  "Choreography: butterfly": [
    // the card says "periodic three-body solution"; equal masses are what
    // makes it one, so that is what the claim resolves to
    ["Another genuine periodic three-body solution", (w) => {
      expect(movers(w)).toHaveLength(3);
      expect(new Set(movers(w).map((b) => b.mass)).size).toBe(1);
    }],
  ],

  "Pythagorean three-body": [
    ["masses 3, 4 and 5",
      (w) => expect(movers(w).map((b) => b.mass).sort()).toEqual([3, 4, 5])],
    ["dropped at rest", (w) => {
      for (const b of movers(w)) expect(b.vel.length()).toBe(0);
    }],
    ["from a 3-4-5 triangle", (w) => {
      const bs = movers(w);
      const sides = [bs[0].pos.distTo(bs[1].pos), bs[1].pos.distTo(bs[2].pos),
                     bs[2].pos.distTo(bs[0].pos)].sort((a, b) => a - b);
      expect(sides[0]).toBeCloseTo(3, 9);
      expect(sides[1]).toBeCloseTo(4, 9);
      expect(sides[2]).toBeCloseTo(5, 9);
    }],
  ],

  "Simple pendulum": [
    ["this 1.5 m rod", (w) => expect(rods(w)[0].length).toBeCloseTo(1.5, 9)],
    ["roughly 2.46 s", (w) => {
      expect(2 * Math.PI * Math.sqrt(rods(w)[0].length / w.gravity))
        .toBeCloseTo(2.46, 2);
    }],
    ["A small-angle pendulum", (w) => {
      const pivot = anchors(w)[0];
      const bob = movers(w)[0];
      const off = deg(Math.atan2(bob.pos.x - pivot.pos.x, -(bob.pos.y - pivot.pos.y)));
      expect(Math.abs(off)).toBeLessThan(30); // small-angle regime
    }],
  ],

  "Double pendulum": [
    ["Two links", (w) => expect(rods(w)).toHaveLength(2)],
    ["released from high up", (w) => {
      const pivot = anchors(w)[0];
      const rod = rods(w).find((r) => r.a === pivot || r.b === pivot)!;
      const first = rod.a === pivot ? rod.b : rod.a;
      const off = deg(Math.atan2(first.pos.x - pivot.pos.x,
                                 -(first.pos.y - pivot.pos.y)));
      expect(Math.abs(off)).toBeGreaterThan(90); // above the horizontal
    }],
  ],

  "Triple pendulum": [
    ["Three rigid links", (w) => expect(rods(w)).toHaveLength(3)],
  ],

  "Swinging rope": [
    ["Twenty-four elastic string segments", (w) => {
      const segs = springs(w).filter((s) => s.tensionOnly);
      expect(segs).toHaveLength(24);
      expect(w.links).toHaveLength(24); // every link is one of them
      // the builder's own claim: total length unchanged at 2.64 m
      expect(segs.reduce((s, l) => s + l.restLength, 0)).toBeCloseTo(2.64, 6);
    }],
    ["taut ones ... slack ones carry nothing", (w) => {
      for (const s of springs(w)) expect(s.tensionOnly).toBe(true);
    }],
  ],

  "Newton's cradle": [
    ["Five balls on strings", (w) => {
      expect(movers(w)).toHaveLength(5);
      expect(rods(w)).toHaveLength(5);
      expect(anchors(w)).toHaveLength(5);
    }],
    ["Elastic collisions", (w) => {
      for (const b of movers(w)) expect(b.restitution).toBe(1.0);
    }],
  ],

  "Coupled pendulums": [
    ["Two pendulums joined by a weak spring", (w) => {
      expect(rods(w)).toHaveLength(2);
      expect(springs(w)).toHaveLength(1);
      expect(anchors(w)).toHaveLength(2);
      // "weak": far softer than the pendulum's own restoring stiffness
      const bob = movers(w)[0];
      expect(springs(w)[0].stiffness)
        .toBeLessThan((bob.mass * w.gravity) / rods(w)[0].length);
    }],
  ],

  "Mass on a spring": [
    ["period 2*pi*sqrt(m/k) = 1.26 s", (w) => {
      const sp = springs(w)[0];
      const m = [sp.a, sp.b].find((b) => b.invMass !== 0)!.mass;
      expect(2 * Math.PI * Math.sqrt(m / sp.stiffness)).toBeCloseTo(1.26, 2);
    }],
  ],

  "Damping regimes": [
    ["light, critical and heavy damping", (w) => {
      const ratios = springs(w).map((s) => {
        const m = [s.a, s.b].find((b) => b.invMass !== 0)!.mass;
        return s.damping / (2 * Math.sqrt(s.stiffness * m));
      });
      expect(ratios).toHaveLength(3);
      expect(ratios[0]).toBeLessThan(1);
      expect(ratios[1]).toBeCloseTo(1, 9);
      expect(ratios[2]).toBeGreaterThan(1);
    }],
    ["Identical oscillators",
      (w) => expect(new Set(springs(w).map((s) => s.stiffness)).size).toBe(1)],
  ],

  "Driven resonance": [
    ["A sinusoidal driver tuned to the natural frequency", (w) => {
      const sp = springs(w)[0];
      const bob = [sp.a, sp.b].find((b) => b.invMass !== 0)!;
      expect(w.drivers).toHaveLength(1);
      expect(w.drivers[0].bodyId).toBe(bob.id);
      expect(w.drivers[0].frequency)
        .toBeCloseTo(Math.sqrt(sp.stiffness / bob.mass) / (2 * Math.PI), 9);
    }],
    ["until damping balances the input",
      (w) => expect(springs(w)[0].damping).toBeGreaterThan(0)],
  ],

  "Coupled oscillators": [
    ["Three masses and four springs between two anchors", (w) => {
      expect(anchors(w)).toHaveLength(2);
      expect(movers(w)).toHaveLength(3);
      expect(springs(w)).toHaveLength(4);
    }],
  ],

  "Spring pendulum": [
    ["A bob on a spring that can also swing", (w) => {
      expect(springs(w)).toHaveLength(1);
      expect(rods(w)).toHaveLength(0); // nothing fixes the angle
    }],
  ],

  "Billiard break": [
    ["a five-row rack", (w) => expect(movers(w)).toHaveLength(1 + 2 + 3 + 4 + 5 + 1)],
    ["near-elastic collisions", (w) => {
      for (const b of movers(w)) expect(b.restitution).toBeGreaterThan(0.9);
    }],
    ["cloth drag slows everything",
      (w) => expect(w.globalDamping).toBeGreaterThan(0)],
  ],

  "Restitution ladder": [
    ["Six balls with restitution 0.5 to 1.0", (w) => {
      const es = movers(w).map((b) => b.restitution).sort((a, b) => a - b);
      expect(es).toHaveLength(6);
      expect(es[0]).toBeCloseTo(0.5, 9);
      expect(es[5]).toBeCloseTo(1.0, 9);
    }],
    ["dropped together", (w) => {
      expect(new Set(movers(w).map((b) => b.pos.y)).size).toBe(1);
      for (const b of movers(w)) expect(b.vel.length()).toBe(0);
    }],
  ],

  "Elastic vs inelastic": [
    ["Equal masses, head-on",
      (w) => expect(new Set(movers(w).map((b) => b.mass)).size).toBe(1)],
    ["Elastic (top) ... Perfectly inelastic (bottom)", (w) => {
      const top = movers(w).filter((b) => b.pos.y > 0);
      const bottom = movers(w).filter((b) => b.pos.y < 0);
      expect(top).toHaveLength(2);
      expect(bottom).toHaveLength(2);
      for (const b of top) expect(b.restitution).toBe(1.0);
      for (const b of bottom) expect(b.restitution).toBe(0.0);
    }],
    ["2 m/s into one at rest", (w) => {
      for (const lane of [1, -1]) {
        const pair = movers(w).filter((b) => Math.sign(b.pos.y) === lane);
        const speeds = pair.map((b) => b.vel.length()).sort((a, b) => a - b);
        expect(speeds[0]).toBe(0);
        expect(speeds[1]).toBeCloseTo(2.0, 9);
      }
    }],
  ],

  "Gas in a box (50)": [
    ["Fifty particles", (w) => expect(movers(w)).toHaveLength(50)],
    ["bouncing elastically in zero gravity", (w) => {
      expect(w.gravity).toBe(0);
      for (const b of movers(w)) expect(b.restitution).toBe(1.0);
    }],
  ],

  "Gas in a box (200)": [
    ["Two hundred particles", (w) => expect(movers(w)).toHaveLength(200)],
  ],

  "Brownian motion": [
    ["A heavy grain jostled by a swarm of light, fast particles", (w) => {
      const ms = movers(w).map((b) => b.mass).sort((a, b) => b - a);
      expect(ms[0]).toBeGreaterThan(ms[1] * 50);
      expect(ms.length).toBeGreaterThan(50);
    }],
  ],

  "Projectile drag race": [
    ["Two identical launches", (w) => {
      const bs = movers(w);
      expect(bs).toHaveLength(2);
      expect(bs[0].vel.x).toBe(bs[1].vel.x);
      expect(bs[0].vel.y).toBe(bs[1].vel.y);
      expect(bs[0].radius).toBe(bs[1].radius);
    }],
    ["a custom force field ... selected by mass", (w) => {
      expect(w.fields).toHaveLength(1);
      expect(w.fields[0].error).toBe("");
      const ms = movers(w).map((b) => b.mass);
      expect(new Set(ms).size).toBe(2);           // the selector needs a split
      expect(Math.max(...ms)).toBeGreaterThan(1); // and it splits at m > 1
      expect(Math.min(...ms)).toBeLessThanOrEqual(1);
    }],
  ],

  "Friction ramp": [
    ["Three balls on a 25 degree ramp", (w) => {
      expect(movers(w)).toHaveLength(3);
      const r = w.walls[0];
      expect(Math.abs(deg(Math.atan2(r.b.y - r.a.y, r.b.x - r.a.x))))
        .toBeCloseTo(25, 1);
    }],
    ["frictionless ball slides fastest, moderate friction slows ... high static friction holds", (w) => {
      const mus = movers(w).map((b) => b.friction).sort((a, b) => a - b);
      expect(mus[0]).toBe(0);
      expect(mus[1]).toBeGreaterThan(0);
      expect(mus[2]).toBeGreaterThan(0);
    }],
    ["Three non-rotating balls spread along", (w) => {
      const balls = movers(w).sort((a, b) => a.pos.x - b.pos.x);
      expect(balls.every((b) => b.noRotation)).toBe(true);
      expect(balls.every((b) => b.omega === 0)).toBe(true);
      const gaps = balls.slice(1).map((b, i) => b.pos.distTo(balls[i].pos));
      expect(Math.min(...gaps)).toBeGreaterThan(1.4);
    }],
  ],

  "Pulley on an incline": [
    ["Two particles share one light inextensible string", (w) => {
      expect(movers(w)).toHaveLength(2);
      expect(w.links.filter((link) => link instanceof PulleyLink)).toHaveLength(1);
    }],
  ],

  "Galileo's drop": [
    ["A 10 kg ball and a 0.5 kg ball", (w) => {
      expect(movers(w).map((b) => b.mass).sort((a, b) => b - a)).toEqual([10, 0.5]);
    }],
    ["fall the same distance and land together", (w) => {
      const bottoms = movers(w).map((b) => b.pos.y - b.radius);
      expect(bottoms[0]).toBeCloseTo(bottoms[1], 9);
      expect(w.dragLinear + w.dragQuadratic).toBe(0); // "without air"
    }],
  ],

  "Which lands first?": [
    ["one is also launched sideways at 6 m/s", (w) => {
      const vx = movers(w).map((b) => Math.abs(b.vel.x)).sort((a, b) => a - b);
      expect(vx[0]).toBe(0);
      expect(vx[1]).toBeCloseTo(6, 9);
    }],
    ["Two identical balls ... from the same height", (w) => {
      const bs = movers(w);
      expect(bs).toHaveLength(2);
      expect(bs[0].pos.y).toBe(bs[1].pos.y);
      expect(bs[0].radius).toBe(bs[1].radius);
      expect(bs[0].mass).toBe(bs[1].mass);
      expect(bs[0].restitution).toBe(bs[1].restitution);
      expect(bs[0].friction).toBe(bs[1].friction);
      for (const b of bs) expect(b.vel.y).toBe(0); // released, not thrown
    }],
  ],

  "Projectile angles": [
    ["Four launches at 10 m/s", (w) => {
      expect(movers(w)).toHaveLength(4);
      for (const b of movers(w)) expect(b.vel.length()).toBeCloseTo(10, 9);
    }],
    ["45 degrees flies farthest, and the 30/60 pair", (w) => {
      const ds = movers(w).map((b) => Math.round(deg(Math.atan2(b.vel.y, b.vel.x))));
      for (const want of [30, 45, 60]) expect(ds).toContain(want);
    }],
  ],

  "Terminal velocity": [
    ["the 10x heavier ball falls about 3x faster", (w) => {
      const ms = movers(w).map((b) => b.mass).sort((a, b) => b - a);
      expect(ms[0] / ms[1]).toBeCloseTo(10, 9);
      // v_term = sqrt(mg/c), so ten times the mass is sqrt(10) = 3.16x
      expect(Math.sqrt(ms[0] / ms[1])).toBeCloseTo(3.16, 2);
    }],
    ["Two same-size balls falling with quadratic air drag", (w) => {
      const bs = movers(w);
      expect(bs).toHaveLength(2);
      expect(bs[0].radius).toBe(bs[1].radius);
      expect(w.dragQuadratic).toBeGreaterThan(0);
    }],
  ],

  "Wrecking ball": [
    ["A 22 kg pendulum ball", (w) => {
      const ball = heaviest(movers(w));
      expect(ball.mass).toBe(22);
      expect(rods(w).some((r) => r.a === ball || r.b === ball)).toBe(true);
    }],
    ["demolishes a stack", (w) => {
      const ball = heaviest(movers(w));
      expect(movers(w).filter((b) => b !== ball).length).toBeGreaterThan(10);
    }],
  ],

  "Chain bridge": [
    ["a bridge of elastic string segments", (w) => {
      const segs = springs(w).filter((s) => s.tensionOnly);
      expect(segs.length).toBeGreaterThan(5);
      expect(springs(w)).toHaveLength(segs.length);
      expect(anchors(w)).toHaveLength(2);
    }],
    ["A load dropped onto a bridge", (w) => {
      const load = heaviest(movers(w));
      expect(w.links.some((l) => l.a === load || l.b === load)).toBe(false);
      expect(load.pos.y).toBeGreaterThan(Math.max(...anchors(w).map((a) => a.pos.y)));
    }],
  ],

  "Jelly block": [
    ["A 9 x 7 lattice",
      (w) => expect(w.bodies.filter((b) => b.softBody)).toHaveLength(63)],
    ["structural, shear and bend springs", (w) => {
      const cols = 9;
      const rows = 7;
      const structural = rows * (cols - 1) + cols * (rows - 1);
      const shear = 2 * (cols - 1) * (rows - 1);
      const bend = rows * (cols - 2) + cols * (rows - 2);
      expect(springs(w)).toHaveLength(structural + shear + bend);
      // all three families are really present and distinguishable by length
      expect(new Set(springs(w).map((s) => +s.restLength.toFixed(4))).size).toBe(3);
    }],
  ],

  "Squishy ball": [
    ["each sprung to its six neighbours", (w) => {
      const parts = w.bodies.filter((b) => b.softBody);
      const degree = new Map<number, number>();
      for (const b of parts) degree.set(b.id, 0);
      for (const l of w.links) {
        degree.set(l.a.id, (degree.get(l.a.id) ?? 0) + 1);
        degree.set(l.b.id, (degree.get(l.b.id) ?? 0) + 1);
      }
      // hex packing: six is the maximum and the interior majority
      expect(Math.max(...degree.values())).toBe(6);
      const six = [...degree.values()].filter((d) => d === 6).length;
      expect(six).toBeGreaterThan(parts.length * 0.4);
    }],
    ["Fully triangulated, so it keeps its round shape", (w) => {
      const seen = new Map<number, number>();
      for (const l of w.links) {
        seen.set(l.a.id, (seen.get(l.a.id) ?? 0) + 1);
        seen.set(l.b.id, (seen.get(l.b.id) ?? 0) + 1);
      }
      for (const b of w.bodies.filter((x) => x.softBody)) {
        expect(seen.get(b.id) ?? 0).toBeGreaterThanOrEqual(2); // no free ends
      }
    }],
  ],

  Trampoline: [
    ["two lower anchors and two wall-top anchors", (w) => {
      const fixed = anchors(w);
      expect(fixed).toHaveLength(4);
      for (const wall of w.walls) {
        expect(fixed.some((a) => a.pos.distTo(wall.b) < 1e-12)).toBe(true);
      }
    }],
    ["damped side springs lifting its shoulders", (w) => {
      const topY = Math.max(...anchors(w).map((a) => a.pos.y));
      const top = anchors(w).filter((a) => a.pos.y === topY);
      const side = springs(w).filter((spring) =>
        top.includes(spring.a) || top.includes(spring.b));
      expect(side).toHaveLength(2);
      for (const spring of side) {
        expect(spring.damping).toBe(250); // half the Inspector's 500 maximum
        expect(spring.stiffness).toBe(100000);
        expect(spring.restLength).toBeCloseTo(
          spring.a.pos.distTo(spring.b.pos), 12);
      }
    }],
    ["The ball's energy trades between gravity and spring tension", (w) => {
      const ball = heaviest(movers(w));
      expect(w.links.some((l) => l.a === ball || l.b === ball)).toBe(false);
      expect(ball.pos.x).toBe(0);
      expect(ball.pos.y).toBe(2.6); // existing centre is intentionally unchanged
      expect(ball.radius).toBe(0.36);
    }],
  ],

  "Soft wheel": [
    ["a sprung tread ring with spokes to a hub", (w) => {
      const ring = w.bodies.filter((b) => b.softBody);
      expect(ring.length).toBeGreaterThan(10);
      const hub = movers(w).find((b) => !b.softBody)!;
      const spokes = w.links.filter((l) => l.a === hub || l.b === hub);
      expect(spokes).toHaveLength(ring.length); // one per tread particle
    }],
  ],

  "Jelly smash": [
    ["200-odd springs", (w) => {
      expect(springs(w).length).toBeGreaterThan(180);
      expect(springs(w).length).toBeLessThan(260);
    }],
    ["A rigid wrecking ball meets a soft jelly block", (w) => {
      const ball = heaviest(movers(w));
      expect(ball.softBody).toBe(false);
      expect(rods(w).some((r) => r.a === ball || r.b === ball)).toBe(true);
      expect(w.bodies.filter((b) => b.softBody).length).toBeGreaterThan(20);
    }],
  ],

  "Butterfly effect": [
    ["Three double pendulums", (w) => {
      expect(anchors(w)).toHaveLength(3);
      expect(rods(w)).toHaveLength(6);
      expect(movers(w)).toHaveLength(6);
    }],
    ["released 0.01 degrees apart", (w) => {
      const piv = anchors(w);
      const firstBob = piv.map((p) => {
        const rod = rods(w).find((r) => r.a === p || r.b === p)!;
        return rod.a === p ? rod.b : rod.a;
      });
      const angles = firstBob.map((b, i) =>
        deg(Math.atan2(b.pos.x - piv[i].pos.x, -(b.pos.y - piv[i].pos.y))));
      for (let i = 1; i < angles.length; i++) {
        expect(angles[i] - angles[i - 1]).toBeCloseTo(0.01, 6);
      }
    }],
  ],

  "Orbit dance": [
    ["Fourteen tiny moons ... around one star", (w) => {
      expect(movers(w)).toHaveLength(14);
      expect(fixed(w)).toHaveLength(1);
      const star = fixed(w)[0];
      for (const m of movers(w)) expect(m.mass).toBeLessThan(star.mass / 100);
    }],
    ["on eccentric orbits", (w) => {
      const star = fixed(w)[0];
      const off = movers(w).filter((m) => {
        const r = m.pos.distTo(star.pos);
        return Math.abs(m.vel.length() / Math.sqrt((w.G * star.mass) / r) - 1) > 0.02;
      });
      expect(off.length).toBeGreaterThan(5);
    }],
  ],

  "Sinai billiard": [
    ["a box with a circular scatterer", (w) => {
      expect(w.walls).toHaveLength(4);
      expect(fixed(w)[0].radius).toBeGreaterThan(0.5);
    }],
    ["Two balls launched a hair apart", (w) => {
      const bs = movers(w);
      expect(bs).toHaveLength(2);
      expect(bs[0].pos.distTo(bs[1].pos)).toBeLessThan(0.2);
      expect(Math.abs(bs[0].vel.length() - bs[1].vel.length())).toBeLessThan(0.05);
    }],
    ["while energy stays exactly flat", (w) => {
      expect(w.gravity).toBe(0);
      for (const b of movers(w)) expect(b.restitution).toBe(1.0);
      for (const wall of w.walls) expect(wall.restitution).toBe(1.0);
    }],
  ],

  Cyclone: [
    ["Sixty particles", (w) => expect(movers(w)).toHaveLength(60)],
    ["written entirely as two force-field formulas", (w) => {
      expect(w.fields).toHaveLength(1);
      expect(w.fields[0].error).toBe("");
      expect(w.gravity).toBe(0); // nothing but the field drives it
    }],
  ],
};

describe("preset descriptions tell the truth", () => {
  for (const [name, claims] of Object.entries(CARD_CLAIMS)) {
    describe(name, () => {
      for (const [phrase, check] of claims) {
        it(`"${phrase}"`, () => check(find(name)));
      }
    });
  }
});

describe("the card audit is complete", () => {
  // Number words the library's own cards use. Digits are caught separately.
  const WORD = new RegExp(
    "\\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|" +
    "thirteen|fourteen|fifteen|twenty|twenty-four|thirty|forty|fifty|sixty|" +
    "hundred)\\b", "i");

  it("covers every card that makes a countable claim", () => {
    // The hole this closes: "Swinging rope" advertised twelve segments long
    // after the builder moved to twenty-four, because no assertion named
    // that card. A new preset quoting a number now fails here until audited.
    const unaudited = PRESETS
      .filter((p) => /\d/.test(p.description) || WORD.test(p.description))
      .filter((p) => CARD_CLAIMS[p.name] === undefined)
      .map((p) => p.name);
    expect(unaudited).toEqual([]);
  });

  it("names only presets that exist", () => {
    const real = new Set(PRESETS.map((p) => p.name));
    expect(Object.keys(CARD_CLAIMS).filter((n) => !real.has(n))).toEqual([]);
  });

  it("quotes a phrase that really appears on the card it audits", () => {
    // A claim is only worth pinning if it is the claim the card makes, so
    // each entry's first distinctive word has to be in the description.
    const missing: string[] = [];
    for (const [name, claims] of Object.entries(CARD_CLAIMS)) {
      const desc = find_desc(name).toLowerCase();
      for (const [phrase] of claims) {
        // the longest word in the phrase, ignoring the ellipsis and glue
        const word = phrase.toLowerCase()
          .split(/[^a-z0-9.]+/)
          .filter((t) => t.length > 4 && t !== "sqrt")
          .sort((a, b) => b.length - a.length)[0];
        if (word !== undefined && !desc.includes(word)) {
          missing.push(`${name}: "${phrase}" (no "${word}")`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("ships the library size the README, help and tour all quote", () => {
    expect(PRESETS).toHaveLength(48);                              // "48 examples"
    expect(CATEGORIES.filter((c) => c !== "All")).toHaveLength(8); // "eight categories"
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
  });
});

function find_desc(name: string): string {
  const p = PRESETS.find((x) => x.name === name);
  if (!p) throw new Error(`no preset named '${name}'`);
  return p.description;
}
