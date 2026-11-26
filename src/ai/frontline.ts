/**
 * Occupied-territory frontline grid (Milestone 2, stage 2): a 100 m influence field over the whole island,
 * re-evaluated every 1.5 s in one typed-array pass (no allocation).
 *
 * Influence (each side separately; the field is the balance (T − P) / (T + P)) comes from weighted emitters — the HQs, owned flags,
 * soldiers (scaled by their ammunition) and crewed combat vehicles — and spreads over a few diffusion passes:
 * quickly along roads and across open ground, slowly through forest and steep relief, and never across water
 * (each cell carries its landmass label: NOVEMBER, 350 m offshore, keeps a perimeter of its own).
 *
 * Each cell is classified for each side:
 *   SECURE_REAR          ours, strong, no contested neighbour, no enemy in it;
 *   CONTESTED_FRONTLINE  on the territory boundary, or both sides present;
 *   REAR_AREA_BREACH     enemy seen (by us: our observations) inside our otherwise secure rear;
 *   ENCIRCLED_POCKET     ours, but cut off: no path to our HQ that does not cross enemy-held ground.
 *
 * Contours: Marching Squares over the scalar field (iso 0) into a pre-allocated segment array, each segment
 * flagged active (a clash: both sides present nearby) or quiet; pocket outlines likewise.
 */

export const Zone = { NEUTRAL: 0, SECURE_REAR: 1, CONTESTED_FRONTLINE: 2, REAR_AREA_BREACH: 3, ENCIRCLED_POCKET: 4 } as const;
export const ZONE_NAMES = ['neutral', 'secure rear', 'contested frontline', 'rear-area breach', 'encircled pocket'];

export interface FrontlineWorld {
  size: number;
  /** Landmass id at (x, z); 0 = water. */
  landmassAt(x: number, z: number): number;
  /** 0..1 forest density. */
  forest(x: number, z: number): number;
  /** 0..1 road / paved. */
  road(x: number, z: number): number;
  /** Ground slope (0 flat … 1 steep). */
  slope(x: number, z: number): number;
}

const MAX_SEG = 2048;
/** Combined influence below which a cell is out of everyone's reach (neutral). */
const REACH = 0.03;
/** Diffusion passes (even): enough for an HQ to reach across most of the island. */
const PASSES = 16;

export class FrontlineGrid {
  readonly cell: number;
  readonly n: number;
  readonly half: number;
  readonly count: number;
  /** Per cell: landmass id (0 water). */
  readonly land: Uint16Array;
  /** Per cell: how easily influence passes through (0.2 forest / steep … 1.5 road). */
  readonly cond: Float32Array;
  /** Emitters this tick per side, each side's propagated influence, and the balance field
   *  (−1 Pampalona … +1 Torsa: (T − P) / (T + P); 0 where neither side reaches). */
  readonly src: Float32Array[];
  readonly infl: Float32Array[];
  readonly field: Float32Array;
  private readonly tmp: Float32Array;
  /** Presence this tick: soldiers / vehicles of each side in each cell (combat power). */
  readonly power: Float32Array[];
  /** Enemy strength observed (by side t: what t knows of the other side) in each cell. */
  readonly seen: Float32Array[];
  readonly seenVeh: Uint8Array[];
  /** Zone of each cell for each side. */
  readonly zone: Uint8Array[];
  /** HQ cell per side. */
  readonly hqCell = new Int32Array([-1, -1]);
  /** Counts per side of contested / breach / pocket cells, and the biggest breach (estimated count, vehicles). */
  readonly counts = { contested: [0, 0], breach: [0, 0], pocket: [0, 0], secure: [0, 0] };
  readonly worstBreach = { cell: new Int32Array([-1, -1]), strength: new Float32Array(2), vehicles: new Uint8Array(2) };
  /** Contour segments [x0, z0, x1, z1] in world metres; segFlag: 1 active clash, 0 quiet; 2 pocket outline. */
  readonly seg = new Float32Array(MAX_SEG * 4);
  readonly segFlag = new Uint8Array(MAX_SEG);
  segN = 0;
  readonly stats = { updates: 0, ms: 0, maxMs: 0 };
  private readonly stack: Int32Array;
  private readonly comp: Int32Array;

  constructor(world: FrontlineWorld, cell = 100) {
    this.cell = cell;
    this.n = Math.ceil(world.size / cell);
    this.half = world.size / 2;
    const N = (this.count = this.n * this.n);
    this.land = new Uint16Array(N); this.cond = new Float32Array(N);
    this.src = [new Float32Array(N), new Float32Array(N)]; this.infl = [new Float32Array(N), new Float32Array(N)];
    this.field = new Float32Array(N); this.tmp = new Float32Array(N);
    this.power = [new Float32Array(N), new Float32Array(N)];
    this.seen = [new Float32Array(N), new Float32Array(N)];
    this.seenVeh = [new Uint8Array(N), new Uint8Array(N)];
    this.zone = [new Uint8Array(N), new Uint8Array(N)];
    this.stack = new Int32Array(N); this.comp = new Int32Array(N);
    // Static terrain: the landmass most of the cell lies on, and its conductance (5 × 5 samples).
    const votes = new Map<number, number>();
    for (let cz = 0; cz < this.n; cz++) for (let cx = 0; cx < this.n; cx++) {
      const i = cz * this.n + cx;
      votes.clear();
      let forest = 0, road = 0, slope = 0, k = 0;
      for (let sz = 0; sz < 5; sz++) for (let sx = 0; sx < 5; sx++) {
        const x = -this.half + (cx + (sx + 0.5) / 5) * cell, z = -this.half + (cz + (sz + 0.5) / 5) * cell;
        const l = world.landmassAt(x, z);
        votes.set(l, (votes.get(l) || 0) + 1);
        if (l === 0) continue;
        forest += world.forest(x, z); road += world.road(x, z); slope += world.slope(x, z); k++;
      }
      let best = 0, bv = 0;
      for (const [l, v] of votes) if (l !== 0 && v > bv) { bv = v; best = l; }
      // (a cell that is mostly sea belongs to no landmass)
      this.land[i] = bv >= 5 ? best : 0;
      if (k) { forest /= k; road /= k; slope /= k; }
      this.cond[i] = this.land[i] === 0 ? 0 : Math.max(0.2, Math.min(1.5, 1 + road * 1.4 - forest * 0.6 - slope * 0.8));
    }
  }

  index(x: number, z: number): number {
    const n = this.n;
    const cx = Math.min(n - 1, Math.max(0, Math.floor((x + this.half) / this.cell)));
    const cz = Math.min(n - 1, Math.max(0, Math.floor((z + this.half) / this.cell)));
    return cz * n + cx;
  }

  /** Cell centre (world). */
  cx(i: number): number { return -this.half + ((i % this.n) + 0.5) * this.cell; }
  cz(i: number): number { return -this.half + (((i / this.n) | 0) + 0.5) * this.cell; }

  // ---------------------------------------------------------------- per-tick input (call between begin / end)

  begin(): void {
    this.src[0].fill(0); this.src[1].fill(0);
    this.power[0].fill(0); this.power[1].fill(0);
    this.seen[0].fill(0); this.seen[1].fill(0);
    this.seenVeh[0].fill(0); this.seenVeh[1].fill(0);
  }

  /** An emitter of `team` at (x, z) with weight w (HQ ≈ 8, flag ≈ 3, soldier ≈ 0.3, combat vehicle ≈ 1.5). */
  emit(team: number, x: number, z: number, w: number, presence = 0): void {
    const i = this.index(x, z);
    if (this.land[i] === 0 && presence === 0) return;
    this.src[team][i] += w;
    if (presence > 0) this.power[team][i] += presence;
  }

  /** Side `observer` knows of enemy strength `est` (vehicles: `veh`) at (x, z). */
  observed(observer: number, x: number, z: number, est: number, veh: boolean): void {
    const i = this.index(x, z);
    this.seen[observer][i] += est;
    if (veh) this.seenVeh[observer][i] = 1;
  }

  setHq(team: number, x: number, z: number): void { this.hqCell[team] = this.index(x, z); }

  /** Propagate, classify and contour. */
  end(): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    this.propagate();
    this.classify(0); this.classify(1);
    this.contour();
    this.stats.updates++;
    if (t0) { const ms = performance.now() - t0; this.stats.ms = ms; this.stats.maxMs = Math.max(this.stats.maxMs, ms); }
  }

  private propagate(): void {
    this.diffuse(this.src[0], this.infl[0]);
    this.diffuse(this.src[1], this.infl[1]);
    // Balance: territory belongs to whoever's influence dominates; a band where they are near-equal is the front,
    // and ground neither side's influence reaches stays neutral.
    const out = this.field, P = this.infl[0], T = this.infl[1], land = this.land;
    for (let i = 0; i < this.count; i++) {
      const tot = P[i] + T[i];
      out[i] = land[i] === 0 || tot < REACH ? 0 : (T[i] - P[i]) / tot;
    }
  }

  /** Diffusion of one side's emitters: each pass a cell takes its own emitters plus a share of its neighbours'
   *  influence, weighted by how easily it crosses the shared edge; neighbours on another landmass give nothing. */
  private diffuse(src: Float32Array, out: Float32Array): void {
    const n = this.n, N = this.count, land = this.land, cond = this.cond;
    let F = out, G = this.tmp;
    for (let i = 0; i < N; i++) F[i] = src[i];
    for (let pass = 0; pass < PASSES; pass++) {
      for (let i = 0; i < N; i++) {
        const l = land[i];
        if (l === 0) { G[i] = 0; continue; }
        const x = i % n;
        let acc = 0, wsum = 0;
        const c0 = cond[i];
        if (x > 0 && land[i - 1] === l) { const w = Math.min(c0, cond[i - 1]); acc += F[i - 1] * w; wsum += w; }
        if (x < n - 1 && land[i + 1] === l) { const w = Math.min(c0, cond[i + 1]); acc += F[i + 1] * w; wsum += w; }
        if (i >= n && land[i - n] === l) { const w = Math.min(c0, cond[i - n]); acc += F[i - n] * w; wsum += w; }
        if (i < N - n && land[i + n] === l) { const w = Math.min(c0, cond[i + n]); acc += F[i + n] * w; wsum += w; }
        G[i] = src[i] + (wsum > 0 ? (acc / Math.max(wsum, 1.6)) * 0.9 * Math.min(1, wsum / 2) : 0) + F[i] * 0.1;
      }
      const T = F; F = G; G = T;
    }
    // (an even pass count, so the result ends back in `out`)
  }

  /** Owner of cell i: 1 Torsa, 0 Pampalona, −1 neutral / water. */
  owner(i: number): number {
    const f = this.field[i];
    return this.land[i] === 0 || Math.abs(f) < 0.12 ? -1 : f > 0 ? 1 : 0;
  }

  private classify(team: number): void {
    const n = this.n, N = this.count, Z = this.zone[team], enemy = 1 - team;
    const C = this.counts;
    let contested = 0, breach = 0, pocket = 0, secure = 0;
    this.worstBreach.cell[team] = -1; this.worstBreach.strength[team] = 0; this.worstBreach.vehicles[team] = 0;
    for (let i = 0; i < N; i++) {
      Z[i] = Zone.NEUTRAL;
      if (this.land[i] === 0) continue;
      const own = this.owner(i), x = i % n;
      let edge = false;
      if (own === team) {
        edge = (x > 0 && this.owner(i - 1) === enemy) || (x < n - 1 && this.owner(i + 1) === enemy) ||
          (i >= n && this.owner(i - n) === enemy) || (i < N - n && this.owner(i + n) === enemy);
      }
      const both = this.power[0][i] > 0 && this.power[1][i] > 0;
      if (own === team && !edge && !both) {
        if (this.seen[team][i] > 0 && Math.abs(this.field[i]) > 0.3) {
          Z[i] = Zone.REAR_AREA_BREACH; breach++;
          if (this.seen[team][i] > this.worstBreach.strength[team]) { this.worstBreach.strength[team] = this.seen[team][i]; this.worstBreach.cell[team] = i; this.worstBreach.vehicles[team] = this.seenVeh[team][i]; }
        } else { Z[i] = Zone.SECURE_REAR; secure++; }
      } else if ((own === team && edge) || both || (own === -1 && this.power[team][i] > 0)) { Z[i] = Zone.CONTESTED_FRONTLINE; contested++; }
    }
    // Encircled pockets: our cells on the HQ's landmass that cannot reach the HQ without crossing enemy-held
    // ground (neutral no-man's-land does not cut a supply line; enemy cells do; the sea at their back does not
    // save them). Flood from the HQ through every land cell the enemy does not hold; what is ours and unreached
    // is cut off. (Garrisons on other landmasses — NOVEMBER — are supplied by sea and air, never "pockets".)
    const reach = this.comp, stack = this.stack;
    reach.fill(0);
    const hq = this.hqCell[team];
    if (hq >= 0 && this.land[hq] !== 0) {
      const hl = this.land[hq];
      let sp = 0, top = 0;
      stack[sp++] = hq; reach[hq] = 1;
      while (top < sp) {
        const i = stack[top++], x = i % n;
        for (let k = 0; k < 4; k++) {
          if (k === 0 ? x === 0 : k === 1 ? x === n - 1 : k === 2 ? i < n : i >= N - n) continue;
          const j = k === 0 ? i - 1 : k === 1 ? i + 1 : k === 2 ? i - n : i + n;
          if (reach[j] || this.land[j] !== hl || this.owner(j) === enemy) continue;
          reach[j] = 1; stack[sp++] = j;
        }
      }
      let cut = 0;
      for (let i = 0; i < N; i++) if (this.land[i] === hl && !reach[i] && this.owner(i) === team) cut++;
      // (more than a quarter of the island cut off is the HQ being besieged, not a pocket)
      if (cut > 0 && cut <= N / 4) for (let i = 0; i < N; i++) {
        if (this.land[i] !== hl || reach[i] || this.owner(i) !== team || Z[i] === Zone.REAR_AREA_BREACH) continue;
        if (Z[i] === Zone.SECURE_REAR) secure--; else if (Z[i] === Zone.CONTESTED_FRONTLINE) contested--;
        Z[i] = Zone.ENCIRCLED_POCKET; pocket++;
      }
    }
    C.contested[team] = contested; C.breach[team] = breach; C.pocket[team] = pocket; C.secure[team] = secure;
  }

  /** Zone of the cell at (x, z) for side `team`. */
  zoneAt(team: number, x: number, z: number): number { return this.zone[team][this.index(x, z)]; }

  // ---------------------------------------------------------------- Marching Squares

  private contour(): void {
    const n = this.n, F = this.field, cell = this.cell, h = this.half;
    this.segN = 0;
    // Corners are cell centres; the square (cx, cz) spans centres (cx..cx+1, cz..cz+1).
    for (let cz = 0; cz < n - 1; cz++) for (let cx = 0; cx < n - 1; cx++) {
      const i0 = cz * n + cx, i1 = i0 + 1, i2 = i0 + n + 1, i3 = i0 + n;
      if (this.land[i0] === 0 && this.land[i1] === 0 && this.land[i2] === 0 && this.land[i3] === 0) continue;
      const a = F[i0], b = F[i1], c = F[i2], d = F[i3];
      const code = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      // Only where both sides actually hold ground on either side (not plain neutral fade-out).
      const mx = Math.max(a, b, c, d), mn = Math.min(a, b, c, d);
      if (mx < 0.1 || mn > -0.1) continue;
      const x0 = -h + (cx + 0.5) * cell, z0 = -h + (cz + 0.5) * cell;
      // Edge crossings (linear interpolation): e0 bottom (a-b), e1 right (b-c), e2 top (d-c), e3 left (a-d).
      const ex = EX, ez = EZ;
      ex[0] = x0 + lerpT(a, b) * cell; ex[1] = x0 + cell; ex[2] = x0 + lerpT(d, c) * cell; ex[3] = x0;
      ez[0] = z0; ez[1] = z0 + lerpT(b, c) * cell; ez[2] = z0 + cell; ez[3] = z0 + lerpT(a, d) * cell;
      const active = this.power[0][i0] + this.power[0][i1] + this.power[0][i2] + this.power[0][i3] > 0 &&
        this.power[1][i0] + this.power[1][i1] + this.power[1][i2] + this.power[1][i3] > 0 ? 1 : 0;
      const L = SEG_TABLE[code];
      for (let k = 0; k < L.length; k += 2) this.pushSeg(ex[L[k]], ez[L[k]], ex[L[k + 1]], ez[L[k + 1]], active);
    }
    // Pocket outlines: edges between a pocket cell (either side's) and a non-pocket cell.
    for (let team = 0; team < 2; team++) {
      const Z = this.zone[team];
      for (let i = 0; i < this.count; i++) {
        if (Z[i] !== Zone.ENCIRCLED_POCKET) continue;
        const x = i % n, wx = -h + x * cell, wz = -h + ((i / n) | 0) * cell;
        if (x === 0 || Z[i - 1] !== Zone.ENCIRCLED_POCKET) this.pushSeg(wx, wz, wx, wz + cell, 2);
        if (x === n - 1 || Z[i + 1] !== Zone.ENCIRCLED_POCKET) this.pushSeg(wx + cell, wz, wx + cell, wz + cell, 2);
        if (i < n || Z[i - n] !== Zone.ENCIRCLED_POCKET) this.pushSeg(wx, wz, wx + cell, wz, 2);
        if (i >= this.count - n || Z[i + n] !== Zone.ENCIRCLED_POCKET) this.pushSeg(wx, wz + cell, wx + cell, wz + cell, 2);
      }
    }
  }

  private pushSeg(x0: number, z0: number, x1: number, z1: number, flag: number): void {
    if (this.segN >= MAX_SEG) return;
    const k = this.segN * 4;
    this.seg[k] = x0; this.seg[k + 1] = z0; this.seg[k + 2] = x1; this.seg[k + 3] = z1;
    this.segFlag[this.segN++] = flag;
  }
}

const EX = new Float32Array(4), EZ = new Float32Array(4);
/** Where the iso-0 line crosses the edge p → q (fraction from p). */
function lerpT(p: number, q: number): number { return Math.abs(q - p) < 1e-6 ? 0.5 : p / (p - q); }

/** Marching Squares edge pairs per case (edges: 0 bottom, 1 right, 2 top, 3 left); saddles split both ways. */
const SEG_TABLE: number[][] = [
  [], [3, 0], [0, 1], [3, 1], [1, 2], [3, 2, 0, 1], [0, 2], [3, 2],
  [2, 3], [2, 0], [0, 3, 1, 2], [2, 1], [1, 3], [1, 0], [0, 3], [],
];
