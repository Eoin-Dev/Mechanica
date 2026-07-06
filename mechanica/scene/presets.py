"""Built-in example library.

Every preset is a small builder that returns a fresh World plus view hints
(camera zoom/centre, overlays to enable, which graph to open). Descriptions
double as the educational blurb shown on the preset card.
"""
from __future__ import annotations

from math import cos, pi, radians, sin
from random import Random

from mechanica.core.vec import Vec2
from mechanica.engine.body import Body, Wall
from mechanica.engine.links import DistanceLink, SpringLink
from mechanica.engine.world import Driver, ForceField, World


class Preset:
    def __init__(self, name: str, category: str, description: str, build,
                 hints: dict | None = None) -> None:
        self.name = name
        self.category = category
        self.description = description
        self.build = build
        self.hints = hints or {}


# ----------------------------------------------------------------- helpers
def _space_world(substeps: int = 4) -> World:
    w = World()
    w.gravity = 0.0
    w.mutual_gravity = True
    w.G = 1.0
    w.integrator = "Velocity Verlet"
    w.substeps = substeps
    return w


def _add_body(w: World, x: float, y: float, r: float = 0.15, m: float = 1.0,
              vx: float = 0.0, vy: float = 0.0, e: float = 0.8, mu: float = 0.4,
              locked: bool = False, color=None, name: str | None = None) -> Body:
    b = Body(Vec2(x, y), r, m, color)
    b.vel.set(vx, vy)
    b.restitution = e
    b.friction = mu
    b.locked = locked
    if name:
        b.name = name
    w.bodies.append(b)
    return b


def _add_box(w: World, half_w: float, half_h: float, e: float = 1.0,
             mu: float = 0.0, thickness: float = 0.1) -> None:
    corners = [Vec2(-half_w, half_h), Vec2(half_w, half_h),
               Vec2(half_w, -half_h), Vec2(-half_w, -half_h)]
    for i in range(4):
        wall = Wall(corners[i].copy(), corners[(i + 1) % 4].copy(), thickness)
        wall.restitution = e
        wall.friction = mu
        w.walls.append(wall)


def _pendulum_chain(w: World, px: float, py: float, n: int, seg: float,
                    mass: float = 1.0, r: float = 0.12, angle_deg: float = 90.0,
                    color=None) -> list[Body]:
    """Pivot + n bobs hanging as a rigid chain, released at angle_deg from
    vertical (90 = horizontal)."""
    pivot = _add_body(w, px, py, 0.06, 1.0, locked=True, color=(120, 125, 135),
                      name="Pivot")
    a = radians(angle_deg)
    dx, dy = sin(a), -cos(a)
    bodies = [pivot]
    for i in range(1, n + 1):
        b = _add_body(w, px + dx * seg * i, py + dy * seg * i, r, mass, color=color)
        b.collides = False
        w.links.append(DistanceLink(bodies[-1], b))
        bodies.append(b)
    return bodies


# ------------------------------------------------------------ gravity/orbits
def _build_earth_moon() -> World:
    w = _space_world(substeps=6)
    earth = _add_body(w, 0, 0, 0.6, 1000.0, color=(86, 140, 214), name="Earth")
    moon = _add_body(w, 4.5, 0, 0.16, 12.0, color=(190, 190, 200), name="Moon")
    v = (w.G * (earth.mass + moon.mass) / 4.5) ** 0.5
    moon.vel.set(0, v)
    earth.vel.set(0, -v * moon.mass / earth.mass)  # net momentum zero
    return w


def _build_kepler() -> World:
    w = _space_world(substeps=8)
    _add_body(w, 0, 0, 0.5, 1000.0, locked=True, color=(235, 200, 90), name="Star")
    p = _add_body(w, 3.0, 0, 0.12, 1.0, color=(86, 156, 214), name="Planet")
    p.vel.set(0, (w.G * 1000 / 3.0) ** 0.5 * 0.72)  # sub-circular -> ellipse
    return w


def _build_inner_planets() -> World:
    w = _space_world(substeps=6)
    star = _add_body(w, 0, 0, 0.55, 3000.0, color=(235, 200, 90), name="Sun")
    star.locked = True
    data = [("Mercury", 1.6, 0.07, 0.5, (200, 180, 150)),
            ("Venus", 2.6, 0.11, 2.0, (230, 190, 130)),
            ("Earth", 3.8, 0.12, 2.2, (86, 156, 214)),
            ("Mars", 5.2, 0.09, 1.0, (220, 120, 80))]
    for name, dist, r, m, col in data:
        p = _add_body(w, dist, 0, r, m, color=col, name=name)
        p.vel.set(0, (w.G * star.mass / dist) ** 0.5)
    return w


def _build_binary() -> World:
    w = _space_world(substeps=8)
    m, d = 500.0, 1.6
    v = 0.5 * (w.G * m / d) ** 0.5  # circular mutual orbit of equal masses
    _add_body(w, -d / 2, 0, 0.35, m, vy=-v, color=(235, 170, 90), name="Star A")
    _add_body(w, d / 2, 0, 0.35, m, vy=v, color=(140, 180, 235), name="Star B")
    p = _add_body(w, 6.0, 0, 0.1, 0.5, color=(120, 200, 140), name="Planet")
    p.vel.set(0, (w.G * 2 * m / 6.0) ** 0.5)
    return w


def _build_figure8() -> World:
    # Chenciner-Montgomery figure-eight choreography (G = m = 1)
    w = _space_world(substeps=8)
    w.softening = 0.001
    x1, y1 = 0.97000436, -0.24308753
    vx3, vy3 = -0.93240737, -0.86473146
    a = _add_body(w, x1, y1, 0.08, 1.0, color=(230, 120, 120))
    b = _add_body(w, -x1, -y1, 0.08, 1.0, color=(120, 200, 140))
    c = _add_body(w, 0, 0, 0.08, 1.0, color=(120, 160, 230))
    a.vel.set(-vx3 / 2, -vy3 / 2)
    b.vel.set(-vx3 / 2, -vy3 / 2)
    c.vel.set(vx3, vy3)
    for body in (a, b, c):
        body.collides = False
    return w


def _build_slingshot() -> World:
    w = _space_world(substeps=8)
    planet = _add_body(w, 0, 0, 0.5, 800.0, vx=-1.5, color=(200, 150, 100),
                       name="Planet")
    probe = _add_body(w, 9.0, -2.4, 0.07, 0.001, vx=-4.0, color=(200, 220, 240),
                      name="Probe")
    probe.collides = planet.collides = False
    return w


# ----------------------------------------------------------------- pendulums
def _build_simple_pendulum() -> World:
    w = World()
    w.substeps = 8
    _pendulum_chain(w, 0, 1.5, 1, 1.5, angle_deg=20, color=(86, 156, 214))
    return w


def _build_double_pendulum() -> World:
    w = World()
    w.substeps = 12
    _pendulum_chain(w, 0, 1.2, 2, 0.9, angle_deg=115, color=(220, 130, 90))
    return w


def _build_triple_pendulum() -> World:
    w = World()
    w.substeps = 12
    _pendulum_chain(w, 0, 1.5, 3, 0.7, angle_deg=100, color=(200, 110, 180))
    return w


def _build_rope() -> World:
    w = World()
    w.substeps = 12
    w.iterations = 12
    _pendulum_chain(w, 0, 1.8, 12, 0.22, mass=0.2, r=0.05, angle_deg=85,
                    color=(170, 140, 230))
    return w


def _build_newtons_cradle() -> World:
    w = World()
    w.substeps = 10
    r, gap = 0.15, 0.302  # just over the diameter so balls rest touching
    for i in range(5):
        x = (i - 2) * gap
        pivot = _add_body(w, x, 1.4, 0.05, 1.0, locked=True,
                          color=(120, 125, 135))
        ball = _add_body(w, x, 0.0, r, 1.0, e=1.0, mu=0.0,
                         color=(150, 160, 175), name=f"Ball {i + 1}")
        w.links.append(DistanceLink(pivot, ball))
    # pull the first ball aside, keeping the string taut
    first = w.bodies[1]
    ang = radians(60)
    first.pos.set(-2 * gap - 1.4 * sin(ang), 1.4 - 1.4 * cos(ang))
    return w


def _build_coupled_pendulums() -> World:
    w = World()
    w.substeps = 10
    chain_a = _pendulum_chain(w, -0.8, 1.2, 1, 1.2, angle_deg=25,
                              color=(86, 156, 214))
    chain_b = _pendulum_chain(w, 0.8, 1.2, 1, 1.2, angle_deg=0,
                              color=(220, 130, 90))
    spring = SpringLink(chain_a[1], chain_b[1], stiffness=3.0)
    w.links.append(spring)
    return w


# --------------------------------------------------------------- oscillators
def _build_shm() -> World:
    w = World()
    w.substeps = 6
    anchor = _add_body(w, 0, 2.0, 0.06, 1.0, locked=True, color=(120, 125, 135))
    bob = _add_body(w, 0, 0.2, 0.16, 1.0, color=(86, 156, 214), name="Mass")
    w.links.append(SpringLink(anchor, bob, rest_length=1.2, stiffness=25.0))
    return w


def _build_damping_regimes() -> World:
    w = World()
    w.substeps = 6
    k, m = 25.0, 1.0
    crit = 2.0 * (k * m) ** 0.5
    for i, (label, c, col) in enumerate([
            ("Underdamped", 0.15 * crit, (86, 156, 214)),
            ("Critical", crit, (120, 190, 120)),
            ("Overdamped", 3.0 * crit, (220, 130, 90))]):
        x = (i - 1) * 1.4
        anchor = _add_body(w, x, 2.0, 0.06, 1.0, locked=True,
                           color=(120, 125, 135))
        bob = _add_body(w, x, 0.0, 0.15, m, color=col, name=label)
        bob.collides = False
        w.links.append(SpringLink(anchor, bob, rest_length=1.2, stiffness=k,
                                  damping=c))
    return w


def _build_resonance() -> World:
    w = World()
    w.gravity = 0.0
    w.substeps = 6
    anchor = _add_body(w, 0, 0, 0.06, 1.0, locked=True, color=(120, 125, 135))
    bob = _add_body(w, 1.2, 0, 0.16, 1.0, color=(230, 120, 120), name="Driven mass")
    k = 25.0
    w.links.append(SpringLink(anchor, bob, rest_length=1.2, stiffness=k,
                              damping=0.4))
    f_nat = (k / bob.mass) ** 0.5 / (2 * pi)
    w.drivers.append(Driver(bob.id, amplitude=1.0, frequency=f_nat))
    return w


def _build_coupled_oscillators() -> World:
    w = World()
    w.gravity = 0.0
    w.substeps = 6
    left = _add_body(w, -2.4, 0, 0.06, 1.0, locked=True, color=(120, 125, 135))
    right = _add_body(w, 2.4, 0, 0.06, 1.0, locked=True, color=(120, 125, 135))
    masses = []
    for i in range(3):
        b = _add_body(w, -1.2 + i * 1.2, 0, 0.14, 1.0,
                      color=(86, 156, 214), name=f"m{i + 1}")
        b.collides = False
        masses.append(b)
    nodes = [left] + masses + [right]
    for a, b in zip(nodes, nodes[1:]):
        w.links.append(SpringLink(a, b, stiffness=30.0))
    masses[0].pos.x -= 0.5  # excite a mode mixture
    return w


def _build_spring_pendulum() -> World:
    w = World()
    w.substeps = 8
    anchor = _add_body(w, 0, 1.5, 0.06, 1.0, locked=True, color=(120, 125, 135))
    bob = _add_body(w, 0.9, 0.6, 0.15, 1.0, color=(200, 110, 180), name="Bob")
    w.links.append(SpringLink(anchor, bob, rest_length=1.0, stiffness=30.0))
    return w


# ------------------------------------------------------------ collisions/gas
def _build_billiards() -> World:
    w = World()
    w.gravity = 0.0
    w.substeps = 4
    _add_box(w, 3.4, 1.8, e=0.9, mu=0.1)
    w.global_damping = 0.25  # cloth friction
    r = 0.11
    rng = Random(4)
    rows = 5
    for row in range(rows):
        for i in range(row + 1):
            x = 1.2 + row * (r * 1.74)
            y = (i - row / 2) * (r * 2.02)
            _add_body(w, x, y, r, 0.17, e=0.95, mu=0.05,
                      color=(200 - row * 18, 90 + rng.randint(0, 60), 90))
    cue = _add_body(w, -2.2, 0, r, 0.17, e=0.95, mu=0.05, vx=7.0,
                    color=(235, 235, 225), name="Cue ball")
    return w


def _build_restitution_ladder() -> World:
    w = World()
    w.substeps = 6
    floor = Wall(Vec2(-3.2, 0), Vec2(3.2, 0), 0.12)
    floor.restitution = 1.0
    floor.friction = 0.2
    w.walls.append(floor)
    for i in range(6):
        e = round(0.5 + i * 0.1, 1)
        _add_body(w, -2.5 + i, 2.0, 0.15, 1.0, e=e,
                  color=(90 + i * 25, 120, 220 - i * 25), name=f"e = {e}")
    return w


def _gas_world(count: int, half: float, seed: int) -> World:
    """Random elastic gas in a box (the original app's 'Premade' worlds)."""
    w = World()
    w.gravity = 0.0
    w.substeps = 2
    w.integrator = "Symplectic Euler"
    _add_box(w, half, half, e=1.0, mu=0.0)
    rng = Random(seed)
    for _ in range(count):
        m = round(rng.uniform(0.5, 2.0), 3)
        r = m / 10.0
        b = _add_body(w, rng.uniform(-half + r * 2, half - r * 2),
                      rng.uniform(-half + r * 2, half - r * 2), r, m,
                      vx=rng.uniform(-1, 1), vy=rng.uniform(-1, 1),
                      e=1.0, mu=0.0)
        b.name = f"Particle {b.id}"
    return w


def _build_brownian() -> World:
    w = World()
    w.gravity = 0.0
    w.substeps = 3
    _add_box(w, 2.6, 2.6, e=1.0, mu=0.0)
    big = _add_body(w, 0, 0, 0.42, 12.0, e=1.0, mu=0.0,
                    color=(230, 200, 90), name="Pollen grain")
    rng = Random(11)
    for _ in range(140):
        while True:
            x, y = rng.uniform(-2.4, 2.4), rng.uniform(-2.4, 2.4)
            if (x * x + y * y) ** 0.5 > big.radius + 0.1:
                break
        _add_body(w, x, y, 0.045, 0.05, vx=rng.uniform(-3, 3),
                  vy=rng.uniform(-3, 3), e=1.0, mu=0.0, color=(120, 160, 200))
    return w


# ------------------------------------------------------ projectiles/friction
def _build_drag_race() -> World:
    w = World()
    w.substeps = 6
    w.integrator = "RK4"
    floor = Wall(Vec2(-1, 0), Vec2(24, 0), 0.12)
    floor.restitution = 0.3
    floor.friction = 0.6
    w.walls.append(floor)
    _add_body(w, 0, 0.4, 0.12, 1.0, vx=9.0, vy=9.0,
              color=(86, 156, 214), name="Vacuum")
    b = _add_body(w, -0.4, 0.4, 0.12, 1.0, vx=9.0, vy=9.0,
                  color=(220, 130, 90), name="With air drag")
    # The field selects its target by mass (m > 1), so only this body feels drag.
    b.mass = 1.001
    drag = ForceField("Air drag (m>1 only)",
                      "(-0.35 * vx * hypot(vx, vy)) * (m > 1)",
                      "(-0.35 * vy * hypot(vx, vy)) * (m > 1)")
    w.fields.append(drag)
    return w


def _build_friction_ramp() -> World:
    w = World()
    w.substeps = 8
    ang = radians(-25)
    length = 8.0
    ramp = Wall(Vec2(0, 0), Vec2(length * cos(ang), length * sin(ang)), 0.12)
    ramp.friction = 1.0
    ramp.restitution = 0.05
    w.walls.append(ramp)
    run_out = Wall(Vec2(length * cos(ang), length * sin(ang)),
                   Vec2(length * cos(ang) + 8, length * sin(ang)), 0.12)
    run_out.friction = 1.0
    run_out.restitution = 0.05
    w.walls.append(run_out)
    for i, (mu, col, label) in enumerate([
            (0.0, (110, 200, 210), "Frictionless (slides)"),
            (0.25, (120, 190, 120), "mu = 0.25 (rolls)"),
            (0.8, (220, 130, 90), "mu = 0.8 (rolls)")]):
        n = Vec2(-sin(ang), cos(ang))
        along = 0.5 + i * 0.8
        pos = Vec2(along * cos(ang), along * sin(ang)) + n * (0.06 + 0.16)
        b = _add_body(w, pos.x, pos.y, 0.16, 1.0, e=0.05, mu=mu, color=col,
                      name=label)
        b.collides = True
    return w


def _build_galileo() -> World:
    w = World()
    w.substeps = 4
    floor = Wall(Vec2(-2.5, 0), Vec2(2.5, 0), 0.12)
    floor.restitution = 0.15
    w.walls.append(floor)
    _add_body(w, -0.8, 3.4, 0.28, 10.0, e=0.15, color=(150, 160, 175),
              name="10 kg")
    _add_body(w, 0.8, 3.4, 0.1, 0.5, e=0.15, color=(220, 130, 90),
              name="0.5 kg")
    return w


def _build_wrecking_ball() -> World:
    w = World()
    w.substeps = 10
    floor = Wall(Vec2(-4, 0), Vec2(4, 0), 0.12)
    floor.friction = 0.7
    floor.restitution = 0.05
    w.walls.append(floor)
    pivot = _add_body(w, -0.5, 3.4, 0.06, 1.0, locked=True,
                      color=(120, 125, 135))
    ball = _add_body(w, -2.8, 2.2, 0.35, 22.0, e=0.2, mu=0.4,
                     color=(90, 95, 105), name="Wrecking ball")
    w.links.append(DistanceLink(pivot, ball))
    rng = Random(3)
    r = 0.16
    tower_x = 1.25
    for col_i in range(3):
        for row in range(6):
            _add_body(w, tower_x + col_i * (2 * r + 0.01), r + row * (2 * r + 0.005),
                      r, 0.4, e=0.1, mu=0.6,
                      color=(200 - rng.randint(0, 40), 150, 100))
    return w


def _build_chain_bridge() -> World:
    w = World()
    w.substeps = 12
    w.iterations = 16
    left = _add_body(w, -2.4, 1.0, 0.07, 1.0, locked=True, color=(120, 125, 135))
    right = _add_body(w, 2.4, 1.0, 0.07, 1.0, locked=True, color=(120, 125, 135))
    n = 11
    prev = left
    for i in range(1, n):
        x = -2.4 + 4.8 * i / n
        b = _add_body(w, x, 1.0, 0.07, 0.3, e=0.2, mu=0.6,
                      color=(170, 140, 230))
        w.links.append(DistanceLink(prev, b))
        prev = b
    w.links.append(DistanceLink(prev, right))
    _add_body(w, 0, 3.0, 0.3, 6.0, e=0.2, mu=0.5, color=(220, 130, 90),
              name="Load")
    return w


# -------------------------------------------------------------------- chaos
def _build_butterfly() -> World:
    w = World()
    w.substeps = 12
    for i, col in enumerate([(230, 120, 120), (120, 190, 120), (120, 160, 230)]):
        _pendulum_chain(w, 0, 1.2, 2, 0.9, angle_deg=115 + i * 0.01, color=col)
    return w


def _build_orbit_dance() -> World:
    w = _space_world(substeps=8)
    w.softening = 0.02
    rng = Random(7)
    star = _add_body(w, 0, 0, 0.4, 1200.0, color=(235, 200, 90), name="Star")
    star.locked = True
    for i in range(14):
        d = rng.uniform(1.5, 6.5)
        th = rng.uniform(0, 2 * pi)
        v = (w.G * star.mass / d) ** 0.5 * rng.uniform(0.85, 1.1)
        b = _add_body(w, d * cos(th), d * sin(th), 0.06, 0.02,
                      vx=-v * sin(th), vy=v * cos(th),
                      color=(120 + rng.randint(0, 100), 140 + rng.randint(0, 80),
                             160 + rng.randint(0, 80)))
        b.collides = False
    return w


# ----------------------------------------------------------------- registry
PRESETS: list[Preset] = [
    Preset("Earth & Moon", "Gravity & Orbits",
           "A light moon in a circular orbit around a heavy planet. Momentum "
           "is balanced so the pair orbits its common centre of mass.",
           _build_earth_moon, {"zoom": 60, "trails": True, "graph": "energy"}),
    Preset("Kepler ellipse", "Gravity & Orbits",
           "Launching a planet below circular speed gives an ellipse. Watch "
           "it speed up near the star: equal areas in equal times.",
           _build_kepler, {"zoom": 90, "trails": True, "vectors": True}),
    Preset("Inner planets", "Gravity & Orbits",
           "Four planets on circular orbits, spaced like the inner solar "
           "system. Orbital period grows with radius (Kepler's third law).",
           _build_inner_planets, {"zoom": 55, "trails": True}),
    Preset("Binary stars", "Gravity & Orbits",
           "Two equal stars orbit their barycentre while a distant planet "
           "circles the pair - a circumbinary orbit like Kepler-16b.",
           _build_binary, {"zoom": 48, "trails": True}),
    Preset("Three-body figure-8", "Gravity & Orbits",
           "The celebrated Chenciner-Montgomery choreography: three equal "
           "masses chase each other around a figure-eight. Chaotic yet "
           "perfectly periodic - a razor-thin solution of the 3-body problem.",
           _build_figure8, {"zoom": 220, "trails": True, "graph": "energy"}),
    Preset("Gravity slingshot", "Gravity & Orbits",
           "A tiny probe steals momentum from a moving planet in a flyby, "
           "leaving faster than it arrived - how Voyager toured the planets.",
           _build_slingshot, {"zoom": 40, "trails": True, "vectors": True}),

    Preset("Simple pendulum", "Pendulums",
           "A small-angle pendulum. Its period is 2*pi*sqrt(L/g), roughly 2.46 s "
           "for this 1.5 m rod - time it with the clock in the toolbar!",
           _build_simple_pendulum, {"zoom": 130, "graph": "energy"}),
    Preset("Double pendulum", "Pendulums",
           "Two links released from high up: the classic chaotic system. "
           "Energy stays constant while the motion never repeats.",
           _build_double_pendulum, {"zoom": 130, "trails": True, "graph": "energy"}),
    Preset("Triple pendulum", "Pendulums",
           "Three rigid links - even wilder than the double pendulum. Watch "
           "the energy graph stay flat while the tip whips around.",
           _build_triple_pendulum, {"zoom": 110, "trails": True, "graph": "energy"}),
    Preset("Swinging rope", "Pendulums",
           "Twelve short links approximate a flexible rope. Constraint "
           "solving keeps every link exactly the same length.",
           _build_rope, {"zoom": 110}),
    Preset("Newton's cradle", "Pendulums",
           "Five balls on strings. Elastic collisions hand momentum down the "
           "line so one ball in means one ball out.",
           _build_newtons_cradle, {"zoom": 170, "graph": "momentum"}),
    Preset("Coupled pendulums", "Pendulums",
           "Two pendulums joined by a weak spring trade energy back and "
           "forth - the swinging slowly migrates from one to the other.",
           _build_coupled_pendulums, {"zoom": 130, "graph": "energy"}),

    Preset("Mass on a spring", "Oscillators",
           "Simple harmonic motion: period 2*pi*sqrt(m/k) = 1.26 s here. Open "
           "the phase plot to see the ellipse of x against v.",
           _build_shm, {"zoom": 130, "graph": "phase"}),
    Preset("Damping regimes", "Oscillators",
           "Identical oscillators with light, critical and heavy damping. "
           "Critical damping settles fastest without overshooting.",
           _build_damping_regimes, {"zoom": 120, "graph": "energy"}),
    Preset("Driven resonance", "Oscillators",
           "A sinusoidal driver tuned to the natural frequency pumps the "
           "amplitude up until damping balances the input - resonance.",
           _build_resonance, {"zoom": 110, "graph": "energy"}),
    Preset("Coupled oscillators", "Oscillators",
           "Three masses and four springs between two anchors. The motion is "
           "a mixture of the system's normal modes.",
           _build_coupled_oscillators, {"zoom": 110, "graph": "phase"}),
    Preset("Spring pendulum", "Oscillators",
           "A bob on a spring that can also swing: energy sloshes between "
           "stretching and swinging, and the path becomes chaotic.",
           _build_spring_pendulum, {"zoom": 140, "trails": True}),

    Preset("Billiard break", "Collisions & Gas",
           "A cue ball smashes a five-row rack. Watch momentum spread "
           "through near-elastic collisions; cloth drag slows everything.",
           _build_billiards, {"zoom": 110, "graph": "momentum"}),
    Preset("Restitution ladder", "Collisions & Gas",
           "Six balls with restitution 0.5 to 1.0 dropped together. Each "
           "keeps that fraction of its speed per bounce; e = 1 never stops.",
           _build_restitution_ladder, {"zoom": 110}),
    Preset("Gas in a box (50)", "Collisions & Gas",
           "Fifty elastic particles in zero gravity - the original "
           "simulator's premade world. Total energy and momentum are conserved.",
           lambda: _gas_world(50, 2.0, 1), {"zoom": 130, "graph": "energy"}),
    Preset("Gas in a box (200)", "Collisions & Gas",
           "Two hundred particles stress-test the collision engine. The "
           "spatial hash keeps this fast; press G to see the grid.",
           lambda: _gas_world(200, 6.0, 2), {"zoom": 45, "graph": "energy"}),
    Preset("Brownian motion", "Collisions & Gas",
           "A heavy grain jostled by a swarm of light, fast particles - the "
           "random walk Einstein used to prove atoms exist. Turn on trails.",
           _build_brownian, {"zoom": 105, "trails": True}),

    Preset("Projectile drag race", "Projectiles & Friction",
           "Two identical launches; a custom force field applies quadratic "
           "air drag to one (selected by mass). Drag shortens the range and "
           "steepens the descent.",
           _build_drag_race, {"zoom": 42, "trails": True, "vectors": True}),
    Preset("Friction ramp", "Projectiles & Friction",
           "Three balls on a 25 degree ramp. With no friction a ball slides; "
           "with friction it rolls - contact torque sets it spinning.",
           _build_friction_ramp, {"zoom": 70}),
    Preset("Galileo's drop", "Projectiles & Friction",
           "A 10 kg ball and a 0.5 kg ball dropped together land together - "
           "gravitational acceleration doesn't depend on mass.",
           _build_galileo, {"zoom": 110, "vectors": True}),
    Preset("Wrecking ball", "Projectiles & Friction",
           "A 22 kg pendulum ball demolishes a stack. Combines constraints, "
           "collisions, friction and gravity in one scene.",
           _build_wrecking_ball, {"zoom": 90}),
    Preset("Chain bridge", "Projectiles & Friction",
           "A load dropped onto a hanging chain of rigid links. The chain "
           "sags into a catenary-like curve under the weight.",
           _build_chain_bridge, {"zoom": 110}),

    Preset("Butterfly effect", "Chaos",
           "Three double pendulums released 0.01 degrees apart. They track "
           "each other briefly, then diverge completely - chaos.",
           _build_butterfly, {"zoom": 130, "trails": True}),
    Preset("Orbit dance", "Chaos",
           "Fourteen tiny moons on eccentric orbits around one star. Long-"
           "term structure emerges from simple inverse-square gravity.",
           _build_orbit_dance, {"zoom": 55, "trails": True}),
]

CATEGORIES = ["All"] + sorted({p.category for p in PRESETS},
                              key=lambda c: [p.category for p in PRESETS].index(c))
