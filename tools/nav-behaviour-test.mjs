// Behavioural navigation test: real soldier movement (agent steering, soldier physics, wall push-out,
// budgeted path search) around and through real buildings. For a sample of buildings a bot must
//  - walk in through the door from behind the building,
//  - walk back out to a point behind it,
//  - walk around it to the far side,
// and, given a goal sealed inside a building (or in the sea), give up instead of grinding forever.
// Reports success rates, time spent without progress, and recovery counters.
// Usage: node tools/nav-behaviour-test.mjs [distDir=dist] [buildings=30] [seed=1]
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const dist = path.resolve(process.argv[2] || 'dist'), count = +(process.argv[3] || 30), seed = +(process.argv[4] || 1);
const server = http.createServer((q, r) => {
  const rel = decodeURIComponent(q.url.split('?')[0]); const f = path.join(dist, rel === '/' ? 'index.html' : rel);
  if (!f.startsWith(dist) || !fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); r.end(fs.readFileSync(f));
}).listen(0);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 300 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${server.address().port}/?q=low&simseed=${seed}`);
await page.waitForFunction(() => window.__game && window.__game.mode === 'menu', null, { timeout: 120000 });
const res = await page.evaluate(([count]) => {
  const g = window.__game; g.stop(); g.render.render = () => {};
  for (let i = 0; i < 60; i++) g._simulate(1 / 30);
  const t = g.map.terrain, n = g.nav;
  const bot = g.soldiers.find((x) => !x.isPlayer && x.alive && !x.vehicle && x.ai);
  const a = bot.ai;
  const W = (b, lx, lz) => [b.x + lx * Math.cos(b.rot) + lz * Math.sin(b.rot), b.z - lx * Math.sin(b.rot) + lz * Math.cos(b.rot)];
  // Walks the bot to (gx, gz) for at most `limit` s; returns time taken (or -1), seconds without progress, final status.
  const walk = (sx, sz, gx, gz, limit) => {
    bot.pos.set(sx, t.height(sx, sz), sz); bot.vehicle = null; bot.stance = 0;
    a.reset(); a.hasGoal = true; a.goalX = gx; a.goalZ = gz; a.target = null; a.sprint = false;
    let best = 1e9, bestT = 0, still = 0, time = 0;
    for (let i = 0; i < limit * 30; i++) {
      a.hasGoal = true; a.goalX = gx; a.goalZ = gz;
      g.time += 1 / 30;
      a._move(1 / 30);
      bot.update(1 / 30, g.time, t, g.physics);
      if (i % 2 === 0) n.update();
      time += 1 / 30;
      const d = Math.hypot(gx - bot.pos.x, gz - bot.pos.z);
      if (d < 2.5) return { t: time, el: time, still, status: a.navStatus };
      // Grinding: trying to walk (non-zero move input) without having gained ground for 2 s.
      if (d < best - 0.5) { best = d; bestT = time; } else if (time - bestT > 2 && Math.hypot(bot.moveX, bot.moveZ) > 0.5) still += 1 / 30;
    }
    return { t: -1, el: time, still, status: a.navStatus, left: Math.hypot(gx - bot.pos.x, gz - bot.pos.z) };
  };
  const cands = g.map.buildings.filter((b) => b.type !== 'custom' && b.type !== 'bridge' && b.roof !== 'open' && b.state < 2 && !b.deck);
  const step = Math.max(1, Math.floor(cands.length / count));
  const out = { tried: 0, inOk: 0, outOk: 0, aroundOk: 0, still: 0, walked: 0, fails: [] };
  for (let k = 0; k < cands.length && out.tried < count; k += step) {
    const b = cands[k];
    const door = b.openings.find((o) => o.kind === 'door' && o.floor === 0);
    if (!door) continue;
    // Behind = opposite side from the door, 6 m out; inside = 2.5 m in from the door.
    const back = door.side === 0 ? W(b, 0, -b.d / 2 - 6) : door.side === 1 ? W(b, 0, b.d / 2 + 6) : door.side === 2 ? W(b, -b.w / 2 - 6, 0) : W(b, b.w / 2 + 6, 0);
    const inside = door.side === 0 ? W(b, door.u, b.d / 2 - 2.5) : door.side === 1 ? W(b, door.u, -b.d / 2 + 2.5) : door.side === 2 ? W(b, b.w / 2 - 2.5, door.u) : W(b, -b.w / 2 + 2.5, door.u);
    const front = door.side === 0 ? W(b, 0, b.d / 2 + 6) : door.side === 1 ? W(b, 0, -b.d / 2 - 6) : door.side === 2 ? W(b, b.w / 2 + 6, 0) : W(b, -b.w / 2 - 6, 0);
    if (n.blocked(back[0], back[1]) || n.blocked(front[0], front[1]) || n.blocked(inside[0], inside[1])) continue;
    out.tried++;
    const r1 = walk(back[0], back[1], inside[0], inside[1], 60);
    const r2 = r1.t >= 0 ? walk(inside[0], inside[1], back[0], back[1], 60) : { t: -1, el: 0, still: 0 };
    const r3 = walk(back[0], back[1], front[0], front[1], 60);
    if (r1.t >= 0) out.inOk++; if (r2.t >= 0) out.outOk++; if (r3.t >= 0) out.aroundOk++;
    out.still += r1.still + r2.still + r3.still;
    out.walked += r1.el + (r2.el || 0) + r3.el;
    if ((r1.t < 0 || r2.t < 0 || r3.t < 0) && out.fails.length < 8) out.fails.push(`${b.id} ${b.type} in:${r1.t >= 0 ? 'ok' : r1.status} out:${r2.t >= 0 ? 'ok' : r2.status} around:${r3.t >= 0 ? 'ok' : r3.status}`);
  }
  // Unreachable goals: the soldier must stop trying (no endless grinding).
  const unreach = [];
  const sealed = g.map.buildings.filter((b) => b.type === 'shed' && b.state < 2).slice(0, 2);
  for (const b of sealed) {
    const s0 = W(b, 0, -b.d / 2 - 8);
    if (n.blocked(s0[0], s0[1])) continue;
    const r = walk(s0[0], s0[1], b.x, b.z, 45);
    unreach.push({ id: b.id, reached: r.t >= 0, status: r.status, grindSeconds: +r.still.toFixed(1) });
  }
  // A point in the sea.
  const sea = [g.map.terrain.half - 20, 0];
  const land = [g.map.terrain.half - 120, 0];
  if (!n.blocked(land[0], land[1])) { const r = walk(land[0], land[1], sea[0], sea[1], 45); unreach.push({ id: 'sea', reached: r.t >= 0, status: r.status, grindSeconds: +r.still.toFixed(1) }); }
  out.unreachable = unreach;
  out.navStats = g.navStats || null;
  return out;
}, [count]);
console.log(JSON.stringify({ dist: path.basename(dist), ...res, stillPerWalkPct: +((100 * res.still) / Math.max(1, res.walked)).toFixed(1) }));
if (errors.length) console.log('ERRORS', errors.slice(0, 3));
await browser.close();
server.close();
