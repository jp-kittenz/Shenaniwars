import * as THREE from 'three';
import { noise2 } from '../../core/math.js';
import { CONFIG } from '../../core/config.js';
import { FACTIONS } from '../factions.js';
import { WEAPON_MODELS } from './weapon-models.js';
import { BONE, BONE_COUNT, RIG } from '../soldier-rig.js';
import { Role, SKIN_COUNT, SKIN_SF_B, SKIN_MORTAR_B } from '../../ai/roles.ts';

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
  g.userData.col = color;
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
  // Role skins (Milestone 3): every part carries the set of skins it is drawn for (ALL by default) and, for
  // uniform cloth (camo, vest, cloth), the tint flag the shader uses per skin.
  const isCloth = (c) => c === camo || c === vest || c === cloth;
  const add = (b, g, mask = ALL_SKINS) => { g.userData.roles = mask | (isCloth(g.userData.col) ? CLOTH : 0); bones[b].push(g); };
  const only = (...skins) => skins.reduce((m, k) => m | (1 << k), 0);
  const except = (...skins) => ALL_SKINS & ~only(...skins);
  const RO = Role;

  // --- Pelvis: hips, belt and pouches -------------------------------------------------
  add(BONE.PELVIS, part(rbox(0.38, 0.24, 0.27, 0.1, hi ? 2 : 1), camo, 0, 0.0, 0, 0, 0, 0, 2));
  if (hi) add(BONE.PELVIS, part(rbox(0.41, 0.07, 0.29, 0.03, 1), strap, 0, 0.08, 0));
  if (hi) {
    for (const x of [-0.12, 0.12]) add(BONE.PELVIS, part(rbox(0.09, 0.1, 0.06, 0.025, 1), vest, x, 0.04, 0.15));
    add(BONE.PELVIS, part(rbox(0.12, 0.13, 0.09, 0.03, 1), vest, -0.13, 0.0, -0.15));
  }

  // --- Torso: body, plate carrier, pouches, pack ----------------------------------------
  const PACK = only(RO.SOLDIER, RO.SAPPER, RO.SHOCK, RO.BREACHER);
  add(BONE.TORSO, part(rbox(0.46, 0.52, 0.3, 0.14, 2), camo, 0, 0.26, 0, 0, 0, 0, 3));
  add(BONE.TORSO, part(rbox(0.5, 0.33, 0.37, 0.07, 1), vest, 0, 0.27, 0));
  if (hi) add(BONE.TORSO, part(cyl(0.12, 0.14, 0.08, R), cloth, 0, 0.51, 0));
  if (hi) {
    for (const x of [-0.11, 0, 0.11]) add(BONE.TORSO, part(rbox(0.085, 0.12, 0.055, 0.02, 1), vest, x, 0.19, 0.2));
    add(BONE.TORSO, part(rbox(0.07, 0.15, 0.06, 0.02, 1), strap, 0.15, 0.36, 0.19));
    add(BONE.TORSO, part(cyl(0.008, 0.008, 0.25, 4), 0x1d1e1f, 0.17, 0.52, 0.14));
    add(BONE.TORSO, part(bx(0.08, 0.06, 0.012), teamHex, -0.12, 0.38, 0.19));
    for (const x of [-0.16, 0.16]) add(BONE.TORSO, part(bx(0.07, 0.03, 0.36), strap, x, 0.45, 0));
    add(BONE.TORSO, part(rbox(0.32, 0.32, 0.15, 0.05, 1), factionId === 'torsa' ? strap : vest, 0, 0.28, -0.24), PACK);
    add(BONE.TORSO, part(rbox(0.26, 0.08, 0.08, 0.03, 1), cloth, 0, 0.47, -0.22), PACK);
  } else add(BONE.TORSO, part(bx(0.28, 0.28, 0.12), strap, 0, 0.28, -0.22), PACK);

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
  const HELMET = except(RO.SAPPER, RO.MECHANIC, RO.SCOUT, RO.MARKSMAN, RO.OPERATOR);
  add(BONE.HEAD, part(dome(0.188, R + 2, hi ? 4 : 2, 1.0, 0.95, 1.07), helmet, 0, hy + 0.03, -0.005, 0, 0, 0, 5), HELMET);
  add(BONE.HEAD, part(ring(0.193, 0.035, R + 2), teamHex, 0, hy + 0.07, 0), HELMET);
  if (hi) {
    const STOCK = only(RO.SOLDIER, RO.MEDIC, RO.MORTAR, SKIN_MORTAR_B);
    if (factionId === 'torsa') {
      add(BONE.HEAD, part(rbox(0.22, 0.065, 0.06, 0.025, 1), 0x2a2d2a, 0, hy + 0.15, 0.15, -0.35), STOCK);
      add(BONE.HEAD, part(bx(0.16, 0.04, 0.02), 0x5d8a8f, 0, hy + 0.15, 0.18, -0.35), STOCK);
    } else {
      add(BONE.HEAD, part(rbox(0.21, 0.045, 0.05, 0.02, 1), 0x1b1d20, 0, hy + 0.02, 0.15), STOCK);
      for (const x of [-0.175, 0.175]) add(BONE.HEAD, part(cyl(0.06, 0.06, 0.05, 8), 0x2a2b2c, x, hy - 0.005, 0, 0, 0, Math.PI / 2), STOCK);
      add(BONE.HEAD, part(bx(0.06, 0.05, 0.04), 0x2a2b2c, 0, hy + 0.16, 0.17), STOCK);
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

  roleKit(add, only, hi, R, hy, { camo, vest, strap, cloth, helmet, skin, teamHex, factionId });

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


/** Skins bit set: every skin (bits 0..SKIN_COUNT-1), and the uniform-cloth tint flag above them. */
const ALL_SKINS = (1 << SKIN_COUNT) - 1;
const CLOTH = 1 << SKIN_COUNT;

/**
 * Role kit (Milestone 3): headgear, rigs, packs and weapon silhouettes that make each of the twelve roles
 * recognisable at a glance. Everything is drawn in the same instanced batch; the shader collapses the pieces of
 * other skins, so the role mix costs vertices, not draw calls. The far LOD keeps the big silhouette pieces.
 */
function roleKit(add, only, hi, R, hy, c) {
  const RO = Role;
  const M = (...k) => only(...k);
  const dark = 0x23262a, steel = 0x6f7377, olive = 0x4b5433, white = 0xf0efe8, red = 0xb3242b;
  const seg = Math.max(5, R);
  // --- 1 Vehicle operator: padded tanker helmet with ear cups, goggles flipped up; hi-vis collar, crew harness.
  add(BONE.HEAD, part(dome(0.196, R + 2, hi ? 4 : 2, 1.02, 0.9, 1.08), 0x3a3d36, 0, hy + 0.02, -0.01), M(RO.OPERATOR));
  for (const x of [-0.18, 0.18]) add(BONE.HEAD, part(cyl(0.07, 0.07, 0.07, seg), 0x2a2c28, x, hy - 0.01, 0, 0, 0, Math.PI / 2), M(RO.OPERATOR));
  add(BONE.HEAD, part(rbox(0.22, 0.06, 0.06, 0.02, 1), 0x202224, 0, hy + 0.16, 0.12, -0.6), M(RO.OPERATOR));
  if (hi) add(BONE.HEAD, part(bx(0.15, 0.035, 0.02), 0x7fa3a8, 0, hy + 0.165, 0.15, -0.6), M(RO.OPERATOR));
  add(BONE.TORSO, part(cyl(0.135, 0.15, 0.06, seg), 0xd2a32a, 0, 0.53, 0), M(RO.OPERATOR));
  if (hi) for (const x of [-0.12, 0.12]) add(BONE.TORSO, part(bx(0.05, 0.4, 0.02), 0x1f2124, x, 0.28, 0.19), M(RO.OPERATOR));

  // --- 2 Medic: helmet with a white band and front cross; white brassards; oversized trauma pack.
  add(BONE.HEAD, part(ring(0.197, 0.05, R + 2), white, 0, hy + 0.12, 0), M(RO.MEDIC));
  add(BONE.HEAD, part(bx(0.075, 0.025, 0.012), red, 0, hy + 0.12, 0.196), M(RO.MEDIC));
  add(BONE.HEAD, part(bx(0.025, 0.075, 0.012), red, 0, hy + 0.12, 0.197), M(RO.MEDIC));
  for (const ub of [BONE.UARM_L, BONE.UARM_R]) {
    add(ub, part(ring(0.088, 0.08, seg), white, 0, -0.07, 0), M(RO.MEDIC));
    if (hi) add(ub, part(bx(0.012, 0.05, 0.05), red, ub === BONE.UARM_L ? 0.088 : -0.088, -0.07, 0), M(RO.MEDIC));
  }
  add(BONE.TORSO, part(rbox(0.42, 0.44, 0.24, 0.07, hi ? 2 : 1), 0x3c4630, 0, 0.27, -0.3), M(RO.MEDIC));
  add(BONE.TORSO, part(bx(0.16, 0.16, 0.02), white, 0, 0.3, -0.43), M(RO.MEDIC));
  add(BONE.TORSO, part(bx(0.1, 0.035, 0.022), red, 0, 0.3, -0.442), M(RO.MEDIC));
  add(BONE.TORSO, part(bx(0.035, 0.1, 0.022), red, 0, 0.3, -0.443), M(RO.MEDIC));
  if (hi) for (const x of [-0.23, 0.23]) add(BONE.TORSO, part(rbox(0.08, 0.16, 0.12, 0.03, 1), x < 0 ? red : white, x, 0.22, -0.28), M(RO.MEDIC));

  // --- 3 Sapper: boonie hat with blast goggles on the brow; bandolier of cylindrical charges; compact satchel.
  add(BONE.HEAD, part(cyl(0.165, 0.18, 0.12, R + 2), c.camo, 0, hy + 0.12, -0.005), M(RO.SAPPER));
  add(BONE.HEAD, part(cyl(0.29, 0.29, 0.018, R + 4), c.camo, 0, hy + 0.07, -0.005), M(RO.SAPPER));
  add(BONE.HEAD, part(rbox(0.21, 0.055, 0.05, 0.02, 1), 0x1d1f21, 0, hy + 0.09, 0.15), M(RO.SAPPER));
  if (hi) add(BONE.HEAD, part(bx(0.15, 0.03, 0.015), 0x9a7b2e, 0, hy + 0.09, 0.176), M(RO.SAPPER));
  add(BONE.TORSO, part(bx(0.07, 0.62, 0.03), c.strap, 0, 0.29, 0.2, 0, 0, 0.75), M(RO.SAPPER));
  for (let i = 0; i < (hi ? 5 : 3); i++) {
    const t = (i / (hi ? 4 : 2) - 0.5) * 0.46;
    add(BONE.TORSO, part(cyl(0.032, 0.032, 0.1, 6), 0x6c6a45, -t * 0.68 * 1.0 + 0, 0.29 + t * 0.73, 0.225, 0, 0, 0.75), M(RO.SAPPER));
  }
  add(BONE.PELVIS, part(rbox(0.2, 0.16, 0.12, 0.03, 1), olive, 0.17, -0.02, -0.12), M(RO.SAPPER));

  // --- 4 Combat engineer: heavy helmet with a lowered armoured visor; pauldrons; heavy plates; tall rucksack
  //     with rolled trench timbers and a sandbag.
  add(BONE.HEAD, part(dome(0.205, R + 2, hi ? 4 : 2, 1.04, 0.98, 1.1), 0x3f4633, 0, hy + 0.03, -0.005), M(RO.ENGINEER));
  add(BONE.HEAD, part(rbox(0.25, 0.15, 0.03, 0.02, 1), 0x5f7a7c, 0, hy + 0.03, 0.18, 0.12), M(RO.ENGINEER));
  for (const ub of [BONE.UARM_L, BONE.UARM_R]) add(ub, part(rbox(0.2, 0.09, 0.19, 0.04, 1), c.vest, ub === BONE.UARM_L ? 0.02 : -0.02, 0.0, 0), M(RO.ENGINEER));
  add(BONE.TORSO, part(rbox(0.55, 0.38, 0.42, 0.06, 1), c.vest, 0, 0.27, 0), M(RO.ENGINEER));
  add(BONE.TORSO, part(rbox(0.36, 0.62, 0.22, 0.05, hi ? 2 : 1), 0x4a4a3a, 0, 0.36, -0.3), M(RO.ENGINEER));
  add(BONE.TORSO, part(cyl(0.06, 0.06, 0.52, 7), 0x7b5b37, 0, 0.72, -0.3, 0, 0, Math.PI / 2), M(RO.ENGINEER));
  if (hi) add(BONE.TORSO, part(cyl(0.055, 0.055, 0.46, 7), 0x6e5030, 0, 0.62, -0.38, 0, 0, Math.PI / 2), M(RO.ENGINEER));
  add(BONE.TORSO, part(rbox(0.3, 0.12, 0.18, 0.05, 1), 0xa8946a, 0, 0.12, -0.36), M(RO.ENGINEER));

  // --- 5 Combat mechanic: backwards cap and a flipped-up welding visor; tool belt; blowtorch tank and wrench frame.
  add(BONE.HEAD, part(dome(0.172, R + 2, 2, 1, 0.62, 1.05), 0x2d3033, 0, hy + 0.05, -0.005), M(RO.MECHANIC));
  add(BONE.HEAD, part(bx(0.17, 0.015, 0.12), 0x2d3033, 0, hy + 0.06, -0.2), M(RO.MECHANIC));
  add(BONE.HEAD, part(rbox(0.23, 0.12, 0.03, 0.02, 1), 0x1a1c1d, 0, hy + 0.19, 0.08, -1.1), M(RO.MECHANIC));
  add(BONE.PELVIS, part(ring(0.215, 0.08, seg + 2), 0x3a2f25, 0, 0.05, 0), M(RO.MECHANIC));
  if (hi) for (const x of [-0.16, 0.16, 0]) add(BONE.PELVIS, part(rbox(0.08, 0.1, 0.06, 0.02, 1), steel, x, 0.02, 0.17), M(RO.MECHANIC));
  add(BONE.TORSO, part(cyl(0.075, 0.075, 0.44, 8), 0x8c2b22, -0.09, 0.3, -0.25), M(RO.MECHANIC));
  add(BONE.TORSO, part(cyl(0.06, 0.06, 0.36, 8), 0x2f5a6a, 0.1, 0.28, -0.25), M(RO.MECHANIC));
  add(BONE.TORSO, part(bx(0.34, 0.04, 0.04), steel, 0, 0.5, -0.27), M(RO.MECHANIC));
  if (hi) add(BONE.TORSO, part(bx(0.04, 0.5, 0.04), steel, 0.2, 0.28, -0.27), M(RO.MECHANIC));

  // --- 6 Scout: draped camouflage hood and ghillie mantle over the shoulders; chest-mounted rangefinder optic.
  const ghillie = [0x4d5a33, 0x3b4628, 0x67704a, 0x2f3720];
  add(BONE.HEAD, part(dome(0.215, R + 2, hi ? 4 : 2, 1.05, 1.12, 1.16), ghillie, 0, hy + 0.01, -0.03, 0, 0, 0, 17), M(RO.SCOUT));
  add(BONE.TORSO, part(rbox(0.66, 0.16, 0.46, 0.07, hi ? 2 : 1), ghillie, 0, 0.5, -0.03, 0, 0, 0, 19), M(RO.SCOUT));
  add(BONE.TORSO, part(rbox(0.5, 0.2, 0.06, 0.03, 1), ghillie, 0, 0.36, -0.22, 0.25, 0, 0, 23), M(RO.SCOUT));
  add(BONE.TORSO, part(rbox(0.14, 0.07, 0.08, 0.02, 1), 0x1d1f21, 0, 0.36, 0.22), M(RO.SCOUT));
  if (hi) for (const x of [-0.035, 0.035]) add(BONE.TORSO, part(cyl(0.025, 0.025, 0.06, 7), 0x111214, x, 0.36, 0.27, Math.PI / 2, 0, 0), M(RO.SCOUT));

  // --- 7 Shock trooper: ballistic mandible guard and dark visor; neck / groin plates; knee and elbow pads.
  add(BONE.HEAD, part(rbox(0.22, 0.09, 0.08, 0.03, 1), 0x1c1e20, 0, hy - 0.07, 0.12), M(RO.SHOCK));
  add(BONE.HEAD, part(rbox(0.23, 0.07, 0.04, 0.02, 1), 0x0d0e10, 0, hy + 0.03, 0.16), M(RO.SHOCK));
  add(BONE.TORSO, part(cyl(0.15, 0.17, 0.1, seg), 0x1f2224, 0, 0.53, 0.01), M(RO.SHOCK));
  add(BONE.PELVIS, part(rbox(0.18, 0.16, 0.04, 0.02, 1), 0x1f2224, 0, -0.08, 0.16), M(RO.SHOCK, RO.BREACHER));
  for (const sb of [BONE.SHIN_L, BONE.SHIN_R]) add(sb, part(rbox(0.13, 0.12, 0.08, 0.03, 1), 0x202224, 0, 0.0, 0.08), M(RO.SHOCK, RO.BREACHER));
  if (hi) for (const fb of [BONE.FARM_L, BONE.FARM_R]) add(fb, part(rbox(0.1, 0.08, 0.1, 0.03, 1), 0x202224, 0, 0.01, -0.06), M(RO.SHOCK));

  // --- 8 Breacher: heavy CQB helmet with a thick armoured visor and ear protection; forearm and shin guards;
  //     flashbangs; a battering ram slung diagonally across the back.
  add(BONE.HEAD, part(rbox(0.26, 0.15, 0.04, 0.02, 1), 0x34383b, 0, hy + 0.02, 0.18), M(RO.BREACHER));
  for (const x of [-0.19, 0.19]) add(BONE.HEAD, part(cyl(0.065, 0.065, 0.07, seg), 0x2b2d2f, x, hy, 0, 0, 0, Math.PI / 2), M(RO.BREACHER));
  for (const fb of [BONE.FARM_L, BONE.FARM_R]) add(fb, part(rbox(0.11, 0.2, 0.11, 0.03, 1), 0x2a2d30, 0, -0.12, 0), M(RO.BREACHER));
  for (const sb of [BONE.SHIN_L, BONE.SHIN_R]) add(sb, part(rbox(0.11, 0.24, 0.06, 0.02, 1), 0x2a2d30, 0, -0.16, 0.07), M(RO.BREACHER));
  if (hi) for (const x of [-0.13, -0.05]) add(BONE.TORSO, part(cyl(0.03, 0.03, 0.1, 7), 0x3b3f2c, x, 0.2, 0.22), M(RO.BREACHER));
  add(BONE.TORSO, part(cyl(0.055, 0.055, 0.78, 8), 0x3a3d40, 0, 0.3, -0.26, 0, 0, 0.8), M(RO.BREACHER));
  if (hi) add(BONE.TORSO, part(cyl(0.07, 0.07, 0.12, 8), 0x1e2022, 0.27, 0.53, -0.26, 0, 0, 0.8), M(RO.BREACHER));

  // --- 9 Marksman: low-profile cap; sniper veil over one shoulder; scoped long barrel with bipod (rifle bones).
  add(BONE.HEAD, part(dome(0.175, R + 2, 2, 1, 0.55, 1.05), c.camo, 0, hy + 0.06, -0.005), M(RO.MARKSMAN));
  add(BONE.HEAD, part(bx(0.17, 0.015, 0.11), c.camo, 0, hy + 0.07, 0.19), M(RO.MARKSMAN));
  add(BONE.TORSO, part(rbox(0.22, 0.42, 0.06, 0.03, 1), [0x55603a, 0x3e472b, 0x6d7350], 0.17, 0.32, -0.12, 0.1, 0, -0.2, 29), M(RO.MARKSMAN));
  // --- Rifle-bone silhouettes: marksman scope / long barrel / bipod; engineer LMG drum and bipod; SF suppressor,
  //     optic and laser. (Weapon local axes: +z muzzle, +y up.)
  for (const [wb, mb] of [[BONE.RIFLE_A, BONE.MAG_A], [BONE.RIFLE_B, BONE.MAG_B]]) {
    add(wb, part(cyl(0.024, 0.024, 0.22, 8), 0x141517, 0, 0.11, 0.05, Math.PI / 2, 0, 0), M(RO.MARKSMAN));
    add(wb, part(cyl(0.012, 0.012, 0.42, 6), 0x141517, 0, 0.04, 0.62, Math.PI / 2, 0, 0), M(RO.MARKSMAN));
    for (const x of [-0.03, 0.03]) add(wb, part(cyl(0.006, 0.006, 0.22, 4), 0x141517, x, -0.06, 0.48, 0, 0, x * 8), M(RO.MARKSMAN, RO.ENGINEER));
    add(mb, part(cyl(0.07, 0.07, 0.07, 10), 0x1f2123, 0, -0.06, 0, 0, 0, Math.PI / 2), M(RO.ENGINEER));
    add(wb, part(cyl(0.022, 0.022, 0.2, 8), 0x101112, 0, 0.04, 0.52, Math.PI / 2, 0, 0), M(RO.SF, SKIN_SF_B));
    add(wb, part(rbox(0.04, 0.05, 0.09, 0.012, 1), 0x101112, 0, 0.1, 0.05), M(RO.SF, SKIN_SF_B));
    if (hi) add(wb, part(bx(0.02, 0.025, 0.06), 0x2b2e1f, 0.035, 0.05, 0.25), M(RO.SF, SKIN_SF_B));
  }

  // --- 10 Special forces: high-cut helmet with dual-tube NVG mount and headset; low-profile plate carrier;
  //     team shoulder patch (gold for the first team, crimson for the second).
  add(BONE.HEAD, part(dome(0.186, R + 2, hi ? 4 : 2, 1.0, 0.85, 1.02), 0x2b2f33, 0, hy + 0.05, -0.01), M(RO.SF, SKIN_SF_B));
  add(BONE.HEAD, part(bx(0.06, 0.05, 0.04), 0x141516, 0, hy + 0.16, 0.17), M(RO.SF, SKIN_SF_B));
  for (const x of [-0.035, 0.035]) add(BONE.HEAD, part(cyl(0.022, 0.022, 0.09, 7), 0x0f1011, x, hy + 0.2, 0.17, -0.6, 0, 0), M(RO.SF, SKIN_SF_B));
  for (const x of [-0.18, 0.18]) add(BONE.HEAD, part(cyl(0.055, 0.055, 0.05, seg), 0x1c1e20, x, hy - 0.01, 0, 0, 0, Math.PI / 2), M(RO.SF, SKIN_SF_B));
  add(BONE.TORSO, part(rbox(0.48, 0.3, 0.34, 0.05, 1), 0x24272b, 0, 0.29, 0), M(RO.SF, SKIN_SF_B));
  add(BONE.UARM_L, part(bx(0.024, 0.08, 0.08), 0xd4a017, 0.08, -0.06, 0), M(RO.SF));
  add(BONE.UARM_L, part(bx(0.024, 0.08, 0.08), 0x8b1e3f, 0.08, -0.06, 0), M(SKIN_SF_B));
  add(BONE.TORSO, part(rbox(0.26, 0.24, 0.1, 0.04, 1), 0x22252a, 0, 0.32, -0.21), M(RO.SF, SKIN_SF_B));

  // --- 11 Mortar team: helmet with ballistic goggles; the gunner carries the folded tube and bipod across his
  //     back, the ammunition bearer a twin-canister shell rack.
  add(BONE.HEAD, part(rbox(0.21, 0.055, 0.05, 0.02, 1), 0x1d1f21, 0, hy + 0.11, 0.165), M(RO.MORTAR, SKIN_MORTAR_B));
  add(BONE.TORSO, part(cyl(0.055, 0.06, 0.8, 9), 0x3e4a2b, 0, 0.32, -0.25, 0, 0, -0.7), M(RO.MORTAR));
  add(BONE.TORSO, part(cyl(0.11, 0.11, 0.025, 10), 0x2c3320, 0.26, 0.04, -0.25, 0, 0, -0.7), M(RO.MORTAR));
  if (hi) for (const x of [-0.06, 0.06]) add(BONE.TORSO, part(cyl(0.01, 0.01, 0.5, 4), 0x2a2c2e, x, 0.28, -0.32, 0, 0, 0.5), M(RO.MORTAR));
  for (const x of [-0.1, 0.1]) add(BONE.TORSO, part(cyl(0.085, 0.085, 0.5, 9), 0x4f5a34, x, 0.3, -0.29), M(SKIN_MORTAR_B));
  add(BONE.TORSO, part(bx(0.36, 0.05, 0.2), 0x2b2c26, 0, 0.08, -0.29), M(SKIN_MORTAR_B));
  add(BONE.TORSO, part(bx(0.36, 0.04, 0.2), 0x2b2c26, 0, 0.5, -0.29), M(SKIN_MORTAR_B));
}

/**
 * Merges every bone's parts into one indexed geometry with an `aBone` attribute.
 * @param {THREE.BufferGeometry[][]} bones
 */
export function mergeSkinned(bones) {
  let vCount = 0, iCount = 0;
  for (const list of bones) for (const g of list) { vCount += g.attributes.position.count; iCount += g.index.count; }
  const pos = new Float32Array(vCount * 3), nrm = new Float32Array(vCount * 3), col = new Float32Array(vCount * 3), bone = new Float32Array(vCount), roles = new Float32Array(vCount);
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
      roles.fill(g.userData.roles ?? ALL_SKINS, vo, vo + n);
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
  out.setAttribute('aRoles', new THREE.BufferAttribute(roles, 1));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
