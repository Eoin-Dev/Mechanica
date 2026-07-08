"""Canvas rendering: grid, bodies, walls, links and analysis overlays."""
from __future__ import annotations

from math import cos, sin

import pygame

try:
    import pygame.gfxdraw as _gfx
except ImportError:          # pragma: no cover - gfxdraw ships with pygame
    _gfx = None

from mechanica.core.vec import Vec2
from mechanica.engine.body import Body, Wall
from mechanica.engine.links import DistanceLink, SpringLink
from mechanica.engine.world import World
from mechanica.render.camera import Camera
from mechanica.ui import theme
from mechanica.ui.theme import blit_text

# world metres of arrow length per unit of the quantity, at vector scale 1
VEL_ARROW_SCALE = 0.15
ACC_ARROW_SCALE = 0.05
FORCE_ARROW_SCALE = 0.05

# gfxdraw uses 16-bit coordinates; stay well inside them
_GFX_LIMIT = 16000


class ViewSettings:
    """Toggleable overlays and display options."""

    def __init__(self) -> None:
        self.grid = True
        self.snap = False
        self.vel_vectors = False
        self.acc_vectors = False
        self.force_vectors = False
        self.trails = False
        self.com = False
        self.contacts = False
        self.spatial_grid = False
        self.labels = False
        self.vector_scale = 1.0
        self.trail_len = 350
        self.follow = False
        self.antialias = True


def fill_circle(surface: pygame.Surface, color, cx: float, cy: float,
                r: int, aa: bool) -> None:
    """Filled circle, antialiased when possible."""
    x, y = int(cx), int(cy)
    if (aa and _gfx is not None and 2 <= r < _GFX_LIMIT
            and -_GFX_LIMIT < x < _GFX_LIMIT and -_GFX_LIMIT < y < _GFX_LIMIT):
        _gfx.filled_circle(surface, x, y, r, color)
        _gfx.aacircle(surface, x, y, r, color)
    else:
        pygame.draw.circle(surface, color, (x, y), r)


def ring_circle(surface: pygame.Surface, color, cx: float, cy: float,
                r: int, width: int, aa: bool) -> None:
    """Circle outline with an antialiased outer rim when possible."""
    x, y = int(cx), int(cy)
    pygame.draw.circle(surface, color, (x, y), r, width)
    if (aa and _gfx is not None and 2 <= r < _GFX_LIMIT
            and -_GFX_LIMIT < x < _GFX_LIMIT and -_GFX_LIMIT < y < _GFX_LIMIT):
        _gfx.aacircle(surface, x, y, r, color)


def _nice_spacing(zoom: float) -> float:
    """Grid spacing in metres: 1/2/5*10^k such that spacing is 25-70 px."""
    target = 45.0 / zoom
    best, err = 1.0, float("inf")
    for exp in range(-5, 7):
        for mant in (1.0, 2.0, 5.0):
            c = mant * 10 ** exp
            e = abs(c - target)
            if e < err:
                best, err = c, e
    return best


def snap_step(zoom: float) -> float:
    return _nice_spacing(zoom) / 2.0


def draw_grid(surface: pygame.Surface, cam: Camera, area: pygame.Rect) -> None:
    spacing = _nice_spacing(cam.zoom)
    min_x, min_y, max_x, max_y = cam.visible_bounds()
    i0 = int(min_x // spacing)
    i1 = int(max_x // spacing) + 1
    j0 = int(min_y // spacing)
    j1 = int(max_y // spacing) + 1
    if (i1 - i0) + (j1 - j0) > 400:
        return
    for i in range(i0, i1 + 1):
        wx = i * spacing
        sx, _ = cam.to_screen_xy(wx, 0)
        major = i % 5 == 0
        color = theme.AXIS if i == 0 else theme.GRID_MAJOR if major else theme.GRID
        pygame.draw.line(surface, color, (sx, area.y), (sx, area.bottom))
    for j in range(j0, j1 + 1):
        wy = j * spacing
        _, sy = cam.to_screen_xy(0, wy)
        major = j % 5 == 0
        color = theme.AXIS if j == 0 else theme.GRID_MAJOR if major else theme.GRID
        pygame.draw.line(surface, color, (area.x, sy), (area.right, sy))


def draw_arrow(surface: pygame.Surface, start: tuple[float, float],
               end: tuple[float, float], color, width: int = 2) -> None:
    dx, dy = end[0] - start[0], end[1] - start[1]
    length2 = dx * dx + dy * dy
    if length2 < 16:
        return
    pygame.draw.line(surface, color, start, end, width)
    length = length2 ** 0.5
    ux, uy = dx / length, dy / length
    head = min(9.0, length * 0.4)
    px, py = -uy, ux
    pygame.draw.polygon(surface, color, [
        end,
        (end[0] - ux * head + px * head * 0.5, end[1] - uy * head + py * head * 0.5),
        (end[0] - ux * head - px * head * 0.5, end[1] - uy * head - py * head * 0.5)])


def _draw_spring(surface: pygame.Surface, a: tuple[float, float],
                 b: tuple[float, float], color, aa: bool = False,
                 rest_px: float = 0.0) -> None:
    """Zigzag coil between two anchor points.

    The coil count comes from the spring's rest length, so it stays constant
    while the spring works; the amplitude fattens under compression and
    thins under tension, like a real coil. Springs too short on screen to
    read as coils degrade to a plain line.
    """
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = (dx * dx + dy * dy) ** 0.5
    if length < 2.0:
        return
    if rest_px <= 0.0:
        rest_px = length
    if length < 7.0 or rest_px < 11.0:      # sub-coil scale: plain line
        pygame.draw.line(surface, color, a, b, 1 if length < 4 else 2)
        return
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    lead = min(9.0, length * 0.15, rest_px * 0.15)
    inner = length - 2.0 * lead
    coils = int(rest_px * 0.12)             # one coil per ~8 px at rest
    if coils < 2:
        coils = 2
    elif coils > 10:
        coils = 10
    ratio = rest_px / length                # >1 compressed, <1 stretched
    if ratio > 1.8:
        ratio = 1.8
    elif ratio < 0.45:
        ratio = 0.45
    amp = (2.2 + rest_px * 0.05) * ratio
    if amp > 9.0:
        amp = 9.0
    pts = [a, (a[0] + ux * lead, a[1] + uy * lead)]
    n = coils * 2
    for i in range(1, n):
        f = i / n
        off = amp if i % 2 else -amp
        pts.append((a[0] + ux * (lead + inner * f) + px * off,
                    a[1] + uy * (lead + inner * f) + py * off))
    pts.append((b[0] - ux * lead, b[1] - uy * lead))
    pts.append(b)
    if aa:
        pygame.draw.aalines(surface, color, False, pts)
    else:
        pygame.draw.lines(surface, color, False, pts, 2)


def draw_world(surface: pygame.Surface, cam: Camera, world: World,
               view: ViewSettings, selection: list, hover,
               trails: dict[int, list[tuple[float, float]]],
               area: pygame.Rect) -> None:
    min_x, min_y, max_x, max_y = cam.visible_bounds()

    # --- trails -------------------------------------------------------------
    if view.trails:
        for bid, pts in trails.items():
            if len(pts) < 2:
                continue
            body = world.body_by_id(bid)
            base = body.color if body else (120, 130, 140)
            screen_pts = [cam.to_screen_xy(px, py) for px, py in pts]
            n = len(screen_pts)
            seg = max(1, n // 24)
            for i in range(0, n - seg, seg):
                f = i / n
                col = (int(theme.BG[0] + (base[0] - theme.BG[0]) * f),
                       int(theme.BG[1] + (base[1] - theme.BG[1]) * f),
                       int(theme.BG[2] + (base[2] - theme.BG[2]) * f))
                pygame.draw.lines(surface, col, False,
                                  screen_pts[i:i + seg + 1], 1)

    # --- links ---------------------------------------------------------------
    # antialiased coils are pretty but pricey; past a few hundred springs
    # (dense soft bodies) plain polylines keep the frame rate up
    aa_springs = view.antialias and len(world.links) <= 300
    for link in world.links:
        pa = cam.to_screen(link.a.pos)
        pb = cam.to_screen(link.b.pos)
        selected = link in selection
        hovered = link is hover
        if isinstance(link, SpringLink):
            color = theme.SELECTION if selected else \
                (200, 205, 215) if hovered else (135, 142, 152)
            _draw_spring(surface, pa, pb, color, aa=aa_springs,
                         rest_px=link.rest_length * cam.zoom)
        else:
            if link.is_rope:
                color = theme.SELECTION if selected else \
                    (215, 190, 150) if hovered else (170, 150, 115)
                pygame.draw.line(surface, color, pa, pb, 2)
            else:
                color = theme.SELECTION if selected else \
                    (200, 205, 215) if hovered else (150, 156, 166)
                pygame.draw.line(surface, color, pa, pb, 3)

    # --- walls ----------------------------------------------------------------
    aa = view.antialias
    for wall in world.walls:
        pa = cam.to_screen(wall.a)
        pb = cam.to_screen(wall.b)
        w_px = max(2, int(wall.thickness * cam.zoom))
        selected = wall in selection
        color = theme.SELECTION if selected else \
            tuple(min(255, c + 30) for c in wall.color) if wall is hover else wall.color
        pygame.draw.line(surface, color, pa, pb, w_px)
        r = w_px // 2
        if r >= 1:
            fill_circle(surface, color, pa[0], pa[1], r, aa)
            fill_circle(surface, color, pb[0], pb[1], r, aa)
        if selected:  # endpoint handles for direct manipulation
            for p in (pa, pb):
                fill_circle(surface, (255, 255, 255), p[0], p[1], 5, aa)
                ring_circle(surface, theme.ACCENT, p[0], p[1], 5, 2, aa)

    # --- bodies ----------------------------------------------------------------
    for body in world.bodies:
        r = body.radius
        if (body.pos.x + r < min_x or body.pos.x - r > max_x
                or body.pos.y + r < min_y or body.pos.y - r > max_y):
            continue
        sx, sy = cam.to_screen(body.pos)
        pr = max(2, int(r * cam.zoom))
        color = body.color
        if body is hover and body not in selection:
            color = tuple(min(255, c + 35) for c in color)
        fill_circle(surface, color, sx, sy, pr, aa)
        edge = tuple(int(c * 0.55) for c in color)
        ring_circle(surface, edge, sx, sy, pr, max(1, pr // 9), aa)
        if pr >= 5 and not body.locked:
            # rotation marker so spin/rolling is visible
            ex = sx + cos(body.angle) * pr * 0.85
            ey = sy - sin(body.angle) * pr * 0.85
            pygame.draw.line(surface, edge, (sx, sy), (ex, ey),
                             max(1, pr // 8))
        if body.locked:
            fill_circle(surface, (230, 233, 240), sx, sy, max(2, pr // 3), aa)
            ring_circle(surface, (90, 95, 105), sx, sy, max(2, pr // 3), 1, aa)
        if body in selection:
            ring_circle(surface, theme.SELECTION, sx, sy, pr + 3, 2, aa)
        if view.labels and pr >= 3:
            blit_text(surface, body.name, (sx, sy - pr - 12), 11,
                      theme.TEXT_DIM, False, "center")

    # --- vectors ----------------------------------------------------------------
    scale = view.vector_scale
    if view.vel_vectors or view.acc_vectors or view.force_vectors:
        for body in world.bodies:
            if body.inv_mass == 0.0:
                continue
            sx, sy = cam.to_screen(body.pos)
            if not area.collidepoint(sx, sy):
                continue
            if view.vel_vectors:
                end = cam.to_screen_xy(body.pos.x + body.vel.x * VEL_ARROW_SCALE * scale,
                                       body.pos.y + body.vel.y * VEL_ARROW_SCALE * scale)
                draw_arrow(surface, (sx, sy), end, theme.VEL_COLOR)
            if view.acc_vectors:
                end = cam.to_screen_xy(body.pos.x + body.acc.x * ACC_ARROW_SCALE * scale,
                                       body.pos.y + body.acc.y * ACC_ARROW_SCALE * scale)
                draw_arrow(surface, (sx, sy), end, theme.ACC_COLOR)
            if view.force_vectors:
                fx = body.acc.x * body.mass
                fy = body.acc.y * body.mass
                end = cam.to_screen_xy(body.pos.x + fx * FORCE_ARROW_SCALE * scale,
                                       body.pos.y + fy * FORCE_ARROW_SCALE * scale)
                draw_arrow(surface, (sx, sy), end, theme.FORCE_COLOR)

    # --- contact normals ----------------------------------------------------------
    if view.contacts:
        for c in world.contacts:
            p = cam.to_screen_xy(c.px, c.py)
            q = cam.to_screen_xy(c.px + c.nx * 0.25, c.py + c.ny * 0.25)
            draw_arrow(surface, p, q, theme.WARN, 1)
            pygame.draw.circle(surface, theme.WARN, p, 2)

    # --- centre of mass -------------------------------------------------------------
    if view.com:
        com = world.centre_of_mass()
        if com is not None:
            sx, sy = cam.to_screen(com)
            pygame.draw.circle(surface, (255, 255, 255), (sx, sy), 7, 1)
            pygame.draw.line(surface, (255, 255, 255), (sx - 9, sy), (sx + 9, sy))
            pygame.draw.line(surface, (255, 255, 255), (sx, sy - 9), (sx, sy + 9))
            blit_text(surface, "COM", (sx + 10, sy + 6), 10, theme.TEXT_DIM)

    # --- spatial hash debug grid ------------------------------------------------------
    if view.spatial_grid and world.bodies:
        max_r = max(b.radius for b in world.bodies)
        cell = max(4.0 * max_r, 0.05)
        i0, i1 = int(min_x // cell), int(max_x // cell) + 1
        j0, j1 = int(min_y // cell), int(max_y // cell) + 1
        if (i1 - i0) + (j1 - j0) < 200:
            for i in range(i0, i1 + 1):
                sx, _ = cam.to_screen_xy(i * cell, 0)
                pygame.draw.line(surface, (70, 45, 45), (sx, area.y), (sx, area.bottom))
            for j in range(j0, j1 + 1):
                _, sy = cam.to_screen_xy(0, j * cell)
                pygame.draw.line(surface, (70, 45, 45), (area.x, sy), (area.right, sy))


def draw_velocity_handle(surface: pygame.Surface, cam: Camera, body: Body,
                         view: ViewSettings) -> pygame.Rect:
    """Draggable arrow-tip handle used to set a body's velocity directly."""
    s = VEL_ARROW_SCALE * view.vector_scale
    tip_world = Vec2(body.pos.x + body.vel.x * s, body.pos.y + body.vel.y * s)
    start = cam.to_screen(body.pos)
    tip = cam.to_screen(tip_world)
    draw_arrow(surface, start, tip, theme.VEL_COLOR, 2)
    handle = pygame.Rect(tip[0] - 6, tip[1] - 6, 12, 12)
    pygame.draw.rect(surface, theme.VEL_COLOR, handle, 0, 3)
    pygame.draw.rect(surface, (20, 40, 20), handle, 1, 3)
    return handle


def draw_scale_bar(surface: pygame.Surface, cam: Camera, area: pygame.Rect) -> None:
    length, label = cam.nice_scale_length()
    px = length * cam.zoom
    x1 = area.right - 24
    x0 = x1 - px
    y = area.bottom - 20
    pygame.draw.line(surface, theme.TEXT_DIM, (x0, y), (x1, y), 2)
    pygame.draw.line(surface, theme.TEXT_DIM, (x0, y - 4), (x0, y + 4), 2)
    pygame.draw.line(surface, theme.TEXT_DIM, (x1, y - 4), (x1, y + 4), 2)
    blit_text(surface, label, ((x0 + x1) / 2, y - 16), 11, theme.TEXT_DIM,
              False, "center")
