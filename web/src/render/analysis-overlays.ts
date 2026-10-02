/** Screen-space scientific annotations, independent of physical state. */
import type { Color } from "../engine/body";
import * as theme from "../ui/theme";

export interface AnalysisLabel {
  text: string; x: number; y: number; color: Color; right: boolean;
}
export interface AnalysisVector {
  x1: number; y1: number; x2: number; y2: number;
}
interface Box { x: number; y: number; width: number; height: number; }

/** Keep small nonzero components and large values legible without long decimals. */
export function analysisNumber(value: number): string {
  const magnitude = Math.abs(value);
  return magnitude !== 0 && (magnitude < 0.005 || magnitude >= 10000)
    ? value.toExponential(2) : value.toFixed(2);
}

/** Segment/rectangle clipping also protects diagonal shafts and arrowheads. */
function crosses(vector: AnalysisVector, box: Box, padding: number): boolean {
  let lo = 0, hi = 1;
  const dx = vector.x2 - vector.x1, dy = vector.y2 - vector.y1;
  const left = box.x - padding, right = box.x + box.width + padding;
  const top = box.y - padding, bottom = box.y + box.height + padding;
  if (Math.abs(dx) < 1e-12) {
    if (vector.x1 < left || vector.x1 > right) return false;
  } else {
    const a = (left - vector.x1) / dx, b = (right - vector.x1) / dx;
    lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
    if (lo > hi) return false;
  }
  if (Math.abs(dy) < 1e-12) {
    if (vector.y1 < top || vector.y1 > bottom) return false;
  } else {
    const a = (top - vector.y1) / dy, b = (bottom - vector.y1) / dy;
    lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
    if (lo > hi) return false;
  }
  return true;
}

// Compute wider search directions once, rather than rebuilding trigonometric
// offsets for every label. Ordinary preferred placements stop before using them.
const SEARCH_DIRECTIONS = Array.from({ length: 64 }, (_, i) => {
  const ring = 1 + Math.floor(i / 16), angle = (i % 16) * Math.PI / 8;
  return { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring };
});

function placeBox(x: number, y: number, width: number, height: number,
                  areaW: number, areaH: number, occupied: Box[],
                  vectors: AnalysisVector[], scale: number): Box {
  const inset = 6;
  const clamp = (px: number, py: number): Box => ({
    x: Math.max(inset, Math.min(areaW - width - inset, px)),
    y: Math.max(inset, Math.min(areaH - height - inset, py)), width, height,
  });
  const preferred = clamp(x, y);
  let best = preferred, bestScore = Infinity;
  // Search nearby positions first, then progressively wider rings. Both
  // candidate count and obstacle work stay bounded in dense opt-in diagrams.
  for (let i = 0; i < 5 + SEARCH_DIRECTIONS.length; i++) {
    let dx = 0, dy = 0;
    if (i === 1) dy = height + 8;
    else if (i === 2) dy = -height - 8;
    else if (i === 3) dx = -width - 12;
    else if (i === 4) dx = width + 12;
    else if (i >= 5) {
      dx = SEARCH_DIRECTIONS[i - 5].x * (width + 12);
      dy = SEARCH_DIRECTIONS[i - 5].y * (height + 12);
    }
    const candidate = clamp(x + dx, y + dy);
    let penalty = 0;
    for (let i = Math.max(0, occupied.length - 128); i < occupied.length; i++) {
      const other = occupied[i];
      if (candidate.x < other.x + other.width + 4 && candidate.x + width + 4 > other.x &&
          candidate.y < other.y + other.height + 4 && candidate.y + height + 4 > other.y) penalty += 10;
    }
    for (let i = Math.max(0, vectors.length - 128); i < vectors.length; i++) {
      const vector = vectors[i];
      if (crosses(vector, candidate, 7 * scale)) penalty += 20;
      if (vector.x2 >= candidate.x - 7 * scale && vector.x2 <= candidate.x + width + 7 * scale &&
          vector.y2 >= candidate.y - 7 * scale && vector.y2 <= candidate.y + height + 7 * scale) penalty += 40;
    }
    if (penalty === 0) { occupied.push(candidate); return candidate; }
    const score = penalty + Math.hypot(candidate.x - preferred.x, candidate.y - preferred.y) * 0.001;
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  // Finite screen space may prevent full separation. Prefer the least
  // obstructive candidate; the source disclosure retains all exact values.
  occupied.push(best);
  return best;
}

function surface(ctx: CanvasRenderingContext2D, box: Box): void {
  ctx.fillStyle = theme.css(theme.PANEL);
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeStyle = theme.css(theme.OUTLINE);
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1);
}

export function drawAnalysisOverlays(ctx: CanvasRenderingContext2D,
    labels: AnalysisLabel[], vectors: AnalysisVector[], areaW: number, areaH: number,
    textScale = 1): void {
  if (labels.length === 0 || areaW < 24 || areaH < 24) return;
  const scale = Number.isFinite(textScale) ? Math.max(0.9, Math.min(2, textScale)) : 1;
  const occupied: Box[] = [];
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `600 ${12 * scale}px system-ui, sans-serif`;
  for (const label of labels) {
    const width = Math.min(areaW - 12, ctx.measureText(label.text).width + 18 * scale);
    const height = 24 * scale;
    const preferredX = label.right ? label.x + 7 : label.x - width - 7;
    const box = placeBox(preferredX, label.y - height - 6, width, height, areaW, areaH, occupied, vectors, scale);
    const anchorX = Math.max(0, Math.min(areaW, label.x));
    const anchorY = Math.max(0, Math.min(areaH, label.y));
    const edgeX = Math.max(box.x, Math.min(box.x + width, anchorX));
    const edgeY = Math.max(box.y, Math.min(box.y + height, anchorY));
    if (Math.hypot(anchorX - edgeX, anchorY - edgeY) > 3) {
      ctx.strokeStyle = theme.css(label.color);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(anchorX, anchorY);
      ctx.lineTo(edgeX, edgeY);
      ctx.stroke();
    }
    surface(ctx, box);
    ctx.fillStyle = theme.css(label.color);
    ctx.fillRect(box.x + 4 * scale, box.y + 5 * scale, 2 * scale, height - 10 * scale);
    ctx.fillStyle = theme.css(theme.TEXT);
    ctx.fillText(label.text, box.x + 10 * scale, box.y + 16 * scale);
  }
  ctx.restore();
}
