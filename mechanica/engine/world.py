"""The physics world: bodies, walls, links, force generators and the stepper.

Stepping pipeline (per substep of length h):
  1. Evaluate smooth forces (gravity, N-body, drag, springs, drivers, custom
     fields) and integrate them with the selected integrator:
       - Symplectic Euler: 1st order, symplectic. Very robust.
       - Velocity Verlet:  2nd order, symplectic. Default -- excellent
         long-term energy behaviour for orbits and oscillators.
       - RK4: 4th order, non-symplectic. Best short-term accuracy for smooth
         systems (e.g. projectiles with drag); may slowly drift on orbits.
  2. Solve rigid links (XPBD position constraints, several iterations),
     then feed the corrections back into velocities.
  3. Detect and resolve contacts (impulses + friction + projection).
  4. Apply global velocity damping, advance time.

Substepping does most of the heavy lifting for accuracy: 4 substeps at 120 Hz
gives an effective 480 Hz solver rate.
"""
from __future__ import annotations

from mechanica.core.expr import ExprError, compile_expr
from mechanica.core.vec import Vec2
from mechanica.engine.body import Body, Wall
from mechanica.engine.contacts import Contact, collide_bodies, collide_walls
from mechanica.engine.links import DistanceLink, SpringLink, link_from_dict

INTEGRATORS = ("Velocity Verlet", "Symplectic Euler", "RK4")


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
        self.iterations = 8          # XPBD iterations per substep

        self.time = 0.0
        self.contacts: list[Contact] = []
        self.step_count = 0

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
            ax = b.const_force.x * b.inv_mass
            ay = b.const_force.y * b.inv_mass - g
            if c1 != 0.0 or c2 != 0.0:
                vx, vy = b.vel.x, b.vel.y
                speed = (vx * vx + vy * vy) ** 0.5
                drag = c1 + c2 * speed
                ax -= drag * vx * b.inv_mass
                ay -= drag * vy * b.inv_mass
            b.acc.set(ax, ay)

        if self.mutual_gravity and self.G != 0.0:
            bodies = self.bodies
            n = len(bodies)
            G = self.G
            eps2 = self.softening * self.softening
            for i in range(n):
                bi = bodies[i]
                for j in range(i + 1, n):
                    bj = bodies[j]
                    dx = bj.pos.x - bi.pos.x
                    dy = bj.pos.y - bi.pos.y
                    d2 = dx * dx + dy * dy + eps2
                    inv_d = 1.0 / (d2 ** 0.5)
                    s = G * inv_d * inv_d * inv_d  # G / d^3
                    if bi.inv_mass != 0.0:
                        bi.acc.x += s * bj.mass * dx
                        bi.acc.y += s * bj.mass * dy
                    if bj.inv_mass != 0.0:
                        bj.acc.x -= s * bi.mass * dx
                        bj.acc.y -= s * bi.mass * dy

        for link in self.links:
            if isinstance(link, SpringLink):
                link.apply_forces()

        if self.drivers:
            from math import sin, tau, cos
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
        self.contacts = []
        rigid = [ln for ln in self.links if isinstance(ln, DistanceLink)]
        for _ in range(n):
            # spin integration (torque only arises from contacts, applied there)
            for b in self.bodies:
                if b.inv_mass != 0.0:
                    b.angle += b.omega * h
            self._integrate(h)

            if rigid:
                for ln in rigid:
                    ln._lambda = 0.0
                for b in self.bodies:
                    b._corr_x = 0.0
                    b._corr_y = 0.0
                for _ in range(self.iterations):
                    for ln in rigid:
                        ln.solve(h)
                inv_h = 1.0 / h
                for b in self.bodies:
                    if b._corr_x != 0.0 or b._corr_y != 0.0:
                        b.vel.x += b._corr_x * inv_h
                        b.vel.y += b._corr_y * inv_h

            collide_bodies(self.bodies, self.contacts)
            collide_walls(self.bodies, self.walls, self.contacts)

            if self.global_damping > 0.0:
                decay = max(0.0, 1.0 - self.global_damping * h)
                for b in self.bodies:
                    b.vel.x *= decay
                    b.vel.y *= decay
                    b.omega *= decay

            self.time += h
        self.step_count += 1

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
            bodies = self.bodies
            for i in range(len(bodies)):
                for j in range(i + 1, len(bodies)):
                    d = bodies[i].pos.dist_to(bodies[j].pos)
                    pe_n -= self.G * bodies[i].mass * bodies[j].mass / max(d, 1e-9)
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
