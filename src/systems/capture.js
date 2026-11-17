import { CONFIG } from '../core/config.js';
import { clamp } from '../core/math.js';

/**
 * @typedef {import('../world/map-generator.js').FlagDef & {
 *   v: number, contestedBy: number, count: number[]
 * }} Flag
 * `v` is the control value in [-1, 1]: -1 = fully team 0, +1 = fully team 1.
 */

/**
 * Conquest rules: flag capture by presence, ticket bleed for the side
 * holding fewer flags, one ticket per death, match end.
 */
export class CaptureSystem {
  /** @param {import('./game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** @type {Flag[]} */
    this.flags = game.map.flags.map((f) => ({ ...f, v: f.owner === 0 ? -1 : f.owner === 1 ? 1 : 0, contestedBy: -1, count: [0, 0] }));
    this.tickets = [CONFIG.match.tickets, CONFIG.match.tickets];
    this.over = false;
    this.winner = -1;
    this._timer = 0;
    this._bleed = CONFIG.match.bleedInterval;
    game.bus.on('kill', (_attacker, victim) => this._spend(victim.team, 1));
  }

  _spend(team, n) {
    if (this.over) return;
    this.tickets[team] = Math.max(0, this.tickets[team] - n);
    if (this.tickets[team] === 0) {
      this.over = true;
      this.winner = 1 - team;
      this.game.bus.emit('match:over', this.winner);
    }
  }

  owned(team) {
    let n = 0;
    for (const f of this.flags) if (f.owner === team) n++;
    return n;
  }

  /** @param {number} dt */
  update(dt) {
    if (this.over) return;
    const g = this.game, M = CONFIG.match;
    this._timer -= dt;
    if (this._timer <= 0) {
      const step = 0.25;
      this._timer += step;
      const r2 = M.captureRadius * M.captureRadius;
      for (const f of this.flags) {
        f.count[0] = f.count[1] = 0;
        for (let i = 0; i < g.soldiers.length; i++) {
          const s = g.soldiers[i];
          if (!s.alive || (s.vehicle && s.vehicle.def.kind === 'heli')) continue;
          const dx = s.pos.x - f.x, dz = s.pos.z - f.z;
          if (dx * dx + dz * dz < r2 && Math.abs(s.pos.y - f.y) < 12) f.count[s.team]++;
        }
        const diff = f.count[0] - f.count[1];
        if (diff === 0) { f.contestedBy = -1; continue; }
        const team = diff > 0 ? 0 : 1, target = team === 0 ? -1 : 1;
        f.contestedBy = f.owner !== team ? team : -1;
        if (f.v === target) continue;
        const before = f.v;
        f.v = clamp(f.v + target * (Math.min(Math.abs(diff), 3) / M.captureTime) * step, -1, 1);
        if (f.owner >= 0 && f.owner !== team && before * f.v <= 0) {
          f.owner = -1;
          g.bus.emit('flag:changed', f, -1);
        }
        if (f.v === target && f.owner !== team) {
          f.owner = team;
          f.contestedBy = -1;
          g.bus.emit('flag:changed', f, team);
        }
      }
    }
    this._bleed -= dt;
    if (this._bleed <= 0) {
      this._bleed = M.bleedInterval;
      const a = this.owned(0), b = this.owned(1);
      if (a !== b) this._spend(a < b ? 0 : 1, 1);
    }
  }

  serialize() {
    return { tickets: this.tickets.slice(), flags: this.flags.map((f) => [f.owner, f.v]) };
  }

  deserialize(d) {
    this.tickets = d.tickets.slice();
    this.over = false; this.winner = -1;
    d.flags.forEach((a, i) => {
      const f = this.flags[i];
      f.owner = a[0]; f.v = a[1]; f.contestedBy = -1;
      this.game.bus.emit('flag:changed', f, f.owner);
    });
  }
}
