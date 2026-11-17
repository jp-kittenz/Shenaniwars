/**
 * Game-state tokenisation: every stateful system registers a provider that
 * turns its live state into a plain JSON token and back. A snapshot is just
 * the map of those tokens, so save / restore / debugging dumps share one path
 * and no system holds references into another system's objects.
 */

/**
 * @typedef {Object} StateProvider
 * @property {() => any} serialize
 * @property {(data: any) => void} deserialize
 */

const VERSION = 1;
const KEY_PREFIX = 'shenaniwars.save.';

export class StateStore {
  /** @param {import('./event-bus.js').EventBus} bus */
  constructor(bus) {
    this.bus = bus;
    /** @type {Map<string, StateProvider>} insertion order == restore order */
    this._providers = new Map();
  }

  /** @param {string} key @param {StateProvider} provider */
  register(key, provider) {
    this._providers.set(key, provider);
  }

  /** @returns {{v: number, t: number, data: Record<string, any>}} */
  snapshot() {
    /** @type {Record<string, any>} */
    const data = {};
    for (const [key, p] of this._providers) data[key] = p.serialize();
    return { v: VERSION, t: Date.now(), data };
  }

  /** @param {{v: number, data: Record<string, any>}} snap @returns {boolean} */
  restore(snap) {
    if (!snap || snap.v !== VERSION || !snap.data) return false;
    for (const [key, p] of this._providers) {
      if (!(key in snap.data)) continue;
      try {
        p.deserialize(snap.data[key]);
      } catch (err) {
        console.error(`[state] restore of "${key}" failed`, err);
        return false;
      }
    }
    this.bus.emit('state:restored');
    return true;
  }

  /** @param {string} [slot] @returns {boolean} */
  save(slot = 'quick') {
    try {
      localStorage.setItem(KEY_PREFIX + slot, JSON.stringify(this.snapshot()));
      this.bus.emit('state:saved', slot);
      return true;
    } catch (err) {
      console.warn('[state] save failed', err);
      return false;
    }
  }

  /** @param {string} [slot] @returns {boolean} */
  load(slot = 'quick') {
    try {
      const raw = localStorage.getItem(KEY_PREFIX + slot);
      return raw ? this.restore(JSON.parse(raw)) : false;
    } catch (err) {
      console.warn('[state] load failed', err);
      return false;
    }
  }

  /** @param {string} [slot] */
  hasSave(slot = 'quick') {
    try {
      return localStorage.getItem(KEY_PREFIX + slot) !== null;
    } catch {
      return false;
    }
  }
}
