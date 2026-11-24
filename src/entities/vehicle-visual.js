import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { merge, finish, box, cyl, DARK, STEEL } from './models/kit.js';
import { MODELS } from './models/vehicle-models.js';
import { interiorSpec } from './models/vehicle-interiors.js';

/**
 * @typedef {Object} VehicleVisual
 * @property {THREE.Group} root
 * @property {THREE.Mesh} hull
 * @property {({yaw: THREE.Object3D, pitch: THREE.Object3D}|null)[]} mounts  per mount (null = no moving parts)
 * @property {THREE.InstancedMesh|null} wheels
 * @property {{node: THREE.Object3D, axis: 'x'|'y', dir: number, rate: number}[]} rotors
 * @property {{node: THREE.Object3D, rate: number}[]} spinners
 * @property {THREE.Object3D[]} detail   hidden beyond the detail distance
 * @property {THREE.Mesh[]} casters      shadow casters (switched off at distance)
 * @property {THREE.MeshLambertMaterial} material
 * @property {THREE.Group} interior  crew / troop compartment, drawn from a seat view (open vehicles: when near)
 * @property {{node: THREE.Object3D, kind: string, side: number}[]} controls  steering wheel, levers, sticks
 * @property {{node: THREE.Object3D, seat: number}[]} hatches
 * @property {{node: THREE.Object3D, axis: string, open: number, z: number, seats: number[]}[]} doors
 * @property {import('./models/vehicle-interiors.js').InteriorSpec} ins
 * @property {{lenses: THREE.Mesh, beams: THREE.Group, anchor: THREE.Object3D, lit: boolean}|null} headlights
 */

/** Cockpit / cab glazing: tinted, glossy, partly transparent. */
const GLASS_MAT = new THREE.MeshStandardMaterial({ color: 0x5f7f88, roughness: 0.12, metalness: 0.35, transparent: true, opacity: 0.3, depthWrite: false });

/** Headlight materials shared by every vehicle: lenses swap between off and on; beams fade with the darkness. */
export const HEADLIGHT = {
  lensOff: new THREE.MeshLambertMaterial({ color: 0x8d9296, emissive: 0x1a1a16 }),
  lensOn: new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.9, 2.3), toneMapped: false, fog: false }),
  /**
   * Volumetric light shaft: an open cone drawn from both sides; brightness follows the light's path through the
   * haze (faces seen square-on carry more light than the grazing silhouette), falls off with distance from the lens
   * with an inverse-square-like curve, and is broken up by slowly drifting dust / moisture. `opacity` is driven by
   * the atmosphere (darkness, fog, rain).
   */
  beam: new THREE.ShaderMaterial({
    uniforms: { opacity: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color(1, 0.93, 0.78) } },
    vertexShader: /* glsl */ `
      varying vec3 vLocal; varying vec3 vWorld; varying vec3 vN; varying vec3 vView;
      void main() {
        vLocal = position;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float opacity; uniform float uTime; uniform vec3 uColor;
      varying vec3 vLocal; varying vec3 vWorld; varying vec3 vN; varying vec3 vView;
      float h(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      float n3(vec3 p) {
        vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      void main() {
        float along = clamp(vLocal.z / 26.0, 0.0, 1.0);
        float facing = abs(dot(normalize(vN), normalize(vView)));
        float path = pow(facing, 1.4);
        float fall = 1.0 / (1.0 + along * along * 14.0) * (1.0 - smoothstep(0.7, 1.0, along));
        float start = smoothstep(0.0, 0.03, along);
        vec3 q = vWorld * 0.35 + vec3(uTime * 0.12, uTime * 0.05, -uTime * 0.08);
        float dust = 0.7 + 0.45 * n3(q) + 0.2 * n3(q * 3.1);
        float a = opacity * path * fall * start * dust;
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false,
  }),
};
const _beamGeo = (() => {
  // Light cone from the lens (apex at the lamp, opening along +z), tipped 5° down so it lights the road ahead.
  const g = new THREE.ConeGeometry(4.2, 26, 20, 6, true);
  g.translate(0, -13, 0); g.rotateX(-Math.PI / 2); g.rotateX(0.09);
  return g;
})();

/**
 * Recessed headlight housings built into the front of the hull: a dark bezel set into the bodywork with the lens
 * just behind its rim, plus a beam cone for each. Parented to the vehicle root (the interpolated render transform),
 * so they track yaw and pitch every frame. The front face is found from the hull geometry itself.
 */
function addHeadlights(v, def, hullGeo) {
  if (def.kind !== 'ground' || def.static || def.noHeadlights) return null;
  const pos = hullGeo.attributes.position.array;
  hullGeo.computeBoundingBox();
  const bb = /** @type {THREE.Box3} */ (hullGeo.boundingBox);
  const lx = Math.max(0.35, (bb.max.x - bb.min.x) * 0.36);
  const ly = def.headlightY !== undefined ? def.headlightY - def.ride : Math.min(bb.max.y - 0.3, Math.max(bb.min.y + 0.45, 0.95 - def.ride));
  // Front surface at the lamp: the furthest-forward hull vertex near the lamp position.
  let fz = -1e9;
  for (let i = 0; i < pos.length; i += 3) {
    if (Math.abs(Math.abs(pos[i]) - lx) < 0.45 && Math.abs(pos[i + 1] - ly) < 0.35 && pos[i + 2] > fz) fz = pos[i + 2];
  }
  if (fz < -1e8) fz = bb.max.z;
  const parts = [], lens = [], beams = [];
  for (const sx of [-1, 1]) {
    const x = sx * lx;
    parts.push(box(0.34, 0.24, 0.16, x, ly, fz - 0.05, DARK));                 // bezel recess
    parts.push(box(0.4, 0.05, 0.2, x, ly + 0.15, fz - 0.04, STEEL));           // visor lip
    lens.push(cyl(0.095, 0.095, 0.04, 10, x, ly, fz - 0.02, 0xffffff, Math.PI / 2));
    beams.push(x);
  }
  // The housings share the hull's material: merged into the hull mesh (no extra draw call per vehicle).
  v.hull.geometry = merge([v.hull.geometry, merge(parts)]);
  const lenses = new THREE.Mesh(merge(lens), HEADLIGHT.lensOff);
  v.root.add(lenses);
  v.detail.push(lenses); // a draw call per vehicle: only near (beams carry the light further out at night)
  const beamMesh = new THREE.Group();
  for (const x of beams) {
    const b = new THREE.Mesh(_beamGeo, HEADLIGHT.beam);
    b.position.set(x, ly, fz); b.renderOrder = 7; b.frustumCulled = false;
    beamMesh.add(b);
  }
  beamMesh.visible = false;
  v.root.add(beamMesh);
  const anchor = new THREE.Object3D();
  anchor.position.set(0, ly, fz + 1.5);
  v.root.add(anchor);
  return { lenses, beams: beamMesh, anchor, lit: false };
}

/**
 * Turns a model spec into a scene graph: one merged hull mesh, one mesh per
 * moving part (turret, gun, remote weapon), an instanced mesh for all wheels,
 * and nodes for rotors and radar antennas. Everything shares one material.
 * @param {import('./vehicle-defs.js').VehicleDef} def
 * @param {number} team  owning team (sets markings)
 * @param {(m: THREE.Material) => THREE.Material} setupMaterial
 * @returns {VehicleVisual}
 */
export function buildVehicleVisual(def, team, setupMaterial) {
  const teamHex = team >= 0 ? CONFIG.teams[team].color : 0x8a8f86;
  const spec = MODELS[def.type](def, teamHex);
  const scheme = { ...spec.scheme, team: teamHex };
  // Imported models: matte standard material (0.75 roughness) for paint and armour; hand-built ones stay Lambert.
  const material = /** @type {THREE.MeshLambertMaterial} */ (setupMaterial(spec.imported
    ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.12 })
    : new THREE.MeshLambertMaterial({ vertexColors: true })));
  const root = new THREE.Group();
  const dy = spec.local ? 0 : -def.ride;
  const mesh = (geos, parent, shadow, offset = 0) => {
    const m = new THREE.Mesh(finish(merge(geos, offset), scheme), material);
    m.castShadow = shadow;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  /** @type {VehicleVisual} */
  const v = {
    root, hull: mesh(spec.hull, root, true, dy), mounts: [], wheels: null, rotors: [], spinners: [], detail: [], casters: [], material,
  };
  v.casters.push(v.hull);
  v.headlights = addHeadlights(v, def, v.hull.geometry);
  // Tinted see-through glazing (the generated interior shows behind it) and retractable landing gear.
  if (spec.glass && spec.glass.length) {
    const g = new THREE.Mesh(merge(spec.glass, dy), GLASS_MAT);
    g.renderOrder = 2; root.add(g); v.glass = g;
  }
  v.gear = null;
  if (spec.gear && spec.gear.length) { v.gear = mesh(spec.gear, root, true, dy); }

  for (let i = 0; i < def.mounts.length; i++) {
    const m = def.mounts[i];
    const parts = spec.mounts && spec.mounts[i];
    if (m.coax !== undefined || m.turnRate === 0 || !m.pos) { v.mounts.push(null); continue; }
    const yaw = new THREE.Object3D(), pitch = new THREE.Object3D();
    yaw.position.fromArray(m.pos);
    pitch.position.fromArray(m.trunnion || [0, 0, 0]);
    yaw.add(pitch);
    const parent = m.parent !== undefined ? v.mounts[m.parent] : null;
    if (parent) {
      const pp = def.mounts[/** @type {number} */ (m.parent)].pos;
      yaw.position.set(m.pos[0] - pp[0], m.pos[1] - pp[1], m.pos[2] - pp[2]);
      parent.yaw.add(yaw);
    } else root.add(yaw);
    const main = i === 0;
    if (parts && parts.yaw) { const y = mesh(parts.yaw, yaw, main); if (main) v.casters.push(y); else v.detail.push(y); }
    if (parts && parts.pitch) { const p = mesh(parts.pitch, pitch, main); if (main) v.casters.push(p); else v.detail.push(p); }
    v.mounts.push({ yaw, pitch });
  }

  if (spec.wheel && def.wheels.length) {
    const geo = finish(spec.wheel, scheme);
    const wm = new THREE.InstancedMesh(geo, material, def.wheels.length);
    wm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    wm.frustumCulled = false;
    wm.receiveShadow = true;
    root.add(wm);
    v.wheels = wm;
  }

  for (const r of spec.rotors || []) {
    const node = new THREE.Object3D();
    node.position.set(r.pos[0], r.pos[1] + dy, r.pos[2]);
    root.add(node);
    mesh(r.geos, node, false);
    v.rotors.push({ node, axis: r.axis, dir: r.dir, rate: r.rate });
  }
  // Interior, controls, hatches and doors (shared geometry per vehicle type, painted once).
  const ins = interiorSpec(def, spec);
  v.ins = ins;
  v.interior = new THREE.Group();
  v.controls = []; v.hatches = []; v.doors = []; v.doorGlass = [];
  if (!ins.finished) {
    ins.finished = true;
    if (ins.shell) finish(ins.shell, scheme);
    for (const c of ins.controls) finish(c.geo, scheme);
    for (const h of ins.hatches) finish(h.geo, scheme);
    for (const d of ins.doors) finish(d.geo, scheme);
  }
  v.cabin = !!spec.cabin;
  v.cabinSeats = spec.cabin && spec.cabin.seats ? new Set(spec.cabin.seats) : null;
  const part = (geo, parent) => { const m = new THREE.Mesh(geo, material); m.castShadow = false; m.receiveShadow = false; parent.add(m); return m; };
  if (ins.shell) part(ins.shell, v.interior);
  for (const c of ins.controls) {
    const node = new THREE.Object3D();
    node.position.set(c.x, c.y, c.z);
    part(c.geo, node);
    v.interior.add(node);
    v.controls.push({ node, kind: c.kind, side: c.side, tilt: c.tilt });
  }
  root.add(v.interior);
  v.interior.visible = ins.open;
  if (ins.open) v.detail.push(v.interior);
  for (const h of ins.hatches) {
    const node = new THREE.Object3D();
    const host = h.turret >= 0 && v.mounts[h.turret] ? /** @type {any} */ (v.mounts[h.turret]).yaw : root;
    const tp = h.turret >= 0 ? def.mounts[h.turret].pos : null;
    node.position.set(h.x - (tp ? tp[0] : 0), h.y - (tp ? tp[1] : 0), h.z - (tp ? tp[2] : 0));
    v.detail.push(part(h.geo, node));
    host.add(node);
    v.hatches.push({ node, seat: h.seat });
  }
  for (const d of ins.doors) {
    const node = new THREE.Object3D();
    node.position.set(d.x, d.y, d.z);
    v.detail.push(part(d.geo, node));
    // door panes are drawn with the interior (near): beyond that the open window frame reads the same
    if (d.glass) { const g = new THREE.Mesh(d.glass, GLASS_MAT); g.renderOrder = 2; node.add(g); v.doorGlass.push(g); }
    root.add(node);
    v.doors.push({ node, axis: d.axis, open: d.open, z: d.z, seats: d.seats });
  }
  for (const s of spec.spinners || []) {
    const node = new THREE.Object3D();
    const host = s.mount >= 0 && v.mounts[s.mount] ? /** @type {any} */ (v.mounts[s.mount]).yaw : root;
    node.position.set(s.pos[0], s.pos[1] + (host === root ? dy : 0), s.pos[2]);
    host.add(node);
    const m = mesh(s.geos, node, false);
    v.detail.push(m);
    v.spinners.push({ node, rate: s.rate });
  }
  return v;
}
