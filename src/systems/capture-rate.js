/**
 * Situational capture rate (Milestone 2, stage 3). Pure functions, so the rules are unit-tested on their own.
 *
 * Two phases: NEUTRALIZING strips the owner's control to neutral, SECURING builds the attacker's from neutral to
 * captured. While only one side is in the capture volume its progress runs at R_cap × the base rate, with
 *   R_cap = force (0.75 lone rifleman … 1.45 combined-arms assault)
 *         + frontline context (+0.40 flag inside an encircled pocket of the side losing it;
 *                              −0.45 deep in that side's secure territory — a rear-area breach / infiltration)
 *         + defences and supply while neutralizing (−0.10 per intact emplacement or supply source on the flag,
 *                                                   capped at −0.30; +0.10 when it has none: un-supplied)
 * clamped to 0.35 … 2.50.
 * Both sides present: progress pauses (CONTESTED) unless one side has at least 3:1 local combat power, which then
 * advances at a fixed 0.35× OVERRUN crawl (one hidden defender does not stall a company forever).
 */

export const CapPhase = { IDLE: 0, NEUTRALIZING: 1, SECURING: 2, CONTESTED: 3, OVERRUN: 4 };
export const CAP_PHASE_NAMES = ['', 'NEUTRALIZING', 'SECURING', 'CONTESTED', 'OVERRUN'];

/** Combat-power weights of what stands in a capture volume. */
export const CAP_POWER = { rifleman: 1, specialist: 1.3, player: 1.5, light: 1.5, medium: 2.5, heavy: 3 };

/** Force term: 0.75 for one rifleman, rising smoothly to 1.45 for a full combined-arms assault. */
export function forceTerm(power, hasVehicle) {
  const p = Math.max(0, power - 1) / 9;
  return Math.min(1.45, 0.75 + 0.6 * Math.min(1, p) + (hasVehicle && power > 1 ? 0.1 : 0));
}

/**
 * @param {number} power attacker's combat power in the volume
 * @param {boolean} hasVehicle a combat vehicle is part of it
 * @param {number} context +0.40 pocket, −0.45 deep in the other side's territory, 0 otherwise
 * @param {number} assets intact emplacements + supply sources of the side losing the flag (−1: not neutralizing)
 */
export function captureRate(power, hasVehicle, context, assets) {
  let r = forceTerm(power, hasVehicle) + context;
  if (assets >= 0) r += assets > 0 ? -0.1 * Math.min(3, assets) : 0.1;
  return Math.max(0.35, Math.min(2.5, r));
}

/**
 * Phase and signed progress direction for one capture tick.
 * @param {number} p0 power of team 0 in the volume @param {number} p1 power of team 1
 * @param {number} owner current owner (−1 neutral) @param {number} v control value (−1 team 0 … +1 team 1)
 * @returns {{phase:number, team:number}} team whose progress runs (−1 none)
 */
export function capturePhase(p0, p1, owner, v, out = { phase: 0, team: -1 }) {
  out.phase = CapPhase.IDLE; out.team = -1;
  if (p0 <= 0 && p1 <= 0) return out;
  let team;
  if (p0 > 0 && p1 > 0) {
    const hi = Math.max(p0, p1), lo = Math.min(p0, p1);
    if (hi < lo * 3) { out.phase = CapPhase.CONTESTED; return out; }
    team = p0 > p1 ? 0 : 1;
    out.phase = CapPhase.OVERRUN; out.team = team;
    return out;
  }
  team = p0 > 0 ? 0 : 1;
  const target = team === 0 ? -1 : 1;
  if (v === target) return out;
  out.team = team;
  // Against the other side's standing control: neutralize it first; from neutral (or regaining our own): secure.
  out.phase = v * target < 0 ? CapPhase.NEUTRALIZING : CapPhase.SECURING;
  return out;
}
