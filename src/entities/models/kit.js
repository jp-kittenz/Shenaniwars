import * as THREE from 'three';
import { noise2 } from '../../core/math.js';

/**
 * Low-poly modelling kit. Every helper returns a non-indexed BufferGeometry
 * with `position`, `normal` and per-vertex `color`, ready to be merged into a
 * single draw call. Hulls and turrets are built by lofting 2D outlines traced
 * from side, top or front drawings, which keeps silhouettes faithful while
 * staying cheap to render.
 *
 * Coordinates: metres, +Z forward, +X left, +Y up.
 */

/** Sentinel colours replaced at finish time (body paint, secondary paint, team marking). */
export const PAINT = 0xff00ff;
export const PAINT2 = 0xfe00fe;
export const TEAM = 0x00ff01;
export const DARK = 0x23262a;
export const STEEL = 0x4d5459;
export const RUBBER = 0x1d1e1f;
export const TRACK = 0x2c2c29;
export const GLASS = 0x7fb4c4;
export const LENS = 0x262c33;
export const WOOD = 0x7a4a26;
export const CANVAS = 0x8a7a52;

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Fills a geometry's colour attribute with one colour. */
export function paint(geo, color) {
  _c.set(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Normalises a primitive: non-indexed, no uvs, painted. */
function prep(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.deleteAttribute('uv');
  return paint(g, color);
}

/** Applies translation + XYZ euler rotation (radians). */
export function place(geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
  return geo.applyMatrix4(_m);
}

export function box(w, h, d, x, y, z, color, rx = 0, ry = 0, rz = 0) {
  return place(prep(new THREE.BoxGeometry(w, h, d), color), x, y, z, rx, ry, rz);
}

/** Cylinder along Y (rotate to re-orient). */
export function cyl(rTop, rBot, h, seg, x, y, z, color, rx = 0, ry = 0, rz = 0) {
  return place(prep(new THREE.CylinderGeometry(rTop, rBot, h, seg), color), x, y, z, rx, ry, rz);
}

/** Tube along Z from z0 to z1 (radius r0 at z0, r1 at z1). */
export function tubeZ(r0, r1, z0, z1, x, y, seg, color) {
  return place(prep(new THREE.CylinderGeometry(r1, r0, Math.abs(z1 - z0), seg), color), x, y, (z0 + z1) / 2, Math.PI / 2, 0, 0);
}

/** Tube along X centred at x (e.g. wheels, axles). */
export function tubeX(r, w, x, y, z, seg, color) {
  return place(prep(new THREE.CylinderGeometry(r, r, w, seg), color), x, y, z, 0, 0, Math.PI / 2);
}

export function sphere(r, x, y, z, color, sx = 1, sy = 1, sz = 1, ws = 8, hs = 6, thetaLen = Math.PI) {
  return place(prep(new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, thetaLen), color), x, y, z, 0, 0, 0, sx, sy, sz);
}

export function cone(r, h, seg, x, y, z, color, rx = 0, ry = 0, rz = 0) {
  return place(prep(new THREE.ConeGeometry(r, h, seg), color), x, y, z, rx, ry, rz);
}

// --- Lofted outlines -----------------------------------------------------------

const PLANES = {
  // u, v basis and extrusion axis; s = sign of (extrusion · (u × v))
  side: { u: [0, 0, 1], v: [0, 1, 0], e: [1, 0, 0], s: -1 },
  top: { u: [1, 0, 0], v: [0, 0, 1], e: [0, 1, 0], s: -1 },
  front: { u: [1, 0, 0], v: [0, 1, 0], e: [0, 0, 1], s: 1 },
};

/**
 * Lofts outline A (at depth w0) to outline B (at depth w1). Both outlines must
 * have the same vertex count. Planes: 'side' (pts = [z, y], depth along X),
 * 'top' ([x, z], depth along Y) and 'front' ([x, y], depth along Z).
 * @param {number[][]} a @param {number[][]} b
 * @param {'side'|'top'|'front'} plane
 */
export function loft(a, b, plane, w0, w1, color) {
  if (w1 < w0) { [a, b] = [b, a]; [w0, w1] = [w1, w0]; }
  const P = PLANES[plane];
  const vecA = a.map((p) => new THREE.Vector2(p[0], p[1]));
  if (THREE.ShapeUtils.isClockWise(vecA)) { a = a.slice().reverse(); b = b.slice().reverse(); vecA.reverse(); }
  const tris = THREE.ShapeUtils.triangulateShape(vecA, []);
  const out = [];
  const pt = (p, w) => [
    P.u[0] * p[0] + P.v[0] * p[1] + P.e[0] * w,
    P.u[1] * p[0] + P.v[1] * p[1] + P.e[1] * w,
    P.u[2] * p[0] + P.v[2] * p[1] + P.e[2] * w,
  ];
  const tri = (p, q, r, flip) => { if (flip) out.push(...p, ...r, ...q); else out.push(...p, ...q, ...r); };
  // Caps: the far cap faces +E, the near cap -E; a CCW outline faces s·E.
  for (const t of tris) {
    tri(pt(b[t[0]], w1), pt(b[t[1]], w1), pt(b[t[2]], w1), P.s < 0);
    tri(pt(a[t[0]], w0), pt(a[t[1]], w0), pt(a[t[2]], w0), P.s > 0);
  }
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const pa = pt(a[i], w0), pb = pt(a[j], w0), pc = pt(b[j], w1), pd = pt(b[i], w1);
    tri(pa, pb, pc, P.s < 0);
    tri(pa, pc, pd, P.s < 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  geo.computeVertexNormals();
  return paint(geo, color);
}

/** Side profile ([z, y] points) extruded across width `w`, centred at x. */
export function side(pts, w, color, x = 0) { return loft(pts, pts, 'side', x - w / 2, x + w / 2, color); }

/**
 * Top outline ([x, z] points) raised from y0 by h. `taper` scales the top
 * outline about its centroid (sloped sides), `shift` moves it ([dx, dz]).
 */
export function top(pts, y0, h, color, taper = 1, shift = [0, 0]) {
  let cx = 0, cz = 0;
  for (const p of pts) { cx += p[0]; cz += p[1]; }
  cx /= pts.length; cz /= pts.length;
  const b = pts.map((p) => [cx + (p[0] - cx) * taper + shift[0], cz + (p[1] - cz) * taper + shift[1]]);
  return loft(pts, b, 'top', y0, y0 + h, color);
}

/** Front outline ([x, y] points) extruded from z0 to z1. */
export function front(pts, z0, z1, color, taper = 1) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;
  const b = pts.map((p) => [cx + (p[0] - cx) * taper, cy + (p[1] - cy) * taper]);
  return loft(pts, b, 'front', z0, z1, color);
}

/** Regular polygon outline helper ([u, v] points). */
export function ngon(n, r, cu = 0, cv = 0, rot = 0, su = 1, sv = 1) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    pts.push([cu + Math.cos(a) * r * su, cv + Math.sin(a) * r * sv]);
  }
  return pts;
}

/** Reverses triangle winding in place (after a mirroring transform). */
function flipWinding(geo) {
  for (const name of ['position', 'normal', 'color']) {
    const attr = geo.attributes[name];
    if (!attr) continue;
    const a = attr.array;
    for (let i = 0; i < a.length; i += 9) {
      for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; }
    }
  }
}

/** Returns the parts plus copies mirrored across the X = 0 plane (left/right symmetry). */
export function mirror(geos) {
  const out = [...geos];
  for (const g of geos) {
    const c = g.clone();
    c.applyMatrix4(_m.makeScale(-1, 1, 1));
    flipWinding(c);
    out.push(c);
  }
  return out;
}

/**
 * Merges parts into one geometry (offset by dy) and frees the sources.
 * @param {THREE.BufferGeometry[]} parts
 */
export function merge(parts, dy = 0) {
  let count = 0;
  for (const g of parts) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), col = new Float32Array(count * 3);
  let o = 0;
  for (const g of parts) {
    const n = g.attributes.position.count;
    const gp = /** @type {Float32Array} */ (g.attributes.position.array), gn = /** @type {Float32Array} */ (g.attributes.normal.array);
    pos.set(gp.subarray(0, n * 3), o);
    nrm.set(gn.subarray(0, n * 3), o);
    col.set(/** @type {Float32Array} */ (g.attributes.color.array).subarray(0, n * 3), o);
    // Thin and small parts (panels, strips, markings, dials, bolts) usually sit flush on a larger surface: push
    // their faces out a few millimetres along the normals so they never share a plane with it (no z-fighting);
    // the smaller the part, the further, so a detail on a detail still wins.
    let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
    for (let i = 0; i < n * 3; i += 3) {
      const x = gp[i], y = gp[i + 1], z = gp[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const lo = Math.min(x1 - x0, y1 - y0, z1 - z0), hi = Math.max(x1 - x0, y1 - y0, z1 - z0);
    if (lo < 0.1 && n <= 600) {
      const eps = 0.0025 + 0.004 * (1 - Math.min(1, hi / 1.2));
      for (let i = 0; i < n * 3; i++) pos[o + i] += gn[i] * eps;
    }
    o += n * 3;
    g.dispose();
  }
  if (dy) for (let i = 1; i < pos.length; i += 3) pos[i] += dy;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/**
 * @typedef {Object} PaintScheme
 * @property {number[]} base     main paint (several entries = camouflage)
 * @property {number} [belly]    secondary paint (PAINT2 faces), e.g. aircraft undersides
 * @property {number} [scale]    camouflage blotch size (m)
 * @property {number} team       team marking colour
 * @property {number} [seed]
 */

const _k = new THREE.Color();
const _keys = { paint: new THREE.Color(PAINT), paint2: new THREE.Color(PAINT2), team: new THREE.Color(TEAM) };
const near = (a, r, g, b) => Math.abs(a.r - r) + Math.abs(a.g - g) + Math.abs(a.b - b) < 0.004;
const hash = (n) => { n = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); return ((n ^ (n >>> 15)) >>> 0) / 4294967296; };

/**
 * Replaces sentinel colours per triangle: body paint gets camouflage (or a
 * plain coat with subtle panel-to-panel variation), team markings get the
 * team colour, and every other face gets a faint jitter so flat panels read.
 * @param {THREE.BufferGeometry} geo @param {PaintScheme} scheme
 */
export function finish(geo, scheme) {
  const pos = geo.attributes.position.array, col = /** @type {Float32Array} */ (geo.attributes.color.array);
  const nrm = geo.attributes.normal ? geo.attributes.normal.array : null;
  const camo = scheme.base.map((h) => new THREE.Color(h));
  const belly = new THREE.Color(scheme.belly ?? scheme.base[0]);
  const team = new THREE.Color(scheme.team);
  const scale = scheme.scale || 2.2, seed = scheme.seed || 7;
  for (let i = 0; i < col.length; i += 9) {
    const r = col[i], g = col[i + 1], b = col[i + 2];
    const cx = (pos[i] + pos[i + 3] + pos[i + 6]) / 3, cy = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3, cz = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3;
    const jitter = 0.95 + hash((i / 9) | 0) * 0.1;
    // Aircraft schemes paint every downward-facing body panel in the belly colour.
    const ny = nrm ? (nrm[i + 1] + nrm[i + 4] + nrm[i + 7]) / 3 : 0;
    if (near(_keys.paint, r, g, b) && scheme.belly !== undefined && ny < -0.35) _k.copy(belly).multiplyScalar(jitter);
    else if (near(_keys.paint, r, g, b)) {
      if (camo.length === 1) _k.copy(camo[0]);
      else {
        const v = noise2(cx / scale + cy * 0.3, cz / scale - cy * 0.2, seed) * 0.7 + noise2(cz / (scale * 0.5), cx / (scale * 0.5) + cy, seed + 3) * 0.3;
        const idx = Math.min(camo.length - 1, Math.max(0, Math.floor((v * 0.5 + 0.5) * camo.length * 1.15 - 0.07)));
        _k.copy(camo[idx]);
      }
      _k.multiplyScalar(jitter);
    } else if (near(_keys.paint2, r, g, b)) _k.copy(belly).multiplyScalar(jitter);
    else if (near(_keys.team, r, g, b)) _k.copy(team);
    else { _k.setRGB(r, g, b); _k.multiplyScalar(0.97 + (jitter - 0.95) * 0.6); }
    for (let k = 0; k < 9; k += 3) { col[i + k] = _k.r; col[i + k + 1] = _k.g; col[i + k + 2] = _k.b; }
  }
  // Baked ambient occlusion and panel shading (imported models carry it per vertex).
  const ao = geo.attributes.ao ? geo.attributes.ao.array : null;
  if (ao) for (let v = 0; v < ao.length; v++) { col[v * 3] *= ao[v]; col[v * 3 + 1] *= ao[v]; col[v * 3 + 2] *= ao[v]; }
  geo.attributes.color.needsUpdate = true;
  return geo;
}

/** A road wheel / tyre centred on the origin, rotating about X. */
export function wheelGeo(r, w, seg, tyre, hub, hubR = 0.55) {
  return merge([
    tubeX(r, w, 0, 0, 0, seg, tyre),
    tubeX(r * hubR, w + 0.03, 0, 0, 0, Math.max(6, seg - 4), hub),
    tubeX(r * 0.18, w + 0.08, 0, 0, 0, 6, STEEL),
  ]);
}

/**
 * Tracked running gear for one side (mirror it for the other): track loop,
 * road wheels, drive sprocket, idler and return rollers.
 * @param {{x:number, w:number, zs:number[], r:number, zRear:number, zFront:number, top:number, sprocketY?:number, idlerY?:number, rollers?:number[], wheelColor?:number}} o
 */
export function runningGear(o) {
  const { x, w, zs, r, zRear, zFront, top: yTop } = o;
  const sy = o.sprocketY ?? yTop - 0.3, iy = o.idlerY ?? yTop - 0.32;
  const zMin = Math.min(...zs), zMax = Math.max(...zs);
  const loop = [
    [zRear - 0.34, sy], [zRear, yTop], [zFront, yTop], [zFront + 0.34, iy],
    [zMax + r * 0.55, 0.02], [zMin - r * 0.55, 0.02],
  ];
  const parts = [side(loop, w * 0.86, TRACK, x)];
  const wc = o.wheelColor ?? PAINT;
  for (const z of zs) {
    parts.push(tubeX(r, w * 0.98, x, r, z, 12, RUBBER), tubeX(r * 0.82, w + 0.04, x, r, z, 12, wc), tubeX(r * 0.25, w + 0.1, x, r, z, 6, STEEL));
  }
  parts.push(tubeX(0.3, w + 0.02, x, sy, zRear - 0.08, 9, DARK), tubeX(0.27, w + 0.02, x, iy, zFront + 0.06, 9, wc));
  for (const z of o.rollers || []) parts.push(tubeX(0.11, w * 0.5, x, yTop - 0.06, z, 6, wc));
  return parts;
}

/** Five-pointed star outline ([u, v]) for markings. */
export function star(r, cu = 0, cv = 0) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i / 10) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.42;
    pts.push([cu + Math.cos(a) * rr, cv + Math.sin(a) * rr]);
  }
  return pts;
}

/**
 * Smooth-ish body lofted through cross-section stations along Z (aircraft
 * fuselages, nacelles, pods, canopies). Each station is [z, halfWidth, yBottom,
 * yTop]; sections are rounded rectangles (superellipses) of `segs` points.
 * @param {number[][]} stations ordered front to back or back to front
 * @param {number} [x] lateral offset
 * @param {number} [squareness] 2 = ellipse, higher = boxier
 */
export function fuselage(stations, color, x = 0, segs = 10, squareness = 2.6) {
  const ring = (st) => {
    const [z, hw, y0, y1] = st;
    const cy = (y0 + y1) / 2, hh = (y1 - y0) / 2;
    const pts = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const k = 2 / squareness;
      pts.push([x + Math.sign(c) * Math.abs(c) ** k * hw, cy + Math.sign(s) * Math.abs(s) ** k * hh, z]);
    }
    return pts;
  };
  const rings = stations.map(ring);
  const out = [];
  // Orient every triangle away from the local axis so the winding is always outward.
  const push = (p, q, r, axis) => {
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (p[0] + q[0] + r[0]) / 3 - axis[0], my = (p[1] + q[1] + r[1]) / 3 - axis[1], mz = (p[2] + q[2] + r[2]) / 3 - axis[2];
    if (nx * mx + ny * my + nz * mz < 0) out.push(...p, ...r, ...q); else out.push(...p, ...q, ...r);
  };
  for (let s = 0; s < rings.length - 1; s++) {
    const A = rings[s], B = rings[s + 1];
    const zc = (stations[s][0] + stations[s + 1][0]) / 2;
    const yc = (stations[s][2] + stations[s][3] + stations[s + 1][2] + stations[s + 1][3]) / 4;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      push(A[i], A[j], B[j], [x, yc, zc]);
      push(A[i], B[j], B[i], [x, yc, zc]);
    }
  }
  for (const [k, nb] of [[0, 1], [rings.length - 1, rings.length - 2]]) {
    const R = rings[k], st = stations[k];
    const c = [x, (st[2] + st[3]) / 2, st[0]];
    // A point just inside the body, toward the neighbouring station.
    const inner = [x, c[1], st[0] + Math.sign(stations[nb][0] - st[0]) * 0.05];
    for (let i = 0; i < segs; i++) push(c, R[i], R[(i + 1) % segs], inner);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  geo.computeVertexNormals();
  return paint(geo, color);
}

/** Rotor or propeller: `blades` flat blades of length r around the origin (spins about Y). */
export function rotorGeo(blades, r, chord, color, hubColor = STEEL, droop = 0.03) {
  const parts = [cyl(0.16, 0.2, 0.3, 8, 0, 0, 0, hubColor)];
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2;
    parts.push(place(box(chord, 0.05, r, 0, 0, 0, color), Math.sin(a) * r / 2, -droop, Math.cos(a) * r / 2, 0, a, 0));
  }
  return parts;
}
