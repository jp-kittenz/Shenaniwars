import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { Pool } from '../core/pool.js';
import { FACTIONS } from '../entities/factions.js';
import { BONE, BONE_COUNT, RIG, poseSoldier, limbMatrix } from '../entities/soldier-rig.js';
import { buildSoldierParts, mergeSkinned } from '../entities/models/soldier-model.js';

const RAGDOLLS = 28;
const RAGDOLL_LIFE = 10;
const LOD_DIST = 32;
/** At most this many soldiers use the detailed body at once (nearest first). */
const HI_MAX = 20;
const JOINTS = 15;
const MAT_FLOATS = BONE_COUNT * 16;

// Ragdoll distance constraints between joints (see poseSoldier joint layout).
const LINKS = [
  [0, 1], [1, 3], [1, 6], [3, 6], [0, 3], [0, 6], [0, 9], [0, 12], [9, 12], [3, 9], [6, 12], [1, 9], [1, 12],
  [1, 2], [2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [9, 10], [10, 11], [12, 13], [13, 14],
];
const JOINT_R = [0.12, 0.12, 0.17, 0.08, 0.07, 0.07, 0.08, 0.07, 0.07, 0.09, 0.08, 0.08, 0.09, 0.08, 0.08];

const SKIN_VERT_HEAD = /* glsl */ `
attribute float aSlot;
attribute float aBone;
uniform highp sampler2D uBones;
mat4 soldierBone() {
  int x = int(aBone + 0.5) * 4;
  int y = int(aSlot + 0.5);
  return mat4(texelFetch(uBones, ivec2(x, y), 0), texelFetch(uBones, ivec2(x + 1, y), 0),
              texelFetch(uBones, ivec2(x + 2, y), 0), texelFetch(uBones, ivec2(x + 3, y), 0));
}`;

/** Injects GPU bone skinning into a built-in material's vertex shader (chained after CSM's hook). */
function skin(material, texture, key) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    shader.uniforms.uBones = { value: texture };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SKIN_VERT_HEAD}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = mat3(soldierBone()) * normal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = (soldierBone() * vec4(position, 1.0)).xyz;');
  };
  material.customProgramCacheKey = () => `soldier-skin-${key}`;
  return material;
}

/**
 * @typedef {Object} Ragdoll
 * @property {number} slot @property {number} team @property {number} life
 * @property {Float32Array} p @property {Float32Array} o  joint positions / previous positions
 * @property {Float32Array} rest   link rest lengths
 * @property {Float32Array} pose   bone matrices at death (weapon, mag, pack)
 * @property {THREE.Vector3} wPos @property {THREE.Vector3} wVel @property {THREE.Quaternion} wRot @property {THREE.Vector3} wSpin
 * @property {number} weaponBone @property {number} magBone
 * @property {THREE.Matrix4} torso0Inv  inverse torso matrix at death (carries pack and slung kit)
 * @property {THREE.Matrix4} weapon0Inv inverse weapon matrix at death (carries its magazine)
 */

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _a = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _dq = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _eul = new THREE.Euler();
const J = Array.from({ length: JOINTS }, () => new THREE.Vector3());
const _tmpJoints = new Float32Array(JOINTS * 3);
const _tmpPose = new Float32Array(MAT_FLOATS);

/**
 * Renders every soldier with GPU skinning: per team, one draw call for the
 * near (detailed) level and one for the far level, whatever the head count.
 * Each soldier owns a row of a float texture holding its bone matrices; the
 * instanced `aSlot` attribute lists which rows to draw this frame, so culled
 * soldiers cost nothing on the GPU. Deaths become verlet ragdolls that keep
 * the body connected while it tumbles.
 */
export class SoldierRenderer {
  /**
   * @param {import('./renderer.js').RenderSystem} render
   * @param {import('../entities/soldier.js').Soldier[]} soldiers
   * @param {import('../world/terrain.js').Terrain} terrain
   */
  constructor(render, soldiers, terrain) {
    this.render = render;
    this.soldiers = soldiers;
    this.terrain = terrain;
    this.teams = CONFIG.teams.map((cfg, t) => {
      const members = soldiers.filter((s) => s.team === t);
      members.forEach((s, i) => { s.row = i; });
      const faction = FACTIONS[cfg.faction];
      const capacity = members.length + RAGDOLLS;
      const data = new Float32Array(capacity * MAT_FLOATS);
      const tex = new THREE.DataTexture(data, BONE_COUNT * 4, capacity, THREE.RGBAFormat, THREE.FloatType);
      tex.minFilter = tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      const material = skin(render.setupMaterial(new THREE.MeshLambertMaterial({ vertexColors: true })), tex, `c${t}`);
      const depth = skin(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), tex, `d${t}`);
      const lods = [0, 1].map((lod) => {
        const base = mergeSkinned(buildSoldierParts(cfg.faction, t, /** @type {0|1} */ (lod)));
        const geo = new THREE.InstancedBufferGeometry();
        geo.index = base.index;
        for (const k in base.attributes) geo.setAttribute(k, base.attributes[k]);
        const slots = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
        slots.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('aSlot', slots);
        geo.instanceCount = 0;
        const mesh = new THREE.Mesh(geo, material);
        mesh.customDepthMaterial = depth;
        mesh.frustumCulled = false;
        // Far bodies only cast shadows on the high tier.
        mesh.castShadow = lod === 0 || render.quality?.cascades >= 3;
        mesh.receiveShadow = true;
        render.scene.add(mesh);
        return { mesh, geo, slots, count: 0, verts: base.attributes.position.count };
      });
      return { faction, members, capacity, data, tex, lods };
    });
    /** @type {Pool<Ragdoll>} */
    this.ragdolls = new Pool(RAGDOLLS * 2, (i) => ({
      slot: i, team: 0, life: 0, p: new Float32Array(JOINTS * 3), o: new Float32Array(JOINTS * 3), rest: new Float32Array(LINKS.length),
      pose: new Float32Array(MAT_FLOATS), wPos: new THREE.Vector3(), wVel: new THREE.Vector3(), wRot: new THREE.Quaternion(), wSpin: new THREE.Vector3(),
      weaponBone: -1, magBone: -1, torso0Inv: new THREE.Matrix4(), weapon0Inv: new THREE.Matrix4(),
    }));
    this._time = 0;
    /** @type {import('../entities/soldier.js').Soldier[]} scratch list of visible soldiers */
    this._visible = [];
  }

  /** Vertex counts per soldier for each LOD (diagnostics). */
  get stats() { return this.teams.map((t) => t.lods.map((l) => l.verts)); }

  /**
   * Converts a soldier's current pose into a ragdoll with an impulse.
   * @param {import('../entities/soldier.js').Soldier} s
   */
  spawnRagdoll(s, ix, iy, iz) {
    const team = this.teams[s.team];
    // Per-team row budget: recycle that team's oldest ragdoll when full.
    let used = 0, oldest = -1, oldestLife = 1e9;
    for (let i = 0; i < this.ragdolls.active; i++) {
      const it = this.ragdolls.items[i];
      if (it.team !== s.team) continue;
      used++;
      if (it.life < oldestLife) { oldestLife = it.life; oldest = i; }
    }
    if (used >= RAGDOLLS && oldest >= 0) this.ragdolls.releaseAt(oldest);
    const r = /** @type {Ragdoll} */ (this.ragdolls.acquire(true));
    // Rows: each team reserves RAGDOLLS rows after its soldiers; find a free one.
    const taken = new Set();
    for (let i = 0; i < this.ragdolls.active; i++) { const it = this.ragdolls.items[i]; if (it !== r && it.team === s.team) taken.add(it.slot); }
    let slot = 0;
    while (taken.has(slot)) slot++;
    r.slot = slot; r.team = s.team; r.life = RAGDOLL_LIFE;
    s.ragdollPose = true;
    poseSoldier(s, team.faction, this._time, r.pose, 0, _tmpJoints);
    s.ragdollPose = false;
    r.p.set(_tmpJoints);
    const dt = 1 / 60;
    for (let j = 0; j < JOINTS; j++) {
      const k = j * 3, jitter = 0.6 + Math.random() * 0.8;
      r.o[k] = r.p[k] - (ix * jitter + (Math.random() - 0.5) * 1.2) * dt;
      r.o[k + 1] = r.p[k + 1] - (iy * jitter + 1 + Math.random()) * dt;
      r.o[k + 2] = r.p[k + 2] - (iz * jitter + (Math.random() - 0.5) * 1.2) * dt;
    }
    for (let l = 0; l < LINKS.length; l++) {
      const a = LINKS[l][0] * 3, b = LINKS[l][1] * 3;
      r.rest[l] = Math.hypot(r.p[a] - r.p[b], r.p[a + 1] - r.p[b + 1], r.p[a + 2] - r.p[b + 2]);
    }
    // The weapon in hand drops separately.
    r.weaponBone = -1;
    for (const b of [BONE.RIFLE_A, BONE.RIFLE_B, BONE.LAUNCHER]) {
      const o = b * 16;
      if (r.pose[o + 15] === 0) continue;
      // Slung weapons have their origin above the hips on the back; the one in hand is in front.
      _m.fromArray(r.pose, o);
      _a.setFromMatrixPosition(_m);
      const handDist = Math.hypot(_a.x - r.p[24], _a.y - r.p[25], _a.z - r.p[26]);
      if (handDist < 0.6) { r.weaponBone = b; r.magBone = b === BONE.LAUNCHER ? BONE.ROCKET : b + 1; break; }
    }
    r.torso0Inv.fromArray(r.pose, BONE.TORSO * 16).invert();
    if (r.weaponBone >= 0) {
      _m.fromArray(r.pose, r.weaponBone * 16);
      r.weapon0Inv.copy(_m).invert();
      _m.decompose(r.wPos, r.wRot, _s);
      r.wVel.set(ix * 0.5 + (Math.random() - 0.5) * 2, 1.5 + Math.random() * 2, iz * 0.5 + (Math.random() - 0.5) * 2);
      r.wSpin.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
    }
  }

  _stepRagdoll(r, dt) {
    const p = r.p, o = r.o, t = this.terrain;
    const sink = Math.max(0, 1.5 - r.life) * 0.4;
    for (let j = 0; j < JOINTS; j++) {
      const k = j * 3;
      const vx = (p[k] - o[k]) * 0.985, vy = (p[k + 1] - o[k + 1]) * 0.985, vz = (p[k + 2] - o[k + 2]) * 0.985;
      o[k] = p[k]; o[k + 1] = p[k + 1]; o[k + 2] = p[k + 2];
      p[k] += vx; p[k + 1] += vy - 14 * dt * dt; p[k + 2] += vz;
    }
    for (let it = 0; it < 5; it++) {
      for (let l = 0; l < LINKS.length; l++) {
        const a = LINKS[l][0] * 3, b = LINKS[l][1] * 3;
        const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        const k = ((d - r.rest[l]) / d) * 0.5;
        p[a] += dx * k; p[a + 1] += dy * k; p[a + 2] += dz * k;
        p[b] -= dx * k; p[b + 1] -= dy * k; p[b + 2] -= dz * k;
      }
      for (let j = 0; j < JOINTS; j++) {
        const k = j * 3;
        const floor = t.height(p[k], p[k + 2]) + JOINT_R[j] - sink;
        if (p[k + 1] < floor) {
          p[k + 1] = floor;
          // Ground friction: kill most sliding.
          o[k] += (p[k] - o[k]) * 0.35; o[k + 2] += (p[k + 2] - o[k + 2]) * 0.35;
        }
      }
    }
    if (r.weaponBone >= 0) {
      r.wVel.y -= 14 * dt;
      r.wPos.addScaledVector(r.wVel, dt);
      const floor = t.height(r.wPos.x, r.wPos.z) + 0.05 - sink;
      if (r.wPos.y < floor) { r.wPos.y = floor; r.wVel.multiplyScalar(0.4); r.wVel.y = Math.abs(r.wVel.y) * 0.2; r.wSpin.multiplyScalar(0.5); }
      _dq.setFromEuler(_eul.set(r.wSpin.x * dt, r.wSpin.y * dt, r.wSpin.z * dt));
      r.wRot.premultiply(_dq).normalize();
    }
  }

  /** Rebuilds a ragdoll's bone matrices from its joints into its texture row. */
  _writeRagdoll(r, out, off) {
    out.fill(0, off, off + MAT_FLOATS);
    const p = r.p;
    for (let j = 0; j < JOINTS; j++) J[j].set(p[j * 3], p[j * 3 + 1], p[j * 3 + 2]);
    const [pel, neck, head, shL, elL, haL, shR, elR, haR, hipL, knL, ftL, hipR, knR, ftR] = J;
    // Torso frame from the spine and shoulder line.
    _y.subVectors(neck, pel).normalize();
    _x.subVectors(shL, shR); _x.addScaledVector(_y, -_x.dot(_y)).normalize();
    _z.crossVectors(_x, _y);
    _m.makeBasis(_x, _y, _z).setPosition(pel);
    _m.toArray(out, off + BONE.PELVIS * 16);
    _m.setPosition(_a.copy(pel).addScaledVector(_y, RIG.waist));
    _m.toArray(out, off + BONE.TORSO * 16);
    // Pack and slung weapons ride along with the torso.
    for (const b of [BONE.PACK, BONE.RIFLE_A, BONE.MAG_A, BONE.RIFLE_B, BONE.MAG_B, BONE.LAUNCHER, BONE.ROCKET]) {
      if (b === r.weaponBone || b === r.magBone || r.pose[b * 16 + 15] === 0) continue;
      _m2.fromArray(r.pose, b * 16).premultiply(r.torso0Inv).premultiply(_m);
      _m2.toArray(out, off + b * 16);
    }
    _y.subVectors(head, neck).normalize();
    _d.copy(_x).addScaledVector(_y, -_x.dot(_y)).normalize();
    _m.makeBasis(_d, _y, _c.crossVectors(_d, _y)).setPosition(neck);
    _m.toArray(out, off + BONE.HEAD * 16);
    limbMatrix(shL, elL, _z, _m).toArray(out, off + BONE.UARM_L * 16);
    limbMatrix(elL, haL, _z, _m).toArray(out, off + BONE.FARM_L * 16);
    limbMatrix(shR, elR, _z, _m).toArray(out, off + BONE.UARM_R * 16);
    limbMatrix(elR, haR, _z, _m).toArray(out, off + BONE.FARM_R * 16);
    limbMatrix(hipL, knL, _z, _m).toArray(out, off + BONE.THIGH_L * 16);
    limbMatrix(knL, ftL, _z, _m).toArray(out, off + BONE.SHIN_L * 16);
    limbMatrix(hipR, knR, _z, _m).toArray(out, off + BONE.THIGH_R * 16);
    limbMatrix(knR, ftR, _z, _m).toArray(out, off + BONE.SHIN_R * 16);
    // The dropped weapon tumbles on its own, keeping its magazine.
    if (r.weaponBone >= 0) {
      _m.compose(r.wPos, r.wRot, _s).toArray(out, off + r.weaponBone * 16);
      if (r.pose[r.magBone * 16 + 15] !== 0) {
        _m2.fromArray(r.pose, r.magBone * 16).premultiply(r.weapon0Inv).premultiply(_m);
        _m2.toArray(out, off + r.magBone * 16);
      }
    }
  }

  /**
   * @param {number} dt
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('../entities/soldier.js').Soldier|null} hidden  soldier not to draw (first-person player)
   */
  update(dt, camera, hidden) {
    this._time += dt;
    camera.updateMatrixWorld();
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const lod2 = (LOD_DIST * (this.render.baseFov / camera.fov)) ** 2;
    // Gather visible soldiers with their distance; the nearest few get the detailed body.
    const vis = this._visible;
    vis.length = 0;
    for (const team of this.teams) {
      team.lods[0].count = 0; team.lods[1].count = 0;
      const n = team.members.length;
      for (let i = 0; i < n; i++) {
        const s = team.members[i];
        if (!s.alive || s === hidden) continue;
        if (s.vehicle && !s.vehicle.def.openSeats) continue;
        _sphere.center.set(s.pos.x, s.pos.y + 1, s.pos.z);
        _sphere.radius = s.parachute ? 4 : 1.5;
        if (!_frustum.intersectsSphere(_sphere)) continue;
        s.camDist2 = (s.pos.x - cx) ** 2 + (s.pos.y - cy) ** 2 + (s.pos.z - cz) ** 2;
        vis.push(s);
      }
    }
    if (vis.length > HI_MAX) vis.sort((a, b) => a.camDist2 - b.camDist2);
    for (let i = 0; i < vis.length; i++) {
      const s = vis[i], team = this.teams[s.team];
      const l = team.lods[i < HI_MAX && s.camDist2 < lod2 ? 0 : 1];
      poseSoldier(s, team.faction, this._time, team.data, s.row * MAT_FLOATS);
      l.slots.array[l.count++] = s.row;
    }
    const pool = this.ragdolls;
    for (let i = pool.active - 1; i >= 0; i--) {
      const r = pool.items[i];
      r.life -= dt;
      if (r.life <= 0) { pool.releaseAt(i); continue; }
      this._stepRagdoll(r, Math.min(dt, 1 / 30));
      const team = this.teams[r.team];
      const row = team.members.length + r.slot;
      this._writeRagdoll(r, team.data, row * MAT_FLOATS);
      const d2 = (r.p[0] - cx) ** 2 + (r.p[1] - cy) ** 2 + (r.p[2] - cz) ** 2;
      const l = team.lods[d2 < lod2 ? 0 : 1];
      l.slots.array[l.count++] = row;
    }
    for (const team of this.teams) {
      for (const l of team.lods) {
        l.geo.instanceCount = l.count;
        l.mesh.visible = l.count > 0;
        l.slots.needsUpdate = true;
      }
      team.tex.needsUpdate = true;
    }
  }
}
