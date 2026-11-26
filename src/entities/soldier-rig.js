import * as THREE from 'three';
import { angleDelta, clamp, smoothstep } from '../core/math.js';
import { WEAPON_MODELS } from './models/weapon-models.js';

/** Bone slots of the soldier skeleton (body parts, carried kit, accessories). */
export const BONE = {
  PELVIS: 0, TORSO: 1, HEAD: 2, UARM_L: 3, FARM_L: 4, UARM_R: 5, FARM_R: 6,
  THIGH_L: 7, SHIN_L: 8, THIGH_R: 9, SHIN_R: 10,
  RIFLE_A: 11, MAG_A: 12, RIFLE_B: 13, MAG_B: 14, LAUNCHER: 15, ROCKET: 16, PACK: 17, CHUTE: 18,
};
export const BONE_COUNT = 19;

/** Skeleton dimensions (metres). */
export const RIG = {
  hipY: 0.86, waist: 0.12, neck: 0.5, shoulderX: 0.25, shoulderY: 0.4,
  upperArm: 0.3, foreArm: 0.31, hipX: 0.11, hipDrop: 0.05, thigh: 0.4, shin: 0.39,
  aimY: 1.41, seatHip: 0.14,
};

// Scratch objects (the rig never allocates per frame).
const _m = Array.from({ length: 12 }, () => new THREE.Matrix4());
const [_root, _pelvis, _torso, _head, _aim, _w, _t1, _t2, _limb, _mag, _frame, _yawRoot] = _m;
/** Crouch: pelvis drop and leg fold. Prone: body pitched forward about the feet. */
const CROUCH_DROP = 0.28, PRONE_PITCH = 1.45;
const _v = Array.from({ length: 16 }, () => new THREE.Vector3());
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const KEY = Array.from({ length: 12 }, () => new THREE.Vector3());

const tr = (m, x, y, z) => m.multiply(_t1.makeTranslation(x, y, z));
const rx = (m, a) => (a ? m.multiply(_t1.makeRotationX(a)) : m);
const ry = (m, a) => (a ? m.multiply(_t1.makeRotationY(a)) : m);
const rz = (m, a) => (a ? m.multiply(_t1.makeRotationZ(a)) : m);
const at = (m, p, out) => out.set(p[0], p[1], p[2]).applyMatrix4(m);

/**
 * Two-bone IK. Places the elbow on the side of `pole`.
 * @returns {THREE.Vector3} the (possibly clamped) hand position in `hand`
 */
export function ik(shoulder, target, a, b, pole, elbow, hand) {
  const d = _v[14].subVectors(target, shoulder);
  let len = d.length();
  if (len < 1e-5) { d.set(0, -1, 0); len = 1e-5; }
  d.multiplyScalar(1 / len);
  len = clamp(len, Math.abs(a - b) + 0.02, a + b - 0.002);
  hand.copy(shoulder).addScaledVector(d, len);
  const cosA = clamp((a * a + len * len - b * b) / (2 * a * len), -1, 1);
  const n = _v[15].subVectors(pole, shoulder);
  n.addScaledVector(d, -n.dot(d));
  if (n.lengthSq() < 1e-8) n.set(0, -1, 0).addScaledVector(d, -d.y);
  n.normalize();
  elbow.copy(shoulder).addScaledVector(d, a * cosA).addScaledVector(n, a * Math.sqrt(1 - cosA * cosA));
  return hand;
}

/** Bone matrix for a limb hanging from joint `p` to joint `q` (geometry runs along -Y). */
export function limbMatrix(p, q, fwdHint, out) {
  _y.subVectors(p, q);
  if (_y.lengthSq() < 1e-10) _y.set(0, 1, 0);
  _y.normalize();
  _x.crossVectors(_y, fwdHint);
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  _x.normalize();
  _z.crossVectors(_x, _y);
  out.makeBasis(_x, _y, _z).setPosition(p);
  return out;
}

/** Smoothstep keyframe track over points. @param {number[]} times */
function track(times, pts, n, t, out) {
  if (t <= times[0]) return out.copy(pts[0]);
  for (let i = 0; i < n - 1; i++) {
    if (t <= times[i + 1]) return out.lerpVectors(pts[i], pts[i + 1], smoothstep(times[i], times[i + 1], t));
  }
  return out.copy(pts[n - 1]);
}

/**
 * @typedef {Object} HoldParams
 * @property {number} reloadT   0..1 progress, or -1 when not reloading
 * @property {boolean} empty    reload from an empty magazine (racks the bolt)
 * @property {boolean} loaded   launcher has a rocket seated
 * @property {number} sprint    0..1 port-arms carry
 * @property {number} low       0..1 relaxed low-ready carry
 * @property {number} kick      0..1 recoil
 * @property {number} ads       0..1 aim down sights (first person only)
 * @property {boolean} fp       first-person frame
 */

/**
 * Weapon placement and hand/magazine targets in the aim frame (third person)
 * or view frame (first person). Writes the weapon matrix to `outW`, the
 * magazine matrix to `outMag` (returns its state) and hand targets.
 * @param {import('./models/weapon-models.js').WeaponModel} model
 * @param {HoldParams} p
 * @returns {'attached'|'hand'|'hidden'} magazine / rocket state
 */
export function holdWeapon(model, p, outW, outMag, rightHand, leftHand) {
  const launcher = model.kind === 'launcher';
  const hold = p.fp ? model.holdFP : model.hold;
  let px = hold[0], py = hold[1], pz = hold[2], yaw = 0, pitch = 0, roll = 0;
  if (p.fp && p.ads > 0) {
    px += (-model.sight[0] - px) * p.ads; py += (-model.sight[1] - py) * p.ads; pz += (0.22 - pz) * p.ads;
  }
  // Carries.
  if (p.low > 0) { pitch -= 0.5 * p.low; yaw += 0.3 * p.low; px += 0.04 * p.low; py -= 0.06 * p.low; pz -= 0.06 * p.low; }
  if (p.sprint > 0) { pitch += 0.55 * p.sprint; yaw += 0.95 * p.sprint; px += 0.14 * p.sprint; py -= 0.08 * p.sprint; pz -= 0.14 * p.sprint; }
  pz -= 0.035 * p.kick; pitch += 0.07 * p.kick;
  const r = p.reloadT;
  if (r >= 0 && !launcher) {
    const c = smoothstep(0, 0.14, r) * (1 - smoothstep(0.84, 0.97, r));
    roll += 0.55 * c; pitch += 0.22 * c; px += 0.03 * c; py -= 0.05 * c; pz -= 0.06 * c;
    if (p.fp) { py += 0.03 * c; px -= 0.05 * c; }
  } else if (r >= 0) {
    const l = smoothstep(0, 0.15, r) * (1 - smoothstep(0.85, 1, r));
    pitch -= 0.42 * l; px += 0.04 * l; py -= 0.14 * l; pz -= 0.1 * l;
  }
  outW.makeTranslation(px, py, pz);
  _q.setFromEuler(_e.set(-pitch, yaw, roll, 'YXZ'));
  outW.multiply(_t2.makeRotationFromQuaternion(_q));

  at(outW, model.grip, rightHand);
  const S = at(outW, model.support, KEY[0]);
  const wellX = model.magWell[0], wellY = model.magWell[1], wellZ = model.magWell[2];
  const g = model.magGrab;
  let state = 'attached';
  if (r < 0) {
    leftHand.copy(S);
    if (launcher && !p.loaded) state = 'hidden';
  } else if (!launcher) {
    const G = at(outW, [wellX + g[0], wellY + g[1], wellZ + g[2]], KEY[1]);
    const Go = at(outW, [wellX + g[0], wellY + g[1] - 0.12, wellZ + g[2] + 0.04], KEY[2]);
    const P = p.fp ? KEY[3].set(0.16, -0.5, 0.12) : KEY[3].set(0.06, -0.25, 0.22);
    const In = at(outW, [wellX + g[0], wellY + g[1] - 0.08, wellZ + g[2] + 0.06], KEY[4]);
    const C0 = at(outW, [model.charge[0], model.charge[1] + 0.05, model.charge[2] + 0.02], KEY[5]);
    const C = at(outW, model.charge, KEY[6]);
    const Cb = at(outW, [model.charge[0], model.charge[1], model.charge[2] - 0.09], KEY[7]);
    if (p.empty) track([0, 0.14, 0.2, 0.3, 0.38, 0.46, 0.6, 0.68, 0.74, 0.78, 0.83, 0.95], [S, G, G, Go, P, P, In, G, C0, C, Cb, S], 12, r, leftHand);
    else track([0, 0.14, 0.2, 0.3, 0.38, 0.46, 0.6, 0.68, 0.86], [S, G, G, Go, P, P, In, G, S], 9, r, leftHand);
    state = r < 0.2 || r >= 0.68 ? 'attached' : r < 0.36 || r >= 0.42 ? 'hand' : 'hidden';
  } else {
    const B = p.fp ? KEY[1].set(0.12, 0.2, -0.25) : KEY[1].set(0.06, 0.14, -0.3);
    const A = at(outW, [wellX + g[0], wellY + g[1], wellZ + g[2] + 0.32], KEY[2]);
    const I = at(outW, [wellX + g[0], wellY + g[1], wellZ + g[2]], KEY[3]);
    track([0, 0.12, 0.26, 0.46, 0.66, 0.74, 0.9], [S, B, B, A, I, I, S], 7, r, leftHand);
    state = r < 0.24 ? 'hidden' : r < 0.7 ? 'hand' : 'attached';
  }
  if (state === 'attached') outMag.copy(outW).multiply(_t2.makeTranslation(wellX, wellY, wellZ));
  else if (state === 'hand') {
    outMag.copy(outW).setPosition(0, 0, 0).premultiply(_t2.makeTranslation(leftHand.x, leftHand.y, leftHand.z));
    outMag.multiply(_t2.makeTranslation(-g[0], -g[1], -g[2]));
  }
  return state;
}

const ZERO16 = new Float32Array(16);
const _hold = /** @type {HoldParams} */ ({ reloadT: -1, empty: false, loaded: true, sprint: 0, low: 0, kick: 0, ads: 0, fp: false });

/**
 * Maps a faction's weapon ids to their bone slots.
 * @param {{rifles: string[], launcher: string}} faction
 */
export function weaponBones(faction, id) {
  if (id === faction.launcher) return [BONE.LAUNCHER, BONE.ROCKET];
  if (faction.rifles[1] && id === faction.rifles[1] && faction.rifles[1] !== faction.rifles[0]) return [BONE.RIFLE_B, BONE.MAG_B];
  return [BONE.RIFLE_A, BONE.MAG_A];
}

/**
 * Poses a soldier: writes BONE_COUNT world matrices into `out` at `off`.
 * @param {import('./soldier.js').Soldier} s
 * @param {{rifles: string[], launcher: string}} faction
 * @param {Float32Array} out
 * @param {number} off
 * @param {Float32Array} [joints] optional 15×3 joint positions (for ragdolls)
 */
export function poseSoldier(s, faction, time, out, off, joints) {
  const V = _v;
  for (let b = 0; b < BONE_COUNT; b++) out.set(ZERO16, off + b * 16);
  const write = (b, m) => m.toArray(out, off + b * 16);
  const veh = s.vehicle;
  // (walking up a ramp / through a troop door to his seat: on his feet, not yet seated)
  const seated = veh !== null && !s.ragdollPose && !(s.transT > 0 && s.transPath && s.transWait <= 0);
  // Exterior rider on a hull: body follows the hull and faces the seat's way, head and rifle follow the look.
  const seatDef = seated ? veh.def.seats[s.seat] : null;
  const rider = seatDef !== null && seatDef.role === 'rider';
  const rPose = rider ? seatDef.pose | 0 : 0;
  const chute = s.parachute && !s.grounded && !seated;
  const rope = s.rappel && !s.grounded && !seated && !chute;
  const pitch = clamp(s.pitch, -1.2, 1.2);
  const ws = s.weapon, model = WEAPON_MODELS[ws.id];
  const launcherInHands = model.kind === 'launcher';
  const stance = seated || chute || !s.grounded ? 0 : s.stance | 0;
  const crouch = stance === 1, prone = stance === 2;
  const amp = seated || chute ? 0 : Math.min(1, s.speed / 5) * (prone ? 0.5 : 1);
  const sprint = !seated && !stance && s.sprinting && s.speed > 5.4 && !ws.reloading ? 1 : 0;
  const phase = s.walkPhase;

  let look = 0, rideBob = 0, rideSway = 0;
  // Seated inside (driver, pilot, passenger on a bench): the body is fixed to the vehicle — tilting with it, facing
  // the seat's way (forward, or across the compartment on troop benches); the head turns to look. Open gunners
  // (static guns, door guns) still turn with their weapon.
  const fixedSeat = seated && !rider && seatDef !== null && seatDef.role !== 'gunner' && !veh.def.static;
  if (fixedSeat) {
    _yawRoot.makeRotationFromQuaternion(veh.quat).setPosition(s.pos.x, s.pos.y, s.pos.z);
    ry(_yawRoot, seatDef.face || 0);
    look = clamp(angleDelta(veh.yaw + (seatDef.face || 0), s.yaw), -1.1, 1.1);
    const sp = Math.min(1, Math.abs(veh.speed || 0) / 8);
    rideBob = Math.sin(time * 8.1 + s.id * 1.3) * 0.008 * sp;
  } else if (rider) {
    _yawRoot.makeRotationFromQuaternion(veh.quat).setPosition(s.pos.x, s.pos.y, s.pos.z);
    ry(_yawRoot, seatDef.face || 0);
    // Looking around: head and shoulders turn toward the look direction (limited), the body stays put.
    look = clamp(angleDelta(veh.yaw + (seatDef.face || 0), s.yaw), -1.3, 1.3);
    // Riding motion: small jolts with speed, a slow sway.
    const sp = Math.min(1, Math.abs(veh.speed || 0) / 6);
    rideBob = Math.sin(time * 9.3 + s.id * 1.7) * 0.012 * sp + Math.sin(time * 2.1 + s.id) * 0.004;
    rideSway = Math.sin(time * 1.3 + s.id * 0.7) * (0.02 + 0.03 * sp);
  } else _yawRoot.makeRotationY(s.yaw).setPosition(s.pos.x, s.pos.y, s.pos.z);
  _root.copy(_yawRoot);
  if (prone) { tr(_root, 0, 0.2, -0.86); rx(_root, PRONE_PITCH); }
  // --- Hips & spine ----------------------------------------------------------------
  const bob = seated || prone ? 0 : -Math.abs(Math.sin(phase)) * 0.045 * amp;
  const sway = rider ? rideSway : Math.sin(phase) * 0.06 * amp + Math.sin(time * 1.7 + s.id) * 0.01;
  const lean = prone ? -0.25 : rider ? (rPose === 2 ? 0.15 : 0.08) : amp * 0.1 + sprint * 0.2 + (crouch ? 0.3 : 0);
  const twist = rider ? look : fixedSeat ? 0 : seated || chute ? 0 : (launcherInHands ? -0.25 : -0.5) * (1 - sprint) * (prone ? 0.3 : 1);
  const hipH = rider && rPose === 2 ? 0.5 : RIG.seatHip;
  _pelvis.copy(_root);
  tr(_pelvis, 0, seated ? hipH + rideBob : RIG.hipY + bob - (crouch ? CROUCH_DROP : 0), 0);
  // Riders stay seated (hips and legs fixed to the deck); the shoulders and head turn to look.
  rz(_pelvis, sway); ry(_pelvis, rider ? 0 : twist * 0.35);
  _torso.copy(_pelvis);
  tr(_torso, 0, RIG.waist, 0);
  ry(_torso, rider ? look * 0.55 : twist * 0.65); rx(_torso, lean - pitch * (prone ? 0.05 : 0.12)); rz(_torso, -sway * 0.5);
  _head.copy(_torso);
  tr(_head, 0, RIG.neck, 0);
  ry(_head, rider ? look * 0.45 : fixedSeat ? look * 0.8 : -twist); rx(_head, -pitch * 0.55 - (lean - pitch * 0.12) * 0.8 - (prone ? PRONE_PITCH - 0.3 : 0));
  write(BONE.PELVIS, _pelvis); write(BONE.TORSO, _torso); write(BONE.HEAD, _head);

  // --- Weapon ------------------------------------------------------------------------
  _aim.copy(_yawRoot);
  if (prone) tr(_aim, 0, 0.32, 0.55);
  else tr(_aim, 0, seated ? hipH + rideBob + RIG.waist + RIG.shoulderY : RIG.aimY + bob - (crouch ? CROUCH_DROP + 0.05 : 0), 0);
  if (rider) ry(_aim, look);
  rx(_aim, -pitch);
  const rightHand = V[0], leftHand = V[1];
  const [wb, mb] = weaponBones(faction, ws.id);
  // Riders keep their rifle in their hands (low ready unless they are shooting).
  const handsOnWeapon = (!seated || rider) && !chute && !rope;
  if (handsOnWeapon) {
    _hold.reloadT = ws.reloading ? ws.reloadProgress : -1;
    _hold.empty = ws.reloadEmpty;
    _hold.loaded = ws.ammo > 0;
    _hold.sprint = sprint;
    _hold.low = rider ? (s.muzzleFlash > 0 || (s.isPlayer && s.alert && s.pitch !== 0) ? 0 : 1) : s.alert || s.isPlayer ? 0 : 1;
    _hold.kick = s.muzzleFlash > 0 ? 1 : 0;
    _hold.fp = false;
    _hold.ads = 0;
    const st = holdWeapon(model, _hold, _w, _mag, rightHand, leftHand);
    rightHand.applyMatrix4(_aim); leftHand.applyMatrix4(_aim);
    _w.premultiply(_aim); _mag.premultiply(_aim);
    write(wb, _w);
    if (st !== 'hidden') write(mb, _mag);
  }
  // Slung weapons: anything carried but not in hand rides on the back.
  for (const other of s.weapons) {
    if (handsOnWeapon && other === ws) continue;
    const otherModel = WEAPON_MODELS[other.id];
    const [ob, omb] = weaponBones(faction, other.id);
    _t2.copy(_torso);
    // Launchers hang muzzle-down diagonally across the back; rifles ride muzzle-up the other way.
    if (otherModel.kind === 'launcher') { tr(_t2, 0.02, 0.22, -0.28); rz(_t2, -1.05); rx(_t2, 1.85); }
    else { tr(_t2, -0.04, 0.22, -0.25); rx(_t2, -1.3); rz(_t2, 0.5); }
    write(ob, _t2);
    if (otherModel.kind !== 'launcher' || other.ammo > 0) {
      _mag.copy(_t2).multiply(_t1.makeTranslation(otherModel.magWell[0], otherModel.magWell[1], otherModel.magWell[2]));
      write(omb, _mag);
    }
  }
  if (s.launcher) { _t2.copy(_torso); tr(_t2, 0, 0.3, -0.31); write(BONE.PACK, _t2); }
  if (chute) { _t2.copy(_root); tr(_t2, 0, 1.25, 0); ry(_t2, Math.sin(time * 0.7) * 0.1); write(BONE.CHUTE, _t2); }

  // --- Arms ----------------------------------------------------------------------------
  _x.setFromMatrixColumn(_torso, 0); _y.setFromMatrixColumn(_torso, 1); _z.setFromMatrixColumn(_torso, 2);
  const fwd = V[2].copy(_z);
  const shL = V[3].set(RIG.shoulderX, RIG.shoulderY, 0).applyMatrix4(_torso);
  const shR = V[4].set(-RIG.shoulderX, RIG.shoulderY, 0).applyMatrix4(_torso);
  if (!handsOnWeapon) {
    _frame.copy(_root);
    if (chute) { leftHand.set(0.22, 1.9, 0.05).applyMatrix4(_frame); rightHand.set(-0.22, 1.9, 0.05).applyMatrix4(_frame); }
    else if (rope) { leftHand.set(0.05, 1.95, 0.16).applyMatrix4(_frame); rightHand.set(-0.03, 1.62, 0.16).applyMatrix4(_frame); }
    else {
      const role = veh ? veh.def.seats[s.seat].role : '';
      const gunner = role === 'gunner' || role === 'commander';
      tr(_frame, 0, RIG.seatHip + RIG.waist + RIG.shoulderY, 0);
      if (gunner) rx(_frame, -pitch);
      const c = veh ? veh.controls : null;
      if (veh && s.seat === 0 && veh.def.kind === 'ground' && !veh.def.static && veh.def.maxSteer > 0) {
        // Hands on the steering wheel rim, turning with it.
        const spin = -(veh.steerAngle || 0) * 5;
        for (const [hand, side] of [[leftHand, 1], [rightHand, -1]]) {
          const th = side * 1.2 + spin;
          hand.set(Math.sin(th) * 0.19, -0.14 + Math.cos(th) * 0.16, 0.36 - Math.cos(th) * 0.09).applyMatrix4(_frame);
        }
      } else if (veh && s.seat === 0 && veh.def.kind === 'ground' && !veh.def.static) {
        // Tiller bars: the lever on the side of the turn is pulled back.
        for (const [hand, side] of [[leftHand, 1], [rightHand, -1]]) {
          const pull = Math.max(0, side * (c.steer || 0)) * 0.45;
          hand.set(side * 0.2, -0.26, 0.32 - pull * 0.35).applyMatrix4(_frame);
        }
      } else if (veh && s.seat === 0 && veh.def.kind !== 'ground') {
        // Pilot: right hand on the cyclic / stick, left on the collective / throttle.
        const heli = veh.def.kind === 'heli';
        rightHand.set(-(c.roll || 0) * 0.08, heli ? -0.2 : -0.26, (heli ? 0.3 : 0.32) + (c.pitch || 0) * 0.06).applyMatrix4(_frame);
        leftHand.set(heli ? 0.3 : 0.28, heli ? -0.48 + (c.collective || 0) * 0.08 : -0.37, heli ? 0.32 : 0.07 + (c.throttle || 0) * 0.06).applyMatrix4(_frame);
      } else {
        leftHand.set(0.16, gunner ? -0.02 : -0.24, gunner ? 0.42 : 0.4).applyMatrix4(_frame);
        rightHand.set(-0.16, gunner ? -0.02 : -0.24, gunner ? 0.42 : 0.4).applyMatrix4(_frame);
      }
    }
  }
  const down = V[5].set(0, -1, 0);
  for (const [sh, hand, ub, fb, side] of [[shL, leftHand, BONE.UARM_L, BONE.FARM_L, 1], [shR, rightHand, BONE.UARM_R, BONE.FARM_R, -1]]) {
    const pole = V[6].copy(sh).addScaledVector(down, 0.7).addScaledVector(_x, side * 0.45).addScaledVector(fwd, -0.15);
    const elbow = V[7], h = V[8];
    ik(sh, hand, RIG.upperArm, RIG.foreArm, pole, elbow, h);
    write(ub, limbMatrix(sh, elbow, fwd, _limb));
    write(fb, limbMatrix(elbow, h, fwd, _limb));
    if (joints) {
      const o = side > 0 ? 3 : 6;
      joints.set([sh.x, sh.y, sh.z, elbow.x, elbow.y, elbow.z, h.x, h.y, h.z], o * 3);
    }
  }

  // --- Legs ------------------------------------------------------------------------------
  // Gait in the direction of travel: forward/back swing and side steps for strafing.
  let lx = 0, lz = 1;
  if (s.speed > 0.3) {
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    lx = s.moveX * c - s.moveZ * sn; lz = s.moveX * sn + s.moveZ * c;
    const l = Math.hypot(lx, lz) || 1; lx /= l; lz /= l;
  }
  const swingAmp = 0.55 * amp + 0.25 * sprint;
  for (const [tb, sb, side, ph] of [[BONE.THIGH_L, BONE.SHIN_L, 1, 0], [BONE.THIGH_R, BONE.SHIN_R, -1, Math.PI]]) {
    _t2.copy(_pelvis);
    tr(_t2, side * RIG.hipX, -RIG.hipDrop, 0);
    let knee;
    if (rider && rPose === 1) {
      // Knees drawn up, feet flat on the deck.
      rx(_t2, -2.15); rz(_t2, side * 0.28); knee = 2.35;
    } else if (rider && rPose === 2) {
      // Kneeling: one knee down on the deck, the other foot planted forward.
      if (side > 0) { rx(_t2, -1.45); rz(_t2, 0.1); knee = 1.5; } else { rx(_t2, -0.15); rz(_t2, -0.08); knee = 1.55; }
    } else if (rider) {
      // Legs over the hull edge, swinging a little with the ride.
      rx(_t2, -1.45); rz(_t2, side * 0.14);
      knee = 1.3 + Math.sin(time * 1.1 + s.id + side) * 0.08 + rideBob * 4;
    } else if (seated) { rx(_t2, -1.45); rz(_t2, side * 0.12); knee = 1.45; }
    else if (chute) { rx(_t2, -0.25 + Math.sin(time * 1.3 + ph) * 0.15); knee = 0.4; }
    else if (!s.grounded) { rx(_t2, -0.55); knee = 0.95; }
    else if (crouch) {
      const sw = Math.sin(phase + ph) * 0.35 * amp;
      rx(_t2, -1.0 - sw); rz(_t2, side * 0.08);
      knee = 1.7 + sw * 0.5;
    } else if (prone) {
      // Low crawl: knees draw up alternately.
      const sw = Math.max(0, Math.sin(phase + ph)) * amp;
      rx(_t2, 0.05 - sw * 0.5); rz(_t2, side * (0.12 + sw * 0.25));
      knee = 0.15 + sw * 0.9;
    } else {
      const sw = Math.sin(phase + ph) * swingAmp;
      // Forward swing is a negative rotation about X; sideways about Z.
      _q.setFromEuler(_e.set(-sw * lz, 0, sw * lx * 0.8, 'XYZ'));
      _t2.multiply(_t1.makeRotationFromQuaternion(_q));
      rz(_t2, side * 0.04);
      knee = 0.08 + Math.max(0, Math.sin(phase + ph + 1.3)) * (0.9 * amp + 0.5 * sprint);
    }
    write(tb, _t2);
    if (joints) { _t1.copy(_t2); }
    const hip = V[9].setFromMatrixPosition(_t2);
    tr(_t2, 0, -RIG.thigh, 0);
    rx(_t2, knee);
    write(sb, _t2);
    if (joints) {
      const kneeP = V[10].setFromMatrixPosition(_t2);
      const foot = V[11].set(0, -RIG.shin, 0.05).applyMatrix4(_t2);
      joints.set([hip.x, hip.y, hip.z, kneeP.x, kneeP.y, kneeP.z, foot.x, foot.y, foot.z], (side > 0 ? 9 : 12) * 3);
    }
  }
  if (joints) {
    const pel = V[12].setFromMatrixPosition(_pelvis), neck = V[13].setFromMatrixPosition(_head);
    const headC = V[14].set(0, 0.15, 0).applyMatrix4(_head);
    joints.set([pel.x, pel.y, pel.z, neck.x, neck.y, neck.z, headC.x, headC.y, headC.z], 0);
  }
}
