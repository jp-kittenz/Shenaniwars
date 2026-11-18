// Browser check of vehicle occupants: exterior riders on armour (board, ride,
// get thrown clear), turned-out crews and hatches, doors, enter / exit
// transitions, the seat view (interior drawn, camera at the seat, easing
// between seats) and animated controls. Optional screenshots.
// Usage: npm run build && node tools/vehicle-occupants-test.mjs [quality=medium] [screenshotDir]
import { createRequire } from 'node:module';
import { preview } from 'vite';

const { chromium } = createRequire(import.meta.url)('playwright');
const quality = process.argv[2] || 'medium';
const shots = process.argv[3] || '';
const server = await preview({ preview: { port: 4183, strictPort: true }, logLevel: 'error' });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.stack || e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
let failures = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); if (!ok) failures++; };
const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/occupants-${name}.png` }); };

await page.goto(`http://localhost:4183/?q=${quality}`);
await page.waitForFunction(() => window.__game && !document.getElementById('menu-main').classList.contains('hidden'), null, { timeout: 90000 });
await page.click('#btn-deploy');
await page.waitForFunction(() => window.__game.mode === 'playing' && window.__game.player.alive, null, { timeout: 30000 });

// Stage: a vehicle of `type` on the player's runway, locked from the AI, emptied; returns its id.
await page.evaluate(() => {
  const g = window.__game;
  window.__stage = (type, lane) => {
    const p = g.player;
    let v = g.vehicles.list.find((x) => x.def.type === type && x.alive);
    if (!v) { v = g.vehicles.list.find((x) => x.def.type === type); v.reset(); }
    g.ai.orchestrator.lock(v, true);
    for (const o of v.seats.slice()) if (o) v.exit(o);
    const rw = g.map.runways.find((r) => r.team === p.team) || g.map.runways[0];
    const along = 60 + lane * 30, side = 14;
    const x = rw.x0 + rw.dx * along - rw.dz * side, z = rw.z0 + rw.dz * along + rw.dx * side;
    const y = g.map.terrain.height(x, z) + v.def.ride + 0.05;
    v.body.setTranslation({ x, y, z }, true);
    v.body.setRotation({ x: 0, y: Math.sin(rw.yaw / 2), z: 0, w: Math.cos(rw.yaw / 2) }, true);
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    v.teleported(); v.team = p.team;
    return v.id;
  };
  // Bots of the player's team that are not in a vehicle, nearest first.
  window.__bots = (n) => g.soldiers.filter((s) => s.alive && !s.isPlayer && s.team === g.player.team && !s.vehicle && s.ai).slice(0, n);
  window.__sim = async (sec) => { const t0 = g.time; while (g.time - t0 < sec) await new Promise((r) => setTimeout(r, 30)); };
  window.__look = (v, back, up, side = 0) => {
    // Parks the player beside the vehicle (out of the seat) looking at it.
    const p = g.player;
    if (p.vehicle) p.vehicle.exit(p);
    const f = new v.pos.constructor(0, 0, 1).applyQuaternion(v.quat);
    p.pos.set(v.pos.x - f.x * back + f.z * side, v.pos.y + up, v.pos.z - f.z * back - f.x * side);
    p.yaw = Math.atan2(v.pos.x - p.pos.x, v.pos.z - p.pos.z); p.pitch = -0.25;
  };
});

// 1) Riders on a battle tank: board, are drawn and exposed, sit on the deck, follow the hull, get thrown clear.
const riders = await page.evaluate(async () => {
  const g = window.__game, id = window.__stage(g.player.team === 0 ? 'tank' : 'mbt', 0), v = g.vehicles.list[id];
  const bots = window.__bots(6);
  const seats = [];
  for (let i = 0; i < v.seats.length; i++) if (v.def.seats[i].role === 'rider') seats.push(i);
  let n = 0;
  for (const b of bots) { if (n >= seats.length) break; b.ai.reset && b.ai.reset(); if (v.enter(b, seats[n]) >= 0) n++; }
  await window.__sim(1.2);
  const onDeck = seats.slice(0, n).every((i) => { const o = v.seats[i]; return o && Math.abs(o.pos.y - (v.pos.y + v.def.seats[i].pos[1])) < 0.6; });
  const exposed = seats.slice(0, n).every((i) => v.seatExposed(i));
  window.__look(v, 9, 3.2, 5);
  return { id, n, cap: seats.length, onDeck, exposed, transitions: v.seats.filter(Boolean).every((o) => o.transT === 0) };
});
check('riders board every exterior position', riders.n === riders.cap && riders.cap >= 4, JSON.stringify(riders));
check('riders sit on the deck after the climb-in transition', riders.onDeck && riders.transitions);
check('riders are visible and can be shot', riders.exposed);
await page.evaluate(() => window.__sim(0.6));
await shot('1-riders');

// 2) Driving: riders stay attached to the moving hull; destroying it throws them clear alive (hurt).
const ride = await page.evaluate(async (id) => {
  const g = window.__game, v = g.vehicles.list[id];
  // Move the hull directly (a bot driver would follow its own orders): riders must ride along with it.
  const p0 = v.pos.clone();
  let maxOff = 0;
  for (let k = 0; k < 20; k++) {
    const f = v.pos.clone().set(0, 0, 1).applyQuaternion(v.quat);
    v.body.setLinvel({ x: f.x * 5, y: v.body.linvel().y, z: f.z * 5 }, true);
    v.body.setAngvel({ x: 0, y: 0.3, z: 0 }, true);
    await window.__sim(0.1);
    for (let i = 0; i < v.seats.length; i++) {
      const o = v.seats[i];
      if (!o || v.def.seats[i].role !== 'rider') continue;
      const w = v.seatWorld(i, o.pos.clone());
      maxOff = Math.max(maxOff, o.pos.distanceTo(w));
    }
  }
  const moved = v.pos.distanceTo(p0);
  const ridersBefore = v.seats.filter((o, i) => o && v.def.seats[i].role === 'rider');
  v.damage(1e6, null);
  await window.__sim(0.8);
  const thrown = ridersBefore.filter((o) => o.alive && !o.vehicle).length;
  return { moved, maxOff, riders: ridersBefore.length, thrown };
}, riders.id);
check('riders stay on the moving hull', ride.moved > 3 && ride.maxOff < 0.05, JSON.stringify(ride));
check('riders are thrown clear when the vehicle is destroyed', ride.thrown > 0 && ride.thrown === ride.riders);

// 3) Turned-out crew and hatches; buttoning up in combat.
const hatch = await page.evaluate(async () => {
  const g = window.__game, team = g.player.team;
  const type = team === 0 ? 'tank' : 'mbt';
  const id = window.__stage(type, 2), v = g.vehicles.list[id];
  const crew = window.__bots(3);
  for (let i = 0; i < Math.min(crew.length, v.seats.length); i++) if (v.def.seats[i].role !== 'rider') v.enter(crew[i], i);
  await window.__sim(2);
  const withHatch = v.visual.hatches.map((h) => h.seat).filter((s) => v.seats[s]);
  const open = withHatch.length > 0 && withHatch.every((s) => v.hatchOpen[s] > 0.8);
  const visible = withHatch.every((s) => v.seatExposed(s));
  window.__look(v, -8, 3, 6);
  return { id, hatches: v.visual.hatches.length, withHatch: withHatch.length, open, visible };
});
check('crews turn out of open hatches when there is no fight', hatch.hatches > 0 && hatch.open && hatch.visible, JSON.stringify(hatch));
await page.evaluate(() => window.__sim(0.4));
await shot('2-turned-out');
const button = await page.evaluate(async (id) => {
  const g = window.__game, v = g.vehicles.list[id];
  v.damage(1, null);
  await window.__sim(1.5);
  return v.visual.hatches.every((h) => v.hatchOpen[h.seat] < 0.2) && v.visual.hatches.every((h) => !v.seats[h.seat] || !v.seatExposed(h.seat));
}, hatch.id);
check('a hit buttons the crew up (hatches shut, crew hidden)', button);

// 4) Doors and climb-in / climb-out transitions on a carrier.
const doors = await page.evaluate(async () => {
  const g = window.__game, team = g.player.team;
  const type = team === 0 ? 'jeep' : 'ifv';
  const id = window.__stage(type, 4), v = g.vehicles.list[id];
  const b = window.__bots(1)[0];
  const from = b.pos.clone();
  b.pos.set(v.pos.x + 3, v.pos.y - v.def.ride, v.pos.z);
  v.enter(b, v.def.seats.findIndex((s) => s.role === 'passenger'));
  await window.__sim(0.2);
  const mid = b.transT > 0;
  await window.__sim(0.6);
  const seated = b.transT === 0;
  const opened = v.doorOpen.length === 0 || Math.max(...v.doorOpen) > 0.5;
  v.exit(b);
  const out0 = b.pos.clone();
  await window.__sim(0.25);
  const sliding = b.transT > 0 && b.pos.distanceTo(out0) > 0.05;
  await window.__sim(0.5);
  void from;
  return { type, doors: v.doorOpen.length, mid, seated, opened, sliding, landed: b.transT === 0 };
});
check('climb-in transition plays, then the soldier is seated', doors.mid && doors.seated, JSON.stringify(doors));
check('doors open while people get in or out', doors.opened);
check('climb-out transition moves the soldier to the ground', doors.sliding && doors.landed);

// 5) Seat view: camera at the seat, interior drawn, body hidden; easing to another seat; controls animate.
for (const [type, lane] of [[0, 'jeep'], [1, 'truck'], [0, 'heli'], [1, 'transportheli'], [1, 'ifv'], [1, 'mbt']].map(([t, ty], i) => [ty, 6 + i])) {
  const r = await page.evaluate(async ([type, lane]) => {
    const g = window.__game, p = g.player;
    const v0 = g.vehicles.list.find((x) => x.def.type === type);
    if (!v0) return { skipped: true };
    const id = window.__stage(type, lane), v = g.vehicles.list[id];
    if (p.vehicle) p.vehicle.exit(p);
    p.pos.copy(v.pos);
    v.enter(p, 0);
    const pc = g.playerCtl;
    pc._setSeatView(true);
    await window.__sim(0.4);
    const rest = v.visual.controls.map((c) => c.node.rotation.x + c.node.rotation.z);
    // Push the stick / turn the wheel through the player's own input.
    g.input._keys.KeyW = true; g.input._keys.KeyA = true;
    await window.__sim(0.6);
    const eye = v.seatEye(0, v.pos.clone());
    const cam = g.render.camera.position;
    const atSeat = cam.distanceTo(eye) < 0.3;
    const interior = v.visual.interior.visible && v.visual.interior.children.length > 0;
    const hidden = pc.firstPerson;
    const moved = v.visual.controls.some((c, i) => Math.abs(c.node.rotation.x + c.node.rotation.z - rest[i]) > 0.02);
    g.input._keys.KeyW = false; g.input._keys.KeyA = false;
    // Switch seat: the camera eases from the old eye to the new one.
    const before = cam.clone();
    const switched = v.switchSeat(p);
    await window.__sim(0.1);
    const easing = switched ? cam.distanceTo(v.seatEye(p.seat, v.pos.clone())) > 0.02 && cam.distanceTo(before) > 0.0 : true;
    await window.__sim(0.6);
    const arrived = cam.distanceTo(v.seatEye(p.seat, v.pos.clone())) < 0.3;
    return { type, atSeat, interior, hidden, moved, controls: v.visual.controls.length, switched, easing, arrived };
  }, [type, lane]);
  if (r.skipped) { console.log(`SKIP  seat view ${type}`); continue; }
  check(`seat view ${type}: camera at the seat, interior drawn, own body hidden`, r.atSeat && r.interior && r.hidden, JSON.stringify(r));
  check(`seat view ${type}: controls animate`, r.controls === 0 || r.moved);
  check(`seat view ${type}: eases to the next seat`, r.easing && r.arrived);
  await shot(`3-seat-${type}`);
}

// 6) Frame cost with occupants drawn (a few frames).
const frame = await page.evaluate(async () => {
  const times = []; let last = performance.now();
  await new Promise((res) => { let n = 0; const f = () => { const t = performance.now(); times.push(t - last); last = t; if (++n < 90) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
  times.sort((a, b) => a - b);
  return { median: times[45], calls: window.__game.render.renderer.info.render.calls };
});
console.log('frame', JSON.stringify(frame));
check('no errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.httpServer.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
