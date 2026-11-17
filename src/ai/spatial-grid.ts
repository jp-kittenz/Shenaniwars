/**
 * Flat uniform spatial grid over the square world, rebuilt by counting sort.
 * Ids are dense integers in [0, capacity). No allocation after construction:
 * queries write into caller-owned Int32Arrays.
 */
export class SpatialGrid {
  readonly cell: number;
  readonly n: number;
  readonly half: number;
  readonly capacity: number;
  /** cellStart[c]..cellStart[c+1] index into `items`. */
  readonly cellStart: Int32Array;
  readonly items: Int32Array;
  readonly xs: Float32Array;
  readonly zs: Float32Array;
  private readonly cellOf: Int32Array;
  private readonly inserted: Int32Array;
  private readonly cursor: Int32Array;
  private insertedCount = 0;

  constructor(worldSize: number, cellSize: number, capacity: number) {
    this.cell = cellSize;
    this.n = Math.ceil(worldSize / cellSize);
    this.half = worldSize / 2;
    this.capacity = capacity;
    const cells = this.n * this.n;
    this.cellStart = new Int32Array(cells + 1);
    this.cursor = new Int32Array(cells + 1);
    this.items = new Int32Array(capacity);
    this.xs = new Float32Array(capacity);
    this.zs = new Float32Array(capacity);
    this.cellOf = new Int32Array(capacity);
    this.inserted = new Int32Array(capacity);
  }

  cellIndex(x: number, z: number): number {
    let cx = Math.floor((x + this.half) / this.cell), cz = Math.floor((z + this.half) / this.cell);
    if (cx < 0) cx = 0; else if (cx >= this.n) cx = this.n - 1;
    if (cz < 0) cz = 0; else if (cz >= this.n) cz = this.n - 1;
    return cz * this.n + cx;
  }

  begin(): void { this.insertedCount = 0; }

  insert(id: number, x: number, z: number): void {
    this.xs[id] = x; this.zs[id] = z;
    this.cellOf[id] = this.cellIndex(x, z);
    this.inserted[this.insertedCount++] = id;
  }

  /** Counting sort of the inserted ids into cell order. */
  finish(): void {
    const start = this.cellStart, cur = this.cursor, cells = this.n * this.n;
    start.fill(0);
    for (let i = 0; i < this.insertedCount; i++) start[this.cellOf[this.inserted[i]] + 1]++;
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    cur.set(start);
    for (let i = 0; i < this.insertedCount; i++) {
      const id = this.inserted[i];
      this.items[cur[this.cellOf[id]]++] = id;
    }
  }

  /**
   * Ids within `r` of (x, z), optionally limited to [idMin, idMax).
   * @returns number of ids written to `out`
   */
  queryRadius(x: number, z: number, r: number, out: Int32Array, idMin = 0, idMax = 0x7fffffff): number {
    const n = this.n, inv = 1 / this.cell, r2 = r * r;
    let c0x = Math.floor((x - r + this.half) * inv), c1x = Math.floor((x + r + this.half) * inv);
    let c0z = Math.floor((z - r + this.half) * inv), c1z = Math.floor((z + r + this.half) * inv);
    if (c0x < 0) c0x = 0; if (c0z < 0) c0z = 0; if (c1x >= n) c1x = n - 1; if (c1z >= n) c1z = n - 1;
    let count = 0;
    const max = out.length;
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const c = cz * n + cx;
        for (let k = this.cellStart[c], e = this.cellStart[c + 1]; k < e; k++) {
          const id = this.items[k];
          if (id < idMin || id >= idMax) continue;
          const dx = this.xs[id] - x, dz = this.zs[id] - z;
          if (dx * dx + dz * dz > r2) continue;
          out[count++] = id;
          if (count === max) return count;
        }
      }
    }
    return count;
  }
}

/**
 * Static grid of points built once (cover nodes): same layout, fixed contents.
 */
export class StaticPointGrid {
  readonly grid: SpatialGrid;
  constructor(worldSize: number, cellSize: number, xs: Float32Array, zs: Float32Array, count: number) {
    this.grid = new SpatialGrid(worldSize, cellSize, Math.max(1, count));
    this.grid.begin();
    for (let i = 0; i < count; i++) this.grid.insert(i, xs[i], zs[i]);
    this.grid.finish();
  }
  query(x: number, z: number, r: number, out: Int32Array): number { return this.grid.queryRadius(x, z, r, out); }
}
