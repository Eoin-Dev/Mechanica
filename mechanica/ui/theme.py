"""Visual theme: palette, fonts, and vector icon drawing."""
from __future__ import annotations

import pygame

# ------------------------------------------------------------------ palette
BG = (24, 26, 31)
PANEL = (33, 36, 43)
PANEL_LIGHT = (43, 47, 56)
PANEL_HOVER = (52, 57, 68)
OUTLINE = (58, 63, 74)
ACCENT = (86, 156, 214)
ACCENT_HOT = (120, 180, 235)
ACCENT_DARK = (50, 90, 125)
TEXT = (226, 229, 234)
TEXT_DIM = (152, 158, 168)
TEXT_FAINT = (105, 111, 122)
GOOD = (120, 190, 120)
WARN = (230, 200, 90)
BAD = (230, 110, 110)
GRID = (33, 36, 42)
GRID_MAJOR = (44, 48, 56)
AXIS = (66, 72, 84)
SELECTION = (110, 180, 240)
VEL_COLOR = (120, 210, 130)
ACC_COLOR = (235, 170, 90)
FORCE_COLOR = (235, 110, 110)

RADIUS = 6  # default corner radius


# ------------------------------------------------------------------- fonts
_cache: dict[tuple, pygame.font.Font] = {}


def font(size: int = 13, bold: bool = False) -> pygame.font.Font:
    key = (size, bold)
    f = _cache.get(key)
    if f is None:
        f = pygame.font.SysFont("segoeui,dejavusans,arial", size, bold=bold)
        _cache[key] = f
    return f


_text_cache: dict[tuple, pygame.Surface] = {}


def text(s: str, size: int = 13, color=TEXT, bold: bool = False) -> pygame.Surface:
    key = (s, size, color, bold)
    surf = _text_cache.get(key)
    if surf is None:
        surf = font(size, bold).render(s, True, color)
        if len(_text_cache) > 3000:
            _text_cache.clear()
        _text_cache[key] = surf
    return surf


def blit_text(surface: pygame.Surface, s: str, pos, size=13, color=TEXT,
              bold=False, align="topleft") -> pygame.Rect:
    img = text(s, size, color, bold)
    rect = img.get_rect(**{align: pos})
    surface.blit(img, rect)
    return rect


def wrap_text(s: str, size: int, max_w: int) -> list[str]:
    f = font(size)
    words = s.split()
    lines: list[str] = []
    cur = ""
    for word in words:
        trial = f"{cur} {word}".strip()
        if f.size(trial)[0] <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


# ------------------------------------------------------------------- icons
def draw_icon(surface: pygame.Surface, name: str, rect: pygame.Rect,
              color=TEXT) -> None:
    """Draw a simple vector glyph centred in rect."""
    x, y, w, h = rect
    cx, cy = x + w / 2, y + h / 2
    s = min(w, h) * 0.32  # glyph half-size
    line = pygame.draw.line
    if name == "play":
        pygame.draw.polygon(surface, color,
                            [(cx - s * 0.7, cy - s), (cx - s * 0.7, cy + s),
                             (cx + s, cy)])
    elif name == "pause":
        pygame.draw.rect(surface, color, (cx - s * 0.9, cy - s, s * 0.6, 2 * s))
        pygame.draw.rect(surface, color, (cx + s * 0.3, cy - s, s * 0.6, 2 * s))
    elif name == "step":
        pygame.draw.polygon(surface, color,
                            [(cx - s, cy - s), (cx - s, cy + s), (cx + s * 0.4, cy)])
        pygame.draw.rect(surface, color, (cx + s * 0.6, cy - s, s * 0.4, 2 * s))
    elif name == "step_back":
        pygame.draw.polygon(surface, color,
                            [(cx + s, cy - s), (cx + s, cy + s), (cx - s * 0.4, cy)])
        pygame.draw.rect(surface, color, (cx - s, cy - s, s * 0.4, 2 * s))
    elif name == "reset":
        r = int(s)
        pygame.draw.arc(surface, color,
                        (cx - r, cy - r, 2 * r, 2 * r), 0.8, 5.6, 2)
        pygame.draw.polygon(surface, color,
                            [(cx + r * 1.15, cy - r * 0.65), (cx + r * 0.25, cy - r * 0.55),
                             (cx + r * 0.85, cy + r * 0.25)])
    elif name == "undo":
        line(surface, color, (cx + s, cy - s * 0.4), (cx - s * 0.4, cy - s * 0.4), 2)
        pygame.draw.polygon(surface, color,
                            [(cx - s, cy - s * 0.4), (cx - s * 0.2, cy - s),
                             (cx - s * 0.2, cy + s * 0.2)])
        line(surface, color, (cx - s * 0.3, cy + s * 0.7), (cx + s, cy + s * 0.7), 2)
    elif name == "redo":
        line(surface, color, (cx - s, cy - s * 0.4), (cx + s * 0.4, cy - s * 0.4), 2)
        pygame.draw.polygon(surface, color,
                            [(cx + s, cy - s * 0.4), (cx + s * 0.2, cy - s),
                             (cx + s * 0.2, cy + s * 0.2)])
        line(surface, color, (cx + s * 0.3, cy + s * 0.7), (cx - s, cy + s * 0.7), 2)
    elif name == "select":
        pygame.draw.polygon(surface, color,
                            [(cx - s * 0.8, cy - s), (cx - s * 0.8, cy + s * 0.8),
                             (cx - s * 0.25, cy + s * 0.3), (cx + s * 0.2, cy + s),
                             (cx + s * 0.55, cy + s * 0.8), (cx + s * 0.05, cy + s * 0.1),
                             (cx + s * 0.7, cy)])
    elif name == "pan":
        for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0)):
            line(surface, color, (cx, cy), (cx + dx * s, cy + dy * s), 2)
            tip = (cx + dx * s * 1.25, cy + dy * s * 1.25)
            px, py = (dy * s * 0.3, dx * s * 0.3)
            pygame.draw.polygon(surface, color,
                                [tip, (cx + dx * s * 0.7 + px, cy + dy * s * 0.7 + py),
                                 (cx + dx * s * 0.7 - px, cy + dy * s * 0.7 - py)])
    elif name == "body":
        pygame.draw.circle(surface, color, (cx, cy), s, 2)
        pygame.draw.circle(surface, color, (cx, cy), max(1, s * 0.25))
    elif name == "anchor":
        pygame.draw.circle(surface, color, (cx, cy - s * 0.3), s * 0.55, 2)
        line(surface, color, (cx, cy + s * 0.25), (cx, cy + s), 2)
        line(surface, color, (cx - s * 0.6, cy + s), (cx + s * 0.6, cy + s), 2)
    elif name == "wall":
        pygame.draw.line(surface, color, (cx - s, cy + s * 0.6), (cx + s, cy - s * 0.6), 4)
    elif name == "rod":
        line(surface, color, (cx - s * 0.7, cy + s * 0.7), (cx + s * 0.7, cy - s * 0.7), 2)
        pygame.draw.circle(surface, color, (cx - s * 0.8, cy + s * 0.8), s * 0.35)
        pygame.draw.circle(surface, color, (cx + s * 0.8, cy - s * 0.8), s * 0.35)
    elif name == "rope":
        pts = [(cx - s + i * s / 2, cy + s * 0.5 * ((-1) ** i) * (0.3 + 0.2 * i % 2))
               for i in range(5)]
        pygame.draw.lines(surface, color, False, pts, 2)
        pygame.draw.circle(surface, color, pts[0], s * 0.3)
        pygame.draw.circle(surface, color, pts[-1], s * 0.3)
    elif name == "spring":
        pts = [(cx - s, cy)]
        n = 6
        for i in range(1, n):
            pts.append((cx - s + 2 * s * i / n, cy + (s * 0.6 if i % 2 else -s * 0.6)))
        pts.append((cx + s, cy))
        pygame.draw.lines(surface, color, False, pts, 2)
    elif name == "eraser":
        line(surface, color, (cx - s, cy - s), (cx + s, cy + s), 3)
        line(surface, color, (cx - s, cy + s), (cx + s, cy - s), 3)
    elif name == "library":
        for i in range(2):
            for j in range(2):
                pygame.draw.rect(surface, color,
                                 (cx - s + i * (s + 2), cy - s + j * (s + 2),
                                  s - 1, s - 1), 0, 2)
    elif name == "help":
        blit_text(surface, "?", (cx, cy), int(s * 2.6), color, True, "center")
    elif name == "trash":
        pygame.draw.rect(surface, color, (cx - s * 0.7, cy - s * 0.5, s * 1.4, s * 1.5), 2)
        line(surface, color, (cx - s, cy - s * 0.5), (cx + s, cy - s * 0.5), 2)
        pygame.draw.rect(surface, color, (cx - s * 0.35, cy - s, s * 0.7, s * 0.35), 2)
    elif name == "plus":
        line(surface, color, (cx - s, cy), (cx + s, cy), 2)
        line(surface, color, (cx, cy - s), (cx, cy + s), 2)
    elif name == "close":
        line(surface, color, (cx - s * 0.8, cy - s * 0.8), (cx + s * 0.8, cy + s * 0.8), 2)
        line(surface, color, (cx - s * 0.8, cy + s * 0.8), (cx + s * 0.8, cy - s * 0.8), 2)
    elif name == "fit":
        # corner brackets: frame the scene once
        for sx_, sy_ in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            corner_x = cx + sx_ * s
            corner_y = cy + sy_ * s
            line(surface, color, (corner_x, corner_y),
                 (corner_x - sx_ * s * 0.7, corner_y), 2)
            line(surface, color, (corner_x, corner_y),
                 (corner_x, corner_y - sy_ * s * 0.7), 2)
    elif name == "autofit":
        # corner brackets around a dot: keep the scene framed continuously
        for sx_, sy_ in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            corner_x = cx + sx_ * s
            corner_y = cy + sy_ * s
            line(surface, color, (corner_x, corner_y),
                 (corner_x - sx_ * s * 0.7, corner_y), 2)
            line(surface, color, (corner_x, corner_y),
                 (corner_x, corner_y - sy_ * s * 0.7), 2)
        pygame.draw.circle(surface, color, (cx, cy), max(2, s * 0.3))
    elif name == "chev_left":
        pygame.draw.lines(surface, color, False,
                          [(cx + s * 0.5, cy - s), (cx - s * 0.5, cy),
                           (cx + s * 0.5, cy + s)], 2)
    elif name == "chev_right":
        pygame.draw.lines(surface, color, False,
                          [(cx - s * 0.5, cy - s), (cx + s * 0.5, cy),
                           (cx - s * 0.5, cy + s)], 2)
