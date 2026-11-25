// @ts-ignore -- plain JS module
import { inCaptureVolume } from '../world/flag-volume.js';
import { ASSAULT_RING, GateCandidate, GateContext, GateResult, evaluatePurposeGate } from './purpose-gate.ts';
import { Deliberation, Domain } from './deliberation.ts';
import { AgentStateBuffers } from './agent-state.ts';
import { TacticalRadioBus } from './radio-bus.ts';
import { CoverField, FoliageField } from './terrain-analysis.ts';
import { PosMode, PositionPlan, planSquadPositions } from './positions.ts';
import {
  AI_TUNING, Archetype, ARCHETYPE_OF, Formation, Logistics, MsgState, ORDER_NAMES, Order, Posture, RadioType, SoldierClass, clamp01, hash01,
} from './types.ts';
import type { AgentLike, FlagLike, GameLike, SoldierLike, VehicleLike } from './types.ts';

const MAX_MEMBERS = 8;
const MAX_CONTACTS = 12;
/** Breadcrumb trail length (points ~3 m apart). */
const TRAIL = 128;
/** Largest column the manager assembles. */
const MAX_CONVOY = 6;
/** Trips at least this long (m) are worth travelling in convoy. */
const CONVOY_TRIP = 350;
/** Vehicles setting out within this many seconds of each other may form a convoy. */
const DEPART_WINDOW = 20;
/** A partner on the same job that set out up to this long ago, still near its start, can still be paired with. */
const LATE_WINDOW = 45;
/** Longest a convoy waits at its rally point for late members (s). */
const ASSEMBLE_MAX = 40;
export const SquadKind = { INFANTRY: 0, CREW: 1 } as const;

/** Shared tactical picture of one fire team. */
/** A squad's support request and its fate (see SquadBlackboard.req). */
export interface SupportReq { msg: any; id: number; state: string; why: string; t: number }
/** Help already asked for and not yet answered either way: no new request on top of it. */
const pending = (r: SupportReq) => r.state === 'requested' || r.state === 'accepted';

export class SquadBlackboard {
  readonly id: number;
  readonly team: number;
  readonly kind: number;
  readonly members = new Int32Array(MAX_MEMBERS).fill(-1);
  count = 0;
  leader = -1;
  objective: FlagLike | null = null;
  objectiveTime = -100;
  defensive = false;
  posture: number = Posture.ASSAULT;
  postureTime = 0;
  rallyX = 0; rallyZ = 0;
  /** Alive, dismounted centroid and heading toward the objective. */
  cx = 0; cz = 0; heading = 0; alive = 0; dismounted = 0;
  // Contacts (known enemies): target index, last known position, time, threat weight.
  readonly cTarget = new Int32Array(MAX_CONTACTS).fill(-1);
  readonly cX = new Float32Array(MAX_CONTACTS);
  readonly cY = new Float32Array(MAX_CONTACTS);
  readonly cZ = new Float32Array(MAX_CONTACTS);
  readonly cT = new Float32Array(MAX_CONTACTS);
  readonly cThreat = new Float32Array(MAX_CONTACTS);
  // Bounding overwatch / flanking.
  boundTeam = 0; boundUntil = 0;
  flankTeam = 1; flankX = 0; flankZ = 0; flankUntil = 0;
  /** Vehicle id the squad is mounted in / boarding (-1 none). */
  vehicle = -1;
  suppressionAvg = 0; ammoAvg = 1;
  nextFireMission = 0; nextCas = 0; nextLogistics = 0; nextExtract = 0; nextSmoke = 0;
  // --- Commander tasking (src/ai/commander.ts) ---
  /** Operation this squad belongs to (-1 none) and its order. */
  opId = -1;
  order: number = Order.NONE;
  /** Where the order wants the squad (assembly area, attack position, support-by-fire position, flag). */
  destX = 0; destZ = 0; destR = 20;
  /** Direction the squad should face / expects the enemy from. */
  threatYaw = 0;
  /** Attack axis waypoint, reached before closing on the flag (multi-axis assaults). */
  axisX = 0; axisZ = 0; axisDone = true;
  /** Flag held as a garrison (-1 none). */
  garrison = -1;
  /** After a failed / cancelled operation: regroup at (recoverX, recoverZ) until this time; the target it failed on and when. */
  recoverUntil = 0; recoverX = 0; recoverZ = 0;
  lastOpTarget = -1; lastOpEnd = -1e3;
  /** Operation it reached the staging venue for (-1 none). */
  stagedFor = -1;
  /** A carrier this squad failed to board (it left or never got going) and until when to leave it alone. */
  noRideV = -1; noRideUntil = 0;
  /** Leader could not reach the squad's destination (last time, and how many separate times). */
  navFailT = -1e3; navFails = 0;
  /** Its carrier got stuck or the trip was interrupted (last time). */
  transportFailT = -1e3;
  /** Walk, do not ride, until this time (the commander learned transport fails toward its target). */
  noLiftUntil = 0;
  /**
   * Its transport (vehicle id, -1 none) and what the squad knows about it: 'none' | 'boarding' | 'riding' |
   * 'escort' | 'standby' | 'pickup' | 'released' | 'lost', with the reason and time of the last change.
   */
  transport = -1; transportState = 'none'; transportWhy = ''; transportT = 0;
  /** Extraction: 'none' | 'requested' | 'coming' | 'denied' | 'done', the radio ticket and its id. */
  extractState = 'none'; extractMsg: any = null; extractMsgId = 0; extractT = 0;
  /** Cohesion: the leader is waiting for stragglers since (0 = not), may not wait again before; where they are. */
  waitSince = 0; waitCool = 0; lagX = 0; lagZ = 0;
  /** Why the squad has its current assignment (commander / initiative), and when it went into reserve. */
  assignWhy = ''; reserveT = -1e3;
  /** Since when it has had its current objective (whatever re-confirmed it in between). */
  objSince = 0; lastObj: FlagLike | null = null;
  /** What the squad as a whole is doing right now (see updateIntent), and since when. */
  intent = 'idle'; intentT = 0;
  /**
   * Capture state toward a flag it is to take: 'approaching' | 'final assault' | 'pinned' | 'in the circle' |
   * 'capturing' | 'defending' | 'none'; why it is pinned; until when a final assault is on; progress tracking.
   */
  /** Trace of the squad's last deliberated decision (Q1–Q6), for the debug overlay. */
  decisionWhy = '';
  capState = 'none'; capWhy = ''; assaultUntil = 0; capBestD = 1e9; capBestT = 0; capFlag = -1; pinnedT = 0;
  /** Suppress-and-bound until (squad decision near a flag) and whether its covering team still has to pop smoke. */
  sbUntil = 0; sbSmoke = false;
  /** Threat memory around the objective: flag, remembered peak of defenders, when updated. */
  memFlag = -1; memPeak = 0; memT = 0;
  /** Last drop from a vehicle: when, the rally point beside the vehicle, and the vehicle (post-dismount regroup). */
  dropT = -1e9; dropX = 0; dropZ = 0; dropV = -1; dropGathered = false;
  /** Last objective changes: "t s: OLD → NEW (why)". */
  readonly changes: string[] = [];
  /**
   * The squad's own support requests (0 fire mission, 1 CAS, 2 resupply) and what became of them, so the
   * squad knows whether help is coming: requested / accepted (with the provider's progress) / done /
   * denied (with the reason) / failed (accepted, then not carried out) / unanswered.
   */
  req: SupportReq[] = [0, 1, 2].map(() => ({ msg: null, id: 0, state: 'none', why: '', t: 0 }));
  /** When the current garrison post was taken (a garrison is not given up again straight away). */
  garrisonT = -1e3;
  /** Fighting positions for the members (by member index) and when / where they were planned. */
  readonly plan = new PositionPlan();
  planX = 1e9; planZ = 1e9; planMode = -1; planTime = -100; planYaw = 0;
  /** Movement progress check (stuck detection while advancing). */
  progX = 0; progZ = 0; progT = 0;

  constructor(id: number, team: number, kind: number) { this.id = id; this.team = team; this.kind = kind; }

  addMember(soldierId: number): boolean {
    if (this.count >= MAX_MEMBERS) return false;
    this.members[this.count++] = soldierId;
    return true;
  }

  removeMember(soldierId: number): void {
    for (let i = 0; i < this.count; i++) {
      if (this.members[i] !== soldierId) continue;
      this.members[i] = this.members[--this.count];
      this.members[this.count] = -1;
      return;
    }
  }

  /** Records / refreshes a contact. */
  addContact(target: number, x: number, y: number, z: number, time: number, threat: number): void {
    let slot = -1, oldest = 0, oldestT = 1e9;
    for (let i = 0; i < MAX_CONTACTS; i++) {
      if (this.cTarget[i] === target) { slot = i; break; }
      if (this.cTarget[i] < 0) { if (oldestT > -1) { oldest = i; oldestT = -1; } continue; }
      if (this.cT[i] < oldestT) { oldestT = this.cT[i]; oldest = i; }
    }
    if (slot < 0) slot = oldest;
    this.cTarget[slot] = target; this.cX[slot] = x; this.cY[slot] = y; this.cZ[slot] = z; this.cT[slot] = time;
    this.cThreat[slot] = threat;
  }

  forgetContact(target: number): void {
    for (let i = 0; i < MAX_CONTACTS; i++) if (this.cTarget[i] === target) this.cTarget[i] = -1;
  }

  /** Number of contacts younger than `maxAge`; writes their weighted centroid to out. */
  contactCentroid(time: number, maxAge: number, out: Float32Array): number {
    let n = 0, sx = 0, sz = 0, sw = 0;
    for (let i = 0; i < MAX_CONTACTS; i++) {
      if (this.cTarget[i] < 0 || time - this.cT[i] > maxAge) continue;
      const w = this.cThreat[i];
      sx += this.cX[i] * w; sz += this.cZ[i] * w; sw += w; n++;
    }
    if (sw > 0) { out[0] = sx / sw; out[1] = sz / sw; }
    return n;
  }

  clearTransient(): void {
    this.cTarget.fill(-1);
    this.posture = Posture.ASSAULT; this.vehicle = -1; this.objective = null; this.objectiveTime = -100;
    this.opId = -1; this.order = Order.NONE; this.garrison = -1; this.axisDone = true; this.planTime = -100; this.planMode = -1;
    this.recoverUntil = 0; this.lastOpTarget = -1; this.lastOpEnd = -1e3; this.stagedFor = -1; this.noRideV = -1; this.noRideUntil = 0; this.garrisonT = -1e3; this.navFailT = -1e3; this.transportFailT = -1e3; this.noLiftUntil = 0;
    this.transport = -1; this.transportState = 'none'; this.transportWhy = ''; this.extractState = 'none'; this.extractMsg = null;
    for (const r of this.req) { r.msg = null; r.state = 'none'; r.why = ''; }
  }
}

/** A road column of ground vehicles that shares a destination. */
export class ConvoyGroup {
  readonly id: number;
  team = 0;
  active = false;
  readonly vehicles = new Int32Array(8).fill(-1);
  count = 0;
  formation: number = Formation.COLUMN;
  formationUntil = 0;
  destX = 0; destZ = 0;
  /** Evaluation: when it formed, how far its leader has travelled with it, why the last member left. */
  formedT = 0; travel = 0; lastLX = NaN; lastLZ = 0; lastLeave = '';
  contactUntil = 0;
  drillDone = false;
  speedCap = 0;
  /** Planned convoy: why it formed, where it forms up, and whether it is still forming up or on the move. */
  purpose = '';
  destName = '';
  state: 'assembling' | 'moving' | 'halted' = 'moving';
  /** Legs travelled together so far, and when the column halted at the end of the current one. */
  legs = 0; haltT = 0; haltS = 25;
  /** A stopover on the way (a friendly flag near the route): the column halts there, then carries on. */
  via = false; viaX = 0; viaZ = 0; viaHalt = false;
  rallyX = 0; rallyZ = 0;
  /** Members that were ever part of it (evaluation) and when it moved off. */
  joined = 0; departT = 0;
  /** Leader waiting for the tail since (0 = not waiting); leader's own task pointing elsewhere since. */
  waitT = 0; leadDivT = 0;
  /** Largest gap between consecutive members while moving (evaluation). */
  maxGap = 0;
  /** Breadcrumb trail of the leader's actual track (ring buffer, newest at trailHead). */
  readonly trailX = new Float32Array(TRAIL);
  readonly trailZ = new Float32Array(TRAIL);
  trailHead = 0;
  trailCount = 0;
  leaderId = -1;
  constructor(id: number) { this.id = id; }

  /** Records the leader's position every few metres; restarts when the leader changes. */
  record(leaderId: number, x: number, z: number): void {
    if (leaderId !== this.leaderId) { this.leaderId = leaderId; this.trailCount = 0; }
    if (this.trailCount > 0) {
      const h = this.trailHead;
      if ((this.trailX[h] - x) ** 2 + (this.trailZ[h] - z) ** 2 < 9) return;
    }
    this.trailHead = (this.trailHead + 1) % TRAIL;
    this.trailX[this.trailHead] = x; this.trailZ[this.trailHead] = z;
    if (this.trailCount < TRAIL) this.trailCount++;
  }

  /**
   * How far back along the leader's recorded track (from the leader at lx, lz) the point (x, z) lies, or -1 when
   * it is not on the track (more than 15 m off it).
   */
  trailDistOf(lx: number, lz: number, x: number, z: number): number {
    let px = lx, pz = lz, acc = 0, best = 15 * 15, at = -1;
    for (let k = 0; k < this.trailCount; k++) {
      const i = (this.trailHead - k + TRAIL) % TRAIL;
      const qx = this.trailX[i], qz = this.trailZ[i], sx = qx - px, sz = qz - pz, l2 = sx * sx + sz * sz;
      const t = l2 > 1e-6 ? Math.max(0, Math.min(1, ((x - px) * sx + (z - pz) * sz) / l2)) : 0;
      const ex = px + sx * t - x, ez = pz + sz * t - z, d2 = ex * ex + ez * ez;
      if (d2 < best) { best = d2; at = acc + Math.sqrt(l2) * t; }
      acc += Math.sqrt(l2); px = qx; pz = qz;
    }
    return at;
  }

  /** Point `dist` metres back along the leader's track from (lx, lz); false if the trail is shorter. */
  trailPoint(lx: number, lz: number, dist: number, out: Float32Array): boolean {
    let px = lx, pz = lz, acc = 0;
    for (let k = 0; k < this.trailCount; k++) {
      const i = (this.trailHead - k + TRAIL) % TRAIL;
      const qx = this.trailX[i], qz = this.trailZ[i];
      const seg = Math.hypot(qx - px, qz - pz);
      if (seg > 1e-3 && acc + seg >= dist) {
        const t = (dist - acc) / seg;
        out[0] = px + (qx - px) * t; out[1] = pz + (qz - pz) * t;
        return true;
      }
      acc += seg; px = qx; pz = qz;
    }
    return false;
  }
}

/**
 * Where a squad should be right now: its order's destination (attack axis
 * first during an ATTACK), or its own objective flag when not under orders.
 * @returns arrival radius, or -1 when the squad has nowhere to go
 */
export function squadGoal(q: SquadBlackboard, out: Float32Array): number {
  if (q.order === Order.NONE) {
    if (!q.objective) return -1;
    out[0] = q.objective.x; out[1] = q.objective.z; return 14;
  }
  if (q.order === Order.ATTACK && !q.axisDone) { out[0] = q.axisX; out[1] = q.axisZ; return 20; }
  out[0] = q.destX; out[1] = q.destZ; return q.destR;
}

const CLS = new Uint8Array(MAX_MEMBERS);
const MX = new Float32Array(MAX_MEMBERS), MZ = new Float32Array(MAX_MEMBERS);

/** Hooks into the vehicle orchestrator used by convoy drills (avoids an import cycle). */
export interface ConvoyHooks {
  /** Why this vehicle is making its trip (operation, troop lift, move-up...): the convoy's stated purpose. */
  purpose(v: VehicleLike): string;
  /** Key shared by vehicles on the same job (operation / objective / trip home), -1 for none. */
  taskKey(v: VehicleLike): number;
  popSmoke(v: VehicleLike): void;
  dismountPassengers(v: VehicleLike): number;
  scanSky(v: VehicleLike): void;
  /** Q5 for support requests: 0..1, how much of a support kind the side has ready (0 artillery, 1 CAS, 2 airlift, 3 ground transport). */
  supportOn(team: number, kind: number): number;
}

/** Convoy order: vanguard → main body → air umbrella → logistics. */
const ROLE_RANK = new Float32Array([0, 0, 0.5, 1, 1, 3, 3, 9, 9, 2.5, 2, 9, 9, 9, 9, 9]);
const CLASS_LEAD_ORDER = [SoldierClass.LEADER, SoldierClass.SPOTTER, SoldierClass.RIFLEMAN, SoldierClass.SUPPORT, SoldierClass.AT, SoldierClass.CREWMAN, SoldierClass.PILOT];

const _c2 = new Float32Array(2);
const _g2 = new Float32Array(2);
const CONVOY_KEYS = new Float32Array(8);

/**
 * Real-time squad and convoy formation:
 * - squads formed at spawn from class templates; leaders re-elected; broken
 *   squads merged into nearby fire teams; objectives chosen and spread;
 *   posture switches (assault / bounding overwatch / flank / regroup / hold);
 *   squads raise fire missions, CAS, logistics and extraction requests.
 * - convoys assembled from ground vehicles sharing a corridor, ordered by role,
 *   speed-matched in column, switching to wedge with an ambush drill on contact.
 */
export class SquadAndConvoyManager {
  readonly squads: SquadBlackboard[] = [];
  readonly convoys: ConvoyGroup[] = [];
  /** Convoy id per vehicle (-1 none). */
  readonly convoyOf: Int32Array;
  /** Per vehicle: destination of its current trip, and when it set out on a long one (convoy planning). */
  private readonly tripX: Float32Array;
  private readonly tripZ: Float32Array;
  private readonly departAt: Float32Array;
  /** Where each vehicle was when it set out on its current trip. */
  private readonly depX: Float32Array;
  private readonly oppSeen: Uint8Array;
  private readonly depZ: Float32Array;
  /** Per vehicle: its own controller's goal and hold (before the convoy overrides them), since when that goal
   * has pointed away from the convoy's destination, and a convoy it may rejoin (after a separation) until when. */
  private readonly ownX: Float32Array; private readonly ownZ: Float32Array; private readonly ownHold: Uint8Array;
  private readonly divT: Float32Array; private readonly pendConv: Int32Array; private readonly pendUntil: Float32Array;
  private readonly funnelSeen: Float32Array; private readonly whyAlone: string[];
  /** Per vehicle: since when it has trailed its predecessor by more than 4 intervals (0 = keeping up). */
  readonly lagSince: Float32Array;
  /** Per vehicle: earliest time it may join a convoy again (after being dropped as a straggler). */
  readonly rejoinAt: Float32Array;
  /** The commanders' estimate of enemy soldiers at each flag, per side (written by the theater commanders). */
  readonly flagEst: Float32Array[] = [new Float32Array(64), new Float32Array(64)];
  private readonly gateCtx = new GateContext();
  private readonly gateOut = new GateResult();
  private readonly delib = new Deliberation(Domain.SQUAD);
  hooks: ConvoyHooks | null = null;
  private readonly game: GameLike;
  private readonly st: AgentStateBuffers;
  private readonly radio: TacticalRadioBus;
  private readonly cover: CoverField;
  private readonly foliage: FoliageField;
  private squadPhase = 0;
  private mergeTimer = 0;
  private convoyTimer = 0;
  private convoyTickTimer = 0;

  /**
   * Per side and flag: metres the theater commander adds to the flag's distance when a free squad picks
   * its own objective (negative = priority, ≥ 1e5 = leave it alone, e.g. strongly held or being staged on).
   */
  readonly objectiveBias: Float32Array[];
  /** Convoy membership counters (evaluation). */
  readonly stats = { genuine: 0, genuineArrived: 0, genuineBroke: {} as Record<string, number>, genuineKm: 0, genuineMembers: 0, rejoined: 0, rejoinTimedOut: 0, rerouted: 0, leaderLeft: 0, waits: 0, neverDeparted: 0, assembleWait: 0, departed: 0, brief: 0, funnel: {} as Record<string, number>, joinedEnRoute: 0, taskPaired: 0, latePaired: 0, branched: 0, opportunities: 0, finalAssaults: 0, pinned: 0, suppressBounds: 0, retaskHeld: 0, chainStops: 0, requests: {} as Record<string, number>, replans: {} as Record<string, number>, extractRequests: 0, extractAccepted: 0, extractDone: 0, extractDenied: 0, convoyJoins: 0, convoyDiverged: 0, convoyStalled: 0, leftHold: 0, leftStuck: 0, leftLag: 0, leftDead: 0, drills: 0, drillDismounts: 0, formed: 0, legHalts: 0, journeyLegs: 0, stopovers: 0 };

  constructor(game: GameLike, st: AgentStateBuffers, radio: TacticalRadioBus, cover: CoverField, foliage: FoliageField) {
    this.game = game; this.st = st; this.radio = radio; this.cover = cover; this.foliage = foliage;
    this.objectiveBias = [new Float32Array(game.capture.flags.length), new Float32Array(game.capture.flags.length)];
    this.convoyOf = new Int32Array(game.vehicles.list.length).fill(-1);
    this.tripX = new Float32Array(game.vehicles.list.length).fill(1e6);
    this.tripZ = new Float32Array(game.vehicles.list.length).fill(1e6);
    this.departAt = new Float32Array(game.vehicles.list.length).fill(-1e3);
    this.oppSeen = new Uint8Array(game.vehicles.list.length); this.depX = new Float32Array(game.vehicles.list.length); this.depZ = new Float32Array(game.vehicles.list.length);
    const nv = game.vehicles.list.length;
    this.ownX = new Float32Array(nv); this.ownZ = new Float32Array(nv); this.ownHold = new Uint8Array(nv);
    this.divT = new Float32Array(nv); this.pendConv = new Int32Array(nv).fill(-1); this.pendUntil = new Float32Array(nv);
    this.funnelSeen = new Float32Array(nv).fill(-1e3); this.whyAlone = new Array(nv).fill('');

    this.lagSince = new Float32Array(game.vehicles.list.length);
    this.rejoinAt = new Float32Array(game.vehicles.list.length);
    for (let i = 0; i < 12; i++) this.convoys.push(new ConvoyGroup(i));
    // Infantry fire teams follow the class template order; crews group separately.
    for (let team = 0; team < 2; team++) {
      let inf: SquadBlackboard | null = null, crew: SquadBlackboard | null = null;
      for (const s of game.soldiers) {
        if (s.team !== team) continue;
        const isCrew = s.cls === SoldierClass.CREWMAN || s.cls === SoldierClass.PILOT;
        if (isCrew) {
          if (!crew || crew.count >= 6) { crew = new SquadBlackboard(this.squads.length, team, SquadKind.CREW); this.squads.push(crew); }
          this.join(s, crew);
        } else {
          if (!inf || (inf.count >= 6 && s.cls === SoldierClass.LEADER)) {
            inf = new SquadBlackboard(this.squads.length, team, SquadKind.INFANTRY);
            inf.defensive = this.squads.filter((q) => q.team === team && q.kind === SquadKind.INFANTRY).length % 4 === 2;
            this.squads.push(inf);
          }
          if (!this.join(s, inf)) { inf = new SquadBlackboard(this.squads.length, team, SquadKind.INFANTRY); this.squads.push(inf); this.join(s, inf); }
        }
      }
    }
  }

  private join(s: SoldierLike, q: SquadBlackboard): boolean {
    if (!q.addMember(s.id)) return false;
    if (s.squad && s.squad !== q) (s.squad as SquadBlackboard).removeMember(s.id);
    s.squad = q;
    const k = q.count - 1;
    this.st.slot[s.id] = k;
    this.st.fireteam[s.id] = k % 2;
    return true;
  }

  squadOf(s: SoldierLike): SquadBlackboard | null { return s.squad as SquadBlackboard | null; }

  reset(): void {
    for (const q of this.squads) q.clearTransient();
    for (const c of this.convoys) { c.active = false; c.count = 0; c.trailCount = 0; c.leaderId = -1; }
    this.convoyOf.fill(-1);
    this.lagSince.fill(0);
    this.rejoinAt.fill(0);
  }

  /** @param dt frame time */
  update(dt: number, agents: (AgentLike | null)[]): void {
    const time = this.game.time;
    // Squads: 4 Hz, staggered by squad id.
    const n = this.squads.length;
    const perFrame = Math.max(1, Math.ceil(n * AI_TUNING.squadHz * dt));
    for (let k = 0; k < perFrame; k++) {
      this.squadPhase = (this.squadPhase + 1) % n;
      const q = this.squads[this.squadPhase];
      this.tickSquad(q, time);
      // The leader found the squad's waypoint unreachable: skip the approach waypoint, or note the failure
      // (shown in the debug overlay; the commander sees it through the operation's lack of progress).
      const la = q.leader >= 0 ? agents[q.leader] : null;
      if (la && la.navStatus === 'unreachable') {
        if (q.navFailT < time - 30) q.navFails++;
        q.navFailT = time;
        if (q.order === Order.ATTACK && !q.axisDone) q.axisDone = true;
      }
    }
    this.mergeTimer -= dt;
    if (this.mergeTimer <= 0) { this.mergeTimer = 1; this.mergeBroken(time); }
    this.convoyTimer -= dt;
    if (this.convoyTimer <= 0) { this.convoyTimer = 1 / AI_TUNING.convoyHz; this.formConvoys(agents, time); }
    this.convoyTickTimer -= dt;
    if (this.convoyTickTimer <= 0) { this.convoyTickTimer = 0.25; this.tickConvoys(agents, time); }
  }

  // ------------------------------------------------------------------ squads

  private tickSquad(q: SquadBlackboard, time: number): void {
    const g = this.game, soldiers = g.soldiers;
    // Census, leader election and centroid.
    let alive = 0, dismounted = 0, sx = 0, sz = 0, sup = 0, ammo = 0, leaderValid = false;
    for (let i = 0; i < q.count; i++) {
      const s = soldiers[q.members[i]];
      if (!s.alive) continue;
      alive++;
      sup += this.st.suppression[s.id];
      const w = s.rifle;
      ammo += (w.ammo + w.reserve) / (w.def.mag + w.def.reserve);
      if (s.vehicle) continue;
      dismounted++; sx += s.pos.x; sz += s.pos.z;
      if (s.id === q.leader && !s.isPlayer) leaderValid = true;
    }
    q.alive = alive; q.dismounted = dismounted;
    q.suppressionAvg = alive ? sup / alive : 0;
    q.ammoAvg = alive ? ammo / alive : 1;
    if (dismounted) { q.cx = sx / dismounted; q.cz = sz / dismounted; }
    if (!leaderValid) q.leader = this.electLeader(q);
    if (alive === 0) return;
    if (q.vehicle >= 0) {
      const v = g.vehicles.list[q.vehicle];
      let aboard = 0;
      for (let i = 0; i < q.count; i++) if (soldiers[q.members[i]].vehicle === v) aboard++;
      if (!v.alive || (aboard === 0 && this.st.ticket[q.leader] < 0)) q.vehicle = -1;
    }
    // Objective.
    const o = q.objective;
    const stale = !o || time - q.objectiveTime > 45 || (o.owner === q.team && o.contestedBy < 0 && !q.defensive && time - q.objectiveTime > 6);
    // Under orders the commander owns the objective; free squads still pick their own.
    if (stale && q.order === Order.NONE && (!o || o.owner === q.team || this.mayRetask(q, false, null))) this.chooseObjective(q, time);
    else if (stale && q.order === Order.NONE && o) q.objectiveTime = time;
    if (q.objective !== q.lastObj) {
      if (q.lastObj && q.objective) {
        q.changes.push(`${time.toFixed(0)} s: ${(q.lastObj as any).name} → ${(q.objective as any).name} (${q.opId >= 0 ? `operation ${q.opId}` : q.assignWhy || ORDER_NAMES[q.order]})`);
        if (q.changes.length > 4) q.changes.shift();
      }
      q.lastObj = q.objective; q.objSince = time;
    }
    if (q.vehicle >= 0) q.waitSince = 0;
    if (q.objective) q.heading = Math.atan2(q.objective.x - q.cx, q.objective.z - q.cz);
    if (q.kind === SquadKind.CREW) { q.posture = Posture.DEFEND; return; }

    // Posture.
    const contacts = q.contactCentroid(time, 8, _c2);
    const prev = q.posture;
    const holding = q.order === Order.HOLD || q.order === Order.SUPPORT || q.order === Order.DEFEND;
    if (q.vehicle >= 0 && dismounted < alive) q.posture = Posture.MOUNTED;
    else if (this.radio.inDangerZone(q.team, q.cx, q.cz, 25, time) >= 0) q.posture = Posture.HOLD;
    // Holding ground: fight from the planned positions, no bounding / flanking away from them.
    else if (holding) q.posture = Posture.DEFEND;
    // Decided on a final assault into the capture circle (updateCapture): everyone goes, no bounding / flanking.
    else if (time < q.assaultUntil && dismounted > 0) q.posture = Posture.ASSAULT;
    // Suppress-and-bound toward the flag (updateCapture): fire and movement, no flanking away, no regrouping back.
    else if (time < q.sbUntil && dismounted >= 3) q.posture = Posture.BOUND;
    // Final assault: once the objective's defenders are engaged (contact on the flag, squad within 160 m) the attack
    // waypoint no longer matters; fire and movement straight onto the flag, no flanking away, no regrouping back.
    else if (q.order === Order.ATTACK && dismounted > 0 && this.assaulting(q, contacts)) { q.axisDone = true; q.posture = Posture.BOUND; }
    // On a mission: contact off the route is bypassed (keep moving, return fire); only a blocking contact is fought through.
    else if (contacts > 0 && dismounted >= 3 && (q.order === Order.ATTACK || q.order === Order.MOVE) && !this.blocksRoute(q, _c2[0], _c2[1])) q.posture = Posture.ASSAULT;
    else if (contacts > 0 && dismounted >= 3) {
      const d = Math.hypot(_c2[0] - q.cx, _c2[1] - q.cz);
      // Squads on a mission meet blocking contact with fire and movement toward the objective; they only
      // swing out to flank when pinned (heavy suppression) and not more than once every 45 s.
      const mission = q.order === Order.ATTACK || q.order === Order.MOVE;
      const pinned = q.suppressionAvg > 0.5 && time - q.flankUntil > 45;
      if (prev === Posture.FLANK && time < q.flankUntil) { /* keep flanking */ }
      else if (dismounted >= 4 && (mission ? pinned : (contacts >= 2 || (prev === Posture.BOUND && time - q.postureTime > 14))) && d > 30 && d < 200) {
        this.planFlank(q, _c2[0], _c2[1], time);
        q.posture = Posture.FLANK;
      } else if (d < 220) q.posture = Posture.BOUND;
      else q.posture = Posture.ASSAULT;
    } else if (dismounted > 0 && this.spread(q) > 60) q.posture = Posture.REGROUP;
    else q.posture = q.defensive && q.objective && q.objective.owner === q.team ? Posture.DEFEND : Posture.ASSAULT;
    if (q.posture !== prev) {
      q.postureTime = time;
      if (q.posture === Posture.BOUND) { q.boundTeam = 0; q.boundUntil = time + 7; this.clearArrived(q); }
    }
    // Bounding overwatch: swap the moving fire team once it has reached cover (or timed out).
    if (q.posture === Posture.BOUND) {
      let movers = 0, arrived = 0;
      for (let i = 0; i < q.count; i++) {
        const s = soldiers[q.members[i]];
        if (!s.alive || s.vehicle || this.st.fireteam[s.id] !== q.boundTeam) continue;
        movers++; if (this.st.arrived[s.id]) arrived++;
      }
      if (time > q.boundUntil || (movers > 0 && arrived >= movers)) {
        q.boundTeam = 1 - q.boundTeam; q.boundUntil = time + 7; this.clearArrived(q);
      }
    }
    if (q.posture === Posture.FLANK) {
      let fl = 0, there = 0;
      for (let i = 0; i < q.count; i++) {
        const s = soldiers[q.members[i]];
        if (!s.alive || s.vehicle || this.st.fireteam[s.id] !== q.flankTeam) continue;
        fl++; if ((s.pos.x - q.flankX) ** 2 + (s.pos.z - q.flankZ) ** 2 < 100) there++;
      }
      if (fl === 0 || there * 2 >= fl || time > q.flankUntil) { q.posture = Posture.BOUND; q.postureTime = time; q.boundTeam = q.flankTeam; q.boundUntil = time + 7; }
    }
    if (dismounted) { q.rallyX = contacts > 0 ? q.cx - Math.sin(q.heading) * 25 : q.cx; q.rallyZ = contacts > 0 ? q.cz - Math.cos(q.heading) * 25 : q.cz; }
    // Stuck while advancing (unreachable waypoint, terrain): skip the attack waypoint, or move on toward the flag.
    if ((q.order === Order.ATTACK || q.order === Order.MOVE) && dismounted > 0) {
      if ((q.cx - q.progX) ** 2 + (q.cz - q.progZ) ** 2 > 36) { q.progX = q.cx; q.progZ = q.cz; q.progT = time; }
      else if (time - q.progT > 25 && contacts === 0) { q.axisDone = true; q.progT = time; }
    } else q.progT = time;
    // Multi-axis attack: the attack position is reached (or the squad is already past it).
    if (q.order === Order.ATTACK && !q.axisDone && dismounted > 0) {
      const da = Math.hypot(q.axisX - q.cx, q.axisZ - q.cz);
      if (da < 28 || Math.hypot(q.destX - q.cx, q.destZ - q.cz) < Math.hypot(q.destX - q.axisX, q.destZ - q.axisZ) * 0.85) q.axisDone = true;
    }
    if (q.order !== Order.NONE) q.heading = Math.atan2(q.destX - q.cx, q.destZ - q.cz);
    this.planPositions(q, contacts, time);
    this.raiseRequests(q, contacts, time);
    this.updateCapture(q, time);
    this.updateIntent(q, contacts, time);
  }

  /** Attacking squad in the close fight for its flag: on the axis inside 90 m, or the contact is on the flag and we are inside 160 m. */
  private assaulting(q: SquadBlackboard, contacts: number): boolean {
    const d2 = (q.destX - q.cx) ** 2 + (q.destZ - q.cz) ** 2;
    if (q.axisDone && d2 < 90 * 90) return true;
    if (contacts === 0 || d2 > 160 * 160) return false;
    return (_c2[0] - q.destX) ** 2 + (_c2[1] - q.destZ) ** 2 < 90 * 90;
  }

  /** Is a contact at (x, z) in the way to the squad's goal (ahead within ±60°, nearer than the goal)? */
  private blocksRoute(q: SquadBlackboard, x: number, z: number): boolean {
    const r = squadGoal(q, _g2);
    if (r < 0) return true;
    const gx = _g2[0] - q.cx, gz = _g2[1] - q.cz, cx = x - q.cx, cz = z - q.cz;
    const dg = Math.hypot(gx, gz), dc = Math.hypot(cx, cz);
    if (dc < 35) return true;                // too close to ignore
    if (dc > dg + 20) return false;          // beyond the goal
    return (gx * cx + gz * cz) / ((dg || 1) * (dc || 1)) > 0.5;
  }

  /** Fighting positions for holding / supporting / defending squads (and attackers on the flag). */
  private planPositions(q: SquadBlackboard, contacts: number, time: number): void {
    let mode = -1;
    if (q.order === Order.HOLD) mode = PosMode.HOLD;
    else if (q.order === Order.SUPPORT) mode = PosMode.SUPPORT;
    else if (q.order === Order.DEFEND) mode = PosMode.DEFEND_FLAG;
    else if (q.order === Order.ATTACK && q.axisDone && (q.destX - q.cx) ** 2 + (q.destZ - q.cz) ** 2 < 35 * 35) mode = PosMode.DEFEND_FLAG;
    else if (q.order === Order.NONE && q.objective && q.objective.owner === q.team && (q.objective.x - q.cx) ** 2 + (q.objective.z - q.cz) ** 2 < 40 * 40) {
      mode = PosMode.DEFEND_FLAG;
      q.destX = q.objective.x; q.destZ = q.objective.z; q.threatYaw = q.heading;
    }
    if (mode < 0 || q.dismounted === 0) { q.planMode = -1; return; }
    const px = q.destX, pz = q.destZ;
    let yaw = q.threatYaw;
    if (contacts > 0 && q.contactCentroid(time, 8, _c2) > 0) yaw = Math.atan2(_c2[0] - px, _c2[1] - pz);
    // Commitment: the posts stand until something meaningful changes: another task or place, the threat coming
    // from a clearly different direction, a post destroyed, members joining / lost, or a long time has passed.
    // (Re-planning every 9 s with a reshuffled seed sent defenders walking between posts all the time.)
    if (mode === q.planMode && (q.planX - px) ** 2 + (q.planZ - pz) ** 2 < 36 && time - q.planTime < 90) {
      let dy = Math.abs(yaw - q.planYaw) % (Math.PI * 2); if (dy > Math.PI) dy = Math.PI * 2 - dy;
      let lost = false;
      for (let k = 0; k < q.plan.count && !lost; k++) if (q.plan.node[k] >= 0 && !this.cover.valid(q.plan.node[k])) lost = true;
      if ((dy < 0.8 || time - q.planTime < 20) && !lost && q.plan.count === q.count) return;
      this.stats.replans[dy >= 0.8 ? 'threat moved' : lost ? 'post destroyed' : 'squad changed'] = (this.stats.replans[dy >= 0.8 ? 'threat moved' : lost ? 'post destroyed' : 'squad changed'] || 0) + 1;
    }
    const soldiers = this.game.soldiers;
    for (let k = 0; k < q.count; k++) { const m = soldiers[q.members[k]]; CLS[k] = m.cls; MX[k] = m.alive && !m.vehicle ? m.pos.x : px; MZ[k] = m.alive && !m.vehicle ? m.pos.z : pz; }
    const fx = mode === PosMode.SUPPORT && q.objective ? q.objective.x : px;
    const fz = mode === PosMode.SUPPORT && q.objective ? q.objective.z : pz;
    const radius = mode === PosMode.HOLD ? 24 : mode === PosMode.SUPPORT ? 22 : 34;
    // Defending a rooftop objective (MIKE) whose hall stands: the circle is the roof.
    const ob = q.objective as any, roofB = mode === PosMode.DEFEND_FLAG && ob && ob.host && ob.host.state < 2 && ob.hostIndex >= 0 ? ob.hostIndex : -1;
    planSquadPositions(this.game, this.cover, this.foliage, mode, px, pz, radius, yaw, fx, fz, AI_TUNING.captureRadius,
      q.count, CLS, q.id * 7, q.plan, MX, MZ, roofB);
    q.planMode = mode; q.planTime = time; q.planX = px; q.planZ = pz; q.planYaw = yaw;
  }

  private electLeader(q: SquadBlackboard): number {
    const soldiers = this.game.soldiers;
    for (let c = 0; c < CLASS_LEAD_ORDER.length; c++) {
      for (let i = 0; i < q.count; i++) {
        const s = soldiers[q.members[i]];
        if (s.alive && !s.isPlayer && s.cls === CLASS_LEAD_ORDER[c]) return s.id;
      }
    }
    for (let i = 0; i < q.count; i++) if (!soldiers[q.members[i]].isPlayer) return q.members[i];
    return q.members[0];
  }

  private spread(q: SquadBlackboard): number {
    const soldiers = this.game.soldiers;
    let worst = 0;
    for (let i = 0; i < q.count; i++) {
      const s = soldiers[q.members[i]];
      if (!s.alive || s.vehicle) continue;
      const d = Math.hypot(s.pos.x - q.cx, s.pos.z - q.cz);
      if (d > worst) worst = d;
    }
    return worst;
  }

  private clearArrived(q: SquadBlackboard): void {
    for (let i = 0; i < q.count; i++) this.st.arrived[q.members[i]] = 0;
  }

  private _flagNames: string[] | null = null;
  private flagNames(): string[] { return this._flagNames || (this._flagNames = this.game.capture.flags.map((f: any) => f.name)); }

  private chooseObjective(q: SquadBlackboard, time: number): void {
    const flags = this.game.capture.flags, bias = this.objectiveBias[q.team];
    const temper = hash01(q.id, 77);
    const D = this.delib.begin(q.id, time, temper, q.suppressionAvg);
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      // The commander's priorities: metres added to (or taken off) this flag's distance; ≥ 1e5 = leave it alone.
      if (q.kind === SquadKind.INFANTRY && bias[i] >= 1e5) continue;
      // On foot: only objectives on the squad's own landmass (the island is reached by air, see the commander).
      if (!(this.game.nav as any).sameLandmass(q.cx, q.cz, f.x, f.z)) continue;
      const mine = f.owner === q.team;
      const contested = f.contestedBy >= 0 && f.contestedBy !== q.team;
      let score = Math.hypot(f.x - q.cx, f.z - q.cz) * (0.75 + hash01(q.id * 31 + i, Math.floor(time / 30)) * 0.5);
      if (q.kind === SquadKind.CREW) score = mine && f.base ? 0 : score + 500;
      else if (q.defensive) { if (!mine) score += 260; else if (!contested) score += 120; }
      else if (mine && !contested) score += 900;
      for (let k = 0; k < this.squads.length; k++) {
        const o = this.squads[k];
        if (o !== q && o.team === q.team && o.objective === f && o.kind === SquadKind.INFANTRY) score += 70;
      }
      if (q.kind === SquadKind.INFANTRY) score += bias[i];
      // Commitment: keep going for the current objective unless another is clearly better (no ping-pong).
      if (f === q.objective && !mine) score -= 160;
      D.propose(i, -score);
    }
    // Q1–Q5 on each flag, nearest / most wanted first; Q6 moves on to the next.
    let best: FlagLike | null = null;
    for (let i = D.next(); i >= 0; i = D.next()) {
      const f = flags[i], mine = f.owner === q.team, contested = f.contestedBy >= 0 && f.contestedBy !== q.team;
      const est = this.flagEst[q.team][i] || 0;
      let others = 0;
      for (let k = 0; k < this.squads.length; k++) {
        const o = this.squads[k];
        if (o !== q && o.team === q.team && o.objective === f && o.kind === SquadKind.INFANTRY) others += o.alive;
      }
      // Q1 why: a flag to take, one of ours under attack, home for crews, our own ground for a defensive squad.
      const why = q.kind === SquadKind.CREW ? mine && !!(f as any).base : !mine || contested || q.defensive || f === q.objective;
      // Q2 necessary: not when enough of us are already heading there for what is believed to hold it.
      const need = q.kind !== SquadKind.CREW && !mine && others >= Math.max(8, est * 2.5) ? 0.25 : 1;
      // Q3 benefit: our odds there (with the squads already going) against the defenders we believe are there.
      const odds = (q.alive + others * 0.6) / Math.max(1, est);
      const benefit = mine || q.kind === SquadKind.CREW || est < 1.5 ? 1 : clamp01(odds / 1.6);
      // Q4 outcome: a flag that counts (an enemy base cannot be taken on foot).
      const outcome = (f as any).base && !mine ? 0 : 1;
      // Q5 resources: rifles and ammunition for a fight; a spent squad only goes to friendly ground.
      const res = mine || q.kind === SquadKind.CREW ? 1 : q.alive >= 2 && q.ammoAvg > 0.12 ? 1 : 0;
      if (D.check(why, need, benefit, outcome, res) === 0) { D.choose(i); best = f; break; }
    }
    if (!best) {
      // Nothing holds: keep the current objective if it is still ours to go for, else fall back on friendly ground.
      D.none();
      best = q.objective && (q.objective.owner !== q.team || q.defensive) ? q.objective : this.nearestFriendlyFlag(q);
      q.decisionWhy = 'no objective passed the five questions: holding course / falling back';
    } else q.decisionWhy = this.delib.trace(this.flagNames());
    q.objective = best;
    q.objectiveTime = time;
  }

  /** Picks the flank side with the most concealment and cover along it. */
  private planFlank(q: SquadBlackboard, ex: number, ez: number, time: number): void {
    let dx = ex - q.cx, dz = ez - q.cz;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const reach = Math.min(40, d * 0.7);
    let bestX = ex, bestZ = ez, bestScore = -1e9;
    for (let side = -1; side <= 1; side += 2) {
      const fx = ex - dz * side * reach - dx * 12, fz = ez + dx * side * reach - dz * 12;
      const mx = (q.cx + fx) / 2, mz = (q.cz + fz) / 2;
      if (this.game.nav.blocked(fx, fz)) continue;
      let s = this.foliage.at(mx, mz) + this.foliage.at(fx, fz) * 0.5;
      s += Math.min(6, this.cover.grid.query(fx, fz, 14, SCRATCH_IDS)) * 0.08;
      if (this.radio.inDangerZone(q.team, fx, fz, 10, time) >= 0) s -= 2;
      s += hash01(q.id, side + 7) * 0.05;
      if (s > bestScore) { bestScore = s; bestX = fx; bestZ = fz; }
    }
    q.flankX = bestX; q.flankZ = bestZ; q.flankUntil = time + 22;
    // The fire team with fewer members pins; the larger one flanks.
    q.flankTeam = 1;
  }

  /**
   * The squad's state as a group, from what it is ordered to do and where its members are: what a player
   * watching it should be able to read off it (and the debug overlay prints).
   */
  /**
   * Taking a flag: once the squad is within 160 m and has stopped closing for 15 s with nobody in the capture
   * circle, it weighs itself against what it knows is there. Enough (at least as many as the known defenders
   * within 70 m of the flag, or nobody known there): final assault into the circle. Clearly fewer: pinned, held
   * where it is (the commander's reviews and the squad's support requests deal with it). Fighting near a flag
   * is not taking it.
   */
  private updateCapture(q: SquadBlackboard, time: number): void {
    const f = q.objective;
    const attacking = f !== null && f.owner !== q.team && !(f as any).base && q.vehicle < 0 &&
      ((q.order === Order.ATTACK && q.axisDone) || q.order === Order.NONE);
    if (!attacking || !f) { q.capState = f && f.owner === q.team && (q.order === Order.DEFEND || q.garrison >= 0) ? 'defending' : 'none'; q.assaultUntil = 0; q.capFlag = -1; return; }
    const soldiers = this.game.soldiers, R = AI_TUNING.captureRadius;
    if (q.capFlag !== f.id) { q.capFlag = f.id; q.capBestD = 1e9; q.capBestT = time; q.assaultUntil = 0; q.pinnedT = 0; }
    const d = Math.hypot(f.x - q.cx, f.z - q.cz);
    let inR = 0;
    for (let i = 0; i < q.count; i++) { const m = soldiers[q.members[i]]; if (m.alive && !m.vehicle && inCaptureVolume(f, m.pos.x, m.pos.y, m.pos.z, R)) inR++; }
    if (d < q.capBestD - 5) { q.capBestD = d; q.capBestT = time; }
    if (inR > 0) { q.capState = (q.team === 0 ? -f.v : f.v) > 0 || f.owner < 0 ? 'capturing' : 'in the circle'; q.pinnedT = 0; return; }
    const enemies = this.perceivedDefenders(q, f, time);
    if (time < q.assaultUntil) { q.capState = 'final assault'; return; }
    if (time < q.sbUntil) { q.capState = 'suppress-and-bound'; return; }
    if (d > ASSAULT_RING || time - q.capBestT < 15) { q.capState = 'approaching'; return; }
    // Stalled near it: decide from the defenders the squad believes are there (threat memory: those it lost sight
    // of a moment ago still count, and the commander's estimate is a floor) — not only those in view right now.
    // Q1–Q5 for each way forward, boldest first; Q6 falls back to the next one.
    const own = q.dismounted;
    const D = this.delib.begin(q.id, time, hash01(q.id, 77), q.suppressionAvg);
    D.propose(0, 3); D.propose(1, 2); D.propose(2, 1);
    let pick = 2;
    for (let k = D.next(); k >= 0; k = D.next()) {
      let r: number;
      if (k === 0) r = D.check(true, true, own >= Math.max(2, enemies) ? 1 : clamp01(own / Math.max(2, enemies)) * 0.8, true, q.ammoAvg > 0.12);
      else if (k === 1) r = D.check(true, true, own >= 3 && own * 2 >= enemies, true, own >= 3 && q.ammoAvg > 0.22);
      else r = D.check(true, true, true, true, true);
      if (r === 0) { pick = D.choose(k); break; }
    }
    if (pick === 0) {
      q.assaultUntil = time + 40; q.capBestT = time; q.capState = 'final assault'; q.capWhy = `${q.dismounted} vs ~${enemies.toFixed(0)} believed at the flag`;
      this.stats.finalAssaults++;
    } else if (pick === 1) {
      // Not enough for a rush, enough to work forward: one fire team suppresses (and smokes), the other bounds to
      // closer cover; then they swap. Re-decided after 30 s.
      q.sbUntil = time + 30; q.sbSmoke = true; q.capBestT = time; q.capState = 'suppress-and-bound';
      q.capWhy = `${q.dismounted} vs ~${enemies.toFixed(0)} believed at the flag: suppress and bound forward`;
      this.stats.suppressBounds++;
    } else {
      if (q.capState !== 'pinned') { q.pinnedT = time; this.stats.pinned++; }
      q.capState = 'pinned'; q.capWhy = `outnumbered at the flag (${q.dismounted} vs ~${enemies.toFixed(0)} believed): holding and calling for support`;
    }
  }

  /**
   * Purpose gate, Q2 for re-tasking: may squad q be taken off its current capture assignment? Locked inside the
   * 180 m assault ring on a flag still to be taken, unless the squad is broken (< 25 % strength), the new task is
   * an explicit retreat, or it concerns the same flag.
   */
  mayRetask(q: SquadBlackboard, retreat: boolean, sameFlag: FlagLike | null): boolean {
    const f = q.objective, G = this.gateCtx;
    G.capturing = f !== null && f.owner !== q.team && !(f as any).base && q.kind === SquadKind.INFANTRY && (q.order === Order.ATTACK || q.order === Order.NONE) && q.vehicle < 0;
    G.objDist = f ? Math.hypot(f.x - q.cx, f.z - q.cz) : 1e9;
    G.strength = q.count > 0 ? q.alive / Math.max(q.count, 4) : 0;
    G.retreat = retreat; G.sameObjective = sameFlag !== null && sameFlag === f;
    const ok = evaluatePurposeGate(G, GateCandidate.SQUAD_RETASK, this.gateOut).ok;
    if (!ok) this.stats.retaskHeld++;
    return ok;
  }

  /**
   * Squad threat memory around a flag: contacts within 70 m seen in the last 6 s (a defender ducking behind a
   * wall is still there), a remembered peak that fades by one every 10 s, and the commander's intel estimate
   * (x 0.8) as a floor. Never drops to zero the moment the defenders break line of sight.
   */
  perceivedDefenders(q: SquadBlackboard, f: FlagLike, time: number): number {
    let live = 0;
    for (let k = 0; k < q.cTarget.length; k++) {
      if (q.cTarget[k] < 0 || time - q.cT[k] > 6) continue;
      if ((q.cX[k] - f.x) ** 2 + (q.cZ[k] - f.z) ** 2 < 70 * 70) live++;
    }
    if (q.memFlag !== f.id) { q.memFlag = f.id; q.memPeak = 0; q.memT = time; }
    q.memPeak = Math.max(live, q.memPeak - (time - q.memT) / 10); q.memT = time;
    const est = this.flagEst[q.team][(f as any).id] || 0;
    return Math.max(live, q.memPeak, est * 0.8);
  }

  private updateIntent(q: SquadBlackboard, contacts: number, time: number): void {
    const o = q.objective, d = o ? Math.hypot(o.x - q.cx, o.z - q.cz) : 1e9, own = o !== null && o.owner === q.team;
    let k: string;
    if (q.vehicle >= 0 && q.dismounted < q.alive) k = 'mounted';
    else if (time < q.recoverUntil || q.posture === Posture.REGROUP) k = 'regrouping';
    else if (q.waitSince > 0) k = 'waiting for stragglers';
    else if (time - q.navFailT < 20 && q.navFails >= 2) k = 'unable to reach its objective';
    else if (q.order === Order.DEFEND || q.garrison >= 0) k = d < 45 ? 'defending' : 'moving to defend';
    else if (q.order === Order.HOLD || q.order === Order.SUPPORT) k = d < 60 || Math.hypot(q.destX - q.cx, q.destZ - q.cz) < 40 ? 'holding' : 'moving to hold';
    else if (q.capState === 'final assault' || q.capState === 'suppress-and-bound' || q.capState === 'pinned' || q.capState === 'capturing' || q.capState === 'in the circle') k = q.capState;
    else if (o && !own && d < 30) k = 'contesting';
    else if (contacts > 0 && d > 60) k = 'interrupted (contact)';
    else if (o && d < 90) k = own ? 'securing' : 'arriving';
    else if (o) k = 'traveling';
    else k = 'idle';
    if (k !== q.intent) { q.intent = k; q.intentT = time; }
  }

  /** Combined-arms requests raised by the squad as a whole. */
  private raiseRequests(q: SquadBlackboard, contacts: number, time: number): void {
    const leader = q.leader;
    let spotter = false;
    for (let i = 0; i < q.count; i++) {
      const s = this.game.soldiers[q.members[i]];
      if (s.alive && s.cls === SoldierClass.SPOTTER && !s.vehicle) { spotter = true; break; }
    }
    // Support: fire mission, close air support or ammunition, each through Q1–Q5; when the first choice fails (no
    // guns crewed, enemy too close for artillery...) Q6 tries the other support before giving up.
    const H = this.hooks;
    const pressed = contacts >= 2 && q.suppressionAvg > 0.35, heavy = contacts >= 4;
    if ((pressed && time > q.nextFireMission && !pending(q.req[0])) || (heavy && time > q.nextCas && !pending(q.req[1]))) {
      q.contactCentroid(time, 8, _c2);
      const close = Math.hypot(_c2[0] - q.cx, _c2[1] - q.cz);
      const D = this.delib.begin(q.id, time, hash01(q.id, 77), q.suppressionAvg);
      D.propose(0, pressed ? 2 : 0.5);
      D.propose(1, heavy ? 2.5 : 1);
      let pick = -1;
      for (let k = D.next(); k >= 0; k = D.next()) {
        const r = k === 0
          ? D.check(contacts >= 2, time > q.nextFireMission && !pending(q.req[0]), close > 70 ? 1 : 0.2, true, H ? H.supportOn(q.team, 0) : 1)
          : D.check(contacts >= 3, time > q.nextCas && !pending(q.req[1]), close > 40 ? 1 : 0.3, true, H ? H.supportOn(q.team, 1) : 1);
        if (r === 0) { pick = D.choose(k); break; }
      }
      if (pick < 0) { D.none(); q.nextFireMission = Math.max(q.nextFireMission, time + 12); q.nextCas = Math.max(q.nextCas, time + 15); }
      const y = this.game.map.terrain.height(_c2[0], _c2[1]);
      if (pick === 0) {
        this.track(q, 0, this.radio.publish(RadioType.FIRE_MISSION, q.team, leader, q.id, _c2[0], y, _c2[1], -1, 2, time, 0, spotter), time);
        q.nextFireMission = time + 18;
      } else if (pick === 1) {
        const m = this.radio.publish(RadioType.CAS_REQUEST, q.team, leader, q.id, _c2[0], y, _c2[1], -1, 1, time, 0, spotter);
        if (m) { m.vx = _c2[0] - q.cx; m.vz = _c2[1] - q.cz; }
        this.track(q, 1, m, time);
        q.nextCas = time + 30;
      }
    }
    if (q.ammoAvg < 0.3 && time > q.nextLogistics && !pending(q.req[2])) {
      this.track(q, 2, this.radio.publish(RadioType.LOGISTICS_REQUEST, q.team, leader, q.id, q.cx, 0, q.cz, -1, 1, time, Logistics.AMMO), time);
      q.nextLogistics = time + 30;
    }
    // Combat ineffective (two or fewer left, or broken and pinned, far from friends): ask to be pulled out by air;
    // with no helicopter free, by the squad's own (or any) ground transport; with neither, withdraw on foot.
    const broken = q.dismounted > 0 && (q.dismounted <= 2 || (q.dismounted <= 3 && q.suppressionAvg > 0.6));
    if (broken && contacts >= 2 && time > q.nextExtract && time > q.noLiftUntil && q.extractState !== 'coming') {
      const f = this.nearestFriendlyFlag(q);
      const far = !f || Math.hypot(f.x - q.cx, f.z - q.cz) > 140;
      const D = this.delib.begin(q.id, time, hash01(q.id, 77), q.suppressionAvg);
      D.propose(0, 2); D.propose(1, 1); D.propose(2, 0.5);
      let pick = -1;
      for (let k = D.next(); k >= 0; k = D.next()) {
        const r = k === 0 ? D.check(true, far, true, true, H ? H.supportOn(q.team, 2) : 1)
          : k === 1 ? D.check(true, far, true, true, H ? H.supportOn(q.team, 3) : 0)
          : D.check(true, true, true, !!f, true);
        if (r === 0) { pick = D.choose(k); break; }
      }
      if (pick === 0 || pick === 1) {
        const m = this.radio.publish(RadioType.EXTRACT_REQUEST, q.team, leader, q.id, q.cx, 0, q.cz, -1, 1, time, pick);
        if (m) { q.nextExtract = time + 60; q.extractMsg = m; q.extractMsgId = m.id; q.extractState = 'requested'; q.extractT = time; this.stats.extractRequests++; }
      } else if (pick === 2 && f) {
        q.objective = f; q.objectiveTime = time; q.nextExtract = time + 45; q.decisionWhy = 'no lift available: withdrawing on foot';
      } else { D.none(); q.nextExtract = time + 20; }
    }
    for (let k = 0; k < 3; k++) this.follow(q, k, time);
    // Follow the request: someone claimed it (coming), it was carried out (done), or it lapsed unanswered (denied).
    const em = q.extractMsg;
    if (em && (q.extractState === 'requested' || q.extractState === 'coming')) {
      if (em.id !== q.extractMsgId || em.state === MsgState.FREE) { q.extractState = 'denied'; q.extractMsg = null; q.extractT = time; this.stats.extractDenied++; }
      else if (em.state === MsgState.DONE) { q.extractState = 'done'; q.extractMsg = null; q.extractT = time; this.stats.extractDone++; }
      else if (em.state === MsgState.CLAIMED && q.extractState !== 'coming') { q.extractState = 'coming'; q.extractT = time; this.stats.extractAccepted++; }
    }
  }

  /** Records a request the squad just made (or was refused). */
  private track(q: SquadBlackboard, k: number, m: any, time: number): void {
    const r = q.req[k];
    // A refresh of the same ticket (dedupe) keeps its current state.
    if (m && r.msg === m && r.id === m.id && r.state !== 'done') return;
    r.t = time;
    if (m) { r.msg = m; r.id = m.id; r.state = 'requested'; r.why = ''; }
    else if (this.radio.lastRefusal && !this.radio.lastRefusal.startsWith('radio net busy')) { r.msg = null; r.state = 'denied'; r.why = this.radio.lastRefusal; this.reqTally(k, 'denied'); }
  }

  /** Follows a tracked request through its life on the radio net. */
  private follow(q: SquadBlackboard, k: number, time: number): void {
    const r = q.req[k], m = r.msg;
    if (!m) return;
    const end = (state: string, why: string) => { r.state = state; r.why = why; r.t = time; r.msg = null; this.reqTally(k, state); };
    if (m.id !== r.id) { end(r.state === 'accepted' ? 'failed' : 'unanswered', r.state === 'accepted' ? `accepted, then not carried out (${r.why || 'no reason given'})` : 'nobody took it'); return; }
    if (m.state === MsgState.DONE) { end(m.outcome.startsWith('called off') ? 'denied' : 'done', m.outcome); return; }
    if (m.state === MsgState.FREE) { end(m.firstClaim > 0 ? 'failed' : 'unanswered', m.outcome || 'expired'); return; }
    if (m.state === MsgState.CLAIMED) { if (r.state !== 'accepted') { r.state = 'accepted'; r.t = time; } r.why = m.status; }
    else if (m.state === MsgState.OPEN) { r.state = 'requested'; r.why = m.status; }
  }

  private reqTally(k: number, state: string): void {
    const key = ['fire', 'cas', 'supply'][k] + ':' + state;
    this.stats.requests[key] = (this.stats.requests[key] || 0) + 1;
  }

  nearestFriendlyFlag(q: SquadBlackboard): FlagLike | null {
    const flags = this.game.capture.flags;
    let best: FlagLike | null = null, bd = 1e12;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f.owner !== q.team) continue;
      const d = (f.x - q.cx) ** 2 + (f.z - q.cz) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  /** Merges the survivors of broken squads into nearby fire teams with room. */
  private mergeBroken(time: number): void {
    const soldiers = this.game.soldiers;
    for (let a = 0; a < this.squads.length; a++) {
      const q = this.squads[a];
      if (q.kind !== SquadKind.INFANTRY || q.vehicle >= 0 || q.dismounted === 0 || q.dismounted > 2 || q.count - q.alive < 2) continue;
      let best: SquadBlackboard | null = null, bd = 90 * 90;
      for (let b = 0; b < this.squads.length; b++) {
        const o = this.squads[b];
        if (o === q || o.team !== q.team || o.kind !== SquadKind.INFANTRY || o.dismounted < 2 || o.count + q.dismounted > MAX_MEMBERS) continue;
        const d = (o.cx - q.cx) ** 2 + (o.cz - q.cz) ** 2;
        if (d < bd) { bd = d; best = o; }
      }
      if (!best) continue;
      for (let i = q.count - 1; i >= 0; i--) {
        const s = soldiers[q.members[i]];
        if (!s.alive || s.vehicle || s.isPlayer) continue;
        this.join(s, best);
      }
      best.objectiveTime = Math.min(best.objectiveTime, time);
    }
  }

  // ------------------------------------------------------------------ convoys

  private formConvoys(agents: (AgentLike | null)[], time: number): void {
    const list = this.game.vehicles.list;
    // Members: destroyed / crew gone leave for good; a stalled or lagging member is separated (it may rejoin
    // within 75 s if the convoy is still on the same journey); a member whose own destination is reached leaves.
    for (let ci = 0; ci < this.convoys.length; ci++) {
      const c = this.convoys[ci];
      if (!c.active) continue;
      for (let i = c.count - 1; i >= 0; i--) {
        const v = list[c.vehicles[i]];
        const a = v.driver ? agents[v.driver.id] : null;
        const lagging = this.lagSince[v.id] > 0 && time - this.lagSince[v.id] > 25;
        const forming = c.state === 'assembling' || time - c.departT < 6;
        if (!v.alive || !a) { this.stats.leftDead++; c.lastLeave = 'destroyed / crew gone'; this.removeFromConvoy(c, i); continue; }
        if (forming) continue;
        if (a.stuckRepeat >= 2 || lagging) {
          if (a.stuckRepeat >= 2) this.stats.leftStuck++; else this.stats.leftLag++;
          c.lastLeave = a.stuckRepeat >= 2 ? 'stuck (may rejoin)' : 'fell behind (may rejoin)';
          this.pendConv[v.id] = c.id; this.pendUntil[v.id] = time + 75;
          this.lagSince[v.id] = 0;
          this.removeFromConvoy(c, i);
          continue;
        }
        // The head's own task has it stop short of the destination (a fight, a new position): the column waits
        // 20 s, then the head drops out and the next vehicle leads on.
        if (i === 0 && this.ownHold[v.id] && Math.hypot(c.destX - v.pos.x, c.destZ - v.pos.z) > 60) {
          if (c.leadDivT === 0) c.leadDivT = time;
          else if (time - c.leadDivT > 20) { c.leadDivT = 0; c.lastLeave = 'leader stopped for its own task'; this.stats.leaderLeft++; this.rejoinAt[v.id] = time + 30; this.removeFromConvoy(c, 0); continue; }
        } else if (i === 0) c.leadDivT = 0;
        // A follower travelling with the column toward a nearby but different position of the same job (another
        // firing position of the operation) branches off once its own position is nearer than the column's end.
        // (Only at the end of the journey: the head within 150 m of the destination.)
        if (i > 0 && c.state === 'moving') {
          const head = list[c.vehicles[0]];
          const sep = Math.hypot(this.ownX[v.id] - c.destX, this.ownZ[v.id] - c.destZ);
          if (sep > 60 && sep < 250 && (head.pos.x - c.destX) ** 2 + (head.pos.z - c.destZ) ** 2 < 150 * 150 &&
            Math.hypot(this.ownX[v.id] - v.pos.x, this.ownZ[v.id] - v.pos.z) < sep) {
            this.stats.branched++; c.lastLeave = 'arrived'; this.removeFromConvoy(c, i); continue;
          }
        }
        // A follower whose own task has it stop here (its own destination) leaves the column there.
        if (i > 0 && this.ownHold[v.id] && Math.hypot(this.ownX[v.id] - v.pos.x, this.ownZ[v.id] - v.pos.z) < 25) {
          this.stats.leftHold++; c.lastLeave = 'arrived'; this.removeFromConvoy(c, i);
        }
      }
      if (c.count < 2) this.dissolve(c);
    }
    // Departures: a vehicle sets out when its destination jumps to somewhere far away (a new long trip).
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const a = v.alive && v.driver ? agents[v.driver.id] : null;
      if (!a) continue;
      const moved = (a.driveX - this.tripX[i]) ** 2 + (a.driveZ - this.tripZ[i]) ** 2 > 100 * 100;
      if (moved) {
        this.tripX[i] = a.driveX; this.tripZ[i] = a.driveZ;
        if ((a.driveX - v.pos.x) ** 2 + (a.driveZ - v.pos.z) ** 2 > CONVOY_TRIP * CONVOY_TRIP && !(v.def as any).static && v.def.kind === 'ground') { this.departAt[i] = time; this.whyAlone[i] = ''; this.depX[i] = v.pos.x; this.depZ[i] = v.pos.z; this.oppSeen[i] = 0; }
      }
    }
    // Rejoin: a separated member that has caught up with its convoy (still on the same journey) falls in at the tail.
    for (let i = 0; i < list.length; i++) {
      const ci = this.pendConv[i];
      if (ci < 0) continue;
      const v = list[i], c = this.convoys[ci];
      const a = v.alive && v.driver ? agents[v.driver.id] : null;
      if (!a || time > this.pendUntil[i] || !c.active || c.state !== 'moving' || this.convoyOf[i] >= 0) { if (!a || time > this.pendUntil[i] || !c.active) { this.pendConv[i] = -1; if (time > this.pendUntil[i]) this.stats.rejoinTimedOut++; } continue; }
      if ((a.driveX - c.destX) ** 2 + (a.driveZ - c.destZ) ** 2 > 250 * 250 || a.stuckRepeat >= 2 || c.count >= MAX_CONVOY) continue;
      const tail = list[c.vehicles[c.count - 1]];
      if ((tail.pos.x - v.pos.x) ** 2 + (tail.pos.z - v.pos.z) ** 2 < 90 * 90) { this.addToConvoy(c, v); c.joined--; this.pendConv[i] = -1; this.stats.rejoined++; }
    }
    // Planned convoys: vehicles setting out at about the same time, from the same place, for the same area,
    // travel together (a single vehicle just goes). A vehicle setting out may also join a convoy that is
    // still forming up nearby for the same destination. Nothing forms from vehicles merely passing each other.
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      // Formation funnel (evaluation): every long departure ends up in a convoy or alone for a recorded reason.
      if (this.departAt[i] > this.funnelSeen[i]) {
        if (time - this.departAt[i] > DEPART_WINDOW || this.convoyOf[v.id] >= 0) {
          this.funnelSeen[i] = this.departAt[i];
          const k = this.convoyOf[v.id] >= 0 ? 'in a convoy' : this.whyAlone[i] || 'not eligible (type / held / stuck)';
          if (this.convoyOf[v.id] >= 0 || this.oppSeen[i]) this.stats.opportunities++;
          this.stats.funnel[k] = (this.stats.funnel[k] || 0) + 1;
        }
      }
      if (this.convoyOf[v.id] >= 0 || this.pendConv[i] >= 0 || time < this.rejoinAt[v.id] || time - this.departAt[i] > DEPART_WINDOW || !this.eligible(v, agents)) continue;
      const a = agents[(v.driver as SoldierLike).id] as AgentLike;
      let c: ConvoyGroup | null = null;
      let why = 'no other vehicle of ours setting out within 20 s';
      for (let ci = 0; ci < this.convoys.length && !c; ci++) {
        const o = this.convoys[ci];
        if (!o.active || o.team !== v.team || o.state !== 'assembling' || o.count >= MAX_CONVOY) continue;
        if (!this.sameJourney(v, a.driveX, a.driveZ, list[o.vehicles[0]], o.destX, o.destZ)) continue;
        if ((v.pos.x - o.rallyX) ** 2 + (v.pos.z - o.rallyZ) ** 2 > 260 * 260) continue;
        c = o;
      }
      // Setting out just behind a convoy already on the move to the same place: fall in at its tail.
      for (let ci = 0; ci < this.convoys.length && !c; ci++) {
        const o = this.convoys[ci];
        if (!o.active || o.team !== v.team || o.state !== 'moving' || o.count >= MAX_CONVOY) continue;
        if (!this.sameJourney(v, a.driveX, a.driveZ, list[o.vehicles[0]], o.destX, o.destZ)) continue;
        const tail = list[o.vehicles[o.count - 1]];
        if ((v.pos.x - tail.pos.x) ** 2 + (v.pos.z - tail.pos.z) ** 2 > 140 * 140) continue;
        c = o; this.stats.joinedEnRoute++;
      }
      if (!c) {
        for (let j = 0; j < list.length; j++) {
          const w = list[j];
          if (w === v || w.team !== v.team || this.convoyOf[w.id] >= 0 || time < this.rejoinAt[w.id] || time - this.departAt[j] > LATE_WINDOW || !this.eligible(w, agents)) continue;
          const b = agents[(w.driver as SoldierLike).id] as AgentLike;
          if (!this.sameJourney(v, a.driveX, a.driveZ, w, b.driveX, b.driveZ)) { why = 'others setting out were going elsewhere'; continue; }
          this.oppSeen[i] = 1;
          // A partner that set out a little earlier (up to 45 s) on the same job, and is still near where it started,
          // is waited for / waits (bounded by the assembly limit); beyond that it is gone.
          const late = time - this.departAt[j] > DEPART_WINDOW;
          if (late && ((w.pos.x - this.depX[j]) ** 2 + (w.pos.z - this.depZ[j]) ** 2 > 150 * 150 || this.keyOf(v) < 0 || this.keyOf(v) !== this.keyOf(w))) { why = 'the vehicle on the same job set out too long before'; continue; }
          if ((v.pos.x - w.pos.x) ** 2 + (v.pos.z - w.pos.z) ** 2 > 160 * 160) { why = 'others going the same way started too far apart'; continue; }
          c = this.newConvoy(v.team, a.driveX, a.driveZ);
          if (!c) break;
          this.stats.formed++;
          if (late) this.stats.latePaired++;
          if ((a.driveX - b.driveX) ** 2 + (a.driveZ - b.driveZ) ** 2 > 150 * 150) this.stats.taskPaired++;
          this.addToConvoy(c, w);
          this.planRally(c, v);
          // The earlier one has left the base already: form up where it is (it waits there).
          if (late && (w.pos.x - this.depX[j]) ** 2 + (w.pos.z - this.depZ[j]) ** 2 > 40 * 40) { c.rallyX = w.pos.x; c.rallyZ = w.pos.z; }
          c.purpose = this.hooks ? this.hooks.purpose(v) : 'move up';
          break;
        }
      }
      if (c) this.addToConvoy(c, v);
      else this.whyAlone[i] = why;
    }
    // The order is set while forming up (by role) and frozen when the convoy moves off (front-most first, so nobody
    // has to overtake); it is not reshuffled on the move, where swapping places made vehicles jostle.
    for (let ci = 0; ci < this.convoys.length; ci++) if (this.convoys[ci].active && this.convoys[ci].state === 'assembling') this.orderConvoy(this.convoys[ci]);
    // Pennants (visual): which vehicles are in a planned convoy and whether it is still forming up.
    for (let i = 0; i < list.length; i++) {
      const ci = this.convoyOf[i];
      (list[i] as any).convoyFlag = ci < 0 ? 0 : this.convoys[ci].state === 'assembling' ? 1 : 2;
    }
  }

  /** The shared-task key of a vehicle's trip (see ConvoyHooks.taskKey). */
  private keyOf(v: VehicleLike): number { return this.hooks ? this.hooks.taskKey(v) : -1; }

  /**
   * Whether two vehicles make the same journey: they are headed for the same place (within 150 m), or they are on
   * the same job (operation / objective) with destinations close enough (240 m) to travel together and split at
   * the end. Being near each other is not enough.
   */
  private sameJourney(v: VehicleLike, vx: number, vz: number, w: VehicleLike, wx: number, wz: number): boolean {
    const d2 = (vx - wx) ** 2 + (vz - wz) ** 2;
    if (d2 <= 150 * 150) return true;
    if (d2 > 240 * 240) return false;
    const k = this.keyOf(v);
    if (k < 0 || k !== this.keyOf(w)) return false;
    // Both going the same way from here (not to opposite sides of the objective).
    return ((vx - v.pos.x) * (wx - w.pos.x) + (vz - v.pos.z) * (wz - w.pos.z)) > 0;
  }

  private eligible(v: VehicleLike, agents: (AgentLike | null)[]): boolean {
    if (!v.alive || v.def.kind !== 'ground' || (v.def as any).static || !v.driver || v.driver.isPlayer) return false;
    const arch = ARCHETYPE_OF[v.def.type];
    if (arch === Archetype.MLRS || arch === Archetype.HOWITZER || arch === Archetype.SAM) return false;
    const a = agents[v.driver.id];
    return !!a && !a.holdVehicle && a.stuckTotal < 2;
  }

  /**
   * Where a convoy forms up: leaving a base, on the road outside the gate nearest the way to its destination
   * (not in the vehicle park's lanes); elsewhere, where its first vehicle is.
   */
  private planRally(c: ConvoyGroup, v: VehicleLike): void {
    const bases = ((this.game.map as any).bases || []) as { x: number; z: number; gates?: { x: number; z: number }[] }[];
    const b = bases[v.team];
    c.rallyX = v.pos.x; c.rallyZ = v.pos.z;
    if (!b || !b.gates || (v.pos.x - b.x) ** 2 + (v.pos.z - b.z) ** 2 > 440 * 440) return;
    let best = -1, bd = 1e12;
    for (let k = 0; k < b.gates.length; k++) {
      const gt = b.gates[k], d = Math.hypot(gt.x - c.destX, gt.z - c.destZ) + Math.hypot(gt.x - v.pos.x, gt.z - v.pos.z) * 0.5;
      if (d < bd) { bd = d; best = k; }
    }
    if (best < 0) return;
    const gt = b.gates[best];
    let ox = gt.x - b.x, oz = gt.z - b.z;
    const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
    for (const r of [45, 35, 60]) {
      const x = gt.x + ox * r, z = gt.z + oz * r;
      if (!this.game.nav.blocked(x, z, true)) { c.rallyX = x; c.rallyZ = z; return; }
    }
  }

  /** Planned convoys of a side, one line each (operations panel). */
  convoyPanel(team: number): string {
    const L: string[] = [], list = this.game.vehicles.list;
    for (const c of this.convoys) {
      if (!c.active || c.team !== team || c.count < 2) continue;
      const lead = list[c.vehicles[0]];
      const d = Math.hypot(c.destX - lead.pos.x, c.destZ - lead.pos.z);
      L.push(`Convoy ${c.id} (${c.count}): ${c.purpose} → ${c.destName} — ${c.state === 'assembling' ? `forming up (${(this.game.time - c.formedT).toFixed(0)} s)` : `on the move, ${d.toFixed(0)} m to go`}`);
    }
    return L.join('\n');
  }

  /** Name of the objective nearest a point (for the convoy's stated destination). */
  flagName(x: number, z: number): string {
    let best = '', bd = 1e12;
    for (const f of this.game.capture.flags) { const d = (f.x - x) ** 2 + (f.z - z) ** 2; if (d < bd) { bd = d; best = (f as any).name || ''; } }
    return bd < 250 * 250 ? best : 'open ground';
  }

  private newConvoy(team: number, x: number, z: number): ConvoyGroup | null {
    for (let ci = 0; ci < this.convoys.length; ci++) {
      const c = this.convoys[ci];
      if (c.active) continue;
      c.active = true; c.team = team; c.count = 0; c.formation = Formation.COLUMN; c.destX = x; c.destZ = z;
      c.formedT = this.game.time; c.travel = 0; c.lastLX = NaN; c.lastLeave = '';
      c.contactUntil = 0; c.drillDone = false;
      c.state = 'assembling'; c.purpose = ''; c.joined = 0; c.departT = 0; c.rallyX = x; c.rallyZ = z; c.waitT = 0; c.leadDivT = 0; c.maxGap = 0;
      c.destName = this.flagName(x, z);
      return c;
    }
    return null;
  }

  private addToConvoy(c: ConvoyGroup, v: VehicleLike): void {
    if (this.convoyOf[v.id] >= 0 || c.count >= 8) return;
    c.vehicles[c.count++] = v.id;
    this.convoyOf[v.id] = c.id;
    c.joined++;

    this.stats.convoyJoins++;
  }

  /** A member drives on alone (and may not join a column for `wait` seconds). */
  private leaveConvoy(c: ConvoyGroup, i: number, time: number, wait: number): void {
    const id = c.vehicles[i];
    this.rejoinAt[id] = time + wait;
    this.lagSince[id] = 0;
    this.removeFromConvoy(c, i);
    if (c.count < 2) this.dissolve(c);
  }

  private removeFromConvoy(c: ConvoyGroup, i: number): void {
    this.convoyOf[c.vehicles[i]] = -1;
    for (let k = i; k < c.count - 1; k++) c.vehicles[k] = c.vehicles[k + 1];
    c.vehicles[--c.count] = -1;
  }

  private dissolve(c: ConvoyGroup): void {
    // Outcome of a genuine convoy (together at least 30 s and 150 m): arrived together, or broke up and why.
    const list = this.game.vehicles.list, st = this.stats;
    if (c.departT > 0 && c.travel >= 150) {
      const lead = c.count > 0 ? list[c.vehicles[0]] : null;
      const arrived = c.lastLeave === 'arrived' || (lead !== null && (lead.pos.x - c.destX) ** 2 + (lead.pos.z - c.destZ) ** 2 < 80 * 80);
      st.genuine++;
      if (arrived) st.genuineArrived++;
      else st.genuineBroke[c.lastLeave || 'unknown'] = (st.genuineBroke[c.lastLeave || 'unknown'] || 0) + 1;
      st.genuineKm += c.travel / 1000;
      st.genuineMembers += c.joined;
    } else { st.brief++; if (c.departT === 0) st.neverDeparted++; }
    for (let i = 0; i < c.count; i++) this.convoyOf[c.vehicles[i]] = -1;
    c.count = 0; c.active = false;
  }

  /** Insertion sort by role rank, then by distance to the destination (keys in a scratch array). */
  private orderConvoy(c: ConvoyGroup): void {
    const list = this.game.vehicles.list, keys = CONVOY_KEYS;
    for (let i = 0; i < c.count; i++) {
      const v = list[c.vehicles[i]];
      keys[i] = ROLE_RANK[ARCHETYPE_OF[v.def.type]] * 1000 + Math.hypot(v.pos.x - c.destX, v.pos.z - c.destZ);
    }
    for (let i = 1; i < c.count; i++) {
      const id = c.vehicles[i], k = keys[i];
      let j = i - 1;
      while (j >= 0 && keys[j] > k) { c.vehicles[j + 1] = c.vehicles[j]; keys[j + 1] = keys[j]; j--; }
      c.vehicles[j + 1] = id; keys[j + 1] = k;
    }
  }

  private tickConvoys(agents: (AgentLike | null)[], time: number): void {
    const list = this.game.vehicles.list;
    for (let ci = 0; ci < this.convoys.length; ci++) {
      const c = this.convoys[ci];
      if (!c.active || c.count < 2) continue;
      // Contact: any crew with a visible enemy within 220 m.
      let contact = false;
      for (let i = 0; i < c.count && !contact; i++) {
        const v = list[c.vehicles[i]];
        for (let s = 0; s < v.seats.length; s++) {
          const o = v.seats[s];
          const a = o ? agents[o.id] : null;
          if (a && a.target && a.targetVisible && (a.target.pos.x - v.pos.x) ** 2 + (a.target.pos.z - v.pos.z) ** 2 < 220 * 220) { contact = true; break; }
        }
      }
      if (contact) {
        if (time > c.contactUntil) c.drillDone = false;
        c.contactUntil = time + 20;
      }
      const engaged = time < c.contactUntil;
      c.formation = engaged ? Formation.WEDGE : Formation.COLUMN;
      if (engaged && !c.drillDone && this.hooks) {
        // Contact drill: the vanguard smokes and the air defence scans, but the column keeps going (firing on the
        // move, wedge, reduced speed). Only a carrier that is itself in danger (see carrierThreatened) unloads.
        c.drillDone = true;
        this.stats.drills++;
        this.hooks.popSmoke(list[c.vehicles[0]]);
        for (let i = 0; i < c.count; i++) { const v = list[c.vehicles[i]]; if (ARCHETYPE_OF[v.def.type] === Archetype.SPAAG) this.hooks.scanSky(v); }
      }
      if (engaged && this.hooks) {
        for (let i = 0; i < c.count; i++) {
          const v = list[c.vehicles[i]], arch = ARCHETYPE_OF[v.def.type];
          if ((arch === Archetype.APC || arch === Archetype.IFV || arch === Archetype.TRUCK) && this.carrierThreatened(v, agents)) {
            if (this.hooks.dismountPassengers(v) > 0) this.stats.drillDismounts++;
          }
        }
      }
      const lead = list[c.vehicles[0]];
      if (c.state === 'halted') {
        if (time - c.haltT > c.haltS) {
          if (c.viaHalt) { c.viaHalt = false; c.via = false; c.state = 'moving'; c.legs++; this.stats.journeyLegs++; this.orderForDeparture(c); }
          else this.nextLeg(c, time);
        }
        continue;
      }
      if (c.state === 'assembling') {
        // Forming up at the rally point: move off when everyone is there (or after a time limit, without the late).
        let ready = 0;
        for (let i = 0; i < c.count; i++) { const v = list[c.vehicles[i]]; if ((v.pos.x - c.rallyX) ** 2 + (v.pos.z - c.rallyZ) ** 2 < 45 * 45) ready++; }
        if (ready >= c.count || time - c.formedT > ASSEMBLE_MAX) {
          c.state = 'moving'; c.departT = time; this.stats.departed++; this.stats.assembleWait += time - c.formedT;
          if (c.legs === 0) this.planStopover(c, time);
          c.formedT = time;
          this.orderForDeparture(c);
          c.trailCount = 0; c.leaderId = -1;
        }
        continue;
      }
      c.record(lead.id, lead.pos.x, lead.pos.z);
      if (!Number.isNaN(c.lastLX)) c.travel += Math.hypot(lead.pos.x - c.lastLX, lead.pos.z - c.lastLZ);
      c.lastLX = lead.pos.x; c.lastLZ = lead.pos.z;
      // Leader speed: the slowest member's pace; ease off when the tail opens up, stop and wait for it when it
      // falls well behind (a member that cannot catch up within 25 s is separated, see formConvoys).
      let cap = 1e9, worst = 0;
      for (let i = 0; i < c.count; i++) {
        const v = list[c.vehicles[i]];
        cap = Math.min(cap, v.def.maxSpeed);
        if (i === 0) continue;
        const ahead = list[c.vehicles[i - 1]], want = this.gapFor(ahead, v);
        const gap = Math.hypot(v.pos.x - ahead.pos.x, v.pos.z - ahead.pos.z);
        if (gap > c.maxGap) c.maxGap = gap;
        const lag = Math.max(0, gap - want);
        if (lag > worst) worst = lag;
        if (lag > want * 2.5) { if (this.lagSince[v.id] === 0) this.lagSince[v.id] = time; } else this.lagSince[v.id] = 0;
      }
      c.speedCap = cap * (engaged ? 0.6 : 0.8);
      const spacing = AI_TUNING.convoySpacing;
      if (!engaged && worst > spacing * 2.5) { c.speedCap = 0; if (c.waitT === 0) { c.waitT = time; this.stats.waits++; } }
      else {
        c.waitT = 0;
        // Elastic: the head eases off in proportion to how far the tail has fallen back (no stop-go).
        if (!engaged && worst > spacing * 0.5) c.speedCap *= Math.max(0.3, Math.min(1, 1 - (worst - spacing * 0.5) / (spacing * 2.2)));
      }
      // End of a leg: the column halts there while members do their jobs (troops off, a resupply, a look round).
      if (c.via && Math.hypot(lead.pos.x - c.viaX, lead.pos.z - c.viaZ) < 55) {
        c.state = 'halted'; c.viaHalt = true; c.haltT = time; c.haltS = 15 + hash01(c.id, 3) * 20; this.stats.stopovers++;
      } else if (Math.hypot(lead.pos.x - c.destX, lead.pos.z - c.destZ) < 60) {
        c.state = 'halted'; c.haltT = time; c.haltS = 18 + hash01(c.id, c.legs) * 22; this.stats.legHalts++;
      }
    }
  }

  /**
   * A long trip may be made as a journey with a stopover: a friendly flag roughly halfway along the route, where the
   * column halts to regroup before the last leg. Q1–Q5 (organic, so not every convoy does it): a trip long enough
   * (> 650 m), not in contact, a flag of ours near the line to stop at, a column of several vehicles or a mood for it.
   */
  private planStopover(c: ConvoyGroup, time: number): void {
    c.via = false;
    const lead = this.game.vehicles.list[c.vehicles[0]];
    const sx = lead.pos.x, sz = lead.pos.z, dx = c.destX - sx, dz = c.destZ - sz, L = Math.hypot(dx, dz);
    if (L < 650) return;
    const ux = dx / L, uz = dz / L;
    const flags = this.game.capture.flags;
    const D = this.delib.begin(c.id + 700, time, hash01(c.id, 13), 0);
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f.owner !== c.team) continue;
      const t = (f.x - sx) * ux + (f.z - sz) * uz, off = Math.abs((f.x - sx) * -uz + (f.z - sz) * ux);
      if (t > L * 0.3 && t < L * 0.75 && off < 280) D.propose(i, -off);
    }
    for (let i = D.next(); i >= 0; i = D.next()) {
      const f = flags[i];
      const contested = f.contestedBy >= 0 && f.contestedBy !== c.team;
      const r = D.check(true, time >= c.contactUntil, 0.35 + hash01(c.id, 17) * 0.35 + (c.count >= 4 ? 0.2 : 0), !contested, true);
      if (r === 0) {
        D.choose(i);
        // Halt just off the flag on the near side (not in the capture circle, out of the way of the road).
        c.via = true; c.viaX = f.x - ux * 45; c.viaZ = f.z - uz * 45;
        if (this.game.nav.blocked(c.viaX, c.viaZ, true)) { c.viaX = f.x; c.viaZ = f.z; }
        return;
      }
    }
    D.none();
  }

  /**
   * After a halt: does the journey go on? The members' own tasks now point somewhere; when several of them point
   * the same way, far enough to be worth a column, the convoy forms up again and travels the next leg together
   * (Q1–Q5: a shared destination, a leg long enough to need it, protection that pays — contested ground on the
   * way or an armoured escort in the group —, all of them fit to drive). Otherwise (or after three legs) it breaks
   * up and each goes its own way. Organic: each convoy's temper and the mood term make it vary.
   */
  private nextLeg(c: ConvoyGroup, time: number): void {
    const list = this.game.vehicles.list;
    let bestN = 0, bx = 0, bz = 0;
    for (let i = 0; i < c.count; i++) {
      const vi = c.vehicles[i], v = list[vi], tx = this.ownX[vi], tz = this.ownZ[vi];
      if (!v.alive || (tx - v.pos.x) ** 2 + (tz - v.pos.z) ** 2 < 350 * 350) continue;
      let n = 0, sx = 0, sz = 0;
      for (let k = 0; k < c.count; k++) {
        const wk = c.vehicles[k];
        if ((this.ownX[wk] - tx) ** 2 + (this.ownZ[wk] - tz) ** 2 < 250 * 250 && list[wk].alive) { n++; sx += this.ownX[wk]; sz += this.ownZ[wk]; }
      }
      if (n > bestN) { bestN = n; bx = sx / n; bz = sz / n; }
    }
    const lead = list[c.vehicles[0]];
    const D = this.delib.begin(c.id + 500, time, hash01(c.id, 91), 0);
    D.propose(0, bestN); D.propose(1, 1);
    let go = false;
    for (let k = D.next(); k >= 0; k = D.next()) {
      if (k === 1) { D.check(true, true, true, true, true); D.choose(1); break; }
      let escort = false, fit = true, enemy = 0;
      for (let i = 0; i < c.count; i++) {
        const vi = c.vehicles[i], v = list[vi];
        if ((this.ownX[vi] - bx) ** 2 + (this.ownZ[vi] - bz) ** 2 >= 250 * 250) continue;
        const ar = ARCHETYPE_OF[v.def.type];
        if (ar === Archetype.MBT || ar === Archetype.IFV || ar === Archetype.LT || ar === Archetype.HT || ar === Archetype.SPAAG) escort = true;
        if (v.health < v.def.health * 0.5) fit = false;
      }
      // Contested ground on the way: enemy-held or contested flags near the leg's midpoint.
      const mx = (lead.pos.x + bx) / 2, mz = (lead.pos.z + bz) / 2;
      for (const f of this.game.capture.flags) if ((f.owner >= 0 && f.owner !== c.team || f.contestedBy >= 0) && (f.x - mx) ** 2 + (f.z - mz) ** 2 < 500 * 500) enemy++;
      const legLen = Math.hypot(bx - lead.pos.x, bz - lead.pos.z);
      const r = D.check(bestN >= 2 && c.legs < 3, legLen > 350 ? 1 : 0.2, enemy > 0 || escort ? 1 : 0.45 + hash01(c.id, c.legs + 7) * 0.2, true, fit);
      if (r === 0) { D.choose(0); go = true; break; }
    }
    if (!go) { c.lastLeave = 'arrived'; this.dissolve(c); return; }
    // Next leg: members going elsewhere leave; the rest form up where they are and move off together.
    for (let i = c.count - 1; i >= 0; i--) {
      const vi = c.vehicles[i];
      if ((this.ownX[vi] - bx) ** 2 + (this.ownZ[vi] - bz) ** 2 >= 250 * 250 || !list[vi].alive) this.leaveConvoy(c, i, time, 20);
    }
    if (c.count < 2) { c.lastLeave = 'arrived'; this.dissolve(c); return; }
    c.legs++; this.stats.journeyLegs++;
    c.destX = bx; c.destZ = bz;
    c.rallyX = list[c.vehicles[0]].pos.x; c.rallyZ = list[c.vehicles[0]].pos.z;
    c.state = 'assembling'; c.formedT = time;
  }

  /** Interval a follower keeps behind the vehicle ahead: room for both hulls plus a margin. */
  private gapFor(ahead: VehicleLike, v: VehicleLike): number {
    return 12 + ahead.def.half[2] + v.def.half[2] + Math.min(8, Math.max(0, ahead.speed) * 0.6);
  }

  /** Moving off: front-most first along the way out, so no vehicle has to overtake another to take its place. */
  private orderForDeparture(c: ConvoyGroup): void {
    const list = this.game.vehicles.list, keys = CONVOY_KEYS;
    let dx = c.destX - c.rallyX, dz = c.destZ - c.rallyZ;
    const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    for (let i = 0; i < c.count; i++) { const v = list[c.vehicles[i]]; keys[i] = -((v.pos.x - c.rallyX) * dx + (v.pos.z - c.rallyZ) * dz); }
    for (let i = 1; i < c.count; i++) {
      const id = c.vehicles[i], k = keys[i];
      let j = i - 1;
      while (j >= 0 && keys[j] > k) { c.vehicles[j + 1] = c.vehicles[j]; keys[j + 1] = keys[j]; j--; }
      c.vehicles[j + 1] = id; keys[j + 1] = k;
    }
  }

  /**
   * A carrier in real danger, i.e. its passengers are better off fighting on foot: a crewman sees an AT
   * soldier or heavy armour, or any enemy within 120 m, or the hull is taking hits. Distant contact is
   * not a reason to put a squad out on the road far from where it is going.
   */
  private carrierThreatened(v: VehicleLike, agents: (AgentLike | null)[]): boolean {
    if (v.health < v.def.health * 0.6) return true;
    for (let s = 0; s < v.seats.length; s++) {
      const o = v.seats[s], a = o ? agents[o.id] : null;
      if (!a || !a.target || !a.targetVisible) continue;
      const t = a.target, d2 = (t.pos.x - v.pos.x) ** 2 + (t.pos.z - v.pos.z) ** 2;
      if (d2 < 120 * 120) return true;
      if (t.kind === 'soldier' ? (t as SoldierLike).launcher !== null && d2 < 250 * 250 : (t as VehicleLike).def.armor === 'heavy' && d2 < 600 * 600) return true;
    }
    return false;
  }

  /** Unit direction of travel: toward the convoy destination, or the leader's heading on arrival. */
  private routeDir(c: ConvoyGroup, lead: VehicleLike, out: Float32Array): void {
    const dx = c.destX - lead.pos.x, dz = c.destZ - lead.pos.z, d = Math.hypot(dx, dz);
    if (d > 30) { out[0] = dx / d; out[1] = dz / d; } else { out[0] = Math.sin(lead.yaw); out[1] = Math.cos(lead.yaw); }
  }

  /**
   * Overrides a convoy follower's destination with its formation slot and
   * matches its speed to the vehicle ahead; caps the leader to the slowest
   * member. Called by the vehicle orchestrator after the crew controller.
   */
  applySlot(v: VehicleLike, a: AgentLike): void {
    const ci = this.convoyOf[v.id];
    if (ci < 0) return;
    const c = this.convoys[ci];
    if (!c.active) return;
    const list = this.game.vehicles.list, time = this.game.time;
    // What the vehicle's own task wants (kept for the relevance checks; the convoy overrides it below).
    const ox = a.driveX, oz = a.driveZ;
    this.ownX[v.id] = ox; this.ownZ[v.id] = oz; this.ownHold[v.id] = a.holdVehicle ? 1 : 0;
    let idx = 0;
    for (let i = 0; i < c.count; i++) if (c.vehicles[i] === v.id) { idx = i; break; }
    // Halted at the end of a leg: each vehicle does its own job there (the column decides afterwards whether
    // the journey goes on).
    if (c.state === 'halted') {
      // A stopover: everyone stays put in the column (a look round, stragglers close up) until it moves on.
      if (c.viaHalt) { a.holdVehicle = true; a.speedCap = 0; a.driveX = v.pos.x; a.driveZ = v.pos.z; }
      return;
    }
    if (c.state === 'assembling') {
      // Form up in column at the rally point, in order, facing the way out; hold there until the convoy moves.
      if (idx === 0) { c.destX = ox; c.destZ = oz; }
      const dx = c.destX - c.rallyX, dz = c.destZ - c.rallyZ, d = Math.hypot(dx, dz) || 1;
      // Two ranks of three abreast on the road outside the gate (never back through the gate into the park's lanes).
      const row = Math.floor(idx / 3), col = (idx % 3) - 1, back = 16 + v.def.half[2];
      let tx = c.rallyX - (dx / d) * back * row + (-dz / d) * col * 10, tz = c.rallyZ - (dz / d) * back * row + (dx / d) * col * 10;
      // A slot on blocked ground (the base wall, a building) moves sideways to the nearest open spot.
      if (this.game.nav.blocked(tx, tz, true)) {
        for (const off of [7, -7, 14, -14]) { const x = tx + (-dz / d) * off, z = tz + (dx / d) * off; if (!this.game.nav.blocked(x, z, true)) { tx = x; tz = z; break; } }
      }
      a.driveX = tx; a.driveZ = tz; a.pursuit = false;
      a.holdVehicle = Math.hypot(tx - v.pos.x, tz - v.pos.z) < 10;
      if (a.holdVehicle) a.faceYaw = Math.atan2(dx, dz);
      return;
    }
    // Is the journey still this vehicle's? Its own task must keep pointing at the convoy's destination; a change
    // has to last 8 s before it counts (a goal flickering for a moment is not a reason to leave the column).
    const away = (ox - c.destX) ** 2 + (oz - c.destZ) ** 2 > 250 * 250;
    if (!away) {
      this.divT[v.id] = 0;
      // The head's own goal refined nearby (a re-planned drop point, a firing position): the journey ends there.
      if (idx === 0) { c.destX = ox; c.destZ = oz; }
    }
    else if (this.divT[v.id] === 0) this.divT[v.id] = time;
    else if (time - this.divT[v.id] > 8) {
      this.divT[v.id] = 0;
      if (idx === 0) {
        // The head's task moved: if most of the column is going the same new way, the whole convoy re-routes;
        // otherwise the head leaves and the next vehicle leads on.
        let same = 0;
        for (let i = 1; i < c.count; i++) { const o = c.vehicles[i]; if ((this.ownX[o] - ox) ** 2 + (this.ownZ[o] - oz) ** 2 < 200 * 200) same++; }
        if (same * 2 >= c.count - 1) { c.destX = ox; c.destZ = oz; c.destName = this.flagName(ox, oz); this.stats.rerouted++; }
        else { c.lastLeave = 'leader re-tasked elsewhere'; this.stats.leaderLeft++; this.leaveConvoy(c, 0, time, 30); return; }
      } else { c.lastLeave = 'its destination diverged'; this.leaveConvoy(c, idx, time, 45); this.stats.convoyDiverged++; return; }
    }
    if (idx === 0) {
      // The head drives the shared journey (not its own flickering standoff point), at the column's pace; via the
      // stopover first when there is one.
      a.driveX = c.via ? c.viaX : c.destX; a.driveZ = c.via ? c.viaZ : c.destZ;
      if (!a.holdVehicle) a.speedCap = Math.min(a.speedCap, c.speedCap);
      return;
    }
    const lead = list[c.vehicles[0]], ahead = list[c.vehicles[idx - 1]];
    const want = this.gapFor(ahead, v);
    a.holdVehicle = false;
    // Station keeping is the convoy's job: the driver's "do not shuffle a few metres" rule does not apply here.
    (a as any).settled = false;
    this.routeDir(c, lead, _c2);
    const lfx = _c2[0], lfz = _c2[1];
    const gapAhead = Math.hypot(ahead.pos.x - v.pos.x, ahead.pos.z - v.pos.z);
    let tx = 0, tz = 0, slot = false;
    if (c.formation !== Formation.COLUMN) {
      // Contact: wedge / line slots on the leader (skipped when the slot is not drivable).
      const rank = Math.ceil(idx / 2), side = idx % 2 === 1 ? 1 : -1;
      const lat = 14 * rank * side, back = c.formation === Formation.WEDGE ? 12 * rank : 0;
      tx = lead.pos.x + lfz * lat - lfx * back; tz = lead.pos.z - lfx * lat - lfz * back;
      slot = !this.game.nav.blocked(tx, tz, true);
    }
    if (!slot) {
      // Column: follow the leader's actual track, one interval behind the vehicle ahead (wherever that one is
      // on the track), not a fixed slot behind the leader, so a slow vehicle ahead is followed, not overtaken.
      const aheadOfLead = idx > 0 && (v.pos.x - lead.pos.x) * lfx + (v.pos.z - lead.pos.z) * lfz > 8;
      if (aheadOfLead) { a.speedCap = 0; return; }
      let dA = ahead === lead ? 0 : c.trailDistOf(lead.pos.x, lead.pos.z, ahead.pos.x, ahead.pos.z);
      if (dA < 0) dA = Math.hypot(ahead.pos.x - lead.pos.x, ahead.pos.z - lead.pos.z);
      if (c.trailPoint(lead.pos.x, lead.pos.z, Math.max(0, dA + want - 10), _c2)) { tx = _c2[0]; tz = _c2[1]; }
      else {
        const dx = v.pos.x - ahead.pos.x, dz = v.pos.z - ahead.pos.z, d = Math.hypot(dx, dz) || 1;
        tx = ahead.pos.x + (dx / d) * want; tz = ahead.pos.z + (dz / d) * want;
      }
    }
    a.driveX = tx; a.driveZ = tz;
    const dP = Math.hypot(tx - v.pos.x, tz - v.pos.z);
    a.pursuit = dP < 60 && this.game.nav.lineClear(v.pos.x, v.pos.z, tx, tz, true);
    // Speed: the vehicle ahead's, corrected by the gap error (closes up when behind, drops back when too close).
    const aheadSpeed = Math.max(0, ahead.speed);
    if (idx === 1) {
      // Second vehicle: speed of the leader corrected by the gap (unchanged two-vehicle behaviour).
      if (gapAhead < want * 0.55) { a.speedCap = 0; return; }
      const cap = aheadSpeed + (gapAhead - want) * 0.45;
      a.speedCap = cap < 0.8 ? 0 : Math.max(2, Math.min(v.def.maxSpeed, cap));
      return;
    }
    // Third and later vehicles: an elastic chain instead of stop-go. Predecessor speed plus a damped gap
    // correction (closing speed counts, so the gap is not overshot), blended with the head's speed so a
    // slow-down at the front does not amplify down the column (the accordion); only a gap under 45 % of the
    // interval brakes to a stop, between 45 and 70 % the vehicle eases off instead.
    const err = gapAhead - want, rel = aheadSpeed - Math.max(0, v.speed);
    if (gapAhead < want * 0.45) { a.speedCap = 0; this.stats.chainStops++; return; }
    let cap = aheadSpeed + err * 0.32 + rel * 0.5;
    cap = 0.7 * cap + 0.3 * (Math.max(0, lead.speed) + err * 0.32);
    if (gapAhead < want * 0.7) cap = Math.min(cap, aheadSpeed * 0.6);
    a.speedCap = cap < 0.6 ? 0 : Math.max(1.5, Math.min(v.def.maxSpeed, cap));
  }
}

const SCRATCH_IDS = new Int32Array(64);
