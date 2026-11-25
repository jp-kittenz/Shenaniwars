/**
 * Explosions in three stages, each shaped by where the round came from, where it went off and what it hit:
 *
 *  1. Impact — the first instant: a white-hot flash that lights the surroundings, sparks, and what the surface
 *     throws out (earth and clods, grit and chips off concrete, splinters and masonry off a wall, metal and burning
 *     fragments off a vehicle, a column of spray off water). Ejecta leave in a cone around the surface normal,
 *     skewed away from the direction the round arrived from.
 *  2. Explosion — a dark, billowing fireball: deep orange flame puffs swallowed within a fraction of a second by
 *     thick, near-black smoke that is lit from inside as it boils up; burning debris arcs out on ballistic paths,
 *     each trailing its own streak of dark smoke (the "spider" of streaks in the references).
 *  3. Plume — the smoke column that is left: it keeps welling up for many seconds, rises, spreads and drifts with
 *     the wind, and thins out slowly (no puff vanishes at once).
 *
 * Every blast is varied: fireball size, how dark the smoke is, how many streaks and how far they fly, the plume's
 * length. Ballistic missiles and the heaviest warheads get a towering fireball, a ground shock ring and a smoke
 * column that stands over the battlefield for most of a minute.
 *
 * The smoke and fire are RocketFX's volumetric puffs (camera-facing quads with turbulent noise, lit tops and
 * shaded undersides); sparks and small chunks are ParticleSystem points.
 */

const R = Math.random;
const MAX_STREAKS = 96, MAX_PLUMES = 48;

export class ExplosionSystem {
  /** @param {any} game */
  constructor(game) {
    this.game = game;
    /** Burning / smoking debris in flight. */
    this.streaks = [];
    /** Smoke columns still welling up. */
    this.plumes = [];
    this.stats = { blasts: 0 };
  }

  /**
   * @param {number} x @param {number} y @param {number} z
   * @param {number} radius blast radius (m)
   * @param {string} kind 'huge' | 'water' | 'vehicle' | 'building' | 'hard' | 'vegetation' | 'dirt'
   * @param {{x:number, y:number, z:number}|null} [dir] direction the round was travelling (unit), if known
   */
  blast(x, y, z, radius, kind, dir = null) {
    const g = this.game, fx = g.rocketFX, P = g.particles;
    if (!fx) { P.explosionCtx(x, y, z, radius, kind); return; }
    this.stats.blasts++;
    const huge = kind === 'huge';
    const s = Math.max(0.45, radius / 7) * (huge ? 2.2 : 1);
    const det = fx.detail;
    // Bigger calibres leave smoke that hangs for much longer (artillery, rockets, missiles).
    const linger = Math.min(4, Math.max(1, radius / 6)) * (huge ? 1.5 : 1);
    // Variation per blast.
    const vFire = 0.75 + R() * 0.55, vDark = 0.8 + R() * 0.45, vSmoke = 0.75 + R() * 0.6;
    // Surface normal and the ejecta axis: up off the ground; off a wall / vehicle, back toward where it came from.
    let nx = 0, ny = 1, nz = 0;
    if ((kind === 'building' || kind === 'vehicle') && dir) {
      const h = Math.hypot(dir.x, dir.z) || 1;
      nx = -dir.x / h * 0.8; nz = -dir.z / h * 0.8; ny = 0.6;
    }
    let ex = nx, ey = ny, ez = nz;
    if (dir) {
      // reflect the incoming direction about the normal and blend it in (a shallow hit throws its spray forward)
      const dn = dir.x * nx + dir.y * ny + dir.z * nz;
      const rx = dir.x - 2 * dn * nx, ry = dir.y - 2 * dn * ny, rz = dir.z - 2 * dn * nz;
      ex = nx * 0.75 + rx * 0.45; ey = ny * 0.75 + Math.max(0.2, ry) * 0.45; ez = nz * 0.75 + rz * 0.45;
      const l = Math.hypot(ex, ey, ez) || 1; ex /= l; ey /= l; ez /= l;
    }
    const cone = (spread, out) => {
      // a random direction within `spread` of the ejecta axis
      let ax = ex + (R() - 0.5) * 2 * spread, ay = ey + (R() - 0.3) * spread, az = ez + (R() - 0.5) * 2 * spread;
      const l = Math.hypot(ax, ay, az) || 1; out[0] = ax / l; out[1] = ay / l; out[2] = az / l; return out;
    };
    const c3 = [0, 0, 0];

    // ---- 1. Impact -----------------------------------------------------------------------------------------
    fx.flashAt(x, y + 1, z, s * (huge ? 3 : 1.2));
    if (kind === 'water') {
      // A column of white spray and a ring of mist; no fireball on the water.
      const n = Math.round(22 * det * s) + 6;
      for (let i = 0; i < n; i++) {
        const a = R() * Math.PI * 2, h = R(), w = (0.8 + R() * 1.6) * s;
        fx._emit(x + Math.cos(a) * R() * s, y + 0.3, z + Math.sin(a) * R() * s, Math.cos(a) * w, (7 + h * 15) * s, Math.sin(a) * w,
          1.8 + R() * 1.4, 0.8 * s, (2.5 + R() * 2) * s, 1.3, 0.75, 0.82, 0.86, 0.9, 0, 1.1, -7, 0);
      }
      for (let i = 0; i < Math.round(14 * det) + 4; i++) {
        const a = (i / 14) * Math.PI * 2 + R() * 0.3;
        fx._emit(x, y + 0.5, z, Math.cos(a) * 8 * s, 0.6, Math.sin(a) * 8 * s, 4 + R() * 3, 1.5 * s, 6 * s, 0.8, 0.35, 0.86, 0.9, 0.94, 0, 1.6, 0.2, 0);
      }
      P.sparks(x, y + 0.5, z, 4);
      return;
    }
    P.sparks(x, y + 0.4, z, Math.round(10 + 10 * s));
    // what the surface throws out (in the ejecta cone)
    const tint = kind === 'hard' ? [0.33, 0.32, 0.3] : kind === 'vegetation' ? [0.2, 0.21, 0.12] : kind === 'building' ? [0.42, 0.4, 0.37]
      : kind === 'vehicle' ? [0.07, 0.065, 0.06] : [0.24, 0.18, 0.12];
    const nE = Math.round((kind === 'hard' ? 10 : 18) * det * Math.min(2.5, s)) + 4;
    for (let i = 0; i < nE; i++) {
      cone(0.55, c3);
      const v = (6 + R() * 12) * Math.sqrt(s), c = 0.8 + R() * 0.35;
      fx._emit(x, y + 0.3, z, c3[0] * v, c3[1] * v, c3[2] * v, 2.5 + R() * 2.5, 0.5 * s, (2.2 + R() * 2) * s, 1.4, 0.7,
        tint[0] * c, tint[1] * c, tint[2] * c, 0, 2.2, -2.5, 0);
    }
    // chunks: clods, chips, splinters, fragments (hard points that fall)
    const nC = Math.round(14 + 12 * s);
    for (let i = 0; i < nC; i++) {
      cone(0.7, c3);
      const v = (5 + R() * 14) * Math.sqrt(s), c = 0.7 + R() * 0.4;
      P.emit(x, y + 0.3, z, c3[0] * v, c3[1] * v + 2, c3[2] * v, 1.4 + R() * 1.2, 0.12 + R() * 0.22, 0.1, tint[0] * c * 0.8, tint[1] * c * 0.8, tint[2] * c * 0.8, 1, 0, 13, 0.25);
    }

    // ---- 2. Explosion: fireball swallowed by dark, fire-lit smoke ---------------------------------------
    const nF = Math.round((huge ? 28 : 14) * Math.min(1.6, det + 0.4) * vFire) + 4;
    for (let i = 0; i < nF; i++) {
      cone(0.9, c3);
      const v = (1.5 + R() * 5) * s, up = huge ? i * 0.9 : 0;
      fx._emit(x + c3[0] * R() * s, y + 0.5 + up + R() * s, z + c3[2] * R() * s, c3[0] * v, c3[1] * v + 2 + (huge ? 6 : 0), c3[2] * v,
        (0.45 + R() * 0.6) * (huge ? 2 : 1), (0.7 + R() * 0.6) * radius * 0.75 * vFire, (1.3 + R() * 0.7) * radius * 0.8 * vFire * (huge ? 1.6 : 1), 5, 1,
        2.6 + R() * 0.9, 0.85 + R() * 0.4, 0.18, 1, 3, 0);
    }
    // a white-hot core in the first instant
    for (let i = 0; i < 3; i++) {
      fx._emit(x + (R() - 0.5) * s, y + 0.8 + R() * s, z + (R() - 0.5) * s, 0, 2, 0, 0.12 + R() * 0.08, radius * 0.6, radius * 1.1 * vFire, 5, 1, 3.6, 2.8, 1.6, 1, 2, 0);
    }
    const nS = Math.round((huge ? 40 : 14) * det * vSmoke) + 5;
    for (let i = 0; i < nS; i++) {
      cone(1.0, c3);
      const v = (1 + R() * 4) * s, d = (0.05 + R() * 0.07) * vDark;
      fx._emit(x + (R() - 0.5) * s, y + 0.8 + R() * 1.5 * s + (huge ? R() * 20 : 0), z + (R() - 0.5) * s, c3[0] * v, c3[1] * v + 1.5, c3[2] * v,
        (7 + R() * 7) * linger + (huge ? 10 : 0), (0.7 + R() * 0.6) * radius * 0.45, (2.2 + R() * 1.5) * radius * 0.6 * vSmoke * (huge ? 1.5 : 1), 1.0, 0.82 + R() * 0.15,
        d * 1.15, d, d * 0.85, 0, 1.3, 1.2 + R() * 0.8, 1);
    }
    if (kind === 'building') {
      // masonry dust rolling out low
      for (let i = 0; i < Math.round(12 * det) + 4; i++) {
        const a = R() * Math.PI * 2, v = (2 + R() * 4) * s, c = 0.38 + R() * 0.1;
        fx._emit(x, y - 1 + R(), z, Math.cos(a) * v, 0.3 + R(), Math.sin(a) * v, 8 + R() * 6, 1.5 * s, (5 + R() * 3) * s, 0.9, 0.5, c, c * 0.95, c * 0.88, 0, 1.4, 0.15, 0);
      }
    }
    if (huge) {
      // ground shock ring of dust racing outward, then a rising cap
      for (let i = 0; i < Math.round(36 * det) + 10; i++) {
        const a = (i / 36) * Math.PI * 2 + R() * 0.2, v = 22 + R() * 14, c = 0.3 + R() * 0.08;
        fx._emit(x, y + 1, z, Math.cos(a) * v, 0.5 + R(), Math.sin(a) * v, 6 + R() * 4, 3, 10 + R() * 5, 1, 0.45, c, c * 0.92, c * 0.82, 0, 1.5, 0.1, 0);
      }
      for (let i = 0; i < Math.round(18 * det) + 6; i++) {
        const a = R() * Math.PI * 2, r = R() * 12, d = 0.07 + R() * 0.05;
        fx._emit(x + Math.cos(a) * r, y + 26 + R() * 12, z + Math.sin(a) * r, Math.cos(a) * 3, 4 + R() * 3, Math.sin(a) * 3, 25 + R() * 15, 8, 26 + R() * 10, 0.5, 0.7,
          d, d * 0.9, d * 0.82, 0, 0.6, 0.9, 1);
      }
    }
    // burning debris arcing out, each with a streak of smoke behind it
    const nK = Math.round((huge ? 14 : kind === 'vehicle' ? 8 : kind === 'hard' ? 4 : 6) * (0.5 + R() * 0.9) * Math.min(1.8, s));
    for (let i = 0; i < nK && this.streaks.length < MAX_STREAKS; i++) {
      cone(0.85, c3);
      const v = (12 + R() * 18) * Math.sqrt(s) * (huge ? 1.6 : 1);
      this.streaks.push({ x, y: y + 0.6, z, vx: c3[0] * v, vy: Math.abs(c3[1]) * v + 3, vz: c3[2] * v, t: 0, life: 0.8 + R() * 1.4, acc: 0,
        hot: kind === 'vehicle' || R() < 0.6, size: (0.45 + R() * 0.45) * Math.min(2, s), dark: (0.06 + R() * 0.07) * vDark });
    }

    // ---- 3. Plume -----------------------------------------------------------------------------------------
    if (this.plumes.length >= MAX_PLUMES) this.plumes.shift();
    const dur = (huge ? 60 : kind === 'vehicle' ? 22 : (10 + 8 * s) * linger) * (0.75 + R() * 0.5);
    this.plumes.push({ x, y: y + 0.5, z, t: 0, dur, rate: (huge ? 3 : 1.4) * vSmoke, acc: 0, s, linger,
      dark: (kind === 'vehicle' ? 0.05 : kind === 'building' ? 0.15 : 0.11) * vDark, dust: kind === 'dirt' || kind === 'vegetation' || kind === 'hard' });
  }

  /** Smoke streaks and plumes. @param {number} dt */
  update(dt) {
    const fx = this.game.rocketFX, P = this.game.particles;
    if (!fx) return;
    const det = fx.detail;
    for (let i = this.streaks.length - 1; i >= 0; i--) {
      const k = this.streaks[i];
      k.t += dt;
      const ox = k.x, oy = k.y, oz = k.z;
      k.vy -= 9.8 * dt; k.vx *= 1 - 0.25 * dt; k.vz *= 1 - 0.25 * dt;
      k.x += k.vx * dt; k.y += k.vy * dt; k.z += k.vz * dt;
      const gy = this.game.map.terrain.height(k.x, k.z);
      if (k.t > k.life || k.y < gy) { this.streaks.splice(i, 1); continue; }
      // smoke along the path, thinning as the fragment slows and cools
      const len = Math.hypot(k.x - ox, k.y - oy, k.z - oz);
      k.acc += len;
      const sp = 0.5 / det, fade = 1 - k.t / k.life;
      while (k.acc > sp) {
        k.acc -= sp;
        const f = k.acc / Math.max(len, 1e-3), x = k.x - (k.x - ox) * f, y = k.y - (k.y - oy) * f, z = k.z - (k.z - oz) * f;
        fx._emit(x, y, z, (R() - 0.5) * 0.6, 0.3 + R() * 0.4, (R() - 0.5) * 0.6, 3 + R() * 3, k.size * 0.9, k.size * (3.4 + R() * 2.2), 1.2, 0.62 * fade + 0.2,
          k.dark * 1.1, k.dark, k.dark * 0.88, 0, 1.4, 0.25, k.hot ? 1 : 0.3);
      }
      if (k.hot) P.emit(k.x, k.y, k.z, 0, 0, 0, 0.08, 0.35 * k.size + 0.15, 0.1, 5, 2.4, 0.6, 1, 1, 0, 0);
    }
    for (let i = this.plumes.length - 1; i >= 0; i--) {
      const p = this.plumes[i];
      p.t += dt;
      if (p.t > p.dur) { this.plumes.splice(i, 1); continue; }
      // wells up strongly at first, then ever more weakly (the column thins and drifts off)
      const k = 1 - p.t / p.dur;
      p.acc += dt * p.rate * (0.3 + 0.7 * k) * det * 4;
      while (p.acc > 1) {
        p.acc -= 1;
        const s = p.s, d = p.dark * (0.85 + R() * 0.3), dusty = p.dust && R() < 0.35;
        const c = dusty ? 0.26 + R() * 0.06 : d;
        fx._emit(p.x + (R() - 0.5) * 2 * s, p.y + R() * s, p.z + (R() - 0.5) * 2 * s, (R() - 0.5) * 1.2, 1.2 + R() * 1.4, (R() - 0.5) * 1.2,
          (12 + R() * 10) * Math.sqrt(p.linger || 1), (1.2 + R()) * s, (6 + R() * 5) * s * Math.sqrt(p.linger || 1), 0.45, (0.28 + 0.3 * k) * (dusty ? 0.7 : 1),
          c * 1.12, c * (dusty ? 0.95 : 1), c * (dusty ? 0.8 : 0.85), 0, 0.8, 0.9 + R() * 0.6, k > 0.7 ? 0.6 : 0);
      }
    }
  }
}
