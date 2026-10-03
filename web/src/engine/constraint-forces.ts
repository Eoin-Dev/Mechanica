/** Small coupled force systems. Reusable storage keeps the ordinary force
 * evaluator free of matrix/row allocations. Larger systems retain their
 * iterative solve; this block handles strongly coupled classroom assemblies. */
export class ConstraintForceSolve {
  static readonly LIMIT = 64;
  matrix = new Float64Array(0);
  rhs = new Float64Array(0);
  solution = new Float64Array(0);
  bilateral = new Uint8Array(0);
  private active = new Uint8Array(0);
  private indices = new Uint8Array(0);
  private work = new Float64Array(0);
  private capacity = 0;

  prepare(count: number): void {
    if (!Number.isInteger(count) || count < 1 || count > ConstraintForceSolve.LIMIT) throw new RangeError("Unsupported force-system size");
    if (count <= this.capacity) return;
    this.capacity = Math.min(ConstraintForceSolve.LIMIT, Math.max(count, this.capacity * 2, 4));
    this.matrix = new Float64Array(this.capacity * this.capacity);
    this.work = new Float64Array(this.capacity * (this.capacity + 1));
    this.rhs = new Float64Array(this.capacity);
    this.solution = new Float64Array(this.capacity);
    this.bilateral = new Uint8Array(this.capacity);
    this.active = new Uint8Array(this.capacity);
    this.indices = new Uint8Array(this.capacity);
  }

  /** Solve A*lambda=b with unrestricted rods and nonnegative rope tensions.
   * An inactive rope must have b-A*lambda <= 0: its path is shortening.
   * Singular/redundant systems return false for the caller's iterative fallback. */
  solve(count: number): boolean {
    if (!Number.isInteger(count) || count < 1 || count > this.capacity) return false;
    this.active.fill(1, 0, count);
    let scale = 1;
    for (let i = 0; i < count; i++) scale = Math.max(scale, Math.abs(this.rhs[i]));
    const residualTolerance = 1e-12 * scale;
    for (let pass = 0; pass < 4 * count + 4; pass++) {
      if (!this.solveActive(count)) return false;
      let negative = -1, minimum = 0, forceScale = 1;
      for (let i = 0; i < count; i++) forceScale = Math.max(forceScale, Math.abs(this.solution[i]));
      for (let i = 0; i < count; i++) {
        if (!this.bilateral[i] && this.active[i] && this.solution[i] < minimum) {
          minimum = this.solution[i]; negative = i;
        }
      }
      if (negative !== -1 && minimum < -1e-12 * forceScale) {
        this.active[negative] = 0; continue;
      }
      let violated = -1, worst = residualTolerance;
      for (let i = 0; i < count; i++) {
        if (this.bilateral[i] || this.active[i]) continue;
        let residual = this.rhs[i];
        for (let j = 0; j < count; j++) residual -= this.matrix[i * count + j] * this.solution[j];
        if (residual > worst) { worst = residual; violated = i; }
      }
      if (violated !== -1) { this.active[violated] = 1; continue; }
      for (let i = 0; i < count; i++) if (!this.bilateral[i]) this.solution[i] = Math.max(0, this.solution[i]);
      return true;
    }
    return false;
  }

  private solveActive(count: number): boolean {
    const { indices, work, matrix, rhs, solution } = this;
    solution.fill(0, 0, count);
    let n = 0;
    for (let i = 0; i < count; i++) if (this.active[i]) indices[n++] = i;
    if (n === 0) return true;
    const stride = n + 1;
    let scale = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const value = matrix[indices[i] * count + indices[j]];
        if (!Number.isFinite(value)) return false;
        work[i * stride + j] = value; scale = Math.max(scale, Math.abs(value));
      }
      work[i * stride + n] = rhs[indices[i]];
      if (!Number.isFinite(work[i * stride + n])) return false;
    }
    const tolerance = Number.EPSILON * scale * n;
    for (let k = 0; k < n; k++) {
      let pivot = k;
      for (let i = k + 1; i < n; i++) if (Math.abs(work[i * stride + k]) > Math.abs(work[pivot * stride + k])) pivot = i;
      if (!(Math.abs(work[pivot * stride + k]) > tolerance)) return false;
      if (pivot !== k) for (let j = k; j <= n; j++) {
        const value = work[k * stride + j]; work[k * stride + j] = work[pivot * stride + j]; work[pivot * stride + j] = value;
      }
      for (let i = k + 1; i < n; i++) {
        const factor = work[i * stride + k] / work[k * stride + k];
        for (let j = k + 1; j <= n; j++) work[i * stride + j] -= factor * work[k * stride + j];
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      let value = work[i * stride + n];
      for (let j = i + 1; j < n; j++) value -= work[i * stride + j] * solution[indices[j]];
      solution[indices[i]] = value / work[i * stride + i];
      if (!Number.isFinite(solution[indices[i]])) return false;
    }
    return true;
  }
}
