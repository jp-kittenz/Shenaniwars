/**
 * Four-question purpose gate: one arbiter for soldiers, squads and the theater commander.
 *
 *   Q1 Why?                     grounded in a threat the squad remembers, an observation, or the current order
 *   Q2 Is it necessary?         not redundant, and not breaking a commitment (a move in progress, a capture inside
 *                               the 180 m assault ring)
 *   Q3 Does it benefit us?      risk vs. the defenders the squad believes are there (including ones it lost sight of)
 *   Q4 What does it do for us?  a concrete gain: cover that protects, a line of fire, entering the flag
 *
 * Callers fill a pre-allocated GateContext, call evaluatePurposeGate(ctx, candidate, out) and read out.ok /
 * out.question / out.alt. Nothing is allocated per call.
 */

/** What is being decided. */
export const GateCandidate = {
  /** A soldier would switch from moving (advance / bound / flank) to a stopping action (cover, engage, suppress…). */
  SOLDIER_STOP: 0,
  /** A squad would be re-tasked away from its capture objective (new order, objective, operation, airlift). */
  SQUAD_RETASK: 1,
  /** A squad stalled near a flag would launch a final assault into the capture circle. */
  FINAL_ASSAULT: 2,
  /** A dismounted squad would mount a nearby friendly transport again for its next move. */
  REBOARD_TRANSPORT: 3,
} as const;

/** Alternative the gate recommends when it rejects. */
export const GateAlt = { NONE: 0, KEEP_MOVING: 1, SUPPRESS_AND_BOUND: 2, HOLD_AND_CALL: 3, KEEP_TASK: 4 } as const;

export class GateContext {
  time = 0;
  // Soldier
  /** Movement action in progress and when it began. */
  moving = false; moveStart = 0;
  /** Seconds of minimum commitment for a move (1.5–2 by temperament). */
  lockS = 1.75;
  /** Acute lethal danger: an explosion nearby, a hit from point blank, a grenade. */
  acute = false;
  suppression = 0;
  /** Squad is committed to taking a flag (rushing, final assault, capturing) and the soldier is close to it. */
  committed = false;
  /** Protection the candidate's cover would give (0..1; < 0 none). */
  coverGain = 0;
  /** Distance to the visible / remembered target. */
  targetDist = 1e9;
  /** A line of fire exists from here. */
  lineOfFire = true;
  /** Candidate is a stop to engage (as opposed to take cover). */
  engage = false;
  // Squad
  /** Squad's distance to its capture objective and whether that objective is still to be taken. */
  objDist = 1e9; capturing = false;
  /** Fraction of the squad still alive (0..1). */
  strength = 1;
  /** The new task is an explicit retreat / withdrawal. */
  retreat = false;
  /** The new task targets the same flag (e.g. moving from support to assault on it). */
  sameObjective = false;
  /** Own soldiers on foot and the defenders the squad believes are at the flag (threat memory + intel floor). */
  own = 0; perceived = 0;
  // Re-boarding
  /** Distance to the squad's next objective, to the candidate carrier, and whether it is intact with room. */
  nextDist = 0; carrierDist = 1e9; carrierOk = false;
  /** In a close fight: contact in the last seconds, or suppressed. */
  pinned = false;
  /** The way there favours going on foot (no drivable route, or a stealthy approach). */
  footFavoured = false;
}

export class GateResult {
  ok = true;
  /** Which question rejected (1–4), 0 when allowed. */
  question = 0;
  alt: number = GateAlt.NONE;
}

/** Inside this ring an attacking squad's capture assignment is locked. */
export const ASSAULT_RING = 180;

export const gateStats = { reboardAsked: 0, reboardOk: 0, asked: 0, rejected: [0, 0, 0, 0, 0], stopRejected: 0, retaskRejected: 0, assaultRejected: 0 };

function reject(out: GateResult, q: number, alt: number): GateResult {
  out.ok = false; out.question = q; out.alt = alt;
  gateStats.rejected[q]++;
  return out;
}

export function evaluatePurposeGate(ctx: GateContext, candidate: number, out: GateResult): GateResult {
  gateStats.asked++;
  out.ok = true; out.question = 0; out.alt = GateAlt.NONE;
  switch (candidate) {
    case GateCandidate.SOLDIER_STOP: {
      // Acute lethal danger always overrides (Q1 answered by the danger itself).
      if (ctx.acute || ctx.suppression > 0.8) return out;
      // Q2: a move in progress is held for its minimum commitment.
      if (ctx.moving && ctx.time - ctx.moveStart < ctx.lockS) { gateStats.stopRejected++; return reject(out, 2, GateAlt.KEEP_MOVING); }
      // Q4: stopping to engage needs a line of fire from here.
      if (ctx.engage && !ctx.lineOfFire) { gateStats.stopRejected++; return reject(out, 4, GateAlt.KEEP_MOVING); }
      // Q3: committed to a capture, stopping only pays for real protection or a close threat; otherwise keep going
      // (marching fire covers the distant ones).
      if (ctx.committed && ctx.targetDist > 40 && ctx.suppression < 0.6 && (ctx.engage || ctx.coverGain < 0.45)) {
        gateStats.stopRejected++; return reject(out, 3, GateAlt.KEEP_MOVING);
      }
      return out;
    }
    case GateCandidate.SQUAD_RETASK: {
      // Q1: an explicit retreat is always grounded; so is a broken squad.
      if (ctx.retreat || ctx.strength < 0.25 || ctx.sameObjective) return out;
      // Q2: inside the assault ring on a flag still to be taken, the assignment is locked.
      if (ctx.capturing && ctx.objDist < ASSAULT_RING) { gateStats.retaskRejected++; return reject(out, 2, GateAlt.KEEP_TASK); }
      return out;
    }
    case GateCandidate.FINAL_ASSAULT: {
      // Q3: enough of us for the defenders we believe are there (those we lost sight of included)?
      if (ctx.own >= Math.max(2, ctx.perceived)) return out;
      // Q4: not enough for a rush, but enough to work forward: suppress with one team, bound with the other.
      gateStats.assaultRejected++;
      return reject(out, 3, ctx.own >= 3 && ctx.own * 2 >= ctx.perceived ? GateAlt.SUPPRESS_AND_BOUND : GateAlt.HOLD_AND_CALL);
    }
    case GateCandidate.REBOARD_TRANSPORT: {
      gateStats.reboardAsked++;
      // Q1 Why: the next fight is far (> 250 m); a close one (< 200 m) is walked to.
      if (ctx.nextDist < 250) return reject(out, 1, GateAlt.KEEP_TASK);
      // Q2 Necessary: not while pinned in close combat.
      if (ctx.pinned) return reject(out, 2, GateAlt.KEEP_TASK);
      // Q3 Benefit: an intact friendly carrier with room close by (<= 120 m).
      if (!ctx.carrierOk || ctx.carrierDist > 120) return reject(out, 3, GateAlt.KEEP_TASK);
      // Q4 Gain: the ride must actually get us there (a drivable route, not a stealthy foot approach).
      if (ctx.footFavoured) return reject(out, 4, GateAlt.KEEP_TASK);
      gateStats.reboardOk++;
      return out;
    }
  }
  return out;
}
