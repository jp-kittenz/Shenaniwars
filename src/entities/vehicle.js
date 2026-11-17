import * as THREE from 'three';
import { CONFIG, GROUP } from '../core/config.js';
import { clamp, turnToward, angleDelta } from '../core/math.js';
import { groups } from '../systems/physics.js';
import { buildVehicleVisual } from './vehicle-visual.js';
import { WeaponState } from './weapons.js';
import { stepHelicopter } from './helicopter.js';
import { stepJet } from './aircraft.js';

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _wp = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _wf = new THREE.Vector3();
const _ws = new THREE.Vector3();
const _n = new THREE.Vector3();
const _r = new THREE.Vector3();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _sc = new THREE.Vector3(1, 1, 1);
const _wq = new THREE.Quaternion();
const _we = new THREE.Euler(0, 0, 0, 'YXZ');
const _imp = { x: 0, y: 0, z: 0 };
const _pt = { x: 0, y: 0, z: 0 };

/**
 * @typedef {Object} VehicleContext
 * @property {import('../systems/physics.js').PhysicsSystem} physics
 * @property {import('../world/terrain.js').Terrain} terrain
 * @property {import('../core/event-bus.js').EventBus} bus
 * @property {THREE.Scene|null} scene
 * @property {(m: THREE.Material) => THREE.Material} setupMaterial
 */

/**
 * @typedef {Object} VehicleControls
 * @property {number} throttle   -1..1 drive (ground); 0..1 engine power (jets)
 * @property {number} steer      -1..1, positive = turn left (ground)
 * @property {boolean} brake
 * @property {number} pitch      -1..1, positive = nose down
 * @property {number} roll       -1..1, positive = bank right
 * @property {number} yaw        -1..1, positive = turn left
 * @property {number} collective -1..1 climb rate command (helicopters)
 */

/**
 * A drivable rigid-body vehicle. Ground vehicles ride a custom raycast
 * suspension whose per-wheel normal load caps tyre friction (weight transfer,
 * traction loss on slopes); tanks reuse it with skid steering. Helicopters
 * and jets delegate to their flight models but share seats, weapons, damage
 * and interpolation.
 */
export class Vehicle {
  /**
   * @param {VehicleContext} ctx
   * @param {import('./vehicle-defs.js').VehicleDef} def
   * @param {import('../world/map-generator.js').VehicleSpawn} spawn
   * @param {number} id
   */
  constructor(ctx, def, spawn, id) {
    this.ctx = ctx;
    this.terrain = ctx.terrain;
    this.def = def;
    this.spawn = spawn;
    this.id = id;
    this.kind = 'vehicle';
    this.team = spawn.team;
    this.health = def.health;
    this.alive = true;
    this.wreckTimer = 0;
    this.respawnTimer = 0;
    this.idleTime = 0;
    /** @type {(import('./soldier.js').Soldier|null)[]} */
    this.seats = def.seats.map(() => null);
    /** Selected weapon (index into def.seatMounts[seat]) per seat. */
    this.seatWeapon = new Int8Array(def.seats.length);
    /** @type {VehicleControls} */
    this.controls = { throttle: 0, steer: 0, brake: false, pitch: 0, roll: 0, yaw: 0, collective: 0 };
    /** World-space aim request per seat. */
    this.aimYaw = new Float32Array(def.seats.length);
    this.aimPitch = new Float32Array(def.seats.length);
    this.mountYaw = new Float32Array(def.mounts.length);
    this.mountPitch = new Float32Array(def.mounts.length);
    this.weapons = def.mounts.map((m) => new WeaponState(m.weapon));
    /** Homing lock per mount (target entity) for 'air' missiles. */
    this.locks = def.mounts.map(() => null);
    this.wheelDist = new Float32Array(def.wheels.length);
    this.wheelSpin = 0;
    this.steerAngle = 0;
    this.grounded = 0;
    this.speed = 0;
    this.airspeed = 0;
    this.heading = spawn.yaw;
    this.rotorSpeed = 0;
    this.lastAttacker = null;
    /** Countermeasures: flares spoof 'air' missiles until this time; smoke launcher cooldown. */
    this.flareUntil = 0;
    this.flareReadyAt = 0;
    this.flares = def.kind === 'ground' ? 0 : 6;
    this.smokeCooldown = 0;
    /** Search radar emitting (air-defence vehicles): extends air detection range, reveals the emitter. */
    this.radarOn = false;
    this._flipTimer = 0;
    this._detailOn = true;
    this._shadowOn = true;

    const R = ctx.physics.R;
    const y = this._restHeight(spawn.x, spawn.z);
    const desc = R.RigidBodyDesc.dynamic().setTranslation(spawn.x, y, spawn.z)
      .setRotation({ x: 0, y: Math.sin(spawn.yaw / 2), z: 0, w: Math.cos(spawn.yaw / 2) })
      .setLinearDamping(def.kind === 'ground' ? 0.03 : 0.02).setAngularDamping(def.kind === 'ground' ? 1.4 : 1.5);
    if (def.kind === 'jet') desc.setCcdEnabled(true);
    this.body = ctx.physics.world.createRigidBody(desc);
    this.collider = ctx.physics.world.createCollider(
      R.ColliderDesc.cuboid(def.half[0], def.half[1], def.half[2]).setMass(def.mass).setFriction(def.kind === 'jet' ? 0.3 : 0.6)
        .setRestitution(0.05).setCollisionGroups(groups(GROUP.VEHICLE, GROUP.WORLD | GROUP.VEHICLE | 0xfff0)), this.body);
    ctx.physics.tagVehicle(this.collider, this);
    this.mass = def.mass;

    const nW = Math.max(1, def.wheels.length);
    this._k = (def.mass * 9.81) / (nW * Math.max(def.suspSag, 0.01));
    this._c = 2 * Math.sqrt(this._k * (def.mass / nW)) * def.suspDamp;
    this._yawInertia = (def.mass * (def.half[0] ** 2 + def.half[2] ** 2)) / 3;

    this.prevPos = new THREE.Vector3(spawn.x, y, spawn.z);
    this.curPos = this.prevPos.clone();
    this.prevQuat = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, spawn.yaw);
    this.curQuat = this.prevQuat.clone();
    /** Interpolated transform used by rendering, cameras and gameplay queries. */
    this.pos = this.prevPos.clone();
    this.quat = this.prevQuat.clone();
    this.vel = new THREE.Vector3();
    this._lastVel = new THREE.Vector3();

    this.visual = buildVehicleVisual(def, spawn.team, ctx.setupMaterial);
    if (ctx.scene) ctx.scene.add(this.visual.root);
    this._syncVisual();
  }

  _restHeight(x, z) {
    return Math.max(this.terrain.height(x, z), CONFIG.world.waterLevel - 0.4) + this.def.ride + 0.02;
  }

  get isAircraft() { return this.def.kind !== 'ground'; }

  /** Height of the hull bottom above the terrain. */
  get altitude() { return this.pos.y - this.def.ride - Math.max(this.terrain.height(this.pos.x, this.pos.z), CONFIG.world.waterLevel); }

  // --- Seats ----------------------------------------------------------------

  get driver() { return this.seats[0]; }
  get occupied() { for (let i = 0; i < this.seats.length; i++) if (this.seats[i]) return true; return false; }
  get occupants() { let n = 0; for (let i = 0; i < this.seats.length; i++) if (this.seats[i]) n++; return n; }
  hasFreeSeat() { for (let i = 0; i < this.seats.length; i++) if (!this.seats[i]) return true; return false; }
  /** A vehicle is boardable by a team when alive, not held by the enemy and not full. */
  boardableBy(team) { return this.alive && this.hasFreeSeat() && (!this.occupied || this.team === team); }

  /**
   * @param {import('./soldier.js').Soldier} s
   * @param {number} [prefer] seat to take when free
   * @returns {number} seat index or -1
   */
  enter(s, prefer = -1) {
    if (!this.boardableBy(s.team)) return -1;
    const i = prefer >= 0 && !this.seats[prefer] ? prefer : this.seats.indexOf(null);
    this.seats[i] = s;
    s.vehicle = this; s.seat = i;
    this.team = s.team;
    this.aimYaw[i] = s.yaw; this.aimPitch[i] = 0;
    this.seatWeapon[i] = 0;
    if (i === 0) {
      this.heading = this.yaw;
      if (this.def.kind === 'jet') this.controls.throttle = this.grounded ? 0 : 0.85;
    }
    this.body.wakeUp();
    this.ctx.bus.emit('vehicle:enter', this, s, i);
    return i;
  }

  /** Moves a soldier to the next free seat (cycling). */
  switchSeat(s) {
    const n = this.seats.length;
    for (let k = 1; k < n; k++) {
      const j = (s.seat + k) % n;
      if (this.seats[j]) continue;
      this.seats[s.seat] = null;
      this.seats[j] = s; s.seat = j;
      this.aimYaw[j] = s.yaw; this.aimPitch[j] = s.pitch;
      if (j === 0) this.heading = this.yaw;
      this.ctx.bus.emit('vehicle:enter', this, s, j);
      return true;
    }
    return false;
  }

  /** @param {import('./soldier.js').Soldier} s */
  exit(s) {
    if (s.vehicle !== this) return;
    const seat = s.seat;
    this.seats[seat] = null;
    s.vehicle = null; s.seat = -1;
    _left.set(1, 0, 0).applyQuaternion(this.quat);
    const airborne = this.isAircraft && this.altitude > 3;
    const off = airborne ? 0 : this.def.half[0] + 1.3;
    const sidePos = this.def.seats[seat].pos[0] >= 0 ? 1 : -1;
    s.pos.x = this.pos.x + _left.x * off * sidePos;
    s.pos.z = this.pos.z + _left.z * off * sidePos;
    s.pos.y = airborne ? this.pos.y - this.def.half[1] - 0.8 : Math.max(this.terrain.height(s.pos.x, s.pos.z), this.pos.y - this.def.ride);
    s.velY = airborne ? Math.min(0, this.vel.y) : 0;
    s.grounded = !airborne;
    // Bailing out of an aircraft deploys a parachute.
    s.parachute = airborne && this.altitude > 8;
    s.yaw = this.yaw;
    if (seat === 0) {
      const c = this.controls;
      c.steer = c.pitch = c.roll = c.yaw = c.collective = 0;
      c.throttle = this.def.kind === 'jet' ? c.throttle : 0;
    }
    this.ctx.bus.emit('vehicle:exit', this, s);
  }

  /**
   * Mounts a seat currently operates: its own, plus crew weapons that fall
   * back to it while their seat is empty (a lone driver still fights the gun).
   * @returns {number[]}
   */
  mountList(seat) {
    const from = this.def.fallbackFrom[seat];
    return from >= 0 && !this.seats[from] ? this.def.seatMountsFallback[seat] : this.def.seatMounts[seat];
  }

  /** Seat that operates mount `k` right now. */
  operatorSeat(k) {
    const m = this.def.mounts[k], base = m.coax !== undefined ? this.def.mounts[m.coax] : m;
    return this.seats[base.seat] || base.fallbackSeat === undefined ? base.seat : base.fallbackSeat;
  }

  /** Soldier operating mount `k` (or null). */
  operator(k) { return this.seats[this.operatorSeat(k)]; }

  /** Pops a flare salvo (aircraft); returns false while reloading or out. */
  deployFlares(time) {
    if (this.flares <= 0 || time < this.flareReadyAt) return false;
    this.flares--;
    this.flareUntil = time + 2.2;
    this.flareReadyAt = time + 4;
    this.ctx.bus.emit('flares', this);
    return true;
  }

  /** Mount index of the weapon a seat currently has selected (-1 = unarmed seat). */
  seatMount(seat) {
    const list = this.mountList(seat);
    if (!list || !list.length) return -1;
    return list[this.seatWeapon[seat] % list.length];
  }

  /** Cycles a seat's selected weapon; returns the new mount index. */
  cycleWeapon(seat) {
    const list = this.mountList(seat);
    if (!list || list.length < 2) return this.seatMount(seat);
    this.seatWeapon[seat] = (this.seatWeapon[seat] + 1) % list.length;
    return this.seatMount(seat);
  }

  /** Chassis yaw (heading of local +Z). */
  get yaw() {
    _fwd.set(0, 0, 1).applyQuaternion(this.quat);
    return Math.atan2(_fwd.x, _fwd.z);
  }

  /** World forward vector. @param {THREE.Vector3} out */
  forward(out) { return out.set(0, 0, 1).applyQuaternion(this.quat); }

  // --- Damage -----------------------------------------------------------------

  /** @param {number} amount @param {any} [attacker] */
  damage(amount, attacker) {
    if (!this.alive || amount <= 0) return;
    this.health -= amount;
    if (attacker) this.lastAttacker = attacker;
    if (this.health <= 0) this.destroy();
  }

  /** @param {number} amount hit points restored */
  repair(amount) {
    if (!this.alive) return false;
    if (this.health >= this.def.health) return false;
    this.health = Math.min(this.def.health, this.health + amount);
    return true;
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.wreckTimer = 14;
    this.visual.material.color.setScalar(0.22);
    this.ctx.bus.emit('vehicle:destroyed', this, this.lastAttacker);
  }

  /** Returns the vehicle to its spawn pad, fully repaired. */
  reset() {
    const s = this.spawn, y = this._restHeight(s.x, s.z);
    this.body.setEnabled(true);
    this.body.setTranslation({ x: s.x, y, z: s.z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(s.yaw / 2), z: 0, w: Math.cos(s.yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.health = this.def.health;
    this.alive = true;
    this.team = s.team;
    this.rotorSpeed = 0;
    this.heading = s.yaw;
    this.lastAttacker = null;
    this.idleTime = 0;
    this.controls.throttle = 0;
    this.mountYaw.fill(0); this.mountPitch.fill(0); this.seatWeapon.fill(0);
    this.flareUntil = 0; this.flareReadyAt = 0; this.flares = this.def.kind === 'ground' ? 0 : 6; this.smokeCooldown = 0; this.radarOn = false;
    for (const w of this.weapons) w.refill();
    this.visual.material.color.setScalar(1);
    this.visual.root.visible = true;
    this.teleported();
  }

  /** Call after moving the body directly: re-syncs state without registering a crash. */
  teleported() {
    const lv = this.body.linvel();
    this._lastVel.set(lv.x, lv.y, lv.z);
    this.capture();
    this.prevPos.copy(this.curPos); this.prevQuat.copy(this.curQuat);
    this.interpolate(1);
  }

  // --- Simulation -------------------------------------------------------------

  /** Applies drive, suspension and flight forces for one fixed step. */
  fixedUpdate(dt) {
    this.prevPos.copy(this.curPos);
    this.prevQuat.copy(this.curQuat);
    if (!this.body.isEnabled()) return;
    const k = this.def.kind;
    if (k === 'heli') stepHelicopter(this, dt);
    else if (k === 'jet') stepJet(this, dt);
    else {
      const driving = this.alive && this.driver !== null, c = this.controls;
      this.stepWheels(dt, driving ? c.throttle : 0, driving ? c.steer : 0, !driving || c.brake);
    }
    this._updateMounts(dt);
  }

  /**
   * Raycast suspension + tyre model (also the landing gear of jets).
   * @param {number} throttle -1..1 @param {number} steer -1..1 @param {boolean} brake
   */
  stepWheels(dt, throttle, steer, brake) {
    const body = this.body, def = this.def;
    if (body.isSleeping()) {
      if (!this.driver) return;
      body.wakeUp();
    }
    const t = body.translation(), q = body.rotation(), lv = body.linvel(), av = body.angvel();
    _q.set(q.x, q.y, q.z, q.w);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    const skid = def.maxSteer === 0;
    const fwdSpeed = lv.x * _fwd.x + lv.y * _fwd.y + lv.z * _fwd.z;
    this.speed = fwdSpeed;
    const steerAngle = skid ? 0 : steer * def.maxSteer / (1 + Math.abs(fwdSpeed) * 0.07);
    const nW = def.wheels.length;
    const maxLen = def.suspRest + def.wheelRadius;
    let grounded = 0;

    if (_up.y > 0.25) {
      for (let i = 0; i < nW; i++) {
        const w = def.wheels[i];
        _wp.set(w.pos[0], w.pos[1], w.pos[2]).applyQuaternion(_q);
        _r.copy(_wp);
        _wp.x += t.x; _wp.y += t.y; _wp.z += t.z;
        // Ray along -up against the heightfield (two fixed-point refinements).
        let dist = (_wp.y - this.terrain.height(_wp.x, _wp.z)) / _up.y;
        dist = (_wp.y - this.terrain.height(_wp.x - _up.x * dist, _wp.z - _up.z * dist)) / _up.y;
        if (dist >= maxLen) { this.wheelDist[i] = maxLen; continue; }
        grounded++;
        this.wheelDist[i] = Math.max(dist, def.wheelRadius * 0.6);
        _cp.copy(_wp).addScaledVector(_up, -dist);
        // Velocity of the anchor point: v + w x r.
        _vp.set(lv.x + av.y * _r.z - av.z * _r.y, lv.y + av.z * _r.x - av.x * _r.z, lv.z + av.x * _r.y - av.y * _r.x);
        const comp = Math.min(maxLen - dist, def.suspRest + 0.25);
        let load = this._k * comp - this._c * _vp.dot(_up);
        load = clamp(load, 0, this.mass * 9.81 * 2.2);
        _imp.x = _up.x * load * dt; _imp.y = _up.y * load * dt; _imp.z = _up.z * load * dt;
        _pt.x = _wp.x; _pt.y = _wp.y; _pt.z = _wp.z;
        body.applyImpulseAtPoint(_imp, _pt, true);

        // Tyre frame on the ground plane.
        this.terrain.normal(_cp.x, _cp.z, _n);
        _wf.copy(_fwd);
        if (w.steer && steerAngle !== 0) _wf.applyAxisAngle(_up, steerAngle);
        _wf.addScaledVector(_n, -_wf.dot(_n)).normalize();
        _ws.crossVectors(_n, _wf);
        const vF = _vp.dot(_wf);
        // Skid-steer hulls resist side slip at the hull, not per bogie, so they can pivot.
        const vS = skid ? lv.x * _ws.x + lv.y * _ws.y + lv.z * _ws.z : _vp.dot(_ws);

        let thr = throttle;
        if (skid) thr = clamp(throttle + (w.pos[0] > 0 ? -steer : steer) * 0.9, -1, 1);
        let force;
        if (brake) force = clamp(-vF * this.mass * 5, -def.brakeForce, def.brakeForce);
        else if (thr !== 0 && w.driven) {
          const dir = Math.sign(thr);
          const along = vF * dir;
          const topSpeed = dir > 0 ? def.maxSpeed : def.reverseSpeed;
          force = along < -0.6 ? dir * def.brakeForce : thr * def.engineForce * clamp(1.15 - along / topSpeed, 0, 1);
        } else force = clamp(-vF * this.mass * def.rolling, -def.brakeForce * 0.35, def.brakeForce * 0.35);
        let jF = (force / nW) * dt;
        let jS = -vS * (this.mass / nW) * def.lateralGrip;
        // Friction circle: the tyre can only transmit what its normal load allows.
        const budget = def.grip * load * dt;
        const want = Math.hypot(jF, jS);
        if (want > budget) { const k = budget / want; jF *= k; jS *= k; }
        _imp.x = _wf.x * jF + _ws.x * jS; _imp.y = _wf.y * jF + _ws.y * jS; _imp.z = _wf.z * jF + _ws.z * jS;
        // Apply most of the way up toward the CoM plane: keeps some body roll without flipping.
        const lift = ((t.x - _cp.x) * _up.x + (t.y - _cp.y) * _up.y + (t.z - _cp.z) * _up.z) * 0.72;
        _pt.x = _cp.x + _up.x * lift; _pt.y = _cp.y + _up.y * lift; _pt.z = _cp.z + _up.z * lift;
        body.applyImpulseAtPoint(_imp, _pt, true);
      }
    } else if (!this.occupied && this.alive && Math.abs(fwdSpeed) < 1 && this.def.kind === 'ground') {
      // Flipped and abandoned: quietly self-right so the vehicle is not lost for the match.
      this._flipTimer += dt;
      if (this._flipTimer > 4) { this._flipTimer = 0; this._selfRight(); }
    }
    this.grounded = grounded;
    this.wheelSpin += (fwdSpeed / Math.max(def.wheelRadius, 0.1)) * dt;
    this.steerAngle = steerAngle;

    if (skid && grounded >= 3) {
      const yawRate = av.x * _up.x + av.y * _up.y + av.z * _up.z;
      const target = steer * def.turnRate * (throttle < -0.1 ? -1 : 1);
      const j = (target - yawRate) * this._yawInertia * Math.min(1, 9 * dt);
      _imp.x = _up.x * j; _imp.y = _up.y * j; _imp.z = _up.z * j;
      body.applyTorqueImpulse(_imp, true);
    }
  }

  _selfRight() {
    const t = this.body.translation();
    const yaw = this.yaw;
    this.body.setTranslation({ x: t.x, y: this._restHeight(t.x, t.z) + 0.4, z: t.z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this._lastVel.set(0, 0, 0);
  }

  /** Slews each weapon mount toward its operator's requested world aim. */
  _updateMounts(dt) {
    const def = this.def;
    _qi.copy(this.curQuat).invert();
    for (let i = 0; i < def.mounts.length; i++) {
      const m = def.mounts[i];
      this.weapons[i].update(dt);
      if (m.coax !== undefined) { this.mountYaw[i] = this.mountYaw[m.coax]; this.mountPitch[i] = this.mountPitch[m.coax]; continue; }
      if (m.turnRate === 0) continue;
      const op = this.operatorSeat(i);
      if (!this.seats[op]) continue;
      const yaw = this.aimYaw[op], pitch = this.aimPitch[op];
      const cp = Math.cos(pitch);
      _v.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp).applyQuaternion(_qi);
      let wantYaw = Math.atan2(_v.x, _v.z);
      if (m.yawMin !== undefined) wantYaw = clamp(wantYaw, m.yawMin, /** @type {number} */ (m.yawMax));
      const wantPitch = clamp(Math.asin(clamp(_v.y, -1, 1)), m.pitchMin, m.pitchMax);
      this.mountYaw[i] = m.yawMin !== undefined
        ? this.mountYaw[i] + clamp(wantYaw - this.mountYaw[i], -m.turnRate * dt, m.turnRate * dt)
        : turnToward(this.mountYaw[i], wantYaw, m.turnRate * dt);
      this.mountPitch[i] += clamp(wantPitch - this.mountPitch[i], -m.turnRate * dt, m.turnRate * dt);
    }
  }

  /** How far (rad) mount `i` still is from its operator's requested aim. */
  aimError(i) {
    const m = this.def.mounts[i];
    if (m.turnRate === 0) return 0;
    const k = m.coax !== undefined ? m.coax : i;
    const seat = this.operatorSeat(k);
    _qi.copy(this.curQuat).invert();
    const yaw = this.aimYaw[seat], cp = Math.cos(this.aimPitch[seat]);
    _v.set(Math.sin(yaw) * cp, Math.sin(this.aimPitch[seat]), Math.cos(yaw) * cp).applyQuaternion(_qi);
    return Math.abs(angleDelta(this.mountYaw[k], Math.atan2(_v.x, _v.z)));
  }

  /**
   * World-space muzzle position and firing direction of mount `i` for the next
   * shot (multi-barrel mounts cycle through their muzzles).
   * @param {THREE.Vector3} outPos @param {THREE.Vector3} outDir
   */
  getMuzzle(i, outPos, outDir) {
    const def = this.def, m = def.mounts[i];
    const base = m.coax !== undefined ? def.mounts[m.coax] : m;
    const yaw = this.mountYaw[i], pitch = this.mountPitch[i], cp = Math.cos(pitch);
    // Yaw pivot (follows a parent turret's rotation when mounted on one).
    const p = /** @type {number[]} */ (base.pos);
    if (base.parent !== undefined) {
      const pp = /** @type {number[]} */ (def.mounts[base.parent].pos), py = this.mountYaw[base.parent];
      const dx = p[0] - pp[0], dz = p[2] - pp[2], c = Math.cos(py), s = Math.sin(py);
      _a.set(pp[0] + dx * c + dz * s, p[1], pp[2] - dx * s + dz * c);
    } else _a.set(p[0], p[1], p[2]);
    // Pitch frame: yaw about Y, then pitch (positive = up).
    _wq.setFromEuler(_we.set(-pitch, yaw, 0, 'YXZ'));
    const tr = base.trunnion || [0, 0, 0];
    _v.set(tr[0], tr[1], tr[2]).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    _a.add(_v);
    const list = m.muzzles, off = m.offset;
    let ox = 0, oy = 0, oz = 0;
    if (off) { ox += off[0]; oy += off[1]; oz += off[2]; }
    if (list && list.length) { const mz = list[this.weapons[i].shot % list.length]; ox += mz[0]; oy += mz[1]; oz += mz[2]; }
    _v.set(ox, oy, oz + (m.barrel || 0)).applyQuaternion(_wq);
    outPos.copy(_a).add(_v).applyQuaternion(this.quat).add(this.pos);
    outDir.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp).applyQuaternion(this.quat);
  }

  /** Captures the post-step transform and converts hard impacts into damage. */
  capture() {
    const t = this.body.translation(), q = this.body.rotation(), lv = this.body.linvel();
    this.curPos.set(t.x, t.y, t.z);
    this.curQuat.set(q.x, q.y, q.z, q.w);
    this.vel.set(lv.x, lv.y, lv.z);
    this.airspeed = this.vel.length();
    if (this.alive && this.body.isEnabled()) {
      const dv = Math.hypot(lv.x - this._lastVel.x, lv.y - this._lastVel.y, lv.z - this._lastVel.z);
      const threshold = this.def.kind === 'heli' ? 3.2 : this.def.kind === 'jet' ? 5 : 5.5;
      if (dv > threshold) this.damage((dv - threshold) * this.def.crashDamage);
      const half = this.terrain.half;
      const lost = this.isAircraft
        ? Math.max(Math.abs(t.x), Math.abs(t.z)) > half + CONFIG.match.airLimit
        : !this.terrain.inBounds(t.x, t.z, 3);
      // Drowned in deep water, or flown / driven off the edge of the world.
      if (t.y < -3 || lost) this.damage(1e6);
    }
    this._lastVel.set(lv.x, lv.y, lv.z);
  }

  /** Blends the two most recent physics states for jitter-free rendering. */
  interpolate(alpha) {
    this.pos.lerpVectors(this.prevPos, this.curPos, alpha);
    this.quat.slerpQuaternions(this.prevQuat, this.curQuat, alpha);
    this._syncVisual();
  }

  _syncVisual() {
    const vis = this.visual, def = this.def;
    vis.root.position.copy(this.pos);
    vis.root.quaternion.copy(this.quat);
    if (vis.wheels) {
      for (let i = 0; i < def.wheels.length; i++) {
        const w = def.wheels[i];
        _v.set(w.pos[0], w.pos[1] - (this.wheelDist[i] - def.wheelRadius), w.pos[2]);
        _wq.setFromEuler(_we.set(this.wheelSpin, w.steer ? this.steerAngle : 0, 0, 'YXZ'));
        _m4.compose(_v, _wq, _sc);
        vis.wheels.setMatrixAt(i, _m4);
      }
      vis.wheels.instanceMatrix.needsUpdate = true;
    }
    for (let i = 0; i < vis.mounts.length; i++) {
      const node = vis.mounts[i];
      if (!node) continue;
      const parent = def.mounts[i].parent;
      node.yaw.rotation.y = this.mountYaw[i] - (parent !== undefined ? this.mountYaw[parent] : 0);
      node.pitch.rotation.x = -this.mountPitch[i];
    }
  }

  /** Per-frame cosmetic update (rotors, radars, LOD). @param {number} camDistSq */
  updateVisual(dt, camDistSq) {
    const vis = this.visual;
    for (const r of vis.rotors) {
      const a = this.rotorSpeed * r.rate * r.dir * dt;
      if (r.axis === 'y') r.node.rotation.y += a; else r.node.rotation.x += a;
    }
    if (vis.spinners.length && this.alive && this.occupied) for (const s of vis.spinners) s.node.rotation.y += s.rate * dt;
    const near = camDistSq < 110 * 110;
    if (near !== this._detailOn) {
      this._detailOn = near;
      for (const d of vis.detail) d.visible = near;
    }
    // Wheels are a few pixels beyond 200 m: skip their draw call.
    if (vis.wheels) vis.wheels.visible = camDistSq < 200 * 200;
    // Shadows from distant vehicles cost a draw per cascade and are barely visible.
    const shadow = camDistSq < 140 * 140;
    if (shadow !== this._shadowOn) {
      this._shadowOn = shadow;
      for (const m of vis.casters) m.castShadow = shadow;
    }
  }

  serialize() {
    const p = this.curPos, q = this.curQuat;
    return { id: this.id, p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w], hp: this.health, alive: this.alive, team: this.team, rt: this.respawnTimer };
  }

  deserialize(d) {
    this.reset();
    this.body.setTranslation({ x: d.p[0], y: d.p[1], z: d.p[2] }, true);
    this.body.setRotation({ x: d.q[0], y: d.q[1], z: d.q[2], w: d.q[3] }, true);
    this.health = d.hp; this.team = d.team; this.respawnTimer = d.rt || 0;
    if (!d.alive) { this.alive = false; this.wreckTimer = 3; this.visual.material.color.setScalar(0.22); }
    this.teleported();
  }
}
