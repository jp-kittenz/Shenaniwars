import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { Pool } from '../core/pool.js';
import { MASK_SHOT } from './physics.js';

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const PROJECTILES = 32;

/** Ray vs sphere; returns entry distance or -1. */
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const t = lx * dx + ly * dy + lz * dz;
  if (t < 0) return -1;
  const d2 = lx * lx + ly * ly + lz * lz - t * t;
  if (d2 > r * r) return -1;
  return t - Math.sqrt(r * r - d2);
}

/**
 * @typedef {Object} Projectile
 * @property {number} slot
 * @property {THREE.Vector3} pos @property {THREE.Vector3} vel
 * @property {number} life
 * @property {import('../entities/weapons.js').WeaponDef} def
 * @property {import('../entities/soldier.js').Soldier|null} shooter
 * @property {any} excludeBody
 */

/**
 * Everything that deals damage: hitscan fire, pooled ballistic projectiles,
 * blast damage, destructible props, kills and vehicle destruction.
 */
export class CombatSystem {
  /** @param {import('./game.js').Game} game */
  constructor(game) {
    this.game = game;
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.2, 1.2), toneMapped: false });
    this.projMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.16, 0.9), mat, PROJECTILES);
    this.projMesh.frustumCulled = false;
    for (let i = 0; i < PROJECTILES; i++) this.projMesh.setMatrixAt(i, _zero);
    game.render.scene.add(this.projMesh);
    /** @type {Pool<Projectile>} */
    this.projectiles = new Pool(PROJECTILES, (i) => ({
      slot: i, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, def: /** @type {any} */ (null), shooter: null, excludeBody: null,
    }));
    game.bus.on('vehicle:destroyed', (v, attacker) => this._onVehicleDestroyed(v, attacker));
  }

  /**
   * Fires one round if the weapon is ready.
   * @param {import('../entities/soldier.js').Soldier} shooter
   * @param {import('../entities/weapons.js').WeaponState} weapon
   * @param {THREE.Vector3} origin @param {THREE.Vector3} dir  unit aim direction
   * @param {number} [spreadMul]
   * @returns {boolean} whether a round left the barrel
   */
  fire(shooter, weapon, origin, dir, spreadMul = 1) {
    if (!weapon.canFire()) return false;
    weapon.consume();
    const def = weapon.def, g = this.game;
    const spread = def.spread * spreadMul;
    _d.set(dir.x + (Math.random() - 0.5) * 2 * spread, dir.y + (Math.random() - 0.5) * 2 * spread, dir.z + (Math.random() - 0.5) * 2 * spread).normalize();
    const exclude = shooter.vehicle ? shooter.vehicle.body : undefined;
    shooter.spotted = 2.5;
    shooter.muzzleFlash = 0.05;
    g.bus.emit('sound', def.sound, origin.x, origin.y, origin.z);
    g.bus.emit('noise', origin.x, origin.z, def.type === 'hitscan' ? CONFIG.ai.hearRange : CONFIG.ai.hearRange * 1.6, shooter.team);
    const big = def.type === 'projectile' ? 2.4 : 1;
    if (!(shooter.isPlayer && !shooter.vehicle)) g.particles.muzzleFlash(origin.x + _d.x * 0.3, origin.y + _d.y * 0.3, origin.z + _d.z * 0.3, _d.x, _d.y, _d.z, big);
    if (def.type === 'hitscan') this._hitscan(shooter, def, origin, _d, exclude);
    else this._launch(shooter, def, origin, _d, exclude);
    return true;
  }

  _hitscan(shooter, def, o, d, exclude) {
    const g = this.game;
    const res = g.physics.castRay(o.x, o.y, o.z, d.x, d.y, d.z, def.range, MASK_SHOT, exclude);
    let best = res.toi;
    const target = res.target, nx = res.nx, ny = res.ny, nz = res.nz, worldHit = res.hit;
    /** @type {import('../entities/soldier.js').Soldier|null} */
    let victim = null;
    let head = false;
    const list = g.soldiers;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s.alive || s.team === shooter.team) continue;
      if (s.vehicle && s.vehicle.def.type !== 'jeep') continue;
      const p = s.pos;
      let t = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, p.x, p.y + 1.58, p.z, 0.24);
      let isHead = t >= 0;
      if (t < 0) t = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, p.x, p.y + 1.05, p.z, 0.44);
      if (t < 0) t = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, p.x, p.y + 0.42, p.z, 0.36);
      if (t >= 0 && t < best) { best = t; victim = s; head = isHead; }
    }
    const hx = o.x + d.x * best, hy = o.y + d.y * best, hz = o.z + d.z * best;
    // Offset the streak slightly so the player's own tracers do not start inside the camera.
    g.particles.tracer(o.x + d.x * 1.2, o.y + d.y * 1.2 - (shooter.isPlayer ? 0.12 : 0), o.z + d.z * 1.2, d.x, d.y, d.z, best - 1.2);
    if (victim) {
      g.particles.impact(hx, hy, hz, -d.x, 0.4, -d.z, 0.45, 0.06, 0.05);
      this.damageSoldier(victim, def.damage * (head ? def.headMul : 1), shooter, d.x, d.y, d.z, head, def.name);
    } else if (worldHit && target) {
      if (target.kind === 'vehicle') {
        g.particles.sparks(hx, hy, hz, 3);
        const v = target.ref;
        if (v.alive && !(v.occupied && v.team === shooter.team)) {
          v.damage(def.damage * def.vsVehicle[v.def.type], shooter);
          if (shooter.isPlayer && def.vsVehicle[v.def.type] > 0) g.bus.emit('hit', false, false);
        }
      } else {
        const rock = target.kind === 'prop';
        g.particles.impact(hx, hy, hz, nx, ny, nz, rock ? 0.35 : 0.3, rock ? 0.33 : 0.24, rock ? 0.3 : 0.14);
        if (rock && target.ref.destructible) this.damageProp(target.ref, def.damage * 0.3);
      }
    }
  }

  _launch(shooter, def, o, d, exclude) {
    const p = this.projectiles.acquire(true);
    if (!p) return;
    p.pos.copy(o).addScaledVector(d, 0.6);
    p.vel.copy(d).multiplyScalar(/** @type {number} */ (def.speed));
    p.life = 6;
    p.def = def; p.shooter = shooter; p.excludeBody = exclude || null;
  }

  /** @param {number} dt */
  update(dt) {
    const g = this.game, pool = this.projectiles;
    for (let i = pool.active - 1; i >= 0; i--) {
      const p = pool.items[i];
      p.vel.y -= /** @type {number} */ (p.def.gravity) * dt;
      const speed = p.vel.length(), step = speed * dt;
      _d.copy(p.vel).multiplyScalar(1 / speed);
      const res = g.physics.castRay(p.pos.x, p.pos.y, p.pos.z, _d.x, _d.y, _d.z, step, MASK_SHOT, p.excludeBody || undefined);
      let t = res.hit ? res.toi : -1;
      /** @type {any} */
      let direct = res.hit && res.target && res.target.kind === 'vehicle' ? res.target.ref : null;
      const team = p.shooter ? p.shooter.team : -1;
      for (let k = 0; k < g.soldiers.length; k++) {
        const s = g.soldiers[k];
        if (!s.alive || s.team === team || (s.vehicle && s.vehicle.def.type !== 'jeep')) continue;
        const ts = raySphere(p.pos.x, p.pos.y, p.pos.z, _d.x, _d.y, _d.z, s.pos.x, s.pos.y + 1, s.pos.z, 0.7);
        if (ts >= 0 && ts <= step && (t < 0 || ts < t)) { t = ts; direct = null; }
      }
      p.life -= dt;
      if (t >= 0 || p.life <= 0) {
        if (t >= 0) p.pos.addScaledVector(_d, Math.max(0, t - 0.15));
        this.explode(p.pos.x, p.pos.y, p.pos.z, p.def, p.shooter, direct);
        this.projMesh.setMatrixAt(p.slot, _zero);
        pool.releaseAt(i);
        continue;
      }
      p.pos.addScaledVector(_d, step);
      g.particles.trail(p.pos.x, p.pos.y, p.pos.z);
      _m.compose(p.pos, _q.setFromUnitVectors(Z, _d), _s.set(1, 1, 1));
      this.projMesh.setMatrixAt(p.slot, _m);
    }
    this.projMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Blast: direct-hit damage to a struck vehicle plus line-of-sight-checked
   * radial damage to soldiers, vehicles and destructible props.
   * @param {import('../entities/weapons.js').WeaponDef} def
   * @param {import('../entities/soldier.js').Soldier|null} shooter
   * @param {import('../entities/vehicle.js').Vehicle|null} [direct]
   */
  explode(x, y, z, def, shooter, direct = null) {
    const g = this.game, radius = /** @type {number} */ (def.radius);
    const team = shooter ? shooter.team : -1;
    g.particles.explosion(x, y, z, radius);
    g.bus.emit('sound', 'explosion', x, y, z);
    g.bus.emit('noise', x, z, 160, team);
    g.bus.emit('shake', x, y, z, radius);
    if (direct && direct.alive && !(direct.occupied && direct.team === team)) {
      direct.damage(def.damage * def.vsVehicle[direct.def.type], shooter);
      if (shooter && shooter.isPlayer) g.bus.emit('hit', false, false);
    }
    for (let i = 0; i < g.soldiers.length; i++) {
      const s = g.soldiers[i];
      if (!s.alive || (s.team === team && s !== shooter) || (s.vehicle && s.vehicle.def.type !== 'jeep')) continue;
      const dx = s.pos.x - x, dy = s.pos.y + 1 - y, dz = s.pos.z - z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius || !g.physics.losClear(x, y + 0.6, z, s.pos.x, s.pos.y + 1.2, s.pos.z)) continue;
      const k = 1 - dist / radius, inv = 1 / (dist || 1);
      this.damageSoldier(s, Math.min(def.damage, 260) * k * (s === shooter ? 0.5 : 1), shooter, dx * inv * 2.5, 1.2, dz * inv * 2.5, false, def.name);
    }
    const vehicles = g.vehicles.list;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (v === direct || !v.alive || (v.occupied && v.team === team)) continue;
      const dist = v.pos.distanceTo(_p.set(x, y, z)) - v.def.half[0];
      if (dist < radius) v.damage(def.damage * 0.3 * (1 - Math.max(0, dist) / radius) * def.vsVehicle[v.def.type], shooter);
    }
    const props = g.physics.propsNear(x, z);
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (!p.alive || !p.destructible) continue;
      const dist = Math.hypot(p.x - x, p.z - z);
      if (dist < radius) this.damageProp(p, def.damage * (1 - dist / radius));
    }
  }

  /** @param {import('../world/map-generator.js').Prop} p */
  damageProp(p, amount) {
    if (!p.alive || !p.destructible) return;
    p.hp -= amount;
    if (p.hp > 0) return;
    p.alive = false;
    const g = this.game;
    g.physics.removeProp(p);
    g.nav.stampProp(p, -1);
    g.chunks.removeDestructible(p);
    const wood = p.type === 'crate';
    for (let i = 0; i < 3; i++) g.particles.impact(p.x, p.y + p.hy, p.z, 0, 1, 0, wood ? 0.3 : 0.4, wood ? 0.2 : 0.4, wood ? 0.1 : 0.38);
    g.particles.smoke(p.x, p.y + p.hy, p.z, 1.2);
    g.bus.emit('prop:destroyed', p);
  }

  /**
   * @param {import('../entities/soldier.js').Soldier} victim
   * @param {import('../entities/soldier.js').Soldier|null} attacker
   * @param {string} [cause]
   */
  damageSoldier(victim, amount, attacker, dx = 0, dy = 0, dz = 0, head = false, cause = '') {
    if (!victim.alive) return;
    const g = this.game;
    if (victim.isPlayer && attacker && !attacker.isPlayer) amount *= CONFIG.ai.damageVsPlayer;
    victim.health -= amount;
    victim.lastDamageTime = g.time;
    if (attacker) victim.lastAttacker = attacker;
    if (victim.ai && attacker) victim.ai.onDamaged(attacker);
    if (victim.isPlayer) g.bus.emit('player:damaged', amount, attacker);
    const killed = victim.health <= 0;
    if (attacker && attacker.isPlayer && attacker !== victim) g.bus.emit('hit', killed, head);
    if (killed) this.kill(victim, attacker, dx, dy, dz, cause);
  }

  /** @param {import('../entities/soldier.js').Soldier} victim */
  kill(victim, attacker, dx = 0, dy = 0, dz = 0, cause = '') {
    if (!victim.alive) return;
    const g = this.game;
    g.soldierRenderer.spawnRagdoll(victim, dx * 3, dy * 2, dz * 3);
    if (victim.vehicle) victim.vehicle.exit(victim);
    victim.alive = false;
    victim.health = 0;
    victim.deaths++;
    victim.respawnTimer = CONFIG.match.respawnTime;
    if (attacker && attacker !== victim && attacker.team !== victim.team) attacker.kills++;
    g.bus.emit('kill', attacker, victim, cause);
  }

  /** @param {import('../entities/vehicle.js').Vehicle} v */
  _onVehicleDestroyed(v, attacker) {
    const g = this.game;
    g.particles.explosion(v.pos.x, v.pos.y, v.pos.z, 9);
    g.bus.emit('sound', 'explosion', v.pos.x, v.pos.y, v.pos.z);
    g.bus.emit('shake', v.pos.x, v.pos.y, v.pos.z, 10);
    for (let i = 0; i < v.seats.length; i++) {
      const s = v.seats[i];
      if (s) this.kill(s, attacker && attacker.team !== s.team ? attacker : null, 0, 2, 0, v.def.label);
    }
    v.body.applyImpulse({ x: 0, y: v.mass * 3, z: 0 }, true);
  }
}
