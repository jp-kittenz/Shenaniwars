import { CONFIG } from '../core/config.js';
import { clamp } from '../core/math.js';
import { K, buildingParts, buildingPortals } from '../world/buildings.js';

const MAX_PATH_POINTS = 48;
const SQRT2 = Math.SQRT2;
/** Navigation regions: REG×REG cells (32 m) with connectivity between neighbours, for corridor-restricted search. */
const REG = 16;
/** Searches longer than this (cells, Chebyshev) are routed through the region graph first. */
const LONG = 48;
/** Props that infantry cannot walk through (others are stepped around by push-out alone). */
const INFANTRY_BLOCK = new Set(['wall', 'container', 'silo', 'fueltank', 'tankwreck', 'truckwreck', 'crane', 'samsite', 'tractor', 'harvester', 'well', 'carwreck', 'car', 'radar']);
/** Props that block neither layer. */
const NO_NAV = new Set(['bush', 'streetlight', 'pole']);
/** Kerbside clutter (parked cars, wrecks, benches): a tighter vehicle margin so streets stay drivable. */
const KERBSIDE = new Set(['car', 'carwreck', 'bench', 'debris']);
/** Props vehicles simply drive through (they are crushed). */
const CRUSHABLE = new Set(['fence', 'crate']);

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
        const h = t.baseHeight(x, z);
        const s = Math.max(
          Math.abs(h - t.baseHeight(x + navCell, z)), Math.abs(h - t.baseHeight(x - navCell, z)),
          Math.abs(h - t.baseHeight(x, z + navCell)), Math.abs(h - t.baseHeight(x, z - navCell))) / navCell;
        const border = cx < 2 || cz < 2 || cx >= n - 2 || cz >= n - 2;
        this.terrainI[i] = border || h < waterLevel + 0.15 || s > 0.9 ? 1 : 0;
        // Vehicles: nothing steeper than ~22°, and gentle ground / roads strongly preferred.
        this.terrainV[i] = border || h < waterLevel + 0.5 || s > 0.4 ? 1 : 0;
        const road = t.roadAt(x, z);
        this.cost[i] = 1 + s * 2.5 - road * 0.25;
        this.costV[i] = 1 + s * 14 - road * 0.6;
      }
    }
    for (const p of map.props) this.stampProp(p, 1);
    /** Decks (bridge, piers, covered passages): cells made walkable over water / trenches. */
    this.deck = new Uint8Array(count);
    /** Doorways carved through building walls for infantry. */
    this.carve = new Uint8Array(count);
    for (const b of map.buildings || []) this.stampBuilding(b, 1);
    // Region graph (per layer): open flag + 4-neighbour links; recomputed lazily where the world changes.
    this.rn = Math.ceil(this.n / REG);
    const rc = this.rn * this.rn;
    this.regOpen = [new Uint8Array(rc), new Uint8Array(rc)];
    this.regLink = [new Uint8Array(rc), new Uint8Array(rc)]; // bits: 1 +x, 2 -x, 4 +z, 8 -z
    this.regDirty = new Uint8Array(rc).fill(1);
    this._corr = new Uint32Array(rc);
    this._rg = new Float32Array(rc); this._rf = new Float32Array(rc); this._rfrom = new Int32Array(rc);
    this._rstamp = new Uint32Array(rc); this._rclosed = new Uint32Array(rc); this._rsearch = 0;
    this._rheap = new Int32Array(rc * 4); this._rheapLen = 0;
    this.stats = { searches: 0, corridor: 0, partial: 0, failed: 0 };
  }

  /** Marks the regions touched by a change around (x, z) within r metres for recomputation. */
  _dirty(x, z, r) {
    if (!this.regDirty) return;
    const c0x = this.toCell(x - r), c1x = this.toCell(x + r), c0z = this.toCell(z - r), c1z = this.toCell(z + r);
    for (let rz = Math.floor(c0z / REG); rz <= Math.floor(c1z / REG); rz++) {
      for (let rx = Math.floor(c0x / REG); rx <= Math.floor(c1x / REG); rx++) {
        for (const [ax, az] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const x2 = rx + ax, z2 = rz + az;
          if (x2 >= 0 && z2 >= 0 && x2 < this.rn && z2 < this.rn) this.regDirty[z2 * this.rn + x2] = 1;
        }
      }
    }
  }

  /** Recomputes open flags and links of a region for both layers. */
  _region(ri) {
    this.regDirty[ri] = 0;
    const rn = this.rn, n = this.n, rx = ri % rn, rz = (ri / rn) | 0;
    const x0 = rx * REG, z0 = rz * REG, x1 = Math.min(n, x0 + REG), z1 = Math.min(n, z0 + REG);
    for (let layer = 0; layer < 2; layer++) {
      const veh = layer === 1;
      let free = 0, link = 0;
      for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) if (!this.blockedCell(z * n + x, veh)) free++;
      // A link exists when some border cell pair is walkable on both sides.
      if (x1 < n) for (let z = z0; z < z1; z++) if (!this.blockedCell(z * n + x1 - 1, veh) && !this.blockedCell(z * n + x1, veh)) { link |= 1; break; }
      if (x0 > 0) for (let z = z0; z < z1; z++) if (!this.blockedCell(z * n + x0, veh) && !this.blockedCell(z * n + x0 - 1, veh)) { link |= 2; break; }
      if (z1 < n) for (let x = x0; x < x1; x++) if (!this.blockedCell((z1 - 1) * n + x, veh) && !this.blockedCell(z1 * n + x, veh)) { link |= 4; break; }
      if (z0 > 0) for (let x = x0; x < x1; x++) if (!this.blockedCell(z0 * n + x, veh) && !this.blockedCell((z0 - 1) * n + x, veh)) { link |= 8; break; }
      this.regOpen[layer][ri] = free > 0 ? 1 : 0;
      this.regLink[layer][ri] = link;
    }
  }

  /**
   * Coarse A* over regions; marks the corridor (route regions and their
   * neighbours) with the current search stamp. Returns false if unreachable.
   */
  _corridor(sc, gc, vehicle) {
    const rn = this.rn, n = this.n, layer = vehicle ? 1 : 0;
    const rs = Math.floor((sc % n) / REG) + Math.floor(((sc / n) | 0) / REG) * rn;
    const rg = Math.floor((gc % n) / REG) + Math.floor(((gc / n) | 0) / REG) * rn;
    const search = ++this._rsearch;
    const g = this._rg, f = this._rf, from = this._rfrom, stamp = this._rstamp, closed = this._rclosed, heap = this._rheap;
    const gx = rg % rn, gz = (rg / rn) | 0;
    let len = 0;
    const push = (i) => {
      let k = len++; heap[k] = i;
      while (k > 0) { const p = (k - 1) >> 1; if (f[heap[p]] <= f[heap[k]]) break; const t = heap[p]; heap[p] = heap[k]; heap[k] = t; k = p; }
    };
    const pop = () => {
      const top = heap[0]; heap[0] = heap[--len];
      let k = 0;
      for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < len && f[heap[l]] < f[heap[m]]) m = l; if (r < len && f[heap[r]] < f[heap[m]]) m = r; if (m === k) break; const t = heap[m]; heap[m] = heap[k]; heap[k] = t; k = m; }
      return top;
    };
    g[rs] = 0; f[rs] = 0; from[rs] = -1; stamp[rs] = search; push(rs);
    let found = false;
    while (len > 0 && len < heap.length - 8) {
      const cur = pop();
      if (cur === rg) { found = true; break; }
      if (closed[cur] === search) continue;
      closed[cur] = search;
      if (this.regDirty[cur]) this._region(cur);
      const link = this.regLink[layer][cur], cx = cur % rn, cz = (cur / rn) | 0;
      for (let d = 0; d < 4; d++) {
        if (!(link & (1 << d))) continue;
        const x2 = cx + (d === 0 ? 1 : d === 1 ? -1 : 0), z2 = cz + (d === 2 ? 1 : d === 3 ? -1 : 0);
        const ni = z2 * rn + x2;
        if (closed[ni] === search) continue;
        if (this.regDirty[ni]) this._region(ni);
        const ng = g[cur] + 1;
        if (stamp[ni] === search && ng >= g[ni]) continue;
        stamp[ni] = search; g[ni] = ng; from[ni] = cur;
        f[ni] = ng + Math.abs(x2 - gx) + Math.abs(z2 - gz);
        push(ni);
      }
    }
    if (!found) return false;
    // Corridor: route regions plus one ring around them.
    const corr = this._corr, mark = ++this._search; // shares the fine search stamp space
    for (let c = rg; c !== -1; c = from[c]) {
      const cx = c % rn, cz = (c / rn) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const x2 = cx + dx, z2 = cz + dz;
        if (x2 >= 0 && z2 >= 0 && x2 < rn && z2 < rn) corr[z2 * rn + x2] = mark;
      }
    }
    this._corrMark = mark;
    return true;
  }

  /**
   * Building footprint in the navigation layers. Vehicles: the whole
   * footprint plus a margin. Infantry: the ground-floor walls and pillars of
   * the building's current damage state, with its doorways (exterior doors,
   * interior partition gaps) carved open, so agents can path inside. Decks
   * (bridge, piers, the covered part of a passage) open their cells over
   * water or trenches while they stand.
   * @param {import('../world/buildings.js').Building} b
   */
  stampBuilding(b, sign) {
    const n = this.n, c = Math.cos(b.rot), sn = Math.sin(b.rot);
    const r = Math.hypot(b.w, b.d) / 2 + 4;
    const c0x = this.toCell(b.x - r), c1x = this.toCell(b.x + r), c0z = this.toCell(b.z - r), c1z = this.toCell(b.z + r);
    const local = (cx, cz, out) => { const dx = this.cx(cx) - b.x, dz = this.cx(cz) - b.z; out.x = dx * c - dz * sn; out.z = dx * sn + dz * c; return out; };
    const L = { x: 0, z: 0 };
    if (b.deck || b.name === 'tunnel') {
      // Decks open their cells (both layers) while they stand; a tunnel's open stair wells are infantry-only.
      const on = b.state === 0;
      const ramp = b.name === 'tunnel' ? 10 : 0;
      for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
        local(cx, cz, L);
        if (Math.abs(L.x) > b.w / 2 - 0.4 || Math.abs(L.z) > b.d / 2 + (b.deck ? 1 : 0)) continue;
        const i = cz * n + cx;
        if (Math.abs(L.z) <= b.d / 2 - ramp) this.deck[i] = sign > 0 && on ? 1 : 0;
        else if (ramp > 0) this.propV[i] += sign;
      }
      this._dirty(b.x, b.z, r);
      return;
    }
    // Vehicles: the whole footprint plus a margin (watchtowers: their ladder sticks out at the back).
    const mz = b.roof === 'open' ? 4.6 : 2.4;
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      local(cx, cz, L);
      if (Math.abs(L.x) - b.w / 2 < 2.4 && Math.abs(L.z) - b.d / 2 < mz) this.propV[cz * n + cx] += sign;
    }
    // Infantry: the actual ground-floor walls and pillars of the current state, doorways carved open.
    const parts = buildingParts(b);
    for (const p of parts) {
      if ((p.k !== K.WALL && p.k !== K.PILLAR) || p.rx || p.rz) continue;
      if (p.y - p.hy > 1.2 || p.y + p.hy < 0.45) continue;
      const reach = Math.max(p.hx, p.hz) + 1.5;
      const wx = b.x + p.x * c + p.z * sn, wz = b.z - p.x * sn + p.z * c;
      for (let cz = this.toCell(wz - reach); cz <= this.toCell(wz + reach); cz++) for (let cx = this.toCell(wx - reach); cx <= this.toCell(wx + reach); cx++) {
        local(cx, cz, L);
        const ex = Math.max(0, Math.abs(L.x - p.x) - p.hx), ez = Math.max(0, Math.abs(L.z - p.z) - p.hz);
        if (ex * ex + ez * ez < 0.6 * 0.6) this.propI[cz * n + cx] += sign;
      }
    }
    // Doorways: carve a passage at least two cells wide through the wall (a one-cell line would be
    // impassable on rotated buildings, where it runs diagonally and corner cutting is not allowed).
    for (const pt of buildingPortals(b)) {
      const tx = -pt.nz, tz = pt.nx, halfT = Math.max(1.3, pt.w / 2 + 0.6), halfN = 2.2;
      const px = b.x + pt.x * c + pt.z * sn, pz = b.z - pt.x * sn + pt.z * c;
      const reach = halfT + halfN;
      for (let cz = this.toCell(pz - reach); cz <= this.toCell(pz + reach); cz++) for (let cx = this.toCell(px - reach); cx <= this.toCell(px + reach); cx++) {
        local(cx, cz, L);
        const dx = L.x - pt.x, dz = L.z - pt.z;
        if (Math.abs(dx * tx + dz * tz) < halfT && Math.abs(dx * pt.nx + dz * pt.nz) < halfN) this.carve[cz * n + cx] += sign;
      }
    }
    this._dirty(b.x, b.z, r);
  }

  /** Cell index -> world coordinate of its centre. */
  cx(c) { return -this.half + (c + 0.5) * this.cell; }
  toCell(v) { return clamp(Math.floor((v + this.half) / this.cell), 0, this.n - 1); }

  /**
   * Adds (+1) or removes (-1) a prop's footprint from the walkability layers.
   * @param {import('../world/map-generator.js').Prop} p
   */
  stampProp(p, sign) {
    if (NO_NAV.has(p.type)) return;
    const infantry = INFANTRY_BLOCK.has(p.type) || (p.type === 'rock' && p.r > 1.3);
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
        if (d < (KERBSIDE.has(p.type) ? 1.9 : 2.6) && !CRUSHABLE.has(p.type)) this.propV[i] += sign;
      }
    }
    this._dirty(p.x, p.z, reach);
  }

  blockedCell(i, vehicle) {
    const water = vehicle ? this.terrainV[i] : this.terrainI[i];
    return vehicle ? ((water && !this.deck[i]) || this.propV[i] !== 0) : ((water && !this.deck[i]) || (this.propI[i] !== 0 && this.carve[i] === 0));
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
  nearestFree(x, z, vehicle, maxRing = 12) {
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
    const goal = this.nearestFree(tx, tz, vehicle, 18);
    if (start < 0 || goal < 0) return 0;
    const maxPts = out.length >> 1;
    if (start === goal) { out[0] = tx; out[1] = tz; return 1; }
    // Short, unobstructed trips need no search at all.
    if ((sx - tx) ** 2 + (sz - tz) ** 2 < 70 * 70 && !this.blocked(tx, tz, vehicle) && this.lineClear(sx, sz, tx, tz, vehicle)) {
      out[0] = tx; out[1] = tz; return 1;
    }

    this.stats.searches++;
    // Long trips: route through the region graph first and keep the fine search inside that corridor.
    const sgx = start % n, sgz = (start / n) | 0;
    const long = Math.max(Math.abs(sgx - (goal % n)), Math.abs(sgz - ((goal / n) | 0))) > LONG;
    const useCorr = long && this._corridor(start, goal, vehicle);
    if (useCorr) this.stats.corridor++;
    const corr = this._corr, corrMark = this._corrMark, rn = this.rn;
    const search = ++this._search;
    const g = this._g, f = this._f, from = this._from, stamp = this._stamp, closed = this._closed;
    const cost = vehicle ? this.costV : this.cost;
    const gx = goal % n, gz = (goal / n) | 0;
    // Slightly greedy heuristic on long searches: near-optimal paths at a fraction of the expansions.
    const hw = long ? 1.15 : 0.75;
    this._heapLen = 0;
    g[start] = 0; f[start] = 0; from[start] = -1; stamp[start] = search;
    this._push(start);
    let found = false, expansions = 0, bestNode = start, bestH = 1e9;
    const heapCap = this._heap.length - 9;

    while (this._heapLen > 0 && expansions++ < 40000 && this._heapLen < heapCap) {
      const cur = this._pop();
      if (cur === goal) { found = true; break; }
      if (closed[cur] === search) continue;
      closed[cur] = search;
      const cx = cur % n, cz = (cur / n) | 0;
      const hcur = Math.abs(cx - gx) + Math.abs(cz - gz);
      if (hcur < bestH) { bestH = hcur; bestNode = cur; }
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const x2 = cx + dx, z2 = cz + dz;
          if (x2 < 0 || z2 < 0 || x2 >= n || z2 >= n) continue;
          const ni = z2 * n + x2;
          if (closed[ni] === search || this.blockedCell(ni, vehicle)) continue;
          if (useCorr && corr[((z2 / REG) | 0) * rn + ((x2 / REG) | 0)] !== corrMark) continue;
          const diag = dx !== 0 && dz !== 0;
          if (diag && (this.blockedCell(cz * n + x2, vehicle) || this.blockedCell(z2 * n + cx, vehicle))) continue;
          const ng = g[cur] + (diag ? SQRT2 : 1) * cost[ni];
          if (stamp[ni] === search && ng >= g[ni]) continue;
          stamp[ni] = search;
          g[ni] = ng;
          from[ni] = cur;
          const hx = Math.abs(x2 - gx), hz = Math.abs(z2 - gz);
          f[ni] = ng + (Math.max(hx, hz) + (SQRT2 - 1) * Math.min(hx, hz)) * hw;
          this._push(ni);
        }
      }
    }
    // Out of budget or cut off: walk as far as we got toward the goal; the agent re-plans from there.
    let endCell = goal;
    if (!found) {
      if (bestNode === start) { this.stats.failed++; return 0; }
      endCell = bestNode; this.stats.partial++;
    }

    // Reconstruct (reversed) then greedily string-pull.
    const cells = this._cells;
    let count = 0;
    for (let c = endCell; c !== -1 && count < cells.length; c = from[c]) cells[count++] = c;
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
    if (found && written > 0 && !this.blocked(tx, tz, vehicle)) {
      out[(written - 1) * 2] = tx;
      out[(written - 1) * 2 + 1] = tz;
    }
    return written;
  }
}
