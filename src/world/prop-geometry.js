import * as THREE from 'three';
import { box, cyl, blob, merge } from './geo.js';

/**
 * @typedef {Object} Template
 * @property {Float32Array} pos @property {Float32Array} nrm @property {Float32Array} col
 * @property {number} count vertex count
 */

/** @param {THREE.BufferGeometry} geo @returns {Template} */
function toTemplate(geo) {
  geo.computeVertexNormals();
  const t = {
    pos: /** @type {Float32Array} */ (geo.attributes.position.array.slice()),
    nrm: /** @type {Float32Array} */ (geo.attributes.normal.array.slice()),
    col: /** @type {Float32Array} */ (geo.attributes.color.array.slice()),
    count: geo.attributes.position.count,
  };
  geo.dispose();
  return t;
}

let _templates = null;

/** Lazily built unit templates for every static prop type and LOD. */
export function propTemplates() {
  if (_templates) return _templates;
  const BARK = 0x4a3a28, LEAF_A = 0x2f5a2a, LEAF_B = 0x3b6b2e, ROCK = 0x77736b, CONCRETE = 0x8d8a82;
  _templates = {
    tree: [
      toTemplate(merge([cyl(0.16, 0.3, 2.4, 5, 0, 1.2, 0, BARK), cyl(0, 1.75, 3.0, 6, 0, 3.4, 0, LEAF_A), cyl(0, 1.25, 2.5, 6, 0, 5.0, 0, LEAF_B)])),
      toTemplate(merge([cyl(0.2, 0.28, 2.0, 3, 0, 1.0, 0, BARK), cyl(0, 1.7, 4.4, 4, 0, 4.0, 0, LEAF_A)])),
    ],
    rock: [toTemplate(merge([blob(1, 0, 0, 0.2, 0, ROCK)])), null],
    wall: [toTemplate(merge([box(2, 2, 2, 0, 0, 0, CONCRETE)])), toTemplate(merge([box(2, 2, 2, 0, 0, 0, CONCRETE)]))],
  };
  return _templates;
}

const hash = (n) => {
  n = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
};

/**
 * Bakes every static prop of a chunk into one vertex-coloured mesh geometry
 * (one draw call per chunk and LOD). Templates are transformed straight into
 * preallocated typed arrays, so chunk streaming causes no per-prop allocation.
 * @param {import('./map-generator.js').Prop[]} props
 * @param {0|1} lod
 * @returns {THREE.BufferGeometry|null}
 */
export function buildPropGeometry(props, lod) {
  const T = propTemplates();
  let total = 0;
  for (const p of props) {
    const t = T[p.type] && T[p.type][lod];
    if (t && !(lod === 1 && p.type === 'wall' && p.hx < 2.5)) total += t.count;
  }
  if (total === 0) return null;
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const p of props) {
    const t = T[p.type] && T[p.type][lod];
    if (!t || (lod === 1 && p.type === 'wall' && p.hx < 2.5)) continue;
    let sx, sy, sz, oy = 0;
    if (p.type === 'wall') { sx = p.hx; sy = p.hy; sz = p.hz; oy = p.hy - 0.15; }
    else if (p.type === 'rock') { sx = p.scale; sy = p.scale * (0.6 + hash(p.id) * 0.35); sz = p.scale * (0.8 + hash(p.id + 7) * 0.4); }
    else { sx = sz = p.scale; sy = p.scale * (0.9 + hash(p.id) * 0.3); }
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    const tint = 0.82 + hash(p.id * 3 + 1) * 0.36;
    for (let i = 0; i < t.count; i++, o += 3) {
      const i3 = i * 3;
      const x = t.pos[i3] * sx, y = t.pos[i3 + 1] * sy, z = t.pos[i3 + 2] * sz;
      pos[o] = p.x + x * c + z * s; pos[o + 1] = p.y + oy + y; pos[o + 2] = p.z - x * s + z * c;
      const nx = t.nrm[i3], nz = t.nrm[i3 + 2];
      nrm[o] = nx * c + nz * s; nrm[o + 1] = t.nrm[i3 + 1]; nrm[o + 2] = -nx * s + nz * c;
      col[o] = t.col[i3] * tint; col[o + 1] = t.col[i3 + 1] * tint; col[o + 2] = t.col[i3 + 2] * tint;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}
