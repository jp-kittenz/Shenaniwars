import { CONFIG } from '../core/config.js';
import { Vehicle } from '../entities/vehicle.js';
import { VEHICLE_DEFS } from '../entities/vehicle-types.js';

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

  /** @param {number} dt @param {{x:number,y:number,z:number}} cam */
  update(dt, cam) {
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
        continue;
      }
      if (v.wreckTimer > 0) {
        v.wreckTimer -= dt;
        if (puff) particles.smoke(v.pos.x, v.pos.y + 1, v.pos.z, 1.3, 0.55);
        if (v.wreckTimer <= 0) {
          v.visual.root.visible = false;
          v.body.setTranslation({ x: v.spawn.x, y: -200 - v.id * 20, z: v.spawn.z }, false);
          v.body.sleep();
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
