/** Canvas rendering: grid, bodies, walls, links and analysis overlays. */
import { Vec2 } from "../core/vec";
import { Body, Color, Wall } from "../engine/body";
import { Link, SpringLink } from "../engine/links";
import { World } from "../engine/world";
import * as theme from "../ui/theme";
import { css, lighten } from "../ui/theme";
import { Camera, niceNumber } from "./camera";
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

/** Grid spacing in metres: the nearest 1/2/5*10^k to ~45 px on screen. */
function niceSpacing(zoom: number): number {
  return niceNumber(45.0 / zoom);
}

export function snapStep(zoom: number): number {
  return niceSpacing(zoom) / 2.0;
}

export function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera,
                         w: number, h: number, coarse = false): void {
  const spacing = niceSpacing(cam.zoom);
  const halfW = (cam.screenW * 0.5) / cam.zoom;
  const halfH = (cam.screenH * 0.5) / cam.zoom;
  const minX = cam.centre.x - halfW;
  const maxX = cam.centre.x + halfW;
  const minY = cam.centre.y - halfH;
  const maxY = cam.centre.y + halfH;
  const i0 = Math.floor(minX / spacing);
  const i1 = Math.floor(maxX / spacing) + 1;
  const j0 = Math.floor(minY / spacing);
  const j1 = Math.floor(maxY / spacing) + 1;
  if (i1 - i0 + (j1 - j0) > 400) return;
  // Keep each line as its own narrow current path. Combining the disjoint
  // lines into a few explicit Path2Ds gives those paths almost full-canvas
  // bounds; Chromium/Edge then scale their raster work with backing-canvas
  // area (including devicePixelRatio), which can make an otherwise empty
  // scene render-bound on a large display. Object geometry below still
  // benefits from style batching only for connected/local link and vector
  // geometry. Disjoint bodies and dense trails stay in bounded paths below.
  ctx.lineWidth = 1;
  for (let i = i0; i <= i1; i++) {
    if (coarse && i !== 0 && i % 5 !== 0) continue;
    const [sx] = cam.toScreenXY(i * spacing, 0);
    const color = i === 0 ? theme.AXIS
      : i % 5 === 0 ? theme.GRID_MAJOR : theme.GRID;
    const x = Math.round(sx) + 0.5;
    ctx.strokeStyle = css(color);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let j = j0; j <= j1; j++) {
    if (coarse && j !== 0 && j % 5 !== 0) continue;
    const [, sy] = cam.toScreenXY(0, j * spacing);
    const color = j === 0 ? theme.AXIS
      : j % 5 === 0 ? theme.GRID_MAJOR : theme.GRID;
    const y = Math.round(sy) + 0.5;
    ctx.strokeStyle = css(color);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

/** Shaft and head of one arrow, appended to a stroke batch and a fill batch.
 *
 * Vector overlays draw one arrow per body per enabled quantity, so a
 * 200-particle gas with velocity arrows on issued 400 calls; batched it is
 * two, because every arrow of a kind shares one colour and width. */
function addArrowXY(strokes: StyleBatch, fills: StyleBatch,
                    sx: number, sy: number, ex: number, ey: number,
                    color: Color, width = 2): void {
  const dx = ex - sx;
  const dy = ey - sy;
  const length2 = dx * dx + dy * dy;
  if (length2 < 16) return;
  addLine(strokes.path(color, width), sx, sy, ex, ey);
  const length = Math.sqrt(length2);
  const ux = dx / length;
  const uy = dy / length;
  const head = Math.min(9.0, length * 0.4);
  const px = -uy;
  const py = ux;
  const p = fills.path(color);
  p.moveTo(ex, ey);
  p.lineTo(ex - ux * head + px * head * 0.5, ey - uy * head + py * head * 0.5);
  p.lineTo(ex - ux * head - px * head * 0.5, ey - uy * head - py * head * 0.5);
  p.closePath();
}

/** One arrow, drawn immediately. For the handful of arrows that are not part
 * of a per-body sweep (the velocity handle, contact normals). */
export function drawArrow(ctx: CanvasRenderingContext2D,
                          start: [number, number], end: [number, number],
                          color: Color, width = 2): void {
  addArrowXY(STROKES, FILLS, start[0], start[1], end[0], end[1], color, width);
  STROKES.strokeAll(ctx);
  FILLS.fillAll(ctx);
}

/** Zigzag coil between two anchor points.
 *
 * The coil count comes from the spring's rest length, so it stays constant
 * while the spring works; the amplitude fattens under compression and
 * thins under tension, like a real coil. Springs too short on screen to
 * read as coils degrade to a plain line.
 */
function addSpringCoil(batch: StyleBatch,
                       ax: number, ay: number, bx: number, by: number,
                       color: Color, restPx: number,
                       maxCoils = 10): void {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 2.0) return;
  if (restPx <= 0.0) restPx = length;
  if (length < 7.0 || restPx < 11.0) { // sub-coil scale: plain line
    addLine(batch.path(color, length < 4 ? 1 : 2), ax, ay, bx, by);
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
  else if (coils > maxCoils) coils = maxCoils;
  let ratio = restPx / length; // >1 compressed, <1 stretched
  if (ratio > 1.8) ratio = 1.8;
  else if (ratio < 0.45) ratio = 0.45;
  let amp = (2.2 + restPx * 0.05) * ratio;
  if (amp > 9.0) amp = 9.0;
  const path = batch.path(color, 2);
  path.moveTo(ax, ay);
  path.lineTo(ax + ux * lead, ay + uy * lead);
  const n = coils * 2;
  for (let i = 1; i < n; i++) {
    const f = i / n;
    const off = i % 2 ? amp : -amp;
    path.lineTo(ax + ux * (lead + inner * f) + px * off,
                ay + uy * (lead + inner * f) + py * off);
  }
  path.lineTo(bx - ux * lead, by - uy * lead);
  path.lineTo(bx, by);
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

function lineXY(ctx: CanvasRenderingContext2D, ax: number, ay: number,
                bx: number, by: number, color: Color, width: number): void {
  ctx.strokeStyle = css(color);
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
}

// ------------------------------------------------------------- draw batching
/** Same-styled connected geometry collected into one Path2D per style.
 *
 * A `stroke()` or `fill()` costs on the order of microseconds however little
 * geometry is in it, so what bounds the cost of a scene is the NUMBER of
 * calls. Drawing each object separately made that number the object count:
 * the Jelly block spent hundreds of calls on its spring lattice. Link and
 * vector batches collapse those calls while bodies remain bounded current
 * paths: disjoint body batches can span the full canvas and trigger the same
 * Chromium raster cliff as a batched grid on large high-DPI surfaces.
 *
 * Trails choose between colour batches and bounded per-trail current paths
 * according to scene density and mode.
 *
 * Line widths are keyed in quarter-pixel buckets so visually equivalent
 * vector/link widths share the same path without string keys.
 *
 * What batching changes is z-order WITHIN a pass: all of one style draws
 * before all of the next, rather than in world order. Measured against the
 * unbatched renderer on the same scenes and the same physics state, that
 * comes to 0.1-1.6% of pixels, and every difference falls into one of three
 * groups, none of them a regression:
 *
 *   - Body labels now sit above every disc instead of being painted over by
 *     whichever body was drawn next. This is the largest share and it is a
 *     fix; it is only visible with body labels turned on.
 *   - Where two grid lines round onto the same pixel (far zoomed out), the
 *     major or axis line wins rather than whichever came later in the scan.
 *   - Overlapping strokes of one style composite once instead of twice, so
 *     an antialiased edge crossing another is no longer slightly darkened.
 *
 * Selection rings and hover highlights are batched into the stroke pass,
 * which runs after every fill, so nothing that marks a specific object can
 * be hidden behind a body.
 */
class StyleBatch {
  private entries = new Map<number, { path: Path2D; style: string; width: number }>();

  /** The path collecting geometry drawn in this exact style. */
  path(color: Color, width = 0): Path2D {
    const style = css(color);
    const w = Math.round(width * 4) / 4;
    const rgb = (color[0] << 16) | (color[1] << 8) | color[2];
    const key = rgb * 4096 + Math.max(0, Math.round(w * 4));
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { path: new Path2D(), style, width: w };
      this.entries.set(key, entry);
    }
    return entry.path;
  }

  strokeAll(ctx: CanvasRenderingContext2D): void {
    for (const entry of this.entries.values()) {
      ctx.strokeStyle = entry.style;
      ctx.lineWidth = entry.width;
      ctx.stroke(entry.path);
    }
    this.reset();
  }

  fillAll(ctx: CanvasRenderingContext2D): void {
    for (const entry of this.entries.values()) {
      ctx.fillStyle = entry.style;
      ctx.fill(entry.path);
    }
    this.reset();
  }

  reset(): void {
    this.entries.clear();
  }
}

/** A full circle as its own subpath. The moveTo matters: without it the arc
 * is joined to whatever was drawn before by a straight line, which a fill
 * turns into a visible wedge. */
function addCircle(path: Path2D, cx: number, cy: number, r: number): void {
  path.moveTo(cx + r, cy);
  path.arc(cx, cy, r, 0, 2 * Math.PI);
}

function addLine(path: Path2D, ax: number, ay: number,
                 bx: number, by: number): void {
  path.moveTo(ax, ay);
  path.lineTo(bx, by);
}

// Reused between frames; the paths inside are rebuilt each frame (a Path2D
// cannot be emptied) but the maps and the batch objects are not reallocated.
const FILLS = new StyleBatch();
const STROKES = new StyleBatch();

const STRING_TAUT: Color = [170, 150, 115];
const STRING_SLACK: Color = [140, 125, 100];
const STRING_HOVER: Color = [215, 190, 150];
const BODY_HUB: Color = [230, 233, 240];
const BODY_HUB_EDGE: Color = [90, 95, 105];

function scaledRgb(base: Color, factor: number): string {
  return `rgb(${(base[0] * factor) | 0},${(base[1] * factor) | 0},${(base[2] * factor) | 0})`;
}

// Total gradient strokes to spend across all trails per frame.
//
// A stroke() costs about 8 us however little geometry is in it, so what
// bounds the trail cost is the NUMBER of strokes, not the number of
// points. Every trail of the same colour shares its band styles, so all
// of them are stroked together (see drawTrails): the count is
// colours x bands rather than trails x bands, and 141 trails in two
// colours cost 48 strokes instead of 846. The budget is small because it
// is now a real stroke count rather than an optimistic one.
const TRAIL_STROKE_BUDGET = 120;
const MAX_BANDS = 24;
// Vertex budget shared across all trails on screen, with a generous
// per-trail ceiling: a lone trail can spend a lot (long orbit paths stay
// detailed) while a swarm still can't blow the frame. Both are scaled by
// the adaptive quality factor the app measures (see App.trailQuality).
const TRAIL_VERT_BUDGET = 12000;
const MAX_TRAIL_VERTS = 4000;

/** Turn angle past which a trail vertex is drawn as a CORNER rather than
 * smoothed through.
 *
 * The quadratic smoothing below rounds every vertex off, which is right
 * for a sampled curve and quite wrong at a bounce or a slingshot
 * periapsis, where the real path genuinely has a kink - there the smooth
 * arc visibly cuts the corner and disagrees with where the body actually
 * went. Only near-reversals qualify; a well-sampled curve never turns this
 * hard between adjacent samples. cos(80 degrees). */
const CORNER_COS = 0.1736;
const CORNER_COS2 = CORNER_COS * CORNER_COS;

// Screen-space scratch for the decimated points of one trail. Reused
// across trails and frames: this runs for every visible trail every frame,
// and two arrays of a few thousand numbers is a lot of garbage otherwise.
const SX: number[] = [];
const SY: number[] = [];

/** rgb() string faded from the background toward `base` by fraction f,
 * without allocating an intermediate Color (this runs per band per trail). */
function fadedRgb(base: Color, f: number): string {
  const bg = theme.BG;
  const r = (bg[0] + (base[0] - bg[0]) * f) | 0;
  const g = (bg[1] + (base[1] - bg[1]) * f) | 0;
  const b = (bg[2] + (base[2] - bg[2]) * f) | 0;
  return `rgb(${r},${g},${b})`;
}

/** Draw one decimated trail as a smoothed, colour-banded path.
 *
 * The curve is the standard midpoint quadratic: every retained point is a
 * control point and the path runs through the midpoints between them. Two
 * things make it behave, both of which the previous version got wrong:
 *
 * 1. Colour bands are cut at MIDPOINTS - points that lie exactly on the
 *    curve - so the geometry is identical however many bands there are and
 *    wherever they fall. Cutting at vertices instead made the curve pass
 *    exactly through the boundary vertex while passing through midpoints
 *    everywhere else, so each boundary sat in a slightly different place
 *    than the rest of the line. Worse, bands were cut on RAW indices while
 *    decimation was applied separately, so a band could contain no
 *    retained points at all and drew as a straight chord between two
 *    curved neighbours. Both boundaries move as the ring scrolls, so those
 *    artefacts crawled along the trail every frame - the glitching between
 *    the sharp turns and the smooth curve.
 *
 * 2. Genuine corners are kept. A vertex whose turn exceeds CORNER_COS is
 *    drawn as a corner instead of being rounded off, so a bounce stays a
 *    bounce.
 */
function appendTrail(paths: Path2D[], m: number, bands: number): void {
  if (m < 2) return;
  if (m === 2) {
    // a two-point trail is one edge: put it in the middle band so its
    // shade matches where the fade would have placed it
    const p = paths[bands >> 1];
    p.moveTo(SX[0], SY[0]);
    p.lineTo(SX[1], SY[1]);
    return;
  }
  const edges = m - 1;
  let band = 0;
  let boundary = Math.ceil(edges / bands);
  let path = paths[0];
  path.moveTo(SX[0], SY[0]);
  let curX = SX[0];
  let curY = SY[0];
  for (let i = 1; i <= m - 2; i++) {
    // Turn at this vertex, from the incoming and outgoing directions.
    // Tested on squared lengths: cos(theta) < CORNER_COS is equivalent to
    // dot^2 < CORNER_COS^2 |a|^2 |b|^2 once both sides are non-negative,
    // and a negative dot is past 90 degrees so it is sharp outright. That
    // is the same predicate without two square roots per vertex, and there
    // are tens of thousands of vertices in a frame of a trail-heavy scene.
    const ax = SX[i] - SX[i - 1];
    const ay = SY[i] - SY[i - 1];
    const bx = SX[i + 1] - SX[i];
    const by = SY[i + 1] - SY[i];
    const la2 = ax * ax + ay * ay;
    const lb2 = bx * bx + by * by;
    const dot = ax * bx + ay * by;
    const sharp = la2 > 1e-18 && lb2 > 1e-18 &&
                  (dot < 0.0 || dot * dot < CORNER_COS2 * la2 * lb2);
    if (sharp) {
      path.lineTo(SX[i], SY[i]); // into the corner, and back out next pass
      curX = SX[i];
      curY = SY[i];
    } else {
      const mx = (SX[i] + SX[i + 1]) * 0.5;
      const my = (SY[i] + SY[i + 1]) * 0.5;
      path.quadraticCurveTo(SX[i], SY[i], mx, my);
      curX = mx;
      curY = my;
    }
    if (i >= boundary && band < bands - 1) {
      // split on the curve: the next band resumes from exactly here
      band++;
      boundary = Math.ceil(((band + 1) * edges) / bands);
      path = paths[band];
      path.moveTo(curX, curY);
    }
  }
  path.lineTo(SX[m - 1], SY[m - 1]);
}

/** Append one complete smoothed trail to the current Canvas path.
 *
 * A colour-wide Path2D can contain trails spread over the whole viewport.
 * Chromium then rasterises the path as full-canvas work on high-DPI backing
 * stores. Dense trail scenes use one bounded current path per trail instead;
 * a gradient retains the age fade without multiplying strokes by fade bands.
 */
function appendCurrentTrail(ctx: CanvasRenderingContext2D, m: number): void {
  if (m < 2) return;
  ctx.moveTo(SX[0], SY[0]);
  if (m === 2) {
    ctx.lineTo(SX[1], SY[1]);
    return;
  }
  for (let i = 1; i <= m - 2; i++) {
    const ax = SX[i] - SX[i - 1];
    const ay = SY[i] - SY[i - 1];
    const bx = SX[i + 1] - SX[i];
    const by = SY[i + 1] - SY[i];
    const la2 = ax * ax + ay * ay;
    const lb2 = bx * bx + by * by;
    const dot = ax * bx + ay * by;
    const sharp = la2 > 1e-18 && lb2 > 1e-18 &&
      (dot < 0.0 || dot * dot < CORNER_COS2 * la2 * lb2);
    if (sharp) ctx.lineTo(SX[i], SY[i]);
    else ctx.quadraticCurveTo(
      SX[i], SY[i], (SX[i] + SX[i + 1]) * 0.5, (SY[i] + SY[i + 1]) * 0.5);
  }
  ctx.lineTo(SX[m - 1], SY[m - 1]);
}

function trailGradient(ctx: CanvasRenderingContext2D, base: Color,
                       m: number): string | CanvasGradient {
  const make = ctx.createLinearGradient;
  if (typeof make !== "function" || m < 2) return css(base);
  let x0 = SX[0];
  let y0 = SY[0];
  let x1 = SX[m - 1];
  let y1 = SY[m - 1];
  if (Math.abs(x1 - x0) + Math.abs(y1 - y0) < 1e-6) x1 += 1;
  const gradient = make.call(ctx, x0, y0, x1, y1);
  if (gradient === undefined || typeof gradient.addColorStop !== "function") {
    return css(base);
  }
  gradient.addColorStop(0, fadedRgb(base, 0));
  gradient.addColorStop(0.5, fadedRgb(base, 0.5));
  gradient.addColorStop(1, fadedRgb(base, 1));
  return gradient;
}

/** Visible trails sharing one base colour, and the band paths they build.
 * Reused between frames: the arrays are cleared, never reallocated. */
interface ColourGroup {
  base: Color;
  trails: Trail[];
  paths: Path2D[];
}
const TRAIL_GROUPS = new Map<number, ColourGroup>();
// Per-pass indexes are cleared and reused. Trail drawing can run every frame
// for thousands of bodies; rebuilding these collection objects only creates
// garbage without changing the lookup work or result.
const TRAIL_BODIES = new Map<number, Body>();
const LIVE_TRAIL_COLOURS = new Set<number>();

function drawTrails(ctx: CanvasRenderingContext2D, cam: Camera, world: World,
                    trails: Map<number, Trail>, quality: number,
                    minX: number, minY: number, maxX: number, maxY: number): void {
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  // one id->body index for the whole pass: world.bodyById is a linear scan,
  // so looking a colour up per trail was quadratic in the body count
  const byId = TRAIL_BODIES;
  const liveColours = LIVE_TRAIL_COLOURS;
  byId.clear();
  liveColours.clear();
  for (const b of world.bodies) {
    byId.set(b.id, b);
    liveColours.add((b.color[0] << 16) | (b.color[1] << 8) | b.color[2]);
  }
  // A scene may cycle through thousands of authored colours over time. The
  // reusable group map must not keep one empty entry for every historical
  // colour after bodies are deleted or recoloured.
  for (const key of TRAIL_GROUPS.keys()) {
    if (!liveColours.has(key)) TRAIL_GROUPS.delete(key);
  }

  // Bin the visible trails by colour. Every trail in a bin shares the same
  // band styles, so the whole bin can be stroked band by band - which is
  // what turns the cost from (trails x bands) strokes into
  // (colours x bands). A stroke costs the same whether it carries one
  // trail's geometry or a hundred's.
  for (const g of TRAIL_GROUPS.values()) g.trails.length = 0;
  let visible = 0;
  for (const [bid, trail] of trails) {
    if (trail.count < 2) continue;
    // cull trails whose bounding box lies entirely outside the viewport
    if (trail.maxX < minX || trail.minX > maxX ||
        trail.maxY < minY || trail.minY > maxY) continue;
    const body = byId.get(bid);
    if (body === undefined) continue; // stale trail is not part of this world
    const base: Color = body.color;
    const key = (base[0] << 16) | (base[1] << 8) | base[2];
    let group = TRAIL_GROUPS.get(key);
    if (group === undefined) {
      group = { base, trails: [], paths: [] };
      TRAIL_GROUPS.set(key, group);
    }
    group.base = base;
    group.trails.push(trail);
    visible++;
  }
  if (visible === 0) {
    byId.clear();
    liveColours.clear();
    ctx.lineJoin = "miter";
    return;
  }
  let groups = 0;
  for (const g of TRAIL_GROUPS.values()) if (g.trails.length > 0) groups++;

  const bands = Math.max(1, Math.min(MAX_BANDS,
    Math.floor(TRAIL_STROKE_BUDGET / groups)));
  // spare frame time buys detail: see App.trailQuality for why measuring
  // frame time is legitimate here when it is not for the physics step
  const vertsPerTrail = Math.max(64, Math.min(
    Math.floor(MAX_TRAIL_VERTS * quality),
    Math.floor((TRAIL_VERT_BUDGET * quality) / visible)));
  const cx = cam.centre.x;
  const cy = cam.centre.y;
  const zoom = cam.zoom;
  const ox = cam.screenW * 0.5;
  const oy = cam.screenH * 0.5;

  // A style-wide explicit Path2D is excellent for a handful of nearby trails,
  // but pathological when many disjoint trails make its bounds cover the
  // viewport. Dense Normal-mode scenes switch to bounded current paths once
  // the disjoint-path cliff is more expensive than the extra stroke calls.
  const bounded = visible >= 48;
  if (bounded) {
    for (const group of TRAIL_GROUPS.values()) {
      if (group.trails.length === 0) continue;
      for (const trail of group.trails) {
        const want = Math.max(1, trail.count / vertsPerTrail);
        let stride = 1;
        while (stride < want) stride *= 2;
        const m = trail.sampleScreen(stride, SX, SY, cx, cy, zoom, ox, oy);
        if (m < 2) continue;
        ctx.strokeStyle = trailGradient(ctx, group.base, m);
        ctx.beginPath();
        appendCurrentTrail(ctx, m);
        ctx.stroke();
      }
    }
    byId.clear();
    liveColours.clear();
    ctx.lineJoin = "miter";
    return;
  }

  for (const group of TRAIL_GROUPS.values()) {
    if (group.trails.length === 0) continue;
    const paths = group.paths;
    paths.length = 0;
    for (let b = 0; b < bands; b++) paths.push(new Path2D());
    for (const trail of group.trails) {
      // Decimate on the point's SERIAL, not its index in the ring. Serials
      // are fixed for the life of a point, so the same physical points
      // stay selected as the trail scrolls; keying on the index re-picks a
      // different subset every frame, which makes the drawn path shimmer
      // and warp in place (very visible on long, fast, chaotic orbits).
      //
      // The stride is rounded UP to a power of two so the retained set is
      // nested: when the trail grows past a threshold, or the adaptive
      // budget moves, the stride doubles or halves and the kept points are
      // a subset or superset of what they were. An arbitrary stride
      // reshuffles the whole selection instead, which reads as the line
      // twitching.
      const want = Math.max(1, trail.count / vertsPerTrail);
      let stride = 1;
      while (stride < want) stride *= 2;
      appendTrail(paths,
                  trail.sampleScreen(stride, SX, SY, cx, cy, zoom, ox, oy),
                  bands);
    }
    const base = group.base;
    const last = bands > 1 ? bands - 1 : 1;
    for (let b = 0; b < bands; b++) {
      ctx.strokeStyle = fadedRgb(base, b / last);
      ctx.stroke(paths[b]);
    }
    paths.length = 0; // release the frame's paths, keep the group
  }
  byId.clear();
  liveColours.clear();
  ctx.lineJoin = "miter";
}

// `drawWorld` is a single synchronous pass. Reusing its membership and label
// scratch avoids one Set, one array, and one tuple per visible label per
// rendered frame while retaining exactly the same ordering and lookups.
const PICKED = new Set<Selectable>();
const LABEL_NAMES: string[] = [];
const LABEL_X: number[] = [];
const LABEL_Y: number[] = [];

/** `simplify` drops the decorative geometry that costs the most to build:
 * spring coils become plain lines (a coil is up to twenty segments), spin
 * markers are skipped, and trails are unavailable. Performance mode passes
 * it. Core scene contents - position, size, colour, selection, links and walls
 * - remain visible. */
export function drawWorld(ctx: CanvasRenderingContext2D, cam: Camera,
                          world: World, view: ViewSettings,
                          selection: Selectable[], hover: Selectable | null,
                          trails: Map<number, Trail>,
                          areaW: number, areaH: number,
                          trailQuality = 1.0, simplify = false,
                          aggressive = false): void {
  const halfW = (cam.screenW * 0.5) / cam.zoom;
  const halfH = (cam.screenH * 0.5) / cam.zoom;
  const minX = cam.centre.x - halfW;
  const maxX = cam.centre.x + halfW;
  const minY = cam.centre.y - halfH;
  const maxY = cam.centre.y + halfH;
  // Draw culling is unconditional: skipping what is outside the viewport
  // can never change what the user sees, so there is nothing to trade.
  // (The "remove runaway objects" setting is a separate, physical thing:
  // it deletes bodies that have escaped for good - see App.cullEscaped.)
  const margin = 12.0 / cam.zoom;
  // `selection` is a plain array and every link, wall and body below asks
  // whether it is in there. As an array scan that is bodies x selection per
  // frame, which a box-select over a large scene turns quadratic; hashing
  // it once makes each test constant time.
  const picked = PICKED;
  picked.clear();
  for (const item of selection) picked.add(item);

  // --- trails ---------------------------------------------------------------
  if (view.trails && !simplify) {
    drawTrails(ctx, cam, world, trails, trailQuality,
               minX, minY, maxX, maxY);
  }

  const zoom = cam.zoom;
  const cx = cam.centre.x;
  const cy = cam.centre.y;
  const ox = cam.screenW * 0.5;
  const oy = cam.screenH * 0.5;
  // A dense soft-body lattice can contain hundreds of short springs. Letting
  // every one grow from two to ten decorative zigzags as the camera zooms in
  // multiplied paused redraw work even though the physical scene was frozen.
  // Two coils preserve the spring language and are already what these meshes
  // show at their authored framing; only the zoom-driven excess is removed.
  let denseSoftSprings = 0;
  if (world.links.length >= 96) {
    for (const link of world.links) {
      if (link instanceof SpringLink && !link.tensionOnly &&
          link.a.softBody && link.b.softBody && ++denseSoftSprings >= 96) break;
    }
  }
  const denseSoftMesh = denseSoftSprings >= 96;

  // --- links -----------------------------------------------------------------
  for (const link of world.links) {
    const ax = link.a.pos.x, ay = link.a.pos.y;
    const bx = link.b.pos.x, by = link.b.pos.y;
    if (Math.max(ax, bx) < minX - margin || Math.min(ax, bx) > maxX + margin ||
        Math.max(ay, by) < minY - margin || Math.min(ay, by) > maxY + margin) {
      continue;
    }
    const pax = (ax - cx) * zoom + ox;
    const pay = (cy - ay) * zoom + oy;
    const pbx = (bx - cx) * zoom + ox;
    const pby = (cy - by) * zoom + oy;
    const selected = picked.has(link);
    const hovered = link === hover;
    if (link instanceof SpringLink) {
      if (link.tensionOnly) {
        // elastic string: a plain line, thinner while slack
        // Squared comparison avoids one square root per visible elastic
        // string on every rendered frame; restLength is non-negative.
        const dx = ax - bx, dy = ay - by;
        const slack = dx * dx + dy * dy < link.restLength * link.restLength;
        const color = selected ? theme.SELECTION
          : hovered ? STRING_HOVER : slack ? STRING_SLACK : STRING_TAUT;
        addLine(STROKES.path(color, slack ? 1 : 2), pax, pay, pbx, pby);
      } else {
        const color: Color = selected ? theme.SELECTION
          : hovered ? [200, 205, 215] : [135, 142, 152];
        if (simplify) addLine(STROKES.path(color, 2), pax, pay, pbx, pby);
        else addSpringCoil(STROKES, pax, pay, pbx, pby, color,
                           link.restLength * cam.zoom,
                           denseSoftMesh && link.a.softBody && link.b.softBody
                             ? 2 : 10);
      }
    } else if (link.isRope) {
      // inelastic string: rigid in tension, free when slack
      const dx = ax - bx, dy = ay - by;
      const slackLimit = link.length - 1e-9;
      const slack = slackLimit > 0 &&
        dx * dx + dy * dy < slackLimit * slackLimit;
      const color = selected ? theme.SELECTION
        : hovered ? STRING_HOVER : slack ? STRING_SLACK : STRING_TAUT;
      addLine(STROKES.path(color, slack ? 1 : 2), pax, pay, pbx, pby);
    } else {
      const color: Color = selected ? theme.SELECTION
        : hovered ? [200, 205, 215] : [150, 156, 166];
      addLine(STROKES.path(color, 3), pax, pay, pbx, pby);
    }
  }
  // every link of a given style in one stroke, whatever the scene's size
  STROKES.strokeAll(ctx);

  // --- walls -------------------------------------------------------------------
  for (const wall of world.walls) {
    const m = margin + wall.thickness / 2;
    if (Math.max(wall.a.x, wall.b.x) < minX - m ||
        Math.min(wall.a.x, wall.b.x) > maxX + m ||
        Math.max(wall.a.y, wall.b.y) < minY - m ||
        Math.min(wall.a.y, wall.b.y) > maxY + m) {
      continue;
    }
    const pax = (wall.a.x - cx) * zoom + ox;
    const pay = (cy - wall.a.y) * zoom + oy;
    const pbx = (wall.b.x - cx) * zoom + ox;
    const pby = (cy - wall.b.y) * zoom + oy;
    const wPx = Math.max(2, Math.floor(wall.thickness * cam.zoom));
    const selected = picked.has(wall);
    const color = selected ? theme.SELECTION
      : wall === hover ? lighten(wall.color, 30) : wall.color;
    ctx.lineCap = "round"; // capsule: round end caps replace the endpoint discs
    lineXY(ctx, pax, pay, pbx, pby, color, wPx);
    ctx.lineCap = "butt";
    if (selected) { // endpoint handles for direct manipulation
      fillCircle(ctx, pax, pay, 5, [255, 255, 255]);
      ringCircle(ctx, pax, pay, 5, 2, theme.ACCENT);
      fillCircle(ctx, pbx, pby, 5, [255, 255, 255]);
      ringCircle(ctx, pbx, pby, 5, 2, theme.ACCENT);
    }
  }

  // --- bodies ---------------------------------------------------------------------
  // Discs, edges, spin markers and hubs all batch by style; labels are text
  // and have to wait until the fills beneath them are down, so they are
  // collected and drawn after the flush.
  LABEL_NAMES.length = 0;
  LABEL_X.length = 0;
  LABEL_Y.length = 0;
  for (const body of world.bodies) {
    const r = body.radius;
    if (body.pos.x + r < minX || body.pos.x - r > maxX ||
        body.pos.y + r < minY || body.pos.y - r > maxY) {
      continue;
    }
    const sx = (body.pos.x - cx) * zoom + ox;
    const sy = (cy - body.pos.y) * zoom + oy;
    const pr = Math.max(2, body.radius * cam.zoom);
    let color = body.color;
    if (body === hover && !picked.has(body)) color = lighten(color, 35);
    const edgeStyle = scaledRgb(color, 0.55);
    // Keep each body's path spatially bounded, but combine its disc edge and
    // optional spin marker into one stroke. This avoids both Chromium's
    // disjoint-Path2D cliff and a redundant call per rotating body.
    ctx.beginPath();
    ctx.arc(sx, sy, pr, 0, 2 * Math.PI);
    ctx.fillStyle = css(color);
    ctx.fill();
    if (pr >= 5 && !body.locked && !simplify) {
      // rotation marker so spin/rolling is visible
      const ex = sx + Math.cos(body.angle) * pr * 0.85;
      const ey = sy - Math.sin(body.angle) * pr * 0.85;
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
    }
    ctx.strokeStyle = edgeStyle;
    ctx.lineWidth = Math.max(1, pr / 9);
    ctx.stroke();
    if (body.locked) {
      const hub = Math.max(2, pr / 3);
      fillCircle(ctx, sx, sy, hub, BODY_HUB);
      ringCircle(ctx, sx, sy, hub, 1, BODY_HUB_EDGE);
    }
    if (picked.has(body)) {
      ringCircle(ctx, sx, sy, pr + 3, 2, theme.SELECTION);
    }
    if (view.labels && pr >= 3 &&
        (!aggressive || picked.has(body) || body === hover)) {
      LABEL_NAMES.push(body.name);
      LABEL_X.push(sx);
      LABEL_Y.push(sy - pr - 6);
    }
  }
  if (LABEL_NAMES.length > 0) {
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = css(theme.TEXT_DIM);
    for (let i = 0; i < LABEL_NAMES.length; i++) {
      ctx.fillText(LABEL_NAMES[i], LABEL_X[i], LABEL_Y[i]);
    }
    ctx.textAlign = "left";
  }

  // --- vectors ------------------------------------------------------------------------
  const vScale = view.vectorScale;
  if (view.velVectors || view.accVectors || view.forceVectors) {
    for (const body of world.bodies) {
      if (body.invMass === 0.0) continue;
      if (aggressive && !picked.has(body) && body !== hover) continue;
      const sx = (body.pos.x - cx) * zoom + ox;
      const sy = (cy - body.pos.y) * zoom + oy;
      if (sx < 0 || sx > areaW || sy < 0 || sy > areaH) continue;
      if (view.velVectors) {
        const ex = (body.pos.x + body.vel.x * VEL_ARROW_SCALE * vScale - cx) * zoom + ox;
        const ey = (cy - body.pos.y - body.vel.y * VEL_ARROW_SCALE * vScale) * zoom + oy;
        addArrowXY(STROKES, FILLS, sx, sy, ex, ey, theme.VEL_COLOR);
      }
      if (view.accVectors) {
        const ex = (body.pos.x + body.acc.x * ACC_ARROW_SCALE * vScale - cx) * zoom + ox;
        const ey = (cy - body.pos.y - body.acc.y * ACC_ARROW_SCALE * vScale) * zoom + oy;
        addArrowXY(STROKES, FILLS, sx, sy, ex, ey, theme.ACC_COLOR);
      }
      if (view.forceVectors) {
        const fx = body.acc.x * body.mass;
        const fy = body.acc.y * body.mass;
        const ex = (body.pos.x + fx * FORCE_ARROW_SCALE * vScale - cx) * zoom + ox;
        const ey = (cy - body.pos.y - fy * FORCE_ARROW_SCALE * vScale) * zoom + oy;
        addArrowXY(STROKES, FILLS, sx, sy, ex, ey, theme.FORCE_COLOR);
      }
    }
    STROKES.strokeAll(ctx); // shafts: one stroke per arrow kind
    FILLS.fillAll(ctx);     // heads: one fill per arrow kind
  }

  // --- contact normals ------------------------------------------------------------------
  if (view.contacts && !aggressive) {
    for (const c of world.contacts) {
      const px = (c.px - cx) * zoom + ox;
      const py = (cy - c.py) * zoom + oy;
      const qx = (c.px + c.nx * 0.25 - cx) * zoom + ox;
      const qy = (cy - c.py - c.ny * 0.25) * zoom + oy;
      addArrowXY(STROKES, FILLS, px, py, qx, qy, theme.WARN, 1);
      addCircle(FILLS.path(theme.WARN), px, py, 2);
    }
    STROKES.strokeAll(ctx);
    FILLS.fillAll(ctx);
  }

  // --- centre of mass ----------------------------------------------------------------------
  if (view.com) {
    const com = world.centreOfMass();
    if (com !== null) {
      const [sx, sy] = cam.toScreen(com);
      ringCircle(ctx, sx, sy, 7, 1, [255, 255, 255]);
      lineXY(ctx, sx - 9, sy, sx + 9, sy, [255, 255, 255], 1);
      lineXY(ctx, sx, sy - 9, sx, sy + 9, [255, 255, 255], 1);
      ctx.fillStyle = css(theme.TEXT_DIM);
      ctx.fillText("COM", sx + 10, sy + 14);
    }
  }

  // --- spatial hash debug grid -------------------------------------------------------------------
  if (view.spatialGrid && !aggressive && world.bodies.length > 0) {
    let maxR = 0.0;
    for (const b of world.bodies) if (b.radius > maxR) maxR = b.radius;
    const cell = Math.max(4.0 * maxR, 0.05);
    const i0 = Math.floor(minX / cell);
    const i1 = Math.floor(maxX / cell) + 1;
    const j0 = Math.floor(minY / cell);
    const j1 = Math.floor(maxY / cell) + 1;
    if (i1 - i0 + (j1 - j0) < 200) {
      // Like the ordinary grid, keep every full-height/full-width line in a
      // narrow current path. One explicit Path2D containing all of these
      // disjoint lines acquires viewport-sized bounds and is unusually
      // expensive for Chromium/Edge to raster on a high-DPI canvas.
      ctx.strokeStyle = css([70, 45, 45]);
      ctx.lineWidth = 1;
      for (let i = i0; i <= i1; i++) {
        const sx = (i * cell - cx) * zoom + ox;
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, areaH);
        ctx.stroke();
      }
      for (let j = j0; j <= j1; j++) {
        const sy = (cy - j * cell) * zoom + oy;
        ctx.beginPath();
        ctx.moveTo(0, sy);
        ctx.lineTo(areaW, sy);
        ctx.stroke();
      }
    }
  }
  picked.clear();
  LABEL_NAMES.length = 0;
  LABEL_X.length = 0;
  LABEL_Y.length = 0;
}

/** Draggable arrow-tip handle used to set a body's velocity directly.
 *
 * The hit test lives in the interaction layer (see pressSelect), which
 * derives the tip from the same arrow scale rather than from a rectangle
 * returned here - so this only draws.
 */
export function drawVelocityHandle(ctx: CanvasRenderingContext2D, cam: Camera,
                                   body: Body, view: ViewSettings): void {
  const s = VEL_ARROW_SCALE * view.vectorScale;
  const startX = (body.pos.x - cam.centre.x) * cam.zoom + cam.screenW * 0.5;
  const startY = (cam.centre.y - body.pos.y) * cam.zoom + cam.screenH * 0.5;
  const tipX = (body.pos.x + body.vel.x * s - cam.centre.x) * cam.zoom +
    cam.screenW * 0.5;
  const tipY = (cam.centre.y - body.pos.y - body.vel.y * s) * cam.zoom +
    cam.screenH * 0.5;
  addArrowXY(STROKES, FILLS, startX, startY, tipX, tipY, theme.VEL_COLOR, 2);
  STROKES.strokeAll(ctx);
  FILLS.fillAll(ctx);
  ctx.beginPath();
  ctx.roundRect(tipX - 6, tipY - 6, 12, 12, 3);
  ctx.fillStyle = css(theme.VEL_COLOR);
  ctx.fill();
  ctx.strokeStyle = css([20, 40, 20]);
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function drawScaleBar(ctx: CanvasRenderingContext2D, cam: Camera,
                             areaW: number, areaH: number): void {
  const [length, label] = cam.niceScaleLength();
  const px = length * cam.zoom;
  const x1 = areaW - 24;
  const x0 = x1 - px;
  const y = areaH - 20;
  const c = theme.TEXT_DIM;
  lineXY(ctx, x0, y, x1, y, c, 2);
  lineXY(ctx, x0, y - 4, x0, y + 4, c, 2);
  lineXY(ctx, x1, y - 4, x1, y + 4, c, 2);
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = css(c);
  ctx.fillText(label, (x0 + x1) / 2, y - 8);
  ctx.textAlign = "left";
}

/** Shortest distance from a point to the segment a-b.
 *
 * The one hit-test primitive, used by the interaction layer to pick links
 * and walls. There were two copies of this - one here, one private to
 * tools.ts - and the interaction layer used the private one, so the
 * "shared" label on this one had been false for a while. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const len2 = sx * sx + sy * sy;
  let t = 0.0;
  if (len2 > 0) {
    t = ((p.x - a.x) * sx + (p.y - a.y) * sy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const dx = p.x - (a.x + sx * t);
  const dy = p.y - (a.y + sy * t);
  return Math.sqrt(dx * dx + dy * dy);
}
