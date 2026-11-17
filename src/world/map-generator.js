import { CONFIG } from '../core/config.js';
import { makeRng, fbm, smoothstep, lerp, distToSegmentSq, TAU } from '../core/math.js';
import { Terrain } from './terrain.js';

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
 * @property {'jeep'|'tank'|'heli'} type
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
 */

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
  for (const f of flags) {
    const R = f.base ? 46 : 26;
    const target = Math.max(lowAt(f.x, f.z), waterLevel + 3);
    const span = Math.ceil((R + 30) / heightRes);
    const cx = Math.round((f.x + half) / heightRes), cz = Math.round((f.z + half) / heightRes);
    for (let iz = Math.max(0, cz - span); iz <= Math.min(n - 1, cz + span); iz++) {
      for (let ix = Math.max(0, cx - span); ix <= Math.min(n - 1, cx + span); ix++) {
        const d = Math.hypot(-half + ix * heightRes - f.x, -half + iz * heightRes - f.z);
        const w = smoothstep(R + 28, R, d);
        const i = iz * n + ix;
        terrain.heights[i] = lerp(terrain.heights[i], target, w);
      }
    }
    f.y = target;
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

  // 5) Vehicle parks.
  /** @type {VehicleSpawn[]} */
  const vehicleSpawns = [];
  const park = (flag, team, type, dx, dz) => {
    const toCentre = Math.atan2(-flag.x, -flag.z);
    const c = Math.cos(toCentre), s = Math.sin(toCentre);
    vehicleSpawns.push({ type, team, x: flag.x + dx * c + dz * s, z: flag.z - dx * s + dz * c, yaw: toCentre });
  };
  for (const [fi, team] of [[0, 0], [4, 1]]) {
    const f = flags[fi];
    park(f, team, 'jeep', -9, 30);
    park(f, team, 'jeep', 9, 30);
    park(f, team, 'tank', -22, 22);
    park(f, team, 'heli', 26, 8);
  }
  park(flags[1], 0, 'jeep', 6, 18);
  park(flags[3], 1, 'jeep', 6, 18);
  // Keep parks clear of clutter.
  for (const p of props) {
    const natural = p.type === 'tree' || p.type === 'rock';
    for (const v of vehicleSpawns) if ((v.x - p.x) ** 2 + (v.z - p.z) ** 2 < (natural ? 196 : 64)) p.alive = false;
    // Bases get a wide clearing so armour can form up and roll out.
    if (natural) for (const f of flags) if (f.base && (f.x - p.x) ** 2 + (f.z - p.z) ** 2 < 58 * 58) p.alive = false;
  }

  return { terrain, flags, props: props.filter((p) => p.alive).map((p, i) => ((p.id = i), p)), vehicleSpawns, roads: ROADS };
}
