import { DARK, STEEL, WOOD, GLASS, box, tubeZ, side, cone, place } from './kit.js';

/**
 * Infantry weapon models (metres, origin at the pistol grip, +Z toward the
 * muzzle, +Y up, +X to the shooter's left) with the anchor points the rig's
 * hands, magazines and reload animation attach to.
 *
 * @typedef {Object} WeaponModel
 * @property {'rifle'|'launcher'} kind
 * @property {(lod: number) => {body: import('three').BufferGeometry[], mag: import('three').BufferGeometry[]}} build
 * @property {number[]} grip      right-hand hold point
 * @property {number[]} support   left-hand hold point
 * @property {number[]} magWell   where the magazine / rocket attaches
 * @property {number[]} magGrab   point of the magazine the hand holds (magazine space)
 * @property {number[]} charge    charging handle (empty reloads)
 * @property {number[]} sight     eye point for aiming down sights
 * @property {number[]} muzzle
 * @property {number[]} hold      weapon origin in the third-person aim frame
 * @property {number[]} holdFP    weapon origin in the first-person view frame (hip)
 */

const BAKELITE = 0x6e3418;
const BLACK = 0x1f2022;
const POLY = 0x26282a;
const OLIVE = 0x4c5a32;
const TAN = 0x9c8a5e;


/**
 * Curved box magazine hanging from the mag well (origin = top centre), bending forward (+Z) as it goes down.
 * Segments are laid end to end along an arc, each tilted to its own stretch of the arc, so they stay joined.
 * @param {number[]} hs segment heights, top to bottom @param {number} w @param {number} d
 * @param {number} bend total forward bend (rad) @param {number} color @param {number} [rib] side-rib colour
 */
function curvedMag(hs, w, d, bend, color, rib) {
  const out = [], da = bend / hs.length;
  let a = 0, y = 0, z = 0;
  for (const h of hs) {
    const m = a + da / 2, cy = y - Math.cos(m) * h / 2, cz = z + Math.sin(m) * h / 2;
    // A hair longer than the stretch, so neighbouring segments overlap on the inside of the bend.
    out.push(place(box(w, h * 1.08, d, 0, 0, 0, color), 0, cy, cz, -m, 0, 0));
    if (rib !== undefined) for (const x of [-1, 1]) out.push(place(box(0.004, h * 0.9, 0.012, 0, 0, 0, rib), x * (w / 2 + 0.002), cy, cz, -m, 0, 0));
    y -= Math.cos(m) * h; z += Math.sin(m) * h; a += da;
  }
  return out;
}

/** @type {Record<string, WeaponModel>} */
export const WEAPON_MODELS = {
  ak47: {
    kind: 'rifle',
    build: (lod) => ({
      body: lod ? [
        box(0.045, 0.07, 0.62, 0, 0.035, 0.08, BLACK), side([[-0.1, 0.06], [-0.43, 0.035], [-0.43, -0.085], [-0.1, -0.005]], 0.04, WOOD),
        box(0.035, 0.1, 0.04, 0, -0.05, -0.02, BAKELITE),
      ] : [
        box(0.046, 0.07, 0.31, 0, 0.04, 0.055, BLACK), tubeZ(0.025, 0.025, -0.09, 0.2, 0, 0.068, 6, BLACK),
        side([[-0.1, 0.062], [-0.43, 0.035], [-0.43, -0.088], [-0.1, -0.004]], 0.042, WOOD), box(0.044, 0.125, 0.012, 0, -0.026, -0.432, STEEL),
        place(box(0.034, 0.11, 0.045, 0, 0, 0, BAKELITE), 0, -0.05, -0.025, -0.35, 0, 0),
        box(0.012, 0.012, 0.07, 0, -0.02, 0.03, STEEL),
        box(0.05, 0.05, 0.19, 0, 0.022, 0.3, WOOD), box(0.036, 0.026, 0.16, 0, 0.074, 0.29, WOOD),
        tubeZ(0.011, 0.011, 0.2, 0.52, 0, 0.035, 6, DARK), tubeZ(0.009, 0.009, 0.36, 0.44, 0, 0.068, 6, DARK),
        box(0.022, 0.03, 0.03, 0, 0.055, 0.47, DARK), box(0.006, 0.04, 0.008, 0, 0.085, 0.47, DARK),
        tubeZ(0.014, 0.014, 0.5, 0.53, 0, 0.035, 6, DARK),
        box(0.028, 0.018, 0.04, 0, 0.088, 0.19, DARK),
        box(0.012, 0.012, 0.03, -0.03, 0.052, 0.16, STEEL),
      ],
      mag: lod ? curvedMag([0.2], 0.028, 0.06, 0.5, BAKELITE) : curvedMag([0.085, 0.08, 0.08], 0.03, 0.063, 0.75, BAKELITE),
    }),
    grip: [0, -0.06, -0.025], support: [0, -0.02, 0.27], magWell: [0, -0.002, 0.12], magGrab: [0, -0.11, 0.03],
    charge: [-0.045, 0.052, 0.16], sight: [0, 0.098, 0.19], muzzle: [0, 0.035, 0.53],
    hold: [-0.14, -0.035, 0.3], holdFP: [-0.13, -0.17, 0.3],
  },

  ak12: {
    kind: 'rifle',
    build: (lod) => ({
      body: lod ? [
        box(0.045, 0.075, 0.64, 0, 0.04, 0.09, POLY), box(0.04, 0.12, 0.2, 0, 0.0, -0.3, POLY), box(0.035, 0.1, 0.04, 0, -0.05, -0.02, POLY),
      ] : [
        box(0.046, 0.072, 0.31, 0, 0.04, 0.055, BLACK), box(0.03, 0.012, 0.3, 0, 0.083, 0.07, POLY),
        box(0.034, 0.04, 0.06, 0, 0.11, 0.06, POLY), box(0.026, 0.026, 0.008, 0, 0.112, 0.03, GLASS), box(0.008, 0.008, 0.006, 0, 0.112, 0.092, 0xd02020),
        box(0.032, 0.032, 0.26, 0, 0.045, -0.22, POLY), box(0.012, 0.012, 0.22, 0, -0.01, -0.24, POLY),
        box(0.04, 0.13, 0.035, 0, 0.0, -0.355, POLY), box(0.036, 0.04, 0.09, 0, 0.065, -0.3, POLY),
        place(box(0.038, 0.115, 0.05, 0, 0, 0, POLY), 0, -0.05, -0.025, -0.3, 0, 0),
        box(0.012, 0.012, 0.07, 0, -0.02, 0.03, DARK),
        box(0.056, 0.062, 0.21, 0, 0.034, 0.315, POLY), box(0.03, 0.012, 0.21, 0, 0.071, 0.315, BLACK),
        box(0.008, 0.026, 0.18, 0.031, 0.034, 0.32, BLACK), box(0.008, 0.026, 0.18, -0.031, 0.034, 0.32, BLACK),
        tubeZ(0.011, 0.011, 0.42, 0.56, 0, 0.035, 6, DARK), tubeZ(0.018, 0.018, 0.55, 0.62, 0, 0.035, 6, BLACK),
        box(0.012, 0.012, 0.03, -0.03, 0.052, 0.16, DARK),
      ],
      mag: lod ? curvedMag([0.19], 0.028, 0.06, 0.4, POLY) : curvedMag([0.085, 0.075, 0.07], 0.031, 0.063, 0.58, POLY, BLACK),
    }),
    grip: [0, -0.06, -0.025], support: [0, -0.02, 0.27], magWell: [0, -0.002, 0.12], magGrab: [0, -0.11, 0.025],
    charge: [-0.045, 0.052, 0.16], sight: [0, 0.112, 0.06], muzzle: [0, 0.035, 0.62],
    hold: [-0.14, -0.035, 0.3], holdFP: [-0.13, -0.17, 0.3],
  },

  rpg7: {
    kind: 'launcher',
    build: (lod) => ({
      body: lod ? [
        tubeZ(0.042, 0.042, -0.62, 0.33, 0, 0.075, 6, 0x30332f), tubeZ(0.04, 0.07, -0.62, -0.78, 0, 0.075, 6, 0x30332f),
        tubeZ(0.05, 0.05, -0.26, 0.06, 0, 0.075, 6, WOOD),
      ] : [
        tubeZ(0.04, 0.04, -0.62, 0.33, 0, 0.075, 8, 0x30332f), tubeZ(0.04, 0.072, -0.62, -0.78, 0, 0.075, 8, 0x30332f),
        tubeZ(0.05, 0.05, -0.26, 0.06, 0, 0.075, 8, WOOD), tubeZ(0.052, 0.052, -0.11, -0.09, 0, 0.075, 8, DARK),
        place(box(0.03, 0.11, 0.045, 0, 0, 0, WOOD), 0, -0.035, 0, -0.25, 0, 0), box(0.012, 0.012, 0.06, 0, -0.01, 0.05, STEEL),
        place(box(0.03, 0.1, 0.042, 0, 0, 0, WOOD), 0, -0.02, -0.22, -0.2, 0, 0),
        box(0.04, 0.055, 0.12, 0.06, 0.125, -0.05, BLACK), box(0.034, 0.034, 0.006, 0.06, 0.125, 0.012, GLASS),
        box(0.008, 0.035, 0.008, 0, 0.13, 0.28, DARK), box(0.02, 0.03, 0.01, 0, 0.13, 0.0, DARK),
      ],
      mag: [
        tubeZ(0.022, 0.022, -0.1, 0.02, 0, 0, 6, OLIVE),
        tubeZ(0.034, 0.036, 0.02, 0.16, 0, 0, 8, OLIVE), tubeZ(0.036, 0.044, 0.16, 0.28, 0, 0, 8, OLIVE),
        tubeZ(0.044, 0.018, 0.28, 0.44, 0, 0, 8, OLIVE), tubeZ(0.008, 0.008, 0.44, 0.48, 0, 0, 4, TAN),
      ],
    }),
    grip: [0, -0.065, 0.0], support: [0, 0.025, 0.2], magWell: [0, 0.075, 0.33], magGrab: [0, 0, 0.15],
    charge: [0, 0.075, 0.33], sight: [0, 0.135, 0.0], muzzle: [0, 0.075, 0.33],
    hold: [-0.17, 0.0, 0.16], holdFP: [-0.27, -0.15, 0.34],
  },

  // --- Pampalona placeholders (same look as before, now properly held) ---------
  rifle: {
    kind: 'rifle',
    build: (lod) => ({
      body: lod ? [box(0.05, 0.08, 0.7, 0, 0.03, 0.1, BLACK), box(0.035, 0.1, 0.04, 0, -0.05, -0.02, BLACK)] : [
        box(0.05, 0.085, 0.3, 0, 0.035, 0.06, 0x1c1f22), box(0.045, 0.05, 0.1, 0, 0.095, 0.05, 0x1c1f22),
        box(0.045, 0.08, 0.24, 0, 0.02, -0.26, 0x3b2f22), box(0.05, 0.11, 0.03, 0, 0.0, -0.39, 0x2b2f33),
        place(box(0.035, 0.11, 0.045, 0, 0, 0, 0x2b2f33), 0, -0.05, -0.02, -0.3, 0, 0),
        box(0.055, 0.06, 0.2, 0, 0.035, 0.31, 0x2b2f33), tubeZ(0.012, 0.012, 0.4, 0.62, 0, 0.035, 6, 0x3a3f44),
        box(0.012, 0.045, 0.012, 0, 0.075, 0.42, 0x1c1f22),
      ],
      mag: [box(0.026, 0.17, 0.06, 0, -0.085, 0.02, 0x1c1f22)],
    }),
    grip: [0, -0.06, -0.02], support: [0, -0.02, 0.28], magWell: [0, -0.005, 0.12], magGrab: [0, -0.09, 0.02],
    charge: [0, 0.09, -0.05], sight: [0, 0.12, 0.05], muzzle: [0, 0.035, 0.62],
    hold: [-0.14, -0.04, 0.3], holdFP: [-0.13, -0.17, 0.3],
  },
  launcher: {
    kind: 'launcher',
    build: (lod) => ({
      body: lod ? [tubeZ(0.065, 0.065, -0.7, 0.4, 0, 0.075, 6, 0x4d5a3c)] : [
        tubeZ(0.065, 0.065, -0.7, 0.4, 0, 0.075, 10, 0x4d5a3c), tubeZ(0.07, 0.085, -0.85, -0.7, 0, 0.075, 10, 0x2b2f33),
        place(box(0.03, 0.12, 0.05, 0, 0, 0, 0x1c1f22), 0, -0.04, 0, -0.25, 0, 0),
        box(0.04, 0.09, 0.14, 0.07, 0.15, -0.05, 0x1c1f22),
      ],
      mag: [cone(0.06, 0.22, 8, 0, 0, 0.14, OLIVE, Math.PI / 2), tubeZ(0.045, 0.045, -0.08, 0.03, 0, 0, 6, OLIVE)],
    }),
    grip: [0, -0.07, 0.0], support: [0, 0.01, 0.25], magWell: [0, 0.075, 0.4], magGrab: [0, 0, 0.0],
    charge: [0, 0.075, 0.4], sight: [0, 0.16, 0.0], muzzle: [0, 0.075, 0.4],
    hold: [-0.18, 0.0, 0.16], holdFP: [-0.28, -0.16, 0.36],
  },
};
