/**
 * Vehicle definitions (pure data, no rendering).
 *
 * Authoring convention: every position below is in "ground coordinates":
 * metres, +Z forward, +X to the vehicle's LEFT, Y measured from the ground
 * when the vehicle sits at rest. `normalize()` converts them to body-local
 * coordinates (origin at the collider centre, which rests `ride` metres up).
 *
 * Tracked vehicles use a row of suspension rays per side and skid steering
 * (`maxSteer: 0`); wheeled vehicles steer the wheels flagged `steer`.
 */

/**
 * @typedef {Object} WheelDef
 * @property {number} x @property {number} z
 * @property {boolean} [steer] @property {boolean} [driven]
 * @property {number[]} [pos]  body-local ray origin (filled by normalize)
 */
/**
 * @typedef {Object} MountDef
 * @property {number} seat         seat index that operates this weapon
 * @property {string} weapon       key into WEAPONS
 * @property {number[]} [pos]      yaw pivot (ground coords in the table, body-local after normalize)
 * @property {number[]} [trunnion] pitch pivot relative to the yaw pivot
 * @property {number} [barrel]     muzzle distance ahead of the pitch pivot
 * @property {number[][]} [muzzles] extra per-shot offsets in the pitch frame (cycled)
 * @property {number} [turnRate]   rad/s; 0 = fixed to the airframe/hull
 * @property {number} [pitchMin] @property {number} [pitchMax]
 * @property {number} [yawMin] @property {number} [yawMax]  hull-relative traverse limits
 * @property {number} [parent]     rides on another mount's turret (position follows its yaw)
 * @property {number} [coax]       slaved to another mount's yaw and pitch
 * @property {number[]} [offset]   coax muzzle offset in the parent's pitch frame
 * @property {number} [fallbackSeat] seat that operates this weapon while `seat` is empty
 */
/**
 * @typedef {Object} SeatDef
 * @property {'driver'|'gunner'|'commander'|'passenger'} role
 * @property {number[]} pos        seat surface
 */
/**
 * @typedef {Object} VehicleDef
 * @property {string} type
 * @property {'pampalona'|'torsa'} faction
 * @property {'ground'|'heli'|'jet'} kind
 * @property {string} label
 * @property {import('./weapons.js').ArmorClass} armor
 * @property {'armor'|'transport'|'supply'|'artillery'|'aa'|'heli'|'airlift'|'jet'} role
 * @property {number} mass @property {number} health
 * @property {number[]} half  collider half extents
 * @property {number} ride    collider centre height above the ground at rest
 * @property {WheelDef[]} wheels
 * @property {number} wheelRadius @property {number} suspRest @property {number} suspSag @property {number} suspDamp
 * @property {number} engineForce @property {number} brakeForce @property {number} maxSpeed @property {number} reverseSpeed
 * @property {number} grip @property {number} lateralGrip @property {number} maxSteer @property {number} turnRate
 * @property {number} [rolling]  coasting resistance (1/s)
 * @property {SeatDef[]} seats
 * @property {MountDef[]} mounts
 * @property {number} camDist @property {number} camHeight @property {number} crashDamage
 * @property {boolean} [openSeats] occupants are visible
 * @property {number} [padRadius]  parking footprint radius
 * @property {Object} [flight]     fixed-wing parameters
 * @property {number[][]} seatMounts  mount indices a seat owns (filled by normalize)
 * @property {number[][]} seatMountsFallback  owned mounts plus those that fall back to the seat
 * @property {number[]} fallbackFrom  per seat: the seat whose weapons it takes over when that seat is empty (-1)
 * @property {number} passengers   passenger seat count (filled by normalize)
 */

const tracks = (x, zs) => zs.flatMap((z) => [{ x, z, driven: true }, { x: -x, z, driven: true }]);
const axles = (x, zs, steerCount) => zs.flatMap((z, i) => [
  { x, z, steer: i < steerCount, driven: true }, { x: -x, z, steer: i < steerCount, driven: true },
]);
const pax = (rows) => rows.map((pos) => ({ role: /** @type {'passenger'} */ ('passenger'), pos }));

const GROUND = { suspDamp: 0.6, rolling: 0.7, reverseSpeed: 6, grip: 1.3, lateralGrip: 0.6, turnRate: 0, maxSteer: 0.5, crashDamage: 4 };
const TRACKED = { suspDamp: 0.7, rolling: 0.9, reverseSpeed: 5, grip: 1.7, lateralGrip: 0.8, maxSteer: 0, crashDamage: 2 };
const NO_DRIVE = { wheels: [], wheelRadius: 0, suspRest: 0, suspSag: 0, suspDamp: 0, engineForce: 0, brakeForce: 0, reverseSpeed: 0, grip: 0, lateralGrip: 0, maxSteer: 0 };

/** @type {Record<string, VehicleDef>} */
export const VEHICLE_DEFS = /** @type {any} */ ({
  // ===================================================================== PAMPALONA (placeholders)
  jeep: {
    ...GROUND, type: 'jeep', faction: 'pampalona', kind: 'ground', label: 'SCOUT CAR', armor: 'soft', role: 'transport',
    mass: 1300, health: 420, half: [0.95, 0.42, 2.0], ride: 0.92, openSeats: true,
    wheels: axles(0.95, [1.35, -1.35], 1), wheelRadius: 0.42, suspRest: 0.5, suspSag: 0.2, suspDamp: 0.5,
    engineForce: 11500, brakeForce: 16000, maxSpeed: 25, reverseSpeed: 9, grip: 1.25, lateralGrip: 0.55, maxSteer: 0.6,
    seats: [
      { role: 'driver', pos: [0.45, 1.0, 0.1] }, { role: 'gunner', pos: [0, 1.3, -0.9] },
      { role: 'passenger', pos: [-0.45, 1.0, 0.1] }, { role: 'passenger', pos: [0.45, 1.0, -1.5] },
    ],
    mounts: [{ seat: 1, weapon: 'mountedMG', pos: [0, 2.47, -0.6], barrel: 1.0, turnRate: 3.2, pitchMin: -0.35, pitchMax: 0.8 }],
    camDist: 8.5, camHeight: 3.2, crashDamage: 9,
  },
  tank: {
    ...TRACKED, type: 'tank', faction: 'pampalona', kind: 'ground', label: 'BATTLE TANK', armor: 'heavy', role: 'armor',
    mass: 9500, health: 1700, half: [1.7, 0.62, 3.3], ride: 1.11,
    wheels: tracks(1.45, [-2.5, 0, 2.5]), wheelRadius: 0.5, suspRest: 0.4, suspSag: 0.14,
    engineForce: 42000, brakeForce: 90000, maxSpeed: 10.5, turnRate: 0.85,
    seats: [{ role: 'driver', pos: [0, 1.5, 1.2] }, { role: 'gunner', pos: [0, 2.3, -0.4] }],
    mounts: [
      { seat: 0, weapon: 'cannon', pos: [0, 2.36, 0.1], barrel: 4.6, turnRate: 0.75, pitchMin: -0.14, pitchMax: 0.42 },
      { seat: 1, weapon: 'mountedMG', parent: 0, pos: [0.55, 3.16, -0.3], barrel: 0.9, turnRate: 3, pitchMin: -0.3, pitchMax: 0.9 },
    ],
    camDist: 12.5, camHeight: 4.6,
  },
  heli: {
    ...NO_DRIVE, type: 'heli', faction: 'pampalona', kind: 'heli', label: 'GUNSHIP', armor: 'heli', role: 'heli',
    mass: 2600, health: 680, half: [0.95, 0.85, 2.9], ride: 0.9, maxSpeed: 42, turnRate: 1.5, padRadius: 6.5,
    seats: [{ role: 'driver', pos: [0, 1.0, 1.4] }, { role: 'gunner', pos: [0, 1.1, 0.2] }],
    mounts: [
      { seat: 0, weapon: 'rockets', pos: [0, 0.5, 1.2], barrel: 1.2, turnRate: 0, muzzles: [[1.55, -0.05, 0], [-1.55, -0.05, 0]] },
      { seat: 1, weapon: 'mountedMG', pos: [0, 0.15, 2.3], barrel: 0.9, turnRate: 3.5, pitchMin: -1.1, pitchMax: 0.25 },
    ],
    camDist: 15, camHeight: 4.5, crashDamage: 22,
  },

  // ===================================================================== TORSA
  mbt: {
    ...TRACKED, type: 'mbt', faction: 'torsa', kind: 'ground', label: 'T-90 MBT', armor: 'heavy', role: 'armor',
    mass: 11000, health: 1800, half: [1.65, 0.55, 3.4], ride: 1.1,
    wheels: tracks(1.41, [-2.5, 0, 2.4]), wheelRadius: 0.38, suspRest: 0.42, suspSag: 0.13,
    engineForce: 52000, brakeForce: 100000, maxSpeed: 11, turnRate: 0.8,
    seats: [{ role: 'driver', pos: [0, 1.3, 2.2] }, { role: 'gunner', pos: [0.45, 1.8, 0] }, { role: 'commander', pos: [-0.45, 2.0, 0] }],
    mounts: [
      { seat: 1, fallbackSeat: 0, weapon: 'cannon125', pos: [0, 2.02, 0.25], trunnion: [0, 0, 0.95], barrel: 5.9, turnRate: 0.7, pitchMin: -0.1, pitchMax: 0.3 },
      { seat: 1, fallbackSeat: 0, weapon: 'pkt', coax: 0, offset: [-0.34, 0.02, 0], barrel: 0.6 },
      { seat: 2, weapon: 'kord', parent: 0, pos: [-0.52, 2.66, -0.4], trunnion: [0, 0, 0.12], barrel: 1.05, turnRate: 2.6, pitchMin: -0.2, pitchMax: 0.9 },
    ],
    camDist: 12.5, camHeight: 4.6,
  },
  ht: {
    ...TRACKED, type: 'ht', faction: 'torsa', kind: 'ground', label: 'T-80U HEAVY TANK', armor: 'heavy', role: 'armor',
    mass: 12500, health: 2400, half: [1.7, 0.58, 3.55], ride: 1.12,
    wheels: tracks(1.45, [-2.6, 0, 2.5]), wheelRadius: 0.4, suspRest: 0.42, suspSag: 0.13,
    engineForce: 56000, brakeForce: 110000, maxSpeed: 9.5, turnRate: 0.7,
    seats: [{ role: 'driver', pos: [0, 1.3, 2.3] }, { role: 'gunner', pos: [0.45, 1.85, 0] }, { role: 'commander', pos: [-0.45, 2.05, 0] }],
    mounts: [
      { seat: 1, fallbackSeat: 0, weapon: 'cannon125hv', pos: [0, 2.08, 0.15], trunnion: [0, 0, 1.0], barrel: 6.0, turnRate: 0.6, pitchMin: -0.1, pitchMax: 0.3 },
      { seat: 1, fallbackSeat: 0, weapon: 'pkt', coax: 0, offset: [-0.34, 0.02, 0], barrel: 0.6 },
      { seat: 2, weapon: 'kord', parent: 0, pos: [-0.55, 2.78, -0.45], trunnion: [0, 0, 0.12], barrel: 1.05, turnRate: 2.4, pitchMin: -0.2, pitchMax: 0.9 },
    ],
    camDist: 13, camHeight: 4.8,
  },
  lt: {
    ...TRACKED, type: 'lt', faction: 'torsa', kind: 'ground', label: 'SPRUT-SD LIGHT TANK', armor: 'light', role: 'armor',
    mass: 7000, health: 1100, half: [1.55, 0.65, 3.5], ride: 1.1,
    wheels: tracks(1.3, [-2.6, 0, 2.6]), wheelRadius: 0.32, suspRest: 0.42, suspSag: 0.13,
    engineForce: 36000, brakeForce: 70000, maxSpeed: 15, turnRate: 0.95,
    seats: [{ role: 'driver', pos: [0, 1.4, 2.4] }, { role: 'gunner', pos: [0.4, 1.9, -0.2] }],
    mounts: [
      { seat: 1, fallbackSeat: 0, weapon: 'cannon125', pos: [0, 2.08, -0.2], trunnion: [0, 0, 0.85], barrel: 6.1, turnRate: 0.8, pitchMin: -0.09, pitchMax: 0.3 },
      { seat: 1, fallbackSeat: 0, weapon: 'pkt', coax: 0, offset: [-0.32, 0.03, 0], barrel: 0.6 },
    ],
    camDist: 12.5, camHeight: 4.4,
  },
  apc: {
    ...GROUND, type: 'apc', faction: 'torsa', kind: 'ground', label: 'BTR-90 APC', armor: 'light', role: 'armor',
    mass: 7000, health: 900, half: [1.45, 0.8, 3.75], ride: 1.35,
    wheels: axles(1.3, [2.45, 0.95, -0.95, -2.45], 2), wheelRadius: 0.6, suspRest: 0.5, suspSag: 0.18,
    engineForce: 30000, brakeForce: 60000, maxSpeed: 19, reverseSpeed: 7, grip: 1.3, lateralGrip: 0.6, maxSteer: 0.5,
    seats: [
      { role: 'driver', pos: [0.55, 1.6, 2.6] }, { role: 'gunner', pos: [-0.3, 1.9, 0.9] },
      ...pax([[0.5, 1.5, 0.2], [-0.5, 1.5, 0.2], [0.5, 1.5, -1.0], [-0.5, 1.5, -1.0], [0.5, 1.5, -2.2], [-0.5, 1.5, -2.2]]),
    ],
    mounts: [
      { seat: 1, fallbackSeat: 0, weapon: 'ac30', pos: [0, 2.55, 0.55], trunnion: [0, 0.05, 0.45], barrel: 3.0, turnRate: 1.6, pitchMin: -0.1, pitchMax: 1.0 },
      { seat: 1, fallbackSeat: 0, weapon: 'atgm', coax: 0, offset: [0, 0.48, -0.25], barrel: 1.0 },
      { seat: 1, fallbackSeat: 0, weapon: 'pkt', coax: 0, offset: [-0.26, -0.02, 0], barrel: 0.5 },
    ],
    camDist: 12, camHeight: 4.6, crashDamage: 3,
  },
  ifv: {
    ...TRACKED, type: 'ifv', faction: 'torsa', kind: 'ground', label: 'BMP-2 IFV', armor: 'light', role: 'armor',
    mass: 7500, health: 1000, half: [1.5, 0.6, 3.35], ride: 1.05,
    wheels: tracks(1.27, [-2.3, 0, 2.3]), wheelRadius: 0.39, suspRest: 0.42, suspSag: 0.13,
    engineForce: 36000, brakeForce: 70000, maxSpeed: 14, turnRate: 0.9,
    seats: [
      { role: 'driver', pos: [0.55, 1.2, 2.3] }, { role: 'gunner', pos: [-0.3, 1.6, 0.1] },
      ...pax([[0.45, 1.2, -0.9], [-0.45, 1.2, -0.9], [0.45, 1.2, -1.8], [-0.45, 1.2, -1.8], [0.45, 1.2, -2.6], [-0.45, 1.2, -2.6]]),
    ],
    mounts: [
      { seat: 1, fallbackSeat: 0, weapon: 'ac30', pos: [0, 2.1, -0.25], trunnion: [0, 0.05, 0.5], barrel: 3.0, turnRate: 1.5, pitchMin: -0.1, pitchMax: 1.0 },
      { seat: 1, fallbackSeat: 0, weapon: 'atgm', coax: 0, offset: [0, 0.48, -0.3], barrel: 1.0 },
      { seat: 1, fallbackSeat: 0, weapon: 'pkt', coax: 0, offset: [-0.24, -0.02, 0], barrel: 0.5 },
    ],
    camDist: 12, camHeight: 4.4,
  },
  truck: {
    ...GROUND, type: 'truck', faction: 'torsa', kind: 'ground', label: 'KAMAZ TRANSPORT', armor: 'soft', role: 'transport',
    mass: 6500, health: 450, half: [1.25, 0.85, 3.9], ride: 1.6,
    wheels: axles(1.0, [2.75, -1.45, -2.85], 1), wheelRadius: 0.6, suspRest: 0.5, suspSag: 0.16,
    engineForce: 24000, brakeForce: 50000, maxSpeed: 20, reverseSpeed: 7, grip: 1.2, lateralGrip: 0.55, maxSteer: 0.55,
    seats: [
      { role: 'driver', pos: [0.55, 1.95, 2.9] }, { role: 'passenger', pos: [-0.55, 1.95, 2.9] },
      ...pax([[0.6, 1.75, -0.4], [-0.6, 1.75, -0.4], [0.6, 1.75, -1.6], [-0.6, 1.75, -1.6], [0.6, 1.75, -2.8], [-0.6, 1.75, -2.8]]),
    ],
    mounts: [], camDist: 13, camHeight: 4.6, crashDamage: 5,
  },
  supply: {
    ...GROUND, type: 'supply', faction: 'torsa', kind: 'ground', label: 'KAMAZ SUPPLY', armor: 'soft', role: 'supply',
    mass: 6200, health: 450, half: [1.25, 0.85, 3.8], ride: 1.6,
    wheels: axles(1.0, [2.6, -1.35, -2.7], 1), wheelRadius: 0.6, suspRest: 0.5, suspSag: 0.16,
    engineForce: 24000, brakeForce: 50000, maxSpeed: 20, reverseSpeed: 7, grip: 1.2, lateralGrip: 0.55, maxSteer: 0.55,
    seats: [{ role: 'driver', pos: [0.55, 1.95, 2.75] }, { role: 'passenger', pos: [-0.55, 1.95, 2.75] }],
    mounts: [], camDist: 13, camHeight: 4.6, crashDamage: 5,
  },
  mlrs: {
    ...GROUND, type: 'mlrs', faction: 'torsa', kind: 'ground', label: 'URAGAN-1M MLRS', armor: 'soft', role: 'artillery',
    mass: 9500, health: 700, half: [1.45, 0.9, 6.2], ride: 1.75,
    wheels: axles(1.1, [4.3, 2.75, -2.0, -3.6], 2), wheelRadius: 0.68, suspRest: 0.55, suspSag: 0.18,
    engineForce: 32000, brakeForce: 70000, maxSpeed: 17, reverseSpeed: 6, grip: 1.2, lateralGrip: 0.55, maxSteer: 0.45,
    seats: [{ role: 'driver', pos: [0.6, 2.3, 5.2] }, { role: 'gunner', pos: [-0.6, 2.3, 5.2] }],
    mounts: [{
      seat: 1, fallbackSeat: 0, weapon: 'mlrs', pos: [0, 2.75, -5.3], trunnion: [0, 0, 0], barrel: 7.5, turnRate: 0.4,
      yawMin: -0.8, yawMax: 0.8, pitchMin: 0.2, pitchMax: 1.0,
      muzzles: [0.95, 0.4, -0.4, -0.95].flatMap((x) => [0.28, 0.72].map((y) => [x, y, 0])).concat([[0.95, 1.05, 0], [0.4, 1.05, 0], [-0.4, 1.05, 0], [-0.95, 1.05, 0]]),
    }],
    camDist: 18, camHeight: 6.5, crashDamage: 4,
  },
  howitzer: {
    ...TRACKED, type: 'howitzer', faction: 'torsa', kind: 'ground', label: 'MSTA-S HOWITZER', armor: 'light', role: 'artillery',
    mass: 10500, health: 1300, half: [1.65, 0.6, 3.4], ride: 1.1,
    wheels: tracks(1.38, [-2.5, 0, 2.5]), wheelRadius: 0.38, suspRest: 0.42, suspSag: 0.13,
    engineForce: 46000, brakeForce: 100000, maxSpeed: 10, turnRate: 0.7,
    seats: [{ role: 'driver', pos: [0, 1.3, 2.3] }, { role: 'gunner', pos: [0.6, 2.2, -0.6] }, { role: 'commander', pos: [-0.7, 2.6, -1.2] }],
    mounts: [
      { seat: 1, fallbackSeat: 0, weapon: 'howitzer', pos: [0, 2.35, -0.55], trunnion: [0, 0.1, 1.75], barrel: 6.7, turnRate: 0.35, pitchMin: -0.05, pitchMax: 1.1 },
      { seat: 2, weapon: 'kord', parent: 0, pos: [-0.8, 3.62, -1.3], trunnion: [0, 0, 0.12], barrel: 1.05, turnRate: 2.4, pitchMin: -0.25, pitchMax: 0.9 },
    ],
    camDist: 14, camHeight: 5.2,
  },
  sam: {
    ...GROUND, type: 'sam', faction: 'torsa', kind: 'ground', label: 'PANTSIR-S1 SAM', armor: 'soft', role: 'aa',
    mass: 8500, health: 800, half: [1.25, 0.9, 4.75], ride: 1.65,
    wheels: axles(1.05, [3.15, 1.75, -1.6, -3.0], 2), wheelRadius: 0.6, suspRest: 0.5, suspSag: 0.16,
    engineForce: 30000, brakeForce: 60000, maxSpeed: 18, reverseSpeed: 7, grip: 1.2, lateralGrip: 0.55, maxSteer: 0.45,
    seats: [{ role: 'driver', pos: [0.55, 1.95, 3.7] }, { role: 'gunner', pos: [-0.55, 1.95, 3.7] }],
    mounts: [
      {
        seat: 1, fallbackSeat: 0, weapon: 'aa30', pos: [0, 3.2, -2.0], trunnion: [0, 0.45, 0.2], barrel: 1.7, turnRate: 1.6, pitchMin: -0.05, pitchMax: 1.3,
        muzzles: [[1.3, -0.22, 0], [-1.3, -0.22, 0], [1.3, 0.02, 0], [-1.3, 0.02, 0]],
      },
      { seat: 1, fallbackSeat: 0, weapon: 'sam', coax: 0, offset: [0, 0, 0], barrel: 1.6, muzzles: [0.78, -0.78, 1.02, -1.02].flatMap((x) => [0.36, 0.63, 0.9].map((y) => [x, y, 0])) },
    ],
    camDist: 14, camHeight: 5.5, crashDamage: 5,
  },
  spaag: {
    ...TRACKED, type: 'spaag', faction: 'torsa', kind: 'ground', label: 'SHILKA SPAAG', armor: 'light', role: 'aa',
    mass: 7000, health: 800, half: [1.5, 0.56, 3.25], ride: 0.98,
    wheels: tracks(1.22, [-2.3, 0, 2.3]), wheelRadius: 0.33, suspRest: 0.4, suspSag: 0.13,
    engineForce: 33000, brakeForce: 70000, maxSpeed: 13, turnRate: 0.9,
    seats: [{ role: 'driver', pos: [0.5, 1.2, 2.3] }, { role: 'gunner', pos: [-0.4, 1.8, 0] }],
    mounts: [{
      seat: 1, fallbackSeat: 0, weapon: 'aa23', pos: [0, 1.98, 0.3], trunnion: [0, 0.18, 1.0], barrel: 2.1, turnRate: 1.8, pitchMin: -0.07, pitchMax: 1.4,
      muzzles: [[0.3, 0.2, 0], [-0.3, 0.2, 0], [0.3, -0.04, 0], [-0.3, -0.04, 0]],
    }],
    camDist: 12, camHeight: 4.4,
  },
  attackheli: {
    ...NO_DRIVE, type: 'attackheli', faction: 'torsa', kind: 'heli', label: 'KA-52 ATTACK HELO', armor: 'heli', role: 'heli',
    mass: 3000, health: 760, half: [0.95, 1.48, 4.4], ride: 1.5, maxSpeed: 44, turnRate: 1.4, padRadius: 7.5,
    seats: [{ role: 'driver', pos: [0.35, 1.7, 2.7] }, { role: 'gunner', pos: [-0.35, 1.7, 2.7] }],
    mounts: [
      { seat: 0, weapon: 'rockets80', pos: [0, 1.05, 0.45], barrel: 1.3, turnRate: 0, muzzles: [[2.35, -0.05, 0], [-2.35, -0.05, 0]] },
      { seat: 0, weapon: 'vikhr', pos: [0, 1.2, 0.5], barrel: 1.6, turnRate: 0, muzzles: [[3.05, 0, 0], [-3.05, 0, 0]] },
      { seat: 1, weapon: 'gsh30', pos: [-0.88, 0.95, 0.9], trunnion: [0, 0, 0.2], barrel: 2.2, turnRate: 2.2, yawMin: -0.9, yawMax: 0.15, pitchMin: -0.7, pitchMax: 0.15 },
    ],
    camDist: 17, camHeight: 5, crashDamage: 22,
  },
  transportheli: {
    ...NO_DRIVE, type: 'transportheli', faction: 'torsa', kind: 'heli', label: 'MI-8 TRANSPORT HELO', armor: 'heli', role: 'airlift',
    mass: 5200, health: 950, half: [1.2, 1.78, 4.7], ride: 1.8, maxSpeed: 40, turnRate: 1.0, padRadius: 9,
    seats: [
      { role: 'driver', pos: [0.4, 2.1, 4.4] }, { role: 'gunner', pos: [0.85, 1.5, 3.1] }, { role: 'gunner', pos: [-0.85, 1.5, -2.2] },
      ...pax([[0.6, 1.4, 1.6], [-0.6, 1.4, 1.6], [0.6, 1.4, 0.4], [-0.6, 1.4, 0.4], [0.6, 1.4, -0.8], [-0.6, 1.4, -0.8]]),
    ],
    mounts: [
      { seat: 0, weapon: 'rockets80', pos: [0, 1.0, 0.6], barrel: 1.2, turnRate: 0, muzzles: [[2.05, 0, 0], [-2.05, 0, 0]] },
      { seat: 1, weapon: 'pkt', pos: [1.2, 1.95, 3.1], trunnion: [0, 0, 0.1], barrel: 0.9, turnRate: 2.5, yawMin: 0.35, yawMax: 2.6, pitchMin: -0.9, pitchMax: 0.3 },
      { seat: 2, weapon: 'pkt', pos: [-1.2, 1.95, -2.2], trunnion: [0, 0, 0.1], barrel: 0.9, turnRate: 2.5, yawMin: -2.6, yawMax: -0.35, pitchMin: -0.9, pitchMax: 0.3 },
    ],
    camDist: 20, camHeight: 6, crashDamage: 22,
  },
  strikejet: {
    ...NO_DRIVE, type: 'strikejet', faction: 'torsa', kind: 'jet', label: 'SU-25 STRIKE JET', armor: 'jet', role: 'jet',
    mass: 9000, health: 700, half: [1.6, 0.75, 5.4], ride: 1.55, maxSpeed: 95, turnRate: 0.35, padRadius: 7,
    wheels: [{ x: 0, z: 3.1, steer: true }, { x: 1.7, z: -0.6 }, { x: -1.7, z: -0.6 }],
    wheelRadius: 0.35, suspRest: 0.35, suspSag: 0.1, suspDamp: 0.6, brakeForce: 30000, grip: 1.2, lateralGrip: 0.6, maxSteer: 0.35, rolling: 0.03,
    flight: { stall: 36, thrust: 7.2, pitchRate: 1.25, rollRate: 2.4, yawRate: 0.35 },
    seats: [{ role: 'driver', pos: [0, 2.3, 3.4] }],
    mounts: [
      { seat: 0, weapon: 'gsh30', pos: [0.32, 1.25, 4.4], barrel: 0.8, turnRate: 0 },
      { seat: 0, weapon: 'rockets80', pos: [0, 1.15, 0.6], barrel: 1.3, turnRate: 0, muzzles: [[2.7, -0.3, 0], [-2.7, -0.3, 0], [3.5, -0.25, 0], [-3.5, -0.25, 0]] },
      { seat: 0, weapon: 'bomb500', pos: [0, 0.95, 0], barrel: 0, turnRate: 0, muzzles: [[1.7, -0.4, 0], [-1.7, -0.4, 0], [2.2, -0.35, 0], [-2.2, -0.35, 0]] },
    ],
    camDist: 17, camHeight: 4.2, crashDamage: 30,
  },
  fighter: {
    ...NO_DRIVE, type: 'fighter', faction: 'torsa', kind: 'jet', label: 'SU-30 FIGHTER', armor: 'jet', role: 'jet',
    mass: 11000, health: 620, half: [1.9, 0.75, 7.0], ride: 1.75, maxSpeed: 115, turnRate: 0.45, padRadius: 8,
    wheels: [{ x: 0, z: 4.6, steer: true }, { x: 2.0, z: -0.8 }, { x: -2.0, z: -0.8 }],
    wheelRadius: 0.38, suspRest: 0.4, suspSag: 0.1, suspDamp: 0.6, brakeForce: 36000, grip: 1.2, lateralGrip: 0.6, maxSteer: 0.3, rolling: 0.03,
    flight: { stall: 40, thrust: 9.3, pitchRate: 1.6, rollRate: 3.2, yawRate: 0.45 },
    seats: [{ role: 'driver', pos: [0, 2.6, 5.1] }],
    mounts: [
      { seat: 0, weapon: 'gsh30', pos: [0.85, 1.95, 3.6], barrel: 0.6, turnRate: 0 },
      { seat: 0, weapon: 'aam', pos: [0, 1.95, 0], barrel: 1.4, turnRate: 0, muzzles: [[5.3, 0.15, -1.6], [-5.3, 0.15, -1.6], [3.4, -0.2, -1.0], [-3.4, -0.2, -1.0]] },
      { seat: 0, weapon: 'rockets80', pos: [0, 1.85, 0], barrel: 1.2, turnRate: 0, muzzles: [[4.35, -0.25, -1.4], [-4.35, -0.25, -1.4]] },
    ],
    camDist: 20, camHeight: 4.8, crashDamage: 30,
  },
});

/** Converts authoring coordinates into body-local ones and derives seat → mount tables. */
function normalize(def) {
  const r = def.ride;
  const gy = (p) => (p ? [p[0], p[1] - r, p[2]] : p);
  def.seats = def.seats.map((s) => ({ ...s, pos: gy(s.pos) }));
  def.mounts = def.mounts.map((m) => ({ turnRate: 0, pitchMin: -1.4, pitchMax: 1.4, trunnion: [0, 0, 0], barrel: 1, ...m, pos: m.pos ? gy(m.pos) : undefined }));
  for (const m of def.mounts) {
    if (m.coax !== undefined) {
      const p = def.mounts[m.coax];
      m.pos = p.pos; m.trunnion = p.trunnion; m.turnRate = p.turnRate;
    }
  }
  // Ray origin height: wheel hub at wheelRadius when the spring is at its rest sag.
  const rayY = def.suspRest + def.wheelRadius - def.suspSag - r;
  def.wheels = def.wheels.map((w) => ({ steer: false, driven: def.kind === 'ground', ...w, pos: [w.x, rayY, w.z] }));
  def.seatMounts = def.seats.map((_, i) => def.mounts.map((m, k) => (m.seat === i ? k : -1)).filter((k) => k >= 0));
  // Crew weapons fall back to another seat (the driver) while their own seat is empty.
  def.fallbackFrom = def.seats.map((_, i) => {
    const m = def.mounts.find((mm) => mm.fallbackSeat === i);
    return m ? m.seat : -1;
  });
  def.seatMountsFallback = def.seats.map((_, i) => def.mounts.map((m, k) => (m.seat === i || m.fallbackSeat === i ? k : -1)).filter((k) => k >= 0));
  def.passengers = def.seats.filter((s) => s.role === 'passenger').length;
  def.padRadius = def.padRadius || Math.hypot(def.half[0], def.half[2]) * 0.92 + 0.6;
  def.rolling = def.rolling ?? 0.7;
  return def;
}
for (const k in VEHICLE_DEFS) normalize(VEHICLE_DEFS[k]);
