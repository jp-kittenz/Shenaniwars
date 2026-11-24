import { DARK, STEEL, RUBBER, GLASS, LENS, box, cyl, mirror } from './kit.js';
import { INT, seat } from './cabs.js';

/**
 * Aircraft cockpits behind transparent canopies (ground coordinates, +Z forward). The fuselage under a canopy is
 * opened with `cutFuselage` (its top lowered to the canopy sill between two bulkheads), and the cockpit parts sit
 * in the opening: ejection seat or crew seats, instrument panel with displays, glareshield and HUD, side and
 * centre consoles, overhead panel; the stick / cyclic is the animated control.
 */

const SEATC = 0x3b4036, HANDLE = 0xd6ae2a, PANELC = 0x2a2e31, MFD = 0x2f7a5c, MFD2 = 0x6a8a3a;

/**
 * Lowers a fuselage's top to `sill` between z0 and z1 (bulkheads at both ends): the cockpit opening under a canopy.
 * Stations are [z, halfWidth, yBottom, yTop], ordered front-to-back or back-to-front.
 * @param {number[][]} st @param {number} z0 @param {number} z1 @param {number} sill
 */
export function cutFuselage(st, z0, z1, sill) {
  const desc = st[0][0] > st[st.length - 1][0];
  const s = st.slice().sort((a, b) => a[0] - b[0]);
  const at = (z) => {
    for (let i = 0; i < s.length - 1; i++) if (z >= s[i][0] && z <= s[i + 1][0]) {
      const k = (z - s[i][0]) / (s[i + 1][0] - s[i][0] || 1);
      return s[i].map((v, j) => v + (s[i + 1][j] - v) * k);
    }
    return null;
  };
  const out = s.filter((q) => q[0] < z0 || q[0] > z1);
  for (const [z, inner] of [[z0, z0 + 0.04], [z1, z1 - 0.04]]) {
    const a = at(z), b = at(inner);
    if (a) out.push(a);
    if (b) out.push([b[0], b[1], b[2], Math.min(b[3], sill)]);
  }
  for (const q of s) if (q[0] > z0 + 0.04 && q[0] < z1 - 0.04) out.push([q[0], q[1], q[2], Math.min(q[3], sill)]);
  out.sort((a, b) => a[0] - b[0]);
  return desc ? out.reverse() : out;
}

/** K-36 style ejection seat: tall back with headbox, side rails, cushion / survival kit, yellow-black handle. */
export function ejectionSeat(x, y, z) {
  return [
    box(0.48, 0.14, 0.5, x, y - 0.07, z, SEATC), box(0.42, 0.05, 0.44, x, y + 0.02, z + 0.01, 0x4a4f43),
    box(0.5, 0.78, 0.14, x, y + 0.39, z - 0.3, SEATC, -0.2), box(0.42, 0.6, 0.05, x, y + 0.37, z - 0.22, 0x4a4f43, -0.2),
    box(0.44, 0.24, 0.22, x, y + 0.86, z - 0.4, SEATC, -0.2), box(0.3, 0.14, 0.04, x, y + 0.84, z - 0.28, 0x4a4f43, -0.2), // headbox + pad
    ...[-1, 1].map((s) => box(0.05, 0.98, 0.08, x + s * 0.27, y + 0.45, z - 0.36, STEEL, -0.2)), // rails
    box(0.16, 0.05, 0.05, x, y + 0.04, z + 0.27, HANDLE), box(0.04, 0.1, 0.04, x - 0.06, y + 0.09, z + 0.27, DARK), box(0.04, 0.1, 0.04, x + 0.06, y + 0.09, z + 0.27, DARK),
    ...[-1, 1].map((s) => box(0.04, 0.12, 0.2, x + s * 0.25, y + 0.1, z + 0.1, HANDLE)), // side firing handles
  ];
}

/** Multi-function display (bezel with buttons, lit screen) facing -Z. */
function mfd(x, y, z, w, h, color = MFD, tilt = 0) {
  const p = [box(w + 0.06, h + 0.06, 0.04, x, y, z, PANELC, tilt), box(w, h, 0.01, x, y, z - 0.022, color, tilt)];
  for (let i = 0; i < 4; i++) p.push(box(0.025, 0.02, 0.015, x - w / 2 + (i + 0.5) * (w / 4), y - h / 2 - 0.02, z - 0.02, INT.GAUGE, tilt));
  return p;
}

/** Round standby instrument facing -Z. */
function dial(x, y, z, r) {
  return [cyl(r, r, 0.02, 12, x, y, z, INT.GAUGE, Math.PI / 2), cyl(r * 1.2, r * 1.2, 0.02, 12, x, y, z + 0.01, PANELC, Math.PI / 2), box(r * 0.9, 0.012, 0.01, x, y, z - 0.015, DARK, 0, 0, 0.7)];
}

/**
 * Fighter / trainer cockpit for one seat. `o.hw` cockpit half width, `o.sill` canopy sill height.
 * @returns {{parts:any[], glass:any[], stick:any}}
 */
export function jetCockpit(st, o) {
  const { x, y, z } = st, hw = o.hw ?? 0.45, sill = o.sill ?? y + 0.28;
  const zp = z + (o.panel ?? 0.78), p = [], glass = [];
  p.push(...ejectionSeat(x, y, z));
  // instrument panel (tilted back), two MFDs + standby dials, glareshield coaming, HUD with its combiner glass
  p.push(box(hw * 1.7, 0.42, 0.1, x, sill + 0.02, zp, PANELC, -0.25));
  p.push(...mfd(x - 0.17, sill + 0.05, zp - 0.07, 0.2, 0.18, MFD, -0.25), ...mfd(x + 0.17, sill + 0.05, zp - 0.07, 0.2, 0.18, MFD2, -0.25));
  p.push(...dial(x, sill - 0.12, zp - 0.06, 0.045), ...dial(x - 0.32, sill + 0.12, zp - 0.04, 0.035), ...dial(x + 0.32, sill + 0.12, zp - 0.04, 0.035));
  p.push(box(hw * 1.75, 0.06, 0.34, x, sill + 0.26, zp + 0.1, PANELC), box(hw * 1.7, 0.02, 0.05, x, sill + 0.23, zp - 0.07, DARK));
  p.push(box(0.2, 0.12, 0.18, x, sill + 0.34, zp + 0.05, DARK));
  glass.push(box(0.17, 0.15, 0.01, x, sill + 0.47, zp - 0.02, GLASS, -0.35));
  p.push(box(0.02, 0.17, 0.02, x - 0.095, sill + 0.47, zp - 0.02, DARK, -0.35), box(0.02, 0.17, 0.02, x + 0.095, sill + 0.47, zp - 0.02, DARK, -0.35));
  // side consoles with switch rows and the throttle quadrant (left)
  for (const s of [-1, 1]) {
    const cx = x + s * (hw - 0.1);
    p.push(box(0.18, 0.06, 0.95, cx, sill - 0.03, z + 0.1, PANELC));
    for (let i = 0; i < 4; i++) p.push(box(0.12, 0.012, 0.12, cx, sill + 0.005, z - 0.25 + i * 0.22, i % 2 ? MFD : INT.GAUGE));
  }
  p.push(box(0.1, 0.06, 0.25, x + (hw - 0.1), sill + 0.02, z - 0.05, DARK));
  // rear bulkhead / headrest fairing
  p.push(box(hw * 1.8, 0.35, 0.1, x, sill + 0.1, z - 0.62, PANELC));
  return { parts: p, glass, stick: { kind: 'stick', x, y: y - 0.12, z: z + 0.36 } };
}

/**
 * Helicopter / transport flight deck for two pilots side by side: armoured seats, wide instrument panel with
 * displays, glareshield, centre pedestal, overhead console, rear bulkhead with a doorway, static copilot controls.
 * `o`: {sill, w, zPanel, zBack, yRoof, floor}.
 */
export function flightDeck(seats, o) {
  const p = [], { sill, w, zPanel, zBack, yRoof } = o, floor = o.floor ?? Math.min(...seats.map((q) => q.y)) - 0.45;
  for (const q of seats) p.push(...seat(q.x, q.y, q.z, floor, { w: 0.5, color: SEATC }), box(0.52, 0.5, 0.06, q.x, q.y + 0.35, q.z - 0.36, DARK, -0.14));
  // instrument panel (two displays per pilot, standby dials in the middle), glareshield
  const ph = 0.4, py = sill + 0.06;
  p.push(box(w - 0.15, ph, 0.12, 0, py, zPanel, PANELC, -0.12), box(w - 0.1, 0.06, 0.4, 0, py + ph / 2 + 0.02, zPanel + 0.12, PANELC));
  for (const q of seats) p.push(...mfd(q.x - 0.13, py + 0.05, zPanel - 0.075, 0.2, 0.17, MFD, -0.12), ...mfd(q.x + 0.13, py + 0.05, zPanel - 0.075, 0.2, 0.17, MFD2, -0.12));
  p.push(...dial(0, py + 0.1, zPanel - 0.07, 0.04), ...dial(-0.12, py - 0.06, zPanel - 0.07, 0.035), ...dial(0.12, py - 0.06, zPanel - 0.07, 0.035));
  // centre pedestal with switch rows
  p.push(box(0.32, sill - floor + 0.05, zPanel - zBack - 0.6, 0, (floor + sill) / 2, (zPanel + zBack) / 2 + 0.25, PANELC));
  for (let i = 0; i < 4; i++) p.push(box(0.26, 0.015, 0.1, 0, sill + 0.035, zPanel - 0.3 - i * 0.18, i % 2 ? INT.GAUGE : MFD));
  // overhead console
  if (yRoof) p.push(box(0.5, 0.08, 0.7, 0, yRoof - 0.06, zPanel - 0.35, PANELC), ...[0, 1, 2].map((i) => box(0.4, 0.012, 0.1, 0, yRoof - 0.105, zPanel - 0.15 - i * 0.2, INT.GAUGE)));
  // rear bulkhead with a doorway in the middle
  if (zBack !== undefined && yRoof) for (const s of [-1, 1]) p.push(box(w / 2 - 0.35, yRoof - floor, 0.06, s * (w / 4 + 0.175), (yRoof + floor) / 2, zBack, INT.INNER));
  // pedals and the copilot's static cyclic / collective (the pilot's are animated controls)
  for (const q of seats) p.push(box(0.12, 0.1, 0.03, q.x - 0.1, floor + 0.15, q.z + 0.72, RUBBER, -0.6), box(0.12, 0.1, 0.03, q.x + 0.1, floor + 0.15, q.z + 0.72, RUBBER, -0.6));
  for (const q of seats.slice(1)) p.push(cyl(0.018, 0.024, 0.5, 6, q.x, q.y + 0.2, q.z + 0.3, DARK), box(0.05, 0.11, 0.06, q.x, q.y + 0.48, q.z + 0.3, RUBBER));
  const d = seats[0];
  return { parts: p, stick: { kind: 'cyclic', x: d.x, y: d.y - 0.1, z: d.z + 0.3 } };
}

/** Canopy frame bow (arch) across a canopy at z: two side members and a top bar. */
export function canopyBow(z, hw, y0, y1, color = DARK) {
  return [box(hw * 1.7, 0.05, 0.05, 0, y1 - 0.04, z, color), ...mirror([box(0.05, y1 - y0 - 0.06, 0.05, hw * 0.9, (y0 + y1) / 2 - 0.02, z, color)])];
}

/**
 * Cockpit for an aircraft def: the seats listed in `o.seats` (def indices; the first flies), optional static extra
 * seats `o.extra` ([x, y, z] ground), transparent canopy lofted through `o.canopy` stations. Returns hull parts,
 * glass and the `cabin` record (seats shown through the canopy, animated stick / cyclic).
 */
export function glaze(def, fuselageFn, o) {
  const ride = def.ride;
  const seats = o.seats.map((i) => ({ i, x: def.seats[i].pos[0], y: def.seats[i].pos[1] + ride, z: def.seats[i].pos[2] }));
  const parts = [], glass = [fuselageFn(o.canopy)];
  let stick;
  if (o.kind === 'jet') {
    const ck = jetCockpit(seats[0], { hw: o.hw, sill: o.sill, panel: o.panel });
    parts.push(...ck.parts); glass.push(...ck.glass); stick = ck.stick;
    for (const [x, y, z] of o.extra || []) {
      parts.push(...ejectionSeat(x, y, z), box((o.hw ?? 0.45) * 1.6, 0.36, 0.1, x, o.sill + 0.1, z + 0.72, PANELC, -0.25), ...mfd(x, o.sill + 0.12, z + 0.65, 0.22, 0.16, MFD, -0.25));
    }
  } else {
    const all = [...seats, ...(o.extra || []).map(([x, y, z]) => ({ x, y, z }))];
    const ck = flightDeck(all, { sill: o.sill, w: o.w, zPanel: o.zPanel, zBack: o.zBack, yRoof: o.yRoof });
    parts.push(...ck.parts); stick = ck.stick;
  }
  for (const b of o.bows || []) parts.push(...canopyBow(b[0], b[1], o.sill, b[2]));
  return { parts, glass, cabin: { zB: o.zBack ?? Math.min(...seats.map((q) => q.z)) - 0.8, zF: 1e3, seats: seats.map((q) => q.i), wheel: { ...stick, y: stick.y, tilt: 0 }, doors: [] } };
}

export { LENS };
