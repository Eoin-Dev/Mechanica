"""Live plots: rolling time-series (energy, momentum) and phase-space plot."""
from __future__ import annotations

from collections import deque

import pygame

from mechanica.ui import theme
from mechanica.ui.theme import blit_text

SERIES_COLORS = [theme.ACCENT, theme.GOOD, theme.WARN, theme.BAD,
                 (170, 140, 230), (110, 200, 210)]


class TimeSeries:
    """Rolling window of named channels sampled against simulation time."""

    def __init__(self, channels: list[str], maxlen: int = 900) -> None:
        self.channels = channels
        self.t: deque[float] = deque(maxlen=maxlen)
        self.data: dict[str, deque[float]] = {c: deque(maxlen=maxlen) for c in channels}

    def clear(self) -> None:
        self.t.clear()
        for d in self.data.values():
            d.clear()

    def add(self, t: float, values: dict[str, float]) -> None:
        if self.t and t < self.t[-1]:
            self.clear()  # simulation was reset/rewound
        self.t.append(t)
        for c in self.channels:
            self.data[c].append(values.get(c, 0.0))

    def draw(self, surface: pygame.Surface, rect: pygame.Rect, title: str,
             unit: str = "") -> None:
        pygame.draw.rect(surface, (28, 30, 36), rect, 0, 6)
        pygame.draw.rect(surface, theme.OUTLINE, rect, 1, 6)
        blit_text(surface, title, (rect.x + 10, rect.y + 4), 12, theme.TEXT_DIM, True)
        if len(self.t) < 2:
            blit_text(surface, "run the simulation to collect data",
                      rect.center, 12, theme.TEXT_FAINT, False, "center")
            return
        plot = rect.inflate(-16, -30)
        plot.y += 12
        ts = list(self.t)
        t0, t1 = ts[0], ts[-1]
        if t1 - t0 < 1e-9:
            return
        lo = min(min(d) for d in self.data.values() if d)
        hi = max(max(d) for d in self.data.values() if d)
        if hi - lo < 1e-12:
            hi, lo = hi + 1, lo - 1
        pad = (hi - lo) * 0.08
        hi += pad
        lo -= pad

        # horizontal gridlines with value labels
        for i in range(3):
            frac = i / 2
            y = plot.bottom - frac * plot.h
            pygame.draw.line(surface, theme.GRID_MAJOR, (plot.x, y), (plot.right, y))
            blit_text(surface, f"{lo + frac * (hi - lo):.3g}",
                      (plot.x + 2, y - 7), 10, theme.TEXT_FAINT)

        step = max(1, len(ts) // max(plot.w, 1))
        for ci, c in enumerate(self.channels):
            d = self.data[c]
            pts = []
            for i in range(0, len(ts), step):
                x = plot.x + (ts[i] - t0) / (t1 - t0) * plot.w
                y = plot.bottom - (d[i] - lo) / (hi - lo) * plot.h
                pts.append((x, y))
            if len(pts) >= 2:
                pygame.draw.aalines(surface, SERIES_COLORS[ci % len(SERIES_COLORS)],
                                    False, pts)
        # legend
        lx = rect.right - 10
        for ci in range(len(self.channels) - 1, -1, -1):
            c = self.channels[ci]
            val = self.data[c][-1] if self.data[c] else 0.0
            lbl = f"{c}: {val:.3g}{unit}"
            w = theme.font(11).size(lbl)[0]
            lx -= w + 18
            col = SERIES_COLORS[ci % len(SERIES_COLORS)]
            pygame.draw.rect(surface, col, (lx, rect.y + 9, 10, 3))
            blit_text(surface, lbl, (lx + 14, rect.y + 4), 11, theme.TEXT_DIM)


class PhasePlot:
    """Trajectory in a 2D state space (e.g. x vs vx of a selected body)."""

    def __init__(self, maxlen: int = 1500) -> None:
        self.points: deque[tuple[float, float]] = deque(maxlen=maxlen)

    def clear(self) -> None:
        self.points.clear()

    def add(self, x: float, y: float) -> None:
        self.points.append((x, y))

    def draw(self, surface: pygame.Surface, rect: pygame.Rect, title: str,
             xlabel: str, ylabel: str) -> None:
        pygame.draw.rect(surface, (28, 30, 36), rect, 0, 6)
        pygame.draw.rect(surface, theme.OUTLINE, rect, 1, 6)
        blit_text(surface, title, (rect.x + 10, rect.y + 4), 12, theme.TEXT_DIM, True)
        if len(self.points) < 2:
            blit_text(surface, "select a body and run to trace its phase orbit",
                      rect.center, 12, theme.TEXT_FAINT, False, "center")
            return
        plot = rect.inflate(-20, -34)
        plot.y += 14
        xs = [p[0] for p in self.points]
        ys = [p[1] for p in self.points]
        lo_x, hi_x = min(xs), max(xs)
        lo_y, hi_y = min(ys), max(ys)
        if hi_x - lo_x < 1e-9:
            lo_x, hi_x = lo_x - 1, hi_x + 1
        if hi_y - lo_y < 1e-9:
            lo_y, hi_y = lo_y - 1, hi_y + 1
        mx = (hi_x - lo_x) * 0.06
        my = (hi_y - lo_y) * 0.06
        lo_x, hi_x, lo_y, hi_y = lo_x - mx, hi_x + mx, lo_y - my, hi_y + my

        def to_px(px: float, py: float) -> tuple[float, float]:
            return (plot.x + (px - lo_x) / (hi_x - lo_x) * plot.w,
                    plot.bottom - (py - lo_y) / (hi_y - lo_y) * plot.h)

        # zero axes if inside range
        if lo_x < 0 < hi_x:
            x0 = to_px(0, 0)[0]
            pygame.draw.line(surface, theme.GRID_MAJOR, (x0, plot.y), (x0, plot.bottom))
        if lo_y < 0 < hi_y:
            y0 = to_px(0, 0)[1]
            pygame.draw.line(surface, theme.GRID_MAJOR, (plot.x, y0), (plot.right, y0))

        pts = [to_px(px, py) for px, py in self.points]
        pygame.draw.aalines(surface, theme.ACCENT, False, pts)
        pygame.draw.circle(surface, theme.WARN, pts[-1], 3)
        blit_text(surface, xlabel, (plot.centerx, rect.bottom - 14), 10,
                  theme.TEXT_FAINT, False, "center")
        blit_text(surface, ylabel, (rect.x + 8, plot.y - 2), 10, theme.TEXT_FAINT)
