import { AgentStateBuffers } from './agent-state.ts';
import { TacticalRadioBus } from './radio-bus.ts';
import { CoverField, FoliageField } from './terrain-analysis.ts';
import {
  AI_TUNING, Archetype, ARCHETYPE_OF, Formation, Logistics, Posture, RadioType, SoldierClass, hash01,
} from './types.ts';
import type { AgentLike, FlagLike, GameLike, SoldierLike, VehicleLike } from './types.ts';

const MAX_MEMBERS = 8;
const MAX_CONTACTS = 12;
export const SquadKind = { INFANTRY: 0, CREW: 1 } as const;

/** Shared tactical picture of one fire team. */
export class SquadBlackboard {
  readonly id: number;
  readonly team: number;
  readonly kind: number;
  readonly members = new Int32Array(MAX_MEMBERS).fill(-1);
  count = 0;
  leader = -1;
  objective: FlagLike | null = null;
  objectiveTime = -100;
  defensive = false;
  posture: number = Posture.ASSAULT;
  postureTime = 0;
  rallyX = 0; rallyZ = 0;
  /** Alive, dismounted centroid and heading toward the objective. */
  cx = 0; cz = 0; heading = 0; alive = 0; dismounted = 0;
  // Contacts (known enemies): target index, last known position, time, threat weight.
  readonly cTarget = new Int32Array(MAX_CONTACTS).fill(-1);
  readonly cX = new Float32Array(MAX_CONTACTS);
  readonly cY = new Float32Array(MAX_CONTACTS);
  readonly cZ = new Float32Array(MAX_CONTACTS);
  readonly cT = new Float32Array(MAX_CONTACTS);
  readonly cThreat = new Float32Array(MAX_CONTACTS);
  // Bounding overwatch / flanking.
  boundTeam = 0; boundUntil = 0;
  flankTeam = 1; flankX = 0; flankZ = 0; flankUntil = 0;
  /** Vehicle id the squad is mounted in / boarding (-1 none). */
  vehicle = -1;
  suppressionAvg = 0; ammoAvg = 1;
  nextFireMission = 0; nextCas = 0; nextLogistics = 0; nextExtract = 0; nextSmoke = 0;

  constructor(id: number, team: number, kind: number) { this.id = id; this.team = team; this.kind = kind; }

  addMember(soldierId: number): boolean {
    if (this.count >= MAX_MEMBERS) return false;
    this.members[this.count++] = soldierId;
    return true;
  }

  removeMember(soldierId: number): void {
    for (let i = 0; i < this.count; i++) {
      if (this.members[i] !== soldierId) continue;
      this.members[i] = this.members[--this.count];
      this.members[this.count] = -1;
      return;
    }
  }

  /** Records / refreshes a contact. */
  addContact(target: number, x: number, y: number, z: number, time: number, threat: number): void {
    let slot = -1, oldest = 0, oldestT = 1e9;
    for (let i = 0; i < MAX_CONTACTS; i++) {
      if (this.cTarget[i] === target) { slot = i; break; }
      if (this.cTarget[i] < 0) { if (oldestT > -1) { oldest = i; oldestT = -1; } continue; }
      if (this.cT[i] < oldestT) { oldestT = this.cT[i]; oldest = i; }
    }
    if (slot < 0) slot = oldest;
    this.cTarget[slot] = target; this.cX[slot] = x; this.cY[slot] = y; this.cZ[slot] = z; this.cT[slot] = time;
    this.cThreat[slot] = threat;
  }

  forgetContact(target: number): void {
    for (let i = 0; i < MAX_CONTACTS; i++) if (this.cTarget[i] === target) this.cTarget[i] = -1;
  }

  /** Number of contacts younger than `maxAge`; writes their weighted centroid to out. */
  contactCentroid(time: number, maxAge: number, out: Float32Array): number {
    let n = 0, sx = 0, sz = 0, sw = 0;
    for (let i = 0; i < MAX_CONTACTS; i++) {
      if (this.cTarget[i] < 0 || time - this.cT[i] > maxAge) continue;
      const w = this.cThreat[i];
      sx += this.cX[i] * w; sz += this.cZ[i] * w; sw += w; n++;
    }
    if (sw > 0) { out[0] = sx / sw; out[1] = sz / sw; }
    return n;
  }

  clearTransient(): void {
    this.cTarget.fill(-1);
    this.posture = Posture.ASSAULT; this.vehicle = -1; this.objective = null; this.objectiveTime = -100;
  }
}

/** A road column of ground vehicles that shares a destination. */
export class ConvoyGroup {
  readonly id: number;
  team = 0;
  active = false;
  readonly vehicles = new Int32Array(8).fill(-1);
  count = 0;
  formation: number = Formation.COLUMN;
  formationUntil = 0;
  destX = 0; destZ = 0;
  contactUntil = 0;
  drillDone = false;
  speedCap = 0;
  constructor(id: number) { this.id = id; }
}

/** Hooks into the vehicle orchestrator used by convoy drills (avoids an import cycle). */
export interface ConvoyHooks {
  popSmoke(v: VehicleLike): void;
  dismountPassengers(v: VehicleLike): number;
  scanSky(v: VehicleLike): void;
}

/** Convoy order: vanguard → main body → air umbrella → logistics. */
const ROLE_RANK = new Float32Array([0, 0, 0.5, 1, 1, 3, 3, 9, 9, 2.5, 2, 9, 9, 9, 9]);
const CLASS_LEAD_ORDER = [SoldierClass.LEADER, SoldierClass.SPOTTER, SoldierClass.RIFLEMAN, SoldierClass.SUPPORT, SoldierClass.AT, SoldierClass.CREWMAN, SoldierClass.PILOT];

const _c2 = new Float32Array(2);
const CONVOY_KEYS = new Float32Array(8);

/**
 * Real-time squad and convoy formation:
 * - squads formed at spawn from class templates; leaders re-elected; broken
 *   squads merged into nearby fire teams; objectives chosen and spread;
 *   posture switches (assault / bounding overwatch / flank / regroup / hold);
 *   squads raise fire missions, CAS, logistics and extraction requests.
 * - convoys assembled from ground vehicles sharing a corridor, ordered by role,
 *   speed-matched in column, switching to wedge with an ambush drill on contact.
 */
export class SquadAndConvoyManager {
  readonly squads: SquadBlackboard[] = [];
  readonly convoys: ConvoyGroup[] = [];
  /** Convoy id per vehicle (-1 none). */
  readonly convoyOf: Int32Array;
  hooks: ConvoyHooks | null = null;
  private readonly game: GameLike;
  private readonly st: AgentStateBuffers;
  private readonly radio: TacticalRadioBus;
  private readonly cover: CoverField;
  private readonly foliage: FoliageField;
  private squadPhase = 0;
  private mergeTimer = 0;
  private convoyTimer = 0;
  private convoyTickTimer = 0;

  constructor(game: GameLike, st: AgentStateBuffers, radio: TacticalRadioBus, cover: CoverField, foliage: FoliageField) {
    this.game = game; this.st = st; this.radio = radio; this.cover = cover; this.foliage = foliage;
    this.convoyOf = new Int32Array(game.vehicles.list.length).fill(-1);
    for (let i = 0; i < 12; i++) this.convoys.push(new ConvoyGroup(i));
    // Infantry fire teams follow the class template order; crews group separately.
    for (let team = 0; team < 2; team++) {
      let inf: SquadBlackboard | null = null, crew: SquadBlackboard | null = null;
      for (const s of game.soldiers) {
        if (s.team !== team) continue;
        const isCrew = s.cls === SoldierClass.CREWMAN || s.cls === SoldierClass.PILOT;
        if (isCrew) {
          if (!crew || crew.count >= 6) { crew = new SquadBlackboard(this.squads.length, team, SquadKind.CREW); this.squads.push(crew); }
          this.join(s, crew);
        } else {
          if (!inf || (inf.count >= 6 && s.cls === SoldierClass.LEADER)) {
            inf = new SquadBlackboard(this.squads.length, team, SquadKind.INFANTRY);
            inf.defensive = this.squads.filter((q) => q.team === team && q.kind === SquadKind.INFANTRY).length % 4 === 2;
            this.squads.push(inf);
          }
          if (!this.join(s, inf)) { inf = new SquadBlackboard(this.squads.length, team, SquadKind.INFANTRY); this.squads.push(inf); this.join(s, inf); }
        }
      }
    }
  }

  private join(s: SoldierLike, q: SquadBlackboard): boolean {
    if (!q.addMember(s.id)) return false;
    if (s.squad && s.squad !== q) (s.squad as SquadBlackboard).removeMember(s.id);
    s.squad = q;
    const k = q.count - 1;
    this.st.slot[s.id] = k;
    this.st.fireteam[s.id] = k % 2;
    return true;
  }

  squadOf(s: SoldierLike): SquadBlackboard | null { return s.squad as SquadBlackboard | null; }

  reset(): void {
    for (const q of this.squads) q.clearTransient();
    for (const c of this.convoys) { c.active = false; c.count = 0; }
    this.convoyOf.fill(-1);
  }

  /** @param dt frame time */
  update(dt: number, agents: (AgentLike | null)[]): void {
    const time = this.game.time;
    // Squads: 4 Hz, staggered by squad id.
    const n = this.squads.length;
    const perFrame = Math.max(1, Math.ceil(n * AI_TUNING.squadHz * dt));
    for (let k = 0; k < perFrame; k++) {
      this.squadPhase = (this.squadPhase + 1) % n;
      this.tickSquad(this.squads[this.squadPhase], time);
    }
    this.mergeTimer -= dt;
    if (this.mergeTimer <= 0) { this.mergeTimer = 1; this.mergeBroken(time); }
    this.convoyTimer -= dt;
    if (this.convoyTimer <= 0) { this.convoyTimer = 1 / AI_TUNING.convoyHz; this.formConvoys(agents, time); }
    this.convoyTickTimer -= dt;
    if (this.convoyTickTimer <= 0) { this.convoyTickTimer = 0.25; this.tickConvoys(agents, time); }
  }

  // ------------------------------------------------------------------ squads

  private tickSquad(q: SquadBlackboard, time: number): void {
    const g = this.game, soldiers = g.soldiers;
    // Census, leader election and centroid.
    let alive = 0, dismounted = 0, sx = 0, sz = 0, sup = 0, ammo = 0, leaderValid = false;
    for (let i = 0; i < q.count; i++) {
      const s = soldiers[q.members[i]];
      if (!s.alive) continue;
      alive++;
      sup += this.st.suppression[s.id];
      const w = s.rifle;
      ammo += (w.ammo + w.reserve) / (w.def.mag + w.def.reserve);
      if (s.vehicle) continue;
      dismounted++; sx += s.pos.x; sz += s.pos.z;
      if (s.id === q.leader && !s.isPlayer) leaderValid = true;
    }
    q.alive = alive; q.dismounted = dismounted;
    q.suppressionAvg = alive ? sup / alive : 0;
    q.ammoAvg = alive ? ammo / alive : 1;
    if (dismounted) { q.cx = sx / dismounted; q.cz = sz / dismounted; }
    if (!leaderValid) q.leader = this.electLeader(q);
    if (alive === 0) return;
    if (q.vehicle >= 0) {
      const v = g.vehicles.list[q.vehicle];
      let aboard = 0;
      for (let i = 0; i < q.count; i++) if (soldiers[q.members[i]].vehicle === v) aboard++;
      if (!v.alive || (aboard === 0 && this.st.ticket[q.leader] < 0)) q.vehicle = -1;
    }
    // Objective.
    const o = q.objective;
    const stale = !o || time - q.objectiveTime > 45 || (o.owner === q.team && o.contestedBy < 0 && !q.defensive && time - q.objectiveTime > 6);
    if (stale) this.chooseObjective(q, time);
    if (q.objective) q.heading = Math.atan2(q.objective.x - q.cx, q.objective.z - q.cz);
    if (q.kind === SquadKind.CREW) { q.posture = Posture.DEFEND; return; }

    // Posture.
    const contacts = q.contactCentroid(time, 8, _c2);
    const prev = q.posture;
    if (q.vehicle >= 0 && dismounted < alive) q.posture = Posture.MOUNTED;
    else if (this.radio.inDangerZone(q.team, q.cx, q.cz, 25, time) >= 0) q.posture = Posture.HOLD;
    else if (contacts > 0 && dismounted >= 3) {
      const d = Math.hypot(_c2[0] - q.cx, _c2[1] - q.cz);
      if (prev === Posture.FLANK && time < q.flankUntil) { /* keep flanking */ }
      else if (dismounted >= 4 && (contacts >= 2 || (prev === Posture.BOUND && time - q.postureTime > 14)) && d > 30 && d < 200) {
        this.planFlank(q, _c2[0], _c2[1], time);
        q.posture = Posture.FLANK;
      } else if (d < 220) q.posture = Posture.BOUND;
      else q.posture = Posture.ASSAULT;
    } else if (dismounted > 0 && this.spread(q) > 60) q.posture = Posture.REGROUP;
    else q.posture = q.defensive && q.objective && q.objective.owner === q.team ? Posture.DEFEND : Posture.ASSAULT;
    if (q.posture !== prev) {
      q.postureTime = time;
      if (q.posture === Posture.BOUND) { q.boundTeam = 0; q.boundUntil = time + 7; this.clearArrived(q); }
    }
    // Bounding overwatch: swap the moving fire team once it has reached cover (or timed out).
    if (q.posture === Posture.BOUND) {
      let movers = 0, arrived = 0;
      for (let i = 0; i < q.count; i++) {
        const s = soldiers[q.members[i]];
        if (!s.alive || s.vehicle || this.st.fireteam[s.id] !== q.boundTeam) continue;
        movers++; if (this.st.arrived[s.id]) arrived++;
      }
      if (time > q.boundUntil || (movers > 0 && arrived >= movers)) {
        q.boundTeam = 1 - q.boundTeam; q.boundUntil = time + 7; this.clearArrived(q);
      }
    }
    if (q.posture === Posture.FLANK) {
      let fl = 0, there = 0;
      for (let i = 0; i < q.count; i++) {
        const s = soldiers[q.members[i]];
        if (!s.alive || s.vehicle || this.st.fireteam[s.id] !== q.flankTeam) continue;
        fl++; if ((s.pos.x - q.flankX) ** 2 + (s.pos.z - q.flankZ) ** 2 < 100) there++;
      }
      if (fl === 0 || there * 2 >= fl || time > q.flankUntil) { q.posture = Posture.BOUND; q.postureTime = time; q.boundTeam = q.flankTeam; q.boundUntil = time + 7; }
    }
    if (dismounted) { q.rallyX = contacts > 0 ? q.cx - Math.sin(q.heading) * 25 : q.cx; q.rallyZ = contacts > 0 ? q.cz - Math.cos(q.heading) * 25 : q.cz; }
    this.raiseRequests(q, contacts, time);
  }

  private electLeader(q: SquadBlackboard): number {
    const soldiers = this.game.soldiers;
    for (let c = 0; c < CLASS_LEAD_ORDER.length; c++) {
      for (let i = 0; i < q.count; i++) {
        const s = soldiers[q.members[i]];
        if (s.alive && !s.isPlayer && s.cls === CLASS_LEAD_ORDER[c]) return s.id;
      }
    }
    for (let i = 0; i < q.count; i++) if (!soldiers[q.members[i]].isPlayer) return q.members[i];
    return q.members[0];
  }

  private spread(q: SquadBlackboard): number {
    const soldiers = this.game.soldiers;
    let worst = 0;
    for (let i = 0; i < q.count; i++) {
      const s = soldiers[q.members[i]];
      if (!s.alive || s.vehicle) continue;
      const d = Math.hypot(s.pos.x - q.cx, s.pos.z - q.cz);
      if (d > worst) worst = d;
    }
    return worst;
  }

  private clearArrived(q: SquadBlackboard): void {
    for (let i = 0; i < q.count; i++) this.st.arrived[q.members[i]] = 0;
  }

  private chooseObjective(q: SquadBlackboard, time: number): void {
    const flags = this.game.capture.flags;
    let best: FlagLike | null = null, bestScore = 1e9;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      const mine = f.owner === q.team;
      const contested = f.contestedBy >= 0 && f.contestedBy !== q.team;
      let score = Math.hypot(f.x - q.cx, f.z - q.cz) * (0.75 + hash01(q.id * 31 + i, Math.floor(time / 30)) * 0.5);
      if (q.kind === SquadKind.CREW) score = mine && f.base ? 0 : score + 500;
      else if (q.defensive) { if (!mine) score += 260; else if (!contested) score += 120; }
      else if (mine && !contested) score += 900;
      for (let k = 0; k < this.squads.length; k++) {
        const o = this.squads[k];
        if (o !== q && o.team === q.team && o.objective === f && o.kind === SquadKind.INFANTRY) score += 70;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    q.objective = best;
    q.objectiveTime = time;
  }

  /** Picks the flank side with the most concealment and cover along it. */
  private planFlank(q: SquadBlackboard, ex: number, ez: number, time: number): void {
    let dx = ex - q.cx, dz = ez - q.cz;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const reach = Math.min(40, d * 0.7);
    let bestX = ex, bestZ = ez, bestScore = -1e9;
    for (let side = -1; side <= 1; side += 2) {
      const fx = ex - dz * side * reach - dx * 12, fz = ez + dx * side * reach - dz * 12;
      const mx = (q.cx + fx) / 2, mz = (q.cz + fz) / 2;
      if (this.game.nav.blocked(fx, fz)) continue;
      let s = this.foliage.at(mx, mz) + this.foliage.at(fx, fz) * 0.5;
      s += Math.min(6, this.cover.grid.query(fx, fz, 14, SCRATCH_IDS)) * 0.08;
      if (this.radio.inDangerZone(q.team, fx, fz, 10, time) >= 0) s -= 2;
      s += hash01(q.id, side + 7) * 0.05;
      if (s > bestScore) { bestScore = s; bestX = fx; bestZ = fz; }
    }
    q.flankX = bestX; q.flankZ = bestZ; q.flankUntil = time + 22;
    // The fire team with fewer members pins; the larger one flanks.
    q.flankTeam = 1;
  }

  /** Combined-arms requests raised by the squad as a whole. */
  private raiseRequests(q: SquadBlackboard, contacts: number, time: number): void {
    const leader = q.leader;
    let spotter = false;
    for (let i = 0; i < q.count; i++) {
      const s = this.game.soldiers[q.members[i]];
      if (s.alive && s.cls === SoldierClass.SPOTTER && !s.vehicle) { spotter = true; break; }
    }
    if (contacts >= 2 && q.suppressionAvg > 0.45 && time > q.nextFireMission) {
      q.contactCentroid(time, 8, _c2);
      const y = this.game.map.terrain.height(_c2[0], _c2[1]);
      if (this.radio.publish(RadioType.FIRE_MISSION, q.team, leader, q.id, _c2[0], y, _c2[1], -1, 2, time, 0, spotter)) q.nextFireMission = time + 25;
    }
    if (contacts >= 4 && time > q.nextCas) {
      q.contactCentroid(time, 8, _c2);
      const y = this.game.map.terrain.height(_c2[0], _c2[1]);
      const m = this.radio.publish(RadioType.CAS_REQUEST, q.team, leader, q.id, _c2[0], y, _c2[1], -1, 1, time, 0, spotter);
      if (m) { m.vx = _c2[0] - q.cx; m.vz = _c2[1] - q.cz; q.nextCas = time + 30; }
    }
    if (q.ammoAvg < 0.3 && time > q.nextLogistics) {
      if (this.radio.publish(RadioType.LOGISTICS_REQUEST, q.team, leader, q.id, q.cx, 0, q.cz, -1, 1, time, Logistics.AMMO)) q.nextLogistics = time + 30;
    }
    if (q.dismounted > 0 && q.dismounted <= 2 && contacts >= 2 && time > q.nextExtract) {
      const f = this.nearestFriendlyFlag(q);
      if (!f || Math.hypot(f.x - q.cx, f.z - q.cz) > 140) {
        if (this.radio.publish(RadioType.EXTRACT_REQUEST, q.team, leader, q.id, q.cx, 0, q.cz, -1, 1, time)) q.nextExtract = time + 60;
      }
    }
  }

  nearestFriendlyFlag(q: SquadBlackboard): FlagLike | null {
    const flags = this.game.capture.flags;
    let best: FlagLike | null = null, bd = 1e12;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f.owner !== q.team) continue;
      const d = (f.x - q.cx) ** 2 + (f.z - q.cz) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  /** Merges the survivors of broken squads into nearby fire teams with room. */
  private mergeBroken(time: number): void {
    const soldiers = this.game.soldiers;
    for (let a = 0; a < this.squads.length; a++) {
      const q = this.squads[a];
      if (q.kind !== SquadKind.INFANTRY || q.vehicle >= 0 || q.dismounted === 0 || q.dismounted > 2 || q.count - q.alive < 2) continue;
      let best: SquadBlackboard | null = null, bd = 90 * 90;
      for (let b = 0; b < this.squads.length; b++) {
        const o = this.squads[b];
        if (o === q || o.team !== q.team || o.kind !== SquadKind.INFANTRY || o.dismounted < 2 || o.count + q.dismounted > MAX_MEMBERS) continue;
        const d = (o.cx - q.cx) ** 2 + (o.cz - q.cz) ** 2;
        if (d < bd) { bd = d; best = o; }
      }
      if (!best) continue;
      for (let i = q.count - 1; i >= 0; i--) {
        const s = soldiers[q.members[i]];
        if (!s.alive || s.vehicle || s.isPlayer) continue;
        this.join(s, best);
      }
      best.objectiveTime = Math.min(best.objectiveTime, time);
    }
  }

  // ------------------------------------------------------------------ convoys

  private formConvoys(agents: (AgentLike | null)[], time: number): void {
    const list = this.game.vehicles.list;
    // Drop finished members.
    for (let ci = 0; ci < this.convoys.length; ci++) {
      const c = this.convoys[ci];
      if (!c.active) continue;
      for (let i = c.count - 1; i >= 0; i--) {
        const v = list[c.vehicles[i]];
        const a = v.driver ? agents[v.driver.id] : null;
        if (!v.alive || !a || a.holdVehicle) this.removeFromConvoy(c, i);
      }
      if (c.count < 2) this.dissolve(c);
    }
    // Group idle candidates by team and destination corridor.
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (this.convoyOf[v.id] >= 0 || !this.eligible(v, agents)) continue;
      const a = agents[(v.driver as SoldierLike).id] as AgentLike;
      let c: ConvoyGroup | null = null;
      for (let j = 0; j < list.length; j++) {
        const w = list[j];
        if (w === v || w.team !== v.team || !this.eligible(w, agents)) continue;
        const b = agents[(w.driver as SoldierLike).id] as AgentLike;
        if ((a.driveX - b.driveX) ** 2 + (a.driveZ - b.driveZ) ** 2 > 120 * 120) continue;
        if ((v.pos.x - w.pos.x) ** 2 + (v.pos.z - w.pos.z) ** 2 > 160 * 160) continue;
        const existing = this.convoyOf[w.id];
        if (existing >= 0) { c = this.convoys[existing]; if (c.count >= 8) c = null; break; }
        c = this.newConvoy(v.team, a.driveX, a.driveZ);
        if (!c) break;
        this.addToConvoy(c, w);
        break;
      }
      if (c) this.addToConvoy(c, v);
    }
    for (let ci = 0; ci < this.convoys.length; ci++) if (this.convoys[ci].active) this.orderConvoy(this.convoys[ci]);
  }

  private eligible(v: VehicleLike, agents: (AgentLike | null)[]): boolean {
    if (!v.alive || v.def.kind !== 'ground' || !v.driver || v.driver.isPlayer) return false;
    const arch = ARCHETYPE_OF[v.def.type];
    if (arch === Archetype.MLRS || arch === Archetype.HOWITZER || arch === Archetype.SAM) return false;
    const a = agents[v.driver.id];
    return !!a && !a.holdVehicle;
  }

  private newConvoy(team: number, x: number, z: number): ConvoyGroup | null {
    for (let ci = 0; ci < this.convoys.length; ci++) {
      const c = this.convoys[ci];
      if (c.active) continue;
      c.active = true; c.team = team; c.count = 0; c.formation = Formation.COLUMN; c.destX = x; c.destZ = z;
      c.contactUntil = 0; c.drillDone = false;
      return c;
    }
    return null;
  }

  private addToConvoy(c: ConvoyGroup, v: VehicleLike): void {
    if (this.convoyOf[v.id] >= 0 || c.count >= 8) return;
    c.vehicles[c.count++] = v.id;
    this.convoyOf[v.id] = c.id;
  }

  private removeFromConvoy(c: ConvoyGroup, i: number): void {
    this.convoyOf[c.vehicles[i]] = -1;
    for (let k = i; k < c.count - 1; k++) c.vehicles[k] = c.vehicles[k + 1];
    c.vehicles[--c.count] = -1;
  }

  private dissolve(c: ConvoyGroup): void {
    for (let i = 0; i < c.count; i++) this.convoyOf[c.vehicles[i]] = -1;
    c.count = 0; c.active = false;
  }

  /** Insertion sort by role rank, then by distance to the destination (keys in a scratch array). */
  private orderConvoy(c: ConvoyGroup): void {
    const list = this.game.vehicles.list, keys = CONVOY_KEYS;
    for (let i = 0; i < c.count; i++) {
      const v = list[c.vehicles[i]];
      keys[i] = ROLE_RANK[ARCHETYPE_OF[v.def.type]] * 1000 + Math.hypot(v.pos.x - c.destX, v.pos.z - c.destZ);
    }
    for (let i = 1; i < c.count; i++) {
      const id = c.vehicles[i], k = keys[i];
      let j = i - 1;
      while (j >= 0 && keys[j] > k) { c.vehicles[j + 1] = c.vehicles[j]; keys[j + 1] = keys[j]; j--; }
      c.vehicles[j + 1] = id; keys[j + 1] = k;
    }
  }

  private tickConvoys(agents: (AgentLike | null)[], time: number): void {
    const list = this.game.vehicles.list;
    for (let ci = 0; ci < this.convoys.length; ci++) {
      const c = this.convoys[ci];
      if (!c.active || c.count < 2) continue;
      // Contact: any crew with a visible enemy within 220 m.
      let contact = false;
      for (let i = 0; i < c.count && !contact; i++) {
        const v = list[c.vehicles[i]];
        for (let s = 0; s < v.seats.length; s++) {
          const o = v.seats[s];
          const a = o ? agents[o.id] : null;
          if (a && a.target && a.targetVisible && (a.target.pos.x - v.pos.x) ** 2 + (a.target.pos.z - v.pos.z) ** 2 < 220 * 220) { contact = true; break; }
        }
      }
      if (contact) {
        if (time > c.contactUntil) c.drillDone = false;
        c.contactUntil = time + 20;
      }
      const engaged = time < c.contactUntil;
      c.formation = engaged ? Formation.WEDGE : Formation.COLUMN;
      if (engaged && !c.drillDone && this.hooks) {
        // Ambush drill: vanguard smokes, air defence scans, carriers dismount to flank.
        c.drillDone = true;
        this.hooks.popSmoke(list[c.vehicles[0]]);
        for (let i = 0; i < c.count; i++) {
          const v = list[c.vehicles[i]], arch = ARCHETYPE_OF[v.def.type];
          if (arch === Archetype.SPAAG) this.hooks.scanSky(v);
          if (arch === Archetype.APC || arch === Archetype.IFV) this.hooks.dismountPassengers(v);
        }
      }
      let cap = 1e9;
      for (let i = 0; i < c.count; i++) cap = Math.min(cap, list[c.vehicles[i]].def.maxSpeed);
      c.speedCap = cap * (engaged ? 0.6 : 0.8);
    }
  }

  /**
   * Overrides a convoy follower's destination with its formation slot and
   * matches its speed to the vehicle ahead; caps the leader to the slowest
   * member. Called by the vehicle orchestrator after the crew controller.
   */
  applySlot(v: VehicleLike, a: AgentLike): void {
    const ci = this.convoyOf[v.id];
    if (ci < 0) return;
    const c = this.convoys[ci];
    if (!c.active) return;
    const list = this.game.vehicles.list;
    let idx = 0;
    for (let i = 0; i < c.count; i++) if (c.vehicles[i] === v.id) { idx = i; break; }
    if (idx === 0) { a.speedCap = Math.min(a.speedCap, c.speedCap); c.destX = a.driveX; c.destZ = a.driveZ; return; }
    const lead = list[c.vehicles[0]], ahead = list[c.vehicles[idx - 1]];
    const spacing = AI_TUNING.convoySpacing;
    let tx: number, tz: number, gap: number;
    if (c.formation === Formation.COLUMN) {
      const h = ahead.yaw;
      tx = ahead.pos.x - Math.sin(h) * spacing; tz = ahead.pos.z - Math.cos(h) * spacing;
      gap = Math.hypot(ahead.pos.x - v.pos.x, ahead.pos.z - v.pos.z);
    } else {
      const h = lead.yaw, rank = Math.ceil(idx / 2), side = idx % 2 === 1 ? 1 : -1;
      const lat = 14 * rank * side, back = c.formation === Formation.WEDGE ? 12 * rank : 0;
      const cs = Math.cos(h), sn = Math.sin(h);
      // Leader frame: +X left = (cos h, -sin h), forward = (sin h, cos h).
      tx = lead.pos.x + cs * lat - sn * back; tz = lead.pos.z - sn * lat - cs * back;
      gap = spacing + Math.hypot(tx - v.pos.x, tz - v.pos.z) * ((tx - v.pos.x) * Math.sin(v.yaw) + (tz - v.pos.z) * Math.cos(v.yaw) > 0 ? 1 : -1);
    }
    a.driveX = tx; a.driveZ = tz; a.holdVehicle = false;
    const leadSpeed = Math.max(0, lead.speed);
    a.speedCap = Math.max(2, Math.min(v.def.maxSpeed, leadSpeed + (gap - spacing) * 0.35));
  }
}

const SCRATCH_IDS = new Int32Array(64);
