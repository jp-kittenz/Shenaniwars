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
    states: g.ai.agents.reduce((m, a) => (m[a.state] = (m[a.state] || 0) + 1, m), {}) };
});
console.log('frame stats', JSON.stringify(stats));
check('bots are alive and acting', stats.alive > stats.total * 0.5 && Object.keys(stats.states).length >= 2);
check('draw calls within mobile budget', stats.calls < 320, `calls=${stats.calls}`);

// Vehicles: teleport next to each type, board, drive/fly.
for (const type of ['jeep', 'tank', 'heli']) {
  const r = await page.evaluate(async (type) => {
    const g = window.__game, p = g.player;
    if (!p.alive) return { skipped: 'dead' };
    if (p.vehicle) p.vehicle.exit(p);
    const v = g.vehicles.list.find((v) => v.def.type === type && v.team === 0 && v.alive);
    if (!v) return { skipped: 'none alive' };
    for (const occ of v.seats.slice()) if (occ) v.exit(occ); // commandeer it from the bots
    p.pos.set(v.pos.x + 3.2, v.pos.y, v.pos.z);
    p.health = 1e6;
    await new Promise((r) => setTimeout(r, 200));
    g.input._edges.interact = true;
    await new Promise((r) => setTimeout(r, 300));
    if (p.vehicle !== v) return { entered: false };
    const start = v.pos.clone();
    if (type === 'heli') { g.input._keys.Space = true; g.input._keys.KeyW = true; } else g.input._keys.KeyW = true;
    const simWait = async (sec) => { const t0 = g.time; while (g.time - t0 < sec) await new Promise((r) => setTimeout(r, 50)); };
    await simWait(5);
    g.input._mouseFire = true;
    await simWait(0.4);
    g.input._mouseFire = false;
    const out = { entered: true, moved: +start.distanceTo(v.pos).toFixed(1), alt: +(v.pos.y - g.map.terrain.height(v.pos.x, v.pos.z)).toFixed(1), hp: v.health };
    return out;
  }, type);
  await shot(`3-${type}`);
  await page.evaluate(() => { const g = window.__game; g.input._keys = {}; });
  check(`${type}: board and move`, r.entered && r.moved > 4, JSON.stringify(r));
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
