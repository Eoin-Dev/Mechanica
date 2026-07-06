"""Physical objects: dynamic circular bodies and static wall segments."""
from __future__ import annotations

from mechanica.core.vec import Vec2

# Material presets: (restitution, friction). Restitution combines with min(),
# friction with sqrt(mu_a * mu_b) at contact time.
MATERIALS: dict[str, tuple[float, float]] = {
    "Custom": (0.8, 0.4),
    "Rubber": (0.9, 0.9),
    "Steel": (0.75, 0.25),
    "Wood": (0.5, 0.45),
    "Ice": (0.3, 0.02),
    "Clay": (0.05, 0.6),
    "Superball": (1.0, 0.5),
}

BODY_PALETTE = [
    (86, 156, 214), (220, 130, 90), (120, 190, 120), (200, 110, 180),
    (230, 200, 90), (110, 200, 210), (170, 140, 230), (235, 120, 120),
    (140, 200, 160), (210, 160, 100),
]


class Body:
    """A dynamic disc with translational and rotational state.

    A body with locked=True behaves as infinite mass/inertia: it never moves
    but still participates in collisions and constraints (e.g. pendulum pivots).
    """

    __slots__ = (
        "id", "name", "pos", "vel", "angle", "omega", "mass", "radius",
        "restitution", "friction", "const_force", "locked", "color",
        "collides", "acc", "_acc0", "_prev", "_corr_x", "_corr_y",
    )

    _next_id = 1

    def __init__(self, pos: Vec2, radius: float = 0.15, mass: float = 1.0,
                 color: tuple[int, int, int] | None = None) -> None:
        self.id = Body._next_id
        Body._next_id += 1
        self.name = f"Body {self.id}"
        self.pos = pos
        self.vel = Vec2()
        self.angle = 0.0
        self.omega = 0.0            # rad/s
        self.mass = mass
        self.radius = radius
        self.restitution = 0.8
        self.friction = 0.4
        self.const_force = Vec2()   # user-applied constant force, N
        self.locked = False
        self.collides = True
        self.color = color or BODY_PALETTE[self.id % len(BODY_PALETTE)]
        # scratch state used by the solver
        self.acc = Vec2()
        self._acc0 = Vec2()
        self._prev = Vec2()
        self._corr_x = 0.0
        self._corr_y = 0.0

    # --- derived quantities ------------------------------------------------
    @property
    def inv_mass(self) -> float:
        return 0.0 if (self.locked or self.mass <= 0.0) else 1.0 / self.mass

    @property
    def inertia(self) -> float:
        """Moment of inertia of a uniform disc: I = mr^2/2."""
        return 0.5 * self.mass * self.radius * self.radius

    @property
    def inv_inertia(self) -> float:
        if self.locked or self.mass <= 0.0 or self.radius <= 0.0:
            return 0.0
        return 2.0 / (self.mass * self.radius * self.radius)

    def kinetic_energy(self) -> float:
        if self.locked:
            return 0.0
        return 0.5 * self.mass * self.vel.length2() + 0.5 * self.inertia * self.omega * self.omega

    # --- serialization -------------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name,
            "pos": [self.pos.x, self.pos.y], "vel": [self.vel.x, self.vel.y],
            "angle": self.angle, "omega": self.omega,
            "mass": self.mass, "radius": self.radius,
            "restitution": self.restitution, "friction": self.friction,
            "const_force": [self.const_force.x, self.const_force.y],
            "locked": self.locked, "collides": self.collides,
            "color": list(self.color),
        }

    @staticmethod
    def from_dict(d: dict) -> "Body":
        b = Body(Vec2(*d["pos"]), d["radius"], d["mass"], tuple(d["color"]))
        b.id = d["id"]
        Body._next_id = max(Body._next_id, b.id + 1)
        b.name = d.get("name", f"Body {b.id}")
        b.vel = Vec2(*d["vel"])
        b.angle = d.get("angle", 0.0)
        b.omega = d.get("omega", 0.0)
        b.restitution = d["restitution"]
        b.friction = d["friction"]
        b.const_force = Vec2(*d.get("const_force", (0, 0)))
        b.locked = d["locked"]
        b.collides = d.get("collides", True)
        return b


class Wall:
    """A static capsule segment (line with thickness) that bodies collide with."""

    __slots__ = ("id", "name", "a", "b", "thickness", "restitution", "friction", "color")

    _next_id = 1

    def __init__(self, a: Vec2, b: Vec2, thickness: float = 0.08) -> None:
        self.id = Wall._next_id
        Wall._next_id += 1
        self.name = f"Wall {self.id}"
        self.a = a
        self.b = b
        self.thickness = thickness
        self.restitution = 0.8
        self.friction = 0.5
        self.color = (150, 155, 165)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name,
            "a": [self.a.x, self.a.y], "b": [self.b.x, self.b.y],
            "thickness": self.thickness, "restitution": self.restitution,
            "friction": self.friction, "color": list(self.color),
        }

    @staticmethod
    def from_dict(d: dict) -> "Wall":
        w = Wall(Vec2(*d["a"]), Vec2(*d["b"]), d["thickness"])
        w.id = d["id"]
        Wall._next_id = max(Wall._next_id, w.id + 1)
        w.name = d.get("name", f"Wall {w.id}")
        w.restitution = d["restitution"]
        w.friction = d["friction"]
        w.color = tuple(d.get("color", (150, 155, 165)))
        return w
