/** Built-in example library.
 *
 * Every preset is a small builder that returns a fresh World plus view hints
 * (camera zoom/centre, overlays to enable, which graph to open). Descriptions
 * double as the educational blurb shown on the preset card.
 */
import { Vec2 } from "../core/vec";
import { Body, Color, Wall } from "../engine/body";
import { DistanceLink, SpringLink } from "../engine/links";
import { Driver, ForceField, World } from "../engine/world";

export interface PresetHints {
  zoom?: number;
  centre?: [number, number];
  trails?: boolean;
  vectors?: boolean;
  autoFit?: boolean; // keep the whole scene framed as it spreads out
  graph?: "energy" | "momentum" | "phase";
}

export class Preset {
  constructor(
    public name: string,
    public category: string,
    public description: string,
    public build: () => World,
    public hints: PresetHints = {},
  ) {}
}

/** Small deterministic RNG (mulberry32) for the randomized scenes: same
 * layout on every load, without hauling Python's Mersenne Twister along. */
class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  random(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  randint(a: number, b: number): number {
    return a + Math.floor(this.random() * (b - a + 1));
  }
}

// ----------------------------------------------------------------- helpers
function spaceWorld(substeps = 4): World {
  const w = new World();
  w.gravity = 0.0;
  w.mutualGravity = true;
  w.G = 1.0;
  w.integrator = "Velocity Verlet";
  w.substeps = substeps;
  return w;
}

const PIVOT_GREY: Color = [120, 125, 135];

interface BodyOpts {
  r?: number;
  m?: number;
  vx?: number;
  vy?: number;
  e?: number;
  mu?: number;
  locked?: boolean;
  anchor?: boolean; // fixed attachment point: locked, grey, no gravity, "Anchor"
  color?: Color;
  name?: string;
}

function addBody(w: World, x: number, y: number, opts: BodyOpts = {}): Body {
  const b = new Body(new Vec2(x, y), opts.r ?? 0.15, opts.m ?? 1.0,
                     opts.color ?? (opts.anchor ? PIVOT_GREY : null));
  b.vel.set(opts.vx ?? 0.0, opts.vy ?? 0.0);
  b.restitution = opts.e ?? 0.8;
  b.friction = opts.mu ?? 0.4;
  b.locked = (opts.locked ?? false) || (opts.anchor ?? false);
  if (opts.anchor) {
    b.isAnchor = true;
    b.name = "Anchor";
  }
  if (opts.name) b.name = opts.name;
  w.bodies.push(b);
  return b;
}

function addBox(w: World, halfW: number, halfH: number, e = 1.0,
                mu = 0.0, thickness = 0.1): void {
  const corners = [new Vec2(-halfW, halfH), new Vec2(halfW, halfH),
                   new Vec2(halfW, -halfH), new Vec2(-halfW, -halfH)];
  for (let i = 0; i < 4; i++) {
    const wall = new Wall(corners[i].copy(), corners[(i + 1) % 4].copy(), thickness);
    wall.restitution = e;
    wall.friction = mu;
    w.walls.push(wall);
  }
}

/** Pivot + n bobs hanging as a chain, released at angleDeg from vertical
 * (90 = horizontal). Rigid rod links by default; pass stringK for elastic
 * strings (tension-only springs) instead. */
function pendulumChain(w: World, px: number, py: number, n: number, seg: number,
                       mass = 1.0, r = 0.12, angleDeg = 90.0,
                       color: Color | null = null,
                       stringK: number | null = null,
                       stringC = 1.5): Body[] {
  const pivot = addBody(w, px, py, { r: 0.06, m: 1.0, anchor: true });
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const bodies = [pivot];
  for (let i = 1; i <= n; i++) {
    const b = addBody(w, px + dx * seg * i, py + dy * seg * i,
                      { r, m: mass, color: color ?? undefined });
    b.collides = false;
    if (stringK === null) {
      w.links.push(new DistanceLink(bodies[bodies.length - 1], b));
    } else {
      w.links.push(new SpringLink(bodies[bodies.length - 1], b, null,
                                  stringK, stringC, true));
    }
    bodies.push(b);
  }
  return bodies;
}

// ------------------------------------------------------------ gravity/orbits
function buildEarthMoon(): World {
  const w = spaceWorld(6);
  const earth = addBody(w, 0, 0, { r: 0.6, m: 1000.0, color: [86, 140, 214], name: "Earth" });
  const moon = addBody(w, 4.5, 0, { r: 0.16, m: 12.0, color: [190, 190, 200], name: "Moon" });
  const v = Math.sqrt((w.G * (earth.mass + moon.mass)) / 4.5);
  moon.vel.set(0, v);
  earth.vel.set(0, (-v * moon.mass) / earth.mass); // net momentum zero
  return w;
}

function buildKepler(): World {
  const w = spaceWorld(8);
  addBody(w, 0, 0, { r: 0.5, m: 1000.0, locked: true, color: [235, 200, 90], name: "Star" });
  const p = addBody(w, 3.0, 0, { r: 0.12, m: 1.0, color: [86, 156, 214], name: "Planet" });
  p.vel.set(0, Math.sqrt((w.G * 1000) / 3.0) * 0.72); // sub-circular -> ellipse
  return w;
}

function buildInnerPlanets(): World {
  const w = spaceWorld(6);
  const star = addBody(w, 0, 0, { r: 0.55, m: 3000.0, color: [235, 200, 90], name: "Sun" });
  star.locked = true;
  const data: Array<[string, number, number, number, Color]> = [
    ["Mercury", 1.6, 0.07, 0.5, [200, 180, 150]],
    ["Venus", 2.6, 0.11, 2.0, [230, 190, 130]],
    ["Earth", 3.8, 0.12, 2.2, [86, 156, 214]],
    ["Mars", 5.2, 0.09, 1.0, [220, 120, 80]],
  ];
  for (const [name, dist, r, m, col] of data) {
    const p = addBody(w, dist, 0, { r, m, color: col, name });
    p.vel.set(0, Math.sqrt((w.G * star.mass) / dist));
  }
  return w;
}

function buildBinary(): World {
  const w = spaceWorld(8);
  const m = 500.0;
  const d = 2.4;
  // each star circles the barycentre (radius d/2) under the pull
  // G m^2/d^2, so the circular speed is v = sqrt(G m / (2 d))
  const v = Math.sqrt((w.G * m) / (2.0 * d));
  addBody(w, -d / 2, 0, { r: 0.35, m, vy: -v, color: [235, 170, 90], name: "Star A" });
  addBody(w, d / 2, 0, { r: 0.35, m, vy: v, color: [140, 180, 235], name: "Star B" });
  const p = addBody(w, 7.0, 0, { r: 0.1, m: 0.5, color: [120, 200, 140], name: "Planet" });
  p.vel.set(0, Math.sqrt((w.G * 2 * m) / 7.0));
  return w;
}

function buildFigure8(): World {
  // Chenciner-Montgomery figure-eight choreography (G = m = 1)
  const w = spaceWorld(8);
  w.pointGravity = true; // the exact solution assumes point masses
  w.softening = 0.001;
  const x1 = 0.97000436;
  const y1 = -0.24308753;
  const vx3 = -0.93240737;
  const vy3 = -0.86473146;
  const a = addBody(w, x1, y1, { r: 0.08, m: 1.0, color: [230, 120, 120] });
  const b = addBody(w, -x1, -y1, { r: 0.08, m: 1.0, color: [120, 200, 140] });
  const c = addBody(w, 0, 0, { r: 0.08, m: 1.0, color: [120, 160, 230] });
  a.vel.set(-vx3 / 2, -vy3 / 2);
  b.vel.set(-vx3 / 2, -vy3 / 2);
  c.vel.set(vx3, vy3);
  for (const body of [a, b, c]) body.collides = false;
  return w;
}

/** A true hyperbolic flyby: the probe falls past the planet's trailing side
 * just after it crosses, hooks around it, and leaves ~50% faster, chasing
 * the planet - the Voyager manoeuvre. (Parameters are tuned so the relative
 * speed exceeds escape speed at closest approach: a genuine flyby, not a
 * capture.) */
function buildSlingshot(): World {
  const w = spaceWorld(8);
  const planet = addBody(w, 2.0, 0, { r: 0.5, m: 25.0, vx: -2.0,
                                      color: [200, 150, 100], name: "Planet" });
  const probe = addBody(w, 0, 8.0, { r: 0.07, m: 0.001, vy: -3.2,
                                     color: [200, 220, 240], name: "Probe" });
  probe.collides = planet.collides = false;
  return w;
}

/** Newton's mountain thought experiment: the same cannonball at ever
 * higher launch speeds falls short, orbits, or escapes. */
function buildNewtonsCannon(): World {
  const w = spaceWorld(6);
  const planet = addBody(w, 0, 0, { r: 0.8, m: 80.0, locked: true, e: 0.1,
                                    mu: 0.4, color: [96, 150, 110], name: "Planet" });
  const alt = 1.15;
  const vCirc = Math.sqrt((w.G * planet.mass) / alt);
  const shots: Array<[number, string, Color]> = [
    [0.55, "0.55 v: falls short", [220, 130, 90]],
    [0.80, "0.8 v: further, still falls", [230, 200, 90]],
    [1.00, "1.0 v: circular orbit", [120, 190, 120]],
    [1.20, "1.2 v: elliptical orbit", [110, 200, 210]],
    [1.45, "1.45 v: escapes (v > sqrt(2))", [200, 110, 180]],
  ];
  for (const [frac, label, col] of shots) {
    addBody(w, 0, alt, { r: 0.05, m: 0.001, vx: frac * vCirc, e: 0.1, mu: 0.4,
                         color: col, name: label });
  }
  return w;
}

/** Asteroids librating around Jupiter's L4/L5 Lagrange points. */
function buildTrojans(): World {
  const w = spaceWorld(6);
  const sun = addBody(w, 0, 0, { r: 0.5, m: 1000.0, locked: true,
                                 color: [235, 200, 90], name: "Sun" });
  const a = 3.5;
  const v = Math.sqrt((w.G * sun.mass) / a);
  addBody(w, a, 0, { r: 0.22, m: 8.0, vy: v, color: [210, 160, 110], name: "Jupiter" });
  const rng = new Random(5);
  for (let k = 0; k < 12; k++) {
    const base = k < 6 ? Math.PI / 3 : -Math.PI / 3; // L4 leads, L5 trails
    const th = base + rng.uniform(-0.15, 0.15);
    const rr = a * (1.0 + rng.uniform(-0.03, 0.03));
    const grey = 160 + rng.randint(0, 60);
    const b = addBody(w, rr * Math.cos(th), rr * Math.sin(th),
                      { r: 0.045, m: 0.001,
                        vx: -v * Math.sin(th), vy: v * Math.cos(th),
                        color: [grey, grey, grey] });
    b.collides = false;
    b.name = `Trojan ${k + 1}`;
  }
  return w;
}

/** Hierarchical three-body: the Moon orbits the Earth orbiting the Sun.
 *
 * The moon's orbit must sit well inside Earth's Hill sphere
 * (r_H = a_e * (m_e / 3 M_sun)^(1/3) ~ 0.6 here; prograde orbits are
 * long-term stable only inside roughly half of that), or the Sun's tide
 * strips it away. */
function buildSunEarthMoon(): World {
  const w = spaceWorld(10);
  const sun = addBody(w, 0, 0, { r: 0.4, m: 2000.0, locked: true,
                                 color: [235, 200, 90], name: "Sun" });
  const aE = 4.0;
  const vE = Math.sqrt((w.G * sun.mass) / aE);
  // small drawn radii: the moon's orbit (0.24) must read as clear space
  // between the two discs, not as the moon scraping the earth
  const earth = addBody(w, aE, 0, { r: 0.09, m: 20.0, vy: vE,
                                    color: [86, 156, 214], name: "Earth" });
  const aM = 0.24;
  const vM = Math.sqrt((w.G * earth.mass) / aM);
  const moon = addBody(w, aE + aM, 0, { r: 0.03, m: 0.02, vy: vE + vM,
                                        color: [190, 190, 200], name: "Moon" });
  moon.collides = false;
  return w;
}

/** Burrau's Pythagorean problem (1913): masses 3, 4 and 5 released at
 * rest from the corners of a 3-4-5 right triangle. A celebrated chaotic
 * free-fall dance of close encounters; eventually two bodies bind into a
 * binary and fling the third away. */
function buildPythagorean(): World {
  const w = spaceWorld(32);
  w.pointGravity = true; // near-collisions are the whole point here
  w.softening = 0.01;
  const rows: Array<[number, number, number, Color]> = [
    [1.0, 3.0, 3.0, [230, 120, 120]],
    [-2.0, -1.0, 4.0, [120, 190, 120]],
    [1.0, -1.0, 5.0, [120, 160, 230]],
  ];
  for (const [x, y, m, col] of rows) {
    const b = addBody(w, x, y, { r: 0.07 * Math.cbrt(m), m, color: col,
                                 name: `m = ${m}` });
    b.collides = false;
  }
  return w;
}

/** Lagrange's equilateral-triangle solution: three masses at the corners
 * of an equilateral triangle can rotate rigidly forever. For equal masses
 * the configuration is *unstable*, so numerical noise eventually grows and
 * the dance breaks into chaos. */
function buildLagrangeTriangle(): World {
  const w = spaceWorld(12);
  w.pointGravity = true; // the rigid-rotation solution assumes point masses
  const side = 2.4;
  const m = 100.0;
  const rOrbit = side / Math.sqrt(3);
  // rigid rotation: omega^2 = 3 G m / side^3
  const omega = Math.sqrt((3.0 * w.G * m) / side ** 3);
  const v = omega * rOrbit;
  const cols: Color[] = [[230, 120, 120], [120, 190, 120], [120, 160, 230]];
  for (let i = 0; i < 3; i++) {
    const th = Math.PI / 2 + (i * 2 * Math.PI) / 3;
    const b = addBody(w, rOrbit * Math.cos(th), rOrbit * Math.sin(th),
                      { r: 0.14, m, vx: -v * Math.sin(th), vy: v * Math.cos(th),
                        color: cols[i], name: `Mass ${i + 1}` });
    b.collides = false;
  }
  return w;
}

/** Zero-angular-momentum three-body choreography (Suvakov &
 * Dmitrasinovic 2013): equal masses at (-1,0), (1,0), (0,0) with
 * v1 = v2 = (p1, p2) and v3 = (-2 p1, -2 p2), G = m = 1. */
function choreography(p1: number, p2: number, substeps = 64): World {
  const w = spaceWorld(substeps);
  w.pointGravity = true; // these delicate orbits assume point masses
  w.softening = 0.001;
  const cols: Color[] = [[230, 120, 120], [120, 190, 120], [120, 160, 230]];
  const starts: Array<[number, number, number]> =
    [[-1.0, p1, p2], [1.0, p1, p2], [0.0, -2 * p1, -2 * p2]];
  for (let i = 0; i < 3; i++) {
    const [x, vx, vy] = starts[i];
    const b = addBody(w, x, 0.0, { r: 0.06, m: 1.0, vx, vy, color: cols[i] });
    b.collides = false;
  }
  return w;
}

const buildMoth = (): World => choreography(0.46444, 0.39606);
const buildButterflyOrbit = (): World => choreography(0.30689, 0.12551);

// ----------------------------------------------------------------- pendulums
function buildSimplePendulum(): World {
  const w = new World();
  w.substeps = 8;
  pendulumChain(w, 0, 1.5, 1, 1.5, 1.0, 0.12, 20, [86, 156, 214]);
  return w;
}

function buildDoublePendulum(): World {
  const w = new World();
  w.substeps = 12;
  pendulumChain(w, 0, 1.2, 2, 0.9, 1.0, 0.12, 115, [220, 130, 90]);
  return w;
}

function buildTriplePendulum(): World {
  const w = new World();
  w.substeps = 12;
  pendulumChain(w, 0, 1.5, 3, 0.7, 1.0, 0.12, 100, [200, 110, 180]);
  return w;
}

function buildRope(): World {
  const w = new World();
  w.substeps = 12;
  w.iterations = 8;
  // elastic string segments: stiff enough that the rope stretches under
  // its own weight by only ~1.5% at the top, slack when compressed - so
  // the rope can fold and whip like real cord. Many short segments give a
  // smooth, finely-jointed cord; count/spacing/mass/stiffness scale together
  // so total length (2.64 m), total mass and overall compliance are unchanged.
  pendulumChain(w, 0, 1.8, 24, 0.11, 0.1, 0.045, 85, [170, 140, 230],
                3000.0, 1.5);
  return w;
}

function buildNewtonsCradle(): World {
  const w = new World();
  w.substeps = 10;
  const r = 0.15;
  const gap = 0.302; // just over the diameter so balls rest touching
  for (let i = 0; i < 5; i++) {
    const x = (i - 2) * gap;
    const pivot = addBody(w, x, 1.4, { r: 0.05, m: 1.0, anchor: true });
    const ball = addBody(w, x, 0.0, { r, m: 1.0, e: 1.0, mu: 0.0,
                                      color: [150, 160, 175], name: `Ball ${i + 1}` });
    w.links.push(new DistanceLink(pivot, ball));
  }
  // pull the first ball aside, keeping the string taut
  const first = w.bodies[1];
  const ang = (60 * Math.PI) / 180;
  first.pos.set(-2 * gap - 1.4 * Math.sin(ang), 1.4 - 1.4 * Math.cos(ang));
  return w;
}

function buildCoupledPendulums(): World {
  const w = new World();
  w.substeps = 10;
  const chainA = pendulumChain(w, -0.8, 1.2, 1, 1.2, 1.0, 0.12, 25, [86, 156, 214]);
  const chainB = pendulumChain(w, 0.8, 1.2, 1, 1.2, 1.0, 0.12, 0, [220, 130, 90]);
  w.links.push(new SpringLink(chainA[1], chainB[1], null, 3.0));
  return w;
}

// --------------------------------------------------------------- oscillators
function buildShm(): World {
  const w = new World();
  w.substeps = 6;
  const anchor = addBody(w, 0, 2.0, { r: 0.06, m: 1.0, anchor: true });
  const bob = addBody(w, 0, 0.2, { r: 0.16, m: 1.0, color: [86, 156, 214], name: "Mass" });
  w.links.push(new SpringLink(anchor, bob, 1.2, 25.0));
  return w;
}

function buildDampingRegimes(): World {
  const w = new World();
  w.substeps = 6;
  const k = 25.0;
  const m = 1.0;
  const crit = 2.0 * Math.sqrt(k * m);
  const rows: Array<[string, number, Color]> = [
    ["Underdamped", 0.15 * crit, [86, 156, 214]],
    ["Critical", crit, [120, 190, 120]],
    ["Overdamped", 3.0 * crit, [220, 130, 90]],
  ];
  for (let i = 0; i < rows.length; i++) {
    const [label, c, col] = rows[i];
    const x = (i - 1) * 1.4;
    const anchor = addBody(w, x, 2.0, { r: 0.06, m: 1.0, anchor: true });
    const bob = addBody(w, x, 0.0, { r: 0.15, m, color: col, name: label });
    bob.collides = false;
    w.links.push(new SpringLink(anchor, bob, 1.2, k, c));
  }
  return w;
}

function buildResonance(): World {
  const w = new World();
  w.gravity = 0.0;
  w.substeps = 6;
  const anchor = addBody(w, 0, 0, { r: 0.06, m: 1.0, anchor: true });
  const bob = addBody(w, 1.2, 0, { r: 0.16, m: 1.0, color: [230, 120, 120],
                                   name: "Driven mass" });
  const k = 25.0;
  w.links.push(new SpringLink(anchor, bob, 1.2, k, 0.4));
  const fNat = Math.sqrt(k / bob.mass) / (2 * Math.PI);
  w.drivers.push(new Driver(bob.id, 1.0, fNat));
  return w;
}

function buildCoupledOscillators(): World {
  const w = new World();
  w.gravity = 0.0;
  w.substeps = 6;
  const left = addBody(w, -2.4, 0, { r: 0.06, m: 1.0, anchor: true });
  const right = addBody(w, 2.4, 0, { r: 0.06, m: 1.0, anchor: true });
  const masses: Body[] = [];
  for (let i = 0; i < 3; i++) {
    const b = addBody(w, -1.2 + i * 1.2, 0, { r: 0.14, m: 1.0,
                                              color: [86, 156, 214], name: `m${i + 1}` });
    b.collides = false;
    masses.push(b);
  }
  const nodes = [left, ...masses, right];
  for (let i = 0; i + 1 < nodes.length; i++) {
    w.links.push(new SpringLink(nodes[i], nodes[i + 1], null, 30.0));
  }
  masses[0].pos.x -= 0.5; // excite a mode mixture
  return w;
}

function buildSpringPendulum(): World {
  const w = new World();
  w.substeps = 8;
  const anchor = addBody(w, 0, 1.5, { r: 0.06, m: 1.0, anchor: true });
  const bob = addBody(w, 0.9, 0.6, { r: 0.15, m: 1.0, color: [200, 110, 180], name: "Bob" });
  w.links.push(new SpringLink(anchor, bob, 1.0, 30.0));
  return w;
}

// ------------------------------------------------------------ collisions/gas
function buildBilliards(): World {
  const w = new World();
  w.gravity = 0.0;
  w.substeps = 4;
  addBox(w, 3.4, 1.8, 0.9, 0.1);
  w.globalDamping = 0.25; // cloth friction
  const r = 0.11;
  const rng = new Random(4);
  const rows = 5;
  for (let row = 0; row < rows; row++) {
    for (let i = 0; i <= row; i++) {
      const x = 1.2 + row * (r * 1.74);
      const y = (i - row / 2) * (r * 2.02);
      addBody(w, x, y, { r, m: 0.17, e: 0.95, mu: 0.05,
                         color: [200 - row * 18, 90 + rng.randint(0, 60), 90] });
    }
  }
  addBody(w, -2.2, 0, { r, m: 0.17, e: 0.95, mu: 0.05, vx: 7.0,
                        color: [235, 235, 225], name: "Cue ball" });
  return w;
}

function buildRestitutionLadder(): World {
  const w = new World();
  w.substeps = 6;
  const floor = new Wall(new Vec2(-3.2, 0), new Vec2(3.2, 0), 0.12);
  floor.restitution = 1.0;
  floor.friction = 0.2;
  w.walls.push(floor);
  for (let i = 0; i < 6; i++) {
    const e = Math.round((0.5 + i * 0.1) * 10) / 10;
    addBody(w, -2.5 + i, 2.0, { r: 0.15, m: 1.0, e,
                                color: [90 + i * 25, 120, 220 - i * 25],
                                name: `e = ${e}` });
  }
  return w;
}

/** Random elastic gas in a box. */
function gasWorld(count: number, half: number, seed: number): World {
  const w = new World();
  w.gravity = 0.0;
  w.substeps = 2;
  w.integrator = "Symplectic Euler";
  addBox(w, half, half, 1.0, 0.0);
  const rng = new Random(seed);
  for (let i = 0; i < count; i++) {
    const m = Math.round(rng.uniform(0.5, 2.0) * 1000) / 1000;
    const r = m / 10.0;
    const b = addBody(w, rng.uniform(-half + r * 2, half - r * 2),
                      rng.uniform(-half + r * 2, half - r * 2),
                      { r, m, vx: rng.uniform(-1, 1), vy: rng.uniform(-1, 1),
                        e: 1.0, mu: 0.0 });
    b.name = `Particle ${b.id}`;
  }
  return w;
}

function buildBrownian(): World {
  const w = new World();
  w.gravity = 0.0;
  w.substeps = 3;
  addBox(w, 2.6, 2.6, 1.0, 0.0);
  const big = addBody(w, 0, 0, { r: 0.42, m: 12.0, e: 1.0, mu: 0.0,
                                 color: [230, 200, 90], name: "Pollen grain" });
  const rng = new Random(11);
  for (let i = 0; i < 140; i++) {
    let x: number;
    let y: number;
    do {
      x = rng.uniform(-2.4, 2.4);
      y = rng.uniform(-2.4, 2.4);
    } while (Math.sqrt(x * x + y * y) <= big.radius + 0.1);
    addBody(w, x, y, { r: 0.045, m: 0.05, vx: rng.uniform(-3, 3),
                       vy: rng.uniform(-3, 3), e: 1.0, mu: 0.0,
                       color: [120, 160, 200] });
  }
  return w;
}

// ------------------------------------------------------ projectiles/friction
function buildDragRace(): World {
  const w = new World();
  w.substeps = 6;
  w.integrator = "RK4";
  const floor = new Wall(new Vec2(-1, 0), new Vec2(24, 0), 0.12);
  floor.restitution = 0.3;
  floor.friction = 0.6;
  w.walls.push(floor);
  addBody(w, 0, 0.4, { r: 0.12, m: 1.0, vx: 9.0, vy: 9.0,
                       color: [86, 156, 214], name: "Vacuum" });
  const b = addBody(w, -0.4, 0.4, { r: 0.12, m: 1.0, vx: 9.0, vy: 9.0,
                                    color: [220, 130, 90], name: "With air drag" });
  // The field selects its target by mass (m > 1), so only this body feels drag.
  b.mass = 1.001;
  w.fields.push(new ForceField("Air drag (m>1 only)",
                               "(-0.35 * vx * hypot(vx, vy)) * (m > 1)",
                               "(-0.35 * vy * hypot(vx, vy)) * (m > 1)"));
  return w;
}

function buildFrictionRamp(): World {
  const w = new World();
  w.substeps = 8;
  const ang = (-25 * Math.PI) / 180;
  const length = 8.0;
  const ramp = new Wall(new Vec2(0, 0),
                        new Vec2(length * Math.cos(ang), length * Math.sin(ang)), 0.12);
  ramp.friction = 1.0;
  ramp.restitution = 0.05;
  w.walls.push(ramp);
  const runOut = new Wall(new Vec2(length * Math.cos(ang), length * Math.sin(ang)),
                          new Vec2(length * Math.cos(ang) + 8, length * Math.sin(ang)), 0.12);
  runOut.friction = 1.0;
  runOut.restitution = 0.05;
  w.walls.push(runOut);
  const rows: Array<[number, Color, string]> = [
    [0.0, [110, 200, 210], "Frictionless (slides)"],
    [0.25, [120, 190, 120], "mu = 0.25 (rolls)"],
    [0.8, [220, 130, 90], "mu = 0.8 (rolls)"],
  ];
  for (let i = 0; i < rows.length; i++) {
    const [mu, col, label] = rows[i];
    const n = new Vec2(-Math.sin(ang), Math.cos(ang));
    const along = 0.5 + i * 0.8;
    const pos = new Vec2(along * Math.cos(ang), along * Math.sin(ang))
      .add(n.mul(0.06 + 0.16));
    const b = addBody(w, pos.x, pos.y, { r: 0.16, m: 1.0, e: 0.05, mu,
                                         color: col, name: label });
    b.collides = true;
  }
  return w;
}

function buildGalileo(): World {
  const w = new World();
  w.substeps = 4;
  const floor = new Wall(new Vec2(-2.5, 0), new Vec2(2.5, 0), 0.12);
  floor.restitution = 0.15;
  w.walls.push(floor);
  // bottoms aligned (y = drop + r + floor half-thickness), so both fall
  // exactly the same distance and touch down together
  const drop = 3.2;
  addBody(w, -0.8, drop + 0.28 + 0.06, { r: 0.28, m: 10.0, e: 0.15,
                                         color: [150, 160, 175], name: "10 kg" });
  addBody(w, 0.8, drop + 0.1 + 0.06, { r: 0.1, m: 0.5, e: 0.15,
                                       color: [220, 130, 90], name: "0.5 kg" });
  return w;
}

function buildWreckingBall(): World {
  const w = new World();
  w.substeps = 10;
  const floor = new Wall(new Vec2(-4, 0), new Vec2(4, 0), 0.12);
  floor.friction = 0.7;
  floor.restitution = 0.05;
  w.walls.push(floor);
  const pivot = addBody(w, -0.5, 3.4, { r: 0.06, m: 1.0, anchor: true });
  const ball = addBody(w, -2.95, 2.15, { r: 0.35, m: 22.0, e: 0.2, mu: 0.4,
                                         color: [90, 95, 105], name: "Wrecking ball" });
  w.links.push(new DistanceLink(pivot, ball));
  const rng = new Random(3);
  const r = 0.16;
  const towerX = 0.90;
  for (let colI = 0; colI < 3; colI++) {
    for (let row = 0; row < 6; row++) {
      addBody(w, towerX + colI * (2 * r + 0.01), r + row * (2 * r + 0.005),
              { r, m: 0.4, e: 0.1, mu: 0.6,
                color: [200 - rng.randint(0, 40), 150, 100] });
    }
  }
  return w;
}

function buildChainBridge(): World {
  const w = new World();
  w.substeps = 12;
  w.iterations = 16;
  const left = addBody(w, -2.4, 1.0, { r: 0.07, m: 1.0, anchor: true });
  const right = addBody(w, 2.4, 1.0, { r: 0.07, m: 1.0, anchor: true });
  const n = 11;
  let prev = left;
  // elastic strings: taut segments stretch slightly under the load,
  // slack ones carry nothing - exactly how a real cable bridge hangs
  for (let i = 1; i < n; i++) {
    const x = -2.4 + (4.8 * i) / n;
    const b = addBody(w, x, 1.0, { r: 0.07, m: 0.3, e: 0.2, mu: 0.6,
                                   color: [170, 140, 230] });
    w.links.push(new SpringLink(prev, b, null, 4000.0, 6.0, true));
    prev = b;
  }
  w.links.push(new SpringLink(prev, right, null, 4000.0, 6.0, true));
  addBody(w, 0, 3.0, { r: 0.3, m: 6.0, e: 0.2, mu: 0.5, color: [220, 130, 90],
                       name: "Load" });
  return w;
}

function buildProjectileAngles(): World {
  const w = new World();
  w.substeps = 4;
  const floor = new Wall(new Vec2(-1, 0), new Vec2(14, 0), 0.12);
  floor.restitution = 0.05;
  floor.friction = 0.8;
  w.walls.push(floor);
  const v0 = 10.0;
  const shots: Array<[number, Color]> = [
    [30, [110, 200, 210]], [45, [120, 190, 120]],
    [60, [220, 130, 90]], [75, [200, 110, 180]],
  ];
  for (const [angDeg, col] of shots) {
    const a = (angDeg * Math.PI) / 180;
    const b = addBody(w, 0, 0.2, { r: 0.09, m: 1.0,
                                   vx: v0 * Math.cos(a), vy: v0 * Math.sin(a),
                                   e: 0.05, mu: 0.8, color: col, name: `${angDeg} deg` });
    b.collides = true;
  }
  return w;
}

function buildElasticVsInelastic(): World {
  const w = new World();
  w.gravity = 0.0;
  w.substeps = 4;
  const lanes: Array<[number, string, string, Color]> = [
    [1.0, "Elastic 2 m/s", "Elastic at rest", [86, 156, 214]],
    [0.0, "Inelastic 2 m/s", "Inelastic at rest", [220, 130, 90]],
  ];
  for (let lane = 0; lane < lanes.length; lane++) {
    const [e, labelA, labelB, col] = lanes[lane];
    const y = 0.8 - lane * 1.6;
    const a = addBody(w, -2.2, y, { r: 0.15, m: 1.0, vx: 2.0, e, mu: 0.0,
                                    color: col, name: labelA });
    const lighter = col.map((c) => Math.min(255, c + 40)) as Color;
    const b = addBody(w, 0.6, y, { r: 0.15, m: 1.0, e, mu: 0.0,
                                   color: lighter, name: labelB });
    a.collides = b.collides = true;
  }
  return w;
}

function buildTerminalVelocity(): World {
  const w = new World();
  w.substeps = 6;
  w.integrator = "RK4";
  w.dragQuadratic = 0.4;
  addBody(w, -1.0, 8.0, { r: 0.12, m: 0.3, e: 0.2, color: [110, 200, 210],
                          name: "Light (0.3 kg)" });
  addBody(w, 1.0, 8.0, { r: 0.12, m: 3.0, e: 0.2, color: [220, 130, 90],
                         name: "Heavy (3 kg)" });
  const floor = new Wall(new Vec2(-3, 0), new Vec2(3, 0), 0.12);
  floor.restitution = 0.2;
  w.walls.push(floor);
  return w;
}

// --------------------------------------------------------------- soft bodies
// Soft bodies are lattices of evenly spaced particles joined by damped
// springs: a structural mesh carries the shape, shear/diagonal springs stop
// it collapsing. Directly linked particles never collide with each other
// (the engine excludes linked pairs; their springs govern the separation),
// but everything else does - so a lattice can squash yet never tangle
// through itself.

function softSpring(w: World, a: Body, b: Body, k: number, damp: number): void {
  w.links.push(new SpringLink(a, b, a.pos.distTo(b.pos), k, damp));
}

/** Rectangular particle lattice with structural + crossed shear springs. */
function softGrid(w: World, x0: number, y0: number, cols: number, rows: number,
                  spacing: number, massTotal: number, k: number, damp: number,
                  color: Color, e = 0.2, mu = 0.5,
                  particleR: number | null = null): Body[][] {
  const m = massTotal / (cols * rows);
  const r = particleR ?? spacing * 0.35;
  const grid: Body[][] = [];
  for (let j = 0; j < rows; j++) {
    const row: Body[] = [];
    for (let i = 0; i < cols; i++) {
      row.push(addBody(w, x0 + i * spacing, y0 + j * spacing,
                       { r, m, e, mu, color }));
    }
    grid.push(row);
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (i + 1 < cols) softSpring(w, grid[j][i], grid[j][i + 1], k, damp);
      if (j + 1 < rows) softSpring(w, grid[j][i], grid[j + 1][i], k, damp);
      if (i + 1 < cols && j + 1 < rows) {
        softSpring(w, grid[j][i], grid[j + 1][i + 1], k, damp);
        softSpring(w, grid[j][i + 1], grid[j + 1][i], k, damp);
      }
    }
  }
  return grid;
}

/** Disc of hex-packed particles, each sprung to its ~6 nearest
 * neighbours: a fully triangulated (and therefore shear-stiff) blob. */
function softBlob(w: World, cx: number, cy: number, radius: number,
                  spacing: number, massTotal: number, k: number, damp: number,
                  color: Color, e = 0.3, mu = 0.5): Body[] {
  const pts: Array<[number, number]> = [];
  const rowH = (spacing * Math.sqrt(3)) / 2;
  let j = 0;
  let y = -radius;
  while (y <= radius + 1e-9) {
    let x = -radius + (j % 2 ? spacing / 2 : 0.0);
    while (x <= radius + 1e-9) {
      if (x * x + y * y <= radius * radius + 1e-9) pts.push([x, y]);
      x += spacing;
    }
    y += rowH;
    j++;
  }
  const m = massTotal / pts.length;
  const bodies: Body[] = [];
  for (const [x, py] of pts) {
    bodies.push(addBody(w, cx + x, cy + py, { r: spacing * 0.38, m, e, mu, color }));
  }
  const cutoff = spacing * 1.25;
  for (let i = 0; i < bodies.length; i++) {
    for (let j2 = i + 1; j2 < bodies.length; j2++) {
      if (bodies[i].pos.distTo(bodies[j2].pos) <= cutoff) {
        softSpring(w, bodies[i], bodies[j2], k, damp);
      }
    }
  }
  return bodies;
}

function buildJellyBlock(): World {
  const w = new World();
  w.substeps = 8;
  const floor = new Wall(new Vec2(-4.5, 0), new Vec2(4.5, 0), 0.14);
  floor.friction = 0.6;
  floor.restitution = 0.1;
  w.walls.push(floor);
  for (const x of [-4.5, 4.5]) {
    const side = new Wall(new Vec2(x, 0), new Vec2(x, 4.0), 0.14);
    side.restitution = 0.4;
    w.walls.push(side);
  }
  softGrid(w, -0.9, 1.6, 9, 7, 0.225, 4.0, 1000.0, 3.0, [120, 200, 140]);
  return w;
}

function buildSquishyBall(): World {
  const w = new World();
  w.substeps = 8;
  // a V-shaped ramp: the ball splats at the bottom, oozes and settles
  const left = new Wall(new Vec2(-4.0, 3.0), new Vec2(0.0, 0.0), 0.14);
  const right = new Wall(new Vec2(0.0, 0.0), new Vec2(4.0, 3.0), 0.14);
  for (const wall of [left, right]) {
    wall.friction = 0.35;
    wall.restitution = 0.15;
    w.walls.push(wall);
  }
  softBlob(w, -2.2, 4.4, 0.75, 0.26, 3.0, 900.0, 3.5, [230, 140, 160]);
  return w;
}

/** Force-field showcase: a cyclone written entirely as two formulas.
 *
 * The field combines four ideas the formula language supports: a tangential
 * swirl with exponential falloff (exp), an inward pull (1/r-style terms), a
 * comparison used as a switch to hollow out a calm "eye" (r < 0.7), and
 * velocity damping. Open the World tab to read and edit the formulas live.
 */
function buildCyclone(): World {
  const w = new World();
  w.gravity = 0.0;
  w.substeps = 4;
  const rng = new Random(9);
  for (let i = 0; i < 60; i++) {
    const d = rng.uniform(0.8, 4.2);
    const th = rng.uniform(0, 2 * Math.PI);
    // spread of masses: since the field applies forces (not accelerations),
    // light debris and heavy debris settle onto different orbits, so the
    // storm organizes into layered bands instead of one ring
    addBody(w, d * Math.cos(th), d * Math.sin(th),
            { r: 0.06, m: rng.uniform(0.02, 0.15),
              vx: rng.uniform(-0.5, 0.5), vy: rng.uniform(-0.5, 0.5),
              e: 0.6, mu: 0.0,
              color: [120 + rng.randint(0, 80), 160 + rng.randint(0, 60),
                      200 + rng.randint(0, 55)] });
  }
  w.fields.push(new ForceField("Cyclone",
    "-9*y*exp(-r/5)/(r+0.15) - 3*x/(r+0.3) + 6*x*(r < 0.7) - 0.4*vx",
    "9*x*exp(-r/5)/(r+0.15) - 3*y/(r+0.3) + 6*y*(r < 0.7) - 0.4*vy"));
  return w;
}

function buildTrampoline(): World {
  const w = new World();
  w.substeps = 10;
  const n = 21;
  const rest = 0.18;   // natural length of each bed segment (unchanged)
  const K = 100000.0;  // maximum spring stiffness (inspector slider max)
  const C = 250.0;     // half the maximum damping (slider max 500)
  const wallX = 3.2;
  const wallBot = -0.6;
  // anchors sit at the bottom of each side bumper wall
  const left = addBody(w, -wallX, wallBot, { r: 0.07, m: 1.0, anchor: true });
  const right = addBody(w, wallX, wallBot, { r: 0.07, m: 1.0, anchor: true });
  // Perfectly elastic, frictionless bed particles, placed evenly between the
  // anchors as a starting guess; the true rest shape is settled below.
  let prev = left;
  const sheet: Body[] = [];
  for (let i = 0; i < n; i++) {
    const x = -wallX + ((i + 1) * 2 * wallX) / (n + 1);
    const b = addBody(w, x, wallBot, { r: 0.055, m: 0.1, e: 1.0,
                                       mu: 0.0, color: [110, 200, 210] });
    sheet.push(b);
    w.links.push(new SpringLink(prev, b, rest, K, C));
    prev = b;
  }
  w.links.push(new SpringLink(prev, right, rest, K, C));
  for (let i = 0; i + 2 < sheet.length; i++) { // bend springs keep the bed smooth
    w.links.push(new SpringLink(sheet[i], sheet[i + 2], 2 * rest, K, C));
  }
  // side bumpers keep the bouncer over the bed
  for (const x of [-wallX, wallX]) {
    const side = new Wall(new Vec2(x, wallBot), new Vec2(x, 3.2), 0.12);
    side.restitution = 0.5;
    w.walls.push(side);
  }
  // Settle the bed into its rest shape under the new stiffness and anchor
  // positions (rest lengths untouched). A small dedicated relaxation loop is
  // used instead of World.step so preset construction stays instant; it
  // applies exactly the engine's per-substep-clamped spring force model
  // (see World.prepareStep), so a force balance here is a true fixed point
  // of the runtime simulation - the bed loads perfectly still.
  const hSub = 1 / 120 / w.substeps;
  const springs = w.links.filter((l): l is SpringLink => l instanceof SpringLink);
  const kEff = springs.map((s) =>
    Math.min(s.stiffness, 1 / (hSub * hSub * (s.a.invMass + s.b.invMass))));
  const hRelax = 2e-4;
  for (let it = 0; it < 15000; it++) {
    for (const b of sheet) b.acc.set(0, -w.gravity);
    for (let i = 0; i < springs.length; i++) {
      const s = springs[i];
      const dx = s.b.pos.x - s.a.pos.x;
      const dy = s.b.pos.y - s.a.pos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-9) continue;
      const f = kEff[i] * (d - s.restLength); // positive pulls ends together
      const nx = dx / d;
      const ny = dy / d;
      s.a.acc.x += f * nx * s.a.invMass;
      s.a.acc.y += f * ny * s.a.invMass;
      s.b.acc.x -= f * nx * s.b.invMass;
      s.b.acc.y -= f * ny * s.b.invMass;
    }
    for (const b of sheet) {
      b.vel.x = (b.vel.x + b.acc.x * hRelax) * 0.995;
      b.vel.y = (b.vel.y + b.acc.y * hRelax) * 0.995;
      b.pos.x += b.vel.x * hRelax;
      b.pos.y += b.vel.y * hRelax;
    }
  }
  for (const b of sheet) {
    b.vel.set(0, 0);
    b.acc.set(0, 0);
  }
  addBody(w, 0.0, 2.6, { r: 0.3, m: 64.0, e: 1.0, mu: 0.0, color: [220, 130, 90],
                         name: "Gymnast" });
  return w;
}

function buildSoftWheel(): World {
  const w = new World();
  w.substeps = 10;
  const ang = (-14 * Math.PI) / 180;
  const length = 11.0;
  const ramp = new Wall(new Vec2(0, 0),
                        new Vec2(length * Math.cos(ang), length * Math.sin(ang)), 0.14);
  ramp.friction = 1.0;
  ramp.restitution = 0.05;
  w.walls.push(ramp);
  const runOut = new Wall(new Vec2(length * Math.cos(ang), length * Math.sin(ang)),
                          new Vec2(length * Math.cos(ang) + 6, length * Math.sin(ang)), 0.14);
  runOut.friction = 0.9;
  runOut.restitution = 0.05;
  w.walls.push(runOut);
  const bumper = new Wall(new Vec2(length * Math.cos(ang) + 6, length * Math.sin(ang)),
                          new Vec2(length * Math.cos(ang) + 6,
                                   length * Math.sin(ang) + 2.5), 0.14);
  bumper.restitution = 0.4;
  w.walls.push(bumper);

  const n = 22;
  const radius = 0.6;
  const nrm = new Vec2(-Math.sin(ang), Math.cos(ang));
  const centre = new Vec2(0.9 * Math.cos(ang), 0.9 * Math.sin(ang))
    .add(nrm.mul(radius + 0.13));
  const hub = addBody(w, centre.x, centre.y, { r: 0.13, m: 0.8,
                                               color: [200, 150, 90], name: "Hub" });
  const ring: Body[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    ring.push(addBody(w, centre.x + radius * Math.cos(th),
                      centre.y + radius * Math.sin(th),
                      { r: 0.075, m: 0.09, e: 0.15, mu: 1.0, color: [235, 170, 90] }));
  }
  for (let i = 0; i < n; i++) {
    softSpring(w, ring[i], ring[(i + 1) % n], 2200.0, 3.0); // tread
    softSpring(w, ring[i], ring[(i + 2) % n], 900.0, 1.5);  // bend
    softSpring(w, ring[i], hub, 450.0, 2.0);                // spokes
  }
  // start it rolling: v = omega x r about the contact point
  const omega = -3.0;
  for (const b of [...ring, hub]) {
    const rx = b.pos.x - centre.x;
    const ry = b.pos.y - centre.y;
    b.vel.set(-omega * ry + 1.0 * Math.cos(ang), omega * rx + 1.0 * Math.sin(ang));
  }
  return w;
}

function buildJellySmash(): World {
  const w = new World();
  w.substeps = 8;
  // floor sits below the swing arc's lowest point (y = 0.344 minus the
  // ball radius), so the ball reaches the jelly before touching ground
  const floor = new Wall(new Vec2(-5.0, -0.5), new Vec2(5.0, -0.5), 0.14);
  floor.friction = 0.7;
  floor.restitution = 0.1;
  w.walls.push(floor);
  softGrid(w, -1.6, -0.34, 8, 6, 0.24, 3.5, 1100.0, 3.2, [170, 140, 230]);
  const pivot = addBody(w, -3.2, 3.6, { r: 0.06, m: 1.0, anchor: true });
  const ball = addBody(w, -5.6, 1.4, { r: 0.4, m: 18.0, e: 0.2, mu: 0.4,
                                       color: [90, 95, 105], name: "Wrecking ball" });
  w.links.push(new DistanceLink(pivot, ball));
  return w;
}

// -------------------------------------------------------------------- chaos
function buildButterfly(): World {
  const w = new World();
  w.substeps = 12;
  const cols: Color[] = [[230, 120, 120], [120, 190, 120], [120, 160, 230]];
  for (let i = 0; i < 3; i++) {
    pendulumChain(w, 0, 1.2, 2, 0.9, 1.0, 0.12, 115 + i * 0.01, cols[i]);
  }
  return w;
}

/** Sinai billiard: a box with a circular scatterer. The curved wall
 * stretches nearby trajectories apart exponentially - textbook chaos. */
function buildSinaiBilliard(): World {
  const w = new World();
  w.gravity = 0.0;
  w.substeps = 4;
  addBox(w, 2.4, 2.4, 1.0, 0.0);
  addBody(w, 0, 0, { r: 0.75, m: 1.0, locked: true, e: 1.0, mu: 0.0,
                     color: PIVOT_GREY, name: "Scatterer" });
  const cols: Color[] = [[230, 120, 120], [110, 200, 210]];
  for (let i = 0; i < 2; i++) {
    addBody(w, -1.7, -0.40 + i * 0.13, { r: 0.055, m: 1.0,
                                         vx: 3.2, vy: 1.1 + i * 0.01,
                                         e: 1.0, mu: 0.0, color: cols[i],
                                         name: `Ball ${i + 1}` });
  }
  return w;
}

/** A pendulum swinging over three attractors with light air drag.
 *
 * It wanders chaotically before settling over one 'magnet'; which one it
 * picks depends so sensitively on the release point that the basins of
 * attraction form a fractal. */
function buildMagneticPendulum(): World {
  const w = new World();
  w.substeps = 10;
  w.mutualGravity = true; // the magnets attract via N-body gravity
  w.G = 0.02;
  w.softening = 0.08;
  w.dragLinear = 0.3;
  const pivot = addBody(w, 0, 2.2, { r: 0.06, m: 1.0, anchor: true });
  const ang = (75 * Math.PI) / 180;
  const bob = addBody(w, 1.9 * Math.sin(ang), 2.2 - 1.9 * Math.cos(ang),
                      { r: 0.11, m: 1.0, color: [235, 235, 225], name: "Bob" });
  bob.collides = false;
  w.links.push(new DistanceLink(pivot, bob));
  const magnets: Array<[[number, number], Color]> = [
    [[0.0, 0.18], [230, 120, 120]],
    [[-1.05, 0.50], [120, 190, 120]],
    [[1.05, 0.50], [120, 160, 230]],
  ];
  for (let i = 0; i < magnets.length; i++) {
    const [[mx, my], col] = magnets[i];
    const mag = addBody(w, mx, my, { r: 0.09, m: 25.0, locked: true,
                                     color: col, name: `Magnet ${i + 1}` });
    mag.collides = false;
  }
  return w;
}

function buildOrbitDance(): World {
  const w = spaceWorld(8);
  w.softening = 0.02;
  const rng = new Random(7);
  const star = addBody(w, 0, 0, { r: 0.4, m: 1200.0, color: [235, 200, 90],
                                  name: "Star" });
  star.locked = true;
  for (let i = 0; i < 14; i++) {
    const d = rng.uniform(1.5, 6.5);
    const th = rng.uniform(0, 2 * Math.PI);
    const v = Math.sqrt((w.G * star.mass) / d) * rng.uniform(0.85, 1.1);
    const b = addBody(w, d * Math.cos(th), d * Math.sin(th),
                      { r: 0.06, m: 0.02,
                        vx: -v * Math.sin(th), vy: v * Math.cos(th),
                        color: [120 + rng.randint(0, 100), 140 + rng.randint(0, 80),
                                160 + rng.randint(0, 80)] });
    b.collides = false;
  }
  return w;
}

// ----------------------------------------------------------------- registry
export const PRESETS: Preset[] = [
  new Preset("Earth & Moon", "Gravity & Orbits",
    "A light moon in a circular orbit around a heavy planet. Momentum " +
    "is balanced so the pair orbits its common centre of mass.",
    buildEarthMoon, { zoom: 60, trails: true, graph: "energy" }),
  new Preset("Kepler ellipse", "Gravity & Orbits",
    "Launching a planet below circular speed gives an ellipse. Watch " +
    "it speed up near the star: equal areas in equal times.",
    buildKepler, { zoom: 90, trails: true, vectors: true }),
  new Preset("Inner planets", "Gravity & Orbits",
    "Four planets on circular orbits, spaced like the inner solar " +
    "system. Orbital period grows with radius (Kepler's third law).",
    buildInnerPlanets, { zoom: 55, trails: true }),
  new Preset("Binary stars", "Gravity & Orbits",
    "Two equal stars orbit their barycentre while a distant planet " +
    "circles the pair - a circumbinary orbit like Kepler-16b.",
    buildBinary, { zoom: 42, trails: true }),
  new Preset("Gravity slingshot", "Gravity & Orbits",
    "A tiny probe crosses just behind a moving planet, hooks around it and " +
    "leaves about 50% faster - stolen momentum, exactly how Voyager toured " +
    "the planets. The camera auto-follows the chase.",
    buildSlingshot, { zoom: 55, trails: true, vectors: true, autoFit: true }),
  new Preset("Newton's cannon", "Gravity & Orbits",
    "Newton's thought experiment: fire a cannonball sideways from a " +
    "mountain. Too slow and it falls; at circular speed it orbits; " +
    "past sqrt(2) times that, it escapes forever.",
    buildNewtonsCannon, { zoom: 105, trails: true }),
  new Preset("Trojan asteroids", "Gravity & Orbits",
    "Asteroids sharing Jupiter's orbit, 60 degrees ahead (L4) and " +
    "behind (L5). These Lagrange points are gravitationally stable, " +
    "so the swarms slowly librate around them instead of drifting off.",
    buildTrojans, { zoom: 55, trails: true }),
  // ---- the three-body problem, from stability to chaos -------------
  new Preset("Sun, Earth & Moon", "Three-Body Problem",
    "The one arrangement of three bodies that IS stable: a " +
    "hierarchy. The Moon circles the Earth while both circle the " +
    "Sun, safe because the Moon sits deep inside Earth's Hill " +
    "sphere, where Earth's pull dominates.",
    buildSunEarthMoon, { zoom: 95, centre: [0, 0], trails: true }),
  new Preset("Three-body figure-8", "Three-Body Problem",
    "The celebrated Chenciner-Montgomery choreography: three equal " +
    "masses chase each other around a figure-eight forever. A " +
    "razor-thin periodic solution - almost any other three-body " +
    "start turns chaotic.",
    buildFigure8, { zoom: 220, trails: true, graph: "energy" }),
  new Preset("Lagrange's triangle", "Three-Body Problem",
    "Lagrange proved three bodies at an equilateral triangle can " +
    "rotate rigidly forever. For equal masses it is unstable: watch " +
    "the perfect waltz hold for a while, then shatter into chaos. " +
    "(Stable versions of these points host the Trojan asteroids.)",
    buildLagrangeTriangle, { zoom: 150, trails: true }),
  new Preset("Choreography: moth", "Three-Body Problem",
    "A true periodic solution of the three-body problem (Suvakov & " +
    "Dmitrasinovic, 2013): three equal masses chase each other along " +
    "one moth-shaped track. It is dynamically UNSTABLE - tiny errors " +
    "grow exponentially, so after many laps it must break into a " +
    "binary plus an escaper. That is chaos, not a glitch.",
    buildMoth, { zoom: 220, trails: true }),
  new Preset("Choreography: butterfly", "Three-Body Problem",
    "Another genuine periodic three-body solution, tracing butterfly " +
    "wings. Like all such choreographies it is unstable: error " +
    "doubles every couple of seconds, so even a perfect computer " +
    "eventually watches it split into a binary + escaper - the " +
    "generic fate of three bodies.",
    buildButterflyOrbit, { zoom: 220, trails: true }),
  new Preset("Pythagorean three-body", "Three-Body Problem",
    "Burrau's 1913 problem: masses 3, 4 and 5 dropped at rest from a " +
    "3-4-5 triangle. They swing through wild close encounters until " +
    "two bind into a binary and eject the third - the fate of almost " +
    "every three-body system.",
    buildPythagorean, { zoom: 70, centre: [-0.5, 1.0], trails: true,
                        graph: "energy" }),

  new Preset("Simple pendulum", "Pendulums",
    "A small-angle pendulum. Its period is 2*pi*sqrt(L/g), roughly 2.46 s " +
    "for this 1.5 m rod - time it with the clock in the toolbar!",
    buildSimplePendulum, { zoom: 130, graph: "energy" }),
  new Preset("Double pendulum", "Pendulums",
    "Two links released from high up: the classic chaotic system. " +
    "Energy stays constant while the motion never repeats.",
    buildDoublePendulum, { zoom: 130, trails: true, graph: "energy" }),
  new Preset("Triple pendulum", "Pendulums",
    "Three rigid links - even wilder than the double pendulum. Watch " +
    "the energy graph stay flat while the tip whips around.",
    buildTriplePendulum, { zoom: 110, trails: true, graph: "energy" }),
  new Preset("Swinging rope", "Pendulums",
    "Twelve elastic string segments approximate a flexible rope: " +
    "taut ones stretch a hair and pull, slack ones carry nothing, " +
    "so the rope folds and whips like real cord.",
    buildRope, { zoom: 110 }),
  new Preset("Newton's cradle", "Pendulums",
    "Five balls on strings. Elastic collisions hand momentum down the " +
    "line so one ball in means one ball out.",
    buildNewtonsCradle, { zoom: 170, graph: "momentum" }),
  new Preset("Coupled pendulums", "Pendulums",
    "Two pendulums joined by a weak spring trade energy back and " +
    "forth - the swinging slowly migrates from one to the other.",
    buildCoupledPendulums, { zoom: 130, graph: "energy" }),

  new Preset("Mass on a spring", "Oscillators",
    "Simple harmonic motion: period 2*pi*sqrt(m/k) = 1.26 s here. Open " +
    "the phase plot to see the ellipse of x against v.",
    buildShm, { zoom: 130, graph: "phase" }),
  new Preset("Damping regimes", "Oscillators",
    "Identical oscillators with light, critical and heavy damping. " +
    "Critical damping settles fastest without overshooting.",
    buildDampingRegimes, { zoom: 120, graph: "energy" }),
  new Preset("Driven resonance", "Oscillators",
    "A sinusoidal driver tuned to the natural frequency pumps the " +
    "amplitude up until damping balances the input - resonance.",
    buildResonance, { zoom: 110, graph: "energy" }),
  new Preset("Coupled oscillators", "Oscillators",
    "Three masses and four springs between two anchors. The motion is " +
    "a mixture of the system's normal modes.",
    buildCoupledOscillators, { zoom: 110, graph: "phase" }),
  new Preset("Spring pendulum", "Oscillators",
    "A bob on a spring that can also swing: energy sloshes between " +
    "stretching and swinging, and the path becomes chaotic.",
    buildSpringPendulum, { zoom: 140, trails: true }),

  new Preset("Billiard break", "Collisions & Gas",
    "A cue ball smashes a five-row rack. Watch momentum spread " +
    "through near-elastic collisions; cloth drag slows everything.",
    buildBilliards, { zoom: 110, graph: "momentum" }),
  new Preset("Restitution ladder", "Collisions & Gas",
    "Six balls with restitution 0.5 to 1.0 dropped together. Each " +
    "bounce returns to e² of the previous height, so the e = 1 ball " +
    "keeps (almost) all of it.",
    buildRestitutionLadder, { zoom: 110 }),
  new Preset("Elastic vs inelastic", "Collisions & Gas",
    "Equal masses, head-on. Elastic (top): the mover stops dead and " +
    "hands its velocity over. Perfectly inelastic (bottom): they " +
    "stick and share it. Momentum is conserved in both - kinetic " +
    "energy only in the first.",
    buildElasticVsInelastic, { zoom: 130, graph: "momentum" }),
  new Preset("Gas in a box (50)", "Collisions & Gas",
    "Fifty particles bouncing elastically in zero gravity - a toy " +
    "ideal gas. Total energy and momentum are conserved.",
    () => gasWorld(50, 2.0, 1), { zoom: 130, graph: "energy" }),
  new Preset("Gas in a box (200)", "Collisions & Gas",
    "Two hundred particles stress-test the collision engine. The " +
    "spatial hash keeps this fast; press G to see the grid.",
    () => gasWorld(200, 6.0, 2), { zoom: 45, graph: "energy" }),
  new Preset("Brownian motion", "Collisions & Gas",
    "A heavy grain jostled by a swarm of light, fast particles - the " +
    "random walk Einstein explained in 1905, cementing the case that " +
    "atoms exist. Turn on trails.",
    buildBrownian, { zoom: 105, trails: true }),

  new Preset("Projectile drag race", "Projectiles & Friction",
    "Two identical launches; a custom force field applies quadratic " +
    "air drag to one (selected by mass). Drag shortens the range and " +
    "steepens the descent.",
    buildDragRace, { zoom: 42, trails: true, vectors: true }),
  new Preset("Friction ramp", "Projectiles & Friction",
    "Three balls on a 25 degree ramp. With no friction a ball slides; " +
    "with friction it rolls - contact torque sets it spinning.",
    buildFrictionRamp, { zoom: 70 }),
  new Preset("Galileo's drop", "Projectiles & Friction",
    "A 10 kg ball and a 0.5 kg ball fall the same distance and land " +
    "together - without air, gravitational acceleration doesn't " +
    "depend on mass.",
    buildGalileo, { zoom: 110, vectors: true }),
  new Preset("Projectile angles", "Projectiles & Friction",
    "Four launches at 10 m/s. 45 degrees flies farthest, and the " +
    "30/60 pair lands on the same spot: range goes as sin(2*theta), " +
    "so complementary angles match.",
    buildProjectileAngles, { zoom: 55, trails: true, centre: [5.0, 2.2] }),
  new Preset("Terminal velocity", "Projectiles & Friction",
    "Two same-size balls falling with quadratic air drag. Drag " +
    "balances weight at v = sqrt(mg/c), so the 10x heavier ball " +
    "falls about 3x faster - Galileo needs a vacuum.",
    buildTerminalVelocity, { zoom: 60, trails: true, centre: [0, 4.0],
                             vectors: true }),
  new Preset("Wrecking ball", "Projectiles & Friction",
    "A 22 kg pendulum ball demolishes a stack. Combines constraints, " +
    "collisions, friction and gravity in one scene.",
    buildWreckingBall, { zoom: 90 }),
  new Preset("Chain bridge", "Projectiles & Friction",
    "A load dropped onto a bridge of elastic string segments. Taut " +
    "strings stretch slightly and pull; slack ones carry nothing - " +
    "so the bridge sags into a catenary-like curve under the weight.",
    buildChainBridge, { zoom: 110 }),

  new Preset("Jelly block", "Soft Bodies",
    "A 9 x 7 lattice of particles joined by structural and shear " +
    "springs - a jelly cube. Drop it, watch it splat, wobble and " +
    "settle. Grab and throw it with the mouse!",
    buildJellyBlock, { zoom: 95, centre: [0, 1.4] }),
  new Preset("Squishy ball", "Soft Bodies",
    "A hex-packed disc of particles, each sprung to its six " +
    "neighbours, rolls and splats down a V-ramp. Fully triangulated, " +
    "so it keeps its round shape - mostly.",
    buildSquishyBall, { zoom: 85, centre: [0, 2.0] }),
  new Preset("Trampoline", "Soft Bodies",
    "A springy bed of particles strung between two anchors. The " +
    "ball's energy trades between gravity and spring tension every " +
    "bounce. Try changing the ball's mass!",
    buildTrampoline, { zoom: 110, centre: [0, 1.0], graph: "energy" }),
  new Preset("Soft wheel", "Soft Bodies",
    "A deformable tyre: a sprung tread ring with spokes to a hub. It " +
    "flattens against the ramp as it rolls, just like a real tyre at " +
    "low pressure.",
    buildSoftWheel, { zoom: 80, centre: [5.0, -1.0], trails: false }),
  new Preset("Jelly smash", "Soft Bodies",
    "A rigid wrecking ball meets a soft jelly block: constraints, " +
    "contacts and 200-odd springs all at once. The jelly absorbs the " +
    "blow and jiggles it away as heat (spring damping).",
    buildJellySmash, { zoom: 80, centre: [-0.5, 1.0] }),

  new Preset("Butterfly effect", "Chaos",
    "Three double pendulums released 0.01 degrees apart. They track " +
    "each other briefly, then diverge completely - chaos.",
    buildButterfly, { zoom: 130, trails: true }),
  new Preset("Orbit dance", "Chaos",
    "Fourteen tiny moons on eccentric orbits around one star. Long-" +
    "term structure emerges from simple inverse-square gravity.",
    buildOrbitDance, { zoom: 55, trails: true }),
  new Preset("Sinai billiard", "Chaos",
    "Two balls launched a hair apart in a box with a circular " +
    "scatterer. Every bounce off the curved wall stretches their " +
    "separation - exponential divergence, while energy stays exactly " +
    "flat. The founding example of provable chaos.",
    buildSinaiBilliard, { zoom: 125, trails: true, graph: "energy" }),
  new Preset("Cyclone", "Chaos",
    "Sixty particles caught in a storm written entirely as two force-field " +
    "formulas: a swirling wind that fades with distance (exp), an inward " +
    "pull, a comparison (r < 0.7) acting as a switch that hollows out a " +
    "calm eye, and drag. Open the World tab to read - and edit - the " +
    "formulas while it runs.",
    buildCyclone, { zoom: 85, trails: true }),
  new Preset("Magnetic pendulum", "Chaos",
    "A pendulum swings over three attracting 'magnets' with light " +
    "air drag. It wanders unpredictably before settling over one - " +
    "and which one depends so sensitively on the release point that " +
    "the basins of attraction form a fractal. Try nudging the bob.",
    buildMagneticPendulum, { zoom: 110, trails: true }),
];

export const CATEGORIES: string[] = (() => {
  const seen: string[] = [];
  for (const p of PRESETS) {
    if (!seen.includes(p.category)) seen.push(p.category);
  }
  return ["All", ...seen];
})();
