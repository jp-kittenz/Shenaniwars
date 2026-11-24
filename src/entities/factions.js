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
      // Milestone 1 expansion (Torsa only)
      { type: 'ifv2', count: 1, site: 'forward' }, { type: 'atcst', count: 1, site: 'forward' }, { type: 'ost', count: 1, site: 'base' },
      { type: 'uaz', count: 2, site: 'forward' }, { type: 'tigr', count: 2, site: 'forward' }, { type: 'brdm', count: 1, site: 'forward' },
      { type: 'cev', count: 1, site: 'base' }, { type: 'grad', count: 1, site: 'base' }, { type: 'smerch', count: 1, site: 'base' },
      { type: 'radar', count: 1, site: 'base' }, { type: 'tel', count: 1, site: 'base' },
      { type: 'gunship', count: 1, site: 'helipad' }, { type: 'reconheli', count: 1, site: 'helipad' },
      { type: 'heavyheli', count: 1, site: 'helipad' },
      { type: 'lightattack', count: 1, site: 'runway' }, { type: 'transportplane', count: 1, site: 'runway' },
      { type: 'fighter2', count: 1, site: 'runway' }, { type: 'fighter3', count: 1, site: 'runway' },
    ],
  },
};

/** @param {number} team */
export const factionOf = (team, teams) => FACTIONS[teams[team].faction];

/** Soldier classes (mirrors src/ai/types.ts SoldierClass). */
export const CLASS = { LEADER: 0, RIFLEMAN: 1, AT: 2, SUPPORT: 3, SPOTTER: 4, CREWMAN: 5, PILOT: 6 };

/** Infantry fire-team template: leader, two riflemen, one AT gunner, an engineer/medic and a spotter. */
const SQUAD_TEMPLATE = [CLASS.LEADER, CLASS.RIFLEMAN, CLASS.AT, CLASS.SUPPORT, CLASS.RIFLEMAN, CLASS.SPOTTER];
const AIRCRAFT = new Set(['heli', 'attackheli', 'transportheli', 'strikejet', 'fighter', 'gunship', 'reconheli', 'heavyheli', 'lightattack', 'transportplane', 'fighter2', 'fighter3']);
/** Ground vehicles that bring a dedicated gunner along with the driver (the scout car's gunner is its air defence). */
const TWO_CREW = new Set(['tank', 'mbt', 'ht', 'jeep']);

/**
 * Vehicle crews a faction musters: one pilot per aircraft, one crewman per
 * ground vehicle plus a gunner for main battle tanks (capped at 40 % of the team).
 * @param {Faction} f @param {number} perTeam
 */
export function crewCounts(f, perTeam) {
  let crew = 0, pilots = 0;
  for (const r of f.roster) {
    if (AIRCRAFT.has(r.type)) pilots += r.count;
    else crew += r.count * (TWO_CREW.has(r.type) ? 2 : 1);
  }
  const cap = Math.floor(perTeam * 0.4);
  if (crew + pilots > cap) { const k = cap / (crew + pilots); crew = Math.floor(crew * k); pilots = Math.floor(pilots * k); }
  return { crew, pilots };
}

/**
 * Class of the `index`-th soldier of a team: infantry fire teams first
 * (template order), then crewmen, then pilots at the end of the list.
 * @param {Faction} f @param {number} index @param {number} perTeam
 */
export function classFor(f, index, perTeam) {
  const { crew, pilots } = crewCounts(f, perTeam);
  const infantry = perTeam - crew - pilots;
  if (index >= infantry + crew) return CLASS.PILOT;
  if (index >= infantry) return CLASS.CREWMAN;
  return SQUAD_TEMPLATE[index % SQUAD_TEMPLATE.length];
}

/**
 * Loadout for a soldier: only the AT class carries a launcher (one per fire
 * team); the human always carries both weapons.
 * @param {Faction} f
 * @param {number} index   index of the soldier within its team
 * @param {boolean} isPlayer
 * @param {number} [cls]   soldier class
 * @returns {string[]} weapon ids, rifle first
 */
export function loadoutFor(f, index, isPlayer, cls = CLASS.RIFLEMAN) {
  const r = ((index * 0.6180339887) % 1);
  let rifle = f.rifles[0];
  // Leaders and spotters favour the modern rifle.
  if (cls !== CLASS.LEADER && cls !== CLASS.SPOTTER) {
    for (let i = 0; i < f.rifles.length; i++) if (r < f.rifleMix[i]) { rifle = f.rifles[i]; break; }
  }
  const at = isPlayer || cls === CLASS.AT;
  return at ? [rifle, f.launcher] : [rifle];
}
