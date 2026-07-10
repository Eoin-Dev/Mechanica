/** 2D vector used throughout the engine.
 *
 * Mutable; arithmetic methods return new vectors, *Ip methods mutate in
 * place (used in hot loops to avoid allocation).
 */
export class Vec2 {
  x: number;
  y: number;

  constructor(x = 0.0, y = 0.0) {
    this.x = x;
    this.y = y;
  }

  // --- arithmetic (allocating) ---------------------------------------------
  add(o: Vec2): Vec2 {
    return new Vec2(this.x + o.x, this.y + o.y);
  }

  sub(o: Vec2): Vec2 {
    return new Vec2(this.x - o.x, this.y - o.y);
  }

  mul(s: number): Vec2 {
    return new Vec2(this.x * s, this.y * s);
  }

  div(s: number): Vec2 {
    return new Vec2(this.x / s, this.y / s);
  }

  neg(): Vec2 {
    return new Vec2(-this.x, -this.y);
  }

  // --- in-place (non-allocating) -------------------------------------------
  addIp(o: Vec2): Vec2 {
    this.x += o.x;
    this.y += o.y;
    return this;
  }

  set(x: number, y: number): Vec2 {
    this.x = x;
    this.y = y;
    return this;
  }

  setVec(o: Vec2): Vec2 {
    this.x = o.x;
    this.y = o.y;
    return this;
  }

  // --- products / measures --------------------------------------------------
  dot(o: Vec2): number {
    return this.x * o.x + this.y * o.y;
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  length2(): number {
    return this.x * this.x + this.y * this.y;
  }

  distTo(o: Vec2): number {
    const dx = this.x - o.x;
    const dy = this.y - o.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  rotated(angle: number): Vec2 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vec2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  copy(): Vec2 {
    return new Vec2(this.x, this.y);
  }
}
