import * as THREE from 'three';
import { DARK, STEEL, RUBBER, GLASS, LENS, CANVAS, PAINT, box, cyl, merge } from './kit.js';

/**
 * Vehicle interiors, hatches and doors, generated from a vehicle's seat
 * layout (so every vehicle gets its own arrangement from shared parts).
 * Everything is in body-local coordinates (collider centre origin), built
 * once per vehicle type and shared by all vehicles of that type.
 *
 * - shell: the inside of the crew / troop compartment (inward-facing walls
 *   with window openings for cabs and cockpits, seats, benches, floor,
 *   instrument panels, sights, periscopes, grab rails). Drawn only while
 *   the player looks from a seat of this vehicle (open vehicles: when near).
 * - controls: steering wheel, tiller levers, cyclic / collective, stick and
 *   throttle; animated from the vehicle controls.
 * - hatches: lids over crew seats of closed ground vehicles; open while the
 *   crew is turned out (no combat), closed when buttoned up.
 * - doors: cab doors, rear troop doors, truck tailgate, helicopter sliding
 *   door; open while people get in or out.
 * - eyes: per seat, where the seat camera sits (turned out of the hatch for
 *   armour crews, inside for passengers, cabs and cockpits).
 *
 * @typedef {{seat:number, x:number, y:number, z:number, turret:number, geo:THREE.BufferGeometry}} HatchSpec
 * @typedef {{x:number, y:number, z:number, axis:'x'|'y'|'slide', open:number, geo:THREE.BufferGeometry, glass?:THREE.BufferGeometry|null, seats:number[]}} DoorSpec
 * @typedef {{kind:'wheel'|'tiller'|'cyclic'|'collective'|'stick'|'throttle', x:number, y:number, z:number, side:number, tilt?:number, geo:THREE.BufferGeometry}} ControlSpec
 * @typedef {{shell:THREE.BufferGeometry|null, controls:ControlSpec[], hatches:HatchSpec[], doors:DoorSpec[], eyes:Float32Array, open:boolean}} InteriorSpec
 */

const LAMP = 0xffe0a0;
const PANEL = 0x30353a;
const SCREEN = 0x3f8f6a;
const AMBER = 0xc08a2a;
const CUSHION = 0x3a3d33;
const INNER = 0x5d6655;   // interior paint (light green-grey, typical of armour interiors)
const INNER_AIR = 0x55595e;

/** @type {Map<string, InteriorSpec>} */
const CACHE = new Map();

/** Inward-facing box (walls seen from inside): flips the winding and the normals of a box. */
function innerBox(w, h, d, x, y, z, color, skip = '') {
  const parts = [];
  // Six walls as thin boxes facing inward: skip some to leave openings ('f' front, 'b' back, 'l' left, 'r' right, 't' top, 'd' floor).
  const t = 0.03;
  if (!skip.includes('d')) parts.push(box(w, t, d, x, y - h / 2, z, color));
  if (!skip.includes('t')) parts.push(box(w, t, d, x, y + h / 2, z, color));
  if (!skip.includes('l')) parts.push(box(t, h, d, x + w / 2, y, z, color));
  if (!skip.includes('r')) parts.push(box(t, h, d, x - w / 2, y, z, color));
  if (!skip.includes('f')) parts.push(box(w, h, t, x, y, z + d / 2, color));
  if (!skip.includes('b')) parts.push(box(w, h, t, x, y, z - d / 2, color));
  return parts;
}

/** Seat: cushion and backrest at a seat surface (pos), facing +Z. */
function seatParts(p, wide = 0.46) {
  return [
    box(wide, 0.08, 0.44, p[0], p[1] - 0.04, p[2], CUSHION),
    box(wide, 0.55, 0.07, p[0], p[1] + 0.28, p[2] - 0.24, CUSHION, 0.12),
    box(0.06, 0.4, 0.06, p[0], p[1] - 0.28, p[2], STEEL),
  ];
}

/** Instrument panel in front of a seat: a slab with gauges / screens and a couple of lamps. */
function panel(p, dz, dy, w, screens, color = PANEL) {
  const z = p[2] + dz, y = p[1] + dy;
  const out = [box(w, 0.26, 0.12, p[0], y, z, color, -0.35)];
  for (let i = 0; i < screens; i++) {
    const x = p[0] + (i - (screens - 1) / 2) * (w / screens);
    out.push(box(w / screens * 0.7, 0.13, 0.02, x, y + 0.02, z - 0.07, i % 2 ? AMBER : SCREEN, -0.35));
  }
  out.push(box(0.03, 0.03, 0.02, p[0] - w * 0.42, y + 0.1, z - 0.06, LAMP), box(0.03, 0.03, 0.02, p[0] + w * 0.42, y + 0.1, z - 0.06, 0xd04030));
  return out;
}

/** Steering wheel rim (spokes, hub, horn pad) in the XY plane. */
function wheelRim(r) {
  const rim = [];
  const n = 14;
  for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; rim.push(box(r * 0.48, 0.035, 0.035, Math.cos(a) * r, Math.sin(a) * r, 0, RUBBER, 0, 0, a + Math.PI / 2)); }
  for (const a of [Math.PI / 2 + 0.0, -Math.PI / 6, Math.PI + Math.PI / 6]) rim.push(box(r * 0.9, 0.03, 0.02, Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45, 0, DARK, 0, 0, a));
  rim.push(cyl(r * 0.28, r * 0.28, 0.05, 10, 0, 0, 0, DARK, Math.PI / 2), cyl(r * 0.12, r * 0.12, 0.06, 8, 0, 0, -0.01, STEEL, Math.PI / 2));
  return merge(rim);
}

/** Cyclic / stick / collective / throttle grips. */
function stickGeo(kind) {
  if (kind === 'collective') return merge([box(0.04, 0.04, 0.45, 0, 0, 0.22, DARK), box(0.06, 0.06, 0.1, 0, 0.02, 0.44, RUBBER), box(0.03, 0.03, 0.03, 0.03, 0.06, 0.44, 0xa3271f)]);
  if (kind === 'throttle') return merge([box(0.05, 0.16, 0.05, 0, 0.08, 0, DARK), box(0.07, 0.07, 0.1, 0, 0.17, 0.02, RUBBER)]);
  return merge([cyl(0.018, 0.024, 0.5, 6, 0, 0.25, 0, DARK), box(0.05, 0.11, 0.06, 0, 0.53, 0, RUBBER), box(0.02, 0.02, 0.02, 0, 0.6, 0.02, 0xa3271f), box(0.07, 0.03, 0.05, 0, 0.03, 0, DARK)]);
}

function hatchGeo(r) {
  return merge([cyl(r, r, 0.06, 10, 0, 0, r, PAINT), box(0.06, 0.06, r * 1.1, 0, 0.05, r, STEEL), cyl(r * 0.2, r * 0.2, 0.05, 6, 0, 0.04, r * 1.5, DARK)]);
}

/**
 * @param {import('../vehicle-defs.js').VehicleDef} def
 * @returns {InteriorSpec}
 */
export function interiorSpec(def, model = null) {
  const hit = CACHE.get(def.type);
  if (hit) return hit;
  const spec = build(def, model && model.cabin ? model.cabin : null);
  CACHE.set(def.type, spec);
  return spec;
}

/**
 * @param {import('../vehicle-defs.js').VehicleDef} def
 * @param {any} cabin model-built cab / cockpit (ground coordinates): its seats, dashboard and walls are part of the
 *   hull; here only the animated controls (wheel / stick at `cabin.wheel` …) and its doors are taken.
 * @returns {InteriorSpec}
 */
function build(def, cabin = null) {
  const seats = def.seats, n = seats.length;
  const eyes = new Float32Array(n * 3);
  /** @type {InteriorSpec} */
  const out = { shell: null, controls: [], hatches: [], doors: [], eyes, open: !!def.openSeats };
  if (def.static) {
    for (let i = 0; i < n; i++) { const p = seats[i].pos; eyes.set([p[0], p[1] + 0.9, p[2]], i * 3); }
    return out;
  }
  const [hx, hy, hz] = def.half;
  const tracked = def.kind === 'ground' && def.maxSteer === 0;
  const air = def.kind !== 'ground';
  const soft = def.armor === 'soft' && def.kind === 'ground';
  const parts = [];
  const cargo = [];
  let crewMinZ = 1e9, crewMaxZ = -1e9, crewMinY = 1e9;
  for (let i = 0; i < n; i++) {
    const s = seats[i], p = s.pos;
    if (s.role === 'rider') { eyes.set([p[0], p[1] + 0.86, p[2]], i * 3); continue; }
    if (s.role === 'passenger' && !(cabin && (cabin.seats ? cabin.seats.includes(i) : p[2] > (cabin.zB ?? 1e9) - 0.1))) cargo.push(i);
    else { crewMinZ = Math.min(crewMinZ, p[2]); crewMaxZ = Math.max(crewMaxZ, p[2]); crewMinY = Math.min(crewMinY, p[1]); }
    eyes.set([p[0], p[1] + 0.78, p[2] + 0.04], i * 3);
    // A gunner on an exposed mount looks over his weapon, not from inside it.
    const own = def.seatMounts[i];
    if (i > 0 && own && own.length) {
      const m = def.mounts[own[0]];
      if (m.pos && Math.hypot(m.pos[0] - p[0], m.pos[2] - p[2]) < 1.2) eyes.set([m.pos[0], Math.max(p[1] + 0.78, m.pos[1] + 0.24), m.pos[2] - 0.6], i * 3);
    }
  }

  // --- Crew stations --------------------------------------------------------------------
  for (let i = 0; i < n; i++) {
    const s = seats[i], p = s.pos;
    if (s.role === 'rider' || s.role === 'passenger') continue;
    if (cabin && (cabin.seats ? cabin.seats.includes(i) : true)) {
      if (i === 0 && cabin.wheel) {
        const wl = cabin.wheel;
        out.controls.push({ kind: wl.kind || 'wheel', x: wl.x, y: wl.y - def.ride, z: wl.z, side: 0, tilt: wl.tilt, geo: wl.kind && wl.kind !== 'wheel' ? stickGeo(wl.kind) : wheelRim(wl.r ?? 0.2) });
        if (wl.kind === 'cyclic') out.controls.push({ kind: 'collective', x: wl.x + 0.3, y: wl.y - def.ride - 0.05, z: wl.z - 0.4, side: 1, geo: stickGeo('collective') });
        if (wl.kind === 'stick') out.controls.push({ kind: 'throttle', x: wl.x + 0.28, y: wl.y - def.ride + 0.15, z: wl.z - 0.27, side: 1, geo: stickGeo('throttle') });
      }
      continue;
    }
    parts.push(...seatParts(p));
    if (i === 0) {
      if (def.kind === 'heli') {
        parts.push(...panel(p, 0.72, 0.5, 0.75, 3));
        out.controls.push({ kind: 'cyclic', x: p[0], y: p[1] - 0.05, z: p[2] + 0.3, side: 0, geo: merge([cyl(0.018, 0.022, 0.5, 6, 0, 0.25, 0, DARK), box(0.05, 0.1, 0.05, 0, 0.52, 0, RUBBER)]) });
        out.controls.push({ kind: 'collective', x: p[0] + 0.3, y: p[1] - 0.02, z: p[2] - 0.1, side: 1, geo: merge([box(0.04, 0.04, 0.45, 0, 0, 0.22, DARK), box(0.06, 0.06, 0.1, 0, 0.02, 0.44, RUBBER)]) });
      } else if (def.kind === 'jet') {
        parts.push(...panel(p, 0.68, 0.48, 0.6, 2), box(0.32, 0.22, 0.02, p[0], p[1] + 0.8, p[2] + 0.55, GLASS, -0.25));
        out.controls.push({ kind: 'stick', x: p[0], y: p[1] - 0.05, z: p[2] + 0.32, side: 0, geo: merge([cyl(0.02, 0.025, 0.42, 6, 0, 0.21, 0, DARK), box(0.05, 0.11, 0.06, 0, 0.45, 0, RUBBER)]) });
        out.controls.push({ kind: 'throttle', x: p[0] + 0.28, y: p[1] + 0.12, z: p[2] + 0.05, side: 1, geo: merge([box(0.05, 0.16, 0.05, 0, 0.08, 0, DARK), box(0.07, 0.07, 0.1, 0, 0.17, 0.02, RUBBER)]) });
      } else if (tracked) {
        parts.push(...panel(p, 0.62, 0.3, 0.5, 2));
        for (const sd of [1, -1]) out.controls.push({ kind: 'tiller', x: p[0] + sd * 0.2, y: p[1] - 0.05, z: p[2] + 0.32, side: sd, geo: merge([cyl(0.018, 0.022, 0.45, 6, 0, 0.22, 0, STEEL), box(0.06, 0.06, 0.12, 0, 0.45, 0, RUBBER)]) });
      } else {
        parts.push(...panel(p, 0.62, 0.38, 0.62, 2), cyl(0.03, 0.03, 0.3, 6, p[0], p[1] + 0.42, p[2] + 0.48, DARK, -0.9));
        const rim = [];
        for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2; rim.push(box(0.06, 0.03, 0.03, Math.cos(a) * 0.19, Math.sin(a) * 0.19, 0, RUBBER, 0, 0, a + Math.PI / 2)); }
        rim.push(box(0.36, 0.03, 0.02, 0, 0, 0, DARK), cyl(0.04, 0.04, 0.04, 8, 0, 0, 0, DARK, Math.PI / 2));
        out.controls.push({ kind: 'wheel', x: p[0], y: p[1] + 0.52, z: p[2] + 0.36, side: 0, geo: merge(rim) });
      }
    } else if (air) {
      parts.push(...panel(p, 0.62, 0.46, 0.55, 2));
    } else {
      // Gunner / commander: sight block with brow pad, hand controls; commander's periscope ring.
      parts.push(box(0.2, 0.18, 0.22, p[0], p[1] + 0.78, p[2] + 0.32, DARK), box(0.16, 0.06, 0.04, p[0], p[1] + 0.84, p[2] + 0.2, RUBBER),
        box(0.06, 0.02, 0.02, p[0], p[1] + 0.82, p[2] + 0.44, LENS));
      parts.push(box(0.3, 0.06, 0.08, p[0], p[1] + 0.45, p[2] + 0.36, STEEL), box(0.05, 0.12, 0.05, p[0] + 0.13, p[1] + 0.5, p[2] + 0.36, RUBBER), box(0.05, 0.12, 0.05, p[0] - 0.13, p[1] + 0.5, p[2] + 0.36, RUBBER));
      if (s.role === 'commander') for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; parts.push(box(0.1, 0.06, 0.04, p[0] + Math.sin(a) * 0.3, p[1] + 0.98, p[2] + Math.cos(a) * 0.3, LENS, 0, a)); }
    }
  }

  // --- Troop compartment: benches along the walls, grab rails, lamps ------------------------------
  if (cargo.length) {
    let minZ = 1e9, maxZ = -1e9, y = 0;
    for (const i of cargo) { const p = seats[i].pos; minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]); y = p[1]; }
    const sidesX = new Set(cargo.map((i) => Math.sign(seats[i].pos[0]) || 1));
    for (const sd of sidesX) {
      const x = cargo.map((i) => seats[i].pos[0]).filter((v) => Math.sign(v) === sd)[0] ?? sd * 0.5;
      parts.push(box(0.42, 0.07, maxZ - minZ + 0.6, x, y - 0.04, (minZ + maxZ) / 2, CUSHION), box(0.06, 0.5, maxZ - minZ + 0.6, x + sd * 0.24, y + 0.28, (minZ + maxZ) / 2, CUSHION));
    }
    if (!soft || def.kind === 'heli') {
      parts.push(cyl(0.015, 0.015, maxZ - minZ + 0.6, 5, 0, y + 1.0, (minZ + maxZ) / 2, STEEL, Math.PI / 2));
      parts.push(box(0.1, 0.03, 0.18, 0, y + 1.04, minZ - 0.1, LAMP), box(0.1, 0.03, 0.18, 0, y + 1.04, maxZ + 0.1, LAMP));
    }
    // The compartment walls (seen from the seats): closed armour box; canvas cover on trucks (open at the back); heli cabin.
    const cw = Math.min(hx * 2 - 0.2, Math.abs(seats[cargo[0]].pos[0]) * 2 + 1.0), cz = (minZ + maxZ) / 2, cd = maxZ - minZ + 1.0;
    const ch = 1.35, cy = y + ch / 2 - 0.45;
    if (def.kind === 'heli') parts.push(...innerBox(cw + 0.1, ch, cd + 0.4, 0, cy, cz, INNER_AIR, 'l'));
    else if (soft) parts.push(...innerBox(cw, ch + 0.2, cd, 0, cy + 0.1, cz, CANVAS, 'bf'));
    else {
      parts.push(...innerBox(cw, ch, cd, 0, cy, cz, INNER));
      // Vision blocks / firing ports along the walls.
      for (const sd of [1, -1]) for (let z = minZ; z <= maxZ + 0.01; z += 1.1) parts.push(box(0.03, 0.1, 0.18, sd * (cw / 2 - 0.03), y + 0.62, z, LENS));
      // Rear doors of the troop compartment (BMP / BTR style pair).
      const dz = cz - cd / 2 + 0.02;
      for (const sd of [1, -1]) {
        out.doors.push({ x: sd * cw / 2, y: cy - ch / 2 + 0.05, z: dz, axis: 'y', open: sd * 1.5, seats: cargo,
          geo: merge([box(cw / 2 - 0.04, ch - 0.15, 0.07, -sd * (cw / 4), (ch - 0.15) / 2, 0, PAINT), box(0.05, 0.12, 0.04, -sd * (cw / 2 - 0.15), ch / 2, -0.05, STEEL), box(0.12, 0.06, 0.03, -sd * (cw / 4), ch * 0.7, 0.04, LENS)]) });
      }
    }
    if (soft && def.kind === 'ground') {
      // Tailgate (hinged at the bottom).
      out.doors.push({ x: 0, y: y - 0.45, z: cz - cd / 2, axis: 'x', open: -1.5, seats: cargo, geo: merge([box(cw, 0.5, 0.05, 0, 0.25, 0, PAINT), box(cw * 0.9, 0.04, 0.06, 0, 0.42, -0.03, STEEL)]) });
    }
    if (def.kind === 'heli') {
      // Sliding cabin door (left side).
      out.doors.push({ x: cw / 2 + 0.08, y: cy, z: cz + 0.3, axis: 'slide', open: -1.25, seats: cargo, geo: merge([box(0.05, ch - 0.1, 1.2, 0, 0, 0, PAINT), box(0.03, 0.35, 0.5, 0.03, 0.2, 0.1, GLASS)]) });
    }
  }

  // --- Cab / cockpit shell with window openings ----------------------------------------------------
  if (cabin) {
    for (const d of cabin.doors || []) {
      out.doors.push({ x: d.x, y: d.y - def.ride, z: d.z, axis: 'y', open: d.side * 1.15, geo: merge(d.geo), glass: d.glass && d.glass.length ? merge(d.glass) : null,
        seats: d.seats || seats.map((q, k) => k).filter((k) => seats[k].role !== 'rider' && Math.sign(seats[k].pos[0] || 1) === d.side && seats[k].pos[2] > (cabin.zB ?? -1e9) - 0.2) });
    }
  } else if (crewMinZ < 1e9 && !def.openSeats) {
    const front = crewMaxZ + (air ? 0.95 : 0.8), back = crewMinZ - 0.45;
    const w = Math.min(hx * 2 - 0.15, 1.9), h = 1.55, y0 = crewMinY - 0.45, cz = (front + back) / 2, d = front - back;
    if (air || soft) {
      // Floor, firewall below the windscreen, roof, pillars and door sills: windows left open.
      parts.push(box(w, 0.03, d, 0, y0, cz, air ? INNER_AIR : INNER), box(w, 0.5, 0.03, 0, y0 + 0.25, front, PANEL), box(w, 0.03, d, 0, y0 + h, cz, air ? INNER_AIR : INNER));
      for (const sd of [1, -1]) {
        parts.push(box(0.04, 0.45, d, sd * w / 2, y0 + 0.22, cz, air ? INNER_AIR : INNER), box(0.06, h, 0.06, sd * w / 2, y0 + h / 2, front, DARK), box(0.06, h, 0.06, sd * w / 2, y0 + h / 2, back, DARK));
      }
      parts.push(box(w, h, 0.03, 0, y0 + h / 2, back, air ? INNER_AIR : INNER));
      if (soft && def.kind === 'ground') {
        // Cab doors beside the cab seats.
        for (let i = 0; i < n; i++) {
          const s = seats[i];
          if (s.role === 'passenger' && Math.abs(s.pos[2] - seats[0].pos[2]) > 0.3) continue;
          if (s.role === 'rider' || (s.role !== 'driver' && s.role !== 'passenger' && i !== 0)) continue;
          const sd = Math.sign(s.pos[0]) || 1;
          out.doors.push({ x: sd * (w / 2 + 0.03), y: y0 + 0.05, z: s.pos[2] + 0.5, axis: 'y', open: sd * 1.1, seats: [i],
            // Lower door panel and window frame (the window itself is open: an opaque pane would blind the seat view).
            geo: merge([box(0.05, 0.62, 0.95, 0, 0.31, -0.47, PAINT), box(0.05, 0.05, 0.95, 0, 1.08, -0.47, PAINT), box(0.05, 0.46, 0.05, 0, 0.85, -0.04, PAINT),
              box(0.03, 0.03, 0.12, sd * 0.03, 0.5, -0.8, STEEL)]) });
        }
      }
    } else if (crewMaxZ - crewMinZ < 3) {
      // Armour: hatches over the crew seats (hull roof for the driver, turret roof for the turret crew).
      for (let i = 0; i < n; i++) {
        const s = seats[i];
        if (s.role === 'passenger' || s.role === 'rider') continue;
        const p = s.pos, inTurret = p[1] > hy - 0.15;
        const y = inTurret ? p[1] + 0.58 : hy + 0.02;
        const turret = inTurret ? turretMount(def) : -1;
        out.hatches.push({ seat: i, x: p[0], y, z: p[2] - 0.32, turret, geo: hatchGeo(0.3) });
        eyes.set([p[0], y + 0.62, p[2] + 0.05], i * 3);
      }
      // Fighting compartment shell (seen when looking down through the open hatch).
      parts.push(...innerBox(Math.min(hx * 2 - 0.2, 2.2), 1.15, d + 0.4, 0, y0 + 0.57, cz, INNER, 't'));
    }
  }
  if (def.openSeats && parts.length) {
    // Open vehicles: seats and controls are part of the visible model.
    for (let i = 0; i < n; i++) if (seats[i].role === 'passenger') parts.push(...seatParts(seats[i].pos));
  }
  out.shell = parts.length ? merge(parts) : null;
  return out;
}

/** The main traversing turret (mount without a parent that turns), or -1. */
function turretMount(def) {
  for (let k = 0; k < def.mounts.length; k++) {
    const m = def.mounts[k];
    if (m.parent === undefined && m.coax === undefined && m.turnRate > 0 && m.pos) return k;
  }
  return -1;
}
