import { Trail } from "./trail";

/** Bounded, lazily allocated path tape. Each sample owns 48 typed-array bytes.
 * The body-tail index contains only bodies with retained samples. The tape
 * records chronological simulation samples and is independent of physics. */
export class TrailHistory {
  static readonly DEFAULT_BUDGET = 16 * 1024 * 1024;
  private data = new Float64Array(0);
  private prev = new Int32Array(0);
  private next = new Int32Array(0);
  private tails = new Map<number, number>();
  private head = 0;
  private size = 0;
  private readonly maximum: number;
  private readonly scratch: number[] = [];

  constructor(byteBudget = TrailHistory.DEFAULT_BUDGET) {
    if (!Number.isFinite(byteBudget) || byteBudget < 48) throw new RangeError("Trail history budget must hold one sample.");
    this.maximum = Math.floor(byteBudget / 48);
  }

  get count(): number { return this.size; }
  get bytesUsed(): number { return this.data.byteLength + this.prev.byteLength + this.next.byteLength; }
  get bodyCount(): number { return this.tails.size; }
  get earliestTime(): number | null { return this.size ? this.data[this.head * 5 + 3] : null; }

  clear(): void {
    this.data = new Float64Array(0); this.prev = new Int32Array(0); this.next = new Int32Array(0);
    this.head = this.size = 0; this.tails.clear(); this.scratch.length = 0;
  }

  /** Copy retained entries in their chronological order when growing.
   * Growth is amortized, capped, and absent until samples are requested. */
  private grow(): void {
    const oldCapacity = this.prev.length;
    const capacity = Math.min(this.maximum, Math.max(128, oldCapacity * 2));
    const data = new Float64Array(capacity * 5);
    const prev = new Int32Array(capacity), next = new Int32Array(capacity);
    prev.fill(-1); next.fill(-1);
    this.tails.clear();
    for (let k = 0; k < this.size; k++) {
      const source = (this.head + k) % oldCapacity;
      data.set(this.data.subarray(source * 5, source * 5 + 5), k * 5);
      const id = data[k * 5], prior = this.tails.get(id) ?? -1;
      prev[k] = prior; if (prior >= 0) next[prior] = k;
      this.tails.set(id, k);
    }
    this.data = data; this.prev = prev; this.next = next; this.head = 0;
  }

  private unlink(slot: number): void {
    const id = this.data[slot * 5], prior = this.prev[slot], following = this.next[slot];
    if (prior >= 0) this.next[prior] = following;
    if (following >= 0) this.prev[following] = prior;
    if (this.tails.get(id) === slot) {
      if (prior >= 0) this.tails.set(id, prior); else this.tails.delete(id);
    }
    this.prev[slot] = this.next[slot] = -1;
  }

  push(id: number, serial: number, x: number, y: number, time: number): void {
    if (!Number.isFinite(id) || !Number.isFinite(serial) || !Number.isFinite(x) ||
        !Number.isFinite(y) || !Number.isFinite(time)) return;
    // A branch drops its abandoned future before new points are appended.
    if (this.size) {
      const last = (this.head + this.size - 1) % this.prev.length;
      if (time < this.data[last * 5 + 3] - 1e-12) this.truncateAfter(time);
    }
    if (this.size === this.prev.length && this.size < this.maximum) this.grow();
    if (this.size === this.maximum) {
      this.unlink(this.head); this.head = (this.head + 1) % this.prev.length; this.size--;
    }
    const slot = (this.head + this.size) % this.prev.length, offset = slot * 5;
    this.data[offset] = id; this.data[offset + 1] = x; this.data[offset + 2] = y;
    this.data[offset + 3] = time; this.data[offset + 4] = serial;
    const prior = this.tails.get(id) ?? -1;
    this.prev[slot] = prior; this.next[slot] = -1;
    if (prior >= 0) this.next[prior] = slot;
    this.tails.set(id, slot); this.size++;
  }

  truncateAfter(time: number): void {
    while (this.size) {
      const slot = (this.head + this.size - 1) % this.prev.length;
      if (this.data[slot * 5 + 3] <= time + 1e-12) break;
      this.unlink(slot); this.size--;
    }
  }

  expireBefore(time: number): void {
    while (this.size && this.data[this.head * 5 + 3] < time) {
      this.unlink(this.head); this.head = (this.head + 1) % this.prev.length; this.size--;
    }
  }

  /** Refill an existing display ring with exact authored samples. Only slot
   * indices are temporarily collected; no position tuples are allocated. */
  restoreTrail(id: number, trail: Trail, start: number, end: number): void {
    const slots = this.scratch;
    slots.length = 0;
    for (let slot = this.tails.get(id) ?? -1; slot >= 0; slot = this.prev[slot]) {
      const time = this.data[slot * 5 + 3];
      if (time < start) break;
      if (time > end + 1e-12) continue;
      slots.push(slot);
      if (slots.length >= trail.capacity) break;
    }
    trail.clear();
    if (slots.length) trail.firstSerial = this.data[slots[slots.length - 1] * 5 + 4];
    for (let k = slots.length - 1; k >= 0; k--) {
      const offset = slots[k] * 5;
      trail.push(this.data[offset + 1], this.data[offset + 2], this.data[offset + 3]);
    }
    slots.length = 0;
  }
}