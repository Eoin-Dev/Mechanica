"""Retained-mode widget toolkit for pygame.

Widgets are plain objects with absolute rects; panels lay them out by
stacking. Each widget implements handle(event, mouse) -> consumed and
draw(surface, mouse). A shared UIState tracks keyboard focus (one text
editor at a time) and the hovered tooltip.
"""
from __future__ import annotations

from typing import Callable

import pygame

from mechanica.ui import theme
from mechanica.ui.theme import blit_text, draw_icon


class UIState:
    """Shared UI context: keyboard focus and tooltip bookkeeping."""

    def __init__(self) -> None:
        self.focus: "TextEdit | None" = None
        self.tooltip: str = ""
        self.tooltip_timer: float = 0.0
        self._last_hover_key: object = None
        self._hovered_this_frame = False

    def set_focus(self, widget: "TextEdit | None") -> None:
        if self.focus is widget:
            return
        if self.focus is not None:
            self.focus.blur(commit=True)
        self.focus = widget

    def begin_frame(self) -> None:
        self._hovered_this_frame = False

    def note_hover(self, key: object, tooltip: str, dt: float) -> None:
        self._hovered_this_frame = True
        if key == self._last_hover_key:
            self.tooltip_timer += dt
        else:
            self._last_hover_key = key
            self.tooltip_timer = 0.0
        self.tooltip = tooltip if self.tooltip_timer > 0.45 else ""

    def end_frame(self, blocked: bool = False) -> None:
        """Drop the tooltip once the cursor leaves every widget (or a modal
        overlay covers the panels), so it can never stick around."""
        if blocked or not self._hovered_this_frame:
            self.tooltip = ""
            self.tooltip_timer = 0.0
            self._last_hover_key = None


class Widget:
    tooltip = ""

    def __init__(self, rect: pygame.Rect) -> None:
        self.rect = pygame.Rect(rect)
        self.visible = True
        self.enabled = True

    def hit(self, mouse) -> bool:
        return self.visible and self.rect.collidepoint(mouse)

    def handle(self, event: pygame.event.Event, mouse) -> bool:
        return False

    def draw(self, surface: pygame.Surface, mouse) -> None:
        pass


class Label(Widget):
    def __init__(self, rect, get_text: Callable[[], str] | str, size=13,
                 color=theme.TEXT, bold=False, align="midleft") -> None:
        super().__init__(rect)
        self.get_text = get_text if callable(get_text) else (lambda: get_text)
        self.size, self.color, self.bold, self.align = size, color, bold, align

    def draw(self, surface, mouse) -> None:
        anchor = getattr(self.rect, self.align)
        blit_text(surface, self.get_text(), anchor, self.size, self.color,
                  self.bold, self.align)


class Button(Widget):
    def __init__(self, rect, on_click: Callable[[], None], label: str = "",
                 icon: str = "", tooltip: str = "", style: str = "normal",
                 is_active: Callable[[], bool] | None = None,
                 is_enabled: Callable[[], bool] | None = None,
                 size: int = 13) -> None:
        super().__init__(rect)
        self.on_click = on_click
        self.label = label
        self.icon = icon
        self.tooltip = tooltip
        self.style = style      # normal | primary | ghost | danger
        self.is_active = is_active
        self.is_enabled = is_enabled
        self.size = size

    def handle(self, event, mouse) -> bool:
        if self.is_enabled and not self.is_enabled():
            return False
        if (event.type == pygame.MOUSEBUTTONDOWN and event.button == 1
                and self.hit(mouse)):
            self.on_click()
            return True
        return False

    def draw(self, surface, mouse) -> None:
        enabled = self.enabled and (self.is_enabled is None or self.is_enabled())
        active = self.is_active() if self.is_active else False
        hover = enabled and self.hit(mouse)
        if self.style == "primary" or active:
            bg = theme.ACCENT_HOT if hover else theme.ACCENT_DARK if not active \
                else theme.ACCENT
            fg = (250, 252, 255)
        elif self.style == "danger":
            bg = (150, 60, 60) if hover else theme.PANEL_LIGHT
            fg = theme.BAD if not hover else (255, 230, 230)
        elif self.style == "ghost":
            bg = theme.PANEL_HOVER if hover else None
            fg = theme.TEXT if hover else theme.TEXT_DIM
        else:
            bg = theme.PANEL_HOVER if hover else theme.PANEL_LIGHT
            fg = theme.TEXT
        if not enabled:
            fg = theme.TEXT_FAINT
            bg = theme.PANEL if bg else None
        if bg:
            pygame.draw.rect(surface, bg, self.rect, 0, theme.RADIUS)
        if self.icon:
            icon_rect = pygame.Rect(self.rect)
            if self.label:
                icon_rect.w = self.rect.h
            draw_icon(surface, self.icon, icon_rect, fg)
            if self.label:
                blit_text(surface, self.label,
                          (self.rect.x + self.rect.h - 2, self.rect.centery),
                          self.size, fg, False, "midleft")
        elif self.label:
            blit_text(surface, self.label, self.rect.center, self.size, fg,
                      False, "center")


class Checkbox(Widget):
    def __init__(self, rect, label: str, get: Callable[[], bool],
                 set_: Callable[[bool], None], tooltip: str = "") -> None:
        super().__init__(rect)
        self.label, self.get, self.set = label, get, set_
        self.tooltip = tooltip

    def handle(self, event, mouse) -> bool:
        if (event.type == pygame.MOUSEBUTTONDOWN and event.button == 1
                and self.hit(mouse)):
            self.set(not self.get())
            return True
        return False

    def draw(self, surface, mouse) -> None:
        box = pygame.Rect(self.rect.x, self.rect.centery - 8, 16, 16)
        checked = self.get()
        pygame.draw.rect(surface, theme.ACCENT if checked else theme.PANEL_LIGHT,
                         box, 0, 4)
        if not checked:
            pygame.draw.rect(surface, theme.OUTLINE, box, 1, 4)
        if checked:
            pygame.draw.lines(surface, (255, 255, 255), False,
                              [(box.x + 3, box.centery), (box.x + 7, box.bottom - 5),
                               (box.right - 3, box.y + 4)], 2)
        color = theme.TEXT if self.hit(mouse) else theme.TEXT_DIM
        blit_text(surface, self.label, (box.right + 8, self.rect.centery), 13,
                  color, False, "midleft")


class Segmented(Widget):
    """Row of mutually exclusive options."""

    def __init__(self, rect, options: list[str], get: Callable[[], str],
                 set_: Callable[[str], None], tooltip: str = "") -> None:
        super().__init__(rect)
        self.options, self.get, self.set = options, get, set_
        self.tooltip = tooltip

    def _seg_rect(self, i: int) -> pygame.Rect:
        w = self.rect.w / len(self.options)
        return pygame.Rect(int(self.rect.x + i * w), self.rect.y,
                           int(w) - 2, self.rect.h)

    def handle(self, event, mouse) -> bool:
        if (event.type == pygame.MOUSEBUTTONDOWN and event.button == 1
                and self.hit(mouse)):
            for i, opt in enumerate(self.options):
                if self._seg_rect(i).collidepoint(mouse):
                    self.set(opt)
                    return True
        return False

    def draw(self, surface, mouse) -> None:
        current = self.get()
        for i, opt in enumerate(self.options):
            r = self._seg_rect(i)
            selected = opt == current
            hover = r.collidepoint(mouse)
            bg = theme.ACCENT if selected else \
                theme.PANEL_HOVER if hover else theme.PANEL_LIGHT
            pygame.draw.rect(surface, bg, r, 0, 5)
            blit_text(surface, opt, r.center, 12,
                      (250, 252, 255) if selected else theme.TEXT_DIM,
                      selected, "center")


class TextEdit(Widget):
    """Single-line text editor. commit(text) -> bool decides acceptance.

    Full caret editing: arrows / Home / End move (Shift extends the
    selection), Ctrl+A selects all, Backspace/Delete remove the selection
    or one character, and typing replaces the selection. Focusing selects
    everything, so click-and-type replaces the whole value."""

    def __init__(self, rect, get: Callable[[], str],
                 commit: Callable[[str], bool], ui: UIState,
                 placeholder: str = "", numeric: bool = False,
                 align_right: bool = False) -> None:
        super().__init__(rect)
        self.get = get
        self.commit_fn = commit
        self.ui = ui
        self.placeholder = placeholder
        self.numeric = numeric
        self.align_right = align_right
        self.editing = False
        self.buffer = ""
        self.caret = 0
        self.sel: int | None = None   # selection anchor (None = no selection)
        self.error = False

    def begin_edit(self) -> None:
        self.editing = True
        self.buffer = self.get()
        self.caret = len(self.buffer)
        self.sel = 0 if self.buffer else None   # select all: type to replace
        self.error = False
        self.ui.set_focus(self)

    def blur(self, commit: bool = True) -> None:
        if self.editing and commit:
            self._try_commit()
        self.editing = False
        if self.ui.focus is self:
            self.ui.focus = None

    def _try_commit(self) -> None:
        ok = self.commit_fn(self.buffer)
        self.error = not ok

    # -- selection helpers
    def _sel_range(self) -> tuple[int, int] | None:
        if self.sel is None or self.sel == self.caret:
            return None
        return (min(self.sel, self.caret), max(self.sel, self.caret))

    def _delete_selection(self) -> bool:
        r = self._sel_range()
        if r is None:
            self.sel = None
            return False
        self.buffer = self.buffer[:r[0]] + self.buffer[r[1]:]
        self.caret = r[0]
        self.sel = None
        return True

    def _move_caret(self, target: int, shift: bool) -> None:
        target = max(0, min(len(self.buffer), target))
        if shift:
            if self.sel is None:
                self.sel = self.caret
        else:
            self.sel = None
        self.caret = target

    def _caret_from_x(self, mx: int) -> int:
        f = theme.font(12)
        best, best_d = 0, 1e9
        base = self.rect.x + 6
        for i in range(len(self.buffer) + 1):
            d = abs(base + f.size(self.buffer[:i])[0] - mx)
            if d < best_d:
                best, best_d = i, d
        return best

    def handle(self, event, mouse) -> bool:
        if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
            if self.hit(mouse):
                if not self.editing:
                    self.begin_edit()
                else:
                    self._move_caret(self._caret_from_x(mouse[0]), False)
                return True
            if self.editing:
                self.blur(commit=True)
            return False
        if not self.editing:
            return False
        if event.type == pygame.KEYDOWN:
            mods = pygame.key.get_mods()
            shift = bool(mods & pygame.KMOD_SHIFT)
            key = event.key
            if key in (pygame.K_RETURN, pygame.K_KP_ENTER):
                self._try_commit()
                if not self.error:
                    self.editing = False
                    self.ui.focus = None
                return True
            if key == pygame.K_ESCAPE:
                self.editing = False
                self.ui.focus = None
                return True
            if key == pygame.K_a and mods & pygame.KMOD_CTRL:
                self.sel = 0
                self.caret = len(self.buffer)
                return True
            if key == pygame.K_LEFT:
                r = self._sel_range()
                self._move_caret(r[0] if r and not shift else self.caret - 1,
                                 shift)
                return True
            if key == pygame.K_RIGHT:
                r = self._sel_range()
                self._move_caret(r[1] if r and not shift else self.caret + 1,
                                 shift)
                return True
            if key == pygame.K_HOME:
                self._move_caret(0, shift)
                return True
            if key == pygame.K_END:
                self._move_caret(len(self.buffer), shift)
                return True
            if key == pygame.K_BACKSPACE:
                if not self._delete_selection() and self.caret > 0:
                    self.buffer = (self.buffer[:self.caret - 1]
                                   + self.buffer[self.caret:])
                    self.caret -= 1
                self.error = False
                return True
            if key == pygame.K_DELETE:
                if not self._delete_selection() and self.caret < len(self.buffer):
                    self.buffer = (self.buffer[:self.caret]
                                   + self.buffer[self.caret + 1:])
                self.error = False
                return True
            ch = event.unicode
            if ch and ch.isprintable():
                if self.numeric and ch not in "0123456789.-+eE":
                    return True
                self._delete_selection()
                self.buffer = (self.buffer[:self.caret] + ch
                               + self.buffer[self.caret:])
                self.caret += 1
                self.error = False
                return True
        return False

    def draw(self, surface, mouse) -> None:
        bg = theme.PANEL_LIGHT if not self.editing else (28, 31, 37)
        pygame.draw.rect(surface, bg, self.rect, 0, 5)
        border = theme.BAD if self.error else \
            theme.ACCENT if self.editing else theme.OUTLINE
        pygame.draw.rect(surface, border, self.rect, 1, 5)
        f = theme.font(12)
        if not self.editing:
            shown = self.get()
            color = theme.TEXT
            if not shown and self.placeholder:
                shown, color = self.placeholder, theme.TEXT_FAINT
            while shown and f.size(shown)[0] > self.rect.w - 10:
                shown = shown[1:]
            anchor = "midright" if self.align_right else "midleft"
            pos = (self.rect.right - 6, self.rect.centery) \
                if self.align_right else (self.rect.x + 6, self.rect.centery)
            blit_text(surface, shown, pos, 12, color, False, anchor)
            return
        # editing: scroll the visible window so the caret stays in view
        buf = self.buffer
        start = 0
        while f.size(buf[start:self.caret])[0] > self.rect.w - 14:
            start += 1
        base_x = self.rect.x + 6
        clip = surface.get_clip()
        surface.set_clip(self.rect.inflate(-2, -2))
        r = self._sel_range()
        if r is not None:
            s0, s1 = max(r[0], start), max(r[1], start)
            x0 = base_x + f.size(buf[start:s0])[0]
            x1 = base_x + f.size(buf[start:s1])[0]
            pygame.draw.rect(surface, theme.ACCENT_DARK,
                             (x0, self.rect.y + 3, x1 - x0, self.rect.h - 6))
        blit_text(surface, buf[start:], (base_x, self.rect.centery), 12,
                  theme.TEXT, False, "midleft")
        if (pygame.time.get_ticks() // 500) % 2 == 0:
            cx = base_x + f.size(buf[start:self.caret])[0]
            pygame.draw.line(surface, theme.TEXT, (cx, self.rect.y + 4),
                             (cx, self.rect.bottom - 4))
        surface.set_clip(clip)


class Slider(Widget):
    """Labelled slider with live value and click-to-type numeric entry.

    get/set work in real units. `log` uses a logarithmic track. on_commit
    fires once when an interaction ends (used to push undo snapshots).
    """

    LABEL_W = 0.40
    VALUE_W = 62

    def __init__(self, rect, label: str, get: Callable[[], float],
                 set_: Callable[[float], None], lo: float, hi: float,
                 ui: UIState, unit: str = "", fmt: str = "{:.2f}",
                 log: bool = False, step: float | None = None,
                 on_commit: Callable[[], None] | None = None,
                 tooltip: str = "") -> None:
        super().__init__(rect)
        self.label, self.get, self.set = label, get, set_
        self.lo, self.hi, self.unit, self.fmt = lo, hi, unit, fmt
        self.log, self.step = log, step
        self.on_commit = on_commit
        self.tooltip = tooltip
        self.dragging = False
        self.edit = TextEdit(self._value_rect(), self._value_text,
                             self._commit_text, ui, numeric=True,
                             align_right=True)
        self.edit.visible = False

    def _value_rect(self) -> pygame.Rect:
        return pygame.Rect(self.rect.right - self.VALUE_W, self.rect.y,
                           self.VALUE_W, self.rect.h)

    def _track_rect(self) -> pygame.Rect:
        x0 = self.rect.x + int(self.rect.w * self.LABEL_W)
        return pygame.Rect(x0, self.rect.y,
                           self.rect.right - self.VALUE_W - 8 - x0, self.rect.h)

    def _value_text(self) -> str:
        v = self.get()
        return self.fmt.format(v)

    def _commit_text(self, s: str) -> bool:
        try:
            v = float(s)
        except ValueError:
            return False
        if v != v or v in (float("inf"), float("-inf")):   # NaN / infinity
            return False
        self.set(min(self.hi, max(self.lo, v)) if self.step is None else
                 round(min(self.hi, max(self.lo, v)) / self.step) * self.step)
        if self.on_commit:
            self.on_commit()
        return True

    def _frac_to_value(self, frac: float) -> float:
        frac = min(1.0, max(0.0, frac))
        if self.log and self.lo > 0:
            from math import log10
            lo_l, hi_l = log10(self.lo), log10(self.hi)
            v = 10 ** (lo_l + frac * (hi_l - lo_l))
        else:
            v = self.lo + frac * (self.hi - self.lo)
        if self.step:
            v = round(v / self.step) * self.step
        return min(self.hi, max(self.lo, v))

    def _value_to_frac(self, v: float) -> float:
        if self.log and self.lo > 0:
            from math import log10
            lo_l, hi_l = log10(self.lo), log10(self.hi)
            v = max(v, self.lo)
            return (log10(v) - lo_l) / (hi_l - lo_l) if hi_l != lo_l else 0
        return (v - self.lo) / (self.hi - self.lo) if self.hi != self.lo else 0

    def handle(self, event, mouse) -> bool:
        if self.edit.editing:
            return self.edit.handle(event, mouse)
        if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
            if self._value_rect().collidepoint(mouse):
                self.edit.rect = self._value_rect()
                self.edit.begin_edit()
                return True
            if self._track_rect().collidepoint(mouse):
                self.dragging = True
                self._drag_to(mouse[0])
                return True
        elif event.type == pygame.MOUSEMOTION and self.dragging:
            self._drag_to(mouse[0])
            return True
        elif event.type == pygame.MOUSEBUTTONUP and event.button == 1 and self.dragging:
            self.dragging = False
            if self.on_commit:
                self.on_commit()
            return True
        return False

    def _drag_to(self, mx: int) -> None:
        track = self._track_rect()
        frac = (mx - track.x) / max(1, track.w)
        self.set(self._frac_to_value(frac))

    def draw(self, surface, mouse) -> None:
        blit_text(surface, self.label, (self.rect.x, self.rect.centery), 12,
                  theme.TEXT_DIM, False, "midleft")
        track = self._track_rect()
        bar = pygame.Rect(track.x, track.centery - 2, track.w, 4)
        pygame.draw.rect(surface, theme.PANEL_LIGHT, bar, 0, 2)
        frac = min(1.0, max(0.0, self._value_to_frac(self.get())))
        fill = pygame.Rect(track.x, bar.y, int(track.w * frac), 4)
        pygame.draw.rect(surface, theme.ACCENT_DARK, fill, 0, 2)
        knob_x = track.x + int(track.w * frac)
        hover = track.collidepoint(mouse) or self.dragging
        pygame.draw.circle(surface, theme.ACCENT_HOT if hover else theme.ACCENT,
                           (knob_x, track.centery), 6 if hover else 5)
        if self.edit.editing:
            self.edit.draw(surface, mouse)
        else:
            vr = self._value_rect()
            if vr.collidepoint(mouse):
                pygame.draw.rect(surface, theme.PANEL_HOVER, vr, 0, 4)
            blit_text(surface, self._value_text() + (f" {self.unit}" if self.unit else ""),
                      (vr.right - 2, vr.centery), 12, theme.TEXT, False, "midright")


class SectionLabel(Widget):
    def __init__(self, rect, label: str) -> None:
        super().__init__(rect)
        self.label = label

    def draw(self, surface, mouse) -> None:
        blit_text(surface, self.label.upper(), (self.rect.x, self.rect.centery),
                  11, theme.TEXT_FAINT, True, "midleft")
        w = theme.font(11, True).size(self.label.upper())[0]
        pygame.draw.line(surface, theme.OUTLINE,
                         (self.rect.x + w + 8, self.rect.centery),
                         (self.rect.right, self.rect.centery))
