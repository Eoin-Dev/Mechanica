/** Small, presentation-only name cue for the one particle under the pointer. */
import type { Body } from "../engine/body";
import type { Camera } from "./camera";
import type { AnalysisBox } from "./analysis-overlays";
import * as theme from "../ui/theme";

export interface ParticleHoverCue extends AnalysisBox {
  text: string;
  font: string;
  scale: number;
}

/** Work is limited to the hovered particle; no scene or force traversal. */
export function prepareParticleHover(ctx: CanvasRenderingContext2D, camera: Camera,
    body: Body, areaW: number, areaH: number, textScale: number,
    pointer: readonly [number, number]): ParticleHoverCue | null {
  if (body.isAnchor || body.isRodEndpoint || body.held ||
      ctx.canvas?.closest?.("[inert]")) return null;
  const scale = Number.isFinite(textScale) ? Math.max(0.8, Math.min(2, textScale)) : 1;
  const inset = 6, height = 22 * scale, padding = 6 * scale;
  if (areaW < 36 || areaH < height + 2 * inset ||
      !Number.isFinite(areaW + areaH + camera.zoom + body.pos.x + body.pos.y + body.radius)) return null;
  const x = (body.pos.x - camera.centre.x) * camera.zoom + camera.screenW * 0.5;
  const y = (camera.centre.y - body.pos.y) * camera.zoom + camera.screenH * 0.5;
  const radius = Math.max(2, body.radius * camera.zoom);
  const pointerRadius = radius + 8;
  // Hover can remain parked during a captured drag or moving simulation.
  // Draw only while the pointer still reaches this particle in the canvas.
  if (pointer[0] < 0 || pointer[0] > areaW || pointer[1] < 0 || pointer[1] > areaH ||
      !Number.isFinite(pointer[0] + pointer[1] + x + y) ||
      (pointer[0] - x) ** 2 + (pointer[1] - y) ** 2 > pointerRadius ** 2) return null;
  const font = `${11 * scale}px system-ui, sans-serif`;
  const oldFont = ctx.font;
  ctx.font = font;
  let text = body.name.trim() || `Particle ${body.id}`;
  const maxTextWidth = Math.min(180 * scale, areaW - 2 * inset) - 2 * padding;
  let textWidth = ctx.measureText(text).width;
  if (textWidth > maxTextWidth) {
    if (ctx.measureText("…").width > maxTextWidth) { ctx.font = oldFont; return null; }
    // Preserve whole Unicode code points when shortening long user names.
    const characters = Array.from(text);
    let lo = 0, hi = characters.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(characters.slice(0, mid).join("") + "…").width <= maxTextWidth) lo = mid;
      else hi = mid - 1;
    }
    text = characters.slice(0, lo).join("") + "…";
    textWidth = ctx.measureText(text).width;
  }
  ctx.font = oldFont;
  const width = textWidth + 2 * padding;
  const above = y - radius - 6 * scale - height;
  const preferredY = above >= inset ? above : y + radius + 6 * scale;
  return {
    x: Math.max(inset, Math.min(areaW - width - inset, x - width * 0.5)),
    y: Math.max(inset, Math.min(areaH - height - inset, preferredY)),
    width, height, text, font, scale,
  };
}

/** Neutral and smaller than scientific force captions, with no accent colour. */
export function drawParticleHover(ctx: CanvasRenderingContext2D, cue: ParticleHoverCue): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(cue.x, cue.y, cue.width, cue.height, 5 * cue.scale);
  ctx.fillStyle = theme.css(theme.PANEL);
  ctx.fill();
  ctx.strokeStyle = theme.css(theme.OUTLINE);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = cue.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.css(theme.TEXT_DIM);
  ctx.fillText(cue.text, cue.x + cue.width * 0.5, cue.y + cue.height * 0.5 + 0.5);
  ctx.restore();
}
