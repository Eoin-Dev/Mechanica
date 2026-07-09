"""Canvas tools: selection, direct manipulation and object creation.

The controller owns all mouse interaction inside the canvas area. Tools:
  select  - pick/drag bodies, walls and links; rubber-band multi-select;
            drag the green arrow tip of a selected body to set its velocity;
            drag wall endpoints to reshape them.
  pan     - drag to pan (also middle/right mouse button in any tool).
  body    - click to place a dynamic body.
  anchor  - click to place a locked (infinite mass) body: a pivot.
  wall    - click and drag to draw a static wall (hold Shift to constrain
            to horizontal / vertical / 45 degrees).
  rod/rope/spring - click two bodies to connect them. Clicking empty space
            creates an anchor for the first pick or a body for the second,
            so a pendulum can be drawn in two clicks.
  eraser  - click objects to delete them.
"""
from __future__ import annotations

from math import atan2, pi

import pygame

from mechanica.core.vec import Vec2
from mechanica.engine.body import Body, Wall
from mechanica.engine.links import DistanceLink, SpringLink
from mechanica.engine.world import safe_drag_speed
from mechanica.render.draw import VEL_ARROW_SCALE, draw_velocity_handle, snap_step

TOOLS = ["select", "pan", "body", "anchor", "wall", "rod", "rope", "spring", "eraser"]

TOOL_KEYS = {pygame.K_v: "select", pygame.K_h: "pan", pygame.K_b: "body",
             pygame.K_a: "anchor", pygame.K_w: "wall", pygame.K_r: "rod",
             pygame.K_e: "rope", pygame.K_s: "spring", pygame.K_x: "eraser"}

TOOL_INFO = {
    "select": ("Select (V)", "Click to select, drag to move (drag while playing "
               "to throw). Shift-click adds. Drag empty space for a box select. "
               "Right-drag a body (or drag the green arrow) to set its velocity."),
    "pan": ("Pan (H)", "Drag to move the view. Middle drag (or right drag on "
            "empty space) pans in any tool."),
    "body": ("Add body (B)", "Click to place a dynamic body. Edit it in the Inspector."),
    "anchor": ("Add anchor (A)", "Click to place a fixed anchor - a pivot for rods and springs."),
    "wall": ("Draw wall (W)", "Click and drag to draw a static wall. Shift snaps the angle."),
    "rod": ("Connect rod (R)", "Click two bodies to join them rigidly. "
            "Click empty space to create an anchor/body automatically."),
    "rope": ("Connect rope (E)", "Like a rod, but only resists stretching."),
    "spring": ("Connect spring (S)", "Click two bodies to join them with a spring."),
    "eraser": ("Eraser (X)", "Click bodies, walls or links to delete them."),
}


class CanvasController:
    def __init__(self, app) -> None:
        self.app = app
        self.tool = "select"
        self.hover: object | None = None
        # transient interaction state: (body, grab offset, max drag speed)
        self._drag_items: list[tuple[Body, Vec2, float]] = []
        self._drag_moved = False
        self._panning = False
        self._pan_last = (0, 0)
        self._rubber: tuple[int, int] | None = None
        self._wall_start: Vec2 | None = None
        self._link_first: Body | None = None
        self._vel_drag: Body | None = None
        self._wall_drag: tuple[Wall, int] | None = None  # wall, endpoint (0/1/2=whole)
        self._wall_grab: Vec2 | None = None
        # velocities at grab time, so a plain click can restore them
        self._press_vel: dict[int, tuple[float, float, float]] = {}
        self._press_ms = 0

    # ------------------------------------------------------------------ helpers
    def set_tool(self, tool: str) -> None:
        self.tool = tool
        self._link_first = None
        self._wall_start = None
        self._rubber = None

    def cancel_pending(self) -> bool:
        """Cancel an in-progress link or wall draw. Returns True if one was."""
        if self._link_first is not None or self._wall_start is not None:
            self._link_first = None
            self._wall_start = None
            return True
        return False

    def abort_drag(self) -> None:
        """Drop any in-progress drag without a throw (e.g. world replaced)."""
        for body, _, _ in self._drag_items:
            body.held = False
        self._drag_items = []
        self._vel_drag = None
        self._wall_drag = None
        self._wall_grab = None
        self.app.world.drag_pins.clear()

    def update_drag(self, mouse) -> None:
        """Refresh the drag every frame (mouse-motion events stop while the
        cursor is parked, but the simulation keeps running).

        While playing, held bodies are not teleported: the world moves each
        one toward its pin target at a bounded, spring-aware speed inside
        the physics substeps, so a fast flick cannot inject unbounded energy
        into whatever the body is attached to. While paused it is pure
        editing, so the body snaps straight to the cursor.
        """
        if not self._drag_items:
            return
        app = self.app
        world_p = app.camera.to_world(*mouse)
        if app.playing:
            pins = app.world.drag_pins
            for body, offset, v_max in self._drag_items:
                t = self._snap(Vec2(world_p.x + offset.x, world_p.y + offset.y))
                pins[body] = (t.x, t.y, v_max)
        else:
            # paused = pure editing: reposition only, keep the velocity so a
            # click or drag never wipes the body's motion state
            app.world.drag_pins.clear()
            for body, offset, _ in self._drag_items:
                t = self._snap(Vec2(world_p.x + offset.x, world_p.y + offset.y))
                body.pos.set_vec(t)

    def _snap(self, p: Vec2) -> Vec2:
        if not self.app.view.snap:
            return p
        step = snap_step(self.app.camera.zoom)
        return Vec2(round(p.x / step) * step, round(p.y / step) * step)

    def pick(self, mouse) -> object | None:
        """Topmost object under the cursor: bodies, then links, then walls."""
        app = self.app
        world_p = app.camera.to_world(*mouse)
        pick_pad = 4.0 / app.camera.zoom
        for body in reversed(app.world.bodies):
            if body.pos.dist_to(world_p) <= max(body.radius + pick_pad,
                                                6.0 / app.camera.zoom):
                return body
        for link in reversed(app.world.links):
            if self._dist_to_segment(world_p, link.a.pos, link.b.pos) < 6.0 / app.camera.zoom:
                return link
        for wall in reversed(app.world.walls):
            if self._dist_to_segment(world_p, wall.a, wall.b) < wall.thickness / 2 + pick_pad:
                return wall
        return None

    @staticmethod
    def _dist_to_segment(p: Vec2, a: Vec2, b: Vec2) -> float:
        ab = b - a
        ab2 = ab.length2()
        if ab2 == 0:
            return p.dist_to(a)
        t = max(0.0, min(1.0, (p - a).dot(ab) / ab2))
        closest = Vec2(a.x + ab.x * t, a.y + ab.y * t)
        return p.dist_to(closest)

    def hint(self) -> str:
        if self.tool in ("rod", "rope", "spring") and self._link_first:
            return "Now click a second body (or empty space) to finish the link. Esc cancels."
        if self.tool == "wall" and self._wall_start:
            return "Release to finish the wall. Hold Shift to snap the angle."
        return TOOL_INFO[self.tool][1]

    # ------------------------------------------------------------------ events
    def handle_event(self, event: pygame.event.Event, mouse) -> bool:
        app = self.app
        if event.type == pygame.MOUSEBUTTONDOWN:
            if event.button in (2, 3):
                # right-drag on a dynamic body aims its velocity vector;
                # middle-drag (or right-drag on empty space) pans
                if event.button == 3:
                    picked = self.pick(mouse)
                    if isinstance(picked, Body) and not picked.locked:
                        self._vel_drag = picked
                        app.selection = [picked]
                        self._drag_moved = False
                        return True
                self._panning = True
                self._pan_last = mouse
                return True
            if event.button == 1:
                return self._press(mouse)
            if event.button in (4, 5):
                return False
        elif event.type == pygame.MOUSEMOTION:
            return self._motion(mouse, event.rel)
        elif event.type == pygame.MOUSEBUTTONUP:
            if event.button in (2, 3):
                self._panning = False
                if event.button == 3 and self._vel_drag is not None:
                    if self._drag_moved:
                        app.push_undo()
                    self._vel_drag = None
                return True
            if event.button == 1:
                return self._release(mouse)
        elif event.type == pygame.MOUSEWHEEL:
            factor = 1.1 ** event.y
            app.camera.zoom_at(*mouse, factor)
            return True
        elif event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
            if self._link_first or self._wall_start:
                self._link_first = None
                self._wall_start = None
                return True
        return False

    # ------------------------------------------------------------------- press
    def _press(self, mouse) -> bool:
        app = self.app
        world_p = app.camera.to_world(*mouse)
        tool = self.tool

        if tool == "pan":
            self._panning = True
            self._pan_last = mouse
            return True

        if tool == "select":
            return self._press_select(mouse, world_p)

        if tool == "body":
            b = Body(self._snap(world_p))
            app.world.bodies.append(b)
            app.selection = [b]
            app.push_undo()
            return True

        if tool == "anchor":
            b = Body(self._snap(world_p), radius=0.08)
            b.locked = True
            b.color = (120, 125, 135)
            b.name = f"Anchor {b.id}"
            app.world.bodies.append(b)
            app.selection = [b]
            app.push_undo()
            return True

        if tool == "wall":
            self._wall_start = self._snap(world_p)
            return True

        if tool in ("rod", "rope", "spring"):
            picked = self.pick(mouse)
            target = picked if isinstance(picked, Body) else None
            if target is None:
                target = Body(self._snap(world_p),
                              radius=0.08 if self._link_first is None else 0.12)
                if self._link_first is None:
                    target.locked = True
                    target.color = (120, 125, 135)
                    target.name = f"Anchor {target.id}"
                app.world.bodies.append(target)
            if self._link_first is None:
                self._link_first = target
            elif target is not self._link_first:
                if self.tool == "spring":
                    link = SpringLink(self._link_first, target)
                else:
                    link = DistanceLink(self._link_first, target,
                                        is_rope=(self.tool == "rope"))
                app.world.links.append(link)
                app.selection = [link]
                self._link_first = None
                app.push_undo()
            return True

        if tool == "eraser":
            picked = self.pick(mouse)
            if picked is not None:
                self._delete_object(picked)
                app.push_undo()
            return True
        return False

    def _press_select(self, mouse, world_p: Vec2) -> bool:
        app = self.app
        shift = pygame.key.get_mods() & pygame.KMOD_SHIFT

        # velocity handle of a single selected body? The tip wins over the
        # body even when it lies inside the body's disc, as long as the
        # arrow has a visible length - otherwise a click on a resting body
        # would grab the (zero-length) arrow and fling it instead of moving it.
        if len(app.selection) == 1 and isinstance(app.selection[0], Body):
            body = app.selection[0]
            if not body.locked:
                s = VEL_ARROW_SCALE * app.view.vector_scale
                tip = app.camera.to_screen_xy(body.pos.x + body.vel.x * s,
                                              body.pos.y + body.vel.y * s)
                centre = app.camera.to_screen(body.pos)
                arrow_px = ((tip[0] - centre[0]) ** 2
                            + (tip[1] - centre[1]) ** 2) ** 0.5
                if (arrow_px > 12.0
                        and abs(mouse[0] - tip[0]) <= 8
                        and abs(mouse[1] - tip[1]) <= 8):
                    self._vel_drag = body
                    return True

        picked = self.pick(mouse)
        if picked is None:
            if not shift:
                app.selection = []
            self._rubber = mouse
            return True

        if isinstance(picked, Wall):
            if shift:
                if picked in app.selection:
                    app.selection.remove(picked)
                else:
                    app.selection.append(picked)
                return True
            if picked not in app.selection:
                app.selection = [picked]
            # endpoint handles
            for i, p in enumerate((picked.a, picked.b)):
                sp = app.camera.to_screen(p)
                if abs(mouse[0] - sp[0]) <= 8 and abs(mouse[1] - sp[1]) <= 8:
                    self._wall_drag = (picked, i)
                    return True
            self._wall_drag = (picked, 2)
            self._wall_grab = world_p
            return True

        if isinstance(picked, (DistanceLink, SpringLink)):
            if shift:
                if picked in app.selection:
                    app.selection.remove(picked)
                else:
                    app.selection.append(picked)
            elif picked not in app.selection:
                app.selection = [picked]
            return True

        # a body
        if shift:
            if picked in app.selection:
                app.selection.remove(picked)
            else:
                app.selection.append(picked)
        elif picked not in app.selection:
            app.selection = [picked]
        # begin dragging all selected bodies; held bodies act as infinite
        # mass so they stay put while everything else collides with them.
        # The base drag speed scales with the view (a few screen-widths per
        # second) and is tightened per body by its attached springs.
        base_speed = 2.5 * app.canvas_rect().w / app.camera.zoom
        self._drag_items = [
            (b, b.pos - world_p, safe_drag_speed(app.world, b, base_speed))
            for b in app.selection if isinstance(b, Body)]
        # remember the grab-time motion so a plain click can put it back
        self._press_ms = pygame.time.get_ticks()
        self._press_vel = {b.id: (b.vel.x, b.vel.y, b.omega)
                           for b, _, _ in self._drag_items}
        for b, _, _ in self._drag_items:
            b.held = True
        self._drag_moved = False
        return True

    # ------------------------------------------------------------------ motion
    def _motion(self, mouse, rel) -> bool:
        app = self.app
        if self._panning:
            app.camera.pan_pixels(mouse[0] - self._pan_last[0],
                                  mouse[1] - self._pan_last[1])
            self._pan_last = mouse
            return True
        world_p = app.camera.to_world(*mouse)
        if self._vel_drag is not None:
            body = self._vel_drag
            s = VEL_ARROW_SCALE * app.view.vector_scale
            body.vel.set((world_p.x - body.pos.x) / s, (world_p.y - body.pos.y) / s)
            self._drag_moved = True
            return True
        if self._wall_drag is not None:
            wall, idx = self._wall_drag
            if idx == 0:
                wall.a = self._snap(world_p)
            elif idx == 1:
                wall.b = self._snap(world_p)
            else:
                delta = world_p - self._wall_grab
                wall.a.add_ip(delta)
                wall.b.add_ip(delta)
                self._wall_grab = world_p
            self._drag_moved = True
            return True
        if self._drag_items:
            # update_drag() moves the bodies once per frame; here we only
            # note that the drag actually moved (for undo and throwing)
            self._drag_moved = True
            return True
        if self._rubber is not None:
            return True
        self.hover = self.pick(mouse)
        return False

    # ----------------------------------------------------------------- release
    def _release(self, mouse) -> bool:
        app = self.app
        handled = False
        if self._panning:
            self._panning = False
            handled = True
        if self._vel_drag is not None or self._wall_drag is not None or self._drag_items:
            # While playing, a held body's velocity is already the speed its
            # pin was moving at (zero if the cursor was parked), so releasing
            # mid-swing throws it and releasing at rest just lets it go.
            # A plain click (no movement, brief press) restores the velocity
            # the body had at grab time instead of stopping it dead.
            throw = app.playing and self._drag_moved
            quick = pygame.time.get_ticks() - self._press_ms <= 350
            for body, _, _ in self._drag_items:
                body.held = False
                if throw:
                    continue
                if not self._drag_moved and quick:
                    v = self._press_vel.get(body.id)
                    if v is not None:
                        body.vel.set(v[0], v[1])
                        body.omega = v[2]
                elif app.playing:
                    body.vel.set(0.0, 0.0)  # held parked, released at rest
                # paused: leave the velocity untouched (pure editing)
            app.world.drag_pins.clear()
            if self._drag_moved:
                app.push_undo()
            self._vel_drag = None
            self._wall_drag = None
            self._wall_grab = None
            self._drag_items = []
            handled = True
        if self._rubber is not None:
            x0, y0 = self._rubber
            x1, y1 = mouse
            rect = pygame.Rect(min(x0, x1), min(y0, y1), abs(x1 - x0), abs(y1 - y0))
            if rect.w > 4 and rect.h > 4:
                shift = pygame.key.get_mods() & pygame.KMOD_SHIFT
                found = self._box_contents(rect)
                if shift:
                    for obj in found:
                        if obj not in app.selection:
                            app.selection.append(obj)
                else:
                    app.selection = found
            self._rubber = None
            handled = True
        if self._wall_start is not None:
            end = self._constrained_wall_end(mouse)
            if self._wall_start.dist_to(end) > 0.05:
                wall = Wall(self._wall_start, end)
                app.world.walls.append(wall)
                app.selection = [wall]
                app.push_undo()
            self._wall_start = None
            handled = True
        return handled

    def _box_contents(self, rect: pygame.Rect) -> list:
        """Everything inside a rubber-band rect, honouring the type filter
        the user set in the Inspector (bodies / walls / springs / rods).
        Bodies count by centre; walls and links need both ends inside."""
        app = self.app
        cam = app.camera
        flt = app.box_filter
        found: list = []
        if flt.get("bodies", True):
            for body in app.world.bodies:
                if rect.collidepoint(cam.to_screen(body.pos)):
                    found.append(body)
        if flt.get("walls", True):
            for wall in app.world.walls:
                if (rect.collidepoint(cam.to_screen(wall.a))
                        and rect.collidepoint(cam.to_screen(wall.b))):
                    found.append(wall)
        want_springs = flt.get("springs", True)
        want_rods = flt.get("rods", True)
        if want_springs or want_rods:
            for link in app.world.links:
                if want_springs if isinstance(link, SpringLink) else want_rods:
                    if (rect.collidepoint(cam.to_screen(link.a.pos))
                            and rect.collidepoint(cam.to_screen(link.b.pos))):
                        found.append(link)
        return found

    def _constrained_wall_end(self, mouse) -> Vec2:
        end = self._snap(self.app.camera.to_world(*mouse))
        if pygame.key.get_mods() & pygame.KMOD_SHIFT and self._wall_start:
            d = end - self._wall_start
            ang = atan2(d.y, d.x)
            snap_ang = round(ang / (pi / 4)) * (pi / 4)
            length = d.length()
            end = self._wall_start + Vec2(length, 0).rotated(snap_ang)
        return end

    # ---------------------------------------------------------------- deletion
    def _delete_object(self, obj) -> None:
        app = self.app
        if isinstance(obj, Body):
            app.world.remove_body(obj)
            app.trails.pop(obj.id, None)
        elif isinstance(obj, Wall):
            app.world.remove_wall(obj)
        else:
            app.world.remove_link(obj)
        if obj in app.selection:
            app.selection.remove(obj)
        if self.hover is obj:
            self.hover = None

    def delete_selection(self) -> None:
        if not self.app.selection:
            return
        for obj in list(self.app.selection):
            self._delete_object(obj)
        self.app.selection = []
        self.app.push_undo()

    def duplicate_selection(self) -> None:
        app = self.app
        new_sel = []
        bodies = [o for o in app.selection if isinstance(o, Body)]
        mapping: dict[int, Body] = {}
        for body in bodies:
            clone = Body.from_dict(body.to_dict())
            clone.id = Body._next_id
            Body._next_id += 1
            clone.name = f"Body {clone.id}"
            clone.pos = body.pos + Vec2(0.3, -0.3)
            mapping[body.id] = clone
            app.world.bodies.append(clone)
            new_sel.append(clone)
        # duplicate links whose two ends were both duplicated
        for link in list(app.world.links):
            if link.a.id in mapping and link.b.id in mapping:
                if isinstance(link, SpringLink):
                    nl = SpringLink(mapping[link.a.id], mapping[link.b.id],
                                    link.rest_length, link.stiffness, link.damping)
                else:
                    nl = DistanceLink(mapping[link.a.id], mapping[link.b.id],
                                      link.length, link.is_rope, link.compliance)
                app.world.links.append(nl)
        for obj in app.selection:
            if isinstance(obj, Wall):
                clone = Wall.from_dict(obj.to_dict())
                clone.id = Wall._next_id
                Wall._next_id += 1
                clone.a = obj.a + Vec2(0.3, -0.3)
                clone.b = obj.b + Vec2(0.3, -0.3)
                app.world.walls.append(clone)
                new_sel.append(clone)
        if new_sel:
            app.selection = new_sel
            app.push_undo()

    # ---------------------------------------------------------------- overlays
    def draw_overlays(self, surface: pygame.Surface, mouse) -> None:
        app = self.app
        if self._rubber is not None:
            x0, y0 = self._rubber
            rect = pygame.Rect(min(x0, mouse[0]), min(y0, mouse[1]),
                               abs(mouse[0] - x0), abs(mouse[1] - y0))
            s = pygame.Surface(rect.size, pygame.SRCALPHA)
            s.fill((110, 180, 240, 30))
            surface.blit(s, rect.topleft)
            pygame.draw.rect(surface, (110, 180, 240), rect, 1)
        if self._wall_start is not None:
            end = self._constrained_wall_end(mouse)
            pygame.draw.line(surface, (200, 205, 215),
                             app.camera.to_screen(self._wall_start),
                             app.camera.to_screen(end), 3)
        if self._link_first is not None:
            pygame.draw.line(surface, (150, 200, 150),
                             app.camera.to_screen(self._link_first.pos), mouse, 1)
        # velocity handle: for the body being right-dragged (any tool), or
        # for a single selected dynamic body with the select tool
        body = self._vel_drag
        if body is None and (self.tool == "select" and len(app.selection) == 1
                             and isinstance(app.selection[0], Body)
                             and not app.selection[0].locked):
            body = app.selection[0]
        if body is not None and not body.locked:
            draw_velocity_handle(surface, app.camera, body, app.view)
