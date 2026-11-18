// Large-map verification (headless, accelerated, bots only):
//  1. Squad objective coherence: how often squads change objective, flip-flops
//     (A → B → A within 60 s), time spent on one objective, distance to it.
//  2. Vehicle navigation around buildings: hull overlaps with building
//     footprints, stuck time, distance driven, path search outcomes.
//  3. Simulation cost per frame (AI + physics + game logic, rendering off).
// Usage: npm run build && node tools/map-report.mjs [simSeconds=600]
import { createRequire } from 'node:module';
import { preview } from 'vite';

const { chromium } = createRequire(import.meta.url)('playwright');
const total = +(process.argv[2] || 600);
const server = await preview({ preview: { port: 4188, strictPort: true }, logLevel: 'error' });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 300 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
await page.goto('http://localhost:4188/?q=low');
await page.waitForFunction(() => window.__game && window.__game.mode === 'menu', null, { timeout: 120000 });
await page.evaluate(() => {
  const g = window.__game;
  g.stop(); g.render.render = () => {};
  const S = g.soldiers.length;
  window.__m = {
    obj: new Map(), changes: 0, flips: 0, samples: 0, onObjective: 0, dist: 0, distN: 0, hist: new Map(),
    vehOverlap: 0, vehSamples: 0, stuckSamples: 0, stuckPrev: new Map(), driven: 0, last: new Map(), frameMs: [], S,
  };
});
const t0 = Date.now();
for (let t = 0; t < total; t += 10) {
  await page.evaluate(() => {
    const g = window.__game, m = window.__m, dt = 1 / 30;
    for (let step = 0; step < 300; step++) {
      const a = performance.now();
      g._simulate(dt);
      m.frameMs.push(performance.now() - a);
      if (step % 15) continue;
      // Squads: objective changes and flip-flops (sampled every 0.5 s).
      for (const q of g.ai.squads.squads) {
        if (q.kind !== 0 || q.alive === 0) continue;
        const id = q.objective ? q.objective.id : -1;
        const prev = m.obj.get(q.id);
        m.samples++;
        if (prev !== undefined && prev !== id && id >= 0) {
          m.changes++;
          const h = m.hist.get(q.id) || [];
          // A → B → A within 60 s counts as a flip-flop.
          if (h.length >= 2 && h[h.length - 2].id === id && g.time - h[h.length - 2].t < 60) m.flips++;
          h.push({ id, t: g.time }); if (h.length > 4) h.shift();
          m.hist.set(q.id, h);
        }
        if (prev === undefined && id >= 0) m.hist.set(q.id, [{ id, t: g.time }]);
        m.obj.set(q.id, id);
        if (q.objective) {
          const d = Math.hypot(q.cx - q.objective.x, q.cz - q.objective.z);
          m.dist += d; m.distN++;
          if (d < 60) m.onObjective++;
        }
      }
      // Vehicles: hull footprint inside a building, stuck, distance.
      for (const v of g.vehicles.list) {
        if (!v.alive || !v.occupied || v.def.kind !== 'ground' || v.def.static) continue;
        m.vehSamples++;
        const ids = g.structures.near(v.pos.x, v.pos.z);
        for (const id of ids) {
          const b = g.map.buildings[id];
          if (b.deck || b.name === 'tunnel') continue;
          const c = Math.cos(b.rot), s = Math.sin(b.rot), dx = v.pos.x - b.x, dz = v.pos.z - b.z;
          const lx = dx * c - dz * s, lz = dx * s + dz * c;
          if (Math.abs(lx) < b.w / 2 - 0.5 && Math.abs(lz) < b.d / 2 - 0.5 && b.state < 2) { m.vehOverlap++; break; }
        }
        const p = m.last.get(v.id);
        const a = v.driver && v.driver.ai;
        // Stuck events: the driver's detector fired (3 s with throttle and < 2.5 m of progress).
        if (a) { const pk = m.stuckPrev.get(v.id) ?? a.stuckTotal; if (a.stuckTotal > pk) m.stuckSamples += a.stuckTotal - pk; m.stuckPrev.set(v.id, a.stuckTotal); }
        if (p) m.driven += Math.hypot(v.pos.x - p.x, v.pos.z - p.z);
        m.last.set(v.id, { x: v.pos.x, z: v.pos.z });
      }
    }
  });
}
const r = await page.evaluate(() => {
  const g = window.__game, m = window.__m;
  const f = m.frameMs.slice().sort((a, b) => a - b);
  const squads = g.ai.squads.squads.filter((q) => q.kind === 0).length;
  const minutes = g.time / 60;
  return {
    time: g.time, squads, minutes,
    changesPerSquadMin: m.changes / squads / minutes, flips: m.flips, changes: m.changes,
    meanDist: m.dist / Math.max(1, m.distN), onObjective: m.onObjective / Math.max(1, m.distN),
    vehOverlapPct: (100 * m.vehOverlap) / Math.max(1, m.vehSamples), stuckPerHour: m.stuckSamples / Math.max(1e-6, m.vehSamples * 0.5 / 3600), stuckEvents: m.stuckSamples, drivenKm: m.driven / 1000,
    nav: g.nav.stats, frameAvg: f.reduce((a, b) => a + b, 0) / f.length, frameP95: f[Math.floor(f.length * 0.95)], frameMax: f[f.length - 1],
    aiMs: g.ai.stats.ms, flags: g.capture.flags.map((x) => (x.base ? '' : x.owner < 0 ? '·' : x.owner ? 'T' : 'P')).join(''), tickets: g.capture.tickets.map(Math.round),
    journal: g.ai.commanders.map((c) => c.journal.slice(-4).join(' / ')),
  };
});
console.log(`simulated ${r.time.toFixed(0)} s in ${((Date.now() - t0) / 1000).toFixed(0)} s wall; flags ${r.flags}; tickets P${r.tickets[0]} T${r.tickets[1]}`);
console.log(`squads ${r.squads}: objective changes ${r.changesPerSquadMin.toFixed(2)}/squad/min (${r.changes} total), flip-flops ${r.flips}; mean distance to objective ${r.meanDist.toFixed(0)} m; within 60 m of it ${(r.onObjective * 100).toFixed(0)}% of samples`);
console.log(`vehicles: inside a building footprint ${r.vehOverlapPct.toFixed(2)}% of samples; stuck events ${r.stuckEvents} (${r.stuckPerHour.toFixed(1)} per crewed-vehicle hour); driven ${r.drivenKm.toFixed(1)} km`);
console.log(`nav searches ${r.nav.searches}, corridor ${r.nav.corridor}, partial ${r.nav.partial}, failed ${r.nav.failed}`);
console.log(`simulation cost per frame: avg ${r.frameAvg.toFixed(2)} ms, p95 ${r.frameP95.toFixed(2)} ms, max ${r.frameMax.toFixed(1)} ms (AI ${r.aiMs.toFixed(2)} ms)`);
for (const j of r.journal) console.log(`  ${j}`);
console.log(errors.length ? `errors:\n${errors.slice(0, 3).join('\n')}` : 'no errors');
await browser.close(); server.httpServer.close();
