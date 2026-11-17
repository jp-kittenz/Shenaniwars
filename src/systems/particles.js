import * as THREE from 'three';
import { Pool } from '../core/pool.js';

const VERT = /* glsl */ `
attribute vec4 aData; // size (m), alpha, additive, unused
attribute vec3 color;
uniform float uScale;
varying vec3 vColor;
varying vec2 vData;
void main() {
  vColor = color;
  vData = aData.yz;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aData.x * uScale / max(-mv.z, 0.1), 256.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying vec2 vData;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.18, d) * vData.x;
  if (a < 0.004) discard;
  // Premultiplied output lets additive (fire) and alpha (smoke) particles share one draw call.
  gl_FragColor = vec4(vColor * a, a * (1.0 - vData.y));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const TRACERS = 48;

/**
 * Fixed-capacity GPU point-sprite particle system plus pooled bullet tracers.
 * All state lives in typed arrays that are allocated once; emitting never
 * allocates and the whole system costs two draw calls.
 */
export class ParticleSystem {
  /** @param {import('./renderer.js').RenderSystem} render */
  constructor(render) {
    this.render = render;
    const n = (this.capacity = render.quality.particles);
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.data = new Float32Array(n * 4);
    this.col = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this._next = 0;

    const geo = new THREE.BufferGeometry();
    this._aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this._aData = new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage);
    this._aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._aPos);
    geo.setAttribute('aData', this._aData);
    geo.setAttribute('color', this._aCol);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: { uScale: { value: 500 } },
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    render.scene.add(this.points);

    const tracerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 3.4, 1.4), toneMapped: false, fog: false });
    this.tracerMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), tracerMat, TRACERS);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < TRACERS; i++) this.tracerMesh.setMatrixAt(i, _zero);
    render.scene.add(this.tracerMesh);
    /** @type {Pool<{slot:number, ox:number, oy:number, oz:number, dx:number, dy:number, dz:number, dist:number, t:number}>} */
    this.tracers = new Pool(TRACERS, (i) => ({ slot: i, ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 1, dist: 0, t: 0 }));
  }

  /** Emits one particle (overwrites the oldest when the ring is full). */
  emit(x, y, z, vx, vy, vz, life, size0, size1, r, g, b, alpha, additive, gravity, drag) {
    const i = this._next;
    this._next = (i + 1) % this.capacity;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    this.life[i] = this.maxLife[i] = life;
    this.size0[i] = size0; this.size1[i] = size1;
    this.alpha[i] = alpha; this.grav[i] = gravity; this.drag[i] = drag;
    this.data[i * 4 + 2] = additive;
  }

  muzzleFlash(x, y, z, dx, dy, dz, big = 1) {
    this.emit(x, y, z, dx * 3, dy * 3, dz * 3, 0.06, 0.55 * big, 0.2 * big, 6, 3.6, 1.2, 1, 1, 0, 0);
    this.emit(x, y, z, dx * 2, dy * 2 + 0.5, dz * 2, 0.5, 0.25 * big, 0.9 * big, 0.5, 0.5, 0.5, 0.22, 0, -0.6, 2);
  }

  impact(x, y, z, nx, ny, nz, r, g, b) {
    for (let i = 0; i < 4; i++) {
      this.emit(x, y, z, nx * 2.5 + (Math.random() - 0.5) * 3, ny * 2.5 + Math.random() * 2.5, nz * 2.5 + (Math.random() - 0.5) * 3,
        0.45 + Math.random() * 0.3, 0.14, 0.5, r, g, b, 0.55, 0, 5, 2.5);
    }
  }

  sparks(x, y, z, count = 5) {
    for (let i = 0; i < count; i++) {
      this.emit(x, y, z, (Math.random() - 0.5) * 9, Math.random() * 6, (Math.random() - 0.5) * 9,
        0.25 + Math.random() * 0.25, 0.09, 0.02, 6, 3.5, 1, 1, 1, 12, 1);
    }
  }

  explosion(x, y, z, radius) {
    const s = radius / 7;
    this.emit(x, y + 0.5, z, 0, 0, 0, 0.14, radius * 1.6, radius * 2.6, 7, 5, 2.5, 1, 1, 0, 0);
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, v = (2 + Math.random() * 5) * s;
      this.emit(x, y + 0.4, z, Math.cos(a) * v, 2 + Math.random() * 6 * s, Math.sin(a) * v, 0.35 + Math.random() * 0.3, 2.2 * s, 3.6 * s, 5, 2.2, 0.5, 0.9, 1, -1, 2);
    }
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2, v = (1 + Math.random() * 3.5) * s;
      const c = 0.1 + Math.random() * 0.14;
      this.emit(x, y + 0.6, z, Math.cos(a) * v, 1.5 + Math.random() * 4.5 * s, Math.sin(a) * v, 1.6 + Math.random() * 1.6, 2.4 * s, 6.5 * s, c, c, c, 0.6, 0, -0.9, 1.4);
    }
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, v = 4 + Math.random() * 9;
      this.emit(x, y + 0.3, z, Math.cos(a) * v, 5 + Math.random() * 9, Math.sin(a) * v, 0.9 + Math.random() * 0.6, 0.22, 0.1, 0.2, 0.16, 0.1, 1, 0, 14, 0.3);
    }
  }

  smoke(x, y, z, size, alpha = 0.4) {
    const c = 0.12 + Math.random() * 0.1;
    this.emit(x, y, z, (Math.random() - 0.5) * 0.8, 1.2 + Math.random(), (Math.random() - 0.5) * 0.8, 1.4 + Math.random(), size, size * 3, c, c, c, alpha, 0, -0.5, 0.8);
  }

  /** Flare salvo: bright decoys ejected sideways and down from an aircraft. */
  flares(x, y, z, vx, vy, vz) {
    for (let i = 0; i < 8; i++) {
      const side = i & 1 ? 1 : -1, a = Math.random() * 0.8;
      this.emit(x, y, z, vx * 0.6 + side * (6 + Math.random() * 5) * Math.cos(a), vy * 0.6 - 2 - Math.random() * 3, vz * 0.6 + side * (6 + Math.random() * 5) * Math.sin(a),
        1.6 + Math.random() * 0.6, 0.7, 0.35, 7, 5.5, 2.4, 1, 1, 6, 0.6);
      this.emit(x, y, z, vx * 0.5 + side * 4, vy * 0.5, vz * 0.5, 2.2, 0.6, 2.4, 0.7, 0.7, 0.7, 0.3, 0, -0.3, 1.2);
    }
  }

  trail(x, y, z) {
    this.emit(x, y, z, 0, 0.3, 0, 0.7, 0.3, 1.1, 0.75, 0.75, 0.75, 0.35, 0, 0, 1);
  }

  /** Spawns a tracer streak from origin along dir for `dist` metres. */
  tracer(ox, oy, oz, dx, dy, dz, dist) {
    if (dist < 4) return;
    const t = this.tracers.acquire(true);
    if (!t) return;
    t.ox = ox; t.oy = oy; t.oz = oz; t.dx = dx; t.dy = dy; t.dz = dz; t.dist = dist; t.t = 1.5;
  }

  /** @param {number} dt */
  update(dt) {
    const cam = this.render.camera;
    this.material.uniforms.uScale.value =
      (this.render.renderer.domElement.height * 0.5) / Math.tan((cam.fov * Math.PI) / 360);
    const { pos, vel, life, maxLife, data } = this;
    for (let i = 0; i < this.capacity; i++) {
      if (life[i] <= 0) continue;
      const l = (life[i] -= dt);
      const i3 = i * 3, i4 = i * 4;
      if (l <= 0) { data[i4] = 0; data[i4 + 1] = 0; continue; }
      const f = Math.max(0, 1 - this.drag[i] * dt);
      vel[i3] *= f; vel[i3 + 1] = vel[i3 + 1] * f - this.grav[i] * dt; vel[i3 + 2] *= f;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      const k = l / maxLife[i];
      data[i4] = this.size1[i] + (this.size0[i] - this.size1[i]) * k;
      data[i4 + 1] = this.alpha[i] * Math.min(1, k * 2.2);
    }
    this._aPos.needsUpdate = true;
    this._aData.needsUpdate = true;
    this._aCol.needsUpdate = true;

    const pool = this.tracers;
    for (let i = pool.active - 1; i >= 0; i--) {
      const t = pool.items[i];
      t.t += 480 * dt;
      const len = Math.min(11, t.dist * 0.5);
      if (t.t - len > t.dist) {
        this.tracerMesh.setMatrixAt(t.slot, _zero);
        pool.releaseAt(i);
        continue;
      }
      const head = Math.min(t.t, t.dist), tail = Math.max(0, t.t - len);
      const mid = (head + tail) * 0.5;
      _d.set(t.dx, t.dy, t.dz);
      _m.compose(_p.set(t.ox + t.dx * mid, t.oy + t.dy * mid, t.oz + t.dz * mid), _q.setFromUnitVectors(Z, _d), _s.set(0.045, 0.045, Math.max(0.1, head - tail)));
      this.tracerMesh.setMatrixAt(t.slot, _m);
    }
    this.tracerMesh.instanceMatrix.needsUpdate = true;
  }
}
