import * as THREE from 'three';

/**
 * Vertical-launch sequence for strategic missile launchers (TEL), modelled on footage of a real launch:
 *
 *  1. A fire order queues a missile; the crew halts the truck (it is immobilised while the erector is up) and the
 *     erector rises to vertical (a few seconds).
 *  2. Cold launch: the missile is thrown straight up out of the launcher by a gas charge, with a white puff.
 *  3. A moment later the booster ignites: a blinding flash that lights the area, a huge cloud rolling out around
 *     the launcher, and cover pieces / debris tumbling away.
 *  4. The missile climbs vertically on its booster, then pitches over toward the aimed impact point and flies on
 *     a lofted ballistic arc; after burnout the flame drops to a small orange glow.
 *  5. The second missile follows a few seconds later; once the salvo is away the erector holds, then lowers and
 *     the truck can drive again.
 *
 * The missile flight itself lives in CombatSystem (projectiles flagged `vls`).
 */

/** Seconds for the erector to go from stowed to vertical (and back). */
export const ERECT_TIME = 5.5;
/** Seconds between missiles of a salvo. */
const SALVO_GAP = 4;
/** Seconds the erector stays up after the last launch. */
const HOLD_AFTER = 3;

const _up = new THREE.Vector3(0, 1, 0), _p = new THREE.Vector3(), _d = new THREE.Vector3();

/**
 * @typedef {Object} TelState
 * @property {number} erect   0 stowed → 1 vertical
 * @property {{target: THREE.Vector3, shooter: any, round: number}[]} queue
 * @property {boolean[]} gone  rounds that have left the launcher
 * @property {number} next    game time the next launch may happen
 * @property {number} hold    seconds left before lowering
 * @property {number} mount
 */

/** @param {any} v vehicle @returns {TelState|null} */
export function telState(v) {
  if (v.tel !== undefined) return v.tel;
  const k = v.def.mounts.findIndex((m, i) => v.weapons[i] && v.weapons[i].def.vls);
  v.tel = k < 0 ? null : { erect: 0, queue: [], gone: [], next: 0, hold: 0, mount: k };
  return v.tel;
}

/** True while the launcher is up or about to go up: the truck may not drive. */
export function telLocked(v) {
  const t = v.tel;
  return !!t && (t.erect > 0.01 || t.queue.length > 0);
}

/**
 * Where a ballistic round from `o` along `dir` would come down (the aimed impact point).
 * @param {any} game @param {THREE.Vector3} o @param {THREE.Vector3} dir unit @param {number} speed @param {number} g
 */
export function impactPoint(game, o, dir, speed, g) {
  const T = game.map.terrain, water = 0;
  _p.copy(o); _d.copy(dir).multiplyScalar(speed);
  const out = new THREE.Vector3().copy(o);
  for (let t = 0; t < 90; t += 0.05) {
    _p.addScaledVector(_d, 0.05); _d.y -= g * 0.05;
    const h = Math.max(T.height(_p.x, _p.z), water);
    if (_d.y < 0 && _p.y <= h) { out.set(_p.x, h, _p.z); return out; }
    out.copy(_p);
  }
  return out;
}

/**
 * Queues a missile on the launcher (called by CombatSystem.fire instead of launching at once).
 * @param {any} v @param {THREE.Vector3} target @param {any} shooter
 */
export function telQueue(v, target, shooter) {
  const t = /** @type {TelState} */ (telState(v));
  const rounds = v.weapons[t.mount].def.mag;
  let round = 0;
  while (round < rounds && (t.gone[round] || t.queue.some((q) => q.round === round))) round++;
  if (round >= rounds) round = 0;
  t.queue.push({ target: target.clone(), shooter, round });
}

/**
 * Advances the launcher: erects, fires queued missiles, lowers. Called once per frame.
 * @param {any} v @param {number} dt @param {any} game
 */
export function telUpdate(v, dt, game) {
  const t = v.tel;
  if (!t) return;
  const w = v.weapons[t.mount];
  // Reloaded: fresh missiles on the rails.
  if (w.ammo >= w.def.mag && !t.queue.length) t.gone.length = 0;
  if (!v.alive) { t.queue.length = 0; return; }
  if (t.queue.length) {
    t.hold = HOLD_AFTER;
    // Erect only once the truck has stopped (the drive is locked meanwhile, so it brakes to a halt).
    if (Math.abs(v.speed) < 0.8) t.erect = Math.min(1, t.erect + dt / ERECT_TIME);
    if (t.erect >= 1 && game.time >= t.next) {
      const q = t.queue.shift();
      t.gone[q.round] = true;
      t.next = game.time + SALVO_GAP;
      game.combat.launchVertical(v, t.mount, q.round, q.target, q.shooter);
    }
  } else if (t.erect > 0) {
    if (t.hold > 0) t.hold -= dt;
    else t.erect = Math.max(0, t.erect - dt / ERECT_TIME);
  }
}

/** Eased erector angle (rad) for the current state. */
export function telPitch(v) {
  const e = v.tel ? v.tel.erect : 0;
  return (e * e * (3 - 2 * e)) * Math.PI / 2;
}

export { _up as UP };
