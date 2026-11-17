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
 * Theater commander (one per side). Reads the battlefield from what its
 * troops actually know (squad contact reports, contested flags, where its own
 * soldiers die), values every flag (ticket majority, road network, front
 * line), and runs operations with a stated reason:
 *
 *  SECURE       grab an empty / weakly held flag with a small detachment
 *  ASSAULT      concentrate force in a defiladed assembly area, prepare the
 *               objective with artillery / CAS / smoke, then attack on a main
 *               and a flanking axis with a support-by-fire element and armour
 *  DEFEND       reinforce a threatened flag
 *  AIR ASSAULT  helicopter insertion (land, fast-rope or parachute) onto a
 *               weakly held flag behind the line, or onto the far side of an
 *               assault objective (vertical envelopment)
 *
 * Failed assaults raise the objective's estimated hardness and put it on
 * cooldown, so the next plan either bypasses it (taking other flags to win
 * the ticket war) or comes back with more force, prep fires and a second axis.
 */

export const OpType = { SECURE: 0, ASSAULT: 1, DEFEND: 2, AIR_ASSAULT: 3 } as const;
export const OP_NAMES = ['SECURE', 'ASSAULT', 'DEFEND', 'AIR ASSAULT'] as const;
export const OpPhase = { ASSEMBLE: 0, PREP: 1, EXECUTE: 2, CONSOLIDATE: 3, DONE: 4, FAILED: 5 } as const;
export const PHASE_NAMES = ['assembling', 'prep fires', 'executing', 'consolidating', 'done', 'failed'] as const;
/** Role of a squad inside an operation. */
export const Task = { MAIN: 0, FLANK: 1, SUPPORT: 2, AIR: 3 } as const;

const MAX_OPS = 6;
const MAX_OP_SQUADS = 8;
/** Combat weight of vehicles by archetype (infantry = 1). */
const VEH_W = new Float32Array([6, 7, 4, 3, 4, 0.5, 0.5, 1, 1, 1, 2, 5, 1, 3, 1]);
const ARMOUR = new Uint8Array(15);
ARMOUR[Archetype.MBT] = 1; ARMOUR[Archetype.HT] = 1; ARMOUR[Archetype.LT] = 1; ARMOUR[Archetype.IFV] = 1;

export class Operation {
  id = 0; active = false; type = 0; phase = 0; flag = -1;
  start = 0; phaseTime = 0;
  /** Assembly area and the main axis (yaw from the objective toward it). */
  stageX = 0; stageZ = 0; mainYaw = 0;
  /** Attack positions: [0] main axis, [1] flanking axis. */
  readonly axisX = new Float32Array(2);
  readonly axisZ = new Float32Array(2);
  sbfX = 0; sbfZ = 0; hasSbf = false;
  readonly squads = new Int32Array(MAX_OP_SQUADS);
  readonly task = new Uint8Array(MAX_OP_SQUADS);
  nsq = 0;
  readonly vehicles = new Int32Array(6);
  nveh = 0;
  required = 0; enemyAtStart = 0; strengthAtStart = 0; lossMark = 0;
  progressAt = 0; bestV = 0; minDist = 1e9;
  prepUntil = 0; nextFireCall = 0; smoked = false;
  heli = -1; airSquad = -1; dropX = 0; dropZ = 0; method = 0; airStart = -1; airDone = false;
  reason = '';
}

const _p2 = new Float32Array(2);
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
  readonly stats = { planned: 0, succeeded: 0, failed: 0, airInsertions: 0 };
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
  private readonly fireFlag: Int32Array;
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
    for (let i = 0; i < MAX_OPS; i++) this.ops.push(new Operation());
  }

  reset(): void {
    for (const op of this.ops) if (op.active) this.close(op, OpPhase.DONE, '');
    this.enemyEst.fill(0); this.enemyNear.fill(0); this.myLoss.fill(0); this.enemyLoss.fill(0); this.hardness.fill(1);
    this.cooldown.fill(0); this.attempts.fill(0); this.vehOp.fill(-1); this.fireAt.fill(-1e3);
    this.journal.length = 0;
  }

  private note(text: string): void {
    this.journal.push(`${this.game.time.toFixed(0)}s ${text}`);
    if (this.journal.length > 12) this.journal.shift();
    if (this.emit) this.emit(this.team, text);
  }

  /** A soldier died: record where (attrition around each flag). */
  onKill(victim: SoldierLike): void {
    const flags = this.game.capture.flags;
    for (let f = 0; f < this.F; f++) {
      const d = Math.hypot(flags[f].x - victim.pos.x, flags[f].z - victim.pos.z);
      if (d > 110) continue;
      if (victim.team === this.team) this.myLoss[f] += 1; else this.enemyLoss[f] += 1;
    }
  }

  // ================================================================= thinking (≈1 Hz)

  think(time: number): void {
    const dt = Math.min(5, Math.max(0.1, time - this.lastThink));
    this.lastThink = time;
    this.readBattlefield(time, dt);
    this.updateOps(time);
    this.planDefence(time);
    this.planOffence(time);
    this.planAir(time);
    this.commitReserve(time);
    this.issueOrders(time);
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
        if (t >= S) { const v = list[t - S]; if (!v.alive || !v.occupied) continue; w = VEH_W[this.orch.manifests[t - S].archetype]; }
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
    for (const f of this.game.capture.flags) if (f.owner === team) n++;
    return n;
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

  private open(type: number, f: number, required: number, reason: string, time: number): Operation | null {
    const op = this.allocOp();
    if (!op) return null;
    op.active = true; op.id = this.nextOpId++; op.type = type; op.flag = f; op.start = time; op.phaseTime = time;
    op.nsq = 0; op.nveh = 0; op.required = required; op.enemyAtStart = this.enemyEst[f];
    op.lossMark = this.myLoss[f]; op.progressAt = time; op.bestV = this.progress(f); op.minDist = 1e9;
    op.prepUntil = 0; op.nextFireCall = 0; op.smoked = false;
    op.heli = -1; op.airSquad = -1; op.airStart = -1; op.airDone = false; op.hasSbf = false;
    op.reason = reason;
    op.phase = type === OpType.ASSAULT ? OpPhase.ASSEMBLE : type === OpType.DEFEND ? OpPhase.CONSOLIDATE : OpPhase.EXECUTE;
    if (type === OpType.ASSAULT || type === OpType.SECURE) this.planGeometry(op);
    this.stats.planned++;
    this.note(`${OP_NAMES[type]} ${this.flagName(f)}: ${reason}`);
    return op;
  }

  private close(op: Operation, phase: number, why: string): void {
    op.phase = phase;
    if (op.heli >= 0 && !op.airDone && op.airSquad >= 0) this.orch.cancelInsertion(op.heli, op.airSquad);
    for (let i = 0; i < op.nsq; i++) {
      const q = this.squadById(op.squads[i]);
      if (q.opId === op.id) { q.opId = -1; q.order = Order.NONE; }
    }
    for (let i = 0; i < op.nveh; i++) if (this.vehOp[op.vehicles[i]] === op.id) this.vehOp[op.vehicles[i]] = -1;
    op.active = false;
    if (phase === OpPhase.FAILED) this.stats.failed++;
    else if (why) this.stats.succeeded++;
    if (why) this.note(`${OP_NAMES[op.type]} ${this.flagName(op.flag)} ${phase === OpPhase.FAILED ? 'FAILED' : 'complete'}: ${why}`);
  }

  private addSquad(op: Operation, q: SquadBlackboard, task: number): boolean {
    if (op.nsq >= MAX_OP_SQUADS) return false;
    op.squads[op.nsq] = q.id; op.task[op.nsq] = task; op.nsq++;
    q.opId = op.id; q.garrison = -1; q.axisDone = task === Task.SUPPORT || task === Task.AIR;
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
    const baseYaw = home ? Math.atan2(home.x - fl.x, home.z - fl.z) : Math.atan2(-fl.x, -fl.z) + (this.team === 0 ? 0 : Math.PI);
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

  private updateOps(time: number): void {
    const flags = this.game.capture.flags;
    for (const op of this.ops) {
      if (!op.active) continue;
      const fl = flags[op.flag];
      // Fill a deficit with squads that became free (reinforcement while assembling / defending).
      if ((op.phase === OpPhase.ASSEMBLE || op.type === OpType.DEFEND) && this.opStrength(op) < op.required) this.allocate(op, op.required, time);
      const strength = this.opStrength(op);
      switch (op.phase) {
        case OpPhase.ASSEMBLE: {
          if (fl.owner === this.team) { this.close(op, OpPhase.DONE, `${fl.name} already ours`); break; }
          const present = this.presentAt(op, op.stageX, op.stageZ, 45);
          const waited = time - op.phaseTime;
          // Allow for the march: ~4 m/s from wherever the furthest squad was when tasked, plus a margin.
          const limit = 120 + this.marchTime(op);
          if (strength > 0 && (present >= strength * 0.7 && strength >= op.required * 0.8 ||
            (waited > limit * 0.6 && present >= strength * 0.45 && present >= op.required * 0.6))) {
            op.strengthAtStart = strength;
            if (this.fireSupport()) {
              op.phase = OpPhase.PREP; op.phaseTime = time; op.prepUntil = time + 22;
              this.note(`${fl.name}: force assembled (${strength.toFixed(0)} vs ~${this.enemyEst[op.flag].toFixed(0)}), preparing with fires`);
            } else this.execute(op, time);
          } else if (waited > limit) {
            this.cooldown[op.flag] = time + 60;
            this.close(op, OpPhase.FAILED, `could not concentrate (${strength.toFixed(0)}/${op.required.toFixed(0)} after ${waited.toFixed(0)} s)`);
          }
          break;
        }
        case OpPhase.PREP:
          this.callFires(op, time);
          if (time > op.prepUntil) this.execute(op, time);
          break;
        case OpPhase.EXECUTE: {
          if (fl.owner === this.team) {
            op.phase = OpPhase.CONSOLIDATE; op.phaseTime = time;
            this.note(`${fl.name} taken; consolidating and digging in`);
            break;
          }
          // Keep the defenders under fire until our assault troops are close (danger-close checks protect them too).
          if (op.type === OpType.ASSAULT && this.closestSquad(op) > 75) this.callFires(op, time);
          // Progress: capture moving our way, owning the circle, or the assault force closing in.
          const p = this.progress(op.flag);
          if (p > op.bestV + 0.04 || fl.count[this.team] > fl.count[this.enemy]) { op.progressAt = time; op.bestV = Math.max(op.bestV, p); }
          // An air assault is judged from the moment its troops are on the ground.
          if (op.type === OpType.AIR_ASSAULT && !op.airDone) { op.progressAt = time; op.phaseTime = time; break; }
          const near = this.closestSquad(op);
          if (near < op.minDist - 8) { op.minDist = near; op.progressAt = time; }
          const lost = this.myLoss[op.flag] - op.lossMark;
          const stalled = time - op.progressAt;
          const inf = this.infantryStrength(op);
          const engagedLong = near < 130 ? 80 : 150;
          if ((lost > Math.max(6, op.strengthAtStart * 0.7) && stalled > 40) || stalled > engagedLong ||
            (inf < 3 && time - op.phaseTime > 45)) {
            this.attempts[op.flag]++;
            this.cooldown[op.flag] = time + 50 + 35 * this.attempts[op.flag];
            this.close(op, OpPhase.FAILED, `stalled ${stalled.toFixed(0)} s, lost ~${lost.toFixed(0)}, defenders ~${this.enemyEst[op.flag].toFixed(0)} (hardness ${this.hardness[op.flag].toFixed(1)}); pulling back to re-plan`);
          }
          break;
        }
        case OpPhase.CONSOLIDATE: {
          if (op.type === OpType.DEFEND) {
            const threat = this.enemyNear[op.flag] > 0.8 || fl.contestedBy === this.enemy;
            if (threat) op.progressAt = time;
            if (fl.owner !== this.team && fl.owner >= 0) { this.close(op, OpPhase.FAILED, `${fl.name} lost`); break; }
            if (time - op.progressAt > 40) this.close(op, OpPhase.DONE, 'threat cleared');
            break;
          }
          if (fl.owner !== this.team && fl.contestedBy === this.enemy) { op.phase = OpPhase.EXECUTE; op.phaseTime = time; op.progressAt = time; break; }
          if (time - op.phaseTime > (op.type === OpType.SECURE ? 20 : 40)) {
            // Leave the best-placed squad behind as the garrison.
            if (op.nsq > 0) { const q = this.squadById(op.squads[0]); q.opId = -1; q.garrison = op.flag; q.order = Order.NONE; }
            this.close(op, OpPhase.DONE, 'objective secured, garrison left');
          }
          break;
        }
      }
    }
  }

  /** Seconds the furthest squad of an operation needs to walk to the assembly area (capped). */
  private marchTime(op: Operation): number {
    let far = 0;
    for (let i = 0; i < op.nsq; i++) {
      if (op.task[i] === Task.AIR) continue;
      const q = this.squadById(op.squads[i]);
      far = Math.max(far, Math.hypot(q.cx - op.stageX, q.cz - op.stageZ));
    }
    return Math.min(140, far / 4);
  }

  /** Distance from the flag of the nearest dismounted attacking squad (main / flank / air). */
  private closestSquad(op: Operation): number {
    const fl = this.game.capture.flags[op.flag];
    let best = 1e9;
    for (let i = 0; i < op.nsq; i++) {
      if (op.task[i] === Task.SUPPORT) continue;
      const q = this.squadById(op.squads[i]);
      if (q.dismounted === 0 || q.alive === 0) continue;
      best = Math.min(best, Math.hypot(q.cx - fl.x, q.cz - fl.z));
    }
    return best;
  }

  private infantryStrength(op: Operation): number {
    let n = 0;
    for (let i = 0; i < op.nsq; i++) n += this.squadById(op.squads[i]).alive;
    return n;
  }

  /**
   * Reserve: squads left over once garrisons are set go to the operation that
   * needs them most (the assault with the worst force ratio), so surplus
   * troops never idle at the base.
   */
  private commitReserve(time: number): void {
    if (this.freeStrength() < 10) return;
    let best: Operation | null = null, ratio = 1e9;
    for (const op of this.ops) {
      if (!op.active || (op.type !== OpType.ASSAULT && op.type !== OpType.DEFEND) || op.phase > OpPhase.EXECUTE && op.type !== OpType.DEFEND) continue;
      const r = this.opStrength(op) / Math.max(1, op.type === OpType.DEFEND ? this.enemyNear[op.flag] : this.enemyEst[op.flag]);
      if (op.type === OpType.DEFEND && r > 1.2) continue;   // do not pile everyone into one circle
      if (r < ratio) { ratio = r; best = op; }
    }
    if (best && ratio < 4) this.allocate(best, this.opStrength(best) + 6, time);
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
    if (op.type === OpType.ASSAULT && !op.smoked) {
      op.smoked = true;
      const t = this.game.map.terrain;
      for (let k = 0; k < 2; k++) {
        const yaw = op.mainYaw + (k === 0 ? 0.25 : -0.25), d = 95;
        const x = fl.x + Math.sin(yaw) * d, z = fl.z + Math.cos(yaw) * d;
        this.smoke.deploy(x, t.height(x, z) + 2, z, 13, 32, time);
      }
    }
    if (op.type === OpType.ASSAULT) this.note(`${fl.name}: assault in ${op.nsq > 1 ? 'two axes' : 'one axis'}${op.hasSbf ? ' with support by fire' : ''}${op.heli >= 0 ? `, air element ${INSERT_NAMES[op.method]}` : ''}`);
  }

  /** Prep fires: artillery fire missions and a CAS request on the objective, attack run along the main axis. */
  private callFires(op: Operation, time: number): void {
    if (time < op.nextFireCall) return;
    op.nextFireCall = time + 7;
    const fl = this.game.capture.flags[op.flag];
    // Never on our own people: skip if friendlies are already on the flag.
    if (fl.count[this.team] > 0) return;
    this.radio.publish(RadioType.FIRE_MISSION, this.team, -1, -1, fl.x, fl.y, fl.z, -1, 3, time, 0, false);
    const m = this.radio.publish(RadioType.CAS_REQUEST, this.team, -1, -1, fl.x, fl.y, fl.z, -1, 3, time, 0, false);
    if (m) { m.vx = -Math.sin(op.mainYaw); m.vz = -Math.cos(op.mainYaw); }
  }

  /** Assigns the nearest free squads to an operation until `required` strength is reached. */
  private allocate(op: Operation, required: number, time: number): void {
    const sq = this.squads.squads;
    let have = this.opStrength(op);
    const ax = op.type === OpType.ASSAULT ? op.stageX : this.game.capture.flags[op.flag].x;
    const az = op.type === OpType.ASSAULT ? op.stageZ : this.game.capture.flags[op.flag].z;
    while (have < required && op.nsq < MAX_OP_SQUADS) {
      let best: SquadBlackboard | null = null, bd = 1e12;
      for (let i = 0; i < sq.length; i++) {
        const q = sq[i];
        if (!this.isFree(q)) continue;
        const d = (q.cx - ax) ** 2 + (q.cz - az) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
      if (!best) break;
      // Roles: first squad main effort, second flanks, third supports by fire, the rest reinforce the main effort.
      const n = op.nsq;
      const task = op.type !== OpType.ASSAULT ? Task.MAIN : n === 1 ? Task.FLANK : n === 2 && op.hasSbf ? Task.SUPPORT : Task.MAIN;
      this.addSquad(op, best, task);
      have += best.alive;
    }
    // Armour for assaults: up to two tanks / IFVs, nearest first.
    if (op.type === OpType.ASSAULT || op.type === OpType.DEFEND) {
      const list = this.game.vehicles.list;
      const want = op.type === OpType.ASSAULT ? 3 : 1;
      while (op.nveh < want) {
        let best = -1, bd = 1e12;
        for (let i = 0; i < list.length; i++) {
          const v = list[i];
          if (!v.alive || !v.occupied || v.team !== this.team || this.vehOp[i] >= 0 || !ARMOUR[this.orch.manifests[i].archetype]) continue;
          if (!v.driver || v.driver.isPlayer || !v.driver.ai) continue;
          const d = (v.pos.x - ax) ** 2 + (v.pos.z - az) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
        if (best < 0) break;
        op.vehicles[op.nveh++] = best;
        this.vehOp[best] = op.id;
        this.fireAt[best] = -1e3;
      }
    }
    void time;
  }

  /** DEFEND: reinforce own flags under threat (enemy on it or massing nearby and outnumbering us). */
  private planDefence(time: number): void {
    const flags = this.game.capture.flags;
    for (let f = 0; f < this.F; f++) {
      const fl = flags[f];
      if (fl.owner !== this.team || this.opOnFlag(f)) continue;
      const threat = fl.contestedBy === this.enemy || this.enemyNear[f] > this.friendly[f] + 2;
      if (!threat) continue;
      const need = Math.max(4, this.enemyNear[f] * 1.3 + 2 - this.friendly[f]);
      if (this.freeStrength() < 2) continue;
      const op = this.open(OpType.DEFEND, f, need,
        `${fl.contestedBy === this.enemy ? 'enemy on the flag' : 'enemy massing'} (~${this.enemyNear[f].toFixed(0)} hostile vs ${this.friendly[f].toFixed(0)} ours)`, time);
      if (op) { op.progressAt = time; this.allocate(op, need, time); if (op.nsq === 0) this.close(op, OpPhase.DONE, ''); }
    }
  }

  /** Offence: choose the flag with the best value for the force it needs; secure, or assault with a deliberate plan. */
  private planOffence(time: number): void {
    if (this.activeOps() >= MAX_OPS - 1) return;
    const free = this.freeStrength();
    if (free < 3) return;
    const flags = this.game.capture.flags, F = this.F;
    const behind = this.ownedCount(this.team) < this.ownedCount(this.enemy);
    // Never plan what the whole army could not deliver: at most ~55 % of our infantry plus armour on one objective.
    let army = 0;
    for (const q of this.squads.squads) if (q.team === this.team && q.kind === SquadKind.INFANTRY) army += q.alive;
    const list = this.game.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.alive && v.occupied && v.team === this.team && ARMOUR[this.orch.manifests[i].archetype]) army += VEH_W[this.orch.manifests[i].archetype];
    }
    const ceiling = army * 0.55;
    // Ground operations only against flags that border our territory (or neutral ground); deep ones are for air assault.
    let anyFront = false;
    for (let f = 0; f < F; f++) if (flags[f].owner !== this.team && this.bordersUs(f)) { anyFront = true; break; }
    let best = -1, bestU = 0, bestReq = 0, bestType: number = OpType.SECURE;
    for (let f = 0; f < F; f++) {
      const fl = flags[f];
      if (fl.owner === this.team || this.opOnFlag(f)) continue;
      // The enemy main base is their spawn: only worth storming once the rest of the map is ours.
      if (fl.base && fl.owner === this.enemy && this.ownedCount(this.team) < F - 2) continue;
      if (anyFront && !this.bordersUs(f)) continue;
      const est = this.enemyEst[f];
      const type = est <= 2.6 && fl.contestedBy !== this.enemy && fl.owner !== this.enemy ? OpType.SECURE
        : est <= 2.6 && fl.owner === this.enemy && this.hardness[f] < 1.2 ? OpType.SECURE : OpType.ASSAULT;
      // Doctrine: ~3:1 against a prepared defence, more after each failed attempt (it has proven harder than it looked).
      const hard = Math.max(this.hardness[f], this.attempts[f] > 0 ? 1 : 0.6) * (1 + 0.4 * this.attempts[f]);
      const required = type === OpType.SECURE ? Math.max(4, est * 1.6 + 2) : Math.max(10, est * 2.6 * hard + 4);
      if (required > ceiling) continue;   // out of reach for now: bypass it and take what we can
      // Recently failed here: only come back with a clearly bigger force.
      if (time < this.cooldown[f] && free + this.reassignable() < required * 1.4) continue;
      let near = 1e9;
      for (let o = 0; o < F; o++) if (flags[o].owner === this.team) near = Math.min(near, Math.hypot(flags[o].x - fl.x, flags[o].z - fl.z));
      if (near === 1e9) near = 300;
      let u = this.value[f] * (behind ? 1.3 : 1) / (required / 6 + near / 260 + 0.4);
      if (type === OpType.SECURE && free < required) u *= 0.5;
      if (type === OpType.ASSAULT && free + this.reassignable() < required * 0.8) u *= 0.35;
      if (this.attempts[f] > 0) u *= 1 / (1 + this.attempts[f] * 0.35);
      if (u > bestU) { bestU = u; best = f; bestReq = required; bestType = type; }
    }
    if (best < 0) return;
    const fl = flags[best];
    const est = this.enemyEst[best];
    const why = bestType === OpType.SECURE
      ? `${fl.owner < 0 ? 'neutral' : 'lightly held'} (~${est.toFixed(0)}), worth ${this.value[best].toFixed(1)}${behind ? ', we hold fewer flags' : ''}`
      : `held by ~${est.toFixed(0)}${this.attempts[best] ? `, attempt ${this.attempts[best] + 1} with ${bestReq.toFixed(0)} (hardness ${this.hardness[best].toFixed(1)})` : ''}; ` +
        `concentrating ${bestReq.toFixed(0)} for ${(bestReq / Math.max(1, est)).toFixed(1)}:1`;
    const op = this.open(bestType, best, bestReq, why, time);
    if (!op) return;
    this.allocate(op, bestReq, time);
    if (op.nsq === 0) this.close(op, OpPhase.DONE, '');
  }

  /** Is flag f linked by road to a flag we hold (or unowned and next to nothing of the enemy's)? */
  private bordersUs(f: number): boolean {
    const flags = this.game.capture.flags, F = this.F;
    for (let o = 0; o < F; o++) if (this.adj[f * F + o] && flags[o].owner === this.team) return true;
    return false;
  }

  /** Strength that could be pulled from garrisons at safe flags. */
  private reassignable(): number {
    let n = 0;
    for (const q of this.squads.squads) {
      if (q.team !== this.team || q.garrison < 0 || q.opId >= 0) continue;
      if (this.enemyNear[q.garrison] < 1) n += q.alive;
    }
    return n;
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
    // 2) Deep, weakly held flag.
    let best = -1, bs = 0;
    for (let f = 0; f < this.F; f++) {
      const fl = flags[f];
      if (fl.owner === this.team || this.opOnFlag(f) || fl.base || this.enemyEst[f] > 3.5) continue;
      let near = 1e9;
      for (let o = 0; o < this.F; o++) if (flags[o].owner === this.team) near = Math.min(near, Math.hypot(flags[o].x - fl.x, flags[o].z - fl.z));
      if (near < 200) continue;
      const s = this.value[f] * (near / 200) / (1 + this.enemyEst[f]);
      if (s > bs) { bs = s; best = f; }
    }
    if (best < 0) return;
    const fl = flags[best];
    const op = this.open(OpType.AIR_ASSAULT, best, 4, `deep and weakly held (~${this.enemyEst[best].toFixed(0)}): vertical envelopment`, time);
    if (!op) return;
    if (!this.pickDropZone(fl, Math.atan2(hv.pos.x - fl.x, hv.pos.z - fl.z), _p2)) { this.close(op, OpPhase.DONE, ''); return; }
    op.dropX = _p2[0]; op.dropZ = _p2[1];
    const method = this.chooseInsert(op.dropX, op.dropZ, false);
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
    for (const q of this.squads.squads) {
      if (!this.isFree(q) || q.dismounted < 2 || q.vehicle >= 0) continue;
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

  /** Turns operations, garrisons and idle squads into concrete squad orders. */
  private issueOrders(time: number): void {
    const g = this.game, flags = g.capture.flags;
    for (const op of this.ops) {
      if (!op.active) continue;
      const fl = flags[op.flag];
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
        if (op.phase === OpPhase.CONSOLIDATE || op.type === OpType.DEFEND) {
          this.setOrder(q, Order.DEFEND, fl.x, fl.z, 14, this.threatYawAt(op.flag, q));
        } else if (op.phase === OpPhase.ASSEMBLE || op.phase === OpPhase.PREP) {
          this.setOrder(q, Order.HOLD, op.stageX, op.stageZ, 30, Math.atan2(fl.x - op.stageX, fl.z - op.stageZ));
        } else if (task === Task.SUPPORT && op.hasSbf) {
          this.setOrder(q, Order.SUPPORT, op.sbfX, op.sbfZ, 22, Math.atan2(fl.x - op.sbfX, fl.z - op.sbfZ));
        } else {
          const ax = task === Task.FLANK ? 1 : 0;
          if (q.order !== Order.ATTACK) q.axisDone = op.type !== OpType.ASSAULT || task === Task.AIR;
          q.axisX = op.axisX[ax]; q.axisZ = op.axisZ[ax];
          this.setOrder(q, Order.ATTACK, fl.x, fl.z, 12, Math.atan2(fl.x - q.cx, fl.z - q.cz));
        }
      }
    }
    // Garrisons and idle squads.
    for (const q of this.squads.squads) {
      if (q.team !== this.team || q.kind !== SquadKind.INFANTRY || q.opId >= 0) continue;
      // Mid-insertion (boarding, flying, on the rope / canopy): leave it alone until everyone is down.
      if (q.order === Order.AIRLIFT) {
        if (q.vehicle >= 0 || this.squadAboard(q)) continue;
        q.order = Order.NONE;
      }
      if (q.garrison >= 0 && flags[q.garrison].owner !== this.team) q.garrison = -1;
      if (q.defensive) {
        // Re-read where the garrison is needed (front lines move); switch only for a clearly better post.
        const best = this.garrisonFlag(q);
        if (q.garrison < 0 || (best >= 0 && best !== q.garrison && this.garrisonScore(best, q) > this.garrisonScore(q.garrison, q) + 1.2)) q.garrison = best;
      }
      if (q.garrison < 0) {
        // Not needed by any operation: hold the most threatened front-line flag instead of wandering into fights.
        const f = this.garrisonFlag(q);
        if (f >= 0) { q.objective = flags[f]; q.objectiveTime = time; this.setOrder(q, Order.DEFEND, flags[f].x, flags[f].z, 14, this.threatYawAt(f, q)); }
        else q.order = Order.NONE;
        continue;
      }
      const fl = flags[q.garrison];
      q.objective = fl; q.objectiveTime = time;
      this.setOrder(q, Order.DEFEND, fl.x, fl.z, 14, this.threatYawAt(q.garrison, q));
    }
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
  private garrisonFlag(q: SquadBlackboard): number {
    const flags = this.game.capture.flags;
    let best = -1, bs = -1e9;
    for (let f = 0; f < this.F; f++) {
      if (flags[f].owner !== this.team) continue;
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
    return front * 1.2 + this.enemyNear[f] * 0.4 + (fl.base ? 0.5 : 0) - held * 1.6 - Math.hypot(fl.x - q.cx, fl.z - q.cz) / 400;
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
   * Objective and firing position for an armoured vehicle: its operation's
   * flag, fighting from a firing position with line of sight (assembly / prep:
   * support by fire; execute: closer in behind the infantry), or the most
   * threatened own flag as overwatch.
   */
  vehicleOrder(v: VehicleLike, man: VehicleManifest, time: number): boolean {
    const flags = this.game.capture.flags;
    const opId = this.vehOp[v.id];
    let op: Operation | null = null;
    if (opId >= 0) for (const o of this.ops) if (o.active && o.id === opId) { op = o; break; }
    if (opId >= 0 && !op) this.vehOp[v.id] = -1;
    let f: number, fromYaw: number, minD: number, maxD: number;
    if (op) {
      f = op.flag;
      fromYaw = op.type === OpType.ASSAULT ? op.mainYaw : this.threatYawAt(f, this.squads.squads[0]) + Math.PI;
      const close = op.phase === OpPhase.EXECUTE && time - op.phaseTime > 15;
      minD = close ? 45 : 85; maxD = close ? 75 : 150;
      man.opPhase = op.phase;
    } else {
      if (!ARMOUR[man.archetype]) return false;
      // Overwatch the most threatened own flag from behind it.
      let best = -1, bs = -1e9;
      for (let i = 0; i < this.F; i++) {
        if (flags[i].owner !== this.team) continue;
        const s = this.enemyNear[i] + this.value[i] - Math.hypot(flags[i].x - v.pos.x, flags[i].z - v.pos.z) / 300;
        if (s > bs) { bs = s; best = i; }
      }
      if (best < 0) return false;
      f = best;
      fromYaw = this.threatYawAt(f, this.squads.squads[0]) + Math.PI;
      minD = 50; maxD = 95;
      man.opPhase = OpPhase.CONSOLIDATE;
    }
    const fl = flags[f];
    man.objective = fl; man.objectiveTime = time;
    if (this.fireFlag[v.id] !== f || time - this.fireAt[v.id] > 20 || (op && op.phase === OpPhase.EXECUTE && time - this.fireAt[v.id] > 8)) {
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
        if (i === v.id || this.fireFlag[i] < 0 || this.game.time - this.fireAt[i] > 40) continue;
        TAKEN_X[tn] = this.fireX[i]; TAKEN_Z[tn] = this.fireZ[i]; tn++;
      }
      if (pickFiringPosition(this.game, this.foliage, fl.x, fl.z, fromYaw, minD, maxD, v.pos.x, v.pos.z, AT_X, AT_Z, n, v.id, _p2, TAKEN_X, TAKEN_Z, tn)) {
        this.fireX[v.id] = _p2[0]; this.fireZ[v.id] = _p2[1];
      } else {
        this.fireX[v.id] = fl.x + Math.sin(fromYaw) * minD; this.fireZ[v.id] = fl.z + Math.cos(fromYaw) * minD;
      }
      this.fireAt[v.id] = time; this.fireFlag[v.id] = f;
    }
    man.fireX = this.fireX[v.id]; man.fireZ = this.fireZ[v.id];
    man.hasFire = true;
    return true;
  }

  /** One-line-per-op summary (debug overlay / report). */
  summary(): string {
    const side = this.team === 0 ? 'P' : 'T';
    const parts: string[] = [];
    for (const op of this.ops) {
      if (!op.active) continue;
      parts.push(`${OP_NAMES[op.type]} ${this.flagName(op.flag)} [${PHASE_NAMES[op.phase]}] ${op.nsq}sq ${this.opStrength(op).toFixed(0)}/${op.required.toFixed(0)}`);
    }
    return `${side}: ${parts.length ? parts.join(' | ') : 'no operations'}`;
  }
}

const IDS_SCRATCH = new Int32Array(64);
