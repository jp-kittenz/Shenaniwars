import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../core/config.js';
import { Vehicle } from '../entities/vehicle.js';
import { VEHICLE_DEFS } from '../entities/vehicle-defs.js';

/**
 * Owns every vehicle: fixed-step simulation, render interpolation, wreck
 * clean-up and respawning at the home pad.
 */
/** Beyond this a vehicle is drawn as an instanced stand-in (m). */
const IMPOSTOR_DIST = 500;
const _m4 = new THREE.Matrix4(), _sc = new THREE.Vector3(), _col = new THREE.Color();

export class VehicleSystem {
  /** @param {import('./game.js').Game} game */
  constructor(game) {
    this.game = game;
    const ctx = {
      physics: game.physics, terrain: game.map.terrain, bus: game.bus,
      scene: game.render.scene, setupMaterial: game.render.setupMaterial,
    };
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
    // Far impostors: beyond IMPOSTOR_DIST a vehicle's full model (many meshes, tens of thousands of triangles) is
    // swapped for a low-poly stand-in sized to its hull; all stand-ins draw in two instanced batches (ground /
    // air), so the whole map's vehicles stay visible at full view distance for two draw calls.
    const n = this.list.length;
    const mat = game.render.setupMaterial(new THREE.MeshLambertMaterial({ color: 0xffffff }));
    const groundGeo = mergeGeometries([new THREE.BoxGeometry(1, 0.62, 1).translate(0, -0.12, 0), new THREE.BoxGeometry(0.62, 0.34, 0.45).translate(0, 0.32, 0.05)]);
    const airGeo = mergeGeometries([new THREE.BoxGeometry(0.3, 0.6, 1), new THREE.BoxGeometry(1.7, 0.06, 0.28).translate(0, 0.1, 0.05), new THREE.BoxGeometry(0.04, 0.9, 0.18).translate(0, 0.5, -0.42)]);
    this._imp = [groundGeo, airGeo].map((geo) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false; m.castShadow = false; m.count = 0;
      m.setColorAt(0, new THREE.Color(1, 1, 1));
      game.render.scene.add(m);
      return m;
    });
  }

  /** Swaps far vehicles for instanced stand-ins (and back when they come near). */
  _impostors(cam) {
    const R2 = IMPOSTOR_DIST * IMPOSTOR_DIST, cnt = [0, 0];
    for (const v of this.list) {
      if (v.def.static) continue;
      const dx = v.pos.x - cam.x, dz = v.pos.z - cam.z, far = dx * dx + dz * dz > R2;
      const show = (v.alive || v.wreckTimer > 0) && !v.cargoOf;
      if (far && show) {
        if (v.visual.root.visible) { v.visual.root.visible = false; v._impostor = true; }
        const air = v.def.kind !== 'ground', m = this._imp[air ? 1 : 0], k = cnt[air ? 1 : 0]++;
        const h = v.def.half;
        _sc.set(h[0] * 2, h[1] * 2, h[2] * 2);
        if (air) _sc.x = h[2] * 1.0;
        _m4.compose(v.pos, v.quat, _sc);
        m.setMatrixAt(k, _m4);
        _col.setHex(!v.alive ? 0x2a2a28 : air ? 0x7d8684 : 0x4c5534);
        m.setColorAt(k, _col);
      } else if (v._impostor) { v._impostor = false; if (show) v.visual.root.visible = true; }
    }
    for (let i = 0; i < 2; i++) {
      const m = this._imp[i];
      m.count = cnt[i];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
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
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i];
      if (v.cargoOf) { this._ride(v); continue; }
      if (v.chute) this._chuteDrag(v);
      v.fixedUpdate(dt);
    }
    this._drops(dt);
  }

  // --------------------------------------------------------------- air cargo (transport aircraft)

  /** Stows a light vehicle in a transport aircraft's hold: out of the world (no collisions, hidden) until dropped. */
  loadCargo(carrier, v) {
    v.cargoOf = carrier;
    v.body.setEnabled(false);
    v.visual.root.visible = false;
  }

  /** Keeps a stowed vehicle at its carrier (so it stays in step with it for streaming and the minimap). */
  _ride(v) {
    const c = v.cargoOf, p = c.pos;
    v.body.setTranslation({ x: p.x, y: p.y, z: p.z }, false);
    v.prevPos.copy(p); v.curPos.copy(p);
    if (!c.alive) { this.dropCargo(c, v); }
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
  update(dt, cam) {
    this._supply(dt);
    this._impostors(cam);
    this._updateRopes();
    const particles = this.game.particles;
    this._smoke -= dt;
    const puff = this._smoke <= 0;
    if (puff) this._smoke = 0.12;
    const atm = this.game.atmosphere, dusty = !atm || (atm.weather !== 'rain' && atm.weather !== 'fog');
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i];
      const dx = v.pos.x - cam.x, dz = v.pos.z - cam.z;
      v.updateVisual(dt, dx * dx + dz * dz);
      if (v.alive) {
        // Damaged vehicles trail smoke: a readable "bail out now" cue.
        if (puff && v.health < v.def.health * 0.35) particles.smoke(v.pos.x, v.pos.y + 1, v.pos.z, 0.8, 0.5);
        // Dust off dirt and grass in dry weather (near the camera only).
        if (puff && dusty && v.def.kind === 'ground' && Math.abs(v.speed) > 5 && dx * dx + dz * dz < 220 * 220) {
          const t = this.game.map.terrain;
          if (t.pavedAt(v.pos.x, v.pos.z) === 0 && t.surfAt(v.pos.x, v.pos.z) !== 1 && t.surfAt(v.pos.x, v.pos.z) !== 2) {
            particles.dust(v.pos.x - Math.sin(v.yaw) * v.def.half[2], v.pos.y - v.def.ride + 0.4, v.pos.z - Math.cos(v.yaw) * v.def.half[2], 0.8 + Math.min(1, Math.abs(v.speed) / 15));
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
        v.idleTime = v.occupied || !away ? 0 : (v.idleTime || 0) + dt;
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
