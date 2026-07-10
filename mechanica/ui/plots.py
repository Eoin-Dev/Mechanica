"""Live plots: rolling time-series (energy, momentum) and phase-space plot."""
from __future__ import annotations

from collections import deque
from math import isfinite

import pygame

from mechanica.ui import theme
from mechanica.ui.theme import blit_text

SERIES_COLORS = [theme.ACCENT, theme.GOOD, theme.WARN, theme.BAD,
                 (170, 140, 230), (110, 200, 210)]


class TimeSeries:
    """Rolling window of named channels sampled against simulation time.

    Channels can be toggled on/off by clicking their legend entries; hidden
    channels are excluded from the autoscale so the visible ones fill the
    plot.
    """

    def __init__(self, channels: list[str], maxlen: int = 3000) -> None:
        self.channels = channels
        self.t: deque[float] = deque(maxlen=maxlen)
        self.data: dict[str, deque[float]] = {c: deque(maxlen=maxlen) for c in channels}
        self.hidden: set[str] = set()   # channels toggled off via the legend
        self._legend_hits: list[tuple[pygame.Rect, str]] = []
        self._view: tuple[float, float] | None = None   # smoothed y-range
        self._n_total = 0   # samples ever added: anchors the draw decimation

    def clear(self) -> None:
        self.t.clear()
        for d in self.data.values():
            d.clear()
        self._view = None
        self._n_total = 0

    def truncate(self, t: float) -> None:
        """Drop samples newer than time t (stepping the simulation back)."""
        while self.t and self.t[-1] > t + 1e-9:
            self.t.pop()
            self._n_total -= 1
            for d in self.data.values():
                if d:
                    d.pop()

    def add(self, t: float, values: dict[str, float]) -> None:
        # a single inf/NaN sample (a body mid-blow-up) would wreck the
        # autoscale for the whole rolling window: drop it instead
        if not isfinite(t) or any(not isfinite(v) for v in values.values()):
            return
        if self.t and t < self.t[-1]:
            self.clear()  # simulation was reset/rewound
        self.t.append(t)
        self._n_total += 1
        for c in self.channels:
            self.data[c].append(values.get(c, 0.0))

    def legend_click(self, pos) -> bool:
        """Toggle a channel's visibility when its legend entry is clicked."""
        for rect, c in self._legend_hits:
            if rect.collidepoint(pos):
                if c in self.hidden:
                    self.hidden.discard(c)
                else:
                    self.hidden.add(c)
                return True
        return False

    def _draw_legend(self, surface: pygame.Surface, rect: pygame.Rect) -> None:
        self._legend_hits = []
        lx = rect.right - 10
        for ci in range(len(self.channels) - 1, -1, -1):
            c = self.channels[ci]
            d = self.data[c]
            val = d[-1] if d else 0.0
            off = c in self.hidden
            lbl = f"{c}: {val:.3g}"
            w = theme.font(11).size(lbl)[0]
            lx -= w + 18
            col = SERIES_COLORS[ci % len(SERIES_COLORS)]
            pygame.draw.rect(surface, theme.TEXT_FAINT if off else col,
                             (lx, rect.y + 9, 10, 3))
            blit_text(surface, lbl, (lx + 14, rect.y + 4), 11,
                      theme.TEXT_FAINT if off else theme.TEXT_DIM)
            self._legend_hits.append(
                (pygame.Rect(lx - 4, rect.y + 2, w + 20, 16), c))

    def draw(self, surface: pygame.Surface, rect: pygame.Rect,
             title: str) -> None:
        pygame.draw.rect(surface, (28, 30, 36), rect, 0, 6)
        pygame.draw.rect(surface, theme.OUTLINE, rect, 1, 6)
        blit_text(surface, title, (rect.x + 10, rect.y + 4), 12, theme.TEXT_DIM, True)
        self._draw_legend(surface, rect)
        if len(self.t) < 2:
            blit_text(surface, "run the simulation to collect data",
                      rect.center, 12, theme.TEXT_FAINT, False, "center")
            return
        visible = [c for c in self.channels if c not in self.hidden]
        if not visible:
            blit_text(surface, "all channels hidden - click the legend to show one",
                      rect.center, 12, theme.TEXT_FAINT, False, "center")
            return
        plot = pygame.Rect(rect.x + 8, rect.y + 26, rect.w - 16, rect.h - 42)
        if plot.w < 20 or plot.h < 16:
            return
        ts = list(self.t)
        t0, t1 = ts[0], ts[-1]
        if t1 - t0 < 1e-9:
            return
        # deque indexing is O(distance from an end): snapshot to lists once
        data = {c: list(self.data[c]) for c in visible}
        lo = min(min(d) for d in data.values())
        hi = max(max(d) for d in data.values())
        if hi - lo < 1e-12:
            hi, lo = hi + 1, lo - 1
        pad = (hi - lo) * 0.08
        hi += pad
        lo -= pad

        # autoscale with hysteresis: grow instantly to fit new data, shrink
        # slowly - otherwise spiky data (e.g. wall-impact momentum jumps)
        # entering and leaving the rolling window rescales the whole plot
        # every frame, which reads as the graph vibrating
        if self._view is not None:
            vlo, vhi = self._view
            vlo = lo if lo < vlo else vlo + (lo - vlo) * 0.04
            vhi = hi if hi > vhi else vhi + (hi - vhi) * 0.04
            lo, hi = vlo, vhi
        self._view = (lo, hi)

        # horizontal gridlines with value labels (count adapts to height)
        n_seg = 2 if plot.h < 70 else 3 if plot.h < 130 else 4
        for i in range(n_seg + 1):
            frac = i / n_seg
            y = plot.bottom - frac * plot.h
            pygame.draw.line(surface, theme.GRID_MAJOR, (plot.x, y), (plot.right, y))
            # the topmost label sits below its line so it stays inside the plot
            blit_text(surface, f"{lo + frac * (hi - lo):.3g}",
                      (plot.x + 2, y + 1 if i == n_seg else y - 12), 10,
                      theme.TEXT_FAINT)

        # time axis labels along the bottom edge
        for frac, align in ((0.0, "topleft"), (0.5, "midtop"), (1.0, "topright")):
            tv = t0 + frac * (t1 - t0)
            blit_text(surface, f"{tv:.4g} s", (plot.x + frac * plot.w, plot.bottom + 2),
                      10, theme.TEXT_FAINT, False, align)

        # ~one sample per 2 px is visually lossless and halves the line work.
        # The decimation phase is anchored to the global sample counter, so
        # the same samples stay chosen as the window rolls - otherwise a
        # fast-oscillating channel shimmers/flickers at high sim speeds.
        step = max(1, (2 * len(ts)) // max(plot.w, 1))
        i0 = (-(self._n_total - len(ts))) % step
        # break the polyline across recording gaps (e.g. data kept from before
        # a rewind-safe clear) instead of drawing a bogus connecting segment
        gap = 8.0 * step * (t1 - t0) / max(len(ts) - 1, 1)
        x_scale = plot.w / (t1 - t0)
        y_scale = plot.h / (hi - lo)
        for c in visible:
            ci = self.channels.index(c)
            col = SERIES_COLORS[ci % len(SERIES_COLORS)]
            d = data[c]
            pts: list[tuple[float, float]] = []
            prev_t = None
            for i in range(i0, len(ts), step):
                ti = ts[i]
                if prev_t is not None and ti - prev_t > gap:
                    if len(pts) >= 2:
                        pygame.draw.aalines(surface, col, False, pts)
                    pts = []
                prev_t = ti
                pts.append((plot.x + (ti - t0) * x_scale,
                            plot.bottom - (d[i] - lo) * y_scale))
            if len(pts) >= 2:
                pygame.draw.aalines(surface, col, False, pts)


class PhasePlot:
    """Position-velocity trajectory of a selected body.

    Both axes are recorded; draw() plots one chosen pair (x-vx or y-vy) in
    a square area so the orbit's shape isn't stretched by the panel's
    aspect ratio.
    """

    def __init__(self, maxlen: int = 1500) -> None:
        self.points: deque[tuple[float, float, float, float]] = deque(maxlen=maxlen)

    def clear(self) -> None:
        self.points.clear()

    def add(self, x: float, vx: float, y: float, vy: float) -> None:
        if isfinite(x + vx + y + vy):
            self.points.append((x, vx, y, vy))

    def draw(self, surface: pygame.Surface, rect: pygame.Rect,
             title: str, axis: str = "x") -> None:
        pygame.draw.rect(surface, (28, 30, 36), rect, 0, 6)
        pygame.draw.rect(surface, theme.OUTLINE, rect, 1, 6)
        blit_text(surface, title, (rect.x + 10, rect.y + 4), 12, theme.TEXT_DIM, True)
        if len(self.points) < 2:
            blit_text(surface, "select a body and run",
                      rect.center, 12, theme.TEXT_FAINT, False, "center")
            return
        plot = rect.inflate(-20, -34)
        plot.y += 14
        samples = list(self.points)
        if axis == "y":
            xs = [p[2] for p in samples]
            ys = [p[3] for p in samples]
            xlabel, ylabel = "y (m)", "vy (m/s)"
        else:
            xs = [p[0] for p in samples]
            ys = [p[1] for p in samples]
            xlabel, ylabel = "x (m)", "vx (m/s)"
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

        pts = [to_px(x, y) for x, y in zip(xs, ys)]
        pygame.draw.aalines(surface, theme.ACCENT, False, pts)
        pygame.draw.circle(surface, theme.WARN, pts[-1], 3)
        blit_text(surface, xlabel, (plot.centerx, rect.bottom - 14), 10,
                  theme.TEXT_FAINT, False, "center")
        blit_text(surface, ylabel, (rect.x + 8, plot.y - 2), 10, theme.TEXT_FAINT)
