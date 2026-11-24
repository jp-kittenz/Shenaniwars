/**
 * Natural anti-aircraft aim. Weapon damage, rate of fire and projectile speed are untouched; what changes is how
 * a gunner (a soldier's shoulder or a turret) gets onto a fast-moving aircraft:
 *   1. slew inertia     — the aim turns toward the aircraft at a limited angular rate (turrets: their traverse
 *                         rate; shoulders: AA_SHOULDER_SLEW), so shots trail fast, low fly-bys
 *   2. lead lag         — the aircraft's velocity is estimated with a lag (exponential average, ~0.6 s), so a
 *                         sudden break / pitch / roll throws the lead off for a moment
 *   3. walk-on          — a burst opens wide and tightens onto the flight path over ~1.25 s of continuous tracking
 *   4. acquisition      — a new aircraft takes 0.8–2.0 s to pick up, longer under fire, at night and in fog
 * State lives on the agent (no allocation).
 */
export const AA_SHOULDER_SLEW = 2.2;

/** Is the target an aircraft? */
export function isAircraft(t) { return !!t && t.kind === 'vehicle' && t.isAircraft; }

/**
 * Updates the tracking state of agent `a` on aircraft `t`; returns the dispersion multiplier for this shot.
 * Writes the lagged velocity estimate to a.aaVX / aaVY / aaVZ.
 */
export function aaTrack(a, t, dt, time, suppression = 0) {
  if (a.aaTarget !== t) {
    a.aaTarget = t; a.aaStart = time;
    a.aaVX = t.vel ? t.vel.x * 0.5 : 0; a.aaVY = t.vel ? t.vel.y * 0.5 : 0; a.aaVZ = t.vel ? t.vel.z * 0.5 : 0;
    // Picking the aircraft up: darkness / fog (EnvironmentState) and incoming fire slow it.
    const env = a.game.environment, acq = env ? env.acquisitionFactor : 1;
    const delay = Math.min(2.0, 0.8 + (1 - acq) * 1.1 + Math.min(1, suppression) * 0.6);
    a.acquireTime = Math.max(a.acquireTime || 0, time + delay);
    a.aaAcquisitions = (a.aaAcquisitions || 0) + 1;
  }
  if (t.vel) {
    const k = 1 - Math.exp(-dt / 0.6);
    a.aaVX += (t.vel.x - a.aaVX) * k; a.aaVY += (t.vel.y - a.aaVY) * k; a.aaVZ += (t.vel.z - a.aaVZ) * k;
  }
  const tracked = time - a.aaStart;
  return 1 + 1.8 * Math.max(0, 1 - tracked / 1.25);
}

/** Moves `cur` toward `want` (radians) by at most rate·dt. */
export function slewTo(cur, want, rate, dt) {
  let d = want - cur;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const m = rate * dt;
  return cur + (d > m ? m : d < -m ? -m : d);
}
