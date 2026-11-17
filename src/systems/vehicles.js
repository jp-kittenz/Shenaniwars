import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { Vehicle } from '../entities/vehicle.js';
import { VEHICLE_DEFS } from '../entities/vehicle-defs.js';

/**
 * Owns every vehicle: fixed-step simulation, render interpolation, wreck
 * clean-up and respawning at the home pad.
 */
export class VehicleSystem {
  /** @param {import('./game.js').Game} game */
  constructor(game) {
    this.game = game;
    const ctx = {
      physics: game.physics, terrain: game.map.terrain, bus: game.bus,
      scene: game.render.scene, setupMaterial: game.render.setupMaterial,
    };
    /** @type {Vehicle[]} */
    this.list = game.map.vehicleSpawns.map((s, i) => new Vehicle(ctx, VEHICLE_DEFS[s.type], s, i));
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
    for (let i = 0; i < this.list.length; i++) this.list[i].fixedUpdate(dt);
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
    for (const truck of this.list) {
      if (!truck.alive || truck.def.role !== 'supply' || Math.abs(truck.speed) > 2) continue;
      const team = truck.occupied ? truck.team : truck.spawn.team;
      for (const s of g.soldiers) {
        if (!s.alive || s.team !== team || s.vehicle) continue;
        if ((s.pos.x - truck.pos.x) ** 2 + (s.pos.z - truck.pos.z) ** 2 > 14 * 14) continue;
        let topped = false;
        for (const w of s.weapons) if (w.reserve < w.def.reserve) { w.reserve = Math.min(w.def.reserve, w.reserve + Math.ceil(w.def.mag * 0.5)); topped = true; }
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

  /** @param {number} dt @param {{x:number,y:number,z:number}} cam */
  update(dt, cam) {
    this._supply(dt);
    this._updateRopes();
    const particles = this.game.particles;
    this._smoke -= dt;
    const puff = this._smoke <= 0;
    if (puff) this._smoke = 0.12;
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i];
      const dx = v.pos.x - cam.x, dz = v.pos.z - cam.z;
      v.updateVisual(dt, dx * dx + dz * dz);
      if (v.alive) {
        // Damaged vehicles trail smoke: a readable "bail out now" cue.
        if (puff && v.health < v.def.health * 0.35) particles.smoke(v.pos.x, v.pos.y + 1, v.pos.z, 0.8, 0.5);
        // Vehicles abandoned in the field are recovered to their pad after a while.
        const away = (v.pos.x - v.spawn.x) ** 2 + (v.pos.z - v.spawn.z) ** 2 > 30 * 30;
        v.idleTime = v.occupied || !away ? 0 : (v.idleTime || 0) + dt;
        if (v.idleTime > 55) {
          const p = this.game.player;
          const nearPlayer = p.alive && (p.pos.x - v.pos.x) ** 2 + (p.pos.z - v.pos.z) ** 2 < 40 * 40;
          if (!nearPlayer) { v.idleTime = 0; v.reset(); }
        }
        continue;
      }
      if (v.wreckTimer > 0) {
        v.wreckTimer -= dt;
        if (puff) particles.smoke(v.pos.x, v.pos.y + 1, v.pos.z, 1.3, 0.55);
        if (v.wreckTimer <= 0) {
          v.visual.root.visible = false;
          // Park the body out of the simulation entirely until it respawns.
          v.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
          v.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
          v.body.setEnabled(false);
          v.respawnTimer = CONFIG.match.vehicleRespawnTime;
        }
      } else {
        v.respawnTimer -= dt;
        if (v.respawnTimer <= 0) v.reset();
      }
    }
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
