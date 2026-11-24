import {
  PAINT, TEAM, DARK, STEEL, RUBBER, GLASS, LENS, box, cyl, tubeX, tubeZ, sphere, cone, mirror, place, fuselage,
  airfoil, wing, wingLine, fin, ring, stringer, stationAt, halfWidthAt, rotor, smallRotor, propeller, navLights, pitot, antenna,
  heliLeg, ejectionSeat, jetTub, flightDeck, cabin, shell, addShell, angleAt, COCKPIT, COCKPIT2, CABIN, CABIN2, FLOOR, tagInterior,
} from './aerokit.js';
import { cutFuselage } from './cockpits.js';
import { side, star } from './kit.js';
import { INT } from './cabs.js';

/**
 * Torsa aircraft, rebuilt on the aircraft kit (aerokit.js): fuselages lofted through many stations with hollow
 * skins where people sit (cockpit tubs, cabins), canopies whose frames follow the glass, airfoil wings / fins /
 * blades, rotor heads, detailed gear and stores; cockpits and cabins are furnished (seats, panels, consoles, troop
 * seats, overhead services). Ground coordinates, +Z forward, +X left.
 */

const seatG = (def, i) => ({ x: def.seats[i].pos[0], y: def.seats[i].pos[1] + def.ride, z: def.seats[i].pos[2] });
const STAR = (x, y, z, r, sgn = 1) => side(star(r).map(([u, v]) => [u + z, v + y]), 0.02, TEAM, x + sgn * 0.0);

/** B-8 rocket pod (20 × 80 mm) on a pylon. */
function b8(x, y, z, r = 0.22, len = 1.6) {
  const p = [tubeZ(r, r, z - len / 2, z + len / 2, x, y, 14, 0x5d6450), cone(r, 0.35, 14, x, y, z + len / 2 + 0.17, 0x5d6450, Math.PI / 2),
    tubeZ(r * 1.02, r * 1.02, z - len / 2, z - len / 2 + 0.06, x, y, 14, DARK), box(0.06, 0.28, len * 0.5, x, y + r + 0.12, z, DARK)];
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; p.push(tubeZ(0.035, 0.035, z - len / 2 - 0.02, z - len / 2 + 0.02, x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, 6, RUBBER)); }
  return p;
}

/** Free-fall bomb with tail fins on a pylon. */
function bomb(x, y, z, r = 0.17, len = 1.5) {
  return [tubeZ(r, r * 0.8, z - len * 0.35, z + len * 0.3, x, y, 12, 0x4f5a3a), cone(r, len * 0.25, 12, x, y, z + len * 0.42, 0x4f5a3a, Math.PI / 2),
    ...[0, 1, 2, 3].map((k) => place(box(0.012, r * 1.6, 0.3, 0, r * 0.6, 0, 0x4f5a3a), x, y, z - len * 0.4, 0, 0, (k * Math.PI) / 2)),
    box(0.05, 0.25, len * 0.45, x, y + r + 0.1, z, DARK)];
}

/** Air-to-air missile on a rail. */
function aam(x, y, z, len = 2.2, r = 0.07, color = 0xd9dcd8) {
  return [tubeZ(r, r, z - len / 2, z + len / 2 - 0.25, x, y, 8, color), cone(r, 0.3, 8, x, y, z + len / 2 - 0.1, color, Math.PI / 2),
    ...[0, 1, 2, 3].map((k) => place(box(0.01, 0.14, 0.22, 0, 0.1, 0, color), x, y, z - len / 2 + 0.15, 0, 0, (k * Math.PI) / 2 + Math.PI / 4)),
    ...[0, 1, 2, 3].map((k) => place(box(0.01, 0.1, 0.12, 0, 0.08, 0, color), x, y, z + len / 2 - 0.5, 0, 0, (k * Math.PI) / 2 + Math.PI / 4)),
    box(0.05, 0.1, len * 0.7, x, y + r + 0.05, z, DARK)];
}

/** Jet engine nozzle (afterburner petals) facing aft at z. */
function nozzle(x, y, z, r, len = 0.5) {
  const p = [tubeZ(r * 0.92, r, z - len, z, x, y, 16, 0x3a3c3e), tubeZ(r * 0.7, r * 0.7, z - len - 0.01, z - len + 0.05, x, y, 14, 0x1a1a1a), cyl(r * 0.45, r * 0.45, 0.02, 12, x, y, z - len * 0.6, 0x5a3a2a, Math.PI / 2)];
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; p.push(box(0.01, 0.02, len * 0.9, x + Math.cos(a) * r * 0.96, y + Math.sin(a) * r * 0.96, z - len / 2, DARK)); }
  return p;
}

/** Cockpit assembly for a single-seat (or tandem) jet: opened fuselage, side skins, tub, canopy glass and frames. */
function jetCockpit(def, st, o) {
  const sq = o.sq ?? 2.6, hull = [], glass = [];
  const seat = seatG(def, 0);
  for (const sgn of [1, -1]) addShell(shell(st, { mode: 'side', sign: sgn, z0: o.z0 + 0.04, z1: o.z1 - 0.04, v0: o.floor, v1: o.sill, sq, nv: 3, dz: 0.3 }), hull, glass);
  // canopy profile: at least 1.12 m over every seat (headbox clearance), as wide as the fuselage at the sill
  const seatsZ = [[seat.z, seat.y], ...(o.extra || []).map(([, y, z]) => [z, y])];
  const canProf = o.canopy.map(([z, top]) => { let t = top; for (const [sz, sy] of seatsZ) if (Math.abs(z - (sz - 0.35)) < 0.75) t = Math.max(t, sy + 1.12 - Math.abs(z - (sz - 0.35)) * 0.15); return [z, t]; });
  o = { ...o, canopy: canProf };
  const cst0 = canProf.map(([z, t]) => [z, halfWidthAt(st, z, o.sill + 0.01, sq) + 0.01, o.sill - (t - o.sill), t]);
  const tub = jetTub(st, seat, { z0: o.z0, z1: o.z1, floor: o.floor, sill: o.sill, panelZ: o.panelZ, sq, walls: false,
    top: (z) => stationAt(cst0, z)[3], cw: (z, y) => halfWidthAt(cst0, z, y, 2.6) });
  hull.push(...tub.parts); glass.push(...tub.glass);
  for (const [x, y, z] of o.extra || []) {
    hull.push(...tagInterior([...ejectionSeat(x, y, z), box(0.7, 0.36, 0.08, x, o.sill - 0.02, z + 0.74, COCKPIT, -0.25),
      box(0.36, 0.26, 0.02, x, o.sill + 0.02, z + 0.69, 0x2f7a5c, -0.25), box(0.75, 0.05, 0.3, x, o.sill + 0.2, z + 0.85, COCKPIT)]));
  }
  // canopy: lower edge on the sill, as wide as the fuselage there
  const cst = o.canopy.map(([z, top]) => { const hw = halfWidthAt(st, z, o.sill + 0.01, sq) + 0.01; return [z, hw, o.sill - (top - o.sill), top]; });
  // fixed windscreen (front of the first bow) and the opening canopy behind it, hinged at its rear edge
  const zb = o.bows[0], wsSt = [...cst.filter((c) => c[0] > zb), stationAt(cst, zb)], caSt = [stationAt(cst, zb), ...cst.filter((c) => c[0] < zb)];
  glass.push(fuselage(wsSt, GLASS, 0, 18));
  hull.push(...ring(cst, zb, { a0: 0.02, a1: Math.PI - 0.02, w: o.bowW ?? 0.07, d: 0.08 }));
  for (const a of [0.03, Math.PI - 0.03]) hull.push(...stringer(wsSt, zb, wsSt[0][0], a, { w: 0.05, n: 3 }));
  const cg = [], cgl = [];
  if (o.rearPanel) {
    // rear cockpit under a mostly solid canopy with two side windows (MiG-31 style)
    const zs = o.rearPanel, front = [stationAt(cst, zb), ...cst.filter((c) => c[0] < zb && c[0] > zs), stationAt(cst, zs)];
    cgl.push(fuselage(front, GLASS, 0, 18));
    const back = [stationAt(cst, zs), ...cst.filter((c) => c[0] < zs)];
    const sh = shell(back, { mode: 'band', yFloor: o.sill + 0.02, z0: back[back.length - 1][0], z1: zs, v0: 0, v1: 1, sq: 2.6, dz: 0.15, nv: 10, inner: COCKPIT2,
      holes: [{ z0: zs - 0.95, z1: zs - 0.12, v0: 0.1, v1: 0.38, glass: true }, { z0: zs - 0.95, z1: zs - 0.12, v0: 0.62, v1: 0.9, glass: true }] });
    if (sh.outer) cg.push(sh.outer); if (sh.inner) cg.push(sh.inner); if (sh.glass) cgl.push(sh.glass);
  } else cgl.push(fuselage(caSt, GLASS, 0, 18));
  for (const z of o.bows.slice(1)) cg.push(...ring(cst, z, { a0: 0.02, a1: Math.PI - 0.02, w: o.bowW ?? 0.06, d: 0.07 }));
  cg.push(...ring(cst, zb - 0.06, { a0: 0.02, a1: Math.PI - 0.02, w: 0.05, d: 0.06, grow: 0.02 }));
  for (const a of [0.03, Math.PI - 0.03]) cg.push(...stringer(caSt, caSt[caSt.length - 1][0], zb, a, { w: 0.05 }));
  if (o.mirrorZ) cg.push(box(0.1, 0.05, 0.03, 0, o.canopy.reduce((m, c) => Math.max(m, c[1]), 0) - 0.08, Math.min(o.mirrorZ, zb - 0.1), INT.CHROME));
  const zh = caSt[caSt.length - 1][0], yh = o.sill;
  for (const g of [...cg, ...cgl]) g.translate(0, -yh, -zh);
  const canopy = { side: 0, x: 0, y: yh, z: zh, axis: 'x', open: -0.75, geo: cg, glass: cgl, glassAlways: true, seats: [0] };
  return { hull, glass, cabin: { zB: o.z0, zF: 1e3, seats: [0], wheel: { ...tub.stick, tilt: 0 }, doors: [canopy] } };
}

export const AIRCRAFT_MODELS = {
  /** Su-25 "Frogfoot": slab-sided armoured nose with the laser window, bubble canopy over a titanium tub, straight
   * shoulder wing with ten pylons and split-flap wingtip pods, engine nacelles along the fuselage, tall fin. */
  strikejet: (def) => {
    const sq = 3.0;
    const st = [[5.95, 0.04, 1.78, 1.84], [5.5, 0.2, 1.62, 1.98], [4.9, 0.36, 1.45, 2.1], [4.3, 0.47, 1.32, 2.2], [3.4, 0.55, 1.24, 2.26], [2.4, 0.58, 1.2, 2.24],
      [1.2, 0.57, 1.2, 2.2], [0.0, 0.54, 1.24, 2.16], [-2.0, 0.45, 1.36, 2.1], [-4.2, 0.32, 1.55, 2.04], [-5.45, 0.22, 1.66, 1.98]];
    const ck = jetCockpit(def, st, { z0: 2.35, z1: 4.3, floor: 1.42, sill: 2.02, panelZ: 4.08, sq, canopy: [[4.32, 2.2], [3.95, 2.6], [3.3, 2.84], [2.7, 2.78], [2.35, 2.3]], bows: [3.95, 3.45], mirrorZ: 3.9 });
    const W = { x0: 0.52, x1: 5.35, le0: 1.6, c0: 2.9, le1: 0.3, c1: 1.05, y0: 1.98, y1: 1.88, t0: 0.11, t1: 0.1 };
    const T = { x0: 0.25, x1: 2.45, le0: -3.95, c0: 1.45, le1: -4.65, c1: 0.7, y0: 2.08, y1: 2.42, t0: 0.08, t1: 0.07 };
    return {
      scheme: { base: [0x8b8f8a, 0x6d6656, 0x575c55], belly: 0x9aa3a8, scale: 2.2 },
      glass: [...ck.glass, box(0.12, 0.1, 0.02, 0, 1.6, 5.42, LENS, 0.5)], cabin: ck.cabin,
      hull: [
        fuselage(cutFuselage(st, 2.35, 4.3, 1.42), PAINT, 0, 18, sq),
        ...ck.hull,
        ...pitot(5.9, 6.55, 1.82), box(0.24, 0.16, 0.5, 0, 1.55, 5.1, DARK), // laser rangefinder fairing
        ...mirror([
          // engine nacelles with intakes beside the cockpit and nozzles
          fuselage([[2.25, 0.3, 1.32, 1.92], [1.7, 0.42, 1.2, 2.02], [0.0, 0.45, 1.15, 2.05], [-3.4, 0.4, 1.25, 1.98], [-4.45, 0.3, 1.38, 1.86]], PAINT, 0.78, 16, 2.4),
          tubeZ(0.3, 0.3, 2.2, 2.27, 0.78, 1.62, 14, DARK), cyl(0.2, 0.2, 0.02, 12, 0.78, 1.62, 2.0, 0x3a3c3e, Math.PI / 2),
          ...nozzle(0.78, 1.62, -4.4, 0.27, 0.45),
          // wing with flap / aileron lines, wingtip pod with split airbrakes and nav light
          wing(W), wingLine(W, 0.7, 0.04, 0.55), wingLine(W, 0.7, 0.58, 0.95), wingLine(W, 0.1, 0.1, 0.95, 0x4a4e4a),
          tubeZ(0.13, 0.13, -0.75, 0.55, 5.42, 1.88, 10, PAINT), cone(0.13, 0.4, 10, 5.42, 1.88, 0.74, PAINT, Math.PI / 2), box(0.26, 0.02, 0.6, 5.42, 1.88, -0.95, DARK),
          // pylons and stores: B-8 pods inboard, bombs outboard
          ...[1.75, 2.55, 3.35, 4.15].map((x) => box(0.06, 0.24, 0.8, x, 1.78, 0.35, DARK)),
          ...b8(1.75, 1.42, 0.3), ...b8(2.55, 1.42, 0.25), ...bomb(3.35, 1.48, 0.3), ...bomb(4.15, 1.5, 0.15, 0.13, 1.2),
          // tailplane with dihedral, elevator line
          wing(T), wingLine(T, 0.65, 0.05, 0.95),
        ]),
        ...navLights(5.42, 1.88, 0.95),
        fin({ x: 0, y0: 2.0, y1: 3.75, le0: -2.95, c0: 2.45, le1: -4.55, c1: 1.05, t0: 0.09, t1: 0.07 }),
        box(0.03, 1.3, 0.03, 0, 2.95, -4.95, DARK), // rudder hinge
        ...antenna(0, 2.25, 0.8), ...antenna(0, 1.2, -1.0, -0.3),
        STAR(0.06, 3.0, -4.0, 0.36), STAR(-0.06, 3.0, -4.0, 0.36),
        // GSh-30-2 cannon fairing under the nose (left)
        box(0.22, 0.2, 1.4, 0.3, 1.22, 3.9, PAINT), tubeZ(0.04, 0.035, 4.5, 4.95, 0.32, 1.2, 6, DARK), tubeZ(0.04, 0.035, 4.5, 4.95, 0.24, 1.22, 6, DARK),
      ],
    };
  },

  /** Mi-8MTV-5: framed glazed flight deck with side blisters, hollow cabin with windows, sliding door, troop seats
   * and overhead services, clamshell doors, twin engines with dust protectors, five-blade rotor, external tanks,
   * B-8 outriggers. */
  transportheli: (def) => {
    const sq = 2.3;
    const st = [[5.45, 0.25, 1.4, 1.85], [5.15, 0.62, 1.1, 2.35], [4.7, 0.92, 0.88, 2.78], [4.0, 1.08, 0.76, 3.0], [3.0, 1.15, 0.72, 2.98], [-1.4, 1.15, 0.72, 2.92],
      [-2.4, 1.08, 0.8, 2.88], [-3.1, 0.8, 1.25, 2.78], [-3.6, 0.42, 1.85, 2.62], [-7.2, 0.2, 2.1, 2.45], [-8.5, 0.17, 2.12, 2.62]];
    const H = heliBody(def, st, { sq, deck: { z0: 3.5, z1: 5.55, floor: 1.65, sill: 2.15, panelZ: 4.8, roof: 2.74, copilot: true }, bay: { z0: -2.4, z1: 3.5, floor: 0.98, roof: 2.8, wins: [-1.8, -0.9, 0.0, 0.9, 1.8], door: [2.35, 3.35], doorSeats: [1, 3, 4, 5, 6, 7, 8] } });
    const hull = H.hull;
    hull.push(fuselage([[3.45, 0.6, 2.8, 3.05], [2.8, 0.88, 2.8, 3.42], [0.0, 0.88, 2.8, 3.48], [-1.2, 0.78, 2.8, 3.38], [-1.9, 0.52, 2.8, 3.2]], PAINT, 0, 16),
      ...mirror([sphere(0.32, 0.42, 3.12, 3.45, 0x6e7468, 1, 1, 0.8, 10, 6), tubeZ(0.2, 0.22, -1.7, -1.1, 0.95, 3.06, 10, DARK), tubeZ(0.16, 0.16, -1.75, -1.68, 0.98, 3.06, 10, 0x2a2420),
        box(0.02, 0.32, 1.6, 0.88, 3.18, 1.2, DARK), ...[0.6, 1.0, 1.4, 1.8].map((z) => box(0.02, 0.26, 0.02, 0.89, 3.18, z, STEEL))]),
      cyl(0.2, 0.28, 0.45, 10, 0, 3.55, 0, DARK), cyl(0.5, 0.6, 0.15, 14, 0, 3.47, 0, PAINT),
      fin({ x: 0, y0: 2.3, y1: 3.65, le0: -7.6, c0: 1.0, le1: -8.4, c1: 0.7, t0: 0.16, t1: 0.12 }),
      ...mirror([wing({ x0: 0.12, x1: 0.95, le0: -6.8, c0: 0.55, le1: -6.9, c1: 0.42, y0: 2.22, y1: 2.22, t0: 0.12, t1: 0.1 })]),
      box(0.05, 0.5, 0.05, 0, 1.9, -7.8, DARK), box(0.12, 0.05, 0.4, 0, 1.65, -7.85, DARK),
      ...mirror([tubeZ(0.38, 0.38, -0.8, 1.8, 1.32, 1.15, 14, PAINT), cone(0.38, 0.4, 14, 1.32, 1.15, 2.0, PAINT, Math.PI / 2),
        place(box(1.3, 0.12, 0.6, 0, 0, 0, PAINT), 1.8, 1.48, 0.6, 0, 0, -0.32), ...b8(2.1, 1.0, 0.6, 0.22, 1.5),
        ...heliLeg(1.5, -1.0, 0.3, 1.2), box(0.06, 0.06, 1.0, 1.25, 0.95, -0.6, DARK)]),
      box(0.08, 0.7, 0.08, 0.3, 0.45, 4.0, DARK), box(0.08, 0.7, 0.08, -0.3, 0.45, 4.0, DARK), tubeX(0.25, 0.75, 0, 0.25, 4.0, 12, RUBBER),
      STAR(0.37, 2.25, -5.0, 0.42), STAR(-0.37, 2.25, -5.0, 0.42), ...antenna(0, 2.9, -2.0), ...navLights(1.35, 1.6, 1.9));
    return {
      scheme: { base: [0x5f6b3d, 0x8b7a4d, 0x4b4a33], belly: 0x8fb0c4, scale: 2.6 }, glass: H.glass, hull, cabin: H.cabin,
      mounts: { 1: lmg(0.9), 2: lmg(0.9) },
      rotors: [
        { pos: [0, 3.75, 0], axis: 'y', dir: 1, rate: 22, geos: rotor(5, 7.6, 0.44, { droop: 0.04 }) },
        { pos: [-0.32, 3.25, -8.45], axis: 'x', dir: 1, rate: 60, geos: smallRotor(3, 1.25, 0.22).map((g) => g.rotateZ(Math.PI / 2)) },
      ],
    };
  },

  /** Mi-17 gunship (Mi-8AMTSh): armoured flight deck, long cabin with the door gunner, outriggers with B-8 pods and
   * Shturm ATGM racks, engines with dust protectors, five-blade rotor, nose gear. */
  gunship: (def) => {
    const sq = 2.4;
    const st = [[9.35, 0.35, 1.2, 1.9], [8.85, 0.95, 0.85, 2.62], [7.8, 1.3, 0.7, 3.1], [6.2, 1.4, 0.68, 3.3], [1.0, 1.42, 0.68, 3.35], [-1.6, 1.35, 0.72, 3.3],
      [-2.8, 1.0, 1.2, 3.25], [-3.8, 0.6, 2.25, 3.2], [-8.0, 0.32, 2.6, 3.1], [-11.2, 0.25, 2.75, 3.15]];
    const H = heliBody(def, st, { sq, deck: { z0: 7.2, z1: 9.45, floor: 1.75, sill: 2.3, panelZ: 8.7, roof: 3.2 }, bay: { z0: -1.6, z1: 7.2, floor: 0.95, roof: 3.2, wins: [6.4, 3.4, 2.4, 1.4, 0.4, -0.6], door: [4.0, 5.2], doorSeats: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } });
    const hull = H.hull;
    hull.push(fuselage([[6.6, 0.85, 3.2, 3.5], [5.8, 1.05, 3.2, 3.95], [-0.2, 1.05, 3.2, 3.95], [-1.4, 0.85, 3.2, 3.75], [-2.3, 0.45, 3.2, 3.45]], PAINT, 0, 16),
      ...mirror([sphere(0.36, 0.48, 3.55, 6.55, 0x6e7468, 1, 1, 0.8, 10, 6), tubeZ(0.24, 0.26, -1.6, -1.2, 1.05, 3.45, 10, DARK), tubeZ(0.19, 0.19, -1.65, -1.58, 1.08, 3.45, 10, 0x2a2420),
        // armour plates on the flight deck sides, outriggers with B-8 pods and Shturm racks, main gear
        box(0.04, 0.42, 1.2, halfWidthAt(st, 8.0, 2.0, sq) + 0.02, 2.0, 8.0, PAINT),
        box(0.08, 0.95, 0.1, 1.0, 1.15, 0.4, STEEL, 0, 0, 0.6), place(box(2.3, 0.12, 1.2, 0, 0, 0, PAINT), 2.2, 1.72, 1.5, 0, 0, -0.08),
        ...b8(2.4, 1.32, 1.4, 0.26, 1.9), ...b8(3.1, 1.36, 1.4, 0.26, 1.9),
        ...[[0.1, 0], [-0.1, 0], [0, 0.18]].map(([dx, dy]) => tubeZ(0.08, 0.08, 0.4, 2.2, 3.55 + dx, 1.5 + dy, 8, 0x6d7458)),
        ...heliLeg(1.55, 0.2, 0.35, 1.15)]),
      cyl(0.22, 0.3, 0.6, 10, 0, 4.3, 1.9, DARK), cyl(0.6, 0.7, 0.18, 14, 0, 4.05, 1.9, PAINT),
      fin({ x: 0, y0: 3.0, y1: 5.4, le0: -10.6, c0: 1.0, le1: -11.6, c1: 0.75, t0: 0.18, t1: 0.12 }),
      wing({ x0: -1.6, x1: 1.6, le0: -10.2, c0: 0.6, le1: -10.2, c1: 0.6, y0: 3.05, y1: 3.05, t0: 0.12, t1: 0.12 }),
      box(0.08, 0.7, 0.08, 0.3, 0.5, 7.4, DARK), box(0.08, 0.7, 0.08, -0.3, 0.5, 7.4, DARK), tubeX(0.27, 0.8, 0, 0.27, 7.4, 12, RUBBER),
      STAR(0.36, 2.95, -6.0, 0.45), STAR(-0.36, 2.95, -6.0, 0.45), ...antenna(0, 3.18, -2.6), ...navLights(3.4, 1.75, 2.0));
    return {
      scheme: { base: [0x5a6640, 0x8a7d52, 0x404530], belly: 0x8fa9b8, scale: 3.0 }, glass: H.glass, hull, cabin: H.cabin,
      mounts: { 2: lmg(0.9) },
      rotors: [
        { pos: [0, 4.75, 1.9], axis: 'y', dir: 1, rate: 22, geos: rotor(5, 10.6, 0.53, { droop: 0.035 }) },
        { pos: [-0.35, 4.6, -11.9], axis: 'x', dir: 1, rate: 60, geos: smallRotor(3, 1.95, 0.28).map((g) => g.rotateZ(Math.PI / 2)) },
      ],
    };
  },

  /** Mi-2: small fully glazed cabin with framed windows and two doors, twin engines on top, three-blade rotor,
   * slim boom with a two-blade tail rotor, four-wheel gear, nose FLIR turret, door gun. */
  reconheli: (def) => {
    const sq = 2.4;
    const st = [[4.48, 0.2, 0.95, 1.45], [4.2, 0.62, 0.7, 2.0], [3.4, 0.8, 0.55, 2.4], [1.2, 0.85, 0.55, 2.5], [-0.2, 0.8, 0.65, 2.45],
      [-0.9, 0.5, 1.4, 2.35], [-1.4, 0.24, 1.75, 2.25], [-5.8, 0.16, 1.95, 2.25], [-6.7, 0.14, 2.0, 2.3]];
    const H = heliBody(def, st, { sq, deck: { z0: 0.0, z1: 4.5, floor: 0.85, sill: 1.5, panelZ: 3.85, roof: 2.4, rearSeats: [2, 3],
      holes: [{ z0: 3.85, z1: 4.42, v0: 0.12, v1: 0.48, glass: true }, { z0: 3.85, z1: 4.42, v0: 0.52, v1: 0.88, glass: true },
        { z0: 2.75, z1: 3.75, v0: 0.06, v1: 0.4, glass: true }, { z0: 2.75, z1: 3.75, v0: 0.6, v1: 0.94, glass: true },
        { z0: 1.55, z1: 2.6, v0: 0.06, v1: 0.36, glass: true }, { z0: 1.55, z1: 2.6, v0: 0.64, v1: 0.94, glass: true },
        { z0: 0.4, z1: 1.4, v0: 0.12, v1: 0.32, glass: true }, { z0: 0.4, z1: 1.4, v0: 0.68, v1: 0.88, glass: true }] } });
    const hull = H.hull;
    hull.push(fuselage([[2.7, 0.6, 2.42, 2.65], [2.2, 0.72, 2.42, 3.0], [-0.4, 0.7, 2.42, 2.95], [-1.0, 0.4, 2.42, 2.7]], PAINT, 0, 14),
      ...mirror([tubeZ(0.16, 0.18, -0.95, -0.6, 0.35, 2.72, 8, DARK), box(0.02, 0.22, 1.0, 0.71, 2.72, 1.0, DARK),
        box(0.06, 0.7, 0.06, 1.0, 0.45, 0.2, DARK), tubeX(0.27, 0.18, 1.05, 0.27, 0.2, 12, RUBBER), box(0.06, 0.6, 0.06, 0.32, 0.45, 3.3, DARK), tubeX(0.2, 0.14, 0.35, 0.2, 3.3, 10, RUBBER),
        box(0.6, 0.06, 0.06, 0.65, 0.75, 0.2, STEEL, 0, 0, 0.3)]),
      fin({ x: 0, y0: 2.1, y1: 3.3, le0: -6.15, c0: 0.75, le1: -6.7, c1: 0.45, t0: 0.14, t1: 0.12, lean: 0 }),
      ...mirror([wing({ x0: 0.1, x1: 1.0, le0: -5.85, c0: 0.45, le1: -5.9, c1: 0.35, y0: 2.18, y1: 2.18, t0: 0.12, t1: 0.1 })]),
      box(0.06, 0.8, 0.06, 0, 1.6, -6.4, DARK), sphere(0.24, 0, 0.82, 4.3, LENS), box(0.1, 0.45, 0.1, 0, 1.02, 4.18, DARK),
      cyl(0.16, 0.22, 0.6, 8, 0, 3.1, 1.6, DARK), ...navLights(0.86, 1.3, 1.0), STAR(0.2, 2.2, -3.0, 0.3), STAR(-0.2, 2.2, -3.0, 0.3));
    return {
      scheme: { base: [0x5c6b3a], belly: 0x9cb7c9 }, glass: H.glass, hull, cabin: H.cabin,
      mounts: { 0: { yaw: [box(0.08, 0.36, 0.08, 0, -0.22, 0, DARK)], pitch: [box(0.1, 0.13, 0.62, 0, 0, 0.05, DARK), tubeZ(0.022, 0.02, 0.3, 0.8, 0, 0.02, 6, STEEL)] } },
      rotors: [
        { pos: [0, 3.55, 1.6], axis: 'y', dir: 1, rate: 24, geos: rotor(3, 7.25, 0.38, { droop: 0.03 }) },
        { pos: [0.22, 2.55, -6.95], axis: 'x', dir: 1, rate: 60, geos: smallRotor(2, 1.35, 0.18).map((g) => g.rotateZ(Math.PI / 2)) },
      ],
    };
  },

  /** Mi-26: glazed flight deck over a long cargo hold with windows, crew door and rear ramp, engines over the
   * cabin, eight-blade rotor, five-blade tail rotor on the swept fin, sponsons with twin-wheel gear. */
  heavyheli: (def) => {
    const sq = 2.4;
    const st = [[16.85, 0.6, 2.0, 3.2], [16.0, 1.5, 1.4, 4.4], [14.5, 1.85, 1.0, 5.1], [12.0, 2.0, 0.9, 5.35], [2.0, 2.05, 0.9, 5.4],
      [-4.5, 2.0, 1.0, 5.35], [-6.5, 1.4, 2.6, 5.3], [-8.0, 0.8, 3.6, 5.2], [-15.0, 0.55, 4.2, 5.2], [-17.0, 0.45, 4.4, 5.3]];
    const H = heliBody(def, st, { sq, deck: { z0: 13.6, z1: 16.95, floor: 3.15, sill: 3.85, panelZ: 15.6, roof: 5.0, roomy: true },
      bay: { z0: -4.4, z1: 13.6, floor: 1.05, roof: 4.4, wins: [12.5, 10.5, 8.5, 6.5, 4.5, 2.5, 0.5, -1.5, -3.2], door: [10.9, 12.1], doorSeats: def.seats.map((q, i) => i).filter((i) => i > 1) } });
    const hull = H.hull;
    hull.push(fuselage([[11.5, 1.6, 5.3, 5.7], [10.5, 1.95, 5.3, 6.6], [3.0, 1.95, 5.3, 6.6], [1.0, 1.4, 5.3, 6.3]], PAINT, 0, 16),
      ...mirror([tubeZ(0.62, 0.6, 11.4, 11.5, 1.0, 6.0, 14, DARK), tubeZ(0.5, 0.52, 0.8, 1.2, 1.4, 5.9, 12, DARK),
        side([[-1.0, 0.6], [-1.0, 2.0], [4.5, 2.0], [4.5, 0.6]], 0.7, PAINT, 2.25), box(0.12, 1.2, 0.12, 2.3, 0.6, 1.8, DARK),
        tubeX(0.6, 0.45, 2.3, 0.6, 1.8, 14, RUBBER), tubeX(0.6, 0.45, 2.3, 0.6, 0.6, 14, RUBBER), box(0.05, 0.8, 2.0, 2.1, 3.2, 8.5, TEAM)]),
      fin({ x: 0, y0: 5.0, y1: 9.4, le0: -14.6, c0: 2.2, le1: -16.9, c1: 1.3, t0: 0.16, t1: 0.12 }),
      ...mirror([wing({ x0: 0.2, x1: 2.2, le0: -14.8, c0: 1.1, le1: -15.0, c1: 0.8, y0: 5.2, y1: 5.2, t0: 0.12, t1: 0.1 })]),
      box(0.12, 1.2, 0.12, 0, 0.8, 11.6, DARK), tubeX(0.5, 0.9, 0, 0.5, 11.6, 14, RUBBER),
      cyl(0.4, 0.55, 1.4, 10, 0, 7.2, 5.5, DARK), STAR(0.66, 4.6, -11.0, 0.9), STAR(-0.66, 4.6, -11.0, 0.9), ...navLights(2.6, 2.0, 2.0));
    return {
      scheme: { base: [0x606b52, 0x7d7a5b], belly: 0x9fb2bd, scale: 5 }, glass: H.glass, hull, cabin: H.cabin,
      rotors: [
        { pos: [0, 8.1, 5.5], axis: 'y', dir: 1, rate: 16, geos: rotor(8, 16, 0.8, { droop: 0.035, hub: 0.6 }) },
        { pos: [-0.6, 7.6, -17.6], axis: 'x', dir: 1, rate: 45, geos: smallRotor(5, 3.8, 0.4).map((g) => g.rotateZ(Math.PI / 2)) },
      ],
    };
  },

  /** Ka-52: side-by-side cockpit with framed flat panels, sensor turret in the nose, stub wings with four pylons,
   * coaxial three-blade rotors, twin end-plate fins, 30 mm cannon on the right side. */
  attackheli: (def) => {
    const sq = 2.6;
    const st = [[4.7, 0.15, 1.2, 1.45], [4.3, 0.45, 0.95, 1.95], [3.6, 0.72, 0.8, 2.5], [2.8, 0.84, 0.75, 2.86], [1.8, 0.86, 0.72, 2.9], [1.15, 0.86, 0.72, 2.75],
      [0.0, 0.85, 0.75, 2.45], [-1.2, 0.7, 0.95, 2.3], [-2.5, 0.42, 1.35, 2.2], [-4.5, 0.3, 1.55, 2.1], [-6.0, 0.22, 1.65, 2.05]];
    const H = heliBody(def, st, { sq, deck: { z0: 1.25, z1: 3.9, floor: 1.28, sill: 1.92, panelZ: 3.4, roof: 2.6, lift: 0.4,
      holes: [{ z0: 3.25, z1: 3.85, v0: 0.12, v1: 0.48, glass: true }, { z0: 3.25, z1: 3.85, v0: 0.52, v1: 0.88, glass: true },
        { z0: 1.5, z1: 3.15, v0: 0.04, v1: 0.42, glass: true }, { z0: 1.5, z1: 3.15, v0: 0.58, v1: 0.96, glass: true }] } });
    const hull = H.hull;
    hull.push(cyl(0.18, 0.28, 1.0, 10, 0, 2.85, 0, DARK), sphere(0.3, 0, 1.0, 4.45, LENS), cyl(0.32, 0.32, 0.25, 12, 0, 1.2, 4.35, DARK),
      ...mirror([
        fuselage([[1.1, 0.25, 2.15, 2.55], [0.6, 0.33, 2.1, 2.7], [-0.6, 0.33, 2.1, 2.7], [-1.2, 0.22, 2.2, 2.55]], PAINT, 0.75, 12),
        tubeZ(0.14, 0.12, -1.35, -1.15, 0.75, 2.38, 10, DARK),
        wing({ x0: 0.75, x1: 3.3, le0: 0.8, c0: 1.1, le1: 0.6, c1: 0.7, y0: 1.5, y1: 1.45, t0: 0.12, t1: 0.1 }),
        box(0.08, 0.3, 0.3, 2.35, 1.35, 0.45, DARK), ...b8(2.35, 1.05, 0.45, 0.25, 1.6),
        box(0.08, 0.25, 0.3, 3.05, 1.38, 0.5, DARK), ...[[0.1, 0], [-0.1, 0], [0, 0.17]].map(([dx, dy]) => tubeZ(0.08, 0.08, -0.5, 1.3, 3.05 + dx, 1.15 + dy, 8, 0x6d7458)),
        fin({ x: 1.62, y0: 1.5, y1: 2.95, le0: -5.0, c0: 0.9, le1: -5.6, c1: 0.65, t0: 0.12, t1: 0.1 }),
        box(0.08, 0.5, 0.08, 0.85, 0.45, -0.6, DARK), tubeX(0.26, 0.2, 0.9, 0.26, -0.6, 12, RUBBER),
      ]),
      wing({ x0: -1.6, x1: 1.6, le0: -5.15, c0: 0.5, le1: -5.15, c1: 0.5, y0: 2.0, y1: 2.0, t0: 0.12, t1: 0.12 }),
      box(0.08, 0.6, 0.08, 0, 0.6, 3.5, DARK), tubeX(0.2, 0.18, 0, 0.2, 3.5, 10, RUBBER),
      STAR(0.66, 1.75, -2.8, 0.32), STAR(-0.66, 1.75, -2.8, 0.32), ...navLights(3.32, 1.47, 0.8));
    return {
      scheme: { base: [0x4b5154], belly: 0x5b6265 }, glass: H.glass, hull, cabin: H.cabin,
      mounts: { 2: { yaw: [box(0.3, 0.3, 0.6, 0, 0, 0, PAINT)], pitch: [box(0.22, 0.2, 0.7, 0, 0, 0.25, DARK), tubeZ(0.05, 0.045, 0.55, 2.2, 0, 0, 8, STEEL), tubeZ(0.07, 0.07, 2.0, 2.2, 0, 0, 8, DARK)] } },
      rotors: [
        { pos: [0, 3.2, 0], axis: 'y', dir: 1, rate: 30, geos: rotor(3, 5.8, 0.4, { droop: 0.02 }) },
        { pos: [0, 3.75, 0], axis: 'y', dir: -1, rate: 30, geos: rotor(3, 5.8, 0.4, { droop: 0.02 }) },
      ],
    };
  },

  /** Su-30: tandem cockpit under one long canopy, IRST ball, canards, LERX and cropped delta, widely spaced
   * nacelles with a tunnel, twin fins, tail sting, tip and pylon missiles. */
  fighter: (def) => {
    const sq = 2.6;
    const st = [[8.25, 0.08, 1.95, 2.05], [7.2, 0.42, 1.7, 2.35], [6.0, 0.58, 1.55, 2.6], [4.5, 0.7, 1.45, 2.7], [3.0, 0.75, 1.4, 2.65],
      [1.0, 0.9, 1.35, 2.45], [-2.0, 0.9, 1.35, 2.35], [-4.5, 0.6, 1.45, 2.25], [-6.0, 0.35, 1.6, 2.15]];
    const ck = jetCockpit(def, st, { z0: 2.95, z1: 6.55, floor: 1.85, sill: 2.45, panelZ: 5.86, sq, canopy: [[6.55, 2.62], [6.0, 3.02], [5.0, 3.2], [3.9, 3.25], [2.95, 2.75]], bows: [5.95, 4.4], extra: [[0, 2.3, 3.85]], mirrorZ: 5.9 });
    const W = { x0: 0.9, x1: 5.3, le0: 1.2, c0: 4.2, le1: -2.05, c1: 0.95, y0: 2.08, y1: 2.05, t0: 0.06, t1: 0.05 };
    const T = { x0: 1.1, x1: 3.4, le0: -4.4, c0: 2.2, le1: -6.0, c1: 0.6, y0: 1.95, y1: 1.95, t0: 0.05, t1: 0.04 };
    return {
      scheme: { base: [0x93abbb, 0x7392a8, 0x55748f], belly: 0xbac6ce, scale: 2.8 }, glass: ck.glass, cabin: ck.cabin,
      hull: [
        fuselage(cutFuselage(st, 2.95, 6.55, 1.85), PAINT, 0, 18, sq), ...ck.hull,
        cone(0.42, 1.1, 14, 0, 2.0, 7.7, 0xd9dcd8, Math.PI / 2), ...pitot(8.25, 8.95, 2.0),
        sphere(0.13, 0.25, 2.6, 6.75, LENS), box(0.2, 0.1, 0.25, 0.25, 2.52, 6.75, DARK), // IRST ball
        box(1.1, 0.05, 1.4, 0, 2.68, 1.0, DARK, -0.12), // spine air brake
        ...mirror([
          fuselage([[2.25, 0.45, 1.05, 1.75], [1.6, 0.53, 1.0, 1.85], [0.0, 0.55, 1.0, 1.9], [-4.8, 0.5, 1.15, 1.95], [-6.6, 0.42, 1.25, 1.85]], PAINT, 1.15, 16),
          box(0.8, 0.7, 0.05, 1.15, 1.4, 2.25, DARK), ...nozzle(1.15, 1.55, -6.6, 0.4, 0.55),
          wing({ x0: 0.6, x1: 1.0, le0: 4.6, c0: 3.8, le1: 1.4, c1: 0.6, y0: 2.12, y1: 2.1, t0: 0.05, t1: 0.04 }), // LERX
          wing({ x0: 0.35, x1: 1.75, le0: 2.6, c0: 9.4, le1: 1.6, c1: 8.6, y0: 2.12, y1: 1.95, t0: 0.055, t1: 0.04, color: PAINT }), // flat centre body over the tunnel
          wing(W), wingLine(W, 0.72, 0.05, 0.6), wingLine(W, 0.72, 0.62, 0.95), wingLine(W, 0.08, 0.1, 0.9, 0x5e7a8c),
          wing({ x0: 0.55, x1: 1.85, le0: 4.95, c0: 0.95, le1: 4.35, c1: 0.32, y0: 2.22, y1: 2.24, t0: 0.05, t1: 0.04 }), // canard
          fin({ x: 1.2, y0: 2.3, y1: 4.45, le0: -3.2, c0: 2.5, le1: -5.4, c1: 1.0, t0: 0.06, t1: 0.05 }), box(0.03, 1.5, 0.03, 1.2, 3.4, -5.65, DARK),
          wing(T), wingLine(T, 0.7, 0.05, 0.9),
          ...aam(5.36, 2.05, -1.4, 2.4), ...aam(3.4, 1.75, -0.9, 2.2), ...aam(4.35, 1.8, -1.35, 3.0, 0.1, 0xb8bcb8),
          STAR(1.26, 3.3, -4.6, 0.42, 1),
        ]),
        ...navLights(5.32, 2.06, -0.9),
        box(0.4, 0.38, 2.0, 0, 2.15, -6.8, PAINT), cone(0.2, 0.5, 10, 0, 2.15, -7.95, PAINT, -Math.PI / 2), // tail sting
        ...antenna(0, 2.65, 0.3),
      ],
    };
  },

  /** Su-27: single seat under a big bubble, IRST ball, LERX blending into a cropped delta, nacelles with the tunnel,
   * twin fins, sting, tip missiles. */
  fighter2: (def) => {
    const sq = 2.6;
    const st = [[10.95, 0.06, 2.35, 2.42], [10.0, 0.42, 2.1, 2.8], [8.6, 0.62, 1.95, 3.05], [6.6, 0.75, 1.95, 3.25], [4.5, 0.85, 2.0, 3.25],
      [2.0, 0.9, 2.05, 3.0], [-3.0, 0.8, 2.05, 2.8], [-7.5, 0.55, 2.1, 2.7], [-10.9, 0.3, 2.25, 2.6]];
    const ck = jetCockpit(def, st, { z0: 4.15, z1: 7.75, floor: 2.5, sill: 3.1, panelZ: 6.8, sq, canopy: [[7.75, 3.3], [7.05, 3.78], [6.0, 3.98], [5.0, 3.88], [4.15, 3.42]], bows: [7.0], mirrorZ: 6.95 });
    const W = { x0: 1.6, x1: 7.35, le0: 0.6, c0: 6.0, le1: -4.2, c1: 1.2, y0: 2.42, y1: 2.4, t0: 0.05, t1: 0.04 };
    const T = { x0: 2.0, x1: 4.9, le0: -7.3, c0: 3.0, le1: -9.3, c1: 0.8, y0: 2.05, y1: 2.05, t0: 0.05, t1: 0.04 };
    return {
      scheme: { base: [0x96acba, 0x7393a9, 0x5a7891], belly: 0xbcc8d0, scale: 3.0 }, glass: ck.glass, cabin: ck.cabin,
      hull: [
        fuselage(cutFuselage(st, 4.15, 7.75, 2.5), PAINT, 0, 18, sq), ...ck.hull,
        cone(0.55, 1.2, 14, 0, 2.38, 10.35, 0xd6dad6, Math.PI / 2), ...pitot(10.9, 11.6, 2.38),
        sphere(0.14, 0.25, 3.33, 7.95, LENS), box(0.22, 0.1, 0.26, 0.25, 3.24, 7.95, DARK),
        box(1.0, 0.05, 1.5, 0, 3.03, 2.6, DARK, -0.1),
        ...mirror([
          fuselage([[2.65, 0.62, 1.15, 2.05], [1.5, 0.7, 1.1, 2.15], [-4.0, 0.66, 1.15, 2.25], [-8.4, 0.6, 1.25, 2.2], [-9.8, 0.55, 1.3, 2.1]], PAINT, 1.55, 16),
          box(1.2, 0.85, 0.05, 1.55, 1.6, 2.62, DARK), ...nozzle(1.55, 1.7, -9.8, 0.52, 0.6),
          wing({ x0: 0.8, x1: 1.6, le0: 6.8, c0: 6.3, le1: 3.0, c1: 2.6, y0: 2.62, y1: 2.45, t0: 0.05, t1: 0.05 }),
          wing({ x0: 0.45, x1: 2.15, le0: 3.2, c0: 12.2, le1: 2.2, c1: 11.2, y0: 2.5, y1: 2.3, t0: 0.05, t1: 0.035, color: PAINT }), // flat centre body over the tunnel
          wing(W), wingLine(W, 0.75, 0.05, 0.6), wingLine(W, 0.75, 0.62, 0.95), wingLine(W, 0.08, 0.1, 0.9, 0x5e7a8c),
          fin({ x: 2.15, y0: 2.7, y1: 5.9, le0: -5.6, c0: 2.7, le1: -8.0, c1: 1.3, t0: 0.06, t1: 0.05 }), box(0.03, 2.2, 0.03, 2.15, 4.4, -8.4, DARK),
          wing(T), wingLine(T, 0.7, 0.05, 0.9),
          ...aam(7.42, 2.42, -4.8, 2.4), ...aam(4.0, 2.1, -2.4, 2.3), ...aam(5.4, 2.12, -3.1, 3.2, 0.1, 0xb8bcb8),
          STAR(2.22, 4.4, -7.9, 0.45, 1), box(0.12, 0.4, 0.7, 2.15, 5.6, -8.9, TEAM),
        ]),
        ...navLights(7.38, 2.42, -4.15),
        box(0.4, 0.4, 2.2, 0, 2.45, -10.6, PAINT), cone(0.2, 0.5, 10, 0, 2.45, -11.95, PAINT, -Math.PI / 2), ...antenna(0, 3.0, 1.0),
      ],
    };
  },

  /** MiG-31: long nose, tandem cockpit (the rear seat with its own glazing), huge rectangular intakes, shoulder
   * wing, canted twin fins, ventral fins, big nozzles, four R-33 semi-recessed under the belly. */
  fighter3: (def) => {
    const sq = 3.2;
    const st = [[11.35, 0.06, 2.55, 2.62], [10.4, 0.45, 2.3, 3.0], [8.6, 0.7, 2.15, 3.35], [6.4, 0.85, 2.2, 3.55], [4.0, 1.05, 2.2, 3.55],
      [0.0, 1.35, 2.05, 3.45], [-6.0, 1.35, 2.05, 3.35], [-10.2, 1.2, 2.15, 3.2], [-11.3, 1.05, 2.2, 3.1]];
    const ck = jetCockpit(def, st, { z0: 3.55, z1: 8.05, floor: 2.75, sill: 3.35, panelZ: 7.3, sq, canopy: [[8.05, 3.55], [7.35, 4.02], [6.4, 4.17], [5.2, 4.17], [4.2, 3.92], [3.55, 3.5]], bows: [7.3, 5.85], extra: [[0, 3.15, 5.15]], mirrorZ: 7.25, rearPanel: 5.85 });
    const W = { x0: 1.9, x1: 6.73, le0: 1.0, c0: 6.8, le1: -5.0, c1: 1.2, y0: 3.2, y1: 3.08, t0: 0.05, t1: 0.04 };
    const T = { x0: 1.3, x1: 4.4, le0: -8.0, c0: 2.8, le1: -9.8, c1: 0.8, y0: 2.62, y1: 2.6, t0: 0.05, t1: 0.04 };
    return {
      scheme: { base: [0x9aa39e, 0x7d8783], belly: 0xb9c1c3, scale: 3.5 }, glass: ck.glass, cabin: ck.cabin,
      hull: [
        fuselage(cutFuselage(st, 3.55, 8.05, 2.75), PAINT, 0, 18, sq), ...ck.hull,
        cone(0.62, 1.4, 14, 0, 2.6, 10.65, 0xd6dad6, Math.PI / 2), ...pitot(11.3, 12.0, 2.6),
        ...mirror([
          side([[4.65, 2.0], [4.15, 3.35], [-2.6, 3.35], [-3.4, 3.0], [-3.4, 2.15], [-2.0, 2.0]], 0.9, PAINT, 1.68), // raked intake trunk, blended into the fuselage
          box(0.8, 1.3, 0.05, 1.7, 2.67, 4.36, DARK, -0.36), box(0.66, 1.1, 0.04, 1.7, 2.62, 4.22, 0x3a3c3e, -0.36),
          box(0.05, 1.38, 0.05, 2.14, 2.67, 4.42, STEEL, -0.36), // intake lip
          wing(W), wingLine(W, 0.75, 0.05, 0.6), wingLine(W, 0.75, 0.62, 0.95), ...aam(6.73, 3.0, -4.4, 2.1),
          fin({ x: 1.75, y0: 3.4, y1: 6.15, le0: -6.4, c0: 2.6, le1: -9.0, c1: 1.3, t0: 0.06, t1: 0.05, cant: -0.14 }),
          fin({ x: 1.6, y0: 1.6, y1: 2.2, le0: -7.2, c0: 1.5, le1: -8.0, c1: 0.9, t0: 0.06, t1: 0.05, cant: 0.4 }), // ventral fin
          wing(T), wingLine(T, 0.7, 0.05, 0.9),
          ...nozzle(0.75, 2.65, -11.25, 0.62, 0.55),
          ...[-1.2, -5.4].map((z) => [tubeZ(0.19, 0.19, z - 2.0, z + 1.6, 0.95, 1.8, 10, 0xd2d6d2), cone(0.19, 0.5, 10, 0.95, 1.8, z + 1.85, 0xd2d6d2, Math.PI / 2)]).flat(),
          STAR(1.82, 4.8, -8.6, 0.45, 1), box(0.12, 0.4, 0.8, 1.75, 5.85, -9.6, TEAM),
        ]),
        ...navLights(6.75, 3.08, -4.0), ...antenna(0, 3.55, 1.5),
      ],
    };
  },

  /** Yak-130: stepped tandem cockpit (raised rear seat), LERX, shoulder wing with slight anhedral, intakes under the
   * LERX, single fin, rocket pods and tip rails. */
  lightattack: (def) => {
    const sq = 2.6;
    const st = [[5.8, 0.06, 1.7, 1.78], [5.0, 0.38, 1.45, 2.05], [3.8, 0.55, 1.28, 2.35], [2.4, 0.6, 1.2, 2.55], [0.5, 0.7, 1.15, 2.45],
      [-2.5, 0.6, 1.2, 2.3], [-4.6, 0.42, 1.35, 2.2], [-5.65, 0.34, 1.45, 2.1]];
    const ck = jetCockpit(def, st, { z0: -0.15, z1: 3.65, floor: 1.8, sill: 2.4, panelZ: 3.35, sq, canopy: [[3.65, 2.55], [3.0, 3.12], [2.2, 3.27], [1.2, 3.37], [0.3, 3.12], [-0.15, 2.62]], bows: [3.0, 1.75], extra: [[0, 2.42, 1.3]], mirrorZ: 2.95 });
    const W = { x0: 0.65, x1: 4.9, le0: 0.55, c0: 3.15, le1: -1.35, c1: 0.85, y0: 1.72, y1: 1.58, t0: 0.09, t1: 0.08 };
    const T = { x0: 0.3, x1: 2.3, le0: -4.1, c0: 1.5, le1: -4.9, c1: 0.45, y0: 1.97, y1: 1.97, t0: 0.07, t1: 0.06 };
    return {
      scheme: { base: [0x7b8483, 0x5f6866], belly: 0xa9b6bd, scale: 3.4 }, glass: ck.glass, cabin: ck.cabin,
      hull: [
        fuselage(cutFuselage(st, -0.15, 3.65, 1.8), PAINT, 0, 18, sq), ...ck.hull,
        box(0.6, 0.3, 0.9, 0, 2.1, 1.4, COCKPIT2), // raised rear seat floor
        ...pitot(5.75, 6.2, 1.75),
        ...mirror([
          wing({ x0: 0.55, x1: 0.95, le0: 3.2, c0: 2.6, le1: 0.6, c1: 0.4, y0: 1.86, y1: 1.85, t0: 0.05, t1: 0.04 }), // LERX
          wing(W), wingLine(W, 0.72, 0.05, 0.6), wingLine(W, 0.72, 0.62, 0.95),
          fuselage([[1.65, 0.25, 1.15, 1.75], [0.8, 0.38, 1.1, 1.85], [-1.6, 0.36, 1.15, 1.8], [-2.6, 0.22, 1.2, 1.7]], PAINT, 0.75, 12),
          tubeZ(0.26, 0.26, 1.6, 1.66, 0.75, 1.45, 12, DARK), ...nozzle(0.75, 1.78, -5.6, 0.29, 0.4),
          ...[1.9, 2.9, 3.9].map((x) => box(0.06, 0.3, 0.7, x, 1.5, -1.2, DARK)), ...b8(1.9, 1.15, -1.2, 0.2, 1.5), ...b8(2.9, 1.18, -1.2, 0.2, 1.4), ...aam(3.9, 1.3, -1.3, 2.0),
          ...aam(4.95, 1.62, -1.7, 1.6), wing(T), wingLine(T, 0.7, 0.05, 0.9),
          STAR(0.72, 1.9, -1.6, 0.32, 1),
        ]),
        ...navLights(4.92, 1.6, -1.2),
        fin({ x: 0, y0: 2.2, y1: 4.7, le0: -3.2, c0: 1.8, le1: -4.9, c1: 0.85, t0: 0.08, t1: 0.06 }), box(0.03, 2.0, 0.03, 0, 3.5, -5.15, DARK),
        box(0.12, 0.4, 0.5, 0, 4.4, -5.3, TEAM), ...antenna(0, 2.3, -0.8),
      ],
    };
  },

  /** Il-112V: glazed flight deck with framed panes, hollow cargo hold (side seats, floor rollers, frames, overhead
   * services) closed by the rear ramp, high wing with two turboprops and six-blade propellers, T-tail, gear
   * sponsons, paratroop doors. */
  transportplane: (def) => {
    const sq = 2.2;
    const st = [[12.15, 0.3, 2.2, 2.8], [11.4, 1.0, 1.6, 3.45], [10.2, 1.45, 1.4, 4.05], [8.4, 1.65, 1.3, 4.35], [-3.6, 1.65, 1.3, 4.35],
      [-6.6, 1.35, 2.2, 4.4], [-9.6, 0.75, 3.4, 4.5], [-12.0, 0.35, 4.1, 4.6]];
    const H = heliBody(def, st, { sq, deck: { z0: 9.55, z1: 12.2, floor: 2.67, sill: 3.42, panelZ: 10.75, roof: 4.15, stick: true,
      holes: [{ z0: 11.0, z1: 11.6, v0: 0.18, v1: 0.47, glass: true }, { z0: 11.0, z1: 11.6, v0: 0.53, v1: 0.82, glass: true },
        { z0: 10.05, z1: 10.9, v0: 0.12, v1: 0.3, glass: true }, { z0: 10.05, z1: 10.9, v0: 0.7, v1: 0.88, glass: true }] },
      bay: { z0: -6.5, z1: 9.55, floor: 1.3, roof: 4.0, wins: [7.0, 4.0, 1.0, -2.0], door: [-4.9, -3.9], doorSeats: def.seats.map((q, i) => i).filter((i) => i > 1), winV: [0.16, 0.22] } });
    const hull = H.hull;
    const W = { x0: 1.2, x1: 13.8, le0: 2.6, c0: 3.1, le1: 1.7, c1: 1.3, y0: 4.55, y1: 4.75, t0: 0.15, t1: 0.12 };
    hull.push(box(2.6, 0.45, 3.2, 0, 4.45, 1.2, PAINT), // wing centre fairing
      ...mirror([
        wing(W), wingLine(W, 0.72, 0.03, 0.5), wingLine(W, 0.72, 0.52, 0.95), wingLine(W, 0.12, 0.05, 0.95, 0x5e6866),
        fuselage([[5.25, 0.45, 3.6, 4.2], [4.6, 0.62, 3.4, 4.5], [1.0, 0.62, 3.5, 4.6], [-1.6, 0.35, 3.9, 4.5]], PAINT, 4.3, 14),
        tubeZ(0.22, 0.22, -1.7, -1.4, 4.75, 3.9, 10, DARK), box(0.4, 0.2, 0.4, 4.3, 3.55, 4.6, DARK), // exhaust, oil cooler
        side([[-1.2, 0.7], [-1.2, 2.0], [3.2, 2.0], [3.2, 0.7]], 0.8, PAINT, 1.55), box(0.06, 1.3, 0.75, 1.65, 2.6, -4.3, DARK),
        box(0.14, 0.9, 0.14, 1.9, 0.6, 1.2, STEEL), tubeX(0.45, 0.32, 1.9, 0.45, 1.6, 14, RUBBER), tubeX(0.45, 0.32, 1.9, 0.45, 0.6, 14, RUBBER),
        wing({ x0: 0.2, x1: 5.0, le0: -11.0, c0: 1.8, le1: -11.7, c1: 0.9, y0: 8.85, y1: 8.85, t0: 0.12, t1: 0.1 }), box(0.06, 0.12, 0.7, 5.02, 8.85, -12.0, TEAM),
        box(0.05, 0.5, 1.6, 1.66, 3.2, 6.8, TEAM),
      ]),
      ...navLights(13.8, 4.75, 1.4),
      fin({ x: 0, y0: 4.4, y1: 8.9, le0: -8.4, c0: 2.9, le1: -11.6, c1: 1.4, t0: 0.14, t1: 0.11 }), box(0.03, 3.8, 0.03, 0, 6.6, -11.6, DARK),
      box(3.0, 0.06, 3.2, 0, 1.8, -8.0, DARK, 0.4), // rear ramp line
      box(0.12, 1.1, 0.12, 0, 0.95, 9.5, STEEL), tubeX(0.38, 0.5, 0, 0.38, 9.5, 12, RUBBER), // nose gear
      STAR(0.18, 7.4, -11.2, 0.6), STAR(-0.18, 7.4, -11.2, 0.6), ...antenna(0, 4.4, 6.0), ...antenna(0, 4.4, -2.0));
    // ramp inside the hold
    H.cabin.parts.push(box(2.6, 0.06, 3.0, 0, 2.2, -7.9, CABIN2, 0.42));
    return {
      scheme: { base: [0x6d7774], belly: 0x9eaab0 }, glass: H.glass, hull, cabin: H.cabin,
      rotors: [4.3, -4.3].map((x) => ({ pos: [x, 4.0, 5.6], axis: 'z', dir: x > 0 ? 1 : -1, rate: 40, geos: propeller(6, 1.95, 0.42) })),
    };
  },
};

/**
 * Helicopter / transport body: the fuselage opened over the flight deck and the cabin, framed glazing around the
 * flight deck, a hollow cabin with windows and a sliding door (left side), the flight deck furnished, and the
 * cabin / hold interior (drawn with the interior).
 */
function heliBody(def, st, o) {
  const sq = o.sq, d = o.deck, b = o.bay, hull = [], glass = [];
  let cut = st;
  if (b) cut = cutFuselage(cut, b.z0, b.z1, b.floor);
  cut = cutFuselage(cut, d.z0, d.z1, d.floor);
  hull.push(fuselage(cut, PAINT, 0, 20, sq));
  for (let z = d.z0 + 0.05; z < d.z1 - 0.3; z += 0.25) hull.push(box(Math.max(0.2, halfWidthAt(st, z + 0.25, d.floor + 0.05, sq) * 2 - 0.12), 0.03, 0.25, 0, d.floor + 0.015, z + 0.125, FLOOR));
  const holes = d.holes || [{ z0: d.z1 - 0.85, z1: d.z1 - 0.12, v0: 0.2, v1: 0.47, glass: true }, { z0: d.z1 - 0.85, z1: d.z1 - 0.12, v0: 0.53, v1: 0.8, glass: true },
    { z0: d.z0 + 0.25, z1: d.z1 - 1.0, v0: 0.06, v1: 0.36, glass: true }, { z0: d.z0 + 0.25, z1: d.z1 - 1.0, v0: 0.64, v1: 0.94, glass: true },
    { z0: d.z1 - 1.5, z1: d.z1 - 1.0, v0: 0.42, v1: 0.58, glass: true }];
  addShell(shell(st, { mode: 'band', yFloor: d.floor, z0: d.z0, z1: d.z1 + 0.05, v0: 0, v1: 1, sq, dz: 0.2, nv: 14, holes, thick: 0.03 }), hull, glass);
  const pil = seatG(def, 0);
  const crew = [pil];
  if (def.seats[1] && Math.abs(def.seats[1].pos[2] - def.seats[0].pos[2]) < 0.3) crew.push(seatG(def, 1));
  else if (d.copilot) crew.push({ x: -pil.x, y: pil.y, z: pil.z });
  // panel width: the narrowest the nose gets over the panel's height and depth; roof: the lowest skin over the deck
  let pwMin = 1e9, roofMin = 1e9;
  for (let z = d.panelZ - 0.1; z <= d.panelZ + 0.4; z += 0.1) for (let y = d.sill; y <= d.sill + 0.55; y += 0.1) pwMin = Math.min(pwMin, halfWidthAt(st, z, y, sq));
  for (let z = d.panelZ - 0.8; z <= d.panelZ; z += 0.1) roofMin = Math.min(roofMin, stationAt(st, z)[3] - 0.08);
  const fd = flightDeck(crew, { sill: d.sill, w: pwMin * 2 - 0.12, zPanel: d.panelZ, floor: d.floor, yRoof: roofMin });
  hull.push(...fd.parts);
  for (const i of d.rearSeats || []) { const q = seatG(def, i); hull.push(...tagInterior([box(0.46, 0.1, 0.44, q.x, q.y - 0.05, q.z, 0x3b4036), box(0.46, 0.6, 0.1, q.x, q.y + 0.3, q.z - 0.25, 0x3b4036, -0.12), box(0.3, q.y - d.floor - 0.1, 0.3, q.x, (q.y + d.floor) / 2 - 0.05, q.z, DARK)])); }
  const seats = [0, ...(crew.length > 1 && !d.copilot ? [1] : []), ...(d.rearSeats || [])];
  const cabinRec = { zB: d.z0, zF: 1e3, seats, wheel: { ...fd.stick, kind: d.stick ? 'stick' : 'cyclic', tilt: 0 }, doors: [], parts: [], ownBay: !!b };
  if (b) {
    const wv = b.winV || [0.14, 0.23];
    const win = (z) => [{ z0: z - 0.17, z1: z + 0.17, v0: wv[0], v1: wv[1], glass: true }, { z0: z - 0.17, z1: z + 0.17, v0: 1 - wv[1], v1: 1 - wv[0], glass: true }];
    const bh = [...b.wins.flatMap(win)];
    if (b.door) bh.push({ z0: b.door[0], z1: b.door[1], v0: 0, v1: 0.3 });
    addShell(shell(st, { mode: 'band', yFloor: b.floor, z0: b.z0, z1: d.z0, v0: 0, v1: 1, sq, dz: 0.3, nv: 14, holes: bh, inner: CABIN2 }), hull, glass);
    hull.push(box(halfWidthAt(st, d.z0, (d.floor + d.roof) / 2, sq) * 2 - 0.1, d.roof - b.floor, 0.05, 0, (d.roof + b.floor) / 2, d.z0 - 0.02, COCKPIT2)); // bulkhead
    cabinRec.parts = cabin({ z0: b.z0 + 0.05, z1: d.z0 - 0.05, floor: b.floor, roof: b.roof, wallX: (z, y) => halfWidthAt(st, z, Math.min(y, b.roof - 0.05), sq) - 0.05 });
    cabinRec.parts.push(box(halfWidthAt(st, b.z0, (b.floor + b.roof) / 2, sq) * 2 - 0.15, b.roof - b.floor - 0.1, 0.05, 0, (b.floor + b.roof) / 2, b.z0 + 0.04, CABIN2));
    if (b.door) {
      const dzc = (b.door[0] + b.door[1]) / 2, L = b.door[1] - b.door[0], h = Math.min(1.75, b.roof - b.floor - 0.3);
      const dx = halfWidthAt(st, dzc, b.floor + h * 0.6, sq) + 0.025;
      cabinRec.doors.push({ side: 1, x: dx, y: b.floor + 0.05, z: dzc, axis: 'slide', open: -(L + 0.1), seats: b.doorSeats,
        geo: [box(0.05, h, L + 0.04, 0, h / 2, 0, PAINT), box(0.06, 0.04, L, 0.01, h, 0, DARK), box(0.05, 0.05, 0.12, 0.03, h * 0.5, -L * 0.4, INT.CHROME), box(0.03, h - 0.15, L - 0.1, -0.03, h / 2, 0, CABIN)],
        glass: [box(0.02, 0.34, Math.min(0.34, L - 0.3), 0.02, h * 0.72, 0.1, GLASS)] });
    }
  }
  return { hull, glass, cabin: cabinRec };
}

/** Pintle PKT door gun: { yaw, pitch }. */
function lmg(barrel) {
  return {
    yaw: [box(0.06, 0.5, 0.06, 0, -0.3, 0, DARK), box(0.2, 0.06, 0.2, 0, -0.06, 0, STEEL)],
    pitch: [box(0.12, 0.15, 0.85, 0, 0, 0.3, DARK), box(0.16, 0.18, 0.22, 0.13, -0.04, 0.18, 0x4a5530), tubeZ(0.025, 0.02, 0.6, 0.6 + barrel, 0, 0.02, 8, STEEL),
      box(0.04, 0.12, 0.06, 0, -0.1, -0.05, DARK)],
  };
}

export { STEEL, RUBBER, CABIN, FLOOR, COCKPIT, airfoil, angleAt, stationAt, propeller, sphere, cone };
