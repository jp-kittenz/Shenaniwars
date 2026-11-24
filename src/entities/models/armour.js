import {
  PAINT, TEAM, DARK, STEEL, RUBBER, TRACK, GLASS, LENS, WOOD,
  box, cyl, tubeZ, tubeX, sphere, cone, side, top, front, mirror, place, wheelGeo,
} from './kit.js';

/**
 * Armour (Torsa tracked and wheeled fighting vehicles), ground coordinates (+Z forward, +X left, y = 0 on the
 * ground); turret / gun parts relative to their mount pivots (vehicle-defs). Built from a kit of running gear
 * (track loop with cleats, dual rubber-tyred road wheels on swing arms, toothed sprocket, idler, return rollers,
 * skirts), reactive armour arrays, guns (thermal sleeve, bore evacuator, muzzle reference), sights, smoke
 * dischargers, stowage.
 */

const RU = [0x4f5b33], RU2 = { base: [0x56613b, 0x3f4729, 0x6a6a46], scale: 2.4 }, LAMP = 0xfff0c0, RED = 0x7a1f1a;

// ------------------------------------------------------------------ running gear

/**
 * One side of a tracked running gear (mirror() it): track loop (top run, bottom run, sloped ends) with cleats,
 * dual road wheels with rubber tyres and hubs on swing arms, sprocket (rear) with teeth, idler (front), rollers.
 * @param {{x:number,w:number,zs:number[],r:number,zRear:number,zFront:number,top:number,sprY?:number,idlY?:number,rollers?:number[],hullY?:number,front?:boolean}} o
 */
export function tracks(o) {
  const { x, w, zs, r } = o, yT = o.top, sy = o.sprY ?? yT - 0.3, iy = o.idlY ?? yT - 0.32;
  const zMin = Math.min(...zs), zMax = Math.max(...zs);
  const zS = o.front ? o.zFront : o.zRear, zI = o.front ? o.zRear : o.zFront; // sprocket at the rear unless front drive
  const p = [];
  const loop = [[o.zRear - 0.36, (o.front ? iy : sy)], [o.zRear - 0.02, yT], [o.zFront + 0.02, yT], [o.zFront + 0.36, (o.front ? sy : iy)], [zMax + r * 0.55, 0.03], [zMin - r * 0.55, 0.03]];
  p.push(side(loop, w * 0.92, TRACK, x));
  // cleats (track shoes) along the top and bottom runs and the ends
  for (let z = zMin - r * 0.5; z <= zMax + r * 0.5; z += 0.17) p.push(box(w * 0.96, 0.035, 0.06, x, 0.015, z, 0x24241f));
  for (let z = o.zRear + 0.05; z <= o.zFront - 0.05; z += 0.17) p.push(box(w * 0.96, 0.035, 0.06, x, yT + 0.015, z, 0x24241f));
  for (const s of [-1, 1]) p.push(box(0.03, 0.05, (o.zFront - o.zRear) + 0.6, x + s * w * 0.47, yT - 0.02, (o.zFront + o.zRear) / 2, 0x33332c)); // guide horns
  // road wheels: two discs per station, rubber rims, hubs, swing arms to the hull
  for (const z of zs) {
    for (const s of [-1, 1]) {
      const xx = x + s * w * 0.24;
      p.push(tubeX(r, w * 0.36, xx, r, z, 14, RUBBER), tubeX(r * 0.86, w * 0.38, xx, r, z, 14, o.wheelColor ?? PAINT));
    }
    p.push(tubeX(r * 0.3, w + 0.06, x, r, z, 8, STEEL), tubeX(r * 0.14, w + 0.12, x, r, z, 6, DARK));
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; p.push(box(w + 0.08, 0.04, 0.04, x, r + Math.cos(a) * r * 0.5, z + Math.sin(a) * r * 0.5, DARK)); }
    const hy = o.hullY ?? r + 0.35;
    p.push(place(box(0.12, 0.1, 0.62, 0, 0, 0, DARK), x - Math.sign(x) * (w / 2 + 0.06), (r + hy) / 2, z + 0.25, -Math.atan2(hy - r, 0.5), 0, 0)); // swing arm
  }
  // sprocket with teeth, idler
  p.push(tubeX(0.31, w * 0.7, x, sy, zS, 12, DARK), tubeX(0.2, w + 0.04, x, sy, zS, 8, STEEL));
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; for (const s of [-1, 1]) p.push(box(0.07, 0.07, 0.07, x + s * w * 0.3, sy + Math.cos(a) * 0.34, zS + Math.sin(a) * 0.34, DARK)); }
  p.push(tubeX(0.28, w * 0.75, x, iy, zI, 12, o.wheelColor ?? PAINT), tubeX(0.12, w + 0.04, x, iy, zI, 6, STEEL));
  for (const z of o.rollers || []) p.push(tubeX(0.1, w * 0.55, x, yT - 0.07, z, 8, o.wheelColor ?? PAINT), tubeX(0.05, w * 0.6, x, yT - 0.07, z, 6, STEEL));
  return p;
}

/** Rubber / armoured side skirt over the track (one side), with the hinged front panels and ERA bricks. */
function skirt(x, z0, z1, y0, y1, o = {}) {
  const p = [box(0.06, y1 - y0, z1 - z0, x, (y0 + y1) / 2, (z0 + z1) / 2, PAINT)];
  for (let z = z0 + 0.6; z < z1 - 0.2; z += 1.0) p.push(box(0.07, y1 - y0 - 0.04, 0.025, x + Math.sign(x) * 0.005, (y0 + y1) / 2, z, DARK));
  p.push(box(0.04, 0.16, z1 - z0, x, y0 - 0.06, (z0 + z1) / 2, RUBBER));
  if (o.era) for (let z = o.era[0]; z < o.era[1]; z += 0.42) p.push(box(0.12, (y1 - y0) * 0.72, 0.38, x + Math.sign(x) * 0.06, (y0 + y1) / 2 + 0.02, z + 0.2, PAINT), box(0.13, 0.02, 0.36, x + Math.sign(x) * 0.065, y1 - 0.06, z + 0.2, DARK));
  return p;
}

// ------------------------------------------------------------------ armour, guns, fittings

/** Grid of reactive armour bricks on a plane tilted by rx about x (glacis) centred at (x, y, z). */
function eraGrid(nx, ny, w, h, x, y, z, rx, d = 0.1, ry = 0) {
  const p = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const u = (i - (nx - 1) / 2) * (w / nx), v = (j - (ny - 1) / 2) * (h / ny);
    p.push(place(box(w / nx - 0.03, d, h / ny - 0.03, u, 0, v, PAINT), x, y, z, rx, ry, 0));
    p.push(place(box(0.03, 0.02, 0.03, u, d / 2 + 0.005, v, DARK), x, y, z, rx, ry, 0));
  }
  return p;
}

/** Tank gun along +Z from the mantlet: tube tapering, thermal sleeve bands, bore evacuator, muzzle reference. */
function gun(z0, len, r0, r1, o = {}) {
  const z1 = z0 + len, p = [tubeZ(r0, r1, z0, z1, 0, 0, 12, PAINT)];
  const ev = o.evac ?? 0.45;
  p.push(tubeZ(r0 * 1.45, r0 * 1.45, z0 + len * ev, z0 + len * ev + 0.75, 0, 0, 14, PAINT), cone(r0 * 1.45, 0.12, 14, 0, 0, z0 + len * ev + 0.81, PAINT, Math.PI / 2));
  for (const f of o.bands ?? [0.18, 0.32, 0.65, 0.82]) p.push(tubeZ(r0 * 1.15, r0 * 1.15, z0 + len * f, z0 + len * f + 0.07, 0, 0, 12, DARK));
  p.push(tubeZ(r1 * 1.1, r1 * 1.1, z1 - 0.06, z1, 0, 0, 12, DARK), tubeZ(r1 * 0.7, r1 * 0.7, z1 - 0.02, z1 + 0.005, 0, 0, 10, 0x111111));
  if (o.mrs !== false) p.push(box(0.1, 0.07, 0.12, 0, r1 + 0.05, z1 - 0.15, DARK));
  return p;
}

/** Bank of smoke grenade dischargers on an arc (n tubes). */
function smokeBank(x, y, z, n, spread, side0 = 1) {
  const p = [];
  for (let i = 0; i < n; i++) { const a = side0 * (0.25 + (i / (n - 1)) * spread); p.push(place(tubeZ(0.045, 0.045, 0, 0.26, 0, 0, 8, DARK), x + Math.sin(a) * 0.05 * i * side0, y + (i % 2) * 0.09, z - i * 0.06, -0.35, a, 0)); }
  return p;
}

/** Commander's cupola with vision blocks and hatch ring. */
function cupola(x, y, z, r = 0.38) {
  const p = [cyl(r, r + 0.03, 0.2, 14, x, y, z, PAINT), cyl(r - 0.06, r - 0.06, 0.06, 14, x, y + 0.12, z, DARK)];
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; p.push(box(0.1, 0.07, 0.04, x + Math.sin(a) * r, y + 0.05, z + Math.cos(a) * r, LENS, 0, a)); }
  return p;
}

/** Periscope head. */
const scope = (x, y, z, a = 0) => [box(0.14, 0.1, 0.1, x, y, z, DARK, 0, a), box(0.1, 0.05, 0.02, x, y + 0.01, z + 0.05, LENS, 0, a)];

/** Tow cable coiled along the hull side (+X side sign s). */
const towCable = (x, y, z0, z1) => [tubeZ(0.025, 0.025, z0, z1, x, y, 6, 0x2a2a26), tubeZ(0.025, 0.025, z0, z1, x, y + 0.06, 6, 0x2a2a26), box(0.06, 0.12, 0.12, x, y + 0.03, z1 + 0.06, STEEL)];

/** Stowage bin with a hinged lid and straps. */
const bin = (x, y, z, w, h, d, c = PAINT) => [box(w, h, d, x, y, z, c), box(w + 0.02, 0.03, d + 0.02, x, y + h / 2, z, DARK), box(0.04, h + 0.02, 0.02, x, y, z - d * 0.25, DARK), box(0.04, h + 0.02, 0.02, x, y, z + d * 0.25, DARK)];

/** Pintle / remote heavy MG for a commander: { yaw, pitch }. */
function hmg(barrel = 1.05) {
  return {
    yaw: [box(0.12, 0.3, 0.12, 0, -0.15, 0, DARK), box(0.22, 0.06, 0.22, 0, -0.02, 0, STEEL)],
    pitch: [box(0.13, 0.15, 0.78, 0, 0, 0.18, DARK), box(0.18, 0.2, 0.24, 0.15, -0.05, 0.05, 0x4a5530), tubeZ(0.025, 0.022, 0.55, 0.55 + barrel, 0, 0.03, 8, STEEL), tubeZ(0.04, 0.04, 0.45 + barrel, 0.6 + barrel, 0, 0.03, 8, DARK)],
  };
}

/** Engine deck grilles. */
function grilles(x, y, z0, z1, w) {
  const p = [box(w, 0.04, z1 - z0, x, y, (z0 + z1) / 2, DARK)];
  for (let z = z0 + 0.1; z < z1 - 0.05; z += 0.12) p.push(box(w - 0.06, 0.03, 0.04, x, y + 0.025, z, STEEL));
  return p;
}

/** Headlight cluster with a guard (front of the hull). */
const lamp = (x, y, z) => [box(0.2, 0.14, 0.12, x, y, z, DARK), box(0.14, 0.1, 0.02, x, y, z + 0.065, LAMP), box(0.24, 0.03, 0.18, x, y + 0.1, z + 0.02, STEEL)];

// ------------------------------------------------------------------ models

export const ARMOUR_MODELS = {
  /** T-90A: welded turret with Kontakt-5 wedges, Shtora dazzlers either side of the gun, commander's cupola with
   * a remote Kord, bustle box; glacis ERA, side skirts with ERA forward, fuel drums and unditching log at the rear. */
  mbt: () => ({
    scheme: RU2,
    hull: [
      side([[-3.4, 0.45], [-3.4, 1.1], [3.4, 1.1], [3.05, 0.45]], 2.3, PAINT),
      side([[-3.45, 1.05], [-3.45, 1.45], [-3.3, 1.6], [2.1, 1.6], [3.5, 1.05]], 3.45, PAINT),
      ...eraGrid(7, 2, 2.9, 1.15, 0, 1.385, 2.8, 0.374, 0.12),
      box(0.42, 0.22, 0.46, 0, 1.62, 2.05, PAINT), cyl(0.25, 0.27, 0.08, 10, 0, 1.68, 2.05, DARK), ...scope(0, 1.73, 2.3),
      box(3.0, 0.24, 0.12, 0, 0.62, 3.42, PAINT), // lower glacis dozer mount
      ...mirror([
        ...tracks({ x: 1.41, w: 0.58, zs: [-2.45, -1.48, -0.5, 0.48, 1.45, 2.42], r: 0.37, zRear: -3.05, zFront: 3.0, top: 0.82, rollers: [-2.0, -0.2, 1.6], hullY: 0.85 }),
        ...skirt(1.76, -3.25, 3.25, 0.7, 1.08, { era: [1.4, 3.2] }),
        ...lamp(1.2, 1.22, 3.42), box(0.04, 0.2, 0.9, 1.8, 0.88, -0.8, TEAM),
        ...grilles(0.65, 1.62, -3.2, -1.6, 0.9), box(0.06, 0.3, 1.5, 1.73, 1.3, -2.2, DARK),
        ...bin(1.45, 1.75, -0.6, 0.5, 0.28, 1.1), ...towCable(1.6, 1.62, 0.4, 2.0),
      ]),
      tubeX(0.28, 0.85, 0.55, 1.28, -3.68, 12, PAINT), tubeX(0.28, 0.85, -0.55, 1.28, -3.68, 12, PAINT), ...mirror([tubeX(0.29, 0.04, 0.55, 1.28, -3.68, 12, DARK)]),
      tubeX(0.12, 3.1, 0, 1.62, -3.45, 8, WOOD), box(3.0, 0.12, 0.08, 0, 1.4, -3.47, DARK),
    ],
    mounts: {
      0: {
        yaw: [
          top([[1.2, 0.75], [1.25, 0], [1.15, -0.75], [0.85, -1.3], [0.4, -1.55], [-0.4, -1.55], [-0.85, -1.3], [-1.15, -0.75], [-1.25, 0], [-1.2, 0.75], [-0.6, 1.15], [0.6, 1.15]], -0.42, 0.72, PAINT, 0.86),
          ...mirror([
            top([[0.3, 1.12], [1.22, 0.62], [1.42, 0.98], [0.42, 1.62]], -0.32, 0.5, PAINT, 0.94), // Kontakt-5 wedge
            ...[0, 1, 2].map((k) => box(0.6, 0.02, 0.03, 0.85 - k * 0.12, 0.2 - k * 0.04, 1.0 + k * 0.18, DARK, 0, 0.5)),
            box(0.36, 0.28, 0.3, 0.78, 0.42, 0.9, PAINT), box(0.26, 0.18, 0.04, 0.78, 0.43, 1.06, RED), // Shtora dazzler
            ...smokeBank(1.05, 0.12, 0.35, 6, 0.6),
            box(0.04, 0.2, 0.75, 1.2, 0.0, -0.25, TEAM), box(0.05, 0.05, 1.6, 1.16, 0.25, -0.35, DARK), // rail
          ]),
          box(0.34, 0.3, 0.44, 0.48, 0.45, 0.45, PAINT), box(0.26, 0.16, 0.04, 0.48, 0.47, 0.68, LENS), box(0.3, 0.04, 0.1, 0.48, 0.62, 0.58, DARK),
          ...cupola(-0.52, 0.38, -0.4),
          ...bin(0, 0.02, -1.74, 1.9, 0.5, 0.48), box(0.18, 0.05, 0.1, 0.5, 0.36, -1.55, DARK),
          cyl(0.014, 0.014, 2.4, 4, 0.85, 1.4, -1.2, DARK), box(0.25, 0.25, 0.25, 0.7, 0.4, -1.0, DARK), // aerial, sensor
        ],
        pitch: [box(0.72, 0.56, 0.5, 0, 0, 0.1, PAINT), box(0.5, 0.3, 0.12, 0, 0.05, 0.38, DARK), ...gun(0.3, 5.6, 0.1, 0.088)],
      },
      2: hmg(1.05),
    },
  }),

  /** T-80U: long low hull with the gas turbine's rear grille, Kontakt-5 "horseshoe" turret, rubber side skirts
   * with ERA, snorkel tube on the turret rear, stowage boxes. */
  ht: () => ({
    scheme: RU2,
    hull: [
      side([[-3.55, 0.45], [-3.55, 1.12], [3.5, 1.12], [3.15, 0.45]], 2.35, PAINT),
      side([[-3.6, 1.07], [-3.6, 1.45], [-3.45, 1.62], [2.15, 1.62], [3.6, 1.07]], 3.5, PAINT),
      ...eraGrid(7, 2, 3.0, 1.15, 0, 1.4, 2.88, 0.363, 0.12),
      box(0.42, 0.22, 0.46, 0, 1.64, 2.15, PAINT), cyl(0.25, 0.27, 0.08, 10, 0, 1.7, 2.15, DARK), ...scope(0, 1.75, 2.4),
      ...grilles(0, 1.64, -3.5, -2.2, 2.6), box(2.8, 0.45, 0.06, 0, 1.25, -3.6, DARK), ...[0, 1, 2, 3].map((k) => box(2.6, 0.04, 0.06, 0, 1.08 + k * 0.1, -3.63, STEEL)), // turbine exhaust
      ...mirror([
        ...tracks({ x: 1.45, w: 0.6, zs: [-2.55, -1.6, -0.6, 0.38, 1.38, 2.36], r: 0.4, zRear: -3.2, zFront: 3.1, top: 0.85, rollers: [-2.1, -0.1, 1.9], hullY: 0.9 }),
        ...skirt(1.82, -3.35, 3.4, 0.72, 1.1, { era: [1.2, 3.3] }),
        ...lamp(1.25, 1.24, 3.52), box(0.04, 0.2, 0.9, 1.86, 0.9, -0.8, TEAM),
        ...bin(1.5, 1.78, -0.9, 0.48, 0.3, 1.4), ...bin(1.5, 1.78, 0.8, 0.48, 0.3, 0.9), ...towCable(1.62, 1.64, -2.5, -1.4),
        tubeZ(0.26, 0.26, -3.2, -2.4, 1.0, 1.95, 12, PAINT), // fuel drum
      ]),
      tubeX(0.12, 3.1, 0, 1.68, -3.0, 8, WOOD),
    ],
    mounts: {
      0: {
        yaw: [
          top([[1.25, 0.7], [1.3, -0.1], [1.15, -0.85], [0.8, -1.4], [0.35, -1.6], [-0.35, -1.6], [-0.8, -1.4], [-1.15, -0.85], [-1.3, -0.1], [-1.25, 0.7], [-0.6, 1.1], [0.6, 1.1]], -0.47, 0.77, PAINT, 0.86),
          ...mirror([
            top([[0.32, 1.08], [1.3, 0.55], [1.5, 0.95], [0.45, 1.55]], -0.34, 0.52, PAINT, 0.95),
            top([[1.28, 0.5], [1.46, 0.9], [1.5, -0.4], [1.32, -0.6]], -0.3, 0.45, PAINT, 0.95), // horseshoe sides
            ...smokeBank(1.15, 0.14, 0.2, 4, 0.5),
            box(0.04, 0.2, 0.7, 1.28, 0.0, -0.3, TEAM),
          ]),
          box(0.36, 0.3, 0.46, 0.5, 0.45, 0.4, PAINT), box(0.26, 0.16, 0.04, 0.5, 0.47, 0.64, LENS),
          ...cupola(-0.55, 0.38, -0.45),
          tubeZ(0.11, 0.11, -1.95, -0.6, 0.9, 0.25, 10, PAINT), // snorkel
          ...bin(0, 0.05, -1.8, 1.7, 0.44, 0.42), cyl(0.014, 0.014, 2.4, 4, -0.85, 1.4, -1.2, DARK),
        ],
        pitch: [box(0.74, 0.56, 0.5, 0, 0, 0.1, PAINT), ...gun(0.3, 5.7, 0.1, 0.09, { evac: 0.5 })],
      },
      2: hmg(1.05),
    },
  }),

  /** 2S25 Sprut-SD: long low airborne hull (BMD-3 based) with seven small road wheels, boat bow and trim vane,
   * large turret with the 125 mm gun, sights and smoke dischargers. */
  lt: () => ({
    scheme: RU2,
    hull: [
      side([[-3.5, 0.5], [-3.5, 1.2], [2.7, 1.25], [3.55, 0.75], [3.3, 0.5]], 2.5, PAINT),
      side([[-3.45, 1.15], [-3.45, 1.5], [1.9, 1.52], [3.45, 0.95]], 3.05, PAINT),
      box(2.4, 0.06, 0.6, 0, 1.0, 3.42, PAINT, -0.9), box(2.3, 0.04, 0.5, 0, 0.95, 3.45, DARK, -0.9), // trim vane
      box(0.4, 0.15, 0.45, 0, 1.55, 2.3, PAINT), ...scope(0, 1.62, 2.55), ...scope(0.25, 1.6, 2.5, 0.3), ...scope(-0.25, 1.6, 2.5, -0.3),
      ...grilles(0, 1.53, -3.3, -1.9, 2.2),
      ...mirror([
        ...tracks({ x: 1.3, w: 0.42, zs: [-2.5, -1.68, -0.85, 0.0, 0.85, 1.68, 2.5], r: 0.3, zRear: -3.05, zFront: 3.1, top: 0.72, rollers: [-1.25, 0.4, 2.0], hullY: 0.8 }),
        ...skirt(1.55, -3.2, 3.2, 0.62, 0.95), ...lamp(1.05, 1.2, 3.3), box(0.04, 0.2, 0.8, 1.53, 0.85, -0.8, TEAM),
        tubeZ(0.08, 0.08, -3.6, -3.45, 0.55, 1.0, 8, DARK), // water-jet outlet
        ...bin(1.2, 1.62, -0.8, 0.4, 0.22, 1.2),
      ]),
    ],
    mounts: {
      0: {
        yaw: [
          top([[1.05, 0.95], [1.15, -0.3], [0.95, -1.25], [-0.95, -1.25], [-1.15, -0.3], [-1.05, 0.95], [-0.5, 1.2], [0.5, 1.2]], -0.57, 0.83, PAINT, 0.84),
          box(0.34, 0.3, 0.4, 0.55, 0.36, 0.55, PAINT), box(0.24, 0.15, 0.04, 0.55, 0.38, 0.76, LENS),
          box(0.3, 0.32, 0.3, -0.6, 0.38, 0.1, PAINT), sphere(0.13, -0.6, 0.58, 0.12, LENS),
          ...mirror([...smokeBank(0.98, 0.08, 0.6, 4, 0.5), box(0.04, 0.2, 0.7, 1.12, 0.0, -0.25, TEAM)]),
          ...bin(0, 0.0, -1.38, 1.6, 0.4, 0.32), cyl(0.012, 0.012, 2.0, 4, 0.8, 1.2, -1.0, DARK),
        ],
        pitch: [box(0.66, 0.5, 0.5, 0, 0, 0.1, PAINT), ...gun(0.3, 5.8, 0.095, 0.085)],
      },
    },
  }),

  /** BTR-90: 8×8 boat hull with sloped sides and bow trim vane, side doors between the second and third axles,
   * firing ports and vision blocks, BMP-2 type turret with the 30 mm gun and Konkurs launcher. */
  apc: (def) => ({
    scheme: RU2,
    doors: [1, -1].map((sd) => ({ x: sd * 1.45, y: 1.1, z: 0.42, axis: 'y', open: -sd * 1.3,
      geo: [box(0.06, 0.86, 0.82, 0, 0.43, -0.41, PAINT), box(0.07, 0.06, 0.14, sd * 0.02, 0.5, -0.68, STEEL), box(0.03, 0.08, 0.14, sd * 0.02, 0.68, -0.4, LENS),
        box(0.08, 0.12, 0.06, 0, 0.2, -0.03, DARK), box(0.08, 0.12, 0.06, 0, 0.7, -0.03, DARK)] })),
    hull: [
      side([[-3.75, 0.75], [-3.75, 1.85], [-3.4, 2.1], [1.6, 2.15], [3.6, 1.55], [3.85, 1.05], [3.5, 0.75]], 2.9, PAINT),
      front([[-1.45, 1.4], [1.45, 1.4], [1.25, 2.12], [-1.25, 2.12]], -3.6, 1.6, PAINT),
      box(2.6, 0.06, 0.7, 0, 1.25, 3.7, PAINT, -0.9), ...[0, 1].map((k) => box(2.4, 0.03, 0.04, 0, 1.15 + k * 0.2, 3.75, DARK, -0.9)), // trim vane
      ...[[0.55, 2.6], [-0.55, 2.6]].map(([x, z]) => [box(0.5, 0.1, 0.5, x, 2.14, z, PAINT), cyl(0.2, 0.2, 0.05, 10, x, 2.2, z, DARK), ...scope(x, 2.24, z + 0.25)]).flat(),
      ...[-0.6, -1.8, -2.8].flatMap((z) => mirror([box(0.55, 0.08, 0.55, 0.5, 2.16, z, PAINT)])), // troop hatches
      ...grilles(0, 2.16, -3.3, -2.9, 1.8),
      ...mirror([
        box(0.03, 0.92, 0.88, 1.425, 1.55, 0.0, DARK), // side door opening
        ...[1.8, -1.0, -2.2, -3.0].map((z) => box(0.04, 0.1, 0.1, 1.45, 1.75, z, DARK)), ...[1.4, -1.6, -2.6].map((z) => box(0.03, 0.08, 0.16, 1.45, 1.95, z, LENS)),
        ...lamp(1.1, 1.7, 3.55), box(0.04, 0.3, 0.8, 1.45, 1.6, -1.6, TEAM),
        ...[2.45, 0.95, -0.95, -2.45].map((z) => box(0.35, 0.08, 1.35, 1.3, 1.32, z, DARK)), // wheel arches
        box(0.1, 0.15, 0.2, 0.8, 0.9, -3.8, DARK), ...towCable(1.38, 2.0, -3.4, -2.0),
      ]),
    ],
    mounts: {
      0: {
        yaw: [
          top([[0.85, 0.55], [0.95, -0.45], [0.6, -0.9], [-0.6, -0.9], [-0.95, -0.45], [-0.85, 0.55], [-0.3, 0.8], [0.3, 0.8]], -0.41, 0.51, PAINT, 0.82),
          box(0.3, 0.24, 0.3, 0.45, 0.2, 0.35, PAINT), box(0.2, 0.12, 0.04, 0.45, 0.22, 0.52, LENS), ...cupola(-0.35, 0.12, -0.2, 0.3),
          box(0.12, 0.25, 0.12, -0.15, 0.25, -0.5, DARK), ...mirror([...smokeBank(0.85, -0.05, 0.1, 3, 0.4)]),
          // Konkurs launcher on the roof
          box(0.1, 0.25, 0.1, 0, 0.25, 0.1, DARK), tubeZ(0.08, 0.08, -0.6, 0.6, 0, 0.42, 10, 0x5c6a3f),
        ],
        pitch: [box(0.42, 0.3, 0.35, 0, 0, 0.1, PAINT), tubeZ(0.05, 0.045, 0.3, 3.0, 0, 0, 10, STEEL), tubeZ(0.065, 0.065, 0.3, 0.85, 0, 0, 10, PAINT),
          ...[1.4, 2.0].map((z) => tubeZ(0.058, 0.058, z, z + 0.06, 0, 0, 10, DARK)), tubeZ(0.06, 0.06, 2.88, 3.02, 0, 0, 10, DARK), tubeZ(0.02, 0.02, 0.3, 0.8, -0.18, -0.02, 6, DARK)],
      },
    },
    wheel: wheelGeo(def.wheelRadius, 0.42, 16, RUBBER, PAINT, 0.55),
  }),

  /** BMP-2: low hull with the ribbed upper glacis, trim vane, six road wheels, two-man turret with the long 2A42,
   * Konkurs launcher, troop hatches on the roof and the rear doors (fuel tanks). */
  ifv: () => ({
    scheme: RU2,
    doors: [1, -1].map((sd) => ({ x: sd * 0.98, y: 0.62, z: -3.37, axis: 'y', open: -sd * 1.55,
      geo: [box(0.9, 0.9, 0.22, -sd * 0.47, 0.45, -0.1, PAINT), box(0.8, 0.8, 0.02, -sd * 0.47, 0.45, -0.22, DARK), box(0.05, 0.12, 0.05, -sd * 0.85, 0.5, -0.24, STEEL),
        box(0.14, 0.08, 0.03, -sd * 0.47, 0.7, -0.23, LENS), ...[0.15, 0.75].map((y) => box(0.08, 0.1, 0.08, -sd * 0.04, y, -0.12, DARK))] })),
    hull: [
      side([[-3.35, 0.45], [-3.35, 1.62], [0.85, 1.65], [3.35, 0.95], [3.1, 0.45]], 3.0, PAINT),
      ...[0.45, 0.85, 1.25, 1.65, 2.05, 2.45, 2.85].map((z) => box(2.7, 0.04, 0.08, 0, 1.65 - (z - 0.85) * 0.28, z, DARK, 0.27)), // glacis ribs
      box(2.7, 0.05, 0.55, 0, 1.0, 3.25, PAINT, -0.75), // trim vane folded
      box(0.45, 0.1, 0.5, 0.55, 1.6, 1.75, PAINT), cyl(0.22, 0.22, 0.05, 10, 0.55, 1.66, 1.75, DARK), ...scope(0.55, 1.7, 2.0), ...scope(0.25, 1.62, 1.95),
      ...grilles(-0.6, 1.66, 0.9, 1.9, 0.9),
      ...[-1.1, -2.2].flatMap((z) => mirror([box(0.65, 0.08, 0.85, 0.45, 1.66, z, PAINT), box(0.05, 0.05, 0.3, 0.45, 1.72, z, DARK)])), // troop hatches
      ...mirror([
        ...tracks({ x: 1.27, w: 0.38, zs: [-2.3, -1.45, -0.55, 0.35, 1.25, 2.15], r: 0.36, zRear: -3.0, zFront: 3.0, top: 0.8, rollers: [-1.7, 0.0, 1.6], hullY: 0.85, front: true }),
        box(0.08, 0.12, 6.4, 1.5, 0.92, 0, PAINT), // track guard
        ...[-0.5, -1.4, -2.3].map((z) => box(0.04, 0.12, 0.12, 1.5, 1.35, z, DARK)), ...[-0.9, -1.8].map((z) => box(0.03, 0.08, 0.16, 1.5, 1.5, z, LENS)), // firing ports, vision blocks
        ...lamp(1.15, 1.15, 3.18), box(0.04, 0.25, 0.8, 1.51, 1.2, 0.5, TEAM),
        ...towCable(1.35, 1.66, -0.4, 0.6),
      ]),
    ],
    mounts: {
      0: {
        yaw: [
          top([[0.9, 0.6], [1.0, -0.45], [0.65, -0.95], [-0.65, -0.95], [-1.0, -0.45], [-0.9, 0.6], [-0.35, 0.85], [0.35, 0.85]], -0.46, 0.59, PAINT, 0.8),
          box(0.3, 0.24, 0.32, 0.45, 0.22, 0.32, PAINT), box(0.2, 0.12, 0.04, 0.45, 0.24, 0.5, LENS), ...cupola(-0.38, 0.12, -0.25, 0.3),
          ...mirror([...smokeBank(0.9, -0.05, 0.1, 3, 0.4)]), box(0.12, 0.32, 0.12, -0.2, 0.28, -0.55, DARK),
          box(0.1, 0.28, 0.1, 0, 0.28, 0.05, DARK), tubeZ(0.08, 0.08, -0.65, 0.6, 0, 0.47, 10, 0x5c6a3f), tubeZ(0.085, 0.085, 0.55, 0.62, 0, 0.47, 10, DARK), // Konkurs
          cyl(0.012, 0.012, 1.8, 4, -0.7, 0.9, -0.7, DARK),
        ],
        pitch: [box(0.4, 0.3, 0.35, 0, 0, 0.1, PAINT), tubeZ(0.05, 0.045, 0.3, 3.05, 0, 0, 10, STEEL), tubeZ(0.065, 0.065, 0.3, 0.9, 0, 0, 10, PAINT),
          ...[1.5, 2.1].map((z) => tubeZ(0.058, 0.058, z, z + 0.06, 0, 0, 10, DARK)), tubeZ(0.065, 0.065, 2.9, 3.05, 0, 0, 10, DARK), tubeZ(0.02, 0.02, 0.3, 0.8, -0.18, -0.02, 6, DARK)],
      },
    },
  }),

  /** Kurganets-25: tall slab-sided hull with spaced armour screens, long glacis, seven road wheels, Bumerang-BM
   * unmanned module (30 mm, twin Kornet pairs), rear ramp. */
  ifv2: () => ({
    scheme: { base: [0x8a8064, 0x56613b, 0x2f312a], scale: 2.0 },
    doors: [{ x: 0, y: 0.52, z: -3.6, axis: 'x', open: -1.45,
      geo: [box(1.75, 1.45, 0.1, 0, 0.73, 0, PAINT), box(1.6, 0.04, 0.12, 0, 1.4, -0.01, DARK), box(0.6, 0.12, 0.05, 0, 1.2, -0.06, TEAM),
        ...[-0.6, -0.2, 0.2, 0.6].map((x) => box(0.05, 1.3, 0.05, x, 0.7, 0.06, DARK)), box(0.1, 0.15, 0.08, 0.8, 1.3, -0.06, STEEL)] }],
    hull: [
      side([[-3.55, 0.48], [-3.55, 2.22], [1.2, 2.22], [3.62, 1.32], [3.62, 1.0], [3.3, 0.48]], 2.9, PAINT),
      ...[2.0, 2.45, 2.9].map((z) => box(2.7, 0.04, 0.06, 0, 2.22 - (z - 1.2) * 0.37, z, DARK, 0.36)),
      box(0.9, 0.1, 0.9, 0.55, 2.25, 1.7, PAINT), cyl(0.32, 0.32, 0.06, 10, 0.55, 2.3, 1.7, DARK), ...scope(0.55, 2.36, 2.1), ...scope(0.2, 2.3, 1.95),
      box(1.2, 0.08, 1.2, 0, 2.24, -2.6, DARK), ...[-2.2, -3.0].map((z) => box(0.9, 0.08, 0.6, -0.6, 2.25, z, PAINT)),
      box(1.85, 1.55, 0.03, 0, 1.25, -3.555, DARK), // ramp opening
      ...grilles(0.6, 2.24, 0.0, 1.0, 0.9),
      ...mirror([
        side([[-3.45, 0.62], [-3.45, 2.0], [1.15, 2.0], [3.15, 1.25], [3.3, 0.85], [3.1, 0.62]], 0.12, PAINT, 1.55),
        ...[-2.6, -1.4, -0.2, 1.0, 2.2].map((z) => box(0.03, 1.3, 0.05, 1.62, 1.3, z, DARK)),
        ...[-2.0, -0.8, 0.4].map((z) => box(0.03, 0.05, 0.05, 1.63, 1.85, z, STEEL)), box(0.04, 0.32, 1.1, 1.63, 1.55, -1.0, TEAM),
        ...tracks({ x: 1.32, w: 0.5, zs: [-2.7, -1.82, -0.94, -0.06, 0.82, 1.7, 2.58], r: 0.36, zRear: -3.25, zFront: 3.15, top: 0.86, rollers: [-2.25, -0.5, 1.25], hullY: 0.9, front: true }),
        ...lamp(1.15, 1.3, 3.55), box(0.12, 0.12, 0.08, 1.35, 2.0, 1.25, LENS),
        box(0.05, 0.55, 0.06, 1.47, 2.5, -3.2, DARK),
      ]),
      cyl(0.012, 0.012, 2.2, 4, 1.47, 3.6, -3.2, DARK),
    ],
    mounts: {
      0: {
        yaw: [
          top([[1.0, 1.05], [1.05, -0.9], [0.75, -1.15], [-0.75, -1.15], [-1.05, -0.9], [-1.0, 1.05], [-0.5, 1.3], [0.5, 1.3]], 0, 0.5, PAINT, 0.88),
          box(0.36, 0.42, 0.4, -0.55, 0.65, 0.1, PAINT), sphere(0.16, -0.55, 0.9, 0.12, LENS),
          box(0.3, 0.26, 0.3, 0.55, 0.6, 0.7, PAINT), box(0.22, 0.14, 0.04, 0.55, 0.62, 0.86, LENS),
          ...mirror([...smokeBank(1.0, 0.3, 0.4, 3, 0.4),
            box(0.24, 0.42, 1.5, 1.2, 0.35, -0.1, PAINT), ...[0.12, -0.12].flatMap((y) => [tubeZ(0.08, 0.08, -0.85, 0.7, 1.2, 0.35 + y, 8, PAINT), tubeZ(0.09, 0.09, 0.62, 0.7, 1.2, 0.35 + y, 8, DARK)])]),
          box(0.6, 0.06, 0.4, 0, 0.52, -0.8, TEAM),
        ],
        pitch: [box(0.5, 0.36, 0.6, 0, 0, 0.1, PAINT), tubeZ(0.07, 0.065, 0.3, 1.1, 0, 0, 10, PAINT), tubeZ(0.04, 0.036, 1.1, 2.9, 0, 0, 10, STEEL),
          tubeZ(0.055, 0.055, 2.75, 3.0, 0, 0, 10, DARK), ...[1.6, 2.2].map((z) => tubeZ(0.05, 0.05, z, z + 0.06, 0, 0, 10, DARK)), tubeZ(0.022, 0.022, 0.2, 0.7, -0.24, -0.04, 6, DARK)],
      },
    },
  }),

  /** BRDM-2: boat hull with a sharp bow, armoured flaps over the windscreens, BPU-1 cone turret (KPVT + PKT), side
   * belly wheels between the axles, side hatches, aerial. */
  brdm: (def) => ({
    scheme: RU2,
    hull: [
      side([[-2.85, 0.55], [-2.85, 1.55], [-2.6, 1.75], [1.4, 1.8], [2.2, 1.45], [2.9, 1.0], [2.6, 0.55]], 2.2, PAINT),
      front([[-1.12, 1.55], [1.12, 1.55], [0.85, 1.95], [-0.85, 1.95]], -2.6, 1.4, PAINT),
      ...mirror([
        box(0.52, 0.27, 0.06, 0.42, 1.68, 1.86, PAINT, -0.6), box(0.42, 0.12, 0.03, 0.42, 1.7, 1.83, GLASS, -0.6), box(0.5, 0.05, 0.08, 0.42, 1.83, 1.8, DARK, -0.6), // screen + flap
        box(0.44, 0.22, 1.25, 1.02, 1.12, 1.4, PAINT), box(0.44, 0.22, 1.25, 1.02, 1.12, -1.73, PAINT),
        tubeX(0.28, 0.2, 0.75, 0.42, -0.45, 12, RUBBER), tubeX(0.28, 0.2, 0.75, 0.42, 0.35, 12, RUBBER), tubeX(0.16, 0.22, 0.75, 0.42, -0.05, 8, DARK),
        ...lamp(0.8, 1.32, 2.55), box(0.05, 0.4, 0.8, 1.12, 1.5, -0.3, PAINT, 0, 0, -0.35), box(0.06, 0.06, 0.12, 1.14, 1.55, -0.6, STEEL),
        box(0.04, 0.24, 0.6, 1.14, 1.35, -1.0, TEAM), ...[0.6, -0.9].map((z) => box(0.04, 0.08, 0.1, 1.1, 1.4, z, DARK)),
      ]),
      box(1.1, 0.06, 0.9, 0, 1.78, -2.0, DARK), ...[-1.7, -2.0, -2.3].map((z) => box(1.0, 0.04, 0.06, 0, 1.82, z, STEEL)),
      box(1.6, 0.05, 0.4, 0, 1.1, 2.75, PAINT, 0.9), cyl(0.012, 0.012, 1.8, 4, -0.8, 2.6, -2.2, DARK), ...towCable(-0.9, 1.78, -1.6, -0.4),
    ],
    mounts: {
      0: {
        yaw: [cone(0.52, 0.55, 10, 0, 0.15, 0, PAINT), cyl(0.56, 0.58, 0.2, 10, 0, -0.06, 0, PAINT), box(0.14, 0.12, 0.06, 0.22, 0.32, 0.36, LENS), box(0.1, 0.1, 0.1, -0.2, 0.42, -0.2, DARK)],
        pitch: [box(0.24, 0.22, 0.4, 0, 0, 0.1, PAINT), tubeZ(0.045, 0.04, 0.3, 1.4, 0, 0, 10, STEEL), tubeZ(0.06, 0.06, 1.25, 1.42, 0, 0, 10, DARK), tubeZ(0.065, 0.065, 0.3, 0.55, 0, 0, 10, PAINT),
          tubeZ(0.02, 0.02, 0.3, 0.75, 0.2, -0.02, 6, DARK)],
      },
    },
    wheel: wheelGeo(def.wheelRadius, 0.34, 16, RUBBER, PAINT, 0.55),
  }),

  /** 2S19 Msta-S: T-80 based hull, very large boxy turret with the 152 mm gun (muzzle brake, evacuator), loader's
   * cupola with a Kord, ammunition conveyor door at the rear, stowage boxes. */
  howitzer: () => ({
    scheme: RU2,
    hull: [
      side([[-3.35, 0.45], [-3.35, 1.1], [3.3, 1.1], [2.95, 0.45]], 2.3, PAINT),
      side([[-3.4, 1.05], [-3.4, 1.45], [-3.25, 1.6], [2.1, 1.6], [3.4, 1.05]], 3.4, PAINT),
      box(0.42, 0.22, 0.46, 0, 1.62, 2.05, PAINT), cyl(0.25, 0.27, 0.08, 10, 0, 1.68, 2.05, DARK), ...scope(0, 1.73, 2.3),
      box(3.0, 0.24, 0.12, 0, 0.62, 3.32, PAINT), ...grilles(0, 1.62, -3.25, -2.2, 2.4),
      ...mirror([
        ...tracks({ x: 1.38, w: 0.58, zs: [-2.45, -1.48, -0.5, 0.48, 1.45, 2.42], r: 0.37, zRear: -3.0, zFront: 2.95, top: 0.82, rollers: [-2.0, -0.2, 1.6], hullY: 0.85 }),
        ...skirt(1.73, -3.2, 3.15, 0.7, 1.08), ...lamp(1.2, 1.22, 3.32), ...bin(1.45, 1.75, 1.2, 0.48, 0.28, 0.9), ...towCable(1.58, 1.62, -1.2, 0.2),
      ]),
    ],
    mounts: {
      0: {
        yaw: [
          side([[-2.3, -0.76], [-2.3, 1.15], [1.35, 1.2], [1.75, 0.75], [1.8, -0.76]], 2.9, PAINT), cyl(1.25, 1.3, 0.2, 16, 0, -0.68, -0.2, DARK),
          box(2.95, 0.06, 0.05, 0, 0.95, 1.6, DARK),
          ...mirror([box(0.05, 0.9, 1.6, 1.46, 0.35, -0.4, DARK), box(0.06, 0.4, 0.6, 1.47, 0.5, 0.6, PAINT), box(0.06, 0.06, 0.14, 1.5, 0.55, 0.4, STEEL),
            ...smokeBank(1.35, 0.85, 1.45, 4, 0.5), box(0.04, 0.3, 0.9, 1.47, 0.2, -1.3, TEAM)]),
          box(0.8, 0.5, 0.06, 0, 0.4, -2.33, DARK), // ammunition conveyor door
          box(0.36, 0.3, 0.4, 0.62, 1.32, 0.5, PAINT), box(0.26, 0.14, 0.04, 0.62, 1.34, 0.71, LENS),
          ...cupola(-0.8, 1.25, -0.75, 0.34),
          ...bin(0, 1.25, -1.6, 1.8, 0.2, 0.9), cyl(0.012, 0.012, 2.2, 4, 0.95, 2.3, -1.6, DARK),
        ],
        pitch: [box(0.85, 0.7, 0.6, 0, 0, 0.1, PAINT), ...gun(0.35, 6.3, 0.12, 0.1, { evac: 0.42, mrs: false }),
          ...[-1, 1].map((s) => box(0.06, 0.32, 0.5, s * 0.17, 0, 6.5, DARK)), box(0.4, 0.06, 0.5, 0, 0.17, 6.5, DARK), box(0.4, 0.06, 0.5, 0, -0.17, 6.5, DARK)], // muzzle brake
      },
      1: hmg(1.05),
    },
  }),

  /** ZSU-23-4 Shilka: light tracked hull with six road wheels, large flat-sided turret with four 23 mm guns in a
   * mantlet, Tobol radar dish on its mast at the turret rear, ammunition boxes and sight. */
  spaag: () => ({
    scheme: RU2,
    hull: [
      side([[-3.25, 0.45], [-3.25, 1.35], [2.4, 1.42], [3.25, 0.85], [3.05, 0.45]], 2.65, PAINT),
      box(0.45, 0.12, 0.5, 0.5, 1.42, 2.2, PAINT), cyl(0.2, 0.2, 0.05, 10, 0.5, 1.49, 2.2, DARK), ...scope(0.5, 1.55, 2.45), ...scope(0.2, 1.48, 2.4),
      ...grilles(0, 1.43, -3.0, -1.8, 2.0),
      ...mirror([
        ...tracks({ x: 1.22, w: 0.38, zs: [-2.3, -1.38, -0.46, 0.46, 1.38, 2.3], r: 0.33, zRear: -2.85, zFront: 2.9, top: 0.74, rollers: [-1.8, 0.0, 1.8], hullY: 0.8 }),
        box(0.3, 0.1, 6.0, 1.45, 0.86, 0, PAINT), ...lamp(1.05, 1.12, 3.1), box(0.04, 0.25, 0.8, 1.335, 1.15, -1.0, TEAM),
        ...bin(1.25, 1.52, 0.6, 0.38, 0.22, 1.2),
      ]),
    ],
    mounts: {
      0: {
        yaw: [
          side([[-1.6, -0.57], [-1.6, 0.6], [0.8, 0.62], [1.15, 0.3], [1.2, -0.57]], 2.85, PAINT),
          ...mirror([box(0.05, 0.5, 2.2, 1.43, 0.15, -0.4, DARK), box(0.42, 0.3, 0.9, 1.2, 0.0, 0.3, PAINT), box(0.05, 0.08, 0.14, 1.45, 0.1, -0.9, STEEL),
            box(0.04, 0.25, 0.8, 1.44, 0.3, -0.6, TEAM)]),
          box(0.3, 0.28, 0.32, -0.6, 0.72, 0.2, PAINT), box(0.2, 0.12, 0.04, -0.6, 0.74, 0.37, LENS),
          box(0.18, 0.7, 0.18, 0, 0.95, -1.35, DARK), // radar mast
          cyl(0.6, 0.6, 0.1, 14, 0, 1.35, -1.25, PAINT, Math.PI / 2 - 0.25), cyl(0.5, 0.5, 0.04, 14, 0, 1.36, -1.19, 0x5d6558, Math.PI / 2 - 0.25), box(0.06, 0.06, 0.5, 0, 1.36, -1.0, DARK),
        ],
        pitch: [box(1.3, 0.5, 0.55, 0, 0, 0.1, PAINT), ...[-0.42, 0.42].flatMap((x) => [0.12, -0.12].flatMap((y) => [tubeZ(0.035, 0.03, 0.3, 2.3, x, y, 8, STEEL), tubeZ(0.05, 0.05, 0.3, 0.75, x, y, 8, PAINT), tubeZ(0.045, 0.045, 2.15, 2.32, x, y, 8, DARK)]))],
      },
    },
  }),
};
