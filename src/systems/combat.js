import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../core/config.js';
import { Pool } from '../core/pool.js';
import { MASK_SHOT } from './physics.js';
import { impactPoint, telQueue, telState } from '../entities/tel-launch.js';

const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _t = new THREE.Vector3();
const _mp = new THREE.Vector3();
const _md = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _up = new THREE.Vector3(0, 1, 0), _vr = new THREE.Vector3();
const PROJECTILES = 128;

/** Ray vs sphere; returns entry distance or -1. */
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const t = lx * dx + ly * dy + lz * dz;
  if (t < 0) return -1;
  const d2 = lx * lx + ly * ly + lz * lz - t * t;
  if (d2 > r * r) return -1;
  return t - Math.sqrt(r * r - d2);
}

/** Can this soldier be hit by small arms (not sealed inside a vehicle)? */
const exposed = (s) => s.alive && (!s.vehicle || s.vehicle.seatExposed(s.seat));

/** Hit-sphere centres for a soldier's stance: head, torso, legs (xyz each) + bounding centre y. */
const _hs = new Float32Array(10);
function hitLayout(s) {
  const p = s.pos;
  if (s.stance === 2 && !s.vehicle) {
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    _hs[0] = p.x + fx * 0.65; _hs[1] = p.y + 0.36; _hs[2] = p.z + fz * 0.65;
    _hs[3] = p.x; _hs[4] = p.y + 0.3; _hs[5] = p.z;
    _hs[6] = p.x - fx * 0.75; _hs[7] = p.y + 0.22; _hs[8] = p.z - fz * 0.75;
    _hs[9] = p.y + 0.3;
  } else {
    // Seated (open vehicle, riding on a hull) is about as tall as kneeling.
    const k = s.vehicle ? 0.62 : s.stance === 1 ? 0.7 : 1;
    _hs[0] = p.x; _hs[1] = p.y + 1.62 * k; _hs[2] = p.z;
    _hs[3] = p.x; _hs[4] = p.y + 1.12 * k; _hs[5] = p.z;
    _hs[6] = p.x; _hs[7] = p.y + 0.45 * k; _hs[8] = p.z;
    _hs[9] = p.y + 0.95 * k;
  }
  return _hs;
}
/** Near-miss candidates of one hitscan shot (soldier index, distance along the ray, miss distance). */
const NEAR = new Int32Array(24);
const NEAR_T = new Float32Array(24);
const NEAR_D = new Float32Array(24);

/**
 * @typedef {Object} Projectile
 * @property {number} slot
 * @property {THREE.Vector3} pos @property {THREE.Vector3} vel
 * @property {number} life @property {number} age @property {number} [fxAcc]  exhaust emission accumulator (m)
 * @property {import('../entities/weapons.js').WeaponDef} def
 * @property {import('../entities/soldier.js').Soldier|null} shooter
 * @property {any} excludeBody
 * @property {any} target            locked aircraft for 'air' missiles
 * @property {any} guide             launching vehicle for 'guided' missiles
 * @property {number} mount
 */

/**
 * @typedef {Object} FireOptions
 * @property {import('../entities/vehicle.js').Vehicle} [vehicle]  launching vehicle (inherits its velocity)
 * @property {number} [mount]   mount index (guided missiles follow its aim)
 * @property {any} [lock]       target for air-to-air / surface-to-air missiles
 */

/**
 * Everything that deals damage: hitscan fire (with optional explosive
 * splash), pooled ballistic / guided / homing projectiles and bombs, blast
 * damage, destructible props, kills and vehicle destruction.
 */
export class CombatSystem {
  /** @param {import('./game.js').Game} game */
  constructor(game) {
    this.game = game;
    // Rocket / missile body: olive tube, ogive nose, four tail fins (bullets are hitscan tracers, not projectiles).
    const mat = new THREE.MeshLambertMaterial({ color: 0x59604a });
    const parts = [new THREE.CylinderGeometry(0.075, 0.075, 0.8, 8).rotateX(Math.PI / 2), new THREE.ConeGeometry(0.075, 0.28, 8).rotateX(Math.PI / 2).translate(0, 0, 0.54)];
    for (let k = 0; k < 4; k++) parts.push(new THREE.BoxGeometry(0.012, 0.2, 0.16).translate(0, 0.12, -0.32).rotateZ((k * Math.PI) / 2));
    this.projMesh = new THREE.InstancedMesh(mergeGeometries(parts.map((g) => g.toNonIndexed())), mat, PROJECTILES);
    this.projMesh.frustumCulled = false;
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < PROJECTILES; i++) this.projMesh.setMatrixAt(i, _zero);
    game.render.scene.add(this.projMesh);
    /** @type {Pool<Projectile>} */
    this.projectiles = new Pool(PROJECTILES, (i) => ({
      slot: i, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, age: 0, def: /** @type {any} */ (null),
      shooter: null, excludeBody: null, target: null, guide: null, mount: 0, flareChecked: false, proxHit: null, vls: null,
    }));
    game.bus.on('vehicle:destroyed', (v, attacker) => this._onVehicleDestroyed(v, attacker));
  }

  /**
   * Fires one round if the weapon is ready.
   * @param {import('../entities/soldier.js').Soldier} shooter
   * @param {import('../entities/weapons.js').WeaponState} weapon
   * @param {THREE.Vector3} origin @param {THREE.Vector3} dir  unit aim direction
   * @param {number} [spreadMul]
   * @param {FireOptions} [opts]
   * @returns {boolean} whether a round left the barrel
   */
  fire(shooter, weapon, origin, dir, spreadMul = 1, opts) {
    if (weapon.def.type === 'light' || !weapon.canFire()) return false;
    const def = weapon.def, g = this.game;
    if (def.homing === 'air' && !(opts && opts.lock && opts.lock.alive)) return false;
    weapon.consume();
    const spread = def.spread * spreadMul;
    _d.set(dir.x + (Math.random() - 0.5) * 2 * spread, dir.y + (Math.random() - 0.5) * 2 * spread, dir.z + (Math.random() - 0.5) * 2 * spread).normalize();
    const vehicle = opts && opts.vehicle ? opts.vehicle : shooter.vehicle;
    if (def.vls && vehicle && telState(vehicle)) {
      // Vertical launch: the fire order sets the impact point (from the aim, not the erector) and queues the
      // missile; the launcher erects and fires it (tel-launch.js → launchVertical).
      const seat = vehicle.operatorSeat(opts && opts.mount !== undefined ? opts.mount : 0);
      const yaw = vehicle.aimYaw[seat], pitch = vehicle.aimPitch[seat], cp = Math.cos(pitch);
      _d.set(Math.sin(yaw) * cp + (Math.random() - 0.5) * 2 * spread, Math.sin(pitch), Math.cos(yaw) * cp + (Math.random() - 0.5) * 2 * spread).normalize();
      telQueue(vehicle, impactPoint(g, origin, _d, /** @type {number} */ (def.speed), /** @type {number} */ (def.gravity)), shooter);
      if (shooter.isPlayer) g.bus.emit('notice', vehicle.tel.erect < 1 ? 'HALT — ERECTING LAUNCHER' : 'LAUNCH SEQUENCE');
      return true;
    }
    const exclude = vehicle ? vehicle.body : undefined;
    shooter.spotted = 2.5;
    shooter.muzzleFlash = 0.05;
    g.bus.emit('sound', def.sound, origin.x, origin.y, origin.z);
    g.bus.emit('noise', origin.x, origin.z, def.type === 'hitscan' ? CONFIG.ai.hearRange : CONFIG.ai.hearRange * 1.6, shooter.team, shooter.id);
    const big = def.type === 'projectile' ? (def.size || 1) * 2.2 : def.splash ? 1.6 : 1;
    if (!def.drop && !(shooter.isPlayer && !shooter.vehicle)) {
      g.particles.muzzleFlash(origin.x + _d.x * 0.3, origin.y + _d.y * 0.3, origin.z + _d.z * 0.3, _d.x, _d.y, _d.z, big);
    }
    if (def.type === 'hitscan') this._hitscan(shooter, def, origin, _d, exclude);
    else this._launch(shooter, def, origin, _d, exclude, vehicle, opts);
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
    let nNear = 0;
    const list = g.soldiers;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.team === shooter.team || !exposed(s)) continue;
      const p = s.pos;
      // Near-miss bookkeeping (suppression): rounds passing within 3 m of the chest.
      const lx = p.x - o.x, ly = p.y + 1 - o.y, lz = p.z - o.z, along = lx * d.x + ly * d.y + lz * d.z;
      if (along > 0 && along < def.range && nNear < NEAR.length) {
        const miss2 = lx * lx + ly * ly + lz * lz - along * along;
        if (miss2 < 9) { NEAR[nNear] = i; NEAR_T[nNear] = along; NEAR_D[nNear] = Math.sqrt(Math.max(0, miss2)); nNear++; }
      }
      const h = hitLayout(s);
      // Cheap bounding test before the three hit spheres.
      if (raySphere(o.x, o.y, o.z, d.x, d.y, d.z, p.x, h[9], p.z, 1.15) < 0) continue;
      let t = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, h[0], h[1], h[2], 0.23);
      const isHead = t >= 0;
      if (t < 0) t = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, h[3], h[4], h[5], 0.42);
      if (t < 0) t = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, h[6], h[7], h[8], 0.36);
      if (t >= 0 && t < best) { best = t; victim = s; head = isHead; }
    }
    if (g.ai) {
      for (let k = 0; k < nNear; k++) {
        const s = list[NEAR[k]];
        if (s === victim || NEAR_T[k] > best + 2) continue;
        g.ai.onSuppress(s.id, (0.06 + def.damage * 0.004) * (1.4 - NEAR_D[k] / 3), o.x, o.z);
      }
    }
    const hx = o.x + d.x * best, hy = o.y + d.y * best, hz = o.z + d.z * best;
    // Offset the streak slightly so the player's own tracers do not start inside the camera.
    g.particles.tracer(o.x + d.x * 1.2, o.y + d.y * 1.2 - (shooter.isPlayer && !shooter.vehicle ? 0.12 : 0), o.z + d.z * 1.2, d.x, d.y, d.z, best - 1.2);
    if (victim) {
      g.particles.impact(hx, hy, hz, -d.x, 0.4, -d.z, 0.45, 0.06, 0.05);
      this.damageSoldier(victim, def.damage * (head ? def.headMul : 1), shooter, d.x, d.y, d.z, head, def.name);
    } else if (worldHit && target) {
      if (target.kind === 'vehicle') {
        g.particles.sparks(hx, hy, hz, 3);
        const v = target.ref, mul = def.vsVehicle[v.def.armor];
        if (v.alive && mul > 0 && !(v.occupied && v.team === shooter.team)) {
          v.damage(def.damage * mul, shooter);
          if (shooter.isPlayer) g.bus.emit('hit', false, false);
        }
      } else {
        const prop = target.kind === 'prop', bld = target.kind === 'building';
        if (!def.splash) g.particles.impact(hx, hy, hz, nx, ny, nz, prop || bld ? 0.35 : 0.3, prop || bld ? 0.33 : 0.24, prop || bld ? 0.3 : 0.14);
        if (prop && target.ref.destructible) this.damageProp(target.ref, def.damage * (def.splash ? 1 : 0.3));
        if (bld && g.structures) g.structures.onBulletHit(target.ref, hx, hy, hz);
      }
    }
    if (def.splash && (victim || worldHit)) this.blast(hx, hy, hz, def.splash, def.damage * 0.6, shooter, def.name, false);
  }

  /**
   * Vertical launch of round `round` from a TEL erector: cold-launch pop now, booster ignition a moment later,
   * vertical climb, then pitch-over onto a ballistic arc that comes down on `target` (see _vls).
   * @param {any} v launcher @param {number} mount @param {number} round @param {THREE.Vector3} target @param {any} shooter
   */
  launchVertical(v, mount, round, target, shooter) {
    const w = v.weapons[mount], def = w.def, g = this.game;
    const p = this.projectiles.acquire(true);
    if (!p) return;
    const shot = w.shot; w.shot = round; v.getMuzzle(mount, _p, _d); w.shot = shot;
    // The missile's middle sits ~3 m below the erector tip.
    p.pos.copy(_p).addScaledVector(_d, -3.2);
    p.vel.set(0, 17, 0);
    p.life = (def.life || 45) + 20; p.age = 0;
    p.def = def; p.shooter = shooter; p.excludeBody = v.body; p.target = null; p.guide = null; p.mount = mount;
    p.flareChecked = false; p.fxAcc = 0;
    p.vls = { phase: 0, target: target.clone(), t0: 0, tf: 0, launcher: v };
    g.rocketFX.coldLaunch(_p, v.pos.y - v.def.ride);
    g.bus.emit('sound', 'cannon', _p.x, _p.y, _p.z);
  }

  /** Vertical-launch flight: pop, ignition, vertical boost, pitch-over onto the ballistic arc to the target. */
  _vls(p, dt) {
    const s = p.vls, a = p.age, g = this.game, fx = g.rocketFX;
    if (s.phase === 0) {
      if (a < 0.45) return;
      // Booster ignition: blinding flash, a cloud rolling out around the launcher, cover pieces flung off.
      s.phase = 1;
      const gy = Math.max(g.map.terrain.height(p.pos.x, p.pos.z), 0);
      fx.launch(p.pos, _up, (p.def.size || 1) * 0.85, gy);
      fx.ignitionFlash(p.pos, 3.2, gy);
      for (let k = 0; k < 14; k++) {
        const a2 = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 9;
        const dark = 0.06 + Math.random() * 0.08;
        g.particles.emit(p.pos.x, p.pos.y - 2, p.pos.z, Math.cos(a2) * sp, 5 + Math.random() * 12, Math.sin(a2) * sp,
          2.5 + Math.random() * 2, 0.18 + Math.random() * 0.22, 0.18, dark, dark, dark, 1, false, 9.8, 0.15);
      }
      g.bus.emit('sound', p.def.sound, p.pos.x, p.pos.y, p.pos.z);
      g.bus.emit('noise', p.pos.x, p.pos.z, CONFIG.ai.hearRange * 2.5, p.shooter ? p.shooter.team : -1, p.shooter ? p.shooter.id : -1);
      return;
    }
    if (s.phase === 1) {
      // Straight up on the booster.
      p.vel.y += 58 * dt;
      p.vel.x *= 0.9; p.vel.z *= 0.9;
      if (a < 1.9) return;
      s.phase = 2; s.t0 = a;
      const D = Math.hypot(s.target.x - p.pos.x, s.target.z - p.pos.z);
      s.tf = Math.max(8, D / 150 + 5);
      return;
    }
    if (s.phase === 2) {
      // Pitch-over: the velocity swings from vertical onto the arc that lands on the target.
      const k = Math.min(1, (a - s.t0) / 2.2), tf = Math.max(1.5, s.tf - (a - s.t0)), G = /** @type {number} */ (p.def.gravity);
      _vr.set((s.target.x - p.pos.x) / tf, (s.target.y - p.pos.y) / tf + 0.5 * G * tf, (s.target.z - p.pos.z) / tf);
      if (k >= 1) { p.vel.copy(_vr); p.vel.y += G * dt; s.phase = 3; return; }
      p.vel.lerp(_vr, Math.min(1, k * k * 0.12 + dt * 1.6 * k));
    }
  }

  _launch(shooter, def, o, d, exclude, vehicle, opts) {
    const p = this.projectiles.acquire(true);
    if (!p) return;
    p.pos.copy(o).addScaledVector(d, def.drop ? 0 : 0.6);
    p.vel.copy(d).multiplyScalar(/** @type {number} */ (def.speed));
    // Launched from a moving aircraft (or dropped): inherit its velocity.
    if (vehicle && (def.drop || vehicle.isAircraft)) p.vel.add(vehicle.vel);
    if (def.drop) p.vel.y -= 1.5;
    p.life = def.life || 6;
    p.age = 0;
    p.def = def; p.shooter = shooter; p.excludeBody = exclude || null;
    p.target = def.homing === 'air' && opts ? opts.lock : null;
    p.flareChecked = false;
    p.guide = def.homing === 'guided' ? vehicle || null : null;
    p.mount = opts && opts.mount !== undefined ? opts.mount : 0;
    p.fxAcc = 0;
    p.vls = null;
    if (def.trail) {
      const fx = this.game.rocketFX, gy = Math.max(this.game.map.terrain.height(o.x, o.z), 0);
      if (def.artillery) fx.launch(p.pos, d, (def.size || 1) * 0.8, gy);
      else if (!vehicle || !vehicle.isAircraft) fx.launch(p.pos, d, 0.3, gy);
    }
    if (p.target) this.game.bus.emit('missile:launch', p.target, shooter);
  }

  /** Steers a guided or homing projectile. */
  _steer(p, dt) {
    const def = p.def;
    let goal = null;
    if (p.target) {
      const t = p.target;
      if (!t.alive) { p.target = null; return; }
      // Flares: each missile rolls once against a live salvo.
      if (t.flareUntil > this.game.time && !p.flareChecked) {
        p.flareChecked = true;
        if (Math.random() < 0.72) { p.target = null; return; }
      }
      const dist = p.pos.distanceTo(t.pos);
      const tof = dist / Math.max(40, p.vel.length());
      goal = _t.copy(t.pos).addScaledVector(t.vel || _s.set(0, 0, 0), Math.min(tof, 3));
      if (dist < 7) { p.life = 0; p.proxHit = t; }
    } else if (p.guide) {
      const v = p.guide;
      if (!v.alive || !v.operator(p.mount)) { p.guide = null; return; }
      v.getMuzzle(p.mount, _mp, _md);
      const along = Math.max(30, _mp.distanceTo(p.pos) + 25);
      goal = _t.copy(_mp).addScaledVector(_md, along);
    }
    if (!goal) return;
    const speed = p.vel.length();
    _d.copy(p.vel).multiplyScalar(1 / speed);
    _s.subVectors(goal, p.pos).normalize();
    const ang = Math.acos(Math.min(1, Math.max(-1, _d.dot(_s))));
    const maxTurn = (def.turn || 1.5) * dt;
    if (ang > 1e-4) {
      const k = Math.min(1, maxTurn / ang);
      _d.lerp(_s, k).normalize();
    }
    p.vel.copy(_d).multiplyScalar(Math.max(speed, /** @type {number} */ (def.speed)));
  }

  /** @param {number} dt */
  update(dt) {
    const g = this.game, pool = this.projectiles, cam = g.render.camera;
    const pxScale = g.render.renderer.domElement.height * 0.5 / Math.tan((cam.fov * Math.PI) / 360);
    for (let i = pool.active - 1; i >= 0; i--) {
      const p = pool.items[i];
      p.age += dt;
      p.proxHit = null;
      if (p.def.homing && p.age > 0.15) this._steer(p, dt);
      if (p.vls) this._vls(p, dt);
      p.vel.y -= /** @type {number} */ (p.def.gravity) * dt;
      const speed = p.vel.length() || 1e-3, step = speed * dt;
      _d.copy(p.vel).multiplyScalar(1 / speed);
      const res = g.physics.castRay(p.pos.x, p.pos.y, p.pos.z, _d.x, _d.y, _d.z, step, MASK_SHOT, p.excludeBody || undefined);
      let t = res.hit ? res.toi : -1;
      /** @type {any} */
      let direct = res.hit && res.target && res.target.kind === 'vehicle' ? res.target.ref : null;
      const team = p.shooter ? p.shooter.team : -1;
      if (!p.def.homing || p.def.homing === 'guided') {
        for (let k = 0; k < g.soldiers.length; k++) {
          const s = g.soldiers[k];
          if (s.team === team || !exposed(s)) continue;
          const ts = raySphere(p.pos.x, p.pos.y, p.pos.z, _d.x, _d.y, _d.z, s.pos.x, hitLayout(s)[4], s.pos.z, 0.7);
          if (ts >= 0 && ts <= step && (t < 0 || ts < t)) { t = ts; direct = null; }
        }
      }
      p.life -= dt;
      if (p.proxHit) direct = p.proxHit;
      if (t >= 0 || p.life <= 0) {
        if (t >= 0) p.pos.addScaledVector(_d, Math.max(0, t - 0.15));
        this.explode(p.pos.x, p.pos.y, p.pos.z, p.def, p.shooter, direct);
        this.projMesh.setMatrixAt(p.slot, _zero);
        pool.releaseAt(i);
        continue;
      }
      const px = p.pos.x, py = p.pos.y, pz = p.pos.z;
      p.pos.addScaledVector(_d, step);
      if (p.vls && p.vls.phase === 0) {
        // Cold-launch pop: the missile itself, thrown out of the launcher before its motor lights.
        _m.compose(p.pos, _q.setFromUnitVectors(Z, _d), _s.set(6, 6, 5.5));
        this.projMesh.setMatrixAt(p.slot, _m);
        continue;
      }
      if (p.def.trail) {
        // Rockets and missiles fly as light: a glowing rod and nozzle flare at the head of the smoke.
        g.rocketFX.trail(p, px, py, pz);
        g.rocketFX.body(p, _d);
        this.projMesh.setMatrixAt(p.slot, _zero);
        continue;
      }
      if (p.def.artillery) {
        // Gun-artillery shells: a glowing dot that cools as it flies, with a smoke trail that thins out.
        g.rocketFX.shell(p, px, py, pz);
        this.projMesh.setMatrixAt(p.slot, _zero);
        continue;
      }
      // Tank shells glow like tracer rounds; bombs fall dark.
      if (!p.def.drop) g.particles.tracer(px, py, pz, _d.x, _d.y, _d.z, step, 0.5);
      // True size, with a floor of about a pixel so a distant body does not vanish.
      const sc = p.def.size || 1, k = Math.max(sc, p.pos.distanceTo(cam.position) * 7 / pxScale);
      _m.compose(p.pos, _q.setFromUnitVectors(Z, _d), _s.set(k, k, sc));
      this.projMesh.setMatrixAt(p.slot, _m);
    }
    this.projMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Radial damage to exposed soldiers (line-of-sight checked) and props.
   * @param {boolean} [effects] spawn the full explosion effect
   */
  blast(x, y, z, radius, damage, shooter, cause, effects = true) {
    const g = this.game, team = shooter ? shooter.team : -1;
    if (effects) {
      // What the blast hit decides what it throws up, and whether something catches fire.
      const kind = this._blastKind(x, y, z, radius);
      this._lastDirect = null; this._lastDef = null;
      g.particles.explosionCtx(x, y, z, radius, kind);
      const F = g.fires, R = Math.random();
      if (F) {
        const gy = g.map.terrain.height(x, z);
        if (kind === 'huge') { for (let i = 0; i < 4; i++) { const a = R * 6.3 + i * 1.6, d = 4 + i * 5; F.ignite(x + Math.cos(a) * d, gy, z + Math.sin(a) * d, 2.5, 50 + i * 10); } }
        else if (kind === 'vehicle' && R < 0.5) F.ignite(x, y - 0.5, z, 1.2, 25);
        else if (kind === 'building' && R < 0.45 * Math.min(1, radius / 6)) F.ignite(x, y, z, 1.4, 40);
        else if (kind === 'vegetation' && R < 0.35 * Math.min(1, radius / 6) && !(g.atmosphere && g.atmosphere.weather === 'rain')) F.ignite(x, gy, z, 1 + radius * 0.08, 30);
      }
    } else g.particles.sparks(x, y, z, 4);
    for (let i = 0; i < g.soldiers.length; i++) {
      const s = g.soldiers[i];
      if (!exposed(s) || (s.team === team && s !== shooter)) continue;
      const cy = hitLayout(s)[4];
      const dx = s.pos.x - x, dy = cy - y, dz = s.pos.z - z;
      if (Math.abs(dx) > radius || Math.abs(dz) > radius) continue;
      // Going prone shrinks the exposed silhouette to fragments.
      const dist = Math.hypot(dx, dy, dz) * (s.stance === 2 ? 1.35 : 1);
      if (dist > radius || !g.physics.losClear(x, y + 0.6, z, s.pos.x, cy + 0.2, s.pos.z)) continue;
      const k = 1 - dist / radius, inv = 1 / (dist || 1);
      this.damageSoldier(s, Math.min(damage, 260) * k * (s === shooter ? 0.5 : 1), shooter, dx * inv * 2.5, 1.2, dz * inv * 2.5, false, cause);
    }
    const props = g.physics.propsNear(x, z);
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (!p.alive || !p.destructible) continue;
      const dist = Math.hypot(p.x - x, p.z - z);
      if (dist < radius) this.damageProp(p, damage * (1 - dist / radius));
    }
    // Structures: damage states (persist until the match resets), shattered windows, the bridge.
    if (g.structures) g.structures.blast(x, y, z, radius, damage);
  }

  /**
   * Shell crater: a bowl with a low rim pressed into the terrain heightfield (soldiers walk down into it and a
   * prone soldier inside is below the surrounding ground: cover). The terrain mesh of that chunk is rebuilt;
   * the vehicle physics heightfield keeps its original shape. Capped per match.
   */
  _crater(x, z, r, depth) {
    const g = this.game, t = g.map.terrain;
    if ((this.craters = (this.craters || 0)) >= 600 || x < -t.half || x > t.half || z < -t.half || z > t.half) return;
    if (t.baseHeight(x, z) < 0.6) return; // not in water
    this.craters++;
    const n = t.n, res = t.res, R = r * 1.5;
    const i0 = Math.max(0, Math.floor((x - R + t.half) / res)), i1 = Math.min(n - 1, Math.ceil((x + R + t.half) / res));
    const j0 = Math.max(0, Math.floor((z - R + t.half) / res)), j1 = Math.min(n - 1, Math.ceil((z + R + t.half) / res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const sx = -t.half + i * res, sz = -t.half + j * res, d = Math.hypot(sx - x, sz - z) / r;
      if (d < 1) t.heights[j * n + i] -= depth * (1 - d * d);
      else if (d < 1.5) t.heights[j * n + i] += depth * 0.3 * Math.sin((d - 1) / 0.5 * Math.PI);
    }
    if (g.chunks && g.chunks.markDirtyAt) g.chunks.markDirtyAt(x, z);
  }

  /**
   * Explosive impact: direct-hit damage to a struck vehicle plus radial
   * damage to soldiers, vehicles and destructible props.
   * @param {import('../entities/weapons.js').WeaponDef} def
   * @param {import('../entities/soldier.js').Soldier|null} shooter
   * @param {import('../entities/vehicle.js').Vehicle|null} [direct]
   */
  /** What an explosion hit: 'huge' | 'water' | 'vehicle' | 'building' | 'hard' | 'vegetation' | 'dirt'. */
  _blastKind(x, y, z, radius) {
    const g = this.game, T = g.map.terrain, gy = T.height(x, z);
    if ((this._lastDef && this._lastDef.vls) || radius >= 25) return 'huge';
    if (gy < CONFIG.world.waterLevel - 0.3 && y < CONFIG.world.waterLevel + 1.5) return 'water';
    if (this._lastDirect) return 'vehicle';
    if (y - gy > 1.2 || g.nav.blocked(x, z)) return 'building';
    const sf = T.surfAt(x, z);
    if (sf === 1 || sf === 2 || sf === 6 || T.pavedAt(x, z) > 0) return 'hard';
    if (sf === 3 || sf === 4 || sf === 8) return 'vegetation';
    return 'dirt';
  }

  explode(x, y, z, def, shooter, direct = null) {
    this._lastDirect = direct && direct.kind === 'vehicle' ? direct : null;
    this._lastDef = def;
    const g = this.game, radius = /** @type {number} */ (def.radius);
    const team = shooter ? shooter.team : -1;
    g.bus.emit('sound', 'explosion', x, y, z);
    g.bus.emit('noise', x, z, 160, team, shooter ? shooter.id : -1);
    if (g.ai) {
      // Blast suppression: everyone nearby ducks, regardless of side.
      const r3 = radius * 3 + 6;
      for (let i = 0; i < g.soldiers.length; i++) {
        const s = g.soldiers[i];
        if (!s.alive || s.vehicle) continue;
        const dx = s.pos.x - x, dz = s.pos.z - z;
        if (Math.abs(dx) > r3 || Math.abs(dz) > r3) continue;
        const dist = Math.hypot(dx, dz);
        if (dist < r3) g.ai.onSuppress(s.id, 0.65 * (1 - dist / r3), x, z);
      }
    }
    g.bus.emit('shake', x, y, z, radius);
    if (direct && direct.alive && !(direct.occupied && direct.team === team)) {
      direct.damage(def.damage * def.vsVehicle[direct.def.armor], shooter);
      if (shooter && shooter.isPlayer) g.bus.emit('hit', false, false);
    }
    this.blast(x, y, z, radius, def.damage, shooter, def.name, true);
    // Heavy rockets: extra structural damage (collapses bunkers and buildings faster) and a crater.
    if (def.structureMul && g.structures) g.structures.blast(x, y, z, radius * 0.7, def.damage * (def.structureMul - 1));
    if (def.crater && y - g.map.terrain.height(x, z) < 2.5) this._crater(x, z, def.crater, 0.9);
    const vehicles = g.vehicles.list;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (v === direct || !v.alive || (v.occupied && v.team === team)) continue;
      const dist = v.pos.distanceTo(_p.set(x, y, z)) - v.def.half[0];
      if (dist < radius) v.damage(def.damage * 0.3 * (1 - Math.max(0, dist) / radius) * def.vsVehicle[v.def.armor], shooter);
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
    const wood = p.type === 'crate' || p.type === 'fence';
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
    if (g.ai && victim.ai && attacker !== victim) g.ai.onDamaged(victim, attacker);
    if (victim.isPlayer) g.bus.emit('player:damaged', amount, attacker);
    const killed = victim.health <= 0;
    if (attacker && attacker.isPlayer && attacker !== victim) g.bus.emit('hit', killed, head);
    if (killed) this.kill(victim, attacker, dx, dy, dz, cause);
  }

  /** @param {import('../entities/soldier.js').Soldier} victim */
  kill(victim, attacker, dx = 0, dy = 0, dz = 0, cause = '') {
    if (!victim.alive) return;
    const g = this.game;
    if (victim.vehicle) victim.vehicle.exit(victim);
    g.soldierRenderer.spawnRagdoll(victim, dx * 3, dy * 2, dz * 3);
    victim.alive = false;
    victim.health = 0;
    victim.deaths++;
    victim.parachute = false;
    victim.respawnTimer = CONFIG.match.respawnTime;
    if (attacker && attacker !== victim && attacker.team !== victim.team) attacker.kills++;
    g.bus.emit('kill', attacker, victim, cause);
  }

  /** @param {import('../entities/vehicle.js').Vehicle} v */
  _onVehicleDestroyed(v, attacker) {
    const g = this.game;
    g.particles.explosionCtx(v.pos.x, v.pos.y, v.pos.z, 9, 'vehicle');
    // The wreck burns.
    if (g.fires && !v.isAircraft) g.fires.ignite(v.pos.x, v.pos.y, v.pos.z, Math.min(2.4, v.def.half[0] + 0.4), 45 + Math.random() * 30);
    g.bus.emit('sound', 'explosion', v.pos.x, v.pos.y, v.pos.z);
    g.bus.emit('shake', v.pos.x, v.pos.y, v.pos.z, 10);
    for (let i = 0; i < v.seats.length; i++) {
      const s = v.seats[i];
      if (!s) continue;
      // Riders on the deck are thrown clear (badly hurt); everyone inside goes with the vehicle.
      if (v.def.seats[i].exterior) {
        v.exit(s);
        this.damageSoldier(s, 70, attacker && attacker.team !== s.team ? attacker : null, 0, 3, 0, false, v.def.label);
      } else this.kill(s, attacker && attacker.team !== s.team ? attacker : null, 0, 2, 0, v.def.label);
    }
    if (!v.def.static) v.body.applyImpulse({ x: 0, y: v.mass * 3, z: 0 }, true);
  }
}
