import { CONFIG } from '../core/config.js';

/**
 * A fire team. Holds the shared tactical picture (objective + focus target)
 * and hands out roles so that members suppress while others flank.
 */
export class Squad {
  /** @param {number} id @param {number} team */
  constructor(id, team) {
    this.id = id;
    this.team = team;
    /** @type {import('../entities/soldier.js').Soldier[]} */
    this.members = [];
    /** @type {import('../entities/soldier.js').Soldier|null} */
    this.leader = null;
    /** @type {import('./capture.js').Flag|null} */
    this.objective = null;
    this.objectiveTime = -100;
    this.defensive = false;
    /** Shared target: last enemy any member has eyes on. */
    this.focus = /** @type {any} */ (null);
    this.focusX = 0; this.focusY = 0; this.focusZ = 0;
    this.focusTime = -100;
    this.cx = 0; this.cz = 0;
  }

  /** Called by a member that currently sees `enemy`. */
  report(enemy, time) {
    if (this.focus !== enemy && time - this.focusTime < 1.5 && this.focus && this.focus.alive) return;
    this.focus = enemy;
    this.focusX = enemy.pos.x; this.focusY = enemy.pos.y; this.focusZ = enemy.pos.z;
    this.focusTime = time;
  }

  hasFocus(time) {
    return this.focus !== null && this.focus.alive && time - this.focusTime < 7;
  }
}

/**
 * Creates squads, elects leaders, picks objectives and issues flank orders.
 */
export class SquadSystem {
  /** @param {import('./game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** @type {Squad[]} */
    this.squads = [];
    this._timer = 0;
    const size = CONFIG.match.squadSize;
    for (let team = 0; team < 2; team++) {
      const soldiers = game.soldiers.filter((s) => s.team === team);
      for (let i = 0; i < soldiers.length; i += size) {
        const squad = new Squad(this.squads.length, team);
        squad.defensive = i / size === 2; // the third fire team of each side guards the line
        for (const s of soldiers.slice(i, i + size)) { squad.members.push(s); s.squad = squad; }
        this.squads.push(squad);
      }
    }
  }

  /** @param {Squad} squad */
  _chooseObjective(squad) {
    const g = this.game, flags = g.capture.flags;
    let best = null, bestScore = 1e9;
    for (const f of flags) {
      const mine = f.owner === squad.team;
      const contested = f.contestedBy >= 0 && f.contestedBy !== squad.team;
      let score = Math.hypot(f.x - squad.cx, f.z - squad.cz) * (0.75 + Math.random() * 0.5);
      if (squad.defensive) {
        if (!mine) score += 260;          // prefer holding ground...
        else if (!contested) score += 120; // ...especially ground under attack
      } else if (mine && !contested) score += 900;
      // Spread squads across objectives instead of dog-piling one flag.
      for (const o of this.squads) if (o !== squad && o.team === squad.team && o.objective === f) score += 70;
      if (score < bestScore) { bestScore = score; best = f; }
    }
    squad.objective = best;
    squad.objectiveTime = g.time;
  }

  /** @param {number} dt */
  update(dt) {
    this._timer -= dt;
    if (this._timer > 0) return;
    this._timer = 1.0;
    const g = this.game;
    for (const squad of this.squads) {
      let n = 0, cx = 0, cz = 0;
      squad.leader = null;
      for (const s of squad.members) {
        if (!s.alive) continue;
        if (!squad.leader && s.ai) squad.leader = s;
        cx += s.pos.x; cz += s.pos.z; n++;
      }
      if (n > 0) { squad.cx = cx / n; squad.cz = cz / n; }
      const o = squad.objective;
      const stale = !o || g.time - squad.objectiveTime > 45 ||
        (o.owner === squad.team && o.contestedBy < 0 && !squad.defensive && g.time - squad.objectiveTime > 4);
      if (stale && n > 0) this._chooseObjective(squad);

      // Tactics: with a live focus target, the leader's pair suppresses and the rest split to both flanks.
      const engaged = squad.hasFocus(g.time);
      let k = 0;
      for (const s of squad.members) {
        if (!s.ai) continue;
        if (!s.alive) { s.ai.role = 'assault'; continue; }
        if (!engaged || s.vehicle) { s.ai.role = 'assault'; k++; continue; }
        const role = k < 2 ? 'suppress' : k % 2 === 0 ? 'flankL' : 'flankR';
        if (role !== s.ai.role) {
          s.ai.role = role;
          if (role !== 'suppress') {
            let dx = squad.focusX - squad.cx, dz = squad.focusZ - squad.cz;
            const len = Math.hypot(dx, dz) || 1;
            dx /= len; dz /= len;
            const side = role === 'flankL' ? 1 : -1;
            const reach = Math.min(30, len * 0.6);
            s.ai.flankX = squad.focusX + -dz * side * reach - dx * 8;
            s.ai.flankZ = squad.focusZ + dx * side * reach - dz * 8;
            s.ai.flankDone = false;
          }
        }
        k++;
      }
    }
  }
}
