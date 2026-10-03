/** Behaviour contracts for every library card at its shipped Normal settings.
 * Construction counts and finite trajectories do not prove an advertised event.
 * Analytic cases use independent equations; showcases check their actual event,
 * conservation law, transfer, deformation or containment over a named interval. */
import { describe, expect, it } from "vitest";
import { Body } from "../src/engine/body";
import { DistanceLink, PulleyLink, SpringLink } from "../src/engine/links";
import { World } from "../src/engine/world";
import { PRESETS } from "../src/scene/presets";

const DT = 1 / 120;
const movers = (w: World) => w.bodies.filter(b => !b.locked && !b.isRodEndpoint);
const build = (name: string) => PRESETS.find(p => p.name === name)!.build();
function run(w: World, seconds: number, observe: () => void = () => {}): void {
  for (let k = 0; k < Math.round(seconds / DT); k++) { w.step(DT); observe(); }
  expect(w.diverged).toHaveLength(0);
}
const cross = (a: Body, b: Body) => {
  const r = b.pos.sub(a.pos), v = b.vel.sub(a.vel); return r.x * v.y - r.y * v.x;
};
function conservativeMotion(w: World, seconds: number, tolerance: number): void {
  const energy = w.energy().total, start = movers(w).map(b => b.pos.copy());
  let error = 0;
  run(w, seconds, () => { error = Math.max(error, Math.abs(w.energy().total - energy)); });
  expect(error).toBeLessThan(tolerance);
  expect(Math.max(...movers(w).map((b, i) => b.pos.distTo(start[i])))).toBeGreaterThan(0.05);
}
function pendulum(w: World, seconds: number, tolerance: number): void {
  const rods = w.links.filter((l): l is DistanceLink => l instanceof DistanceLink);
  let error = 0;
  conservativeMotion(w, seconds, tolerance);
  for (const rod of rods) error = Math.max(error, Math.abs(rod.a.pos.distTo(rod.b.pos) - rod.length));
  expect(error).toBeLessThan(1e-6);
}
function gas(w: World): void {
  const energy = w.energy().ke;
  run(w, 10);
  expect(Math.abs(w.energy().ke - energy) / energy).toBeLessThan(0.003);
  const half = Math.max(...w.walls.map(wall => wall.a.x));
  for (const b of movers(w)) {
    expect(Math.abs(b.pos.x) + b.radius).toBeLessThan(half + 0.001);
    expect(Math.abs(b.pos.y) + b.radius).toBeLessThan(half + 0.001);
  }
}

const outcomes: Record<string, (w: World) => void> = {
  "Earth & Moon": w => {
    const [earth, moon] = w.bodies, r = earth.pos.distTo(moon.pos);
    // For softened gravity a_rel = GM*r/(r²+eps²)^(3/2), v_rel² = a_rel*r.
    const totalMass = earth.mass + moon.mass;
    const speed = Math.sqrt(w.G * totalMass * r * r / (r * r + w.softening ** 2) ** 1.5);
    expect(moon.vel.sub(earth.vel).length()).toBeCloseTo(speed, 10);
    let error = 0;
    run(w, 2 * 2 * Math.PI * r / speed, () => {
      error = Math.max(error, Math.abs(earth.pos.distTo(moon.pos) - r));
    });
    expect(error).toBeLessThan(0.0002);
    expect(w.momentum().length()).toBeLessThan(1e-8);
  },
  "Kepler ellipse": w => {
    const [star, planet] = w.bodies, h = cross(star, planet), apogee = planet.pos.length();
    let minimum = apogee, fastest = 0, angularError = 0;
    run(w, 3, () => {
      minimum = Math.min(minimum, planet.pos.length()); fastest = Math.max(fastest, planet.vel.length());
      angularError = Math.max(angularError, Math.abs(cross(star, planet) - h));
    });
    expect(minimum).toBeLessThan(apogee * 0.4);
    expect(fastest).toBeGreaterThan(planet.vel.length());
    expect(angularError).toBeLessThan(1e-8);
  },
  "Inner planets": w => {
    const sun = w.bodies[0], planets = movers(w), periods = new Map<number, number>();
    const radii = planets.map(b => b.pos.length()), previous = planets.map(b => b.pos.y);
    run(w, 2, () => {
      planets.forEach((b, i) => {
        if (previous[i] < 0 && b.pos.y >= 0 && b.pos.x > 0 && !periods.has(b.id)) {
          periods.set(b.id, w.time - DT * b.pos.y / (b.pos.y - previous[i]));
        }
        previous[i] = b.pos.y;
      });
    });
    planets.forEach((b, i) => {
      expect(periods.has(b.id)).toBe(true);
      const analytic = 2 * Math.PI * Math.sqrt(radii[i] ** 3 / (w.G * sun.mass));
      expect(Math.abs(periods.get(b.id)! / analytic - 1)).toBeLessThan(0.01);
    });
  },
  "Binary stars": w => {
    const [a, b, planet] = w.bodies, separation = a.pos.distTo(b.pos);
    run(w, 6, () => {
      expect(Math.abs(a.pos.distTo(b.pos) - separation)).toBeLessThan(0.04);
      expect(planet.pos.length()).toBeGreaterThan(5);
      expect(planet.pos.length()).toBeLessThan(9);
    });
  },
  "Gravity slingshot": w => {
    const [planet, probe] = w.bodies, speed = probe.vel.length(), momentum = w.momentum().copy();
    run(w, 10);
    expect(probe.vel.length() / speed).toBeGreaterThan(1.45);
    expect(probe.vel.length() / speed).toBeLessThan(1.6);
    expect(probe.pos.distTo(planet.pos)).toBeGreaterThan(20);
    expect(w.momentum().distTo(momentum)).toBeLessThan(1e-8);
  },
  "Newton's cannon": () => {
    // The card explicitly asks for individual shots for this comparison.
    for (const index of [1, 2, 3, 4, 5]) {
      const w = build("Newton's cannon"), planet = w.bodies[0], shot = w.bodies[index];
      w.bodies = [planet, shot]; const radius = shot.pos.length(); let nearest = radius, farthest = radius;
      run(w, 4, () => { nearest = Math.min(nearest, shot.pos.length()); farthest = Math.max(farthest, shot.pos.length()); });
      if (index <= 2) expect(nearest).toBeLessThan(planet.radius + shot.radius + 0.002);
      if (index === 3) expect(farthest - nearest).toBeLessThan(0.001);
      if (index === 4) { expect(farthest).toBeGreaterThan(2.5); expect(farthest).toBeLessThan(3.1); }
      if (index === 5) expect(shot.pos.length()).toBeGreaterThan(10);
    }
  },
  "Trojan asteroids": w => {
    const [sun, jupiter] = w.bodies, asteroids = w.bodies.slice(2);
    expect(sun.locked).toBe(false);
    const sides = asteroids.map(b => Math.sign(b.pos.y - sun.pos.y));
    run(w, 100, () => {
      for (const [i, b] of asteroids.entries()) {
        const r = b.pos.sub(sun.pos), axis = jupiter.pos.sub(sun.pos);
        const angle = Math.atan2(r.x * axis.y - r.y * axis.x, r.dot(axis));
        expect(Math.sign(angle)).toBe(-sides[i]);
        expect(Math.abs(angle)).toBeGreaterThan(0.6); expect(Math.abs(angle)).toBeLessThan(1.5);
        // The seeded swarm is deliberately perturbed, not an exact equilateral
        // solution: bound libration against Jupiter's orbit, not a 3% circle.
        expect(Math.abs(r.length() / axis.length() - 1)).toBeLessThan(0.2);
      }
    });
  },
  "Sun, Earth & Moon": w => {
    const [sun, earth, moon] = w.bodies;
    run(w, 10, () => {
      expect(earth.pos.distTo(moon.pos)).toBeGreaterThan(0.1);
      expect(earth.pos.distTo(moon.pos)).toBeLessThan(0.4);
      expect(sun.pos.distTo(earth.pos)).toBeGreaterThan(3.5);
      expect(sun.pos.distTo(earth.pos)).toBeLessThan(4.5);
    });
    expect(w.momentum().length()).toBeLessThan(1e-7);
  },
  "Three-body figure-8": w => {
    const start = w.bodies.map(b => b.pos.copy());
    run(w, 6.3259);
    w.bodies.forEach((b, i) => expect(b.pos.distTo(start[i])).toBeLessThan(0.004));
    expect(w.momentum().length()).toBeLessThan(1e-9);
  },
  "Lagrange's triangle": w => {
    const side = w.bodies[0].pos.distTo(w.bodies[1].pos);
    run(w, 0.5, () => {
      for (let i = 0; i < 3; i++) expect(Math.abs(w.bodies[i].pos.distTo(w.bodies[(i + 1) % 3].pos) - side)).toBeLessThan(0.002);
    });
  },
  "Choreography: moth": w => conservativeMotion(w, 10, 0.001),
  "Choreography: butterfly": w => conservativeMotion(w, 10, 0.001),
  "Pythagorean three-body": w => {
    let closest = Infinity;
    conservativeMotion(w, 10, 0.005);
    for (let i = 0; i < 3; i++) closest = Math.min(closest, w.bodies[i].pos.distTo(w.bodies[(i + 1) % 3].pos));
    expect(closest).toBeLessThan(2);
    expect(w.momentum().length()).toBeLessThan(1e-8);
  },
  "Simple pendulum": w => {
    const bob = movers(w)[0], length = (w.links[0] as DistanceLink).length;
    let previous = bob.pos.x, period = 0;
    run(w, 3, () => { if (previous < 0 && bob.pos.x >= 0 && !period) period = w.time - DT * bob.pos.x / (bob.pos.x - previous); previous = bob.pos.x; });
    // Release is a turning point: upward crossing occurs at 3T/4. The 20°
    // amplitude increases the small-angle period by about 0.77 percent.
    const measured = period * 4 / 3, smallAngle = 2 * Math.PI * Math.sqrt(length / w.gravity);
    expect(measured / smallAngle).toBeGreaterThan(1); expect(measured / smallAngle).toBeLessThan(1.01);
  },
  "Double pendulum": w => pendulum(w, 10, 0.005),
  "Triple pendulum": w => pendulum(w, 10, 0.01),
  "Swinging rope": w => {
    const tip = movers(w).at(-1)!, start = tip.pos.copy(), energy = w.energy().total;
    run(w, 5);
    expect(tip.pos.distTo(start)).toBeGreaterThan(1);
    expect(w.energy().total).toBeLessThan(energy);
    expect(w.links.some(l => l instanceof SpringLink && l.a.pos.distTo(l.b.pos) > l.restLength)).toBe(true);
  },
  "Newton's cradle": w => {
    const bobs = movers(w); run(w, 2);
    const speeds = bobs.map(b => b.vel.length()).sort((a, b) => b - a);
    expect(speeds[0]).toBeGreaterThan(1); expect(speeds[1]).toBeLessThan(speeds[0] * 0.1);
  },
  "Coupled pendulums": w => {
    const [a, b] = movers(w), startB = b.pos.copy(); run(w, 10);
    expect(b.pos.distTo(startB)).toBeGreaterThan(0.4);
    expect(Math.abs(a.pos.x + 0.8)).toBeLessThan(0.05);
  },
  "Atwood machine": w => {
    const string = w.links[0] as PulleyLink, floor = w.walls[0];
    const y = floor.a.y + floor.thickness / 2 + string.b.radius;
    let caught = false;
    run(w, 2, () => { if (Math.abs(string.b.pos.y - y) < 0.001 && Math.abs(string.b.vel.y) < 0.01) caught = true; });
    expect(caught).toBe(true);
  },
  "Rough table and pulley": w => {
    const string = w.links[0] as PulleyLink; run(w, 0.5);
    expect(string.a.vel.x).toBeCloseTo(1.96 * w.time, 3);
    expect(string.b.vel.y).toBeCloseTo(-1.96 * w.time, 3);
  },
  "Balanced beam": w => { const starts = movers(w).map(b => b.pos.copy()); run(w, 10); movers(w).forEach((b, i) => expect(b.pos.distTo(starts[i])).toBeLessThan(1e-6)); },
  "Loaded rod pendulum": w => conservativeMotion(w, 10, 0.001),
  "Rod rotor": w => { const load = movers(w)[0], start = load.pos.copy(); run(w, 3); expect(load.pos.x).toBeCloseTo(start.x * Math.cos(w.time), 3); expect(load.pos.y).toBeCloseTo(start.x * Math.sin(w.time), 3); },
  "Swinging Atwood machine": w => {
    const string = w.links[0] as PulleyLink, x = string.a.pos.x, y = string.b.pos.y;
    run(w, 0.5);
    expect(Math.abs(string.a.pos.x - x)).toBeGreaterThan(0.1); expect(Math.abs(string.b.pos.y - y)).toBeGreaterThan(0.05);
    expect(Math.abs(string.currentLength() - string.length)).toBeLessThan(1e-6);
  },
  "Mass on a spring": w => {
    const link = w.links[0] as SpringLink, bob = movers(w)[0], start = bob.pos.copy();
    const period = 2 * Math.PI * Math.sqrt(bob.mass / link.stiffness);
    const n = Math.floor(period / DT); for (let i = 0; i < n; i++) w.step(DT); w.step(period - n * DT);
    expect(bob.pos.distTo(start)).toBeLessThan(1e-5); expect(bob.vel.length()).toBeLessThan(0.0001);
  },
  "Elastic string release": w => {
    const link = w.links[0] as SpringLink, bob = movers(w)[0];
    const turning = Math.PI * Math.sqrt(bob.mass / link.stiffness);
    const n = Math.floor(turning / DT); for (let i = 0; i < n; i++) w.step(DT); w.step(turning - n * DT);
    expect(link.a.pos.distTo(link.b.pos) - link.restLength).toBeCloseTo(2, 7); expect(bob.vel.length()).toBeLessThan(1e-7);
  },
  "Damping regimes": w => {
    const [under, critical, over] = movers(w), equilibrium = 2 - 1.2 - w.gravity / 25;
    let underMax = 0, criticalMax = 0, overMax = 0;
    run(w, 2, () => { underMax = Math.max(underMax, under.pos.y); criticalMax = Math.max(criticalMax, critical.pos.y); overMax = Math.max(overMax, over.pos.y); });
    expect(underMax).toBeGreaterThan(equilibrium + 0.1);
    expect(criticalMax).toBeLessThanOrEqual(equilibrium + 1e-7); expect(overMax).toBeLessThanOrEqual(equilibrium + 1e-7);
    expect(Math.abs(critical.pos.y - equilibrium)).toBeLessThan(Math.abs(over.pos.y - equilibrium) * 0.01);
  },
  "Driven resonance": w => {
    const bob = movers(w)[0]; let early = 0, late = 0;
    run(w, 40, () => { const amplitude = Math.abs(bob.pos.x - 1.2); if (w.time < 2) early = Math.max(early, amplitude); if (w.time > 35) late = Math.max(late, amplitude); });
    expect(late).toBeGreaterThan(early * 2); expect(late).toBeCloseTo(1 / (0.4 * 5), 2);
  },
  "Coupled oscillators": w => {
    const bodies = movers(w), positions = [-1.2, 0, 1.2]; run(w, 1.1);
    for (let mode = 1; mode <= 3; mode++) {
      const measured = bodies.reduce((sum, b, i) => sum + (b.pos.x - positions[i]) * Math.sin((i + 1) * mode * Math.PI / 4), 0);
      const omega = 2 * Math.sqrt(30) * Math.sin(mode * Math.PI / 8);
      expect(measured).toBeCloseTo(-0.5 * Math.sin(mode * Math.PI / 4) * Math.cos(omega * w.time), 3);
    }
  },
  "Spring pendulum": w => conservativeMotion(w, 10, 0.001),
  "Billiard break": w => {
    const balls = movers(w), start = balls.map(b => b.pos.copy()), energy = w.energy().ke;
    run(w, 3); expect(balls.filter((b, i) => b.pos.distTo(start[i]) > 0.1).length).toBeGreaterThan(10);
    expect(w.energy().ke).toBeLessThan(energy / 2);
  },
  "Restitution ladder": w => {
    const balls = movers(w), floor = w.walls[0], starts = balls.map(b => b.pos.y);
    const status = balls.map(() => ({ bounces: 0, previous: 0, top: -Infinity }));
    run(w, 2, () => { balls.forEach((b, i) => {
      const s = status[i]; if (s.previous < 0 && b.vel.y > 0) s.bounces++;
      if (s.bounces === 1) s.top = Math.max(s.top, b.pos.y); s.previous = b.vel.y;
    }); });
    balls.forEach((b, i) => {
      const contact = floor.a.y + floor.thickness / 2 + b.radius;
      expect((status[i].top - contact) / (starts[i] - contact)).toBeCloseTo(b.restitution ** 2, 2);
    });
  },
  "Elastic vs inelastic": w => { run(w, 2); expect(w.bodies.map(b => b.vel.x)).toEqual([0, 2, 1, 1]); },
  "Direct collision": w => { run(w, 1); expect(w.bodies[0].vel.x).toBeCloseTo(-0.8, 10); expect(w.bodies[1].vel.x).toBeCloseTo(2.2, 10); expect(w.momentum().x).toBeCloseTo(5, 10); },
  "Gas in a box (50)": gas,
  "Gas in a box (200)": gas,
  "Brownian motion": w => { const grain = w.bodies[0], start = grain.pos.copy(); gas(w); expect(grain.pos.distTo(start)).toBeGreaterThan(0.5); },
  "Rough inclined plane": w => { const b = w.bodies[0], floor = w.walls[1]; run(w, 10); expect(b.pos.x).toBeGreaterThan(floor.a.x); expect(b.pos.x).toBeLessThan(floor.b.x); expect(Math.abs(b.pos.y - floor.a.y - floor.thickness / 2 - b.radius)).toBeLessThan(0.000501); expect(b.vel.length()).toBeLessThan(1e-6); },
  "Projectile drag race": w => {
    const [vacuum, drag] = w.bodies, initial = vacuum.pos.copy(); run(w, 1);
    expect(vacuum.pos.x - initial.x).toBeCloseTo(9, 8); expect(vacuum.pos.y).toBeCloseTo(initial.y + 9 - w.gravity / 2, 8);
    expect(drag.pos.x - (-0.4)).toBeLessThan(vacuum.pos.x - initial.x);
    run(w, 9); expect(vacuum.pos.y).toBeGreaterThan(0.1); expect(drag.pos.y).toBeGreaterThan(0.1);
  },
  "Friction ramp": w => {
    const [free, moderate, held] = movers(w), theta = 25 * Math.PI / 180;
    const along = (b: Body) => b.vel.x * Math.cos(theta) - b.vel.y * Math.sin(theta);
    const start = held.pos.copy(); run(w, 0.5);
    expect(along(free)).toBeCloseTo(w.gravity * Math.sin(theta) * w.time, 3);
    expect(along(moderate)).toBeCloseTo(w.gravity * (Math.sin(theta) - 0.25 * Math.cos(theta)) * w.time, 3);
    run(w, 9.5); expect(held.pos.distTo(start)).toBeLessThan(0.001); expect(held.vel.length()).toBeLessThan(1e-6);
  },
  "Pulley on an incline": w => {
    const string = w.links[0] as PulleyLink, start = string.a.pos.copy();
    const axis = w.walls[0].b.sub(w.walls[0].a), length = axis.length();
    const sin = axis.y / length, cos = axis.x / length;
    const mu = Math.sqrt(string.a.friction * w.walls[0].friction);
    const acceleration = w.gravity * (string.b.mass - string.a.mass * (sin + mu * cos)) / (string.a.mass + string.b.mass);
    run(w, 0.5);
    expect(Math.abs(string.a.pos.distTo(start) - acceleration * w.time ** 2 / 2)).toBeLessThan(0.0003);
    expect(Math.abs(string.currentLength() - string.length)).toBeLessThan(1e-6);
    expect(Math.abs(-string.a.vel.x * sin + string.a.vel.y * cos)).toBeLessThan(0.001);
  },
  "Galileo's drop": w => {
    const balls = movers(w), landed = [0, 0]; run(w, 1, () => { balls.forEach((b, i) => { if (!landed[i] && b.vel.y > 0) landed[i] = w.time; }); });
    expect(landed[0]).toBeGreaterThan(0); expect(landed[0]).toBe(landed[1]);
    expect(Math.abs(landed[0] - Math.sqrt(2 * 3.2 / w.gravity))).toBeLessThan(DT);
  },
  "Which lands first?": w => {
    const [drop, launch] = w.bodies; run(w, 0.7, () => expect(drop.pos.y).toBeCloseTo(launch.pos.y, 10));
    const landed = [0, 0]; run(w, 0.2, () => { [drop, launch].forEach((b, i) => { if (!landed[i] && b.vel.y > 0) landed[i] = w.time; }); });
    expect(landed[0]).toBeGreaterThan(0); expect(landed[0]).toBe(landed[1]);
  },
  "Projectile angles": () => {
    const ranges: number[] = [];
    for (let i = 0; i < 4; i++) {
      const w = build("Projectile angles"), b = w.bodies[i]; w.bodies = [b];
      const vx = b.vel.x, vy = b.vel.y, initialX = b.pos.x, fall = b.pos.y - w.walls[0].thickness / 2 - b.radius;
      const time = (vy + Math.sqrt(vy ** 2 + 2 * w.gravity * fall)) / w.gravity;
      let x = 0, previous = vy;
      run(w, 3, () => { if (!x && previous < 0 && b.vel.y > 0) x = b.pos.x; previous = b.vel.y; });
      expect(Math.abs((x - initialX) - vx * time)).toBeLessThan(0.08); ranges.push(x - initialX);
    }
    expect(ranges[1]).toBeGreaterThan(Math.max(ranges[0], ranges[2], ranges[3])); expect(Math.abs(ranges[0] - ranges[2])).toBeLessThan(0.08);
    const w = build("Projectile angles"); run(w, 10); for (const b of w.bodies) expect(b.pos.y).toBeGreaterThan(0);
  },
  "Terminal velocity": w => {
    run(w, 0.6);
    for (const b of w.bodies) { const vt = Math.sqrt(b.mass * w.gravity / w.dragQuadratic); expect(-b.vel.y).toBeCloseTo(vt * Math.tanh(w.gravity * w.time / vt), 7); }
  },
  "Wrecking ball": w => { const bricks = movers(w).filter(b => b.mass === 0.4), start = bricks.map(b => b.pos.copy()); run(w, 7.5); expect(bricks.filter((b, i) => b.pos.distTo(start[i]) > 0.2).length).toBeGreaterThan(bricks.length / 2); },
  "Chain bridge": w => { const load = w.bodies.find(b => b.name === "Load")!; run(w, 5); expect(load.pos.y).toBeLessThan(1.5); expect(load.pos.y).toBeGreaterThan(0); expect(movers(w).filter(b => b !== load).some(b => b.pos.y < 0.9)).toBe(true); },
  "Jelly block": w => { const energy = w.energy().total; run(w, 10); expect(w.energy().total).toBeLessThan(energy); expect(movers(w).every(b => b.pos.y > 0)).toBe(true); expect(w.energy().ke).toBeLessThan(energy * 0.01); },
  "Squishy ball": w => { const parts = movers(w); run(w, 10); expect(Math.abs(parts.reduce((sum, b) => sum + b.pos.x, 0) / parts.length)).toBeLessThan(0.3); expect(Math.max(...parts.map(b => b.pos.y)) - Math.min(...parts.map(b => b.pos.y))).toBeGreaterThan(0.6); },
  "Trampoline": w => { const ball = w.bodies.find(b => b.name === "Gymnast")!; let low = ball.pos.y, rebound = -Infinity; run(w, 5, () => { if (ball.pos.y < low) { low = ball.pos.y; rebound = low; } else rebound = Math.max(rebound, ball.pos.y); }); expect(low).toBeLessThan(0); expect(rebound).toBeGreaterThan(1.5); },
  "Soft wheel": w => { const hub = w.bodies.find(b => b.name === "Hub")!, start = hub.pos.x; let strain = 0; run(w, 5, () => { for (const l of w.links as SpringLink[]) strain = Math.max(strain, Math.abs(l.a.pos.distTo(l.b.pos) - l.restLength)); }); expect(hub.pos.x - start).toBeGreaterThan(5); expect(strain).toBeGreaterThan(0.03); expect(hub.pos.y).toBeGreaterThan(-3); },
  "Jelly smash": w => { const soft = movers(w).filter(b => b.softBody), start = soft.map(b => b.pos.copy()), energy = w.energy().total; run(w, 10); expect(soft.some((b, i) => b.pos.distTo(start[i]) > 1)).toBe(true); expect(w.energy().total).toBeLessThan(energy); expect(soft.every(b => b.pos.y > -0.5)).toBe(true); },
  "Butterfly effect": w => { const tips = [w.bodies[2], w.bodies[5], w.bodies[8]], initial = tips[0].pos.distTo(tips[2].pos); run(w, 10); expect(tips[0].pos.distTo(tips[2].pos)).toBeGreaterThan(initial * 100); },
  "Orbit dance": w => { run(w, 10, () => { for (const b of movers(w)) { expect(b.pos.length()).toBeGreaterThan(0.5); expect(b.pos.length()).toBeLessThan(10); } }); },
  "Sinai billiard": w => { const energy = w.energy().ke, [a, b] = movers(w), separation = a.pos.distTo(b.pos); run(w, 10); expect(Math.abs(w.energy().ke - energy)).toBeLessThan(1e-10); expect(a.pos.distTo(b.pos)).toBeGreaterThan(separation * 5); },
  "Cyclone": w => { run(w, 5); expect(w.fields[0].error).toBe(""); expect(movers(w).every(b => b.vel.length() > 1 && b.pos.length() < 10)).toBe(true); },
};

describe("premade behaviour contracts", () => {
  it("requires an explicit outcome check for every preset", () => {
    expect(Object.keys(outcomes).sort()).toEqual(PRESETS.map(p => p.name).sort());
  });
  for (const [name, check] of Object.entries(outcomes)) it(name, () => check(build(name)));
});
