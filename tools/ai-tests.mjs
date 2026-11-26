// Headless unit tests for the AI core (Node strips the TypeScript types natively).
// Run with `npm test` (after the simulation smoke test) or `node tools/ai-tests.mjs`.
import { SpatialGrid } from '../src/ai/spatial-grid.ts';
import { TacticalRadioBus } from '../src/ai/radio-bus.ts';
import { AgentStateBuffers } from '../src/ai/agent-state.ts';
import { VehicleOrchestrator } from '../src/ai/vehicle-orchestrator.ts';
import { ConvoyGroup, SquadAndConvoyManager, SquadKind } from '../src/ai/squad-convoy.ts';
import { MsgState, RadioType, SeatRole, SoldierClass, TicketState, rand, hash01 } from '../src/ai/types.ts';

let failures = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); if (!ok) failures++; };

// ---------------------------------------------------------------- spatial grid
{
  const grid = new SpatialGrid(1024, 32, 600);
  const st = new Uint32Array([12345]);
  const xs = [], zs = [];
  grid.begin();
  for (let i = 0; i < 600; i++) { xs.push((rand(st, 0) - 0.5) * 1000); zs.push((rand(st, 0) - 0.5) * 1000); grid.insert(i, xs[i], zs[i]); }
  grid.finish();
  const out = new Int32Array(600);
  let ok = true;
  for (let q = 0; q < 50 && ok; q++) {
    const x = (rand(st, 0) - 0.5) * 1000, z = (rand(st, 0) - 0.5) * 1000, r = 20 + rand(st, 0) * 120;
    const n = grid.queryRadius(x, z, r, out);
    const got = new Set(Array.from(out.subarray(0, n)));
    for (let i = 0; i < 600; i++) {
      const inside = (xs[i] - x) ** 2 + (zs[i] - z) ** 2 <= r * r;
      if (inside !== got.has(i)) { ok = false; break; }
    }
  }
  check('grid radius query matches brute force', ok);
  const n = grid.queryRadius(0, 0, 400, out, 100, 200);
  check('grid id-range filter', Array.from(out.subarray(0, n)).every((id) => id >= 100 && id < 200));
}

// ---------------------------------------------------------------- radio bus
{
  const radio = new TacticalRadioBus(16, 10);
  const heard = [];
  radio.subscribe(RadioType.AIR_THREAT, { onRadio: (m) => heard.push(m.id) });
  const a = radio.publish(RadioType.CAS_REQUEST, 0, 1, 0, 100, 0, 100, -1, 2, 0);
  check('radio publishes a CAS ticket', a !== null && a.state === MsgState.OPEN);
  const again = radio.publish(RadioType.CAS_REQUEST, 0, 1, 0, 400, 0, 400, -1, 2, 1);
  check('per-sender cooldown suppresses repeats', again === null);
  const dup = radio.publish(RadioType.CAS_REQUEST, 0, 2, 0, 120, 0, 110, 7, 3, 1);
  check('nearby duplicate refreshes the open ticket', dup === a && a.targetIdx === 7 && a.priority === 3 && radio.openCount(RadioType.CAS_REQUEST, 0) === 1);
  const team = radio.publish(RadioType.CAS_REQUEST, 0, 3, 0, 600, 0, 600, -1, 1, 2);
  check('per-team cooldown gates new tickets', team === null);
  radio.publish(RadioType.AIR_THREAT, 0, 4, 0, 0, 50, 0, 3, 3, 2);
  check('listeners receive their message type', heard.length === 1);
  const c1 = radio.claim(RadioType.CAS_REQUEST, 0, 50, 0, 0, 1000, 3);
  const c2 = radio.claim(RadioType.CAS_REQUEST, 0, 51, 0, 0, 1000, 3);
  check('claims are exclusive', c1 === a && c2 === null && radio.holds(c1, 50, a.id) && !radio.holds(c1, 51, a.id));
  radio.release(c1);
  check('released ticket can be re-claimed', radio.claim(RadioType.CAS_REQUEST, 0, 51, 0, 0, 1000, 4) === a);
  radio.update(4 + 51);
  check('abandoned / expired tickets are recycled', a.state === MsgState.FREE);
  const out = radio.claim(RadioType.CAS_REQUEST, 1, 60, 0, 0, 1000, 60);
  check('claims respect team', out === null);
  radio.addDangerZone(0, 10, 10, 20, 70, 60);
  check('danger-close zone hit / miss', radio.inDangerZone(0, 15, 12, 0, 61) >= 0 && radio.inDangerZone(0, 80, 80, 0, 61) < 0 && radio.inDangerZone(1, 15, 12, 0, 61) < 0);
  check('danger zone expires', radio.inDangerZone(0, 15, 12, 0, 71) < 0);
}

// ---------------------------------------------------------------- fixtures
const P = (x, z) => ({ x, y: 0, z });
function fakeSoldier(id, team, cls) {
  return {
    kind: 'soldier', id, team, cls, isPlayer: false, alive: true, name: `s${id}`, pos: P(0, 0), yaw: 0, pitch: 0, health: 100,
    speed: 0, moveX: 0, moveZ: 0, grounded: true, vehicle: null, seat: -1, stance: 0, squad: null,
    rifle: { def: { mag: 30, reserve: 120 }, ammo: 30, reserve: 120, shot: 0 }, weapons: [], launcher: null,
    ai: { nav: { clear() {}, vehicle: false }, hasGoal: false, stuckTotal: 0 },
  };
}
function fakeVehicle(id, type, seats, team = 0) {
  const v = {
    kind: 'vehicle', id, team, alive: true, health: 1000, pos: P(10, 0), vel: P(0, 0), altitude: 0, isAircraft: false,
    def: { type, kind: 'ground', health: 1000, armor: 'light', seats: seats.map((role) => ({ role, pos: [0, 0, 0] })), mounts: [],
      seatMounts: seats.map(() => []), fallbackFrom: seats.map(() => -1), passengers: seats.filter((r) => r === 'passenger').length, maxSpeed: 15 },
    seats: seats.map(() => null), spawn: { x: 10, z: 0, yaw: 0, team, type }, weapons: [], controls: { throttle: 0, steer: 0, brake: false },
    get occupied() { return this.seats.some(Boolean); }, get driver() { return this.seats[0]; },
    enter(s, prefer) { if (this.seats[prefer]) return -1; this.seats[prefer] = s; s.vehicle = this; s.seat = prefer; return prefer; },
    exit(s) { this.seats[s.seat] = null; s.vehicle = null; s.seat = -1; },
  };
  return v;
}

// ---------------------------------------------------------------- seat tickets
{
  const soldiers = [0, 1, 2, 3].map((i) => fakeSoldier(i, 0, SoldierClass.RIFLEMAN));
  const apc = fakeVehicle(0, 'apc', ['driver', 'gunner', 'passenger', 'passenger']);
  const game = { time: 0, soldiers, vehicles: { list: [apc] }, bus: { on() {}, emit() {} } };
  const st = new AgentStateBuffers(soldiers.length, 7);
  const radio = new TacticalRadioBus(8, soldiers.length);
  const orch = new VehicleOrchestrator(game, st, radio, { squads: [], convoyOf: new Int32Array(1).fill(-1) }, null, null, null, null, null);
  const man = orch.manifests[0];
  check('manifest seat roles', man.seatRole[0] === SeatRole.DRIVER && man.seatRole[1] === SeatRole.GUNNER && man.seatRole[2] === SeatRole.PASSENGER);
  const t0 = orch.reserve(soldiers[0], apc, 2, -1, 0);
  const t1 = orch.reserve(soldiers[1], apc, 2, -1, 0);
  check('seat reservation is atomic (one holder per seat)', t0 >= 0 && t1 === -1);
  check('one ticket per soldier', orch.reserve(soldiers[0], apc, 3, -1, 0) === -1);
  check('ticket resolves to its vehicle', orch.ticketVehicle(0) === apc && orch.ticketVehicle(1) === null);
  check('holder boards the reserved seat', orch.tryBoard(soldiers[0]) && apc.seats[2] === soldiers[0] && st.ticket[0] === -1);
  const t2 = orch.reserve(soldiers[1], apc, 3, -1, 0);
  const ttl = orch.tickets[t2].expires;
  game.time = ttl + 0.1;
  orch.sweepTickets(game.time);
  check('tickets expire after their TTL', orch.tickets[t2].state === TicketState.FREE && st.ticket[1] === -1 && man.ticket[3] === -1);
  const t3 = orch.reserve(soldiers[2], apc, 3, -1, game.time);
  soldiers[2].alive = false;
  orch.onSoldierDeath(soldiers[2]);
  check('dead holder releases the seat', orch.tickets[t3].state === TicketState.FREE && man.ticket[3] === -1);
  const t4 = orch.reserve(soldiers[3], apc, 3, -1, game.time);
  orch.onEnter(apc, soldiers[1], 3);
  check('a seat taken directly voids its reservation', orch.tickets[t4].state === TicketState.FREE);
  orch.lock(apc, true);
  check('locking a vehicle cancels its open reservations', orch.activeTickets() === 0 && orch.locked[0] === 1);
}

// ---------------------------------------------------------------- exterior riders, transport memory
{
  const soldiers = [0, 1, 2, 3, 4].map((i) => fakeSoldier(i, 0, SoldierClass.RIFLEMAN));
  const ifv = fakeVehicle(0, 'ifv', ['driver', 'gunner', 'passenger', 'rider', 'rider']);
  const game = { time: 0, soldiers, vehicles: { list: [ifv] }, bus: { on() {}, emit() {} }, map: {} };
  const st = new AgentStateBuffers(soldiers.length, 9);
  const orch = new VehicleOrchestrator(game, st, new TacticalRadioBus(8, soldiers.length), { squads: [], convoyOf: new Int32Array(1).fill(-1) }, null, null, null, null, null);
  const man = orch.manifests[0];
  check('rider positions get their own seat role', man.seatRole[3] === SeatRole.RIDER && man.seatRole[4] === SeatRole.RIDER && man.seatRole[2] === SeatRole.PASSENGER);
  // Squad boarding fills the compartment first, then the deck.
  const q = { id: 0, team: 0 };
  for (let i = 0; i < 3; i++) orch.reservePassenger(soldiers[i], ifv, man, q, 0);
  const roles = [0, 1, 2].map((i) => man.seatRole[orch.tickets[st.ticket[i]].seat]);
  check('passengers fill the compartment before the deck', roles[0] === SeatRole.PASSENGER && roles[1] === SeatRole.RIDER && roles[2] === SeatRole.RIDER);
  check('cargo capacity counts riders', orch.freePassengerSeats(ifv, man) === 0 && orch.pendingPassengerTickets(man) === 3);
  check('no double booking of a rider position', orch.reserve(soldiers[3], ifv, orch.tickets[st.ticket[1]].seat, -1, 0) === -1);
  // A soldier that could not reach its vehicle in time is not sent back to it straight away.
  game.time = 1000;
  orch.sweepTickets(game.time);
  check('timed-out reservations are remembered', orch.stats.expiredTimeout === 3 && orch.noSeatV[0] === 0 && orch.noSeatUntil[0] > game.time);
}

// ---------------------------------------------------------------- partial paths
{
  const { NavState } = await import('../src/systems/navigation.js');
  const nav = new NavState();
  nav.partial = true; nav.len = 3; nav.idx = 3;
  nav.clear();
  check('clearing a path clears its partial flag', nav.partial === false && nav.len === 0);
}

// ---------------------------------------------------------------- squads
{
  const T = [SoldierClass.LEADER, SoldierClass.RIFLEMAN, SoldierClass.AT, SoldierClass.SUPPORT, SoldierClass.RIFLEMAN, SoldierClass.SPOTTER];
  const soldiers = [];
  for (let team = 0; team < 2; team++) {
    for (let i = 0; i < 30; i++) soldiers.push(fakeSoldier(soldiers.length, team, i < 24 ? T[i % 6] : SoldierClass.CREWMAN));
  }
  const game = { time: 0, soldiers, vehicles: { list: [] }, capture: { flags: [] }, bus: { on() {}, emit() {} } };
  const st = new AgentStateBuffers(soldiers.length, 3);
  const mgr = new SquadAndConvoyManager(game, st, new TacticalRadioBus(8, soldiers.length), null, null);
  const inf = mgr.squads.filter((q) => q.kind === SquadKind.INFANTRY), crews = mgr.squads.filter((q) => q.kind === SquadKind.CREW);
  check('fire teams formed from the class template', inf.length === 8 && inf.every((q) => q.count === 6));
  check('one AT gunner per fire team', inf.every((q) => Array.from(q.members.subarray(0, q.count)).filter((id) => soldiers[id].cls === SoldierClass.AT).length === 1));
  check('crews grouped separately', crews.length === 2 && crews.every((q) => Array.from(q.members.subarray(0, q.count)).every((id) => soldiers[id].cls === SoldierClass.CREWMAN)));
  // Break squad 0: four dead, two survivors next to squad 1.
  const a = inf[0], b = inf[1];
  for (let i = 2; i < 6; i++) soldiers[a.members[i]].alive = false;
  a.alive = 2; a.dismounted = 2; a.cx = 0; a.cz = 0;
  b.alive = 6; b.dismounted = 6; b.cx = 20; b.cz = 0; b.count = 6;
  for (const q of inf.slice(2)) { q.cx = 5000; q.cz = 5000; q.dismounted = 6; q.alive = 6; }
  const survivors = [a.members[0], a.members[1]];
  mgr.mergeBroken(0);
  check('broken squad merges into the nearest fire team', survivors.every((id) => soldiers[id].squad === b) && b.count === 8);
}

// ---------------------------------------------------------------- convoy trail
{
  const c = new ConvoyGroup(0);
  for (let x = 0; x <= 60; x += 1) c.record(7, x, 0);        // leader drives east 60 m (points every >= 3 m)
  for (let z = 1; z <= 30; z += 1) c.record(7, 60, z);       // then turns north 30 m
  const out = new Float32Array(2);
  const ok1 = c.trailPoint(60, 30, 20, out) && Math.abs(out[0] - 60) < 0.01 && Math.abs(out[1] - 10) < 1.5;
  const ok2 = c.trailPoint(60, 30, 45, out) && Math.abs(out[1]) < 0.01 && Math.abs(out[0] - 45) < 1.5;
  check('followers get points along the leader\'s actual track (around corners)', ok1 && ok2, JSON.stringify(Array.from(out)));
  check('no trail point beyond the recorded track', !c.trailPoint(60, 30, 200, out));
  c.record(9, 0, 0);
  check('trail restarts when the leader changes', c.trailCount === 1 && !c.trailPoint(0, 0, 10, out));
}

// ---------------------------------------------------------------- positioning
{
  const { terrainLos, planSquadPositions, PositionPlan, PosMode } = await import('../src/ai/positions.ts');
  const { CoverField, FoliageField } = await import('../src/ai/terrain-analysis.ts');
  // Flat ground with a 6 m ridge running along x = 50.
  const terrain = { half: 512, size: 1024, height: (x) => (Math.abs(x - 50) < 4 ? 6 : 0), roadAt: () => 0, inBounds: () => true };
  check('terrain line of sight: blocked by a ridge, clear on open ground',
    !terrainLos(terrain, null, 0, 1.6, 0, 100, 1.6, 0) && terrainLos(terrain, null, 0, 1.6, 0, 0, 1.6, 100));
  const game = { map: { terrain }, nav: { blocked: () => false } };
  const cover = new CoverField([], terrain, () => false);
  const foliage = new FoliageField([], 1024);
  const plan = new PositionPlan();
  const cls = new Uint8Array([SoldierClass.LEADER, SoldierClass.RIFLEMAN, SoldierClass.AT, SoldierClass.SUPPORT, SoldierClass.RIFLEMAN, SoldierClass.SPOTTER]);
  planSquadPositions(game, cover, foliage, PosMode.DEFEND_FLAG, 0, 0, 34, 0, 0, 0, 16, 6, cls, 3, plan);
  let inside = true, spaced = true;
  for (let i = 0; i < 6; i++) {
    const d = Math.hypot(plan.x[i], plan.z[i]);
    if (cls[i] !== SoldierClass.AT && cls[i] !== SoldierClass.SPOTTER && d > 15) inside = false;
    for (let j = 0; j < i; j++) if (Math.hypot(plan.x[i] - plan.x[j], plan.z[i] - plan.z[j]) < 4.9) spaced = false;
  }
  check('flag defence: riflemen inside the capture circle, positions spread out', inside && spaced);
  let facing = true;
  for (let i = 0; i < 6; i++) if (Math.abs(Math.atan2(Math.sin(plan.yaw[i]), Math.cos(plan.yaw[i]))) > 0.6) facing = false;
  check('defenders face the threat axis', facing);
  // A village flag: a house 24 m from the flag with windows on the side facing it. Part of the squad overwatches
  // the flag from inside (window posts facing the flag); the rest still holds the circle.
  {
    const house = { x: 24, z: 0, w: 8, d: 10, rot: 0, type: 'house', state: 0, floors: 1, fh: 3, roof: 'gable',
      openings: [-2.5, 0, 2.5].map((u) => ({ side: 3, u, w: 1.2, y0: 0.95, y1: 2.3, floor: 0, kind: 'window' })) };
    const vcover = new CoverField([], terrain, () => false, -10, [house]);
    const vplan = new PositionPlan();
    planSquadPositions(game, vcover, foliage, PosMode.DEFEND_FLAG, 0, 0, 34, 0, 0, 0, 16, 6, cls, 3, vplan);
    let windows = 0, inCircle = 0, faceFlag = true;
    for (let i = 0; i < 6; i++) {
      const n = vplan.node[i];
      if (n >= 0 && vcover.inside[n]) { windows++; if (Math.abs(Math.atan2(-vplan.x[i], -vplan.z[i]) - vplan.yaw[i]) > 0.5) faceFlag = false; }
      if (Math.hypot(vplan.x[i], vplan.z[i]) < 15) inCircle++;
    }
    check('village defence: some defenders take window posts facing the flag, the rest hold the circle', windows >= 1 && windows <= 3 && inCircle >= 3 && faceFlag, `windows ${windows}, in circle ${inCircle}`);
  }
}

// ---------------------------------------------------------------- capture commitment
{
  const T = [SoldierClass.LEADER, SoldierClass.RIFLEMAN, SoldierClass.AT, SoldierClass.SUPPORT, SoldierClass.RIFLEMAN, SoldierClass.SPOTTER];
  const soldiers = [];
  for (let i = 0; i < 12; i++) soldiers.push(fakeSoldier(i, 0, T[i % 6]));
  const flag = { id: 3, x: 0, y: 0, z: 0, owner: 1, v: 0, base: false };
  const game = { time: 0, soldiers, vehicles: { list: [] }, capture: { flags: [flag] }, bus: { on() {}, emit() {} } };
  const mgr = new SquadAndConvoyManager(game, new AgentStateBuffers(soldiers.length, 4), new TacticalRadioBus(8, soldiers.length), null, null);
  const q = mgr.squads[0];
  const place = (d) => { for (let i = 0; i < q.count; i++) { const m = soldiers[q.members[i]]; m.pos.x = d + i; m.pos.z = 0; } q.cx = d + 2; q.cz = 0; };
  q.objective = flag; q.order = 3; q.axisDone = true; q.vehicle = -1; q.dismounted = q.count; q.alive = q.count;
  place(60);
  mgr.updateCapture(q, 0);
  check('capture: a squad stalled near the flag first counts as approaching', q.capState === 'approaching');
  // 20 s later, no closer, two defenders known at the flag: six attackers go in (final assault) instead of trading shots outside.
  q.cTarget[0] = 5; q.cT[0] = 19; q.cX[0] = 5; q.cZ[0] = 0; q.cTarget[1] = 6; q.cT[1] = 19; q.cX[1] = -5; q.cZ[1] = 0;
  mgr.updateCapture(q, 20);
  check('capture: stalled outside the circle with the numbers → final assault', q.capState === 'final assault' && q.assaultUntil === 60);
  // Outnumbered: pinned (holds and asks for support) rather than rushing.
  q.assaultUntil = 0; q.dismounted = 2; q.capBestT = 0;
  for (let k = 2; k < 5; k++) { q.cTarget[k] = 7 + k; q.cT[k] = 39; q.cX[k] = k; q.cZ[k] = 3; }
  mgr.updateCapture(q, 40);
  check('capture: outnumbered at the flag → pinned, with a reason', q.capState === 'pinned' && /outnumbered/.test(q.capWhy));
  // Inside the radius and the bar moving our way: capturing.
  q.dismounted = q.count; place(2); flag.v = -0.3;
  mgr.updateCapture(q, 45);
  check('capture: members inside the radius → capturing', q.capState === 'capturing');
  // Our flag, defend order: defending.
  flag.owner = 0; q.order = 5;
  mgr.updateCapture(q, 50);
  check('capture: own flag on a defend order → defending', q.capState === 'defending');
}

// ---------------------------------------------------------------- upper floors (stair routes)
{
  const { FloorRoutes } = await import('../src/ai/floors.ts');
  const { createBuilding, buildingParts, K } = await import('../src/world/buildings.js');
  const { CoverField } = await import('../src/ai/terrain-analysis.ts');
  const rng = (() => { let k = 1; return () => ((k = (k * 16807) % 2147483647) / 2147483647); })();
  const house = createBuilding('house', 0, 0, 0, 0.4, rng, { floors: 2, w: 9, d: 10, roof: 'gable' });
  const shed = createBuilding('house', 60, 0, 0, 0, rng, { floors: 1, w: 7, d: 7, roof: 'gable' });
  const nav = { _partial: false, blocked: () => false, findPath: (sx, sz, tx, tz, v, out) => { out[0] = tx; out[1] = tz; return 1; } };
  const game = { time: 0, nav };
  const F = new FloorRoutes(game, [house, shed]);
  const L = F.levels[0];
  check('upper floors: a two-storey house has a usable level with window posts; a one-storey gabled house has none',
    L && L.usable && L.posts.length >= 3 && F.levels[1] === null, `posts ${L && L.posts.length}`);
  // No post (nor any free cell) over the stairwell hole of the flight arriving from below.
  const run = Math.min(house.d - 2 * 0.25 - 1.6, house.fh * 1.75), x0 = -house.w / 2 + 0.25, z0 = -house.d / 2 + 0.25 + 0.6;
  let overHole = 0;
  for (let j = 0; j < L.nz; j++) for (let i = 0; i < L.nx; i++) {
    const x = L.gx0 + (i + 0.5) * 0.4, z = L.gz0 + (j + 0.5) * 0.4;
    if (L.free[j * L.nx + i] && x > x0 && x < x0 + 1.3 && z > z0 && z < z0 + run) overHole++;
  }
  check('upper floors: the stairwell hole is never walkable on the level grid', overHole === 0);
  const s = { pos: { x: 30, y: 0, z: 30 } };
  const a = { s, goalX: 0, goalZ: 0, hasGoal: true, upB: 0, flMode: 0, flB: -1, flPts: new Float32Array(64), flN: 0, flI: 0, flT: 0, flBest: 1e9, flFail: 0, flGX: 0, flGZ: 0, flBadB: -1, flBadUntil: 0 };
  const post = new Float32Array(4); F.postWorld(0, 0, post); a.goalX = post[0]; a.goalZ = post[1];
  const out = new Float32Array(2);
  const far = F.steer(a, out);
  check('upper floors: from outside, the ground grid takes the soldier to the stairs first', far === 2 && a.flMode === 1);
  s.pos.x = out[0]; s.pos.z = out[1];
  const r = F.steer(a, out);
  // Route: beside the ramp foot → foot → top (one storey up the ramp) → … → the post.
  const c = Math.cos(house.rot), sn = Math.sin(house.rot), loc = (x, z) => [(x - house.x) * c - (z - house.z) * sn, (x - house.x) * sn + (z - house.z) * c];
  const pts = []; for (let i = 0; i < a.flN; i++) pts.push(loc(a.flPts[i * 2], a.flPts[i * 2 + 1]));
  const last = pts[pts.length - 1], pl = loc(post[0], post[1]);
  check('upper floors: stair route goes foot → top → post', r === 1 && a.flMode === 2 && pts.length >= 4 &&
    Math.abs(pts[1][0] - L.xm) < 0.01 && Math.abs(pts[2][1] - L.zt) < 0.01 && Math.hypot(last[0] - pl[0], last[1] - pl[1]) < 0.5, JSON.stringify(pts.map((p) => p.map((v) => +v.toFixed(1)))));
  // Up there: a goal outside the building sends the soldier back down the stairs to the ground grid.
  s.pos.x = post[0]; s.pos.z = post[1]; s.pos.y = house.fh; a.flMode = 0; a.flB = 0;
  a.goalX = 40; a.goalZ = 40; a.upB = -1;
  const d = F.steer(a, out);
  const dl = loc(a.flPts[(a.flN - 1) * 2], a.flPts[(a.flN - 1) * 2 + 1]);
  check('upper floors: leaving goes back down the stairs and out at the approach point', d === 1 && a.flMode === 3 && Math.hypot(dl[0] - L.ax, dl[1] - L.az) < 0.01);
  // Destruction: damaged keeps the floor (routes rebuilt), ruined removes the level; cover nodes follow.
  const cover = new CoverField([], { height: () => 0, size: 1024 }, () => false, -10, [house, shed], F);
  const up = Array.from({ length: cover.count }, (_, i) => i).filter((i) => cover.floor[i]);
  check('upper floors: cover field carries the level posts at storey height', up.length === L.posts.length && Math.abs(cover.levelHeight(up[0]) - house.fh) < 0.05);
  house.state = 1; const dmg = F.ok(0) && cover.valid(up[0]);
  house.state = 2; const ruined = !F.ok(0) && !cover.valid(up[0]);
  house.state = 0;
  check('upper floors: level survives damage, is gone when the building is ruined', dmg && ruined && F.ok(0));
  // A level whose stairs cannot be reached from outside on the ground grid is left out.
  const cut = createBuilding('house', 0, 0, 0, 0, rng, { floors: 2, w: 9, d: 10, roof: 'gable' });
  const F2 = new FloorRoutes({ time: 0, nav: { _partial: false, blocked: () => false, findPath: () => 0 } }, [cut]);
  check('upper floors: unreachable stairs → no upper level', !F2.ok(0) && F2.stats.noApproach === 1);
  void buildingParts; void K;
}

// ---------------------------------------------------------------- convoy journeys
{
  const vs = [0, 1, 2].map((i) => fakeVehicle(i, 'truck', ['driver', 'passenger'], 0));
  vs[0].pos = P(0, 0); vs[1].pos = P(20, 0); vs[2].pos = P(-20, 0);
  const game = { time: 0, soldiers: [], vehicles: { list: vs }, capture: { flags: [] }, bus: { on() {}, emit() {} }, map: {} };
  const mgr = new SquadAndConvoyManager(game, new AgentStateBuffers(1, 1), new TacticalRadioBus(8, 1), null, null);
  const keys = [7, 7, 9];
  mgr.hooks = { taskKey: (v) => keys[v.id], purpose: () => '', popSmoke() {}, dismountPassengers: () => 0, scanSky() {} };
  check('convoys: same destination → same journey', mgr.sameJourney(vs[0], 500, 0, vs[2], 560, 40));
  check('convoys: same job, nearby but different positions (200 m apart) → same journey', mgr.sameJourney(vs[0], 500, 100, vs[1], 500, -100));
  check('convoys: different jobs 200 m apart → not a convoy (no proximity-only convoys)', !mgr.sameJourney(vs[0], 500, 100, vs[2], 500, -100));
  check('convoys: same job but destinations 300 m apart → separate trips', !mgr.sameJourney(vs[0], 500, 150, vs[1], 500, -150));
  check('convoys: same job, opposite directions → separate trips', !mgr.sameJourney(vs[0], 120, 0, vs[1], -100, 0));
}

// ---------------------------------------------------------------- post-dismount rally
{
  const soldiers = [0, 1, 2, 3].map((i) => fakeSoldier(i, 0, SoldierClass.RIFLEMAN));
  const truck = fakeVehicle(0, 'truck', ['driver', 'passenger', 'passenger', 'passenger']);
  truck.pos = P(0, 0); truck.yaw = 0; truck.def.half = [1.3, 1.5, 3.5];
  const game = { time: 50, soldiers, vehicles: { list: [truck] }, bus: { on() {}, emit() {} }, map: {}, nav: { blocked: () => false } };
  const q = { id: 0, team: 0, order: 1, destX: 200, destZ: 0, destR: 10, axisDone: true, vehicle: 0, count: 3, members: new Int32Array([1, 2, 3]) };
  const orch = new VehicleOrchestrator(game, new AgentStateBuffers(4, 2), new TacticalRadioBus(8, 4), { squads: [q], convoyOf: new Int32Array(1).fill(-1) }, null, null, null, null, null);
  const man = orch.manifests[0]; man.squadId = 0;
  for (let i = 1; i <= 3; i++) { soldiers[i].squad = q; soldiers[i].ai = { target: null }; truck.enter(soldiers[i], i); }
  const n = orch.dismountPassengers(truck);
  // Truck faces +z; the goal is to the east (+x): rally on the right side, clear of the hull and of its path.
  check('dismount: everyone out, rally beside the vehicle toward the goal, vehicle holds a moment',
    n === 3 && q.dropT === 50 && q.dropX > 1.3 + 5 && Math.abs(q.dropZ) < 0.01 && man.unloadUntil > 50 && q.vehicle === -1, `${q.dropX},${q.dropZ}`);
  // Threat on the right: rally on the left instead.
  for (let i = 1; i <= 3; i++) truck.enter(soldiers[i], i);
  q.vehicle = 0; man.squadId = 0; game.time = 80;
  soldiers[1].ai = { target: { kind: 'soldier', launcher: null }, lastSeenX: 80, lastSeenZ: 0 };
  orch.dismountPassengers(truck);
  check('dismount: rally on the side away from the threat', q.dropX < -1.3 - 5, `${q.dropX}`);
}

// ---------------------------------------------------------------- Milestone 2: observations (dedupe / clustering)
{
  const { ObservationBoard, ObsCat } = await import('../src/ai/intel.ts');
  const B = new ObservationBoard(16, 35);
  const r1 = B.observe(0, 7, ObsCat.INFANTRY, 100, 100, 0, 0, 1, 10);
  const r2 = B.observe(0, 7, ObsCat.INFANTRY, 102, 101, 0, 0, 2, 10.5);
  const r3 = B.observe(0, 7, ObsCat.INFANTRY, 101, 99, 0, 0, 3, 11);
  check('observations: one enemy seen by three soldiers is one record with three observers',
    r1 === r2 && r2 === r3 && B.estimatedCount(r1) === 1 && B.obsN[r1] === 3 && B.confidence(r1, 11) > B.confidence(B.observe(0, 50, ObsCat.INFANTRY, -400, 0, 0, 0, 1, 11), 11));
  const r4 = B.observe(0, 8, ObsCat.INFANTRY, 125, 110, 0, 0, 1, 12);
  const r5 = B.observe(0, 9, ObsCat.INFANTRY, 220, 100, 0, 0, 1, 12);
  const r6 = B.observe(0, 10, ObsCat.ARMOUR, 100, 100, 0, 0, 1, 12);
  const r7 = B.observe(1, 7, ObsCat.INFANTRY, 100, 100, 0, 0, 40, 12);
  check('observations: a second enemy within 35 m joins the cluster; farther, another category or the other side do not',
    r4 === r1 && B.estimatedCount(r1) === 2 && r5 !== r1 && r6 !== r1 && r7 !== r1 && B.strengthNear(0, 110, 100, 60, 12) === 2 + 3, `${B.estimatedCount(r1)}`);
  check('observations: one radio report per cluster per 20 s',
    B.shouldReport(r1, 12, 20) && !B.shouldReport(r1, 17, 20) && !B.shouldReport(r1, 31, 20) && B.shouldReport(r1, 33, 20));
}

// ---------------------------------------------------------------- Milestone 2: frontline grid
{
  const { FrontlineGrid, Zone } = await import('../src/ai/frontline.ts');
  // 1 km × 1 km test island, 10 × 10 cells; optionally a strait (water) at 400–500 m east of the west edge.
  const world = (strait) => ({ size: 1000, landmassAt: (x) => (strait && x > -100 && x < 0 ? 0 : strait && x >= 0 ? 2 : 1), forest: () => 0, road: () => 0, slope: () => 0 });
  const tick = (F, fn) => { F.begin(); fn(); F.end(); };
  const F = new FrontlineGrid(world(false), 100);
  const hq = () => { F.setHq(0, -450, 0); F.setHq(1, 450, 0); F.emit(0, -450, 0, 8); F.emit(1, 450, 0, 8); };
  tick(F, hq);
  const W = F.index(-450, 0), E = F.index(450, 0);
  check('frontline: each HQ holds its side as secure rear, a contested front between them',
    F.owner(W) === 0 && F.owner(E) === 1 && F.zone[0][W] === Zone.SECURE_REAR && F.zone[1][E] === Zone.SECURE_REAR && F.counts.contested[0] > 0 && F.counts.pocket[0] === 0,
    `contested ${F.counts.contested[0]}`);
  // Marching Squares: the iso-0 contour runs north–south between the HQs, every segment endpoint where the
  // interpolated field crosses zero.
  let segOk = F.segN > 0;
  const fAt = (x, z) => { // bilinear over cell centres
    const gx = (x + 500) / 100 - 0.5, gz = (z + 500) / 100 - 0.5, x0 = Math.floor(gx), z0 = Math.floor(gz), tx = gx - x0, tz = gz - z0;
    const v = (a, b) => F.field[Math.min(9, Math.max(0, b)) * 10 + Math.min(9, Math.max(0, a))];
    return (v(x0, z0) * (1 - tx) + v(x0 + 1, z0) * tx) * (1 - tz) + (v(x0, z0 + 1) * (1 - tx) + v(x0 + 1, z0 + 1) * tx) * tz;
  };
  for (let k = 0; k < F.segN; k++) for (let e = 0; e < 2; e++) {
    const x = F.seg[k * 4 + e * 2], z = F.seg[k * 4 + e * 2 + 1];
    if (Math.abs(x) > 200 || Math.abs(fAt(x, z)) > 0.05) segOk = false;
  }
  check('frontline: marching-squares contour sits on the zero crossing between the sides', segOk, `${F.segN} segments`);
  // Rear-area breach: Pampalona spots three Torsa soldiers deep behind its lines.
  tick(F, () => { hq(); F.observed(0, -350, 100, 3, false); });
  const bi = F.index(-350, 100);
  check('frontline: enemy observed deep in our rear is a REAR_AREA_BREACH (and the worst one is tracked)',
    F.zone[0][bi] === Zone.REAR_AREA_BREACH && F.worstBreach.cell[0] === bi && F.worstBreach.strength[0] === 3 && F.counts.breach[0] === 1);
  // Encircled pocket: a Pampalona garrison east of a Torsa line that spans the island north to south.
  tick(F, () => { hq(); for (let z = -450; z <= 450; z += 100) F.emit(1, -50, z, 3); F.emit(0, 150, 0, 8); });
  const pi = F.index(150, 0);
  check('frontline: our ground cut off from our HQ by enemy territory is an ENCIRCLED_POCKET',
    F.owner(pi) === 0 && F.zone[0][pi] === Zone.ENCIRCLED_POCKET && F.counts.pocket[0] > 0 && F.zone[0][W] === Zone.SECURE_REAR,
    `pocket ${F.counts.pocket[0]}`);
  let pocketSeg = 0; for (let k = 0; k < F.segN; k++) if (F.segFlag[k] === 2) pocketSeg++;
  check('frontline: pockets get their own outline segments', pocketSeg >= 4, `${pocketSeg}`);
  // Water stops propagation: across the strait, nothing of Pampalona's reaches.
  const G = new FrontlineGrid(world(true), 100);
  tick(G, () => { G.setHq(0, -450, 0); G.emit(0, -450, 0, 8); });
  const east = G.index(250, 0), shore = G.index(-150, 0);
  check('frontline: influence never crosses water (other landmass stays neutral)',
    G.land[G.index(-50, 0)] === 0 && G.owner(shore) === 0 && G.owner(east) === -1 && G.field[east] === 0);
}

// ---------------------------------------------------------------- Milestone 2: capture rate and 3:1 rule
{
  const { captureRate, capturePhase, forceTerm, CapPhase, CAP_POWER } = await import('../src/systems/capture-rate.js');
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  check('capture: force term 0.75 lone rifleman … 1.45 combined-arms assault',
    near(forceTerm(1, false), 0.75) && forceTerm(4, false) > 0.75 && near(forceTerm(10, true), 1.45) && near(forceTerm(30, true), 1.45));
  check('capture: pocket +0.40, deep rear −0.45 (floor 0.35)',
    near(captureRate(1, false, 0.4, -1), 1.15) && near(captureRate(1, false, -0.45, -1), 0.35) && near(captureRate(4, false, -0.45, -1), forceTerm(4, false) - 0.45));
  check('capture: defences −0.10 each (cap −0.30), unsupplied +0.10, while neutralizing',
    near(captureRate(1, false, 0, 2), 0.55) && near(captureRate(10, true, 0, 7), 1.15) && near(captureRate(1, false, 0, 0), 0.85));
  check('capture: R_cap clamped to 0.35 … 2.50',
    near(captureRate(1, false, -0.45, 3), 0.35) && captureRate(30, true, 0.4, 0) <= 2.5 && near(captureRate(30, true, 0.4, 0), 1.95));
  const o = { phase: 0, team: -1 };
  const ph = (p0, p1, owner, v) => { capturePhase(p0, p1, owner, v, o); return [o.phase, o.team]; };
  const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
  check('capture: two phases (neutralize the owner, then secure from neutral)',
    eq(ph(0, 1, 0, -1), [CapPhase.NEUTRALIZING, 1]) && eq(ph(0, 1, -1, 0.2), [CapPhase.SECURING, 1]) && eq(ph(2, 0, 1, 0.5), [CapPhase.NEUTRALIZING, 0]) && eq(ph(0, 1, 1, 1), [CapPhase.IDLE, -1]));
  check('capture: below 3:1 both sides present pauses (CONTESTED); at 3:1 the stronger side OVERRUNS',
    eq(ph(2, 1, 0, -1), [CapPhase.CONTESTED, -1]) && eq(ph(1, 2.9, 0, -1), [CapPhase.CONTESTED, -1]) && eq(ph(1, 3, 0, -1), [CapPhase.OVERRUN, 1]) &&
    eq(ph(CAP_POWER.heavy, CAP_POWER.rifleman, 1, 1), [CapPhase.OVERRUN, 0]));
}

// ---------------------------------------------------------------- Milestone 3: supply economy
{
  const { SiteTier, TIER_BY_FLAG, capacityFor, needsResupply, resupplyPriority, CRATE_USES, useCrate, stockFor, stockFrac, boxSize, mostDepleted, TRUCK_CRATES, truckClassOf, routeRisk, escortsWanted, fuelBurn } = await import('../src/ai/logistics.ts');
  check('supply: HQs unlimited; outposts > depots > towns > villages > checkpoints, scaled by footprint',
    capacityFor(SiteTier.HQ, 80) === Infinity && capacityFor(SiteTier.OUTPOST, 45) === 120 && capacityFor(SiteTier.OUTPOST, 95) === 180 &&
    capacityFor(SiteTier.DEPOT, 60) >= 100 && capacityFor(SiteTier.DEPOT, 60) <= 140 && capacityFor(SiteTier.TOWN, 90) <= 90 &&
    capacityFor(SiteTier.VILLAGE, 50) <= 50 && capacityFor(SiteTier.CHECKPOINT, 45) === 15 &&
    TIER_BY_FLAG.BRAVO === SiteTier.OUTPOST && TIER_BY_FLAG.KILO === SiteTier.DEPOT && TIER_BY_FLAG.MIKE === SiteTier.TOWN && TIER_BY_FLAG.NOVEMBER === SiteTier.VILLAGE);
  check('supply: below 35 % a location signals; nearer the front and emptier asks harder',
    needsResupply(30, 100) && !needsResupply(36, 100) && !needsResupply(5, Infinity) &&
    resupplyPriority(10, 100, 100) > resupplyPriority(10, 100, Infinity) && resupplyPriority(5, 100, 400) > resupplyPriority(30, 100, 400));
  let u = CRATE_USES, uses = 0; while (u > 0) { u = useCrate(u); uses++; }
  check('crates: ten charges, then empty', CRATE_USES === 10 && uses === 10 && useCrate(0) === 0);
  const tank = stockFor('cannon125', Infinity), pods = stockFor('rockets80', 20);
  check('vehicles: finite stowage (belt / single-chamber guns finite loaded, magazines finite reserve); lamps unlimited',
    tank[0] === 40 && tank[1] === 0 && pods[0] === 20 && pods[1] === 20 && stockFor('lamp', Infinity) === null && stockFrac(10, 0, 40, 0) === 0.25);
  const b762 = boxSize('7.62MM'), b125 = boxSize('125MM'), b300 = boxSize('300MM');
  check('throws: ammunition box scales with the depleted caliber; the most depleted weapon decides',
    b762[0] < b125[0] && b125[0] < b300[0] && b300[1] > b762[1] && mostDepleted([0.9, 0.2, 0.5], ['7.62MM', '125MM', null]) === 1);
  check('trucks: OST 40 crates, CST / AT-CST 20', TRUCK_CRATES[truckClassOf('ost')] === 40 && TRUCK_CRATES[truckClassOf('supply')] === 20 && TRUCK_CRATES[truckClassOf('atcst')] === 20 && truckClassOf('mbt') === -1);
  const risk = routeRisk((x) => (x > 100 && x < 300 ? 2 : 1), 0, 0, 500, 0);
  check('OST: route risk from contested cells; at least one escort, more with risk / urgency (max 3)',
    risk > 0 && routeRisk(() => 1, 0, 0, 500, 0) === 0 && escortsWanted(0, 3) === 1 && escortsWanted(6, 3) === 3 && escortsWanted(0, 8) === 2 && escortsWanted(99, 9) === 3);
  check('fuel: burns faster at speed than idling', fuelBurn(20, 20, 1) > fuelBurn(0, 20, 1) * 10);
  // Weapon-state stock limits (vehicle weapons).
  const { WeaponState } = await import('../src/entities/weapons.js');
  const w = new WeaponState('cannon125'); w.limit(40, 0);
  for (let i = 0; i < 31; i++) { w.cooldown = 0; w.consume(); }
  const frac = w.stockFrac; w.restock(1);
  check('vehicles: a 125 mm gun runs dry and is restocked in full by a resupply', Math.abs(frac - 9 / 40) < 1e-6 && w.ammo === 40 && w.stockFrac === 1);
}

// ---------------------------------------------------------------- Milestone 3: roles, triad, classification
{
  const { Role, roleFor, roleWeapon, can, Cap, repairCeiling, SQUAD_ROLES, SF_TEAMS, classifySquad, SquadClass, SKIN_SF_B, SKIN_MORTAR_B, ROLE_COUNT } = await import('../src/ai/roles.ts');
  const seen = new Set(); for (const t of SQUAD_ROLES) for (const r of t) seen.add(r);
  const [, , sfA] = roleFor(16 * 6 + 2, 1, 17 * 6), [, skB, sfB] = roleFor(15 * 6 + 2, 1, 17 * 6);
  check('roles: all twelve roles fielded (squad templates + crews + special forces), the player squad is a line squad',
    ROLE_COUNT === 12 && seen.size + 2 === 12 && roleFor(200, 5, 60)[0] === Role.OPERATOR && roleFor(1, 1, 60)[0] === Role.SOLDIER && roleFor(3, 3, 60)[0] === Role.MEDIC);
  check('special forces: two named teams per faction, the last two infantry squads, distinct skins',
    SF_TEAMS.torsa[0] === 'Spetkrill' && SF_TEAMS.torsa[1] === 'TSB Omega Group' && SF_TEAMS.pampalona[0] === 'Alpha Force' && SF_TEAMS.pampalona[1] === 'Viper Team-8' &&
    sfA === 1 && sfB === 0 && skB === Role.SF && roleFor(16 * 6, 0, 17 * 6)[1] === SKIN_SF_B);
  check('mortar team: gunner and ammunition bearer wear different kit', roleFor(4 * 6 + 1, 1, 60)[1] === Role.MORTAR && roleFor(4 * 6 + 3, 3, 60)[1] === SKIN_MORTAR_B);
  check('role weapons: marksman SVD, engineer RPK-16, breacher shotgun, SF suppressed carbine',
    roleWeapon(Role.MARKSMAN, 1) === 'svd' && roleWeapon(Role.ENGINEER, 1) === 'rpk16' && roleWeapon(Role.BREACHER, 1) === 'saiga12' && roleWeapon(Role.SF, 1) === 'vss' && roleWeapon(Role.SOLDIER, 1) === null);
  check('triad gates: sapper mines / MG nest / wheel patch only; engineer trenches / barracks / checkpoints; mechanic full repairs',
    can(Role.SAPPER, Cap.MINES) && can(Role.SAPPER, Cap.SMALL_TURRET) && !can(Role.SAPPER, Cap.TRENCH) && !can(Role.SAPPER, Cap.FULL_REPAIR) &&
    can(Role.ENGINEER, Cap.TRENCH) && can(Role.ENGINEER, Cap.CHECKPOINT) && can(Role.ENGINEER, Cap.BARRACKS) && !can(Role.ENGINEER, Cap.MINES) &&
    can(Role.MECHANIC, Cap.FULL_REPAIR) && !can(Role.MECHANIC, Cap.TRENCH) && can(Role.MEDIC, Cap.HEAL) && !can(Role.SOLDIER, Cap.HEAL));
  check('repairs: sappers patch wheeled vehicles to 60 % only, never tracks; mechanics anything to full',
    repairCeiling(Role.SAPPER, false) === 0.6 && repairCeiling(Role.SAPPER, true) === 0 && repairCeiling(Role.MECHANIC, true) === 1 && repairCeiling(Role.SOLDIER, false) === 0);
  const F = (o) => ({ vehicle: '', paradrop: false, scouts: 0, operators: 0, members: 6, water: false, elevation: 10, slope: 0.1, ...o });
  const C = (o) => classifySquad(F(o));
  check('classification: all nine classes from the squad\'s facts',
    C({}) === SquadClass.LIGHT && C({ vehicle: 'truck' }) === SquadClass.MOTORIZED && C({ vehicle: 'ifv' }) === SquadClass.MECHANIZED &&
    C({ vehicle: 'mbt', operators: 3 }) === SquadClass.ARMORED && C({ vehicle: 'brdm', scouts: 1 }) === SquadClass.CAVALRY &&
    C({ vehicle: 'transportplane', paradrop: true }) === SquadClass.AIRBORNE && C({ vehicle: 'transportheli' }) === SquadClass.AIRMOBILE &&
    C({ vehicle: 'ifv2', water: true }) === SquadClass.MARINE && C({ elevation: 60 }) === SquadClass.ALPINE && C({ slope: 0.5 }) === SquadClass.ALPINE);
  check('classification: organic evolution (IFV lost → light infantry; boards a helicopter → airmobile)',
    C({ vehicle: 'ifv' }) === SquadClass.MECHANIZED && C({ vehicle: '' }) === SquadClass.LIGHT && C({ vehicle: 'transportheli' }) === SquadClass.AIRMOBILE);
}

// ---------------------------------------------------------------- Milestone 3: morale, surrender, drag, baiting, rearguards
{
  const E = await import('../src/ai/emergent.ts');
  const calm = { casualties: 0, artillery: 0, flanked: 0, armour: 0, helicopter: 0, pocket: false, leader: true, cover: true, medic: true, suppression: 0 };
  const hit = { ...calm, casualties: 3, artillery: 1, flanked: 1, leader: false, cover: false, medic: false, suppression: 0.8 };
  check('morale: bands STEADY ≥ 0.55 > SHAKEN ≥ 0.25 > PANIC; losses, artillery and flanking drain it, leaders / cover / medics restore it',
    E.moraleBand(0.6) === 0 && E.moraleBand(0.3) === 1 && E.moraleBand(0.1) === 2 && E.moraleRate(hit) < -0.1 && E.moraleRate(calm) > 0 && E.moraleRate({ ...calm, armour: 1, flanked: 1, leader: false, cover: false, medic: false }) > -0.04);
  check('panic: bounded 4–8 s by temperament, recovery to at least 0.30 (SHAKEN) with immunity — never a loop',
    E.panicDuration(1) === 4 && E.panicDuration(0) === 8 && E.PANIC_RECOVER >= 0.25 && E.moraleBand(E.PANIC_RECOVER) === 1 && E.PANIC_IMMUNE > E.PANIC_MAX);
  const A = new Float32Array(5);
  const pass = (a) => a[0] >= 0.5 && a[1] >= 0.5 && a[2] >= 0.5 && a[3] >= 0.5 && a[4] >= 0.5;
  const base = { morale: 0.1, pocket: true, ratio: 4, hp: 0.8, escape: 0.05, bailed: false, enemyDist: 30 };
  check('surrender: broken, trapped 3:1 in a pocket with an enemy close → yes; steady, an escape, or nobody to surrender to → no',
    pass(E.surrenderAnswers(base, A)) && !pass(E.surrenderAnswers({ ...base, morale: 0.5 }, A)) && !pass(E.surrenderAnswers({ ...base, escape: 0.6 }, A)) &&
    !pass(E.surrenderAnswers({ ...base, enemyDist: 200 }, A)) && pass(E.surrenderAnswers({ ...base, pocket: false, ratio: 2.5, hp: 0.2 }, A)));
  const drag = { exposed: true, dist: 12, suppression: 0.1, crossing: 0.6, smoke: true, coverDist: 8, hp: 0.9, taken: false };
  check('buddy drag: exposed casualty + smoke makes the crossing worth it; without smoke under heavy fire it is not',
    pass(E.dragAnswers(drag, A)) && !pass(E.dragAnswers({ ...drag, smoke: false, crossing: 1, suppression: 0.8 }, A)) && !pass(E.dragAnswers({ ...drag, exposed: false }, A)) && !pass(E.dragAnswers({ ...drag, taken: true }, A)));
  const B2 = new Float32Array(2);
  E.feintAnswers(0.9, 0.8, 1, true, 1, B2); const f1 = [B2[0], B2[1]];
  E.feintAnswers(0.1, 0.2, 3, true, 0, B2); const f2 = [B2[0], B2[1]];
  check('bait tier 1: an enemy holding a strong angle makes the frontal push lose (Q3) and the suppress-and-flank win (Q4)', f1[0] < 0.5 && f1[1] > 0.5 && f2[0] > f1[0]);
  E.lureAnswers(false, 1, 0.5, B2); const l1 = [B2[0], B2[1]];
  E.lureAnswers(true, 0, 0, B2);
  check('bait tier 2: a scout that cannot penetrate rejects the slugfest and lures onto friendly AT / mines', l1[0] < 0.5 && l1[1] > 0.5 && B2[0] > 0.5 && B2[1] < 0.5);
  E.flagBaitAnswers(18, 35, 0.9, 1.2, true, B2); const b1 = [B2[0], B2[1]];
  E.flagBaitAnswers(Infinity, 35, 0.9, 1.2, true, B2);
  check('bait tier 3: a QRF due before the 35 s capture in the open → leave the flag, ambush perimeter; no QRF → take the ring',
    b1[0] < 0.5 && b1[1] > 0.5 && B2[0] > 0.9 && B2[1] < 0.5 && E.etaTo(0, 0, 0, 5, 0, 100) === 20 && E.etaTo(0, 0, 0, -5, 0, 100) === Infinity);
  const R = new Float32Array(6);
  const best = (v) => { E.rearguardScores(v, R); let b = 0; for (let i = 1; i < 6; i++) if (R[i] > R[b]) b = i; return b; };
  const rv = { exposure: 0.2, garrisonEta: 30, burden: 0.1, retreat: 0.1, visibility: 1, vehicle: false, tall: false, enemyAssets: false };
  check('rearguards from five variables: fresh & safe → blitz; battered & exposed → garrison; tall + exposed → rooftop; retreat memory at night → empty-flag ambush',
    best(rv) === E.Rearguard.BLITZ && best({ ...rv, burden: 0.9, exposure: 0.9, garrisonEta: Infinity }) === E.Rearguard.GARRISON &&
    best({ ...rv, tall: true, exposure: 0.9, burden: 0.5 }) === E.Rearguard.ROOFTOP && best({ ...rv, retreat: 1, exposure: 1, visibility: 0, burden: 0.7 }) === E.Rearguard.EMPTY_AMBUSH);
  check('CQB: dense multi-storey ground with tight walls → stacked entry; open village street → none',
    E.cqbFactor(0.5, 6, false, 8) > 0.5 && E.cqbFactor(0.14, 2, false, 4) < 0.5 && E.cqbFactor(0.3, 1, true, 10) > 0.5);
  check('scorched earth: only withdrawing at ≥ 3:1 with something to deny and someone to do it',
    pass(E.scorchedAnswers(true, 3, 4, 2, A)) && !pass(E.scorchedAnswers(true, 1.5, 4, 2, A)) && !pass(E.scorchedAnswers(true, 3, 0, 2, A)) && !pass(E.scorchedAnswers(false, 3, 4, 2, A)));
}

// ---------------------------------------------------------------- determinism
{
  const s1 = new Uint32Array([42]), s2 = new Uint32Array([42]);
  let same = true;
  for (let i = 0; i < 100; i++) if (rand(s1, 0) !== rand(s2, 0)) same = false;
  check('seeded RNG is deterministic', same && hash01(3, 4) === hash01(3, 4) && hash01(3, 4) !== hash01(4, 3));
}

process.exit(failures ? 1 : 0);
