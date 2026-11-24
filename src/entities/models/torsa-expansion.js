import * as THREE from 'three';
import {
  PAINT, PAINT2, TEAM, DARK, STEEL, RUBBER, TRACK, GLASS, LENS, CANVAS,
  box, cyl, tubeZ, tubeX, sphere, cone, side, top, front, mirror, place, fuselage, rotorGeo, runningGear, wheelGeo, star,
} from './kit.js';

/**
 * Torsa expansion (Milestone 1), hand-built from the reference blueprints. Every model is authored in ground
 * coordinates (y = 0 on the ground at rest, +Z forward, +X to the vehicle's left), sized from the drawings'
 * dimensions; turret / launcher / gun parts are authored relative to their pivots (see vehicle-defs.js).
 */

const OLIVE = [0x4f5b33];
const KURG_CAMO = { base: [0x8a8064, 0x56613b, 0x2f312a], scale: 2.0 };
const AIR_GREY = { base: [0x7b8483, 0x5f6866], belly: 0xa9b6bd, scale: 3.4 };
const LAMP = 0xfff0c0, RED_LENS = 0x7a1f1a, CRATE = 0x5b6236, CRATE2 = 0x6e6a45, KHAKI = 0x7b7350;

// ------------------------------------------------------------------ shared parts

/** Cab-over truck cab (KamAZ family): body, windscreen, side windows, grille, bumper, lamps, mirrors, sun visor. */
function cabOver(zB, zF, y0, y1, w, o = {}) {
  const hw = w / 2;
  const p = [
    side([[zB, y0], [zB, y1], [zF - 0.35, y1], [zF - 0.05, y1 - 0.5], [zF, y0 + 0.5], [zF, y0]], w, PAINT),
    box(w - 0.32, 0.66, 0.05, 0, y1 - 0.62, zF - 0.17, GLASS, -0.28),
    ...mirror([
      box(0.04, 0.52, 0.72, hw + 0.005, y1 - 0.62, zF - 0.72, GLASS), // door window
      box(0.05, 0.9, 0.04, hw + 0.01, y0 + 0.55, zB + 0.05, DARK), // door seam
      box(0.3, 0.16, 0.06, hw - 0.32, y0 + 0.3, zF + 0.03, LAMP), box(0.12, 0.1, 0.05, hw - 0.12, y0 + 0.3, zF + 0.03, 0xd08a2a),
      box(0.06, 0.36, 0.2, hw + 0.3, y1 - 0.55, zF - 0.3, DARK), box(0.36, 0.04, 0.04, hw + 0.13, y1 - 0.42, zF - 0.3, DARK), // mirror
      box(0.38, 0.06, 0.38, hw - 0.22, y0 - 0.05, zF - 0.38, DARK), // step
      box(0.04, 0.32, 0.6, hw + 0.012, y0 + 0.62, zF - 0.85, TEAM),
    ]),
    box(w - 0.6, 0.42, 0.05, 0, y0 + 0.5, zF + 0.02, DARK), ...[0, 1, 2].map((i) => box(w - 0.7, 0.04, 0.06, 0, y0 + 0.36 + i * 0.13, zF + 0.04, STEEL)),
    box(w + 0.12, 0.24, 0.26, 0, y0 + 0.02, zF + 0.1, STEEL), // bumper
    box(w - 0.2, 0.08, 0.3, 0, y1 + 0.02, zF - 0.2, PAINT), // sun visor
  ];
  if (o.sleeper) p.push(side([[zB - 0.7, y0 + 0.1], [zB - 0.7, y1 - 0.15], [zB, y1 - 0.15], [zB, y0 + 0.1]], w - 0.08, PAINT));
  if (o.hatch) p.push(cyl(0.38, 0.38, 0.1, 10, o.hatch[0], y1 + 0.05, o.hatch[1], DARK));
  return p;
}

/** Ladder chassis rails with fuel tanks, battery box and mudguards over the given wheel stations. */
function chassis(z0, z1, y, wheelZs, w, r) {
  const p = [box(0.95, 0.3, z1 - z0, 0, y, (z0 + z1) / 2, DARK)];
  for (const z of wheelZs) p.push(...mirror([box(0.32, 0.06, r * 2 + 0.3, w / 2 - 0.16, r * 2 + 0.12, z, DARK), box(0.06, 0.3, 0.08, w / 2 - 0.02, r * 2, z - r - 0.1, DARK)]));
  return p;
}

/** Drop-side cargo bed: floor, sides with stake pockets, tailgate. */
function cargoBed(z0, z1, y, w, hSide) {
  const L = z1 - z0, zc = (z0 + z1) / 2;
  const p = [box(w, 0.14, L, 0, y, zc, PAINT), box(w, hSide, 0.06, 0, y + hSide / 2 + 0.07, z0 + 0.03, PAINT), box(w, hSide, 0.06, 0, y + hSide / 2 + 0.07, z1 - 0.03, PAINT)];
  p.push(...mirror([box(0.06, hSide, L, w / 2 - 0.03, y + hSide / 2 + 0.07, zc, PAINT)]));
  for (let z = z0 + 0.6; z < z1 - 0.3; z += 1.1) p.push(...mirror([box(0.08, hSide + 0.04, 0.08, w / 2, y + hSide / 2 + 0.07, z, STEEL)]));
  p.push(...mirror([box(0.04, 0.06, L - 0.2, w / 2 + 0.01, y + hSide * 0.55, zc, DARK)]));
  return p;
}

/** Stack of supply crates and ammunition boxes (seeded layout). */
function crates(z0, z1, y, w, rows, seed = 1) {
  const p = [];
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let z = z0 + 0.4; z < z1 - 0.35; z += 0.8) for (let x = -w / 2 + 0.4; x < w / 2 - 0.3; x += 0.75) {
    const n = 1 + Math.floor(rnd() * rows);
    for (let k = 0; k < n; k++) p.push(box(0.68, 0.42, 0.72, x, y + 0.21 + k * 0.43, z, rnd() > 0.5 ? CRATE : CRATE2));
    if (rnd() > 0.6) p.push(box(0.5, 0.05, 0.12, x, y + n * 0.43 + 0.01, z, TEAM));
  }
  return p;
}

/** Remote / pintle heavy MG (Kord) with shield: { yaw, pitch } parts. */
function kordMount(shield = true, ring = 0.42) {
  return {
    yaw: [cyl(ring, ring, 0.12, 12, 0, -0.18, 0, DARK), box(0.1, 0.36, 0.1, 0, -0.02, 0, DARK),
      ...(shield ? [box(0.9, 0.5, 0.05, 0, 0.05, 0.32, PAINT), ...mirror([box(0.05, 0.42, 0.32, 0.45, 0.05, 0.16, PAINT, 0, 0.5, 0)])] : [])],
    pitch: [box(0.13, 0.16, 0.85, 0, 0, 0.2, DARK), box(0.16, 0.2, 0.24, 0.16, -0.05, 0.05, CRATE), tubeZ(0.026, 0.022, 0.6, 1.45, 0, 0.03, 6, STEEL), tubeZ(0.042, 0.042, 1.36, 1.46, 0, 0.03, 6, DARK)],
  };
}

/** Twin-pair Kornet launcher on a pedestal: { yaw, pitch }. */
function kornetMount() {
  const tube = (x, y) => [tubeZ(0.09, 0.09, -0.5, 1.25, x, y, 8, PAINT), tubeZ(0.1, 0.1, 1.15, 1.25, x, y, 8, DARK)];
  return {
    yaw: [cyl(0.4, 0.45, 0.3, 10, 0, -0.35, 0, PAINT), box(0.5, 0.55, 0.5, 0, 0.05, -0.1, PAINT), box(0.3, 0.2, 0.05, 0, 0.12, 0.16, LENS)],
    pitch: [box(0.3, 0.3, 0.6, 0, 0, 0.1, DARK), ...mirror([...tube(0.42, 0.12), ...tube(0.42, -0.12), box(0.08, 0.5, 0.3, 0.28, 0, 0.2, DARK)])],
  };
}

const truckWheel = (r, w) => wheelGeo(r, w, 14, RUBBER, PAINT, 0.55);

// ------------------------------------------------------------------ models

export const EXPANSION_MODELS = {
  /** Kurganets-25 IFV (Object 695): tall slab-sided hull with spaced side screens, long shallow glacis, seven road
   * wheels, low Bumerang-BM unmanned module amidships with 30 mm gun and twin Kornet pairs, big rear ramp. */
  ifv2: () => ({
    scheme: KURG_CAMO,
    hull: [
      side([[-3.55, 0.48], [-3.55, 2.22], [1.2, 2.22], [3.62, 1.32], [3.62, 1.0], [3.3, 0.48]], 2.9, PAINT),
      ...mirror([
        side([[-3.45, 0.62], [-3.45, 2.0], [1.15, 2.0], [3.15, 1.25], [3.3, 0.85], [3.1, 0.62]], 0.12, PAINT, 1.55), // spaced side screens
        ...[-2.6, -1.4, -0.2, 1.0, 2.2].map((z) => box(0.03, 1.3, 0.05, 1.62, 1.3, z, DARK)), // screen panel seams
        box(0.04, 0.32, 1.1, 1.63, 1.55, -1.0, TEAM),
        ...runningGear({ x: 1.32, w: 0.5, zs: [-2.7, -1.82, -0.94, -0.06, 0.82, 1.7, 2.58], r: 0.36, zRear: -3.25, zFront: 3.15, top: 0.86, sprocketY: 0.62, idlerY: 0.58, rollers: [-2.25, -0.5, 1.25] }),
        box(0.22, 0.14, 0.06, 1.15, 1.3, 3.6, LAMP), box(0.12, 0.12, 0.08, 1.35, 2.0, 1.25, LENS),
        box(0.05, 0.55, 0.06, 1.47, 2.5, -3.2, DARK), // aerial base
      ]),
      ...[2.0, 2.45, 2.9].map((z) => box(2.7, 0.04, 0.06, 0, 2.22 - (z - 1.2) * 0.37, z, DARK, 0.36)), // glacis ribs
      box(0.9, 0.1, 0.9, 0.55, 2.25, 1.7, PAINT), cyl(0.32, 0.32, 0.06, 10, 0.55, 2.3, 1.7, DARK), // driver's hatch
      box(1.2, 0.08, 1.2, 0, 2.24, -2.6, DARK), ...[-2.2, -3.0].map((z) => box(0.9, 0.08, 0.6, -0.6, 2.25, z, PAINT)), // troop hatches
      box(1.6, 1.4, 0.08, 0, 1.25, -3.58, PAINT), box(0.6, 0.12, 0.05, 0, 1.75, -3.62, TEAM), // rear ramp
      cyl(0.012, 0.012, 2.2, 4, 1.47, 3.6, -3.2, DARK),
    ],
    mounts: {
      0: {
        yaw: [
          top([[1.0, 1.05], [1.05, -0.9], [0.75, -1.15], [-0.75, -1.15], [-1.05, -0.9], [-1.0, 1.05], [-0.5, 1.3], [0.5, 1.3]], 0, 0.5, PAINT, 0.88),
          box(0.36, 0.42, 0.4, -0.55, 0.65, 0.1, PAINT), sphere(0.16, -0.55, 0.9, 0.12, LENS), // commander's panoramic sight
          box(0.3, 0.26, 0.3, 0.55, 0.6, 0.7, PAINT), box(0.22, 0.14, 0.04, 0.55, 0.62, 0.86, LENS), // gunner's sight
          ...mirror(Array.from({ length: 3 }, (_, i) => cyl(0.05, 0.05, 0.22, 6, 1.02, 0.25 + i * 0.1, 0.4, DARK, Math.PI / 2 - 0.5, 0.6, 0))),
          ...mirror([box(0.24, 0.42, 1.5, 1.2, 0.35, -0.1, PAINT), ...[0.12, -0.12].flatMap((y) => [tubeZ(0.08, 0.08, -0.85, 0.7, 1.2, 0.35 + y, 8, PAINT), tubeZ(0.09, 0.09, 0.62, 0.7, 1.2, 0.35 + y, 8, DARK)])]), // Kornet pairs
          box(0.6, 0.06, 0.4, 0, 0.52, -0.8, TEAM),
        ],
        pitch: [box(0.5, 0.36, 0.6, 0, 0, 0.1, PAINT), tubeZ(0.07, 0.065, 0.3, 1.1, 0, 0, 8, PAINT), tubeZ(0.04, 0.036, 1.1, 2.9, 0, 0, 8, STEEL),
          tubeZ(0.055, 0.055, 2.75, 3.0, 0, 0, 8, DARK), tubeZ(0.022, 0.022, 0.2, 0.7, -0.24, -0.04, 6, DARK)],
      },
    },
  }),

  /** AT-CST: KamAZ-44108 4×4 with sleeper cab, drop-side bed of supply crates and a twin-Kornet launcher at the rear. */
  atcst: () => ({
    scheme: { base: OLIVE },
    hull: [
      ...chassis(-3.55, 3.4, 1.05, [2.55, -1.75], 2.5, 0.6),
      ...cabOver(1.95, 3.65, 1.25, 3.05, 2.45, { sleeper: true }),
      ...cargoBed(-3.6, 1.0, 1.42, 2.45, 0.55),
      ...crates(-1.6, 1.0, 1.5, 2.3, 2, 3),
      box(1.7, 0.18, 1.4, 0, 1.6, -2.75, DARK), // launcher base plate
      tubeX(0.6, 0.42, 0.9, 1.75, 1.3, 12, RUBBER), tubeX(0.32, 0.44, 0.9, 1.75, 1.3, 8, PAINT), // spare wheel
      ...mirror([tubeZ(0.26, 0.26, -0.9, 0.3, 1.05, 1.0, 10, PAINT), box(0.05, 0.32, 0.7, 1.24, 1.82, -2.9, TEAM)]),
      cyl(0.07, 0.07, 1.3, 6, -1.05, 2.9, 1.85, DARK),
    ],
    mounts: { 0: kornetMount() },
    wheel: truckWheel(0.6, 0.48),
  }),

  /** CST: KamAZ-63501 8×8 (9.61 m) combat supply truck: cab-over cab with a Kord ring mount, long bed of crates
   * under a half tilt. Axles at 1420 / 1940 / 3340 / 1320 mm from the drawing. */
  supply: () => ({
    scheme: { base: OLIVE },
    hull: [
      ...chassis(-4.75, 4.6, 1.1, [3.39, 1.45, -1.9, -3.22], 2.5, 0.62),
      ...cabOver(2.75, 4.8, 1.3, 3.1, 2.5, { hatch: [-0.5, 3.5] }),
      ...cargoBed(-4.8, 2.35, 1.48, 2.48, 0.6),
      ...crates(-1.2, 2.35, 1.56, 2.3, 2, 7),
      side([[-4.75, 2.12], [-4.75, 2.95], [-4.6, 3.1], [-1.3, 3.1], [-1.15, 2.95], [-1.15, 2.12]], 2.46, CANVAS), // half tilt at the rear
      ...[-4.0, -3.0, -2.0].map((z) => box(2.48, 0.04, 0.05, 0, 3.11, z, DARK)),
      ...mirror([tubeZ(0.28, 0.28, 0.1, 1.2, 1.05, 1.0, 10, PAINT), box(0.05, 0.4, 0.8, 1.25, 2.6, -3.0, TEAM)]),
      tubeX(0.62, 0.42, 0, 2.95, 2.6, 12, RUBBER), // spare wheel behind cab
      cyl(0.07, 0.07, 1.4, 6, 1.05, 3.0, 2.65, DARK),
    ],
    mounts: { 0: kordMount(true, 0.45) },
    wheel: truckWheel(0.62, 0.48),
  }),

  /** OST: armoured 6×6 operations supply truck (8.6 m): faceted armoured cab with armoured glass, armoured box
   * body with doors and firing ports protecting the load; no weapons. */
  ost: () => ({
    scheme: { base: OLIVE },
    hull: [
      ...chassis(-4.25, 3.9, 1.15, [2.48, -1.21, -2.53], 2.55, 0.65),
      // armoured cab: faceted nose, steep screen
      side([[1.85, 1.35], [1.85, 3.25], [3.55, 3.25], [3.95, 2.45], [4.3, 2.15], [4.32, 1.35]], 2.62, PAINT),
      box(2.2, 0.62, 0.06, 0, 2.86, 3.68, GLASS, -0.62),
      ...mirror([
        box(0.04, 0.5, 0.6, 1.315, 2.7, 3.05, GLASS), box(0.04, 0.4, 0.45, 1.315, 2.75, 2.25, GLASS), // armoured side windows
        box(0.08, 0.95, 0.8, 1.33, 2.2, 2.7, PAINT), // door armour plate
        box(0.32, 0.18, 0.08, 0.95, 1.85, 4.33, LAMP), box(0.22, 0.42, 0.1, 1.5, 2.75, 3.2, DARK), // lamp, mirror arm
        box(0.04, 0.3, 0.5, 1.33, 1.75, 2.0, TEAM),
        ...[2.48, -1.21, -2.53].map((z) => box(0.4, 0.08, 1.6, 1.12, 1.45, z, DARK)), // mudguards
      ]),
      box(1.4, 0.62, 0.06, 0, 1.95, 4.33, DARK), ...[0, 1, 2, 3].map((i) => box(1.3, 0.05, 0.06, 0, 1.75 + i * 0.13, 4.36, STEEL)), // armoured grille
      box(2.7, 0.3, 0.3, 0, 1.3, 4.35, STEEL), // bumper
      cyl(0.32, 0.32, 0.12, 10, 0, 3.3, 2.5, DARK), // roof hatch
      tubeX(0.65, 0.45, 0, 2.3, 1.45, 12, RUBBER), // spare wheel between cab and body
      // armoured cargo body
      side([[-4.3, 1.4], [-4.3, 3.2], [1.15, 3.2], [1.15, 1.4]], 2.55, PAINT),
      ...mirror([
        ...[-3.6, -2.3, -1.0, 0.3].map((z) => box(0.04, 0.24, 0.24, 1.285, 2.6, z, DARK)), // firing ports
        ...[-3.0, -1.7, -0.4].map((z) => box(0.03, 1.7, 0.05, 1.29, 2.3, z, DARK)), // panel seams
        box(0.04, 0.4, 1.3, 1.29, 2.0, -1.7, TEAM),
      ]),
      box(1.1, 1.5, 0.06, 0.58, 2.3, -4.33, PAINT), box(1.1, 1.5, 0.06, -0.58, 2.3, -4.33, PAINT), box(0.04, 1.5, 0.08, 0, 2.3, -4.36, DARK), // rear doors
      ...mirror([box(0.24, 0.24, 0.05, 0.6, 2.75, -4.37, GLASS)]),
      box(2.55, 0.08, 5.45, 0, 3.24, -1.57, DARK),
    ],
    wheel: truckWheel(0.65, 0.5),
  }),

  /** UAZ-469: boxy 4×4 with bonnet, flat windscreen frame, canvas top, rear-mounted spare wheel. */
  uaz: () => ({
    scheme: { base: [0x55603a] },
    hull: [
      side([[-1.95, 0.55], [-1.95, 1.3], [1.1, 1.3], [1.95, 1.18], [2.02, 0.75], [1.95, 0.55]], 1.68, PAINT), // body
      side([[1.05, 1.18], [1.05, 1.32], [1.95, 1.2], [1.95, 1.08]], 1.5, PAINT), // bonnet
      side([[-1.9, 1.3], [-1.9, 2.0], [0.75, 2.02], [0.95, 1.95], [0.95, 1.3]], 1.62, CANVAS), // canvas top
      box(1.5, 0.62, 0.04, 0, 1.62, 1.0, GLASS, -0.12), box(1.62, 0.05, 0.06, 0, 1.95, 0.98, DARK),
      ...mirror([
        box(0.04, 0.42, 0.62, 0.82, 1.6, 0.5, GLASS), box(0.04, 0.42, 0.6, 0.82, 1.6, -0.25, GLASS),
        box(0.26, 0.14, 1.05, 0.88, 0.98, 1.4, PAINT), box(0.26, 0.14, 1.0, 0.88, 0.98, -1.2, PAINT), // fender flares
        cyl(0.1, 0.1, 0.05, 10, 0.55, 1.0, 2.0, LAMP, Math.PI / 2), box(0.12, 0.06, 0.05, 0.72, 0.82, 2.0, 0xd08a2a),
        box(0.04, 0.05, 0.6, 0.85, 1.0, 0.15, DARK), box(0.05, 0.3, 0.05, 0.86, 0.85, 0.82, DARK), // door handle, hinge
        box(0.04, 0.28, 0.5, 0.85, 1.12, -0.5, TEAM),
      ]),
      box(0.9, 0.36, 0.05, 0, 0.98, 2.02, DARK), ...[0, 1, 2, 3, 4].map((i) => box(0.05, 0.32, 0.05, -0.32 + i * 0.16, 0.98, 2.05, STEEL)), // grille
      box(1.7, 0.12, 0.16, 0, 0.62, 2.05, STEEL), box(1.6, 0.12, 0.12, 0, 0.62, -1.98, STEEL),
      tubeZ(0.36, 0.36, -2.2, -2.0, 0.4, 1.1, 12, RUBBER), tubeZ(0.18, 0.18, -2.22, -2.0, 0.4, 1.1, 8, PAINT), // spare wheel
      cyl(0.01, 0.01, 1.6, 4, -0.8, 2.3, -1.6, DARK),
    ],
    wheel: wheelGeo(0.37, 0.28, 12, RUBBER, PAINT, 0.55),
  }),

  /** GAZ Tigr-M: long sloping bonnet with bull bar, tall armoured cabin with small windows, roof hatch with a
   * shielded Kord, rear door carrying the spare wheel. */
  tigr: () => ({
    scheme: { base: [0x5a663f] },
    hull: [
      side([[-2.75, 0.62], [-2.75, 2.25], [-2.6, 2.4], [0.55, 2.4], [0.95, 1.6], [2.6, 1.42], [2.85, 1.05], [2.8, 0.62]], 2.3, PAINT),
      box(1.9, 0.6, 0.05, 0, 1.98, 0.76, GLASS, -1.08), // windscreen (two panes)
      box(0.06, 0.62, 0.08, 0, 1.98, 0.77, DARK, -1.08),
      ...mirror([
        box(0.04, 0.4, 0.7, 1.155, 1.95, 0.0, GLASS), box(0.04, 0.4, 0.7, 1.155, 1.95, -1.05, GLASS),
        ...[0.4, -0.65, -1.7].map((z) => box(0.05, 1.3, 0.04, 1.16, 1.5, z, DARK)), // door seams
        box(0.42, 0.2, 1.3, 1.04, 1.12, 1.85, PAINT), box(0.42, 0.2, 1.3, 1.04, 1.12, -1.65, PAINT), // wheel arches
        box(0.25, 0.14, 0.06, 0.72, 1.25, 2.84, LAMP), box(0.05, 0.36, 0.05, 1.25, 1.95, 0.55, DARK),
        box(0.04, 0.3, 0.6, 1.16, 1.6, -0.6, TEAM),
        box(0.08, 0.7, 0.08, 0.8, 1.05, 3.02, STEEL), // bull bar uprights
      ]),
      box(1.4, 0.38, 0.05, 0, 1.12, 2.86, DARK), box(1.75, 0.08, 0.08, 0, 1.42, 3.02, STEEL), box(1.75, 0.08, 0.08, 0, 0.75, 3.02, STEEL),
      box(2.0, 0.2, 0.22, 0, 0.62, 2.85, STEEL),
      tubeZ(0.5, 0.5, -3.0, -2.78, 0.25, 1.4, 12, RUBBER), tubeZ(0.26, 0.26, -3.02, -2.78, 0.25, 1.4, 8, PAINT), // spare on rear door
      cyl(0.48, 0.48, 0.08, 12, 0, 2.43, -0.25, DARK), // roof hatch ring
      cyl(0.01, 0.01, 1.8, 4, -0.95, 3.3, -2.4, DARK),
    ],
    mounts: { 0: kordMount(true, 0.44) },
    wheel: wheelGeo(0.53, 0.36, 14, RUBBER, PAINT, 0.55),
  }),

  /** BRDM-2: boat hull with sharp bow, armoured windscreen hatches, BPU-1 cone turret (KPVT + PKT), belly wheels. */
  brdm: () => ({
    scheme: { base: OLIVE },
    hull: [
      side([[-2.85, 0.55], [-2.85, 1.55], [-2.6, 1.75], [1.4, 1.8], [2.2, 1.45], [2.9, 1.0], [2.6, 0.55]], 2.2, PAINT),
      front([[-1.12, 1.55], [1.12, 1.55], [0.85, 1.95], [-0.85, 1.95]], -2.6, 1.4, PAINT), // sloped upper hull
      ...mirror([
        box(0.5, 0.25, 0.05, 0.42, 1.68, 1.86, DARK, -0.6), box(0.4, 0.1, 0.04, 0.42, 1.72, 1.9, GLASS, -0.6), // windscreen hatches
        box(0.44, 0.22, 1.25, 1.02, 1.12, 1.4, PAINT), box(0.44, 0.22, 1.25, 1.02, 1.12, -1.73, PAINT), // wheel arches
        tubeX(0.28, 0.2, 0.75, 0.42, -0.45, 10, RUBBER), tubeX(0.28, 0.2, 0.75, 0.42, 0.35, 10, RUBBER), // belly wheels
        box(0.18, 0.12, 0.06, 0.8, 1.32, 2.55, LAMP), box(0.05, 0.4, 0.8, 1.12, 1.5, -0.3, PAINT, 0, 0, -0.35), // side hatch
        box(0.04, 0.24, 0.6, 1.14, 1.35, -1.0, TEAM),
      ]),
      box(1.1, 0.06, 0.9, 0, 1.78, -2.0, DARK), ...[-1.7, -2.0, -2.3].map((z) => box(1.0, 0.04, 0.06, 0, 1.82, z, STEEL)), // engine deck louvres
      box(1.6, 0.04, 0.4, 0, 1.1, 2.75, PAINT, 0.9), // trim vane
      cyl(0.012, 0.012, 1.8, 4, -0.8, 2.6, -2.2, DARK),
    ],
    mounts: {
      0: {
        yaw: [cone(0.52, 0.55, 8, 0, 0.26, 0, PAINT), cyl(0.56, 0.56, 0.12, 8, 0, 0.03, 0, PAINT), box(0.14, 0.12, 0.06, 0.22, 0.32, 0.36, LENS)],
        pitch: [box(0.24, 0.22, 0.4, 0, 0, 0.1, PAINT), tubeZ(0.045, 0.04, 0.3, 1.4, 0, 0, 8, STEEL), tubeZ(0.06, 0.06, 1.25, 1.42, 0, 0, 8, DARK), tubeZ(0.02, 0.02, 0.3, 0.75, 0.2, -0.02, 6, DARK)],
      },
    },
    wheel: wheelGeo(0.55, 0.34, 14, RUBBER, PAINT, 0.55),
  }),

  /** IMR-2 style combat engineer vehicle: tracked hull with a V-plough dozer blade, armoured operator cab, long
   * telescopic crane boom with a grab stowed over the deck, mine-clearing charges, remote Kord. */
  cev: () => ({
    scheme: { base: OLIVE },
    hull: [
      side([[-3.4, 0.45], [-3.4, 1.55], [2.4, 1.6], [3.45, 1.0], [3.3, 0.45]], 3.0, PAINT),
      ...mirror([
        side([[-3.3, 0.6], [-3.3, 1.08], [3.2, 1.08], [3.4, 0.75], [3.25, 0.6]], 0.08, PAINT, 1.6),
        ...runningGear({ x: 1.32, w: 0.55, zs: [-2.45, -1.25, -0.05, 1.15, 2.35], r: 0.42, zRear: -3.0, zFront: 2.95, top: 0.9, rollers: [-1.8, 0.6] }),
        box(0.12, 0.12, 2.4, 1.0, 1.0, 4.0, STEEL, 0.32), // plough arms
        box(1.4, 0.75, 0.12, 0.8, 0.55, 5.0, PAINT, 0, 0.55, 0), // V-plough wing
        box(0.08, 0.5, 0.1, 1.35, 0.35, 5.35, STEEL), // plough tine
        box(0.04, 0.3, 0.9, 1.62, 1.3, -1.4, TEAM),
        box(0.18, 0.12, 0.06, 1.2, 1.45, 3.15, LAMP),
      ]),
      box(1.0, 0.1, 0.4, 0, 0.9, 5.55, STEEL), // plough point
      // operator's cab (front left) and rear equipment
      side([[-0.3, 1.55], [-0.3, 2.65], [1.35, 2.65], [1.75, 2.1], [1.75, 1.55]], 1.3, PAINT, 0.75),
      box(0.04, 0.3, 0.5, 1.41, 2.3, 0.7, GLASS), box(0.9, 0.3, 0.04, 0.75, 2.3, 1.7, GLASS, -0.9),
      box(1.2, 0.6, 1.6, -0.75, 1.88, -2.2, PAINT), ...[-1.6, -2.2, -2.8].map((z) => box(1.0, 0.06, 0.08, -0.75, 2.2, z, DARK)),
      // telescopic crane boom stowed along the roof, pivot at the rear, grab at the front
      box(0.55, 0.55, 5.6, -0.65, 2.55, -0.4, PAINT), box(0.42, 0.42, 1.6, -0.65, 2.55, 2.9, STEEL),
      box(0.6, 0.5, 0.6, -0.65, 2.05, -2.9, DARK), cyl(0.24, 0.24, 0.7, 10, -0.65, 2.3, -2.9, STEEL, 0, 0, Math.PI / 2),
      ...[[-0.25, 0], [0.25, 0]].map(([dx]) => box(0.08, 0.6, 0.3, -0.65 + dx, 2.1, 3.75, DARK, 0.4)), // grab tines
      tubeZ(0.1, 0.1, -1.4, 1.6, -0.15, 1.95, 8, 0x6b6440), // demolition charge tube
      cyl(0.012, 0.012, 2.0, 4, 1.3, 3.6, -3.0, DARK),
    ],
    mounts: { 0: kordMount(false, 0.3) },
  }),

  /** BM-21 Grad on the Ural-375D 6×6: bonnet cab, spare wheel behind it, 40-tube launcher pivoting at the rear of a
   * turntable and lying forward over the bed. Axles 1276 / 3525 / 1400 mm, 7.37 m long. */
  grad: () => ({
    scheme: { base: OLIVE },
    hull: [
      ...chassis(-3.65, 3.5, 1.08, [2.41, -1.12, -2.52], 2.5, 0.58),
      side([[2.35, 1.2], [2.35, 1.72], [3.55, 1.66], [3.72, 1.45], [3.72, 1.2]], 1.95, PAINT), // bonnet
      ...mirror([side([[1.85, 1.15], [1.85, 1.6], [2.8, 1.6], [3.3, 1.25], [3.55, 1.12]], 0.35, PAINT, 1.05)]), // flared fenders
      side([[0.9, 1.25], [0.9, 2.9], [1.95, 2.9], [2.35, 2.2], [2.35, 1.25]], 2.25, PAINT), // cab
      box(1.85, 0.5, 0.04, 0, 2.45, 2.3, GLASS, -0.55),
      ...mirror([box(0.04, 0.45, 0.7, 1.13, 2.45, 1.5, GLASS), box(0.14, 0.12, 0.05, 0.62, 1.48, 3.74, LAMP), box(0.04, 0.3, 0.55, 1.14, 1.75, 1.4, TEAM),
        box(0.06, 0.32, 0.2, 1.3, 2.4, 2.2, DARK)]),
      box(1.0, 0.38, 0.05, 0, 1.42, 3.74, DARK), box(2.2, 0.18, 0.2, 0, 1.12, 3.78, STEEL),
      tubeX(0.55, 0.38, 0, 1.95, 0.55, 12, RUBBER), tubeX(0.3, 0.4, 0, 1.95, 0.55, 8, PAINT), // spare wheel
      ...mirror([box(0.5, 0.45, 0.8, 0.9, 1.5, -0.2, PAINT)]), // equipment lockers
      box(2.45, 0.12, 4.0, 0, 1.38, -1.7, PAINT), cyl(0.85, 0.9, 0.35, 12, 0, 1.6, -2.4, PAINT), // deck + turntable base
      ...mirror([box(0.25, 0.4, 0.25, 1.05, 0.85, -3.5, DARK)]), // stabiliser jacks
    ],
    mounts: {
      0: {
        yaw: [box(1.5, 0.4, 1.6, 0, 0.0, -0.2, PAINT), ...mirror([box(0.12, 0.7, 0.8, 0.62, 0.25, -0.65, DARK)])],
        pitch: [
          ...Array.from({ length: 10 }, (_, i) => -0.63 + i * 0.14).flatMap((x) => [-0.12, 0.08, 0.28, 0.48].map((y) => tubeZ(0.065, 0.065, 0, 3.0, x, y, 6, PAINT))),
          ...[0.3, 1.5, 2.7].map((z) => box(1.5, 0.84, 0.1, 0, 0.18, z, STEEL)),
          ...Array.from({ length: 10 }, (_, i) => -0.63 + i * 0.14).flatMap((x) => [-0.12, 0.08, 0.28, 0.48].map((y) => tubeZ(0.05, 0.05, 2.99, 3.01, x, y, 6, DARK))),
          box(0.5, 0.12, 0.05, 0, 0.62, 1.5, TEAM),
        ],
      },
    },
    wheel: wheelGeo(0.58, 0.4, 14, RUBBER, PAINT, 0.55),
  }),

  /** BM-30 Smerch on the MAZ-543 8×8: twin crew cabs either side of the engine, 12 × 300 mm tubes (4 × 3) over the
   * whole deck pivoting at the rear, stabiliser jacks. 12.1 m long. */
  smerch: () => ({
    scheme: { base: OLIVE },
    hull: [
      box(1.2, 0.4, 11.6, 0, 1.15, 0, DARK),
      box(2.95, 0.3, 9.0, 0, 1.55, -1.4, PAINT),
      ...mirror([
        side([[3.2, 1.35], [3.2, 2.85], [5.3, 2.85], [6.0, 2.2], [6.05, 1.35]], 1.0, PAINT, 1.0), // crew cab
        box(0.82, 0.55, 0.04, 1.0, 2.45, 5.66, GLASS, -0.75), box(0.04, 0.5, 0.75, 1.51, 2.45, 4.6, GLASS), box(0.04, 0.5, 0.6, 1.51, 2.45, 3.75, GLASS),
        box(0.04, 0.3, 0.7, 1.52, 1.85, 4.2, TEAM), box(0.22, 0.14, 0.05, 1.05, 1.55, 6.08, LAMP),
        ...[4.15, 1.95, -1.35, -3.55].map((z) => box(0.45, 0.1, 1.65, 1.3, 1.62, z, DARK)), // mudguards
        box(0.3, 0.5, 0.3, 1.2, 0.9, -5.4, DARK), // jacks
        side([[-5.9, 1.7], [-5.9, 2.05], [2.6, 2.05], [2.6, 1.7]], 0.08, STEEL, 1.45), // deck rail
      ]),
      side([[3.6, 1.35], [3.6, 2.2], [5.6, 2.2], [6.05, 1.6], [6.05, 1.35]], 0.95, PAINT), // engine hood between the cabs
      box(0.85, 0.4, 0.05, 0, 1.75, 6.07, DARK), box(3.0, 0.24, 0.3, 0, 1.25, 6.12, STEEL),
      box(2.2, 0.7, 1.1, 0, 2.05, 2.8, PAINT), // equipment module behind the cabs
    ],
    mounts: {
      0: {
        yaw: [box(2.3, 0.35, 1.3, 0, -0.15, 0.5, DARK)],
        pitch: [
          ...[-0.9, -0.3, 0.3, 0.9].flatMap((x) => [0.35, 0.85, 1.3].flatMap((y) => [tubeZ(0.2, 0.2, 0, 8.6, x, y, 10, PAINT), tubeZ(0.15, 0.15, 8.58, 8.62, x, y, 10, DARK), tubeZ(0.17, 0.17, -0.04, 0.0, x, y, 10, 0x5d86a8)])),
          ...[0.6, 4.2, 7.9].map((z) => box(2.62, 1.55, 0.14, 0, 0.82, z, STEEL)),
          box(2.6, 0.12, 8.6, 0, 0.06, 4.3, PAINT), box(0.6, 0.18, 0.05, 0.6, 1.55, 4.2, TEAM),
        ],
      },
    },
    wheel: wheelGeo(0.69, 0.55, 14, RUBBER, PAINT, 0.5),
  }),

  /** 96L6E all-altitude acquisition radar on an 8×8: cab, raised mast with the rotating phased array, equipment
   * shelter at the rear, outrigger jacks. */
  radar: () => ({
    scheme: { base: OLIVE },
    hull: [
      ...chassis(-5.3, 5.0, 1.12, [3.0, 1.5, -1.6, -3.1], 2.6, 0.6),
      ...cabOver(3.5, 5.4, 1.3, 3.05, 2.6),
      box(2.55, 1.6, 3.6, 0, 2.3, -3.4, PAINT), box(2.57, 0.08, 3.62, 0, 3.12, -3.4, DARK), // shelter
      ...mirror([box(0.04, 0.5, 0.9, 1.29, 2.4, -2.6, DARK), box(0.04, 0.35, 0.9, 1.29, 2.0, -4.2, TEAM)]),
      box(2.4, 0.5, 1.5, 0, 1.6, 0.0, PAINT), // generator
      // mast: lattice column from a hinged base
      box(0.6, 0.5, 0.8, 0, 1.7, 1.4, DARK), box(0.32, 3.8, 0.32, 0, 3.7, 1.4, STEEL), box(0.12, 3.4, 0.12, 0.25, 3.5, 1.15, DARK, 0.18),
      ...mirror([box(1.4, 0.14, 0.14, 1.0, 1.25, 1.4, STEEL), box(0.16, 0.9, 0.16, 1.65, 0.7, 1.4, STEEL), box(0.4, 0.05, 0.4, 1.65, 0.05, 1.4, DARK)]), // outriggers
    ],
    spinners: [{
      mount: -1, pos: [0, 5.65, 1.4], rate: 1.4,
      geos: [box(0.5, 0.4, 0.5, 0, 0, 0, DARK), box(2.3, 3.0, 0.3, 0, 1.75, 0.3, PAINT), box(2.1, 2.8, 0.05, 0, 1.75, 0.47, 0x6f7a74),
        ...[0.5, 1.2, 1.9, 2.6].map((y) => box(2.2, 0.04, 0.06, 0, 0.25 + y, 0.5, DARK)), box(0.5, 0.2, 0.05, 0, 3.15, 0.47, TEAM)],
    }],
    wheel: truckWheel(0.6, 0.5),
  }),

  /** Iskander-M TEL (MZKT 8×8, 13.07 m): wide three-window cab, long armoured launcher compartment whose roof opens;
   * two missiles on the erector (the erector lifts them out to fire). */
  tel: () => ({
    scheme: { base: OLIVE },
    hull: [
      ...chassis(-6.4, 5.6, 1.15, [4.4, 2.6, -1.8, -3.6], 3.0, 0.7),
      side([[4.55, 1.35], [4.55, 3.25], [6.15, 3.25], [6.55, 2.6], [6.55, 1.35]], 3.0, PAINT), // cab
      box(2.6, 0.62, 0.05, 0, 2.85, 6.4, GLASS, -0.45), ...[-0.43, 0.43].map((x) => box(0.06, 0.62, 0.06, x, 2.85, 6.41, DARK, -0.45)),
      ...mirror([box(0.04, 0.5, 0.8, 1.505, 2.85, 5.4, GLASS), box(0.3, 0.16, 0.05, 1.2, 1.75, 6.57, LAMP), box(0.04, 0.32, 0.6, 1.51, 2.1, 5.0, TEAM),
        box(0.15, 0.3, 0.35, 1.55, 2.6, 6.0, DARK)]),
      box(2.0, 0.42, 0.05, 0, 1.85, 6.57, DARK), box(3.0, 0.25, 0.3, 0, 1.35, 6.6, STEEL),
      box(2.9, 1.6, 1.4, 0, 2.3, 3.75, PAINT), // equipment section behind the cab
      // launcher compartment: walls, floor and the two open roof doors
      ...mirror([side([[-6.45, 1.5], [-6.45, 3.25], [2.95, 3.25], [2.95, 1.5]], 0.12, PAINT, 1.44),
        box(1.0, 0.08, 9.3, 1.0, 3.3, -1.75, PAINT, 0, 0, 0.35), // roof door (opened outward)
        ...[-5.4, -3.4, -1.4, 0.6, 2.4].map((z) => box(0.05, 1.7, 0.06, 1.51, 2.38, z, DARK)),
        ...[4.4, 2.6, -1.8, -3.6].map((z) => box(0.5, 0.1, 1.8, 1.3, 1.6, z, DARK))]),
      box(2.8, 0.12, 9.4, 0, 1.55, -1.75, PAINT), box(2.9, 1.7, 0.1, 0, 2.38, -6.45, PAINT),
      box(0.4, 0.4, 0.6, 0, 1.75, -6.2, DARK), // erector hinge
    ],
    mounts: {
      0: {
        yaw: [],
        // two missiles on the erector beam, pointing forward along the compartment at pitch 0
        pitch: [box(0.35, 0.25, 6.6, 0, -0.35, 3.2, STEEL), ...mirror([
          tubeZ(0.46, 0.46, 0.2, 5.4, 0.62, 0.15, 12, 0x5c6a3f), cone(0.46, 1.5, 12, 0.62, 0.15, 6.15, 0x5c6a3f, Math.PI / 2),
          ...[0.6, 2.0].map((z) => box(0.06, 0.5, 0.5, 0.62 + 0.46, 0.15, z, DARK)), // fins
          box(0.5, 0.06, 0.06, 0.62, 0.62, 3.0, TEAM)])],
      },
    },
    wheel: wheelGeo(0.7, 0.55, 14, RUBBER, PAINT, 0.5),
  }),

  /** Gunship: Mi-17 (Mi-8AMTSh "Terminator"): big cabin, twin engines over it, five-blade rotor, tail rotor on the
   * right, outriggers with B-8 rocket pods and Shturm ATGM racks, armoured cockpit, clamshell doors. */
  gunship: () => ({
    scheme: { base: [0x5a6640, 0x8a7d52, 0x404530], belly: 0x8fa9b8, scale: 3.0 },
    hull: [
      fuselage([[9.3, 0.35, 1.2, 1.9], [8.8, 0.95, 0.85, 2.6], [7.8, 1.3, 0.7, 3.1], [6.2, 1.4, 0.68, 3.3], [1.0, 1.42, 0.68, 3.35], [-1.6, 1.35, 0.72, 3.3],
        [-2.8, 1.0, 1.2, 3.25], [-3.8, 0.6, 2.25, 3.2], [-8.0, 0.32, 2.6, 3.1], [-11.2, 0.25, 2.75, 3.15]], PAINT, 0, 12),
      fuselage([[9.25, 0.32, 1.25, 1.85], [8.75, 0.9, 1.4, 2.55], [8.1, 1.15, 2.2, 2.95], [7.4, 1.1, 2.5, 3.0]], GLASS, 0, 10),
      fuselage([[6.6, 0.85, 3.2, 3.5], [5.8, 1.05, 3.2, 3.95], [-0.2, 1.05, 3.2, 3.95], [-1.4, 0.85, 3.2, 3.75], [-2.3, 0.45, 3.2, 3.45]], PAINT, 0, 10), // engines
      ...mirror([
        tubeZ(0.33, 0.3, 6.5, 6.6, 0.48, 3.55, 10, DARK), tubeZ(0.24, 0.26, -1.6, -1.2, 1.05, 3.45, 8, DARK), // intakes, exhausts
        ...[5.6, 4.6, 3.6, 2.6, 1.6].map((z) => tubeX(0.2, 0.04, 1.42, 2.25, z, 10, LENS)), // round cabin windows
        box(0.08, 0.95, 0.1, 1.0, 1.15, 0.4, STEEL, 0, 0, 0.6), // outrigger strut
        top([[1.3, 2.4], [3.4, 1.9], [3.4, 0.6], [1.3, 0.6]], 1.75, 0.1, PAINT), // outrigger
        ...[2.35, 3.05].map((x) => [box(0.08, 0.3, 0.25, x, 1.55, 1.5, DARK), tubeZ(0.26, 0.26, 0.4, 2.4, x, 1.25, 10, PAINT), tubeZ(0.22, 0.22, 2.39, 2.42, x, 1.25, 10, DARK)]).flat(), // B-8 pods
        ...[[0.1, 0], [-0.1, 0], [0, 0.18]].map(([dx, dy]) => tubeZ(0.08, 0.08, 0.2, 2.0, 3.55 + dx, 1.55 + dy, 6, 0x6d7458)), // Shturm tubes
        box(0.1, 0.75, 0.1, 1.5, 0.55, 0.2, DARK), tubeX(0.35, 0.26, 1.55, 0.35, 0.2, 10, RUBBER), // main gear
        box(0.06, 0.06, 4.0, 0.25, 2.95, -7.5, DARK),
        place(cyl(0.07, 0.07, 0.04, 5, 0, 0, 0, TEAM), 1.36, 2.0, -1.0, 0, 0, Math.PI / 2),
      ]),
      box(0.05, 1.3, 1.6, 1.42, 1.65, 4.8, DARK), // sliding door outline (left)
      side([[-10.6, 3.0], [-11.6, 3.0], [-12.3, 5.4], [-11.5, 5.4]], 0.18, PAINT), // tail fin
      top([[1.6, -10.2], [1.6, -10.8], [-1.6, -10.8], [-1.6, -10.2]], 3.05, 0.08, PAINT), // stabiliser
      side(star(0.45).map(([u, v]) => [u - 6.0, v + 2.95]), 0.02, TEAM, 0.37), side(star(0.45).map(([u, v]) => [u - 6.0, v + 2.95]), 0.02, TEAM, -0.37),
      box(0.08, 0.7, 0.08, 0.3, 0.5, 7.4, DARK), box(0.08, 0.7, 0.08, -0.3, 0.5, 7.4, DARK), tubeX(0.27, 0.8, 0, 0.27, 7.4, 10, RUBBER), // nose gear
      cyl(0.22, 0.3, 0.6, 8, 0, 4.3, 1.9, DARK), // rotor mast
    ],
    mounts: { 2: { yaw: [box(0.08, 0.36, 0.08, 0, -0.22, 0, DARK)], pitch: [box(0.1, 0.13, 0.62, 0, 0, 0.05, DARK), tubeZ(0.022, 0.02, 0.3, 0.9, 0, 0.02, 6, STEEL)] } },
    rotors: [
      { pos: [0, 4.75, 1.9], axis: 'y', dir: 1, rate: 22, geos: rotorGeo(5, 10.6, 0.53, DARK, STEEL, 0.14) },
      { pos: [-0.35, 4.6, -11.9], axis: 'x', dir: 1, rate: 60, geos: rotorGeo(3, 1.95, 0.26, DARK).map((g) => g.rotateZ(Math.PI / 2)) },
    ],
  }),

  /** Recon helo: Mi-2: short glazed cabin pod, twin engines on top, slim tail boom, three-blade rotor, two-blade
   * tail rotor, four-wheel gear, nose FLIR turret. */
  reconheli: () => ({
    scheme: { base: [0x5c6b3a], belly: 0x9cb7c9 },
    hull: [
      fuselage([[4.45, 0.2, 0.95, 1.45], [4.2, 0.62, 0.7, 2.0], [3.4, 0.8, 0.55, 2.4], [1.2, 0.85, 0.55, 2.5], [-0.2, 0.8, 0.65, 2.45],
        [-0.9, 0.5, 1.4, 2.35], [-1.4, 0.24, 1.75, 2.25], [-5.8, 0.16, 1.95, 2.25], [-6.7, 0.14, 2.0, 2.3]], PAINT, 0, 12),
      fuselage([[4.4, 0.18, 1.0, 1.42], [4.15, 0.6, 1.25, 2.05], [3.6, 0.76, 1.55, 2.35], [2.8, 0.78, 1.6, 2.4]], GLASS, 0, 10),
      fuselage([[2.7, 0.6, 2.45, 2.65], [2.2, 0.72, 2.45, 3.0], [-0.4, 0.7, 2.45, 2.95], [-1.0, 0.4, 2.4, 2.7]], PAINT, 0, 10), // engines
      ...mirror([...[1.9, 1.0, 0.1].map((z) => tubeX(0.22, 0.03, 0.85, 1.75, z, 8, GLASS)), box(0.06, 0.7, 0.06, 1.0, 0.45, 0.2, DARK), tubeX(0.27, 0.18, 1.05, 0.27, 0.2, 10, RUBBER),
        box(0.06, 0.6, 0.06, 0.32, 0.45, 3.3, DARK), tubeX(0.2, 0.14, 0.35, 0.2, 3.3, 8, RUBBER), box(0.04, 0.3, 0.5, 0.86, 1.25, -0.4, TEAM)]),
      side([[-6.2, 2.1], [-6.9, 2.15], [-7.15, 3.3], [-6.7, 3.3]], 0.12, PAINT), top([[1.0, -5.9], [1.0, -6.3], [-1.0, -6.3], [-1.0, -5.9]], 2.15, 0.06, PAINT),
      box(0.06, 0.8, 0.06, 0, 1.6, -6.4, DARK), // tail skid strut
      sphere(0.26, 0, 0.82, 4.25, LENS), box(0.1, 0.5, 0.1, 0, 1.0, 4.15, DARK), // FLIR ball
      cyl(0.16, 0.22, 0.6, 8, 0, 3.1, 1.6, DARK),
    ],
    mounts: { 0: { yaw: [box(0.08, 0.36, 0.08, 0, -0.22, 0, DARK)], pitch: [box(0.1, 0.13, 0.62, 0, 0, 0.05, DARK), tubeZ(0.022, 0.02, 0.3, 0.8, 0, 0.02, 6, STEEL)] } },
    rotors: [
      { pos: [0, 3.55, 1.6], axis: 'y', dir: 1, rate: 24, geos: rotorGeo(3, 7.25, 0.38, DARK, STEEL, 0.06) },
      { pos: [0.22, 2.55, -6.95], axis: 'x', dir: 1, rate: 60, geos: rotorGeo(2, 1.35, 0.18, DARK).map((g) => g.rotateZ(Math.PI / 2)) },
    ],
  }),

  /** Heavy transport helo: Mi-26: 33.7 m fuselage, glazed nose, tall cargo hold with clamshell ramp, engines over
   * the cabin, eight-blade 32 m rotor, five-blade tail rotor on a swept fin. */
  heavyheli: () => ({
    scheme: { base: [0x606b52, 0x7d7a5b], belly: 0x9fb2bd, scale: 5 },
    hull: [
      fuselage([[16.8, 0.6, 2.0, 3.2], [16.0, 1.5, 1.4, 4.4], [14.5, 1.85, 1.0, 5.1], [12.0, 2.0, 0.9, 5.35], [2.0, 2.05, 0.9, 5.4],
        [-4.5, 2.0, 1.0, 5.35], [-6.5, 1.4, 2.6, 5.3], [-8.0, 0.8, 3.6, 5.2], [-15.0, 0.55, 4.2, 5.2], [-17.0, 0.45, 4.4, 5.3]], PAINT, 0, 14),
      fuselage([[16.75, 0.58, 2.05, 3.15], [16.2, 1.25, 2.6, 4.2], [15.3, 1.55, 3.6, 4.85], [14.4, 1.5, 4.1, 5.0]], GLASS, 0, 12),
      fuselage([[11.5, 1.6, 5.3, 5.7], [10.5, 1.95, 5.3, 6.6], [3.0, 1.95, 5.3, 6.6], [1.0, 1.4, 5.3, 6.3]], PAINT, 0, 12), // engines
      ...mirror([
        tubeZ(0.62, 0.6, 11.4, 11.5, 1.0, 6.0, 12, DARK), tubeZ(0.5, 0.52, 0.8, 1.2, 1.4, 5.9, 10, DARK),
        ...[12.5, 10.5, 8.5, 6.5, 4.5, 2.5, 0.5].map((z) => tubeX(0.26, 0.04, 2.05, 3.6, z, 10, LENS)),
        side([[-1.0, 0.6], [-1.0, 2.0], [4.5, 2.0], [4.5, 0.6]], 0.7, PAINT, 2.2), // gear sponson
        box(0.12, 1.2, 0.12, 2.3, 0.6, 1.8, DARK), tubeX(0.6, 0.45, 2.3, 0.6, 1.8, 12, RUBBER), tubeX(0.6, 0.45, 2.3, 0.6, 0.6, 12, RUBBER),
        box(0.05, 0.8, 2.0, 2.06, 3.2, 8.5, TEAM),
        box(0.06, 1.8, 1.4, 2.06, 2.0, 11.0, DARK), // entry door
      ]),
      box(3.2, 0.08, 4.0, 0, 1.6, -7.3, DARK, 0.42), // clamshell ramp line
      side([[-14.6, 5.0], [-16.8, 5.0], [-18.2, 9.4], [-16.9, 9.4]], 0.4, PAINT), // fin
      top([[2.2, -14.8], [2.2, -15.9], [-2.2, -15.9], [-2.2, -14.8]], 5.2, 0.12, PAINT),
      box(0.12, 1.2, 0.12, 0, 0.8, 11.6, DARK), tubeX(0.5, 0.9, 0, 0.5, 11.6, 12, RUBBER), // nose gear
      side(star(0.9).map(([u, v]) => [u - 11.0, v + 4.6]), 0.02, TEAM, 0.66), side(star(0.9).map(([u, v]) => [u - 11.0, v + 4.6]), 0.02, TEAM, -0.66),
      cyl(0.4, 0.55, 1.4, 10, 0, 7.2, 5.5, DARK),
    ],
    rotors: [
      { pos: [0, 8.1, 5.5], axis: 'y', dir: 1, rate: 16, geos: rotorGeo(8, 16, 0.8, DARK, STEEL, 0.25) },
      { pos: [-0.6, 7.6, -17.6], axis: 'x', dir: 1, rate: 45, geos: rotorGeo(5, 3.8, 0.38, DARK).map((g) => g.rotateZ(Math.PI / 2)) },
    ],
  }),

  /** Light attack: Yak-130: slim nose, high tandem canopy, long LERX, mid wing with three pylons and tip rails,
   * intakes under the LERX, single fin. 11.5 m, gear 1.0 m. */
  lightattack: () => ({
    scheme: AIR_GREY,
    hull: [
      fuselage([[5.75, 0.06, 1.7, 1.78], [5.0, 0.38, 1.45, 2.05], [3.8, 0.55, 1.28, 2.35], [2.4, 0.6, 1.2, 2.55], [0.5, 0.7, 1.15, 2.45],
        [-2.5, 0.6, 1.2, 2.3], [-4.6, 0.42, 1.35, 2.2], [-5.65, 0.34, 1.45, 2.1]], PAINT, 0, 12),
      fuselage([[3.6, 0.28, 2.3, 2.5], [2.9, 0.42, 2.3, 3.0], [1.6, 0.44, 2.35, 3.15], [0.6, 0.38, 2.4, 2.95], [0.0, 0.2, 2.35, 2.6]], GLASS, 0, 10),
      box(0.04, 0.5, 0.04, 0, 2.9, 1.9, DARK),
      ...mirror([
        top([[0.55, 3.2], [0.7, 0.5], [0.95, 0.5]], 1.85, 0.08, PAINT), // LERX
        top([[0.65, 0.55], [4.9, -1.35], [4.9, -2.2], [0.65, -2.6]], 1.7, 0.12, PAINT), // wing
        tubeZ(0.05, 0.05, -2.4, -0.9, 4.95, 1.74, 6, 0xd9dcd8), // tip rail missile
        fuselage([[1.6, 0.25, 1.15, 1.75], [0.8, 0.38, 1.1, 1.85], [-1.6, 0.36, 1.15, 1.8], [-2.6, 0.22, 1.2, 1.7]], PAINT, 0.75, 8), // intake ducts
        tubeZ(0.26, 0.26, 1.58, 1.62, 0.75, 1.45, 8, DARK), tubeZ(0.3, 0.28, -5.7, -5.6, 0.32, 1.78, 10, DARK),
        ...[1.9, 2.9, 3.9].map((x) => box(0.06, 0.3, 0.7, x, 1.5, -1.2, DARK)),
        ...[1.9, 2.9].map((x) => [tubeZ(0.2, 0.2, -2.0, -0.4, x, 1.2, 10, 0x5d6450), cone(0.2, 0.3, 10, x, 1.2, -0.25, 0x5d6450, Math.PI / 2)]).flat(), // rocket pods
        top([[0.3, -4.1], [2.3, -4.9], [2.3, -5.3], [0.3, -5.6]], 1.95, 0.08, PAINT), // tailplane
        side(star(0.32).map(([u, v]) => [u - 1.6, v + 1.9]), 0.02, TEAM, 0.71),
      ]),
      side([[-3.2, 2.2], [-5.0, 2.2], [-5.75, 4.7], [-4.9, 4.7]], 0.1, PAINT),
      box(0.12, 0.4, 0.5, 0, 4.4, -5.3, TEAM),
      tubeZ(0.025, 0.02, 5.7, 6.2, 0, 1.75, 4, DARK),
    ],
  }),

  /** Light transport: Il-112V (24.15 m, span 27.6 m): circular fuselage, high straight wing, two turboprops with
   * six-blade propellers, T-tail with swept fin, gear sponsons, rear ramp, paratroop doors. */
  transportplane: () => ({
    scheme: { base: [0x6d7774], belly: 0x9eaab0 },
    hull: [
      fuselage([[12.1, 0.3, 2.2, 2.8], [11.4, 1.0, 1.6, 3.45], [10.2, 1.45, 1.4, 4.05], [8.4, 1.65, 1.3, 4.35], [-3.6, 1.65, 1.3, 4.35],
        [-6.6, 1.35, 2.2, 4.4], [-9.6, 0.75, 3.4, 4.5], [-12.0, 0.35, 4.1, 4.6]], PAINT, 0, 14),
      fuselage([[11.55, 0.8, 3.0, 3.45], [11.1, 1.15, 3.2, 3.85], [10.5, 1.3, 3.5, 4.05], [10.1, 1.25, 3.7, 4.1]], GLASS, 0, 10),
      box(2.4, 0.4, 2.8, 0, 4.4, 1.2, PAINT), // wing centre fairing
      ...mirror([
        top([[1.2, 2.6], [13.8, 1.7], [13.8, 0.4], [1.2, -0.4]], 4.55, 0.32, PAINT), // wing
        box(0.08, 0.36, 0.9, 13.82, 4.7, 1.05, TEAM),
        fuselage([[5.2, 0.45, 3.6, 4.2], [4.6, 0.62, 3.4, 4.5], [1.0, 0.62, 3.5, 4.6], [-1.6, 0.35, 3.9, 4.5]], PAINT, 4.3, 10), // nacelle
        cone(0.35, 0.6, 10, 4.3, 4.0, 5.5, DARK, Math.PI / 2),
        side([[-1.2, 0.7], [-1.2, 2.0], [3.2, 2.0], [3.2, 0.7]], 0.8, PAINT, 1.55), // gear sponson
        box(0.06, 1.3, 0.75, 1.65, 2.6, -4.3, DARK), // paratroop door
        ...[8.0, 6.0, 4.0, 2.0, 0.0, -2.0].map((z) => tubeX(0.18, 0.03, 1.65, 3.25, z, 8, LENS)),
        box(0.05, 0.5, 1.6, 1.66, 3.2, 6.8, TEAM),
        box(0.14, 0.9, 0.14, 1.9, 0.6, 1.2, STEEL), tubeX(0.45, 0.32, 1.9, 0.45, 1.6, 12, RUBBER), tubeX(0.45, 0.32, 1.9, 0.45, 0.6, 12, RUBBER),
        top([[0.3, -11.0], [5.0, -11.7], [5.0, -12.4], [0.3, -12.8]], 8.75, 0.12, PAINT), // T-tail tailplane
        box(0.06, 0.12, 0.7, 5.02, 8.8, -12.0, TEAM),
      ]),
      side([[-8.4, 4.3], [-11.2, 4.4], [-12.9, 8.9], [-11.6, 8.9]], 0.35, PAINT), // swept fin
      box(3.0, 0.06, 3.2, 0, 1.8, -8.0, DARK, 0.4), // rear ramp line
      side(star(0.6).map(([u, v]) => [u - 11.2, v + 7.4]), 0.02, TEAM, 0.18), side(star(0.6).map(([u, v]) => [u - 11.2, v + 7.4]), 0.02, TEAM, -0.18),
    ],
    rotors: [4.3, -4.3].map((x) => ({ pos: [x, 4.0, 5.6], axis: 'z', dir: x > 0 ? 1 : -1, rate: 40,
      geos: [0, 1, 2, 3, 4, 5].map((i) => place(box(0.24, 1.95, 0.07, 0, 0.97, 0, DARK), 0, 0, 0, 0, 0, (i * Math.PI) / 3)) })),
  }),

  /** Fighter 1: Su-27: long pointed nose, high bubble canopy, ogival LERX, cropped-delta wing with tip rails, widely
   * spaced engine nacelles with a tunnel, twin fins, tail boom. 21.9 m, span 14.7 m. */
  fighter2: () => ({
    scheme: { base: [0x96acba, 0x7393a9, 0x5a7891], belly: 0xbcc8d0, scale: 3.0 },
    hull: [
      fuselage([[10.9, 0.06, 2.35, 2.42], [10.0, 0.42, 2.1, 2.8], [8.6, 0.62, 1.95, 3.05], [6.6, 0.75, 1.95, 3.25], [4.5, 0.85, 2.0, 3.25],
        [2.0, 0.9, 2.05, 3.0], [-3.0, 0.8, 2.05, 2.8], [-7.5, 0.55, 2.1, 2.7], [-10.9, 0.3, 2.25, 2.6]], PAINT, 0, 12),
      cone(0.55, 1.2, 12, 0, 2.38, 10.3, 0xd6dad6, Math.PI / 2),
      fuselage([[7.6, 0.3, 3.0, 3.25], [6.8, 0.5, 3.0, 3.75], [5.4, 0.52, 3.05, 3.8], [4.3, 0.35, 3.05, 3.4]], GLASS, 0, 10),
      ...mirror([
        fuselage([[2.6, 0.62, 1.15, 2.05], [1.5, 0.7, 1.1, 2.15], [-4.0, 0.66, 1.15, 2.25], [-8.4, 0.6, 1.25, 2.2], [-9.8, 0.55, 1.3, 2.1]], PAINT, 1.55, 10), // nacelles
        tubeZ(0.55, 0.55, 2.58, 2.62, 1.55, 1.6, 10, DARK), tubeZ(0.5, 0.52, -10.1, -9.8, 1.55, 1.7, 10, DARK),
        top([[0.8, 6.8], [1.6, 3.0], [1.6, 0.5]], 2.6, 0.1, PAINT), // LERX
        top([[1.6, 0.6], [7.35, -4.2], [7.35, -5.4], [1.6, -5.4]], 2.4, 0.14, PAINT), // wing
        tubeZ(0.08, 0.08, -6.0, -3.6, 7.4, 2.45, 6, 0xdfe3e0), cone(0.08, 0.35, 6, 7.4, 2.45, -3.45, 0xdfe3e0, Math.PI / 2), // tip missile
        tubeZ(0.1, 0.1, -3.5, -1.3, 3.9, 2.12, 6, 0xdfe3e0), box(0.05, 0.3, 1.0, 3.9, 2.3, -2.4, DARK), // pylon missile
        side([[-5.6, 2.7], [-8.3, 2.7], [-9.3, 5.9], [-8.0, 5.9]], 0.12, PAINT, 2.15), // fin
        top([[2.0, -7.3], [4.9, -9.3], [4.9, -10.1], [2.0, -10.3]], 2.0, 0.1, PAINT), // taileron
        side(star(0.45).map(([u, v]) => [u - 7.9, v + 4.4]), 0.02, TEAM, 2.22),
        box(0.12, 0.4, 0.7, 2.15, 5.6, -8.9, TEAM),
      ]),
      box(0.4, 0.4, 2.2, 0, 2.45, -10.6, PAINT), // tail boom (sting)
      tubeZ(0.03, 0.02, 10.9, 11.6, 0, 2.38, 4, DARK),
    ],
  }),

  /** Fighter 2: MiG-31: long nose, tandem canopy, huge rectangular intakes along the sides, shoulder wing, twin
   * canted fins, two big nozzles, four R-33 under the belly. 22.7 m, span 13.46 m. */
  fighter3: () => ({
    scheme: { base: [0x9aa39e, 0x7d8783], belly: 0xb9c1c3, scale: 3.5 },
    hull: [
      fuselage([[11.3, 0.06, 2.55, 2.62], [10.4, 0.45, 2.3, 3.0], [8.6, 0.7, 2.15, 3.35], [6.4, 0.85, 2.2, 3.55], [4.0, 1.05, 2.2, 3.55],
        [0.0, 1.35, 2.05, 3.45], [-6.0, 1.35, 2.05, 3.35], [-10.2, 1.2, 2.15, 3.2], [-11.3, 1.05, 2.2, 3.1]], PAINT, 0, 12, 3.2),
      cone(0.62, 1.4, 12, 0, 2.6, 10.6, 0xd6dad6, Math.PI / 2),
      fuselage([[7.9, 0.3, 3.3, 3.55], [7.1, 0.52, 3.3, 4.0], [4.6, 0.55, 3.35, 4.05], [3.8, 0.35, 3.35, 3.65]], GLASS, 0, 10),
      box(0.04, 0.5, 0.04, 0, 3.75, 5.9, DARK),
      ...mirror([
        side([[4.4, 2.0], [4.4, 3.35], [-2.0, 3.35], [-2.0, 2.0]], 0.75, PAINT, 1.75), // intake box
        front([[1.4, 2.08], [2.1, 2.08], [2.1, 3.3], [1.4, 3.3]], 4.35, 4.45, DARK),
        top([[1.9, 1.0], [6.73, -5.0], [6.73, -6.2], [1.9, -5.8]], 3.15, 0.14, PAINT), // shoulder wing
        tubeZ(0.08, 0.08, -5.5, -3.4, 6.73, 3.0, 6, 0xdfe3e0),
        side([[-6.4, 3.4], [-9.0, 3.4], [-10.3, 6.15], [-9.0, 6.15]], 0.12, PAINT, 1.75), // fin
        top([[1.3, -8.0], [4.4, -9.8], [4.4, -10.6], [1.3, -10.8]], 2.6, 0.1, PAINT), // stabilator
        tubeZ(0.62, 0.64, -11.6, -11.25, 0.75, 2.65, 12, DARK),
        ...[-1.2, -5.4].map((z) => [tubeZ(0.19, 0.19, z - 2.0, z + 1.6, 0.95, 1.8, 8, 0xd2d6d2), cone(0.19, 0.5, 8, 0.95, 1.8, z + 1.85, 0xd2d6d2, Math.PI / 2)]).flat(), // R-33
        side(star(0.45).map(([u, v]) => [u - 8.6, v + 4.8]), 0.02, TEAM, 1.82),
        box(0.12, 0.4, 0.8, 1.75, 5.85, -9.6, TEAM),
      ]),
      tubeZ(0.03, 0.02, 11.3, 12.0, 0, 2.6, 4, DARK),
    ],
  }),
};

/**
 * Fixed-wing landing gear (retracts in flight): leg from the airframe's underside down to each wheel, tyre, door.
 * @param {any} def @param {THREE.BufferGeometry[]} hull
 */
export function jetGear(def, hull) {
  const out = [], r = def.wheelRadius;
  for (const w of def.wheels) {
    let topY = 1e9;
    for (const g of hull) {
      const p = g.attributes.position.array;
      for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i] - w.x) < 0.45 && Math.abs(p[i + 2] - w.z) < 0.5 && p[i + 1] > r) topY = Math.min(topY, p[i + 1]);
    }
    if (topY > 20) topY = r * 2 + 0.9;
    const h = Math.max(0.2, topY - r + 0.1);
    out.push(box(0.14, h, 0.14, w.x, r + h / 2, w.z, STEEL), box(0.05, h * 0.5, 0.5, w.x + (w.x >= 0 ? 0.2 : -0.2), topY - h * 0.25, w.z, PAINT),
      cyl(r, r, 0.24, 12, w.x, r, w.z, RUBBER, 0, 0, Math.PI / 2), cyl(r * 0.5, r * 0.5, 0.26, 8, w.x, r, w.z, STEEL, 0, 0, Math.PI / 2));
  }
  return out;
}

export { THREE, PAINT2 };
