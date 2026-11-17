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
    if (m.turnRate > 0) {
      if (def.artillery) { v.aimYaw[seat] = v.yaw; v.aimPitch[seat] = 0.3; }
      else searchAim(a, v, seat, idx, dt);
    }
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
  if (m.turnRate > 0) {
    v.aimYaw[seat] = Math.atan2(dx, dz); v.aimPitch[seat] = pitch;
    // Remember where the gun was laid, so a lost target is searched for from here (no snap back).
    a.scanYaw = v.aimYaw[seat]; a.scanPitch = pitch; a.scanVel = 0;
  }
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
  // Fire-mission dispersion shrinks as spotters walk the rounds in.
  const spread = isAir(t) ? 1.4 : def.artillery ? 3 * (a.artySpread > 0 ? clamp(a.artySpread / 18, 0.4, 1.4) : 1) : 2.2;
  if (a.game.combat.fire(a.s, weapon, _pos, _dir, spread, { vehicle: v, mount: idx, lock }) && def.auto && --a.burstLeft <= 0) {
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
  if (a.holdVehicle) {
    c.throttle = 0; c.steer = 0; c.brake = true;
    // Holding but told which way to face (frontal armour toward the threat): pivot / creep round.
    if (!Number.isNaN(a.faceYaw)) {
      const err = angleDelta(v.yaw, a.faceYaw);
      if (Math.abs(err) > 0.1) {
        c.brake = false;
        c.steer = clamp(err * 2, -1, 1);
        c.throttle = v.def.maxSteer === 0 ? 0 : 0.35;
      }
    }
    return;
  }
  // Convoy hold (waiting for the column or keeping interval): brake without counting as stuck.
  if (a.speedCap < 0.5) {
    c.throttle = 0; c.steer = 0; c.brake = true;
    a.stuck = 0; a.progressX = v.pos.x; a.progressZ = v.pos.z;
    return;
  }
  let wx, wz, d, last;
  if (a.pursuit) {
    // Direct pursuit of a nearby moving target with a clear line (convoy slots): no path, no stop at path end.
    wx = a.driveX; wz = a.driveZ; last = false;
    d = Math.hypot(wx - v.pos.x, wz - v.pos.z);
    if (d < 3) { c.throttle = 0; c.steer = 0; c.brake = true; return; }
  } else {
    a.repath -= dt;
    const goalMoved = Math.hypot(nav.tx - a.driveX, nav.tz - a.driveZ) > 10 || !nav.vehicle;
    if ((goalMoved || (nav.done && !nav.pending)) && a.repath <= 0) {
      g.nav.request(nav, v.pos.x, v.pos.z, a.driveX, a.driveZ, true);
      a.repath = 2.5;
    }
    if (nav.done) { c.throttle = 0; c.steer = 0; c.brake = true; return; }
    wx = nav.path[nav.idx * 2]; wz = nav.path[nav.idx * 2 + 1];
    d = Math.hypot(wx - v.pos.x, wz - v.pos.z);
    last = nav.idx === nav.len - 1;
    if (d < (last ? 10 : 8)) {
      nav.idx++;
      if (nav.done) return;
      wx = nav.path[nav.idx * 2]; wz = nav.path[nav.idx * 2 + 1];
      d = Math.hypot(wx - v.pos.x, wz - v.pos.z);
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
  // Convoy speed matching / caution caps.
  if (v.speed > a.speedCap) c.throttle = Math.min(c.throttle, 0);
  // Slow for what is ahead on the chosen heading; brake hard for something very close.
  if (a.clearAhead < 9) {
    c.throttle = Math.min(c.throttle, Math.max(0.15, a.clearAhead / 9));
    if (a.clearAhead < 3.5 && v.speed > 3) { c.throttle = 0; c.brake = true; }
  }
  // Stuck detection by progress, not speed: a hull grinding against an obstacle
  // can creep at walking pace forever without getting anywhere.
  a.stuck += dt;
  if (a.stuck > 3) {
    const moved = Math.hypot(v.pos.x - a.progressX, v.pos.z - a.progressZ);
    if (moved < 2.5 && c.throttle > 0.2) { a.reverseTimer = 1.7; a.reverseSteer = a.escapeSide; a.stuckTotal++; nav.len = 0; }
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
  // Cruise height above terrain comes from the controller (nap-of-the-earth hides, pop-ups, transit).
  const cruise = a.heliAlt > 0 ? a.heliAlt : v.def.role === 'airlift' ? 32 : 42;
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
  if (t && a.targetVisible && t.alive && v.def.role === 'heli' && a.heliAlt > 20) {
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
      _D.set(dx, ty + 1 - p.y, dz);
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
      // Dive onto the target; pull out low or close.
      _D.set(t.pos.x - p.x, t.pos.y + 1 - p.y, t.pos.z - p.z);
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
