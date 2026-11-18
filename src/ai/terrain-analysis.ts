import { StaticPointGrid } from './spatial-grid.ts';
import type { PropLike, TerrainLike } from './types.ts';

/** Threat set used to evaluate cover: positions + weights (filled per evaluation, never reallocated). */
export class ThreatSet {
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly w: Float32Array;
  count = 0;
  constructor(capacity: number) {
    this.x = new Float32Array(capacity); this.z = new Float32Array(capacity); this.w = new Float32Array(capacity);
  }
  clear(): void { this.count = 0; }
  add(x: number, z: number, w: number): void {
    if (this.count >= this.x.length) return;
    // Merge nearby threats so a fire team counts as one sightline cluster.
    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - x, dz = this.z[i] - z;
      if (dx * dx + dz * dz < 64) { this.w[i] += w; return; }
    }
    const i = this.count++;
    this.x[i] = x; this.z[i] = z; this.w[i] = w;
  }
  /** Weighted centroid into out[0], out[1]; returns total weight. */
  centroid(out: Float32Array): number {
    let sx = 0, sz = 0, sw = 0;
    for (let i = 0; i < this.count; i++) { sx += this.x[i] * this.w[i]; sz += this.z[i] * this.w[i]; sw += this.w[i]; }
    if (sw > 0) { out[0] = sx / sw; out[1] = sz / sw; }
    return sw;
  }
}

/**
 * Cover nodes generated from the map's solid props (walls, barriers, crates,
 * boulders). Each node stores its outward normal (pointing away from the
 * prop) and cover height, so a node protects against a threat when the
 * threat lies on the prop's side: dot(normal, dirToThreat) < 0.
 */
export class CoverField {
  count = 0;
  readonly x: Float32Array; readonly z: Float32Array;
  readonly nx: Float32Array; readonly nz: Float32Array;
  readonly height: Float32Array;
  readonly prop: Int32Array;
  readonly occupant: Int32Array;
  readonly reservedUntil: Float32Array;
  readonly grid: StaticPointGrid;
  private readonly props: PropLike[];

  constructor(props: PropLike[], terrain: TerrainLike, blocked: (x: number, z: number) => boolean, waterLevel = 0) {
    this.props = props;
    const cap = props.length * 6 + 16;
    const x = new Float32Array(cap), z = new Float32Array(cap), nx = new Float32Array(cap), nz = new Float32Array(cap);
    const h = new Float32Array(cap), pr = new Int32Array(cap);
    let n = 0;
    const add = (px: number, pz: number, ux: number, uz: number, height: number, id: number): void => {
      if (terrain.height(px, pz) < waterLevel + 0.3 || blocked(px, pz)) return;
      x[n] = px; z[n] = pz; nx[n] = ux; nz[n] = uz; h[n] = height; pr[n] = id; n++;
    };
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (!p.alive || p.type === 'tree') continue;
      const c = Math.cos(p.rot), s = Math.sin(p.rot);
      // Local x axis → (c, -s), local z axis → (s, c) (matches the physics push-out convention).
      if (p.type === 'wall' || p.type === 'barrier') {
        const off = p.hz + 0.8, height = p.hy * 2 - 0.15;
        for (const side of [1, -1]) {
          for (const along of [-0.5, 0.5]) {
            add(p.x + s * off * side + c * p.hx * along, p.z + c * off * side - s * p.hx * along, s * side, c * side, height, p.id);
          }
        }
      } else if (p.type === 'crate' || p.type === 'sandbag' || p.type === 'container' || p.type === 'carwreck' || p.type === 'truckwreck' ||
        p.type === 'tankwreck' || p.type === 'car' || p.type === 'haybale' || p.type === 'debris' || p.type === 'fueltank' || p.type === 'log') {
        // One node off each face (elongated props: the long faces sit further out).
        const offZ = p.hz + 0.7, off = p.hx + 0.7;
        add(p.x + s * offZ, p.z + c * offZ, s, c, p.hy * 2, p.id);
        add(p.x - s * offZ, p.z - c * offZ, -s, -c, p.hy * 2, p.id);
        add(p.x + c * off, p.z - s * off, c, -s, p.hy * 2, p.id);
        add(p.x - c * off, p.z + s * off, -c, s, p.hy * 2, p.id);
      } else if (p.type === 'rock' && p.r > 0.9) {
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          const ux = Math.cos(a), uz = Math.sin(a);
          add(p.x + ux * (p.r + 0.8), p.z + uz * (p.r + 0.8), ux, uz, p.r * 1.25, p.id);
        }
      }
    }
    this.count = n;
    this.x = x.slice(0, Math.max(1, n)); this.z = z.slice(0, Math.max(1, n));
    this.nx = nx.slice(0, Math.max(1, n)); this.nz = nz.slice(0, Math.max(1, n));
    this.height = h.slice(0, Math.max(1, n)); this.prop = pr.slice(0, Math.max(1, n));
    this.occupant = new Int32Array(Math.max(1, n)).fill(-1);
    this.reservedUntil = new Float32Array(Math.max(1, n));
    this.grid = new StaticPointGrid(terrain.size, 16, this.x, this.z, n);
  }

  valid(i: number): boolean { return this.props[this.prop[i]].alive; }
  isLow(i: number): boolean { return this.height[i] < 1.4; }

  /** Free for `id` (unreserved, reserved by it, or reservation expired). */
  available(i: number, id: number, time: number): boolean {
    const o = this.occupant[i];
    return o === -1 || o === id || this.reservedUntil[i] < time;
  }

  reserve(i: number, id: number, until: number): void { this.occupant[i] = id; this.reservedUntil[i] = until; }
  release(i: number, id: number): void { if (i >= 0 && this.occupant[i] === id) this.occupant[i] = -1; }

  /**
   * Protection of node `i` against every threat in the set: +1 for a covered
   * sightline, a partial credit for oblique ones and -1 for exposed ones,
   * weighted by threat weight. Range −1..1.
   */
  protection(i: number, threats: ThreatSet): number {
    if (threats.count === 0) return 0.3;
    const x = this.x[i], z = this.z[i], nx = this.nx[i], nz = this.nz[i];
    let sum = 0, wsum = 0;
    for (let k = 0; k < threats.count; k++) {
      let dx = threats.x[k] - x, dz = threats.z[k] - z;
      const d = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= d; dz /= d;
      const dot = nx * dx + nz * dz;
      const w = threats.w[k];
      sum += (dot < -0.35 ? 1 : dot < 0.2 ? 0.25 : -1) * w;
      wsum += w;
    }
    return wsum > 0 ? sum / wsum : 0;
  }

  /**
   * Utility of a node for a soldier at (ax, az): protection against all known
   * sightlines, travel distance, cover height and progress toward an
   * objective, minus advancing toward the threat centroid.
   * @param objWeight positive to reward progress toward (ox, oz)
   */
  score(i: number, ax: number, az: number, threats: ThreatSet, maxDist: number, ox: number, oz: number, objWeight: number,
    tcx: number, tcz: number, hasThreat: boolean): number {
    const x = this.x[i], z = this.z[i];
    const d = Math.hypot(x - ax, z - az);
    if (d > maxDist) return -1;
    let s = this.protection(i, threats) * 0.6 + (1 - d / maxDist) * 0.25 + (this.isLow(i) ? 0.03 : 0.08);
    if (objWeight !== 0) {
      const before = Math.hypot(ox - ax, oz - az), after = Math.hypot(ox - x, oz - z);
      s += Math.max(-1, Math.min(1, (before - after) / maxDist)) * objWeight;
    }
    if (hasThreat) {
      // Do not charge the threat to reach cover (unless the objective pulls us there).
      const closer = Math.hypot(tcx - ax, tcz - az) - Math.hypot(tcx - x, tcz - z);
      if (closer > 8 && objWeight <= 0) s -= 0.3;
    }
    return s;
  }
}

/** Tree density (0..1) on an 8 m grid; conceals infantry from observers. */
export class FoliageField {
  readonly cell = 8;
  readonly n: number;
  readonly half: number;
  readonly density: Float32Array;

  constructor(props: PropLike[], worldSize: number) {
    this.n = Math.ceil(worldSize / this.cell);
    this.half = worldSize / 2;
    const raw = new Float32Array(this.n * this.n);
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (p.type !== 'tree' && p.type !== 'bush') continue;
      raw[this.index(p.x, p.z)] += p.type === 'bush' ? p.scale * 0.6 : p.scale;
    }
    this.density = new Float32Array(this.n * this.n);
    const n = this.n;
    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        let s = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx, z = cz + dz;
          if (x >= 0 && z >= 0 && x < n && z < n) s += raw[z * n + x] * (dx === 0 && dz === 0 ? 1 : 0.4);
        }
        this.density[cz * n + cx] = Math.min(1, s / 4);
      }
    }
  }

  index(x: number, z: number): number {
    let cx = Math.floor((x + this.half) / this.cell), cz = Math.floor((z + this.half) / this.cell);
    if (cx < 0) cx = 0; else if (cx >= this.n) cx = this.n - 1;
    if (cz < 0) cz = 0; else if (cz >= this.n) cz = this.n - 1;
    return cz * this.n + cx;
  }

  at(x: number, z: number): number { return this.density[this.index(x, z)]; }
}
