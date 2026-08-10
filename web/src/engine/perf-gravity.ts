/** Approximate mutual gravity used only by adaptive Performance mode.
 *
 * Space is divided into a small fixed grid. Nearby cells retain exact
 * body-to-body forces; farther cells act through their total mass and centre
 * of mass. Work is O(n * occupiedCells + nearbyPairs), with every buffer
 * reused. The approximation is intentionally machine-quality-dependent and
 * is never used by Normal mode.
 */
export class ApproximateGravity {
  private mass = new Float64Array(0);
  private mx = new Float64Array(0);
  private my = new Float64Array(0);
  private head = new Int32Array(0);
  private next = new Int32Array(0);
  private bodyCell = new Int32Array(0);
  private occupied = new Int32Array(0);

  private ensure(cells: number, bodies: number): void {
    if (this.mass.length < cells) {
      this.mass = new Float64Array(cells);
      this.mx = new Float64Array(cells);
      this.my = new Float64Array(cells);
      this.head = new Int32Array(cells);
      this.occupied = new Int32Array(cells);
    }
    if (this.next.length < bodies) {
      let cap = Math.max(64, this.next.length);
      while (cap < bodies) cap *= 2;
      this.next = new Int32Array(cap);
      this.bodyCell = new Int32Array(cap);
    }
  }

  /** Add approximate attraction to the seeded acceleration arrays. */
  accumulate(px: Float64Array, py: Float64Array, bodyMass: Float64Array,
             radius: Float64Array, movable: Uint8Array,
             ax: Float64Array, ay: Float64Array, n: number,
             G: number, eps2: number, pointGravity: boolean,
             gridSize: number): void {
    if (n < 2) return;
    let minX = px[0];
    let maxX = px[0];
    let minY = py[0];
    let maxY = py[0];
    for (let i = 1; i < n; i++) {
      const x = px[i];
      const y = py[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const span = Math.max(maxX - minX, maxY - minY, 1e-9);
    const invCell = gridSize / span;
    const cells = gridSize * gridSize;
    this.ensure(cells, n);
    const mass = this.mass;
    const mx = this.mx;
    const my = this.my;
    const head = this.head;
    mass.fill(0, 0, cells);
    mx.fill(0, 0, cells);
    my.fill(0, 0, cells);
    head.fill(-1, 0, cells);

    const next = this.next;
    const bodyCell = this.bodyCell;
    const occupied = this.occupied;
    let occupiedCount = 0;
    for (let i = 0; i < n; i++) {
      let gx = Math.floor((px[i] - minX) * invCell);
      let gy = Math.floor((py[i] - minY) * invCell);
      if (gx < 0) gx = 0;
      else if (gx >= gridSize) gx = gridSize - 1;
      if (gy < 0) gy = 0;
      else if (gy >= gridSize) gy = gridSize - 1;
      const cell = gy * gridSize + gx;
      bodyCell[i] = cell;
      next[i] = head[cell];
      if (head[cell] === -1) occupied[occupiedCount++] = cell;
      head[cell] = i;
      const m = bodyMass[i];
      mass[cell] += m;
      mx[cell] += m * px[i];
      my[cell] += m * py[i];
    }

    for (let i = 0; i < n; i++) {
      if (movable[i] === 0) continue;
      const own = bodyCell[i];
      const ownX = own % gridSize;
      const ownY = (own / gridSize) | 0;
      const ix = px[i];
      const iy = py[i];
      let aix = ax[i];
      let aiy = ay[i];
      for (let k = 0; k < occupiedCount; k++) {
        const cell = occupied[k];
        const cellX = cell % gridSize;
        const cellY = (cell / gridSize) | 0;
        if (Math.abs(cellX - ownX) <= 1 && Math.abs(cellY - ownY) <= 1) {
          for (let j = head[cell]; j !== -1; j = next[j]) {
            if (j === i) continue;
            const dx = px[j] - ix;
            const dy = py[j] - iy;
            let r2 = dx * dx + dy * dy;
            if (!pointGravity) {
              const reach = radius[i] + radius[j];
              const reach2 = reach * reach;
              if (r2 < reach2) r2 = reach2;
            }
            const d2 = r2 + eps2;
            const scale = G * bodyMass[j] / (d2 * Math.sqrt(d2));
            aix += scale * dx;
            aiy += scale * dy;
          }
        } else {
          const cellMass = mass[cell];
          if (cellMass === 0) continue;
          const dx = mx[cell] / cellMass - ix;
          const dy = my[cell] / cellMass - iy;
          const d2 = dx * dx + dy * dy + eps2;
          const scale = G * cellMass / (d2 * Math.sqrt(d2));
          aix += scale * dx;
          aiy += scale * dy;
        }
      }
      ax[i] = aix;
      ay[i] = aiy;
    }
  }
}
