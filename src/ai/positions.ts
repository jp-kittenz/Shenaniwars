import { CoverField, FoliageField } from './terrain-analysis.ts';
import { Stance, SoldierClass, hash01 } from './types.ts';
import type { GameLike, TerrainLike } from './types.ts';

/**
 * Tactical positioning: where each soldier of a squad should stand (and face)
 * when holding ground, supporting by fire or defending a flag, and where an
 * armoured vehicle should fight from. Uses a cheap terrain + vegetation
 * line-of-sight estimate (no physics raycasts) and the cover field.
 */

/** Terrain / vegetation line of sight from A to B (heights are absolute). Samples every `step` metres. */
export function terrainLos(t: TerrainLike, foliage: FoliageField | null, ax: number, ay: number, az: number,
  bx: number, by: number, bz: number, step = 4): boolean {
  const dx = bx - ax, dz = bz - az, d = Math.hypot(dx, dz);
  const n = Math.max(1, Math.floor(d / step));
  let veg = 0;
  for (let i = 1; i < n; i++) {
    const k = i / n, x = ax + dx * k, z = az + dz * k, y = ay + (by - ay) * k;
    if (t.height(x, z) > y - 0.25) return false;
    if (foliage) { veg += foliage.at(x, z) * step; if (veg > 22) return false; }
  }
  return true;
}

/** Positioning modes. */
export const PosMode = {
  /** Hold an assembly / waiting area: cover facing the threat, concealed. */
  HOLD: 0,
  /** Support by fire: overwatch with line of sight onto the objective. */
  SUPPORT: 1,
  /** Defend a flag: most of the squad inside the capture radius, AT and spotter outside covering approaches. */
  DEFEND_FLAG: 2,
} as const;

const MAX_CAND = 72;
const CX = new Float32Array(MAX_CAND), CZ = new Float32Array(MAX_CAND), CY = new Float32Array(MAX_CAND);
const CCOVER = new Int32Array(MAX_CAND), CLOS = new Float32Array(MAX_CAND), CUSED = new Uint8Array(MAX_CAND);
const IDS = new Int32Array(96);

/** Output of a squad position assignment (per member index). */
export class PositionPlan {
  readonly x = new Float32Array(8);
  readonly z = new Float32Array(8);
  readonly yaw = new Float32Array(8);
  readonly stance = new Uint8Array(8);
  /** Cover node of each post (-1 open ground). */
  readonly node = new Int32Array(8).fill(-1);
  count = 0;
}

/**
 * Assigns positions to `n` members (classes in `cls`) around (px, pz) within
 * `radius`, facing `threatYaw`. `fx, fz` is the flag / objective the squad
 * must cover (SUPPORT: line of sight onto it; DEFEND_FLAG: stay inside its
 * capture radius). Greedy: leader first, every member takes the best free
 * candidate, keeping 5 m spacing.
 */
export function planSquadPositions(game: GameLike, cover: CoverField, foliage: FoliageField, mode: number,
  px: number, pz: number, radius: number, threatYaw: number, fx: number, fz: number, captureR: number,
  n: number, cls: Uint8Array, seed: number, out: PositionPlan, mx?: Float32Array, mz?: Float32Array): void {
  const t = game.map.terrain, nav = game.nav;
  const tdx = Math.sin(threatYaw), tdz = Math.cos(threatYaw);
  let c = 0;
  // Cover nodes in reach.
  const m = cover.grid.query(px, pz, radius, IDS);
  for (let k = 0; k < m && c < MAX_CAND - 24; k++) {
    const i = IDS[k];
    if (!cover.valid(i)) continue;
    CX[c] = cover.x[i]; CZ[c] = cover.z[i]; CCOVER[c] = i; c++;
  }
  // Open-ground fallbacks on three rings, biased to the threat side.
  for (let r = 0; r < 3; r++) {
    const rr = radius * (0.3 + r * 0.32);
    for (let a = 0; a < 8 && c < MAX_CAND; a++) {
      const ang = threatYaw + (a - 3.5) * 0.55 + hash01(seed, r * 8 + a) * 0.2;
      const x = px + Math.sin(ang) * rr, z = pz + Math.cos(ang) * rr;
      if (nav.blocked(x, z)) continue;
      CX[c] = x; CZ[c] = z; CCOVER[c] = -1; c++;
    }
  }
  const h0 = t.height(px, pz);
  for (let i = 0; i < c; i++) {
    // A post on a building's upper level sees from a storey up.
    CY[i] = t.height(CX[i], CZ[i]) + (CCOVER[i] >= 0 && cover.floor[CCOVER[i]] ? cover.levelHeight(CCOVER[i]) : 0);
    CUSED[i] = 0;
    // Line of sight from a crouched eye: onto the objective (support) or 60 m down the threat axis.
    const eye = CY[i] + 1.1;
    if (mode === PosMode.SUPPORT) CLOS[i] = terrainLos(t, foliage, CX[i], eye, CZ[i], fx, t.height(fx, fz) + 1.2, fz) ? 1 : 0;
    else {
      const lx = CX[i] + tdx * 60, lz = CZ[i] + tdz * 60;
      CLOS[i] = terrainLos(t, foliage, CX[i], eye, CZ[i], lx, t.height(lx, lz) + 1.2, lz) ? 1 : 0;
    }
  }
  out.count = n;
  for (let k = 0; k < n; k++) {
    const cl = cls[k];
    const outer = mode === PosMode.DEFEND_FLAG && (cl === SoldierClass.AT || cl === SoldierClass.SPOTTER);
    // Flag defence in a village: three riflemen hold the circle; any further ones may overwatch it from the
    // nearest buildings (a window looking onto the flag), as a real defence of a built-up position would.
    let innerBefore = 0;
    for (let j = 0; j < k; j++) if (cls[j] !== SoldierClass.AT && cls[j] !== SoldierClass.SPOTTER) innerBefore++;
    const overwatch = mode === PosMode.DEFEND_FLAG && !outer && innerBefore >= 3;
    let best = -1, bestS = -1e9;
    for (let i = 0; i < c; i++) {
      if (CUSED[i]) continue;
      const x = CX[i], z = CZ[i];
      let s = 0;
      const ci = CCOVER[i];
      if (ci >= 0) {
        // The prop must sit between the soldier and the threat (node normal points away from the threat).
        const dot = cover.nx[ci] * tdx + cover.nz[ci] * tdz;
        s += dot < -0.35 ? 1.1 : dot < 0.2 ? 0.3 : -0.4;
      }
      s += CLOS[i] * (mode === PosMode.SUPPORT ? 1.6 : 0.8);
      s += (CY[i] - h0) * (cl === SoldierClass.SPOTTER ? 0.16 : 0.06);
      s += foliage.at(x, z) * (mode === PosMode.HOLD ? 0.5 : 0.15);
      s -= (Math.hypot(x - px, z - pz) / radius) * 0.5;
      // Forward-facing arc for a flag defence: spread toward the threat side.
      const along = (x - px) * tdx + (z - pz) * tdz;
      if (mode !== PosMode.HOLD) s += Math.max(-0.4, Math.min(0.4, along / radius));
      if (mode === PosMode.DEFEND_FLAG) {
        const df = Math.hypot(x - fx, z - fz);
        if (!outer && !overwatch && df > captureR - 2) s -= 3;           // must stay on the flag to hold it
        if (overwatch) {
          const bld = ci >= 0 && cover.bld[ci] >= 0;
          if (df > captureR - 2 && !bld) s -= 1.5;          // outside the circle only from a building
          if (df > 36) s -= 3;
          if (ci >= 0 && cover.inside[ci]) {
            // A window that looks onto the flag (outward = -normal).
            const fdx = fx - x, fdz = fz - z, fl = Math.hypot(fdx, fdz) || 1;
            s += -(cover.nx[ci] * fdx + cover.nz[ci] * fdz) / fl > 0.3 ? 1.0 : -0.6;
          }
        }
        if (outer && df < captureR) s -= 0.3;               // AT / spotter cover the approaches
        if (outer && cl === SoldierClass.AT && t.roadAt(x + tdx * 30, z + tdz * 30) > 0.2) s += 0.6;
      }
      // Members prefer a post near where they already are (no walking across the position on a re-plan).
      if (mx && mz) { const dm = Math.hypot(x - mx[k], z - mz[k]); s -= Math.min(1.6, dm / radius * 2) - (dm < 2.5 ? 0.3 : 0); }
      // Buildings: a window position overlooking the threat side is a strong post in a village.
      if (ci >= 0 && cover.inside[ci]) s += 0.35;
      // An upper-floor window: a better field of view over the approaches (and over walls and hedges).
      if (ci >= 0 && cover.floor[ci] && mode !== PosMode.HOLD) s += 0.2;
      // Spacing: 5 m between fighting positions (on the same level; a post upstairs may sit above one downstairs).
      for (let j = 0; j < k; j++) {
        const nj = out.node[j], up = ci >= 0 && cover.floor[ci] ? 1 : 0, upJ = nj >= 0 && cover.floor[nj] ? 1 : 0;
        if (up === upJ && (out.x[j] - x) ** 2 + (out.z[j] - z) ** 2 < 25) { s -= 1.5; break; }
      }
      if (s > bestS) { bestS = s; best = i; }
    }
    if (best < 0) { out.x[k] = px; out.z[k] = pz; out.yaw[k] = threatYaw; out.stance[k] = Stance.CROUCH; out.node[k] = -1; continue; }
    CUSED[best] = 1;
    out.node[k] = CCOVER[best];
    out.x[k] = CX[best]; out.z[k] = CZ[best];
    out.yaw[k] = threatYaw + (hash01(seed + k, 3) - 0.5) * 0.9;
    const ci = CCOVER[best];
    // At a window: look out through it (the node normal points in, from the wall to the soldier).
    if (ci >= 0 && cover.inside[ci]) out.yaw[k] = Math.atan2(-cover.nx[ci], -cover.nz[ci]);
    out.stance[k] = ci >= 0 ? (cover.isLow(ci) ? Stance.CROUCH : Stance.STAND)
      : mode === PosMode.SUPPORT || cl === SoldierClass.SPOTTER ? Stance.PRONE : Stance.CROUCH;
  }
}

/**
 * Firing position for an armoured vehicle engaging an objective: on an arc
 * centred on `fromYaw` (the friendly side), `minD`–`maxD` from the
 * objective, with line of sight onto it from turret height, preferably
 * hull-down behind a crest, away from known enemy AT, on drivable ground.
 * @returns true and the point in out[0], out[1]
 */
export function pickFiringPosition(game: GameLike, foliage: FoliageField, ox: number, oz: number, fromYaw: number,
  minD: number, maxD: number, curX: number, curZ: number, atX: Float32Array, atZ: Float32Array, atN: number,
  seed: number, out: Float32Array, takenX?: Float32Array, takenZ?: Float32Array, takenN = 0): boolean {
  const t = game.map.terrain, nav = game.nav;
  const oy = t.height(ox, oz) + 1.5;
  let best = -1e9, found = false;
  for (let a = 0; a < 9; a++) {
    const ang = fromYaw + (a - 4) * 0.24 + (hash01(seed, a) - 0.5) * 0.1;
    for (let r = 0; r < 3; r++) {
      const d = minD + (maxD - minD) * (r / 2);
      const x = ox + Math.sin(ang) * d, z = oz + Math.cos(ang) * d;
      if (!t.inBounds(x, z, 30) || nav.blocked(x, z, true)) continue;
      const h = t.height(x, z);
      if (!terrainLos(t, foliage, x, h + 2.6, z, ox, oy, oz, 5)) continue;
      let s = 0;
      // Hull-down: ground just ahead (toward the objective) rises to cover the hull but not the gun.
      const kx = (ox - x) / d, kz = (oz - z) / d;
      const crest = t.height(x + kx * 7, z + kz * 7) - h;
      if (crest > 0.5 && crest < 1.9) s += 0.8;
      s -= Math.abs(a - 4) * 0.05;
      s -= Math.hypot(x - curX, z - curZ) * 0.002;
      for (let i = 0; i < atN; i++) {
        const da = Math.hypot(x - atX[i], z - atZ[i]);
        if (da < 140) s -= (140 - da) / 140 * 1.5;
      }
      // Spread out: other vehicles' firing positions are taken (one hull per spot, no stacking).
      if (takenX && takenZ) for (let i = 0; i < takenN; i++) if ((x - takenX[i]) ** 2 + (z - takenZ[i]) ** 2 < 15 * 15) s -= 2;
      if (s > best) { best = s; out[0] = x; out[1] = z; found = true; }
    }
  }
  return found;
}
