/**
 * Fixed-capacity object pool with a dense "active" prefix. Acquire/release are
 * O(1) swap operations and never allocate after construction, which keeps the
 * garbage collector quiet during firefights.
 * @template T
 */
export class Pool {
  /**
   * @param {number} capacity
   * @param {(index: number) => T} factory
   */
  constructor(capacity, factory) {
    /** @type {T[]} items[0..active) are live */
    this.items = new Array(capacity);
    for (let i = 0; i < capacity; i++) this.items[i] = factory(i);
    this.active = 0;
    this.capacity = capacity;
  }

  /**
   * @param {boolean} [recycleOldest] when exhausted, reuse slot 0 instead of failing
   * @returns {T | null}
   */
  acquire(recycleOldest = false) {
    if (this.active === this.capacity) {
      if (!recycleOldest) return null;
      this.releaseAt(0);
    }
    return this.items[this.active++];
  }

  /** Releases the live item at `index`; the last live item takes its slot. */
  releaseAt(index) {
    const last = --this.active;
    const item = this.items[index];
    this.items[index] = this.items[last];
    this.items[last] = item;
  }

  releaseAll() {
    this.active = 0;
  }
}
