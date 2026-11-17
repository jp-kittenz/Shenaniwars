import * as THREE from 'three';
import { clamp, angleDelta } from '../core/math.js';

const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _aim = new THREE.Vector3();

/**
 * Weapon-mount operator: slews the agent's mount onto its target and fires
 * in bursts once the barrel has converged. Used by gunners, tank commanders
 * and helicopter pilots (whose fixed rocket pods get a small convergence assist).
 * @param {import('../entities/ai-agent.js').AIAgent} a
 * @param {import('../entities/vehicle.js').Vehicle} v
 */
export function operateMount(a, v, dt) {
  const seat = a.s.seat, mounts = v.def.mounts;
  let idx = -1;
  for (let i = 0; i < mounts.length; i++) if (mounts[i].seat === seat) { idx = i; break; }
  if (idx < 0) return;
  const m = mounts[idx], weapon = v.weapons[idx], def = weapon.def;
  const t = a.target;
  if (!t || !a.targetVisible || !t.alive) {
    v.aimYaw[seat] = v.yaw; v.aimPitch[seat] = 0;
    return;
  }
  if (t.kind === 'vehicle' ? def.vsVehicle[t.def.type] <= 0 : false) return;
  v.getMuzzle(idx, _pos, _dir);
  a.aimPoint(_aim);
  let dx = _aim.x - _pos.x, dy = _aim.y - _pos.y, dz = _aim.z - _pos.z;
  const flat = Math.hypot(dx, dz), dist = Math.hypot(flat, dy);
  if (def.type === 'projectile') {
    const tof = dist / /** @type {number} */ (def.speed);
    dy += 0.5 * /** @type {number} */ (def.gravity) * tof * tof;
  }
  v.aimYaw[seat] = Math.atan2(dx, dz);
  v.aimPitch[seat] = Math.atan2(dy, flat);
  if (dist > def.range || a.game.time < a.acquireTime) return;

  let ready;
  if (m.turnRate === 0) {
    // Fixed pods: fire when the airframe points roughly at the target, converging the salvo onto it.
    const inv = 1 / Math.hypot(dx, dy, dz);
    _aim.set(dx * inv, dy * inv, dz * inv);
    ready = _aim.dot(_dir) > 0.86 && dist > 45;
    if (ready) _dir.copy(_aim);
  } else ready = v.aimError(idx) < 0.045 && Math.abs(v.mountPitch[idx] - clamp(v.aimPitch[seat], m.pitchMin, m.pitchMax)) < 0.05;
  if (!ready) return;
  if (a.burstPause > 0) { a.burstPause -= dt; return; }
  if (a.game.combat.fire(a.s, weapon, _pos, _dir, 2.2) && def.auto && --a.burstLeft <= 0) {
    a.burstPause = 0.5 + Math.random() * 0.8;
    a.burstLeft = 5 + ((Math.random() * 6) | 0);
  }
}

/**
 * Waypoint-following driver for wheeled and tracked vehicles with stuck
 * recovery (reverse-and-turn) and a pivot-first rule for skid-steer hulls.
 * @param {import('../entities/ai-agent.js').AIAgent} a
 * @param {import('../entities/vehicle.js').Vehicle} v
 */
export function driveGround(a, v, dt) {
  const c = v.controls, nav = a.nav, g = a.game;
  c.brake = false;
  if (a.holdVehicle) { c.throttle = 0; c.steer = 0; c.brake = true; return; }
  a.repath -= dt;
  const goalMoved = Math.hypot(nav.tx - a.driveX, nav.tz - a.driveZ) > 10 || !nav.vehicle;
  if ((goalMoved || (nav.done && !nav.pending)) && a.repath <= 0) {
    g.nav.request(nav, v.pos.x, v.pos.z, a.driveX, a.driveZ, true);
    a.repath = 2.5;
  }
  if (nav.done) { c.throttle = 0; c.steer = 0; c.brake = true; return; }
  let wx = nav.path[nav.idx * 2], wz = nav.path[nav.idx * 2 + 1];
  let d = Math.hypot(wx - v.pos.x, wz - v.pos.z);
  const last = nav.idx === nav.len - 1;
  if (d < (last ? 10 : 8)) {
    nav.idx++;
    if (nav.done) return;
    wx = nav.path[nav.idx * 2]; wz = nav.path[nav.idx * 2 + 1];
    d = Math.hypot(wx - v.pos.x, wz - v.pos.z);
  }
  const err = angleDelta(v.yaw, Math.atan2(wx - v.pos.x, wz - v.pos.z));
  const skid = v.def.maxSteer === 0;
  if (a.reverseTimer > 0) {
    a.reverseTimer -= dt;
    c.throttle = -0.9;
    c.steer = skid ? 0 : -Math.sign(err || 1) * 0.9;
    return;
  }
  c.steer = clamp(err * 1.9, -1, 1);
  if (skid) c.throttle = Math.abs(err) > 0.7 ? 0.12 : clamp(1.1 - Math.abs(err), 0.3, 1);
  else {
    // Ease off for corners and for the final approach.
    const corner = Math.abs(err) > 0.5 && v.speed > 9;
    c.throttle = corner ? 0 : clamp(1.05 - Math.abs(err) * 0.6, 0.35, 1);
    if (last && d < 30 && v.speed > 8) c.throttle = 0;
  }
  if (Math.abs(v.speed) < 0.7) {
    a.stuck += dt;
    if (a.stuck > 2.4) { a.stuck = 0; a.reverseTimer = 1.7; a.stuckTotal++; nav.len = 0; }
  } else a.stuck = Math.max(0, a.stuck - dt * 2);
}

/**
 * Helicopter autopilot: terrain-following altitude hold, velocity-vector
 * guidance toward the objective, an orbit pattern on station, attack runs on
 * visible targets and an emergency descent when critically damaged.
 * @param {import('../entities/ai-agent.js').AIAgent} a
 * @param {import('../entities/vehicle.js').Vehicle} v
 */
export function flyHeli(a, v, dt) {
  const c = v.controls, p = v.pos, terrain = a.game.map.terrain;
  const lv = v.body.linvel();
  const ground = Math.max(terrain.height(p.x, p.z), 0);
  const agl = p.y - ground - v.def.half[1];
  const heading = v.yaw;
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const speed = Math.hypot(lv.x, lv.z);

  if (a.heliLand) {
    c.collective = agl > 8 ? -0.75 : -0.3;
    c.pitch = clamp(-(lv.x * fx + lv.z * fz) * 0.12, -1, 1);
    c.roll = clamp(-(lv.x * -fz + lv.z * fx) * 0.12, -1, 1);
    c.yaw = 0;
    if (agl < 1.2) a.wantExit = true;
    return;
  }
  const ahead = Math.max(terrain.height(p.x + lv.x * 3, p.z + lv.z * 3), terrain.height(p.x + lv.x * 1.5, p.z + lv.z * 1.5));
  c.collective = clamp((Math.max(ground, ahead) + 42 - p.y) * 0.22, -1, 1);

  const dx = a.driveX - p.x, dz = a.driveZ - p.z;
  const dist = Math.hypot(dx, dz) || 1;
  let vx, vz;
  if (dist > 90) {
    const s = Math.min(34, dist * 0.3);
    vx = (dx / dist) * s; vz = (dz / dist) * s;
  } else {
    // Orbit the objective at ~60 m.
    const k = (dist - 60) * 0.25;
    vx = (-dz / dist) * 13 + (dx / dist) * k; vz = (dx / dist) * 13 + (dz / dist) * k;
  }
  let desiredYaw = speed > 5 ? Math.atan2(lv.x, lv.z) : heading;
  const t = a.target;
  if (t && a.targetVisible && t.alive) {
    const tx = t.pos.x - p.x, tz = t.pos.z - p.z, td = Math.hypot(tx, tz);
    if (td < 320) {
      desiredYaw = Math.atan2(tx, tz);
      // Attack run: close while far, slide sideways when near so the nose stays on target.
      const s = td > 150 ? 16 : 5;
      vx = (tx / td) * s + (-tz / td) * 6; vz = (tz / td) * s + (tx / td) * 6;
    }
  }
  const ex = vx - lv.x, ez = vz - lv.z;
  c.pitch = clamp((ex * fx + ez * fz) * 0.11, -1, 1);
  c.roll = clamp((ex * -fz + ez * fx) * 0.11, -1, 1);
  c.yaw = clamp(angleDelta(heading, desiredYaw) * 1.8, -1, 1);
}
