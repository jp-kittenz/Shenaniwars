import { AgentStateBuffers } from './agent-state.ts';
import { TheaterCommander } from './commander.ts';
import { PerceptionAndUtilityEngine } from './perception-utility.ts';
import { TacticalRadioBus } from './radio-bus.ts';
import { SmokeField } from './smoke.ts';
import { SpatialGrid } from './spatial-grid.ts';
import { SquadAndConvoyManager, SquadKind } from './squad-convoy.ts';
import { CoverField, FoliageField } from './terrain-analysis.ts';
import { FloorRoutes } from './floors.ts';
import { TASK_NAMES, VMODE_NAMES, VehicleOrchestrator } from './vehicle-orchestrator.ts';
import { ACTION_NAMES, AILod, AI_TUNING, CLASS_NAMES, MsgState, ORDER_NAMES, SoldierClass, clamp } from './types.ts';
import type { AgentLike, FlagLike, GameLike, PropLike, SoldierLike, VehicleLike } from './types.ts';

/** Slices of the fixed 60 Hz AI clock: observer o perceives when frame % 12 == o % 12 (5 Hz) … */
const PERCEPTION_SLICES = AI_TUNING.clockHz / AI_TUNING.perceptionHz; // 12
/** … and thinks tactically when frame % 15 == o % 15 (4 Hz). */
const TACTICAL_SLICES = AI_TUNING.clockHz / AI_TUNING.tacticalHz; // 15
/** At most this many AI clock steps per rendered frame (spiral-of-death guard). */
const MAX_STEPS = 4;
const GRID_CELL = 32;

export interface DirectorOptions { seed: number; waterLevel: number }

/**
 * Composition root and scheduler of the AI:
 *  - rebuilds the flat spatial grid each frame (counting sort, no allocation);
 *  - runs a fixed 60 Hz AI clock; perception and tactics are id-modulo slices
 *    of it (5 Hz / 4 Hz), scaled down by distance LOD (½ rate at REDUCED,
 *    1 Hz at ABSTRACT);
 *  - spends a fixed line-of-sight raycast budget per frame from the global
 *    priority queue;
 *  - ticks squads / convoys and the vehicle orchestrator round-robin;
 *  - routes game events (noise, damage, suppression, deaths, spawns,
 *    vehicle events, missile launches) to the right module;
 *  - runs every bot's actuator each frame.
 */
/**
 * Cover sources for the AI: the map's props plus every building's exterior
 * walls, cut into ≤ 8 m stand-in wall segments (low cover: soldiers inside
 * fight from the windows, soldiers outside use the corners and facades).
 */
function coverProps(game: GameLike): PropLike[] {
  const props = game.map.props.slice();
  const buildings = (game.map as any).buildings || [];
  for (const b of buildings) {
    if (b.type === 'custom' || b.type === 'bridge' || b.roof === 'open') continue;
    const c = Math.cos(b.rot), sn = Math.sin(b.rot);
    // Four sides: centre (local), half length, wall rotation (local x axis along the wall).
    const sides: [number, number, number, number][] = [[0, b.d / 2, b.w / 2, 0], [0, -b.d / 2, b.w / 2, 0], [b.w / 2, 0, b.d / 2, Math.PI / 2], [-b.w / 2, 0, b.d / 2, Math.PI / 2]];
    for (const [lx, lz, half, r] of sides) {
      const n = Math.max(1, Math.ceil((half * 2) / 8));
      for (let k = 0; k < n; k++) {
        const t = -half + (k + 0.5) * (half * 2 / n);
        const px = lx + (r ? 0 : t), pz = lz + (r ? t : 0);
        const x = b.x + px * c + pz * sn, z = b.z - px * sn + pz * c;
        props.push({ id: props.length, type: 'wall', x, y: b.y, z, rot: b.rot + r, hx: half / n, hy: 0.6, hz: 0.15, r: 0, scale: 1, alive: true });
      }
    }
  }
  return props;
}

export class AIDirector {
  readonly st: AgentStateBuffers;
  readonly grid: SpatialGrid;
  readonly cover: CoverField;
  readonly floors: FloorRoutes;
  readonly foliage: FoliageField;
  readonly smoke: SmokeField;
  readonly radio: TacticalRadioBus;
  readonly squads: SquadAndConvoyManager;
  readonly engine: PerceptionAndUtilityEngine;
  readonly orchestrator: VehicleOrchestrator;
  /** One theater commander per side (strategy, operations, force allocation). */
  readonly commanders: TheaterCommander[];
  private commanderTimer = 0;
  private siegeTimer = 0;
  private commanderTurn = 0;
  /** Actuator per soldier id (null for the human). */
  readonly agents: (AgentLike | null)[];
  readonly stats = { ms: 0, perceptionHz: 0, tacticalHz: 0, raysHz: 0, losQueue: 0, tickets: 0, radioOpen: 0, convoys: 0 };
  private readonly game: GameLike;
  private readonly makeAgent: (s: SoldierLike) => AgentLike;
  private readonly S: number;
  private readonly V: number;
  private frame = 0;
  private acc = 0;
  private statT = 0;
  private statP = 0; private statT2 = 0; private statR = 0;
  private msAvg = 0;

  constructor(game: GameLike, makeAgent: (s: SoldierLike) => AgentLike, opts: DirectorOptions) {
    this.game = game;
    this.makeAgent = makeAgent;
    const S = (this.S = game.soldiers.length), V = (this.V = game.vehicles.list.length);
    const terrain = game.map.terrain;
    this.st = new AgentStateBuffers(S, opts.seed);
    this.grid = new SpatialGrid(terrain.size, GRID_CELL, S + V);
    // Upper floors: stair routes and posts on the upper level of buildings (read by the agents' movement).
    this.floors = new FloorRoutes(game, (game.map as any).buildings || []);
    (game as any).floors = this.floors;
    this.cover = new CoverField(coverProps(game), terrain, (x, z) => game.nav.blocked(x, z), opts.waterLevel, (game.map as any).buildings || [], this.floors);
    this.foliage = new FoliageField(game.map.props, terrain.size);
    this.smoke = new SmokeField();
    this.radio = new TacticalRadioBus(64, S);
    this.squads = new SquadAndConvoyManager(game, this.st, this.radio, this.cover, this.foliage);
    this.engine = new PerceptionAndUtilityEngine(game, this.st, this.grid, this.cover, this.foliage, this.smoke, this.radio);
    this.orchestrator = new VehicleOrchestrator(game, this.st, this.radio, this.squads, this.engine, this.smoke, this.cover, this.foliage, this.grid);
    this.agents = [];
    for (let i = 0; i < S; i++) {
      const s = game.soldiers[i];
      const a = s.isPlayer ? null : makeAgent(s);
      s.ai = a;
      this.agents.push(a);
      this.st.resetSoldier(i, 0);
    }
    this.commanders = [0, 1].map((team) =>
      new TheaterCommander(game, team, this.st, this.squads, this.orchestrator, this.radio, this.cover, this.foliage, this.smoke));
    for (const c of this.commanders) c.emit = (team, text) => game.bus.emit('ai:op', team, text);
    this.orchestrator.tasking[0] = this.commanders[0];
    this.orchestrator.tasking[1] = this.commanders[1];
    this.engine.agents = this.agents;
    this.engine.hooks = this.orchestrator;
    this.squads.hooks = this.orchestrator;
    this.orchestrator.agents = this.agents;
    this.rebuildGrid();

    // --- Event routing (registered once) ------------------------------------------
    const bus = game.bus;
    bus.on('noise', (x: number, z: number, r: number, team: number, shooterId: number) =>
      this.engine.onNoise(x, z, r, team, shooterId === undefined ? -1 : shooterId));
    bus.on('kill', (attacker: SoldierLike | null, victim: SoldierLike) => {
      this.engine.onDeath(victim.id);
      this.orchestrator.onSoldierDeath(victim);
      this.commanders[0].onKill(victim, attacker); this.commanders[1].onKill(victim, attacker);
    });
    bus.on('spawn', (s: SoldierLike) => { if (!s.isPlayer) this.engine.onSpawn(s.id); });
    bus.on('vehicle:destroyed', (v: VehicleLike) => this.orchestrator.onVehicleDestroyed(v));
    bus.on('vehicle:enter', (v: VehicleLike, s: SoldierLike, seat: number) => this.orchestrator.onEnter(v, s, seat));
    bus.on('missile:launch', (target: SoldierLike | VehicleLike) => {
      if (target && target.kind === 'vehicle') this.orchestrator.onMissileLaunch(target);
    });
  }

  // ================================================================= direct event entry points (combat.js)

  onDamaged(victim: SoldierLike, attacker: SoldierLike | null): void { this.engine.onDamaged(victim.id, attacker); }

  /** Near misses and nearby blasts. */
  onSuppress(id: number, amount: number, fromX: number, fromZ: number): void {
    if (this.agents[id]) this.engine.onSuppress(id, amount, fromX, fromZ);
  }

  // ================================================================= agents (player swap)

  releaseAgent(s: SoldierLike): void {
    this.orchestrator.onSoldierDeath(s);
    this.agents[s.id] = null;
    s.ai = null;
  }

  adoptAgent(s: SoldierLike): AgentLike {
    const a = this.makeAgent(s);
    this.agents[s.id] = a;
    s.ai = a;
    this.st.resetSoldier(s.id, this.game.time);
    this.engine.onSpawn(s.id);
    return a;
  }

  /**
   * Spawn point for vehicle crews: the owned flag nearest to a vehicle of
   * their side that still lacks a driver (pilots: aircraft only).
   */
  crewSpawnFlag(s: SoldierLike): FlagLike | null {
    if (s.cls !== SoldierClass.CREWMAN && s.cls !== SoldierClass.PILOT) return null;
    const list = this.game.vehicles.list, flags = this.game.capture.flags;
    let best: FlagLike | null = null, bd = 1e12;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.alive || v.def.static || v.spawn.team !== s.team || v.seats[0] || v.isAircraft !== (s.cls === SoldierClass.PILOT) || v.health < v.def.health * 0.4) continue;
      if (this.orchestrator.manifests[i].ticket[0] >= 0) continue;
      for (let k = 0; k < flags.length; k++) {
        const f = flags[k];
        if (f.owner !== s.team) continue;
        const d = (f.x - v.pos.x) ** 2 + (f.z - v.pos.z) ** 2;
        if (d < bd) { bd = d; best = f; }
      }
    }
    return best;
  }

  reset(): void {
    for (const c of this.commanders) c.reset();
    this.engine.reset();
    this.squads.reset();
    this.orchestrator.reset();
    this.radio.reset();
    this.smoke.reset();
    const time = this.game.time;
    for (let i = 0; i < this.S; i++) {
      this.st.resetSoldier(i, time);
      this.st.ticket[i] = -1;
      const a = this.agents[i];
      if (a) a.reset();
    }
  }

  // ================================================================= frame

  private rebuildGrid(): void {
    const g = this.game, grid = this.grid;
    grid.begin();
    for (let i = 0; i < this.S; i++) {
      const s = g.soldiers[i];
      if (s.alive) grid.insert(i, s.pos.x, s.pos.z);
    }
    for (let i = 0; i < this.V; i++) {
      const v = g.vehicles.list[i];
      if (v.alive) grid.insert(this.S + i, v.pos.x, v.pos.z);
    }
    grid.finish();
  }

  /** Distance LOD from the camera (crews included). */
  private updateLod(o: number): void {
    const s = this.game.soldiers[o], cam = this.game.render.camera.position;
    const d = Math.hypot(s.pos.x - cam.x, s.pos.z - cam.z);
    this.st.lod[o] = d < AI_TUNING.lodFull || s.vehicle ? AILod.FULL : d < AI_TUNING.lodReduced ? AILod.REDUCED : AILod.ABSTRACT;
  }

  /** Should observer o run on this slice cycle given its LOD? */
  private lodGate(o: number, cycle: number): boolean {
    const lod = this.st.lod[o];
    if (lod === AILod.FULL) return true;
    if (lod === AILod.REDUCED) return ((cycle + o) & 1) === 0;
    return (cycle + o) % 5 === 0;
  }

  /**
   * Endgame: while a side's base is exposed, attackers with explosives (AT
   * gunners, tank / IFV / helicopter gunners) that see one of its standing HQ
   * buildings and have nothing better to shoot get that wall as a target.
   */
  private siegeTargets(time: number): void {
    const g = this.game as any, cap = g.capture, map = g.map;
    if (!cap.phase || !map.bases) return;
    for (let def = 0; def < 2; def++) {
      if (cap.phase[def] !== 'siege') continue;
      const atk = 1 - def;
      const hqs: any[] = [];
      for (const id of map.bases[def].hq) if (map.buildings[id].state < 2) hqs.push(map.buildings[id]);
      if (!hqs.length) continue;
      for (let i = 0; i < this.S; i++) {
        const s = g.soldiers[i], a = this.agents[i];
        if (!a || !s.alive || s.team !== atk) continue;
        const v = s.vehicle;
        if (!v && !(s.launcher && s.launcher.ammo + s.launcher.reserve > 0)) continue;
        if (v && (v.def.kind === 'jet' || !v.def.mounts.some((m: any) => m.seat === s.seat))) continue;
        const range = v ? 650 : 260;
        const ex = s.pos.x, ez = s.pos.z, ey = v ? v.pos.y + 2.5 : s.pos.y + 1.5;
        let best: any = null, bd = range * range, bx = 0, by = 0, bz = 0;
        for (const b of hqs) {
          // Closest point of the HQ's footprint, two metres up its wall.
          const c = Math.cos(b.rot), sn = Math.sin(b.rot), dx = ex - b.x, dz = ez - b.z;
          const lx = clamp(dx * c - dz * sn, -b.w / 2, b.w / 2), lz = clamp(dx * sn + dz * c, -b.d / 2, b.d / 2);
          const px = b.x + lx * c + lz * sn, pz = b.z - lx * sn + lz * c;
          const d2 = (px - ex) ** 2 + (pz - ez) ** 2;
          if (d2 >= bd) continue;
          bd = d2; best = b; bx = px; bz = pz; by = b.y + Math.min(3, b.floors * b.fh * 0.5);
        }
        if (!best) continue;
        const d = Math.sqrt(bd) || 1;
        // Line of sight to the wall (stop just short of it).
        const k = Math.max(0, (d - 1.2) / d);
        if (!g.physics.losClear(ex, ey, ez, ex + (bx - ex) * k, ey + (by - ey) * k, ez + (bz - ez) * k)) continue;
        a.siegeX = bx; a.siegeY = by; a.siegeZ = bz; a.siegeUntil = time + 1.5;
      }
    }
  }

  update(dt: number): void {
    const t0 = performance.now();
    const g = this.game, time = g.time, S = this.S;
    this.rebuildGrid();
    this.radio.update(time);
    this.smoke.update(dt, time, g);

    // Fixed AI clock: perception and tactics as id-modulo slices.
    this.acc = Math.min(this.acc + dt * AI_TUNING.clockHz, MAX_STEPS);
    while (this.acc >= 1) {
      this.acc -= 1;
      const f = ++this.frame;
      const pSlice = f % PERCEPTION_SLICES, pCycle = (f / PERCEPTION_SLICES) | 0;
      for (let o = pSlice; o < S; o += PERCEPTION_SLICES) {
        if (!this.agents[o] || !g.soldiers[o].alive) continue;
        this.updateLod(o);
        if (this.lodGate(o, pCycle)) this.engine.perceive(o);
      }
      const tSlice = f % TACTICAL_SLICES, tCycle = (f / TACTICAL_SLICES) | 0;
      for (let o = tSlice; o < S; o += TACTICAL_SLICES) {
        if (!this.agents[o] || !g.soldiers[o].alive) continue;
        if (this.lodGate(o, tCycle)) this.engine.tactical(o);
      }
    }
    // Global line-of-sight budget for this rendered frame.
    this.engine.processLos(AI_TUNING.raysPerFrame);

    // Strategy: each commander thinks once a second, the two sides half a second apart.
    this.commanderTimer -= dt;
    if (this.commanderTimer <= 0) {
      this.commanderTimer = 0.5;
      this.commanders[this.commanderTurn].think(time);
      this.commanderTurn = 1 - this.commanderTurn;
    }
    this.squads.update(dt, this.agents);
    this.orchestrator.update(dt);
    this.siegeTimer -= dt;
    if (this.siegeTimer <= 0) { this.siegeTimer = 0.5; this.siegeTargets(time); }

    // Actuators: intent → motion / aim / fire / vehicle controls.
    for (let o = 0; o < S; o++) {
      const a = this.agents[o];
      if (!a) continue;
      const s = g.soldiers[o];
      if (!s.alive) continue;
      if (s.vehicle) {
        a.state = s.seat === 0 ? VMODE_NAMES[this.orchestrator.manifests[s.vehicle.id].mode] : 'crew';
      } else a.state = ACTION_NAMES[this.st.action[o]];
      a.update(dt);
    }

    const ms = performance.now() - t0;
    this.msAvg = this.msAvg * 0.95 + ms * 0.05;
    this.statT += dt;
    if (this.statT >= 1) {
      const es = this.engine.stats;
      this.stats.ms = this.msAvg;
      this.stats.perceptionHz = (es.perceptions - this.statP) / this.statT;
      this.stats.tacticalHz = (es.tactical - this.statT2) / this.statT;
      this.stats.raysHz = (es.rays - this.statR) / this.statT;
      this.statP = es.perceptions; this.statT2 = es.tactical; this.statR = es.rays;
      this.stats.losQueue = es.raysQueued;
      this.stats.tickets = this.orchestrator.activeTickets();
      let open = 0;
      for (let i = 0; i < this.radio.messages.length; i++) {
        const st = this.radio.messages[i].state;
        if (st === MsgState.OPEN || st === MsgState.CLAIMED) open++;
      }
      this.stats.radioOpen = open;
      let c = 0;
      for (let i = 0; i < this.squads.convoys.length; i++) if (this.squads.convoys[i].active) c++;
      this.stats.convoys = c;
      this.statT = 0;
    }
  }

  /**
   * What the AI knows and is doing about one soldier, read from the data its decisions use
   * (assignment and why, action, target, movement goal and navigation status, recent failures).
   */
  explainSoldier(s: SoldierLike): string {
    const g = this.game, a = s.ai as any, q = s.squad as any;
    if (!s.alive) return `${s.name}: dead`;
    const L: string[] = [`${s.name} ${CLASS_NAMES[s.cls]} ${s.team ? 'TORSA' : 'PAMPALONA'}`];
    if (q) {
      L.push(` squad ${q.id} (${q.alive} alive): order ${ORDER_NAMES[q.order]}, posture ${['assault', 'defend', 'bound', 'flank', 'regroup', 'mounted', 'hold'][q.posture]}`);
      if (q.objective) {
        const f = q.objective, d = Math.hypot(f.x - q.cx, f.z - q.cz);
        L.push(` objective ${f.name} (${f.owner === q.team ? 'ours' : f.owner < 0 ? 'neutral' : 'enemy'}), ${d < 25 ? 'arrived' : `${d.toFixed(0)} m away`}, for ${(g.time - q.objSince).toFixed(0)} s${q.assignWhy ? ` — ${q.assignWhy}` : ''}`);
      }
      L.push(` why: ${this.commanders[s.team].squadWhy(q)}`);
      // The squad as a group: what it is doing, its leader, how together it is.
      const ld = q.leader >= 0 ? g.soldiers[q.leader] : null;
      let far = 0, maxD = 0, foot = 0;
      for (let i = 0; i < q.count; i++) {
        const m = g.soldiers[q.members[i]];
        if (!m.alive || m.vehicle) continue;
        foot++;
        const d = ld && ld.alive && !ld.vehicle ? Math.hypot(m.pos.x - ld.pos.x, m.pos.z - ld.pos.z) : Math.hypot(m.pos.x - q.cx, m.pos.z - q.cz);
        if (d > maxD) maxD = d; if (d > 45) far++;
      }
      L.push(` squad state: ${q.intent} for ${(g.time - q.intentT).toFixed(0)} s; ${q.opId >= 0 ? `operation ${q.opId}` : 'no operation'}; leader ${ld ? (ld === s ? 'this soldier' : ld.alive ? ld.name : 'dead') : 'none'}; ${foot} on foot, furthest ${maxD.toFixed(0)} m from the leader${far ? `, ${far} straggling` : ''}`);
      if (q.changes.length) L.push(` recent objective changes: ${q.changes.slice(-3).join('; ')}`);
      if (q.navFails) L.push(` squad route failures: ${q.navFails} (last ${(g.time - q.navFailT).toFixed(0)} s ago)`);
      if (q.transportState !== 'none') L.push(` transport: ${q.transport >= 0 ? g.vehicles.list[q.transport].def.label + ' ' : ''}${q.transportState} (${q.transportWhy}, ${(g.time - q.transportT).toFixed(0)} s ago)`);
      if (q.extractState !== 'none') L.push(` extraction: ${q.extractState} (${(g.time - q.extractT).toFixed(0)} s ago)`);
      if (q.waitSince > 0) L.push(` squad leader waiting for stragglers (${(g.time - q.waitSince).toFixed(0)} s)`);
      for (let k = 0; k < 3; k++) {
        const r = q.req[k];
        if (r.state !== 'none') L.push(` ${['fire mission', 'air support', 'resupply'][k]}: ${r.state}${r.why ? ` — ${r.why}` : ''} (${(g.time - r.t).toFixed(0)} s ago)`);
      }
    } else L.push(' no squad');
    if (s.vehicle) { L.push(` in ${s.vehicle.def.label}, seat ${s.vehicle.def.seats[s.seat].role}`); return L.join('\n'); }
    if (!a) return L.join('\n');
    const t = a.target;
    const KNOW = ['nothing', 'suspected (heard)', 'reported by a comrade', 'own last sighting', 'in sight'];
    L.push(` action ${ACTION_NAMES[this.st.action[s.id]]}, fire ${['hold', 'aimed', 'suppressive'][a.fireMode]}; ${t ? `target ${t.kind === 'vehicle' ? t.def.label : t.name} ~${Math.hypot(a.lastSeenX - s.pos.x, a.lastSeenZ - s.pos.z).toFixed(0)} m: ${KNOW[a.know]}, ${(g.time - a.lastSeenTime).toFixed(1)} s old` : 'no target'}`);
    if (g.time < a.noLineUntil) L.push(` no line of fire from here (blocked bursts): moving for ${(a.noLineUntil - g.time).toFixed(0)} s more`);
    // Where it stands and why: its post in the squad's position plan (window / cover / open), or the order's area.
    if (q && q.planMode >= 0) {
      let k = -1; for (let i = 0; i < q.count; i++) if (q.members[i] === s.id) k = i;
      if (k >= 0 && k < q.plan.count) {
        const n = q.plan.node[k], kind = n < 0 ? 'open ground' : this.cover.inside[n] ? 'inside a building, at a window' : this.cover.bld[n] >= 0 ? 'at a building corner' : 'behind cover';
        const dP = Math.hypot(q.plan.x[k] - s.pos.x, q.plan.z[k] - s.pos.z);
        L.push(` post: ${['holding area', 'support-by-fire', 'flag defence'][q.planMode]} position ${dP < 2 ? 'taken' : `${dP.toFixed(0)} m away`} (${kind}); plan ${(g.time - q.planTime).toFixed(0)} s old`);
      }
    }
    if (t && a.targetVisible && q && q.order !== 0) {
      const dT = Math.hypot(a.lastSeenX - q.destX, a.lastSeenZ - q.destZ);
      if (dT > 90) L.push(` enemy in sight ${dT.toFixed(0)} m outside the squad's task area: fighting from here, not chasing (order ${ORDER_NAMES[q.order]})`);
    }
    if (a.dodgeUntil > g.time) L.push(' stepping out of a friendly vehicle\'s way');
    if (a.hasGoal) {
      const d = Math.hypot(a.goalX - s.pos.x, a.goalZ - s.pos.z);
      L.push(` moving to ${a.goalX.toFixed(0)},${a.goalZ.toFixed(0)} (${d.toFixed(0)} m): ${a.navStatus}; path ${a.nav.pending ? 'searching' : a.nav.failed ? 'none found' : `${a.nav.idx}/${a.nav.len}${a.nav.partial ? ' partial' : ''}`}; best ${a.progBest < 1e8 ? a.progBest.toFixed(0) : '-'} m ${(g.time - a.progT).toFixed(0)} s ago`);
    } else L.push(' holding position (no movement goal)');
    if (g.time - a.giveUpT < 30) L.push(` gave up on ${a.giveUpX.toFixed(0)},${a.giveUpZ.toFixed(0)} ${(g.time - a.giveUpT).toFixed(0)} s ago (unreachable from here)`);
    const tk = this.st.ticket[s.id];
    if (tk >= 0) { const v = this.orchestrator.ticketVehicle(s.id); if (v) L.push(` seat reserved in ${v.def.label}`); }
    return L.join('\n');
  }

  /** Role, assignment, crew, trip and the reason it is moving / stopped / unused, for one vehicle. */
  explainVehicle(v: VehicleLike): string {
    const m = this.orchestrator.manifests[v.id], a = v.driver && v.driver.ai ? v.driver.ai : null;
    const L: string[] = [`${v.def.label} ${v.team ? 'TORSA' : 'PAMPALONA'} ${v.alive ? `${Math.round((100 * v.health) / v.def.health)}%` : 'destroyed'}`];
    if (!v.alive) return L[0];
    let crew = 0, pax = 0;
    for (let i = 0; i < v.seats.length; i++) if (v.seats[i]) { if (m.seatRole[i] >= 4) pax++; else crew++; }
    L.push(` crew ${crew}, passengers/riders ${pax}; mode ${VMODE_NAMES[m.mode]}`);
    if (!v.seats[0]) { L.push(` unused: ${this.orchestrator.unusedReason(v)}`); return L.join('\n'); }
    if (m.supports >= 0 || m.supportState !== 'none') L.push(` squad link: ${m.supports >= 0 ? `squad ${m.supports} ` : ''}${m.supportState} (${m.supportWhy}, ${(this.game.time - m.supportT).toFixed(0)} s ago)`);
    const role = this.commanders[v.team].vehicleRole(v.id);
    L.push(` task: ${role || (m.objective ? `own tasking toward ${m.objective.name}` : 'none')}`);
    L.push(` assignment: ${TASK_NAMES[m.taskKind]} for ${(this.game.time - m.taskT).toFixed(0)} s — ${m.taskWhy || '—'}`);
    if (m.servicing) L.push(' going for repairs (below half health)');
    if (m.squadId >= 0) {
      const q = this.squads.squads[m.squadId];
      L.push(` carrying squad ${q.id} to ${m.destX.toFixed(0)},${m.destZ.toFixed(0)} (drop ${Math.hypot(m.dismountX - v.pos.x, m.dismountZ - v.pos.z).toFixed(0)} m away)`);
    }
    if (m.lastTrip) L.push(` last trip: ${m.lastTrip}`);
    if (m.fireWhy) L.push(` fires: ${m.fireWhy}`);
    if (m.msg && m.msg.status) L.push(` request in hand: ${m.msg.status}`);
    const sl = this.orchestrator.park.slotOf(v);
    if (sl) L.push(` parking slot ${sl.row ? 'back row' : 'front row'} ${sl.occ === v.id ? '(parked in it)' : '(reserved)'}`);
    if (a) {
      const d = Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z);
      const conv = this.squads.convoyOf[v.id];
      const why = a.holdVehicle ? (m.mode === 1 ? 'waiting for passengers to board' : m.supportState === 'standby' ? 'parked on standby for its squad' : m.mode === 0 ? 'parked, no mission' : m.mode === 7 ? 'firing a mission' : 'holding its assigned position') : a.speedCap < 0.5 ? 'waiting for its convoy' : a.stuckRepeat >= 3 ? 'stuck here repeatedly (treated as arrived)' : (a as any).detourUntil > this.game.time ? 'detouring around an obstacle' : Math.abs(v.speed) < 1 && d > 15 ? 'stopped (path search / obstacle)' : 'driving';
      L.push(` ${why}; destination ${d.toFixed(0)} m; stuck events ${a.stuckTotal.toFixed(0)}`);
      if (conv >= 0) {
        const c = this.squads.convoys[conv];
        let idx = 0; for (let i = 0; i < c.count; i++) if (c.vehicles[i] === v.id) idx = i;
        L.push(` convoy ${c.id}: ${idx === 0 ? 'leading' : `${idx + 1}. of ${c.count}`}, ${c.state === 'assembling' ? 'forming up' : 'on the move'} — ${c.purpose} → ${c.destName}`);
      }
    }
    let seen = '';
    for (let i = 0; i < v.seats.length; i++) { const o = v.seats[i]; if (o && o.ai && o.ai.target && o.ai.targetVisible) { const t = o.ai.target; seen = `${t.kind === 'vehicle' ? t.def.label : 'infantry'} at ${Math.hypot(t.pos.x - v.pos.x, t.pos.z - v.pos.z).toFixed(0)} m`; break; } }
    L.push(` engaging: ${seen || 'nothing in sight'}`);
    return L.join('\n');
  }

  /** Explanation for whatever is nearest the camera's line of sight within 120 m (debug overlay). */
  explainAt(px: number, py: number, pz: number, dx: number, dy: number, dz: number): string {
    const g = this.game;
    let best: any = null, bs = 0.06;
    const consider = (e: any, x: number, y: number, z: number) => {
      const ex = x - px, ey = y - py, ez = z - pz, d = Math.hypot(ex, ey, ez);
      if (d < 2 || d > 120) return;
      const off = 1 - (ex * dx + ey * dy + ez * dz) / d;
      if (off < bs) { bs = off; best = e; }
    };
    for (const s of g.soldiers) if (s.alive && !s.isPlayer && !s.vehicle) consider(s, s.pos.x, s.pos.y + 1.2, s.pos.z);
    for (const v of g.vehicles.list) if (v.alive && !v.def.static) consider(v, v.pos.x, v.pos.y, v.pos.z);
    if (!best) return '';
    return best.kind === 'vehicle' ? this.explainVehicle(best) : this.explainSoldier(best);
  }

  /** Commander and orchestrator counters for tools/ai-eval.mjs. */
  evalStats(): object {
    const c = this.commanders.map((k) => ({ ...k.stats, byPurpose: k.stats.byPurpose.slice(), priorities: k.priorities.slice(), decision: k.lastDecision }));
    return { commanders: c, orchestrator: { ...this.orchestrator.stats }, convoys: { ...this.squads.stats }, blockedAt: this.orchestrator.blockedAt.slice() };
  }

  /** Summary for the debug overlay. */
  statsLine(): string {
    const s = this.stats;
    let inf = 0, crew = 0;
    for (let i = 0; i < this.squads.squads.length; i++) if (this.squads.squads[i].kind === SquadKind.INFANTRY) inf++; else crew++;
    return `ai ${s.ms.toFixed(2)}ms  perc ${s.perceptionHz | 0}/s  tac ${s.tacticalHz | 0}/s  los ${s.raysHz | 0}/s\n` +
      `squads ${inf}+${crew}  convoys ${s.convoys}  seats ${s.tickets}  radio ${s.radioOpen}\n` +
      `${this.commanders[0].debugText()}\n${this.commanders[1].debugText()}`;
  }
}
