/** Screen-space scientific annotations, independent of physical state. */
import type { Color } from "../engine/body";
import * as theme from "../ui/theme";

export interface AnalysisLabel {
  text: string; x: number; y: number; color: Color; right: boolean;
}
export interface AnalysisCard {
  x: number; y: number;
  rows: Array<{ symbol: string; parallel: number; normal: number; color: Color }>;
}
interface Box { x: number; y: number; width: number; height: number; }

/** Keep small nonzero components and large values legible without long decimals. */
export function analysisNumber(value: number): string {
  const magnitude = Math.abs(value);
  return magnitude !== 0 && (magnitude < 0.005 || magnitude >= 10000)
    ? value.toExponential(2) : value.toFixed(2);
}

function placeBox(x: number, y: number, width: number, height: number,
                  areaW: number, areaH: number, occupied: Box[]): Box {
  const inset = 6;
  const clamp = (px: number, py: number): Box => ({
    x: Math.max(inset, Math.min(areaW - width - inset, px)),
    y: Math.max(inset, Math.min(areaH - height - inset, py)), width, height,
  });
  const overlaps = (box: Box): boolean => {
    // Bound dense opt-in annotation work; ordinary scenes retain every box.
    for (let i = Math.max(0, occupied.length - 128); i < occupied.length; i++) {
      const other = occupied[i];
      if (box.x < other.x + other.width + 4 && box.x + width + 4 > other.x &&
          box.y < other.y + other.height + 4 && box.y + height + 4 > other.y) return true;
    }
    return false;
  };
  const preferred = clamp(x, y);
  for (const [dx, dy] of [
    [0, 0], [0, height + 8], [0, -height - 8],
    [-width - 12, 0], [width + 12, 0],
    [0, 2 * (height + 8)], [0, -2 * (height + 8)],
    [-width - 12, height + 8], [width + 12, height + 8],
  ]) {
    const candidate = clamp(x + dx, y + dy);
    if (!overlaps(candidate)) { occupied.push(candidate); return candidate; }
  }
  // A crowded scene has finite screen space. Keep its numeric labels on the
  // canvas even if local separation is exhausted; full sources remain in UI.
  occupied.push(preferred);
  return preferred;
}

function surface(ctx: CanvasRenderingContext2D, box: Box): void {
  ctx.fillStyle = theme.css(theme.PANEL);
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeStyle = theme.css(theme.OUTLINE);
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1);
}

export function drawAnalysisOverlays(ctx: CanvasRenderingContext2D,
    labels: AnalysisLabel[], cards: AnalysisCard[], areaW: number, areaH: number,
    textScale = 1): void {
  if (labels.length === 0 && cards.length === 0) return;
  const scale = Number.isFinite(textScale) ? Math.max(0.9, Math.min(2, textScale)) : 1;
  const occupied: Box[] = [];
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const card of cards) {
    ctx.font = `${12 * scale}px system-ui, sans-serif`;
    const allAlong = card.rows.map(row => analysisNumber(row.parallel));
    const allNormal = card.rows.map(row => analysisNumber(row.normal));
    const numberWidth = Math.max(ctx.measureText("∥ Along").width,
      ctx.measureText("⊥ Normal").width,
      ...allAlong.map(value => ctx.measureText(value).width),
      ...allNormal.map(value => ctx.measureText(value).width));
    const columnWidth = numberWidth + 14 * scale;
    const width = Math.min(areaW - 12, Math.max(198 * scale, 36 * scale + 2 * columnWidth));
    const compact = 36 * scale + 2 * columnWidth > width;
    ctx.font = `600 ${12 * scale}px system-ui, sans-serif`;
    const heading: string[] = [];
    let line = "";
    for (const word of ["Slope", "components", "(N)"]) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width - 18 * scale) {
        heading.push(line); line = word;
      } else line = next;
    }
    heading.push(line);
    const headerHeight = (11 + heading.length * 17 + (compact ? 2 : 19)) * scale;
    const rowHeight = (compact ? 38 : 19) * scale;
    const maxRows = Math.max(1, Math.floor((areaH - 12 - headerHeight - 44 * scale) / rowHeight));
    const rows = card.rows.slice(0, maxRows);
    const omitted = card.rows.length - rows.length;
    const along = allAlong.slice(0, maxRows), normal = allNormal.slice(0, maxRows);
    const height = headerHeight + rows.length * rowHeight + (omitted > 0 ? 44 : 9) * scale;
    const box = placeBox(card.x, card.y, width, height, areaW, areaH, occupied);
    surface(ctx, box);
    ctx.fillStyle = theme.css(theme.TEXT);
    ctx.font = `600 ${12 * scale}px system-ui, sans-serif`;
    for (let i = 0; i < heading.length; i++) {
      ctx.fillText(heading[i], box.x + 9 * scale, box.y + (17 + i * 17) * scale);
    }
    ctx.font = `${12 * scale}px system-ui, sans-serif`;
    const firstColumn = box.x + 30 * scale;
    const secondColumn = firstColumn + (width - 40 * scale) / 2;
    ctx.fillStyle = theme.css(theme.TEXT_DIM);
    if (!compact) {
      ctx.fillText("∥ Along", firstColumn, box.y + headerHeight - 5 * scale);
      ctx.fillText("⊥ Normal", secondColumn, box.y + headerHeight - 5 * scale);
    }
    for (let i = 0; i < rows.length; i++) {
      const baseline = box.y + headerHeight + 14 * scale + i * rowHeight;
      ctx.fillStyle = theme.css(rows[i].color);
      ctx.fillRect(box.x + 5 * scale, baseline - 9 * scale, 2 * scale, 11 * scale);
      ctx.fillStyle = theme.css(theme.TEXT);
      ctx.fillText(rows[i].symbol, box.x + 11 * scale, baseline);
      ctx.fillText(compact ? `∥ ${along[i]}` : along[i], firstColumn, baseline);
      ctx.fillText(compact ? `⊥ ${normal[i]}` : normal[i], compact ? firstColumn : secondColumn,
        baseline + (compact ? 19 * scale : 0));
    }
    if (omitted > 0) {
      ctx.fillStyle = theme.css(theme.TEXT_DIM);
      ctx.font = `${10 * scale}px system-ui, sans-serif`;
      ctx.fillText(`+${omitted} more forces`, box.x + 9 * scale, box.y + height - 25 * scale);
      ctx.fillText("Open Force values", box.x + 9 * scale, box.y + height - 10 * scale);
    }
  }
  ctx.font = `600 ${12 * scale}px system-ui, sans-serif`;
  for (const label of labels) {
    const width = Math.min(areaW - 12, ctx.measureText(label.text).width + 18 * scale);
    const height = 24 * scale;
    const preferredX = label.right ? label.x + 7 : label.x - width - 7;
    const box = placeBox(preferredX, label.y - height - 6, width, height, areaW, areaH, occupied);
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
