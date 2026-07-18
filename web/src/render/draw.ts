/** Canvas rendering: grid, bodies, walls, links and analysis overlays. */
import { Vec2 } from "../core/vec";
import { Body, Color, Wall } from "../engine/body";
import { DistanceLink, Link, SpringLink } from "../engine/links";
import { World } from "../engine/world";
import * as theme from "../ui/theme";
import { css, lighten, scale } from "../ui/theme";
import { Camera } from "./camera";
import { Trail } from "./trail";

// world metres of arrow length per unit of the quantity, at vector scale 1
export const VEL_ARROW_SCALE = 0.15;
export const ACC_ARROW_SCALE = 0.05;
export const FORCE_ARROW_SCALE = 0.05;

export type Selectable = Body | Wall | Link;

/** Toggleable overlays and display options. */
export class ViewSettings {
  grid = true;
  snap = false;
  velVectors = false;
  accVectors = false;
  forceVectors = false;
  trails = false;
  com = false;
  contacts = false;
  spatialGrid = false;
  labels = false;
  vectorScale = 1.0;
  trailLen = 350;
  follow = false;
  autoFit = false; // camera continuously frames the whole scene
}

/** Grid spacing in metres: 1/2/5*10^k such that spacing is 25-70 px. */
function niceSpacing(zoom: number): number {
  const target = 45.0 / zoom;
  let best = 1.0;
  let err = Infinity;
  for (let exp = -5; exp < 7; exp++) {
    for (const mant of [1.0, 2.0, 5.0]) {
      const c = mant * 10 ** exp;
      const e = Math.abs(c - target);
      if (e < err) {
        best = c;
        err = e;
      }
    }
  }
  return best;
}

export function snapStep(zoom: number): number {
  return niceSpacing(zoom) / 2.0;
}

export function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera,
                         w: number, h: number): void {
  const spacing = niceSpacing(cam.zoom);
  const [minX, minY, maxX, maxY] = cam.visibleBounds();
  const i0 = Math.floor(minX / spacing);
  const i1 = Math.floor(maxX / spacing) + 1;
  const j0 = Math.floor(minY / spacing);
  const j1 = Math.floor(maxY / spacing) + 1;
  if (i1 - i0 + (j1 - j0) > 400) return;
  ctx.lineWidth = 1;
  for (let i = i0; i <= i1; i++) {
    const [sx] = cam.toScreenXY(i * spacing, 0);
    const major = i % 5 === 0;
    ctx.strokeStyle = css(i === 0 ? theme.AXIS : major ? theme.GRID_MAJOR : theme.GRID);
    ctx.beginPath();
    ctx.moveTo(Math.round(sx) + 0.5, 0);
    ctx.lineTo(Math.round(sx) + 0.5, h);
    ctx.stroke();
  }
  for (let j = j0; j <= j1; j++) {
    const [, sy] = cam.toScreenXY(0, j * spacing);
    const major = j % 5 === 0;
    ctx.strokeStyle = css(j === 0 ? theme.AXIS : major ? theme.GRID_MAJOR : theme.GRID);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(sy) + 0.5);
    ctx.lineTo(w, Math.round(sy) + 0.5);
    ctx.stroke();
  }
}

export function drawArrow(ctx: CanvasRenderingContext2D,
                          start: [number, number], end: [number, number],
                          color: Color, width = 2): void {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length2 = dx * dx + dy * dy;
  if (length2 < 16) return;
  const style = css(color);
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(start[0], start[1]);
  ctx.lineTo(end[0], end[1]);
  ctx.stroke();
  const length = Math.sqrt(length2);
  const ux = dx / length;
  const uy = dy / length;
  const head = Math.min(9.0, length * 0.4);
  const px = -uy;
  const py = ux;
  ctx.fillStyle = style;
  ctx.beginPath();
  ctx.moveTo(end[0], end[1]);
  ctx.lineTo(end[0] - ux * head + px * head * 0.5, end[1] - uy * head + py * head * 0.5);
  ctx.lineTo(end[0] - ux * head - px * head * 0.5, end[1] - uy * head - py * head * 0.5);
  ctx.closePath();
  ctx.fill();
}

/** Zigzag coil between two anchor points.
 *
 * The coil count comes from the spring's rest length, so it stays constant
 * while the spring works; the amplitude fattens under compression and
 * thins under tension, like a real coil. Springs too short on screen to
 * read as coils degrade to a plain line.
 */
function drawSpringCoil(ctx: CanvasRenderingContext2D,
                        a: [number, number], b: [number, number],
                        color: Color, restPx: number): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 2.0) return;
  if (restPx <= 0.0) restPx = length;
  ctx.strokeStyle = css(color);
  if (length < 7.0 || restPx < 11.0) { // sub-coil scale: plain line
    ctx.lineWidth = length < 4 ? 1 : 2;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    return;
  }
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const lead = Math.min(9.0, length * 0.15, restPx * 0.15);
  const inner = length - 2.0 * lead;
  let coils = Math.floor(restPx * 0.12); // one coil per ~8 px at rest
  if (coils < 2) coils = 2;
  else if (coils > 10) coils = 10;
  let ratio = restPx / length; // >1 compressed, <1 stretched
  if (ratio > 1.8) ratio = 1.8;
  else if (ratio < 0.45) ratio = 0.45;
  let amp = (2.2 + restPx * 0.05) * ratio;
  if (amp > 9.0) amp = 9.0;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(a[0] + ux * lead, a[1] + uy * lead);
  const n = coils * 2;
  for (let i = 1; i < n; i++) {
    const f = i / n;
    const off = i % 2 ? amp : -amp;
    ctx.lineTo(a[0] + ux * (lead + inner * f) + px * off,
               a[1] + uy * (lead + inner * f) + py * off);
  }
  ctx.lineTo(b[0] - ux * lead, b[1] - uy * lead);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}

function line(ctx: CanvasRenderingContext2D, a: [number, number],
              b: [number, number], color: Color, width: number): void {
  ctx.strokeStyle = css(color);
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}

function fillCircle(ctx: CanvasRenderingContext2D, cx: number, cy: number,
                    r: number, color: Color): void {
  ctx.fillStyle = css(color);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fill();
}

function ringCircle(ctx: CanvasRenderingContext2D, cx: number, cy: number,
                    r: number, width: number, color: Color): void {
  ctx.strokeStyle = css(color);
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.stroke();
}

const STRING_TAUT: Color = [170, 150, 115];
const STRING_SLACK: Color = [140, 125, 100];
const STRING_HOVER: Color = [215, 190, 150];

// Total gradient strokes to spend across all trails per frame. A single
// trail fades over up to MAX_BANDS colour bands; when many trails are on
// screen the band count is shared out so the frame cost stays bounded.
const TRAIL_STROKE_BUDGET = 900;
const MAX_BANDS = 24;
// Cap the vertices drawn per trail: beyond this the extra points are
// sub-pixel and invisible, so decimate. Keeps very long trails cheap.
const MAX_TRAIL_VERTS = 600;

/** rgb() string faded from the background toward `base` by fraction f,
 * without allocating an intermediate Color (this runs per band per trail). */
function fadedRgb(base: Color, f: number): string {
  const bg = theme.BG;
  const r = (bg[0] + (base[0] - bg[0]) * f) | 0;
  const g = (bg[1] + (base[1] - bg[1]) * f) | 0;
  const b = (bg[2] + (base[2] - bg[2]) * f) | 0;
  return `rgb(${r},${g},${b})`;
}

function drawTrails(ctx: CanvasRenderingContext2D, cam: Camera, world: World,
                    trails: Map<number, Trail>,
                    minX: number, minY: number, maxX: number, maxY: number): void {
  ctx.lineWidth = 1;
  const bands = Math.max(1, Math.min(MAX_BANDS,
    Math.floor(TRAIL_STROKE_BUDGET / Math.max(1, trails.size))));
  for (const [bid, trail] of trails) {
    const n = trail.count;
    if (n < 2) continue;
    // cull trails whose bounding box lies entirely outside the viewport
    if (trail.maxX < minX || trail.minX > maxX ||
        trail.maxY < minY || trail.minY > maxY) continue;
    const body = world.bodyById(bid);
    const base: Color = body ? body.color : [120, 130, 140];
    const stride = Math.max(1, Math.ceil(n / MAX_TRAIL_VERTS));
    const last = n - 1;
    // draw `bands` contiguous colour bands oldest -> newest; each band ends
    // exactly where the next begins so the line stays unbroken
    for (let bnd = 0; bnd < bands; bnd++) {
      const i0 = Math.floor((bnd * last) / bands);
      const i1 = Math.floor(((bnd + 1) * last) / bands);
      if (i1 <= i0) continue;
      ctx.strokeStyle = fadedRgb(base, i0 / n);
      ctx.beginPath();
      const [sx0, sy0] = cam.toScreenXY(trail.x(i0), trail.y(i0));
      ctx.moveTo(sx0, sy0);
      for (let k = i0 + stride; k < i1; k += stride) {
        const [sx, sy] = cam.toScreenXY(trail.x(k), trail.y(k));
        ctx.lineTo(sx, sy);
      }
      const [sxE, syE] = cam.toScreenXY(trail.x(i1), trail.y(i1));
      ctx.lineTo(sxE, syE);
      ctx.stroke();
    }
  }
}

export function drawWorld(ctx: CanvasRenderingContext2D, cam: Camera,
                          world: World, view: ViewSettings,
                          selection: Selectable[], hover: Selectable | null,
                          trails: Map<number, Trail>,
                          areaW: number, areaH: number): void {
  const [minX, minY, maxX, maxY] = cam.visibleBounds();

  // --- trails ---------------------------------------------------------------
  if (view.trails) drawTrails(ctx, cam, world, trails, minX, minY, maxX, maxY);

  // --- links -----------------------------------------------------------------
  for (const link of world.links) {
    const pa = cam.toScreen(link.a.pos);
    const pb = cam.toScreen(link.b.pos);
    const selected = selection.includes(link);
    const hovered = link === hover;
    if (link instanceof SpringLink) {
      if (link.tensionOnly) {
        // elastic string: a plain line, thinner while slack
        const slack = link.a.pos.distTo(link.b.pos) < link.restLength;
        const color = selected ? theme.SELECTION
          : hovered ? STRING_HOVER : slack ? STRING_SLACK : STRING_TAUT;
        line(ctx, pa, pb, color, slack ? 1 : 2);
      } else {
        const color: Color = selected ? theme.SELECTION
          : hovered ? [200, 205, 215] : [135, 142, 152];
        drawSpringCoil(ctx, pa, pb, color, link.restLength * cam.zoom);
      }
    } else if (link.isRope) {
      // inelastic string: rigid in tension, free when slack
      const slack = link.a.pos.distTo(link.b.pos) < link.length - 1e-9;
      const color = selected ? theme.SELECTION
        : hovered ? STRING_HOVER : slack ? STRING_SLACK : STRING_TAUT;
      line(ctx, pa, pb, color, slack ? 1 : 2);
    } else {
      const color: Color = selected ? theme.SELECTION
        : hovered ? [200, 205, 215] : [150, 156, 166];
      line(ctx, pa, pb, color, 3);
    }
  }

  // --- walls -------------------------------------------------------------------
  for (const wall of world.walls) {
    const pa = cam.toScreen(wall.a);
    const pb = cam.toScreen(wall.b);
    const wPx = Math.max(2, Math.floor(wall.thickness * cam.zoom));
    const selected = selection.includes(wall);
    const color = selected ? theme.SELECTION
      : wall === hover ? lighten(wall.color, 30) : wall.color;
    ctx.lineCap = "round"; // capsule: round end caps replace the endpoint discs
    line(ctx, pa, pb, color, wPx);
    ctx.lineCap = "butt";
    if (selected) { // endpoint handles for direct manipulation
      for (const p of [pa, pb]) {
        fillCircle(ctx, p[0], p[1], 5, [255, 255, 255]);
        ringCircle(ctx, p[0], p[1], 5, 2, theme.ACCENT);
      }
    }
  }

  // --- bodies ---------------------------------------------------------------------
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  for (const body of world.bodies) {
    const r = body.radius;
    if (body.pos.x + r < minX || body.pos.x - r > maxX ||
        body.pos.y + r < minY || body.pos.y - r > maxY) {
      continue;
    }
    const [sx, sy] = cam.toScreen(body.pos);
    const pr = Math.max(2, body.radius * cam.zoom);
    let color = body.color;
    if (body === hover && !selection.includes(body)) color = lighten(color, 35);
    fillCircle(ctx, sx, sy, pr, color);
    const edge = scale(color, 0.55);
    ringCircle(ctx, sx, sy, pr, Math.max(1, pr / 9), edge);
    if (pr >= 5 && !body.locked) {
      // rotation marker so spin/rolling is visible
      const ex = sx + Math.cos(body.angle) * pr * 0.85;
      const ey = sy - Math.sin(body.angle) * pr * 0.85;
      line(ctx, [sx, sy], [ex, ey], edge, Math.max(1, pr / 8));
    }
    if (body.locked) {
      fillCircle(ctx, sx, sy, Math.max(2, pr / 3), [230, 233, 240]);
      ringCircle(ctx, sx, sy, Math.max(2, pr / 3), 1, [90, 95, 105]);
    }
    if (selection.includes(body)) {
      ringCircle(ctx, sx, sy, pr + 3, 2, theme.SELECTION);
    }
    if (view.labels && pr >= 3) {
      ctx.fillStyle = css(theme.TEXT_DIM);
      ctx.fillText(body.name, sx, sy - pr - 6);
    }
  }
  ctx.textAlign = "left";

  // --- vectors ------------------------------------------------------------------------
  const vScale = view.vectorScale;
  if (view.velVectors || view.accVectors || view.forceVectors) {
    for (const body of world.bodies) {
      if (body.invMass === 0.0) continue;
      const [sx, sy] = cam.toScreen(body.pos);
      if (sx < 0 || sx > areaW || sy < 0 || sy > areaH) continue;
      if (view.velVectors) {
        const end = cam.toScreenXY(body.pos.x + body.vel.x * VEL_ARROW_SCALE * vScale,
                                   body.pos.y + body.vel.y * VEL_ARROW_SCALE * vScale);
        drawArrow(ctx, [sx, sy], end, theme.VEL_COLOR);
      }
      if (view.accVectors) {
        const end = cam.toScreenXY(body.pos.x + body.acc.x * ACC_ARROW_SCALE * vScale,
                                   body.pos.y + body.acc.y * ACC_ARROW_SCALE * vScale);
        drawArrow(ctx, [sx, sy], end, theme.ACC_COLOR);
      }
      if (view.forceVectors) {
        const fx = body.acc.x * body.mass;
        const fy = body.acc.y * body.mass;
        const end = cam.toScreenXY(body.pos.x + fx * FORCE_ARROW_SCALE * vScale,
                                   body.pos.y + fy * FORCE_ARROW_SCALE * vScale);
        drawArrow(ctx, [sx, sy], end, theme.FORCE_COLOR);
      }
    }
  }

  // --- contact normals ------------------------------------------------------------------
  if (view.contacts) {
    for (const c of world.contacts) {
      const p = cam.toScreenXY(c.px, c.py);
      const q = cam.toScreenXY(c.px + c.nx * 0.25, c.py + c.ny * 0.25);
      drawArrow(ctx, p, q, theme.WARN, 1);
      fillCircle(ctx, p[0], p[1], 2, theme.WARN);
    }
  }

  // --- centre of mass ----------------------------------------------------------------------
  if (view.com) {
    const com = world.centreOfMass();
    if (com !== null) {
      const [sx, sy] = cam.toScreen(com);
      ringCircle(ctx, sx, sy, 7, 1, [255, 255, 255]);
      line(ctx, [sx - 9, sy], [sx + 9, sy], [255, 255, 255], 1);
      line(ctx, [sx, sy - 9], [sx, sy + 9], [255, 255, 255], 1);
      ctx.fillStyle = css(theme.TEXT_DIM);
      ctx.fillText("COM", sx + 10, sy + 14);
    }
  }

  // --- spatial hash debug grid -------------------------------------------------------------------
  if (view.spatialGrid && world.bodies.length > 0) {
    let maxR = 0.0;
    for (const b of world.bodies) if (b.radius > maxR) maxR = b.radius;
    const cell = Math.max(4.0 * maxR, 0.05);
    const i0 = Math.floor(minX / cell);
    const i1 = Math.floor(maxX / cell) + 1;
    const j0 = Math.floor(minY / cell);
    const j1 = Math.floor(maxY / cell) + 1;
    if (i1 - i0 + (j1 - j0) < 200) {
      const c: Color = [70, 45, 45];
      for (let i = i0; i <= i1; i++) {
        const [sx] = cam.toScreenXY(i * cell, 0);
        line(ctx, [sx, 0], [sx, areaH], c, 1);
      }
      for (let j = j0; j <= j1; j++) {
        const [, sy] = cam.toScreenXY(0, j * cell);
        line(ctx, [0, sy], [areaW, sy], c, 1);
      }
    }
  }
}

export interface HandleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Draggable arrow-tip handle used to set a body's velocity directly. */
export function drawVelocityHandle(ctx: CanvasRenderingContext2D, cam: Camera,
                                   body: Body, view: ViewSettings): HandleRect {
  const s = VEL_ARROW_SCALE * view.vectorScale;
  const tipWorld = new Vec2(body.pos.x + body.vel.x * s, body.pos.y + body.vel.y * s);
  const start = cam.toScreen(body.pos);
  const tip = cam.toScreen(tipWorld);
  drawArrow(ctx, start, tip, theme.VEL_COLOR, 2);
  const handle: HandleRect = { x: tip[0] - 6, y: tip[1] - 6, w: 12, h: 12 };
  ctx.fillStyle = css(theme.VEL_COLOR);
  roundRect(ctx, handle.x, handle.y, handle.w, handle.h, 3);
  ctx.fill();
  ctx.strokeStyle = css([20, 40, 20]);
  ctx.lineWidth = 1;
  roundRect(ctx, handle.x, handle.y, handle.w, handle.h, 3);
  ctx.stroke();
  return handle;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number,
                   w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export function drawScaleBar(ctx: CanvasRenderingContext2D, cam: Camera,
                             areaW: number, areaH: number): void {
  const [length, label] = cam.niceScaleLength();
  const px = length * cam.zoom;
  const x1 = areaW - 24;
  const x0 = x1 - px;
  const y = areaH - 20;
  const c = theme.TEXT_DIM;
  line(ctx, [x0, y], [x1, y], c, 2);
  line(ctx, [x0, y - 4], [x0, y + 4], c, 2);
  line(ctx, [x1, y - 4], [x1, y + 4], c, 2);
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = css(c);
  ctx.fillText(label, (x0 + x1) / 2, y - 8);
  ctx.textAlign = "left";
}

/** Hit test helpers shared by the interaction layer. */
export function distToSegment(px: number, py: number, ax: number, ay: number,
                              bx: number, by: number): number {
  const sx = bx - ax;
  const sy = by - ay;
  const len2 = sx * sx + sy * sy;
  let t = 0.0;
  if (len2 > 0) {
    t = ((px - ax) * sx + (py - ay) * sy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const dx = px - (ax + sx * t);
  const dy = py - (ay + sy * t);
  return Math.sqrt(dx * dx + dy * dy);
}

export { DistanceLink };
