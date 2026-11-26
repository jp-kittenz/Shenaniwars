/**
 * Emergent infantry intelligence (Milestone 3, stages 3–4): the inputs every decision below feeds to the Q1–Q6
 * gate. There are no behaviour scripts here — no "if enemy near flag then ambush" — only answers to the five
 * questions computed from what the squad knows (observations, predictions, morale, geometry); the gate
 * (deliberation.ts) and each actor's temperament decide. Pure functions, unit-tested.
 */

// ---------------------------------------------------------------- morale

export const MoraleBand = { STEADY: 0, SHAKEN: 1, PANIC: 2 } as const;
export const MORALE_NAMES = ['STEADY', 'SHAKEN', 'PANIC'];
export function moraleBand(m: number): number { return m >= 0.55 ? MoraleBand.STEADY : m >= 0.25 ? MoraleBand.SHAKEN : MoraleBand.PANIC; }

export interface MoraleInputs {
  /** Squadmates lost in the last 30 s. */
  casualties: number;
  /** 0..1 incoming artillery / MLRS / mortar near the squad (recent heavy blasts). */
  artillery: number;
  /** 0..1 fire from a flank or the rear. */
  flanked: number;
  /** 0..1 enemy armour close with nothing on our side able to answer it. */
  armour: number;
  /** 0..1 enemy helicopters low overhead. */
  helicopter: number;
  /** Inside an encircled pocket. */
  pocket: boolean;
  /** 0..1 average suppression on the squad. */
  suppression: number;
  /** Recovery: leader near, in cover, medic near. */
  leader: boolean; cover: boolean; medic: boolean;
}

/** Morale change per second (negative under pressure, positive while recovering). */
export function moraleRate(i: MoraleInputs): number {
  const down = 0.03 * Math.min(4, i.casualties) + 0.05 * i.artillery + 0.015 * i.flanked + 0.025 * i.armour + 0.02 * i.helicopter + (i.pocket ? 0.02 : 0) + 0.025 * Math.max(0, i.suppression - 0.3);
  // Recovery only once the pressure eases (no fresh losses).
  const calm = i.casualties === 0 ? 1 : 0.3;
  const up = (0.01 + (i.leader ? 0.01 : 0) + (i.cover ? 0.01 : 0) + (i.medic ? 0.006 : 0)) * calm;
  return up - down;
}

/** Panic is a bounded survival reaction: 4–8 s (by temperament), then morale is restored to at least SHAKEN. */
export const PANIC_MIN = 4, PANIC_MAX = 8, PANIC_RECOVER = 0.3, PANIC_IMMUNE = 15;
export function panicDuration(temper: number): number { return PANIC_MIN + (PANIC_MAX - PANIC_MIN) * Math.max(0, Math.min(1, 1 - temper)); }

/** Morale shifts from POW captures: the captors' squads near gain, the losing side's squads near lose. */
export const POW_MORALE_CAPTOR = 0.15, POW_MORALE_LOSER = -0.12;

// ---------------------------------------------------------------- surrender

export interface SurrenderFacts {
  morale: number;
  /** Encircled pocket around him. */
  pocket: boolean;
  /** Local enemy : friendly combat power around him (within 60 m). */
  ratio: number;
  /** 0..1 health. */
  hp: number;
  /** 0..1 how viable an escape is (cover / friendly ground within reach, not surrounded). */
  escape: number;
  /** Bailed out of a doomed / surrounded vehicle. */
  bailed: boolean;
  /** Distance to the nearest enemy that could take him (m). */
  enemyDist: number;
}

/**
 * Q1–Q5 answers for surrendering: why (morale broken), necessary (no viable escape), benefit (fighting on is
 * hopeless: 3:1 in a pocket, wounded and cornered, or bailed from a doomed vehicle), outcome (an enemy close
 * enough to accept it), resources (always).
 */
export function surrenderAnswers(f: SurrenderFacts, out: Float32Array): Float32Array {
  out[0] = f.morale < 0.25 ? 1 : 0;
  out[1] = f.escape < 0.2 ? 1 : f.escape < 0.4 ? 0.4 : 0;
  const hopeless = (f.pocket && f.ratio >= 3) || f.ratio >= 4 || (f.hp < 0.35 && f.ratio >= 2) || (f.bailed && f.ratio >= 2);
  out[2] = hopeless ? 1 : 0.2;
  out[3] = f.enemyDist < 60 ? 1 : 0;
  out[4] = 1;
  return out;
}

// ---------------------------------------------------------------- buddy drag

export interface DragFacts {
  /** Casualty downed in an exposed fire lane (enemy line of fire onto him). */
  exposed: boolean;
  /** Rescuer → casualty distance (m). */
  dist: number;
  /** 0..1 rescuer's suppression. */
  suppression: number;
  /** 0..1 share of the way crossing active enemy fire cones. */
  crossing: number;
  /** Rescuer carries smoke. */
  smoke: boolean;
  /** Distance from the casualty to the nearest hard cover (m). */
  coverDist: number;
  /** Rescuer health 0..1, and whether someone else is already dragging him. */
  hp: number; taken: boolean;
}

/** Q1–Q5 for a rescuer dragging a downed squadmate to cover (benefit of a life vs the risk of the crossing). */
export function dragAnswers(f: DragFacts, out: Float32Array): Float32Array {
  out[0] = f.exposed ? 1 : 0;
  out[1] = f.taken ? 0 : f.dist < 40 ? 1 : 0.3;
  out[2] = Math.max(0, 1 - f.crossing * (f.smoke ? 0.45 : 1) - f.suppression * 0.5);
  out[3] = f.coverDist < 25 ? 1 : 0.3;
  out[4] = f.hp > 0.35 ? 1 : 0;
  return out;
}

// ---------------------------------------------------------------- baiting (three tiers, all emergent)

/**
 * Tier 1 — peek & feint. A frontal push against an enemy holding an angle (in cover, watching our approach) is
 * high-casualty: its Q3 falls with the enemy's protection and our exposure. Element A suppressing draws the
 * enemy's aim cones onto itself, which raises element B's Q4 for a flank on the blind side — so FLANK wins over
 * ASSAULT whenever the flank route exists, with no bait state anywhere.
 * @returns [frontal Q3 benefit, flank Q4 outcome]
 */
export function feintAnswers(enemyProtection: number, ourExposure: number, ratio: number, flankRoute: boolean, suppressing: number, out: Float32Array): Float32Array {
  out[0] = Math.max(0, Math.min(1, ratio / 3 - enemyProtection * 0.6 - ourExposure * 0.4 + 0.3));
  out[1] = flankRoute ? Math.min(1, 0.35 + 0.25 * suppressing + 0.4 * enemyProtection) : 0.1;
  return out;
}

/**
 * Tier 2 — vehicle / recon lure. A fast scout vehicle facing armour beyond its frontal penetration rejects the
 * slugfest (Q3) and, when friendly ATGMs / AT teams or mines lie behind it (Q4), harasses and reverses down that
 * corridor instead. @returns [slugfest Q3, lure Q4]
 */
export function lureAnswers(canPenetrate: boolean, friendlyAtBehind: number, minesBehind: number, out: Float32Array): Float32Array {
  out[0] = canPenetrate ? 0.8 : 0.1;
  out[1] = Math.min(1, 0.45 * friendlyAtBehind + 0.4 * minesBehind);
  return out;
}

/**
 * Tier 3 — strategic flag baiting. At a lightly held flag the squad weighs CAPTURE_RING against AMBUSH_PERIMETER:
 * predicted enemy QRF arriving (ETA from observations + predicted paths) before the capture completes, in the open,
 * makes the ring a wipe risk (Q3) and the ambush's outcome (Q4) good; capture afterwards, unopposed.
 * @param qrfEta seconds until the predicted QRF reaches the flag (Infinity: none)
 * @param captureT seconds the capture would take from here
 * @param openness 0..1 how exposed the capture ring is
 * @param qrfStrength predicted QRF strength relative to the squad (1 = equal)
 * @returns [ring Q3, ambush Q4]
 */
export function flagBaitAnswers(qrfEta: number, captureT: number, openness: number, qrfStrength: number, coverNear: boolean, out: Float32Array): Float32Array {
  const caught = qrfEta < captureT ? 1 : qrfEta < captureT * 1.4 ? 0.5 : 0;
  out[0] = Math.max(0, 1 - caught * (0.4 + 0.5 * openness) * Math.min(1.5, qrfStrength));
  out[1] = caught > 0 && coverNear ? Math.min(1, 0.5 + 0.3 * caught + 0.2 * (1 - Math.min(1, qrfStrength / 2))) : 0.1;
  return out;
}

/** ETA (s) of an observed enemy group moving at (vx, vz) from (x, z) toward a point, or Infinity if not heading there. */
export function etaTo(x: number, z: number, vx: number, vz: number, tx: number, tz: number): number {
  const dx = tx - x, dz = tz - z, d = Math.hypot(dx, dz), sp = Math.hypot(vx, vz);
  // (an enemy holding still is the defender, not a QRF on its way)
  if (sp < 0.6) return Infinity;
  const cos = (vx * dx + vz * dz) / (sp * (d || 1));
  return cos > 0.6 ? d / (sp * cos) : Infinity;
}

// ---------------------------------------------------------------- post-capture rearguard

export const Rearguard = { BLITZ: 0, ROOFTOP: 1, GARRISON: 2, EMPTY_AMBUSH: 3, ARMOR_SPLIT: 4, SABOTAGE: 5 } as const;
export const REARGUARD_NAMES = ['momentum blitz', 'rooftop overwatch rearguard', 'battered improvised garrison', 'empty flag ambush', 'armor overwatch split', 'hit-and-run sabotage'];

export interface RearguardVars {
  /** 0..1 how exposed the flag is on the frontline (contested neighbours / enemy near). */
  exposure: number;
  /** Seconds until a dedicated garrison arrives (Infinity: none coming). */
  garrisonEta: number;
  /** 0..1 squad casualties + POW burden (escorting prisoners ties riflemen down). */
  burden: number;
  /** 0..1 enemy retreat memory: how many beaten defenders fled and may come back. */
  retreat: number;
  /** 0..1 visibility (EnvironmentState: night / fog / rain lower it). */
  visibility: number;
  /** Squad has its own combat vehicle with it, tall buildings at the flag, enemy supply / static nodes near. */
  vehicle: boolean; tall: boolean; enemyAssets: boolean;
}

/** Utility of each rearguard option from the five continuous variables (the Q1–Q6 gate then walks them). */
export function rearguardScores(v: RearguardVars, out: Float32Array): Float32Array {
  const gar = v.garrisonEta === Infinity ? 1 : Math.min(1, v.garrisonEta / 120);
  out[Rearguard.BLITZ] = 0.55 * (1 - v.burden) + 0.25 * (1 - v.exposure) + 0.2 * (1 - gar) * 0.5 + 0.15 * v.retreat;
  out[Rearguard.ROOFTOP] = v.tall ? 0.35 + 0.3 * v.exposure + 0.25 * v.visibility + 0.1 * gar : 0;
  out[Rearguard.GARRISON] = 0.3 + 0.4 * v.burden + 0.3 * gar * v.exposure;
  out[Rearguard.EMPTY_AMBUSH] = 0.2 + 0.45 * v.retreat * v.exposure + 0.25 * (1 - v.visibility);
  out[Rearguard.ARMOR_SPLIT] = v.vehicle ? 0.35 + 0.35 * v.exposure + 0.2 * v.visibility : 0;
  out[Rearguard.SABOTAGE] = v.enemyAssets ? 0.3 + 0.3 * (1 - v.visibility) + 0.25 * (1 - v.burden) : 0;
  return out;
}

// ---------------------------------------------------------------- close-quarters battle

/** Alley / doorway clearance below which a squad's open-ground spacing gives way to stacked entry pairs (m). */
export const CQB_CLEARANCE = 18;
/**
 * Whether a squad's neighbourhood calls for CQB: dense building footprint (urban density), multi-storey interiors
 * or ruins at hand, or wall clearance under 18 m. @returns 0..1 how strongly
 */
export function cqbFactor(density: number, storeys: number, ruins: boolean, clearance: number): number {
  const tight = clearance < CQB_CLEARANCE ? 1 - clearance / CQB_CLEARANCE : 0;
  // Built-up first: tight walls only count where there is a real built-up mass (a lone barracks block is not CQB).
  const built = density * 0.9 + (storeys >= 3 ? 0.3 : storeys >= 2 ? 0.1 : 0) + (ruins ? 0.2 : 0);
  return Math.max(0, Math.min(1, built + (built > 0.2 ? tight * 0.35 : 0)));
}

// ---------------------------------------------------------------- garrison denial / fortification mask

/**
 * Scorched earth: a garrison that is withdrawing outnumbered weighs denying the enemy what it leaves behind.
 * @returns Q1–Q5 answers
 */
export function scorchedAnswers(withdrawing: boolean, ratio: number, assets: number, demolishers: number, out: Float32Array): Float32Array {
  out[0] = withdrawing ? 1 : 0;
  out[1] = ratio >= 3 ? 1 : ratio >= 2 ? 0.45 : 0;
  out[2] = assets > 0 ? Math.min(1, 0.5 + assets * 0.1) : 0;
  out[3] = 1;
  out[4] = demolishers > 0 ? 1 : 0;
  return out;
}
