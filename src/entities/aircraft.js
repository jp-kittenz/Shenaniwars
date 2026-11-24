import * as THREE from 'three';
import { clamp } from '../core/math.js';

const _q = new THREE.Quaternion();
const _f = new THREE.Vector3();
const _u = new THREE.Vector3();
const _l = new THREE.Vector3();
const _w = new THREE.Vector3();
const _imp = { x: 0, y: 0, z: 0 };
const _av = { x: 0, y: 0, z: 0 };
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _qa = new THREE.Quaternion();

/**
 * Assisted flight (heavy transports): the sticks command a bank angle (roll) and a flight-path angle (pitch); the
 * turn rate follows from the bank (coordinated), lift always balances weight, speed comes from thrust, drag and
 * the climb. Stable at low speed where the free-lift model would climb or depart. Ground roll, rotation and
 * touchdown stay on the gear model.
 */
function stepAssisted(v, dt) {
  const body = v.body, c = v.controls, fl = v.def.flight, lv = body.linvel();
  let A = v._assist;
  if (!A || !A.on) {
    const sp = Math.hypot(lv.x, lv.y, lv.z) || 1;
    A = v._assist = { on: true, heading: v.yaw, path: Math.asin(clamp(lv.y / sp, -0.9, 0.9)), bank: 0, speed: sp };
  }
  const throttle = clamp(c.throttle, 0, 1);
  const bankT = clamp(c.roll, -1, 1) * (fl.maxBank || 0.6), pathT = clamp(-c.pitch, -1, 1) * 0.3;
  A.bank += clamp(bankT - A.bank, -0.5 * dt, 0.5 * dt);
  A.path += clamp(pathT - A.path, -0.22 * dt, 0.22 * dt);
  if (A.speed < fl.stall) A.path = Math.min(A.path, -0.15 * (1 - A.speed / fl.stall) - 0.02); // too slow: the nose drops
  A.heading += (9.81 * Math.tan(A.bank) / Math.max(A.speed, 15)) * dt;
  const k = fl.thrust / (v.def.maxSpeed * v.def.maxSpeed);
  A.speed = Math.max(0, A.speed + (fl.thrust * throttle - k * A.speed * A.speed - 9.81 * Math.sin(A.path)) * dt);
  _e.set(-A.path, A.heading, -A.bank);
  _qa.setFromEuler(_e);
  body.setRotation({ x: _qa.x, y: _qa.y, z: _qa.z, w: _qa.w }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  const cp = Math.cos(A.path);
  body.setLinvel({ x: Math.sin(A.heading) * cp * A.speed, y: Math.sin(A.path) * A.speed, z: Math.cos(A.heading) * cp * A.speed }, true);
  v.rotorSpeed = throttle;
}


/**
 * Arcade fixed-wing flight model tuned for touch controls.
 *
 * - Thrust along the nose; quadratic drag sized so full throttle settles at
 *   the airframe's top speed.
 * - Lift along the wing's up vector grows with (airspeed / stall speed)², so
 *   banking turns the aircraft and slowing below stall makes it sink.
 * - The flight path is pulled toward where the nose points (the effect of the
 *   wing and tail at speed), which is what makes rate-commanded sticks feel
 *   like flying rather than pushing a rock.
 * - Sticks command pitch / roll / yaw rates; authority fades at low speed and
 *   a stalled nose drops on its own.
 * On the ground the airframe rolls on its landing gear (the shared raycast
 * suspension) with nose-wheel steering and brakes.
 *
 * @param {import('./vehicle.js').Vehicle} v
 * @param {number} dt
 */
export function stepJet(v, dt) {
  const body = v.body, c = v.controls, def = v.def, fl = def.flight;
  const piloted = v.alive && v.seats[0] !== null;
  // Assisted flight once well airborne (and until it is back down near the ground on the way in).
  if (fl.assisted) {
    const A = v._assist;
    // (the wheel rays do not run while assisted: touchdown is detected from the height above the ground)
    if (piloted && v.grounded === 0 && (v.altitude > 4 || (A && A.on && v.altitude > 0.5))) { stepAssisted(v, dt); return; }
    if (A) A.on = false;
  }
  const throttle = piloted ? clamp(c.throttle, 0, 1) : 0;
  v.rotorSpeed = throttle;
  if (body.isSleeping()) {
    if (!piloted) return;
    body.wakeUp();
  }
  // Landing gear: steer with the rudder, brake with zero throttle.
  const braking = !piloted || c.brake || throttle < 0.04;
  v.stepWheels(dt, 0, piloted ? c.yaw : 0, braking);

  const q = body.rotation(), lv = body.linvel(), av = body.angvel();
  _q.set(q.x, q.y, q.z, q.w);
  _f.set(0, 0, 1).applyQuaternion(_q);
  _u.set(0, 1, 0).applyQuaternion(_q);
  _l.set(1, 0, 0).applyQuaternion(_q);
  const speed = Math.hypot(lv.x, lv.y, lv.z);
  const fs = lv.x * _f.x + lv.y * _f.y + lv.z * _f.z;
  const ratio = clamp(fs / fl.stall, 0, 1.7);
  const onGround = v.grounded > 0;
  const m = v.mass;

  // Thrust and drag.
  const thrust = fl.thrust * throttle;
  const k = fl.thrust / (def.maxSpeed * def.maxSpeed);
  let ix = _f.x * thrust - lv.x * speed * k, iy = _f.y * thrust - lv.y * speed * k, iz = _f.z * thrust - lv.z * speed * k;
  // Lift along the wing's up vector.
  // (an assisted transport rolling on its gear at low power makes no lift: it stays down after touchdown)
  const lift = fl.assisted && onGround && throttle < 0.5 ? 0 : 9.81 * Math.min(ratio * ratio, 1.6);
  ix += _u.x * lift; iy += _u.y * lift; iz += _u.z * lift;
  _imp.x = ix * m * dt; _imp.y = iy * m * dt; _imp.z = iz * m * dt;
  body.applyImpulse(_imp, true);

  // Flight-path alignment: bleed off velocity that is not along the nose.
  if (speed > 4 && !onGround) {
    const px = lv.x - _f.x * fs, py = lv.y - _f.y * fs, pz = lv.z - _f.z * fs;
    const frac = 1 - Math.exp(-2.4 * Math.min(ratio, 1) * dt);
    _imp.x = -px * frac * m; _imp.y = -py * frac * m; _imp.z = -pz * frac * m;
    body.applyImpulse(_imp, true);
  }

  // Rate-commanded attitude. Right axis = -left; positive rotation about it raises the nose.
  if (piloted || !onGround) {
    const auth = onGround ? (ratio > 0.82 ? 0.6 : 0) : clamp(0.3 + ratio * 0.7, 0.3, 1);
    const pitchRate = (piloted ? -c.pitch * fl.pitchRate : 0) * auth;
    const rollRate = onGround ? 0 : (piloted ? c.roll * fl.rollRate : 0) * auth;
    const yawRate = onGround ? 0 : (piloted ? c.yaw * fl.yawRate : 0) * auth;
    // A stalled wing lets the nose fall.
    const stallDrop = !onGround && ratio < 0.7 ? (0.7 - ratio) * 1.1 : 0;
    _w.set(0, 0, 0)
      .addScaledVector(_l, -(pitchRate - stallDrop))
      .addScaledVector(_u, yawRate)
      .addScaledVector(_f, rollRate);
    const blend = 1 - Math.exp(-(onGround ? 4 : 6) * dt);
    if (onGround) {
      // Rolling on the gear: only the rotation (pitch) is commanded; the nose wheel steers.
      if (auth > 0) {
        const wl = -(pitchRate - stallDrop);
        const pc = av.x * _l.x + av.y * _l.y + av.z * _l.z;
        const d = (wl - pc) * blend;
        _av.x = av.x + _l.x * d; _av.y = av.y + _l.y * d; _av.z = av.z + _l.z * d;
        body.setAngvel(_av, true);
      }
      // Taxiing slowly: differential braking and power pivot the aircraft on its gear (turning round on a strip).
      if (piloted && throttle > 0.04 && Math.abs(fs) < 4 && Math.abs(c.yaw) > 0.3) {
        const cur = body.angvel();
        _av.x = cur.x; _av.y = cur.y + (c.yaw * 0.45 - cur.y) * blend; _av.z = cur.z;
        body.setAngvel(_av, true);
      }
    } else {
      _av.x = av.x + (_w.x - av.x) * blend; _av.y = av.y + (_w.y - av.y) * blend; _av.z = av.z + (_w.z - av.z) * blend;
      body.setAngvel(_av, true);
    }
  }
}
