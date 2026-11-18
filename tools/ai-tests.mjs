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
}

// ---------------------------------------------------------------- determinism
{
  const s1 = new Uint32Array([42]), s2 = new Uint32Array([42]);
  let same = true;
  for (let i = 0; i < 100; i++) if (rand(s1, 0) !== rand(s2, 0)) same = false;
  check('seeded RNG is deterministic', same && hash01(3, 4) === hash01(3, 4) && hash01(3, 4) !== hash01(4, 3));
}

process.exit(failures ? 1 : 0);
