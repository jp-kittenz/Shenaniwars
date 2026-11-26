/**
 * Sensory backbone (Milestone 2, stage 1): what a side can see, what it has seen, what it expects, and how
 * dangerous each thing it knows about is. Everything here is allocation-free after construction.
 *
 *  - concealment(): one detection model for every observer/target pair (light / weather, stance, motion,
 *    foliage, ruins and buildings, light / muzzle signatures). It returns the rate multiplier and the fraction of
 *    the observer's range out to which the target can be picked up at all, so a slow crouched or prone squad in a
 *    forest, in ruins or at night slips past a distant patrol until it is close or fires.
 *  - UrbanField: how built-up / ruined each 10 m cell is (concealment, and the caution bias for un-cleared rooms),
 *    plus, per side, when friendly soldiers last stood in each cell without contact ("cleared").
 *  - ObservationBoard: deduplicated, side-wide enemy sightings (~35 m clusters per unit category): position,
 *    velocity, estimated count (distinct enemies seen in it), observers, confidence, last seen. Twenty soldiers
 *    seeing the same squad make one record, one radio report and one strength estimate.
 *  - threatScore(): lethal capability × aiming at us × proximity × our vulnerability to it.
 */

/** Unit categories of an observation. */
export const ObsCat = { INFANTRY: 0, AT_INFANTRY: 1, LIGHT_VEHICLE: 2, ARMOUR: 3, AIR: 4 } as const;
export const OBS_CAT_NAMES = ['infantry', 'AT team', 'light vehicle', 'armour', 'aircraft'];

// ------------------------------------------------------------------ concealment

/**
 * Detection rate multiplier of a soldier target, and (out[0]) the fraction of the observer's sensor range within
 * which he can be picked up at all.
 * @param stance 0 standing, 1 crouched, 2 prone
 * @param speed  m/s
 * @param foliage 0..1 at the target
 * @param urban 0..1 built-up / ruins at the target
 * @param signature  > 0 while a muzzle flash, a lit flashlight or a searchlight beam gives him away
 * @param thermal observer has thermal sights
 * @param light  ambient light / weather visibility factor (1 = clear day)
 */
export function concealment(stance: number, speed: number, foliage: number, urban: number, signature: number,
  thermal: boolean, light: number, out: Float32Array): number {
  let vis = stance === 2 ? 0.3 : stance === 1 ? 0.55 : 1;
  // Moving draws the eye; creeping slowly low down hardly does.
  vis *= speed < 1.4 && stance > 0 ? 0.85 : 1 + Math.min(7, speed) * 0.1;
  vis *= 1 - foliage * (thermal ? 0.25 : 0.65);
  vis *= 1 - urban * (thermal ? 0.2 : 0.45);
  const lit = signature > 0;
  if (lit) vis *= 2.5;
  else if (!thermal) vis *= light;
  // Out to what share of his range the observer can pick this target up at all: everything that is lit or
  // firing is seen as far as he can see; something low, still and hidden only close in.
  out[0] = lit ? 1 : Math.max(0.16, Math.min(1, 0.12 + 0.88 * Math.sqrt(Math.min(1, vis))));
  return vis;
}

// ------------------------------------------------------------------ urban field + cleared rooms

interface BuildingLike { x: number; z: number; w: number; d: number; rot: number; state?: number; floors?: number }

export class UrbanField {
  readonly cell = 10;
  readonly n: number;
  readonly half: number;
  /** 0..1 built-up / ruined. */
  readonly density: Float32Array;
  /** Per side: last time a friendly soldier stood in the cell with no contact (cleared). */
  readonly cleared: Float32Array[];

  constructor(buildings: BuildingLike[], worldSize: number) {
    this.half = worldSize / 2;
    this.n = Math.ceil(worldSize / this.cell);
    this.density = new Float32Array(this.n * this.n);
    this.cleared = [new Float32Array(this.n * this.n).fill(-1e9), new Float32Array(this.n * this.n).fill(-1e9)];
    for (const b of buildings) {
      if (!b || !(b.w > 0)) continue;
      // Ruins (rubble, broken walls) hide more than an intact block's street face; a building's surroundings
      // within a few metres count too (doorways, corners, rubble spill).
      const k = (b.state || 0) >= 1 ? 1 : 0.7, r = Math.hypot(b.w, b.d) / 2 + 4;
      const c = Math.cos(b.rot), s = Math.sin(b.rot);
      for (let x = b.x - r; x <= b.x + r; x += this.cell / 2) for (let z = b.z - r; z <= b.z + r; z += this.cell / 2) {
        const dx = x - b.x, dz = z - b.z, lx = dx * c - dz * s, lz = dx * s + dz * c;
        const ox = Math.max(0, Math.abs(lx) - b.w / 2), oz = Math.max(0, Math.abs(lz) - b.d / 2);
        const e = Math.hypot(ox, oz);
        if (e > 4) continue;
        const i = this.index(x, z);
        this.density[i] = Math.max(this.density[i], k * (1 - e / 6));
      }
    }
  }

  index(x: number, z: number): number {
    const n = this.n;
    const cx = Math.min(n - 1, Math.max(0, Math.floor((x + this.half) / this.cell)));
    const cz = Math.min(n - 1, Math.max(0, Math.floor((z + this.half) / this.cell)));
    return cz * n + cx;
  }

  at(x: number, z: number): number { return this.density[this.index(x, z)]; }

  /** A friendly soldier stands here with nothing in sight: the room / corner counts as cleared for a while. */
  markCleared(team: number, x: number, z: number, time: number): void {
    const i = this.index(x, z);
    if (this.density[i] > 0.05) this.cleared[team][i] = time;
  }

  /**
   * Caution bias at (x, z) for a side: built-up and not cleared by us in the last 90 s (doorways, stairwells,
   * upper floors nobody has looked into) → close to the cell's density; cleared → a fifth of it.
   */
  caution(team: number, x: number, z: number, time: number): number {
    const i = this.index(x, z), d = this.density[i];
    if (d <= 0) return 0;
    return d * (time - this.cleared[team][i] > 90 ? 1 : 0.2);
  }
}

// ------------------------------------------------------------------ observations

const MAX_IDS = 12;
const MAX_OBS = 6;

export class ObservationBoard {
  readonly cap: number;
  readonly mergeR: number;
  readonly team: Int8Array;
  readonly cat: Uint8Array;
  readonly x: Float32Array; readonly z: Float32Array;
  readonly vx: Float32Array; readonly vz: Float32Array;
  readonly first: Float32Array; readonly last: Float32Array; readonly reported: Float32Array;
  readonly idN: Uint8Array; readonly ids: Int32Array;
  readonly obsN: Uint8Array; readonly obs: Int32Array;
  readonly stats = { observations: 0, merged: 0, created: 0, reportsAllowed: 0, reportsSuppressed: 0 };

  /** @param cap records per side */
  constructor(cap = 64, mergeR = 35) {
    this.cap = cap * 2; this.mergeR = mergeR;
    const n = this.cap;
    this.team = new Int8Array(n).fill(-1); this.cat = new Uint8Array(n);
    this.x = new Float32Array(n); this.z = new Float32Array(n); this.vx = new Float32Array(n); this.vz = new Float32Array(n);
    this.first = new Float32Array(n); this.last = new Float32Array(n).fill(-1e9); this.reported = new Float32Array(n).fill(-1e9);
    this.idN = new Uint8Array(n); this.ids = new Int32Array(n * MAX_IDS);
    this.obsN = new Uint8Array(n); this.obs = new Int32Array(n * MAX_OBS);
  }

  /**
   * Side `team` sees enemy `entity` (category `cat`) at (x, z) moving (vx, vz), seen by `observer`. Merges into
   * the side's record of that category within the merge radius (fresh in the last 20 s), else opens one (or
   * reuses the stalest). Returns the record index.
   */
  observe(team: number, entity: number, cat: number, x: number, z: number, vx: number, vz: number, observer: number, time: number): number {
    this.stats.observations++;
    let best = -1, bd = this.mergeR * this.mergeR, free = -1, stale = -1, st = 1e9;
    for (let i = 0; i < this.cap; i++) {
      if (this.team[i] < 0 || time - this.last[i] > 45) { if (free < 0) free = i; continue; }
      if (this.team[i] !== team) continue;
      if (this.last[i] < st) { st = this.last[i]; stale = i; }
      if (this.cat[i] !== cat || time - this.last[i] > 20) continue;
      const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    let r = best;
    if (r >= 0) {
      this.stats.merged++;
      // The record follows its members: a running blend toward the newest sighting.
      this.x[r] += (x - this.x[r]) * 0.35; this.z[r] += (z - this.z[r]) * 0.35;
      this.vx[r] += (vx - this.vx[r]) * 0.4; this.vz[r] += (vz - this.vz[r]) * 0.4;
    } else {
      r = free >= 0 ? free : stale;
      if (r < 0) return -1;
      this.stats.created++;
      this.team[r] = team; this.cat[r] = cat; this.x[r] = x; this.z[r] = z; this.vx[r] = vx; this.vz[r] = vz;
      this.first[r] = time; this.reported[r] = -1e9; this.idN[r] = 0; this.obsN[r] = 0;
    }
    this.last[r] = time;
    this.addTo(this.ids, this.idN, r, MAX_IDS, entity);
    this.addTo(this.obs, this.obsN, r, MAX_OBS, observer);
    return r;
  }

  private addTo(arr: Int32Array, n: Uint8Array, r: number, max: number, v: number): void {
    const b = r * max, c = n[r];
    for (let k = 0; k < c; k++) if (arr[b + k] === v) return;
    if (c < max) { arr[b + c] = v; n[r] = c + 1; }
    else arr[b + ((v >>> 0) % max)] = v;
  }

  /** Distinct enemies seen in record r (its estimated strength). */
  estimatedCount(r: number): number { return this.idN[r]; }

  /** 0..1: more independent observers and a fresher sighting, more confidence. */
  confidence(r: number, time: number): number {
    const age = time - this.last[r];
    return Math.max(0, Math.min(1, 0.35 + 0.15 * this.obsN[r]) * (1 - age / 45));
  }

  fresh(r: number, time: number, maxAge = 30): boolean { return this.team[r] >= 0 && time - this.last[r] <= maxAge; }

  /**
   * One radio report per record per `gap` seconds (the first observer to see it reports; the other nineteen
   * do not repeat it).
   */
  shouldReport(r: number, time: number, gap = 20): boolean {
    if (r < 0) return true;
    if (time - this.reported[r] < gap) { this.stats.reportsSuppressed++; return false; }
    this.reported[r] = time; this.stats.reportsAllowed++;
    return true;
  }

  /** Estimated enemy strength side `team` knows of within r of (x, z) (vehicles weigh 3). */
  strengthNear(team: number, x: number, z: number, r: number, time: number, maxAge = 30): number {
    let s = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.team[i] !== team || time - this.last[i] > maxAge) continue;
      if ((this.x[i] - x) ** 2 + (this.z[i] - z) ** 2 > r * r) continue;
      s += this.idN[i] * (this.cat[i] >= ObsCat.LIGHT_VEHICLE ? 3 : 1);
    }
    return s;
  }

  /** Records side `team` holds (for iteration): calls fn(index) on each fresh one. */
  each(team: number, time: number, maxAge: number, fn: (i: number) => void): void {
    for (let i = 0; i < this.cap; i++) if (this.team[i] === team && time - this.last[i] <= maxAge) fn(i);
  }

  clear(): void { this.team.fill(-1); this.last.fill(-1e9); }
}

// ------------------------------------------------------------------ threat assessment

/**
 * How dangerous enemy `e` is to `me` right now: lethal capability against what I am × aiming at me ×
 * proximity × my vulnerability to it. Infantry weigh an RPG gunner or an IFV turning its gun on them over a
 * distant rifleman; armour weighs ATGM teams and tank guns over everything else.
 * @param lethal 0.5 rifle … 3 ATGM / tank gun against this kind of target
 * @param aiming 0..1 how squarely it points at me
 * @param dist metres
 * @param vulnerable 0.3 (heavy armour against small arms) … 1.4 (infantry in the open against HE)
 */
export function threatScore(lethal: number, aiming: number, dist: number, vulnerable: number): number {
  return lethal * (1 + 0.8 * aiming) * (1 / (1 + dist / 120)) * vulnerable;
}
