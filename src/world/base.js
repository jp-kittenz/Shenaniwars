import { TAU } from '../core/math.js';
import { baseToWorld } from './layout.js';
import { K, buildingParts } from './buildings.js';

/**
 * Military base (one per side, point-symmetric), in four connected parts laid out from the design sketches.
 * Base frame: u inland from the base centre, v along the coast (see layout.js BASE).
 *
 *  PT1  Ground forces, inland (u 58 → 236): HQ, supply zone and supply-truck garages, armoured-transport
 *       garages, a diamond of four barracks (infantry spawn inside), radio mast and operations building, transport
 *       garages flanked by SAMs, the big assembly area, tank garages, three gates in the inland wall and a gate in
 *       each side wall (HMG pairs at every gate), missile-truck reload zone and garage.
 *  PT2  Fixed-wing airfield (+v, seaward of the ring road): hangars for the strike / light-attack jets, the light
 *       transport and three fighters along a parallel taxiway, radio mast and SAMs, tower (ATC), three barracks,
 *       aircraft supply depots across the runway.
 *  PT3  Helicopters and artillery (middle): helicopter hangars behind their typed pads, recon hangar, heliport ATC,
 *       barracks, radar building, MLRS / artillery garage and HQ at the end of the runway, SAMs.
 *  PT4  Harbour (−v end): three ramped slips cut into the coast with gantry cranes between them, harbour building,
 *       HQ, SAMs, reserve universal helipad, container yard and reserve universal garage.
 *
 * A ring road (u 58) joins the four parts; PT1's inner road (u 86), the side-gate roads and the gate roads join
 * the garages, the assembly area and the gates. Everything a vehicle starts in is returned as typed slots
 * (garages by category, hangar stands, typed helipads, assembly-area and reserve slots) for map-generator.
 */

const COL = { STEEL: 0x7d8288, DARK: 0x3a3d40, YEL: 0xd8b23a, WHITE: 0xe8e4da, RED: 0xb3352a, OLIVE: 0x4f5a38, CONC: 0x8d8a82 };
const part = (x, y, z, hx, hy, hz, c, k = K.TRIM, lod = 1, extra) => ({ x, y, z, hx, hy, hz, c, k, lod, ...(extra || {}) });

/** Lattice radio mast with platforms, dishes, whip antennas and an equipment hut. */
function mastParts(h = 32) {
  const P = [], s = 1.25;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.push(part(sx * s, h / 2, sz * s, 0.1, h / 2, 0.1, COL.STEEL, K.PILLAR));
  for (let y = 2; y < h; y += 3) {
    for (const sz of [-1, 1]) P.push(part(0, y + 1.5, sz * s, 1.7, 0.04, 0.04, COL.STEEL, K.TRIM, 1, { rz: (y / 3) % 2 ? 0.88 : -0.88 }));
    for (const sx of [-1, 1]) P.push(part(sx * s, y + 1.5, 0, 0.04, 0.04, 1.7, COL.STEEL, K.TRIM, 1, { rx: (y / 3) % 2 ? 0.88 : -0.88 }));
    P.push(part(0, y, s, s, 0.04, 0.04, COL.STEEL), part(0, y, -s, s, 0.04, 0.04, COL.STEEL), part(s, y, 0, 0.04, 0.04, s, COL.STEEL), part(-s, y, 0, 0.04, 0.04, s, COL.STEEL));
  }
  for (const y of [h * 0.45, h * 0.8]) { P.push(part(0, y, 0, 1.9, 0.06, 1.9, COL.DARK, K.TRIM)); for (const [x, z, hx, hz] of [[0, 1.9, 1.9, 0.03], [0, -1.9, 1.9, 0.03], [1.9, 0, 0.03, 1.9], [-1.9, 0, 0.03, 1.9]]) P.push(part(x, y + 0.5, z, hx, 0.5, hz, COL.STEEL, K.TRIM, 0)); }
  // Dishes (flat discs approximated by thin boxes) and panel antennas.
  P.push(part(1.9, h * 0.62, 0, 0.12, 0.8, 0.8, COL.WHITE, K.TRIM, 1, { rz: 0.15 }), part(-1.9, h * 0.7, 0.6, 0.12, 0.6, 0.6, COL.WHITE, K.TRIM, 1, { rz: -0.2 }));
  for (const [x, z] of [[1.3, 1.3], [-1.3, 1.3], [1.3, -1.3]]) P.push(part(x * 1.15, h * 0.85, z * 1.15, 0.18, 0.9, 0.08, COL.WHITE, K.TRIM));
  P.push(part(0, h + 2, 0, 0.05, 2, 0.05, COL.STEEL), part(0.6, h + 1.2, 0, 0.03, 1.2, 0.03, COL.STEEL), part(0, h + 4.05, 0, 0.15, 0.08, 0.15, 0xff3020, K.LAMP, 0));
  for (const y of [h * 0.33, h * 0.66]) P.push(part(0, y, 0, 0.2, 0.06, 0.2, 0xff3020, K.LAMP, 0));
  // Equipment hut and cable tray.
  P.push(part(3.4, 1.3, 0, 1.4, 1.3, 1.1, 0x8f9488, K.PILLAR), part(3.4, 2.65, 0, 1.6, 0.06, 1.3, COL.DARK), part(2.0, 2.2, 0, 0.6, 0.06, 0.15, COL.DARK));
  return P;
}

/** Stepped radome (a dome of square layers; a second copy turned 45° makes it octagonal). */
function radomeParts(r = 3.4) {
  const P = [];
  for (let i = 0; i < 7; i++) {
    const a = (i + 0.5) / 7 * Math.PI / 2, y = Math.sin(a) * r, hr = Math.cos(a) * r * 0.92;
    P.push(part(0, y, 0, hr, r / 14 + 0.02, hr, 0xe6e2d8, K.TRIM));
  }
  return P;
}

/** Harbour gantry crane straddling the quay, its girder reaching out over the slip / sea (−u = local −z). */
function craneParts() {
  const P = [], H = 20, Y = 0xc9a23a;
  for (const z of [-7, 7]) for (const x of [-4.5, 4.5]) P.push(part(x, H / 2, z, 0.35, H / 2, 0.35, Y, K.PILLAR));
  for (const z of [-7, 7]) P.push(part(0, H - 0.5, z, 4.9, 0.5, 0.4, Y), part(0, 1.0, z, 4.9, 0.3, 0.3, Y));
  for (const x of [-4.5, 4.5]) P.push(part(x, H + 0.4, -14, 0.4, 0.5, 26, Y));
  P.push(part(0, H + 1.4, -14, 4.9, 0.12, 0.6, Y), part(0, H + 1.4, 11.5, 4.9, 0.12, 0.6, Y));
  P.push(part(0, H - 0.1, -26, 2.2, 0.8, 1.6, COL.DARK), part(0, H - 3, -26, 0.05, 2.2, 0.05, COL.DARK), part(0, H - 5.4, -26, 1.2, 0.25, 0.6, COL.RED));
  P.push(part(3.6, H - 2.5, 7.8, 1.3, 1.1, 1.3, 0x5f6a58, K.TRIM), part(3.6, H - 2.4, 9.15, 1.0, 0.5, 0.02, 0x7fa6b8, K.TRIM, 0));
  P.push(part(0, H + 3, 7, 0.4, 3, 0.4, Y), part(0, H + 2.8, 13, 2.4, 1.0, 1.6, 0x6a6f74, K.TRIM)); // A-frame and counterweight
  P.push(part(4.5, H + 1.1, 7, 0.18, 0.08, 0.18, 0xff3020, K.LAMP, 0));
  return P;
}

/** Guard booth with a raised boom barrier beside a gate lane (booth on local +x of the lane). */
function boothParts() {
  return [
    part(0, 1.3, 0, 1.3, 1.3, 1.2, 0xc9c3b4, K.PILLAR), part(0, 2.7, 0, 1.6, 0.12, 1.5, COL.DARK),
    part(0, 1.6, 1.21, 0.9, 0.45, 0.02, 0x7fa6b8, K.TRIM, 0), part(-1.31, 1.6, 0, 0.02, 0.45, 0.8, 0x7fa6b8, K.TRIM, 0),
    part(0, 2.45, 1.3, 0.25, 0.06, 0.1, 0xfff1d8, K.LAMP, 0),
    part(-1.8, 0.55, 1.6, 0.2, 0.55, 0.2, COL.RED), ...Array.from({ length: 5 }, (_, i) => part(-1.8 - 0.1 - i * 0.62 * Math.cos(1.25), 1.1 + i * 0.62 * Math.sin(1.25) + 0.3, 1.6, 0.31, 0.05, 0.05, i % 2 ? COL.RED : COL.WHITE, K.TRIM, 1, { rz: -1.25 })),
  ];
}

/** Missile-transport canisters on trestles, and a gantry over the reload pad. */
function reloadParts(w, d) {
  const P = [];
  for (let i = 0; i < 3; i++) {
    const x = -w / 2 + 3 + i * 2.6;
    for (const z of [-4, 4]) P.push(part(x, 0.5, z, 0.9, 0.5, 0.25, COL.DARK, K.PILLAR));
    for (const y of [1.45, 2.5]) { P.push(part(x - 0.55, y, 0, 0.48, 0.48, 6.2, 0x5c6a3f, K.TRIM)); P.push(part(x + 0.55, y, 0, 0.48, 0.48, 6.2, 0x5c6a3f, K.TRIM)); P.push(part(x - 0.55, y, 6.2, 0.3, 0.3, 0.05, COL.YEL, K.TRIM, 0)); }
  }
  for (const z of [-d / 2 + 1, d / 2 - 1]) for (const x of [-w / 2 + 1, w / 2 - 1]) P.push(part(x, 5, z, 0.3, 5, 0.3, COL.YEL, K.PILLAR));
  for (const x of [-w / 2 + 1, w / 2 - 1]) P.push(part(x, 10.2, 0, 0.35, 0.35, d / 2 - 0.7, COL.YEL));
  P.push(part(0, 10.2, 0, w / 2 - 0.7, 0.4, 0.4, COL.YEL), part(1.5, 9.5, 0, 0.9, 0.5, 0.7, COL.DARK), part(1.5, 7.2, 0, 0.04, 1.8, 0.04, COL.DARK), part(1.5, 5.3, 0, 0.5, 0.15, 0.5, COL.RED));
  for (const x of [-w / 2 + 1, w / 2 - 1]) P.push(part(x, 10.7, 0, 0.18, 0.08, 0.18, 0xfff1d8, K.LAMP, 0));
  return P;
}

export function buildBase(ctx, b, B) {
  const W = (u, v) => baseToWorld(b, u, v);
  /** World yaw for a building whose front faces the local direction (du, dv). */
  const face = (du, dv) => Math.atan2(du * b.inland, dv * b.inland);
  const IN = face(1, 0), SEA = face(-1, 0), PV = face(0, 1), NV = face(0, -1);
  const torsa = b.team === 1, style = torsa ? 'torsa' : 'pampalona';
  const own = { style, team: b.team, invulnerable: true, military: true, force: true };
  ctx.zone(b.x, b.z, 430, 'base');
  const rec = {
    team: b.team, x: b.x, z: b.z, inland: b.inland, hq: [], sams: [], gates: [], spawnPoints: [],
    garages: { tanks: [], armoured: [], transport: [], supply: [], artillery: [], missile: [], reserve: [] },
    assembly: [], stands: [], pads: [], radarStand: null, lanes: [],
    infantry: W(124, -268), vehicles: W(184, 19), aircraft: W(20, 10), resupply: W(72, 55), flagpole: W(104, -2),
    park: { u0: 160, u1: 208, v0: -112, v1: 150, vMid: 19 },
  };
  const bld = (type, u, v, rot, o = {}) => {
    const p = W(u, v), bl = ctx.building(type, p.x, p.z, rot, { ...own, ...o });
    if (bl) lampsOf(bl);
    return bl;
  };
  /** Interior light fixtures → light records (pool lights by day, glows at night); barracks spawn points. */
  const lampsOf = (bl) => {
    buildingParts(bl);
    const c = Math.cos(bl.rot), s = Math.sin(bl.rot);
    const wp = (lx, lz) => [bl.x + lx * c + lz * s, bl.z - lx * s + lz * c];
    for (const [lx, ly, lz] of bl.lamps || []) { const [x, z] = wp(lx, lz); ctx.lampAbs(x, bl.y + ly, z, 'interior', bl.id); }
    for (const [lx, lz] of bl.spawns || []) { const [x, z] = wp(lx, lz); rec.spawnPoints.push({ x, z }); }
  };
  const structure = (name, u, v, rot, parts, w, d, o = {}) => { const p = W(u, v); return ctx.structure(name, p.x, p.z, rot, parts, { w, d, ...o }); };
  const street = (u0, v0, u1, v1, w = 8) => { const a = W(u0, v0), e = W(u1, v1); ctx.street(a.x, a.z, e.x, e.z, w); rec.lanes.push({ u0: Math.min(u0, u1) - w / 2, u1: Math.max(u0, u1) + w / 2, v0: Math.min(v0, v1) - w / 2, v1: Math.max(v0, v1) + w / 2 }); };
  const pave = (u, v, hu, hv) => { const p = W(u, v); ctx.paveRect(p.x, p.z, hv, hu, face(1, 0)); };
  const sam = (u, v) => { const p = W(u, v); rec.sams.push({ x: p.x, z: p.z, team: b.team }); ctx.prop('samsite', p.x, p.z, IN, { hx: 1.6, hy: 1.6, hz: 2.4, base: b.team }); };
  const hmg = (u, v, rot) => { const p = W(u, v); ctx.vehicle('hmgturret', b.team, p.x, p.z, rot); };
  const flood = (u, v) => { const p = W(u, v), pole = ctx.prop('pole', p.x, p.z, 0, { hx: 0.15, hy: 5, hz: 0.15 }); ctx.light(p.x, 10, p.z, 'flood', pole.id); };
  /** Ground markings (thin strips on the paving; not obstacles). */
  const markings = (u, v, rot, parts, w, d) => structure('marking', u, v, rot, parts, w, d, { nonav: true });
  /**
   * Garage row: `n` drive-in buildings of `bays` bays each, fronts facing `dir` (local), centred at (u, v) along v.
   * Every bay is a parking slot of category `cat` (vehicle facing out, approach point in front of the door).
   */
  const garageRow = (cat, u, v, n, bays, bayW, depth, du, gap = 4) => {
    const wB = bays * bayW, span = n * wB + (n - 1) * gap;
    for (let i = 0; i < n; i++) {
      const vc = v - span / 2 + wB / 2 + i * (wB + gap);
      const g = bld('bays', u, vc, face(du, 0), { bays, w: wB, d: depth, fh: depth > 16 ? 7.5 : 6.5, roof: 'flat' });
      if (!g) continue;
      pave(u, vc, depth / 2 + 0.5, wB / 2 + 0.5);
      pave(u + du * (depth / 2 + 7), vc, 7, wB / 2 + 1);
      for (let k = 0; k < bays; k++) {
        const vb = vc - wB / 2 + bayW * (k + 0.5), p = W(u + du * 0.6, vb), a = W(u + du * (depth / 2 + 9), vb);
        rec.garages[cat].push({ x: p.x, z: p.z, yaw: face(du, 0), len: depth - 1.5, r: Math.min(bayW / 2 + 1, 6.5), ax: a.x, az: a.z, building: g.id });
      }
    }
  };

  // ===================================================================== perimeter, ring road, lighting
  const L = B.halfLength;
  rec.gates = B.gateList.map((g) => W(g.u, g.v));
  const wall = (u0, v0, u1, v1) => {
    const len = Math.hypot(u1 - u0, v1 - v0), n = Math.ceil(len / 9);
    const a = W(u0, v0), e = W(u1, v1), rot = Math.atan2(e.x - a.x, e.z - a.z) + Math.PI / 2;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, u = u0 + (u1 - u0) * t, v = v0 + (v1 - v0) * t;
      if (B.gateList.some((g) => Math.hypot(g.u - u, g.v - v) < 14)) continue;
      const p = W(u, v);
      ctx.prop('wall', p.x, p.z, rot, { hx: len / n / 2 + 0.3, hy: 2.3, hz: 0.45, base: b.team });
    }
  };
  wall(B.wall, -L, B.wall, L);
  wall(B.coast + 4, -L, B.wall, -L);
  wall(B.coast + 4, L, B.wall, L);
  // Gates: guard booth, floodlight, HMG pair (PT1 sketch).
  for (const g of B.gateList) {
    const side = g.u !== B.wall, sg = Math.sign(g.v);
    const along = side ? [0, sg] : [1, 0], across = side ? [1, 0] : [0, 1];
    const bu = g.u - along[0] * 9 + across[0] * 17, bv = g.v - along[1] * 9 + across[1] * 17;
    structure('booth', bu, bv, face(along[0], along[1]), boothParts(), 4, 4);
    flood(g.u - along[0] * 12 - across[0] * 17, g.v - along[1] * 12 - across[1] * 17);
    if (side) for (const du of [-1, 1]) hmg(g.u + du * 20, g.v - sg * 14, face(0, sg));
  }
  for (const v of [-10, 90]) hmg(B.wall - 10, v, IN);
  // Ring road joining the four parts, floodlit.
  street(B.ring, -L + 6, B.ring, L - 6, 10);
  for (let v = -L + 30; v < L; v += 60) flood(B.ring + 7, v);

  // Hardstands: concrete over the working areas of every part (lawns stay between PT1's buildings).
  pave(75, 0, 17, 330);          // PT1 north row: garages, HQ, supply zone
  pave(7, 128, 14, 122);         // PT2 apron between the hangars and the runway
  pave(10, -55, 13, 62);         // PT3 helicopter apron
  pave(25, -170, 25, 52);        // PT3 heliport / radar block
  pave(-48, -170, 22, 52);       // PT3 artillery garage and HQ, seaward
  pave(-9, -292, 29, 68);        // PT4 harbour yard (inland of the slips)

  // ===================================================================== PT1 — ground forces
  street(86, -330, 86, 330);                                  // inner road along the garage fronts
  for (const v of [-320, -225, 230, 320]) street(B.ring, v, 86, v);
  street(86, -130, 160, -130); street(86, 200, 160, 200);     // down to the assembly area
  street(150, -L, 150, -112); street(150, 152, 150, L);       // side-gate roads
  for (const g of B.gateList.filter((x) => x.u === B.wall)) street(204, g.v, B.wall + 8, g.v, 12);
  street(201, -250, 201, -112);                               // tank garages to the assembly area
  for (let v = -300; v <= 300; v += 60) flood(92, v);
  // Assembly area: paved, marked slots in two rows facing the gates, floodlit.
  pave(184, 19, 24, 131);
  // Marked slots in two rows (u 172 / 196) facing the gates; the lanes in line with the gates stay open.
  const slotLines = [part(0, 0.03, 0, 0.12, 0.03, 128, COL.YEL)];
  for (const u of [172, 196]) {
    for (let v = -104; v <= 142; v += 9) {
      if (u === 196 && [-60, 40, 140].some((gv) => Math.abs(gv - v) < 8)) continue;
      const p = W(u, v), a = W(u + 10, v);
      rec.assembly.push({ x: p.x, z: p.z, yaw: IN, r: 4.8, ax: a.x, az: a.z });
    }
    for (let v = -108.5; v <= 146.5; v += 9) slotLines.push(part(u - 184, 0.03, v - 19, 4.5, 0.03, 0.06, COL.WHITE));
  }
  // (local x = +u, local z = +v for a structure facing +v)
  markings(184, 19, PV, slotLines, 48, 262);
  for (const v of [-100, -40, 20, 80, 140]) for (const u of [161, 207]) flood(u, v);
  // HQ (north row), supply zone, supply-truck garages, armoured-transport garages.
  const hq1 = bld('hq', 72, 0, IN, { hq: true, w: 26, d: 18, floors: 2, doors: [{ side: 0 }, { side: 1 }] });
  if (hq1) { hq1.hqIndex = rec.hq.length; rec.hq.push(hq1.id); }
  pave(72, 55, 10, 14);
  { const p = W(72, 55); ctx.supply(p.x, p.z, 20, b.team); }
  for (let i = 0; i < 8; i++) { const p = W(66 + (i % 4) * 3.5, 46 + Math.floor(i / 4) * 16); ctx.prop('crate', p.x, p.z, (i * 0.7) % TAU, { hx: 0.65, hy: 0.65, hz: 0.65, hp: 90, destructible: true }); }
  for (const v of [50, 60]) { const p = W(80, v); ctx.prop('fueltank', p.x, p.z, 0, { hx: 1.6, hy: 1.8, hz: 1.6, base: b.team }); }
  garageRow('supply', 70, 114, 3, 2, 7.5, 15, 1);
  garageRow('armoured', 70, -165, 3, 4, 7.5, 15, 1);
  // Barracks diamond around a courtyard (infantry spawn inside), PT1 top-left.
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4, cu = 124 + Math.cos(a) * 17, cv = -268 + Math.sin(a) * 17;
    bld('barracks', cu, cv, face(-Math.cos(a), -Math.sin(a)), { w: 22, d: 10, floors: 2, roof: torsa ? 'flat' : 'flat', doors: [{ side: 0 }, { side: 1 }] });
  }
  pave(124, -268, 13, 13);
  flood(124, -268);
  // Radio mast and operations building; transport garages with SAMs either side.
  structure('mast', 112, 22, IN, mastParts(32), 8, 6);
  { const p = W(112, 22); ctx.lampAbs(p.x, ctx.groundAt(p.x, p.z) + 36.1, p.z, 'beacon', -1); }
  bld('office', 112, 66, SEA, { w: 22, d: 12, floors: 2, doors: [{ side: 0 }, { side: 1 }] });
  garageRow('transport', 140, 0, 3, 2, 7.5, 15, 1);
  sam(140, -46); sam(140, 46);
  // Tank garages (bottom-left), backs against the inland wall (no blind alley behind them), facing the assembly area.
  garageRow('tanks', 227, -211, 3, 3, 7.5, 15, -1);
  // Missile-truck reload zone and garage (right flank).
  pave(188, 300, 12, 13);
  structure('reload', 188, 300, PV, reloadParts(12, 22), 14, 24);
  { const p = W(188, 300); ctx.supply(p.x, p.z, 14, b.team); }
  garageRow('missile', 226, 300, 1, 2, 9, 18, -1);
  street(188, 152, 188, 285);
  flood(176, 286); flood(200, 314);

  // ===================================================================== PT2 — fixed-wing airfield
  const R = B.runway;
  const r0 = W(R.u, R.v0), r1 = W(R.u, R.v1);
  ctx.runway(b.team, r0.x, r0.z, r1.x, r1.z, R.width);
  const hangar = (types, v, w, d, fh = 10) => {
    // Aircraft hangar: doors open across nearly the whole front (wingspans), no floor slab (it taxis in and out).
    const h = bld('hangar', 36, v, SEA, { style: torsa ? 'metal' : 'pampalona', w, d, fh, doors: [{ side: 0, w: w - 3 }], drive: true });
    pave(36, v, d / 2, w / 2);
    pave(36 - d / 2 - 7, v, 7, w / 2 - 1);
    rec.stands.push({ types, v, u: 36 - d / 2, x: W(36, v).x, z: W(36, v).z, w, building: h ? h.id : -1 });
    return h;
  };
  hangar(['strikejet', 'lightattack'], 40, 44, 30);
  hangar(['transportplane'], 88, 40, 32, 11);
  hangar(['fighter2'], 133, 34, 30);
  hangar(['fighter3'], 175, 34, 30);
  hangar(['fighter'], 217, 34, 30);
  // Taxiway along the hangar fronts with stubs to every door and three links to the runway (yellow centrelines).
  pave(7, 128, 7, 120);
  for (const v of [20, 130, 245]) pave(-1, v, 8, 6);
  const tx = [part(0, 0.03, 0, 0.1, 0.03, 118, COL.YEL)];
  markings(7, 128, PV, tx, 1, 240);
  for (const v of [20, 130, 245]) markings(-1, v, IN, [part(0, 0.03, 0, 0.1, 0.03, 8, COL.YEL)], 1, 16);
  for (const s of rec.stands) markings(14, s.v, IN, [part(0, 0.03, 0, 0.1, 0.03, 7, COL.YEL)], 1, 14);
  structure('mast', 36, 262, SEA, mastParts(26), 8, 6);
  { const p = W(36, 262); ctx.lampAbs(p.x, ctx.groundAt(p.x, p.z) + 30.1, p.z, 'beacon', -1); }
  sam(16, 255); sam(16, 272);
  bld('control', 2, 300, SEA, { floors: 3 });
  for (const v of [290, 316, 342]) bld('barracks', 38, v, SEA, { w: 22, d: 10, floors: 2, doors: [{ side: 0 }, { side: 1 }] });
  // Aircraft supply depots across the runway, fuel farm beside them.
  for (const v of [40, 76]) bld('warehouse', -54, v, IN, { style: 'metal', w: 30, d: 14 });
  for (let i = 0; i < 4; i++) { const p = W(-58 + (i % 2) * 7, 104 + Math.floor(i / 2) * 7); ctx.prop('fueltank', p.x, p.z, 0, { hx: 2.4, hy: 2.8, hz: 2.4, base: b.team }); }
  { const p = W(-54, 58); ctx.supply(p.x, p.z, 22, b.team); }
  for (const v of [30, 150, 270]) flood(-40, v);
  for (const v of [20, 100, 180]) flood(20, v);

  // ===================================================================== PT3 — helicopters and artillery
  const pad = (types, u, v, r) => { const p = W(u, v); ctx.helipad(-1, p.x, p.z); rec.pads.push({ types, x: p.x, z: p.z, r }); };
  // Helicopter hangars behind their pads.
  bld('hangar', 36, -98, SEA, { w: 32, d: 26, fh: 9, doors: [{ side: 0, w: 32 - 3 }] }); pad(['heavyheli'], 8, -98, 15);
  bld('hangar', 36, -66, SEA, { w: 28, d: 24, fh: 8, doors: [{ side: 0, w: 28 - 3 }] }); pad(['gunship'], 8, -66, 12);
  bld('hangar', 36, -35, SEA, { w: 30, d: 22, fh: 8, doors: [{ side: 0, w: 30 - 3 }] }); pad(['attackheli', 'heli'], 4, -44, 7.5); pad(['attackheli', 'heli'], 4, -26, 7.5);
  bld('hangar', 36, -4, SEA, { w: 28, d: 22, fh: 8, doors: [{ side: 0, w: 28 - 3 }] }); pad(['transportheli'], 8, -6, 9);
  // Recon hangar and pad, heliport ATC, barracks, radar building (+ radar vehicle stand), SAM.
  bld('hangar', 36, -150, SEA, { w: 24, d: 20, fh: 7, doors: [{ side: 0, w: 24 - 3 }] }); pad(['reconheli'], 8, -150, 9);
  bld('control', 8, -185, SEA, { floors: 3 });
  bld('barracks', 8, -126, SEA, { w: 22, d: 10, floors: 2, doors: [{ side: 0 }, { side: 1 }] });
  const radar = bld('office', 38, -207, SEA, { w: 14, d: 11, floors: 1 });
  if (radar) for (const rr of [0, Math.PI / 4]) structure('radome', 38, -207, radar.rot + rr, radomeParts(3.4), 7, 7, { y: radar.y + radar.fh, nonav: true });
  { const p = W(14, -212); rec.radarStand = { x: p.x, z: p.z, yaw: SEA }; pave(14, -212, 7, 8); }
  sam(44, -118);
  // End of the runway, seaward: MLRS / artillery garage and HQ, SAMs.
  garageRow('artillery', -50, -175, 1, 5, 8, 17, 1);
  street(-34, -175, B.ring, -175);
  const hq3 = bld('hq', -50, -132, IN, { hq: true, w: 18, d: 14, floors: 2, doors: [{ side: 0 }, { side: 1 }] });
  if (hq3) { hq3.hqIndex = rec.hq.length; rec.hq.push(hq3.id); }
  sam(-63, -208); sam(-63, -114);
  for (const v of [-205, -150]) flood(-30, v);
  // Air defence guns at both runway ends.
  for (const v of [R.v0 - 22, R.v1 + 18]) { const p = W(R.u, v); ctx.vehicle('aaturret', b.team, p.x, p.z, IN); }

  // ===================================================================== PT4 — harbour
  street(-30, -L + 8, -30, -228, 9); street(-30, -228, B.ring, -228, 9);
  for (const sl of B.slips) {
    // Quay apron at the head of each slip and bollards along its edges.
    pave(B.slipInland + 5, sl.v, 5, sl.hw + 2);
    for (let u = B.coast + 4; u < B.slipInland - 2; u += 7) for (const sg of [-1, 1]) { const p = W(u, sl.v + sg * (sl.hw + 0.8)); ctx.prop('crate', p.x, p.z, 0, { hx: 0.3, hy: 0.4, hz: 0.3 }); }
  }
  for (let k = 0; k < B.slips.length - 1; k++) {
    const v = (B.slips[k].v + B.slips[k + 1].v) / 2;
    pave(-50, v, 22, 9);
    structure('crane', -40, v, IN, craneParts(), 11, 16);
  }
  for (let u = B.coast + 6; u < -30; u += 14) for (const v of [-321, -279, -237]) flood(u, v);
  bld('warehouse', -12, -300, SEA, { style: 'metal', w: 40, d: 16 });
  const hq4 = bld('hq', -12, -252, SEA, { hq: true, w: 18, d: 14, floors: 2, doors: [{ side: 0 }, { side: 1 }] });
  if (hq4) { hq4.hqIndex = rec.hq.length; rec.hq.push(hq4.id); }
  sam(8, -240); sam(-44, -236); sam(-20, -356);
  // Reserve universal helipad (two pads on one apron), container yard, reserve universal garage.
  pave(16, -349, 22, 10);
  pad(['transportheli', 'attackheli', 'heli', 'reconheli', 'gunship'], 4, -349, 9); pad(['transportheli', 'attackheli', 'heli', 'reconheli', 'gunship'], 28, -349, 9);
  for (let i = 0; i < 12; i++) {
    const p = W(18 + (i % 4) * 7, -310 + Math.floor(i / 4) * 3);
    ctx.prop('container', p.x, p.z, face(1, 0), { hx: 1.25, hy: 1.3, hz: 3.05, hue: ctx.rng(), base: b.team });
    if (i % 3 === 0) { const t = W(18 + (i % 4) * 7, -296); ctx.prop('container', t.x, t.z, face(1, 0), { hx: 1.25, hy: 1.3, hz: 3.05, hue: ctx.rng(), base: b.team }); }
  }
  garageRow('reserve', 34, -254, 1, 4, 8, 16, 1);
  flood(30, -330); flood(30, -280);
  return rec;
}
