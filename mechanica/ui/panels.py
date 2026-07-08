"""Application panels: toolbar, tool palette, inspector, graph dock,
library / help / tour overlays and the hint bar."""
from __future__ import annotations

from math import isfinite, pi

import pygame

from mechanica.engine.body import Body, MATERIALS, Wall
from mechanica.engine.links import DistanceLink, SpringLink
from mechanica.engine.world import Driver, ForceField, INTEGRATORS
from mechanica.interact.tools import TOOLS, TOOL_INFO
from mechanica.scene import snapshot as snap
from mechanica.scene.presets import CATEGORIES, PRESETS
from mechanica.ui import theme
from mechanica.ui.theme import blit_text, draw_icon, wrap_text
from mechanica.ui.widgets import (Button, Checkbox, Label, SectionLabel,
                                  Segmented, Slider, TextEdit, Widget)

TOOLBAR_H = 46
PALETTE_W = 52
INSPECTOR_W = 306
DOCK_H = 178
HINT_H = 24


class PanelBase:
    def __init__(self, app) -> None:
        self.app = app
        self.rect = pygame.Rect(0, 0, 0, 0)
        self.widgets: list[Widget] = []

    def handle_event(self, event, mouse) -> bool:
        for w in self.widgets:
            if w.visible and w.handle(event, mouse):
                return True
        if event.type == pygame.MOUSEBUTTONDOWN and self.rect.collidepoint(mouse):
            return True  # swallow clicks on panel background
        return False

    def draw_widgets(self, surface, mouse) -> None:
        for w in self.widgets:
            if w.visible:
                w.draw(surface, mouse)
                if w.tooltip and w.hit(mouse):
                    self.app.ui.note_hover(w, w.tooltip, self.app.dt_frame)


# ---------------------------------------------------------------- toolbar
class Toolbar(PanelBase):
    def relayout(self) -> None:
        app = self.app
        self.rect = pygame.Rect(0, 0, app.width, TOOLBAR_H)
        y, h = 8, 30
        self.widgets = []
        x = 14
        self.widgets.append(Label((x, 0, 120, TOOLBAR_H), "Mechanica", 17,
                                  theme.TEXT, True))
        x += 118
        self.widgets.append(Button((x, y, 64, h), app.toggle_play, "",
                                   icon="play", tooltip="Play / pause  (Space)",
                                   style="primary"))
        play_btn = self.widgets[-1]
        play_btn.is_active = lambda: app.playing
        self._play_btn = play_btn
        x += 70
        self.widgets.append(Button((x, y, 34, h), app.step_once, "", icon="step",
                                   tooltip="Advance one frame  (.)"))
        x += 40
        self.widgets.append(Button((x, y, 34, h), app.reset_sim, "", icon="reset",
                                   tooltip="Reset to the initial state  (Ctrl+R)"))
        x += 48
        self.widgets.append(Slider((x, y + 3, 190, 24), "Speed",
                                   lambda: app.speed,
                                   lambda v: setattr(app, "speed", v),
                                   0.01, 20.0, app.ui, "x", "{:.2f}", log=True,
                                   tooltip="Simulation speed multiplier "
                                           "(0.01x slow motion to 20x fast-forward)"))
        x += 200
        self.widgets.append(Label((x, 0, 30, TOOLBAR_H), "t =", 13, theme.TEXT_DIM))
        self._time_edit = TextEdit((x + 26, y + 3, 78, 24),
                                   lambda: f"{app.sim_time:.2f}",
                                   app.commit_time_jump, app.ui, numeric=True)
        self._time_edit.tooltip = "Simulation clock (s). Type a time to re-simulate to it."
        self.widgets.append(self._time_edit)
        x += 112
        self.widgets.append(Label((x, 0, 20, TOOLBAR_H), "s", 13, theme.TEXT_DIM))

        # right side
        rx = app.width - 12
        rx -= 60
        self._fps_label = Label((rx, 0, 56, TOOLBAR_H),
                                lambda: f"{app.fps_now:.0f} fps", 12,
                                theme.TEXT_FAINT, align="midright")
        self._fps_label.rect = pygame.Rect(rx, 0, 56, TOOLBAR_H)
        self.widgets.append(self._fps_label)
        rx -= 40
        self.widgets.append(Button((rx, y, 34, h), app.toggle_help, "", icon="help",
                                   tooltip="Help & shortcuts  (F1)"))
        rx -= 96
        self.widgets.append(Button((rx, y, 90, h), app.toggle_library, "Library",
                                   icon="library",
                                   tooltip="Example simulations and saved scenes  (L)"))
        rx -= 40
        self.widgets.append(Button((rx, y, 34, h), app.new_scene, "", icon="trash",
                                   tooltip="Clear the scene (undo-able)"))
        rx -= 78
        self.widgets.append(Button((rx, y, 34, h), app.undo, "", icon="undo",
                                   tooltip="Undo  (Ctrl+Z)",
                                   is_enabled=lambda: app.undo_stack.can_undo))
        self.widgets.append(Button((rx + 38, y, 34, h), app.redo, "", icon="redo",
                                   tooltip="Redo  (Ctrl+Y)",
                                   is_enabled=lambda: app.undo_stack.can_redo))

    def draw(self, surface, mouse) -> None:
        pygame.draw.rect(surface, theme.PANEL, self.rect)
        pygame.draw.line(surface, theme.OUTLINE, (0, self.rect.bottom - 1),
                         (self.rect.right, self.rect.bottom - 1))
        self._play_btn.icon = "pause" if self.app.playing else "play"
        self.draw_widgets(surface, mouse)


# ---------------------------------------------------------------- palette
class Palette(PanelBase):
    def relayout(self) -> None:
        app = self.app
        self.rect = pygame.Rect(0, TOOLBAR_H, PALETTE_W,
                                app.height - TOOLBAR_H - HINT_H)
        self.widgets = []
        y = self.rect.y + 10
        for tool in TOOLS:
            name, desc = TOOL_INFO[tool]
            btn = Button((8, y, 36, 36),
                         (lambda t=tool: app.canvas.set_tool(t)), "",
                         icon=tool, tooltip=f"{name} - {desc}", style="ghost",
                         is_active=(lambda t=tool: app.canvas.tool == t))
            self.widgets.append(btn)
            y += 42

    def draw(self, surface, mouse) -> None:
        pygame.draw.rect(surface, theme.PANEL, self.rect)
        pygame.draw.line(surface, theme.OUTLINE, (self.rect.right - 1, self.rect.y),
                         (self.rect.right - 1, self.rect.bottom))
        self.draw_widgets(surface, mouse)


# --------------------------------------------------------------- inspector
class Inspector(PanelBase):
    TABS = ["Selection", "World", "View"]

    def __init__(self, app) -> None:
        super().__init__(app)
        self.tab = "Selection"
        self.scroll = 0
        self.content_h = 0
        self.tabs: Segmented | None = None
        self._key: tuple = ()

    def _content_rect(self) -> pygame.Rect:
        return pygame.Rect(self.rect.x, self.rect.y + 44, self.rect.w,
                           max(0, self.rect.h - 44))

    def _widget_active(self, widget: Widget) -> bool:
        return (getattr(widget, "dragging", False)
                or getattr(widget, "editing", False)
                or getattr(getattr(widget, "edit", None), "editing", False))

    def _structure_key(self) -> tuple:
        app = self.app
        sel_ids = tuple(id(o) for o in app.selection)
        field_errors = tuple(f.error for f in app.world.fields)
        return (self.tab, sel_ids, len(app.world.fields), field_errors,
                len(app.world.drivers), self.scroll, app.width, app.height,
                app.graph_mode)

    def maybe_rebuild(self) -> None:
        key = self._structure_key()
        if key != self._key:
            self._key = key
            self.relayout()

    def handle_event(self, event, mouse) -> bool:
        if self.tabs and self.tabs.handle(event, mouse):
            return True
        content_rect = self._content_rect()
        if event.type == pygame.MOUSEWHEEL and content_rect.collidepoint(mouse):
            max_scroll = max(0, self.content_h - content_rect.h + 12)
            self.scroll = min(max_scroll, max(0, self.scroll - event.y * 40))
            return True
        route_active = event.type in (pygame.MOUSEMOTION, pygame.MOUSEBUTTONUP,
                                      pygame.KEYDOWN)
        if content_rect.collidepoint(mouse) or route_active:
            for w in self.widgets:
                if w is self.tabs or not w.visible:
                    continue
                if (content_rect.collidepoint(mouse) or self._widget_active(w)
                        or event.type == pygame.KEYDOWN):
                    if w.handle(event, mouse):
                        return True
        if event.type == pygame.MOUSEBUTTONDOWN and self.rect.collidepoint(mouse):
            return True
        return False

    # -- layout helpers
    def _row(self, h: int = 26) -> pygame.Rect:
        r = pygame.Rect(self.rect.x + 12, self._y, self.rect.w - 24, h)
        self._y += h + 4
        return r

    def _half_rows(self, h: int = 24) -> tuple[pygame.Rect, pygame.Rect]:
        full = self._row(h)
        w = (full.w - 6) // 2
        return (pygame.Rect(full.x, full.y, w, h),
                pygame.Rect(full.x + w + 6, full.y, w, h))

    def relayout(self) -> None:
        app = self.app
        self.rect = pygame.Rect(app.width - INSPECTOR_W, TOOLBAR_H, INSPECTOR_W,
                                app.height - TOOLBAR_H - HINT_H
                                - (DOCK_H if app.graph_mode != "Off" else 0))
        self.widgets = []
        tabs_rect = pygame.Rect(self.rect.x + 12, self.rect.y + 10,
                                self.rect.w - 24, 28)
        self.tabs = Segmented(tabs_rect, self.TABS, lambda: self.tab,
                              self._set_tab)
        self._y = self.rect.y + 48 - self.scroll
        if self.tab == "Selection":
            self._build_selection()
        elif self.tab == "World":
            self._build_world()
        else:
            self._build_view()
        self.widgets.append(self.tabs)
        self.content_h = self._y + self.scroll - (self.rect.y + 48)

    def _set_tab(self, t: str) -> None:
        self.tab = t
        self.scroll = 0

    # -- name helper
    def _name_edit(self, obj) -> None:
        row = self._row(24)
        self.widgets.append(Label((row.x, row.y, 44, row.h), "Name", 12,
                                  theme.TEXT_DIM))

        def commit(s: str) -> bool:
            s = s.strip()
            if not s:
                return False
            obj.name = s
            self.app.push_undo()
            return True

        te = TextEdit((row.x + 48, row.y, row.w - 48, row.h),
                      lambda: obj.name, commit, self.app.ui)
        te.tooltip = "Rename this object (shown with 'Body labels' in View)"
        self.widgets.append(te)

    # -- numeric helper
    def _num_edit(self, rect, label: str, get, set_, unit: str = "") -> None:
        self.widgets.append(Label((rect.x, rect.y, 44, rect.h), label, 12,
                                  theme.TEXT_DIM))
        lw = theme.font(12).size(label)[0] + 6

        def commit(s: str, set_=set_) -> bool:
            try:
                v = float(s)
            except ValueError:
                return False
            if not isfinite(v) or abs(v) > 1e9:
                return False
            set_(v)
            self.app.push_undo()
            return True

        te = TextEdit((rect.x + lw, rect.y, rect.w - lw - (18 if unit else 0),
                       rect.h), lambda: f"{get():.4g}", commit, self.app.ui,
                      numeric=True, align_right=True)
        self.widgets.append(te)
        if unit:
            self.widgets.append(Label((rect.right - 16, rect.y, 16, rect.h),
                                      unit, 11, theme.TEXT_FAINT))

    # ---------------------------------------------------------- selection tab
    def _build_selection(self) -> None:
        app = self.app
        sel = app.selection
        if not sel:
            for line in ["Nothing selected.", "",
                         "Click an object with the Select tool,",
                         "or drag a box around several objects.",
                         "Shift-click adds to the selection."]:
                self.widgets.append(Label(self._row(18), line, 12, theme.TEXT_DIM))
            self.widgets.append(SectionLabel(self._row(22), "Box select picks up"))
            for key, label in (("bodies", "Bodies / particles"),
                               ("walls", "Walls"),
                               ("springs", "Springs"),
                               ("rods", "Rods & ropes")):
                self.widgets.append(Checkbox(
                    self._row(22), label,
                    (lambda k=key: app.box_filter[k]),
                    (lambda v, k=key: app.box_filter.__setitem__(k, v)),
                    "Object types included when you drag a selection box"))
            return
        if len(sel) == 1 and isinstance(sel[0], Body):
            self._build_single_body(sel[0])
        elif len(sel) == 1 and isinstance(sel[0], Wall):
            self._build_wall(sel[0])
        elif len(sel) == 1:
            self._build_link(sel[0])
        else:
            self._build_multi(sel)

    def _commit(self) -> None:
        self.app.push_undo()

    def _build_single_body(self, b: Body) -> None:
        app = self.app
        self._name_edit(b)
        u = app.ui
        self.widgets.append(Slider(self._row(), "Mass", lambda: b.mass,
                                   lambda v: setattr(b, "mass", v),
                                   0.001, 10000.0,
                                   u, "kg", "{:.3g}", log=True,
                                   on_commit=self._commit))
        self.widgets.append(Slider(self._row(), "Radius", lambda: b.radius,
                                   lambda v: setattr(b, "radius", v), 0.01, 10.0,
                                   u, "m", "{:.3g}", log=True,
                                   on_commit=self._commit))
        r1, r2 = self._half_rows()
        self._num_edit(r1, "x", lambda: b.pos.x, lambda v: setattr(b.pos, "x", v), "m")
        self._num_edit(r2, "y", lambda: b.pos.y, lambda v: setattr(b.pos, "y", v), "m")
        r1, r2 = self._half_rows()
        self._num_edit(r1, "vx", lambda: b.vel.x, lambda v: setattr(b.vel, "x", v))
        self._num_edit(r2, "vy", lambda: b.vel.y, lambda v: setattr(b.vel, "y", v))
        self.widgets.append(Slider(self._row(), "Spin", lambda: b.omega,
                                   lambda v: setattr(b, "omega", v), -100.0, 100.0,
                                   u, "rad/s", "{:.2f}", on_commit=self._commit))
        r1, r2 = self._half_rows()
        chk1 = Checkbox(r1, "Locked", lambda: b.locked,
                        lambda v: (setattr(b, "locked", v), self._commit()),
                        "A locked body never moves: use as pivot or anchor")
        chk2 = Checkbox(r2, "Collides", lambda: b.collides,
                        lambda v: (setattr(b, "collides", v), self._commit()),
                        "Disable to let this body pass through others")
        self.widgets.extend((chk1, chk2))

        self.widgets.append(SectionLabel(self._row(20), "Material"))
        self.widgets.append(Slider(self._row(), "Bounce", lambda: b.restitution,
                                   lambda v: setattr(b, "restitution", v),
                                   0.0, 1.0, u, "", "{:.2f}",
                                   on_commit=self._commit,
                                   tooltip="Restitution: fraction of speed kept per bounce"))
        self.widgets.append(Slider(self._row(), "Friction", lambda: b.friction,
                                   lambda v: setattr(b, "friction", v),
                                   0.0, 3.0, u, "", "{:.2f}",
                                   on_commit=self._commit))
        names = [n for n in MATERIALS if n != "Custom"]
        per_row = 3
        for i in range(0, len(names), per_row):
            row = self._row(22)
            w = (row.w - 8) // per_row
            for j, name in enumerate(names[i:i + per_row]):
                e, mu = MATERIALS[name]
                self.widgets.append(Button(
                    (row.x + j * (w + 4), row.y, w, 22),
                    (lambda e=e, mu=mu: (setattr(b, "restitution", e),
                                         setattr(b, "friction", mu),
                                         self._commit())),
                    name, size=11,
                    tooltip=f"bounce {e}, friction {mu}"))

        self.widgets.append(SectionLabel(self._row(20), "Constant force"))
        r1, r2 = self._half_rows()
        self._num_edit(r1, "Fx", lambda: b.const_force.x,
                       lambda v: setattr(b.const_force, "x", v), "N")
        self._num_edit(r2, "Fy", lambda: b.const_force.y,
                       lambda v: setattr(b.const_force, "y", v), "N")

        drv = next((d for d in app.world.drivers if d.body_id == b.id), None)
        self.widgets.append(SectionLabel(self._row(20), "Driving force"))
        if drv is None:
            self.widgets.append(Button(self._row(24), lambda: self._add_driver(b),
                                       "Add sinusoidal driver", icon="plus", size=12,
                                       tooltip="Apply F = A sin(2 pi f t) to this body"))
        else:
            self.widgets.append(Slider(self._row(), "Amplitude",
                                       lambda: drv.amplitude,
                                       lambda v: setattr(drv, "amplitude", v),
                                       0.0, 500.0, u, "N", "{:.2f}",
                                       on_commit=self._commit))
            self.widgets.append(Slider(self._row(), "Frequency",
                                       lambda: drv.frequency,
                                       lambda v: setattr(drv, "frequency", v),
                                       0.001, 100.0, u, "Hz", "{:.3g}", log=True,
                                       on_commit=self._commit))
            self.widgets.append(Slider(self._row(), "Direction",
                                       lambda: drv.angle * 180 / pi,
                                       lambda v: setattr(drv, "angle", v * pi / 180),
                                       -180.0, 180.0, u, "deg", "{:.0f}",
                                       on_commit=self._commit))
            self.widgets.append(Button(self._row(24),
                                       lambda: self._remove_driver(drv),
                                       "Remove driver", icon="trash",
                                       style="danger", size=12))

        self._action_buttons()

    def _add_driver(self, b: Body) -> None:
        self.app.world.drivers.append(Driver(b.id))
        self.app.push_undo()

    def _remove_driver(self, drv: Driver) -> None:
        self.app.world.drivers.remove(drv)
        self.app.push_undo()

    def _build_multi(self, sel: list) -> None:
        """Bulk editor for a mixed selection: every type present gets its own
        section, and each control writes to all selected objects of that type."""
        app = self.app
        u = app.ui
        bodies = [o for o in sel if isinstance(o, Body)]
        walls = [o for o in sel if isinstance(o, Wall)]
        springs = [o for o in sel if isinstance(o, SpringLink)]
        rods = [o for o in sel if isinstance(o, DistanceLink)]
        summary = ", ".join(
            f"{len(group)} {plural if len(group) != 1 else singular}"
            for group, singular, plural in (
                (bodies, "body", "bodies"), (walls, "wall", "walls"),
                (springs, "spring", "springs"), (rods, "rod/rope", "rods/ropes"))
            if group)
        self.widgets.append(Label(self._row(22), summary + " selected", 13,
                                  theme.TEXT, True))

        def set_all(objs, attr):
            def s(v):
                for o in objs:
                    setattr(o, attr, v)
            return s

        if bodies:
            first = bodies[0]
            self.widgets.append(SectionLabel(self._row(20),
                                             f"Bodies ({len(bodies)})"))
            self.widgets.append(Slider(self._row(), "Mass", lambda: first.mass,
                                       set_all(bodies, "mass"), 0.001, 10000.0,
                                       u, "kg", "{:.3g}", log=True,
                                       on_commit=self._commit))
            self.widgets.append(Slider(self._row(), "Radius",
                                       lambda: first.radius,
                                       set_all(bodies, "radius"), 0.01, 10.0,
                                       u, "m", "{:.3g}", log=True,
                                       on_commit=self._commit))
            self.widgets.append(Slider(self._row(), "Bounce",
                                       lambda: first.restitution,
                                       set_all(bodies, "restitution"),
                                       0.0, 1.0, u, "", "{:.2f}",
                                       on_commit=self._commit))
            self.widgets.append(Slider(self._row(), "Friction",
                                       lambda: first.friction,
                                       set_all(bodies, "friction"), 0.0, 3.0,
                                       u, "", "{:.2f}", on_commit=self._commit))
            if len(bodies) >= 2:
                self.widgets.append(SectionLabel(self._row(20), "Align"))
                r = self._row(24)
                w = (r.w - 12) // 4
                for i, (label, fn) in enumerate([
                        ("|x", lambda: self._align(bodies, "x")),
                        ("y-", lambda: self._align(bodies, "y")),
                        ("<->", lambda: self._distribute(bodies, "x")),
                        ("^v", lambda: self._distribute(bodies, "y"))]):
                    tip = ["Align to the same x", "Align to the same y",
                           "Space evenly in x", "Space evenly in y"][i]
                    self.widgets.append(Button((r.x + i * (w + 4), r.y, w, 24),
                                               fn, label, size=12, tooltip=tip))

        if walls:
            wfirst = walls[0]
            self.widgets.append(SectionLabel(self._row(20),
                                             f"Walls ({len(walls)})"))
            self.widgets.append(Slider(self._row(), "Thickness",
                                       lambda: wfirst.thickness,
                                       set_all(walls, "thickness"), 0.01, 2.0,
                                       u, "m", "{:.2f}", log=True,
                                       on_commit=self._commit))
            self.widgets.append(Slider(self._row(), "Bounce",
                                       lambda: wfirst.restitution,
                                       set_all(walls, "restitution"), 0.0, 1.0,
                                       u, "", "{:.2f}", on_commit=self._commit))
            self.widgets.append(Slider(self._row(), "Friction",
                                       lambda: wfirst.friction,
                                       set_all(walls, "friction"), 0.0, 3.0,
                                       u, "", "{:.2f}", on_commit=self._commit))

        if springs:
            sfirst = springs[0]
            self.widgets.append(SectionLabel(self._row(20),
                                             f"Springs ({len(springs)})"))
            self.widgets.append(Slider(self._row(), "Stiffness",
                                       lambda: sfirst.stiffness,
                                       set_all(springs, "stiffness"),
                                       0.01, 100000.0, u, "N/m", "{:.3g}",
                                       log=True, on_commit=self._commit,
                                       tooltip="Applied to every selected spring"))
            self.widgets.append(Slider(self._row(), "Damping",
                                       lambda: sfirst.damping,
                                       set_all(springs, "damping"), 0.0, 500.0,
                                       u, "Ns/m", "{:.2f}",
                                       on_commit=self._commit,
                                       tooltip="Applied to every selected spring"))

        if rods:
            rfirst = rods[0]
            self.widgets.append(SectionLabel(self._row(20),
                                             f"Rods & ropes ({len(rods)})"))
            self.widgets.append(Checkbox(self._row(24), "Behave as rope (no push)",
                                         lambda: rfirst.is_rope,
                                         lambda v: (set_all(rods, "is_rope")(v),
                                                    self._commit())))

        self._action_buttons()

    def _align(self, bodies: list[Body], axis: str) -> None:
        avg = sum(getattr(b.pos, axis) for b in bodies) / len(bodies)
        for b in bodies:
            setattr(b.pos, axis, avg)
        self.app.push_undo()

    def _distribute(self, bodies: list[Body], axis: str) -> None:
        if len(bodies) < 3:
            return
        ordered = sorted(bodies, key=lambda b: getattr(b.pos, axis))
        lo = getattr(ordered[0].pos, axis)
        hi = getattr(ordered[-1].pos, axis)
        for i, b in enumerate(ordered):
            setattr(b.pos, axis, lo + (hi - lo) * i / (len(ordered) - 1))
        self.app.push_undo()

    def _build_wall(self, w: Wall) -> None:
        app = self.app
        u = app.ui
        self._name_edit(w)
        r1, r2 = self._half_rows()
        self._num_edit(r1, "x1", lambda: w.a.x, lambda v: setattr(w.a, "x", v), "m")
        self._num_edit(r2, "y1", lambda: w.a.y, lambda v: setattr(w.a, "y", v), "m")
        r1, r2 = self._half_rows()
        self._num_edit(r1, "x2", lambda: w.b.x, lambda v: setattr(w.b, "x", v), "m")
        self._num_edit(r2, "y2", lambda: w.b.y, lambda v: setattr(w.b, "y", v), "m")
        self.widgets.append(Slider(self._row(), "Thickness", lambda: w.thickness,
                                   lambda v: setattr(w, "thickness", v),
                                   0.01, 2.0, u, "m", "{:.2f}", log=True,
                                   on_commit=self._commit))
        self.widgets.append(Slider(self._row(), "Bounce", lambda: w.restitution,
                                   lambda v: setattr(w, "restitution", v),
                                   0.0, 1.0, u, "", "{:.2f}", on_commit=self._commit))
        self.widgets.append(Slider(self._row(), "Friction", lambda: w.friction,
                                   lambda v: setattr(w, "friction", v),
                                   0.0, 3.0, u, "", "{:.2f}", on_commit=self._commit))
        self._action_buttons()

    def _build_link(self, link) -> None:
        app = self.app
        u = app.ui
        if isinstance(link, SpringLink):
            self.widgets.append(Label(self._row(22), "Spring", 14, theme.TEXT, True))
            self.widgets.append(Slider(self._row(), "Rest len",
                                       lambda: link.rest_length,
                                       lambda v: setattr(link, "rest_length", v),
                                       0.01, 50.0, u, "m", "{:.3g}", log=True,
                                       on_commit=self._commit))
            self.widgets.append(Slider(self._row(), "Stiffness",
                                       lambda: link.stiffness,
                                       lambda v: setattr(link, "stiffness", v),
                                       0.01, 100000.0, u, "N/m", "{:.3g}", log=True,
                                       on_commit=self._commit))
            self.widgets.append(Slider(self._row(), "Damping",
                                       lambda: link.damping,
                                       lambda v: setattr(link, "damping", v),
                                       0.0, 500.0, u, "Ns/m", "{:.2f}",
                                       on_commit=self._commit))
        elif isinstance(link, DistanceLink):
            title = "Rope" if link.is_rope else "Rod"
            self.widgets.append(Label(self._row(22), title, 14, theme.TEXT, True))
            self.widgets.append(Slider(self._row(), "Length", lambda: link.length,
                                       lambda v: setattr(link, "length", v),
                                       0.01, 100.0, u, "m", "{:.3g}", log=True,
                                       on_commit=self._commit))
            self.widgets.append(Checkbox(self._row(24), "Behave as rope (no push)",
                                         lambda: link.is_rope,
                                         lambda v: (setattr(link, "is_rope", v),
                                                    self._commit())))
        self.widgets.append(Button(self._row(26), app.canvas.delete_selection,
                                   "Delete", icon="trash", style="danger", size=12))

    def _action_buttons(self) -> None:
        app = self.app
        self.widgets.append(SectionLabel(self._row(20), "Actions"))
        r1, r2 = self._half_rows(26)
        self.widgets.append(Button(r1, app.canvas.duplicate_selection,
                                   "Duplicate", size=12,
                                   tooltip="Copy the selection (Ctrl+D)"))
        self.widgets.append(Button(r2, app.canvas.delete_selection, "Delete",
                                   style="danger", size=12,
                                   tooltip="Remove the selection (Del)"))
        r1, r2 = self._half_rows(26)
        self.widgets.append(Button(r1, app.copy_props, "Copy props", size=12,
                                   tooltip="Copy material and physical properties (Ctrl+C)"))
        self.widgets.append(Button(r2, app.paste_props, "Paste props", size=12,
                                   is_enabled=lambda: app.clipboard_props is not None,
                                   tooltip="Apply copied properties to the selection (Ctrl+V)"))

    # ------------------------------------------------------------- world tab
    def _build_world(self) -> None:
        app = self.app
        world = app.world
        u = app.ui
        self.widgets.append(SectionLabel(self._row(20), "Gravity"))
        self.widgets.append(Slider(self._row(), "g", lambda: world.gravity,
                                   lambda v: setattr(world, "gravity", v),
                                   -100.0, 100.0, u, "m/s²", "{:.2f}",
                                   on_commit=self._commit,
                                   tooltip="Uniform downward gravity. 9.81 = Earth, "
                                           "24.8 = Jupiter, 0 = space, negative = upward"))
        self.widgets.append(Checkbox(self._row(24), "Bodies attract each other",
                                     lambda: world.mutual_gravity,
                                     lambda v: (setattr(world, "mutual_gravity", v),
                                                self._commit()),
                                     "Newtonian N-body gravity for orbital mechanics"))
        if world.mutual_gravity:
            self.widgets.append(Slider(self._row(), "G", lambda: world.G,
                                       lambda v: setattr(world, "G", v),
                                       0.0001, 100000.0, u, "", "{:.3g}", log=True,
                                       on_commit=self._commit,
                                       tooltip="Gravitational constant (scaled units)"))
            self.widgets.append(Slider(self._row(), "Softening",
                                       lambda: world.softening,
                                       lambda v: setattr(world, "softening", v),
                                       0.0001, 2.0, u, "m", "{:.3g}", log=True,
                                       on_commit=self._commit,
                                       tooltip="Smooths the force at tiny separations"))

        self.widgets.append(SectionLabel(self._row(20), "Air & damping"))
        self.widgets.append(Slider(self._row(), "Linear drag",
                                   lambda: world.drag_linear,
                                   lambda v: setattr(world, "drag_linear", v),
                                   0.0, 20.0, u, "", "{:.2f}",
                                   on_commit=self._commit,
                                   tooltip="F = -c v (Stokes drag)"))
        self.widgets.append(Slider(self._row(), "Quad. drag",
                                   lambda: world.drag_quadratic,
                                   lambda v: setattr(world, "drag_quadratic", v),
                                   0.0, 20.0, u, "", "{:.2f}",
                                   on_commit=self._commit,
                                   tooltip="F = -c |v| v (aerodynamic drag)"))
        self.widgets.append(Slider(self._row(), "Damping",
                                   lambda: world.global_damping,
                                   lambda v: setattr(world, "global_damping", v),
                                   0.0, 20.0, u, "1/s", "{:.2f}",
                                   on_commit=self._commit,
                                   tooltip="Exponential decay applied to all velocities"))

        self.widgets.append(SectionLabel(self._row(20), "Solver"))
        short = {"Velocity Verlet": "Verlet", "Symplectic Euler": "Euler", "RK4": "RK4"}
        rev = {v: k for k, v in short.items()}
        self.widgets.append(Segmented(self._row(26), list(short.values()),
                                      lambda: short[world.integrator],
                                      lambda v: (setattr(world, "integrator", rev[v]),
                                                 self._commit()),
                                      tooltip="Verlet: symplectic, best all-round choice. "
                                              "Euler: fastest, less accurate. RK4: highest "
                                              "short-term accuracy for smooth forces."))
        self.widgets.append(Slider(self._row(), "Substeps",
                                   lambda: world.substeps,
                                   lambda v: setattr(world, "substeps", int(v)),
                                   1, 128, u, "", "{:.0f}", step=1, log=True,
                                   on_commit=self._commit,
                                   tooltip="Physics substeps per frame, up to 128: "
                                           "more = more accurate but slower"))
        self.widgets.append(Slider(self._row(), "Iterations",
                                   lambda: world.iterations,
                                   lambda v: setattr(world, "iterations", int(v)),
                                   1, 64, u, "", "{:.0f}", step=1, log=True,
                                   on_commit=self._commit,
                                   tooltip="Solver iterations per substep for links "
                                           "and contacts (they exit early once converged)"))

        self.widgets.append(SectionLabel(self._row(20), "Custom force fields"))
        for field in list(world.fields):
            self.widgets.append(Checkbox(self._row(22), field.name,
                                         lambda f=field: f.enabled,
                                         lambda v, f=field: (setattr(f, "enabled", v),
                                                             self._commit())))
            for attr, label in (("fx_src", "Fx"), ("fy_src", "Fy")):
                row = self._row(24)
                self.widgets.append(Label((row.x, row.y, 22, 24), label, 12,
                                          theme.TEXT_DIM))

                def commit(s, f=field, a=attr) -> bool:
                    # keep the text either way so the user can fix it; a bad
                    # expression just disables the field and shows the error
                    setattr(f, a, s)
                    ok = f.compile()
                    if ok:
                        self.app.push_undo()
                    return ok

                self.widgets.append(TextEdit((row.x + 24, row.y, row.w - 24, 24),
                                             lambda f=field, a=attr: getattr(f, a),
                                             commit, u,
                                             placeholder="e.g. -0.5*vx or -x*10"))
            if field.error:
                self.widgets.append(Label(self._row(16), field.error, 11, theme.BAD))
            self.widgets.append(Button(self._row(22),
                                       lambda f=field: (world.fields.remove(f),
                                                        self._commit()),
                                       "Remove field", icon="trash",
                                       style="danger", size=11))
        self.widgets.append(Button(self._row(24), self._add_field, "Add force field",
                                   icon="plus", size=12,
                                   tooltip="Force in N as f(x, y, vx, vy, t, m, r). "
                                           "Try Fy = -y*5 for a spring field."))

        if world.drivers:
            self.widgets.append(SectionLabel(self._row(20), "Drivers"))
            for drv in list(world.drivers):
                body = world.body_by_id(drv.body_id)
                name = body.name if body else f"body {drv.body_id}"
                r = self._row(22)
                self.widgets.append(Checkbox(pygame.Rect(r.x, r.y, r.w - 30, 22),
                                             f"{name}: {drv.amplitude:.1f} N @ "
                                             f"{drv.frequency:.2f} Hz",
                                             lambda d=drv: d.enabled,
                                             lambda v, d=drv: (setattr(d, "enabled", v),
                                                               self._commit())))
                self.widgets.append(Button((r.right - 24, r.y, 24, 22),
                                           lambda d=drv: (world.drivers.remove(d),
                                                          self._commit()),
                                           "", icon="close", style="ghost"))

    def _add_field(self) -> None:
        self.app.world.fields.append(ForceField(f"Field {len(self.app.world.fields) + 1}",
                                                "0", "0"))
        self.app.push_undo()

    # -------------------------------------------------------------- view tab
    def _build_view(self) -> None:
        app = self.app
        view = app.view
        u = app.ui

        def chk(label, attr, tip=""):
            self.widgets.append(Checkbox(self._row(24), label,
                                         lambda a=attr: getattr(view, a),
                                         lambda v, a=attr: setattr(view, a, v),
                                         tip))

        self.widgets.append(SectionLabel(self._row(20), "Canvas"))
        chk("Grid", "grid")
        chk("Snap to grid", "snap", "New and dragged objects snap to grid points (N)")
        chk("Body labels", "labels")
        chk("Follow selection", "follow",
            "Keep the camera centred on the selected body (C)")
        self.widgets.append(Button(self._row(24), app.zoom_to_fit,
                                   "Zoom to fit scene", size=12,
                                   tooltip="Frame every object in view (F)"))

        self.widgets.append(SectionLabel(self._row(20), "Vectors"))
        chk("Velocity vectors", "vel_vectors", "Green arrows (also editable by dragging)")
        chk("Acceleration vectors", "acc_vectors", "Orange arrows")
        chk("Net force vectors", "force_vectors", "Red arrows: F = ma")
        self.widgets.append(Slider(self._row(), "Vector size",
                                   lambda: view.vector_scale,
                                   lambda v: setattr(view, "vector_scale", v),
                                   0.02, 20.0, u, "x", "{:.2f}", log=True))

        self.widgets.append(SectionLabel(self._row(20), "Analysis"))
        chk("Motion trails", "trails", "Fading path behind each moving body (T)")
        self.widgets.append(Slider(self._row(), "Trail length",
                                   lambda: view.trail_len,
                                   lambda v: setattr(view, "trail_len", int(v)),
                                   10, 10000, u, "pts", "{:.0f}", step=10,
                                   log=True))
        chk("Centre of mass", "com")
        chk("Contact normals", "contacts", "Arrow at every collision this frame")
        chk("Broadphase grid", "spatial_grid", "Spatial-hash cells used by the collision engine (G)")

        self.widgets.append(SectionLabel(self._row(20), "Graph dock"))
        self.widgets.append(Segmented(self._row(26), ["Off", "Energy", "Mom.", "Phase"],
                                      lambda: app.graph_mode,
                                      app.set_graph_mode,
                                      tooltip="Live plots along the bottom of the screen"))

        self.widgets.append(SectionLabel(self._row(20), "Performance"))
        self.widgets.append(Segmented(self._row(26), ["30", "60", "120", "Max"],
                                      lambda: app.fps_cap_label,
                                      app.set_fps_cap,
                                      tooltip="Frame-rate cap"))
        self.widgets.append(Checkbox(self._row(24), "Antialiased rendering",
                                     lambda: view.antialias, app.set_antialias,
                                     "Smooth circle edges. Turn off on slow machines."))

    def draw(self, surface, mouse) -> None:
        pygame.draw.rect(surface, theme.PANEL, self.rect)
        pygame.draw.line(surface, theme.OUTLINE, (self.rect.x, self.rect.y),
                         (self.rect.x, self.rect.bottom))
        clip = surface.get_clip()
        surface.set_clip(self._content_rect())
        for w in self.widgets:
            if w is not self.tabs and w.visible:
                w.draw(surface, mouse)
                if w.tooltip and w.hit(mouse):
                    self.app.ui.note_hover(w, w.tooltip, self.app.dt_frame)
        surface.set_clip(clip)
        if self.tabs:
            header = pygame.Rect(self.rect.x, self.rect.y, self.rect.w, 44)
            pygame.draw.rect(surface, theme.PANEL, header)
            self.tabs.draw(surface, mouse)
            if self.tabs.tooltip and self.tabs.hit(mouse):
                self.app.ui.note_hover(self.tabs, self.tabs.tooltip,
                                       self.app.dt_frame)
        pygame.draw.line(surface, theme.OUTLINE, (self.rect.x, self.rect.y),
                         (self.rect.x, self.rect.bottom))
        surface.set_clip(clip)


# --------------------------------------------------------------- graph dock
class GraphDock(PanelBase):
    def relayout(self) -> None:
        app = self.app
        # full width (the inspector stops at the dock's top edge)
        self.rect = pygame.Rect(PALETTE_W, app.height - HINT_H - DOCK_H,
                                app.width - PALETTE_W, DOCK_H)
        self.widgets = [Button((self.rect.right - 30, self.rect.y + 6, 24, 24),
                               lambda: app.set_graph_mode("Off"), "",
                               icon="close", style="ghost", tooltip="Close graphs")]

    def draw(self, surface, mouse) -> None:
        app = self.app
        pygame.draw.rect(surface, theme.PANEL, self.rect)
        plot_rect = self.rect.inflate(-12, -12)
        if app.graph_mode == "Energy":
            app.energy_series.draw(surface, plot_rect, "Energy (J)")
        elif app.graph_mode == "Mom.":
            app.momentum_series.draw(surface, plot_rect,
                                     "Momentum (kg m/s) and angular momentum")
        elif app.graph_mode == "Phase":
            body = next((o for o in app.selection if isinstance(o, Body)), None)
            title = f"Phase space: {body.name}" if body else "Phase space"
            app.phase_plot.draw(surface, plot_rect, title)
        self.draw_widgets(surface, mouse)


# ----------------------------------------------------------------- hint bar
class HintBar(PanelBase):
    def relayout(self) -> None:
        app = self.app
        self.rect = pygame.Rect(0, app.height - HINT_H, app.width, HINT_H)
        self.widgets = []

    def draw(self, surface, mouse) -> None:
        app = self.app
        pygame.draw.rect(surface, theme.PANEL, self.rect)
        pygame.draw.line(surface, theme.OUTLINE, self.rect.topleft,
                         self.rect.topright)
        blit_text(surface, app.canvas.hint(), (10, self.rect.centery), 12,
                  theme.TEXT_DIM, False, "midleft")
        wp = app.camera.to_world(*mouse)
        n_dyn = sum(1 for b in app.world.bodies if not b.locked)
        drift = app.energy_drift_text()
        info = f"{wp.x:.2f}, {wp.y:.2f} m   |   {n_dyn} bodies   " \
               f"{len(app.world.contacts)} contacts   {drift}"
        blit_text(surface, info, (self.rect.right - 10, self.rect.centery), 12,
                  theme.TEXT_FAINT, False, "midright")


# ------------------------------------------------------------------ library
class LibraryOverlay(PanelBase):
    CARD_H = 96

    def __init__(self, app) -> None:
        super().__init__(app)
        self.visible = False
        self.category = "All"
        self.scroll = 0
        self.save_edit: TextEdit | None = None

    def relayout(self) -> None:
        app = self.app
        w = min(940, app.width - 60)
        h = min(600, app.height - 60)
        self.rect = pygame.Rect((app.width - w) // 2, (app.height - h) // 2, w, h)
        self.widgets = [Button((self.rect.right - 36, self.rect.y + 10, 26, 26),
                               self.close, "", icon="close", style="ghost")]
        x = self.rect.x + 14
        y = self.rect.y + 46
        for cat in CATEGORIES + ["Saved scenes"]:
            self.widgets.append(Button((x, y, 150, 26),
                                       (lambda c=cat: self._set_cat(c)), cat,
                                       size=12, style="ghost",
                                       is_active=(lambda c=cat: self.category == c)))
            y += 30
        # save box
        y += 12
        self.widgets.append(Label((x, y, 150, 18), "Save current scene:", 11,
                                  theme.TEXT_FAINT))
        y += 20
        self.save_edit = TextEdit((x, y, 150, 24), lambda: "", self._save,
                                  app.ui, placeholder="scene name")
        self.widgets.append(self.save_edit)

    def _set_cat(self, c: str) -> None:
        self.category = c
        self.scroll = 0

    def _save(self, name: str) -> bool:
        if not name.strip():
            return False
        saved = snap.save_scene(self.app.world, name)
        self.app.toast(f"Saved scene '{saved}'")
        self.category = "Saved scenes"
        return True

    def open(self) -> None:
        self.visible = True
        self.relayout()

    def close(self) -> None:
        self.visible = False
        if self.save_edit and self.save_edit.editing:
            self.save_edit.blur(commit=False)

    def _cards(self) -> list:
        if self.category == "Saved scenes":
            return snap.list_scenes()
        return [p for p in PRESETS
                if self.category in ("All", p.category)]

    def _grid_area(self) -> pygame.Rect:
        return pygame.Rect(self.rect.x + 180, self.rect.y + 46,
                           self.rect.w - 194, self.rect.h - 60)

    def handle_event(self, event, mouse) -> bool:
        if not self.visible:
            return False
        if event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
            if not (self.save_edit and self.save_edit.editing):
                self.close()
                return True
        if event.type == pygame.MOUSEWHEEL and self._grid_area().collidepoint(mouse):
            self.scroll = min(self._max_scroll(),
                              max(0, self.scroll - event.y * 48))
            return True
        for w in self.widgets:
            if w.handle(event, mouse):
                return True
        if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
            if not self.rect.collidepoint(mouse):
                self.close()
                return True
            area = self._grid_area()
            if area.collidepoint(mouse):
                self._click_card(mouse)
            return True
        return event.type in (pygame.MOUSEBUTTONDOWN, pygame.MOUSEWHEEL)

    def _card_rects(self) -> list[pygame.Rect]:
        area = self._grid_area()
        cols = 2
        cw = (area.w - 12) // cols
        rects = []
        for i in range(len(self._cards())):
            col, row = i % cols, i // cols
            rects.append(pygame.Rect(area.x + col * (cw + 12),
                                     area.y + row * (self.CARD_H + 10) - self.scroll,
                                     cw, self.CARD_H))
        return rects

    def _max_scroll(self) -> int:
        area = self._grid_area()
        rows = (len(self._cards()) + 1) // 2
        content_h = rows * self.CARD_H + max(0, rows - 1) * 10
        return max(0, content_h - area.h)

    def _click_card(self, mouse) -> None:
        cards = self._cards()
        for card, rect in zip(cards, self._card_rects()):
            if not rect.collidepoint(mouse):
                continue
            if self.category == "Saved scenes":
                del_rect = pygame.Rect(rect.right - 34, rect.y + 8, 26, 22)
                if del_rect.collidepoint(mouse):
                    import os
                    os.remove(os.path.join(snap.SCENES_DIR, f"{card}.json"))
                    self.app.toast(f"Deleted '{card}'")
                    return
                self.app.load_saved_scene(card)
            else:
                self.app.load_preset(card)
            self.close()
            return

    def draw(self, surface, mouse) -> None:
        if not self.visible:
            return
        dim = pygame.Surface((self.app.width, self.app.height), pygame.SRCALPHA)
        dim.fill((8, 9, 12, 180))
        surface.blit(dim, (0, 0))
        pygame.draw.rect(surface, theme.PANEL, self.rect, 0, 10)
        pygame.draw.rect(surface, theme.OUTLINE, self.rect, 1, 10)
        blit_text(surface, "Simulation library", (self.rect.x + 16, self.rect.y + 12),
                  16, theme.TEXT, True)
        area = self._grid_area()
        clip = surface.get_clip()
        surface.set_clip(area)
        cards = self._cards()
        for card, rect in zip(cards, self._card_rects()):
            if rect.bottom < area.y or rect.y > area.bottom:
                continue
            hover = rect.collidepoint(mouse)
            pygame.draw.rect(surface, theme.PANEL_HOVER if hover else theme.PANEL_LIGHT,
                             rect, 0, 8)
            if self.category == "Saved scenes":
                blit_text(surface, str(card), (rect.x + 12, rect.y + 10), 14,
                          theme.TEXT, True)
                blit_text(surface, "Click to load", (rect.x + 12, rect.y + 34),
                          11, theme.TEXT_FAINT)
                del_rect = pygame.Rect(rect.right - 34, rect.y + 8, 26, 22)
                draw_icon(surface, "trash",
                          del_rect, theme.BAD if del_rect.collidepoint(mouse)
                          else theme.TEXT_FAINT)
            else:
                blit_text(surface, card.name, (rect.x + 12, rect.y + 8), 14,
                          theme.TEXT, True)
                blit_text(surface, card.category, (rect.right - 12, rect.y + 12),
                          10, theme.ACCENT, False, "topright")
                for li, line in enumerate(wrap_text(card.description, 11,
                                                    rect.w - 24)[:4]):
                    blit_text(surface, line, (rect.x + 12, rect.y + 32 + li * 15),
                              11, theme.TEXT_DIM)
        surface.set_clip(clip)
        self.draw_widgets(surface, mouse)


# -------------------------------------------------------------------- help
HELP_SHORTCUTS = [
    ("Space", "Play / pause"), (".", "Step one frame"),
    ("Ctrl+R", "Reset simulation"), ("Ctrl+Z / Y", "Undo / redo"),
    ("Ctrl+D", "Duplicate selection"), ("Del", "Delete selection"),
    ("Ctrl+C / V", "Copy / paste properties"), ("Ctrl+S", "Save scene"),
    ("V H B A W R E S X", "Choose tool"), ("Arrows", "Nudge selected bodies"),
    ("F", "Zoom to fit the scene"), ("C", "Follow the selected body"),
    ("N", "Toggle grid snapping"), ("T", "Toggle motion trails"),
    ("G", "Toggle broadphase grid"), ("L", "Open the library"),
    ("Scroll", "Zoom at cursor"), ("Mid/right drag", "Pan the view"),
    ("Shift+click", "Add to selection"), ("Shift+drag wall", "Snap wall angle"),
    ("Drag body (playing)", "Throw it"), ("F1", "This help"),
]


class HelpOverlay(PanelBase):
    def __init__(self, app) -> None:
        super().__init__(app)
        self.visible = False

    def relayout(self) -> None:
        app = self.app
        rows = (len(HELP_SHORTCUTS) + 1) // 2
        w = min(860, app.width - 80)
        h = min(rows * 26 + 110, app.height - 60)
        self.rect = pygame.Rect((app.width - w) // 2, (app.height - h) // 2, w, h)
        self.widgets = [
            Button((self.rect.right - 36, self.rect.y + 10, 26, 26),
                   lambda: setattr(self, "visible", False), "", icon="close",
                   style="ghost"),
            Button((self.rect.x + 16, self.rect.bottom - 40, 150, 28),
                   self._restart_tour, "Restart the tour", size=12),
        ]

    def _restart_tour(self) -> None:
        self.visible = False
        self.app.tour.start()

    def handle_event(self, event, mouse) -> bool:
        if not self.visible:
            return False
        if event.type == pygame.KEYDOWN and event.key in (pygame.K_ESCAPE, pygame.K_F1):
            self.visible = False
            return True
        for w in self.widgets:
            if w.handle(event, mouse):
                return True
        if event.type == pygame.MOUSEBUTTONDOWN:
            if not self.rect.collidepoint(mouse):
                self.visible = False
            return True
        return False

    def draw(self, surface, mouse) -> None:
        if not self.visible:
            return
        dim = pygame.Surface((self.app.width, self.app.height), pygame.SRCALPHA)
        dim.fill((8, 9, 12, 180))
        surface.blit(dim, (0, 0))
        pygame.draw.rect(surface, theme.PANEL, self.rect, 0, 10)
        pygame.draw.rect(surface, theme.OUTLINE, self.rect, 1, 10)
        blit_text(surface, "Help & keyboard shortcuts",
                  (self.rect.x + 16, self.rect.y + 12), 16, theme.TEXT, True)
        rows = (len(HELP_SHORTCUTS) + 1) // 2
        col_w = (self.rect.w - 48) // 2
        for i, (keys, desc) in enumerate(HELP_SHORTCUTS):
            col, row = divmod(i, rows)
            x = self.rect.x + 24 + col * (col_w + 12)
            y = self.rect.y + 52 + row * 26
            blit_text(surface, keys, (x, y), 12, theme.ACCENT, True)
            blit_text(surface, desc, (x + 150, y), 12, theme.TEXT_DIM)
        self.draw_widgets(surface, mouse)


# --------------------------------------------------------------------- tour
class TourOverlay:
    """First-run guided tour: sequential callouts pointing at UI regions."""

    def __init__(self, app) -> None:
        self.app = app
        self.visible = False
        self.index = 0

    def steps(self) -> list[tuple[str, str, pygame.Rect | None]]:
        app = self.app
        return [
            ("Welcome to Mechanica",
             "A physics laboratory for building and analysing mechanical "
             "systems. This short tour points out the essentials - "
             "click Next to continue.", None),
            ("Tool palette",
             "Pick a tool here: select and move things, add bodies and "
             "anchors, draw walls, or connect bodies with rods, ropes and "
             "springs. Hover any icon for its shortcut.",
             app.palette.rect),
            ("The canvas",
             "Scroll to zoom, drag with the right mouse button to pan, press "
             "F to frame everything. With the Select tool, drag bodies to "
             "move them (throw them while playing!) and drag the green arrow "
             "tip to set a velocity.",
             app.canvas_rect()),
            ("Playback",
             "Play, pause, single-step and reset here. The speed slider "
             "slows time down for fast events, and you can type a time to "
             "jump straight to it.", pygame.Rect(120, 0, 480, TOOLBAR_H)),
            ("Inspector",
             "Everything about the selected object - mass, velocity, "
             "materials, forces - plus world settings (gravity, drag, the "
             "solver) and view overlays live in these three tabs.",
             app.inspector.rect),
            ("Library",
             "Nearly thirty ready-made simulations: orbits, chaotic "
             "pendulums, resonance, gases and more. Your own scenes can be "
             "saved there too. Press L any time.",
             pygame.Rect(app.width - 320, 0, 200, TOOLBAR_H)),
            ("Analyse",
             "In the View tab you can show velocity and force vectors, "
             "motion trails and live graphs of energy, momentum and phase "
             "space. Have fun experimenting!",
             app.inspector.rect),
        ]

    def start(self) -> None:
        self.visible = True
        self.index = 0

    def _advance(self) -> None:
        self.index += 1
        if self.index >= len(self.steps()):
            self.visible = False
            self.app.mark_tour_done()

    def handle_event(self, event, mouse) -> bool:
        if not self.visible:
            return False
        if event.type == pygame.KEYDOWN:
            if event.key == pygame.K_ESCAPE:
                self.visible = False
                self.app.mark_tour_done()
            else:
                self._advance()
            return True
        if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
            if self._skip_rect().collidepoint(mouse):
                self.visible = False
                self.app.mark_tour_done()
            else:
                self._advance()
            return True
        return event.type in (pygame.MOUSEBUTTONDOWN, pygame.MOUSEWHEEL)

    def _box_rect(self, target: pygame.Rect | None) -> pygame.Rect:
        app = self.app
        w, h = 380, 170
        if target is None:
            return pygame.Rect((app.width - w) // 2, (app.height - h) // 2, w, h)
        x = min(max(20, target.centerx - w // 2), app.width - w - 20)
        y = target.bottom + 16
        if y + h > app.height - 30:
            y = max(20, target.y - h - 16)
        return pygame.Rect(x, y, w, h)

    def _skip_rect(self) -> pygame.Rect:
        steps = self.steps()
        box = self._box_rect(steps[self.index][2])
        return pygame.Rect(box.x + 14, box.bottom - 36, 70, 24)

    def draw(self, surface, mouse) -> None:
        if not self.visible:
            return
        app = self.app
        title, body, target = self.steps()[self.index]
        dim = pygame.Surface((app.width, app.height), pygame.SRCALPHA)
        dim.fill((8, 9, 12, 165))
        if target is not None:
            pygame.draw.rect(dim, (0, 0, 0, 0), target.inflate(8, 8), 0, 8)
        surface.blit(dim, (0, 0))
        if target is not None:
            pygame.draw.rect(surface, theme.ACCENT, target.inflate(8, 8), 2, 8)
        box = self._box_rect(target)
        pygame.draw.rect(surface, theme.PANEL, box, 0, 10)
        pygame.draw.rect(surface, theme.ACCENT, box, 1, 10)
        blit_text(surface, title, (box.x + 14, box.y + 10), 15, theme.TEXT, True)
        for i, line in enumerate(wrap_text(body, 12, box.w - 28)[:6]):
            blit_text(surface, line, (box.x + 14, box.y + 38 + i * 17), 12,
                      theme.TEXT_DIM)
        step_txt = f"{self.index + 1} / {len(self.steps())}"
        blit_text(surface, step_txt, (box.right - 14, box.bottom - 30), 11,
                  theme.TEXT_FAINT, False, "topright")
        skip = self._skip_rect()
        pygame.draw.rect(surface, theme.PANEL_LIGHT, skip, 0, 5)
        blit_text(surface, "Skip", skip.center, 12, theme.TEXT_DIM, False, "center")
        nxt = pygame.Rect(skip.right + 10, skip.y, 90, 24)
        pygame.draw.rect(surface, theme.ACCENT, nxt, 0, 5)
        blit_text(surface, "Next", nxt.center, 12, (250, 252, 255), True, "center")
