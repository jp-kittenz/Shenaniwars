// @ts-ignore -- plain JS module
import { inCaptureVolume } from '../world/flag-volume.js';
import { Deliberation, Domain, Q_NAMES } from './deliberation.ts';
import { AgentStateBuffers } from './agent-state.ts';
import { TacticalRadioBus } from './radio-bus.ts';
import { SmokeField } from './smoke.ts';
import { SpatialGrid } from './spatial-grid.ts';
import { SquadBlackboard, SquadKind, squadGoal } from './squad-convoy.ts';
import { CoverField, FoliageField, ThreatSet } from './terrain-analysis.ts';
import {
  ACTION_COMMIT, ACTION_COUNT, ACTION_NAMES, AI_TUNING, Action, Archetype, ARCHETYPE_OF, Logistics, Order, PF, Posture,
  RadioType, SoldierClass, Stance, clamp, clamp01, hash01, rand,
} from './types.ts';
import type { AgentLike, FlagLike, GameLike, SoldierLike, VehicleLike } from './types.ts';

// ---------------------------------------------------------------- perception memory

/**
 * Per-observer contact memory, structure-of-arrays with K slots per observer:
 * detection level (0..1.2), last-known position + time, LoS cache and flags.
 */
export class PerceptionMemory {
  readonly k: number;
  readonly target: Int32Array;
  readonly level: Float32Array;
  readonly lkpX: Float32Array;
  readonly lkpY: Float32Array;
  readonly lkpZ: Float32Array;
  readonly lkpT: Float32Array;
  readonly losT: Float32Array;
  readonly flags: Uint8Array;

  constructor(observers: number, k: number) {
    this.k = k;
    const n = observers * k;
    this.target = new Int32Array(n).fill(-1);
    this.level = new Float32Array(n);
    this.lkpX = new Float32Array(n); this.lkpY = new Float32Array(n); this.lkpZ = new Float32Array(n);
    this.lkpT = new Float32Array(n).fill(-100);
    this.losT = new Float32Array(n).fill(-100);
    this.flags = new Uint8Array(n);
  }

  find(o: number, t: number): number {
    const b = o * this.k;
    for (let i = b; i < b + this.k; i++) if (this.target[i] === t) return i;
    return -1;
  }

  /** Slot for target t: existing, empty, or the weakest unacquired one. */
  alloc(o: number, t: number): number {
    const b = o * this.k;
    let empty = -1, weakest = -1, wl = 1e9;
    for (let i = b; i < b + this.k; i++) {
      const tt = this.target[i];
      if (tt === t) return i;
      if (tt < 0) { if (empty < 0) empty = i; continue; }
      const score = this.level[i] + ((this.flags[i] & PF.ACQUIRED) ? 2 : 0) + ((this.flags[i] & PF.VISIBLE) ? 1 : 0);
      if (score < wl) { wl = score; weakest = i; }
    }
    const slot = empty >= 0 ? empty : weakest;
    this.target[slot] = t; this.level[slot] = 0; this.flags[slot] = 0; this.lkpT[slot] = -100; this.losT[slot] = -100;
    return slot;
  }

  clearSlot(i: number): void { this.target[i] = -1; this.level[i] = 0; this.flags[i] = 0; }

  clear(o: number): void {
    const b = o * this.k;
    for (let i = b; i < b + this.k; i++) this.clearSlot(i);
  }
}

/** Two-tier ring buffer of LoS requests (global slot indices). */
class LosQueue {
  private readonly hi: Int32Array;
  private readonly lo: Int32Array;
  private hiHead = 0; private hiCount = 0;
  private loHead = 0; private loCount = 0;
  constructor(capacity: number) { this.hi = new Int32Array(capacity); this.lo = new Int32Array(capacity); }
  push(slot: number, high: boolean): boolean {
    const q = high ? this.hi : this.lo;
    if (high) {
      if (this.hiCount === q.length) return false;
      q[(this.hiHead + this.hiCount++) % q.length] = slot;
    } else {
      if (this.loCount === q.length) return false;
      q[(this.loHead + this.loCount++) % q.length] = slot;
    }
    return true;
  }
  pop(): number {
    if (this.hiCount > 0) { const v = this.hi[this.hiHead]; this.hiHead = (this.hiHead + 1) % this.hi.length; this.hiCount--; return v; }
    if (this.loCount > 0) { const v = this.lo[this.loHead]; this.loHead = (this.loHead + 1) % this.lo.length; this.loCount--; return v; }
    return -1;
  }
  get size(): number { return this.hiCount + this.loCount; }
  clear(): void { this.hiCount = this.loCount = 0; }
}

/** Services the engine needs from the vehicle orchestrator (set after construction). */
export interface InfantryVehicleHooks {
  ticketVehicle(soldierId: number): VehicleLike | null;
  tryBoard(s: SoldierLike): boolean;
  nearestSupply(team: number, x: number, z: number, radius: number): VehicleLike | null;
  archetypeOfSeat(s: SoldierLike): number;
  /** Where an unassigned crewman / pilot should wait (beside a vehicle lacking a driver). */
  crewPost(s: SoldierLike, out: Float32Array): boolean;
  /** The soldier cannot reach the vehicle he reserved: release the seat (and do not send him there again soon). */
  abandonTicket(s: SoldierLike): void;
  /** Seat index of the soldier's reservation (-1 none). */
  ticketSeat(s: SoldierLike): number;
}

// ---------------------------------------------------------------- scratch (module-level, reused)

const CAND = new Int32Array(256);
const IDS = new Int32Array(128);
const SCORES = new Float32Array(ACTION_COUNT);
const C2 = new Float32Array(2);
const GOAL = new Float32Array(2);
const SCREEN_X = new Float32Array([4.5, -4.5, 7, -7, 0, 3, -3, 0]);
const SCREEN_Z = new Float32Array([-5, -5, -1, -1, -9, -11, -11, -14]);

/**
 * Perception (time-sliced LoS, gradual detection, LKP memory, acoustic cues,
 * squad / radio sharing) and the infantry utility brain (hysteresis-gated
 * action selection, cover scoring against all known sightlines, bounding
 * overwatch, flanking, AT ambush discipline, armour screening, danger-close
 * holds and self-preservation).
 */
export class PerceptionAndUtilityEngine {
  readonly memory: PerceptionMemory;
  readonly S: number;
  readonly V: number;
  agents: (AgentLike | null)[] = [];
  hooks: InfantryVehicleHooks | null = null;
  /** Last acute danger per soldier (blast close by, point-blank fire): breaks a move commitment. */
  readonly acuteAt: Float32Array;
  private readonly delib = new Deliberation(Domain.SOLDIER);
  /** Last deliberation per soldier: up to 4 (action, failed question) pairs, 0xff = end. For the debug overlay. */
  readonly traceBuf = new Uint8Array(4096 * 4);
  readonly stats = { rays: 0, raysQueued: 0, perceptions: 0, tactical: 0, cohesionWaits: 0, circleHolds: 0, aheadWaits: 0, dropRegrouped: 0, upperMoves: 0, gateHeld: 0, feintSmoke: 0, fireLaneSteps: 0, roofAssaults: 0 };
  /** Last acquisition / tactical-tick time per target for radio throttling. */
  private readonly nextNoise: Float32Array;
  private readonly los = new LosQueue(2048);
  private readonly threats = new ThreatSet(16);
  private readonly game: GameLike;
  private readonly st: AgentStateBuffers;
  private readonly grid: SpatialGrid;
  private readonly cover: CoverField;
  private readonly foliage: FoliageField;
  private readonly smoke: SmokeField;
  private readonly radio: TacticalRadioBus;

  constructor(game: GameLike, st: AgentStateBuffers, grid: SpatialGrid, cover: CoverField, foliage: FoliageField,
    smoke: SmokeField, radio: TacticalRadioBus) {
    this.game = game; this.st = st; this.grid = grid; this.cover = cover; this.foliage = foliage;
    this.smoke = smoke; this.radio = radio;
    this.S = game.soldiers.length;
    this.acuteAt = new Float32Array(game.soldiers.length).fill(-1e3);
    this.V = game.vehicles.list.length;
    this.memory = new PerceptionMemory(this.S, AI_TUNING.memorySlots);
    this.nextNoise = new Float32Array(this.S);
  }

  entity(t: number): SoldierLike | VehicleLike {
    return t < this.S ? this.game.soldiers[t] : this.game.vehicles.list[t - this.S];
  }
  index(e: SoldierLike | VehicleLike): number { return e.kind === 'soldier' ? e.id : this.S + e.id; }

  reset(): void {
    for (let o = 0; o < this.S; o++) this.memory.clear(o);
    this.los.clear();
  }

  onSpawn(id: number): void { this.memory.clear(id); this.st.resetSoldier(id, this.game.time); }

  // ================================================================= perception

  /** Sensor profile of an observer: range, focal/peripheral cone, air range, thermal. */
  private sensor(s: SoldierLike, out: Float32Array): void {
    let range = s.cls === SoldierClass.SPOTTER ? 230 : 170, focal = 0.87, periph = 0.42, air = 450, thermal = 0;
    const v = s.vehicle;
    if (v) {
      const arch = ARCHETYPE_OF[v.def.type];
      if (v.def.kind !== 'ground') { range = 420; focal = 0.5; periph = -0.5; air = 900; thermal = 1; }
      else if (arch === Archetype.SAM) { range = 200; focal = 0.5; periph = -1; air = v.radarOn ? ((v.def as any).radarRange || 1000) : 300; thermal = 1; }
      else if (arch === Archetype.SPAAG) { range = 230; focal = 0.6; periph = -1; air = 650; thermal = 1; }
      else { range = 240; focal = 0.64; periph = -0.17; air = 500; thermal = 1; }
    }
    // Darkness, rain and fog shorten how far an observer sees (thermal sights ignore the dark).
    const atm = this.game.atmosphere;
    if (atm) range *= thermal ? atm.thermalRange : atm.range;
    // EnvironmentState: nobody sees past the current visibility (fog, storm, darkness), aircraft included
    // (radars excepted: SAM / SPAAG keep their air range).
    const env = (this.game as any).environment;
    if (env) {
      const cap = thermal ? env.thermalRangeMeters : env.visibilityRangeMeters;
      range = Math.min(range, cap);
      if (air < 600) air = Math.min(air, cap * 1.6);
    }
    out[0] = range; out[1] = focal; out[2] = periph; out[3] = air; out[4] = thermal;
  }

  /** One perception tick for observer o (soldier id). */
  perceive(o: number): void {
    const g = this.game, time = g.time, s = g.soldiers[o], mem = this.memory, K = mem.k;
    if (!s.alive || s.isPlayer) return;
    this.stats.perceptions++;
    const dt = Math.min(1, time - this.st.lastPerception[o]);
    this.st.lastPerception[o] = time;
    const sens = SENSOR;
    this.sensor(s, sens);
    const range = sens[0], focal = sens[1], periph = sens[2], airRange = sens[3], thermal = sens[4] > 0;
    const v = s.vehicle;
    const ex = s.pos.x, ez = s.pos.z;
    let facing = s.yaw;
    if (v) facing = v.mountList(s.seat).length ? v.aimYaw[s.seat] : v.yaw;
    const fx = Math.sin(facing), fz = Math.cos(facing);
    const sup = this.st.suppression[o];
    const skill = (s.ai ? s.ai.skill : 1) * (s.cls === SoldierClass.SPOTTER ? 1.4 : 1) * (1 - 0.5 * sup);
    const base = o * K;

    // 1) Decay and staleness.
    for (let i = base; i < base + K; i++) {
      if (mem.target[i] < 0) continue;
      if ((mem.flags[i] & PF.VISIBLE) && time - mem.losT[i] > 1.0) mem.flags[i] &= ~PF.VISIBLE;
      if (!(mem.flags[i] & PF.VISIBLE)) {
        mem.level[i] = Math.max(0, mem.level[i] - 0.12 * dt);
        if ((mem.flags[i] & PF.ACQUIRED) && mem.level[i] < 0.35 && time - mem.lkpT[i] > 6) mem.flags[i] &= ~PF.ACQUIRED;
        if (time - mem.lkpT[i] > AI_TUNING.forgetAfter && mem.level[i] <= 0) mem.clearSlot(i);
      }
    }

    // 2) Candidates near the observer (+ aircraft at long range).
    let n = this.grid.queryRadius(ex, ez, range, CAND);
    if (airRange > range) {
      const list = g.vehicles.list;
      for (let i = 0; i < list.length && n < CAND.length; i++) {
        const av = list[i];
        if (!av.alive || !av.isAircraft || !av.occupied || av.team === s.team) continue;
        const d2 = (av.pos.x - ex) ** 2 + (av.pos.z - ez) ** 2;
        if (d2 > range * range && d2 < airRange * airRange) CAND[n++] = this.S + av.id;
      }
    }
    const current = s.ai && s.ai.target ? this.index(s.ai.target) : -1;
    const atmo = g.atmosphere;
    for (let c = 0; c < n; c++) {
      const t = CAND[c];
      if (t === o) continue;
      let tx: number, ty: number, tz: number, vis: number, isAir = false;
      if (t < this.S) {
        const e = g.soldiers[t];
        if (!e.alive || e.team === s.team || (e.vehicle && !e.vehicle.seatExposed(e.seat))) continue;
        tx = e.pos.x; tz = e.pos.z; ty = e.pos.y + (e.stance === Stance.PRONE ? 0.35 : e.stance === Stance.CROUCH ? 1.0 : 1.35);
        vis = e.stance === Stance.PRONE ? 0.3 : e.stance === Stance.CROUCH ? 0.55 : 1;
        vis *= 1 + Math.min(7, e.speed) * 0.1;
        if (e.spotted > 0) vis *= 2.5;
        // Muzzle flashes and searchlight beams (spotted) give a soldier away in the dark.
        else if (!thermal && atmo) vis *= atmo.vis;
        vis *= 1 - this.foliage.at(tx, tz) * (thermal ? 0.25 : 0.65);
      } else {
        const ev = g.vehicles.list[t - this.S];
        if (!ev.alive || !ev.occupied || ev.team === s.team || ev === v) continue;
        tx = ev.pos.x; ty = ev.pos.y + 0.4; tz = ev.pos.z;
        isAir = ev.isAircraft;
        vis = isAir ? 3 : 2.2;
        if (ev.airspeed > 2) vis *= 1.3;
        if (thermal) vis *= 1.4;
        else if (atmo) vis *= atmo.vehVis;
        if (!isAir) vis *= 1 - this.foliage.at(tx, tz) * 0.35;
      }
      const dx = tx - ex, dz = tz - ez, d = Math.sqrt(dx * dx + dz * dz) || 0.01;
      const maxR = isAir ? airRange : range;
      if (d > maxR) continue;
      const cos = (dx * fx + dz * fz) / d;
      const af = d < 8 ? 1 : cos > focal ? 1 : cos > periph ? 0.35 : isAir && d < 260 ? 0.25 : 0;
      if (af === 0 && t !== current) continue;
      let df = 1 - (d / maxR) * (d / maxR);
      if (d < 15) df *= 2;
      const rate = AI_TUNING.baseDetectRate * Math.max(0.05, df) * af * vis * skill;
      const slot = mem.alloc(o, t);
      // Line of sight is cached and refreshed through the global, budgeted queue.
      if (time - mem.losT[slot] > AI_TUNING.losValid && !(mem.flags[slot] & PF.PENDING)) {
        if (this.los.push(slot, t === current || d < 50)) { mem.flags[slot] |= PF.PENDING; this.stats.raysQueued++; }
      }
      if (mem.flags[slot] & PF.VISIBLE) {
        mem.level[slot] = Math.min(1.2, mem.level[slot] + rate * dt);
        mem.lkpX[slot] = tx; mem.lkpY[slot] = ty; mem.lkpZ[slot] = tz; mem.lkpT[slot] = time;
        if (mem.level[slot] >= 1 && !(mem.flags[slot] & PF.ACQUIRED)) {
          mem.flags[slot] |= PF.ACQUIRED;
          this.onAcquire(s, t, tx, ty, tz, time);
        }
        if ((mem.flags[slot] & PF.ACQUIRED) && time > this.st.nextShareAt[o]) {
          this.st.nextShareAt[o] = time + 1;
          const q = s.squad as SquadBlackboard | null;
          if (q) q.addContact(t, tx, ty, tz, time, t < this.S ? 1 : 2);
        }
      }
    }

    // 3) Squad-shared contacts (no line of sight: LKP only, for suppression and cueing).
    const q = s.squad as SquadBlackboard | null;
    if (q) {
      for (let i = 0; i < q.cTarget.length; i++) {
        const t = q.cTarget[i];
        if (t < 0 || time - q.cT[i] > 4) continue;
        let slot = mem.find(o, t);
        if (slot < 0) { slot = mem.alloc(o, t); mem.level[slot] = 0.5; }
        if (!(mem.flags[slot] & PF.VISIBLE) && q.cT[i] > mem.lkpT[slot]) {
          mem.flags[slot] |= PF.SHARED;
          mem.lkpX[slot] = q.cX[i]; mem.lkpY[slot] = q.cY[i]; mem.lkpZ[slot] = q.cZ[i]; mem.lkpT[slot] = q.cT[i];
          mem.level[slot] = Math.max(mem.level[slot], 0.5);
        }
      }
    }
    this.selectTarget(o);
  }

  /** Spot reports: aircraft → AIR_THREAT; armour seen by spotters, LTs and infantry → CAS request. */
  private onAcquire(s: SoldierLike, t: number, x: number, y: number, z: number, time: number): void {
    if (t < this.S) return;
    const ev = this.game.vehicles.list[t - this.S];
    const q = s.squad as SquadBlackboard | null;
    const sq = q ? q.id : -1;
    if (ev.isAircraft) {
      const m = this.radio.publish(RadioType.AIR_THREAT, s.team, s.id, sq, x, y, z, t, ev.def.kind === 'jet' ? 3 : 2, time);
      if (m) { m.vx = ev.vel.x; m.vz = ev.vel.z; }
      return;
    }
    const arch = ARCHETYPE_OF[ev.def.type];
    const lase = s.cls === SoldierClass.SPOTTER || (s.vehicle !== null && ARCHETYPE_OF[s.vehicle.def.type] === Archetype.LT);
    if (ev.def.armor === 'heavy' || arch === Archetype.MLRS || arch === Archetype.SAM || arch === Archetype.HOWITZER) {
      const m = this.radio.publish(RadioType.CAS_REQUEST, s.team, s.id, sq, x, y, z, t, ev.def.armor === 'heavy' ? 2 : 1, time, 0, lase);
      if (m) { m.vx = x - s.pos.x; m.vz = z - s.pos.z; }
      if (lase) this.radio.publish(RadioType.FIRE_MISSION, s.team, s.id, sq, x, y, z, t, 1, time, 0, true);
    }
  }

  /** Processes up to `budget` queued line-of-sight checks. */
  processLos(budget: number): void {
    const g = this.game, mem = this.memory, K = mem.k, time = g.time;
    while (budget > 0 && this.los.size > 0) {
      const slot = this.los.pop();
      if (slot < 0) break;
      mem.flags[slot] &= ~PF.PENDING;
      const t = mem.target[slot];
      if (t < 0) continue;
      const o = (slot / K) | 0;
      const s = g.soldiers[o];
      if (!s.alive) continue;
      const e = this.entity(t);
      if (!e.alive) { mem.clearSlot(slot); continue; }
      budget--;
      this.stats.rays++;
      const ay = s.pos.y + (s.vehicle ? 1.6 : s.stance === Stance.PRONE ? 0.35 : s.stance === Stance.CROUCH ? 1.1 : 1.6);
      let by: number;
      if (e.kind === 'soldier') by = e.pos.y + (e.stance === Stance.PRONE ? 0.3 : e.stance === Stance.CROUCH ? 0.95 : 1.3);
      else by = e.pos.y + 0.3;
      let clear = !this.smoke.blocks(s.pos.x, ay, s.pos.z, e.pos.x, by, e.pos.z, time);
      if (clear) clear = g.physics.losClear(s.pos.x, ay, s.pos.z, e.pos.x, by, e.pos.z);
      mem.losT[slot] = time;
      if (clear) mem.flags[slot] |= PF.VISIBLE; else mem.flags[slot] &= ~PF.VISIBLE;
    }
  }

  /** Does this seat have an anti-aircraft mount (e.g. the scout car's pintle MG)? */
  private seatAA(v: VehicleLike, seat: number): boolean {
    const list = v.mountList(seat);
    for (let i = 0; i < list.length; i++) if (v.def.mounts[list[i]].aa) return true;
    return false;
  }

  /** Threat priority of target e for observer s (0 = ignore). */
  private priority(s: SoldierLike, e: SoldierLike | VehicleLike): number {
    const v = s.vehicle;
    // Airborne aircraft are air defence's job: infantry and ordinary ground crews spot and report them (AIR_THREAT)
    // but keep fighting the ground battle. Aircraft crews keep their own air-to-air rules below.
    if (e.kind === 'vehicle' && e.isAircraft && e.altitude > 3) {
      if (!v) {
        // Infantry against aircraft: only a helicopter close overhead (low and near) is worth the rounds — rifles
        // at short range, a launcher a little further (a hovering or slow helicopter is a fair rocket target).
        // Anything higher, further or fast stays air defence's job (reported, not engaged).
        if (e.def.kind !== 'heli') return 0;
        const d = Math.hypot(e.pos.x - s.pos.x, e.pos.y - s.pos.y, e.pos.z - s.pos.z);
        const rocket = s.launcher !== null && s.launcher.ammo + s.launcher.reserve > 0 && Math.abs(e.speed) < 25;
        if (d > (rocket ? 260 : 150) || e.altitude > (rocket ? 120 : 90) || !this.canHurt(s, e)) return 0;
        return rocket ? 2.2 : d < 80 ? 1.5 : 0.9;
      }
      if (!v.isAircraft) {
        const arch = ARCHETYPE_OF[v.def.type];
        const aa = arch === Archetype.SAM || arch === Archetype.SPAAG || this.seatAA(v, s.seat);
        if (!aa || !this.canHurt(s, e)) return 0;
        if (arch !== Archetype.SAM && arch !== Archetype.SPAAG) return e.altitude < 150 ? 2.8 : 2;   // AA-tasked mount
      }
    }
    if (e.kind === 'soldier') {
      if (v) {
        const arch = ARCHETYPE_OF[v.def.type];
        if (arch === Archetype.SAM || arch === Archetype.FIGHTER) return 0;
        if (!this.canHurt(s, e)) return 0;
        return (e.launcher ? 1.5 : 1) * (arch === Archetype.SPAAG ? 0.7 : arch === Archetype.STRIKE_JET ? 0.6 : 1);
      }
      return e.launcher && s.cls !== SoldierClass.AT ? 1.15 : 1;
    }
    if (!this.canHurt(s, e)) return 0;
    const air = e.isAircraft, armor = e.def.armor, tArch = ARCHETYPE_OF[e.def.type];
    if (v) {
      const arch = ARCHETYPE_OF[v.def.type];
      switch (arch) {
        case Archetype.FIGHTER:
          return tArch === Archetype.FIGHTER ? 4 : tArch === Archetype.STRIKE_JET ? 3.5 : tArch === Archetype.ATTACK_HELI ? 3 : air ? 2.5 : 0.2;
        case Archetype.SAM: return air ? (e.def.kind === 'jet' ? 3 : e.altitude > 80 ? 3 : 2.4) : 0;
        case Archetype.SPAAG: return air ? (e.altitude < 150 ? 3.2 : 2.4) : armor === 'soft' ? 0.9 : 0.4;
        case Archetype.STRIKE_JET: case Archetype.ATTACK_HELI:
          return air ? 0.4 : armor === 'heavy' ? 2.6 : armor === 'light' ? 2.2 : 1.6;
        default:
          return air ? 0.8 : armor === 'heavy' ? 2.2 : armor === 'light' ? 1.9 : 1.3;
      }
    }
    return air ? 0.6 : s.cls === SoldierClass.AT ? (armor === 'soft' ? 1.4 : 2) : armor === 'soft' ? 0.8 : 0.2;
  }

  canHurt(s: SoldierLike, e: SoldierLike | VehicleLike): boolean {
    const v = s.vehicle;
    if (v) {
      // Includes crew weapons that fall back to this seat while the gunner's seat is empty.
      const list = v.mountList(s.seat);
      const armor = e.kind === 'vehicle' ? e.def.armor : 'soft';
      for (let i = 0; i < list.length; i++) {
        const def = v.weapons[list[i]].def;
        if (e.kind === 'soldier') { if (def.homing !== 'air' && (def.type === 'hitscan' || (def.radius || 0) > 0)) return true; continue; }
        if (def.homing === 'air' ? e.isAircraft && e.altitude > 3 : def.vsVehicle[armor] > 0.05) return true;
      }
      return false;
    }
    if (e.kind === 'soldier') return true;
    const l = s.launcher;
    if (l && l.ammo + l.reserve > 0 && e.def.armor !== 'jet') return true;
    return s.rifle.def.vsVehicle[e.def.armor] > 0.05;
  }

  /** Chooses the agent's target from its memory (visible first, then fresh LKPs). */
  selectTarget(o: number): void {
    const g = this.game, s = g.soldiers[o], a = s.ai, mem = this.memory, K = mem.k, time = g.time;
    if (!a) return;
    const base = o * K;
    let best = -1, bestScore = 0, bestVisible = false;
    const cur = a.target ? this.index(a.target) : -1;
    for (let i = base; i < base + K; i++) {
      const t = mem.target[i];
      if (t < 0) continue;
      const f = mem.flags[i];
      if (!(f & (PF.ACQUIRED | PF.SHARED | PF.CUED))) continue;
      const e = this.entity(t);
      if (!e.alive) { mem.clearSlot(i); continue; }
      // A shot that just found the line blocked overrides a stale "visible" for the current target.
      const visible = (f & PF.VISIBLE) !== 0 && (f & PF.ACQUIRED) !== 0 && !(t === cur && time - a.lofBlockedAt < 1);
      const age = time - mem.lkpT[i];
      if (!visible && age > 7) continue;
      const p = this.priority(s, e);
      if (p <= 0) continue;
      const d = Math.hypot(mem.lkpX[i] - s.pos.x, mem.lkpZ[i] - s.pos.z);
      const score = p * (visible ? 1 : 0.3) / (1 + d / 90) * (t === cur ? 1.3 : 1);
      if (score > bestScore) { bestScore = score; best = i; bestVisible = visible; }
    }
    if (best < 0) {
      a.target = null; a.targetVisible = false; a.know = 0;
      return;
    }
    const bf = mem.flags[best];
    a.know = bestVisible ? 4 : (bf & PF.ACQUIRED) ? 3 : (bf & PF.SHARED) ? 2 : 1;
    const t = mem.target[best];
    if (t !== cur) a.acquireTime = time + (0.25 + hash01(o, t) * 0.35) / a.skill;
    a.target = this.entity(t);
    a.targetVisible = bestVisible;
    a.lastSeenX = mem.lkpX[best]; a.lastSeenY = mem.lkpY[best]; a.lastSeenZ = mem.lkpZ[best]; a.lastSeenTime = mem.lkpT[best];
  }

  /** External cue (radio AIR_THREAT, laser mark): seeds an LKP; detection still needs line of sight. */
  cue(o: number, t: number, x: number, y: number, z: number): void {
    const mem = this.memory, slot = mem.alloc(o, t);
    mem.flags[slot] |= PF.CUED;
    mem.level[slot] = Math.max(mem.level[slot], 0.6);
    mem.lkpX[slot] = x; mem.lkpY[slot] = y; mem.lkpZ[slot] = z; mem.lkpT[slot] = this.game.time;
  }

  // ================================================================= events

  /** Gunfire heard by enemy bots within `radius` (rate-limited per shooter). */
  onNoise(x: number, z: number, radius: number, team: number, shooterId: number): void {
    const g = this.game, time = g.time, mem = this.memory;
    if (shooterId >= 0 && shooterId < this.S) {
      if (this.nextNoise[shooterId] > time) return;
      this.nextNoise[shooterId] = time + 0.6;
    }
    const n = this.grid.queryRadius(x, z, radius, IDS, 0, this.S);
    for (let i = 0; i < n; i++) {
      const o = IDS[i], s = g.soldiers[o];
      if (s.team === team || !s.alive || s.isPlayer || !s.ai) continue;
      if (shooterId < 0) continue;
      const slot = mem.alloc(o, shooterId);
      if (mem.flags[slot] & PF.VISIBLE) continue;
      const d = Math.hypot(s.pos.x - x, s.pos.z - z);
      const err = d * 0.08;
      mem.flags[slot] |= PF.HEARD;
      mem.lkpX[slot] = x + (hash01(o, shooterId + (time | 0)) - 0.5) * 2 * err;
      mem.lkpZ[slot] = z + (hash01(shooterId, o + (time | 0)) - 0.5) * 2 * err;
      mem.lkpY[slot] = g.map.terrain.height(mem.lkpX[slot], mem.lkpZ[slot]) + 1.2;
      mem.lkpT[slot] = time;
      mem.level[slot] = Math.max(mem.level[slot], 0.3);
    }
  }

  onDamaged(victimId: number, attacker: SoldierLike | null): void {
    const st = this.st, time = this.game.time;
    st.lastHitAt[victimId] = time;
    st.suppression[victimId] = Math.min(1, st.suppression[victimId] + 0.35);
    st.morale[victimId] = Math.max(0, st.morale[victimId] - 0.08);
    if (!attacker || attacker.id < 0 || attacker.team === this.game.soldiers[victimId].team) return; // id < 0: base air defence
    const v = this.game.soldiers[victimId];
    st.threatX[victimId] += attacker.pos.x - v.pos.x; st.threatZ[victimId] += attacker.pos.z - v.pos.z;
    // Being hit reveals the shooter's direction (not a wall-hack: an approximate LKP).
    const mem = this.memory, slot = mem.alloc(victimId, attacker.id);
    if (!(mem.flags[slot] & PF.VISIBLE)) {
      mem.flags[slot] |= PF.HEARD;
      mem.lkpX[slot] = attacker.pos.x; mem.lkpY[slot] = attacker.pos.y + 1.2; mem.lkpZ[slot] = attacker.pos.z; mem.lkpT[slot] = time;
      mem.level[slot] = Math.max(mem.level[slot], 0.6);
    }
  }

  /** Near misses and nearby blasts. */
  onSuppress(id: number, amount: number, fromX: number, fromZ: number): void {
    const st = this.st, s = this.game.soldiers[id];
    st.suppression[id] = Math.min(1, st.suppression[id] + amount);
    // A heavy single dose (a blast close by, fire from point blank) counts as acute danger for the purpose gate.
    if (amount > 0.3 || (fromX - s.pos.x) ** 2 + (fromZ - s.pos.z) ** 2 < 15 * 15) this.acuteAt[id] = this.game.time;
    st.threatX[id] += (fromX - s.pos.x) * 0.2; st.threatZ[id] += (fromZ - s.pos.z) * 0.2;
  }

  onDeath(victimId: number): void {
    const s = this.game.soldiers[victimId], q = s.squad as SquadBlackboard | null;
    if (!q) return;
    for (let i = 0; i < q.count; i++) {
      const m = q.members[i];
      if (m === victimId) continue;
      const o = this.game.soldiers[m];
      if (!o.alive) continue;
      if ((o.pos.x - s.pos.x) ** 2 + (o.pos.z - s.pos.z) ** 2 < 40 * 40) this.st.morale[m] = Math.max(0, this.st.morale[m] - 0.15);
    }
    this.cover.release(this.st.coverNode[victimId], victimId);
    this.st.coverNode[victimId] = -1;
  }

  // ================================================================= utility (infantry)

  /** Tactical decision for a dismounted bot (4 Hz, staggered by id). */
  tactical(o: number): void {
    const g = this.game, s = g.soldiers[o], a = s.ai, st = this.st, time = g.time;
    if (!a || !s.alive || s.vehicle) return;
    this.stats.tactical++;
    const dtT = Math.min(1, time - st.lastTactical[o]);
    st.lastTactical[o] = time;

    // --- Self-preservation state ------------------------------------------------
    st.suppression[o] *= Math.exp(-0.45 * dtT);
    st.threatX[o] *= Math.exp(-0.3 * dtT); st.threatZ[o] *= Math.exp(-0.3 * dtT);
    const sup = st.suppression[o];
    const q = s.squad as SquadBlackboard | null;
    const leader = q && q.leader >= 0 ? g.soldiers[q.leader] : null;
    const nearLeader = leader && leader !== s && leader.alive && !leader.vehicle && (leader.pos.x - s.pos.x) ** 2 + (leader.pos.z - s.pos.z) ** 2 < 30 * 30;
    const inCover = st.coverNode[o] >= 0 && (this.cover.x[st.coverNode[o]] - s.pos.x) ** 2 + (this.cover.z[st.coverNode[o]] - s.pos.z) ** 2 < 4;
    st.morale[o] = clamp01(st.morale[o] + dtT * ((nearLeader ? 0.05 : 0.02) + (inCover ? 0.04 : 0) - sup * 0.08));
    const morale = st.morale[o];
    const hp = s.health / 100;
    const rifle = s.rifle;
    const ammo = (rifle.ammo + rifle.reserve) / (rifle.def.mag + rifle.def.reserve);

    // --- Threat picture -----------------------------------------------------------
    const threats = this.threats;
    threats.clear();
    const mem = this.memory, K = mem.k, base = o * K;
    let heardSlot = -1;
    for (let i = base; i < base + K; i++) {
      const t = mem.target[i];
      if (t < 0 || time - mem.lkpT[i] > 15) continue;
      const f = mem.flags[i];
      if (f & (PF.ACQUIRED | PF.SHARED)) threats.add(mem.lkpX[i], mem.lkpZ[i], t < this.S ? 1 : 2);
      else if (f & PF.HEARD) { threats.add(mem.lkpX[i], mem.lkpZ[i], 0.5); if (heardSlot < 0 || mem.lkpT[i] > mem.lkpT[heardSlot]) heardSlot = i; }
    }
    if (q) {
      for (let i = 0; i < q.cTarget.length; i++) if (q.cTarget[i] >= 0 && time - q.cT[i] < 10) threats.add(q.cX[i], q.cZ[i], 0.6);
    }
    const hasThreat = threats.centroid(C2) > 0;
    const tcx = C2[0], tcz = C2[1];
    const t = a.target, visible = t !== null && a.targetVisible;
    const tdist = t ? Math.hypot(a.lastSeenX - s.pos.x, a.lastSeenZ - s.pos.z) : 1e9;
    const threatened = hasThreat && (visible || time - st.lastHitAt[o] < 4 || sup > 0.25);
    const protection = inCover ? this.cover.protection(st.coverNode[o], threats) : -0.5;
    const danger = this.radio.inDangerZone(s.team, s.pos.x, s.pos.z, 12, time);
    const ticket = st.ticket[o] >= 0 && this.hooks ? this.hooks.ticketVehicle(o) : null;
    const posture = q ? q.posture : Posture.ASSAULT;
    const ft = st.fireteam[o];
    // Where the squad's orders want this soldier: assembly area, attack position, support position or flag.
    const goalR = q ? squadGoal(q, GOAL) : -1;
    // At the objective: inside its radius, or (a squad holding ground with planned fighting positions) anywhere in
    // the planned area. Defenders at posts up to 34 m out used to count as "not there", walk in toward the flag,
    // count as arrived, and walk back out to the post: back and forth for as long as they defended.
    let atObj = goalR >= 0 && ((GOAL[0] - s.pos.x) ** 2 + (GOAL[1] - s.pos.z) ** 2 < (goalR + 6) ** 2 ||
      (q !== null && q.planMode >= 0 && (q.planX - s.pos.x) ** 2 + (q.planZ - s.pos.z) ** 2 < 46 * 46));
    // A rooftop objective still to be taken is only reached on the roof, not standing under it.
    if (atObj && q && q.objective && (q.objective as any).host && q.objective.owner !== s.team && !inCaptureVolume(q.objective, s.pos.x, s.pos.y, s.pos.z, AI_TUNING.captureRadius)) atObj = false;
    const isLeader = q !== null && q.leader === o;
    const crew = s.cls === SoldierClass.CREWMAN || s.cls === SoldierClass.PILOT;
    // Armour, or a helicopter hanging low and slow in reach of a launcher.
    const armorTarget = t !== null && t.kind === 'vehicle' && t.def.armor !== 'soft' &&
      (!t.isAircraft || ((t as VehicleLike).def.kind === 'heli' && t.altitude < 120 && Math.abs(t.speed) < 25));
    const launcherReady = s.launcher !== null && s.launcher.ammo + s.launcher.reserve > 0;
    let aspect = 0;
    if (armorTarget && !(t as VehicleLike).isAircraft) {
      const tv = t as VehicleLike;
      const fy = tv.yaw;
      const toMeX = s.pos.x - tv.pos.x, toMeZ = s.pos.z - tv.pos.z, dm = Math.hypot(toMeX, toMeZ) || 1;
      aspect = Math.acos(clamp((Math.sin(fy) * toMeX + Math.cos(fy) * toMeZ) / dm, -1, 1)); // 0 = we face its front
    }

    // Temperament: a fixed trait per soldier (0 cautious … 1 bold); leaders and the more skilled are a little
    // bolder. It shifts how readily they go to ground, press on, or break, so a squad never reacts as one.
    const bold = clamp01(hash01(o, 991) * 0.75 + (isLeader ? 0.15 : 0) + (a.skill - 1) * 0.4 + 0.08);
    // On the move with a purpose (attack / move order, or heading for a flag to take): a distant enemy is
    // engaged on the move, not a reason to stop; close or suppressing threats still stop the squad.
    const onTask = q !== null && goalR >= 0 && !atObj && !crew && (q.order === Order.ATTACK || q.order === Order.MOVE ||
      (q.order === Order.NONE && q.objective !== null && q.objective.owner !== s.team));
    const marching = onTask && visible && tdist > 150 - 50 * bold && sup < 0.35 && hp > 0.5;

    // --- Scores --------------------------------------------------------------------------
    const sc = SCORES;
    sc.fill(0);
    sc[Action.PATROL] = 0.12;
    if (goalR >= 0 && !atObj && !crew) sc[Action.ADVANCE] = 0.38 + (isLeader ? 0.05 : 0);
    // Final assault: inside 75 m of an enemy / neutral flag the attackers close in with marching fire instead of trading shots.
    const fo = q ? q.objective : null;
    // ...and for a squad that has decided on a final assault (see SquadAndConvoyManager.updateCapture), from further out;
    // free squads taking a flag on their own initiative rush the last 60 m the same way.
    const fd2 = fo ? (fo.x - s.pos.x) ** 2 + (fo.z - s.pos.z) ** 2 : 1e12;
    const rush = q !== null && fo !== null && fo.owner !== s.team && !(fo as any).base && fd2 > 9 * 9 &&
      ((q.order === Order.ATTACK && q.axisDone && (fd2 < 75 * 75 || (time < q.assaultUntil && fd2 < 170 * 170))) ||
       (q.order === Order.NONE && q.vehicle < 0 && (fd2 < 60 * 60 || (time < q.assaultUntil && fd2 < 170 * 170))));
    if (rush) sc[Action.ADVANCE] = Math.max(sc[Action.ADVANCE], 0.74 + (hp > 0.5 ? 0.06 : 0) - 0.35 * sup);
    st.rushing[o] = rush ? 1 : 0;
    if (posture === Posture.REGROUP && !isLeader && leader && leader.alive && !leader.vehicle &&
      (leader.pos.x - s.pos.x) ** 2 + (leader.pos.z - s.pos.z) ** 2 > 15 * 15) sc[Action.REGROUP] = 0.5;
    // Just off a vehicle: first get clear of the hull, then gather at the rally point beside it until most of the
    // squad is together (or 12 s have passed), so it moves on as a squad instead of scattering from the doors.
    if (q !== null && !crew && time - q.dropT < 12 && !q.dropGathered && this.dropGathering(q, s, time)) sc[Action.REGROUP] = time - q.dropT < 4 ? 0.85 : 0.6;
    if (visible) {
      sc[Action.ENGAGE] = marching ? 0.34 : 0.55 + (tdist < 80 ? 0.15 : 0) - 0.25 * sup + (bold - 0.5) * 0.08;
      if (posture === Posture.BOUND && ft !== (q as SquadBlackboard).boundTeam) sc[Action.ENGAGE] += 0.1;
    } else if (t !== null && time - a.lastSeenTime < 6) {
      const overwatch = (posture === Posture.BOUND && q && ft !== q.boundTeam) || (posture === Posture.FLANK && q && ft !== q.flankTeam);
      // Suppression is worth choosing only with our own sighting and a line of fire from here.
      const canSuppress = a.know >= 3 && time >= a.noLineUntil;
      sc[Action.SUPPRESS] = canSuppress ? (overwatch ? 0.62 : 0.3) : 0;
      sc[Action.ENGAGE] = 0.33;
    }
    // Suppress-and-bound: the covering team smokes the defenders' line once, then lays down fire for the bounders.
    if (q && q.capState === 'suppress-and-bound' && ft !== q.boundTeam) {
      if (q.sbSmoke && hasThreat && st.smokeReadyAt[o] <= time && (s.cls === SoldierClass.LEADER || s.cls === SoldierClass.SUPPORT)) { q.sbSmoke = false; this.maybeSmoke(o, hasThreat, tcx, tcz); this.stats.feintSmoke++; }
      if (t !== null && time - a.lastSeenTime < 8 && a.know >= 3) sc[Action.SUPPRESS] = Math.max(sc[Action.SUPPRESS], 0.66);
    }
    // Fire and movement: the bounding team moves (unless pinned), the other fire team covers it.
    if (q && posture === Posture.BOUND && ft === q.boundTeam && !(visible && tdist < 35)) sc[Action.BOUND] = 0.75 - 0.3 * sup;
    if (q && posture === Posture.FLANK && ft === q.flankTeam) sc[Action.FLANK] = 0.7;
    if (threatened) {
      sc[Action.TAKE_COVER] = (0.35 + 0.45 * sup + 0.3 * (1 - hp) + (s.weapon.reloading ? 0.25 : 0)) * (1 - Math.max(0, protection)) * (1.2 - 0.4 * bold);
    }
    if ((hp < 0.35 && threatened) || morale < 0.12 + 0.16 * (1 - bold)) sc[Action.RETREAT] = 0.75 + Math.max(0, 0.35 - hp);
    if (ammo < 0.2) sc[Action.RESUPPLY] = 0.6 + (0.2 - ammo);
    if (ticket) sc[Action.BOARD] = 0.92;
    // A noise: free squads go and look; soldiers holding a post (defend / hold / support) only for one right by
    // them, otherwise they turn to watch that way from where they are.
    const holdingPost = q !== null && (q.order === Order.DEFEND || q.order === Order.HOLD || q.order === Order.SUPPORT) && q.planMode >= 0;
    if (!visible && heardSlot >= 0 && !t && time - mem.lkpT[heardSlot] < 8 && this.leash(q, mem.lkpX[heardSlot], mem.lkpZ[heardSlot]) &&
      (!holdingPost || (mem.lkpX[heardSlot] - s.pos.x) ** 2 + (mem.lkpZ[heardSlot] - s.pos.z) ** 2 < 25 * 25)) sc[Action.INVESTIGATE] = 0.42;
    st.heardYaw[o] = heardSlot >= 0 && time - mem.lkpT[heardSlot] < 8 ? Math.atan2(mem.lkpX[heardSlot] - s.pos.x, mem.lkpZ[heardSlot] - s.pos.z) : NaN;
    if (armorTarget && visible && s.cls === SoldierClass.AT && launcherReady && aspect < 1.1 && tdist > 40 && sup < 0.6) sc[Action.AMBUSH] = 0.82;
    if (danger >= 0) sc[Action.HOLD] = 0.97;
    if (crew && !ticket) sc[Action.CREW_WAIT] = 0.45;
    if (s.cls === SoldierClass.SUPPORT && sup < 0.5) {
      if (this.findHeal(s) >= 0) sc[Action.HEAL] = 0.6;
      if (this.findRepair(s) >= 0) sc[Action.REPAIR] = 0.58;
    }
    // Screening armour is for squads on the move or attacking, never for a garrison holding its positions.
    const mobile = !q || q.order === Order.NONE || q.order === Order.ATTACK || q.order === Order.MOVE;
    if (!visible && !crew && mobile && this.findScreenTank(s) !== null) sc[Action.SCREEN] = 0.5;

    // --- Deliberate: Q1–Q5 for each candidate action, best first; Q6 falls through to the next ----------
    const cur = st.action[o];
    const D = this.delib.begin(o, time, bold, Math.max(sup, 1 - hp));
    for (let i = 0; i < ACTION_COUNT; i++) if (sc[i] > 0) D.propose(i, sc[i] + (i === cur ? AI_TUNING.hysteresis : 0));
    let best = -1;
    for (let act = D.next(); act >= 0; act = D.next()) {
      if (this.answerAction(D, o, act, cur, s, a, q, t, visible, tdist, sup, hp, bold, ammo, morale, threatened, protection, inCover,
        threats, hasThreat, tcx, tcz, launcherReady, aspect, heardSlot, ticket, fo, ft, time) === 0) { best = D.choose(act); break; }
    }
    if (best < 0) { D.none(); best = sc[cur] > 0 ? cur : Action.PATROL; }
    if (best !== cur && best !== D.lastIds[0]) this.stats.gateHeld++;
    if (o < 4096) { const b = o * 4; for (let k = 0; k < 4; k++) this.traceBuf[b + k] = k < D.lastN ? (D.lastIds[k] << 3) | D.lastFail[k] : 0xff; }
    if (best !== cur) {
      const urgent = best === Action.HOLD || best === Action.BOARD || (best === Action.RETREAT && hp < 0.25) || (best === Action.TAKE_COVER && sup > 0.7);
      const committed = time < st.commitUntil[o] && sc[cur] > 0;
      if (committed && !urgent && sc[best] - sc[cur] < AI_TUNING.interruptMargin) best = cur;
    }
    if (best !== cur) {
      st.action[o] = best; st.actionStart[o] = time; st.commitUntil[o] = time + ACTION_COMMIT[best];
      st.arrived[o] = 0;
      if (best !== Action.TAKE_COVER && best !== Action.BOUND && best !== Action.ENGAGE) { this.cover.release(st.coverNode[o], o); st.coverNode[o] = -1; }
    }
    st.actionScore[o] = sc[best];
    a.state = ACTION_NAMES[best];
    this.execute(o, best, dtT, hasThreat, tcx, tcz, tdist, visible, armorTarget, aspect, launcherReady, danger, heardSlot, ticket);
    // (Cover posts are reserved per soldier, so only open-ground moves are spaced.)
    if (q && (best === Action.ADVANCE || best === Action.FLANK || best === Action.REGROUP) && !((a.upB ?? -1) >= 0)) this.spaceGoal(o, q, s, a);
    // Taking a flag: a soldier at the capture circle does not step out of it for cover or a better shot (a capture
    // counts bodies in the circle); his moves are kept inside it. Breaking off badly hurt (retreat) still goes.
    if (q && fo && fo.owner !== s.team && best !== Action.RETREAT && best !== Action.BOARD && best !== Action.HOLD &&
      (q.capState === 'in the circle' || q.capState === 'capturing' || q.capState === 'final assault') && fd2 < 20 * 20 && a.hasGoal) {
      const R = AI_TUNING.captureRadius - 3, gx = a.goalX - fo.x, gz = a.goalZ - fo.z, gd = Math.hypot(gx, gz);
      if (gd > R) {
        const x = fo.x + (gx / gd) * R, z = fo.z + (gz / gd) * R;
        if (!g.nav.blocked(x, z)) { a.goalX = x; a.goalZ = z; } else a.hasGoal = false;
        this.stats.circleHolds++;
      }
    }
  }

  /**
   * Q1–Q5 for one candidate action of a soldier (see deliberation.ts). Answers are drawn from what the soldier
   * actually knows: its own sightings and memory, its squad's orders and posture, what squadmates are already
   * doing, its health, ammunition and gear. Returns 0 when the action holds, else the failed question.
   */
  private answerAction(D: Deliberation, o: number, act: number, cur: number, s: SoldierLike, a: AgentLike, q: SquadBlackboard | null,
    t: any, visible: boolean, tdist: number, sup: number, hp: number, bold: number, ammo: number, morale: number, threatened: boolean,
    protection: number, inCover: boolean, threats: any, hasThreat: boolean, tcx: number, tcz: number, launcherReady: boolean, aspect: number,
    heardSlot: number, ticket: VehicleLike | null, fo: FlagLike | null, ft: number, time: number): number {
    const st = this.st;
    const acute = time - this.acuteAt[o] < 1.2 || (visible && tdist < 20) || sup > 0.8;
    const moving = cur === Action.ADVANCE || cur === Action.BOUND || cur === Action.FLANK;
    const stopping = act === Action.TAKE_COVER || act === Action.ENGAGE || act === Action.SUPPRESS || act === Action.INVESTIGATE || act === Action.PATROL;
    // Q2 shared by every stop: a move in progress holds for its minimum commitment (1.5–2 s by temperament).
    const held = moving && stopping && (act as number) !== (cur as number) && !acute && time - st.actionStart[o] < 1.5 + 0.5 * bold;
    // Committed to taking a flag (rushing, final assault, in the circle, or bounding in a suppress-and-bound).
    const committed = q !== null && fo !== null && fo.owner !== s.team && (st.rushing[o] === 1 || q.capState === 'final assault' ||
      q.capState === 'capturing' || q.capState === 'in the circle' || (q.capState === 'suppress-and-bound' && ft === q.boundTeam));
    const rounds = s.rifle.ammo + s.rifle.reserve > 0 ? 1 : 0;
    const lof = time >= a.noLineUntil ? 1 : 0;
    const range = (s.weapon && s.weapon.def && s.weapon.def.range) || 300;
    switch (act) {
      case Action.ENGAGE: {
        const why = visible || (t !== null && time - a.lastSeenTime < 6);
        // Committed attackers answer distant fire on the move; a stop pays only for a close threat.
        const benefit = committed && tdist > 40 && sup < 0.6 && !acute ? 0.2 : tdist < range * (0.8 + 0.4 * bold) ? 1 : 0.35;
        return D.check(why, held ? 0 : 1, benefit, lof || visible ? 1 : 0, rounds);
      }
      case Action.SUPPRESS: {
        const why = t !== null && a.know >= 3;
        // Necessary only while too few squadmates are already firing on that line (bounders need cover anyway).
        const covering = q !== null && ((q.posture === Posture.BOUND && ft !== q.boundTeam) || (q.posture === Posture.FLANK && ft !== q.flankTeam) || q.capState === 'suppress-and-bound');
        const others = q ? this.squadDoing(q, o, Action.SUPPRESS) : 0;
        const need = held ? 0 : covering || others < 2 + Math.round(bold * 2) ? 1 : 0.2;
        const benefit = covering ? 1 : committed && !acute ? 0.25 : 0.6;
        return D.check(why, need, benefit, lof, ammo > 0.12 ? 1 : 0);
      }
      case Action.TAKE_COVER: {
        // Already well protected: going for other cover does not add anything.
        const need = held ? 0 : inCover && protection > 0.75 && !s.weapon.reloading ? 0.3 : 1;
        const coverGain = st.coverNode[o] >= 0 ? this.cover.protection(st.coverNode[o], threats) : 0.3;
        const benefit = committed && tdist > 40 && sup < 0.6 && coverGain < 0.45 && !acute ? 0.2 : 1;
        // Somewhere to go: a cover post or concealment nearby, or real fire that makes going prone worth it.
        const near = this.cover.grid.query(s.pos.x, s.pos.z, 25, IDS) > 0;
        return D.check(threatened || acute, need, benefit, near || sup > 0.4 ? 1 : 0.3, 1);
      }
      case Action.ADVANCE: {
        // Walking into heavy fire without being committed does not help the squad.
        const benefit = st.rushing[o] === 1 || committed || sup < 0.7 || bold > 0.65 ? 1 : 0.3;
        return D.check(true, 1, benefit, 1, hp > 0.2 && (rounds || st.rushing[o] === 1) ? 1 : 0.3);
      }
      case Action.BOUND: case Action.FLANK:
        return D.check(q !== null, 1, sup < 0.85 ? 1 : 0.2, 1, rounds && hp > 0.25 ? 1 : 0);
      case Action.RETREAT: {
        const need = threatened || morale < 0.2 || hp < 0.3 ? 1 : 0.4;
        return D.check(true, need, 1, 1, 1);
      }
      case Action.RESUPPLY: {
        // Running for ammo at point blank leaves the squad short a rifle: only once really empty.
        const benefit = visible && tdist < 40 && ammo > 0.04 ? 0.3 : 1;
        return D.check(ammo < 0.2, 1, benefit, 1, 1);
      }
      case Action.BOARD:
        return D.check(ticket !== null, 1, 1, ticket !== null && ticket.alive, 1);
      case Action.INVESTIGATE: {
        // One or two looking is enough; the rest keep their places.
        const others = q ? this.squadDoing(q, o, Action.INVESTIGATE) : 0;
        const need = held ? 0 : others < 2 + Math.round(bold) ? 1 : 0.2;
        return D.check(heardSlot >= 0, need, hp > 0.45 ? 1 : 0.3, 1, ammo > 0.15 ? 1 : 0);
      }
      case Action.AMBUSH:
        return D.check(visible && t !== null, 1, aspect < 1.1 && tdist < 400 ? 1 : 0.3, lof || visible ? 1 : 0, launcherReady);
      case Action.REGROUP:
        return D.check(true, 1, !(visible && tdist < 30) || bold > 0.8 ? 1 : 0.4, 1, 1);
      case Action.HEAL: case Action.REPAIR: {
        const others = q ? this.squadDoing(q, o, act) : 0;
        return D.check(true, others < 1 ? 1 : 0.3, sup < 0.5 ? 1 : 0.3, 1, 1);
      }
      case Action.SCREEN:
        return D.check(true, held ? 0 : 1, !(visible && tdist < 60) ? 1 : 0.4, 1, 1);
      default:
        // PATROL, HOLD (danger zone), CREW_WAIT: always grounded; PATROL is everyone's last resort.
        return D.check(true, act === Action.PATROL && held ? 0 : 1, 1, 1, 1);
    }
  }

  /** Squadmates (other than o) currently doing `act`. */
  /** "engage✗benefit → cover✓" for the debug overlay. */
  traceOf(o: number): string {
    if (o >= 4096) return '';
    let out = '';
    for (let k = 0; k < 4; k++) {
      const c = this.traceBuf[o * 4 + k];
      if (c === 0xff) break;
      out += (k ? ' → ' : '') + ACTION_NAMES[c >> 3] + ((c & 7) ? `✗${Q_NAMES[c & 7]}` : '✓');
    }
    return out;
  }

  private squadDoing(q: SquadBlackboard, o: number, act: number): number {
    let n = 0;
    const m = q.members;
    for (let i = 0; i < m.length; i++) { const id = m[i]; if (id >= 0 && id !== o && this.st.action[id] === act && this.game.soldiers[id].alive) n++; }
    return n;
  }

  private execute(o: number, act: number, dtT: number, hasThreat: boolean, tcx: number, tcz: number, tdist: number, visible: boolean,
    armorTarget: boolean, aspect: number, launcherReady: boolean, danger: number, heardSlot: number, ticket: VehicleLike | null): void {
    const g = this.game, s = g.soldiers[o], a = s.ai as AgentLike, st = this.st, time = g.time;
    const q = s.squad as SquadBlackboard | null;
    const obj = q ? q.objective : null;
    a.weaponPref = 0;
    a.lookYaw = NaN;
    const walking = (a as any).walkTo; (a as any).walkTo = null;
    let stance: number = Stance.STAND;
    switch (act) {
      case Action.ENGAGE: {
        // Aimed fire at what we see; suppressive fire only at our own recent sighting. A position known only from
        // a comrade's report or a sound is watched and approached, not shot at; no line from here: stop and move.
        const noLine = time < a.noLineUntil;
        a.fireMode = noLine ? 0 : visible ? 1 : a.know >= 3 ? 2 : 0;
        if (!visible) a.lookYaw = Math.atan2(a.lastSeenX - s.pos.x, a.lastSeenZ - s.pos.z);
        // Holding a post (defence / hold / support): fight from it. No random shuffles or drifting toward the enemy;
        // a blocked line moves the soldier a few metres along, never more than 10 m from the post.
        const post = this.postOf(o, q);
        if (post >= 0 && q) {
          const px = q.plan.x[post], pz = q.plan.z[post];
          if (noLine && (s.pos.x - px) ** 2 + (s.pos.z - pz) ** 2 < 8 * 8 && !a.hasGoal) {
            const dx = a.lastSeenX - s.pos.x, dz = a.lastSeenZ - s.pos.z, d = Math.hypot(dx, dz) || 1, side = o & 1 ? 1 : -1;
            const x = s.pos.x - (dz / d) * side * 4, z = s.pos.z + (dx / d) * side * 4;
            if (!g.nav.blocked(x, z) && (x - px) ** 2 + (z - pz) ** 2 < 10 * 10) { this.go(a, x, z, false); break; }
          }
          if (!noLine || (s.pos.x - px) ** 2 + (s.pos.z - pz) ** 2 > 10 * 10) {
            if (!this.arrivedAt(s, px, pz, 1.4)) this.go(a, px, pz, false); else if (!a.hasGoal || this.arrivedAt(s, a.goalX, a.goalZ, 1.2)) a.hasGoal = false;
          }
          stance = !a.hasGoal ? q.plan.stance[post] : Stance.STAND;
          break;
        }
        if (noLine && !a.hasGoal) {
          const dx = a.lastSeenX - s.pos.x, dz = a.lastSeenZ - s.pos.z, d = Math.hypot(dx, dz) || 1, side = o & 1 ? 1 : -1;
          const x = s.pos.x + (dx / d) * 6 - (dz / d) * side * 4, z = s.pos.z + (dz / d) * 6 + (dx / d) * side * 4;
          if (!g.nav.blocked(x, z)) { this.go(a, x, z, false); break; }
        }
        if (armorTarget && launcherReady && (s.cls !== SoldierClass.AT || aspect > 1.2 || tdist < 40)) a.weaponPref = 1;
        else if (a.target && a.target.kind === 'vehicle' && a.target.def.armor === 'soft' && launcherReady) a.weaponPref = 1;
        const effective = a.weaponPref ? 200 : 140;
        // Leash: no chasing kills away from the task; fight from where the orders put us.
        const chase = this.leash(q, a.lastSeenX, a.lastSeenZ);
        if (tdist > effective && !chase) { if (!this.occupy(o, q, a, s)) a.hasGoal = false; }
        else if (tdist > effective) this.moveViaCover(o, a.lastSeenX, a.lastSeenZ, 22, 0.6, hasThreat, tcx, tcz);
        else if (st.coverNode[o] >= 0) this.go(a, this.cover.x[st.coverNode[o]], this.cover.z[st.coverNode[o]], false);
        else if (time - st.actionStart[o] > 1.5 && rand(st.rng, o) < 0.35 * dtT * 4) {
          // Short lateral shuffles under fire.
          const dx = a.lastSeenX - s.pos.x, dz = a.lastSeenZ - s.pos.z, d = Math.hypot(dx, dz) || 1, side = rand(st.rng, o) < 0.5 ? 1 : -1;
          const x = s.pos.x - (dz / d) * side * 3, z = s.pos.z + (dx / d) * side * 3;
          if (!g.nav.blocked(x, z)) this.go(a, x, z, false); else a.hasGoal = false;
        } else if (!a.hasGoal || this.arrivedAt(s, a.goalX, a.goalZ, 1.2)) a.hasGoal = false;
        stance = !a.hasGoal && (tdist > 80 || (st.coverNode[o] >= 0 && this.cover.isLow(st.coverNode[o]))) ? Stance.CROUCH : Stance.STAND;
        break;
      }
      case Action.SUPPRESS:
        // Suppression needs our own recent sighting and a line of fire from here.
        a.fireMode = time < a.noLineUntil || a.know < 3 ? 0 : 2;
        if (st.coverNode[o] >= 0) this.go(a, this.cover.x[st.coverNode[o]], this.cover.z[st.coverNode[o]], false); else a.hasGoal = false;
        stance = Stance.CROUCH;
        break;
      case Action.TAKE_COVER: {
        if (st.coverNode[o] < 0 || !this.cover.valid(st.coverNode[o])) this.pickCover(o, 24, 0, hasThreat, tcx, tcz, 0, 0);
        const c = st.coverNode[o];
        if (c >= 0) {
          this.go(a, this.cover.x[c], this.cover.z[c], !this.arrivedAt(s, this.cover.x[c], this.cover.z[c], 4));
          const there = this.arrivedAt(s, this.cover.x[c], this.cover.z[c], 1.3);
          stance = there ? (this.cover.isLow(c) || st.suppression[o] > 0.6 ? Stance.CROUCH : Stance.STAND) : Stance.STAND;
          if (there && st.suppression[o] > 0.8) stance = Stance.PRONE;
        } else {
          // No cover nearby: get low.
          a.hasGoal = false;
          stance = st.suppression[o] > 0.5 ? Stance.PRONE : Stance.CROUCH;
        }
        a.fireMode = visible ? 1 : 0;
        if (st.suppression[o] > 0.65) this.maybeSmoke(o, hasThreat, tcx, tcz);
        break;
      }
      case Action.BOUND: {
        const c = st.coverNode[o];
        const needNew = c < 0 || !this.cover.valid(c) || (st.arrived[o] && time - st.actionStart[o] > 1);
        if (needNew && !st.arrived[o]) {
          const ox = obj ? obj.x : tcx, oz = obj ? obj.z : tcz;
          this.pickCover(o, 28, 0.5, hasThreat, tcx, tcz, ox, oz);
        }
        const cn = st.coverNode[o];
        if (cn >= 0) {
          this.go(a, this.cover.x[cn], this.cover.z[cn], true);
          if (this.arrivedAt(s, this.cover.x[cn], this.cover.z[cn], 1.5)) { st.arrived[o] = 1; a.hasGoal = false; stance = Stance.CROUCH; }
        } else if (obj) {
          // No cover in reach: short rush toward the objective instead.
          const dx = obj.x - s.pos.x, dz = obj.z - s.pos.z, d = Math.hypot(dx, dz) || 1;
          this.go(a, s.pos.x + (dx / d) * 15, s.pos.z + (dz / d) * 15, true);
          if (time - st.actionStart[o] > 4) st.arrived[o] = 1;
        } else st.arrived[o] = 1;
        a.fireMode = st.arrived[o] && visible ? 1 : 0;
        break;
      }
      case Action.FLANK:
        if (q) this.go(a, q.flankX, q.flankZ, true);
        a.fireMode = visible && tdist < 40 ? 1 : 0;
        break;
      case Action.RETREAT: {
        this.fallback(o, C2);
        this.go(a, C2[0], C2[1], true);
        a.fireMode = visible && tdist < 30 ? 1 : 0;
        if (st.suppression[o] > 0.5) this.maybeSmoke(o, hasThreat, tcx, tcz);
        break;
      }
      case Action.RESUPPLY: {
        // Nearest source of ammunition: the squad's ammo bearer, a supply truck, or an owned flag's cache.
        const truck = this.hooks ? this.hooks.nearestSupply(s.team, s.pos.x, s.pos.z, 220) : null;
        const bearer = this.squadBearer(q, s);
        if (bearer && (!truck || (bearer.pos.x - s.pos.x) ** 2 + (bearer.pos.z - s.pos.z) ** 2 < (truck.pos.x - s.pos.x) ** 2 + (truck.pos.z - s.pos.z) ** 2)) this.go(a, bearer.pos.x + 2, bearer.pos.z, false);
        else if (truck) this.go(a, truck.pos.x + 4, truck.pos.z + 4, true);
        else { const f = this.nearestFriendlyFlag(s); if (f) this.go(a, f.x, f.z, true); }
        if (time > st.nextRadioAt[o]) {
          st.nextRadioAt[o] = time + 20;
          this.radio.publish(RadioType.LOGISTICS_REQUEST, s.team, o, q ? q.id : -1, s.pos.x, s.pos.y, s.pos.z, -1, 1, time, Logistics.AMMO);
        }
        a.fireMode = visible ? 1 : 0;
        break;
      }
      case Action.BOARD:
        if (ticket) {
          // The vehicle cannot be reached from here: give the seat up now instead of holding it until it expires.
          if (a.navStatus === 'unreachable' && this.hooks) { this.hooks.abandonTicket(s); a.hasGoal = false; break; }
          // To the seat's door: a carrier's troop door at the back (opened for him), otherwise beside the hull.
          const tv = ticket as any, seatI = this.hooks ? this.hooks.ticketSeat(s) : -1;
          const rampSeat = seatI >= 0 && tv.def.rampDeck && tv.def.seats[seatI].role === 'passenger' && !tv.def.seats[seatI].front;
          if (rampSeat && (tv.rampDown || tv.inHold(s.pos))) {
            // Ramp aircraft, ramp down: up the ramp on his own feet, along the hold to his row, then he sits down.
            const W = tv.boardWalk(seatI);
            // Vehicle first: the stick waits off to the side of the ramp while its vehicle drives up.
            if (tv.cargoPending && !tv.inHold(s.pos)) {
              const side = (s.id & 1 ? 1 : -1) * (5 + (s.id % 3) * 1.2), fx = Math.sin(tv.yaw), fz = Math.cos(tv.yaw);
              this.go(a, W[0].x + fz * side - fx * 1.5, W[0].z - fx * side - fz * 1.5, false);
              (a as any).rampK = 0; a.fireMode = 0;
              break;
            }
            const nearLip = (W[0].x - s.pos.x) ** 2 + (W[0].z - s.pos.z) ** 2 < 3 * 3;
            if (!walking && !nearLip && !tv.inHold(s.pos)) { (a as any).rampK = 0; this.go(a, W[0].x, W[0].z, true); tv.holdDoors(2); a.fireMode = 0; break; }
            let k = Math.min((a as any).rampK | 0, W.length - 1);
            const A = a as any, dk = Math.hypot(W[k].x - s.pos.x, W[k].z - s.pos.z);
            // (the first point, behind the lip, only needs reaching roughly: the stick queues up there)
            if (dk < (k === 0 ? 2.0 : 0.5)) { k++; A.rampBest = 1e9; }
            // No headway for 4 s (blocked by something on the way): on to the next point, or into the seat.
            else if (dk < (A.rampBest ?? 1e9) - 0.3) { A.rampBest = dk; A.rampT = time; }
            else if (time - (A.rampT ?? time) > 4) { k++; A.rampBest = 1e9; A.rampT = time; }
            if (A.rampT === undefined || k === 0 && !walking) A.rampT = time;
            A.rampK = k; tv.holdDoors(2);
            if (k >= W.length) { (a as any).walkTo = null; (a as any).rampK = 0; if (this.hooks) this.hooks.tryBoard(s); }
            else { (a as any).walkTo = W[k]; a.hasGoal = false; }
            a.fireMode = 0;
            break;
          }
          if (seatI >= 0 && tv.def.rearAccess && tv.def.seats[seatI].role === 'passenger' && !tv.def.seats[seatI].front) {
            tv.accessPoint(seatI, _acc);
            this.go(a, _acc.x, _acc.z, true);
            const dd = (_acc.x - s.pos.x) ** 2 + (_acc.z - s.pos.z) ** 2;
            if (dd < 12 * 12) tv.holdDoors(2);
            // (a ramp aircraft is boarded on foot once its ramp is down: wait at its foot for it)
            if (dd < 2.6 * 2.6 && this.hooks && !rampSeat) this.hooks.tryBoard(s);
          } else {
            this.go(a, ticket.pos.x, ticket.pos.z, true);
            const reach = Math.max(ticket.def.half[0], ticket.def.half[2] * 0.5) + 3.4;
            if ((ticket.pos.x - s.pos.x) ** 2 + (ticket.pos.z - s.pos.z) ** 2 < reach * reach && this.hooks) this.hooks.tryBoard(s);
          }
        }
        a.fireMode = visible && tdist < 50 ? 1 : 0;
        break;
      case Action.INVESTIGATE:
        if (heardSlot >= 0) this.go(a, this.memory.lkpX[heardSlot], this.memory.lkpZ[heardSlot], false);
        a.fireMode = 0;
        break;
      case Action.AMBUSH:
        // AT discipline: track the tank, hold fire until it shows a flank or rear.
        a.weaponPref = 1;
        a.fireMode = 0;
        if (st.coverNode[o] < 0) this.pickCover(o, 12, 0, hasThreat, tcx, tcz, 0, 0);
        if (st.coverNode[o] >= 0) this.go(a, this.cover.x[st.coverNode[o]], this.cover.z[st.coverNode[o]], false); else a.hasGoal = false;
        stance = this.foliage.at(s.pos.x, s.pos.z) > 0.4 ? Stance.PRONE : Stance.CROUCH;
        break;
      case Action.SCREEN: {
        const tank = this.findScreenTank(s);
        if (tank) {
          const k = st.slot[o] % 8, h = tank.yaw, cs = Math.cos(h), sn = Math.sin(h);
          const lx = SCREEN_X[k], lz = SCREEN_Z[k];
          this.go(a, tank.pos.x + cs * lx + sn * lz, tank.pos.z - sn * lx + cs * lz, Math.hypot(tank.pos.x - s.pos.x, tank.pos.z - s.pos.z) > 15);
        }
        a.fireMode = visible ? 1 : 0;
        break;
      }
      case Action.HOLD: {
        // Danger close: step out of the friendly impact zone and wait.
        const dz = this.radio;
        const cx = dz.dangerX[danger], cz = dz.dangerZ[danger], r = dz.dangerR[danger] + 18;
        const dx = s.pos.x - cx, dzz = s.pos.z - cz, d = Math.hypot(dx, dzz) || 1;
        if (d < r) this.go(a, cx + (dx / d) * r, cz + (dzz / d) * r, true); else a.hasGoal = false;
        a.fireMode = visible ? 1 : 0;
        stance = d >= r ? Stance.CROUCH : Stance.STAND;
        break;
      }
      case Action.REGROUP: {
        if (q && time - q.dropT < 12 && !q.dropGathered) {
          // Post-dismount rally: a loose wedge around the rally point, facing the way the squad is going.
          this.formationSlot(o, q.dropX, q.dropZ, q.heading, C2);
          if (st.slot[o] === 0 || g.nav.blocked(C2[0], C2[1])) { C2[0] = q.dropX; C2[1] = q.dropZ; }
          if (!this.arrivedAt(s, C2[0], C2[1], 2)) this.go(a, C2[0], C2[1], true); else a.hasGoal = false;
          a.fireMode = visible ? 1 : 0;
          break;
        }
        const l = q && q.leader >= 0 ? g.soldiers[q.leader] : null;
        if (l) this.formationSlot(o, l.pos.x, l.pos.z, q ? q.heading : 0, C2), this.go(a, C2[0], C2[1], Math.hypot(l.pos.x - s.pos.x, l.pos.z - s.pos.z) > 40);
        a.fireMode = visible ? 1 : 0;
        break;
      }
      case Action.REPAIR: {
        const vid = this.findRepair(s);
        st.repairTarget[o] = vid;
        if (vid >= 0) {
          const v = g.vehicles.list[vid];
          this.go(a, v.pos.x + v.def.half[0] + 1.5, v.pos.z, false);
          if ((v.pos.x - s.pos.x) ** 2 + (v.pos.z - s.pos.z) ** 2 < 49) v.repair(v.def.health * 0.025 * dtT);
        }
        a.fireMode = visible ? 1 : 0;
        stance = Stance.CROUCH;
        break;
      }
      case Action.HEAL: {
        const mid = this.findHeal(s);
        st.healTarget[o] = mid;
        if (mid >= 0) {
          const m = g.soldiers[mid];
          this.go(a, m.pos.x + 0.8, m.pos.z, true);
          if ((m.pos.x - s.pos.x) ** 2 + (m.pos.z - s.pos.z) ** 2 < 9) m.health = Math.min(100, m.health + 12 * dtT);
        }
        a.fireMode = visible ? 1 : 0;
        stance = Stance.CROUCH;
        break;
      }
      case Action.CREW_WAIT: {
        // Stand by the vehicle that needs a crew; otherwise hold near the crew squad's base.
        if (this.hooks && this.hooks.crewPost(s, C2)) {
          if (!this.arrivedAt(s, C2[0], C2[1], 3)) this.go(a, C2[0], C2[1], Math.hypot(C2[0] - s.pos.x, C2[1] - s.pos.z) > 40);
          else a.hasGoal = false;
          a.fireMode = visible ? 1 : 0;
          break;
        }
        const f = obj || this.nearestFriendlyFlag(s);
        if (f && (!a.hasGoal || this.arrivedAt(s, a.goalX, a.goalZ, 2))) {
          const ang = rand(st.rng, o) * Math.PI * 2, r = 8 + rand(st.rng, o) * 14;
          this.go(a, f.x + Math.cos(ang) * r, f.z + Math.sin(ang) * r, false);
        }
        a.fireMode = visible ? 1 : 0;
        break;
      }
      case Action.ADVANCE: {
        const gr = q ? squadGoal(q, GOAL) : -1;
        if (gr >= 0) {
          const ox = GOAL[0], oz = GOAL[1];
          const leader = q && q.leader >= 0 ? g.soldiers[q.leader] : null;
          let gx: number, gz: number;
          // The leader waits a little for stragglers (not under fire, not for ever); stragglers hurry to catch up.
          if (q && leader === s && !visible && this.waitForStragglers(q, s, ox, oz, time)) {
            a.hasGoal = false; a.lookYaw = Math.atan2(q.lagX - s.pos.x, q.lagZ - s.pos.z); a.fireMode = 0;
            break;
          }
          const dL2 = leader ? (leader.pos.x - s.pos.x) ** 2 + (leader.pos.z - s.pos.z) ** 2 : 1e12;
          const lagging = q !== null && leader !== null && leader !== s && leader.alive && !leader.vehicle && dL2 > 30 * 30;
          // The leader sets a pace the squad can hold: no running off while anyone on foot trails by more than 30 m.
          let trail = false;
          if (q && leader === s) for (let i = 0; i < q.count && !trail; i++) { const m = g.soldiers[q.members[i]]; if (m !== s && m.alive && !m.vehicle && (m.pos.x - s.pos.x) ** 2 + (m.pos.z - s.pos.z) ** 2 > 30 * 30) trail = true; }
          // Stragglers catch up with the leader (not off to the goal on their own) unless the leader is very far away;
          // a member already further along than a distant leader (dropped ahead) does not walk back:
          // it waits there for the leader to come up for a while after the drop, then goes on to the goal.
          const ahead = leader !== null && leader !== s && dL2 > 50 * 50 &&
            (ox - s.pos.x) ** 2 + (oz - s.pos.z) ** 2 < ((ox - leader.pos.x) ** 2 + (oz - leader.pos.z) ** 2) * 0.6;
          if (ahead && q && time - q.dropT < 40 && !visible) {
            a.hasGoal = false; a.lookYaw = Math.atan2(ox - s.pos.x, oz - s.pos.z); a.fireMode = 0; this.stats.aheadWaits++;
            break;
          }
          if (!leader || leader === s || !leader.alive || leader.vehicle || dL2 > 220 * 220 || ahead) {
            // Leaders (and stragglers) head for the goal, fanned out around it.
            const k = st.slot[o], ang = k * 2.4, r = Math.min(gr * 0.7, 4 + (k % 4) * 2.2);
            gx = ox + Math.cos(ang) * r; gz = oz + Math.sin(ang) * r;
          } else {
            // Members keep their own corridor off the leader's path instead of a single-file line.
            this.corridorSlot(o, leader.pos.x, leader.pos.z, q ? q.heading : 0, C2);
            gx = C2[0]; gz = C2[1];
          }
          if (this.radio.inDangerZone(s.team, gx, gz, 15, time) >= 0) { a.hasGoal = false; break; }
          const rushing = st.rushing[o] === 1;
          // A rooftop objective (MIKE): within 80 m, the goal is on the roof, reached by the stairs (floors.ts).
          const fl = q ? q.objective as any : null, floors = (g as any).floors;
          const roof = fl && fl.host && fl.host.state < 2 && fl.hostIndex >= 0 && floors && floors.ok(fl.hostIndex, a) &&
            (fl.x - s.pos.x) ** 2 + (fl.z - s.pos.z) ** 2 < 80 * 80 && fl.owner !== s.team;
          if (rushing || roof) {
            // Into the flag circle, spread around it, firing on the move (on a roof: within 3.5 m of the pole).
            const k = st.slot[o], ang = k * 2.4, r = roof ? 1.5 + (k % 3) * 1 : 3 + (k % 4) * 2.5;
            gx = ox + Math.cos(ang) * r; gz = oz + Math.sin(ang) * r;
          }
          this.go(a, gx, gz, lagging || (!rushing && !trail && Math.hypot(ox - s.pos.x, oz - s.pos.z) > 30));
          if (roof) { a.upB = fl.hostIndex; this.stats.roofAssaults++; }
          // Marching fire: shooting at what is in sight while still moving on.
          a.fireMode = rushing ? (visible ? 1 : a.target && time - a.lastSeenTime < 4 ? 2 : 0) : visible && tdist < 230 ? 1 : 0;
          break;
        }
        a.fireMode = 0;
        break;
      }
      default: {
        // At the goal: take the planned fighting position and watch the threat axis.
        if (this.occupy(o, q, a, s)) { a.fireMode = 0; stance = this.occupyStance; break; }
        // PATROL around the objective.
        const f = obj;
        if (f && (!a.hasGoal || this.arrivedAt(s, a.goalX, a.goalZ, 1.5))) {
          // (an objective across the water has no walking route: patrol where we are until a lift comes)
          const nav = g.nav as any, across = nav.sameLandmass && !nav.sameLandmass(s.pos.x, s.pos.z, f.x, f.z);
          const cx = across ? s.pos.x : f.x, cz = across ? s.pos.z : f.z;
          const ang = rand(st.rng, o) * Math.PI * 2, r = 3 + rand(st.rng, o) * 11;
          const x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r;
          if (!g.nav.blocked(x, z)) this.go(a, x, z, false);
        }
        a.fireMode = 0;
      }
    }
    // Prone under heavy suppression when holding still (any action), crouch when firing from range.
    if (!a.hasGoal && st.suppression[o] > 0.8 && act !== Action.ENGAGE) stance = Stance.PRONE;
    s.stance = a.hasGoal && !this.arrivedAt(s, a.goalX, a.goalZ, 1.5) && stance === Stance.PRONE ? Stance.CROUCH : stance;
  }

  // ---------------------------------------------------------------- helpers

  /** The squad's living ammo bearer (SUPPORT class, on foot) other than `s`, if any. */
  private squadBearer(q: SquadBlackboard | null, s: SoldierLike): SoldierLike | null {
    if (!q) return null;
    for (let i = 0; i < q.count; i++) {
      const m = this.game.soldiers[q.members[i]];
      if (m !== s && m.alive && !m.vehicle && m.cls === SoldierClass.SUPPORT) return m;
    }
    return null;
  }

  /** Stance chosen by the last successful occupy(). */
  private occupyStance: number = Stance.CROUCH;

  /**
   * Moves to (or stays at) this soldier's planned fighting position and sets
   * the direction to watch. False when the squad has no position plan.
   */
  private occupy(o: number, q: SquadBlackboard | null, a: AgentLike, s: SoldierLike): boolean {
    if (!q || q.planMode < 0) return false;
    let k = -1;
    for (let i = 0; i < q.count; i++) if (q.members[i] === o) { k = i; break; }
    if (k < 0 || k >= q.plan.count) return false;
    const px = q.plan.x[k], pz = q.plan.z[k];
    // A post upstairs: reached by the stairs (floors.ts); arrived only once actually up there.
    const node = q.plan.node[k], upB = node >= 0 && this.cover.floor[node] ? this.cover.bld[node] : -1;
    const floors = (this.game as any).floors;
    const there = this.arrivedAt(s, px, pz, upB >= 0 ? 0.9 : 1.4) && (upB < 0 || (floors && floors.isUp(upB, s)));
    if (!there && upB >= 0 && floors && !floors.ok(upB, a)) {
      // The stairs to that post did not work out for this soldier (blocked, collapsed): hold where it is.
      a.hasGoal = false; this.occupyStance = Stance.CROUCH;
    } else if (!there) {
      this.go(a, px, pz, upB < 0 && Math.hypot(px - s.pos.x, pz - s.pos.z) > 25); a.upB = upB; this.occupyStance = Stance.STAND;
      if (upB >= 0) this.stats.upperMoves++;
    }
    else {
      a.hasGoal = false; this.occupyStance = q.plan.stance[k];
      // Quiet for a while at the post: now and then stand up to look over the position, then get down again
      // (per soldier, out of step with the others; never while there is anything to shoot at).
      const time = this.game.time, quiet = !(a.target && time - a.lastSeenTime < 20) && this.st.suppression[o] < 0.1;
      if (quiet && this.occupyStance !== Stance.STAND && hash01(o, Math.floor((time + o * 3.7) / 14)) < 0.3) this.occupyStance = Stance.STAND;
    }
    // Something heard nearby: watch that way from the post instead of the planned sector.
    a.lookYaw = Number.isNaN(this.st.heardYaw[o]) ? q.plan.yaw[k] : this.st.heardYaw[o];
    return true;
  }

  /** Index of this soldier's post in its squad's position plan, when the squad holds ground (else -1). */
  private postOf(o: number, q: SquadBlackboard | null): number {
    if (!q || q.planMode < 0 || !(q.order === Order.DEFEND || q.order === Order.HOLD || q.order === Order.SUPPORT)) return -1;
    for (let i = 0; i < q.count && i < q.plan.count; i++) if (q.members[i] === o) return i;
    return -1;
  }

  /** Is (x, z) within the squad's task area (or close to the squad itself)? Squads without orders roam freely. */
  private leash(q: SquadBlackboard | null, x: number, z: number): boolean {
    if (!q || q.order === Order.NONE) return true;
    if ((x - q.cx) ** 2 + (z - q.cz) ** 2 < 45 * 45) return true;
    const r = q.order === Order.ATTACK ? 90 : q.order === Order.MOVE || q.order === Order.AIRLIFT ? 35 : 60;
    return (x - q.destX) ** 2 + (z - q.destZ) ** 2 < r * r;
  }

  private go(a: AgentLike, x: number, z: number, sprint: boolean): void {
    a.goalX = x; a.goalZ = z; a.hasGoal = true; a.sprint = sprint; a.upB = -1;
  }

  private arrivedAt(s: SoldierLike, x: number, z: number, r: number): boolean {
    return (s.pos.x - x) ** 2 + (s.pos.z - z) ** 2 < r * r;
  }

  /** Post-dismount: whether this soldier should still gather at the squad's rally point. */
  private dropGathering(q: SquadBlackboard, s: SoldierLike, time: number): boolean {
    if (s.vehicle) return false;
    const dx = s.pos.x - q.dropX, dz = s.pos.z - q.dropZ;
    // Too far to be part of the drop (left behind at the pick-up): no use walking to the rally point.
    if (dx * dx + dz * dz > 60 * 60) return false;
    // Still beside the vehicle: get clear first.
    const v = q.dropV >= 0 ? this.game.vehicles.list[q.dropV] : null;
    if (v && time - q.dropT < 4 && (v.pos.x - s.pos.x) ** 2 + (v.pos.z - s.pos.z) ** 2 < (v.def.half[2] + 4) ** 2) return true;
    let n = 0, near = 0;
    for (let i = 0; i < q.count; i++) {
      const m = this.game.soldiers[q.members[i]];
      if (!m.alive || m.vehicle) continue;
      const ex = m.pos.x - q.dropX, ez = m.pos.z - q.dropZ, e2 = ex * ex + ez * ez;
      if (e2 > 60 * 60) continue;
      n++; if (e2 < 12 * 12) near++;
    }
    if (n === 0 || near >= Math.ceil(n * 0.7)) { q.dropGathered = true; this.stats.dropRegrouped++; return false; }
    return true;
  }

  /**
   * Squad cohesion on the move: when a third of the squad on foot has fallen more than 45 m behind the leader
   * (and the goal is still some way off), the leader stops and looks back for up to 15 s, then goes on (and does
   * not wait again for 40 s). Writes the stragglers' centroid to q.lagX / q.lagZ.
   */
  private waitForStragglers(q: SquadBlackboard, s: SoldierLike, gx: number, gz: number, time: number): boolean {
    if (time < q.waitCool || (gx - s.pos.x) ** 2 + (gz - s.pos.z) ** 2 < 50 * 50 || q.contactCentroid(time, 6, C2) > 0) { q.waitSince = 0; return false; }
    let lag = 0, n = 0, lx = 0, lz = 0;
    for (let i = 0; i < q.count; i++) {
      const m = this.game.soldiers[q.members[i]];
      if (!m.alive || m.vehicle || m === s) continue;
      n++;
      if ((m.pos.x - s.pos.x) ** 2 + (m.pos.z - s.pos.z) ** 2 > 45 * 45) { lag++; lx += m.pos.x; lz += m.pos.z; }
    }
    if (n === 0 || lag < Math.max(1, Math.ceil(n / 3))) {
      if (q.waitSince > 0) { q.waitSince = 0; q.waitCool = time + 10; }
      return false;
    }
    if (q.waitSince === 0) { q.waitSince = time; this.stats.cohesionWaits++; }
    if (time - q.waitSince > 15) { q.waitSince = 0; q.waitCool = time + 40; return false; }
    q.lagX = lx / lag; q.lagZ = lz / lag;
    return true;
  }

  /**
   * Persistent movement corridor: each soldier keeps its own lateral offset (−12…+12 m, fixed per soldier) and a
   * 2–4 m stagger behind the leader — a loose skirmish line in the open — compressed to a staggered double file
   * (±1.8 m) on roads and streets.
   */
  private corridorSlot(o: number, lx: number, lz: number, heading: number, out: Float32Array): void {
    const k = this.st.slot[o], road = this.game.map.terrain.roadAt(lx, lz) > 0.3;
    const side = k % 2 === 1 ? 1 : -1, rank = Math.ceil(k / 2);
    const lat = road ? side * 1.8 : (hash01(o, 77) * 2 - 1) * 12;
    const back = road ? 3.5 * k : 2 + hash01(o, 78) * 2 + rank * 1.5;
    const cs = Math.cos(heading), sn = Math.sin(heading);
    let x = lx + cs * lat - sn * back, z = lz - sn * lat - cs * back;
    if (this.game.nav.blocked(x, z)) { x = lx + cs * lat * 0.3 - sn * back; z = lz - sn * lat * 0.3 - cs * back; }
    out[0] = x; out[1] = z;
  }

  /**
   * Squad spacing on the move (O(squad size)): goals within 3.5 m of a squadmate are pushed apart, and a goal whose
   * path crosses a firing squadmate's line of fire (within 25 m in front of the muzzle) steps around behind it.
   */
  private spaceGoal(o: number, q: SquadBlackboard, s: SoldierLike, a: AgentLike): void {
    if (!a.hasGoal) return;
    let gx = a.goalX, gz = a.goalZ, moved = false;
    for (let i = 0; i < q.count; i++) {
      const m = this.game.soldiers[q.members[i]];
      if (m === s || !m.alive || m.vehicle) continue;
      const dx = gx - m.pos.x, dz = gz - m.pos.z, d2 = dx * dx + dz * dz;
      if (d2 < 3.5 * 3.5) {
        const d = Math.sqrt(d2) || 1, push = 3.5 - d;
        gx += (dx / d) * push; gz += (dz / d) * push; moved = true;
      }
      const ma = m.ai;
      if (ma && ma.fireMode > 0 && ma.target) {
        // Line of fire: from m toward its target.
        const fx = ma.lastSeenX - m.pos.x, fz = ma.lastSeenZ - m.pos.z, fl = Math.hypot(fx, fz) || 1, ux = fx / fl, uz = fz / fl;
        // Does the segment s → goal pass in front of the muzzle within 25 m and 1.5 m of the line?
        for (let t = 0.25; t <= 1; t += 0.25) {
          const px = s.pos.x + (gx - s.pos.x) * t - m.pos.x, pz = s.pos.z + (gz - s.pos.z) * t - m.pos.z;
          const along = px * ux + pz * uz, lat = px * -uz + pz * ux;
          if (along > 1 && along < Math.min(25, fl) && Math.abs(lat) < 1.5) {
            // Go round behind the shooter instead.
            const back = (s.pos.x - m.pos.x) * ux + (s.pos.z - m.pos.z) * uz;
            if (back > 0) { gx = m.pos.x - ux * 3 + (lat >= 0 ? -uz : uz) * 3; gz = m.pos.z - uz * 3 + (lat >= 0 ? ux : -ux) * 3; }
            else { gx -= -uz * (lat >= 0 ? 1 : -1) * (1.6 - Math.abs(lat)); gz -= ux * (lat >= 0 ? 1 : -1) * (1.6 - Math.abs(lat)); }
            moved = true; this.stats.fireLaneSteps++;
            break;
          }
        }
      }
    }
    if (moved && !this.game.nav.blocked(gx, gz)) { a.goalX = gx; a.goalZ = gz; }
  }

  /** Wedge slot around the leader, facing `heading`. */
  private formationSlot(o: number, lx: number, lz: number, heading: number, out: Float32Array): void {
    const k = this.st.slot[o], rank = Math.ceil(k / 2), side = k % 2 === 1 ? 1 : -1;
    const lat = 4.5 * rank * side, back = 4 * rank;
    const cs = Math.cos(heading), sn = Math.sin(heading);
    out[0] = lx + cs * lat - sn * back; out[1] = lz - sn * lat - cs * back;
  }

  /** Reserves the best cover node in range (protection vs all sightlines, distance, objective pull). */
  private pickCover(o: number, maxDist: number, objWeight: number, hasThreat: boolean, tcx: number, tcz: number, ox: number, oz: number): number {
    const s = this.game.soldiers[o], st = this.st, time = this.game.time;
    const limit = 32;
    let n = this.cover.grid.query(s.pos.x, s.pos.z, maxDist, IDS);
    if (n > limit) n = limit;
    let best = -1, bestScore = -1e9;
    for (let i = 0; i < n; i++) {
      const c = IDS[i];
      if (this.cover.floor[c] || !this.cover.valid(c) || !this.cover.available(c, o, time)) continue;
      const sc = this.cover.score(c, s.pos.x, s.pos.z, this.threats, maxDist, ox, oz, objWeight, tcx, tcz, hasThreat);
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
    this.cover.release(st.coverNode[o], o);
    st.coverNode[o] = best;
    if (best >= 0) this.cover.reserve(best, o, time + 10);
    return best;
  }

  /** Approaches a point from cover to cover. */
  private moveViaCover(o: number, x: number, z: number, step: number, objWeight: number, hasThreat: boolean, tcx: number, tcz: number): void {
    const s = this.game.soldiers[o], a = s.ai as AgentLike, st = this.st;
    const c = st.coverNode[o];
    if (c < 0 || this.arrivedAt(s, this.cover.x[c], this.cover.z[c], 1.5)) this.pickCover(o, step, objWeight, hasThreat, tcx, tcz, x, z);
    const n = st.coverNode[o];
    if (n >= 0) this.go(a, this.cover.x[n], this.cover.z[n], true);
    else this.go(a, x, z, false);
  }

  private maybeSmoke(o: number, hasThreat: boolean, tcx: number, tcz: number): void {
    const s = this.game.soldiers[o], st = this.st, time = this.game.time;
    if (!hasThreat || time < st.smokeReadyAt[o] ) return;
    // Smoke grenades: leaders and engineers carry one per life; one screen per squad every 25 s.
    if (s.cls !== SoldierClass.LEADER && s.cls !== SoldierClass.SUPPORT) return;
    const q = s.squad as SquadBlackboard | null;
    if (q) { if (time < q.nextSmoke) return; q.nextSmoke = time + 25; }
    st.smokeReadyAt[o] = 1e9;
    const dx = tcx - s.pos.x, dz = tcz - s.pos.z, d = Math.hypot(dx, dz) || 1;
    const k = Math.min(10, d * 0.4);
    const x = s.pos.x + (dx / d) * k, z = s.pos.z + (dz / d) * k;
    this.smoke.deploy(x, this.game.map.terrain.height(x, z) + 1, z, 7, 16, time);
  }

  /** Retreat destination: nearby support soldier (medic), supply truck, rally point or friendly flag. */
  private fallback(o: number, out: Float32Array): void {
    const g = this.game, s = g.soldiers[o], q = s.squad as SquadBlackboard | null;
    if (q) {
      for (let i = 0; i < q.count; i++) {
        const m = g.soldiers[q.members[i]];
        if (m === s || !m.alive || m.vehicle || m.cls !== SoldierClass.SUPPORT) continue;
        if ((m.pos.x - s.pos.x) ** 2 + (m.pos.z - s.pos.z) ** 2 < 80 * 80) { out[0] = m.pos.x; out[1] = m.pos.z; return; }
      }
    }
    const truck = this.hooks ? this.hooks.nearestSupply(s.team, s.pos.x, s.pos.z, 150) : null;
    if (truck) { out[0] = truck.pos.x + 4; out[1] = truck.pos.z; return; }
    if (q && q.rallyX !== 0 && (q.rallyX - s.pos.x) ** 2 + (q.rallyZ - s.pos.z) ** 2 > 100) { out[0] = q.rallyX; out[1] = q.rallyZ; return; }
    const f = this.nearestFriendlyFlag(s);
    if (f) { out[0] = f.x; out[1] = f.z; return; }
    const tx = this.st.threatX[o], tz = this.st.threatZ[o], l = Math.hypot(tx, tz) || 1;
    out[0] = s.pos.x - (tx / l) * 25; out[1] = s.pos.z - (tz / l) * 25;
  }

  private nearestFriendlyFlag(s: SoldierLike): { x: number; z: number } | null {
    const flags = this.game.capture.flags;
    let best = null, bd = 1e12;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f.owner !== s.team) continue;
      const d = (f.x - s.pos.x) ** 2 + (f.z - s.pos.z) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  /** Friendly MBT / HT nearby that the squad's objective is taking into close terrain. */
  private findScreenTank(s: SoldierLike): VehicleLike | null {
    const q = s.squad as SquadBlackboard | null;
    if (!q || q.kind !== SquadKind.INFANTRY || !q.objective) return null;
    const n = this.grid.queryRadius(s.pos.x, s.pos.z, 45, IDS, this.S, this.S + this.V);
    for (let i = 0; i < n; i++) {
      const v = this.game.vehicles.list[IDS[i] - this.S];
      if (!v.alive || v.team !== s.team || !v.driver || v.driver.isPlayer) continue;
      const arch = ARCHETYPE_OF[v.def.type];
      if (arch !== Archetype.MBT && arch !== Archetype.HT) continue;
      // Close terrain: the tank is near the (fortified) objective flag.
      if ((v.pos.x - q.objective.x) ** 2 + (v.pos.z - q.objective.z) ** 2 < 90 * 90) return v;
    }
    return null;
  }

  private findRepair(s: SoldierLike): number {
    const n = this.grid.queryRadius(s.pos.x, s.pos.z, 60, IDS, this.S, this.S + this.V);
    let best = -1, worst = 0.7;
    for (let i = 0; i < n; i++) {
      const v = this.game.vehicles.list[IDS[i] - this.S];
      if (!v.alive || (v.occupied && v.team !== s.team) || v.speed > 2 || v.isAircraft && v.altitude > 1) continue;
      const f = v.health / v.def.health;
      if (f < worst) { worst = f; best = v.id; }
    }
    return best;
  }

  private findHeal(s: SoldierLike): number {
    const q = s.squad as SquadBlackboard | null;
    if (!q) return -1;
    let best = -1, low = 60;
    for (let i = 0; i < q.count; i++) {
      const m = this.game.soldiers[q.members[i]];
      if (m === s || !m.alive || m.vehicle || m.health >= low) continue;
      if ((m.pos.x - s.pos.x) ** 2 + (m.pos.z - s.pos.z) ** 2 > 35 * 35) continue;
      low = m.health; best = m.id;
    }
    return best;
  }
}

const SENSOR = new Float32Array(5);
const _acc = { x: 0, y: 0, z: 0 };
