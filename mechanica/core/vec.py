"""2D vector used throughout the engine.

Mutable with __slots__ for speed; arithmetic operators return new vectors,
*_ip methods mutate in place (used in hot loops to avoid allocation).
"""
from __future__ import annotations

from math import atan2, cos, sin, sqrt


class Vec2:
    __slots__ = ("x", "y")

    def __init__(self, x: float = 0.0, y: float = 0.0) -> None:
        self.x = float(x)
        self.y = float(y)

    # --- arithmetic (allocating) -------------------------------------------
    def __add__(self, o: "Vec2") -> "Vec2":
        return Vec2(self.x + o.x, self.y + o.y)

    def __sub__(self, o: "Vec2") -> "Vec2":
        return Vec2(self.x - o.x, self.y - o.y)

    def __mul__(self, s: float) -> "Vec2":
        return Vec2(self.x * s, self.y * s)

    __rmul__ = __mul__

    def __truediv__(self, s: float) -> "Vec2":
        return Vec2(self.x / s, self.y / s)

    def __neg__(self) -> "Vec2":
        return Vec2(-self.x, -self.y)

    def __repr__(self) -> str:
        return f"Vec2({self.x:.4g}, {self.y:.4g})"

    # --- in-place (non-allocating) -----------------------------------------
    def add_ip(self, o: "Vec2") -> "Vec2":
        self.x += o.x
        self.y += o.y
        return self

    def add_scaled_ip(self, o: "Vec2", s: float) -> "Vec2":
        self.x += o.x * s
        self.y += o.y * s
        return self

    def set(self, x: float, y: float) -> "Vec2":
        self.x = x
        self.y = y
        return self

    def set_vec(self, o: "Vec2") -> "Vec2":
        self.x = o.x
        self.y = o.y
        return self

    # --- products / measures -----------------------------------------------
    def dot(self, o: "Vec2") -> float:
        return self.x * o.x + self.y * o.y

    def cross(self, o: "Vec2") -> float:
        """z-component of the 3D cross product."""
        return self.x * o.y - self.y * o.x

    def length(self) -> float:
        return sqrt(self.x * self.x + self.y * self.y)

    def length2(self) -> float:
        return self.x * self.x + self.y * self.y

    def dist_to(self, o: "Vec2") -> float:
        dx = self.x - o.x
        dy = self.y - o.y
        return sqrt(dx * dx + dy * dy)

    def normalized(self) -> "Vec2":
        m = self.length()
        if m == 0.0:
            return Vec2(1.0, 0.0)
        return Vec2(self.x / m, self.y / m)

    def perp(self) -> "Vec2":
        """Counter-clockwise perpendicular."""
        return Vec2(-self.y, self.x)

    def rotated(self, angle: float) -> "Vec2":
        c, s = cos(angle), sin(angle)
        return Vec2(self.x * c - self.y * s, self.x * s + self.y * c)

    def angle(self) -> float:
        return atan2(self.y, self.x)

    def copy(self) -> "Vec2":
        return Vec2(self.x, self.y)

    def tuple(self) -> tuple[float, float]:
        return (self.x, self.y)
