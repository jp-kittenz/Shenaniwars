import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Bakes a flat vertex colour into a geometry (non-indexed-safe). */
function paint(geo, color) {
  _c.set(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function place(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(1, 1, 1));
  return geo.applyMatrix4(_m);
}

/** Vertex-coloured box part. */
export function box(w, h, d, x, y, z, color, rx = 0, ry = 0, rz = 0) {
  return place(paint(new THREE.BoxGeometry(w, h, d), color), x, y, z, rx, ry, rz);
}

/** Vertex-coloured cylinder / cone part (axis along Y before rotation). */
export function cyl(rTop, rBot, h, seg, x, y, z, color, rx = 0, ry = 0, rz = 0) {
  return place(paint(new THREE.CylinderGeometry(rTop, rBot, h, seg), color), x, y, z, rx, ry, rz);
}

/** Vertex-coloured low-poly blob (rocks). */
export function blob(r, detail, x, y, z, color) {
  return place(paint(new THREE.IcosahedronGeometry(r, detail), color), x, y, z);
}

/**
 * Merges parts into one draw call and frees the sources.
 * @param {THREE.BufferGeometry[]} parts
 */
export function merge(parts) {
  const prepared = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = mergeGeometries(prepared, false);
  for (const g of parts) g.dispose();
  for (const g of prepared) g.dispose();
  return out;
}
