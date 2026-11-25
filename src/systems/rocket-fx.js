import * as THREE from 'three';

/**
 * Rocket and missile exhaust: billowing smoke trails, motor flames, launch backblast and a glow light.
 *
 * Smoke puffs are camera-facing quads (instanced; no point-size cap) shaded with animated fractal noise, so each
 * puff has a ragged, turbulent edge, a lit top and a shaded underside. A puff is born small, dense and warm
 * (lit by the motor), then expands quickly and keeps slowly spreading while it thins out, rises a little and
 * drifts with the wind; it fades over 7–14 s as it disperses rather than vanishing at once. Motor flames are short-
 * lived additive puffs packed along the path flown each frame (no gaps at 150 m/s), and the brightest burning rocket
 * near the camera carries a flickering point light. Fire and smoke share one draw call (premultiplied blending).
 */

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iData;   // size, alpha, seed, fire (0 smoke / 1 flame)
attribute vec4 iCol;    // rgb, age (0..1)
varying vec2 vUv;
varying vec4 vData;
varying vec4 vCol;
varying float vFog;
uniform float uFogDensity;
uniform float uMinPx;
void main() {
  vUv = position.xy;
  vData = iData; vCol = iCol;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  // Far away a puff never shrinks below a few pixels (the trail still reads at the far side of the map);
  // what it gains in size it loses in density.
  float sz = max(iData.x, -mv.z * uMinPx * (1.0 - iData.w));
  vData.y *= pow(iData.x / max(sz, 1e-4), 0.3);
  float a = iData.z * 6.2831 + iCol.w * (iData.z - 0.5) * 2.4;
  float c = cos(a), s = sin(a);
  vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
  mv.xy += q * sz;
  float d = -mv.z * uFogDensity;
  vFog = 1.0 - exp(-d * d);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vData;
varying vec4 vCol;
varying float vFog;
uniform float uTime;
uniform float uLight;
uniform vec3 uFogColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
void main() {
  vec2 p = vUv * 2.0;
  float r = length(p);
  if (r > 1.0) discard;
  float age = vCol.w, seed = vData.z;
  if (vData.w > 0.5) {
    // flame: hot white core, orange rim, flickering
    float core = pow(max(0.0, 1.0 - r), 1.6);
    float fl = 0.75 + 0.25 * noise(p * 3.0 + vec2(seed * 40.0, uTime * 18.0));
    float a = core * vData.y * fl;
    vec3 col = mix(vCol.rgb, vec3(1.0, 0.95, 0.8) * 3.0, smoothstep(0.35, 0.95, core));
    gl_FragColor = vec4(col * a, 0.0);
  } else {
    // smoke: turbulent, billowing edge that gets more ragged as the puff ages and spreads
    vec2 o = vec2(seed * 31.7, seed * 17.3 + uTime * 0.04);
    float n = fbm(p * (1.35 + age * 0.6) + o);
    float n2 = fbm(p * 3.1 - o * 0.7 + vec2(uTime * 0.07, 0.0));
    float edge = r + (n - 0.5) * (0.75 + age * 0.55) + (n2 - 0.5) * 0.25;
    float dens = smoothstep(1.0, 0.25 + age * 0.15, edge);
    dens *= 0.72 + 0.56 * n;
    float a = dens * vData.y;
    if (a < 0.003) discard;
    // lit top, shaded underside, self-shadowed folds
    float lit = clamp(0.5 + p.y * 0.42 + (n2 - 0.5) * 0.5, 0.0, 1.0);
    vec3 col = vCol.rgb * mix(0.52, 1.08, lit) * uLight;
    col = mix(col, uFogColor, vFog * 0.85);
    gl_FragColor = vec4(col * a, a);
  }
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const BURN = { grad: 2.4, mlrs: 3.0, smerch: 3.4, tbm: 6.0 };
const _bp = new THREE.Vector3(), _bq = new THREE.Quaternion(), _bs = new THREE.Vector3(), _bm = new THREE.Matrix4(), _bc = new THREE.Color();
const _Z = new THREE.Vector3(0, 0, 1), _bt = new THREE.Vector3(), _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bn = new THREE.Vector3();

/** Round glow: hot white centre, soft orange falloff. */
function dotTexture() {
  const S = 64, c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d'), h = S / 2, gr = x.createRadialGradient(h, h, 0, h, h, h);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,235,200,0.9)');
  gr.addColorStop(0.5, 'rgba(255,160,80,0.3)'); gr.addColorStop(1, 'rgba(255,120,50,0)');
  x.fillStyle = gr; x.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft elongated glow (white centre line fading out to the sides and ends). */
function glowTexture() {
  const S = 64, c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d'), img = x.createImageData(S, S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const u = (i + 0.5) / S * 2 - 1, v = (j + 0.5) / S * 2 - 1;
    const a = Math.exp(-u * u * 7) * Math.pow(Math.max(0, 1 - v * v), 1.5);
    const k = (j * S + i) * 4;
    img.data[k] = 255; img.data[k + 1] = 255; img.data[k + 2] = 255; img.data[k + 3] = Math.round(a * 255);
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Four-point star with a soft core (the long spikes vertical), as a lens flare. */
function starTexture() {
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d'), h = S / 2;
  const core = x.createRadialGradient(h, h, 0, h, h, h * 0.5);
  core.addColorStop(0, 'rgba(255,255,255,1)'); core.addColorStop(0.18, 'rgba(255,240,210,0.9)');
  core.addColorStop(0.5, 'rgba(255,170,90,0.25)'); core.addColorStop(1, 'rgba(255,140,60,0)');
  x.fillStyle = core; x.fillRect(0, 0, S, S);
  x.globalCompositeOperation = 'lighter';
  const spike = (vertical, reach, width) => {
    const gr = vertical ? x.createLinearGradient(h, h - reach, h, h + reach) : x.createLinearGradient(h - reach, h, h + reach, h);
    gr.addColorStop(0, 'rgba(255,200,140,0)'); gr.addColorStop(0.5, 'rgba(255,250,235,1)'); gr.addColorStop(1, 'rgba(255,200,140,0)');
    x.fillStyle = gr;
    x.beginPath();
    if (vertical) { x.moveTo(h, h - reach); x.lineTo(h + width, h); x.lineTo(h, h + reach); x.lineTo(h - width, h); }
    else { x.moveTo(h - reach, h); x.lineTo(h, h - width); x.lineTo(h + reach, h); x.lineTo(h, h + width); }
    x.closePath(); x.fill();
  };
  spike(true, h * 0.98, S * 0.035);
  spike(false, h * 0.7, S * 0.03);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class RocketFX {
  /** @param {import('./renderer.js').RenderSystem} render */
  constructor(render) {
    this.render = render;
    const q = render.quality;
    const n = (this.capacity = q.ssao ? 5200 : q.cascades ? 3200 : 1600);
    this.detail = q.ssao ? 1 : q.cascades ? 0.75 : 0.45;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.data = new Float32Array(n * 4);
    this.col = new Float32Array(n * 4);
    this.base = new Float32Array(n * 3); // final smoke colour
    this.t = new Float32Array(n);
    this.life = new Float32Array(n);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.grow = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.buoy = new Float32Array(n);
    this.fire = new Uint8Array(n);
    this._next = 0;
    this._alive = 0;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this._aPos = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this._aData = new THREE.InstancedBufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage);
    this._aCol = new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this._aPos);
    geo.setAttribute('iData', this._aData);
    geo.setAttribute('iCol', this._aCol);
    geo.instanceCount = n;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uMinPx: { value: 0.008 }, uTime: { value: 0 }, uLight: { value: 1 }, uFogColor: { value: new THREE.Color(0.7, 0.75, 0.8) }, uFogDensity: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    render.scene.add(this.mesh);

    // Rocket glow: one light shared by the nearest burning motor (or a launch flash).
    this.light = q.cascades ? new THREE.PointLight(0xffa050, 0, 60, 1.6) : null;
    if (this.light) render.scene.add(this.light);
    this._glow = { d: 1e18, x: 0, y: 0, z: 0, k: 0 };
    this._flash = 0;
    this.wind = new THREE.Vector3(1.4, 0, 0.7);
    this.time = 0;

    // Rocket bodies in flight are drawn as light, not hardware: a glowing rod (the motor-lit rocket, seen up
    // close) with a small star flare at the nozzle that keeps a fixed on-screen size, so a distant rocket reads
    // as a bright twinkle at the head of its smoke. Both scale with the rocket (S-8 small, TBM big and dramatic).
    const N = (this._bodyCap = 128);
    const prof = [[0, 0], [0.62, 0], [0.92, 0.1], [1, 0.3], [1, 0.74], [0.86, 0.87], [0.52, 0.96], [0, 1]].map(([x, y]) => new THREE.Vector2(x, y));
    const rodGeo = new THREE.LatheGeometry(prof, 10).rotateX(Math.PI / 2);
    const rodMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.4, 2.3, 1.15), toneMapped: false, fog: false, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false });
    this._rods = new THREE.InstancedMesh(rodGeo, rodMat, N);
    const flareMat = new THREE.MeshBasicMaterial({ map: starTexture(), color: new THREE.Color(2.6, 2.0, 1.35), toneMapped: false, fog: false,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this._flares = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), flareMat, N);
    const glowMat = new THREE.MeshBasicMaterial({ map: glowTexture(), color: new THREE.Color(2.2, 1.25, 0.55), toneMapped: false, fog: false,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this._glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMat, N);
    const dotMat = new THREE.MeshBasicMaterial({ map: dotTexture(), color: new THREE.Color(3.0, 2.1, 1.2), toneMapped: false, fog: false,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this._dots = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), dotMat, N);
    this._nDots = 0;
    for (const m of [this._rods, this._flares, this._glows, this._dots]) {
      m.frustumCulled = false; m.count = 0; m.renderOrder = 6;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color(1, 1, 1));
      render.scene.add(m);
    }
    this._nBodies = 0;
    this._pxScale = 500;
  }

  /**
   * Gun-artillery shell in flight: a small glowing dot. Leaving the barrel it is hot and trails dense smoke; within a
   * couple of seconds the glow fades to a faint ember and the smoke thins to a wispy line the wind carries off.
   * @param {any} p projectile @param {number} px @param {number} py @param {number} pz previous position
   */
  shell(p, px, py, pz) {
    const g = p.def.size || 1, age = p.age, cam = this.render.camera;
    const heat = 0.12 + 0.88 * Math.exp(-age / 0.9);
    if (this._nDots < this._bodyCap) {
      const i = this._nDots++;
      const dist = p.pos.distanceTo(cam.position);
      const w = Math.max(0.45 * g * (0.6 + 0.4 * heat), dist * 1.4 / this._pxScale);
      _bm.compose(p.pos, cam.quaternion, _bs.set(w, w, 1));
      this._dots.setMatrixAt(i, _bm);
      _bc.setScalar(heat * (0.9 + Math.random() * 0.2));
      this._dots.setColorAt(i, _bc);
    }
    const dx = p.pos.x - px, dy = p.pos.y - py, dz = p.pos.z - pz, len = Math.hypot(dx, dy, dz) || 1e-3;
    const dense = Math.exp(-age / 1.4); // 1 at the muzzle, → 0
    const spacing = (1.2 + (1 - dense) * 5) / this.detail;
    p.fxAcc = (p.fxAcc || 0) + len;
    let n = 0;
    while (p.fxAcc > spacing && n < 16) {
      p.fxAcc -= spacing; n++;
      const f = p.fxAcc / len, x = p.pos.x - dx * f, y = p.pos.y - dy * f, z = p.pos.z - dz * f;
      const grey = 0.78 + Math.random() * 0.12, sp = 0.6 + Math.random() * 0.8;
      const a0 = 0.05 + 0.4 * dense, s0 = (0.25 + 0.5 * dense) * g * 0.6, s1 = (1.2 + 2.6 * dense) * g * 0.6;
      this._emit(x, y, z, (Math.random() - 0.5) * sp, (Math.random() - 0.5) * sp + 0.2, (Math.random() - 0.5) * sp,
        (3 + 4 * dense) + Math.random() * 3, s0, s1, 0.4 + dense * 0.5, a0, grey, grey * 0.98, grey * 0.95, 0, 1.2, 0.1);
    }
  }

  /**
   * Draws one rocket / missile in flight (call every frame per projectile with a smoke trail).
   * @param {any} p projectile @param {THREE.Vector3} d unit flight direction
   */
  body(p, d) {
    if (this._nBodies >= this._bodyCap) return;
    const def = p.def, art = !!def.artillery, g = def.size || 1;
    const burn = BURN[def.id] ?? (art ? 3 : 1.6);
    // Guided and short-range rockets burn for their whole flight; artillery rockets coast dimmer after burnout.
    const hot = !art || p.age < burn ? 1 : 0.5;
    const flick = 0.85 + Math.random() * 0.3;
    const i = this._nBodies++, cam = this.render.camera;
    const dist = p.pos.distanceTo(cam.position), pxW = dist / this._pxScale;
    // Never thinner than about a pixel; far away it shrinks to a short glint and the flare takes over.
    const r = Math.max(0.045 * Math.pow(g, 1.35), pxW * 0.4), len = Math.max(1.5 * Math.pow(g, 1.6), r * 12);
    // Rod: from the nozzle forward along the flight path.
    _bp.copy(p.pos).addScaledVector(d, -len * 0.5);
    _bm.compose(_bp, _bq.setFromUnitVectors(_Z, d), _bs.set(r, r, len));
    this._rods.setMatrixAt(i, _bm);
    _bc.setScalar(hot * flick);
    this._rods.setColorAt(i, _bc);
    // Flare at the nozzle: a fixed number of pixels across far away (bigger rockets, bigger flare), never
    // smaller than the rocket up close.
    // Glow: a soft streak around the rod, turned to face the camera about the flight axis.
    _bt.subVectors(cam.position, p.pos);
    _bx.crossVectors(d, _bt).normalize();
    _bn.crossVectors(_bx, d);
    _bm.makeBasis(_bx.multiplyScalar(Math.max(r * 2.6, pxW * 0.9)), _by.copy(d).multiplyScalar(len * 1.6), _bn);
    _bm.setPosition(_bt.copy(p.pos).addScaledVector(d, -len * 0.35));
    this._glows.setMatrixAt(i, _bm);
    _bc.setScalar(hot * flick * 0.45);
    this._glows.setColorAt(i, _bc);
    // Physical size first (it shrinks with distance like the rocket); a floor of a couple of pixels, a little
    // larger for bigger rockets, keeps it from vanishing.
    const px = (1.5 + 0.9 * g) * (hot < 1 ? 0.75 : 1);
    const w = Math.max(len * 0.6, dist * px / this._pxScale);
    _bm.compose(_bp, cam.quaternion, _bs.set(w, w * 1.35, 1));
    this._flares.setMatrixAt(i, _bm);
    _bc.setScalar(hot * (0.8 + Math.random() * 0.4));
    this._flares.setColorAt(i, _bc);
  }

  /** One particle (ring buffer: the oldest is reused when full). */
  _emit(x, y, z, vx, vy, vz, life, s0, s1, grow, a0, r, g, b, fire, drag, buoy) {
    const i = this._next;
    this._next = (i + 1) % this.capacity;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.base[i3] = r; this.base[i3 + 1] = g; this.base[i3 + 2] = b;
    this.t[i] = 0; this.life[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.grow[i] = grow; this.a0[i] = a0;
    this.fire[i] = fire; this.drag[i] = drag; this.buoy[i] = buoy;
    this.data[i * 4 + 2] = Math.random();
    this.data[i * 4 + 3] = fire;
  }

  /**
   * Exhaust along the path a projectile flew this frame (from (px,py,pz) to its position).
   * @param {any} p projectile @param {number} px @param {number} py @param {number} pz
   */
  trail(p, px, py, pz) {
    const def = p.def, art = !!def.artillery;
    const sc = (def.size || 1) * (art ? 1 : 0.55);
    const burn = BURN[def.id] ?? (art ? 3 : 1.6);
    const burning = p.age < burn;
    const tail = !burning && p.age < burn + (art ? 1.2 : 0.6);
    if (!burning && !tail) return;
    const dx = p.pos.x - px, dy = p.pos.y - py, dz = p.pos.z - pz, len = Math.hypot(dx, dy, dz) || 1e-3;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    // nozzle sits behind the projectile
    const nx = p.pos.x - ux * 0.6 * sc, ny = p.pos.y - uy * 0.6 * sc, nz = p.pos.z - uz * 0.6 * sc;
    if (burning) {
      // flames packed along the step: a continuous jet
      const nf = Math.min(10, 2 + Math.ceil(len / 3)) * (this.detail > 0.5 ? 1 : 0.5);
      for (let k = 0; k < nf; k++) {
        const f = k / nf, j = (Math.random() - 0.5) * 0.15 * sc;
        this._emit(nx - dx * f + j, ny - dy * f + j, nz - dz * f + j, -ux * 20, -uy * 20, -uz * 20, 0.05 + Math.random() * 0.05,
          (0.9 + Math.random() * 0.5) * sc, 0.25 * sc, 6, 1, 3.2, 1.7, 0.6, 1, 6, 0);
      }
      const d = this._camD(nx, ny, nz);
      if (d < this._glow.d) { this._glow.d = d; this._glow.x = nx; this._glow.y = ny; this._glow.z = nz; this._glow.k = Math.min(1.6, sc); }
    }
    // smoke puffs spaced along the path (denser near the launcher where the rocket is slow)
    const spacing = (burning ? 1.6 : 4.5) * sc / this.detail;
    p.fxAcc = (p.fxAcc || 0) + len;
    let emitted = 0;
    while (p.fxAcc > spacing && emitted < 24) {
      p.fxAcc -= spacing; emitted++;
      const f = p.fxAcc / len;
      const x = nx - dx * f, y = ny - dy * f, z = nz - dz * f;
      const grey = 0.72 + Math.random() * 0.16;
      const life = (art ? 8 : 4.5) + Math.random() * (art ? 6 : 3);
      const a0 = (burning ? 0.62 : 0.22) * (art ? 1 : 0.8);
      const sp = 1.2 + Math.random() * 1.4;
      this._emit(x, y, z, -ux * 6 + (Math.random() - 0.5) * sp, -uy * 6 + (Math.random() - 0.5) * sp, -uz * 6 + (Math.random() - 0.5) * sp,
        life, (0.7 + Math.random() * 0.4) * sc, (4.2 + Math.random() * 3) * sc, 0.55 + Math.random() * 0.4, a0, grey, grey * 0.98, grey * 0.95, 0, 1.6, 0.18 + Math.random() * 0.12);
    }
  }

  /**
   * Launch backblast: flash, a dense cloud rolling out behind and to the sides of the launcher, ground dust.
   * @param {THREE.Vector3} o launch point @param {THREE.Vector3} d launch direction @param {number} size
   * @param {number} groundY ground height under the launcher
   */
  launch(o, d, size, groundY) {
    const s = Math.max(0.6, size);
    for (let k = 0; k < 4; k++) this._emit(o.x - d.x * k * 0.6, o.y - d.y * k * 0.6, o.z - d.z * k * 0.6, -d.x * 8, -d.y * 8, -d.z * 8, 0.12 + Math.random() * 0.06, 2.2 * s, 3.2 * s, 6, 1, 3.4, 2.0, 0.7, 1, 4, 0);
    const n = Math.round(14 * this.detail * s);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, v = 3 + Math.random() * 7;
      const bx = -d.x * (4 + Math.random() * 8), bz = -d.z * (4 + Math.random() * 8);
      const g = 0.66 + Math.random() * 0.14;
      this._emit(o.x - d.x * 1.5, Math.max(groundY + 0.8, o.y - 0.5), o.z - d.z * 1.5, Math.cos(a) * v + bx, 0.5 + Math.random() * 2.5, Math.sin(a) * v + bz,
        7 + Math.random() * 6, 1.6 * s, (6 + Math.random() * 4) * s, 0.7, 0.42, g, g * 0.97, g * 0.92, 0, 1.4, 0.12);
    }
    for (let k = 0; k < Math.round(8 * this.detail); k++) { // ground dust
      const a = Math.random() * Math.PI * 2, v = 5 + Math.random() * 8;
      this._emit(o.x + Math.cos(a) * 1.5, groundY + 0.4, o.z + Math.sin(a) * 1.5, Math.cos(a) * v, 0.6, Math.sin(a) * v,
        4 + Math.random() * 3, 1.2 * s, 5 * s, 0.9, 0.3, 0.55, 0.48, 0.36, 0, 2.2, 0.05);
    }
    this._flash = 0.25;
    this._glow.d = -1; this._glow.x = o.x; this._glow.y = o.y; this._glow.z = o.z; this._glow.k = 2.2 * s;
  }

  _camD(x, y, z) { const c = this.render.camera.position; return (x - c.x) ** 2 + (y - c.y) ** 2 + (z - c.z) ** 2; }

  /** @param {number} dt @param {{dark:number, windK?:number}} env */
  update(dt, env) {
    this.time += dt;
    for (const m of [this._rods, this._flares, this._glows, this._dots]) {
      m.count = m === this._dots ? this._nDots : this._nBodies;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this._nBodies = 0; this._nDots = 0;
    const cam = this.render.camera;
    this._pxScale = this.render.renderer.domElement.height * 0.5 / Math.tan((cam.fov * Math.PI) / 360);
    this.material.uniforms.uMinPx.value = 2.5 / this._pxScale;
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    u.uLight.value = Math.max(0.14, 1 - ((env && env.dark) || 0) * 0.86);
    const fog = this.render.scene.fog;
    if (fog) { u.uFogColor.value.copy(fog.color); u.uFogDensity.value = /** @type {any} */ (fog).density || 0; }
    const wk = env && env.windK !== undefined ? env.windK : 1;
    const wx = this.wind.x * wk, wz = this.wind.z * wk;
    const { pos, vel, data, col, base, t, life } = this;
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      const i4 = i * 4;
      if (life[i] <= 0) continue;
      const age = (t[i] += dt);
      if (age >= life[i]) { life[i] = 0; data[i4] = 0; data[i4 + 1] = 0; continue; }
      alive++;
      const i3 = i * 3, k = age / life[i];
      const f = Math.max(0, 1 - this.drag[i] * dt);
      // the wind takes over as the puff slows down; it rises a little (warm exhaust) and the rise dies away
      const w = Math.min(1, age * 0.35);
      vel[i3] = vel[i3] * f + (wx - vel[i3]) * w * dt * 0.5;
      vel[i3 + 1] = vel[i3 + 1] * f + this.buoy[i] * (1 - k) * dt;
      vel[i3 + 2] = vel[i3 + 2] * f + (wz - vel[i3 + 2]) * w * dt * 0.5;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      const s0 = this.s0[i], s1 = this.s1[i];
      if (this.fire[i]) {
        data[i4] = s0 + (s1 - s0) * k;
        data[i4 + 1] = this.a0[i] * (1 - k);
        col[i4] = base[i3]; col[i4 + 1] = base[i3 + 1] * (1 - k * 0.4); col[i4 + 2] = base[i3 + 2] * (1 - k * 0.7);
      } else {
        // fast initial expansion, then slow spreading; thins as it spreads and fades out over its life
        const g = 1 - Math.exp(-age * this.grow[i] * 2.2);
        const size = s0 + (s1 - s0) * (g * 0.8 + k * 0.2);
        data[i4] = size;
        const fadeIn = Math.min(1, age / 0.15);
        const fade = (1 - k) * (1 - k) * (1 - 0.35 * k);
        data[i4 + 1] = this.a0[i] * fadeIn * fade * Math.pow(s0 / size, 0.35);
        // born glowing from the motor, cooling to grey within half a second
        const warm = Math.max(0, 1 - age * 2.2);
        col[i4] = base[i3] + warm * 0.9; col[i4 + 1] = base[i3 + 1] + warm * 0.35; col[i4 + 2] = base[i3 + 2] * (1 - warm * 0.3);
      }
      col[i4 + 3] = k;
    }
    this._alive = alive;
    this.mesh.visible = alive > 0;
    this._aPos.needsUpdate = true; this._aData.needsUpdate = true; this._aCol.needsUpdate = true;

    if (this.light) {
      const gl = this._glow;
      this._flash = Math.max(0, this._flash - dt);
      if (gl.d < 260 * 260) {
        this.light.position.set(gl.x, gl.y, gl.z);
        this.light.intensity = (this._flash > 0 ? 260 : 90) * gl.k * (0.8 + Math.random() * 0.4);
      } else this.light.intensity = 0;
      gl.d = 1e18;
    }
  }
}
