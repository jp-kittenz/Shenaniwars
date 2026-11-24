/**
 * VehicleCrewBlackboard: what the commander, gunner, driver and passengers of one vehicle agree on, so the
 * driver and the gunner work together instead of independently.
 *
 *   HOLD_STABLE        the gunner is laying a precision shot (tank gun, ATGM): the driver eases to a halt for
 *                      1.5–2.5 s, the shot goes, the vehicle moves on at once
 *   ANGLE_FRONT        holding in contact with AT / armour: the hull's front (thickest armour) faces that threat
 *   HULL_DOWN_REVERSE  armour that has just fired backs off a few metres while the gun reloads, then returns
 *   SMOKE_AND_EXTRACT  hit hard by AT: smoke, then reverse out of the killzone along the way it came
 *
 * One small object per vehicle, created on first use; no allocation afterwards.
 */
export const CrewState = { NONE: 0, HOLD_STABLE: 1, ANGLE_FRONT: 2, HULL_DOWN_REVERSE: 3, SMOKE_AND_EXTRACT: 4 };
export const CREW_STATE_NAMES = ['none', 'hold-stable', 'angle-front', 'hull-down-reverse', 'smoke-and-extract'];

/** @param {any} v */
export function crewBB(v) {
  return v.crewBB || (v.crewBB = { state: 0, until: 0, since: 0, threatX: 0, threatZ: 0, extractX: 0, extractZ: 0, firedAt: -1e3, holds: 0, reverses: 0 });
}

/** Is this weapon one the gunner wants a steady platform for? */
export function precisionWeapon(def) {
  return (def.type === 'projectile' && !def.auto && !def.artillery && !def.drop && (def.radius || 0) > 0) || (!!def.homing && def.homing !== 'air');
}

export function setCrewState(bb, state, time, seconds) {
  bb.state = state; bb.since = time; bb.until = time + seconds;
}

/** Active state (expired states read as NONE). */
export function crewState(v, time) {
  const bb = v.crewBB;
  if (!bb || bb.state === 0) return 0;
  if (time >= bb.until) { bb.state = 0; return 0; }
  return bb.state;
}
