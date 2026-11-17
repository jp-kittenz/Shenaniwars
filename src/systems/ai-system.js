import { AIAgent } from '../entities/ai-agent.js';

/**
 * Owns every bot brain: staggered think scheduling (inside each agent),
 * per-frame execution, and the hearing model (gunfire/explosion noise events
 * alert enemy agents within earshot).
 */
export class AISystem {
  /** @param {import('./game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** @type {AIAgent[]} */
    this.agents = [];
    const perTeam = [0, 0];
    for (const s of game.soldiers) {
      const index = perTeam[s.team]++;
      if (s.isPlayer) continue;
      s.ai = new AIAgent(game, s, index);
      this.agents.push(s.ai);
    }
    game.bus.on('noise', (x, z, radius, team) => {
      const r2 = radius * radius;
      for (let i = 0; i < this.agents.length; i++) {
        const a = this.agents[i], s = a.s;
        if (s.team === team || !s.alive) continue;
        const dx = s.pos.x - x, dz = s.pos.z - z;
        if (dx * dx + dz * dz < r2) a.onNoise(x, z);
      }
    });
  }

  /** @param {number} dt */
  update(dt) {
    for (let i = 0; i < this.agents.length; i++) this.agents[i].update(dt);
  }
}
