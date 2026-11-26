import { inCaptureVolume } from '../world/flag-volume.js';
import { CONFIG } from '../core/config.js';
import { clamp } from '../core/math.js';
import { CAP_POWER, CapPhase, capturePhase, captureRate } from './capture-rate.js';
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
const _pw = new Float32Array(2), _veh = new Uint8Array(2), _ph = { phase: 0, team: -1 };
/** Base rate: R_cap 1 moves control by CAP_BASE / captureTime per second (≈ the old three-man speed at R 1.35). */
const CAP_BASE = 2.2;

export class CaptureSystem {
  /** @param {import('./game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** @type {Flag[]} */
    this.flags = game.map.flags.map((f) => ({ ...f, v: f.owner === 0 ? -1 : f.owner === 1 ? 1 : 0, contestedBy: -1, count: [0, 0] }));
    this.tickets = [CONFIG.match.tickets, CONFIG.match.tickets];
    /** Situational capture telemetry: ticks per phase, R_cap range, context hits, captures (by overrun). */
    this.capStats = { ticks: [0, 0, 0, 0, 0], minR: 9, maxR: 0, pocket: 0, deep: 0, neutralized: 0, captures: 0, overrunCaptures: 0 };
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

  /**
   * One capture tick of flag f (see capture-rate.js): combat power of each side in the volume (soldiers, AT
   * specialists, the player, combat vehicles on the objective), the phase (NEUTRALIZING / SECURING / CONTESTED /
   * OVERRUN) and the situational rate R_cap from the frontline grid, the force and the defences / supply.
   */
  _captureTick(f, step) {
    const g = this.game, M = CONFIG.match, P = CAP_POWER;
    f.count[0] = f.count[1] = 0;
    const pw = _pw; pw[0] = pw[1] = 0; _veh[0] = _veh[1] = 0;
    for (let i = 0; i < g.soldiers.length; i++) {
      const s = g.soldiers[i];
      if (!s.alive || (s.vehicle && s.vehicle.def.kind !== 'ground')) continue;
      if (!inCaptureVolume(f, s.pos.x, s.pos.y, s.pos.z, M.captureRadius)) continue;
      f.count[s.team]++;
      if (s.vehicle) continue; // (the vehicle counts as the vehicle)
      pw[s.team] += s.isPlayer ? P.player : s.launcher ? P.specialist : P.rifleman;
    }
    const list = g.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.alive || !v.occupied || v.isAircraft || v.def.static || !v.weapons || !v.weapons.length) continue;
      if (!inCaptureVolume(f, v.pos.x, v.pos.y - v.def.ride, v.pos.z, M.captureRadius)) continue;
      const a = v.def.armor;
      pw[v.team] += a === 'heavy' ? P.heavy : a === 'medium' ? P.medium : P.light;
      _veh[v.team] = 1;
    }
    const ph = capturePhase(pw[0], pw[1], f.owner, f.v, _ph);
    f.capPhase = ph.phase; f.capTeam = ph.team;
    const C = this.capStats;
    C.ticks[ph.phase]++;
    if (ph.phase === CapPhase.IDLE) { f.contestedBy = -1; f.capRate = 0; return; }
    // Contested: the non-owner present is the one contesting (the commander reads this).
    f.contestedBy = f.owner >= 0 ? (pw[1 - f.owner] > 0 ? 1 - f.owner : -1) : -1;
    if (ph.phase === CapPhase.CONTESTED) { f.capRate = 0; return; }
    const team = ph.team, target = team === 0 ? -1 : 1;
    let R;
    if (ph.phase === CapPhase.OVERRUN) R = 0.35;
    else {
      // Frontline context: whose ground is this flag on, from the side losing it.
      const F = g.ai && g.ai.frontline;
      let context = 0;
      const loser = ph.phase === CapPhase.NEUTRALIZING ? f.owner : F ? F.owner(F.index(f.x, f.z)) : -1;
      if (F && loser >= 0 && loser !== team) {
        const z = F.zoneAt(loser, f.x, f.z);
        if (z === 4) { context = 0.4; C.pocket++; }               // ENCIRCLED_POCKET: cut off, falls faster
        else if (z === 1 || z === 3) { context = -0.45; C.deep++; } // deep in their rear: a QRF gets its window
      }
      // Defences and supply of the side losing it, while neutralizing.
      let assets = -1;
      if (ph.phase === CapPhase.NEUTRALIZING) {
        assets = 0;
        const r2 = (M.captureRadius * 1.5) ** 2;
        for (let i = 0; i < list.length; i++) {
          const v = list[i];
          if (!v.alive || (v.pos.x - f.x) ** 2 + (v.pos.z - f.z) ** 2 > r2) continue;
          const vt = v.occupied ? v.team : v.spawn.team;
          if (vt !== f.owner) continue;
          if (v.def.static || v.def.role === 'supply') assets++;
        }
        for (const sp of g.map.supplies || []) if (sp.team === f.owner && (sp.x - f.x) ** 2 + (sp.z - f.z) ** 2 < r2) assets++;
      }
      R = captureRate(pw[team], _veh[team] > 0, context, assets);
    }
    f.capRate = R;
    C.minR = Math.min(C.minR, R); C.maxR = Math.max(C.maxR, R);
    if (f.v === target) return;
    const before = f.v;
    f.v = clamp(f.v + target * R * (CAP_BASE / M.captureTime) * step, -1, 1);
    if (f.owner >= 0 && f.owner !== team && before * f.v <= 0) {
      f.owner = -1;
      C.neutralized++;
      g.bus.emit('flag:changed', f, -1);
    }
    if (f.v === target && f.owner !== team) {
      f.owner = team;
      f.contestedBy = -1;
      C.captures++;
      if (ph.phase === CapPhase.OVERRUN) C.overrunCaptures++;
      g.bus.emit('flag:changed', f, team);
    }
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
        this._captureTick(f, step);
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
