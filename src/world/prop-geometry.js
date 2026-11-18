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

/**
 * How a template is placed: 'box' templates are authored in a unit box
 * [-1, 1]³ and stretched to the prop's half extents (sitting on the ground);
 * 'scale' templates are uniformly scaled by `prop.scale`; 'metric' ones are
 * authored in metres and placed as they are.
 * @type {Record<string, 'box'|'scale'|'metric'>}
 */
export const PROP_MODE = {
  tree: 'scale', rock: 'scale', bush: 'scale',
  wall: 'box', log: 'box', debris: 'box', bench: 'box', well: 'box', silo: 'box', haybale: 'box', tractor: 'box', harvester: 'box',
  sandbag: 'box', container: 'box', tankwreck: 'box', carwreck: 'box', truckwreck: 'box', car: 'box', fueltank: 'box', samsite: 'box',
  barrier: 'box', crate: 'box', fence: 'box',
  radar: 'metric', pole: 'metric', crane: 'metric', streetlight: 'metric',
};

/** Pure white template vertices take the prop's hue (containers, cars, machinery). */
export const TINT = 0xffffff;
const C = {
  BARK: 0x4a3a28, LEAF_A: 0x2f5a2a, LEAF_B: 0x3b6b2e, LEAF_C: 0x46702f, ROCK: 0x77736b, CONCRETE: 0x8d8a82, BRICK: 0x8a5745,
  WOOD: 0x6b4e33, STONE: 0x8a857a, WATER: 0x22343c, METAL: 0x8f949a, ROOF: 0x6a4b3a, HAY: 0xc9a94a, TYRE: 0x1f1f1f,
  SAND: 0xa8956a, DARK: 0x2c2f33, BURNT: 0x2f2b28, BURNT2: 0x3d3631, RUST: 0x6e4630, RUST2: 0x5a3a2a, GLASS: 0x34464f,
  TANK: 0xc9c6bd, STEEL: 0x6c7176, LAMP: 0xfff2c0, OLIVE: 0x4f5a3a, YELLOW: 0xc9a23a,
};

let _templates = null;

/** Lazily built templates per prop type: [high detail, low detail | null]. */
export function propTemplates() {
  if (_templates) return _templates;
  const T = (parts) => toTemplate(merge(parts));
  const H = Math.PI / 2;
  _templates = {
    tree: [
      T([cyl(0.16, 0.3, 2.4, 5, 0, 1.2, 0, C.BARK), cyl(0, 1.75, 3.0, 6, 0, 3.4, 0, C.LEAF_A), cyl(0, 1.25, 2.5, 6, 0, 5.0, 0, C.LEAF_B)]),
      T([cyl(0.2, 0.28, 2.0, 3, 0, 1.0, 0, C.BARK), cyl(0, 1.7, 4.4, 4, 0, 4.0, 0, C.LEAF_A)]),
    ],
    rock: [T([blob(1, 0, 0, 0.2, 0, C.ROCK)]), null],
    bush: [T([blob(0.9, 0, 0, 0.55, 0, C.LEAF_B), blob(0.7, 0, 0.55, 0.45, 0.3, C.LEAF_C), blob(0.6, 0, -0.45, 0.4, -0.3, C.LEAF_A)]), null],
    log: [T([cyl(1, 1, 2, 7, 0, 0, 0, C.BARK, H, 0, 0)]), null],
    wall: [T([box(2, 2, 2, 0, 0, 0, C.CONCRETE)]), T([box(2, 2, 2, 0, 0, 0, C.CONCRETE)])],
    debris: [T([box(1.4, 0.9, 1.1, -0.25, -0.55, 0, C.CONCRETE, 0.15, 0.3, 0.2), box(1.1, 0.7, 1.3, 0.4, -0.6, 0.3, C.BRICK, 0.2, -0.4, 0), box(0.8, 1.2, 0.4, 0.05, -0.3, -0.35, C.CONCRETE, 0.4, 0.8, 0)]), null],
    bench: [T([box(2, 0.3, 0.9, 0, 0.05, 0.1, C.WOOD), box(2, 0.9, 0.15, 0, 0.55, -0.85, C.WOOD), box(0.12, 1, 0.8, -0.85, -0.5, 0, C.DARK), box(0.12, 1, 0.8, 0.85, -0.5, 0, C.DARK)]), null],
    well: [T([cyl(1, 1, 1.6, 10, 0, -0.2, 0, C.STONE), cyl(0.82, 0.82, 0.1, 10, 0, 0.62, 0, C.WATER)]), null],
    silo: [T([cyl(1, 1, 1.7, 12, 0, -0.15, 0, C.METAL), cyl(0, 1.06, 0.3, 12, 0, 0.85, 0, C.ROOF)]), T([cyl(1, 1, 2, 5, 0, 0, 0, C.METAL)])],
    haybale: [T([cyl(1, 1, 2, 9, 0, 0, 0, C.HAY, 0, 0, H)]), null],
    tractor: [T([box(1.2, 0.8, 1.6, 0, -0.1, 0.35, TINT), box(1.3, 0.9, 0.85, 0, 0.55, -0.4, TINT), box(1.0, 0.05, 0.9, 0, 1.02, -0.4, C.DARK),
      cyl(0.75, 0.75, 0.35, 10, 0.95, -0.25, -0.5, C.TYRE, 0, 0, H), cyl(0.75, 0.75, 0.35, 10, -0.95, -0.25, -0.5, C.TYRE, 0, 0, H),
      cyl(0.42, 0.42, 0.3, 8, 0.85, -0.58, 0.65, C.TYRE, 0, 0, H), cyl(0.42, 0.42, 0.3, 8, -0.85, -0.58, 0.65, C.TYRE, 0, 0, H)]), T([box(2, 1.6, 2, 0, -0.2, 0, TINT)])],
    harvester: [T([box(1.6, 1.3, 1.5, 0, 0, -0.2, TINT), box(1.0, 0.7, 0.6, 0, 0.75, 0.25, TINT), box(2.0, 0.35, 0.45, 0, -0.6, 0.95, C.YELLOW),
      cyl(0.6, 0.6, 0.3, 10, 0.9, -0.4, 0.3, C.TYRE, 0, 0, H), cyl(0.6, 0.6, 0.3, 10, -0.9, -0.4, 0.3, C.TYRE, 0, 0, H)]), T([box(2, 1.8, 2, 0, -0.1, 0, TINT)])],
    sandbag: [T([box(2, 0.95, 1.9, 0, -0.5, 0, C.SAND), box(1.7, 0.95, 1.6, 0.05, 0.45, 0, 0x9a8862)]), null],
    container: [T([box(2, 2, 2, 0, 0, 0, TINT), box(1.92, 1.9, 0.02, 0, 0, 1.0, C.DARK), box(2.04, 0.06, 2.04, 0, 0.97, 0, 0x55595e)]), T([box(2, 2, 2, 0, 0, 0, TINT)])],
    tankwreck: [T([box(2, 0.9, 2, 0, -0.5, 0, C.BURNT), box(1.15, 0.6, 1.0, 0.1, 0.25, -0.1, C.BURNT2, 0, 0.5, 0), box(0.14, 0.16, 1.2, 0.55, 0.3, 0.55, C.BURNT2, 0.2, 0.5, 0),
      box(2.1, 0.45, 2.04, 0, -0.75, 0, C.DARK)]), T([box(2, 1.4, 2, 0, -0.3, 0, C.BURNT)])],
    carwreck: [T([box(2, 0.95, 2, 0, -0.4, 0, C.RUST), box(1.6, 0.6, 1.0, 0, 0.4, -0.1, C.BURNT, 0.1, 0, 0.08)]), null],
    truckwreck: [T([box(2, 1.6, 0.62, 0, -0.1, 0.68, C.RUST), box(2, 1.0, 1.25, 0, -0.45, -0.35, C.RUST2), box(1.6, 0.5, 0.4, 0, 0.7, 0.68, C.BURNT)]), T([box(2, 1.6, 2, 0, -0.2, 0, C.RUST)])],
    car: [T([box(2, 0.9, 2, 0, -0.45, 0, TINT), box(1.8, 0.75, 1.0, 0, 0.35, -0.1, TINT), box(1.84, 0.5, 0.94, 0, 0.38, -0.1, C.GLASS),
      cyl(0.36, 0.36, 0.22, 8, 0.95, -0.82, 0.62, C.TYRE, 0, 0, H), cyl(0.36, 0.36, 0.22, 8, -0.95, -0.82, 0.62, C.TYRE, 0, 0, H),
      cyl(0.36, 0.36, 0.22, 8, 0.95, -0.82, -0.62, C.TYRE, 0, 0, H), cyl(0.36, 0.36, 0.22, 8, -0.95, -0.82, -0.62, C.TYRE, 0, 0, H)]), null],
    fueltank: [T([cyl(1, 1, 1.8, 10, 0, -0.1, 0, C.TANK), cyl(0.25, 0.25, 0.2, 6, 0.3, 0.9, 0.3, C.STEEL), box(0.12, 0.6, 0.12, 0.98, -0.6, 0, C.STEEL)]), T([cyl(1, 1, 2, 5, 0, 0, 0, C.TANK)])],
    samsite: [T([box(2, 0.6, 2, 0, -0.7, 0, C.OLIVE), box(0.5, 0.5, 0.5, 0, -0.15, 0, C.DARK),
      ...[-0.45, 0.45].flatMap((x) => [0.22, 0.62].map((y) => cyl(0.18, 0.18, 1.9, 6, x, y, 0.1, C.OLIVE, -1.05, 0, 0)))]), T([box(2, 1.4, 2, 0, -0.3, 0, C.OLIVE)])],
    radar: [T([cyl(0.12, 0.2, 7, 6, 0, 3.5, 0, C.STEEL), box(2.6, 1.5, 0.15, 0, 7.4, 0.3, C.METAL, -0.35, 0, 0), box(0.8, 0.5, 0.6, 0, 6.8, 0, C.DARK)]), null],
    pole: [T([cyl(0.1, 0.15, 10, 6, 0, 5, 0, C.STEEL), box(1.2, 0.45, 0.55, 0, 9.9, 0.25, C.DARK), box(1.1, 0.35, 0.05, 0, 9.9, 0.53, C.LAMP)]), null],
    crane: [T([
      ...[-2.2, 2.2].flatMap((x) => [-2.2, 2.2].map((z) => box(0.45, 17, 0.45, x, 8.5, z, C.YELLOW))),
      box(5.4, 0.4, 0.3, 0, 6, 2.2, C.YELLOW), box(5.4, 0.4, 0.3, 0, 6, -2.2, C.YELLOW), box(5.4, 0.4, 0.3, 0, 12, 2.2, C.YELLOW), box(5.4, 0.4, 0.3, 0, 12, -2.2, C.YELLOW),
      box(5.6, 1.6, 5.6, 0, 17.6, 0, C.YELLOW), box(2.2, 2.0, 2.2, 0, 19.4, 0, C.DARK),
      box(1.3, 1.3, 26, 0, 18.4, 10, C.YELLOW), box(3, 2.4, 4, 0, 18.4, -5, C.CONCRETE), box(0.08, 12, 0.08, 0, 12.4, 21, C.DARK), box(1.6, 0.6, 1.6, 0, 6.2, 21, C.DARK)]),
    T([box(5, 17, 5, 0, 8.5, 0, C.YELLOW), box(1.3, 1.3, 26, 0, 18.4, 10, C.YELLOW)])],
    // Instanced destructibles (see ChunkManager): single high template.
    barrier: [T([box(2, 2, 2, 0, 0, 0, 0xa9a69c)]), null],
    crate: [T([box(2, 2, 2, 0, 0, 0, 0x8a6a3c), box(2.04, 0.2, 2.04, 0, 0.6, 0, 0x6e5430), box(2.04, 0.2, 2.04, 0, -0.6, 0, 0x6e5430)]), null],
    fence: [T([box(0.07, 2, 1.2, -0.96, 0, 0, C.WOOD), box(0.07, 2, 1.2, 0, 0, 0, C.WOOD), box(0.07, 2, 1.2, 0.96, 0, 0, C.WOOD),
      box(2, 0.16, 0.8, 0, 0.45, 0, 0x7a5a3a), box(2, 0.16, 0.8, 0, -0.25, 0, 0x7a5a3a)]), null],
    streetlight: [T([cyl(0.08, 0.12, 7.2, 6, 0, 3.6, 0, C.STEEL), box(0.08, 0.08, 1.4, 0, 7.1, 0.65, C.STEEL), box(0.32, 0.14, 0.5, 0, 7.0, 1.3, C.DARK), box(0.26, 0.04, 0.42, 0, 6.92, 1.3, C.LAMP)]), null],
  };
  return _templates;
}

const hash = (n) => {
  n = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
};

const _tint = new THREE.Color();
/** Hue-driven paint for containers, cars and machinery. */
export function tintOf(hue, out = _tint) {
  return out.setHSL(hue, 0.42 + hue * 0.2, 0.3 + (1 - hue) * 0.12, THREE.SRGBColorSpace);
}

/** Placement scale and lift of a prop's template. */
export function placement(p, out) {
  const mode = PROP_MODE[p.type] || 'box';
  if (mode === 'box') { out.sx = p.hx; out.sy = p.hy; out.sz = p.hz; out.oy = p.hy - (p.type === 'wall' ? 0.15 : 0.05); }
  else if (mode === 'scale') {
    if (p.type === 'rock') { out.sx = p.scale; out.sy = p.scale * (0.6 + hash(p.id) * 0.35); out.sz = p.scale * (0.8 + hash(p.id + 7) * 0.4); }
    else { out.sx = out.sz = p.scale; out.sy = p.scale * (0.9 + hash(p.id) * 0.3); }
    out.oy = 0;
  } else { out.sx = out.sy = out.sz = 1; out.oy = 0; }
  return out;
}

/** Static (non-destructible) props drawn in the batched chunk meshes. */
const lodSkip = (p, lod) => lod === 1 && p.type === 'wall' && p.hx < 2.5;
const _pl = { sx: 1, sy: 1, sz: 1, oy: 0 };

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
    if (t && !lodSkip(p, lod)) total += t.count;
  }
  if (total === 0) return null;
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const p of props) {
    const t = T[p.type] && T[p.type][lod];
    if (!t || lodSkip(p, lod)) continue;
    const { sx, sy, sz, oy } = placement(p, _pl);
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    const tint = 0.82 + hash(p.id * 3 + 1) * 0.36;
    const paint = p.hue !== undefined ? tintOf(p.hue) : null;
    for (let i = 0; i < t.count; i++, o += 3) {
      const i3 = i * 3;
      const x = t.pos[i3] * sx, y = t.pos[i3 + 1] * sy, z = t.pos[i3 + 2] * sz;
      pos[o] = p.x + x * c + z * s; pos[o + 1] = p.y + oy + y; pos[o + 2] = p.z - x * s + z * c;
      // Non-uniform stretch: correct the normal by the inverse scale.
      let nx = t.nrm[i3] / sx, ny = t.nrm[i3 + 1] / sy, nz = t.nrm[i3 + 2] / sz;
      const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
      nx *= inv; ny *= inv; nz *= inv;
      nrm[o] = nx * c + nz * s; nrm[o + 1] = ny; nrm[o + 2] = -nx * s + nz * c;
      const white = t.col[i3] > 0.99 && t.col[i3 + 1] > 0.99 && t.col[i3 + 2] > 0.99;
      if (white && paint) { col[o] = paint.r * tint; col[o + 1] = paint.g * tint; col[o + 2] = paint.b * tint; }
      else { col[o] = t.col[i3] * tint; col[o + 1] = t.col[i3 + 1] * tint; col[o + 2] = t.col[i3 + 2] * tint; }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Template geometry for an instanced destructible type (barrier, crate,
 * fence, streetlight), ready for an InstancedMesh.
 * @param {string} type
 */
export function destructibleGeometry(type) {
  const t = propTemplates()[type][0];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(t.pos.slice(), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(t.nrm.slice(), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(t.col.slice(), 3));
  geo.computeBoundingSphere();
  return geo;
}
