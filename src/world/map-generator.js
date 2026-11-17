import { CONFIG } from '../core/config.js';
import { makeRng, fbm, smoothstep, lerp, clamp, distToSegmentSq, TAU } from '../core/math.js';
import { Terrain } from './terrain.js';
import { VEHICLE_DEFS } from '../entities/vehicle-defs.js';
import { FACTIONS } from '../entities/factions.js';

/**
 * @typedef {Object} Prop
 * @property {number} id
 * @property {'tree'|'rock'|'barrier'|'crate'|'wall'} type
 * @property {number} x @property {number} y @property {number} z
 * @property {number} rot   yaw in radians
 * @property {number} hx @property {number} hy @property {number} hz  half extents (boxes)
 * @property {number} r     footprint radius (round props; 0 for boxes)
 * @property {number} scale
 * @property {number} hp
 * @property {boolean} alive
 * @property {boolean} destructible
 * @property {any} collider   physics handle, filled by PhysicsSystem
 * @property {number} instance  instance slot, filled by the renderer for destructibles
 */

/**
 * @typedef {Object} FlagDef
 * @property {number} id @property {string} name
 * @property {number} x @property {number} y @property {number} z
 * @property {number} owner  -1 neutral, otherwise team index
 * @property {boolean} base  main base (uncapturable spawn of last resort is still capturable, but holds vehicles)
 */

/**
 * @typedef {Object} VehicleSpawn
 * @property {string} type  key into VEHICLE_DEFS
 * @property {number} team
 * @property {number} x @property {number} z @property {number} yaw
 */

/**
 * @typedef {Object} GameMap
 * @property {Terrain} terrain
 * @property {FlagDef[]} flags
 * @property {Prop[]} props
 * @property {VehicleSpawn[]} vehicleSpawns
 * @property {number[][]} roads  pairs of flag indices
 * @property {Runway[]} runways
 */

/**
 * @typedef {Object} Runway
 * @property {number} team
 * @property {number} x0 @property {number} x1  start (base end) and far end along X
 * @property {number} z     centreline
 * @property {number} width
 * @property {number} yaw   take-off heading
 */

const BASE_PLATEAU = 62;
const FLAG_PLATEAU = 28;
/** Forward flags host vehicle parks: a levelled forward base. */
const FORWARD_PLATEAU = 58;
/** Plateau banks widen with the height they bridge (run per metre of rise ≈ 18° average grade). */
const BANK_RUN = 3.1;
/** Steepest grade a graded road may have (rise / run, ≈ 15°). */
const ROAD_GRADE = 0.27;
const RUNWAY = { z: 330, near: 300, far: 60, width: 28 };

const FLAG_LAYOUT = [
  { name: 'ALPHA', x: -285, z: -265, owner: 0, base: true },
  { name: 'BRAVO', x: -115, z: -150, owner: 0, base: false },
  { name: 'CHARLIE', x: 5, z: 10, owner: -1, base: false },
  { name: 'DELTA', x: 125, z: 150, owner: 1, base: false },
  { name: 'ECHO', x: 285, z: 265, owner: 1, base: true },
  { name: 'FOXTROT', x: -205, z: 175, owner: -1, base: false },
  { name: 'GOLF', x: 205, z: -185, owner: -1, base: false },
];
const ROADS = [[0, 1], [1, 2], [2, 3], [3, 4], [1, 5], [5, 3], [1, 6], [6, 3], [0, 5], [4, 6]];

/**
 * Builds the whole battlefield deterministically from a seed: an island
 * heightmap with ridges and valleys, graded roads between capture points,
 * flattened bases, forests, rock fields and fortified flag positions.
 * @param {number} seed
 * @returns {GameMap}
 */
export function generateMap(seed = CONFIG.seed) {
  const { size, heightRes, waterLevel } = CONFIG.world;
  const terrain = new Terrain(size, heightRes);
  const rng = makeRng(seed);
  const n = terrain.n, half = terrain.half;

  const lowAt = (x, z) => 15 + 24 * fbm(x / 310, z / 310, seed, 2) + 9 * fbm(x / 140 + 40, z / 140 - 17, seed + 7, 2);

  // 1) Base relief + island falloff.
  for (let iz = 0; iz < n; iz++) {
    const z = -half + iz * heightRes;
    for (let ix = 0; ix < n; ix++) {
      const x = -half + ix * heightRes;
      const low = lowAt(x, z);
      const ridge = 1 - Math.abs(fbm(x / 95 - 9, z / 95 + 3, seed + 19, 3));
      const detail = 7 * fbm(x / 60, z / 60, seed + 3, 3) + 6 * ridge * ridge * smoothstep(8, 30, low);
      let h = low + detail;
      const edge = Math.max(Math.abs(x), Math.abs(z));
      h -= smoothstep(half - 48, half, edge) * 46;
      terrain.heights[iz * n + ix] = h;
    }
  }

  // 2) Roads: blend toward the low-frequency surface so vehicles get gentle grades.
  for (let iz = 0; iz < n; iz++) {
    const z = -half + iz * heightRes;
    for (let ix = 0; ix < n; ix++) {
      const x = -half + ix * heightRes;
      let best = 1e9;
      for (let r = 0; r < ROADS.length; r++) {
        const a = FLAG_LAYOUT[ROADS[r][0]], b = FLAG_LAYOUT[ROADS[r][1]];
        const d = distToSegmentSq(x, z, a.x, a.z, b.x, b.z);
        if (d < best) best = d;
      }
      if (best > 15 * 15) continue;
      const w = smoothstep(15, 5, Math.sqrt(best));
      const i = iz * n + ix;
      const target = Math.max(lowAt(x, z), waterLevel + 1.4);
      terrain.heights[i] = lerp(terrain.heights[i], target, w * 0.92);
      terrain.road[i] = Math.round(smoothstep(7, 4, Math.sqrt(best)) * 255);
    }
  }

  // 3) Flatten flag plateaus.
  /** @type {FlagDef[]} */
  const flags = FLAG_LAYOUT.map((f, id) => ({ id, name: f.name, x: f.x, y: 0, z: f.z, owner: f.owner, base: f.base }));
  const forwardIds = new Set([1, 3]);
  for (const f of flags) {
    const R = f.base ? BASE_PLATEAU : forwardIds.has(f.id) ? FORWARD_PLATEAU : FLAG_PLATEAU;
    const target = Math.max(lowAt(f.x, f.z), waterLevel + 3);
    // Bank width from the largest height difference around the rim: no cliffs at the plateau edge.
    let rise = 0;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU;
      for (const off of [12, 30, 50]) rise = Math.max(rise, Math.abs(terrain.height(f.x + Math.cos(a) * (R + off), f.z + Math.sin(a) * (R + off)) - target));
    }
    const bank = clamp(rise * BANK_RUN, 28, 95);
    const span = Math.ceil((R + bank + 2) / heightRes);
    const cx = Math.round((f.x + half) / heightRes), cz = Math.round((f.z + half) / heightRes);
    for (let iz = Math.max(0, cz - span); iz <= Math.min(n - 1, cz + span); iz++) {
      for (let ix = Math.max(0, cx - span); ix <= Math.min(n - 1, cx + span); ix++) {
        const d = Math.hypot(-half + ix * heightRes - f.x, -half + iz * heightRes - f.z);
        const w = smoothstep(R + bank, R, d);
        const i = iz * n + ix;
        terrain.heights[i] = lerp(terrain.heights[i], target, w);
      }
    }
    f.y = target;
  }

  // 3a) Grade every road to a drivable profile: cut and fill so no stretch is steeper than ROAD_GRADE.
  for (const [ra, rb] of ROADS) {
    const a = flags[ra], b = flags[rb];
    const len = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(2, Math.ceil(len / 2)), step = len / steps;
    const prof = new Float32Array(steps + 1);
    for (let i = 0; i <= steps; i++) prof[i] = terrain.height(a.x + (b.x - a.x) * (i / steps), a.z + (b.z - a.z) * (i / steps));
    prof[0] = a.y; prof[steps] = b.y;
    const g = ROAD_GRADE * step;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i <= steps; i++) prof[i] = clamp(prof[i], prof[i - 1] - g, prof[i - 1] + g);
      for (let i = steps - 1; i >= 0; i--) prof[i] = clamp(prof[i], prof[i + 1] - g, prof[i + 1] + g);
    }
    const minX = Math.min(a.x, b.x) - 18, maxX = Math.max(a.x, b.x) + 18, minZ = Math.min(a.z, b.z) - 18, maxZ = Math.max(a.z, b.z) + 18;
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    for (let iz = Math.max(0, Math.floor((minZ + half) / heightRes)); iz <= Math.min(n - 1, Math.ceil((maxZ + half) / heightRes)); iz++) {
      const z = -half + iz * heightRes;
      for (let ix = Math.max(0, Math.floor((minX + half) / heightRes)); ix <= Math.min(n - 1, Math.ceil((maxX + half) / heightRes)); ix++) {
        const x = -half + ix * heightRes;
        const u = clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1);
        const d = Math.hypot(x - (a.x + dx * u), z - (a.z + dz * u));
        if (d > 16) continue;
        const k = u * steps, i0 = Math.floor(k), i1 = Math.min(steps, i0 + 1);
        const target = lerp(prof[i0], prof[i1], k - i0);
        const i = iz * n + ix;
        terrain.heights[i] = lerp(terrain.heights[i], target, smoothstep(16, 6, d));
      }
    }
  }

  // 3b) Runways beside each main base: a straight, gently graded strip.
  /** @type {Runway[]} */
  const runways = [];
  for (const team of [0, 1]) {
    const sign = team === 0 ? -1 : 1, base = flags[team === 0 ? 0 : 4];
    const rw = { team, x0: sign * RUNWAY.near, x1: sign * RUNWAY.far, z: sign * RUNWAY.z, width: RUNWAY.width, yaw: -sign * Math.PI / 2 };
    runways.push(rw);
    const h0 = base.y, h1 = h0 + clamp(Math.max(lowAt(rw.x1, rw.z), waterLevel + 2.5) - h0, -4.5, 4.5);
    const halfW = rw.width / 2, blend = 18, lo = Math.min(rw.x0, rw.x1), hi = Math.max(rw.x0, rw.x1);
    for (let iz = 0; iz < n; iz++) {
      const z = -half + iz * heightRes, dz = Math.abs(z - rw.z);
      if (dz > halfW + blend) continue;
      for (let ix = 0; ix < n; ix++) {
        const x = -half + ix * heightRes;
        const outside = Math.max(lo - x, x - hi, 0);
        if (outside > blend) continue;
        const t = clamp((x - rw.x0) / (rw.x1 - rw.x0), 0, 1);
        const w = smoothstep(halfW + blend, halfW, dz) * smoothstep(blend, 0, outside);
        const i = iz * n + ix;
        terrain.heights[i] = lerp(terrain.heights[i], lerp(h0, h1, t), w);
        if (dz < halfW && outside === 0) terrain.paved[i] = 255;
      }
    }
  }
  const onRunway = (x, z, pad) => runways.some((rw) => Math.abs(z - rw.z) < rw.width / 2 + pad &&
    x > Math.min(rw.x0, rw.x1) - pad && x < Math.max(rw.x0, rw.x1) + pad);

  // 3c) Vehicle parks: footprint-aware slots around each side's base and forward flag.
  /** @type {VehicleSpawn[]} */
  const vehicleSpawns = [];
  /** @type {{x:number, z:number, r:number}[]} */
  const pads = [];
  const flatten = (x, z, r, target) => {
    const span = Math.ceil((r + 6) / heightRes);
    const cx = Math.round((x + half) / heightRes), cz = Math.round((z + half) / heightRes);
    for (let iz = Math.max(0, cz - span); iz <= Math.min(n - 1, cz + span); iz++) {
      for (let ix = Math.max(0, cx - span); ix <= Math.min(n - 1, cx + span); ix++) {
        const d = Math.hypot(-half + ix * heightRes - x, -half + iz * heightRes - z);
        const i = iz * n + ix;
        terrain.heights[i] = lerp(terrain.heights[i], target, smoothstep(r + 6, r, d));
      }
    }
  };
  const slopeOk = (x, z, r) => {
    const h = terrain.height(x, z);
    if (h < waterLevel + 1.5) return false;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      if (Math.abs(terrain.height(x + Math.cos(a) * r, z + Math.sin(a) * r) - h) > r * 0.22) return false;
    }
    return true;
  };
  for (const team of [0, 1]) {
    const faction = FACTIONS[CONFIG.teams[team].faction];
    const base = flags[team === 0 ? 0 : 4], forward = flags[team === 0 ? 1 : 3];
    const rw = runways[team];
    const items = [];
    for (const entry of faction.roster) for (let k = 0; k < entry.count; k++) items.push({ ...entry, r: VEHICLE_DEFS[entry.type].padRadius });
    items.sort((a, b) => b.r - a.r);
    let jets = 0;
    const jetCount = items.filter((it) => it.site === 'runway').length;
    for (const it of items) {
      if (it.site === 'runway') {
        const x = rw.x0 + Math.sign(rw.x1 - rw.x0) * 16, z = rw.z + (jets++ - (jetCount - 1) / 2) * 14;
        vehicleSpawns.push({ type: it.type, team, x, z, yaw: rw.yaw });
        pads.push({ x, z, r: it.r });
        continue;
      }
      const centre = it.site === 'forward' ? forward : base;
      const rMin = it.site === 'helipad' ? 34 : 18 + it.r, rMax = it.site === 'forward' ? 62 : BASE_PLATEAU - 3;
      let best = null, bestScore = 1e9;
      for (let gz = -rMax; gz <= rMax; gz += 3) {
        for (let gx = -rMax; gx <= rMax; gx += 3) {
          const d = Math.hypot(gx, gz);
          if (d < rMin || d > rMax) continue;
          const x = centre.x + gx, z = centre.z + gz;
          if (!terrain.inBounds(x, z, 40) || onRunway(x, z, it.r + 4)) continue;
          if (pads.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + it.r + 1.8) ** 2)) continue;
          if (it.site === 'forward' && !slopeOk(x, z, it.r)) continue;
          // Prefer slots close to the flag and on the side facing the front line.
          const toFront = (gx * -centre.x + gz * -centre.z) / (Math.hypot(centre.x, centre.z) * (d || 1));
          const score = d - toFront * 8 + (it.site === 'helipad' ? -d * 0.5 : 0);
          if (score < bestScore) { bestScore = score; best = { x, z }; }
        }
      }
      if (!best) { console.warn(`[map] no parking slot for ${it.type}`); continue; }
      if (it.site === 'forward') flatten(best.x, best.z, it.r, terrain.height(best.x, best.z));
      pads.push({ x: best.x, z: best.z, r: it.r });
      vehicleSpawns.push({ type: it.type, team, x: best.x, z: best.z, yaw: Math.atan2(-best.x, -best.z) });
    }
  }

  // 4) Props.
  /** @type {Prop[]} */
  const props = [];
  const nearFlag = (x, z, dist) => flags.some((f) => (f.x - x) ** 2 + (f.z - z) ** 2 < dist * dist);
  const add = (type, x, z, rot, o) => {
    /** @type {Prop} */
    const p = {
      id: props.length, type, x, y: terrain.height(x, z), z, rot,
      hx: 0, hy: 0, hz: 0, r: 0, scale: 1, hp: 0, alive: true, destructible: false, collider: null, instance: -1, ...o,
    };
    props.push(p);
    return p;
  };

  // Forests: density from a noise field so trees form groves with clearings.
  for (let i = 0; i < 5200 && props.length < 1700; i++) {
    const x = (rng() - 0.5) * (size - 90), z = (rng() - 0.5) * (size - 90);
    if (fbm(x / 120 + 5, z / 120 - 8, seed + 101, 2) < 0.08 + rng() * 0.25) continue;
    const y = terrain.height(x, z);
    if (y < waterLevel + 1.5 || terrain.slope(x, z) > 0.55 || terrain.roadAt(x, z) > 0.05) continue;
    if (nearFlag(x, z, 34)) continue;
    add('tree', x, z, rng() * TAU, { r: 0.45, scale: 0.8 + rng() * 0.7 });
  }
  // Rock fields.
  for (let i = 0; i < 900; i++) {
    const x = (rng() - 0.5) * (size - 80), z = (rng() - 0.5) * (size - 80);
    const y = terrain.height(x, z);
    if (y < waterLevel + 0.5 || terrain.roadAt(x, z) > 0.02 || nearFlag(x, z, 20)) continue;
    if (fbm(x / 80 - 30, z / 80 + 12, seed + 211, 2) < 0.1) continue;
    const s = 0.8 + rng() * rng() * 2.4;
    add('rock', x, z, rng() * TAU, { r: s * 0.95, scale: s });
  }
  // Fortified flag positions: ruin walls, concrete barriers and crates.
  for (const f of flags) {
    const ring = (count, rMin, rMax, fn) => {
      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU + rng() * 0.6;
        const d = rMin + rng() * (rMax - rMin);
        const x = f.x + Math.cos(a) * d, z = f.z + Math.sin(a) * d;
        if (terrain.roadAt(x, z) > 0.3) continue;
        fn(x, z, a);
      }
    };
    ring(6, 12, 24, (x, z, a) => {
      const rot = a + Math.PI / 2 + (rng() - 0.5) * 0.5;
      add('wall', x, z, rot, { hx: 3 + rng() * 1.5, hy: 1.6 + rng() * 0.6, hz: 0.35 });
      if (rng() < 0.5) {
        const c = Math.cos(rot), s = Math.sin(rot);
        add('wall', x + c * 3 - s * 2.2, z - s * 3 - c * 2.2, rot + Math.PI / 2, { hx: 2.2, hy: 1.4 + rng() * 0.5, hz: 0.35 });
      }
    });
    ring(9, 7, 28, (x, z, a) =>
      add('barrier', x, z, a + Math.PI / 2 + (rng() - 0.5), { hx: 1.5, hy: 0.6, hz: 0.3, hp: 260, destructible: true }));
    ring(7, 5, 20, (x, z) =>
      add('crate', x, z, rng() * TAU, { hx: 0.65, hy: 0.65, hz: 0.65, hp: 90, destructible: true }));
  }

  // 5) Keep parks and runways clear of clutter.
  for (const p of props) {
    const natural = p.type === 'tree' || p.type === 'rock';
    for (const pad of pads) if ((pad.x - p.x) ** 2 + (pad.z - p.z) ** 2 < (pad.r + (natural ? 7 : 2.5)) ** 2) p.alive = false;
    if (onRunway(p.x, p.z, natural ? 10 : 4)) p.alive = false;
    // Bases get a wide clearing so armour can form up and roll out.
    if (natural) for (const f of flags) if (f.base && (f.x - p.x) ** 2 + (f.z - p.z) ** 2 < (BASE_PLATEAU + 8) ** 2) p.alive = false;
  }

  return { terrain, flags, props: props.filter((p) => p.alive).map((p, i) => ((p.id = i), p)), vehicleSpawns, roads: ROADS, runways };
}
