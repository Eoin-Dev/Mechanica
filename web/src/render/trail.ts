/** Fixed-capacity ring buffer of trail points for one body.
 *
 * Motion trails record a point on nearly every physics substep and only ever
 * keep the newest `capacity` of them. The obvious `Array.push` +
 * `splice(0, …)` costs O(capacity) per point (the whole array shifts down),
 * which dominates the frame in scenes with many bodies. This stores the
 * points in a flat Float64Array ring instead: appends are O(1), memory is a
 * tight 16 bytes/point (no per-point JS array objects), and a running
 * bounding box lets the renderer cull trails that are fully off-screen.
 */
export class Trail {
  private xy: Float64Array;
  private cap: number;
  private head = 0;   // point index of the oldest sample
  private len = 0;    // number of valid samples (<= cap)
  // world-space bounding box of the retained points, for off-screen culling.
  // It only ever grows on push, so it can lag reality after eviction; a full
  // recompute every `cap` pushes keeps it from drifting permanently loose.
  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
  private sinceRecompute = 0;

  constructor(capacity: number) {
    this.cap = Math.max(1, Math.floor(capacity));
    this.xy = new Float64Array(this.cap * 2);
  }

  get count(): number { return this.len; }
  get capacity(): number { return this.cap; }

  /** x/y of the k-th point in chronological order (0 = oldest). */
  x(k: number): number { return this.xy[(((this.head + k) % this.cap) * 2)]; }
  y(k: number): number { return this.xy[(((this.head + k) % this.cap) * 2) + 1]; }

  push(x: number, y: number): void {
    const i = ((this.head + this.len) % this.cap) * 2;
    this.xy[i] = x;
    this.xy[i + 1] = y;
    if (this.len < this.cap) {
      this.len++;
    } else {
      this.head = (this.head + 1) % this.cap;
    }
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
    if (++this.sinceRecompute >= this.cap) this.recomputeBounds();
  }

  /** Grow or shrink to a new capacity, keeping the newest points in order. */
  setCapacity(capacity: number): void {
    const cap = Math.max(1, Math.floor(capacity));
    if (cap === this.cap) return;
    const keep = Math.min(this.len, cap);
    const next = new Float64Array(cap * 2);
    // copy the newest `keep` points, oldest first
    const first = this.len - keep;
    for (let k = 0; k < keep; k++) {
      const src = ((this.head + first + k) % this.cap) * 2;
      next[k * 2] = this.xy[src];
      next[k * 2 + 1] = this.xy[src + 1];
    }
    this.xy = next;
    this.cap = cap;
    this.head = 0;
    this.len = keep;
    this.recomputeBounds();
  }

  private recomputeBounds(): void {
    this.sinceRecompute = 0;
    let miX = Infinity, miY = Infinity, maX = -Infinity, maY = -Infinity;
    for (let k = 0; k < this.len; k++) {
      const i = ((this.head + k) % this.cap) * 2;
      const x = this.xy[i];
      const y = this.xy[i + 1];
      if (x < miX) miX = x;
      if (x > maX) maX = x;
      if (y < miY) miY = y;
      if (y > maY) maY = y;
    }
    this.minX = miX; this.minY = miY; this.maxX = maX; this.maxY = maY;
  }
}
