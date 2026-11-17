import * as THREE from 'three';
import { noise2 } from '../../core/math.js';
import { CONFIG } from '../../core/config.js';
import { FACTIONS } from '../factions.js';
import { WEAPON_MODELS } from './weapon-models.js';
import { BONE, BONE_COUNT, RIG } from '../soldier-rig.js';

/**
 * Soldier geometry. Every body part, weapon, magazine and accessory is a
 * "bone": geometry authored in that bone's local space and tagged with an
 * `aBone` attribute, all merged into ONE indexed geometry per faction and
 * detail level. The vertex shader looks each vertex's bone matrix up in a
 * float texture (see SoldierRenderer), so a whole army is a single draw call
 * per team and LOD.
 *
 * Style: chunky, rounded, toy-like soldiers (big helmeted heads, thick limbs,
 * mitten gloves) wearing real kit — plate carriers, pouches, knee pads,
 * packs — with a team-coloured helmet band and arm patches for readability.
 */

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Indexed part with a colour attribute; `camo` paints soft blotches from a palette.
 * @param {THREE.BufferGeometry} g @param {number|number[]} color
 */
function part(g, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, seed = 1) {
  g.deleteAttribute('uv');
  _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(1, 1, 1));
  g.applyMatrix4(_m);
  const n = g.attributes.position.count, pos = g.attributes.position.array;
  const col = new Float32Array(n * 3);
  const pal = Array.isArray(color) ? color : [color];
  for (let i = 0; i < n; i++) {
    let hex = pal[0];
    if (pal.length > 1) {
      const v = noise2(pos[i * 3] * 9 + seed * 3.1 + pos[i * 3 + 1] * 4, pos[i * 3 + 2] * 9 + pos[i * 3 + 1] * 7 - seed, 31 + seed) * 0.5 + 0.5;
      hex = pal[Math.min(pal.length - 1, Math.floor(v * pal.length * 1.1))];
    }
    _c.set(hex);
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!g.index) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return g;
}

/** Rounded box: a subdivided box whose vertices are pushed onto a rounded hull. */
function rbox(w, h, d, r, seg = 3) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const p = g.attributes.position, nrm = g.attributes.normal;
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
  const v = new THREE.Vector3(), inner = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    inner.set(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
    v.sub(inner).normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
    v.multiplyScalar(r).add(inner);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}
/** Capsule hanging from the origin down to -len. */
const limb = (r, len, radial, cap) => new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), cap, radial).translate(0, -len / 2, 0);
const ball = (r, ws, hs, sx = 1, sy = 1, sz = 1) => new THREE.SphereGeometry(r, ws, hs).scale(sx, sy, sz);
const dome = (r, ws, hs, sx = 1, sy = 1, sz = 1) => new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, Math.PI * 0.56).scale(sx, sy, sz);
const ring = (r, h, seg) => new THREE.CylinderGeometry(r, r, h, seg, 1, true);
const cyl = (r0, r1, h, seg) => new THREE.CylinderGeometry(r0, r1, h, seg);
const bx = (w, h, d) => new THREE.BoxGeometry(w, h, d);

/** Converts a non-indexed kit geometry (weapons) into an indexed part. */
function kitPart(geos) {
  const out = [];
  for (const g of geos) {
    const n = g.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    out.push(g);
  }
  return out;
}

/**
 * Per-bone geometry lists for a faction.
 * @param {string} factionId @param {number} team @param {0|1} lod
 * @returns {THREE.BufferGeometry[][]} indexed by bone
 */
export function buildSoldierParts(factionId, team, lod) {
  const f = FACTIONS[factionId], u = f.uniform, hi = lod === 0;
  const teamHex = CONFIG.teams[team].color;
  const camo = u.camo, vest = u.vest[0], helmet = factionId === 'torsa' ? camo : u.helmet, skin = u.skin[0];
  const gloves = u.gloves[0], boots = u.boots[0], strap = u.strap[0], cloth = u.cloth[0];
  const R = hi ? 8 : 5, C = hi ? 2 : 1;
  /** @type {THREE.BufferGeometry[][]} */
  const bones = Array.from({ length: BONE_COUNT }, () => []);
  const add = (b, g) => bones[b].push(g);

  // --- Pelvis: hips, belt and pouches -------------------------------------------------
  add(BONE.PELVIS, part(rbox(0.38, 0.24, 0.27, 0.1, hi ? 2 : 1), camo, 0, 0.0, 0, 0, 0, 0, 2));
  if (hi) add(BONE.PELVIS, part(rbox(0.41, 0.07, 0.29, 0.03, 1), strap, 0, 0.08, 0));
  if (hi) {
    for (const x of [-0.12, 0.12]) add(BONE.PELVIS, part(rbox(0.09, 0.1, 0.06, 0.025, 1), vest, x, 0.04, 0.15));
    add(BONE.PELVIS, part(rbox(0.12, 0.13, 0.09, 0.03, 1), vest, -0.13, 0.0, -0.15));
  }

  // --- Torso: body, plate carrier, pouches, pack ----------------------------------------
  add(BONE.TORSO, part(rbox(0.46, 0.52, 0.3, 0.14, 2), camo, 0, 0.26, 0, 0, 0, 0, 3));
  add(BONE.TORSO, part(rbox(0.5, 0.33, 0.37, 0.07, 1), vest, 0, 0.27, 0));
  if (hi) add(BONE.TORSO, part(cyl(0.12, 0.14, 0.08, R), cloth, 0, 0.51, 0));
  if (hi) {
    for (const x of [-0.11, 0, 0.11]) add(BONE.TORSO, part(rbox(0.085, 0.12, 0.055, 0.02, 1), vest, x, 0.19, 0.2));
    add(BONE.TORSO, part(rbox(0.07, 0.15, 0.06, 0.02, 1), strap, 0.15, 0.36, 0.19));
    add(BONE.TORSO, part(cyl(0.008, 0.008, 0.25, 4), 0x1d1e1f, 0.17, 0.52, 0.14));
    add(BONE.TORSO, part(bx(0.08, 0.06, 0.012), teamHex, -0.12, 0.38, 0.19));
    for (const x of [-0.16, 0.16]) add(BONE.TORSO, part(bx(0.07, 0.03, 0.36), strap, x, 0.45, 0));
    add(BONE.TORSO, part(rbox(0.32, 0.32, 0.15, 0.05, 1), factionId === 'torsa' ? strap : vest, 0, 0.28, -0.24));
    add(BONE.TORSO, part(rbox(0.26, 0.08, 0.08, 0.03, 1), cloth, 0, 0.47, -0.22));
  } else add(BONE.TORSO, part(bx(0.28, 0.28, 0.12), strap, 0, 0.28, -0.22));

  // --- Head: face, helmet, eyewear --------------------------------------------------------
  const hy = 0.15;
  if (f.balaclava) {
    add(BONE.HEAD, part(ball(0.162, R + 1, R - 1, 1, 1.02, 1), 0x34372e, 0, hy, 0.01));
    add(BONE.HEAD, part(rbox(0.19, 0.06, 0.05, 0.02, 1), skin, 0, hy + 0.015, 0.135));
  } else {
    add(BONE.HEAD, part(ball(0.162, R + 1, R - 1, 1, 1.02, 1), skin, 0, hy, 0.01));
    if (hi) add(BONE.HEAD, part(ball(0.035, 6, 4, 1, 0.8, 1), skin, 0, hy - 0.01, 0.165));
  }
  if (hi) for (const x of [-0.055, 0.055]) add(BONE.HEAD, part(ball(0.022, 5, 3, 1, 1.2, 0.6), 0x15171a, x, hy + 0.02, 0.152));
  add(BONE.HEAD, part(dome(0.188, R + 2, hi ? 4 : 2, 1.0, 0.95, 1.07), helmet, 0, hy + 0.03, -0.005, 0, 0, 0, 5));
  add(BONE.HEAD, part(ring(0.193, 0.035, R + 2), teamHex, 0, hy + 0.07, 0));
  if (hi) {
    if (factionId === 'torsa') {
      add(BONE.HEAD, part(rbox(0.22, 0.065, 0.06, 0.025, 1), 0x2a2d2a, 0, hy + 0.15, 0.15, -0.35));
      add(BONE.HEAD, part(bx(0.16, 0.04, 0.02), 0x5d8a8f, 0, hy + 0.15, 0.18, -0.35));
    } else {
      add(BONE.HEAD, part(rbox(0.21, 0.045, 0.05, 0.02, 1), 0x1b1d20, 0, hy + 0.02, 0.15));
      for (const x of [-0.175, 0.175]) add(BONE.HEAD, part(cyl(0.06, 0.06, 0.05, 8), 0x2a2b2c, x, hy - 0.005, 0, 0, 0, Math.PI / 2));
      add(BONE.HEAD, part(bx(0.06, 0.05, 0.04), 0x2a2b2c, 0, hy + 0.16, 0.17));
    }
  }

  // --- Arms ---------------------------------------------------------------------------------
  for (const [ub, fb, side] of [[BONE.UARM_L, BONE.FARM_L, 1], [BONE.UARM_R, BONE.FARM_R, -1]]) {
    add(ub, part(limb(0.078, RIG.upperArm + 0.03, R - 2, C), camo, 0, 0.015, 0, 0, 0, 0, 7 + side));
    add(ub, part(bx(0.02, 0.07, 0.07), teamHex, side * 0.075, -0.08, 0));
    add(fb, part(limb(0.07, RIG.foreArm - 0.06, R - 2, C), camo, 0, 0, 0, 0, 0, 0, 9 + side));
    add(fb, part(ball(0.074, R - 2, Math.max(3, R - 4), 0.95, 1.15, 1.05), gloves, 0, -RIG.foreArm + 0.01, 0.005));
    if (hi) add(fb, part(ball(0.05, 6, 4, 1, 0.8, 1), vest, 0, 0.0, -0.03));
  }

  // --- Legs ---------------------------------------------------------------------------------
  for (const [tb, sb, side] of [[BONE.THIGH_L, BONE.SHIN_L, 1], [BONE.THIGH_R, BONE.SHIN_R, -1]]) {
    add(tb, part(limb(0.098, RIG.thigh + 0.04, R - 2, C), camo, 0, 0.02, 0, 0, 0, 0, 11 + side));
    if (hi) add(tb, part(rbox(0.04, 0.12, 0.11, 0.015, 1), cloth, side * 0.095, -0.2, 0.01));
    add(sb, part(limb(0.086, RIG.shin - 0.05, R - 2, C), camo, 0, 0, 0, 0, 0, 0, 13 + side));
    if (hi) add(sb, part(rbox(0.12, 0.1, 0.07, 0.03, 1), vest, 0, -0.03, 0.07));
    add(sb, part(rbox(0.13, 0.12, 0.27, 0.05, 1), boots, 0, -RIG.shin + 0.04, 0.04));
  }

  // --- Weapons, magazines, AT pack and parachute -------------------------------------------
  const weaponBones = [[f.rifles[0], BONE.RIFLE_A, BONE.MAG_A], [f.rifles[1] || f.rifles[0], BONE.RIFLE_B, BONE.MAG_B], [f.launcher, BONE.LAUNCHER, BONE.ROCKET]];
  for (const [id, wb, mb] of weaponBones) {
    if (wb === BONE.RIFLE_B && !f.rifles[1]) continue;
    const g = WEAPON_MODELS[id].build(lod);
    bones[wb].push(...kitPart(g.body));
    bones[mb].push(...kitPart(g.mag));
  }
  add(BONE.PACK, part(rbox(0.28, 0.34, 0.14, 0.05, hi ? 2 : 1), strap, 0, 0, 0));
  for (const x of [-0.07, 0.07]) {
    add(BONE.PACK, part(cyl(0.035, 0.035, 0.24, 6), 0x4c5a32, x, 0.22, 0.01));
    add(BONE.PACK, part(cyl(0.0, 0.045, 0.14, 6), 0x4c5a32, x, 0.4, 0.01));
  }
  add(BONE.CHUTE, part(dome(2.3, hi ? 10 : 6, 2, 1, 0.55, 1), factionId === 'torsa' ? [0x6b7348, 0x59603c] : [0xb5a27a, 0x9c8a62], 0, 3.0, 0));
  add(BONE.CHUTE, part(ring(2.3, 0.18, hi ? 10 : 6), teamHex, 0, 3.05, 0));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const tx = Math.cos(a) * 2.1, tz = Math.sin(a) * 2.1;
    const len = Math.hypot(tx, 2.6, tz);
    add(BONE.CHUTE, part(cyl(0.008, 0.008, len, 3), 0xd8d2c0, tx / 2, 0.3 + 1.3, tz / 2, Math.atan2(tz, 2.6), 0, -Math.atan2(tx, 2.6)));
  }
  return bones;
}

/**
 * Merges every bone's parts into one indexed geometry with an `aBone` attribute.
 * @param {THREE.BufferGeometry[][]} bones
 */
export function mergeSkinned(bones) {
  let vCount = 0, iCount = 0;
  for (const list of bones) for (const g of list) { vCount += g.attributes.position.count; iCount += g.index.count; }
  const pos = new Float32Array(vCount * 3), nrm = new Float32Array(vCount * 3), col = new Float32Array(vCount * 3), bone = new Float32Array(vCount);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0, io = 0;
  bones.forEach((list, b) => {
    for (const g of list) {
      const n = g.attributes.position.count;
      if (!g.attributes.normal) g.computeVertexNormals();
      pos.set(/** @type {Float32Array} */ (g.attributes.position.array).subarray(0, n * 3), vo * 3);
      nrm.set(/** @type {Float32Array} */ (g.attributes.normal.array).subarray(0, n * 3), vo * 3);
      col.set(/** @type {Float32Array} */ (g.attributes.color.array).subarray(0, n * 3), vo * 3);
      bone.fill(b, vo, vo + n);
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
      vo += n; io += src.length;
      g.dispose();
    }
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('aBone', new THREE.BufferAttribute(bone, 1));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
