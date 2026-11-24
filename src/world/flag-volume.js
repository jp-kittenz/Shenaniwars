/**
 * Capture volume of an objective. Normally a ground circle (radius r, ±12 m vertically). A flag with a host
 * building (MIKE) is captured on that building's roof — inside its footprint, from 1.5 m below to 4 m above the
 * roof — for as long as the building stands; once it is ruined the volume drops to the rubble at ground level.
 */

/** Height of the roof the flag stands on, or NaN when the flag is on the ground (no host / host ruined). */
export function flagRoofY(f) {
  const h = f.host;
  if (!h || h.state >= 2) return NaN;
  return (h.y || 0) + h.floors * h.fh + 0.01;
}

/** Height of the flag's base (roof or ground). */
export function flagBaseY(f) {
  const r = flagRoofY(f);
  return Number.isNaN(r) ? f.y : r;
}

/** Is (x, y, z) (feet) inside the capture volume of f with ground radius r? */
export function inCaptureVolume(f, x, y, z, r) {
  const roof = flagRoofY(f);
  if (!Number.isNaN(roof)) {
    const h = f.host, dx = x - h.x, dz = z - h.z, c = Math.cos(h.rot), s = Math.sin(h.rot);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    return Math.abs(lx) < h.w / 2 && Math.abs(lz) < h.d / 2 && y > roof - 1.5 && y < roof + 4;
  }
  const dx = x - f.x, dz = z - f.z;
  return dx * dx + dz * dz < r * r && Math.abs(y - f.y) < 12;
}
