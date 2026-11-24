import { AgentStateBuffers } from './agent-state.ts';
import { TacticalRadioBus } from './radio-bus.ts';
import { SmokeField } from './smoke.ts';
import { SquadAndConvoyManager, SquadBlackboard, SquadKind } from './squad-convoy.ts';
import { CoverField, FoliageField } from './terrain-analysis.ts';
import { pickFiringPosition, terrainLos } from './positions.ts';
import { VehicleManifest, VehicleOrchestrator } from './vehicle-orchestrator.ts';
import type { VehicleTasking } from './vehicle-orchestrator.ts';
import { Archetype, Insert, INSERT_NAMES, Order, RadioType, clamp, hash01 } from './types.ts';
import type { FlagLike, GameLike, SoldierLike, VehicleLike } from './types.ts';

/**
 * Theater commander (one per side).
 *
 * Every think it reads the battlefield from what its troops actually know
 * (squad contact reports, contested flags, where its own soldiers die, which
 * enemy vehicles are killing them), forms a short list of priorities, and
 * then decides whether anything needs a *formal operation*. Most of the time
 * nothing does: garrisons sit where they are needed, threatened flags are
 * reinforced, and free squads take nearby objectives on their own initiative
 * within the commander's priorities. An operation is launched only when a
 * candidate clearly beats a threshold that rises with every operation already
 * running, and only for things routine behaviour would not achieve.
 *
 * An operation has a purpose, a medium and a method:
 *
 *  purpose  CAPTURE  establish control over an objective
 *           ATTACK   apply pressure toward an objective (wear a defence
 *                    down, besiege an exposed base's HQ)
 *           WEAKEN   reduce the enemy's ability to contest objectives (the
 *                    battery, armour or air defence that keeps killing us)
 *  medium   REMOTE (fires, CAS), ON_SITE (troops on the objective), MIXED
 *  method   DIRECT CAPTURE   small detachment straight onto a weak flag
 *           ASSAULT          stage at a friendly facility, move up to a
 *                            defiladed line of departure, prepare with fires
 *                            and smoke, attack on a main and a flanking axis
 *                            with support by fire and armour
 *           AIR ASSAULT      helicopter insertion (land / fast-rope / parachute)
 *           PRESSURE         fires and armour on a hard objective from range
 *           SIEGE            endgame: shell and assault an exposed base's HQ
 *           STRIKE           fire missions and CAS on a known enemy asset
 *           HUNT             armour and an AT team go after enemy armour
 *
 * Major operations assemble physically at a staging venue (a friendly base,
 * depot, outpost or town chosen for distance, capacity, safety and the
 * forces nearby). Units are taken organically: never from a fight, never from
 * another operation, never while recovering from a failed one. Vehicles are
 * committed only where they add something. Failed or cancelled operations
 * hand their units a short recovery at the venue; successful ones leave a
 * garrison. Failed assaults raise the objective's estimated hardness and put
 * it on cooldown, so the next plan bypasses it, pressures it from range, or
 * comes back with more force.
 */

/** Method: how an operation is carried out. */
export const OpType = { SECURE: 0, ASSAULT: 1, PRESSURE: 2, AIR_ASSAULT: 3, SIEGE: 4, STRIKE: 5, HUNT: 6 } as const;
export const OP_NAMES = ['DIRECT CAPTURE', 'ASSAULT', 'PRESSURE', 'AIR ASSAULT', 'SIEGE', 'STRIKE', 'HUNT'] as const;
/** Purpose: the outcome an operation is for. */
export const Purpose = { ATTACK: 0, WEAKEN: 1, CAPTURE: 2 } as const;
export const PURPOSE_NAMES = ['ATTACK', 'WEAKEN', 'CAPTURE'] as const;
/** Medium: how the effect reaches the target. */
export const Medium = { REMOTE: 0, ON_SITE: 1, MIXED: 2 } as const;
export const MEDIUM_NAMES = ['remote', 'on-site', 'mixed'] as const;
const METHOD_PURPOSE = [Purpose.CAPTURE, Purpose.CAPTURE, Purpose.ATTACK, Purpose.CAPTURE, Purpose.ATTACK, Purpose.WEAKEN, Purpose.WEAKEN];
export const OpPhase = { ASSEMBLE: 0, MOVE_UP: 1, PREP: 2, EXECUTE: 3, CONSOLIDATE: 4, DONE: 5, FAILED: 6, CANCELLED: 7 } as const;
export const PHASE_NAMES = ['assembling', 'moving up', 'prep fires', 'executing', 'consolidating', 'done', 'failed', 'cancelled'] as const;
/** Role of a squad inside an operation. */
export const Task = { MAIN: 0, FLANK: 1, SUPPORT: 2, AIR: 3 } as const;
/** Role of a vehicle inside an operation. */
export const VRole = { ARMOUR: 0, AIR_DEFENCE: 1, SUPPLY: 2 } as const;
const VROLE_NAMES = ['armour', 'air defence', 'supply'];

const MAX_OPS = 8;
const MAX_OP_SQUADS = 8;
/** Recovery after a failed / cancelled operation (regroup and resupply at the venue). */
const RECOVER_S = 18;
/** Combat weight of vehicles by archetype (infantry = 1). */
const VEH_W = new Float32Array([6, 7, 4, 3, 4, 0.5, 0.5, 1, 1, 1, 2, 5, 1, 3, 1, 1.5]);
const ARMOUR = new Uint8Array(16);
ARMOUR[Archetype.MBT] = 1; ARMOUR[Archetype.HT] = 1; ARMOUR[Archetype.LT] = 1; ARMOUR[Archetype.IFV] = 1;
/** Staging capacity of a facility by site kind (how many troops and vehicles it can organise). */
const VENUE_CAPACITY: Record<string, number> = {
  base: 3, 'depot-large': 2.6, 'depot-forest': 2, 'outpost-turrets': 2, 'outpost-river': 1.6, 'outpost-helipad': 2, 'outpost-runway': 2.2,
  'town-ruined': 1.6, 'town-intact': 1.8, 'town-farm': 1.4, village: 1.2, harbor: 1.6, 'harbor-cranes': 1.8,
};

export class Operation {
  id = 0; active = false; type = 0; phase = 0; flag = -1;
  purpose = 0; medium = 0; major = false;
  start = 0; phaseTime = 0;
  /** Staging venue (flag index of a friendly facility; -1 = field assembly area) and why it was chosen. */
  venue = -1; venueX = 0; venueZ = 0; venueWhy = '';
  /** Line of departure (assembly area in defilade) and the main axis (yaw from the objective toward it). */
  stageX = 0; stageZ = 0; mainYaw = 0;
  /** Attack positions: [0] main axis, [1] flanking axis. */
  readonly axisX = new Float32Array(2);
  readonly axisZ = new Float32Array(2);
  sbfX = 0; sbfZ = 0; hasSbf = false;
  readonly squads = new Int32Array(MAX_OP_SQUADS);
  readonly task = new Uint8Array(MAX_OP_SQUADS);
  nsq = 0;
  readonly vehicles = new Int32Array(6);
  readonly vrole = new Uint8Array(6);
  nveh = 0;
  required = 0; enemyAtStart = 0; strengthAtStart = 0; lossMark = 0;
  /** Enemy losses around the objective when the operation opened (PRESSURE: what our fires achieved). */
  killMark = 0;
  progressAt = 0; bestV = 0; minDist = 1e9;
  /** Mid-assault review done (once per stall). */
  midReviewed = false;
  prepUntil = 0; nextFireCall = 0; smoked = false;
  /** Seconds the assembly may take (grows while squads are still marching in, capped). */
  marchLimit = 0;
  heli = -1; airSquad = -1; dropX = 0; dropZ = 0; method = 0; airStart = -1; airDone = false;
  /** Target point (SIEGE: beside the targeted HQ; WEAKEN: the asset's last known position). */
  tx = 0; tz = 0; hq = -1;
  /** WEAKEN: target index (soldier / vehicle index space) and when it was last reported. */
  target = -1; targetSeen = 0;
  /** Readiness (present / required while assembling) and progress (0..1) for reporting. */
  readiness = 0; progressPct = 0;
  /** Squads that physically reached the staging venue. */
  staged = 0;
  /** Vehicle needs were evaluated (for reporting once). */
  vehNoted = false;
  /** Last time a free squad joined on its own. */
  volunteerAt = -1e3;
  /** Diagnosed cause when it failed ('' otherwise); age of the enemy estimate when it was planned (s). */
  cause = ''; intelAge = 0;
  /** Hard stop and the next re-justification check. */
  deadline = 0; reviewAt = 0;
  reason = '';
}
const _p2 = new Float32Array(2);
const _p3 = new Float32Array(2);
const AT_X = new Float32Array(16), AT_Z = new Float32Array(16);
const TAKEN_X = new Float32Array(32), TAKEN_Z = new Float32Array(32);

export class TheaterCommander implements VehicleTasking {
  readonly team: number;
  readonly enemy: number;
  readonly ops: Operation[] = [];
  /** Per flag: estimated enemy strength on it, enemy strength within 140 m, own strength within 60 m. */
  readonly enemyEst: Float32Array;
  readonly enemyNear: Float32Array;
  readonly friendly: Float32Array;
  /** Decaying own / enemy deaths within 110 m, and the resulting exchange-ratio "hardness". */
  readonly myLoss: Float32Array;
  readonly enemyLoss: Float32Array;
  readonly hardness: Float32Array;
  readonly lastSeen: Float32Array;
  readonly value: Float32Array;
  readonly cooldown: Float32Array;
  readonly attempts: Uint8Array;
  readonly adj: Uint8Array;
  readonly degree: Uint8Array;
  /** Recent decisions (newest last), for the debug overlay and reports. */
  readonly journal: string[] = [];
  /** Longer operation log (creation, venue, outcome, declined plans) for reports and evaluation. */
  readonly opLog: string[] = [];
  /** Current priorities, most important first (assessment output, shown in the debug overlay). */
  priorities: string[] = [];
  readonly stats = {
    planned: 0, succeeded: 0, failed: 0, cancelled: 0, declined: 0, airInsertions: 0, reinforcements: 0, staged: 0,
    vehiclesCommitted: 0, vehiclesNotNeeded: 0, retargeted: 0, byPurpose: [0, 0, 0],
    /** Major operations that formed up at their venue, and the total time it took. */
    formed: 0, formTime: 0,
    /** Garrisons sent back to work (front moved on), squads that joined an operation on their own. */
    garrisonsReleased: 0, volunteers: 0, withdrawals: 0, watchChanges: 0, firePosMoves: 0, midReviews: 0, midReinforced: 0, cancelledEarly: 0,
    /** Failure analysis: causes, and failures of execution vs failures of judgement. */
    failCauses: {} as Record<string, number>, executionFailures: 0, decisionFailures: 0,
  };
  private readonly game: GameLike;
  private readonly squads: SquadAndConvoyManager;
  private readonly orch: VehicleOrchestrator;
  private readonly radio: TacticalRadioBus;
  private readonly cover: CoverField;
  private readonly foliage: FoliageField;
  private readonly smoke: SmokeField;
  private readonly F: number;
  private readonly S: number;
  private readonly stamp: Uint32Array;
  private stampId = 0;
  private nextOpId = 1;
  private lastThink = 0;
  private readonly seen = new Float32Array(16);
  private readonly seenNear = new Float32Array(16);
  /** Vehicle → operation id (-1 none); cached firing positions. */
  private readonly vehOp: Int32Array;
  private readonly fireX: Float32Array;
  private readonly fireZ: Float32Array;
  private readonly fireAt: Float32Array;
  /** Per vehicle: health when its firing position was chosen, flag it watches on its own, last reason its task changed. */
  private readonly fireHp: Float32Array;
  private readonly watchFlag: Int32Array;
  readonly vehWhy: string[];
  private readonly fireFlag: Int32Array;
  /** Enemy vehicles that killed our soldiers recently (decaying), and where they were last reported. */
  private readonly killsBy: Float32Array;
  /** Ticket history (one sample per 30 s) for the trend. */
  private readonly ticketHist: number[][] = [];
  private ticketT = 0;
  private declineT = 0;
  private prioT = -1e3;
  private lastAirSeen = -1e3;
  /** Flag owners at the last think (to notice flags changing hands) and when we last reinforced each flag. */
  private readonly ownerSnap: Int8Array;
  private readonly reinfT: Float32Array;
  /** Per flag: no force could be found for it recently (do not re-plan it every second). */
  private readonly noForceUntil: Float32Array;
  /** Per flag: last time an operation was pressuring it (do not pressure it again straight away). */
  private readonly pressuredAt: Float32Array;
  /** Lessons per flag: approach axis to try (after route failures), no transport until (after transport failures), failed assemblies. */
  private readonly approach: Uint8Array;
  private readonly noLift: Float32Array;
  private readonly assemblyFails: Uint8Array;
  /** Situation from the last assessment. */
  readonly sit = { own: 0, theirs: 0, neutral: 0, trend: 0, threatened: 0, free: 0, behind: false, stalemate: false, lastFlip: 0 };
  /** Bar a candidate operation must clear (rises with every operation running) and the last decision taken. */
  threshold = 1;
  lastDecision = 'not assessed yet';
  /** Callback for decisions (game event bus). */
  emit: ((team: number, text: string) => void) | null = null;

  constructor(game: GameLike, team: number, st: AgentStateBuffers, squads: SquadAndConvoyManager, orch: VehicleOrchestrator,
    radio: TacticalRadioBus, cover: CoverField, foliage: FoliageField, smoke: SmokeField) {
    this.game = game; this.team = team; this.enemy = 1 - team; this.squads = squads; this.orch = orch;
    void st;
    this.radio = radio; this.cover = cover; this.foliage = foliage; this.smoke = smoke;
    const F = (this.F = game.capture.flags.length);
    this.S = game.soldiers.length;
    this.enemyEst = new Float32Array(F); this.enemyNear = new Float32Array(F); this.friendly = new Float32Array(F);
    this.myLoss = new Float32Array(F); this.enemyLoss = new Float32Array(F); this.hardness = new Float32Array(F).fill(1);
    this.lastSeen = new Float32Array(F).fill(-1e3); this.value = new Float32Array(F); this.cooldown = new Float32Array(F);
    this.attempts = new Uint8Array(F);
    this.adj = new Uint8Array(F * F); this.degree = new Uint8Array(F);
    for (const [a, b] of game.map.roads) { this.adj[a * F + b] = this.adj[b * F + a] = 1; this.degree[a]++; this.degree[b]++; }
    this.stamp = new Uint32Array(this.S + game.vehicles.list.length);
    const V = game.vehicles.list.length;
    this.vehOp = new Int32Array(V).fill(-1);
    this.fireX = new Float32Array(V); this.fireZ = new Float32Array(V); this.fireAt = new Float32Array(V).fill(-1e3);
    this.fireFlag = new Int32Array(V).fill(-1);
    this.fireHp = new Float32Array(V); this.watchFlag = new Int32Array(V).fill(-1); this.vehWhy = new Array(V).fill('');
    this.killsBy = new Float32Array(V);
    this.ownerSnap = new Int8Array(F); this.reinfT = new Float32Array(F).fill(-1e3); this.noForceUntil = new Float32Array(F); this.pressuredAt = new Float32Array(F).fill(-1e3);
    this.approach = new Uint8Array(F); this.noLift = new Float32Array(F); this.assemblyFails = new Uint8Array(F);
    for (let f = 0; f < F; f++) this.ownerSnap[f] = game.capture.flags[f].owner;
    for (let i = 0; i < MAX_OPS; i++) this.ops.push(new Operation());
  }

  reset(): void {
    for (const op of this.ops) if (op.active) this.close(op, OpPhase.DONE, '');
    this.enemyEst.fill(0); this.enemyNear.fill(0); this.myLoss.fill(0); this.enemyLoss.fill(0); this.hardness.fill(1);
    this.cooldown.fill(0); this.attempts.fill(0); this.vehOp.fill(-1); this.fireAt.fill(-1e3); this.killsBy.fill(0);
    this.journal.length = 0; this.opLog.length = 0; this.ticketHist.length = 0; this.priorities = [];
    this.sit.lastFlip = 0; this.prioT = -1e3; this.lastAirSeen = -1e3; this.reinfT.fill(-1e3); this.noForceUntil.fill(0); this.pressuredAt.fill(-1e3); this.approach.fill(0); this.noLift.fill(0); this.assemblyFails.fill(0);
    for (let f = 0; f < this.F; f++) this.ownerSnap[f] = this.game.capture.flags[f].owner;
  }

  /** Operation log entry (kept longer than the journal). */
  private log(text: string): void {
    this.opLog.push(`${this.game.time.toFixed(0)}s ${text}`);
    if (this.opLog.length > 80) this.opLog.shift();
  }

  private note(text: string): void {
    this.journal.push(`${this.game.time.toFixed(0)}s ${text}`);
    if (this.journal.length > 12) this.journal.shift();
    this.log(text);
    if (this.emit) this.emit(this.team, text);
  }

  /** A soldier died: record where (attrition around each flag) and which enemy vehicle did it. */
  onKill(victim: SoldierLike, attacker: SoldierLike | null = null): void {
    const flags = this.game.capture.flags;
    for (let f = 0; f < this.F; f++) {
      const d = Math.hypot(flags[f].x - victim.pos.x, flags[f].z - victim.pos.z);
      if (d > 110) continue;
      if (victim.team === this.team) this.myLoss[f] += 1; else this.enemyLoss[f] += 1;
    }
    if (victim.team === this.team && attacker && attacker.team === this.enemy && attacker.vehicle) this.killsBy[attacker.vehicle.id] += 1;
  }

  // ================================================================= thinking (≈1 Hz)

  think(time: number): void {
    const dt = Math.min(5, Math.max(0.1, time - this.lastThink));
    this.lastThink = time;
    this.readBattlefield(time, dt);
    this.assess(time, dt);
    this.updateOps(time);
    this.reinforce(time);
    this.decide(time);
    this.planAir(time);
    this.standingFires(time);
    this.issueOrders(time);
  }

  /**
   * Standing fire tasking for the batteries: shell verified enemy flag garrisons and armour clusters on our own
   * initiative, not only when an operation or a squad calls for it. A target needs an observation confidence of at
   * least 0.55 (fresh reports) and no friendly soldier within 85 m of it.
   */
  private nextStanding = 0;
  readonly fireStats = { garrison: 0, armour: 0 };
  private standingFires(time: number): void {
    if (time < this.nextStanding) return;
    this.nextStanding = time + 14;
    const flags = this.game.capture.flags, soldiers = this.game.soldiers, list = this.game.vehicles.list;
    const friendlyWithin = (x: number, z: number, r: number): boolean => {
      for (const s of soldiers) if (s.alive && s.team === this.team && (s.pos.x - x) ** 2 + (s.pos.z - z) ** 2 < r * r) return true;
      return false;
    };
    let calls = 0;
    // 1) Enemy flag garrisons we have eyes on.
    let bf = -1, bs = 0;
    for (let f = 0; f < this.F; f++) {
      const fl = flags[f];
      if (fl.base || fl.owner === this.team) continue;
      const conf = 1 - (time - this.lastSeen[f]) / 45;
      if (conf < 0.55 || this.enemyEst[f] < 2) continue;
      const sc = this.enemyEst[f] * conf * (fl.owner === this.enemy ? 1.3 : 1);
      if (sc > bs && !friendlyWithin(fl.x, fl.z, 85)) { bs = sc; bf = f; }
    }
    if (bf >= 0) {
      const fl = flags[bf];
      this.radio.publish(RadioType.FIRE_MISSION, this.team, -1, -1, fl.x, fl.y, fl.z, -1, 2, time, 0, false);
      this.fireStats.garrison++; calls++;
    }
    // 2) Armour clusters: a heavy hull, or two enemy vehicles within 60 m of each other, reported recently.
    let bx = 0, bz = 0, best = 0, bt = -1;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.alive || !v.occupied || v.team !== this.enemy || v.isAircraft) continue;
      const age = this.lastReport(this.S + i, _p2);
      if (1 - age / 30 < 0.55) continue;
      const x = _p2[0], z = _p2[1];
      let w = v.def.armor === 'heavy' ? 2 : 1;
      for (let j = 0; j < list.length; j++) {
        const o = list[j];
        if (j !== i && o.alive && o.occupied && o.team === this.enemy && !o.isAircraft && (o.pos.x - x) ** 2 + (o.pos.z - z) ** 2 < 60 * 60) w++;
      }
      if (w >= 2 && w > best && !friendlyWithin(x, z, 85)) { best = w; bx = x; bz = z; bt = this.S + i; }
    }
    if (bt >= 0 && calls < 2) {
      this.radio.publish(RadioType.FIRE_MISSION, this.team, -1, -1, bx, this.game.map.terrain.height(bx, bz), bz, bt, 2, time, 0, false);
      this.fireStats.armour++;
    }
  }

  private flagName(f: number): string { return this.game.capture.flags[f].name; }

  /** Intel picture from contact reports (not omniscient), public flag state and attrition. */
  private readBattlefield(time: number, dt: number): void {
    const g = this.game, flags = g.capture.flags, F = this.F, S = this.S;
    // Estimates fade when nobody is looking, slowly for flags the enemy holds (garrisons rarely vanish).
    const dEst = Math.exp(-dt / 90), dEstHeld = Math.exp(-dt / 300), dLoss = Math.exp(-dt / 150);
    const seen = this.seen, seenNear = this.seenNear;
    seen.fill(0); seenNear.fill(0);
    this.friendly.fill(0);
    // Own strength: exact.
    for (let i = 0; i < S; i++) {
      const s = g.soldiers[i];
      if (!s.alive || s.team !== this.team || (s.vehicle && s.vehicle.isAircraft)) continue;
      for (let f = 0; f < F; f++) if ((flags[f].x - s.pos.x) ** 2 + (flags[f].z - s.pos.z) ** 2 < 60 * 60) this.friendly[f] += 1;
    }
    const list = g.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.alive || !v.occupied || v.team !== this.team || v.isAircraft) continue;
      const w = VEH_W[this.orch.manifests[i].archetype];
      for (let f = 0; f < F; f++) if ((flags[f].x - v.pos.x) ** 2 + (flags[f].z - v.pos.z) ** 2 < 80 * 80) this.friendly[f] += w;
    }
    // Enemy: only what our squads have reported recently (each contact counted once).
    this.stampId++;
    const sq = this.squads.squads;
    for (let qi = 0; qi < sq.length; qi++) {
      const q = sq[qi];
      if (q.team !== this.team) continue;
      for (let k = 0; k < q.cTarget.length; k++) {
        const t = q.cTarget[k];
        if (t < 0 || time - q.cT[k] > 15 || this.stamp[t] === this.stampId) continue;
        this.stamp[t] = this.stampId;
        let w = 1;
        if (t >= S) {
          const v = list[t - S];
          if (!v.alive || !v.occupied) continue;
          w = VEH_W[this.orch.manifests[t - S].archetype];
          if (v.isAircraft) this.lastAirSeen = time;
        }
        else if (!g.soldiers[t].alive) continue;
        const x = q.cX[k], z = q.cZ[k];
        for (let f = 0; f < F; f++) {
          const d2 = (flags[f].x - x) ** 2 + (flags[f].z - z) ** 2;
          if (d2 < 75 * 75) { seen[f] += w; this.lastSeen[f] = time; }
          if (d2 < 140 * 140) seenNear[f] += w;
        }
      }
    }
    for (let f = 0; f < F; f++) {
      const fl = flags[f];
      this.enemyEst[f] = Math.max(this.enemyEst[f] * (fl.owner === this.enemy ? dEstHeld : dEst), seen[f]);
      this.enemyNear[f] = Math.max(this.enemyNear[f] * Math.exp(-dt / 40), seenNear[f]);
      this.squads.flagEst[this.team][f] = this.enemyEst[f];
      // Public information: a contested flag means more of them than of us inside the circle.
      if (fl.contestedBy === this.enemy) {
        const floor = fl.count[this.team] + 1;
        if (this.enemyEst[f] < floor) this.enemyEst[f] = floor;
        if (this.enemyNear[f] < floor) this.enemyNear[f] = floor;
      }
      // We are inside their circle and the flag does not move our way: at least as many of them as of us in there.
      if (fl.owner !== this.team && fl.count[this.team] > 0 && fl.contestedBy !== this.team) {
        const floor = fl.count[this.team] + 1;
        if (this.enemyEst[f] < floor) this.enemyEst[f] = floor;
      }
      // Enemy flag we have not looked at for a while: assume a token garrison.
      if (fl.owner === this.enemy && time - this.lastSeen[f] > 45 && this.enemyEst[f] < 2.5) this.enemyEst[f] = 2.5;
      this.myLoss[f] *= dLoss; this.enemyLoss[f] *= dLoss;
      this.hardness[f] = clamp((this.myLoss[f] + 2) / (this.enemyLoss[f] + 2), 0.6, 3.5);
      // Value: every flag counts for the ticket bleed; links and front-line position add to it.
      let v = 1 + 0.12 * this.degree[f];
      let front = false;
      for (let o = 0; o < F; o++) if (this.adj[f * F + o] && flags[o].owner !== fl.owner) { front = true; break; }
      if (front) v += 0.3;
      if (fl.base) v *= fl.owner === this.team ? 1.6 : 0.55;
      this.value[f] = v;
    }
  }

  private ownedCount(team: number): number {
    let n = 0;
    for (const f of this.game.capture.flags) if (f.owner === team && !f.base) n++;
    return n;
  }

  /** Endgame: the enemy holds no objective and its base buildings can be destroyed. */
  private enemyExposed(): boolean {
    const ph = this.game.capture.phase;
    return !!ph && ph[this.enemy] === 'siege';
  }

  /** Our own base is exposed. */
  private ownExposed(): boolean {
    const ph = this.game.capture.phase;
    return !!ph && ph[this.team] === 'siege';
  }

  private baseFlag(team: number): number {
    const b = this.game.map.bases;
    return b && b[team] ? b[team].flag : -1;
  }

  /** Picks the standing enemy HQ nearest to the operation's assembly area; false when none is left. */
  private siegeTarget(op: Operation): boolean {
    const map = this.game.map as any, base = map.bases ? map.bases[this.enemy] : null;
    if (!base) return false;
    let best = -1, bd = 1e12;
    for (const id of base.hq) {
      const b = map.buildings[id];
      if (b.state >= 2) continue;
      // Stay with the current target until it falls (no target hopping).
      if (id === op.hq) { best = id; break; }
      const d = (b.x - op.stageX) ** 2 + (b.z - op.stageZ) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    if (best < 0) return false;
    const b = map.buildings[best];
    op.hq = best;
    // Aim point: in front of the HQ wall facing the assembly area.
    const yaw = Math.atan2(op.stageX - b.x, op.stageZ - b.z), off = Math.max(b.w, b.d) / 2 + 4;
    op.tx = b.x + Math.sin(yaw) * off; op.tz = b.z + Math.cos(yaw) * off;
    return true;
  }

  // ================================================================= operations

  private allocOp(): Operation | null {
    for (const op of this.ops) if (!op.active) return op;
    return null;
  }

  private opOnFlag(f: number): Operation | null {
    for (const op of this.ops) if (op.active && op.flag === f && op.type !== OpType.AIR_ASSAULT) return op;
    return null;
  }

  private activeOps(): number {
    let n = 0;
    for (const op of this.ops) if (op.active) n++;
    return n;
  }

  private squadById(id: number): SquadBlackboard { return this.squads.squads[id]; }

  private opStrength(op: Operation): number {
    let n = 0;
    for (let i = 0; i < op.nsq; i++) n += this.squadById(op.squads[i]).alive;
    for (let i = 0; i < op.nveh; i++) {
      const v = this.game.vehicles.list[op.vehicles[i]];
      if (v.alive && v.occupied && v.team === this.team) n += VEH_W[this.orch.manifests[v.id].archetype];
    }
    return n;
  }

  /** Free infantry squads: not in an operation and not garrisoning. */
  private isFree(q: SquadBlackboard): boolean {
    return q.team === this.team && q.kind === SquadKind.INFANTRY && q.opId < 0 && q.garrison < 0 && q.alive >= 2 && q.order !== Order.AIRLIFT;
  }

  private freeStrength(): number {
    let n = 0;
    for (const q of this.squads.squads) if (this.isFree(q)) n += q.alive;
    return n;
  }

  private open(type: number, f: number, required: number, reason: string, time: number, medium = -1): Operation | null {
    const op = this.allocOp();
    if (!op) return null;
    op.active = true; op.id = this.nextOpId++; op.type = type; op.flag = f; op.start = time; op.phaseTime = time;
    op.nsq = 0; op.nveh = 0; op.required = required; op.enemyAtStart = this.enemyEst[f];
    op.lossMark = this.myLoss[f]; op.killMark = this.enemyLoss[f]; op.progressAt = time; op.bestV = this.progress(f); op.minDist = 1e9;
    op.prepUntil = 0; op.nextFireCall = 0; op.smoked = false; op.marchLimit = 0;
    op.heli = -1; op.airSquad = -1; op.airStart = -1; op.airDone = false; op.hasSbf = false; op.hq = -1;
    op.target = -1; op.targetSeen = time; op.readiness = 0; op.progressPct = 0; op.staged = 0;
    op.venue = -1; op.venueWhy = ''; op.vehNoted = false; op.volunteerAt = -1e3; op.cause = ''; op.intelAge = time - this.lastSeen[f];
    op.reason = reason;
    op.purpose = METHOD_PURPOSE[type];
    op.medium = medium >= 0 ? medium : type === OpType.STRIKE ? Medium.REMOTE : type === OpType.PRESSURE ? Medium.MIXED
      : type === OpType.ASSAULT || type === OpType.SIEGE ? (this.fireSupport() ? Medium.MIXED : Medium.ON_SITE) : Medium.ON_SITE;
    op.major = type === OpType.ASSAULT || type === OpType.SIEGE;
    op.deadline = time + (type === OpType.PRESSURE ? 150 : type === OpType.STRIKE ? 120 : type === OpType.HUNT ? 200 : type === OpType.SECURE ? 360 : 600);
    op.reviewAt = time + 30;
    op.phase = op.major ? OpPhase.ASSEMBLE : OpPhase.EXECUTE;
    const fl = this.game.capture.flags[f];
    op.tx = fl.x; op.tz = fl.z;
    if (type === OpType.ASSAULT || type === OpType.SECURE || type === OpType.SIEGE) this.planGeometry(op);
    if (type === OpType.SIEGE) this.siegeTarget(op);
    if (op.major) this.pickVenue(op, time);
    this.stats.planned++;
    this.stats.byPurpose[op.purpose]++;
    this.note(`${PURPOSE_NAMES[op.purpose]} ${this.flagName(f)} by ${OP_NAMES[type]} (${MEDIUM_NAMES[op.medium]}, ${op.major ? 'major' : 'local'}): ${reason}` +
      (op.major ? `; staging at ${op.venueWhy}` : ''));
    return op;
  }

  /**
   * Ends an operation. Squads of a failed or cancelled one regroup at the
   * venue (or the nearest friendly flag) for a while and are not sent straight
   * back at the same target; vehicles return to routine duties.
   */
  private close(op: Operation, phase: number, why: string): void {
    op.phase = phase;
    const time = this.game.time, flags = this.game.capture.flags;
    const recover = phase === OpPhase.FAILED || phase === OpPhase.CANCELLED;
    if (op.heli >= 0 && !op.airDone && op.airSquad >= 0) this.orch.cancelInsertion(op.heli, op.airSquad);
    for (let i = 0; i < op.nsq; i++) {
      const q = this.squadById(op.squads[i]);
      if (q.opId !== op.id) continue;
      q.opId = -1; q.order = Order.NONE; q.stagedFor = -1;
      if (!recover || q.alive === 0) continue;
      q.recoverUntil = time + RECOVER_S; q.lastOpTarget = op.flag; q.lastOpEnd = time;
      if (op.venue >= 0 && flags[op.venue].owner === this.team) { q.recoverX = op.venueX; q.recoverZ = op.venueZ; }
      else {
        let bd = 1e12; q.recoverX = q.cx; q.recoverZ = q.cz;
        for (const fl of flags) { if (fl.owner !== this.team) continue; const d = (fl.x - q.cx) ** 2 + (fl.z - q.cz) ** 2; if (d < bd) { bd = d; q.recoverX = fl.x; q.recoverZ = fl.z; } }
      }
    }
    for (let i = 0; i < op.nveh; i++) if (this.vehOp[op.vehicles[i]] === op.id) this.vehOp[op.vehicles[i]] = -1;
    op.active = false;
    if (phase === OpPhase.FAILED) this.stats.failed++;
    else if (phase === OpPhase.CANCELLED) this.stats.cancelled++;
    else if (why) this.stats.succeeded++;
    if (why) this.note(`${PURPOSE_NAMES[op.purpose]} ${this.flagName(op.flag)} (${OP_NAMES[op.type]}) ${PHASE_NAMES[phase].toUpperCase()}: ${why}`);
  }

  private addSquad(op: Operation, q: SquadBlackboard, task: number): boolean {
    if (op.nsq >= MAX_OP_SQUADS) return false;
    op.squads[op.nsq] = q.id; op.task[op.nsq] = task; op.nsq++;
    q.opId = op.id; q.garrison = -1; q.axisDone = task === Task.SUPPORT || task === Task.AIR;
    q.noLiftUntil = this.noLift[op.flag];
    return true;
  }

  /** Our progress on a flag (−1 enemy, +1 ours). */
  private progress(f: number): number {
    const v = this.game.capture.flags[f].v;
    return this.team === 0 ? -v : v;
  }

  /** Assembly area in defilade on our side, the main / flanking attack positions and a support-by-fire position. */
  private planGeometry(op: Operation): void {
    const g = this.game, t = g.map.terrain, flags = g.capture.flags, fl = flags[op.flag];
    // Our side: toward our nearest owned flag (else our base).
    let home: FlagLike | null = null, hd = 1e12;
    for (const f of flags) {
      if (f.owner !== this.team || f === fl) continue;
      const d = (f.x - fl.x) ** 2 + (f.z - fl.z) ** 2;
      if (d < hd) { hd = d; home = f; }
    }
    // After a failure to get through, the next plan swings the approach round (±0.8 rad, then the far side).
    const shift = [0, 0.8, -0.8, 1.6][this.approach[op.flag]];
    const baseYaw = (home ? Math.atan2(home.x - fl.x, home.z - fl.z) : Math.atan2(-fl.x, -fl.z) + (this.team === 0 ? 0 : Math.PI)) + shift;
    const oy = t.height(fl.x, fl.z) + 1.6;
    let best = -1e9;
    const dist = op.type === OpType.SECURE ? 120 : 165;
    for (let a = -2; a <= 2; a++) {
      for (let r = 0; r < 2; r++) {
        const yaw = baseYaw + a * 0.42, d = dist + r * 35;
        const x = fl.x + Math.sin(yaw) * d, z = fl.z + Math.cos(yaw) * d;
        if (!t.inBounds(x, z, 30) || g.nav.blocked(x, z)) continue;
        let s = -Math.abs(a) * 0.15;
        if (!terrainLos(t, this.foliage, fl.x, oy, fl.z, x, t.height(x, z) + 1.6, z)) s += 1.5;    // defilade
        s += this.foliage.at(x, z) * 0.6;
        s += Math.min(5, this.cover.grid.query(x, z, 25, IDS_SCRATCH)) * 0.06;
        if (home) s -= Math.hypot(home.x - x, home.z - z) * 0.002;
        if (s > best) { best = s; op.stageX = x; op.stageZ = z; op.mainYaw = yaw; }
      }
    }
    if (best === -1e9) { op.stageX = fl.x + Math.sin(baseYaw) * dist; op.stageZ = fl.z + Math.cos(baseYaw) * dist; op.mainYaw = baseYaw; }
    // Main attack position on the axis; flank on the side with more concealment and fewer known enemies.
    // Main attack position: on the axis, nudged until it is walkable ground.
    op.axisX[0] = fl.x + Math.sin(op.mainYaw) * 60; op.axisZ[0] = fl.z + Math.cos(op.mainYaw) * 60;
    for (let k = 0; k < 8 && (g.nav.blocked(op.axisX[0], op.axisZ[0]) || !t.inBounds(op.axisX[0], op.axisZ[0], 20)); k++) {
      const yaw = op.mainYaw + ((k & 1) ? 1 : -1) * 0.2 * ((k >> 1) + 1), d = 60 - (k >> 1) * 5;
      op.axisX[0] = fl.x + Math.sin(yaw) * d; op.axisZ[0] = fl.z + Math.cos(yaw) * d;
    }
    let bestSide = 1, bs = -1e9;
    for (let side = -1; side <= 1; side += 2) {
      const yaw = op.mainYaw + side * 1.15;
      const x = fl.x + Math.sin(yaw) * 65, z = fl.z + Math.cos(yaw) * 65;
      if (g.nav.blocked(x, z) || !t.inBounds(x, z, 30)) continue;
      const s = this.foliage.at(x, z) + Math.min(5, this.cover.grid.query(x, z, 20, IDS_SCRATCH)) * 0.08 + hash01(op.id, side + 2) * 0.1;
      if (s > bs) { bs = s; bestSide = side; }
    }
    const fy = op.mainYaw + bestSide * 1.15;
    op.axisX[1] = fl.x + Math.sin(fy) * 65; op.axisZ[1] = fl.z + Math.cos(fy) * 65;
    // Support by fire: 100–140 m out, line of sight onto the flag, on the far side of the main axis from the flank.
    op.hasSbf = false;
    for (let a = 0; a < 6 && !op.hasSbf; a++) {
      const yaw = op.mainYaw - bestSide * (0.35 + a * 0.12), d = 115 + (a % 2) * 20;
      const x = fl.x + Math.sin(yaw) * d, z = fl.z + Math.cos(yaw) * d;
      if (g.nav.blocked(x, z) || !t.inBounds(x, z, 30)) continue;
      if (terrainLos(t, this.foliage, x, t.height(x, z) + 1.2, z, fl.x, oy, fl.z)) { op.sbfX = x; op.sbfZ = z; op.hasSbf = true; }
    }
  }

  /** Is there fire support to prepare an objective with (artillery or attack aviation)? */
  private fireSupport(): boolean {
    const list = this.game.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i], a = this.orch.manifests[i].archetype;
      if (!v.alive || !v.occupied || v.team !== this.team) continue;
      if (a === Archetype.MLRS || a === Archetype.HOWITZER || a === Archetype.ATTACK_HELI || a === Archetype.STRIKE_JET) return true;
    }
    return false;
  }

  /**
   * Monitors every operation: assembly at the venue (readiness), moving up to
   * the line of departure, prep fires, execution, consolidation; periodic
   * re-justification; completion, adaptation, cancellation or failure.
   */
  private updateOps(time: number): void {
    const flags = this.game.capture.flags;
    for (const op of this.ops) {
      if (!op.active) continue;
      if (time > op.deadline) {
        if (op.purpose === Purpose.CAPTURE) this.close(op, OpPhase.FAILED, this.learn(op, time, `ran out of time after ${(time - op.start).toFixed(0)} s`));
        else this.close(op, OpPhase.DONE, `ran out of time after ${(time - op.start).toFixed(0)} s`);
        continue;
      }
      if (op.type === OpType.STRIKE || op.type === OpType.HUNT) { this.updateWeaken(op, time); continue; }
      if (op.type === OpType.PRESSURE) { this.updatePressure(op, time); continue; }
      const fl = flags[op.flag];
      if (time > op.reviewAt) { op.reviewAt = time + 30; if (this.review(op, time)) continue; }
      // Fill a deficit while forming up: free squads nearby, and (major operations) garrisons from safe rear flags.
      if (op.phase <= OpPhase.MOVE_UP && this.opStrength(op) < op.required) {
        if (op.major) this.releaseGarrisons(op, op.type === OpType.SIEGE ? 2 : 1);
        this.allocate(op, op.required, time);
      }
      const strength = this.opStrength(op);
      switch (op.phase) {
        case OpPhase.ASSEMBLE: {
          if (fl.owner === this.team && op.type !== OpType.SIEGE) { this.close(op, OpPhase.DONE, `${fl.name} already ours`); break; }
          if (op.type === OpType.SIEGE && (!this.enemyExposed() || !this.siegeTarget(op))) { this.siegeLifted(op, time); break; }
          // Physical assembly at the staging venue (or, with no friendly facility in reach, the field assembly area).
          const atVenue = op.venue >= 0;
          const gx = atVenue ? op.venueX : op.stageX, gz = atVenue ? op.venueZ : op.stageZ;
          const present = this.presentAt(op, gx, gz, atVenue ? 70 : 45);
          op.readiness = Math.min(1, present / Math.max(1, op.required));
          op.progressPct = 0.2 * op.readiness;
          const waited = time - op.phaseTime;
          // Allow for the march (≈ 4 m/s for the furthest squad, which can be a kilometre away on this island),
          // extended while reinforcements are still on their way, never beyond seven minutes.
          op.marchLimit = Math.max(op.marchLimit || 120 + this.marchTime(op, gx, gz), Math.min(waited + this.marchTime(op, gx, gz) + 40, 420));
          const limit = op.marchLimit;
          if (strength > 0 && (present >= strength * 0.7 && strength >= op.required * 0.8 ||
            (waited > limit * 0.6 && present >= strength * 0.45 && present >= op.required * 0.6))) {
            op.strengthAtStart = strength;
            if (atVenue) {
              let n = 0;
              for (let i = 0; i < op.nsq; i++) {
                const q = this.squadById(op.squads[i]);
                if (q.dismounted > 0 && (q.cx - gx) ** 2 + (q.cz - gz) ** 2 < 70 * 70) { q.stagedFor = op.id; n++; }
              }
              op.staged = n; this.stats.staged += n; this.stats.formed++; this.stats.formTime += waited;
              op.phase = OpPhase.MOVE_UP; op.phaseTime = time;
              this.note(`${fl.name}: force formed at ${this.flagName(op.venue)} (${strength.toFixed(0)} vs ~${this.enemyEst[op.flag].toFixed(0)}, ${n} squads staged), moving up to the line of departure`);
            } else this.beginAttack(op, time, strength);
          } else if (waited > limit) {
            const why = this.learn(op, time, `could not concentrate (${strength.toFixed(0)}/${op.required.toFixed(0)}, ${present.toFixed(0)} at the venue after ${waited.toFixed(0)} s)`);
            this.close(op, OpPhase.CANCELLED, why);
          }
          break;
        }
        case OpPhase.MOVE_UP: {
          if (fl.owner === this.team && op.type !== OpType.SIEGE) { this.close(op, OpPhase.DONE, `${fl.name} already ours`); break; }
          if (op.type === OpType.SIEGE && (!this.enemyExposed() || !this.siegeTarget(op))) { this.siegeLifted(op, time); break; }
          const present = this.presentAt(op, op.stageX, op.stageZ, 50);
          op.progressPct = 0.3;
          const limit = 90 + Math.hypot(op.venueX - op.stageX, op.venueZ - op.stageZ) / 3;
          if (present >= strength * 0.6 || time - op.phaseTime > limit) this.beginAttack(op, time, strength);
          break;
        }
        case OpPhase.PREP:
          if (op.type === OpType.SIEGE && (!this.enemyExposed() || !this.siegeTarget(op))) { this.siegeLifted(op, time); break; }
          op.progressPct = 0.4;
          this.callFires(op, time);
          if (time > op.prepUntil) this.execute(op, time);
          break;
        case OpPhase.EXECUTE: {
          if (op.type === OpType.SIEGE) { this.updateSiege(op, time, strength); break; }
          if (fl.owner === this.team) {
            op.phase = OpPhase.CONSOLIDATE; op.phaseTime = time;
            this.note(`${fl.name} taken; consolidating and digging in`);
            break;
          }
          // Keep the defenders under fire until our assault troops are close (danger-close checks protect them too).
          if (op.type === OpType.ASSAULT && this.closestSquad(op) > 75) this.callFires(op, time);
          // Progress: capture moving our way, owning the circle, or the assault force closing in.
          const p = this.progress(op.flag);
          op.progressPct = 0.5 + 0.45 * Math.max(0, p);
          if (p > op.bestV + 0.04 || fl.count[this.team] > fl.count[this.enemy]) { op.progressAt = time; op.bestV = Math.max(op.bestV, p); }
          // An air assault is judged from the moment its troops are on the ground.
          if (op.type === OpType.AIR_ASSAULT && !op.airDone) { op.progressAt = time; op.phaseTime = time; break; }
          const near = this.closestSquad(op);
          if (near < op.minDist - 8) { op.minDist = near; op.progressAt = time; op.midReviewed = false; }
          const lost = this.myLoss[op.flag] - op.lossMark;
          const stalled = time - op.progressAt;
          const inf = this.infantryStrength(op);
          // Mid-assault review after 40 s without progress: with enough force on hand it is not the plan that fails
          // but the push, so more fire and the nearest free squad go in; clearly outnumbered, pull back now
          // rather than wait out the stall and lose more.
          if (stalled > 40 && !op.midReviewed && op.type !== OpType.AIR_ASSAULT) {
            op.midReviewed = true;
            const est = this.enemyEst[op.flag];
            if (inf >= est * 1.3) {
              this.callFires(op, time);
              let best: SquadBlackboard | null = null, bd = 450 * 450;
              for (const q of this.squads.squads) {
                if (!this.isFree(q) || q.defensive || time < q.recoverUntil) continue;
                const d = (q.cx - op.tx) ** 2 + (q.cz - op.tz) ** 2;
                if (d < bd) { bd = d; best = q; }
              }
              if (best && this.addSquad(op, best, Task.MAIN)) { best.assignWhy = `sent to reinforce the stalled attack on ${fl.name}`; this.stats.midReinforced++; }
              this.stats.midReviews++;
              this.log(`${fl.name} (${OP_NAMES[op.type]}): no progress for ${stalled.toFixed(0)} s with ${inf.toFixed(0)} vs ~${est.toFixed(0)}: kept, more fire${best ? ' and another squad' : ''}`);
            } else if (inf < est * 0.8 && lost > 2) {
              this.stats.cancelledEarly++;
              const why = this.learn(op, time, `outnumbered after ${stalled.toFixed(0)} s without progress (${inf.toFixed(0)} vs ~${est.toFixed(0)}, lost ~${lost.toFixed(0)}): pulled back early`);
              this.close(op, OpPhase.CANCELLED, why);
              break;
            } else this.stats.midReviews++;
          }
          const engagedLong = near < 130 ? 80 : 150;
          if ((lost > Math.max(6, op.strengthAtStart * 0.7) && stalled > 40) || stalled > engagedLong ||
            (inf < 3 && time - op.phaseTime > 45)) {
            const why = this.learn(op, time, `stalled ${stalled.toFixed(0)} s, lost ~${lost.toFixed(0)}, closest squad ${near < 1e8 ? near.toFixed(0) + ' m' : 'none'} from the flag, defenders ~${this.enemyEst[op.flag].toFixed(0)} (planned for ~${op.enemyAtStart.toFixed(0)})`);
            this.close(op, OpPhase.FAILED, why);
          }
          break;
        }
        case OpPhase.CONSOLIDATE: {
          op.progressPct = 0.95;
          if (fl.owner !== this.team && fl.contestedBy === this.enemy) { op.phase = OpPhase.EXECUTE; op.phaseTime = time; op.progressAt = time; break; }
          if (time - op.phaseTime > (op.type === OpType.SECURE ? 12 : 25)) {
            // Leave the best-placed squad behind as the garrison.
            if (op.nsq > 0) { const q = this.squadById(op.squads[0]); q.opId = -1; q.garrison = op.flag; q.garrisonT = time; q.order = Order.NONE; }
            this.close(op, OpPhase.DONE, 'objective secured, garrison left');
          }
          break;
        }
      }
    }
  }

  /**
   * Failure analysis: what went wrong, from what the operation itself recorded, and what to change.
   * Execution failures (the plan was reasonable, carrying it out failed) change how we go about it next
   * time; decision failures (the objective was stronger than we judged) change whether and with what we
   * go. Uncertain cases say so and change little. One failure never escalates more than one step.
   *  - route: squads could not reach the venue / attack positions (navigation failures)  → new approach axis
   *  - transport: carriers were stuck or lost their passengers on the way                  → walk next time
   *  - assembly: too few units arrived in time, nothing was blocking them                   → plan nearer, wait for more free troops
   *  - reinforced: the defence grew well beyond the estimate during the operation          → short cooldown, no blame on the objective
   *  - force: losses heavy against a defence about as estimated (we underestimated it)     → more force next time (attempts)
   *  - held up: attackers never closed in, without nav failures or heavy losses            → uncertain; short cooldown only
   * @returns the outcome text with the diagnosis
   */
  private learn(op: Operation, time: number, facts: string): string {
    const f = op.flag, est = this.enemyEst[f], lost = this.myLoss[f] - op.lossMark;
    let navFails = 0, transportFails = 0;
    for (let i = 0; i < op.nsq; i++) {
      const q = this.squadById(op.squads[i]);
      if (q.navFailT > op.start) navFails++;
      if (q.transportFailT > op.start) transportFails++;
    }
    let cause: string, exec = true, adapt = '';
    if (navFails > 0 && navFails * 2 >= op.nsq) {
      cause = 'route'; this.approach[f] = (this.approach[f] + 1) % 4;
      adapt = 'next attempt comes from another direction';
      this.cooldown[f] = time + 45;
    } else if (transportFails > 0 && transportFails * 2 >= op.nsq) {
      cause = 'transport'; this.noLift[f] = time + 300;
      adapt = 'troops march next time';
      this.cooldown[f] = time + 45;
    } else if (op.phase === OpPhase.ASSEMBLE) {
      cause = 'assembly'; this.assemblyFails[f]++;
      adapt = this.assemblyFails[f] > 1 ? 'needs more free troops before trying again' : 'will wait for a better moment';
      this.cooldown[f] = time + 60;
    } else if (est > op.enemyAtStart * 1.5 + 2 && op.intelAge < 30) {
      cause = 'reinforced';
      adapt = 'the defence (seen when we planned) was reinforced during the attack; objective not marked harder';
      this.cooldown[f] = time + 60;
    } else if (est > op.enemyAtStart * 1.5 + 2) {
      // The estimate was a guess (nobody had looked at the flag for a while) and the defence turned out bigger.
      cause = 'underestimated'; exec = false;
      this.attempts[f]++;
      adapt = `planned on ${op.intelAge > 1e3 ? 'no' : (op.intelAge | 0) + ' s old'} intel; the estimate now stands at ~${est.toFixed(0)} and the next plan sizes for it`;
      this.cooldown[f] = time + 60;
    } else if (lost > Math.max(6, op.strengthAtStart * 0.6)) {
      cause = 'force'; exec = false;
      this.attempts[f]++;
      adapt = `objective rated harder (attempt ${this.attempts[f] + 1} needs more force)`;
      this.cooldown[f] = time + 50 + 35 * this.attempts[f];
    } else {
      cause = 'held up';
      adapt = 'cause unclear (no route failures, light losses): short pause, plan unchanged';
      this.cooldown[f] = time + 40;
    }
    this.stats.failCauses[cause] = (this.stats.failCauses[cause] || 0) + 1;
    if (exec) this.stats.executionFailures++; else this.stats.decisionFailures++;
    op.cause = cause;
    return `${facts}. Diagnosis: ${exec ? 'execution' : 'decision'} failure (${cause}): ${adapt}`;
  }

  /** A squad leaves an operation on its own initiative (reported, so the operation sees its strength drop). */
  private withdraw(op: Operation, q: SquadBlackboard, time: number, why: string): void {
    q.opId = -1; q.order = Order.NONE;
    const home = this.nearestOwned(q.cx, q.cz);
    q.recoverUntil = time + RECOVER_S; q.lastOpTarget = op.flag; q.lastOpEnd = time;
    if (home >= 0) { q.recoverX = this.game.capture.flags[home].x; q.recoverZ = this.game.capture.flags[home].z; } else { q.recoverX = q.cx; q.recoverZ = q.cz; }
    this.stats.withdrawals++;
    this.log(`${this.flagName(op.flag)} (${OP_NAMES[op.type]}): squad ${q.id} withdrew: ${why}`);
  }

  /** Into the attack from the line of departure: preparatory fires first when there is fire support. */
  private beginAttack(op: Operation, time: number, strength: number): void {
    op.strengthAtStart = Math.max(op.strengthAtStart, strength);
    if (op.medium !== Medium.ON_SITE && this.fireSupport()) {
      op.phase = OpPhase.PREP; op.phaseTime = time; op.prepUntil = time + 22;
      this.note(`${this.flagName(op.flag)}: in position (${strength.toFixed(0)} vs ~${this.enemyEst[op.flag].toFixed(0)}), preparing with fires`);
    } else this.execute(op, time);
  }

  /**
   * Re-justification (every 30 s): is the operation still worth what it ties
   * down? Returns true when it was closed.
   */
  private review(op: Operation, time: number): boolean {
    if (op.phase > OpPhase.MOVE_UP || op.type === OpType.SIEGE) return false;
    const est = this.enemyEst[op.flag];
    if (op.type === OpType.SECURE && est > 6 && op.phase === OpPhase.EXECUTE && this.closestSquad(op) > 120) {
      this.cooldown[op.flag] = time + 40;
      this.close(op, OpPhase.CANCELLED, `target reinforced (~${est.toFixed(0)}): needs a deliberate assault, not a detachment`);
      return true;
    }
    if (op.type === OpType.ASSAULT && op.required < est * 1.8 && this.opStrength(op) < est * 1.8 && time - op.start > 90) {
      const army = this.armyStrength();
      if (est * 2.4 > army * 0.6) {
        this.cooldown[op.flag] = time + 90;
        this.close(op, OpPhase.CANCELLED, `defence grew to ~${est.toFixed(0)}, more than we can concentrate (${army.toFixed(0)} in the field)`);
        return true;
      }
      op.required = Math.max(op.required, est * 2.4);
      this.log(`${this.flagName(op.flag)}: defence grew to ~${est.toFixed(0)}, raising the force to ${op.required.toFixed(0)}`);
    }
    return false;
  }

  /**
   * ATTACK by pressure: artillery / CAS and armour wear a hard objective down
   * from range for a while, so a later capture faces fewer defenders.
   */
  private updatePressure(op: Operation, time: number): void {
    const fl = this.game.capture.flags[op.flag], est = this.enemyEst[op.flag];
    this.pressuredAt[op.flag] = time;
    if (fl.owner === this.team) { this.close(op, OpPhase.DONE, `${fl.name} fell to us`); return; }
    if (fl.owner < 0) { this.cooldown[op.flag] = 0; this.close(op, OpPhase.DONE, `defence broken: ${fl.name} is neutral, open for capture`); return; }
    if (time > op.nextFireCall && fl.count[this.team] === 0) {
      op.nextFireCall = time + 12;
      this.radio.publish(RadioType.FIRE_MISSION, this.team, -1, -1, fl.x, fl.y, fl.z, -1, 3, time, 0, false);
      if (op.medium !== Medium.ON_SITE) {
        const m = this.radio.publish(RadioType.CAS_REQUEST, this.team, -1, -1, fl.x, fl.y, fl.z, -1, 3, time, 0, false);
        if (m) { m.vx = -Math.sin(op.mainYaw); m.vz = -Math.cos(op.mainYaw); }
      }
    }
    const killed = this.enemyLoss[op.flag] - op.killMark;
    op.progressPct = Math.min(1, Math.max(0, 1 - est / Math.max(1, op.enemyAtStart)) + killed * 0.08);
    if ((est <= op.enemyAtStart * 0.6 && time - op.start > 40) || killed >= 4) {
      this.attempts[op.flag] = Math.max(0, this.attempts[op.flag] - 1);
      this.hardness[op.flag] = Math.max(0.6, this.hardness[op.flag] * 0.8);
      this.cooldown[op.flag] = 0;
      this.close(op, OpPhase.DONE, `garrison worn down (~${op.enemyAtStart.toFixed(0)} → ~${est.toFixed(0)}, ~${killed.toFixed(0)} killed): ready for capture`);
    }
  }

  /**
   * WEAKEN an enemy asset (the battery, armour or air defence that keeps
   * killing us): STRIKE calls fire missions and CAS on its last known
   * position; HUNT sends armour and an AT team after it. Ends when it is
   * destroyed or nobody has seen it for a minute.
   */
  private updateWeaken(op: Operation, time: number): void {
    const list = this.game.vehicles.list, v = list[op.target - this.S];
    if (!v || !v.alive) { this.killsBy[op.target - this.S] = 0; this.close(op, OpPhase.DONE, `${v ? v.def.label : 'target'} destroyed`); return; }
    if (this.lastReport(op.target, _p2) < 20) { op.tx = _p2[0]; op.tz = _p2[1]; op.targetSeen = time; }
    if (time - op.targetSeen > 60) { this.close(op, OpPhase.CANCELLED, `lost track of the ${v.def.label}`); return; }
    op.progressPct = Math.min(0.9, 1 - v.health / v.def.health);
    if (op.type === OpType.STRIKE && time > op.nextFireCall) {
      op.nextFireCall = time + 10;
      // Not on our own people.
      for (const q of this.squads.squads) if (q.team === this.team && q.alive > 0 && (q.cx - op.tx) ** 2 + (q.cz - op.tz) ** 2 < 50 * 50) return;
      const y = this.game.map.terrain.height(op.tx, op.tz);
      this.radio.publish(RadioType.FIRE_MISSION, this.team, -1, -1, op.tx, y, op.tz, op.target, 3, time, 0, false);
      this.radio.publish(RadioType.CAS_REQUEST, this.team, -1, -1, op.tx, y, op.tz, op.target, 3, time, 0, false);
    }
  }

  /** Age (s) of the latest contact report on target index t; writes its position. */
  private lastReport(t: number, out: Float32Array): number {
    let best = 1e9;
    const time = this.game.time;
    for (const q of this.squads.squads) {
      if (q.team !== this.team) continue;
      for (let k = 0; k < q.cTarget.length; k++) {
        if (q.cTarget[k] !== t) continue;
        const age = time - q.cT[k];
        if (age < best) { best = age; out[0] = q.cX[k]; out[1] = q.cZ[k]; }
      }
    }
    return best;
  }

  /**
   * The enemy retook an objective, so its base is protected again: the siege
   * force does not disband, it turns on the objective they retook (or, if
   * there is nothing sensible to turn on, stands down).
   */
  private siegeLifted(op: Operation, time: number): void {
    const flags = this.game.capture.flags;
    let best = -1, bd = 1e12;
    for (let f = 0; f < this.F; f++) {
      const fl = flags[f];
      if (fl.base || fl.owner === this.team) continue;
      const d = (fl.x - op.stageX) ** 2 + (fl.z - op.stageZ) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    if (best < 0 || this.opStrength(op) < 6) { this.close(op, OpPhase.DONE, 'siege lifted: they retook an objective, base protected again'); return; }
    const est = this.enemyEst[best];
    op.type = OpType.ASSAULT; op.purpose = Purpose.CAPTURE; op.flag = best; op.hq = -1;
    op.required = Math.min(Math.max(10, est * 2.6 + 4), this.armyStrength() * 0.6);
    op.enemyAtStart = est; op.lossMark = this.myLoss[best]; op.bestV = this.progress(best); op.minDist = 1e9;
    op.venue = -1; op.venueWhy = 'field assembly area (re-tasked siege force)';
    this.planGeometry(op);
    op.phase = OpPhase.ASSEMBLE; op.phaseTime = time; op.marchLimit = 0; op.smoked = false; op.reviewAt = time + 30;
    op.deadline = time + 480;
    op.reason = `siege lifted when they retook ${flags[best].name}: same force turns on it`;
    this.stats.retargeted++;
    this.note(`SIEGE → CAPTURE ${flags[best].name}: they retook it and their base is protected again; the siege force (${this.opStrength(op).toFixed(0)}) turns on it`);
  }

  /**
   * SIEGE in execution: keep the current HQ under fire until our troops close
   * on it, switch to the next HQ when it falls, turn on the objective they
   * retake if the base becomes protected again, fall back after ruinous losses.
   */
  private updateSiege(op: Operation, time: number, strength: number): void {
    if (!this.enemyExposed()) { this.siegeLifted(op, time); return; }
    const prev = op.hq;
    if (!this.siegeTarget(op)) { this.close(op, OpPhase.DONE, 'every HQ destroyed'); return; }
    if (op.hq !== prev) { op.progressAt = time; this.note(`SIEGE: HQ down, moving on to the next one`); }
    op.progressPct = 0.5 + 0.12 * (4 - this.hqStanding(this.enemy));
    let near = 1e9;
    for (let i = 0; i < op.nsq; i++) {
      const q = this.squadById(op.squads[i]);
      if (q.alive > 0 && q.dismounted > 0) near = Math.min(near, Math.hypot(q.cx - op.tx, q.cz - op.tz));
    }
    if (near > 55) this.callFires(op, time);
    const lost = this.myLoss[op.flag] - op.lossMark;
    if (lost > Math.max(10, op.strengthAtStart * 1.1) && strength < op.strengthAtStart * 0.4 && time - op.phaseTime > 60) {
      this.cooldown[op.flag] = time + 45;
      this.close(op, OpPhase.FAILED, `siege broken: lost ~${lost.toFixed(0)}, ${strength.toFixed(0)} left; regrouping`);
    }
  }

  private hqStanding(team: number): number {
    const map = this.game.map as any, base = map.bases ? map.bases[team] : null;
    if (!base) return 0;
    let n = 0;
    for (const id of base.hq) if (map.buildings[id].state < 2) n++;
    return n;
  }

  /** Infantry plus armour of this side (the most any one operation could ever draw on). */
  private armyStrength(): number {
    let army = 0;
    for (const q of this.squads.squads) if (q.team === this.team && q.kind === SquadKind.INFANTRY) army += q.alive;
    const list = this.game.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.alive && v.occupied && v.team === this.team && ARMOUR[this.orch.manifests[i].archetype]) army += VEH_W[this.orch.manifests[i].archetype];
    }
    return army;
  }

  /** Seconds the furthest squad of an operation needs to walk to the assembly area (capped). */
  private marchTime(op: Operation, x = op.stageX, z = op.stageZ): number {
    let far = 0;
    for (let i = 0; i < op.nsq; i++) {
      if (op.task[i] === Task.AIR) continue;
      const q = this.squadById(op.squads[i]);
      far = Math.max(far, Math.hypot(q.cx - x, q.cz - z));
    }
    return Math.min(280, far / 4);
  }

  /** Distance from the flag of the nearest attacking squad (main / flank / air; a squad riding a carrier counts where the carrier is). */
  private closestSquad(op: Operation): number {
    const fl = this.game.capture.flags[op.flag];
    let best = 1e9;
    for (let i = 0; i < op.nsq; i++) {
      if (op.task[i] === Task.SUPPORT) continue;
      const q = this.squadById(op.squads[i]);
      if (q.alive === 0) continue;
      if (q.dismounted === 0) {
        if (q.vehicle < 0) continue;
        const v = this.game.vehicles.list[q.vehicle];
        best = Math.min(best, Math.hypot(v.pos.x - fl.x, v.pos.z - fl.z));
        continue;
      }
      best = Math.min(best, Math.hypot(q.cx - fl.x, q.cz - fl.z));
    }
    return best;
  }

  private infantryStrength(op: Operation): number {
    let n = 0;
    for (let i = 0; i < op.nsq; i++) n += this.squadById(op.squads[i]).alive;
    return n;
  }

  private presentAt(op: Operation, x: number, z: number, r: number): number {
    let n = 0;
    for (let i = 0; i < op.nsq; i++) {
      const q = this.squadById(op.squads[i]);
      if (op.task[i] === Task.AIR) { n += q.alive; continue; }
      if (q.dismounted > 0 && (q.cx - x) ** 2 + (q.cz - z) ** 2 < r * r) n += q.alive;
    }
    for (let i = 0; i < op.nveh; i++) {
      const v = this.game.vehicles.list[op.vehicles[i]];
      // Armour counts once it is actually in its firing position near the assembly area.
      if (v.alive && v.occupied && (v.pos.x - x) ** 2 + (v.pos.z - z) ** 2 < 180 * 180) n += VEH_W[this.orch.manifests[op.vehicles[i]].archetype];
    }
    return n;
  }

  private execute(op: Operation, time: number): void {
    op.phase = OpPhase.EXECUTE; op.phaseTime = time; op.progressAt = time;
    op.strengthAtStart = Math.max(op.strengthAtStart, this.opStrength(op));
    op.lossMark = this.myLoss[op.flag];
    for (let i = 0; i < op.nsq; i++) { const q = this.squadById(op.squads[i]); q.axisDone = op.task[i] === Task.SUPPORT || op.task[i] === Task.AIR; }
    const fl = this.game.capture.flags[op.flag];
    // Smoke the line of departure (mortar smoke) so the assault crosses the open ground screened.
    if ((op.type === OpType.ASSAULT || op.type === OpType.SIEGE) && !op.smoked) {
      op.smoked = true;
      const t = this.game.map.terrain;
      for (let k = 0; k < 2; k++) {
        const yaw = op.mainYaw + (k === 0 ? 0.25 : -0.25), d = 95;
        const x = fl.x + Math.sin(yaw) * d, z = fl.z + Math.cos(yaw) * d;
        this.smoke.deploy(x, t.height(x, z) + 2, z, 13, 32, time);
      }
    }
    if (op.type === OpType.SIEGE) this.note(`SIEGE of the ${fl.name} base: going in on ${op.nsq > 1 ? 'two axes' : 'one axis'} toward its HQ`);
    if (op.type === OpType.ASSAULT) this.note(`${fl.name}: assault in ${op.nsq > 1 ? 'two axes' : 'one axis'}${op.hasSbf ? ' with support by fire' : ''}${op.heli >= 0 ? `, air element ${INSERT_NAMES[op.method]}` : ''}`);
  }

  /** Prep fires: artillery fire missions and a CAS request on the objective, attack run along the main axis. */
  private callFires(op: Operation, time: number): void {
    if (time < op.nextFireCall) return;
    op.nextFireCall = time + 7;
    const fl = this.game.capture.flags[op.flag];
    let x = fl.x, y = fl.y, z = fl.z;
    if (op.type === OpType.SIEGE && op.hq >= 0) {
      // Shell the targeted HQ itself; danger close is checked against our squads near it.
      const b = (this.game.map as any).buildings[op.hq];
      x = b.x; z = b.z; y = b.y + 2;
      for (const q of this.squads.squads) if (q.team === this.team && q.alive > 0 && (q.cx - x) ** 2 + (q.cz - z) ** 2 < 45 * 45) return;
    } else if (fl.count[this.team] > 0) return; // never on our own people: skip if friendlies are already on the flag
    this.radio.publish(RadioType.FIRE_MISSION, this.team, -1, -1, x, y, z, -1, 3, time, 0, false);
    const m = this.radio.publish(RadioType.CAS_REQUEST, this.team, -1, -1, x, y, z, -1, 3, time, 0, false);
    if (m) { m.vx = -Math.sin(op.mainYaw); m.vz = -Math.cos(op.mainYaw); }
  }

  /**
   * Assigns eligible squads (see eligible()) nearest to where the operation
   * forms up (its venue, else the line of departure; HUNT: the target, AT
   * teams first) until `required` strength is reached, then the vehicles it
   * needs.
   */
  private allocate(op: Operation, required: number, time: number): void {
    const sq = this.squads.squads;
    let have = this.opStrength(op);
    const ax = op.major ? (op.venue >= 0 ? op.venueX : op.stageX) : op.tx;
    const az = op.major ? (op.venue >= 0 ? op.venueZ : op.stageZ) : op.tz;
    // Local operations draw on squads within reach; major ones on squads that can march to the venue in a few minutes.
    const reach = op.major ? 900 * 900 : op.type === OpType.HUNT ? 600 * 600 : 450 * 450;
    while (have < required && op.nsq < MAX_OP_SQUADS) {
      let best: SquadBlackboard | null = null, bd = reach;
      for (let i = 0; i < sq.length; i++) {
        const q = sq[i];
        if (!this.eligible(q, op, time)) continue;
        let d = (q.cx - ax) ** 2 + (q.cz - az) ** 2;
        if (op.type === OpType.HUNT && !this.hasLauncher(q)) d *= 4;
        if (d < bd) { bd = d; best = q; }
      }
      if (!best) break;
      // Roles: first squad main effort, second flanks, third supports by fire, the rest reinforce the main effort.
      const n = op.nsq;
      const task = !op.major ? Task.MAIN : n === 1 ? Task.FLANK : n === 2 && op.hasSbf ? Task.SUPPORT : Task.MAIN;
      this.addSquad(op, best, task);
      have += best.alive;
    }
    if (op.nveh === 0 || op.phase <= OpPhase.MOVE_UP) this.commitVehicles(op, time);
  }

  private hasLauncher(q: SquadBlackboard): boolean {
    for (let i = 0; i < q.count; i++) { const s = this.game.soldiers[q.members[i]]; if (s.alive && s.launcher) return true; }
    return false;
  }

  // ================================================================= assessment and decisions

  /**
   * What is happening and what matters: flag balance and the ticket trend,
   * threatened flags, flags changing hands, enemy assets that keep killing
   * us. Produces the priorities the decisions below are weighed against.
   */
  private assess(time: number, dt: number): void {
    const flags = this.game.capture.flags, tk = this.game.capture.tickets, sit = this.sit, list = this.game.vehicles.list;
    const k = Math.exp(-dt / 120);
    for (let i = 0; i < this.killsBy.length; i++) this.killsBy[i] *= k;
    if (this.ticketHist.length === 0 || time - this.ticketT >= 30) {
      this.ticketT = time;
      this.ticketHist.push([tk[this.team], tk[this.enemy]]);
      if (this.ticketHist.length > 5) this.ticketHist.shift();
    }
    const h0 = this.ticketHist[0];
    // Tickets they lost minus tickets we lost over the last two minutes (positive: the bleed favours us).
    sit.trend = (h0[1] - tk[this.enemy]) - (h0[0] - tk[this.team]);
    let own = 0, theirs = 0, neutral = 0, threatened = 0;
    for (let f = 0; f < this.F; f++) {
      const fl = flags[f];
      if (fl.owner !== this.ownerSnap[f]) { this.ownerSnap[f] = fl.owner; sit.lastFlip = time; }
      if (fl.base) continue;
      if (fl.owner === this.team) { own++; if (this.threatened(f)) threatened++; }
      else if (fl.owner === this.enemy) theirs++;
      else neutral++;
    }
    sit.own = own; sit.theirs = theirs; sit.neutral = neutral; sit.threatened = threatened;
    sit.free = this.freeStrength();
    sit.behind = own < theirs || sit.trend < -15;
    sit.stalemate = time > 240 && time - sit.lastFlip > 180;
    if (time - this.prioT < 5) return;
    this.prioT = time;
    const p: string[] = [];
    if (this.ownExposed()) p.push('SURVIVE: we hold no objective and our base is exposed; retake one');
    if (this.enemyExposed()) p.push('FINISH: their base is exposed; destroy its HQ');
    if (threatened) p.push(`HOLD: ${threatened} flag${threatened > 1 ? 's' : ''} threatened`);
    if (sit.behind) p.push(`CATCH UP: ${own} vs ${theirs} flags, ticket trend ${sit.trend >= 0 ? '+' : ''}${sit.trend.toFixed(0)}`);
    if (neutral) p.push(`EXPAND: ${neutral} neutral flag${neutral > 1 ? 's' : ''}`);
    let worst = -1, wk = 2.5;
    for (let i = 0; i < this.killsBy.length; i++) if (this.killsBy[i] > wk && list[i].alive) { wk = this.killsBy[i]; worst = i; }
    if (worst >= 0) p.push(`DEGRADE: their ${list[worst].def.label} has killed ~${wk.toFixed(0)} of ours`);
    if (sit.stalemate) p.push(`BREAK STALEMATE: no flag changed hands for ${(time - sit.lastFlip).toFixed(0)} s`);
    if (!sit.behind && own > theirs) p.push(`CONSOLIDATE: ahead ${own} vs ${theirs}`);
    this.priorities = p;
  }

  /** Own flag under threat: the enemy on it, or massing nearby and outnumbering what we have there. */
  private threatened(f: number): boolean {
    const fl = this.game.capture.flags[f];
    return fl.owner === this.team && (fl.contestedBy === this.enemy || this.enemyNear[f] > this.friendly[f] + 2);
  }

  /** Urgency multiplier of gaining a flag, from the priorities (behind, own base exposed, stalemate). */
  private urgency(): number {
    const sit = this.sit;
    return 1 + (sit.behind ? 0.5 : 0) + (this.ownExposed() ? 2 : 0) + (sit.stalemate ? 0.4 : 0);
  }

  /**
   * Is a formal operation worth it right now? Candidates (capture a flag,
   * pressure a hard one, weaken an enemy asset) are scored as benefit minus
   * cost; the best must beat a threshold that rises with every operation
   * already running (major ones count double). Anything routine behaviour
   * achieves anyway (free squads taking an empty flag, garrisons reinforcing
   * a threatened one) is not an operation. Doing nothing is the usual answer.
   */
  private decide(time: number): void {
    if (this.planSiege(time)) return;
    let load = 0, n = 0;
    for (const op of this.ops) if (op.active) { load += op.major ? 2 : 1; n++; }
    // Two or three pushes at once keep the front busy on the big map: a low bar until three are running.
    this.threshold = 0.8 + 0.2 * load;
    if (n >= MAX_OPS - 1) return;
    const flags = this.game.capture.flags, F = this.F, sit = this.sit;
    const ceiling = this.armyStrength() * 0.55;
    let eligibleAll = 0, releasable = 0;
    for (const q of this.squads.squads) if (this.eligibleFor(q, -1, false, time)) eligibleAll += q.alive;
    for (const q of this.squads.squads) if (q.team === this.team && q.garrison >= 0 && q.opId < 0 && this.enemyNear[q.garrison] < 1 && this.garrisonSurplus(q)) releasable += q.alive;
    // What a major operation could actually gather: free squads now, plus spare garrisons (released two at a time).
    const avail = eligibleAll < 4 ? 0 : eligibleAll + releasable * 0.5;
    const urg = this.urgency();
    let anyFront = false;
    for (let f = 0; f < F; f++) if (flags[f].owner !== this.team && !flags[f].base && this.bordersUs(f)) { anyFront = true; break; }
    let bestU = -1e9, bestType = -1, bestF = -1, bestReq = 0, bestTarget = -1, bestWhy = '';
    const fires = this.fireSupport();
    // --- CAPTURE (direct capture or deliberate assault) and ATTACK by pressure.
    for (let f = 0; f < F; f++) {
      const fl = flags[f];
      if (fl.owner === this.team || fl.base || this.opOnFlag(f) || time < this.noForceUntil[f]) continue;
      // Ground operations only where troops can walk / drive from our base; another landmass is taken by air.
      if (!this.onOurLandmass(f)) continue;
      if (anyFront && !this.bordersUs(f)) continue;
      const est = this.enemyEst[f];
      const swing = fl.owner === this.enemy ? 1.6 : 1;
      let near = 1e9;
      for (let o = 0; o < F; o++) if (flags[o].owner === this.team) near = Math.min(near, Math.hypot(flags[o].x - fl.x, flags[o].z - fl.z));
      if (near === 1e9) near = 300;
      // Routine covers it: an empty neutral flag our free squads are already heading for or standing on.
      if (fl.owner < 0 && est < 1.5 && (fl.count[this.team] > 0 || this.routineOn(f))) continue;
      const light = est <= 2.6 && (fl.owner !== this.enemy || this.hardness[f] < 1.2) && fl.contestedBy !== this.enemy;
      const type = light ? OpType.SECURE : OpType.ASSAULT;
      // Doctrine: ~3:1 against a prepared defence, more after each failed attempt.
      const hard = Math.min(2.6, Math.max(this.hardness[f], this.attempts[f] > 0 ? 1 : 0.6) * (1 + 0.4 * this.attempts[f]));
      const required = type === OpType.SECURE ? Math.max(4, est * 1.6 + 2) : Math.max(10, est * 2.6 * hard + 4);
      const value = this.value[f] * swing * urg;
      // After failed assemblies here, only go when clearly more troops are free than the plan needs.
      const margin = 0.8 + 0.3 * Math.min(2, this.assemblyFails[f]);
      const feasible = required <= ceiling && (type === OpType.SECURE ? this.availableFor(f, 450, time) >= required * 0.7 : avail >= required * margin);
      const cooling = time < this.cooldown[f] && avail < required * 1.4;
      if (feasible && !cooling) {
        const u = value - required / 24 - near / 700 - this.attempts[f] * 0.3;
        if (u > bestU) {
          bestU = u; bestType = type; bestF = f; bestReq = required; bestTarget = -1;
          bestWhy = type === OpType.SECURE
            ? `${fl.owner < 0 ? 'neutral (~' + est.toFixed(0) + ' seen) and no squad of ours is taking it' : 'lightly held (~' + est.toFixed(0) + ')'}; worth ${this.value[f].toFixed(1)}`
            : `held by ~${est.toFixed(0)}${this.attempts[f] ? `, attempt ${this.attempts[f] + 1} (hardness ${this.hardness[f].toFixed(1)})` : ''}; ${required.toFixed(0)} for ${(required / Math.max(1, est)).toFixed(1)}:1`;
        }
      } else if (fl.owner === this.enemy && fires && est >= 3 && time > this.pressuredAt[f] + 150) {
        // Too hard to take now: wear it down from range so a later capture faces fewer defenders.
        const u = 0.5 * value * (1 + 0.3 * this.attempts[f]) + (sit.stalemate ? 0.4 : 0) - 0.25;
        if (u > bestU) {
          bestU = u; bestType = OpType.PRESSURE; bestF = f; bestReq = 0; bestTarget = -1;
          bestWhy = `held by ~${est.toFixed(0)}: ${required > ceiling ? `needs ${required.toFixed(0)}, more than we can concentrate` : cooling ? 'recent attack failed' : `only ${avail.toFixed(0)} available`}; wear it down with fires${this.freeArmour(fl.x, fl.z) >= 0 ? ' and armour' : ''}`;
        }
      }
    }
    // --- WEAKEN: an enemy vehicle that keeps killing us and is currently known.
    const list = this.game.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const kills = this.killsBy[i];
      if (kills < 3) continue;
      const v = list[i];
      if (!v.alive || !v.occupied || v.team !== this.enemy || v.isAircraft || this.opOnTarget(this.S + i)) continue;
      if (this.lastReport(this.S + i, _p2) > 20) continue;
      const armour = ARMOUR[this.orch.manifests[i].archetype] === 1;
      const hunter = armour ? this.freeArmour(_p2[0], _p2[1]) : -1;
      const type = fires ? OpType.STRIKE : hunter >= 0 ? OpType.HUNT : -1;
      if (type < 0) continue;
      const u = 0.45 * kills * (sit.behind ? 1.2 : 1) - (type === OpType.STRIKE ? 0.3 : 0.6);
      if (u > bestU) {
        bestU = u; bestType = type; bestF = this.flagNear(_p2[0], _p2[1]); bestReq = type === OpType.HUNT ? 6 : 0; bestTarget = this.S + i;
        bestWhy = `their ${v.def.label} has killed ~${kills.toFixed(0)} of ours; ${type === OpType.STRIKE ? 'fire missions and CAS on its last position' : 'armour and an AT team go after it'}`;
      }
    }
    if (bestType < 0) { this.lastDecision = 'nothing worth an operation'; return; }
    if (bestU < this.threshold) {
      this.lastDecision = `declined ${PURPOSE_NAMES[METHOD_PURPOSE[bestType]]} ${this.flagName(bestF)} (${OP_NAMES[bestType]}): utility ${bestU.toFixed(2)} < ${this.threshold.toFixed(2)} with ${n} running`;
      if (time - this.declineT > 20) { this.declineT = time; this.stats.declined++; this.log(this.lastDecision); }
      return;
    }
    this.lastDecision = `launched ${OP_NAMES[bestType]} ${this.flagName(bestF)} (utility ${bestU.toFixed(2)} ≥ ${this.threshold.toFixed(2)})`;
    const op = this.open(bestType, bestF, bestReq, bestWhy, time, bestType === OpType.PRESSURE && this.freeArmour(flags[bestF].x, flags[bestF].z) < 0 ? Medium.REMOTE : -1);
    if (!op) return;
    if (bestTarget >= 0) { this.lastReport(bestTarget, _p2); op.target = bestTarget; op.tx = _p2[0]; op.tz = _p2[1]; op.targetSeen = time; }
    if (bestType === OpType.PRESSURE) { op.mainYaw = Math.atan2(this.homeX(op), this.homeZ(op)); }
    if (op.major) this.releaseGarrisons(op, 1);
    if (bestReq > 0) this.allocate(op, bestReq, time);
    else this.commitVehicles(op, time);
    if (bestReq > 0 && op.nsq === 0 && op.nveh === 0) {
      this.noForceUntil[bestF] = time + 45;
      this.close(op, OpPhase.CANCELLED, 'nobody available without pulling units out of a fight');
    }
  }

  /** Direction (sin, cos components) from an operation's target toward our side. */
  private homeX(op: Operation): number { const h = this.nearestOwned(op.tx, op.tz); return h >= 0 ? this.game.capture.flags[h].x - op.tx : 0; }
  private homeZ(op: Operation): number { const h = this.nearestOwned(op.tx, op.tz); return h >= 0 ? this.game.capture.flags[h].z - op.tz : 1; }

  private nearestOwned(x: number, z: number): number {
    const flags = this.game.capture.flags;
    let best = -1, bd = 1e12;
    for (let f = 0; f < this.F; f++) {
      if (flags[f].owner !== this.team) continue;
      const d = (flags[f].x - x) ** 2 + (flags[f].z - z) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  private flagNear(x: number, z: number): number {
    const flags = this.game.capture.flags;
    let best = 0, bd = 1e12;
    for (let f = 0; f < this.F; f++) { const d = (flags[f].x - x) ** 2 + (flags[f].z - z) ** 2; if (d < bd) { bd = d; best = f; } }
    return best;
  }

  private opOnTarget(t: number): boolean {
    for (const op of this.ops) if (op.active && op.target === t) return true;
    return false;
  }

  /** Is a free squad of ours already heading for flag f on its own initiative? */
  private routineOn(f: number): boolean {
    const fl = this.game.capture.flags[f];
    for (const q of this.squads.squads) if (q.team === this.team && q.opId < 0 && q.garrison < 0 && q.alive >= 2 && q.objective === fl && q.order === Order.NONE) return true;
    return false;
  }

  /**
   * Routine defence, no operation: a threatened flag draws the nearest
   * uncommitted squads (not in a fight elsewhere) as its garrison until we
   * roughly match what is massing there. Squads in operations are never
   * pulled.
   */
  private reinforce(time: number): void {
    const flags = this.game.capture.flags;
    for (let f = 0; f < this.F; f++) {
      if (!this.threatened(f)) continue;
      const fl = flags[f];
      let have = this.friendly[f];
      for (const q of this.squads.squads) {
        if (q.team === this.team && q.garrison === f && q.opId < 0 && (q.cx - fl.x) ** 2 + (q.cz - fl.z) ** 2 > 60 * 60) have += q.alive;
      }
      const need = this.enemyNear[f] * 1.2 + 1;
      let added = 0;
      while (have < need && added < 2) {
        let best: SquadBlackboard | null = null, bd = 450 * 450;
        for (const q of this.squads.squads) {
          if (!this.isFree(q) || this.inContact(q, time) || !(this.game.nav as any).sameLandmass(q.cx, q.cz, fl.x, fl.z)) continue;
          const d = (q.cx - fl.x) ** 2 + (q.cz - fl.z) ** 2;
          if (d < bd) { bd = d; best = q; }
        }
        if (!best) break;
        best.garrison = f; best.garrisonT = time; best.recoverUntil = 0;
        have += best.alive; added++;
      }
      if (added) {
        this.stats.reinforcements += added;
        if (time - this.reinfT[f] > 30) {
          this.reinfT[f] = time;
          this.log(`${fl.name} threatened (~${this.enemyNear[f].toFixed(0)} vs ${this.friendly[f].toFixed(0)}): ${added} squad${added > 1 ? 's' : ''} reinforce it (routine, no operation)`);
        }
      }
    }
  }

  /**
   * Staging venue for a major operation: one of our own uncontested
   * facilities 150–700 m from the target on our side of it, scored by its
   * capacity (bases and large depots organise a force best), the free troops
   * already near it, a sensible approach distance, safety, and how many other
   * operations already stage there. No such facility: the field assembly area.
   */
  private pickVenue(op: Operation, time: number): void {
    const flags = this.game.capture.flags;
    let best = -1, bs = -1e9, bNear = 0, bD = 0;
    for (let f = 0; f < this.F; f++) {
      const v = flags[f];
      if (v.owner !== this.team || f === op.flag || v.contestedBy >= 0 || this.enemyNear[f] > 1) continue;
      const d = Math.hypot(v.x - op.tx, v.z - op.tz);
      if (d < 150 || d > 700) continue;
      const cap = VENUE_CAPACITY[(v as any).kind] || 1.2;
      let near = 0;
      for (const q of this.squads.squads) if (this.isFree(q) && (q.cx - v.x) ** 2 + (q.cz - v.z) ** 2 < 350 * 350) near += q.alive;
      let others = 0;
      for (const o of this.ops) if (o.active && o !== op && o.venue === f) others++;
      // On our side of the target: the venue should lie roughly along the planned approach.
      const yaw = Math.atan2(v.x - op.tx, v.z - op.tz);
      const along = Math.cos(yaw - op.mainYaw);
      const s = cap * 0.8 + Math.min(12, near) * 0.12 - Math.abs(d - 340) / 200 + along * 0.8 - others * 0.8;
      if (s > bs) { bs = s; best = f; bNear = near; bD = d; }
    }
    if (best < 0) {
      op.venue = -1; op.venueX = op.stageX; op.venueZ = op.stageZ;
      op.venueWhy = 'the field assembly area (no safe friendly facility within reach)';
      return;
    }
    const v = flags[best];
    op.venue = best; op.venueX = v.x; op.venueZ = v.z;
    op.venueWhy = `${v.name} (${(v as any).kind || 'site'}, ${bD.toFixed(0)} m from the target, ${bNear} free troops nearby)`;
    void time;
  }

  /**
   * Organic participation: a squad joins an operation only if it is free,
   * not fighting, not regrouping after a failed operation, not about to
   * finish taking a flag on its own, and not being sent straight back at the
   * target it just failed on.
   */
  private eligible(q: SquadBlackboard, op: Operation, time: number): boolean {
    return this.eligibleFor(q, op.flag, op.type === OpType.SIEGE, time);
  }

  private eligibleFor(q: SquadBlackboard, f: number, siege: boolean, time: number): boolean {
    if (!this.isFree(q) || time < q.recoverUntil || this.inContact(q, time)) return false;
    // Purpose gate: a free squad inside the assault ring of the flag it is taking is not pulled off it.
    if (!this.squads.mayRetask(q, false, f >= 0 ? this.game.capture.flags[f] : null)) return false;
    if (q.lastOpTarget === f && time - q.lastOpEnd < 150 && !siege) return false;
    // Riding somewhere already: its transport keeps its destination.
    if (q.vehicle >= 0) return false;
    // Finishing its own capture.
    const o = q.objective;
    if (o && o.owner !== this.team && o !== this.game.capture.flags[f] && (o.x - q.cx) ** 2 + (o.z - q.cz) ** 2 < 60 * 60) return false;
    // Closing on another objective of its own (on its way for a while, and getting there): let it finish the
    // attempt rather than turn it round, unless that objective lies on the way to this operation's.
    if (o && f >= 0 && o.owner !== this.team && o !== this.game.capture.flags[f] && q.order === Order.NONE && time - q.objSince > 20) {
      const of = this.game.capture.flags[f], dO = Math.hypot(o.x - q.cx, o.z - q.cz);
      if (of && dO < 300 && Math.hypot(of.x - o.x, of.z - o.z) > 150) return false;
    }
    return true;
  }

  /** Strength of squads that could join an operation on flag f without breaking the participation rules (within r). */
  private availableFor(f: number, r: number, time: number): number {
    const fl = this.game.capture.flags[f];
    let n = 0;
    for (const q of this.squads.squads) if (this.eligibleFor(q, f, false, time) && (q.cx - fl.x) ** 2 + (q.cz - fl.z) ** 2 < r * r) n += q.alive;
    return n;
  }

  private inContact(q: SquadBlackboard, time: number): boolean {
    return q.contactCentroid(time, 8, _p3) > 0 && (_p3[0] - q.cx) ** 2 + (_p3[1] - q.cz) ** 2 < 220 * 220;
  }

  /** Nearest free AI-driven armour to (x, z) within 900 m (-1 none). */
  private freeArmour(x: number, z: number): number {
    return this.freeVehicle(x, z, VRole.ARMOUR, 900);
  }

  private fitsRole(a: number, role: number): boolean {
    return role === VRole.ARMOUR ? ARMOUR[a] === 1 : role === VRole.AIR_DEFENCE ? a === Archetype.SAM || a === Archetype.SPAAG : a === Archetype.SUPPLY;
  }

  private freeVehicle(x: number, z: number, role: number, r: number): number {
    const list = this.game.vehicles.list;
    let best = -1, bd = r * r;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.alive || !v.occupied || v.team !== this.team || this.vehOp[i] >= 0 || !this.fitsRole(this.orch.manifests[i].archetype, role)) continue;
      if (!v.driver || v.driver.isPlayer || !v.driver.ai || this.squads.convoyOf[i] >= 0 || this.orch.manifests[i].servicing) continue;
      const d = (v.pos.x - x) ** 2 + (v.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /**
   * Vehicles by need: armour against a real defence or enemy armour, air
   * defence when enemy aircraft have been about lately, a supply truck for a
   * big deliberate operation. Nothing is committed just because it exists.
   */
  private commitVehicles(op: Operation, time: number): void {
    const est = this.enemyEst[op.flag];
    const enemyArmour = this.enemyArmourNear(op.tx, op.tz, 250);
    let armour = 0, aa = 0, supply = 0;
    const why: string[] = [];
    switch (op.type) {
      case OpType.ASSAULT: case OpType.SIEGE:
        armour = enemyArmour > 0 ? 2 : est >= 4 ? Math.min(3, Math.ceil(est / 5)) : 0;
        aa = time - this.lastAirSeen < 120 ? 1 : 0;
        supply = op.required >= 14 ? 1 : 0;
        break;
      case OpType.SECURE: armour = enemyArmour > 0 ? 1 : 0; break;
      case OpType.PRESSURE: armour = op.medium === Medium.REMOTE ? 0 : est >= 6 ? 2 : 1; break;
      case OpType.HUNT: armour = enemyArmour > 1 ? 2 : 1; break;
    }
    const x = op.venue >= 0 ? op.venueX : op.tx, z = op.venue >= 0 ? op.venueZ : op.tz;
    const want = [armour, aa, supply];
    for (let role = 0; role < 3; role++) {
      let have = 0, added = 0;
      for (let i = 0; i < op.nveh; i++) if (op.vrole[i] === role) have++;
      while (have < want[role] && op.nveh < op.vehicles.length) {
        const v = this.freeVehicle(x, z, role, role === VRole.ARMOUR ? 900 : 1200);
        if (v < 0) break;
        op.vehicles[op.nveh] = v; op.vrole[op.nveh] = role; op.nveh++;
        this.vehOp[v] = op.id; this.fireAt[v] = -1e3;
        this.stats.vehiclesCommitted++; have++; added++;
      }
      if (added) why.push(`${added} ${VROLE_NAMES[role]} (${this.game.vehicles.list[op.vehicles[op.nveh - 1]].def.label})`);
    }
    if (!op.vehNoted && !armour && (op.type === OpType.ASSAULT || op.type === OpType.SECURE) && this.freeArmour(x, z) >= 0) {
      this.stats.vehiclesNotNeeded++;
      why.push('armour available but not needed (defence too light)');
    }
    op.vehNoted = true;
    if (why.length) this.log(`${this.flagName(op.flag)} (${OP_NAMES[op.type]}) vehicles: ${why.join(', ')}`);
  }

  /** Reported enemy armour within r of (x, z). */
  private enemyArmourNear(x: number, z: number, r: number): number {
    const time = this.game.time, list = this.game.vehicles.list;
    let n = 0;
    this.stampId++;
    for (const q of this.squads.squads) {
      if (q.team !== this.team) continue;
      for (let k = 0; k < q.cTarget.length; k++) {
        const t = q.cTarget[k];
        if (t < this.S || time - q.cT[k] > 60 || this.stamp[t] === this.stampId) continue;
        this.stamp[t] = this.stampId;
        const v = list[t - this.S];
        if (v.alive && ARMOUR[this.orch.manifests[t - this.S].archetype] && (q.cX[k] - x) ** 2 + (q.cZ[k] - z) ** 2 < r * r) n++;
      }
    }
    return n;
  }

  /**
   * Endgame: the enemy holds nothing and its base is exposed. One SIEGE
   * operation at a time, formed from free squads plus garrisons released from
   * safe rear flags at most two per think (flags next to the enemy base keep
   * theirs: that is where the defenders will try to break out). Ongoing
   * operations are never stripped, so the switch to the endgame is gradual.
   * @returns true when a siege was opened this think
   */
  private planSiege(time: number): boolean {
    if (!this.enemyExposed() || this.activeOps() >= MAX_OPS) return false;
    const bf = this.baseFlag(this.enemy);
    if (bf < 0 || time < this.cooldown[bf]) return false;
    for (const op of this.ops) if (op.active && op.type === OpType.SIEGE) return false;
    let army = 0;
    for (const q of this.squads.squads) if (q.team === this.team && q.kind === SquadKind.INFANTRY) army += q.alive;
    const est = this.enemyEst[bf];
    const required = Math.min(Math.max(8, army * 0.55), Math.max(12, est * 2.2 + 6));
    const op = this.open(OpType.SIEGE, bf, required, `they hold no objective: base exposed, ~${est.toFixed(0)} defending; concentrating ${required.toFixed(0)} to destroy its HQ`, time);
    if (!op) return false;
    this.releaseGarrisons(op, 2);
    this.allocate(op, required, time);
    if (op.nsq === 0 && this.squadsReleasable(op) === 0) { this.close(op, OpPhase.DONE, ''); return false; }
    return true;
  }

  /** Garrison squads that could be freed for a siege (safe flags not bordering the enemy base). */
  private squadsReleasable(op: Operation): number {
    let n = 0;
    for (const q of this.squads.squads) if (this.releasable(q, op)) n++;
    return n;
  }

  private releasable(q: SquadBlackboard, op: Operation): boolean {
    if (q.team !== this.team || q.kind !== SquadKind.INFANTRY || q.opId >= 0 || q.garrison < 0 || q.alive < 2) return false;
    const f = q.garrison;
    if (this.enemyNear[f] >= 1 || this.adj[f * this.F + op.flag]) return false;
    // Keep one squad on every flag: release only where another squad also garrisons.
    let others = 0;
    for (const o of this.squads.squads) if (o !== q && o.team === this.team && o.garrison === f && o.alive > 0) others++;
    return others > 0 || this.ownedCount(this.team) > 6;
  }

  /** Frees up to `n` releasable garrison squads nearest to the operation's assembly area. */
  private releaseGarrisons(op: Operation, n: number): void {
    for (let k = 0; k < n; k++) {
      let best: SquadBlackboard | null = null, bd = 1e12;
      for (const q of this.squads.squads) {
        if (!this.releasable(q, op)) continue;
        const d = (q.cx - op.stageX) ** 2 + (q.cz - op.stageZ) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
      if (!best) return;
      best.garrison = -1;
    }
  }

  /** Is flag f linked by road to a flag we hold (or unowned and next to nothing of the enemy's)? */
  private bordersUs(f: number): boolean {
    const flags = this.game.capture.flags, F = this.F;
    for (let o = 0; o < F; o++) if (this.adj[f * F + o] && flags[o].owner === this.team) return true;
    return false;
  }

  /**
   * Air assault: a transport helicopter inserts a squad. Either onto the far
   * side of an assault objective that has already resisted (vertical
   * envelopment), or onto a weakly held flag deep behind the enemy line.
   */
  private planAir(time: number): void {
    const heli = this.orch.idleTransport(this.team);
    if (heli < 0) return;
    const hv = this.game.vehicles.list[heli];
    const flags = this.game.capture.flags;
    // 1) Envelopment for an assault that is assembling or preparing.
    let target: Operation | null = null;
    for (const op of this.ops) {
      if (!op.active || op.type !== OpType.ASSAULT || op.heli >= 0 || op.phase > OpPhase.PREP) continue;
      if (this.nearEnemyBase(flags[op.flag].x, flags[op.flag].z, 650)) continue;
      if (this.attempts[op.flag] > 0 || this.hardness[op.flag] > 1.3 || this.enemyEst[op.flag] > 5) { target = op; break; }
    }
    let squad = this.nearestFree(hv.pos.x, hv.pos.z, 420);
    if (!squad) return;
    if (target) {
      const fl = flags[target.flag];
      // Drop zone in the defenders' rear (far side from the main axis), out of their sight and away from known enemies.
      if (!this.pickDropZone(fl, target.mainYaw + Math.PI, _p2)) return;
      target.dropX = _p2[0]; target.dropZ = _p2[1];
      const method = this.chooseInsert(target.dropX, target.dropZ, true);
      target.method = method;
      if (!this.orch.requestInsertion(heli, squad, target.dropX, target.dropZ, method, time)) return;
      target.heli = heli; target.airSquad = squad.id; target.airStart = time;
      this.addSquad(target, squad, Task.AIR);
      this.stats.airInsertions++;
      this.note(`${fl.name}: air element (${INSERT_NAMES[method]}) into the defenders' rear to split the defence`);
      return;
    }
    // 2) Deep, weakly held flag — or one across the water (NOVEMBER), which only aircraft can reach.
    let best = -1, bs = 0;
    for (let f = 0; f < this.F; f++) {
      const fl = flags[f];
      const offshore = !this.onOurLandmass(f);
      if (fl.owner === this.team || this.opOnFlag(f) || fl.base || this.enemyEst[f] > (offshore ? 6 : 3.5)) continue;
      // Not under the enemy base's air-defence umbrella (helicopters were shot down roping in next to it).
      if (this.nearEnemyBase(fl.x, fl.z, 650)) continue;
      let near = 1e9;
      for (let o = 0; o < this.F; o++) if (flags[o].owner === this.team) near = Math.min(near, Math.hypot(flags[o].x - fl.x, flags[o].z - fl.z));
      if (near < 200 && !offshore) continue;
      // An objective only aircraft can reach comes first: nothing else will ever take it.
      const s = offshore ? 1000 + this.value[f] / (1 + this.enemyEst[f]) : this.value[f] * near / 200 / (1 + this.enemyEst[f]);
      if (s > bs) { bs = s; best = f; }
    }
    if (best < 0) return;
    const fl = flags[best];
    // Worth risking a helicopter and a squad on? Same bar as any other operation — except an objective only
    // aircraft can reach (NOVEMBER): nobody else will ever take it, so it carries a standing bonus.
    const offshoreBest = !this.onOurLandmass(best);
    const u = this.value[best] * (fl.owner === this.enemy ? 1.6 : 1) * this.urgency() - 0.5 - this.enemyEst[best] * 0.25 + (offshoreBest ? 0.9 : 0);
    // (It ties up one helicopter and one squad, nothing a ground operation needs: judged against the base bar,
    // not the bar raised by the ground operations already running.)
    if (u < (offshoreBest ? 1 : this.threshold)) return;
    const op = this.open(OpType.AIR_ASSAULT, best, 4, `deep and weakly held (~${this.enemyEst[best].toFixed(0)}), out of reach on foot: vertical envelopment (utility ${u.toFixed(2)})`, time);
    if (!op) return;
    // Landing zone: on the island, its helipad / the nearest clear ground within 90 m of the flag (so the
    // squad is inside the 180 m ring the moment it is down); a standing rooftop objective (MIKE): fast-rope
    // straight onto the roof; elsewhere the usual defilade LZ 115–160 m out.
    let method: number;
    if ((fl as any).host && (fl as any).host.state < 2) { op.dropX = fl.x; op.dropZ = fl.z; method = Insert.ROPE; }
    else {
      if (!(this.onOurLandmass(best) ? this.pickDropZone(fl, Math.atan2(hv.pos.x - fl.x, hv.pos.z - fl.z), _p2) : this.pickIslandLz(fl, _p2))) { this.close(op, OpPhase.DONE, ''); return; }
      op.dropX = _p2[0]; op.dropZ = _p2[1];
      method = this.chooseInsert(op.dropX, op.dropZ, false);
    }
    op.method = method;
    if (!this.orch.requestInsertion(heli, squad, op.dropX, op.dropZ, method, time)) { this.close(op, OpPhase.DONE, ''); return; }
    op.heli = heli; op.airSquad = squad.id; op.airStart = time;
    this.addSquad(op, squad, Task.AIR);
    this.stats.airInsertions++;
    squad = null;
  }

  /**
   * Drop zone 110–170 m from an objective: in defilade from the flag, clear of
   * reported enemies, preferably toward `prefYaw` (e.g. the defenders' rear),
   * on walkable ground. Never on top of the defenders.
   */
  private pickDropZone(fl: FlagLike, prefYaw: number, out: Float32Array): boolean {
    const t = this.game.map.terrain, oy = t.height(fl.x, fl.z) + 1.6;
    let best = -1e9;
    for (let a = 0; a < 12; a++) {
      const yaw = prefYaw + (a - 5.5) * 0.35;
      for (let r = 0; r < 2; r++) {
        const d = 115 + r * 45, x = fl.x + Math.sin(yaw) * d, z = fl.z + Math.cos(yaw) * d;
        if (!t.inBounds(x, z, 30) || this.game.nav.blocked(x, z)) continue;
        let s = Math.cos(yaw - prefYaw) * 0.6 + this.foliage.at(x, z) * 0.3;
        if (!terrainLos(t, this.foliage, fl.x, oy, fl.z, x, t.height(x, z) + 2, z)) s += 1.5;
        s -= this.enemiesNearPoint(x, z, 100) * 0.6;
        if (s > best) { best = s; out[0] = x; out[1] = z; }
      }
    }
    return best > -1e9;
  }

  /** Within r of the enemy's base flag (its SAM / AA umbrella)? */
  private nearEnemyBase(x: number, z: number, r: number): boolean {
    for (const o of this.game.capture.flags) if (o.base && o.owner === this.enemy && (o.x - x) ** 2 + (o.z - z) ** 2 < r * r) return true;
    return false;
  }

  /** Is flag f on the same landmass as our base (reachable on foot / by road)? */
  private onOurLandmass(f: number): boolean {
    const flags = this.game.capture.flags;
    let bx = 0, bz = 0;
    for (const o of flags) if (o.base && o.owner === this.team) { bx = o.x; bz = o.z; break; }
    return (this.game.nav as any).sameLandmass(bx, bz, flags[f].x, flags[f].z);
  }

  /** Landing zone close to an offshore objective: clear, walkable ground 40–90 m from the flag on its landmass. */
  private pickIslandLz(fl: FlagLike, out: Float32Array): boolean {
    const nav = this.game.nav as any, t = this.game.map.terrain;
    let best = -1e9;
    for (let a = 0; a < 16; a++) for (const d of [45, 65, 90]) {
      const yaw = (a / 16) * Math.PI * 2, x = fl.x + Math.sin(yaw) * d, z = fl.z + Math.cos(yaw) * d;
      if (nav.blocked(x, z) || !nav.sameLandmass(x, z, fl.x, fl.z) || (t as any).slope(x, z) > 0.27) continue;
      const s = -this.enemiesNearPoint(x, z, 80) - d / 100;
      if (s > best) { best = s; out[0] = x; out[1] = z; }
    }
    return best > -1e9;
  }

  /** Reported enemy contacts within r of (x, z). */
  private enemiesNearPoint(x: number, z: number, r: number): number {
    let n = 0;
    const time = this.game.time;
    for (const q of this.squads.squads) {
      if (q.team !== this.team) continue;
      for (let k = 0; k < q.cTarget.length; k++) if (q.cTarget[k] >= 0 && time - q.cT[k] < 30 && (q.cX[k] - x) ** 2 + (q.cZ[k] - z) ** 2 < r * r) n++;
    }
    return n;
  }

  private nearestFree(x: number, z: number, r: number): SquadBlackboard | null {
    let best: SquadBlackboard | null = null, bd = r * r;
    const time = this.game.time;
    for (const q of this.squads.squads) {
      if (!this.isFree(q) || q.dismounted < 2 || q.vehicle >= 0 || time < q.recoverUntil || this.inContact(q, time)) continue;
      const d = (q.cx - x) ** 2 + (q.cz - z) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  /**
   * Insertion method: parachute when enemy air defence covers the area (stay
   * high, one fast pass), fast-rope into a hot or cluttered zone (no
   * touchdown), land on open, flat, quiet ground.
   */
  private chooseInsert(x: number, z: number, hot: boolean): number {
    const list = this.game.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i], a = this.orch.manifests[i].archetype;
      if (!v.alive || !v.occupied || v.team !== this.enemy || (a !== Archetype.SAM && a !== Archetype.SPAAG)) continue;
      if (this.knownEnemy(this.S + i) && Math.hypot(v.pos.x - x, v.pos.z - z) < 650) return Insert.PARA;
    }
    // Enemies reported near the zone: no hovering there, one fast high pass instead.
    if (this.enemiesNearPoint(x, z, 150) > 0) return Insert.PARA;
    if (hot) return Insert.ROPE;
    const t = this.game.map.terrain;
    if (t.inBounds(x, z, 30) && !this.game.nav.blocked(x, z, true) && this.foliage.at(x, z) < 0.15) {
      let flat = true;
      for (let k = 0; k < 6 && flat; k++) { const a = k * 1.047; if (Math.abs(t.height(x + Math.cos(a) * 9, z + Math.sin(a) * 9) - t.height(x, z)) > 1.6) flat = false; }
      if (flat) return Insert.LAND;
    }
    return Insert.ROPE;
  }

  /** Has any of our squads reported this target recently? */
  private knownEnemy(t: number): boolean {
    for (const q of this.squads.squads) {
      if (q.team !== this.team) continue;
      for (let k = 0; k < q.cTarget.length; k++) if (q.cTarget[k] === t && this.game.time - q.cT[k] < 60) return true;
    }
    return false;
  }

  // ================================================================= orders

  /**
   * Turns operations, garrisons, recovery and initiative into concrete squad
   * orders. Squads outside operations act on their own initiative within the
   * commander's priorities (objectiveBias); garrisons hold where they are
   * needed; squads coming out of a failed operation regroup first.
   */
  private issueOrders(time: number): void {
    const g = this.game, flags = g.capture.flags;
    for (const op of this.ops) {
      if (!op.active) continue;
      const fl = flags[op.flag];
      const toYaw = Math.atan2(op.tx - op.stageX, op.tz - op.stageZ);
      for (let i = 0; i < op.nsq; i++) {
        const q = this.squadById(op.squads[i]);
        if (q.opId !== op.id) continue;
        q.objective = fl; q.objectiveTime = time;
        const task = op.task[i];
        if (task === Task.AIR && !op.airDone) {
          // Riding / boarding the helicopter; once everyone is out, fight for the flag from the drop zone.
          const out = op.airStart >= 0 && time - op.airStart > 12 && !this.squadAboard(q) && !this.orch.insertionPending(op.heli, q.id);
          if (out) { op.airDone = true; this.note(`${fl.name}: air element on the ground`); }
          else { q.order = Order.AIRLIFT; continue; }
        }
        // Extraction: a transport is on its way, stay put and wait for it; nobody could come, so break off on foot.
        if (q.extractState === 'coming' && q.vehicle < 0) { this.setOrder(q, Order.HOLD, q.cx, q.cz, 12, q.threatYaw); continue; }
        if (q.extractState === 'denied' && time - q.extractT < 5) {
          this.withdraw(op, q, time, 'combat ineffective and no transport could pull it out');
          continue;
        }
        if (op.type === OpType.HUNT) {
          // After the asset: fire and movement toward where it was last reported.
          q.axisDone = true;
          this.setOrder(q, Order.ATTACK, op.tx, op.tz, 25, Math.atan2(op.tx - q.cx, op.tz - q.cz));
        } else if (op.phase === OpPhase.CONSOLIDATE) {
          this.setOrder(q, Order.DEFEND, fl.x, fl.z, 14, this.threatYawAt(op.flag, q));
        } else if (op.phase === OpPhase.ASSEMBLE) {
          // Form up physically at the staging venue (or the field assembly area).
          if (op.venue >= 0) this.setOrder(q, Order.HOLD, op.venueX, op.venueZ, 35, Math.atan2(op.tx - op.venueX, op.tz - op.venueZ));
          else this.setOrder(q, Order.HOLD, op.stageX, op.stageZ, 30, toYaw);
        } else if (op.phase === OpPhase.MOVE_UP || op.phase === OpPhase.PREP) {
          this.setOrder(q, Order.HOLD, op.stageX, op.stageZ, 30, toYaw);
        } else if (task === Task.SUPPORT && op.hasSbf && !(op.phase === OpPhase.EXECUTE && fl.count[this.team] > 0 && op.type !== OpType.PRESSURE)) {
          this.setOrder(q, Order.SUPPORT, op.sbfX, op.sbfZ, 22, Math.atan2(fl.x - op.sbfX, fl.z - op.sbfZ));
        } else if (task === Task.SUPPORT && op.hasSbf) {
          // The assault is in the circle: the support-by-fire squad moves in too, a capture needs bodies on the flag.
          if (q.order !== Order.ATTACK) { q.axisDone = true; q.assignWhy = `assault is on ${fl.name}: support squad moving in to help take it`; }
          this.setOrder(q, Order.ATTACK, fl.x, fl.z, 12, Math.atan2(fl.x - q.cx, fl.z - q.cz));
        } else if (op.type === OpType.SIEGE) {
          // Close on the targeted HQ: main effort straight in, the flank around the side.
          const ax = task === Task.FLANK ? 1 : 0;
          if (q.order !== Order.ATTACK) q.axisDone = task !== Task.FLANK;
          q.axisX = op.axisX[ax]; q.axisZ = op.axisZ[ax];
          this.setOrder(q, Order.ATTACK, op.tx, op.tz, 18, Math.atan2(op.tx - q.cx, op.tz - q.cz));
        } else {
          const ax = task === Task.FLANK ? 1 : 0;
          if (q.order !== Order.ATTACK) q.axisDone = op.type !== OpType.ASSAULT || task === Task.AIR;
          q.axisX = op.axisX[ax]; q.axisZ = op.axisZ[ax];
          this.setOrder(q, Order.ATTACK, fl.x, fl.z, 12, Math.atan2(fl.x - q.cx, fl.z - q.cz));
        }
      }
    }
    const open = this.setBias(time);
    const bias = this.squads.objectiveBias[this.team];
    for (const q of this.squads.squads) {
      if (q.team !== this.team || q.kind !== SquadKind.INFANTRY || q.opId >= 0) continue;
      // Mid-insertion (boarding, flying, on the rope / canopy): leave it alone until everyone is down.
      if (q.order === Order.AIRLIFT) {
        if (q.vehicle >= 0 || this.squadAboard(q)) continue;
        q.order = Order.NONE;
      }
      if (q.garrison >= 0 && flags[q.garrison].owner !== this.team) q.garrison = -1;
      if (q.garrison < 0 && time < q.recoverUntil) {
        // Regroup after a failed or cancelled operation before taking on anything new.
        const t = flags[Math.max(0, q.lastOpTarget)];
        this.setOrder(q, Order.HOLD, q.recoverX, q.recoverZ, 30, Math.atan2(t.x - q.recoverX, t.z - q.recoverZ));
        continue;
      }
      if (q.defensive) {
        // Re-read where the garrison is needed (front lines move); switch only for a clearly better post.
        // Defensive squads go where a garrison is short first; where every flag is covered, the most exposed one.
        const short = this.garrisonFlag(q, true), best = short >= 0 ? short : this.garrisonFlag(q);
        const stay = q.garrison >= 0 && (this.garrisonShort(q.garrison, q) || short < 0);
        if (q.garrison < 0 || (best >= 0 && best !== q.garrison && (!stay || this.garrisonScore(best, q) > this.garrisonScore(q.garrison, q) + 1.2) && time - q.garrisonT > 45)) { q.garrison = best; q.garrisonT = time; }
      } else if (q.garrison >= 0 && time - q.garrisonT > 90 && !this.threatened(q.garrison) && ((this.garrisonSurplus(q) && !this.garrisonShort(q.garrison, q)) || this.rearFlagQuiet(q.garrison))) {
        // The threat has passed and someone else holds the flag, or the front has moved on and the flag is deep in
        // our territory with nobody about: holding it is no longer a job, back to the squad's own initiative.
        q.garrison = -1; q.objectiveTime = -100;
        this.stats.garrisonsReleased++;
      }
      if (q.garrison < 0) {
        // A front-line flag nobody holds gets this squad if it is the obvious choice (not one already closing on its own objective).
        const f = this.garrisonFlag(q);
        const o = q.objective;
        // Committed: a free squad on its way to take an objective (still open to it, within reach). Only a flag that is
        // actually threatened pulls it off that attempt; a quiet garrison post waits for an uncommitted squad.
        const committed = q.order === Order.NONE && o !== null && o.owner !== this.team && bias[o.id] < 1e5 && (o.x - q.cx) ** 2 + (o.z - q.cz) ** 2 < 600 * 600;
        // Only where a garrison is actually short: a quiet front flag needs one squad, not everyone with nothing
        // better to do (parking every free squad there used to lock most of the infantry out of operations).
        if (f >= 0 && this.garrisonShort(f, q) && (committed ? this.threatened(f) : open === 0 || this.garrisonScore(f, q) > 0.9) &&
          this.squads.mayRetask(q, false, flags[f])) {
          q.garrison = f; q.garrisonT = time; q.assignWhy = committed ? `pulled off its attack to defend ${this.flagName(f)} (threatened)` : `garrison for ${this.flagName(f)}`;
        }
        else if (this.volunteer(q, time)) continue;
        else if ((open === 0 || (q.order === Order.HOLD && time - q.reserveT < 25)) && this.squads.mayRetask(q, false, null)) {
          // Reserve: nothing open to take and no garrison short of men. Wait at the nearest own flag, free for operations
          // (at least 25 s once there: an objective opening up for a moment is no reason to set off and turn back).
          if (q.order !== Order.HOLD) { q.reserveT = time; q.assignWhy = 'reserve: nothing open to attack'; }
          const h = q.order === Order.HOLD && q.objective && q.objective.owner === this.team ? q.objective.id : this.nearestOwned(q.cx, q.cz);
          if (h >= 0) { const hf = flags[h]; q.objective = hf; q.objectiveTime = time; this.setOrder(q, Order.HOLD, hf.x, hf.z, 40, this.threatYawAt(h, q)); }
          else q.order = Order.NONE;
          continue;
        } else if (open > 0) {
          if (q.order !== Order.NONE) q.assignWhy = 'initiative: an objective is open';
          // Initiative within the commander's priorities: the squad picks its own objective (squad-convoy chooseObjective).
          if (q.order !== Order.NONE) { q.order = Order.NONE; q.planTime = -100; q.objectiveTime = -100; }
          // Its objective was taken over by an operation or turned into a stronghold: choose again (unless already fighting there).
          if (o && bias[o.id] >= 1e5 && (o.x - q.cx) ** 2 + (o.z - q.cz) ** 2 > 150 * 150) q.objectiveTime = -100;
          continue;
        } else { q.order = Order.NONE; continue; }
      }
      const fl = flags[q.garrison];
      q.objective = fl; q.objectiveTime = time;
      // A fallen bridge next to this flag: its first garrison squad holds the bridgehead (its engineer rebuilds it).
      if (this.bridgeCrew(q, _p2)) { this.setOrder(q, Order.DEFEND, _p2[0], _p2[1], 10, this.threatYawAt(q.garrison, q)); continue; }
      this.setOrder(q, Order.DEFEND, fl.x, fl.z, 14, this.threatYawAt(q.garrison, q));
    }
  }

  /**
   * A free squad that knows of an operation close by which is short of force joins it on its own, as long
   * as it is eligible (not fighting, not regrouping, not mounted, not finishing its own capture) and the
   * operation has not started its final assault from the far side. One volunteer per operation every 20 s.
   */
  private volunteer(q: SquadBlackboard, time: number): boolean {
    for (const op of this.ops) {
      if (!op.active || op.nsq >= MAX_OP_SQUADS || op.phase > OpPhase.EXECUTE || op.purpose !== Purpose.CAPTURE || op.type === OpType.AIR_ASSAULT) continue;
      if (time - op.volunteerAt < 20 || this.opStrength(op) >= op.required) continue;
      const x = op.phase === OpPhase.ASSEMBLE && op.venue >= 0 ? op.venueX : op.phase <= OpPhase.PREP ? op.stageX : op.tx;
      const z = op.phase === OpPhase.ASSEMBLE && op.venue >= 0 ? op.venueZ : op.phase <= OpPhase.PREP ? op.stageZ : op.tz;
      if ((q.cx - x) ** 2 + (q.cz - z) ** 2 > 350 * 350 || !this.eligible(q, op, time)) continue;
      this.addSquad(op, q, Task.MAIN);
      op.volunteerAt = time;
      this.stats.volunteers++;
      this.log(`${this.flagName(op.flag)} (${OP_NAMES[op.type]}): a squad nearby joined on its own (${this.opStrength(op).toFixed(0)}/${op.required.toFixed(0)})`);
      return true;
    }
    return false;
  }

  /** Own flag with no enemy-held or neutral neighbour and no enemy reported near it. */
  private rearFlagQuiet(f: number): boolean {
    const flags = this.game.capture.flags, F = this.F;
    if (flags[f].base || this.enemyNear[f] >= 1 || flags[f].contestedBy >= 0) return false;
    for (let o = 0; o < F; o++) if (this.adj[f * F + o] && flags[o].owner !== this.team) return false;
    return true;
  }

  /**
   * Does flag f still need another garrison squad (q excluded)? A threatened flag needs to match what is
   * massing there (reinforce() handles that); a quiet front flag one squad; a quiet rear flag none.
   */
  private garrisonShort(f: number, q: SquadBlackboard): boolean {
    let have = 0;
    for (const o of this.squads.squads) if (o !== q && o.team === this.team && o.garrison === f && o.alive > 0) have += o.alive;
    return have < this.garrisonNeed(f);
  }

  /**
   * Soldiers flag f needs holding it: a threatened flag, a match for what is massing there; a quiet rear flag
   * none; a quiet front flag by how close the nearest hostile objective is (a full fire team when the enemy is
   * a few hundred metres off, a few men to keep watch when the front is far).
   */
  garrisonNeed(f: number): number {
    if (this.threatened(f)) return this.enemyNear[f] * 1.2 + 1;
    if (this.rearFlagQuiet(f)) return 0;
    const flags = this.game.capture.flags, fl = flags[f];
    let d = 1e9;
    for (const o of flags) if (o.owner !== this.team) d = Math.min(d, Math.hypot(o.x - fl.x, o.z - fl.z));
    return d < 300 ? 5 : d < 480 ? 4 : 3;
  }

  /** Another squad of ours also garrisons q's flag. */
  private garrisonSurplus(q: SquadBlackboard): boolean {
    for (const o of this.squads.squads) if (o !== q && o.team === this.team && o.garrison === q.garrison && o.alive >= 2) return true;
    return false;
  }

  /**
   * Priorities for squads on their own initiative, as metres added to a
   * flag's distance in their objective choice (≥ 1e5: leave it alone). Flags
   * an operation is dealing with, strongholds that need a deliberate attack,
   * recently failed targets and enemy flags deep behind their line are left
   * alone (no piecemeal attacks); neutral and weakly held front flags are
   * favoured, more so when we are behind; threatened own flags draw help.
   * @returns how many flags are open to initiative
   */
  private setBias(time: number): number {
    const bias = this.squads.objectiveBias[this.team], flags = this.game.capture.flags, F = this.F;
    let anyFront = false;
    for (let f = 0; f < F; f++) if (flags[f].owner !== this.team && !flags[f].base && this.bordersUs(f)) { anyFront = true; break; }
    const k = this.sit.behind ? 1.5 : 1;
    let open = 0;
    for (let f = 0; f < F; f++) {
      const fl = flags[f];
      if (fl.owner === this.team) { bias[f] = this.threatened(f) ? -200 : 0; continue; }
      let b: number;
      if (fl.base || this.opOnFlag(f)) b = 1e5;
      else if (this.enemyEst[f] > 4 || time < this.cooldown[f]) b = 1e5;
      else if (fl.owner === this.enemy && anyFront && !this.bordersUs(f)) b = 1e5;
      else b = (fl.owner < 0 ? -150 : -60) * k + this.enemyEst[f] * 60;
      bias[f] = b;
      if (b < 1e5) open++;
    }
    return open;
  }

  /** Is q the garrison squad that should hold the bridgehead of a destroyed bridge by its flag? Writes the spot. */
  private bridgeCrew(q: SquadBlackboard, out: Float32Array): boolean {
    const g = this.game as any, br = g.map.bridge;
    if (!br || !g.baseDefence || g.map.buildings[br.building].state === 0) return false;
    const fl = this.game.capture.flags[q.garrison];
    if (Math.hypot(fl.x - br.x, fl.z - br.z) > 200) return false;
    for (const o of this.squads.squads) if (o.team === this.team && o.garrison === q.garrison && o.alive > 0 && o.id < q.id) return false;
    return g.baseDefence.bridgeEnd(fl.x, fl.z, out);
  }

  private setOrder(q: SquadBlackboard, order: number, x: number, z: number, r: number, yaw: number): void {
    if (q.order !== order || (q.destX - x) ** 2 + (q.destZ - z) ** 2 > 16) q.planTime = -100;
    q.order = order; q.destX = x; q.destZ = z; q.destR = r; q.threatYaw = yaw;
  }

  /** Anyone still in the helicopter, on a rope or under a canopy? */
  private squadAboard(q: SquadBlackboard): boolean {
    for (let i = 0; i < q.count; i++) { const s = this.game.soldiers[q.members[i]]; if (s.alive && (s.vehicle || s.parachute || s.rappel)) return true; }
    return false;
  }

  /** Own flag needing a garrison most (front line, threat, base), spreading squads out. */
  private garrisonFlag(q: SquadBlackboard, onlyShort = false): number {
    const flags = this.game.capture.flags;
    let best = -1, bs = -1e9;
    for (let f = 0; f < this.F; f++) {
      if (flags[f].owner !== this.team || (onlyShort && !this.garrisonShort(f, q))) continue;
      if (!(this.game.nav as any).sameLandmass(q.cx, q.cz, flags[f].x, flags[f].z)) continue;
      const s = this.garrisonScore(f, q);
      if (s > bs) { bs = s; best = f; }
    }
    return best;
  }

  /** How much flag f needs squad q as a garrison: exposure (non-friendly neighbours), threat, base, minus squads already there. */
  private garrisonScore(f: number, q: SquadBlackboard): number {
    const flags = this.game.capture.flags, F = this.F, fl = flags[f];
    let front = 0;
    for (let o = 0; o < F; o++) if (this.adj[f * F + o] && flags[o].owner !== this.team) front++;
    let held = 0;
    for (const o of this.squads.squads) if (o !== q && o.team === this.team && (o.garrison === f || (o.order === Order.DEFEND && o.objective === fl))) held++;
    return front * 1.2 + this.enemyNear[f] * 0.4 + (fl.base ? (this.ownExposed() ? 2.5 : 0.5) : 0) - held * 1.6 - Math.hypot(fl.x - q.cx, fl.z - q.cz) / 400;
  }

  /** Direction a defender of flag f should face: known enemies near it, else the nearest non-friendly neighbour flag. */
  private threatYawAt(f: number, q: SquadBlackboard): number {
    const flags = this.game.capture.flags, fl = flags[f];
    if (q.contactCentroid(this.game.time, 20, _p2) > 0) return Math.atan2(_p2[0] - fl.x, _p2[1] - fl.z);
    let best = -1, bd = 1e12;
    for (let o = 0; o < this.F; o++) {
      if (o === f || flags[o].owner === this.team) continue;
      const d = (flags[o].x - fl.x) ** 2 + (flags[o].z - fl.z) ** 2 * (this.adj[f * this.F + o] ? 0.5 : 1);
      if (d < bd) { bd = d; best = o; }
    }
    return best >= 0 ? Math.atan2(flags[best].x - fl.x, flags[best].z - fl.z) : 0;
  }

  // ================================================================= vehicles (VehicleTasking)

  /**
   * Tasking of a vehicle committed to an operation, by its role there:
   * armour forms up at the venue with the infantry, supports by fire from the
   * line of departure and closes in behind the assault (PRESSURE: stays at
   * range; HUNT: goes after the asset); air defence and supply trucks stay
   * with the force on our side of the line. Armour outside operations
   * overwatches the most threatened own flag.
   */
  vehicleOrder(v: VehicleLike, man: VehicleManifest, time: number): boolean {
    const flags = this.game.capture.flags;
    const opId = this.vehOp[v.id];
    let op: Operation | null = null, role: number = VRole.ARMOUR;
    if (opId >= 0) for (const o of this.ops) if (o.active && o.id === opId) { op = o; break; }
    if (opId >= 0 && !op) this.vehOp[v.id] = -1;
    // Gone for repairs: released from the operation (it can be committed again once patched up).
    if (op && man.servicing) { this.dropVehicle(op, v.id); return false; }
    if (op) for (let i = 0; i < op.nveh; i++) if (op.vehicles[i] === v.id) { role = op.vrole[i]; break; }
    if (op && role !== VRole.ARMOUR) {
      const f = op.phase === OpPhase.ASSEMBLE && op.venue >= 0 ? op.venue : this.rearFlag(op);
      if (f < 0) return false;
      man.objective = flags[f]; man.objectiveTime = time; man.opPhase = op.phase;
      return true;
    }
    let f: number, fromYaw: number, minD: number, maxD: number, tgtX: number, tgtZ: number, key: number;
    if (op) {
      man.opPhase = op.phase;
      key = op.id * 8 + Math.min(op.phase, 4);
      if (op.type === OpType.HUNT) {
        f = op.flag; tgtX = op.tx; tgtZ = op.tz;
        fromYaw = Math.atan2(v.pos.x - op.tx, v.pos.z - op.tz); minD = 60; maxD = 120;
      } else if (op.type === OpType.PRESSURE) {
        f = op.flag; tgtX = flags[f].x; tgtZ = flags[f].z; fromYaw = op.mainYaw; minD = 95; maxD = 165;
      } else if (op.phase === OpPhase.ASSEMBLE && op.venue >= 0) {
        // Form up with the infantry at the venue, on the side facing the target.
        f = op.venue; tgtX = op.venueX; tgtZ = op.venueZ;
        fromYaw = Math.atan2(op.tx - op.venueX, op.tz - op.venueZ); minD = 25; maxD = 60;
      } else {
        f = op.flag;
        fromYaw = op.mainYaw;
        const close = op.phase === OpPhase.EXECUTE && time - op.phaseTime > 15;
        minD = close ? 45 : 85; maxD = close ? 75 : 150;
        // Captures need bodies inside the circle; a crew counts. Once the defence is light (or our infantry is
        // already in) and nobody has seen an enemy AT weapon near the flag, the armour drives onto the objective.
        if ((op.phase === OpPhase.EXECUTE || op.phase === OpPhase.CONSOLIDATE) && op.type !== OpType.SIEGE &&
          (this.enemyEst[f] <= 2 || flags[f].count[this.team] > 0) && !this.atNear(flags[f].x, flags[f].z, 130, time)) {
          man.objective = flags[f]; man.objectiveTime = time; man.opPhase = op.phase;
          man.fireX = flags[f].x + Math.sin(fromYaw) * 7; man.fireZ = flags[f].z + Math.cos(fromYaw) * 7; man.hasFire = true;
          this.fireAt[v.id] = time; this.fireFlag[v.id] = -9;
          return true;
        }
        // Siege: firing positions on the targeted HQ rather than the flagpole.
        tgtX = op.type === OpType.SIEGE && op.hq >= 0 ? op.tx : flags[f].x; tgtZ = op.type === OpType.SIEGE && op.hq >= 0 ? op.tz : flags[f].z;
      }
    } else {
      if (!ARMOUR[man.archetype]) return false;
      // Overwatch the most threatened own flag from behind it. Commitment: the flag it is already watching keeps
      // it unless another needs it clearly more (a fluctuating enemy estimate is no reason to drive across the map).
      let best = -1, bs = -1e9;
      const cur = this.watchFlag[v.id];
      for (let i = 0; i < this.F; i++) {
        // Own base: only when the enemy is actually there (armour parked in the base aisle watching nothing blocked the park).
        if (flags[i].owner !== this.team || (flags[i].base && this.enemyNear[i] < 1)) continue;
        const s = this.enemyNear[i] + this.value[i] - Math.hypot(flags[i].x - v.pos.x, flags[i].z - v.pos.z) / 300 + (i === cur ? 1.5 : 0);
        if (s > bs) { bs = s; best = i; }
      }
      if (best < 0) return false;
      if (best !== cur) { if (cur >= 0) this.stats.watchChanges++; this.watchFlag[v.id] = best; this.vehWhy[v.id] = cur >= 0 && flags[cur].owner !== this.team ? 'watched flag lost' : cur >= 0 ? `${this.flagName(best)} more threatened` : 'overwatch'; }
      f = best; tgtX = flags[f].x; tgtZ = flags[f].z;
      fromYaw = this.threatYawAt(f, this.squads.squads[0]) + Math.PI;
      minD = 50; maxD = 95;
      man.opPhase = OpPhase.CONSOLIDATE;
      key = -2 - f;
    }
    const fl = flags[f];
    man.objective = fl; man.objectiveTime = time;
    const busy = op && (op.phase === OpPhase.EXECUTE || op.type === OpType.HUNT);
    // A firing position is kept while it works: a new one is picked for a new task, when the crew has seen nothing
    // to shoot for a while from it (busy: 15 s, else 60 s), or when it is taking hits; not on a fixed timer.
    const crewSaw = this.crewSawRecently(v, time, busy ? 15 : 60);
    const hit = v.health < this.fireHp[v.id] - v.def.health * 0.08;
    const stale = time - this.fireAt[v.id] > (busy ? 15 : 60) && !crewSaw;
    if (this.fireFlag[v.id] !== key || stale || hit) {
      if (this.fireFlag[v.id] === key) { this.stats.firePosMoves++; this.vehWhy[v.id] = hit ? 'firing position under fire: moving' : 'nothing to shoot from there: moving'; }
      this.fireHp[v.id] = v.health;
      // Known enemy anti-tank positions to keep away from.
      let n = 0;
      for (const q of this.squads.squads) {
        if (q.team !== this.team) continue;
        for (let k = 0; k < q.cTarget.length && n < AT_X.length; k++) {
          const t = q.cTarget[k];
          if (t < 0 || t >= this.S || time - q.cT[k] > 30) continue;
          const s = this.game.soldiers[t];
          if (s.alive && s.launcher) { AT_X[n] = q.cX[k]; AT_Z[n] = q.cZ[k]; n++; }
        }
      }
      // Firing positions already handed to other vehicles of this side.
      let tn = 0;
      for (let i = 0; i < this.fireX.length && tn < TAKEN_X.length; i++) {
        if (i === v.id || this.fireFlag[i] === -1 || this.game.time - this.fireAt[i] > 40) continue;
        TAKEN_X[tn] = this.fireX[i]; TAKEN_Z[tn] = this.fireZ[i]; tn++;
      }
      if (pickFiringPosition(this.game, this.foliage, tgtX, tgtZ, fromYaw, minD, maxD, v.pos.x, v.pos.z, AT_X, AT_Z, n, v.id, _p2, TAKEN_X, TAKEN_Z, tn)) {
        this.fireX[v.id] = _p2[0]; this.fireZ[v.id] = _p2[1];
      } else {
        this.fireX[v.id] = tgtX + Math.sin(fromYaw) * minD; this.fireZ[v.id] = tgtZ + Math.cos(fromYaw) * minD;
      }
      this.fireAt[v.id] = time; this.fireFlag[v.id] = key;
    }
    man.fireX = this.fireX[v.id]; man.fireZ = this.fireZ[v.id];
    man.hasFire = true;
    return true;
  }

  private dropVehicle(op: Operation, id: number): void {
    for (let i = 0; i < op.nveh; i++) {
      if (op.vehicles[i] !== id) continue;
      for (let k = i; k < op.nveh - 1; k++) { op.vehicles[k] = op.vehicles[k + 1]; op.vrole[k] = op.vrole[k + 1]; }
      op.nveh--;
      break;
    }
    this.vehOp[id] = -1;
    this.log(`${this.flagName(op.flag)} (${OP_NAMES[op.type]}): ${this.game.vehicles.list[id].def.label} released for repairs`);
  }

  /** An enemy soldier with an AT launcher reported within r of (x, z) in the last 40 s. */
  private atNear(x: number, z: number, r: number, time: number): boolean {
    for (const q of this.squads.squads) {
      if (q.team !== this.team) continue;
      for (let k = 0; k < q.cTarget.length; k++) {
        const t = q.cTarget[k];
        if (t < 0 || t >= this.S || time - q.cT[k] > 40) continue;
        const s = this.game.soldiers[t];
        if (s.alive && s.launcher && (q.cX[k] - x) ** 2 + (q.cZ[k] - z) ** 2 < r * r) return true;
      }
    }
    return false;
  }

  /** Our flag behind an operation's line of departure (venue if still ours, else the nearest owned flag). */
  private rearFlag(op: Operation): number {
    if (op.venue >= 0 && this.game.capture.flags[op.venue].owner === this.team) return op.venue;
    return this.nearestOwned(op.stageX || op.tx, op.stageZ || op.tz);
  }

  /** The operation a squad belongs to and its part in it, from the commander's records ('' if none). */
  squadRole(q: SquadBlackboard): string {
    if (q.opId < 0) return '';
    for (const op of this.ops) {
      if (!op.active || op.id !== q.opId) continue;
      let task = 'main effort';
      for (let i = 0; i < op.nsq; i++) if (op.squads[i] === q.id) task = ['main effort', 'flanking', 'support by fire', 'air element'][op.task[i]];
      return `op ${op.id} ${PURPOSE_NAMES[op.purpose]} ${this.flagName(op.flag)} by ${OP_NAMES[op.type]}, ${PHASE_NAMES[op.phase]}; ${task}. Why: ${op.reason}`;
    }
    return `op ${q.opId} (closed)`;
  }

  /** Why a squad outside operations does what it does (garrison, regroup, initiative), from the same data the orders use. */
  squadWhy(q: SquadBlackboard): string {
    const flags = this.game.capture.flags, time = this.game.time;
    if (q.opId >= 0) return this.squadRole(q);
    if (q.garrison >= 0) {
      const f = q.garrison;
      const kind = this.threatened(f) ? `threatened (~${this.enemyNear[f].toFixed(0)} enemies near)` : this.rearFlagQuiet(f) ? 'quiet rear flag (released after 90 s)' : 'front-line flag';
      return `garrison of ${flags[f].name}: ${kind}${q.defensive ? ', defensive squad' : ''}, held ${(time - q.garrisonT).toFixed(0)} s`;
    }
    if (time < q.recoverUntil) return `regrouping ${(q.recoverUntil - time).toFixed(0)} s more after the operation on ${q.lastOpTarget >= 0 ? flags[q.lastOpTarget].name : '?'} ended`;
    if (q.objective) {
      const b = this.squads.objectiveBias[this.team][q.objective.id];
      return `own initiative toward ${q.objective.name} (${q.objective.owner === this.team ? 'ours' : q.objective.owner < 0 ? 'neutral' : 'enemy'}, priority bias ${b >= 1e5 ? 'excluded' : b.toFixed(0) + ' m'})`;
    }
    return 'no task (no open objective, no garrison needed)';
  }

  /** A vehicle's role in an operation, if any. */
  /** Did any of the vehicle's crew see an enemy within the last `s` seconds? */
  private crewSawRecently(v: VehicleLike, time: number, s: number): boolean {
    for (let i = 0; i < v.seats.length; i++) { const o = v.seats[i]; const a = o && o.ai; if (a && a.lastSeenTime > 0 && time - a.lastSeenTime < s) return true; }
    return false;
  }

  /** Operation the vehicle is assigned to, or -1. */
  vehicleOpId(id: number): number { return this.vehOp[id]; }

  vehicleRole(id: number): string {
    const opId = this.vehOp[id];
    if (opId < 0) return '';
    for (const op of this.ops) {
      if (!op.active || op.id !== opId) continue;
      for (let i = 0; i < op.nveh; i++) if (op.vehicles[i] === id) return `${VROLE_NAMES[op.vrole[i]]} for op ${op.id} ${OP_NAMES[op.type]} ${this.flagName(op.flag)} (${PHASE_NAMES[op.phase]})`;
    }
    return '';
  }

  /**
   * Minimap zones straight from the live operation records: where each operation is forming up, its
   * line of departure, and its objective (or the asset a WEAKEN operation is after). kind: 0 assembly,
   * 1 line of departure, 2 objective. Nothing is drawn for squads that merely stand together.
   */
  zones(out: { id: number; purpose: number; kind: number; x: number; z: number; r: number }[]): void {
    out.length = 0;
    const flags = this.game.capture.flags;
    for (const op of this.ops) {
      if (!op.active) continue;
      if (op.phase === OpPhase.ASSEMBLE && op.major) out.push({ id: op.id, purpose: op.purpose, kind: 0, x: op.venue >= 0 ? op.venueX : op.stageX, z: op.venue >= 0 ? op.venueZ : op.stageZ, r: op.venue >= 0 ? 70 : 45 });
      if (op.major && (op.phase === OpPhase.MOVE_UP || op.phase === OpPhase.PREP)) out.push({ id: op.id, purpose: op.purpose, kind: 1, x: op.stageX, z: op.stageZ, r: 45 });
      const weaken = op.purpose === Purpose.WEAKEN;
      out.push({ id: op.id, purpose: op.purpose, kind: 2, x: weaken ? op.tx : flags[op.flag].x, z: weaken ? op.tz : flags[op.flag].z, r: weaken ? 40 : 34 });
    }
  }

  /**
   * Garrison allocation by the reason that keeps it there: soldiers holding threatened flags, quiet front
   * flags (bordering enemy or neutral ground), quiet rear flags; and how many of those are 'defensive'
   * squads (a quarter of the army is raised to hold ground) vs squads sent there.
   */
  garrisonSummary(): { threatened: number; front: number; rear: number; defensive: number; soldiers: number; flags: string } {
    const r = { threatened: 0, front: 0, rear: 0, defensive: 0, soldiers: 0, flags: '' };
    const per = new Map<number, number>();
    for (const q of this.squads.squads) {
      if (q.team !== this.team || q.garrison < 0 || q.opId >= 0 || q.alive === 0) continue;
      const f = q.garrison;
      if (this.threatened(f)) r.threatened += q.alive; else if (this.rearFlagQuiet(f)) r.rear += q.alive; else r.front += q.alive;
      if (q.defensive) r.defensive += q.alive;
      r.soldiers += q.alive;
      per.set(f, (per.get(f) || 0) + q.alive);
    }
    r.flags = [...per.entries()].map(([f, n]) => `${this.flagName(f)} ${n}${this.threatened(f) ? '!' : this.rearFlagQuiet(f) ? '(rear)' : ''}`).join(', ');
    return r;
  }

  /** Lines for the operations panel: each live operation and the last outcomes. */
  opsPanel(): string {
    const time = this.game.time, L: string[] = [];
    for (const op of this.ops) {
      if (!op.active) continue;
      const pct = Math.round((op.phase === OpPhase.ASSEMBLE ? op.readiness : op.progressPct) * 100);
      L.push(`#${op.id} ${PURPOSE_NAMES[op.purpose]} ${this.flagName(op.flag)} · ${OP_NAMES[op.type]} · ${PHASE_NAMES[op.phase]} ${pct}% · ${op.nsq} squads ${this.opStrength(op).toFixed(0)}/${op.required.toFixed(0)}${op.nveh ? ` · ${op.nveh} veh` : ''} · ${(time - op.start).toFixed(0)}s`);
    }
    if (!L.length) L.push('No operations running (routine garrisons and initiative only).');
    for (let i = Math.max(0, this.journal.length - 3); i < this.journal.length; i++) {
      const j = this.journal[i];
      // Outcome with its diagnosis (the facts are shortened first so the diagnosis stays readable).
      if (/DONE|FAILED|CANCELLED/.test(j)) { const d = j.indexOf('Diagnosis:'); L.push('· ' + (d > 0 ? j.slice(0, Math.min(d, 90)) + '… ' + j.slice(d) : j).slice(0, 230)); }
    }
    return L.join('\n');
  }

  /** One-line-per-op summary (reports). */
  summary(): string {
    const side = this.team === 0 ? 'P' : 'T';
    const parts: string[] = [];
    for (const op of this.ops) {
      if (!op.active) continue;
      parts.push(`${PURPOSE_NAMES[op.purpose]}/${OP_NAMES[op.type]} ${this.flagName(op.flag)} [${PHASE_NAMES[op.phase]}] ${op.nsq}sq ${this.opStrength(op).toFixed(0)}/${op.required.toFixed(0)}`);
    }
    return `${side}: ${parts.length ? parts.join(' | ') : 'no operations'}`;
  }

  /**
   * Debug overlay block: priorities, the last decision, each operation (why,
   * venue, readiness / progress, squads and vehicles), squads regrouping or
   * awaiting a task, transports and their passengers, and the latest outcomes.
   */
  debugText(): string {
    const time = this.game.time, flags = this.game.capture.flags, list = this.game.vehicles.list;
    const side = this.team === 0 ? 'PAMPALONA' : 'TORSA', st = this.stats;
    const out: string[] = [];
    out.push(`== ${side}  ops ${this.activeOps()}  bar ${this.threshold.toFixed(2)}  planned ${st.planned} ok ${st.succeeded} fail ${st.failed} cxl ${st.cancelled} declined ${st.declined}`);
    const fc = Object.entries(st.failCauses).map(([k, n]) => `${k} ${n}`).join(', ');
    if (fc) out.push(` failures: ${fc} (execution ${st.executionFailures}, judgement ${st.decisionFailures}); garrisons released ${st.garrisonsReleased}, volunteers ${st.volunteers}`);
    for (let i = 0; i < Math.min(3, this.priorities.length); i++) out.push(` ${i + 1}. ${this.priorities[i]}`);
    out.push(` > ${this.lastDecision}`);
    for (const op of this.ops) {
      if (!op.active) continue;
      const pct = (op.phase === OpPhase.ASSEMBLE ? op.readiness : op.progressPct) * 100;
      out.push(` [${op.id}] ${PURPOSE_NAMES[op.purpose]} ${this.flagName(op.flag)} by ${OP_NAMES[op.type]} (${MEDIUM_NAMES[op.medium]}${op.major ? ', major' : ''}) ` +
        `${PHASE_NAMES[op.phase]} ${op.phase === OpPhase.ASSEMBLE ? 'ready' : 'progress'} ${pct.toFixed(0)}%  ${(time - op.start).toFixed(0)}s`);
      out.push(`     why: ${op.reason}`);
      if (op.major) out.push(`     venue: ${op.venueWhy}${op.staged ? `, ${op.staged} squads staged` : ''}`);
      let vs = '';
      for (let i = 0; i < op.nveh; i++) { const v = list[op.vehicles[i]]; if (v.alive) vs += `${vs ? ', ' : ''}${v.def.label} (${VROLE_NAMES[op.vrole[i]]})`; }
      out.push(`     force ${this.opStrength(op).toFixed(0)}/${op.required.toFixed(0)}: ${op.nsq} squads${vs ? `; ${vs}` : '; no vehicles'}`);
    }
    let regroup = 0, initiative = 0, garrison = 0, idle = 0;
    for (const q of this.squads.squads) {
      if (q.team !== this.team || q.kind !== SquadKind.INFANTRY || q.alive === 0 || q.opId >= 0) continue;
      if (q.garrison >= 0) garrison++;
      else if (time < q.recoverUntil) regroup++;
      else if (q.order === Order.NONE && q.objective && q.objective.owner !== this.team) initiative++;
      else idle++;
    }
    out.push(` squads: ${garrison} garrison, ${initiative} on initiative, ${regroup} regrouping, ${idle} awaiting a task`);
    const gs = this.garrisonSummary();
    if (gs.soldiers) out.push(` garrisons ${gs.soldiers} soldiers (threatened ${gs.threatened}, front ${gs.front}, rear ${gs.rear}; defensive squads ${gs.defensive}): ${gs.flags}`);
    let tr = '';
    for (let i = 0; i < list.length; i++) {
      const v = list[i], m = this.orch.manifests[i];
      if (!v.alive || v.team !== this.team || m.squadId < 0) continue;
      const q = this.squads.squads[m.squadId], dest = q.objective ? q.objective.name : '?';
      tr += `${tr ? ', ' : ''}${v.def.label}→${dest} (${m.reserved} aboard/booked)`;
    }
    if (tr) out.push(` transport: ${tr}`);
    for (let i = Math.max(0, this.opLog.length - 2); i < this.opLog.length; i++) out.push(`   ${this.opLog[i]}`);
    void flags;
    return out.join('\n');
  }
}

const IDS_SCRATCH = new Int32Array(64);
