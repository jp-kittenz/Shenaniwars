// Browser end-to-end check: boots the built game in headless Chromium, deploys,
// exercises infantry + every vehicle, and reports errors and frame stats.
// Usage: npm run build && node tools/e2e.mjs [quality] [screenshotDir]
import { createRequire } from 'node:module';
import { preview } from 'vite';

// Playwright is expected to be installed globally (it is not a project dependency).
const { chromium } = createRequire(import.meta.url)('playwright');
const quality = process.argv[2] || 'high';
const shots = process.argv[3] || '';
const server = await preview({ preview: { port: 4179, strictPort: true }, logLevel: 'error' });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.stack || e.message}`));
let failures = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); if (!ok) failures++; };
const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${quality}-${name}.png` }); };
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(`http://localhost:4179/?q=${quality}&debug`);
await page.waitForFunction(() => window.__game && !document.getElementById('menu-main').classList.contains('hidden'), null, { timeout: 90000 });
await wait(2500);
await shot('1-menu');
check('boots to menu', await page.evaluate(() => window.__game.mode === 'menu'));

await page.click('#btn-deploy');
await wait(1500);
check('deploys and spawns player', await page.evaluate(() => window.__game.mode === 'playing' && window.__game.player.alive));
await shot('2-spawn');

// Walk + shoot.
await page.evaluate(() => { const g = window.__game; g.input._keys.KeyW = true; g.input._mouseFire = true; });
await wait(1500);
const moved = await page.evaluate(() => { const g = window.__game; g.input._keys.KeyW = false; g.input._mouseFire = false; return { speed: g.player.speed, ammo: g.player.weapon.ammo }; });
check('player moves and fires', moved.ammo < 30, JSON.stringify(moved));

// Let the battle develop, sampling frame times.
const stats = await page.evaluate(async () => {
  const g = window.__game; const times = [];
  let last = performance.now();
  await new Promise((res) => { let n = 0; const f = () => { const now = performance.now(); times.push(now - last); last = now; if (++n < 240) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
  times.sort((a, b) => a - b);
  const info = g.render.renderer.info;
  let meshes = 0, shadowCasters = 0;
  g.render.scene.traverseVisible((o) => { if (o.isMesh || o.isPoints) { meshes++; if (o.castShadow) shadowCasters++; } });
  return { meshes, shadowCasters, median: times[120], p95: times[228], calls: info.render.calls, tris: info.render.triangles, alive: g.soldiers.filter((s) => s.alive).length, total: g.soldiers.length,
    states: g.ai.agents.filter(Boolean).reduce((m, a) => (m[a.state] = (m[a.state] || 0) + 1, m), {}),
    ai: { ...g.ai.stats }, crewed: g.vehicles.list.filter((v) => v.occupied).length,
    launchers: g.soldiers.filter((s) => !s.isPlayer && s.launcher).length, bots: g.soldiers.filter((s) => !s.isPlayer).length };
});
console.log('frame stats', JSON.stringify(stats));
check('bots are alive and acting', stats.alive > stats.total * 0.5 && Object.keys(stats.states).length >= 2);
check('AI clock runs perception and tactics', stats.ai.perceptionHz > 50 && stats.ai.tacticalHz > 40, JSON.stringify(stats.ai));
check('only AT-class bots carry launchers', stats.launchers > 0 && stats.launchers < stats.bots * 0.25, `${stats.launchers}/${stats.bots}`);
// Per-tier draw-call sanity bounds (shadow passes included). Vehicles keep full quality at every range, so these
// only catch runaway growth (e.g. a leak of meshes); frame rate is managed by the frame cap and resolution governor.
const budget = { low: 700, medium: 1000, high: 1200 }[quality];
check('draw calls within tier budget', stats.calls < budget, `calls=${stats.calls} budget=${budget} tris=${stats.tris}`);

// Vehicles: move one of each type onto the open runway, board it and drive / fly.
for (const type of ['jeep', 'tank', 'heli', 'mbt', 'attackheli', 'strikejet']) {
  const r = await page.evaluate(async (type) => {
    const g = window.__game, p = g.player;
    const simWait = async (sec) => { const t0 = g.time; while (g.time - t0 < sec) await new Promise((res) => setTimeout(res, 50)); };
    if (!p.alive) { p.respawnTimer = 0; await simWait(0.5); }
    if (p.vehicle) p.vehicle.exit(p);
    let v = g.vehicles.list.find((v) => v.def.type === type && v.alive);
    if (!v) { v = g.vehicles.list.find((v) => v.def.type === type); if (!v) return { skipped: 'no such vehicle' }; v.reset(); }
    // Commandeer it from the bots and keep them from climbing back in during the test.
    g.ai.orchestrator.lock(v, true);
    for (const occ of v.seats.slice()) if (occ) v.exit(occ);
    // The player's own base runway (its SAM sites will not engage the test aircraft).
    const rw = g.map.runways.find((r) => r.team === p.team) || g.map.runways[0];
    // Jets take the centre line; everything else gets its own lane beside it.
    const lane = ['jeep', 'tank', 'heli', 'mbt', 'attackheli', 'strikejet'].indexOf(type);
    const jet = v.def.kind === 'jet';
    const along = jet ? 30 : 60 + lane * 28, side = jet ? 0 : 10;
    const x = rw.x0 + rw.dx * along - rw.dz * side, z = rw.z0 + rw.dz * along + rw.dx * side, yaw = rw.yaw;
    const y = g.map.terrain.height(x, z) + v.def.ride + 0.05;
    v.body.setTranslation({ x, y, z }, true);
    v.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    v.teleported();
    await simWait(0.4);
    // Board (retrying: the player can be killed or knocked aside by the battle around the runway).
    for (let attempt = 0; attempt < 3 && p.vehicle !== v; attempt++) {
      if (!p.alive) { p.respawnTimer = 0; await simWait(0.5); }
      if (p.vehicle) p.vehicle.exit(p);
      p.pos.set(v.pos.x + Math.cos(yaw) * (v.def.half[0] + 1.5), g.map.terrain.height(v.pos.x, v.pos.z), v.pos.z - Math.sin(yaw) * (v.def.half[0] + 1.5));
      p.health = 1e6;
      await simWait(0.3);
      g.input._edges.interact = true;
      await simWait(0.3);
    }
    if (p.vehicle !== v) {
      return { entered: false, near: g.playerCtl.nearVehicle && g.playerCtl.nearVehicle.def.type, alive: v.alive, alt: +v.altitude.toFixed(1), occ: v.occupants, playerAlive: p.alive };
    }
    const start = v.pos.clone();
    let killedBy = null;
    const off = g.bus.on('vehicle:destroyed', (dv, attacker) => { if (dv === v) killedBy = attacker ? `${attacker.name} (${attacker.team === p.team ? 'friendly' : 'enemy'})` : 'crash/self'; });
    if (v.def.kind === 'heli') { g.input._keys.Space = true; await simWait(2.5); g.input._keys.KeyW = true; }
    else if (v.def.kind === 'jet') g.input._keys.Space = true;
    else g.input._keys.KeyW = true;
    await simWait(v.def.kind === 'jet' ? 7 : 5);
    g.input._mouseFire = true;
    await simWait(0.5);
    g.input._mouseFire = false;
    off();
    const result = { entered: true, moved: +start.distanceTo(v.pos).toFixed(1), alt: +v.altitude.toFixed(1), hp: Math.round(v.health), speed: +v.airspeed.toFixed(1), killedBy };
    // Hand the vehicle back to its pad so it cannot fall or roll into the next test's lane.
    v.exit(p);
    v.reset();
    g.ai.orchestrator.lock(v, false);
    return result;
  }, type);
  await shot(`3-${type}`);
  await page.evaluate(() => { const g = window.__game; g.input._keys = {}; });
  // Losing the vehicle to enemy fire is part of the battle; losing it to a crash is a bug.
  const survived = r.hp > 0 || (r.killedBy && r.killedBy.endsWith('(enemy)'));
  check(`${type}: board and move`, r.entered && r.moved > 4 && survived, JSON.stringify(r));
}
await page.evaluate(() => { const g = window.__game, p = g.player; if (p.vehicle) p.vehicle.exit(p); p.health = 100; });

// Save / restore round trip.
const rt = await page.evaluate(() => {
  const g = window.__game;
  const before = JSON.stringify(g.state.snapshot().data.capture);
  const ok = g.state.save('e2e');
  g.capture.tickets[0] = 3;
  const loaded = g.state.load('e2e');
  return { ok, loaded, same: JSON.stringify(g.state.snapshot().data.capture) === before };
});
check('state save/restore round-trips', rt.ok && rt.loaded && rt.same, JSON.stringify(rt));

// Pause.
await page.evaluate(() => window.__game.pause());
await wait(300);
check('pause shows menu', await page.evaluate(() => window.__game.mode === 'paused' && !document.getElementById('menu').classList.contains('hidden')));
await shot('4-pause');

const real = errors.filter((e) => !/GPU stall|GL Driver Message|swiftshader|Automatic fallback to software/i.test(e));
check('no console errors', real.length === 0, real.slice(0, 8).join('\n'));
await browser.close();
await server.close();
process.exit(failures ? 1 : 0);
