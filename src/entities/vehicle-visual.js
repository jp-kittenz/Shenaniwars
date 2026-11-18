import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { merge, finish } from './models/kit.js';
import { MODELS } from './models/vehicle-models.js';

/**
 * @typedef {Object} VehicleVisual
 * @property {THREE.Group} root
 * @property {THREE.Mesh} hull
 * @property {({yaw: THREE.Object3D, pitch: THREE.Object3D}|null)[]} mounts  per mount (null = no moving parts)
 * @property {THREE.InstancedMesh|null} wheels
 * @property {{node: THREE.Object3D, axis: 'x'|'y', dir: number, rate: number}[]} rotors
 * @property {{node: THREE.Object3D, rate: number}[]} spinners
 * @property {THREE.Object3D[]} detail   hidden beyond the detail distance
 * @property {THREE.Mesh[]} casters      shadow casters (switched off at distance)
 * @property {THREE.MeshLambertMaterial} material
 */

/**
 * Turns a model spec into a scene graph: one merged hull mesh, one mesh per
 * moving part (turret, gun, remote weapon), an instanced mesh for all wheels,
 * and nodes for rotors and radar antennas. Everything shares one material.
 * @param {import('./vehicle-defs.js').VehicleDef} def
 * @param {number} team  owning team (sets markings)
 * @param {(m: THREE.Material) => THREE.Material} setupMaterial
 * @returns {VehicleVisual}
 */
export function buildVehicleVisual(def, team, setupMaterial) {
  const teamHex = team >= 0 ? CONFIG.teams[team].color : 0x8a8f86;
  const spec = MODELS[def.type](def, teamHex);
  const scheme = { ...spec.scheme, team: teamHex };
  const material = /** @type {THREE.MeshLambertMaterial} */ (setupMaterial(new THREE.MeshLambertMaterial({ vertexColors: true })));
  const root = new THREE.Group();
  const dy = spec.local ? 0 : -def.ride;
  const mesh = (geos, parent, shadow, offset = 0) => {
    const m = new THREE.Mesh(finish(merge(geos, offset), scheme), material);
    m.castShadow = shadow;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  /** @type {VehicleVisual} */
  const v = {
    root, hull: mesh(spec.hull, root, true, dy), mounts: [], wheels: null, rotors: [], spinners: [], detail: [], casters: [], material,
  };
  v.casters.push(v.hull);

  for (let i = 0; i < def.mounts.length; i++) {
    const m = def.mounts[i];
    const parts = spec.mounts && spec.mounts[i];
    if (m.coax !== undefined || m.turnRate === 0 || !m.pos) { v.mounts.push(null); continue; }
    const yaw = new THREE.Object3D(), pitch = new THREE.Object3D();
    yaw.position.fromArray(m.pos);
    pitch.position.fromArray(m.trunnion || [0, 0, 0]);
    yaw.add(pitch);
    const parent = m.parent !== undefined ? v.mounts[m.parent] : null;
    if (parent) {
      const pp = def.mounts[/** @type {number} */ (m.parent)].pos;
      yaw.position.set(m.pos[0] - pp[0], m.pos[1] - pp[1], m.pos[2] - pp[2]);
      parent.yaw.add(yaw);
    } else root.add(yaw);
    const main = i === 0;
    if (parts && parts.yaw) { const y = mesh(parts.yaw, yaw, main); if (main) v.casters.push(y); else v.detail.push(y); }
    if (parts && parts.pitch) { const p = mesh(parts.pitch, pitch, main); if (main) v.casters.push(p); else v.detail.push(p); }
    v.mounts.push({ yaw, pitch });
  }

  if (spec.wheel && def.wheels.length) {
    const geo = finish(spec.wheel, scheme);
    const wm = new THREE.InstancedMesh(geo, material, def.wheels.length);
    wm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    wm.frustumCulled = false;
    wm.receiveShadow = true;
    root.add(wm);
    v.wheels = wm;
  }

  for (const r of spec.rotors || []) {
    const node = new THREE.Object3D();
    node.position.set(r.pos[0], r.pos[1] + dy, r.pos[2]);
    root.add(node);
    mesh(r.geos, node, false);
    v.rotors.push({ node, axis: r.axis, dir: r.dir, rate: r.rate });
  }
  for (const s of spec.spinners || []) {
    const node = new THREE.Object3D();
    const host = s.mount >= 0 && v.mounts[s.mount] ? /** @type {any} */ (v.mounts[s.mount]).yaw : root;
    node.position.set(s.pos[0], s.pos[1] + (host === root ? dy : 0), s.pos[2]);
    host.add(node);
    const m = mesh(s.geos, node, false);
    v.detail.push(m);
    v.spinners.push({ node, rate: s.rate });
  }
  return v;
}
