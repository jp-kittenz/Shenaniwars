import * as THREE from 'three';
import { WeaponState } from '../entities/weapons.js';

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const SAM_RANGE = 760;
const SAM_INTERVAL = 4.5;
const SAM_SALVO = 6;
const SAM_RELOAD = 30;
const REPAIR_REACH = 13;

/**
 * Autonomous base air defence and engineering:
 *
 *  - Each base's two SAM sites engage enemy aircraft in range and sight on
 *    their own (radar-guided missiles; flares still spoof them), a missile
 *    every few seconds, a salvo then a reload. They make the base airspace
 *    dangerous without making it untouchable.
 *  - Engineers (the fire team's support soldier) standing at either end of a
 *    fallen bridge rebuild it over time; the deck and its navigation return
 *    when the repair completes.
 */
export class BaseDefenceSystem {
  /** @param {import('./game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** @type {{x:number, y:number, z:number, team:number, weapon: WeaponState, next:number, left:number, shooter:any}[]} */
    this.sams = [];
    for (const base of game.map.bases || []) {
      for (const p of base.sams) {
        const y = game.map.terrain.baseHeight(p.x, p.z) + 3.2;
        const pos = new THREE.Vector3(p.x, y, p.z);
        this.sams.push({
          x: p.x, y, z: p.z, team: p.team, weapon: new WeaponState('sam'), next: 0, left: SAM_SALVO,
          // Stand-in "shooter" so kills are credited in the feed and missiles know their side.
          shooter: { id: -1, team: p.team, name: 'BASE SAM', isPlayer: false, alive: true, vehicle: null, spotted: 0, muzzleFlash: 0, kills: 0, pos },
        });
      }
    }
    this._t = 0;
    this._repairT = 0;
    this.bridge = game.map.bridge ? game.map.buildings[game.map.bridge.building] : null;
  }

  update(dt) {
    const g = this.game;
    for (const s of this.sams) s.weapon.update(dt);
    if ((this._t -= dt) <= 0) { this._t = 0.4; this._sams(); }
    if ((this._repairT -= dt) <= 0) { this._repairT = 1; this._repairBridge(1); }
    void g;
  }

  _sams() {
    const g = this.game, time = g.time;
    for (const s of this.sams) {
      if (time < s.next) continue;
      let best = null, bd = SAM_RANGE * SAM_RANGE;
      for (const v of g.vehicles.list) {
        if (!v.alive || !v.isAircraft || !v.occupied || v.team === s.team || v.altitude < 12) continue;
        const d = (v.pos.x - s.x) ** 2 + (v.pos.y - s.y) ** 2 + (v.pos.z - s.z) ** 2;
        if (d >= bd) continue;
        if (!g.physics.losClear(s.x, s.y, s.z, v.pos.x, v.pos.y, v.pos.z)) continue;
        bd = d; best = v;
      }
      if (!best) continue;
      _o.set(s.x, s.y, s.z);
      _d.set(best.pos.x - s.x, best.pos.y - s.y + 6, best.pos.z - s.z).normalize();
      s.weapon.ammo = Math.max(1, s.weapon.ammo); s.weapon.cooldown = 0; s.weapon.reloadTimer = 0;
      if (g.combat.fire(s.shooter, s.weapon, _o, _d, 1, { lock: best })) {
        g.bus.emit('sound', 'missile', s.x, s.y, s.z);
        if (--s.left <= 0) { s.left = SAM_SALVO; s.next = time + SAM_RELOAD; } else s.next = time + SAM_INTERVAL;
      }
    }
  }

  /** Engineers at the ends of a destroyed bridge rebuild it. */
  _repairBridge(dt) {
    const b = this.bridge, g = this.game;
    if (!b || b.state === 0) return;
    const c = Math.cos(b.rot), sn = Math.sin(b.rot);
    let crews = 0;
    for (const s of g.soldiers) {
      if (!s.alive || s.vehicle || s.cls !== 3) continue;
      for (const end of [-1, 1]) {
        const ex = b.x + end * (b.d / 2) * sn, ez = b.z + end * (b.d / 2) * c;
        if ((s.pos.x - ex) ** 2 + (s.pos.z - ez) ** 2 < REPAIR_REACH * REPAIR_REACH) { crews++; break; }
      }
    }
    if (crews > 0) g.structures.repairBridge(b, Math.min(3, crews) * dt);
  }

  /** World position of the bridge end on the given side of the river (for the AI). */
  bridgeEnd(x, z, out) {
    const b = this.bridge;
    if (!b) return false;
    const c = Math.cos(b.rot), sn = Math.sin(b.rot);
    let bd = 1e12;
    for (const end of [-1, 1]) {
      const ex = b.x + end * (b.d / 2 + 4) * sn, ez = b.z + end * (b.d / 2 + 4) * c;
      const d = (x - ex) ** 2 + (z - ez) ** 2;
      if (d < bd) { bd = d; out[0] = ex; out[1] = ez; }
    }
    return true;
  }
}
