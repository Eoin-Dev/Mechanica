"""Physics verification suite (headless).

Run:  python -m mechanica.tests_physics
Checks the engine against analytic results: projectile motion, orbital
energy conservation, collision conservation laws, pendulum and spring
periods, constraint drift, N-body momentum, the expression sandbox and
serialization round-trips.
"""
from __future__ import annotations

import math
import sys

from mechanica.core.expr import ExprError, compile_expr
from mechanica.core.vec import Vec2
from mechanica.engine.body import Body, Wall
from mechanica.engine.links import DistanceLink, SpringLink
from mechanica.engine.world import World

DT = 1.0 / 120.0
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}   {detail}")


def body(w: World, x, y, r=0.1, m=1.0, vx=0.0, vy=0.0, locked=False) -> Body:
    b = Body(Vec2(x, y), r, m)
    b.vel.set(vx, vy)
    b.locked = locked
    w.bodies.append(b)
    return b


def run(w: World, seconds: float) -> None:
    steps = int(round(seconds / DT))
    for _ in range(steps):
        w.step(DT)


# ---------------------------------------------------------------- projectile
def test_projectile_analytic() -> None:
    for integrator in ("Velocity Verlet", "Symplectic Euler", "RK4"):
        w = World()
        w.integrator = integrator
        w.substeps = 4
        b = body(w, 0, 0, vx=3.0, vy=8.0)
        b.collides = False
        t = 2.0
        run(w, t)
        exact_x = 3.0 * t
        exact_y = 8.0 * t - 0.5 * 9.81 * t * t
        err = math.hypot(b.pos.x - exact_x, b.pos.y - exact_y)
        tol = 1e-6 if integrator != "Symplectic Euler" else 0.05
        check(f"projectile vs SUVAT ({integrator})", err < tol,
              f"err={err:.2e} m")


def test_projectile_drag() -> None:
    # RK4 with linear drag vs the exact solution v(t) = v0 e^(-ct/m), g=0
    w = World()
    w.integrator = "RK4"
    w.substeps = 2
    w.gravity = 0.0
    w.drag_linear = 0.7
    b = body(w, 0, 0, vx=5.0)
    b.collides = False
    t = 3.0
    run(w, t)
    exact_vx = 5.0 * math.exp(-0.7 * t)
    exact_x = 5.0 / 0.7 * (1 - math.exp(-0.7 * t))
    err_v = abs(b.vel.x - exact_vx)
    err_x = abs(b.pos.x - exact_x)
    check("linear drag vs exponential decay (RK4)",
          err_v < 1e-6 and err_x < 1e-6,
          f"err_v={err_v:.2e}, err_x={err_x:.2e}")


# ---------------------------------------------------------------- collisions
def test_elastic_collision() -> None:
    w = World()
    w.gravity = 0.0
    a = body(w, -1, 0, r=0.1, m=1.0, vx=2.0)
    b = body(w, 1, 0, r=0.1, m=3.0, vx=-1.0)
    a.restitution = b.restitution = 1.0
    a.friction = b.friction = 0.0
    p0 = w.momentum().x
    e0 = w.energy()["total"]
    run(w, 2.0)
    p1 = w.momentum().x
    e1 = w.energy()["total"]
    # analytic 1D elastic result
    v1 = (1 - 3) / 4 * 2.0 + 2 * 3 / 4 * -1.0   # -2.5
    v2 = 2 * 1 / 4 * 2.0 + (3 - 1) / 4 * -1.0   # 0.5
    check("elastic collision: momentum conserved", abs(p1 - p0) < 1e-9,
          f"dp={p1 - p0:.2e}")
    check("elastic collision: energy conserved", abs(e1 - e0) / abs(e0) < 5e-3,
          f"dE={100 * (e1 - e0) / e0:.3f}%")
    check("elastic collision: analytic velocities",
          abs(a.vel.x - v1) < 0.05 and abs(b.vel.x - v2) < 0.05,
          f"v1={a.vel.x:.3f} (want {v1}), v2={b.vel.x:.3f} (want {v2})")


def test_inelastic_collision() -> None:
    w = World()
    w.gravity = 0.0
    a = body(w, -1, 0, r=0.1, m=1.0, vx=2.0)
    b = body(w, 1, 0, r=0.1, m=1.0, vx=0.0)
    a.restitution = b.restitution = 0.0
    a.friction = b.friction = 0.0
    run(w, 2.0)
    # perfectly inelastic equal masses: both end at 1.0 m/s
    check("inelastic collision: common final velocity",
          abs(a.vel.x - 1.0) < 0.05 and abs(b.vel.x - 1.0) < 0.05,
          f"v1={a.vel.x:.3f}, v2={b.vel.x:.3f}")


# -------------------------------------------------------------------- orbits
def test_orbit_energy() -> None:
    w = World()
    w.gravity = 0.0
    w.mutual_gravity = True
    w.G = 1.0
    w.softening = 0.0001
    w.substeps = 8
    star = body(w, 0, 0, r=0.3, m=1000.0, locked=True)
    star.collides = False
    d = 3.0
    p = body(w, d, 0, r=0.05, m=1.0, vy=math.sqrt(1000.0 / d))
    p.collides = False
    e0 = w.energy()["total"]
    r0 = p.pos.length()
    run(w, 60.0)  # many orbital periods
    e1 = w.energy()["total"]
    r1 = p.pos.length()
    drift = abs(e1 - e0) / abs(e0)
    check("circular orbit: energy drift < 0.1% over 60 s", drift < 1e-3,
          f"drift={100 * drift:.4f}%")
    check("circular orbit: radius stays circular", abs(r1 - r0) / r0 < 0.01,
          f"r: {r0:.4f} -> {r1:.4f}")


def test_nbody_momentum() -> None:
    w = World()
    w.gravity = 0.0
    w.mutual_gravity = True
    w.G = 5.0
    w.substeps = 8
    a = body(w, -1, 0.3, m=4.0, vy=0.5)
    b = body(w, 1.5, -0.2, m=2.0, vy=-1.0)
    c = body(w, 0.2, 1.2, m=1.0, vx=0.4)
    for x in (a, b, c):
        x.collides = False
    p0 = w.momentum()
    run(w, 10.0)
    p1 = w.momentum()
    err = math.hypot(p1.x - p0.x, p1.y - p0.y)
    check("three-body: total momentum conserved", err < 1e-9,
          f"|dp|={err:.2e}")


# ----------------------------------------------------------------- pendulum
def test_pendulum_period() -> None:
    w = World()
    w.substeps = 8
    length, theta0 = 1.5, math.radians(5)
    pivot = body(w, 0, 0, r=0.05, locked=True)
    bob = body(w, length * math.sin(theta0), -length * math.cos(theta0), r=0.08)
    bob.collides = pivot.collides = False
    w.links.append(DistanceLink(pivot, bob))
    # measure the period from successive positive-going zero crossings of x
    crossings = []
    prev_x = bob.pos.x
    t = 0.0
    while t < 15.0:
        w.step(DT)
        t += DT
        if prev_x < 0 <= bob.pos.x:
            crossings.append(t)
        prev_x = bob.pos.x
    periods = [b - a for a, b in zip(crossings, crossings[1:])]
    measured = sum(periods) / len(periods)
    exact = 2 * math.pi * math.sqrt(length / 9.81) * (1 + theta0 ** 2 / 16)
    err = abs(measured - exact) / exact
    check("simple pendulum period vs 2*pi*sqrt(L/g)", err < 0.01,
          f"measured={measured:.4f}s exact={exact:.4f}s err={100 * err:.2f}%")


def test_rod_constraint_drift() -> None:
    w = World()
    w.substeps = 12
    pivot = body(w, 0, 1, r=0.05, locked=True)
    b1 = body(w, 0.9, 1, r=0.08)
    b2 = body(w, 1.8, 1, r=0.08)
    for x in (pivot, b1, b2):
        x.collides = False
    l1 = DistanceLink(pivot, b1)
    l2 = DistanceLink(b1, b2)
    w.links.extend((l1, l2))
    e0 = w.energy()["total"]
    run(w, 20.0)  # chaotic double pendulum
    err1 = abs(pivot.pos.dist_to(b1.pos) - l1.length) / l1.length
    err2 = abs(b1.pos.dist_to(b2.pos) - l2.length) / l2.length
    check("double pendulum: rod length drift < 0.1%", max(err1, err2) < 1e-3,
          f"err={max(err1, err2) * 100:.4f}%")
    e1 = w.energy()["total"]
    drift = abs(e1 - e0) / abs(e0)
    check("double pendulum: energy drift < 0.5% over 20 s", drift < 5e-3,
          f"dE={100 * (e1 - e0) / e0:+.4f}%")


def test_pendulum_energy_conservation() -> None:
    """The flagship fix: rigid-link systems must not bleed energy."""
    from mechanica.scene.presets import PRESETS

    for name, seconds, tol in [("Simple pendulum", 60.0, 1e-3),
                               ("Triple pendulum", 30.0, 5e-3),
                               ("Swinging rope", 15.0, 3e-2)]:
        w = [p for p in PRESETS if p.name == name][0].build()
        e0 = w.energy()["total"]
        run(w, seconds)
        e1 = w.energy()["total"]
        drift = abs(e1 - e0) / max(abs(e0), 1e-9)
        check(f"{name}: |dE| < {tol * 100:g}% over {seconds:.0f} s",
              drift < tol, f"dE={100 * (e1 - e0) / e0:+.4f}%")


# -------------------------------------------------------------------- spring
def test_spring_period() -> None:
    w = World()
    w.gravity = 0.0
    w.substeps = 8
    anchor = body(w, 0, 0, locked=True)
    bob = body(w, 1.5, 0, m=1.0)  # stretched 0.5 beyond rest length 1.0
    bob.collides = anchor.collides = False
    w.links.append(SpringLink(anchor, bob, rest_length=1.0, stiffness=25.0))
    crossings = []
    prev = bob.pos.x - 1.0
    t = 0.0
    while t < 10.0:
        w.step(DT)
        t += DT
        cur = bob.pos.x - 1.0
        if prev < 0 <= cur:
            crossings.append(t)
        prev = cur
    periods = [b - a for a, b in zip(crossings, crossings[1:])]
    measured = sum(periods) / len(periods)
    exact = 2 * math.pi * math.sqrt(1.0 / 25.0)
    err = abs(measured - exact) / exact
    check("spring-mass period vs 2*pi*sqrt(m/k)", err < 0.01,
          f"measured={measured:.4f}s exact={exact:.4f}s err={100 * err:.2f}%")


def test_newtons_cradle() -> None:
    from mechanica.scene.presets import PRESETS
    w = [p for p in PRESETS if p.name == "Newton's cradle"][0].build()
    run(w, 1.2)  # first ball swings down and strikes the row
    balls = [b for b in w.bodies if not b.locked]
    moving = sum(1 for b in balls if b.vel.length() > 0.3)
    check("Newton's cradle: one ball in, one ball out", moving == 1,
          f"speeds={[round(b.vel.length(), 2) for b in balls]}")


def test_stack_comes_to_rest() -> None:
    w = World()
    w.substeps = 8
    floor = Wall(Vec2(-3, 0), Vec2(3, 0), 0.12)
    floor.friction = 0.7
    floor.restitution = 0.05
    w.walls.append(floor)
    r = 0.16
    for col in range(3):
        for row in range(5):
            b = body(w, col * (2 * r + 0.01), r + row * (2 * r + 0.005), r=r, m=0.4)
            b.restitution = 0.1
            b.friction = 0.6
    run(w, 4.0)
    vmax = max(b.vel.length() for b in w.bodies)
    check("stacked tower comes to rest (no jitter)", vmax < 0.01,
          f"max residual speed={vmax:.4f} m/s")


def test_restitution_accuracy() -> None:
    """A dropped ball must rebound to e^2 of its drop height."""
    w = World()
    w.substeps = 8
    floor = Wall(Vec2(-2, 0), Vec2(2, 0), 0.1)
    floor.restitution = 1.0
    w.walls.append(floor)
    b = body(w, 0, 1.0 + 0.15 + 0.05, r=0.15)
    b.restitution = 0.9
    b.friction = 0.0
    peak, bounced = 0.0, False
    for _ in range(int(3.0 / DT)):
        w.step(DT)
        if b.vel.y > 0:
            bounced = True
        if bounced:
            peak = max(peak, b.pos.y)
    rebound = (peak - 0.15 - 0.05) / 1.0
    check("bounce rebound height ~ e^2 h", abs(rebound - 0.81) < 0.02,
          f"rebound={rebound:.3f} (ideal 0.810)")


def test_nonfinite_survival() -> None:
    """Bodies with inf/NaN state must be frozen, not crash the engine."""
    w = World()
    b1 = body(w, float("1e999"), 0)          # +inf x
    b2 = body(w, 0, 0)
    try:
        run(w, 0.5)
        ok = math.isfinite(b1.pos.x) and math.isfinite(b2.pos.y)
        check("non-finite body state is contained", ok,
              f"b1.x={b1.pos.x}, diverged={w.diverged}")
    except Exception as exc:  # noqa: BLE001
        check("non-finite body state is contained", False,
              f"{type(exc).__name__}: {exc}")


# ------------------------------------------------------------------- rolling
def test_rolling() -> None:
    w = World()
    w.substeps = 8
    ang = math.radians(-20)
    wall = Wall(Vec2(0, 0), Vec2(10 * math.cos(ang), 10 * math.sin(ang)), 0.1)
    wall.friction = 1.0
    wall.restitution = 0.0
    w.walls.append(wall)
    n = Vec2(-math.sin(ang), math.cos(ang))
    start = Vec2(0.5 * math.cos(ang), 0.5 * math.sin(ang)) + n * (0.05 + 0.15)
    b = body(w, start.x, start.y, r=0.15, m=1.0)
    b.friction = 0.8
    b.restitution = 0.0
    run(w, 1.5)
    speed = b.vel.length()
    ratio = abs(b.omega) * b.radius / max(speed, 1e-9)
    check("ball rolls down a rough ramp (|omega| r ~ |v|)",
          speed > 0.5 and 0.7 < ratio < 1.3,
          f"v={speed:.3f} m/s, omega*r/v={ratio:.3f}")


# ---------------------------------------------------------------- soft bodies
def test_soft_body_presets() -> None:
    """Every soft-body preset must run without blowing up or escaping."""
    from mechanica.scene.presets import PRESETS
    for name in ("Jelly block", "Squishy ball", "Cloth curtain",
                 "Trampoline", "Soft wheel", "Jelly smash"):
        w = [p for p in PRESETS if p.name == name][0].build()
        run(w, 3.0)
        spans = [abs(b.pos.x) + abs(b.pos.y) for b in w.bodies]
        ok = (all(math.isfinite(s) for s in spans) and max(spans) < 50.0
              and not w.diverged)
        check(f"soft body '{name}' stays coherent over 3 s", ok,
              f"max |x|+|y|={max(spans):.1f} m")


def test_soft_body_momentum() -> None:
    """Vectorized spring forces are internal: they must conserve momentum."""
    w = World()
    w.gravity = 0.0
    w.substeps = 8
    bodies = []
    for j in range(5):
        for i in range(6):
            b = body(w, i * 0.3, j * 0.3, r=0.1, m=0.2, vx=1.0, vy=0.5)
            bodies.append(b)
    for j in range(5):
        for i in range(6):
            a = bodies[j * 6 + i]
            if i + 1 < 6:
                w.links.append(SpringLink(a, bodies[j * 6 + i + 1],
                                          stiffness=150.0, damping=0.5))
            if j + 1 < 5:
                w.links.append(SpringLink(a, bodies[(j + 1) * 6 + i],
                                          stiffness=150.0, damping=0.5))
    p0 = w.momentum()
    run(w, 5.0)
    p1 = w.momentum()
    err = math.hypot(p1.x - p0.x, p1.y - p0.y)
    check("soft lattice: momentum conserved (numpy springs)", err < 1e-9,
          f"|dp|={err:.2e}")


def test_drag_speed_limit() -> None:
    """Swinging a grabbed particle wildly must not scramble its lattice."""
    from mechanica.engine.world import safe_drag_speed
    from mechanica.scene.presets import PRESETS
    w = [p for p in PRESETS if p.name == "Jelly block"][0].build()
    parts = [b for b in w.bodies if not b.locked]
    grab = parts[len(parts) // 2]
    grab.held = True
    vmax = safe_drag_speed(w, grab, 60.0)
    for i in range(int(1.0 / DT)):   # two fast loops, cursor at ~23 m/s
        ang = 2.0 * math.tau * i * DT
        w.drag_pins[grab] = (1.8 * math.cos(ang), 1.8 + 1.8 * math.sin(ang),
                             vmax)
        w.step(DT)
    grab.held = False
    w.drag_pins.clear()
    run(w, 5.0)
    springs = [ln for ln in w.links if isinstance(ln, SpringLink)]
    worst = max(abs(ln.a.pos.dist_to(ln.b.pos) - ln.rest_length)
                / ln.rest_length for ln in springs)
    check("violent drag: jelly lattice stays pristine", worst < 0.2,
          f"worst residual strain={worst * 100:.1f}%")


def test_vectorized_matches_scalar() -> None:
    """The numpy fast path must reproduce the pure-Python physics."""
    from mechanica.engine import contacts as contacts_mod
    from mechanica.scene.presets import PRESETS
    build = [p for p in PRESETS if p.name == "Jelly block"][0].build
    saved = (World.VEC_MIN_BODIES, World.VEC_MIN_SPRINGS,
             contacts_mod.VEC_MIN_COLLIDERS)
    try:
        World.VEC_MIN_BODIES = World.VEC_MIN_SPRINGS = 10 ** 9
        contacts_mod.VEC_MIN_COLLIDERS = 10 ** 9
        w_scalar = build()
        run(w_scalar, 1.5)
    finally:
        (World.VEC_MIN_BODIES, World.VEC_MIN_SPRINGS,
         contacts_mod.VEC_MIN_COLLIDERS) = saved
    w_vec = build()
    run(w_vec, 1.5)
    err = max(math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y)
              for a, b in zip(w_scalar.bodies, w_vec.bodies))
    check("numpy path matches the Python path", err < 1e-9,
          f"max deviation={err:.2e} m")


# -------------------------------------------------------------- infrastructure
def test_expression_sandbox() -> None:
    ok = True
    detail = ""
    try:
        f = compile_expr("-0.5*vx + sin(t)*2")
        val = f({"x": 0, "y": 0, "vx": 2.0, "vy": 0, "t": 0, "m": 1, "r": 0})
        ok = abs(val - (-1.0)) < 1e-12
        detail = f"eval={val}"
    except ExprError as exc:
        ok, detail = False, str(exc)
    check("expression: valid force compiles and evaluates", ok, detail)
    for bad in ("__import__('os').system('x')", "().__class__", "x.__dict__",
                "open('f')", "[1 for _ in range(9)]", "lambda: 1",
                "9**9**9", "'a'*99999999"):
        try:
            compile_expr(bad)
            check(f"expression rejects: {bad[:30]}", False, "was accepted!")
        except ExprError:
            check(f"expression rejects: {bad[:30]}", True)


def test_serialization_roundtrip() -> None:
    from mechanica.scene.presets import PRESETS
    ok = True
    detail = ""
    for preset in PRESETS:
        w = preset.build()
        d1 = w.to_dict()
        w2 = World.from_dict(d1)
        d2 = w2.to_dict()
        if d1 != d2:
            ok = False
            detail = f"mismatch in '{preset.name}'"
            break
    check("all presets serialize round-trip losslessly", ok, detail)


def test_determinism() -> None:
    def signature() -> tuple:
        from mechanica.scene.presets import PRESETS
        w = [p for p in PRESETS if p.name == "Double pendulum"][0].build()
        run(w, 3.0)
        b = w.bodies[-1]
        return (round(b.pos.x, 12), round(b.pos.y, 12))

    check("simulation is deterministic", signature() == signature())


def main() -> int:
    print("Mechanica physics verification")
    print("=" * 60)
    test_projectile_analytic()
    test_projectile_drag()
    test_elastic_collision()
    test_inelastic_collision()
    test_orbit_energy()
    test_nbody_momentum()
    test_pendulum_period()
    test_rod_constraint_drift()
    test_pendulum_energy_conservation()
    test_newtons_cradle()
    test_stack_comes_to_rest()
    test_restitution_accuracy()
    test_nonfinite_survival()
    test_spring_period()
    test_rolling()
    test_soft_body_presets()
    test_soft_body_momentum()
    test_drag_speed_limit()
    test_vectorized_matches_scalar()
    test_expression_sandbox()
    test_serialization_roundtrip()
    test_determinism()
    print("=" * 60)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"{passed}/{len(RESULTS)} checks passed")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
