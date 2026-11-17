import { clamp } from '../core/math.js';

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
  }

  /** Bilinear height at world position. */
  height(x, z) {
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
   */
  normal(x, z, out) {
    const e = this.res;
    const dx = this.height(x + e, z) - this.height(x - e, z);
    const dz = this.height(x, z + e) - this.height(x, z - e);
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
