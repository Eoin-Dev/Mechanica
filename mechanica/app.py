"""Mechanica application: window, main loop, event routing and playback."""
from __future__ import annotations

import json
import os
import time
from collections import deque
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
# wall-clock ceiling for physics per frame: however heavy the scene, the
# UI keeps redrawing at ~20 fps and stays clickable (the sim just runs
# slower than real time, with the existing "can't keep up" warning)
PHYSICS_BUDGET_S = 0.045
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
        # adaptive time resolution: extra, smaller physics steps during
        # fast close encounters, budgeted against real frame headroom
        self.adaptive_dt = True
        self._phys_res = 1        # current subdivision (with hysteresis)
        self._q_now = 1           # what actually ran this frame (for the UI)
        self._step_ms = 0.2       # EMA of wall-clock ms per world step
        self._last_phys_ms = 0.0  # physics wall time spent last frame

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
        self.adaptive_dt = bool(self.settings.get("adaptive_dt", True))
        self.inspector_visible = bool(self.settings.get("inspector_visible", True))
        try:
            self.inspector_w = int(self.settings.get("inspector_w", INSPECTOR_W))
            self.dock_h = int(self.settings.get("dock_h", DOCK_H))
        except (TypeError, ValueError):
            self.inspector_w, self.dock_h = INSPECTOR_W, DOCK_H
        self._split_drag: str | None = None
        self._cursor = pygame.SYSTEM_CURSOR_ARROW
        self._autofit_ratio = 1.0    # user zoom-out factor while auto-fitting
        self._autofit_zt: float | None = None
        self._history: deque = deque(maxlen=600)   # per-frame rewind states
        self._overload_since: float | None = None  # sustained-lag detection
        self._overload_hint_at = 0.0
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
        for _ in range(2):
            self._safe_step(self.world, PHYSICS_DT)
            self._record_trails()
        self._after_physics()

    def step_back(self) -> None:
        """Rewind the simulation by one displayed frame (,)."""
        self.playing = False
        state = None
        if len(self._history) >= 2:
            self._history.pop()           # the frame we are on
            state = self._history[-1]     # the one before it
        elif self.initial_snapshot is not None:
            self._history.clear()
            state = self.initial_snapshot
        if state is None:
            return
        sel_ids = {o.id for o in self.selection if isinstance(o, Body)}
        world = snap.restore(state)
        self.world = world
        self.canvas.hover = None
        self.canvas.abort_drag()
        self.selection = [b for b in world.bodies if b.id in sel_ids]
        # trim graphs back to the rewound time instead of wiping them
        self.energy_series.truncate(world.time)
        self.momentum_series.truncate(world.time)

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
        self._history.clear()
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
        self._autofit_ratio = 1.0
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

    def toggle_auto_fit(self) -> None:
        self.view.auto_fit = not self.view.auto_fit
        self._autofit_ratio = 1.0
        self.toast("Auto-fit camera "
                   + ("on - framing the whole scene (scroll out any time)"
                      if self.view.auto_fit else "off"))

    def note_user_zoom(self) -> None:
        """Called after a manual scroll-zoom. With auto-fit active the user
        may zoom out freely (auto-fit keeps tracking at that wider framing)
        but can never zoom in tighter than the current fit level."""
        if not self.view.auto_fit:
            return
        target = self._fit_target()
        if target is None:
            return
        zt = target[2]
        if self.camera.zoom > zt:
            self.camera.zoom = zt
        self._autofit_ratio = max(0.02, min(1.0, self.camera.zoom / zt))

    def _clamp_camera_to_bounds(self) -> None:
        """Zoom out and shift the camera just enough that every body and
        wall is inside the canvas right now."""
        bounds = self._scene_bounds()
        if bounds is None:
            return
        min_x, max_x, min_y, max_y = bounds
        rect = self.canvas_rect()
        cam = self.camera
        span_x = max(max_x - min_x, 1e-9)
        span_y = max(max_y - min_y, 1e-9)
        fit = min(rect.w / span_x, rect.h / span_y) * 0.98
        if cam.zoom > fit:
            cam.zoom = max(fit, MIN_ZOOM)
        z = cam.zoom
        lo = max_x - (rect.right - self.width * 0.5) / z
        hi = min_x + (self.width * 0.5 - rect.left) / z
        if lo <= hi:
            cam.centre.x = min(max(cam.centre.x, lo), hi)
        lo = max_y + (rect.top - self.height * 0.5) / z
        hi = min_y + (rect.bottom - self.height * 0.5) / z
        if lo <= hi:
            cam.centre.y = min(max(cam.centre.y, lo), hi)

    def bump_speed(self, factor: float) -> None:
        self.speed = min(20.0, max(0.01, self.speed * factor))
        self.toast(f"Speed {self.speed:g}x")

    def reset_speed(self) -> None:
        self.speed = 1.0
        self.toast("Speed 1x")

    def toggle_graph(self, mode: str) -> None:
        """Keyboard graph toggle: same key again closes the dock."""
        self.set_graph_mode("Off" if self.graph_mode == mode else mode)

    def toggle_lock_selection(self) -> None:
        bodies = [o for o in self.selection if isinstance(o, Body)]
        if not bodies:
            self.toast("Select one or more bodies to lock (K)")
            return
        target = not all(b.locked for b in bodies)
        for b in bodies:
            b.locked = target
        self.push_undo()
        n = len(bodies)
        self.toast(("Locked" if target else "Unlocked")
                   + f" {n} bod{'ies' if n != 1 else 'y'}")

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

    def set_adaptive_dt(self, on: bool) -> None:
        self.adaptive_dt = on
        self.settings["adaptive_dt"] = on
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
        elif key == pygame.K_COMMA:
            self.step_back()
        elif key in (pygame.K_DELETE, pygame.K_BACKSPACE):
            self.canvas.delete_selection()
        elif key in TOOL_KEYS:
            self.canvas.set_tool(TOOL_KEYS[key])
        elif key == pygame.K_n:
            self.view.snap = not self.view.snap
            self.toast(f"Snap to grid {'on' if self.view.snap else 'off'}")
        elif key == pygame.K_t:
            self.set_trails(not self.view.trails)
        elif key == pygame.K_g:
            self.view.spatial_grid = not self.view.spatial_grid
        elif key == pygame.K_f:
            if mods & pygame.KMOD_SHIFT:
                self.toggle_auto_fit()
            else:
                self.zoom_to_fit()
        elif key == pygame.K_d:
            self.view.vel_vectors = not self.view.vel_vectors
            self.toast("Velocity vectors "
                       + ("on" if self.view.vel_vectors else "off"))
        elif key == pygame.K_k:
            self.toggle_lock_selection()
        elif key in (pygame.K_1, pygame.K_KP1):
            self.toggle_graph("Energy")
        elif key in (pygame.K_2, pygame.K_KP2):
            self.toggle_graph("Mom.")
        elif key in (pygame.K_3, pygame.K_KP3):
            self.toggle_graph("Phase")
        elif key in (pygame.K_MINUS, pygame.K_KP_MINUS):
            self.bump_speed(0.5)
        elif key in (pygame.K_EQUALS, pygame.K_PLUS, pygame.K_KP_PLUS):
            self.bump_speed(2.0)
        elif key in (pygame.K_0, pygame.K_KP0):
            self.reset_speed()
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
            self.world.trace_spacing = (0.5 / self.camera.zoom
                                        if self.view.trails else 0.0)
            self.accumulator += dt_frame * self.speed
            quanta = 0
            small_steps = 0
            q_used = 1
            t0 = time.perf_counter()
            while self.accumulator >= eff_dt and quanta < MAX_STEPS_PER_FRAME:
                # resolution is re-chosen per quantum from the freshest
                # accelerations, so a close encounter that flares up
                # mid-frame is caught within 1/120 s
                q = self._pick_resolution(eff_dt, dt_frame)
                if q > q_used:
                    q_used = q
                h = eff_dt / q
                for _ in range(q):
                    self._safe_step(self.world, h)
                    self._record_trails()
                    small_steps += 1
                self.accumulator -= eff_dt
                quanta += 1
                if time.perf_counter() - t0 > PHYSICS_BUDGET_S:
                    break   # frame-time ceiling: stay responsive, dilate time
            elapsed = time.perf_counter() - t0
            self._last_phys_ms = elapsed * 1000.0
            if small_steps:
                self._step_ms = (0.9 * self._step_ms
                                 + 0.1 * self._last_phys_ms / small_steps)
            self._q_now = q_used
            self.overloaded = self.accumulator >= eff_dt
            if self.overloaded:
                self.accumulator = 0.0
            self._check_sustained_overload()
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
                self._autofit_zt = target[2]
                # the user may zoom OUT below the fit level (ratio < 1);
                # auto-fit then keeps tracking at that wider framing and
                # never zooms back in on its own
                desired = target[2] * self._autofit_ratio
                rate = 10.0 if desired < cam.zoom else 3.0
                k = min(1.0, dt_frame * rate)
                cam.zoom *= (desired / cam.zoom) ** k
                blend = min(1.0, dt_frame * 10.0)
                cam.centre.x += (target[0] - cam.centre.x) * blend
                cam.centre.y += (target[1] - cam.centre.y) * blend
                # hard guarantee on top of the smoothing: nothing that
                # exists right now may be off-screen, however fast it moves
                self._clamp_camera_to_bounds()
        elif self.view.follow:
            body = next((o for o in self.selection
                         if isinstance(o, Body) and isfinite(o.pos.x)
                         and isfinite(o.pos.y)), None)
            if body is not None:
                cam = self.camera
                blend = min(1.0, dt_frame * 8.0)
                cam.centre.x += (body.pos.x - cam.centre.x) * blend
                cam.centre.y += (body.pos.y - cam.centre.y) * blend

    def _pick_resolution(self, eff_dt: float, dt_frame: float) -> int:
        """Time-resolution multiplier for this frame: how many extra, smaller
        physics steps to run in place of each normal one.

        Need comes from the physics (world.subdivision_need: fast close
        encounters want finer time slicing); affordability comes from the
        measured step cost and frame headroom, so the extra work never pulls
        the frame rate below ~48 fps - plenty of resolution at 200 fps,
        none to spare at 30.
        """
        if not self.adaptive_dt:
            self._phys_res = 1
            return 1
        need = self.world.subdivision_need(eff_dt)
        if need > self._phys_res:
            self._phys_res = need       # react to spikes immediately...
        elif self._phys_res > need:
            self._phys_res -= 1         # ...but relax gradually (no flicker)
        q = self._phys_res
        if q > 1:
            base_steps = max(1.0, dt_frame * self.speed / eff_dt)
            floor_fps = min(self.fps_cap, 48)
            render_ms = max(0.0, dt_frame * 1000.0 - self._last_phys_ms)
            budget_ms = max(1.0, 1000.0 / floor_fps - render_ms)
            afford = int(budget_ms / max(self._step_ms * base_steps, 1e-3))
            q = max(1, min(q, afford))
        return q

    def _check_sustained_overload(self) -> None:
        """After several seconds of continuous overload the lag clearly
        won't recover on its own, so intervene: a fast-forward multiplier
        is the usual culprit (reset it - that often fixes it outright);
        otherwise tell the user what will actually help."""
        if not self.overloaded:
            self._overload_since = None
            return
        now = time.monotonic()
        if self._overload_since is None:
            self._overload_since = now
            return
        if now - self._overload_since > 4.0 and now > self._overload_hint_at:
            self._overload_hint_at = now + 30.0
            if self.speed > 1.0:
                self.speed = 1.0
                self.toast("Physics can't keep up - speed reset to 1x")
            else:
                self.toast("Scene too heavy for real time (running in slow "
                           "motion). Fewer substeps, iterations or bodies "
                           "will speed it up.")

    def set_trails(self, on: bool) -> None:
        """Trail toggle. Re-enabling starts fresh, so no bogus straight
        line joins where recording stopped to where it resumed."""
        if on and not self.view.trails:
            self.trails.clear()
        self.view.trails = on
        if not on:
            self.world.trace.clear()

    def _record_trails(self) -> None:
        """Append trail points; called after every physics step so extra
        adaptive steps show up as extra trail resolution."""
        if not self.view.trails:
            self.world.trace.clear()
            return
        maxlen = self.view.trail_len
        threshold = 0.5 / self.camera.zoom
        # sub-step path samples captured inside the adaptive integrator
        # (close encounters turn around within a single step)
        if self.world.trace:
            for bid, x, y in self.world.trace:
                pts = self.trails.setdefault(bid, [])
                pts.append((x, y))
                if len(pts) > maxlen:
                    del pts[:len(pts) - maxlen]
            self.world.trace.clear()
        for b in self.world.bodies:
            if b.locked:
                continue
            pts = self.trails.setdefault(b.id, [])
            if not pts or (abs(pts[-1][0] - b.pos.x) + abs(pts[-1][1] - b.pos.y)
                           > threshold):
                pts.append((b.pos.x, b.pos.y))
                if len(pts) > maxlen:
                    del pts[:len(pts) - maxlen]

    def _after_physics(self) -> None:
        # rolling per-frame history so the user can step backwards (,)
        self._history.append(snap.snapshot(self.world))
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
        # transient render shedding: while the frame rate is critically low,
        # drop antialiasing (the priciest drawing) without touching the
        # user's setting - it comes back the moment the fps recovers
        aa_saved = self.view.antialias
        if self.playing and 0.0 < self.fps_now < 22.0:
            self.view.antialias = False
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
        self.view.antialias = aa_saved

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
        # centred over the canvas and kept above the graph dock
        area = self.canvas_rect()
        y = area.bottom - 16
        for msg, ttl in reversed(self.toasts[-3:]):
            img = theme.text(msg, 13, theme.TEXT)
            w = img.get_width() + 28
            rect = pygame.Rect(area.centerx - w // 2, y - 30, w, 30)
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
