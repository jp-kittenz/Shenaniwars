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
 * Vehicle path cost added per cell by clearance (cells to the nearest static vehicle obstacle, capped at 3):
 * routes run down the middle of streets, gates and gaps instead of skimming walls, so a hull following the
 * path has room to turn without clipping the corner it is rounding.
 */
const CLR_PEN = [0, 1.6, 0.55, 0];

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
    /** The last search ran out of budget or was cut off: the path ends short of the target (not an arrival). */
    this.partial = false;
    this.sx = 0; this.sz = 0; this.tx = 0; this.tz = 0;
    this.vehicle = false;
    /** Dynamic-obstacle key of the vehicle this path is for (its own parked footprint is ignored), or -1. */
    this.ignore = -1;
  }
  clear() { this.len = 0; this.idx = 0; this.failed = false; this.partial = false; }
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
    /** Whether the last findPath() returned a partial path. */
    this._partial = false;
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
    /** Dynamic vehicle obstacles (parked / waiting vehicles, wrecks, recent jam spots): counts per cell. */
    this.dynV = new Uint8Array(count);
    /** Parked vehicles for infantry: their hulls (plus a step), so paths go round them, not into them. */
    this.dynI = new Uint8Array(count);
    /** @type {Map<number, {x:number, z:number, yaw:number, hx:number, hz:number, until:number}>} */
    this.dyn = new Map();
    /** Clearance of each cell from static vehicle obstacles (cells, capped at 3); see CLR_PEN. */
    this.clrV = new Uint8Array(count);
    this._clrReady = false;
    for (const p of map.props) this.stampProp(p, 1);
    /** Decks (bridge, piers, covered passages): cells made walkable over water / trenches. */
    this.deck = new Uint8Array(count);
    /** Doorways (true centre, normal, carve half-width) for threading infantry paths through the opening. */
    this.portals = [];
    /** Optional exact line test against the physical world (set by the game): (ax, az, bx, bz) => clear. */
    this.rayClear = null;
    /** Doorways carved through building walls for infantry. */
    this.carve = new Uint8Array(count);
    for (const b of map.buildings || []) this.stampBuilding(b, 1);
    this._clearance(0, 0, this.n - 1, this.n - 1);
    this._clrReady = true;
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
    this.stats = { searches: 0, corridor: 0, partial: 0, failed: 0, crossWater: 0 };
    this._labelLandmasses(map, waterLevel);
  }

  /**
   * Landmasses: connected land (terrain above the waterline, plus decks: piers, the bridge), labelled once at
   * load. A path between different landmasses (the mainland and the island NOVEMBER) is refused at once
   * instead of searching the whole map; the planners send aircraft there instead. Ids: 0 water, 1.. land;
   * names: the largest is 'mainland', the one under the NOVEMBER objective 'island_november'.
   */
  _labelLandmasses(map, waterLevel) {
    const n = this.n, count = n * n, lab = (this.land = new Uint16Array(count));
    const q = new Int32Array(count), sizes = [0];
    for (let s = 0; s < count; s++) {
      if (lab[s] || (this.terrainI[s] && !this.deck[s] && this.terrain.baseHeight(this.cx(s % n), this.cx((s / n) | 0)) < waterLevel + 0.15)) continue;
      const id = sizes.length;
      let h = 0, t = 0, size = 0;
      q[t++] = s; lab[s] = id;
      while (h < t) {
        const c = q[h++]; size++;
        const x = c % n, z = (c / n) | 0;
        for (let k = 0; k < 4; k++) {
          const x2 = x + (k === 0 ? 1 : k === 1 ? -1 : 0), z2 = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (x2 < 0 || z2 < 0 || x2 >= n || z2 >= n) continue;
          const ni = z2 * n + x2;
          if (lab[ni]) continue;
          if (!this.deck[ni] && this.terrain.baseHeight(this.cx(x2), this.cx(z2)) < waterLevel + 0.15) continue;
          lab[ni] = id; q[t++] = ni;
        }
      }
      sizes.push(size);
      if (sizes.length > 60000) break;
    }
    let main = 1; for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;
    /** @type {Record<number, string>} */
    this.landNames = { 0: 'water', [main]: 'mainland' };
    for (const f of map.flags || []) {
      const id = this.landmassAt(f.x, f.z);
      if (f.kind === 'island-november' && id !== main) this.landNames[id] = 'island_november';
      f.landmassId = this.landNames[id] || `landmass_${id}`;
    }
  }

  /** Landmass label at a point (0: water), from the nearest land cell within a few metres. */
  landmassAt(x, z) {
    const n = this.n, cx = this.toCell(x), cz = this.toCell(z);
    for (let r = 0; r <= 3; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const x2 = cx + dx, z2 = cz + dz;
      if (x2 < 0 || z2 < 0 || x2 >= n || z2 >= n) continue;
      const id = this.land[z2 * n + x2];
      if (id) return id;
    }
    return 0;
  }

  /** Can one walk / drive between the two points without crossing open water? */
  sameLandmass(ax, az, bx, bz) {
    const a = this.landmassAt(ax, az), b = this.landmassAt(bx, bz);
    return a === 0 || b === 0 || a === b;
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
      if (this._clrReady) this._clearance(c0x, c0z, c1x, c1z);
      return;
    }
    // Ground markings and other flat structures: nothing to stamp.
    if (b.nonav) return;
    // Vehicles: the whole footprint plus a margin (watchtowers: their ladder sticks out at the back). Drive-in
    // garages: only their walls (with a margin), so vehicles can drive into the bays.
    const mz = b.roof === 'open' ? 4.6 : 2.4;
    if (!b.drive) for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      local(cx, cz, L);
      if (Math.abs(L.x) - b.w / 2 < 2.4 && Math.abs(L.z) - b.d / 2 < mz) this.propV[cz * n + cx] += sign;
    }
    if (b.drive) {
      for (const p of buildingParts(b)) {
        if ((p.k !== K.WALL && p.k !== K.PILLAR) || p.y - p.hy > 1.5) continue;
        const reach = Math.max(p.hx, p.hz) + 2;
        const wx = b.x + p.x * c + p.z * sn, wz = b.z - p.x * sn + p.z * c;
        for (let cz = this.toCell(wz - reach); cz <= this.toCell(wz + reach); cz++) for (let cx = this.toCell(wx - reach); cx <= this.toCell(wx + reach); cx++) {
          local(cx, cz, L);
          const ex = Math.max(0, Math.abs(L.x - p.x) - p.hx), ez = Math.max(0, Math.abs(L.z - p.z) - p.hz);
          if (ex * ex + ez * ez < 1.3 * 1.3) this.propV[cz * n + cx] += sign;
        }
      }
    }
    // Infantry: the actual ground-floor walls and pillars of the current state, doorways carved open.
    // A cell is blocked when its centre lies within half a cell (projected on the wall's dominant axis) of the
    // wall: every column of cells along the wall then gets one, so the barrier has no gaps however a thin wall
    // falls between cell centres (at 0.6 m, whole walls lying ~1 m from the nearest centres went missing).
    const reachN = (this.cell / 2) * Math.max(Math.abs(c), Math.abs(sn)) + 0.05;
    const parts = buildingParts(b);
    for (const p of parts) {
      if ((p.k !== K.WALL && p.k !== K.PILLAR) || p.rx || p.rz) continue;
      if (p.y - p.hy > 1.2 || p.y + p.hy < 0.45) continue;
      const reach = Math.max(p.hx, p.hz) + 1.5;
      const wx = b.x + p.x * c + p.z * sn, wz = b.z - p.x * sn + p.z * c;
      for (let cz = this.toCell(wz - reach); cz <= this.toCell(wz + reach); cz++) for (let cx = this.toCell(wx - reach); cx <= this.toCell(wx + reach); cx++) {
        local(cx, cz, L);
        const ex = Math.max(0, Math.abs(L.x - p.x) - p.hx), ez = Math.max(0, Math.abs(L.z - p.z) - p.hz);
        if (ex * ex + ez * ez < reachN * reachN) this.propI[cz * n + cx] += sign;
      }
    }
    // Doorways: carve a passage at least two cells wide through the wall (a one-cell line would be
    // impassable on rotated buildings, where it runs diagonally and corner cutting is not allowed).
    if (sign < 0) this.portals = this.portals.filter((p) => p.b !== b.id);
    for (const pt of buildingPortals(b)) {
      // (a wide opening, a garage bay's door, is carved only within its own jambs: carved wider, it cut through the
      // front ends of the walls between the bays and paths ran bay-to-bay through them)
      const tx = -pt.nz, tz = pt.nx, halfT = Math.max(1.7, pt.w >= 5 ? pt.w / 2 - 1.1 : pt.w / 2 + 0.8), halfN = 2.2;
      const px = b.x + pt.x * c + pt.z * sn, pz = b.z - pt.x * sn + pt.z * c;
      // The true opening (world centre and normal): paths are threaded through it (see _threadDoors).
      if (sign > 0) this.portals.push({ b: b.id, x: px, z: pz, nx: pt.nx * c + pt.nz * sn, nz: -pt.nx * sn + pt.nz * c, hw: halfT });
      const reach = halfT + halfN;
      // Exterior doors open through their own wall only; partition doorways stay inside the outer walls
      // (a passage beside a side wall used to cut straight through that wall).
      const exterior = Math.abs(pt.z) > b.d / 2 - 0.5 || Math.abs(pt.x) > b.w / 2 - 0.5;
      for (let cz = this.toCell(pz - reach); cz <= this.toCell(pz + reach); cz++) for (let cx = this.toCell(px - reach); cx <= this.toCell(px + reach); cx++) {
        local(cx, cz, L);
        const dx = L.x - pt.x, dz = L.z - pt.z;
        if (Math.abs(dx * tx + dz * tz) >= halfT || Math.abs(dx * pt.nx + dz * pt.nz) >= halfN) continue;
        // Never through a perpendicular outer wall: along the door's own wall, stay within the footprint.
        // (keep clear of the whole band of cells that represents an outer wall: half a cell plus a margin)
        const inX = Math.abs(L.x) < b.w / 2 - 1.1, inZ = Math.abs(L.z) < b.d / 2 - 1.1;
        if (!exterior ? !(inX && inZ) : pt.nx === 0 ? !inX : !inZ) continue;
        this.carve[cz * n + cx] += sign;
      }
    }
    this._dirty(b.x, b.z, r);
    if (this._clrReady) this._clearance(c0x, c0z, c1x, c1z);
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
    if (this._clrReady) this._clearance(c0x, c0z, c1x, c1z);
  }

  /** Static vehicle obstacle (terrain, water, props, buildings; not the dynamic layer). */
  _staticV(i) { return (this.terrainV[i] !== 0 && !this.deck[i]) || this.propV[i] !== 0; }

  /**
   * Recomputes vehicle clearance (Chebyshev distance in cells to a static obstacle, capped at 3) for a
   * window of cells and a 4-cell margin around it. Three in-place relaxation passes are exact up to the cap.
   */
  _clearance(c0x, c0z, c1x, c1z) {
    const n = this.n, clr = this.clrV;
    c0x = Math.max(0, c0x - 4); c0z = Math.max(0, c0z - 4); c1x = Math.min(n - 1, c1x + 4); c1z = Math.min(n - 1, c1z + 4);
    for (let z = c0z; z <= c1z; z++) for (let x = c0x; x <= c1x; x++) { const i = z * n + x; clr[i] = this._staticV(i) ? 0 : 3; }
    for (let pass = 0; pass < 3; pass++) {
      for (let z = c0z; z <= c1z; z++) {
        const z0 = Math.max(0, z - 1), z1 = Math.min(n - 1, z + 1);
        for (let x = c0x; x <= c1x; x++) {
          const i = z * n + x;
          let c = clr[i];
          if (c <= 1) continue;
          const x0 = Math.max(0, x - 1), x1 = Math.min(n - 1, x + 1);
          for (let zz = z0; zz <= z1; zz++) for (let xx = x0; xx <= x1; xx++) { const m = clr[zz * n + xx] + 1; if (m < c) c = m; }
          clr[i] = c;
        }
      }
    }
  }

  /**
   * Adds (sign +1) or removes (-1) an oriented rectangle (half extents hx × hz, obstacle margin included)
   * in the dynamic vehicle layer.
   */
  _stampDyn(x, z, yaw, hx, hz, sign, arr = this.dynV) {
    const n = this.n, c = Math.cos(yaw), s = Math.sin(yaw), r = Math.hypot(hx, hz);
    for (let cz = this.toCell(z - r); cz <= this.toCell(z + r); cz++) for (let cx = this.toCell(x - r); cx <= this.toCell(x + r); cx++) {
      const dx = this.cx(cx) - x, dz = this.cx(cz) - z;
      // Local frame: +z along the heading (sin yaw, cos yaw).
      if (Math.abs(dx * c - dz * s) > hx || Math.abs(dx * s + dz * c) > hz) continue;
      const i = cz * n + cx;
      arr[i] = Math.max(0, arr[i] + sign);
    }
    this._dirty(x, z, r);
  }
  _stampDynI(o, sign) { if (o.ihx > 0) this._stampDyn(o.x, o.z, o.yaw, o.ihx, o.ihz, sign, this.dynI); }

  /**
   * Places (or moves) a keyed dynamic obstacle for ground-vehicle planning: a parked or waiting vehicle, a
   * wreck, or a spot where a vehicle just jammed (with an expiry time). Re-stamps only when it moved.
   */
  setDyn(key, x, z, yaw, hx, hz, until = Infinity, ihx = 0, ihz = 0) {
    const o = this.dyn.get(key);
    if (o) {
      o.until = until;
      if (Math.abs(o.x - x) < 0.6 && Math.abs(o.z - z) < 0.6 && Math.abs(o.yaw - yaw) < 0.08 && o.hx === hx && o.hz === hz && o.ihx === ihx) return;
      this._stampDyn(o.x, o.z, o.yaw, o.hx, o.hz, -1); this._stampDynI(o, -1);
      o.x = x; o.z = z; o.yaw = yaw; o.hx = hx; o.hz = hz; o.ihx = ihx; o.ihz = ihz;
      this._stampDyn(x, z, yaw, hx, hz, 1); this._stampDynI(o, 1);
      return;
    }
    const n = { x, z, yaw, hx, hz, until, ihx, ihz };
    this.dyn.set(key, n);
    this._stampDyn(x, z, yaw, hx, hz, 1); this._stampDynI(n, 1);
  }
  clearDyn(key) {
    const o = this.dyn.get(key);
    if (!o) return;
    this._stampDyn(o.x, o.z, o.yaw, o.hx, o.hz, -1); this._stampDynI(o, -1);
    this.dyn.delete(key);
  }
  /** Drops expired dynamic obstacles (jam marks). */
  expireDyn(time) {
    for (const [k, o] of this.dyn) if (o.until < time) this.clearDyn(k);
  }

  blockedCell(i, vehicle) {
    const water = vehicle ? this.terrainV[i] : this.terrainI[i];
    return vehicle ? ((water && !this.deck[i]) || this.propV[i] !== 0 || this.dynV[i] !== 0) : ((water && !this.deck[i]) || (this.propI[i] !== 0 && this.carve[i] === 0) || this.dynI[i] !== 0);
  }
  blocked(x, z, vehicle = false) {
    return this.blockedCell(this.toCell(z) * this.n + this.toCell(x), vehicle);
  }

  /** Straight-line walkability test, sampled every half cell. */
  lineClear(ax, az, bx, bz, vehicle, minClr = 0) {
    // Exact traversal of every cell the segment crosses (Amanatides-Woo). Passing through a cell corner
    // needs both side cells free: the same no-corner-cutting rule as the path search. Sampling the line every
    // metre let string-pulled paths slip between two diagonally touching wall cells, i.e. through the walls of
    // rotated buildings.
    const n = this.n, inv = 1 / this.cell;
    const x = (ax + this.half) * inv, z = (az + this.half) * inv;
    const ex = (bx + this.half) * inv, ez = (bz + this.half) * inv;
    let cx = clamp(Math.floor(x), 0, n - 1), cz = clamp(Math.floor(z), 0, n - 1);
    const tx = clamp(Math.floor(ex), 0, n - 1), tz = clamp(Math.floor(ez), 0, n - 1);
    const dx = ex - x, dz = ez - z, sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = dx > 0 ? (cx + 1 - x) * tdx : dx < 0 ? (x - cx) * tdx : Infinity;
    let tmz = dz > 0 ? (cz + 1 - z) * tdz : dz < 0 ? (z - cz) * tdz : Infinity;
    for (let guard = 0; (cx !== tx || cz !== tz) && guard < 4 * n; guard++) {
      if (Math.abs(tmx - tmz) < 1e-9) {
        if (this.blockedCell(cz * n + cx + sx, vehicle) || this.blockedCell((cz + sz) * n + cx, vehicle)) return false;
        if (minClr && (this.clrV[cz * n + cx + sx] < minClr || this.clrV[(cz + sz) * n + cx] < minClr)) return false;
        cx += sx; cz += sz; tmx += tdx; tmz += tdz;
      } else if (tmx < tmz) { cx += sx; tmx += tdx; } else { cz += sz; tmz += tdz; }
      if (cx < 0 || cz < 0 || cx >= n || cz >= n) return false;
      if (this.blockedCell(cz * n + cx, vehicle)) return false;
      if (minClr && this.clrV[cz * n + cx] < minClr) return false;
    }
    return true;
  }

  /** Nearest free cell index by expanding rings, or -1. */
  nearestFree(x, z, vehicle, maxRing = 12) {
    const n = this.n, cx = this.toCell(x), cz = this.toCell(z);
    if (!this.blockedCell(cz * n + cx, vehicle)) return cz * n + cx;
    // Standing in a wall's band of cells (right beside a wall, inside or out): take the nearest free cell on the
    // same side of the real wall (physics ray), not one through it.
    if (this.rayClear) {
      let rays = 0;
      for (let r = 1; r <= 2 && rays < 10; r++) {
        let best = -1, bestD = 1e9;
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x2 = cx + dx, z2 = cz + dz;
          if (x2 < 0 || z2 < 0 || x2 >= n || z2 >= n) continue;
          const i = z2 * n + x2, d = dx * dx + dz * dz;
          if (d >= bestD || this.blockedCell(i, vehicle) || rays >= 10) continue;
          rays++;
          if (!this.rayClear(x, z, this.cx(x2), this.cx(z2))) continue;
          bestD = d; best = i;
        }
        if (best >= 0) return best;
      }
    }
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
      // A vehicle's own parked footprint is not an obstacle to its own route out.
      const own = nav.vehicle && nav.ignore >= 0 ? this.dyn.get(nav.ignore) : null;
      if (own) this._stampDyn(own.x, own.z, own.yaw, own.hx, own.hz, -1);
      nav.len = this.findPath(nav.sx, nav.sz, nav.tx, nav.tz, nav.vehicle, nav.path);
      if (own) this._stampDyn(own.x, own.z, own.yaw, own.hx, own.hz, 1);
      nav.idx = 0;
      nav.failed = nav.len === 0;
      nav.partial = this._partial && nav.len > 0;
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
  findPath(sx, sz, tx, tz, vehicle, out, noCorr = false) {
    const n = this.n;
    this._partial = false;
    const start = this.nearestFree(sx, sz, vehicle);
    const goal = this.nearestFree(tx, tz, vehicle, 18);
    if (start < 0 || goal < 0) return 0;
    // Across open water (another landmass): no ground route, refused without a search.
    const ls = this.land[start], lg = this.land[goal];
    if (ls && lg && ls !== lg) { this.stats.crossWater++; return 0; }
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
    const useCorr = long && !noCorr && this._corridor(start, goal, vehicle);
    if (useCorr) this.stats.corridor++;
    const corr = this._corr, corrMark = this._corrMark, rn = this.rn;
    const search = ++this._search;
    const g = this._g, f = this._f, from = this._from, stamp = this._stamp, closed = this._closed;
    const cost = vehicle ? this.costV : this.cost, clr = this.clrV;
    const gx = goal % n, gz = (goal / n) | 0;
    // Slightly greedy heuristic on long searches: near-optimal paths at a fraction of the expansions.
    const hw = long ? 1.15 : 0.75;
    this._heapLen = 0;
    g[start] = 0; f[start] = 0; from[start] = -1; stamp[start] = search;
    this._push(start);
    let found = false, expansions = 0, bestNode = start, bestH = 1e9;
    const heapCap = this._heap.length - 9;

    const budget = noCorr ? 140000 : 40000;
    while (this._heapLen > 0 && expansions++ < budget && this._heapLen < heapCap) {
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
          const ng = g[cur] + (diag ? SQRT2 : 1) * (vehicle ? cost[ni] + CLR_PEN[clr[ni]] : cost[ni]);
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
    // The region graph can be wrong next to thin walls (a region straddling the base wall made the corridor go
    // through it, and vehicles parked behind the garages drove into the wall): retry once without the corridor.
    if (!found && useCorr) { this.stats.corridorRetries = (this.stats.corridorRetries || 0) + 1; return this.findPath(sx, sz, tx, tz, vehicle, out, true); }
    if (!found) {
      if (bestNode === start) { this.stats.failed++; return 0; }
      endCell = bestNode; this.stats.partial++; this._partial = true;
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
        // Vehicles: a shortcut may not pass closer to obstacles than the searched route it replaces.
        let need = 0;
        if (vehicle) { need = 3; for (let k = j; k <= i && need > 0; k++) need = Math.min(need, clr[cells[k]]); }
        if (this.lineClear(ax, az, this.cx(cells[j] % n), this.cx((cells[j] / n) | 0), vehicle, need)) break;
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
    if (!vehicle && written > 0) written = this._threadDoors(sx, sz, out, written, maxPts);
    return written;
  }

  /**
   * The grid's doorway passage is two cells wide, the real door 1.2 m: a path that just goes to a cell
   * centre in the doorway meets the door frame at an angle and the soldier jams there. Every segment that
   * crosses a doorway's wall inside its carved passage gets two points inserted, 1.2 m either side of the
   * true opening on its axis, so the soldier walks straight through the middle.
   */
  _threadDoors(sx, sz, out, written, maxPts) {
    const P = this.portals;
    let ax = sx, az = sz;
    for (let i = 0; i < written; i++) {
      const bx = out[i * 2], bz = out[i * 2 + 1];
      const minX = Math.min(ax, bx) - 3, maxX = Math.max(ax, bx) + 3, minZ = Math.min(az, bz) - 3, maxZ = Math.max(az, bz) + 3;
      for (let k = 0; k < P.length; k++) {
        const p = P[k];
        if (p.x < minX || p.x > maxX || p.z < minZ || p.z > maxZ) continue;
        const s0 = (ax - p.x) * p.nx + (az - p.z) * p.nz, s1 = (bx - p.x) * p.nx + (bz - p.z) * p.nz;
        if (s0 * s1 >= 0) continue;
        const t = s0 / (s0 - s1), ix = ax + (bx - ax) * t, iz = az + (bz - az) * t;
        if (Math.abs((ix - p.x) * -p.nz + (iz - p.z) * p.nx) > p.hw + 0.3) continue;
        if (written + 2 > maxPts) return written;
        for (let j = written - 1; j >= i; j--) { out[(j + 2) * 2] = out[j * 2]; out[(j + 2) * 2 + 1] = out[j * 2 + 1]; }
        const sd = s0 > 0 ? 1 : -1;
        out[i * 2] = p.x + p.nx * sd * 1.2; out[i * 2 + 1] = p.z + p.nz * sd * 1.2;
        out[i * 2 + 2] = p.x - p.nx * sd * 1.2; out[i * 2 + 3] = p.z - p.nz * sd * 1.2;
        written += 2;
        i += 2;
        break;
      }
      ax = out[i * 2]; az = out[i * 2 + 1];
    }
    return written;
  }
}
