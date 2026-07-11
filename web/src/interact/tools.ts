/** Canvas tools: selection, direct manipulation and object creation.
 *
 * The controller owns all pointer interaction inside the canvas. Tools:
 *   select  - pick/drag bodies, walls and links; rubber-band multi-select;
 *             drag the green arrow tip of a selected body to set its
 *             velocity; drag wall endpoints to reshape them.
 *   pan     - drag to pan (also middle/right button in any tool).
 *   body    - click to place a dynamic body.
 *   anchor  - click to place a locked (infinite mass) body: a pivot.
 *   wall    - click and drag to draw a static wall (hold Shift to constrain
 *             to horizontal / vertical / 45 degrees).
 *   rod/rope/spring - click two bodies to connect them. Clicking empty space
 *             creates an anchor for the first pick or a body for the second,
 *             so a pendulum can be drawn in two clicks.
 *   eraser  - click objects to delete them.
 *
 * Touch: one finger drives the active tool exactly like the mouse; two
 * fingers pinch-zoom and pan (something the desktop app never had).
 */
import { Vec2 } from "../core/vec";
import { Body, Wall } from "../engine/body";
import { DistanceLink, SpringLink } from "../engine/links";
import { safeDragSpeed } from "../engine/world";
import { Selectable, VEL_ARROW_SCALE, drawVelocityHandle, snapStep } from "../render/draw";
import { css } from "../ui/theme";
import type { App } from "../app";

export const TOOLS = ["select", "pan", "body", "anchor", "wall",
                      "rod", "rope", "spring", "eraser"] as const;
export type Tool = (typeof TOOLS)[number];

export const TOOL_KEYS: Record<string, Tool> = {
  v: "select", h: "pan", b: "body", a: "anchor", w: "wall",
  r: "rod", e: "rope", s: "spring", x: "eraser",
};

export const TOOL_INFO: Record<Tool, [string, string]> = {
  select: ["Select (V)", "Click to select, drag to move (drag while playing " +
           "to throw). Shift-click adds. Drag empty space for a box select. " +
           "Right-drag a body (or drag the green arrow) to set its velocity."],
  pan: ["Pan (H)", "Drag to move the view. Middle drag (or right drag on " +
        "empty space) pans in any tool."],
  body: ["Add body (B)", "Click to place a dynamic body. Edit it in the Inspector."],
  anchor: ["Add anchor (A)", "Click to place a fixed anchor - connect rods, strings and springs to it."],
  wall: ["Draw wall (W)", "Click and drag to draw a static wall. Shift snaps the angle."],
  rod: ["Connect rod (R)", "Click two bodies to join them rigidly. " +
        "Click empty space to create an anchor/body automatically."],
  rope: ["Connect string (E)", "An elastic string: pulls when stretched " +
         "past its natural length, completely slack when shorter. Can be " +
         "made inelastic (fixed length) in the Inspector."],
  spring: ["Connect spring (S)", "Click two bodies to join them with a spring."],
  eraser: ["Eraser (X)", "Click bodies, walls or links to delete them."],
};

const ANCHOR_GREY: [number, number, number] = [120, 125, 135];

/** Turn a freshly-created body into a fixed anchor: locked, grey, named
 * "Anchor", and flagged so it is excluded from gravity and the body count. */
function makeAnchor(b: Body): Body {
  b.locked = true;
  b.isAnchor = true;
  b.color = ANCHOR_GREY;
  b.name = "Anchor";
  return b;
}

interface DragItem {
  body: Body;
  offset: Vec2;
  vMax: number;
}

export class CanvasController {
  tool: Tool = "select";
  hover: Selectable | null = null;
  mouse: [number, number] = [0, 0];
  shiftDown = false;

  private app: App;
  private dragItems: DragItem[] = [];
  private dragMoved = false;
  private panning = false;
  private panLast: [number, number] = [0, 0];
  private rubber: [number, number] | null = null;
  private wallStart: Vec2 | null = null;
  private linkFirst: Body | null = null;
  private velDrag: Body | null = null;
  private wallDrag: [Wall, number] | null = null; // wall, endpoint (0/1/2=whole)
  private wallGrab: Vec2 | null = null;
  // a body drag only *activates* (holds/pins the body) once the cursor
  // moves a few pixels; a plain inspect-click never touches the physics
  private dragPress: [number, number] = [0, 0];
  private dragActive = false;
  // touch: active pointers for pinch detection
  private pointers = new Map<number, [number, number]>();
  private pinchDist = 0;
  private pinchMid: [number, number] = [0, 0];

  constructor(app: App) {
    this.app = app;
  }

  // ------------------------------------------------------------------ helpers
  setTool(tool: Tool): void {
    this.tool = tool;
    this.linkFirst = null;
    this.wallStart = null;
    this.rubber = null;
  }

  /** Cancel an in-progress link or wall draw. Returns true if one was. */
  cancelPending(): boolean {
    if (this.linkFirst !== null || this.wallStart !== null) {
      this.linkFirst = null;
      this.wallStart = null;
      return true;
    }
    return false;
  }

  /** Drop any in-progress drag without a throw (e.g. world replaced). */
  abortDrag(): void {
    for (const { body } of this.dragItems) body.held = false;
    this.dragItems = [];
    this.dragActive = false;
    this.velDrag = null;
    this.wallDrag = null;
    this.wallGrab = null;
    this.app.world.dragPins.clear();
  }

  /** Refresh the drag every frame (pointer-move events stop while the
   * cursor is parked, but the simulation keeps running).
   *
   * While playing, held bodies are not teleported: the world moves each
   * one toward its pin target at a bounded, spring-aware speed inside
   * the physics substeps. While paused it is pure editing, so the body
   * snaps straight to the cursor. */
  updateDrag(): void {
    if (this.dragItems.length === 0 || !this.dragActive) return;
    const app = this.app;
    const worldP = app.camera.toWorld(this.mouse[0], this.mouse[1]);
    if (app.playing) {
      const pins = app.world.dragPins;
      for (const { body, offset, vMax } of this.dragItems) {
        const t = this.snap(new Vec2(worldP.x + offset.x, worldP.y + offset.y));
        pins.set(body, [t.x, t.y, vMax]);
      }
    } else {
      // paused = pure editing: reposition only, keep the velocity so a
      // click or drag never wipes the body's motion state
      app.world.dragPins.clear();
      for (const { body, offset } of this.dragItems) {
        body.pos.setVec(this.snap(new Vec2(worldP.x + offset.x, worldP.y + offset.y)));
      }
    }
  }

  private snap(p: Vec2): Vec2 {
    if (!this.app.view.snap) return p;
    const step = snapStep(this.app.camera.zoom);
    return new Vec2(Math.round(p.x / step) * step, Math.round(p.y / step) * step);
  }

  /** Topmost object under the cursor: bodies, then links, then walls. */
  pick(mouse: [number, number]): Selectable | null {
    const app = this.app;
    const worldP = app.camera.toWorld(mouse[0], mouse[1]);
    const pickPad = 4.0 / app.camera.zoom;
    const bodies = app.world.bodies;
    for (let i = bodies.length - 1; i >= 0; i--) {
      const body = bodies[i];
      if (body.pos.distTo(worldP) <=
          Math.max(body.radius + pickPad, 6.0 / app.camera.zoom)) {
        return body;
      }
    }
    const links = app.world.links;
    for (let i = links.length - 1; i >= 0; i--) {
      if (distToSegment(worldP, links[i].a.pos, links[i].b.pos) < 6.0 / app.camera.zoom) {
        return links[i];
      }
    }
    const walls = app.world.walls;
    for (let i = walls.length - 1; i >= 0; i--) {
      if (distToSegment(worldP, walls[i].a, walls[i].b) <
          walls[i].thickness / 2 + pickPad) {
        return walls[i];
      }
    }
    return null;
  }

  hint(): string {
    if ((this.tool === "rod" || this.tool === "rope" || this.tool === "spring") &&
        this.linkFirst !== null) {
      return "Now click a second body (or empty space) to finish the link. Esc cancels.";
    }
    if (this.tool === "wall" && this.wallStart !== null) {
      return "Release to finish the wall. Hold Shift to snap the angle.";
    }
    return TOOL_INFO[this.tool][1];
  }

  // ------------------------------------------------------------------ events
  /** Drop every in-progress gesture (drag, pan, rubber band, pinch).
   * Called when the browser interrupts us mid-gesture: fullscreen
   * toggles, window blur, pointer cancellation. */
  resetInteraction(): void {
    this.abortDrag();
    this.pointers.clear();
    this.pinchDist = 0;
    this.rubber = null;
    this.wallStart = null;
    this.panning = false;
  }

  attach(canvas: HTMLCanvasElement): void {
    // The page context menu must never open over the app: Chrome's menu
    // starts with Back/Forward, so a stray right-click could navigate the
    // user away mid-simulation. Text fields keep their native menu.
    document.addEventListener("contextmenu", (e) => {
      const t = e.target as HTMLElement;
      if (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") e.preventDefault();
    });
    // a fullscreen toggle or focus loss can swallow the matching pointerup,
    // which would otherwise leave bodies stuck "held"
    window.addEventListener("blur", () => this.resetInteraction());
    document.addEventListener("fullscreenchange", () => this.resetInteraction());

    canvas.addEventListener("pointerdown", (e) => {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // pointer already gone (released mid-dispatch): continue uncaptured
      }
      this.mouse = this.local(canvas, e);
      // only touch contacts take part in pinch detection: a mouse whose
      // pointerup got eaten (context menu, F11) must never leave a stale
      // entry that turns every later click into a phantom two-finger pinch
      if (e.pointerType === "touch") {
        this.pointers.set(e.pointerId, this.mouse);
        if (this.pointers.size === 2) {
          // second finger: cancel the one-finger gesture, start pinching
          this.abortDrag();
          this.rubber = null;
          this.wallStart = null;
          this.panning = false;
          const [p1, p2] = [...this.pointers.values()];
          this.pinchDist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
          this.pinchMid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
          return;
        }
      }
      this.shiftDown = e.shiftKey;
      if (e.button === 1 || e.button === 2) {
        e.preventDefault(); // no middle-click autoscroll / browser defaults
        // right-drag on a dynamic body aims its velocity vector;
        // middle-drag (or right-drag on empty space) pans
        if (e.button === 2) {
          const picked = this.pick(this.mouse);
          if (picked instanceof Body && !picked.locked) {
            this.velDrag = picked;
            this.app.setSelection([picked]);
            this.dragMoved = false;
            return;
          }
        }
        this.panning = true;
        this.panLast = this.mouse;
        return;
      }
      if (e.button === 0) this.press(this.mouse);
    });

    canvas.addEventListener("pointermove", (e) => {
      const pos = this.local(canvas, e);
      this.shiftDown = e.shiftKey;
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pos);
      if (this.pointers.size === 2) {
        const [p1, p2] = [...this.pointers.values()];
        const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        const cx = (p1[0] + p2[0]) / 2;
        const cy = (p1[1] + p2[1]) / 2;
        if (this.pinchDist > 0) {
          this.app.camera.zoomAt(cx, cy, dist / this.pinchDist);
          this.app.noteUserZoom();
        }
        this.app.camera.panPixels(cx - this.pinchMid[0], cy - this.pinchMid[1]);
        this.pinchDist = dist;
        this.pinchMid = [cx, cy];
        this.mouse = pos;
        return;
      }
      this.mouse = pos;
      this.motion(pos);
    });

    const finish = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size > 0) {
        this.pinchDist = 0;
        return;
      }
      this.mouse = this.local(canvas, e);
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        this.panning = false;
        if (e.button === 2 && this.velDrag !== null) {
          if (this.dragMoved) this.app.pushUndo();
          this.velDrag = null;
        }
        return;
      }
      this.release(this.mouse);
    };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", (e) => {
      this.pointers.delete(e.pointerId);
      this.abortDrag();
      this.rubber = null;
      this.panning = false;
      this.pinchDist = 0;
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const pos = this.local(canvas, e);
      const factor = 1.1 ** (-e.deltaY / 100);
      this.app.camera.zoomAt(pos[0], pos[1], factor);
      this.app.noteUserZoom(); // auto-fit: allow out, cap in
    }, { passive: false });
  }

  private local(canvas: HTMLCanvasElement, e: MouseEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // ------------------------------------------------------------------- press
  private press(mouse: [number, number]): void {
    const app = this.app;
    const worldP = app.camera.toWorld(mouse[0], mouse[1]);
    const tool = this.tool;

    if (tool === "pan") {
      this.panning = true;
      this.panLast = mouse;
      return;
    }

    if (tool === "select") {
      this.pressSelect(mouse, worldP);
      return;
    }

    if (tool === "body") {
      const b = new Body(this.snap(worldP));
      app.world.bodies.push(b);
      app.setSelection([b]);
      app.pushUndo();
      return;
    }

    if (tool === "anchor") {
      const b = makeAnchor(new Body(this.snap(worldP), 0.08));
      app.world.bodies.push(b);
      app.setSelection([b]);
      app.pushUndo();
      return;
    }

    if (tool === "wall") {
      this.wallStart = this.snap(worldP);
      return;
    }

    if (tool === "rod" || tool === "rope" || tool === "spring") {
      const picked = this.pick(mouse);
      let target = picked instanceof Body ? picked : null;
      if (target === null) {
        target = new Body(this.snap(worldP), this.linkFirst === null ? 0.08 : 0.12);
        if (this.linkFirst === null) makeAnchor(target);
        app.world.bodies.push(target);
      }
      if (this.linkFirst === null) {
        this.linkFirst = target;
      } else if (target !== this.linkFirst) {
        let link;
        if (tool === "spring") {
          link = new SpringLink(this.linkFirst, target);
        } else if (tool === "rope") {
          // an elastic string: a tension-only spring
          link = new SpringLink(this.linkFirst, target, null, 1000.0, 2.0, true);
        } else {
          link = new DistanceLink(this.linkFirst, target);
        }
        app.world.links.push(link);
        app.setSelection([link]);
        this.linkFirst = null;
        app.pushUndo();
      }
      return;
    }

    if (tool === "eraser") {
      const picked = this.pick(mouse);
      if (picked !== null) {
        this.deleteObject(picked);
        app.pushUndo();
      }
    }
  }

  private pressSelect(mouse: [number, number], worldP: Vec2): void {
    const app = this.app;
    const shift = this.shiftDown;

    // velocity handle of a single selected body? The tip wins over the
    // body even when it lies inside the body's disc, as long as the
    // arrow has a visible length - otherwise a click on a resting body
    // would grab the (zero-length) arrow and fling it instead of moving it.
    if (app.selection.length === 1 && app.selection[0] instanceof Body) {
      const body = app.selection[0];
      if (!body.locked) {
        const s = VEL_ARROW_SCALE * app.view.vectorScale;
        const tip = app.camera.toScreenXY(body.pos.x + body.vel.x * s,
                                          body.pos.y + body.vel.y * s);
        const centre = app.camera.toScreen(body.pos);
        const arrowPx = Math.hypot(tip[0] - centre[0], tip[1] - centre[1]);
        if (arrowPx > 12.0 && Math.abs(mouse[0] - tip[0]) <= 8 &&
            Math.abs(mouse[1] - tip[1]) <= 8) {
          this.velDrag = body;
          return;
        }
      }
    }

    const picked = this.pick(mouse);
    if (picked === null) {
      if (!shift) app.setSelection([]);
      this.rubber = mouse;
      return;
    }

    if (picked instanceof Wall) {
      if (shift) {
        this.toggleInSelection(picked);
        return;
      }
      if (!app.selection.includes(picked)) app.setSelection([picked]);
      // endpoint handles
      const ends = [picked.a, picked.b];
      for (let i = 0; i < 2; i++) {
        const sp = app.camera.toScreen(ends[i]);
        if (Math.abs(mouse[0] - sp[0]) <= 8 && Math.abs(mouse[1] - sp[1]) <= 8) {
          this.wallDrag = [picked, i];
          return;
        }
      }
      this.wallDrag = [picked, 2];
      this.wallGrab = worldP;
      return;
    }

    if (picked instanceof DistanceLink || picked instanceof SpringLink) {
      if (shift) this.toggleInSelection(picked);
      else if (!app.selection.includes(picked)) app.setSelection([picked]);
      return;
    }

    // a body
    if (shift) this.toggleInSelection(picked);
    else if (!app.selection.includes(picked)) app.setSelection([picked]);
    // begin dragging all selected bodies; held bodies act as infinite
    // mass so they stay put while everything else collides with them.
    // The base drag speed scales with the view (a few screen-widths per
    // second) and is tightened per body by its attached springs.
    const baseSpeed = (2.5 * app.canvasWidth) / app.camera.zoom;
    this.dragItems = app.selection
      .filter((o): o is Body => o instanceof Body)
      .map((b) => ({ body: b, offset: b.pos.sub(worldP),
                     vMax: safeDragSpeed(app.world, b, baseSpeed) }));
    // bodies are NOT held yet: the drag arms here and only activates
    // once the cursor moves, so an inspect-click leaves the physics alone
    this.dragPress = mouse;
    this.dragActive = false;
    this.dragMoved = false;
  }

  private toggleInSelection(obj: Selectable): void {
    const sel = [...this.app.selection];
    const i = sel.indexOf(obj);
    if (i >= 0) sel.splice(i, 1);
    else sel.push(obj);
    this.app.setSelection(sel);
  }

  // ------------------------------------------------------------------ motion
  private motion(mouse: [number, number]): void {
    const app = this.app;
    if (this.panning) {
      app.camera.panPixels(mouse[0] - this.panLast[0], mouse[1] - this.panLast[1]);
      this.panLast = mouse;
      return;
    }
    const worldP = app.camera.toWorld(mouse[0], mouse[1]);
    if (this.velDrag !== null) {
      const body = this.velDrag;
      const s = VEL_ARROW_SCALE * app.view.vectorScale;
      body.vel.set((worldP.x - body.pos.x) / s, (worldP.y - body.pos.y) / s);
      this.dragMoved = true;
      return;
    }
    if (this.wallDrag !== null) {
      const [wall, idx] = this.wallDrag;
      if (idx === 0) wall.a = this.snap(worldP);
      else if (idx === 1) wall.b = this.snap(worldP);
      else if (this.wallGrab !== null) {
        const delta = worldP.sub(this.wallGrab);
        wall.a.addIp(delta);
        wall.b.addIp(delta);
        this.wallGrab = worldP;
      }
      this.dragMoved = true;
      return;
    }
    if (this.dragItems.length > 0) {
      if (!this.dragActive) {
        const dx = mouse[0] - this.dragPress[0];
        const dy = mouse[1] - this.dragPress[1];
        if (dx * dx + dy * dy < 16) return; // a click's jitter never grabs
        this.dragActive = true;
        for (const { body } of this.dragItems) body.held = true;
      }
      // updateDrag() moves the bodies once per frame; here we only
      // note that the drag actually moved (for undo and throwing)
      this.dragMoved = true;
      return;
    }
    if (this.rubber !== null) return;
    this.hover = this.pick(mouse);
  }

  // ----------------------------------------------------------------- release
  private release(mouse: [number, number]): void {
    const app = this.app;
    if (this.panning) this.panning = false;
    if (this.velDrag !== null || this.wallDrag !== null || this.dragItems.length > 0) {
      // An inactive (never-moved) press was a pure inspect-click: the
      // bodies were never held or pinned, so there is nothing to undo.
      // An active drag while playing releases at the pin's velocity -
      // moving pin = a throw, parked pin = let go at rest. While
      // paused it is pure editing and the velocity stays untouched.
      for (const { body } of this.dragItems) body.held = false;
      app.world.dragPins.clear();
      if (this.dragMoved) app.pushUndo();
      this.velDrag = null;
      this.wallDrag = null;
      this.wallGrab = null;
      this.dragItems = [];
      this.dragActive = false;
    }
    if (this.rubber !== null) {
      const [x0, y0] = this.rubber;
      const [x1, y1] = mouse;
      const rect = { x: Math.min(x0, x1), y: Math.min(y0, y1),
                     w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      if (rect.w > 4 && rect.h > 4) {
        const found = this.boxContents(rect);
        if (this.shiftDown) {
          const sel = [...app.selection];
          for (const obj of found) {
            if (!sel.includes(obj)) sel.push(obj);
          }
          app.setSelection(sel);
        } else {
          app.setSelection(found);
        }
      }
      this.rubber = null;
    }
    if (this.wallStart !== null) {
      const end = this.constrainedWallEnd(mouse);
      if (this.wallStart.distTo(end) > 0.05) {
        const wall = new Wall(this.wallStart, end);
        app.world.walls.push(wall);
        app.setSelection([wall]);
        app.pushUndo();
      }
      this.wallStart = null;
    }
  }

  /** Everything inside a rubber-band rect, honouring the type filter the
   * user set in the Inspector (bodies / walls / springs / rods). Bodies
   * count by centre; walls and links need both ends inside. */
  private boxContents(rect: { x: number; y: number; w: number; h: number }): Selectable[] {
    const app = this.app;
    const cam = app.camera;
    const inside = (p: [number, number]): boolean =>
      p[0] >= rect.x && p[0] <= rect.x + rect.w &&
      p[1] >= rect.y && p[1] <= rect.y + rect.h;
    const flt = app.boxFilter;
    const found: Selectable[] = [];
    if (flt.bodies || flt.anchors) {
      for (const body of app.world.bodies) {
        if (!(body.isAnchor ? flt.anchors : flt.bodies)) continue;
        if (inside(cam.toScreen(body.pos))) found.push(body);
      }
    }
    if (flt.walls) {
      for (const wall of app.world.walls) {
        if (inside(cam.toScreen(wall.a)) && inside(cam.toScreen(wall.b))) {
          found.push(wall);
        }
      }
    }
    if (flt.springs || flt.rods) {
      for (const link of app.world.links) {
        const want = link instanceof SpringLink ? flt.springs : flt.rods;
        if (want && inside(cam.toScreen(link.a.pos)) && inside(cam.toScreen(link.b.pos))) {
          found.push(link);
        }
      }
    }
    return found;
  }

  private constrainedWallEnd(mouse: [number, number]): Vec2 {
    let end = this.snap(this.app.camera.toWorld(mouse[0], mouse[1]));
    if (this.shiftDown && this.wallStart !== null) {
      const d = end.sub(this.wallStart);
      const ang = Math.atan2(d.y, d.x);
      const snapAng = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      end = this.wallStart.add(new Vec2(d.length(), 0).rotated(snapAng));
    }
    return end;
  }

  // ---------------------------------------------------------------- deletion
  deleteObject(obj: Selectable): void {
    const app = this.app;
    if (obj instanceof Body) {
      app.world.removeBody(obj);
      app.trails.delete(obj.id);
    } else if (obj instanceof Wall) {
      app.world.removeWall(obj);
    } else {
      app.world.removeLink(obj);
    }
    if (app.selection.includes(obj)) {
      app.setSelection(app.selection.filter((o) => o !== obj));
    }
    if (this.hover === obj) this.hover = null;
  }

  deleteSelection(): void {
    if (this.app.selection.length === 0) return;
    for (const obj of [...this.app.selection]) this.deleteObject(obj);
    this.app.setSelection([]);
    this.app.pushUndo();
  }

  duplicateSelection(): void {
    const app = this.app;
    const newSel: Selectable[] = [];
    const bodies = app.selection.filter((o): o is Body => o instanceof Body);
    const mapping = new Map<number, Body>();
    for (const body of bodies) {
      const clone = Body.fromDict(body.toDict());
      clone.id = Body.nextId++;
      clone.name = `Body ${clone.id}`;
      clone.pos = body.pos.add(new Vec2(0.3, -0.3));
      mapping.set(body.id, clone);
      app.world.bodies.push(clone);
      newSel.push(clone);
    }
    // duplicate links whose two ends were both duplicated
    for (const link of [...app.world.links]) {
      const a = mapping.get(link.a.id);
      const b = mapping.get(link.b.id);
      if (a !== undefined && b !== undefined) {
        if (link instanceof SpringLink) {
          app.world.links.push(new SpringLink(a, b, link.restLength,
                                              link.stiffness, link.damping,
                                              link.tensionOnly));
        } else {
          app.world.links.push(new DistanceLink(a, b, link.length,
                                                link.isRope, link.compliance));
        }
      }
    }
    for (const obj of app.selection) {
      if (obj instanceof Wall) {
        const clone = Wall.fromDict(obj.toDict());
        clone.id = Wall.nextId++;
        clone.a = obj.a.add(new Vec2(0.3, -0.3));
        clone.b = obj.b.add(new Vec2(0.3, -0.3));
        app.world.walls.push(clone);
        newSel.push(clone);
      }
    }
    if (newSel.length > 0) {
      app.setSelection(newSel);
      app.pushUndo();
    }
  }

  // ---------------------------------------------------------------- overlays
  drawOverlays(ctx: CanvasRenderingContext2D): void {
    const app = this.app;
    const mouse = this.mouse;
    if (this.rubber !== null) {
      const x = Math.min(this.rubber[0], mouse[0]);
      const y = Math.min(this.rubber[1], mouse[1]);
      const w = Math.abs(mouse[0] - this.rubber[0]);
      const h = Math.abs(mouse[1] - this.rubber[1]);
      ctx.fillStyle = "rgba(110,180,240,0.12)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgb(110,180,240)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    }
    if (this.wallStart !== null) {
      const end = this.constrainedWallEnd(mouse);
      const a = app.camera.toScreen(this.wallStart);
      const b = app.camera.toScreen(end);
      ctx.strokeStyle = "rgb(200,205,215)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    if (this.linkFirst !== null) {
      const a = app.camera.toScreen(this.linkFirst.pos);
      ctx.strokeStyle = "rgb(150,200,150)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(mouse[0], mouse[1]);
      ctx.stroke();
    }
    // velocity handle: for the body being right-dragged (any tool), or
    // for a single selected dynamic body with the select tool
    let body = this.velDrag;
    if (body === null && this.tool === "select" && app.selection.length === 1 &&
        app.selection[0] instanceof Body && !app.selection[0].locked) {
      body = app.selection[0];
    }
    if (body !== null && !body.locked) {
      drawVelocityHandle(ctx, app.camera, body, app.view);
    }
    void css; // (theme import used by future overlay styling)
  }
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = b.sub(a);
  const ab2 = ab.length2();
  if (ab2 === 0) return p.distTo(a);
  const t = Math.max(0.0, Math.min(1.0, p.sub(a).dot(ab) / ab2));
  return p.distTo(new Vec2(a.x + ab.x * t, a.y + ab.y * t));
}
