/**
 * Weapon definitions and per-holder weapon state.
 *
 * Damage against vehicles is scaled by the target's armour class:
 *   soft  — trucks, light cars       light — APCs, IFVs, light tanks, SPAAG, howitzer
 *   heavy — main battle tanks        heli / jet — aircraft
 */

/** @typedef {'soft'|'light'|'heavy'|'heli'|'jet'} ArmorClass */

/**
 * @typedef {Object} WeaponDef
 * @property {string} id
 * @property {string} name
 * @property {'hitscan'|'projectile'} type
 * @property {'rifle'|'launcher'|'vehicle'} slot
 * @property {number} damage
 * @property {number} rpm
 * @property {number} mag       rounds per magazine (Infinity = belt fed)
 * @property {number} reserve   spare rounds carried (Infinity = unlimited)
 * @property {number} reload    seconds (tactical reload)
 * @property {number} [reloadEmpty] seconds when reloading from an empty magazine
 * @property {number} spread    radians of random cone
 * @property {number} range
 * @property {boolean} auto
 * @property {string} sound
 * @property {number} headMul
 * @property {Record<ArmorClass, number>} vsVehicle
 * @property {number} [radius]  blast radius (projectiles)
 * @property {number} [splash]  small blast radius for explosive hitscan rounds
 * @property {number} [speed]   muzzle velocity (projectiles)
 * @property {number} [gravity] projectile drop (m/s²)
 * @property {number} [life]    projectile lifetime (s)
 * @property {'air'|'guided'} [homing]  'air' locks aircraft, 'guided' follows the launcher's aim line
 * @property {number} [turn]    homing turn rate (rad/s)
 * @property {number} [lockRange]
 * @property {boolean} [artillery] aim with a ballistic solution instead of line of sight
 * @property {boolean} [drop]   released with the carrier's velocity (bombs)
 * @property {boolean} [trail]  smoke trail behind the projectile
 * @property {number} [size]    projectile visual scale
 * @property {number} [zoom]    vertical FOV when aiming down sights
 * @property {number} [recoil]  view kick per shot (first person)
 */

const V = (soft, light, heavy, heli, jet) => ({ soft, light, heavy, heli, jet });

/** @type {Record<string, WeaponDef>} */
export const WEAPONS = {
  // --- Pampalona (placeholder kit, unchanged in behaviour) --------------------------
  rifle: {
    id: 'rifle', name: 'CARBINE', type: 'hitscan', slot: 'rifle', damage: 27, rpm: 620, mag: 30, reserve: 180,
    reload: 2.1, reloadEmpty: 2.6, spread: 0.011, range: 300, auto: true, sound: 'shot', headMul: 2.2,
    vsVehicle: V(1, 0.08, 0, 0.6, 0.4), zoom: 48, recoil: 0.0065,
  },
  launcher: {
    id: 'launcher', name: 'LAUNCHER', type: 'projectile', slot: 'launcher', damage: 560, rpm: 40, mag: 1, reserve: 5,
    reload: 3.2, spread: 0.004, range: 400, auto: false, sound: 'rocket', radius: 7, speed: 75, gravity: 4, headMul: 1,
    vsVehicle: V(1.2, 1, 0.6, 1.5, 1.2), trail: true, zoom: 55, recoil: 0.03,
  },
  // --- Torsa ----------------------------------------------------------------------------
  ak47: {
    id: 'ak47', name: 'AK-47', type: 'hitscan', slot: 'rifle', damage: 34, rpm: 600, mag: 30, reserve: 150,
    reload: 2.5, reloadEmpty: 3.1, spread: 0.014, range: 320, auto: true, sound: 'shotAK', headMul: 2.2,
    vsVehicle: V(1.1, 0.1, 0, 0.6, 0.45), zoom: 52, recoil: 0.0095,
  },
  ak12: {
    id: 'ak12', name: 'AK-12', type: 'hitscan', slot: 'rifle', damage: 28, rpm: 700, mag: 30, reserve: 180,
    reload: 2.3, reloadEmpty: 2.9, spread: 0.009, range: 340, auto: true, sound: 'shot', headMul: 2.2,
    vsVehicle: V(1, 0.08, 0, 0.55, 0.4), zoom: 40, recoil: 0.0068,
  },
  rpg7: {
    id: 'rpg7', name: 'RPG-7', type: 'projectile', slot: 'launcher', damage: 620, rpm: 30, mag: 1, reserve: 4,
    reload: 3.4, spread: 0.006, range: 420, auto: false, sound: 'rocket', radius: 6.5, speed: 115, gravity: 3.5,
    headMul: 1, vsVehicle: V(1.2, 1, 0.6, 1.4, 1.2), trail: true, zoom: 50, recoil: 0.035,
  },
  // --- Vehicle armament -----------------------------------------------------------------
  mountedMG: {
    id: 'mountedMG', name: 'MOUNTED MG', type: 'hitscan', slot: 'vehicle', damage: 30, rpm: 540, mag: Infinity, reserve: 0,
    reload: 0, spread: 0.014, range: 350, auto: true, sound: 'shotHeavy', headMul: 1.8, vsVehicle: V(1.2, 0.15, 0, 0.8, 0.6),
  },
  cannon: {
    id: 'cannon', name: '105MM CANNON', type: 'projectile', slot: 'vehicle', damage: 900, rpm: 17, mag: Infinity, reserve: 0,
    reload: 0, spread: 0.002, range: 600, auto: false, sound: 'cannon', radius: 9, speed: 140, gravity: 6, headMul: 1,
    vsVehicle: V(2, 1.3, 1, 2, 2),
  },
  rockets: {
    id: 'rockets', name: 'ROCKET PODS', type: 'projectile', slot: 'vehicle', damage: 240, rpm: 260, mag: 14, reserve: Infinity,
    reload: 8, spread: 0.012, range: 500, auto: true, sound: 'rocket', radius: 6.5, speed: 110, gravity: 1.5, headMul: 1,
    vsVehicle: V(1.5, 1, 0.45, 1.5, 1.5), trail: true,
  },
  pkt: {
    id: 'pkt', name: 'PKT 7.62', type: 'hitscan', slot: 'vehicle', damage: 30, rpm: 650, mag: 250, reserve: Infinity,
    reload: 5, spread: 0.012, range: 380, auto: true, sound: 'shotHeavy', headMul: 1.8, vsVehicle: V(1.1, 0.1, 0, 0.6, 0.5),
  },
  kord: {
    id: 'kord', name: 'KORD 12.7', type: 'hitscan', slot: 'vehicle', damage: 48, rpm: 600, mag: 150, reserve: Infinity,
    reload: 5, spread: 0.012, range: 450, auto: true, sound: 'shotHeavy', headMul: 1.5, vsVehicle: V(1.4, 0.35, 0.02, 1, 0.9),
  },
  cannon125: {
    id: 'cannon125', name: '125MM 2A46', type: 'projectile', slot: 'vehicle', damage: 950, rpm: 9, mag: Infinity, reserve: 0,
    reload: 0, spread: 0.0015, range: 700, auto: false, sound: 'cannon', radius: 8, speed: 170, gravity: 5, headMul: 1,
    vsVehicle: V(2, 1.3, 1, 2, 2), size: 1.2,
  },
  cannon125hv: {
    id: 'cannon125hv', name: '125MM 2A46M-1', type: 'projectile', slot: 'vehicle', damage: 1150, rpm: 7.5, mag: Infinity,
    reserve: 0, reload: 0, spread: 0.0012, range: 750, auto: false, sound: 'cannon', radius: 8.5, speed: 185, gravity: 5,
    headMul: 1, vsVehicle: V(2, 1.3, 1, 2, 2), size: 1.25,
  },
  ac30: {
    id: 'ac30', name: '30MM 2A42', type: 'hitscan', slot: 'vehicle', damage: 60, rpm: 500, mag: 160, reserve: Infinity,
    reload: 6, spread: 0.006, range: 550, auto: true, sound: 'autocannon', splash: 2.2, headMul: 1,
    vsVehicle: V(1.5, 0.6, 0.06, 1.4, 1.4),
  },
  atgm: {
    id: 'atgm', name: 'KONKURS ATGM', type: 'projectile', slot: 'vehicle', damage: 1100, rpm: 20, mag: 1, reserve: Infinity,
    reload: 9, spread: 0, range: 700, auto: false, sound: 'rocket', radius: 5, speed: 85, gravity: 0, life: 9,
    homing: 'guided', turn: 1.6, headMul: 1, vsVehicle: V(1, 1.1, 0.9, 1, 0), trail: true, size: 1.1,
  },
  rockets80: {
    id: 'rockets80', name: 'S-8 ROCKETS', type: 'projectile', slot: 'vehicle', damage: 260, rpm: 300, mag: 20, reserve: Infinity,
    reload: 10, spread: 0.012, range: 550, auto: true, sound: 'rocket', radius: 6.5, speed: 120, gravity: 1.5, headMul: 1,
    vsVehicle: V(1.5, 1, 0.45, 1.5, 1.5), trail: true,
  },
  vikhr: {
    id: 'vikhr', name: 'VIKHR ATGM', type: 'projectile', slot: 'vehicle', damage: 1100, rpm: 30, mag: 4, reserve: Infinity,
    reload: 14, spread: 0, range: 800, auto: false, sound: 'rocket', radius: 5, speed: 110, gravity: 0, life: 9,
    homing: 'guided', turn: 1.8, headMul: 1, vsVehicle: V(1, 1.1, 0.9, 1, 0), trail: true, size: 1.1,
  },
  gsh30: {
    id: 'gsh30', name: '30MM CANNON', type: 'hitscan', slot: 'vehicle', damage: 70, rpm: 900, mag: 250, reserve: Infinity,
    reload: 8, spread: 0.008, range: 650, auto: true, sound: 'autocannon', splash: 2.4, headMul: 1,
    vsVehicle: V(1.5, 0.7, 0.12, 1.5, 1.5),
  },
  bomb500: {
    id: 'bomb500', name: 'FAB-500 BOMBS', type: 'projectile', slot: 'vehicle', damage: 1800, rpm: 120, mag: 4, reserve: Infinity,
    reload: 25, spread: 0, range: 900, auto: false, sound: 'release', radius: 16, speed: 0, gravity: 9.81, life: 20,
    drop: true, headMul: 1, vsVehicle: V(1.5, 1.2, 1, 1, 1), size: 1.8,
  },
  aam: {
    id: 'aam', name: 'R-73 AAM', type: 'projectile', slot: 'vehicle', damage: 900, rpm: 60, mag: 4, reserve: Infinity,
    reload: 18, spread: 0, range: 900, auto: false, sound: 'missile', radius: 7, speed: 170, gravity: 0, life: 8,
    homing: 'air', turn: 2.6, lockRange: 800, headMul: 1, vsVehicle: V(0, 0, 0, 1.3, 1.4), trail: true, size: 1.2,
  },
  sam: {
    id: 'sam', name: '57E6 SAM', type: 'projectile', slot: 'vehicle', damage: 1100, rpm: 40, mag: 12, reserve: Infinity,
    reload: 30, spread: 0, range: 1000, auto: false, sound: 'missile', radius: 8, speed: 190, gravity: 0, life: 9,
    homing: 'air', turn: 2.2, lockRange: 950, headMul: 1, vsVehicle: V(0, 0, 0, 1.2, 1.3), trail: true, size: 1.4,
  },
  aa23: {
    id: 'aa23', name: '4× 23MM AZP-23', type: 'hitscan', slot: 'vehicle', damage: 34, rpm: 1500, mag: 500, reserve: Infinity,
    reload: 9, spread: 0.012, range: 600, auto: true, sound: 'autocannon', splash: 1.6, headMul: 1,
    vsVehicle: V(1.2, 0.3, 0.02, 1.5, 1.8),
  },
  aa30: {
    id: 'aa30', name: '2× 30MM 2A38', type: 'hitscan', slot: 'vehicle', damage: 42, rpm: 1200, mag: 350, reserve: Infinity,
    reload: 9, spread: 0.01, range: 650, auto: true, sound: 'autocannon', splash: 2, headMul: 1,
    vsVehicle: V(1.3, 0.35, 0.03, 1.5, 1.8),
  },
  mlrs: {
    id: 'mlrs', name: '300MM ROCKETS', type: 'projectile', slot: 'vehicle', damage: 650, rpm: 150, mag: 12, reserve: Infinity,
    reload: 28, spread: 0.02, range: 950, auto: true, sound: 'rocket', radius: 12, speed: 115, gravity: 14, life: 25,
    artillery: true, headMul: 1, vsVehicle: V(1.5, 1, 0.6, 1, 1), trail: true, size: 1.6,
  },
  howitzer: {
    id: 'howitzer', name: '152MM 2A64', type: 'projectile', slot: 'vehicle', damage: 1300, rpm: 8, mag: Infinity, reserve: 0,
    reload: 0, spread: 0.004, range: 1000, auto: false, sound: 'cannon', radius: 13, speed: 120, gravity: 14, life: 25,
    artillery: true, headMul: 1, vsVehicle: V(1.5, 1.2, 0.9, 1, 1), size: 1.4,
  },
};

/**
 * Launch pitch that lands a projectile `dx` metres away horizontally and `dy`
 * metres higher. Returns NaN when the target is out of range.
 * @param {boolean} high  lob over obstacles instead of the flat trajectory
 */
export function ballisticPitch(dx, dy, speed, gravity, high = false) {
  if (gravity <= 0) return Math.atan2(dy, dx);
  const v2 = speed * speed;
  const disc = v2 * v2 - gravity * (gravity * dx * dx + 2 * dy * v2);
  if (disc < 0) return NaN;
  const root = Math.sqrt(disc);
  return Math.atan((v2 + (high ? root : -root)) / (gravity * dx));
}

/** Mutable per-holder weapon state. */
export class WeaponState {
  /** @param {string} id key into WEAPONS */
  constructor(id) {
    this.id = id;
    this.def = WEAPONS[id];
    if (!this.def) throw new Error(`Unknown weapon "${id}"`);
    this.ammo = this.def.mag;
    this.reserve = this.def.reserve;
    this.cooldown = 0;
    this.reloadTimer = 0;
    /** Duration of the reload in progress (drives the animation timeline). */
    this.reloadDuration = 1;
    /** Whether the reload in progress started from an empty magazine. */
    this.reloadEmpty = false;
    /** Index of the next barrel / pod / rail for multi-muzzle mounts. */
    this.shot = 0;
  }
  refill() {
    this.ammo = this.def.mag;
    this.reserve = this.def.reserve;
    this.reloadTimer = 0;
  }
  get reloading() { return this.reloadTimer > 0; }
  /** 0 → 1 progress of the current reload (0 when not reloading). */
  get reloadProgress() { return this.reloadTimer > 0 ? 1 - this.reloadTimer / this.reloadDuration : 0; }
  canFire() { return this.cooldown <= 0 && this.reloadTimer <= 0 && this.ammo > 0; }
  startReload() {
    if (this.reloadTimer > 0 || this.ammo >= this.def.mag || this.reserve <= 0) return false;
    this.reloadEmpty = this.ammo <= 0;
    this.reloadDuration = (this.reloadEmpty && this.def.reloadEmpty) || this.def.reload;
    this.reloadTimer = this.reloadDuration;
    return true;
  }
  /** Advances timers; returns true on the frame a reload completes. */
  update(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloadTimer = 0;
        const need = this.def.mag - this.ammo;
        const take = Math.min(need, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        return true;
      }
    } else if (this.ammo <= 0 && this.reserve > 0) this.startReload();
    return false;
  }
  /** Consumes a round and arms the fire-rate timer. */
  consume() {
    this.ammo--;
    this.shot++;
    this.cooldown = 60 / this.def.rpm;
  }
}
