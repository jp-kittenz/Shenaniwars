/**
 * Supply economy (Milestone 3, stage 1): pure rules, unit-tested on their own. The runtime that moves crates,
 * trucks and thrown kit around is src/systems/logistics.js.
 *
 *  - Main HQs hold unlimited stock. Every other location holds a finite number of crate-equivalents, scaled by its
 *    strategic tier and its physical footprint: outposts (hardened bunkers and storage yards) hold the most, then
 *    depots and harbours, towns, villages, and engineer-built checkpoints the least.
 *  - Below 35 % a location signals LOGISTICS_RESUPPLY_NEEDED (a LOGISTICS_REQUEST of subtype LOCATION), its priority
 *    raised by how close the location sits to contested frontline cells.
 *  - A crate holds 10 resupply charges; empty, it collapses and despawns.
 *  - Vehicles carry finite stowage for every weapon (caliber-labelled), fuel and internal repair kits; below 25 % of
 *    primary ordnance or fuel the crew weighs a resupply run.
 */

export const SiteTier = { HQ: 0, OUTPOST: 1, DEPOT: 2, TOWN: 3, VILLAGE: 4, CHECKPOINT: 5 } as const;
export const TIER_NAMES = ['HQ', 'outpost', 'depot', 'town', 'village', 'checkpoint'];

/** Strategic tier of each named location (anything unlisted counts as a village cache). */
export const TIER_BY_FLAG: Record<string, number> = {
  BRAVO: SiteTier.OUTPOST, CHARLIE: SiteTier.OUTPOST, FOXTROT: SiteTier.OUTPOST, GOLF: SiteTier.OUTPOST, OSCAR: SiteTier.OUTPOST,
  DELTA: SiteTier.DEPOT, INDIA: SiteTier.DEPOT, JULIET: SiteTier.DEPOT, KILO: SiteTier.DEPOT,
  ALPHA: SiteTier.TOWN, ECHO: SiteTier.TOWN, MIKE: SiteTier.TOWN,
  HOTEL: SiteTier.VILLAGE, LIMA: SiteTier.VILLAGE, NOVEMBER: SiteTier.VILLAGE,
};

/** Crate-equivalent range per tier (min at the smallest footprint, max at the largest). */
export const TIER_RANGE: readonly (readonly [number, number])[] = [
  [Infinity, Infinity], [120, 180], [100, 140], [60, 90], [30, 50], [15, 25],
];

/** Footprint radius (m) mapped onto a tier's range: 45 m → its minimum, 95 m → its maximum. */
export function capacityFor(tier: number, footprintR: number): number {
  const r = TIER_RANGE[tier] || TIER_RANGE[SiteTier.VILLAGE];
  if (r[0] === Infinity) return Infinity;
  const k = Math.max(0, Math.min(1, (footprintR - 45) / 50));
  return Math.round(r[0] + (r[1] - r[0]) * k);
}

export const RESUPPLY_THRESHOLD = 0.35;
export const CRATE_USES = 10;
/** Interaction reach to a crate (m). */
export const CRATE_REACH = 4;

/** True when a location should ask for a supply run. */
export function needsResupply(current: number, max: number): boolean {
  return max !== Infinity && max > 0 && current / max < RESUPPLY_THRESHOLD;
}

/**
 * Priority of a location's resupply signal: emptier and closer to the front ask harder. `frontDist` is the distance
 * (m) to the nearest contested frontline cell of the asking side (Infinity: none).
 */
export function resupplyPriority(current: number, max: number, frontDist: number): number {
  const empty = 1 - Math.max(0, Math.min(1, current / Math.max(1, max)));
  const front = frontDist === Infinity ? 0 : Math.max(0, 1 - frontDist / 600);
  return Math.round(1 + empty * 3 + front * 4);
}

// ---------------------------------------------------------------- crates

/** One crate's state transition on a use: returns the uses left (0 → it collapses and despawns). */
export function useCrate(uses: number, take = 1): number { return Math.max(0, uses - take); }

/** Crate uses a vehicle's full rearm draws from a supply zone, by armour class. */
export function rearmCost(armor: string): number {
  return armor === 'heavy' ? 6 : armor === 'light' ? 4 : armor === 'heli' || armor === 'jet' ? 5 : 2;
}

// ---------------------------------------------------------------- vehicle stowage

export interface Stowage { total: number; label: string }

/**
 * Rounds a vehicle carries for each weapon (beyond what is loaded) and the caliber stencilled on its ammunition
 * boxes. Weapons without an entry (searchlights, fixed base SAMs) stay unlimited.
 */
export const STOWAGE: Record<string, Stowage> = {
  mountedMG: { total: 1500, label: '7.62MM' }, pkt: { total: 2000, label: '7.62MM' }, kord: { total: 900, label: '12.7MM' },
  cannon: { total: 40, label: '105MM' }, cannon125: { total: 40, label: '125MM' }, ac30: { total: 500, label: '30MM' },
  gsh30: { total: 750, label: '30MM' }, aa23: { total: 2000, label: '23MM' }, aa30: { total: 1400, label: '30MM' },
  atgm: { total: 8, label: 'ATGM' }, vikhr: { total: 12, label: 'ATGM' }, rockets: { total: 42, label: '80MM ROCKETS' },
  rockets80: { total: 40, label: '80MM ROCKETS' }, bomb500: { total: 4, label: 'FAB-500' }, aam: { total: 8, label: 'AAM' },
  sam: { total: 24, label: 'SAM' }, mlrs: { total: 24, label: '300MM' }, grad: { total: 80, label: '122MM' },
  smerch: { total: 24, label: '300MM' }, tbm: { total: 4, label: 'TBM' }, howitzer: { total: 50, label: '152MM' },
};

/** Ammunition box size (w, h, d in m) for a caliber label: a 7.62 tin up to a 300 mm rocket case. */
export function boxSize(label: string): [number, number, number] {
  switch (label) {
    case '7.62MM': return [0.26, 0.16, 0.12];
    case '12.7MM': return [0.32, 0.2, 0.16];
    case '23MM': case '30MM': return [0.48, 0.26, 0.3];
    case '80MM ROCKETS': return [0.9, 0.22, 0.26];
    case '105MM': case '125MM': return [1.05, 0.22, 0.3];
    case 'ATGM': case 'AAM': case 'SAM': return [1.25, 0.2, 0.2];
    case '122MM': return [1.3, 0.26, 0.3];
    case '152MM': return [0.9, 0.34, 0.4];
    case '300MM': case 'TBM': return [1.6, 0.42, 0.42];
    case 'FAB-500': return [1.4, 0.45, 0.45];
    default: return [0.4, 0.24, 0.24];
  }
}

/**
 * Loaded + stowed rounds a vehicle weapon holds when fully stocked, as [loaded, reserve]. Belt-fed and
 * single-chamber guns (mag Infinity) become a finite loaded count; magazine weapons keep their magazine and gain a
 * finite reserve.
 */
export function stockFor(id: string, mag: number): [number, number] | null {
  const s = STOWAGE[id];
  if (!s) return null;
  if (mag === Infinity) return [s.total, 0];
  return [mag, Math.max(0, s.total - mag)];
}

/** 0..1 how much of a weapon's full stock is left. */
export function stockFrac(ammo: number, reserve: number, loaded: number, stowed: number): number {
  const full = loaded + stowed;
  if (!(full > 0) || full === Infinity) return 1;
  return Math.max(0, Math.min(1, (ammo + reserve) / full));
}

export const VEHICLE_RESUPPLY_AT = 0.25;
/** Fuel drawn per second at full throttle and at idle (fraction of a tank). */
export const FUEL_FULL = 1 / 720, FUEL_IDLE = 1 / 9000;

/** Fuel burned over dt by a vehicle moving at |speed| of maxSpeed. */
export function fuelBurn(speed: number, maxSpeed: number, dt: number): number {
  const k = Math.min(1, Math.abs(speed) / Math.max(1, maxSpeed));
  return dt * (FUEL_IDLE + (FUEL_FULL - FUEL_IDLE) * k);
}

/** Internal repair kits carried, by armour class. */
export function kitsFor(armor: string): number { return armor === 'heavy' ? 3 : armor === 'light' ? 2 : 1; }

export const ThrowItem = { AMMO: 0, FUEL: 1, KIT: 2 } as const;
export const THROW_NAMES = ['ammunition box', 'fuel box', 'repair kit'];
/** Seconds between the three throws of a resupply, and the length of each throw's arc. */
export const THROW_STAGGER = 0.35, THROW_FLIGHT = 0.55;

/**
 * What the supplier throws a halted vehicle's crewman: the caliber box of its most-depleted weapon, a fuel box,
 * a repair kit — always all three, so the crewman collects everything in one seating.
 * @param fracs per-weapon stock fraction, labels their caliber labels
 * @returns index of the weapon whose caliber the ammunition box carries (-1: none limited)
 */
export function mostDepleted(fracs: ArrayLike<number>, labels: ArrayLike<string | null>): number {
  let bi = -1, bf = 2;
  for (let i = 0; i < fracs.length; i++) if (labels[i] && fracs[i] < bf) { bf = fracs[i]; bi = i; }
  return bi;
}

// ---------------------------------------------------------------- truck doctrine

export const TruckClass = { OST: 0, CST: 1, ATCST: 2 } as const;
/** Crates each truck class carries. */
export const TRUCK_CRATES = [40, 20, 20];
export const TRUCK_NAMES = ['OST', 'CST', 'AT-CST'];
export function truckClassOf(type: string): number { return type === 'ost' ? 0 : type === 'supply' ? 1 : type === 'atcst' ? 2 : -1; }

/**
 * Risk along a supply route through the frontline grid (zones of the travelling side): contested cells weigh 1,
 * rear-area breaches 1.5, pockets 0.5 — summed over the cells the straight line crosses, sampled every 50 m.
 */
export function routeRisk(zoneAt: (x: number, z: number) => number, x0: number, z0: number, x1: number, z1: number): number {
  const d = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(d / 50));
  let risk = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n, z = zoneAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
    risk += z === 2 ? 1 : z === 3 ? 1.5 : z === 4 ? 0.5 : 0;
  }
  return risk;
}

/** Escort vehicles an OST run wants: at least one, more with route risk and urgency (capped at three). */
export function escortsWanted(risk: number, priority: number): number {
  return Math.max(1, Math.min(3, 1 + Math.floor(risk / 3) + (priority >= 7 ? 1 : 0)));
}

/** Route penalty per nav cell (added to vehicle path cost) for logistics traffic, by zone. */
export const FRONT_PENALTY = [0, 0, 12, 18, 6];
