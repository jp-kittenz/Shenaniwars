import { PAINT, TEAM, DARK, STEEL, RUBBER, GLASS, LENS, box, cyl, tubeX, mirror, wheelGeo, merge } from './kit.js';

/**
 * Glazed cabs and their interiors (trucks, cars, crew cabs), in ground coordinates (+Z forward, +X left, y = 0 on
 * the ground). A cab is built hollow: a solid base up to the cab floor, thin walls from the floor to the window
 * line, pillars, roof and window frames above it, and transparent panes (`glass`, drawn with the see-through
 * glazing material) in the openings, so the interior (seats, dashboard, steering column, door cards, roof liner)
 * reads from outside through the windows. Doors are separate hinged parts (with their own window pane) that open
 * while people get in or out; the steering wheel is an animated control placed at `wheel`.
 */

export const INT = {
  PLASTIC: 0x2f3234, DASH: 0x25282a, FABRIC: 0x3e4237, FABRIC2: 0x4a4b3f, LINER: 0x8e8c80, FLOOR: 0x1c1e1f,
  GAUGE: 0xd8d4c4, CARD: 0x4c5046, RED: 0xa3271f, AMBER: 0xd08a2a, SCREEN: 0x3c8a66, CHROME: 0x9aa3a6, LAMP: 0xfff2c8,
  INNER: 0x6a7262,
};

/**
 * Seat (cushion, backrest, headrest, slide base) facing +Z; `y` is the seat surface, `floor` the cab floor.
 * @param {number} x @param {number} y @param {number} z @param {number} floor
 */
export function seat(x, y, z, floor, o = {}) {
  const w = o.w ?? 0.5, c = o.color ?? INT.FABRIC, back = o.back ?? 0.62;
  const p = [
    box(w, 0.12, 0.5, x, y - 0.06, z, c),
    box(w * 0.92, 0.04, 0.42, x, y + 0.01, z + 0.01, INT.FABRIC2),
    box(w, back, 0.12, x, y + back / 2 + 0.02, z - 0.28, c, -0.14),
    ...[-1, 1].map((s) => box(0.07, 0.14, 0.46, x + s * (w / 2 - 0.02), y + 0.02, z, c)), // cushion bolsters
    ...[-1, 1].map((s) => box(0.07, back * 0.75, 0.13, x + s * (w / 2 - 0.02), y + back * 0.42, z - 0.27, c, -0.14)),
  ];
  if (o.headrest !== false) p.push(box(w * 0.55, 0.2, 0.1, x, y + back + 0.12, z - 0.36, c, -0.14), ...[-1, 1].map((s) => box(0.02, 0.1, 0.02, x + s * 0.08, y + back + 0.02, z - 0.35, INT.CHROME)));
  const base = y - 0.12 - floor;
  if (base > 0.04) p.push(box(w * 0.7, base, 0.38, x, floor + base / 2, z, INT.PLASTIC), box(w * 0.8, 0.03, 0.42, x, floor + 0.02, z, STEEL));
  return p;
}

/** Gauge dial facing -Z (toward the driver) at (x, y, z). */
function gauge(x, y, z, r, tilt = 0) {
  return [cyl(r, r, 0.02, 12, x, y, z, INT.GAUGE, Math.PI / 2 + tilt), cyl(r * 1.15, r * 1.15, 0.015, 12, x, y, z + 0.008, INT.DASH, Math.PI / 2 + tilt),
    box(r * 0.9, 0.012, 0.012, x + r * 0.3, y + r * 0.2, z - 0.015, INT.RED, 0, 0, 0.6)];
}

/**
 * Dashboard across the cab: padded top, instrument cluster with dials in front of the driver, centre console
 * (radio / screens / switches), glovebox and vents. `zF` is the inside of the front wall, `yTop` the dash top.
 */
export function dashboard(zF, yTop, w, driverX, o = {}) {
  const d = o.depth ?? 0.42, h = o.height ?? 0.42, z = zF - d / 2;
  const p = [
    box(w - 0.12, h, d, 0, yTop - h / 2, z, INT.DASH),
    box(w - 0.12, 0.05, d + 0.04, 0, yTop + 0.01, z - 0.02, INT.PLASTIC, 0.12), // padded top
    box(0.6, 0.16, 0.2, driverX, yTop + 0.04, zF - d - 0.02, INT.DASH, -0.2), // cluster hood
    box(0.55, 0.2, 0.02, driverX, yTop - 0.06, zF - d - 0.005, INT.PLASTIC),
  ];
  // dials: speedo + tacho, four small gauges, warning lamps
  p.push(...gauge(driverX + 0.13, yTop - 0.05, zF - d - 0.02, 0.07), ...gauge(driverX - 0.13, yTop - 0.05, zF - d - 0.02, 0.07));
  for (let i = 0; i < 4; i++) p.push(...gauge(driverX - 0.3 + i * 0.2 + (i > 1 ? 0.2 : 0), yTop - 0.17, zF - d - 0.02, 0.035));
  for (let i = 0; i < 5; i++) p.push(box(0.025, 0.02, 0.01, driverX - 0.1 + i * 0.05, yTop + 0.04, zF - d - 0.03, [INT.RED, INT.AMBER, INT.SCREEN, INT.AMBER, INT.RED][i]));
  // centre console: radio, a small screen, switch rows, vents
  const cx = o.consoleX ?? 0;
  p.push(box(0.42, h + 0.05, 0.12, cx, yTop - h / 2 - 0.03, zF - d - 0.05, INT.PLASTIC),
    box(0.3, 0.1, 0.02, cx, yTop - 0.12, zF - d - 0.115, INT.DASH), box(0.22, 0.05, 0.01, cx, yTop - 0.12, zF - d - 0.125, INT.SCREEN),
    ...[0, 1, 2, 3, 4].map((i) => box(0.03, 0.04, 0.02, cx - 0.12 + i * 0.06, yTop - 0.26, zF - d - 0.115, i === 2 ? INT.RED : INT.GAUGE)),
    ...[-1, 1].map((s) => box(0.14, 0.06, 0.02, cx + s * 0.13, yTop - 0.02, zF - d - 0.115, LENS)),
    ...[-1, 1].map((s) => box(0.12, 0.07, 0.02, s * (w / 2 - 0.2), yTop - 0.06, zF - d - 0.005, LENS))); // side vents
  // glovebox on the passenger side
  p.push(box(0.4, 0.18, 0.02, -driverX, yTop - 0.18, zF - d - 0.005, INT.PLASTIC), box(0.08, 0.02, 0.02, -driverX, yTop - 0.1, zF - d - 0.02, INT.CHROME));
  return p;
}

/**
 * Driver's controls fixed to the cab: steering column (the wheel itself is the animated control), pedals,
 * gear lever and handbrake. `wheel` = {x, y, z, tilt}; the column runs from the wheel hub along the wheel's axis.
 */
export function driverControls(wheel, floor, seatX, seatZ, o = {}) {
  const { x, y, z, tilt } = wheel;
  const L = o.column ?? 0.6, dy = -Math.sin(tilt), dz = Math.cos(tilt);
  const p = [cyl(0.045, 0.06, L, 8, x, y + dy * L / 2, z + dz * L / 2, INT.PLASTIC, tilt + Math.PI / 2),
    box(0.16, 0.08, 0.1, x, y + dy * 0.12, z + dz * 0.12, INT.PLASTIC, tilt)]; // column shroud + stalks
  p.push(box(0.2, 0.012, 0.012, x, y + dy * 0.1 + 0.02, z + dz * 0.1, INT.PLASTIC));
  // pedals: clutch, brake, accelerator
  for (const [dx, wd] of [[0.17, 0.08], [0.02, 0.09], [-0.15, 0.06]]) p.push(box(wd, 0.12, 0.03, seatX + dx, floor + 0.14, seatZ + 0.75, RUBBER, -0.6), box(0.02, 0.2, 0.02, seatX + dx, floor + 0.24, seatZ + 0.82, STEEL, -0.3));
  // gear lever (inboard of the driver) and handbrake
  const gx = seatX - Math.sign(seatX || 1) * (o.gearOff ?? 0.4), gy = o.gearFloor ?? floor;
  p.push(box(0.16, 0.06, 0.16, gx, gy + 0.03, seatZ + 0.35, RUBBER), cyl(0.012, 0.015, 0.5, 5, gx, gy + 0.28, seatZ + 0.37, INT.CHROME, -0.2),
    cyl(0.035, 0.035, 0.035, 8, gx, gy + 0.53, seatZ + 0.32, INT.PLASTIC), box(0.04, 0.22, 0.04, gx - Math.sign(seatX || 1) * 0.1, gy + 0.12, seatZ + 0.1, INT.PLASTIC, 0.5));
  return p;
}

/**
 * Hollow cab body with window openings, glass and hinged doors.
 * @param {{zB:number, zF:number, yB:number, yF:number, yBelt:number, yRoof:number, w:number, rake?:number,
 *   split?:boolean, door?:number[], doorBottom?:number, quarter?:boolean, rearWin?:boolean, pillar?:number,
 *   roofCrown?:number, frontWall?:number, armoured?:boolean, color?:number}} o
 * @returns {{hull:any[], glass:any[], doors:any[], inner:any[]}}
 */
export function cabShell(o) {
  const { zB, zF, yB, yF, yBelt, yRoof, w } = o;
  const C = o.color ?? PAINT, U = o.upper ?? C, hw = w / 2, t = 0.05, pil = o.pillar ?? 0.09, rake = o.rake ?? 0.25;
  const hWin = yRoof - yBelt, aRake = Math.atan2(rake, hWin), lenW = Math.hypot(rake, hWin);
  const fw = o.frontWall ?? 0.14;
  const [d0, d1] = o.door ?? [zB + 0.15, zF - 0.25];
  const hull = [], glass = [], inner = [], doors = [];
  // base below the floor, front wall (behind the grille) up to the window line, back wall
  hull.push(box(w, yF - yB, zF - zB, 0, (yB + yF) / 2, (zB + zF) / 2, C));
  hull.push(box(w, yBelt - yF + 0.02, fw, 0, (yF + yBelt) / 2, zF - fw / 2, C));
  if (o.rearWin) {
    const ww = Math.min(1.1, w * 0.45), wy0 = yBelt + 0.12, wy1 = yRoof - 0.18;
    hull.push(box(w, Math.min(wy0, yBelt) - yF, t, 0, (yF + Math.min(wy0, yBelt)) / 2, zB + t / 2, C), box(w, wy0 - Math.min(wy0, yBelt) + 0.001, t, 0, (wy0 + Math.min(wy0, yBelt)) / 2, zB + t / 2, U), box(w, yRoof - wy1, t, 0, (wy1 + yRoof) / 2, zB + t / 2, U));
    for (const s of [-1, 1]) hull.push(box(hw - ww / 2, wy1 - wy0, t, s * (hw + ww / 2) / 2, (wy0 + wy1) / 2, zB + t / 2, U));
    glass.push(box(ww + 0.02, wy1 - wy0 + 0.02, 0.02, 0, (wy0 + wy1) / 2, zB + t / 2, GLASS));
  } else hull.push(box(w, yRoof - yF, t, 0, (yF + yRoof) / 2, zB + t / 2, C));
  for (const s of [-1, 1]) {
    const xs = s * (hw - t / 2);
    // side walls floor→belt outside the door opening
    if (d0 - zB > 0.02) hull.push(box(t, yBelt - yF, d0 - zB, xs, (yF + yBelt) / 2, (zB + d0) / 2, C));
    if (zF - fw - d1 > 0.02) hull.push(box(t, yBelt - yB, zF - fw - d1, xs, (yB + yBelt) / 2, (d1 + zF - fw) / 2, C));
    // A pillar (raked), B pillar at the door's rear edge, C pillar at the back corner
    hull.push(box(pil, lenW, pil, s * (hw - pil / 2), (yBelt + yRoof) / 2, zF - 0.02 - rake / 2, C, -aRake));
    hull.push(box(pil, hWin, pil, s * (hw - pil / 2), (yBelt + yRoof) / 2, d0 + pil / 2, U));
    hull.push(box(pil, hWin, pil, s * (hw - pil / 2), (yBelt + yRoof) / 2, zB + pil / 2, U));
    // quarter window (or a closed panel) between the door and the back of the cab
    const ql = d0 - zB - pil * 1.5;
    if (ql > -0.05) {
      if (o.quarter && ql > 0.15) {
        glass.push(box(0.02, hWin - 0.06, ql + 0.02, s * (hw - 0.03), (yBelt + yRoof) / 2, (zB + d0) / 2 + pil * 0.25, GLASS));
        hull.push(box(t, 0.05, ql, s * (hw - t / 2), yBelt + 0.02, (zB + d0) / 2, C), box(t, 0.06, ql, s * (hw - t / 2), yRoof - 0.04, (zB + d0) / 2, U));
      } else hull.push(box(t, hWin, Math.max(0.05, d0 - zB), s * (hw - t / 2), (yBelt + yRoof) / 2, (zB + d0) / 2, U));
    }
    // fixed panel / window between the A pillar and the door's front edge
    const fz0 = d1, fz1 = zF - 0.02 - rake * 0.15;
    if (fz1 - fz0 > 0.1) glass.push(box(0.02, hWin * 0.85, fz1 - fz0, s * (hw - 0.03), yBelt + hWin * 0.43, (fz0 + fz1) / 2, GLASS));
    // rain gutter
    hull.push(box(0.04, 0.04, zF - rake - zB, s * (hw + 0.01), yRoof - 0.03, (zF - rake + zB) / 2, DARK));
  }
  // windscreen: cowl, header, pillar(s) and pane(s)
  const zW = zF - 0.02 - rake / 2, yW = (yBelt + yRoof) / 2;
  hull.push(box(w, 0.07, fw + 0.12, 0, yBelt + 0.01, zF - (fw + 0.12) / 2, C));
  hull.push(box(w, 0.1, 0.16, 0, yRoof - 0.06, zF - rake - 0.06, C));
  // roof (slightly crowned)
  const crown = o.roofCrown ?? 0.05;
  hull.push(box(w + 0.03, 0.07, zF - rake - zB + 0.06, 0, yRoof, (zF - rake + zB) / 2, U), box(w - 0.4, crown, zF - rake - zB - 0.2, 0, yRoof + 0.035 + crown / 2, (zF - rake + zB) / 2, U));
  if (o.split) {
    hull.push(box(0.08, lenW, 0.06, 0, yW, zW, C, -aRake));
    for (const s of [-1, 1]) glass.push(box(hw - pil - 0.06, lenW - 0.1, 0.02, s * (hw - pil + 0.04) / 2, yW, zW - 0.01, GLASS, -aRake));
  } else glass.push(box(w - pil * 2 + 0.04, lenW - 0.1, 0.02, 0, yW, zW - 0.01, GLASS, -aRake));
  // wipers
  for (const s of [-1, 1]) hull.push(box(0.5, 0.025, 0.025, s * hw * 0.42, yBelt + 0.08, zF - 0.05 - 0.04, DARK, -aRake, 0, s * 0.25));

  // interior skin: inner door-line panels, back wall, roof liner
  inner.push(box(w - 0.12, 0.03, zF - rake - zB - 0.1, 0, yRoof - 0.06, (zF - rake + zB) / 2, INT.LINER));
  inner.push(box(w - 0.12, yRoof - yF - 0.1, 0.03, 0, (yF + yRoof) / 2, zB + t + 0.02, INT.INNER));
  inner.push(box(w - 0.1, 0.02, zF - fw - zB - 0.08, 0, yF + 0.012, (zF - fw + zB) / 2, INT.FLOOR));
  for (const s of [-1, 1]) if (d0 - zB > 0.12) inner.push(box(0.03, yBelt - yF - 0.05, d0 - zB - 0.08, s * (hw - t - 0.02), (yF + yBelt) / 2, (zB + d0) / 2, INT.INNER));

  // doors (hinged at the front edge); window frame and inner card are part of the door, the pane is its own glass
  const yDb = o.doorBottom ?? yB + 0.08, L = d1 - d0;
  const doorSides = o.doorSides ?? [-1, 1];
  for (const s of [-1, 1]) {
    if (!doorSides.includes(s)) {
      // no door this side: solid wall below the window line, fixed pane above
      hull.push(box(t, yBelt - yB, L, s * (hw - t / 2), (yB + yBelt) / 2, (d0 + d1) / 2, C), box(t, 0.07, L, s * (hw - t / 2), yRoof - 0.05, (d0 + d1) / 2, C));
      glass.push(box(0.02, hWin - 0.1, L, s * (hw - 0.03), (yBelt + yRoof) / 2, (d0 + d1) / 2, GLASS));
      inner.push(box(0.03, yBelt - yF - 0.05, L - 0.08, s * (hw - t - 0.02), (yF + yBelt) / 2, (d0 + d1) / 2, INT.CARD));
      continue;
    }
    const g = [], dg = [];
    const hLow = yBelt - yDb;
    g.push(box(t, hLow, L, 0, hLow / 2, -L / 2, C)); // outer skin below the window
    g.push(box(t, hWin - 0.02, 0.07, 0, hLow + hWin / 2, -L + 0.035, U), box(t, 0.07, L, 0, hLow + hWin - 0.05, -L / 2, U), box(t, hWin - 0.02, 0.06, 0, hLow + hWin / 2, -0.03, U));
    g.push(box(0.02, 0.012, L - 0.1, s * 0.03, hLow - 0.25, -L / 2, DARK)); // swage line
    g.push(box(0.04, 0.04, 0.18, s * 0.035, hLow - 0.12, -L + 0.22, DARK), box(0.03, 0.06, 0.06, s * 0.035, hLow - 0.12, -L + 0.12, INT.CHROME)); // handle + lock
    if (o.armoured) g.push(box(0.07, hLow - 0.1, L - 0.08, s * 0.05, hLow / 2 + 0.05, -L / 2, C), ...[0.15, L - 0.15].flatMap((zz) => [0.2, hLow - 0.2].map((yy) => cyl(0.025, 0.025, 0.02, 6, s * 0.09, yy, -zz, DARK, 0, 0, Math.PI / 2))));
    // inner door card with armrest, handle and window winder
    const yIn = Math.max(0.05, yF - yDb);
    g.push(box(0.03, hLow - yIn - 0.02, L - 0.1, -s * 0.035, yIn + (hLow - yIn) / 2, -L / 2, INT.CARD),
      box(0.08, 0.05, L * 0.45, -s * 0.07, yIn + (hLow - yIn) * 0.55, -L * 0.45, INT.PLASTIC),
      box(0.03, 0.04, 0.12, -s * 0.06, yIn + (hLow - yIn) * 0.8, -L * 0.25, INT.CHROME),
      cyl(0.05, 0.05, 0.02, 8, -s * 0.06, yIn + (hLow - yIn) * 0.38, -L * 0.6, INT.PLASTIC, 0, 0, Math.PI / 2));
    dg.push(box(0.02, hWin - 0.12, L - 0.13, 0, hLow + hWin / 2 - 0.02, -L / 2, GLASS));
    doors.push({ side: s, x: s * (hw + 0.006), y: yDb, z: d1, geo: g, glass: dg });
  }
  return { hull, glass, doors, inner };
}

/**
 * Cab interior for the given seats (ground coordinates) under a cab built by cabShell: seats, dashboard, driver's
 * controls, engine hump (cab-over), sun visors, dome lamp, grab handles; optional sleeper bunk behind the seats.
 * @param {any} o cabShell options @param {{x:number,y:number,z:number,driver?:boolean}[]} seats
 */
export function cabInterior(o, seats, wheel, extra = {}) {
  const { zB, zF, yF, yBelt, yRoof, w } = o;
  const p = [];
  const fw = o.frontWall ?? 0.14, zIn = zF - fw;
  const drv = seats.find((s) => s.driver) || seats[0];
  const yDash = Math.min(yBelt + 0.02, drv.y + 0.62);
  p.push(...dashboard(zIn, yDash, w, drv.x, { depth: extra.dashDepth ?? 0.4, height: Math.min(0.5, yDash - yF - 0.05) }));
  for (const s of seats) p.push(...seat(s.x, s.y, s.z, yF, { w: s.w ?? 0.5 }));
  if (wheel) p.push(...driverControls(wheel, yF, drv.x, drv.z, { gearFloor: extra.hump ? yF + extra.hump : yF }));
  if (extra.hump) p.push(box(0.55, extra.hump, 0.9, 0, yF + extra.hump / 2, zIn - 0.55, INT.PLASTIC), box(0.5, 0.02, 0.85, 0, yF + extra.hump + 0.01, zIn - 0.55, INT.FLOOR));
  if (extra.sleeper) p.push(box(w - 0.15, 0.12, 0.6, 0, drv.y + 0.05, zB + 0.38, INT.FABRIC), box(w - 0.15, 0.04, 0.6, 0, drv.y - 0.03, zB + 0.38, INT.PLASTIC));
  const rake = o.rake ?? 0.25;
  for (const s of seats.filter((q) => q.z > drv.z - 0.3)) p.push(box(0.5, 0.02, 0.22, s.x, yRoof - 0.12, zF - rake - 0.22, INT.PLASTIC, 0.25)); // sun visors
  p.push(box(0.18, 0.025, 0.1, 0, yRoof - 0.09, (zB + zF) / 2, INT.LAMP));
  for (const s of [-1, 1]) p.push(box(0.03, 0.03, 0.25, s * (w / 2 - 0.12), yRoof - 0.15, drv.z - 0.05, INT.PLASTIC));
  return p;
}

/** Large mirror on an arm from the A pillar (both sides). */
export function mirrors(hw, y, z, reach = 0.32) {
  return mirror([box(reach, 0.035, 0.035, hw + reach / 2, y + 0.2, z, DARK), box(0.035, 0.4, 0.035, hw + reach - 0.02, y, z, DARK),
    box(0.06, 0.42, 0.22, hw + reach, y - 0.02, z - 0.04, DARK), box(0.015, 0.36, 0.17, hw + reach - 0.035, y - 0.02, z - 0.06, INT.CHROME),
    box(0.06, 0.16, 0.16, hw + reach, y - 0.34, z - 0.04, DARK)]);
}

/**
 * KamAZ "Mustang" (4350 / 5350 / 6350 / 63501) cab-over front: plastic fascia with a black grille of three slats
 * and a nameplate band, recessed lamp clusters in a heavy steel bumper, tow hooks, corner indicators, two-step
 * ladder under each door, sun visor, roof marker lamps, big mirrors.
 */
export function kamazFront(o) {
  const { zF, yB, yBelt, w } = o, hw = w / 2;
  const p = [];
  const gy = yBelt - 0.38;
  p.push(box(w - 0.5, 0.46, 0.04, 0, gy, zF + 0.01, DARK));
  for (let i = 0; i < 3; i++) p.push(box(w - 0.6, 0.05, 0.05, 0, gy - 0.14 + i * 0.14, zF + 0.035, i === 1 ? INT.CHROME : STEEL));
  p.push(box(0.9, 0.08, 0.02, 0, gy + 0.3, zF + 0.015, INT.GAUGE)); // nameplate
  p.push(box(w + 0.02, 0.05, 0.05, 0, yBelt - 0.05, zF + 0.01, DARK)); // crease under the windscreen
  // bumper with lamp clusters, fog lamps, number plate, tow hooks
  const by = o.bumperY ?? yB + 0.05;
  p.push(box(w + 0.12, 0.42, 0.32, 0, by, zF + 0.1, C(o)), box(w + 0.1, 0.06, 0.3, 0, by + 0.23, zF + 0.1, DARK));
  for (const s of [-1, 1]) {
    p.push(box(0.5, 0.22, 0.04, s * (hw - 0.38), by + 0.05, zF + 0.265, DARK), box(0.2, 0.15, 0.02, s * (hw - 0.27), by + 0.05, zF + 0.285, INT.LAMP), box(0.16, 0.13, 0.02, s * (hw - 0.49), by + 0.05, zF + 0.285, INT.LAMP),
      cyl(0.06, 0.06, 0.03, 10, s * (hw - 0.75), by - 0.08, zF + 0.27, INT.LAMP, Math.PI / 2), box(0.1, 0.06, 0.02, s * (hw - 0.12), by + 0.12, zF + 0.285, INT.AMBER),
      box(0.08, 0.16, 0.12, s * 0.42, by - 0.22, zF + 0.28, DARK), box(0.14, 0.12, 0.06, s * (hw + 0.01), yBelt - 0.3, zF - 0.03, INT.AMBER));
  }
  p.push(box(0.52, 0.12, 0.02, 0, by + 0.06, zF + 0.27, INT.GAUGE));
  // steps under the doors
  const sz = o.stepZ ?? (o.door ? (o.door[0] + o.door[1]) / 2 : zF - 0.7);
  for (const s of [-1, 1]) {
    for (const [yy, k] of [[yB - 0.32, 0.95], [yB + 0.08, 0.85]]) p.push(box(0.32, 0.05, 0.42 * k, s * (hw - 0.14), yy, sz, STEEL), box(0.3, 0.02, 0.4 * k, s * (hw - 0.14), yy + 0.03, sz, DARK));
    p.push(box(0.04, 0.5, 0.04, s * (hw - 0.01), yB - 0.1, sz + 0.2, DARK), box(0.04, 0.5, 0.04, s * (hw - 0.01), yB - 0.1, sz - 0.2, DARK));
  }
  // sun visor, roof marker lamps, horn and antenna
  const rake = o.rake ?? 0.25;
  p.push(box(w - 0.1, 0.05, 0.34, 0, o.yRoof + 0.02, zF - rake + 0.12, C(o), -0.18));
  for (const x of [-0.4, 0, 0.4]) p.push(box(0.12, 0.06, 0.06, x, o.yRoof + 0.09, zF - rake - 0.06, INT.AMBER));
  p.push(...mirrors(hw, yBelt + 0.35, zF - 0.12));
  return p;
}
const C = (o) => o.color ?? PAINT;

/** Military truck tyre: chunky directional lugs, deep rim with hub and central-tyre-inflation valve. */
export function truckTyre(r, w, o = {}) {
  const p = [tubeX(r * 0.93, w, 0, 0, 0, 16, RUBBER), tubeX(r * 0.62, w + 0.03, 0, 0, 0, 12, o.hub ?? PAINT), tubeX(r * 0.34, w + 0.07, 0, 0, 0, 10, DARK),
    tubeX(r * 0.16, w + 0.14, 0, 0, 0, 6, STEEL)];
  const n = o.lugs ?? 18;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    for (const s of [-1, 1]) p.push(box(w * 0.46, 0.05, r * 0.2, s * w * 0.24, Math.cos(a) * r * 0.955, Math.sin(a) * r * 0.955, RUBBER, a, 0, 0));
  }
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; p.push(box(w + 0.05, 0.035, 0.035, 0, Math.cos(a) * r * 0.48, Math.sin(a) * r * 0.48, STEEL)); }
  return merge(p);
}

/**
 * Builds a cab around the vehicle's own seat layout: shell, interior (seats where the def's seats are, wheel at the
 * driver), doors carrying the seats on their side. Returns hull parts, glass and the `cabin` record for the
 * interior generator. `extra.skip`: seat indices not seated in the cab (e.g. a gunner standing in the roof hatch).
 * @param {any} def @param {any} o cabShell options @param {any} extra
 */
export function fitCab(def, o, extra = {}) {
  const ride = def.ride, skip = extra.skip || [];
  const seats = def.seats.map((s, i) => ({ i, x: s.pos[0], y: s.pos[1] + ride, z: s.pos[2], role: s.role, driver: i === 0 }))
    .filter((s) => s.z > o.zB - 0.05 && s.z < o.zF && s.role !== 'rider' && !skip.includes(s.i) && (extra.only ? extra.only.includes(s.i) : true));
  const drv = seats.find((s) => s.driver) || seats[0];
  const wheel = { x: drv.x, y: drv.y + (extra.wheelUp ?? 0.5), z: drv.z + (extra.wheelFwd ?? 0.44), tilt: extra.tilt ?? 0.9, r: extra.wheelR ?? 0.23 };
  const sh = cabShell(o);
  const inside = cabInterior(o, seats, extra.noWheel ? null : wheel, extra);
  const doors = sh.doors.map((d) => ({ ...d, seats: seats.filter((s) => Math.sign(s.x || 1) === d.side || extra.anyDoor).map((s) => s.i) }));
  return { hull: [...sh.hull, ...sh.inner, ...inside], glass: sh.glass, cabin: { zB: o.zB, zF: o.zF, seats: seats.map((q) => q.i), wheel: extra.noWheel ? null : wheel, doors: extra.noDoors ? [] : doors },
    doorsAsHull: extra.noDoors ? sh.doors.flatMap((d) => d.geo.map((g) => g.translate(d.x, d.y, d.z))) : [], doorGlass: extra.noDoors ? sh.doors.flatMap((d) => d.glass.map((g) => g.translate(d.x, d.y, d.z))) : [] };
}

/** Moves a fitCab result sideways (twin cabs either side of an engine). */
export function shiftCab(cab, dx) {
  for (const g of [...cab.hull, ...cab.glass]) g.translate(dx, 0, 0);
  if (cab.cabin.wheel) cab.cabin.wheel = { ...cab.cabin.wheel, x: cab.cabin.wheel.x + dx };
  cab.cabin.doors = cab.cabin.doors.map((d) => ({ ...d, x: d.x + dx }));
  return cab;
}

/**
 * MZKT-7930 style wide cab-over front: flat front panel with a horizontal-bar grille in the middle, square lamp
 * bezels with paired round lamps in the bumper, brush guards, roof marker lamps, big mirrors.
 */
export function mzktFront(o) {
  const { zF, yB, yBelt, w } = o, hw = w / 2, p = [];
  const gy = (yB + yBelt) / 2 + 0.05;
  p.push(box(1.3, 0.5, 0.04, 0, gy, zF + 0.01, DARK), ...[0, 1, 2, 3].map((i) => box(1.2, 0.05, 0.05, 0, gy - 0.18 + i * 0.12, zF + 0.035, STEEL)));
  const by = o.bumperY ?? yB + 0.05;
  p.push(box(w + 0.1, 0.4, 0.34, 0, by, zF + 0.12, DARK), box(w + 0.12, 0.05, 0.36, 0, by + 0.22, zF + 0.12, STEEL));
  for (const s of [-1, 1]) {
    p.push(box(0.55, 0.26, 0.05, s * (hw - 0.45), gy - 0.05, zF + 0.02, DARK),
      cyl(0.09, 0.09, 0.03, 12, s * (hw - 0.6), gy - 0.05, zF + 0.05, INT.LAMP, Math.PI / 2), cyl(0.09, 0.09, 0.03, 12, s * (hw - 0.32), gy - 0.05, zF + 0.05, INT.LAMP, Math.PI / 2),
      box(0.12, 0.08, 0.03, s * (hw - 0.12), gy + 0.15, zF + 0.04, INT.AMBER),
      box(0.1, 0.2, 0.14, s * 0.5, by - 0.26, zF + 0.25, DARK), // tow hooks
      box(0.06, 0.6, 0.06, s * (hw - 0.2), by + 0.45, zF + 0.3, STEEL)); // brush guard uprights
    for (const [yy] of [[yB - 0.32], [yB + 0.06]]) p.push(box(0.3, 0.05, 0.4, s * (hw - 0.14), yy, o.stepZ ?? zF - 0.9, STEEL));
  }
  p.push(box(w - 0.3, 0.05, 0.05, 0, by + 0.75, zF + 0.3, STEEL));
  for (const x of [-0.6, -0.2, 0.2, 0.6]) p.push(box(0.1, 0.06, 0.06, x, o.yRoof + 0.08, zF - (o.rake ?? 0.25) - 0.05, INT.AMBER));
  p.push(...mirrors(hw, yBelt + 0.35, zF - 0.15, 0.36));
  return p;
}

export { TEAM, wheelGeo };
