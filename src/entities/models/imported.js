import * as THREE from 'three';
import { PAINT, PAINT2, TEAM, DARK, STEEL, RUBBER, GLASS, LENS, TRACK, box, cyl, sphere, tubeZ, mirror, place } from './kit.js';

/**
 * Imported Torsa vehicles: HD source models reduced offline (tools/models/README.md) to 1.3–4.5 k triangles each,
 * repainted into the game's paint keys (camo, team markings, dark metal, rubber, glass) with baked ambient
 * occlusion, split into rigged parts (hull, turret / launcher / erector, gun, wheel, main and tail rotor, radar,
 * landing gear) whose geometry is stored relative to its pivot. Everything is in ground coordinates
 * (+Z forward, +X left, y = 0 on the ground at rest), like the hand-built models.
 *
 * Packed file: u32 header length, JSON header, then per part uint16 quantised positions, a paint class per
 * triangle and an AO byte per vertex.
 */
const KEY = { PAINT, PAINT2, TEAM, DARK, STEEL, RUBBER, GLASS, LENS, LAMP: 0xfff0c0, TRACK };

/** @type {Record<string, {info: any, parts: Record<string, THREE.BufferGeometry>, glass: Record<string, THREE.BufferGeometry>}>} */
export const IMPORTED = {};
let loading = null;

/** Fetches and decodes the packed models once (resolves immediately when already loaded or unavailable). */
export function loadImported() {
  if (loading) return loading;
  const url = new URL('./torsa-models.bin', import.meta.url).href;
  loading = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).then((buf) => { if (buf) decode(buf); }).catch((e) => {
    console.warn('[models] imported vehicle models unavailable, using fallbacks', e);
  });
  return loading;
}

function decode(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  const base = 4 + n, classes = header.classes;
  const col = new THREE.Color();
  for (const key in header.models) {
    const M = header.models[key], parts = {}, glass = {};
    for (const p of M.parts) {
      const q = new Uint16Array(buf, base + p.pos, p.n * 9);
      const cls = new Uint8Array(buf, base + p.cls, p.n);
      const ao = new Uint8Array(buf, base + p.ao, p.n * 3);
      // Split glass off into its own geometry (tinted, see-through: the generated interior shows behind it).
      let ng = 0;
      for (let t = 0; t < p.n; t++) if (classes[cls[t]] === 'GLASS') ng++;
      const mk = (count) => ({ pos: new Float32Array(count * 9), col: new Float32Array(count * 9), ao: new Float32Array(count * 3), k: 0 });
      const A = mk(p.n - ng), G = mk(ng);
      for (let t = 0; t < p.n; t++) {
        const name = classes[cls[t]], T = name === 'GLASS' ? G : A;
        col.setHex(KEY[name] ?? PAINT);
        for (let v = 0; v < 3; v++) {
          const s = (t * 3 + v) * 3, d = (T.k * 3 + v) * 3;
          for (let c = 0; c < 3; c++) T.pos[d + c] = p.lo[c] + q[s + c] * p.sc[c];
          T.col[d] = col.r; T.col[d + 1] = col.g; T.col[d + 2] = col.b;
          T.ao[T.k * 3 + v] = ao[t * 3 + v] / 200;
        }
        T.k++;
      }
      const geo = (T) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(T.pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(T.col, 3));
        g.setAttribute('ao', new THREE.BufferAttribute(T.ao, 1));
        g.computeVertexNormals();
        return g;
      };
      parts[p.name] = geo(A);
      if (ng) glass[p.name] = geo(G);
    }
    IMPORTED[key] = { info: M.info, parts, glass };
  }
}

const shift = (g, dx, dy, dz) => g.clone().translate(dx, dy, dz);
const TORSA_GROUND = { base: [0x5b6538, 0x8a845e, 0x4a4f4f], scale: 2.4 };
const TORSA_AIR = { base: [0x59605a, 0x7d8279, 0x4a5157], belly: 0x9aa7ae, scale: 3.2 };

/**
 * Model spec for an imported vehicle (see vehicle-models.js ModelSpec), or null when it did not load.
 * @param {string} key  imported model id
 * @param {{air?: boolean, lift?: number, extraHull?: THREE.BufferGeometry[], gear?: THREE.BufferGeometry[], mountMap?: Record<string, number>}} [o]
 */
export function importedSpec(key, o = {}) {
  const M = IMPORTED[key];
  if (!M) return null;
  const P = M.parts, info = M.info, lift = o.lift || 0;
  const lifted = (g) => (lift ? shift(g, 0, lift, 0) : g);
  const marks = markings(P.hull, !!o.air, lift);
  const spec = {
    imported: true,
    scheme: o.air ? TORSA_AIR : TORSA_GROUND,
    hull: [lifted(P.hull), ...marks, ...(o.extraHull || [])],
    glass: Object.entries(M.glass).filter(([n]) => n === 'hull').map(([, g]) => lifted(g)),
    mounts: {},
    rotors: [],
    spinners: [],
  };
  if (P.wheel) spec.wheel = P.wheel;
  const m = o.mountMap || { yaw0: 0, pitch0: 0 };
  if (P.yaw0 || P.pitch0) {
    const idx = m.pitch0 ?? 0;
    spec.mounts[idx] = { yaw: P.yaw0 ? [P.yaw0] : [], pitch: P.pitch0 ? [P.pitch0] : [] };
  }
  if (P.rotor) spec.rotors.push({ pos: [info.rotor[0], info.rotor[1] + lift, info.rotor[2]], axis: 'y', dir: 1, rate: 22, geos: [P.rotor] });
  if (P.tailrotor) spec.rotors.push({ pos: [info.tailrotor[0], info.tailrotor[1] + lift, info.tailrotor[2]], axis: 'x', dir: 1, rate: 60, geos: [P.tailrotor] });
  if (P.spin) spec.spinners.push({ mount: -1, pos: info.spin, rate: 1.6, geos: [P.spin] });
  if (P.gear || o.gear) spec.gear = [...(P.gear ? [lifted(P.gear)] : []), ...(o.gear || [])];
  return spec;
}

/**
 * Torsa tactical markings as small plates fitted to the hull surface: orange side bars on ground vehicles
 * (two per side), fin-tip bands on aircraft (each fin found from the hull's highest rear points).
 */
function markings(hull, air, lift) {
  const p = hull.attributes.position.array, out = [];
  let x0 = 1e9, x1 = -1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y1 = Math.max(y1, p[i + 1]); z0 = Math.min(z0, p[i + 2]); z1 = Math.max(z1, p[i + 2]); }
  const L = z1 - z0;
  if (!air) {
    // side surface: outermost hull point in a small window around the plate centre
    const at = (sx, y, z) => { let m = 0; for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i + 1] - y) < 0.2 && Math.abs(p[i + 2] - z) < 0.35 && p[i] * sx > m) m = p[i] * sx; return m; };
    const y = y1 * 0.62;
    for (const zf of [0.12, -0.18]) for (const sx of [1, -1]) {
      const z = z0 + L * (0.5 + zf), x = at(sx, y, z);
      if (x > 0.3) out.push(box(0.03, 0.22, 0.75, sx * (x + 0.012), y + lift, z, TEAM));
    }
  } else {
    // fins: highest points in the rear quarter, either side of the centreline (twin fins) or on it
    const rear = z0 + L * 0.3;
    for (const side of [1, -1, 0]) {
      let by = -1e9, bx = 0, bz = 0;
      for (let i = 0; i < p.length; i += 3) {
        if (p[i + 2] > rear) continue;
        const sx = p[i] > 0.25 ? 1 : p[i] < -0.25 ? -1 : 0;
        if (sx !== side || p[i + 1] <= by) continue;
        by = p[i + 1]; bx = p[i]; bz = p[i + 2];
      }
      if (by > y1 * 0.8) out.push(box(0.36, 0.45, 1.1, bx, by - 0.45 + lift, bz + 0.35, TEAM));
    }
  }
  return out;
}

// ------------------------------------------------------------------ procedural fallbacks (no source model)

/**
 * Combat engineering vehicle (BMR-3M-style reference drawing): T-72 derived hull, armoured crew cab with
 * vision blocks, small remote weapon station, front mine-roller frame on articulated arms, rear crane jib.
 */
export function cevSpec() {
  const hull = [
    box(3.4, 0.9, 6.6, 0, 1.0, 0, PAINT), box(3.0, 0.5, 6.0, 0, 1.7, -0.1, PAINT),
    place(box(3.0, 0.08, 1.6, 0, 0, 0, PAINT), 0, 1.6, 3.55, -0.85),                       // glacis
    box(2.6, 0.9, 2.6, 0, 2.35, -0.8, PAINT), box(2.62, 0.25, 2.62, 0, 2.9, -0.8, DARK),    // crew cab
    ...mirror([box(0.05, 0.2, 0.5, 1.31, 2.55, -0.4, GLASS), box(0.05, 0.2, 0.5, 1.31, 2.55, -1.2, GLASS)]),
    box(1.6, 0.2, 0.05, 0, 2.55, 0.51, GLASS),
    ...mirror([box(0.5, 0.75, 6.8, 1.45, 0.62, 0, TRACK), box(0.55, 0.08, 6.6, 1.45, 1.28, 0, PAINT)]),
    ...[-2.6, -1.3, 0, 1.3, 2.6].flatMap((z) => mirror([cyl(0.38, 0.38, 0.3, 10, 1.45, 0.55, z, DARK, 0, 0, Math.PI / 2)])),
    // mine-roller frame (arms and two roller gangs ahead of the tracks)
    ...mirror([box(0.18, 0.18, 2.6, 1.0, 1.05, 4.4, STEEL, 0.25), cyl(0.36, 0.36, 0.9, 10, 1.05, 0.38, 5.6, DARK, 0, 0, Math.PI / 2)]),
    box(2.4, 0.12, 0.12, 0, 0.75, 5.55, STEEL), box(3.6, 0.5, 0.25, 0, 0.7, 4.0, STEEL, -0.35), // dozer blade
    // rear crane jib (stowed) and spare track links
    box(0.3, 0.3, 3.2, -0.9, 2.35, -2.4, PAINT), cyl(0.18, 0.18, 0.5, 8, -0.9, 2.1, -1.0, STEEL),
    box(0.04, 0.45, 1.2, 1.7, 1.75, -2.0, TEAM), box(0.04, 0.45, 1.2, -1.7, 1.75, -2.0, TEAM),
    box(0.25, 0.25, 0.05, 1.1, 1.55, 3.32, 0xfff0c0), box(0.25, 0.25, 0.05, -1.1, 1.55, 3.32, 0xfff0c0),
  ];
  const yaw = [cyl(0.38, 0.42, 0.25, 10, 0, 0.12, 0, PAINT), box(0.5, 0.3, 0.6, 0, 0.35, 0, PAINT), sphere(0.12, 0.2, 0.42, 0.25, LENS)];
  const pitch = [tubeZ(0.045, 0.045, 0, 1.1, 0, 0, 8, DARK), box(0.16, 0.18, 0.5, 0, 0, 0.1, DARK)];
  return { scheme: TORSA_GROUND, hull, mounts: { 0: { yaw, pitch } } };
}

/**
 * Light military transport aircraft from its general-arrangement drawing (Il-112V-style): 23.1 m long, 24.7 m
 * span, 8.4 m tall; high wing, twin turboprops, swept fin, rear cargo ramp, paratroop doors, glazed cockpit.
 */
export function transportPlaneSpec() {
  const F = [];
  // fuselage: stations [z, halfWidth, halfHeight, yCentre]
  const st = [[11.5, 0.2, 0.25, 2.6], [11.0, 0.8, 0.85, 2.65], [9.8, 1.35, 1.35, 2.8], [8.0, 1.62, 1.62, 2.9], [-3.5, 1.62, 1.62, 2.9],
    [-6.5, 1.3, 1.25, 3.25], [-9.5, 0.65, 0.65, 3.9], [-11.6, 0.3, 0.3, 4.2]];
  for (let i = 0; i < st.length - 1; i++) {
    const [z0, w0, h0, y0] = st[i], [z1, w1, h1, y1] = st[i + 1];
    const zc = (z0 + z1) / 2, len = Math.abs(z0 - z1);
    const g = new THREE.CylinderGeometry(1, 1, len, 14, 1, false);
    g.rotateX(Math.PI / 2);
    // taper the section from (w0,h0) to (w1,h1)
    const pos = g.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      const front = pos.getZ(k) > 0;
      pos.setX(k, pos.getX(k) * (front ? w0 : w1));
      pos.setY(k, pos.getY(k) * (front ? h0 : h1) + (front ? y0 : y1));
      pos.setZ(k, pos.getZ(k) + zc);
    }
    F.push(paintGeo(g, PAINT));
  }
  F.push(
    box(1.9, 0.5, 0.06, 0, 3.55, 10.25, GLASS, -0.7), ...mirror([box(0.05, 0.42, 0.9, 1.25, 3.4, 9.6, GLASS)]),     // cockpit glazing
    box(24.7, 0.32, 2.7, 0, 4.7, 1.2, PAINT), ...mirror([box(0.05, 0.5, 0.5, 12.35, 4.8, 1.0, TEAM)]),            // high wing + tips
    box(0.3, 4.2, 2.6, 0, 6.6, -10.3, PAINT, 0.32), box(8.5, 0.18, 1.8, 0, 4.4, -10.6, PAINT),                   // fin, tailplane
    box(0.04, 1.2, 1.1, 0.2, 7.0, -10.6, TEAM), box(0.04, 1.2, 1.1, -0.2, 7.0, -10.6, TEAM),
    ...mirror([tubeZ(0.62, 0.55, -0.5, 4.2, 4.05, 4.3, 12, PAINT), tubeZ(0.3, 0.2, 4.2, 4.6, 4.05, 4.3, 10, DARK)]),   // nacelles
    ...mirror([box(1.2, 0.7, 2.6, 1.9, 1.55, 0.5, PAINT)]),                                                      // gear sponsons
    ...mirror([box(0.05, 1.3, 0.75, 1.62, 2.6, -4.2, DARK)]),                                                    // paratroop doors
    box(2.4, 0.06, 3.2, 0, 1.75, -6.2, DARK, 0.42),                                                              // cargo ramp line
  );
  const gear = [
    box(0.15, 1.6, 0.15, 0, 0.95, 9.0, STEEL), cyl(0.32, 0.32, 0.3, 10, 0, 0.32, 9.0, RUBBER, 0, 0, Math.PI / 2),
    ...mirror([box(0.2, 1.3, 0.2, 1.9, 0.75, 0.5, STEEL), cyl(0.45, 0.45, 0.35, 12, 1.9, 0.45, 1.0, RUBBER, 0, 0, Math.PI / 2), cyl(0.45, 0.45, 0.35, 12, 1.9, 0.45, 0.0, RUBBER, 0, 0, Math.PI / 2)]),
  ];
  const prop = (x) => ({ pos: [x, 4.05, 4.65], axis: 'z', dir: x > 0 ? 1 : -1, rate: 40, geos: [0, 1, 2, 3, 4, 5].map((i) => place(box(0.22, 1.9, 0.06, 0, 0.95, 0, DARK), 0, 0, 0, 0, 0, (i * Math.PI) / 3)) });
  return { scheme: TORSA_AIR, hull: F, gear, rotors: [prop(4.3), prop(-4.3)] };
}

function paintGeo(g, color) {
  const n = g.attributes.position.count, c = new Float32Array(n * 3), k = new THREE.Color(color);
  for (let i = 0; i < n; i++) { c[i * 3] = k.r; c[i * 3 + 1] = k.g; c[i * 3 + 2] = k.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g.index ? g.toNonIndexed() : g;
}

/** Fixed landing gear for the light attack jet (the source model has it retracted). */
export function yakGear() {
  return [
    box(0.12, 1.15, 0.12, 0, 0.6, 4.0, STEEL), cyl(0.26, 0.26, 0.18, 10, 0, 0.26, 4.0, RUBBER, 0, 0, Math.PI / 2),
    ...mirror([box(0.14, 1.1, 0.14, 1.3, 0.6, -0.8, STEEL), cyl(0.32, 0.32, 0.22, 10, 1.3, 0.32, -0.8, RUBBER, 0, 0, Math.PI / 2)]),
  ];
}
