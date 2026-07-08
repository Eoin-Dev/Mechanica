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

from mechanica.core.expr import ExprError, compile_expr
from mechanica.core.vec import Vec2
from mechanica.engine.body import Body, Wall
from mechanica.engine.contacts import Contact, solve_contacts
from mechanica.engine.links import DistanceLink, SpringLink, link_from_dict

INTEGRATORS = ("Velocity Verlet", "Symplectic Euler", "RK4")

# Gauss-Seidel passes for the acceleration-level rod tension solve. Warm
# starting makes a handful of passes enough even for long chains.
ROD_FORCE_PASSES = 4


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
        self._contact_cache: dict = {}  # warm-start impulses between substeps

    # ------------------------------------------------------------------ forces
    def _accumulate_forces(self, t: float) -> None:
        """Fill body.acc with the total smooth acceleration at the current state."""
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

    def _solve_rod_forces(self) -> None:
        """Add the analytic rod/rope constraint forces to the accelerations.

        Solves d^2C/dt^2 = n.(a_b - a_a) + |v_t|^2/d = 0 for every rod's
        tension with warm-started Gauss-Seidel. The warm start (last solve's
        tension as the initial guess) makes a few passes sufficient even for
        long chains; the XPBD position pass mops up the O(h^2) residual.
        """
        rows = []
        for ln in self.links:
            if type(ln) is not DistanceLink:
                continue
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
        if name == "RK4":
            self._integrate_rk4(h)
        elif name == "Symplectic Euler":
            self._accumulate_forces(self.time)
            for b in self.bodies:
                if b.inv_mass == 0.0:
                    continue
                b.angle += b.omega * h
                b.vel.x += b.acc.x * h
                b.vel.y += b.acc.y * h
                b.pos.x += b.vel.x * h
                b.pos.y += b.vel.y * h
        else:  # Velocity Verlet
            self._accumulate_forces(self.time)
            half = 0.5 * h
            for b in self.bodies:
                if b.inv_mass == 0.0:
                    continue
                b.angle += b.omega * h
                b._acc0.set_vec(b.acc)
                b.vel.x += b.acc.x * half
                b.vel.y += b.acc.y * half
                b.pos.x += b.vel.x * h
                b.pos.y += b.vel.y * h
            self._accumulate_forces(self.time + h)
            for b in self.bodies:
                if b.inv_mass == 0.0:
                    continue
                b.vel.x += b.acc.x * half
                b.vel.y += b.acc.y * half

    def _integrate_rk4(self, h: float) -> None:
        movers = [b for b in self.bodies if b.inv_mass != 0.0]
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
        self.contacts = []
        self.diverged = []
        for b in self.bodies:
            b._prev.x = b.pos.x
            b._prev.y = b.pos.y
        rigid = [ln for ln in self.links if type(ln) is DistanceLink]
        iters = self.iterations
        for _ in range(n):
            # (spin integration happens inside the integrator body loops;
            # torque only arises from contacts, applied there)
            self._integrate(h)

            if rigid:
                self._solve_rod_positions(rigid, h, inv_h, iters)

            solve_contacts(self.bodies, self.walls, self.contacts, iters,
                           self._contact_cache)

            if self.global_damping > 0.0:
                decay = max(0.0, 1.0 - self.global_damping * h)
                for b in self.bodies:
                    b.vel.x *= decay
                    b.vel.y *= decay
                    b.omega *= decay

            self.time += h
        self._sanitize()
        self.step_count += 1

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
