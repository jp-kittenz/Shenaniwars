/**
 * @typedef {Object} WeaponDef
 * @property {string} name
 * @property {'hitscan'|'projectile'} type
 * @property {number} damage
 * @property {number} rpm
 * @property {number} mag       rounds per magazine (Infinity = belt fed)
 * @property {number} reserve   spare rounds carried
 * @property {number} reload    seconds
 * @property {number} spread    radians of random cone
 * @property {number} range
 * @property {boolean} auto
 * @property {string} sound
 * @property {number} [radius]  blast radius (projectiles)
 * @property {number} [speed]   muzzle velocity (projectiles)
 * @property {number} [gravity] projectile drop
 * @property {number} headMul
 * @property {{jeep:number, tank:number, heli:number}} vsVehicle  damage multipliers
 */

/** @type {Record<string, WeaponDef>} */
export const WEAPONS = {
  rifle: {
    name: 'CARBINE', type: 'hitscan', damage: 27, rpm: 620, mag: 30, reserve: 180, reload: 2.1, spread: 0.011,
    range: 300, auto: true, sound: 'shot', headMul: 2.2, vsVehicle: { jeep: 1, tank: 0, heli: 0.6 },
  },
  launcher: {
    name: 'LAUNCHER', type: 'projectile', damage: 560, rpm: 40, mag: 1, reserve: 5, reload: 3.2, spread: 0.004,
    range: 400, auto: false, sound: 'rocket', radius: 7, speed: 75, gravity: 4, headMul: 1,
    vsVehicle: { jeep: 1.2, tank: 1, heli: 1.5 },
  },
  mountedMG: {
    name: 'MOUNTED MG', type: 'hitscan', damage: 30, rpm: 540, mag: Infinity, reserve: 0, reload: 0, spread: 0.014,
    range: 350, auto: true, sound: 'shotHeavy', headMul: 1.8, vsVehicle: { jeep: 1.2, tank: 0, heli: 0.8 },
  },
  cannon: {
    name: '105MM CANNON', type: 'projectile', damage: 900, rpm: 17, mag: Infinity, reserve: 0, reload: 0, spread: 0.002,
    range: 600, auto: false, sound: 'cannon', radius: 9, speed: 140, gravity: 6, headMul: 1,
    vsVehicle: { jeep: 2, tank: 1, heli: 2 },
  },
  rockets: {
    name: 'ROCKET PODS', type: 'projectile', damage: 240, rpm: 260, mag: 14, reserve: Infinity, reload: 8, spread: 0.012,
    range: 500, auto: true, sound: 'rocket', radius: 6.5, speed: 110, gravity: 1.5, headMul: 1,
    vsVehicle: { jeep: 1.5, tank: 0.8, heli: 1.5 },
  },
};

/** Mutable per-holder weapon state. */
export class WeaponState {
  /** @param {string} id key into WEAPONS */
  constructor(id) {
    this.id = id;
    this.def = WEAPONS[id];
    this.ammo = this.def.mag;
    this.reserve = this.def.reserve;
    this.cooldown = 0;
    this.reloadTimer = 0;
  }
  refill() {
    this.ammo = this.def.mag;
    this.reserve = this.def.reserve;
    this.reloadTimer = 0;
  }
  get reloading() { return this.reloadTimer > 0; }
  canFire() { return this.cooldown <= 0 && this.reloadTimer <= 0 && this.ammo > 0; }
  startReload() {
    if (this.reloadTimer > 0 || this.ammo >= this.def.mag || this.reserve <= 0) return false;
    this.reloadTimer = this.def.reload;
    return true;
  }
  /** Advances timers; returns true on the frame a reload completes. */
  update(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
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
    this.cooldown = 60 / this.def.rpm;
  }
}
