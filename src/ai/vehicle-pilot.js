import { aaTrack } from './aa-aim.js';
import { CrewState, crewBB, crewState, precisionWeapon, setCrewState } from './vehicle-crew.js';
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
/** Dynamic-obstacle key offset of jam marks (see src/ai/vehicle-park.ts). */
const JAM_KEY = 100000;

/** Airborne aircraft (air-to-air / SAM seekers do not lock onto parked airframes). */
const isAir = (t) => t && t.kind === 'vehicle' && t.def.kind !== 'ground' && t.altitude > 3;

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
  const list = v.mountList(seat);
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

/** Most destructive direct-fire explosive mount of a seat (cannon, rockets, ATGM, bombs); -1 if none. */
function pickSiegeMount(v, seat) {
  const list = v.mountList(seat);
  if (!list) return -1;
  let best = -1, bd = 0;
  for (let k = 0; k < list.length; k++) {
    const i = list[k], w = v.weapons[i], def = w.def;
    if ((w.ammo <= 0 && w.reserve <= 0) || def.artillery || def.homing === 'air' || !def.radius) continue;
    if (def.damage > bd) { bd = def.damage; best = k; }
  }
  if (best < 0) return -1;
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
  // Endgame siege: direct fire with explosives on an exposed enemy HQ while nothing else is in sight.
  const siege = !visible && !arty && a.siegeUntil > a.game.time;
  const idx = siege ? pickSiegeMount(v, seat) : pickMount(v, seat, visible ? t : null, arty);
  if (idx < 0) return;
  const m = v.def.mounts[idx], weapon = v.weapons[idx], def = weapon.def;
  if (siege && (def.artillery || def.homing === 'air')) return;
  if (!visible && !arty && !siege) {
    if (m.turnRate > 0) {
      if (def.artillery) { v.aimYaw[seat] = v.yaw; v.aimPitch[seat] = 0.3; }
      else searchAim(a, v, seat, idx, dt);
    }
    return;
  }
  if (visible && effectiveness(def, t) <= 0) return;
  v.getMuzzle(idx, _pos, _dir);
  if (visible) a.aimPoint(_aim); else if (siege) _aim.set(a.siegeX, a.siegeY, a.siegeZ); else _aim.set(a.artyX, a.artyY, a.artyZ);
  let dx = _aim.x - _pos.x, dy = _aim.y - _pos.y, dz = _aim.z - _pos.z;
  // Against aircraft: lagged lead estimate and walk-on dispersion; the mount's traverse rate is the slew limit.
  let aaMul = 1;
  if (visible && isAir(t) && !def.homing) {
    aaMul = aaTrack(a, t, dt, a.game.time);
    const tof = Math.hypot(dx, dy, dz) / (def.type === 'projectile' ? /** @type {number} */ (def.speed) || 400 : 900);
    dx += a.aaVX * tof; dy += a.aaVY * tof; dz += a.aaVZ * tof;
  }
  let flat = Math.hypot(dx, dz), dist = Math.hypot(flat, dy);
  let pitch = Math.atan2(dy, flat);
  if (def.type === 'projectile' && !def.homing) {
    const speed = /** @type {number} */ (def.speed) || 1, g = def.gravity || 0;
    // Lead moving targets by the time of flight.
    if (visible && t.vel && !isAir(t)) { const tof = dist / speed; dx += t.vel.x * tof; dz += t.vel.z * tof; flat = Math.hypot(dx, dz); }
    else if (visible && t.moveX !== undefined) { const tof = dist / speed; dx += t.moveX * tof; dz += t.moveZ * tof; flat = Math.hypot(dx, dz); }
    if (def.artillery) {
      let p = ballisticPitch(flat, dy, speed, g, false);
      // Below the launcher's minimum elevation: lob it (high arc) if that is within its maximum.
      if (!Number.isNaN(p) && p < m.pitchMin) { const hp = ballisticPitch(flat, dy, speed, g, true); if (!Number.isNaN(hp) && hp <= m.pitchMax) p = hp; }
      pitch = Number.isNaN(p) ? 0.78 : p;
    } else if (!def.drop) {
      const tof = dist / speed;
      pitch = Math.atan2(dy + 0.5 * g * tof * tof, flat);
    }
  }
  if (m.turnRate > 0) {
    v.aimYaw[seat] = Math.atan2(dx, dz); v.aimPitch[seat] = pitch;
    // Remember where the gun was laid, so a lost target is searched for from here (no snap back).
    a.scanYaw = v.aimYaw[seat]; a.scanPitch = pitch; a.scanVel = 0;
  }
  if (dist > def.range || a.game.time < a.acquireTime) return;
  // Crew blackboard: a precision shot from a moving ground vehicle asks the driver for a steady platform.
  const precise = visible && v.def.kind === 'ground' && !v.def.static && precisionWeapon(def);
  if (precise) {
    const time = a.game.time, st = crewState(v, time);
    if (Math.abs(v.speed) > 1.2 && v.aimError(idx) < 0.25 && st !== CrewState.SMOKE_AND_EXTRACT && st !== CrewState.HOLD_STABLE &&
      st !== CrewState.HULL_DOWN_REVERSE && time - crewBB(v).firedAt > 3) {
      const bb = crewBB(v); setCrewState(bb, CrewState.HOLD_STABLE, time, 1.5 + ((a.s.id * 0.37) % 1)); bb.holds++;
    }
    // Wait for the halt (at most the hold's length) before taking the shot.
    if (crewState(v, time) === CrewState.HOLD_STABLE && Math.abs(v.speed) > 2) return;
  }

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
    // Lock-on: within lock range and, for fixed (boresight) launchers, inside a 30° seeker cone.
    let inCone = true;
    if (m.turnRate === 0) { const inv = 1 / Math.max(1e-3, Math.hypot(dx, dy, dz)); inCone = (dx * _dir.x + dy * _dir.y + dz * _dir.z) * inv > 0.866; }
    lock = visible && isAir(t) && dist < (def.lockRange || def.range) && inCone ? t : null;
    ready = ready && lock !== null;
  }
  v.locks[idx] = lock;
  if (!ready) return;
  if (a.burstPause > 0) { a.burstPause -= dt; return; }
  // Fire-mission dispersion shrinks as spotters walk the rounds in.
  const spread = isAir(t) ? 1.4 * aaMul : def.artillery ? 3 * (a.artySpread > 0 ? clamp(a.artySpread / 18, 0.4, 1.4) : 1) : 2.2;
  const shot = a.game.combat.fire(a.s, weapon, _pos, _dir, spread, { vehicle: v, mount: idx, lock });
  if (shot && precise) {
    // Shot away: the halt ends; armour backs off behind its cover while the gun reloads.
    const bb = crewBB(v), time = a.game.time;
    bb.firedAt = time;
    const armoured = v.def.armor === 'heavy' || v.def.armor === 'medium';
    // Gun cycle: a magazine reload, or (single-shot tank guns) the time between rounds.
    const cycle = Math.max(def.reload || 0, def.rpm ? 60 / def.rpm : 0);
    if (armoured && cycle >= 2.5) { setCrewState(bb, CrewState.HULL_DOWN_REVERSE, time, Math.min(cycle * 0.5, 3.2)); bb.reverses++; }
    else bb.state = CrewState.NONE;
  }
  if (shot && def.auto && --a.burstLeft <= 0) {
    const r = (a.s.id * 0.618 + a.game.time * 1.7) % 1;
    a.burstPause = (def.artillery ? 0.1 : 0.45) + r * 0.8;
    a.burstLeft = def.artillery ? 12 : 5 + ((r * 7) | 0);
  }
}

/** Small deterministic hash of two numbers into [0, 1). */
function hash2(a, b) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be59b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const FEELERS = 11;
const FEELER_STEP = 0.26;
const _fc = new Float32Array(FEELERS);

/**
 * Obstacle avoidance for ground vehicles. Casts feelers in ±70° around the
 * desired heading from the front of the hull, each measuring clear distance
 * against blocked terrain / props (vehicle nav layer), other vehicles (with a
 * keep-right bias for oncoming traffic) and friendly infantry. The heading
 * with the best mix of clearance and alignment wins (with hysteresis); when
 * every feeler is short the driver backs out toward the clearer side.
 * Writes a.avoidYaw, a.clearAhead, a.boxedIn, a.escapeSide.
 */
function avoid(a, v, want) {
  const g = a.game, nav = g.nav, def = v.def;
  const speed = Math.abs(v.speed);
  const look = 8 + speed * 1.7;
  const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
  const ox = v.pos.x + fx * def.half[2] * 0.8, oz = v.pos.z + fz * def.half[2] * 0.8;
  const width = def.half[0] + 0.8;
  const vehicles = g.vehicles.list, soldiers = g.soldiers;
  let oncoming = false;
  let best = 0, bestScore = -1e9, bestClear = look;
  for (let k = 0; k < FEELERS; k++) {
    const off = (k - (FEELERS - 1) / 2) * FEELER_STEP;
    const yaw = want + off;
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    let clear = look;
    for (let d = 2; d < clear; d += 2) if (nav.blocked(ox + dx * d, oz + dz * d, true)) { clear = d - 1; break; }
    for (let i = 0; i < vehicles.length; i++) {
      const o = vehicles[i];
      if (o === v || (!o.alive && o.wreckTimer <= 0)) continue;
      const px = o.pos.x - ox, pz = o.pos.z - oz;
      const along = px * dx + pz * dz;
      if (along <= 0 || along > clear + o.def.half[2]) continue;
      const lat = Math.abs(px * dz - pz * dx);
      const r = width + o.def.half[0] + 0.6;
      if (lat < r) {
        clear = Math.max(0, along - o.def.half[2]);
        // Moving toward us: traffic, pass on the right.
        if (o.speed > 1 && (Math.sin(o.yaw) * fx + Math.cos(o.yaw) * fz) < -0.3) oncoming = true;
      }
    }
    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (!s.alive || s.vehicle || s.team !== v.team) continue;
      const px = s.pos.x - ox, pz = s.pos.z - oz;
      if (px * px + pz * pz > (clear + 2) * (clear + 2)) continue;
      const along = px * dx + pz * dz;
      if (along <= 0 || along > clear) continue;
      if (Math.abs(px * dz - pz * dx) < width + 0.6) clear = Math.max(0, along - 1);
    }
    _fc[k] = clear;
  }
  for (let k = 0; k < FEELERS; k++) {
    const off = (k - (FEELERS - 1) / 2) * FEELER_STEP;
    let s = (_fc[k] / look) * 1.1 + Math.cos(off) * 0.9 - Math.abs(off) * 0.05;
    if (oncoming && off < 0) s += 0.15;                  // keep right (turning right lowers yaw)
    if (Math.abs(angleDelta(a.avoidYaw, want + off)) < 0.2) s += 0.06;   // hysteresis: no twitching
    if (s > bestScore) { bestScore = s; best = k; bestClear = _fc[k]; }
  }
  a.avoidYaw = want + (best - (FEELERS - 1) / 2) * FEELER_STEP;
  a.clearAhead = bestClear;
  // Boxed in: every heading blocked within a few metres → reverse toward the clearer side.
  let left = 0, right = 0, maxC = 0;
  for (let k = 0; k < FEELERS; k++) { maxC = Math.max(maxC, _fc[k]); if (k > (FEELERS - 1) / 2) left += _fc[k]; else if (k < (FEELERS - 1) / 2) right += _fc[k]; }
  a.boxedIn = maxC < 4 && speed < 2;
  a.escapeSide = left > right ? 1 : -1;
}

/** How long a gunner keeps searching around the last known position before giving up (s). */
const SEARCH_TIME = 12;

/**
 * Turret behaviour without a visible target. First a search: keep the gun on
 * the last known position and sweep around it, widening as time passes (the
 * enemy may have moved). Then give up into a sector scan: pick a new point in
 * the watched sector every few seconds, glide there on a damped spring, pause,
 * with a faint hand tremor, so the turret never snaps back or freezes rigidly.
 */
function searchAim(a, v, seat, idx, dt) {
  const time = a.game.time, id = a.s.id;
  const lost = time - a.lastSeenTime;
  v.getMuzzle(idx, _pos, _dir);
  let tYaw, tPitch;
  if (a.lastSeenTime > 0 && lost < SEARCH_TIME) {
    const dx = a.lastSeenX - _pos.x, dy = a.lastSeenY + 1 - _pos.y, dz = a.lastSeenZ - _pos.z;
    const flat = Math.hypot(dx, dz) || 1;
    const spread = Math.min(0.45, 0.05 + lost * 0.035);
    tYaw = Math.atan2(dx, dz) + Math.sin(time * 0.55 + id) * spread + Math.sin(time * 1.3 + id * 2) * spread * 0.25;
    tPitch = Math.atan2(dy, flat) + Math.sin(time * 0.8 + id) * 0.03;
  } else {
    // Sector scan around the direction the crew has been told to watch (else the hull's front).
    const centre = Number.isNaN(a.lookYaw) ? v.yaw : a.lookYaw;
    if (time > a.scanAt) {
      const r = hash2(id * 31 + seat, Math.floor(time * 0.37));
      a.scanTarget = centre + (r - 0.5) * 1.8;
      a.scanTargetPitch = (hash2(id, Math.floor(time * 0.37) + 7) - 0.5) * 0.12;
      a.scanAt = time + 2.5 + r * 3.5;
    }
    tYaw = a.scanTarget; tPitch = a.scanTargetPitch;
  }
  // Critically damped spring toward the scan point: accelerates, decelerates, settles.
  const err = angleDelta(a.scanYaw, tYaw);
  a.scanVel += (err * 7 - a.scanVel * 5.3) * dt;
  a.scanYaw += a.scanVel * dt;
  a.scanPitch += (tPitch - a.scanPitch) * Math.min(1, dt * 2.2);
  v.aimYaw[seat] = a.scanYaw + Math.sin(time * 1.7 + id) * 0.004;
  v.aimPitch[seat] = a.scanPitch + Math.sin(time * 2.3 + id * 3) * 0.003;
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
  // Crew blackboard: steady platform for the gunner's shot, or a short reverse behind cover while reloading.
  const cs = crewState(v, g.time);
  if (cs === CrewState.HOLD_STABLE) { c.throttle = 0; c.steer = 0; c.brake = Math.abs(v.speed) > 0.3; return; }
  if (cs === CrewState.HULL_DOWN_REVERSE) {
    if (rearClear(a, v)) { c.throttle = v.speed > 1 ? 0 : -0.6; c.brake = v.speed > 1; c.steer = 0; return; }
    v.crewBB.state = CrewState.NONE;
  }
  // Asked to make way (a friendly vehicle is stuck against this one): pull aside, then resume.
  if (a.yieldUntil > g.time && a.holdVehicle && !(a.target && a.targetVisible)) {
    a.holdVehicle = false; a.driveX = a.yieldX; a.driveZ = a.yieldZ; a.pursuit = true;
  }
  // Settled: a vehicle that has stopped does not start up again to shuffle a few metres because the point it
  // was given moved a little (following a squad, a drifting standoff point). It moves when the point is
  // really somewhere else, or to park precisely.
  if (a.holdVehicle) a.settled = true;
  else if (a.settled) {
    if (!a.pursuit && a.arriveR >= 6 && Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z) < 18) { a.holdVehicle = true; a.settleHolds++; }
    else a.settled = false;
  }
  if (a.holdVehicle) {
    c.throttle = 0; c.steer = 0; c.brake = true;
    // Holding but told which way to face (frontal armour toward the threat): pivot / creep round.
    if (!Number.isNaN(a.faceYaw)) {
      const err = angleDelta(v.yaw, a.faceYaw);
      if (Math.abs(err) > 0.1) {
        c.brake = false;
        if (v.def.maxSteer === 0) { c.steer = clamp(err * 2, -1, 1); c.throttle = 0; }  // tracks: pivot in place
        else {
          // Wheels cannot pivot: shuffle round in place, forward on full lock then back on opposite lock,
          // switching when the room in front / behind runs out (or after a few metres), instead of a wide circle.
          const side = err > 0 ? 1 : -1;
          if (a.shuffleT <= 0 || (a.shuffleDir > 0 && a.clearAhead < 4.5) || (a.shuffleDir < 0 && !rearClear(a, v))) {
            a.shuffleDir = a.shuffleT <= 0 ? (a.clearAhead > 6 ? 1 : -1) : -a.shuffleDir; a.shuffleT = 2.4;
          }
          a.shuffleT -= dt;
          a.avoidT -= dt;
          if (a.avoidT <= 0) { a.avoidT = 0.1; avoid(a, v, v.yaw); }
          c.steer = a.shuffleDir > 0 ? side : -side;
          c.throttle = a.shuffleDir > 0 ? 0.4 : -0.5;
          if (Math.abs(v.speed) > 3) c.throttle = 0;
        }
        return;
      }
    }
    a.shuffleT = 0;
    return;
  }
  // Convoy hold (waiting for the column or keeping interval): brake without counting as stuck.
  if (a.speedCap < 0.5) {
    c.throttle = 0; c.steer = 0; c.brake = true;
    a.stuck = 0; a.progressX = v.pos.x; a.progressZ = v.pos.z;
    return;
  }
  let wx, wz, d, last;
  // Repeatedly stuck at the same spot: close to the goal counts as arrived; otherwise detour, then re-plan.
  if (a.stuckRepeat >= 3 && !a.pursuit && Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z) < 30) {
    c.throttle = 0; c.steer = 0; c.brake = true;
    a.stuck = 0; a.progressX = v.pos.x; a.progressZ = v.pos.z;
    if (Math.hypot(a.driveX - a.stuckGoalX, a.driveZ - a.stuckGoalZ) > 15) a.stuckRepeat = 0; // new goal: try again
    return;
  }
  if (a.detourUntil > g.time && !a.pursuit) {
    wx = a.detourX; wz = a.detourZ; last = false;
    d = Math.hypot(wx - v.pos.x, wz - v.pos.z);
    if (d < 6) a.detourUntil = 0;
  } else if (a.pursuit) {
    // Direct pursuit of a nearby moving target with a clear line (convoy slots): no path, no stop at path end.
    wx = a.driveX; wz = a.driveZ; last = false;
    d = Math.hypot(wx - v.pos.x, wz - v.pos.z);
    if (d < 3) { c.throttle = 0; c.steer = 0; c.brake = true; return; }
  } else {
    a.repath -= dt;
    const goalMoved = Math.hypot(nav.tx - a.driveX, nav.tz - a.driveZ) > 10 || !nav.vehicle;
    if ((goalMoved || (nav.done && !nav.pending)) && a.repath <= 0) {
      nav.ignore = v.id;
      g.nav.request(nav, v.pos.x, v.pos.z, a.driveX, a.driveZ, true);
      a.repath = 2.5;
    }
    // No path from here (shoved into a pocket among trees or rubble): drive straight out toward the goal, then re-plan.
    if (nav.failed && !nav.pending && Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z) > 12) {
      a.detourX = a.driveX; a.detourZ = a.driveZ; a.detourUntil = g.time + 6; nav.failed = false;
      return;
    }
    if (nav.done) {
      c.throttle = 0; c.steer = 0; c.brake = true;
      // The end of a partial path is not the destination: search on from here straight away.
      if (nav.partial && Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z) > 12) { a.repath = Math.min(a.repath, 0.2); a.partialHops++; nav.partial = false; }
      return;
    }
    // Pure pursuit: steer for a point a speed-dependent distance ahead along the path (not for the next
    // corner itself, which made hulls cut corners into walls and circle points inside their turning circle).
    const P = nav.path, spd = Math.abs(v.speed);
    for (let k = 0; k < 4 && nav.idx < nav.len; k++) {
      const ax = nav.idx > 0 ? P[nav.idx * 2 - 2] : nav.sx, az = nav.idx > 0 ? P[nav.idx * 2 - 1] : nav.sz;
      const bx = P[nav.idx * 2], bz = P[nav.idx * 2 + 1];
      const sx = bx - ax, sz = bz - az, sl2 = sx * sx + sz * sz;
      const t = sl2 > 1e-4 ? ((v.pos.x - ax) * sx + (v.pos.z - az) * sz) / sl2 : 1;
      const isLast = nav.idx === nav.len - 1;
      const db = Math.hypot(bx - v.pos.x, bz - v.pos.z);
      // Reached the point, or passed it along the segment (never turn back for a corner already rounded).
      if ((isLast ? db < a.arriveR : db < 2.5 + spd * 0.25 || t >= 1)) nav.idx++;
      else break;
    }
    if (nav.done) { c.throttle = 0; c.steer = 0; c.brake = true; return; }
    last = nav.idx === nav.len - 1;
    {
      const ax = nav.idx > 0 ? P[nav.idx * 2 - 2] : nav.sx, az = nav.idx > 0 ? P[nav.idx * 2 - 1] : nav.sz;
      const bx = P[nav.idx * 2], bz = P[nav.idx * 2 + 1];
      const sx = bx - ax, sz = bz - az, sl = Math.hypot(sx, sz) || 1;
      const t = clamp(((v.pos.x - ax) * sx + (v.pos.z - az) * sz) / (sl * sl), 0, 1);
      let qx = ax + sx * t, qz = az + sz * t;
      let L = clamp(4.5 + spd * 0.65, 5, 14);
      let i = nav.idx;
      for (;;) {
        const px = P[i * 2], pz = P[i * 2 + 1], rem = Math.hypot(px - qx, pz - qz);
        if (L <= rem || i === nav.len - 1) {
          const f = rem > 1e-3 ? Math.min(1, L / rem) : 1;
          wx = qx + (px - qx) * f; wz = qz + (pz - qz) * f;
          break;
        }
        L -= rem; qx = px; qz = pz; i++;
      }
      // The carrot must be reachable in a straight line; otherwise fall back to the path point itself.
      if (a.avoidT <= dt) a.carrotBad = !g.nav.lineClear(v.pos.x, v.pos.z, wx, wz, true);
      if (a.carrotBad) { wx = bx; wz = bz; }
      d = Math.hypot(P[(nav.len - 1) * 2] - v.pos.x, P[(nav.len - 1) * 2 + 1] - v.pos.z);
      // Corner ahead: the turn angle at the next path point sets a speed to be down to by the time we get there.
      a.cornerV = 99;
      if (!last) {
        // Curvature lookahead: the next three corners, each setting the speed to be down to by the time we get
        // there (a sharp bend 40 m ahead slows us now, not when we are on it).
        let ax2 = ax, az2 = az, bx2 = bx, bz2 = bz, along = Math.hypot(bx - v.pos.x, bz - v.pos.z);
        for (let j = nav.idx; j < Math.min(nav.len - 1, nav.idx + 3); j++) {
          const cx2 = P[j * 2 + 2], cz2 = P[j * 2 + 3];
          const ang = Math.abs(angleDelta(Math.atan2(bx2 - ax2, bz2 - az2), Math.atan2(cx2 - bx2, cz2 - bz2)));
          const vc = ang < 0.3 ? 99 : ang < 0.7 ? 10 : ang < 1.2 ? 7 : 4.5;
          a.cornerV = Math.min(a.cornerV, vc + along * 0.45);
          along += Math.hypot(cx2 - bx2, cz2 - bz2);
          ax2 = bx2; az2 = bz2; bx2 = cx2; bz2 = cz2;
          if (along > 70) break;
        }
      } else a.cornerV = 2.5 + d * 0.45;
      // Narrow ground: bridges and town streets are taken at a crawl / steady pace (no fishtailing into walls).
      const surf = g.map.terrain.surfAt(wx, wz);
      if (surf === 2 && !skidSteer(v)) a.cornerV = Math.min(a.cornerV, 9);
      const br = g.map.bridge;
      if (br && (wx - br.x) ** 2 + (wz - br.z) ** 2 < 45 * 45) a.cornerV = Math.min(a.cornerV, 7);
      a.carrotX = wx; a.carrotZ = wz;
    }
  }
  // Context steering (10 Hz): pick the clearest heading near the path direction.
  const want = Math.atan2(wx - v.pos.x, wz - v.pos.z);
  a.avoidT -= dt;
  if (a.avoidT <= 0) { a.avoidT = 0.1; avoid(a, v, want); }
  if (a.boxedIn && a.reverseTimer <= 0) { a.reverseTimer = 1.4; a.reverseSteer = a.escapeSide; a.boxedIn = false; }
  const err = angleDelta(v.yaw, a.avoidYaw);
  const skid = v.def.maxSteer === 0;
  if (a.reverseTimer > 0) {
    a.reverseTimer -= dt;
    c.throttle = -0.9;
    // Back out turning the nose toward the clearer side.
    // Reversing flips the turn (wheels and skid-steer alike): negative input swings the nose toward +side.
    c.steer = -a.reverseSteer * (skid ? 0.6 : 0.9);
    return;
  }
  // Three-point turn: a wheeled vehicle whose way lies well behind it backs up swinging its nose round,
  // instead of a wide forward circle that runs it into whatever is beside it (parks, streets, gates).
  if (!skid) {
    const wantErr = angleDelta(v.yaw, want);
    if (a.turnRev <= 0 && Math.abs(wantErr) > 1.75 && Math.abs(v.speed) < 4 && !a.pursuit && rearClear(a, v)) {
      a.turnRev = 2.6; a.turnSide = wantErr > 0 ? 1 : -1; a.kTurns++;
    }
    if (a.turnRev > 0) {
      a.turnRev -= dt;
      if (Math.abs(wantErr) < 0.8 || (a.turnRev < 2.2 && !rearClear(a, v))) a.turnRev = 0;
      else {
        c.throttle = v.speed > 1 ? 0 : -0.75; c.brake = v.speed > 1;
        c.steer = -a.turnSide;
        a.stuck = 0; a.progressX = v.pos.x; a.progressZ = v.pos.z;
        return;
      }
    }
  }
  // Damped steering: proportional on the heading error, a derivative term on the hull's own yaw rate (so it does
  // not swing past the heading and back), and a slew limit on the wheel itself (no twitching between avoidance picks).
  const yawRate = a.lastYaw === undefined ? 0 : angleDelta(a.lastYaw, v.yaw) / Math.max(dt, 1e-3);
  a.lastYaw = v.yaw;
  const steerWant = clamp(err * 1.7 - yawRate * (skid ? 0.22 : 0.32), -1, 1);
  const slew = (skid ? 4 : 3.2) * dt;
  a.steerOut = (a.steerOut || 0) + clamp(steerWant - (a.steerOut || 0), -slew, slew);
  c.steer = a.steerOut;
  if (skid) c.throttle = Math.abs(err) > 0.7 ? 0.12 : clamp(1.1 - Math.abs(err), 0.3, 1);
  else {
    // Ease off for sharp steering; bots keep to a speed at which they can still dodge rocks and trees.
    c.throttle = Math.abs(err) > 0.5 && v.speed > 9 ? 0 : clamp(1.05 - Math.abs(err) * 0.6, 0.35, 1);
    if (v.speed > 16) c.throttle = 0;
  }
  // Velocity-scaled turn braking: the sharper the turn still to make, the lower the speed it can be made at
  // (trucks and APCs no longer run wide off a bend into the ditch).
  if (!skid) {
    const turnV = 4 + 13 * clamp(1 - Math.abs(err) / 0.9, 0, 1);
    if (v.speed > turnV) { c.throttle = 0; if (v.speed > turnV + 2.5) c.brake = true; }
  }
  // Slow for the next corner / the stop at the end of the path.
  if (!a.pursuit && a.detourUntil <= g.time && v.speed > a.cornerV) { c.throttle = 0; if (v.speed > a.cornerV + 3) c.brake = true; }
  // Convoy speed matching / caution caps.
  if (v.speed > a.speedCap) c.throttle = Math.min(c.throttle, 0);
  // Slow for what is ahead on the chosen heading; brake hard for something very close.
  if (a.clearAhead < 9) {
    c.throttle = Math.min(c.throttle, Math.max(0.15, a.clearAhead / 9));
    if (a.clearAhead < 3.5 && v.speed > 3) { c.throttle = 0; c.brake = true; }
  }
  // Whiskers: something solid right ahead and we are not getting anywhere: back out turning (a three-point turn
  // for wheels) now, rather than grinding forward until the stuck timer notices.
  if (a.clearAhead < 3 && Math.abs(v.speed) < 0.8 && c.throttle > 0.2 && a.reverseTimer <= 0) {
    a.whiskerT = (a.whiskerT || 0) + dt;
    if (a.whiskerT > 1.2) {
      a.whiskerT = 0; a.reverseTimer = 1.6; a.reverseSteer = a.escapeSide; a.whiskerRecover = (a.whiskerRecover || 0) + 1;
      a.stuck = 0; a.progressX = v.pos.x; a.progressZ = v.pos.z;
    }
  } else a.whiskerT = 0;
  // Stuck detection by progress, not speed: a hull grinding against an obstacle
  // can creep at walking pace forever without getting anywhere.
  a.stuck += dt;
  if (a.stuck > 3) {
    const moved = Math.hypot(v.pos.x - a.progressX, v.pos.z - a.progressZ);
    if (moved < 2.5 && c.throttle > 0.2) {
      a.reverseTimer = 1.7; a.reverseSteer = a.escapeSide; a.stuckTotal++; nav.len = 0; a.repath = 0;
      makeWay(a, v);
      // Same spot again? Count repeats.
      a.stuckRepeat = Math.hypot(v.pos.x - a.stuckX, v.pos.z - a.stuckZ) < 12 ? a.stuckRepeat + 1 : 1;
      a.stuckX = v.pos.x; a.stuckZ = v.pos.z; a.stuckGoalX = a.driveX; a.stuckGoalZ = a.driveZ;
      // Never retry the same move blindly: mark the spot just ahead as an obstacle for route planning for a
      // while, so the re-plan goes round whatever is there (it is in nobody's map: debris, a hull, a crowd).
      if (a.stuckRepeat >= 2) {
        const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw), ahead = v.def.half[2] + 2.5;
        g.nav.setDyn(JAM_KEY + v.id, v.pos.x + fx * ahead, v.pos.z + fz * ahead, v.yaw, v.def.half[0] + 1, 2.2, g.time + 25);
        a.jamReroutes++;
      }
      // Third time here: swing out sideways to an open point before re-planning.
      if (a.stuckRepeat >= 3) {
        const side = a.stuckRepeat % 2 ? 1 : -1, yaw = Math.atan2(a.driveX - v.pos.x, a.driveZ - v.pos.z) + side * 1.9;
        for (let k = 0; k < 6; k++) {
          const r = 22 + k * 5, x = v.pos.x + Math.sin(yaw + k * 0.3 * side) * r, z = v.pos.z + Math.cos(yaw + k * 0.3 * side) * r;
          if (!g.nav.blocked(x, z, true) && g.nav.lineClear(v.pos.x, v.pos.z, x, z, true)) { a.detourX = x; a.detourZ = z; a.detourUntil = g.time + 9; break; }
        }
      }
    } else if (moved > 15) { a.stuckTotal = Math.max(0, a.stuckTotal - 0.5); a.stuckRepeat = 0; }
    a.stuck = 0; a.progressX = v.pos.x; a.progressZ = v.pos.z;
  }
}

function skidSteer(v) { return v.def.maxSteer === 0; }

/** Free room behind the hull to back up (terrain / props / parked vehicles, then moving vehicles and friends). */
function rearClear(a, v) {
  const g = a.game, bx = -Math.sin(v.yaw), bz = -Math.cos(v.yaw), h = v.def.half[2];
  for (const d of [2, 4.5]) if (g.nav.blocked(v.pos.x + bx * (h + d), v.pos.z + bz * (h + d), true)) return false;
  for (const o of g.vehicles.list) {
    if (o === v || !(o.alive || o.wreckTimer > 0)) continue;
    const ox = o.pos.x - v.pos.x, oz = o.pos.z - v.pos.z, al = ox * bx + oz * bz;
    if (al > 0 && al < h + o.def.half[2] + 5 && Math.abs(ox * bz - oz * bx) < v.def.half[0] + o.def.half[0] + 0.8) return false;
  }
  return true;
}

/**
 * A stuck vehicle with a friendly vehicle parked or holding right in front of it asks that one to pull 9 m
 * aside (away from the stuck vehicle's way) for a few seconds: vehicle parks and gates used to jam.
 */
function makeWay(a, v) {
  const g = a.game, fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
  let best = null, bd = 9;
  for (const o of g.vehicles.list) {
    if (o === v || !o.alive || o.team !== v.team || o.def.kind !== 'ground' || o.def.static || Math.abs(o.speed) > 1) continue;
    const ox = o.pos.x - v.pos.x, oz = o.pos.z - v.pos.z, d = Math.hypot(ox, oz) - o.def.half[2] - v.def.half[2];
    if (d > bd || ox * fx + oz * fz < 0) continue;
    const oa = o.driver && o.driver.ai;
    if (!oa || o.driver.isPlayer) continue;
    bd = d; best = o;
  }
  if (!best) return;
  const oa = best.driver.ai;
  // Sideways relative to our heading, to the side the blocker already sits on.
  const side = (best.pos.x - v.pos.x) * fz - (best.pos.z - v.pos.z) * fx > 0 ? 1 : -1;
  for (let k = 0; k < 2; k++) {
    const sd = k ? -side : side, x = best.pos.x + fz * 9 * sd, z = best.pos.z - fx * 9 * sd;
    if (g.nav.blocked(x, z, true)) continue;
    oa.yieldX = x; oa.yieldZ = z; oa.yieldUntil = g.time + 5;
    if (g.navStats) g.navStats.vehicleYields = (g.navStats.vehicleYields || 0) + 1;
    return;
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

  if (a.heliHover) {
    // Station keeping over a point at a fixed height (fast-rope): gentle approach, damped altitude hold.
    a.landed = false;
    let vx = 0, vz = 0;
    if (dist > 1.5) { const s = Math.min(10, dist * 0.45); vx = (dx / dist) * s; vz = (dz / dist) * s; }
    c.collective = clamp((ground + a.heliAlt + v.def.ride - p.y) * 0.25 - lv.y * 0.3, -1, 1);
    const ex = vx - lv.x, ez = vz - lv.z;
    c.pitch = clamp((ex * fx + ez * fz) * 0.14, -1, 1);
    c.roll = clamp((ex * -fz + ez * fx) * 0.14, -1, 1);
    c.yaw = 0;
    return;
  }
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
  const time = a.game.time, evading = a.evadeUntil > time;
  // Cruise height above terrain comes from the controller (nap-of-the-earth hides, pop-ups, transit);
  // a missile / radar warning drops it to treetop height for terrain masking.
  const cruise = evading ? 8 : a.heliAlt > 0 ? a.heliAlt : v.def.role === 'airlift' ? 32 : 42;
  const ahead = Math.max(terrain.height(p.x + lv.x * 3, p.z + lv.z * 3), terrain.height(p.x + lv.x * 1.5, p.z + lv.z * 1.5));
  // Altitude hold on a smoothed target (terrain bumps no longer bob the airframe), damped by the climb rate.
  const altWant = Math.max(ground, ahead, 0) + cruise + v.def.ride;
  a.hAlt = a.hAlt === undefined || a.hAlt !== a.hAlt ? altWant : altWant > a.hAlt ? altWant : a.hAlt + (altWant - a.hAlt) * Math.min(1, dt * 0.8);
  c.collective = clamp((a.hAlt - p.y) * 0.2 - lv.y * 0.06, -1, 1);

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
  if (t && a.targetVisible && t.alive && v.def.role === 'heli' && a.heliAlt > 20) {
    const tx = t.pos.x - p.x, tz = t.pos.z - p.z, td = Math.hypot(tx, tz);
    if (td < 320) {
      desiredYaw = Math.atan2(tx, tz);
      // Attack run: close while far, slide sideways when near so the nose stays on target.
      const s = td > 150 ? 16 : 5;
      vx = (tx / td) * s + (-tz / td) * 6; vz = (tz / td) * s + (tx / td) * 6;
    }
  }
  if (evading) {
    // Notch: break perpendicular to the threat bearing (the side we are already sliding toward) at full speed.
    const side = (lv.x * Math.cos(a.evadeYaw) - lv.z * Math.sin(a.evadeYaw)) >= 0 ? 1 : -1;
    vx = Math.cos(a.evadeYaw) * side * 30; vz = -Math.sin(a.evadeYaw) * side * 30;
    desiredYaw = Math.atan2(vx, vz);
  }
  // Smooth the commanded velocity (acceleration-limited) so waypoint and mode changes do not kick the cyclic.
  if (a.hvx === undefined || a.hvx !== a.hvx) { a.hvx = lv.x; a.hvz = lv.z; }
  const maxA = (evading ? 9 : 5) * dt;
  a.hvx += clamp(vx - a.hvx, -maxA, maxA); a.hvz += clamp(vz - a.hvz, -maxA, maxA);
  // Velocity loop with damping on the airframe's own acceleration (no porpoising).
  const axh = a.hlvx === undefined ? 0 : (lv.x - a.hlvx) / Math.max(dt, 1e-3), azh = a.hlvz === undefined ? 0 : (lv.z - a.hlvz) / Math.max(dt, 1e-3);
  a.hlvx = lv.x; a.hlvz = lv.z;
  a.hax = (a.hax || 0) + (clamp(axh, -15, 15) - (a.hax || 0)) * Math.min(1, dt * 8);
  a.haz = (a.haz || 0) + (clamp(azh, -15, 15) - (a.haz || 0)) * Math.min(1, dt * 8);
  const ex = a.hvx - lv.x - a.hax * 0.35, ez = a.hvz - lv.z - a.haz * 0.35;
  c.pitch = clamp((ex * fx + ez * fz) * 0.085, -0.85, 0.85);
  c.roll = clamp((ex * -fz + ez * fx) * 0.085, -0.85, 0.85);
  if (speed > 5 && !evading && desiredYaw === Math.atan2(lv.x, lv.z)) desiredYaw = Math.atan2(a.hvx, a.hvz);
  const yawErr = angleDelta(heading, desiredYaw);
  c.yaw = clamp(yawErr * 1.3, -1, 1) * (Math.abs(yawErr) < 0.03 ? 0.5 : 1);
  // Shallow-dive rocket pass (gunship pilot with rocket pods): the altitude hold yields to a nose-down attitude
  // pointing the fixed pods at the target's lead point; pull out below 25 m or inside 160 m.
  if (!evading && t && a.targetVisible && t.alive && v.def.role === 'heli' && a.heliAlt >= 40 && !isAir(t)) {
    const rk = rocketMount(v);
    const tx = t.pos.x - p.x, tz = t.pos.z - p.z, td = Math.hypot(tx, tz);
    if (rk && td > 160 && td < 700 && agl > 25) {
      const tof = td / (rk.speed || 300);
      const lx = t.pos.x + (t.vel ? t.vel.x * tof : 0) - p.x, lz = t.pos.z + (t.vel ? t.vel.z * tof : 0) - p.z;
      const ly = t.pos.y + 0.5 * (rk.gravity || 0) * tof * tof - p.y, lflat = Math.hypot(lx, lz);
      v.forward(_f);
      const wantFy = ly / Math.hypot(lflat, ly);
      c.pitch = clamp((_f.y - wantFy) * 3.2, -1, 1);
      c.collective = clamp(c.collective * 0.35, -0.25, 1);
      c.yaw = clamp(angleDelta(heading, Math.atan2(lx, lz)) * 2.2, -1, 1);
      a.rocketPass = (a.rocketPass || 0) + dt;
    }
  }
}

/** Keeps an attack dive between 20° and 30° below the horizon (shallower if the geometry allows no more). */
function diveLimit(D, flat) {
  if (D.y >= 0 || flat < 1) return;
  const ang = Math.atan2(-D.y, flat);
  if (ang > 0.52) D.y = -Math.tan(0.52) * flat;
  else if (ang < 0.35 && flat > 400) D.y = -Math.tan(0.35) * flat;
}

/** The pilot's fixed forward weapon (rockets / cannon / bombs) used to aim the dive. */
function fixedGun(v) {
  const ms = v.def.mounts;
  for (let i = 0; i < ms.length; i++) if (ms[i].seat === 0 && ms[i].turnRate === 0 && !v.weapons[i].def.drop && !v.weapons[i].def.homing) return v.weapons[i].def;
  return null;
}

/** The pilot's fixed rocket pods, if the aircraft has any (weapon def). */
function rocketMount(v) {
  const ms = v.def.mounts;
  for (let i = 0; i < ms.length; i++) if (ms[i].seat === 0 && ms[i].turnRate === 0 && /rocket/.test(ms[i].weapon)) return v.weapons[i].def;
  return null;
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
    // Hold the runway heading and steer back onto the centreline during the roll.
    const lat = rw ? (p.x - rw.x0) * -rw.dz + (p.z - rw.z0) * rw.dx : 0;
    c.yaw = clamp(angleDelta(v.yaw, hdg) * 2.5 + clamp(lat * 0.05, -0.3, 0.3), -1, 1);
    // Progressive rotation: from rotation speed the nose comes up to ~13° over ~1.5 s (no pitch snap).
    if (speed > fl.stall * 1.08) {
      if (!(a.rotateT > 0)) a.rotateT = time;
      v.forward(_f);
      const want = Math.min(1, (time - a.rotateT) / 1.5) * 0.23, cur = Math.asin(clamp(_f.y, -1, 1));
      c.pitch = clamp(-(want - cur) * 4, -0.75, 0.3);
    } else { c.pitch = 0; a.rotateT = 0; }
    return;
  }
  a.rotateT = 0;
  const ground = Math.max(terrain.height(p.x, p.z), 0);
  const agl = p.y - ground;
  const half = terrain.half;
  let throttle = 1;

  // Desired flight direction.
  const t = a.target;
  const visible = t !== null && a.targetVisible && t.alive;
  const fighter = v.weapons.some((w) => w.def.homing === 'air');
  if (a.evadeUntil > time && a.jetPullUntil <= time) {
    // Notch: beam the threat (fly perpendicular to its bearing) and dive toward ~80 m for terrain masking.
    const side = (_f.x * Math.cos(a.evadeYaw) - _f.z * Math.sin(a.evadeYaw)) >= 0 ? 1 : -1;
    _D.set(Math.cos(a.evadeYaw) * side, 0, -Math.sin(a.evadeYaw) * side);
    _D.y = clamp((ground + 80 - p.y) * 0.01, -0.35, 0.2);
  } else if (a.jetPullUntil > time) {
    _D.set(_f.x, 0, _f.z).normalize().multiplyScalar(0.8); _D.y = 0.75;
  } else if (a.jetMode === 1 && !(visible && !isAir(t))) {
    // CAS run along the marked attack vector: set up at the ingress point, then dive on the mark.
    const tx = a.jetX, tz = a.jetZ, ty = Math.max(terrain.height(tx, tz), 0);
    const dx = tx - p.x, dz = tz - p.z, flat = Math.hypot(dx, dz) || 1;
    const along = (dx * a.jetVX + dz * a.jetVZ) / flat;
    if (flat > 950 || (along < 0.75 && flat > 260)) {
      const ix = tx - a.jetVX * 850, iz = tz - a.jetVZ * 850;
      _D.set(ix - p.x, 0, iz - p.z).normalize();
      _D.y = clamp((ground + a.jetAlt - p.y) * 0.01, -0.3, 0.4);
    } else {
      // Attack dive at 20–30° (CCIP: bombs release on the predicted impact point, see operateMount).
      _D.set(dx, ty + 1 - p.y, dz);
      diveLimit(_D, flat);
      throttle = 0.75;
      if (agl < 85 || flat < 140) a.jetPullUntil = time + 4.5;
    }
  } else if (visible && isAir(t)) {
    _D.copy(t.pos).addScaledVector(t.vel, Math.min(2.5, p.distanceTo(t.pos) / 200)).sub(p);
  } else if (visible && (!fighter || t.kind === 'vehicle' || t.kind === 'soldier')) {
    _D.set(t.pos.x - p.x, 0, t.pos.z - p.z);
    const flat = _D.length();
    if (flat > 700) { _D.normalize(); _D.y = clamp((ground + 140 - p.y) * 0.01, -0.3, 0.4); }
    else {
      // Dive onto the target's lead point (velocity × time of flight, plus the gravity drop of rockets /
      // cannon shells) at 20–30°; pull out low or close.
      const fw = fixedGun(v), dist = Math.hypot(t.pos.x - p.x, t.pos.y - p.y, t.pos.z - p.z), tof = fw ? dist / (fw.speed || 600) : 0;
      _D.set(t.pos.x + (t.vel ? t.vel.x * tof : 0) - p.x, t.pos.y + 1 + (fw ? 0.5 * (fw.gravity || 0) * tof * tof : 0) - p.y, t.pos.z + (t.vel ? t.vel.z * tof : 0) - p.z);
      diveLimit(_D, flat);
      throttle = 0.75;
      if (agl < 85 || flat < 140) a.jetPullUntil = time + 4.5;
    }
  } else {
    // Racetrack over the loiter point at the controller's altitude.
    const ox = a.jetX, oz = a.jetZ;
    const dx = ox - p.x, dz = oz - p.z, d = Math.hypot(dx, dz) || 1;
    const k = (d - 260) * 0.004;
    _D.set(-dz / d + (dx / d) * k, 0, dx / d + (dz / d) * k).normalize();
    _D.y = clamp((ground + Math.min(a.jetAlt, 300) - p.y) * 0.012, -0.35, 0.45);
  }
  // Smooth the wanted direction (mode switches no longer jerk the stick); emergencies below bypass this.
  _D.normalize();
  const kD = 1 - Math.exp(-dt / 0.55);
  if (a.jDx === undefined || a.jDx !== a.jDx) { a.jDx = _D.x; a.jDy = _D.y; a.jDz = _D.z; }
  a.jDx += (_D.x - a.jDx) * kD; a.jDy += (_D.y - a.jDy) * kD; a.jDz += (_D.z - a.jDz) * kD;
  _D.set(a.jDx, a.jDy, a.jDz);
  // Terrain look-ahead and map edge: a gentle climb for a ridge 6 s out, a hard pull for one 3 s out.
  const far6 = Math.max(terrain.height(p.x + v.vel.x * 6, p.z + v.vel.z * 6), terrain.height(p.x + v.vel.x * 4.5, p.z + v.vel.z * 4.5), 0);
  if (p.y + Math.min(0, v.vel.y) * 6 < far6 + 70) _D.y = Math.max(_D.y, 0.45 * Math.hypot(_D.x, _D.z));
  const ahead = Math.max(terrain.height(p.x + v.vel.x * 3, p.z + v.vel.z * 3), terrain.height(p.x + v.vel.x * 1.5, p.z + v.vel.z * 1.5), 0);
  if (p.y + Math.min(0, v.vel.y) * 3 < ahead + 55) { _D.set(_f.x, 0, _f.z).normalize(); _D.y = 1.1; a.jetPullUntil = Math.max(a.jetPullUntil, time + 1.5); a.jDx = _D.x; a.jDy = _D.y; a.jDz = _D.z; }
  if (Math.max(Math.abs(p.x), Math.abs(p.z)) > half + 70) { _D.set(-p.x, 0, -p.z).normalize(); _D.y = 0.1; }
  if (agl > 330) _D.y = Math.min(_D.y, -0.25);
  _D.normalize();

  // Bank-to-turn: roll the target into the lift plane, then pull toward it.
  const lr = -_D.dot(_l), lu = _D.dot(_u), lf = _D.dot(_f);
  const bank = Math.atan2(_l.y, _u.y);
  const offAxis = smoothstep(0.995, 0.9, lf);
  const rollErr = offAxis * Math.atan2(lr, Math.max(lu, 0.05)) + (1 - offAxis) * -bank;
  // Critically damped attitude loops: proportional on the error, derivative on its (filtered, clamped) rate of
  // change, so the bank settles without rocking and the pull does not porpoise.
  const pitchErr = -Math.atan2(lu, Math.max(lf, 0.15));
  const dR = a.jRollErr === undefined ? 0 : clamp(angleDelta(a.jRollErr, rollErr) / Math.max(dt, 1e-3), -4, 4);
  const dP = a.jPitchErr === undefined ? 0 : clamp((pitchErr - a.jPitchErr) / Math.max(dt, 1e-3), -4, 4);
  a.jRollErr = rollErr; a.jPitchErr = pitchErr;
  a.jdR = (a.jdR || 0) + (dR - (a.jdR || 0)) * Math.min(1, dt * 12);
  a.jdP = (a.jdP || 0) + (dP - (a.jdP || 0)) * Math.min(1, dt * 12);
  c.roll = clamp(rollErr * 1.9 + a.jdR * 0.42, -1, 1);
  // Coordinated turn: pull in proportion to how far the bank is established (no pulling while still rolling in).
  const established = 1 - smoothstep(0.35, 1.2, Math.abs(rollErr));
  c.pitch = clamp((pitchErr * 2.2 + a.jdP * 0.4) * (0.35 + 0.65 * established), -1, 1);
  // Never pull the nose up into a stall: below 1.15× stall speed the pull is limited.
  if (speed < fl.stall * 1.15) c.pitch = Math.max(c.pitch, -0.25);
  c.yaw = lf > 0.9 ? clamp(-lr * 3, -1, 1) : 0;
  c.throttle = speed < fl.stall * 1.25 ? 1 : throttle;
}
