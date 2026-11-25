import * as THREE from 'three';
import { flagBaseY } from '../world/flag-volume.js';
import { HEADLIGHT, AIRLIGHT, BEAM_GEO } from '../entities/vehicle-visual.js';
import { clamp } from '../core/math.js';

/**
 * Time of day and weather.
 *
 * Presets drive the renderer's sun / moon, sky gradient, ambient light, fog
 * and exposure; night switches on the lights of the world (street lamps,
 * floodlights, runway edge lights, tunnel lamps, vehicle headlights,
 * searchlight beams), rain adds falling streaks around the camera, and every
 * condition sets how far soldiers can see (read by the AI's perception).
 *
 * Mobile budget: the glows are two point-sprite draw calls in total; real
 * dynamic lights are a small fixed pool (0 / 2 / 4 by quality tier) that
 * follows the lamps nearest to the camera, kept in the scene at all times so
 * shaders never recompile when the lights come on.
 */

const _v = new THREE.Vector3();
const _c = new THREE.Color();
const C = (r, g, b) => new THREE.Color(r, g, b);
const dirFrom = (elev, az) => new THREE.Vector3(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az));

/** Time-of-day presets (colours are linear). */
export const TIMES = {
  morning: {
    label: 'MORNING', sun: dirFrom(0.26, -2.1), sunColor: C(1.0, 0.78, 0.55), sunI: 2.0, skySun: C(1.0, 0.72, 0.45),
    zenith: C(0.2, 0.36, 0.64), horizon: C(0.86, 0.72, 0.6), hemiSky: C(0.78, 0.82, 0.92), hemiGround: C(0.42, 0.36, 0.26), hemiI: 1.0,
    fog: C(0.8, 0.74, 0.66), exposure: 0.95, dark: 0.15,
  },
  midday: {
    label: 'MIDDAY', sun: new THREE.Vector3(0.45, 0.72, 0.53).normalize(), sunColor: C(1.0, 0.945, 0.84), sunI: 2.6, skySun: C(1.0, 0.86, 0.62),
    zenith: C(0.16, 0.36, 0.72), horizon: C(0.62, 0.76, 0.88), hemiSky: C(0.81, 0.89, 1.0), hemiGround: C(0.42, 0.38, 0.28), hemiI: 1.15,
    fog: C(0.62, 0.76, 0.88), exposure: 0.92, dark: 0,
  },
  evening: {
    label: 'EVENING', sun: dirFrom(0.13, 2.2), sunColor: C(1.0, 0.55, 0.3), sunI: 1.7, skySun: C(1.0, 0.5, 0.25),
    zenith: C(0.12, 0.16, 0.36), horizon: C(0.92, 0.5, 0.32), hemiSky: C(0.6, 0.55, 0.62), hemiGround: C(0.3, 0.24, 0.18), hemiI: 0.85,
    fog: C(0.62, 0.42, 0.36), exposure: 1.0, dark: 0.55,
  },
  night: {
    label: 'NIGHT', sun: dirFrom(0.75, 0.6), sunColor: C(0.55, 0.66, 0.95), sunI: 0.38, skySun: C(0.35, 0.4, 0.52),
    zenith: C(0.008, 0.014, 0.035), horizon: C(0.04, 0.06, 0.1), hemiSky: C(0.3, 0.38, 0.6), hemiGround: C(0.08, 0.08, 0.1), hemiI: 0.42,
    fog: C(0.03, 0.045, 0.08), exposure: 1.25, dark: 1,
  },
};

/** Blend of two time-of-day presets (colours / vectors / numbers interpolated). */
export function blendTime(a, b, k, label = '') {
  const o = { label: label || (k < 0.5 ? a.label : b.label) };
  for (const key of Object.keys(a)) {
    const x = a[key], y = b[key];
    if (key === 'label') continue;
    if (x instanceof THREE.Color) o[key] = x.clone().lerp(y, k);
    else if (x instanceof THREE.Vector3) o[key] = x.clone().lerp(y, k).normalize();
    else o[key] = x + (y - x) * k;
  }
  return o;
}
/** Blend of two weather presets. */
export function blendWeather(a, b, k, label = '') {
  const o = { label: label || (k < 0.5 ? a.label : b.label) };
  for (const key of Object.keys(a)) if (key !== 'label') o[key] = a[key] + (b[key] - a[key]) * k;
  return o;
}
TIMES.midday.label = 'NOON';
TIMES.evening.label = 'SUNSET';
// Seven times of day (EnvironmentState.TimeOfDay): the four base presets plus blends between them.
Object.assign(TIMES, {
  sunrise: blendTime(TIMES.night, TIMES.morning, 0.68, 'SUNRISE'),
  dusk: blendTime(TIMES.evening, TIMES.night, 0.55, 'DUSK'),
  midnight: { ...blendTime(TIMES.night, TIMES.night, 0, 'MIDNIGHT'), sunI: 0.22, hemiI: 0.3, exposure: 1.35, zenith: C(0.004, 0.007, 0.02), horizon: C(0.02, 0.03, 0.06), fog: C(0.015, 0.022, 0.04) },
});
const ORDERED_TIMES = ['sunrise', 'morning', 'midday', 'evening', 'dusk', 'night', 'midnight'];
for (const k of ORDERED_TIMES) { const v = TIMES[k]; delete TIMES[k]; TIMES[k] = v; }

/** Weather presets: sun / sky dimming, fog distances (fraction of view distance), rain (intensity), sight. */
export const WEATHERS = {
  clear: { label: 'CLEAR', sunMul: 1, hemiMul: 1, grey: 0, fogNear: 0.62, fogFar: 1.0, rain: 0, sight: 1 },
  overcast: { label: 'OVERCAST', sunMul: 0.3, hemiMul: 1.12, grey: 0.65, fogNear: 0.42, fogFar: 0.95, rain: 0, sight: 0.95 },
  light_rain: { label: 'LIGHT RAIN', sunMul: 0.2, hemiMul: 0.97, grey: 0.8, fogNear: 0.18, fogFar: 0.7, rain: 0.7, sight: 0.78 },
  storm: { label: 'HEAVY STORM', sunMul: 0.07, hemiMul: 0.8, grey: 0.95, fogNear: 0.05, fogFar: 0.38, rain: 1.6, sight: 0.52 },
  coastal_fog: { label: 'COASTAL FOG', sunMul: 0.4, hemiMul: 1.05, grey: 0.9, fogNear: 0.02, fogFar: 0.3, rain: 0, sight: 0.42 },
};
/** Older saved settings / URLs. */
const WEATHER_ALIAS = { rain: 'light_rain', fog: 'coastal_fog' };
export const TIME_KEYS = /** @type {(keyof typeof TIMES)[]} */ (Object.keys(TIMES));
export const WEATHER_KEYS = /** @type {(keyof typeof WEATHERS)[]} */ (Object.keys(WEATHERS));

/** Glow colours per light kind. */
const KIND_COLOR = { interior: [1.0, 0.93, 0.8], street: [1.0, 0.74, 0.42], flood: [0.92, 0.95, 1.0], runway: [0.55, 0.75, 1.0], tunnel: [1.0, 0.8, 0.5], window: [1.0, 0.82, 0.5], beacon: [1.0, 0.2, 0.15] };
const KIND_SIZE = { interior: 0.9, street: 2.2, flood: 3.4, runway: 1.0, tunnel: 1.4, window: 1.3, beacon: 2.6 };

const GLOW_VERT = /* glsl */ `
attribute vec4 glow; // rgb colour, size
uniform float uScale;
uniform float uOn;
varying vec3 vCol;
void main() {
  vCol = glow.rgb * uOn;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(glow.a * uScale / max(1.0, -mv.z), 0.0, 96.0) * step(0.001, uOn * glow.a);
  gl_Position = projectionMatrix * mv;
}`;
const GLOW_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  float a = exp(-r * 3.2) * (1.0 - r);
  if (a <= 0.003) discard;
  gl_FragColor = vec4(vCol * a, a);
}`;

const RAIN_VERT = /* glsl */ `
attribute vec3 seed;   // xz offset in the box, phase
attribute float tip;   // 0 bottom, 1 top of the streak
uniform vec3 uCam;
uniform float uTime;
uniform float uBox;
uniform float uSpeed;
void main() {
  vec3 p;
  p.x = uCam.x + (fract(seed.x + uCam.x / uBox) - 0.5) * uBox;
  p.z = uCam.z + (fract(seed.y + uCam.z / uBox) - 0.5) * uBox;
  p.y = uCam.y + uBox * 0.5 - fract(seed.z + uTime * uSpeed) * uBox;
  p += vec3(0.25, 1.0, 0.1) * tip * 0.9;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const RAIN_FRAG = /* glsl */ `
uniform float uAlpha;
void main() { gl_FragColor = vec4(0.62, 0.68, 0.76, uAlpha); }`;

export class AtmosphereSystem {
  /** @param {import('./game.js').Game} game */
  constructor(game) {
    this.game = game;
    const render = game.render, q = render.quality;
    this.time = /** @type {keyof typeof TIMES} */ ('midday');
    this.weather = /** @type {keyof typeof WEATHERS} */ ('clear');
    /** 0 day … 1 night: how much the artificial lights matter. */
    this.dark = 0;
    /** Sight multipliers read by the AI: soldiers / vehicles / sensor range (eyes) / thermal range. */
    this.vis = 1; this.vehVis = 1; this.range = 1; this.thermalRange = 1;

    // Static light glows (street, flood, runway, tunnel lamps).
    const lights = game.map.lights || [];
    this.lights = lights;
    const n = Math.max(1, lights.length);
    const pos = new Float32Array(n * 3), glow = new Float32Array(n * 4);
    lights.forEach((l, i) => {
      pos[i * 3] = l.x; pos[i * 3 + 1] = l.y; pos[i * 3 + 2] = l.z;
      const c = KIND_COLOR[l.kind] || KIND_COLOR.street;
      glow[i * 4] = c[0] * 2.2; glow[i * 4 + 1] = c[1] * 2.2; glow[i * 4 + 2] = c[2] * 2.2; glow[i * 4 + 3] = KIND_SIZE[l.kind] || 2;
    });
    this._glowSize = glow.filter((_, i) => i % 4 === 3);
    const geo = new THREE.BufferGeometry();
    this._glowPos = new THREE.BufferAttribute(pos, 3);
    geo.setAttribute('position', this._glowPos);
    this._glowAttr = new THREE.BufferAttribute(glow, 4);
    geo.setAttribute('glow', this._glowAttr);
    const mat = () => new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, uniforms: { uScale: { value: 600 }, uOn: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
    });
    this.glowMat = mat();
    this.glows = new THREE.Points(geo, this.glowMat);
    this.glows.frustumCulled = false;
    this.glows.renderOrder = 6;
    render.scene.add(this.glows);

    // Headlights (two per occupied ground vehicle), rebuilt each frame while it is dark.
    const V = game.vehicles.list.length * 7 + 96 + 2;
    this._headPos = new Float32Array(V * 3);
    this._headGlow = new Float32Array(V * 4);
    const hg = new THREE.BufferGeometry();
    this._headPosAttr = new THREE.BufferAttribute(this._headPos, 3).setUsage(THREE.DynamicDrawUsage);
    this._headGlowAttr = new THREE.BufferAttribute(this._headGlow, 4).setUsage(THREE.DynamicDrawUsage);
    hg.setAttribute('position', this._headPosAttr);
    hg.setAttribute('glow', this._headGlowAttr);
    this.headMat = mat();
    this.heads = new THREE.Points(hg, this.headMat);
    this.heads.frustumCulled = false;
    this.heads.renderOrder = 6;
    render.scene.add(this.heads);

    // Searchlight beams: an additive cone on each searchlight's lamp.
    const beamGeo = new THREE.ConeGeometry(7, 70, 14, 1, true);
    beamGeo.translate(0, -35, 0);
    beamGeo.rotateX(-Math.PI / 2);   // apex at the lamp, opening along +z
    this.beamMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1, 0.95, 0.8), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    /** @type {{v: any}[]} */
    this.beams = [];
    // Operated searchlights (BRAVO's towers and the like) use the same volumetric beam, lens glow and real spot
    // light as the vehicle lamps, aimed with the light's mount; they are switched situationally (see _searchOn).
    for (const v of game.vehicles.list) {
      if (v.def.type !== 'searchlight' || !v.visual.mounts[0]) continue;
      const pitch = v.visual.mounts[0].pitch;
      const beams = new THREE.Group();
      const b = new THREE.Mesh(BEAM_GEO, HEADLIGHT.beam);
      b.rotation.x = -0.09; b.scale.set(1.4, 1.4, 2.9); b.position.set(0, 0, 0.45); b.renderOrder = 7; b.frustumCulled = false;
      beams.add(b); beams.visible = false; pitch.add(beams);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.3, 18), HEADLIGHT.lensOff);
      lens.position.set(0, 0, 0.44); pitch.add(lens);
      const anchor = new THREE.Object3D(); anchor.position.set(0, 0, 0.9); pitch.add(anchor);
      const target = new THREE.Object3D(); target.position.set(0, 0, 45); pitch.add(target);
      v.visual.headlights = { lenses: lens, beams, anchor, target, lit: false, reach: 120, far: 1600, search: true, angle: 0.2, lastHp: v.health, doused: 0 };
      this.beams.push({ v });
    }

    // Dynamic light pool (nearest lamps / headlights / beams to the camera).
    const poolSize = q.cascades === 0 ? 0 : q.ssao ? 4 : 2;
    /** @type {THREE.PointLight[]} */
    this.pool = [];
    for (let i = 0; i < poolSize; i++) {
      const l = new THREE.PointLight(0xffc890, 0, 28, 2);
      render.scene.add(l);
      this.pool.push(l);
    }
    this._poolTimer = 0;
    // Headlight spot lights: the nearest lit vehicles throw real light on the ground, walls and other vehicles.
    const spots = q.cascades === 0 ? 0 : q.ssao ? 3 : 2;
    /** @type {{light: THREE.SpotLight, v: any}[]} */
    this.spots = [];
    for (let i = 0; i < spots; i++) {
      const l = new THREE.SpotLight(0xfff0d8, 0, 55, 0.62, 0.65, 1.3);
      render.scene.add(l); render.scene.add(l.target);
      this.spots.push({ light: l, v: null });
    }

    // Rain streaks around the camera.
    const drops = q.ssao ? 2200 : q.cascades ? 1400 : 700;
    const seed = new Float32Array(drops * 2 * 3), tip = new Float32Array(drops * 2), rp = new Float32Array(drops * 2 * 3);
    for (let i = 0; i < drops; i++) {
      const a = Math.random(), b = Math.random(), c = Math.random();
      for (let k = 0; k < 2; k++) { const o = (i * 2 + k) * 3; seed[o] = a; seed[o + 1] = b; seed[o + 2] = c; tip[i * 2 + k] = k; }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rg.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
    rg.setAttribute('tip', new THREE.BufferAttribute(tip, 1));
    this.rainMat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false, fog: false,
      uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uBox: { value: 36 }, uAlpha: { value: 0.35 }, uSpeed: { value: 0.9 } },
    });
    this.rain = new THREE.LineSegments(rg, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.rain.renderOrder = 7;
    render.scene.add(this.rain);

    this._propTimer = 0;
    this.set(this.time, this.weather);
  }

  /** Applies a time of day and a weather preset. */
  set(time, weather) {
    weather = WEATHER_ALIAS[weather] || weather;
    if (TIMES[time]) this.time = time;
    if (WEATHERS[weather]) this.weather = weather;
    this.applyPresets(TIMES[this.time], WEATHERS[this.weather]);
  }

  /** Applies preset objects directly (EnvironmentState passes blends while a change is under way). */
  applyPresets(T, W) {
    const render = this.game.render, vd = render.quality.viewDist;
    this.T = T; this.W = W;
    const grey = W.grey, night = T.dark;
    const greyOf = (c) => { const l = (c.r + c.g + c.b) / 3; return _c.setRGB(l, l, l); };
    const mixGrey = (c, k) => c.clone().lerp(greyOf(c).clone().multiplyScalar(0.9), k);
    // Clear air stays crisp to the middle distance: fog starts no closer than 460 m (blended in smoothly as the
    // weather clears, so a transition never jumps).
    const clearK = clamp((W.fogNear - 0.42) / 0.2, 0, 1);
    const fogNear = vd * W.fogNear + clearK * Math.max(0, 460 - vd * W.fogNear);
    const fogFar = Math.max(vd * W.fogFar, fogNear + 100 * clearK);
    render.setLighting({
      sunDir: T.sun, sunColor: mixGrey(T.sunColor, grey * 0.6), sunIntensity: T.sunI * W.sunMul,
      skySun: T.skySun.clone().multiplyScalar(Math.max(0.04, 1 - grey * 1.05)), zenith: mixGrey(T.zenith, grey), horizon: mixGrey(T.horizon, grey),
      hemiSky: mixGrey(T.hemiSky, grey * 0.5), hemiGround: T.hemiGround, hemiIntensity: T.hemiI * W.hemiMul,
      fog: mixGrey(T.fog, grey * 0.8).multiplyScalar(W.sight < 0.5 && W.rain === 0 ? 1.05 : 1), fogNear, fogFar,
      exposure: T.exposure,
    });
    // Lamps matter in the dark and in murky weather.
    this.dark = clamp(night + (grey > 0.6 ? 0.25 : 0), 0, 1);
    this.glowMat.uniforms.uOn.value = this.dark > 0.2 ? Math.min(1, this.dark * 1.2) : 0;
    this.headMat.uniforms.uOn.value = 0;
    // Headlights on at dusk, night, midnight, in a storm and in fog.
    this.headlightsOn = night > 0.6 || W.rain > 1.2 || W.sight < 0.5;
    // Shafts show more in fog and rain (more to scatter off), a little less on a clear night.
    HEADLIGHT.beam.uniforms.opacity.value = this.headlightsOn ? (0.09 + Math.min(1, night) * 0.09) * (W.sight < 0.5 ? 1.8 : 1) * (W.rain > 0 ? 1.35 : 1) : 0;
    this.glowMat.uniforms.uScale.value = W.sight < 0.8 ? 900 : 600;
    this.beamMat.opacity = this.dark > 0.4 ? 0.05 + this.dark * 0.07 : 0;
    this.rain.visible = W.rain > 0;
    this.rainMat.uniforms.uAlpha.value = (night > 0.5 ? 0.18 : 0.32) * Math.min(1.5, Math.max(0.6, W.rain));
    this.rainMat.uniforms.uSpeed.value = 0.7 + W.rain * 0.35;
    // Sight: darkness hurts the naked eye (thermal sights shrug it off), fog and rain hurt both.
    this.vis = clamp((1 - night * 0.62) * W.sight, 0.2, 1);
    this.vehVis = clamp((1 - night * 0.3) * (0.4 + W.sight * 0.6), 0.3, 1);
    this.range = clamp((1 - night * 0.45) * (0.35 + W.sight * 0.65), 0.3, 1);
    this.thermalRange = clamp(0.5 + W.sight * 0.5, 0.5, 1);
    for (const l of this.pool) l.intensity = 0;
    this._poolTimer = 0;
    if (!this.quiet) this.game.bus.emit('atmosphere', this.time, this.weather);
  }

  /** @param {number} dt @param {THREE.Vector3} cam */
  update(dt, cam) {
    const g = this.game;
    this.rainMat.uniforms.uTime.value = g.time;
    this.rainMat.uniforms.uCam.value.copy(cam);
    const on = this.glowMat.uniforms.uOn.value > 0;
    // Destroyed lamps go dark (checked twice a second).
    if (on && (this._propTimer -= dt) <= 0) {
      this._propTimer = 0.5;
      const props = g.map.props, attr = this._glowAttr;
      let changed = false;
      for (let i = 0; i < this.lights.length; i++) {
        const l = this.lights[i];
        // A rooftop flag's beacon rides its pole: down onto the rubble when the host building collapses.
        if (l.kind === 'beacon' && l.flag >= 0) {
          const f = g.capture.flags[l.flag], y = flagBaseY(f) + (f.base ? 17.8 : 11.2);
          if (Math.abs(this._glowPos.array[i * 3 + 1] - y) > 0.01) { this._glowPos.array[i * 3 + 1] = y; this._glowPos.needsUpdate = true; }
          const want = props && (l.prop < 0 || props[l.prop].alive) ? this._glowSize[i] : 0;
          if (attr.array[i * 4 + 3] !== want) { attr.array[i * 4 + 3] = want; changed = true; }
          continue;
        }
        const alive = (l.prop < 0 || props[l.prop].alive) && (l.building < 0 || l.kind === 'tunnel' || g.map.buildings[l.building].state < 2);
        const want = alive ? this._glowSize[i] : 0;
        if (attr.array[i * 4 + 3] !== want) { attr.array[i * 4 + 3] = want; changed = true; }
      }
      if (changed) attr.needsUpdate = true;
    }
    // Headlights and searchlight beams.
    let n = 0;
    // Headlights: lenses in their housings light up and the beams show while it is dark or murky; positions come
    // from the vehicle's interpolated render transform (the lamps are part of the model).
    const want = this.headlightsOn, cap = this._headPos.length / 3;
    const C = AIRLIGHT.colors;
    for (const v of g.vehicles.list) {
      const vis = v.visual;
      if (!vis) continue;
      // Aircraft position lights / beacons / strobes: a coloured glow on each lit one at night, seen from far off.
      const al = vis.airLights;
      if (al && want && al.steady.visible && n + 7 <= cap && (v.pos.x - cam.x) ** 2 + (v.pos.z - cam.z) ** 2 < 2600 * 2600) {
        const mw = vis.root.matrixWorld;
        const put = (pt, c, k, size) => {
          _v.copy(pt).applyMatrix4(mw);
          const o = n * 3, o4 = n * 4;
          this._headPos[o] = _v.x; this._headPos[o + 1] = _v.y; this._headPos[o + 2] = _v.z;
          this._headGlow[o4] = c.r * k; this._headGlow[o4 + 1] = c.g * k; this._headGlow[o4 + 2] = c.b * k; this._headGlow[o4 + 3] = size;
          n++;
        };
        put(al.pts[0], C.red, 0.4, 0.8); put(al.pts[1], C.green, 0.4, 0.8); put(al.pts[2], C.white, 0.35, 0.7);
        if (al.beacon.visible) { put(al.pts[3], C.red, 0.55, 1.3); put(al.pts[4], C.red, 0.55, 1.3); }
        if (al.strobe.visible) { put(al.pts[0], C.white, 0.7, 1.6); put(al.pts[1], C.white, 0.7, 1.6); }
      }
      const h = vis.headlights;
      if (!h) continue;
      const lit = want && v.alive && v.occupied && !!v.driver && (h.search ? this._searchOn(v, h, g.time) : !h.maxAlt || v.grounded > 0 || v.altitude < h.maxAlt);
      if (lit !== h.lit) { h.lit = lit; h.lenses.material = lit ? HEADLIGHT.lensOn : HEADLIGHT.lensOff; }
      const far = h.far || 450;
      const near = lit && (v.pos.x - cam.x) ** 2 + (v.pos.z - cam.z) ** 2 < far * far;
      h.beams.visible = near;
      if (near && n + 2 <= cap) {
        // a soft glow sprite on each lens (the lamp seen through the haze)
        for (const b of h.beams.children) {
          b.getWorldPosition(_v);
          const o = n * 3, o4 = n * 4;
          this._headPos[o] = _v.x; this._headPos[o + 1] = _v.y; this._headPos[o + 2] = _v.z;
          this._headGlow[o4] = 2.4; this._headGlow[o4 + 1] = 2.2; this._headGlow[o4 + 2] = 1.8; this._headGlow[o4 + 3] = h.maxAlt ? 1.4 : 0.9;
          n++;
        }
      }
    }
    // Flashlight lenses (FlashlightSystem): a small warm-white glow on each lit one.
    const fls = g.flashlights;
    if (fls) for (let i = 0; i < fls.nLens && n < this._headPos.length / 3; i++) {
      const o = n * 3, o4 = n * 4;
      this._headPos[o] = fls.lens[i * 3]; this._headPos[o + 1] = fls.lens[i * 3 + 1]; this._headPos[o + 2] = fls.lens[i * 3 + 2];
      this._headGlow[o4] = 1.6; this._headGlow[o4 + 1] = 1.5; this._headGlow[o4 + 2] = 1.3; this._headGlow[o4 + 3] = 0.55;
      n++;
    }
    this.heads.geometry.setDrawRange(0, n);
    this._headPosAttr.needsUpdate = true; this._headGlowAttr.needsUpdate = true;
    this.headMat.uniforms.uOn.value = n > 0 ? 1 : 0;
    HEADLIGHT.beam.uniforms.uTime.value += dt;
    // Spot lights ride on their vehicles every frame (assigned to the nearest lit ones a few times a second).
    for (const sp of this.spots) {
      const v = sp.v, l = sp.light;
      if (!v || !v.visual.headlights || !v.visual.headlights.lit) { l.intensity = 0; continue; }
      const hl = v.visual.headlights;
      hl.anchor.getWorldPosition(_v);
      l.position.copy(_v);
      hl.target.getWorldPosition(l.target.position);
      l.target.updateMatrixWorld();
      // Aircraft lamps throw much further: longer reach, brightness scaled to keep the same falloff shape.
      const reach = hl.reach || 55;
      l.distance = reach;
      l.angle = hl.angle || (hl.maxAlt ? 0.42 : 0.62);
      l.intensity = 140 * Math.pow(reach / 55, 1.3) * Math.min(1, this.dark * 1.3 + 0.3);
    }
    for (const b of this.beams) if (b.v.visual.headlights.lit) this._reveal(b.v);
    if ((this._poolTimer -= dt) <= 0) { this._poolTimer = 0.4; this._assignPool(cam, 0); this._assignSpots(cam); }
  }

  /**
   * Situational searchlight: on at night only when it has something to do — its operator has a target or saw /
   * heard something in the last 40 s, or it is the light's turn to sweep the approaches (a slow duty cycle, each
   * light on its own rhythm). Hit by fire, the crew douses it for 12 s (a lit lamp is the best target on the
   * field). A player on the light keeps it on.
   */
  _searchOn(v, h, time) {
    if (v.health < h.lastHp - 0.5) h.doused = time + 12;
    h.lastHp = v.health;
    const op = v.seats[0];
    if (!op) return false;
    if (op.isPlayer) return true;
    if (time < h.doused) return false;
    const a = op.ai;
    const alert = !!a && (!!a.target || time - (a.lastSeenTime ?? -1e9) < 40 || (a.heardAt !== undefined && time - a.heardAt < 40));
    const sweep = (time + v.id * 7.3) % 70 < 30;
    return alert || sweep;
  }

  /** Soldiers caught in an operated searchlight's beam are revealed (minimap, AI detection bonus). */
  _reveal(v) {
    const g = this.game;
    const yaw = v.aimYaw[0] ?? v.yaw, pitch = v.aimPitch[0] || 0;
    const dx = Math.sin(yaw) * Math.cos(pitch), dz = Math.cos(yaw) * Math.cos(pitch), dy = Math.sin(pitch);
    for (const s of g.soldiers) {
      if (!s.alive || s.team === v.team) continue;
      const ox = s.pos.x - v.pos.x, oy = s.pos.y + 1 - (v.pos.y + 1.5), oz = s.pos.z - v.pos.z;
      const along = ox * dx + oy * dy + oz * dz;
      if (along < 2 || along > 70) continue;
      const off2 = ox * ox + oy * oy + oz * oz - along * along;
      const r = 1 + along * 0.1;
      if (off2 < r * r) s.spotted = Math.max(s.spotted, 1.2);
    }
  }

  /** Gives the headlight spot lights to the lit vehicles nearest the camera (keeping current holders when close). */
  _assignSpots(cam) {
    if (!this.spots.length) return;
    const cand = [];
    for (const v of this.game.vehicles.list) {
      const h = v.visual && v.visual.headlights;
      if (!h || !h.lit) continue;
      const d = (v.pos.x - cam.x) ** 2 + (v.pos.z - cam.z) ** 2, r = 165 + (h.reach || 55);
      if (d < r * r) cand.push({ v, d });
    }
    cand.sort((a, b) => a.d - b.d);
    const want = cand.slice(0, this.spots.length).map((c) => c.v);
    const free = this.spots.filter((s) => !want.includes(s.v));
    for (const v of want) if (!this.spots.some((s) => s.v === v)) { const s = free.shift(); if (s) s.v = v; }
    for (const s of free) s.v = null;
  }

  /** Points the dynamic light pool at the nearest active lamps / headlights. */
  _assignPool(cam, nHead) {
    const pool = this.pool;
    if (!pool.length) return;
    // By day only the interior fixtures of the building the camera is in or beside light up (they are what
    // makes a room readable once the walls cut off the sun); at night every lamp competes.
    const day = !(this.glowMat.uniforms.uOn.value > 0);
    const props = this.game.map.props;
    const best = [];
    const consider = (x, y, z, kind, i) => {
      if (day && kind !== 'interior') return;
      const d = (x - cam.x) ** 2 + (z - cam.z) ** 2 + (day ? (y - cam.y) ** 2 * 4 : 0);
      if (d > (day ? 26 * 26 : 140 * 140)) return;
      best.push({ d, x, y, z, kind, i });
    };
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      if (l.prop >= 0 && !props[l.prop].alive) continue;
      if (l.kind === 'runway' || l.kind === 'window' || l.kind === 'beacon') continue;
      consider(l.x, l.y - 0.6, l.z, l.kind, i);
    }
    for (let k = 0; k < nHead; k += 2) consider(this._headPos[k * 3], this._headPos[k * 3 + 1] + 0.5, this._headPos[k * 3 + 2], 'head', k);
    best.sort((a, b) => a.d - b.d);
    const strength = day ? 1 : Math.min(1, this.dark * 1.2);
    for (let i = 0; i < pool.length; i++) {
      const l = pool[i], b = best[i];
      if (!b) { l.intensity = 0; continue; }
      l.position.set(b.x, b.y, b.z);
      const c = b.kind === 'head' ? [1, 0.95, 0.85] : KIND_COLOR[b.kind] || KIND_COLOR.street;
      l.color.setRGB(c[0], c[1], c[2]);
      l.distance = b.kind === 'flood' ? 38 : b.kind === 'interior' ? 16 : 26;
      l.intensity = (b.kind === 'flood' ? 60 : b.kind === 'interior' ? (day ? 16 : 24) : 30) * strength;
    }
  }

  serialize() { return { time: this.time, weather: this.weather }; }
  deserialize(d) { if (d) this.set(d.time, d.weather); }
}
