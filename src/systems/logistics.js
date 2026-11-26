import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../core/config.js';
import {
  SiteTier, TIER_BY_FLAG, capacityFor, needsResupply, resupplyPriority, CRATE_USES, CRATE_REACH, rearmCost,
  STOWAGE, boxSize, mostDepleted, ThrowItem, THROW_STAGGER, THROW_FLIGHT, TRUCK_CRATES, truckClassOf, VEHICLE_RESUPPLY_AT,
} from '../ai/logistics.ts';
import { RadioType } from '../ai/types.ts';

/**
 * Supply rework part 1 (Milestone 3): finite field stock, two-bay supply zones, ground-locked 10-use crates,
 * supply-truck crate drops and the physical crew-to-crew resupply of combat vehicles.
 *
 * Locations. Every HQ supply apron (unlimited) and every flag location (finite, by tier × footprint: see
 * src/ai/logistics.ts) has a Supply Zone with two marked bays aligned with its road access:
 *   Bay 1 VEHICLE_RESUPPLY_BAY    combat vehicles pull up here for ammunition, fuel and internal repair kits;
 *   Bay 2 TRUCK_LOAD_OFFLOAD_BAY  supply trucks load fresh crates (HQ) or offload them into a location's stock.
 * A zone stages up to eight crates on pallets beside the bays (fewer when stock is short). Below 35 % a location
 * signals LOGISTICS_RESUPPLY_NEEDED on its side's radio net (priority by emptiness and frontline proximity).
 *
 * Crates. 10 resupply charges each; soldiers and the player within 4 m interact to rearm (rifle, launcher,
 * smoke) and patch minor wounds. Dropped crates fly a short parabolic arc (0.4–0.7 s) and lock to the ground or
 * pallet height: no rigid body at all (they live in typed arrays and one instanced mesh), so forty stacked crates
 * cost the physics solver nothing. Empty crates collapse and despawn.
 *
 * Vehicle resupply. A vehicle halted in Bay 1 (or within 8 m of a halted CST / AT-CST with crates) has its
 * commander / operator pop the roof hatch; the supplier throws three physical objects along staggered arcs — a
 * caliber-scaled ammunition box stencilled with the depleted weapon's caliber (label textures cached per caliber),
 * a fuel box and a repair kit — which the crewman collects in one seating before dropping back inside. The stock
 * comes out of the zone (or truck), then the vehicle is fully rearmed, refuelled and its kits restocked.
 */

const MAX_CRATES = 480;
const SLOTS = 8;
const MAX_THROWS = 18;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

const CrateState = { FREE: 0, FLYING: 1, LOCKED: 2, COLLAPSING: 3 };

/** Label textures by caliber text, built once (no texture is ever recreated per throw). */
const LABELS = new Map();
function labelTexture(text) {
  let t = LABELS.get(text);
  if (t) return t;
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return null;
  const c = doc.createElement('canvas'); c.width = 128; c.height = 64;
  const x = c.getContext('2d');
  if (!x) return null;
  x.fillStyle = '#4a5530'; x.fillRect(0, 0, 128, 64);
  x.fillStyle = '#d9cf9c'; x.fillRect(6, 10, 116, 44);
  x.fillStyle = '#1c1d18'; x.font = 'bold 22px monospace'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 64, 33, 110);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  LABELS.set(text, t);
  return t;
}

function colored(g, hex) {
  const n = g.attributes.position.count, col = new Float32Array(n * 3), c = new THREE.Color(hex);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

export class LogisticsSystem {
  constructor(game) {
    this.game = game;
    /** @type {any[]} */
    this.locations = [];
    // Crates (typed arrays: no per-crate objects, no rigid bodies).
    const N = MAX_CRATES;
    this.cx = new Float32Array(N); this.cy = new Float32Array(N); this.cz = new Float32Array(N); this.cyaw = new Float32Array(N);
    this.fx = new Float32Array(N); this.fy = new Float32Array(N); this.fz = new Float32Array(N);
    this.ct = new Float32Array(N); this.cdur = new Float32Array(N);
    this.uses = new Int8Array(N); this.state = new Uint8Array(N); this.loc = new Int16Array(N).fill(-1);
    this.team = new Int8Array(N).fill(-1); this.slot = new Int8Array(N).fill(-1);
    this.crateN = 0;
    this.stats = {
      crateUses: 0, cratesDropped: 0, cratesEmptied: 0, truckDrops: 0, offloads: 0, loads: 0, signals: 0,
      rearms: 0, throws: 0, throwLabels: {}, escorts: 0, playerUses: 0, aircraftRearms: 0,
    };
    /** Telemetry lines (newest last, capped) for probes and the debug overlay. */
    this.log = [];
    /** Active vehicle resupplies: { v, source (location | truck), t, items: [{kind,label,mesh}], hatch } */
    this.rearms = [];
    this._dirty = true;
    this._timer = 0;
    this._signalT = 0;
    this._build();
  }

  note(line) { this.log.push(`t${this.game.time.toFixed(0)} ${line}`); if (this.log.length > 200) this.log.shift(); }

  // ================================================================= set-up

  _build() {
    const g = this.game, map = g.map, flags = g.capture.flags, T = map.terrain;
    const supplies = map.supplies || [];
    // HQ zones: every base supply apron (PT parts), unlimited.
    for (const st of supplies) if (st.team >= 0) this._addLocation({ name: `${CONFIG.teams[st.team].name} HQ`, tier: SiteTier.HQ, x: st.x, z: st.z, r: st.r, hq: st.team, flag: -1 });
    // Field locations: one per non-base flag, at its supply station when it has one.
    for (const f of flags) {
      if (f.base) continue;
      let best = null, bd = 140 * 140;
      for (const st of supplies) { if (st.team >= 0) continue; const d = (st.x - f.x) ** 2 + (st.z - f.z) ** 2; if (d < bd) { bd = d; best = st; } }
      const tier = TIER_BY_FLAG[f.name] ?? SiteTier.VILLAGE;
      const p = best || this._roadside(f.x, f.z, 22);
      this._addLocation({ name: f.name, tier, x: p.x, z: p.z, r: f.radius || 50, hq: -1, flag: f.id });
    }
    this._buildVisuals();
    for (const L of this.locations) this._restage(L);
    void T;
  }

  /** A point near (x, z) on open road / flat ground, for zones of sites without a supply station. */
  _roadside(x, z, r) {
    const T = this.game.map.terrain, nav = this.game.nav;
    let best = { x: x + r, z }, bs = -1e9;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (nav && nav.blocked(px, pz, true)) continue;
      const s = (T.roadAt ? T.roadAt(px, pz) : 0) * 2 - (T.slope ? T.slope(px, pz) : 0);
      if (s > bs) { bs = s; best = { x: px, z: pz }; }
    }
    return best;
  }

  _addLocation(o) {
    const T = this.game.map.terrain, nav = this.game.nav;
    const max = o.tier === SiteTier.HQ ? Infinity : capacityFor(o.tier, o.r);
    // Field stocks start part-drawn (the island has been fought over); a hash keeps it deterministic.
    const h = ((o.x * 12.9898 + o.z * 78.233) % 1 + 1) % 1;
    const current = max === Infinity ? Infinity : Math.round(max * (0.3 + 0.4 * ((Math.sin(h * 43758.5453) * 0.5 + 0.5))));
    // Bay axis along the road (or the slope contour) through the zone centre.
    let yaw = 0, bs = -1;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI, dx = Math.sin(a), dz = Math.cos(a);
      let s = 0;
      for (const d of [-12, -6, 6, 12]) s += T.roadAt ? T.roadAt(o.x + dx * d, o.z + dz * d) : 0;
      if (s > bs) { bs = s; yaw = a; }
    }
    const sx = Math.sin(yaw), cz = Math.cos(yaw);
    // The two bays side by side across the road axis, 9 m apart; pallets for the staged crates behind Bay 2.
    const side = (d) => { let x = o.x + cz * d, z = o.z - sx * d; if (nav && nav.blocked(x, z, true)) { x = o.x - cz * d; z = o.z + sx * d; } return { x, z }; };
    const b1 = { x: o.x, z: o.z, yaw }, p2 = side(9), b2 = { x: p2.x, z: p2.z, yaw };
    const slots = [];
    for (let i = 0; i < SLOTS; i++) {
      const along = (i % 4 - 1.5) * 1.3, out = 4.2 + Math.floor(i / 4) * 1.1;
      const dx = b2.x - b1.x, dz = b2.z - b1.z, dl = Math.hypot(dx, dz) || 1;
      const x = b2.x + (dx / dl) * out + sx * along, z = b2.z + (dz / dl) * out + cz * along;
      slots.push({ x, z, y: T.height(x, z) + 0.12, crate: -1 });
    }
    this.locations.push({
      id: this.locations.length, name: o.name, tier: o.tier, hq: o.hq, flag: o.flag, x: o.x, z: o.z, r: o.r,
      max, current, bay1: b1, bay2: b2, slots, signalAt: -1e9, lowSince: -1, signals: 0, drawn: 0, delivered: 0,
    });
  }

  /**
   * Engineer-built checkpoint (Milestone 3): a forward stash with the smallest field capacity and its own two-bay
   * zone, held by the side that built it.
   */
  addCheckpoint(x, z, team, name) {
    this._addLocation({ name, tier: SiteTier.CHECKPOINT, x, z, r: 45, hq: -1, flag: -1 });
    const L = this.locations[this.locations.length - 1];
    L.cpTeam = team; L.current = Math.round(L.max * 0.6);
    this._dressLocation(L);
    this._restage(L);
    this.note(`checkpoint ${name} opens a supply zone (${L.current}/${L.max})`);
    return L;
  }

  /** Side holding a location: the HQ's own side, else the owner of its flag (-1 nobody). */
  owner(L) { return L.hq >= 0 ? L.hq : L.flag >= 0 ? this.game.capture.flags[L.flag].owner : L.cpTeam ?? -1; }

  _buildVisuals() {
    const scene = this.game.render && this.game.render.scene;
    if (!scene) return;
    // Crate: olive box with darker lid and steel bands (vertex colours; one instanced mesh for all crates).
    const body = colored(new THREE.BoxGeometry(0.9, 0.5, 0.6), 0x55613a);
    const lid = colored(new THREE.BoxGeometry(0.94, 0.06, 0.64).translate(0, 0.27, 0), 0x3d4529);
    const b1 = colored(new THREE.BoxGeometry(0.05, 0.52, 0.62).translate(-0.3, 0, 0), 0x6b6d66);
    const b2 = colored(new THREE.BoxGeometry(0.05, 0.52, 0.62).translate(0.3, 0, 0), 0x6b6d66);
    const plate = colored(new THREE.BoxGeometry(0.34, 0.16, 0.01).translate(0, 0.02, 0.305), 0xd9cf9c);
    const crateGeo = mergeGeometries([body, lid, b1, b2, plate]).translate(0, 0.25, 0);
    const crateMat = this.game.render.setupMaterial ? this.game.render.setupMaterial(new THREE.MeshLambertMaterial({ vertexColors: true })) : new THREE.MeshLambertMaterial({ vertexColors: true });
    this.crateMesh = new THREE.InstancedMesh(crateGeo, crateMat, MAX_CRATES);
    this.crateMesh.count = 0; this.crateMesh.castShadow = true; this.crateMesh.receiveShadow = true;
    this.crateMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.crateMesh.frustumCulled = false;
    scene.add(this.crateMesh);
    // Zone dressing: painted bay outlines (thin strips), pallet skids, bollards (static, built once per zone).
    this._crateMat = crateMat;
    for (const L of this.locations) this._dressLocation(L);
    // Thrown-item pool: ammunition box (label face), fuel box, repair kit.
    this.throwPool = [];
    const fuelGeo = mergeGeometries([colored(new THREE.BoxGeometry(0.34, 0.46, 0.16), 0x6b2a22), colored(new THREE.BoxGeometry(0.08, 0.08, 0.08).translate(0.1, 0.27, 0), 0x2b2b28), colored(new THREE.BoxGeometry(0.2, 0.04, 0.04).translate(-0.04, 0.25, 0), 0x2b2b28)]);
    const kitGeo = mergeGeometries([colored(new THREE.BoxGeometry(0.5, 0.2, 0.22), 0x8d9396), colored(new THREE.BoxGeometry(0.22, 0.05, 0.04).translate(0, 0.13, 0), 0x3a3c3e)]);
    this._fuelGeo = fuelGeo; this._kitGeo = kitGeo; this._itemMat = crateMat;
    this._boxGeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < MAX_THROWS; i++) {
      const m = new THREE.Mesh(this._boxGeo, crateMat);
      m.visible = false; m.castShadow = true; scene.add(m);
      this.throwPool.push({ mesh: m, busy: false });
    }
    this._ammoMats = new Map();
  }

  _dressLocation(L) {
    const scene = this.game.render && this.game.render.scene;
    if (!scene || !this._crateMat) return;
    const strips = [], pallets = [], bollards = [];
    const T = this.game.map.terrain;
    const put = (list, geo, x, z, yaw, y) => { _m.compose(_p.set(x, y ?? T.height(x, z), z), _q.setFromEuler(_e.set(0, yaw, 0)), _s.set(1, 1, 1)); list.push(geo.clone().applyMatrix4(_m)); };
    const G = this._dressGeo || (this._dressGeo = {
      stripGeo: colored(new THREE.BoxGeometry(0.18, 0.03, 7.5), 0xd8c24a), stripX: colored(new THREE.BoxGeometry(4.8, 0.03, 0.18), 0xd8c24a),
      stripW: colored(new THREE.BoxGeometry(4.8, 0.03, 0.18), 0xe8e6dc), stripWZ: colored(new THREE.BoxGeometry(0.18, 0.03, 7.5), 0xe8e6dc),
      palletGeo: mergeGeometries([colored(new THREE.BoxGeometry(1.2, 0.1, 1.0), 0x7a6040), colored(new THREE.BoxGeometry(1.1, 0.04, 0.12).translate(0, 0.07, 0.35), 0x8c7150)]),
      bollardGeo: mergeGeometries([colored(new THREE.CylinderGeometry(0.11, 0.13, 0.9, 7).translate(0, 0.45, 0), 0xd8c24a), colored(new THREE.CylinderGeometry(0.115, 0.115, 0.14, 7).translate(0, 0.62, 0), 0x2a2b28)]),
    });
    for (const [b, yellow] of [[L.bay1, true], [L.bay2, false]]) {
      const s = Math.sin(b.yaw), c = Math.cos(b.yaw), y = T.height(b.x, b.z) + 0.03;
      const sg = yellow ? G.stripGeo : G.stripWZ, sx = yellow ? G.stripX : G.stripW;
      for (const d of [-2.4, 2.4]) put(strips, sg, b.x + c * d, b.z - s * d, b.yaw, y);
      for (const d of [-3.75, 3.75]) put(strips, sx, b.x + s * d, b.z + c * d, b.yaw, y);
      for (const d of [-3.75, 3.75]) for (const e of [-2.9, 2.9]) put(bollards, G.bollardGeo, b.x + s * d + c * e, b.z + c * d - s * e, 0);
    }
    for (let i = 0; i < L.slots.length; i += 2) { const sl = L.slots[i], sn = L.slots[i + 1] || sl; put(pallets, G.palletGeo, (sl.x + sn.x) / 2, (sl.z + sn.z) / 2, L.bay2.yaw); }
    const merged = mergeGeometries([...strips, ...pallets, ...bollards]);
    const mesh = new THREE.Mesh(merged, this._crateMat);
    mesh.receiveShadow = true; mesh.castShadow = true;
    scene.add(mesh);
  }

  _ammoMaterial(label) {
    let m = this._ammoMats.get(label);
    if (m) return m;
    const tex = labelTexture(label);
    const side = new THREE.MeshLambertMaterial({ color: 0x4a5530 });
    const face = tex ? new THREE.MeshLambertMaterial({ map: tex }) : side;
    m = [side, side, side, side, face, side];
    this._ammoMats.set(label, m);
    return m;
  }

  // ================================================================= crates

  _alloc() {
    for (let i = 0; i < this.crateN; i++) if (this.state[i] === CrateState.FREE) return i;
    return this.crateN < MAX_CRATES ? this.crateN++ : -1;
  }

  /**
   * Drops a crate from (fx, fy, fz) onto the ground at (x, z) (or a pallet slot) along a short arc; it locks in
   * place on landing. @returns crate index or -1
   */
  dropCrate(team, fx, fy, fz, x, z, locId = -1, slot = -1, y = NaN) {
    const i = this._alloc();
    if (i < 0) return -1;
    const T = this.game.map.terrain;
    this.fx[i] = fx; this.fy[i] = fy; this.fz[i] = fz;
    this.cx[i] = x; this.cz[i] = z; this.cy[i] = Number.isFinite(y) ? y : Math.max(T.height(x, z), CONFIG.world.waterLevel);
    this.cyaw[i] = Math.atan2(x - fx, z - fz) + (((i * 7919) % 100) / 100 - 0.5) * 0.5;
    this.ct[i] = 0; this.cdur[i] = Math.min(0.7, Math.max(0.4, Math.hypot(x - fx, z - fz) / 12));
    this.uses[i] = CRATE_USES; this.state[i] = CrateState.FLYING; this.loc[i] = locId; this.team[i] = team; this.slot[i] = slot;
    this._dirty = true;
    this.stats.cratesDropped++;
    return i;
  }

  /** Nearest usable crate of `team` within r of (x, z), or -1. Writes its position to out. */
  nearestCrate(team, x, z, r, out) {
    let best = -1, bd = r * r;
    for (let i = 0; i < this.crateN; i++) {
      if (this.state[i] !== CrateState.LOCKED || this.team[i] !== team || this.uses[i] <= 0) continue;
      const d = (this.cx[i] - x) ** 2 + (this.cz[i] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && out) { out[0] = this.cx[best]; out[1] = this.cz[best]; }
    return best;
  }

  /** Whether soldier s needs anything a crate gives. */
  wants(s) {
    for (const w of s.weapons) if (w.reserve !== Infinity && w.reserve < w.def.reserve) return true;
    return s.health < 70;
  }

  /**
   * Soldier s interacts with crate i (must be within 4 m): rearms every weapon, tops up smoke, patches minor
   * wounds; one charge off the crate. @returns true when something was taken
   */
  useCrate(i, s) {
    if (i < 0 || this.state[i] !== CrateState.LOCKED || this.uses[i] <= 0) return false;
    if ((this.cx[i] - s.pos.x) ** 2 + (this.cz[i] - s.pos.z) ** 2 > CRATE_REACH * CRATE_REACH) return false;
    if (!this.wants(s)) return false;
    for (const w of s.weapons) if (w.reserve !== Infinity && w.reserve < w.def.reserve) w.reserve = w.def.reserve;
    if (s.health < 70) s.health = Math.min(100, s.health + 25);
    if (s.ai && s.ai.smokeLeft !== undefined) s.ai.smokeLeft = Math.max(s.ai.smokeLeft, 1);
    this.uses[i]--;
    this.stats.crateUses++;
    if (s.isPlayer) { this.stats.playerUses++; this.game.bus.emit('notice', `RESUPPLIED (${this.uses[i]}/10 LEFT)`); }
    if (this.uses[i] <= 0) this._empty(i);
    return true;
  }

  /** Takes `n` charges from a location's staged crates (vehicle rearms). @returns charges actually taken */
  _draw(L, n) {
    if (L.max === Infinity) return n;
    let got = 0;
    for (const sl of L.slots) {
      while (got < n && sl.crate >= 0 && this.uses[sl.crate] > 0) { this.uses[sl.crate]--; got++; if (this.uses[sl.crate] <= 0) this._empty(sl.crate); }
      if (got >= n) break;
    }
    L.drawn += got;
    return got;
  }

  _empty(i) {
    this.state[i] = CrateState.COLLAPSING; this.ct[i] = 0;
    this.stats.cratesEmptied++;
    const li = this.loc[i];
    if (li >= 0) {
      const L = this.locations[li];
      if (L.max !== Infinity) L.current = Math.max(0, L.current - 1);
      if (this.slot[i] >= 0) L.slots[this.slot[i]].crate = -1;
    }
    this._dirty = true;
  }

  /** Stages crates on a location's pallets: as many as its stock allows (HQ: always full). */
  _restage(L) {
    const team = this.owner(L);
    let staged = 0;
    for (const sl of L.slots) if (sl.crate >= 0) staged++;
    for (let k = 0; k < L.slots.length; k++) {
      const sl = L.slots[k];
      if (sl.crate >= 0) continue;
      if (L.max !== Infinity && staged >= L.current) break;
      const i = this._alloc();
      if (i < 0) break;
      this.cx[i] = sl.x; this.cz[i] = sl.z; this.cy[i] = sl.y; this.cyaw[i] = L.bay2.yaw;
      this.uses[i] = CRATE_USES; this.state[i] = CrateState.LOCKED; this.loc[i] = L.id; this.team[i] = team; this.slot[i] = k;
      sl.crate = i; staged++;
      this._dirty = true;
    }
    // Staged crates serve whoever holds the location now.
    for (const sl of L.slots) if (sl.crate >= 0) this.team[sl.crate] = team;
  }

  // ================================================================= trucks

  /** Crates a supply truck carries (initialised on first use). */
  crates(v) { if (v.crates === undefined) { const k = truckClassOf(v.def.type); v.crates = k >= 0 ? TRUCK_CRATES[k] : 0; v.cratesMax = v.crates; } return v.crates; }

  /** World point at the tailgate of a truck (behind its bed), and the drop point on the ground behind it. */
  _tail(v, back, out) {
    const s = Math.sin(v.yaw), c = Math.cos(v.yaw), hz = v.def.half[2];
    out.x = v.pos.x - s * (hz + back); out.z = v.pos.z - c * (hz + back); out.y = v.pos.y + 0.4;
    return out;
  }

  /** Whether a seat of the truck is its supplier (rear cargo bed) and someone sits in it. */
  supplier(v) {
    const seats = v.def.seats;
    for (let i = 0; i < seats.length; i++) if (seats[i].role === 'supplier') return v.seats[i] || null;
    return null;
  }

  /**
   * Supply request answered by a truck: the supplier (or, with nobody in the bed, the crew) tosses a 10-use crate
   * off the tailgate onto the ground behind it. @returns crate index or -1
   */
  truckDrop(v, why = 'supply request') {
    if (!v.alive || this.crates(v) <= 0 || Math.abs(v.speed) > 2.5) return -1;
    const team = v.occupied ? v.team : v.spawn.team;
    const from = this._tail(v, 0.2, _v), fx = from.x, fy = from.y, fz = from.z;
    const to = this._tail(v, 3.2, _v);
    const i = this.dropCrate(team, fx, fy, fz, to.x + (Math.random() - 0.5) * 1.2, to.z + (Math.random() - 0.5) * 1.2);
    if (i < 0) return -1;
    v.crates--;
    this.stats.truckDrops++;
    this.note(`${v.def.label} ${this.supplier(v) ? 'supplier' : 'crew'} drops a crate off the tailgate (${why}; ${v.crates} left)`);
    return i;
  }

  /** Nearest HQ zone of `team` (for loading). */
  hqZone(team, x, z) {
    let best = null, bd = 1e12;
    for (const L of this.locations) { if (L.hq !== team) continue; const d = (L.bay2.x - x) ** 2 + (L.bay2.z - z) ** 2; if (d < bd) { bd = d; best = L; } }
    return best;
  }

  /** Location nearest (x, z) (signals carry the Bay 2 position). */
  locationAt(x, z, r = 30) {
    let best = null, bd = r * r;
    for (const L of this.locations) { const d = (L.bay2.x - x) ** 2 + (L.bay2.z - z) ** 2; if (d < bd) { bd = d; best = L; } }
    return best;
  }

  /** Truck halted at an HQ's Bay 2: loads to capacity. @returns crates loaded */
  loadAt(v, L) {
    const need = (v.cratesMax ?? this.crates(v)) - v.crates;
    if (need <= 0 || L.hq < 0) return 0;
    v.crates += need;
    this.stats.loads++;
    this.note(`${v.def.label} loads ${need} crates at ${L.name} Bay 2`);
    return need;
  }

  /**
   * Truck halted at a field location's Bay 2: its supplier hands crates down one by one onto the pallets (each a
   * short arc that locks in a slot) until the stock is full or the bed is empty. Called each second while halted.
   * @returns crates delivered this call
   */
  offloadStep(v, L, n = 2) {
    if (L.max === Infinity) return 0;
    let done = 0;
    while (done < n && this.crates(v) > 0 && L.current < L.max) {
      L.current++; L.delivered++; v.crates--; done++;
      // A crate visibly goes over the tailgate when a pallet slot is free; the rest go into the stores.
      const k = L.slots.findIndex((s) => s.crate < 0);
      if (k >= 0) {
        const from = this._tail(v, 0.2, _v), sl = L.slots[k];
        const i = this.dropCrate(this.owner(L), from.x, from.y, from.z, sl.x, sl.z, L.id, k, sl.y);
        if (i >= 0) sl.crate = i;
      }
    }
    if (done) { this.stats.offloads += done; }
    return done;
  }

  // ================================================================= vehicle resupply

  /** Lowest stock fraction over a vehicle's limited weapons. */
  stockLow(v) {
    let f = 1;
    for (const w of v.weapons) if (w.stockLoaded !== undefined) f = Math.min(f, w.stockFrac);
    return f;
  }

  /** Whether a vehicle should weigh a resupply run (Q1: why): primary ordnance or fuel below 25 %. */
  needsRearm(v) {
    const w0 = v.weapons[0];
    const primary = w0 && w0.stockLoaded !== undefined ? w0.stockFrac : this.stockLow(v);
    return primary < VEHICLE_RESUPPLY_AT || (v.fuel !== undefined && v.fuel < VEHICLE_RESUPPLY_AT);
  }

  /** Whether anything at all is missing (a resupply would add something). */
  depleted(v) { return this.stockLow(v) < 0.98 || (v.fuel ?? 1) < 0.98 || (v.kits ?? 0) < (v.kitsMax ?? 0); }

  /**
   * Where `v` can rearm: Bay 1 of the nearest zone its side holds with stock, or a halted CST / AT-CST with crates
   * (whichever is nearer). Writes [x, z] to out. @returns the source (location or truck) or null
   */
  rearmPoint(v, out, maxR = 1400) {
    const team = v.team;
    let best = null, bd = maxR * maxR;
    for (const L of this.locations) {
      if (this.owner(L) !== team || (L.max !== Infinity && L.current < 1)) continue;
      const d = (L.bay1.x - v.pos.x) ** 2 + (L.bay1.z - v.pos.z) ** 2;
      if (d < bd) { bd = d; best = L; out[0] = L.bay1.x; out[1] = L.bay1.z; }
    }
    const list = this.game.vehicles.list;
    const tr2 = Math.min(bd, 700 * 700);
    let td = tr2;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t === v || !t.alive || truckClassOf(t.def.type) < 1 || (t.occupied ? t.team : t.spawn.team) !== team || this.crates(t) <= 0) continue;
      const d = (t.pos.x - v.pos.x) ** 2 + (t.pos.z - v.pos.z) ** 2;
      if (d < td) { td = d; best = t; const p = this._tail(t, 6, _v); out[0] = p.x; out[1] = p.z; }
    }
    return best;
  }

  /** Which seat's occupant takes the throws: the commander / gunner up in a roof hatch, else the driver. */
  _catcher(v) {
    const seats = v.def.seats;
    for (let i = 0; i < seats.length; i++) if ((seats[i].role === 'commander') && v.seats[i]) return i;
    for (let i = 0; i < seats.length; i++) if ((seats[i].role === 'gunner') && v.seats[i]) return i;
    return v.seats[0] ? 0 : -1;
  }

  /** Starts the throw sequence for a halted vehicle at its source. */
  _startRearm(v, src) {
    const seat = this._catcher(v);
    if (seat < 0) return;
    const truck = src.def !== undefined;
    const cost = rearmCost(v.def.armor);
    let got;
    if (truck) {
      // A truck spends whole crates: one per rearm (two for heavy armour).
      const crates = cost >= 6 ? 2 : 1;
      if (this.crates(src) < 1) return;
      src.crates = Math.max(0, src.crates - crates); got = cost;
    } else got = this._draw(src, cost);
    if (got <= 0) return;
    // Caliber of the most depleted limited weapon.
    const fr = [], lb = [];
    for (const w of v.weapons) { fr.push(w.stockFrac); lb.push(w.stockLoaded !== undefined && STOWAGE[w.id] ? STOWAGE[w.id].label : null); }
    const wi = mostDepleted(fr, lb);
    const label = wi >= 0 ? lb[wi] : '7.62MM';
    // The crewman pops the hatch (or, without a roof hatch, the seat's occupant leans out beside the hull).
    const hatch = !!(v._hasHatch && v._hasHatch[seat]);
    if (hatch) v.hatchHold = seat; else if (v.holdDoors) v.holdDoors(4);
    const items = [ThrowItem.AMMO, ThrowItem.FUEL, ThrowItem.KIT].map((kind, k) => ({ kind, label, start: k * THROW_STAGGER, mesh: null, done: false }));
    this.rearms.push({ v, src, truck, seat, t: 0, items, label, got, hatch });
    this.stats.rearms++;
    v._rearming = true;
    this.stats.throwLabels[label] = (this.stats.throwLabels[label] || 0) + 1;
    const from = truck ? `${src.def.label} supplier` : `${src.name} Bay 1 attendant`;
    this.note(`${v.def.label} halts for resupply: ${from} throws ${label} ammo box, fuel box, repair kit to the ${v.def.seats[seat].role || 'driver'} ${hatch ? 'up in the hatch' : 'leaning out beside the hull'} (${got} charges)`);
  }

  _throwOrigin(r, out) {
    if (r.truck) return this._tail(r.src, 0.1, out).setY(r.src.pos.y + 1.2);
    const b = r.src.bay1, d = 4;
    out.set(b.x + Math.cos(b.yaw) * d, this.game.map.terrain.height(b.x, b.z) + 1.2, b.z - Math.sin(b.yaw) * d);
    return out;
  }

  _updateRearms(dt) {
    for (let k = this.rearms.length - 1; k >= 0; k--) {
      const r = this.rearms[k], v = r.v;
      r.t += dt;
      const gone = !v.alive || Math.abs(v.speed) > 2;
      // Catch point: the crewman at the hatch / seat.
      if (r.hatch && v.seatEye) { v.seatEye(r.seat, _p); _p.y += 0.35; }
      else { const s = Math.sin(v.yaw), c = Math.cos(v.yaw), w = v.def.half[0] + 0.6; _p.set(v.pos.x + c * w, v.pos.y - v.def.ride + 1.3, v.pos.z - s * w); }
      let all = true;
      for (const it of r.items) {
        if (it.done) continue;
        all = false;
        if (r.t < it.start) continue;
        if (!it.mesh && this.throwPool) {
          const slot = this.throwPool.find((s) => !s.busy);
          if (slot) {
            slot.busy = true; it.slot = slot; it.mesh = slot.mesh;
            const m = slot.mesh;
            if (it.kind === ThrowItem.AMMO) { const [w, h, d] = boxSize(it.label); m.geometry = this._boxGeo; m.material = this._ammoMaterial(it.label); m.scale.set(w, h, d); }
            else { m.geometry = it.kind === ThrowItem.FUEL ? this._fuelGeo : this._kitGeo; m.material = this._itemMat; m.scale.set(1, 1, 1); }
            m.visible = true;
            this.stats.throws++;
          }
        }
        const u = Math.min(1, (r.t - it.start) / THROW_FLIGHT);
        if (it.mesh) {
          const o = this._throwOrigin(r, _v);
          it.mesh.position.set(o.x + (_p.x - o.x) * u, o.y + (_p.y - o.y) * u + Math.sin(u * Math.PI) * 1.6, o.z + (_p.z - o.z) * u);
          it.mesh.rotation.set(u * 2.4, Math.atan2(_p.x - o.x, _p.z - o.z), u * 1.1);
        }
        if (u >= 1 || gone) { it.done = true; if (it.slot) { it.slot.busy = false; it.mesh.visible = false; } }
      }
      // All three caught: one continuous catch-and-stow, then back inside and the hatch shut.
      if ((all && r.t > THROW_STAGGER * 2 + THROW_FLIGHT + 0.8) || gone) {
        if (!gone) {
          for (const w of v.weapons) if (w.stockLoaded !== undefined) w.restock(1);
          v.fuel = 1; if (v.kitsMax !== undefined) v.kits = v.kitsMax;
          if (v.repair) v.repair(v.def.health * 0.1);
          this.note(`${v.def.label}: crewman stows ammo, fuel and kit in one seating; rearmed (${(this.stockLow(v) * 100).toFixed(0)} %), fuel 100 %`);
          if (v.seats.some((o) => o && o.isPlayer)) this.game.bus.emit('notice', 'REARMED · REFUELLED · KITS RESTOCKED');
        }
        if (v.hatchHold === r.seat) v.hatchHold = -1;
        v._rearming = false;
        v._rearmedAt = this.game.time;
        this.rearms.splice(k, 1);
      }
    }
  }

  // ================================================================= per-frame

  update(dt) {
    const g = this.game;
    // Crate arcs and collapses.
    for (let i = 0; i < this.crateN; i++) {
      const st = this.state[i];
      if (st === CrateState.FLYING) {
        this.ct[i] += dt;
        if (this.ct[i] >= this.cdur[i]) { this.state[i] = CrateState.LOCKED; this.ct[i] = 0; }
        this._dirty = true;
      } else if (st === CrateState.COLLAPSING) {
        this.ct[i] += dt;
        if (this.ct[i] > 0.6) { this.state[i] = CrateState.FREE; this.loc[i] = -1; this.slot[i] = -1; }
        this._dirty = true;
      }
    }
    if (this.rearms.length) this._updateRearms(dt);
    this._timer -= dt;
    if (this._timer <= 0) { this._timer = 1; this._tick(); }
    if (this._dirty) this._writeInstances();
    void g;
  }

  _tick() {
    const g = this.game, time = g.time;
    // Field stock restaging, owners, resupply signals.
    this._signalT -= 1;
    const signal = this._signalT <= 0;
    if (signal) this._signalT = 5;
    for (const L of this.locations) {
      this._restage(L);
      if (!signal || L.max === Infinity) continue;
      const team = this.owner(L);
      if (team < 0 || !needsResupply(L.current, L.max)) { L.lowSince = -1; continue; }
      if (L.lowSince < 0) L.lowSince = time;
      const F = g.ai && g.ai.frontline;
      let fd = Infinity;
      if (F) for (let c = 0; c < F.count; c++) if (F.zone[team][c] === 2) fd = Math.min(fd, Math.hypot(F.cx(c) - L.x, F.cz(c) - L.z));
      const pr = resupplyPriority(L.current, L.max, fd);
      const radio = g.ai && g.ai.radio;
      if (radio && radio.publish(RadioType.LOGISTICS_RESUPPLY_NEEDED, team, -1, -1, L.bay2.x, 0, L.bay2.z, -1, pr, time, 0)) {
        if (time - L.signalAt > 30) { this.stats.signals++; L.signals++; this.note(`${L.name} (${L.current}/${L.max}) signals LOGISTICS_RESUPPLY_NEEDED, priority ${pr}${fd < Infinity ? `, front ${fd.toFixed(0)} m` : ''}`); }
        L.signalAt = time;
      }
    }
    // Vehicles halted in a Bay 1 / beside a supply truck: start the throw sequence.
    const list = g.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.alive || v._rearming || v.def.static || !v.occupied || Math.abs(v.speed) > 0.8 || truckClassOf(v.def.type) >= 0) continue;
      if (v.isAircraft) { this._aircraft(v); continue; }
      if (!this.depleted(v) || time - (v._rearmedAt || -1e9) < 20) continue;
      // Only a vehicle that wants it (crew ran Q1–Q6 and drove here: servicing) or one that pulled into the bay.
      const src = this._sourceAt(v);
      if (src) this._startRearm(v, src);
    }
  }

  /** The supply source a halted vehicle stands at: a Bay 1 within 7 m, or a halted supply truck within 8 m. */
  _sourceAt(v) {
    for (const L of this.locations) {
      if (this.owner(L) !== v.team || (L.max !== Infinity && L.current < 1)) continue;
      if ((L.bay1.x - v.pos.x) ** 2 + (L.bay1.z - v.pos.z) ** 2 < 7 * 7) return L;
    }
    const list = this.game.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t === v || !t.alive || truckClassOf(t.def.type) < 1 || (t.occupied ? t.team : t.spawn.team) !== v.team || Math.abs(t.speed) > 1 || this.crates(t) <= 0) continue;
      const hz = v.def.half[2] + t.def.half[2];
      if ((t.pos.x - v.pos.x) ** 2 + (t.pos.z - v.pos.z) ** 2 < (8 + hz) ** 2) return t;
    }
    return null;
  }

  /** Landed aircraft at an owned zone or station: rearmed by the ground crew (no throws), stock drawn. */
  _aircraft(v) {
    if (v.altitude > 3 || !this.depleted(v) || this.game.time - (v._rearmedAt || -1e9) < 15) return;
    for (const L of this.locations) {
      if (this.owner(L) !== v.team || (L.max !== Infinity && L.current < 1)) continue;
      if ((L.x - v.pos.x) ** 2 + (L.z - v.pos.z) ** 2 > (L.max === Infinity ? 260 : 90) ** 2) continue;
      if (this._draw(L, rearmCost(v.def.armor)) <= 0) continue;
      for (const w of v.weapons) if (w.stockLoaded !== undefined) w.restock(1);
      v._rearmedAt = this.game.time;
      this.stats.aircraftRearms++;
      return;
    }
  }

  _writeInstances() {
    this._dirty = false;
    const mesh = this.crateMesh;
    if (!mesh) return;
    let n = 0;
    for (let i = 0; i < this.crateN; i++) {
      const st = this.state[i];
      if (st === CrateState.FREE) continue;
      let x = this.cx[i], y = this.cy[i], z = this.cz[i], sc = 1, tilt = 0;
      if (st === CrateState.FLYING) {
        const u = Math.min(1, this.ct[i] / this.cdur[i]);
        x = this.fx[i] + (this.cx[i] - this.fx[i]) * u; z = this.fz[i] + (this.cz[i] - this.fz[i]) * u;
        y = this.fy[i] + (this.cy[i] - this.fy[i]) * u + Math.sin(u * Math.PI) * 0.9;
        tilt = (1 - u) * 0.6;
      } else if (st === CrateState.COLLAPSING) { const u = this.ct[i] / 0.6; sc = Math.max(0.01, 1 - u); y -= u * 0.25; tilt = u * 0.4; }
      _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(tilt, this.cyaw[i], 0)), _s.set(1, st === CrateState.COLLAPSING ? sc : 1, 1));
      mesh.setMatrixAt(n++, _m);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    void ZERO;
  }

  /** Debug / HUD summary: supply per location. */
  summary() {
    return this.locations.filter((L) => L.max !== Infinity).map((L) => `${L.name} ${L.current}/${L.max}`).join(' · ');
  }

  serialize() { return this.locations.map((L) => (L.max === Infinity ? -1 : L.current)); }
  deserialize(a) { if (!Array.isArray(a)) return; a.forEach((c, i) => { const L = this.locations[i]; if (L && c >= 0) L.current = c; }); }
}
