import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../core/config.js';
import { Deliberation, Domain } from '../ai/deliberation.ts';
import {
  Role, Cap, can, Build, BUILD_NAMES, BUILD_WORK, BUILD_STAGES, BUILD_CREW, TRENCH_STAGE_NAMES, SF_TEAMS,
  SQUAD_CLASS_NAMES, SQUAD_CLASS_TAGS, classifySquad, ALPINE_ELEVATION,
} from '../ai/roles.ts';
import {
  moraleBand, moraleRate, panicDuration, PANIC_RECOVER, PANIC_IMMUNE, POW_MORALE_CAPTOR, POW_MORALE_LOSER, MORALE_NAMES,
  surrenderAnswers, dragAnswers, feintAnswers, flagBaitAnswers, etaTo, rearguardScores, REARGUARD_NAMES, Rearguard,
  cqbFactor, scorchedAnswers,
} from '../ai/emergent.ts';
import { Order, Posture } from '../ai/types.ts';

const SquadKindInfantry = 0;
import { WeaponState, ballisticPitch } from '../entities/weapons.js';
import { SiteTier } from '../ai/logistics.ts';

/**
 * Field operations (Milestone 3, stages 2–4): what infantry does beyond shooting, all of it decided through the
 * Q1–Q6 deliberation gate (src/ai/deliberation.ts) from live observations, predictions and geometry — no
 * behaviour scripts. This runtime keeps the state those decisions act on and executes them:
 *
 *  - Engineering triad: sappers lay logged AT / AP minefields on predicted enemy approach corridors (friendly
 *    routes pay to avoid them), raise small MG emplacements and hasty sandbag cover, patch wheels; combat-engineer
 *    groups build three-stage modular trenches, forward barracks (a reinforcement spawn point) and checkpoints
 *    (guard booth, barrier, HMG post and a scaled two-bay supply zone); combat mechanics do full vehicle repairs
 *    (gated in the soldier brain, src/ai/perception-utility.ts).
 *  - Mortar teams: gunner and ammunition bearer emplace and fire on observed enemy clusters, masked off friendly
 *    trenches, crates and occupied buildings.
 *  - Special forces: each faction's two named teams stand by at the HQ and deploy only on a special operation
 *    worth ≥ 65 % (high-value asset strike, deep raid, POW rescue).
 *  - Squad classification: event-driven (roster change, boarding / leaving a vehicle, airborne staging,
 *    elevation band) into nine classes.
 *  - Squad-anchored morale with bounded panic, downed casualties, buddy-drag to cover, emergent surrender, POW
 *    escort and delivery with a field-intel harvest.
 *  - Baiting (peek & feint, flag ambush), post-capture rearguards, CQB stacking, scorched-earth withdrawals and
 *    fortification masks.
 */

const MAX_MINES = 200;
const PERIOD_SQUAD = 1.0;
const _v = new THREE.Vector3(), _o = new THREE.Vector3(), _d = new THREE.Vector3();
const SCORES = new Float32Array(6);

function colored(g, hex) {
  const n = g.attributes.position.count, col = new Float32Array(n * 3), c = new THREE.Color(hex);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}
const box = (w, h, d, x, y, z, hex, ry = 0) => colored(new THREE.BoxGeometry(w, h, d).rotateY(ry).translate(x, y, z), hex);
const cylY = (r, h, x, y, z, hex) => colored(new THREE.CylinderGeometry(r, r, h, 8).translate(x, y, z), hex);

export class FieldOps {
  constructor(game) {
    this.game = game;
    const S = game.soldiers.length;
    this.D = new Deliberation(Domain.SQUAD);
    this.Ds = new Deliberation(Domain.SOLDIER);
    this.A5 = new Float32Array(5); this.A2 = new Float32Array(2);
    // Per soldier.
    this.job = new Int16Array(S).fill(-1);
    this.dragOf = new Int16Array(S).fill(-1);
    this.dragBy = new Int16Array(S).fill(-1);
    this.escortOf = new Int16Array(S).fill(-1);
    this.escortBy = new Int16Array(S).fill(-1);
    this.panicUntil = new Float32Array(S);
    this.immuneUntil = new Float32Array(S);
    this.downT = new Float32Array(S);
    this.powT = new Float32Array(S);
    this.capX = new Float32Array(S); this.capZ = new Float32Array(S); this.capTeam = new Int8Array(S).fill(-1);
    /** @type {Map<number, {ws: WeaponState, set: number, t: number}>} mortar gunners */
    this.mortars = new Map();
    // Per squad (lazily sized).
    this.morale = new Float32Array(256).fill(0.85);
    this.lossT = Array.from({ length: 256 }, () => []);
    this.sqClass = new Int8Array(256).fill(-1);
    this.sqKey = new Int32Array(256).fill(-1);
    this.sqT = new Float32Array(256);
    this.cqb = new Float32Array(256);
    this.bait = Array.from({ length: 256 }, () => null);
    this.rear = new Int8Array(256).fill(-1);
    this.rearUntil = new Float32Array(256);
    this.prevOwner = new Int8Array(64).fill(-2);
    // Build sites.
    /** @type {any[]} */
    this.sites = [];
    // Mines (typed arrays).
    this.mx = new Float32Array(MAX_MINES); this.mz = new Float32Array(MAX_MINES); this.mteam = new Int8Array(MAX_MINES).fill(-1);
    this.mtype = new Uint8Array(MAX_MINES); this.mknown = new Uint8Array(MAX_MINES); this.mineN = 0;
    // Recent heavy blasts (artillery pressure on morale).
    this.blastX = new Float32Array(32); this.blastZ = new Float32Array(32); this.blastT = new Float32Array(32).fill(-1e9); this.blastK = 0;
    this.pows = [];
    this.stats = {
      moraleBands: [0, 0, 0], panics: 0, panicRecovered: 0, downed: 0, revived: 0, bledOut: 0, drags: 0, dragsDone: 0, dragDeclined: 0,
      surrenders: 0, surrenderDeclined: 0, powDelivered: 0, intelHarvests: 0, intelRevealed: 0, powMorale: 0,
      builds: {}, buildsDone: {}, minesLaid: 0, mineHits: 0, mgNests: 0, checkpoints: 0, barracks: 0, trenchStages: 0, barracksSpawns: 0,
      mortarRounds: 0, mortarMasked: 0, sfStandby: 0, sfOps: 0, sfStrikes: 0,
      classes: new Array(9).fill(0), reclass: 0, feints: 0, feintDeclined: 0, baits: 0, baitSprung: 0, baitDeclined: 0,
      rearguards: {}, cqbSquads: 0, cqbEntries: 0, fragPrep: 0, scorched: 0, masked: 0, wheelPatches: 0,
    };
    this.log = [];
    this._t = 0; this._mineT = 0; this._sqI = 0;
    this._buildVisualBases();
    this._initSquads();
    const bus = game.bus;
    bus.on('kill', (attacker, victim) => this._onKill(attacker, victim));
    bus.on('shake', (x, y, z, k) => { if (k >= 6) { const i = this.blastK++ % 32; this.blastX[i] = x; this.blastZ[i] = z; this.blastT[i] = game.time; } });
  }

  note(line) { this.log.push(`t${this.game.time.toFixed(0)} ${line}`); if (this.log.length > 300) this.log.shift(); }

  get squads() { return this.game.ai.squads.squads; }
  get st() { return this.game.ai.st; }

  // ================================================================= set-up

  _initSquads() {
    const g = this.game;
    // Special forces: each faction's last two infantry squads; staged at the HQ on standby.
    for (const q of this.squads) {
      if (q.kind !== SquadKindInfantry) continue;
      let sf = -1;
      for (let i = 0; i < q.count; i++) { const s = g.soldiers[q.members[i]]; if (s && s.sfTeam >= 0) { sf = s.sfTeam; break; } }
      if (sf < 0) continue;
      q.sf = sf;
      q.sfName = SF_TEAMS[CONFIG.teams[q.team].faction][sf];
      q.held = `${q.sfName} on HQ standby`;
      this.stats.sfStandby++;
    }
  }

  _buildVisualBases() {
    const scene = this.game.render && this.game.render.scene;
    this.scene = scene || null;
    if (!scene) return;
    this.mat = this.game.render.setupMaterial ? this.game.render.setupMaterial(new THREE.MeshLambertMaterial({ vertexColors: true })) : new THREE.MeshLambertMaterial({ vertexColors: true });
    // Mines: small instanced discs (visible to the side that laid them; the enemy sees them once revealed).
    const mineGeo = mergeGeometries([cylY(0.16, 0.06, 0, 0.03, 0, 0x3c4229), cylY(0.05, 0.04, 0, 0.08, 0, 0x6b6d55)]);
    this.mineMesh = new THREE.InstancedMesh(mineGeo, this.mat, MAX_MINES);
    this.mineMesh.count = 0; this.mineMesh.frustumCulled = false; this.mineMesh.receiveShadow = true;
    scene.add(this.mineMesh);
  }

  // ================================================================= per-frame

  update(dt) {
    const g = this.game, time = g.time;
    if (!g.ai || !g.ai.squads) return;
    this._downed(time);
    this._drags(dt, time);
    this._powsTick(dt, time);
    this._mineT -= dt;
    if (this._mineT <= 0) { this._mineT = 0.25; this._minesTick(time); }
    // Squads round-robin: a share every frame, each squad about once per second.
    const sq = this.squads, n = sq.length;
    const per = Math.max(1, Math.ceil(n * dt / PERIOD_SQUAD));
    for (let k = 0; k < per; k++) { const q = sq[this._sqI++ % n]; if (q) this._squadTick(q, time); }
    this._t -= dt;
    if (this._t <= 0) { this._t = 1; this._siteTick(time); this._flagsTick(time); this._sfTick(time); this._mortarTick(time); }
  }

  // ================================================================= morale, panic, classification (per squad)

  _squadTick(q, time) {
    const g = this.game, st = this.st, id = q.id;
    if (id >= 256 || q.kind !== SquadKindInfantry || q.alive === 0) return;
    const dt = Math.min(3, time - (this.sqT[id] || time - 1)); this.sqT[id] = time;
    // --- Squad-anchored morale.
    const L = this.lossT[id];
    while (L.length && time - L[0] > 30) L.shift();
    let art = 0;
    for (let k = 0; k < 32; k++) if (time - this.blastT[k] < 12 && (this.blastX[k] - q.cx) ** 2 + (this.blastZ[k] - q.cz) ** 2 < 70 * 70) art += 0.35;
    let flank = 0, armour = 0, heli = 0, at = 0, medic = false, leader = false, cover = 0, dis = 0;
    for (let i = 0; i < q.cTarget.length; i++) {
      if (q.cTarget[i] < 0 || time - q.cT[i] > 10) continue;
      const yaw = Math.atan2(q.cX[i] - q.cx, q.cZ[i] - q.cz);
      let d = Math.abs(((yaw - q.threatYaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
      if (d > 1.8) flank = 1;
      const e = g.ai.engine.entity(q.cTarget[i]);
      if (e && e.kind === 'vehicle' && e.alive) {
        const dd = Math.hypot(e.pos.x - q.cx, e.pos.z - q.cz);
        if (e.isAircraft && e.def.kind === 'heli' && e.altitude < 70 && dd < 200) heli = 1;
        else if (!e.isAircraft && e.def.armor !== 'soft' && dd < 140) armour = 1;
      }
    }
    for (let i = 0; i < q.count; i++) {
      const s = g.soldiers[q.members[i]];
      if (!s || !s.alive || s.vehicle) continue;
      dis++;
      if (s.role === Role.MEDIC) medic = true;
      if (q.leader === s.id) leader = true;
      if (s.launcher && s.launcher.ammo + s.launcher.reserve > 0) at++;
      if (st.coverNode[s.id] >= 0) cover++;
    }
    const F = g.ai.frontline;
    const pocket = F ? F.zoneAt(q.team, q.cx, q.cz) === 4 : false;
    const rate = moraleRate({ suppression: q.suppressionAvg || 0, casualties: L.length, artillery: Math.min(1, art), flanked: flank, armour: at > 0 ? armour * 0.3 : armour, helicopter: heli, pocket, leader, cover: cover * 2 > dis, medic });
    let m = Math.max(0, Math.min(1, this.morale[id] + rate * dt));
    this.morale[id] = m;
    // Members are pulled toward the squad's morale; each one panics on his own (bounded, never looping).
    for (let i = 0; i < q.count; i++) {
      const o = q.members[i], s = g.soldiers[o];
      if (!s || !s.alive || s.isPlayer) continue;
      st.morale[o] = st.morale[o] * 0.6 + m * 0.4;
      if (st.morale[o] < 0.25 && time > this.immuneUntil[o] && this.panicUntil[o] < time && !s.pow && !s.downed) {
        const temper = ((o * 2654435761) >>> 0) / 4294967296;
        this.panicUntil[o] = time + panicDuration(temper);
        this.stats.panics++;
        if (this.stats.panics <= 40) this.note(`${this._who(s)} panics (morale ${st.morale[o].toFixed(2)}): smoke and a dash for hard cover, ${(this.panicUntil[o] - time).toFixed(1)} s`);
      } else if (this.panicUntil[o] > 0 && this.panicUntil[o] <= time) {
        // Sheltered (or rallied by the leader / a medic): back to SHAKEN, and not again for a while.
        this.panicUntil[o] = 0; st.morale[o] = Math.max(st.morale[o], PANIC_RECOVER); this.immuneUntil[o] = time + PANIC_IMMUNE;
        this.morale[id] = Math.max(this.morale[id], PANIC_RECOVER);
        this.stats.panicRecovered++;
      }
      this.stats.moraleBands[moraleBand(st.morale[o])]++;
      // Emergent surrender (Q1–Q6 per soldier): broken morale and no way out.
      if (st.morale[o] < 0.25 && !s.pow && !s.downed && !s.vehicle) this._weighSurrender(s, q, time);
    }
    // --- Event-driven classification: recompute only when the squad's key facts changed.
    this._classify(q, time);
    // --- CQB geometry, feint (tier 1) and flag baiting (tier 3).
    this._cqb(q, time);
    this._feint(q, time);
    this._flagBait(q, time);
    this._builds(q, time);
  }

  _who(s) { return `${CONFIG.teams[s.team].name} ${s.role !== undefined ? ['soldier', 'operator', 'medic', 'sapper', 'engineer', 'mechanic', 'scout', 'shock trooper', 'breacher', 'marksman', 'SF operator', 'mortarman'][s.role] : 'soldier'} #${s.id}`; }

  /** True while soldier o is in a panic reaction (the brain weighs smoke and hard cover above everything). */
  panicking(o) { return this.panicUntil[o] > this.game.time; }

  _classify(q, time) {
    const g = this.game, id = q.id;
    let veh = '', vid = -1, para = false, scouts = 0, ops = 0, n = 0;
    for (let i = 0; i < q.count; i++) {
      const s = g.soldiers[q.members[i]];
      if (!s || !s.alive) continue;
      n++;
      if (s.role === Role.SCOUT || s.role === Role.MARKSMAN) scouts++;
      if (s.role === Role.OPERATOR) ops++;
      if (s.vehicle && !s.vehicle.def.static) { veh = s.vehicle.def.type; vid = s.vehicle.id; if (s.vehicle.def.type === 'transportplane') para = true; }
    }
    if (!veh && q.transport >= 0 && (q.transportState === 'escort' || q.transportState === 'standby' || q.transportState === 'riding')) {
      const v = g.vehicles.list[q.transport];
      if (v && v.alive) { veh = v.def.type; vid = v.id; }
    }
    const T = g.map.terrain;
    const h = T.height(q.cx, q.cz) - CONFIG.world.waterLevel;
    const band = h >= ALPINE_ELEVATION ? 2 : h >= ALPINE_ELEVATION * 0.75 ? 1 : 0;
    const water = h < 0.5 ? 1 : 0;
    const key = ((vid + 1) * 31 + n) * 7 + band * 2 + water + (para ? 5000 : 0);
    if (key === this.sqKey[id]) return;
    this.sqKey[id] = key;
    const slope = T.slope ? T.slope(q.cx, q.cz) : 0;
    const c = classifySquad({ vehicle: veh, paradrop: para, scouts, operators: ops, members: n, water: !!water, elevation: h, slope });
    if (c !== this.sqClass[id]) {
      if (this.sqClass[id] >= 0) { this.stats.reclass++; if (this.stats.reclass <= 60) this.note(`squad ${id} ${SQUAD_CLASS_TAGS[this.sqClass[id]]} → ${SQUAD_CLASS_TAGS[c]} (${veh || 'on foot'}${band === 2 ? ', high ground' : ''})`); }
      this.sqClass[id] = c;
      q.squadClass = c; q.classTag = SQUAD_CLASS_TAGS[c];
      this.stats.classes[c]++;
    }
    void time;
  }

  // ================================================================= CQB, baiting, rearguards

  _cqb(q, time) {
    const g = this.game, U = g.ai.urban;
    if (!U || q.alive < 2) return;
    const dens = U.caution(q.team, q.cx, q.cz, -1e9);
    let storeys = 0, ruins = false;
    for (const b of g.structures.near(q.cx, q.cz)) {
      const bd = g.map.buildings[b];
      if (!bd) continue;
      storeys = Math.max(storeys, bd.floors || 1);
      if (bd.state >= 2) ruins = true;
    }
    // Wall clearance: distance between building footprints across the squad's heading (sampled).
    const fx = Math.cos(q.heading), fz = -Math.sin(q.heading);
    let clear = 40;
    for (const side of [-1, 1]) for (let r = 2; r <= 20; r += 3) { if (g.nav.blocked(q.cx + fx * r * side, q.cz + fz * r * side)) { clear = Math.min(clear, r * 2); break; } }
    const k = cqbFactor(dens, storeys, ruins, clear);
    const was = this.cqb[q.id] > 0.5;
    this.cqb[q.id] = k;
    q.cqb = k;
    if (k > 0.5 && !was) { this.stats.cqbSquads++; if (this.stats.cqbSquads <= 30) this.note(`squad ${q.id} enters CQB geometry (density ${dens.toFixed(2)}, ${storeys} storeys${ruins ? ', ruins' : ''}, clearance ${clear.toFixed(0)} m): stacked entry pairs, breachers lead`); }
    void time;
  }

  /** Tier 1 peek & feint: frontal push vs flank on an enemy holding an angle (posture through Q1–Q6). */
  _feint(q, time) {
    const g = this.game;
    if (q.alive < 4 || q.posture === Posture.FLANK || time < (q.feintT || 0)) return;
    // An enemy we know of, holding still in cover within 30–160 m.
    let best = -1, bd = 160;
    for (let i = 0; i < q.cTarget.length; i++) {
      if (q.cTarget[i] < 0 || time - q.cT[i] > 6) continue;
      const d = Math.hypot(q.cX[i] - q.cx, q.cZ[i] - q.cz);
      if (d > 30 && d < bd) { bd = d; best = i; }
    }
    if (best < 0) return;
    q.feintT = time + 8;
    const e = g.ai.engine.entity(q.cTarget[best]);
    if (!e || e.kind !== 'soldier' || !e.alive || e.speed > 1) return;
    const prot = g.ai.urban ? Math.min(1, g.ai.urban.caution(e.team, e.pos.x, e.pos.z, -1e9) + (e.stance > 0 ? 0.35 : 0)) : 0.4;
    const ours = q.alive, theirs = Math.max(1, g.ai.board.strengthNear(q.team, e.pos.x, e.pos.z, 40, time));
    // Flank route: a point 60° off the line to the enemy that is walkable.
    const yaw = Math.atan2(e.pos.x - q.cx, e.pos.z - q.cz), side = (q.id & 1) ? 1 : -1;
    const fx = e.pos.x - Math.sin(yaw + side * 1.1) * 45, fz = e.pos.z - Math.cos(yaw + side * 1.1) * 45;
    const route = !g.nav.blocked(fx, fz);
    let suppressing = 0;
    for (let i = 0; i < q.count; i++) if (this.st.action[q.members[i]] === 3) suppressing++;
    const A = feintAnswers(prot, q.suppressionAvg > 0.3 ? 0.8 : 0.4, ours / theirs, route, Math.min(1, suppressing / 2), this.A2);
    const D = this.D.begin(q.id, time, 0.5, q.suppressionAvg);
    D.propose(0, A[0]); D.propose(1, A[1] + 0.05);
    for (let op = D.next(); op >= 0; op = D.next()) {
      if (op === 0 && D.check(true, true, A[0], true, true) === 0) { D.choose(0); this.stats.feintDeclined++; return; }
      if (op === 1 && D.check(true, A[0] < 0.55, A[1] > 0.5 ? 1 : A[1], route, q.alive >= 4) === 0) {
        D.choose(1);
        // Element A (the team without the shock troops / breachers) suppresses to draw the enemy's aim; element B
        // flanks the blind side.
        let shock0 = 0, shock1 = 0;
        for (let i = 0; i < q.count; i++) { const s = g.soldiers[q.members[i]]; if (s && (s.role === Role.SHOCK || s.role === Role.BREACHER)) { if (this.st.fireteam[s.id]) shock1++; else shock0++; } }
        q.posture = Posture.FLANK; q.postureTime = time; q.flankTeam = shock0 > shock1 ? 0 : 1; q.flankX = fx; q.flankZ = fz; q.flankUntil = time + 25;
        q.decisionWhy = `feint: frontal ✗benefit (${A[0].toFixed(2)}) → flank ✓ (outcome ${A[1].toFixed(2)})`;
        this.stats.feints++;
        if (this.stats.feints <= 40) this.note(`squad ${q.id} peek & feint: element A suppresses ${e.team === 0 ? 'Pampalona' : 'Torsa'} rifleman holding an angle at ${bd.toFixed(0)} m, element B (team ${q.flankTeam}) flanks — frontal Q3 ${A[0].toFixed(2)}, flank Q4 ${A[1].toFixed(2)}`);
        return;
      }
    }
    D.none();
  }

  /** Tier 3 strategic flag baiting: CAPTURE_RING vs AMBUSH_PERIMETER against a predicted QRF. */
  _flagBait(q, time) {
    const g = this.game, f = q.objective;
    const b = this.bait[q.id];
    if (b) {
      // Sprung: the QRF walked into the crossfire (enemy at the flag or close to us) or timed out → take the flag.
      let near = 0;
      const B = g.ai.board, enemy = q.team;
      B.each(enemy, time, 8, (i) => { if (Math.hypot(B.x[i] - b.fx, B.z[i] - b.fz) < 45) near += B.estimatedCount(i); });
      if (near > 0 && !b.sprung) { b.sprung = true; this.stats.baitSprung++; this.note(`squad ${q.id} springs the ambush at ${b.name}: ${near} enemies walked into the crossfire`); q.holdFireUntil = 0; }
      if (time > b.until || (b.sprung && near === 0 && time > b.sprungT + 6) || !f || f.owner === q.team) {
        this.bait[q.id] = null; q.held = ''; q.holdFireUntil = 0;
        if (f && f.owner !== q.team) { q.order = Order.ATTACK; q.destX = f.x; q.destZ = f.z; q.destR = 12; q.planTime = -100; }
        this.note(`squad ${q.id} ends the ambush at ${b.name} → ${f && f.owner !== q.team ? 'captures the flag' : 'flag already ours'}`);
      } else if (b.sprung && !b.sprungT) b.sprungT = time;
      return;
    }
    if (!f || f.owner === q.team || f.base || q.alive < 3 || q.held || time < (q.baitT || 0)) return;
    const d = Math.hypot(f.x - q.cx, f.z - q.cz);
    if (d > 110) return;
    q.baitT = time + 6;
    // Light hold: few enemies known at the flag.
    const B = g.ai.board;
    // Lightly held: few defenders known at the flag (stationary records; a group on the move is a QRF, not a garrison).
    let held = 0;
    B.each(q.team, time, 20, (i) => { if (Math.hypot(B.vx[i], B.vz[i]) < 0.6 && Math.hypot(B.x[i] - f.x, B.z[i] - f.z) < 50) held += B.estimatedCount(i); });
    if (held > 2) return;
    // Predicted QRF: observed enemy groups heading for the flag; ETA from their velocity.
    let eta = Infinity, str = 0;
    B.each(q.team, time, 15, (i) => {
      const e = etaTo(B.x[i], B.z[i], B.vx[i], B.vz[i], f.x, f.z);
      if (e < 60) { eta = Math.min(eta, e); str += B.estimatedCount(i) * (B.cat[i] >= 2 ? 3 : 1); }
    });
    const rate = Math.max(0.2, f.capRate || 0.9), captureT = (1 + Math.abs(f.v)) / ((2.2 / CONFIG.match.captureTime) * rate);
    const open = g.ai.urban ? 1 - Math.min(1, g.ai.urban.caution(q.team, f.x, f.z, -1e9)) : 0.6;
    // Cover outside the ring, on our side of the flag, off the QRF's approach.
    const yaw = Math.atan2(q.cx - f.x, q.cz - f.z);
    const ax = f.x + Math.sin(yaw) * 38, az = f.z + Math.cos(yaw) * 38;
    const coverNear = g.ai.cover.grid.query(ax, az, 18, new Int32Array(64)) > 0;
    const A = flagBaitAnswers(eta, captureT, open, str / Math.max(1, q.alive), coverNear, this.A2);
    if (eta === Infinity) return;
    const D = this.D.begin(q.id + 700, time, 0.5, q.suppressionAvg);
    D.propose(0, A[0]); D.propose(1, A[1]);
    for (let op = D.next(); op >= 0; op = D.next()) {
      if (op === 0 && D.check(true, true, A[0], true, true) === 0) { D.choose(0); this.stats.baitDeclined++; return; }
      if (op === 1 && D.check(eta < Infinity, A[0] < 0.5, A[1], coverNear, q.alive >= 3) === 0) {
        D.choose(1);
        this.bait[q.id] = { fx: f.x, fz: f.z, name: f.name, until: time + Math.max(25, eta + 25), sprung: false, sprungT: 0 };
        q.held = `ambush perimeter at ${f.name}`;
        q.order = Order.HOLD; q.destX = ax; q.destZ = az; q.destR = 10; q.threatYaw = Math.atan2(f.x - ax, f.z - az); q.planTime = -100;
        q.holdFireUntil = time + Math.max(25, eta + 25);
        q.decisionWhy = `flag bait: ring ✗benefit (${A[0].toFixed(2)}, QRF ETA ${eta.toFixed(0)} s < capture ${captureT.toFixed(0)} s) → ambush ✓`;
        this.stats.baits++;
        this.note(`squad ${q.id} leaves ${f.name} uncaptured: predicted QRF (${str.toFixed(0)} strength) ETA ${eta.toFixed(0)} s vs ${captureT.toFixed(0)} s capture in the open → silent ambush perimeter 38 m out`);
        return;
      }
    }
    D.none();
  }

  /** Flags changing hands: post-capture rearguards for the captors, scorched earth for withdrawing garrisons. */
  _flagsTick(time) {
    const g = this.game, flags = g.capture.flags;
    for (const f of flags) {
      const prev = this.prevOwner[f.id];
      this.prevOwner[f.id] = f.owner;
      if (prev === -2 || prev === f.owner || f.owner < 0 || f.base) continue;
      // Captured by f.owner: every captor squad at the flag weighs its rearguard.
      for (const q of this.squads) {
        if (q.team !== f.owner || q.kind !== SquadKindInfantry || q.alive < 2 || Math.hypot(q.cx - f.x, q.cz - f.z) > 70) continue;
        this._rearguard(q, f, time);
      }
    }
    // Scorched earth: garrisons outnumbered 3:1 at a flag with stock weigh denying it before they go.
    for (const f of flags) {
      if (f.owner < 0 || f.base || f.capPhase !== 4 || f.capTeam === f.owner) continue;
      const L = g.logistics ? g.logistics.locations.find((l) => l.flag === f.id) : null;
      let assets = 0;
      if (L) for (const sl of L.slots) if (sl.crate >= 0) assets++;
      for (const s of this.sites) if (s.team === f.owner && s.done && Math.hypot(s.x - f.x, s.z - f.z) < 60) assets++;
      let dem = 0;
      for (const s of g.soldiers) if (s.alive && !s.pow && !s.downed && s.team === f.owner && !s.vehicle && Math.hypot(s.pos.x - f.x, s.pos.z - f.z) < 35) dem++;
      const A = scorchedAnswers(true, 3, assets, dem, this.A5);
      const D = this.D.begin(900 + f.id, time, 0.5, 0.5);
      D.propose(0, 1); D.next();
      if (D.check(A[0], A[1], A[2], A[3], A[4]) !== 0) { D.none(); continue; }
      D.choose(0);
      let n = 0;
      if (L) for (const sl of L.slots) if (sl.crate >= 0) { g.logistics._empty(sl.crate); n++; }
      if (L && L.max !== Infinity) { L.current = Math.max(0, L.current - Math.ceil(L.current * 0.6)); }
      for (const s of this.sites) if (s.team === f.owner && s.done && Math.hypot(s.x - f.x, s.z - f.z) < 60) { this._demolish(s); n++; }
      if (n) {
        g.combat.blast(f.x + 6, g.map.terrain.height(f.x + 6, f.z) + 0.5, f.z, 6, 40, null, 'DEMOLITION', true);
        this.stats.scorched++;
        this.note(`${CONFIG.teams[f.owner].name} garrison at ${f.name} overrun 3:1: scorched earth — ${n} crates / structures demolished before withdrawing`);
      }
    }
  }

  _rearguard(q, f, time) {
    const g = this.game, F = g.ai.frontline;
    if (time < this.rearUntil[q.id]) return;
    let exposure = 0;
    if (F) { const c = F.index(f.x, f.z); exposure = F.zone[q.team][c] === 2 ? 1 : F.zone[q.team][c] === 3 ? 0.8 : 0.3; }
    // Dedicated garrison: another squad of ours heading here.
    let eta = Infinity;
    for (const o of this.squads) if (o !== q && o.team === q.team && o.alive >= 2 && o.objective === f) eta = Math.min(eta, Math.hypot(o.cx - f.x, o.cz - f.z) / 3);
    const lost = this.lossT[q.id].length, burden = Math.max(0, Math.min(1, (lost + Math.max(0, 6 - q.alive) * 0.5) / 6 + this._powBurden(q) * 0.2));
    let retreat = 0;
    g.ai.board.each(q.team, time, 30, (i) => { if (Math.hypot(g.ai.board.x[i] - f.x, g.ai.board.z[i] - f.z) < 250) retreat = Math.min(1, retreat + g.ai.board.estimatedCount(i) * 0.15); });
    const env = g.environment, visibility = env && env.visibility !== undefined ? Math.max(0, Math.min(1, env.visibility)) : 1;
    let tall = false;
    for (const b of g.structures.near(f.x, f.z)) { const bd = g.map.buildings[b]; if (bd && (bd.floors || 1) >= 2) tall = true; }
    const vehicle = q.transport >= 0 && g.vehicles.list[q.transport] && g.vehicles.list[q.transport].alive;
    let assets = false;
    if (g.logistics) for (const L of g.logistics.locations) if (g.logistics.owner(L) === 1 - q.team && Math.hypot(L.x - f.x, L.z - f.z) < 400) assets = true;
    const sc = rearguardScores({ exposure, garrisonEta: eta, burden, retreat, visibility, vehicle: !!vehicle, tall, enemyAssets: assets }, SCORES);
    const D = this.D.begin(q.id + 1500, time, 0.5, burden);
    for (let i = 0; i < 6; i++) if (sc[i] > 0) D.propose(i, sc[i]);
    let pick = -1;
    for (let op = D.next(); op >= 0; op = D.next()) {
      const need = op === Rearguard.GARRISON ? (eta === Infinity || eta > 60 ? 1 : 0.3) : op === Rearguard.BLITZ ? (burden < 0.6 ? 1 : 0.3) : 1;
      if (D.check(true, need, sc[op], true, op === Rearguard.ARMOR_SPLIT ? !!vehicle : true) === 0) { pick = D.choose(op); break; }
    }
    if (pick < 0) { D.none(); return; }
    this.rear[q.id] = pick; this.rearUntil[q.id] = time + 45;
    this.stats.rearguards[REARGUARD_NAMES[pick]] = (this.stats.rearguards[REARGUARD_NAMES[pick]] || 0) + 1;
    q.decisionWhy = `rearguard at ${f.name}: ${REARGUARD_NAMES[pick]} (exposure ${exposure.toFixed(1)}, garrison ETA ${eta === Infinity ? '—' : eta.toFixed(0) + ' s'}, burden ${burden.toFixed(2)}, retreat ${retreat.toFixed(2)}, visibility ${visibility.toFixed(2)})`;
    this.note(`squad ${q.id} took ${f.name} → ${REARGUARD_NAMES[pick]} [${q.decisionWhy.split(': ')[1].split(' (')[1].replace(')', '')}]`);
    // Apply as an order (the commander does not re-task a squad that holds its rearguard for 45 s).
    const yaw = q.threatYaw;
    if (pick === Rearguard.GARRISON || pick === Rearguard.ROOFTOP) { q.order = Order.DEFEND; q.destX = f.x; q.destZ = f.z; q.destR = 25; q.garrison = f.id; }
    else if (pick === Rearguard.EMPTY_AMBUSH) { q.order = Order.HOLD; q.destX = f.x + Math.sin(yaw) * -40; q.destZ = f.z + Math.cos(yaw) * -40; q.destR = 10; q.holdFireUntil = time + 30; }
    else if (pick === Rearguard.ARMOR_SPLIT) { q.order = Order.SUPPORT; q.destX = f.x; q.destZ = f.z; q.destR = 30; }
    q.planTime = -100;
  }

  _powBurden(q) { let n = 0; for (let i = 0; i < q.count; i++) if (this.escortOf[q.members[i]] >= 0) n++; return n; }

  // ================================================================= engineering: builds

  /**
   * Squads with builders weigh one build each tick through Q1–Q6: engineers raise trenches facing the frontline's
   * threat vector at a held position, checkpoints on secure-rear roads near the front, forward barracks; sappers lay
   * minefields on predicted enemy approach corridors and raise MG nests at held flags.
   */
  _builds(q, time) {
    const g = this.game;
    if (time < (q.buildT || 0) || q.alive < 1 || q.vehicle >= 0) return;
    q.buildT = time + 6;
    let eng = 0, sap = 0;
    for (let i = 0; i < q.count; i++) { const s = g.soldiers[q.members[i]]; if (!s || !s.alive || s.vehicle || s.pow || s.downed) continue; if (s.role === Role.ENGINEER) eng++; if (s.role === Role.SAPPER) sap++; }
    if (!eng && !sap) return;
    // Already working on a site.
    for (const s of this.sites) if (s.squad === q.id && !s.done && !s.dead) return;
    const F = g.ai.frontline;
    if (!F) return;
    const team = q.team, c = F.index(q.cx, q.cz), zone = F.zone[team][c];
    // Threat vector: toward the nearest enemy-owned frontline cell.
    let tx = 0, tz = 0, bd = 1e12;
    for (let i = 0; i < F.count; i++) if (F.owner(i) === 1 - team) { const d = (F.cx(i) - q.cx) ** 2 + (F.cz(i) - q.cz) ** 2; if (d < bd) { bd = d; tx = F.cx(i); tz = F.cz(i); } }
    if (bd === 1e12) return;
    const frontD = Math.sqrt(bd), yaw = Math.atan2(tx - q.cx, tz - q.cz);
    const holding = q.order === Order.DEFEND || q.order === Order.HOLD || q.garrison >= 0 || (q.objective && q.objective.owner === team && Math.hypot(q.objective.x - q.cx, q.objective.z - q.cz) < 60);
    const D = this.D.begin(q.id + 2300, time, 0.5, q.suppressionAvg);
    const opts = [];
    if (eng >= 2) { opts.push(Build.TRENCH); if (eng >= 3) { opts.push(Build.CHECKPOINT); opts.push(Build.BARRACKS); } }
    if (sap) { opts.push(Build.MINEFIELD); opts.push(Build.MG_NEST); }
    for (const k of opts) D.propose(k, k === Build.TRENCH ? 0.6 : k === Build.MINEFIELD ? 0.55 : k === Build.MG_NEST ? 0.5 : k === Build.CHECKPOINT ? 0.45 : 0.4);
    const near = (kind, r) => this.sites.some((s) => s.team === team && !s.dead && s.kind === kind && Math.hypot(s.x - q.cx, s.z - q.cz) < r);
    for (let k = D.next(); k >= 0; k = D.next()) {
      let why = false, need = 0, benefit = 0, outcome = false, res = false, x = q.cx, z = q.cz;
      if (k === Build.TRENCH) {
        why = holding && frontD < 450; need = near(Build.TRENCH, 60) ? 0 : 1; benefit = q.suppressionAvg < 0.5 ? 1 : 0.3;
        x = q.cx + Math.sin(yaw) * 12; z = q.cz + Math.cos(yaw) * 12; outcome = !g.nav.blocked(x, z); res = eng >= 2;
      } else if (k === Build.CHECKPOINT) {
        why = zone === 1 && frontD < 500 && frontD > 150; need = near(Build.CHECKPOINT, 400) ? 0 : 1; benefit = 1;
        const p = this._roadPoint(q.cx, q.cz, 60); outcome = !!p; if (p) { x = p.x; z = p.z; } res = eng >= 3 && this._pooledMg(team) !== null;
      } else if (k === Build.BARRACKS) {
        why = zone === 1 && frontD < 600 && frontD > 200; need = near(Build.BARRACKS, 700) || this.sites.filter((s) => s.team === team && s.kind === Build.BARRACKS && !s.dead).length >= 2 ? 0 : 1; benefit = 1;
        x = q.cx - Math.sin(yaw) * 20; z = q.cz - Math.cos(yaw) * 20; outcome = !g.nav.blocked(x, z); res = eng >= 3;
      } else if (k === Build.MINEFIELD) {
        // Predicted enemy approach corridor: road / open ground between us and their nearest ground, 40–110 m out.
        why = frontD < 400; need = this.mineN < MAX_MINES - 6 && !this._minesNear(team, q.cx + Math.sin(yaw) * 70, q.cz + Math.cos(yaw) * 70, 60) ? 1 : 0;
        const p = this._corridor(q.cx, q.cz, yaw, 40, 110); outcome = !!p; if (p) { x = p.x; z = p.z; }
        benefit = q.suppressionAvg < 0.6 ? 1 : 0.3; res = sap > 0;
      } else if (k === Build.MG_NEST) {
        why = holding && frontD < 350; need = near(Build.MG_NEST, 80) ? 0 : 1; benefit = 1;
        x = q.cx + Math.sin(yaw) * 8; z = q.cz + Math.cos(yaw) * 8; outcome = !g.nav.blocked(x, z, true); res = this._pooledMg(team) !== null;
      }
      if (D.check(why, need, benefit, outcome, res) === 0) { D.choose(k); this._startSite(k, q, x, z, yaw, time); return; }
    }
    D.none();
  }

  _roadPoint(x, z, r) {
    const T = this.game.map.terrain;
    let best = null, bs = 0.35;
    for (let k = 0; k < 24; k++) {
      const a = k * 0.785, d = 12 + (k >> 3) * (r / 3), px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d;
      const v = T.roadAt ? T.roadAt(px, pz) : 0;
      if (v > bs && !this.game.nav.blocked(px, pz, true)) { bs = v; best = { x: px, z: pz }; }
    }
    return best;
  }

  _corridor(x, z, yaw, d0, d1) {
    const T = this.game.map.terrain;
    let best = null, bs = -1;
    for (let d = d0; d <= d1; d += 14) for (const off of [-12, 0, 12]) {
      const px = x + Math.sin(yaw) * d + Math.cos(yaw) * off, pz = z + Math.cos(yaw) * d - Math.sin(yaw) * off;
      if (this.game.nav.blocked(px, pz)) continue;
      const s = (T.roadAt ? T.roadAt(px, pz) : 0) * 2 + 0.2;
      if (s > bs) { bs = s; best = { x: px, z: pz }; }
    }
    return best;
  }

  _minesNear(team, x, z, r) { for (let i = 0; i < this.mineN; i++) if (this.mteam[i] === team && (this.mx[i] - x) ** 2 + (this.mz[i] - z) ** 2 < r * r) return true; return false; }

  _pooledMg(team) {
    for (const v of this.game.vehicles.list) if (v.pooled && v.spawn.team === team) return v;
    return null;
  }

  _startSite(kind, q, x, z, yaw, time) {
    const site = { id: this.sites.length, kind, team: q.team, squad: q.id, x, z, yaw, stage: 0, stages: BUILD_STAGES[kind], work: 0, done: false, dead: false, born: time, mesh: null, name: BUILD_NAMES[kind] };
    this.sites.push(site);
    this.stats.builds[BUILD_NAMES[kind]] = (this.stats.builds[BUILD_NAMES[kind]] || 0) + 1;
    const fo = q.objective ? ` near ${q.objective.name}` : '';
    this.note(`squad ${q.id} (${kind === Build.MINEFIELD || kind === Build.MG_NEST ? 'sappers' : 'combat engineers'}) starts a ${site.name}${fo} facing the threat vector`);
    // Assign the builders.
    const cap = kind === Build.MINEFIELD || kind === Build.MG_NEST ? Role.SAPPER : Role.ENGINEER;
    for (let i = 0; i < q.count; i++) { const s = this.game.soldiers[q.members[i]]; if (s && s.alive && s.role === cap) this.job[s.id] = site.id; }
    // The squad holds at the site while it works (the commander leaves it be).
    q.held = `building ${site.name}`;
    q.order = Order.HOLD; q.destX = x; q.destZ = z; q.destR = 14; q.planTime = -100;
  }

  /** The build site soldier o is working on (-1 none), with its position in out. */
  jobOf(o, out) {
    const j = this.job[o];
    if (j < 0) return -1;
    const s = this.sites[j];
    if (!s || s.done || s.dead) { this.job[o] = -1; return -1; }
    if (out) { out[0] = s.x; out[1] = s.z; }
    return j;
  }

  /** A soldier at the site puts in dt seconds of work. */
  work(o, dt) {
    const j = this.job[o], s = this.sites[j];
    if (!s || s.done) return;
    const sol = this.game.soldiers[o];
    if (!sol || (sol.pos.x - s.x) ** 2 + (sol.pos.z - s.z) ** 2 > 7 * 7) return;
    s.work += dt;
    const per = BUILD_WORK[s.kind] / Math.max(1, BUILD_CREW[s.kind]);
    if (s.work >= per * (s.stage + 1) * (s.kind === Build.TRENCH ? 1 : 1)) this._advance(s);
  }

  _advance(s) {
    const g = this.game;
    s.stage++;
    if (s.kind === Build.TRENCH) { this.stats.trenchStages++; this.note(`${CONFIG.teams[s.team].name} trench stage ${s.stage}/3: ${TRENCH_STAGE_NAMES[s.stage - 1]}`); }
    this._visual(s);
    if (s.stage < s.stages) return;
    s.done = true;
    this.stats.buildsDone[s.name] = (this.stats.buildsDone[s.name] || 0) + 1;
    const q = this.squads[s.squad];
    if (q && q.held && q.held.startsWith('building')) q.held = '';
    for (let i = 0; i < this.job.length; i++) if (this.job[i] === s.id) this.job[i] = -1;
    if (s.kind === Build.MINEFIELD) {
      const sx = Math.cos(s.yaw), sz = -Math.sin(s.yaw);
      const n = 4, at = g.map.terrain.roadAt && g.map.terrain.roadAt(s.x, s.z) > 0.3;
      for (let k = 0; k < n; k++) {
        const off = (k - (n - 1) / 2) * 4;
        this._layMine(s.team, s.x + sx * off, s.z + sz * off, at || k % 2 === 0 ? 1 : 0);
      }
      this.note(`${CONFIG.teams[s.team].name} sappers log ${at ? 'a mixed AT/AP' : 'an AP/AT'} minefield (${n} mines) on the predicted approach corridor — friendly routes now avoid it`);
    } else if (s.kind === Build.MG_NEST || s.kind === Build.CHECKPOINT) {
      const v = this._pooledMg(s.team);
      if (v) {
        const off = s.kind === Build.CHECKPOINT ? 6 : 0;
        v.spawn.x = s.x + Math.sin(s.yaw) * off; v.spawn.z = s.z + Math.cos(s.yaw) * off; v.spawn.yaw = s.yaw; v.spawn.team = s.team;
        v.pooled = false; v.reset();
        s.vehicle = v.id;
        this.stats.mgNests++;
        this.note(`${CONFIG.teams[s.team].name} ${s.kind === Build.CHECKPOINT ? 'checkpoint HMG post' : 'sappers raise an MG emplacement'} manned at (${s.x.toFixed(0)}, ${s.z.toFixed(0)})`);
      }
      if (s.kind === Build.CHECKPOINT) {
        this.stats.checkpoints++;
        if (g.logistics) g.logistics.addCheckpoint(s.x - Math.sin(s.yaw) * 10, s.z - Math.cos(s.yaw) * 10, s.team, `CP-${s.id}`);
        this.note(`${CONFIG.teams[s.team].name} engineers complete a checkpoint: guard booth, barrier, HMG post and a two-bay supply zone (smallest forward stash)`);
      }
    } else if (s.kind === Build.BARRACKS) {
      this.stats.barracks++;
      this.note(`${CONFIG.teams[s.team].name} engineers raise forward barracks: squads reinforce from here`);
    }
  }

  _demolish(s) {
    s.dead = true;
    if (s.mesh && this.scene) { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); }
    if (s.vehicle !== undefined) { const v = this.game.vehicles.list[s.vehicle]; if (v && v.alive) v.damage(v.def.health * 2, null); }
  }

  _visual(s) {
    if (!this.scene) return;
    const T = this.game.map.terrain, y = T.height(s.x, s.z);
    const parts = [];
    const earth = 0x6e5a3e, bag = 0xa8946a, wood = 0x6b5034, dark = 0x2b2c28;
    if (s.kind === Build.TRENCH) {
      for (let k = -3; k <= 3; k++) parts.push(box(1.6, 0.55, 1.1, k * 1.5, 0.27, 0.9 + Math.abs(k) * 0.12, earth, k * 0.06));
      if (s.stage >= 2) for (let k = -3; k <= 3; k++) for (let r = 0; r < 2; r++) parts.push(box(0.7, 0.22, 0.42, k * 1.5 + (r ? 0.35 : 0), 0.66 + r * 0.22, 0.85 + Math.abs(k) * 0.12, bag, k * 0.06));
      if (s.stage >= 3) {
        for (const x of [-4.2, -1.4, 1.4, 4.2]) parts.push(box(0.16, 1.5, 0.16, x, 0.75, -0.6, wood));
        parts.push(box(10, 0.18, 2.4, 0, 1.55, 0.2, wood)); parts.push(box(9.6, 0.28, 2.2, 0, 1.78, 0.2, bag));
      }
    } else if (s.kind === Build.CHECKPOINT) {
      parts.push(box(2, 2.4, 2, -4, 1.2, 0, 0x8a8f7a)); parts.push(box(2.4, 0.15, 2.4, -4, 2.47, 0, dark)); parts.push(box(1.2, 0.6, 0.05, -4, 1.6, 1.01, 0x9ab6c0));
      parts.push(box(0.25, 1.1, 0.25, -2.6, 0.55, 3, dark));
      for (let k = 0; k < 6; k++) parts.push(box(1, 0.12, 0.12, -2 + k, 1.0, 3, k % 2 ? 0xe8e6dc : 0xb3242b));
      for (let k = -2; k <= 2; k++) parts.push(box(0.7, 0.4, 0.42, 5 + k * 0.72, 0.2, -1.6, bag));
    } else if (s.kind === Build.BARRACKS) {
      const tent = new THREE.CylinderGeometry(0.01, 3.2, 2.8, 3, 1).rotateZ(Math.PI / 2).scale(2.2, 1, 1).translate(0, 1.4, 0);
      parts.push(colored(tent.toNonIndexed(), 0x56603d));
      for (let k = -3; k <= 3; k++) parts.push(box(0.7, 0.5, 0.42, k * 0.75, 0.25, 4, bag));
    } else if (s.kind === Build.MG_NEST || s.kind === Build.SANDBAGS) {
      for (let a = -2; a <= 2; a++) parts.push(box(0.75, 0.45, 0.42, Math.sin(a * 0.45) * 2.2, 0.22, Math.cos(a * 0.45) * 2.2, bag, a * 0.45));
    } else return;
    for (const p of parts) if (!p.index) { const n = p.attributes.position.count; const idx = []; for (let i = 0; i < n; i++) idx.push(i); p.setIndex(idx); }
    const geo = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
    if (s.mesh) { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); }
    s.mesh = new THREE.Mesh(geo, this.mat);
    s.mesh.position.set(s.x, y, s.z); s.mesh.rotation.y = s.yaw;
    s.mesh.castShadow = true; s.mesh.receiveShadow = true;
    this.scene.add(s.mesh);
  }

  _siteTick(time) {
    // Abandoned sites (builders gone for 90 s) are dropped.
    for (const s of this.sites) {
      if (s.done || s.dead) continue;
      let any = false;
      for (let i = 0; i < this.job.length; i++) if (this.job[i] === s.id && this.game.soldiers[i].alive) { any = true; break; }
      if (!any && time - s.born > 90) { s.dead = true; const q = this.squads[s.squad]; if (q && q.held && q.held.startsWith('building')) q.held = ''; }
    }
    // Pooled MG emplacements destroyed at a site go back to the pool.
    for (const v of this.game.vehicles.list) if (v.poolable && !v.alive && !v.pooled && v.wreckTimer !== undefined && v.respawnTimer <= 1) { v.pooled = true; }
  }

  /** Damage taken in a finished trench (by stage): parapet 0.75, sandbags 0.55, overhead cover 0.4. */
  protection(s) {
    for (const t of this.sites) {
      if (t.kind !== Build.TRENCH || t.dead || t.stage === 0 || t.team !== s.team) continue;
      if ((s.pos.x - t.x) ** 2 + (s.pos.z - t.z) ** 2 < 6 * 6) return t.stage >= 3 ? 0.4 : t.stage >= 2 ? 0.55 : 0.75;
    }
    return 1;
  }

  /**
   * Fortification mask: friendly fire (artillery, mortars, grenades) may not land on coordinates overlapping our
   * trenches / build sites, supply crates or buildings our soldiers occupy. @returns true when masked
   */
  masked(team, x, z, r) {
    const g = this.game, rr = (r + 6) * (r + 6);
    for (const s of this.sites) if (s.team === team && !s.dead && (s.x - x) ** 2 + (s.z - z) ** 2 < rr) return true;
    if (g.logistics && g.logistics.nearestCrate(team, x, z, r + 3, null) >= 0) return true;
    for (const b of g.structures.near(x, z)) {
      const bd = g.map.buildings[b];
      if (!bd || (bd.x - x) ** 2 + (bd.z - z) ** 2 > (r + 12) ** 2) continue;
      for (const sol of g.soldiers) if (sol.alive && sol.team === team && !sol.vehicle && (sol.pos.x - bd.x) ** 2 + (sol.pos.z - bd.z) ** 2 < 100) return true;
    }
    return false;
  }

  /** Forward barracks of the soldier's side nearer its squad's objective than `score` (spawn point), or null. */
  barracksFor(s, objective, score) {
    let best = null;
    for (const b of this.sites) {
      if (b.kind !== Build.BARRACKS || !b.done || b.dead || b.team !== s.team) continue;
      const d = objective ? Math.hypot(b.x - objective.x, b.z - objective.z) : 400;
      if (d < score) { score = d; best = b; }
    }
    if (best) this.stats.barracksSpawns++;
    return best;
  }

  // ================================================================= mines

  _layMine(team, x, z, type) {
    if (this.mineN >= MAX_MINES) return;
    const i = this.mineN++;
    this.mx[i] = x; this.mz[i] = z; this.mteam[i] = team; this.mtype[i] = type; this.mknown[i] = 1 << team;
    this.stats.minesLaid++;
    const nav = this.game.nav;
    if (nav.stampMine) nav.stampMine(team, x, z, type ? 4 : 2, 1);
    this._mineVisual();
  }

  _mineVisual() {
    const m = this.mineMesh;
    if (!m) return;
    const T = this.game.map.terrain, M = new THREE.Matrix4();
    let n = 0;
    for (let i = 0; i < this.mineN; i++) {
      if (this.mteam[i] < 0) continue;
      M.makeTranslation(this.mx[i], T.height(this.mx[i], this.mz[i]), this.mz[i]);
      if (this.mtype[i]) M.scale(_v.set(1.6, 1, 1.6));
      m.setMatrixAt(n++, M);
    }
    m.count = n; m.instanceMatrix.needsUpdate = true;
  }

  _minesTick(time) {
    const g = this.game, ai = g.ai, grid = ai.grid, S = g.soldiers.length;
    const ids = this._ids || (this._ids = new Int32Array(64));
    for (let i = 0; i < this.mineN; i++) {
      const team = this.mteam[i];
      if (team < 0) continue;
      const at = this.mtype[i] === 1;
      const n = grid.queryRadius(this.mx[i], this.mz[i], at ? 3 : 1.6, ids);
      for (let k = 0; k < n; k++) {
        const e = ids[k] < S ? g.soldiers[ids[k]] : g.vehicles.list[ids[k] - S];
        if (!e || !e.alive || e.team === team) continue;
        if (ids[k] < S) { if (e.vehicle || e.pow) continue; }
        else if (!at || e.isAircraft || e.def.static) continue;
        // Detonation.
        const y = g.map.terrain.height(this.mx[i], this.mz[i]);
        g.combat.blast(this.mx[i], y + 0.3, this.mz[i], at ? 5 : 3.5, at ? 160 : 120, null, at ? 'AT MINE' : 'AP MINE', true);
        if (ids[k] >= S) e.damage(e.def.health * (e.def.armor === 'heavy' ? 0.45 : 0.75), null);
        if (g.nav.stampMine) g.nav.stampMine(team, this.mx[i], this.mz[i], at ? 4 : 2, -1);
        this.mteam[i] = -1;
        this.stats.mineHits++;
        this.note(`${at ? 'AT' : 'AP'} mine of ${CONFIG.teams[team].name} detonates under ${ids[k] >= S ? e.def.label : 'an enemy soldier'}`);
        this._mineVisual();
        break;
      }
    }
    void time;
  }

  // ================================================================= mortars

  _mortarTick(time) {
    const g = this.game, B = g.ai.board;
    for (const s of g.soldiers) {
      if (s.role !== Role.MORTAR || s.skin !== Role.MORTAR || !s.alive || s.vehicle || s.pow || s.downed) continue;
      let m = this.mortars.get(s.id);
      if (!m) { m = { ws: new WeaponState('mortar82'), set: 0, t: 0, tx: 0, tz: 0 }; this.mortars.set(s.id, m); }
      // Target: the biggest fresh enemy cluster 120–600 m out, outside friendly danger-close and masks.
      let best = -1, bs = 0;
      B.each(s.team, time, 20, (i) => {
        const d = Math.hypot(B.x[i] - s.pos.x, B.z[i] - s.pos.z);
        if (d < 120 || d > 600) return;
        const sc = B.estimatedCount(i) * B.confidence(i, time);
        if (sc > bs) { bs = sc; best = i; }
      });
      s.mortarTarget = best >= 0 && bs >= 1.2 ? best : -1;
      if (best < 0 || bs < 1.2) { m.set = 0; continue; }
      const tx = B.x[best], tz = B.z[best];
      let close = false;
      for (const o of g.soldiers) if (o.alive && o.team === s.team && (o.pos.x - tx) ** 2 + (o.pos.z - tz) ** 2 < 45 * 45) { close = true; break; }
      if (close || this.masked(s.team, tx, tz, 9)) { this.stats.mortarMasked++; continue; }
      if (this.st.action[s.id] !== 21) continue;
      m.set += 1;
      if (m.set < 3) continue; // emplacing the tube
      // Rounds: the bearer close by carries the rack.
      let bearer = false;
      const q = s.squad;
      if (q) for (let i = 0; i < q.count; i++) { const b = g.soldiers[q.members[i]]; if (b && b.alive && b.skin === 13 && Math.hypot(b.pos.x - s.pos.x, b.pos.z - s.pos.z) < 15) bearer = true; }
      const ws = m.ws;
      if (ws.reserve <= 0 && bearer) ws.reserve = 6;
      if (time - m.t < (bearer ? 4.5 : 7)) continue;
      ws.cooldown = 0; ws.reloadTimer = 0; if (ws.ammo <= 0 && ws.reserve > 0) { ws.ammo = 1; ws.reserve--; }
      if (ws.ammo <= 0) continue;
      const T = g.map.terrain, ox = s.pos.x, oz = s.pos.z, oy = T.height(ox, oz) + 0.9;
      const dx = Math.hypot(tx - ox, tz - oz), dy = T.height(tx, tz) - oy;
      const pitch = ballisticPitch(dx, dy, ws.def.speed, ws.def.gravity, true);
      if (!Number.isFinite(pitch)) continue;
      const yaw = Math.atan2(tx - ox, tz - oz), cp = Math.cos(pitch);
      _o.set(ox, oy, oz); _d.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
      if (g.combat.fire(s, ws, _o, _d, 1)) {
        m.t = time; this.stats.mortarRounds++;
        if (this.stats.mortarRounds <= 12 || this.stats.mortarRounds % 25 === 0) this.note(`${this._who(s)} fires 82 mm at an observed cluster (${B.estimatedCount(best)}) ${dx.toFixed(0)} m out${bearer ? ', bearer feeding rounds' : ''}`);
      }
    }
  }

  // ================================================================= special forces

  _sfTick(time) {
    const g = this.game;
    for (const q of this.squads) {
      if (q.sf === undefined || q.team < 0) continue;
      const cmd = g.ai.commanders[q.team];
      if (q.sfOp) {
        const op = q.sfOp;
        const tgt = op.vehicle !== undefined ? g.vehicles.list[op.vehicle] : null;
        const powGone = op.pow !== undefined && (!g.soldiers[op.pow].alive || g.soldiers[op.pow].pow !== 1);
        if (q.alive === 0 || time - op.t > 300 || (tgt && !tgt.alive) || powGone) {
          if (powGone) this.note(`${q.sfName}: ${op.label} no longer held — stands down`);
          if (tgt && !tgt.alive) { this.stats.sfStrikes++; this.note(`${q.sfName} completes ${op.kind}: ${op.label} destroyed`); }
          q.sfOp = null; q.held = `${q.sfName} on HQ standby`;
          const base = g.map.bases[q.team], bf = base ? g.capture.flags[base.flag] : null;
          if (bf) { q.order = Order.MOVE; q.destX = bf.x; q.destZ = bf.z; q.destR = 30; q.planTime = -100; }
          continue;
        }
        if (tgt) {
          q.order = Order.ATTACK; q.destX = tgt.pos.x; q.destZ = tgt.pos.z; q.destR = 15;
          // Close enough: demolition charges on the asset.
          for (let i = 0; i < q.count; i++) { const s = g.soldiers[q.members[i]]; if (s && s.alive && Math.hypot(s.pos.x - tgt.pos.x, s.pos.z - tgt.pos.z) < 9) { tgt.damage(tgt.def.health * 0.6, s); g.combat.blast(tgt.pos.x, tgt.pos.y, tgt.pos.z, 5, 60, s, 'DEMOLITION', true); break; } }
        }
        continue;
      }
      if (q.alive < 3 || time < (q.sfT || 0)) continue;
      q.sfT = time + 10;
      // Special-operation candidates (importance 0..1): observed enemy high-value assets (radar, TEL, MLRS, SAM,
      // howitzer) — destruction raids; own soldiers taken prisoner nearby — POW rescue.
      const B = g.ai.board;
      let best = null, bi = 0;
      for (const v of g.vehicles.list) {
        if (!v.alive || v.team === q.team || v.isAircraft || (!v.occupied && v.spawn.team !== 1 - q.team)) continue;
        const hv = { radar: 0.85, tel: 0.95, mlrs: 0.75, smerch: 0.8, grad: 0.7, sam: 0.7, howitzer: 0.65 }[v.def.type];
        if (!hv) continue;
        // Known to us: an observation near it.
        let seen = false;
        B.each(q.team, time, 60, (i) => { if (Math.hypot(B.x[i] - v.pos.x, B.z[i] - v.pos.z) < 60) seen = true; });
        if (!seen) continue;
        const d = Math.hypot(v.pos.x - q.cx, v.pos.z - q.cz);
        const imp = hv * (d < 1500 ? 1 : 0.7);
        if (imp > bi) { bi = imp; best = { kind: 'destruction raid', label: v.def.label, vehicle: v.id, x: v.pos.x, z: v.pos.z, t: time }; }
      }
      for (const id of this.pows) {
        const p = g.soldiers[id];
        if (!p || p.team !== q.team || p.pow !== 1) continue;
        const imp = 0.7;
        if (imp > bi) { bi = imp; best = { kind: 'POW rescue', label: `prisoner #${id}`, pow: id, x: p.pos.x, z: p.pos.z, t: time }; }
      }
      if (!best) continue;
      // One team per target: the other named team stays on standby.
      if (this.squads.some((o) => o !== q && o.team === q.team && o.sfOp && ((best.vehicle !== undefined && o.sfOp.vehicle === best.vehicle) || (best.pow !== undefined && o.sfOp.pow === best.pow)))) continue;
      const D = this.D.begin(q.id + 3100, time, 0.7, 0);
      D.propose(0, bi); D.next();
      // Q1 a target · Q2 importance ≥ 65 % (no routine use) · Q3 benefit · Q4 reachable on its landmass · Q5 team fit.
      const r = D.check(true, bi >= 0.65, bi, g.nav.sameLandmass ? g.nav.sameLandmass(q.cx, q.cz, best.x, best.z) : true, q.alive >= 3);
      if (r !== 0) { D.none(); continue; }
      D.choose(0);
      q.sfOp = best; q.held = `${q.sfName}: ${best.kind}`;
      q.order = Order.ATTACK; q.destX = best.x; q.destZ = best.z; q.destR = 15; q.planTime = -100; q.axisDone = true;
      this.stats.sfOps++;
      if (cmd && cmd.note) cmd.note(`special operation: ${q.sfName} — ${best.kind} on ${best.label}`);
      this.note(`${q.sfName} (${CONFIG.teams[q.team].name} SF) launched on a special operation: ${best.kind} → ${best.label} (importance ${(bi * 100).toFixed(0)} %), low-signature infiltration`);
    }
  }

  // ================================================================= casualties: downed, drag, medic

  /**
   * A soldier who would die from small-arms / fragment wounds may instead go down (incapacitated, bleeding out over
   * 40 s): squadmates can drag him to cover, a medic can bring him back. @returns true when downed instead of killed
   */
  down(s, cause) {
    if (s.isPlayer || s.vehicle || s.downed || s.pow || !s.ai) return false;
    if (/MINE|BLAST|DEMOLITION|CANNON|ROCKET|MISSILE|BOMB|MM/.test(cause || '')) return false;
    if (((s.id * 7 + Math.floor(this.game.time)) % 10) >= 4) return false;
    s.downed = true; s.health = 6; this.downT[s.id] = this.game.time;
    if (this.game.ai.cover && this.st.coverNode[s.id] >= 0) { this.game.ai.cover.release(this.st.coverNode[s.id], s.id); this.st.coverNode[s.id] = -1; }
    s.moveX = s.moveZ = 0; s.stance = 2;
    if (s.ai) { s.ai.target = null; s.ai.hasGoal = false; }
    this.stats.downed++;
    return true;
  }

  _downed(time) {
    const g = this.game;
    for (const s of g.soldiers) {
      if (!s.downed) continue;
      if (!s.alive) { s.downed = false; continue; }
      s.stance = 2; s.moveX = s.moveZ = 0;
      if (s.health >= 30) { s.downed = false; this.stats.revived++; if (this.stats.revived <= 20) this.note(`${this._who(s)} revived by a medic under cover`); continue; }
      if (time - this.downT[s.id] > 40) { s.downed = false; g.combat.kill(s, s.lastAttacker || null, 0, 0, 0, 'BLED OUT'); this.stats.bledOut++; }
    }
  }

  /** Who (if anyone) soldier o should drag now: Q1–Q6 for each downed squadmate in an exposed fire lane. */
  dragJob(o, out) {
    const g = this.game, time = g.time, s = g.soldiers[o];
    const c = this.dragOf[o];
    if (c >= 0) {
      const v = g.soldiers[c];
      if (!v || !v.alive || !v.downed) { this.dragOf[o] = -1; if (c >= 0) this.dragBy[c] = -1; return -1; }
      if (out) { out[0] = v.pos.x; out[1] = v.pos.z; }
      return c;
    }
    const q = s.squad;
    if (!q || s.downed || s.pow || s.role === Role.OPERATOR || time < (s.dragT || 0)) return -1;
    s.dragT = time + 2;
    for (let i = 0; i < q.count; i++) {
      const v = g.soldiers[q.members[i]];
      if (!v || v === s || !v.alive || !v.downed || this.dragBy[v.id] >= 0) continue;
      const dist = Math.hypot(v.pos.x - s.pos.x, v.pos.z - s.pos.z);
      if (dist > 45) continue;
      // Exposed: enemy contacts with a line onto him (not inside cover), and how much of the way crosses fire.
      let exposed = false, crossing = 0;
      for (let k = 0; k < q.cTarget.length; k++) {
        if (q.cTarget[k] < 0 || time - q.cT[k] > 8) continue;
        const de = Math.hypot(q.cX[k] - v.pos.x, q.cZ[k] - v.pos.z);
        if (de < 300) { exposed = true; crossing = Math.max(crossing, Math.min(1, 80 / Math.max(20, de))); }
      }
      // He fell where he stood: exposed unless he lies right at hard cover.
      const coverD = this._coverDist(v.pos.x, v.pos.z);
      if (coverD < 2.5) exposed = false;
      const smoke = time >= this.st.smokeReadyAt[o];
      const A = dragAnswers({ exposed, dist, suppression: this.st.suppression[o], crossing, smoke, coverDist: coverD, hp: s.health / 100, taken: false }, this.A5);
      const D = this.Ds.begin(o + 4000, time, 0.5 + (((o * 97) % 50) / 100), this.st.suppression[o]);
      D.propose(0, 1); D.next();
      if (D.check(A[0], A[1], A[2], A[3], A[4]) !== 0) { D.none(); this.stats.dragDeclined++; continue; }
      D.choose(0);
      this.dragOf[o] = v.id; this.dragBy[v.id] = o;
      v.dragCover = this._coverPoint(v.pos.x, v.pos.z, q);
      this.stats.drags++;
      if (this.stats.drags <= 30) this.note(`${this._who(s)} goes for downed ${this._who(v)} in an exposed fire lane (benefit ${A[2].toFixed(2)}${smoke ? ', popping smoke' : ''}) → drags him ${coverD.toFixed(0)} m behind cover`);
      if (smoke && g.ai.smoke) { g.ai.smoke.deploy(v.pos.x, g.map.terrain.height(v.pos.x, v.pos.z) + 1, v.pos.z, 7, 16, time); this.st.smokeReadyAt[o] = time + 40; }
      if (out) { out[0] = v.pos.x; out[1] = v.pos.z; }
      return v.id;
    }
    return -1;
  }

  _coverDist(x, z) {
    const C = this.game.ai.cover, ids = this._cids || (this._cids = new Int32Array(64));
    const n = C.grid.query(x, z, 30, ids);
    let bd = 99;
    for (let i = 0; i < n; i++) bd = Math.min(bd, Math.hypot(C.x[ids[i]] - x, C.z[ids[i]] - z));
    return bd;
  }

  _coverPoint(x, z, q) {
    const C = this.game.ai.cover, ids = this._cids || (this._cids = new Int32Array(64));
    const n = C.grid.query(x, z, 30, ids);
    let best = null, bs = 1e9;
    for (let i = 0; i < n; i++) {
      const cx = C.x[ids[i]], cz = C.z[ids[i]];
      // Behind it as seen from the enemy (away from the squad's threat direction), and near.
      const away = Math.sin(q.threatYaw) * (cx - x) + Math.cos(q.threatYaw) * (cz - z);
      const sc = Math.hypot(cx - x, cz - z) + away * 1.5;
      if (sc < bs) { bs = sc; best = { x: cx - Math.sin(q.threatYaw) * 1.2, z: cz - Math.cos(q.threatYaw) * 1.2 }; }
    }
    return best || { x: x - Math.sin(q.threatYaw) * 12, z: z - Math.cos(q.threatYaw) * 12 };
  }

  _drags(dt, time) {
    const g = this.game;
    for (let o = 0; o < this.dragOf.length; o++) {
      const c = this.dragOf[o];
      if (c < 0) continue;
      const r = g.soldiers[o], v = g.soldiers[c];
      if (!r.alive || r.downed || !v || !v.alive || !v.downed) { this.dragOf[o] = -1; if (v) this.dragBy[c] = -1; continue; }
      const d = Math.hypot(v.pos.x - r.pos.x, v.pos.z - r.pos.z);
      if (d < 1.6) {
        // Dragging: the casualty follows a step behind the rescuer.
        const yaw = Math.atan2(r.pos.x - v.pos.x, r.pos.z - v.pos.z);
        v.pos.x = r.pos.x - Math.sin(yaw) * 0.9; v.pos.z = r.pos.z - Math.cos(yaw) * 0.9;
        v.pos.y = g.map.terrain.height(v.pos.x, v.pos.z);
        const cp = v.dragCover;
        if (cp && Math.hypot(cp.x - v.pos.x, cp.z - v.pos.z) < 2.5) {
          this.dragOf[o] = -1; this.dragBy[c] = -1; this.stats.dragsDone++;
          this.downT[c] = Math.min(this.downT[c] + 15, time); // pressure on the wound: more time for the medic
        }
      }
    }
  }

  /** The drag's destination for the rescuer (cover point), written to out. */
  dragGoal(o, out) {
    const c = this.dragOf[o];
    if (c < 0) return false;
    const v = this.game.soldiers[c], r = this.game.soldiers[o];
    if (Math.hypot(v.pos.x - r.pos.x, v.pos.z - r.pos.z) > 1.6) { out[0] = v.pos.x; out[1] = v.pos.z; return true; }
    const cp = v.dragCover;
    out[0] = cp ? cp.x : v.pos.x; out[1] = cp ? cp.z : v.pos.z;
    return true;
  }

  _onKill(attacker, victim) {
    if (!victim) return;
    const q = victim.squad;
    if (q && q.id < 256) this.lossT[q.id].push(this.game.time);
    victim.downed = false;
    if (victim.pow) this._releasePow(victim, 'killed');
    if (this.dragBy[victim.id] >= 0) { this.dragOf[this.dragBy[victim.id]] = -1; this.dragBy[victim.id] = -1; }
    if (this.dragOf[victim.id] >= 0) { this.dragBy[this.dragOf[victim.id]] = -1; this.dragOf[victim.id] = -1; }
    if (this.escortOf[victim.id] >= 0) { this.escortBy[this.escortOf[victim.id]] = -1; this.escortOf[victim.id] = -1; }
    this.job[victim.id] = -1;
    void attacker;
  }

  // ================================================================= POWs

  _weighSurrender(s, q, time) {
    if (time < (s.surrT || 0)) return;
    s.surrT = time + 3;
    const g = this.game, grid = g.ai.grid, ids = this._sids || (this._sids = new Int32Array(96));
    const n = grid.queryRadius(s.pos.x, s.pos.z, 60, ids, 0, g.soldiers.length);
    let mine = 0, theirs = 0, near = 1e9;
    for (let k = 0; k < n; k++) {
      const o = g.soldiers[ids[k]];
      if (!o.alive || o.pow || o.downed) continue;
      if (o.team === s.team) mine += 1; else { theirs += 1; near = Math.min(near, Math.hypot(o.pos.x - s.pos.x, o.pos.z - s.pos.z)); }
    }
    for (const v of g.vehicles.list) if (v.alive && v.occupied && v.team !== s.team && !v.isAircraft && Math.hypot(v.pos.x - s.pos.x, v.pos.z - s.pos.z) < 60) theirs += v.def.armor === 'heavy' ? 3 : 2;
    const F = g.ai.frontline, pocket = F ? F.zoneAt(s.team, s.pos.x, s.pos.z) === 4 : false;
    const escape = pocket ? 0.05 : Math.max(0, Math.min(1, (mine - theirs * 0.5) / 4 + (this.st.coverNode[s.id] >= 0 ? 0.2 : 0)));
    const A = surrenderAnswers({ morale: this.st.morale[s.id], pocket, ratio: theirs / Math.max(1, mine), hp: s.health / 100, escape, bailed: time - (s.bailT || -1e9) < 20, enemyDist: near }, this.A5);
    const D = this.Ds.begin(s.id + 6000, time, 0.3, 1 - s.health / 100);
    D.propose(0, 1); D.next();
    if (D.check(A[0], A[1], A[2], A[3], A[4]) !== 0) { D.none(); this.stats.surrenderDeclined++; return; }
    D.choose(0);
    this.surrender(s, time, `morale ${this.st.morale[s.id].toFixed(2)}, ${theirs}:${mine} local odds${pocket ? ', encircled' : ''}`);
  }

  surrender(s, time, why) {
    const g = this.game;
    s.pow = 1; this.powT[s.id] = time; this.capX[s.id] = s.pos.x; this.capZ[s.id] = s.pos.z; this.capTeam[s.id] = 1 - s.team;
    s.weaponIdx = 0;
    if (s.ai) { s.ai.target = null; s.ai.hasGoal = false; s.ai.state = 'surrendered'; }
    // Hands up: nobody keeps him as a target.
    for (const o of g.soldiers) if (o.ai && o.ai.target === s) { o.ai.target = null; o.ai.targetVisible = false; }
    this.pows.push(s.id);
    this.stats.surrenders++;
    this.note(`${this._who(s)} drops his weapon and surrenders (${why})`);
    // Morale: captors near gain, his side near loses.
    for (const q of this.squads) {
      if (q.id >= 256 || Math.hypot(q.cx - s.pos.x, q.cz - s.pos.z) > 150) continue;
      this.morale[q.id] = Math.max(0, Math.min(1, this.morale[q.id] + (q.team === s.team ? POW_MORALE_LOSER : POW_MORALE_CAPTOR)));
      this.stats.powMorale++;
    }
    // Overrun: prisoners taken in a capture volume count for the captors for a minute.
    for (const f of g.capture.flags) if (Math.hypot(f.x - s.pos.x, f.z - s.pos.z) < 40) { f.powBonus = f.powBonus || [0, 0]; f.powBonusT = time; f.powBonus[1 - s.team] += 0.5; }
  }

  _releasePow(s, why) {
    const i = this.pows.indexOf(s.id);
    if (i >= 0) this.pows.splice(i, 1);
    const e = this.escortBy[s.id];
    if (e >= 0) { this.escortOf[e] = -1; this.escortBy[s.id] = -1; }
    s.pow = 0;
    void why;
  }

  /** Escort duty for soldier o: the prisoner he takes back (Q1–Q6 at the moment of capture), or -1. */
  escortJob(o, out) {
    const g = this.game, p = this.escortOf[o];
    if (p >= 0) {
      const v = g.soldiers[p];
      if (!v || !v.alive || v.pow !== 1) { this.escortOf[o] = -1; return -1; }
      const dst = this._delivery(v);
      if (out && dst) { out[0] = dst.x; out[1] = dst.z; }
      return p;
    }
    const s = g.soldiers[o];
    if (!this.pows.length || s.pow || s.downed || s.role === Role.OPERATOR) return -1;
    for (const id of this.pows) {
      const v = g.soldiers[id];
      if (!v || v.team === s.team || v.pow !== 1 || this.escortBy[id] >= 0) continue;
      if (Math.hypot(v.pos.x - s.pos.x, v.pos.z - s.pos.z) > 40) continue;
      // One riflemen per prisoner, not in a close fight.
      const D = this.Ds.begin(o + 7000, g.time, 0.5, this.st.suppression[o]);
      D.propose(0, 1); D.next();
      if (D.check(true, true, this.st.suppression[o] < 0.4 ? 1 : 0.2, !!this._delivery(v), s.health > 30) !== 0) { D.none(); continue; }
      D.choose(0);
      this.escortOf[o] = id; this.escortBy[id] = o;
      this.note(`${this._who(s)} takes ${this._who(v)} prisoner and escorts him toward ${this._delivery(v)?.name || 'the rear'}`);
      const dst = this._delivery(v);
      if (out && dst) { out[0] = dst.x; out[1] = dst.z; }
      return id;
    }
    return -1;
  }

  /** Where a prisoner is taken: the captors' nearest checkpoint, HQ supply zone or rear flag. */
  _delivery(p) {
    const g = this.game, team = this.capTeam[p.id];
    if (p._dst && g.time - p._dstT < 10) return p._dst;
    let best = null, bd = 1e12;
    if (g.logistics) for (const L of g.logistics.locations) {
      if (g.logistics.owner(L) !== team || (L.tier !== SiteTier.CHECKPOINT && L.tier !== SiteTier.HQ)) continue;
      const d = (L.x - p.pos.x) ** 2 + (L.z - p.pos.z) ** 2;
      if (d < bd) { bd = d; best = { x: L.x, z: L.z, name: L.name }; }
    }
    for (const f of g.capture.flags) {
      // Any flag the captors hold that is not being fought over right now.
      if (f.owner !== team || f.contestedBy >= 0) continue;
      const d = (f.x - p.pos.x) ** 2 + (f.z - p.pos.z) ** 2;
      if (d < bd) { bd = d; best = { x: f.x, z: f.z, name: f.name }; }
    }
    p._dst = best; p._dstT = g.time;
    return best;
  }

  _powsTick(dt, time) {
    const g = this.game;
    for (let k = this.pows.length - 1; k >= 0; k--) {
      const s = g.soldiers[this.pows[k]];
      if (!s || !s.alive) { this.pows.splice(k, 1); continue; }
      const a = s.ai;
      if (a) { a.target = null; a.fireMode = 0; }
      const e = this.escortBy[s.id];
      if (e >= 0) {
        const es = g.soldiers[e];
        // Walks ahead of his escort toward the delivery point.
        const dst = this._delivery(s);
        if (dst && a) {
          a.hasGoal = true;
          const yaw = Math.atan2(dst.x - es.pos.x, dst.z - es.pos.z);
          a.goalX = es.pos.x + Math.sin(yaw) * 3; a.goalZ = es.pos.z + Math.cos(yaw) * 3;
          if (Math.hypot(dst.x - s.pos.x, dst.z - s.pos.z) < 22) this._deliver(s, dst, time);
        }
      } else if (a) a.hasGoal = false;
      // Abandoned for 3 minutes (nobody took him back): he walks off and rejoins his side.
      if (time - this.powT[s.id] > 180 && e < 0) { this._releasePow(s, 'released'); s.weaponIdx = 0; }
    }
  }

  _deliver(s, dst, time) {
    const g = this.game, captor = this.capTeam[s.id], B = g.ai.board;
    this.stats.powDelivered++;
    // Field intel harvest: his side's hidden minefields, fortifications and mortar teams near where he was taken
    // become verified observations of the captors (and the mines are revealed to them).
    let revealed = 0;
    const cx = this.capX[s.id], cz = this.capZ[s.id];
    for (let i = 0; i < this.mineN; i++) {
      if (this.mteam[i] !== s.team || Math.hypot(this.mx[i] - cx, this.mz[i] - cz) > 500) continue;
      if (!(this.mknown[i] & (1 << captor))) { this.mknown[i] |= 1 << captor; revealed++; if (g.nav.stampMine) g.nav.stampMine(captor, this.mx[i], this.mz[i], 4, 1); }
    }
    for (const t of this.sites) if (t.team === s.team && !t.dead && Math.hypot(t.x - cx, t.z - cz) < 500) { B.observe(captor, 90000 + t.id, 0, t.x, t.z, 0, 0, -2, time); B.observe(captor, 90000 + t.id, 0, t.x, t.z, 0, 0, -3, time); revealed++; }
    for (const m of g.soldiers) if (m.alive && m.team === s.team && m.role === Role.MORTAR && Math.hypot(m.pos.x - cx, m.pos.z - cz) < 600) { B.observe(captor, m.id, 0, m.pos.x, m.pos.z, 0, 0, -2, time); B.observe(captor, m.id, 0, m.pos.x, m.pos.z, 0, 0, -3, time); revealed++; }
    this.stats.intelHarvests++; this.stats.intelRevealed += revealed;
    this.note(`prisoner ${this._who(s)} delivered to ${dst.name}: field intel harvest — ${revealed} minefields / fortifications / mortar teams now verified observations`);
    this._releasePow(s, 'delivered');
    // Off the battlefield (back to his side's reinforcement pool).
    s.pow = 2;
    g.combat.kill(s, null, 0, 0, 0, 'CAPTURED');
    s.pow = 0;
  }
}
