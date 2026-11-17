import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { Pool } from '../core/pool.js';

const PARTS = 7;
// pivot xyz, centre offset from pivot xyz, size xyz
const DEF = [
  [0, 0.82, 0, 0, 0.32, 0, 0.5, 0.64, 0.28],        // torso
  [0, 1.46, 0, 0, 0.15, 0, 0.27, 0.27, 0.27],       // head
  [0.13, 0.82, 0, 0, -0.41, 0, 0.18, 0.82, 0.2],    // leg L
  [-0.13, 0.82, 0, 0, -0.41, 0, 0.18, 0.82, 0.2],   // leg R
  [0.32, 1.38, 0, 0, -0.26, 0, 0.13, 0.58, 0.14],   // arm L
  [-0.32, 1.38, 0, 0, -0.26, 0, 0.13, 0.58, 0.14],  // arm R
  [-0.16, 1.34, 0.12, 0, 0, 0.42, 0.07, 0.11, 0.84], // weapon
];
const RAGDOLLS = 16;
const RAGDOLL_LIFE = 11;

const _base = new THREE.Matrix4();
const _part = new THREE.Matrix4();
const _off = new THREE.Matrix4();
const _out = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _angles = new Float32Array(PARTS);

/**
 * Draws every soldier in the match with a single instanced draw call (seven
 * box instances per body), and owns the pooled ragdolls that replace a body
 * when its soldier dies.
 */
export class SoldierRenderer {
  /**
   * @param {import('./renderer.js').RenderSystem} render
   * @param {import('../entities/soldier.js').Soldier[]} soldiers
   * @param {import('../world/terrain.js').Terrain} terrain
   */
  constructor(render, soldiers, terrain) {
    this.soldiers = soldiers;
    this.terrain = terrain;
    const total = (soldiers.length + RAGDOLLS) * PARTS;
    const mat = render.setupMaterial(new THREE.MeshLambertMaterial());
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, total);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._teamColors = CONFIG.teams.map((t) => this._palette(t.color));
    soldiers.forEach((s, i) => this._paint(i * PARTS, s.team));
    for (let i = 0; i < total; i++) this.mesh.setMatrixAt(i, _zero);
    render.scene.add(this.mesh);

    this._ragBase = soldiers.length * PARTS;
    /** @type {Pool<{slot:number, life:number, pos:Float32Array, vel:Float32Array, quat:Float32Array, ang:Float32Array}>} */
    this.ragdolls = new Pool(RAGDOLLS, (i) => ({
      slot: i, life: 0, pos: new Float32Array(PARTS * 3), vel: new Float32Array(PARTS * 3),
      quat: new Float32Array(PARTS * 4), ang: new Float32Array(PARTS * 3),
    }));
  }

  _palette(hex) {
    const base = new THREE.Color(hex);
    const dark = base.clone().multiplyScalar(0.45);
    const mid = base.clone().multiplyScalar(0.75);
    const cloth = new THREE.Color(0x30343a), gun = new THREE.Color(0x121416);
    return [base, dark, cloth, cloth, mid, mid, gun];
  }

  _paint(first, team) {
    for (let k = 0; k < PARTS; k++) this.mesh.setColorAt(first + k, _c.copy(this._teamColors[team][k]));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Writes the seven part matrices of a posed soldier starting at instance `first`. */
  _pose(s, first) {
    const moving = Math.min(1, s.speed / 3);
    const swing = Math.sin(s.walkPhase) * 0.8 * moving;
    const seated = s.vehicle !== null;
    _angles[0] = -s.pitch * 0.25;
    _angles[1] = -s.pitch * 0.6;
    _angles[2] = seated ? -1.35 : swing;
    _angles[3] = seated ? -1.35 : -swing;
    _angles[4] = _angles[5] = -1.32 - s.pitch;
    _angles[6] = -s.pitch;
    _base.makeRotationY(s.yaw).setPosition(s.pos.x, s.pos.y + (seated ? 0.35 : 0), s.pos.z);
    for (let k = 0; k < PARTS; k++) {
      const d = DEF[k];
      _part.makeRotationX(_angles[k]).setPosition(d[0], d[1], d[2]);
      _off.makeTranslation(d[3], d[4], d[5]).scale(_s.set(d[6], d[7], d[8]));
      _out.multiplyMatrices(_base, _part).multiply(_off);
      this.mesh.setMatrixAt(first + k, _out);
    }
  }

  /**
   * Converts a soldier's current pose into a tumbling ragdoll.
   * @param {import('../entities/soldier.js').Soldier} s
   * @param {number} ix @param {number} iy @param {number} iz  impulse velocity
   */
  spawnRagdoll(s, ix, iy, iz) {
    const r = /** @type {NonNullable<ReturnType<typeof this.ragdolls.acquire>>} */ (this.ragdolls.acquire(true));
    r.life = RAGDOLL_LIFE;
    const first = this._ragBase + r.slot * PARTS;
    const vehicle = s.vehicle; s.vehicle = null; // pose standing even if killed in a seat
    this._pose(s, first);
    s.vehicle = vehicle;
    this._paint(first, s.team);
    for (let k = 0; k < PARTS; k++) {
      this.mesh.getMatrixAt(first + k, _out);
      _out.decompose(_p, _q, _s);
      r.pos[k * 3] = _p.x; r.pos[k * 3 + 1] = _p.y; r.pos[k * 3 + 2] = _p.z;
      r.quat[k * 4] = _q.x; r.quat[k * 4 + 1] = _q.y; r.quat[k * 4 + 2] = _q.z; r.quat[k * 4 + 3] = _q.w;
      const j = 0.6 + Math.random() * 0.8;
      r.vel[k * 3] = ix * j + (Math.random() - 0.5) * 1.6;
      r.vel[k * 3 + 1] = iy * j + 1.5 + Math.random() * 1.5;
      r.vel[k * 3 + 2] = iz * j + (Math.random() - 0.5) * 1.6;
      r.ang[k * 3] = (Math.random() - 0.5) * 9; r.ang[k * 3 + 1] = (Math.random() - 0.5) * 9; r.ang[k * 3 + 2] = (Math.random() - 0.5) * 9;
    }
  }

  _updateRagdolls(dt) {
    const pool = this.ragdolls;
    for (let i = pool.active - 1; i >= 0; i--) {
      const r = pool.items[i];
      const first = this._ragBase + r.slot * PARTS;
      r.life -= dt;
      if (r.life <= 0) {
        for (let k = 0; k < PARTS; k++) this.mesh.setMatrixAt(first + k, _zero);
        pool.releaseAt(i);
        continue;
      }
      const fade = Math.min(1, r.life); // shrink away during the last second
      for (let k = 0; k < PARTS; k++) {
        const p3 = k * 3, q4 = k * 4, d = DEF[k];
        r.vel[p3 + 1] -= 14 * dt;
        r.pos[p3] += r.vel[p3] * dt; r.pos[p3 + 1] += r.vel[p3 + 1] * dt; r.pos[p3 + 2] += r.vel[p3 + 2] * dt;
        const floor = this.terrain.height(r.pos[p3], r.pos[p3 + 2]) + Math.min(d[6], d[8]) * 0.5;
        if (r.pos[p3 + 1] < floor) {
          r.pos[p3 + 1] = floor;
          r.vel[p3 + 1] *= -0.25;
          const f = Math.exp(-9 * dt);
          r.vel[p3] *= f; r.vel[p3 + 2] *= f;
          r.ang[p3] *= f; r.ang[p3 + 1] *= f; r.ang[p3 + 2] *= f;
        }
        _q.set(r.quat[q4], r.quat[q4 + 1], r.quat[q4 + 2], r.quat[q4 + 3]);
        const ax = r.ang[p3] * dt, ay = r.ang[p3 + 1] * dt, az = r.ang[p3 + 2] * dt;
        _dq.set(ax * 0.5, ay * 0.5, az * 0.5, 1).normalize();
        _q.premultiply(_dq);
        r.quat[q4] = _q.x; r.quat[q4 + 1] = _q.y; r.quat[q4 + 2] = _q.z; r.quat[q4 + 3] = _q.w;
        _out.compose(_p.set(r.pos[p3], r.pos[p3 + 1], r.pos[p3 + 2]), _q, _s.set(d[6] * fade, d[7] * fade, d[8] * fade));
        this.mesh.setMatrixAt(first + k, _out);
      }
    }
  }

  /** @param {number} dt @param {boolean} firstPerson hide the player's own body */
  update(dt, firstPerson) {
    const list = this.soldiers;
    for (let i = 0; i < list.length; i++) {
      const s = list[i], first = i * PARTS;
      const enclosed = s.vehicle !== null && s.vehicle.def.type !== 'jeep';
      if (!s.alive || enclosed || (s.isPlayer && firstPerson)) {
        for (let k = 0; k < PARTS; k++) this.mesh.setMatrixAt(first + k, _zero);
      } else this._pose(s, first);
    }
    this._updateRagdolls(dt);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
