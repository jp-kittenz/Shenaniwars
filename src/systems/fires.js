/**
 * Fires left by explosions: burning grass and scrub, a building on fire, a burning wreck. Each burns for a while
 * (flames licking up, a column of smoke drifting with the wind) and dies down; a glow is added at night by the
 * atmosphere. Fires spread no further and do no damage: they are the scene, not a hazard.
 */
const MAX = 48;

export class FireSystem {
  /** @param {any} game */
  constructor(game) {
    this.game = game;
    /** @type {{x:number, y:number, z:number, size:number, until:number, t0:number, acc:number}[]} */
    this.list = [];
    /** Positions of the burning fires this frame (for the night glow). */
    this.glow = new Float32Array(MAX * 4);
    this.nGlow = 0;
    this.stats = { lit: 0 };
  }

  /** Starts a fire (merged into one already burning close by). */
  ignite(x, y, z, size, seconds) {
    const t = this.game.time;
    for (const f of this.list) if ((f.x - x) ** 2 + (f.z - z) ** 2 < (f.size + size) ** 2) { f.until = Math.max(f.until, t + seconds); f.size = Math.min(4, Math.max(f.size, size)); return f; }
    if (this.list.length >= MAX) this.list.shift();
    const f = { x, y, z, size, until: t + seconds, t0: t, acc: 0 };
    this.list.push(f);
    this.stats.lit++;
    return f;
  }

  /** @param {number} dt @param {{x:number, z:number}} cam */
  update(dt, cam) {
    const g = this.game, t = g.time, P = g.particles;
    this.nGlow = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const f = this.list[i];
      if (t > f.until) { this.list.splice(i, 1); continue; }
      // Grows for the first seconds, dies down over the last quarter.
      const life = f.until - f.t0, age = t - f.t0;
      const k = Math.min(1, age / 4) * Math.min(1, (f.until - t) / (life * 0.25));
      const far = (f.x - cam.x) ** 2 + (f.z - cam.z) ** 2 > 900 * 900;
      f.acc += dt;
      const every = far ? 0.5 : 0.12;
      if (f.acc >= every && k > 0.05) { f.acc = 0; P.fire(f.x, f.y, f.z, f.size * (0.4 + 0.6 * k)); }
      if (this.nGlow < MAX) { const o = this.nGlow * 4; this.glow[o] = f.x; this.glow[o + 1] = f.y + f.size * 0.8; this.glow[o + 2] = f.z; this.glow[o + 3] = f.size * k; this.nGlow++; }
    }
  }
}
