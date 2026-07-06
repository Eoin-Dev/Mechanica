"""World <-> screen transform with pan and zoom-to-cursor."""
from __future__ import annotations

from mechanica.core.vec import Vec2

MIN_ZOOM = 2.0      # px per metre
MAX_ZOOM = 2000.0


class Camera:
    def __init__(self, screen_w: int, screen_h: int) -> None:
        self.centre = Vec2(0.0, 0.0)   # world point at the middle of the canvas
        self.zoom = 88.0               # px per metre
        self.screen_w = screen_w
        self.screen_h = screen_h

    def resize(self, w: int, h: int) -> None:
        self.screen_w = w
        self.screen_h = h

    def to_screen(self, p: Vec2) -> tuple[float, float]:
        return ((p.x - self.centre.x) * self.zoom + self.screen_w * 0.5,
                (self.centre.y - p.y) * self.zoom + self.screen_h * 0.5)

    def to_screen_xy(self, x: float, y: float) -> tuple[float, float]:
        return ((x - self.centre.x) * self.zoom + self.screen_w * 0.5,
                (self.centre.y - y) * self.zoom + self.screen_h * 0.5)

    def to_world(self, sx: float, sy: float) -> Vec2:
        return Vec2((sx - self.screen_w * 0.5) / self.zoom + self.centre.x,
                    self.centre.y - (sy - self.screen_h * 0.5) / self.zoom)

    def pan_pixels(self, dx: float, dy: float) -> None:
        self.centre.x -= dx / self.zoom
        self.centre.y += dy / self.zoom

    def zoom_at(self, sx: float, sy: float, factor: float) -> None:
        """Zoom keeping the world point under the cursor fixed."""
        before = self.to_world(sx, sy)
        self.zoom = min(MAX_ZOOM, max(MIN_ZOOM, self.zoom * factor))
        after = self.to_world(sx, sy)
        self.centre.x += before.x - after.x
        self.centre.y += before.y - after.y

    def visible_bounds(self) -> tuple[float, float, float, float]:
        half_w = self.screen_w * 0.5 / self.zoom
        half_h = self.screen_h * 0.5 / self.zoom
        return (self.centre.x - half_w, self.centre.y - half_h,
                self.centre.x + half_w, self.centre.y + half_h)

    def nice_scale_length(self) -> tuple[float, str]:
        """A round world length (1/2/5 * 10^k m) that spans 60-160 px."""
        target = 100.0 / self.zoom
        best = 1.0
        for exp in range(-4, 6):
            for mant in (1.0, 2.0, 5.0):
                candidate = mant * (10.0 ** exp)
                if abs(candidate - target) < abs(best - target):
                    best = candidate
        label = f"{best:g} m" if best >= 0.01 else f"{best * 1000:g} mm"
        return best, label
