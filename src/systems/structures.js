import { CONFIG, GROUP } from '../core/config.js';
import { clamp } from '../core/math.js';
import { groups } from './physics.js';
import { K, SOLID, WALKABLE, buildingParts, partSurface, toLocal, buildingRadius } from '../world/buildings.js';

const CELL = 16;
const STEP_UP = 0.65;
const _l = { x: 0, z: 0 };

/**
 * Buildings (and the bridge) in the running game: physics colliders for
 * every solid part, walkable surfaces for infantry (floors, stairs, roofs),
 * height-aware wall push-out, damage with predefined structural states,
 * navigation updates and save / restore. Damage persists until repaired
 * (bridge) or the match ends.
 */
export class StructureSystem {
  /**
   * @param {any} game  (map, physics, nav, chunks, bus)
   */
  constructor(game) {
    this.game = game;
    this.map = game.map;
    /** @type {import('../world/buildings.js').Building[]} */
    this.list = game.map.buildings;
    const half = this.map.terrain.half;
    this.half = half;
    this.n = Math.ceil(CONFIG.world.size / CELL);
    /** @type {number[][]} building ids per hash cell */
    this.hash = Array.from({ length: this.n * this.n }, () => []);
    for (const b of this.list) {
      const r = buildingRadius(b);
      for (let cz = this._c(b.z - r); cz <= this._c(b.z + r); cz++) for (let cx = this._c(b.x - r); cx <= this._c(b.x + r); cx++) this.hash[cz * this.n + cx].push(b.id);
      this._addColliders(b);
    }
    /** Bridge repair progress (engineer-seconds). */
    this.repair = new Map();
    this.stats = { colliders: 0, destroyed: 0 };
    for (const b of this.list) this.stats.colliders += b.colliders.length;
  }

  _c(v) { return clamp(Math.floor((v + this.half) / CELL), 0, this.n - 1); }

  near(x, z) { return this.hash[this._c(z) * this.n + this._c(x)]; }

  // ---------------------------------------------------------------- physics

  _addColliders(b) {
    const ph = this.game.physics, R = ph.R, world = ph.world;
    const parts = buildingParts(b);
    const cy = Math.cos(b.rot / 2), sy = Math.sin(b.rot / 2);
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    for (const p of parts) {
      if (!SOLID.has(p.k)) continue;
      // Thin decorative slabs under 6 cm are not worth a collider.
      if (p.hy < 0.03 && p.k !== K.FLOOR) continue;
      let qx = 0, qy = sy, qz = 0, qw = cy;
      if (p.rx || p.rz) {
        // q = qYaw * qTilt
        const a = (p.rx || p.rz) / 2, ta = Math.sin(a), tw = Math.cos(a);
        const tx = p.rx ? ta : 0, tz = p.rz ? ta : 0;
        qw = cy * tw; qx = cy * tx + sy * tz; qy = sy * tw; qz = cy * tz - sy * tx;
      }
      const desc = R.ColliderDesc.cuboid(p.hx, Math.max(0.05, p.hy), p.hz)
        .setTranslation(b.x + p.x * c + p.z * s, b.y + p.y, b.z - p.x * s + p.z * c)
        .setRotation({ x: qx, y: qy, z: qz, w: qw })
        .setCollisionGroups(groups(GROUP.WORLD, 0xffff));
      const col = world.createCollider(desc);
      ph.userData.set(col.handle, { kind: 'building', ref: b });
      b.colliders.push(col);
    }
  }

  _removeColliders(b) {
    const ph = this.game.physics;
    for (const col of b.colliders) { ph.userData.delete(col.handle); ph.world.removeCollider(col, false); }
    b.colliders.length = 0;
  }

  // ---------------------------------------------------------------- infantry support

  /** Walkable parts of a building's current state (cached per state). */
  _walk(b) {
    if (!b._walk || b._walkState !== b.state) {
      b._walk = buildingParts(b).filter((p) => WALKABLE.has(p.k));
      b._walls = buildingParts(b).filter((p) => (p.k === K.WALL || p.k === K.PILLAR) && Math.abs(p.rx || 0) <= 0.15 && !p.rz);
      b._walkState = b.state;
    }
    return b._walk;
  }

  /** Wall and pillar parts that block a walking soldier (cached per state). */
  _walls(b) { this._walk(b); return b._walls; }

  /**
   * Highest walkable building surface at (x, z) that a soldier at height y can
   * stand on (at most a step above his feet), or -Infinity.
   */
  surface(x, z, y) {
    const ids = this.near(x, z);
    let best = -Infinity;
    for (let i = 0; i < ids.length; i++) {
      const b = this.list[ids[i]];
      toLocal(b, x, z, _l);
      if (Math.abs(_l.x) > b.w / 2 + 2 || Math.abs(_l.z) > b.d / 2 + 2) continue;
      const parts = this._walk(b);
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        const h = partSurface(p, _l.x, _l.z);
        if (h === -Infinity) continue;
        const wy = b.y + h;
        if (wy <= y + STEP_UP && wy > best) best = wy;
      }
    }
    return best;
  }

  /** Pushes a soldier (feet at pos.y) out of walls and solid furniture overlapping his body height. */
  pushOut(pos, radius) {
    const ids = this.near(pos.x, pos.z);
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      const b = this.list[ids[i]];
      toLocal(b, pos.x, pos.z, _l);
      if (Math.abs(_l.x) > b.w / 2 + 1 || Math.abs(_l.z) > b.d / 2 + 1) continue;
      const parts = this._walls(b);
      let lx = _l.x, lz = _l.z, hit = false;
      const fy = pos.y - b.y;
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        // Body from knee height to head: a wall only blocks if it overlaps that band.
        if (p.y + p.hy < fy + 0.45 || p.y - p.hy > fy + 1.7) continue;
        const ox = p.hx + radius - Math.abs(lx - p.x), oz = p.hz + radius - Math.abs(lz - p.z);
        if (ox <= 0 || oz <= 0) continue;
        if (ox < oz) lx = p.x + Math.sign(lx - p.x || 1) * (p.hx + radius);
        else lz = p.z + Math.sign(lz - p.z || 1) * (p.hz + radius);
        hit = true;
      }
      if (hit) {
        const c = Math.cos(b.rot), s = Math.sin(b.rot);
        pos.x = b.x + lx * c + lz * s; pos.z = b.z - lx * s + lz * c;
        moved = true;
      }
    }
    return moved;
  }

  // ---------------------------------------------------------------- damage

  /** Explosion damage to buildings within `radius` of (x, z); the blast also shatters nearby windows. */
  blast(x, y, z, radius, damage) {
    const ids = this.near(x, z);
    for (let i = 0; i < ids.length; i++) {
      const b = this.list[ids[i]];
      toLocal(b, x, z, _l);
      const ex = Math.max(0, Math.abs(_l.x) - b.w / 2), ez = Math.max(0, Math.abs(_l.z) - b.d / 2);
      const d = Math.hypot(ex, ez);
      if (d > radius * 1.6) continue;
      this.breakGlass(b, x, y, z, d < radius * 0.6 ? 0xffff : 0);
      if (d > radius) continue;
      this.damage(b, damage * (1 - d / radius) * 0.6);
    }
  }

  /**
   * Breaks the window panes of the wall face (and storey) nearest to a hit
   * point, or every pane in `all` (bit mask). Persistent until the match resets.
   */
  breakGlass(b, x, y, z, all = 0) {
    if (b.state > 0 || b.type === 'custom' || b.type === 'bridge') return;
    let mask = all;
    if (!mask) {
      toLocal(b, x, z, _l);
      const fx = Math.abs(_l.x) / (b.w / 2), fz = Math.abs(_l.z) / (b.d / 2);
      const side = fz >= fx ? (_l.z > 0 ? 0 : 1) : (_l.x > 0 ? 2 : 3);
      const storey = clamp(Math.floor((y - b.y) / b.fh), 0, 3);
      mask = 1 << (side * 4 + storey);
    }
    if ((b.glassBroken & mask) === mask) return;
    b.glassBroken |= mask;
    if (this.game.chunks) this.game.chunks.markBuildingDirty(b);
    if (this.game.particles) this.game.particles.sparks(x, y, z, 6);
    this.game.bus.emit('sound', 'glass', x, y, z);
  }

  /** A bullet struck a building at (x, y, z): windows of that face shatter. */
  onBulletHit(b, x, y, z) { this.breakGlass(b, x, y, z); }

  /** @param {import('../world/buildings.js').Building} b */
  damage(b, amount) {
    if (b.invulnerable || b.state === 2 || amount <= 0) return;
    b.hp = Math.max(0, b.hp - amount);
    const want = b.hp <= 0 ? 2 : b.hp < b.maxHp * 0.6 ? 1 : 0;
    if (want > b.state) this.setState(b, want);
    this.game.bus.emit('building:damaged', b);
  }

  /** Swaps a building to a predefined damage state: colliders, render batch, navigation. */
  setState(b, state) {
    if (b.state === state) return;
    const nav = this.game.nav;
    if (nav) nav.stampBuilding(b, -1);
    b.state = state;
    // A fallen bridge drops its deck: vehicles and soldiers on it go into the river.
    for (const d of this.map.terrain.decks) if (d.building === b.id) d.alive = state < 2;
    this._removeColliders(b);
    this._addColliders(b);
    if (nav) nav.stampBuilding(b, 1);
    if (this.game.chunks) this.game.chunks.markBuildingDirty(b);
    if (state === 2) this.stats.destroyed++;
    // Glass goes with the walls.
    if (state > 0 && this.game.combat) for (const id of b.glass) { const g = this.map.props[id]; if (g && g.alive) this.game.combat.damageProp(g, 99); }
    this.game.bus.emit('building:state', b, state);
  }

  /** Engineers rebuild a destroyed bridge (engineer-seconds of work). @returns {boolean} finished */
  repairBridge(b, amount) {
    if (b.type !== 'bridge' || b.state === 0) return false;
    const p = (this.repair.get(b.id) || 0) + amount;
    this.repair.set(b.id, p);
    if (p < 45) return false;
    this.repair.delete(b.id);
    b.hp = b.maxHp;
    this.setState(b, 0);
    this.game.bus.emit('notice', 'BRIDGE REPAIRED');
    return true;
  }

  // ---------------------------------------------------------------- state store

  serialize() { return this.list.map((b) => [b.state, Math.round(b.hp), b.glassBroken]); }

  deserialize(d) {
    d.forEach((a, i) => {
      const b = this.list[i];
      if (!b) return;
      b.hp = a[1];
      if ((a[2] || 0) !== b.glassBroken) { b.glassBroken = a[2] || 0; if (this.game.chunks) this.game.chunks.markBuildingDirty(b); }
      for (const dk of this.map.terrain.decks) if (dk.building === b.id) dk.alive = a[0] < 2;
      if (b.state !== a[0]) {
        const nav = this.game.nav;
        if (nav) nav.stampBuilding(b, -1);
        b.state = a[0];
        this._removeColliders(b);
        this._addColliders(b);
        if (nav) nav.stampBuilding(b, 1);
        if (this.game.chunks) this.game.chunks.markBuildingDirty(b);
      }
    });
  }
}
