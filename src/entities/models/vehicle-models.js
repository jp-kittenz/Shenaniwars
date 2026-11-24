import * as THREE from 'three';
import {
  PAINT, TEAM, DARK, STEEL, RUBBER, TRACK, GLASS, LENS, WOOD, CANVAS,
  box, cyl, tubeZ, tubeX, sphere, cone, side, top, front, ngon, mirror, place, fuselage, rotorGeo, runningGear, wheelGeo, star,
} from './kit.js';
import { importedSpec, cevSpec, transportPlaneSpec, yakGear } from './imported.js';

/**
 * Vehicle model builders. Torsa vehicles are authored in ground coordinates
 * (y = 0 on the ground at rest, +Z forward, +X left) from their reference
 * drawings; turret and gun parts are authored relative to their pivots.
 *
 * @typedef {THREE.BufferGeometry} Geo
 * @typedef {Object} ModelSpec
 * @property {Geo[]} hull
 * @property {boolean} [local]  hull authored in body-local coordinates (no ride offset)
 * @property {Record<number, {yaw?: Geo[], pitch?: Geo[]}>} [mounts]
 * @property {Geo} [wheel]       instanced per wheel (rotates about X)
 * @property {{pos:number[], axis:'x'|'y', dir:number, rate:number, geos:Geo[]}[]} [rotors]
 * @property {{mount:number, pos:number[], rate:number, geos:Geo[]}[]} [spinners]
 * @property {{base:number[], belly?:number, scale?:number}} scheme
 */

const RU_GREEN = [0x4f5b33];
const LAMP = 0xfff0c0;
const RED_LENS = 0x6a1d1d;

// ------------------------------------------------------------------ shared parts

/** Kontakt-style reactive armour bricks laid along a slope. */
function bricks(n, x0, x1, y, z, w, h, d, rx = 0, color = PAINT) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * (i + 0.5)) / n;
    out.push(box(w, h, d, x, y, z, color, rx));
  }
  return out;
}

/** Bank of smoke-grenade dischargers on a turret cheek (mirrored by caller). */
function smokeBank(x, y, z, n, yaw, color = PAINT) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(cyl(0.05, 0.05, 0.26, 6, x, y + (i % 2) * 0.1, z - Math.floor(i / 2) * 0.12, color, Math.PI / 2 - 0.5, yaw, 0));
  return out;
}

/** Remote heavy machine gun on a cupola: [yaw parts, pitch parts]. */
function hmgParts(barrel) {
  return {
    yaw: [box(0.16, 0.3, 0.3, 0, -0.14, -0.02, DARK), box(0.2, 0.16, 0.18, 0.14, -0.06, 0.02, PAINT), box(0.1, 0.1, 0.06, 0.14, -0.04, 0.12, LENS)],
    pitch: [
      box(0.12, 0.15, 0.55, 0, 0, 0.12, DARK), box(0.18, 0.14, 0.22, -0.15, -0.04, 0.05, PAINT),
      tubeZ(0.026, 0.022, 0.38, barrel, 0, 0.02, 6, STEEL), tubeZ(0.04, 0.04, barrel - 0.08, barrel, 0, 0.02, 6, DARK),
    ],
  };
}

/** Light machine gun for door / pintle mounts. */
function lmgParts(barrel) {
  return {
    yaw: [box(0.08, 0.36, 0.08, 0, -0.22, 0, DARK)],
    pitch: [box(0.1, 0.13, 0.62, 0, 0, 0.05, DARK), box(0.12, 0.14, 0.16, -0.1, -0.06, 0.05, PAINT), tubeZ(0.022, 0.02, 0.3, barrel, 0, 0.02, 6, STEEL)],
  };
}

/** BMP-2 / BTR-90 style two-man turret with 30 mm cannon and ATGM launcher. */
function bppuTurret(base) {
  const yaw = [
    top([[0.92, 0.6], [1.02, -0.2], [0.82, -0.92], [0.3, -1.12], [-0.3, -1.12], [-0.82, -0.92], [-1.02, -0.2], [-0.92, 0.6], [-0.42, 0.95], [0.42, 0.95]], base, 0.58, PAINT, 0.74),
    cyl(0.28, 0.3, 0.14, 8, 0.42, base + 0.64, -0.35, PAINT), cyl(0.24, 0.26, 0.12, 8, -0.4, base + 0.62, -0.25, PAINT),
    box(0.22, 0.24, 0.3, 0.55, base + 0.68, 0.35, PAINT), box(0.16, 0.12, 0.04, 0.55, base + 0.7, 0.51, LENS),
    box(0.5, 0.06, 0.4, 0, base + 0.6, -0.65, TEAM),
    ...mirror(smokeBank(0.82, base + 0.28, 0.35, 3, 0.5)),
    cyl(0.012, 0.012, 1.6, 4, -0.7, base + 1.3, -0.8, DARK),
  ];
  const pitch = [
    box(0.42, 0.34, 0.55, 0, 0, 0.0, PAINT), tubeZ(0.065, 0.065, 0.25, 0.9, 0, 0, 8, PAINT),
    tubeZ(0.04, 0.036, 0.9, 2.9, 0, 0, 8, STEEL), tubeZ(0.055, 0.055, 2.75, 3.0, 0, 0, 8, DARK),
    box(0.1, 0.1, 0.22, -0.26, -0.02, 0.25, DARK),
    // Konkurs launch tube on its cradle
    box(0.08, 0.3, 0.12, 0, 0.3, -0.25, DARK), tubeZ(0.085, 0.085, -0.55, 0.75, 0, 0.48, 8, PAINT), tubeZ(0.095, 0.095, 0.65, 0.75, 0, 0.48, 8, DARK),
  ];
  return { yaw, pitch };
}

/** KamAZ cab-over cab with windscreen, lights and mirrors (front at zF). */
function kamazCab(zB, zF, y0, y1, w, opts = {}) {
  const hw = w / 2;
  const parts = [
    side([[zB, y0], [zB, y1], [zF - 0.32, y1 + 0.04], [zF, y1 - 0.42], [zF + 0.02, y0]], w, PAINT),
    box(w - 0.3, 0.62, 0.05, 0, y1 - 0.6, zF - 0.12, GLASS, -0.42), // windscreen
    box(0.04, 0.5, 0.8, hw + 0.005, y1 - 0.62, zF - 0.62, GLASS), box(0.04, 0.5, 0.8, -hw - 0.005, y1 - 0.62, zF - 0.62, GLASS),
    box(w - 0.5, 0.45, 0.06, 0, y0 + 0.55, zF + 0.03, DARK), // grille
    box(w + 0.1, 0.22, 0.25, 0, y0 + 0.08, zF + 0.1, STEEL), // bumper
    box(0.28, 0.16, 0.06, hw - 0.3, y0 + 0.28, zF + 0.06, LAMP), box(0.28, 0.16, 0.06, -hw + 0.3, y0 + 0.28, zF + 0.06, LAMP),
    box(0.06, 0.34, 0.2, hw + 0.25, y1 - 0.55, zF - 0.3, DARK), box(0.06, 0.34, 0.2, -hw - 0.25, y1 - 0.55, zF - 0.3, DARK),
    box(0.04, 0.3, 0.55, hw + 0.01, y0 + 0.8, zF - 0.75, TEAM), box(0.04, 0.3, 0.55, -hw - 0.01, y0 + 0.8, zF - 0.75, TEAM),
    box(w - 0.6, 0.14, 0.8, 0, y1 + 0.08, zB + 0.6, PAINT), // roof hatch / AC unit
  ];
  if (opts.fenders) for (const z of opts.fenders) parts.push(box(w + 0.18, 0.12, 1.1, 0, y0 + 0.08, z, DARK));
  return parts;
}

/** Truck chassis rails, fuel tanks and wheel arches. */
function truckChassis(z0, z1, y, wheelZs, w) {
  const parts = [box(1.0, 0.32, z1 - z0, 0, y, (z0 + z1) / 2, DARK)];
  parts.push(...mirror([tubeZ(0.26, 0.26, -0.6, 0.6, w / 2 - 0.2, y + 0.05, 10, PAINT)]));
  for (const z of wheelZs) parts.push(box(w + 0.15, 0.08, 1.45, 0, y + 0.55, z, DARK));
  return parts;
}

/** Shilka/Pantsir style radar dish (spins about Y). */
function dish(r, color = PAINT) {
  return [
    place(sphere(r, 0, 0, 0, color, 1, 0.35, 1, 10, 4, Math.PI / 2), 0, 0, 0, Math.PI / 2 + 0.35, 0, 0),
    cyl(0.05, 0.05, 0.6, 5, 0, 0.1, 0.25, DARK, Math.PI / 2 - 0.3),
  ];
}

// ------------------------------------------------------------------ Pampalona (placeholders)

function pampalonaColor(hex, teamHex) {
  return new THREE.Color(hex).lerp(new THREE.Color(teamHex), 0.22).getHex();
}

const MG_PARTS = (barrel) => ({
  yaw: [box(0.16, 0.5, 0.16, 0, -0.3, 0, DARK)],
  pitch: [box(0.14, 0.16, 0.9, 0, 0, 0.35, DARK), cyl(0.035, 0.035, 0.6, 5, 0, 0.02, barrel - 0.3, STEEL, Math.PI / 2)],
});

const SANDBAG = 0x9a8862, OLIVE = 0x4f5a3a;
/** Sandbag horseshoe (ground coordinates) around an emplacement. */
const sandbags = (r, h, gapBack = true) => {
  const out = [];
  for (let k = 0; k < 9; k++) {
    const a = -Math.PI * 0.75 + (k / 8) * Math.PI * 1.5;
    if (!gapBack && Math.abs(a) > Math.PI * 0.7) continue;
    for (let row = 0; row < 2; row++) out.push(box(0.75, h / 2, 0.42, Math.sin(a) * r, h / 4 + row * h / 2, Math.cos(a) * r, row ? 0x8f7f5a : SANDBAG, 0, a, 0));
  }
  return out;
};

/** @type {Record<string, (def: any, teamHex: number) => ModelSpec>} */
export const MODELS = {
  hmgturret: () => ({
    local: false,
    scheme: { base: [0x55603a] },
    hull: [...sandbags(1.25, 0.9), box(0.08, 1.05, 0.08, 0.35, 0.52, 0.3, DARK, 0.25, 0, 0.3), box(0.08, 1.05, 0.08, -0.35, 0.52, 0.3, DARK, 0.25, 0, -0.3),
      box(0.08, 1.05, 0.08, 0, 0.52, -0.3, DARK, -0.35)],
    mounts: { 0: { yaw: [box(0.2, 0.25, 0.3, 0, -0.08, 0, DARK)], pitch: [box(0.16, 0.18, 1.0, 0, 0, 0.2, DARK), cyl(0.04, 0.04, 0.8, 6, 0, 0.02, 0.9, STEEL, Math.PI / 2), box(0.3, 0.22, 0.25, 0.22, -0.02, 0.05, OLIVE)] } },
  }),
  aaturret: () => ({
    local: false,
    scheme: { base: [0x56613f] },
    hull: [cyl(1.3, 1.45, 0.25, 10, 0, 0.13, 0, OLIVE), ...sandbags(2.2, 0.8),
      box(0.12, 0.6, 0.12, 1.1, 0.4, 0.9, DARK), box(0.12, 0.6, 0.12, -1.1, 0.4, 0.9, DARK), box(0.12, 0.6, 0.12, 0, 0.4, -1.3, DARK)],
    mounts: { 0: {
      yaw: [box(1.3, 0.25, 1.2, 0, -0.15, -0.1, OLIVE), box(0.5, 0.06, 0.5, 0, -0.1, -0.85, DARK), box(0.12, 0.6, 0.6, 0.55, 0.15, 0.1, OLIVE), box(0.12, 0.6, 0.6, -0.55, 0.15, 0.1, OLIVE)],
      pitch: [box(0.75, 0.3, 1.0, 0, 0, 0.1, OLIVE), cyl(0.05, 0.05, 2.0, 6, 0.28, 0, 1.2, STEEL, Math.PI / 2), cyl(0.05, 0.05, 2.0, 6, -0.28, 0, 1.2, STEEL, Math.PI / 2),
        cyl(0.07, 0.07, 0.3, 6, 0.28, 0, 2.15, DARK, Math.PI / 2), cyl(0.07, 0.07, 0.3, 6, -0.28, 0, 2.15, DARK, Math.PI / 2)],
    } },
  }),
  searchlight: () => ({
    local: false,
    scheme: { base: [0x5a5f55] },
    hull: [...sandbags(1.1, 0.7), cyl(0.12, 0.2, 1.3, 6, 0, 0.65, 0, DARK)],
    mounts: { 0: {
      yaw: [box(0.9, 0.12, 0.25, 0, 0, 0, DARK), box(0.08, 0.5, 0.12, 0.42, 0.22, 0, DARK), box(0.08, 0.5, 0.12, -0.42, 0.22, 0, DARK)],
      pitch: [cyl(0.42, 0.36, 0.7, 12, 0, 0, 0.05, 0x3d4247, Math.PI / 2), cyl(0.38, 0.38, 0.04, 12, 0, 0, 0.42, 0xfff6d0, Math.PI / 2)],
    } },
  }),

  jeep: (def, teamHex) => ({
    local: true,
    scheme: { base: [pampalonaColor(0x7d7350, teamHex)] },
    hull: [
      box(1.9, 0.5, 4.0, 0, 0, 0, PAINT), box(1.8, 0.35, 1.2, 0, 0.42, 1.35, PAINT),
      box(1.7, 0.55, 0.08, 0, 0.75, 0.72, GLASS, -0.25), box(1.9, 0.5, 0.1, 0, 0.5, -1.95, PAINT),
      box(0.1, 0.5, 1.9, 0.9, 0.5, -1.0, PAINT), box(0.1, 0.5, 1.9, -0.9, 0.5, -1.0, PAINT),
      box(0.08, 1.2, 0.08, 0.85, 0.9, -0.2, DARK), box(0.08, 1.2, 0.08, -0.85, 0.9, -0.2, DARK), box(1.78, 0.08, 0.08, 0, 1.5, -0.2, DARK),
      box(2.0, 0.16, 0.2, 0, -0.15, 2.05, DARK), box(0.3, 0.12, 0.06, 0.6, 0.3, 2.02, LAMP), box(0.3, 0.12, 0.06, -0.6, 0.3, 2.02, LAMP),
      box(0.5, 0.06, 1.2, 0, 0.62, 1.35, TEAM),
    ],
    mounts: { 0: MG_PARTS(def.mounts[0].barrel) },
    wheel: wheelGeo(def.wheelRadius, 0.3, 10, DARK, STEEL),
  }),

  tank: (def, teamHex) => ({
    local: true,
    scheme: { base: [pampalonaColor(0x5d6b4c, teamHex)] },
    hull: [
      box(3.4, 0.9, 6.4, 0, 0.1, 0, PAINT), box(3.0, 0.5, 1.6, 0, 0.35, 3.0, PAINT, 0.5),
      box(0.75, 0.95, 6.8, 1.5, -0.3, 0, DARK), box(0.75, 0.95, 6.8, -1.5, -0.3, 0, DARK),
      box(0.85, 0.12, 6.9, 1.5, 0.25, 0, PAINT), box(0.85, 0.12, 6.9, -1.5, 0.25, 0, PAINT),
      box(2.2, 0.3, 1.4, 0, 0.6, -2.4, STEEL), box(0.9, 0.06, 2.4, 0, 0.58, 1.6, TEAM),
      ...def.wheels.map((w) => cyl(def.wheelRadius, def.wheelRadius, 0.5, 8, w.pos[0] * 1.08, w.pos[1] - 0.25, w.pos[2], STEEL, 0, 0, Math.PI / 2)),
    ],
    mounts: {
      0: {
        yaw: [box(2.3, 0.75, 2.9, 0, 0, -0.2, PAINT), box(1.7, 0.6, 0.9, 0, 0, 1.5, PAINT), box(0.7, 0.25, 0.7, -0.5, 0.5, -0.5, STEEL), box(1.2, 0.05, 1.2, 0, 0.39, -0.3, TEAM)],
        pitch: [cyl(0.11, 0.13, 4.4, 8, 0, 0, 2.4, STEEL, Math.PI / 2), cyl(0.17, 0.17, 0.5, 8, 0, 0, 4.4, DARK, Math.PI / 2)],
      },
      1: MG_PARTS(def.mounts[1].barrel),
    },
  }),

  heli: (def, teamHex) => ({
    local: true,
    scheme: { base: [pampalonaColor(0x56606a, teamHex)] },
    hull: [
      box(1.7, 1.5, 3.4, 0, 0, 0.6, PAINT), box(1.5, 0.9, 1.4, 0, 0.25, 2.5, GLASS, 0.35), box(1.3, 0.7, 1.0, 0, -0.35, 2.7, PAINT),
      box(0.5, 0.5, 4.6, 0, 0.35, -3.2, PAINT), box(0.12, 1.5, 0.9, 0, 1.0, -5.1, PAINT), box(1.6, 0.1, 0.6, 0, 0.5, -5.0, PAINT),
      box(1.1, 0.5, 1.6, 0, 0.95, 0.3, STEEL), box(3.6, 0.12, 0.9, 0, -0.35, 0.9, PAINT),
      cyl(0.28, 0.28, 1.5, 7, 1.55, -0.55, 1.0, DARK, Math.PI / 2), cyl(0.28, 0.28, 1.5, 7, -1.55, -0.55, 1.0, DARK, Math.PI / 2),
      box(0.1, 0.1, 3.4, 0.85, -0.95, 0.8, DARK), box(0.1, 0.1, 3.4, -0.85, -0.95, 0.8, DARK),
      box(0.08, 0.35, 0.08, 0.85, -0.78, 1.8, DARK), box(0.08, 0.35, 0.08, -0.85, -0.78, 1.8, DARK),
      box(0.08, 0.35, 0.08, 0.85, -0.78, -0.2, DARK), box(0.08, 0.35, 0.08, -0.85, -0.78, -0.2, DARK),
      box(0.5, 0.05, 1.4, 0, 0.76, 1.3, TEAM),
    ],
    mounts: { 1: MG_PARTS(def.mounts[1].barrel) },
    rotors: [
      { pos: [0, 1.35, 0.3], axis: 'y', dir: 1, rate: 34, geos: [box(10.5, 0.06, 0.34, 0, 0, 0, DARK), box(0.34, 0.06, 10.5, 0, 0, 0, DARK), cyl(0.12, 0.12, 0.4, 6, 0, -0.15, 0, STEEL)] },
      { pos: [0.14, 1.2, -5.1], axis: 'x', dir: 1, rate: 50, geos: [box(0.05, 1.9, 0.18, 0, 0, 0, DARK), box(0.05, 0.18, 1.9, 0, 0, 0, DARK)] },
    ],
  }),

  // ------------------------------------------------------------------ TORSA

  /** T-90: welded turret with Kontakt-5 clamshell, Shtora dazzlers, six road wheels. */
  mbt: () => ({
    scheme: { base: RU_GREEN },
    hull: [
      side([[-3.4, 0.45], [-3.4, 1.1], [3.4, 1.1], [3.05, 0.45]], 2.3, PAINT),
      side([[-3.45, 1.05], [-3.45, 1.45], [-3.3, 1.6], [2.1, 1.6], [3.5, 1.05]], 3.45, PAINT),
      // upper glacis ERA: two rows of bricks
      ...bricks(6, -1.35, 1.35, 1.36, 2.84, 0.4, 0.12, 0.7, 0.374), ...bricks(6, -1.35, 1.35, 1.2, 3.2, 0.4, 0.1, 0.36, 0.374),
      box(0.42, 0.22, 0.46, 0, 1.62, 2.05, PAINT), cyl(0.24, 0.26, 0.08, 8, 0, 1.64, 2.05, DARK), // driver's hatch
      ...mirror([
        side([[-3.25, 0.62], [-3.25, 1.08], [3.25, 1.08], [3.45, 0.78], [3.3, 0.62]], 0.06, PAINT, 1.75),
        side([[1.35, 0.6], [1.35, 1.06], [3.3, 1.06], [3.4, 0.78], [3.3, 0.6]], 0.1, PAINT, 1.8), // ERA skirt panels
        box(0.05, 0.16, 0.9, 1.79, 0.84, -0.8, TEAM),
        box(0.18, 0.12, 0.08, 1.2, 1.2, 3.42, LAMP),
        box(0.06, 0.32, 1.6, 1.76, 1.3, -2.2, DARK), // exhaust louvre
        ...runningGear({ x: 1.41, w: 0.58, zs: [-2.45, -1.48, -0.5, 0.48, 1.45, 2.42], r: 0.37, zRear: -3.05, zFront: 3.0, top: 0.82, rollers: [-2.0, -0.2, 1.6] }),
      ]),
      tubeX(0.28, 0.85, 0.55, 1.28, -3.68, 10, PAINT), tubeX(0.28, 0.85, -0.55, 1.28, -3.68, 10, PAINT), // fuel drums
      tubeX(0.12, 3.1, 0, 1.62, -3.42, 8, WOOD), // unditching log
    ],
    mounts: {
      0: {
        yaw: [
          top([[1.2, 0.75], [1.25, 0], [1.15, -0.75], [0.85, -1.3], [0.4, -1.55], [-0.4, -1.55], [-0.85, -1.3], [-1.15, -0.75], [-1.25, 0], [-1.2, 0.75], [-0.6, 1.15], [0.6, 1.15]], -0.42, 0.72, PAINT, 0.86),
          ...mirror([
            top([[0.3, 1.12], [1.22, 0.62], [1.42, 0.98], [0.42, 1.62]], -0.32, 0.5, PAINT, 0.94),
            box(0.36, 0.28, 0.3, 0.75, 0.42, 0.95, PAINT), box(0.24, 0.18, 0.05, 0.75, 0.43, 1.11, RED_LENS),
            ...smokeBank(1.1, 0.12, 0.45, 6, 0.6),
            box(0.04, 0.2, 0.75, 1.2, 0.0, -0.25, TEAM),
          ]),
          box(0.34, 0.3, 0.44, 0.48, 0.45, 0.45, PAINT), box(0.24, 0.16, 0.04, 0.48, 0.47, 0.68, LENS), // gunner's sight
          cyl(0.38, 0.4, 0.2, 10, -0.52, 0.38, -0.4, PAINT), // commander's cupola
          box(1.9, 0.5, 0.48, 0, 0.02, -1.72, PAINT), box(1.92, 0.04, 0.5, 0, 0.18, -1.72, STEEL), // bustle box
          cyl(0.014, 0.014, 2.4, 4, 0.85, 1.4, -1.2, DARK),
          ...bricks(4, -0.75, 0.75, 0.33, 0.95, 0.34, 0.1, 0.4),
        ],
        pitch: [
          box(0.72, 0.56, 0.5, 0, 0, 0.1, PAINT),
          tubeZ(0.1, 0.088, 0.3, 5.9, 0, 0, 10, PAINT),
          ...[1.4, 2.4, 4.1, 5.0].map((z) => tubeZ(0.112, 0.112, z, z + 0.07, 0, 0, 10, DARK)),
          tubeZ(0.135, 0.135, 2.7, 3.45, 0, 0, 10, PAINT),
          box(0.12, 0.08, 0.16, 0, 0.12, 5.8, DARK),
        ],
      },
      2: hmgParts(1.05),
    },
  }),

  /** T-80U: angular turret wrapped in reactive bricks, rubber-tyred road wheels, rear drums. */
  ht: () => ({
    scheme: { base: [0x4b5631] },
    hull: [
      side([[-3.55, 0.45], [-3.55, 1.1], [3.5, 1.1], [3.15, 0.45]], 2.35, PAINT),
      side([[-3.6, 1.05], [-3.6, 1.45], [-3.45, 1.62], [2.2, 1.62], [3.6, 1.05]], 3.5, PAINT),
      ...bricks(7, -1.45, 1.45, 1.4, 2.82, 0.36, 0.14, 0.72, 0.385), ...bricks(7, -1.45, 1.45, 1.22, 3.24, 0.36, 0.12, 0.42, 0.385),
      box(0.42, 0.22, 0.46, 0, 1.64, 2.12, PAINT),
      ...mirror([
        side([[-3.4, 0.6], [-3.4, 1.08], [3.35, 1.08], [3.55, 0.78], [3.4, 0.6]], 0.06, PAINT, 1.78),
        ...[0.55, 1.35, 2.15, 2.9].map((z) => box(0.12, 0.42, 0.72, 1.84, 0.84, z, PAINT)),
        box(0.05, 0.16, 0.9, 1.82, 0.84, -1.0, TEAM),
        box(0.18, 0.12, 0.08, 1.25, 1.2, 3.52, LAMP),
        ...runningGear({ x: 1.45, w: 0.58, zs: [-2.55, -1.55, -0.55, 0.45, 1.45, 2.45], r: 0.39, zRear: -3.2, zFront: 3.15, top: 0.84, rollers: [-2.05, -1.05, 0, 0.95, 1.95] }),
      ]),
      tubeX(0.3, 0.9, 0.62, 1.3, -3.82, 10, PAINT), tubeX(0.3, 0.9, -0.62, 1.3, -3.82, 10, PAINT),
      box(2.2, 0.35, 0.8, 0, 1.75, -2.8, DARK), // turbine exhaust grille
    ],
    mounts: {
      0: {
        yaw: [
          top([[1.25, 0.65], [1.35, -0.1], [1.25, -0.8], [0.9, -1.35], [0.35, -1.6], [-0.35, -1.6], [-0.9, -1.35], [-1.25, -0.8], [-1.35, -0.1], [-1.25, 0.65], [-0.65, 1.1], [0.65, 1.1]], -0.46, 0.76, PAINT, 0.88),
          ...mirror([
            ...[0, 1, 2, 3, 4, 5].map((i) => {
              const a = 0.32 + i * 0.2, r = 1.32;
              return box(0.36, 0.42, 0.26, Math.sin(a) * r, -0.05, Math.cos(a) * r + 0.05, PAINT, 0, a, 0);
            }),
            ...smokeBank(1.2, 0.15, 0.3, 4, 0.7),
            box(0.04, 0.2, 0.7, 1.28, 0.02, -0.55, TEAM),
          ]),
          ...bricks(5, -0.95, 0.95, 0.33, 0.7, 0.34, 0.1, 0.42), ...bricks(5, -0.95, 0.95, 0.33, 0.25, 0.34, 0.1, 0.42),
          box(0.34, 0.3, 0.44, 0.52, 0.45, 0.2, PAINT), box(0.24, 0.16, 0.04, 0.52, 0.47, 0.43, LENS),
          cyl(0.4, 0.42, 0.22, 10, -0.55, 0.4, -0.45, PAINT),
          tubeZ(0.23, 0.23, 0.6, 0.8, -0.95, 0.5, 10, PAINT), tubeZ(0.18, 0.18, 0.79, 0.82, -0.95, 0.5, 10, GLASS), // IR searchlight
          box(2.1, 0.55, 0.55, 0, 0.0, -1.85, PAINT), tubeZ(0.14, 0.14, -2.6, -2.0, 0, 0.12, 8, PAINT), // bustle + snorkel
          cyl(0.014, 0.014, 2.4, 4, 0.9, 1.4, -1.3, DARK),
        ],
        pitch: [
          box(0.76, 0.6, 0.55, 0, 0, 0.1, PAINT),
          tubeZ(0.1, 0.088, 0.3, 6.0, 0, 0, 10, PAINT),
          ...[1.3, 2.4, 4.2, 5.1].map((z) => tubeZ(0.112, 0.112, z, z + 0.07, 0, 0, 10, DARK)),
          tubeZ(0.135, 0.135, 2.75, 3.5, 0, 0, 10, PAINT),
        ],
      },
      2: hmgParts(1.05),
    },
  }),

  /** 2S25 Sprut-SD: tall boat-shaped hull, seven small road wheels, low wide turret, very long gun. */
  lt: () => ({
    scheme: { base: RU_GREEN },
    hull: [
      side([[-3.5, 0.48], [-3.5, 1.05], [3.45, 1.05], [2.8, 0.48]], 2.2, PAINT),
      side([[-3.6, 1.0], [-3.6, 1.75], [2.0, 1.8], [3.6, 1.22], [3.5, 1.0]], 3.05, PAINT),
      box(2.7, 0.08, 0.55, 0, 1.28, 3.55, PAINT, 0.9), // folded trim vane
      box(0.42, 0.2, 0.5, 0.6, 1.86, 2.2, PAINT), box(0.3, 0.1, 0.05, 0.6, 1.9, 2.46, LENS),
      ...mirror([
        box(0.18, 0.12, 0.08, 1.15, 1.45, 3.45, LAMP),
        box(0.05, 0.18, 1.0, 1.54, 1.45, -0.6, TEAM),
        box(0.36, 0.36, 0.06, 0.55, 1.05, -3.62, DARK), // water-jet outlets
        box(0.04, 0.1, 6.6, 1.53, 1.15, 0, DARK), // splash strake
        ...runningGear({ x: 1.3, w: 0.42, zs: [-2.85, -1.9, -0.95, 0, 0.95, 1.9, 2.85], r: 0.31, zRear: -3.25, zFront: 3.3, top: 0.74, idlerY: 0.62, rollers: [-1.4, 0.5, 2.3] }),
      ]),
      box(1.2, 0.9, 0.06, 0, 1.3, -3.62, DARK), // rear doors
    ],
    mounts: {
      0: {
        yaw: [
          top([[1.25, 0.6], [1.3, -0.4], [1.0, -1.25], [0.4, -1.5], [-0.4, -1.5], [-1.0, -1.25], [-1.3, -0.4], [-1.25, 0.6], [-0.7, 1.1], [0.7, 1.1]], -0.28, 0.54, PAINT, 0.85),
          box(0.32, 0.3, 0.4, 0.55, 0.38, 0.35, PAINT), box(0.22, 0.14, 0.04, 0.55, 0.4, 0.56, LENS),
          box(0.3, 0.26, 0.36, -0.5, 0.36, -0.2, PAINT), box(0.2, 0.12, 0.04, -0.5, 0.38, -0.01, LENS),
          ...mirror([...smokeBank(1.05, 0.05, 0.3, 4, 0.6), box(0.04, 0.16, 0.6, 1.24, -0.05, -0.3, TEAM), box(0.12, 0.12, 0.1, 0.95, 0.18, 0.8, RED_LENS)]),
          box(1.4, 0.32, 0.4, 0, -0.08, -1.55, PAINT),
          cyl(0.012, 0.012, 2.2, 4, -0.85, 1.3, -1.1, DARK),
        ],
        pitch: [
          box(0.66, 0.5, 0.42, 0, 0, 0.05, PAINT),
          tubeZ(0.092, 0.08, 0.25, 6.1, 0, 0, 10, PAINT),
          ...[1.2, 2.3, 4.0, 5.0].map((z) => tubeZ(0.102, 0.102, z, z + 0.07, 0, 0, 10, DARK)),
          tubeZ(0.125, 0.125, 2.6, 3.3, 0, 0, 10, PAINT),
        ],
      },
    },
  }),

  /** BTR-90: 8×8 boat hull with inward-sloped sides, side door and BPPU turret. */
  apc: () => ({
    scheme: { base: RU_GREEN },
    hull: [
      side([[-3.8, 0.55], [-3.8, 1.3], [3.85, 1.3], [3.2, 0.55]], 2.05, PAINT),
      front([[-1.45, 1.25], [1.45, 1.25], [1.15, 2.15], [-1.15, 2.15]], -3.75, 1.85, PAINT),
      side([[1.8, 1.25], [1.8, 2.15], [3.95, 1.3], [3.75, 1.2]], 2.6, PAINT), // glacis
      box(2.4, 0.07, 0.55, 0, 1.45, 3.9, PAINT, 1.0), // trim vane
      ...mirror([
        box(0.1, 0.64, 1.0, 1.29, 1.55, 0.05, DARK, 0, 0, 0.32), // side door
        box(0.06, 0.5, 0.08, 1.35, 1.48, -0.6, TEAM),
        box(0.2, 0.14, 0.08, 1.0, 1.55, 3.5, LAMP),
        ...[-2.45, -0.95, 0.95, 2.45].map((z) => box(0.36, 0.5, 1.45, 1.32, 1.42, z, PAINT)), // wheel arches
        box(0.1, 0.1, 0.16, 1.1, 1.95, 2.0, LENS), box(0.1, 0.1, 0.16, 1.1, 1.95, -1.4, LENS),
      ]),
      box(1.4, 0.3, 0.5, -0.45, 2.22, -2.6, DARK), // engine deck grille
      box(0.5, 0.12, 0.6, 0.6, 2.22, 2.45, PAINT), // driver's hatch
      cyl(0.012, 0.012, 2.2, 4, -1.0, 3.2, -3.2, DARK),
    ],
    mounts: { 0: bppuTurret(-0.4) },
    wheel: wheelGeo(0.6, 0.45, 12, RUBBER, PAINT, 0.5),
  }),

  /** BMP-2: low ribbed glacis, six spoked road wheels, BPPU turret amidships, rear doors. */
  ifv: () => ({
    scheme: { base: RU_GREEN },
    hull: [
      side([[-3.35, 0.42], [-3.35, 1.05], [3.4, 1.05], [2.7, 0.42]], 2.2, PAINT),
      side([[-3.4, 1.0], [-3.35, 1.62], [1.9, 1.65], [3.45, 1.08], [3.35, 1.0]], 3.0, PAINT),
      ...[2.15, 2.45, 2.75, 3.05].map((z) => box(2.6, 0.04, 0.06, 0, 1.65 - (z - 1.9) * 0.37 + 0.04, z, DARK, 0.37)), // glacis ribs
      box(2.9, 0.06, 0.4, 0, 1.12, 3.48, PAINT, 1.1),
      ...mirror([
        box(0.18, 0.12, 0.08, 1.2, 1.25, 3.38, LAMP),
        box(0.05, 0.18, 0.9, 1.51, 1.25, -0.8, TEAM),
        box(0.55, 0.06, 0.62, 0.5, 1.66, -1.7, PAINT), box(0.55, 0.06, 0.62, 0.5, 1.66, -2.5, PAINT), // troop hatches
        box(0.52, 0.5, 0.08, 0.5, 1.25, -3.42, PAINT), // rear doors (fuel-tank doors)
        box(0.08, 0.08, 0.12, 1.5, 1.4, -1.2, LENS), box(0.08, 0.08, 0.12, 1.5, 1.4, -2.2, LENS),
        ...runningGear({ x: 1.27, w: 0.4, zs: [-2.35, -1.45, -0.55, 0.35, 1.25, 2.15], r: 0.38, zRear: -2.95, zFront: 3.0, top: 0.86, sprocketY: 0.62, idlerY: 0.55, rollers: [-1.9, -0.1, 1.7] }),
      ]),
      box(1.3, 0.28, 0.9, -0.5, 1.7, 1.1, DARK), // engine grille
    ],
    mounts: { 0: bppuTurret(-0.45) },
  }),

  /** KamAZ-5350 6×6 troop transport with green canvas tilt. */
  truck: () => ({
    scheme: { base: RU_GREEN },
    hull: [
      ...truckChassis(-3.9, 3.0, 0.95, [2.75, -2.15], 2.4),
      ...kamazCab(2.2, 3.95, 1.05, 3.0, 2.45, { fenders: [] }),
      box(2.5, 0.16, 5.85, 0, 1.43, -0.98, PAINT), // bed floor
      ...mirror([box(0.06, 0.5, 5.85, 1.22, 1.7, -0.98, PAINT)]), box(2.5, 0.5, 0.06, 0, 1.7, -3.88, PAINT),
      side([[-3.9, 1.95], [-3.9, 3.05], [-3.75, 3.27], [1.7, 3.27], [1.85, 3.05], [1.85, 1.95]], 2.46, 0x5b6440),
      ...[-3.0, -1.6, -0.2, 1.2].map((z) => box(2.5, 0.05, 0.06, 0, 3.28, z, 0x4a5235)),
      box(0.04, 0.4, 1.4, 1.24, 2.6, -1.0, TEAM), box(0.04, 0.4, 1.4, -1.24, 2.6, -1.0, TEAM),
      cyl(0.07, 0.07, 1.4, 6, -1.1, 2.6, 2.1, DARK), // exhaust stack
    ],
    wheel: wheelGeo(0.6, 0.45, 12, RUBBER, PAINT, 0.5),
  }),

  /** KamAZ-4310 supply truck: khaki canvas, spare wheel, open tail with ammo crates. */
  supply: () => ({
    scheme: { base: RU_GREEN },
    hull: [
      ...truckChassis(-3.8, 2.9, 0.95, [2.6, -2.05], 2.4),
      ...kamazCab(2.05, 3.8, 1.05, 3.0, 2.45),
      tubeX(0.58, 0.4, 0.7, 2.0, 1.75, 12, RUBBER), tubeX(0.3, 0.42, 0.7, 2.0, 1.75, 8, PAINT), // spare wheel
      box(2.5, 0.16, 5.6, 0, 1.43, -0.95, PAINT),
      ...mirror([box(0.06, 0.5, 5.6, 1.22, 1.7, -0.95, PAINT)]),
      side([[-3.0, 1.95], [-3.0, 3.0], [-2.85, 3.2], [1.45, 3.2], [1.6, 3.0], [1.6, 1.95]], 2.46, CANVAS),
      // stacked crates visible at the open tail
      ...[[0.6, 1.72, -3.35], [-0.1, 1.72, -3.35], [0.25, 2.12, -3.35], [-0.65, 1.72, -3.35]].map(([x, y, z]) => box(0.6, 0.38, 0.7, x, y, z, 0x4c5a32)),
      box(0.04, 0.5, 0.5, 1.24, 2.55, -0.6, TEAM), box(0.04, 0.5, 0.5, -1.24, 2.55, -0.6, TEAM),
      ...[2.42, 2.55, 2.68].map((y) => box(0.05, 0.05, 0.36, 1.25, y, -0.6, DARK)), // stencilled supply bars
      cyl(0.012, 0.012, 2.4, 4, -1.0, 4.1, 2.3, DARK),
    ],
    wheel: wheelGeo(0.6, 0.45, 12, RUBBER, PAINT, 0.5),
  }),

  /** 9A53 Uragan-1M on an 8×8 chassis: big cab, equipment module, twin launch pods. */
  mlrs: () => ({
    scheme: { base: RU_GREEN },
    hull: [
      box(1.4, 0.4, 10.4, 0, 1.15, -0.95, DARK),
      box(2.8, 0.3, 8.0, 0, 1.5, -2.0, PAINT),
      side([[3.6, 1.25], [3.6, 3.35], [5.5, 3.42], [6.15, 2.9], [6.25, 1.25]], 2.85, PAINT),
      box(2.4, 0.7, 0.05, 0, 2.85, 6.02, GLASS, -0.62), ...mirror([box(0.04, 0.55, 1.0, 1.43, 2.85, 4.8, GLASS), box(0.04, 0.3, 0.6, 1.44, 2.0, 4.6, TEAM)]),
      box(2.0, 0.5, 0.06, 0, 1.75, 6.27, DARK), box(2.95, 0.26, 0.3, 0, 1.22, 6.3, STEEL),
      ...mirror([box(0.3, 0.16, 0.06, 1.2, 2.0, 6.27, LAMP)]),
      box(2.6, 1.3, 1.3, 0, 2.3, 2.85, PAINT), box(2.62, 0.5, 0.6, 0, 2.2, 2.85, DARK), // equipment module
      ...mirror([box(0.3, 0.35, 0.3, 1.25, 0.95, -6.0, DARK), tubeZ(0.28, 0.28, -0.4, 0.8, 1.15, 1.25, 10, PAINT)]), // jacks + tanks
      ...[4.3, 2.75, -2.0, -3.6].map((z) => box(3.0, 0.08, 1.6, 0, 1.75, z, DARK)),
      cyl(0.95, 1.05, 0.4, 12, 0, 1.85, -5.3, PAINT),
    ],
    mounts: {
      0: {
        yaw: [box(1.6, 0.5, 1.4, 0, -0.5, 0.2, PAINT), ...mirror([box(0.16, 0.8, 0.5, 0.8, -0.2, 0, DARK)])],
        pitch: [
          ...mirror([box(1.2, 1.24, 7.6, 0.68, 0.64, 3.8, PAINT)]),
          ...[1.5, 4.0, 6.5].map((z) => box(2.62, 1.3, 0.12, 0, 0.64, z, STEEL)),
          ...[0.95, 0.4, -0.4, -0.95].flatMap((x) => [0.28, 0.72, 1.05].map((y) => tubeZ(0.15, 0.15, 7.55, 7.62, x, y, 8, DARK))),
          box(0.6, 0.2, 0.06, 0.68, 1.05, 0.2, TEAM),
        ],
      },
    },
    wheel: wheelGeo(0.68, 0.5, 12, RUBBER, PAINT, 0.5),
  }),

  /** 2S19 Msta-S: T-80 derived hull, very large boxy turret, 152 mm gun with muzzle brake. */
  howitzer: () => ({
    scheme: { base: RU_GREEN },
    hull: [
      side([[-3.35, 0.45], [-3.35, 1.1], [3.3, 1.1], [2.95, 0.45]], 2.3, PAINT),
      side([[-3.45, 1.0], [-3.45, 1.5], [-3.3, 1.62], [2.0, 1.65], [3.45, 1.05]], 3.38, PAINT),
      box(2.9, 0.5, 0.12, 0, 0.62, 3.25, PAINT, -0.35), // dozer blade
      box(0.42, 0.22, 0.46, 0, 1.67, 2.2, PAINT),
      ...mirror([
        side([[-3.2, 0.62], [-3.2, 1.08], [3.2, 1.08], [3.4, 0.78], [3.25, 0.62]], 0.06, PAINT, 1.72),
        box(0.18, 0.12, 0.08, 1.2, 1.2, 3.38, LAMP),
        ...runningGear({ x: 1.38, w: 0.56, zs: [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5], r: 0.37, zRear: -3.1, zFront: 3.05, top: 0.82, rollers: [-2.0, -1.0, 0, 1.0, 2.0] }),
      ]),
    ],
    mounts: {
      0: {
        yaw: [
          top([[1.45, 1.3], [1.5, -2.0], [1.3, -2.3], [-1.3, -2.3], [-1.5, -2.0], [-1.45, 1.3], [-0.9, 1.75], [0.9, 1.75]], -0.7, 1.3, PAINT, 0.95),
          ...mirror([
            box(0.05, 0.3, 1.2, 1.45, 0.05, -0.4, TEAM),
            ...smokeBank(1.35, 0.25, 1.2, 6, 0.6),
            box(0.08, 0.5, 0.7, 1.48, -0.1, -1.4, DARK), // side hatch
          ]),
          box(0.36, 0.34, 0.5, 0.75, 0.75, 0.9, PAINT), box(0.26, 0.18, 0.04, 0.75, 0.77, 1.16, LENS),
          cyl(0.4, 0.42, 0.24, 10, -0.8, 0.72, -1.3, PAINT),
          box(1.6, 0.55, 0.6, 0, -0.35, -2.55, PAINT), // ammunition conveyor
          cyl(0.014, 0.014, 2.4, 4, 1.0, 1.7, -1.8, DARK),
        ],
        pitch: [
          box(0.95, 0.8, 0.65, 0, 0, 0.12, PAINT),
          ...mirror([tubeZ(0.1, 0.1, 0.3, 1.7, 0.28, 0.32, 8, PAINT)]),
          tubeZ(0.115, 0.1, 0.4, 6.3, 0, 0, 10, PAINT),
          tubeZ(0.13, 0.13, 3.5, 4.2, 0, 0, 10, PAINT),
          box(0.44, 0.3, 0.5, 0, 0, 6.48, DARK), box(0.46, 0.08, 0.1, 0, 0, 6.38, STEEL), box(0.46, 0.08, 0.1, 0, 0, 6.58, STEEL),
        ],
      },
      1: hmgParts(1.05),
    },
  }),

  /** Pantsir-S1 on an 8×8 KamAZ: cab, equipment cabin, turret with radars, twin 30 mm and 12 missiles. */
  sam: () => ({
    scheme: { base: RU_GREEN },
    hull: [
      ...truckChassis(-4.75, 3.2, 1.0, [3.15, 1.75, -1.6, -3.0], 2.4),
      ...kamazCab(3.25, 4.75, 1.1, 3.0, 2.5),
      box(2.5, 1.45, 2.4, 0, 2.32, 1.95, PAINT), box(0.04, 0.9, 1.6, 1.26, 2.3, 1.95, DARK), box(0.04, 0.9, 1.6, -1.26, 2.3, 1.95, DARK),
      box(2.5, 0.14, 5.4, 0, 1.6, -2.0, PAINT),
      box(2.4, 1.15, 4.1, 0, 2.2, -1.95, PAINT),
      ...mirror([box(0.05, 0.5, 2.0, 1.21, 2.2, -2.0, TEAM), box(0.3, 0.8, 0.12, 1.15, 1.6, -4.6, DARK)]),
    ],
    mounts: {
      0: {
        yaw: [
          top([[0.78, 1.0], [0.88, -1.15], [-0.88, -1.15], [-0.78, 1.0]], -0.45, 0.9, PAINT, 0.9),
          box(1.2, 0.8, 0.14, 0, 0.0, 1.05, PAINT), cyl(0.36, 0.36, 0.06, 12, 0, 0.0, 1.13, DARK, Math.PI / 2), // tracking radar
          cyl(0.1, 0.12, 0.5, 6, 0, 0.7, -0.6, DARK),
        ],
        pitch: [
          ...mirror([
            box(0.2, 0.5, 0.9, 0.85, 0.1, 0.1, PAINT), // side arms
            ...[0.78, 1.02].flatMap((x) => [0.36, 0.63, 0.9].map((y) => tubeZ(0.11, 0.11, -1.4, 1.62, x, y, 8, PAINT))),
            box(0.34, 0.3, 0.9, 1.3, -0.1, 0.2, DARK),
            tubeZ(0.035, 0.03, 0.6, 1.75, 1.3, -0.22, 6, STEEL), tubeZ(0.035, 0.03, 0.6, 1.75, 1.3, 0.02, 6, STEEL),
          ]),
        ],
      },
    },
    spinners: [{ mount: 0, pos: [0, 1.05, -0.6], rate: 2.5, geos: [box(1.7, 0.55, 0.12, 0, 0, 0, PAINT), box(1.5, 0.42, 0.04, 0, 0, 0.07, DARK)] }],
    wheel: wheelGeo(0.6, 0.45, 12, RUBBER, PAINT, 0.5),
  }),

  /** ZSU-23-4 Shilka: light tracked hull, flat box turret, quad 23 mm, rear radar dish. */
  spaag: () => ({
    scheme: { base: RU_GREEN },
    hull: [
      side([[-3.2, 0.42], [-3.2, 0.98], [3.2, 0.98], [2.75, 0.42]], 2.2, PAINT),
      side([[-3.25, 0.95], [-3.25, 1.45], [2.2, 1.55], [3.3, 1.05], [3.2, 0.95]], 3.1, PAINT),
      box(0.4, 0.18, 0.44, 0.6, 1.6, 2.4, PAINT),
      ...mirror([
        box(0.18, 0.12, 0.08, 1.2, 1.15, 3.2, LAMP),
        box(0.05, 0.16, 0.9, 1.56, 1.2, -1.2, TEAM),
        ...runningGear({ x: 1.22, w: 0.38, zs: [-2.4, -1.45, -0.5, 0.45, 1.4, 2.35], r: 0.33, zRear: -2.9, zFront: 2.95, top: 0.72, rollers: [] }),
      ]),
    ],
    mounts: {
      0: {
        yaw: [
          top([[1.4, 1.1], [1.45, -1.6], [-1.45, -1.6], [-1.4, 1.1], [-1.1, 1.35], [1.1, 1.35]], -0.43, 0.76, PAINT, 0.95),
          ...mirror([box(0.05, 0.2, 1.0, 1.43, -0.05, -0.4, TEAM), box(0.2, 0.18, 0.3, 0.9, 0.42, -0.9, PAINT)]),
          box(0.9, 0.12, 0.7, 0, 0.36, 0.95, DARK), // gun port
          cyl(0.08, 0.08, 0.7, 6, 0, 0.6, -1.3, DARK), // radar mast
        ],
        pitch: [
          box(0.9, 0.5, 0.6, 0, 0.05, 0.05, DARK),
          ...[[0.3, 0.2], [-0.3, 0.2], [0.3, -0.04], [-0.3, -0.04]].flatMap(([x, y]) => [
            tubeZ(0.07, 0.07, 0.2, 1.0, x, y, 8, PAINT), tubeZ(0.03, 0.028, 1.0, 2.1, x, y, 6, STEEL),
          ]),
        ],
      },
    },
    spinners: [{ mount: 0, pos: [0, 1.0, -1.35], rate: 1.6, geos: dish(0.62) }],
  }),

  /** Ka-52: coaxial rotors, side-by-side cockpit, stub wings with rocket pods and Vikhr tubes. */
  attackheli: () => ({
    scheme: { base: [0x4b5154], belly: 0x5b6265 },
    hull: [
      fuselage([[4.65, 0.15, 1.2, 1.45], [4.3, 0.45, 0.95, 1.85], [3.6, 0.72, 0.8, 2.15], [2.6, 0.82, 0.75, 2.2], [1.2, 0.85, 0.72, 2.3],
        [0.0, 0.85, 0.75, 2.35], [-1.2, 0.7, 0.95, 2.3], [-2.5, 0.42, 1.35, 2.2], [-4.5, 0.3, 1.55, 2.1], [-6.0, 0.22, 1.65, 2.05]], PAINT, 0, 12),
      fuselage([[3.55, 0.5, 2.05, 2.15], [3.0, 0.7, 2.05, 2.7], [2.0, 0.72, 2.1, 2.85], [1.25, 0.6, 2.15, 2.6]], GLASS, 0, 10),
      box(0.04, 0.7, 0.04, 0, 2.5, 2.6, DARK), box(1.4, 0.04, 0.04, 0, 2.75, 2.2, DARK),
      cyl(0.18, 0.28, 1.0, 8, 0, 2.85, 0, DARK), // rotor mast fairing
      ...mirror([
        fuselage([[1.1, 0.25, 2.15, 2.55], [0.6, 0.33, 2.1, 2.7], [-0.6, 0.33, 2.1, 2.7], [-1.2, 0.22, 2.2, 2.55]], PAINT, 0.75, 8),
        tubeZ(0.14, 0.12, -1.35, -1.15, 0.75, 2.38, 8, DARK),
        top([[0.8, 0.8], [3.3, 0.6], [3.3, 0.05], [0.8, -0.25]], 1.5, 0.12, PAINT),
        tubeZ(0.14, 0.14, -0.2, 0.9, 3.38, 1.55, 8, PAINT),
        box(0.08, 0.3, 0.3, 2.35, 1.38, 0.45, DARK), tubeZ(0.25, 0.25, -0.35, 1.25, 2.35, 1.05, 10, PAINT), tubeZ(0.22, 0.22, 1.24, 1.27, 2.35, 1.05, 10, DARK),
        box(0.08, 0.25, 0.3, 3.05, 1.42, 0.5, DARK), ...[[0.1, 0], [-0.1, 0], [0, 0.17]].map(([dx, dy]) => tubeZ(0.08, 0.08, -0.5, 1.3, 3.05 + dx, 1.2 + dy, 6, 0x6d7458)),
        side([[-5.0, 1.6], [-5.9, 1.5], [-6.25, 2.95], [-5.6, 2.95]], 0.08, PAINT, 1.62),
        place(cyl(0.08, 0.08, 0.06, 5, 0, 0, 0, TEAM), 1.67, 2.3, -5.7, 0, 0, Math.PI / 2),
        box(0.08, 0.5, 0.08, 0.85, 0.45, -0.6, DARK), tubeX(0.26, 0.2, 0.9, 0.26, -0.6, 10, RUBBER),
      ]),
      top([[1.6, -5.2], [1.6, -5.65], [-1.6, -5.65], [-1.6, -5.2]], 2.0, 0.08, PAINT),
      box(0.08, 0.6, 0.08, 0, 0.6, 3.5, DARK), tubeX(0.2, 0.18, 0, 0.2, 3.5, 8, RUBBER),
      side(star(0.32).map(([u, v]) => [u - 2.8, v + 1.75]), 0.02, TEAM, 0.66), side(star(0.32).map(([u, v]) => [u - 2.8, v + 1.75]), 0.02, TEAM, -0.66),
    ],
    mounts: {
      2: {
        yaw: [box(0.3, 0.3, 0.6, 0, 0, 0, PAINT)],
        pitch: [box(0.22, 0.2, 0.7, 0, 0, 0.25, DARK), tubeZ(0.05, 0.045, 0.55, 2.2, 0, 0, 8, STEEL), tubeZ(0.07, 0.07, 2.0, 2.2, 0, 0, 8, DARK)],
      },
    },
    rotors: [
      { pos: [0, 3.2, 0], axis: 'y', dir: 1, rate: 30, geos: rotorGeo(3, 5.8, 0.38, DARK) },
      { pos: [0, 3.75, 0], axis: 'y', dir: -1, rate: 30, geos: rotorGeo(3, 5.8, 0.38, DARK) },
    ],
  }),

  /** Mi-8MTV-5: big cabin, twin engines on top, five-blade rotor, tail rotor, rocket outriggers. */
  transportheli: () => ({
    scheme: { base: [0x5f6b3d, 0x8b7a4d, 0x4b4a33], belly: 0x8fb0c4, scale: 2.6 },
    hull: [
      fuselage([[5.25, 0.35, 1.35, 1.95], [4.8, 0.78, 0.95, 2.4], [4.0, 1.05, 0.75, 2.75], [2.5, 1.15, 0.7, 2.85], [-1.0, 1.15, 0.7, 2.85],
        [-2.6, 1.05, 0.8, 2.8], [-3.3, 0.7, 1.4, 2.7], [-3.6, 0.35, 1.9, 2.6], [-7.0, 0.2, 2.05, 2.45], [-8.4, 0.16, 2.1, 2.6]], PAINT, 0, 12),
      sphere(0.62, 0, 1.62, 4.85, GLASS, 1, 0.75, 0.75, 10, 6, Math.PI),
      box(1.7, 0.45, 0.05, 0, 2.45, 4.45, GLASS, -0.55),
      fuselage([[3.4, 0.6, 2.8, 3.05], [2.8, 0.85, 2.8, 3.4], [0.0, 0.85, 2.8, 3.45], [-1.2, 0.75, 2.8, 3.35], [-1.8, 0.5, 2.8, 3.2]], PAINT, 0, 10),
      ...mirror([
        tubeZ(0.22, 0.22, 3.36, 3.42, 0.4, 3.12, 10, DARK),
        tubeZ(0.18, 0.2, -1.6, -1.1, 0.95, 3.05, 8, DARK),
        ...[-1.8, -0.9, 0, 0.9, 1.8].map((z) => tubeX(0.16, 0.04, 1.15, 2.05, z, 8, LENS)),
        tubeZ(0.38, 0.38, -0.8, 1.8, 1.3, 1.15, 10, PAINT),
        place(box(1.3, 0.12, 0.6, 0, 0, 0, PAINT), 1.75, 1.45, 0.6, 0, 0, -0.35),
        tubeZ(0.22, 0.22, -0.2, 1.4, 2.05, 1.0, 10, PAINT), tubeZ(0.19, 0.19, 1.39, 1.42, 2.05, 1.0, 10, DARK),
        box(0.08, 0.9, 0.08, 1.4, 0.45, -1.0, DARK), tubeX(0.3, 0.22, 1.5, 0.3, -1.0, 10, RUBBER),
        top([[0.15, -6.8], [0.9, -7.0], [0.9, -7.3], [0.15, -7.4]], 2.2, 0.06, PAINT),
      ]),
      box(0.04, 1.0, 1.3, 1.17, 1.65, 3.1, DARK), // sliding door outline
      side([[-7.6, 2.3], [-8.5, 2.3], [-8.95, 3.6], [-8.3, 3.6]], 0.16, PAINT),
      side(star(0.42).map(([u, v]) => [u - 5.0, v + 2.25]), 0.02, TEAM, 0.36), side(star(0.42).map(([u, v]) => [u - 5.0, v + 2.25]), 0.02, TEAM, -0.36),
      box(0.08, 0.7, 0.08, 0.3, 0.45, 4.0, DARK), box(0.08, 0.7, 0.08, -0.3, 0.45, 4.0, DARK), tubeX(0.25, 0.75, 0, 0.25, 4.0, 10, RUBBER),
      cyl(0.18, 0.25, 0.4, 8, 0, 3.5, 0, DARK),
    ],
    mounts: { 1: lmgParts(0.9), 2: lmgParts(0.9) },
    rotors: [
      { pos: [0, 3.75, 0], axis: 'y', dir: 1, rate: 22, geos: rotorGeo(5, 7.6, 0.42, DARK, STEEL, 0.12) },
      { pos: [-0.3, 3.25, -8.45], axis: 'x', dir: 1, rate: 60, geos: rotorGeo(3, 1.25, 0.2, DARK).map((g) => g.rotateZ(Math.PI / 2)) },
    ],
  }),

  /** Su-25: straight shoulder wings, side engine nacelles, tall fin, ten pylons. */
  strikejet: () => ({
    scheme: { base: [0x8b8f8a, 0x6d6656, 0x575c55], belly: 0x9aa3a8, scale: 2.2 },
    hull: [
      fuselage([[5.6, 0.08, 1.75, 1.85], [4.9, 0.38, 1.45, 2.05], [3.9, 0.55, 1.25, 2.25], [2.5, 0.6, 1.15, 2.2], [0.5, 0.55, 1.2, 2.15],
        [-2.0, 0.45, 1.35, 2.1], [-4.2, 0.3, 1.55, 2.05], [-5.4, 0.22, 1.65, 2.0]], PAINT, 0, 12),
      tubeZ(0.03, 0.02, 5.6, 6.3, 0, 1.8, 4, DARK),
      fuselage([[4.2, 0.3, 2.1, 2.3], [3.4, 0.38, 2.05, 2.62], [2.6, 0.32, 2.05, 2.45], [2.2, 0.2, 2.05, 2.2]], GLASS, 0, 10),
      ...mirror([
        fuselage([[2.3, 0.35, 1.25, 1.95], [0.0, 0.45, 1.15, 2.05], [-3.6, 0.38, 1.25, 1.95], [-4.4, 0.3, 1.35, 1.85]], PAINT, 0.75, 10),
        tubeZ(0.32, 0.32, 2.28, 2.32, 0.75, 1.6, 10, DARK), tubeZ(0.26, 0.26, -4.42, -4.38, 0.75, 1.6, 10, DARK),
        top([[0.6, 1.5], [5.4, 0.25], [5.4, -0.55], [0.6, -1.4]], 1.82, 0.16, PAINT),
        tubeZ(0.12, 0.12, -1.0, 0.6, 5.45, 1.88, 8, PAINT),
        ...[2.7, 3.5].map((x) => tubeZ(0.22, 0.22, -0.2, 1.3, x, 1.15, 10, 0x5d6450)),
        ...[2.7, 3.5].map((x) => box(0.06, 0.4, 0.5, x, 1.55, 0.5, DARK)),
        ...[1.7, 2.2].map((x) => fuselage([[1.0, 0.04, 0.48, 0.58], [0.6, 0.22, 0.33, 0.73], [-0.6, 0.22, 0.33, 0.73], [-1.0, 0.1, 0.43, 0.63]], 0x3f4630, x, 8)),
        ...[1.7, 2.2].map((x) => box(0.06, 0.45, 0.4, x, 0.95, 0, DARK)),
        place(top([[0.2, -3.9], [2.4, -4.6], [2.4, -5.1], [0.2, -5.3]], 0, 0.1, PAINT), 0, 2.15, 0, 0, 0, -0.1),
        box(0.08, 1.0, 0.08, 1.7, 0.85, -0.6, DARK), tubeX(0.35, 0.22, 1.75, 0.35, -0.6, 10, RUBBER),
        side(star(0.38).map(([u, v]) => [u - 4.6, v + 3.1]), 0.02, TEAM, 0.07),
      ]),
      side([[-3.0, 2.05], [-5.1, 2.05], [-5.6, 3.65], [-4.6, 3.65]], 0.12, PAINT),
      box(0.06, 0.9, 0.06, 0, 0.7, 3.1, DARK), tubeX(0.3, 0.2, 0, 0.3, 3.1, 10, RUBBER),
      tubeZ(0.04, 0.035, 3.9, 4.6, 0.32, 1.25, 6, DARK),
    ],
  }),

  /** Su-30: long nose with canards, blended wing, widely spaced engines, twin tails. */
  fighter: () => ({
    scheme: { base: [0x93abbb, 0x7392a8, 0x55748f], belly: 0xbac6ce, scale: 2.8 },
    hull: [
      fuselage([[8.2, 0.1, 1.95, 2.05], [7.2, 0.42, 1.7, 2.35], [6.0, 0.58, 1.55, 2.6], [4.5, 0.7, 1.45, 2.7], [3.0, 0.75, 1.4, 2.65],
        [1.0, 0.9, 1.35, 2.45], [-2.0, 0.9, 1.35, 2.35], [-4.5, 0.6, 1.45, 2.25], [-6.0, 0.35, 1.6, 2.15]], PAINT, 0, 12),
      tubeZ(0.035, 0.02, 8.2, 8.9, 0, 2.0, 4, DARK),
      cone(0.42, 1.1, 10, 0, 2.0, 7.65, 0xd9dcd8, Math.PI / 2), // radome
      fuselage([[6.6, 0.3, 2.5, 2.7], [5.8, 0.42, 2.45, 3.05], [4.6, 0.42, 2.45, 3.05], [3.8, 0.25, 2.5, 2.7]], GLASS, 0, 10),
      ...mirror([
        fuselage([[2.2, 0.45, 1.05, 1.75], [0.0, 0.55, 1.0, 1.9], [-4.8, 0.5, 1.15, 1.95], [-6.6, 0.42, 1.25, 1.85]], PAINT, 1.15, 10),
        tubeZ(0.4, 0.4, 2.18, 2.22, 1.15, 1.4, 10, DARK), tubeZ(0.36, 0.38, -6.9, -6.6, 1.15, 1.55, 10, DARK),
        top([[0.75, 4.0], [1.6, 1.2], [5.3, -2.1], [5.3, -2.9], [3.0, -3.0], [1.0, -3.0]], 2.08, 0.14, PAINT),
        top([[0.7, 4.9], [1.9, 4.3], [1.9, 4.0], [0.7, 4.0]], 2.22, 0.06, PAINT),
        side([[-3.2, 2.3], [-5.6, 2.3], [-6.4, 4.45], [-5.4, 4.45]], 0.1, PAINT, 1.2),
        top([[1.1, -4.4], [3.4, -6.0], [3.4, -6.6], [1.1, -6.6]], 1.92, 0.08, PAINT),
        tubeZ(0.08, 0.08, -2.4, -0.4, 5.3, 2.17, 6, 0xdfe3e0), cone(0.08, 0.3, 6, 5.3, 2.17, -0.25, 0xdfe3e0, Math.PI / 2),
        tubeZ(0.08, 0.08, -1.9, 0.1, 3.4, 1.82, 6, 0xdfe3e0), box(0.05, 0.25, 0.8, 3.4, 1.98, -0.9, DARK),
        tubeZ(0.2, 0.2, -2.1, -0.6, 4.35, 1.65, 10, 0x5d6450), box(0.05, 0.25, 0.6, 4.35, 1.95, -1.35, DARK),
        box(0.08, 1.2, 0.08, 2.0, 0.95, -0.8, DARK), tubeX(0.38, 0.24, 2.05, 0.38, -0.8, 10, RUBBER),
        side(star(0.42).map(([u, v]) => [u - 5.6, v + 3.3]), 0.02, TEAM, 1.26),
      ]),
      box(0.06, 1.1, 0.06, 0, 0.85, 4.6, DARK), tubeX(0.3, 0.3, 0, 0.3, 4.6, 10, RUBBER),
    ],
  }),
};

// ------------------------------------------------------------------ Torsa expansion (Milestone 1)
// Imported HD models reduced to low-poly rigged parts (imported.js); each falls back to the nearest hand-built
// model if the packed file could not be loaded, so a missing asset never breaks the build.
const imp = (key, fallback, o) => (def, teamHex) => importedSpec(key, o) || MODELS[fallback](def, teamHex);
Object.assign(MODELS, {
  ifv2: imp('ifv2', 'ifv'),
  atcst: imp('atcst', 'supply'),
  uaz: imp('uaz', 'truck'),
  tigr: imp('tigr', 'truck'),
  brdm: imp('brdm', 'apc'),
  cev: () => cevSpec(),
  grad: imp('grad', 'mlrs'),
  smerch: imp('smerch', 'mlrs'),
  radar: imp('radar', 'sam'),
  tel: imp('tel', 'mlrs'),
  gunship: imp('gunship', 'attackheli', { air: true }),
  utilheli: imp('utilheli', 'transportheli', { air: true }),
  reconheli: imp('reconheli', 'transportheli', { air: true, extraHull: [sphere(0.28, 0, 1.0, 4.85, LENS)] }),
  heavyheli: imp('heavyheli', 'transportheli', { air: true }),
  lightattack: imp('lightattack', 'strikejet', { air: true, lift: 1.0, gear: yakGear() }),
  transportplane: () => transportPlaneSpec(),
  fighter2: imp('fighter2', 'fighter', { air: true }),
  fighter3: imp('fighter3', 'fighter', { air: true }),
  ost: MODELS.supply,
});
