import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { WeaponState } from './weapons.js';

const S = CONFIG.soldier;
const PARACHUTE_FALL = 5.5;
const SAFE_FALL = 13;
const _seat = new THREE.Vector3();

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
    this.vehicle = null; this.seat = -1;
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
      const seat = v.def.seats[this.seat].pos;
      _seat.set(seat[0], seat[1], seat[2]).applyQuaternion(v.quat);
      this.pos.set(v.pos.x + _seat.x, v.pos.y + _seat.y, v.pos.z + _seat.z);
      this.speed = 0;
      this.grounded = true;
      this.parachute = false;
      return 0;
    }

    const pos = this.pos;
    const ground0 = terrain.height(pos.x, pos.z);
    let nx = pos.x + this.moveX * dt, nz = pos.z + this.moveZ * dt;
    const step = Math.hypot(nx - pos.x, nz - pos.z);
    if (step > 1e-5 && this.grounded) {
      const h1 = terrain.height(nx, nz);
      // Refuse cliffs and deep water; everything else is walkable.
      if ((h1 - ground0) / step > 1.25 || h1 < CONFIG.world.waterLevel - 1.1) { nx = pos.x; nz = pos.z; }
    }
    const lim = terrain.half - 8;
    pos.x = Math.max(-lim, Math.min(lim, nx));
    pos.z = Math.max(-lim, Math.min(lim, nz));
    if (this.grounded || pos.y - ground0 < 3) physics.pushOut(pos, S.radius);

    const ground = terrain.height(pos.x, pos.z);
    let damage = 0;
    if (!this.grounded || pos.y > ground + 0.35) {
      this.velY -= S.gravity * dt;
      if (this.parachute) this.velY = Math.max(this.velY, -PARACHUTE_FALL);
      pos.y += this.velY * dt;
      this.grounded = false;
      if (pos.y <= ground) {
        if (this.velY < -SAFE_FALL) damage = (-this.velY - SAFE_FALL) * 12;
        pos.y = ground; this.velY = 0; this.grounded = true; this.parachute = false;
      }
    } else pos.y = ground;

    this.speed = Math.hypot(this.moveX, this.moveZ);
    this.walkPhase += this.speed * dt * 2.1;
    return damage;
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
    this.vehicle = null; this.seat = -1; this.velY = 0; this.grounded = false; this.parachute = false;
    d.w.forEach((a, i) => {
      const ws = this.weapons[i];
      if (!ws) return;
      ws.ammo = a[0]; ws.reserve = a[1] < 0 ? Infinity : a[1]; ws.reloadTimer = 0;
    });
  }
}
