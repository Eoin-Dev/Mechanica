/** Screen-space scientific annotations, independent of physical state. */
import type { Color } from "../engine/body";
import type { ForceKind } from "../engine/force-diagnostics";
import * as theme from "../ui/theme";

export interface AnalysisLabel {
  /** Stable physical source identity; values and placement can change. */
  id?: string;
  text: string; x: number; y: number; color: Color; right: boolean;
  source?: string;
  owner?: AnalysisOwner;
}
export interface AnalysisOwner {
  tag: string; x: number; y: number; radius: number; color: Color;
}
export interface AnalysisVector {
  x1: number; y1: number; x2: number; y2: number;
}
export interface AnalysisBox { x: number; y: number; width: number; height: number; }
type Box = AnalysisBox;
interface OwnerPlacement { x: number; y: number; box: Box; }
interface OverlayLayout {
  width: number; height: number; scale: number; inputs: Float64Array;
  labelCount: number; vectorCount: number; reservedCount: number; widths: Float64Array; boxes: Box[];
  keys: string[];
  ownerBoxes?: Map<string, OwnerPlacement>;
  ownerMarkers?: boolean;
}
// One owned layout per canvas, released with that context. Reuse never relies
// on physics clocks: pointer moves and UI repaints can share identical geometry.
const LAYOUTS = new WeakMap<CanvasRenderingContext2D, OverlayLayout>();
const NO_RESERVED: readonly AnalysisBox[] = [];

const DARK_FORCES: Record<string, Color> = {
  weight: [255, 116, 165], reaction: [80, 225, 245], friction: [232, 181, 255],
  link: [255, 221, 110], applied: [180, 195, 255], drag: [255, 180, 90],
};
const LIGHT_FORCES: Record<string, Color> = {
  weight: [175, 35, 80], reaction: [0, 95, 165], friction: [115, 45, 165],
  link: [140, 90, 0], applied: [65, 70, 165], drag: [155, 65, 0],
};

/** Scientific arrows use a fixed palette independent of body/custom colours.
 * The renderer surrounds it with an opaque contrasting contour. */
export function analysisForceColour(kind: ForceKind): Color {
  if (kind === "correction") return theme.TEXT_DIM;
  if (kind === "gravity") kind = "weight";
  const palette = theme.themeName === "light" ? LIGHT_FORCES : DARK_FORCES;
  return palette[kind] ?? palette[
    kind === "string" || kind === "spring" || kind === "pulley" || kind === "rod"
      ? "link" : "applied"];
}

/** Keep small nonzero components and large values legible without long decimals. */
export function analysisNumber(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "0.00";
  if (magnitude >= 0.005 && magnitude < 10000) return value.toFixed(2);
  const [mantissa, exponent] = value.toExponential(2).split("e");
  if (exponent === undefined) return mantissa;
  const superscripts = "⁰¹²³⁴⁵⁶⁷⁸⁹";
  const power = String(Number(exponent)).replace(/[-\d]/g,
    digit => digit === "-" ? "⁻" : superscripts[Number(digit)]);
  return `${mantissa} × 10${power}`;
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
                  vectors: AnalysisVector[], scale: number, reserved: readonly Box[], previous?: Box): Box {
  const inset = 6;
  const clamp = (px: number, py: number): Box => ({
    x: Math.max(inset, Math.min(areaW - width - inset, px)),
    y: Math.max(inset, Math.min(areaH - height - inset, py)), width, height,
  });
  const preferred = clamp(x, y);
  // Keep a source's previous placement while it remains unobstructed. New
  // placements reserve a seven-pixel vector gap; retained placements have a
  // two-pixel gap, preventing repeated flips at the padded boundary.
  if (previous !== undefined) {
    const retained = clamp(previous.x, previous.y);
    const overlaps = (other: Box): boolean => retained.x < other.x + other.width + 4 &&
      retained.x + width + 4 > other.x && retained.y < other.y + other.height + 4 &&
      retained.y + height + 4 > other.y;
    if (!reserved.some(overlaps) && !occupied.slice(-128).some(overlaps) &&
        !vectors.slice(-128).some(vector => crosses(vector, retained, 2 * scale))) {
      occupied.push(retained); return retained;
    }
  }
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
    // HUD surfaces have priority over optional scientific captions, even
    // when the moving scene exhausts its bounded label-placement window.
    for (const other of reserved) {
      if (candidate.x < other.x + other.width + 4 && candidate.x + width + 4 > other.x &&
          candidate.y < other.y + other.height + 4 && candidate.y + height + 4 > other.y) penalty += 1000;
    }
    for (let i = Math.max(0, occupied.length - 128); i < occupied.length; i++) {
      const other = occupied[i];
      if (candidate.x < other.x + other.width + 4 && candidate.x + width + 4 > other.x &&
          candidate.y < other.y + other.height + 4 && candidate.y + height + 4 > other.y) penalty += 10;
    }
    for (let i = Math.max(0, vectors.length - 128); i < vectors.length; i++) {
      const vector = vectors[i];
      const pad = 7 * scale, left = candidate.x - pad, right = candidate.x + width + pad;
      const top = candidate.y - pad, bottom = candidate.y + height + pad;
      // Exact broad-phase rejection avoids segment clipping for remote arrows.
      if ((vector.x1 < left && vector.x2 < left) || (vector.x1 > right && vector.x2 > right) ||
          (vector.y1 < top && vector.y2 < top) || (vector.y1 > bottom && vector.y2 > bottom)) continue;
      if (crosses(vector, candidate, pad)) penalty += 20;
      if (vector.x2 >= left && vector.x2 <= right && vector.y2 >= top && vector.y2 <= bottom) penalty += 40;
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
    textScale = 1, pointer: readonly [number, number] | null = null,
    reserved: readonly AnalysisBox[] = NO_RESERVED,
    paintVectors?: () => void): void {
  if (labels.length === 0 || areaW < 24 || areaH < 24) { paintVectors?.(); return; }
  const scale = Number.isFinite(textScale) ? Math.max(0.8, Math.min(2, textScale)) : 1;
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `600 ${12 * scale}px system-ui, sans-serif`;
  const ownerMarkers = labels.some(label => label.owner !== undefined);
  let cached = LAYOUTS.get(ctx);
  const previous = cached;
  const length = (labels.length + vectors.length + reserved.length) * 4;
  if (cached === undefined || cached.inputs.length !== length || cached.labelCount !== labels.length) {
    cached = { width: 0, height: 0, scale: 0, inputs: new Float64Array(length),
      labelCount: labels.length, vectorCount: vectors.length, reservedCount: reserved.length, widths: new Float64Array(labels.length), boxes: [], keys: [] };
  }
  let reusable = cached.width === areaW && cached.height === areaH && cached.scale === scale &&
    cached.ownerMarkers === ownerMarkers &&
    cached.vectorCount === vectors.length && cached.reservedCount === reserved.length &&
    cached.boxes.length === labels.length;
  // Measure in the current canvas font even on a cache hit: font loading and
  // browser text metrics can change without an application preference edit.
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i], required = Math.min(areaW - 12, ctx.measureText(label.text).width + 18 * scale +
      (label.owner ? Math.max(18 * scale, ctx.measureText(label.owner.tag).width + 8 * scale) + 6 * scale : 0)), j = i * 4;
    const key = label.id ?? label.source ?? `label-${i}`;
    if (cached.keys[i] !== key) reusable = false;
    const previousIndex = label.id === undefined ? -1 : previous?.keys.indexOf(key) ?? -1;
    const oldWidth = previousIndex >= 0 && previous!.scale === scale && previous!.ownerMarkers === ownerMarkers
      ? previous!.inputs[previousIndex * 4 + 2] : 0;
    const width = Math.min(areaW - 12, Math.ceil(Math.max(required,
      oldWidth < required * 1.6 ? oldWidth : 0) / (8 * scale)) * 8 * scale);
    cached.widths[i] = width;
    if (cached.inputs[j] !== label.x || cached.inputs[j + 1] !== label.y ||
        cached.inputs[j + 2] !== width || cached.inputs[j + 3] !== Number(label.right)) reusable = false;
  }
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i], j = (labels.length + i) * 4;
    if (cached.inputs[j] !== v.x1 || cached.inputs[j + 1] !== v.y1 ||
        cached.inputs[j + 2] !== v.x2 || cached.inputs[j + 3] !== v.y2) reusable = false;
  }
  for (let i = 0; i < reserved.length; i++) {
    const box = reserved[i], j = (labels.length + vectors.length + i) * 4;
    if (cached.inputs[j] !== box.x || cached.inputs[j + 1] !== box.y ||
        cached.inputs[j + 2] !== box.width || cached.inputs[j + 3] !== box.height) reusable = false;
  }
  const occupied: Box[] = reusable ? cached.boxes : [];
  let hot = -1, closest = 49;
  if (pointer !== null) for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i], dx = v.x2 - v.x1, dy = v.y2 - v.y1;
    const length2 = dx * dx + dy * dy;
    const along = length2 > 0 ? Math.max(0, Math.min(1,
      ((pointer[0] - v.x1) * dx + (pointer[1] - v.y1) * dy) / length2)) : 0;
    const distance2 = (pointer[0] - v.x1 - along * dx) ** 2 +
      (pointer[1] - v.y1 - along * dy) ** 2;
    if (distance2 < closest) { hot = i; closest = distance2; }
  }
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const width = cached.widths[i];
    const height = 24 * scale;
    const preferredX = label.right ? label.x + 7 : label.x - width - 7;
    const key = label.id ?? label.source ?? `label-${i}`;
    const priorIndex = label.id === undefined ? -1 : previous?.keys.indexOf(key) ?? -1;
    const priorBox = priorIndex < 0 ? undefined : previous?.boxes[priorIndex];
    const prior = priorBox !== undefined && previous!.width === areaW && previous!.height === areaH && previous!.scale === scale
      ? { x: priorBox.x + label.x - previous!.inputs[priorIndex * 4],
          y: priorBox.y + label.y - previous!.inputs[priorIndex * 4 + 1], width, height } : undefined;
    const box = reusable ? occupied[i] :
      placeBox(preferredX, label.y - height - 6, width, height, areaW, areaH, occupied, vectors, scale, reserved, prior);
    if (pointer !== null && pointer[0] >= box.x && pointer[0] <= box.x + width &&
        pointer[1] >= box.y && pointer[1] <= box.y + height) hot = i;
    const anchorX = Math.max(0, Math.min(areaW, label.x));
    const anchorY = Math.max(0, Math.min(areaH, label.y));
    const edgeX = Math.max(box.x, Math.min(box.x + width, anchorX));
    const edgeY = Math.max(box.y, Math.min(box.y + height, anchorY));
    if (Math.hypot(anchorX - edgeX, anchorY - edgeY) > 3) {
      ctx.strokeStyle = theme.css(label.color);
      ctx.lineWidth = 1;
      ctx.setLineDash([3 * scale, 3 * scale]);
      ctx.beginPath();
      ctx.moveTo(anchorX, anchorY);
      ctx.lineTo(edgeX, edgeY);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  const owners = new Set<AnalysisOwner>();
  for (const label of labels) if (label.owner) owners.add(label.owner);
  const ownerWidth = (owner: AnalysisOwner): number =>
    Math.max(18 * scale, ctx.measureText(owner.tag).width + 8 * scale);
  const markerObstacles = owners.size ? occupied.slice() : [];
  const markerBoxes = new Map<AnalysisOwner, Box>();
  const nextOwnerBoxes = new Map<string, OwnerPlacement>();
  const previousOwners = previous?.width === areaW && previous.height === areaH && previous.scale === scale
    ? previous.ownerBoxes : undefined;
  for (const owner of owners) {
    const width = ownerWidth(owner), height = 16 * scale;
    const old = previousOwners?.get(owner.tag);
    const prior = old === undefined ? undefined : {
      x: old.box.x + owner.x - old.x, y: old.box.y + owner.y - old.y, width, height,
    };
    const box = placeBox(owner.x + owner.radius * 0.7,
      owner.y - owner.radius * 0.7 - height, width, height,
      areaW, areaH, markerObstacles, vectors, scale, reserved, prior);
    markerBoxes.set(owner, box);
    nextOwnerBoxes.set(owner.tag, { x: owner.x, y: owner.y, box });
    const edgeX = Math.max(box.x, Math.min(box.x + width, owner.x));
    const edgeY = Math.max(box.y, Math.min(box.y + height, owner.y));
    const dx = edgeX - owner.x, dy = edgeY - owner.y, distance = Math.hypot(dx, dy);
    if (distance > owner.radius + 3 * scale) {
      ctx.strokeStyle = theme.css(theme.TEXT_DIM);
      ctx.lineWidth = 1;
      ctx.setLineDash([2 * scale, 2 * scale]);
      ctx.beginPath();
      ctx.moveTo(owner.x + dx / distance * owner.radius, owner.y + dy / distance * owner.radius);
      ctx.lineTo(edgeX, edgeY); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  cached.ownerBoxes = nextOwnerBoxes;
  cached.ownerMarkers = ownerMarkers;
  // All association leaders sit below arrow ink, which sits below captions.
  paintVectors?.();
  const ownerBadge = (owner: AnalysisOwner, x: number, y: number): void => {
    const width = ownerWidth(owner);
    ctx.fillStyle = theme.css(owner.color);
    ctx.fillRect(x, y, width, 16 * scale);
    ctx.strokeStyle = theme.css(theme.PANEL);
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, 16 * scale);
    ctx.fillStyle = theme.css(theme.contrastRatio(owner.color, [255, 255, 255]) >= 4.5 ? [255, 255, 255] : [0, 0, 0]);
    ctx.fillText(owner.tag, x + 4 * scale, y + 12 * scale);
  };
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i], box = occupied[i], height = 24 * scale;
    surface(ctx, box);
    ctx.fillStyle = theme.css(label.color);
    ctx.fillRect(box.x + 4 * scale, box.y + 5 * scale, 2 * scale, height - 10 * scale);
    ctx.fillStyle = theme.css(theme.TEXT);
    ctx.fillText(label.text, box.x + 10 * scale, box.y + 16 * scale);
    if (label.owner) {
      const owner = label.owner;
      const width = Math.max(18 * scale, ctx.measureText(owner.tag).width + 8 * scale);
      ownerBadge(owner, box.x + box.width - width - 4 * scale, box.y + 4 * scale);
    }
  }
  for (const owner of owners) {
    const box = markerBoxes.get(owner)!;
    ownerBadge(owner, box.x, box.y);
  }
  if (!reusable) {
    cached.width = areaW; cached.height = areaH; cached.scale = scale;
    cached.vectorCount = vectors.length; cached.reservedCount = reserved.length; cached.boxes = occupied;
    cached.keys = labels.map((label, i) => label.id ?? label.source ?? `label-${i}`);
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i], j = i * 4;
      cached.inputs[j] = label.x; cached.inputs[j + 1] = label.y;
      cached.inputs[j + 2] = cached.widths[i]; cached.inputs[j + 3] = Number(label.right);
    }
    for (let i = 0; i < vectors.length; i++) {
      const vector = vectors[i], j = (labels.length + i) * 4;
      cached.inputs[j] = vector.x1; cached.inputs[j + 1] = vector.y1;
      cached.inputs[j + 2] = vector.x2; cached.inputs[j + 3] = vector.y2;
    }
    for (let i = 0; i < reserved.length; i++) {
      const box = reserved[i], j = (labels.length + vectors.length + i) * 4;
      cached.inputs[j] = box.x; cached.inputs[j + 1] = box.y;
      cached.inputs[j + 2] = box.width; cached.inputs[j + 3] = box.height;
    }
    LAYOUTS.set(ctx, cached);
  }
  if (pointer !== null && hot >= 0 && labels[hot]?.source && areaH >= 60 * scale && areaW >= 80 * scale) {
    const label = labels[hot], box = occupied[hot];
    const owner = label.owner;
    if (owner) {
      ctx.strokeStyle = theme.css(theme.PANEL); ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(owner.x, owner.y, owner.radius + 4, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = theme.css(label.color); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(owner.x, owner.y, owner.radius + 4, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.strokeStyle = theme.css(label.color);
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x + 1, box.y + 1, box.width - 2, box.height - 2);
    const lines: string[] = [];
    const maxWidth = Math.min(300 * scale, areaW - 36 - 20 * scale);
    // Scene names are text only. Bound paint work for exceptionally long names;
    // the source disclosure keeps the complete name and exact components.
    for (const word of label.source!.slice(0, 240).split(/\s+/)) {
      const last = lines.length - 1;
      if (last < 0 || ctx.measureText(lines[last] + " " + word).width > maxWidth) lines.push(word);
      else lines[last] += " " + word;
    }
    const availableLines = Math.max(1, Math.min(3, Math.floor((areaH - 24 * scale) / (18 * scale)) - 1));
    const displayed = [...lines.slice(0, availableLines), label.text];
    const width = Math.min(areaW - 36, Math.max(...displayed.map(line => ctx.measureText(line).width)) + 20 * scale);
    const height = (displayed.length * 18 + 12) * scale;
    // Prefer the pointer's other side before clamping a wide popup against the
    // edge. Leave room for the narrow Inspector tab over the canvas there.
    const preferredX = pointer[0] + 16 + width <= areaW - 30
      ? pointer[0] + 16 : pointer[0] - width - 16;
    // Popup placement uses a copy: hover must never append to the retained
    // label layout or change the caption-to-source index mapping.
    const tip = placeBox(preferredX, pointer[1] + 16, width, height,
      areaW - 24, areaH, occupied.slice(), vectors, scale, reserved);
    surface(ctx, tip);
    ctx.fillStyle = theme.css(theme.TEXT);
    for (let i = 0; i < displayed.length; i++) {
      ctx.fillText(displayed[i], tip.x + 10 * scale, tip.y + (20 + 18 * i) * scale, width - 20 * scale);
    }
  }
  ctx.restore();
}
