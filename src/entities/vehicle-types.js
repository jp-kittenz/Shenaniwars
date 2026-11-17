import * as THREE from 'three';
import { box, cyl, merge } from '../world/geo.js';
import { CONFIG } from '../core/config.js';

/**
 * @typedef {Object} WheelDef
 * @property {number[]} pos   chassis-local suspension anchor
 * @property {boolean} steer
 * @property {boolean} driven
 */
/**
 * @typedef {Object} MountDef
 * @property {number} seat       seat index that operates this weapon
 * @property {string} weapon     key into WEAPONS
 * @property {number[]} pos      chassis-local pivot
 * @property {number} barrel     muzzle distance from pivot
 * @property {number} turnRate   rad/s (0 = fixed forward)
 * @property {number} pitchMin @property {number} pitchMax
 */
/**
 * @typedef {Object} VehicleDef
 * @property {'jeep'|'tank'|'heli'} type
 * @property {'ground'|'heli'} kind
 * @property {string} label
 * @property {number} mass @property {number} health
 * @property {number[]} half           chassis collider half extents
 * @property {WheelDef[]} wheels
 * @property {number} wheelRadius @property {number} suspRest @property {number} suspSag @property {number} suspDamp
 * @property {number} engineForce @property {number} brakeForce @property {number} maxSpeed @property {number} reverseSpeed
 * @property {number} grip            tyre friction coefficient
 * @property {number} lateralGrip     0..1 fraction of side-slip cancelled per step
 * @property {number} maxSteer        front-wheel steering lock (rad); 0 => skid steer
 * @property {number} turnRate        skid-steer yaw rate (rad/s)
 * @property {{role:'driver'|'gunner'|'passenger', pos:number[]}[]} seats
 * @property {MountDef[]} mounts
 * @property {number} camDist @property {number} camHeight
 * @property {number} crashDamage     hp per m/s of sudden velocity change
 */

/** @type {Record<string, VehicleDef>} */
export const VEHICLE_DEFS = {
  jeep: {
    type: 'jeep', kind: 'ground', label: 'SCOUT CAR', mass: 1300, health: 420, half: [0.95, 0.42, 2.0],
    wheels: [
      { pos: [0.95, -0.2, 1.35], steer: true, driven: true }, { pos: [-0.95, -0.2, 1.35], steer: true, driven: true },
      { pos: [0.95, -0.2, -1.35], steer: false, driven: true }, { pos: [-0.95, -0.2, -1.35], steer: false, driven: true },
    ],
    wheelRadius: 0.42, suspRest: 0.5, suspSag: 0.2, suspDamp: 0.5,
    engineForce: 11500, brakeForce: 16000, maxSpeed: 25, reverseSpeed: 9, grip: 1.25, lateralGrip: 0.55,
    maxSteer: 0.6, turnRate: 0,
    seats: [
      { role: 'driver', pos: [0.45, 0.45, 0.1] }, { role: 'gunner', pos: [0, 0.9, -0.9] },
      { role: 'passenger', pos: [-0.45, 0.45, 0.1] }, { role: 'passenger', pos: [0.45, 0.45, -1.5] },
    ],
    mounts: [{ seat: 1, weapon: 'mountedMG', pos: [0, 1.55, -0.6], barrel: 1.0, turnRate: 3.2, pitchMin: -0.35, pitchMax: 0.8 }],
    camDist: 8.5, camHeight: 3.2, crashDamage: 9,
  },
  tank: {
    type: 'tank', kind: 'ground', label: 'BATTLE TANK', mass: 9500, health: 1700, half: [1.7, 0.62, 3.3],
    wheels: [-2.5, 0, 2.5].flatMap((z) => [
      { pos: [1.45, -0.35, z], steer: false, driven: true }, { pos: [-1.45, -0.35, z], steer: false, driven: true },
    ]),
    wheelRadius: 0.5, suspRest: 0.4, suspSag: 0.14, suspDamp: 0.7,
    engineForce: 42000, brakeForce: 90000, maxSpeed: 10.5, reverseSpeed: 5, grip: 1.7, lateralGrip: 0.8,
    maxSteer: 0, turnRate: 0.85,
    seats: [{ role: 'driver', pos: [0, 0.4, 1.2] }, { role: 'gunner', pos: [0, 1.2, -0.4] }],
    mounts: [
      { seat: 0, weapon: 'cannon', pos: [0, 1.25, 0.1], barrel: 4.6, turnRate: 0.75, pitchMin: -0.14, pitchMax: 0.42 },
      { seat: 1, weapon: 'mountedMG', pos: [0, 2.05, 0.1], barrel: 0.9, turnRate: 3, pitchMin: -0.3, pitchMax: 0.9 },
    ],
    camDist: 12.5, camHeight: 4.6, crashDamage: 2,
  },
  heli: {
    type: 'heli', kind: 'heli', label: 'GUNSHIP', mass: 2600, health: 680, half: [0.95, 0.85, 2.9],
    wheels: [], wheelRadius: 0, suspRest: 0, suspSag: 0, suspDamp: 0,
    engineForce: 0, brakeForce: 0, maxSpeed: 42, reverseSpeed: 0, grip: 0, lateralGrip: 0, maxSteer: 0, turnRate: 1.5,
    seats: [{ role: 'driver', pos: [0, 0.2, 1.4] }, { role: 'gunner', pos: [0, 0.3, 0.2] }],
    mounts: [
      { seat: 0, weapon: 'rockets', pos: [0, -0.4, 1.2], barrel: 1.2, turnRate: 0, pitchMin: 0, pitchMax: 0 },
      { seat: 1, weapon: 'mountedMG', pos: [0, -0.75, 2.3], barrel: 0.9, turnRate: 3.5, pitchMin: -1.1, pitchMax: 0.25 },
    ],
    camDist: 15, camHeight: 4.5, crashDamage: 22,
  },
};

const DARK = 0x23282c, STEEL = 0x4b5257, GLASS = 0x8fd0e0;

/**
 * @typedef {Object} VehicleVisual
 * @property {THREE.Group} root
 * @property {THREE.Mesh} hull
 * @property {THREE.Object3D[]} wheels
 * @property {{yaw:THREE.Object3D, pitch:THREE.Object3D}[]} mounts
 * @property {THREE.Object3D[]} rotors
 * @property {THREE.Object3D[]} detail   hidden beyond LOD distance
 * @property {THREE.MeshLambertMaterial} material
 */

/**
 * Builds a vehicle's scene graph out of a handful of merged, vertex-coloured
 * meshes (hull + one mesh per moving part) sharing one material.
 * @param {VehicleDef} def
 * @param {number} team
 * @param {(m: THREE.Material) => THREE.Material} setupMaterial  hooks CSM shadows
 * @returns {VehicleVisual}
 */
export function buildVehicleVisual(def, team, setupMaterial) {
  const teamColor = CONFIG.teams[team].color;
  const paintCol = new THREE.Color(def.type === 'tank' ? 0x5d6b4c : def.type === 'heli' ? 0x56606a : 0x7d7350)
    .lerp(new THREE.Color(teamColor), 0.22).getHex();
  const material = /** @type {THREE.MeshLambertMaterial} */ (setupMaterial(new THREE.MeshLambertMaterial({ vertexColors: true })));
  const root = new THREE.Group();
  const mk = (parts, parent = root, shadow = true) => {
    const m = new THREE.Mesh(merge(parts), material);
    m.castShadow = shadow; m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  /** @type {VehicleVisual} */
  const v = { root, hull: /** @type {any} */ (null), wheels: [], mounts: [], rotors: [], detail: [], material };
  const mountNode = (md) => {
    const yaw = new THREE.Object3D(); yaw.position.fromArray(md.pos);
    const pitch = new THREE.Object3D(); yaw.add(pitch); root.add(yaw);
    v.mounts.push({ yaw, pitch });
    return { yaw, pitch };
  };
  const mg = (md) => {
    const n = mountNode(md);
    // Small parts skip the shadow pass and are dropped entirely at distance (see Vehicle.updateVisual).
    v.detail.push(mk([box(0.16, 0.5, 0.16, 0, -0.3, 0, DARK)], n.yaw, false));
    v.detail.push(mk([box(0.14, 0.16, 0.9, 0, 0, 0.35, DARK), cyl(0.035, 0.035, 0.6, 5, 0, 0.02, md.barrel - 0.3, STEEL, Math.PI / 2)], n.pitch, false));
  };

  if (def.type === 'jeep') {
    v.hull = mk([
      box(1.9, 0.5, 4.0, 0, 0, 0, paintCol), box(1.8, 0.35, 1.2, 0, 0.42, 1.35, paintCol),
      box(1.7, 0.55, 0.08, 0, 0.75, 0.72, GLASS, -0.25), box(1.9, 0.5, 0.1, 0, 0.5, -1.95, paintCol),
      box(0.1, 0.5, 1.9, 0.9, 0.5, -1.0, paintCol), box(0.1, 0.5, 1.9, -0.9, 0.5, -1.0, paintCol),
      box(0.08, 1.2, 0.08, 0.85, 0.9, -0.2, DARK), box(0.08, 1.2, 0.08, -0.85, 0.9, -0.2, DARK), box(1.78, 0.08, 0.08, 0, 1.5, -0.2, DARK),
      box(2.0, 0.16, 0.2, 0, -0.15, 2.05, DARK), box(0.3, 0.12, 0.06, 0.6, 0.3, 2.02, 0xfff2c0), box(0.3, 0.12, 0.06, -0.6, 0.3, 2.02, 0xfff2c0),
      box(0.5, 0.06, 1.2, 0, 0.62, 1.35, teamColor),
    ]);
    for (const w of def.wheels) {
      const node = new THREE.Object3D(); node.position.fromArray(w.pos); root.add(node);
      v.detail.push(mk([cyl(def.wheelRadius, def.wheelRadius, 0.3, 10, 0, 0, 0, DARK, 0, 0, Math.PI / 2), cyl(0.2, 0.2, 0.32, 6, 0, 0, 0, STEEL, 0, 0, Math.PI / 2)], node, false));
      v.wheels.push(node);
    }
    mg(def.mounts[0]);
  } else if (def.type === 'tank') {
    v.hull = mk([
      box(3.4, 0.9, 6.4, 0, 0.1, 0, paintCol), box(3.0, 0.5, 1.6, 0, 0.35, 3.0, paintCol, 0.5),
      box(0.75, 0.95, 6.8, 1.5, -0.3, 0, DARK), box(0.75, 0.95, 6.8, -1.5, -0.3, 0, DARK),
      box(0.85, 0.12, 6.9, 1.5, 0.25, 0, paintCol), box(0.85, 0.12, 6.9, -1.5, 0.25, 0, paintCol),
      box(2.2, 0.3, 1.4, 0, 0.6, -2.4, STEEL), box(0.9, 0.06, 2.4, 0, 0.58, 1.6, teamColor),
      // Road wheels are baked into the hull batch: tracks hide their travel, so they need no nodes.
      ...def.wheels.map((w) => cyl(def.wheelRadius, def.wheelRadius, 0.5, 8, w.pos[0] * 1.08, w.pos[1] - 0.25, w.pos[2], STEEL, 0, 0, Math.PI / 2)),
    ]);
    const t = mountNode(def.mounts[0]);
    mk([box(2.3, 0.75, 2.9, 0, 0, -0.2, paintCol), box(1.7, 0.6, 0.9, 0, 0, 1.5, paintCol), box(0.7, 0.25, 0.7, -0.5, 0.5, -0.5, STEEL), box(1.2, 0.05, 1.2, 0, 0.39, -0.3, teamColor)], t.yaw);
    mk([cyl(0.11, 0.13, 4.4, 8, 0, 0, 2.4, STEEL, Math.PI / 2), cyl(0.17, 0.17, 0.5, 8, 0, 0, 4.4, DARK, Math.PI / 2)], t.pitch);
    mg(def.mounts[1]);
  } else {
    v.hull = mk([
      box(1.7, 1.5, 3.4, 0, 0, 0.6, paintCol), box(1.5, 0.9, 1.4, 0, 0.25, 2.5, GLASS, 0.35), box(1.3, 0.7, 1.0, 0, -0.35, 2.7, paintCol),
      box(0.5, 0.5, 4.6, 0, 0.35, -3.2, paintCol), box(0.12, 1.5, 0.9, 0, 1.0, -5.1, paintCol), box(1.6, 0.1, 0.6, 0, 0.5, -5.0, paintCol),
      box(1.1, 0.5, 1.6, 0, 0.95, 0.3, STEEL), box(3.6, 0.12, 0.9, 0, -0.35, 0.9, paintCol),
      cyl(0.28, 0.28, 1.5, 7, 1.55, -0.55, 1.0, DARK, Math.PI / 2), cyl(0.28, 0.28, 1.5, 7, -1.55, -0.55, 1.0, DARK, Math.PI / 2),
      box(0.1, 0.1, 3.4, 0.85, -0.95, 0.8, DARK), box(0.1, 0.1, 3.4, -0.85, -0.95, 0.8, DARK),
      box(0.08, 0.35, 0.08, 0.85, -0.78, 1.8, DARK), box(0.08, 0.35, 0.08, -0.85, -0.78, 1.8, DARK),
      box(0.08, 0.35, 0.08, 0.85, -0.78, -0.2, DARK), box(0.08, 0.35, 0.08, -0.85, -0.78, -0.2, DARK),
      box(0.5, 0.05, 1.4, 0, 0.76, 1.3, teamColor),
    ]);
    const main = new THREE.Object3D(); main.position.set(0, 1.35, 0.3); root.add(main);
    mk([box(10.5, 0.06, 0.34, 0, 0, 0, DARK), box(0.34, 0.06, 10.5, 0, 0, 0, DARK), cyl(0.12, 0.12, 0.4, 6, 0, -0.15, 0, STEEL)], main, false);
    const tail = new THREE.Object3D(); tail.position.set(0.14, 1.2, -5.1); root.add(tail);
    v.detail.push(mk([box(0.05, 1.9, 0.18, 0, 0, 0, DARK), box(0.05, 0.18, 1.9, 0, 0, 0, DARK)], tail, false));
    v.rotors.push(main, tail);
    mountNode(def.mounts[0]);
    mg(def.mounts[1]);
  }
  return v;
}
