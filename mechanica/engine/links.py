"""Links between bodies: rigid rods / ropes (XPBD constraints) and springs.

Rods are solved as XPBD position constraints (exact length, no stretch drift,
stable for long chains -> multi-link pendulums, linkages). Ropes are the same
constraint made one-sided (resists extension only). Springs are smooth forces
(Hooke's law + optional damping) handled by the integrator, which is the
physically accurate treatment for oscillators.
"""
from __future__ import annotations

from mechanica.engine.body import Body


class DistanceLink:
    """Rigid rod (or rope) between two bodies, solved positionally (XPBD)."""

    __slots__ = ("id", "a", "b", "length", "compliance", "is_rope", "_lambda")

    _next_id = 1

    def __init__(self, a: Body, b: Body, length: float | None = None,
                 is_rope: bool = False, compliance: float = 0.0) -> None:
        self.id = DistanceLink._next_id
        DistanceLink._next_id += 1
        self.a = a
        self.b = b
        self.length = a.pos.dist_to(b.pos) if length is None else length
        self.compliance = compliance  # m/N; 0 = perfectly rigid
        self.is_rope = is_rope
        self._lambda = 0.0

    def project_acceleration(self) -> None:
        """Apply the analytic constraint force (rod tension) at the
        acceleration level: solves d²C/dt² = n·(a_b - a_a) + |v_t|²/d = 0
        for the Lagrange multiplier. Doing this before integrating means the
        XPBD position solve only mops up O(h²) residual, which removes the
        systematic energy loss of pure position projection (the projection
        would otherwise discard the radial velocity gained from unresisted
        gravity every substep)."""
        a, b = self.a, self.b
        wa, wb = a.inv_mass, b.inv_mass
        w_sum = wa + wb
        if w_sum == 0.0:
            return
        dx = b.pos.x - a.pos.x
        dy = b.pos.y - a.pos.y
        d2 = dx * dx + dy * dy
        if d2 < 1e-18:
            return
        d = d2 ** 0.5
        nx, ny = dx / d, dy / d
        if self.is_rope and d < self.length - 1e-9:
            return  # slack rope: no tension
        rvx = b.vel.x - a.vel.x
        rvy = b.vel.y - a.vel.y
        vn = rvx * nx + rvy * ny
        vt2 = rvx * rvx + rvy * rvy - vn * vn
        an = (b.acc.x - a.acc.x) * nx + (b.acc.y - a.acc.y) * ny
        mu = (an + vt2 / d) / w_sum
        if self.is_rope and mu < 0.0:
            return  # rope cannot push
        a.acc.x += mu * wa * nx
        a.acc.y += mu * wa * ny
        b.acc.x -= mu * wb * nx
        b.acc.y -= mu * wb * ny

    def solve(self, h: float) -> None:
        """One XPBD iteration; h is the substep duration."""
        a, b = self.a, self.b
        wa, wb = a.inv_mass, b.inv_mass
        w_sum = wa + wb
        if w_sum == 0.0:
            return
        dx = b.pos.x - a.pos.x
        dy = b.pos.y - a.pos.y
        dist = (dx * dx + dy * dy) ** 0.5
        if dist < 1e-12:
            return
        c = dist - self.length
        if self.is_rope and c <= 0.0:
            return
        nx, ny = dx / dist, dy / dist
        alpha = self.compliance / (h * h)
        dlam = (-c - alpha * self._lambda) / (w_sum + alpha)
        self._lambda += dlam
        # gradient wrt a is -n, wrt b is +n
        ax, ay = -wa * dlam * nx, -wa * dlam * ny
        bx, by = wb * dlam * nx, wb * dlam * ny
        a.pos.x += ax
        a.pos.y += ay
        b.pos.x += bx
        b.pos.y += by
        a._corr_x += ax
        a._corr_y += ay
        b._corr_x += bx
        b._corr_y += by

    def to_dict(self) -> dict:
        return {"type": "rod", "id": self.id, "a": self.a.id, "b": self.b.id,
                "length": self.length, "is_rope": self.is_rope,
                "compliance": self.compliance}


class SpringLink:
    """Hookean spring (optionally damped) between two bodies."""

    __slots__ = ("id", "a", "b", "rest_length", "stiffness", "damping")

    _next_id = 1

    def __init__(self, a: Body, b: Body, rest_length: float | None = None,
                 stiffness: float = 20.0, damping: float = 0.0) -> None:
        self.id = SpringLink._next_id
        SpringLink._next_id += 1
        self.a = a
        self.b = b
        self.rest_length = a.pos.dist_to(b.pos) if rest_length is None else rest_length
        self.stiffness = stiffness  # N/m
        self.damping = damping      # N*s/m, along the spring axis

    def apply_forces(self) -> None:
        a, b = self.a, self.b
        dx = b.pos.x - a.pos.x
        dy = b.pos.y - a.pos.y
        dist = (dx * dx + dy * dy) ** 0.5
        if dist < 1e-9:
            return
        nx, ny = dx / dist, dy / dist
        f = self.stiffness * (dist - self.rest_length)
        if self.damping > 0.0:
            vrel = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny
            f += self.damping * vrel
        # positive f pulls the ends together
        a.acc.x += f * nx * a.inv_mass
        a.acc.y += f * ny * a.inv_mass
        b.acc.x -= f * nx * b.inv_mass
        b.acc.y -= f * ny * b.inv_mass

    def potential_energy(self) -> float:
        ext = self.a.pos.dist_to(self.b.pos) - self.rest_length
        return 0.5 * self.stiffness * ext * ext

    def to_dict(self) -> dict:
        return {"type": "spring", "id": self.id, "a": self.a.id, "b": self.b.id,
                "rest_length": self.rest_length, "stiffness": self.stiffness,
                "damping": self.damping}


def link_from_dict(d: dict, bodies_by_id: dict[int, Body]):
    a, b = bodies_by_id[d["a"]], bodies_by_id[d["b"]]
    if d["type"] == "spring":
        link = SpringLink(a, b, d["rest_length"], d["stiffness"], d["damping"])
    else:
        link = DistanceLink(a, b, d["length"], d.get("is_rope", False),
                            d.get("compliance", 0.0))
    link.id = d["id"]
    cls = type(link)
    cls._next_id = max(cls._next_id, link.id + 1)
    return link
