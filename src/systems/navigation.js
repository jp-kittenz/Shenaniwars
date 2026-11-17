import { CONFIG } from '../core/config.js';
import { clamp } from '../core/math.js';

const MAX_PATH_POINTS = 48;
const SQRT2 = Math.SQRT2;

/**
 * Per-agent navigation scratch state. Paths are written into a preallocated
 * typed array so repathing never allocates.
 */
export class NavState {
  constructor() {
    this.path = new Float32Array(MAX_PATH_POINTS * 2);
    this.len = 0;
    this.idx = 0;
    this.pending = false;
    this.failed = false;
    this.sx = 0; this.sz = 0; this.tx = 0; this.tz = 0;
    this.vehicle = false;
  }
  clear() { this.len = 0; this.idx = 0; this.failed = false; }
  get done() { return this.idx >= this.len; }
}

/**
 * Automatically generated navigation grid covering the whole map, with
 * separate walkability layers for infantry and ground vehicles, budgeted A*
 * and string-pulled paths.
 */
export class NavigationSystem {
  /** @param {import('../world/map-generator.js').GameMap} map */
  constructor(map) {
    const { size, navCell, waterLevel } = CONFIG.world;
    this.terrain = map.terrain;
    this.cell = navCell;
    this.n = Math.round(size / navCell);
    this.half = size / 2;
    const count = this.n * this.n;
    this.terrainI = new Uint8Array(count);
    this.terrainV = new Uint8Array(count);
    this.propI = new Uint8Array(count);
    this.propV = new Uint8Array(count);
    this.cost = new Float32Array(count);
    this.costV = new Float32Array(count);

    // A* scratch (allocated once).
    this._g = new Float32Array(count);
    this._f = new Float32Array(count);
    this._from = new Int32Array(count);
    this._stamp = new Uint32Array(count);
    this._closed = new Uint32Array(count);
    this._search = 0;
    this._heap = new Int32Array(count * 2);
    this._heapLen = 0;
    this._cells = new Int32Array(4096);
    /** @type {NavState[]} */
    this._queue = [];

    const t = this.terrain, n = this.n;
    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        const i = cz * n + cx;
        const x = this.cx(cx), z = this.cx(cz);
        const h = t.height(x, z);
        const s = Math.max(
          Math.abs(h - t.height(x + navCell, z)), Math.abs(h - t.height(x - navCell, z)),
          Math.abs(h - t.height(x, z + navCell)), Math.abs(h - t.height(x, z - navCell))) / navCell;
        const border = cx < 2 || cz < 2 || cx >= n - 2 || cz >= n - 2;
        this.terrainI[i] = border || h < waterLevel + 0.15 || s > 0.9 ? 1 : 0;
        this.terrainV[i] = border || h < waterLevel + 0.5 || s > 0.5 ? 1 : 0;
        const road = t.roadAt(x, z);
        this.cost[i] = 1 + s * 2.5 - road * 0.25;
        this.costV[i] = 1 + s * 6 - road * 0.6;
      }
    }
    for (const p of map.props) this.stampProp(p, 1);
  }

  /** Cell index -> world coordinate of its centre. */
  cx(c) { return -this.half + (c + 0.5) * this.cell; }
  toCell(v) { return clamp(Math.floor((v + this.half) / this.cell), 0, this.n - 1); }

  /**
   * Adds (+1) or removes (-1) a prop's footprint from the walkability layers.
   * @param {import('../world/map-generator.js').Prop} p
   */
  stampProp(p, sign) {
    const infantry = p.type === 'wall' || (p.type === 'rock' && p.r > 1.3);
    const reach = (p.r || Math.max(p.hx, p.hz)) + 3.5;
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    const c0x = this.toCell(p.x - reach), c1x = this.toCell(p.x + reach);
    const c0z = this.toCell(p.z - reach), c1z = this.toCell(p.z + reach);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const dx = this.cx(cx) - p.x, dz = this.cx(cz) - p.z;
        let d;
        if (p.r > 0) d = Math.hypot(dx, dz) - p.r;
        else {
          const lx = Math.abs(dx * c - dz * s) - p.hx, lz = Math.abs(dx * s + dz * c) - p.hz;
          d = Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
        }
        const i = cz * this.n + cx;
        if (infantry && d < 1.3) this.propI[i] += sign;
        if (d < 2.6) this.propV[i] += sign;
      }
    }
  }

  blockedCell(i, vehicle) {
    return vehicle ? (this.terrainV[i] | this.propV[i]) !== 0 : (this.terrainI[i] | this.propI[i]) !== 0;
  }
  blocked(x, z, vehicle = false) {
    return this.blockedCell(this.toCell(z) * this.n + this.toCell(x), vehicle);
  }

  /** Straight-line walkability test, sampled every half cell. */
  lineClear(ax, az, bx, bz, vehicle) {
    const dx = bx - ax, dz = bz - az;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (this.cell * 0.5)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (this.blocked(ax + dx * t, az + dz * t, vehicle)) return false;
    }
    return true;
  }

  /** Nearest free cell index by expanding rings, or -1. */
  nearestFree(x, z, vehicle, maxRing = 8) {
    const n = this.n, cx = this.toCell(x), cz = this.toCell(z);
    if (!this.blockedCell(cz * n + cx, vehicle)) return cz * n + cx;
    for (let r = 1; r <= maxRing; r++) {
      let best = -1, bestD = 1e9;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x2 = cx + dx, z2 = cz + dz;
          if (x2 < 0 || z2 < 0 || x2 >= n || z2 >= n) continue;
          const i = z2 * n + x2;
          if (this.blockedCell(i, vehicle)) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * Queues an asynchronous path request; results land in `nav` within a few frames.
   * @param {NavState} nav
   */
  request(nav, sx, sz, tx, tz, vehicle = false) {
    nav.sx = sx; nav.sz = sz; nav.tx = tx; nav.tz = tz; nav.vehicle = vehicle;
    if (!nav.pending) {
      nav.pending = true;
      this._queue.push(nav);
    }
  }

  /** Processes queued requests within a per-frame count and time budget. */
  update() {
    let budget = CONFIG.ai.pathsPerFrame;
    const deadline = performance.now() + CONFIG.ai.pathBudgetMs;
    let first = true;
    while (budget-- > 0 && this._queue.length && (first || performance.now() < deadline)) {
      first = false;
      const nav = /** @type {NavState} */ (this._queue.shift());
      nav.pending = false;
      nav.len = this.findPath(nav.sx, nav.sz, nav.tx, nav.tz, nav.vehicle, nav.path);
      nav.idx = 0;
      nav.failed = nav.len === 0;
    }
  }

  _push(i) {
    const heap = this._heap, f = this._f;
    let k = this._heapLen++;
    heap[k] = i;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (f[heap[parent]] <= f[heap[k]]) break;
      const tmp = heap[parent]; heap[parent] = heap[k]; heap[k] = tmp;
      k = parent;
    }
  }
  _pop() {
    const heap = this._heap, f = this._f;
    const top = heap[0];
    const last = heap[--this._heapLen];
    let k = 0;
    const len = this._heapLen;
    heap[0] = last;
    for (;;) {
      const l = 2 * k + 1, r = l + 1;
      let m = k;
      if (l < len && f[heap[l]] < f[heap[m]]) m = l;
      if (r < len && f[heap[r]] < f[heap[m]]) m = r;
      if (m === k) break;
      const tmp = heap[m]; heap[m] = heap[k]; heap[k] = tmp;
      k = m;
    }
    return top;
  }

  /**
   * Synchronous A* + string pulling.
   * @param {Float32Array} out  receives x,z pairs
   * @returns {number} number of points written (0 = no path)
   */
  findPath(sx, sz, tx, tz, vehicle, out) {
    const n = this.n;
    const start = this.nearestFree(sx, sz, vehicle);
    const goal = this.nearestFree(tx, tz, vehicle, 12);
    if (start < 0 || goal < 0) return 0;
    const maxPts = out.length >> 1;
    if (start === goal) { out[0] = tx; out[1] = tz; return 1; }
    // Short, unobstructed trips need no search at all.
    if ((sx - tx) ** 2 + (sz - tz) ** 2 < 70 * 70 && !this.blocked(tx, tz, vehicle) && this.lineClear(sx, sz, tx, tz, vehicle)) {
      out[0] = tx; out[1] = tz; return 1;
    }

    const search = ++this._search;
    const g = this._g, f = this._f, from = this._from, stamp = this._stamp, closed = this._closed;
    const cost = vehicle ? this.costV : this.cost;
    const gx = goal % n, gz = (goal / n) | 0;
    this._heapLen = 0;
    g[start] = 0; f[start] = 0; from[start] = -1; stamp[start] = search;
    this._push(start);
    let found = false, expansions = 0;
    const heapCap = this._heap.length - 9;

    while (this._heapLen > 0 && expansions++ < 14000 && this._heapLen < heapCap) {
      const cur = this._pop();
      if (cur === goal) { found = true; break; }
      if (closed[cur] === search) continue;
      closed[cur] = search;
      const cx = cur % n, cz = (cur / n) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const x2 = cx + dx, z2 = cz + dz;
          if (x2 < 0 || z2 < 0 || x2 >= n || z2 >= n) continue;
          const ni = z2 * n + x2;
          if (closed[ni] === search || this.blockedCell(ni, vehicle)) continue;
          const diag = dx !== 0 && dz !== 0;
          if (diag && (this.blockedCell(cz * n + x2, vehicle) || this.blockedCell(z2 * n + cx, vehicle))) continue;
          const ng = g[cur] + (diag ? SQRT2 : 1) * cost[ni];
          if (stamp[ni] === search && ng >= g[ni]) continue;
          stamp[ni] = search;
          g[ni] = ng;
          from[ni] = cur;
          const hx = Math.abs(x2 - gx), hz = Math.abs(z2 - gz);
          f[ni] = ng + (Math.max(hx, hz) + (SQRT2 - 1) * Math.min(hx, hz)) * 0.75;
          this._push(ni);
        }
      }
    }
    if (!found) return 0;

    // Reconstruct (reversed) then greedily string-pull.
    const cells = this._cells;
    let count = 0;
    for (let c = goal; c !== -1 && count < cells.length; c = from[c]) cells[count++] = c;
    let written = 0;
    let i = count - 1;
    while (i > 0 && written < maxPts - 1) {
      const ax = this.cx(cells[i] % n), az = this.cx((cells[i] / n) | 0);
      let j = Math.max(0, i - 14);
      for (; j < i - 1; j++) {
        if (this.lineClear(ax, az, this.cx(cells[j] % n), this.cx((cells[j] / n) | 0), vehicle)) break;
      }
      out[written * 2] = this.cx(cells[j] % n);
      out[written * 2 + 1] = this.cx((cells[j] / n) | 0);
      written++;
      i = j;
    }
    // Snap the final point to the exact target when it is reachable.
    if (written > 0 && !this.blocked(tx, tz, vehicle)) {
      out[(written - 1) * 2] = tx;
      out[(written - 1) * 2 + 1] = tz;
    }
    return written;
  }
}
