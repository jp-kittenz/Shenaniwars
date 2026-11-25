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
 * @property {boolean} [aa]        anti-aircraft duty: the crew of this mount engages aircraft (ground air defence)
 */
/**
 * @typedef {Object} SeatDef
 * @property {'driver'|'gunner'|'commander'|'passenger'|'rider'} role
 * @property {number[]} pos        seat surface
 * @property {boolean} [exterior]  outside the hull (riders on the deck): visible and exposed to fire
 * @property {number} [face]       rider: facing relative to the hull (rad, +π/2 = out to the left)
 * @property {number} [pose]       rider: 0 legs over the side, 1 knees up, 2 kneeling
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
 * @property {boolean} [static] fixed emplacement (no drive, fixed rigid body)
 * @property {number} [padRadius]  parking footprint radius
 * @property {Object} [flight]     fixed-wing parameters
 * @property {number[][]} seatMounts  mount indices a seat owns (filled by normalize)
 * @property {number[][]} seatMountsFallback  owned mounts plus those that fall back to the seat
 * @property {number[]} fallbackFrom  per seat: the seat whose weapons it takes over when that seat is empty (-1)
 * @property {number} passengers   passenger seat count (filled by normalize)
 * @property {number} riders       exterior rider positions (filled by normalize)
 */

const tracks = (x, zs) => zs.flatMap((z) => [{ x, z, driven: true }, { x: -x, z, driven: true }]);
const axles = (x, zs, steerCount) => zs.flatMap((z, i) => [
  { x, z, steer: i < steerCount, driven: true }, { x: -x, z, steer: i < steerCount, driven: true },
]);
const pax = (rows) => rows.map((pos) => ({ role: /** @type {'passenger'} */ ('passenger'), pos }));
/**
 * Exterior riders on an armoured hull (tank desant): [x, y, z, face, pose]
 * per position, on the deck surface, facing outward over the side or back.
 */
const riders = (rows) => rows.map(([x, y, z, face, pose]) => ({ role: /** @type {'rider'} */ ('rider'), pos: [x, y, z], exterior: true, face, pose }));
const L = Math.PI / 2, R = -Math.PI / 2, B = Math.PI;
/** BM-21: 40 tubes, 4 rows of 10. */
const GRAD_MUZZLES = [[-0.62, -0.12, 0], [-0.48, -0.12, 0], [-0.34, -0.12, 0], [-0.21, -0.12, 0], [-0.07, -0.12, 0], [0.07, -0.12, 0], [0.21, -0.12, 0], [0.35, -0.12, 0], [0.48, -0.12, 0], [0.62, -0.12, 0], [-0.62, 0.08, 0], [-0.48, 0.08, 0], [-0.34, 0.08, 0], [-0.21, 0.08, 0], [-0.07, 0.08, 0], [0.07, 0.08, 0], [0.21, 0.08, 0], [0.35, 0.08, 0], [0.48, 0.08, 0], [0.62, 0.08, 0], [-0.62, 0.28, 0], [-0.48, 0.28, 0], [-0.34, 0.28, 0], [-0.21, 0.28, 0], [-0.07, 0.28, 0], [0.07, 0.28, 0], [0.21, 0.28, 0], [0.35, 0.28, 0], [0.48, 0.28, 0], [0.62, 0.28, 0], [-0.62, 0.48, 0], [-0.48, 0.48, 0], [-0.34, 0.48, 0], [-0.21, 0.48, 0], [-0.07, 0.48, 0], [0.07, 0.48, 0], [0.21, 0.48, 0], [0.35, 0.48, 0], [0.48, 0.48, 0], [0.62, 0.48, 0]];

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
    // Pintle MG: Pampalona's only air defence, so its gunner is tasked against aircraft first.
    mounts: [{ seat: 1, weapon: 'mountedMG', aa: true, pos: [0, 2.47, -0.6], barrel: 1.0, turnRate: 3.2, pitchMin: -0.35, pitchMax: 1.1 }],
    camDist: 8.5, camHeight: 3.2, crashDamage: 9,
  },
  tank: {
    ...TRACKED, type: 'tank', faction: 'pampalona', kind: 'ground', label: 'BATTLE TANK', armor: 'heavy', role: 'armor',
    mass: 9500, health: 1700, half: [1.7, 0.62, 3.3], ride: 1.11,
    wheels: tracks(1.45, [-2.5, 0, 2.5]), wheelRadius: 0.5, suspRest: 0.4, suspSag: 0.14,
    engineForce: 42000, brakeForce: 90000, maxSpeed: 10.5, turnRate: 0.85,
    seats: [
      { role: 'driver', pos: [0, 1.5, 1.2] }, { role: 'gunner', pos: [0, 2.3, -0.4] },
      ...riders([[1.3, 1.74, -1.4, L, 0], [1.3, 1.74, -2.4, L, 1], [-1.3, 1.74, -1.6, R, 0], [-1.3, 1.74, -2.6, R, 0], [0.55, 1.74, -3.0, B, 2], [-0.55, 1.74, -3.05, B, 0]]),
    ],
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
      // Chin turret autocannon: the gunner works it; with no gunner aboard the pilot does.
      { seat: 1, fallbackSeat: 0, weapon: 'gsh30', pos: [0, 0.15, 2.3], barrel: 0.9, turnRate: 3.0, pitchMin: -1.1, pitchMax: 0.25 },
    ],
    camDist: 15, camHeight: 4.5, crashDamage: 22,
  },

  // ===================================================================== TORSA
  mbt: {
    ...TRACKED, type: 'mbt', faction: 'torsa', kind: 'ground', label: 'T-90 MBT', armor: 'heavy', role: 'armor',
    mass: 11000, health: 1800, half: [1.65, 0.55, 3.4], ride: 1.1,
    wheels: tracks(1.41, [-2.5, 0, 2.4]), wheelRadius: 0.38, suspRest: 0.42, suspSag: 0.13,
    engineForce: 52000, brakeForce: 100000, maxSpeed: 11, turnRate: 0.8,
    seats: [
      { role: 'driver', pos: [0, 1.3, 2.2] }, { role: 'gunner', pos: [0.45, 1.8, 0] }, { role: 'commander', pos: [-0.45, 2.0, 0] },
      ...riders([[1.25, 1.66, -1.4, L, 0], [1.25, 1.66, -2.4, L, 0], [-1.25, 1.66, -1.6, R, 1], [-1.25, 1.66, -2.6, R, 0], [0.5, 1.66, -3.1, B, 0], [-0.5, 1.66, -3.1, B, 2]]),
    ],
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
    seats: [
      { role: 'driver', pos: [0, 1.3, 2.3] }, { role: 'gunner', pos: [0.45, 1.85, 0] }, { role: 'commander', pos: [-0.45, 2.05, 0] },
      ...riders([[1.3, 1.71, -1.5, L, 0], [1.3, 1.71, -2.5, L, 1], [-1.3, 1.71, -1.7, R, 0], [-1.3, 1.71, -2.7, R, 0], [0.55, 1.71, -3.25, B, 2], [-0.55, 1.71, -3.25, B, 0]]),
    ],
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
    seats: [
      { role: 'driver', pos: [0, 1.4, 2.4] }, { role: 'gunner', pos: [0.4, 1.9, -0.2] },
      ...riders([[1.2, 1.76, -1.7, L, 0], [1.2, 1.76, -2.7, L, 0], [-1.2, 1.76, -1.9, R, 1], [-0.5, 1.76, -3.25, B, 2]]),
    ],
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
      ...riders([[1.05, 2.15, -1.2, L, 0], [-1.05, 2.15, -1.6, R, 0], [1.0, 2.15, -2.6, L, 1], [-0.6, 2.15, -3.2, B, 2]]),
    ],
    mounts: [
      { seat: 1, fallbackSeat: 0, weapon: 'ac30', pos: [0, 2.55, 0.55], trunnion: [0, 0.05, 0.45], barrel: 3.0, turnRate: 1.6, pitchMin: -0.1, pitchMax: 1.0 },
      { seat: 1, fallbackSeat: 0, weapon: 'atgm', coax: 0, offset: [0, 0.48, -0.25], barrel: 1.0 },
      { seat: 1, fallbackSeat: 0, weapon: 'pkt', coax: 0, offset: [-0.26, -0.02, 0], barrel: 0.5 },
    ],
    camDist: 12, camHeight: 4.6, crashDamage: 3,
  },
  ifv: {
    ...TRACKED, type: 'ifv', faction: 'torsa', kind: 'ground', label: 'BMP-2 AMPH-IFV', armor: 'light', role: 'armor', amphibious: true,
    mass: 7500, health: 1000, half: [1.5, 0.6, 3.35], ride: 1.05,
    wheels: tracks(1.27, [-2.3, 0, 2.3]), wheelRadius: 0.39, suspRest: 0.42, suspSag: 0.13,
    engineForce: 36000, brakeForce: 70000, maxSpeed: 14, turnRate: 0.9,
    seats: [
      { role: 'driver', pos: [0.55, 1.2, 2.3] }, { role: 'gunner', pos: [-0.3, 1.6, 0.1] },
      ...pax([[0.45, 1.2, -0.9], [-0.45, 1.2, -0.9], [0.45, 1.2, -1.8], [-0.45, 1.2, -1.8], [0.45, 1.2, -2.6], [-0.45, 1.2, -2.6]]),
      ...riders([[1.2, 1.66, -1.3, L, 0], [-1.2, 1.66, -1.5, R, 1], [1.2, 1.66, -2.4, L, 0], [-0.5, 1.66, -3.0, B, 2]]),
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
    ...GROUND, type: 'supply', faction: 'torsa', kind: 'ground', label: 'CST KAMAZ-63501', armor: 'soft', role: 'supply', supplyUses: 14,
    mass: 9500, health: 620, half: [1.25, 0.85, 4.8], ride: 1.65,
    wheels: axles(1.0, [3.39, 1.45, -1.9, -3.22], 2), wheelRadius: 0.62, suspRest: 0.5, suspSag: 0.16,
    engineForce: 30000, brakeForce: 62000, maxSpeed: 20, reverseSpeed: 7, grip: 1.25, lateralGrip: 0.56, maxSteer: 0.45,
    seats: [{ role: 'driver', pos: [0.55, 2.15, 4.0] }, { role: 'gunner', pos: [-0.5, 2.45, 3.5] }, { role: 'passenger', pos: [-0.55, 2.15, 4.15] }],
    mounts: [{ seat: 1, fallbackSeat: 0, weapon: 'kord', pos: [-0.5, 3.45, 3.5], trunnion: [0, 0.15, 0.05], barrel: 1.45, turnRate: 2.0, pitchMin: -0.25, pitchMax: 1.0 }],
    camDist: 15, camHeight: 5, crashDamage: 5,
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
      // 30 mm on an independent gimbal: a ±80° yaw / −70°…+12° pitch cone at a realistic slew rate.
      // Side-mounted 30 mm cannon: the co-pilot / operator works it; flying alone, the pilot does.
      { seat: 1, fallbackSeat: 0, weapon: 'gsh30', pos: [-0.88, 0.95, 0.9], trunnion: [0, 0, 0.2], barrel: 2.2, turnRate: 1.6, yawMin: -1.4, yawMax: 1.4, pitchMin: -1.22, pitchMax: 0.2 },
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
    seats: [{ role: 'driver', pos: [0, 1.75, 3.4] }],
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
    seats: [{ role: 'driver', pos: [0, 2.2, 5.1] }],
    mounts: [
      { seat: 0, weapon: 'gsh30', pos: [0.85, 1.95, 3.6], barrel: 0.6, turnRate: 0 },
      { seat: 0, weapon: 'aam', pos: [0, 1.95, 0], barrel: 1.4, turnRate: 0, muzzles: [[5.3, 0.15, -1.6], [-5.3, 0.15, -1.6], [3.4, -0.2, -1.0], [-3.4, -0.2, -1.0]] },
      { seat: 0, weapon: 'rockets80', pos: [0, 1.85, 0], barrel: 1.2, turnRate: 0, muzzles: [[4.35, -0.25, -1.4], [-4.35, -0.25, -1.4]] },
    ],
    camDist: 20, camHeight: 4.8, crashDamage: 30,
  },

  // ===================================================================== TORSA EXPANSION (Milestone 1)
  // Hand-built from the reference blueprints (src/entities/models/torsa-expansion.js), Torsa only.
  ifv2: {
    ...TRACKED, type: 'ifv2', faction: 'torsa', kind: 'ground', label: 'KURGANETS-25 IFV', armor: 'light', role: 'armor',
    mass: 9000, health: 1300, half: [1.5, 0.85, 3.55], ride: 1.35,
    wheels: tracks(1.32, [-2.7, 0, 2.6]), wheelRadius: 0.36, suspRest: 0.44, suspSag: 0.13,
    engineForce: 48000, brakeForce: 85000, maxSpeed: 17, turnRate: 0.95,
    seats: [
      { role: 'driver', pos: [0.55, 1.55, 2.3] }, { role: 'gunner', pos: [-0.3, 1.75, -0.4] }, { role: 'commander', pos: [0.4, 1.75, -0.9] },
      ...pax([[0.55, 1.3, -1.6], [-0.55, 1.3, -1.6], [0.55, 1.3, -2.35], [-0.55, 1.3, -2.35], [0.55, 1.3, -3.05], [-0.55, 1.3, -3.05], [0, 1.3, -1.95]]),
      ...riders([[1.25, 2.25, 0.9, L, 0], [-1.25, 2.25, 0.5, R, 1]]),
    ],
    mounts: [
      { seat: 1, fallbackSeat: 0, weapon: 'ac30', pos: [0, 2.22, -0.6], trunnion: [0, 0.32, 1.0], barrel: 3.0, turnRate: 1.6, pitchMin: -0.12, pitchMax: 1.0 },
      { seat: 1, fallbackSeat: 0, weapon: 'atgm', coax: 0, offset: [1.2, 0.03, -1.4], barrel: 0.7 },
      { seat: 1, fallbackSeat: 0, weapon: 'pkt', coax: 0, offset: [-0.24, -0.04, 0], barrel: 0.7 },
    ],
    camDist: 13, camHeight: 4.8,
  },
  atcst: {
    ...GROUND, type: 'atcst', faction: 'torsa', kind: 'ground', label: 'AT-CST KAMAZ-44108', armor: 'soft', role: 'supply', supplyUses: 10,
    mass: 7000, health: 560, half: [1.25, 0.85, 3.6], ride: 1.6,
    wheels: axles(1.0, [2.55, -1.75], 1), wheelRadius: 0.6, suspRest: 0.5, suspSag: 0.16,
    engineForce: 24000, brakeForce: 50000, maxSpeed: 21, reverseSpeed: 7, grip: 1.25, lateralGrip: 0.58, maxSteer: 0.55,
    seats: [{ role: 'driver', pos: [0.55, 2.05, 2.9] }, { role: 'gunner', pos: [-0.55, 2.05, 2.9] }],
    mounts: [{ seat: 1, fallbackSeat: 0, weapon: 'atgm', pos: [0, 2.05, -2.75], trunnion: [0, 0.25, 0.05], barrel: 1.25, turnRate: 1.2, pitchMin: -0.15, pitchMax: 0.5,
      muzzles: [[0.42, 0.12, 0], [-0.42, 0.12, 0], [0.42, -0.12, 0], [-0.42, -0.12, 0]] }],
    camDist: 13, camHeight: 4.6, crashDamage: 5,
  },
  ost: {
    ...GROUND, type: 'ost', faction: 'torsa', kind: 'ground', label: 'OST ARMOURED SUPPLY', armor: 'light', role: 'supply', supplyUses: 24, protectedCargo: true,
    mass: 12000, health: 1700, half: [1.3, 0.95, 4.25], ride: 1.75,
    wheels: axles(1.0, [2.48, -1.21, -2.53], 1), wheelRadius: 0.65, suspRest: 0.55, suspSag: 0.17,
    engineForce: 34000, brakeForce: 70000, maxSpeed: 19, reverseSpeed: 7, grip: 1.25, lateralGrip: 0.58, maxSteer: 0.5,
    seats: [{ role: 'driver', pos: [0.55, 2.3, 3.1] }, { role: 'passenger', pos: [-0.55, 2.3, 3.1] }],
    mounts: [], camDist: 14, camHeight: 5, crashDamage: 3,
  },
  uaz: {
    ...GROUND, type: 'uaz', faction: 'torsa', kind: 'ground', label: 'UAZ-469 JEEP', armor: 'soft', role: 'transport',
    mass: 1650, health: 380, half: [0.82, 0.42, 1.95], ride: 0.92,
    wheels: axles(0.72, [1.19, -1.19], 1), wheelRadius: 0.37, suspRest: 0.38, suspSag: 0.12,
    engineForce: 9000, brakeForce: 16000, maxSpeed: 24, reverseSpeed: 8, grip: 1.3, lateralGrip: 0.62, maxSteer: 0.6,
    seats: [{ role: 'driver', pos: [0.38, 1.0, 0.35] }, { role: 'passenger', pos: [-0.38, 1.0, 0.35] }, ...pax([[0.38, 1.0, -0.75], [-0.38, 1.0, -0.75]])],
    mounts: [], camDist: 9, camHeight: 3.6, crashDamage: 5,
  },
  tigr: {
    ...GROUND, type: 'tigr', faction: 'torsa', kind: 'ground', label: 'TIGR-M QRF', armor: 'light', role: 'armor',
    mass: 7200, health: 720, half: [1.15, 0.7, 2.8], ride: 1.25,
    wheels: axles(0.95, [1.85, -1.45], 1), wheelRadius: 0.53, suspRest: 0.48, suspSag: 0.15,
    engineForce: 24000, brakeForce: 50000, maxSpeed: 23, reverseSpeed: 8, grip: 1.3, lateralGrip: 0.6, maxSteer: 0.55,
    seats: [
      { role: 'driver', pos: [0.5, 1.3, 0.3] }, { role: 'gunner', pos: [0, 1.35, -0.25] },
      { role: 'passenger', pos: [-0.5, 1.3, 0.3] }, ...pax([[0.5, 1.3, -0.95], [-0.5, 1.3, -0.95]]),
    ],
    mounts: [{ seat: 1, fallbackSeat: 0, weapon: 'kord', pos: [0, 2.62, -0.25], trunnion: [0, 0.12, 0.1], barrel: 1.45, turnRate: 2.2, pitchMin: -0.3, pitchMax: 1.0 }],
    camDist: 11, camHeight: 4.2, crashDamage: 3,
  },
  brdm: {
    ...GROUND, type: 'brdm', faction: 'torsa', kind: 'ground', label: 'BRDM-2 RECON', armor: 'light', role: 'armor', observer: true, amphibious: true,
    mass: 7000, health: 760, half: [1.1, 0.62, 2.85], ride: 1.2,
    wheels: axles(0.95, [1.4, -1.7], 1), wheelRadius: 0.55, suspRest: 0.48, suspSag: 0.15,
    engineForce: 22000, brakeForce: 48000, maxSpeed: 22, reverseSpeed: 8, grip: 1.3, lateralGrip: 0.6, maxSteer: 0.5,
    seats: [{ role: 'driver', pos: [0.42, 1.35, 1.3] }, { role: 'gunner', pos: [0, 1.5, -0.05] }, { role: 'commander', pos: [-0.42, 1.35, 1.3] }, ...pax([[0.4, 1.3, -1.2]])],
    mounts: [
      { seat: 1, fallbackSeat: 0, weapon: 'kord', pos: [0, 1.95, -0.05], trunnion: [0, 0.25, 0.25], barrel: 1.42, turnRate: 1.8, pitchMin: -0.1, pitchMax: 0.9 },
      { seat: 1, fallbackSeat: 0, weapon: 'pkt', coax: 0, offset: [0.2, -0.02, 0], barrel: 0.75 },
    ],
    camDist: 11, camHeight: 4.2, crashDamage: 3,
  },
  cev: {
    ...TRACKED, type: 'cev', faction: 'torsa', kind: 'ground', label: 'IMR-2 ENGINEER', armor: 'heavy', role: 'armor', engineer: true,
    mass: 12000, health: 1700, half: [1.6, 0.6, 3.3], ride: 1.1,
    wheels: tracks(1.32, [-2.45, 0, 2.35]), wheelRadius: 0.42, suspRest: 0.46, suspSag: 0.13,
    engineForce: 50000, brakeForce: 100000, maxSpeed: 11, turnRate: 0.7,
    seats: [{ role: 'driver', pos: [0.75, 1.9, 0.6] }, { role: 'gunner', pos: [0.75, 1.95, 0.0] }, { role: 'passenger', pos: [-0.6, 1.75, -1.3] }],
    mounts: [{ seat: 1, fallbackSeat: 0, weapon: 'kord', pos: [0.75, 2.85, 0.4], trunnion: [0, 0.1, 0.05], barrel: 1.45, turnRate: 2.0, pitchMin: -0.2, pitchMax: 1.0 }],
    camDist: 14, camHeight: 5,
  },
  grad: {
    ...GROUND, type: 'grad', faction: 'torsa', kind: 'ground', label: 'BM-21 GRAD MLRS', armor: 'soft', role: 'artillery',
    mass: 8000, health: 600, half: [1.25, 0.85, 3.65], ride: 1.6,
    wheels: axles(1.0, [2.41, -1.12, -2.52], 1), wheelRadius: 0.58, suspRest: 0.5, suspSag: 0.16,
    engineForce: 26000, brakeForce: 55000, maxSpeed: 19, reverseSpeed: 7, grip: 1.2, lateralGrip: 0.55, maxSteer: 0.5,
    seats: [{ role: 'driver', pos: [0.5, 2.0, 1.55] }, { role: 'gunner', pos: [-0.5, 2.0, 1.55] }, { role: 'commander', pos: [0, 2.0, 1.15] }],
    mounts: [{
      seat: 1, fallbackSeat: 0, weapon: 'grad', pos: [0, 1.95, -2.4], trunnion: [0, 0.3, -0.75], barrel: 3.0, turnRate: 0.5,
      yawMin: -1.6, yawMax: 1.6, pitchMin: 0.15, pitchMax: 0.95, muzzles: GRAD_MUZZLES,
    }],
    camDist: 14, camHeight: 5.4, crashDamage: 4,
  },
  smerch: {
    ...GROUND, type: 'smerch', faction: 'torsa', kind: 'ground', label: 'BM-30 SMERCH MLRS', armor: 'soft', role: 'artillery',
    mass: 13000, health: 850, half: [1.45, 0.95, 6.0], ride: 1.85,
    wheels: axles(1.3, [4.15, 1.95, -1.35, -3.55], 2), wheelRadius: 0.69, suspRest: 0.55, suspSag: 0.18,
    engineForce: 38000, brakeForce: 80000, maxSpeed: 16, reverseSpeed: 6, grip: 1.2, lateralGrip: 0.55, maxSteer: 0.42,
    seats: [{ role: 'driver', pos: [1.0, 2.2, 4.8] }, { role: 'gunner', pos: [-1.0, 2.2, 4.8] }, { role: 'commander', pos: [1.0, 2.2, 3.9] }, { role: 'passenger', pos: [-1.0, 2.2, 3.9] }],
    mounts: [{
      seat: 1, fallbackSeat: 0, weapon: 'smerch', pos: [0, 2.05, -5.9], trunnion: [0, 0, 0], barrel: 8.6, turnRate: 0.35,
      yawMin: -0.55, yawMax: 0.55, pitchMin: 0.12, pitchMax: 0.95,
      muzzles: [-0.9, -0.3, 0.3, 0.9].flatMap((x) => [0.35, 0.85, 1.3].map((y) => [x, y, 0])),
    }],
    camDist: 19, camHeight: 6.8, crashDamage: 4,
  },
  radar: {
    ...GROUND, type: 'radar', faction: 'torsa', kind: 'ground', label: '96L6E RADAR', armor: 'soft', role: 'aa', radarRange: 2400,
    mass: 11000, health: 650, half: [1.3, 0.85, 5.2], ride: 1.6,
    wheels: axles(1.05, [3.0, 1.5, -1.6, -3.1], 2), wheelRadius: 0.6, suspRest: 0.5, suspSag: 0.16,
    engineForce: 30000, brakeForce: 65000, maxSpeed: 17, reverseSpeed: 6, grip: 1.2, lateralGrip: 0.55, maxSteer: 0.45,
    seats: [{ role: 'driver', pos: [0.55, 2.1, 4.4] }, { role: 'gunner', pos: [-0.55, 2.1, 4.4] }],
    mounts: [], camDist: 17, camHeight: 7, crashDamage: 4,
  },
  tel: {
    ...GROUND, type: 'tel', faction: 'torsa', kind: 'ground', label: 'ISKANDER-M TEL', armor: 'soft', role: 'artillery', magazineMount: 0, strategic: true,
    mass: 16000, health: 950, half: [1.5, 0.95, 6.5], ride: 1.85,
    wheels: axles(1.25, [4.4, 2.6, -1.8, -3.6], 2), wheelRadius: 0.7, suspRest: 0.55, suspSag: 0.18,
    engineForce: 42000, brakeForce: 90000, maxSpeed: 15, reverseSpeed: 6, grip: 1.2, lateralGrip: 0.55, maxSteer: 0.42,
    seats: [{ role: 'driver', pos: [0.6, 2.35, 5.5] }, { role: 'gunner', pos: [-0.6, 2.35, 5.5] }, { role: 'commander', pos: [0, 2.35, 4.9] }],
    mounts: [{ seat: 1, fallbackSeat: 0, weapon: 'tbm', pos: [0, 2.55, -6.2], trunnion: [0, 0, 0], barrel: 6.6, turnRate: 0.25, pitchMin: 0.3, pitchMax: 1.4, muzzles: [[0.62, 0.15, 0], [-0.62, 0.15, 0]] }],
    camDist: 19, camHeight: 7, crashDamage: 4,
  },
  gunship: {
    ...NO_DRIVE, type: 'gunship', faction: 'torsa', kind: 'heli', label: 'MI-17 GUNSHIP', armor: 'heli', role: 'heli',
    mass: 6000, health: 1300, half: [1.4, 1.35, 8.0], ride: 1.36, maxSpeed: 44, turnRate: 1.05, padRadius: 12,
    seats: [
      { role: 'driver', pos: [0.5, 2.2, 8.2] }, { role: 'gunner', pos: [-0.5, 2.2, 8.2] }, { role: 'gunner', pos: [1.25, 1.7, 4.6] },
      ...pax([5.4, 4.4, 3.4, 2.4, 1.4].flatMap((z) => [[0.75, 1.4, z], [-0.75, 1.4, z]])),
    ],
    mounts: [
      { seat: 0, weapon: 'rockets80', pos: [0, 1.25, 1.4], barrel: 1.0, turnRate: 0, muzzles: [[2.35, 0, 0], [-2.35, 0, 0], [3.05, 0, 0], [-3.05, 0, 0]] },
      { seat: 1, fallbackSeat: 0, weapon: 'vikhr', pos: [0, 1.6, 0.2], barrel: 1.8, turnRate: 0, muzzles: [[3.55, 0.05, 0], [-3.55, 0.05, 0]] },
      { seat: 2, weapon: 'pkt', pos: [1.45, 1.75, 4.6], trunnion: [0, 0, 0.1], barrel: 0.9, turnRate: 2.5, yawMin: 0.35, yawMax: 2.6, pitchMin: -0.9, pitchMax: 0.3 },
      // Twin cannon pods on the outriggers (fixed forward): the co-pilot fires them, the pilot when alone.
      { seat: 1, fallbackSeat: 0, weapon: 'gsh30', pos: [0, 1.15, 1.8], barrel: 1.4, turnRate: 0, muzzles: [[1.75, -0.1, 0], [-1.75, -0.1, 0]] },
    ],
    camDist: 24, camHeight: 7, crashDamage: 22,
  },
  reconheli: {
    ...NO_DRIVE, type: 'reconheli', faction: 'torsa', kind: 'heli', label: 'MI-2 RECON HELO', armor: 'heli', role: 'airlift', observer: true,
    mass: 1800, health: 480, half: [0.85, 1.0, 4.6], ride: 1.01, maxSpeed: 44, turnRate: 1.5, padRadius: 9,
    seats: [{ role: 'driver', pos: [0.35, 1.3, 3.3] }, { role: 'gunner', pos: [-0.35, 1.3, 3.3] }, ...pax([[0.35, 1.3, 2.1], [-0.35, 1.3, 2.1], [0, 1.3, 1.1]])],
    mounts: [{ seat: 1, weapon: 'pkt', pos: [-0.9, 1.6, 2.2], trunnion: [0, 0, 0.1], barrel: 0.8, turnRate: 2.5, yawMin: -2.6, yawMax: -0.35, pitchMin: -0.9, pitchMax: 0.3 }],
    camDist: 16, camHeight: 4.6, crashDamage: 20,
  },
  heavyheli: {
    ...NO_DRIVE, type: 'heavyheli', faction: 'torsa', kind: 'heli', label: 'MI-26 HEAVY LIFT', armor: 'heli', role: 'airlift',
    mass: 15000, health: 1900, half: [2.1, 2.25, 14.0], ride: 2.26, maxSpeed: 38, turnRate: 0.7, padRadius: 15,
    seats: [
      { role: 'driver', pos: [0.7, 3.6, 14.8] }, { role: 'passenger', pos: [-0.7, 3.6, 14.8] },
      ...pax([10, 8.5, 7, 5.5, 4, 2.5, 1, -0.5, -2, -3.5].flatMap((z) => [[0.95, 1.5, z], [-0.95, 1.5, z]])),
    ],
    mounts: [], camDist: 40, camHeight: 12, crashDamage: 22,
  },
  lightattack: {
    ...NO_DRIVE, type: 'lightattack', faction: 'torsa', kind: 'jet', label: 'YAK-130 LIGHT ATTACK', armor: 'jet', role: 'jet',
    mass: 6000, health: 560, half: [1.0, 0.65, 5.6], ride: 1.8, maxSpeed: 85, turnRate: 0.45, padRadius: 7,
    wheels: [{ x: 0, z: 3.9, steer: true }, { x: 1.35, z: -0.9 }, { x: -1.35, z: -0.9 }],
    wheelRadius: 0.3, suspRest: 0.35, suspSag: 0.1, suspDamp: 0.6, brakeForce: 26000, grip: 1.2, lateralGrip: 0.6, maxSteer: 0.35, rolling: 0.03,
    flight: { stall: 30, thrust: 7.0, pitchRate: 1.6, rollRate: 3.0, yawRate: 0.45 },
    seats: [{ role: 'driver', pos: [0, 2.15, 2.6] }],
    mounts: [
      { seat: 0, weapon: 'gsh30', pos: [0, 1.15, 1.0], barrel: 0.8, turnRate: 0 },
      { seat: 0, weapon: 'rockets80', pos: [0, 1.2, -1.2], barrel: 0.95, turnRate: 0, muzzles: [[1.9, 0, 0], [-1.9, 0, 0], [2.9, 0, 0], [-2.9, 0, 0]] },
      { seat: 0, weapon: 'bomb500', pos: [0, 1.4, -1.2], barrel: 0, turnRate: 0, muzzles: [[3.9, 0, 0], [-3.9, 0, 0]] },
    ],
    camDist: 15, camHeight: 4, crashDamage: 30,
  },
  transportplane: {
    ...NO_DRIVE, type: 'transportplane', faction: 'torsa', kind: 'jet', label: 'IL-112V TRANSPORT', armor: 'jet', role: 'airlift', cargoVehicles: 1, accessZ: -7.4,
    mass: 15000, health: 1100, half: [1.65, 1.5, 12.0], ride: 2.85, maxSpeed: 85, turnRate: 0.35, padRadius: 14,
    wheels: [{ x: 0, z: 9.5, steer: true }, { x: 1.9, z: 1.1 }, { x: -1.9, z: 1.1 }],
    wheelRadius: 0.45, suspRest: 0.4, suspSag: 0.1, suspDamp: 0.6, brakeForce: 95000, grip: 1.2, lateralGrip: 0.6, maxSteer: 0.3, rolling: 0.03,
    flight: { stall: 30, thrust: 8.5, pitchRate: 1.0, rollRate: 1.4, yawRate: 0.35, assisted: true, maxBank: 0.75 },
    seats: [
      { role: 'driver', pos: [0.55, 3.12, 10.3] }, { role: 'passenger', pos: [-0.55, 3.12, 10.3] },
      ...pax([7.5, 6.3, 5.1, 3.9, 2.7, 1.5, 0.3, -0.9].flatMap((z) => [[1.05, 1.75, z], [-1.05, 1.75, z]])),
    ],
    mounts: [], camDist: 32, camHeight: 9, crashDamage: 30,
  },
  fighter2: {
    ...NO_DRIVE, type: 'fighter2', faction: 'torsa', kind: 'jet', label: 'SU-27 FIGHTER', armor: 'jet', role: 'jet',
    mass: 11500, health: 650, half: [1.9, 0.8, 10.0], ride: 2.1, maxSpeed: 125, turnRate: 0.55, padRadius: 10,
    wheels: [{ x: 0, z: 5.2, steer: true }, { x: 1.95, z: -1.6 }, { x: -1.95, z: -1.6 }],
    wheelRadius: 0.45, suspRest: 0.4, suspSag: 0.1, suspDamp: 0.6, brakeForce: 38000, grip: 1.2, lateralGrip: 0.6, maxSteer: 0.3, rolling: 0.03,
    flight: { stall: 40, thrust: 10.2, pitchRate: 1.9, rollRate: 3.8, yawRate: 0.55 },
    seats: [{ role: 'driver', pos: [0, 2.85, 6.0] }],
    mounts: [
      { seat: 0, weapon: 'gsh30', pos: [1.0, 2.6, 4.5], barrel: 0.6, turnRate: 0 },
      { seat: 0, weapon: 'aam', pos: [0, 2.2, 0], barrel: 1.4, turnRate: 0, muzzles: [[7.4, 0.25, -4.8], [-7.4, 0.25, -4.8], [3.9, -0.1, -2.4], [-3.9, -0.1, -2.4]] },
    ],
    camDist: 22, camHeight: 5, crashDamage: 30,
  },
  fighter3: {
    ...NO_DRIVE, type: 'fighter3', faction: 'torsa', kind: 'jet', label: 'MIG-31 INTERCEPTOR', armor: 'jet', role: 'jet',
    mass: 14000, health: 760, half: [2.0, 0.75, 10.5], ride: 2.5, maxSpeed: 140, turnRate: 0.4, padRadius: 10,
    wheels: [{ x: 0, z: 6.3, steer: true }, { x: 1.9, z: -1.8 }, { x: -1.9, z: -1.8 }],
    wheelRadius: 0.5, suspRest: 0.4, suspSag: 0.1, suspDamp: 0.6, brakeForce: 42000, grip: 1.2, lateralGrip: 0.6, maxSteer: 0.3, rolling: 0.03,
    flight: { stall: 45, thrust: 11.5, pitchRate: 1.3, rollRate: 2.5, yawRate: 0.4 },
    seats: [{ role: 'driver', pos: [0, 3.1, 6.5] }],
    mounts: [
      { seat: 0, weapon: 'gsh30', pos: [1.1, 2.4, 2.5], barrel: 0.6, turnRate: 0 },
      { seat: 0, weapon: 'aam', pos: [0, 1.8, 0], barrel: 1.6, turnRate: 0, muzzles: [[0.95, 0, -1.2], [-0.95, 0, -1.2], [0.95, 0, -5.4], [-0.95, 0, -5.4], [6.7, 1.2, -4.4], [-6.7, 1.2, -4.4]] },
    ],
    camDist: 23, camHeight: 5, crashDamage: 30,
  },

  // Static emplacements: fixed to the ground, crewed by one gunner (base guns belong to their side,
  // outpost guns to whoever holds the outpost).
  hmgturret: {
    ...NO_DRIVE, type: 'hmgturret', faction: 'torsa', kind: 'ground', static: true, label: 'HMG EMPLACEMENT', armor: 'soft', role: 'turret',
    mass: 900, health: 650, half: [1.1, 0.45, 1.1], ride: 0.45, openSeats: true, padRadius: 2,
    seats: [{ role: 'gunner', pos: [0, 0.2, -1.0] }],
    mounts: [{ seat: 0, weapon: 'kord', pos: [0, 1.25, 0.1], trunnion: [0, 0.12, 0], barrel: 1.3, turnRate: 2.4, pitchMin: -0.35, pitchMax: 0.85 }],
    camDist: 5, camHeight: 2.4, crashDamage: 0,
  },
  aaturret: {
    ...NO_DRIVE, type: 'aaturret', faction: 'torsa', kind: 'ground', static: true, label: 'ZU-23 AA GUN', armor: 'soft', role: 'turret',
    mass: 1100, health: 800, half: [1.4, 0.4, 1.6], ride: 0.4, openSeats: true, padRadius: 2.4,
    seats: [{ role: 'gunner', pos: [0, 0.75, -0.55] }],
    mounts: [{
      seat: 0, weapon: 'aa23', aa: true, pos: [0, 0.95, 0.25], trunnion: [0, 0.35, 0.25], barrel: 1.9, turnRate: 1.9, pitchMin: -0.1, pitchMax: 1.45,
      muzzles: [[0.28, 0, 0], [-0.28, 0, 0]],
    }],
    camDist: 6, camHeight: 2.8, crashDamage: 0,
  },
  searchlight: {
    ...NO_DRIVE, type: 'searchlight', faction: 'torsa', kind: 'ground', static: true, label: 'SEARCHLIGHT', armor: 'soft', role: 'turret',
    mass: 700, health: 300, half: [0.8, 0.5, 0.8], ride: 0.5, openSeats: true, padRadius: 1.6,
    seats: [{ role: 'gunner', pos: [0, 0.2, -1.0] }],
    mounts: [{ seat: 0, weapon: 'lamp', pos: [0, 1.6, 0], trunnion: [0, 0.2, 0], barrel: 0.6, turnRate: 1.6, pitchMin: -0.3, pitchMax: 0.9 }],
    camDist: 5, camHeight: 2.4, crashDamage: 0,
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
  def.riders = def.seats.filter((s) => s.role === 'rider').length;
  // Troop compartments (four or more passenger seats: APCs, IFVs, truck beds, helicopter cabins, cargo holds) seat
  // their passengers on benches along the walls, facing across; cars keep forward-facing seats.
  // Dedicated troop door: armoured carriers, truck beds and cargo aircraft load and unload through the rear (doors,
  // tailgate or ramp), which opens before anyone climbs in or out; cars and helicopter cabins use the side doors.
  if (def.rearAccess === undefined) def.rearAccess = def.passengers >= 4 && (def.kind === 'ground' || def.type === 'transportplane' || def.type === 'heavyheli');
  const frontZ = def.seats[0] ? def.seats[0].pos[2] : 0;
  for (const s of def.seats) s.front = s.role === 'passenger' && Math.abs(s.pos[2] - frontZ) < 1.2; // beside the driver / pilot
  if (def.passengers >= 4) for (const s of def.seats) if (s.role === 'passenger' && !s.front && s.face === undefined && Math.abs(s.pos[0]) > 0.25) s.face = s.pos[0] > 0 ? -Math.PI / 2 : Math.PI / 2;
  // Crew seats inside a traversing turret ride round with it (turned-out crews, hatches).
  const turret = def.mounts.findIndex((m) => m.parent === undefined && m.coax === undefined && m.turnRate > 0 && m.pos);
  def.seats.forEach((s) => {
    s.turret = turret >= 0 && def.kind === 'ground' && !def.static && (s.role === 'gunner' || s.role === 'commander') && s.pos[1] > def.half[1] - 0.15 ? turret : -1;
  });
  def.padRadius = def.padRadius || Math.hypot(def.half[0], def.half[2]) * 0.92 + 0.6;
  def.rolling = def.rolling ?? 0.7;
  return def;
}
for (const k in VEHICLE_DEFS) normalize(VEHICLE_DEFS[k]);
