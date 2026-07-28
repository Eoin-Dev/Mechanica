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
import { nameTable } from "../core/expr";
import { Vec2 } from "../core/vec";
import { sweepClearOfWalls } from "../engine/contacts";
import { Body, Wall } from "../engine/body";
import { DistanceLink, Link, SpringLink } from "../engine/links";
import { Driver } from "../engine/world";
import { Selectable, VEL_ARROW_SCALE, distToSegment, drawVelocityHandle,
         snapStep } from "../render/draw";
import { isTouch } from "../ui/dom";
import type { App } from "../app";

export const TOOLS = ["select", "pan", "body", "anchor", "wall",
                      "rod", "rope", "spring", "eraser"] as const;
export type Tool = (typeof TOOLS)[number];

// nameTable: this is indexed by a live keystroke (`e.key.toLowerCase()` in
// ui/shortcuts.ts), and on a plain object literal `"constructor" in TOOL_KEYS`
// is true - so a synthetic key event naming a prototype member would have set
// the current tool to a host function. No physical keyboard produces such a
// key, but the table costs nothing to close and the same shape has already
// been a real bug twice in this codebase (see nameTable in core/expr.ts).
export const TOOL_KEYS: Record<string, Tool> = nameTable<Tool>({
  v: "select", h: "pan", b: "body", a: "anchor", w: "wall",
  r: "rod", e: "rope", s: "spring", x: "eraser",
});

export const TOOL_INFO: Record<Tool, [string, string]> = {
  select: ["Select (V)", "Click to select, drag to move - a body keeps the " +
           "motion it had, running or not. Shift-click adds. Drag empty " +
           "space for a box select. Right-drag a body (or drag the green " +
           "arrow) to set its velocity."],
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

/** Touch wording for the hint bar (phones and tablets): short, tap-based,
 * and free of the PC-only interactions (keyboard keys, hover, right/middle
 * drag). */
export const TOOL_INFO_TOUCH: Record<Tool, string> = {
  select: "Tap to select, drag to move - a body keeps the motion it had. " +
          "Drag empty space for a box select.",
  pan: "Drag to move the view. Pinch with two fingers to zoom.",
  body: "Tap to place a dynamic body. Edit it in the Inspector.",
  anchor: "Tap to place a fixed anchor for rods, strings and springs.",
  wall: "Drag to draw a static wall.",
  rod: "Tap two bodies to join them rigidly. Tap empty space to " +
       "auto-create an anchor/body.",
  rope: "Tap two bodies to join with an elastic string (pulls only " +
        "when stretched).",
  spring: "Tap two bodies to join them with a spring.",
  eraser: "Tap bodies, walls or links to delete them.",
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

// How hard user dragging may hit the physics.
//
// A grabbed body follows the cursor EXACTLY. While it is held it reports its
// TRUE per-frame displacement as its velocity, because the contact and
// constraint solvers read relative velocities: without that, a dragged body
// shoved into a pile would push nothing and a dragged pendulum anchor would
// not carry its bob. That reported velocity is capped at DRAG_VEL_CAP so a
// fast flick cannot inject a huge amount of energy, and everything
// link-connected to a grab is additionally speed-clamped each substep at
// DRAG_CHASE_CAP as a blow-up guard.
//
// The reported velocity is a means to an end and never survives the drag:
// releasing restores whatever the body had when it was grabbed (see
// dragVel0). Left-dragging is repositioning, not throwing - you put
// something where you want it and the motion it already had carries on. It
// used to release at the cursor's velocity, which meant a drag could not be
// done without also flinging the thing you were trying to place, and made
// the "hold it still to pin it" gesture the only way to move anything
// without changing its motion. Aiming a velocity deliberately is the
// right-drag / green-arrow gesture, which is untouched.
const DRAG_VEL_CAP = 14.0;   // m/s - the grabbed body's reported speed
const DRAG_CHASE_CAP = 20.0; // m/s - per-substep clamp on linked bodies

interface DragItem {
  body: Body;
  offset: Vec2;
  /** Velocity the body had when the drag activated, restored on release. */
  vel0: Vec2;
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
  private dragPrev: { x: number; y: number; t: number } | null = null;
  // bodies currently under a chase-speed cap, so release always clears it
  private capped = new Set<Body>();
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

  /** Release every dragged body, restoring the velocity it was grabbed with.
   *
   * Shared by a normal release and by abortDrag, because the answer is the
   * same either way: the drag borrowed the velocity field to talk to the
   * solver and now gives it back. A body that was never activated was never
   * held and never had its velocity touched, so restoring is still correct -
   * vel0 is what it has.
   */
  private releaseDragged(): void {
    this.clearChaseCaps();
    for (const { body, vel0 } of this.dragItems) {
      body.held = false;
      // a locked body or anchor never had a velocity written (see updateDrag)
      if (!body.locked) body.vel.setVec(vel0);
    }
    this.dragItems = [];
    this.dragActive = false;
    this.dragPrev = null;
  }

  /** Drop any in-progress drag (e.g. world replaced). */
  abortDrag(): void {
    this.releaseDragged();
    this.velDrag = null;
    this.wallDrag = null;
    this.wallGrab = null;
  }

  /** Refresh the drag every frame (pointer-move events stop while the
   * cursor is parked, but the simulation keeps running).
   *
   * Grabbed bodies follow the cursor EXACTLY - the position is never
   * limited, so the body is always under the pointer. The velocity each
   * reports to the physics while held is its TRUE per-frame displacement
   * (consistent with the move, so the contact and constraint solvers read
   * correct relative velocities and links carry momentum - a stopped anchor
   * lets a pendulum lunge on), capped at DRAG_VEL_CAP so a fast flick can't
   * inject a huge amount of energy. Everything link-connected keeps
   * simulating with real link physics under a per-substep speed clamp, a
   * blow-up guard that a normal drag never touches.
   *
   * None of that velocity outlives the drag: release restores what the body
   * was grabbed with (see releaseDragged), so a drag moves a body without
   * also throwing it. */
  updateDrag(): void {
    if (this.dragItems.length === 0 || !this.dragActive) return;
    const app = this.app;
    const worldP = app.camera.toWorld(this.mouse[0], this.mouse[1]);
    if (!app.playing) {
      // paused = pure editing: reposition only, keep the velocity so a
      // click or drag never wipes the body's motion state
      this.clearChaseCaps();
      this.dragPrev = null;
      const solidPaused = app.dragHitsWalls;
      for (const { body, offset } of this.dragItems) {
        let t = this.snap(new Vec2(worldP.x + offset.x, worldP.y + offset.y));
        // Walls are solid while paused too. Whether the clock is running
        // is irrelevant to where a body is allowed to BE - and placing
        // things is mostly done paused, so applying it only during play
        // meant the setting appeared to do nothing most of the time.
        if (solidPaused && !body.locked) {
          const [cx, cy] =
            sweepClearOfWalls(app.world.walls, body.pos, t, body.radius);
          t = new Vec2(cx, cy);
        }
        body.pos.setVec(t);
      }
      return;
    }

    const now = performance.now() / 1000;
    const firstFrame = this.dragPrev === null;
    const dt = firstFrame
      ? 1 / 60
      : Math.min(0.1, Math.max(1e-3, now - this.dragPrev!.t));
    this.dragPrev = { x: worldP.x, y: worldP.y, t: now };

    const solid = this.app.dragHitsWalls;
    for (const { body, offset } of this.dragItems) {
      let t = this.snap(new Vec2(worldP.x + offset.x, worldP.y + offset.y));
      // sweep from where the body actually is, so a fast flick cannot
      // step over a wall between frames
      if (solid && !body.locked) {
        // sweep from where the body actually is, so a fast flick cannot
        // step over a wall between frames
        const [cx, cy] =
          sweepClearOfWalls(this.app.world.walls, body.pos, t, body.radius);
        t = new Vec2(cx, cy);
      }
      if (body.locked) {
        // A locked body or anchor is being repositioned, not thrown: it
        // never integrates, so a "velocity" written here would just sit in
        // its state - showing a moving anchor in the inspector, and firing
        // it off the moment anyone unlocked it.
        body.pos.setVec(t);
        continue;
      }
      // true displacement velocity: exactly how far the body moves this
      // frame, so position and velocity stay consistent for the solver.
      // Capped to tone the energy way down on fast flicks; zero on the
      // very first frame so the click-to-activate jump is not a spike.
      let vx = 0.0;
      let vy = 0.0;
      if (!firstFrame) {
        vx = (t.x - body.pos.x) / dt;
        vy = (t.y - body.pos.y) / dt;
        const sp = Math.hypot(vx, vy);
        if (sp > DRAG_VEL_CAP) {
          vx *= DRAG_VEL_CAP / sp;
          vy *= DRAG_VEL_CAP / sp;
        }
      }
      body.vel.set(vx, vy);
      body.pos.setVec(t);
    }
    this.applyChaseCaps();
  }

  /** Speed-cap everything link-connected to the grabbed bodies
   * (transitively; anchors and locked bodies excepted). Recomputed every
   * frame so links added or deleted mid-drag are always honoured. */
  private applyChaseCaps(): void {
    const world = this.app.world;
    const inGroup = new Set<Body>(this.dragItems.map((it) => it.body));
    const queue = [...inGroup];
    while (queue.length > 0) {
      const b = queue.pop()!;
      for (const ln of world.links) {
        let other: Body | null = null;
        if (ln.a === b) other = ln.b;
        else if (ln.b === b) other = ln.a;
        if (other === null || inGroup.has(other)) continue;
        if (other.isAnchor || other.locked || other.held) continue;
        inGroup.add(other);
        queue.push(other);
      }
    }
    for (const b of this.capped) {
      if (!inGroup.has(b)) {
        b.speedCap = Infinity;
        this.capped.delete(b);
      }
    }
    for (const b of inGroup) {
      if (this.dragItems.some((it) => it.body === b)) continue;
      b.speedCap = DRAG_CHASE_CAP;
      this.capped.add(b);
    }
  }

  /** Lift every chase cap (drag ended, paused, or world replaced). */
  private clearChaseCaps(): void {
    for (const b of this.capped) b.speedCap = Infinity;
    this.capped.clear();
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
    const touch = isTouch();
    if ((this.tool === "rod" || this.tool === "rope" || this.tool === "spring") &&
        this.linkFirst !== null) {
      return touch
        ? "Now tap a second body (or empty space) to finish the link."
        : "Now click a second body (or empty space) to finish the link. Esc cancels.";
    }
    if (this.tool === "wall" && this.wallStart !== null) {
      return touch
        ? "Release to finish the wall."
        : "Release to finish the wall. Hold Shift to snap the angle.";
    }
    return touch ? TOOL_INFO_TOUCH[this.tool] : TOOL_INFO[this.tool][1];
  }

  // ------------------------------------------------------------------ events
  /** Drop every in-progress gesture: drag, pan, rubber band, pinch, and the
   * two multi-click gestures (a half-drawn wall, a half-made link).
   *
   * `linkFirst` was the one thing this did not clear, while `wallStart`
   * beside it was - and a link's first endpoint is a BODY REFERENCE, which
   * makes it the one that outlives a world. Pick the rod tool, click one
   * body, then load a scene or press undo, then click again: the second
   * click completed the link against a body from the world before, so the
   * new world got a link with an endpoint that is not in it. It drew as a
   * line to a phantom point and the rod solver pulled a real body toward
   * nothing. Saving and reloading silently dropped the link, which made it
   * look like a rendering glitch rather than a live constraint.
   */
  resetInteraction(): void {
    this.abortDrag();
    this.pointers.clear();
    this.pinchDist = 0;
    this.rubber = null;
    this.wallStart = null;
    this.linkFirst = null;
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
    // Reset once, for every path out of this function. It used to be set
    // only on the body-drag path, so a wall press inherited the previous
    // gesture's flag and released as if it had moved - pushing an undo
    // entry that the stack then discarded as identical, but only after
    // rebuilding the whole inspector for it.
    this.dragMoved = false;

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
    // mass so they stay put while everything else collides with them
    // vel0 is captured at PRESS, not at activation: the simulation keeps
    // running between the two, so grabbing a falling ball and restoring the
    // velocity it had when your finger went down is what "the motion it
    // already had" means to the person doing it.
    this.dragItems = app.selection
      .filter((o): o is Body => o instanceof Body)
      .map((b) => ({ body: b, offset: b.pos.sub(worldP), vel0: b.vel.copy() }));
    // bodies are NOT held yet: the drag arms here and only activates
    // once the cursor moves, so an inspect-click leaves the physics alone
    this.dragPress = mouse;
    this.dragActive = false;
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
        // first left-drag of a soft-body particle: nudge the user toward
        // right-drag (velocity drag), which pulls without deforming. Shown
        // once per soft-body preset load (see App.softBodyHintArmed).
        if (this.app.softBodyHintArmed &&
            this.dragItems.some((it) => it.body.softBody)) {
          this.app.softBodyHintArmed = false;
          this.app.toast(isTouch()
            ? "Tip: drag the green arrow to pull a soft body by velocity - it won't deform."
            : "Tip: right-drag a soft body to pull it by velocity - it won't deform.");
        }
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
      // An inactive (never-moved) press was a pure inspect-click: the bodies
      // were never held, so there is nothing to undo. Either way the release
      // hands each dragged body back the velocity it was grabbed with, so a
      // drag repositions without throwing - running or paused, one body or a
      // whole box selection.
      this.releaseDragged();
      if (this.dragMoved) app.pushUndo();
      this.velDrag = null;
      this.wallDrag = null;
      this.wallGrab = null;
    }
    if (this.rubber !== null) {
      const [x0, y0] = this.rubber;
      const [x1, y1] = mouse;
      const rect = { x: Math.min(x0, x1), y: Math.min(y0, y1),
                     w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      // one long dimension is enough: a flat box over a row of bodies (or
      // a tall one over a column) is a deliberate selection - requiring
      // BOTH dimensions silently selected nothing. Click jitter stays
      // excluded because both dimensions are tiny.
      if (rect.w > 4 || rect.h > 4) {
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
  /** Drop every reference this controller holds to an object the world no
   * longer contains.
   *
   * Deleting a body cascade-deletes every link attached to it, so removing
   * just the object that was asked for left the inspector editing ghosts -
   * a selected spring whose endpoint was erased stayed "selected" although
   * it no longer existed.
   *
   * The controller keeps FIVE such references, and only three were being
   * cleaned. The two that were not are both live gestures:
   *
   *   - `linkFirst` is the first endpoint of a half-made link. Erase that
   *     body (or box-select and delete, or undo it away) and the next click
   *     completed the link against it anyway, putting a link into the world
   *     with an endpoint that is not in it: drawn as a line to a phantom
   *     point, and fed to the rod solver, which then pulled a real body
   *     toward nothing. Saving and reloading dropped the link silently,
   *     which disguised a live constraint as a rendering glitch.
   *   - `velDrag` / `wallDrag` are the objects being aimed or reshaped, and
   *     kept receiving edits after deletion - edits that then pushed an
   *     undo entry for a change to something that does not exist.
   *
   * Found by the random operation fuzzer, not by inspection: both need a
   * delete to land in the middle of a multi-step gesture.
   */
  private pruneDeleted(): void {
    const app = this.app;
    const w = app.world;
    const alive = (o: Selectable): boolean =>
      o instanceof Body ? w.bodies.includes(o)
        : o instanceof Wall ? w.walls.includes(o)
          : w.links.includes(o);
    if (this.hover !== null && !alive(this.hover)) this.hover = null;
    if (this.dragItems.some(({ body }) => !alive(body))) this.abortDrag();
    if (this.linkFirst !== null && !alive(this.linkFirst)) this.linkFirst = null;
    if (this.velDrag !== null && !alive(this.velDrag)) this.velDrag = null;
    if (this.wallDrag !== null && !alive(this.wallDrag[0])) {
      this.wallDrag = null;
      this.wallGrab = null;
    }
    if (app.selection.some((o) => !alive(o))) {
      app.setSelection(app.selection.filter(alive));
    }
  }

  /** Remove one object, and anything that depended on it (the eraser). */
  deleteObject(obj: Selectable): void {
    this.deleteObjects([obj]);
  }

  /** Remove any number of objects at once, reconciling once at the end.
   *
   * Everything that deletes goes through here, because everything that
   * deletes in bulk needs it to: the runaway cull can bin hundreds inside
   * a single frame while the simulation runs, Delete acts on a whole box
   * selection, and the Inspector has "Delete every ..." buttons. One
   * object at a time each of those is quadratic twice over - once in the
   * world's own list edits, once in the reconciliation scan - which at a
   * thousand objects was 50 ms of dropped frame, and at two thousand a
   * quarter of a second, for an operation that is linear by nature.
   */
  deleteObjects(objs: Iterable<Selectable>): void {
    const app = this.app;
    const bodies = new Set<Body>();
    const walls = new Set<Wall>();
    const links = new Set<Link>();
    for (const o of objs) {
      if (o instanceof Body) {
        bodies.add(o);
        app.trails.delete(o.id);
      } else if (o instanceof Wall) {
        walls.add(o);
      } else {
        links.add(o);
      }
    }
    app.world.removeBodies(bodies); // cascades their links and drivers
    app.world.removeWalls(walls);
    app.world.removeLinks(links);
    this.pruneDeleted();
  }

  deleteSelection(): void {
    if (this.app.selection.length === 0) return;
    this.deleteObjects([...this.app.selection]);
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
      // anchors are always called "Anchor" - the generic rename would have
      // produced a thing labelled "Body 12" that is still an anchor
      if (!clone.isAnchor) clone.name = `Body ${clone.id}`;
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
    // ...and the sinusoidal drivers of the duplicated bodies. A driver is
    // as much a property of its body as a link is of its endpoints, so
    // copying the springs but silently dropping the driver left a
    // duplicated oscillator sitting dead beside a running one, with
    // nothing in the inspector to say why.
    for (const drv of [...app.world.drivers]) {
      const clone = mapping.get(drv.bodyId);
      if (clone === undefined) continue;
      const copy = Driver.fromDict(drv.toDict());
      copy.bodyId = clone.id;
      app.world.drivers.push(copy);
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
    // for a single selected dynamic body with the select tool. Hidden
    // while a left-drag is active: that drag positions the body and only
    // borrows its velocity for the throw, so a handle whipping around
    // with the cursor would read as if left-drag were setting velocity -
    // which is the right-drag gesture's job.
    let body = this.velDrag;
    if (body === null && this.tool === "select" && app.selection.length === 1 &&
        app.selection[0] instanceof Body && !app.selection[0].locked &&
        !(this.dragActive &&
          this.dragItems.some((it) => it.body === app.selection[0]))) {
      body = app.selection[0];
    }
    if (body !== null && !body.locked) {
      drawVelocityHandle(ctx, app.camera, body, app.view);
    }
  }
}
