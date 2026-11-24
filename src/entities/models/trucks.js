import {
  PAINT, TEAM, DARK, STEEL, RUBBER, GLASS, LENS, CANVAS,
  box, cyl, tubeZ, tubeX, side, top, mirror, cone, place, runningGear as trackGear,
} from './kit.js';
import { INT, fitCab, shiftCab, kamazFront, mzktFront, mirrors, truckTyre } from './cabs.js';

/**
 * Wheeled military trucks and truck-mounted systems, rebuilt around glazed cabs with interiors (cabs.js). Ground
 * coordinates (+Z forward, +X left, y = 0 on the ground); running gear (axles, springs, mudguards) is placed from
 * the def's own wheel stations so it lines up with the simulated wheels.
 */

const OLIVE = [0x4f5b33];
const CRATE = 0x5b6236, CRATE2 = 0x6e6a45, TILT = 0x6b6a48, TILT2 = 0x5f5e40;

// ------------------------------------------------------------------ running gear and chassis

/** Distinct axle stations (z) of a wheeled def. */
const axleZs = (def) => [...new Set(def.wheels.map((w) => +w.pos[2].toFixed(2)))].sort((a, b) => b - a);
const track = (def) => Math.max(...def.wheels.map((w) => Math.abs(w.pos[0])));

/** Ladder frame (two C-section rails and cross-members), axles with differential housings, leaf springs. */
function runningGear(def, z0, z1, yRail, o = {}) {
  const r = def.wheelRadius, tw = track(def), p = [];
  const rx = o.railX ?? 0.45;
  for (const s of [-1, 1]) p.push(box(0.09, 0.28, z1 - z0, s * rx, yRail, (z0 + z1) / 2, DARK), box(0.05, 0.05, z1 - z0, s * (rx + 0.03), yRail + 0.12, (z0 + z1) / 2, DARK));
  for (let z = z0 + 0.4; z < z1 - 0.2; z += 1.3) p.push(box(rx * 2, 0.16, 0.1, 0, yRail, z, DARK));
  for (const z of axleZs(def)) {
    p.push(tubeX(0.08, tw * 2 - 0.3, 0, r, z, 8, DARK), cyl(0.2, 0.2, 0.32, 10, 0, r, z, DARK, Math.PI / 2), box(0.3, 0.24, 0.26, 0, r + 0.04, z, DARK));
    for (const s of [-1, 1]) {
      p.push(box(0.09, 0.07, 1.15, s * rx, (r + yRail) / 2 + 0.02, z, STEEL), box(0.11, 0.05, 0.9, s * rx, (r + yRail) / 2 - 0.04, z, STEEL)); // leaf spring pack
      p.push(box(0.1, Math.max(0.1, yRail - r - 0.1), 0.1, s * rx, (r + yRail) / 2, z, DARK)); // spring hanger / damper
      p.push(cyl(0.12, 0.12, 0.08, 8, s * (tw - 0.36), r, z, STEEL, 0, 0, Math.PI / 2)); // hub reduction
    }
  }
  return p;
}

/** Mudguard arching over a wheel (both sides): top plate, front / rear lips, rubber mud flap. */
function mudguards(def, z, o = {}) {
  const r = def.wheelRadius, tw = track(def), w = o.w ?? 0.5, y = o.y ?? r * 2 + 0.12, len = o.len ?? r * 2 + 0.25;
  return mirror([box(w, 0.04, len, tw, y, z, o.color ?? PAINT), box(w, 0.25, 0.04, tw, y - 0.12, z + len / 2, o.color ?? PAINT, -0.3),
    box(w, 0.25, 0.04, tw, y - 0.12, z - len / 2, o.color ?? PAINT, 0.3), box(w - 0.04, 0.42, 0.02, tw, y - 0.46, z - len / 2 - 0.05, RUBBER),
    box(0.04, 0.3, 0.04, tw - w / 2 + 0.03, y - 0.15, z, DARK)]);
}

/** Cylindrical fuel tank on the frame side, with straps, filler cap and step plate. */
function fuelTank(x, y, z, len, r = 0.3) {
  return [tubeZ(r, r, z - len / 2, z + len / 2, x, y, 12, PAINT), ...[-0.3, 0.3].map((k) => tubeZ(r + 0.012, r + 0.012, z + k * len - 0.03, z + k * len + 0.03, x, y, 12, DARK)),
    cyl(0.07, 0.07, 0.08, 8, x - Math.sign(x) * 0.08, y + r, z + len * 0.35, DARK), box(0.32, 0.03, len * 0.6, x, y + r + 0.02, z, STEEL)];
}

/** Battery / tool box with a ribbed lid. */
function lockerBox(x, y, z, w, h, d) {
  return [box(w, h, d, x, y, z, PAINT), box(w + 0.02, 0.04, d + 0.02, x, y + h / 2, z, DARK), box(0.02, 0.06, 0.1, x + Math.sign(x) * (w / 2 + 0.01), y + h * 0.2, z, STEEL)];
}

/** Spare wheel (vertical, across the truck, facing aft) on a carrier frame. */
function spareWheel(x, y, z, r, w, across = true) {
  const p = across ? [tubeZ(r, r, z - w / 2, z + w / 2, x, y, 16, RUBBER), tubeZ(r * 0.6, r * 0.6, z - w / 2 - 0.02, z + w / 2 + 0.02, x, y, 12, PAINT), tubeZ(r * 0.2, r * 0.2, z - w / 2 - 0.05, z + w / 2 + 0.05, x, y, 6, STEEL)]
    : [tubeX(r, w, x, y, z, 16, RUBBER), tubeX(r * 0.6, w + 0.03, x, y, z, 12, PAINT), tubeX(r * 0.2, w + 0.06, x, y, z, 6, STEEL)];
  p.push(box(0.08, r * 2.1, 0.08, x - r * 0.9, y, z, DARK), box(0.08, r * 2.1, 0.08, x + r * 0.9, y, z, DARK));
  return p;
}

/** Vertical exhaust stack with a guard and rain cap, behind the cab. */
function exhaust(x, z, y0, y1) {
  return [cyl(0.07, 0.07, y1 - y0, 8, x, (y0 + y1) / 2, z, DARK), cyl(0.1, 0.1, (y1 - y0) * 0.5, 8, x, y0 + (y1 - y0) * 0.55, z, STEEL), box(0.16, 0.02, 0.16, x, y1 + 0.02, z, DARK, 0.4)];
}

/** Air intake snorkel / filter can behind the cab. */
function airFilter(x, z, y0, y1) {
  return [cyl(0.17, 0.17, 0.5, 10, x, y1 - 0.25, z, PAINT), cyl(0.18, 0.18, 0.06, 10, x, y1 + 0.02, z, DARK), cyl(0.08, 0.08, y1 - y0 - 0.45, 8, x, (y0 + y1 - 0.45) / 2, z, DARK)];
}

/** Rear lamps, reflectors, bumper and tow hitch. */
function rearEnd(z, y, hw) {
  return [box(hw * 2 - 0.3, 0.16, 0.14, 0, y, z - 0.07, DARK), cyl(0.07, 0.09, 0.2, 8, 0, y - 0.02, z - 0.2, STEEL, Math.PI / 2),
    ...mirror([box(0.32, 0.12, 0.06, hw - 0.3, y + 0.14, z - 0.05, DARK), box(0.09, 0.08, 0.02, hw - 0.4, y + 0.14, z - 0.085, 0x7a1f1a), box(0.09, 0.08, 0.02, hw - 0.3, y + 0.14, z - 0.085, INT.AMBER),
      box(0.09, 0.08, 0.02, hw - 0.2, y + 0.14, z - 0.085, 0x7a1f1a), box(0.12, 0.06, 0.02, hw - 0.3, y - 0.05, z - 0.15, 0x8a2a20)])];
}

/**
 * Drop-side cargo bed: floor on cross-bearers, planked sides with stake pockets, hinges and latches, a raised
 * headboard with a window guard, tailgate with steps.
 */
function cargoBed(z0, z1, y, w, h, o = {}) {
  const L = z1 - z0, zc = (z0 + z1) / 2, p = [box(w, 0.1, L, 0, y, zc, PAINT)];
  for (let z = z0 + 0.3; z < z1; z += 0.6) p.push(box(w - 0.1, 0.12, 0.08, 0, y - 0.1, z, DARK));
  for (const s of [-1, 1]) {
    p.push(box(0.06, h, L, s * (w / 2 - 0.03), y + h / 2 + 0.05, zc, PAINT));
    for (let k = 1; k < 3; k++) p.push(box(0.012, 0.02, L - 0.04, s * (w / 2 + 0.002), y + 0.05 + (h * k) / 3, zc, DARK)); // plank lines
    p.push(box(0.03, 0.05, L, s * (w / 2 + 0.01), y + h + 0.03, zc, STEEL)); // top rail
    for (let z = z0 + 0.5; z < z1 - 0.2; z += 1.0) p.push(box(0.05, h + 0.04, 0.08, s * (w / 2 + 0.02), y + h / 2 + 0.05, z, STEEL));
    for (let z = z0 + 1.0; z < z1 - 0.2; z += 2.0) p.push(box(0.04, 0.08, 0.14, s * (w / 2 + 0.035), y + h * 0.75, z, DARK)); // latches
  }
  p.push(box(w, h + 0.45, 0.06, 0, y + (h + 0.45) / 2 + 0.05, z1 - 0.03, PAINT), ...[-0.6, 0, 0.6].map((x) => box(0.05, 0.35, 0.03, x, y + h + 0.28, z1 - 0.07, DARK)));
  if (!o.noGate) p.push(box(w, h, 0.06, 0, y + h / 2 + 0.05, z0 + 0.03, PAINT), box(w - 0.1, 0.02, 0.03, 0, y + h * 0.5, z0, DARK));
  p.push(...[-0.6, 0.6].map((x) => box(0.3, 0.04, 0.18, x, y - 0.35, z0 + 0.1, STEEL)));
  return p;
}

/** Canvas tilt over a bed on hoops: rounded-shoulder cover, visible hoop bands, tie-down ropes, rolled rear flap. */
function tilt(z0, z1, yb, yt, w, o = {}) {
  const hw = w / 2, sh = 0.18, p = [], C = o.color ?? TILT, L = z1 - z0, zc = (z0 + z1) / 2, t = 0.035;
  // Hollow cover on its hoops: side curtains, rounded shoulders, roof and the front panel; open at the back when
  // the rear flap is rolled up (the bed and its benches show through), closed otherwise.
  for (const s of [-1, 1]) {
    p.push(box(t, yt - sh - yb, L, s * (hw - t / 2), (yb + yt - sh) / 2, zc, C));
    p.push(box(0.04, sh * 1.45, L, s * (hw - sh * 0.45), yt - sh * 0.48, zc, C, 0, 0, s * 0.78));
  }
  p.push(box(w - sh * 1.6, t, L, 0, yt - t / 2, zc, C), box(w - 0.04, yt - yb - 0.02, t, 0, (yb + yt) / 2 - 0.01, z1 - t / 2, C));
  if (!o.rolled) p.push(box(w - 0.02, yt - yb, t, 0, (yb + yt) / 2, z0 + t / 2, C));
  for (let z = z0 + 0.35; z < z1 - 0.1; z += (z1 - z0 - 0.4) / Math.max(1, Math.round((z1 - z0) / 1.2))) {
    for (const s of [-1, 1]) p.push(box(0.03, yt - yb - 0.2, 0.04, s * (hw - 0.06), (yb + yt - 0.2) / 2, z, STEEL)); // hoops inside
    p.push(box(w - 0.4, 0.03, 0.04, 0, yt - 0.06, z, STEEL));
  }
  for (let z = z0 + 0.35; z < z1 - 0.1; z += (z1 - z0 - 0.4) / Math.max(1, Math.round((z1 - z0) / 1.2))) {
    p.push(box(w + 0.02, 0.035, 0.07, 0, yt + 0.01, z, TILT2));
    for (const s of [-1, 1]) p.push(box(0.025, yt - yb - 0.1, 0.07, s * (hw + 0.005), (yb + yt) / 2, z, TILT2));
  }
  for (const s of [-1, 1]) p.push(box(0.02, 0.02, z1 - z0, s * (hw + 0.012), yb + 0.08, (z0 + z1) / 2, 0x3a3a30));
  if (o.rolled) p.push(tubeX(0.11, w - 0.1, 0, yt - 0.25, z0 - 0.03, 10, o.color ?? TILT), box(w - 0.1, 0.03, 0.04, 0, yt - 0.62, z0 - 0.02, 0x3a3a30));
  return p;
}

/** Ammunition / supply crates on a bed (seeded rows, some with stencilled bands), lashed down. */
function crates(z0, z1, y, w, rows, seed = 1) {
  const p = [];
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let z = z0 + 0.42; z < z1 - 0.35; z += 0.82) for (let x = -w / 2 + 0.42; x < w / 2 - 0.3; x += 0.76) {
    const n = 1 + Math.floor(rnd() * rows);
    for (let k = 0; k < n; k++) {
      const c = rnd() > 0.5 ? CRATE : CRATE2, yy = y + 0.21 + k * 0.43;
      p.push(box(0.7, 0.42, 0.74, x, yy, z, c), box(0.72, 0.04, 0.05, x, yy + 0.1, z + 0.3, DARK), box(0.72, 0.04, 0.05, x, yy + 0.1, z - 0.3, DARK),
        box(0.06, 0.05, 0.4, x + 0.36, yy, z, STEEL));
    }
    if (rnd() > 0.55) p.push(box(0.4, 0.02, 0.12, x, y + n * 0.43 + 0.005, z, 0xc9c4a4));
  }
  for (let z = z0 + 0.8; z < z1 - 0.4; z += 1.6) p.push(box(w + 0.02, 0.02, 0.05, 0, y + rows * 0.43 + 0.02, z, 0x3a3a30));
  return p;
}

/** Shielded Kord heavy MG on a roof ring: { yaw, pitch }. */
function kordMount(ring = 0.45) {
  return {
    yaw: [cyl(ring, ring, 0.1, 14, 0, -0.18, 0, DARK), cyl(ring - 0.06, ring - 0.06, 0.12, 14, 0, -0.12, 0, PAINT), box(0.12, 0.4, 0.12, 0, 0.0, 0, DARK),
      box(0.95, 0.52, 0.05, 0, 0.08, 0.34, PAINT), ...mirror([box(0.05, 0.44, 0.34, 0.47, 0.08, 0.17, PAINT, 0, 0.45, 0)]), box(0.22, 0.12, 0.02, 0.18, 0.2, 0.37, GLASS)],
    pitch: [box(0.14, 0.17, 0.9, 0, 0, 0.2, DARK), box(0.2, 0.22, 0.28, 0.17, -0.06, 0.04, CRATE), box(0.05, 0.08, 0.2, -0.05, 0.12, -0.15, DARK),
      tubeZ(0.026, 0.022, 0.6, 1.5, 0, 0.03, 8, STEEL), tubeZ(0.045, 0.045, 1.4, 1.52, 0, 0.03, 8, DARK), box(0.02, 0.1, 0.02, 0, 0.1, 0.65, DARK)],
  };
}

/** 9P163 Kornet twin launcher on a pedestal with the thermal sight: { yaw, pitch }. */
function kornetMount() {
  const tube = (x, y) => [tubeZ(0.08, 0.08, -0.55, 1.2, x, y, 10, 0x5c6a3f), tubeZ(0.095, 0.095, 1.1, 1.22, x, y, 10, DARK), tubeZ(0.095, 0.095, -0.58, -0.5, x, y, 10, DARK)];
  return {
    yaw: [cyl(0.42, 0.48, 0.3, 12, 0, -0.35, 0, PAINT), box(0.52, 0.5, 0.52, 0, 0.05, -0.1, PAINT), box(0.32, 0.22, 0.05, 0, 0.12, 0.17, LENS), box(0.4, 0.05, 0.3, 0, 0.32, -0.1, DARK)],
    pitch: [box(0.32, 0.3, 0.62, 0, 0, 0.1, DARK), box(0.24, 0.2, 0.3, 0, 0.24, 0.0, PAINT), box(0.16, 0.12, 0.03, 0, 0.24, 0.16, LENS),
      ...mirror([...tube(0.42, 0.12), ...tube(0.42, -0.12), box(0.08, 0.5, 0.32, 0.28, 0, 0.2, DARK)])],
  };
}

// ------------------------------------------------------------------ cab presets

/** KamAZ Mustang cab sized for a def (cab-over, flat front, raked screen, crew of two or three). */
function kamazCab(def, zB, zF, o = {}) {
  const yF = o.yF ?? Math.min(...def.seats.filter((s) => s.pos[2] > zB).map((s) => s.pos[1] + def.ride)) - 0.47;
  const c = { zB, zF, yB: o.yB ?? yF - 0.28, yF, yBelt: yF + 0.78, yRoof: o.yRoof ?? yF + 1.5, w: o.w ?? 2.5, rake: 0.28, split: false, door: o.door ?? [zB + 0.3, zF - 0.42], quarter: o.quarter ?? false, rearWin: o.rearWin ?? true };
  const cab = fitCab(def, c, { hump: 0.32, sleeper: o.sleeper, skip: o.skip, tilt: 0.95 });
  const fz = Math.max(...axleZs(def)), r = def.wheelRadius;
  cab.hull.push(...kamazFront({ ...c, bumperY: o.bumperY ?? r * 1.55, stepZ: fz - r - 0.24 }));
  // front wheel arch skirt under the cab
  cab.hull.push(...mirror([box(0.06, 0.3, r * 2 + 0.2, c.w / 2 - 0.05, c.yB - 0.1, fz, PAINT), box(0.5, 0.05, r * 2 + 0.2, c.w / 2 - 0.27, c.yB + 0.02, fz, DARK)]));
  return { c, ...cab };
}

const OLIVE_SCHEME = { base: OLIVE };

// ------------------------------------------------------------------ models

export const TRUCK_MODELS = {
  /** KamAZ-5350 6×6 troop / cargo truck: Mustang cab, drop-side bed under a canvas tilt with the rear flap rolled
   * up, fuel tank and battery box on the frame, spare wheel and air intake behind the cab. */
  truck: (def) => {
    const r = def.wheelRadius, hw = 1.25;
    const cab = kamazCab(def, 2.05, 3.95);
    const bedY = 1.42;
    // tailgate: hinged at the bed floor, folds down for the troops (operable with the doors)
    cab.cabin.doors.push({ side: 0, x: 0, y: bedY + 0.05, z: -3.85, axis: 'x', open: -1.5, seats: def.seats.map((q, i) => i).filter((i) => def.seats[i].pos[2] < 1),
      geo: [box(2.5, 0.55, 0.06, 0, 0.275, 0, PAINT), box(2.4, 0.02, 0.03, 0, 0.3, -0.04, DARK), ...[-0.9, 0, 0.9].map((x) => box(0.08, 0.5, 0.05, x, 0.27, -0.03, STEEL)),
        ...[-1.1, 1.1].map((x) => box(0.05, 0.1, 0.1, x, 0.45, -0.05, DARK))] });
    return {
      scheme: OLIVE_SCHEME,
      cabin: cab.cabin, glass: cab.glass,
      hull: [
        ...cab.hull,
        ...runningGear(def, -3.85, 3.7, 1.05),
        ...mudguards(def, 2.75, { y: 1.25, len: 1.25, w: 0.55 }), ...mudguards(def, -1.45, { y: bedY - 0.12, len: 1.3 }), ...mudguards(def, -2.85, { y: bedY - 0.12, len: 1.3 }),
        ...fuelTank(0.95, 0.95, 0.75, 1.3), ...lockerBox(-0.95, 0.95, 0.9, 0.36, 0.4, 0.6), ...lockerBox(-0.95, 0.95, 0.2, 0.36, 0.4, 0.5),
        ...cargoBed(-3.88, 1.75, bedY, 2.5, 0.55, { noGate: true }),
        ...tilt(-3.86, 1.73, bedY + 0.6, 3.22, 2.5, { rolled: true }),
        ...spareWheel(0, 1.95, 1.9, r, 0.42), ...exhaust(-0.85, 1.95, 1.2, 3.25), ...airFilter(0.95, 1.95, 1.4, 2.95),
        ...rearEnd(-3.9, 1.18, hw),
        ...mirror([box(0.04, 0.42, 1.5, 1.27, 2.55, -1.1, TEAM)]),
        cyl(0.012, 0.012, 1.8, 4, -1.05, 3.9, 2.2, DARK),
      ],
      wheel: truckTyre(r, 0.44),
    };
  },

  /** CST: KamAZ-63501 8×8 combat supply truck: Mustang cab with a roof hatch and shielded Kord, long bed of crates
   * under a half tilt, two fuel tanks, spare wheel behind the cab. */
  supply: (def) => {
    const r = def.wheelRadius, hw = 1.25;
    const cab = kamazCab(def, 2.85, 4.85, { skip: [1] });
    const bedY = 1.5;
    return {
      scheme: OLIVE_SCHEME,
      cabin: cab.cabin, glass: cab.glass,
      hull: [
        ...cab.hull,
        cyl(0.46, 0.46, 0.1, 14, -0.5, cab.c.yRoof + 0.06, 3.5, DARK), // roof hatch ring for the Kord
        ...runningGear(def, -4.75, 4.6, 1.12),
        ...mudguards(def, 3.39, { y: 1.3, len: 1.3, w: 0.55 }), ...mudguards(def, 1.45, { y: 1.42, len: 1.35 }), ...mudguards(def, -1.9, { y: bedY - 0.12, len: 1.35 }), ...mudguards(def, -3.22, { y: bedY - 0.12, len: 1.35 }),
        ...fuelTank(0.98, 1.0, 2.35, 1.0), ...fuelTank(-0.98, 1.0, 2.35, 1.0), ...lockerBox(0.95, 1.0, 0.0, 0.36, 0.42, 0.7),
        ...cargoBed(-4.8, 2.45, bedY, 2.48, 0.6),
        ...crates(-1.3, 2.45, bedY + 0.06, 2.3, 2, 7),
        ...tilt(-4.78, -1.3, bedY + 0.65, 3.15, 2.48, {}),
        ...spareWheel(0, 2.05, 2.62, r, 0.44), ...exhaust(-0.9, 2.62, 1.3, 3.35),
        ...rearEnd(-4.82, 1.22, hw),
        ...mirror([box(0.04, 0.4, 0.8, 1.27, 2.65, -3.0, TEAM)]),
        cyl(0.012, 0.012, 1.8, 4, 1.05, 3.95, 3.0, DARK),
      ],
      mounts: { 0: kordMount(0.45) },
      wheel: truckTyre(r, 0.46),
    };
  },

  /** AT-CST: KamAZ-44108 4×4 with the long sleeper cab, a bed of crates and a twin Kornet launcher on a pedestal at
   * the rear of the bed. */
  atcst: (def) => {
    const r = def.wheelRadius, hw = 1.25;
    const cab = kamazCab(def, 1.75, 3.65, { sleeper: true, door: [2.2, 3.23] });
    const bedY = 1.45;
    return {
      scheme: OLIVE_SCHEME,
      cabin: cab.cabin, glass: cab.glass,
      hull: [
        ...cab.hull,
        ...runningGear(def, -3.5, 3.4, 1.05),
        ...mudguards(def, 2.55, { y: 1.25, len: 1.25, w: 0.55 }), ...mudguards(def, -1.75, { y: bedY - 0.12, len: 1.35 }),
        ...fuelTank(0.98, 0.95, 0.6, 1.1), ...lockerBox(-0.95, 0.95, 0.65, 0.36, 0.42, 0.7),
        ...cargoBed(-3.6, 1.45, bedY, 2.45, 0.55),
        ...crates(-1.7, 1.45, bedY + 0.06, 2.3, 2, 3),
        box(1.7, 0.16, 1.5, 0, bedY + 0.12, -2.75, DARK), ...mirror([box(0.1, 0.5, 0.1, 0.75, bedY + 0.35, -2.2, STEEL)]), // launcher plinth + rails
        ...spareWheel(0, 1.95, 1.6, r, 0.42), ...exhaust(-0.9, 1.6, 1.25, 3.2),
        ...rearEnd(-3.62, 1.18, hw),
        ...mirror([box(0.04, 0.34, 0.7, 1.24, 1.84, -0.9, TEAM)]),
      ],
      mounts: { 0: kornetMount() },
      wheel: truckTyre(r, 0.46),
    };
  },
};

/** MZKT-7930 wide cab for a def (crew of two or three abreast / in tandem). */
function mzktCab(def, zB, zF, o = {}) {
  const yF = Math.min(...def.seats.filter((s) => s.pos[2] > zB).map((s) => s.pos[1] + def.ride)) - 0.47;
  const c = { zB, zF, yB: yF - 0.3, yF, yBelt: yF + 0.72, yRoof: yF + 1.55, w: o.w ?? 2.9, rake: 0.2, split: true, door: o.door ?? [zB + 0.75, zF - 0.38], quarter: true, rearWin: false, pillar: 0.1 };
  const cab = fitCab(def, c, { tilt: 0.85, skip: o.skip });
  const fz = Math.max(...axleZs(def)), r = def.wheelRadius;
  cab.hull.push(...mzktFront({ ...c, bumperY: r * 1.6, stepZ: c.door[0] + 0.25 }));
  cab.hull.push(...mirror([box(0.08, 0.35, r * 2 + 0.3, c.w / 2 - 0.04, c.yB - 0.12, fz, PAINT)]));
  return { c, ...cab };
}

/** SAM / radar operator cabin (box shelter) with doors, vents, cable reels and a ladder. */
function shelter(z0, z1, y0, y1, w, o = {}) {
  const L = z1 - z0, zc = (z0 + z1) / 2, hw = w / 2;
  const p = [box(w, y1 - y0, L, 0, (y0 + y1) / 2, zc, PAINT), box(w + 0.04, 0.06, L + 0.04, 0, y1 + 0.03, zc, DARK), box(w + 0.04, 0.06, L + 0.04, 0, y0, zc, DARK)];
  for (const sd of [-1, 1]) {
    p.push(box(0.03, (y1 - y0) - 0.2, 0.03, sd * (hw + 0.01), (y0 + y1) / 2, z0 + 0.06, DARK), box(0.03, (y1 - y0) - 0.2, 0.03, sd * (hw + 0.01), (y0 + y1) / 2, z1 - 0.06, DARK));
    p.push(box(0.04, 0.3, 0.5, sd * (hw + 0.02), y1 - 0.4, zc + L * 0.25, DARK), ...[0, 1, 2].map((i) => box(0.05, 0.03, 0.46, sd * (hw + 0.03), y1 - 0.5 + i * 0.1, zc + L * 0.25, STEEL))); // vent
  }
  if (o.door !== false) p.push(box(0.04, (y1 - y0) - 0.35, 0.8, hw + 0.02, (y0 + y1) / 2 - 0.05, zc - L * 0.2, PAINT), box(0.05, 0.04, 0.12, hw + 0.05, (y0 + y1) / 2, zc - L * 0.2 + 0.3, STEEL),
    box(0.02, 0.3, 0.3, hw + 0.03, (y0 + y1) / 2 + 0.4, zc - L * 0.2, GLASS), ...[0.25, 0.55, 0.85].map((k) => box(0.3, 0.04, 0.05, hw + 0.2, y0 - k, zc - L * 0.2, STEEL)));
  return p;
}

/** Hydraulic outrigger jack (down / stowed). */
function jack(x, z, y0, y1) {
  return [box(0.2, y1 - y0, 0.2, x, (y0 + y1) / 2, z, DARK), cyl(0.07, 0.07, 0.4, 8, x, y0 - 0.15, z, STEEL), box(0.36, 0.05, 0.36, x, y0 - 0.38, z, DARK)];
}

Object.assign(TRUCK_MODELS, {
  /** Pantsir-S1 on the KamAZ-6560 8×8: Mustang cab, equipment module behind it, rear operator cabin under the
   * combat module (12 missiles + twin 30 mm, tracking radar on the front, search radar spinning on top). */
  sam: (def) => {
    const r = def.wheelRadius, hw = 1.25;
    const cab = kamazCab(def, 2.85, 4.75);
    return {
      scheme: OLIVE_SCHEME,
      cabin: cab.cabin, glass: cab.glass,
      hull: [
        ...cab.hull,
        ...runningGear(def, -4.75, 4.5, 1.08),
        ...[3.15, 1.75].map((z) => mudguards(def, z, { y: z > 3 ? 1.3 : 1.45, len: 1.3 })).flat(), ...[-1.6, -3.0].map((z) => mudguards(def, z, { y: 1.5, len: 1.3 })).flat(),
        ...shelter(1.0, 2.7, 1.55, 3.05, 2.5, { door: false }), // equipment / power module
        ...exhaust(-1.0, 2.75, 1.4, 3.35), ...airFilter(1.0, 2.75, 1.6, 3.15),
        box(2.5, 0.14, 5.6, 0, 1.55, -2.0, PAINT),
        ...shelter(-4.7, 0.85, 1.62, 2.75, 2.45),
        ...fuelTank(0.98, 1.05, 0.0, 0.9), ...lockerBox(-0.95, 1.05, 0.2, 0.36, 0.42, 0.7),
        ...jack(1.15, -4.55, 0.7, 1.45), ...jack(-1.15, -4.55, 0.7, 1.45), ...jack(1.15, 0.9, 0.7, 1.45), ...jack(-1.15, 0.9, 0.7, 1.45),
        ...rearEnd(-4.78, 1.2, hw),
        ...mirror([box(0.05, 0.5, 2.0, 1.24, 2.2, -2.0, TEAM)]),
      ],
      mounts: {
        0: {
          yaw: [
            top([[0.8, 1.0], [0.9, -1.15], [-0.9, -1.15], [-0.8, 1.0]], -0.45, 0.9, PAINT, 0.9),
            box(1.25, 0.85, 0.14, 0, 0.0, 1.06, PAINT), box(1.05, 0.7, 0.04, 0, 0.0, 1.14, 0x5d6558), cyl(0.36, 0.36, 0.06, 14, 0, 0.0, 1.17, DARK, Math.PI / 2), // tracking radar
            box(0.3, 0.2, 0.3, 0.45, 0.55, 0.6, DARK), box(0.2, 0.12, 0.03, 0.45, 0.55, 0.76, LENS), // EO director
            cyl(0.1, 0.12, 0.5, 6, 0, 0.7, -0.6, DARK), box(1.6, 0.06, 1.8, 0, 0.47, -0.1, DARK),
          ],
          pitch: [
            ...mirror([
              box(0.2, 0.55, 0.9, 0.85, 0.1, 0.1, PAINT),
              ...[0.78, 1.02].flatMap((x) => [0.36, 0.63, 0.9].flatMap((y) => [tubeZ(0.11, 0.11, -1.4, 1.62, x, y, 10, 0x5c6a3f), tubeZ(0.115, 0.115, 1.55, 1.63, x, y, 10, DARK)])),
              box(0.36, 0.32, 0.95, 1.3, -0.1, 0.2, DARK),
              tubeZ(0.035, 0.03, 0.6, 1.8, 1.3, -0.22, 8, STEEL), tubeZ(0.035, 0.03, 0.6, 1.8, 1.3, 0.02, 8, STEEL), tubeZ(0.05, 0.05, 1.7, 1.82, 1.3, -0.1, 8, DARK),
            ]),
          ],
        },
      },
      spinners: [{ mount: 0, pos: [0, 1.05, -0.6], rate: 2.5, geos: [box(1.8, 0.6, 0.14, 0, 0, 0, PAINT), box(1.6, 0.46, 0.04, 0, 0, 0.08, 0x5d6558), ...[-0.6, 0, 0.6].map((x) => box(0.03, 0.46, 0.02, x, 0, 0.11, DARK))] }],
      wheel: truckTyre(r, 0.46),
    };
  },

  /** 96L6E all-altitude detector on an MZKT-7930: wide cab, generator behind it, operator shelter, raised mast with
   * the rotating phased-array antenna, four outrigger jacks. */
  radar: (def) => {
    const r = def.wheelRadius, hw = 1.3;
    const cab = mzktCab(def, 3.55, 5.45, { w: 2.65 });
    return {
      scheme: OLIVE_SCHEME,
      cabin: cab.cabin, glass: cab.glass,
      hull: [
        ...cab.hull,
        ...runningGear(def, -5.3, 5.0, 1.12),
        ...[3.0, 1.5].map((z) => mudguards(def, z, { y: z > 2.5 ? 1.3 : 1.42, len: 1.3 })).flat(), ...[-1.6, -3.1].map((z) => mudguards(def, z, { y: 1.5, len: 1.3 })).flat(),
        ...shelter(-5.25, -1.65, 1.6, 3.15, 2.55),
        ...lockerBox(0, 1.85, 0.05, 2.3, 0.55, 1.5), ...mirror([box(0.04, 0.3, 1.2, 1.17, 1.9, 0.05, DARK)]), // generator set
        box(0.65, 0.5, 0.85, 0, 1.75, 1.4, DARK), box(0.34, 3.85, 0.34, 0, 3.72, 1.4, STEEL), // mast column
        ...[0.6, 1.4, 2.2, 3.0].map((y) => box(0.38, 0.05, 0.38, 0, 1.95 + y, 1.4, DARK)), box(0.1, 3.4, 0.1, 0.27, 3.5, 1.15, DARK, 0.18),
        ...mirror([box(1.4, 0.14, 0.14, 1.0, 1.25, 1.4, STEEL), ...jack(1.65, 1.4, 0.4, 1.3)]),
        ...jack(1.2, -5.1, 0.7, 1.5), ...jack(-1.2, -5.1, 0.7, 1.5),
        ...exhaust(-1.05, 3.4, 1.4, 3.45), ...fuelTank(0.98, 1.05, -0.9, 1.0),
        ...rearEnd(-5.32, 1.25, hw),
        ...mirror([box(0.04, 0.35, 0.9, 1.29, 2.0, -4.2, TEAM)]),
      ],
      spinners: [{
        mount: -1, pos: [0, 5.65, 1.4], rate: 1.4,
        geos: [box(0.55, 0.42, 0.55, 0, 0, 0, DARK), box(2.4, 3.05, 0.3, 0, 1.75, 0.3, PAINT), box(2.2, 2.85, 0.05, 0, 1.75, 0.47, 0x6f7a74),
          ...[0.5, 1.2, 1.9, 2.6].map((y) => box(2.3, 0.04, 0.06, 0, 0.25 + y, 0.5, DARK)), ...[-0.8, -0.27, 0.27, 0.8].map((x) => box(0.04, 2.8, 0.06, x, 1.75, 0.5, DARK)),
          box(0.6, 0.6, 0.4, 0, 1.75, 0.0, DARK), box(0.5, 0.2, 0.05, 0, 3.15, 0.47, TEAM)],
      }],
      wheel: truckTyre(r, 0.5),
    };
  },

  /** 9A53 Uragan-1M on the MZKT-7930: wide four-pane cab, equipment module, two 6-round 300 mm pods on the
   * traversing launcher at the rear, stabiliser jacks. */
  mlrs: (def) => {
    const r = def.wheelRadius, hw = 1.4;
    const cab = mzktCab(def, 4.15, 6.25, { w: 2.85 });
    return {
      scheme: OLIVE_SCHEME,
      cabin: cab.cabin, glass: cab.glass,
      hull: [
        ...cab.hull,
        ...runningGear(def, -6.1, 5.9, 1.15),
        ...[4.3, 2.75].map((z) => mudguards(def, z, { y: z > 4 ? 1.38 : 1.5, len: 1.45 })).flat(), ...[-2.0, -3.6].map((z) => mudguards(def, z, { y: 1.62, len: 1.45 })).flat(),
        ...shelter(2.05, 3.95, 1.55, 3.05, 2.7, { door: false }),
        box(2.8, 0.3, 8.0, 0, 1.6, -2.0, PAINT), ...mirror([box(0.08, 0.3, 8.0, 1.38, 1.4, -2.0, DARK)]),
        ...fuelTank(1.0, 1.1, 0.6, 1.3, 0.32), ...fuelTank(-1.0, 1.1, 0.6, 1.3, 0.32),
        ...exhaust(-1.1, 4.0, 1.4, 3.4),
        cyl(0.95, 1.05, 0.42, 14, 0, 1.95, -5.3, PAINT),
        ...jack(1.25, -6.0, 0.6, 1.4), ...jack(-1.25, -6.0, 0.6, 1.4),
        ...rearEnd(-6.15, 1.25, hw),
      ],
      mounts: {
        0: {
          yaw: [box(1.7, 0.5, 1.5, 0, -0.5, 0.2, PAINT), ...mirror([box(0.16, 0.85, 0.55, 0.82, -0.2, 0, DARK)]), box(0.4, 0.35, 0.35, 1.0, -0.4, -0.5, DARK)],
          pitch: [
            ...mirror([box(1.2, 1.24, 7.6, 0.68, 0.64, 3.8, PAINT), ...[1.0, 2.6, 4.2, 5.8].map((z) => box(1.22, 0.04, 0.06, 0.68, 1.27, z, DARK))]),
            ...[1.5, 4.0, 6.5].map((z) => box(2.62, 1.32, 0.12, 0, 0.64, z, STEEL)),
            ...[0.95, 0.4, -0.4, -0.95].flatMap((x) => [0.28, 0.72, 1.05].flatMap((y) => [tubeZ(0.15, 0.15, 7.55, 7.62, x, y, 10, DARK), tubeZ(0.1, 0.1, 7.6, 7.63, x, y, 8, 0x3a4048)])),
            box(0.6, 0.2, 0.06, 0.68, 1.05, 0.2, TEAM),
          ],
        },
      },
      wheel: truckTyre(r, 0.52),
    };
  },

  /** Iskander-M TEL on the MZKT-7930: wide cab, equipment section, long armoured launcher compartment whose roof
   * doors are opened, two missiles on the erector beam. */
  tel: (def) => {
    const r = def.wheelRadius, hw = 1.5;
    const cab = mzktCab(def, 4.45, 6.55, { w: 3.0, door: [5.15, 6.15] });
    return {
      scheme: OLIVE_SCHEME,
      cabin: cab.cabin, glass: cab.glass,
      hull: [
        ...cab.hull,
        ...runningGear(def, -6.4, 6.2, 1.2, { railX: 0.5 }),
        ...[4.4, 2.6].map((z) => mudguards(def, z, { y: z > 4 ? 1.45 : 1.55, len: 1.5, w: 0.6 })).flat(), ...[-1.8, -3.6].map((z) => mudguards(def, z, { y: 1.6, len: 1.5, w: 0.6 })).flat(),
        ...shelter(3.05, 4.4, 1.6, 3.15, 2.9, { door: false }),
        ...mirror([side([[-6.45, 1.55], [-6.45, 3.25], [2.95, 3.25], [2.95, 1.55]], 0.12, PAINT, 1.44),
          box(1.0, 0.08, 9.3, 1.0, 3.32, -1.75, PAINT, 0, 0, 0.35), // roof door (opened outward)
          ...[-5.4, -3.4, -1.4, 0.6, 2.4].map((z) => box(0.05, 1.7, 0.06, 1.51, 2.38, z, DARK)),
          ...[-4.4, -0.4].map((z) => box(0.04, 0.6, 1.0, 1.52, 2.1, z, DARK)), box(0.04, 0.4, 1.0, 1.52, 2.7, 1.6, TEAM)]),
        box(2.8, 0.12, 9.4, 0, 1.6, -1.75, PAINT), box(2.9, 1.7, 0.1, 0, 2.4, -6.45, PAINT),
        box(0.45, 0.45, 0.6, 0, 1.8, -6.2, DARK),
        ...jack(1.3, -6.25, 0.6, 1.5), ...jack(-1.3, -6.25, 0.6, 1.5),
        ...exhaust(-1.25, 4.45, 1.5, 3.55),
        ...rearEnd(-6.52, 1.3, hw),
      ],
      mounts: {
        0: {
          yaw: [],
          pitch: [box(0.35, 0.25, 6.6, 0, -0.35, 3.2, STEEL), ...[1.0, 3.0, 5.0].map((z) => box(1.9, 0.12, 0.2, 0, -0.2, z, DARK)), ...mirror([
            tubeZ(0.46, 0.46, 0.2, 5.4, 0.62, 0.15, 14, 0x5c6a3f), cone(0.46, 1.5, 14, 0.62, 0.15, 6.15, 0x5c6a3f, Math.PI / 2),
            ...[0.6, 2.0].map((z) => box(0.06, 0.5, 0.5, 0.62 + 0.46, 0.15, z, DARK)), ...[0.6, 2.0].map((z) => box(0.06, 0.5, 0.5, 0.62 - 0.46, 0.15, z, DARK)),
            box(0.5, 0.06, 0.06, 0.62, 0.62, 3.0, TEAM), tubeZ(0.47, 0.47, 5.0, 5.08, 0.62, 0.15, 14, DARK)])],
        },
      },
      wheel: truckTyre(r, 0.55),
    };
  },
});

Object.assign(TRUCK_MODELS, {
  /** BM-21 Grad on the Ural-4320 6×6: bonneted three-seat cab with a two-pane screen, long bonnet with the tall
   * vertical-slat grille between the wings, round headlamps on the wings, spare wheel behind the cab, 40-tube
   * launcher pivoting at the rear of the turntable. */
  grad: (def) => {
    const r = def.wheelRadius, hw = 1.25;
    const yF = 2.0 - 0.47;
    const c = { zB: 0.75, zF: 2.3, yB: yF - 0.3, yF, yBelt: yF + 0.75, yRoof: yF + 1.42, w: 2.3, rake: 0.08, split: true, door: [1.0, 2.2], quarter: false, rearWin: true, frontWall: 0.1, pillar: 0.08 };
    const cab = fitCab(def, c, { tilt: 0.7, wheelFwd: 0.46 });
    const bz0 = 2.3, bz1 = 3.5, by = c.yBelt - 0.08; // bonnet
    return {
      scheme: OLIVE_SCHEME,
      cabin: cab.cabin, glass: cab.glass,
      hull: [
        ...cab.hull,
        // bonnet: sloping top, side louvres; grille shell between the wings
        side([[bz0, c.yB + 0.1], [bz0, by], [bz1 - 0.05, by - 0.12], [bz1, by - 0.2], [bz1, c.yB + 0.1]], 1.25, PAINT),
        ...mirror([...[0, 1, 2, 3, 4].map((i) => box(0.02, 0.22, 0.04, 0.63, by - 0.3, bz0 + 0.3 + i * 0.12, DARK)), box(0.03, 0.03, bz1 - bz0, 0.63, by - 0.02, (bz0 + bz1) / 2, DARK)]),
        box(1.1, 0.75, 0.06, 0, by - 0.58, bz1 + 0.02, DARK), ...Array.from({ length: 11 }, (_, i) => box(0.04, 0.72, 0.06, -0.5 + i * 0.1, by - 0.58, bz1 + 0.05, STEEL)),
        box(1.2, 0.06, 0.08, 0, by - 0.2, bz1 + 0.04, PAINT), box(1.2, 0.06, 0.08, 0, by - 0.96, bz1 + 0.04, PAINT),
        // wings (fenders): flat top, rounded front, with headlamps on top of the front edge
        ...mirror([
          side([[bz0 - 0.65, 1.12], [bz0 - 0.6, 1.5], [bz1 - 0.45, 1.6], [bz1 + 0.05, 1.45], [bz1 + 0.15, 1.15]], 0.55, PAINT, 0.92),
          box(0.55, 0.04, 0.4, 0.92, 1.05, bz0 - 0.45, DARK, -0.4),
          cyl(0.13, 0.13, 0.12, 12, 0.92, 1.72, bz1 - 0.18, PAINT, Math.PI / 2), cyl(0.11, 0.11, 0.02, 12, 0.92, 1.72, bz1 - 0.115, INT.LAMP, Math.PI / 2),
          box(0.12, 0.06, 0.03, 0.85, 1.52, bz1 + 0.12, INT.AMBER), box(0.08, 0.1, 0.08, 0.92, 1.62, bz1 - 0.2, DARK),
        ]),
        box(2.25, 0.2, 0.22, 0, 0.95, bz1 + 0.18, STEEL), ...mirror([box(0.12, 0.22, 0.14, 0.55, 0.85, bz1 + 0.3, DARK)]), // bumper, tow hooks
        ...mirrors(1.15, c.yBelt + 0.35, c.zF - 0.1, 0.25),
        ...runningGear(def, -3.65, 3.4, 1.05),
        ...mudguards(def, -1.12, { y: 1.3, len: 1.25 }), ...mudguards(def, -2.52, { y: 1.3, len: 1.25 }),
        ...spareWheel(0, 1.95, 0.55, r, 0.4),
        ...fuelTank(0.98, 0.95, -0.3, 0.9), ...lockerBox(-0.95, 1.05, -0.2, 0.4, 0.5, 0.8),
        box(2.45, 0.12, 4.0, 0, 1.4, -1.7, PAINT), cyl(0.85, 0.9, 0.35, 14, 0, 1.6, -2.4, PAINT),
        ...jack(1.05, -3.45, 0.55, 1.3), ...jack(-1.05, -3.45, 0.55, 1.3),
        ...[0.5, 0.2].map((z) => box(0.04, 0.3, 0.55, 1.16, c.yF + 0.3, 1.4 + z, TEAM)).slice(0, 1),
        ...rearEnd(-3.68, 1.15, hw),
        ...exhaust(-1.05, 0.55, 1.2, 2.9),
      ],
      mounts: {
        0: {
          yaw: [box(1.55, 0.4, 1.65, 0, 0.0, -0.2, PAINT), ...mirror([box(0.12, 0.72, 0.82, 0.64, 0.25, -0.65, DARK)]), box(0.3, 0.3, 0.3, 0.9, 0.1, 0.4, DARK)],
          pitch: [
            ...Array.from({ length: 10 }, (_, i) => -0.63 + i * 0.14).flatMap((x) => [-0.12, 0.08, 0.28, 0.48].map((y) => tubeZ(0.062, 0.062, 0, 3.0, x, y, 8, PAINT))),
            ...[0.3, 1.5, 2.7].map((z) => box(1.52, 0.86, 0.1, 0, 0.18, z, STEEL)),
            ...Array.from({ length: 10 }, (_, i) => -0.63 + i * 0.14).flatMap((x) => [-0.12, 0.08, 0.28, 0.48].map((y) => tubeZ(0.045, 0.045, 2.99, 3.02, x, y, 8, DARK))),
            box(0.5, 0.12, 0.05, 0, 0.64, 1.5, TEAM), box(1.5, 0.08, 2.4, 0, -0.25, 1.5, DARK),
          ],
        },
      },
      wheel: truckTyre(r, 0.42),
    };
  },

  /** BM-30 Smerch on the MAZ-543M 8×8: two separate two-seat fibreglass cabs either side of the engine, sloping
   * screens, 12 × 300 mm tubes over the whole deck pivoting at the rear, jacks. */
  smerch: (def) => {
    const r = def.wheelRadius, hw = 1.45;
    const yF = 2.2 - 0.47;
    const mk = (side0) => {
      const cx = side0 * 1.0, idx = side0 > 0 ? [0, 2] : [1, 3];
      const pdef = { ...def, seats: def.seats.map((q) => ({ ...q, pos: [q.pos[0] - cx, q.pos[1], q.pos[2]] })) };
      const c = { zB: 3.35, zF: 5.65, yB: yF - 0.35, yF, yBelt: yF + 0.72, yRoof: yF + 1.38, w: 1.08, rake: 0.55, split: false, door: [3.75, 4.85], quarter: true, rearWin: false, frontWall: 0.12, pillar: 0.08, doorSides: [side0] };
      const cab = fitCab(pdef, c, { only: idx, noWheel: side0 < 0, tilt: 0.75, anyDoor: true });
      if (side0 < 0) cab.cabin.wheel = null;
      return shiftCab(cab, cx);
    };
    const L = mk(1), R = mk(-1);
    return {
      scheme: OLIVE_SCHEME,
      cabin: { zB: 3.35, zF: 5.65, seats: [...L.cabin.seats, ...R.cabin.seats], wheel: L.cabin.wheel, doors: [...L.cabin.doors, ...R.cabin.doors] },
      glass: [...L.glass, ...R.glass],
      hull: [
        ...L.hull, ...R.hull,
        ...mirror([box(0.95, 0.35, 0.3, 1.0, yF - 0.25, 5.8, DARK), box(0.28, 0.14, 0.04, 0.85, yF - 0.22, 5.96, INT.LAMP), box(0.12, 0.1, 0.03, 1.3, yF - 0.22, 5.96, INT.AMBER),
          ...mirrors(1.52, yF + 1.05, 5.2, 0.22).slice(0, 5)]),
        side([[3.4, 1.35], [3.4, 2.25], [5.55, 2.25], [6.05, 1.65], [6.05, 1.35]], 0.85, PAINT), // engine hood between the cabs
        box(0.7, 0.42, 0.05, 0, 1.75, 6.07, DARK), ...[0, 1, 2, 3].map((i) => box(0.6, 0.04, 0.04, 0, 1.6 + i * 0.1, 6.09, STEEL)), box(3.0, 0.24, 0.3, 0, 1.25, 6.12, STEEL),
        box(1.2, 0.42, 11.6, 0, 1.15, 0, DARK), box(2.95, 0.3, 9.0, 0, 1.6, -1.4, PAINT),
        box(2.4, 0.75, 1.15, 0, 2.1, 2.75, PAINT), ...mirror([box(0.04, 0.4, 0.8, 1.21, 2.15, 2.75, DARK)]), // equipment module
        ...mirror([
          ...[4.15, 1.95, -1.35, -3.55].map((z) => box(0.48, 0.08, 1.65, 1.3, 1.62, z, DARK)),
          ...jack(1.2, -5.5, 0.6, 1.4),
          side([[-5.9, 1.75], [-5.9, 2.05], [2.6, 2.05], [2.6, 1.75]], 0.06, STEEL, 1.45),
          box(0.04, 0.32, 0.7, 1.52, 1.95, 3.5, TEAM),
        ]),
        ...runningGear(def, -5.9, 5.5, 1.15, { railX: 0.5 }),
        ...rearEnd(-5.95, 1.3, hw),
      ],
      mounts: {
        0: {
          yaw: [box(2.3, 0.35, 1.3, 0, -0.15, 0.5, DARK), ...mirror([box(0.2, 0.6, 0.6, 0.9, 0.15, 0.4, DARK)])],
          pitch: [
            ...[-0.9, -0.3, 0.3, 0.9].flatMap((x) => [0.35, 0.85, 1.3].flatMap((y) => [tubeZ(0.2, 0.2, 0, 8.6, x, y, 12, PAINT), tubeZ(0.15, 0.15, 8.58, 8.62, x, y, 12, DARK), tubeZ(0.17, 0.17, -0.04, 0.0, x, y, 12, 0x5d86a8)])),
            ...[0.6, 4.2, 7.9].map((z) => box(2.62, 1.55, 0.14, 0, 0.82, z, STEEL)),
            box(2.6, 0.12, 8.6, 0, 0.06, 4.3, PAINT), box(0.6, 0.18, 0.05, 0.6, 1.55, 4.2, TEAM),
            ...[2.4, 6.0].map((z) => box(2.64, 0.05, 0.05, 0, 1.6, z, DARK)),
          ],
        },
      },
      wheel: truckTyre(r, 0.58),
    };
  },

  /** OST: armoured 6×6 operations supply truck (Typhoon-K family): faceted armoured cab with thick armoured glass,
   * armoured box body with doors and firing ports protecting the load; no weapons. */
  ost: (def) => {
    const r = def.wheelRadius, hw = 1.3;
    const yF = 2.3 - 0.47;
    const c = { zB: 1.85, zF: 3.95, yB: yF - 0.4, yF, yBelt: yF + 0.85, yRoof: yF + 1.45, w: 2.6, rake: 0.32, split: true, door: [2.35, 3.45], quarter: true, rearWin: false, pillar: 0.2, frontWall: 0.18, armoured: true };
    const cab = fitCab(def, c, { tilt: 0.9 });
    const fz = 2.48;
    // armoured rear doors, hinged at the body's rear corners
    for (const sd of [1, -1]) {
      cab.cabin.doors.push({ side: sd, x: sd * 1.3, y: 1.52, z: -4.3, axis: 'y', open: -sd * 1.65, seats: [],
        geo: [box(1.28, 1.6, 0.08, -sd * 0.64, 0.8, 0, PAINT), box(1.2, 1.5, 0.03, -sd * 0.64, 0.8, 0.05, 0x5d6555), box(0.24, 0.24, 0.04, -sd * 0.68, 1.23, -0.05, GLASS),
          box(0.05, 0.08, 0.2, -sd * 1.1, 0.7, -0.07, STEEL), ...[0.4, 1.2].map((y) => box(0.06, 0.12, 0.12, -sd * 0.05, y, -0.06, DARK)), box(0.06, 0.06, 0.06, -sd * 0.68, 0.95, -0.06, DARK)] });
    }
    // the load: shelving along both walls with ammunition boxes and supply crates, strapped down; dome lamps
    const load = [];
    for (const sd of [1, -1]) {
      for (const y of [1.6, 2.2, 2.8]) load.push(box(0.5, 0.04, 5.0, sd * 0.95, y, -1.6, STEEL));
      for (let z = -3.8; z < 0.7; z += 1.2) load.push(box(0.04, 1.6, 0.04, sd * 0.72, 2.3, z, STEEL));
      for (let z = -3.7; z < 0.8; z += 0.62) for (const y of [1.62, 2.22, 2.82]) load.push(box(0.42, 0.36, 0.52, sd * 0.97, y + 0.2, z, ((z * 10 + y * 7) | 0) % 2 ? CRATE : CRATE2), box(0.44, 0.04, 0.05, sd * 0.97, y + 0.3, z + 0.2, DARK));
      load.push(box(0.03, 0.04, 5.0, sd * 0.7, 2.5, -1.6, 0x3a3a30));
    }
    for (let z = -3.4; z < 0.8; z += 0.8) load.push(box(0.6, 0.4, 0.6, 0, 1.78, z, CRATE2), box(0.62, 0.05, 0.12, 0, 1.9, z, DARK));
    load.push(box(0.18, 0.03, 0.12, 0, 3.12, -0.5, INT.LAMP), box(0.18, 0.03, 0.12, 0, 3.12, -2.8, INT.LAMP));
    cab.cabin.parts = load;
    return {
      scheme: OLIVE_SCHEME,
      cabin: cab.cabin, glass: cab.glass,
      hull: [
        ...cab.hull,
        // faceted armoured nose: sloped glacis over the engine, grille armour louvres, bumper, lamps in cages
        side([[3.9, c.yB], [3.9, c.yBelt], [4.15, c.yBelt - 0.15], [4.35, c.yB + 0.35], [4.35, c.yB]], 2.6, PAINT),
        box(1.6, 0.5, 0.05, 0, c.yB + 0.55, 4.31, DARK), ...[0, 1, 2, 3].map((i) => box(1.5, 0.05, 0.08, 0, c.yB + 0.36 + i * 0.12, 4.34, STEEL, -0.4)),
        box(2.7, 0.32, 0.32, 0, c.yB - 0.05, 4.4, STEEL),
        ...mirror([box(0.36, 0.2, 0.08, 0.95, c.yB + 0.15, 4.4, DARK), box(0.28, 0.14, 0.02, 0.95, c.yB + 0.15, 4.45, INT.LAMP), ...[-0.12, 0, 0.12].map((dx) => box(0.02, 0.22, 0.04, 0.95 + dx, c.yB + 0.15, 4.47, DARK)),
          box(0.12, 0.08, 0.04, 1.2, c.yBelt - 0.2, 4.0, INT.AMBER),
          ...[-0.3, 0.3].map((dz) => box(0.04, 0.04, 0.04, 1.32, c.yBelt - 0.4, 3.0 + dz, DARK))]),
        ...mirrors(hw, c.yBelt + 0.35, 3.75, 0.25),
        ...runningGear(def, -4.25, 3.9, 1.15),
        ...mirror([...[2.48, -1.21, -2.53].map((z) => box(0.45, 0.08, 1.6, 1.12, 1.48, z, DARK)), box(0.06, 0.45, 1.6, 1.32, 1.2, fz, PAINT)]),
        ...mirror([box(0.28, 0.05, 0.4, 1.17, c.yB - 0.3, 2.0, STEEL), box(0.28, 0.05, 0.4, 1.17, c.yB + 0.05, 2.0, STEEL)]),
        ...spareWheel(0, 2.3, 1.55, r, 0.42),
        // armoured cargo body: double rear doors with vision blocks, firing ports, panel seams, roof hatch
        // hollow body: floor, armoured walls, roof and front bulkhead (rear doors are operable parts)
        box(2.6, 0.12, 5.6, 0, 1.51, -1.48, PAINT), box(2.6, 0.1, 5.5, 0, 3.2, -1.5, PAINT),
        ...mirror([box(0.08, 1.7, 5.6, 1.26, 2.35, -1.48, PAINT), box(0.03, 1.55, 5.4, 1.21, 2.35, -1.48, 0x5d6555)]),
        side([[1.15, 1.45], [1.15, 3.25], [1.35, 3.0], [1.35, 1.45]], 2.6, PAINT), box(2.45, 1.6, 0.03, 0, 2.35, 1.12, 0x5d6555),
        ...mirror([
          ...[-3.6, -2.3, -1.0, 0.3].map((z) => box(0.05, 0.24, 0.24, 1.31, 2.6, z, DARK)), ...[-3.6, -2.3, -1.0, 0.3].map((z) => box(0.03, 0.12, 0.16, 1.33, 2.85, z, GLASS)),
          ...[-3.0, -1.7, -0.4].map((z) => box(0.03, 1.75, 0.05, 1.31, 2.35, z, DARK)),
          box(0.04, 0.4, 1.3, 1.31, 2.0, -1.7, TEAM), box(0.06, 0.06, 5.4, 1.32, 1.55, -1.55, DARK),
        ]),
        box(2.6, 0.08, 5.45, 0, 3.27, -1.57, DARK), cyl(0.35, 0.35, 0.1, 12, 0, 3.32, -2.0, DARK),
        ...[0.25, 0.55].map((k) => box(0.5, 0.04, 0.2, 0, 1.45 - k, -4.45, STEEL)),
        ...rearEnd(-4.32, 1.25, hw),
      ],
      wheel: truckTyre(r, 0.5),
    };
  },
});

Object.assign(TRUCK_MODELS, {
  /** UAZ-469: boxy 4×4 with a short bonnet, upright framed windscreen, steel doors with canvas uppers, canvas top
   * with side and rear windows, slotted grille between round headlamps, spare wheel on the tailgate. */
  uaz: (def) => {
    const c = { zB: -1.92, zF: 1.02, yB: 0.5, yF: 0.56, yBelt: 1.28, yRoof: 1.98, w: 1.72, rake: 0.12, split: false, door: [0.08, 0.95], quarter: true, rearWin: true,
      pillar: 0.06, frontWall: 0.12, upper: CANVAS, roofCrown: 0.03 };
    const cab = fitCab(def, c, { tilt: 0.42, wheelUp: 0.42, wheelFwd: 0.42, wheelR: 0.2, hump: 0.14 });
    const ry = 0.37;
    return {
      scheme: { base: [0x55603a] },
      cabin: cab.cabin, glass: cab.glass,
      hull: [
        ...cab.hull,
        side([[1.0, 0.55], [1.0, 1.3], [1.95, 1.2], [2.02, 0.95], [2.02, 0.55]], 1.5, PAINT), // bonnet + front panel
        ...mirror([box(0.025, 0.02, 0.92, 0.74, 1.27, 1.48, DARK, 0.1)]), box(1.45, 0.02, 0.025, 0, 1.3, 1.04, DARK), // bonnet seams
        ...[-3, -2, -1, 0, 1, 2, 3].map((i) => box(0.06, 0.34, 0.03, i * 0.1, 0.92, 2.03, DARK)), // grille slots
        ...mirror([
          cyl(0.1, 0.1, 0.06, 12, 0.56, 0.95, 2.02, INT.LAMP, Math.PI / 2), cyl(0.12, 0.12, 0.05, 12, 0.56, 0.95, 2.0, DARK, Math.PI / 2),
          box(0.12, 0.06, 0.04, 0.72, 0.76, 2.02, INT.AMBER),
          side([[-1.6, 0.62], [-1.5, 1.02], [-0.85, 1.02], [-0.75, 0.62]], 0.12, PAINT, 0.9), side([[0.85, 0.62], [0.95, 1.05], [1.65, 1.05], [1.75, 0.62]], 0.12, PAINT, 0.9), // fender flares
          box(0.04, 0.04, 0.55, 0.88, 1.05, -0.55, DARK), box(0.03, 0.95, 0.03, 0.865, 0.92, -0.08, DARK), // rear door seam + handle
          box(0.04, 0.28, 0.5, 0.88, 0.95, -1.35, TEAM),
          ...mirrors(0.86, 1.48, 0.95, 0.12).slice(0, 4),
        ]),
        box(1.72, 0.12, 0.16, 0, 0.62, 2.06, STEEL), box(1.62, 0.12, 0.12, 0, 0.62, -1.98, STEEL),
        ...mirror([box(0.1, 0.12, 0.06, 0.78, 0.82, -1.95, 0x7a1f1a)]),
        tubeZ(0.36, 0.36, -2.22, -2.0, 0.42, 1.12, 14, RUBBER), tubeZ(0.2, 0.2, -2.24, -2.0, 0.42, 1.12, 10, PAINT), // spare wheel
        box(0.2, 0.34, 0.12, -0.55, 1.05, -2.02, 0x4a5530), // jerrycan
        box(1.0, 0.1, 3.0, 0, ry + 0.02, 0, DARK), tubeX(0.07, 1.4, 0, ry, 1.19, 8, DARK), tubeX(0.07, 1.4, 0, ry, -1.19, 8, DARK),
        cyl(0.01, 0.01, 1.6, 4, -0.8, 2.3, -1.6, DARK),
      ],
      wheel: truckTyre(def.wheelRadius, 0.26, { lugs: 14 }),
    };
  },

  /** GAZ Tigr-M: long sloping bonnet with a bull bar, tall armoured four-door cabin with thick armoured glass and
   * firing ports, roof hatch with a shielded Kord, rear door carrying the spare wheel. */
  tigr: (def) => {
    const c = { zB: -2.72, zF: 0.95, yB: 0.62, yF: 0.85, yBelt: 1.7, yRoof: 2.38, w: 2.3, rake: 0.42, split: true, door: [-0.38, 0.72], quarter: true, rearWin: true,
      pillar: 0.15, frontWall: 0.14, armoured: true };
    const cab = fitCab(def, c, { skip: [1], tilt: 0.5, wheelUp: 0.45, wheelFwd: 0.42 });
    return {
      scheme: { base: [0x5a663f] },
      cabin: cab.cabin, glass: cab.glass,
      hull: [
        ...cab.hull,
        // armour around the rear windows (they are small), rear door outline and firing ports
        ...mirror([box(0.06, 0.25, 2.1, 1.14, 1.82, -1.6, PAINT), box(0.06, 0.2, 2.1, 1.14, 2.25, -1.6, PAINT), box(0.05, 0.75, 0.04, 1.155, 1.27, -1.5, DARK),
          ...[-1.0, -2.2].map((z) => box(0.05, 0.12, 0.12, 1.16, 1.4, z, DARK)), box(0.04, 0.3, 0.6, 1.16, 1.25, -2.15, TEAM),
          box(0.42, 0.2, 1.3, 1.04, 1.12, 1.85, PAINT), box(0.42, 0.2, 1.3, 1.04, 1.12, -1.65, PAINT), // wheel arches
          box(0.3, 0.05, 0.4, 1.05, 0.45, -0.5, STEEL)]),
        // bonnet: long, sloping, with louvres; grille, lamps and the bull bar
        side([[0.9, 0.7], [0.9, 1.72], [2.55, 1.42], [2.85, 1.08], [2.85, 0.7]], 2.28, PAINT),
        ...[1.3, 1.5, 1.7].map((z) => box(0.9, 0.03, 0.08, 0, 1.72 - (z - 0.9) * 0.18 + 0.02, z, DARK, 0.18)),
        box(1.45, 0.4, 0.05, 0, 1.12, 2.86, DARK), ...Array.from({ length: 9 }, (_, i) => box(0.05, 0.36, 0.05, -0.6 + i * 0.15, 1.12, 2.89, STEEL)),
        ...mirror([box(0.28, 0.16, 0.06, 0.92, 1.24, 2.86, INT.LAMP), box(0.12, 0.08, 0.04, 0.92, 1.0, 2.88, INT.AMBER),
          box(0.08, 0.72, 0.08, 0.8, 1.05, 3.02, STEEL), ...mirrors(1.15, 2.0, 0.6, 0.2).slice(0, 4)]),
        box(1.75, 0.08, 0.08, 0, 1.42, 3.02, STEEL), box(1.75, 0.08, 0.08, 0, 0.75, 3.02, STEEL), box(2.0, 0.2, 0.22, 0, 0.62, 2.85, STEEL),
        tubeZ(0.5, 0.5, -3.0, -2.78, 0.25, 1.4, 14, RUBBER), tubeZ(0.26, 0.26, -3.02, -2.78, 0.25, 1.4, 10, PAINT), // spare on the rear door
        cyl(0.48, 0.48, 0.08, 14, 0, 2.43, -0.25, DARK), // roof hatch ring
        cyl(0.01, 0.01, 1.8, 4, -0.95, 3.3, -2.4, DARK),
      ],
      mounts: { 0: kordMount(0.44) },
      wheel: truckTyre(def.wheelRadius, 0.36, { lugs: 16 }),
    };
  },
});

Object.assign(TRUCK_MODELS, {
  /** IMR-2M combat engineer vehicle (T-72 chassis): wide dozer blade with side wings on push arms, armoured
   * operator cabin with armoured glass, telescopic crane on a turntable stowed along the right side with the
   * pincer grab at the rear, remote Kord on the cabin, fuel drums and tool boxes. */
  cev: (def) => {
    const cx = 0.6;
    const pdef = { ...def, seats: def.seats.map((q) => ({ ...q, pos: [q.pos[0] - cx, q.pos[1], q.pos[2]] })) };
    const c = { zB: -0.55, zF: 1.15, yB: 1.4, yF: 1.45, yBelt: 2.2, yRoof: 2.72, w: 1.35, rake: 0.3, split: false, door: [-0.4, 0.2], quarter: true, rearWin: false,
      pillar: 0.16, frontWall: 0.16, armoured: true };
    const cab = shiftCab(fitCab(pdef, c, { only: [0, 1], noWheel: true, noDoors: true }), cx);
    const ry = 1.6;
    return {
      scheme: OLIVE_SCHEME,
      cabin: cab.cabin, glass: [...cab.glass, ...cab.doorGlass.map((g) => g.translate(cx, 0, 0))],
      hull: [
        ...cab.hull, ...cab.doorsAsHull.map((g) => g.translate(cx, 0, 0)),
        // T-72 hull: lower hull, upper glacis, engine deck, side skirts
        side([[-3.4, 0.45], [-3.4, 1.1], [3.4, 1.1], [3.05, 0.45]], 2.3, PAINT),
        side([[-3.45, 1.05], [-3.45, 1.45], [-3.3, ry], [2.1, ry], [3.5, 1.05]], 3.4, PAINT),
        ...mirror([
          side([[-3.25, 0.62], [-3.25, 1.08], [3.25, 1.08], [3.45, 0.78], [3.3, 0.62]], 0.06, PAINT, 1.72),
          ...trackGear({ x: 1.32, w: 0.55, zs: [-2.45, -1.48, -0.5, 0.48, 1.45, 2.42], r: 0.37, zRear: -3.05, zFront: 3.0, top: 0.82, rollers: [-2.0, -0.2, 1.6] }),
          box(0.18, 0.12, 0.08, 1.2, 1.3, 3.42, INT.LAMP), box(0.04, 0.3, 0.9, 1.75, 0.9, -1.4, TEAM),
          box(0.06, 0.32, 1.4, 1.73, 1.32, -2.2, DARK), // exhaust louvre
          // dozer push arms and hydraulic rams
          box(0.16, 0.18, 2.2, 1.35, 0.75, 3.9, DARK, 0.18), cyl(0.07, 0.07, 1.4, 8, 1.0, 1.25, 3.7, STEEL, Math.PI / 2 - 0.5),
          // blade wing (angled)
          box(1.25, 1.05, 0.12, 1.15, 0.62, 5.0, PAINT, 0.18, 0.5, 0), box(1.25, 0.08, 0.16, 1.15, 0.12, 5.05, STEEL, 0, 0.5, 0),
        ]),
        // centre blade section with cutting edge and ribs
        box(1.4, 1.1, 0.14, 0, 0.62, 5.25, PAINT, 0.18), box(1.42, 0.08, 0.18, 0, 0.1, 5.32, STEEL), ...[-0.5, 0, 0.5].map((x) => box(0.08, 0.95, 0.14, x, 0.66, 5.14, DARK, 0.18)),
        // crane turntable, telescopic boom stowed rearward on the right, pincer grab on a rest at the rear
        cyl(0.55, 0.6, 0.3, 14, -0.75, ry + 0.15, 0.6, DARK), box(0.7, 0.55, 0.8, -0.75, ry + 0.55, 0.6, PAINT),
        box(0.5, 0.5, 3.0, -0.95, ry + 0.75, -0.9, PAINT), box(0.4, 0.4, 1.4, -0.95, ry + 0.75, -3.05, STEEL), box(0.3, 0.3, 0.6, -0.95, ry + 0.75, -3.9, STEEL),
        cyl(0.1, 0.1, 1.4, 8, -0.95, ry + 0.45, 0.0, STEEL, Math.PI / 2 - 0.25), // lift ram
        box(0.6, 0.35, 0.45, -0.95, ry + 0.7, -4.3, DARK), ...[-1, 1].map((sd) => box(0.08, 0.75, 0.3, -0.95 + sd * 0.25, ry + 0.4, -4.5, DARK, 0.35)),
        box(0.12, ry + 0.4, 0.12, -0.95, (ry + 0.4) / 2, -3.6, DARK), // boom rest
        ...mirror([cyl(0.3, 0.3, 0.85, 12, 0.55, 1.28, -3.68, PAINT, 0, 0, Math.PI / 2)]), // fuel drums
        box(0.7, 0.35, 0.5, -0.9, ry + 0.17, 1.5, PAINT), box(0.72, 0.04, 0.52, -0.9, ry + 0.35, 1.5, DARK), // tool box
        box(1.0, 0.12, 0.6, 0.6, ry + 0.06, -1.6, DARK), ...[-1.4, -1.6, -1.8].map((z) => box(0.9, 0.03, 0.06, 0.6, ry + 0.13, z, STEEL)), // engine louvres
        cyl(0.012, 0.012, 2.0, 4, 1.3, 3.6, -3.0, DARK),
      ],
      mounts: { 0: kordMount(0.3) },
    };
  },
});

export { CRATE, kordMount, kornetMount, runningGear, mudguards, fuelTank, lockerBox, spareWheel, exhaust, airFilter, rearEnd, cargoBed, tilt, crates, kamazCab, axleZs, track };
export { cone, place, top, tubeX, CANVAS, STEEL, GLASS, mirrors };
