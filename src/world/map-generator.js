import { CONFIG } from '../core/config.js';
import { makeRng, fbm, smoothstep, lerp, clamp, TAU } from '../core/math.js';
import { Terrain, SURF } from './terrain.js';
import { VEHICLE_DEFS } from '../entities/vehicle-defs.js';
import { FACTIONS } from '../entities/factions.js';
import { FLAGS, BASES, BASE, ROADS, BASE_ROADS, BRIDGE_ROAD, RIVER, WADE, FIELDS, FORESTS, TRAILS, MAINLAND, ISLAND, toLayout, baseToWorld } from './layout.js';
import { createBuilding, resetBuildingIds } from './buildings.js';
import { buildSite } from './sites.js';
import { buildBase } from './base.js';

/**
 * @typedef {Object} Prop
 * @property {number} id
 * @property {string} type  tree, rock, log, bush, wall, barrier, crate, fence, streetlight, sandbag, container, ...
 * @property {number} x @property {number} y @property {number} z
 * @property {number} rot   yaw in radians
 * @property {number} hx @property {number} hy @property {number} hz  half extents (boxes)
 * @property {number} r     footprint radius (round props; 0 for boxes)
 * @property {number} scale
 * @property {number} hp
 * @property {boolean} alive
 * @property {boolean} destructible
 * @property {number} [hue]  colour variation (containers, cars)
 * @property {number} [base] team whose base the prop belongs to (walls)
 * @property {any} collider   physics handle, filled by PhysicsSystem
 * @property {number} instance  instance slot, filled by the renderer for destructibles
 */

/**
 * @typedef {Object} FlagDef
 * @property {number} id @property {string} name
 * @property {number} x @property {number} y @property {number} z
 * @property {number} owner  -1 neutral, otherwise team index
 * @property {boolean} base  a faction's military base: uncapturable spawn (always owned by `owner`)
 * @property {string} kind   site kind (layout.js) or 'base'
 * @property {number} radius site radius (metres)
 */

/**
 * @typedef {Object} VehicleSpawn
 * @property {string} type  key into VEHICLE_DEFS
 * @property {number} team  owning side (-1: neutral emplacement, manned by whoever holds it)
 * @property {number} x @property {number} z @property {number} yaw
 */

/**
 * @typedef {Object} Runway
 * @property {number} team  -1 for the outpost airstrip
 * @property {number} x0 @property {number} z0  start of the take-off run
 * @property {number} x1 @property {number} z1  far end
 * @property {number} dx @property {number} dz  unit direction start → end
 * @property {number} len @property {number} width
 * @property {number} yaw   take-off heading
 */

/**
 * @typedef {Object} BaseRecord
 * @property {number} team @property {number} x @property {number} z @property {number} inland
 * @property {number} flag  index of the base's spawn flag in `flags`
 * @property {number[]} hq  building ids of the four HQ buildings
 * @property {{x:number, z:number, team:number}[]} sams  autonomous SAM sites
 * @property {{x:number, z:number}[]} gates
 * @property {{x:number, z:number}} infantry @property {{x:number, z:number}} vehicles @property {{x:number, z:number}} aircraft
 * @property {{x:number, z:number}} flagpole @property {{x:number, z:number}} resupply
 * @property {{x:number, z:number}[]} helipads
 */

/**
 * @typedef {Object} GameMap
 * @property {Terrain} terrain
 * @property {FlagDef[]} flags   twelve objectives, then the two base spawn flags
 * @property {Prop[]} props
 * @property {import('./buildings.js').Building[]} buildings
 * @property {VehicleSpawn[]} vehicleSpawns  faction vehicles (all parked at the bases)
 * @property {VehicleSpawn[]} emplacements   static, crewable turrets and searchlights (team -1: neutral outpost guns)
 * @property {number[][]} roads  pairs of flag indices (base roads use the base flags)
 * @property {Runway[]} runways
 * @property {BaseRecord[]} bases
 * @property {{x:number, y:number, z:number, kind:string, prop:number, building:number}[]} lights
 * @property {{x:number, z:number, r:number, kind:string}[]} zones  ambient sound / atmosphere zones
 * @property {{x:number, z:number, r:number, team:number}[]} supplies  resupply / repair stations
 * @property {{x:number, z:number, building:number}} bridge
 * @property {{x:number, z:number}[]} fords
 */

/** Plateau banks widen with the height they bridge (run per metre of rise ≈ 18° average grade). */
const BANK_RUN = 3.1;
/** Steepest grade a graded road may have (rise / run, ≈ 15°). */
const ROAD_GRADE = 0.27;
const HARBOR_QUAY = 40;   // quay edge distance from a harbour flag, toward the sea
const HARBOR_H = 3.0;
const FORD_H = 0.6;

/**
 * Builds the whole battlefield deterministically from a seed: a 1344 m island
 * with rolling hills, a river, farmland and forests, twelve themed objective
 * sites with enterable buildings, two coastal military bases, graded roads,
 * a bridge, fords, airstrips, piers and environmental clutter.
 * @param {number} seed
 * @returns {GameMap}
 */
export function generateMap(seed = CONFIG.seed) {
  const { size, heightRes: res, waterLevel } = CONFIG.world;
  const terrain = new Terrain(size, res);
  const rng = makeRng(seed);
  const n = terrain.n, half = terrain.half, H = terrain.heights;
  resetBuildingIds();

  /** Calls fn(index, x, z) for every heightmap sample inside the world-space box. */
  const samples = (minX, maxX, minZ, maxZ, fn) => {
    const i0 = Math.max(0, Math.floor((minX + half) / res)), i1 = Math.min(n - 1, Math.ceil((maxX + half) / res));
    const j0 = Math.max(0, Math.floor((minZ + half) / res)), j1 = Math.min(n - 1, Math.ceil((maxZ + half) / res));
    for (let iz = j0; iz <= j1; iz++) {
      const z = -half + iz * res;
      for (let ix = i0; ix <= i1; ix++) fn(iz * n + ix, -half + ix * res, z);
    }
  };
  const lima = FLAGS[11];
  // Low-frequency relief is point-symmetric about the centre (mirrored objectives sit at the same
  // height with the same surroundings); the detail noise on top is not, so it never looks mirrored.
  const lowHalf = (x, z) => 19 * fbm(x / 430, z / 430, seed, 2) + 8 * fbm(x / 180 + 40, z / 180 - 17, seed + 7, 2);
  const lowAt = (x, z) => 14 + 0.5 * (lowHalf(x, z) + lowHalf(-x, -z)) * 1.25
    + (lima.lift || 0) * smoothstep(230, 60, Math.hypot(x - lima.x, z - lima.z));

  // ------------------------------------------------------------- 1) relief + coast
  samples(-half, half, -half, half, (i, x, z) => {
    const low = lowAt(x, z);
    const ridge = 1 - Math.abs(fbm(x / 110 - 9, z / 110 + 3, seed + 19, 3));
    let h = low + 6 * fbm(x / 70, z / 70, seed + 3, 3) + 5 * ridge * ridge * smoothstep(8, 30, low);
    // Mainland coast: the original 1344 m coastline profile, run along the spread mainland's edges.
    const edge = Math.max(Math.abs(x) - (MAINLAND.hx - 672), Math.abs(z - MAINLAND.oz) - (MAINLAND.hz - 672)) + 16 * fbm(x / 95, z / 95, seed + 55, 2);
    h -= smoothstep(672 - 95, 672 - 30, edge) * 52;
    // The offshore island NOVEMBER rises out of the sound: a low plateau with beaches.
    const ie = Math.hypot((x - ISLAND.x) / ISLAND.ax, (z - ISLAND.z) / ISLAND.az) + 0.06 * fbm(x / 60, z / 60, seed + 91, 2);
    if (ie < 1.35) h = Math.max(h, lerp(-6, ISLAND.h + 1.5 * fbm(x / 80, z / 80, seed + 93, 2), smoothstep(1.3, 0.92, ie)));
    H[i] = h;
  });

  // ------------------------------------------------------------- 2) flags, harbours, bases
  /** @type {FlagDef[]} */
  const flags = FLAGS.map((f, id) => ({ id, name: f.name, x: f.x, y: 0, z: f.z, owner: -1, base: false, kind: f.kind, radius: f.radius }));
  // Toward the open sea, judged in the original layout frame (the map is spread unevenly along x and z).
  const harborOut = (f) => { const L = toLayout(f.x, f.z); return Math.abs(L.z) > Math.abs(L.x) ? (L.z > 0 ? 0 : Math.PI) : (L.x > 0 ? Math.PI / 2 : -Math.PI / 2); };
  const plateau = (x, z, R, target) => {
    let rise = 0;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU;
      for (const off of [12, 30, 50]) rise = Math.max(rise, Math.abs(terrain.baseHeight(x + Math.cos(a) * (R + off), z + Math.sin(a) * (R + off)) - target));
    }
    const bank = clamp(rise * BANK_RUN, 24, 90);
    samples(x - R - bank, x + R + bank, z - R - bank, z + R + bank, (i, sx, sz) => {
      const w = smoothstep(R + bank, R, Math.hypot(sx - x, sz - z));
      if (w > 0) H[i] = lerp(H[i], target, w);
    });
  };
  for (const f of flags) {
    const harbor = f.kind.startsWith('harbor');
    const target = harbor ? HARBOR_H : f.kind === 'island-november' ? ISLAND.h : Math.max(lowAt(f.x, f.z), waterLevel + 3);
    plateau(f.x, f.z, f.radius * 0.95, target);
    f.y = target;
    if (harbor) {
      // Quay: a flat apron toward the sea, then a drop into deep water.
      const out = harborOut(f), c = Math.cos(out), s = Math.sin(out);
      samples(f.x - 140, f.x + 140, f.z - 140, f.z + 140, (i, x, z) => {
        const dx = x - f.x, dz = z - f.z, lx = dx * c - dz * s, lz = dx * s + dz * c;
        const side = smoothstep(105, 85, Math.abs(lx));
        if (lz > HARBOR_QUAY) H[i] = lerp(H[i], Math.min(H[i], HARBOR_H - (lz - HARBOR_QUAY) * 1.4), side);
        else if (lz > -10) H[i] = lerp(H[i], HARBOR_H, side * smoothstep(-10, 5, lz));
      });
    }
  }
  /** Base flatten: the base strip at the coast, a long bank inland and a quay drop seaward. */
  const baseH = BASES.map(() => clamp(lowAt(BASES[0].x + 40, BASES[0].z) - 8, 4.5, 11));
  BASES.forEach((b, k) => {
    const target = baseH[k], L = BASE.halfLength + 14;
    // Bank wide enough for vehicles (≈ 1 : 4.5 average, ≤ ~0.33 at its steepest) up to the surrounding ground.
    let rise = 0;
    for (let v = -L; v <= L; v += 40) for (const off of [40, 80, 120]) rise = Math.max(rise, terrain.baseHeight(b.x + (BASE.wall + off) * b.inland, b.z + v) - target);
    const bank = clamp(rise * 4.5, 40, 130);
    samples(b.x - BASE.wall - bank - 20, b.x + BASE.wall + bank + 20, b.z - L - bank, b.z + L + bank, (i, x, z) => {
      const u = (x - b.x) * b.inland, v = z - b.z;
      const out = Math.max(u - (BASE.wall + 12), Math.abs(v) - L, 0);
      if (u < BASE.coast) {
        const w = smoothstep(L + 40, L, Math.abs(v));
        H[i] = lerp(H[i], Math.min(H[i], target - (BASE.coast - u) * 0.9), w);
        if (H[i] > target && Math.abs(v) < L) H[i] = target;
        return;
      }
      const w = smoothstep(bank, 0, out);
      if (w > 0) H[i] = lerp(H[i], target, w);
    });
    // Harbour slips (PT4): basins cut in from the sea, a concrete launch ramp rising to the quay at the inland end.
    for (const sl of BASE.slips) {
      const floor = waterLevel - 3.2, RAMP = 16;
      samples(b.x - 140, b.x + 140, b.z - L - 40, b.z + L + 40, (i, x, z) => {
        const u = (x - b.x) * b.inland, v = (z - b.z) * b.inland;
        const dv = Math.abs(v - sl.v);
        if (u > BASE.slipInland + 1 || u < BASE.coast - 30 || dv > sl.hw + 1.5) return;
        const depth = u > BASE.slipInland - RAMP ? lerp(target, floor, (BASE.slipInland - u) / RAMP) : floor;
        const edge = smoothstep(sl.hw + 1.5, sl.hw, dv);
        H[i] = lerp(H[i], Math.min(H[i], depth), edge);
        if (dv < sl.hw && u > BASE.slipInland - RAMP - 2) terrain.surf[i] = SURF.CONCRETE;
      });
    }
  });

  // ------------------------------------------------------------- 3) roads
  /** @type {{a: number, b: number, pts: number[][], bridge: boolean}[]} */
  const roadLines = [];
  const gateNear = (b, f) => {
    let best = null, bd = 1e9;
    const gates = BASE.gateList;
    for (const g of gates) {
      const { x, z } = baseToWorld(b, g.u, g.v), d = Math.hypot(f.x - x, f.z - z);
      if (d < bd) { bd = d; best = { x, z, u: g.u, v: g.v }; }
    }
    return best;
  };
  const bend = (ax, az, bx, bz, straight) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (straight || len < 120) return [[ax, az], [bx, bz]];
    const nx = -(bz - az) / len, nz = (bx - ax) / len, k = (rng() - 0.5) * 0.16 * len;
    return [[ax, az], [lerp(ax, bx, 0.33) + nx * k * 0.8, lerp(az, bz, 0.33) + nz * k * 0.8], [lerp(ax, bx, 0.66) + nx * k, lerp(az, bz, 0.66) + nz * k], [bx, bz]];
  };
  for (const [a, b] of ROADS) {
    const fa = flags[a], fb = flags[b], bridge = a === BRIDGE_ROAD[0] && b === BRIDGE_ROAD[1];
    roadLines.push({ a, b, pts: bend(fa.x, fa.z, fb.x, fb.z, bridge), bridge });
  }
  const gateRoads = [];
  for (const [team, fi] of BASE_ROADS) {
    const b = BASES[team], f = flags[fi], g = gateNear(b, f);
    // Leave the gate straight out (25 m) before bending toward the objective.
    const ox = g.u === BASE.wall ? b.inland * 25 : 0, oz = g.u === BASE.wall ? 0 : Math.sign(g.v) * b.inland * 25;
    const pts = [[g.x - ox * 0.6, g.z - oz * 0.6], ...bend(g.x + ox, g.z + oz, f.x, f.z, false)];
    roadLines.push({ a: FLAGS.length + team, b: fi, pts, bridge: false });
    gateRoads.push({ team, gate: g });
  }
  const roadLen = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };
  /** Point at arc length s along a polyline. */
  const along = (pts, s, out) => {
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (s <= l || i === pts.length - 1) { const t = clamp(s / (l || 1), 0, 1); out[0] = lerp(pts[i - 1][0], pts[i][0], t); out[1] = lerp(pts[i - 1][1], pts[i][1], t); return out; }
      s -= l;
    }
    return out;
  };
  /** Distance from (x, z) to a polyline and the arc length of the closest point. */
  const polyDist = (pts, x, z, out) => {
    let best = 1e9, bs = 0, acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0], az = pts[i - 1][1], dx = pts[i][0] - ax, dz = pts[i][1] - az, l2 = dx * dx + dz * dz;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (l2 || 1), 0, 1);
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (d < best) { best = d; bs = acc + t * Math.sqrt(l2); }
      acc += Math.sqrt(l2);
    }
    out[0] = best; out[1] = bs;
    return out;
  };
  const _pd = [0, 0], _pt = [0, 0];
  // Roads stop at the edge of the street grid in towns and the village, and at the yard of other sites.
  const grid = flags.filter((f) => !f.kind.startsWith('harbor'));
  for (const f of grid) f.roadStop = f.kind === 'town-ruined' || f.kind === 'town-intact' || f.kind === 'village' ? 0.82 : 0.78;
  // Grade every road to a drivable profile (cut and fill), then paint the road mask.
  for (const r of roadLines) {
    const L = roadLen(r.pts), steps = Math.max(2, Math.ceil(L / 2)), step = L / steps;
    const prof = new Float32Array(steps + 1);
    for (let i = 0; i <= steps; i++) { along(r.pts, i * step, _pt); prof[i] = Math.max(terrain.baseHeight(_pt[0], _pt[1]), waterLevel + 1.6); }
    const g = ROAD_GRADE * step;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i <= steps; i++) prof[i] = clamp(prof[i], prof[i - 1] - g, prof[i - 1] + g);
      for (let i = steps - 1; i >= 0; i--) prof[i] = clamp(prof[i], prof[i + 1] - g, prof[i + 1] + g);
    }
    // Smooth the profile so crests and dips are rounded.
    for (let pass = 0; pass < 4; pass++) for (let i = 1; i < steps; i++) prof[i] = (prof[i - 1] + prof[i] * 2 + prof[i + 1]) / 4;
    r.prof = prof; r.step = step; r.len = L;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const [x, z] of r.pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    samples(minX - 18, maxX + 18, minZ - 18, maxZ + 18, (i, x, z) => {
      polyDist(r.pts, x, z, _pd);
      const d = _pd[0];
      if (d > 16) return;
      // Inside towns and the village the street grid takes over from the through-roads.
      if (grid.some((f) => Math.hypot(x - f.x, z - f.z) < f.radius * f.roadStop)) return;
      const k = clamp(_pd[1] / step, 0, steps), i0 = Math.floor(k), i1 = Math.min(steps, i0 + 1);
      H[i] = lerp(H[i], lerp(prof[i0], prof[i1], k - i0), smoothstep(16, 6, d));
      terrain.road[i] = Math.max(terrain.road[i], Math.round(smoothstep(6.5, 3.8, d) * 255));
    });
  }

  // ------------------------------------------------------------- 4) river, ford, wading spot, bridge
  const RP = RIVER.points, RW = RIVER.halfWidth, RB = RIVER.bankWidth;
  let rMinX = 1e9, rMaxX = -1e9, rMinZ = 1e9, rMaxZ = -1e9;
  for (const [x, z] of RP) { rMinX = Math.min(rMinX, x); rMaxX = Math.max(rMaxX, x); rMinZ = Math.min(rMinZ, z); rMaxZ = Math.max(rMaxZ, z); }
  const riverDist = (x, z) => polyDist(RP, x, z, _pd)[0];
  /** First crossing of a polyline with the river: point + direction. */
  const crossing = (pts) => {
    for (let i = 1; i < pts.length; i++) {
      for (let j = 1; j < RP.length; j++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i], [cx, cz] = RP[j - 1], [dx, dz] = RP[j];
        const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
        if (Math.abs(den) < 1e-9) continue;
        const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den, u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          const l = Math.hypot(bx - ax, bz - az);
          return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, dx: (bx - ax) / l, dz: (bz - az) / l };
        }
      }
    }
    return null;
  };
  const pre = new Float32Array(H); // heights before carving (fords ramp back up to these)
  // The valley widens where the river cuts through high ground (≈ 1 : 2.6 banks), so it is never a gorge.
  const VALLEY = 70, BRIDGE_L = 2 * (RW + RB) + 6;
  // The bridge road keeps its graded embankment up to the deck ends (the bridge spans the rest).
  const bridgeLine = roadLines.find((r) => r.bridge), bridgeX = bridgeLine ? crossing(bridgeLine.pts) : null;
  samples(rMinX - RW - VALLEY, rMaxX + RW + VALLEY, rMinZ - RW - VALLEY, rMaxZ + RW + VALLEY, (i, x, z) => {
    const d = riverDist(x, z);
    if (d > RW + VALLEY) return;
    const bank = clamp(Math.max(0, H[i]) * 2.6, RB, VALLEY);
    if (d > RW + bank) return;
    let keep = 0;
    if (bridgeX) {
      const dr = Math.abs((x - bridgeX.x) * -bridgeX.dz + (z - bridgeX.z) * bridgeX.dx), sb = Math.abs((x - bridgeX.x) * bridgeX.dx + (z - bridgeX.z) * bridgeX.dz);
      if (dr < 14 && sb > BRIDGE_L / 2 - 3) keep = smoothstep(14, 7, dr);
    }
    const wob = 0.3 * fbm(x / 9, z / 9, seed + 77, 2);
    let t = d < RW ? lerp(RIVER.depth, -0.7, smoothstep(RW * 0.35, RW, d)) + wob : lerp(-0.7, H[i], smoothstep(RW, RW + bank, d));
    t = lerp(t, H[i], keep);
    if (t < H[i]) { H[i] = t; terrain.road[i] = Math.round(terrain.road[i] * smoothstep(RW, RW + RB, d)); }
    if (d < RW + 3) terrain.surf[i] = SURF.MUD;
  });
  /** @type {{x:number, z:number}[]} */
  const fords = [];
  let bridgeAt = null;
  for (const r of roadLines) {
    const c = crossing(r.pts);
    if (!c) continue;
    if (r.bridge) { bridgeAt = c; continue; }
    fords.push({ x: c.x, z: c.z });
    // Ford: a gravel bar across the channel, and the road graded down both banks to it
    // (≤ 0.24 grade: cut where the bank is high, filled where the carve went too deep).
    const reach = 130;
    samples(c.x - reach, c.x + reach, c.z - reach, c.z + reach, (i, x, z) => {
      const dr = Math.abs((x - c.x) * -c.dz + (z - c.z) * c.dx); // distance from the road axis
      if (dr > 14) return;
      const s = Math.abs((x - c.x) * c.dx + (z - c.z) * c.dz);  // distance along the road from the crossing
      const ramp = FORD_H + Math.max(0, s - RW * 0.6) * 0.24;
      if (ramp >= pre[i] && H[i] >= pre[i] - 0.01) return;      // beyond the cut: original ground
      const target = Math.min(pre[i], ramp);
      const w = smoothstep(14, 7, dr);
      H[i] = lerp(H[i], target, w);
      if (dr < 7 && riverDist(x, z) < RW + 4) terrain.surf[i] = SURF.GRAVEL;
      if (dr < 6) terrain.road[i] = Math.max(terrain.road[i], 200);
    });
  }
  for (const wd of WADE) {
    // Shallow bar where infantry can wade across (too deep for vehicles).
    let best = null, bd = 1e9;
    for (let x = wd.x - 30; x <= wd.x + 30; x += 2) for (let z = rMinZ; z <= rMaxZ; z += 2) { const d = riverDist(x, z); if (d < bd && Math.abs(x - wd.x) < 3) { bd = d; best = { x, z }; } }
    if (!best) continue;
    samples(best.x - 40, best.x + 40, best.z - 40, best.z + 40, (i, x, z) => {
      const d = Math.hypot(x - best.x, z - best.z);
      if (d > 14) return;
      const t = Math.min(pre[i], wd.depth + Math.max(0, riverDist(x, z) - RW * 0.5) * 0.18);
      if (t > H[i]) H[i] = lerp(H[i], t, smoothstep(14, 9, d));
      if (riverDist(x, z) < RW + 2) terrain.surf[i] = SURF.GRAVEL;
    });
    fords.push({ x: best.x, z: best.z, infantry: true });
  }

  // ------------------------------------------------------------- 5) farm fields, trails
  for (const f of FIELDS) {
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw), R = Math.hypot(f.hx, f.hz) + 12;
    let target = 0, cnt = 0;
    samples(f.x - f.hx, f.x + f.hx, f.z - f.hz, f.z + f.hz, (i) => { target += H[i]; cnt++; });
    target = Math.max(target / Math.max(1, cnt), waterLevel + 2);
    samples(f.x - R, f.x + R, f.z - R, f.z + R, (i, x, z) => {
      const dx = x - f.x, dz = z - f.z, lx = dx * c - dz * s, lz = dx * s + dz * c;
      const ex = Math.abs(lx) - f.hx, ez = Math.abs(lz) - f.hz, out = Math.max(ex, ez, 0);
      const w = smoothstep(12, 0, out);
      if (w <= 0) return;
      if (terrain.road[i] > 60) return;
      H[i] = lerp(H[i], target + 0.25 * fbm(x / 40, z / 40, seed + 5, 2), w * 0.9);
      if (ex < 0 && ez < 0 && H[i] > waterLevel + 1) {
        terrain.surf[i] = f.crop;
        // Irrigation ditches along the long edges.
        if (Math.abs(ez) < 1.6 || Math.abs(lx) < 1.2) { terrain.surf[i] = SURF.DITCH; H[i] -= 0.45; }
      }
    });
  }
  for (const t of TRAILS) {
    for (let k = 1; k < t.length; k++) {
      const [ax, az] = t[k - 1], [bx, bz] = t[k];
      samples(Math.min(ax, bx) - 6, Math.max(ax, bx) + 6, Math.min(az, bz) - 6, Math.max(az, bz) + 6, (i, x, z) => {
        if (polyDist([t[k - 1], t[k]], x, z, _pd)[0] < 2.2 && terrain.surf[i] === 0) terrain.surf[i] = SURF.MUD;
      });
    }
  }

  // ------------------------------------------------------------- 6) sites, bases, structures
  /** @type {Prop[]} */
  const props = [];
  /** @type {import('./buildings.js').Building[]} */
  const buildings = [];
  /** @type {VehicleSpawn[]} */
  const emplacements = [];
  /** @type {Runway[]} */
  const runways = [];
  const lights = [], zones = [], supplies = [], helipads = [[], []];
  /** Footprint flatten records, re-applied after all terrain shaping. */
  const pads = [];
  const add = (type, x, z, rot, o) => {
    /** @type {Prop} */
    const p = { id: props.length, type, x, y: 0, z, rot, hx: 0, hy: 0, hz: 0, r: 0, scale: 1, hp: 0, alive: true, destructible: false, collider: null, instance: -1, ...o };
    p.maxHp = p.hp;
    props.push(p);
    return p;
  };
  const flattenRect = (x, z, rot, hw, hd, target, blend = 6) => {
    const c = Math.cos(rot), s = Math.sin(rot), R = Math.hypot(hw, hd) + blend;
    samples(x - R, x + R, z - R, z + R, (i, sx, sz) => {
      const dx = sx - x, dz = sz - z, lx = dx * c - dz * s, lz = dx * s + dz * c;
      const out = Math.max(Math.abs(lx) - hw, Math.abs(lz) - hd, 0);
      const w = smoothstep(blend, 0, out);
      if (w > 0) H[i] = lerp(H[i], target, w);
    });
  };
  const flattenDisc = (x, z, r, target, blend = 6) => {
    samples(x - r - blend, x + r + blend, z - r - blend, z + r + blend, (i, sx, sz) => {
      const w = smoothstep(r + blend, r, Math.hypot(sx - x, sz - z));
      if (w > 0) H[i] = lerp(H[i], target, w);
    });
  };
  const paint = (x, z, rot, hw, hd, surf) => {
    const c = Math.cos(rot), s = Math.sin(rot), R = Math.hypot(hw, hd);
    samples(x - R, x + R, z - R, z + R, (i, sx, sz) => {
      const dx = sx - x, dz = sz - z;
      if (Math.abs(dx * c - dz * s) <= hw && Math.abs(dx * s + dz * c) <= hd) terrain.surf[i] = surf;
    });
  };
  /** Accepts a building: ids are indices into `buildings` (rejected lots never take one). */
  const addBuilding = (b) => { b.id = buildings.length; buildings.push(b); return b; };
  /** Oriented-rectangle overlap with the buildings placed so far (2.5 m clearance). */
  const corners = (b, pad) => {
    const c = Math.cos(b.rot), s = Math.sin(b.rot), hw = b.w / 2 + pad, hd = b.d / 2 + pad;
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => [b.x + lx * c + lz * s, b.z - lx * s + lz * c]);
  };
  const sepAxis = (A, B) => {
    for (const P of [A, B]) for (let i = 0; i < 4; i++) {
      const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % 4], nx = z1 - z0, nz = x0 - x1;
      let aMin = 1e18, aMax = -1e18, bMin = 1e18, bMax = -1e18;
      for (const [x, z] of A) { const d = x * nx + z * nz; aMin = Math.min(aMin, d); aMax = Math.max(aMax, d); }
      for (const [x, z] of B) { const d = x * nx + z * nz; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d); }
      if (aMax < bMin || bMax < aMin) return true;
    }
    return false;
  };
  const overlaps = (b) => {
    const A = corners(b, 1.25), r = Math.hypot(b.w, b.d) / 2 + 3;
    return buildings.some((o) => Math.hypot(o.x - b.x, o.z - b.z) < r + Math.hypot(o.w, o.d) / 2 && !sepAxis(A, corners(o, 1.25)));
  };
  /** Building would sit on an inter-site road or in the river. */
  const onRoad = (b) => corners(b, 0.5).concat([[b.x, b.z]]).some(([x, z]) => terrain.roadAt(x, z) > 0.45 && terrain.surfAt(x, z) !== SURF.STREET)
    || riverDist(b.x, b.z) < RW + RB + Math.hypot(b.w, b.d) / 2;
  const ctx = {
    rng,
    building(type, x, z, rot, o = {}) {
      const b = createBuilding(type, x, 0, z, rot, rng, o);
      const inTown = grid.some((f) => f.roadStop > 0.8 && Math.hypot(f.x - x, f.z - z) < f.radius + 10);
      if (!o.force && (overlaps(b) || (inTown && onRoad(b)))) return null;
      const target = terrain.baseHeight(x, z);
      flattenRect(x, z, rot, b.w / 2 + 1.5, b.d / 2 + 1.5, target, 5);
      b.y = target;
      addBuilding(b);
      pads.push({ kind: 'rect', x, z, rot, hw: b.w / 2 + 1.2, hd: b.d / 2 + 1.2, y: target, building: b });
      return b;
    },
    prop(type, x, z, rot, o = {}) { return add(type, x, z, rot, o); },
    light(x, y, z, kind, prop = -1) { lights.push({ x, y, z, kind, prop, building: -1 }); },
    /** Light at an absolute height, tied to a building (dark once it is ruined). */
    lampAbs(x, y, z, kind, building = -1) { lights.push({ x, y, z, kind, prop: -1, building, abs: true }); },
    groundAt(x, z) { return terrain.baseHeight(x, z); },
    /** Hand-built structure (explicit parts, building frame); `nonav` for flat markings. */
    structure(name, x, z, rot, parts, o = {}) {
      const y = o.y ?? terrain.baseHeight(x, z);
      const b = createBuilding('custom', x, y, z, rot, rng, { w: o.w || 4, d: o.d || 4, parts, invulnerable: true, name });
      if (o.nonav) b.nonav = true;
      addBuilding(b);
      return b;
    },
    zone(x, z, r, kind) { zones.push({ x, z, r, kind }); },
    supply(x, z, r, team = -1) { supplies.push({ x, z, r, team }); paint(x, z, 0, r * 0.7, r * 0.7, SURF.CONCRETE); },
    paveRect(x, z, hw, hd, rot) {
      const target = terrain.baseHeight(x, z);
      flattenRect(x, z, rot, hw, hd, target, 5);
      paint(x, z, rot, hw, hd, SURF.CONCRETE);
      pads.push({ kind: 'rect', x, z, rot, hw, hd, y: target, soft: true });
    },
    paveDisc(x, z, r) {
      const target = terrain.baseHeight(x, z);
      flattenDisc(x, z, r, target, 5);
      samples(x - r, x + r, z - r, z + r, (i, sx, sz) => { if (Math.hypot(sx - x, sz - z) <= r) terrain.surf[i] = SURF.CONCRETE; });
      pads.push({ kind: 'disc', x, z, r, y: target, soft: true });
    },
    helipad(team, x, z) { ctx.paveDisc(x, z, 10); if (team >= 0) helipads[team].push({ x, z }); },
    street(ax, az, bx, bz, w) {
      const pts = [[ax, az], [bx, bz]];
      samples(Math.min(ax, bx) - w, Math.max(ax, bx) + w, Math.min(az, bz) - w, Math.max(az, bz) + w, (i, x, z) => {
        const d = polyDist(pts, x, z, _pd)[0];
        if (d > w / 2 + 1) return;
        if (terrain.surf[i] === 0 || terrain.surf[i] === SURF.MUD) terrain.surf[i] = SURF.STREET;
        terrain.road[i] = Math.max(terrain.road[i], Math.round(smoothstep(w / 2 + 1, w / 2 - 1, d) * 200));
      });
    },
    flatten(x, z, r) { flattenDisc(x, z, r, terrain.baseHeight(x, z)); },
    /** Shell crater: a bowl `depth` deep with a low raised rim (prone cover). */
    crater(x, z, r, depth) {
      samples(x - r * 1.5, x + r * 1.5, z - r * 1.5, z + r * 1.5, (i, sx, sz) => {
        const d = Math.hypot(sx - x, sz - z) / r;
        if (d < 1) H[i] -= depth * (1 - d * d);
        else if (d < 1.5) H[i] += depth * 0.35 * Math.sin((d - 1) / 0.5 * Math.PI);
        if (d < 1.2 && terrain.surf[i] !== SURF.CONCRETE) terrain.surf[i] = SURF.MUD;
      });
    },
    vehicle(type, team, x, z, yaw) { emplacements.push({ type, team, x, z, yaw }); },
    runway(team, x0, z0, x1, z1, width) {
      const len = Math.hypot(x1 - x0, z1 - z0), dx = (x1 - x0) / len, dz = (z1 - z0) / len;
      const rw = { team, x0, z0, x1, z1, dx, dz, len, width, yaw: Math.atan2(dx, dz) };
      runways.push(rw);
      const h0 = terrain.baseHeight(x0, z0), h1 = h0 + clamp(terrain.baseHeight(x1, z1) - h0, -4, 4);
      // Wide shoulders: the strip is cut / filled into the slope with gentle embankments vehicles can cross.
      const hw = width / 2, blend = 42, R = len / 2 + hw + blend, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      samples(cx - R, cx + R, cz - R, cz + R, (i, x, z) => {
        const u = (x - x0) * dx + (z - z0) * dz, v = Math.abs((x - x0) * -dz + (z - z0) * dx);
        const outU = Math.max(-u, u - len, 0);
        if (outU > blend || v > hw + blend) return;
        const w = smoothstep(hw + blend, hw + 2, v) * smoothstep(blend, 0, outU);
        H[i] = lerp(H[i], lerp(h0, h1, clamp(u / len, 0, 1)), w);
        if (v < hw && outU === 0) { terrain.paved[i] = 255; terrain.surf[i] = SURF.CONCRETE; }
      });
      pads.push({ kind: 'runway', rw });
      // Edge lights every 30 m (lit at night).
      for (let u = 0; u <= len; u += 30) for (const sd of [-1, 1]) {
        lights.push({ x: x0 + dx * u - dz * sd * (hw + 1), y: 0.4, z: z0 + dz * u + dx * sd * (hw + 1), kind: 'runway', prop: -1, building: -1 });
      }
      return rw;
    },
    pier(x, z, yaw, len, w) {
      const c = Math.sin(yaw), s = Math.cos(yaw); // direction (sin, cos)
      const cx = x + c * len / 2, cz = z + s * len / 2, y = terrain.baseHeight(x, z);
      const parts = [{ x: 0, y: -0.2, z: 0, hx: w / 2, hy: 0.2, hz: len / 2, c: 0x6e5a44, k: 1, lod: 1 }];
      for (let k = -len / 2 + 2; k <= len / 2; k += 6) for (const sd of [-1, 1]) {
        parts.push({ x: sd * (w / 2 - 0.3), y: -3.2, z: k, hx: 0.25, hy: 3, hz: 0.25, c: 0x4a3c2c, k: 7, lod: 1 });
        parts.push({ x: sd * (w / 2 - 0.4), y: 0.25, z: k + 3, hx: 0.18, hy: 0.25, hz: 0.18, c: 0x2e2e2e, k: 5, lod: 0 });
      }
      const b = createBuilding('custom', cx, y, cz, yaw, rng, { w, d: len, parts, invulnerable: true, deck: true, name: 'pier' });
      addBuilding(b);
      terrain.decks.push(deckOf(b, y, y, w / 2 - 0.4, len / 2));
      return b;
    },
    tunnel(ax, az, bx, bz) {
      // Cut-and-cover passage: a trench below street level, roofed in the middle, open stairs at both ends.
      const len = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / len, dz = (bz - az) / len;
      const g0 = terrain.baseHeight(ax, az), RAMP = 10, DEPTH = 3.3;
      samples(Math.min(ax, bx) - 8, Math.max(ax, bx) + 8, Math.min(az, bz) - 8, Math.max(az, bz) + 8, (i, x, z) => {
        const u = (x - ax) * dx + (z - az) * dz, v = Math.abs((x - ax) * -dz + (z - az) * dx);
        if (u < 0 || u > len || v > 2.6) return;
        const depth = DEPTH * Math.min(1, u / RAMP, (len - u) / RAMP);
        H[i] = Math.min(H[i], g0 - depth);
        terrain.surf[i] = SURF.CONCRETE;
      });
      const parts = [{ x: 0, y: -0.18, z: 0, hx: 2.9, hy: 0.18, hz: (len - 2 * RAMP) / 2, c: 0x6f6a62, k: 2, lod: 1 }];
      for (const sd of [-1, 1]) parts.push({ x: sd * 2.45, y: -DEPTH / 2, z: 0, hx: 0.2, hy: DEPTH / 2, hz: len / 2 - 1, c: 0x77736b, k: 0, lod: 1 });
      // Rails around the open stair wells.
      for (const end of [-1, 1]) for (const sd of [-1, 1]) parts.push({ x: sd * 2.7, y: 0.5, z: end * (len / 2 - RAMP / 2), hx: 0.05, hy: 0.5, hz: RAMP / 2, c: 0x3a3d40, k: 5, lod: 0 });
      const b = createBuilding('custom', (ax + bx) / 2, g0, (az + bz) / 2, Math.atan2(dx, dz), rng, { w: 5.8, d: len, parts, invulnerable: true, name: 'tunnel' });
      addBuilding(b);
      for (let u = RAMP + 4; u < len - RAMP; u += 9) lights.push({ x: ax + dx * u, y: -0.8, z: az + dz * u, kind: 'tunnel', prop: -1, building: b.id });
      return b;
    },
  };
  /** Terrain deck record for a building laid along its local z. */
  const deckOf = (b, y0, y1, hw, hl) => {
    const c = Math.cos(b.rot), s = Math.sin(b.rot), R = Math.hypot(hw, hl) + 1;
    return { x: b.x, z: b.z, c, s, hw, hl, y0, y1, alive: true, minX: b.x - R, maxX: b.x + R, minZ: b.z - R, maxZ: b.z + R, building: b.id };
  };

  // Objective sites, aligned with their most important road.
  for (const f of flags) {
    let yaw = 0;
    const r = roadLines.find((rl) => rl.a === f.id || rl.b === f.id);
    if (r) {
      const p = r.a === f.id ? r.pts[1] : r.pts[r.pts.length - 2];
      yaw = Math.atan2(p[0] - f.x, p[1] - f.z);
    }
    if (f.kind.startsWith('harbor')) yaw = harborOut(f);
    f.yaw = buildSite(ctx, f, yaw);
  }
  // Military bases.
  /** @type {BaseRecord[]} */
  const bases = [];
  BASES.forEach((b, team) => {
    const rec = buildBase(ctx, b, BASE);
    rec.flag = flags.length + team;
    rec.helipads = helipads[team];
    bases.push(rec);
  });
  for (const rec of bases) {
    const team = rec.team;
    flags.push({ id: flags.length, name: CONFIG.teams[team].name, x: rec.flagpole.x, y: 0, z: rec.flagpole.z, owner: team, base: true, kind: 'base', radius: 150 });
  }

  // The bridge over the river on its road.
  let bridge = null;
  if (bridgeAt) {
    const L = BRIDGE_L, hw = 4.6;
    const ax = bridgeAt.x - bridgeAt.dx * L / 2, az = bridgeAt.z - bridgeAt.dz * L / 2;
    const bx = bridgeAt.x + bridgeAt.dx * L / 2, bz = bridgeAt.z + bridgeAt.dz * L / 2;
    const y0 = Math.max(terrain.baseHeight(ax, az), 2), y1 = Math.max(terrain.baseHeight(bx, bz), 2);
    // Abutments: level the approach to the deck ends.
    flattenDisc(ax - bridgeAt.dx * 3, az - bridgeAt.dz * 3, 6, y0, 8);
    flattenDisc(bx + bridgeAt.dx * 3, bz + bridgeAt.dz * 3, 6, y1, 8);
    const ym = (y0 + y1) / 2, tilt = -Math.atan2(y1 - y0, L), bed = RIVER.depth;
    const parts = [{ x: 0, y: -0.3, z: 0, hx: hw, hy: 0.3, hz: L / 2, c: 0x77746c, k: 1, lod: 1, rx: tilt }];
    const ruined = [];
    for (const sd of [-1, 1]) {
      parts.push({ x: sd * (hw - 0.15), y: 0.55, z: 0, hx: 0.15, hy: 0.55, hz: L / 2, c: 0x8d8a82, k: 0, lod: 1, rx: tilt });
      for (const pz of [-RW + 3, 0, RW - 3]) {
        const top = ym + (y1 - y0) * (pz / L) - 0.6, hy = (top - bed) / 2;
        const pier = { x: sd * (hw - 1.2), y: bed + hy - ym, z: pz, hx: 0.7, hy, hz: 0.9, c: 0x6f6a62, k: 7, lod: 1 };
        parts.push(pier); ruined.push(pier);
      }
    }
    // Ruined: deck stubs at both ends, broken slabs in the water.
    for (const end of [-1, 1]) {
      const yE = (end < 0 ? y0 : y1) - ym;
      ruined.push({ x: 0, y: yE - 0.3, z: end * (L / 2 - 4), hx: hw, hy: 0.3, hz: 4, c: 0x77746c, k: 1, lod: 1 });
      ruined.push({ x: (rng() - 0.5) * 3, y: bed + 0.4 - ym, z: end * 8, hx: 3.5, hy: 0.4, hz: 5, c: 0x6f6a62, k: 6, lod: 1, rz: 0.25 * end });
    }
    const b = createBuilding('bridge', bridgeAt.x, ym, bridgeAt.z, Math.atan2(bridgeAt.dx, bridgeAt.dz), rng, { w: hw * 2, d: L, parts, ruined, deck: true, hp: 2600 });
    addBuilding(b);
    terrain.decks.push(deckOf(b, y0, y1, hw - 0.3, L / 2));
    bridge = { x: b.x, z: b.z, building: b.id };
    zones.push({ x: b.x, z: b.z, r: 90, kind: 'river' });
    for (const sd of [-1, 1]) for (const end of [-1, 1]) {
      const lx = sd * (hw + 0.3), lz = end * (L / 2 - 2), c = Math.cos(b.rot), s = Math.sin(b.rot);
      const p = add('streetlight', b.x + lx * c + lz * s, b.z - lx * s + lz * c, b.rot, { hx: 0.12, hy: 3.6, hz: 0.12, hp: 60, destructible: true });
      lights.push({ x: p.x, y: 7, z: p.z, kind: 'street', prop: p.id, building: -1 });
    }
  }
  for (const f of fords) zones.push({ x: f.x, z: f.z, r: 70, kind: 'river' });
  for (const f of FORESTS) zones.push({ x: f.x, z: f.z, r: f.r * 0.85, kind: 'forest' });

  // Re-level every building and pad footprint (later shaping must not tilt them).
  for (const p of pads) {
    if (p.kind === 'rect') flattenRect(p.x, p.z, p.rot, p.hw, p.hd, p.y, p.soft ? 4 : 3);
    else if (p.kind === 'disc') flattenDisc(p.x, p.z, p.r, p.y, 4);
  }
  for (const f of flags) f.y = terrain.baseHeight(f.x, f.z);
  // Rooftop objectives: index of the host building (for the AI's stair routes).
  for (const f of flags) if (f.host) f.hostIndex = buildings.indexOf(f.host);
  // Night emissives: lit windows in about a third of the buildings (two each) and a beacon atop every flag pole.
  for (let bi = 0; bi < buildings.length; bi++) {
    const b = buildings[bi];
    if (b.type === 'custom' || b.state >= 2 || !b.openings || rng() > 0.35) continue;
    const wins = b.openings.filter((o) => o.kind === 'window');
    for (let k = 0; k < 2 && wins.length; k++) {
      const o = wins[Math.floor(rng() * wins.length)], c = Math.cos(b.rot), s = Math.sin(b.rot);
      const lx = o.side === 2 ? b.w / 2 + 0.05 : o.side === 3 ? -b.w / 2 - 0.05 : o.u, lz = o.side === 0 ? b.d / 2 + 0.05 : o.side === 1 ? -b.d / 2 - 0.05 : o.u;
      lights.push({ x: b.x + lx * c + lz * s, y: b.y + o.floor * b.fh + (o.y0 + o.y1) / 2, z: b.z - lx * s + lz * c, kind: 'window', prop: -1, building: bi, abs: true });
    }
  }
  for (const f of flags) {
    const top = f.host ? f.host.y + f.host.floors * f.host.fh : f.y;
    // Absolute height (the other lights are ground-relative): exactly at the pole top, wherever the pole stands.
    lights.push({ x: f.x, y: top + (f.base ? 17.8 : 11.2), z: f.z, kind: 'beacon', prop: -1, building: f.host ? f.hostIndex : -1, abs: true, flag: flags.indexOf(f) });
  }

  // ------------------------------------------------------------- 7) vehicle parks
  /** @type {VehicleSpawn[]} */
  const vehicleSpawns = [];
  const slots = [];
  const inBuilding = (x, z, r) => buildings.some((b) => {
    if (b.name === 'pier' || b.name === 'tunnel' || b.nonav) return false;
    const c = Math.cos(b.rot), s = Math.sin(b.rot), dx = x - b.x, dz = z - b.z;
    const lx = Math.abs(dx * c - dz * s), lz = Math.abs(dx * s + dz * c);
    return lx < b.w / 2 + r + 1.5 && lz < b.d / 2 + r + 1.5;
  });
  const onRunway = (x, z, pad) => runways.some((rw) => {
    const u = (x - rw.x0) * rw.dx + (z - rw.z0) * rw.dz, v = Math.abs((x - rw.x0) * -rw.dz + (z - rw.z0) * rw.dx);
    return u > -pad && u < rw.len + pad && v < rw.width / 2 + pad;
  });
  const slotFree = (x, z, r) => !slots.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + r + 1.8) ** 2);
  /** Garage category of each ground vehicle type (anything else parks in the assembly area / reserve garage). */
  const CAT = {
    mbt: 'tanks', ht: 'tanks', lt: 'tanks', tank: 'tanks', cev: 'tanks',
    apc: 'armoured', ifv: 'armoured', ifv2: 'armoured', brdm: 'armoured', tigr: 'armoured',
    truck: 'transport', uaz: 'transport', jeep: 'transport',
    supply: 'supply', atcst: 'supply', ost: 'supply',
    mlrs: 'artillery', howitzer: 'artillery', grad: 'artillery', smerch: 'artillery',
    tel: 'missile',
  };
  for (const rec of bases) {
    const team = rec.team;
    const faction = FACTIONS[CONFIG.teams[team].faction];
    const items = [];
    for (const entry of faction.roster) for (let k = 0; k < entry.count; k++) items.push({ ...entry, r: VEHICLE_DEFS[entry.type].padRadius });
    items.sort((a, c) => c.r - a.r);
    const rw = runways.find((w) => w.team === team);
    // Jets: on the taxiway stand in front of their own hangar, nose toward the runway (they taxi out onto the
    // centreline before the take-off roll, and taxi back to the stand after landing; see flyJet).
    const perStand = new Map(), bt = BASES[team];
    for (const it of items.filter((i) => i.site === 'runway')) {
      const st = rec.stands.find((s) => s.types.includes(it.type)) || rec.stands[perStand.size % rec.stands.length];
      const k = perStand.get(st) || 0; perStand.set(st, k + 1);
      // Two aircraft share a stand (strike jet and light attack): side by side across the hangar door.
      const n = items.filter((i) => i.site === 'runway' && st.types.includes(i.type)).length;
      const p = baseToWorld(bt, 9, st.v + (n > 1 ? (k === 0 ? -1 : 1) * st.w / 4 : 0));
      vehicleSpawns.push({ type: it.type, team, x: p.x, z: p.z, yaw: Math.atan2(-bt.inland, 0) });
      slots.push({ x: p.x, z: p.z, r: it.r });
    }
    // Helicopters: each on a pad in front of its type's hangar (reserve pads in the harbour take the rest).
    const padUsed = new Set();
    for (const it of items.filter((i) => i.site === 'helipad')) {
      let best = -1;
      for (let k = 0; k < rec.pads.length && best < 0; k++) if (!padUsed.has(k) && rec.pads[k].types[0] === it.type) best = k;
      for (let k = 0; k < rec.pads.length && best < 0; k++) if (!padUsed.has(k) && rec.pads[k].types.includes(it.type) && rec.pads[k].r >= it.r - 0.5) best = k;
      for (let k = 0; k < rec.pads.length && best < 0; k++) if (!padUsed.has(k) && rec.pads[k].r >= it.r - 0.5) best = k;
      if (best < 0) { console.warn(`[map] no helipad for ${it.type}`); continue; }
      padUsed.add(best);
      const pd = rec.pads[best];
      vehicleSpawns.push({ type: it.type, team, x: pd.x, z: pd.z, yaw: Math.atan2(-rec.inland, 0) });
      slots.push({ x: pd.x, z: pd.z, r: it.r });
    }
    // Ground vehicles: into the bays of their garage; air defence and overflow to the assembly area, then the
    // harbour's reserve garage. Every bay and assembly slot is also a parking slot for returning vehicles.
    const parkSlots = [];
    const addSlot = (sl, row) => { const ps = { x: sl.x, z: sl.z, yaw: sl.yaw, r: sl.r, row, team, ax: sl.ax, az: sl.az, len: sl.len || 9.6, taken: false }; parkSlots.push(ps); return ps; };
    const bayGroups = {};
    for (const [cat, list] of Object.entries(rec.garages)) bayGroups[cat] = list.map((sl) => addSlot(sl, 2));
    const assembly = rec.assembly.map((sl) => addSlot(sl, 0));
    const lengthOf = (type) => VEHICLE_DEFS[type].half[2] * 2 + 0.6;
    const takeFrom = (list, type) => {
      for (const ps of list) if (!ps.taken && ps.len >= lengthOf(type)) { ps.taken = true; return ps; }
      return null;
    };
    const ground = items.filter((i) => i.site === 'base' || i.site === 'forward');
    // Longest first, so long launchers get the deep bays.
    ground.sort((x, y) => lengthOf(y.type) - lengthOf(x.type));
    for (const it of ground) {
      let ps = null;
      if (it.type === 'radar' && rec.radarStand) { const s0 = rec.radarStand; vehicleSpawns.push({ type: it.type, team, x: s0.x, z: s0.z, yaw: s0.yaw }); slots.push({ x: s0.x, z: s0.z, r: 6 }); continue; }
      const cat = CAT[it.type];
      if (cat) ps = takeFrom(bayGroups[cat] || [], it.type);
      if (!ps) ps = takeFrom(assembly, it.type);
      if (!ps) ps = takeFrom(bayGroups.reserve || [], it.type);
      if (!ps) for (const list of Object.values(bayGroups)) if (!ps) ps = takeFrom(list, it.type);
      if (!ps) { console.warn(`[map] no parking for ${it.type}`); continue; }
      slots.push({ x: ps.x, z: ps.z, r: 4.8 });
      vehicleSpawns.push({ type: it.type, team, x: ps.x, z: ps.z, yaw: ps.yaw });
    }
    rec.parkSlots = parkSlots.map(({ taken, ...p }) => { void taken; return p; });
  }

  // ------------------------------------------------------------- 8) nature and clutter
  const siteNear = (x, z, pad) => flags.some((f) => !f.base && Math.hypot(f.x - x, f.z - z) < f.radius * 0.8 + pad);
  const baseNear = (x, z, pad) => BASES.some((b) => {
    const u = (x - b.x) * b.inland, v = z - b.z;
    return u > BASE.coast - pad && u < BASE.wall + pad && Math.abs(v) < BASE.halfLength + pad;
  });
  const forestAt = (x, z) => {
    let d = 0;
    for (const f of FORESTS) d = Math.max(d, f.density * smoothstep(f.r, f.r * 0.45, Math.hypot(x - f.x, z - f.z)));
    return d;
  };
  const trailNear = (x, z) => TRAILS.some((t) => polyDist(t, x, z, _pd)[0] < 4);
  const fieldAt = (x, z) => { const s = terrain.surfAt(x, z); return s >= SURF.WHEAT && s <= SURF.DITCH; };
  const naturalOk = (x, z) => {
    const y = terrain.baseHeight(x, z);
    return y > waterLevel + 1.4 && terrain.slope(x, z) < 0.6 && terrain.roadAt(x, z) < 0.04 && !fieldAt(x, z)
      && terrain.surfAt(x, z) !== SURF.CONCRETE && terrain.surfAt(x, z) !== SURF.STREET && riverDist(x, z) > RW + 3;
  };
  // Trees: sparse groves everywhere, dense woods in forest zones (clearings from noise).
  // (Counts scaled to the 2280 m map: about twice the land area of the 1344 m island.)
  for (let i = 0; i < 52000 && props.length < 15000; i++) {
    const x = (rng() - 0.5) * (size - 70), z = (rng() - 0.5) * (size - 70);
    const fz = forestAt(x, z);
    const grove = fbm(x / 120 + 5, z / 120 - 8, seed + 101, 2);
    const clearing = fbm(x / 45 - 3, z / 45 + 11, seed + 131, 2) < -0.38;
    const chance = fz > 0 ? (clearing ? 0.04 : 0.15 + fz * 0.85) : grove > 0.18 ? 0.35 : 0.02;
    if (rng() > chance) continue;
    if (!naturalOk(x, z) || siteNear(x, z, 12) || baseNear(x, z, 45) || trailNear(x, z)) continue;
    const kind = fz > 0.5 && rng() < 0.05 ? 'log' : fz > 0.3 && rng() < 0.16 ? 'bush' : 'tree';
    if (kind === 'log') add('log', x, z, rng() * TAU, { hx: 0.35, hy: 0.35, hz: 2.5 + rng() * 2, hp: 0 });
    else if (kind === 'bush') add('bush', x, z, rng() * TAU, { r: 0, scale: 0.8 + rng() * 0.8 });
    else add('tree', x, z, rng() * TAU, { r: 0.45, scale: 0.8 + rng() * 0.7 + fz * 0.25 });
  }
  // Forest zones: a second, denser pass (≈ one tree per 30 m² in the heart of the heavy forest).
  for (const fz of FORESTS) {
    const tries = Math.round(Math.PI * fz.r * fz.r * fz.density / 30);
    for (let i = 0; i < tries; i++) {
      const a = rng() * TAU, d = Math.sqrt(rng()) * fz.r, x = fz.x + Math.cos(a) * d, z = fz.z + Math.sin(a) * d;
      const dens = forestAt(x, z);
      if (rng() > dens || fbm(x / 45 - 3, z / 45 + 11, seed + 131, 2) < -0.38) continue;
      if (!naturalOk(x, z) || siteNear(x, z, 10) || baseNear(x, z, 45) || trailNear(x, z)) continue;
      if (rng() < 0.15) add('bush', x, z, rng() * TAU, { scale: 0.8 + rng() * 0.8 });
      else if (rng() < 0.03) add('log', x, z, rng() * TAU, { hx: 0.35, hy: 0.35, hz: 2.5 + rng() * 2 });
      else add('tree', x, z, rng() * TAU, { r: 0.45, scale: 0.85 + rng() * 0.7 + dens * 0.3 });
    }
  }
  // Rock fields.
  for (let i = 0; i < 5200; i++) {
    const x = (rng() - 0.5) * (size - 60), z = (rng() - 0.5) * (size - 60);
    const y = terrain.baseHeight(x, z);
    if (y < waterLevel + 0.5 || terrain.roadAt(x, z) > 0.02 || siteNear(x, z, 8) || baseNear(x, z, 20) || fieldAt(x, z)) continue;
    if (fbm(x / 80 - 30, z / 80 + 12, seed + 211, 2) < 0.12 && terrain.slope(x, z) < 0.35) continue;
    const s = 0.8 + rng() * rng() * 2.4;
    add('rock', x, z, rng() * TAU, { r: s * 0.95, scale: s });
  }
  // Farmland: fences along fields, haybales, machinery.
  for (const f of FIELDS) {
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
    const W = (lx, lz) => ({ x: f.x + lx * c + lz * s, z: f.z - lx * s + lz * c });
    for (const side of [-1, 1]) {
      for (let lx = -f.hx + 2; lx < f.hx - 2; lx += 4.2) {
        if (rng() < 0.12) continue; // broken stretches
        const p = W(lx, side * (f.hz + 1.2));
        if (terrain.roadAt(p.x, p.z) > 0.1) continue;
        add('fence', p.x, p.z, f.yaw + Math.PI / 2, { hx: 2.05, hy: 0.55, hz: 0.05, hp: 30, destructible: true });
      }
    }
    for (let k = 0; k < 7; k++) {
      const p = W((rng() - 0.5) * f.hx * 1.6, (rng() - 0.5) * f.hz * 1.6);
      add('haybale', p.x, p.z, rng() * TAU, { hx: 0.7, hy: 0.6, hz: 0.7 });
    }
    const m = W(f.hx * 0.6 * (rng() < 0.5 ? -1 : 1), f.hz * 0.4);
    add(rng() < 0.5 ? 'tractor' : 'harvester', m.x, m.z, f.yaw + (rng() < 0.5 ? 0 : Math.PI), { hx: 1.25, hy: 1.4, hz: 2.3 });
  }
  // Abandoned vehicles and debris along the roads (more of it near the ruined sites).
  for (const r of roadLines) {
    for (let s = 40; s < r.len - 40; s += 60 + rng() * 80) {
      if (rng() < 0.45) continue;
      along(r.pts, s, _pt);
      const k = Math.min(r.pts.length - 1, 1);
      const yaw = Math.atan2(r.pts[k][0] - r.pts[0][0], r.pts[k][1] - r.pts[0][1]) + (rng() - 0.5) * 0.9;
      const off = (rng() < 0.5 ? -1 : 1) * (6.5 + rng() * 2.5);
      const x = _pt[0] + Math.cos(yaw) * off, z = _pt[1] - Math.sin(yaw) * off;
      if (riverDist(x, z) < RW + 6 || siteNear(x, z, 0) || baseNear(x, z, 30)) continue;
      const roll = rng();
      if (roll < 0.45) add('carwreck', x, z, yaw, { hx: 0.95, hy: 0.75, hz: 2.1, hue: rng() });
      else if (roll < 0.7) add('truckwreck', x, z, yaw, { hx: 1.2, hy: 1.4, hz: 3.6, hue: rng() });
      else if (roll < 0.82) add('tankwreck', x, z, yaw, { hx: 1.7, hy: 1.1, hz: 3.4 });
      else add('debris', x, z, yaw, { hx: 1.4, hy: 0.5, hz: 1.1 });
    }
  }
  // Forest trails get a few fallen logs and stumps beside them.
  for (const t of TRAILS) for (let k = 0; k < 6; k++) {
    const seg = 1 + Math.floor(rng() * (t.length - 1)), u = rng();
    const x = lerp(t[seg - 1][0], t[seg][0], u) + (rng() - 0.5) * 14, z = lerp(t[seg - 1][1], t[seg][1], u) + (rng() - 0.5) * 14;
    if (!trailNear(x, z) && naturalOk(x, z)) add('log', x, z, rng() * TAU, { hx: 0.35, hy: 0.35, hz: 2.5 + rng() * 2 });
  }

  // ------------------------------------------------------------- 9) clean-up
  const natural = new Set(['tree', 'rock', 'log', 'bush']);
  for (const p of props) {
    const nat = natural.has(p.type);
    const reach = p.r || Math.max(p.hx, p.hz);
    if (nat && inBuilding(p.x, p.z, reach + 2)) { p.alive = false; continue; }
    if (!nat && p.type !== 'wall' && p.type !== 'streetlight' && p.type !== 'pole' && inBuilding(p.x, p.z, reach - 1.6)) { p.alive = false; continue; }
    if (slots.some((s) => (s.x - p.x) ** 2 + (s.z - p.z) ** 2 < (s.r + reach + (nat ? 6 : 2)) ** 2)) { p.alive = false; continue; }
    if (onRunway(p.x, p.z, nat ? 12 : 3)) { p.alive = false; continue; }
    if (nat && (terrain.surfAt(p.x, p.z) === SURF.CONCRETE || baseNear(p.x, p.z, 40))) { p.alive = false; continue; }
    if (fords.some((f) => Math.hypot(f.x - p.x, f.z - p.z) < 26)) { p.alive = false; continue; }
    if (terrain.baseHeight(p.x, p.z) < waterLevel + 0.4 && p.type !== 'wall') p.alive = false;
  }
  const live = props.filter((p) => p.alive);
  const remap = new Map();
  live.forEach((p, i) => { remap.set(p.id, i); p.id = i; });
  for (const l of lights) if (l.prop >= 0) l.prop = remap.has(l.prop) ? remap.get(l.prop) : -2;
  for (const p of live) p.y = terrain.baseHeight(p.x, p.z);
  const litLights = lights.filter((l) => l.prop !== -2).map((l) => ({ ...l, y: l.abs ? l.y : terrain.baseHeight(l.x, l.z) + l.y }));
  for (const b of buildings) b.glass = [];

  const roads = roadLines.map((r) => [r.a, r.b]);
  return {
    terrain, flags, props: live, buildings, vehicleSpawns, emplacements, roads, runways, bases,
    lights: litLights, zones, supplies, bridge, fords, roadLines: roadLines.map((r) => ({ a: r.a, b: r.b, pts: r.pts })),
  };
}
