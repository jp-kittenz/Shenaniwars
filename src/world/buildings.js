import { makeRng } from '../core/math.js';

/**
 * Procedural enterable buildings.
 *
 * A building is described in its own frame (x across its width, z across its
 * depth, y up from the ground floor) as a list of boxes ("parts"). Exterior
 * walls are cut around doors and windows on every storey, upper floors are
 * slabs with a stairwell hole, stairs are ramps that alternate sides so they
 * never stack, flat roofs are walkable (stairs continue up through a hatch),
 * and interiors are furnished per building type. Three predefined damage
 * states (intact, damaged, ruined) are derived deterministically from the
 * intact part list, so destruction is a cheap state swap rather than a
 * structural simulation.
 *
 * The same part list feeds rendering (chunk batches; furniture and small
 * trim only at high detail), physics colliders, walkable surfaces (soldiers
 * climb stairs and stand on floors and roofs), wall push-out for infantry and
 * navigation stamping.
 */

/** Part kinds. */
export const K = { WALL: 0, FLOOR: 1, ROOF: 2, RAMP: 3, FURN: 4, TRIM: 5, RUBBLE: 6, PILLAR: 7, GLASS: 8 };
/** Kinds soldiers can stand on. */
export const WALKABLE = new Set([K.FLOOR, K.ROOF, K.RAMP, K.RUBBLE]);
/** Kinds that get physics colliders. */
export const SOLID = new Set([K.WALL, K.FLOOR, K.ROOF, K.RAMP, K.RUBBLE, K.PILLAR]);

/**
 * @typedef {Object} Part
 * @property {number} x @property {number} y @property {number} z  centre (building frame)
 * @property {number} hx @property {number} hy @property {number} hz  half extents
 * @property {number} c   colour (hex)
 * @property {number} k   kind (K.*)
 * @property {number} lod 0 = high detail only (interior / trim), 1 = shell (all LODs)
 * @property {number} [rx] rotation about the local X axis (ramps, pitched roofs)
 * @property {number} [rz] rotation about the local Z axis (pitched roofs)
 * @property {boolean} [ground] ground-floor wall (navigation stamping)
 * @property {number} [g]  glass pane group (side * 4 + storey)
 */

/**
 * @typedef {Object} Opening
 * @property {number} side 0 +z (front), 1 -z, 2 +x, 3 -x
 * @property {number} u    centre along the wall (metres from its middle)
 * @property {number} w @property {number} y0 @property {number} y1 relative to the storey
 * @property {number} floor storey index
 * @property {'door'|'window'} kind
 */

/**
 * @typedef {Object} Building
 * @property {number} id @property {string} type
 * @property {number} x @property {number} y @property {number} z @property {number} rot
 * @property {number} w @property {number} d @property {number} floors @property {number} fh
 * @property {{wall: number, trim: number, roof: number, floor: number}} pal
 * @property {string} interior @property {'flat'|'gable'|'open'} roof
 * @property {Opening[]} openings
 * @property {number} state 0 intact, 1 damaged, 2 ruined
 * @property {number} hp @property {number} maxHp
 * @property {string} name   type, or the structure name (pier, tunnel, bridge)
 * @property {boolean} deck  structure carries a terrain deck (vehicles drive on it)
 * @property {number} glassBroken  bit mask of broken window panes (side * 4 + storey)
 * @property {number} [hqIndex]
 * @property {number} team  owning base (-1 none)
 * @property {boolean} hq   base headquarters (endgame objective)
 * @property {boolean} invulnerable
 * @property {number} seed
 * @property {(Part[]|null)[]} cache  parts per state
 * @property {any[]} colliders  physics handles (filled by the structure system)
 * @property {number[]} glass   glass prop ids
 */

const T = 0.25; // wall thickness
const GLASS = 0x7fa6b8;

/** Palettes by style. */
export const PALETTES = {
  plaster: [{ wall: 0xc9b99a, trim: 0x8b7d66, roof: 0x8a4b3a, floor: 0x7a6650 }, { wall: 0xb8b2a2, trim: 0x726d62, roof: 0x5d5a55, floor: 0x6b5a48 },
    { wall: 0xd2c4a2, trim: 0x9a8a6c, roof: 0x7b3f33, floor: 0x80694f }, { wall: 0xa9a49a, trim: 0x6a665f, roof: 0x4f4c48, floor: 0x655544 }],
  brick: [{ wall: 0x9b5a43, trim: 0x6e4232, roof: 0x4a4644, floor: 0x6b5644 }, { wall: 0x8a5745, trim: 0x5f3d30, roof: 0x3f3d3b, floor: 0x5f4d3e }],
  wood: [{ wall: 0x8a6440, trim: 0x5a4028, roof: 0x5e3a2a, floor: 0x6e5236 }, { wall: 0x9b3b2e, trim: 0xe0d6c4, roof: 0x4b4744, floor: 0x6e5236 }],
  concrete: [{ wall: 0x9a978f, trim: 0x6c6a65, roof: 0x5f5d59, floor: 0x77746e }],
  pampalona: [{ wall: 0xc2b08a, trim: 0x8c7a58, roof: 0x9a8a68, floor: 0x7d6e55 }],
  torsa: [{ wall: 0x6d7a5a, trim: 0x47513a, roof: 0x55604a, floor: 0x5d5f55 }],
  metal: [{ wall: 0x7d8288, trim: 0x55595e, roof: 0x6a6f74, floor: 0x5d6064 }],
};

/** Type presets: size ranges, storeys, storey height, roof, interior, door width. */
const PRESETS = {
  house: { w: [7, 10], d: [7, 9], floors: [1, 2], fh: 3, roof: 'gable', interior: 'house', door: 1.2, style: 'plaster' },
  farmhouse: { w: [8, 11], d: [8, 10], floors: [2, 2], fh: 3, roof: 'gable', interior: 'house', door: 1.2, style: 'wood' },
  apartment: { w: [12, 16], d: [9, 11], floors: [3, 3], fh: 3, roof: 'flat', interior: 'apartment', door: 1.4, style: 'plaster' },
  shop: { w: [8, 11], d: [8, 10], floors: [1, 2], fh: 3.2, roof: 'flat', interior: 'shop', door: 1.6, style: 'brick' },
  townhall: { w: [18, 18], d: [14, 14], floors: [2, 2], fh: 3.6, roof: 'flat', interior: 'office', door: 2.4, style: 'brick' },
  office: { w: [10, 12], d: [8, 9], floors: [1, 2], fh: 3.2, roof: 'flat', interior: 'office', door: 1.4, style: 'concrete' },
  warehouse: { w: [20, 28], d: [14, 18], floors: [1, 1], fh: 7, roof: 'flat', interior: 'warehouse', door: 5, style: 'metal' },
  barn: { w: [12, 14], d: [15, 18], floors: [1, 1], fh: 6, roof: 'gable', interior: 'barn', door: 4.5, style: 'wood' },
  garage: { w: [12, 14], d: [10, 11], floors: [1, 1], fh: 4.6, roof: 'flat', interior: 'garage', door: 6, style: 'concrete' },
  hangar: { w: [30, 34], d: [26, 30], floors: [1, 1], fh: 10, roof: 'flat', interior: 'hangar', door: 22, style: 'metal' },
  vhangar: { w: [26, 30], d: [13, 14], floors: [1, 1], fh: 6.5, roof: 'flat', interior: 'vhangar', door: 22, style: 'metal' },
  barracks: { w: [22, 26], d: [10, 11], floors: [2, 2], fh: 3.2, roof: 'flat', interior: 'barracks', door: 1.6, style: 'concrete' },
  hq: { w: [16, 18], d: [13, 14], floors: [2, 2], fh: 3.6, roof: 'flat', interior: 'hq', door: 2.2, style: 'concrete' },
  control: { w: [7, 7], d: [7, 7], floors: [3, 3], fh: 3.4, roof: 'flat', interior: 'office', door: 1.4, style: 'concrete' },
  shed: { w: [4, 5.5], d: [4, 5], floors: [1, 1], fh: 2.8, roof: 'flat', interior: 'shed', door: 1.2, style: 'wood' },
  tower: { w: [4, 4], d: [4, 4], floors: [1, 1], fh: 6.5, roof: 'open', interior: 'tower', door: 1.2, style: 'wood' },
};

const HP = { house: 900, farmhouse: 1000, apartment: 1800, shop: 1000, townhall: 2400, office: 1200, warehouse: 2000, barn: 900,
  garage: 1200, hangar: 3500, vhangar: 2400, barracks: 2400, hq: 4500, control: 1500, shed: 400, tower: 500 };

let nextId = 0;
export function resetBuildingIds() { nextId = 0; }

/**
 * Creates a building of `type` at (x, y, z) facing `rot` (front = local +z).
 * @param {string} type @param {number} x @param {number} y @param {number} z @param {number} rot
 * @param {() => number} rng
 * @param {Partial<Building> & {style?: string, palIndex?: number, doors?: {side: number, u?: number, w?: number}[]}} [o]
 * @returns {Building}
 */
export function createBuilding(type, x, y, z, rot, rng, o = {}) {
  if (type === 'custom' || type === 'bridge') {
    // Hand-built structures (bridge, piers, tunnel): explicit part lists per state.
    const hp = o.hp ?? 99999;
    return /** @type {Building} */ ({
      id: nextId++, type, name: o.name || type, x, y, z, rot, w: o.w, d: o.d, floors: 1, fh: 3, pal: PALETTES.concrete[0],
      interior: 'none', roof: 'flat', openings: [], state: 0, hp, maxHp: hp, team: -1, hq: false, invulnerable: !!o.invulnerable,
      deck: !!o.deck, seed: Math.floor(rng() * 1e9), cache: [o.parts, o.damaged || o.parts, o.ruined || o.parts], colliders: [], glass: [], glassBroken: 0,
    });
  }
  const p = PRESETS[type];
  const r = (a) => a[0] + (a[1] - a[0]) * rng();
  const w = o.w ?? Math.round(r(p.w) * 2) / 2, d = o.d ?? Math.round(r(p.d) * 2) / 2;
  const floors = o.floors ?? Math.round(r(p.floors));
  const pals = PALETTES[o.style || p.style];
  const pal = pals[(o.palIndex ?? Math.floor(rng() * pals.length)) % pals.length];
  const b = /** @type {Building} */ ({
    id: nextId++, type, name: type, x, y, z, rot, w, d, floors, fh: o.fh ?? p.fh, pal, deck: false, glassBroken: 0,
    interior: p.interior, roof: o.roof || p.roof, openings: [],
    state: o.state ?? 0, hp: HP[type], maxHp: HP[type], team: o.team ?? -1, hq: !!o.hq, invulnerable: !!o.invulnerable,
    seed: Math.floor(rng() * 1e9), cache: [null, null, null], colliders: [], glass: [],
  });
  if (b.state === 1) b.hp = b.maxHp * 0.55;
  if (b.state === 2) b.hp = 0;
  // Doors: front by default (wide doors for hangars / garages / barns), plus a back door on larger buildings.
  const doors = o.doors || [{ side: 0, u: 0 }];
  for (const dr of doors) {
    b.openings.push({ side: dr.side, u: dr.u ?? 0, w: dr.w ?? p.door, y0: 0, y1: Math.min(b.fh - 0.4, p.door > 4 ? b.fh - 0.8 : 2.2), floor: 0, kind: 'door' });
  }
  if (!o.doors && w * d > 90 && p.door < 4) b.openings.push({ side: 1, u: (rng() - 0.5) * (w * 0.4), w: p.door, y0: 0, y1: 2.2, floor: 0, kind: 'door' });
  // Windows every ~3.2 m on every side and storey (shops: big display windows on the ground floor).
  if (type !== 'hangar' && type !== 'vhangar' && type !== 'tower') {
    for (let side = 0; side < 4; side++) {
      const L = side < 2 ? w : d;
      const n = Math.floor((L - 1.6) / 3.2);
      for (let f = 0; f < b.floors; f++) {
        for (let i = 0; i < n; i++) {
          const u = -L / 2 + 0.8 + 3.2 * (i + 0.5) + ((L - 1.6) - n * 3.2) / 2;
          if (b.openings.some((op) => op.side === side && op.floor === f && Math.abs(op.u - u) < op.w / 2 + 0.9)) continue;
          const big = type === 'shop' && f === 0 && side === 0;
          const ww = big ? 2.4 : type === 'warehouse' || type === 'barn' ? 1.6 : 1.2;
          const y0 = big ? 0.45 : type === 'warehouse' || type === 'barn' ? b.fh - 2 : 0.95;
          const y1 = big ? 2.5 : type === 'warehouse' || type === 'barn' ? b.fh - 0.9 : Math.min(b.fh - 0.5, 2.3);
          b.openings.push({ side, u, w: ww, y0, y1, floor: f, kind: 'window' });
        }
      }
    }
  }
  return b;
}

/** Parts of a building in a damage state (cached). */
export function buildingParts(b, state = b.state) {
  if (!b.cache[state]) b.cache[state] = state === 0 ? intactParts(b) : damagedParts(b, state, buildingParts(b, 0));
  return /** @type {Part[]} */ (b.cache[state]);
}

const box = (P, x, y, z, hx, hy, hz, c, k, lod = 1, extra = null) => {
  const p = { x, y, z, hx, hy, hz, c, k, lod };
  if (extra) Object.assign(p, extra);
  P.push(p);
  return p;
};

/** Stairwell strip for storey f → f+1 (alternating sides so ramps never stack). */
function stairwell(b, f) {
  const run = Math.min(b.d - 2 * T - 1.6, b.fh * 1.75);
  const left = f % 2 === 0;
  const x0 = left ? -b.w / 2 + T : b.w / 2 - T - 1.3, x1 = x0 + 1.3;
  const z0 = -b.d / 2 + T + 0.6, z1 = z0 + run;
  return { x0, x1, z0, z1, run, up: left ? 1 : -1 };
}

function intactParts(b) {
  /** @type {Part[]} */
  const P = [];
  const { w, d, fh, floors, pal } = b;
  const rng = makeRng(b.seed);
  if (b.roof === 'open') return towerParts(b, P);
  const H = floors * fh;
  // Exterior walls with openings.
  for (let side = 0; side < 4; side++) {
    const L = side < 2 ? w : d - 2 * T;
    for (let f = 0; f < floors; f++) {
      const base = f * fh, top = base + fh;
      const ops = b.openings.filter((op) => op.side === side && op.floor === f).sort((a, c) => a.u - c.u);
      let cur = -L / 2;
      const seg = (u0, u1, y0, y1) => {
        if (u1 - u0 < 0.05 || y1 - y0 < 0.05) return;
        const u = (u0 + u1) / 2, hu = (u1 - u0) / 2, y = (y0 + y1) / 2, hy = (y1 - y0) / 2;
        const ground = f === 0 && y0 < 1.5;
        if (side === 0) box(P, u, y, d / 2 - T / 2, hu, hy, T / 2, pal.wall, K.WALL, 1, { ground });
        else if (side === 1) box(P, u, y, -d / 2 + T / 2, hu, hy, T / 2, pal.wall, K.WALL, 1, { ground });
        else if (side === 2) box(P, w / 2 - T / 2, y, u, T / 2, hy, hu, pal.wall, K.WALL, 1, { ground });
        else box(P, -w / 2 + T / 2, y, u, T / 2, hy, hu, pal.wall, K.WALL, 1, { ground });
      };
      for (const op of ops) {
        const a = Math.max(-L / 2, op.u - op.w / 2), e = Math.min(L / 2, op.u + op.w / 2);
        seg(cur, a, base, top);
        seg(a, e, base, base + op.y0);
        seg(a, e, base + op.y1, top);
        cur = e;
      }
      seg(cur, L / 2, base, top);
    }
  }
  // Floors: ground slab, upper slabs with the stairwell hole of the flight arriving from below.
  box(P, 0, 0.06, 0, w / 2 - T, 0.06, d / 2 - T, pal.floor, K.FLOOR, 0);
  const levels = b.roof === 'flat' ? floors : floors - 1;
  for (let f = 0; f < levels; f++) {
    const s = stairwell(b, f), y = (f + 1) * fh;
    const roof = f === floors - 1;
    const kind = roof ? K.ROOF : K.FLOOR, col = roof ? pal.roof : pal.floor;
    // Slab around the hole (x0..x1 × z0..z1).
    const ix0 = -w / 2 + T, ix1 = w / 2 - T, iz0 = -d / 2 + T, iz1 = d / 2 - T;
    const rect = (x0, x1, z0, z1) => { if (x1 - x0 > 0.05 && z1 - z0 > 0.05) box(P, (x0 + x1) / 2, y - 0.1, (z0 + z1) / 2, (x1 - x0) / 2, 0.11, (z1 - z0) / 2, col, kind, 1); };
    rect(ix0, s.x0, iz0, iz1);
    rect(s.x1, ix1, iz0, iz1);
    rect(s.x0, s.x1, iz0, s.z0);
    rect(s.x0, s.x1, s.z1, iz1);
    // Ramp (stairs) from storey f to f+1 inside the stairwell.
    const len = Math.hypot(s.run, fh), ang = Math.atan2(fh, s.run);
    box(P, (s.x0 + s.x1) / 2, f * fh + fh / 2, (s.z0 + s.z1) / 2, 0.62, 0.08, len / 2, pal.trim, K.RAMP, 1, { rx: -ang });
    if (roof) {
      // Parapet and a hatch rim; the roof is a fighting position.
      box(P, 0, H + 0.45, d / 2 - 0.1, w / 2, 0.45, 0.1, pal.wall, K.WALL, 1);
      box(P, 0, H + 0.45, -d / 2 + 0.1, w / 2, 0.45, 0.1, pal.wall, K.WALL, 1);
      box(P, w / 2 - 0.1, H + 0.45, 0, 0.1, 0.45, d / 2 - 0.2, pal.wall, K.WALL, 1);
      box(P, -w / 2 + 0.1, H + 0.45, 0, 0.1, 0.45, d / 2 - 0.2, pal.wall, K.WALL, 1);
    }
  }
  if (b.roof === 'gable') {
    // Pitched roof (not walkable): two tilted slabs plus gable ends.
    const rise = Math.min(3, w * 0.32), half = w / 2 + 0.4, len = Math.hypot(half, rise), ang = Math.atan2(rise, half);
    box(P, -half / 2, H + rise / 2, 0, len / 2, 0.09, d / 2 + 0.4, pal.roof, K.TRIM, 1, { rz: ang });
    box(P, half / 2, H + rise / 2, 0, len / 2, 0.09, d / 2 + 0.4, pal.roof, K.TRIM, 1, { rz: -ang });
    box(P, 0, H + 0.1, 0, w / 2 - T, 0.1, d / 2 - T, pal.floor, K.ROOF, 0);
    for (const s of [1, -1]) box(P, 0, H + rise * 0.4, s * (d / 2 - T / 2), w * 0.3, rise * 0.4, T / 2, pal.wall, K.WALL, 1);
  }
  // Interior partition with a doorway on each storey of larger buildings.
  if (w * d > 70 && !['warehouse', 'hangar', 'vhangar', 'barn', 'garage', 'shed'].includes(b.type)) {
    for (let f = 0; f < floors; f++) {
      const y = f * fh + fh / 2, zc = d * 0.12;
      const gap = 1.1, x0 = -w / 2 + T + 1.6, xg = x0 + 2.2;
      box(P, (x0 + xg - gap) / 2 - 0.25, y, zc, (xg - gap - x0) / 2, fh / 2, 0.06, pal.trim, K.WALL, 0);
      box(P, (xg + w / 2 - T) / 2, y, zc, (w / 2 - T - xg) / 2, fh / 2, 0.06, pal.trim, K.WALL, 0);
    }
  }
  furnish(b, P, rng);
  trims(b, P, rng);
  return P;
}

function towerParts(b, P) {
  const h = b.fh, c = b.pal.trim, s = 1.7;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(P, sx * s, h / 2, sz * s, 0.12, h / 2, 0.12, c, K.PILLAR, 1);
  box(P, 0, h, 0, 2.1, 0.12, 2.1, b.pal.floor, K.FLOOR, 1);
  // Railings; the back one has a gap where the ladder arrives.
  for (const [x, z, hx, hz] of [[0, 2.05, 2.1, 0.05], [-0.85, -2.05, 1.25, 0.05], [1.85, -2.05, 0.25, 0.05], [2.05, 0, 0.05, 2.1], [-2.05, 0, 0.05, 2.1]]) {
    box(P, x, h + 0.55, z, hx, 0.5, hz, b.pal.wall, K.WALL, 1);
  }
  box(P, 0, h + 2.4, 0, 2.3, 0.08, 2.3, b.pal.roof, K.TRIM, 1);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(P, sx * 1.95, h + 1.5, sz * 1.95, 0.06, 0.9, 0.06, c, K.TRIM, 0);
  // Ladder ramp up the back.
  const len = Math.hypot(h, 3.2), ang = Math.atan2(h, 3.2);
  box(P, 0.9, h / 2, -3.6, 0.45, 0.06, len / 2, c, K.RAMP, 1, { rx: -ang });
  return P;
}

/** Furniture by interior type (high detail only; no colliders except large items). */
function furnish(b, P, rng) {
  const { w, d, fh, floors } = b;
  const W = 0x6b4e33, FABRIC = [0x6b2f2f, 0x2f4a6b, 0x55603a, 0x7a6a50], METAL = 0x5a5f63, STEEL = 0x8a9095;
  const inner = (f, fn) => {
    for (let i = 0; i < 40; i++) {
      const s = stairwell(b, f), s2 = f > 0 ? stairwell(b, f - 1) : null;
      const x = (rng() - 0.5) * (w - 2.4), z = (rng() - 0.5) * (d - 2.4);
      const inStair = (st) => st && x > st.x0 - 0.6 && x < st.x1 + 0.6 && z > st.z0 - 0.6 && z < st.z1 + 0.8;
      if (inStair(s) || inStair(s2)) continue;
      if (Math.abs(x) < 1.4 && z > d / 2 - 2.4) continue; // keep the front door clear
      if (Math.abs(z - d * 0.12) < 0.8) continue;        // and the partition
      fn(x, f * fh, z);
      return;
    }
  };
  const n = (a) => a[Math.floor(rng() * a.length)];
  switch (b.interior) {
    case 'house': case 'apartment':
      for (let f = 0; f < floors; f++) {
        inner(f, (x, y, z) => { box(P, x, y + 0.4, z, 0.9, 0.04, 0.55, W, K.FURN, 0); for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(P, x + sx * 0.8, y + 0.2, z + sz * 0.45, 0.04, 0.2, 0.04, W, K.FURN, 0); });
        inner(f, (x, y, z) => { const c = n(FABRIC); box(P, x, y + 0.25, z, 1.0, 0.25, 0.45, c, K.FURN, 0); box(P, x, y + 0.6, z - 0.4, 1.0, 0.35, 0.08, c, K.FURN, 0); });
        inner(f, (x, y, z) => { box(P, x, y + 0.25, z, 1.0, 0.22, 0.7, n(FABRIC), K.FURN, 0); box(P, x, y + 0.5, z - 0.6, 1.0, 0.3, 0.05, W, K.FURN, 0); });
        inner(f, (x, y, z) => box(P, x, y + 0.9, z, 0.5, 0.9, 0.2, W, K.FURN, 0));
      }
      break;
    case 'shop':
      inner(0, (x, y, z) => box(P, x, y + 0.5, z, 1.6, 0.5, 0.4, W, K.FURN, 0));
      for (let i = 0; i < 3; i++) inner(0, (x, y, z) => { box(P, x, y + 0.85, z, 1.4, 0.85, 0.25, METAL, K.FURN, 0); for (let k = 0; k < 4; k++) box(P, x, y + 0.3 + k * 0.42, z, 1.35, 0.03, 0.26, 0xbfb6a0, K.FURN, 0); });
      break;
    case 'office': case 'hq':
      for (let f = 0; f < floors; f++) {
        for (let i = 0; i < (b.interior === 'hq' ? 4 : 3); i++) inner(f, (x, y, z) => { box(P, x, y + 0.38, z, 0.8, 0.03, 0.45, 0x5d5348, K.FURN, 0); box(P, x, y + 0.19, z + 0.35, 0.75, 0.19, 0.05, 0x5d5348, K.FURN, 0); box(P, x, y + 0.55, z - 0.2, 0.22, 0.15, 0.03, 0x22262a, K.FURN, 0); });
        if (b.interior === 'hq') {
          inner(f, (x, y, z) => box(P, x, y + 0.45, z, 1.4, 0.04, 0.9, 0x3d5a3a, K.FURN, 0));
          inner(f, (x, y, z) => { box(P, x, y + 1.0, z, 0.35, 1.0, 0.3, 0x30353a, K.FURN, 0); box(P, x, y + 1.2, z + 0.31, 0.25, 0.4, 0.01, 0x55ff88, K.FURN, 0); });
        }
      }
      break;
    case 'warehouse':
      for (let i = 0; i < 5; i++) inner(0, (x, y, z) => { for (let k = 0; k < 3; k++) box(P, x, y + 0.9 + k * 1.4, z, 2.2, 0.05, 0.55, 0xc0732e, K.FURN, 0); for (const sx of [-1, 1]) box(P, x + sx * 2.15, y + 2, z, 0.05, 2, 0.5, 0x2e5d8a, K.FURN, 0); box(P, x, y + 1.3, z, 0.9, 0.35, 0.45, 0x8a6a3c, K.FURN, 0); });
      for (let i = 0; i < 6; i++) inner(0, (x, y, z) => box(P, x, y + 0.45, z, 0.6, 0.45, 0.6, 0x8a6a3c, K.PILLAR, 0));
      break;
    case 'barn':
      for (let i = 0; i < 8; i++) inner(0, (x, y, z) => box(P, x, y + 0.5, z, 0.7, 0.5, 0.5, 0xc9a94a, K.PILLAR, 0));
      for (let i = 0; i < 3; i++) inner(0, (x, y, z) => box(P, x, y + 0.6, z, 0.05, 0.6, 1.4, W, K.FURN, 0));
      break;
    case 'barracks':
      for (let f = 0; f < floors; f++) for (let i = 0; i < 6; i++) inner(f, (x, y, z) => { box(P, x, y + 0.45, z, 0.45, 0.05, 1.0, METAL, K.FURN, 0); box(P, x, y + 1.35, z, 0.45, 0.05, 1.0, METAL, K.FURN, 0); box(P, x, y + 0.5, z, 0.4, 0.06, 0.95, 0x55603a, K.FURN, 0); box(P, x, y + 1.4, z, 0.4, 0.06, 0.95, 0x55603a, K.FURN, 0); });
      for (let f = 0; f < floors; f++) inner(f, (x, y, z) => box(P, x, y + 1, z, 0.9, 1, 0.25, STEEL, K.FURN, 0));
      break;
    case 'garage':
      inner(0, (x, y, z) => { box(P, x, y + 0.9, z, 1.8, 0.9, 0.4, METAL, K.FURN, 0); box(P, x, y + 1.85, z, 1.8, 0.05, 0.45, 0x8a4a2a, K.FURN, 0); });
      inner(0, (x, y, z) => { for (const sx of [-1, 1]) box(P, x + sx * 1.3, y + 0.8, z, 0.12, 0.8, 0.12, 0xc9a23a, K.FURN, 0); box(P, x, y + 1.5, z, 1.4, 0.06, 2.2, 0xc9a23a, K.FURN, 0); });
      inner(0, (x, y, z) => box(P, x, y + 0.45, z, 0.3, 0.45, 0.3, 0x8a2a2a, K.FURN, 0));
      break;
    case 'hangar':
      for (let i = 0; i < 4; i++) inner(0, (x, y, z) => { box(P, x, y + 0.5, z, 1.2, 0.5, 0.5, METAL, K.FURN, 0); box(P, x, y + 1.05, z, 1.2, 0.05, 0.5, 0x8a4a2a, K.FURN, 0); });
      inner(0, (x, y, z) => { box(P, x, y + 0.7, z, 0.8, 0.7, 1.5, 0xb0a25a, K.FURN, 0); });
      break;
    case 'vhangar':
      for (let i = 0; i < 3; i++) inner(0, (x, y, z) => box(P, x, y + 0.8, z - d / 2 + 1.2 + 0, 1.5, 0.8, 0.35, METAL, K.FURN, 0));
      break;
    case 'shed':
      inner(0, (x, y, z) => box(P, x, y + 0.4, z, 0.4, 0.4, 0.4, 0x8a6a3c, K.FURN, 0));
      break;
  }
}

/** Exterior trim: window frames, roof edges, awnings, antennas (high detail). */
function trims(b, P, rng) {
  const { w, d, fh, floors, pal } = b;
  for (const op of b.openings) {
    if (op.kind !== 'window') continue;
    const base = op.floor * fh;
    // Pane (breakable; drawn at high detail only).
    const gy = base + (op.y0 + op.y1) / 2, ghy = (op.y1 - op.y0) / 2, g = { g: op.side * 4 + Math.min(3, op.floor) };
    if (op.side === 0) box(P, op.u, gy, d / 2 - T / 2, op.w / 2, ghy, 0.02, GLASS, K.GLASS, 0, g);
    else if (op.side === 1) box(P, op.u, gy, -d / 2 + T / 2, op.w / 2, ghy, 0.02, GLASS, K.GLASS, 0, g);
    else if (op.side === 2) box(P, w / 2 - T / 2, gy, op.u, 0.02, ghy, op.w / 2, GLASS, K.GLASS, 0, g);
    else box(P, -w / 2 + T / 2, gy, op.u, 0.02, ghy, op.w / 2, GLASS, K.GLASS, 0, g);
    const out = 0.05;
    const L = op.side < 2 ? w : d - 2 * T;
    void L;
    if (op.side === 0) box(P, op.u, base + op.y0 - 0.05, d / 2 + out, op.w / 2 + 0.1, 0.05, 0.08, pal.trim, K.TRIM, 0);
    else if (op.side === 1) box(P, op.u, base + op.y0 - 0.05, -d / 2 - out, op.w / 2 + 0.1, 0.05, 0.08, pal.trim, K.TRIM, 0);
    else if (op.side === 2) box(P, w / 2 + out, base + op.y0 - 0.05, op.u, 0.08, 0.05, op.w / 2 + 0.1, pal.trim, K.TRIM, 0);
    else box(P, -w / 2 - out, base + op.y0 - 0.05, op.u, 0.08, 0.05, op.w / 2 + 0.1, pal.trim, K.TRIM, 0);
  }
  const H = floors * fh;
  if (b.type === 'shop') box(P, 0, fh - 0.3, d / 2 + 0.8, w / 2 - 0.4, 0.06, 0.8, rng() < 0.5 ? 0x8a2f2f : 0x2f5a8a, K.TRIM, 0);
  if (b.type === 'hq' || b.type === 'control') {
    box(P, w / 4, H + 2.5, -d / 4, 0.05, 2.5, 0.05, 0x9a9a9a, K.TRIM, 0);
    box(P, w / 4, H + 0.4, -d / 4, 0.6, 0.4, 0.6, 0x55595e, K.TRIM, 0);
  }
  if (b.type === 'control') box(P, 0, H - fh / 2, 0, w / 2 + 0.02, fh * 0.32, d / 2 + 0.02, 0x2b4a5c, K.TRIM, 0);
}

/**
 * Damaged / ruined variants: deterministic subsets of the intact parts.
 * Damaged: chunks of upper walls and roof missing, rubble inside.
 * Ruined: walls broken off at 0.6–2 m, upper floors and roof collapsed, rubble mounds.
 */
function damagedParts(b, state, intact) {
  const rng = makeRng(b.seed + state * 7919);
  /** @type {Part[]} */
  const P = [];
  const H = b.floors * b.fh;
  intact.forEach((p, i) => {
    if (p.k === K.GLASS) return;
    const r = ((Math.imul(b.seed + i * 2654435761, 0x9e3779b1) >>> 0) % 1000) / 1000;
    if (state === 1) {
      const upper = p.y - p.hy > b.fh * 0.6;
      if ((p.k === K.WALL || p.k === K.ROOF || p.k === K.TRIM) && upper && r < 0.35) return;
      if (p.k === K.FURN && r < 0.3) return;
      P.push(p);
      return;
    }
    // Ruined.
    if (p.k === K.FURN || p.k === K.TRIM || p.k === K.ROOF || p.k === K.RAMP) return;
    if (p.k === K.FLOOR && p.y > 0.5) return;
    if (p.k === K.WALL || p.k === K.PILLAR) {
      const bottom = p.y - p.hy;
      const cut = 0.6 + r * 1.6;
      if (bottom > cut || p.rx || p.rz) return;
      const top = Math.min(p.y + p.hy, cut);
      P.push({ ...p, y: (bottom + top) / 2, hy: (top - bottom) / 2 });
      return;
    }
    P.push(p);
  });
  // Rubble: inside the footprint (damaged) or heaped over it (ruined).
  const n = state === 1 ? 4 : 9;
  for (let i = 0; i < n; i++) {
    const x = (rng() - 0.5) * (b.w - 1.5), z = (rng() - 0.5) * (b.d - 1.5);
    const s = state === 1 ? 0.5 + rng() * 0.6 : 0.8 + rng() * Math.min(1.6, H * 0.18);
    P.push({ x, y: s * 0.45, z, hx: s * (0.8 + rng() * 0.6), hy: s * 0.45, hz: s * (0.8 + rng() * 0.6), c: rng() < 0.5 ? b.pal.wall : 0x6f6a62, k: K.RUBBLE, lod: 1 });
  }
  return P;
}

// ---------------------------------------------------------------- geometry emission

/**
 * Appends the boxes of `parts` (filtered by LOD) to growable vertex arrays.
 * Flat-shaded, non-indexed (36 vertices per box). `tint` modulates colours.
 * @param {{pos: number[], nrm: number[], col: number[]}} out
 */
export function emitParts(b, parts, lod, out) {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  for (const p of parts) {
    if (lod === 1 && p.lod === 0) continue;
    if (p.k === K.GLASS && (b.glassBroken >> p.g) & 1) continue;
    emitBox(out, p, b.x, b.y, b.z, c, s);
  }
}

const FACES = [
  [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
  [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
  [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
  [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
  [[0, 0, 1], [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]]],
  [[0, 0, -1], [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]]],
];
const TRI = [0, 1, 2, 0, 2, 3];

/** Rotates a part-local vector by the part's tilt (rx about X, then rz about Z). */
function tilt(p, v) {
  let [x, y, z] = v;
  if (p.rx) { const c = Math.cos(p.rx), s = Math.sin(p.rx); const y2 = y * c - z * s, z2 = y * s + z * c; y = y2; z = z2; }
  if (p.rz) { const c = Math.cos(p.rz), s = Math.sin(p.rz); const x2 = x * c - y * s, y2 = x * s + y * c; x = x2; y = y2; }
  return [x, y, z];
}

export function emitBox(out, p, bx, by, bz, c, s) {
  const r = ((p.c >> 16) & 255) / 255, g = ((p.c >> 8) & 255) / 255, bl = (p.c & 255) / 255;
  // sRGB-ish palette → linear-ish vertex colours (matches the rest of the world's colouring).
  const cr = r * r, cg = g * g, cb = bl * bl;
  for (const [n, corners] of FACES) {
    const nn = tilt(p, n);
    const wnx = nn[0] * c + nn[2] * s, wnz = -nn[0] * s + nn[2] * c;
    for (const t of TRI) {
      const k = corners[t];
      const v = tilt(p, [k[0] * p.hx, k[1] * p.hy, k[2] * p.hz]);
      const lx = p.x + v[0], ly = p.y + v[1], lz = p.z + v[2];
      out.pos.push(bx + lx * c + lz * s, by + ly, bz - lx * s + lz * c);
      out.nrm.push(wnx, nn[1], wnz);
      out.col.push(cr, cg, cb);
    }
  }
}

// ---------------------------------------------------------------- queries

/** World → building-local (x across, z deep). */
export function toLocal(b, x, z, out) {
  const dx = x - b.x, dz = z - b.z, c = Math.cos(b.rot), s = Math.sin(b.rot);
  out.x = dx * c - dz * s;
  out.z = dx * s + dz * c;
  return out;
}

/**
 * Height of a walkable part at building-local (lx, lz), or -Infinity.
 * Ramps interpolate along their length; slabs report their top surface.
 */
export function partSurface(p, lx, lz) {
  if (p.rz) return -Infinity;
  if (p.rx) {
    // Ramp along local z: footprint is its run (cos) in z, width hx in x.
    const run = p.hz * Math.cos(p.rx), rise = -p.hz * Math.sin(p.rx);
    if (Math.abs(lx - p.x) > p.hx || Math.abs(lz - p.z) > Math.abs(run)) return -Infinity;
    const t = (lz - p.z) / run;   // -1..1
    return p.y + t * rise + p.hy;
  }
  if (Math.abs(lx - p.x) > p.hx || Math.abs(lz - p.z) > p.hz) return -Infinity;
  return p.y + p.hy;
}

/**
 * Walk-through openings at ground level in building-local coordinates:
 * exterior doors (normal pointing out) and the doorways of the interior
 * partition. Navigation carves these so agents can path in and out.
 * @returns {{x: number, z: number, nx: number, nz: number, w: number}[]}
 */
export function buildingPortals(b) {
  const out = [];
  if (b.type === 'custom' || b.type === 'bridge') return out;
  const { w, d } = b;
  if (b.roof === 'open') { out.push({ x: 0.9, z: -5.4, nx: 0, nz: -1, w: 1 }); return out; }
  for (const op of b.openings) {
    if (op.kind !== 'door' || op.floor !== 0) continue;
    if (op.side === 0) out.push({ x: op.u, z: d / 2, nx: 0, nz: 1, w: op.w });
    else if (op.side === 1) out.push({ x: op.u, z: -d / 2, nx: 0, nz: -1, w: op.w });
    else if (op.side === 2) out.push({ x: w / 2, z: op.u, nx: 1, nz: 0, w: op.w });
    else out.push({ x: -w / 2, z: op.u, nx: -1, nz: 0, w: op.w });
  }
  if (w * d > 70 && !['warehouse', 'hangar', 'vhangar', 'barn', 'garage', 'shed'].includes(b.type)) {
    const zc = d * 0.12, x0 = -w / 2 + T + 1.6, xg = x0 + 2.2;
    out.push({ x: xg - 0.675, z: zc, nx: 0, nz: 1, w: 1.35 }, { x: (-w / 2 + T + x0 - 0.25) / 2, z: zc, nx: 0, nz: 1, w: 1.35 });
  }
  return out;
}

/** Footprint radius (for spatial hashing). */
export function buildingRadius(b) { return Math.hypot(b.w, b.d) / 2 + 1; }
