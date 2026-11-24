import * as THREE from 'three';
import {
  PAINT, PAINT2, TEAM, DARK, STEEL, RUBBER, GLASS, LENS,
  box, cyl, tubeZ, tubeX, sphere, cone, side, top, front, mirror, runningGear, wheelGeo,
} from './kit.js';

/**
 * Torsa expansion (Milestone 1), hand-built from the reference blueprints. Every model is authored in ground
 * coordinates (y = 0 on the ground at rest, +Z forward, +X to the vehicle's left), sized from the drawings'
 * dimensions; turret / launcher / gun parts are authored relative to their pivots (see vehicle-defs.js).
 */

const OLIVE = [0x4f5b33];
const KURG_CAMO = { base: [0x8a8064, 0x56613b, 0x2f312a], scale: 2.0 };
const LAMP = 0xfff0c0, CRATE = 0x5b6236;

// ------------------------------------------------------------------ shared parts

/** Remote / pintle heavy MG (Kord) with shield: { yaw, pitch } parts. */
function kordMount(shield = true, ring = 0.42) {
  return {
    yaw: [cyl(ring, ring, 0.12, 12, 0, -0.18, 0, DARK), box(0.1, 0.36, 0.1, 0, -0.02, 0, DARK),
      ...(shield ? [box(0.9, 0.5, 0.05, 0, 0.05, 0.32, PAINT), ...mirror([box(0.05, 0.42, 0.32, 0.45, 0.05, 0.16, PAINT, 0, 0.5, 0)])] : [])],
    pitch: [box(0.13, 0.16, 0.85, 0, 0, 0.2, DARK), box(0.16, 0.2, 0.24, 0.16, -0.05, 0.05, CRATE), tubeZ(0.026, 0.022, 0.6, 1.45, 0, 0.03, 6, STEEL), tubeZ(0.042, 0.042, 1.36, 1.46, 0, 0.03, 6, DARK)],
  };
}

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
