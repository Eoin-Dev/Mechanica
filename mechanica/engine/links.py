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

Springs are smooth forces (Hooke's law F = -k*extension plus optional axial
damping F = -c*v_rel) handled by the integrator, which is the physically
accurate treatment for oscillators. `k` is the spring constant (the 1-D
analogue of the modulus of elasticity) and the rest length is the natural
length L0 at which the spring exerts no force.

Strings are tension-only springs (`tension_only=True`): they pull when
stretched beyond their natural length and go completely slack when shorter,
transmitting neither push nor damping. An *inelastic* string is the same
one-sided idea taken to infinite stiffness: a DistanceLink with
`is_rope=True`, rigid in tension, free when slack.

The engine clamps each spring's effective k and c per substep to its
explicit-integration stability limit (see World._prepare_step), so absurd
user settings soften instead of exploding the simulation.
"""
from __future__ import annotations

from mechanica.engine.body import Body


class DistanceLink:
    """Rigid rod (or, with is_rope, an inelastic string) between two bodies."""

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
    """Hookean spring (optionally damped) between two bodies.

    With `tension_only=True` it behaves as an elastic string: it pulls when
    stretched past its natural length and is completely slack otherwise.
    `_k_eff`/`_c_eff` are the per-substep stability-clamped coefficients the
    solver actually applies; World._prepare_step refreshes them every step.
    """

    __slots__ = ("id", "a", "b", "rest_length", "stiffness", "damping",
                 "tension_only", "_k_eff", "_c_eff")

    _next_id = 1

    def __init__(self, a: Body, b: Body, rest_length: float | None = None,
                 stiffness: float = 20.0, damping: float = 0.0,
                 tension_only: bool = False) -> None:
        self.id = SpringLink._next_id
        SpringLink._next_id += 1
        self.a = a
        self.b = b
        self.rest_length = a.pos.dist_to(b.pos) if rest_length is None else rest_length
        self.stiffness = stiffness      # spring constant k, N/m
        self.damping = damping          # damping coefficient c, N*s/m, axial
        self.tension_only = tension_only
        self._k_eff = stiffness
        self._c_eff = max(damping, 0.0)

    def apply_forces(self) -> None:
        a, b = self.a, self.b
        dx = b.pos.x - a.pos.x
        dy = b.pos.y - a.pos.y
        dist = (dx * dx + dy * dy) ** 0.5
        if dist < 1e-9:
            return
        ext = dist - self.rest_length
        if self.tension_only and ext <= 0.0:
            return  # slack string: no push, no damping
        nx, ny = dx / dist, dy / dist
        f = self._k_eff * ext
        if self._c_eff > 0.0:
            vrel = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny
            f += self._c_eff * vrel
        # positive f pulls the ends together
        a.acc.x += f * nx * a.inv_mass
        a.acc.y += f * ny * a.inv_mass
        b.acc.x -= f * nx * b.inv_mass
        b.acc.y -= f * ny * b.inv_mass

    def potential_energy(self) -> float:
        ext = self.a.pos.dist_to(self.b.pos) - self.rest_length
        if self.tension_only and ext <= 0.0:
            return 0.0
        return 0.5 * self.stiffness * ext * ext

    def to_dict(self) -> dict:
        return {"type": "spring", "id": self.id, "a": self.a.id, "b": self.b.id,
                "rest_length": self.rest_length, "stiffness": self.stiffness,
                "damping": self.damping, "tension_only": self.tension_only}


def link_from_dict(d: dict, bodies_by_id: dict[int, Body]):
    a, b = bodies_by_id[d["a"]], bodies_by_id[d["b"]]
    if d["type"] == "spring":
        link = SpringLink(a, b, d["rest_length"], d["stiffness"], d["damping"],
                          d.get("tension_only", False))
    else:
        link = DistanceLink(a, b, d["length"], d.get("is_rope", False),
                            d.get("compliance", 0.0))
    link.id = d["id"]
    cls = type(link)
    cls._next_id = max(cls._next_id, link.id + 1)
    return link
