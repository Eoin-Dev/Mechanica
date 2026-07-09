"""Built-in example library.

Every preset is a small builder that returns a fresh World plus view hints
(camera zoom/centre, overlays to enable, which graph to open). Descriptions
double as the educational blurb shown on the preset card.
"""
from __future__ import annotations

from math import cos, pi, radians, sin, sqrt, tau
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
    m, d = 500.0, 2.4
    # each star circles the barycentre (radius d/2) under the pull
    # G m^2/d^2, so the circular speed is v = sqrt(G m / (2 d))
    v = (w.G * m / (2.0 * d)) ** 0.5
    _add_body(w, -d / 2, 0, 0.35, m, vy=-v, color=(235, 170, 90), name="Star A")
    _add_body(w, d / 2, 0, 0.35, m, vy=v, color=(140, 180, 235), name="Star B")
    p = _add_body(w, 7.0, 0, 0.1, 0.5, color=(120, 200, 140), name="Planet")
    p.vel.set(0, (w.G * 2 * m / 7.0) ** 0.5)
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


def _build_newtons_cannon() -> World:
    """Newton's mountain thought experiment: the same cannonball at ever
    higher launch speeds falls short, orbits, or escapes."""
    w = _space_world(substeps=6)
    planet = _add_body(w, 0, 0, 0.8, 80.0, locked=True, e=0.1, mu=0.4,
                       color=(96, 150, 110), name="Planet")
    alt = 1.15
    v_circ = (w.G * planet.mass / alt) ** 0.5
    shots = [(0.55, "0.55 v: falls short", (220, 130, 90)),
             (0.80, "0.8 v: further, still falls", (230, 200, 90)),
             (1.00, "1.0 v: circular orbit", (120, 190, 120)),
             (1.20, "1.2 v: elliptical orbit", (110, 200, 210)),
             (1.45, "1.45 v: escapes (v > sqrt(2))", (200, 110, 180))]
    for frac, label, col in shots:
        _add_body(w, 0, alt, 0.05, 0.001, vx=frac * v_circ, e=0.1, mu=0.4,
                  color=col, name=label)
    return w


def _build_trojans() -> World:
    """Asteroids librating around Jupiter's L4/L5 Lagrange points."""
    w = _space_world(substeps=6)
    sun = _add_body(w, 0, 0, 0.5, 1000.0, locked=True, color=(235, 200, 90),
                    name="Sun")
    a = 3.5
    v = (w.G * sun.mass / a) ** 0.5
    _add_body(w, a, 0, 0.22, 8.0, vy=v, color=(210, 160, 110), name="Jupiter")
    rng = Random(5)
    for k in range(12):
        base = pi / 3 if k < 6 else -pi / 3   # L4 leads, L5 trails
        th = base + rng.uniform(-0.15, 0.15)
        rr = a * (1.0 + rng.uniform(-0.03, 0.03))
        b = _add_body(w, rr * cos(th), rr * sin(th), 0.045, 0.001,
                      vx=-v * sin(th), vy=v * cos(th),
                      color=(160 + rng.randint(0, 60),) * 3)
        b.collides = False
        b.name = f"Trojan {k + 1}"
    return w


def _build_sun_earth_moon() -> World:
    """Hierarchical three-body: the Moon orbits the Earth orbiting the Sun.

    The moon's orbit must sit well inside Earth's Hill sphere
    (r_H = a_e * (m_e / 3 M_sun)^(1/3) ~ 0.6 here; prograde orbits are
    long-term stable only inside roughly half of that), or the Sun's tide
    strips it away."""
    w = _space_world(substeps=10)
    sun = _add_body(w, 0, 0, 0.5, 2000.0, locked=True, color=(235, 200, 90),
                    name="Sun")
    a_e = 4.0
    v_e = (w.G * sun.mass / a_e) ** 0.5
    earth = _add_body(w, a_e, 0, 0.13, 20.0, vy=v_e, color=(86, 156, 214),
                      name="Earth")
    a_m = 0.22
    v_m = (w.G * earth.mass / a_m) ** 0.5
    moon = _add_body(w, a_e + a_m, 0, 0.05, 0.02, vy=v_e + v_m,
                     color=(190, 190, 200), name="Moon")
    moon.collides = False
    return w


def _build_galaxy_collision() -> World:
    """Two 'galaxies' (heavy cores dressed with rings of test stars) swing
    past each other; the pass strips stars into tidal bridges and tails.

    The impact parameter is chosen so the cores' periapsis (~1.4) is
    comparable to the disc radius: close enough for strong tides, wide
    enough that the discs aren't simply shredded head-on."""
    w = _space_world(substeps=6)
    w.softening = 0.05

    def galaxy(cx: float, cy: float, vx: float, vy: float, name: str,
               core_col, star_col) -> None:
        core = _add_body(w, cx, cy, 0.24, 120.0, vx=vx, vy=vy,
                         color=core_col, name=name)
        core.collides = False
        for radius, n in ((0.6, 5), (0.95, 8), (1.3, 11), (1.65, 14)):
            vv = (w.G * core.mass / radius) ** 0.5
            for i in range(n):
                th = tau * i / n + radius  # offset rings so spokes don't align
                b = _add_body(w, cx + radius * cos(th), cy + radius * sin(th),
                              0.035, 0.001,
                              vx=vx - vv * sin(th), vy=vy + vv * cos(th),
                              color=star_col)
                b.collides = False

    galaxy(-7.0, -3.8, 2.0, 0.0, "Core A", (235, 170, 90), (225, 195, 150))
    galaxy(7.0, 3.8, -2.0, 0.0, "Core B", (140, 180, 235), (170, 195, 235))
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
    w.iterations = 8
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
    # bottoms aligned (y = drop + r + floor half-thickness), so both fall
    # exactly the same distance and touch down together
    drop = 3.2
    _add_body(w, -0.8, drop + 0.28 + 0.06, 0.28, 10.0, e=0.15,
              color=(150, 160, 175), name="10 kg")
    _add_body(w, 0.8, drop + 0.1 + 0.06, 0.1, 0.5, e=0.15,
              color=(220, 130, 90), name="0.5 kg")
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
    ball = _add_body(w, -2.95, 2.15, 0.35, 22.0, e=0.2, mu=0.4,
                     color=(90, 95, 105), name="Wrecking ball")
    w.links.append(DistanceLink(pivot, ball))
    rng = Random(3)
    r = 0.16
    tower_x = 0.90
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
    # elastic strings: taut segments stretch slightly under the load,
    # slack ones carry nothing - exactly how a real cable bridge hangs
    for i in range(1, n):
        x = -2.4 + 4.8 * i / n
        b = _add_body(w, x, 1.0, 0.07, 0.3, e=0.2, mu=0.6,
                      color=(170, 140, 230))
        w.links.append(SpringLink(prev, b, stiffness=4000.0, damping=6.0,
                                  tension_only=True))
        prev = b
    w.links.append(SpringLink(prev, right, stiffness=4000.0, damping=6.0,
                              tension_only=True))
    _add_body(w, 0, 3.0, 0.3, 6.0, e=0.2, mu=0.5, color=(220, 130, 90),
              name="Load")
    return w


def _build_projectile_angles() -> World:
    w = World()
    w.substeps = 4
    floor = Wall(Vec2(-1, 0), Vec2(14, 0), 0.12)
    floor.restitution = 0.05
    floor.friction = 0.8
    w.walls.append(floor)
    v0 = 10.0
    for ang_deg, col in [(30, (110, 200, 210)), (45, (120, 190, 120)),
                         (60, (220, 130, 90)), (75, (200, 110, 180))]:
        a = radians(ang_deg)
        b = _add_body(w, 0, 0.2, 0.09, 1.0, vx=v0 * cos(a), vy=v0 * sin(a),
                      e=0.05, mu=0.8, color=col, name=f"{ang_deg} deg")
        b.collides = True
    return w


def _build_elastic_vs_inelastic() -> World:
    w = World()
    w.gravity = 0.0
    w.substeps = 4
    for lane, (e, label_a, label_b, col) in enumerate([
            (1.0, "Elastic 2 m/s", "Elastic at rest", (86, 156, 214)),
            (0.0, "Inelastic 2 m/s", "Inelastic at rest", (220, 130, 90))]):
        y = 0.8 - lane * 1.6
        a = _add_body(w, -2.2, y, 0.15, 1.0, vx=2.0, e=e, mu=0.0, color=col,
                      name=label_a)
        b = _add_body(w, 0.6, y, 0.15, 1.0, e=e, mu=0.0,
                      color=tuple(min(255, c + 40) for c in col), name=label_b)
        a.collides = b.collides = True
    return w


def _build_terminal_velocity() -> World:
    w = World()
    w.substeps = 6
    w.integrator = "RK4"
    w.drag_quadratic = 0.4
    _add_body(w, -1.0, 8.0, 0.12, 0.3, e=0.2, color=(110, 200, 210),
              name="Light (0.3 kg)")
    _add_body(w, 1.0, 8.0, 0.12, 3.0, e=0.2, color=(220, 130, 90),
              name="Heavy (3 kg)")
    floor = Wall(Vec2(-3, 0), Vec2(3, 0), 0.12)
    floor.restitution = 0.2
    w.walls.append(floor)
    return w


# --------------------------------------------------------------- soft bodies
# Soft bodies are lattices of evenly spaced particles joined by damped
# springs: a structural mesh carries the shape, shear/diagonal springs stop
# it collapsing. Directly linked particles never collide with each other
# (the engine excludes linked pairs; their springs govern the separation),
# but everything else does - so a lattice can squash yet never tangle
# through itself.

def _soft_spring(w: World, a: Body, b: Body, k: float, damp: float) -> None:
    w.links.append(SpringLink(a, b, a.pos.dist_to(b.pos), k, damp))


def _soft_grid(w: World, x0: float, y0: float, cols: int, rows: int,
               spacing: float, mass_total: float, k: float, damp: float,
               color, e: float = 0.2, mu: float = 0.5,
               particle_r: float | None = None) -> list[list[Body]]:
    """Rectangular particle lattice with structural + crossed shear springs."""
    m = mass_total / (cols * rows)
    r = particle_r if particle_r is not None else spacing * 0.35
    grid: list[list[Body]] = []
    for j in range(rows):
        row = []
        for i in range(cols):
            b = _add_body(w, x0 + i * spacing, y0 + j * spacing, r, m,
                          e=e, mu=mu, color=color)
            row.append(b)
        grid.append(row)
    for j in range(rows):
        for i in range(cols):
            if i + 1 < cols:
                _soft_spring(w, grid[j][i], grid[j][i + 1], k, damp)
            if j + 1 < rows:
                _soft_spring(w, grid[j][i], grid[j + 1][i], k, damp)
            if i + 1 < cols and j + 1 < rows:
                _soft_spring(w, grid[j][i], grid[j + 1][i + 1], k, damp)
                _soft_spring(w, grid[j][i + 1], grid[j + 1][i], k, damp)
    return grid


def _soft_blob(w: World, cx: float, cy: float, radius: float, spacing: float,
               mass_total: float, k: float, damp: float, color,
               e: float = 0.3, mu: float = 0.5) -> list[Body]:
    """Disc of hex-packed particles, each sprung to its ~6 nearest
    neighbours: a fully triangulated (and therefore shear-stiff) blob."""
    pts: list[tuple[float, float]] = []
    row_h = spacing * sqrt(3) / 2
    j = 0
    y = -radius
    while y <= radius + 1e-9:
        x = -radius + (spacing / 2 if j % 2 else 0.0)
        while x <= radius + 1e-9:
            if x * x + y * y <= radius * radius + 1e-9:
                pts.append((x, y))
            x += spacing
        y += row_h
        j += 1
    m = mass_total / len(pts)
    bodies = []
    for (x, y) in pts:
        b = _add_body(w, cx + x, cy + y, spacing * 0.38, m, e=e, mu=mu,
                      color=color)
        bodies.append(b)
    cutoff = spacing * 1.25
    for i in range(len(bodies)):
        for j2 in range(i + 1, len(bodies)):
            if bodies[i].pos.dist_to(bodies[j2].pos) <= cutoff:
                _soft_spring(w, bodies[i], bodies[j2], k, damp)
    return bodies


def _build_jelly_block() -> World:
    w = World()
    w.substeps = 8
    floor = Wall(Vec2(-4.5, 0), Vec2(4.5, 0), 0.14)
    floor.friction = 0.6
    floor.restitution = 0.1
    w.walls.append(floor)
    for x in (-4.5, 4.5):
        side = Wall(Vec2(x, 0), Vec2(x, 4.0), 0.14)
        side.restitution = 0.4
        w.walls.append(side)
    _soft_grid(w, -0.9, 1.6, 9, 7, 0.225, mass_total=4.0, k=1000.0, damp=3.0,
               color=(120, 200, 140))
    return w


def _build_squishy_ball() -> World:
    w = World()
    w.substeps = 8
    # a V-shaped ramp: the ball splats at the bottom, oozes and settles
    left = Wall(Vec2(-4.0, 3.0), Vec2(0.0, 0.0), 0.14)
    right = Wall(Vec2(0.0, 0.0), Vec2(4.0, 3.0), 0.14)
    for wall in (left, right):
        wall.friction = 0.35
        wall.restitution = 0.15
        w.walls.append(wall)
    _soft_blob(w, -2.2, 4.4, 0.75, 0.26, mass_total=3.0, k=900.0, damp=3.5,
               color=(230, 140, 160))
    return w


def _build_cloth_curtain() -> World:
    w = World()
    w.substeps = 8
    floor = Wall(Vec2(-5.0, -1.8), Vec2(5.0, -1.8), 0.14)
    floor.friction = 0.6
    floor.restitution = 0.2
    w.walls.append(floor)
    for x in (-5.0, 5.0):
        side = Wall(Vec2(x, -1.8), Vec2(x, 2.2), 0.14)
        side.restitution = 0.4
        w.walls.append(side)
    cols, rows, spacing = 13, 8, 0.2
    grid = _soft_grid(w, -1.2, -0.4, cols, rows, spacing, mass_total=1.5,
                      k=200.0, damp=1.0, color=(150, 170, 230),
                      e=0.05, mu=0.3, particle_r=0.04)
    for b in grid[rows - 1]:    # pin the whole top edge
        b.locked = True
        b.color = (120, 125, 135)
    # a gusting breeze that only stirs the light fabric (selected by mass),
    # then a ball lobbed into the middle of the curtain
    w.fields.append(ForceField("Breeze (light bodies)",
                               "0.6*sin(1.1*t + 0.8*y)*(m < 0.1)", "0"))
    ball = _add_body(w, -3.8, 0.2, 0.28, 1.2, vx=3.6, vy=3.2, e=0.3, mu=0.3,
                     color=(235, 200, 90), name="Cannonball")
    ball.collides = True
    return w


def _build_trampoline() -> World:
    w = World()
    w.substeps = 10
    n, spacing = 21, 0.18
    x0 = -(n - 1) * spacing / 2
    left = _add_body(w, x0 - spacing, 0.0, 0.07, 1.0, locked=True,
                     color=(120, 125, 135))
    right = _add_body(w, -x0 + spacing, 0.0, 0.07, 1.0, locked=True,
                      color=(120, 125, 135))
    prev = left
    sheet = []
    for i in range(n):
        b = _add_body(w, x0 + i * spacing, 0.0, 0.055, 0.1, e=0.2, mu=0.5,
                      color=(110, 200, 210))
        sheet.append(b)
        _soft_spring(w, prev, b, 2500.0, 4.0)
        prev = b
    _soft_spring(w, prev, right, 2500.0, 4.0)
    for a, b in zip(sheet, sheet[2:]):   # bend springs keep the bed smooth
        _soft_spring(w, a, b, 500.0, 1.5)
    # side bumpers keep the bouncer over the bed
    for x in (-3.2, 3.2):
        side = Wall(Vec2(x, -0.6), Vec2(x, 3.2), 0.12)
        side.restitution = 0.5
        w.walls.append(side)
    _add_body(w, 0.0, 2.6, 0.3, 2.0, e=0.2, mu=0.4, color=(220, 130, 90),
              name="Gymnast")
    return w


def _build_soft_wheel() -> World:
    w = World()
    w.substeps = 10
    ang = radians(-14)
    length = 11.0
    ramp = Wall(Vec2(0, 0), Vec2(length * cos(ang), length * sin(ang)), 0.14)
    ramp.friction = 1.0
    ramp.restitution = 0.05
    w.walls.append(ramp)
    run_out = Wall(Vec2(length * cos(ang), length * sin(ang)),
                   Vec2(length * cos(ang) + 6, length * sin(ang)), 0.14)
    run_out.friction = 0.9
    run_out.restitution = 0.05
    w.walls.append(run_out)
    bumper = Wall(Vec2(length * cos(ang) + 6, length * sin(ang)),
                  Vec2(length * cos(ang) + 6, length * sin(ang) + 2.5), 0.14)
    bumper.restitution = 0.4
    w.walls.append(bumper)

    n, radius = 22, 0.6
    nrm = Vec2(-sin(ang), cos(ang))
    centre = Vec2(0.9 * cos(ang), 0.9 * sin(ang)) + nrm * (radius + 0.13)
    hub = _add_body(w, centre.x, centre.y, 0.13, 0.8, color=(200, 150, 90),
                    name="Hub")
    ring = []
    for i in range(n):
        th = tau * i / n
        b = _add_body(w, centre.x + radius * cos(th),
                      centre.y + radius * sin(th), 0.075, 0.09,
                      e=0.15, mu=1.0, color=(235, 170, 90))
        ring.append(b)
    for i in range(n):
        _soft_spring(w, ring[i], ring[(i + 1) % n], 2200.0, 3.0)   # tread
        _soft_spring(w, ring[i], ring[(i + 2) % n], 900.0, 1.5)    # bend
        _soft_spring(w, ring[i], hub, 450.0, 2.0)                  # spokes
    # start it rolling: v = omega x r about the contact point
    omega = -3.0
    for b in ring + [hub]:
        rx = b.pos.x - centre.x
        ry = b.pos.y - centre.y
        b.vel.set(-omega * ry + 1.0 * cos(ang), omega * rx + 1.0 * sin(ang))
    return w


def _build_jelly_smash() -> World:
    w = World()
    w.substeps = 8
    # floor sits below the swing arc's lowest point (y = 0.344 minus the
    # ball radius), so the ball reaches the jelly before touching ground
    floor = Wall(Vec2(-5.0, -0.5), Vec2(5.0, -0.5), 0.14)
    floor.friction = 0.7
    floor.restitution = 0.1
    w.walls.append(floor)
    _soft_grid(w, -1.6, -0.34, 8, 6, 0.24, mass_total=3.5, k=1100.0, damp=3.2,
               color=(170, 140, 230))
    pivot = _add_body(w, -3.2, 3.6, 0.06, 1.0, locked=True,
                      color=(120, 125, 135))
    ball = _add_body(w, -5.6, 1.4, 0.4, 18.0, e=0.2, mu=0.4,
                     color=(90, 95, 105), name="Wrecking ball")
    w.links.append(DistanceLink(pivot, ball))
    return w
def _build_butterfly() -> World:
    w = World()
    w.substeps = 12
    for i, col in enumerate([(230, 120, 120), (120, 190, 120), (120, 160, 230)]):
        _pendulum_chain(w, 0, 1.2, 2, 0.9, angle_deg=115 + i * 0.01, color=col)
    return w


def _build_sinai_billiard() -> World:
    """Sinai billiard: a box with a circular scatterer. The curved wall
    stretches nearby trajectories apart exponentially - textbook chaos."""
    w = World()
    w.gravity = 0.0
    w.substeps = 4
    _add_box(w, 2.4, 2.4, e=1.0, mu=0.0)
    _add_body(w, 0, 0, 0.75, 1.0, locked=True, e=1.0, mu=0.0,
              color=(120, 125, 135), name="Scatterer")
    for i, col in enumerate([(230, 120, 120), (110, 200, 210)]):
        _add_body(w, -1.7, -0.40 + i * 0.13, 0.055, 1.0,
                  vx=3.2, vy=1.1 + i * 0.01, e=1.0, mu=0.0, color=col,
                  name=f"Ball {i + 1}")
    return w


def _build_magnetic_pendulum() -> World:
    """A pendulum swinging over three attractors with light air drag.

    It wanders chaotically before settling over one 'magnet'; which one it
    picks depends so sensitively on the release point that the basins of
    attraction form a fractal."""
    w = World()
    w.substeps = 10
    w.mutual_gravity = True     # the magnets attract via N-body gravity
    w.G = 0.02
    w.softening = 0.08
    w.drag_linear = 0.3
    pivot = _add_body(w, 0, 2.2, 0.06, 1.0, locked=True,
                      color=(120, 125, 135), name="Pivot")
    ang = radians(75)
    bob = _add_body(w, 1.9 * sin(ang), 2.2 - 1.9 * cos(ang), 0.11, 1.0,
                    color=(235, 235, 225), name="Bob")
    bob.collides = False
    w.links.append(DistanceLink(pivot, bob))
    magnets = [((0.0, 0.18), (230, 120, 120)),
               ((-1.05, 0.50), (120, 190, 120)),
               ((1.05, 0.50), (120, 160, 230))]
    for i, ((mx, my), col) in enumerate(magnets):
        mag = _add_body(w, mx, my, 0.09, 25.0, locked=True, color=col,
                        name=f"Magnet {i + 1}")
        mag.collides = False
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
           _build_binary, {"zoom": 42, "trails": True}),
    Preset("Three-body figure-8", "Gravity & Orbits",
           "The celebrated Chenciner-Montgomery choreography: three equal "
           "masses chase each other around a figure-eight forever. A "
           "razor-thin periodic solution - almost any other three-body "
           "start turns chaotic.",
           _build_figure8, {"zoom": 220, "trails": True, "graph": "energy"}),
    Preset("Gravity slingshot", "Gravity & Orbits",
           "A tiny probe steals momentum from a moving planet in a flyby, "
           "leaving faster than it arrived - how Voyager toured the planets.",
           _build_slingshot, {"zoom": 40, "trails": True, "vectors": True}),
    Preset("Newton's cannon", "Gravity & Orbits",
           "Newton's thought experiment: fire a cannonball sideways from a "
           "mountain. Too slow and it falls; at circular speed it orbits; "
           "past sqrt(2) times that, it escapes forever.",
           _build_newtons_cannon, {"zoom": 105, "trails": True}),
    Preset("Trojan asteroids", "Gravity & Orbits",
           "Asteroids sharing Jupiter's orbit, 60 degrees ahead (L4) and "
           "behind (L5). These Lagrange points are gravitationally stable, "
           "so the swarms slowly librate around them instead of drifting off.",
           _build_trojans, {"zoom": 55, "trails": True}),
    Preset("Sun, Earth & Moon", "Gravity & Orbits",
           "A hierarchical three-body system: the Moon circles the Earth "
           "while both circle the Sun. Stable because the Moon sits deep "
           "inside Earth's Hill sphere, where Earth's pull dominates.",
           _build_sun_earth_moon, {"zoom": 62, "trails": True}),
    Preset("Colliding galaxies", "Gravity & Orbits",
           "Two galaxy cores dressed with rings of test stars fall together. "
           "The close pass strips stars into tidal bridges and tails, like "
           "the Antennae galaxies. About 80 bodies of pure N-body gravity.",
           _build_galaxy_collision, {"zoom": 40, "trails": True}),

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
           "bounce returns to e² of the previous height, so the e = 1 ball "
           "keeps (almost) all of it.",
           _build_restitution_ladder, {"zoom": 110}),
    Preset("Elastic vs inelastic", "Collisions & Gas",
           "Equal masses, head-on. Elastic (top): the mover stops dead and "
           "hands its velocity over. Perfectly inelastic (bottom): they "
           "stick and share it. Momentum is conserved in both - kinetic "
           "energy only in the first.",
           _build_elastic_vs_inelastic, {"zoom": 130, "graph": "momentum"}),
    Preset("Gas in a box (50)", "Collisions & Gas",
           "Fifty particles bouncing elastically in zero gravity - a toy "
           "ideal gas. Total energy and momentum are conserved.",
           lambda: _gas_world(50, 2.0, 1), {"zoom": 130, "graph": "energy"}),
    Preset("Gas in a box (200)", "Collisions & Gas",
           "Two hundred particles stress-test the collision engine. The "
           "spatial hash keeps this fast; press G to see the grid.",
           lambda: _gas_world(200, 6.0, 2), {"zoom": 45, "graph": "energy"}),
    Preset("Brownian motion", "Collisions & Gas",
           "A heavy grain jostled by a swarm of light, fast particles - the "
           "random walk Einstein explained in 1905, cementing the case that "
           "atoms exist. Turn on trails.",
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
           "A 10 kg ball and a 0.5 kg ball fall the same distance and land "
           "together - without air, gravitational acceleration doesn't "
           "depend on mass.",
           _build_galileo, {"zoom": 110, "vectors": True}),
    Preset("Projectile angles", "Projectiles & Friction",
           "Four launches at 10 m/s. 45 degrees flies farthest, and the "
           "30/60 pair lands on the same spot: range goes as sin(2*theta), "
           "so complementary angles match.",
           _build_projectile_angles, {"zoom": 55, "trails": True,
                                      "centre": (5.0, 2.2)}),
    Preset("Terminal velocity", "Projectiles & Friction",
           "Two same-size balls falling with quadratic air drag. Drag "
           "balances weight at v = sqrt(mg/c), so the 10x heavier ball "
           "falls about 3x faster - Galileo needs a vacuum.",
           _build_terminal_velocity, {"zoom": 60, "trails": True,
                                      "centre": (0, 4.0), "vectors": True}),
    Preset("Wrecking ball", "Projectiles & Friction",
           "A 22 kg pendulum ball demolishes a stack. Combines constraints, "
           "collisions, friction and gravity in one scene.",
           _build_wrecking_ball, {"zoom": 90}),
    Preset("Chain bridge", "Projectiles & Friction",
           "A load dropped onto a bridge of elastic string segments. Taut "
           "strings stretch slightly and pull; slack ones carry nothing - "
           "so the bridge sags into a catenary-like curve under the weight.",
           _build_chain_bridge, {"zoom": 110}),

    Preset("Jelly block", "Soft Bodies",
           "A 9 x 7 lattice of particles joined by structural and shear "
           "springs - a jelly cube. Drop it, watch it splat, wobble and "
           "settle. Grab and throw it with the mouse!",
           _build_jelly_block, {"zoom": 95, "centre": (0, 1.4)}),
    Preset("Squishy ball", "Soft Bodies",
           "A hex-packed disc of particles, each sprung to its six "
           "neighbours, rolls and splats down a V-ramp. Fully triangulated, "
           "so it keeps its round shape - mostly.",
           _build_squishy_ball, {"zoom": 85, "centre": (0, 2.0)}),
    Preset("Cloth curtain", "Soft Bodies",
           "A 15 x 10 spring lattice pinned along its top edge sways in a "
           "gusting breeze - until a cannonball flies into it. Drag any "
           "particle to tug the fabric around.",
           _build_cloth_curtain, {"zoom": 110, "centre": (0, 0.4)}),
    Preset("Trampoline", "Soft Bodies",
           "A springy bed of particles strung between two anchors. The "
           "ball's energy trades between gravity and spring tension every "
           "bounce. Try changing the ball's mass!",
           _build_trampoline, {"zoom": 110, "centre": (0, 1.0), "graph": "energy"}),
    Preset("Soft wheel", "Soft Bodies",
           "A deformable tyre: a sprung tread ring with spokes to a hub. It "
           "flattens against the ramp as it rolls, just like a real tyre at "
           "low pressure.",
           _build_soft_wheel, {"zoom": 80, "centre": (5.0, -1.0), "trails": False}),
    Preset("Jelly smash", "Soft Bodies",
           "A rigid wrecking ball meets a soft jelly block: constraints, "
           "contacts and 200-odd springs all at once. The jelly absorbs the "
           "blow and jiggles it away as heat (spring damping).",
           _build_jelly_smash, {"zoom": 80, "centre": (-0.5, 1.0)}),

    Preset("Butterfly effect", "Chaos",
           "Three double pendulums released 0.01 degrees apart. They track "
           "each other briefly, then diverge completely - chaos.",
           _build_butterfly, {"zoom": 130, "trails": True}),
    Preset("Orbit dance", "Chaos",
           "Fourteen tiny moons on eccentric orbits around one star. Long-"
           "term structure emerges from simple inverse-square gravity.",
           _build_orbit_dance, {"zoom": 55, "trails": True}),
    Preset("Sinai billiard", "Chaos",
           "Two balls launched a hair apart in a box with a circular "
           "scatterer. Every bounce off the curved wall stretches their "
           "separation - exponential divergence, while energy stays exactly "
           "flat. The founding example of provable chaos.",
           _build_sinai_billiard, {"zoom": 125, "trails": True,
                                   "graph": "energy"}),
    Preset("Magnetic pendulum", "Chaos",
           "A pendulum swings over three attracting 'magnets' with light "
           "air drag. It wanders unpredictably before settling over one - "
           "and which one depends so sensitively on the release point that "
           "the basins of attraction form a fractal. Try nudging the bob.",
           _build_magnetic_pendulum, {"zoom": 110, "trails": True}),
]

CATEGORIES = ["All"] + sorted({p.category for p in PRESETS},
                              key=lambda c: [p.category for p in PRESETS].index(c))
