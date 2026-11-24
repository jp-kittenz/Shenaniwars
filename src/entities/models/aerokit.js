import {
  PAINT, TEAM, DARK, STEEL, RUBBER, GLASS, LENS,
  box, cyl, tubeX, tubeZ, sphere, cone, loft, mirror, place, fuselage, merge,
} from './kit.js';
import * as THREE from 'three';
import { INT } from './cabs.js';
import { paint } from './kit.js';

/**
 * Aircraft kit (ground coordinates, +Z forward, +X left): airfoil-section wings, stabilisers and fins, fuselages
 * with matching canopy frames, rotor heads and blades, propellers, deep cockpit tubs with ejection seats and
 * instrument panels, two-pilot flight decks, and troop / cargo cabins (floor, frames, fold-down seats, overhead
 * services) for helicopters and transports.
 */

export const COCKPIT = 0x2b2f33, COCKPIT2 = 0x363b40, SEAT = 0x3b4036, SEATPAD = 0x4b5142, HANDLE = 0xd6ae2a, MFD = 0x2f7a5c, MFD2 = 0x6f8f3e;
export const CABIN = 0x8a8f86, CABIN2 = 0x6f746c, FLOOR = 0x3a3d3a, WEB = 0xa0362c, NAV_L = 0xd02a20, NAV_R = 0x1fa04a;

/** Tags geometries as cabin / cockpit furniture (model checks use it; harmless at runtime). */
export const tagInterior = (parts) => { for (const g of parts) g.userData.interior = true; return parts; };

// ------------------------------------------------------------------ sections and surfaces

/** NACA 00xx half thickness at chord fraction u (t = thickness / chord). */
const yt = (u, t) => 5 * t * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
const US = [0, 0.03, 0.1, 0.22, 0.38, 0.55, 0.72, 0.88, 1];

/** Airfoil outline in the side plane: [z, y] points, leading edge at zLE, chord c (toward -z), thickness t·c. */
export function airfoil(zLE, c, yc, t, camber = 0) {
  const up = US.map((u) => [zLE - u * c, yc + yt(u, t) * c + camber * c * 4 * u * (1 - u)]);
  const lo = US.slice(1, -1).reverse().map((u) => [zLE - u * c, yc - yt(u, t) * c + camber * c * 4 * u * (1 - u)]);
  return [...up, ...lo];
}

/**
 * Wing / tailplane panel from x0 (root) to x1 (tip) on the +X side (mirror() it for the other side).
 * @param {{x0:number,x1:number,le0:number,c0:number,le1:number,c1:number,y0:number,y1:number,t0?:number,t1?:number,camber?:number,color?:number}} o
 */
export function wing(o) {
  return loft(airfoil(o.le0, o.c0, o.y0, o.t0 ?? 0.12, o.camber ?? 0), airfoil(o.le1, o.c1, o.y1, o.t1 ?? 0.09, o.camber ?? 0), 'side', o.x0, o.x1, o.color ?? PAINT);
}

/** Hinge / panel line on a wing panel's upper surface at chord fraction f (between span fractions s0..s1). */
export function wingLine(o, f, s0 = 0, s1 = 1, color = DARK) {
  const at = (s) => {
    const le = o.le0 + (o.le1 - o.le0) * s, c = o.c0 + (o.c1 - o.c0) * s, y = o.y0 + (o.y1 - o.y0) * s, t = (o.t0 ?? 0.12) + ((o.t1 ?? 0.09) - (o.t0 ?? 0.12)) * s;
    const z = le - f * c, yy = y + yt(f, t) * c + 0.004;
    return [[z - 0.015, yy], [z - 0.015, yy + 0.012], [z + 0.015, yy + 0.012], [z + 0.015, yy]];
  };
  return loft(at(s0), at(s1), 'side', o.x0 + (o.x1 - o.x0) * s0, o.x0 + (o.x1 - o.x0) * s1, color);
}

/**
 * Vertical fin from y0 (root) to y1 (tip) at lateral position x, canted outward by `cant` (radians, about z).
 * @param {{x:number,y0:number,y1:number,le0:number,c0:number,le1:number,c1:number,t0?:number,t1?:number,cant?:number,color?:number}} o
 */
export function fin(o) {
  const sec = (le, c, t) => airfoil(le, c, 0, t).map(([z, y]) => [y, z]);
  const g = loft(sec(o.le0, o.c0, o.t0 ?? 0.1), sec(o.le1, o.c1, o.t1 ?? 0.08).map(([x, z]) => [x + (o.lean ?? 0), z]), 'top', o.y0, o.y1, o.color ?? PAINT);
  if (o.cant) { g.translate(0, -o.y0, 0); g.rotateZ(o.cant); g.translate(0, o.y0, 0); }
  return g.translate(o.x, 0, 0);
}

/** Point on a fuselage section (superellipse) at angle a, matching kit.fuselage(). */
function sectionPoint(st, a, sq, x = 0) {
  const [, hw, y0, y1] = st, cy = (y0 + y1) / 2, hh = (y1 - y0) / 2, k = 2 / sq, c = Math.cos(a), s = Math.sin(a);
  return [x + Math.sign(c) * Math.abs(c) ** k * hw, cy + Math.sign(s) * Math.abs(s) ** k * hh];
}

/** Station interpolated at z. */
export function stationAt(st, z) {
  const s = st.slice().sort((a, b) => a[0] - b[0]);
  if (z <= s[0][0]) return s[0];
  for (let i = 0; i < s.length - 1; i++) if (z <= s[i + 1][0]) {
    const k = (z - s[i][0]) / (s[i + 1][0] - s[i][0]);
    return s[i].map((v, j) => v + (s[i + 1][j] - v) * k);
  }
  return s[s.length - 1];
}

/** Half width of a fuselage (superellipse sections) at height y and position z. */
export function halfWidthAt(st, z, y, sq = 2.6) {
  const [, hw, y0, y1] = stationAt(st, z), cy = (y0 + y1) / 2, hh = (y1 - y0) / 2;
  const v = Math.min(1, Math.abs((y - cy) / hh));
  return hw * Math.max(0, 1 - v ** sq) ** (1 / sq);
}

/**
 * Frame ring (canopy bow, panel joint) following a fuselage / canopy section at z: thin members between section
 * points over angles a0..a1 (0 = +X side, π/2 = top).
 */
export function ring(st, z, o = {}) {
  const sq = o.sq ?? 2.6, segs = o.segs ?? 14, a0 = o.a0 ?? 0, a1 = o.a1 ?? Math.PI, w = o.w ?? 0.05, d = o.d ?? 0.05, grow = o.grow ?? 0.012;
  const s = stationAt(st, z), st2 = [z, s[1] + grow, s[2] - grow, s[3] + grow];
  const out = [];
  for (let i = 0; i < segs; i++) {
    const p = sectionPoint(st2, a0 + ((a1 - a0) * i) / segs, sq, o.x ?? 0), q = sectionPoint(st2, a0 + ((a1 - a0) * (i + 1)) / segs, sq, o.x ?? 0);
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    out.push(box(len + w * 0.6, w, d, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, z, o.color ?? DARK, 0, 0, Math.atan2(q[1] - p[1], q[0] - p[0])));
  }
  return out;
}

/** Longitudinal frame member along a canopy / fuselage at section angle a from z0 to z1 (follows the stations). */
export function stringer(st, z0, z1, a, o = {}) {
  const sq = o.sq ?? 2.6, n = o.n ?? 6, w = o.w ?? 0.045, out = [];
  for (let i = 0; i < n; i++) {
    const za = z0 + ((z1 - z0) * i) / n, zb = z0 + ((z1 - z0) * (i + 1)) / n;
    const sa = stationAt(st, za), sb = stationAt(st, zb), g = o.grow ?? 0.012;
    const p = sectionPoint([za, sa[1] + g, sa[2] - g, sa[3] + g], a, sq, o.x ?? 0), q = sectionPoint([zb, sb[1] + g, sb[2] - g, sb[3] + g], a, sq, o.x ?? 0);
    const dz = zb - za, dy = q[1] - p[1], dx = q[0] - p[0], len = Math.hypot(dx, dy, dz);
    out.push(place(box(w, w, len + w * 0.5, 0, 0, 0, o.color ?? DARK), (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (za + zb) / 2, -Math.atan2(dy, Math.hypot(dz, dx)), Math.atan2(dx, dz), 0));
  }
  return out;
}

// ------------------------------------------------------------------ rotors and propellers

/**
 * Main rotor: hub with blade grips, lag dampers, pitch links and swashplate; blades with an airfoil section and a
 * slight droop. Spins about Y at its node.
 */
export function rotor(blades, r, chord, o = {}) {
  const col = o.color ?? DARK, droop = o.droop ?? 0.03, hubR = o.hub ?? Math.max(0.22, r * 0.035), out = [];
  out.push(cyl(hubR, hubR * 1.1, hubR * 0.9, 12, 0, 0, 0, STEEL), cyl(hubR * 0.6, hubR * 0.6, hubR * 1.6, 10, 0, hubR * 0.3, 0, DARK),
    cyl(hubR * 1.4, hubR * 1.4, 0.06, 14, 0, -hubR * 1.4, 0, STEEL), cyl(hubR * 1.1, hubR * 1.1, 0.05, 14, 0, -hubR * 1.6, 0, DARK)); // swashplate
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2, parts = [];
    parts.push(box(hubR * 1.2, 0.12, 0.16, hubR * 1.1, 0, 0, STEEL), box(0.06, 0.06, 0.36, hubR * 1.3, -0.08, 0.15, DARK), // grip + damper
      cyl(0.02, 0.02, hubR * 1.4, 5, hubR * 0.9, -hubR * 0.75, -0.12, STEEL)); // pitch link
    const b = wing({ x0: hubR * 1.6, x1: r, le0: chord * 0.4, c0: chord, le1: chord * 0.4, c1: chord * 0.92, y0: 0, y1: -droop * r * 0.3, t0: 0.12, t1: 0.09, color: col });
    parts.push(b, box(0.05, 0.03, chord * 0.9, r - 0.06, -droop * r * 0.3 + 0.025, chord * 0.4 - chord * 0.45, o.tip ?? 0xc9c2a6));
    for (const p of parts) out.push(p.rotateY(a));
  }
  return out;
}

/** Tail rotor / propeller about the X axis (tail rotor) — built about Y, then rotated by the caller. */
export function smallRotor(blades, r, chord, color = DARK) {
  const out = [cyl(0.12, 0.12, 0.22, 10, 0, 0, 0, STEEL), cone(0.11, 0.18, 10, 0, 0.18, 0, STEEL)];
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2;
    out.push(wing({ x0: 0.1, x1: r, le0: chord * 0.45, c0: chord, le1: chord * 0.45, c1: chord * 0.8, y0: 0, y1: 0, t0: 0.12, t1: 0.1, color }).rotateY(a));
  }
  return out;
}

/** Turboprop propeller (axis +Z): spinner and twisted blades. */
export function propeller(blades, r, chord) {
  const out = [cone(0.42, 0.9, 14, 0, 0, 0.25, STEEL, Math.PI / 2), cyl(0.42, 0.42, 0.35, 14, 0, 0, -0.1, STEEL, Math.PI / 2)];
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2;
    const b = wing({ x0: 0.35, x1: r, le0: chord * 0.5, c0: chord, le1: chord * 0.3, c1: chord * 0.55, y0: 0, y1: 0, t0: 0.12, t1: 0.08, color: DARK });
    b.rotateZ(0.35); // blade pitch
    const tip = box(0.12, 0.02, chord * 0.5, r - 0.06, 0, chord * 0.1, 0xd8c040);
    tip.rotateZ(0.35);
    for (const g of [b, tip]) { g.rotateX(Math.PI / 2); g.rotateZ(a); out.push(g); }
  }
  return out;
}

// ------------------------------------------------------------------ small details

export const navLights = (x, y, z) => [sphere(0.07, x, y, z, NAV_L), sphere(0.07, -x, y, z, NAV_R)];
export const pitot = (z0, z1, y, x = 0) => [tubeZ(0.03, 0.015, z0, z1, x, y, 6, STEEL)];
export const antenna = (x, y, z, h = 0.35) => [box(0.02, h, 0.12, x, y + h / 2, z, DARK, 0.4)];
export const starMark = (x, y, z, r, side = 1) => [place(cyl(r, r, 0.02, 5, 0, 0, 0, TEAM), x, y, z, 0, 0, side * Math.PI / 2)];

/** Helicopter fixed gear leg with oleo, brace and wheel (ground at y = 0). */
export function heliLeg(x, z, r, top, o = {}) {
  const w = o.w ?? 0.22;
  return [box(0.1, top - r, 0.1, x, (top + r) / 2, z, STEEL), cyl(0.06, 0.06, (top - r) * 0.5, 8, x, r + (top - r) * 0.3, z, INT.CHROME),
    box(Math.abs(x) * 0.8, 0.06, 0.06, x * 0.6, top - 0.1, z, DARK, 0, 0, Math.sign(x) * -0.35),
    tubeX(r, w, x, r, z, 14, RUBBER), tubeX(r * 0.55, w + 0.02, x, r, z, 10, STEEL)];
}

// ------------------------------------------------------------------ cockpits

/**
 * K-36DM ejection seat: bucket with survival pack, backrest with the parachute container, headbox, harness straps,
 * side rails, yellow / black firing handles.
 */
export function ejectionSeat(x, y, z) {
  const p = [
    box(0.5, 0.18, 0.48, x, y - 0.09, z, SEAT), box(0.42, 0.06, 0.42, x, y + 0.02, z + 0.01, SEATPAD),
    box(0.5, 0.76, 0.18, x, y + 0.38, z - 0.3, SEAT, -0.22), box(0.4, 0.6, 0.06, x, y + 0.36, z - 0.2, SEATPAD, -0.22),
    box(0.38, 0.24, 0.24, x, y + 0.84, z - 0.42, SEAT, -0.22), box(0.32, 0.14, 0.05, x, y + 0.82, z - 0.3, SEATPAD, -0.22),
    box(0.18, 0.06, 0.1, x, y + 0.96, z - 0.46, HANDLE, -0.22), // face-curtain / headbox top
  ];
  for (const s of [-1, 1]) {
    p.push(box(0.05, 0.92, 0.08, x + s * 0.22, y + 0.4, z - 0.36, STEEL, -0.22),
      box(0.05, 0.5, 0.012, x + s * 0.1, y + 0.33, z - 0.16, 0xb8b29a, -0.22), // shoulder straps
      box(0.04, 0.1, 0.18, x + s * 0.25, y + 0.08, z + 0.12, HANDLE), box(0.045, 0.03, 0.05, x + s * 0.25, y + 0.14, z + 0.12, DARK));
  }
  p.push(box(0.16, 0.04, 0.05, x, y + 0.03, z + 0.26, HANDLE), box(0.04, 0.12, 0.04, x - 0.07, y + 0.08, z + 0.26, DARK), box(0.04, 0.12, 0.04, x + 0.07, y + 0.08, z + 0.26, DARK));
  return p;
}

function mfd(x, y, z, w, h, color, tilt) {
  const p = [box(w + 0.07, h + 0.07, 0.045, x, y, z, COCKPIT, tilt), box(w, h, 0.01, x, y, z - 0.025, color, tilt)];
  for (let i = 0; i < 5; i++) p.push(box(0.022, 0.018, 0.012, x - w / 2 + (i + 0.5) * (w / 5), y - h / 2 - 0.022, z - 0.024, 0xbab7aa, tilt), box(0.018, 0.022, 0.012, x - w / 2 - 0.025, y - h / 2 + (i + 0.5) * (h / 5), z - 0.024, 0xbab7aa, tilt));
  return p;
}

function dial(x, y, z, r, tilt = 0) {
  return [cyl(r, r, 0.02, 14, x, y, z, INT.GAUGE, Math.PI / 2 + tilt), cyl(r * 1.25, r * 1.25, 0.02, 14, x, y, z + 0.012, COCKPIT, Math.PI / 2 + tilt), box(r * 0.9, 0.01, 0.01, x + r * 0.2, y + r * 0.15, z - 0.014, DARK, tilt, 0, 0.7)];
}

/**
 * Fighter / trainer cockpit in a fuselage opened with cutFuselage(st, z0, z1, floor): tub side walls following the
 * fuselage skin from the floor to the sill, sill rails, consoles, a shaped instrument panel with displays and dials
 * under a glareshield with the HUD, rear bulkhead; the ejection seat; the stick and throttle are controls.
 * @param {number[][]} st fuselage stations @param {{x?:number,y:number,z:number}} seatP seat surface (ground)
 * @param {{z0:number,z1:number,floor:number,sill:number,panelZ:number,sq?:number,hud?:boolean}} o
 */
export function jetTub(st, seatP, o) {
  const p = [], glass = [], sq = o.sq ?? 2.6, x = seatP.x ?? 0;
  const { z0, z1, floor, sill } = o;
  // tub walls along the skin, with frame ribs
  const n = o.walls === false ? 0 : Math.max(4, Math.round((z1 - z0) / 0.35));
  for (let i = 0; i < n; i++) {
    const za = z0 + 0.05 + ((z1 - z0 - 0.1) * i) / n, zb = z0 + 0.05 + ((z1 - z0 - 0.1) * (i + 1)) / n;
    const w = halfWidthAt(st, (za + zb) / 2, sill - 0.05, sq) - 0.06;
    for (const s of [-1, 1]) {
      p.push(box(0.03, sill - floor, zb - za + 0.01, s * w, (sill + floor) / 2, (za + zb) / 2, COCKPIT2));
      if (i % 2 === 0) p.push(box(0.04, sill - floor, 0.04, s * (w - 0.02), (sill + floor) / 2, za, COCKPIT));
      p.push(box(0.07, 0.04, zb - za + 0.01, s * (w + 0.01), sill - 0.01, (za + zb) / 2, DARK)); // sill rail
    }
  }
  p.push(box(halfWidthAt(st, z0 + 0.05, sill, sq) * 2 - 0.1, sill - floor - 0.02, 0.04, 0, (sill + floor) / 2 - 0.01, z0 + 0.05, COCKPIT2)); // rear bulkhead
  p.push(box(halfWidthAt(st, z1 - 0.05, sill, sq) * 2 - 0.1, sill - floor, 0.04, 0, (sill + floor) / 2, z1 - 0.05, COCKPIT2)); // front bulkhead
  p.push(...ejectionSeat(x, seatP.y, seatP.z));
  // consoles: left with the throttle quadrant, right with panels; switch rows
  const wz = halfWidthAt(st, seatP.z, sill - 0.05, sq) - 0.1;
  for (const s of [-1, 1]) {
    const cx = x + s * Math.min(0.33, wz - 0.06);
    p.push(box(0.16, sill - floor - 0.12, 0.9, cx, (sill + floor) / 2 - 0.06, seatP.z + 0.12, COCKPIT));
    for (let i = 0; i < 4; i++) p.push(box(0.13, 0.012, 0.16, cx, sill - 0.17, seatP.z - 0.2 + i * 0.21, i % 2 ? COCKPIT2 : 0x4a4f53), box(0.02, 0.03, 0.02, cx + 0.03, sill - 0.15, seatP.z - 0.2 + i * 0.21, INT.GAUGE));
  }
  p.push(box(0.08, 0.05, 0.26, x + Math.min(0.33, wz - 0.06), sill - 0.15, seatP.z - 0.02, DARK));
  // instrument panel: centre section with two MFDs, angled wings with dials, glareshield and HUD
  // the panel, glareshield and HUD fit under the canopy (o.cw: canopy half width at (z, y); o.top: canopy top at z)
  const pz = o.panelZ, top = o.top ? o.top(pz + 0.12) : sill + 0.6;
  const pw = Math.min(0.46, halfWidthAt(st, pz, sill, sq) - 0.08, o.cw ? o.cw(pz + 0.2, sill + 0.15) - 0.1 : 1);
  const ph = Math.min(0.42, Math.max(0.24, (top - 0.16 - sill) * 2 + 0.1)), py = sill - 0.05, tilt = -0.25;
  p.push(box(pw * 1.2, ph, 0.08, x, py, pz, COCKPIT, tilt));
  const wx = Math.min(pw * 0.78, (o.cw ? o.cw(pz - 0.14, py + 0.06) : pw) - 0.12, halfWidthAt(st, pz - 0.14, py, sq) - 0.12);
  if (wx > 0.3) for (const s of [-1, 1]) p.push(box(Math.min(pw * 0.45, wx * 0.5), ph * 0.8, 0.08, x + s * wx, py - 0.03, pz - 0.08, COCKPIT, tilt, s * 0.45, 0), ...dial(x + s * wx, py + 0.02, pz - 0.14, 0.035, tilt));
  const mx = Math.min(0.14, Math.max(0.085, (o.cw ? o.cw(pz - 0.05, py + 0.1) : 0.4) - 0.17)), mw = Math.min(0.17, mx * 2 - 0.08);
  p.push(...mfd(x - mx, py + 0.04, pz - 0.055, mw, 0.15, MFD, tilt), ...mfd(x + mx, py + 0.04, pz - 0.055, mw, 0.15, MFD2, tilt));
  p.push(...dial(x, py - 0.13, pz - 0.06, 0.035, tilt), ...dial(x - 0.1, py - 0.15, pz - 0.06, 0.028, tilt), ...dial(x + 0.1, py - 0.15, pz - 0.06, 0.028, tilt));
  p.push(box(pw * 1.9, 0.05, 0.22, x, py + ph / 2 + 0.03, pz + 0.04, COCKPIT), box(pw * 1.9, 0.03, 0.05, x, py + ph / 2 + 0.01, pz - 0.06, DARK));
  if (o.hud !== false && py + ph / 2 + 0.32 < top - 0.04) {
    p.push(box(0.2, 0.1, 0.18, x, py + ph / 2 + 0.09, pz + 0.02, DARK));
    glass.push(box(0.17, 0.15, 0.008, x, py + ph / 2 + 0.22, pz - 0.02, GLASS, -0.35));
    p.push(box(0.015, 0.16, 0.015, x - 0.095, py + ph / 2 + 0.22, pz - 0.02, DARK, -0.35), box(0.015, 0.16, 0.015, x + 0.095, py + ph / 2 + 0.22, pz - 0.02, DARK, -0.35));
  }
  // rudder pedals and floor
  for (const s of [-1, 1]) p.push(box(0.1, 0.16, 0.04, x + s * 0.13, floor + 0.12, seatP.z + 0.72, RUBBER, -0.5));
  p.push(box(0.6, 0.02, z1 - z0 - 0.2, 0, floor + 0.01, (z0 + z1) / 2, FLOOR));
  return { parts: tagInterior(p), glass, stick: { kind: 'stick', x, y: seatP.y - 0.12, z: seatP.z + 0.34 } };
}

/**
 * Two-pilot flight deck (helicopter / transport): armoured seats with harness, wide instrument panel shaped to the
 * nose, glareshield, centre pedestal with levers, overhead console, side consoles, pedals; copilot controls static.
 */
export function flightDeck(seats, o) {
  const p = [], { sill, w, zPanel, floor } = o;
  for (const q of seats) {
    p.push(box(0.5, 0.12, 0.48, q.x, q.y - 0.06, q.z, SEAT), box(0.44, 0.05, 0.42, q.x, q.y + 0.01, q.z, SEATPAD),
      box(0.5, 0.68, 0.12, q.x, q.y + 0.35, q.z - 0.28, SEAT, -0.15), box(0.42, 0.55, 0.04, q.x, q.y + 0.35, q.z - 0.22, SEATPAD, -0.15),
      box(0.3, 0.16, 0.1, q.x, q.y + 0.74, q.z - 0.34, SEATPAD, -0.15), box(0.56, 0.62, 0.05, q.x, q.y + 0.32, q.z - 0.36, 0x4c5248, -0.15), // armour plate
      box(0.36, q.y - 0.12 - floor, 0.36, q.x, (q.y - 0.12 + floor) / 2, q.z, DARK));
    for (const s of [-1, 1]) p.push(box(0.05, 0.5, 0.012, q.x + s * 0.1, q.y + 0.35, q.z - 0.2, 0xb8b29a, -0.15));
    for (const s of [-1, 1]) p.push(box(0.1, 0.14, 0.04, q.x + s * 0.12, floor + 0.13, q.z + 0.75, RUBBER, -0.5));
  }
  const ph = 0.45, py = sill + 0.05;
  p.push(box(w - 0.2, ph, 0.12, 0, py, zPanel, COCKPIT, -0.12), box(w - 0.2, 0.05, 0.24, 0, py + ph / 2 + 0.02, zPanel + 0.06, COCKPIT), box(w - 0.2, 0.03, 0.05, 0, py + ph / 2, zPanel - 0.06, DARK));
  const lim = w / 2 - 0.16, cx = (v) => Math.max(-lim, Math.min(lim, v));
  for (const q of seats) p.push(...mfd(cx(q.x - 0.12), py + 0.06, zPanel - 0.075, 0.18, 0.16, MFD, -0.12), ...mfd(cx(q.x + 0.12), py + 0.06, zPanel - 0.075, 0.18, 0.16, MFD2, -0.12),
    ...dial(cx(q.x - 0.12), py - 0.13, zPanel - 0.07, 0.035, -0.12), ...dial(cx(q.x + 0.12), py - 0.13, zPanel - 0.07, 0.035, -0.12));
  p.push(...mfd(0, py + 0.02, zPanel - 0.075, 0.16, 0.14, MFD, -0.12));
  // centre pedestal with levers
  const pl = Math.max(0.5, zPanel - Math.min(...seats.map((q) => q.z)) - 0.1);
  p.push(box(0.32, py - floor - 0.15, pl, 0, (py - 0.15 + floor) / 2, zPanel - pl / 2 - 0.05, COCKPIT));
  for (let i = 0; i < 3; i++) p.push(box(0.26, 0.012, 0.12, 0, py - 0.14, zPanel - 0.25 - i * 0.18, i % 2 ? 0x4a4f53 : COCKPIT2));
  for (const s of [-1, 0, 1]) p.push(box(0.025, 0.16, 0.025, s * 0.07, py - 0.07, zPanel - 0.75, STEEL), box(0.05, 0.04, 0.05, s * 0.07, py + 0.02, zPanel - 0.75, s ? RUBBER : HANDLE));
  if (o.yRoof) p.push(box(0.5, 0.08, 0.75, 0, o.yRoof - 0.06, zPanel - 0.4, COCKPIT), ...[0, 1, 2].map((i) => box(0.42, 0.012, 0.12, 0, o.yRoof - 0.105, zPanel - 0.18 - i * 0.22, 0x4a4f53)),
    ...[0, 1, 2, 3, 4].map((i) => box(0.02, 0.035, 0.02, -0.16 + i * 0.08, o.yRoof - 0.12, zPanel - 0.18, INT.GAUGE)));
  for (const q of seats.slice(1)) p.push(cyl(0.018, 0.024, 0.5, 6, q.x, q.y + 0.2, q.z + 0.3, DARK), box(0.05, 0.11, 0.06, q.x, q.y + 0.48, q.z + 0.3, RUBBER), box(0.04, 0.04, 0.42, q.x + 0.3, q.y + 0.02, q.z - 0.15, DARK));
  const d = seats[0];
  return { parts: tagInterior(p), stick: { kind: 'cyclic', x: d.x, y: d.y - 0.1, z: d.z + 0.3 } };
}

/**
 * Troop / cargo cabin interior between z0 (rear) and z1 (front): floor with tie-down rails, side wall lining with
 * frames, ceiling with longerons and overhead pipes / cable runs, dome lamps, fold-down troop seats (red webbing on
 * tube frames) along both walls facing inward, a fire extinguisher and first-aid box on the front bulkhead.
 * `wallX(z, y)` gives the inner half-width.
 */
export function cabin(o) {
  const { z0, z1, floor, roof } = o, p = [];
  const hw = (z, y) => o.wallX(z, y);
  p.push(box(hw((z0 + z1) / 2, floor + 0.1) * 2 - 0.05, 0.04, z1 - z0, 0, floor, (z0 + z1) / 2, FLOOR));
  for (const x of [-0.45, 0.45]) p.push(box(0.05, 0.02, z1 - z0 - 0.1, x, floor + 0.03, (z0 + z1) / 2, STEEL));
  for (let z = z0 + 0.4; z < z1 - 0.2; z += 0.55) for (const x of [-0.45, 0.45]) p.push(cyl(0.03, 0.03, 0.03, 6, x, floor + 0.04, z, DARK));
  const yMid = (floor + roof) / 2, n = Math.max(3, Math.round((z1 - z0) / 0.6));
  for (let i = 0; i <= n; i++) {
    const z = z0 + ((z1 - z0) * i) / n;
    for (const s of [-1, 1]) {
      // wall lining panels + frame
      const yq = floor + (roof - floor) * 0.33, yr = floor + (roof - floor) * 0.66;
      for (const [ya, yb] of [[floor + 0.05, yq], [yq, yr], [yr, roof - 0.15]]) {
        const w = Math.min(hw(z, ya), hw(z, yb), hw(z + (z1 - z0) / n, ya), hw(z + (z1 - z0) / n, yb)) - 0.05;
        if (i < n) p.push(box(0.025, yb - ya, (z1 - z0) / n - 0.02, s * w, (ya + yb) / 2, z + (z1 - z0) / n / 2, i % 2 ? CABIN : CABIN2));
        p.push(box(0.06, yb - ya, 0.06, s * (w - 0.02), (ya + yb) / 2, z, CABIN2));
      }
    }
    p.push(box(hw(z, roof) * 2 - 0.1, 0.05, 0.06, 0, roof - 0.12, z, CABIN2));
  }
  p.push(box(hw((z0 + z1) / 2, roof) * 2 - 0.12, 0.025, z1 - z0, 0, roof - 0.1, (z0 + z1) / 2, CABIN));
  for (const s of [-1, 1]) p.push(tubeZ(0.03, 0.03, z0 + 0.1, z1 - 0.1, s * 0.35, roof - 0.18, 6, STEEL), tubeZ(0.02, 0.02, z0 + 0.1, z1 - 0.1, s * 0.2, roof - 0.16, 6, 0x7a4a2a));
  for (let z = z0 + 0.8; z < z1 - 0.3; z += 1.8) p.push(box(0.22, 0.04, 0.12, 0, roof - 0.14, z, INT.LAMP));
  // troop seats along both walls
  if (o.seats !== false) for (const s of [-1, 1]) {
    for (let z = z0 + 0.45; z < z1 - 0.3; z += 0.55) {
      const w = hw(z, floor + 0.45) - 0.08, sx = s * (w - 0.22);
      p.push(box(0.42, 0.03, 0.44, sx, floor + 0.45, z, WEB), box(0.03, 0.5, 0.4, s * (w - 0.02), floor + 0.75, z, WEB),
        box(0.025, 0.45, 0.025, sx - s * 0.2, floor + 0.22, z - 0.2, STEEL), box(0.025, 0.45, 0.025, sx - s * 0.2, floor + 0.22, z + 0.2, STEEL),
        box(0.44, 0.025, 0.025, sx, floor + 0.45, z - 0.21, STEEL), box(0.44, 0.025, 0.025, sx, floor + 0.45, z + 0.21, STEEL));
    }
    p.push(tubeZ(0.02, 0.02, z0 + 0.2, z1 - 0.2, s * (hw((z0 + z1) / 2, floor + 1.1) - 0.08), floor + 1.1, 6, STEEL)); // grab rail
  }
  // front bulkhead: extinguisher, first-aid box
  p.push(cyl(0.07, 0.07, 0.42, 8, 0.4, floor + 0.55, z1 - 0.1, 0xb02a22), box(0.3, 0.22, 0.1, -0.4, floor + 0.9, z1 - 0.08, 0xd6d6cc), box(0.08, 0.08, 0.02, -0.4, floor + 0.9, z1 - 0.14, 0xb02a22));
  return p;
}

// ------------------------------------------------------------------ hollow skins

/**
 * Hollow skin over part of a fuselage (outer skin, inner lining and glass), so cockpits and cabins sit inside a
 * real body. Two parametrisations:
 *  - mode 'side': a side wall on the +X side (sign 1) or -X side (sign -1) from height yA to yB, following the
 *    fuselage width at each height;
 *  - mode 'arc': a shell around the section from angle a0 to a1 (0 = +X side at mid height, π/2 = top, π = -X).
 * `holes` are window / door openings in (z, v) where v is the height (side) or the angle (arc); a hole with
 * `glass` is glazed. Returns { outer, inner, glass } geometries (null when empty).
 */
export function shell(st, o) {
  const sq = o.sq ?? 2.6, holes = o.holes || [], t = o.thick ?? 0.035;
  const uz = new Set([o.z0, o.z1]), uv = new Set([o.v0, o.v1]);
  const nz = Math.max(2, Math.ceil((o.z1 - o.z0) / (o.dz ?? 0.35))), nv = o.nv ?? 6;
  for (let i = 1; i < nz; i++) uz.add(o.z0 + ((o.z1 - o.z0) * i) / nz);
  for (let j = 1; j < nv; j++) uv.add(o.v0 + ((o.v1 - o.v0) * j) / nv);
  for (const h of holes) { for (const z of [h.z0, h.z1]) if (z > o.z0 && z < o.z1) uz.add(z); for (const v of [h.v0, h.v1]) if (v > Math.min(o.v0, o.v1) && v < Math.max(o.v0, o.v1)) uv.add(v); }
  const zs = [...uz].sort((a, b) => a - b), vs = [...uv].sort((a, b) => a - b);
  const sign = o.sign ?? 1;
  const pt = (z, v, inset) => {
    if (o.mode === 'side') {
      const w = halfWidthAt(st, z, v, sq) - inset;
      return [sign * Math.max(0.02, w) + (o.x ?? 0), v, z];
    }
    const s = stationAt(st, z), s2 = [z, s[1] - inset, s[2] + inset, s[3] - inset];
    let a = v;
    if (o.mode === 'band') { const aF = angleAt(st, z, o.yFloor, sq); a = aF + (Math.PI - 2 * aF) * v; }
    const [x, y] = sectionPoint(s2, a, sq, o.x ?? 0);
    return [x, y, z];
  };
  const out = [], inn = [], gl = [];
  const tri = (arr, a, b, c, ref, outward) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz2 = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz2 * vy, ny = uz2 * vx - ux * vz, nzz = ux * vy - uy * vx;
    const mx = (a[0] + b[0] + c[0]) / 3 - ref[0], my = (a[1] + b[1] + c[1]) / 3 - ref[1];
    const dot = nx * mx + ny * my;
    if ((dot >= 0) === outward) arr.push(...a, ...b, ...c); else arr.push(...a, ...c, ...b);
  };
  for (let i = 0; i < zs.length - 1; i++) for (let j = 0; j < vs.length - 1; j++) {
    const za = zs[i], zb = zs[i + 1], va = vs[j], vb = vs[j + 1], zc = (za + zb) / 2, vc = (va + vb) / 2;
    const h = holes.find((q) => zc > q.z0 && zc < q.z1 && vc > Math.min(q.v0, q.v1) && vc < Math.max(q.v0, q.v1));
    const sC = stationAt(st, zc), ref = [o.x ?? 0, (sC[2] + sC[3]) / 2];
    const A = pt(za, va, 0), B = pt(zb, va, 0), C = pt(zb, vb, 0), D = pt(za, vb, 0);
    if (h) {
      if (h.glass) { tri(gl, A, B, C, ref, true); tri(gl, A, C, D, ref, true); }
      continue;
    }
    tri(out, A, B, C, ref, true); tri(out, A, C, D, ref, true);
    const a2 = pt(za, va, t), b2 = pt(zb, va, t), c2 = pt(zb, vb, t), d2 = pt(za, vb, t);
    tri(inn, a2, b2, c2, ref, false); tri(inn, a2, c2, d2, ref, false);
  }
  const mk = (arr, color) => {
    if (!arr.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
    g.computeVertexNormals();
    return paint(g, color);
  };
  const inner = mk(inn, o.inner ?? COCKPIT2);
  if (inner) inner.userData.lining = true;
  return { outer: mk(out, o.color ?? PAINT), inner, glass: mk(gl, GLASS) };
}

/** Angle on a section (arc mode) at which the section reaches height y on the +X side. */
export function angleAt(st, z, y, sq = 2.6) {
  const [, , y0, y1] = stationAt(st, z), cy = (y0 + y1) / 2, hh = (y1 - y0) / 2;
  const v = Math.max(-1, Math.min(1, (y - cy) / hh));
  return Math.asin(Math.sign(v) * Math.abs(v) ** (sq / 2));
}

/** Collects shell outputs into hull / interior / glass lists. */
export function addShell(sh, hull, glass, inner = hull) {
  if (sh.outer) hull.push(sh.outer);
  if (sh.inner) inner.push(sh.inner);
  if (sh.glass) glass.push(sh.glass);
}

export { PAINT, TEAM, DARK, STEEL, RUBBER, GLASS, LENS, box, cyl, tubeX, tubeZ, sphere, cone, mirror, place, fuselage, merge, loft };
