import * as THREE from 'three';
import { clamp, angleDelta, smoothstep } from '../core/math.js';
import { ballisticPitch } from '../entities/weapons.js';

const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _f = new THREE.Vector3();
const _u = new THREE.Vector3();
const _l = new THREE.Vector3();
const _D = new THREE.Vector3();

const isAir = (t) => t && t.kind === 'vehicle' && t.def.kind !== 'ground';

/** Damage a mount's weapon would do to a target (0 = useless). */
function effectiveness(def, t) {
  if (!t) return 0;
  if (t.kind === 'vehicle') {
    if (def.homing === 'air') return isAir(t) ? def.damage * def.vsVehicle[t.def.armor] * 1.5 : 0;
    return def.damage * def.vsVehicle[t.def.armor] * (def.artillery ? 0.3 : 1);
  }
  if (def.homing === 'air' || def.artillery) return 0;
  // Against infantry: favour rapid fire and splash over single heavy rounds.
  const rate = def.rpm / 60;
  return (def.type === 'hitscan' ? def.damage * Math.min(rate, 12) : def.radius ? 60 : 0) * (def.splash ? 1.5 : 1);
}

/**
 * Chooses the best weapon a seat can bring to bear on the agent's target and
 * selects it on the vehicle. Returns the mount index (or -1).
 */
export function pickMount(v, seat, target, wantArtillery) {
  const list = v.def.seatMounts[seat];
  if (!list || !list.length) return -1;
  let best = -1, bestScore = 0;
  for (let k = 0; k < list.length; k++) {
    const i = list[k], w = v.weapons[i], def = w.def;
    if (w.ammo <= 0 && w.reserve <= 0) continue;
    let score = wantArtillery ? (def.artillery ? 1 : 0) : effectiveness(def, target);
    if (w.reloading) score *= 0.3;
    if (score > bestScore) { bestScore = score; best = k; }
  }
  if (best < 0) return v.seatMount(seat);
  v.seatWeapon[seat] = best;
  return list[best];
}

/**
 * Weapon-mount operator: chooses a weapon, slews onto the target with drop and
 * lead compensation (or a ballistic arc for artillery), locks air targets for
 * missiles and fires in bursts once the barrel has converged. Fixed weapons
 * (aircraft guns, pods, bombs) fire when the airframe points at the target.
 * @param {import('../entities/ai-agent.js').AIAgent} a
 * @param {import('../entities/vehicle.js').Vehicle} v
 */
export function operateMount(a, v, dt) {
  const seat = a.s.seat;
  const t = a.target;
  const visible = t !== null && a.targetVisible && t.alive;
  const arty = !visible && a.artyUntil > a.game.time;
  const idx = pickMount(v, seat, visible ? t : null, arty);
  if (idx < 0) return;
  const m = v.def.mounts[idx], weapon = v.weapons[idx], def = weapon.def;
  if (!visible && !arty) {
    if (m.turnRate > 0) { v.aimYaw[seat] = v.yaw; v.aimPitch[seat] = def.artillery ? 0.3 : 0; }
    return;
  }
  if (visible && effectiveness(def, t) <= 0) return;
  v.getMuzzle(idx, _pos, _dir);
  if (visible) a.aimPoint(_aim); else _aim.set(a.artyX, a.artyY, a.artyZ);
  let dx = _aim.x - _pos.x, dy = _aim.y - _pos.y, dz = _aim.z - _pos.z;
  let flat = Math.hypot(dx, dz), dist = Math.hypot(flat, dy);
  let pitch = Math.atan2(dy, flat);
  if (def.type === 'projectile' && !def.homing) {
    const speed = /** @type {number} */ (def.speed) || 1, g = def.gravity || 0;
    // Lead moving targets by the time of flight.
    if (visible && t.vel) { const tof = dist / speed; dx += t.vel.x * tof; dz += t.vel.z * tof; flat = Math.hypot(dx, dz); }
    else if (visible && t.moveX !== undefined) { const tof = dist / speed; dx += t.moveX * tof; dz += t.moveZ * tof; flat = Math.hypot(dx, dz); }
    if (def.artillery) {
      const p = ballisticPitch(flat, dy, speed, g, false);
      pitch = Number.isNaN(p) ? 0.78 : p;
    } else if (!def.drop) {
      const tof = dist / speed;
      pitch = Math.atan2(dy + 0.5 * g * tof * tof, flat);
    }
  }
  if (m.turnRate > 0) { v.aimYaw[seat] = Math.atan2(dx, dz); v.aimPitch[seat] = pitch; }
  if (dist > def.range || a.game.time < a.acquireTime) return;

  let ready;
  let lock = null;
  if (def.drop) {
    // Release bombs when the predicted impact point is close to the target.
    const h = Math.max(1, v.altitude), vy = v.vel.y, gr = def.gravity || 9.81;
    const tf = (vy + Math.sqrt(vy * vy + 2 * gr * h)) / gr;
    const ix = v.pos.x + v.vel.x * tf - _aim.x, iz = v.pos.z + v.vel.z * tf - _aim.z;
    ready = Math.hypot(ix, iz) < 22 && h > 40;
  } else if (m.turnRate === 0) {
    const inv = 1 / Math.max(1e-3, Math.hypot(dx, dy, dz));
    ready = (dx * _dir.x + dy * _dir.y + dz * _dir.z) * inv > (def.homing ? 0.8 : 0.975) && dist > 40;
  } else {
    const pe = Math.abs(v.mountPitch[idx] - clamp(pitch, m.pitchMin, m.pitchMax));
    ready = v.aimError(idx) < (def.artillery ? 0.03 : 0.05) && pe < (def.artillery ? 0.03 : 0.06);
  }
  if (def.homing === 'air') {
    lock = visible && isAir(t) && dist < (def.lockRange || def.range) ? t : null;
    ready = ready && lock !== null;
  }
  v.locks[idx] = lock;
  if (!ready) return;
  if (a.burstPause > 0) { a.burstPause -= dt; return; }
  const spread = isAir(t) ? 1.4 : def.artillery ? 3 : 2.2;
  if (a.game.combat.fire(a.s, weapon, _pos, _dir, spread, { vehicle: v, mount: idx, lock }) && def.auto && --a.burstLeft <= 0) {
    a.burstPause = (def.artillery ? 0.1 : 0.45) + Math.random() * 0.8;
    a.burstLeft = def.artillery ? 12 : 5 + ((Math.random() * 7) | 0);
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
    // Bots keep to a speed at which they can still dodge rocks and trees.
    if (v.speed > 16) c.throttle = 0;
  }
  // Stuck detection by progress, not speed: a hull grinding against an obstacle
  // can creep at walking pace forever without getting anywhere.
  a.stuck += dt;
  if (a.stuck > 3) {
    const moved = Math.hypot(v.pos.x - a.progressX, v.pos.z - a.progressZ);
    if (moved < 2.5 && c.throttle > 0.2) { a.reverseTimer = 1.7; a.stuckTotal++; nav.len = 0; }
    else if (moved > 15) a.stuckTotal = Math.max(0, a.stuckTotal - 0.5);
    a.stuck = 0; a.progressX = v.pos.x; a.progressZ = v.pos.z;
  }
}

/**
 * Helicopter autopilot: terrain-following altitude hold, velocity-vector
 * guidance toward the destination, an orbit on station, attack runs on
 * visible targets, and a controlled landing when `heliLand` is set.
 * @param {import('../entities/ai-agent.js').AIAgent} a
 * @param {import('../entities/vehicle.js').Vehicle} v
 */
export function flyHeli(a, v, dt) {
  const c = v.controls, p = v.pos, terrain = a.game.map.terrain;
  const lv = v.vel;
  const ground = Math.max(terrain.height(p.x, p.z), 0);
  const agl = v.altitude;
  const heading = v.yaw;
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const speed = Math.hypot(lv.x, lv.z);
  const dx = a.driveX - p.x, dz = a.driveZ - p.z;
  const dist = Math.hypot(dx, dz) || 1;

  if (a.heliLand) {
    // Slide over the landing point, then descend gently.
    let vx = 0, vz = 0;
    if (dist > 6 && agl > 3) { const s = Math.min(14, dist * 0.35); vx = (dx / dist) * s; vz = (dz / dist) * s; }
    c.collective = dist > 25 ? clamp((ground + 25 - p.y) * 0.2, -1, 1) : agl > 10 ? -0.7 : agl > 2.5 ? -0.35 : -0.2;
    const ex = vx - lv.x, ez = vz - lv.z;
    c.pitch = clamp((ex * fx + ez * fz) * 0.12, -1, 1);
    c.roll = clamp((ex * -fz + ez * fx) * 0.12, -1, 1);
    c.yaw = 0;
    a.landed = agl < 1.2 && speed < 2;
    return;
  }
  a.landed = false;
  const cruise = v.def.role === 'airlift' ? 32 : 42;
  const ahead = Math.max(terrain.height(p.x + lv.x * 3, p.z + lv.z * 3), terrain.height(p.x + lv.x * 1.5, p.z + lv.z * 1.5));
  c.collective = clamp((Math.max(ground, ahead, 0) + cruise + v.def.ride - p.y) * 0.22, -1, 1);

  let vx, vz;
  if (dist > 90 || a.heliTransit) {
    const s = Math.min(34, dist * 0.3);
    vx = (dx / dist) * s; vz = (dz / dist) * s;
  } else {
    // Orbit the objective at ~60 m.
    const k = (dist - 60) * 0.25;
    vx = (-dz / dist) * 13 + (dx / dist) * k; vz = (dx / dist) * 13 + (dz / dist) * k;
  }
  let desiredYaw = speed > 5 ? Math.atan2(lv.x, lv.z) : heading;
  const t = a.target;
  if (t && a.targetVisible && t.alive && v.def.role === 'heli') {
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

/**
 * Fixed-wing autopilot. On the runway: full power, hold the centreline and
 * rotate at take-off speed. In the air it steers toward a desired direction
 * with bank-to-turn (roll the target into the lift plane, then pull), keeps
 * clear of terrain and the edge of the map, and flies:
 *   - intercepts against aircraft (fighters),
 *   - dive attacks with a pull-out on ground targets (strike jets),
 *   - otherwise a racetrack orbit over the squad objective.
 * @param {import('../entities/ai-agent.js').AIAgent} a
 * @param {import('../entities/vehicle.js').Vehicle} v
 */
export function flyJet(a, v, dt) {
  const c = v.controls, p = v.pos, g = a.game, terrain = g.map.terrain, fl = v.def.flight;
  const time = g.time;
  const speed = v.airspeed;
  v.forward(_f);
  _u.set(0, 1, 0).applyQuaternion(v.quat);
  _l.set(1, 0, 0).applyQuaternion(v.quat);

  if (v.grounded > 0 && v.altitude < 1.5) {
    c.throttle = 1;
    c.roll = 0;
    const rw = g.map.runways.find((r) => r.team === v.spawn.team);
    const hdg = rw ? rw.yaw : v.spawn.yaw;
    c.yaw = clamp(angleDelta(v.yaw, hdg) * 2.5 + (rw ? clamp((rw.z - p.z) * 0.05, -0.3, 0.3) * -Math.sign(Math.sin(hdg)) : 0), -1, 1);
    c.pitch = speed > fl.stall * 1.08 ? -0.75 : 0;
    return;
  }
  const ground = Math.max(terrain.height(p.x, p.z), 0);
  const agl = p.y - ground;
  const half = terrain.half;
  let throttle = 1;

  // Desired flight direction.
  const t = a.target;
  const visible = t !== null && a.targetVisible && t.alive;
  const fighter = v.weapons.some((w) => w.def.homing === 'air');
  if (a.jetPullUntil > time) {
    _D.set(_f.x, 0, _f.z).normalize().multiplyScalar(0.8); _D.y = 0.75;
  } else if (visible && isAir(t)) {
    _D.copy(t.pos).addScaledVector(t.vel, Math.min(2.5, p.distanceTo(t.pos) / 200)).sub(p);
  } else if (visible && (!fighter || t.kind === 'vehicle' || t.kind === 'soldier')) {
    _D.set(t.pos.x - p.x, 0, t.pos.z - p.z);
    const flat = _D.length();
    if (flat > 700) { _D.normalize(); _D.y = clamp((ground + 140 - p.y) * 0.01, -0.3, 0.4); }
    else {
      // Dive onto the target; pull out low or close.
      _D.set(t.pos.x - p.x, t.pos.y + 1 - p.y, t.pos.z - p.z);
      throttle = 0.75;
      if (agl < 85 || flat < 140) a.jetPullUntil = time + 4.5;
    }
  } else {
    // Racetrack over the objective at ~150 m.
    const o = a.objective();
    const ox = o ? o.x : 0, oz = o ? o.z : 0;
    const dx = ox - p.x, dz = oz - p.z, d = Math.hypot(dx, dz) || 1;
    const k = (d - 260) * 0.004;
    _D.set(-dz / d + (dx / d) * k, 0, dx / d + (dz / d) * k).normalize();
    _D.y = clamp((ground + 150 - p.y) * 0.012, -0.35, 0.45);
  }
  // Terrain look-ahead and map edge.
  const ahead = Math.max(terrain.height(p.x + v.vel.x * 3, p.z + v.vel.z * 3), terrain.height(p.x + v.vel.x * 1.5, p.z + v.vel.z * 1.5), 0);
  if (p.y + Math.min(0, v.vel.y) * 3 < ahead + 55) { _D.set(_f.x, 0, _f.z).normalize(); _D.y = 1.1; a.jetPullUntil = Math.max(a.jetPullUntil, time + 1.5); }
  if (Math.max(Math.abs(p.x), Math.abs(p.z)) > half + 70) { _D.set(-p.x, 0, -p.z).normalize(); _D.y = 0.1; }
  if (agl > 330) _D.y = Math.min(_D.y, -0.25);
  _D.normalize();

  // Bank-to-turn: roll the target into the lift plane, then pull toward it.
  const lr = -_D.dot(_l), lu = _D.dot(_u), lf = _D.dot(_f);
  const bank = Math.atan2(_l.y, _u.y);
  const offAxis = smoothstep(0.995, 0.9, lf);
  const rollErr = offAxis * Math.atan2(lr, Math.max(lu, 0.05)) + (1 - offAxis) * -bank;
  c.roll = clamp(rollErr * 2.2, -1, 1);
  c.pitch = clamp(-Math.atan2(lu, Math.max(lf, 0.15)) * 2.4, -1, 1);
  c.yaw = lf > 0.9 ? clamp(-lr * 4, -1, 1) : 0;
  c.throttle = speed < fl.stall * 1.25 ? 1 : throttle;
}
