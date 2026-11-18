import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { clamp, turnToward, angleDelta } from '../core/math.js';
import { NavState } from '../systems/navigation.js';
import { driveGround, flyHeli, flyJet, operateMount } from '../ai/vehicle-pilot.js';

const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();
/** Movement speed multiplier per stance (stand, crouch, prone crawl). */
const STANCE_SPEED = [1, 0.55, 0.28];
/** Weapon sway multiplier per stance. */
const STANCE_SPREAD = [1, 0.8, 0.62];

/**
 * Per-bot actuator. Decisions live in the AI director (src/ai/*.ts):
 * perception and the utility brain write *intent* here at 4–5 Hz (goal,
 * stance, fire mode, weapon preference, vehicle orders), and `update()` turns
 * that intent into motion, aiming, trigger pulls and vehicle controls every
 * frame. Nothing in this class decides what to do.
 */
export class AIAgent {
  /**
   * @param {import('../systems/game.js').Game} game
   * @param {import('./soldier.js').Soldier} soldier
   */
  constructor(game, soldier) {
    this.game = game;
    this.s = soldier;
    // Deterministic per-soldier skill (accuracy / reaction).
    this.skill = 0.75 + ((soldier.id * 0.754877666) % 1) * 0.5;
    this.nav = new NavState();
    /** Current action / vehicle mode name (debug, telemetry). */
    this.state = 'patrol';
    this.reset();
  }

  reset() {
    /** @type {any} Soldier or Vehicle */
    this.target = null;
    this.targetVisible = false;
    this.lastSeenX = 0; this.lastSeenY = 0; this.lastSeenZ = 0; this.lastSeenTime = -100;
    this.acquireTime = 0;
    // Infantry intent.
    this.goalX = 0; this.goalZ = 0; this.hasGoal = false; this.sprint = false;
    /** 0 = hold fire, 1 = fire at visible target, 2 = suppress last known position */
    this.fireMode = 0;
    /** 0 = automatic choice, 1 = rifle, 2 = launcher */
    this.weaponPref = 0;
    this.burstLeft = 4; this.burstPause = 0;
    // Vehicle crew intent (read by src/ai/vehicle-pilot.js).
    this.driveX = 0; this.driveZ = 0; this.holdVehicle = false;
    this.speedCap = 1e9; this.faceYaw = NaN;
    /** Drive straight at (driveX, driveZ) without pathing (convoy followers with a clear line). */
    this.pursuit = false;
    this.heliLand = false; this.heliTransit = false; this.heliAlt = 42; this.landed = false; this.heliHover = false;
    /** Direction to watch when idle at a fighting position (NaN = none). */
    this.lookYaw = NaN;
    /** Gun / gaze search and scan state (natural sweeping instead of snapping back). */
    this.scanYaw = this.s.yaw; this.scanVel = 0; this.scanPitch = 0;
    this.scanAt = 0; this.scanTarget = this.s.yaw; this.scanTargetPitch = 0;
    /** Jets: 0 loiter over (jetX, jetZ), 1 attack run along (jetVX, jetVZ), 2 intercept the target. */
    this.jetMode = 0; this.jetX = 0; this.jetZ = 0; this.jetVX = 0; this.jetVZ = 1; this.jetAlt = 250; this.jetPullUntil = 0;
    /** Indirect-fire aim point, validity and dispersion (m). */
    this.artyX = 0; this.artyY = 0; this.artyZ = 0; this.artyUntil = 0; this.artySpread = 0;
    /** Endgame siege: point on an exposed enemy HQ to hit with explosives while no enemy is in sight. */
    this.siegeX = 0; this.siegeY = 0; this.siegeZ = 0; this.siegeUntil = 0;
    // Low-level driving / walking state.
    this.stuck = 0; this.stuckTotal = 0; this.reverseTimer = 0; this.repath = 0; this.progressX = 0; this.progressZ = 0;
    /** Repeated stuck events at one spot, and the detour taken to get out. */
    this.stuckRepeat = 0; this.stuckX = 0; this.stuckZ = 0; this.stuckGoalX = 0; this.stuckGoalZ = 0;
    /** Partial paths followed to their end on the way to the current goal (re-planned from there). */
    this.partialHops = 0;
    this.detourX = 0; this.detourZ = 0; this.detourUntil = 0;
    /** Asked to pull aside for a stuck friendly vehicle: where to, and until when. */
    this.yieldX = 0; this.yieldZ = 0; this.yieldUntil = 0;
    /** Obstacle avoidance (src/ai/vehicle-pilot.js): chosen heading, clear distance on it, boxed-in escape. */
    this.avoidT = 0; this.avoidYaw = 0; this.clearAhead = 99; this.boxedIn = false; this.escapeSide = 1; this.reverseSteer = 1;
    this.moveStuck = 0; this.lastX = 0; this.lastZ = 0; this.sidestep = 0; this.sideX = 0; this.sideZ = 0;
    /**
     * Walking progress toward the current goal: best distance so far, when it last improved, the recovery
     * step reached (0 none, 1 re-planned, 2 detoured, 3 gave up) and the goal given up on (with when).
     * Status for the debug overlay: 'moving' | 'replanning' | 'detour' | 'unreachable' | 'idle'.
     */
    this.progGX = NaN; this.progGZ = 0; this.progBest = 1e9; this.progT = 0; this.recover = 0;
    this.giveUpX = NaN; this.giveUpZ = 0; this.giveUpT = -1e3;
    this.navStatus = 'idle';
    this.nav.clear();
    this.nav.vehicle = false;
  }

  /** World-space point to shoot at. @param {THREE.Vector3} out */
  aimPoint(out) {
    const t = this.target;
    if (this.fireMode === 2 || !t) return out.set(this.lastSeenX, this.lastSeenY + 1.1, this.lastSeenZ);
    const h = t.kind === 'vehicle' ? 0.2 : t.stance === 2 ? 0.3 : t.stance === 1 ? 0.85 : 1.15;
    return out.set(t.pos.x, t.pos.y + h, t.pos.z);
  }

  _distTo(x, z) { return Math.hypot(x - this.s.pos.x, z - this.s.pos.z); }

  // --- Per-frame execution ----------------------------------------------------------

  /** @param {number} dt */
  update(dt) {
    const s = this.s;
    if (!s.alive) return;
    const v = s.vehicle;
    if (v) {
      s.moveX = s.moveZ = 0;
      s.sprinting = false;
      s.alert = true;
      s.stance = 0;
      if (s.seat === 0 && !v.def.static) {
        if (v.def.kind === 'heli') flyHeli(this, v, dt);
        else if (v.def.kind === 'jet') flyJet(this, v, dt);
        else driveGround(this, v, dt);
      }
      const armed = v.mountList(s.seat).length > 0;
      if (armed) operateMount(this, v, dt);
      s.yaw = armed ? v.aimYaw[s.seat] : v.yaw;
      return;
    }
    this._move(dt);
    this._aimAndFire(dt);
  }

  _move(dt) {
    const s = this.s, g = this.game, nav = this.nav;
    let mx = 0, mz = 0;
    const stance = s.stance | 0;
    if (this.hasGoal) {
      // A goal given up on in the last 30 s (unreachable from here): stay put at the closest point reached
      // instead of grinding against the same wall again.
      if (g.time - this.giveUpT < 30 && Math.hypot(this.goalX - this.giveUpX, this.goalZ - this.giveUpZ) < 4) {
        this.navStatus = 'unreachable';
        s.moveX = s.moveZ = 0; s.sprinting = false;
        s.alert = this.target !== null || this.fireMode !== 0 || stance !== 0;
        return;
      }
      this.repath -= dt;
      const direct = this._distTo(this.goalX, this.goalZ);
      const stale = Math.hypot(nav.tx - this.goalX, nav.tz - this.goalZ) > 3.5 || nav.vehicle;
      if ((stale || (nav.done && direct > 6)) && !nav.pending && this.repath <= 0) {
        g.nav.request(nav, s.pos.x, s.pos.z, this.goalX, this.goalZ, false);
        // Deterministic jitter keeps repaths from synchronising across bots.
        this.repath = 0.7 + ((s.id * 0.37 + g.time) % 1) * 0.5;
      }
      // Without a path, only a goal a few metres away is walked to directly (positions hugging a wall).
      let tx = this.goalX, tz = this.goalZ, have = direct < 6 && direct > 0.5;
      if (!nav.done && !stale) {
        tx = nav.path[nav.idx * 2]; tz = nav.path[nav.idx * 2 + 1];
        if (this._distTo(tx, tz) < 0.9) nav.idx++;
        have = true;
      }
      if (this.detourUntil > g.time) { tx = this.detourX; tz = this.detourZ; have = true; if (this._distTo(tx, tz) < 1.2) this.detourUntil = 0; }
      this._progress(direct);
      if (have && this.recover < 3) {
        const dx = tx - s.pos.x, dz = tz - s.pos.z, len = Math.hypot(dx, dz) || 1;
        const sprint = this.sprint && stance === 0;
        const speed = (sprint ? CONFIG.soldier.sprintSpeed : CONFIG.soldier.walkSpeed) * STANCE_SPEED[stance];
        mx = (dx / len) * speed; mz = (dz / len) * speed;
        // Bumping into something (a comrade, a crate): shuffle sideways briefly.
        this.moveStuck += dt;
        if (this.moveStuck > 1.1) {
          if (Math.hypot(s.pos.x - this.lastX, s.pos.z - this.lastZ) < 0.6 * STANCE_SPEED[stance]) {
            this.sidestep = 0.6;
            const side = (s.id + (g.time | 0)) & 1 ? 1 : -1;
            this.sideX = -mz * side; this.sideZ = mx * side;
          }
          this.moveStuck = 0; this.lastX = s.pos.x; this.lastZ = s.pos.z;
        }
      }
    } else this.navStatus = 'idle';
    if (this.sidestep > 0) { this.sidestep -= dt; mx = this.sideX; mz = this.sideZ; }
    s.moveX = mx; s.moveZ = mz;
    s.sprinting = this.sprint && stance === 0 && this.fireMode === 0;
    s.alert = this.target !== null || this.fireMode !== 0 || stance !== 0;
  }

  /**
   * Progress watchdog toward the current goal. No metre gained in 5 s while trying to walk:
   * 1) re-plan from here, 2) step out to a clear point to the side and re-plan, 3) give up: the goal is
   * unreachable from here (the soldier holds where he is and the goal is refused for 30 s, so the tactical
   * layer picks something else). Each step happens once per goal; a new goal starts clean.
   */
  _progress(direct) {
    const g = this.game, s = this.s, nav = this.nav, st = g.navStats || (g.navStats = { stalls: 0, replans: 0, detours: 0, giveUps: 0, recovered: 0 });
    if (Number.isNaN(this.progGX) || Math.hypot(this.goalX - this.progGX, this.goalZ - this.progGZ) > 3) {
      this.progGX = this.goalX; this.progGZ = this.goalZ; this.progBest = direct; this.progT = g.time; this.recover = 0;
      this.navStatus = 'moving';
      return;
    }
    if (direct < this.progBest - 1 || direct < 1.5) {
      if (this.recover > 0 && this.recover < 3) st.recovered++;
      this.progBest = Math.min(this.progBest, direct); this.progT = g.time;
      if (this.recover < 3) { this.recover = 0; this.navStatus = 'moving'; }
      return;
    }
    // Waiting on purpose (holding still, path being searched) is not a stall.
    if (nav.pending || g.time - this.progT < 5) return;
    this.progT = g.time;
    if (this.recover === 0) {
      st.stalls++; st.replans++;
      this.recover = 1; this.navStatus = 'replanning';
      nav.len = 0; this.repath = 0;
    } else if (this.recover === 1) {
      st.detours++;
      this.recover = 2; this.navStatus = 'detour';
      // A clear point 4-7 m off to either side of the line to the goal, reachable in a straight line.
      const yaw = Math.atan2(this.goalX - s.pos.x, this.goalZ - s.pos.z), side = s.id & 1 ? 1 : -1;
      for (let k = 0; k < 8; k++) {
        const a = yaw + (k & 1 ? -side : side) * (1.2 + (k >> 1) * 0.35), r = 4 + (k >> 1);
        const x = s.pos.x + Math.sin(a) * r, z = s.pos.z + Math.cos(a) * r;
        if (!g.nav.blocked(x, z) && g.nav.lineClear(s.pos.x, s.pos.z, x, z, false)) { this.detourX = x; this.detourZ = z; this.detourUntil = g.time + 3; break; }
      }
      nav.len = 0; this.repath = 1.5;
    } else if (this.recover === 2) {
      st.giveUps++;
      this.recover = 3; this.navStatus = 'unreachable';
      this.giveUpX = this.goalX; this.giveUpZ = this.goalZ; this.giveUpT = g.time;
    }
  }

  /** Chooses rifle or launcher from the preference and the target. */
  _pickWeapon(t) {
    const s = this.s, launcher = s.launcher;
    if (!launcher || launcher.ammo + launcher.reserve <= 0 || this.fireMode !== 1) return 0;
    if (this.weaponPref === 1) return 0;
    if (this.weaponPref === 2) return s.weapons.indexOf(launcher);
    const use = t.kind === 'vehicle' && t.def.kind !== 'jet' && (t.def.kind !== 'heli' || this._distTo(t.pos.x, t.pos.z) < 120);
    return use ? s.weapons.indexOf(launcher) : 0;
  }

  _aimAndFire(dt) {
    const s = this.s, g = this.game;
    const t = this.target;
    let wantYaw = s.yaw, wantPitch = 0, turnRate = 7.5;
    if (t && (this.fireMode !== 0 || this.targetVisible)) {
      s.weaponIdx = this._pickWeapon(t);
      const def = s.weapon.def;
      s.eye(_eye);
      this.aimPoint(_aim);
      let dx = _aim.x - _eye.x, dy = _aim.y - _eye.y, dz = _aim.z - _eye.z;
      if (def.type === 'projectile' && this.fireMode === 1 && t.kind === 'vehicle' && t.vel) {
        // Lead moving vehicles by the time of flight.
        const tof = Math.hypot(dx, dy, dz) / /** @type {number} */ (def.speed);
        dx += t.vel.x * tof; dz += t.vel.z * tof;
      }
      const flat = Math.hypot(dx, dz), dist = Math.hypot(flat, dy);
      if (def.type === 'projectile') {
        const tof = dist / /** @type {number} */ (def.speed);
        dy += 0.5 * /** @type {number} */ (def.gravity) * tof * tof;
      }
      wantYaw = Math.atan2(dx, dz);
      wantPitch = Math.atan2(dy, flat);
      const canShoot = this.fireMode === 2 || (this.targetVisible && (t.kind !== 'vehicle' || def.vsVehicle[t.def.armor] > 0));
      const firing = this.fireMode !== 0 && canShoot && dist < def.range && g.time >= this.acquireTime &&
        Math.abs(angleDelta(s.yaw, wantYaw)) < 0.09;
      if (firing) {
        if (this.burstPause > 0) this.burstPause -= dt;
        else {
          const inv = 1 / Math.hypot(dx, dy, dz);
          _dir.set(dx * inv, dy * inv, dz * inv);
          // Accuracy degrades with range, movement and suppressive fire; skill and a braced stance tighten it.
          const spread = (2.6 + dist / 45 + (s.speed > 1 ? 1.6 : 0) + (this.fireMode === 2 ? 3 : 0)) * STANCE_SPREAD[s.stance | 0] / this.skill;
          if (g.combat.fire(s, s.weapon, _eye, _dir, def.type === 'projectile' ? 2 : spread) && --this.burstLeft <= 0) {
            const r = (s.id * 0.618 + g.time * 1.7) % 1;
            this.burstPause = 0.3 + r * 0.75;
            this.burstLeft = 3 + ((r * 5) | 0);
          }
        }
      }
    } else if (this.siegeUntil > g.time && s.launcher && s.launcher.ammo + s.launcher.reserve > 0 && !s.vehicle) {
      // Endgame: put rockets into an exposed enemy HQ while no enemy is in sight.
      s.weaponIdx = s.weapons.indexOf(s.launcher);
      const def = s.weapon.def;
      s.eye(_eye);
      let dx = this.siegeX - _eye.x, dy = this.siegeY - _eye.y, dz = this.siegeZ - _eye.z;
      const flat = Math.hypot(dx, dz), dist = Math.hypot(flat, dy);
      const tof = dist / /** @type {number} */ (def.speed);
      dy += 0.5 * /** @type {number} */ (def.gravity) * tof * tof;
      wantYaw = Math.atan2(dx, dz);
      wantPitch = Math.atan2(dy, flat);
      if (dist < def.range && Math.abs(angleDelta(s.yaw, wantYaw)) < 0.06 && Math.abs(s.pitch - wantPitch) < 0.06 && s.speed < 1) {
        if (this.burstPause > 0) this.burstPause -= dt;
        else {
          const inv = 1 / Math.hypot(dx, dy, dz);
          _dir.set(dx * inv, dy * inv, dz * inv);
          if (g.combat.fire(s, s.weapon, _eye, _dir, 2)) this.burstPause = 1.2 + ((s.id * 0.618) % 1);
        }
      }
    } else {
      s.weaponIdx = 0;
      const lost = g.time - this.lastSeenTime;
      if (this.lastSeenTime > 0 && lost < 10 && s.speed < 2.5) {
        // Keep watching where the enemy was last seen, sweeping wider as the trail goes cold.
        const spread = Math.min(0.5, 0.08 + lost * 0.04);
        wantYaw = Math.atan2(this.lastSeenX - s.pos.x, this.lastSeenZ - s.pos.z) + Math.sin(g.time * 0.7 + s.id) * spread;
        turnRate = 2.6;
      } else if (!Number.isNaN(this.lookYaw) && s.speed < 1.5) {
        // At a fighting position: watch the sector, glancing left and right with pauses.
        if (g.time > this.scanAt) {
          const r = ((s.id * 0.6180339 + Math.floor(g.time * 0.31) * 0.7548777) % 1);
          this.scanTarget = this.lookYaw + (r - 0.5) * 1.2;
          this.scanAt = g.time + 2 + r * 3;
        }
        wantYaw = this.scanTarget;
        turnRate = 2.2;
      } else if (s.speed > 0.5) wantYaw = Math.atan2(s.moveX, s.moveZ);
    }
    s.yaw = turnToward(s.yaw, wantYaw, turnRate * dt);
    s.pitch += clamp(wantPitch - s.pitch, -3 * dt, 3 * dt);
  }
}
