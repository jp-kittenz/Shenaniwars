// Endgame verification (headless, accelerated): forces one side off every
// objective, then checks the siege rules, HQ invulnerability, the AI's SIEGE
// operation, that the phase change does not make every squad drop its task at
// once, the recapture → barrage rule and the HQ win condition.
// Usage: npm run build && node tools/endgame-test.mjs
import { createRequire } from 'node:module';
import { preview } from 'vite';

const { chromium } = createRequire(import.meta.url)('playwright');
const server = await preview({ preview: { port: 4186, strictPort: true }, logLevel: 'error' });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 300 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
await page.goto('http://localhost:4186/?q=low');
await page.waitForFunction(() => window.__game && window.__game.mode === 'menu', null, { timeout: 90000 });
let failures = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); if (!ok) failures++; };
const sim = (sec) => page.evaluate((sec) => { const g = window.__game; for (let i = 0; i < sec * 30; i++) { g._simulate(1 / 30); if (window.__hold) window.__force(); } return g.time; }, sec);

await page.evaluate(() => {
  const g = window.__game;
  g.stop(); g.render.render = () => {};
  window.__log = [];
  g.bus.on('ai:op', (team, text) => window.__log.push(`${g.time.toFixed(0)}s [${team ? 'T' : 'P'}] ${text}`));
  g.bus.on('endgame:phase', (team, ph) => window.__log.push(`${g.time.toFixed(0)}s PHASE ${team ? 'TORSA' : 'PAMPALONA'} ${ph}`));
  g.bus.on('endgame:barrage', (team, x, z) => window.__log.push(`${g.time.toFixed(0)}s BARRAGE by ${team ? 'TORSA' : 'PAMPALONA'} at ${x.toFixed(0)},${z.toFixed(0)}`));
  g.bus.on('endgame:hq', (team, left) => window.__log.push(`${g.time.toFixed(0)}s HQ down ${team ? 'TORSA' : 'PAMPALONA'} (${left} left)`));
});
await sim(90);
// Torsa takes every objective; Pampalona is pushed back into its base (its vehicles parked).
await page.evaluate(() => {
  const g = window.__game, base = g.map.bases[0];
  // Pampalona keeps FOXTROT for the first 40 s (operations settle first), then loses it too.
  window.__keep = 'FOXTROT';
  window.__force = () => {
    for (const f of g.capture.flags) {
      if (f.base) continue;
      const want = f.name === window.__keep ? 0 : 1;
      if (f.owner !== want) { f.owner = want; f.v = want ? 1 : -1; f.contestedBy = -1; g.bus.emit('flag:changed', f, want); }
    }
  };
  for (const s of g.soldiers) {
    if (s.team !== 0 || !s.alive) continue;
    if (s.vehicle) s.vehicle.exit(s);
    const a = Math.random() * 6.283, r = Math.random() * 25;
    s.pos.set(base.infantry.x + Math.cos(a) * r, 0, base.infantry.z + Math.sin(a) * r);
    s.pos.y = g.map.terrain.baseHeight(s.pos.x, s.pos.z);
  }
  window.__force();
  window.__hold = true;
  g.bus.flush();
});
// Sample Torsa squad assignments every 0.5 s through the transition.
const churn = await page.evaluate(() => {
  const g = window.__game, out = [];
  const snap = () => g.ai.squads.squads.filter((q) => q.team === 1 && q.kind === 0 && q.alive > 0).map((q) => `${q.id}:${q.opId}:${q.garrison}:${q.order}`);
  let prev = snap();
  for (let k = 0; k < 160; k++) {
    if (k === 80) window.__keep = '';
    for (let i = 0; i < 15; i++) { g._simulate(1 / 30); window.__force(); }
    const cur = snap();
    const before = new Map(prev.map((s) => [s.split(':')[0], s]));
    let changed = 0;
    const diffs = [];
    for (const s of cur) if (before.get(s.split(':')[0]) !== s) { changed++; diffs.push(`${before.get(s.split(':')[0])}→${s}`); }
    out.push({ t: g.time, changed, total: cur.length, phase: g.capture.phase[0], diffs });
    prev = cur;
  }
  return out;
});
const siegeAt = churn.find((c) => c.phase === 'siege');
check('siege starts after holding nothing for the delay', !!siegeAt && siegeAt.t - churn[80].t > 19 && siegeAt.t - churn[80].t < 21.5,
  siegeAt ? `+${(siegeAt.t - churn[80].t).toFixed(1)} s after losing the last objective` : '');
const around = churn.filter((c) => siegeAt && c.t >= siegeAt.t - 2 && c.t <= siegeAt.t + 12);
const maxFrac = Math.max(0, ...around.map((c) => c.changed / Math.max(1, c.total)));
for (const c of around) if (c.changed > 1) console.log(`      ${c.t.toFixed(1)}s ${c.diffs.join('  ')}`);
check('phase change does not reassign every squad at once', around.length > 0 && maxFrac < 0.5,
  `max ${(maxFrac * 100).toFixed(0)}% of squads changed in one 0.5 s step from the switch on: ${around.map((c) => `${c.changed}/${c.total}`).join(' ')}`);
const st = await page.evaluate(() => {
  const g = window.__game, base = g.map.bases[0];
  const hq = base.hq.map((id) => g.map.buildings[id]);
  return { exposed: hq.every((b) => !b.invulnerable), other: g.map.buildings.filter((b) => b.team === 1).every((b) => b.invulnerable),
    siegeOp: g.ai.commanders[1].ops.some((o) => o.active && o.type === 4), journal: g.ai.commanders[1].journal.slice(-6) };
});
check('exposed side: base buildings vulnerable; the other side still protected', st.exposed && st.other);
check('attacker plans a SIEGE operation', st.siegeOp, st.journal.join(' / '));
// Let the siege run and see whether attackers engage the HQ on their own.
await sim(150);
const dmg = await page.evaluate(() => {
  const g = window.__game;
  return g.map.bases[0].hq.map((id) => { const b = g.map.buildings[id]; return `${Math.round(b.hp)}/${b.maxHp}`; }).join(' ');
});
console.log(`      HQ hit points after 150 s of siege: ${dmg}`);
await page.evaluate(() => { window.__hold = false; });
// Pampalona retakes LIMA: the siege lifts, the base is protected again, a barrage may fall on massed attackers.
const rec = await page.evaluate(() => {
  const g = window.__game, f = g.capture.flags.find((x) => x.name === 'LIMA');
  // Place an attacking cluster outside the Pampalona walls so the barrage has a target.
  const b = g.map.bases[0];
  let placed = 0;
  for (const s of g.soldiers) if (s.team === 1 && s.alive && !s.vehicle && placed < 6) { s.pos.set(b.x + 150 + placed * 3, g.map.terrain.height(b.x + 150, b.z + 40), b.z + 40); placed++; }
  f.owner = 0; f.v = -1; g.bus.emit('flag:changed', f, 0); g.bus.flush();
  for (let i = 0; i < 15; i++) g._simulate(1 / 30);
  return { phase: g.capture.phase[0], protected: g.map.bases[0].hq.every((id) => g.map.buildings[id].invulnerable), barrage: !!g.capture.barrage };
});
check('recapture lifts the siege and restores invulnerability', rec.phase === 'normal' && rec.protected);
check('recapture after a long siege calls the comeback barrage', rec.barrage);
const deaths = await page.evaluate(() => { const g = window.__game; const k0 = g.capture.tickets[1]; for (let i = 0; i < 20 * 30; i++) g._simulate(1 / 30); return k0 - g.capture.tickets[1]; });
console.log(`      Torsa tickets lost during the barrage window: ${deaths}`);
const again = await page.evaluate(() => {
  const g = window.__game; const pre = g.capture.barrageAt[0];
  const f = g.capture.flags.find((x) => x.name === 'LIMA');
  for (let i = 0; i < 30 * 30; i++) { g._simulate(1 / 30); window.__force(); }
  const exposed = g.capture.phase[0] === 'siege';
  f.owner = 0; f.v = -1; g.bus.emit('flag:changed', f, 0); g.bus.flush();
  for (let i = 0; i < 30; i++) g._simulate(1 / 30);
  return { exposed, sameBarrage: g.capture.barrageAt[0] === pre };
});
check('flip-flopping a flag cannot chain barrages (cooldown)', again.exposed && again.sameBarrage);
// Win condition: expose again and level all four HQ buildings.
const win = await page.evaluate(() => {
  const g = window.__game;
  for (let i = 0; i < 22 * 30; i++) { g._simulate(1 / 30); window.__force(); }
  const hp0 = g.map.bases[0].hq.map((id) => g.map.buildings[id].hp);
  for (const id of g.map.bases[0].hq) { const b = g.map.buildings[id]; g.structures.damage(b, b.hp + 1); }
  g.bus.flush();
  return { over: g.capture.over, winner: g.capture.winner, left: g.capture.hqLeft(0), persisted: hp0.some((h, i) => h < g.map.buildings[g.map.bases[0].hq[i]].maxHp) || true };
});
check('destroying all four HQ buildings wins the match', win.over && win.winner === 1 && win.left === 0, JSON.stringify(win));
const log = await page.evaluate(() => window.__log.splice(0));
for (const l of log.filter((l) => /PHASE|BARRAGE|HQ down|SIEGE/.test(l)).slice(0, 30)) console.log(`      ${l}`);
check('no page errors', errors.length === 0, errors.slice(0, 3).join('\n'));
await browser.close();
server.httpServer.close();
console.log(failures ? `${failures} FAILED` : 'all endgame checks passed');
process.exit(failures ? 1 : 0);
