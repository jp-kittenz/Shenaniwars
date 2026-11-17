/**
 * Faction content: infantry loadouts, uniform palettes and vehicle rosters.
 * Pampalona still fields the original placeholder kit; Torsa has its own.
 */

/**
 * @typedef {Object} Faction
 * @property {string} id
 * @property {string[]} rifles     rifle ids, assigned round-robin
 * @property {number[]} rifleMix   cumulative share for each rifle
 * @property {string} launcher
 * @property {Record<string, number[]>} uniform  camo/kit palette (hex colours)
 * @property {boolean} balaclava
 * @property {{type: string, count: number, site: 'base'|'forward'|'helipad'|'runway'}[]} roster
 */

/** @type {Record<string, Faction>} */
export const FACTIONS = {
  pampalona: {
    id: 'pampalona',
    rifles: ['rifle'],
    rifleMix: [1],
    launcher: 'launcher',
    balaclava: false,
    uniform: {
      camo: [0xb39c74, 0x8c7752, 0x6f6b47, 0xcbb994],
      vest: [0x9a8461], helmet: [0xa48d68], skin: [0xd9a27a], cloth: [0x4a4436],
      gloves: [0x3b372f], boots: [0x5f4b34], strap: [0x5a4c36],
    },
    roster: [
      { type: 'jeep', count: 2, site: 'base' }, { type: 'jeep', count: 2, site: 'forward' },
      { type: 'tank', count: 2, site: 'base' }, { type: 'heli', count: 2, site: 'helipad' },
    ],
  },
  torsa: {
    id: 'torsa',
    rifles: ['ak12', 'ak47'],
    rifleMix: [0.6, 1],
    launcher: 'rpg7',
    balaclava: true,
    uniform: {
      camo: [0x56653a, 0x6c7a47, 0x3e482b, 0x8b8a5d],
      vest: [0x4a5433], helmet: [0x55613a], skin: [0xcf9a74], cloth: [0x33382b],
      gloves: [0x262722], boots: [0x2a2420], strap: [0x3a4029],
    },
    roster: [
      { type: 'mbt', count: 2, site: 'base' }, { type: 'mbt', count: 1, site: 'forward' },
      { type: 'ht', count: 2, site: 'base' },
      { type: 'lt', count: 1, site: 'base' }, { type: 'lt', count: 1, site: 'forward' },
      { type: 'apc', count: 1, site: 'base' }, { type: 'apc', count: 2, site: 'forward' },
      { type: 'ifv', count: 1, site: 'base' }, { type: 'ifv', count: 2, site: 'forward' },
      { type: 'truck', count: 2, site: 'base' }, { type: 'truck', count: 1, site: 'forward' },
      { type: 'supply', count: 1, site: 'base' }, { type: 'supply', count: 1, site: 'forward' },
      { type: 'mlrs', count: 1, site: 'base' }, { type: 'howitzer', count: 2, site: 'base' },
      { type: 'sam', count: 1, site: 'base' }, { type: 'spaag', count: 1, site: 'base' },
      { type: 'attackheli', count: 2, site: 'helipad' }, { type: 'transportheli', count: 2, site: 'helipad' },
      { type: 'strikejet', count: 1, site: 'runway' }, { type: 'fighter', count: 1, site: 'runway' },
    ],
  },
};

/** @param {number} team */
export const factionOf = (team, teams) => FACTIONS[teams[team].faction];

/**
 * Loadout for a soldier: every fourth member of a fire team is an AT gunner;
 * the human always carries both weapons.
 * @param {Faction} f
 * @param {number} index   index of the soldier within its team
 * @param {boolean} isPlayer
 * @returns {string[]} weapon ids, rifle first
 */
export function loadoutFor(f, index, isPlayer) {
  const r = ((index * 0.6180339887) % 1);
  let rifle = f.rifles[0];
  for (let i = 0; i < f.rifles.length; i++) if (r < f.rifleMix[i]) { rifle = f.rifles[i]; break; }
  const at = isPlayer || index % 4 === 2;
  return at ? [rifle, f.launcher] : [rifle];
}
