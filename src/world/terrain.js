import { clamp } from '../core/math.js';

/** Ground cover kinds (Terrain.surf). */
export const SURF = { NONE: 0, CONCRETE: 1, STREET: 2, WHEAT: 3, GREEN: 4, PLOUGHED: 5, GRAVEL: 6, DITCH: 7, FOREST: 8, MUD: 9 };

/**
 * Heightmap terrain. Pure data + sampling; rendering and collision are built
 * from it by the chunk manager and physics system respectively.
 */
export class Terrain {
  /**
   * @param {number} size world edge length in metres (centred on origin)
   * @param {number} res  metres per sample
   */
  constructor(size, res) {
    this.size = size;
    this.half = size / 2;
    this.res = res;
    this.n = Math.round(size / res) + 1;
    this.heights = new Float32Array(this.n * this.n);
    /** 0..255 road blend weight per sample (used for colouring + prop exclusion). */
    this.road = new Uint8Array(this.n * this.n);
    /** 0..255 paved surface (runways). */
    this.paved = new Uint8Array(this.n * this.n);
    /** Ground cover per sample (SURF.*): concrete, streets, crops, gravel, ditches, forest floor. */
    this.surf = new Uint8Array(this.n * this.n);
    /**
     * Bridge decks laid over the heightfield (axis-aligned in their own
     * frame): vehicles and soldiers sample them through height(); rendering,
     * physics and navigation use baseHeight(). `alive` drops with the bridge.
     * @type {{x:number, z:number, c:number, s:number, hw:number, hl:number, y0:number, y1:number, alive:boolean, minX:number, maxX:number, minZ:number, maxZ:number}[]}
     */
    this.decks = [];
  }

  /** Ground height including standing bridge decks. */
  height(x, z) {
    const h = this.baseHeight(x, z);
    for (let i = 0; i < this.decks.length; i++) {
      const d = this.decks[i];
      if (!d.alive || x < d.minX || x > d.maxX || z < d.minZ || z > d.maxZ) continue;
      const dx = x - d.x, dz = z - d.z;
      const lx = dx * d.c - dz * d.s, lz = dx * d.s + dz * d.c;
      if (Math.abs(lx) > d.hw || Math.abs(lz) > d.hl) continue;
      const y = d.y0 + (d.y1 - d.y0) * (lz / d.hl * 0.5 + 0.5);
      if (y > h) return y;
    }
    return h;
  }

  /** Bilinear heightfield sample (no bridges). */
  baseHeight(x, z) {
    const n = this.n;
    const fx = clamp((x + this.half) / this.res, 0, n - 1.001);
    const fz = clamp((z + this.half) / this.res, 0, n - 1.001);
    const ix = fx | 0, iz = fz | 0;
    const tx = fx - ix, tz = fz - iz;
    const i = iz * n + ix;
    const h = this.heights;
    const a = h[i], b = h[i + 1], c = h[i + n], d = h[i + n + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /**
   * Surface normal via central differences.
   * @param {{x:number,y:number,z:number}} out
   * @param {boolean} [base] ignore bridge decks
   */
  normal(x, z, out, base = false) {
    const e = this.res;
    const dx = base ? this.baseHeight(x + e, z) - this.baseHeight(x - e, z) : this.height(x + e, z) - this.height(x - e, z);
    const dz = base ? this.baseHeight(x, z + e) - this.baseHeight(x, z - e) : this.height(x, z + e) - this.height(x, z - e);
    const inv = 1 / Math.hypot(dx, 2 * e, dz);
    out.x = -dx * inv; out.y = 2 * e * inv; out.z = -dz * inv;
    return out;
  }

  /** Slope as rise/run (0 = flat, 1 = 45°). */
  slope(x, z) {
    const e = this.res;
    const dx = this.height(x + e, z) - this.height(x - e, z);
    const dz = this.height(x, z + e) - this.height(x, z - e);
    return Math.hypot(dx, dz) / (2 * e);
  }

  surfAt(x, z) {
    const ix = clamp(Math.round((x + this.half) / this.res), 0, this.n - 1);
    const iz = clamp(Math.round((z + this.half) / this.res), 0, this.n - 1);
    return this.surf[iz * this.n + ix];
  }

  pavedAt(x, z) {
    const ix = clamp(Math.round((x + this.half) / this.res), 0, this.n - 1);
    const iz = clamp(Math.round((z + this.half) / this.res), 0, this.n - 1);
    return this.paved[iz * this.n + ix] / 255;
  }

  roadAt(x, z) {
    const ix = clamp(Math.round((x + this.half) / this.res), 0, this.n - 1);
    const iz = clamp(Math.round((z + this.half) / this.res), 0, this.n - 1);
    return this.road[iz * this.n + ix] / 255;
  }

  inBounds(x, z, margin = 0) {
    const m = this.half - margin;
    return x > -m && x < m && z > -m && z < m;
  }
}
