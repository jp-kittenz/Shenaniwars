// Scenario test: squad ↔ transport relationship and extraction lifecycle, in the real simulation
// (commanders paused so the squad's orders stay as the test sets them).
// Usage: npm run build && node tools/transport-test.mjs [distDir=dist]
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const dist = path.resolve(process.argv[2] || 'dist');
const server = http.createServer((q, r) => {
  const rel = decodeURIComponent(q.url.split('?')[0]); const f = path.join(dist, rel === '/' ? 'index.html' : rel);
  if (!f.startsWith(dist) || !fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); r.end(fs.readFileSync(f));
}).listen(0);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 300 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${server.address().port}/?q=low&simseed=3`);
await page.waitForFunction(() => window.__game && window.__game.mode === 'menu', null, { timeout: 120000 });
let failures = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); if (!ok) failures++; };

const res = await page.evaluate(async () => {
  const g = window.__game; g.stop(); g.render.render = () => {};
  for (let i = 0; i < 90; i++) g._simulate(1 / 30);
  const team = 1, ai = g.ai, flags = g.capture.flags;
  for (const c of ai.commanders) c.think = () => {};
  const sim = (sec, until) => { for (let i = 0; i < sec * 30; i++) { g._simulate(1 / 30); if (until && i % 15 === 0 && until()) return true; } return false; };
  const log = [];
  const truck = g.vehicles.list.find((v) => v.def.type === 'truck' && v.spawn.team === team && v.alive);
  const q = ai.squads.squads.find((x) => x.team === team && x.kind === 0 && x.alive >= 4);
  // Bring the squad and an empty, crewed truck together at the base.
  for (let i = 0; i < q.count; i++) { const s = g.soldiers[q.members[i]]; if (s.alive && !s.vehicle) { s.pos.set(truck.pos.x + 6 + (i % 3), s.pos.y, truck.pos.z + (i % 4)); s.ai.reset(); } }
  sim(8);
  // A friendly objective a few hundred metres off (a trip worth riding, away from the fighting where possible).
  const dist = (f) => Math.hypot(f.x - truck.pos.x, f.z - truck.pos.z);
  const far = flags.filter((f) => !f.base && f.owner === team && dist(f) > 280).sort((a, b) => dist(a) - dist(b))[0] || flags.find((f) => !f.base);
  const order = (x, z) => { q.order = 2; q.destX = x; q.destZ = z; q.destR = 25; q.planTime = -100; q.objective = far; q.objectiveTime = g.time; };
  order(far.x, far.z);
  const states = [];
  const watch = () => { const st = q.transportState; if (states[states.length - 1] !== st) states.push(st); };
  const rideV = () => q.transport;
  sim(30, () => { watch(); return q.transportState === 'riding'; });
  const tv = rideV();
  sim(200, () => { watch(); return q.transportState === 'standby' || q.transportState === 'escort' || q.transportState === 'released'; });
  const afterDrop = { state: q.transportState, why: q.transportWhy, vehSupports: tv >= 0 ? ai.orchestrator.manifests[tv].supports : -2 };
  // Squad needs to go far again: its own transport should come back for it.
  // A second leg long enough to be worth riding (350-700 m), on our side.
  const dq = (f) => Math.hypot(f.x - q.cx, f.z - q.cz);
  const back = flags.filter((f) => f.owner === team && dq(f) > 350 && dq(f) < 700).sort((a, b) => dq(a) - dq(b))[0] || flags.find((f) => f.base && f.owner === team);
  order(back.x + (back.base ? 60 : 0), back.z);
  let blockedBy = '';
  const picked = sim(200, () => {
    watch();
    const c = new Float32Array(2);
    if (!window.__pc) window.__pc = {};
    const k = `contact:${q.contactCentroid(g.time, 8, c) > 0} veh:${q.vehicle} goal>260:${Math.hypot(q.destX - q.cx, q.destZ - q.cz) > 260} near600:${tv >= 0 && Math.hypot(q.cx - g.vehicles.list[tv].pos.x, q.cz - g.vehicles.list[tv].pos.z) < 600} rel:${q.transport === tv}`;
    window.__pc[k] = (window.__pc[k] || 0) + 1;
    blockedBy = q.contactCentroid(g.time, 8, c) > 0 ? 'squad in contact' : q.transport !== tv ? 'relationship ended: ' + q.transportWhy : q.dismounted < 2 ? 'too few dismounted' : '';
    return q.transportState === 'riding' && q.transport === tv;
  });
  const sawContact = Object.keys(window.__pc || {}).some((k) => k.startsWith('contact:true'));
  if (!picked && sawContact) blockedBy = 'squad under fire during the window (no pickups under fire)';
  else if (!picked && q.transport === tv) {
    const v = g.vehicles.list[tv], mm = ai.orchestrator.manifests[tv], gl = new Float32Array(2);
    const { squadGoal } = { squadGoal: null };
    blockedBy = `diag: mode ${mm.mode} supports ${mm.supports} ${mm.supportState} squadId ${mm.squadId} driver ${!!(v.driver && v.driver.ai)} opPhase ${mm.opPhase} qveh ${q.vehicle} dism ${q.dismounted} goalD ${Math.round(Math.hypot(q.destX - q.cx, q.destZ - q.cz))} vehD ${Math.round(Math.hypot(q.cx - v.pos.x, q.cz - v.pos.z))} order ${q.order}`;
  }
  // Destroy the transport while it is with the squad: the squad must know.
  sim(10);
  const endedBefore = q.transport < 0 ? { state: q.transportState, why: q.transportWhy } : null;
  if (q.transport >= 0) g.vehicles.list[q.transport].damage(1e6, null);
  sim(2);
  watch();
  const lost = { state: q.transportState, why: q.transportWhy, endedBefore };
  log.push(states.join(' → '));
  // Extraction: a squad far from friends asks to be pulled out; an idle carrier should answer it.
  const q2 = ai.squads.squads.find((x) => x !== q && x.team === team && x.kind === 0 && x.alive >= 2 && x.vehicle < 0);
  const carrier = g.vehicles.list.find((v) => v.alive && v.spawn.team === team && (v.def.type === 'truck' || v.def.type === 'apc') && v.seats[0] && !v.seats.some((o, i) => i > 0 && o) && v.id !== tv);
  let ext = null;
  if (q2 && carrier) {
    for (let i = 0; i < q2.count; i++) { const s = g.soldiers[q2.members[i]]; if (s.alive && !s.vehicle) { s.pos.set(carrier.pos.x + 140 + (i % 3) * 2, s.pos.y, carrier.pos.z + 20 + (i % 2) * 2); s.ai.reset(); } }
    q2.order = 2; q2.destX = carrier.pos.x + 140; q2.destZ = carrier.pos.z + 20; q2.destR = 15;
    sim(3);
    ai.radio.teamCooldown.fill(0); ai.radio.senderCooldown.fill(0);
    const m = ai.radio.publish(5, team, q2.leader, q2.id, q2.cx, 0, q2.cz, -1, 1, g.time);
    q2.extractMsg = m; q2.extractMsgId = m ? m.id : 0; q2.extractState = m ? 'requested' : 'none'; q2.extractT = g.time;
    const ex = [];
    const modes = [];
    const done = sim(240, () => {
      if (ex[ex.length - 1] !== q2.extractState) ex.push(q2.extractState);
      const c = m && m.claimedBy >= 0 ? g.vehicles.list[m.claimedBy] : null;
      if (c) { const mm = ai.orchestrator.manifests[c.id], k = `${c.id}:${mm.mode}:${mm.supportState}:${Math.round(Math.hypot(c.pos.x - q2.cx, c.pos.z - q2.cz))}m`; if (modes[modes.length - 1] !== k) modes.push(k); }
      return q2.extractState === 'done' || q2.extractState === 'denied';
    });
    ext = { states: ex.join(' → '), done, by: m && m.claimedBy, modes: modes.slice(-12).join(' | '), q2: [q2.alive, q2.dismounted, q2.vehicle] };
  }
  return { pc: window.__pc, log, tv, afterDrop, picked, blockedBy, lost, ext, rel: ai.orchestrator.stats.rel };
});
console.log(JSON.stringify(res));
check('squad boards its transport and rides', res.log[0].includes('boarding') && res.log[0].includes('riding'), res.log[0]);
check('relationship survives the drop (standby / escort, both sides agree)', (res.afterDrop.state === 'standby' || res.afterDrop.state === 'escort') && res.afterDrop.vehSupports >= 0, JSON.stringify(res.afterDrop));
check('its own transport comes back to pick it up (or a valid reason not to)', res.picked || (res.blockedBy !== '' && !res.blockedBy.startsWith('diag')), res.picked ? '' : `withheld: ${res.blockedBy}`);
check('squad knows when its transport is destroyed (or the link had already ended for a stated reason)',
  res.lost.state === 'lost' || (res.lost.endedBefore && res.lost.endedBefore.why !== ''), JSON.stringify(res.lost));
check('extraction request is answered and carried out', !!res.ext && res.ext.states.endsWith('done') && res.ext.states.includes('coming'), JSON.stringify(res.ext));
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close(); server.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
