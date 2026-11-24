import { inCaptureVolume } from '../world/flag-volume.js';
import { CONFIG } from '../core/config.js';
import { clamp } from '../core/math.js';
import { WEAPONS } from '../entities/weapons.js';
import { BASES, BASE } from '../world/layout.js';

/** Seconds a side must hold no objective at all before its base is exposed (no flip-flop exploits). */
export const SIEGE_DELAY = 20;
/** A comeback barrage needs a siege of at least this long, and is available once per cooldown. */
const BARRAGE_MIN_SIEGE = 25;
const BARRAGE_COOLDOWN = 240;
const BARRAGE_SHELLS = 16;
/** The barrage falls within this distance of the defending base centre (outside its walls). */
const BARRAGE_REACH = 340;
/** Off-map artillery: a medium shell (less than a howitzer round), same armour effects. */
const BARRAGE_DEF = { ...WEAPONS.howitzer, name: 'ARTILLERY BARRAGE', damage: 560, radius: 10 };

/**
 * @typedef {import('../world/map-generator.js').FlagDef & {
 *   v: number, contestedBy: number, count: number[]
 * }} Flag
 * `v` is the control value in [-1, 1]: -1 = fully team 0, +1 = fully team 1.
 */

/**
 * Conquest rules: flag capture by presence, ticket bleed for the side
 * holding fewer flags, one ticket per death, match end; plus the endgame.
 *
 * Endgame: a side that has held none of the twelve objectives for
 * SIEGE_DELAY seconds is under siege. Its base buildings lose their
 * invulnerability (damage taken before persists either way) and the attacker
 * wins by destroying all four of its HQ buildings. Recapturing any objective
 * lifts the siege at once and, if the siege had lasted a while, calls an
 * off-map artillery barrage onto the densest group of attackers outside the
 * base (once per cooldown): a chance to break the siege, not a guaranteed
 * comeback. Tickets still decide the match if they run out first.
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
    /** Per team: 'normal' or 'siege' (its base is exposed). */
    this.phase = ['normal', 'normal'];
    this._zeroFor = [0, 0];
    this.siegeStart = [0, 0];
    this.siegeCount = [0, 0];
    this.barrageAt = [-1e9, -1e9];
    /** Pending barrage: {team (firing side), x, z, t (first impact), fired}. */
    this.barrage = null;
    this.bases = game.map.bases || [];
    game.bus.on('kill', (_attacker, victim) => this._spend(victim.team, 1));
    game.bus.on('building:state', (b, state) => { if (b.hq && state === 2) this._hqDown(b); });
  }

  /** HQ buildings of `team` still standing. */
  hqLeft(team) {
    const base = this.bases[team];
    if (!base) return 0;
    let n = 0;
    for (const id of base.hq) if (this.game.map.buildings[id].state < 2) n++;
    return n;
  }

  _hqDown(b) {
    const team = b.team, g = this.game;
    const left = this.hqLeft(team);
    g.bus.emit('endgame:hq', team, left);
    g.bus.emit('notice', `${CONFIG.teams[team].name} HQ DESTROYED (${left}/4 LEFT)`);
    if (left === 0 && !this.over) {
      this.over = true;
      this.winner = 1 - team;
      g.bus.emit('match:over', this.winner);
    }
  }

  /** Exposes or protects a side's base buildings (their damage persists). */
  _setExposed(team, exposed) {
    for (const b of this.game.map.buildings) if (b.team === team) b.invulnerable = !exposed;
  }

  _endgame(dt) {
    const g = this.game;
    for (let team = 0; team < 2; team++) {
      const mine = this.owned(team), theirs = this.owned(1 - team);
      if (this.phase[team] === 'normal') {
        this._zeroFor[team] = mine === 0 && theirs > 0 ? this._zeroFor[team] + dt : 0;
        if (this._zeroFor[team] >= SIEGE_DELAY) {
          this.phase[team] = 'siege';
          this.siegeStart[team] = g.time;
          this.siegeCount[team]++;
          this._setExposed(team, true);
          g.bus.emit('endgame:phase', team, 'siege');
          g.bus.emit('notice', `${CONFIG.teams[team].name} BASE EXPOSED — DESTROY ITS 4 HQ`);
        }
      } else if (mine > 0) {
        // Recapture: the final phase is postponed; a long enough siege earns the defenders a barrage.
        const lasted = g.time - this.siegeStart[team];
        this.phase[team] = 'normal';
        this._zeroFor[team] = 0;
        this._setExposed(team, false);
        g.bus.emit('endgame:phase', team, 'normal');
        g.bus.emit('notice', `${CONFIG.teams[team].name} RECAPTURED AN OBJECTIVE — BASE SECURED`);
        if (lasted >= BARRAGE_MIN_SIEGE && g.time - this.barrageAt[team] >= BARRAGE_COOLDOWN) this._callBarrage(team);
      }
    }
    this._runBarrage();
  }

  /**
   * Off-map artillery for `team`: the densest cluster of enemy soldiers near
   * its base (within BARRAGE_REACH of its centre) but outside the walls.
   */
  _callBarrage(team) {
    const g = this.game, b = BASES[team], foe = 1 - team;
    let best = -1, bestN = 0;
    const list = g.soldiers;
    const outside = (x, z) => {
      const u = (x - b.x) * b.inland, v = (z - b.z) * b.inland;
      return u > BASE.wall + 12 || Math.abs(v) > BASE.halfLength + 12 || u < BASE.coast - 10;
    };
    let bestScore = 0;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s.alive || s.team !== foe || (s.vehicle && s.vehicle.isAircraft)) continue;
      const d = Math.hypot(s.pos.x - b.x, s.pos.z - b.z);
      if (d > BARRAGE_REACH || !outside(s.pos.x, s.pos.z)) continue;
      let n = 0;
      for (let k = 0; k < list.length; k++) {
        const o = list[k];
        if (o.alive && o.team === foe && (o.pos.x - s.pos.x) ** 2 + (o.pos.z - s.pos.z) ** 2 < 35 * 35) n++;
      }
      // Most attackers, preferring the ones pressing closest to the base.
      const score = n * (1.4 - d / BARRAGE_REACH);
      if (score > bestScore) { bestScore = score; bestN = n; best = i; }
    }
    if (best < 0 || bestN < 3) return;
    let cx = 0, cz = 0, n = 0;
    const c = list[best].pos;
    for (const o of list) if (o.alive && o.team === foe && (o.pos.x - c.x) ** 2 + (o.pos.z - c.z) ** 2 < 35 * 35) { cx += o.pos.x; cz += o.pos.z; n++; }
    this.barrageAt[team] = g.time;
    this.barrage = { team, x: cx / n, z: cz / n, t: g.time + 5, fired: 0 };
    g.bus.emit('endgame:barrage', team, this.barrage.x, this.barrage.z);
    g.bus.emit('notice', `${CONFIG.teams[team].name} ARTILLERY BARRAGE INBOUND`);
  }

  _runBarrage() {
    const br = this.barrage, g = this.game;
    if (!br || g.time < br.t) return;
    if (br.fired >= BARRAGE_SHELLS) { this.barrage = null; return; }
    // One shell every ~0.6 s, scattered around the aim point (denser in the middle).
    const r = 45 * Math.sqrt(Math.random()) * (0.55 + 0.45 * Math.random()), a = Math.random() * Math.PI * 2;
    const x = br.x + Math.cos(a) * r, z = br.z + Math.sin(a) * r;
    const y = Math.max(g.map.terrain.height(x, z), CONFIG.world.waterLevel);
    g.bus.emit('sound', 'whistle', x, y + 30, z);
    g.combat.explode(x, y + 0.3, z, BARRAGE_DEF, null);
    br.fired++;
    br.t = g.time + 0.45 + Math.random() * 0.35;
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

  /** Objectives held by `team` (military bases are not objectives and never count). */
  owned(team) {
    let n = 0;
    for (const f of this.flags) if (!f.base && f.owner === team) n++;
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
      for (const f of this.flags) {
        if (f.base) continue; // military bases cannot be captured
        f.count[0] = f.count[1] = 0;
        for (let i = 0; i < g.soldiers.length; i++) {
          const s = g.soldiers[i];
          if (!s.alive || (s.vehicle && s.vehicle.def.kind !== 'ground')) continue;
          if (inCaptureVolume(f, s.pos.x, s.pos.y, s.pos.z, M.captureRadius)) f.count[s.team]++;
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
    this._endgame(dt);
    this._bleed -= dt;
    if (this._bleed <= 0) {
      this._bleed = M.bleedInterval;
      const a = this.owned(0), b = this.owned(1);
      if (a !== b) this._spend(a < b ? 0 : 1, 1);
    }
  }

  serialize() {
    return {
      tickets: this.tickets.slice(), flags: this.flags.map((f) => [f.owner, f.v]),
      phase: this.phase.slice(), zero: this._zeroFor.slice(), siege: this.siegeStart.slice(), barrage: this.barrageAt.slice(),
    };
  }

  deserialize(d) {
    this.tickets = d.tickets.slice();
    this.over = false; this.winner = -1;
    this.phase = d.phase ? d.phase.slice() : ['normal', 'normal'];
    this._zeroFor = d.zero ? d.zero.slice() : [0, 0];
    this.siegeStart = d.siege ? d.siege.slice() : [0, 0];
    this.barrageAt = d.barrage ? d.barrage.slice() : [-1e9, -1e9];
    this.barrage = null;
    for (let t = 0; t < 2; t++) this._setExposed(t, this.phase[t] === 'siege');
    d.flags.forEach((a, i) => {
      const f = this.flags[i];
      f.owner = a[0]; f.v = a[1]; f.contestedBy = -1;
      this.game.bus.emit('flag:changed', f, f.owner);
    });
  }
}
