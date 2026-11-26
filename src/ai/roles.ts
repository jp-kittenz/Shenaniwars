/**
 * Infantry roles (Milestone 3, stage 2): twelve battlefield roles with distinct skins, the engineering triad's
 * capability gates, the four named special-forces teams, and the event-driven squad classifier. Pure data and
 * functions (unit-tested); the runtime that acts on them is src/systems/field-ops.js and the AI core.
 *
 * Roles sit on top of the soldier classes the AI core already reasons with (LEADER / RIFLEMAN / AT / SUPPORT /
 * SPOTTER / CREWMAN / PILOT): the class keeps the squad's fire-team shape and seat affinities, the role adds the
 * job — what a soldier can build, repair or heal, what he carries and how he looks.
 */

export const Role = {
  SOLDIER: 0, OPERATOR: 1, MEDIC: 2, SAPPER: 3, ENGINEER: 4, MECHANIC: 5, SCOUT: 6, SHOCK: 7, BREACHER: 8,
  MARKSMAN: 9, SF: 10, MORTAR: 11,
} as const;
export const ROLE_COUNT = 12;
export const ROLE_NAMES = ['Soldier', 'Vehicle Operator', 'Medic', 'Sapper', 'Combat Engineer', 'Combat Mechanic', 'Scout',
  'Shock Trooper', 'Breacher', 'Marksman', 'Special Forces', 'Mortar Team'];
/**
 * Render skins: the twelve roles, plus a second special-forces skin (each faction's two teams wear different
 * shoulder patches) and the mortar team's ammunition bearer (the gunner carries the tube, the bearer the shells).
 */
export const SKIN_COUNT = 14;
export const SKIN_SF_B = 12;
export const SKIN_MORTAR_B = 13;

/** Soldier classes (mirrors types.ts SoldierClass, kept local so this module has no imports). */
const C = { LEADER: 0, RIFLEMAN: 1, AT: 2, SUPPORT: 3, SPOTTER: 4, CREWMAN: 5, PILOT: 6 };

/**
 * Squad role templates (six per squad, in fire-team template order LEADER, RIFLEMAN, AT, SUPPORT, RIFLEMAN,
 * SPOTTER). Squads cycle through them so every company has line, assault, engineer, pioneer and fire-support
 * squads.
 */
export const SQUAD_ROLES: readonly (readonly number[])[] = [
  /* line      */ [Role.SOLDIER, Role.SOLDIER, Role.SOLDIER, Role.MEDIC, Role.SHOCK, Role.SCOUT],
  /* assault   */ [Role.SHOCK, Role.BREACHER, Role.SOLDIER, Role.MEDIC, Role.SHOCK, Role.MARKSMAN],
  /* engineers */ [Role.ENGINEER, Role.ENGINEER, Role.ENGINEER, Role.MEDIC, Role.ENGINEER, Role.ENGINEER],
  /* pioneers  */ [Role.SOLDIER, Role.SAPPER, Role.SOLDIER, Role.MECHANIC, Role.SAPPER, Role.SCOUT],
  /* fire spt  */ [Role.SOLDIER, Role.MORTAR, Role.SOLDIER, Role.MORTAR, Role.MARKSMAN, Role.SCOUT],
  /* line 2    */ [Role.SOLDIER, Role.SOLDIER, Role.SOLDIER, Role.MEDIC, Role.SAPPER, Role.MARKSMAN],
];
export const SQUAD_KIND_NAMES = ['line', 'assault', 'engineers', 'pioneers', 'fire support', 'line'];

/** Named special-forces teams per faction (two each), staged at the main HQ. */
export const SF_TEAMS: Record<string, readonly [string, string]> = {
  torsa: ['Spetkrill', 'TSB Omega Group'],
  pampalona: ['Alpha Force', 'Viper Team-8'],
};

/**
 * Role (and skin) of the `index`-th soldier of a team. `infantry` soldiers come first in squads of six; the last
 * two infantry squads are the faction's special forces; crewmen and pilots are vehicle operators.
 * @returns [role, skin, sfTeam (-1 / 0 / 1), squad kind (-1 for crews)]
 */
export function roleFor(index: number, cls: number, infantry: number): [number, number, number, number] {
  if (cls === C.CREWMAN || cls === C.PILOT) return [Role.OPERATOR, Role.OPERATOR, -1, -1];
  const squad = Math.floor(index / 6), squads = Math.floor(infantry / 6);
  // The last two full squads of the line: the named special-forces teams (squad 0 holds the human player).
  if (squads >= 4 && squad >= squads - 2 && squad < squads) {
    const team = squad - (squads - 2);
    return [Role.SF, team === 0 ? Role.SF : SKIN_SF_B, team, -2];
  }
  const kind = squad % SQUAD_ROLES.length;
  // The player's squad (squad 0) is always a line squad.
  const r = SQUAD_ROLES[squad === 0 ? 0 : kind][index % 6];
  const skin = r === Role.MORTAR && cls === C.SUPPORT ? SKIN_MORTAR_B : r;
  return [r, skin, -1, squad === 0 ? 0 : kind];
}

/** Role weapon (overrides the faction rifle); null keeps the faction's rifle. */
export function roleWeapon(role: number, cls: number): string | null {
  switch (role) {
    case Role.MARKSMAN: return 'svd';
    case Role.ENGINEER: return 'rpk16';
    case Role.BREACHER: return 'saiga12';
    case Role.SF: return 'vss';
    case Role.OPERATOR: case Role.MECHANIC: case Role.SAPPER: return cls === C.AT ? null : 'pdw';
    default: return null;
  }
}

// ---------------------------------------------------------------- engineering triad: capability gates

export const Cap = {
  MINES: 1, SMALL_TURRET: 2, HASTY_COVER: 4, WHEEL_REPAIR: 8, TRENCH: 16, BARRACKS: 32, CHECKPOINT: 64, FULL_REPAIR: 128,
  HEAL: 256, MORTAR: 512, BREACH: 1024,
} as const;

/** What each role can do (bit set of Cap). */
export const ROLE_CAPS: readonly number[] = [
  /* Soldier   */ 0,
  /* Operator  */ 0,
  /* Medic     */ Cap.HEAL,
  /* Sapper    */ Cap.MINES | Cap.SMALL_TURRET | Cap.HASTY_COVER | Cap.WHEEL_REPAIR,
  /* Engineer  */ Cap.TRENCH | Cap.BARRACKS | Cap.CHECKPOINT | Cap.HASTY_COVER,
  /* Mechanic  */ Cap.FULL_REPAIR,
  /* Scout     */ 0,
  /* Shock     */ Cap.BREACH,
  /* Breacher  */ Cap.BREACH,
  /* Marksman  */ 0,
  /* SF        */ Cap.MINES | Cap.BREACH | Cap.HEAL,
  /* Mortar    */ Cap.MORTAR,
];

export function can(role: number, cap: number): boolean { return ((ROLE_CAPS[role] ?? 0) & cap) !== 0; }

/**
 * How much of a vehicle a role may repair, as the health fraction it can bring the vehicle up to (0: none).
 * Sappers only patch wheels and tyres on wheeled vehicles (up to 60 %); mechanics do full repairs (hull, turret,
 * engine, tracks) on anything.
 */
export function repairCeiling(role: number, tracked: boolean): number {
  if (can(role, Cap.FULL_REPAIR)) return 1;
  if (can(role, Cap.WHEEL_REPAIR)) return tracked ? 0 : 0.6;
  return 0;
}

/** Repair rate (fraction of the vehicle's health per second) by role. */
export function repairRate(role: number): number { return can(role, Cap.FULL_REPAIR) ? 0.035 : can(role, Cap.WHEEL_REPAIR) ? 0.015 : 0; }

/** Builds a combat-engineer group (3–6) can raise, with their work-seconds per stage. */
export const Build = { TRENCH: 0, BARRACKS: 1, CHECKPOINT: 2, MG_NEST: 3, MINEFIELD: 4, SANDBAGS: 5 } as const;
export const BUILD_NAMES = ['modular trench', 'forward barracks', 'checkpoint', 'MG emplacement', 'minefield', 'sandbag cover'];
/** Engineer-seconds per stage, and stages, per build. */
export const BUILD_WORK = [24, 60, 90, 20, 8, 10];
export const BUILD_STAGES = [3, 1, 1, 1, 1, 1];
export const TRENCH_STAGE_NAMES = ['earth parapet', 'sandbagged trench', 'overhead-covered firing bay'];
/** Engineers a build needs at once (a lone engineer cannot raise a checkpoint). */
export const BUILD_CREW = [2, 3, 3, 1, 1, 1];
/** Which role capability each build needs. */
export const BUILD_CAP = [Cap.TRENCH, Cap.BARRACKS, Cap.CHECKPOINT, Cap.SMALL_TURRET, Cap.MINES, Cap.HASTY_COVER];

// ---------------------------------------------------------------- squad classification

export const SquadClass = {
  LIGHT: 0, MOTORIZED: 1, MECHANIZED: 2, ARMORED: 3, CAVALRY: 4, AIRBORNE: 5, AIRMOBILE: 6, MARINE: 7, ALPINE: 8,
} as const;
export const SQUAD_CLASS_NAMES = ['Light Infantry', 'Motorized', 'Mechanized', 'Armored', 'Armored Cavalry', 'Airborne', 'Airmobile', 'Marine', 'Alpine'];
export const SQUAD_CLASS_TAGS = ['LIGHT', 'MOT', 'MECH', 'ARMOR', 'CAV', 'AIRBORNE', 'AIRMOBILE', 'MARINE', 'ALPINE'];

/** Vehicle families the classifier needs (by vehicle type id). */
const WHEELED_LIGHT = new Set(['truck', 'uaz', 'tigr', 'supply', 'jeep', 'ost']);
const IFV_APC = new Set(['ifv', 'ifv2', 'apc', 'atcst']);
const TANKS = new Set(['mbt', 'ht', 'tank', 'lt']);
const RECON = new Set(['brdm', 'lt']);
const ROTARY = new Set(['transportheli', 'heavyheli', 'reconheli', 'gunship', 'heli', 'attackheli']);
const AMPHIBIOUS = new Set(['ifv2', 'brdm']);

export interface SquadFacts {
  /** Type id of the vehicle the squad is paired with (its own transport / the one it rides), '' none. */
  vehicle: string;
  /** Aboard a cargo aircraft staged for a paradrop. */
  paradrop: boolean;
  /** Members that are scouts / marksmen / crew operators (counts). */
  scouts: number; operators: number; members: number;
  /** Squad centre over water or heading across it (coastal crossing). */
  water: boolean;
  /** Mean ground height above sea and slope at the squad (m, 0..1). */
  elevation: number; slope: number;
}

/** Elevation (m above sea) and slope from which a foot squad counts as alpine. */
export const ALPINE_ELEVATION = 38, ALPINE_SLOPE = 0.32;

/**
 * Classifies a squad from its current facts (event-driven: on roster change, boarding / leaving a vehicle,
 * airborne insertion, or crossing an elevation band — never polled per frame).
 */
export function classifySquad(f: SquadFacts): number {
  if (f.paradrop) return SquadClass.AIRBORNE;
  const v = f.vehicle;
  if (v) {
    if (ROTARY.has(v)) return SquadClass.AIRMOBILE;
    if (v === 'transportplane') return SquadClass.AIRBORNE;
    if (f.water && AMPHIBIOUS.has(v)) return SquadClass.MARINE;
    if (TANKS.has(v) && f.operators * 2 >= f.members) return SquadClass.ARMORED;
    if ((RECON.has(v) || v === 'tigr') && f.scouts > 0) return SquadClass.CAVALRY;
    if (TANKS.has(v)) return SquadClass.ARMORED;
    if (IFV_APC.has(v)) return SquadClass.MECHANIZED;
    if (WHEELED_LIGHT.has(v)) return SquadClass.MOTORIZED;
    return SquadClass.MOTORIZED;
  }
  if (f.elevation >= ALPINE_ELEVATION || f.slope >= ALPINE_SLOPE) return SquadClass.ALPINE;
  return SquadClass.LIGHT;
}
