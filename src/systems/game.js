import * as THREE from 'three';
import { CONFIG } from '../core/config.js';
import { EventBus } from '../core/event-bus.js';
import { StateStore } from '../core/state-store.js';
import { generateMap } from '../world/map-generator.js';
import { PhysicsSystem } from './physics.js';
import { NavigationSystem } from './navigation.js';
import { RenderSystem } from './renderer.js';
import { ChunkManager } from './chunk-manager.js';
import { ParticleSystem } from './particles.js';
import { SoldierRenderer } from './soldier-renderer.js';
import { VehicleSystem } from './vehicles.js';
import { CombatSystem } from './combat.js';
import { CaptureSystem } from './capture.js';
import { AudioSystem } from './audio.js';
import { InputSystem } from './input.js';
import { Soldier } from '../entities/soldier.js';
import { FACTIONS, loadoutFor, classFor } from '../entities/factions.js';
import { AIAgent } from '../entities/ai-agent.js';
import { AIDirector } from '../ai/director.ts';
import { PlayerController } from '../entities/player.js';
import { Hud } from '../ui/hud.js';

const _v = new THREE.Vector3();
const _qi = new THREE.Quaternion();
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

/**
 * Composition root and frame loop. Systems are constructed in dependency
 * order, talk to each other through the event bus where they can, and are
 * ticked here in one explicit, deterministic sequence.
 */
export class Game {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} touchLayer
   * @param {'low'|'medium'|'high'} quality
   * @param {(fraction: number, label: string) => void} onProgress
   * @returns {Promise<Game>}
   */
  static async create(canvas, touchLayer, quality, onProgress) {
    const game = new Game();
    await game._init(canvas, touchLayer, quality, onProgress);
    return game;
  }

  constructor() {
    /** @type {'menu'|'playing'|'paused'|'over'} */
    this.mode = 'menu';
    this.time = 0;
    this._acc = 0;
    this._last = 0;
    this._raf = 0;
    this._menuAngle = 0;
    this._frame = this._frame.bind(this);
  }

  async _init(canvas, touchLayer, quality, onProgress) {
    this.bus = new EventBus();
    this.state = new StateStore(this.bus);

    onProgress(0.05, 'Generating terrain…');
    await nextFrame();
    this.map = generateMap(CONFIG.seed);

    onProgress(0.25, 'Building physics world…');
    await nextFrame();
    this.physics = await PhysicsSystem.create(this.map);

    onProgress(0.45, 'Generating navigation grid…');
    await nextFrame();
    this.nav = new NavigationSystem(this.map);

    onProgress(0.55, 'Starting renderer…');
    await nextFrame();
    this.render = new RenderSystem(canvas, quality);
    this.chunks = new ChunkManager(this.render, this.map);
    this.particles = new ParticleSystem(this.render);

    onProgress(0.7, 'Mustering forces…');
    await nextFrame();
    /** @type {Soldier[]} */
    this.soldiers = [];
    const override = parseInt(new URLSearchParams(location.search).get('bots') || '', 10);
    const perTeam = Number.isFinite(override) && override > 1 ? override : CONFIG.match.soldiersPerTeam;
    for (let team = 0; team < 2; team++) {
      const faction = FACTIONS[CONFIG.teams[team].faction];
      for (let i = 0; i < perTeam; i++) {
        // The human takes the second slot of the first fire team (a rifleman, never squad leader).
        const isPlayer = team === 0 && i === 1;
        const cls = classFor(faction, i, perTeam);
        const s = new Soldier(this.soldiers.length, team, isPlayer, loadoutFor(faction, i, isPlayer, cls));
        s.cls = cls;
        this.soldiers.push(s);
      }
    }
    this.player = /** @type {Soldier} */ (this.soldiers.find((s) => s.isPlayer));
    this.soldierRenderer = new SoldierRenderer(this.render, this.soldiers, this.map.terrain);
    this.vehicles = new VehicleSystem(this);
    this.combat = new CombatSystem(this);
    this.capture = new CaptureSystem(this);
    /** Combined-arms AI: perception, utility brains, squads, convoys, crews and the tactical radio. */
    this.ai = new AIDirector(/** @type {any} */ (this), (s) => /** @type {any} */ (new AIAgent(this, /** @type {Soldier} */ (s))),
      { seed: CONFIG.seed, waterLevel: CONFIG.world.waterLevel });
    this.audio = new AudioSystem(this.bus);
    this.input = new InputSystem(touchLayer);
    this.playerCtl = new PlayerController(this, this.player);
    this.hud = new Hud(this);
    for (const f of this.capture.flags) this.chunks.setFlagOwner(f.id, f.owner);
    this.bus.on('match:over', (winner) => this._onMatchOver(winner));

    this._registerState();
    this._muster();
    this._initial = this.state.snapshot();

    onProgress(0.85, 'Streaming world…');
    await nextFrame();
    const centre = this.capture.flags[2];
    this.render.camera.position.set(centre.x, centre.y + 50, centre.z - 100);
    this.chunks.update(0, this.render.camera.position, true);
    // Compile shaders up-front so the first combat frames do not hitch.
    this.render.renderer.compile(this.render.scene, this.render.camera);
    onProgress(1, 'Ready');
  }

  /** Wires every stateful system into the state store. */
  _registerState() {
    const st = this.state;
    st.register('match', {
      serialize: () => ({ time: this.time }),
      deserialize: (d) => { this.time = d.time; },
    });
    st.register('props', {
      serialize: () => this.map.props.filter((p) => p.destructible && !p.alive).map((p) => p.id),
      deserialize: (dead) => {
        const set = new Set(dead);
        for (const p of this.map.props) {
          if (!p.destructible) continue;
          const alive = !set.has(p.id);
          if (alive && !p.alive) { this.physics.createPropCollider(p); this.nav.stampProp(p, 1); p.hp = p.type === 'crate' ? 90 : 260; }
          else if (!alive && p.alive) { this.physics.removeProp(p); this.nav.stampProp(p, -1); }
          p.alive = alive;
        }
        this.chunks.refreshDestructibles();
      },
    });
    st.register('vehicles', this.vehicles);
    st.register('capture', this.capture);
    st.register('soldiers', {
      serialize: () => this.soldiers.map((s) => s.serialize()),
      deserialize: (list) => {
        list.forEach((d, i) => {
          const s = this.soldiers[i];
          if (!s) return;
          s.deserialize(d);
          if (s.ai) s.ai.reset();
        });
        this.ai.reset();
        this.combat.projectiles.releaseAll();
      },
    });
  }

  /** Initial deployment: bots trickle in at their flags, the player waits for DEPLOY. */
  _muster() {
    for (const s of this.soldiers) {
      s.alive = false;
      s.respawnTimer = s.isPlayer ? 0 : Math.random() * 2.5;
    }
  }

  /** Picks a spawn flag (owned, closest to the squad objective) and places the soldier. */
  spawnSoldier(s) {
    const flags = this.capture.flags, objective = s.squad ? s.squad.objective : null;
    let best = null, bestScore = 1e9;
    for (const f of flags) {
      if (f.owner !== s.team) continue;
      let score = objective ? Math.hypot(f.x - objective.x, f.z - objective.z) : Math.random() * 100;
      if (f.contestedBy >= 0) score += 150; // avoid spawning into a firefight when possible
      if (f === objective) score += 60;
      if (score < bestScore) { bestScore = score; best = f; }
    }
    const home = flags[s.team === 0 ? 0 : flags.length - 3];
    // Crewmen and pilots deploy beside a vehicle of their side that still needs a crew.
    const crewFlag = s.ai ? this.ai.crewSpawnFlag(s) : null;
    if (crewFlag) best = crewFlag;
    // A side with no flags left falls back to the rear of its original base.
    let cx = best ? best.x : home.x * 1.12, cz = best ? best.z : home.z * 1.12;
    let x = cx, z = cz;
    for (let tries = 0; tries < 12; tries++) {
      const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 13;
      x = cx + Math.cos(a) * r; z = cz + Math.sin(a) * r;
      if (!this.nav.blocked(x, z)) break;
    }
    const face = objective && objective !== best ? Math.atan2(objective.x - x, objective.z - z) : Math.atan2(-x, -z);
    s.spawn(x, this.map.terrain.height(x, z), z, face);
    if (s.ai) s.ai.reset();
    this.bus.emit('spawn', s);
  }

  /**
   * Puts the human on `team` by swapping places with one of that team's bots
   * (allowed before deploying, or while dead).
   * @returns {boolean} whether the side changed
   */
  setPlayerTeam(team) {
    const old = this.player;
    if (old.team === team || old.alive) return false;
    const members = this.soldiers.filter((s) => s.team === team && !s.isPlayer);
    const bot = members[1] || members[0];
    if (!bot) return false;
    if (bot.vehicle) bot.vehicle.exit(bot);
    bot.alive = false;
    // The bot's brain moves to the old player soldier, the human takes over the bot.
    this.ai.releaseAgent(bot);
    bot.isPlayer = true; bot.name = 'YOU';
    old.isPlayer = false; old.name = `${CONFIG.teams[old.team].name[0]}-${String(old.id).padStart(3, '0')}`;
    const fOld = FACTIONS[CONFIG.teams[old.team].faction], fNew = FACTIONS[CONFIG.teams[team].faction];
    old.setLoadout(loadoutFor(fOld, old.id, false, old.cls));
    bot.setLoadout(loadoutFor(fNew, 0, true, bot.cls));
    this.ai.adoptAgent(old);
    old.respawnTimer = Math.random() * 2;
    bot.respawnTimer = 0;
    this.player = bot;
    this.playerCtl.setSoldier(bot);
    this.bus.emit('player:team', team);
    return true;
  }

  // --- Mode transitions -------------------------------------------------------

  deploy() {
    this.audio.unlock();
    this.input.reset();
    this.input.enabled = true;
    if (!this.player.alive) this.player.respawnTimer = 0;
    this.mode = 'playing';
    this.bus.emit('mode', this.mode);
  }

  pause() {
    if (this.mode !== 'playing') return;
    this.mode = 'paused';
    this.input.enabled = false;
    this.input.reset();
    this.audio.setEngine(0, 60);
    if (document.pointerLockElement) document.exitPointerLock();
    this.bus.emit('mode', this.mode);
  }

  resume() {
    if (this.mode !== 'paused') return;
    this.input.reset();
    this.input.enabled = true;
    this.mode = 'playing';
    this._last = performance.now();
    this.bus.emit('mode', this.mode);
  }

  restart() {
    for (const v of this.vehicles.list) for (let i = 0; i < v.seats.length; i++) if (v.seats[i]) v.exit(/** @type {Soldier} */ (v.seats[i]));
    this.state.restore(this._initial);
    for (const s of this.soldiers) { s.kills = 0; s.deaths = 0; }
    this._muster();
    this.time = 0;
    this.mode = 'paused';
    this.resume();
  }

  /** Restores a quick-save; returns false when there is none or it is incompatible. */
  loadSave() {
    for (const v of this.vehicles.list) for (let i = 0; i < v.seats.length; i++) if (v.seats[i]) v.exit(/** @type {Soldier} */ (v.seats[i]));
    return this.state.load();
  }

  _onMatchOver(winner) {
    this.mode = 'over';
    this.input.enabled = false;
    this.input.reset();
    this.audio.setEngine(0, 60);
    if (document.pointerLockElement) document.exitPointerLock();
    this.bus.emit('mode', this.mode, winner);
  }

  // --- Frame loop ---------------------------------------------------------------

  start() {
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._frame);
  }

  stop() { cancelAnimationFrame(this._raf); }

  /** @param {number} now */
  _frame(now) {
    this._raf = requestAnimationFrame(this._frame);
    const dt = Math.min(CONFIG.maxFrameDt, Math.max(0.0005, (now - this._last) / 1000));
    this._last = now;
    try {
      if (this.mode === 'playing' || this.mode === 'menu') this._simulate(dt);
      else if (this.mode === 'over') this._simulate(dt * 0.25); // slow-motion epilogue
      this.render.render(dt);
    } catch (err) {
      this.stop();
      this.bus.emit('fatal', err);
      throw err;
    }
  }

  /** One simulation frame. Order matters and is the single source of truth for it. */
  _simulate(dt) {
    const playing = this.mode === 'playing';
    this.time += dt;
    const input = this.input, player = this.player;

    // 1) Intent: human input, then bot brains.
    input.update();
    if (playing) {
      if (input.take('pause')) { this.pause(); return; }
      this.playerCtl.update(dt);
    }
    this.ai.update(dt);
    this.nav.update();

    // 2) Fixed-step rigid-body simulation, interpolated for rendering.
    const h = CONFIG.fixedDt;
    this._acc = Math.min(this._acc + dt, h * 4);
    while (this._acc >= h) {
      this.vehicles.fixedUpdate(h);
      this.physics.step();
      this.vehicles.capture();
      this._acc -= h;
    }
    this.vehicles.interpolate(this._acc / h);

    // 3) Kinematic soldiers (seated ones follow their interpolated vehicle).
    const terrain = this.map.terrain;
    for (let i = 0; i < this.soldiers.length; i++) {
      const s = this.soldiers[i];
      if (s.alive) {
        const fall = s.update(dt, this.time, terrain, this.physics);
        if (fall > 0) this.combat.damageSoldier(s, fall, null, 0, -1, 0, false, 'FALL');
        continue;
      }
      if (s.isPlayer && !playing) continue;
      s.respawnTimer -= dt;
      if (s.respawnTimer <= 0 && this.capture.tickets[s.team] > 0 && !this.capture.over) this.spawnSoldier(s);
    }
    this._roadkill();

    // 4) Combat resolution and match rules.
    this.combat.update(dt);
    this.capture.update(dt);
    this.bus.flush();

    // 5) Presentation.
    const cam = this.render.camera;
    if (playing || this.mode === 'over') this.playerCtl.updateCamera(dt);
    else this._menuCamera(dt);
    this.vehicles.update(dt, cam.position);
    this.particles.update(dt);
    this.chunks.update(dt, cam.position);
    this.soldierRenderer.update(dt, cam, this.playerCtl.firstPerson && playing ? player : null);
    this.audio.setListener(cam.position.x, cam.position.y, cam.position.z, player.yaw);
    if (playing) {
      const v = player.vehicle;
      if (v && player.alive) {
        const kind = v.def.kind;
        if (kind === 'heli') this.audio.setEngine(0.5 + v.rotorSpeed * 0.5, 38 + v.rotorSpeed * 30, true);
        else if (kind === 'jet') this.audio.setEngine(0.45 + v.rotorSpeed * 0.55, 70 + v.rotorSpeed * 90 + v.airspeed * 0.6, false);
        else this.audio.setEngine(0.55 + Math.min(0.45, Math.abs(v.speed) / 30), 48 + Math.abs(v.speed) * 5, false);
      } else this.audio.setEngine(0, 60);
      const seatMounts = v ? v.mountList(player.seat) : null;
      const aimable = v ? this.playerCtl.mount >= 0 && v.def.mounts[this.playerCtl.mount].turnRate > 0 : true;
      input.setContext({
        inVehicle: !!v, canEnter: this.playerCtl.nearVehicle !== null, canSwitchSeat: !!v && v.hasFreeSeat(),
        hasWeapon: player.alive && (!v || this.playerCtl.mount >= 0), onFoot: player.alive && !v,
        canAim: player.alive && aimable && (!v || this.playerCtl.mount >= 0),
        canSwap: player.alive && (v ? !!seatMounts && seatMounts.length > 1 : player.weapons.length > 1),
      });
      this.hud.update(dt);
    }
  }

  /** Slow orbit over the central flag while the menu is up (the battle already rages). */
  _menuCamera(dt) {
    this._menuAngle += dt * 0.06;
    const f = this.capture.flags[2], cam = this.render.camera;
    const x = f.x + Math.cos(this._menuAngle) * 95, z = f.z + Math.sin(this._menuAngle) * 95;
    cam.position.set(x, Math.max(f.y, this.map.terrain.height(x, z)) + 38, z);
    cam.lookAt(f.x, f.y + 6, f.z);
    this.render.setFov(this.render.baseFov - 14);
    this.playerCtl.viewRoot.visible = false;
  }

  /** Vehicle-vs-infantry contact: fast hulls run enemies over, otherwise soldiers are pushed clear. */
  _roadkill() {
    const vehicles = this.vehicles.list;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (v.wreckTimer <= 0 && !v.alive) continue; // removed wreck awaiting respawn
      const lethal = v.alive && v.driver !== null && v.def.kind === 'ground' && Math.abs(v.speed) > 5;
      const hx = v.def.half[0] + 0.4, hz = v.def.half[2] + 0.4;
      _qi.copy(v.quat).invert();
      for (let k = 0; k < this.soldiers.length; k++) {
        const s = this.soldiers[k];
        if (!s.alive || s.vehicle) continue;
        _v.set(s.pos.x - v.pos.x, s.pos.y + 0.9 - v.pos.y, s.pos.z - v.pos.z);
        if (_v.lengthSq() > 64) continue;
        _v.applyQuaternion(_qi);
        const ox = hx - Math.abs(_v.x), oz = hz - Math.abs(_v.z);
        if (ox <= 0 || oz <= 0 || Math.abs(_v.y) > 2) continue;
        if (lethal && s.team !== v.team) {
          const f = v.body.linvel();
          this.combat.kill(s, v.driver, f.x * 0.25, 1.5, f.z * 0.25, v.def.label);
          continue;
        }
        // Push out through the nearest face of the hull's footprint.
        if (ox < oz) _v.set(Math.sign(_v.x || 1) * ox, 0, 0); else _v.set(0, 0, Math.sign(_v.z || 1) * oz);
        _v.applyQuaternion(v.quat);
        s.pos.x += _v.x; s.pos.z += _v.z;
      }
    }
  }
}
