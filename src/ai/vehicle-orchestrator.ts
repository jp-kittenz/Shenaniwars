// @ts-ignore -- plain JS module
import { CrewState, crewBB, crewState, setCrewState } from './vehicle-crew.js';
import { AgentStateBuffers } from './agent-state.ts';
import { PerceptionAndUtilityEngine } from './perception-utility.ts';
import { RadioMessage, TacticalRadioBus } from './radio-bus.ts';
import type { RadioListener } from './radio-bus.ts';
import { SmokeField } from './smoke.ts';
import { GateCandidate, GateContext, GateResult, evaluatePurposeGate } from './purpose-gate.ts';
import { Deliberation, Domain, Q_NAMES } from './deliberation.ts';
import { SpatialGrid } from './spatial-grid.ts';
import { VehiclePark } from './vehicle-park.ts';
import { SquadAndConvoyManager, SquadBlackboard, SquadKind, squadGoal } from './squad-convoy.ts';
import type { ConvoyHooks } from './squad-convoy.ts';
import { CoverField, FoliageField } from './terrain-analysis.ts';
import {
  AI_TUNING, Archetype, ARCHETYPE_OF, Insert, Logistics, MsgState, Order, Posture, RADIO_TYPE_COUNT, RadioType, SeatRole, SoldierClass, TicketState,
  clamp, hash01, rand,
} from './types.ts';
import type { AgentLike, FlagLike, GameLike, SoldierLike, VehicleLike } from './types.ts';

// ---------------------------------------------------------------- data

/** An atomic reservation of one seat by one soldier, with a time-to-live. */
export class SeatTicket {
  id = 0;
  vehicleId = -1;
  seat = -1;
  role: number = SeatRole.PASSENGER;
  soldierId = -1;
  squadId = -1;
  expires = 0;
  state: number = TicketState.FREE;
}

/** Vehicle controller modes. */
/** Base taxiway centreline: its distance from the runway centreline (base.js: runway u −20, taxiway u 7). */
const TAXIWAY_LAT = 27;
/** Combat-jet sortie length (s airborne) and turnaround on the ground (rearm, refuel). */
const SORTIE_S = (globalThis as any).__sortieS || 210, TURNAROUND_S = 40;

export const VMode = {
  PARKED: 0, BOARDING: 1, TRANSIT: 2, DISMOUNT: 3, OVERWATCH: 4, RETURN: 5, HOLD: 6, FIRE: 7, SCOOT: 8,
  LOITER: 9, ATTACK: 10, EGRESS: 11, LAND: 12, UNLOAD: 13, HIDE: 14, POPUP: 15, RESUPPLY: 16, SUPPORT: 17, FLANK: 18,
  ROPE: 19, PARA: 20, SERVICE: 21,
} as const;
export const VMODE_NAMES = ['parked', 'boarding', 'transit', 'dismount', 'overwatch', 'return', 'hold', 'fire', 'scoot',
  'loiter', 'attack', 'egress', 'land', 'unload', 'hide', 'popup', 'resupply', 'support', 'flank', 'fast-rope', 'paradrop', 'repair'] as const;

/** Strategic tasking of a vehicle (implemented by the theater commander). */
export interface VehicleTasking {
  /** Sets man.objective / firing position / phase; false when the vehicle has no strategic task. */
  vehicleOrder(v: VehicleLike, man: VehicleManifest, time: number): boolean;
  /** The vehicle's part in an operation, in words ('' when none). */
  vehicleRole(id: number): string;
  /** Operation the vehicle is assigned to, or -1. */
  vehicleOpId(id: number): number;
}

/** Per-vehicle crew manifest: seat roles, reservations and controller state. */
export class VehicleManifest {
  readonly vehicleId: number;
  readonly archetype: number;
  readonly seatRole: Uint8Array;
  /** Ticket index per seat (-1 free). */
  readonly ticket: Int32Array;
  mode: number = VMode.PARKED;
  /** Why an indirect-fire vehicle is or is not firing (explainability). */
  fireWhy = '';
  fireTurnT = 0;
  /** Assignment record (see trackTask): kind, signature, previous signature, since when, why it changed, free since. */
  taskKind = 0; taskSig = -1; taskPrevSig = -1; taskT = 0; taskPrevT = 0; taskWhy = ''; freeSince = 0;
  /** CAS execution: attack passes flown / with weapons fired, rounds at the last check. */
  casPasses = 0; casFired = 0; casShots = 0;
  modeTime = 0;
  waitUntil = 0;
  /** After a drop the vehicle stands still until then, so the passengers get clear of it. */
  unloadUntil = 0;
  /** Passenger squad being carried / boarding (-1 none). */
  squadId = -1;
  reserved = 0;
  objective: FlagLike | null = null;
  objectiveTime = -100;
  msg: RadioMessage | null = null;
  msgId = 0;
  tx = 0; ty = 0; tz = 0;
  hasPoint = false;
  dismountX = 0; dismountZ = 0;
  hideX = 0; hideZ = 0;
  radarOn = false; radarUntil = 0; radarToggleAt = 0;
  /** Transport aircraft: current job ('' | 'para' | 'airland' | 'supply'), light vehicle in the hold, run-in passed. */
  planeJob = ''; cargoV = -1; runIn = false; runUX = 0; runUZ = 1;
  shotsAtMove = 0;
  missionErr = 25;
  missionShots = 0;
  missions = 0;
  smokeReadyAt = 0;
  flareReadyAt = 0;
  evadeUntil = 0;
  /** Gunship fly-by over a contested objective: when the last one began, until when the current one runs. */
  flybyT = 0; flybyUntil = 0;
  /** Air insertion: when the first passenger boarded; whether this sortie already waved off a hot LZ. */
  boardFirstT = 0; waved = false; lzMarked = false;
  lastHealth = 0;
  damageRate = 0;
  passes = 0;
  nextHullDown = 0;
  idleSince = 0;
  /** Has an anti-aircraft mount (ground air defence besides SAM / SPAAG). */
  aaCapable = false;
  /** Commander tasking: operation phase (-1 none) and firing position. */
  opPhase = -1;
  hasFire = false;
  fireX = 0; fireZ = 0;
  /**
   * Transport task: the passengers' destination taken at departure (kept for
   * the whole trip unless their squad is legitimately re-tasked), progress
   * watchdog, and the reason the last trip ended.
   */
  destX = 0; destZ = 0; destCheck = 0;
  bestD = 1e9; bestAt = 0; transitStart = 0;
  lastTrip = '';
  /**
   * The squad this vehicle transports / supports (-1 none) and the relationship state:
   * 'boarding' | 'riding' | 'escort' | 'standby' | 'pickup' | 'released' | 'lost', reason, since when;
   * standby waiting point; carrying out an extraction (drop at the nearest friendly flag, then complete the ticket).
   */
  supports = -1; supportState = 'none'; supportWhy = ''; supportT = 0; waitX = 0; waitZ = 0; extracting = false;
  /** Riders on a tank's deck: their squad, how long the tank waits for them, time spent stopped while carrying them. */
  riderSquad = -1; riderWaitUntil = 0; riderStill = 0; riderT = 0;
  /** Maintenance: heading for a repair point (supply truck or service station) until patched up. */
  servicing = false; svcX = 0; svcZ = 0; svcAt = -100;
  /** Helicopter insertion: squad, method (Insert.*), drop zone, next jumper timer. */
  insertSquad = -1;
  /** Air assault picking its squad up where it stands (out in the field) instead of at the pad. */
  fieldPickup = false;
  /** A job this crew turned down (Q1–Q5 failed): no new claims until then. */
  declineUntil = 0;
  /** Transport aircraft this (light) vehicle is being driven into, -1 none. */
  loadInto = -1;
  /** Transport aircraft: taxi route to its loading point on the runway, the point, and the light vehicle it takes. */
  loadQ: { x: number; z: number }[] | null = null;
  loadReady = false;
  cargoTried = false;
  insertMethod = 0;
  dropX = 0; dropZ = 0;
  nextDrop = 0;

  constructor(v: VehicleLike) {
    this.vehicleId = v.id;
    this.archetype = ARCHETYPE_OF[v.def.type];
    const n = v.def.seats.length;
    this.seatRole = new Uint8Array(n);
    this.ticket = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const r = v.def.seats[i].role;
      this.seatRole[i] = i === 0 ? (v.def.kind === 'ground' ? SeatRole.DRIVER : SeatRole.PILOT)
        : r === 'gunner' ? SeatRole.GUNNER : r === 'commander' ? SeatRole.COMMANDER : r === 'rider' ? SeatRole.RIDER : SeatRole.PASSENGER;
    }
    this.lastHealth = v.health;
    for (let i = 0; i < v.def.mounts.length; i++) if (v.def.mounts[i].aa) this.aaCapable = true;
  }

  setMode(m: number, time: number): void { if (this.mode !== m) { this.mode = m; this.modeTime = time; } }
}

// ---------------------------------------------------------------- tables

const A = Archetype;
/** Archetypes that carry an infantry squad. */
const CARRIER = new Uint8Array(17);
CARRIER[A.APC] = 1; CARRIER[A.IFV] = 1; CARRIER[A.TRUCK] = 1; CARRIER[A.TRANSPORT_HELI] = 1;
/** Seat roles that carry infantry (inside the compartment or on the deck). */
const CARGO = new Uint8Array(8);
CARGO[SeatRole.PASSENGER] = 1; CARGO[SeatRole.RIDER] = 1;
/** Armour that takes riders on its deck while driving where it is going anyway. */
const RIDE_ON = new Uint8Array(17);
RIDE_ON[A.MBT] = 1; RIDE_ON[A.HT] = 1; RIDE_ON[A.LT] = 1;
/** Stand-off from the objective flag (m) by archetype. */
/** Vehicle assignment kinds (VehicleManifest.taskKind). */
export const TASK_NAMES = ['idle', 'operation', 'carrying squad', 'supporting squad', 'radio request', 'repairs', 'going home', 'own initiative'];

/** Angle wrapped to [-π, π). */
function wrapPi(a: number): number { return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI; }

const STANDOFF = new Float32Array([35, 45, 120, 70, 45, 120, 85, 420, 380, 140, 90, 0, 0, 0, 0, 0, 0]);
/** Crew assignment order by archetype (lower first). */
const CREW_PRIORITY = new Uint8Array([0, 0, 2, 3, 1, 6, 5, 4, 4, 2, 2, 0, 1, 1, 1, 7, 1]);
/** Armour factor in the stay-inside survival estimate. */
const ARMOR_K: Record<string, number> = { heavy: 1.6, light: 1.1, soft: 0.7, heli: 0.8, jet: 0.8 };

// ---------------------------------------------------------------- scratch

const IDS = new Int32Array(128);
const T2 = new Float32Array(2);
const P3V = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; } } as any;
const P2 = new Float32Array(2);
const P3 = new Float32Array(2);
const CAND_X = new Float32Array(12);
/** Known enemy AT positions (scratch, see knownAtThreats). */
const AT_X = new Float32Array(32), AT_Z = new Float32Array(32);
const CAND_Z = new Float32Array(12);
const CAND_S = new Float32Array(12);

/**
 * Crew and vehicle orchestration: reservation tickets (no greedy rushes to a
 * single seat), class-affinity crew assignment, squad-synchronised boarding,
 * safe dismount nodes, survival-scored bailout, countermeasures and one
 * behaviour controller per archetype, all driven by the tactical radio.
 */
export class VehicleOrchestrator implements ConvoyHooks, RadioListener {
  readonly manifests: VehicleManifest[] = [];
  readonly tickets: SeatTicket[] = [];
  private readonly gateCtx = new GateContext();
  private readonly gateOut = new GateResult();
  private readonly delib = new Deliberation(Domain.VEHICLE);
  readonly stats = {
    reserved: 0, boarded: 0, expired: 0, expiredPassenger: 0, expiredTimeout: 0, unreachableSeats: 0, bailouts: 0, dismounts: 0,
    /** Trips: dropped at the planned point / short of it because the way was blocked / passengers lost on the way. */
    trips: 0, delivered: 0, blockedDrops: 0, interrupted: 0, retasked: 0, partialHops: 0, boardFailed: 0, splitAvoided: 0, notches: 0, flybys: 0, flybyShock: 0, waveOffs: 0, fieldPickups: 0, declinedJobs: 0, forwardLandings: 0, shadowMoves: 0, lzMarks: 0, craters: 0, assaultVectors: 0, reboards: 0, planeLifts: 0, planeSupplyRuns: 0, planeAirdrops: 0, planeVehicleDrops: 0, planeCargoLoads: 0, planeLandings: 0, atAwareDrops: 0, holdStable: 0, hullDown: 0, angleFront: 0, smokeExtract: 0,
    /** Tank riders: trips, and why they got off. */
    /** Transport relationships: transitions by state, pickups by the squad's own transport, extractions. */
    rel: {} as Record<string, number>, ownPickups: 0, extractClaims: 0, extractDelivered: 0, fireAborts: 0, fireShifted: 0, fireTurns: 0, fireTurnFails: 0, taskChanges: {} as Record<string, number>, taskThrash: 0, gapToNextTask: 0, nextTasks: 0,
    riderTrips: 0, riderArrived: 0, riderContact: 0, riderDiverted: 0, riderStopped: 0, riderHit: 0, riderAborted: 0,
  };
  agents: (AgentLike | null)[] = [];
  /** Per soldier: a vehicle it failed to reach in time, and until when not to send it there again. */
  private readonly noSeatV: Int32Array;
  private readonly noSeatUntil: Float32Array;
  /** Where carrier trips got stuck (x, z, metres short), newest last; for evaluation. */
  readonly blockedAt: number[] = [];
  /** Vehicles withheld from AI crews (scripted tests, player-reserved). */
  readonly locked: Uint8Array;
  /** Strategic tasking per team (theater commanders). */
  tasking: (VehicleTasking | null)[] = [null, null];
  /** Last enemy aircraft report per team (AIR_THREAT radio). */
  private readonly lastAirThreat = new Float32Array([-1e3, -1e3]);
  /** Vehicle indices in crew-assignment priority order. */
  private readonly crewOrder: Int32Array;
  private readonly freeTickets: Int32Array;
  private freeCount = 0;
  private nextTicketId = 1;
  private assignTimer = 0;
  private airTimer = 0;
  private readonly lzMarks = Array.from({ length: 6 }, () => ({ x: 0, z: 0, until: -1, night: false, next: 0 }));
  private capTimer = 0;
  private vehiclePhase = 0;
  private readonly game: GameLike;
  private readonly st: AgentStateBuffers;
  private readonly radio: TacticalRadioBus;
  private readonly squads: SquadAndConvoyManager;
  private readonly engine: PerceptionAndUtilityEngine;
  private readonly smoke: SmokeField;
  private readonly cover: CoverField;
  private readonly foliage: FoliageField;
  private readonly grid: SpatialGrid;
  private readonly S: number;
  /** Base vehicle parks (slots, lanes) and dynamic vehicle obstacles for route planning. */
  readonly park: VehiclePark;

  constructor(game: GameLike, st: AgentStateBuffers, radio: TacticalRadioBus, squads: SquadAndConvoyManager,
    engine: PerceptionAndUtilityEngine, smoke: SmokeField, cover: CoverField, foliage: FoliageField, grid: SpatialGrid) {
    this.game = game; this.st = st; this.radio = radio; this.squads = squads; this.engine = engine;
    this.smoke = smoke; this.cover = cover; this.foliage = foliage; this.grid = grid;
    this.S = game.soldiers.length;
    this.park = new VehiclePark(game);
    let seats = 0;
    for (const v of game.vehicles.list) { this.manifests.push(new VehicleManifest(v)); seats += v.def.seats.length; }
    this.locked = new Uint8Array(game.vehicles.list.length);
    this.noSeatV = new Int32Array(this.S).fill(-1); this.noSeatUntil = new Float32Array(this.S);
    // Crew priority: armour and air defence first, then fires, carriers, logistics.
    const n = game.vehicles.list.length;
    this.crewOrder = new Int32Array(n);
    for (let i = 0; i < n; i++) this.crewOrder[i] = i;
    for (let i = 1; i < n; i++) {
      const id = this.crewOrder[i], k = CREW_PRIORITY[this.manifests[id].archetype];
      let j = i - 1;
      while (j >= 0 && CREW_PRIORITY[this.manifests[this.crewOrder[j]].archetype] > k) { this.crewOrder[j + 1] = this.crewOrder[j]; j--; }
      this.crewOrder[j + 1] = id;
    }
    const cap = seats + 64;
    this.freeTickets = new Int32Array(cap);
    for (let i = 0; i < cap; i++) { this.tickets.push(new SeatTicket()); this.freeTickets[this.freeCount++] = cap - 1 - i; }
    radio.subscribe(RadioType.AIR_THREAT, this);
  }

  /** Withholds (or releases) a vehicle from AI crews; open reservations on it are cancelled. */
  lock(v: VehicleLike, on: boolean): void {
    this.locked[v.id] = on ? 1 : 0;
    if (!on) return;
    const man = this.manifests[v.id];
    for (let i = 0; i < man.ticket.length; i++) if (man.ticket[i] >= 0) this.releaseTicket(man.ticket[i]);
    if (man.squadId >= 0) { const q = this.squads.squads[man.squadId]; if (q.vehicle === v.id) { q.vehicle = -1; q.posture = Posture.ASSAULT; } }
    man.squadId = -1; man.mode = VMode.PARKED;
  }

  reset(): void {
    for (let i = 0; i < this.tickets.length; i++) if (this.tickets[i].state !== TicketState.FREE) this.releaseTicket(i);
    for (const m of this.manifests) {
      m.mode = VMode.PARKED; m.squadId = -1; m.msg = null; m.objective = null; m.radarOn = false; m.missions = 0;
      m.riderSquad = -1; m.servicing = false; m.svcAt = -100; m.supports = -1; m.supportState = 'none'; m.extracting = false;
    }
  }

  // ================================================================= tickets

  /**
   * Atomically reserves `seat` of `v` for soldier `s`. Fails when the seat is
   * occupied or already reserved, or when the soldier already holds a ticket.
   * @returns ticket index or -1
   */
  reserve(s: SoldierLike, v: VehicleLike, seat: number, squadId: number, time: number): number {
    const man = this.manifests[v.id];
    if (seat < 0 || seat >= v.seats.length || v.seats[seat] || man.ticket[seat] >= 0 || this.st.ticket[s.id] >= 0 || this.freeCount === 0) return -1;
    const idx = this.freeTickets[--this.freeCount];
    const t = this.tickets[idx];
    t.id = this.nextTicketId++; t.vehicleId = v.id; t.seat = seat; t.role = man.seatRole[seat];
    t.soldierId = s.id; t.squadId = squadId; t.state = TicketState.RESERVED;
    const d = Math.hypot(v.pos.x - s.pos.x, v.pos.z - s.pos.z);
    t.expires = time + AI_TUNING.ticketTtlMin + d / 4;
    man.ticket[seat] = idx;
    this.st.ticket[s.id] = idx;
    this.stats.reserved++;
    return idx;
  }

  releaseTicket(idx: number): void {
    const t = this.tickets[idx];
    if (t.state === TicketState.FREE) return;
    const man = this.manifests[t.vehicleId];
    if (man.ticket[t.seat] === idx) man.ticket[t.seat] = -1;
    if (t.soldierId >= 0 && this.st.ticket[t.soldierId] === idx) this.st.ticket[t.soldierId] = -1;
    t.state = TicketState.FREE; t.soldierId = -1;
    this.freeTickets[this.freeCount++] = idx;
  }

  ticketVehicle(soldierId: number): VehicleLike | null {
    const idx = this.st.ticket[soldierId];
    if (idx < 0) return null;
    const t = this.tickets[idx];
    return t.state === TicketState.RESERVED ? this.game.vehicles.list[t.vehicleId] : null;
  }

  /** Called by a ticket holder that reached its vehicle. */
  ticketSeat(s: SoldierLike): number {
    const idx = this.st.ticket[s.id];
    return idx < 0 ? -1 : this.tickets[idx].seat;
  }

  tryBoard(s: SoldierLike): boolean {
    const idx = this.st.ticket[s.id];
    if (idx < 0) return false;
    const t = this.tickets[idx], v = this.game.vehicles.list[t.vehicleId];
    if (!v.alive || (v.isAircraft && v.altitude > 2.5)) { this.releaseTicket(idx); return false; }
    if (Math.abs(v.speed) > 1.5) return false; // nobody climbs into a moving vehicle (the aircraft still taxiing out)
    let seat = t.seat;
    if (v.seats[seat]) {
      // Someone (the player) took it: look for another free seat of the same role.
      seat = -1;
      const man = this.manifests[v.id];
      for (let i = 0; i < v.seats.length; i++) if (!v.seats[i] && man.seatRole[i] === t.role && man.ticket[i] < 0) { seat = i; break; }
    }
    const ok = seat >= 0 && v.enter(s, seat) >= 0;
    this.releaseTicket(idx);
    if (ok) {
      this.stats.boarded++;
      const a = s.ai;
      if (a) {
        a.nav.clear(); a.nav.vehicle = false; a.hasGoal = false; a.stuckTotal = 0;
        // Take over the gun where it points now (no swing round from a default heading).
        const own = v.def.seatMounts[seat];
        a.scanYaw = own && own.length ? v.yaw + v.mountYaw[own[0]] : s.yaw; a.scanVel = 0; a.scanAt = 0;
      }
      if (seat === 0) this.manifests[v.id].idleSince = this.game.time;
    }
    return ok;
  }

  /**
   * Why an intact vehicle has no driver, from the actual crew state (debug overlay, evaluation):
   * 'manned' | 'locked' | 'burning' | 'crew on the way' | 'held for air assault' | 'no free pilot' |
   * 'no free crewman' | 'crew free but not assigned' (the last one would be an assignment bug).
   */
  unusedReason(v: VehicleLike): string {
    if (v.seats[0]) return 'manned';
    const man = this.manifests[v.id];
    if (this.locked[v.id]) return 'locked';
    if (v.health < v.def.health * AI_TUNING.criticalBurn * 1.6) return 'burning';
    if (man.ticket[0] >= 0) return 'crew on the way';
    const team = v.spawn.team, pilot = v.isAircraft;
    let free = 0;
    for (const s of this.game.soldiers) {
      if (!s.alive || s.team !== team || s.vehicle || s.isPlayer) continue;
      if (pilot ? s.cls === SoldierClass.PILOT : s.cls === SoldierClass.CREWMAN) { if (this.st.ticket[s.id] < 0) free++; }
    }
    if (free > 0) return 'crew free but not assigned';
    return pilot ? 'no free pilot' : 'no free crewman';
  }

  /** The holder found no way to its vehicle: release the seat and remember the vehicle as out of reach for a while. */
  abandonTicket(s: SoldierLike): void {
    const idx = this.st.ticket[s.id];
    if (idx < 0) return;
    this.noSeatV[s.id] = this.tickets[idx].vehicleId; this.noSeatUntil[s.id] = this.game.time + 60;
    this.stats.unreachableSeats++;
    this.releaseTicket(idx);
  }

  /** Expires tickets whose holders died or ran out of time. */
  private sweepTickets(time: number): void {
    for (let i = 0; i < this.tickets.length; i++) {
      const t = this.tickets[i];
      if (t.state !== TicketState.RESERVED) continue;
      const s = this.game.soldiers[t.soldierId], v = this.game.vehicles.list[t.vehicleId];
      if (time > t.expires || !s.alive || s.vehicle || !v.alive) {
        if (CARGO[t.role]) this.stats.expiredPassenger++;
        // Could not get there in time: do not send this soldier back to the same vehicle for a while.
        if (time > t.expires && s.alive && !s.vehicle) { this.noSeatV[s.id] = v.id; this.noSeatUntil[s.id] = time + 60; this.stats.expiredTimeout++; }
        this.releaseTicket(i); this.stats.expired++;
      }
    }
  }

  /** A seat taken directly (the player) voids any reservation on it. */
  onEnter(v: VehicleLike, s: SoldierLike, seat: number): void {
    const idx = this.manifests[v.id].ticket[seat];
    if (idx >= 0 && this.tickets[idx].soldierId !== s.id) this.releaseTicket(idx);
  }

  onSoldierDeath(s: SoldierLike): void {
    if (this.st.ticket[s.id] >= 0) this.releaseTicket(this.st.ticket[s.id]);
  }

  onVehicleDestroyed(v: VehicleLike): void {
    const man = this.manifests[v.id];
    for (let i = 0; i < man.ticket.length; i++) if (man.ticket[i] >= 0) this.releaseTicket(man.ticket[i]);
    if (man.msg && this.radio.holds(man.msg, v.id, man.msgId)) this.radio.release(man.msg, `${v.def.label.toLowerCase()} destroyed`);
    if (man.insertSquad >= 0) { const q = this.squads.squads[man.insertSquad]; if (q.vehicle === v.id) q.vehicle = -1; }
    if (man.supports >= 0) {
      const q = this.squads.squads[man.supports];
      if (q.transport === v.id) {
        // Destroyed coming to fetch them or carrying them: no more vehicles are sent into that for a while.
        const enRoute = man.supportState === 'pickup' || man.supportState === 'riding' || man.extracting;
        q.transport = -1; q.transportState = 'lost'; q.transportT = this.game.time;
        q.transportWhy = enRoute ? 'transport destroyed on the way; no vehicle will be sent here for 90 s' : 'transport destroyed';
        if (enRoute) q.noLiftUntil = Math.max(q.noLiftUntil, this.game.time + 90);
      }
      this.stats.rel.lost = (this.stats.rel.lost || 0) + 1;
      man.supports = -1; man.supportState = 'lost'; man.extracting = false;
    }
    if (man.riderSquad >= 0) { const q = this.squads.squads[man.riderSquad]; if (q.vehicle === v.id) { q.vehicle = -1; q.posture = Posture.ASSAULT; } }
    man.msg = null; man.squadId = -1; man.mode = VMode.PARKED; man.insertSquad = -1; man.riderSquad = -1; man.servicing = false;
    v.ropes = false;
  }

  // ================================================================= helicopter insertions

  /** A transport helicopter parked at its pad with a pilot and nothing to do, or -1. */
  idleTransport(team: number): number {
    const list = this.game.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i], man = this.manifests[i];
      if (man.archetype !== A.TRANSPORT_HELI || !v.alive || this.locked[i] || (v.occupied ? v.team : v.spawn.team) !== team) continue;
      const p = v.seats[0];
      if (!p || !p.ai || man.mode !== VMode.PARKED || man.squadId >= 0 || man.insertSquad >= 0 || man.msg) continue;
      if (v.altitude > 2.5 || v.health < v.def.health * 0.5) continue;
      return i;
    }
    return -1;
  }

  /** A transport aircraft parked, crewed and free for a job (-1 none). */
  idlePlane(team: number): number {
    const list = this.game.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i], man = this.manifests[i];
      if (man.archetype !== A.TRANSPORT_PLANE || !v.alive || this.locked[i] || (v.occupied ? v.team : v.spawn.team) !== team) continue;
      const p = v.seats[0];
      if (!p || !p.ai || man.mode !== VMode.PARKED || man.squadId >= 0 || man.insertSquad >= 0 || man.msg || man.planeJob) continue;
      if (v.altitude > 2.5 || v.health < v.def.health * 0.5) continue;
      return i;
    }
    return -1;
  }

  /**
   * How a transport aircraft puts a squad down near (x, z): air-landed on an airstrip we can use within 450 m of
   * it when nobody hostile is around the strip, otherwise by parachute.
   */
  planeMethod(team: number, x: number, z: number): number {
    const rw = this.usableRunway(team, x, z, 450);
    if (rw && this.contactsNear(team, (rw.x0 + rw.x1) / 2, (rw.z0 + rw.z1) / 2, 250, this.game.time) === 0) return Insert.LAND;
    return Insert.PARA;
  }

  /** Nearest runway a side may use: its own, or a neutral airstrip whose nearest flag it holds (null none in range). */
  usableRunway(team: number, x: number, z: number, maxD = 1e9): any {
    const flags = this.game.capture.flags;
    let best = null, bd = maxD * maxD;
    for (const rw of (this.game.map as any).runways) {
      const cx = (rw.x0 + rw.x1) / 2, cz = (rw.z0 + rw.z1) / 2;
      if (rw.team !== team) {
        if (rw.team >= 0) continue;
        let nf = null, nd = 1e12;
        for (const f of flags) { const d = (f.x - cx) ** 2 + (f.z - cz) ** 2; if (d < nd) { nd = d; nf = f; } }
        if (!nf || nf.owner !== team) continue;
      }
      const d = (cx - x) ** 2 + (cz - z) ** 2;
      if (d < bd) { bd = d; best = rw; }
    }
    return best;
  }

  /** Landing set-up for a runway: the direction whose roll-out ends nearest the stand it will taxi to. */
  private landingOn(rw: any, tx: number, tz: number): any {
    const end = (x0: number, z0: number, dx: number, dz: number) => (x0 + dx * 400 - tx) ** 2 + (z0 + dz * 400 - tz) ** 2;
    if (end(rw.x0, rw.z0, rw.dx, rw.dz) <= end(rw.x1, rw.z1, -rw.dx, -rw.dz)) return rw;
    return { ...rw, x0: rw.x1, z0: rw.z1, x1: rw.x0, z1: rw.z0, dx: -rw.dx, dz: -rw.dz, yaw: rw.yaw + Math.PI };
  }

  /** Commander request: board squad `q` on helicopter `heli` and insert it at (x, z) by `method` (Insert.*). */
  requestInsertion(heli: number, q: SquadBlackboard, x: number, z: number, method: number, time: number): boolean {
    const v = this.game.vehicles.list[heli], man = this.manifests[heli], soldiers = this.game.soldiers;
    man.squadId = q.id; man.reserved = 0;
    if (q.leader >= 0) this.reservePassenger(soldiers[q.leader], v, man, q, time);
    for (let i = 0; i < q.count; i++) this.reservePassenger(soldiers[q.members[i]], v, man, q, time);
    if (man.reserved === 0) { man.squadId = -1; return false; }
    man.insertSquad = q.id; man.insertMethod = method; man.dropX = x; man.dropZ = z;
    q.vehicle = heli; q.posture = Posture.MOUNTED;
    q.order = Order.AIRLIFT;
    const far = Math.hypot(q.cx - v.pos.x, q.cz - v.pos.z);
    if (far > 300 && v.isAircraft && man.archetype === A.TRANSPORT_HELI) {
      // Squad out in the field: the helicopter flies to it, lands beside it and picks it up there (the squad waits
      // where it is; its seats are reserved when the helicopter is down).
      for (let i = 0; i < man.ticket.length; i++) if (man.ticket[i] >= 0) this.releaseTicket(man.ticket[i]);
      man.reserved = 1; man.fieldPickup = true;
      man.dismountX = q.cx; man.dismountZ = q.cz; man.lzMarked = false;
      q.destX = q.cx; q.destZ = q.cz; q.destR = 12;
      man.setMode(VMode.EGRESS, time);
      this.stats.fieldPickups++;
      return true;
    }
    man.fieldPickup = false;
    // The squad's goal is the pad until it is airborne, then the drop zone (canopies steer there).
    q.destX = v.pos.x; q.destZ = v.pos.z; q.destR = 10;
    // Boarding window sized to the walk to the pad.
    man.waitUntil = time + 25 + far / 3.5;
    man.setMode(VMode.BOARDING, time);
    return true;
  }

  insertionPending(heli: number, squadId: number): boolean { return heli >= 0 && this.manifests[heli].insertSquad === squadId; }

  /** Operation cancelled before take-off: free the seats and the helicopter (airborne insertions finish on their own). */
  cancelInsertion(heli: number, squadId: number): void {
    if (heli < 0) return;
    const man = this.manifests[heli];
    if (man.insertSquad !== squadId || man.mode !== VMode.BOARDING) return;
    for (let i = 0; i < man.ticket.length; i++) if (man.ticket[i] >= 0) this.releaseTicket(man.ticket[i]);
    const q = this.squads.squads[squadId];
    if (q.vehicle === heli) q.vehicle = -1;
    const v = this.game.vehicles.list[heli];
    if (this.passengersAboard(v, man) > 0) this.dismountPassengers(v);
    man.insertSquad = -1; man.squadId = -1; man.setMode(VMode.PARKED, this.game.time); man.idleSince = this.game.time;
  }

  /** One passenger out of the door: on a fast-rope (rappel) or by parachute (high pass). */
  private dropOne(v: VehicleLike, man: VehicleManifest, rope: boolean): boolean {
    const carried = man.squadId >= 0 ? this.squads.squads[man.squadId] : null;
    for (let i = 1; i < v.seats.length; i++) {
      const o = v.seats[i];
      if (!o || !o.ai || (man.seatRole[i] !== SeatRole.PASSENGER && !(carried && o.squad === carried))) continue;
      const side = (i & 1) ? 1 : -1;
      if (carried) { carried.destX = man.dropX; carried.destZ = man.dropZ; carried.destR = 14; }
      v.exit(o);
      if (rope) {
        // Slide down the rope from the side door, below the hovering airframe.
        const lx = Math.cos(v.yaw), lz = -Math.sin(v.yaw);
        o.parachute = false; o.rappel = true; o.velY = -1;
        o.pos.x = v.pos.x + lx * side * (v.def.half[0] + 0.5); o.pos.z = v.pos.z + lz * side * (v.def.half[0] + 0.5);
        o.pos.y = v.pos.y - 0.8;
      }
      return true;
    }
    return false;
  }

  /** A building under (or just behind) the aircraft, where a vehicle dropped now would come down. */
  private roofBelow(v: VehicleLike): boolean {
    const bx = v.pos.x - Math.sin(v.yaw) * 20, bz = v.pos.z - Math.cos(v.yaw) * 20;
    for (const b of (this.game.map as any).buildings) {
      const r = Math.max(b.w || 0, b.d || 0) / 2 + 10;
      if (Math.abs(b.x - bx) < r && Math.abs(b.z - bz) < r) return true;
    }
    return false;
  }

  private finishInsertion(v: VehicleLike, man: VehicleManifest, time: number): void {
    const q = man.insertSquad >= 0 ? this.squads.squads[man.insertSquad] : null;
    if (q) {
      q.vehicle = -1; q.posture = Posture.ASSAULT; q.objectiveTime = time;
      // Post-touchdown assault vector: straight at the objective's capture ring (no attack waypoint, no regroup
      // walk), and the capture decision (final assault / suppress-and-bound / pinned) is taken at once.
      const f = q.objective;
      if (f && f.owner !== q.team) {
        q.order = Order.ATTACK; q.axisDone = true; q.destX = f.x; q.destZ = f.z; q.destR = 12; q.planTime = -100;
        q.capFlag = f.id; q.capBestD = Math.hypot(f.x - q.cx, f.z - q.cz); q.capBestT = time - 16;
        this.stats.assaultVectors++;
      }
    }
    man.insertSquad = -1; man.squadId = -1;
    v.ropes = false;
    for (let i = 0; i < man.ticket.length; i++) if (man.ticket[i] >= 0 && CARGO[man.seatRole[i]]) this.releaseTicket(man.ticket[i]);
    man.setMode(VMode.RETURN, time);
  }

  // ================================================================= crew assignment

  /** Seat-role affinity of a soldier class (0 = never). */
  private affinity(cls: number, role: number, arch: number): number {
    // Emplacements are manned by the infantry holding the position, never by vehicle crews or pilots.
    if (arch === A.TURRET) return cls === SoldierClass.RIFLEMAN ? 0.8 : cls === SoldierClass.SUPPORT ? 0.6 : cls === SoldierClass.AT ? 0.35 : cls === SoldierClass.SPOTTER ? 0.3 : 0;
    if (role === SeatRole.PILOT) return cls === SoldierClass.PILOT ? 1 : 0;
    if (role === SeatRole.DRIVER) {
      if (cls === SoldierClass.CREWMAN) return 1;
      if (cls === SoldierClass.SUPPORT) return 0.55;
      if (arch === A.TRUCK) return cls === SoldierClass.RIFLEMAN ? 0.5 : cls === SoldierClass.AT ? 0 : 0.25;
      return cls === SoldierClass.RIFLEMAN ? 0.3 : 0;
    }
    if (role === SeatRole.GUNNER || role === SeatRole.COMMANDER) {
      const air = arch === A.ATTACK_HELI || arch === A.TRANSPORT_HELI;
      if (cls === SoldierClass.CREWMAN) return air ? 0.7 : 0.9;
      if (cls === SoldierClass.PILOT) return air && arch === A.ATTACK_HELI ? 0.8 : 0.1;
      if (cls === SoldierClass.AT) return 0.75; // heavy weapons on exposed mounts
      if (cls === SoldierClass.RIFLEMAN) return 0.45;
      if (cls === SoldierClass.SUPPORT) return 0.35;
      return 0.15;
    }
    return 0;
  }

  /** Which seats an archetype wants crewed (driver always; gunners for weapons platforms). */
  private wantsSeat(v: VehicleLike, seat: number, man: VehicleManifest): boolean {
    const role = man.seatRole[seat];
    if (role === SeatRole.DRIVER || role === SeatRole.PILOT) return true;
    if (role === SeatRole.PASSENGER) return false;
    const arch = man.archetype;
    if (role === SeatRole.COMMANDER) return arch === A.MBT || arch === A.HT;
    return v.def.seatMounts[seat].length > 0;
  }

  /** Fills driver / pilot / gunner seats with the best-suited free soldiers (1 Hz). */
  /**
   * Fills seats by class affinity (1 Hz): pass 0 drivers / pilots, pass 1
   * gunners and commanders, vehicles in crew-priority order (armour and air
   * defence before logistics). Candidates are the side's crewmen and pilots
   * (crew squads, any distance) plus the fire team boarding that carrier.
   */
  private assignCrews(time: number): void {
    const list = this.game.vehicles.list, order = this.crewOrder;
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < order.length; k++) {
        const vi = order[k], v = list[vi], man = this.manifests[vi];
        // Burning hulls are not re-crewed (no bail / re-board loops) until a supply truck patches them up.
        if (!v.alive || this.locked[vi] || (v.isAircraft && v.altitude > 2.5) || v.health < v.def.health * AI_TUNING.criticalBurn * 1.6) continue;
        const playerDriver = !!v.seats[0] && v.seats[0].isPlayer;
        const driverSet = !!v.seats[0] || man.ticket[0] >= 0;
        if (pass === 0) { if (!driverSet) this.fillSeat(v, man, 0, time); continue; }
        if (!driverSet) continue;
        for (let seat = 1; seat < v.seats.length; seat++) {
          if (v.seats[seat] || man.ticket[seat] >= 0 || !this.wantsSeat(v, seat, man)) continue;
          // A human driver keeps the main gun: no bot takes the seat it falls back from.
          if (playerDriver && v.def.fallbackFrom[0] === seat) continue;
          this.fillSeat(v, man, seat, time);
        }
      }
    }
  }

  /**
   * Side that may man an emplacement: its owner for base guns; for outpost
   * guns, whoever holds the objective it stands at (-1: nobody yet).
   */
  turretTeam(v: VehicleLike): number {
    if (v.occupied) return v.team;
    if (v.spawn.team >= 0) return v.spawn.team;
    const flags = this.game.capture.flags;
    let best = -1, bd = 120 * 120;
    for (const f of flags) { const d = (f.x - v.pos.x) ** 2 + (f.z - v.pos.z) ** 2; if (!f.base && d < bd) { bd = d; best = f.owner; } }
    return best;
  }

  private fillSeat(v: VehicleLike, man: VehicleManifest, seat: number, time: number): void {
    const turret = man.archetype === A.TURRET;
    const team = turret ? this.turretTeam(v) : v.occupied ? v.team : v.spawn.team, role = man.seatRole[seat];
    if (team < 0) return;
    const squads = this.squads.squads, soldiers = this.game.soldiers;
    let best: SoldierLike | null = null, bestScore = 0.02;
    for (let qi = 0; qi < squads.length; qi++) {
      const q = squads[qi];
      if (q.team !== team) continue;
      if (turret) {
        // Only a squad holding this position mans its gun (one member; the rest keep defending).
        if (q.kind !== SquadKind.INFANTRY || (q.order !== Order.DEFEND && q.order !== Order.HOLD && q.garrison < 0) || q.vehicle >= 0) continue;
        if ((q.destX - v.pos.x) ** 2 + (q.destZ - v.pos.z) ** 2 > 70 * 70) continue;
      } else if (q.kind === SquadKind.INFANTRY && man.squadId !== q.id) continue; // fire teams only crew the carrier they board; crews mount anything
      for (let i = 0; i < q.count; i++) {
        const s = soldiers[q.members[i]];
        if (!s.alive || s.isPlayer || !s.ai || s.vehicle || this.st.ticket[s.id] >= 0) continue;
        if (this.noSeatV[s.id] === v.id && time < this.noSeatUntil[s.id]) continue;
        const aff = this.affinity(s.cls, role, man.archetype);
        if (aff <= 0) continue;
        const d = Math.hypot(s.pos.x - v.pos.x, s.pos.z - v.pos.z);
        if (d > (turret ? 45 : q.kind === SquadKind.INFANTRY ? 60 : 900)) continue;
        if (turret && s.id === q.leader) continue;
        const score = aff * (1 - d / 1000);
        if (score > bestScore) { bestScore = score; best = s; }
      }
    }
    if (best) this.reserve(best, v, seat, -1, time);
  }

  /**
   * Waiting post for an unassigned crewman / pilot: beside the highest-priority
   * vehicle of its side that still lacks a driver (null when none).
   */
  crewPost(s: SoldierLike, out: Float32Array): boolean {
    const list = this.game.vehicles.list, order = this.crewOrder, pilot = s.cls === SoldierClass.PILOT;
    let bestD = 1e12, found = false;
    for (let k = 0; k < order.length; k++) {
      const v = list[order[k]], man = this.manifests[order[k]];
      if (!v.alive || this.locked[v.id] || v.seats[0] || man.ticket[0] >= 0 || v.isAircraft !== pilot || man.archetype === A.TURRET) continue;
      if (v.health < v.def.health * AI_TUNING.criticalBurn * 1.6) continue;
      if ((v.occupied ? v.team : v.spawn.team) !== s.team) continue;
      const d = (v.pos.x - s.pos.x) ** 2 + (v.pos.z - s.pos.z) ** 2;
      if (d < bestD) { bestD = d; out[0] = v.pos.x + v.def.half[0] + 4; out[1] = v.pos.z; found = true; }
    }
    return found;
  }

  /**
   * Squad-synchronised boarding: a squad whose objective is far claims the
   * nearest carrier with room; passenger tickets are reserved for its members
   * first and the driver waits for them (T_wait or 75 % aboard).
   */
  private squadSyncBoarding(time: number): void {
    const list = this.game.vehicles.list, soldiers = this.game.soldiers;
    for (let qi = 0; qi < this.squads.squads.length; qi++) {
      const q = this.squads.squads[qi];
      if (q.kind !== SquadKind.INFANTRY || q.vehicle >= 0 || q.dismounted < 2 || q.order === Order.AIRLIFT) continue;
      // Purpose gate (REBOARD_TRANSPORT): mount up again only when the next objective is far, the squad is not
      // pinned, an intact carrier with room is within 120 m and the ride actually gets it there.
      if (squadGoal(q, P2) < 0) continue;
      const G = this.gateCtx;
      G.nextDist = Math.hypot(P2[0] - q.cx, P2[1] - q.cz);
      G.pinned = q.contactCentroid(time, 10, P3) > 0 || (q.order === Order.ATTACK && q.axisDone) ||
        q.posture === Posture.BOUND || q.posture === Posture.FLANK || q.posture === Posture.HOLD;
      G.footFavoured = !(this.game.nav as any).sameLandmass(q.cx, q.cz, P2[0], P2[1]);
      G.carrierOk = true; G.carrierDist = 0;
      if (!evaluatePurposeGate(G, GateCandidate.REBOARD_TRANSPORT, this.gateOut).ok) continue;
      let best: VehicleLike | null = null, bd = 120 * 120;
      for (let vi = 0; vi < list.length; vi++) {
        const v = list[vi], man = this.manifests[vi];
        // Its own transport waiting nearby (standby / escort / overwatch) takes it back aboard.
        const own = q.transport === vi && man.supports === q.id;
        // Transport helicopters are the theater commander's: air assaults (land / fast-rope / parachute), not taxi rides.
        if (man.archetype === A.TRANSPORT_HELI && this.tasking[q.team]) continue;
        // Not the carrier it just failed to board; and no lift at all toward an objective where transport failed before.
        if ((vi === q.noRideV && time < q.noRideUntil) || time < q.noLiftUntil) continue;
        if (!v.alive || this.locked[vi] || v.health < v.def.health * 0.4 || !CARRIER[man.archetype] || man.squadId >= 0 || (v.occupied ? v.team : v.spawn.team) !== q.team) continue;
        if (!(v.seats[0] || man.ticket[0] >= 0) || (v.seats[0] && v.seats[0].isPlayer)) continue;
        const idleMode = man.mode === VMode.PARKED || man.mode === VMode.BOARDING || man.mode === VMode.RETURN ||
          ((man.mode === VMode.OVERWATCH || man.mode === VMode.HOLD || man.mode === VMode.SUPPORT) && man.opPhase < 0 && (own || man.supports < 0));
        if (!idleMode) continue;
        if (v.isAircraft && v.altitude > 2.5) continue;
        // Room for the whole squad (one may be left to walk): a carrier that takes only part of a squad splits it
        // in two, and the riders then end up walking back to the ones left behind.
        if (this.freePassengerSeats(v, man) < Math.max(Math.min(2, q.dismounted), q.dismounted - 1)) continue;
        const d = (v.pos.x - q.cx) ** 2 + (v.pos.z - q.cz) ** 2;
        if (d < bd) { bd = d; best = v; }
      }
      if (!best) continue;
      this.stats.reboards += q.transportState === 'standby' || q.transportState === 'escort' || q.transportState === 'released' ? 1 : 0;
      const man = this.manifests[best.id];
      man.squadId = q.id; man.reserved = 0;
      // Leader claims first, then squadmates.
      this.reservePassenger(soldiers[q.leader], best, man, q, time);
      for (let i = 0; i < q.count; i++) this.reservePassenger(soldiers[q.members[i]], best, man, q, time);
      if (man.reserved === 0) { man.squadId = -1; continue; }
      q.vehicle = best.id;
      q.posture = Posture.MOUNTED;
      // Long enough for the furthest member to walk over (a fixed 15 s was shorter than the walk from 90 m, so
      // carriers left part-loaded), bounded at 45 s.
      man.waitUntil = time + this.boardingWait(best, man);
      man.setMode(VMode.BOARDING, time);
      this.relate(best, man, q, 'boarding', 'squad has a long way to go');
    }
  }

  private reservePassenger(s: SoldierLike | undefined, v: VehicleLike, man: VehicleManifest, q: SquadBlackboard, time: number): void {
    if (!s || !s.alive || s.isPlayer || !s.ai || s.vehicle || this.st.ticket[s.id] >= 0) return;
    if (s.cls === SoldierClass.CREWMAN || s.cls === SoldierClass.PILOT) return;
    // The squad's AT gunner mans a free weapon station (heavy weapons affinity); everyone else rides in the back.
    if (s.cls === SoldierClass.AT) {
      for (let i = 1; i < v.seats.length; i++) {
        if (man.seatRole[i] !== SeatRole.GUNNER || v.seats[i] || man.ticket[i] >= 0 || !v.def.seatMounts[i].length) continue;
        if (v.seats[0] && v.seats[0].isPlayer && v.def.fallbackFrom[0] === i) continue;
        if (this.reserve(s, v, i, q.id, time) >= 0) { man.reserved++; return; }
      }
    }
    // Inside first; when the compartment is full, the rest ride on the deck.
    for (let pass = 0; pass < 2; pass++) {
      const role = pass === 0 ? SeatRole.PASSENGER : SeatRole.RIDER;
      for (let i = 0; i < v.seats.length; i++) {
        if (man.seatRole[i] !== role || v.seats[i] || man.ticket[i] >= 0) continue;
        if (this.reserve(s, v, i, q.id, time) >= 0) man.reserved++;
        return;
      }
    }
  }

  /** Free cargo positions: interior passenger seats plus exterior rider positions. */
  private freePassengerSeats(v: VehicleLike, man: VehicleManifest): number {
    let n = 0;
    for (let i = 0; i < v.seats.length; i++) if (CARGO[man.seatRole[i]] && !v.seats[i] && man.ticket[i] < 0) n++;
    return n;
  }

  /** Boarding wait for the soldiers holding cargo tickets on v: the furthest one's walk, 15–45 s. */
  private boardingWait(v: VehicleLike, man: VehicleManifest): number {
    let far = 0;
    for (let i = 0; i < man.ticket.length; i++) {
      const k = man.ticket[i];
      if (k < 0) continue;
      const s = this.game.soldiers[this.tickets[k].soldierId];
      if (s && s.alive) far = Math.max(far, Math.hypot(s.pos.x - v.pos.x, s.pos.z - v.pos.z));
    }
    return Math.min(45, Math.max(AI_TUNING.transportWait, far / 3 + 6));
  }

  /**
   * Members of the carried squad still on their way to the vehicle: on foot and either holding a seat on it
   * (within r metres) or already beside it (within 40 m).
   */
  private missingNear(v: VehicleLike, man: VehicleManifest, r: number): number {
    if (man.squadId < 0) return 0;
    const q = this.squads.squads[man.squadId];
    let n = 0;
    for (let i = 0; i < q.count; i++) {
      const s = this.game.soldiers[q.members[i]];
      if (!s.alive || s.vehicle || s.isPlayer) continue;
      const d2 = (s.pos.x - v.pos.x) ** 2 + (s.pos.z - v.pos.z) ** 2, k = this.st.ticket[s.id];
      if (d2 < 40 * 40 || (d2 < r * r && k >= 0 && this.tickets[k].vehicleId === v.id)) n++;
    }
    return n;
  }

  /** Whether every soldier still walking to a reserved cargo seat is more than r metres from the vehicle. */
  private pendingFar(v: VehicleLike, man: VehicleManifest, r: number): boolean {
    for (let i = 0; i < man.ticket.length; i++) {
      const k = man.ticket[i];
      if (k < 0 || !CARGO[man.seatRole[i]]) continue;
      const s = this.game.soldiers[this.tickets[k].soldierId];
      if (s && s.alive && (s.pos.x - v.pos.x) ** 2 + (s.pos.z - v.pos.z) ** 2 < r * r) return false;
    }
    return true;
  }

  private passengersAboard(v: VehicleLike, man: VehicleManifest): number {
    let n = 0;
    for (let i = 0; i < v.seats.length; i++) if (CARGO[man.seatRole[i]] && v.seats[i]) n++;
    return n;
  }

  /** Members of the carried squad sitting in gunner seats (they ride along and dismount with it). */
  private carriedGunners(v: VehicleLike, man: VehicleManifest): number {
    if (man.squadId < 0) return 0;
    const q = this.squads.squads[man.squadId];
    let n = 0;
    for (let i = 1; i < v.seats.length; i++) if (man.seatRole[i] !== SeatRole.PASSENGER && v.seats[i] && v.seats[i]!.squad === q) n++;
    return n;
  }

  private pendingPassengerTickets(man: VehicleManifest): number {
    let n = 0;
    for (let i = 0; i < man.ticket.length; i++) if (man.ticket[i] >= 0 && CARGO[man.seatRole[i]]) n++;
    return n;
  }

  // ================================================================= frame update

  update(dt: number): void {
    const time = this.game.time, list = this.game.vehicles.list;
    this.sweepTickets(time);
    this.park.update(dt, (id) => this.manifests[id].mode === VMode.RETURN);
    // Who can answer which request on each side right now (crewed providers); requests nobody can answer are turned down.
    if ((this.capTimer -= dt) <= 0) {
      this.capTimer = 1;
      const cap = this.radio.capacity;
      cap.fill(0);
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (!v.alive || !v.seats[0]) continue;
        const a = this.manifests[i].archetype, k = v.team * RADIO_TYPE_COUNT;
        if (a === A.MLRS || a === A.HOWITZER) cap[k + RadioType.FIRE_MISSION]++;
        if (a === A.ATTACK_HELI || a === A.STRIKE_JET) cap[k + RadioType.CAS_REQUEST]++;
        if (a === A.SUPPLY || a === A.TRANSPORT_PLANE) cap[k + RadioType.LOGISTICS_REQUEST]++;
        if (CARRIER[a]) cap[k + RadioType.EXTRACT_REQUEST]++;
      }
      this.radio.capacityKnown = true;
    }
    this.assignTimer -= dt;
    if (this.assignTimer <= 0) { this.assignTimer = 1; this.assignCrews(time); this.squadSyncBoarding(time); this.riderBoarding(time); }
    // Air: radar-lock warnings and low fly-by shock, four times a second.
    this.airTimer -= dt;
    if (this.airTimer <= 0) { this.airTimer = 0.25; this.scanLocks(time); this.flybyShock(); }
    this.emitLzMarks(time);
    // Controllers: 4 Hz per vehicle, staggered by id.
    const n = list.length;
    const perFrame = Math.max(1, Math.ceil(n * AI_TUNING.vehicleHz * dt));
    for (let k = 0; k < perFrame; k++) {
      this.vehiclePhase = (this.vehiclePhase + 1) % n;
      this.tickVehicle(list[this.vehiclePhase], time);
    }
  }

  /**
   * Claims the best open request of a type and runs the crew's own Q1–Q5 on it before taking it on: why (a live
   * request from our side), necessary (the requesting squad still needs it), benefit against risk (how hot the
   * spot is for this kind of vehicle), outcome (something there to help or hit) and resources (health, ammunition,
   * seats). A job that fails is handed back for someone better placed (Q6: the crew keeps what it was doing, and
   * does not claim again for a few seconds).
   */
  private take(v: VehicleLike, man: VehicleManifest, type: number, range: number, time: number, minR = 0): RadioMessage | null {
    if (time < man.declineUntil) return null;
    const m = this.radio.claim(type as any, v.team, v.id, v.pos.x, v.pos.z, range, time, minR);
    if (!m) return null;
    const hp = v.health / v.def.health;
    const D = this.delib.begin(v.id, time, hash01(v.id, 13), clamp(1 - hp, 0, 1));
    D.propose(type, 1); D.next();
    const hot = this.contactsNear(v.team, m.x, m.z, 90, time);
    const q = m.senderSquad >= 0 ? this.squads.squads[m.senderSquad] : null;
    let ammo = 0;
    for (const w of v.weapons) if (w && (w.ammo > 0 || w.reserve > 0)) { ammo = 1; break; }
    let r: number;
    if (type === RadioType.EXTRACT_REQUEST) {
      const air = v.isAircraft;
      // A landing zone already overrun is no pick-up: a helicopter (or truck) lost there helps nobody.
      r = D.check(true, !q || (q.alive > 0 && q.dismounted > 0), hot < (air ? 4 : 3) ? 1 : 0.2, !q || q.alive > 0,
        hp > (air ? 0.45 : 0.35) && this.freePassengerSeats(v, man) > 0);
    } else if (type === RadioType.FIRE_MISSION) {
      r = D.check(true, true, true, true, ammo);
    } else if (type === RadioType.CAS_REQUEST) {
      r = D.check(true, true, hp > 0.35 ? 1 : 0.2, true, ammo && hp > 0.3);
    } else {
      r = D.check(true, !q || q.alive > 0, hot < 5 ? 1 : 0.3, true, hp > 0.3);
    }
    if (r) {
      D.none();
      this.radio.release(m, `declined by ${v.def.label} (${Q_NAMES[r]})`);
      man.declineUntil = time + 8;
      this.stats.declinedJobs++;
      return null;
    }
    D.choose(type);
    return m;
  }

  /**
   * Q5 for a squad's support request: how much of a support kind the side has ready, 0..1 (0 artillery, 1 close air
   * support, 2 airlift, 3 ground transport). Crewed providers count fully; intact ones still waiting for a crew
   * count partly (a crew is assigned within seconds when a job comes up).
   */
  supportOn(team: number, kind: number): number {
    const list = this.game.vehicles.list;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.alive || v.team !== team && v.occupied) continue;
      const a = this.manifests[i].archetype;
      const fits = kind === 0 ? a === A.MLRS || a === A.HOWITZER
        : kind === 1 ? a === A.ATTACK_HELI || a === A.STRIKE_JET
        : kind === 2 ? a === A.TRANSPORT_HELI
        : CARRIER[a] === 1 && a !== A.TRANSPORT_HELI && !v.isAircraft;
      if (!fits) continue;
      if (v.seats[0] && v.team === team) n += 1;
      else if (!v.occupied && (v as any).spawn && (v as any).spawn.team === team) n += 0.6;
    }
    return Math.min(1, n);
  }

  private tickVehicle(v: VehicleLike, time: number): void {
    const man = this.manifests[v.id];
    // Damage monitor: rate of incoming damage and "mobility hits".
    const lost = man.lastHealth - v.health;
    man.damageRate = man.damageRate * 0.8 + Math.max(0, lost) * 0.8;
    const bigHit = lost > v.def.health * 0.08;
    man.lastHealth = v.health;
    if (!v.alive) return;
    const d = v.driver;
    const a = d && d.ai ? d.ai : null;
    if (bigHit && v.occupied) { if (v.isAircraft) this.flares(v, time); else this.popSmoke(v); }
    if (v.occupied && v.driver !== null && v.driver.ai !== null && this.shouldBail(v, man, time)) { this.bailCrew(v); return; }
    if (!a) return;
    if (man.archetype === A.TURRET) { this.ctlTurret(v, a, time); return; }
    if (man.loadInto >= 0) { this.ctlDriveAboard(v, man, a, time); return; }
    a.speedCap = v.def.maxSpeed; a.faceYaw = NaN; a.holdVehicle = false; a.pursuit = false; a.arriveR = 6;
    a.heliTransit = false; a.heliAlt = 42;
    man.hasFire = false; man.opPhase = -1;
    // Crews watch toward their objective (turret sector scans centre there when no target).
    if (man.objective) {
      const yaw = Math.atan2(man.objective.x - v.pos.x, man.objective.z - v.pos.z);
      for (let i = 0; i < v.seats.length; i++) { const o = v.seats[i]; if (o && o.ai) o.ai.lookYaw = yaw; }
    }
    // Maintenance before duties: a badly damaged ground vehicle with nobody to deliver goes to be repaired.
    if (v.def.kind === 'ground' && this.needsService(v, man, time)) { this.ctlService(v, man, a, time); this.squads.applySlot(v, a); this.trackTask(v, man, time); return; }
    const tk = this.tasking[v.team];
    if (!(tk && tk.vehicleOrder(v, man, time))) this.updateObjective(v, man, time);
    switch (man.archetype) {
      case A.MBT: this.ctlMBT(v, man, a, time, false); break;
      case A.HT: this.ctlMBT(v, man, a, time, true); break;
      case A.LT: this.ctlLT(v, man, a, time); break;
      case A.APC: case A.IFV: case A.TRUCK:
        // Just unloaded: stand still a moment so the squad gets clear of the hull before it moves off.
        if (time < man.unloadUntil && !v.isAircraft) { a.holdVehicle = true; a.speedCap = 0; break; }
        this.ctlCarrier(v, man, a, time); break;
      case A.SUPPLY: this.ctlSupply(v, man, a, time); break;
      case A.MLRS: case A.HOWITZER: this.ctlArtillery(v, man, a, time); break;
      case A.SAM: this.ctlSAM(v, man, a, time); break;
      case A.SPAAG: this.ctlSPAAG(v, man, a, time); break;
      case A.ATTACK_HELI: this.ctlAttackHeli(v, man, a, time); break;
      case A.TRANSPORT_HELI: this.ctlTransportHeli(v, man, a, time); break;
      case A.TRANSPORT_PLANE: this.ctlTransportPlane(v, man, a, time); break;
      case A.STRIKE_JET: this.ctlStrikeJet(v, man, a, time); break;
      case A.FIGHTER: this.ctlFighter(v, man, a, time); break;
    }
    if (man.riderSquad >= 0) this.tickRiders(v, man, a, time);
    if (v.def.kind === 'ground' && !(v.def as any).static) this.crewCoordination(v, man, a, time, bigHit);
    if (v.def.kind === 'ground') this.squads.applySlot(v, a);
    this.trackTask(v, man, time);
  }

  /**
   * Crew blackboard, commander's part (see vehicle-crew.js): smoke and extract after a heavy AT hit, and the
   * frontal armour angled at the worst AT / armour threat whenever the vehicle holds in contact.
   */
  private crewCoordination(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number, bigHit: boolean): void {
    const bb = crewBB(v);
    const w = this.crewThreat(v, P2);
    const armoured = (v.def as any).armor === 'heavy' || (v.def as any).armor === 'medium';
    if (bigHit && w >= 2.5 && v.health < v.def.health * 0.6 && crewState(v, time) !== CrewState.SMOKE_AND_EXTRACT) {
      // Out of the killzone: 45 m straight away from the shooter (or back the way it came), smoke already popped.
      let dx = v.pos.x - P2[0], dz = v.pos.z - P2[1];
      const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
      let ex = v.pos.x + dx * 45, ez = v.pos.z + dz * 45;
      if (this.game.nav.blocked(ex, ez, true)) { ex = v.pos.x - Math.sin(v.yaw) * 35; ez = v.pos.z - Math.cos(v.yaw) * 35; }
      bb.extractX = ex; bb.extractZ = ez; bb.threatX = P2[0]; bb.threatZ = P2[1];
      setCrewState(bb, CrewState.SMOKE_AND_EXTRACT, time, 9);
      this.popSmoke(v); this.stats.smokeExtract++;
    }
    if (crewState(v, time) === CrewState.SMOKE_AND_EXTRACT) {
      a.holdVehicle = false; a.pursuit = false; a.speedCap = v.def.maxSpeed; this.drive(a, bb.extractX, bb.extractZ);
      if (Math.hypot(bb.extractX - v.pos.x, bb.extractZ - v.pos.z) < 8) bb.state = CrewState.NONE;
      return;
    }
    if (armoured && a.holdVehicle && w >= 2.5) {
      // Frontal armour at the worst AT / armour threat (the tank controllers may already have set this).
      a.faceYaw = Math.atan2(P2[0] - v.pos.x, P2[1] - v.pos.z);
      if (crewState(v, time) === CrewState.NONE) { setCrewState(bb, CrewState.ANGLE_FRONT, time, 3); this.stats.angleFront++; }
    }
  }

  /**
   * Assignment record: what the vehicle is doing (operation role, carrying a squad, supporting a squad, a radio
   * request, repairs, going home, its own initiative, nothing), where, since when and why it last changed.
   * Changes that come straight back within 30 s are counted as thrash; the time from finishing a task to the
   * next task is measured.
   */
  private trackTask(v: VehicleLike, man: VehicleManifest, time: number): void {
    const tk = this.tasking[v.team];
    const kind = man.servicing ? 5 : man.opPhase >= 0 && man.opPhase < 5 && tk && tk.vehicleRole(v.id) ? 1
      : man.squadId >= 0 ? 2 : man.supports >= 0 ? 3 : man.msg && this.radio.holds(man.msg, v.id, man.msgId) ? 4
      : man.mode === VMode.RETURN ? 6 : man.objective ? 7 : 0;
    const obj = man.objective ? man.objective.id : -1;
    const sig = kind * 1000 + (kind === 4 ? (man.msg ? man.msg.id % 1000 : 0) : obj + 1);
    if (sig === man.taskSig) return;
    const prevKind = man.taskKind, prevSig = man.taskSig;
    if (prevSig >= 0) {
      const key = `${TASK_NAMES[prevKind]}→${TASK_NAMES[kind]}`;
      this.stats.taskChanges[key] = (this.stats.taskChanges[key] || 0) + 1;
      if (sig === man.taskPrevSig && time - man.taskT < 30) this.stats.taskThrash++;
      // Finished a real task (anything but idle / own initiative / going home): time until the next one.
      if (prevKind >= 1 && prevKind <= 5 && (kind === 0 || kind === 6 || kind === 7)) man.freeSince = time;
      if (kind >= 1 && kind <= 5 && man.freeSince > 0) { this.stats.gapToNextTask += time - man.freeSince; this.stats.nextTasks++; man.freeSince = 0; }
    }
    man.taskPrevSig = prevSig; man.taskSig = sig; man.taskKind = kind; man.taskPrevT = man.taskT; man.taskT = time;
    const cw = tk && (tk as any).vehWhy ? (tk as any).vehWhy[v.id] : '';
    man.taskWhy = prevSig < 0 ? 'first task' : kind === 5 ? 'damaged: going for repairs' : kind === 6 ? (man.lastTrip || 'nothing left to do out there') : kind === 1 ? `commander: ${tk ? tk.vehicleRole(v.id) : ''}`
      : prevKind === 1 ? 'operation ended / vehicle released' : cw && kind === 7 ? cw : man.supportWhy || man.lastTrip || `${TASK_NAMES[prevKind]} ended`;
  }

  // ================================================================= transport relationships

  /** Records a relationship change on both sides (squad and vehicle) with its reason. */
  private relate(v: VehicleLike, man: VehicleManifest, q: SquadBlackboard | null, state: string, why: string): void {
    const time = this.game.time;
    const ended = state === 'released' || state === 'lost';
    if (q && (!ended || q.transport === v.id)) { q.transport = ended ? -1 : v.id; q.transportState = state; q.transportWhy = why; q.transportT = time; }
    man.supports = ended ? -1 : q ? q.id : -1; man.supportState = state; man.supportWhy = why; man.supportT = time;
    this.stats.rel[state] = (this.stats.rel[state] || 0) + 1;
  }

  /**
   * Keeps an unloaded transport's relationship honest: it ends when the squad is gone, rides with someone
   * else, the vehicle is tasked elsewhere by the commander or needs repairs, or nobody has needed it for
   * four minutes. An escort that lost touch with its squad drops back to standby. A squad that asks to be
   * pulled out gets its own transport first.
   */
  private upkeepRelation(v: VehicleLike, man: VehicleManifest, time: number): void {
    // Carrying out an extraction: keep the ticket ours and alive until the squad is delivered.
    if (man.extracting && man.msg && this.radio.holds(man.msg, v.id, man.msgId)) { man.msg.claimTime = time; if (man.msg.expires < time + 30) man.msg.expires = time + 30; }
    if (man.supports < 0 || man.squadId >= 0) return;
    const q = this.squads.squads[man.supports];
    if (q.alive === 0) { this.relate(v, man, q, 'released', 'squad wiped out'); return; }
    if (q.transport !== v.id) { this.relate(v, man, q, 'released', 'squad moved on with another vehicle'); return; }
    if (man.servicing) { this.relate(v, man, q, 'released', 'vehicle went for repairs'); return; }
    if (man.opPhase >= 0) { this.relate(v, man, q, 'released', 'commander tasked the vehicle elsewhere'); return; }
    // The bond lasts: released only when the squad has gone far beyond reach for a long time (8 min).
    const sqD = Math.hypot(q.cx - v.pos.x, q.cz - v.pos.z);
    if (man.supportState === 'standby' && time - man.supportT > 480 && sqD > 900) { this.relate(v, man, q, 'released', 'squad out of reach for 8 min'); return; }
    if (man.supportState === 'escort' && sqD > 400) this.relate(v, man, q, 'standby', 'squad moved out of escort range');
    // Standby: shadow the squad, holding ~110 m behind it (toward home) when it has moved on, out of the line of
    // fire but close enough to come forward and pick it up.
    if (man.supportState === 'standby' && man.mode === VMode.HOLD && Math.hypot(q.cx - man.waitX, q.cz - man.waitZ) > 280 &&
      q.contactCentroid(time, 10, P3) === 0 && time - man.modeTime > 6) {
      let bx = v.pos.x - q.cx, bz = v.pos.z - q.cz;
      const bd = Math.hypot(bx, bz) || 1; bx /= bd; bz /= bd;
      const wx = q.cx + bx * 110, wz = q.cz + bz * 110;
      if (!this.game.nav.blocked(wx, wz, true)) { man.waitX = wx; man.waitZ = wz; man.supportT = time; man.setMode(VMode.HOLD, time); this.stats.shadowMoves++; }
    }
    // Extraction asked for: the squad's own transport answers it.
    const m = q.extractMsg;
    if (q.extractState === 'requested' && m && m.state === MsgState.OPEN && m.id === q.extractMsgId && time >= q.noLiftUntil) {
      m.state = MsgState.CLAIMED; m.claimedBy = v.id; m.claimTime = time; m.aliveT = time; if (!m.firstClaim) m.firstClaim = time;
      man.msg = m; man.msgId = m.id; man.extracting = true; this.stats.extractClaims++;
      this.startPickup(v, man, q, time, 'extraction requested');
      return;
    }
    // The squad needs to go far again: its transport comes to get it.
    if (q.vehicle < 0 && q.dismounted >= 2 && time >= q.noLiftUntil && q.contactCentroid(time, 8, P2) === 0 && squadGoal(q, P2) >= 0 &&
      Math.hypot(P2[0] - q.cx, P2[1] - q.cz) > 220 && (q.cx - v.pos.x) ** 2 + (q.cz - v.pos.z) ** 2 < 900 * 900 &&
      this.freePassengerSeats(v, man) >= Math.max(Math.min(2, q.dismounted), q.dismounted - 1)) {
      this.stats.ownPickups++;
      this.startPickup(v, man, q, time, 'squad has a long way to go');
    }
  }

  /** Drives to the squad and boards it (seats reserved now; the carrier waits longer while it is still driving up). */
  private startPickup(v: VehicleLike, man: VehicleManifest, q: SquadBlackboard, time: number, why: string): void {
    const soldiers = this.game.soldiers;
    man.squadId = q.id; man.reserved = 0;
    this.reservePassenger(soldiers[q.leader], v, man, q, time);
    for (let i = 0; i < q.count; i++) this.reservePassenger(soldiers[q.members[i]], v, man, q, time);
    q.vehicle = v.id;
    man.waitUntil = time + 60;
    man.setMode(VMode.BOARDING, time);
    this.relate(v, man, q, 'pickup', why);
  }

  /** After the drop: what the transport does for its squad depends on its kind and the squad's task. */
  private afterDrop(v: VehicleLike, man: VehicleManifest, q: SquadBlackboard, time: number): void {
    const arch = man.archetype;
    if (man.extracting) {
      man.extracting = false;
      if (man.msg && this.radio.holds(man.msg, v.id, man.msgId)) { this.radio.complete(man.msg); this.stats.extractDelivered++; }
      man.msg = null;
      this.relate(v, man, q, 'released', 'extraction delivered');
      man.setMode(arch === A.TRUCK ? VMode.RETURN : VMode.OVERWATCH, time);
      return;
    }
    if (arch === A.IFV) { this.relate(v, man, q, 'escort', 'IFV fights alongside the squad it delivered'); man.setMode(VMode.SUPPORT, time); return; }
    if (q.opId >= 0 || q.order !== Order.NONE || q.garrison >= 0) {
      // Wait out of the way, 60 m back toward home from the drop, ready to pick the squad up again.
      let dx = v.spawn.x - v.pos.x, dz = v.spawn.z - v.pos.z;
      const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
      man.waitX = v.pos.x + dx * 60; man.waitZ = v.pos.z + dz * 60;
      if (this.game.nav.blocked(man.waitX, man.waitZ, true)) { man.waitX = v.pos.x; man.waitZ = v.pos.z; }
      this.relate(v, man, q, 'standby', 'squad on a task; waiting nearby for a pickup');
      man.setMode(VMode.HOLD, time);
      return;
    }
    // A free squad keeps its transport too: it waits back from the drop, shadows the squad as it moves on, and
    // comes to get it when it has a long way to go again (the squad and its vehicle stay a unit).
    let dx = v.spawn.x - v.pos.x, dz = v.spawn.z - v.pos.z;
    const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    man.waitX = v.pos.x + dx * 50; man.waitZ = v.pos.z + dz * 50;
    if (this.game.nav.blocked(man.waitX, man.waitZ, true)) { man.waitX = v.pos.x; man.waitZ = v.pos.z; }
    this.relate(v, man, q, 'standby', 'squad on its own objective; staying with it');
    man.setMode(VMode.HOLD, time);
  }

  // ================================================================= tank riders

  /**
   * Tank riders: a squad with a long way to go climbs onto the deck of
   * armour near it that is driving toward the same place anyway (its drive
   * target close to the squad's goal), if the whole squad fits. The tank
   * waits for them briefly; they get off when they arrive, when the tank
   * turns away, under fire, when it stops for long, or when it is hit hard.
   */
  private riderBoarding(time: number): void {
    const list = this.game.vehicles.list, soldiers = this.game.soldiers;
    for (let qi = 0; qi < this.squads.squads.length; qi++) {
      const q = this.squads.squads[qi];
      if (q.kind !== SquadKind.INFANTRY || q.vehicle >= 0 || q.dismounted < 2 || q.dismounted < q.alive || q.order === Order.AIRLIFT) continue;
      if (q.contactCentroid(time, 10, P2) > 0) continue;
      if (q.posture === Posture.BOUND || q.posture === Posture.FLANK || q.posture === Posture.HOLD) continue;
      if (squadGoal(q, P2) < 0) continue;
      const gx = P2[0], gz = P2[1], dq = Math.hypot(gx - q.cx, gz - q.cz);
      if (dq < 260) continue;
      let best = -1, bd = 70 * 70;
      for (let vi = 0; vi < list.length; vi++) {
        const v = list[vi], man = this.manifests[vi];
        if (!RIDE_ON[man.archetype] || !v.alive || v.team !== q.team || !v.occupied || man.riderSquad >= 0 || this.locked[vi]) continue;
        const d = v.driver;
        if (!d || d.isPlayer || !d.ai || man.servicing || this.squads.convoyOf[vi] >= 0 || v.health < v.def.health * 0.5) continue;
        if (vi === q.noRideV && time < q.noRideUntil) continue;
        const dd = (v.pos.x - q.cx) ** 2 + (v.pos.z - q.cz) ** 2;
        if (dd > bd) continue;
        // Going the same way: still far from its own destination, and that destination is near where the squad is going.
        const a = d.ai, tx = a.driveX, tz = a.driveZ;
        if (Math.hypot(tx - v.pos.x, tz - v.pos.z) < 180) continue;
        if (Math.hypot(tx - gx, tz - gz) > dq * 0.35 + 80) continue;
        if (this.freeRiderSeats(v, man) < q.alive) continue;
        bd = dd; best = vi;
      }
      if (best < 0) continue;
      const v = list[best], man = this.manifests[best];
      let n = 0;
      for (let i = 0; i < q.count; i++) {
        const s = soldiers[q.members[i]];
        if (!s.alive || s.vehicle || s.isPlayer || !s.ai || this.st.ticket[s.id] >= 0) continue;
        for (let k = 0; k < v.seats.length; k++) {
          if (man.seatRole[k] !== SeatRole.RIDER || v.seats[k] || man.ticket[k] >= 0) continue;
          if (this.reserve(s, v, k, q.id, time) >= 0) n++;
          break;
        }
      }
      if (n === 0) continue;
      man.riderSquad = q.id; man.riderWaitUntil = time + 14; man.riderStill = 0; man.riderT = time;
      q.vehicle = best; q.posture = Posture.MOUNTED;
      this.stats.riderTrips++;
    }
  }

  private freeRiderSeats(v: VehicleLike, man: VehicleManifest): number {
    let n = 0;
    for (let i = 0; i < v.seats.length; i++) if (man.seatRole[i] === SeatRole.RIDER && !v.seats[i] && man.ticket[i] < 0) n++;
    return n;
  }

  private tickRiders(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    const q = this.squads.squads[man.riderSquad];
    const dt = Math.min(1, time - man.riderT);
    man.riderT = time;
    let aboard = 0, pending = 0;
    for (let i = 0; i < v.seats.length; i++) {
      if (man.seatRole[i] !== SeatRole.RIDER) continue;
      const o = v.seats[i];
      if (o && o.squad === q) aboard++;
      if (man.ticket[i] >= 0 && this.tickets[man.ticket[i]].squadId === q.id) pending++;
    }
    // Climbing on: the tank waits (briefly) for its riders.
    if (pending > 0) {
      if (time < man.riderWaitUntil) { a.holdVehicle = true; return; }
      for (let i = 0; i < man.ticket.length; i++) if (man.ticket[i] >= 0 && man.seatRole[i] === SeatRole.RIDER) this.releaseTicket(man.ticket[i]);
      if (aboard > 0 && aboard < q.alive) { this.dropRiders(v, man, q, -1); return; }   // never split a squad
    }
    if (aboard === 0) {
      if (q.vehicle === v.id) q.vehicle = -1;
      q.noRideV = v.id; q.noRideUntil = time + 60;
      man.riderSquad = -1; return;
    }
    let why = -1;
    const goalR = squadGoal(q, P2);
    const dGoal = goalR >= 0 ? Math.hypot(P2[0] - v.pos.x, P2[1] - v.pos.z) : 0;
    if (goalR < 0 || dGoal < 110) why = 0;
    else if (v.health < v.def.health * 0.5 || man.servicing) why = 4;
    else if (this.crewThreat(v, P3) > 0 || q.contactCentroid(time, 4, P3) > 0 || man.damageRate > v.def.health * 0.01) why = 1;
    else if (Math.hypot(a.driveX - P2[0], a.driveZ - P2[1]) > dGoal - 20 && Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z) > 20) why = 2;
    else {
      man.riderStill = Math.abs(v.speed) < 1 ? man.riderStill + dt : 0;
      if (man.riderStill > 10) why = 3;
    }
    if (why >= 0) this.dropRiders(v, man, q, why);
  }

  /** Riders get off (the tank stops for it unless it is under fire). */
  private dropRiders(v: VehicleLike, man: VehicleManifest, q: SquadBlackboard, why: number): void {
    for (let i = 0; i < v.seats.length; i++) {
      const o = v.seats[i];
      if (o && o.ai && man.seatRole[i] === SeatRole.RIDER && o.squad === q) v.exit(o);
    }
    for (let i = 0; i < man.ticket.length; i++) if (man.ticket[i] >= 0 && man.seatRole[i] === SeatRole.RIDER) this.releaseTicket(man.ticket[i]);
    if (q.vehicle === v.id) { q.vehicle = -1; q.posture = Posture.ASSAULT; q.rallyX = v.pos.x; q.rallyZ = v.pos.z; }
    man.riderSquad = -1;
    const st = this.stats;
    if (why === 0) st.riderArrived++; else if (why === 1) st.riderContact++; else if (why === 2) st.riderDiverted++;
    else if (why === 3) st.riderStopped++; else if (why === 4) st.riderHit++; else st.riderAborted++;
  }

  /**
   * Emplacement gunner: watches toward the nearest objective not held by its
   * side; leaves the gun when its squad is ordered elsewhere (the gun stays
   * for whoever holds the position next).
   */
  private ctlTurret(v: VehicleLike, a: AgentLike, time: number): void {
    const s = v.seats[0] as SoldierLike;
    const q = s.squad as SquadBlackboard | null;
    const holding = q && (q.order === Order.DEFEND || q.order === Order.HOLD || q.garrison >= 0) &&
      (q.destX - v.pos.x) ** 2 + (q.destZ - v.pos.z) ** 2 < 80 * 80;
    if (!holding && time - (a.lastSeenTime || 0) > 6) { v.exit(s); return; }
    const flags = this.game.capture.flags;
    let best = -1, bd = 1e12;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f.owner === v.team) continue;
      const d = (f.x - v.pos.x) ** 2 + (f.z - v.pos.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) a.lookYaw = Math.atan2(flags[best].x - v.pos.x, flags[best].z - v.pos.z);
  }

  // ================================================================= shared behaviours

  /**
   * Below half health (and not carrying passengers, not in a convoy, not in
   * a close fight) a ground vehicle breaks off to the nearest repair point,
   * and stays until it is back above 90 %. No repair point in reach: it
   * carries on with its duties.
   */
  private needsService(v: VehicleLike, man: VehicleManifest, time: number): boolean {
    const frac = v.health / v.def.health;
    if (man.servicing && frac > 0.9) { man.servicing = false; man.setMode(VMode.PARKED, time); man.idleSince = time; return false; }
    if (!man.servicing) {
      if (frac > 0.5 || man.archetype === A.SUPPLY || (this.squads.convoyOf[v.id] >= 0 && frac > 0.35)) return false;
      if (man.mode === VMode.BOARDING || man.mode === VMode.TRANSIT || man.mode === VMode.DISMOUNT || this.passengersAboard(v, man) > 0) return false;
      if (this.crewThreat(v, P2) > 0 && Math.hypot(P2[0] - v.pos.x, P2[1] - v.pos.z) < 120 && frac > 0.25) return false;
    }
    if (time - man.svcAt > 10) {
      man.svcAt = time;
      if (!this.repairPoint(v, P2)) { man.servicing = false; return false; }
      man.svcX = P2[0]; man.svcZ = P2[1];
    }
    if (!man.servicing) { man.servicing = true; man.setMode(VMode.SERVICE, time); man.objective = null; }
    return true;
  }

  /** Nearest friendly repair point: a stopped supply truck within 700 m, else a service station of ours within 1000 m. */
  private repairPoint(v: VehicleLike, out: Float32Array): boolean {
    const list = this.game.vehicles.list;
    let bd = 700 * 700, found = false;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t === v || !t.alive || this.manifests[i].archetype !== A.SUPPLY || (t.occupied ? t.team : t.spawn.team) !== v.team) continue;
      const d = (t.pos.x - v.pos.x) ** 2 + (t.pos.z - v.pos.z) ** 2;
      if (d < bd) { bd = d; out[0] = t.pos.x; out[1] = t.pos.z; found = true; }
    }
    if (found) return true;
    const st = (this.game.map as any).supplies as { x: number; z: number; r: number; team: number; flag?: number }[] | undefined;
    if (!st) return false;
    const flags = this.game.capture.flags;
    bd = 1000 * 1000;
    for (const p of st) {
      const team = p.team >= 0 ? p.team : p.flag !== undefined && p.flag >= 0 ? flags[p.flag].owner : -1;
      if (team !== v.team) continue;
      const d = (p.x - v.pos.x) ** 2 + (p.z - v.pos.z) ** 2;
      if (d < bd) { bd = d; out[0] = p.x; out[1] = p.z; found = true; }
    }
    return found;
  }

  private ctlService(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    man.setMode(VMode.SERVICE, time);
    this.drive(a, man.svcX, man.svcZ);
    a.holdVehicle = Math.hypot(man.svcX - v.pos.x, man.svcZ - v.pos.z) < 10;
    if (v.radarOn !== undefined && man.archetype !== A.SAM) v.radarOn = man.archetype === A.SPAAG;
  }

  /** Front-line flag for a vehicle: contested or enemy-held, nearest, spread across the team. */
  private updateObjective(v: VehicleLike, man: VehicleManifest, time: number): void {
    if (man.objective && time - man.objectiveTime < 20 && !(man.objective.owner === v.team && man.objective.contestedBy < 0)) return;
    const flags = this.game.capture.flags;
    let best: FlagLike | null = null, bs = 1e12;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      const mine = f.owner === v.team, contested = f.contestedBy >= 0 && f.contestedBy !== v.team;
      // Ground vehicles only fight for objectives on their own landmass (not across the sound to NOVEMBER).
      if (!v.isAircraft && !(this.game.nav as any).sameLandmass(v.pos.x, v.pos.z, f.x, f.z)) continue;
      let s = Math.hypot(f.x - v.pos.x, f.z - v.pos.z) * (0.85 + hash01(v.id, i) * 0.3);
      if (mine && !contested) s += 900;
      for (let k = 0; k < this.manifests.length; k++) {
        const o = this.manifests[k];
        if (o !== man && o.objective === f && this.game.vehicles.list[k].team === v.team) s += 40;
      }
      if (s < bs) { bs = s; best = f; }
    }
    man.objective = best; man.objectiveTime = time;
  }

  /** Point `dist` metres from the flag on the vehicle's side of it. */
  private standoffPoint(v: VehicleLike, f: { x: number; z: number }, dist: number, out: Float32Array): void {
    let dx = v.pos.x - f.x, dz = v.pos.z - f.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    out[0] = f.x + dx * dist; out[1] = f.z + dz * dist;
  }

  private drive(a: AgentLike, x: number, z: number): void { a.driveX = x; a.driveZ = z; }

  /** Why a vehicle is setting out on its trip, in words: the stated purpose of a convoy it leads. */
  /**
   * What the vehicle's trip is for, as a key shared by vehicles on the same job: its operation, else the squad it
   * carries / the objective it moves up to (by its objective flag), else a trip home. -1: no shared task.
   */
  taskKey(v: VehicleLike): number {
    const man = this.manifests[v.id], tk = this.tasking[v.team];
    const op = tk ? tk.vehicleOpId(v.id) : -1;
    if (op >= 0) return 1000 + op;
    if (man.mode === VMode.RETURN) return 3000 + v.team;
    const f = man.objective;
    return f ? 2000 + this.game.capture.flags.indexOf(f) : -1;
  }

  purpose(v: VehicleLike): string {
    const man = this.manifests[v.id], tk = this.tasking[v.team];
    const role = tk ? tk.vehicleRole(v.id) : '';
    if (role) return role;
    const aboard = this.passengersAboard(v, man);
    if (aboard > 0 && man.squadId >= 0) return `troop lift: squad ${man.squadId} (${aboard} aboard)`;
    if (man.extracting) return 'extraction run';
    if (man.mode === VMode.RETURN) return 'returning to base';
    if (man.archetype === A.SUPPLY) return 'resupply run';
    return man.objective ? 'moving up to the front' : 'repositioning';
  }

  /** Total rounds fired by a vehicle's weapons (to tell whether an attack pass actually engaged). */
  private shotsFired(v: VehicleLike): number {
    let n = 0;
    for (let i = 0; i < v.weapons.length; i++) n += (v.weapons[i] as any).shot || 0;
    return n;
  }

  /** Best known threat to a vehicle from its crew's targets (AT soldiers and armour first). */
  private crewThreat(v: VehicleLike, out: Float32Array): number {
    let best = 0;
    for (let i = 0; i < v.seats.length; i++) {
      const o = v.seats[i];
      const a = o && o.ai;
      if (!a || !a.target) continue;
      const t = a.target;
      const w = t.kind === 'soldier' ? (t.launcher ? 3 : 1) : t.def.armor === 'heavy' ? 4 : t.def.armor === 'light' ? 2.5 : 1;
      if (w > best) { best = w; out[0] = a.lastSeenX; out[1] = a.lastSeenZ; }
    }
    return best;
  }

  private agentOfMount(v: VehicleLike, mount: number): AgentLike | null {
    const m = v.def.mounts[mount];
    const s = v.seats[m.seat] || (m.fallbackSeat !== undefined ? v.seats[m.fallbackSeat] : null);
    return s && s.ai ? s.ai : null;
  }

  private friendliesNear(team: number, x: number, z: number, r: number): number {
    const n = this.grid.queryRadius(x, z, r, IDS);
    let c = 0;
    for (let i = 0; i < n; i++) {
      const id = IDS[i];
      if (id < this.S) { const s = this.game.soldiers[id]; if (s.alive && s.team === team) c++; }
      else { const v = this.game.vehicles.list[id - this.S]; if (v.alive && v.occupied && v.team === team) c += 2; }
    }
    return c;
  }

  private enemiesNear(team: number, x: number, z: number, r: number): number {
    const n = this.grid.queryRadius(x, z, r, IDS, 0, this.S);
    let c = 0;
    for (let i = 0; i < n; i++) { const s = this.game.soldiers[IDS[i]]; if (s.alive && s.team !== team && !s.vehicle) c++; }
    return c;
  }

  /**
   * Bail only when the hull is burning AND the outside is more survivable:
   * nearby cover, few enemies close, no point-blank fire. Aircraft only bail
   * high enough for a parachute; lower down they try to land.
   */
  private shouldBail(v: VehicleLike, man: VehicleManifest, time: number): boolean {
    const frac = v.health / v.def.health;
    if (frac > AI_TUNING.criticalBurn) return false;
    if (v.isAircraft) {
      if (v.altitude > 30) return frac < 0.12;
      return v.altitude < 1.5 && v.airspeed < 3;
    }
    let inside = frac * 4 * (ARMOR_K[v.def.armor] || 1) - (man.damageRate / v.def.health) * 12;
    if (frac < 0.12) inside -= 1; // burning
    const coverN = Math.min(4, this.cover.grid.query(v.pos.x, v.pos.z, 15, IDS));
    const close = this.enemiesNear(v.team, v.pos.x, v.pos.z, 30);
    const near = this.enemiesNear(v.team, v.pos.x, v.pos.z, 70);
    const outside = coverN * 0.15 + (1 - Math.min(1, near / 4)) * 0.5 - close * 0.35 + this.foliage.at(v.pos.x, v.pos.z) * 0.2;
    void time;
    return outside > inside;
  }

  private bailCrew(v: VehicleLike): void {
    let n = 0;
    for (let i = 0; i < v.seats.length; i++) {
      const o = v.seats[i];
      if (o && o.ai) { v.exit(o); n++; }
    }
    if (n === 0) return;
    this.stats.bailouts++;
    v.controls.throttle = 0; v.controls.brake = true;
  }

  /** Passenger exit (crew keep their seats); the squad resumes the assault from the drop point. */
  dismountPassengers(v: VehicleLike): number {
    const man = this.manifests[v.id];
    const carried = man.squadId >= 0 ? this.squads.squads[man.squadId] : null;
    // Where the threat is, read from the crew and passengers before they get out.
    const threat = this.crewThreat(v, T2) > 0;
    let n = 0;
    for (let i = 1; i < v.seats.length; i++) {
      const o = v.seats[i];
      // Passengers, plus the carried squad's own gunner, dismount; vehicle crews stay.
      if (o && o.ai && (CARGO[man.seatRole[i]] || (carried !== null && o.squad === carried))) { v.exit(o); n++; }
    }
    if (man.squadId >= 0) {
      const q = this.squads.squads[man.squadId];
      q.vehicle = -1; q.posture = Posture.ASSAULT; q.rallyX = v.pos.x; q.rallyZ = v.pos.z; q.objectiveTime = this.game.time;
      // Rally beside the vehicle, on the side away from the threat (or toward the squad's goal), clear of its path.
      const sx = Math.cos(v.yaw), sz = -Math.sin(v.yaw);
      let side = 1;
      if (threat) side = (T2[0] - v.pos.x) * sx + (T2[1] - v.pos.z) * sz > 0 ? -1 : 1;
      else if (squadGoal(q, P2) >= 0) side = (P2[0] - v.pos.x) * sx + (P2[1] - v.pos.z) * sz >= 0 ? 1 : -1;
      let rx = v.pos.x + sx * side * (v.def.half[0] + 6), rz = v.pos.z + sz * side * (v.def.half[0] + 6);
      if (this.game.nav.blocked(rx, rz)) { rx = v.pos.x - sx * side * (v.def.half[0] + 6); rz = v.pos.z - sz * side * (v.def.half[0] + 6); }
      q.dropT = this.game.time; q.dropX = rx; q.dropZ = rz; q.dropV = v.id; q.dropGathered = false;
    }
    if (n) man.unloadUntil = this.game.time + 3.5;
    for (let i = 0; i < man.ticket.length; i++) if (man.ticket[i] >= 0 && CARGO[man.seatRole[i]]) this.releaseTicket(man.ticket[i]);
    man.squadId = -1;
    if (n) this.stats.dismounts++;
    return n;
  }

  popSmoke(v: VehicleLike): void {
    const man = this.manifests[v.id], time = this.game.time;
    if (time < man.smokeReadyAt || v.isAircraft) return;
    man.smokeReadyAt = time + 30;
    let fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    if (this.crewThreat(v, P2) > 0) { fx = P2[0] - v.pos.x; fz = P2[1] - v.pos.z; const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l; }
    const x = v.pos.x + fx * 9, z = v.pos.z + fz * 9;
    this.smoke.deploy(x, this.game.map.terrain.height(x, z) + 1.5, z, 10, 18, time);
  }

  private flares(v: VehicleLike, time: number): void {
    const man = this.manifests[v.id];
    if (time < man.flareReadyAt) return;
    if (v.deployFlares(time)) { man.flareReadyAt = time + 7; man.evadeUntil = time + 4; }
  }

  scanSky(v: VehicleLike): void { const man = this.manifests[v.id]; man.radarOn = true; man.radarUntil = this.game.time + 15; v.radarOn = true; }

  /** A homing missile was launched at `target` (combat event). */
  onMissileLaunch(target: VehicleLike, shooter?: SoldierLike): void {
    if (target.kind !== 'vehicle' || !target.isAircraft || !target.driver || target.driver.isPlayer) return;
    // Missile warning: flares, and a notch away from the launch point (see rwrWarn / the flight autopilots).
    const sp = shooter ? (shooter.vehicle ? shooter.vehicle.pos : shooter.pos) : null;
    this.rwrWarn(target, sp ? sp.x : target.pos.x + Math.sin(target.yaw) * 500, sp ? sp.z : target.pos.z + Math.cos(target.yaw) * 500, true);
  }

  /**
   * Radar / missile warning on aircraft v from (x, z): flares (if a missile is in the air), and the pilot breaks
   * perpendicular to the threat bearing (a notch — a radar or IR seeker loses an aircraft crossing its line of
   * sight) and dives for terrain masking for a few seconds.
   */
  private rwrWarn(v: VehicleLike, x: number, z: number, missile: boolean): void {
    const time = this.game.time, a = v.driver && v.driver.ai;
    if (!a) return;
    if (missile) this.flares(v, time);
    if (time < (a as any).evadeUntil) return;
    (a as any).evadeUntil = time + (missile ? 5 : 3.5);
    (a as any).evadeYaw = Math.atan2(x - v.pos.x, z - v.pos.z);
    this.stats.notches++;
  }

  /**
   * Low fly-by shock: an aircraft screaming over at under 35 m AGL and 15+ m/s suppresses and shakes the morale of
   * exposed enemy infantry within 30 m of its track (no damage).
   */
  private flybyShock(): void {
    const list = this.game.vehicles.list, soldiers = this.game.soldiers, S = soldiers.length;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.alive || !v.isAircraft || !v.occupied || v.altitude > 35 || v.altitude < 4 || Math.hypot(v.vel.x, v.vel.z) < 15) continue;
      const n = this.grid.queryRadius(v.pos.x, v.pos.z, 30, IDS, 0, S);
      let hit = 0;
      for (let k = 0; k < n; k++) {
        const s = soldiers[IDS[k]];
        if (!s.alive || s.vehicle || s.team === v.team || !s.ai) continue;
        this.engine.onSuppress(s.id, 0.35, v.pos.x, v.pos.z);
        this.st.morale[s.id] = Math.max(0, this.st.morale[s.id] - 0.06);
        hit++;
      }
      if (hit) { this.stats.flybyShock += hit; this.stats.flybys++; }
    }
  }

  /** Our side's recent contacts (≤ 20 s) within r of (x, z). */
  private contactsNear(team: number, x: number, z: number, r: number, time: number): number {
    let n = 0;
    for (const q of this.squads.squads) {
      if (q.team !== team) continue;
      for (let k = 0; k < q.cTarget.length; k++) if (q.cTarget[k] >= 0 && time - q.cT[k] < 20 && (q.cX[k] - x) ** 2 + (q.cZ[k] - z) ** 2 < r * r) n++;
    }
    return n;
  }

  /**
   * Secondary LZ for a wave-off, away from the threat: walkable, gentle slope (< 15°), few contacts. For an
   * insertion it stays inside the objective's 180 m assault ring (110–175 m from the flag); for a pick-up it is
   * 150–250 m from the planned zone.
   */
  private secondaryLz(v: VehicleLike, man: VehicleManifest, out: Float32Array): boolean {
    const nav = this.game.nav as any, t = this.game.map.terrain as any, time = this.game.time;
    const threat = this.crewThreat(v, T2) > 0;
    const q = man.insertSquad >= 0 ? this.squads.squads[man.insertSquad] : null, f = q && q.objective ? q.objective : null;
    const cx = f ? f.x : man.dismountX, cz = f ? f.z : man.dismountZ;
    const away = threat ? Math.atan2(cx - T2[0], cz - T2[1]) : Math.atan2(v.pos.x - cx, v.pos.z - cz);
    const radii = f ? [115, 145, 175] : [160, 210, 250];
    let best = -1e9;
    for (let k = 0; k < 12; k++) for (const r of radii) {
      const yaw = away + (k - 5.5) * 0.3, x = cx + Math.sin(yaw) * r, z = cz + Math.cos(yaw) * r;
      if (f && Math.hypot(x - man.dismountX, z - man.dismountZ) < 60) continue;
      if (!t.inBounds(x, z, 30) || nav.blocked(x, z) || t.slope(x, z) > 0.27 || !nav.sameLandmass(x, z, man.dismountX, man.dismountZ)) continue;
      const s = -this.contactsNear(v.team, x, z, 90, time) * 2 - Math.abs(k - 4.5) * 0.2 - r / 400;
      if (s > best) { best = s; out[0] = x; out[1] = z; }
    }
    return best > -1e9;
  }

  /** LZ marker: coloured smoke column by day, red flares at night or in fog (a few seconds of particles). */
  private markLz(x: number, z: number, time: number): void {
    const env = (this.game as any).environment, dark = env ? env.ambientLightFactor < 0.45 || env.visibilityRangeMeters < 450 : false;
    const slot = this.lzMarks.findIndex((m) => m.until < time);
    const m = slot >= 0 ? this.lzMarks[slot] : this.lzMarks[0];
    m.x = x; m.z = z; m.until = time + 18; m.night = dark; m.next = 0;
    this.stats.lzMarks++;
  }

  private emitLzMarks(time: number): void {
    const p = (this.game as any).particles, t = this.game.map.terrain;
    if (!p) return;
    for (const m of this.lzMarks) {
      if (m.until < time || time < m.next) continue;
      m.next = time + 0.25;
      const y = Math.max(t.height(m.x, m.z), 0) + 0.4;
      if (m.night) p.emit(m.x, y + 0.3, m.z, (Math.random() - 0.5) * 0.6, 2.2, (Math.random() - 0.5) * 0.6, 1.4, 0.9, 0.4, 3.2, 0.25, 0.15, 1, true, -1.5, 0.3);
      else p.emit(m.x, y, m.z, (Math.random() - 0.5) * 0.8, 1.6 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8, 6, 1.5, 6, 0.25, 0.72, 0.3, 0.55, false, -0.25, 0.6);
    }
  }

  /** Radar locks held by enemy air defences on our aircraft (checked a few times a second). */
  private scanLocks(time: number): void {
    const list = this.game.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s.alive || !s.occupied || !(s as any).locks) continue;
      const locks = (s as any).locks as (VehicleLike | null)[];
      for (let k = 0; k < locks.length; k++) {
        const t = locks[k];
        if (t && t.alive && t.isAircraft && t.team !== s.team && t.driver && !t.driver.isPlayer) this.rwrWarn(t, s.pos.x, s.pos.z, false);
      }
    }
    void time;
  }

  /** AIR_THREAT: cue SAM / SPAAG / fighter crews and light up SAM radars. */
  onRadio(m: RadioMessage): void {
    const list = this.game.vehicles.list, time = this.game.time;
    this.lastAirThreat[m.team] = time;
    for (let i = 0; i < list.length; i++) {
      const v = list[i], man = this.manifests[i];
      if (!v.alive || !v.occupied || v.team !== m.team) continue;
      const arch = man.archetype;
      if (arch !== A.SAM && arch !== A.SPAAG && arch !== A.FIGHTER && !man.aaCapable) continue;
      const d = Math.hypot(v.pos.x - m.x, v.pos.z - m.z);
      if (d > (arch === A.FIGHTER ? 1500 : 1100)) continue;
      if (arch === A.SAM) { man.radarOn = true; man.radarUntil = time + 12; v.radarOn = true; }
      if (m.targetIdx < 0) continue;
      for (let s = 0; s < v.seats.length; s++) {
        const o = v.seats[s];
        if (o && o.ai) this.engine.cue(o.id, m.targetIdx, m.x, m.y, m.z);
      }
    }
  }

  nearestSupply(team: number, x: number, z: number, radius: number): VehicleLike | null {
    const list = this.game.vehicles.list;
    let best: VehicleLike | null = null, bd = radius * radius;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.alive || this.manifests[i].archetype !== A.SUPPLY || (v.occupied ? v.team : v.spawn.team) !== team) continue;
      const d = (v.pos.x - x) ** 2 + (v.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  archetypeOfSeat(s: SoldierLike): number { return s.vehicle ? this.manifests[s.vehicle.id].archetype : -1; }

  /**
   * Safe dismount node near an objective: on the friendly approach, close to
   * cover, away from known threats and danger zones, preferring defilade
   * (no line of sight from the main threat — at most three raycasts).
   */
  private computeDismount(v: VehicleLike, man: VehicleManifest, fx: number, fz: number, standoff: number, time: number): void {
    const team = v.team;
    const q = man.squadId >= 0 ? this.squads.squads[man.squadId] : null;
    let threatN = 0, tx = fx, tz = fz;
    if (q) threatN = q.contactCentroid(time, 20, P2);
    if (threatN > 0) { tx = P2[0]; tz = P2[1]; }
    const enemyHeld = man.objective && man.objective.owner >= 0 && man.objective.owner !== team;
    let dx = v.pos.x - fx, dz = v.pos.z - fz;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const terrain = this.game.map.terrain;
    let n = 0;
    for (let k = -2; k <= 2; k++) {
      const ang = k * 0.38, c = Math.cos(ang), s = Math.sin(ang);
      const rx = dx * c - dz * s, rz = dx * s + dz * c;
      CAND_X[n] = fx + rx * standoff; CAND_Z[n] = fz + rz * standoff; n++;
    }
    CAND_X[n] = fx + dx * standoff * 0.7; CAND_Z[n] = fz + dz * standoff * 0.7; n++;
    // Known AT killzones (launcher teams, enemy armour our side has seen): candidates further back on the approach
    // too, so a carrier unloads 60–100 m short of them behind cover instead of driving in with a full bay.
    const nAt = v.def.kind === 'ground' ? this.knownAtThreats(team, fx, fz, 260, time) : 0;
    if (nAt > 0) for (const extra of [45, 80]) { CAND_X[n] = fx + dx * (standoff + extra); CAND_Z[n] = fz + dz * (standoff + extra); n++; }
    for (let i = 0; i < n; i++) {
      const x = CAND_X[i], z = CAND_Z[i];
      let s = -1e9;
      if (terrain.inBounds(x, z, 30) && !this.game.nav.blocked(x, z, v.def.kind === 'ground')) {
        s = Math.min(6, this.cover.grid.query(x, z, 16, IDS)) * 0.15 + this.foliage.at(x, z) * 0.4;
        const dt = Math.hypot(x - tx, z - tz);
        if (threatN > 0 || enemyHeld) s += Math.min(1, dt / 80) * 0.6;
        if (nAt > 0) {
          let dAt = 1e9;
          for (let k = 0; k < nAt; k++) dAt = Math.min(dAt, Math.hypot(x - AT_X[k], z - AT_Z[k]));
          s += dAt < 60 ? -3 : dAt < 100 ? 0.8 : 0.3;
          if (dAt < 100) this.stats.atAwareDrops++;
        }
        if (this.radio.inDangerZone(team, x, z, 15, time) >= 0) s -= 3;
        s -= Math.hypot(x - v.pos.x, z - v.pos.z) * 0.001;
      }
      CAND_S[i] = s;
    }
    // Defilade check for the three best candidates.
    for (let pass = 0; pass < 3; pass++) {
      let bi = -1;
      for (let i = 0; i < n; i++) if (CAND_S[i] > -1e8 && CAND_S[i] < 1e8 && (bi < 0 || CAND_S[i] > CAND_S[bi])) bi = i;
      if (bi < 0) break;
      const x = CAND_X[bi], z = CAND_Z[bi];
      const hidden = !this.game.physics.losClear(tx, terrain.height(tx, tz) + 2, tz, x, terrain.height(x, z) + 1.5, z);
      CAND_S[bi] += (hidden ? 0.6 : 0) + 1e8; // mark evaluated (offset removed below)
    }
    let best = -1;
    for (let i = 0; i < n; i++) {
      const s = CAND_S[i] >= 1e8 ? CAND_S[i] - 1e8 : CAND_S[i];
      if (best < 0 || s > (CAND_S[best] >= 1e8 ? CAND_S[best] - 1e8 : CAND_S[best])) best = i;
    }
    man.dismountX = CAND_X[best]; man.dismountZ = CAND_Z[best];
  }

  /** Our side's recent sightings (≤ 30 s) of enemy AT launchers and armour within r of (x, z); fills AT_X / AT_Z. */
  private knownAtThreats(team: number, x: number, z: number, r: number, time: number): number {
    let n = 0;
    const soldiers = this.game.soldiers, S = soldiers.length, list = this.game.vehicles.list;
    for (const q of this.squads.squads) {
      if (q.team !== team) continue;
      for (let k = 0; k < q.cTarget.length && n < AT_X.length; k++) {
        const t = q.cTarget[k];
        if (t < 0 || time - q.cT[k] > 30 || (q.cX[k] - x) ** 2 + (q.cZ[k] - z) ** 2 > r * r) continue;
        const at = t < S ? soldiers[t].launcher !== null && soldiers[t].alive : list[t - S] && list[t - S].alive && (list[t - S].def as any).armor === 'heavy';
        if (at) { AT_X[n] = q.cX[k]; AT_Z[n] = q.cZ[k]; n++; }
      }
    }
    return n;
  }

  // ================================================================= 15 archetype controllers

  /**
   * MBT / HT. Spearhead / breakthrough anchor: stand off the objective,
   * orient the frontal glacis at the worst AT threat, seek hull-down crests.
   * The heavy tank waits for an infantry screen before entering close terrain
   * and keeps advancing under fire.
   */
  private ctlMBT(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number, heavy: boolean): void {
    const f = man.objective;
    if (!f) { a.holdVehicle = true; return; }
    this.standoffPoint(v, f, STANDOFF[man.archetype], P2);
    let gx = P2[0], gz = P2[1];
    // Commander's firing position: line of sight onto the objective, hull-down where possible, clear of known AT.
    if (man.hasFire) { gx = man.fireX; gz = man.fireZ; }
    const dist = Math.hypot(f.x - v.pos.x, f.z - v.pos.z);
    if (heavy) {
      a.speedCap = v.def.maxSpeed * 0.85;
      // No blind push into the fortified flag without infantry around.
      const screen = this.friendliesNear(v.team, v.pos.x, v.pos.z, 35) - v.occupants * 2;
      if (dist < 80 && screen < 3) { this.standoffPoint(v, f, 75, P2); gx = P2[0]; gz = P2[1]; }
    }
    this.drive(a, gx, gz);
    const threat = this.crewThreat(v, P2);
    const holding = Math.hypot(gx - v.pos.x, gz - v.pos.z) < 10;
    man.setMode(threat > 0 ? VMode.OVERWATCH : holding ? VMode.HOLD : VMode.TRANSIT, time);
    if (threat > 0) {
      a.faceYaw = Math.atan2(P2[0] - v.pos.x, P2[1] - v.pos.z);
      if (holding && time > man.nextHullDown) {
        man.nextHullDown = time + 6;
        if (this.hullDown(v, P2[0], P2[1], P2)) { this.drive(a, P2[0], P2[1]); man.setMode(VMode.HIDE, time); return; }
      }
    }
    a.holdVehicle = holding && (!heavy || threat > 0 || dist < 50 || man.hasFire);
    // Holding with no target: hull toward the objective (frontal armour where trouble will come from).
    if (a.holdVehicle && threat === 0) a.faceYaw = Math.atan2(f.x - v.pos.x, f.z - v.pos.z);
  }

  /** Hull-down search: a spot where a crest 0.6–1.8 m high lies between the hull and the threat. */
  private hullDown(v: VehicleLike, tx: number, tz: number, out: Float32Array): boolean {
    const terrain = this.game.map.terrain;
    let dx = tx - v.pos.x, dz = tz - v.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    let best = -1, bestScore = -1;
    for (let i = 0; i < 6; i++) {
      const ang = (i - 2.5) * 0.5, r = 10 + (i % 3) * 10;
      const c = Math.cos(ang), s = Math.sin(ang);
      const x = v.pos.x + (dx * c - dz * s) * r * 0.6 + (-dz) * (i - 2.5) * 6, z = v.pos.z + (dx * s + dz * c) * r * 0.6 + dx * (i - 2.5) * 6;
      if (this.game.nav.blocked(x, z, true)) continue;
      const h = terrain.height(x, z), crest = terrain.height(x + dx * 8, z + dz * 8) - h;
      if (crest < 0.6 || crest > 1.8) continue;
      const score = 2 - Math.abs(crest - 1.1) - Math.hypot(x - v.pos.x, z - v.pos.z) * 0.02;
      if (score > bestScore) { bestScore = score; best = i; out[0] = x; out[1] = z; }
    }
    return best >= 0;
  }

  /**
   * LT: recon flanker. Avoids frontal duels with heavy armour (repositions to
   * a flank), shoots and scoots, and lases armour for friendly CAS / artillery
   * (spot reports from its crew are laser-marked).
   */
  private ctlLT(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    const f = man.objective;
    if (!f) { a.holdVehicle = true; return; }
    const g = this.agentOfMount(v, 0);
    const t = g ? g.target : null;
    if (t && t.kind === 'vehicle' && t.def.armor === 'heavy' && g && g.targetVisible) {
      const dx = v.pos.x - t.pos.x, dz = v.pos.z - t.pos.z, d = Math.hypot(dx, dz) || 1;
      const facing = (Math.sin(t.yaw) * dx + Math.cos(t.yaw) * dz) / d;
      if (facing > 0.6 && d < 320) {
        // Frontal aspect: break contact sideways toward concealment.
        const side = this.foliage.at(t.pos.x - dz / d * 70, t.pos.z + dx / d * 70) > this.foliage.at(t.pos.x + dz / d * 70, t.pos.z - dx / d * 70) ? 1 : -1;
        man.setMode(VMode.FLANK, time);
        man.tx = t.pos.x - (dz / d) * 80 * side + (dx / d) * 40; man.tz = t.pos.z + (dx / d) * 80 * side + (dz / d) * 40;
      }
      // Re-mark the tank for CAS every few seconds.
      const sq = v.driver && v.driver.squad ? (v.driver.squad as SquadBlackboard).id : -1;
      const m = this.radio.publish(RadioType.CAS_REQUEST, v.team, v.driver ? v.driver.id : -1, sq, t.pos.x, t.pos.y, t.pos.z,
        this.engine.index(t), 2, time, 0, true);
      if (m) { m.vx = t.pos.x - v.pos.x; m.vz = t.pos.z - v.pos.z; }
    }
    const shots = v.weapons[0].shot;
    if (man.mode === VMode.FLANK) {
      this.drive(a, man.tx, man.tz);
      if (Math.hypot(man.tx - v.pos.x, man.tz - v.pos.z) < 15 || time - man.modeTime > 25) man.setMode(VMode.HOLD, time);
      return;
    }
    // Shoot and scoot: relocate after each main-gun shot.
    if (shots !== man.shotsAtMove && man.mode === VMode.HOLD) {
      man.shotsAtMove = shots;
      const ang = rand(this.st.rng, v.driver ? v.driver.id : 0) * Math.PI * 2;
      man.tx = v.pos.x + Math.cos(ang) * 30; man.tz = v.pos.z + Math.sin(ang) * 30;
      man.setMode(VMode.SCOOT, time);
    }
    if (man.mode === VMode.SCOOT && time - man.modeTime < 6) { this.drive(a, man.tx, man.tz); return; }
    this.standoffPoint(v, f, STANDOFF[A.LT], P2);
    if (man.hasFire) { P2[0] = man.fireX; P2[1] = man.fireZ; }
    this.drive(a, P2[0], P2[1]);
    const there = Math.hypot(P2[0] - v.pos.x, P2[1] - v.pos.z) < 12;
    man.setMode(there ? VMode.HOLD : VMode.TRANSIT, time);
    a.holdVehicle = there;
  }

  /**
   * Drive home and park: reserve a free slot in the base park that fits (its own first), drive into it and
   * stop. A slot it cannot get into (jammed approach) is given up for another one rather than retried.
   * Returns true once parked.
   */
  private goHome(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): boolean {
    const sl = this.park.claim(v, time);
    const hx = sl ? sl.x : v.spawn.x, hz = sl ? sl.z : v.spawn.z;
    this.drive(a, hx, hz);
    a.arriveR = sl ? 2.5 : 8;
    const dh = Math.hypot(hx - v.pos.x, hz - v.pos.z);
    if (sl && dh < 3.5) {
      a.holdVehicle = true; this.park.parked(v, sl);
      man.setMode(VMode.PARKED, time); man.idleSince = time;
      return true;
    }
    if (sl && dh < 40 && a.stuckRepeat >= 2) { this.park.failed(v, time); a.stuckRepeat = 0; return false; }
    // No slot free: wait at the edge of the park, not in its lanes.
    if (!sl && (dh < 14 || (dh < 45 && a.stuckRepeat >= 1))) { a.holdVehicle = true; man.setMode(VMode.PARKED, time); man.idleSince = time; return true; }
    return false;
  }

  /**
   * APC / IFV / transport truck (and the light scout car): squad-sync
   * boarding, transit to a safe dismount node, unload, then
   *  - APC: medium-range overwatch, backing off from AT;
   *  - IFV: advance with the dismounted squad, suppressing;
   *  - truck: return to base for the next wave.
   */
  private ctlCarrier(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    const arch = man.archetype, f = man.objective;
    let aboard = this.passengersAboard(v, man);
    // Air-defence escort: with enemy aircraft about, an empty carrier with a manned AA mount (scout car)
    // shadows the nearest friendly squad so its gunner can cover them, instead of idling at base.
    if (man.aaCapable && aboard === 0 && this.aaManned(v) && time - this.lastAirThreat[v.team] < 45 &&
      (man.mode === VMode.PARKED || man.mode === VMode.RETURN || man.mode === VMode.OVERWATCH || man.mode === VMode.SUPPORT)) {
      man.setMode(VMode.SUPPORT, time);
      const q = this.nearestSquadWithin(v, 450);
      if (q) {
        const hasC = q.contactCentroid(time, 10, P2) > 0;
        const tx = hasC ? P2[0] : q.objective ? q.objective.x : q.cx, tz = hasC ? P2[1] : q.objective ? q.objective.z : q.cz;
        let dx = tx - q.cx, dz = tz - q.cz;
        const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
        this.drive(a, q.cx - dx * 28, q.cz - dz * 28);
        a.holdVehicle = Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z) < 12;
      } else a.holdVehicle = true;
      return;
    }
    this.upkeepRelation(v, man, time);
    // An empty carrier with nothing to do answers a nearby extraction request (helicopters do the same).
    if (aboard === 0 && man.squadId < 0 && man.supports < 0 && man.opPhase < 0 && !man.servicing && v.def.passengers > 0 &&
      (man.mode === VMode.PARKED || man.mode === VMode.OVERWATCH || man.mode === VMode.RETURN) && time > man.radarToggleAt) {
      man.radarToggleAt = time + 2;
      const m = this.take(v, man, RadioType.EXTRACT_REQUEST, 500, time);
      if (m && m.senderSquad >= 0 && time < this.squads.squads[m.senderSquad].noLiftUntil) {
        // The last vehicle sent to them was destroyed on the way: not another one into the same fire.
        this.radio.callOff(m, 'the last vehicle sent there was destroyed', time);
      } else if (m && m.senderSquad >= 0) {
        man.msg = m; man.msgId = m.id; man.extracting = true; this.stats.extractClaims++;
        this.startPickup(v, man, this.squads.squads[m.senderSquad], time, 'answering an extraction request');
        return;
      }
    }
    switch (man.mode) {
      case VMode.PARKED:
        a.holdVehicle = true;
        // Waiting somewhere that is not a parking slot (a lane, the field): go and take a slot at home.
        if (aboard === 0 && man.squadId < 0 && man.supports < 0 && time - man.idleSince > 12 && !this.park.inSlot(v)) { man.setMode(VMode.RETURN, time); return; }
        // Nobody to carry: armed carriers go and fight, trucks wait at home.
        if (v.def.passengers === 0 || (time - man.idleSince > 25 && arch !== A.TRUCK)) man.setMode(arch === A.IFV ? VMode.SUPPORT : VMode.OVERWATCH, time);
        if (aboard > 0 && f) this.startTransit(v, man, time);
        return;
      case VMode.BOARDING: {
        a.holdVehicle = true;
        if (man.supportState === 'pickup' && man.squadId >= 0) {
          const q = this.squads.squads[man.squadId];
          if (q.alive > 0 && (q.cx - v.pos.x) ** 2 + (q.cz - v.pos.z) ** 2 > 22 * 22 && time < man.waitUntil) {
            this.drive(a, q.cx, q.cz); a.holdVehicle = false;
            return;
          }
        }
        v.holdDoors();
        const pending = this.pendingPassengerTickets(man);
        // Everyone who reserved a seat gets aboard; the carrier leaves short only once those still missing are far
        // off or it has waited a while (and never past waitUntil).
        const missing = this.missingNear(v, man, 150);
        const full = man.reserved > 0 && (aboard >= man.reserved ||
          (aboard >= Math.ceil(man.reserved * AI_TUNING.boardFraction) && (time - man.modeTime > 20 || this.pendingFar(v, man, 60))));
        if ((full || time > man.waitUntil || (pending === 0 && aboard > 0 && missing <= 1)) && f) {
          const cq = man.squadId >= 0 ? this.squads.squads[man.squadId] : null;
          const leaderAboard = cq !== null && cq.leader >= 0 && this.game.soldiers[cq.leader].vehicle === v;
          if (aboard > 0 && missing > aboard && !leaderAboard) {
            // Most of the squad nearby is still on foot and the leader with them: no driving off with a few of them
            // (they would walk back to the leader after the drop); they get out again and the squad walks together.
            // With the leader aboard, the ride goes: those on foot follow the leader toward the same goal.
            this.stats.splitAvoided++;
            const q = this.squads.squads[man.squadId];
            q.noRideV = v.id; q.noRideUntil = time + 90;
            this.relate(v, man, q, 'released', 'too few of the squad aboard: they walk together');
            this.dismountPassengers(v);
            q.dropT = -1e9;
          }
          aboard = this.passengersAboard(v, man);
          for (let i = 0; i < man.ticket.length; i++) if (man.ticket[i] >= 0 && CARGO[man.seatRole[i]]) this.releaseTicket(man.ticket[i]);
          if (aboard > 0) this.startTransit(v, man, time);
          else {
            // Nobody made it: the squad walks and does not try this carrier again for a while.
            if (man.squadId >= 0) {
              const q = this.squads.squads[man.squadId];
              q.noRideV = v.id; q.noRideUntil = time + 90;
              if (q.vehicle === v.id) q.vehicle = -1;
              this.relate(v, man, q, 'released', 'squad never made it aboard');
            }
            if (man.extracting && man.msg && this.radio.holds(man.msg, v.id, man.msgId)) this.radio.release(man.msg, 'squad never made it aboard');
            man.extracting = false;
            this.stats.boardFailed++;
            man.squadId = -1; man.setMode(VMode.PARKED, time); man.idleSince = time;
          }
        }
        return;
      }
      case VMode.TRANSIT: {
        if (aboard === 0) {
          // Everyone got out on the way (bailed out, or the squad was pulled off): the trip ends here.
          this.stats.interrupted++; man.lastTrip = 'passengers left on the way';
          if (man.squadId >= 0) {
            const q = this.squads.squads[man.squadId];
            q.transportFailT = time;
            // They got out early (bailed / pulled off): wait where we are in case they need us again.
            man.waitX = v.pos.x; man.waitZ = v.pos.z;
            this.relate(v, man, q, 'standby', 'passengers got out before the drop point');
            man.squadId = -1; man.setMode(VMode.HOLD, time); return;
          }
          man.squadId = -1; man.setMode(arch === A.TRUCK ? VMode.RETURN : arch === A.IFV ? VMode.SUPPORT : VMode.OVERWATCH, time); return;
        }
        this.superviseTransit(v, man, a, time);
        if (man.mode !== VMode.TRANSIT) return;
        this.drive(a, man.dismountX, man.dismountZ);
        a.arriveR = 5; // a delivery goes all the way (no settling short of the drop point)
        const dd = Math.hypot(man.dismountX - v.pos.x, man.dismountZ - v.pos.z);
        // Arrived (or wedged within 30 m of the drop point after repeated attempts: close enough to walk).
        if (dd < 12 || (dd < 30 && a.stuckRepeat >= 3)) {
          a.holdVehicle = true;
          if (v.speed < 3) { this.stats.delivered++; man.lastTrip = `delivered ${dd.toFixed(0)} m from the drop point`; man.setMode(VMode.DISMOUNT, time); }
        }
        return;
      }
      case VMode.DISMOUNT: {
        a.holdVehicle = true;
        const sid = man.squadId;
        this.dismountPassengers(v);
        if (sid >= 0) this.afterDrop(v, man, this.squads.squads[sid], time);
        else man.setMode(arch === A.TRUCK ? VMode.RETURN : arch === A.IFV ? VMode.SUPPORT : VMode.OVERWATCH, time);
        return;
      }
      case VMode.HOLD:
        if (man.supportState === 'standby') {
          // Waiting for the squad: out of the way, backing off if anti-tank fire finds us.
          this.drive(a, man.waitX, man.waitZ);
          a.holdVehicle = Math.hypot(man.waitX - v.pos.x, man.waitZ - v.pos.z) < 10;
          if (this.atThreatened(v)) { this.crewThreat(v, P2); this.backOff(v, a, P2[0], P2[1], 150); }
          return;
        }
        man.setMode(arch === A.TRUCK ? VMode.RETURN : VMode.OVERWATCH, time);
        return;
      case VMode.RETURN:
        this.goHome(v, man, a, time);
        return;
      case VMode.SUPPORT: {
        if (man.hasFire) {
          // Tasked by the commander: fight from the firing position (support by fire for the assault).
          this.drive(a, man.fireX, man.fireZ);
          a.holdVehicle = Math.hypot(man.fireX - v.pos.x, man.fireZ - v.pos.z) < 10;
          if (this.atThreatened(v)) { this.crewThreat(v, P2); this.backOff(v, a, P2[0], P2[1], 150); this.popSmoke(v); }
          return;
        }
        // IFV: stay with the squad it delivered (or the nearest friendly squad), on the threat side, behind it.
        const q = man.supports >= 0 && man.supportState === 'escort' ? this.squads.squads[man.supports] : this.nearestSquad(v);
        if (!q || !f) { man.setMode(VMode.OVERWATCH, time); return; }
        const hasC = q.contactCentroid(time, 10, P2) > 0;
        const tx = hasC ? P2[0] : f.x, tz = hasC ? P2[1] : f.z;
        let dx = tx - q.cx, dz = tz - q.cz;
        const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
        this.drive(a, q.cx - dx * 15 + dz * 8, q.cz - dz * 15 - dx * 8);
        a.holdVehicle = Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z) < 12;
        a.speedCap = Math.min(v.def.maxSpeed, 8);
        if (this.atThreatened(v)) { this.backOff(v, a, tx, tz, 140); this.popSmoke(v); }
        return;
      }
      case VMode.OVERWATCH:
      default: {
        if (!f) { a.holdVehicle = true; return; }
        if (arch === A.TRUCK) { man.setMode(VMode.RETURN, time); return; }
        this.standoffPoint(v, f, arch === A.APC ? 80 : 50, P2);
        if (man.hasFire) { P2[0] = man.fireX; P2[1] = man.fireZ; }
        this.drive(a, P2[0], P2[1]);
        a.holdVehicle = Math.hypot(P2[0] - v.pos.x, P2[1] - v.pos.z) < 12;
        if (this.atThreatened(v)) { this.crewThreat(v, P2); this.backOff(v, a, P2[0], P2[1], 150); this.popSmoke(v); }
        // Empty carriers return to pick up the next squad once the fight moves on.
        if (time - man.modeTime > 60 && v.def.passengers > 0 && !this.atThreatened(v)) man.setMode(VMode.RETURN, time);
      }
    }
  }

  /**
   * Departure: the destination is the passengers' squad goal at this moment
   * (assembly area, attack position or flag) and stays fixed for the trip;
   * the drop point is right at a safe destination, short of a flag the squad
   * has to fight for.
   */
  private startTransit(v: VehicleLike, man: VehicleManifest, time: number): void {
    const f = man.objective;
    const q = man.squadId >= 0 ? this.squads.squads[man.squadId] : null;
    if (q) this.relate(v, man, q, 'riding', man.extracting ? 'being pulled out' : 'on the way');
    const home = man.extracting && q ? this.squads.nearestFriendlyFlag(q) : null;
    if (home) { man.destX = home.x; man.destZ = home.z; }
    else if (q && squadGoal(q, P2) >= 0) { man.destX = P2[0]; man.destZ = P2[1]; }
    else if (q && q.objective) { man.destX = q.objective.x; man.destZ = q.objective.z; }
    else if (f) { man.destX = f.x; man.destZ = f.z; }
    else return;
    this.planDrop(v, man, time);
    man.destCheck = time; man.bestD = 1e9; man.bestAt = time; man.transitStart = time;
    if (v.driver && v.driver.ai) v.driver.ai.partialHops = 0;
    this.stats.trips++;
    man.setMode(VMode.TRANSIT, time);
  }

  /** Drop point for the current destination: right at it when the squad only has to get there, short of it when it has to fight. */
  private planDrop(v: VehicleLike, man: VehicleManifest, time: number): void {
    const q = man.squadId >= 0 ? this.squads.squads[man.squadId] : null;
    const safe = q !== null && (q.order === Order.HOLD || q.order === Order.SUPPORT || q.order === Order.MOVE || q.order === Order.DEFEND);
    this.computeDismount(v, man, man.destX, man.destZ, safe ? 12 : STANDOFF[man.archetype], time);
  }

  /**
   * Keeps a trip coherent: the destination changes only when the squad is
   * re-tasked (its goal moved), the drop point is re-planned around the same
   * destination on new contact or when it turns into a danger zone, and a
   * trip that stops making progress ends with a drop short of the goal
   * instead of circling forever. Partial paths are followed on, not taken as
   * arrival.
   */
  private superviseTransit(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    const q = man.squadId >= 0 ? this.squads.squads[man.squadId] : null;
    if (time - man.destCheck > 3) {
      man.destCheck = time;
      if (q && squadGoal(q, P2) >= 0 && (P2[0] - man.destX) ** 2 + (P2[1] - man.destZ) ** 2 > 50 * 50) {
        man.destX = P2[0]; man.destZ = P2[1];
        this.planDrop(v, man, time);
        man.bestD = 1e9; man.bestAt = time;
        this.stats.retasked++;
      } else if (this.radio.inDangerZone(v.team, man.dismountX, man.dismountZ, 15, time) >= 0 ||
        (q && time - man.modeTime > 8 && q.contactCentroid(time, 4, P2) > 0)) {
        this.computeDismount(v, man, man.destX, man.destZ, STANDOFF[man.archetype] + 20, time);
        man.modeTime = time;
      }
    }
    const d = Math.hypot(man.dismountX - v.pos.x, man.dismountZ - v.pos.z);
    if (d < man.bestD - 10) { man.bestD = d; man.bestAt = time; }
    // Forming up with a convoy (or its column waiting for a straggler) is waiting, not being blocked.
    const ci = this.squads.convoyOf[v.id];
    if (ci >= 0 && (this.squads.convoys[ci].state === 'assembling' || this.squads.convoys[ci].waitT > 0)) man.bestAt = time;
    // No progress for 40 s (blocked road, wrecks, a pocket the planner cannot get out of): drop here and let them walk.
    // A convoy waiting for its column is not stuck: it gets much longer.
    const limit = this.squads.convoyOf[v.id] >= 0 ? 60 : 40;
    if (time - man.bestAt > limit && v.speed < 2) {
      this.stats.blockedDrops++;
      if (man.squadId >= 0) this.squads.squads[man.squadId].transportFailT = time;
      // Remember the trap for 2 min: routes (this vehicle's next trip, and everyone else's) are planned around it
      // instead of driving into the same spot again.
      const nav = this.game.nav as any;
      if (nav.setDyn) nav.setDyn(200000 + v.id, v.pos.x + Math.sin(v.yaw) * (v.def.half[2] + 3), v.pos.z + Math.cos(v.yaw) * (v.def.half[2] + 3), v.yaw, v.def.half[0] + 2, 3.5, time + 120);
      this.blockedAt.push(Math.round(v.pos.x), Math.round(v.pos.z), Math.round(d));
      if (this.blockedAt.length > 60) this.blockedAt.splice(0, 3);
      man.lastTrip = `blocked ${d.toFixed(0)} m short of the drop point after ${(time - man.transitStart).toFixed(0)} s`;
      this.stats.partialHops += a.partialHops;
      man.setMode(VMode.DISMOUNT, time);
    }
  }

  /** Light armour facing AT: an enemy launcher within 120 m or heavy armour within 200 m. */
  private atThreatened(v: VehicleLike): boolean {
    for (let i = 0; i < v.seats.length; i++) {
      const o = v.seats[i], a = o && o.ai;
      if (!a || !a.target || !a.targetVisible) continue;
      const t = a.target, d = Math.hypot(t.pos.x - v.pos.x, t.pos.z - v.pos.z);
      if (t.kind === 'soldier' && t.launcher && d < 120) return true;
      if (t.kind === 'vehicle' && t.def.armor === 'heavy' && d < 200) return true;
    }
    return false;
  }

  private backOff(v: VehicleLike, a: AgentLike, tx: number, tz: number, dist: number): void {
    let dx = v.pos.x - tx, dz = v.pos.z - tz;
    const d = Math.hypot(dx, dz) || 1;
    if (d >= dist) return;
    dx /= d; dz /= d;
    this.drive(a, tx + dx * dist, tz + dz * dist);
    a.holdVehicle = false;
  }

  /** An AI soldier sits behind an anti-aircraft mount. */
  private aaManned(v: VehicleLike): boolean {
    for (let i = 0; i < v.def.mounts.length; i++) {
      if (!v.def.mounts[i].aa) continue;
      const o = v.seats[v.operatorSeat(i)];
      if (o && o.ai) return true;
    }
    return false;
  }

  private nearestSquadWithin(v: VehicleLike, r: number): SquadBlackboard | null {
    let best: SquadBlackboard | null = null, bd = r * r;
    for (let i = 0; i < this.squads.squads.length; i++) {
      const q = this.squads.squads[i];
      if (q.team !== v.team || q.kind !== SquadKind.INFANTRY || q.dismounted < 2) continue;
      const d = (q.cx - v.pos.x) ** 2 + (q.cz - v.pos.z) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  private nearestSquad(v: VehicleLike): SquadBlackboard | null {
    let best: SquadBlackboard | null = null, bd = 150 * 150;
    for (let i = 0; i < this.squads.squads.length; i++) {
      const q = this.squads.squads[i];
      if (q.team !== v.team || q.kind !== SquadKind.INFANTRY || q.dismounted < 2) continue;
      const d = (q.cx - v.pos.x) ** 2 + (q.cz - v.pos.z) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  /**
   * SUPPLY: mobile logistics node. Answers logistics tickets at a safe
   * rendezvous behind the requester; otherwise parks in defilade behind the
   * front (its aura re-arms and repairs: see VehicleSystem).
   */
  private ctlSupply(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    if (!man.msg || !this.radio.holds(man.msg, v.id, man.msgId)) {
      man.msg = this.take(v, man, RadioType.LOGISTICS_REQUEST, 450, time);
      if (man.msg) { man.msgId = man.msg.id; man.setMode(VMode.RESUPPLY, time); }
    }
    if (man.msg && man.mode === VMode.RESUPPLY) {
      const m = man.msg;
      // Rendezvous 20 m behind the requester, toward home.
      let dx = v.spawn.x - m.x, dz = v.spawn.z - m.z;
      const d = Math.hypot(dx, dz) || 1;
      this.drive(a, m.x + (dx / d) * 20, m.z + (dz / d) * 20);
      const there = Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z) < 10;
      a.holdVehicle = there;
      if (there && time - man.modeTime > 25) { this.radio.complete(m); man.msg = null; man.setMode(VMode.HOLD, time); }
      return;
    }
    const f = man.objective;
    if (!f) { a.holdVehicle = true; return; }
    this.standoffPoint(v, f, STANDOFF[A.SUPPLY], P2);
    this.drive(a, P2[0], P2[1]);
    a.holdVehicle = Math.hypot(P2[0] - v.pos.x, P2[1] - v.pos.z) < 12;
  }

  /**
   * MLRS / MOBILE HOWITZER: indirect fire from the rear on radio fire
   * missions (or contested flags), danger-close checked; the MLRS fires a
   * salvo then shoots-and-scoots, the howitzer walks rounds in on spotter
   * feedback and displaces after two missions.
   */
  private ctlArtillery(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    const mlrs = man.archetype === A.MLRS;
    const gunner = this.agentOfMount(v, 0);
    const w = v.weapons[0];
    if (man.mode === VMode.SCOOT) {
      this.drive(a, man.tx, man.tz);
      if (Math.hypot(man.tx - v.pos.x, man.tz - v.pos.z) < 10 || time - man.modeTime > 30) man.setMode(VMode.HOLD, time);
      return;
    }
    // Keep well back from the front.
    const f = man.objective;
    const df = f ? Math.hypot(f.x - v.pos.x, f.z - v.pos.z) : 0;
    if (f && df < 330 && man.mode !== VMode.FIRE) {
      this.standoffPoint(v, f, STANDOFF[man.archetype], P2);
      this.drive(a, P2[0], P2[1]);
      return;
    }
    // On the 2280 m map the front is often beyond the battery's reach from its park: displace forward to a
    // firing position ~55 % of range back from the front (never closer than 380 m), then wait for missions.
    if (f && df > w.def.range * 0.8 && man.mode !== VMode.FIRE && !(man.msg && this.radio.holds(man.msg, v.id, man.msgId))) {
      const back = Math.max(380, w.def.range * 0.55);
      const dx = v.pos.x - f.x, dz = v.pos.z - f.z, d = Math.hypot(dx, dz) || 1;
      let px = f.x + (dx / d) * back, pz = f.z + (dz / d) * back;
      if (this.game.nav.blocked(px, pz, true)) { px = f.x + (dx / d) * (back + 60); pz = f.z + (dz / d) * (back + 60); }
      man.fireWhy = `displacing forward: the front is ${df.toFixed(0)} m away, beyond reach`;
      this.drive(a, px, pz);
      return;
    }
    a.holdVehicle = true;
    // Launchers with limited traverse (the MLRS: ±46° either side of the cab) and a minimum elevation can only
    // engage what lies in front of the hull and beyond a minimum range: missions are taken only where they can
    // be fired, and the vehicle turns to bring the launcher to bear before it can fire.
    const m0 = v.def.mounts[0] as any;
    const limited = m0 && m0.yawMin !== undefined;
    const g0 = w.def.gravity || 9.81, sp = w.def.speed || 100;
    const minR = m0 && m0.pitchMin > 0 ? (sp * sp * Math.sin(2 * m0.pitchMin)) / g0 + 15 : 0;
    if ((!man.msg || !this.radio.holds(man.msg, v.id, man.msgId)) && time > man.waitUntil) {
      if (!gunner) man.fireWhy = 'no gunner or driver to operate the launcher';
      else if (w.ammo <= 0 && w.reloading) man.fireWhy = 'reloading';
      else {
        man.msg = this.take(v, man, RadioType.FIRE_MISSION, w.def.range * 0.95, time, minR);
        if (man.msg) { man.msgId = man.msg.id; man.missionErr = man.msg.lased ? 10 : 25; man.missionShots = 0; man.setMode(VMode.FIRE, time); man.fireTurnT = 0; }
        else man.fireWhy = minR > 0 ? `no fire mission open between ${minR.toFixed(0)} and ${(w.def.range * 0.95).toFixed(0)} m` : 'no fire mission open in range';
      }
    }
    if (!man.msg || man.mode !== VMode.FIRE || !gunner) {
      // Ready for the next mission: face the front (a launcher that faces away cannot fire at all).
      const f = man.objective;
      if (limited && f) { const brg = Math.atan2(f.x - v.pos.x, f.z - v.pos.z); if (Math.abs(wrapPi(brg - v.yaw)) > 0.6) a.faceYaw = brg; }
      return;
    }
    const m = man.msg;
    if (limited) {
      const brg = Math.atan2(m.x - v.pos.x, m.z - v.pos.z), rel = wrapPi(brg - v.yaw);
      if (Math.abs(rel) > m0.yawMax - 0.08) {
        a.faceYaw = brg;
        if (man.fireTurnT === 0) { man.fireTurnT = time; this.stats.fireTurns++; }
        man.fireWhy = `turning to bring the launcher to bear (${Math.round(Math.abs(rel) * 57)}° off, traverse ±${Math.round(m0.yawMax * 57)}°)`;
        this.radio.extend(m, time, 90, 'battery turning to bear');
        // Could not turn within 40 s (boxed in): hand the mission back for another battery.
        if (time - man.fireTurnT > 40) { this.stats.fireTurnFails++; this.radio.release(m, 'launcher could not be brought to bear'); man.msg = null; man.setMode(VMode.HOLD, time); gunner.artyUntil = 0; man.waitUntil = time + 6; man.fireWhy = 'could not turn to bear; mission handed back'; }
        return;
      }
    }
    man.fireWhy = 'firing';
    this.radio.extend(m, time, 90, 'battery firing');
    // Danger close: abort if friendlies are inside the beaten zone.
    const radius = (w.def.radius || 10) * 1.6;
    // Danger close: friendlies (usually the squad that called it) are inside the beaten zone. Walk the aim point
    // beyond the enemy, away from them (up to 40 m); only if that is still unsafe is the mission turned down.
    let ax = m.x, az = m.z;
    // Heavy rockets carry their own (larger) friendly safety buffer.
    const safe = Math.max(radius + man.missionErr, (w.def as any).dangerClose || 0);
    if (this.friendliesNear(v.team, ax, az, safe) > 0) {
      let fx = 0, fz = 0, n = 0;
      const k = this.grid.queryRadius(ax, az, safe + 30, IDS, 0, this.S);
      for (let i = 0; i < k; i++) { const s = this.game.soldiers[IDS[i]]; if (s.alive && s.team === v.team) { fx += s.pos.x; fz += s.pos.z; n++; } }
      if (n) {
        fx /= n; fz /= n;
        let dx = ax - fx, dz = az - fz; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
        for (let shift = 10; shift <= 40; shift += 10) {
          if (this.friendliesNear(v.team, m.x + dx * shift, m.z + dz * shift, safe) === 0) { ax = m.x + dx * shift; az = m.z + dz * shift; this.stats.fireShifted++; break; }
        }
      }
      if (ax === m.x && az === m.z) {
        this.stats.fireAborts++; man.fireWhy = 'turned down: friendlies inside the beaten zone';
        // Turned down: friendlies too close to the target. The ticket lapses so the requester knows it was not fired.
        this.radio.callOff(m, 'friendlies inside the beaten zone', time); man.msg = null; man.setMode(VMode.HOLD, time); gunner.artyUntil = 0; man.waitUntil = time + 4; return;
      }
    }
    // Spotter feedback narrows the spread on each salvo while the request keeps being refreshed.
    const shots = w.shot;
    if (shots !== man.shotsAtMove) {
      man.shotsAtMove = shots; man.missionShots++;
      if (!mlrs && time - m.time < 6 && m.expires - time > 20) man.missionErr = Math.max(4, man.missionErr * 0.65);
    }
    const ang = hash01(m.id, man.missionShots) * Math.PI * 2, r = man.missionErr * hash01(man.missionShots, m.id);
    gunner.artyX = ax + Math.cos(ang) * r; gunner.artyZ = az + Math.sin(ang) * r; gunner.artyY = this.game.map.terrain.height(ax, az);
    gunner.artyUntil = time + 1;
    gunner.artySpread = man.missionErr;
    this.radio.addDangerZone(v.team, ax, az, radius, time + 14, time);
    const done = mlrs ? man.missionShots >= 12 || (w.ammo <= 0 && w.reloading) : man.missionShots >= 6;
    if (done) {
      this.radio.complete(m, `fire mission fired (${man.missionShots} rounds)`); man.msg = null; gunner.artyUntil = 0; man.missions++;
      if (man.missions % (mlrs ? 2 : 3) === 0) {
        // Displace to dodge counter-battery fire.
        const id = v.driver ? v.driver.id : 0;
        const away = Math.atan2(v.pos.x - m.x, v.pos.z - m.z) + (rand(this.st.rng, id) - 0.5) * 1.6;
        const dist = 90 + rand(this.st.rng, id) * 40;
        man.tx = v.pos.x + Math.sin(away) * dist; man.tz = v.pos.z + Math.cos(away) * dist;
        if (!this.game.map.terrain.inBounds(man.tx, man.tz, 40)) { man.tx = v.pos.x - Math.sin(away) * dist; man.tz = v.pos.z - Math.cos(away) * dist; }
        man.setMode(VMode.SCOOT, time);
      } else man.setMode(VMode.HOLD, time);
    }
  }

  /**
   * MOBILE SAM: radar emission discipline (short bursts, lit on air-threat
   * reports), prefers jets and high gunships (perception priorities), and
   * displaces with the radar dark after firing.
   */
  private ctlSAM(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    const id = v.driver ? v.driver.id : 0;
    if (man.mode === VMode.SCOOT) {
      man.radarOn = false;
      this.drive(a, man.tx, man.tz);
      if (Math.hypot(man.tx - v.pos.x, man.tz - v.pos.z) < 10 || time - man.modeTime > 25) man.setMode(VMode.HOLD, time);
    } else {
      if (time > man.radarUntil && time > man.radarToggleAt) {
        man.radarOn = !man.radarOn;
        man.radarToggleAt = time + (man.radarOn ? 6 : 10) + rand(this.st.rng, id) * 4;
      }
      if (time < man.radarUntil) man.radarOn = true;
      const f = man.objective;
      if (f) { this.standoffPoint(v, f, STANDOFF[A.SAM], P2); this.drive(a, P2[0], P2[1]); a.holdVehicle = Math.hypot(P2[0] - v.pos.x, P2[1] - v.pos.z) < 12; }
      else a.holdVehicle = true;
      const sam = v.weapons.length > 1 ? v.weapons[1].shot : 0;
      if (sam - man.shotsAtMove >= 2) {
        man.shotsAtMove = sam;
        const ang = rand(this.st.rng, id) * Math.PI * 2;
        man.tx = v.pos.x + Math.cos(ang) * 80; man.tz = v.pos.z + Math.sin(ang) * 80;
        if (!this.game.map.terrain.inBounds(man.tx, man.tz, 40)) { man.tx = v.pos.x - Math.cos(ang) * 80; man.tz = v.pos.z - Math.sin(ang) * 80; }
        man.setMode(VMode.SCOOT, time);
      }
    }
    v.radarOn = man.radarOn;
  }

  /**
   * SPAAG: SHORAD / convoy escort. Rides in convoys as the air umbrella,
   * otherwise shadows the nearest friendly armour; perception priorities
   * favour low helicopters and strafing jets and fall back to ground targets.
   */
  private ctlSPAAG(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    v.radarOn = true;
    if (this.squads.convoyOf[v.id] >= 0) return;
    const list = this.game.vehicles.list;
    let best: VehicleLike | null = null, bd = 220 * 220;
    for (let i = 0; i < list.length; i++) {
      const o = list[i], arch = this.manifests[i].archetype;
      if (o === v || !o.alive || !o.occupied || o.team !== v.team || (arch !== A.MBT && arch !== A.HT && arch !== A.IFV)) continue;
      const d = (o.pos.x - v.pos.x) ** 2 + (o.pos.z - v.pos.z) ** 2;
      if (d < bd) { bd = d; best = o; }
    }
    if (best) {
      const h = best.yaw;
      this.drive(a, best.pos.x - Math.sin(h) * 25, best.pos.z - Math.cos(h) * 25);
      a.holdVehicle = Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z) < 10;
      man.setMode(VMode.SUPPORT, time);
      return;
    }
    man.setMode(VMode.OVERWATCH, time);
    const f = man.objective;
    if (!f) { a.holdVehicle = true; return; }
    this.standoffPoint(v, f, STANDOFF[A.SPAAG], P2);
    this.drive(a, P2[0], P2[1]);
    a.holdVehicle = Math.hypot(P2[0] - v.pos.x, P2[1] - v.pos.z) < 12;
    void time;
  }

  /**
   * ATTACK HELICOPTER: nap-of-the-earth hunter-killer. Hides low behind a
   * terrain mask, pops up to fire on CAS-designated (or visible) armour, drops
   * back down; flares and descends when a missile is launched at it.
   */
  private ctlAttackHeli(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    const crit = v.health / v.def.health < 0.3;
    a.heliLand = false;
    if (crit) {
      // Too damaged to stay: any accepted strike goes back to the pool for another aircraft.
      if (man.msg && this.radio.holds(man.msg, v.id, man.msgId)) this.radio.release(man.msg, 'gunship damaged, returning to base');
      man.msg = null;
      a.heliLand = true; this.drive(a, v.spawn.x, v.spawn.z); a.heliTransit = true; return;
    }
    if (!man.msg || !this.radio.holds(man.msg, v.id, man.msgId)) {
      man.msg = this.take(v, man, RadioType.CAS_REQUEST, 1150, time);
      if (man.msg) { man.msgId = man.msg.id; man.hasPoint = false; man.casFired = 0; man.casPasses = 0; man.casShots = this.shotsFired(v); }
    }
    let tx: number, tz: number, ty: number;
    if (man.msg) {
      const m = man.msg;
      tx = m.x; tz = m.z; ty = m.y;
      if (m.targetIdx >= 0 && v.seats[0]) this.engine.cue(v.seats[0].id, m.targetIdx, tx, ty, tz);
      // Executed: the target is destroyed, or two attack passes were flown with weapons fired into the area,
      // or four pop-ups found nothing to shoot at the mark (reported as such).
      if (m.targetIdx >= 0 && !this.engine.entity(m.targetIdx).alive) { this.radio.complete(m, 'target destroyed'); man.msg = null; }
      else if (man.casFired >= 2) { this.radio.complete(m, 'attack passes flown on the target area'); man.msg = null; }
      else if (man.casPasses >= 4) { this.radio.complete(m, 'searched the mark: no target found'); man.msg = null; }
      else if (!this.radio.extend(m, time, 150, man.mode === VMode.POPUP ? 'gunship attacking' : man.mode === VMode.HIDE ? 'gunship in position' : 'gunship en route')) {
        // Could not finish within the time cap: hand it back with the reason rather than hold it forever.
        this.radio.release(m, 'gunship could not finish in time'); man.msg = null; man.evadeUntil = time + 20;
      }
    }
    if (man.msg) {
      tx = man.msg.x; tz = man.msg.z; ty = man.msg.y;
    } else if (man.objective) {
      tx = man.objective.x; tz = man.objective.z; ty = man.objective.y;
      // No strike to fly and our troops are contesting the objective: a low, fast fly-by (20–30 m) over it now
      // and then (shock and suppression on the defenders, see flybyShock), from the hide and back.
      const o = man.objective;
      if (o.owner !== v.team && o.contestedBy === v.team && v.health > v.def.health * 0.6 && time - (man.flybyT || 0) > 50) {
        man.flybyT = time; man.flybyUntil = time + 14; this.stats.flybys++;
      }
      if (time < (man.flybyUntil || 0)) {
        const dx = tx - man.hideX, dz = tz - man.hideZ, d = Math.hypot(dx, dz) || 1;
        a.heliAlt = 24; a.heliTransit = true;
        this.drive(a, tx + (dx / d) * 160, tz + (dz / d) * 160);
        return;
      }
    }
    else { a.heliAlt = 30; this.drive(a, v.spawn.x, v.spawn.z); return; }
    if (!man.hasPoint || time - man.modeTime > 30 || Math.hypot(man.tx - tx, man.tz - tz) > 60) {
      this.pickHide(v, man, tx, ty, tz, time);
      man.tx = tx; man.tz = tz; man.hasPoint = true;
      man.setMode(VMode.TRANSIT, time);
    }
    const evading = time < man.evadeUntil;
    switch (man.mode) {
      case VMode.TRANSIT:
        // Nap-of-the-earth ingress (15–35 m AGL).
        a.heliAlt = 25; a.heliTransit = true;
        this.drive(a, man.hideX, man.hideZ);
        if (Math.hypot(man.hideX - v.pos.x, man.hideZ - v.pos.z) < 25) man.setMode(VMode.HIDE, time);
        break;
      case VMode.HIDE:
        a.heliAlt = 15; a.heliTransit = true;
        this.drive(a, man.hideX, man.hideZ);
        if (time - man.modeTime > 5 && !evading) man.setMode(VMode.POPUP, time);
        break;
      case VMode.POPUP:
        // Pop up (60–90 m), point at the target area and let the gunner / pilot fire (rocket passes dive from here).
        a.heliAlt = 70; a.heliTransit = true;
        this.drive(a, man.hideX + (tx - man.hideX) * 0.08, man.hideZ + (tz - man.hideZ) * 0.08);
        if (time - man.modeTime > 7 || evading) {
          man.setMode(VMode.HIDE, time); man.passes++;
          if (man.msg) { man.casPasses++; const sh = this.shotsFired(v); if (sh > man.casShots) man.casFired++; man.casShots = sh; }
          if (man.passes % 3 === 0) this.pickHide(v, man, tx, ty, tz, time);
        }
        break;
      default: man.setMode(VMode.TRANSIT, time);
    }
    if (evading) a.heliAlt = 8;
  }

  /** Hide position 220–300 m from the target with terrain masking (≤ 2 raycasts). */
  private pickHide(v: VehicleLike, man: VehicleManifest, tx: number, ty: number, tz: number, time: number): void {
    const terrain = this.game.map.terrain;
    const base = Math.atan2(v.pos.x - tx, v.pos.z - tz);
    let bestX = tx + Math.sin(base) * 260, bestZ = tz + Math.cos(base) * 260, found = false;
    for (let k = 0; k < 4 && !found; k++) {
      const ang = base + (k - 1.5) * 0.45 + (hash01(v.id, (time | 0) + k) - 0.5) * 0.2, r = 220 + k * 25;
      const x = tx + Math.sin(ang) * r, z = tz + Math.cos(ang) * r;
      if (!terrain.inBounds(x, z, 20)) continue;
      if (k < 2) {
        const masked = !this.game.physics.losClear(tx, ty + 2, tz, x, Math.max(terrain.height(x, z), 0) + 12, z);
        if (masked) { bestX = x; bestZ = z; found = true; }
      } else if (!found) { bestX = x; bestZ = z; }
    }
    man.hideX = bestX; man.hideZ = bestZ;
  }

  /**
   * TRANSPORT HELICOPTER: air assault. Loads a squad at the pad (or answers
   * an extraction request), flies a low ingress corridor offset from known
   * air defences, pops flares on approach, lands at a safe LZ, unloads and
   * extracts immediately back to the pad.
   */
  private ctlTransportHeli(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    const aboard = this.passengersAboard(v, man) + this.carriedGunners(v, man);
    a.heliLand = false; a.heliHover = false;
    if (man.mode !== VMode.ROPE) v.ropes = false;
    switch (man.mode) {
      case VMode.PARKED: case VMode.BOARDING: {
        if (man.mode === VMode.BOARDING) v.holdDoors();
        a.heliLand = true; this.drive(a, v.pos.x, v.pos.z);
        // AirInsertionBlackboard: no take-off until every living soldier on the manifest is aboard, or 12 s after
        // the first of them got in (the boarding window caps the whole wait).
        if (man.mode === VMode.BOARDING && aboard > 0 && man.boardFirstT <= 0) man.boardFirstT = time;
        if (man.mode !== VMode.BOARDING) man.boardFirstT = 0;
        const ready = man.reserved > 0 && aboard > 0 && (this.pendingPassengerTickets(man) === 0 || time - man.boardFirstT > 12);
        if (man.mode === VMode.BOARDING && (ready || time > man.waitUntil)) {
          man.boardFirstT = 0; man.waved = false;
          for (let i = 0; i < man.ticket.length; i++) if (man.ticket[i] >= 0 && CARGO[man.seatRole[i]]) this.releaseTicket(man.ticket[i]);
          if (aboard > 0) {
            const q = man.squadId >= 0 ? this.squads.squads[man.squadId] : null;
            const f = q && q.objective ? q.objective : man.objective;
            if (man.insertSquad >= 0) { man.dismountX = man.dropX; man.dismountZ = man.dropZ; }
            else if (man.msg && this.radio.holds(man.msg, v.id, man.msgId)) {
              // Extraction pick-up done: fly them home.
              this.radio.complete(man.msg); man.msg = null;
              man.dismountX = v.spawn.x + 30; man.dismountZ = v.spawn.z + 30;
            } else if (f) this.computeDismount(v, man, f.x, f.z, 70, time);
            man.setMode(VMode.TRANSIT, time);
          } else { man.squadId = -1; man.insertSquad = -1; man.setMode(VMode.PARKED, time); man.idleSince = time; }
        }
        if (man.mode === VMode.PARKED && man.insertSquad < 0 && time - man.idleSince > 20) {
          man.msg = this.take(v, man, RadioType.EXTRACT_REQUEST, 1800, time);
          if (man.msg) { man.msgId = man.msg.id; man.dismountX = man.msg.x; man.dismountZ = man.msg.z; man.setMode(VMode.EGRESS, time); }
        }
        return;
      }
      case VMode.EGRESS: {
        // Flying out to an extraction LZ (the squad waiting there marks it).
        a.heliAlt = 25; a.heliTransit = true;
        this.drive(a, man.dismountX, man.dismountZ);
        if (!man.lzMarked && Math.hypot(man.dismountX - v.pos.x, man.dismountZ - v.pos.z) < 320) { man.lzMarked = true; this.markLz(man.dismountX, man.dismountZ, time); }
        if (Math.hypot(man.dismountX - v.pos.x, man.dismountZ - v.pos.z) < 40) { man.setMode(VMode.LAND, time); man.tx = 1; }
        return;
      }
      case VMode.TRANSIT: {
        const para = man.insertSquad >= 0 && man.insertMethod === Insert.PARA;
        // Paradrops cross the zone high and fast; everything else comes in low (nap of the earth).
        a.heliAlt = para ? 115 : 25; a.heliTransit = true;
        this.corridor(v, man.dismountX, man.dismountZ, P2);
        this.drive(a, P2[0], P2[1]);
        const d = Math.hypot(man.dismountX - v.pos.x, man.dismountZ - v.pos.z);
        if (d < 300 && d > 120) this.flares(v, time);
        // Hot LZ (purpose gate, Q3): the zone has filled with enemies, or we are taking fire on the approach:
        // wave off once to a secondary LZ 150–250 m away on the side away from the threat.
        if (!para && d < 450 && d > 60 && !man.waved) {
          const hot = this.contactsNear(v.team, man.dismountX, man.dismountZ, 80, time);
          if (hot >= 3 || man.damageRate > v.def.health * 0.05 || this.crewThreat(v, T2) >= 2.5) {
            man.waved = true;
            if (this.secondaryLz(v, man, P2)) {
              man.dismountX = P2[0]; man.dismountZ = P2[1];
              if (man.insertSquad >= 0) { man.dropX = P2[0]; man.dropZ = P2[1]; }
              this.stats.waveOffs++; man.lzMarked = false;
            }
          }
        }
        // The LZ is marked for the pilot: coloured smoke by day, red flares at night / in fog (visual only).
        if (!para && d < 320 && !man.lzMarked) { man.lzMarked = true; this.markLz(man.dismountX, man.dismountZ, time); }
        if (para && d < 220 && v.altitude < 70) {
          // Too low for the jump: open out from the zone while climbing, then run in again.
          const ax = (v.pos.x - man.dismountX) / (d || 1), az = (v.pos.z - man.dismountZ) / (d || 1);
          this.drive(a, man.dismountX + ax * 300, man.dismountZ + az * 300);
        } else if (para && d < 95) {
          // Run in over the drop zone and keep going: jumpers spread along the line.
          const dx = (man.dismountX - v.pos.x) / (d || 1), dz = (man.dismountZ - v.pos.z) / (d || 1);
          man.tx = man.dismountX + dx * 320; man.tz = man.dismountZ + dz * 320;
          man.nextDrop = time; man.setMode(VMode.PARA, time);
        } else if (man.insertSquad >= 0 && man.insertMethod === Insert.ROPE && d < 45) { man.nextDrop = time + 1.5; man.setMode(VMode.ROPE, time); }
        else if (!para && d < 40) { man.setMode(VMode.LAND, time); man.tx = 0; }
        return;
      }
      case VMode.ROPE: {
        // Fast-rope: hover over the drop point at rope height; one soldier down each rope at a time.
        a.heliHover = true; a.heliAlt = 13; a.heliTransit = false;
        this.drive(a, man.dropX, man.dropZ);
        const h = Math.hypot(man.dropX - v.pos.x, man.dropZ - v.pos.z);
        const steady = h < 7 && v.airspeed < 4 && v.altitude > 7 && v.altitude < 19;
        v.ropes = steady || (v.ropes && v.altitude < 22);
        if (steady && time > man.nextDrop && aboard > 0) { this.dropOne(v, man, true); man.nextDrop = time + 0.55; }
        if (aboard === 0 || time - man.modeTime > 40) { if (aboard > 0) this.dismountPassengers(v); this.finishInsertion(v, man, time); this.stats.dismounts++; }
        if (time < man.evadeUntil) this.flares(v, time);
        return;
      }
      case VMode.PARA: {
        a.heliAlt = 115; a.heliTransit = true;
        this.drive(a, man.tx, man.tz);
        if (time > man.nextDrop && aboard > 0) { this.dropOne(v, man, false); man.nextDrop = time + 0.3; }
        if (aboard === 0) { this.finishInsertion(v, man, time); this.stats.dismounts++; }
        return;
      }
      case VMode.LAND:
        a.heliLand = true; this.drive(a, man.dismountX, man.dismountZ);
        if (a.landed) {
          if (man.tx === 1 && (man.msg || man.fieldPickup)) {
            // Extraction (the requesting squad) or a field pick-up for an air assault (the inserting squad): board it.
            const q = this.squads.squads[man.msg ? man.msg.senderSquad : man.insertSquad];
            man.fieldPickup = false;
            if (q && q.alive > 0) {
              man.squadId = q.id; man.reserved = 0;
              for (let i = 0; i < q.count; i++) this.reservePassenger(this.game.soldiers[q.members[i]], v, man, q, time);
              q.vehicle = v.id; q.posture = Posture.MOUNTED;
            }
            // Wait long enough for the squad to cover the distance to the LZ (12 s was shorter than the walk).
            const walk = q ? Math.hypot(q.cx - v.pos.x, q.cz - v.pos.z) / 3.5 : 0;
            man.waitUntil = time + Math.min(45, 12 + walk);
            man.setMode(VMode.BOARDING, time);
          } else man.setMode(VMode.UNLOAD, time);
        } else if (time - man.modeTime > 25) man.setMode(VMode.RETURN, time);
        return;
      case VMode.UNLOAD:
        a.heliLand = true;
        if (aboard > 0) this.dismountPassengers(v);
        if (aboard === 0 || time - man.modeTime > 8) { if (man.insertSquad >= 0) this.finishInsertion(v, man, time); else man.setMode(VMode.RETURN, time); }
        return;
      case VMode.RETURN:
        a.heliAlt = 30; a.heliTransit = true;
        this.drive(a, v.spawn.x, v.spawn.z);
        if (Math.hypot(v.spawn.x - v.pos.x, v.spawn.z - v.pos.z) < 25) { a.heliLand = true; if (a.landed) { man.setMode(VMode.PARKED, time); man.idleSince = time; } }
        return;
      default: man.setMode(VMode.PARKED, time);
    }
  }

  /** Ingress waypoint offset sideways away from known enemy air defence along the route. */
  private corridor(v: VehicleLike, x: number, z: number, out: Float32Array): void {
    out[0] = x; out[1] = z;
    const list = this.game.vehicles.list;
    let dx = x - v.pos.x, dz = z - v.pos.z;
    const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    for (let i = 0; i < list.length; i++) {
      const o = list[i], arch = this.manifests[i].archetype;
      if (!o.alive || !o.occupied || o.team === v.team || (arch !== A.SAM && arch !== A.SPAAG)) continue;
      // Distance of the AA site from the route line; push the waypoint away from it.
      const px = o.pos.x - v.pos.x, pz = o.pos.z - v.pos.z, along = px * dx + pz * dz;
      if (along < 0 || along > d) continue;
      const lat = px * -dz + pz * dx;
      if (Math.abs(lat) > 250) continue;
      const push = (250 - Math.abs(lat)) * (lat > 0 ? -1 : 1);
      out[0] = v.pos.x + dx * Math.min(along, d * 0.6) + -dz * push;
      out[1] = v.pos.z + dz * Math.min(along, d * 0.6) + dx * push;
      return;
    }
  }

  /**
   * TRANSPORT AIRCRAFT (Il-112V). Jobs come from the situation, not a script:
   *  - paratroop / air-landed lift: the theater commander books it like a transport helicopter (requestInsertion)
   *    for far or offshore objectives; it waits for the stick to board at its stand, picks up an idle light vehicle
   *    for the drop when one is parked nearby, takes off, flies a run-in track over the drop zone at jump height
   *    and drops the vehicle and then the jumpers along it; for an air-landed lift it lands on the airstrip by the
   *    objective, unloads and flies home;
   *  - supply airdrop: idle on the ground, it takes an ammunition request that no truck has answered and is far from
   *    the base, and drops a pallet that becomes a resupply point;
   *  - afterwards it lands on the nearest runway its side can use and taxis to its stand.
   */
  private ctlTransportPlane(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    const aboard = this.passengersAboard(v, man) + this.carriedGunners(v, man);
    const list = this.game.vehicles.list as any[];
    a.jetHold = false;
    const startRun = (x: number, z: number) => {
      man.dismountX = x; man.dismountZ = z; man.runIn = false;
      // Run-in track: from where the aircraft is toward the drop zone (fixed for the whole run).
      const dx = x - v.pos.x, dz = z - v.pos.z, d = Math.hypot(dx, dz) || 1;
      man.runUX = dx / d; man.runUZ = dz / d;
      a.landRw = null; a.landPhase = ''; a.landed = false;
      man.setMode(VMode.TRANSIT, time);
    };
    switch (man.mode) {
      case VMode.PARKED: case VMode.BOARDING: {
        a.jetHold = true; a.landRw = null; a.jetMode = 0;
        if (man.mode === VMode.BOARDING) {
          // A light vehicle rides along on paradrops: the squad's own light vehicle if it has one, else an idle
          // one nearby. One of the stick drives it over to the ramp and up into the hold.
          if (man.insertMethod === Insert.PARA && (v.def as any).cargoVehicles && man.cargoV < 0 && !man.cargoTried) {
            man.cargoTried = true;
            const q = man.insertSquad >= 0 ? this.squads.squads[man.insertSquad] : null;
            const team = v.occupied ? v.team : v.spawn.team;
            const LIGHT = (t: string) => t === 'uaz' || t === 'tigr' || t === 'jeep';
            let pick = -1, bd = 700 * 700;
            if (q && q.transport >= 0) { const o = list[q.transport]; if (o && o.alive && !o.cargoOf && LIGHT(o.def.type) && !(o.occupied && !o.seats[0]?.ai)) pick = q.transport; }
            if (pick < 0) for (let i = 0; i < list.length; i++) {
              const o = list[i];
              if (o === v || !o.alive || o.occupied || o.cargoOf || this.locked[i] || !LIGHT(o.def.type) || o.spawn.team !== team || this.manifests[i].mode !== VMode.PARKED) continue;
              const d = (o.pos.x - v.pos.x) ** 2 + (o.pos.z - v.pos.z) ** 2;
              if (d < bd) { bd = d; pick = i; }
            }
            if (pick >= 0 && q) {
              const o = list[pick], om = this.manifests[pick];
              // A driver from the stick (not the leader): his seat in the aircraft is given up for the wheel.
              let drv: SoldierLike | null = o.seats[0] && o.seats[0].ai ? o.seats[0] : null;
              if (!drv) for (let k = q.count - 1; k >= 0 && !drv; k--) {
                const s2 = this.game.soldiers[q.members[k]];
                if (!s2.alive || s2.vehicle || s2.isPlayer || q.members[k] === q.leader) continue;
                const ti = this.st.ticket[s2.id];
                if (ti >= 0) this.releaseTicket(ti);
                if (this.reserve(s2, o, 0, q.id, time) >= 0) drv = s2;
              }
              if (drv) { om.loadInto = v.id; man.cargoV = pick; this.stats.planeCargoLoads++; }
            }
          }
          // First the aircraft taxis out to its loading point at the head of the runway (the stick and its vehicle
          // come to it there); then the ramp comes down.
          if (!man.loadReady) {
            if (!man.loadQ) man.loadQ = this.loadingRoute(v);
            const tq = man.loadQ;
            if (tq && tq.length && (v as any).grounded > 0) {
              a.jetHold = false; a.landRw = this.homeRunway(v); a.landPhase = 'taxi';
              a.taxiX = tq[0].x; a.taxiZ = tq[0].z;
              if (a.landed || Math.hypot(tq[0].x - v.pos.x, tq[0].z - v.pos.z) < 9) { tq.shift(); a.landed = false; }
              man.waitUntil = Math.max(man.waitUntil, time + 60);
              return;
            }
            man.loadReady = true; a.landRw = null; a.landPhase = ''; a.landed = false;
            // Brakes on, lined up on the centreline facing down the runway (the tug squares it up).
            const rw = this.homeRunway(v);
            if (rw) {
              const al = (v.pos.x - rw.x0) * rw.dx + (v.pos.z - rw.z0) * rw.dz, la = (v.pos.x - rw.x0) * -rw.dz + (v.pos.z - rw.z0) * rw.dx;
              if (Math.abs(la) < 15) (v as any).towTo?.(rw.x0 + rw.dx * al, rw.z0 + rw.dz * al, rw.yaw);
            }
            man.waitUntil = Math.max(man.waitUntil, time + 75);
            // The stick is called to the ramp.
            const q = man.insertSquad >= 0 ? this.squads.squads[man.insertSquad] : null;
            if (q) { (this.game.vehicles as any).rampFoot(v, P3V); q.destX = P3V.x; q.destZ = P3V.z; q.destR = 8; }
          }
          // Ramp down for the stick to walk up (and a vehicle to drive up).
          (v as any).holdDoors(2.5);
          if (aboard > 0 && man.boardFirstT <= 0) man.boardFirstT = time;
          // The vehicle must be in the hold (it drives over and up the ramp) before the ramp closes.
          const cargoIn = man.cargoV < 0 || (!!list[man.cargoV].cargoOf && !list[man.cargoV].loading) || !list[man.cargoV].alive;
          const ready = man.reserved > 0 && aboard > 0 && (this.pendingPassengerTickets(man) === 0 || time - man.boardFirstT > 15) && cargoIn;
          if (ready || (time > man.waitUntil && cargoIn) || time > man.waitUntil + 60) {
            man.boardFirstT = 0;
            for (let i = 0; i < man.ticket.length; i++) if (man.ticket[i] >= 0 && CARGO[man.seatRole[i]]) this.releaseTicket(man.ticket[i]);
            man.loadQ = null; man.loadReady = false; (man as any).cargoTried = false;
            if (man.cargoV >= 0 && !list[man.cargoV].cargoOf) { const om = this.manifests[man.cargoV]; om.loadInto = -1; this.lock(list[man.cargoV], false); man.cargoV = -1; }
            if (aboard > 0) { man.planeJob = man.insertMethod === Insert.LAND ? 'airland' : 'para'; startRun(man.dropX, man.dropZ); this.stats.planeLifts++; }
            else { man.squadId = -1; man.insertSquad = -1; man.planeJob = ''; man.setMode(VMode.PARKED, time); man.idleSince = time; }
          }
          return;
        }
        // Idle: an unanswered ammunition request far from the base gets an airdrop.
        if (!man.planeJob && man.insertSquad < 0 && time - man.idleSince > 20 && time > man.waitUntil) {
          const m = this.take(v, man, RadioType.LOGISTICS_REQUEST, 2600, time);
          if (m) {
            if (time - m.time < 20 || Math.hypot(m.x - v.pos.x, m.z - v.pos.z) < 650) { this.radio.release(m, 'a truck is closer'); man.waitUntil = time + 15; }
            else { man.msg = m; man.msgId = m.id; man.planeJob = 'supply'; startRun(m.x, m.z); this.stats.planeSupplyRuns++; }
          } else man.waitUntil = time + 10;
        }
        return;
      }
      case VMode.TRANSIT: {
        if (man.planeJob === 'airland') {
          const rw = this.usableRunway(v.team, man.dismountX, man.dismountZ, 600);
          if (!rw) { man.planeJob = 'para'; man.insertMethod = Insert.PARA; return; }
          if (!a.landRw) { const mid = { x: (rw.x0 + rw.x1) / 2, z: (rw.z0 + rw.z1) / 2 }; a.landRw = this.landingOn(rw, mid.x, mid.z); a.landPhase = ''; a.taxiX = mid.x; a.taxiZ = mid.z; }
          if (a.landed) { a.landed = false; man.setMode(VMode.UNLOAD, time); }
          return;
        }
        // Run-in track: from 900 m short of the drop zone along the line from the base, at jump / drop height.
        const ux = man.runUX, uz = man.runUZ, half = this.game.map.terrain.half - 200;
        const runD = 900;
        const rx = clamp(man.dismountX - ux * runD, -half, half), rz = clamp(man.dismountZ - uz * runD, -half, half);
        if (!man.runIn && Math.hypot(rx - v.pos.x, rz - v.pos.z) < 220) man.runIn = true;
        a.jetMode = 2; a.jetAlt = man.planeJob === 'supply' ? 140 : 190; a.jetVX = ux; a.jetVZ = uz;
        a.jetX = man.runIn ? man.dismountX : rx; a.jetZ = man.runIn ? man.dismountZ : rz;
        if (man.planeJob === 'supply' && man.msg && !this.radio.holds(man.msg, v.id, man.msgId)) { man.msg = null; man.planeJob = ''; man.setMode(VMode.RETURN, time); return; }
        if (man.msg) this.radio.extend(man.msg, time, 120, 'transport aircraft inbound with supplies');
        const along = (man.dismountX - v.pos.x) * ux + (man.dismountZ - v.pos.z) * uz;
        const lat = Math.abs((man.dismountX - v.pos.x) * -uz + (man.dismountZ - v.pos.z) * ux);
        const d = Math.hypot(man.dismountX - v.pos.x, man.dismountZ - v.pos.z);
        if (d < 400 && d > 150) this.flares(v, time);
        if (man.runIn && along < 60 && lat < 90 && v.altitude > 60) {
          if (man.planeJob === 'supply') {
            (this.game.vehicles as any).airdrop(v.pos.x - Math.sin(v.yaw) * 14, v.pos.y - 4, v.pos.z - Math.cos(v.yaw) * 14, v.team, 24);
            if (man.msg && this.radio.holds(man.msg, v.id, man.msgId)) this.radio.complete(man.msg, 'supplies airdropped');
            man.msg = null; this.stats.planeAirdrops++; man.planeJob = ''; man.setMode(VMode.RETURN, time);
          } else { man.tx = clamp(man.dismountX + ux * 1500, -half, half); man.tz = clamp(man.dismountZ + uz * 1500, -half, half); man.nextDrop = time; man.setMode(VMode.PARA, time); }
        } else if (man.runIn && along < -250) man.runIn = false; // overshot: go round for another run
        return;
      }
      case VMode.PARA: {
        // Over the drop zone: the ramp opens, the vehicle rolls out over it under its chute, and the stick follows
        // it out one by one off the end of the ramp.
        a.jetMode = 2; a.jetAlt = 190; a.jetX = man.tx; a.jetZ = man.tz;
        (v as any).holdDoors(2);
        const VS = this.game.vehicles as any;
        if (man.cargoV >= 0) {
          const o = list[man.cargoV];
          if (!o.cargoOf) { this.lock(o, false); man.cargoV = -1; this.stats.planeVehicleDrops++; }
          // Over buildings: hold the vehicle a moment so it does not land on a roof (jumpers go first).
          else if (!o.sliding && !(time - man.modeTime < 8 && this.roofBelow(v)) && time - man.modeTime > 1) { VS.unloadCargo(v, o); man.nextDrop = time + 0.7; }
        }
        const sliding = man.cargoV >= 0 && list[man.cargoV].sliding;
        if (time > man.nextDrop && aboard > 0 && time - man.modeTime > 1.2 && (!sliding || time - man.modeTime > 2)) { this.dropOne(v, man, false); man.nextDrop = time + 0.45; }
        if (aboard === 0 && man.cargoV < 0) { man.planeJob = ''; this.finishInsertion(v, man, time); this.stats.dismounts++; }
        return;
      }
      case VMode.UNLOAD: {
        // Air-landed: ramp down, the vehicle drives off first, then the troops walk down.
        a.jetHold = true;
        (v as any).holdDoors(2);
        if (man.cargoV >= 0) {
          const o = list[man.cargoV];
          if (!o.cargoOf) { this.lock(o, false); man.cargoV = -1; }
          else if (!o.sliding) (this.game.vehicles as any).unloadCargo(v, o);
        }
        if (aboard > 0 && (man.cargoV < 0 || time - man.modeTime > 4)) this.dismountPassengers(v);
        if ((aboard === 0 && man.cargoV < 0) || time - man.modeTime > 16) { man.planeJob = ''; this.finishInsertion(v, man, time); a.landRw = null; a.landPhase = ''; }
        return;
      }
      case VMode.RETURN: case VMode.LAND: this.ctlLanding(v, man, a, time); return;
      default: man.setMode(VMode.PARKED, time);
    }
  }


  /** The side's own runway. */
  private homeRunway(v: VehicleLike): any {
    return ((this.game.map as any).runways as any[]).find((r: any) => r.team === (v.occupied ? v.team : v.spawn.team)) || null;
  }

  /**
   * Taxi route from the stand to the loading point at the head of the runway: out to the taxiway, along it to the
   * threshold end, onto the centreline facing down the runway (so it can roll straight off once loaded).
   */
  private loadingRoute(v: VehicleLike): { x: number; z: number }[] | null {
    const rw = this.homeRunway(v);
    if (!rw || !((v as any).grounded > 0)) return null;
    const along = (v.pos.x - rw.x0) * rw.dx + (v.pos.z - rw.z0) * rw.dz, lat = (v.pos.x - rw.x0) * -rw.dz + (v.pos.z - rw.z0) * rw.dx;
    if ((rw.dx * 0 + Math.abs(lat)) < 6 && along < 120) return [];
    const sg = Math.sign(lat) || 1;
    const at = (al: number, la: number) => ({ x: rw.x0 + rw.dx * al - rw.dz * la, z: rw.z0 + rw.dz * al + rw.dx * la });
    const q = [];
    if (Math.abs(lat) > TAXIWAY_LAT + 4) q.push(at(along, sg * TAXIWAY_LAT));
    q.push(at(Math.max(60, Math.min(along, 120)), sg * TAXIWAY_LAT), at(48, sg * 10), at(30, 0), at(55, 0));
    return q;
  }

  /**
   * A light vehicle being taken aboard a transport aircraft: its driver (one of the stick) drives it over on the
   * vehicle network to a point behind the lowered ramp, lines up with the aircraft and comes up to the foot of the
   * ramp; the load crew then winches it up the ramp into the hold, where the driver gets out and takes his seat.
   */
  private ctlDriveAboard(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    const plane = this.game.vehicles.list[man.loadInto] as any, pm = this.manifests[man.loadInto];
    const VS = this.game.vehicles as any;
    if (!plane || !plane.alive || (pm.mode !== VMode.BOARDING && pm.mode !== VMode.PARKED) || (v as any).cargoOf) {
      if (!(v as any).cargoOf) { man.loadInto = -1; this.lock(v, false); }
      return;
    }
    if (!pm.loadReady) { this.drive(a, v.pos.x, v.pos.z); a.holdVehicle = true; return; } // wait until it is on its spot
    VS.rampFoot(plane, P3V);
    const bx = -Math.sin(plane.yaw), bz = -Math.cos(plane.yaw);
    const lineX = P3V.x + bx * 14, lineZ = P3V.z + bz * 14;
    const dFoot = Math.hypot(P3V.x - v.pos.x, P3V.z - v.pos.z), dLine = Math.hypot(lineX - v.pos.x, lineZ - v.pos.z);
    // line up behind the ramp first, then drive straight up to its foot, slowly
    if (!(man as any).lined && dLine > 5 && dFoot > 8) { this.drive(a, lineX, lineZ); a.arriveR = 4; a.speedCap = Math.min(a.speedCap, dLine < 40 ? 5 : 12); return; }
    (man as any).lined = true;
    this.drive(a, P3V.x, P3V.z); a.pursuit = true; a.arriveR = 1.5; a.speedCap = 3;
    // Close behind the ramp (the driver's obstacle avoidance keeps it a few metres off the airframe): the load
    // crew guides it up the ramp from there.
    const behind = (v.pos.x - P3V.x) * bx + (v.pos.z - P3V.z) * bz > -2;
    if ((dFoot < 7 && behind) || dFoot < 3.2) {
      plane.holdDoors(4);
      VS.loadCargo(plane, v, true);
      (man as any).lined = false;
    }
  }

  /**
   * Fixed-wing recovery: approach and land on the home runway (or a nearer friendly strip), roll out, taxi along
   * the centreline abeam the stand, across to the taxiway and the hangar door, into the stand, where the ground
   * crew turns it round. RETURN sets it up; LAND flies it (see flyJet).
   */
  private ctlLanding(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
  if (man.mode === VMode.RETURN) {
      // Home, or the nearest runway we can use if home is far and one is closer.
      // Home runway by default; a friendly airstrip only when home is far and the strip is long enough.
      const runways = (this.game.map as any).runways as any[];
      const homeRw = runways.find((r: any) => r.team === v.team) || null;
      // Where to land (Q1–Q6): home (full service in the hangar) or a forward airstrip at a flag we hold, when it
      // saves a long flight or the aircraft is hurt, the strip is quiet, and long enough for this aircraft.
      const hurt = v.health < v.def.health * 0.4;
      const D = this.delib.begin(v.id, time, hash01(v.id, 13), hurt ? 0.8 : 0);
      const dist = (r: any) => Math.hypot((r.x0 + r.x1) / 2 - v.pos.x, (r.z0 + r.z1) / 2 - v.pos.z);
      const dHome = homeRw ? dist(homeRw) : 1e9;
      for (let i = 0; i < runways.length; i++) {
        const r = runways[i];
        if (r === homeRw) D.propose(i, 300 - dHome);
        else if (this.usableRunway(v.team, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, 5) === r) D.propose(i, -dist(r));
      }
      let rw: any = null;
      for (let i = D.next(); i >= 0; i = D.next()) {
        const r = runways[i];
        const ok = r === homeRw ? D.check(true, true, true, true, true)
          : D.check(true, hurt || dHome - dist(r) > 500, this.enemiesNear(v.team, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, 300) < 2,
            r.len >= (man.archetype === A.TRANSPORT_PLANE ? 380 : 340), true);
        if (ok === 0) { rw = r; D.choose(i); break; }
      }
      if (!rw) { D.none(); rw = homeRw; }
      const home = rw && rw.team === v.team;
      if (home || !rw) { a.taxiX = v.spawn.x; a.taxiZ = v.spawn.z; }
      else {
        // Forward airstrip: park beside the strip near its first threshold (the next departure taxis out from there).
        const P = { x: rw.x0 + rw.dx * 45 - rw.dz * 24, z: rw.z0 + rw.dz * 45 + rw.dx * 24 };
        a.taxiX = P.x; a.taxiZ = P.z; this.stats.forwardLandings++;
      }
      if ((v as any).grounded > 0 && v.altitude < 1.5 && !a.landRw) { a.jetMode = 0; return; } // still on a strip after unloading: take off first
      if (rw) { a.landRw = this.landingOn(rw, a.taxiX, a.taxiZ); a.landPhase = ''; a.landed = false; }
      // Taxi in: along the centreline to abeam the stand, across to the taxiway, to the hangar door, into the
      // stand (home); elsewhere just off the runway.
      man.tx = a.taxiX; man.tz = a.taxiZ; man.runIn = false;
      const q: { x: number; z: number }[] = [];
      if (rw) {
        const t = clamp((a.taxiX - rw.x0) * rw.dx + (a.taxiZ - rw.z0) * rw.dz, 30, rw.len - 30);
        const lat = (a.taxiX - rw.x0) * -rw.dz + (a.taxiZ - rw.z0) * rw.dx, sg = Math.sign(lat) || 1;
        const at = (al: number, la: number) => ({ x: rw.x0 + rw.dx * al - rw.dz * la, z: rw.z0 + rw.dz * al + rw.dx * la });
        q.push(at(t, 0));
        if (home && Math.abs(lat) > TAXIWAY_LAT + 6) { q.push(at(t, sg * TAXIWAY_LAT), at(t, sg * (TAXIWAY_LAT + 13))); }
        q.push({ x: man.tx, z: man.tz });
        const first = q.shift()!;
        a.taxiX = first.x; a.taxiZ = first.z; man.runIn = true;
      }
      (man as any).taxiQ = q;
      man.setMode(VMode.LAND, time);
      return;
  }
  {
      a.jetMode = 0;
      if (!a.landRw) { man.setMode(VMode.RETURN, time); return; }
      const tq = (man as any).taxiQ as { x: number; z: number }[] | undefined;
      if (a.landed && tq && tq.length) { const p = tq.shift()!; a.taxiX = p.x; a.taxiZ = p.z; a.landed = false; return; }
      if (a.landed && man.runIn) { man.runIn = false; a.taxiX = man.tx; a.taxiZ = man.tz; a.landed = false; return; }
      if (a.landed || (a.landPhase === 'taxi' && time - man.modeTime > 240)) {
        // On its stand in the hangar: the ground crew turns it round, nose to the door, for the next sortie.
        if (a.landed && Math.hypot(v.pos.x - v.spawn.x, v.pos.z - v.spawn.z) < 12) (v as any).towTo?.(v.spawn.x, v.spawn.z, v.spawn.yaw);
        a.landRw = null; a.landPhase = ''; a.landed = false; this.stats.planeLandings++;
        man.planeJob = ''; man.setMode(VMode.PARKED, time); man.idleSince = time;
      }
      return;
    }
  }

  /**
   * Combat-jet sortie cycle: after SORTIE_S airborne (fuel), or badly damaged, and not in the middle of a strike
   * run, it returns, lands and taxis into its hangar; there it is rearmed and refuelled (TURNAROUND_S) and sent
   * off again. Returns true while it has control.
   */
  private sortie(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): boolean {
    const sm = man as any, vv = v as any;
    if (man.mode === VMode.RETURN || man.mode === VMode.LAND) {
      a.jetHold = false;
      this.ctlLanding(v, man, a, time);
      if ((man.mode as number) === VMode.PARKED) {
        for (const w of vv.weapons) w.refill();
        sm.turnUntil = time + TURNAROUND_S;
      }
      return true;
    }
    if (sm.turnUntil > 0) {
      // Turnaround in the hangar: engines off, brakes on.
      if (time < sm.turnUntil && vv.grounded > 0) { a.jetHold = true; man.setMode(VMode.PARKED, time); return true; }
      sm.turnUntil = 0; a.jetHold = false;
    }
    const airborne = !(vv.grounded > 0) && v.altitude > 20;
    if (!airborne) { sm.airSince = -1; return false; }
    if (!(sm.airSince >= 0)) sm.airSince = time;
    const fuel = time - sm.airSince > SORTIE_S, hurt = vv.health < vv.def.health * 0.4;
    if ((fuel || hurt) && !(man.msg && man.mode === VMode.ATTACK && !hurt)) {
      if (man.msg) { this.radio.release(man.msg, 'aircraft returning to base'); man.msg = null; }
      sm.airSince = -1;
      man.setMode(VMode.RETURN, time);
      this.ctlLanding(v, man, a, time);
      return true;
    }
    return false;
  }

  /**
   * STRIKE JET: loiter cap over the friendly side until a CAS ticket, then an
   * angled dive along the requester's marked vector, weapons release after a
   * danger-close check, pull-out with flares, back to the cap.
   */
  private ctlStrikeJet(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    if (this.sortie(v, man, a, time)) return;
    const terrain = this.game.map.terrain;
    if (!man.msg || !this.radio.holds(man.msg, v.id, man.msgId)) {
      man.msg = null;
      if (time > man.evadeUntil) {
        man.msg = this.take(v, man, RadioType.CAS_REQUEST, 1400, time);
        if (man.msg) { man.msgId = man.msg.id; man.passes = 0; man.setMode(VMode.ATTACK, time); }
      }
    }
    if (man.msg && man.mode === VMode.ATTACK) {
      const m = man.msg;
      if (m.targetIdx >= 0) {
        const e = this.engine.entity(m.targetIdx);
        if (!e.alive) { this.radio.complete(m, 'target destroyed'); man.msg = null; man.setMode(VMode.LOITER, time); return; }
        m.x = e.pos.x; m.y = e.pos.y; m.z = e.pos.z;
        if (v.seats[0]) this.engine.cue(v.seats[0].id, m.targetIdx, m.x, m.y, m.z);
      }
      // Danger close: abort the run if friendlies are at the impact point; the second time it is called off
      // (the requester hears why) instead of being picked up and aborted again until it times out.
      if (this.friendliesNear(v.team, m.x, m.z, 25) > 0) {
        if (m.handbacks >= 1) this.radio.callOff(m, 'friendlies too close to the target', time);
        else this.radio.release(m, 'run aborted: friendlies at the target');
        man.msg = null; man.evadeUntil = time + 15; man.setMode(VMode.LOITER, time);
        a.jetMode = 0; return;
      }
      if (!this.radio.extend(m, time, 120, man.passes > 0 ? `strike run ${man.passes + 1} of 3` : 'strike aircraft inbound')) {
        this.radio.release(m, 'aircraft could not complete the runs in time'); man.msg = null; man.evadeUntil = time + 20; man.setMode(VMode.LOITER, time); a.jetMode = 0; return;
      }
      const vlen = Math.hypot(m.vx, m.vz);
      a.jetMode = 1; a.jetX = m.x; a.jetZ = m.z;
      a.jetVX = vlen > 1 ? m.vx / vlen : Math.sin(v.yaw); a.jetVZ = vlen > 1 ? m.vz / vlen : Math.cos(v.yaw);
      a.jetAlt = 220;
      a.artyX = m.x; a.artyY = m.y; a.artyZ = m.z; a.artyUntil = time + 1;
      const d = Math.hypot(m.x - v.pos.x, m.z - v.pos.z);
      if (d < 500) this.radio.addDangerZone(v.team, m.x, m.z, 22, time + 6, time);
      if (time < a.jetPullUntil && d < 300) this.flares(v, time);
      if (time > a.jetPullUntil && man.modeTime + 5 < time && d > 650) {
        man.passes++;
        if (man.passes >= 3) { this.radio.complete(m, 'strike delivered (3 runs)'); man.msg = null; man.setMode(VMode.LOITER, time); }
      }
      return;
    }
    // Loiter cap between the nearest friendly flag and the front.
    man.setMode(VMode.LOITER, time);
    const f = man.objective;
    a.jetMode = 0; a.jetAlt = 250; a.artyUntil = 0;
    const own = this.nearestOwnFlag(v);
    a.jetX = f ? (own ? (f.x + own.x) / 2 : f.x) : 0;
    a.jetZ = f ? (own ? (f.z + own.z) / 2 : f.z) : 0;
    void terrain;
  }

  /**
   * FIGHTER: combat air patrol over the front at altitude, intercepting
   * hostile air in priority order (fighter → strike jet → attack helicopter →
   * transport helicopter) with throttle managed for energy.
   */
  private ctlFighter(v: VehicleLike, man: VehicleManifest, a: AgentLike, time: number): void {
    if (this.sortie(v, man, a, time)) return;
    const t = a.target;
    if (t && t.kind === 'vehicle' && t.isAircraft) { a.jetMode = 2; man.setMode(VMode.ATTACK, time); return; }
    man.setMode(VMode.LOITER, time);
    const f = man.objective;
    a.jetMode = 0; a.jetAlt = 300;
    a.jetX = f ? f.x : 0; a.jetZ = f ? f.z : 0;
  }

  private nearestOwnFlag(v: VehicleLike): FlagLike | null {
    const flags = this.game.capture.flags;
    let best: FlagLike | null = null, bd = 1e12;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f.owner !== v.team) continue;
      const d = (f.x - v.pos.x) ** 2 + (f.z - v.pos.z) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  /** Debug: count of manifests per controller mode. */
  modeHistogram(out: Int32Array): void {
    out.fill(0);
    for (let i = 0; i < this.manifests.length; i++) if (this.game.vehicles.list[i].occupied) out[this.manifests[i].mode]++;
  }

  /** Tickets currently reserved (debug). */
  activeTickets(): number {
    let n = 0;
    for (let i = 0; i < this.tickets.length; i++) if (this.tickets[i].state === TicketState.RESERVED) n++;
    return n;
  }
}

/** Seconds a CAS / fire-mission ticket stays exclusive before reopening (see TacticalRadioBus.update). */
export const TICKET_STATES = MsgState;
export const LOGISTICS = Logistics;
export const clampValue = clamp;
