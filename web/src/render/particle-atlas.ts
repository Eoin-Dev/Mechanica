/** Bounded subpixel glyph cache for dense, high-DPI tiny-particle views. */
import type { Color } from "../engine/body";

interface Atlas {
  bitmap: HTMLCanvasElement;
  painter: CanvasRenderingContext2D;
  pad: number;
  slot: number;
  styles: Map<number, number>;
}

/** Tiny discs have no visible spin marker. Cache their fill and one-pixel
 * edge together, with eight phases per device-pixel axis, then copy on the
 * device-pixel lattice. This avoids both blurred resampling and thousands
 * of separate vector raster operations. Larger/special bodies stay vector.
 *
 * At most two radii and sixteen colours per radius are retained. Each style
 * owns 64 phase cells in a 32-by-32 atlas. Zoom/DPR/world changes release the
 * previous bitmaps. Unsupported contexts and excess styles use normal paths. */
export class ParticleAtlas {
  private atlases = new Map<number, Atlas>();
  private dpr = 0;
  private zoom = 0;
  private world: unknown;
  private enabled = false;
  private failed = false;

  constructor(private createBitmap: () => HTMLCanvasElement | null = () =>
    typeof document === "undefined" ? null : document.createElement("canvas")) {}

  begin(ctx: CanvasRenderingContext2D, zoom: number, world: unknown, count: number): void {
    const transform = ctx.getTransform?.();
    const dpr = transform?.a ?? 0;
    if (this.dpr !== dpr || this.zoom !== zoom || this.world !== world) {
      for (const atlas of this.atlases.values()) atlas.bitmap.width = atlas.bitmap.height = 0;
      this.atlases.clear();
      this.dpr = dpr;
      this.zoom = zoom;
      this.world = world;
      this.failed = false;
    }
    this.enabled = !this.failed && count >= 500 && dpr >= 1.5 && dpr <= 2.5 &&
      dpr === transform?.d && transform.b === 0 && transform.c === 0 &&
      transform.e === 0 && transform.f === 0 && ctx.globalAlpha === 1 &&
      ctx.globalCompositeOperation === "source-over";
  }

  draw(ctx: CanvasRenderingContext2D, x: number, y: number,
       radius: number, colour: Color): boolean {
    if (!this.enabled || !Number.isFinite(x) || !Number.isFinite(y) ||
        !Number.isFinite(radius) || radius < 2 || radius >= 5) return false;
    const dx = x * this.dpr, dy = y * this.dpr;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const [r, g, b] = colour;
    if ((r | 0) !== r || (g | 0) !== g || (b | 0) !== b ||
        r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return false;
    const rgb = (r << 16) | (g << 8) | b;
    let atlas = this.atlases.get(radius);
    if (atlas === undefined) {
      if (this.atlases.size >= 2) return false;
      const pad = Math.ceil((radius + 0.5) * this.dpr) + 1;
      const slot = 2 * pad + 1;
      let bitmap: HTMLCanvasElement | null = null;
      try {
        bitmap = this.createBitmap();
        if (bitmap !== null) {
          bitmap.width = bitmap.height = slot * 32;
          const painter = bitmap.getContext("2d");
          if (painter !== null) atlas = { bitmap, painter, pad, slot, styles: new Map() };
        }
      } catch { /* A glyph cache must not interrupt ordinary vector drawing. */ }
      if (atlas === undefined) {
        if (bitmap !== null) bitmap.width = bitmap.height = 0;
        this.failed = true;
        this.enabled = false;
        return false;
      }
      this.atlases.set(radius, atlas);
    }
    let style = atlas.styles.get(rgb);
    if (style === undefined) {
      if (atlas.styles.size >= 16) return false;
      style = atlas.styles.size;
      const painter = atlas.painter;
      painter.fillStyle = `rgb(${r},${g},${b})`;
      painter.strokeStyle = `rgb(${(r * 0.55) | 0},${(g * 0.55) | 0},${(b * 0.55) | 0})`;
      painter.lineWidth = 1;
      // Populate one colour's phases before copying any of them. Interleaving
      // painting and copying a shared atlas can force repeated GPU uploads.
      for (let qx = 0; qx < 8; qx++) for (let qy = 0; qy < 8; qy++) {
        const at = style * 64 + qx * 8 + qy;
        painter.setTransform(this.dpr, 0, 0, this.dpr,
          at % 32 * atlas.slot, Math.floor(at / 32) * atlas.slot);
        painter.beginPath();
        painter.arc((atlas.pad + qx / 8) / this.dpr,
          (atlas.pad + qy / 8) / this.dpr, radius, 0, Math.PI * 2);
        painter.fill();
        painter.stroke();
      }
      atlas.styles.set(rgb, style);
    }
    let ix = Math.floor(dx), iy = Math.floor(dy);
    let qx = Math.round((dx - ix) * 8), qy = Math.round((dy - iy) * 8);
    if (qx === 8) { qx = 0; ix++; }
    if (qy === 8) { qy = 0; iy++; }
    const at = style * 64 + qx * 8 + qy;
    ctx.drawImage(atlas.bitmap,
      at % 32 * atlas.slot, Math.floor(at / 32) * atlas.slot, atlas.slot, atlas.slot,
      (ix - atlas.pad) / this.dpr, (iy - atlas.pad) / this.dpr,
      atlas.slot / this.dpr, atlas.slot / this.dpr);
    return true;
  }
}
