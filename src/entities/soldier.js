import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { WeaponState } from './weapons.js';

const S = CONFIG.soldier;
const _v = new THREE.Vector3();

/**
 * An infantry unit: the human player and every bot share this class. Soldiers
 * are kinematic (terrain-following with prop push-out) rather than rigid
 * bodies, which keeps forty of them cheaper than a single vehicle.
 */
export class Soldier {
  /** @param {number} id @param {number} team @param {boolean} isPlayer */
  constructor(id, team, isPlayer) {
    this.id = id;
    this.kind = 'soldier';
    this.team = team;
    this.isPlayer = isPlayer;
    this.name = isPlayer ? 'YOU' : `${CONFIG.teams[team].name[0]}-${String(id).padStart(2, '0')}`;
    /** Feet position. */
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
    this.health = S.health;
    this.alive = false;
    this.respawnTimer = 0;
    this.lastDamageTime = -100;
    /** @type {Soldier|null} */
    this.lastAttacker = null;
    this.weapons = [new WeaponState('rifle'), new WeaponState('launcher')];
    this.weaponIdx = 0;
    /** @type {import('./vehicle.js').Vehicle|null} */
    this.vehicle = null;
    this.seat = -1;
    this.kills = 0;
    this.deaths = 0;
    /** Seconds the unit stays revealed on the enemy minimap after firing. */
    this.spotted = 0;
    this.muzzleFlash = 0;
    /** @type {import('./ai-agent.js').AIAgent|null} */
    this.ai = null;
    /** @type {import('../systems/squad.js').Squad|null} */
    this.squad = null;
  }

  get weapon() { return this.weapons[this.weaponIdx]; }

  /** Eye position (accounts for vehicle seating). @param {THREE.Vector3} out */
  eye(out) {
    return out.set(this.pos.x, this.pos.y + S.eyeHeight, this.pos.z);
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
    this.vehicle = null; this.seat = -1;
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
   */
  update(dt, time, terrain, physics) {
    if (!this.alive) return;
    if (this.spotted > 0) this.spotted -= dt;
    if (this.muzzleFlash > 0) this.muzzleFlash -= dt;
    if (this.health < S.health && time - this.lastDamageTime > S.regenDelay) {
      this.health = Math.min(S.health, this.health + S.regenRate * dt);
    }
    for (let i = 0; i < this.weapons.length; i++) this.weapons[i].update(i === this.weaponIdx ? dt : 0);

    const v = this.vehicle;
    if (v) {
      const seat = v.def.seats[this.seat].pos;
      _v.set(seat[0], seat[1] - 1.0, seat[2]).applyQuaternion(v.quat);
      this.pos.set(v.pos.x + _v.x, v.pos.y + _v.y, v.pos.z + _v.z);
      this.speed = 0;
      return;
    }

    const p = this.pos;
    let nx = p.x + this.moveX * dt, nz = p.z + this.moveZ * dt;
    const ground0 = terrain.height(p.x, p.z);
    const step = Math.hypot(nx - p.x, nz - p.z);
    if (step > 1e-5) {
      const h1 = terrain.height(nx, nz);
      // Refuse cliffs and deep water; everything else is walkable.
      if ((this.grounded && (h1 - ground0) / step > 1.25) || h1 < CONFIG.world.waterLevel - 1.1) { nx = p.x; nz = p.z; }
    }
    const lim = terrain.half - 8;
    p.x = Math.max(-lim, Math.min(lim, nx));
    p.z = Math.max(-lim, Math.min(lim, nz));
    physics.pushOut(p, S.radius);

    const ground = terrain.height(p.x, p.z);
    if (!this.grounded || p.y > ground + 0.35) {
      this.velY -= S.gravity * dt;
      p.y += this.velY * dt;
      this.grounded = false;
      if (p.y <= ground) { p.y = ground; this.velY = 0; this.grounded = true; }
    } else p.y = ground;

    this.speed = Math.hypot(this.moveX, this.moveZ);
    this.walkPhase += this.speed * dt * 2.4;
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
    this.vehicle = null; this.seat = -1; this.velY = 0; this.grounded = false;
    d.w.forEach((a, i) => { this.weapons[i].ammo = a[0]; this.weapons[i].reserve = a[1] < 0 ? Infinity : a[1]; this.weapons[i].reloadTimer = 0; });
  }
}
