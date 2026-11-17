import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { clamp, damp, angleDelta } from '../core/math.js';
import { box, cyl, merge } from '../world/geo.js';
import { MASK_LOS } from '../systems/physics.js';

const S = CONFIG.soldier;
const _look = { x: 0, y: 0 };
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * Translates input into the player soldier's actions (on foot and in every
 * vehicle seat) and drives the camera: first-person with a view-model on
 * foot, a chase/orbit rig in vehicles, and a rising death cam.
 */
export class PlayerController {
  /**
   * @param {import('../systems/game.js').Game} game
   * @param {import('./soldier.js').Soldier} soldier
   */
  constructor(game, soldier) {
    this.game = game;
    this.s = soldier;
    this.recoil = 0;
    this.kick = 0;
    this.shake = 0;
    this.adsT = 0;
    this.bob = 0;
    this.camYaw = 0;
    /** @type {import('./vehicle.js').Vehicle|null} */
    this.nearVehicle = null;
    this._deathCam = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._resupply = 0;

    // First-person view-models (one per carried weapon), parented to the camera.
    const mat = game.render.setupMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const rifle = new THREE.Mesh(merge([
      box(0.06, 0.09, 0.62, 0, 0, -0.3, 0x1c1f22), box(0.05, 0.16, 0.1, 0, -0.11, -0.12, 0x1c1f22), box(0.05, 0.2, 0.08, 0, -0.13, -0.33, 0x2b2f33, 0.25),
      cyl(0.014, 0.014, 0.32, 6, 0, 0.01, -0.74, 0x3a3f44, Math.PI / 2), box(0.055, 0.08, 0.26, 0, -0.01, 0.1, 0x3b2f22),
      box(0.03, 0.04, 0.05, 0, 0.065, -0.5, 0x1c1f22), box(0.04, 0.045, 0.1, 0, 0.068, -0.14, 0x1c1f22),
    ]), mat);
    const launcher = new THREE.Mesh(merge([
      cyl(0.065, 0.065, 1.1, 8, 0, 0, -0.35, 0x4d5a3c, Math.PI / 2), cyl(0.085, 0.07, 0.16, 8, 0, 0, -0.95, 0x2b2f33, Math.PI / 2),
      box(0.05, 0.16, 0.07, 0, -0.13, -0.3, 0x1c1f22), box(0.04, 0.09, 0.14, 0.06, 0.1, -0.35, 0x1c1f22),
    ]), mat);
    this.viewModels = [rifle, launcher];
    this.viewRoot = new THREE.Group();
    this.viewRoot.add(rifle, launcher);
    game.render.camera.add(this.viewRoot);
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3.6, 1.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }));
    this.flash.position.set(0, 0.01, -0.95);
    this.flash.visible = false;
    this.viewRoot.add(this.flash);

    game.bus.on('shake', (x, y, z, radius) => {
      const d = this._camPos.distanceTo(_v.set(x, y, z));
      this.shake = Math.max(this.shake, clamp(1.6 - d / (radius * 5), 0, 1));
    });
    game.bus.on('player:damaged', (amount) => { this.shake = Math.max(this.shake, clamp(amount / 60, 0.15, 0.6)); });
  }

  /** True while the camera is inside the player's head. */
  get firstPerson() { return this.s.alive && !this.s.vehicle; }

  /** @param {number} dt */
  update(dt) {
    const g = this.game, s = this.s, input = g.input;
    input.consumeLook(_look);
    /** Index of the vehicle weapon mount the player operates this frame (-1 = none). */
    this.mount = -1;
    if (!s.alive) { s.moveX = s.moveZ = 0; this.nearVehicle = null; return; }
    const adsScale = 1 - 0.5 * this.adsT;
    if (s.vehicle) this._updateVehicle(dt, adsScale);
    else this._updateFoot(dt, adsScale);
  }

  _updateFoot(dt, adsScale) {
    const g = this.game, s = this.s, input = g.input;
    s.yaw -= _look.x * adsScale;
    s.pitch = clamp(s.pitch - _look.y * adsScale, -1.45, 1.45);

    const ads = input.ads && !s.weapon.reloading;
    this.adsT = damp(this.adsT, ads ? 1 : 0, 14, dt);
    const sprinting = input.sprint && !ads && !input.fire;
    const speed = (sprinting ? S.sprintSpeed : S.walkSpeed) * (ads ? 0.55 : 1);
    const sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
    // forward = (sin, cos), right = (-cos, sin)
    s.moveX = (sy * input.moveY - cy * input.moveX) * speed;
    s.moveZ = (cy * input.moveY + sy * input.moveX) * speed;
    if (input.take('jump')) s.jump();
    if (input.take('reload') && s.weapon.startReload()) g.bus.emit('sound', 'reload');
    if (input.take('swap')) { s.weaponIdx = (s.weaponIdx + 1) % s.weapons.length; this.kick = 0.6; }
    input.take('seat');

    // Contextual vehicle entry.
    this.nearVehicle = g.vehicles.nearestBoardable(s.pos, s.team, 6.5);
    if (input.take('interact') && this.nearVehicle && this.nearVehicle.enter(s) >= 0) {
      this.camYaw = s.yaw;
      this.adsT = 0;
      return;
    }

    const w = s.weapon;
    if (input.fire && (w.def.auto || !this._triggerHeld)) {
      s.eye(_eye);
      s.aimDir(_dir);
      const moving = s.speed > 1 ? 1.8 : 1;
      if (g.combat.fire(s, w, _eye, _dir, (ads ? 0.35 : 1.6) * moving * (s.grounded ? 1 : 2.5))) {
        const heavy = w.def.type === 'projectile';
        this.recoil += heavy ? 0.05 : 0.011;
        s.pitch = Math.min(1.45, s.pitch + (heavy ? 0.03 : 0.0065));
        s.yaw += (Math.random() - 0.5) * 0.006;
        this.kick = heavy ? 1.6 : 1;
        this.flash.visible = !heavy;
        this.flash.rotation.z = Math.random() * 6.28;
        this._flashT = 0.045;
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
    this.adsT = damp(this.adsT, 0, 14, dt);
    this.nearVehicle = null;
    input.take('jump'); input.take('reload'); input.take('swap');
    if (input.take('interact')) {
      v.exit(s);
      s.pitch = 0;
      return;
    }
    if (input.take('seat')) v.switchSeat(s);
    const heliPilot = def.kind === 'heli' && s.seat === 0;
    if (heliPilot) {
      // Left thumb: cyclic (pitch/roll). Right thumb: yaw + collective.
      c.pitch = input.moveY; c.roll = input.moveX;
      c.yaw = -input.stickX; c.collective = input.stickY;
      s.yaw = v.yaw; s.pitch = 0;
    } else {
      s.yaw -= _look.x * adsScale;
      s.pitch = clamp(s.pitch - _look.y * adsScale, -0.9, 0.9);
      if (s.seat === 0) {
        c.throttle = input.moveY; c.steer = -input.moveX;
        c.brake = input.jumpHeld;
      }
    }
    // Converge the seat's weapon on what the crosshair is looking at.
    let mount = -1;
    for (let i = 0; i < def.mounts.length; i++) if (def.mounts[i].seat === s.seat) mount = i;
    this.mount = mount;
    if (mount >= 0) {
      const cam = g.render.camera;
      cam.getWorldDirection(_dir);
      const reach = g.physics.castRay(cam.position.x, cam.position.y, cam.position.z, _dir.x, _dir.y, _dir.z, 400, MASK_LOS, v.body).toi;
      _v.copy(cam.position).addScaledVector(_dir, Math.max(reach, 25));
      const m = def.mounts[mount];
      _pos.set(m.pos[0], m.pos[1], m.pos[2]).applyQuaternion(v.quat).add(v.pos);
      const dx = _v.x - _pos.x, dy = _v.y - _pos.y, dz = _v.z - _pos.z;
      v.aimYaw[s.seat] = Math.atan2(dx, dz);
      v.aimPitch[s.seat] = Math.atan2(dy, Math.hypot(dx, dz));
      const w = v.weapons[mount];
      if (input.fire && (w.def.auto || !this._triggerHeld)) {
        v.getMuzzle(mount, _pos, _dir);
        if (g.combat.fire(s, w, _pos, _dir, 1)) this.shake = Math.max(this.shake, w.def.type === 'projectile' ? 0.35 : 0.06);
      }
    }
    this._triggerHeld = input.fire;
  }

  /** Positions the camera; call after vehicles are interpolated and soldiers moved. */
  updateCamera(dt) {
    const g = this.game, s = this.s, cam = g.render.camera, terrain = g.map.terrain;
    this.recoil = damp(this.recoil, 0, 9, dt);
    this.kick = damp(this.kick, 0, 16, dt);
    this.shake = damp(this.shake, 0, 5, dt);
    if (this._flashT > 0 && (this._flashT -= dt) <= 0) this.flash.visible = false;
    let fov = g.render.baseFov;

    if (!s.alive) {
      // Death cam: drift up and look down at where we fell.
      this._deathCam.y += dt * 2.2;
      cam.position.lerp(_v.copy(this._deathCam).add(_pos.set(0, 6, -7)), 1 - Math.exp(-2 * dt));
      cam.lookAt(this._deathCam.x, this._deathCam.y - 4, this._deathCam.z);
      this.viewRoot.visible = false;
    } else if (!s.vehicle) {
      this._deathCam.set(s.pos.x, s.pos.y + 1, s.pos.z);
      this.bob += s.speed * dt * (s.grounded ? 1.6 : 0);
      const bobY = Math.sin(this.bob * 2) * 0.035 * Math.min(1, s.speed / 4) * (1 - this.adsT);
      cam.position.set(s.pos.x, s.pos.y + S.eyeHeight + bobY, s.pos.z);
      cam.rotation.set(s.pitch + this.recoil, s.yaw + Math.PI, 0, 'YXZ');
      fov -= 24 * this.adsT * (s.weaponIdx === 0 ? 1 : 0.4);

      this.viewRoot.visible = true;
      for (let i = 0; i < this.viewModels.length; i++) this.viewModels[i].visible = i === s.weaponIdx;
      const sway = Math.sin(this.bob) * 0.012 * (1 - this.adsT);
      const reload = s.weapon.reloading ? 0.16 : 0;
      this.viewRoot.position.set(0.19 * (1 - this.adsT) + sway, -0.17 + 0.065 * this.adsT - reload - Math.abs(sway) * 0.5, -0.32 + this.kick * 0.045 + 0.05 * this.adsT);
      this.viewRoot.rotation.set(this.kick * 0.035 - reload * 2.2, 0, 0);
    } else {
      const v = s.vehicle;
      this._deathCam.copy(v.pos);
      this.viewRoot.visible = false;
      const def = v.def;
      let yaw = s.yaw, pitch = s.pitch;
      if (def.kind === 'heli' && s.seat === 0) {
        // Chase cam trails the airframe's heading with a little lag so banking reads well.
        this.camYaw += angleDelta(this.camYaw, v.yaw) * (1 - Math.exp(-4.5 * dt));
        yaw = this.camYaw; pitch = -0.12;
      } else this.camYaw = yaw;
      const cp = Math.cos(pitch);
      _fwd.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
      _pos.copy(v.pos).addScaledVector(_fwd, -def.camDist);
      _pos.y += def.camHeight;
      const floor = terrain.height(_pos.x, _pos.z) + 0.8;
      if (_pos.y < floor) _pos.y = floor;
      cam.position.copy(_pos);
      _v.copy(v.pos).addScaledVector(_fwd, 30);
      _v.y += def.camHeight * 0.55;
      cam.lookAt(_v);
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
