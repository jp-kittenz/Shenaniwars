import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { clamp, turnToward, angleDelta } from '../core/math.js';
import { NavState } from '../systems/navigation.js';
import { selector, sequence, condition, action, Status } from '../ai/behavior-tree.js';
import { driveGround, flyHeli, operateMount } from '../ai/vehicle-pilot.js';

const AI = CONFIG.ai;
const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _cand = /** @type {any[]} */ ([null, null, null]);
const _candD = new Float32Array(3);

/**
 * The shared behavior tree (priority order, top wins):
 *   vehicle crew duties > retreat > [take cover > flank > engage] >
 *   investigate noise > board vehicle > advance to flag > patrol
 * @type {import('../ai/behavior-tree.js').BTNode<AIAgent>}
 */
const TREE = selector(
  sequence(condition((a) => a.s.vehicle !== null), action('vehicle', (a) => a.thinkVehicle())),
  sequence(condition((a) => a.shouldRetreat()), action('retreat', (a) => a.doRetreat())),
  sequence(
    condition((a) => a.target !== null),
    selector(
      sequence(condition((a) => a.wantsCover()), action('cover', (a) => a.doCover())),
      sequence(condition((a) => (a.role === 'flankL' || a.role === 'flankR') && !a.flankDone), action('flank', (a) => a.doFlank())),
      action('engage', (a) => a.doEngage()),
    ),
  ),
  sequence(condition((a) => a.game.time < a.investigateUntil), action('investigate', (a) => a.doInvestigate())),
  sequence(condition((a) => a.findVehicle()), action('board', (a) => a.doBoard())),
  sequence(condition((a) => a.objective() !== null && !a.atObjective()), action('advance', (a) => a.doAdvance())),
  action('patrol', (a) => a.doPatrol()),
);

/**
 * Bot brain. `think()` (≈5 Hz, staggered across agents) runs perception and
 * the behavior tree, which only writes *intent* (goal, fire mode). `update()`
 * (every frame) turns intent into motion, aiming and trigger pulls.
 */
export class AIAgent {
  /**
   * @param {import('../systems/game.js').Game} game
   * @param {import('./soldier.js').Soldier} soldier
   * @param {number} index  index within the team (used for formation slots and pilot duty)
   */
  constructor(game, soldier, index) {
    this.game = game;
    this.s = soldier;
    this.index = index;
    this.canFly = index % 6 === 1;
    this.skill = 0.75 + Math.random() * 0.5;
    this.nav = new NavState();
    this.state = 'patrol';
    this.thinkTimer = Math.random() * AI.thinkInterval;
    /** @type {'assault'|'suppress'|'flankL'|'flankR'} */
    this.role = 'assault';
    this.flankX = 0; this.flankZ = 0; this.flankDone = false;
    this.reset();
  }

  reset() {
    /** @type {any} Soldier or Vehicle */
    this.target = null;
    this.targetVisible = false;
    this.lastSeenX = 0; this.lastSeenY = 0; this.lastSeenZ = 0; this.lastSeenTime = -100;
    this.acquireTime = 0;
    this.suppressLOS = false;
    this.goalX = 0; this.goalZ = 0; this.hasGoal = false; this.sprint = false;
    /** 0 = hold fire, 1 = fire at visible target, 2 = suppress last known position */
    this.fireMode = 0;
    this.burstLeft = 4; this.burstPause = 0;
    this.hasCover = false; this.coverX = 0; this.coverZ = 0; this.coverUntil = 0; this.coverCooldown = 0;
    this.investigateX = 0; this.investigateZ = 0; this.investigateUntil = 0;
    this.underFireUntil = 0;
    this.retreating = false;
    /** @type {import('./vehicle.js').Vehicle|null} */
    this.vehicleGoal = null;
    this.vehicleGoalUntil = 0; this.nextVehicleCheck = 0; this.boardedTime = 0;
    this.driveX = 0; this.driveZ = 0; this.holdVehicle = false; this.heliLand = false; this.wantExit = false;
    this.stuck = 0; this.stuckTotal = 0; this.reverseTimer = 0; this.repath = 0;
    this.strafeUntil = 0; this.patrolUntil = 0;
    this.moveStuck = 0; this.lastX = 0; this.lastZ = 0; this.sidestep = 0; this.sideX = 0; this.sideZ = 0;
    this.scanTick = 0;
    this.nav.clear();
    this.nav.vehicle = false;
  }

  // --- Events -----------------------------------------------------------------

  /** @param {import('./soldier.js').Soldier} attacker */
  onDamaged(attacker) {
    const t = this.game.time;
    this.underFireUntil = t + 3.5;
    if (!this.target && attacker.alive && attacker.team !== this.s.team) {
      // Being shot reveals roughly where the shooter is.
      this.investigateX = attacker.pos.x; this.investigateZ = attacker.pos.z;
      this.investigateUntil = t + 8;
      this.s.yaw = Math.atan2(attacker.pos.x - this.s.pos.x, attacker.pos.z - this.s.pos.z);
    }
  }

  onNoise(x, z) {
    if (this.target || this.s.vehicle) return;
    this.investigateX = x + (Math.random() - 0.5) * 16;
    this.investigateZ = z + (Math.random() - 0.5) * 16;
    this.investigateUntil = this.game.time + 7;
  }

  // --- Perception -------------------------------------------------------------

  /** Can this agent meaningfully hurt `t` with what it carries or crews? */
  canHurt(t) {
    if (t.kind !== 'vehicle') return true;
    const v = this.s.vehicle;
    if (v) {
      for (let i = 0; i < v.def.mounts.length; i++) {
        if (v.def.mounts[i].seat === this.s.seat) return v.weapons[i].def.vsVehicle[t.def.type] > 0;
      }
      return false;
    }
    const launcher = this.s.weapons[1];
    return launcher.ammo + launcher.reserve > 0 || t.def.type !== 'tank';
  }

  _visible(t, dist) {
    const s = this.s, p = t.pos;
    const h = t.kind === 'vehicle' ? 0.6 : 1.3;
    return dist < 3 || this.game.physics.losClear(s.pos.x, s.pos.y + 1.6, s.pos.z, p.x, p.y + h, p.z);
  }

  _perceive() {
    const g = this.game, s = this.s, time = g.time;
    const range = AI.viewRange * (s.vehicle && s.vehicle.def.kind === 'heli' ? 1.7 : 1);
    let t = this.target;
    if (t && (!t.alive || (t.kind === 'soldier' && t.vehicle && t.vehicle.def.type !== 'jeep') || (t.kind === 'vehicle' && (!t.occupied || t.team === s.team)))) {
      t = this.target = null;
    }
    if (t) {
      const d = Math.hypot(t.pos.x - s.pos.x, t.pos.z - s.pos.z);
      this.targetVisible = d < range && this._visible(t, d);
    }
    // Full scan every other tick, or immediately when we have nothing visible.
    if ((this.scanTick++ & 1) === 0 || !t || !this.targetVisible) {
      const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
      let n = 0;
      const consider = (e, bias) => {
        const dx = e.pos.x - s.pos.x, dz = e.pos.z - s.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > range) return;
        // Vision cone, with exceptions for point-blank contacts and enemies revealed by their own gunfire.
        const inCone = d < 14 || (dx * fx + dz * fz) / (d || 1) > AI.fovCos || (e.spotted > 0 && d < 130);
        if (!inCone) return;
        const score = d * bias;
        let k = n < 3 ? n++ : -1;
        if (k < 0) { for (let i = 0; i < 3; i++) if (_candD[i] > score && (k < 0 || _candD[i] > _candD[k])) k = i; if (k < 0) return; }
        _cand[k] = e; _candD[k] = score;
      };
      const soldiers = g.soldiers;
      for (let i = 0; i < soldiers.length; i++) {
        const e = soldiers[i];
        if (e.team === s.team || !e.alive || (e.vehicle && e.vehicle.def.type !== 'jeep')) continue;
        consider(e, 1);
      }
      const vehicles = g.vehicles.list;
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        if (!v.alive || !v.occupied || v.team === s.team || v === s.vehicle || !this.canHurt(v)) continue;
        consider(v, s.vehicle ? 0.6 : 0.85);
      }
      let best = null, bestD = this.targetVisible && t ? Math.hypot(t.pos.x - s.pos.x, t.pos.z - s.pos.z) * 0.8 : 1e9;
      for (let i = 0; i < n; i++) {
        const e = _cand[i];
        _cand[i] = null;
        if (_candD[i] >= bestD || e === t) continue;
        const d = Math.hypot(e.pos.x - s.pos.x, e.pos.z - s.pos.z);
        if (this._visible(e, d)) { best = e; bestD = _candD[i]; }
      }
      if (best) {
        if (best !== this.target) this.acquireTime = time + (0.3 + Math.random() * 0.35) / this.skill;
        t = this.target = best;
        this.targetVisible = true;
        this.flankDone = false;
      }
    }
    const squad = s.squad;
    if (t && this.targetVisible) {
      this.lastSeenX = t.pos.x; this.lastSeenY = t.pos.y; this.lastSeenZ = t.pos.z; this.lastSeenTime = time;
      if (squad) squad.report(t, time);
    } else if (!t && squad && squad.hasFocus(time) && !s.vehicle && this.canHurt(squad.focus)) {
      // Adopt the squad's shared contact even without personal line of sight.
      t = this.target = squad.focus;
      this.targetVisible = false;
      this.lastSeenX = squad.focusX; this.lastSeenY = squad.focusY; this.lastSeenZ = squad.focusZ; this.lastSeenTime = squad.focusTime;
      this.acquireTime = time + 0.3;
    }
    if (t && !this.targetVisible) {
      if (time - this.lastSeenTime > 9) { this.target = null; return; }
      this.suppressLOS = g.physics.losClear(s.pos.x, s.pos.y + 1.6, s.pos.z, this.lastSeenX, this.lastSeenY + 1.2, this.lastSeenZ);
    }
  }

  /** World-space point to shoot at. @param {THREE.Vector3} out */
  aimPoint(out) {
    const t = this.target;
    if (this.fireMode === 2 || !t) return out.set(this.lastSeenX, this.lastSeenY + 1.1, this.lastSeenZ);
    return out.set(t.pos.x, t.pos.y + (t.kind === 'vehicle' ? 0.2 : 1.15), t.pos.z);
  }

  // --- Behaviour leaves --------------------------------------------------------

  objective() { return this.s.squad ? this.s.squad.objective : null; }

  _distTo(x, z) { return Math.hypot(x - this.s.pos.x, z - this.s.pos.z); }

  _go(x, z, sprint) { this.goalX = x; this.goalZ = z; this.hasGoal = true; this.sprint = sprint; }

  atObjective() {
    const o = this.objective();
    return o !== null && this._distTo(o.x, o.z) < CONFIG.match.captureRadius - 3;
  }

  shouldRetreat() {
    const s = this.s, threatened = this.target !== null || this.game.time < this.underFireUntil;
    if (this.retreating) { if (s.health > 68 || !threatened) this.retreating = false; }
    else if (s.health < 36 && threatened) this.retreating = true;
    return this.retreating;
  }

  doRetreat() {
    const s = this.s, flags = this.game.capture.flags;
    let best = null, bestD = 1e9;
    for (const f of flags) {
      if (f.owner !== s.team) continue;
      const d = this._distTo(f.x, f.z);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (best && bestD > 10) this._go(best.x, best.z, true);
    else {
      // No friendly ground nearby: break contact directly away from the threat.
      const dx = s.pos.x - this.lastSeenX, dz = s.pos.z - this.lastSeenZ, len = Math.hypot(dx, dz) || 1;
      this._go(s.pos.x + (dx / len) * 25, s.pos.z + (dz / len) * 25, true);
    }
    this.fireMode = this.targetVisible && this._distTo(this.lastSeenX, this.lastSeenZ) < 25 ? 1 : 0;
  }

  wantsCover() {
    const g = this.game, s = this.s;
    if (g.time < this.coverCooldown) return false;
    if (this.hasCover && g.time < this.coverUntil) return true;
    return (g.time < this.underFireUntil || s.weapon.reloading) && s.health < 90 && this._distTo(this.lastSeenX, this.lastSeenZ) > 14;
  }

  /** Picks the nearest solid prop and the spot behind it relative to the threat. */
  _findCover() {
    const g = this.game, s = this.s;
    let best = 1e9;
    this.hasCover = false;
    for (let q = 0; q < 5; q++) {
      const ox = q === 1 ? 14 : q === 2 ? -14 : 0, oz = q === 3 ? 14 : q === 4 ? -14 : 0;
      const list = g.physics.propsNear(s.pos.x + ox, s.pos.z + oz);
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p.alive || p.type === 'tree' || p.type === 'crate' || (p.type === 'rock' && p.r < 1.1)) continue;
        let dx = p.x - this.lastSeenX, dz = p.z - this.lastSeenZ;
        const len = Math.hypot(dx, dz) || 1;
        if (len < 10) continue;
        dx /= len; dz /= len;
        const off = (p.r || p.hz) + 1.0;
        const cx = p.x + dx * off, cz = p.z + dz * off;
        const d = this._distTo(cx, cz);
        if (d < best && d < 24 && !g.nav.blocked(cx, cz)) { best = d; this.coverX = cx; this.coverZ = cz; this.hasCover = true; }
      }
    }
    return this.hasCover;
  }

  doCover() {
    const g = this.game;
    if (!this.hasCover || g.time >= this.coverUntil) {
      if (!this._findCover()) { this.coverCooldown = g.time + 4; return Status.FAILURE; }
      this.coverUntil = g.time + 4.5 + Math.random() * 2;
    }
    const d = this._distTo(this.coverX, this.coverZ);
    if (d > 0.8) this._go(this.coverX, this.coverZ, d > 4);
    else this.hasGoal = false;
    this.fireMode = this.targetVisible ? 1 : 0;
    if (g.time > this.coverUntil - 0.3) { this.hasCover = false; this.coverCooldown = g.time + 5; }
    return Status.RUNNING;
  }

  doFlank() {
    const d = this._distTo(this.flankX, this.flankZ);
    if (d < 4 || this.game.nav.blocked(this.flankX, this.flankZ) || (this.targetVisible && this._distTo(this.lastSeenX, this.lastSeenZ) < 40)) {
      this.flankDone = true;
      return Status.FAILURE;
    }
    this._go(this.flankX, this.flankZ, true);
    this.fireMode = this.targetVisible ? 1 : 0;
    return Status.RUNNING;
  }

  doEngage() {
    const g = this.game, s = this.s, time = g.time;
    const dist = this._distTo(this.lastSeenX, this.lastSeenZ);
    if (this.targetVisible) {
      this.fireMode = 1;
      if (dist > 120) this._go(this.lastSeenX, this.lastSeenZ, false);
      else if (time > this.strafeUntil) {
        // Short lateral shuffles make bots harder to hit without breaking their firing line.
        this.strafeUntil = time + 1.2 + Math.random() * 1.5;
        const side = Math.random() < 0.5 ? 1 : -1, step = 2.5 + Math.random() * 3;
        const dx = (this.lastSeenX - s.pos.x) / (dist || 1), dz = (this.lastSeenZ - s.pos.z) / (dist || 1);
        const x = s.pos.x - dz * side * step, z = s.pos.z + dx * side * step;
        if (Math.random() < 0.65 && !g.nav.blocked(x, z)) this._go(x, z, false);
        else this.hasGoal = false;
      }
    } else if (this.role === 'suppress' && this.suppressLOS && time - this.lastSeenTime < 3.5) {
      this.fireMode = 2;
      this.hasGoal = false;
    } else {
      // Lost sight: push to the last known position.
      this.fireMode = 0;
      if (dist < 5) { this.target = null; return Status.FAILURE; }
      this._go(this.lastSeenX, this.lastSeenZ, dist > 30);
    }
    return Status.RUNNING;
  }

  doInvestigate() {
    if (this._distTo(this.investigateX, this.investigateZ) < 7) { this.investigateUntil = 0; return Status.FAILURE; }
    this._go(this.investigateX, this.investigateZ, false);
    this.fireMode = 0;
    return Status.RUNNING;
  }

  /** Decides whether an idle vehicle nearby is worth taking. */
  findVehicle() {
    const g = this.game, s = this.s, time = g.time;
    const cur = this.vehicleGoal;
    if (cur) {
      if (cur.boardableBy(s.team) && time < this.vehicleGoalUntil) return true;
      this.vehicleGoal = null;
    }
    if (time < this.nextVehicleCheck) return false;
    this.nextVehicleCheck = time + 1.5 + Math.random();
    const o = this.objective();
    const far = o !== null && this._distTo(o.x, o.z) > 150;
    const v = g.vehicles.nearestBoardable(s.pos, s.team, 62, (veh) => {
      const type = veh.def.type, driver = veh.driver;
      if (driver && driver.isPlayer && this._distTo(veh.pos.x, veh.pos.z) > 16) return false;
      if (type === 'heli') return driver ? !driver.isPlayer || Math.abs(veh.speed) < 1 : this.canFly;
      if (type === 'jeep') return far || (driver !== null && driver.isPlayer);
      return true;
    });
    if (!v) return false;
    this.vehicleGoal = v;
    this.vehicleGoalUntil = time + 18;
    return true;
  }

  doBoard() {
    const v = /** @type {import('./vehicle.js').Vehicle} */ (this.vehicleGoal);
    if (this._distTo(v.pos.x, v.pos.z) < v.def.half[0] + 3.2) {
      this.vehicleGoal = null;
      if (v.enter(this.s) >= 0) {
        this.boardedTime = this.game.time;
        this.stuck = 0; this.stuckTotal = 0; this.wantExit = false; this.heliLand = false;
        this.nav.clear(); this.nav.vehicle = false;
        this.hasGoal = false;
      }
      return Status.SUCCESS;
    }
    this._go(v.pos.x, v.pos.z, true);
    this.fireMode = 0;
    return Status.RUNNING;
  }

  doAdvance() {
    const o = /** @type {NonNullable<ReturnType<AIAgent['objective']>>} */ (this.objective());
    // Fan out around the flag instead of stacking on the pole.
    const a = this.index * 2.4, r = 4 + (this.index % 4) * 2.2;
    const d = this._distTo(o.x, o.z);
    this._go(o.x + Math.cos(a) * r, o.z + Math.sin(a) * r, d > 26);
    this.fireMode = 0;
  }

  doPatrol() {
    const g = this.game, o = this.objective();
    this.fireMode = 0;
    if (!o) { this.hasGoal = false; return; }
    if (g.time > this.patrolUntil || (this.hasGoal && this._distTo(this.goalX, this.goalZ) < 1.2)) {
      this.patrolUntil = g.time + 4 + Math.random() * 5;
      const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * (CONFIG.match.captureRadius - 5);
      const x = o.x + Math.cos(a) * r, z = o.z + Math.sin(a) * r;
      if (!g.nav.blocked(x, z)) this._go(x, z, false);
      else this.hasGoal = false;
    }
  }

  /** Crew logic: where to drive, when to hold, when to bail out. */
  thinkVehicle() {
    const g = this.game, s = this.s;
    const v = /** @type {import('./vehicle.js').Vehicle} */ (s.vehicle);
    const def = v.def, time = g.time;
    const critical = v.health < def.health * 0.28;
    const o = this.objective();
    const driver = v.driver;
    this.hasGoal = false;

    if (def.kind === 'heli') {
      const agl = v.pos.y - g.map.terrain.height(v.pos.x, v.pos.z) - def.half[1];
      if (s.seat === 0) {
        this.heliLand = critical;
        if (o) { this.driveX = o.x; this.driveZ = o.z; }
        if (this.wantExit && agl < 2) this._bailAll(v);
      } else if (agl < 2 && (!driver || critical)) v.exit(s);
      return;
    }
    if (critical || this.stuckTotal > 4) { this._bailAll(v); return; }
    if (s.seat !== 0) {
      if (!driver) {
        // Slide over and take the wheel rather than sit in a parked vehicle.
        if (time - this.boardedTime > 2.5) { v.exit(s); v.enter(s); this.boardedTime = time; }
      } else if (driver.isPlayer && def.type === 'jeep' && Math.abs(v.speed) < 1.5 && o && this._distTo(o.x, o.z) < 45) v.exit(s);
      return;
    }
    if (!o) { this.holdVehicle = true; return; }
    const dist = Math.hypot(o.x - v.pos.x, o.z - v.pos.z);
    // Park short of the flag on the approach side.
    const k = Math.min(1, 16 / (dist || 1));
    this.driveX = o.x + (v.pos.x - o.x) * k; this.driveZ = o.z + (v.pos.z - o.z) * k;
    if (def.type === 'jeep') {
      const waiting = time - this.boardedTime < 3.5 && v.hasFreeSeat();
      this.holdVehicle = waiting;
      if (dist < 38 && Math.abs(v.speed) < 6) this._bailAll(v);
    } else {
      const t = this.target;
      const engaging = t !== null && this.targetVisible && this._distTo(t.pos.x, t.pos.z) < 170;
      this.holdVehicle = dist < 26 || engaging;
    }
  }

  /** Orders every bot aboard to dismount (the human player decides for themselves). */
  _bailAll(v) {
    for (let i = 0; i < v.seats.length; i++) {
      const occ = v.seats[i];
      if (occ && occ.ai) { v.exit(occ); occ.ai.nav.clear(); occ.ai.nav.vehicle = false; occ.ai.nextVehicleCheck = this.game.time + 12; }
    }
    v.controls.throttle = 0; v.controls.brake = true;
  }

  think() {
    this._perceive();
    TREE.tick(this);
  }

  // --- Per-frame execution ----------------------------------------------------------

  /** @param {number} dt */
  update(dt) {
    const s = this.s, g = this.game;
    if (!s.alive) return;
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = AI.thinkInterval * (0.85 + Math.random() * 0.3);
      this.think();
      if (!s.alive) return;
    }
    const v = s.vehicle;
    if (v) {
      s.moveX = s.moveZ = 0;
      if (s.seat === 0) {
        if (v.def.kind === 'heli') flyHeli(this, v, dt);
        else driveGround(this, v, dt);
      }
      operateMount(this, v, dt);
      s.yaw = v.aimYaw[s.seat];
      return;
    }
    this._move(dt);
    this._aimAndFire(dt);
  }

  _move(dt) {
    const s = this.s, g = this.game, nav = this.nav;
    let mx = 0, mz = 0;
    if (this.hasGoal) {
      this.repath -= dt;
      const direct = this._distTo(this.goalX, this.goalZ);
      const stale = Math.hypot(nav.tx - this.goalX, nav.tz - this.goalZ) > 3.5 || nav.vehicle;
      if ((stale || (nav.done && direct > 6)) && !nav.pending && this.repath <= 0) {
        g.nav.request(nav, s.pos.x, s.pos.z, this.goalX, this.goalZ, false);
        this.repath = 0.7 + Math.random() * 0.5;
      }
      let tx = this.goalX, tz = this.goalZ, have = direct < 6 && direct > 0.5;
      if (!nav.done && !stale) {
        tx = nav.path[nav.idx * 2]; tz = nav.path[nav.idx * 2 + 1];
        if (this._distTo(tx, tz) < 1.4) nav.idx++;
        have = true;
      }
      if (have) {
        const dx = tx - s.pos.x, dz = tz - s.pos.z, len = Math.hypot(dx, dz) || 1;
        const speed = this.sprint ? CONFIG.soldier.sprintSpeed : CONFIG.soldier.walkSpeed;
        mx = (dx / len) * speed; mz = (dz / len) * speed;
        // Stuck detection: if we barely moved, shuffle sideways and re-plan.
        this.moveStuck += dt;
        if (this.moveStuck > 1.1) {
          if (Math.hypot(s.pos.x - this.lastX, s.pos.z - this.lastZ) < 0.6) {
            this.sidestep = 0.6;
            const side = Math.random() < 0.5 ? 1 : -1;
            this.sideX = -mz * side; this.sideZ = mx * side;
            nav.len = 0;
          }
          this.moveStuck = 0; this.lastX = s.pos.x; this.lastZ = s.pos.z;
        }
      }
    }
    if (this.sidestep > 0) { this.sidestep -= dt; mx = this.sideX; mz = this.sideZ; }
    s.moveX = mx; s.moveZ = mz;
  }

  _aimAndFire(dt) {
    const s = this.s, g = this.game;
    const t = this.target;
    let wantYaw = s.yaw, wantPitch = 0, firing = false;
    if (t && (this.fireMode !== 0 || this.targetVisible)) {
      // Pick the right tool: launcher for armour (and distant vehicles), rifle otherwise.
      const launcher = s.weapons[1];
      const useLauncher = t.kind === 'vehicle' && this.fireMode === 1 && launcher.ammo + launcher.reserve > 0 &&
        (t.def.type !== 'heli' || this._distTo(t.pos.x, t.pos.z) < 120);
      s.weaponIdx = useLauncher ? 1 : 0;
      const def = s.weapon.def;
      s.eye(_eye);
      this.aimPoint(_aim);
      let dx = _aim.x - _eye.x, dy = _aim.y - _eye.y, dz = _aim.z - _eye.z;
      const flat = Math.hypot(dx, dz), dist = Math.hypot(flat, dy);
      if (def.type === 'projectile') {
        const tof = dist / /** @type {number} */ (def.speed);
        dy += 0.5 * /** @type {number} */ (def.gravity) * tof * tof;
      }
      wantYaw = Math.atan2(dx, dz);
      wantPitch = Math.atan2(dy, flat);
      const canShoot = this.fireMode === 2 || (this.targetVisible && (t.kind !== 'vehicle' || def.vsVehicle[t.def.type] > 0));
      firing = this.fireMode !== 0 && canShoot && dist < def.range && g.time >= this.acquireTime &&
        Math.abs(angleDelta(s.yaw, wantYaw)) < 0.09;
      if (firing) {
        if (this.burstPause > 0) this.burstPause -= dt;
        else {
          const inv = 1 / Math.hypot(dx, dy, dz);
          _dir.set(dx * inv, dy * inv, dz * inv);
          // Accuracy degrades with range, movement and suppression fire; skill tightens it.
          const spread = (2.6 + dist / 45 + (s.speed > 1 ? 1.6 : 0) + (this.fireMode === 2 ? 3 : 0)) / this.skill;
          if (g.combat.fire(s, s.weapon, _eye, _dir, def.type === 'projectile' ? 2 : spread) && --this.burstLeft <= 0) {
            this.burstPause = 0.3 + Math.random() * 0.75;
            this.burstLeft = 3 + ((Math.random() * 5) | 0);
          }
        }
      }
    } else {
      s.weaponIdx = 0;
      if (s.speed > 0.5) wantYaw = Math.atan2(s.moveX, s.moveZ);
    }
    s.yaw = turnToward(s.yaw, wantYaw, 7.5 * dt);
    s.pitch += clamp(wantPitch - s.pitch, -3 * dt, 3 * dt);
  }
}
