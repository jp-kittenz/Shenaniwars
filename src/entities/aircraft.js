import * as THREE from 'three';
import { clamp } from '../core/math.js';

const _q = new THREE.Quaternion();
const _f = new THREE.Vector3();
const _u = new THREE.Vector3();
const _l = new THREE.Vector3();
const _w = new THREE.Vector3();
const _imp = { x: 0, y: 0, z: 0 };
const _av = { x: 0, y: 0, z: 0 };

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
  const lift = 9.81 * Math.min(ratio * ratio, 1.6);
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
    } else {
      _av.x = av.x + (_w.x - av.x) * blend; _av.y = av.y + (_w.y - av.y) * blend; _av.z = av.z + (_w.z - av.z) * blend;
      body.setAngvel(_av, true);
    }
  }
}
