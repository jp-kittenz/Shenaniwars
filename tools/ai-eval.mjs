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
    };
    // Shots fired per vehicle (weapon usefulness).
    const fire = g.combat.fire.bind(g.combat);
    g.combat.fire = (shooter, w, o, d, spread, opts) => {
      const ok = fire(shooter, w, o, d, spread, opts);
      const v = (opts && opts.vehicle) || shooter.vehicle;
      if (ok && v) M.vehShots.set(v.id, (M.vehShots.get(v.id) || 0) + 1);
      return ok;
    };
    // Passengers: boarding and where they get off relative to their squad's destination.
    g.bus.on('vehicle:enter', (v, s, seat) => {
      const role = v.def.seats[seat].role;
      if (role === 'passenger' || role === 'rider') { M.boardEvents++; if (role === 'rider') M.riderBoard++; M.vehPassengers.set(v.id, (M.vehPassengers.get(v.id) || 0) + 1); }
    });
    g.bus.on('vehicle:exit', (v, s) => {
      const q = s.squad;
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
      const g = window.__game, M = window.__m, dt = 1 / 30;
      for (let step = 0; step < 300; step++) {
        const a = performance.now();
        g._simulate(dt);
        M.frame.push(performance.now() - a);
        if (step % 15) continue;
        M.samples++;
        const time = g.time;
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
        for (const v of g.vehicles.list) {
          if (!v.alive || v.def.static || !v.occupied) continue;
          M.vehCrewed++;
          const a = v.driver && v.driver.ai;
          const busy = Math.abs(v.speed) > 0.6 || (a && a.target && a.targetVisible) || v.seats.some((o, i) => i > 0 && o);
          if (!busy) M.vehIdleCrewed++;
          if (a && v.def.kind === 'ground') { const pk = M.stuckPrev.get(v.id) ?? a.stuckTotal; if (a.stuckTotal > pk) M.stuck += a.stuckTotal - pk; M.stuckPrev.set(v.id, a.stuckTotal); }
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
      vehIdleCrewedPct: (100 * M.vehIdleCrewed) / Math.max(1, M.vehCrewed), vehWithShotsPct: (100 * withShots) / vehicles.length,
      vehCarriedPct: (100 * carried) / vehicles.length, stuckPerKm: M.stuck / Math.max(0.1, M.driven / 1000), drivenKm: M.driven / 1000,
      frameAvg: f.reduce((a, b) => a + b, 0) / f.length, frameP95: f[Math.floor(f.length * 0.95)],
      aiMs: M.ai.reduce((a, b) => a + b, 0) / M.ai.length,
      flags: g.capture.flags.filter((x) => !x.base).map((x) => (x.owner < 0 ? '·' : x.owner ? 'T' : 'P')).join(''),
      tickets: g.capture.tickets.map(Math.round), extra: g.ai.evalStats ? g.ai.evalStats() : null, opLog: cmd.map((c) => c.log),
    };
  });
  r.seed = seed; r.wall = (Date.now() - t0) / 1000; r.errors = errors.slice(0, 3);
  results.push(r);
  console.log(`seed ${seed}: ${r.minutes.toFixed(1)} min in ${r.wall.toFixed(0)} s wall, flags ${r.flags}, tickets ${r.tickets.join('/')}${errors.length ? `, ERRORS ${errors[0]}` : ''}`);
  await page.close();
}
// Averages over seeds.
const keys = ['objChangesPerSquadMin', 'flips', 'idleSquadPct', 'opSteals', 'opLeavesInContact', 'deliveries', 'deliveredNearPct', 'boardEvents', 'riderBoard',
  'ticketsExpired', 'vehIdleCrewedPct', 'vehWithShotsPct', 'vehCarriedPct', 'stuckPerKm', 'drivenKm', 'frameAvg', 'frameP95', 'aiMs'];
const avg = {};
for (const k of keys) avg[k] = results.reduce((a, r) => a + (r[k] || 0), 0) / results.length;
avg.opsPlanned = results.map((r) => r.opsPlanned.join('+')).join(' | ');
avg.opsOutcome = results.map((r) => `ok ${r.opsSucceeded.join('+')} fail ${r.opsFailed.join('+')} cancel ${r.opsCancelled.join('+')} declined ${r.declined.join('+')}`).join(' | ');
console.log(JSON.stringify(avg, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v), 1));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ dist, seconds, seeds, avg, results }, null, 1));
await browser.close();
server.close();
