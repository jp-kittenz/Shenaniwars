import { TAU } from '../core/math.js';
import { baseToWorld } from './layout.js';

/**
 * Site builders: every objective and both military bases get their own
 * layout and features (see layout.js). Builders work through a context
 * object supplied by the map generator:
 *   ctx.building(type, x, z, rot, opts) → Building | null   (null if the lot is taken; footprint levelled)
 *   ctx.prop(type, x, z, rot, opts)     → Prop
 *   ctx.light(x, y, z, kind, propId)     night lighting point (y above ground)
 *   ctx.zone(x, z, r, kind)              ambient sound / atmosphere zone
 *   ctx.paveRect(x, z, hw, hd, yaw) / ctx.paveDisc(x, z, r) / ctx.helipad(team, x, z)
 *   ctx.street(ax, az, bx, bz, w)        paved street
 *   ctx.vehicle(type, team, x, z, yaw)   static emplacement (turret, searchlight)
 *   ctx.runway(team, x0, z0, x1, z1, w)  airstrip (edge lights included)
 *   ctx.pier(x, z, yaw, len, w)          walkable / drivable pier into the sea
 *   ctx.tunnel(ax, az, bx, bz)           cut-and-cover passage under a street
 *   ctx.supply(x, z, r, team)            resupply / repair station
 *   ctx.rng()
 */

/** Local frame helper: (lx, lz) relative to (cx, cz) rotated by yaw → world. */
export const frame = (cx, cz, yaw) => {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return (lx, lz) => ({ x: cx + lx * c + lz * s, z: cz - lx * s + lz * c });
};

const pick = (rng, a) => a[Math.floor(rng() * a.length)];
const LAMP = { hx: 0.12, hy: 3.6, hz: 0.12, hp: 60, destructible: true };
const CONTAINER = (rng) => ({ hx: 1.25, hy: 1.3, hz: 3.05, hue: rng() });
const CRATE = { hx: 0.65, hy: 0.65, hz: 0.65, hp: 90, destructible: true };
const BARRIER = { hx: 1.5, hy: 0.6, hz: 0.3, hp: 260, destructible: true };

function lamp(ctx, x, z, rot) {
  const l = ctx.prop('streetlight', x, z, rot, LAMP);
  ctx.light(x, 7, z, 'street', l.id);
  return l;
}
function flood(ctx, x, z) {
  const p = ctx.prop('pole', x, z, 0, { hx: 0.15, hy: 5, hz: 0.15 });
  ctx.light(x, 10, z, 'flood', p.id);
}

/**
 * Builds the objective `flag` (FLAGS entry with world y) and returns the
 * yaw its layout was aligned to. `mainYaw` points along its main road.
 */
export function buildSite(ctx, flag, mainYaw) {
  switch (flag.kind) {
    case 'town-ruined': return town(ctx, flag, mainYaw, { radius: 95, max: 34, ruin: 0.8, types: ['house', 'house', 'apartment', 'shop', 'apartment', 'office'], center: 'townhall', tunnel: true, debris: 30, lights: 0.25, courtyards: false });
    case 'town-intact': return town(ctx, flag, mainYaw, { radius: 85, max: 30, ruin: 0, types: ['shop', 'shop', 'apartment', 'house', 'apartment', 'office'], center: 'apartment', tunnel: false, debris: 2, lights: 1, courtyards: true });
    case 'town-farm': return farmTown(ctx, flag, mainYaw);
    case 'village': return village(ctx, flag, mainYaw);
    case 'outpost-turrets': return outpost(ctx, flag, mainYaw, 'turrets');
    case 'outpost-river': return outpost(ctx, flag, mainYaw, 'river');
    case 'outpost-helipad': return outpost(ctx, flag, mainYaw, 'helipad');
    case 'outpost-runway': return outpost(ctx, flag, mainYaw, 'runway');
    case 'depot-large': return depot(ctx, flag, mainYaw, true);
    case 'depot-forest': return depot(ctx, flag, mainYaw, false);
    case 'harbor': return harbor(ctx, flag, mainYaw, false);
    case 'harbor-cranes': return harbor(ctx, flag, mainYaw, true);
  }
  return mainYaw;
}

// ---------------------------------------------------------------- towns

/**
 * Grid town: three streets along the main road crossed by three cross
 * streets, a central square around the flag, lots on both sides of each
 * street with buildings facing it, courtyards behind (intact towns) or
 * rubble and wrecks (ruined towns), streetlights and parked cars.
 */
function town(ctx, f, yaw, o) {
  const rng = ctx.rng, F = frame(f.x, f.z, yaw);
  ctx.zone(f.x, f.z, o.radius + 30, o.ruin > 0 ? 'ruins' : 'town');
  const streets = [-44, 0, 44], cross = [-44, 0, 44];
  for (const sx of streets) { const a = F(sx, -o.radius), b = F(sx, o.radius); ctx.street(a.x, a.z, b.x, b.z, 9); }
  for (const sz of cross) { const a = F(-o.radius, sz), b = F(o.radius, sz); ctx.street(a.x, a.z, b.x, b.z, 8); }
  /** Reserved lots in the site frame (centre, half extents along x / z). */
  const placed = [{ lx: 0, lz: 0, hw: 20, hd: 20 }];
  const free = (lx, lz, hw, hd) => {
    if (Math.hypot(lx, lz) > o.radius - Math.max(hw, hd)) return false;
    if (cross.some((sz) => Math.abs(lz - sz) < 4.6 + hd)) return false;
    if (streets.some((sx) => Math.abs(lx - sx) < 5 + hw)) return false;
    return placed.every((p) => Math.abs(p.lx - lx) > p.hw + hw + 2.2 || Math.abs(p.lz - lz) > p.hd + hd + 2.2);
  };
  // Underground passage under the central cross street, between two blocks.
  if (o.tunnel) {
    const a = F(-22, -15), b = F(-22, 15);
    ctx.tunnel(a.x, a.z, b.x, b.z);
    placed.push({ lx: -22, lz: 0, hw: 4, hd: 16 });
  }
  // The landmark building on the square: town hall (ruined town) or an apartment block.
  const cb = F(-22, 24);
  if (ctx.building(o.center, cb.x, cb.z, yaw + Math.PI, { state: o.ruin > 0 ? 1 : 0, doors: [{ side: 0 }, { side: 1 }] })) placed.push({ lx: -22, lz: 24, hw: 9.5, hd: 7.5 });
  let count = 0;
  for (const sx of streets) {
    for (const side of [-1, 1]) {
      for (let lz = -o.radius + 8; lz < o.radius - 8 && count < o.max; lz += 2) {
        const type = pick(rng, o.types);
        const big = type === 'apartment' || type === 'office';
        const w = big ? 13 + Math.round(rng() * 3) : 8 + Math.round(rng() * 2), d = big ? 10 : 8 + Math.round(rng() * 1);
        // Rotated to face the street: width runs along the street (site z), depth away from it (site x).
        const hw = d / 2, hd = w / 2, lx = sx + side * (5.4 + hw);
        if (!free(lx, lz + hd, hw, hd)) continue;
        if (rng() < 0.12) { lz += 6; continue; } // empty lot
        const c = lz + hd, p = F(lx, c);
        const rot = yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
        const r = rng();
        const state = r < o.ruin * 0.5 ? 2 : r < o.ruin ? 1 : 0;
        const b = ctx.building(type, p.x, p.z, rot, { state, w, d, floors: type === 'apartment' ? 3 : undefined });
        placed.push({ lx, lz: c, hw, hd });
        lz += w + 1.5;
        if (!b) continue;
        count++;
        if (o.courtyards && rng() < 0.5) {
          const back = F(lx + side * (hw + 4.5), c);
          ctx.prop('wall', back.x, back.z, rot + Math.PI / 2, { hx: Math.min(4, hd), hy: 0.9, hz: 0.25 });
          const bench = F(lx + side * (hw + 2.2), c + 1.5);
          ctx.prop('bench', bench.x, bench.z, rot, { hx: 0.9, hy: 0.25, hz: 0.3 });
          if (rng() < 0.4) { const t = F(lx + side * (hw + 2.5), c - 2.5); ctx.prop('bush', t.x, t.z, 0, { scale: 0.9 }); }
        }
      }
    }
  }
  // Streetlights, parked cars (wrecks in the ruins), debris and barricades.
  for (const sx of streets) {
    for (let lz = -o.radius + 12; lz < o.radius - 12; lz += 21) {
      if (cross.some((sz) => Math.abs(lz - sz) < 6)) continue;
      const p = F(sx + 4.9, lz);
      if (Math.hypot(p.x - f.x, p.z - f.z) > o.radius - 6) continue;
      const l = ctx.prop('streetlight', p.x, p.z, yaw, LAMP);
      if (rng() < o.lights) ctx.light(p.x, 7, p.z, 'street', l.id);
      if (rng() < 0.4) {
        // Parked at the kerb, clear of the driving lane.
        const c = F(sx - 4.3, lz + 7);
        const wreck = o.ruin > 0, truck = wreck && rng() < 0.3;
        ctx.prop(wreck ? (truck ? 'truckwreck' : 'carwreck') : 'car', c.x, c.z, yaw + (wreck ? (rng() - 0.5) * 1.2 : (rng() < 0.5 ? 0 : Math.PI)),
          truck ? { hx: 1.2, hy: 1.4, hz: 3.6, hue: rng() } : { hx: 0.95, hy: 0.75, hz: 2.1, hue: rng() });
      }
    }
  }
  for (let i = 0; i < o.debris; i++) {
    const lx = (rng() - 0.5) * o.radius * 1.7, lz = (rng() - 0.5) * o.radius * 1.7;
    if (Math.hypot(lx, lz) > o.radius || Math.hypot(lx, lz) < 12) continue;
    const p = F(lx, lz), s = 0.8 + rng() * 1.4;
    ctx.prop('debris', p.x, p.z, rng() * TAU, { hx: s, hy: 0.35 + rng() * 0.5, hz: s * (0.6 + rng() * 0.6) });
  }
  if (o.ruin === 0) {
    // Square: fountain, benches, lamps.
    const w = F(-9, -9);
    ctx.prop('well', w.x, w.z, 0, { hx: 1.6, hy: 0.55, hz: 1.6 });
    for (let i = 0; i < 4; i++) { const p = F((i % 2 ? 1 : -1) * 15, (i < 2 ? 1 : -1) * 15); lamp(ctx, p.x, p.z, yaw); }
    for (let i = 0; i < 4; i++) { const p = F((i % 2 ? 1 : -1) * 9, (i < 2 ? 1 : -1) * 13); ctx.prop('bench', p.x, p.z, yaw, { hx: 0.9, hy: 0.25, hz: 0.3 }); }
  } else {
    // Barricades of rubble and concrete around the square.
    for (let i = 0; i < 9; i++) { const a = rng() * TAU, p = F(Math.cos(a) * (11 + rng() * 6), Math.sin(a) * (11 + rng() * 6)); ctx.prop('barrier', p.x, p.z, a + Math.PI / 2, BARRIER); }
    for (let i = 0; i < 6; i++) { const a = rng() * TAU, p = F(Math.cos(a) * 18, Math.sin(a) * 18); ctx.prop('sandbag', p.x, p.z, a + Math.PI / 2, { hx: 1.6, hy: 0.5, hz: 0.45 }); }
  }
  return yaw;
}

/** HOTEL: a small destroyed town beside farmland (farmhouses, barns, silos, machinery, fences, hay). */
function farmTown(ctx, f, yaw) {
  const rng = ctx.rng, F = frame(f.x, f.z, yaw);
  ctx.zone(f.x, f.z, 130, 'farm');
  const a = F(0, -55), e = F(0, 55);
  ctx.street(a.x, a.z, e.x, e.z, 8);
  const spots = [[-17, -22], [-17, 0], [-17, 24], [17, -20], [17, 4], [17, 28], [-40, 40], [40, -42]];
  spots.forEach(([lx, lz], i) => {
    const p = F(lx, lz);
    const rot = yaw + (lx < 0 ? Math.PI / 2 : -Math.PI / 2);
    const r = rng();
    ctx.building(i < 6 ? 'house' : 'farmhouse', p.x, p.z, rot, { state: r < 0.4 ? 2 : r < 0.8 ? 1 : 0 });
  });
  for (const [lx, lz, rot] of [[-62, -12, 0.2], [60, 30, -0.3]]) {
    const p = F(lx, lz);
    if (!ctx.building('barn', p.x, p.z, yaw + rot, { doors: [{ side: 0 }, { side: 1 }], state: rng() < 0.4 ? 1 : 0 })) continue;
    const s = F(lx + 12, lz - 6);
    ctx.prop('silo', s.x, s.z, 0, { hx: 2.4, hy: 7, hz: 2.4 });
    for (let k = 0; k < 6; k++) { const h = F(lx - 6 + rng() * 12, lz + 13 + rng() * 6); ctx.prop('haybale', h.x, h.z, rng() * TAU, { hx: 0.7, hy: 0.6, hz: 0.7 }); }
  }
  for (const [lx, lz] of [[-36, 12], [36, -12], [8, 46]]) { const p = F(lx, lz); ctx.prop(rng() < 0.6 ? 'tractor' : 'harvester', p.x, p.z, rng() * TAU, { hx: 1.25, hy: 1.4, hz: 2.3 }); }
  for (let i = 0; i < 10; i++) { const p = F((rng() - 0.5) * 80, (rng() - 0.5) * 80); if (Math.hypot(p.x - f.x, p.z - f.z) > 14) ctx.prop('debris', p.x, p.z, rng() * TAU, { hx: 1.2, hy: 0.5, hz: 1 }); }
  for (let i = 0; i < 14; i++) { const ang = (i / 14) * TAU, p = F(Math.cos(ang) * 58, Math.sin(ang) * 58); ctx.prop('fence', p.x, p.z, ang + Math.PI / 2, { hx: 2.05, hy: 0.55, hz: 0.05, hp: 30, destructible: true }); }
  const l = F(5, 8); lamp(ctx, l.x, l.z, yaw);
  return yaw;
}

/** LIMA: a hilltop village: houses ringed around a square, narrow lanes between them, an observation tower. */
function village(ctx, f, yaw) {
  const rng = ctx.rng, F = frame(f.x, f.z, yaw);
  ctx.zone(f.x, f.z, 80, 'village');
  // Elevated observation first: the bell tower by the square and a timber watchtower on the crest.
  const t = F(-16, 16); ctx.building('control', t.x, t.z, yaw + Math.PI / 4, { style: 'plaster', floors: 3 });
  const wt = F(44, -26); ctx.building('tower', wt.x, wt.z, yaw, { fh: 8 });
  const n = 16;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * TAU + (rng() - 0.5) * 0.18;
    const r = 27 + (i % 2) * 11 + rng() * 3;
    const p = F(Math.cos(ang) * r, Math.sin(ang) * r);
    // Gaps between the houses are the narrow lanes into the square.
    ctx.building(i % 4 === 0 ? 'shop' : 'house', p.x, p.z, Math.atan2(f.x - p.x, f.z - p.z), { floors: rng() < 0.45 ? 2 : 1, w: 7 + Math.round(rng() * 2), d: 7 });
  }
  const w = F(5, -6);
  ctx.prop('well', w.x, w.z, 0, { hx: 1.2, hy: 0.5, hz: 1.2 });
  for (let i = 0; i < 4; i++) { const p = F((i % 2 ? 1 : -1) * 11, (i < 2 ? 1 : -1) * 11); lamp(ctx, p.x, p.z, yaw); }
  for (let i = 0; i < 8; i++) { const ang = rng() * TAU, p = F(Math.cos(ang) * 52, Math.sin(ang) * 52); ctx.prop('fence', p.x, p.z, ang + Math.PI / 2, { hx: 2.05, hy: 0.55, hz: 0.05, hp: 30, destructible: true }); }
  for (let i = 0; i < 3; i++) { const p = F(-6 + i * 5, 6); ctx.prop('bench', p.x, p.z, yaw, { hx: 0.9, hy: 0.25, hz: 0.3 }); }
  return yaw;
}

// ---------------------------------------------------------------- military

/** Sandbag ring, barriers and crates around an outpost. */
function fortify(ctx, F, r) {
  const rng = ctx.rng;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU + rng() * 0.25, d = r * (0.78 + rng() * 0.25);
    const p = F(Math.cos(a) * d, Math.sin(a) * d);
    ctx.prop('sandbag', p.x, p.z, a + Math.PI / 2, { hx: 1.6, hy: 0.5, hz: 0.45 });
  }
  for (let i = 0; i < 9; i++) {
    const a = rng() * TAU, d = 9 + rng() * (r - 12);
    const p = F(Math.cos(a) * d, Math.sin(a) * d);
    ctx.prop(i % 2 ? 'crate' : 'barrier', p.x, p.z, a, i % 2 ? CRATE : BARRIER);
  }
}

function outpost(ctx, f, yaw, variant) {
  const rng = ctx.rng, F = frame(f.x, f.z, yaw);
  ctx.zone(f.x, f.z, 80, 'outpost');
  // Watchtowers at three corners, floodlights.
  const towers = variant === 'runway' ? [[42, -46], [42, 46], [-48, 0]] : [[-32, -32], [32, -32], [-32, 32]];
  for (const [lx, lz] of towers) { const p = F(lx, lz); ctx.building('tower', p.x, p.z, yaw + Math.PI / 4, { style: 'wood' }); }
  for (const [lx, lz] of [[0, -26], [26, 26]]) { const p = F(lx, lz); flood(ctx, p.x, p.z); }
  if (variant === 'turrets') {
    // BRAVO: repair garages, bunker, controllable HMG turrets and searchlights, military kit.
    for (const lx of [-19, 19]) { const p = F(lx, 22); ctx.building('garage', p.x, p.z, yaw + Math.PI, { style: 'concrete' }); }
    const b = F(0, -36); ctx.building('shed', b.x, b.z, yaw, { style: 'concrete', w: 5, d: 4 });
    for (const [lx, lz, a] of [[-25, -8, -Math.PI / 2], [25, -8, Math.PI / 2], [0, -28, Math.PI]]) { const p = F(lx, lz); ctx.vehicle('hmgturret', -1, p.x, p.z, yaw + a); }
    for (const [lx, lz, a] of [[-28, 26, -0.8], [28, -26, 2.3]]) { const p = F(lx, lz); ctx.vehicle('searchlight', -1, p.x, p.z, yaw + a); }
    for (let i = 0; i < 3; i++) { const p = F(-9 + i * 9, 40); ctx.prop('container', p.x, p.z, yaw, CONTAINER(rng)); }
    const r = F(12, -15); ctx.prop('radar', r.x, r.z, 0, { hx: 0.5, hy: 4, hz: 0.5 });
    const t = F(-13, -15); ctx.prop('tankwreck', t.x, t.z, yaw + 0.6, { hx: 1.7, hy: 1.1, hz: 3.4 });
    const s = F(0, 22); ctx.supply(s.x, s.z, 9);
  } else if (variant === 'river') {
    // CHARLIE: barracks hut, bunker, a turret covering the approach, a store for the bridge crews.
    const b = F(-15, 13); ctx.building('barracks', b.x, b.z, yaw + Math.PI, { w: 18, d: 9, floors: 1 });
    const s = F(17, -14); ctx.building('shed', s.x, s.z, yaw, { style: 'concrete' });
    const t = F(0, -30); ctx.vehicle('hmgturret', -1, t.x, t.z, yaw + Math.PI);
    for (let i = 0; i < 2; i++) { const p = F(24, 8 + i * 8); ctx.prop('container', p.x, p.z, yaw, CONTAINER(rng)); }
    for (let i = 0; i < 4; i++) { const p = F(-24 + i * 3, -16); ctx.prop('crate', p.x, p.z, rng() * TAU, CRATE); }
  } else if (variant === 'helipad') {
    // FOXTROT: two pads, a service hangar, fuel farm and refuelling point, control hut.
    for (const lx of [-17, 17]) { const p = F(lx, -12); ctx.helipad(-1, p.x, p.z); }
    const h = F(0, 24); ctx.building('vhangar', h.x, h.z, yaw + Math.PI, { w: 24 });
    for (const [lx, lz] of [[-33, 6], [-33, 14], [-27, 20]]) { const p = F(lx, lz); ctx.prop('fueltank', p.x, p.z, 0, { hx: 2.2, hy: 2.6, hz: 2.2 }); }
    const c = F(29, 12); ctx.building('control', c.x, c.z, yaw, { floors: 2 });
    const tr = F(8, -32); ctx.prop('truckwreck', tr.x, tr.z, yaw + 1.2, { hx: 1.2, hy: 1.4, hz: 3.6, hue: 0.1 });
    ctx.supply(f.x, f.z, 14);
  } else {
    // GOLF: airstrip with edge lights, two hangars facing it, control tower, maintenance shed, fuel.
    const a = F(-62, -150), b = F(-62, 150);
    ctx.runway(-1, a.x, a.z, b.x, b.z, 22);
    for (const lz of [-30, 30]) { const p = F(-31, lz); ctx.building('hangar', p.x, p.z, yaw - Math.PI / 2, { w: 30, d: 26 }); }
    const c = F(22, -32); ctx.building('control', c.x, c.z, yaw);
    const m = F(24, 32); ctx.building('garage', m.x, m.z, yaw + Math.PI, { style: 'metal' });
    for (const [lx, lz] of [[36, -2], [36, 6]]) { const p = F(lx, lz); ctx.prop('fueltank', p.x, p.z, 0, { hx: 2, hy: 2.4, hz: 2 }); }
    const s = F(-14, 0); ctx.supply(s.x, s.z, 12);
  }
  fortify(ctx, F, 44);
  return yaw;
}

/** Supply depots: warehouses, service garages, containers, fuel; DELTA is the big one, INDIA hides in the woods. */
function depot(ctx, f, yaw, large) {
  const rng = ctx.rng, F = frame(f.x, f.z, yaw);
  ctx.zone(f.x, f.z, large ? 110 : 85, large ? 'depot' : 'forest');
  const wh = large ? [[-40, -30], [-40, 30], [40, -30], [40, 30]] : [[-28, -16], [28, 18]];
  for (const [lx, lz] of wh) { const p = F(lx, lz); ctx.building('warehouse', p.x, p.z, yaw + (lx < 0 ? Math.PI / 2 : -Math.PI / 2), { w: large ? 24 : 20, d: 15, doors: [{ side: 0, w: 5 }, { side: 1, w: 1.4 }] }); }
  if (large) {
    for (const lz of [-60, 60]) { const p = F(0, lz); ctx.building('garage', p.x, p.z, yaw + (lz < 0 ? 0 : Math.PI)); }
    const o = F(-14, 0); ctx.building('office', o.x, o.z, yaw + Math.PI / 2);
    for (const [lx, lz] of [[62, -6], [62, 3], [68, -2]]) { const p = F(lx, lz); ctx.prop('fueltank', p.x, p.z, 0, { hx: 2.4, hy: 2.8, hz: 2.4 }); }
    for (let i = 0; i < 2; i++) { const p = F(16 + i * 9, -14); ctx.prop('tankwreck', p.x, p.z, yaw + 0.1, { hx: 1.7, hy: 1.1, hz: 3.4 }); }
    ctx.supply(f.x, f.z, 22);
  } else {
    // Concealed storage: low sheds and stacks under the trees, watchtowers over the trails.
    for (const [lx, lz] of [[-26, 28], [26, -26]]) { const p = F(lx, lz); ctx.building('tower', p.x, p.z, yaw + 0.4); }
    for (const [lx, lz] of [[-8, 26], [10, -27], [34, -4]]) { const p = F(lx, lz); ctx.building('shed', p.x, p.z, yaw, { style: 'wood' }); }
    for (let i = 0; i < 5; i++) { const p = F(-40 + rng() * 10, -10 + i * 6); ctx.prop('crate', p.x, p.z, rng() * TAU, CRATE); }
    ctx.supply(f.x, f.z, 18);
  }
  const stacks = large ? 10 : 4;
  for (let i = 0; i < stacks; i++) {
    const p = F((rng() - 0.5) * (large ? 110 : 60), (rng() < 0.5 ? -1 : 1) * (12 + rng() * 8));
    if (Math.hypot(p.x - f.x, p.z - f.z) < 16) continue;
    ctx.prop('container', p.x, p.z, yaw + (rng() < 0.5 ? 0 : Math.PI / 2), CONTAINER(rng));
  }
  fortify(ctx, F, large ? 74 : 48);
  for (const [lx, lz] of [[0, -42], [0, 42]]) { const p = F(lx, lz); flood(ctx, p.x, p.z); }
  return yaw;
}

/** Harbours at the island edge: piers, warehouses, (KILO) cargo cranes and container yards. */
function harbor(ctx, f, out, cranes) {
  const rng = ctx.rng, F = frame(f.x, f.z, out);
  ctx.zone(f.x, f.z, 130, 'coast');
  for (const lx of [-24, 24]) { const p = F(lx, 38); ctx.pier(p.x, p.z, out, 40, 9); }
  for (const lx of [-34, 34]) { const p = F(lx, -18); ctx.building('warehouse', p.x, p.z, out, { w: 22, d: 14 }); }
  const s = F(0, -36); ctx.building('office', s.x, s.z, out + Math.PI);
  if (cranes) {
    for (const lx of [-12, 12]) { const p = F(lx, 33); ctx.prop('crane', p.x, p.z, out, { hx: 1.6, hy: 15, hz: 1.6 }); }
    for (let i = 0; i < 10; i++) { const p = F(-14 + (i % 5) * 7, 12 + Math.floor(i / 5) * 8); ctx.prop('container', p.x, p.z, out + Math.PI / 2, CONTAINER(rng)); }
    const g = F(0, -16); ctx.building('garage', g.x, g.z, out, { style: 'metal' });
  } else {
    for (let i = 0; i < 5; i++) { const p = F(-14 + i * 7, 14); ctx.prop('container', p.x, p.z, out, CONTAINER(rng)); }
    const g = F(0, -14); ctx.building('shed', g.x, g.z, out, { style: 'concrete', w: 5.5, d: 5 });
  }
  for (const lx of [-24, 24]) { const p = F(lx + 5.5, 74); lamp(ctx, p.x, p.z, out); }
  for (const lx of [-50, 50]) { const p = F(lx, 34); flood(ctx, p.x, p.z); }
  fortify(ctx, F, 46);
  return out;
}

// ---------------------------------------------------------------- military bases

/**
 * A military base on its coast (base-local u inland, v along the coast; the
 * two bases are point-symmetric). Inland wall with four gates plus a gate in
 * each end wall, gate towers and controllable HMG turrets, two barracks with
 * the infantry spawn between them, aircraft hangars facing a coastal runway,
 * a control tower, four helipads, two vehicle hangars opening onto the
 * vehicle park, four HQ buildings (the endgame objectives), a repair /
 * resupply station, AA turrets, searchlights, two autonomous SAM sites, a
 * harbour with piers and a warehouse, and the faction flagpole. Same
 * function for both sides; the architecture (palette, roofs, towers) differs.
 * @returns {object} base record (spawn areas, HQ ids, SAM sites, park, ...)
 */
export function buildBase(ctx, b, B) {
  const W = (u, v) => baseToWorld(b, u, v);
  const face = (dir) => Math.atan2(dir * b.inland, 0); // local +z inland (1) / seaward (-1)
  const style = b.team === 0 ? 'pampalona' : 'torsa';
  const torsa = b.team === 1;
  const L = B.halfLength;
  const own = { style, team: b.team, invulnerable: true };
  const both = (v) => [v, -v];
  ctx.zone(b.x, b.z, 300, 'base');
  // The layout is mirror-symmetric along the coast (v ↔ -v), so with the
  // point-symmetric placement of the two bases every spawn area is equally
  // far from every objective's mirror image, KILO on the centre line included.
  const rec = {
    team: b.team, x: b.x, z: b.z, inland: b.inland, hq: [], sams: [], gates: [],
    infantry: W(58, 0), vehicles: W(30, 0), aircraft: W(-18, 0), resupply: W(30, 0), flagpole: W(42, 0),
    park: { u0: 4, u1: 56, v0: -88, v1: 88, vMid: 0 },
  };
  // HQ buildings first: the endgame objectives always get their lots.
  for (const [u, v] of [[30, -255], [20, -175], [20, 175], [30, 255]]) {
    const p = W(u, v);
    const hq = ctx.building('hq', p.x, p.z, face(1), { ...own, hq: true, doors: [{ side: 0 }, { side: 1 }], force: true, roof: 'flat' });
    hq.hqIndex = rec.hq.length;
    rec.hq.push(hq.id);
  }
  // Runway along the coast, harbour with a pier and a warehouse at each end.
  const r0 = W(-50, -228), r1 = W(-50, 228);
  ctx.runway(b.team, r0.x, r0.z, r1.x, r1.z, 26);
  for (const v of both(264)) {
    const p = W(B.coast + 4, v); ctx.pier(p.x, p.z, face(-1), 34, 9);
    const wh = W(-46, v - Math.sign(v) * 14); ctx.building('warehouse', wh.x, wh.z, face(-1), { ...own, w: 18, d: 14 });
    for (const dv of [0, 9]) { const f = W(-30, Math.sign(v) * (185 + dv)); ctx.prop('fueltank', f.x, f.z, 0, { hx: 2.4, hy: 2.8, hz: 2.4, base: b.team }); }
  }
  // Perimeter: inland wall with four gates, end walls with a gate each.
  rec.gates = B.gates.map((v) => W(B.wall, v)).concat([W(30, -L), W(30, L)]);
  const wall = (u0, v0, u1, v1, gaps) => {
    const len = Math.hypot(u1 - u0, v1 - v0), n = Math.ceil(len / 9);
    const a = W(u0, v0), e = W(u1, v1), rot = Math.atan2(e.x - a.x, e.z - a.z) + Math.PI / 2;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, u = u0 + (u1 - u0) * t, v = v0 + (v1 - v0) * t;
      if (gaps.some((g) => Math.hypot(g[0] - u, g[1] - v) < 14)) continue; // 28 m gates: convoys roll out two abreast
      const p = W(u, v);
      ctx.prop('wall', p.x, p.z, rot, { hx: len / n / 2 + 0.3, hy: 2.3, hz: 0.45, base: b.team });
    }
  };
  wall(B.wall, -L, B.wall, L, B.gates.map((v) => [B.wall, v]));
  wall(-36, -L, B.wall, -L, [[30, -L]]);
  wall(-36, L, B.wall, L, [[30, L]]);
  for (const v of B.gates) {
    const sg = Math.sign(v);
    const t = W(86, v + sg * 19); ctx.building('tower', t.x, t.z, face(1), { ...own, style: torsa ? 'metal' : 'wood' });
    const g = W(82, v - sg * 18); ctx.vehicle('hmgturret', b.team, g.x, g.z, face(1));
  }
  for (const v of both(L)) { const g = W(44, v - Math.sign(v) * 10); ctx.vehicle('hmgturret', b.team, g.x, g.z, Math.atan2(0, Math.sign(v) * b.inland)); }
  // Barracks either side of the infantry spawn (the vehicle lanes to the inner gates run between them); flagpole in front.
  for (const v of both(64)) { const p = W(72, v); ctx.building('barracks', p.x, p.z, face(1), { ...own, roof: torsa ? 'gable' : 'flat', floors: torsa ? 1 : 2, w: 22, d: 10 }); }
  // Aircraft hangars facing the runway, control tower, helipads.
  for (const v of both(60)) { const p = W(-14, v); ctx.building('hangar', p.x, p.z, face(-1), { ...own, style: torsa ? 'metal' : 'pampalona', w: 32, d: 28 }); }
  const ct = W(-20, 0); ctx.building('control', ct.x, ct.z, face(-1), own);
  for (const v of [-150, -115, 115, 150]) { const p = W(-18, v); ctx.helipad(b.team, p.x, p.z); }
  // Vehicle park with the repair / resupply station; vehicle hangars and repair garages beside it.
  const apron = W(30, 0); ctx.paveRect(apron.x, apron.z, 27, 90, 0);
  for (const v of both(120)) { const p = W(72, v); ctx.building('vhangar', p.x, p.z, face(-1), { ...own, w: 28, d: 13 }); }
  for (const v of both(98)) { const p = W(-2, v); ctx.building('garage', p.x, p.z, face(-1), own); }
  ctx.supply(apron.x, apron.z, 32, b.team);
  // Air defence and lights: AA turrets, searchlights, autonomous SAM sites.
  for (const v of both(230)) { const p = W(-28, v); ctx.vehicle('aaturret', b.team, p.x, p.z, face(1)); }
  for (const v of both(270)) { const p = W(80, v); ctx.vehicle('searchlight', b.team, p.x, p.z, face(1)); }
  for (const v of both(280)) { const p = W(0, v); rec.sams.push({ x: p.x, z: p.z, team: b.team }); ctx.prop('samsite', p.x, p.z, face(1), { hx: 1.6, hy: 1.6, hz: 2.4, base: b.team }); }
  for (const [u, v] of [[62, 230], [62, 85], [-34, 100], [-34, 220], [20, 280], [-34, 0]]) for (const vv of v ? both(v) : [0]) { const p = W(u, vv); flood(ctx, p.x, p.z); }
  // Clutter: container rows by the gates, crates at the hangars.
  for (const v of both(240)) for (let i = 0; i < 3; i++) { const p = W(70, v - Math.sign(v) * i * 8); ctx.prop('container', p.x, p.z, face(1), { hx: 1.25, hy: 1.3, hz: 3.05, hue: ctx.rng(), base: b.team }); }
  for (const v of both(30)) for (let i = 0; i < 3; i++) { const p = W(-32, v + i * 6 * Math.sign(v)); ctx.prop('crate', p.x, p.z, ctx.rng() * TAU, CRATE); }
  return rec;
}
