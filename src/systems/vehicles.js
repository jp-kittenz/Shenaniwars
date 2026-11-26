import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { Vehicle } from '../entities/vehicle.js';
import { telState, telUpdate } from '../entities/tel-launch.js';
import { VEHICLE_DEFS } from '../entities/vehicle-defs.js';

/**
 * Owns every vehicle: fixed-step simulation, render interpolation, wreck
 * clean-up and respawning at the home pad.
 */
const _hold = new THREE.Vector3(), _foot = new THREE.Vector3(), _o = new THREE.Vector3(), _e = new THREE.Euler(), _qq = new THREE.Quaternion();
const _qi = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0);

const DUST_EARTH = [0.52, 0.43, 0.31], DUST_FIELD = [0.6, 0.53, 0.38], DUST_GREEN = [0.46, 0.43, 0.32], DUST_GRAVEL = [0.55, 0.53, 0.5];
export class VehicleSystem {
  /** @param {import('./game.js').Game} game */
  constructor(game) {
    this.game = game;
    // (time: the game clock, kept current every frame; vehicles' door queues and timers read it)
    const ctx = {
      physics: game.physics, terrain: game.map.terrain, bus: game.bus,
      scene: game.render.scene, setupMaterial: game.render.setupMaterial, time: 0,
    };
    this.ctx = ctx;
    /** @type {Vehicle[]} */
    // Faction vehicles first, then the static emplacements (turrets, AA guns, searchlights).
    const spawns = game.map.vehicleSpawns.concat(game.map.emplacements || []);
    this.list = spawns.map((s, i) => new Vehicle(ctx, VEHICLE_DEFS[s.type], s, i));
    this._smoke = 0;
    game.bus.on('flares', (v) => game.particles.flares(v.pos.x, v.pos.y - 0.5, v.pos.z, v.vel.x, v.vel.y, v.vel.z));
    // Fast-ropes: one dynamic line batch (two ropes per helicopter, up to four helicopters).
    const ropeGeo = new THREE.BufferGeometry();
    this._ropePos = new Float32Array(16 * 3);
    ropeGeo.setAttribute('position', new THREE.BufferAttribute(this._ropePos, 3).setUsage(THREE.DynamicDrawUsage));
    ropeGeo.setDrawRange(0, 0);
    this._ropes = new THREE.LineSegments(ropeGeo, new THREE.LineBasicMaterial({ color: 0x2b2a24 }));
    this._ropes.frustumCulled = false;
    game.render.scene.add(this._ropes);
  }

  /** Updates fast-rope lines hanging from hovering helicopters. */
  _updateRopes() {
    const pos = this._ropePos, terrain = this.game.map.terrain;
    let n = 0;
    for (let i = 0; i < this.list.length && n < 16; i++) {
      const v = this.list[i];
      if (!v.ropes || !v.alive) continue;
      const lx = Math.cos(v.yaw), lz = -Math.sin(v.yaw), off = v.def.half[0] + 0.5;
      for (let side = -1; side <= 1 && n < 16; side += 2) {
        const x = v.pos.x + lx * side * off, z = v.pos.z + lz * side * off;
        const k = n * 3;
        pos[k] = x; pos[k + 1] = v.pos.y - 0.4; pos[k + 2] = z;
        pos[k + 3] = x; pos[k + 4] = Math.max(terrain.height(x, z), CONFIG.world.waterLevel); pos[k + 5] = z;
        n += 2;
      }
    }
    const geo = this._ropes.geometry;
    geo.setDrawRange(0, n);
    if (n) geo.attributes.position.needsUpdate = true;
  }

  fixedUpdate(dt) {
    this.ctx.time = this.game.time;
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i];
      if (v.cargoOf) { this._ride(v); continue; }
      if (v.chute) this._chuteDrag(v);
      v.fixedUpdate(dt);
    }
    this._drops(dt);
  }

  // --------------------------------------------------------------- air cargo (transport aircraft)

  /**
   * Loads a light vehicle into a transport aircraft's hold the way it is done on the ground: it drives (along a
   * vehicle route) to the foot of the lowered ramp, lines up behind the aircraft, climbs the ramp and parks in the
   * hold, where it rides (no collisions) until it is dropped. Done by the load crew: the vehicle needs no driver.
   */
  loadCargo(carrier, v, atRamp = false) {
    v.cargoOf = carrier;
    v.body.setEnabled(false);
    v.stow = null;
    if (atRamp === 'parked') {
      // Driven up the ramp into the hold on its own wheels and stopped on its spot: lashed down where it stands.
      _o.set(v.pos.x - carrier.pos.x, v.pos.y - carrier.pos.y, v.pos.z - carrier.pos.z).applyQuaternion(_qi.copy(carrier.quat).invert());
      v.stow = { x: _o.x, y: _o.y, z: _o.z, yaw: Math.atan2(Math.sin(v.yaw - carrier.yaw), Math.cos(v.yaw - carrier.yaw)) };
      v.loading = null; v.speed = 0;
      this._seatDriver(carrier, v);
      return;
    }
    this.holdPoint(carrier, v, _hold);
    this.rampFoot(carrier, _foot);
    if (atRamp) {
      // Driven to the foot of the ramp by its own driver: only the climb into the hold is left.
      v.loading = { phase: 'ramp', pts: [], k: 0, t: 0, x: v.pos.x, z: v.pos.z, yaw: v.yaw, sx: v.pos.x, sy: v.pos.y, sz: v.pos.z };
      return;
    }
    const path = new Float32Array(64), n = this.game.nav.findPath(v.pos.x, v.pos.z, _foot.x, _foot.z, true, path);
    const pts = [];
    for (let i = 0; i < n; i++) pts.push({ x: path[i * 2], z: path[i * 2 + 1] });
    pts.push({ x: _foot.x, z: _foot.z });
    v.loading = { phase: 'drive', pts, k: 0, t: 0, x: v.pos.x, z: v.pos.z, yaw: v.yaw };
  }

  /** The driver of a vehicle just stowed in the hold climbs out and takes a cabin seat. */
  _seatDriver(c, v) {
    const d = v.seats[0];
    if (!d || d.isPlayer) return;
    v.exit(d);
    let seat = -1;
    for (let i = 1; i < c.seats.length; i++) if (!c.seats[i] && c.def.seats[i].role === 'passenger') { seat = i; break; }
    if (seat >= 0) c.enter(d, seat);
  }

  /** Hold position of cargo vehicle v in carrier (world), behind the cabin on the hold floor. */
  holdPoint(carrier, v, out) {
    const R = carrier.def.rampDeck, floor = R ? R.floor : 1.3;
    // (towards the rear of the hold, just ahead of the ramp hinge: its tail clears the ramp as it closes)
    const z = R ? R.hinge + v.def.half[2] + 0.4 : -0.6;
    _o.set(0, floor - carrier.def.ride + v.def.ride, z).applyQuaternion(carrier.quat);
    return out.set(carrier.pos.x + _o.x, carrier.pos.y + _o.y, carrier.pos.z + _o.z);
  }

  /** Where the lowered ramp meets the ground behind the carrier. */
  rampFoot(carrier, out) {
    _o.set(0, 0, -7.6).applyQuaternion(carrier.quat);
    out.set(carrier.pos.x + _o.x, 0, carrier.pos.z + _o.z);
    out.y = this.game.map.terrain.height(out.x, out.z);
    return out;
  }

  /** Cargo vehicle on its way in (driving up), stowed (riding in the hold) or rolling out over the ramp. */
  _ride(v) {
    const c = v.cargoOf, dt = 1 / 60;
    if (!c.alive) { v.loading = null; v.sliding = null; this.dropCargo(c, v); return; }
    const L = v.loading, S = v.sliding;
    let x, y, z, yaw = c.yaw, pitch = 0;
    if (L && L.phase === 'drive') {
      // Ground run to the ramp foot at a walking-pace drive, turning to face the next waypoint.
      c.holdDoors(3);
      const p = L.pts[L.k];
      const dx = p.x - L.x, dz = p.z - L.z, d = Math.hypot(dx, dz);
      const want = Math.atan2(dx, dz);
      L.yaw += Math.max(-1.6 * dt, Math.min(1.6 * dt, Math.atan2(Math.sin(want - L.yaw), Math.cos(want - L.yaw))));
      const step = Math.min(d, 6 * dt);
      L.x += Math.sin(L.yaw) * step; L.z += Math.cos(L.yaw) * step;
      if (d < 1.5) { if (L.k < L.pts.length - 1) L.k++; else { L.phase = 'ramp'; L.t = 0; } }
      if ((L.t += dt) > 90) { L.phase = 'ramp'; L.t = 0; } // never stuck outside for ever
      x = L.x; z = L.z; yaw = L.yaw; y = v.terrain.height(x, z) + v.def.ride;
      v.speed = 6;
    } else if (L && L.phase === 'ramp') {
      // Up the ramp and into the hold, facing the cockpit (3 s).
      c.holdDoors(3);
      L.t += dt;
      const k = Math.min(1, L.t / 3.5), e = k * k * (3 - 2 * k);
      this.rampFoot(c, _foot); this.holdPoint(c, v, _hold);
      const fx = L.sx !== undefined ? L.sx : _foot.x, fz = L.sz !== undefined ? L.sz : _foot.z, fy = L.sy !== undefined ? L.sy : _foot.y + v.def.ride;
      x = fx + (_hold.x - fx) * e; z = fz + (_hold.z - fz) * e;
      y = fy + (_hold.y - fy) * Math.min(1, e * 1.6);
      yaw = L.yaw + Math.atan2(Math.sin(c.yaw - L.yaw), Math.cos(c.yaw - L.yaw)) * Math.min(1, e * 2);
      pitch = k < 0.6 ? -0.42 : 0;
      v.speed = 3;
      if (k >= 1) {
        v.loading = null;
        // Parked in the hold: the driver gets out and takes his seat in the cabin.
        this._seatDriver(c, v);
      }
    } else if (S) {
      // Rolling out over the open ramp (airdrop: it slides off the end under its chute; on the ground it drives down).
      c.holdDoors(2);
      S.t += dt;
      const k = Math.min(1, S.t / S.dur);
      this.holdPoint(c, v, _hold);
      _o.set(0, 0, -1).applyQuaternion(c.quat);
      x = _hold.x + _o.x * 9 * k; z = _hold.z + _o.z * 9 * k; y = _hold.y - (k > 0.5 ? (k - 0.5) * 3 : 0);
      pitch = k > 0.5 ? 0.35 : 0;
      if (k >= 1) { v.sliding = null; this.dropCargo(c, v); return; }
    } else if (v.stow) {
      // Lashed down where it parked.
      _o.set(v.stow.x, v.stow.y, v.stow.z).applyQuaternion(c.quat);
      x = c.pos.x + _o.x; y = c.pos.y + _o.y; z = c.pos.z + _o.z; yaw = c.yaw + v.stow.yaw;
      v.speed = 0;
    } else {
      this.holdPoint(c, v, _hold);
      x = _hold.x; y = _hold.y; z = _hold.z;
      v.speed = 0;
    }
    _e.set(pitch, yaw, 0, 'YXZ');
    const q = _qq.setFromEuler(_e);
    if (!L && !S) { q.copy(c.quat); if (v.stow) q.multiply(_qy.setFromAxisAngle(_Y, v.stow.yaw)); }
    v.body.setTranslation({ x, y, z }, false);
    v.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, false);
    v.prevPos.copy(v.curPos); v.curPos.set(x, y, z);
    v.prevQuat.copy(v.curQuat); v.curQuat.copy(q);
  }

  /** Starts a stowed vehicle rolling out of the hold over the ramp (dropCargo follows when it is off the end). */
  unloadCargo(carrier, v) {
    if (v.cargoOf !== carrier || v.sliding) return;
    v.loading = null; v.stow = null;
    v.sliding = { t: 0, dur: carrier.altitude > 8 ? 1.4 : 3.5 };
  }

  /** Releases a stowed vehicle out of the rear ramp under a parachute (or onto the ground if the carrier is landed). */
  dropCargo(carrier, v) {
    v.cargoOf = null;
    v.airdropped = true;
    const fx = Math.sin(carrier.yaw), fz = Math.cos(carrier.yaw);
    const x = carrier.pos.x - fx * (carrier.def.half[2] + 4), z = carrier.pos.z - fz * (carrier.def.half[2] + 4);
    const y = Math.max(carrier.pos.y - 3, v.terrain.height(x, z) + v.def.ride + 0.3);
    const yaw = carrier.yaw;
    v.body.setEnabled(true);
    v.body.setTranslation({ x, y, z }, true);
    v.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    v.body.setLinvel({ x: carrier.vel.x * 0.25, y: -2, z: carrier.vel.z * 0.25 }, true);
    v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    v.prevPos.set(x, y, z); v.curPos.set(x, y, z);
    v.visual.root.visible = true;
    if (carrier.altitude > 8) {
      v.chute = true;
      if (!this._chuteGeo) {
        this._chuteGeo = new THREE.SphereGeometry(4.2, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2.2);
        this._chuteMat = new THREE.MeshLambertMaterial({ color: 0x7d8a5a, side: THREE.DoubleSide });
      }
      const m = new THREE.Mesh(this._chuteGeo, this._chuteMat);
      m.position.set(0, 9, 0); m.scale.set(1, 0.55, 1);
      v.visual.root.add(m); v._chuteMesh = m;
    }
    this.game.bus.emit('cargoDropped', carrier, v);
  }

  /** Parachute: descent held at ~6 m/s, drift damped, kept upright; the canopy goes on touchdown. */
  _chuteDrag(v) {
    const b = v.body, lv = b.linvel();
    if (v.altitude < 0.8 && lv.y > -1) {
      v.chute = false;
      if (v._chuteMesh) { v.visual.root.remove(v._chuteMesh); v._chuteMesh = null; }
      return;
    }
    b.setLinvel({ x: lv.x * 0.985, y: Math.max(lv.y, -6), z: lv.z * 0.985 }, true);
    const av = b.angvel();
    b.setAngvel({ x: av.x * 0.8, y: av.y * 0.9, z: av.z * 0.8 }, true);
  }

  /**
   * Supply airdrop: a pallet under a parachute; once down it is a resupply point (ammunition for the dropping side's
   * infantry within 12 m, a fixed number of loads) until used up or after four minutes.
   */
  airdrop(x, y, z, team, uses = 24) {
    if (!this._palletGeo) {
      this._palletGeo = new THREE.BoxGeometry(1.4, 1.1, 1.4);
      this._palletMat = new THREE.MeshLambertMaterial({ color: 0x5b6236 });
    }
    const g = new THREE.Group();
    const crate = new THREE.Mesh(this._palletGeo, this._palletMat); crate.position.y = 0.55; crate.castShadow = true;
    if (!this._chuteGeo) { this._chuteGeo = new THREE.SphereGeometry(4.2, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2.2); this._chuteMat = new THREE.MeshLambertMaterial({ color: 0x7d8a5a, side: THREE.DoubleSide }); }
    const chute = new THREE.Mesh(this._chuteGeo, this._chuteMat); chute.position.y = 7; chute.scale.set(0.6, 0.4, 0.6);
    g.add(crate, chute); g.position.set(x, y, z);
    this.game.render.scene.add(g);
    (this.drops || (this.drops = [])).push({ g, chute, team, uses, t: 0, down: false });
  }

  _drops(dt) {
    if (!this.drops || !this.drops.length) return;
    const terrain = this.game.map.terrain;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i], p = d.g.position;
      if (!d.down) {
        p.y -= 6 * dt;
        const gy = Math.max(terrain.height(p.x, p.z), CONFIG.world.waterLevel);
        if (p.y <= gy) { p.y = gy; d.down = true; d.chute.visible = false; }
        continue;
      }
      d.t += dt;
      if (d.uses <= 0 || d.t > 240) { this.game.render.scene.remove(d.g); this.drops.splice(i, 1); }
    }
  }

  /** Call right after the physics step. */
  capture() {
    for (let i = 0; i < this.list.length; i++) this.list[i].capture();
  }

  /** @param {number} alpha fixed-step interpolation factor */
  interpolate(alpha) {
    for (let i = 0; i < this.list.length; i++) this.list[i].interpolate(alpha);
  }

  /**
   * Supply trucks resupply friendly infantry ammunition and repair friendly
   * vehicles parked nearby.
   */
  _supply(dt) {
    this._supplyTimer = (this._supplyTimer || 0) - dt;
    if (this._supplyTimer > 0) return;
    this._supplyTimer = 1;
    const g = this.game;
    this._stations();
    // Ammunition caches at owned flags: infantry inside the circle refill a third of a magazine per second.
    const r2 = CONFIG.match.captureRadius * CONFIG.match.captureRadius;
    for (const f of g.capture.flags) {
      if (f.owner < 0) continue;
      for (const s of g.soldiers) {
        if (!s.alive || s.team !== f.owner || s.vehicle) continue;
        if ((s.pos.x - f.x) ** 2 + (s.pos.z - f.z) ** 2 > r2) continue;
        for (const w of s.weapons) if (w.reserve < w.def.reserve) w.reserve = Math.min(w.def.reserve, w.reserve + Math.ceil(w.def.mag / 3));
      }
    }
    // Ammo bearers: each fire team's engineer / medic (class SUPPORT) shares spare magazines with squadmates nearby.
    for (const b of g.soldiers) {
      if (!b.alive || b.vehicle || b.cls !== 3 || !b.squad) continue;
      for (const s of g.soldiers) {
        if (s === b || !s.alive || s.vehicle || s.squad !== b.squad) continue;
        if ((s.pos.x - b.pos.x) ** 2 + (s.pos.z - b.pos.z) ** 2 > 10 * 10) continue;
        const w = s.rifle;
        if (w.reserve < w.def.reserve * 0.5) w.reserve = Math.min(w.def.reserve, w.reserve + Math.ceil(w.def.mag / 6));
      }
    }
    // Combat engineers (CEV): recover and patch up friendly vehicles beside them while halted.
    for (const cev of this.list) {
      if (!cev.alive || !cev.def.engineer || !cev.occupied || Math.abs(cev.speed) > 1.5) continue;
      for (const v of this.list) {
        if (v === cev || !v.alive || (v.occupied && v.team !== cev.team) || v.pos.distanceToSquared(cev.pos) > 16 * 16) continue;
        if (v.repair(v.def.health * 0.04) && v.seats.some((o) => o && o.isPlayer)) g.bus.emit('notice', 'ENGINEERS REPAIRING');
      }
    }
    for (const d of this.drops || []) {
      if (!d.down || d.uses <= 0) continue;
      const p = d.g.position;
      for (const s of g.soldiers) {
        if (d.uses <= 0) break;
        if (!s.alive || s.team !== d.team || s.vehicle || (s.pos.x - p.x) ** 2 + (s.pos.z - p.z) ** 2 > 144) continue;
        let topped = false;
        for (const w of s.weapons) if (w.reserve < w.def.reserve) { w.reserve = Math.min(w.def.reserve, w.reserve + Math.ceil(w.def.mag * 0.5)); topped = true; }
        if (topped) d.uses -= 0.25;
      }
    }
    for (const truck of this.list) {
      if (!truck.alive || truck.def.role !== 'supply' || Math.abs(truck.speed) > 2) continue;
      const team = truck.occupied ? truck.team : truck.spawn.team;
      // Supply crates: a carrier holds def.supplyUses crate loads (one per soldier topped up), refilled at a base.
      if (truck.supplyLeft === undefined) truck.supplyLeft = truck.def.supplyUses || Infinity;
      const base = g.map.bases[team], bf = base ? g.capture.flags[base.flag] : null;
      if (bf && (truck.pos.x - bf.x) ** 2 + (truck.pos.z - bf.z) ** 2 < 160 * 160) truck.supplyLeft = truck.def.supplyUses || Infinity;
      for (const s of g.soldiers) {
        if (truck.supplyLeft <= 0) break;
        if (!s.alive || s.team !== team || s.vehicle) continue;
        if ((s.pos.x - truck.pos.x) ** 2 + (s.pos.z - truck.pos.z) ** 2 > 14 * 14) continue;
        let topped = false;
        for (const w of s.weapons) if (w.reserve < w.def.reserve) { w.reserve = Math.min(w.def.reserve, w.reserve + Math.ceil(w.def.mag * 0.5)); topped = true; }
        if (topped) truck.supplyLeft -= 0.25;
        if (topped && s.isPlayer) g.bus.emit('notice', 'RESUPPLYING');
      }
      for (const v of this.list) {
        if (v === truck || !v.alive || (v.occupied && v.team !== team)) continue;
        if (v.pos.distanceToSquared(truck.pos) > 18 * 18) continue;
        if (v.repair(v.def.health * 0.05) && v.seats.some((o) => o && o.isPlayer)) g.bus.emit('notice', 'REPAIRING');
        for (const w of v.weapons) if (w.reserve !== Infinity && w.reserve < w.def.reserve) w.reserve = w.def.reserve;
      }
    }
  }

  /**
   * Fixed repair / resupply / refuelling stations (base aprons, depots,
   * outpost yards): infantry refill ammunition, vehicles and landed aircraft
   * are repaired and rearmed. A base station serves its own side; the others
   * serve whoever holds the objective they belong to.
   */
  _stations() {
    const g = this.game, flags = g.capture.flags;
    for (const st of g.map.supplies || []) {
      let team = st.team;
      if (team < 0) {
        if (st.flag === undefined) {
          st.flag = -1;
          let bd = 140 * 140;
          for (const f of flags) { const d = (f.x - st.x) ** 2 + (f.z - st.z) ** 2; if (!f.base && d < bd) { bd = d; st.flag = f.id; } }
        }
        team = st.flag >= 0 ? flags[st.flag].owner : -1;
      }
      if (team < 0) continue;
      const r2 = st.r * st.r;
      for (const s of g.soldiers) {
        if (!s.alive || s.team !== team || s.vehicle) continue;
        if ((s.pos.x - st.x) ** 2 + (s.pos.z - st.z) ** 2 > r2) continue;
        for (const w of s.weapons) if (w.reserve < w.def.reserve) w.reserve = Math.min(w.def.reserve, w.reserve + Math.ceil(w.def.mag / 2));
      }
      const vr2 = (st.r + 8) * (st.r + 8);
      for (const v of this.list) {
        if (!v.alive || (v.occupied ? v.team : v.spawn.team) !== team || Math.abs(v.speed) > 3) continue;
        if (v.isAircraft && v.altitude > 3) continue;
        if ((v.pos.x - st.x) ** 2 + (v.pos.z - st.z) ** 2 > vr2) continue;
        if (v.repair(v.def.health * 0.04) && v.seats.some((o) => o && o.isPlayer)) g.bus.emit('notice', 'REPAIRING');
        for (const w of v.weapons) if (w.reserve !== Infinity && w.reserve < w.def.reserve) w.reserve = Math.min(w.def.reserve, w.reserve + Math.ceil(w.def.reserve / 6));
      }
    }
  }

  /** @param {number} dt @param {{x:number,y:number,z:number}} cam */
  /**
   * Ramp and hold floor of a parked cargo aircraft with its ramp down, as walkable / drivable deck surfaces
   * (terrain.height samples them): troops walk up the ramp into the hold and a light vehicle drives up on its own
   * wheels. They are laid while the aircraft stands still with the ramp fully down and lifted otherwise.
   */
  _updateDecks() {
    const T = this.game.map.terrain;
    for (const v of this.list) {
      const R = v.def.rampDeck;
      if (!R) continue;
      const open = v.doorOpen.length ? v.doorOpen[v.doorOpen.length - 1] : 0;
      // The hold floor is walkable whenever the aircraft stands still on the ground; the ramp only once it is down.
      const parked = v.alive && v.grounded > 0 && v.altitude < 1 && Math.abs(v.speed) < 0.6;
      const on = parked && open > 0.85;
      if (!v._decks) { v._decks = [{ alive: false, group: v.id, kind: 'ramp' }, { alive: false, group: v.id, kind: 'floor' }]; T.decks.push(...v._decks); }
      v.rampDown = on;
      if (!parked) { v._decks[0].alive = v._decks[1].alive = false; continue; }
      const s = Math.sin(v.yaw), c = Math.cos(v.yaw), gy = v.pos.y - v.def.ride, floor = gy + R.floor;
      const lay = (d, zc, hl, y0, y1) => {
        const x = v.pos.x + s * zc, z = v.pos.z + c * zc, r = Math.hypot(hl, R.hw) + 0.5;
        Object.assign(d, { x, z, c, s, hw: R.hw, hl, y0, y1, alive: true, minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r });
      };
      // Ramp: from the hinge at floor height down to where its lip meets the ground.
      const run = Math.sqrt(Math.max(0.1, R.length * R.length - R.floor * R.floor));
      const fz = R.hinge - run, fx = v.pos.x + s * fz, fzw = v.pos.z + c * fz;
      if (on) lay(v._decks[0], R.hinge - run / 2, run / 2, T.baseHeight(fx, fzw), floor); else v._decks[0].alive = false;
      lay(v._decks[1], (R.hinge + R.front) / 2, (R.front - R.hinge) / 2, floor, floor);
      // Someone (the player) on the ramp or in the hold, or walking up to the ramp: it stays down / comes down.
      const p = this.game.player;
      if (p && p.alive && !p.vehicle && (p.team === v.team || !v.occupied)) {
        const lz = (p.pos.x - v.pos.x) * s + (p.pos.z - v.pos.z) * c, lx = (p.pos.x - v.pos.x) * c - (p.pos.z - v.pos.z) * s;
        if (Math.abs(lx) < 3.5 && lz > R.hinge - run - 9 && lz < R.front) v.holdDoors(1.5);
      }
    }
  }

  /**
   * Jump lights by the ramp of a cargo aircraft (both walls of the hold): red on the run-in (stand up, hook up),
   * green over the drop zone, dark otherwise.
   */
  _jumpLights() {
    for (const v of this.list) {
      if (!v.def.rampDeck) continue;
      if (!v._jl) {
        const R = v.def.rampDeck, y = R.floor + 1.9 - v.def.ride, geo = new THREE.BoxGeometry(0.06, 0.16, 0.28);
        v._jlMat = [new THREE.MeshBasicMaterial({ color: 0x220606 }), new THREE.MeshBasicMaterial({ color: 0x062206 })];
        v._jl = [];
        for (const sx of [1.38, -1.38]) for (let k = 0; k < 2; k++) {
          const m = new THREE.Mesh(geo, v._jlMat[k]);
          m.position.set(sx, y + (k ? -0.2 : 0), R.hinge + 0.6);
          v.visual.root.add(m); v._jl.push(m);
        }
        v._jlState = '';
      }
      const st = v.alive ? v.jumpLight || 'off' : 'off';
      if (st === v._jlState) continue;
      v._jlState = st;
      v._jlMat[0].color.setHex(st === 'red' ? 0xff2a1a : 0x220606);
      v._jlMat[1].color.setHex(st === 'green' ? 0x30ff40 : 0x062206);
    }
  }

  update(dt, cam) {
    this.ctx.time = this.game.time;
    this._supply(dt);
    this._updateRopes();
    this._updateDecks();
    this._jumpLights();
    for (let i = 0; i < this.list.length; i++) if (this.list[i].occupied) this.list[i].processExits();
    const particles = this.game.particles;
    this._smoke -= dt;
    const puff = this._smoke <= 0;
    if (puff) this._smoke = 0.12;
    const atm = this.game.atmosphere, dusty = !atm || (atm.weather !== 'rain' && atm.weather !== 'fog');
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i];
      const dx = v.pos.x - cam.x, dz = v.pos.z - cam.z;
      if (v.tel === undefined) telState(v);
      if (v.tel) telUpdate(v, dt, this.game);
      v.updateVisual(dt, dx * dx + dz * dz);
      if (v.alive) {
        // Damaged vehicles trail smoke: a readable "bail out now" cue.
        if (puff && v.health < v.def.health * 0.35) particles.smoke(v.pos.x, v.pos.y + 1, v.pos.z, 0.8, 0.5);
        // Dust off dirt and grass in dry weather (near the camera only).
        if (puff && dusty && v.def.kind === 'ground' && Math.abs(v.speed) > 3 && dx * dx + dz * dz < 320 * 320) {
          const t = this.game.map.terrain;
          const sf = t.surfAt(v.pos.x, v.pos.z);
          if (t.pavedAt(v.pos.x, v.pos.z) === 0 && sf !== 1 && sf !== 2 && sf !== 9) {
            // Tint by ground: field and meadow paler and greener, gravel grey, ploughed / bare earth brown.
            const tint = sf === 6 ? DUST_GRAVEL : sf === 3 ? DUST_FIELD : sf === 4 || sf === 8 ? DUST_GREEN : DUST_EARTH;
            const bx = -Math.sin(v.yaw) * Math.sign(v.speed), bz = -Math.cos(v.yaw) * Math.sign(v.speed);
            particles.roadDust(v.pos.x + bx * v.def.half[2], v.pos.y - v.def.ride + 0.3, v.pos.z + bz * v.def.half[2], bx, bz, v.def.half[0], Math.abs(v.speed), tint[0], tint[1], tint[2]);
          }
        }
        if (puff && dusty && dx * dx + dz * dz < 200 * 200) {
          const t = this.game.map.terrain;
          // Tracks slewing round on the spot throw up dirt at both sides.
          if (v.def.kind === 'ground' && v.def.maxSteer === 0 && Math.abs(v.speed) < 3 && Math.abs(v.controls.steer) > 0.6 && v.occupied && t.pavedAt(v.pos.x, v.pos.z) === 0) {
            const c = Math.cos(v.yaw), sn = Math.sin(v.yaw), w = v.def.half[0];
            particles.dust(v.pos.x + c * w, v.pos.y - v.def.ride + 0.3, v.pos.z - sn * w, 0.6);
            particles.dust(v.pos.x - c * w, v.pos.y - v.def.ride + 0.3, v.pos.z + sn * w, 0.6);
          }
          // Rotor wash: a helicopter low over open ground raises a ring of dust.
          if ((v.def.kind === 'heli') && v.rotorSpeed > 0.5 && v.altitude < 14 && t.surfAt(v.pos.x, v.pos.z) !== 1) {
            const a = (this._wash = (this._wash || 0) + 2.39996), r = 6 + (14 - v.altitude) * 0.4;
            const gx = v.pos.x + Math.cos(a) * r, gz = v.pos.z + Math.sin(a) * r;
            particles.dust(gx, t.height(gx, gz) + 0.4, gz, 1.1);
          }
        }
        // Vehicles abandoned in the field are recovered to their pad after a while.
        const away = (v.pos.x - v.spawn.x) ** 2 + (v.pos.z - v.spawn.z) ** 2 > 30 * 30;
        v.idleTime = v.occupied || v.cargoOf || !away ? 0 : (v.idleTime || 0) + dt;
        if (v.idleTime > (v.airdropped ? 240 : 55)) {
          const p = this.game.player;
          const nearPlayer = p.alive && (p.pos.x - v.pos.x) ** 2 + (p.pos.z - v.pos.z) ** 2 < 40 * 40;
          if (!nearPlayer) { v.idleTime = 0; this._parkFor(v); v.reset(); }
        }
        continue;
      }
      if (v.wreckTimer > 0) {
        v.wreckTimer -= dt;
        if (puff) particles.smoke(v.pos.x, v.pos.y + 1, v.pos.z, 1.3, 0.55);
        if (v.wreckTimer <= 0) {
          v.visual.root.visible = false;
          // Park the body out of the simulation entirely until it respawns.
          if (!v.def.static) { v.body.setLinvel({ x: 0, y: 0, z: 0 }, false); v.body.setAngvel({ x: 0, y: 0, z: 0 }, false); }
          v.body.setEnabled(false);
          v.respawnTimer = CONFIG.match.vehicleRespawnTime;
        }
      } else {
        v.respawnTimer -= dt;
        if (v.respawnTimer <= 0) { this._parkFor(v); v.reset(); }
      }
    }
  }

  /** A vehicle about to be reset at base gets a free parking slot as its home (never inside another vehicle). */
  _parkFor(v) {
    const park = this.game.ai && this.game.ai.orchestrator && this.game.ai.orchestrator.park;
    if (park) park.prepareReset(v);
  }

  /**
   * Closest vehicle a soldier of `team` could board.
   * @param {{x:number,z:number}} pos
   * @param {(v: Vehicle) => boolean} [filter]
   * @returns {Vehicle|null}
   */
  nearestBoardable(pos, team, maxDist, filter) {
    let best = null, bestD = maxDist * maxDist;
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i];
      if (!v.boardableBy(team) || (filter && !filter(v))) continue;
      const d = (v.pos.x - pos.x) ** 2 + (v.pos.z - pos.z) ** 2;
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  serialize() { return this.list.map((v) => v.serialize()); }

  deserialize(data) {
    for (const d of data) {
      const v = this.list[d.id];
      if (!v) continue;
      for (let i = 0; i < v.seats.length; i++) v.seats[i] = null;
      v.deserialize(d);
    }
  }
}
