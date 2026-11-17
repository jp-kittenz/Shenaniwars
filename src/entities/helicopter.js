import * as THREE from 'three';
import { clamp, damp } from '../core/math.js';

const _qT = new THREE.Quaternion();
const _qC = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _up = new THREE.Vector3();
const _imp = { x: 0, y: 0, z: 0 };

const MAX_TILT = 0.5;      // rad at full stick
const CLIMB_RATE = 10;     // m/s at full collective
const CEILING = 150;

/**
 * Assisted 6-DOF flight model tuned for two thumbs.
 *
 * The sticks command *attitude* (pitch/roll angle) and *rates* (yaw rate,
 * climb rate) rather than raw torques; an attitude servo drives the rigid
 * body's angular velocity toward the commanded orientation and the rotor
 * thrust is solved along the body-up axis, so tilting the disc converts lift
 * into horizontal acceleration exactly like a real helicopter while remaining
 * hover-stable when the sticks are released.
 *
 * @param {import('./vehicle.js').Vehicle} v
 * @param {number} dt
 */
export function stepHelicopter(v, dt) {
  const body = v.body, c = v.controls, def = v.def;
  const piloted = v.alive && v.seats[0] !== null;
  v.rotorSpeed = damp(v.rotorSpeed, piloted ? 1 : 0, piloted ? 1.2 : 0.5, dt);
  if (v.rotorSpeed < 0.02) return;
  if (body.isSleeping()) body.wakeUp();

  const t = body.translation(), q = body.rotation(), lv = body.linvel(), av = body.angvel();
  _qC.set(q.x, q.y, q.z, q.w);
  _up.set(0, 1, 0).applyQuaternion(_qC);
  const mass = v.mass;
  const agl = t.y - def.ride - Math.max(v.terrain.height(t.x, t.z), 0);
  const airborne = agl > 0.6;

  // --- Attitude servo -----------------------------------------------------
  if (piloted) {
    v.heading += c.yaw * def.turnRate * dt;
    const authority = airborne ? 1 : 0;
    _e.set(c.pitch * MAX_TILT * authority, v.heading, c.roll * MAX_TILT * authority);
    _qT.setFromEuler(_e);
    // q_err = q_target * conj(q_current): rotation still to be performed, in world space.
    _qC.conjugate();
    _qT.multiply(_qC);
    if (_qT.w < 0) { _qT.x = -_qT.x; _qT.y = -_qT.y; _qT.z = -_qT.z; _qT.w = -_qT.w; }
    const s = Math.hypot(_qT.x, _qT.y, _qT.z);
    let wx = 0, wy = 0, wz = 0;
    if (s > 1e-5) {
      const k = Math.min((2 * Math.atan2(s, _qT.w)) * 5.5, 3.5) / s;
      wx = _qT.x * k; wy = _qT.y * k; wz = _qT.z * k;
    }
    const blend = 1 - Math.exp(-12 * dt);
    _imp.x = av.x + (wx - av.x) * blend; _imp.y = av.y + (wy - av.y) * blend; _imp.z = av.z + (wz - av.z) * blend;
    body.setAngvel(_imp, true);
  }

  // --- Rotor thrust (solved for commanded climb rate) -----------------------
  let climb = c.collective * CLIMB_RATE;
  if (t.y > CEILING) climb = Math.min(climb, (CEILING - t.y) * 0.5);
  if (!piloted) climb = -CLIMB_RATE;
  const accel = (9.81 + clamp((climb - lv.y) * 3, -8.5, 9)) / Math.max(0.55, _up.y);
  const j = mass * accel * dt * v.rotorSpeed;
  _imp.x = _up.x * j; _imp.y = _up.y * j; _imp.z = _up.z * j;
  body.applyImpulse(_imp, true);

  // --- Parasitic drag (sets top speed) ------------------------------------------
  const drag = mass * 0.13 * dt;
  _imp.x = -lv.x * drag; _imp.y = 0; _imp.z = -lv.z * drag;
  body.applyImpulse(_imp, true);
}
