import * as THREE from 'three';
import { HEADLIGHT } from '../entities/vehicle-visual.js';

/**
 * Weapon-mounted flashlights for the player and the bots.
 *
 * Bots use them the way soldiers do (light discipline): on at night while searching, moving up, regrouping,
 * resupplying or treating someone, and switched off the moment there is a fight (a visible enemy, suppressive
 * fire, taking cover, engaging, ambushing). A switch holds for a few seconds (no flicker). A lit flashlight gives
 * its bearer away (it reveals him for a moment to the enemy, the way an operated searchlight reveals soldiers).
 *
 * Rendering: one instanced mesh of volumetric beam cones (the same look as the vehicle headlights: brightness
 * along the light's path through the haze, falling off with distance), a glow sprite on each lens (added to the
 * atmosphere's headlight glows), and one real spot light for the player's own flashlight.
 */

const MAX = 96;
const LEN = 16;
const BEAM_VERT = /* glsl */ `
varying float vAlong;
varying vec3 vN;
varying vec3 vView;
void main() {
  vAlong = clamp(position.z, 0.0, 1.0);
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
  vView = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const BEAM_FRAG = /* glsl */ `
uniform float opacity;
uniform vec3 uColor;
varying float vAlong;
varying vec3 vN;
varying vec3 vView;
void main() {
  float facing = abs(dot(normalize(vN), normalize(vView)));
  float fall = 1.0 / (1.0 + vAlong * vAlong * 12.0) * (1.0 - smoothstep(0.65, 1.0, vAlong));
  float a = opacity * pow(facing, 1.5) * fall * smoothstep(0.0, 0.04, vAlong);
  gl_FragColor = vec4(uColor * a, a);
}`;

/** Actions (see ai/types Action) during which a bot keeps its light on. */
const LIGHT_OK = new Set([0, 1, 8, 9, 10, 12, 14, 15, 16]); // patrol, advance, resupply, board, investigate, screen, regroup, repair, heal

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _d = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

export class FlashlightSystem {
  /** @param {import('./game.js').Game} game */
  constructor(game) {
    this.game = game;
    const geo = new THREE.ConeGeometry(1, 1, 14, 1, true);
    geo.translate(0, -0.5, 0); geo.rotateX(-Math.PI / 2); // apex at the lens, opening along +z, length 1
    this.mat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
      uniforms: { opacity: { value: 0 }, uColor: { value: new THREE.Color(1, 0.95, 0.85) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.count = 0;
    game.render.scene.add(this.mesh);
    // The player's own light: a real spot light (created once with zero intensity, so toggling it never
    // recompiles the scene's materials).
    this.spot = new THREE.SpotLight(0xfff2dc, 0, 48, 0.36, 0.55, 1.4);
    game.render.scene.add(this.spot); game.render.scene.add(this.spot.target);
    this.playerOn = false;
    /** Per soldier: light on, and the time it may next switch. */
    this.on = new Uint8Array(game.soldiers.length + 8);
    this.until = new Float32Array(game.soldiers.length + 8);
    /** Lens positions of the lit lights this frame (for the atmosphere's glow sprites). */
    this.lens = new Float32Array(MAX * 3);
    this.nLens = 0;
    this.stats = { lit: 0 };
  }

  toggle() { this.playerOn = !this.playerOn; return this.playerOn; }

  /** @param {number} dt @param {THREE.Camera} cam */
  update(dt, cam) {
    const g = this.game, atm = g.atmosphere, time = g.time;
    const dark = !!(atm && atm.headlightsOn);
    this.mat.uniforms.opacity.value = HEADLIGHT.beam.uniforms.opacity.value * 0.8;
    const st = g.ai && g.ai.st;
    let n = 0;
    this.nLens = 0;
    const cx = cam.position.x, cz = cam.position.z;
    for (let i = 0; i < g.soldiers.length; i++) {
      const s = g.soldiers[i];
      let want = false;
      if (dark && s.alive && !s.vehicle) {
        if (s.isPlayer) want = this.playerOn;
        else if (s.ai && st) {
          const a = s.ai;
          const calm = !(a.target && a.targetVisible) && (st.suppression ? st.suppression[i] < 0.2 : true);
          want = calm && LIGHT_OK.has(st.action[i]);
        }
      }
      if (!s.isPlayer && (want ? 1 : 0) !== this.on[i]) {
        if (time < this.until[i] && !(this.on[i] && !want && s.ai && s.ai.target && s.ai.targetVisible)) want = !!this.on[i];
        else this.until[i] = time + 3 + (i % 5) * 0.4;
      }
      this.on[i] = want ? 1 : 0;
      if (!want) continue;
      // Lit lights give their bearer away to the other side (briefly revealed, like a searchlight's beam does).
      if (!s.isPlayer) s.spotted = Math.max(s.spotted, 0.25);
      if (n >= MAX || (s.pos.x - cx) ** 2 + (s.pos.z - cz) ** 2 > 320 * 320) continue;
      const yaw = s.yaw, pitch = s.pitch || 0, cp = Math.cos(pitch);
      _d.set(Math.sin(yaw) * cp, Math.sin(pitch) - 0.08, Math.cos(yaw) * cp).normalize();
      const crouch = s.stance === 1 ? 0.45 : s.stance === 2 ? 1.05 : 0;
      _p.set(s.pos.x + _d.x * 0.55, s.pos.y + 1.35 - crouch, s.pos.z + _d.z * 0.55);
      const r = LEN * 0.24;
      _m.compose(_p, _q.setFromUnitVectors(Z, _d), _s.set(r, r, LEN));
      this.mesh.setMatrixAt(n, _m);
      this.lens[this.nLens * 3] = _p.x; this.lens[this.nLens * 3 + 1] = _p.y; this.lens[this.nLens * 3 + 2] = _p.z;
      this.nLens++;
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.stats.lit = n;
    // The player's spot light follows the view (first person) or the soldier's aim (third person).
    const p = g.player;
    if (dark && this.playerOn && p && p.alive && !p.vehicle) {
      const fp = g.playerCtl && g.playerCtl.firstPerson;
      if (fp) { this.spot.position.copy(cam.position); cam.getWorldDirection(_d); }
      else { const cp = Math.cos(p.pitch || 0); _d.set(Math.sin(p.yaw) * cp, Math.sin(p.pitch || 0), Math.cos(p.yaw) * cp); this.spot.position.set(p.pos.x, p.pos.y + 1.4, p.pos.z); }
      this.spot.target.position.copy(this.spot.position).addScaledVector(_d, 20);
      this.spot.target.updateMatrixWorld();
      this.spot.intensity = 60;
    } else this.spot.intensity = 0;
  }
}
