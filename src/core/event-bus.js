/**
 * Deterministic, allocation-free event bus.
 *
 * - `emit` dispatches synchronously, in subscription order, passing up to six
 *   positional arguments (no payload objects => no GC pressure in combat).
 * - `post` enqueues into a fixed-size ring that `flush` drains in FIFO order at
 *   a well-defined point of the frame, so cross-system reactions never depend
 *   on call-stack ordering.
 */
export class EventBus {
  constructor(queueSize = 256) {
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();
    this._qType = new Array(queueSize).fill('');
    this._qArgs = new Array(queueSize * 4).fill(undefined);
    this._qHead = 0;
    this._qCount = 0;
    this._qSize = queueSize;
  }

  /**
   * @param {string} type
   * @param {Function} fn
   * @returns {() => void} unsubscribe handle
   */
  on(type, fn) {
    let list = this._listeners.get(type);
    if (!list) this._listeners.set(type, (list = []));
    list.push(fn);
    return () => this.off(type, fn);
  }

  /** @param {string} type @param {Function} fn */
  off(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  /** Synchronous dispatch. @param {string} type */
  emit(type, a, b, c, d, e, f) {
    const list = this._listeners.get(type);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](a, b, c, d, e, f);
      } catch (err) {
        console.error(`[bus] listener for "${type}" threw`, err);
      }
    }
  }

  /** Deferred dispatch (max four args); dropped with a warning when the ring is full. */
  post(type, a, b, c, d) {
    if (this._qCount === this._qSize) {
      console.warn('[bus] queue overflow, dropping', type);
      return;
    }
    const slot = (this._qHead + this._qCount) % this._qSize;
    this._qType[slot] = type;
    const o = slot * 4;
    this._qArgs[o] = a; this._qArgs[o + 1] = b; this._qArgs[o + 2] = c; this._qArgs[o + 3] = d;
    this._qCount++;
  }

  /** Drains the deferred queue in FIFO order. */
  flush() {
    while (this._qCount > 0) {
      const slot = this._qHead;
      const o = slot * 4;
      const type = this._qType[slot];
      const a = this._qArgs[o], b = this._qArgs[o + 1], c = this._qArgs[o + 2], d = this._qArgs[o + 3];
      this._qArgs[o] = this._qArgs[o + 1] = this._qArgs[o + 2] = this._qArgs[o + 3] = undefined;
      this._qHead = (slot + 1) % this._qSize;
      this._qCount--;
      this.emit(type, a, b, c, d);
    }
  }

  clear() {
    this._listeners.clear();
    this._qCount = 0;
    this._qHead = 0;
    this._qArgs.fill(undefined);
  }
}
