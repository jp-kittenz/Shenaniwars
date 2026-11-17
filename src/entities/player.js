import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { clamp, damp, angleDelta } from '../core/math.js';
import { MASK_LOS } from '../systems/physics.js';
import { FACTIONS } from './factions.js';
import { WEAPON_MODELS } from './models/weapon-models.js';
import { buildSoldierParts, mergeSkinned } from './models/soldier-model.js';
import { merge } from './models/kit.js';
import { BONE, RIG, holdWeapon, ik, limbMatrix } from './soldier-rig.js';
import { ballisticPitch } from './weapons.js';

const S = CONFIG.soldier;
const _look = { x: 0, y: 0 };
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rh = new THREE.Vector3(), _lh = new THREE.Vector3(), _el = new THREE.Vector3(), _hd = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _W = new THREE.Matrix4(), _MAG = new THREE.Matrix4(), _T = new THREE.Matrix4();
const FP_FWD = new THREE.Vector3(0, 0, 1);
// First-person shoulders sit low and wide so only forearms and gloves enter the frame.
const SH_R = new THREE.Vector3(-0.21, -0.36, -0.06), SH_L = new THREE.Vector3(0.24, -0.38, 0.02);
const _hold = { reloadT: -1, empty: false, loaded: true, sprint: 0, low: 0, kick: 0, ads: 0, fp: true };
const _proj = new THREE.Vector3();

/**
 * Translates input into the player soldier's actions (on foot and in every
 * vehicle seat) and drives the camera: first person with a rigged view model,
 * chase / orbit cameras in vehicles, a flight camera for jets, and a death cam.
 */
export class PlayerController {
  /**
   * @param {import('../systems/game.js').Game} game
   * @param {import('./soldier.js').Soldier} soldier
   */
  constructor(game, soldier) {
    this.game = game;
    this.recoil = 0;
    this.kick = 0;
    this.shake = 0;
    this.adsT = 0;
    this.bob = 0;
    this.camYaw = 0;
    this.camPitch = 0;
    /** Mount index of the vehicle weapon the player operates this frame (-1 = none). */
    this.mount = -1;
    /** @type {import('./vehicle.js').Vehicle|null} */
    this.nearVehicle = null;
    /** Current missile lock target (aircraft) for homing weapons. */
    this.lock = null;
    this.lockTime = 0;
    /** Range to the artillery aim point (m), or 0. */
    this.artyRange = 0;
    /** Screen-space boresight (NDC) for fixed aircraft weapons, or null. */
    this.boresight = null;
    this._deathCam = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._resupply = 0;
    this._flashT = 0;
    this._triggerHeld = false;

    this.viewRoot = new THREE.Group();
    this.viewRoot.rotation.y = Math.PI;
    game.render.camera.add(this.viewRoot);
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3.6, 1.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide }));
    this.flash.visible = false;
    this.flash.matrixAutoUpdate = false;
    this.viewRoot.add(this.flash);
    /** @type {Record<string, any>} view-model kits per faction */
    this._kits = {};
    this.s = soldier;
    this.setSoldier(soldier);

    game.bus.on('shake', (x, y, z, radius) => {
      const d = this._camPos.distanceTo(_v.set(x, y, z));
      this.shake = Math.max(this.shake, clamp(1.6 - d / (radius * 5), 0, 1));
    });
    game.bus.on('player:damaged', (amount) => { this.shake = Math.max(this.shake, clamp(amount / 60, 0.15, 0.6)); });
  }

  /** Switches control to another soldier (team change) and rebuilds the view model. */
  setSoldier(s) {
    this.s = s;
    const factionId = CONFIG.teams[s.team].faction;
    for (const k in this._kits) this._kits[k].root.visible = false;
    if (!this._kits[factionId]) this._kits[factionId] = this._buildKit(factionId, s.team);
    this.kit = this._kits[factionId];
  }

  /** Arms (sleeves + gloves) and the faction's weapons as separate meshes for the view model. */
  _buildKit(factionId, team) {
    const root = new THREE.Group();
    this.viewRoot.add(root);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const bones = buildSoldierParts(factionId, team, 0);
    const mk = (geo) => {
      const m = new THREE.Mesh(geo, mat);
      m.matrixAutoUpdate = false;
      m.frustumCulled = false;
      root.add(m);
      return m;
    };
    const arms = {};
    for (const b of [BONE.UARM_L, BONE.FARM_L, BONE.UARM_R, BONE.FARM_R]) arms[b] = mk(mergeSkinned([bones[b]]));
    // Upper arms would fill the lower screen right in front of the camera; the forearms tell the story.
    arms[BONE.UARM_L].visible = false;
    arms[BONE.UARM_R].visible = false;
    const f = FACTIONS[factionId];
    const weapons = {};
    for (const id of new Set([...f.rifles, f.launcher])) {
      const g = WEAPON_MODELS[id].build(0);
      weapons[id] = { body: mk(merge(g.body)), mag: mk(merge(g.mag)) };
    }
    return { root, arms, weapons };
  }

  /** True while the camera is inside the player's head. */
  get firstPerson() { return this.s.alive && !this.s.vehicle; }

  /** @param {number} dt */
  update(dt) {
    const g = this.game, s = this.s, input = g.input;
    input.consumeLook(_look);
    this.mount = -1;
    this.boresight = null;
    this.artyRange = 0;
    if (!s.alive) { s.moveX = s.moveZ = 0; this.nearVehicle = null; this.lock = null; return; }
    const adsScale = 1 - 0.55 * this.adsT;
    if (s.vehicle) this._updateVehicle(dt, adsScale);
    else this._updateFoot(dt, adsScale);
  }

  _updateFoot(dt, adsScale) {
    const g = this.game, s = this.s, input = g.input;
    s.yaw -= _look.x * adsScale;
    s.pitch = clamp(s.pitch - _look.y * adsScale, -1.45, 1.45);
    this.lock = null;

    const w = s.weapon;
    const ads = input.ads && !w.reloading;
    this.adsT = damp(this.adsT, ads ? 1 : 0, 14, dt);
    const sprinting = input.sprint && !ads && !input.fire;
    s.sprinting = sprinting;
    s.alert = true;
    const speed = (sprinting ? S.sprintSpeed : S.walkSpeed) * (ads ? 0.55 : 1);
    const sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
    // forward = (sin, cos), right = (-cos, sin)
    s.moveX = (sy * input.moveY - cy * input.moveX) * speed;
    s.moveZ = (cy * input.moveY + sy * input.moveX) * speed;
    if (input.take('jump')) s.jump();
    if (input.take('reload') && w.startReload()) g.bus.emit('sound', 'reload');
    if (input.take('swap') && s.weapons.length > 1) { s.weaponIdx = (s.weaponIdx + 1) % s.weapons.length; this.kick = 0.6; }
    input.take('seat');

    // Contextual vehicle entry.
    this.nearVehicle = g.vehicles.nearestBoardable(s.pos, s.team, 7.5, (v) => !v.isAircraft || v.altitude < 2);
    if (input.take('interact') && this.nearVehicle && this.nearVehicle.enter(s) >= 0) {
      this.camYaw = s.yaw;
      this.camPitch = 0;
      this.adsT = 0;
      return;
    }

    if (input.fire && !sprinting && (w.def.auto || !this._triggerHeld)) {
      s.eye(_eye);
      s.aimDir(_dir);
      const moving = s.speed > 1 ? 1.8 : 1;
      if (g.combat.fire(s, w, _eye, _dir, (ads ? 0.35 : 1.6) * moving * (s.grounded ? 1 : 2.5))) {
        const heavy = w.def.type === 'projectile';
        const rec = w.def.recoil || 0.0065;
        this.recoil += rec * (heavy ? 1 : 1.6);
        s.pitch = Math.min(1.45, s.pitch + rec);
        s.yaw += (Math.random() - 0.5) * rec * 0.9;
        this.kick = heavy ? 1.6 : 1;
        this._flashT = heavy ? 0 : 0.045;
      }
    }
    this._triggerHeld = input.fire;

    // Resupply at friendly flags.
    this._resupply -= dt;
    if (this._resupply <= 0) {
      this._resupply = 1;
      for (const f of g.capture.flags) {
        if (f.owner !== s.team || (f.x - s.pos.x) ** 2 + (f.z - s.pos.z) ** 2 > 14 * 14) continue;
        let need = false;
        for (const ws of s.weapons) if (ws.reserve < ws.def.reserve) { ws.reserve = ws.def.reserve; need = true; }
        if (need) g.bus.emit('notice', 'AMMO RESUPPLIED');
      }
    }
  }

  _updateVehicle(dt, adsScale) {
    const g = this.game, s = this.s, input = g.input;
    const v = /** @type {import('./vehicle.js').Vehicle} */ (s.vehicle);
    const def = v.def, c = v.controls;
    this.nearVehicle = null;
    s.alert = true; s.sprinting = false;
    input.take('jump'); input.take('reload');
    if (input.take('interact')) {
      v.exit(s);
      s.pitch = 0;
      this.adsT = 0;
      return;
    }
    if (input.take('seat')) v.switchSeat(s);
    if (input.take('swap')) {
      const m = v.cycleWeapon(s.seat);
      if (m >= 0) g.bus.emit('notice', v.weapons[m].def.name);
    }
    let mount = v.seatMount(s.seat);
    const pilot = s.seat === 0 && def.kind !== 'ground';
    const canAim = mount >= 0 && def.mounts[mount].turnRate > 0;
    this.adsT = damp(this.adsT, canAim && input.ads ? 1 : 0, 10, dt);

    if (pilot && def.kind === 'heli') {
      // Left thumb: cyclic (pitch/roll). Right thumb: yaw + collective.
      c.pitch = input.moveY; c.roll = input.moveX;
      c.yaw = -input.stickX; c.collective = input.stickY;
      s.yaw = v.yaw; s.pitch = 0;
    } else if (pilot) {
      // Jets: left thumb flies (pitch / roll), right thumb is rudder and throttle.
      c.pitch = input.moveY; c.roll = input.moveX;
      c.yaw = -input.stickX;
      c.throttle = clamp(c.throttle + input.stickY * 0.7 * dt, 0, 1);
      c.brake = false;
      s.yaw = v.yaw; s.pitch = 0;
    } else {
      s.yaw -= _look.x * adsScale;
      s.pitch = clamp(s.pitch - _look.y * adsScale, -1.2, 1.2);
      if (s.seat === 0) {
        c.throttle = input.moveY; c.steer = -input.moveX;
        c.brake = input.jumpHeld;
      }
    }
    this.mount = mount;
    if (mount < 0) { this.lock = null; this._triggerHeld = input.fire; return; }
    const m = def.mounts[mount], w = v.weapons[mount], wdef = w.def;
    const cam = g.render.camera;
    cam.getWorldDirection(_dir);
    if (m.turnRate > 0) {
      // Converge the seat's weapon on what the crosshair is looking at.
      const reach = g.physics.castRay(cam.position.x, cam.position.y, cam.position.z, _dir.x, _dir.y, _dir.z, wdef.artillery ? wdef.range : 450, MASK_LOS, v.body).toi;
      _v.copy(cam.position).addScaledVector(_dir, Math.max(reach, 25));
      const pp = m.coax !== undefined ? def.mounts[m.coax] : m;
      _pos.set(pp.pos[0], pp.pos[1], pp.pos[2]).applyQuaternion(v.quat).add(v.pos);
      const dx = _v.x - _pos.x, dy = _v.y - _pos.y, dz = _v.z - _pos.z, flat = Math.hypot(dx, dz);
      let pitch = Math.atan2(dy, flat);
      if (wdef.artillery) {
        const p = ballisticPitch(flat, dy, /** @type {number} */ (wdef.speed), /** @type {number} */ (wdef.gravity), false);
        pitch = Number.isNaN(p) ? 0.78 : p;
        this.artyRange = Math.round(flat);
      }
      const seatOf = v.operatorSeat(mount);
      v.aimYaw[seatOf] = Math.atan2(dx, dz);
      v.aimPitch[seatOf] = pitch;
    }
    // Missile lock: the enemy aircraft nearest the crosshair / boresight.
    if (wdef.homing === 'air') this._updateLock(v, mount, dt); else this.lock = null;
    if (m.turnRate === 0 && pilot) this._boresight(v, mount);
    if (input.fire && (wdef.auto || !this._triggerHeld)) {
      v.getMuzzle(mount, _pos, _v);
      const lock = this.lock && this.lockTime > 0.8 ? this.lock : null;
      if (g.combat.fire(s, w, _pos, _v, 1, { vehicle: v, mount, lock })) {
        this.shake = Math.max(this.shake, wdef.type === 'projectile' ? 0.35 : 0.06);
      } else if (wdef.homing === 'air' && !lock && !this._triggerHeld) g.bus.emit('notice', 'NO LOCK');
    }
    this._triggerHeld = input.fire;
  }

  _updateLock(v, mount, dt) {
    const g = this.game, def = v.weapons[mount].def, range = def.lockRange || def.range;
    const cam = g.render.camera;
    if (def.homing !== 'air') { this.lock = null; return; }
    const fixed = v.def.mounts[mount].turnRate === 0;
    if (fixed) v.forward(_fwd); else cam.getWorldDirection(_fwd);
    const origin = fixed ? v.pos : cam.position;
    let best = null, bestDot = Math.cos(0.26);
    for (const o of g.vehicles.list) {
      if (!o.alive || !o.isAircraft || !o.occupied || o.team === this.s.team) continue;
      _v.subVectors(o.pos, origin);
      const d = _v.length();
      if (d > range || d < 30) continue;
      const dot = _v.dot(_fwd) / d;
      if (dot > bestDot) { bestDot = dot; best = o; }
    }
    if (best !== this.lock) { this.lock = best; this.lockTime = 0; if (best) g.bus.emit('sound', 'lock'); }
    else if (best) this.lockTime += dt;
  }

  /** Projects where a fixed weapon points onto the screen (aircraft gunsight). */
  _boresight(v, mount) {
    const cam = this.game.render.camera;
    v.getMuzzle(mount, _pos, _v);
    _proj.copy(_pos).addScaledVector(_v, 300).project(cam);
    this.boresight = _proj.z < 1 ? { x: _proj.x, y: _proj.y } : null;
  }

  /** Poses the first-person arms and weapon. */
  _poseViewModel(dt) {
    const s = this.s, w = s.weapon, kit = this.kit;
    const model = WEAPON_MODELS[w.id];
    const sway = Math.sin(this.bob) * 0.012 * (1 - this.adsT);
    _hold.reloadT = w.reloading ? w.reloadProgress : -1;
    _hold.empty = w.reloadEmpty;
    _hold.loaded = w.ammo > 0;
    _hold.sprint = s.sprinting && s.speed > 5 ? 1 : 0;
    _hold.low = 0;
    _hold.kick = Math.min(1, this.kick);
    _hold.ads = this.adsT;
    holdWeapon(model, _hold, _W, _MAG, _rh, _lh);
    // Bob and sway ride on top of the hold.
    _T.makeTranslation(sway, -Math.abs(sway) * 0.6, 0);
    _W.premultiply(_T); _MAG.premultiply(_T); _rh.applyMatrix4(_T); _lh.applyMatrix4(_T);
    const magState = _hold.reloadT >= 0
      ? (model.kind === 'launcher' ? (_hold.reloadT < 0.24 ? 'hidden' : 'shown') : (_hold.reloadT >= 0.36 && _hold.reloadT < 0.42 ? 'hidden' : 'shown'))
      : (model.kind === 'launcher' && w.ammo <= 0 ? 'hidden' : 'shown');
    for (const id in kit.weapons) {
      const e = kit.weapons[id], on = id === w.id;
      e.body.visible = on; e.mag.visible = on && magState === 'shown';
      if (on) { e.body.matrix.copy(_W); e.mag.matrix.copy(_MAG); }
    }
    for (const [sh, hand, ub, fb, side] of [[SH_L, _lh, BONE.UARM_L, BONE.FARM_L, 1], [SH_R, _rh, BONE.UARM_R, BONE.FARM_R, -1]]) {
      _pole.copy(sh).add(_v.set(side * 0.35, -0.5, -0.1));
      ik(sh, hand, RIG.upperArm, RIG.foreArm, _pole, _el, _hd);
      limbMatrix(sh, _el, FP_FWD, kit.arms[ub].matrix);
      limbMatrix(_el, _hd, FP_FWD, kit.arms[fb].matrix);
    }
    if (this._flashT > 0) {
      this._flashT -= dt;
      this.flash.visible = this._flashT > 0;
      this.flash.matrix.copy(_W).multiply(_T.makeTranslation(model.muzzle[0], model.muzzle[1], model.muzzle[2] + 0.06))
        .multiply(_T.makeRotationZ(Math.random() * 6.28));
    } else this.flash.visible = false;
  }

  /** Positions the camera; call after vehicles are interpolated and soldiers moved. */
  updateCamera(dt) {
    const g = this.game, s = this.s, cam = g.render.camera, terrain = g.map.terrain;
    this.recoil = damp(this.recoil, 0, 9, dt);
    this.kick = damp(this.kick, 0, 16, dt);
    this.shake = damp(this.shake, 0, 5, dt);
    let fov = g.render.baseFov;
    const showVM = s.alive && !s.vehicle;
    this.viewRoot.visible = showVM;
    for (const k in this._kits) this._kits[k].root.visible = showVM && this._kits[k] === this.kit;

    if (!s.alive) {
      // Death cam: drift up and look down at where we fell.
      this._deathCam.y += dt * 2.2;
      cam.position.lerp(_v.copy(this._deathCam).add(_pos.set(0, 6, -7)), 1 - Math.exp(-2 * dt));
      cam.lookAt(this._deathCam.x, this._deathCam.y - 4, this._deathCam.z);
    } else if (!s.vehicle) {
      this._deathCam.set(s.pos.x, s.pos.y + 1, s.pos.z);
      this.bob += s.speed * dt * (s.grounded ? 1.6 : 0);
      const bobY = Math.sin(this.bob * 2) * 0.035 * Math.min(1, s.speed / 4) * (1 - this.adsT);
      cam.position.set(s.pos.x, s.pos.y + S.eyeHeight + bobY, s.pos.z);
      cam.rotation.set(s.pitch + this.recoil, s.yaw + Math.PI, 0, 'YXZ');
      const zoom = s.weapon.def.zoom || 50;
      fov += (zoom - fov) * this.adsT;
      this._poseViewModel(dt);
    } else {
      const v = s.vehicle, def = v.def;
      this._deathCam.copy(v.pos);
      const pilot = s.seat === 0 && def.kind !== 'ground';
      let yaw = s.yaw, pitch = s.pitch;
      if (pilot) {
        v.forward(_fwd);
        const noseYaw = def.kind === 'jet' ? Math.atan2(_fwd.x, _fwd.z) : v.yaw;
        const nosePitch = def.kind === 'jet' ? clamp(Math.asin(clamp(_fwd.y, -1, 1)), -0.9, 0.9) : 0;
        // The chase camera trails the airframe with a little lag so manoeuvres read well.
        this.camYaw += angleDelta(this.camYaw, noseYaw) * (1 - Math.exp(-(def.kind === 'jet' ? 6 : 4.5) * dt));
        this.camPitch += (nosePitch - this.camPitch) * (1 - Math.exp(-5 * dt));
        yaw = this.camYaw; pitch = this.camPitch - 0.12;
      } else this.camYaw = yaw;
      const cp = Math.cos(pitch);
      _fwd.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
      const dist = def.camDist * (1 - this.adsT * 0.35);
      _pos.copy(v.pos).addScaledVector(_fwd, -dist);
      _pos.y += def.camHeight;
      const floor = Math.max(terrain.height(_pos.x, _pos.z), 0) + 0.8;
      if (_pos.y < floor) _pos.y = floor;
      cam.position.copy(_pos);
      _v.copy(v.pos).addScaledVector(_fwd, 30);
      _v.y += def.camHeight * 0.55;
      cam.lookAt(_v);
      fov -= 34 * this.adsT;
    }
    if (this.shake > 0.01) {
      cam.rotation.x += (Math.random() - 0.5) * 0.035 * this.shake;
      cam.rotation.y += (Math.random() - 0.5) * 0.035 * this.shake;
      cam.rotation.z = (Math.random() - 0.5) * 0.03 * this.shake;
    } else cam.rotation.z = 0;
    g.render.setFov(fov);
    this._camPos.copy(cam.position);
  }
}
