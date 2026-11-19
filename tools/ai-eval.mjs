// Repeatable AI evaluation: runs accelerated bots-only battles on a built game
// (any dist/ directory, so an older build can be measured the same way) with a
// seeded Math.random, and reports decision-quality metrics rather than
// kills or flags: assignment consistency, idle squads, unit stealing between
// operations, transport deliveries, vehicle usefulness and navigation,
// operation outcomes, and the AI's cost per frame.
//
// Usage: node tools/ai-eval.mjs [distDir=dist] [seconds=600] [seeds=1,2] [--json out.json]
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
const dist = path.resolve(args[0] || 'dist');
const seconds = +(args[1] || 600);
const seeds = (args[2] || '1,2').split(',').map(Number);
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((q, r) => {
  const rel = decodeURIComponent(q.url.split('?')[0]);
  const f = path.join(dist, rel === '/' ? 'index.html' : rel);
  if (!f.startsWith(dist) || !fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  r.end(fs.readFileSync(f));
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

const results = [];
for (const seed of seeds) {
  const page = await browser.newPage({ viewport: { width: 640, height: 300 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Seeded randomness before any game module runs (works for older builds too).
  await page.addInitScript((seed) => {
    let s = seed >>> 0;
    Math.random = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }, seed * 7919 + 13);
  await page.goto(`http://localhost:${port}/?q=low&simseed=${seed}`);
  await page.waitForFunction(() => window.__game && window.__game.mode === 'menu', null, { timeout: 120000 });
  await page.evaluate(() => {
    const g = window.__game;
    g.stop(); g.render.render = () => {};
    const S = g.soldiers.length;
    const M = window.__m = {
      t0: g.time, samples: 0, idleSquadSamples: 0, squadSamples: 0, objChanges: 0, flips: 0, opSteals: 0, opLeavesInContact: 0,
      deliveries: 0, deliveredNear: 0, boardEvents: 0, riderBoard: 0, riderLeave: 0,
      vehCrewed: 0, vehIdleCrewed: 0, vehShots: new Map(), vehPassengers: new Map(), stuck: 0, driven: 0, frame: [], ai: [],
      obj: new Map(), hist: new Map(), opOf: new Map(), still: new Map(), stuckPrev: new Map(), last: new Map(), delivered: [],
      // Census: soldiers standing still for 30 s with nothing to shoot at (by situation), vehicles left at spawn,
      // vehicles that stop dead when their crew sights an enemy, travel speed of vehicles on the move.
      sx: new Float32Array(S), sz: new Float32Array(S), st: new Float32Array(S).fill(-1),
      footSamples: 0, census: { all: 0, crew: 0, garrison: 0, hold: 0, op: 0, free: 0, recover: 0 },
      vehAlive: 0, vehParked: 0, parkedByType: {}, aliveByType: {}, vspd: new Map(),
      contactStops: 0, contactStopsConvoy: 0, contactStopsTransit: 0, convoySamples: 0, convoyVehicles: 0,
      travelSamples: 0, travelSpeedSum: 0, laneSamples: 0, laneBlockers: 0, vst: new Map(), ret: new Map(), retOk: 0, retOther: 0, retTime: 0, dt: new Map(), flipFlops: 0, unused: {}, stopBy: {}, stuckPhase: {}, spec: {},
    };
    // Shots fired per vehicle (weapon usefulness).
    const fire = g.combat.fire.bind(g.combat);
    g.combat.fire = (shooter, w, o, d, spread, opts) => {
      const ok = fire(shooter, w, o, d, spread, opts);
      const v = (opts && opts.vehicle) || shooter.vehicle;
      if (ok && v) M.vehShots.set(v.id, (M.vehShots.get(v.id) || 0) + 1);
      return ok;
    };
    // Per side: deaths by what killed them, vehicles lost, spawns straight into a contested capture circle.
    M.side = [0, 1].map(() => ({ deaths: 0, byInf: 0, byVeh: 0, byAir: 0, bySam: 0, other: 0, vehLost: 0, airLost: 0, spawns: 0, spawnIntoContest: 0, captures: 0, flagSamples: 0, crewedSamples: 0, footSamples: 0 }));
    g.bus.on('kill', (attacker, victim) => {
      const t = M.side[victim.team]; t.deaths++;
      if (!attacker) t.other++;
      else if (attacker.name === 'BASE SAM') t.bySam++;
      else if (attacker.vehicle && attacker.vehicle.isAircraft) t.byAir++;
      else if (attacker.vehicle) t.byVeh++;
      else t.byInf++;
    });
    g.bus.on('flag:changed', (f, owner) => { if (owner >= 0 && !f.base) M.side[owner].captures++; });
    g.bus.on('vehicle:destroyed', (v) => { const team = v.occupied ? v.team : v.spawn.team; if (team < 0) return; M.side[team].vehLost++; if (v.isAircraft) M.side[team].airLost++; });
    g.bus.on('spawn', (s) => {
      const t = M.side[s.team]; t.spawns++;
      for (const f of g.capture.flags) if (!f.base && (f.x - s.pos.x) ** 2 + (f.z - s.pos.z) ** 2 < 40 * 40 && f.count[1 - s.team] > 0) { t.spawnIntoContest++; break; }
    });
    // Passengers: boarding and where they get off relative to their squad's destination.
    g.bus.on('vehicle:enter', (v, s, seat) => {
      const role = v.def.seats[seat].role;
      if (role === 'passenger' || role === 'rider') { M.boardEvents++; if (role === 'rider') M.riderBoard++; M.vehPassengers.set(v.id, (M.vehPassengers.get(v.id) || 0) + 1); }
    });
    g.bus.on('vehicle:exit', (v, s) => {
      const q = s.squad;
      const T = window.__m && window.__m.T;
      if (T && q && q.kind === 0 && !v.isAircraft && !T.drops.some((d) => d.q === q.id && g.time - d.t < 5)) T.drops.push({ q: q.id, t: g.time });
      if (!q || q.kind !== 0 || v.isAircraft) return;
      const seat = v.def.seats.findIndex((x, i) => i > 0 && x.role !== 'driver');
      void seat;
      // Destination of the squad when it got off.
      let dx, dz;
      if (q.order && q.order !== 0) { dx = q.destX; dz = q.destZ; } else if (q.objective) { dx = q.objective.x; dz = q.objective.z; } else return;
      const d = Math.hypot(s.pos.x - dx, s.pos.z - dz);
      M.deliveries++;
      if (d < 120) M.deliveredNear++;
      M.delivered.push(Math.round(d));
    });
  });
  const t0 = Date.now();
  for (let t = 0; t < seconds; t += 10) {
    await page.evaluate(() => {
      const g = window.__game, M = window.__m, dt = 1 / 30, S = g.soldiers.length;
      for (let step = 0; step < 300; step++) {
        const a = performance.now();
        g._simulate(dt);
        M.frame.push(performance.now() - a);
        if (step % 15) continue;
        M.samples++;
        const time = g.time;
        // ---- Tactical metrics (generic state: agent buffers, squads, buildings) ----
        {
          const T = M.T || (M.T = { act: {}, actChanges: 0, actABA: 0, footSamples: 0, tgtSwitch: 0, idle: {}, idleSamples: 0, defSamples: 0, defCover: 0, defBuilding: 0, defOpen: 0, defCrowded: 0, defMoves: 0, defMoveSamples: 0,
            spreadSum: 0, spreadN: 0, farFromLeader: 0, travelMembers: 0, dropSpread: [], drops: [], inPath: 0, vehMovingSamples: 0, still: {}, defGoal: {} });
          const st = g.ai.st, list = g.vehicles.list, B = g.map.buildings;
          const inBuilding = (x, z) => { for (const b of B) { if (b.state >= 2 || b.deck || b.roof === 'open') continue; const dx = x - b.x, dz = z - b.z; if (dx * dx + dz * dz > (b.w + b.d) * (b.w + b.d)) continue; const c = Math.cos(b.rot), sn = Math.sin(b.rot), lx = dx * c - dz * sn, lz = dx * sn + dz * c; if (Math.abs(lx) < b.w / 2 - 0.3 && Math.abs(lz) < b.d / 2 - 0.3) return true; } return false; };
          for (const s of g.soldiers) {
            if (!s.alive || s.isPlayer || s.vehicle || !s.ai) continue;
            const o = s.id, a = s.ai, q = s.squad;
            T.footSamples++;
            // Action oscillation: back to the action it had before the last change, within 4 s.
            const act = st.action[o], h = T.act[o] || (T.act[o] = [act, -1, -1e9]);
            if (act !== h[0]) { T.actChanges++; if (act === h[1] && time - h[2] < 4) T.actABA++; h[1] = h[0]; h[0] = act; h[2] = time; }
            // Abrupt target switches: a new target while the old one is alive and was in sight a moment ago.
            const pt = T.still['t' + o];
            if (a.target && pt && pt[0] && pt[0] !== a.target && pt[0].alive && pt[1] && time - pt[2] < 1.5) T.tgtSwitch++;
            T.still['t' + o] = [a.target, a.targetVisible, time];
            // Standing still with nothing to shoot: why?
            const sp = T.still[o] || (T.still[o] = [s.pos.x, s.pos.z, time]);
            if (Math.hypot(s.pos.x - sp[0], s.pos.z - sp[1]) > 1.5) { sp[0] = s.pos.x; sp[1] = s.pos.z; sp[2] = time; }
            if (time - sp[2] > 15 && !(a.target && a.targetVisible)) {
              T.idleSamples++;
              const ord = q ? q.order : 0, d2o = q && q.objective ? Math.hypot(q.objective.x - s.pos.x, q.objective.z - s.pos.z) : 1e9;
              const k = s.cls === 5 || s.cls === 6 ? 'crew waiting' : !q ? 'no squad' : ord === 5 || ord === 2 || ord === 4 ? 'holding a position (defend/hold/support)'
                : q.planMode >= 0 ? 'at a planned position' : d2o < 30 ? 'at its objective' : q.waitSince > 0 ? 'waiting for stragglers' : a.hasGoal ? 'has a goal but not moving' : 'no goal, objective elsewhere';
              T.idle[k] = (T.idle[k] || 0) + 1;
            }
            // Defenders (squads defending / holding a flag, arrived): where do they stand, and do they keep moving?
            if (q && (q.order === 5 || (q.planMode === 2)) && Math.hypot(q.destX - q.cx, q.destZ - q.cz) < 35) {
              T.defSamples++;
              // In a building, at a cover position (within 1.6 m of a valid cover node), or in the open.
              const cov = g.ai.cover, ids = T.ids || (T.ids = new Int32Array(64));
              let nearC = false; const nq = cov.grid.query(s.pos.x, s.pos.z, 1.6, ids);
              for (let k = 0; k < nq && !nearC; k++) if (cov.valid(ids[k]) && (cov.x[ids[k]] - s.pos.x) ** 2 + (cov.z[ids[k]] - s.pos.z) ** 2 < 1.6 * 1.6) nearC = true;
              const inB = inBuilding(s.pos.x, s.pos.z);
              if (inB) T.defBuilding++; else if (nearC) T.defCover++; else T.defOpen++;
              let crowd = false;
              for (let i = 0; i < q.count; i++) { const m = g.soldiers[q.members[i]]; if (m !== s && m.alive && !m.vehicle && (m.pos.x - s.pos.x) ** 2 + (m.pos.z - s.pos.z) ** 2 < 2.5 * 2.5) { crowd = true; break; } }
              if (crowd) T.defCrowded++;
              const dg = T.defGoal[o];
              if (!(a.target && a.targetVisible)) {
                T.defMoveSamples++;
                if (dg && a.hasGoal && Math.hypot(a.goalX - dg[0], a.goalZ - dg[1]) > 4) T.defMoves++;
              }
              if (a.hasGoal) T.defGoal[o] = [a.goalX, a.goalZ];
            }
          }
          // Squad cohesion on the move: spread around the centroid, members far from the leader.
          for (const q of g.ai.squads.squads) {
            if (q.kind !== 0 || q.dismounted < 3 || q.vehicle >= 0) continue;
            const goalD = q.objective ? Math.hypot(q.objective.x - q.cx, q.objective.z - q.cz) : 0;
            if (goalD < 60 || q.order === 5 || q.order === 2) continue;
            const L0 = g.soldiers[q.leader];
            let sum = 0, n = 0;
            for (let i = 0; i < q.count; i++) { const m = g.soldiers[q.members[i]]; if (!m.alive || m.vehicle) continue; sum += Math.hypot(m.pos.x - q.cx, m.pos.z - q.cz); n++; T.travelMembers++; if (L0 && L0.alive && !L0.vehicle && Math.hypot(m.pos.x - L0.pos.x, m.pos.z - L0.pos.z) > 50) T.farFromLeader++; }
            if (n) { T.spreadSum += sum / n; T.spreadN++; }
          }
          // Squads 20 s after getting off a vehicle: how spread out are they?
          for (let i = T.drops.length - 1; i >= 0; i--) {
            const d = T.drops[i];
            if (time - d.t < 20) continue;
            const q = g.ai.squads.squads[d.q]; let sum = 0, n = 0;
            for (let k = 0; k < q.count; k++) { const m = g.soldiers[q.members[k]]; if (m.alive && !m.vehicle) { sum += Math.hypot(m.pos.x - q.cx, m.pos.z - q.cz); n++; } }
            if (n >= 2) T.dropSpread.push(sum / n);
            T.drops.splice(i, 1);
          }
          // Friendly soldiers standing in the path of moving friendly vehicles.
          for (const v of list) {
            if (!v.alive || v.def.kind !== 'ground' || v.def.static || Math.abs(v.speed) < 3) continue;
            T.vehMovingSamples++;
            const fx = Math.sin(v.yaw) * Math.sign(v.speed), fz = Math.cos(v.yaw) * Math.sign(v.speed);
            for (const s of g.soldiers) {
              if (!s.alive || s.vehicle || s.team !== v.team) continue;
              const dx = s.pos.x - v.pos.x, dz = s.pos.z - v.pos.z, al = dx * fx + dz * fz;
              if (al > v.def.half[2] && al < v.def.half[2] + 8 && Math.abs(dx * fz - dz * fx) < v.def.half[0] + 0.8) { T.inPath++; break; }
            }
          }
        }
        // ---- Lifecycle metrics (computed from generic game state, so older builds are measured the same way).
        {
          const L = M.L || (M.L = { conv: { samples: 0, gapSum: 0, gapN: 0, gapMax: 0, inBand: 0, pairs: 0, maxPer: {} }, idle: { samples: 0, byMode: {}, episodes: [], open: {} },
            retBy: {}, cap: [0, 0], att: {}, attOut: {}, sqIdle: 0, sqObjSamples: 0, win: { t0: time, cap: 0, contested: false, ops: false, arrived: false }, dead: {}, free: [0, 0], freeN: 0, goalJumps: 0, lastOwner: null, gj: {} });
          const VM = ['parked','boarding','transit','dismount','overwatch','return','hold','fire','scoot','loiter','attack','egress','land','unload','hide','popup','resupply','support','flank','rope','para','repair'];
          const list = g.vehicles.list, flags = g.capture.flags, orch = g.ai.orchestrator;
          // Convoy column quality: gaps between consecutive members of moving convoys.
          for (const c of g.ai.squads.convoys) {
            if (!c.active || c.count < 2 || (c.state && c.state !== 'moving')) continue;
            L.conv.samples++;
            let mx = 0;
            for (let i = 1; i < c.count; i++) {
              const a = list[c.vehicles[i - 1]], b = list[c.vehicles[i]], d = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
              L.conv.gapSum += d; L.conv.gapN++; L.conv.pairs++; if (d >= 8 && d <= 45) L.conv.inBand++; if (d > mx) mx = d;
            }
            if (mx > L.conv.gapMax) L.conv.gapMax = mx;
          }
          // Vehicles idle in the field: crewed, stationary, out of combat, far from their base (episodes).
          for (const v of list) {
            if (!v.alive || v.def.static || v.def.kind !== 'ground' || !v.driver || !v.driver.ai) { delete L.idle.open[v.id]; continue; }
            const b = g.map.bases[v.spawn.team], far = Math.hypot(v.pos.x - b.x, v.pos.z - b.z) > 250;
            const combat = v.seats.some((o) => o && o.ai && o.ai.target && o.ai.targetVisible);
            const st = M.vst.get(v.id), still = st && time - st[2] > 30;
            const mf = orch.manifests[v.id];
            const tasked = mf.opPhase >= 0 || mf.squadId >= 0 || mf.supports >= 0 || mf.servicing || (mf.msg && mf.msg.state === 2);
            if (far && still && !combat && tasked) L.idle.holdingTask = (L.idle.holdingTask || 0) + 1;
            const idle = far && still && !combat && !tasked;
            if (idle) {
              L.idle.samples++;
              const m = VM[orch.manifests[v.id].mode] || orch.manifests[v.id].mode;
              L.idle.byMode[m] = (L.idle.byMode[m] || 0) + 1;
              if (!L.idle.open[v.id]) L.idle.open[v.id] = time;
            } else if (L.idle.open[v.id]) { L.idle.episodes.push(time - L.idle.open[v.id]); delete L.idle.open[v.id]; }
            // Every drive-goal jump over 60 m (legitimate or not).
            const a = v.driver.ai, pg = L.gj[v.id];
            if (pg && Math.hypot(a.driveX - pg[0], a.driveZ - pg[1]) > 60) L.goalJumps++;
            L.gj[v.id] = [a.driveX, a.driveZ];
          }
          // Captures by side (non-base flags).
          if (!L.lastOwner) L.lastOwner = flags.map((f) => f.owner);
          let capNow = 0;
          flags.forEach((f, i) => { if (f.owner !== L.lastOwner[i]) { if (f.owner >= 0 && !f.base) { L.cap[f.owner]++; capNow++; } L.lastOwner[i] = f.owner; } if (f.contestedBy >= 0) L.win.contested = true; });
          L.win.cap += capNow;
          // Capture attempts: (squad, non-owned objective flag) assignments followed to their outcome.
          let free = [0, 0];
          for (const q of g.ai.squads.squads) {
            if (q.kind !== 0) continue;
            const key = q.id;
            const cur = L.att[key];
            if (q.alive > 0 && q.opId < 0 && q.garrison < 0) free[q.team] += q.alive;
            const o = q.objective;
            const target = o && o.owner !== q.team && !o.base ? o : null;
            const close = (f) => Math.hypot(q.cx - f.x, q.cz - f.z) < (f.radius || 16) * 1.6;
            const end = (why) => { L.attOut[why] = (L.attOut[why] || 0) + 1; delete L.att[key]; };
            if (cur) {
              const f = flags[cur.f];
              if (cur.arrived === false && close(f)) { cur.arrived = true; cur.arrT = time; L.win.arrived = true; }
              if (q.alive === 0) end(cur.arrived ? 'wiped after arriving' : 'wiped before arriving');
              else if (f.owner === q.team) end(cur.arrived ? 'captured (squad there)' : 'taken by others before it arrived');
              else if (!target || target.id !== f.id) end(cur.arrived ? 'reassigned after arriving' : time - cur.t < 20 ? 'reassigned within 20 s' : 'reassigned before arriving');
            }
            if (target && q.alive > 0 && !L.att[key]) { L.att[key] = { f: flags.indexOf(target), t: time, arrived: close(target) }; L.attOut.started = (L.attOut.started || 0) + 1; }
            // Stalled: an objective it has not reached, on foot, and the squad moved under 5 m in the last 10 s.
            const P = M.sqPos || (M.sqPos = {}), pc = P[key];
            if (!pc || time - pc[2] >= 10) {
              if (pc && target && q.alive > 0 && !close(target) && q.vehicle < 0) { L.sqObjSamples++; if (Math.hypot(q.cx - pc[0], q.cz - pc[1]) < 5) L.sqIdle++; }
              P[key] = [q.cx, q.cz, time];
            }
          }
          L.free[0] += free[0]; L.free[1] += free[1]; L.freeN++;
          const opsActive = g.ai.commanders.some((c) => (c.ops || []).some((op) => op.active));
          if (opsActive) L.win.ops = true;
          // Every 60 s: what kind of minute was it?
          if (time - L.win.t0 >= 60) {
            // fluid: a flag changed hands; contested: both sides inside a capture circle, nobody wins it; operational:
            // operations running but no squad reached a target; attacks stalled: squads got there, no contest;
            // resource: one side has (almost) no free infantry; passive: no operations, nobody reached a target.
            const k = L.win.cap > 0 ? 'fluid (captures)' : L.win.contested ? 'contested deadlock' : L.win.ops && !L.win.arrived ? 'operational deadlock'
              : Math.min(free[0], free[1]) < 6 ? 'resource deadlock' : L.win.arrived ? 'attacks reached targets, no contest' : 'passive deadlock';
            L.dead[k] = (L.dead[k] || 0) + 1;
            L.win = { t0: time, cap: 0, contested: false, ops: false, arrived: false };
          }
        }
        for (const q of g.ai.squads.squads) {
          if (q.kind !== 0 || q.alive === 0) continue;
          M.squadSamples++;
          // Objective consistency.
          const id = q.objective ? q.objective.id : -1, prev = M.obj.get(q.id);
          if (prev !== undefined && prev !== id && id >= 0) {
            M.objChanges++;
            const h = M.hist.get(q.id) || [];
            if (h.length >= 2 && h[h.length - 2].id === id && time - h[h.length - 2].t < 60) M.flips++;
            h.push({ id, t: time }); if (h.length > 4) h.shift(); M.hist.set(q.id, h);
          }
          M.obj.set(q.id, id);
          // Operations: direct moves from one operation to another (stealing), leaving an op while in contact.
          const op = q.opId, pop = M.opOf.get(q.id);
          if (pop !== undefined && pop !== op) {
            // Stealing: moved into another operation while the one it belonged to is still running.
            const stillActive = pop >= 0 && g.ai.commanders[q.team].ops.some((o) => o.active && o.id === pop);
            if (op >= 0 && stillActive) M.opSteals++;
            const c = new Float32Array(2);
            if (pop >= 0 && stillActive && q.contactCentroid(time, 10, c) > 0) M.opLeavesInContact++;
          }
          M.opOf.set(q.id, op);
          // Purposeless idling: dismounted, no contacts, not holding / garrisoning / under orders, not moving for 30 s.
          const st = M.still.get(q.id) || { x: q.cx, z: q.cz, t: time };
          if ((q.cx - st.x) ** 2 + (q.cz - st.z) ** 2 > 25) { st.x = q.cx; st.z = q.cz; st.t = time; }
          M.still.set(q.id, st);
          // Purposeful: under orders, garrisoning, mounted, at its own flag, or standing in the circle of the flag it is capturing.
          const atObj = q.objective && Math.hypot(q.objective.x - q.cx, q.objective.z - q.cz) < (q.objective.owner === q.team ? 60 : 40);
          const purposeful = q.order !== 0 || q.garrison >= 0 || q.vehicle >= 0 || atObj;
          const c2 = new Float32Array(2);
          if (q.dismounted > 0 && !purposeful && q.contactCentroid(time, 15, c2) === 0 && time - st.t > 30) M.idleSquadSamples++;
        }
        // --- census: soldiers
        for (let i = 0; i < S; i++) {
          const s = g.soldiers[i];
          if (!s.alive || s.isPlayer || s.vehicle || !s.ai) { M.st[i] = -1; continue; }
          M.footSamples++;
          if (M.st[i] < 0 || (s.pos.x - M.sx[i]) ** 2 + (s.pos.z - M.sz[i]) ** 2 > 16) { M.sx[i] = s.pos.x; M.sz[i] = s.pos.z; M.st[i] = time; continue; }
          if (time - M.st[i] < 30 || (s.ai.target && s.ai.targetVisible)) continue;
          const q = s.squad, c = M.census;
          c.all++;
          if (s.cls === 5 || s.cls === 6) c.crew++;
          else if (!q) c.free++;
          else if (q.opId >= 0) c.op++;
          else if (q.recoverUntil > time) c.recover++;
          else if (q.garrison >= 0 || q.order === 5) c.garrison++;
          else if (q.order === 2 || q.order === 4) c.hold++;
          else c.free++;
        }
        // --- census: vehicles
        for (const v of g.vehicles.list) {
          if (!v.alive || v.def.static) continue;
          M.vehAlive++;
          M.aliveByType[v.def.type] = (M.aliveByType[v.def.type] || 0) + 1;
          if (!v.occupied && (v.pos.x - v.spawn.x) ** 2 + (v.pos.z - v.spawn.z) ** 2 < 40 * 40) {
            M.vehParked++; M.parkedByType[v.def.type] = (M.parkedByType[v.def.type] || 0) + 1;
            if (g.ai.orchestrator.unusedReason) { const r = `${v.spawn.team ? 'T' : 'P'} ${g.ai.orchestrator.unusedReason(v)}`; M.unused[r] = (M.unused[r] || 0) + 1; }
          }
          const a = v.driver && v.driver.ai;
          if (!a || v.def.kind !== 'ground') { M.vspd.delete(v.id); continue; }
          const prev = M.vspd.get(v.id) || 0, sp = Math.abs(v.speed);
          M.vspd.set(v.id, sp);
          const sees = v.seats.some((o) => o && o.ai && o.ai.target && o.ai.targetVisible);
          const conv = g.ai.squads.convoyOf[v.id] >= 0, transit = g.ai.orchestrator.manifests[v.id].mode === 2;
          if (conv) M.convoyVehicles++;
          if (prev > 4 && sp < 1 && sees && Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z) > 60) {
            const key = `${v.def.type}:${g.ai.orchestrator.manifests[v.id].mode}${a.holdVehicle ? ':hold' : ''}${a.speedCap < 0.5 ? ':capped' : ''}`; M.stopBy[key] = (M.stopBy[key] || 0) + 1;
            M.contactStops++; if (conv) M.contactStopsConvoy++; if (transit) M.contactStopsTransit++; }
          if (!a.holdVehicle && Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z) > 60) { M.travelSamples++; M.travelSpeedSum += sp / v.def.maxSpeed; }
        }
        M.convoySamples++;
        for (let team = 0; team < 2; team++) {
          const t = M.side[team];
          if (g.ai.commanders[team].garrisonSummary && step % 60 === 0) {
            const gs = g.ai.commanders[team].garrisonSummary();
            t.gSamples = (t.gSamples || 0) + 1; t.gSoldiers = (t.gSoldiers || 0) + gs.soldiers; t.gThreat = (t.gThreat || 0) + gs.threatened; t.gFront = (t.gFront || 0) + gs.front; t.gRear = (t.gRear || 0) + gs.rear; t.gDef = (t.gDef || 0) + gs.defensive;
            let opSoldiers = 0; for (const q of g.ai.squads.squads) if (q.team === team && q.opId >= 0) opSoldiers += q.alive;
            t.opSoldiers = (t.opSoldiers || 0) + opSoldiers;
          }
          t.flagSamples += g.capture.flags.filter((f) => !f.base && f.owner === team).length;
          for (const x of g.soldiers) if (x.alive && x.team === team) { if (x.vehicle) t.crewedSamples++; else t.footSamples++; }
        }
        // Vehicle park: stationary vehicles standing in base lanes; return-to-base trips (start → parked).
        // (Lane geometry computed here, so builds without a park manager are measured the same way.)
        M.laneSamples++;
        for (const v of g.vehicles.list) {
          if (!v.alive || v.def.static || v.def.kind !== 'ground') continue;
          const st = M.vst.get(v.id) || [v.pos.x, v.pos.z, g.time];
          if (Math.hypot(v.pos.x - st[0], v.pos.z - st[1]) > 2) { st[0] = v.pos.x; st[1] = v.pos.z; st[2] = g.time; }
          M.vst.set(v.id, st);
          if (g.time - st[2] < 10) continue;
          const b = g.map.bases[v.spawn.team], u = (v.pos.x - b.x) * b.inland, w = v.pos.z - b.z;
          if (Math.abs(w) < 94 && ((u > 47 && u < 72) || (u > 21 && u < 35))) M.laneBlockers++;
        }
        for (const v of g.vehicles.list) {
          if (!v.alive || v.def.static || v.def.kind !== 'ground' || !v.driver || !v.driver.ai) continue;
          const mode = g.ai.orchestrator.manifests[v.id].mode, rt = M.ret.get(v.id);
          if (mode === 5 && !rt) M.ret.set(v.id, g.time);
          else if (mode !== 5 && rt) {
            M.ret.delete(v.id);
            const base = g.map.bases[v.spawn.team], home = Math.hypot(v.pos.x - base.x, v.pos.z - base.z) < 200;
            if (mode === 0 && home) { M.retOk++; M.retTime += g.time - rt; } else { M.retOther++; const L = M.L; if (L) { const VMN = ['parked','boarding','transit','dismount','overwatch','return','hold','fire','scoot','loiter','attack','egress','land','unload','hide','popup','resupply','support','flank','rope','para','repair']; const k = (VMN[mode] || mode) + (home ? ' at base' : ' in field'); L.retBy[k] = (L.retBy[k] || 0) + 1; } }
          }
          // Drive-target flip-flops: the goal jumps far away and back again within 15 s.
          const a = v.driver.ai, prev = M.dt.get(v.id);
          if (prev) {
            if (Math.hypot(a.driveX - prev[0], a.driveZ - prev[1]) > 60) {
              if (prev[3] && g.time - prev[5] < 15 && Math.hypot(a.driveX - prev[3], a.driveZ - prev[4]) < 20) M.flipFlops++;
              M.dt.set(v.id, [a.driveX, a.driveZ, g.time, prev[0], prev[1], g.time]);
            }
          } else M.dt.set(v.id, [a.driveX, a.driveZ, g.time, 0, 0, 0]);
        }
        for (const v of g.vehicles.list) {
          if (!v.alive || v.def.static || !v.occupied) continue;
          M.vehCrewed++;
          const a = v.driver && v.driver.ai;
          const busy = Math.abs(v.speed) > 0.6 || (a && a.target && a.targetVisible) || v.seats.some((o, i) => i > 0 && o);
          if (!busy) M.vehIdleCrewed++;
          if (a && v.def.kind === 'ground') {
            const pk = M.stuckPrev.get(v.id) ?? a.stuckTotal;
            if (a.stuckTotal > pk) {
              M.stuck += a.stuckTotal - pk;
              // Phase of the trip: returning home, leaving base, arriving (last 40 m), or open travel.
              const mode = g.ai.orchestrator.manifests[v.id].mode, base = g.map.bases[v.team];
              const ph = mode === 5 ? 'return' : Math.hypot(v.pos.x - base.x, v.pos.z - base.z) < 200 ? 'base departure' : Math.hypot(a.driveX - v.pos.x, a.driveZ - v.pos.z) < 40 ? 'arrival' : 'open travel';
              M.stuckPhase[ph] = (M.stuckPhase[ph] || 0) + 1;
            }
            M.stuckPrev.set(v.id, a.stuckTotal);
          }
          // Specialized vehicles: crewed, tasked (holding a radio mission or an operation role), firing.
          const cat = ['mlrs', 'howitzer', 'sam', 'spaag', 'supply', 'attackheli', 'strikejet', 'fighter', 'transportheli', 'heli'].includes(v.def.type) ? v.def.type : null;
          if (cat) {
            const sp = M.spec[cat] || (M.spec[cat] = { ids: {}, crewed: 0, tasked: 0, samples: 0 });
            sp.ids[v.id] = 1; sp.samples++; sp.crewed++;
            const mm = g.ai.orchestrator.manifests[v.id];
            if ((mm.msg && mm.msg.state === 2 && mm.msg.claimedBy === v.id) || mm.opPhase >= 0 || (g.ai.commanders[v.team].vehicleRole && g.ai.commanders[v.team].vehicleRole(v.id))) sp.tasked++;
          }
          const p = M.last.get(v.id);
          if (p && v.def.kind === 'ground') M.driven += Math.hypot(v.pos.x - p.x, v.pos.z - p.z);
          M.last.set(v.id, { x: v.pos.x, z: v.pos.z });
        }
      }
      M.ai.push(g.ai.stats.ms);
    });
  }
  const r = await page.evaluate(() => {
    const g = window.__game, M = window.__m;
    const f = M.frame.slice().sort((a, b) => a - b);
    const minutes = (g.time - M.t0) / 60;
    const squads = g.ai.squads.squads.filter((q) => q.kind === 0).length;
    const cmd = g.ai.commanders.map((c) => ({ ...c.stats, log: (c.opLog || []).slice(-60) }));
    const vehicles = g.vehicles.list.filter((v) => !v.def.static);
    const withShots = vehicles.filter((v) => (M.vehShots.get(v.id) || 0) > 0).length;
    const carried = vehicles.filter((v) => (M.vehPassengers.get(v.id) || 0) > 0).length;
    const orch = g.ai.orchestrator.stats;
    return {
      minutes, squads,
      objChangesPerSquadMin: M.objChanges / squads / minutes, flips: M.flips,
      idleSquadPct: (100 * M.idleSquadSamples) / Math.max(1, M.squadSamples),
      opSteals: M.opSteals, opLeavesInContact: M.opLeavesInContact,
      opsPlanned: cmd.map((c) => c.planned), opsSucceeded: cmd.map((c) => c.succeeded), opsFailed: cmd.map((c) => c.failed),
      opsCancelled: cmd.map((c) => c.cancelled ?? null), declined: cmd.map((c) => c.declined ?? null),
      deliveries: M.deliveries, deliveredNearPct: (100 * M.deliveredNear) / Math.max(1, M.deliveries),
      boardEvents: M.boardEvents, riderBoard: M.riderBoard, ticketsExpired: orch.expired, ticketsBoarded: orch.boarded,
      perSide: M.side.map((t, team) => ({ ...t, flagsHeldAvg: +(t.flagSamples / Math.max(1, M.convoySamples)).toFixed(2),
        onFootAvg: +(t.footSamples / Math.max(1, M.convoySamples)).toFixed(1), inVehicleAvg: +(t.crewedSamples / Math.max(1, M.convoySamples)).toFixed(1),
        crewClass: g.soldiers.filter((x) => x.team === team && (x.cls === 5 || x.cls === 6)).length,
        vehicles: g.vehicles.list.filter((v) => !v.def.static && v.spawn.team === team).length, ticketsEnd: Math.round(g.capture.tickets[team]),
        garrisonAvg: t.gSamples ? { soldiers: +(t.gSoldiers / t.gSamples).toFixed(1), threatened: +(t.gThreat / t.gSamples).toFixed(1), front: +(t.gFront / t.gSamples).toFixed(1), rear: +(t.gRear / t.gSamples).toFixed(1), defensive: +(t.gDef / t.gSamples).toFixed(1), inOps: +(t.opSoldiers / t.gSamples).toFixed(1) } : null,
        flagSamples: undefined, crewedSamples: undefined, footSamples: undefined })),
      convoyStats: { ...g.ai.squads.stats }, stopBy: M.stopBy, stuckPhase: M.stuckPhase,
      specialized: Object.fromEntries(['mlrs', 'howitzer', 'sam', 'spaag', 'supply', 'attackheli', 'strikejet', 'fighter', 'transportheli', 'heli'].map((t) => {
        const all = g.vehicles.list.filter((v) => v.def.type === t), sp = M.spec[t] || { ids: {}, crewed: 0, tasked: 0, samples: 0 };
        const per = M.vehAliveByType && M.vehAliveByType[t] || 1;
        return [t, { count: all.length, everCrewed: Object.keys(sp.ids).length, crewedPct: Math.round((100 * sp.crewed) / Math.max(1, M.aliveByType[t] || 1)),
          taskedPctOfCrewed: Math.round((100 * sp.tasked) / Math.max(1, sp.samples)), fired: all.filter((v) => (M.vehShots.get(v.id) || 0) > 0).length,
          missions: all.reduce((n, v) => n + (g.ai.orchestrator.manifests[v.id].missions || 0), 0),
          unusedNow: all.filter((v) => v.alive && !v.seats[0]).map((v) => g.ai.orchestrator.unusedReason(v)).join('; ') }];
      })),
      radio: g.ai.radio.byType ? Object.fromEntries(['spot', 'cas', 'fire', 'logistics', 'airThreat', 'extract', 'dangerClose', 'contact'].map((k, i) => [k, g.ai.radio.byType[i]])) : null,
      unusedReasons: Object.fromEntries(Object.entries(M.unused).map(([k, n]) => [k, +((100 * n) / Math.max(1, M.vehAlive)).toFixed(1)])),
      baseSamKills: g.baseDefence ? g.baseDefence.sams.reduce((a, x) => a + x.shooter.kills, 0) : 0,
      navStats: g.navStats || null,
      stillPct: (100 * M.census.all) / Math.max(1, M.footSamples),
      stillBy: Object.fromEntries(Object.entries(M.census).map(([k, n]) => [k, +((100 * n) / Math.max(1, M.footSamples)).toFixed(2)])),
      vehParkedPct: (100 * M.vehParked) / Math.max(1, M.vehAlive),
      parkedByType: Object.fromEntries(Object.keys(M.aliveByType).map((k) => [k, Math.round((100 * (M.parkedByType[k] || 0)) / M.aliveByType[k])])),
      contactStopsPerMin: M.contactStops / minutes, contactStopsConvoy: M.contactStopsConvoy, contactStopsTransit: M.contactStopsTransit,
      convoyVehiclesAvg: M.convoyVehicles / Math.max(1, M.convoySamples),
      travelSpeedPct: (100 * M.travelSpeedSum) / Math.max(1, M.travelSamples),
      vehIdleCrewedPct: (100 * M.vehIdleCrewed) / Math.max(1, M.vehCrewed), vehWithShotsPct: (100 * withShots) / vehicles.length,
      laneBlockersAvg: M.laneBlockers / Math.max(1, M.laneSamples), returnsParked: M.retOk, returnsRetasked: M.retOther, returnStillOn: M.ret.size,
      returnAvgS: M.retTime / Math.max(1, M.retOk), driveFlipFlops: M.flipFlops,
      parkStats: g.ai.orchestrator.park ? { ...g.ai.orchestrator.park.stats } : null,
      driving: (() => { const o = { kTurns: 0, jamReroutes: 0, settleHolds: 0 }; for (const s2 of g.soldiers) if (s2.ai) { o.kTurns += s2.ai.kTurns || 0; o.jamReroutes += s2.ai.jamReroutes || 0; o.settleHolds += s2.ai.settleHolds || 0; } return o; })(),
      vehCarriedPct: (100 * carried) / vehicles.length, stuckPerKm: M.stuck / Math.max(0.1, M.driven / 1000), drivenKm: M.driven / 1000,
      frameAvg: f.reduce((a, b) => a + b, 0) / f.length, frameP95: f[Math.floor(f.length * 0.95)],
      aiMs: M.ai.reduce((a, b) => a + b, 0) / M.ai.length,
      flags: g.capture.flags.filter((x) => !x.base).map((x) => (x.owner < 0 ? '·' : x.owner ? 'T' : 'P')).join(''),
      tactical: (() => { const T = M.T; if (!T) return null; const fs = g.fireStats || {};
        return { actChangesPerSoldierMin: +(T.actChanges / Math.max(1, T.footSamples) * 120).toFixed(2), abaPct: +(100 * T.actABA / Math.max(1, T.actChanges)).toFixed(1),
          targetSwitchesPerSoldierMin: +(T.tgtSwitch / Math.max(1, T.footSamples) * 120).toFixed(3),
          idlePct: +(100 * T.idleSamples / Math.max(1, T.footSamples)).toFixed(1), idleBy: Object.fromEntries(Object.entries(T.idle).map(([k, n]) => [k, +(100 * n / Math.max(1, T.footSamples)).toFixed(2)])),
          defenders: { samples: T.defSamples, buildingPct: +(100 * T.defBuilding / Math.max(1, T.defSamples)).toFixed(1), coverPct: +(100 * T.defCover / Math.max(1, T.defSamples)).toFixed(1), openPct: +(100 * T.defOpen / Math.max(1, T.defSamples)).toFixed(1),
            crowdedPct: +(100 * T.defCrowded / Math.max(1, T.defSamples)).toFixed(1), positionChangesPerMin: +(T.defMoves / Math.max(1, T.defMoveSamples) * 120).toFixed(2) },
          travelSpread: +(T.spreadSum / Math.max(1, T.spreadN)).toFixed(1), farFromLeaderPct: +(100 * T.farFromLeader / Math.max(1, T.travelMembers)).toFixed(1),
          dropSpread: +(T.dropSpread.reduce((a, b) => a + b, 0) / Math.max(1, T.dropSpread.length)).toFixed(1), drops: T.dropSpread.length,
          soldierInVehiclePathPct: +(100 * T.inPath / Math.max(1, T.vehMovingSamples)).toFixed(1),
          fireBlockedPct: fs.checks ? +(100 * fs.blocked / fs.checks).toFixed(1) : null, fireChecks: fs.checks || 0 }; })(),
      lifecycle: (() => { const L = M.L; if (!L) return null; const ep = L.idle.episodes.concat(Object.values(L.idle.open).map((t) => g.time - t));
        return { convoyGapAvg: +(L.conv.gapSum / Math.max(1, L.conv.gapN)).toFixed(1), convoyGapMax: Math.round(L.conv.gapMax), convoyInBandPct: Math.round(100 * L.conv.inBand / Math.max(1, L.conv.pairs)), convoyMovingSamples: L.conv.samples,
          idleFieldAvg: +(L.idle.samples / Math.max(1, M.samples)).toFixed(2), holdingTaskAvg: +((L.idle.holdingTask || 0) / Math.max(1, M.samples)).toFixed(2), idleByMode: L.idle.byMode, idleEpisodes: ep.length, idleEpisodeAvgS: Math.round(ep.reduce((a, b) => a + b, 0) / Math.max(1, ep.length)), idleOver120: ep.filter((x) => x > 120).length,
          returnInterruptedBy: L.retBy, captures: L.cap, attempts: L.attOut, squadStalledPct: +(100 * L.sqIdle / Math.max(1, L.sqObjSamples)).toFixed(1),
          freeInfantryAvg: L.free.map((x) => +(x / Math.max(1, L.freeN)).toFixed(1)), minutes: L.dead, vehicleGoalJumps: L.goalJumps,
          cmdStats: g.ai.commanders.map((c) => c.stats) }; })(),
      tickets: g.capture.tickets.map(Math.round), extra: g.ai.evalStats ? g.ai.evalStats() : null, opLog: cmd.map((c) => c.log),
    };
  });
  r.seed = seed; r.wall = (Date.now() - t0) / 1000; r.errors = errors.slice(0, 3);
  results.push(r);
  console.log(`seed ${seed}: ${r.minutes.toFixed(1)} min in ${r.wall.toFixed(0)} s wall, flags ${r.flags}, tickets ${r.tickets.join('/')}${errors.length ? `, ERRORS ${errors[0]}` : ''}`);
  await page.close();
}
// Averages over seeds.
const keys = ['baseSamKills', 'stillPct', 'vehParkedPct', 'contactStopsPerMin', 'contactStopsConvoy', 'contactStopsTransit', 'convoyVehiclesAvg', 'travelSpeedPct',
  'objChangesPerSquadMin', 'flips', 'idleSquadPct', 'opSteals', 'opLeavesInContact', 'deliveries', 'deliveredNearPct', 'boardEvents', 'riderBoard',
  'laneBlockersAvg', 'returnsParked', 'returnsRetasked', 'returnStillOn', 'returnAvgS', 'driveFlipFlops',
  'ticketsExpired', 'vehIdleCrewedPct', 'vehWithShotsPct', 'vehCarriedPct', 'stuckPerKm', 'drivenKm', 'frameAvg', 'frameP95', 'aiMs'];
const avg = {};
for (const k of keys) avg[k] = results.reduce((a, r) => a + (r[k] || 0), 0) / results.length;
avg.stillBy = results.map((r) => r.stillBy);
avg.parkedByType = results.map((r) => r.parkedByType);
avg.opsPlanned = results.map((r) => r.opsPlanned.join('+')).join(' | ');
avg.opsOutcome = results.map((r) => `ok ${r.opsSucceeded.join('+')} fail ${r.opsFailed.join('+')} cancel ${r.opsCancelled.join('+')} declined ${r.declined.join('+')}`).join(' | ');
console.log(JSON.stringify(avg, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v), 1));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ dist, seconds, seeds, avg, results }, null, 1));
await browser.close();
server.close();
