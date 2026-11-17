// Accelerated headless battle (bots only, rendering off) with a strategy report:
// flag control over time, tickets, where each side's squads are committed, and
// the commanders' operations with their reasons.
// Usage: npm run build && node tools/battle-report.mjs [simSeconds=600] [sampleEvery=30]
import { createRequire } from 'node:module';
import { preview } from 'vite';

const { chromium } = createRequire(import.meta.url)('playwright');
const total = +(process.argv[2] || 600), every = +(process.argv[3] || 30);
const server = await preview({ preview: { port: 4185, strictPort: true }, logLevel: 'error' });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 300 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:4185/?q=low');
await page.waitForFunction(() => window.__game && window.__game.mode === 'menu', null, { timeout: 90000 });
await page.evaluate(() => {
  const g = window.__game;
  g.stop();
  g.render.render = () => {};
  window.__log = [];
  g.bus.on('flag:changed', (f, team) => window.__log.push(`${g.time.toFixed(0)}s ${f.name} -> ${team < 0 ? 'neutral' : team === 0 ? 'PAMPALONA' : 'TORSA'}`));
  g.bus.on('ai:op', (team, text) => window.__log.push(`${g.time.toFixed(0)}s [${team === 0 ? 'P' : 'T'}] ${text}`));
});
const t0 = Date.now();
for (let t = 0; t < total; t += every) {
  const r = await page.evaluate((every) => {
    const g = window.__game, dt = 1 / 30;
    for (let i = 0; i < every / dt; i++) g._simulate(dt);
    const names = g.capture.flags.map((f) => f.name[0]);
    const own = g.capture.flags.map((f) => (f.owner < 0 ? '·' : f.owner === 0 ? 'P' : 'T')).join('');
    // Where squads are committed: objective letter counts per side (alive members only).
    const commit = [{}, {}];
    for (const q of g.ai.squads.squads) {
      if (q.kind !== 0 || q.alive === 0) continue;
      const k = q.objective ? q.objective.name[0] : '-';
      commit[q.team][k] = (commit[q.team][k] || 0) + q.alive;
    }
    const fmt = (o) => names.map((n) => (o[n] ? `${n}${o[n]}` : '')).filter(Boolean).join(' ');
    const log = window.__log.splice(0);
    const ops = g.ai.commanders ? g.ai.commanders.map((c) => c.summary()) : [];
    return { t: g.time.toFixed(0), own, tickets: g.capture.tickets.map((x) => Math.round(x)), p: fmt(commit[0]), q: fmt(commit[1]), log, ops, over: g.capture.over };
  }, every);
  console.log(`t=${r.t.padStart(4)}s flags ${r.own}  tickets P${r.tickets[0]} T${r.tickets[1]}  | P: ${r.p}  | T: ${r.q}`);
  for (const l of r.log) console.log(`      ${l}`);
  for (const o of r.ops) console.log(`      ${o}`);
  if (r.over) break;
}
console.log(`wall ${((Date.now() - t0) / 1000).toFixed(0)}s`, errors.length ? `errors: ${errors.slice(0, 5).join('\n')}` : 'no errors');
await browser.close();
await server.close();
