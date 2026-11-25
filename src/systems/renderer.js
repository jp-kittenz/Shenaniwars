import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { QUALITY } from '../core/config.js';
import { clamp } from '../core/math.js';
import { FULLSCREEN_VERT, BRIGHT_FRAG, BLUR_FRAG, COMPOSITE_FRAG } from '../shaders/post.js';
import { SKY_VERT, SKY_FRAG } from '../shaders/sky.js';

const SUN_DIR = new THREE.Vector3(0.45, 0.72, 0.53).normalize(); // direction *toward* the sun
const HORIZON = new THREE.Color(0.62, 0.76, 0.88);
const ZENITH = new THREE.Color(0.16, 0.36, 0.72);

/**
 * Owns the WebGL renderer, scene, camera, lighting (cascaded shadow maps),
 * the custom post chain and the dynamic-resolution governor.
 */
export class RenderSystem {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {'low'|'medium'|'high'} qualityName
   */
  constructor(canvas, qualityName) {
    this.qualityName = qualityName;
    /** @type {import('../core/config.js').QualityTier} */
    this.quality = QUALITY[qualityName];
    const q = this.quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: !q.post, powerPreference: 'high-performance', stencil: false, alpha: false,
    });
    const r = this.renderer;
    r.shadowMap.enabled = q.cascades > 0;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = q.post ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(HORIZON.getHex(), q.viewDist * 0.3, q.viewDist * 0.98);
    this.camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.12, q.viewDist);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.baseFov = 72;

    this.hemi = new THREE.HemisphereLight(0xcfe4ff, 0x6b6248, 1.15);
    this.scene.add(this.hemi);
    /** @type {THREE.DirectionalLight|null} sun without cascaded shadows (low tier) */
    this.sun = null;
    /** @type {CSM|null} */
    this.csm = null;
    if (q.cascades > 0) {
      this.csm = new CSM({
        camera: this.camera, parent: this.scene, cascades: q.cascades, maxFar: q.shadowFar, mode: 'practical',
        shadowMapSize: q.shadowMapSize, lightDirection: SUN_DIR.clone().negate(), lightIntensity: 2.6,
        lightNear: 1, lightFar: 600, lightMargin: 120, shadowBias: -0.00025,
      });
      this.csm.fade = true;
      for (const l of this.csm.lights) { l.color.set(0xfff1d6); l.shadow.normalBias = 0.06; }
    } else {
      const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
      sun.position.copy(SUN_DIR).multiplyScalar(100);
      this.scene.add(sun);
      this.sun = sun;
    }

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 12),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
        uniforms: {
          sunDir: { value: SUN_DIR }, zenith: { value: ZENITH }, horizon: { value: HORIZON },
          sunColor: { value: new THREE.Color(1.0, 0.86, 0.62) },
        },
      }));
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.sky.scale.setScalar(q.viewDist * 0.9);
    this.scene.add(this.sky);

    // Dynamic resolution state.
    // Native resolution, capped at 2x: the resolution governor may shed a little under load but never below 1x.
    this.devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2, q.maxPixelRatio);
    this.resScale = 1;
    this._frameAvg = 16.7;
    this._resTimer = 0;
    this.width = 1; this.height = 1;
    this.damage = 0;

    this._initPost();
    this.resize();
  }

  /**
   * Registers a lit material with the cascaded shadow system. Must be called
   * before the material is first rendered.
   * @template {THREE.Material} T
   * @param {T} material
   * @returns {T}
   */
  setupMaterial = (material) => {
    if (this.csm) this.csm.setupMaterial(material);
    return material;
  };

  _initPost() {
    const q = this.quality;
    this.post = null;
    if (!q.post) return;
    const gl = this.renderer;
    const hdr = gl.extensions.has('EXT_color_buffer_float') || gl.extensions.has('EXT_color_buffer_half_float');
    const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const sceneRT = new THREE.WebGLRenderTarget(4, 4, { type, samples: q.msaa, depthBuffer: true });
    if (q.ssao) {
      sceneRT.depthTexture = new THREE.DepthTexture(4, 4);
      sceneRT.depthTexture.type = THREE.UnsignedIntType;
    }
    const small = () => new THREE.WebGLRenderTarget(4, 4, { type, depthBuffer: false });
    const mat = (frag, uniforms, defines = {}) => new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false, toneMapped: false,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    tri.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    const quad = new THREE.Mesh(tri, undefined);
    quad.frustumCulled = false;
    this.post = {
      sceneRT, bright: small(), blurA: small(), blurB: small(), quad,
      camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
      brightMat: mat(BRIGHT_FRAG, { tScene: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 1.05 } }),
      blurMat: mat(BLUR_FRAG, { tInput: { value: null }, dir: { value: new THREE.Vector2() } }),
      compositeMat: mat(COMPOSITE_FRAG, {
        tScene: { value: sceneRT.texture }, tBloom: { value: null }, tDepth: { value: sceneRT.depthTexture || null },
        texel: { value: new THREE.Vector2() }, near: { value: 0.1 }, far: { value: 100 },
        bloomStrength: { value: 0.55 }, aoStrength: { value: 0.85 }, damage: { value: 0 }, exposure: { value: 0.92 },
      }, q.ssao ? { USE_SSAO: '' } : {}),
    };
  }

  /**
   * Applies a lighting setup (time of day + weather; see AtmosphereSystem):
   * sun / moon direction, colour and strength, sky gradient, ambient
   * hemisphere, fog and exposure.
   * @param {{sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number, skySun: THREE.Color, zenith: THREE.Color,
   *   horizon: THREE.Color, hemiSky: THREE.Color, hemiGround: THREE.Color, hemiIntensity: number, fog: THREE.Color,
   *   fogNear: number, fogFar: number, exposure: number}} L  fogNear / fogFar in metres
   */
  setLighting(L) {
    const u = /** @type {THREE.ShaderMaterial} */ (this.sky.material).uniforms;
    u.sunDir.value.copy(L.sunDir); u.zenith.value.copy(L.zenith); u.horizon.value.copy(L.horizon); u.sunColor.value.copy(L.skySun);
    const fog = /** @type {THREE.Fog} */ (this.scene.fog);
    fog.color.copy(L.fog); fog.near = L.fogNear; fog.far = L.fogFar;
    this.hemi.color.copy(L.hemiSky); this.hemi.groundColor.copy(L.hemiGround); this.hemi.intensity = L.hemiIntensity;
    if (this.csm) {
      this.csm.lightDirection.copy(L.sunDir).negate();
      for (const l of this.csm.lights) { l.color.copy(L.sunColor); l.intensity = L.sunIntensity; }
    } else if (this.sun) {
      this.sun.position.copy(L.sunDir).multiplyScalar(100);
      this.sun.color.copy(L.sunColor); this.sun.intensity = L.sunIntensity;
    }
    if (this.post) this.post.compositeMat.uniforms.exposure.value = L.exposure;
    else this.renderer.toneMappingExposure = L.exposure * 1.08;
  }

  /** Re-reads the canvas size and reallocates targets at the current resolution scale. */
  resize() {
    const canvas = this.renderer.domElement;
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    const pr = this.devicePixelRatio * this.resScale;
    this.width = w; this.height = h;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.csm) this.csm.updateFrustums();
    if (this.post) {
      const pw = Math.max(2, Math.round(w * pr)), ph = Math.max(2, Math.round(h * pr));
      const p = this.post;
      p.sceneRT.setSize(pw, ph);
      p.bright.setSize(pw >> 1, ph >> 1);
      p.blurA.setSize(pw >> 2, ph >> 2);
      p.blurB.setSize(pw >> 2, ph >> 2);
      p.brightMat.uniforms.texel.value.set(1 / pw, 1 / ph);
      p.compositeMat.uniforms.texel.value.set(1 / pw, 1 / ph);
    }
  }

  /** @param {number} fov vertical FOV in degrees */
  setFov(fov) {
    if (Math.abs(this.camera.fov - fov) < 0.05) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    if (this.csm) this.csm.updateFrustums();
  }

  /**
   * Frame-time driven resolution governor: sheds pixels when the device
   * cannot hold ~60 FPS and claws them back when there is headroom.
   */
  _govern(dt) {
    this._frameAvg += (dt * 1000 - this._frameAvg) * 0.05;
    this._resTimer += dt;
    if (this._resTimer < 2) return;
    this._resTimer = 0;
    const q = this.quality;
    const min = Math.max(1, Math.min(q.minPixelRatio, this.devicePixelRatio)) / this.devicePixelRatio, prev = this.resScale;
    if (this._frameAvg > 19.5) this.resScale = clamp(this.resScale - 0.1, Math.min(min, 1), 1);
    else if (this._frameAvg < 15.2) this.resScale = clamp(this.resScale + 0.05, Math.min(min, 1), 1);
    if (this.resScale !== prev) this.resize();
  }

  /** @param {number} dt */
  render(dt) {
    this._govern(dt);
    const r = this.renderer, cam = this.camera;
    r.info.reset();
    this.sky.position.copy(cam.position);
    if (this.csm) {
      this.csm.update();
      // Staggered shadow cascades: the near cascade (where moving shadows are seen) renders every frame, the
      // outer ones every second / third frame. Each map keeps the light matrix it was drawn with, so it stays
      // aligned; this saves about a third of the shadow work.
      const f = this._shadowFrame = (this._shadowFrame || 0) + 1;
      this.csm.lights.forEach((l, i) => { l.shadow.autoUpdate = false; l.shadow.needsUpdate = i === 0 || f % (i + 1) === 0; });
    }
    if (!this.post) {
      r.setRenderTarget(null);
      r.render(this.scene, cam);
      return;
    }
    const p = this.post;
    r.setRenderTarget(p.sceneRT);
    r.render(this.scene, cam);

    const pass = (material, target) => {
      p.quad.material = material;
      r.setRenderTarget(target);
      r.render(p.quad, p.camera);
    };
    p.brightMat.uniforms.tScene.value = p.sceneRT.texture;
    pass(p.brightMat, p.bright);
    const bu = p.blurMat.uniforms;
    bu.tInput.value = p.bright.texture; bu.dir.value.set(1 / p.blurA.width, 0);
    pass(p.blurMat, p.blurA);
    bu.tInput.value = p.blurA.texture; bu.dir.value.set(0, 1 / p.blurB.height);
    pass(p.blurMat, p.blurB);
    const cu = p.compositeMat.uniforms;
    cu.tBloom.value = p.blurB.texture;
    cu.near.value = cam.near; cu.far.value = cam.far;
    cu.damage.value = this.damage;
    pass(p.compositeMat, null);
  }

  dispose() {
    if (this.csm) { this.csm.remove(); this.csm.dispose(); }
    if (this.post) for (const k of ['sceneRT', 'bright', 'blurA', 'blurB']) this.post[k].dispose();
    this.renderer.dispose();
  }
}
