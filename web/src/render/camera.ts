/** World <-> screen transform with pan and zoom-to-cursor. */
import { Vec2 } from "../core/vec";

export const MIN_ZOOM = 2.0; // px per metre
export const MAX_ZOOM = 2000.0;

export class Camera {
  centre = new Vec2(0.0, 0.0); // world point at the middle of the canvas
  zoom = 88.0;                 // px per metre
  screenW: number;
  screenH: number;

  constructor(screenW: number, screenH: number) {
    this.screenW = screenW;
    this.screenH = screenH;
  }

  resize(w: number, h: number): void {
    this.screenW = w;
    this.screenH = h;
  }

  toScreen(p: Vec2): [number, number] {
    return [(p.x - this.centre.x) * this.zoom + this.screenW * 0.5,
            (this.centre.y - p.y) * this.zoom + this.screenH * 0.5];
  }

  toScreenXY(x: number, y: number): [number, number] {
    return [(x - this.centre.x) * this.zoom + this.screenW * 0.5,
            (this.centre.y - y) * this.zoom + this.screenH * 0.5];
  }

  toWorld(sx: number, sy: number): Vec2 {
    return new Vec2((sx - this.screenW * 0.5) / this.zoom + this.centre.x,
                    this.centre.y - (sy - this.screenH * 0.5) / this.zoom);
  }

  panPixels(dx: number, dy: number): void {
    this.centre.x -= dx / this.zoom;
    this.centre.y += dy / this.zoom;
  }

  /** Zoom keeping the world point under the cursor fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    const after = this.toWorld(sx, sy);
    this.centre.x += before.x - after.x;
    this.centre.y += before.y - after.y;
  }

  visibleBounds(): [number, number, number, number] {
    const halfW = (this.screenW * 0.5) / this.zoom;
    const halfH = (this.screenH * 0.5) / this.zoom;
    return [this.centre.x - halfW, this.centre.y - halfH,
            this.centre.x + halfW, this.centre.y + halfH];
  }

  /** A round world length (1/2/5 * 10^k m) that spans 60-160 px. */
  niceScaleLength(): [number, string] {
    const target = 100.0 / this.zoom;
    let best = 1.0;
    for (let exp = -4; exp < 6; exp++) {
      for (const mant of [1.0, 2.0, 5.0]) {
        const candidate = mant * 10.0 ** exp;
        if (Math.abs(candidate - target) < Math.abs(best - target)) {
          best = candidate;
        }
      }
    }
    const label = best >= 0.01 ? `${formatG(best)} m` : `${formatG(best * 1000)} mm`;
    return [best, label];
  }
}

/** Python's %g-style compact number formatting. */
export function formatG(v: number): string {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e-4 && abs < 1e6) {
    return String(parseFloat(v.toPrecision(6)));
  }
  return v.toExponential(4).replace(/\.?0+e/, "e");
}
