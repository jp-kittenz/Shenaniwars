import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { noise2, smoothstep, clamp } from '../core/math.js';
import { buildPropGeometry } from '../world/prop-geometry.js';
import { cyl, box, merge } from '../world/geo.js';

const SEGS = [32, 8]; // grid resolution per LOD (hi, lo)
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = { x: 0, y: 1, z: 0 };
const UP = new THREE.Vector3(0, 1, 0);

/**
 * @typedef {Object} Chunk
 * @property {number} x @property {number} z   centre
 * @property {import('../world/map-generator.js').Prop[]} props  static props owned by this chunk
 * @property {(THREE.Mesh|null)[]} terrain  per LOD
 * @property {(THREE.Mesh|null)[]} propMesh per LOD
 * @property {boolean[]} built
 * @property {number} lod  -1 hidden, 0 hi, 1 lo
 * @property {number} want
 */

/**
 * Spatial streaming of the world's render data. The map is cut into square
 * chunks; each chunk lazily builds a high and a low detail terrain patch plus
 * one batched prop mesh per LOD, shows whichever suits its distance from the
 * camera, and frees GPU memory again once it falls well outside view range.
 * Builds are amortised (one per frame) so streaming never causes a hitch.
 */
export class ChunkManager {
  /**
   * @param {import('./renderer.js').RenderSystem} render
   * @param {import('../world/map-generator.js').GameMap} map
   */
  constructor(render, map) {
    this.render = render;
    this.map = map;
    this.terrain = map.terrain;
    this.size = CONFIG.world.chunkSize;
    this.n = Math.round(CONFIG.world.size / this.size);
    this.group = new THREE.Group();
    render.scene.add(this.group);

    this.terrainMat = render.setupMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.propMat = render.setupMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));

    /** @type {Chunk[]} */
    this.chunks = [];
    const half = this.terrain.half;
    for (let cz = 0; cz < this.n; cz++) {
      for (let cx = 0; cx < this.n; cx++) {
        this.chunks.push({
          x: -half + (cx + 0.5) * this.size, z: -half + (cz + 0.5) * this.size,
          props: [], terrain: [null, null], propMesh: [null, null], built: [false, false], lod: -1, want: -1,
        });
      }
    }
    for (const p of map.props) {
      if (p.destructible) continue;
      const cx = clamp(Math.floor((p.x + half) / this.size), 0, this.n - 1);
      const cz = clamp(Math.floor((p.z + half) / this.size), 0, this.n - 1);
      this.chunks[cz * this.n + cx].props.push(p);
    }
    /** @type {Chunk[]} */
    this._queue = [];
    this._timer = 0;
    this.stats = { built: 0, visible: 0 };

    this._buildDestructibles();
    this._buildWater();
    this._buildFlags();
  }

  // --- Terrain patches --------------------------------------------------------

  /** @param {Chunk} c @param {0|1} lod */
  _buildTerrain(c, lod) {
    const segs = SEGS[lod], t = this.terrain, size = this.size;
    const side = segs + 3; // +1 for fence posts, +2 for the skirt ring that hides LOD cracks
    const count = side * side;
    const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), col = new Float32Array(count * 3);
    const x0 = c.x - size / 2, z0 = c.z - size / 2, step = size / segs;
    const seed = CONFIG.seed;
    let o = 0;
    for (let j = -1; j <= segs + 1; j++) {
      for (let i = -1; i <= segs + 1; i++, o += 3) {
        const skirt = i < 0 || j < 0 || i > segs || j > segs;
        const x = x0 + clamp(i, 0, segs) * step, z = z0 + clamp(j, 0, segs) * step;
        const h = t.height(x, z);
        pos[o] = x; pos[o + 1] = skirt ? h - (lod ? 9 : 3) : h; pos[o + 2] = z;
        t.normal(x, z, _n);
        nrm[o] = _n.x; nrm[o + 1] = _n.y; nrm[o + 2] = _n.z;
        // Biome colouring: sand at the shore, grass, exposed rock on slopes, dirt roads.
        const v = 0.5 + 0.5 * noise2(x / 23, z / 23, seed + 900);
        const v2 = 0.5 + 0.5 * noise2(x / 5.1, z / 5.1, seed + 901);
        let r = 0.085 + 0.05 * v, g = 0.19 + 0.085 * v + 0.03 * v2, b = 0.045 + 0.02 * v;
        const dry = smoothstep(26, 44, h + v * 6);
        r += (0.21 - r) * dry * 0.6; g += (0.2 - g) * dry * 0.6; b += (0.1 - b) * dry * 0.6;
        const rock = smoothstep(0.55, 0.85, 1 - _n.y + (1 - _n.y) * 1.4);
        r += (0.19 - r) * rock; g += (0.175 - g) * rock; b += (0.16 - b) * rock;
        const sand = smoothstep(2.4, 0.6, h);
        r += (0.5 - r) * sand; g += (0.43 - g) * sand; b += (0.25 - b) * sand;
        const road = t.roadAt(x, z) * (0.75 + 0.25 * v2);
        r += (0.22 - r) * road; g += (0.17 - g) * road; b += (0.11 - b) * road;
        // Runway: concrete slabs with expansion joints and a dashed centreline.
        const paved = t.pavedAt(x, z);
        if (paved > 0) {
          const joint = (Math.abs(((x % 12) + 12) % 12 - 6) > 5.7 ? 0.82 : 1) * (0.92 + 0.08 * v2);
          const rw = this.map.runways.find((w) => Math.abs(z - w.z) < w.width);
          const stripe = rw && Math.abs(z - rw.z) < 0.6 && ((Math.abs(x) % 14) < 8) ? 1 : 0;
          const c = stripe ? 0.6 : 0.23 * joint;
          r += (c - r) * paved; g += (c - g) * paved; b += ((stripe ? 0.55 : 0.235 * joint) - b) * paved;
        }
        col[o] = r; col[o + 1] = g; col[o + 2] = b;
      }
    }
    const idx = new Uint16Array((side - 1) * (side - 1) * 6);
    let k = 0;
    for (let j = 0; j < side - 1; j++) {
      for (let i = 0; i < side - 1; i++) {
        const a = j * side + i, b2 = a + 1, d = a + side, e = d + 1;
        idx[k++] = a; idx[k++] = d; idx[k++] = b2; idx[k++] = b2; idx[k++] = d; idx[k++] = e;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** @param {Chunk} c @param {0|1} lod */
  _build(c, lod) {
    c.terrain[lod] = this._buildTerrain(c, lod);
    this.group.add(c.terrain[lod]);
    let geo = buildPropGeometry(c.props, lod);
    if (geo && lod === 1) {
      // Far LOD: fold the simplified props into the terrain patch so a distant chunk is a single draw call.
      const mesh = /** @type {THREE.Mesh} */ (c.terrain[1]);
      mesh.geometry = this._fold(mesh.geometry, geo);
      geo = null;
    }
    if (geo) {
      const mesh = new THREE.Mesh(geo, this.propMat);
      mesh.castShadow = lod === 0;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      c.propMesh[lod] = mesh;
      this.group.add(mesh);
    }
    c.built[lod] = true;
    this.stats.built++;
  }

  /**
   * Appends a non-indexed geometry to an indexed one (both are disposed).
   * @param {THREE.BufferGeometry} base @param {THREE.BufferGeometry} extra
   */
  _fold(base, extra) {
    const n = base.attributes.position.count, m = extra.attributes.position.count;
    const out = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'color']) {
      const arr = new Float32Array((n + m) * 3);
      arr.set(/** @type {Float32Array} */ (base.attributes[name].array), 0);
      arr.set(/** @type {Float32Array} */ (extra.attributes[name].array), n * 3);
      out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
    }
    const bi = /** @type {THREE.BufferAttribute} */ (base.index).array;
    const idx = n + m > 65535 ? new Uint32Array(bi.length + m) : new Uint16Array(bi.length + m);
    idx.set(bi, 0);
    for (let i = 0; i < m; i++) idx[bi.length + i] = n + i;
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    base.dispose(); extra.dispose();
    return out;
  }

  /** @param {Chunk} c @param {0|1} lod */
  _dispose(c, lod) {
    for (const mesh of [c.terrain[lod], c.propMesh[lod]]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    c.terrain[lod] = null; c.propMesh[lod] = null; c.built[lod] = false;
    this.stats.built--;
  }

  _apply(c) {
    for (let lod = 0; lod < 2; lod++) {
      const on = c.lod === lod;
      if (c.terrain[lod]) c.terrain[lod].visible = on;
      if (c.propMesh[lod]) c.propMesh[lod].visible = on;
    }
  }

  /**
   * Re-evaluates chunk LODs around the camera and advances the build queue.
   * @param {THREE.Vector3} cam
   * @param {boolean} [sync] build everything needed immediately (loading screen)
   */
  update(dt, cam, sync = false) {
    this._timer -= dt;
    if (this._timer <= 0 || sync) {
      this._timer = 0.25;
      const q = this.render.quality, halfDiag = this.size * 0.71;
      this._queue.length = 0;
      let visible = 0;
      for (const c of this.chunks) {
        const d = Math.hypot(c.x - cam.x, c.z - cam.z) - halfDiag;
        // Hysteresis on the hi->lo boundary avoids LOD flicker when strafing along it.
        const hi = d < q.hiLodDist + (c.lod === 0 ? 16 : 0);
        c.want = d > q.viewDist ? -1 : hi ? 0 : 1;
        if (c.want >= 0) {
          visible++;
          if (!c.built[c.want]) { c._d = d; this._queue.push(c); }
          else if (c.lod !== c.want) { c.lod = c.want; this._apply(c); }
        } else if (c.lod !== -1) { c.lod = -1; this._apply(c); }
        // Unload: hi-detail data well beyond its switch distance, everything beyond view range.
        if (c.built[0] && d > q.hiLodDist + 140) this._dispose(c, 0);
        if (c.built[1] && d > q.viewDist + 160) this._dispose(c, 1);
      }
      this.stats.visible = visible;
      this._queue.sort((a, b) => b._d - a._d);
    }
    let budget = sync ? 1e9 : 1;
    while (budget-- > 0 && this._queue.length) {
      const c = /** @type {Chunk} */ (this._queue.pop());
      if (c.want < 0 || c.built[c.want]) continue;
      this._build(c, /** @type {0|1} */ (c.want));
      c.lod = c.want;
      this._apply(c);
    }
  }

  // --- Global world dressing --------------------------------------------------

  _buildDestructibles() {
    const mk = (type, color) => {
      const list = this.map.props.filter((p) => p.type === type);
      const mat = this.render.setupMaterial(new THREE.MeshLambertMaterial({ color }));
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), mat, Math.max(1, list.length));
      mesh.count = list.length;
      list.forEach((p, i) => {
        p.instance = i;
        _m.compose(_p.set(p.x, p.y + p.hy - 0.15, p.z), _q.setFromAxisAngle(UP, p.rot), _s.set(p.hx, p.hy, p.hz));
        mesh.setMatrixAt(i, _m);
      });
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      this.render.scene.add(mesh);
      return mesh;
    };
    this.destructibles = { barrier: mk('barrier', 0xa9a69c), crate: mk('crate', 0x8a6a3c) };
  }

  /** Hides a destroyed barrier/crate instance. @param {import('../world/map-generator.js').Prop} p */
  removeDestructible(p) {
    const mesh = this.destructibles[p.type];
    if (!mesh || p.instance < 0) return;
    _m.makeScale(0, 0, 0);
    mesh.setMatrixAt(p.instance, _m);
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Restores every destructible to match `alive` flags (after a state restore). */
  refreshDestructibles() {
    for (const p of this.map.props) {
      if (!p.destructible) continue;
      const mesh = this.destructibles[p.type];
      if (p.alive) _m.compose(_p.set(p.x, p.y + p.hy - 0.15, p.z), _q.setFromAxisAngle(UP, p.rot), _s.set(p.hx, p.hy, p.hz));
      else _m.makeScale(0, 0, 0);
      mesh.setMatrixAt(p.instance, _m);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  _buildWater() {
    const mat = new THREE.MeshLambertMaterial({ color: 0x1d5f7c, transparent: true, opacity: 0.86 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = CONFIG.world.waterLevel;
    mesh.renderOrder = 2;
    this.render.scene.add(mesh);
    this.water = mesh;
  }

  _buildFlags() {
    const poles = [];
    /** @type {THREE.Mesh[]} */
    this.banners = [];
    for (const f of this.map.flags) {
      poles.push(cyl(0.09, 0.12, 11, 6, f.x, f.y + 5.5, f.z, 0xcfd2d4), box(1.4, 0.3, 1.4, f.x, f.y + 0.15, f.z, 0x5a5d60));
      const banner = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.9, 0.06), new THREE.MeshLambertMaterial({ color: 0xdddddd }));
      banner.position.set(f.x + 1.7, f.y + 9.8, f.z);
      this.render.scene.add(banner);
      this.banners.push(banner);
    }
    const mesh = new THREE.Mesh(merge(poles), this.render.setupMaterial(new THREE.MeshLambertMaterial({ vertexColors: true })));
    mesh.castShadow = true;
    this.render.scene.add(mesh);
  }

  /** @param {number} flagId @param {number} owner -1 neutral */
  setFlagOwner(flagId, owner) {
    /** @type {THREE.MeshLambertMaterial} */ (this.banners[flagId].material).color.set(owner < 0 ? 0xdddddd : CONFIG.teams[owner].color);
  }
}
