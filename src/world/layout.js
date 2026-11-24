/**
 * Island layout (pure data). The 2280 m map (5.2 km²): a mainland that spans the full width (2280 m) and
 * 1680 m north–south, a 350 m sound to the south, and the offshore island NOVEMBER. Coordinates below are
 * written in the original 1344 m layout frame and spread to the full map at load (MAP_SX / MAP_SZ, shifted
 * north by MAP_OZ); entries marked `abs` are already in world metres. Only positions are spread: every
 * site, building, street, road width and base keeps its 1:1 size. Pampalona's base sits on the west coast, Torsa's on the
 * east coast; twelve capturable objectives with distinct roles in between.
 *
 * Balance: the objectives are point-symmetric about the centre in pairs
 * (ALPHA↔ECHO, BRAVO↔GOLF, INDIA↔DELTA, FOXTROT↔HOTEL, CHARLIE↔JULIET), with
 * LIMA in the middle and KILO on the centre line, so neither side starts
 * with the better half. Each base has three gate roads to mirrored targets.
 * The river is the one deliberate asymmetry in terrain: it isolates CHARLIE
 * (bridge + ford), while JULIET's mirror position is a coastal harbour.
 */

/**
 * @typedef {'town-ruined'|'town-intact'|'town-farm'|'village'|'outpost-turrets'|'outpost-river'|'outpost-helipad'
 *   |'outpost-runway'|'depot-large'|'depot-forest'|'harbor'|'harbor-cranes'} SiteKind
 */

/** @type {{name: string, x: number, z: number, kind: SiteKind, radius: number, lift?: number}[]} */
export const FLAGS = [
  { name: 'ALPHA', x: -160, z: 150, kind: 'town-ruined', radius: 95 },
  { name: 'BRAVO', x: -340, z: -170, kind: 'outpost-turrets', radius: 55 },
  { name: 'CHARLIE', x: -330, z: 565, kind: 'outpost-river', radius: 55 },
  { name: 'DELTA', x: 340, z: -300, kind: 'depot-large', radius: 80 },
  { name: 'ECHO', x: 160, z: -150, kind: 'town-intact', radius: 85 },
  { name: 'FOXTROT', x: -130, z: -400, kind: 'outpost-helipad', radius: 55 },
  { name: 'GOLF', x: 340, z: 170, kind: 'outpost-runway', radius: 60 },
  { name: 'HOTEL', x: 130, z: 400, kind: 'town-farm', radius: 60 },
  { name: 'INDIA', x: -340, z: 300, kind: 'depot-forest', radius: 60 },
  { name: 'JULIET', x: 330, z: -565, kind: 'harbor', radius: 60 },
  { name: 'KILO', x: 0, z: 588, kind: 'harbor-cranes', radius: 60 },
  { name: 'LIMA', x: 0, z: 0, kind: 'village', radius: 50, lift: 12 },
  // Centre line, point-symmetric pair around LIMA: the rooftop stronghold town (north) and the ruined outpost (south).
  { name: 'MIKE', x: 0, z: 580, kind: 'town-mike', radius: 90, abs: true },
  // Offshore island 350 m south of the mainland: harbour village, docks, forward airstrip. Reached by air only.
  { name: 'NOVEMBER', x: 0, z: -1035, kind: 'island-november', radius: 70, abs: true },
  { name: 'OSCAR', x: 0, z: -180, kind: 'outpost-ruined', radius: 70, abs: true },
];

/**
 * Military bases (uncapturable spawn bases) at the very west / east edges.
 * Local frame: +u points inland (toward the map centre), +v along the coast.
 * The coastline runs at u = COAST; the runway along it, piers out to sea.
 */
export const BASES = [
  { team: 0, x: -570, z: 0, inland: 1 },
  { team: 1, x: 570, z: 0, inland: -1 },
];
export const BASE = { coast: -72, wall: 95, halfLength: 290, gates: [-200, -40, 40, 200] };

/** Roads between objectives (indices into FLAGS); mirrored pairs listed together. */
export const ROADS = [
  [0, 1], [4, 6], // ALPHA–BRAVO / ECHO–GOLF
  [0, 8], [4, 3], // ALPHA–INDIA / ECHO–DELTA
  [0, 11], [4, 11], // ALPHA–LIMA / ECHO–LIMA
  [0, 7], [4, 5], // ALPHA–HOTEL / ECHO–FOXTROT
  [1, 5], [6, 7], // BRAVO–FOXTROT / GOLF–HOTEL
  [1, 11], [6, 11], // BRAVO–LIMA / GOLF–LIMA
  [8, 2], [3, 9], // INDIA–CHARLIE (bridge) / DELTA–JULIET
  [0, 10], [4, 9], // ALPHA–KILO / ECHO–JULIET
  [2, 10], [9, 5], // CHARLIE–KILO (ford) / JULIET–FOXTROT
  [7, 10], // HOTEL–KILO
  [12, 11], [14, 11], // MIKE–LIMA / OSCAR–LIMA
  [12, 0], [14, 4], // MIKE–ALPHA / OSCAR–ECHO
  [12, 7], [14, 5], // MIKE–HOTEL / OSCAR–FOXTROT
  [12, 10], // MIKE–KILO
];
/** Road crossing the river on the bridge (the other crossings are fords). */
export const BRIDGE_ROAD = [8, 2];

/** Roads from a base gate to nearby objectives: [team, flag index]. */
export const BASE_ROADS = [[0, 1], [0, 8], [0, 5], [1, 6], [1, 3], [1, 7]];

/** River separating CHARLIE from the mainland: centreline, half width of the channel and of the banks. */
export const RIVER = {
  points: [[-720, 470], [-560, 452], [-430, 446], [-300, 436], [-200, 450], [-150, 510], [-138, 600], [-132, 720]],
  halfWidth: 15,
  bankWidth: 14,
  depth: -2.6,
};
/** Shallow wading spot for infantry (x along the river where the bed rises). */
export const WADE = [{ x: -560, depth: 0.25 }];

/** Farm fields around HOTEL: centre, half sizes, yaw, crop (3 wheat, 4 green, 5 ploughed — terrain SURF codes). */
export const FIELDS = [
  { x: 230, z: 335, hx: 62, hz: 42, yaw: 0.12, crop: 3 },
  { x: 245, z: 470, hx: 60, hz: 42, yaw: -0.06, crop: 4 },
  { x: 40, z: 320, hx: 48, hz: 36, yaw: 0.3, crop: 5 },
  { x: 170, z: 535, hx: 52, hz: 30, yaw: 0.05, crop: 3 },
  { x: 40, z: 450, hx: 34, hz: 40, yaw: -0.2, crop: 4 },
];

/** Forest zones that raise tree density (heavy forest around INDIA, mirrored woods elsewhere). */
export const FORESTS = [
  { x: -340, z: 300, r: 175, density: 1.0 },
  { x: 340, z: -300, r: 60, density: 0.25 },
  { x: -470, z: 120, r: 95, density: 0.65 },
  { x: 470, z: -120, r: 95, density: 0.65 },
  { x: -60, z: -230, r: 115, density: 0.55 },
  { x: 60, z: 230, r: 100, density: 0.45 },
  { x: -230, z: 560, r: 110, density: 0.6 },
  { x: 230, z: -560, r: 90, density: 0.45 },
  { x: 420, z: 400, r: 110, density: 0.55 },
  { x: -420, z: -400, r: 110, density: 0.55 },
  { x: 160, z: 140, r: 70, density: 0.4 },
  { x: -160, z: -140, r: 70, density: 0.4 },
];

/** Forest trails through INDIA's woods (polylines; trees are kept off them). */
export const TRAILS = [
  [[-340, 300], [-395, 360], [-450, 410]],
  [[-340, 300], [-265, 250], [-200, 238]],
  [[-340, 300], [-410, 230], [-470, 196]],
];

/**
 * Converts base-local (u inland, v along the coast) to world coordinates.
 * Both axes flip with `inland`, so the two bases are point-symmetric.
 */
export function baseToWorld(b, u, v) {
  return { x: b.x + u * b.inland, z: b.z + v * b.inland };
}

// ---------------------------------------------------------------- spread to the 2280 m map

/** Terrain edge (m) and the spread of the original layout: x × 1.7, z × 1.25, shifted north 200 m. */
export const MAP_SIZE = 2280;
export const MAP_SX = 1.7, MAP_SZ = 1.25, MAP_OZ = 200;
/** Mainland: half extents in world metres and centre z (the coast runs ~60 m inside these). */
export const MAINLAND = { hx: 672 * MAP_SX, hz: 672 * MAP_SZ, oz: MAP_OZ };
/** Offshore island NOVEMBER: ellipse centre and semi-axes, plateau height. */
export const ISLAND = { x: 0, z: -1032, ax: 330, az: 96, h: 4.5 };
/** Layout frame (original 1344 m coordinates) of a world point: harbour orientation, coast tests. */
export function toLayout(x, z) { return { x: x / MAP_SX, z: (z - MAP_OZ) / MAP_SZ }; }
const SPREAD = (p) => { p.x *= MAP_SX; p.z = p.z * MAP_SZ + MAP_OZ; };
for (const f of FLAGS) if (!f.abs) SPREAD(f);
for (const b of BASES) { b.x = Math.sign(b.x) * (MAINLAND.hx - 102); b.z = MAP_OZ; }
for (const p of RIVER.points) { p[0] *= MAP_SX; p[1] = p[1] * MAP_SZ + MAP_OZ; }
for (const w of WADE) w.x *= MAP_SX;
for (const f of FIELDS) SPREAD(f);
for (const f of FORESTS) { SPREAD(f); f.r *= 1.4; }
for (const t of TRAILS) for (const p of t) { p[0] *= MAP_SX; p[1] = p[1] * MAP_SZ + MAP_OZ; }
