"""Mechanica application: window, main loop, event routing and playback."""
from __future__ import annotations

import json
import os
import time
from math import isfinite

import pygame

from mechanica.engine.body import Body, Wall
from mechanica.engine.world import World
from mechanica.interact.tools import TOOL_KEYS, CanvasController
from mechanica.render.camera import MAX_ZOOM, MIN_ZOOM, Camera
from mechanica.render.draw import (ViewSettings, draw_grid, draw_scale_bar,
                                   draw_world)
from mechanica.scene import snapshot as snap
from mechanica.scene.presets import PRESETS, Preset
from mechanica.scene.snapshot import UndoStack
from mechanica.ui import theme
from mechanica.ui.panels import (COLLAPSED_W, DOCK_H, HINT_H, INSPECTOR_W,
                                 PALETTE_W, TOOLBAR_H, GraphDock, HelpOverlay,
                                 HintBar, Inspector, LibraryOverlay, Palette,
                                 Toolbar, TourOverlay)
from mechanica.ui.plots import PhasePlot, TimeSeries
from mechanica.ui.theme import blit_text
from mechanica.ui.widgets import UIState

PHYSICS_DT = 1.0 / 120.0
MAX_STEPS_PER_FRAME = 24   # bounds catch-up work per frame at high speeds
SETTINGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "settings.json")


class App:
    def __init__(self) -> None:
        pygame.init()
        pygame.key.set_repeat(400, 35)
        info = pygame.display.Info()
        self.width = min(1440, info.current_w - 60)
        self.height = min(860, info.current_h - 90)
        self.screen = pygame.display.set_mode((self.width, self.height),
                                              pygame.RESIZABLE)
        pygame.display.set_caption("Mechanica - Physics Lab")

        self.settings = self._load_settings()
        self.ui = UIState()
        self.world = World()
        self.camera = Camera(self.width, self.height)
        self.view = ViewSettings()
        self.selection: list = []
        # which object types a box (rubber-band) selection picks up
        self.box_filter = {"bodies": True, "walls": True,
                           "springs": True, "rods": True}
        self.canvas = CanvasController(self)

        self.playing = False
        self.speed = 1.0
        self.accumulator = 0.0
        self.fps_cap = 120
        self.fps_cap_label = "120"
        self.fps_now = 0.0
        self.dt_frame = 0.0
        self.running = True
        self.overloaded = False

        self.undo_stack = UndoStack(self.world)
        self.initial_snapshot: str | None = None
        self.baseline_energy: float | None = None
        self.clipboard_props: dict | None = None

        self.trails: dict[int, list] = {}
        self.energy_series = TimeSeries(["KE", "PE", "Total"])
        self.momentum_series = TimeSeries(["|p|", "px", "py", "L"])
        self.phase_plot = PhasePlot()
        self._phase_body_id: int | None = None
        self.graph_mode = "Off"

        # user-resizable panel geometry, persisted across sessions
        self.inspector_visible = bool(self.settings.get("inspector_visible", True))
        try:
            self.inspector_w = int(self.settings.get("inspector_w", INSPECTOR_W))
            self.dock_h = int(self.settings.get("dock_h", DOCK_H))
        except (TypeError, ValueError):
            self.inspector_w, self.dock_h = INSPECTOR_W, DOCK_H
        self._split_drag: str | None = None
        self._cursor = pygame.SYSTEM_CURSOR_ARROW
        self._clamp_panel_sizes()

        self.toasts: list[list] = []

        self._nudge_dirty = False
        self._nudge_deadline = 0.0
        self._diverge_cooldown = 0.0

        self.toolbar = Toolbar(self)
        self.palette = Palette(self)
        self.inspector = Inspector(self)
        self.dock = GraphDock(self)
        self.hintbar = HintBar(self)
        self.library = LibraryOverlay(self)
        self.help = HelpOverlay(self)
        self.tour = TourOverlay(self)
        self.relayout_all()

        if self.settings.get("fps_cap") in ("30", "60", "120", "Max"):
            self.set_fps_cap(self.settings["fps_cap"])
        self.view.antialias = bool(self.settings.get("antialias", True))
        if not self.settings.get("tour_done"):
            self.tour.start()
        self.load_preset(PRESETS[0], announce=False)
        self.toast("Welcome! Press L for the library, F1 for help.")

    # ------------------------------------------------------------- settings
    def _load_settings(self) -> dict:
        try:
            with open(SETTINGS_PATH, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return {}

    def _save_settings(self) -> None:
        try:
            with open(SETTINGS_PATH, "w", encoding="utf-8") as fh:
                json.dump(self.settings, fh)
        except OSError:
            pass

    def mark_tour_done(self) -> None:
        self.settings["tour_done"] = True
        self._save_settings()

    # --------------------------------------------------------------- layout
    def relayout_all(self) -> None:
        self.camera.resize(self.width, self.height)
        self.toolbar.relayout()
        self.palette.relayout()
        self.inspector.relayout()
        self.dock.relayout()
        self.hintbar.relayout()
        if self.library.visible:
            self.library.relayout()
        if self.help.visible:
            self.help.relayout()

    def canvas_rect(self) -> pygame.Rect:
        bottom = self.height - HINT_H - (self.dock_h if self.graph_mode != "Off" else 0)
        right = self.inspector_w if self.inspector_visible else COLLAPSED_W
        return pygame.Rect(PALETTE_W, TOOLBAR_H,
                           self.width - PALETTE_W - right,
                           bottom - TOOLBAR_H)

    # ------------------------------------------------- resizable panel edges
    def _clamp_panel_sizes(self) -> None:
        """Keep the user-resizable panels within sane bounds for the window."""
        max_w = min(620, max(240, self.width - PALETTE_W - 320))
        self.inspector_w = int(min(max_w, max(240, self.inspector_w)))
        max_h = max(110, self.height - TOOLBAR_H - HINT_H - 220)
        self.dock_h = int(min(max_h, max(110, self.dock_h)))

    def toggle_inspector(self) -> None:
        self.inspector_visible = not self.inspector_visible
        self.settings["inspector_visible"] = self.inspector_visible
        self._save_settings()
        self.relayout_all()
        if not self.inspector_visible:
            self.toast("Panel hidden - press Tab or click the right edge to reopen")

    def _split_rect_inspector(self) -> pygame.Rect | None:
        if not self.inspector_visible:
            return None
        r = self.inspector.rect
        return pygame.Rect(r.x - 3, r.y, 7, r.h)

    def _split_rect_dock(self) -> pygame.Rect | None:
        if self.graph_mode == "Off":
            return None
        r = self.dock.rect
        return pygame.Rect(r.x, r.y - 3, r.w, 7)

    def _handle_split(self, event: pygame.event.Event, mouse) -> bool:
        """Drag the inspector's left edge or the dock's top edge to resize."""
        if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
            self._split_drag = None
            for name, rect in (("inspector", self._split_rect_inspector()),
                               ("dock", self._split_rect_dock())):
                if rect is not None and rect.collidepoint(mouse):
                    self._split_drag = name
                    return True
            return False
        if self._split_drag is None:
            return False
        if event.type == pygame.MOUSEMOTION:
            if self._split_drag == "inspector":
                self.inspector_w = self.width - mouse[0]
            else:
                self.dock_h = self.height - HINT_H - mouse[1]
            self._clamp_panel_sizes()
            self.relayout_all()
            return True
        if event.type == pygame.MOUSEBUTTONUP and event.button == 1:
            self._split_drag = None
            self.settings["inspector_w"] = self.inspector_w
            self.settings["dock_h"] = self.dock_h
            self._save_settings()
            return True
        return False

    def _update_cursor(self, mouse) -> None:
        cur = pygame.SYSTEM_CURSOR_ARROW
        if self._split_drag == "inspector":
            cur = pygame.SYSTEM_CURSOR_SIZEWE
        elif self._split_drag == "dock":
            cur = pygame.SYSTEM_CURSOR_SIZENS
        elif not (self.library.visible or self.help.visible or self.tour.visible
                  or pygame.mouse.get_pressed()[0]):
            r = self._split_rect_inspector()
            if r and r.collidepoint(mouse):
                cur = pygame.SYSTEM_CURSOR_SIZEWE
            else:
                r = self._split_rect_dock()
                if r and r.collidepoint(mouse):
                    cur = pygame.SYSTEM_CURSOR_SIZENS
        if cur != self._cursor:
            self._cursor = cur
            try:
                pygame.mouse.set_cursor(cur)
            except pygame.error:
                pass  # headless / dummy video driver has no cursor

    # ------------------------------------------------------------- playback
    def toggle_play(self) -> None:
        self.ensure_initial()
        self.playing = not self.playing

    @staticmethod
    def _safe_step(world: World, dt: float) -> bool:
        """Step the world, converting a mid-step numerical blow-up (e.g.
        absurd user settings overflowing a float) into frozen bodies via
        _sanitize instead of crashing the app."""
        try:
            world.step(dt)
            return True
        except (OverflowError, ValueError, FloatingPointError,
                ZeroDivisionError):
            world._contact_cache.clear()   # may hold junk impulses
            world._sanitize()
            if not world.diverged:
                world.diverged.append("a body")
            return False

    def step_once(self) -> None:
        self.ensure_initial()
        self.playing = False
        # one 60 Hz frame, stepped at the normal rate so accuracy matches play
        self._safe_step(self.world, PHYSICS_DT)
        self._safe_step(self.world, PHYSICS_DT)
        self._after_physics()

    def ensure_initial(self) -> None:
        if self.initial_snapshot is None:
            self.initial_snapshot = snap.snapshot(self.world)
            self.baseline_energy = self.world.energy()["total"]

    def reset_sim(self) -> None:
        if self.initial_snapshot is None:
            return
        self.replace_world(snap.restore(self.initial_snapshot))
        self.playing = False
        self.toast("Reset to the initial state")

    def commit_time_jump(self, text: str) -> bool:
        try:
            target = float(text)
        except ValueError:
            return False
        if target < 0 or not isfinite(target):
            return False
        self.ensure_initial()
        world = snap.restore(self.initial_snapshot)
        steps = int(round((target - world.time) / PHYSICS_DT))
        if steps < 0:
            return False
        if steps > 20000:
            steps = 20000
            self.toast("Time jump capped at "
                       f"{world.time + steps * PHYSICS_DT:.0f} s")
        for _ in range(steps):
            if not self._safe_step(world, PHYSICS_DT):
                break
        self.replace_world(world, keep_initial=True)
        self.playing = False
        return True

    def replace_world(self, world: World, keep_initial: bool = False) -> None:
        self.world = world
        self.selection = []
        self.canvas.hover = None
        self.canvas.abort_drag()
        self.trails.clear()
        self.energy_series.clear()
        self.momentum_series.clear()
        self.phase_plot.clear()
        if not keep_initial:
            self.initial_snapshot = None
            self.baseline_energy = None

    @property
    def sim_time(self) -> float:
        return self.world.time

    # ------------------------------------------------------------ undo/redo
    def push_undo(self) -> None:
        self.undo_stack.push(self.world)
        if self.world.time == 0.0:
            self.initial_snapshot = snap.snapshot(self.world)
            self.baseline_energy = self.world.energy()["total"]

    def undo(self) -> None:
        world = self.undo_stack.undo()
        if world is not None:
            self.replace_world(world)
            self.playing = False

    def redo(self) -> None:
        world = self.undo_stack.redo()
        if world is not None:
            self.replace_world(world)
            self.playing = False

    # ------------------------------------------------------------ scene ops
    def new_scene(self) -> None:
        self.replace_world(World())
        self.playing = False
        self.push_undo()
        self.toast("Scene cleared (Ctrl+Z restores it)")

    def load_preset(self, preset: Preset, announce: bool = True) -> None:
        self.replace_world(preset.build())
        self.playing = False
        self.undo_stack.reset(self.world)
        hints = preset.hints
        self.view.trails = hints.get("trails", False)
        if hints.get("vectors"):
            self.view.vel_vectors = True
        graph = hints.get("graph")
        self.set_graph_mode({"energy": "Energy", "momentum": "Mom.",
                             "phase": "Phase"}.get(graph, self.graph_mode)
                            if graph else self.graph_mode)
        self._frame_preset(hints)   # after the graph dock resizes the canvas
        self.ensure_initial()
        if announce:
            self.toast(f"Loaded '{preset.name}' - press Space to run")

    def _frame_preset(self, hints: dict) -> None:
        """Frame a freshly loaded preset so nothing starts off-screen.

        The zoom is never tighter than a full fit of the initial scene; a
        hint zoom may only widen it (anticipating where the action will go).
        A hint centre is honoured but clamped so the whole scene stays in
        the canvas."""
        cam = self.camera
        bounds = self._scene_bounds()
        if bounds is None:
            cam.centre.set(*hints.get("centre", (0, 0)))
            cam.zoom = hints.get("zoom", 88.0)
            return
        fit_zoom = self._frame_for_bounds(bounds)[2]
        zoom = min(float(hints.get("zoom", fit_zoom)), fit_zoom)
        cx, cy, _ = self._frame_for_bounds(bounds, zoom)
        if "centre" in hints:
            hx, hy = hints["centre"]
            # clamp so every bound stays inside the canvas (guaranteed
            # feasible because zoom <= fit_zoom leaves 15% slack)
            rect = self.canvas_rect()
            min_x, max_x, min_y, max_y = bounds
            cx = min(max(hx, max_x - (rect.right - self.width * 0.5) / zoom),
                     min_x + (self.width * 0.5 - rect.left) / zoom)
            cy = min(max(hy, max_y + (rect.top - self.height * 0.5) / zoom),
                     min_y + (rect.bottom - self.height * 0.5) / zoom)
        cam.zoom = zoom
        cam.centre.set(cx, cy)

    def load_saved_scene(self, name: str) -> None:
        try:
            world = snap.load_scene(name)
        except (OSError, ValueError, KeyError) as exc:
            self.toast(f"Could not load '{name}': {exc}")
            return
        self.replace_world(world)
        self.playing = False
        self.undo_stack.reset(self.world)
        self.ensure_initial()
        self.toast(f"Loaded scene '{name}'")

    # ------------------------------------------------------- property clipboard
    COPYABLE = ("mass", "radius", "restitution", "friction", "locked", "collides")

    def copy_props(self) -> None:
        body = next((o for o in self.selection if isinstance(o, Body)), None)
        if body is None:
            self.toast("Select a body to copy properties from")
            return
        self.clipboard_props = {k: getattr(body, k) for k in self.COPYABLE}
        self.toast(f"Copied properties of {body.name}")

    def paste_props(self) -> None:
        if self.clipboard_props is None:
            return
        bodies = [o for o in self.selection if isinstance(o, Body)]
        for b in bodies:
            for k, v in self.clipboard_props.items():
                setattr(b, k, v)
        if bodies:
            self.push_undo()
            self.toast(f"Pasted properties onto {len(bodies)} body(ies)")

    # ------------------------------------------------------------ view helpers
    def _scene_bounds(self) -> tuple[float, float, float, float] | None:
        """(min_x, max_x, min_y, max_y) enclosing every body and wall."""
        pts: list[tuple[float, float, float]] = []   # (x, y, pad radius)
        for b in self.world.bodies:
            if isfinite(b.pos.x) and isfinite(b.pos.y):
                pts.append((b.pos.x, b.pos.y, b.radius))
        for w in self.world.walls:
            half = w.thickness * 0.5
            pts.append((w.a.x, w.a.y, half))
            pts.append((w.b.x, w.b.y, half))
        if not pts:
            return None
        return (min(p[0] - p[2] for p in pts), max(p[0] + p[2] for p in pts),
                min(p[1] - p[2] for p in pts), max(p[1] + p[2] for p in pts))

    def _frame_for_bounds(self, bounds, zoom: float | None = None
                          ) -> tuple[float, float, float]:
        """Camera (centre_x, centre_y, zoom) framing `bounds` in the canvas.
        With an explicit zoom, only the centre is computed."""
        min_x, max_x, min_y, max_y = bounds
        rect = self.canvas_rect()
        if zoom is None:
            span_x = max(max_x - min_x, 1e-6)
            span_y = max(max_y - min_y, 1e-6)
            zoom = min(rect.w / span_x, rect.h / span_y) * 0.85
            zoom = min(MAX_ZOOM, max(MIN_ZOOM, zoom))
        # place the bounds centre at the canvas centre (canvas != window centre)
        cx = (min_x + max_x) * 0.5
        cy = (min_y + max_y) * 0.5
        return (cx - (rect.centerx - self.width * 0.5) / zoom,
                cy + (rect.centery - self.height * 0.5) / zoom, zoom)

    def _fit_target(self) -> tuple[float, float, float] | None:
        """Camera (centre_x, centre_y, zoom) that frames every body and wall,
        or None for an empty scene."""
        bounds = self._scene_bounds()
        return None if bounds is None else self._frame_for_bounds(bounds)

    def zoom_to_fit(self) -> None:
        """Frame every body and wall in the canvas (F)."""
        cam = self.camera
        target = self._fit_target()
        if target is None:
            cam.centre.set(0.0, 0.0)
            cam.zoom = 88.0
            return
        cam.centre.set(target[0], target[1])
        cam.zoom = target[2]

    def nudge_selection(self, dx: int, dy: int) -> None:
        """Move selected bodies and walls one small step with the arrow keys."""
        bodies = [o for o in self.selection if isinstance(o, Body)]
        walls = [o for o in self.selection if isinstance(o, Wall)]
        if not bodies and not walls:
            return
        from mechanica.render.draw import snap_step
        step = snap_step(self.camera.zoom) if self.view.snap \
            else 8.0 / self.camera.zoom
        for b in bodies:
            b.pos.x += dx * step
            b.pos.y += dy * step
        for w in walls:
            w.a.x += dx * step
            w.a.y += dy * step
            w.b.x += dx * step
            w.b.y += dy * step
        # commit to undo once the burst of key repeats ends
        self._nudge_dirty = True
        self._nudge_deadline = time.monotonic() + 0.5

    def quick_save(self) -> None:
        name = time.strftime("scene %Y-%m-%d %H%M%S")
        saved = snap.save_scene(self.world, name)
        self.toast(f"Saved scene '{saved}' - press L to browse scenes")

    def toggle_follow(self) -> None:
        self.view.follow = not self.view.follow
        if self.view.follow and not any(isinstance(o, Body) for o in self.selection):
            self.toast("Camera follow is on - select a body to track")
        else:
            self.toast(f"Camera follow {'on' if self.view.follow else 'off'}")

    # ---------------------------------------------------------------- misc UI
    def set_graph_mode(self, mode: str) -> None:
        self.graph_mode = mode
        self.inspector.relayout()
        self.dock.relayout()

    def set_fps_cap(self, label: str) -> None:
        self.fps_cap_label = label
        self.fps_cap = {"30": 30, "60": 60, "120": 120, "Max": 240}[label]
        if getattr(self, "settings", None) is not None \
                and self.settings.get("fps_cap") != label:
            self.settings["fps_cap"] = label
            self._save_settings()

    def set_antialias(self, on: bool) -> None:
        self.view.antialias = on
        self.settings["antialias"] = on
        self._save_settings()

    def toggle_library(self) -> None:
        if self.library.visible:
            self.library.close()
        else:
            self.library.open()

    def toggle_help(self) -> None:
        self.help.visible = not self.help.visible
        if self.help.visible:
            self.help.relayout()

    def toast(self, msg: str) -> None:
        self.toasts.append([msg, 3.2])

    def energy_drift_text(self) -> str:
        if self.baseline_energy is None:
            return ""
        e = self.world.energy()["total"]
        base = self.baseline_energy
        if abs(base) < 1e-9:
            return f"dE {e - base:+.3g} J"
        return f"dE {100 * (e - base) / abs(base):+.2f}%"

    # ------------------------------------------------------------ event loop
    def run(self) -> None:
        clock = pygame.time.Clock()
        while self.running:
            self.dt_frame = clock.tick(self.fps_cap) / 1000.0
            self.fps_now = clock.get_fps()
            mouse = pygame.mouse.get_pos()
            for event in pygame.event.get():
                self._route_event(event, mouse)
            self._update_cursor(mouse)
            # keep held bodies pinned even when the mouse isn't moving
            self.canvas.update_drag(mouse)
            self._update(self.dt_frame)
            self._render(mouse)
            pygame.display.flip()
        pygame.quit()

    def _route_event(self, event: pygame.event.Event, mouse) -> None:
        if event.type == pygame.QUIT:
            self.running = False
            return
        if event.type == pygame.VIDEORESIZE:
            self.width = max(900, event.w)
            self.height = max(600, event.h)
            self.screen = pygame.display.set_mode((self.width, self.height),
                                                  pygame.RESIZABLE)
            self._clamp_panel_sizes()
            self.relayout_all()
            return
        if self.tour.handle_event(event, mouse):
            return
        if self.help.handle_event(event, mouse):
            return
        if self.library.handle_event(event, mouse):
            return
        if self._handle_split(event, mouse):
            return
        for panel in (self.toolbar, self.palette, self.inspector,
                      self.dock if self.graph_mode != "Off" else None):
            if panel is not None and panel.handle_event(event, mouse):
                return
        if self.ui.focus is None and event.type == pygame.KEYDOWN:
            if self._shortcut(event):
                return
        if self.canvas_rect().collidepoint(mouse) or event.type in (
                pygame.MOUSEBUTTONUP, pygame.MOUSEMOTION, pygame.KEYDOWN):
            self.canvas.handle_event(event, mouse)

    def _shortcut(self, event: pygame.event.Event) -> bool:
        key = event.key
        mods = pygame.key.get_mods()
        ctrl = mods & pygame.KMOD_CTRL
        if ctrl:
            if key == pygame.K_z:
                self.redo() if mods & pygame.KMOD_SHIFT else self.undo()
            elif key == pygame.K_y:
                self.redo()
            elif key == pygame.K_d:
                self.canvas.duplicate_selection()
            elif key == pygame.K_r:
                self.reset_sim()
            elif key == pygame.K_c:
                self.copy_props()
            elif key == pygame.K_v:
                self.paste_props()
            elif key == pygame.K_s:
                self.quick_save()
            else:
                return False
            return True
        if key == pygame.K_SPACE:
            self.toggle_play()
        elif key == pygame.K_PERIOD:
            self.step_once()
        elif key in (pygame.K_DELETE, pygame.K_BACKSPACE):
            self.canvas.delete_selection()
        elif key in TOOL_KEYS:
            self.canvas.set_tool(TOOL_KEYS[key])
        elif key == pygame.K_n:
            self.view.snap = not self.view.snap
            self.toast(f"Snap to grid {'on' if self.view.snap else 'off'}")
        elif key == pygame.K_t:
            self.view.trails = not self.view.trails
        elif key == pygame.K_g:
            self.view.spatial_grid = not self.view.spatial_grid
        elif key == pygame.K_f:
            self.zoom_to_fit()
        elif key == pygame.K_c:
            self.toggle_follow()
        elif key == pygame.K_l:
            self.toggle_library()
        elif key == pygame.K_TAB:
            self.toggle_inspector()
        elif key == pygame.K_F1:
            self.toggle_help()
        elif key in (pygame.K_UP, pygame.K_DOWN, pygame.K_LEFT, pygame.K_RIGHT):
            self.nudge_selection(
                (key == pygame.K_RIGHT) - (key == pygame.K_LEFT),
                (key == pygame.K_UP) - (key == pygame.K_DOWN))
        elif key == pygame.K_ESCAPE:
            # cancel an in-progress link/wall first, then clear the selection
            if not self.canvas.cancel_pending():
                self.selection = []
        else:
            return False
        return True

    # ---------------------------------------------------------------- update
    def _update(self, dt_frame: float) -> None:
        self.inspector.maybe_rebuild()
        for t in self.toasts:
            t[1] -= dt_frame
        self.toasts = [t for t in self.toasts if t[1] > 0]

        if self._nudge_dirty and time.monotonic() > self._nudge_deadline:
            self._nudge_dirty = False
            self.push_undo()

        if self.playing:
            # Below 1x, keep stepping at the normal 120 Hz real-time rate but
            # with a proportionally smaller dt: slow motion then produces a
            # fresh state every frame (glassy smooth, and *more* accurate)
            # instead of one full-size step every few frames (choppy).
            eff_dt = PHYSICS_DT * min(self.speed, 1.0)
            self.accumulator += dt_frame * self.speed
            steps = 0
            while self.accumulator >= eff_dt and steps < MAX_STEPS_PER_FRAME:
                self._safe_step(self.world, eff_dt)
                self.accumulator -= eff_dt
                steps += 1
            self.overloaded = self.accumulator >= eff_dt
            if self.overloaded:
                self.accumulator = 0.0
            self._after_physics()
            if self.world.diverged and time.monotonic() > self._diverge_cooldown:
                self._diverge_cooldown = time.monotonic() + 5.0
                names = ", ".join(self.world.diverged[:3])
                self.toast(f"{names} hit a numerical blow-up and was frozen "
                           "- check extreme forces or fields")

        if self.view.auto_fit:
            target = self._fit_target()
            if target is not None:
                cam = self.camera
                # zoom out quickly so escapers stay in frame; zoom back in
                # gently so bounces don't make the view pump
                rate = 6.0 if target[2] < cam.zoom else 1.2
                k = min(1.0, dt_frame * rate)
                cam.zoom *= (target[2] / cam.zoom) ** k
                blend = min(1.0, dt_frame * 4.0)
                cam.centre.x += (target[0] - cam.centre.x) * blend
                cam.centre.y += (target[1] - cam.centre.y) * blend
        elif self.view.follow:
            body = next((o for o in self.selection
                         if isinstance(o, Body) and isfinite(o.pos.x)
                         and isfinite(o.pos.y)), None)
            if body is not None:
                cam = self.camera
                blend = min(1.0, dt_frame * 8.0)
                cam.centre.x += (body.pos.x - cam.centre.x) * blend
                cam.centre.y += (body.pos.y - cam.centre.y) * blend

    def _after_physics(self) -> None:
        # trails
        if self.view.trails:
            maxlen = self.view.trail_len
            for b in self.world.bodies:
                if b.locked:
                    continue
                pts = self.trails.setdefault(b.id, [])
                if not pts or (abs(pts[-1][0] - b.pos.x) + abs(pts[-1][1] - b.pos.y)
                               > 0.5 / self.camera.zoom):
                    pts.append((b.pos.x, b.pos.y))
                    if len(pts) > maxlen:
                        del pts[:len(pts) - maxlen]
        # graphs: every series records continuously whatever the dock shows,
        # so switching graph views (or closing and reopening the dock) never
        # leaves gaps in the data
        e = self.world.energy()
        self.energy_series.add(self.world.time,
                               {"KE": e["ke"], "PE": e["pe"],
                                "Total": e["total"]})
        p = self.world.momentum()
        self.momentum_series.add(self.world.time,
                                 {"|p|": p.length(), "px": p.x, "py": p.y,
                                  "L": self.world.angular_momentum()})
        body = next((o for o in self.selection if isinstance(o, Body)), None)
        if body is not None:
            if body.id != self._phase_body_id:
                self._phase_body_id = body.id
                self.phase_plot.clear()
            self.phase_plot.add(body.pos.x, body.vel.x,
                                body.pos.y, body.vel.y)

    # ---------------------------------------------------------------- render
    def _render(self, mouse) -> None:
        screen = self.screen
        screen.fill(theme.BG)
        self.ui.begin_frame()
        area = self.canvas_rect()
        clip = screen.get_clip()
        screen.set_clip(area)
        if self.view.grid:
            draw_grid(screen, self.camera, area)
        draw_world(screen, self.camera, self.world, self.view, self.selection,
                   self.canvas.hover, self.trails, area)
        self.canvas.draw_overlays(screen, mouse)
        draw_scale_bar(screen, self.camera, area)
        if self.overloaded and self.playing:
            blit_text(screen, "slow: physics can't keep up - reduce substeps "
                      "or bodies", (area.centerx, area.y + 10), 12, theme.WARN,
                      False, "midtop")
        if self.playing:
            pygame.draw.circle(screen, theme.GOOD, (area.x + 14, area.y + 14), 5)
        screen.set_clip(clip)

        self.toolbar.draw(screen, mouse)
        self.palette.draw(screen, mouse)
        self.inspector.draw(screen, mouse)
        if self.graph_mode != "Off":
            self.dock.draw(screen, mouse)
        self.hintbar.draw(screen, mouse)
        self.library.draw(screen, mouse)
        self.help.draw(screen, mouse)
        self.tour.draw(screen, mouse)
        self._draw_toasts()
        # tooltips from panels underneath a modal overlay must not show through
        self.ui.end_frame(blocked=self.library.visible or self.help.visible
                          or self.tour.visible)
        self._draw_tooltip(mouse)

    def _draw_toasts(self) -> None:
        y = self.height - HINT_H - 40
        for msg, ttl in reversed(self.toasts[-3:]):
            img = theme.text(msg, 13, theme.TEXT)
            w = img.get_width() + 28
            right = self.inspector_w if self.inspector_visible else COLLAPSED_W
            rect = pygame.Rect((self.width - right + PALETTE_W - w) // 2,
                               y - 30, w, 30)
            s = pygame.Surface(rect.size, pygame.SRCALPHA)
            alpha = min(1.0, ttl / 0.4)
            s.fill((20, 22, 27, int(230 * alpha)))
            self.screen.blit(s, rect.topleft)
            pygame.draw.rect(self.screen, theme.OUTLINE, rect, 1, 8)
            self.screen.blit(img, (rect.x + 14, rect.centery - img.get_height() // 2))
            y -= 36

    def _draw_tooltip(self, mouse) -> None:
        tip = self.ui.tooltip
        if not tip:
            return
        lines = theme.wrap_text(tip, 12, 260)
        w = max(theme.font(12).size(line)[0] for line in lines) + 16
        h = len(lines) * 17 + 10
        x = min(mouse[0] + 14, self.width - w - 6)
        y = min(mouse[1] + 18, self.height - h - 6)
        rect = pygame.Rect(x, y, w, h)
        pygame.draw.rect(self.screen, (20, 22, 27), rect, 0, 6)
        pygame.draw.rect(self.screen, theme.OUTLINE, rect, 1, 6)
        for i, line in enumerate(lines):
            blit_text(self.screen, line, (x + 8, y + 5 + i * 17), 12, theme.TEXT)


def main() -> None:
    App().run()
