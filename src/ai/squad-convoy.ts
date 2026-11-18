import { AgentStateBuffers } from './agent-state.ts';
import { TacticalRadioBus } from './radio-bus.ts';
import { CoverField, FoliageField } from './terrain-analysis.ts';
import { PosMode, PositionPlan, planSquadPositions } from './positions.ts';
import {
  AI_TUNING, Archetype, ARCHETYPE_OF, Formation, Logistics, Order, Posture, RadioType, SoldierClass, hash01,
} from './types.ts';
import type { AgentLike, FlagLike, GameLike, SoldierLike, VehicleLike } from './types.ts';

const MAX_MEMBERS = 8;
const MAX_CONTACTS = 12;
/** Breadcrumb trail length (points ~3 m apart). */
const TRAIL = 64;
/** Largest column the manager assembles. */
const MAX_CONVOY = 6;
export const SquadKind = { INFANTRY: 0, CREW: 1 } as const;

/** Shared tactical picture of one fire team. */
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
  /** When the current garrison post was taken (a garrison is not given up again straight away). */
  garrisonT = -1e3;
  /** Fighting positions for the members (by member index) and when / where they were planned. */
  readonly plan = new PositionPlan();
  planX = 1e9; planZ = 1e9; planMode = -1; planTime = -100;
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
  contactUntil = 0;
  drillDone = false;
  speedCap = 0;
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

/** Hooks into the vehicle orchestrator used by convoy drills (avoids an import cycle). */
export interface ConvoyHooks {
  popSmoke(v: VehicleLike): void;
  dismountPassengers(v: VehicleLike): number;
  scanSky(v: VehicleLike): void;
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
  /** Per vehicle: since when it has trailed its predecessor by more than 4 intervals (0 = keeping up). */
  readonly lagSince: Float32Array;
  /** Per vehicle: earliest time it may join a convoy again (after being dropped as a straggler). */
  readonly rejoinAt: Float32Array;
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
  /** Convoy members: best distance to their own destination while in the column, and when it last improved. */
  private readonly convBest: Float32Array;
  private readonly convBestAt: Float32Array;
  /** Convoy membership counters (evaluation). */
  readonly stats = { convoyJoins: 0, convoyDiverged: 0, convoyStalled: 0, leftHold: 0, leftStuck: 0, leftLag: 0, leftDead: 0, drills: 0, drillDismounts: 0, formed: 0 };

  constructor(game: GameLike, st: AgentStateBuffers, radio: TacticalRadioBus, cover: CoverField, foliage: FoliageField) {
    this.game = game; this.st = st; this.radio = radio; this.cover = cover; this.foliage = foliage;
    this.objectiveBias = [new Float32Array(game.capture.flags.length), new Float32Array(game.capture.flags.length)];
    this.convoyOf = new Int32Array(game.vehicles.list.length).fill(-1);
    this.convBest = new Float32Array(game.vehicles.list.length); this.convBestAt = new Float32Array(game.vehicles.list.length);
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
    if (stale && q.order === Order.NONE) this.chooseObjective(q, time);
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
    if (mode === q.planMode && time - q.planTime < 9 && (q.planX - px) ** 2 + (q.planZ - pz) ** 2 < 16) return;
    let yaw = q.threatYaw;
    if (contacts > 0 && q.contactCentroid(time, 8, _c2) > 0) yaw = Math.atan2(_c2[0] - px, _c2[1] - pz);
    const soldiers = this.game.soldiers;
    for (let k = 0; k < q.count; k++) CLS[k] = soldiers[q.members[k]].cls;
    const fx = mode === PosMode.SUPPORT && q.objective ? q.objective.x : px;
    const fz = mode === PosMode.SUPPORT && q.objective ? q.objective.z : pz;
    const radius = mode === PosMode.HOLD ? 24 : mode === PosMode.SUPPORT ? 22 : 34;
    planSquadPositions(this.game, this.cover, this.foliage, mode, px, pz, radius, yaw, fx, fz, AI_TUNING.captureRadius,
      q.count, CLS, q.id * 7 + Math.floor(time / 30), q.plan);
    q.planMode = mode; q.planTime = time; q.planX = px; q.planZ = pz;
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

  private chooseObjective(q: SquadBlackboard, time: number): void {
    const flags = this.game.capture.flags, bias = this.objectiveBias[q.team];
    let best: FlagLike | null = null, bestScore = 1e9;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      // The commander's priorities: metres added to (or taken off) this flag's distance; ≥ 1e5 = leave it alone.
      if (q.kind === SquadKind.INFANTRY && bias[i] >= 1e5) continue;
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
      if (score < bestScore) { bestScore = score; best = f; }
    }
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

  /** Combined-arms requests raised by the squad as a whole. */
  private raiseRequests(q: SquadBlackboard, contacts: number, time: number): void {
    const leader = q.leader;
    let spotter = false;
    for (let i = 0; i < q.count; i++) {
      const s = this.game.soldiers[q.members[i]];
      if (s.alive && s.cls === SoldierClass.SPOTTER && !s.vehicle) { spotter = true; break; }
    }
    if (contacts >= 2 && q.suppressionAvg > 0.45 && time > q.nextFireMission) {
      q.contactCentroid(time, 8, _c2);
      const y = this.game.map.terrain.height(_c2[0], _c2[1]);
      if (this.radio.publish(RadioType.FIRE_MISSION, q.team, leader, q.id, _c2[0], y, _c2[1], -1, 2, time, 0, spotter)) q.nextFireMission = time + 25;
    }
    if (contacts >= 4 && time > q.nextCas) {
      q.contactCentroid(time, 8, _c2);
      const y = this.game.map.terrain.height(_c2[0], _c2[1]);
      const m = this.radio.publish(RadioType.CAS_REQUEST, q.team, leader, q.id, _c2[0], y, _c2[1], -1, 1, time, 0, spotter);
      if (m) { m.vx = _c2[0] - q.cx; m.vz = _c2[1] - q.cz; q.nextCas = time + 30; }
    }
    if (q.ammoAvg < 0.3 && time > q.nextLogistics) {
      if (this.radio.publish(RadioType.LOGISTICS_REQUEST, q.team, leader, q.id, q.cx, 0, q.cz, -1, 1, time, Logistics.AMMO)) q.nextLogistics = time + 30;
    }
    if (q.dismounted > 0 && q.dismounted <= 2 && contacts >= 2 && time > q.nextExtract) {
      const f = this.nearestFriendlyFlag(q);
      if (!f || Math.hypot(f.x - q.cx, f.z - q.cz) > 140) {
        if (this.radio.publish(RadioType.EXTRACT_REQUEST, q.team, leader, q.id, q.cx, 0, q.cz, -1, 1, time)) q.nextExtract = time + 60;
      }
    }
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
    // Drop finished members.
    for (let ci = 0; ci < this.convoys.length; ci++) {
      const c = this.convoys[ci];
      if (!c.active) continue;
      for (let i = c.count - 1; i >= 0; i--) {
        const v = list[c.vehicles[i]];
        const a = v.driver ? agents[v.driver.id] : null;
        // Arrived, dead, unmanned, wedged on terrain, or lagging for 30 s: leave the column so it never waits forever.
        const lagging = this.lagSince[v.id] > 0 && time - this.lagSince[v.id] > 30;
        if (!v.alive || !a || a.holdVehicle || a.stuckTotal >= 3 || lagging) {
          if (!v.alive || !a) this.stats.leftDead++; else if (a.holdVehicle) this.stats.leftHold++; else if (a.stuckTotal >= 3) this.stats.leftStuck++; else this.stats.leftLag++;
          // Stragglers sit out 30 s before they may join a column again.
          if (a && (a.stuckTotal >= 3 || lagging)) this.rejoinAt[v.id] = time + 30;
          this.lagSince[v.id] = 0;
          this.removeFromConvoy(c, i);
        }
      }
      if (c.count < 2) this.dissolve(c);
    }
    // Group idle candidates by team and destination corridor.
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (this.convoyOf[v.id] >= 0 || time < this.rejoinAt[v.id] || !this.eligible(v, agents)) continue;
      const a = agents[(v.driver as SoldierLike).id] as AgentLike;
      let c: ConvoyGroup | null = null;
      for (let j = 0; j < list.length; j++) {
        const w = list[j];
        if (w === v || w.team !== v.team || time < this.rejoinAt[w.id] || !this.eligible(w, agents)) continue;
        const b = agents[(w.driver as SoldierLike).id] as AgentLike;
        // Same destination corridor and genuinely together (not chained across the map).
        if ((a.driveX - b.driveX) ** 2 + (a.driveZ - b.driveZ) ** 2 > 120 * 120) continue;
        if ((v.pos.x - w.pos.x) ** 2 + (v.pos.z - w.pos.z) ** 2 > 70 * 70) continue;
        const existing = this.convoyOf[w.id];
        if (existing >= 0) {
          c = this.convoys[existing];
          const lead = list[c.vehicles[0]];
          if (c.count >= MAX_CONVOY || (lead.pos.x - v.pos.x) ** 2 + (lead.pos.z - v.pos.z) ** 2 > 120 * 120) { c = null; continue; }
          break;
        }
        c = this.newConvoy(v.team, a.driveX, a.driveZ);
        if (!c) break;
        this.stats.formed++;
        this.addToConvoy(c, w);
        break;
      }
      if (c) this.addToConvoy(c, v);
    }
    for (let ci = 0; ci < this.convoys.length; ci++) if (this.convoys[ci].active) this.orderConvoy(this.convoys[ci]);
  }

  private eligible(v: VehicleLike, agents: (AgentLike | null)[]): boolean {
    if (!v.alive || v.def.kind !== 'ground' || !v.driver || v.driver.isPlayer) return false;
    const arch = ARCHETYPE_OF[v.def.type];
    if (arch === Archetype.MLRS || arch === Archetype.HOWITZER || arch === Archetype.SAM) return false;
    const a = agents[v.driver.id];
    return !!a && !a.holdVehicle && a.stuckTotal < 2;
  }

  private newConvoy(team: number, x: number, z: number): ConvoyGroup | null {
    for (let ci = 0; ci < this.convoys.length; ci++) {
      const c = this.convoys[ci];
      if (c.active) continue;
      c.active = true; c.team = team; c.count = 0; c.formation = Formation.COLUMN; c.destX = x; c.destZ = z;
      c.contactUntil = 0; c.drillDone = false;
      return c;
    }
    return null;
  }

  private addToConvoy(c: ConvoyGroup, v: VehicleLike): void {
    if (this.convoyOf[v.id] >= 0 || c.count >= 8) return;
    c.vehicles[c.count++] = v.id;
    this.convoyOf[v.id] = c.id;
    this.convBestAt[v.id] = 0;
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
      c.record(lead.id, lead.pos.x, lead.pos.z);
      // Speed of the slowest member, then wait for the tail: crawl past 1.5 intervals of lag, stop past 3.
      let cap = 1e9, worst = 0;
      const spacing = AI_TUNING.convoySpacing;
      this.routeDir(c, lead, _c2);
      const rx = _c2[0], rz = _c2[1];
      for (let i = 0; i < c.count; i++) {
        const v = list[c.vehicles[i]];
        cap = Math.min(cap, v.def.maxSpeed);
        if (i === 0) continue;
        const dx = v.pos.x - lead.pos.x, dz = v.pos.z - lead.pos.z;
        let lag = 0;
        // Vehicles still ahead of the leader are waiting to fall in (timed out like laggers, never waited for).
        if (dx * rx + dz * rz > 6) lag = -1;
        else lag = Math.max(0, Math.hypot(dx, dz) - i * spacing * 1.25);
        if (lag > worst) worst = lag;
        if (lag < 0 || lag > spacing * 3) { if (this.lagSince[v.id] === 0) this.lagSince[v.id] = time; } else this.lagSince[v.id] = 0;
      }
      c.speedCap = cap * (engaged ? 0.6 : 0.8);
      if (!engaged && worst > spacing * 3) c.speedCap = 0;
      else if (!engaged && worst > spacing * 1.5) c.speedCap = Math.min(c.speedCap, 3);
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
    const list = this.game.vehicles.list;
    let idx = 0;
    for (let i = 0; i < c.count; i++) if (c.vehicles[i] === v.id) { idx = i; break; }
    if (idx === 0) { a.speedCap = Math.min(a.speedCap, c.speedCap); c.destX = a.driveX; c.destZ = a.driveZ; return; }
    // The follower's own destination (set by its controller this tick) decides whether the column still serves it:
    // leave when the column is going somewhere else, or when riding along has stopped bringing it closer.
    const time = this.game.time, ox = a.driveX, oz = a.driveZ;
    if ((ox - c.destX) ** 2 + (oz - c.destZ) ** 2 > 160 * 160) { this.leaveConvoy(c, idx, time, 45); this.stats.convoyDiverged++; return; }
    const dOwn = Math.hypot(ox - v.pos.x, oz - v.pos.z);
    if (this.convBestAt[v.id] === 0 || dOwn < this.convBest[v.id] - 8) { this.convBest[v.id] = dOwn; this.convBestAt[v.id] = time; }
    else if (time - this.convBestAt[v.id] > 45) { this.leaveConvoy(c, idx, time, 60); this.stats.convoyStalled++; return; }
    const lead = list[c.vehicles[0]], ahead = list[c.vehicles[idx - 1]];
    const spacing = AI_TUNING.convoySpacing;
    a.holdVehicle = false;
    this.routeDir(c, lead, _c2);
    const lfx = _c2[0], lfz = _c2[1];
    const gapAhead = Math.hypot(ahead.pos.x - v.pos.x, ahead.pos.z - v.pos.z);
    let tx = 0, tz = 0, slot = false;
    if (c.formation !== Formation.COLUMN) {
      // Contact: wedge / line slots on the leader (skipped when the slot is not drivable).
      const rank = Math.ceil(idx / 2), side = idx % 2 === 1 ? 1 : -1;
      const lat = 14 * rank * side, back = c.formation === Formation.WEDGE ? 12 * rank : 0;
      // Leader frame: +X left = (cos h, -sin h), forward = (sin h, cos h).
      tx = lead.pos.x + lfz * lat - lfx * back; tz = lead.pos.z - lfx * lat - lfz * back;
      slot = !this.game.nav.blocked(tx, tz, true);
    }
    if (!slot) {
      // Column: out-of-order vehicles ahead of the leader wait for the column to pass, then fall in.
      const aheadOfLead = (v.pos.x - lead.pos.x) * lfx + (v.pos.z - lead.pos.z) * lfz > 6;
      if (aheadOfLead) { a.speedCap = 0; return; }
      // Follow the leader's actual track, `idx` intervals back; before a trail exists, close on the vehicle ahead.
      if (c.trailPoint(lead.pos.x, lead.pos.z, idx * spacing, _c2)) { tx = _c2[0]; tz = _c2[1]; }
      else {
        const dx = v.pos.x - ahead.pos.x, dz = v.pos.z - ahead.pos.z, d = Math.hypot(dx, dz) || 1;
        tx = ahead.pos.x + (dx / d) * spacing; tz = ahead.pos.z + (dz / d) * spacing;
      }
      // Keep the interval: never reverse into a slot, just wait for the gap to open.
      const ex = tx - v.pos.x, ez = tz - v.pos.z, dT = Math.hypot(ex, ez);
      const behindMe = ex * Math.sin(v.yaw) + ez * Math.cos(v.yaw) < 0;
      if (gapAhead < spacing * 0.6 || (behindMe && dT < 25)) { a.speedCap = 0; return; }
    }
    // Pursue a point a little ahead of the slot (smooth following); speed governs the interval.
    if (!slot && c.trailPoint(lead.pos.x, lead.pos.z, Math.max(0, idx * spacing - 12), _c2)) { tx = _c2[0]; tz = _c2[1]; }
    a.driveX = tx; a.driveZ = tz;
    const dP = Math.hypot(tx - v.pos.x, tz - v.pos.z);
    a.pursuit = dP < 60 && this.game.nav.lineClear(v.pos.x, v.pos.z, tx, tz, true);
    const leadSpeed = Math.max(0, lead.speed);
    const cap = leadSpeed + (gapAhead - spacing) * 0.4;
    // Closing too fast or too close: hold; otherwise match the leader with a proportional correction.
    a.speedCap = cap < 0.6 ? 0 : Math.max(1.5, Math.min(v.def.maxSpeed, cap));
  }
}

const SCRATCH_IDS = new Int32Array(64);
