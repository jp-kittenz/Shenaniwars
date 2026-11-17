import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG, GROUP } from '../core/config.js';
import { clamp } from '../core/math.js';

/** Packs Rapier interaction groups. */
export const groups = (member, filter) => ((member << 16) | filter) >>> 0;
export const MASK_LOS = groups(0xffff, GROUP.WORLD);
export const MASK_SHOT = groups(0xffff, GROUP.WORLD | GROUP.VEHICLE);

const HASH_CELL = 16;

/**
 * @typedef {Object} RayResult
 * @property {boolean} hit
 * @property {number} toi  distance along the ray
 * @property {number} nx @property {number} ny @property {number} nz
 * @property {{kind:'terrain'|'prop'|'vehicle', ref:any}|null} target
 */

/**
 * Rapier (WASM) world wrapper: terrain heightfield, static prop colliders,
 * ray queries with a shared result object, and a 2D obstacle hash used for
 * cheap soldier-vs-prop resolution (soldiers are kinematic, not rigid bodies).
 */
export class PhysicsSystem {
  /**
   * @param {import('../world/map-generator.js').GameMap} map
   * @returns {Promise<PhysicsSystem>}
   */
  static async create(map) {
    await RAPIER.init();
    return new PhysicsSystem(map);
  }

  /** @param {import('../world/map-generator.js').GameMap} map */
  constructor(map) {
    this.R = RAPIER;
    this.map = map;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = CONFIG.fixedDt;
    /** @type {Map<number, {kind:'terrain'|'prop'|'vehicle', ref:any}>} */
    this.userData = new Map();
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    /** @type {RayResult} */
    this.result = { hit: false, toi: 0, nx: 0, ny: 1, nz: 0, target: null };

    this._buildTerrain();
    const hn = Math.ceil(CONFIG.world.size / HASH_CELL);
    this._hashN = hn;
    /** @type {import('../world/map-generator.js').Prop[][]} */
    this._hash = Array.from({ length: hn * hn }, () => []);
    for (const p of map.props) this._addProp(p);
    // Rapier builds its query acceleration structure during a step; prime it so
    // ray queries work before the first simulated frame.
    this.world.step();
  }

  _buildTerrain() {
    const t = this.map.terrain;
    const step = 4;
    const nr = Math.round(t.size / step);
    const heights = new Float32Array((nr + 1) * (nr + 1));
    for (let ix = 0; ix <= nr; ix++) {
      for (let iz = 0; iz <= nr; iz++) {
        heights[ix * (nr + 1) + iz] = t.height(-t.half + ix * step, -t.half + iz * step);
      }
    }
    const desc = RAPIER.ColliderDesc.heightfield(nr, nr, heights, { x: t.size, y: 1, z: t.size })
      .setCollisionGroups(groups(GROUP.WORLD, 0xffff)).setFriction(0.9);
    const col = this.world.createCollider(desc);
    this.userData.set(col.handle, { kind: 'terrain', ref: null });
  }

  /** Creates (or re-creates) the static collider of a prop. @param {import('../world/map-generator.js').Prop} p */
  createPropCollider(p) {
    const R = RAPIER;
    let desc;
    if (p.type === 'tree') {
      const hh = 2.4 * p.scale;
      desc = R.ColliderDesc.cylinder(hh, 0.32 * p.scale).setTranslation(p.x, p.y + hh, p.z);
    } else if (p.type === 'rock') {
      desc = R.ColliderDesc.ball(p.r).setTranslation(p.x, p.y + p.r * 0.25, p.z);
    } else {
      desc = R.ColliderDesc.cuboid(p.hx, p.hy, p.hz)
        .setTranslation(p.x, p.y + p.hy - 0.15, p.z)
        .setRotation({ x: 0, y: Math.sin(p.rot / 2), z: 0, w: Math.cos(p.rot / 2) });
    }
    desc.setCollisionGroups(groups(GROUP.WORLD, 0xffff));
    p.collider = this.world.createCollider(desc);
    this.userData.set(p.collider.handle, { kind: 'prop', ref: p });
  }

  /** @param {import('../world/map-generator.js').Prop} p */
  _addProp(p) {
    this.createPropCollider(p);
    const reach = (p.r || Math.hypot(p.hx, p.hz)) + 1;
    const c0x = this._hc(p.x - reach), c1x = this._hc(p.x + reach);
    const c0z = this._hc(p.z - reach), c1z = this._hc(p.z + reach);
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) this._hash[cz * this._hashN + cx].push(p);
  }

  _hc(v) { return clamp(Math.floor((v + this.map.terrain.half) / HASH_CELL), 0, this._hashN - 1); }

  /** Props whose footprint may touch the hash cell containing (x, z). */
  propsNear(x, z) { return this._hash[this._hc(z) * this._hashN + this._hc(x)]; }

  /** Removes a destroyed prop's collider (the hash entry is skipped via `alive`). */
  removeProp(p) {
    if (!p.collider) return;
    this.userData.delete(p.collider.handle);
    this.world.removeCollider(p.collider, false);
    p.collider = null;
  }

  /** @param {any} collider @param {any} ref */
  tagVehicle(collider, ref) { this.userData.set(collider.handle, { kind: 'vehicle', ref }); }
  untag(collider) { this.userData.delete(collider.handle); }

  step() { this.world.step(); }

  /**
   * Closest-hit ray query. The returned object is shared: read it immediately.
   * @param {number} mask  interaction groups (MASK_LOS / MASK_SHOT)
   * @param {any} [excludeBody]
   * @returns {RayResult}
   */
  castRay(ox, oy, oz, dx, dy, dz, maxDist, mask, excludeBody) {
    const ray = this._ray, res = this.result;
    ray.origin.x = ox; ray.origin.y = oy; ray.origin.z = oz;
    ray.dir.x = dx; ray.dir.y = dy; ray.dir.z = dz;
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, mask, undefined, excludeBody);
    if (!hit) { res.hit = false; res.toi = maxDist; res.target = null; return res; }
    res.hit = true;
    res.toi = hit.timeOfImpact;
    res.nx = hit.normal.x; res.ny = hit.normal.y; res.nz = hit.normal.z;
    res.target = this.userData.get(hit.collider.handle) || null;
    return res;
  }

  /** True when nothing static blocks the segment a->b. */
  losClear(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5) return true;
    const ray = this._ray;
    ray.origin.x = ax; ray.origin.y = ay; ray.origin.z = az;
    ray.dir.x = dx / len; ray.dir.y = dy / len; ray.dir.z = dz / len;
    return this.world.castRay(ray, len - 0.4, true, undefined, MASK_LOS) === null;
  }

  /**
   * Pushes a circle (soldier footprint) out of nearby static props.
   * @param {{x:number, z:number}} pos mutated in place
   * @returns {boolean} whether any correction was applied
   */
  pushOut(pos, radius) {
    const list = this.propsNear(pos.x, pos.z);
    let moved = false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.alive) continue;
      const dx = pos.x - p.x, dz = pos.z - p.z;
      if (p.r > 0) {
        const pr = (p.type === 'tree' ? 0.34 * p.scale : p.r * 0.92) + radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= pr * pr) continue;
        const d = Math.sqrt(d2) || 0.001;
        pos.x = p.x + (dx / d) * pr; pos.z = p.z + (dz / d) * pr;
        moved = true;
      } else {
        const c = Math.cos(p.rot), s = Math.sin(p.rot);
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        const ox = p.hx + radius - Math.abs(lx), oz = p.hz + radius - Math.abs(lz);
        if (ox <= 0 || oz <= 0) continue;
        let nlx = lx, nlz = lz;
        if (ox < oz) nlx = Math.sign(lx || 1) * (p.hx + radius);
        else nlz = Math.sign(lz || 1) * (p.hz + radius);
        pos.x = p.x + nlx * c + nlz * s; pos.z = p.z - nlx * s + nlz * c;
        moved = true;
      }
    }
    return moved;
  }
}
