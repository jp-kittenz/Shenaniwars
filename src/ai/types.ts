/**
 * Shared AI vocabulary: numeric enums (erasable const objects), tuning,
 * deterministic RNG and the structural types of the JavaScript game objects
 * the AI reads and drives.
 */

// ---------------------------------------------------------------- enums

export const SeatRole = { DRIVER: 0, PILOT: 1, GUNNER: 2, COMMANDER: 3, PASSENGER: 4, RIDER: 5 } as const;
export type SeatRole = (typeof SeatRole)[keyof typeof SeatRole];
export const SEAT_ROLE_NAMES = ['DRIVER', 'PILOT', 'GUNNER', 'COMMANDER', 'PASSENGER', 'RIDER'] as const;

export const Archetype = {
  MBT: 0, HT: 1, LT: 2, APC: 3, IFV: 4, TRUCK: 5, SUPPLY: 6, MLRS: 7, HOWITZER: 8,
  SAM: 9, SPAAG: 10, ATTACK_HELI: 11, TRANSPORT_HELI: 12, STRIKE_JET: 13, FIGHTER: 14,
  /** Static emplacement (HMG, AA gun, searchlight): crewed by nearby defenders, never driven. */
  TURRET: 15,
} as const;
export type Archetype = (typeof Archetype)[keyof typeof Archetype];
export const ARCHETYPE_NAMES = [
  'MBT', 'HT', 'LT', 'APC', 'IFV', 'TRUCK', 'SUPPLY', 'MLRS', 'HOWITZER', 'SAM', 'SPAAG',
  'ATTACK_HELI', 'TRANSPORT_HELI', 'STRIKE_JET', 'FIGHTER', 'TURRET',
] as const;
/** Vehicle type id (vehicle-defs.js) → archetype. Pampalona placeholders map onto the nearest profile. */
export const ARCHETYPE_OF: Readonly<Record<string, Archetype>> = {
  mbt: Archetype.MBT, ht: Archetype.HT, lt: Archetype.LT, apc: Archetype.APC, ifv: Archetype.IFV,
  truck: Archetype.TRUCK, supply: Archetype.SUPPLY, mlrs: Archetype.MLRS, howitzer: Archetype.HOWITZER,
  sam: Archetype.SAM, spaag: Archetype.SPAAG, attackheli: Archetype.ATTACK_HELI, transportheli: Archetype.TRANSPORT_HELI,
  strikejet: Archetype.STRIKE_JET, fighter: Archetype.FIGHTER,
  jeep: Archetype.TRUCK, tank: Archetype.MBT, heli: Archetype.ATTACK_HELI,
  hmgturret: Archetype.TURRET, aaturret: Archetype.TURRET, searchlight: Archetype.TURRET,
};

export const SoldierClass = { LEADER: 0, RIFLEMAN: 1, AT: 2, SUPPORT: 3, SPOTTER: 4, CREWMAN: 5, PILOT: 6 } as const;
export type SoldierClass = (typeof SoldierClass)[keyof typeof SoldierClass];
export const CLASS_NAMES = ['LEADER', 'RIFLEMAN', 'AT', 'SUPPORT', 'SPOTTER', 'CREWMAN', 'PILOT'] as const;

export const Action = {
  PATROL: 0, ADVANCE: 1, ENGAGE: 2, SUPPRESS: 3, TAKE_COVER: 4, BOUND: 5, FLANK: 6, RETREAT: 7, RESUPPLY: 8,
  BOARD: 9, INVESTIGATE: 10, AMBUSH: 11, SCREEN: 12, HOLD: 13, REGROUP: 14, REPAIR: 15, HEAL: 16, CREW_WAIT: 17,
} as const;
export type Action = (typeof Action)[keyof typeof Action];
export const ACTION_COUNT = 18;
export const ACTION_NAMES = [
  'patrol', 'advance', 'engage', 'suppress', 'cover', 'bound', 'flank', 'retreat', 'resupply',
  'board', 'investigate', 'ambush', 'screen', 'hold', 'regroup', 'repair', 'heal', 'crew',
] as const;
/** Minimum seconds an action stays selected before a normal-priority switch. */
export const ACTION_COMMIT = new Float32Array([1.5, 1.5, 1.2, 1.5, 3, 2, 4, 4, 3, 2, 2, 1.5, 2, 2, 1.5, 2, 2, 2]);

export const Stance = { STAND: 0, CROUCH: 1, PRONE: 2 } as const;
export type Stance = (typeof Stance)[keyof typeof Stance];

export const RadioType = {
  SPOT: 0, CAS_REQUEST: 1, FIRE_MISSION: 2, LOGISTICS_REQUEST: 3, AIR_THREAT: 4, EXTRACT_REQUEST: 5, DANGER_CLOSE: 6, CONTACT: 7,
} as const;
export type RadioType = (typeof RadioType)[keyof typeof RadioType];
export const RADIO_TYPE_COUNT = 8;
export const RADIO_NAMES = ['SPOT', 'CAS_REQUEST', 'FIRE_MISSION', 'LOGISTICS_REQUEST', 'AIR_THREAT', 'EXTRACT_REQUEST', 'DANGER_CLOSE', 'CONTACT'] as const;
export const Logistics = { AMMO: 0, REPAIR: 1, MEDIC: 2 } as const;
export const MsgState = { FREE: 0, OPEN: 1, CLAIMED: 2, DONE: 3 } as const;
export const TicketState = { FREE: 0, RESERVED: 1, BOARDED: 2 } as const;
export const Posture = { ASSAULT: 0, DEFEND: 1, BOUND: 2, FLANK: 3, REGROUP: 4, MOUNTED: 5, HOLD: 6 } as const;
export type Posture = (typeof Posture)[keyof typeof Posture];
export const Formation = { COLUMN: 0, WEDGE: 1, LINE: 2 } as const;
export type Formation = (typeof Formation)[keyof typeof Formation];
export const AILod = { FULL: 0, REDUCED: 1, ABSTRACT: 2 } as const;
/** Commander orders to a squad. */
export const Order = { NONE: 0, MOVE: 1, HOLD: 2, ATTACK: 3, SUPPORT: 4, DEFEND: 5, AIRLIFT: 6 } as const;
export const ORDER_NAMES = ['free', 'move', 'hold', 'attack', 'support', 'defend', 'airlift'] as const;
/** Helicopter insertion methods. */
export const Insert = { LAND: 0, ROPE: 1, PARA: 2 } as const;
export const INSERT_NAMES = ['land', 'fast-rope', 'parachute'] as const;
export type AILod = (typeof AILod)[keyof typeof AILod];

/** Perception memory slot flags. */
export const PF = { VISIBLE: 1, ACQUIRED: 2, PENDING: 4, HEARD: 8, SHARED: 16, CUED: 32 } as const;

// ---------------------------------------------------------------- tuning

export const AI_TUNING = {
  /** Fixed AI clock (Hz). Perception and tactics are slices of it. */
  clockHz: 60,
  perceptionHz: 5,
  tacticalHz: 6,
  squadHz: 4,
  vehicleHz: 4,
  convoyHz: 1,
  /** Line-of-sight raycasts per rendered frame, across all observers. */
  raysPerFrame: 20,
  losValid: 0.45,
  memorySlots: 10,
  /** LOD radii around the camera. */
  lodFull: 160,
  lodReduced: 320,
  baseDetectRate: 1.7,
  forgetAfter: 20,
  hysteresis: 0.1,
  interruptMargin: 0.25,
  ticketTtlMin: 8,
  transportWait: 15,
  boardFraction: 0.75,
  criticalBurn: 0.25,
  convoySpacing: 25,
  /** Flag capture radius (CONFIG.match.captureRadius). */
  captureRadius: 16,
} as const;

// ---------------------------------------------------------------- deterministic RNG

/** mulberry32 step over a Uint32Array state cell; returns [0, 1). Allocation-free. */
export function rand(state: Uint32Array, i: number): number {
  let s = (state[i] = (state[i] + 0x6d2b79f5) >>> 0);
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}
/** Stable hash of two ints into [0, 1). */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

// ---------------------------------------------------------------- game-facing structural types

export interface Vec3Like { x: number; y: number; z: number }

export interface WeaponDefLike {
  id: string; name: string; type: 'hitscan' | 'projectile'; slot: string;
  damage: number; rpm: number; mag: number; reserve: number; range: number;
  vsVehicle: Record<string, number>;
  homing?: 'air' | 'guided'; artillery?: boolean; drop?: boolean;
  radius?: number; speed?: number; gravity?: number; splash?: number;
}
export interface WeaponStateLike {
  def: WeaponDefLike; ammo: number; reserve: number; readonly reloading: boolean;
  /** Rounds fired since spawn (monotonic). */
  shot: number;
}

export interface MountDefLike { seat: number; weapon: string; turnRate: number; coax?: number; fallbackSeat?: number; aa?: boolean }
export interface SeatDefLike { role: string; pos: number[]; exterior?: boolean; face?: number; pose?: number }
export interface VehicleDefLike {
  type: string; kind: 'ground' | 'heli' | 'jet'; role: string; armor: string; label: string;
  half: number[]; seats: SeatDefLike[]; mounts: MountDefLike[]; seatMounts: number[][];
  /** Per seat: the seat whose weapons it takes over while that seat is empty (-1). */
  fallbackFrom: number[];
  maxSpeed: number; padRadius: number; passengers: number; riders?: number; health: number; openSeats?: boolean; static?: boolean;
  flight?: { stall: number };
}

export interface ControlsLike { throttle: number; steer: number; brake: boolean }

export interface VehicleLike {
  readonly kind: 'vehicle';
  id: number; team: number; alive: boolean; health: number;
  pos: Vec3Like; vel: Vec3Like;
  def: VehicleDefLike;
  seats: (SoldierLike | null)[];
  spawn: { x: number; z: number; yaw: number; team: number; type: string };
  weapons: WeaponStateLike[];
  controls: ControlsLike;
  readonly occupied: boolean; readonly driver: SoldierLike | null; readonly isAircraft: boolean;
  readonly altitude: number; readonly yaw: number; airspeed: number; speed: number;
  flareUntil: number; smokeCooldown: number; radarOn: boolean;
  /** Fast-ropes deployed (visual). */
  ropes: boolean;
  aimYaw: Float32Array;
  readonly occupants: number;
  /** Mounts a seat operates now (own plus fallback crew weapons). */
  mountList(seat: number): number[];
  /** Occupant of seat i is visible and can be shot (open vehicle or exterior rider position). */
  seatExposed(i: number): boolean;
  /** Hull-relative yaw of each weapon mount. */
  readonly mountYaw: Float32Array;
  /** Keeps the doors open for t seconds (boarding / unloading). */
  holdDoors(t?: number): void;
  /** Seat operating mount k now. */
  operatorSeat(k: number): number;
  enter(s: SoldierLike, prefer?: number): number;
  exit(s: SoldierLike): void;
  repair(amount: number): boolean;
  deployFlares(time: number): boolean;
}

export interface NavStateLike { len: number; idx: number; pending: boolean; clear(): void; vehicle: boolean; partial: boolean }

/** Intent surface of the per-bot actuator (src/entities/ai-agent.js). */
export interface AgentLike {
  s: SoldierLike;
  skill: number;
  nav: NavStateLike;
  state: string;
  // infantry intent
  goalX: number; goalZ: number; hasGoal: boolean; sprint: boolean;
  /** Building whose upper level the goal is on (-1: ground); see floors.ts. */
  upB?: number;
  /** 0 hold fire, 1 fire at visible target, 2 suppress last known position */
  fireMode: number;
  weaponPref: number;
  target: SoldierLike | VehicleLike | null; targetVisible: boolean;
  lastSeenX: number; lastSeenY: number; lastSeenZ: number; lastSeenTime: number;
  acquireTime: number;
  // vehicle crew intent (read by src/ai/vehicle-pilot.js)
  driveX: number; driveZ: number; holdVehicle: boolean; speedCap: number; faceYaw: number; pursuit: boolean;
  /** Distance from the final path point at which the driver counts as arrived (parking: small). */
  arriveR: number;
  /** Driving trouble counters (three-point turns, re-routes around jams). */
  kTurns: number; jamReroutes: number;
  heliLand: boolean; heliTransit: boolean; heliAlt: number; landed: boolean;
  /** Hold a hover over (driveX, driveZ) at heliAlt (fast-rope). */
  heliHover: boolean;
  /** Yaw to watch when idle (fighting position facing), NaN for none. */
  lookYaw: number;
  scanYaw: number; scanVel: number; scanAt: number;
  jetMode: number; jetX: number; jetZ: number; jetVX: number; jetVZ: number; jetAlt: number; jetPullUntil: number;
  artyX: number; artyY: number; artyZ: number; artyUntil: number; artySpread: number;
  /** Endgame: a point on an exposed enemy HQ to engage with explosives when no enemy is in sight. */
  siegeX: number; siegeY: number; siegeZ: number; siegeUntil: number;
  stuckTotal: number;
  /** Repeated stuck events at one spot; partial paths followed to their end. */
  stuckRepeat: number; partialHops: number;
  /** Target knowledge 0..4 and line-of-fire state (see ai-agent.js). */
  know: number; lofBlockedAt: number; noLineUntil: number;
  /** Walking: 'moving' | 'replanning' | 'detour' | 'unreachable' | 'idle'. */
  navStatus: string;
  reset(): void;
  /** Per-frame actuation of the current intent. */
  update(dt: number): void;
}

export interface SquadRef { id: number }

export interface SoldierLike {
  readonly kind: 'soldier';
  id: number; team: number; isPlayer: boolean; alive: boolean; name: string;
  pos: Vec3Like; yaw: number; pitch: number; health: number; speed: number;
  moveX: number; moveZ: number; grounded: boolean;
  vehicle: VehicleLike | null; seat: number;
  weapons: WeaponStateLike[]; readonly weapon: WeaponStateLike; weaponIdx: number;
  launcher: WeaponStateLike | null; rifle: WeaponStateLike;
  spotted: number; muzzleFlash: number;
  stance: number; cls: number;
  sprinting: boolean; alert: boolean; parachute: boolean;
  /** Sliding down a fast-rope. */
  rappel: boolean;
  velY: number;
  ai: AgentLike | null;
  squad: any;
}

export interface FlagLike {
  id: number; name: string; x: number; y: number; z: number; owner: number; base: boolean; radius?: number;
  contestedBy: number; count: number[];
  /** Capture progress: -1 fully team 0, +1 fully team 1. */
  v: number;
}

export interface PropLike {
  id: number; type: string; x: number; y: number; z: number; rot: number;
  hx: number; hy: number; hz: number; r: number; scale: number; alive: boolean;
}

export interface TerrainLike {
  half: number; size: number;
  height(x: number, z: number): number;
  roadAt(x: number, z: number): number;
  inBounds(x: number, z: number, margin?: number): boolean;
}

export interface GameLike {
  time: number;
  soldiers: SoldierLike[];
  player: SoldierLike;
  vehicles: { list: VehicleLike[] };
  physics: { losClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean };
  nav: { blocked(x: number, z: number, vehicle?: boolean): boolean; lineClear(ax: number, az: number, bx: number, bz: number, vehicle: boolean): boolean };
  map: { terrain: TerrainLike; props: PropLike[]; runways: { team: number; x0: number; z0: number; x1: number; z1: number; dx: number; dz: number; len: number; yaw: number }[]; roads: number[][]; bases?: { team: number; flag: number; hq: number[] }[] };
  capture: { flags: FlagLike[]; tickets: number[]; phase?: string[] };
  bus: { on(type: string, fn: (...args: any[]) => void): () => void; emit(type: string, ...args: any[]): void };
  particles: { smoke(x: number, y: number, z: number, size: number, alpha?: number): void; sparks(x: number, y: number, z: number, n?: number): void };
  render: { camera: { position: Vec3Like } };
  /** Time of day / weather sight multipliers (AtmosphereSystem). */
  atmosphere?: { vis: number; vehVis: number; range: number; thermalRange: number };
}

/** Target index space: soldiers [0, S), vehicles [S, S + V). */
export interface EntityIndex {
  readonly soldierCount: number;
  readonly vehicleCount: number;
}
