"""Links between bodies: rigid rods / ropes (constraints) and springs.

Rods and ropes are solved in two phases by the world stepper:

  1. Force phase: the analytic constraint force (rod tension) is solved at
     the acceleration level with warm-started Gauss-Seidel and added to the
     accelerations before integrating. This is what keeps pendulums and
     chains energy-conserving -- pure position projection would silently
     drain energy every substep.
  2. Position phase: an XPBD solve removes the tiny O(h^2) residual drift so
     link lengths stay exact, and the corrections are fed back into the
     velocities.

Ropes are the same constraint made one-sided (they resist stretching only).
Springs are smooth forces (Hooke's law + optional axial damping) handled by
the integrator, which is the physically accurate treatment for oscillators.
"""
from __future__ import annotations

from mechanica.engine.body import Body


class DistanceLink:
    """Rigid rod (or rope) between two bodies."""

    __slots__ = ("id", "a", "b", "length", "compliance", "is_rope",
                 "_lambda", "_mu")

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
        self._lambda = 0.0   # XPBD accumulator (per substep)
        self._mu = 0.0       # warm-start guess for the constraint force

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
