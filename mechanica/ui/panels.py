"""Application panels: toolbar, tool palette, inspector, graph dock,
library / help / tour overlays and the hint bar."""
from __future__ import annotations

from math import isfinite, pi

import pygame

from mechanica.engine.body import Body, MATERIALS, Wall
from mechanica.engine.links import DistanceLink, SpringLink
from mechanica.engine.world import Driver, ForceField, INTEGRATORS
from mechanica.interact.tools import TOOL_KEYS, TOOLS, TOOL_INFO
from mechanica.scene import snapshot as snap
from mechanica.scene.presets import CATEGORIES, PRESETS
from mechanica.ui import theme
from mechanica.ui.theme import blit_text, draw_icon, wrap_text
from mechanica.ui.widgets import (Button, Checkbox, Label, SectionLabel,
                                  Segmented, Slider, TextEdit, Widget)

TOOLBAR_H = 46
PALETTE_W = 52
INSPECTOR_W = 306   # default width of the right panel (drag its edge to resize)
DOCK_H = 178        # default height of the graph dock (drag its edge to resize)
COLLAPSED_W = 18    # slim reopen strip shown when the right panel is hidden
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
        self.widgets.append(Button((x, y, 34, h), app.step_back, "",
                                   icon="step_back",
                                   tooltip="Step one frame back  (,)"))
        x += 38
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
                                           "(0.01x slow motion to 20x "
                                           "fast-forward). Keys: + and - "
                                           "double/halve, 0 resets to 1x."))
        x += 196
        self.widgets.append(Button((x, y + 3, 30, 24), app.reset_speed, "1x",
                                   size=11,
                                   tooltip="Reset the speed to 1x  (0)"))
        x += 40
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
        self.widgets.append(Button((rx, y, 34, h), app.toggle_auto_fit, "",
                                   icon="autofit",
                                   is_active=lambda: app.view.auto_fit,
                                   tooltip="Auto-fit camera: continuously keep "
                                           "the whole scene framed  (Shift+F)"))
        rx -= 38
        self.widgets.append(Button((rx, y, 34, h), app.zoom_to_fit, "",
                                   icon="fit",
                                   tooltip="Zoom to fit the scene once  (F)"))
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
# tools grouped by purpose; a thin separator is drawn between groups
TOOL_GROUPS = [("select", "pan"), ("body", "anchor", "wall"),
               ("rod", "rope", "spring"), ("eraser",)]


class Palette(PanelBase):
    def relayout(self) -> None:
        app = self.app
        self.rect = pygame.Rect(0, TOOLBAR_H, PALETTE_W,
                                app.height - TOOLBAR_H - HINT_H)
        self.widgets = []
        self._badges: list[tuple[pygame.Rect, str]] = []
        self._seps: list[int] = []
        key_of = {t: pygame.key.name(k).upper() for k, t in TOOL_KEYS.items()}
        y = self.rect.y + 10
        for gi, group in enumerate(TOOL_GROUPS):
            if gi:
                self._seps.append(y)
                y += 8
            for tool in group:
                name, desc = TOOL_INFO[tool]
                btn = Button((8, y, 36, 36),
                             (lambda t=tool: app.canvas.set_tool(t)), "",
                             icon=tool, tooltip=f"{name} - {desc}",
                             style="ghost",
                             is_active=(lambda t=tool: app.canvas.tool == t))
                self.widgets.append(btn)
                self._badges.append((btn.rect, key_of.get(tool, "")))
                y += 42

    def draw(self, surface, mouse) -> None:
        pygame.draw.rect(surface, theme.PANEL, self.rect)
        pygame.draw.line(surface, theme.OUTLINE, (self.rect.right - 1, self.rect.y),
                         (self.rect.right - 1, self.rect.bottom))
        for sy in self._seps:
            pygame.draw.line(surface, theme.OUTLINE, (10, sy), (PALETTE_W - 10, sy))
        self.draw_widgets(surface, mouse)
        # tiny shortcut-letter badge in each button's corner
        for rect, letter in self._badges:
            if letter:
                blit_text(surface, letter, (rect.right - 2, rect.bottom + 1),
                          9, theme.TEXT_FAINT, False, "bottomright")


# --------------------------------------------------------------- inspector
class Inspector(PanelBase):
    TABS = ["Selection", "World", "View"]

    def __init__(self, app) -> None:
        super().__init__(app)
        self.tab = "Selection"
        self.scroll = 0
        self.content_h = 0
        self.tabs: Segmented | None = None
        self._hide_btn: Button | None = None
        self.show_formula_help = False
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
                app.graph_mode, app.inspector_w, app.inspector_visible,
                app.dock_h, self.show_formula_help, len(app.world.bodies),
                len(app.world.walls), len(app.world.links))

    def maybe_rebuild(self) -> None:
        key = self._structure_key()
        if key != self._key:
            self._key = key
            self.relayout()

    def handle_event(self, event, mouse) -> bool:
        if not self.app.inspector_visible:
            # collapsed to a slim strip: any click on it reopens the panel
            if (event.type == pygame.MOUSEBUTTONDOWN and event.button == 1
                    and self.rect.collidepoint(mouse)):
                self.app.toggle_inspector()
                return True
            return False
        if self._hide_btn and self._hide_btn.handle(event, mouse):
            return True
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
        panel_h = (app.height - TOOLBAR_H - HINT_H
                   - (app.dock_h if app.graph_mode != "Off" else 0))
        if not app.inspector_visible:
            self.rect = pygame.Rect(app.width - COLLAPSED_W, TOOLBAR_H,
                                    COLLAPSED_W, panel_h)
            self.widgets = []
            self.tabs = None
            self._hide_btn = None
            self.content_h = 0
            return
        self.rect = pygame.Rect(app.width - app.inspector_w, TOOLBAR_H,
                                app.inspector_w, panel_h)
        self.widgets = []
        tabs_rect = pygame.Rect(self.rect.x + 12, self.rect.y + 10,
                                self.rect.w - 24 - 30, 28)
        self.tabs = Segmented(tabs_rect, self.TABS, lambda: self.tab,
                              self._set_tab)
        self._hide_btn = Button((self.rect.right - 34, self.rect.y + 10, 24, 28),
                                app.toggle_inspector, "", icon="chev_right",
                                style="ghost",
                                tooltip="Hide the panel to widen the canvas (Tab)")
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
                               ("springs", "Springs & strings"),
                               ("rods", "Rods")):
                self.widgets.append(Checkbox(
                    self._row(22), label,
                    (lambda k=key: app.box_filter[k]),
                    (lambda v, k=key: app.box_filter.__setitem__(k, v)),
                    "Object types included when you drag a selection box"))
            world = app.world
            groups = [(g, lbl) for g, lbl in (
                (list(world.bodies), "bodies"),
                (list(world.walls), "walls"),
                ([ln for ln in world.links if isinstance(ln, SpringLink)],
                 "springs & strings"),
                ([ln for ln in world.links if isinstance(ln, DistanceLink)],
                 "rods"))
                if g]
            if groups:
                self.widgets.append(SectionLabel(self._row(22),
                                                 "Delete every ..."))
                for grp, lbl in groups:
                    self.widgets.append(Button(
                        self._row(24),
                        (lambda g=grp, s=lbl: self._delete_objs(g, s)),
                        f"All {lbl} ({len(grp)})", style="danger", size=11,
                        tooltip=f"Remove every {lbl.rstrip('s')} in the scene "
                                "(undo with Ctrl+Z)"))
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
                                   on_commit=self._commit,
                                   tooltip="Inertial (and gravitational) mass m"))
        self.widgets.append(Slider(self._row(), "Radius", lambda: b.radius,
                                   lambda v: setattr(b, "radius", v), 0.01, 10.0,
                                   u, "m", "{:.3g}", log=True,
                                   on_commit=self._commit,
                                   tooltip="Collision radius (mass is "
                                           "independent of size here)"))
        r1, r2 = self._half_rows()
        self._num_edit(r1, "x", lambda: b.pos.x, lambda v: setattr(b.pos, "x", v), "m")
        self._num_edit(r2, "y", lambda: b.pos.y, lambda v: setattr(b.pos, "y", v), "m")
        r1, r2 = self._half_rows()
        self._num_edit(r1, "vx", lambda: b.vel.x, lambda v: setattr(b.vel, "x", v))
        self._num_edit(r2, "vy", lambda: b.vel.y, lambda v: setattr(b.vel, "y", v))
        self.widgets.append(Slider(self._row(), "Spin", lambda: b.omega,
                                   lambda v: setattr(b, "omega", v), -100.0, 100.0,
                                   u, "rad/s", "{:.2f}", on_commit=self._commit,
                                   tooltip="Angular velocity omega about the "
                                           "body's centre"))
        r1, r2 = self._half_rows()
        chk1 = Checkbox(r1, "Locked", lambda: b.locked,
                        lambda v: (setattr(b, "locked", v), self._commit()),
                        "A locked body never moves: use as pivot or anchor (K)")
        chk2 = Checkbox(r2, "Collides", lambda: b.collides,
                        lambda v: (setattr(b, "collides", v), self._commit()),
                        "Disable to let this body pass through others")
        self.widgets.extend((chk1, chk2))

        self.widgets.append(SectionLabel(self._row(20), "Material"))
        self.widgets.append(Slider(self._row(), "Bounce", lambda: b.restitution,
                                   lambda v: setattr(b, "restitution", v),
                                   0.0, 1.0, u, "", "{:.2f}",
                                   on_commit=self._commit,
                                   tooltip="Coefficient of restitution e: "
                                           "fraction of approach speed kept "
                                           "after a bounce (1 = perfectly "
                                           "elastic, 0 = perfectly inelastic)"))
        self.widgets.append(Slider(self._row(), "Friction", lambda: b.friction,
                                   lambda v: setattr(b, "friction", v),
                                   0.0, 3.0, u, "", "{:.2f}",
                                   on_commit=self._commit,
                                   tooltip="Coefficient of friction mu "
                                           "(Coulomb model: |F_t| <= mu N)"))
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
                (springs, "spring/string", "springs/strings"),
                (rods, "rod", "rods"))
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
                                       on_commit=self._commit,
                                       tooltip="Coefficient of restitution e, "
                                               "applied to every selected body"))
            self.widgets.append(Slider(self._row(), "Friction",
                                       lambda: first.friction,
                                       set_all(bodies, "friction"), 0.0, 3.0,
                                       u, "", "{:.2f}", on_commit=self._commit,
                                       tooltip="Coefficient of friction mu, "
                                               "applied to every selected body"))
            names = [n for n in MATERIALS if n != "Custom"]
            per_row = 3
            for i in range(0, len(names), per_row):
                row = self._row(22)
                bw = (row.w - 8) // per_row
                for j, name in enumerate(names[i:i + per_row]):
                    e_, mu_ = MATERIALS[name]
                    self.widgets.append(Button(
                        (row.x + j * (bw + 4), row.y, bw, 22),
                        (lambda e_=e_, mu_=mu_: (set_all(bodies, "restitution")(e_),
                                                 set_all(bodies, "friction")(mu_),
                                                 self._commit())),
                        name, size=11,
                        tooltip=f"Set every selected body to bounce {e_}, "
                                f"friction {mu_}"))
            r1, r2 = self._half_rows()
            self.widgets.append(Checkbox(
                r1, "Locked", lambda: first.locked,
                lambda v: (set_all(bodies, "locked")(v), self._commit()),
                "Lock / unlock every selected body"))
            self.widgets.append(Checkbox(
                r2, "Collides", lambda: first.collides,
                lambda v: (set_all(bodies, "collides")(v), self._commit()),
                "Enable / disable collisions for every selected body"))
            self.widgets.append(SectionLabel(self._row(20), "Constant force"))
            r1, r2 = self._half_rows()
            self._num_edit(r1, "Fx", lambda: first.const_force.x,
                           lambda v: [setattr(o.const_force, "x", v)
                                      for o in bodies], "N")
            self._num_edit(r2, "Fy", lambda: first.const_force.y,
                           lambda v: [setattr(o.const_force, "y", v)
                                      for o in bodies], "N")
            self._build_multi_drivers(bodies)
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
                                             f"Springs & strings ({len(springs)})"))
            self.widgets.append(Slider(self._row(), "Stiffness",
                                       lambda: sfirst.stiffness,
                                       set_all(springs, "stiffness"),
                                       0.01, 100000.0, u, "N/m", "{:.3g}",
                                       log=True, on_commit=self._commit,
                                       tooltip="Spring constant k, applied to "
                                               "every selected spring/string"))
            self.widgets.append(Slider(self._row(), "Damping",
                                       lambda: sfirst.damping,
                                       set_all(springs, "damping"), 0.0, 500.0,
                                       u, "Ns/m", "{:.2f}",
                                       on_commit=self._commit,
                                       tooltip="Damping coefficient c, applied "
                                               "to every selected spring/string"))

        self._action_buttons()
        # selective deletion: remove just one kind of thing from the selection
        groups = [(g, lbl) for g, lbl in
                  ((bodies, "bodies"), (walls, "walls"),
                   (springs, "springs"), (rods, "rods"))
                  if g]
        if len(groups) >= 2:
            self.widgets.append(SectionLabel(self._row(20),
                                             "Delete only ..."))
            for i in range(0, len(groups), 2):
                r1, r2 = self._half_rows(24)
                for rect, (grp, lbl) in zip((r1, r2), groups[i:i + 2]):
                    self.widgets.append(Button(
                        rect, (lambda g=grp, s=lbl: self._delete_objs(g, s)),
                        f"{lbl.capitalize()} ({len(grp)})", style="danger",
                        size=11,
                        tooltip=f"Delete only the selected {lbl}, keeping "
                                "everything else"))

    def _build_multi_drivers(self, bodies: list[Body]) -> None:
        """Edit the sinusoidal drivers of every selected body at once."""
        app = self.app
        u = app.ui
        ids = {b.id for b in bodies}
        drvs = [d for d in app.world.drivers if d.body_id in ids]
        self.widgets.append(SectionLabel(
            self._row(20), f"Driving force ({len(drvs)}/{len(bodies)} driven)"))
        if not drvs:
            self.widgets.append(Button(
                self._row(24), lambda: self._add_drivers(bodies),
                "Add driver to all selected", icon="plus", size=12,
                tooltip="Apply F = A sin(2 pi f t) to every selected body"))
            return
        first = drvs[0]

        def set_all_drv(attr):
            def s(v):
                for d in drvs:
                    setattr(d, attr, v)
            return s

        self.widgets.append(Slider(self._row(), "Amplitude",
                                   lambda: first.amplitude,
                                   set_all_drv("amplitude"), 0.0, 500.0,
                                   u, "N", "{:.2f}", on_commit=self._commit,
                                   tooltip="Applied to every selected driver"))
        self.widgets.append(Slider(self._row(), "Frequency",
                                   lambda: first.frequency,
                                   set_all_drv("frequency"), 0.001, 100.0,
                                   u, "Hz", "{:.3g}", log=True,
                                   on_commit=self._commit,
                                   tooltip="Applied to every selected driver"))
        self.widgets.append(Slider(self._row(), "Direction",
                                   lambda: first.angle * 180 / pi,
                                   lambda v: set_all_drv("angle")(v * pi / 180),
                                   -180.0, 180.0, u, "deg", "{:.0f}",
                                   on_commit=self._commit,
                                   tooltip="Applied to every selected driver"))
        r1, r2 = self._half_rows(24)
        if len(drvs) < len(bodies):
            self.widgets.append(Button(r1, lambda: self._add_drivers(bodies),
                                       "Drive rest", size=11,
                                       tooltip="Add drivers to the selected "
                                               "bodies that lack one"))
        self.widgets.append(Button(r2, lambda: self._remove_drivers(drvs),
                                   "Remove all", style="danger", size=11,
                                   tooltip="Remove every selected body's driver"))

    def _add_drivers(self, bodies: list[Body]) -> None:
        world = self.app.world
        driven = {d.body_id for d in world.drivers}
        for b in bodies:
            if b.id not in driven and not b.locked:
                world.drivers.append(Driver(b.id))
        self.app.push_undo()

    def _remove_drivers(self, drvs: list[Driver]) -> None:
        world = self.app.world
        world.drivers = [d for d in world.drivers if d not in drvs]
        self.app.push_undo()

    def _delete_objs(self, objs: list, label: str) -> None:
        """Delete only one kind of object (used by the selective buttons)."""
        for o in list(objs):
            self.app.canvas._delete_object(o)
        self.app.push_undo()
        self.app.toast(f"Deleted {len(objs)} {label} - Ctrl+Z restores them")

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

    def _replace_link(self, old, new) -> None:
        """Swap a link object in place (elastic string <-> inelastic string)."""
        world = self.app.world
        if old in world.links:
            world.links[world.links.index(old)] = new
        self.app.selection = [new]
        self.app.push_undo()

    def _build_link(self, link) -> None:
        app = self.app
        u = app.ui
        if isinstance(link, SpringLink):
            is_string = link.tension_only
            title = "String (elastic)" if is_string else "Spring"
            self.widgets.append(Label(self._row(22), title, 14, theme.TEXT, True))
            self.widgets.append(Slider(self._row(), "Nat. len",
                                       lambda: link.rest_length,
                                       lambda v: setattr(link, "rest_length", v),
                                       0.01, 50.0, u, "m", "{:.3g}", log=True,
                                       on_commit=self._commit,
                                       tooltip="Natural (rest) length L0: the "
                                               "length at which it exerts no force"))
            self.widgets.append(Slider(self._row(), "Stiffness",
                                       lambda: link.stiffness,
                                       lambda v: setattr(link, "stiffness", v),
                                       0.01, 100000.0, u, "N/m", "{:.3g}", log=True,
                                       on_commit=self._commit,
                                       tooltip="Spring constant k (Hooke's law "
                                               "F = -k times extension) - the 1-D "
                                               "analogue of the modulus of elasticity"))
            self.widgets.append(Slider(self._row(), "Damping",
                                       lambda: link.damping,
                                       lambda v: setattr(link, "damping", v),
                                       0.0, 500.0, u, "Ns/m", "{:.2f}",
                                       on_commit=self._commit,
                                       tooltip="Damping coefficient c: axial "
                                               "force F = -c times the stretch rate"))
            if is_string:
                self.widgets.append(Checkbox(
                    self._row(24), "Inelastic (fixed length)",
                    lambda: False,
                    lambda v: self._replace_link(
                        link, DistanceLink(link.a, link.b,
                                           length=link.rest_length,
                                           is_rope=True)),
                    "Replace with a perfectly inelastic string: rigid at its "
                    "natural length when taut, still slack when shorter"))
        elif isinstance(link, DistanceLink):
            title = "String (inelastic)" if link.is_rope else "Rod"
            self.widgets.append(Label(self._row(22), title, 14, theme.TEXT, True))
            self.widgets.append(Slider(self._row(), "Nat. len", lambda: link.length,
                                       lambda v: setattr(link, "length", v),
                                       0.01, 100.0, u, "m", "{:.3g}", log=True,
                                       on_commit=self._commit,
                                       tooltip="Rigid length the rod maintains"
                                               if not link.is_rope else
                                               "Natural length L0: rigid when "
                                               "taut, free when slack"))
            if link.is_rope:
                self.widgets.append(Checkbox(
                    self._row(24), "Inelastic (fixed length)",
                    lambda: True,
                    lambda v: self._replace_link(
                        link, SpringLink(link.a, link.b,
                                         rest_length=link.length,
                                         stiffness=1000.0, damping=2.0,
                                         tension_only=True)),
                    "Untick to make the string elastic: it stretches under "
                    "load following Hooke's law (adds stiffness and damping)"))
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
                                   tooltip="Gravitational field strength g "
                                           "(uniform, downward). 9.81 = Earth, "
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
                                   1, 64, u, "", "{:.0f}", step=1, log=True,
                                   on_commit=self._commit,
                                   tooltip="Physics substeps per 1/120 s step, "
                                           "up to 64: more = more accurate but "
                                           "slower. Takes effect immediately."))
        self.widgets.append(Slider(self._row(), "Iterations",
                                   lambda: world.iterations,
                                   lambda v: setattr(world, "iterations", int(v)),
                                   1, 64, u, "", "{:.0f}", step=1, log=True,
                                   on_commit=self._commit,
                                   tooltip="Solver iterations per substep for links "
                                           "and contacts (they exit early once converged)"))
        self.widgets.append(Checkbox(
            self._row(24), "Adaptive resolution",
            lambda: app.adaptive_dt, app.set_adaptive_dt,
            "Automatically run extra, smaller physics steps during fast "
            "close encounters (gravity slingshots, whipping pendulums), "
            "as long as the frame rate can afford it. Keeps trajectories "
            "and motion trails smooth."))

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
                                   tooltip="A force (in N) applied to every body, "
                                           "written as plain math. Try Fy = -y*5 "
                                           "for a spring field. See the formula "
                                           "reference below for all the symbols."))
        self.widgets.append(Button(
            self._row(22), self._toggle_formula_help,
            ("Hide formula reference" if self.show_formula_help
             else "Formula reference"),
            size=11, style="ghost",
            tooltip="Every variable, function and operator you can use in "
                    "force-field formulas"))
        if self.show_formula_help:
            self._build_formula_reference()

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

    def _toggle_formula_help(self) -> None:
        self.show_formula_help = not self.show_formula_help

    def _build_formula_reference(self) -> None:
        """The in-panel cheat sheet for force-field formulas: sectioned,
        with the code part in accent and the meaning in dim text."""

        def code_row(code: str, desc: str, code_w: int = 108) -> None:
            row = self._row(16)
            self.widgets.append(Label((row.x + 6, row.y, code_w, 16), code,
                                      11, theme.ACCENT))
            self.widgets.append(Label((row.x + 6 + code_w, row.y,
                                       row.w - code_w - 6, 16), desc, 11,
                                      theme.TEXT_FAINT))

        def dim_row(text: str) -> None:
            self.widgets.append(Label(self._row(15), "   " + text, 11,
                                      theme.TEXT_DIM))

        self.widgets.append(SectionLabel(self._row(20), "Examples"))
        code_row("-0.5*vx", "drag along x")
        code_row("-10*x", "spring toward x = 0")
        code_row("3*sin(2*t)", "oscillating push")
        code_row("-5*x/r^3", "inverse-square pull")
        code_row("-0.4*m*(y > 2)", "only above y = 2")
        self.widgets.append(SectionLabel(self._row(20), "Variables"))
        code_row("x,  y", "position (m)")
        code_row("vx,  vy", "velocity (m/s)")
        code_row("t", "time (s)")
        code_row("m", "mass (kg)")
        code_row("r", "distance from (0, 0)  (m)")
        self.widgets.append(SectionLabel(self._row(20), "Functions"))
        dim_row("sin  cos  tan  asin  acos  atan  atan2")
        dim_row("sqrt  exp  log  abs  sign  hypot")
        dim_row("min(a, b, ...)  max  floor  ceil")
        self.widgets.append(SectionLabel(self._row(20), "Constants & operators"))
        code_row("pi  e  tau  g", "3.1416...,  2.7183...,  2*pi,  9.81")
        code_row("+ - * / %", "arithmetic")
        code_row("^  or  **", "power:  x^2  is  x squared")
        code_row("(m > 1)", "comparisons give 1 or 0 -")
        dim_row("use them as on/off switches, or write")
        code_row("a if y > 0 else b", "for a true either/or")
        self.widgets.append(SectionLabel(self._row(20), "Notes"))
        dim_row("The force is in newtons, applied to every")
        dim_row("body. Anything not listed above is rejected")
        dim_row("and the error shows in red under the field.")

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
            "Keep the camera centred on the selected body (C). Zoom-to-fit "
            "and the auto-fit camera live in the toolbar.")

        self.widgets.append(SectionLabel(self._row(20), "Vectors"))
        chk("Velocity vectors", "vel_vectors",
            "Green arrows (also editable by dragging) (D)")
        chk("Acceleration vectors", "acc_vectors", "Orange arrows")
        chk("Net force vectors", "force_vectors", "Red arrows: F = ma")
        self.widgets.append(Slider(self._row(), "Vector size",
                                   lambda: view.vector_scale,
                                   lambda v: setattr(view, "vector_scale", v),
                                   0.02, 20.0, u, "x", "{:.2f}", log=True))

        self.widgets.append(SectionLabel(self._row(20), "Analysis"))
        self.widgets.append(Checkbox(self._row(24), "Motion trails",
                                     lambda: view.trails, app.set_trails,
                                     "Fading path behind each moving body (T)"))
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
                                      tooltip="Live plots along the bottom of "
                                              "the screen (keys 1, 2, 3)"))

        self.widgets.append(SectionLabel(self._row(20), "Performance"))
        self.widgets.append(Segmented(self._row(26), ["30", "60", "120", "Max"],
                                      lambda: app.fps_cap_label,
                                      app.set_fps_cap,
                                      tooltip="Frame-rate cap"))
        self.widgets.append(Checkbox(self._row(24), "Antialiased rendering",
                                     lambda: view.antialias, app.set_antialias,
                                     "Smooth circle edges. Turn off on slow machines."))

    def draw(self, surface, mouse) -> None:
        app = self.app
        if not app.inspector_visible:
            # slim reopen strip along the right edge
            pygame.draw.rect(surface, theme.PANEL, self.rect)
            pygame.draw.line(surface, theme.OUTLINE, (self.rect.x, self.rect.y),
                             (self.rect.x, self.rect.bottom))
            hover = self.rect.collidepoint(mouse)
            draw_icon(surface, "chev_left",
                      pygame.Rect(self.rect.x, self.rect.centery - 14,
                                  self.rect.w, 28),
                      theme.TEXT if hover else theme.TEXT_DIM)
            if hover:
                app.ui.note_hover(self, "Show the panel (Tab)", app.dt_frame)
            return
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
        if self._hide_btn:
            self._hide_btn.draw(surface, mouse)
            if self._hide_btn.tooltip and self._hide_btn.hit(mouse):
                app.ui.note_hover(self._hide_btn, self._hide_btn.tooltip,
                                  app.dt_frame)
        pygame.draw.line(surface, theme.OUTLINE, (self.rect.x, self.rect.y),
                         (self.rect.x, self.rect.bottom))
        # resize grip on the draggable left edge
        pygame.draw.rect(surface, theme.TEXT_FAINT,
                         (self.rect.x + 1, self.rect.centery - 16, 3, 32), 0, 2)
        surface.set_clip(clip)


# --------------------------------------------------------------- graph dock
class GraphDock(PanelBase):
    """Bottom dock hosting the live graphs.

    Resizable by dragging its top edge. The header switches between graphs,
    clears the collected data, and shows a conservation hint explaining when
    the plotted quantity is (or is not) expected to stay constant."""

    def relayout(self) -> None:
        app = self.app
        # full width (the inspector stops at the dock's top edge)
        self.rect = pygame.Rect(PALETTE_W, app.height - HINT_H - app.dock_h,
                                app.width - PALETTE_W, app.dock_h)
        y = self.rect.y + 8
        self._seg = Segmented((self.rect.x + 10, y,
                               min(270, max(180, self.rect.w // 4)), 24),
                              ["Energy", "Mom.", "Phase"],
                              lambda: app.graph_mode, app.set_graph_mode,
                              tooltip="Which live graph to display "
                                      "(keys 1, 2, 3)")
        self.widgets = [
            self._seg,
            Button((self.rect.right - 32, y, 24, 24),
                   lambda: app.set_graph_mode("Off"), "", icon="close",
                   style="ghost", tooltip="Close the graph dock"),
            Button((self.rect.right - 60, y, 24, 24), self._clear_data, "",
                   icon="trash", style="ghost",
                   tooltip="Clear all collected graph data"),
        ]

    def _clear_data(self) -> None:
        app = self.app
        app.energy_series.clear()
        app.momentum_series.clear()
        app.phase_plot.clear()

    def _active_series(self):
        app = self.app
        return {"Energy": app.energy_series,
                "Mom.": app.momentum_series}.get(app.graph_mode)

    def handle_event(self, event, mouse) -> bool:
        if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1 \
                and self.rect.collidepoint(mouse):
            series = self._active_series()
            if series is not None and series.legend_click(mouse):
                return True
        return super().handle_event(event, mouse)

    def _hint(self) -> str:
        """Why the plotted conserved quantity may legitimately change."""
        app = self.app
        w = app.world
        if app.graph_mode == "Mom.":
            ext = []
            if w.gravity != 0.0:
                ext.append("gravity")
            if any(b.inv_mass == 0.0 for b in w.bodies):
                ext.append("fixed anchors")
            if w.walls:
                ext.append("walls")
            if w.drag_linear or w.drag_quadratic or w.global_damping:
                ext.append("drag/damping")
            if any(d.enabled for d in w.drivers) or \
                    any(f.enabled for f in w.fields):
                ext.append("drivers/fields")
            if ext:
                return ("momentum is only conserved in isolation - " +
                        ", ".join(ext) + " exert external forces here")
            return "isolated system: total momentum should stay constant"
        if app.graph_mode == "Energy":
            lossy = []
            if w.drag_linear or w.drag_quadratic:
                lossy.append("air drag")
            if w.global_damping:
                lossy.append("global damping")
            if any(isinstance(ln, SpringLink) and ln.damping > 0
                   for ln in w.links):
                lossy.append("spring damping")
            if lossy:
                return "energy is removed by " + ", ".join(lossy)
        return ""

    def draw(self, surface, mouse) -> None:
        app = self.app
        pygame.draw.rect(surface, theme.PANEL, self.rect)
        pygame.draw.line(surface, theme.OUTLINE, self.rect.topleft,
                         self.rect.topright)
        # resize grip on the draggable top edge
        pygame.draw.rect(surface, theme.TEXT_FAINT,
                         (self.rect.centerx - 16, self.rect.y + 2, 32, 3), 0, 2)
        hint = self._hint()
        if hint:
            x0 = self._seg.rect.right + 12
            max_w = self.rect.right - 66 - x0
            if max_w > 80:
                f = theme.font(11)
                if f.size(hint)[0] > max_w:
                    while hint and f.size(hint + "...")[0] > max_w:
                        hint = hint[:-1]
                    hint += "..."
                blit_text(surface, hint, (x0, self._seg.rect.centery), 11,
                          theme.TEXT_FAINT, False, "midleft")
        plot_rect = pygame.Rect(self.rect.x + 10, self.rect.y + 38,
                                self.rect.w - 20, self.rect.h - 46)
        if app.graph_mode == "Energy":
            app.energy_series.draw(surface, plot_rect, "Energy (J)")
        elif app.graph_mode == "Mom.":
            app.momentum_series.draw(surface, plot_rect,
                                     "Momentum p (kg m/s) and angular momentum L")
        elif app.graph_mode == "Phase":
            body = next((o for o in app.selection if isinstance(o, Body)), None)
            name = body.name if body else "select a body"
            # two SQUARE plots (x-vx and y-vy) so orbits aren't stretched
            # by the dock's wide aspect ratio
            side = min(plot_rect.h, (plot_rect.w - 12) // 2)
            x0 = plot_rect.x + (plot_rect.w - (2 * side + 12)) // 2
            left = pygame.Rect(x0, plot_rect.y, side, side)
            right = pygame.Rect(x0 + side + 12, plot_rect.y, side, side)
            app.phase_plot.draw(surface, left, f"{name}:  x - vx", "x")
            app.phase_plot.draw(surface, right, f"{name}:  y - vy", "y")
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
        res = f"dt/{app._q_now}   " if app.playing and app._q_now > 1 else ""
        info = f"{wp.x:.2f}, {wp.y:.2f} m   |   {n_dyn} bodies   " \
               f"{len(app.world.contacts)} contacts   {res}{drift}"
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
HELP_SECTIONS = [
    ("Playback", [
        ("Space", "Play / pause"),
        (". / ,", "Step a frame forward / back"),
        ("+ / -", "Double / halve the speed"),
        ("0", "Reset speed to 1x"),
        ("Ctrl+R", "Reset the simulation"),
        ("t = box", "Type a time to jump to it"),
    ]),
    ("Tools", [
        ("V", "Select / move"),
        ("H", "Pan"),
        ("B / A", "Add body / anchor"),
        ("W", "Draw wall"),
        ("R / E / S", "Rod / string / spring"),
        ("X", "Eraser"),
    ]),
    ("Camera & view", [
        ("Scroll", "Zoom at the cursor"),
        ("Mid drag", "Pan the view"),
        ("F", "Zoom to fit, once"),
        ("Shift+F", "Auto-fit camera on / off"),
        ("C", "Follow the selected body"),
        ("N", "Snap to grid"),
        ("T", "Motion trails"),
        ("D", "Velocity vectors"),
        ("G", "Broadphase grid"),
    ]),
    ("Selection & editing", [
        ("Drag body", "Move it (throw while playing)"),
        ("Right-drag body", "Aim its velocity"),
        ("Shift+click", "Add to the selection"),
        ("Drag empty space", "Box select"),
        ("Arrows", "Nudge the selection"),
        ("K", "Lock / unlock selection"),
        ("Ctrl+D", "Duplicate"),
        ("Del", "Delete"),
        ("Ctrl+C / V", "Copy / paste properties"),
        ("Ctrl+Z / Y", "Undo / redo"),
        ("Esc", "Cancel draw / clear selection"),
    ]),
    ("Graphs & analysis", [
        ("1 / 2 / 3", "Energy / momentum / phase graph"),
        ("Click legend", "Show / hide a channel"),
        ("Drag dock edge", "Resize the graphs"),
    ]),
    ("Panels & app", [
        ("Tab", "Show / hide the right panel"),
        ("Drag panel edge", "Resize it"),
        ("L", "Simulation library"),
        ("Ctrl+S", "Quick-save the scene"),
        ("F1", "This help"),
    ]),
]


class HelpOverlay(PanelBase):
    """Sectioned, scrollable shortcut reference with key chips."""

    ROW_H = 21
    HEAD_H = 26
    GAP = 10
    KEY_COL = 136

    def __init__(self, app) -> None:
        super().__init__(app)
        self.visible = False
        self.scroll = 0
        self._cols: list[list] = [[], []]
        self._col_h = 0

    @classmethod
    def _section_h(cls, sec) -> int:
        return cls.HEAD_H + len(sec[1]) * cls.ROW_H + cls.GAP

    def relayout(self) -> None:
        app = self.app
        # balance the sections across two columns greedily
        cols: list[list] = [[], []]
        heights = [0, 0]
        for sec in HELP_SECTIONS:
            i = 0 if heights[0] <= heights[1] else 1
            cols[i].append(sec)
            heights[i] += self._section_h(sec)
        self._cols = cols
        self._col_h = max(heights)
        w = min(900, app.width - 80)
        h = min(self._col_h + 104, app.height - 60)
        self.rect = pygame.Rect((app.width - w) // 2, (app.height - h) // 2, w, h)
        self.scroll = 0
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

    def _content_rect(self) -> pygame.Rect:
        return pygame.Rect(self.rect.x + 20, self.rect.y + 46,
                           self.rect.w - 40, self.rect.h - 96)

    def handle_event(self, event, mouse) -> bool:
        if not self.visible:
            return False
        if event.type == pygame.KEYDOWN and event.key in (pygame.K_ESCAPE, pygame.K_F1):
            self.visible = False
            return True
        if event.type == pygame.MOUSEWHEEL and self.rect.collidepoint(mouse):
            max_scroll = max(0, self._col_h - self._content_rect().h)
            self.scroll = min(max_scroll, max(0, self.scroll - event.y * 40))
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
        app = self.app
        dim = pygame.Surface((app.width, app.height), pygame.SRCALPHA)
        dim.fill((8, 9, 12, 180))
        surface.blit(dim, (0, 0))
        pygame.draw.rect(surface, theme.PANEL, self.rect, 0, 10)
        pygame.draw.rect(surface, theme.OUTLINE, self.rect, 1, 10)
        blit_text(surface, "Help & keyboard shortcuts",
                  (self.rect.x + 16, self.rect.y + 12), 16, theme.TEXT, True)
        content = self._content_rect()
        clip = surface.get_clip()
        surface.set_clip(content)
        col_w = (content.w - 24) // 2
        f_key = theme.font(11, True)
        for ci, secs in enumerate(self._cols):
            x = content.x + ci * (col_w + 24)
            y = content.y - self.scroll
            for title, items in secs:
                blit_text(surface, title.upper(), (x, y + 6), 11,
                          theme.TEXT_FAINT, True)
                tw = f_key.size(title.upper())[0]
                pygame.draw.line(surface, theme.OUTLINE,
                                 (x + tw + 10, y + 13), (x + col_w, y + 13))
                y += self.HEAD_H
                for keys, desc in items:
                    chip = pygame.Rect(x, y + 1, f_key.size(keys)[0] + 12, 17)
                    pygame.draw.rect(surface, theme.PANEL_LIGHT, chip, 0, 4)
                    blit_text(surface, keys, (chip.x + 6, chip.centery), 11,
                              theme.ACCENT, True, "midleft")
                    blit_text(surface, desc, (x + self.KEY_COL, y + 3), 12,
                              theme.TEXT_DIM)
                    y += self.ROW_H
                y += self.GAP
        surface.set_clip(clip)
        if self._col_h > content.h:
            blit_text(surface, "scroll for more", (self.rect.centerx,
                      self.rect.bottom - 26), 11, theme.TEXT_FAINT, False,
                      "midtop")
        blit_text(surface, "Tip: the World tab has a formula reference for "
                  "custom force fields.",
                  (self.rect.right - 20, self.rect.bottom - 26), 11,
                  theme.TEXT_FAINT, False, "topright")
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
             "anchors, draw walls, or connect bodies with rods, strings and "
             "springs. Hover any icon for its shortcut.",
             app.palette.rect),
            ("The canvas",
             "Scroll to zoom, middle-drag to pan, press F to frame "
             "everything. Drag bodies to move them (throw them while "
             "playing!), and right-drag a body - or its green arrow tip - "
             "to aim its velocity.",
             app.canvas_rect()),
            ("Playback",
             "Play, pause, single-step and reset here. The speed slider "
             "slows time down for fast events, and you can type a time to "
             "jump straight to it.", pygame.Rect(120, 0, 480, TOOLBAR_H)),
            ("Inspector",
             "Everything about the selected object - mass, velocity, "
             "materials, forces - plus world settings (gravity, drag, the "
             "solver, custom force fields) and view overlays live in these "
             "three tabs. Drag the panel's edge to resize it, or press Tab "
             "to hide it.",
             app.inspector.rect),
            ("Library",
             "Almost fifty ready-made simulations: orbits, three-body "
             "chaos, springs, soft bodies, gases and more. Your own scenes "
             "can be saved there too. Press L any time.",
             pygame.Rect(app.width - 320, 0, 200, TOOLBAR_H)),
            ("Analyse",
             "In the View tab you can show velocity and force vectors, "
             "motion trails, an auto-fit camera, and live graphs of energy, "
             "momentum and phase space (resizable, along the bottom). Have "
             "fun experimenting!",
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
