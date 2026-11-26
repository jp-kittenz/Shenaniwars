import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { WeaponState } from './weapons.js';

const S = CONFIG.soldier;
const PARACHUTE_FALL = 5.5;
/** Controlled slide speed down a fast-rope. */
const RAPPEL_FALL = 6;
const SAFE_FALL = 13;
const _seat = new THREE.Vector3();

let _onStructure = false;
/**
 * Ground under a soldier: the terrain (bridges excluded) or the highest
 * building floor, stair, roof or deck he can stand on from height `y`.
 * Sets `_onStructure` when a structure surface wins.
 */
function groundAt(terrain, st, x, z, y) {
  let h = terrain.baseHeight(x, z);
  _onStructure = false;
  // A parked cargo aircraft's ramp and hold floor (deck surfaces): stood on when within a step of his feet (from
  // the ramp's lip up, not from under the belly).
  if (terrain.decks.length) {
    const d = terrain.deckAt(x, z);
    if (d && d.group !== undefined) {
      const dy = d.y0 + (d.y1 - d.y0) * (((x - d.x) * d.s + (z - d.z) * d.c) / d.hl * 0.5 + 0.5);
      if (dy > h && dy <= y + 0.6) h = dy;
    }
  }
  if (!st) return h;
  const s = st.surface(x, z, y);
  if (s > h) { _onStructure = true; return s; }
  return h;
}

/**
 * An infantry unit: the human player and every bot share this class. Soldiers
 * are kinematic (terrain-following with prop push-out) rather than rigid
 * bodies, which keeps two hundred of them cheaper than a handful of vehicles.
 */
export class Soldier {
  /**
   * @param {number} id @param {number} team @param {boolean} isPlayer
   * @param {string[]} loadout weapon ids, rifle first
   */
  constructor(id, team, isPlayer, loadout) {
    this.id = id;
    this.kind = 'soldier';
    this.team = team;
    this.isPlayer = isPlayer;
    this.name = isPlayer ? 'YOU' : `${CONFIG.teams[team].name[0]}-${String(id).padStart(3, '0')}`;
    /** Feet position (seat surface while riding). */
    this.pos = new THREE.Vector3();
    this.velY = 0;
    this.yaw = 0;
    this.pitch = 0;
    /** Desired planar velocity for this frame (m/s, world space). */
    this.moveX = 0;
    this.moveZ = 0;
    this.speed = 0;
    this.walkPhase = 0;
    this.grounded = true;
    this.sprinting = false;
    /** Combat posture (weapon shouldered); relaxed soldiers carry at low ready. */
    this.alert = false;
    this.parachute = false;
    /** Sliding down a fast-rope from a hovering helicopter. */
    this.rappel = false;
    this.health = S.health;
    this.alive = false;
    this.respawnTimer = 0;
    this.lastDamageTime = -100;
    /** @type {Soldier|null} */
    this.lastAttacker = null;
    this.setLoadout(loadout);
    /** @type {import('./vehicle.js').Vehicle|null} */
    this.vehicle = null;
    this.seat = -1;
    /** Climbing into / out of a vehicle: remaining time, duration, start and end points, direction. */
    this.transT = 0; this.transDur = 0; this.transOut = false;
    /** Seconds to wait at the troop door before climbing in / out (door opening, the man ahead). */
    this.transWait = 0;
    this.transFrom = new THREE.Vector3(); this.transTo = new THREE.Vector3();
    /**
     * Walked route of the transition (troop door / ramp): world points [x, y, z, ...] from where he stands to the
     * seat (in) or from the seat to where he steps off (out); null for the short climb straight in / out.
     * @type {number[]|null}
     */
    this.transPath = null;
    /** Queued dismount: still seated until this time (his turn at the door), then out over `exitDur` seconds. */
    this.exitAt = 0; this.exitDur = 0; this.exitUrgent = false;
    this.kills = 0;
    this.deaths = 0;
    /** Seconds the unit stays revealed on the enemy minimap after firing. */
    this.spotted = 0;
    this.muzzleFlash = 0;
    /** Bone-texture row (assigned by the renderer). */
    this.row = 0;
    /** Set while the renderer snapshots a standing pose for a ragdoll. */
    this.ragdollPose = false;
    /** @type {import('./ai-agent.js').AIAgent|null} */
    this.ai = null;
    /** Squad blackboard (src/ai/squad-convoy.ts). @type {any} */
    this.squad = null;
    /** 0 stand, 1 crouch, 2 prone (bots; changes hitboxes, eye height and speed). */
    this.stance = 0;
    /** Soldier class (src/ai/types.ts SoldierClass): drives loadout, seat affinity and squad role. */
    this.cls = 1;
  }

  /** @param {string[]} loadout */
  setLoadout(loadout) {
    this.weapons = loadout.map((id) => new WeaponState(id));
    this.weaponIdx = 0;
    /** @type {WeaponState} */
    this.rifle = this.weapons[0];
    /** @type {WeaponState|null} */
    this.launcher = this.weapons.find((w) => w.def.slot === 'launcher') || null;
  }

  get weapon() { return this.weapons[this.weaponIdx]; }

  /** Eye position (accounts for vehicle seating). @param {THREE.Vector3} out */
  eye(out) {
    if (this.vehicle) return out.set(this.pos.x, this.pos.y + 0.9, this.pos.z);
    if (this.stance === 2) return out.set(this.pos.x + Math.sin(this.yaw) * 0.6, this.pos.y + 0.42, this.pos.z + Math.cos(this.yaw) * 0.6);
    return out.set(this.pos.x, this.pos.y + (this.stance === 1 ? S.eyeHeight - 0.45 : S.eyeHeight), this.pos.z);
  }

  /** Unit aim direction from yaw/pitch. @param {THREE.Vector3} out */
  aimDir(out) {
    const cp = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  spawn(x, y, z, yaw) {
    this.pos.set(x, y, z);
    this.velY = 0; this.yaw = yaw; this.pitch = 0;
    this.moveX = this.moveZ = 0;
    this.health = S.health;
    this.alive = true;
    this.grounded = true;
    this.parachute = false;
    this.rappel = false;
    this.vehicle = null; this.seat = -1; this.transT = 0; this.transOut = false; this.transPath = null; this.exitAt = 0;
    this.stance = 0;
    this.weaponIdx = 0;
    for (const w of this.weapons) w.refill();
    this.lastAttacker = null;
    this.spotted = 0;
  }

  jump() {
    if (this.grounded && !this.vehicle) { this.velY = S.jumpSpeed; this.grounded = false; }
  }

  /**
   * Integrates one frame of movement.
   * @param {number} dt @param {number} time
   * @param {import('../world/terrain.js').Terrain} terrain
   * @param {import('../systems/physics.js').PhysicsSystem} physics
   * @returns {number} fall damage taken this frame (0 normally)
   */
  update(dt, time, terrain, physics) {
    if (!this.alive) return 0;
    if (this.spotted > 0) this.spotted -= dt;
    if (this.muzzleFlash > 0) this.muzzleFlash -= dt;
    if (this.health < S.health && time - this.lastDamageTime > S.regenDelay) {
      this.health = Math.min(S.health, this.health + S.regenRate * dt);
    }
    for (let i = 0; i < this.weapons.length; i++) this.weapons[i].update(i === this.weaponIdx ? dt : 0);

    const v = this.vehicle;
    if (v) {
      v.seatWorld(this.seat, _seat);
      if (this.transT > 0 && !this.transOut && this.transWait > 0) {
        // At the troop door, waiting for it to open (or for the man ahead to get in).
        this.transWait -= dt; this.pos.copy(this.transFrom);
      } else if (this.transT > 0 && !this.transOut && this.transPath) {
        // Walking in: up the ramp / through the troop door, down the aisle to his seat (the route ends at the seat).
        this.transT = Math.max(0, this.transT - dt);
        const P = this.transPath, n = P.length;
        P[n - 3] = _seat.x; P[n - 2] = _seat.y; P[n - 1] = _seat.z;
        this._walkPath(1 - this.transT / this.transDur, dt);
        if (this.transT === 0) this.transPath = null;
        return 0;
      } else if (this.transT > 0 && !this.transOut) {
        // Climbing in: from where he stood to the seat, with a step up.
        this.transT = Math.max(0, this.transT - dt);
        const k = 1 - this.transT / this.transDur, e = k * k * (3 - 2 * k);
        this.pos.lerpVectors(this.transFrom, _seat, e);
        this.pos.y += Math.sin(k * Math.PI) * 0.35;
      } else { this.transT = 0; this.transPath = null; this.pos.copy(_seat); }
      this.speed = 0;
      this.grounded = true;
      this.parachute = false;
      return 0;
    }
    if (this.transT > 0 && this.transOut && this.transWait > 0) {
      // Waiting in the compartment for the troop door to open (or for the man ahead to get out).
      this.transWait -= dt; this.speed = 0; return 0;
    }
    if (this.transT > 0 && this.transOut && this.transPath) {
      // Walking out: down the aisle, out of the troop door / down the ramp, to where he steps off.
      this.transT = Math.max(0, this.transT - dt);
      this._walkPath(1 - this.transT / this.transDur, dt);
      if (this.transT === 0) { const P = this.transPath; this.pos.set(P[P.length - 3], P[P.length - 2], P[P.length - 1]); this.transPath = null; this.transOut = false; this.speed = 0; }
      return 0;
    }
    if (this.transT > 0 && this.transOut) {
      // Climbing out: from the seat down to the ground beside the vehicle (no walking meanwhile).
      this.transT = Math.max(0, this.transT - dt);
      const k = 1 - this.transT / this.transDur, e = k * k * (3 - 2 * k);
      this.pos.lerpVectors(this.transFrom, this.transTo, e);
      this.pos.y += Math.sin(k * Math.PI) * 0.25;
      this.speed = 0;
      if (this.transT === 0) { this.pos.copy(this.transTo); this.transOut = false; }
      return 0;
    }

    const pos = this.pos, st = physics.structures;
    const ground0 = groundAt(terrain, st, pos.x, pos.z, pos.y);
    // On the rope the soldier slides straight down; under a canopy he steers.
    let nx = this.rappel ? pos.x : pos.x + this.moveX * dt, nz = this.rappel ? pos.z : pos.z + this.moveZ * dt;
    const step = Math.hypot(nx - pos.x, nz - pos.z);
    if (step > 1e-5 && this.grounded) {
      const h1 = groundAt(terrain, st, nx, nz, pos.y);
      // Refuse terrain cliffs and deep water (stairs, ladders and floors are fine); everything else is walkable.
      if ((!_onStructure && (h1 - ground0) / step > 1.25) || h1 < CONFIG.world.waterLevel - 1.1) { nx = pos.x; nz = pos.z; }
    }
    // Inside a parked aircraft's hold the walls hold the player in: he leaves only down the ramp, off its lip.
    if (this.isPlayer && step > 1e-5 && terrain.deckAt) {
      const d0 = terrain.deckAt(pos.x, pos.z);
      if (d0 && d0.group !== undefined && pos.y > d0.y0 - 0.5) {
        const ok = (x, z) => {
          const d1 = terrain.deckAt(x, z);
          if (d1 && d1.group === d0.group) return true;
          const lz = (x - d0.x) * d0.s + (z - d0.z) * d0.c, lx = (x - d0.x) * d0.c - (z - d0.z) * d0.s;
          return d0.kind === 'ramp' && lz < -d0.hl + 0.5 && Math.abs(lx) < d0.hw + 0.3;
        };
        // (blocked: slide along the wall)
        if (!ok(nx, nz)) { if (ok(nx, pos.z)) nz = pos.z; else if (ok(pos.x, nz)) nx = pos.x; else { nx = pos.x; nz = pos.z; } }
      }
    }
    const lim = terrain.half - 8;
    pos.x = Math.max(-lim, Math.min(lim, nx));
    pos.z = Math.max(-lim, Math.min(lim, nz));
    if (this.grounded || pos.y - ground0 < 3) physics.pushOut(pos, S.radius);
    if (st) st.pushOut(pos, S.radius);

    const ground = groundAt(terrain, st, pos.x, pos.z, pos.y);
    let damage = 0;
    if (!this.grounded || pos.y > ground + 0.35) {
      this.velY -= S.gravity * dt;
      if (this.parachute) this.velY = Math.max(this.velY, -PARACHUTE_FALL);
      if (this.rappel) this.velY = Math.max(this.velY, -RAPPEL_FALL);
      pos.y += this.velY * dt;
      this.grounded = false;
      if (pos.y <= ground) {
        if (this.velY < -SAFE_FALL) damage = (-this.velY - SAFE_FALL) * 12;
        pos.y = ground; this.velY = 0; this.grounded = true; this.parachute = false; this.rappel = false;
      }
    } else pos.y = ground;

    this.speed = Math.hypot(this.moveX, this.moveZ);
    this.walkPhase += this.speed * dt * 2.1;
    return damage;
  }

  /** Position along the walked transition route at fraction k (0..1), walking pose and heading along it. */
  _walkPath(k, dt) {
    const P = this.transPath, n = P.length / 3;
    let len = 0;
    for (let i = 1; i < n; i++) len += Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 1] - P[i * 3 - 2], P[i * 3 + 2] - P[i * 3 - 1]);
    let d = Math.max(0, Math.min(1, k)) * len;
    for (let i = 1; i < n; i++) {
      const ax = P[i * 3 - 3], ay = P[i * 3 - 2], az = P[i * 3 - 1], bx = P[i * 3], by = P[i * 3 + 1], bz = P[i * 3 + 2];
      const sl = Math.hypot(bx - ax, by - ay, bz - az);
      if (d <= sl || i === n - 1) {
        const t = sl > 1e-4 ? Math.min(1, d / sl) : 1;
        this.pos.set(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
        if (Math.hypot(bx - ax, bz - az) > 0.05) this.yaw = Math.atan2(bx - ax, bz - az);
        break;
      }
      d -= sl;
    }
    this.speed = this.transDur > 0 ? len / this.transDur : 0;
    this.moveX = Math.sin(this.yaw) * this.speed; this.moveZ = Math.cos(this.yaw) * this.speed;
    this.walkPhase += this.speed * dt * 2.1;
    this.grounded = true; this.velY = 0;
  }

  serialize() {
    const w = this.weapons;
    return {
      p: [this.pos.x, this.pos.y, this.pos.z], yaw: this.yaw, hp: this.health, alive: this.alive, rt: this.respawnTimer,
      k: this.kills, d: this.deaths, w: w.map((s) => [s.ammo, s.reserve === Infinity ? -1 : s.reserve]),
    };
  }

  deserialize(d) {
    this.pos.fromArray(d.p);
    this.yaw = d.yaw; this.health = d.hp; this.alive = d.alive; this.respawnTimer = d.rt;
    this.kills = d.k; this.deaths = d.d;
    this.vehicle = null; this.seat = -1; this.velY = 0; this.grounded = false; this.parachute = false; this.rappel = false; this.transT = 0; this.transOut = false;
    d.w.forEach((a, i) => {
      const ws = this.weapons[i];
      if (!ws) return;
      ws.ammo = a[0]; ws.reserve = a[1] < 0 ? Infinity : a[1]; ws.reloadTimer = 0;
    });
  }
}
