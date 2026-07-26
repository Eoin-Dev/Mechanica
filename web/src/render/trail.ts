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
  private ts: Float64Array; // simulation time of each point
  private cap: number;
  private head = 0;   // point index of the oldest sample
  private len = 0;    // number of valid samples (<= cap)
  // Serial number of the oldest retained point. Serials are monotonic
  // across the trail's whole life, so the renderer can decimate on
  // `serial % stride` and keep selecting the SAME physical points as the
  // ring scrolls - decimating on the ring index instead re-picks a
  // different subset every frame, which reads as the trail shimmering
  // and warping in place.
  firstSerial = 0;
  // world-space bounding box of the retained points, for off-screen culling.
  // It only ever grows on push, so it can lag reality after eviction; a full
  // recompute every `cap` pushes keeps it from drifting permanently loose.
  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
  private sinceRecompute = 0;

  constructor(capacity: number) {
    this.cap = Math.max(1, Math.floor(capacity));
    this.xy = new Float64Array(this.cap * 2);
    this.ts = new Float64Array(this.cap);
  }

  get count(): number { return this.len; }
  get capacity(): number { return this.cap; }

  /** x/y/time of the k-th point in chronological order (0 = oldest). */
  x(k: number): number { return this.xy[(((this.head + k) % this.cap) * 2)]; }
  y(k: number): number { return this.xy[(((this.head + k) % this.cap) * 2) + 1]; }
  time(k: number): number { return this.ts[(this.head + k) % this.cap]; }

  /** Write every `stride`-th point (plus both ends) into `outX`/`outY` in
   * SCREEN space, and return how many were written.
   *
   * The renderer does this for every visible trail on every frame, so it
   * is worth having as one tight loop rather than a call per coordinate:
   * `x(k)`/`y(k)` each cost a modulo, the transform used to allocate a
   * two-element array per point, and the caller used to visit every stored
   * point only to reject most of them. Here the ring index is walked and
   * wrapped by hand, and only the retained points are touched at all -
   * which is what stops a 10 000-point trail costing 10 000 iterations to
   * yield the ninety samples the vertex budget allows.
   *
   * The retained set is exactly `{0, count-1} + {k : (k + phase) % stride
   * == 0}`, phase being `firstSerial % stride`, so that decimation keeps
   * selecting the same physical points as the ring scrolls.
   */
  sampleScreen(stride: number, outX: number[], outY: number[],
               cx: number, cy: number, zoom: number,
               ox: number, oy: number): number {
    const n = this.len;
    if (n === 0) return 0;
    const xy = this.xy;
    const cap = this.cap;
    const head = this.head;
    const last = n - 1;
    let m = 0;
    // head < cap and k <= cap - 1, so the ring index wraps at most once:
    // a single compare beats the modulo the accessors above have to do
    let slot = head;
    outX[0] = (xy[slot * 2] - cx) * zoom + ox;
    outY[0] = (cy - xy[slot * 2 + 1]) * zoom + oy;
    m = 1;
    if (last > 0) {
      const phase = this.firstSerial % stride;
      // smallest k > 0 whose serial lands on the stride
      let k = (stride - phase) % stride;
      if (k === 0) k = stride;
      for (; k < last; k += stride) {
        slot = head + k;
        if (slot >= cap) slot -= cap;
        const i = slot * 2;
        outX[m] = (xy[i] - cx) * zoom + ox;
        outY[m] = (cy - xy[i + 1]) * zoom + oy;
        m++;
      }
      slot = head + last;
      if (slot >= cap) slot -= cap;
      outX[m] = (xy[slot * 2] - cx) * zoom + ox;
      outY[m] = (cy - xy[slot * 2 + 1]) * zoom + oy;
      m++;
    }
    return m;
  }

  push(x: number, y: number, t = 0): void {
    const slot = (this.head + this.len) % this.cap;
    const i = slot * 2;
    this.xy[i] = x;
    this.xy[i + 1] = y;
    this.ts[slot] = t;
    if (this.len < this.cap) {
      this.len++;
    } else {
      this.head = (this.head + 1) % this.cap;
      this.firstSerial++;
    }
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
    if (++this.sinceRecompute >= this.cap) this.recomputeBounds();
  }

  /** Drop points recorded before `tCut`.
   *
   * This is what makes a trail fade with TIME rather than only with
   * motion: a body that stops still ages its trail out instead of
   * leaving a frozen line behind forever. */
  expireBefore(tCut: number): void {
    let dropped = 0;
    while (this.len > 0 && this.ts[this.head] < tCut) {
      this.head = (this.head + 1) % this.cap;
      this.len--;
      this.firstSerial++;
      dropped++;
    }
    // Do NOT recompute the bounds here. At steady state a point expires on
    // essentially every frame, so recomputing made this O(capacity) per
    // body per frame - with long trails on a busy scene that alone was a
    // large slice of the budget. Eviction can only ever leave the box too
    // LARGE, which costs nothing but a missed cull (the same contract push
    // already relies on), so amortise it the same way: charge the drops
    // against the periodic recompute and let that catch up.
    this.sinceRecompute += dropped;
    if (this.sinceRecompute >= this.cap) this.recomputeBounds();
  }

  /** Discard everything (a rewind/reset invalidates recorded history). */
  clear(): void {
    this.head = 0;
    this.len = 0;
    this.recomputeBounds();
  }

  /** Grow or shrink to a new capacity, keeping the newest points in order. */
  setCapacity(capacity: number): void {
    const cap = Math.max(1, Math.floor(capacity));
    if (cap === this.cap) return;
    const keep = Math.min(this.len, cap);
    const next = new Float64Array(cap * 2);
    const nextTs = new Float64Array(cap);
    // copy the newest `keep` points, oldest first
    const first = this.len - keep;
    for (let k = 0; k < keep; k++) {
      const slot = (this.head + first + k) % this.cap;
      const src = slot * 2;
      next[k * 2] = this.xy[src];
      next[k * 2 + 1] = this.xy[src + 1];
      nextTs[k] = this.ts[slot];
    }
    this.xy = next;
    this.ts = nextTs;
    this.cap = cap;
    this.firstSerial += first; // the dropped points keep their serials
    this.head = 0;
    this.len = keep;
    this.recomputeBounds();
  }

  recomputeBounds(): void {
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
