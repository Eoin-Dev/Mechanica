"""The physics world: bodies, walls, links, force generators and the stepper.

Stepping pipeline (per substep of length h):
  1. Evaluate smooth forces (gravity, N-body, drag, springs, drivers, custom
     fields), then solve rod/rope tensions at the acceleration level
     (warm-started Gauss-Seidel). Integrate with the selected integrator:
       - Symplectic Euler: 1st order, symplectic. Very robust.
       - Velocity Verlet:  2nd order, symplectic. Default -- excellent
         long-term energy behaviour for orbits and oscillators.
       - RK4: 4th order, non-symplectic. Best short-term accuracy for smooth
         systems (e.g. projectiles with drag); may slowly drift on orbits.
  2. Remove the tiny residual link drift with an XPBD position solve and
     feed the corrections back into velocities.
  3. Detect all contacts, then resolve them together with iterated
     sequential impulses (restitution + Coulomb friction) and split-impulse
     positional projection.
  4. Apply global velocity damping, advance time.

Solving the rod tension as a *force* before integrating (step 1) rather than
only projecting positions afterwards is what makes pendulums and chains
energy-conserving: pure projection would systematically discard the radial
velocity gained within each substep and drain energy.
"""
from __future__ import annotations

from math import isfinite

import numpy as np

from mechanica.core.expr import ExprError, compile_expr
from mechanica.core.vec import Vec2
from mechanica.engine.body import Body, Wall
from mechanica.engine.contacts import Contact, solve_contacts
from mechanica.engine.links import DistanceLink, SpringLink, link_from_dict

INTEGRATORS = ("Velocity Verlet", "Symplectic Euler", "RK4")

# Gauss-Seidel passes for the acceleration-level rod tension solve. Warm
# starting makes a handful of passes enough even for long chains.
ROD_FORCE_PASSES = 4

# Mouse-drag speed limit tuning: a held body may not chase the cursor faster
# than DRAG_GAMMA * rest_length * omega of its stiffest attached spring, so a
# fast drag can never stretch a spring faster than it can respond - which is
# what used to scramble soft bodies (measured: wild swinging leaves the
# lattice pristine at 0.3; above ~0.5 it starts to crease). The floor keeps
# dragging responsive even on extremely stiff/light lattices.
DRAG_GAMMA = 0.3
DRAG_SPEED_FLOOR = 2.5   # m/s


def safe_drag_speed(world: "World", body: Body, base: float) -> float:
    """Maximum speed at which `body` may be dragged through the world.

    `base` is the caller's scale-derived cap (e.g. a few screen-widths per
    second); it is tightened for bodies with springs attached so the drag
    cannot outrun the spring response of whatever it is anchored to.
    """
    v = base
    for ln in world.links:
        if not isinstance(ln, SpringLink):
            continue
        if ln.a is body:
            other = ln.b
        elif ln.b is body:
            other = ln.a
        else:
            continue
        iw = other.inv_mass
        if iw <= 0.0 or ln.stiffness <= 0.0:
            continue  # anchored to something immovable: no response to outrun
        omega = (ln.stiffness * iw) ** 0.5
        v = min(v, DRAG_GAMMA * max(ln.rest_length, 0.05) * omega)
    return max(v, DRAG_SPEED_FLOOR)


class ForceField:
    """User-defined force field F(x, y, vx, vy, t, m, r) applied to all bodies."""

    __slots__ = ("name", "fx_src", "fy_src", "enabled", "error", "_fx", "_fy")

    def __init__(self, name: str = "Field", fx_src: str = "0", fy_src: str = "0") -> None:
        self.name = name
        self.fx_src = fx_src
        self.fy_src = fy_src
        self.enabled = True
        self.error = ""
        self._fx = None
        self._fy = None
        self.compile()

    def compile(self) -> bool:
        try:
            self._fx = compile_expr(self.fx_src)
            self._fy = compile_expr(self.fy_src)
            self.error = ""
            return True
        except ExprError as exc:
            self.error = str(exc)
            self._fx = self._fy = None
            return False

    def to_dict(self) -> dict:
        return {"name": self.name, "fx": self.fx_src, "fy": self.fy_src,
                "enabled": self.enabled}

    @staticmethod
    def from_dict(d: dict) -> "ForceField":
        f = ForceField(d["name"], d["fx"], d["fy"])
        f.enabled = d.get("enabled", True)
        return f


class Driver:
    """Sinusoidal driving force on one body: F(t) = A sin(2*pi*f*t + phase)."""

    __slots__ = ("body_id", "amplitude", "frequency", "phase", "angle", "enabled")

    def __init__(self, body_id: int, amplitude: float = 5.0, frequency: float = 1.0,
                 phase: float = 0.0, angle: float = 0.0) -> None:
        self.body_id = body_id
        self.amplitude = amplitude   # N
        self.frequency = frequency   # Hz
        self.phase = phase           # rad
        self.angle = angle           # direction of the force, rad from +x
        self.enabled = True

    def to_dict(self) -> dict:
        return {"body_id": self.body_id, "amplitude": self.amplitude,
                "frequency": self.frequency, "phase": self.phase,
                "angle": self.angle, "enabled": self.enabled}

    @staticmethod
    def from_dict(d: dict) -> "Driver":
        drv = Driver(d["body_id"], d["amplitude"], d["frequency"], d["phase"], d["angle"])
        drv.enabled = d.get("enabled", True)
        return drv


class World:
    # Scenes at/above these sizes switch the smooth-force pass to vectorized
    # numpy array math (a big win for soft bodies and N-body swarms); below
    # them plain Python loops are faster than the numpy call overhead.
    VEC_MIN_BODIES = 24
    VEC_MIN_SPRINGS = 12

    def __init__(self) -> None:
        self.bodies: list[Body] = []
        self.walls: list[Wall] = []
        self.links: list[DistanceLink | SpringLink] = []
        self.fields: list[ForceField] = []
        self.drivers: list[Driver] = []

        self.gravity = 9.81          # m/s^2, downward (negative = upward)
        self.mutual_gravity = False  # pairwise Newtonian attraction
        self.G = 1.0                 # gravitational constant (scaled units)
        self.softening = 0.01        # m, avoids the r->0 singularity
        self.drag_linear = 0.0       # N*s/m         (F = -c1 v)
        self.drag_quadratic = 0.0    # N*s^2/m^2     (F = -c2 |v| v)
        self.global_damping = 0.0    # 1/s, exponential velocity decay

        self.integrator = "Velocity Verlet"
        self.substeps = 4
        self.iterations = 8          # solver iterations (links and contacts)

        self.time = 0.0
        self.contacts: list[Contact] = []
        self.step_count = 0
        self.diverged: list[str] = []   # names of bodies frozen this step
        # transient mouse-drag pins: held body -> (target_x, target_y, v_max).
        # Each substep the body travels toward its target at up to v_max, so
        # a fast drag stays a smooth, bounded motion instead of a teleport.
        self.drag_pins: dict[Body, tuple[float, float, float]] = {}
        self._contact_cache: dict = {}  # warm-start impulses between substeps
        self._vec: dict | None = None   # numpy scratch, rebuilt each step()
        self._rods: list[DistanceLink] = []      # per-step caches, see
        self._movers: list[Body] = []            # _prepare_step()
        self._contact_static: dict = {}

    # ------------------------------------------------------------------ forces
    def _prepare_step(self) -> None:
        """Rebuild the per-step numpy scratch arrays (or drop them for small
        scenes). Body/link lists cannot change during a step, so quantities
        that only the UI edits (mass, stiffness, ...) are gathered once here
        instead of every force evaluation."""
        bodies = self.bodies
        n = len(bodies)
        springs = []
        rods = []
        no_collide: set[tuple[int, int]] = set()
        for ln in self.links:
            if type(ln) is DistanceLink:
                rods.append(ln)
            elif isinstance(ln, SpringLink):
                springs.append(ln)
            a, b = ln.a.id, ln.b.id
            no_collide.add((a, b) if a < b else (b, a))
        self._rods = rods
        self._movers = [b for b in bodies if b.inv_mass != 0.0]
        # directly linked bodies never collide with each other (their link
        # already governs their separation); everything else does, which is
        # what stops soft bodies from tangling through themselves
        self._contact_static: dict = {"no_collide": no_collide}
        # arrays pay off only when there is real vector work to do: many
        # springs, or many bodies under N-body gravity / custom fields
        # (plain gravity+drag alone is cheaper as a Python loop)
        heavy = (self.mutual_gravity and self.G != 0.0) or any(
            f.enabled and f._fx is not None for f in self.fields)
        if len(springs) < self.VEC_MIN_SPRINGS and not (
                heavy and n >= self.VEC_MIN_BODIES):
            self._vec = None
            return
        for i, b in enumerate(bodies):
            b._idx = i
        inv_m = np.fromiter((b.inv_mass for b in bodies), np.float64, n)
        v: dict = {
            "n": n,
            "mass": np.fromiter((b.mass for b in bodies), np.float64, n),
            "inv_m": inv_m,
            "movable": (inv_m > 0.0).astype(np.float64),
            "cfx": np.fromiter((b.const_force.x for b in bodies), np.float64, n),
            "cfy": np.fromiter((b.const_force.y for b in bodies), np.float64, n),
            "px": np.empty(n), "py": np.empty(n),
            "vx": np.empty(n), "vy": np.empty(n),
        }
        if self.drivers:
            v["id2i"] = {b.id: i for i, b in enumerate(bodies)}
        if springs:
            ns = len(springs)
            v["sa"] = np.fromiter((s.a._idx for s in springs), np.intp, ns)
            v["sb"] = np.fromiter((s.b._idx for s in springs), np.intp, ns)
            v["sk"] = np.fromiter((s.stiffness for s in springs), np.float64, ns)
            v["sr"] = np.fromiter((s.rest_length for s in springs), np.float64, ns)
            # negative damping would inject energy; the scalar path ignores it
            v["sc"] = np.maximum(
                np.fromiter((s.damping for s in springs), np.float64, ns), 0.0)
        self._vec = v

    def _accumulate_forces(self, t: float) -> None:
        """Fill body.acc with the total smooth acceleration at the current state."""
        if self._vec is not None:
            self._accumulate_forces_vec(t)
            self._solve_rod_forces()
            return
        g = self.gravity
        c1 = self.drag_linear
        c2 = self.drag_quadratic
        for b in self.bodies:
            if b.inv_mass == 0.0:
                b.acc.set(0.0, 0.0)
                continue
            inv_m = b.inv_mass
            ax = b.const_force.x * inv_m
            ay = b.const_force.y * inv_m - g
            if c1 != 0.0 or c2 != 0.0:
                vx, vy = b.vel.x, b.vel.y
                speed = (vx * vx + vy * vy) ** 0.5
                drag = (c1 + c2 * speed) * inv_m
                ax -= drag * vx
                ay -= drag * vy
            b.acc.set(ax, ay)

        if self.mutual_gravity and self.G != 0.0:
            bodies = self.bodies
            n = len(bodies)
            G = self.G
            eps2 = self.softening * self.softening
            for i in range(n):
                bi = bodies[i]
                bix = bi.pos.x
                biy = bi.pos.y
                bi_acc = bi.acc
                bi_movable = bi.inv_mass != 0.0
                bi_mass = bi.mass
                for j in range(i + 1, n):
                    bj = bodies[j]
                    dx = bj.pos.x - bix
                    dy = bj.pos.y - biy
                    d2 = dx * dx + dy * dy + eps2
                    s = G / (d2 * d2 ** 0.5)  # G / d^3
                    if bi_movable:
                        m = s * bj.mass
                        bi_acc.x += m * dx
                        bi_acc.y += m * dy
                    if bj.inv_mass != 0.0:
                        m = s * bi_mass
                        bj.acc.x -= m * dx
                        bj.acc.y -= m * dy

        for link in self.links:
            if isinstance(link, SpringLink):
                link.apply_forces()

        if self.drivers:
            from math import cos, sin, tau
            by_id = {b.id: b for b in self.bodies}
            for drv in self.drivers:
                if not drv.enabled:
                    continue
                b = by_id.get(drv.body_id)
                if b is None or b.inv_mass == 0.0:
                    continue
                f = drv.amplitude * sin(tau * drv.frequency * t + drv.phase)
                b.acc.x += f * cos(drv.angle) * b.inv_mass
                b.acc.y += f * sin(drv.angle) * b.inv_mass

        for field in self.fields:
            if not field.enabled or field._fx is None:
                continue
            fx, fy = field._fx, field._fy
            for b in self.bodies:
                if b.inv_mass == 0.0:
                    continue
                env = {"x": b.pos.x, "y": b.pos.y, "vx": b.vel.x, "vy": b.vel.y,
                       "t": t, "m": b.mass,
                       "r": (b.pos.x * b.pos.x + b.pos.y * b.pos.y) ** 0.5}
                try:
                    b.acc.x += float(fx(env)) * b.inv_mass
                    b.acc.y += float(fy(env)) * b.inv_mass
                except Exception:
                    pass  # singular point (e.g. 1/r at origin): skip this sample

        self._solve_rod_forces()

    def _accumulate_forces_vec(self, t: float) -> None:
        """Vectorized twin of the scalar force pass: gravity, drag, N-body,
        springs, drivers and fields computed with numpy over every body at
        once, then scattered back into body.acc."""
        v = self._vec
        bodies = self.bodies
        n = v["n"]
        px, py, vx, vy = v["px"], v["py"], v["vx"], v["vy"]
        px[:] = [b.pos.x for b in bodies]
        py[:] = [b.pos.y for b in bodies]
        vx[:] = [b.vel.x for b in bodies]
        vy[:] = [b.vel.y for b in bodies]
        inv_m = v["inv_m"]

        ax = v["cfx"] * inv_m
        ay = v["cfy"] * inv_m - self.gravity
        c1 = self.drag_linear
        c2 = self.drag_quadratic
        if c1 != 0.0 or c2 != 0.0:
            drag = (c1 + c2 * np.hypot(vx, vy)) * inv_m
            ax -= drag * vx
            ay -= drag * vy

        if self.mutual_gravity and self.G != 0.0:
            dx = px[None, :] - px[:, None]
            dy = py[None, :] - py[:, None]
            d2 = dx * dx + dy * dy + self.softening * self.softening
            np.fill_diagonal(d2, np.inf)
            s = self.G * d2 ** -1.5
            m = v["mass"]
            ax += (s * dx) @ m
            ay += (s * dy) @ m

        sa = v.get("sa")
        if sa is not None:
            sb = v["sb"]
            dx = px[sb] - px[sa]
            dy = py[sb] - py[sa]
            dist = np.hypot(dx, dy)
            safe = np.maximum(dist, 1e-9)
            nx = dx / safe
            ny = dy / safe
            f = v["sk"] * (dist - v["sr"])
            f += v["sc"] * ((vx[sb] - vx[sa]) * nx + (vy[sb] - vy[sa]) * ny)
            f[dist < 1e-9] = 0.0    # coincident ends: no defined direction
            fx = f * nx
            fy = f * ny
            # positive f pulls the ends together (a += f n, b -= f n)
            ax += (np.bincount(sa, fx, n) - np.bincount(sb, fx, n)) * inv_m
            ay += (np.bincount(sa, fy, n) - np.bincount(sb, fy, n)) * inv_m

        if self.drivers:
            from math import cos, sin, tau
            id2i = v["id2i"]
            for drv in self.drivers:
                if not drv.enabled:
                    continue
                i = id2i.get(drv.body_id)
                if i is None or inv_m[i] == 0.0:
                    continue
                f = drv.amplitude * sin(tau * drv.frequency * t + drv.phase)
                ax[i] += f * cos(drv.angle) * inv_m[i]
                ay[i] += f * sin(drv.angle) * inv_m[i]

        for field in self.fields:
            if not field.enabled or field._fx is None:
                continue
            env = {"x": px, "y": py, "vx": vx, "vy": vy, "t": t,
                   "m": v["mass"], "r": np.hypot(px, py)}
            try:
                fxv = np.asarray(field._fx(env), np.float64)
                fyv = np.asarray(field._fy(env), np.float64)
                if not (np.all(np.isfinite(fxv)) and np.all(np.isfinite(fyv))):
                    # singular samples (e.g. 1/r at the origin): skip them
                    fxv = np.where(np.isfinite(fxv), fxv, 0.0)
                    fyv = np.where(np.isfinite(fyv), fyv, 0.0)
                ax += fxv * inv_m
                ay += fyv * inv_m
            except Exception:
                # not vectorizable (e.g. uses `and`/`or`): evaluate per body
                for i, b in enumerate(bodies):
                    if inv_m[i] == 0.0:
                        continue
                    e = {"x": b.pos.x, "y": b.pos.y, "vx": b.vel.x,
                         "vy": b.vel.y, "t": t, "m": b.mass,
                         "r": (b.pos.x * b.pos.x + b.pos.y * b.pos.y) ** 0.5}
                    try:
                        ax[i] += float(field._fx(e)) * inv_m[i]
                        ay[i] += float(field._fy(e)) * inv_m[i]
                    except Exception:
                        pass  # singular point: skip this sample

        movable = v["movable"]
        ax *= movable
        ay *= movable
        axl = ax.tolist()   # plain floats keep the scalar solvers fast
        ayl = ay.tolist()
        for i, b in enumerate(bodies):
            acc = b.acc
            acc.x = axl[i]
            acc.y = ayl[i]

    def _solve_rod_forces(self) -> None:
        """Add the analytic rod/rope constraint forces to the accelerations.

        Solves d^2C/dt^2 = n.(a_b - a_a) + |v_t|^2/d = 0 for every rod's
        tension with warm-started Gauss-Seidel. The warm start (last solve's
        tension as the initial guess) makes a few passes sufficient even for
        long chains; the XPBD position pass mops up the O(h^2) residual.
        """
        rows = []
        for ln in self._rods:
            a = ln.a
            b = ln.b
            wa = a.inv_mass
            wb = b.inv_mass
            w_sum = wa + wb
            if w_sum == 0.0:
                continue
            dx = b.pos.x - a.pos.x
            dy = b.pos.y - a.pos.y
            d2 = dx * dx + dy * dy
            if d2 < 1e-18:
                continue
            d = d2 ** 0.5
            if ln.is_rope and d < ln.length - 1e-9:
                ln._mu = 0.0    # slack: no tension, drop the warm start
                continue
            nx = dx / d
            ny = dy / d
            mu = ln._mu
            if ln.is_rope and mu < 0.0:
                mu = 0.0
            if mu != 0.0:   # apply the warm-start guess immediately
                a.acc.x += mu * wa * nx
                a.acc.y += mu * wa * ny
                b.acc.x -= mu * wb * nx
                b.acc.y -= mu * wb * ny
            rows.append([ln, a, b, wa, wb, w_sum, nx, ny, d, mu])
        if not rows:
            return
        for _ in range(ROD_FORCE_PASSES):
            worst = 0.0
            for row in rows:
                ln, a, b, wa, wb, w_sum, nx, ny, d, mu = row
                rvx = b.vel.x - a.vel.x
                rvy = b.vel.y - a.vel.y
                vn = rvx * nx + rvy * ny
                vt2 = rvx * rvx + rvy * rvy - vn * vn
                an = (b.acc.x - a.acc.x) * nx + (b.acc.y - a.acc.y) * ny
                new_mu = mu + (an + vt2 / d) / w_sum
                if ln.is_rope and new_mu < 0.0:
                    new_mu = 0.0
                dmu = new_mu - mu
                row[9] = mu = new_mu
                if dmu != 0.0:
                    a.acc.x += dmu * wa * nx
                    a.acc.y += dmu * wa * ny
                    b.acc.x -= dmu * wb * nx
                    b.acc.y -= dmu * wb * ny
                    d_abs = dmu if dmu > 0.0 else -dmu
                    if d_abs > worst:
                        worst = d_abs
            if worst < 1e-9:
                break
        for row in rows:
            row[0]._mu = row[9]

    # -------------------------------------------------------------- integrators
    def _integrate(self, h: float) -> None:
        name = self.integrator
        movers = self._movers
        if name == "RK4":
            self._integrate_rk4(h)
        elif name == "Symplectic Euler":
            self._accumulate_forces(self.time)
            for b in movers:
                b.angle += b.omega * h
                b.vel.x += b.acc.x * h
                b.vel.y += b.acc.y * h
                b.pos.x += b.vel.x * h
                b.pos.y += b.vel.y * h
        else:  # Velocity Verlet
            self._accumulate_forces(self.time)
            half = 0.5 * h
            for b in movers:
                b.angle += b.omega * h
                b.vel.x += b.acc.x * half
                b.vel.y += b.acc.y * half
                b.pos.x += b.vel.x * h
                b.pos.y += b.vel.y * h
            self._accumulate_forces(self.time + h)
            for b in movers:
                b.vel.x += b.acc.x * half
                b.vel.y += b.acc.y * half

    def _integrate_rk4(self, h: float) -> None:
        movers = self._movers
        if not movers:
            return
        for b in movers:
            b.angle += b.omega * h
        x0 = [(b.pos.x, b.pos.y, b.vel.x, b.vel.y) for b in movers]

        def eval_acc(t: float) -> list[tuple[float, float]]:
            self._accumulate_forces(t)
            return [(b.acc.x, b.acc.y) for b in movers]

        def load(state: list[tuple[float, float, float, float]]) -> None:
            for b, (px, py, vx, vy) in zip(movers, state):
                b.pos.x, b.pos.y, b.vel.x, b.vel.y = px, py, vx, vy

        k1a = eval_acc(self.time)
        k1 = [(vx, vy, ax, ay) for (_, _, vx, vy), (ax, ay) in zip(x0, k1a)]
        load([(px + 0.5 * h * d[0], py + 0.5 * h * d[1],
               vx + 0.5 * h * d[2], vy + 0.5 * h * d[3])
              for (px, py, vx, vy), d in zip(x0, k1)])
        k2a = eval_acc(self.time + 0.5 * h)
        k2 = [(b.vel.x, b.vel.y, ax, ay) for b, (ax, ay) in zip(movers, k2a)]
        load([(px + 0.5 * h * d[0], py + 0.5 * h * d[1],
               vx + 0.5 * h * d[2], vy + 0.5 * h * d[3])
              for (px, py, vx, vy), d in zip(x0, k2)])
        k3a = eval_acc(self.time + 0.5 * h)
        k3 = [(b.vel.x, b.vel.y, ax, ay) for b, (ax, ay) in zip(movers, k3a)]
        load([(px + h * d[0], py + h * d[1], vx + h * d[2], vy + h * d[3])
              for (px, py, vx, vy), d in zip(x0, k3)])
        k4a = eval_acc(self.time + h)
        k4 = [(b.vel.x, b.vel.y, ax, ay) for b, (ax, ay) in zip(movers, k4a)]

        sixth = h / 6.0
        for b, (px, py, vx, vy), d1, d2, d3, d4 in zip(movers, x0, k1, k2, k3, k4):
            b.pos.x = px + sixth * (d1[0] + 2 * d2[0] + 2 * d3[0] + d4[0])
            b.pos.y = py + sixth * (d1[1] + 2 * d2[1] + 2 * d3[1] + d4[1])
            b.vel.x = vx + sixth * (d1[2] + 2 * d2[2] + 2 * d3[2] + d4[2])
            b.vel.y = vy + sixth * (d1[3] + 2 * d2[3] + 2 * d3[3] + d4[3])

    # ------------------------------------------------------------------- step
    def step(self, dt: float) -> None:
        """Advance the world by dt seconds using the configured substeps."""
        n = max(1, self.substeps)
        h = dt / n
        inv_h = 1.0 / h
        self._prepare_step()
        self.contacts = []
        self.diverged = []
        for b in self.bodies:
            b._prev.x = b.pos.x
            b._prev.y = b.pos.y
        rigid = self._rods
        iters = self.iterations
        for _ in range(n):
            if self.drag_pins:
                self._move_drag_pins(h, inv_h)

            # (spin integration happens inside the integrator body loops;
            # torque only arises from contacts, applied there)
            self._integrate(h)

            if rigid:
                self._solve_rod_positions(rigid, h, inv_h, iters)

            solve_contacts(self.bodies, self.walls, self.contacts, iters,
                           self._contact_cache, self._contact_static)

            if self.global_damping > 0.0:
                decay = max(0.0, 1.0 - self.global_damping * h)
                for b in self.bodies:
                    b.vel.x *= decay
                    b.vel.y *= decay
                    b.omega *= decay

            self.time += h
        self._sanitize()
        self.step_count += 1

    def _move_drag_pins(self, h: float, inv_h: float) -> None:
        """Advance held bodies toward their drag targets, at most v_max each.

        The body keeps infinite mass (nothing can push it) but moves
        kinematically with a real velocity, so springs stretch smoothly,
        spring damping sees the true relative speed, and contacts treat it
        like a moving platform that carries other bodies along.
        """
        for b, (tx, ty, v_max) in self.drag_pins.items():
            if not b.held:
                continue    # released this frame; controller clears soon
            dx = tx - b.pos.x
            dy = ty - b.pos.y
            dist = (dx * dx + dy * dy) ** 0.5
            step_len = v_max * h
            if dist <= step_len:
                b.pos.set(tx, ty)
                b.vel.set(dx * inv_h, dy * inv_h)
            else:
                s = step_len / dist
                mx = dx * s
                my = dy * s
                b.pos.x += mx
                b.pos.y += my
                b.vel.set(mx * inv_h, my * inv_h)

    def _solve_rod_positions(self, rigid: list[DistanceLink], h: float,
                             inv_h: float, iterations: int) -> None:
        """XPBD position solve for the residual link drift, with the
        corrections fed back into velocities."""
        rows = []
        for ln in rigid:
            a = ln.a
            b = ln.b
            wa = a.inv_mass
            wb = b.inv_mass
            if wa + wb == 0.0:
                continue
            ln._lambda = 0.0
            rows.append((ln, a, b, wa, wb, wa + wb,
                         ln.compliance * inv_h * inv_h))
        if not rows:
            return
        touched: dict[int, Body] = {}
        for _, a, b, _, _, _, _ in rows:
            if a.id not in touched:
                touched[a.id] = a
                a._corr_x = 0.0
                a._corr_y = 0.0
            if b.id not in touched:
                touched[b.id] = b
                b._corr_x = 0.0
                b._corr_y = 0.0
        for _ in range(iterations):
            worst = 0.0
            for ln, a, b, wa, wb, w_sum, alpha in rows:
                dx = b.pos.x - a.pos.x
                dy = b.pos.y - a.pos.y
                dist = (dx * dx + dy * dy) ** 0.5
                if dist < 1e-12:
                    continue
                c = dist - ln.length
                if ln.is_rope and c <= 0.0:
                    continue
                nx = dx / dist
                ny = dy / dist
                dlam = (-c - alpha * ln._lambda) / (w_sum + alpha)
                ln._lambda += dlam
                d = dlam if dlam > 0.0 else -dlam
                if d > worst:
                    worst = d
                ax = -wa * dlam * nx
                ay = -wa * dlam * ny
                bx = wb * dlam * nx
                by = wb * dlam * ny
                a.pos.x += ax
                a.pos.y += ay
                b.pos.x += bx
                b.pos.y += by
                a._corr_x += ax
                a._corr_y += ay
                b._corr_x += bx
                b._corr_y += by
            if worst < 1e-10:   # converged: links are exact to sub-nanometre
                break
        for body in touched.values():
            if body._corr_x != 0.0 or body._corr_y != 0.0:
                body.vel.x += body._corr_x * inv_h
                body.vel.y += body._corr_y * inv_h

    def _sanitize(self) -> None:
        """Freeze any body whose state became non-finite (a numerical
        blow-up, e.g. from an extreme custom field) instead of crashing."""
        for b in self.bodies:
            # any inf/nan component makes the sum non-finite
            if isfinite(b.pos.x + b.pos.y + b.vel.x + b.vel.y + b.omega):
                continue
            if isfinite(b._prev.x) and isfinite(b._prev.y):
                b.pos.set_vec(b._prev)
            else:
                b.pos.set(0.0, 0.0)
            b.vel.set(0.0, 0.0)
            b.omega = 0.0
            b.acc.set(0.0, 0.0)
            self.diverged.append(b.name)

    # ------------------------------------------------------------- diagnostics
    def energy(self) -> dict[str, float]:
        ke = 0.0
        pe_g = 0.0
        for b in self.bodies:
            if b.inv_mass == 0.0:
                continue
            ke += b.kinetic_energy()
            pe_g += b.mass * self.gravity * b.pos.y
        pe_s = sum(ln.potential_energy() for ln in self.links
                   if isinstance(ln, SpringLink))
        pe_n = 0.0
        if self.mutual_gravity and self.G != 0.0:
            # softened potential, consistent with the softened force
            bodies = self.bodies
            eps2 = self.softening * self.softening
            if len(bodies) >= self.VEC_MIN_BODIES:
                px = np.fromiter((b.pos.x for b in bodies), np.float64)
                py = np.fromiter((b.pos.y for b in bodies), np.float64)
                m = np.fromiter((b.mass for b in bodies), np.float64)
                dx = px[None, :] - px[:, None]
                dy = py[None, :] - py[:, None]
                d2 = dx * dx + dy * dy + eps2
                np.fill_diagonal(d2, np.inf)
                pe_n = -0.5 * self.G * float(m @ (d2 ** -0.5) @ m)
            else:
                for i in range(len(bodies)):
                    bi = bodies[i]
                    for j in range(i + 1, len(bodies)):
                        bj = bodies[j]
                        dx = bj.pos.x - bi.pos.x
                        dy = bj.pos.y - bi.pos.y
                        pe_n -= self.G * bi.mass * bj.mass / (
                            (dx * dx + dy * dy + eps2) ** 0.5)
        return {"ke": ke, "pe": pe_g + pe_s + pe_n, "total": ke + pe_g + pe_s + pe_n}

    def momentum(self) -> Vec2:
        p = Vec2()
        for b in self.bodies:
            if b.inv_mass != 0.0:
                p.x += b.mass * b.vel.x
                p.y += b.mass * b.vel.y
        return p

    def centre_of_mass(self) -> Vec2 | None:
        m_total = 0.0
        cx = cy = 0.0
        for b in self.bodies:
            if b.inv_mass != 0.0:
                m_total += b.mass
                cx += b.mass * b.pos.x
                cy += b.mass * b.pos.y
        if m_total == 0.0:
            return None
        return Vec2(cx / m_total, cy / m_total)

    def angular_momentum(self) -> float:
        """Total angular momentum about the centre of mass (spin + orbital)."""
        com = self.centre_of_mass()
        if com is None:
            return 0.0
        total = 0.0
        for b in self.bodies:
            if b.inv_mass == 0.0:
                continue
            rx, ry = b.pos.x - com.x, b.pos.y - com.y
            total += b.mass * (rx * b.vel.y - ry * b.vel.x)
            total += b.inertia * b.omega
        return total

    # ------------------------------------------------------------ bookkeeping
    def body_by_id(self, bid: int) -> Body | None:
        for b in self.bodies:
            if b.id == bid:
                return b
        return None

    def remove_body(self, body: Body) -> None:
        if body in self.bodies:
            self.bodies.remove(body)
        self.links = [ln for ln in self.links if ln.a is not body and ln.b is not body]
        self.drivers = [d for d in self.drivers if d.body_id != body.id]

    def remove_wall(self, wall: Wall) -> None:
        if wall in self.walls:
            self.walls.remove(wall)

    def remove_link(self, link) -> None:
        if link in self.links:
            self.links.remove(link)

    # ----------------------------------------------------------- serialization
    def to_dict(self) -> dict:
        return {
            "settings": {
                "gravity": self.gravity, "mutual_gravity": self.mutual_gravity,
                "G": self.G, "softening": self.softening,
                "drag_linear": self.drag_linear,
                "drag_quadratic": self.drag_quadratic,
                "global_damping": self.global_damping,
                "integrator": self.integrator, "substeps": self.substeps,
                "iterations": self.iterations, "time": self.time,
            },
            "bodies": [b.to_dict() for b in self.bodies],
            "walls": [w.to_dict() for w in self.walls],
            "links": [ln.to_dict() for ln in self.links],
            "fields": [f.to_dict() for f in self.fields],
            "drivers": [d.to_dict() for d in self.drivers],
        }

    @staticmethod
    def from_dict(data: dict) -> "World":
        w = World()
        s = data.get("settings", {})
        w.gravity = s.get("gravity", 9.81)
        w.mutual_gravity = s.get("mutual_gravity", False)
        w.G = s.get("G", 1.0)
        w.softening = s.get("softening", 0.01)
        w.drag_linear = s.get("drag_linear", 0.0)
        w.drag_quadratic = s.get("drag_quadratic", 0.0)
        w.global_damping = s.get("global_damping", 0.0)
        w.integrator = s.get("integrator", "Velocity Verlet")
        w.substeps = int(s.get("substeps", 4))
        w.iterations = int(s.get("iterations", 8))
        w.time = s.get("time", 0.0)
        w.bodies = [Body.from_dict(d) for d in data.get("bodies", [])]
        w.walls = [Wall.from_dict(d) for d in data.get("walls", [])]
        by_id = {b.id: b for b in w.bodies}
        w.links = [link_from_dict(d, by_id) for d in data.get("links", [])
                   if d["a"] in by_id and d["b"] in by_id]
        w.fields = [ForceField.from_dict(d) for d in data.get("fields", [])]
        w.drivers = [Driver.from_dict(d) for d in data.get("drivers", [])]
        return w
