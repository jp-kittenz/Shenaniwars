/**
 * Vehicle parks and dynamic vehicle obstacles.
 *
 * Parking: every base has marked slots in two rows across the apron (src/world/map-generator.js), with a
 * departure lane and an aisle that are never parked in. Vehicles start in slots; a returning vehicle reserves
 * a free slot that fits it (its own first) instead of driving to the exact spot it spawned on, which another
 * vehicle may be sitting on; a vehicle recovered or rebuilt at base is placed in a free slot too.
 *
 * Obstacles: stationary vehicles (parked, waiting, holding), wrecks and spots where a vehicle just jammed are
 * stamped into the navigation grid's dynamic vehicle layer, so ground routes are planned around them instead
 * of discovering them by bumping into them. A vehicle's own footprint is ignored when it plans its route.
 */
import type { GameLike, VehicleLike } from './types';

export interface ParkSlot {
  x: number; z: number; yaw: number; r: number; row: number; team: number;
  /** Point in the lane / aisle in front of the slot. */
  ax: number; az: number;
  /** Vehicle standing in the slot, or -1. */
  occ: number;
  /** Vehicle that has reserved the slot, or -1. */
  res: number;
  resT: number;
}

interface NavDyn {
  setDyn(key: number, x: number, z: number, yaw: number, hx: number, hz: number, until?: number): void;
  clearDyn(key: number): void;
  expireDyn(time: number): void;
  dyn: Map<number, unknown>;
}

/** Margin around a stationary hull in the dynamic layer (the planner treats a vehicle as a point). */
const DYN_MARGIN = 2.0;
/** Seconds a vehicle must stand still before it is treated as an obstacle (not for traffic waiting a moment). */
const STILL_T = 2.5;
/** Key offset of jam marks in the dynamic layer. */
export const JAM_KEY = 100000;

export class VehiclePark {
  readonly slots: ParkSlot[][] = [[], []];
  private readonly still: Float32Array;
  private readonly stamped: Uint8Array;
  /** Slot a vehicle failed to reach, and until when it avoids it. */
  private readonly badSlot: Int32Array;
  private readonly badUntil: Float32Array;
  private timer = 0;
  readonly stats = { claims: 0, ownSlot: 0, otherSlot: 0, noSlot: 0, parked: 0, slotFailed: 0, respawnMoved: 0, dynStamped: 0, laneParked: 0 };

  private readonly game: GameLike;

  constructor(game: GameLike) {
    this.game = game;
    const bases = ((game.map && (game.map as any).bases) || []) as { parkSlots?: any[] }[];
    for (let t = 0; t < 2; t++) {
      const list = (bases[t] && bases[t].parkSlots) || [];
      this.slots[t] = list.map((s: any) => ({ x: s.x, z: s.z, yaw: s.yaw, r: s.r, row: s.row, team: s.team, ax: s.ax, az: s.az, occ: -1, res: -1, resT: 0 }));
    }
    const n = game.vehicles.list.length;
    this.still = new Float32Array(n);
    this.stamped = new Uint8Array(n);
    this.badSlot = new Int32Array(n).fill(-1);
    this.badUntil = new Float32Array(n);
    // Initial occupancy: vehicles spawn in slots.
    for (const v of game.vehicles.list) {
      const s = this.slotAt(v.spawn.team, v.spawn.x, v.spawn.z, 1.5);
      if (s) s.occ = v.id;
    }
  }

  private get nav(): NavDyn { return this.game.nav as unknown as NavDyn; }

  private slotAt(team: number, x: number, z: number, r: number): ParkSlot | null {
    const L = this.slots[team];
    if (!L) return null;
    for (const s of L) if ((s.x - x) ** 2 + (s.z - z) ** 2 < r * r) return s;
    return null;
  }

  /** Slot reserved by / occupied by this vehicle, if any. */
  slotOf(v: VehicleLike): ParkSlot | null {
    const L = this.slots[v.spawn.team];
    if (!L) return null;
    for (const s of L) if (s.res === v.id) return s;
    for (const s of L) if (s.occ === v.id) return s;
    return null;
  }

  private fits(s: ParkSlot, v: VehicleLike): boolean {
    return s.r >= ((v.def as any).padRadius || 4) - 0.2;
  }

  /**
   * Reserves a slot for a vehicle heading home: the one it holds, else its home slot, else the free slot that
   * fits it nearest to where it is now. Returns null when the park is full (it then waits near the lane end).
   */
  claim(v: VehicleLike, time: number): ParkSlot | null {
    const held = this.slotOf(v);
    if (held && !(this.badSlot[v.id] >= 0 && this.slots[v.spawn.team][this.badSlot[v.id]] === held && time < this.badUntil[v.id])) {
      held.res = v.id; held.resT = time;
      return held;
    }
    if (held) { if (held.res === v.id) held.res = -1; }
    const L = this.slots[v.spawn.team];
    if (!L || !L.length) return null;
    let best: ParkSlot | null = null, bs = 1e12;
    for (let k = 0; k < L.length; k++) {
      const s = L[k];
      if ((s.occ >= 0 && s.occ !== v.id) || (s.res >= 0 && s.res !== v.id) || !this.fits(s, v)) continue;
      if (this.badSlot[v.id] === k && time < this.badUntil[v.id]) continue;
      let d = (s.x - v.pos.x) ** 2 + (s.z - v.pos.z) ** 2;
      if (s.x === v.spawn.x && s.z === v.spawn.z) d *= 0.5;
      // Big slots are kept for the vehicles that need them.
      if (s.r > 6 && ((v.def as any).padRadius || 4) < 5) d += 120 * 120;
      if (d < bs) { bs = d; best = s; }
    }
    this.stats.claims++;
    if (!best) { this.stats.noSlot++; return null; }
    if (best.x === v.spawn.x && best.z === v.spawn.z) this.stats.ownSlot++; else this.stats.otherSlot++;
    best.res = v.id; best.resT = time;
    return best;
  }

  /** The vehicle could not get into its slot: try another one for a while. */
  failed(v: VehicleLike, time: number): void {
    const s = this.slotOf(v);
    if (!s) return;
    this.stats.slotFailed++;
    this.badSlot[v.id] = this.slots[v.spawn.team].indexOf(s);
    this.badUntil[v.id] = time + 90;
    if (s.res === v.id) s.res = -1;
  }

  release(v: VehicleLike): void {
    const L = this.slots[v.spawn.team];
    if (!L) return;
    for (const s of L) if (s.res === v.id) s.res = -1;
  }

  /** Arrived in a slot: it is now its home slot (where it is rebuilt / recovered to). */
  parked(v: VehicleLike, s: ParkSlot): void {
    s.occ = v.id; s.res = -1;
    v.spawn.x = s.x; v.spawn.z = s.z; v.spawn.yaw = s.yaw;
    this.stats.parked++;
  }

  /**
   * Before a vehicle is reset at base (rebuilt after destruction, or recovered after being abandoned):
   * if its home slot is taken, move its home to a free slot that fits, so it never appears inside another.
   */
  prepareReset(v: VehicleLike): void {
    if ((v.def as any).kind !== 'ground' || (v.def as any).static) return;
    const L = this.slots[v.spawn.team];
    if (!L || !L.length) return;
    const own = this.slotAt(v.spawn.team, v.spawn.x, v.spawn.z, 1.5);
    const blocked = (s: ParkSlot) => (s.occ >= 0 && s.occ !== v.id) || (s.res >= 0 && s.res !== v.id) || this.vehicleNear(s.x, s.z, 5, v);
    if (own && !blocked(own)) { own.occ = v.id; return; }
    let best: ParkSlot | null = null, bs = 1e12;
    for (const s of L) {
      if (blocked(s) || !this.fits(s, v)) continue;
      const d = (s.x - v.spawn.x) ** 2 + (s.z - v.spawn.z) ** 2;
      if (d < bs) { bs = d; best = s; }
    }
    if (!best) return;
    if (own && own.occ === v.id) own.occ = -1;
    best.occ = v.id; v.spawn.x = best.x; v.spawn.z = best.z; v.spawn.yaw = best.yaw;
    this.stats.respawnMoved++;
  }

  private vehicleNear(x: number, z: number, r: number, not: VehicleLike): boolean {
    for (const o of this.game.vehicles.list) {
      if (o === not || !(o.alive || (o as any).wreckTimer > 0)) continue;
      if ((o.pos.x - x) ** 2 + (o.pos.z - z) ** 2 < r * r) return true;
    }
    return false;
  }

  /** Whether a point is in a base's departure lane or aisle (where nothing should stand). */
  inLane(team: number, x: number, z: number): boolean {
    const b = ((this.game.map && (this.game.map as any).bases) || [])[team];
    if (!b || !b.park) return false;
    const u = (x - b.x) * b.inland, v = z - b.z;
    if (Math.abs(v) > b.park.v1 + 6) return false;
    return (u > 47 && u < 72) || (u > 21 && u < 35);
  }

  /** Standing in a parking slot (any slot of its side), or not a park vehicle at all. */
  inSlot(v: VehicleLike): boolean {
    const L = this.slots[v.spawn.team];
    if (!L || !L.length || (v.def as any).kind !== 'ground') return true;
    return this.slotAt(v.spawn.team, v.pos.x, v.pos.z, 4) !== null;
  }

  update(dt: number, returning: (id: number) => boolean): void {
    if ((this.timer -= dt) > 0) return;
    const step = 0.5 - this.timer;
    this.timer = 0.5;
    const time = this.game.time, nav = this.nav, list = this.game.vehicles.list;
    if (!nav || !nav.setDyn) return;
    nav.expireDyn(time);
    for (let i = 0; i < list.length; i++) {
      const v = list[i] as VehicleLike & { wreckTimer?: number; body?: { isEnabled(): boolean } };
      const def = v.def as any;
      const wreck = !v.alive && (v.wreckTimer || 0) > 0;
      const ground = def.kind === 'ground' || v.altitude < 2;
      const moving = Math.abs(v.speed) > 0.5 || (v.isAircraft && v.altitude > 2);
      this.still[i] = moving || !(v.alive || wreck) ? 0 : this.still[i] + step;
      const stamp = (v.alive || wreck) && ground && (def.static || wreck || this.still[i] >= STILL_T);
      if (stamp) {
        nav.setDyn(v.id, v.pos.x, v.pos.z, v.yaw, def.half[0] + DYN_MARGIN, def.half[2] + DYN_MARGIN);
        if (!this.stamped[i]) { this.stamped[i] = 1; this.stats.dynStamped++; }
      } else if (this.stamped[i]) { nav.clearDyn(v.id); this.stamped[i] = 0; }
    }
    // Slot occupancy follows where vehicles actually stand; stale reservations lapse.
    for (let t = 0; t < 2; t++) {
      for (const s of this.slots[t]) {
        if (s.occ >= 0) {
          const o = list[s.occ];
          if (!o || !o.alive || (o.pos.x - s.x) ** 2 + (o.pos.z - s.z) ** 2 > 36) s.occ = -1;
        }
        if (s.res >= 0) {
          const o = list[s.res];
          if (!o || !o.alive || !o.driver || !returning(s.res) || time - s.resT > 240) s.res = -1;
        }
      }
    }
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.alive || (v.def as any).kind !== 'ground' || (v.def as any).static || this.still[i] < STILL_T) continue;
      const s = this.slotAt(v.spawn.team, v.pos.x, v.pos.z, 3.5);
      if (s && s.occ < 0 && (s.res < 0 || s.res === v.id)) s.occ = v.id;
    }
  }

  /** Counts stationary vehicles standing in their base's lanes (a congestion metric). */
  laneBlockers(): number {
    let n = 0;
    for (let i = 0; i < this.game.vehicles.list.length; i++) {
      const v = this.game.vehicles.list[i];
      if (v.alive && (v.def as any).kind === 'ground' && !(v.def as any).static && this.still[i] > 10 && this.inLane(v.spawn.team, v.pos.x, v.pos.z)) n++;
    }
    return n;
  }
}
