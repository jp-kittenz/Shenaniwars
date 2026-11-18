// Renders the generated map top-down to a PPM (converted to PNG by the caller) with
// terrain shading, surface cover, roads, buildings, props, flags, bases and spawns,
// and prints layout statistics: overlaps, balance and generation time.
import { writeFileSync } from 'node:fs';
import { generateMap } from '../src/world/map-generator.js';
import { buildingParts } from '../src/world/buildings.js';

const out = process.argv[2] || 'map.ppm';
const scale = Number(process.argv[3] || 1); // pixels per 2 m sample
const t0 = performance.now();
const map = generateMap();
const ms = performance.now() - t0;
const t = map.terrain, N = t.n, S = N * scale;
const img = new Uint8Array(S * S * 3);
const put = (x, z, r, g, b) => {
  const px = Math.round((x + t.half) / t.res * scale), pz = Math.round((z + t.half) / t.res * scale);
  if (px < 0 || pz < 0 || px >= S || pz >= S) return;
  const i = (pz * S + px) * 3; img[i] = r; img[i + 1] = g; img[i + 2] = b;
};
const SURFC = { 1: [150, 150, 145], 2: [95, 95, 98], 3: [196, 170, 80], 4: [90, 150, 60], 5: [120, 90, 60], 6: [170, 160, 140], 7: [70, 110, 140], 8: [40, 70, 35], 9: [110, 90, 60] };
for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
  const x = -t.half + (i / scale) * t.res, z = -t.half + (j / scale) * t.res;
  const h = t.baseHeight(x, z), sl = t.slope(x, z);
  let c;
  if (h < 0) c = [30, 70 + Math.max(-40, h * 6), 110];
  else {
    const k = Math.min(1, h / 50);
    c = [70 + k * 80, 120 + k * 50, 60 + k * 40];
    const s = t.surfAt(x, z);
    if (SURFC[s]) c = SURFC[s];
    const road = t.roadAt(x, z);
    if (road > 0.3) c = [130, 110, 80];
    if (t.pavedAt(x, z) > 0) c = [70, 70, 72];
    const shade = 1 - Math.min(0.5, sl * 0.8);
    c = c.map((v) => v * shade);
  }
  const o = (j * S + i) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
}
const PROPC = { tree: [20, 60, 20], bush: [40, 90, 30], log: [90, 60, 30], rock: [120, 120, 120], wall: [200, 200, 200], fence: [160, 120, 80], container: [200, 80, 40], streetlight: [255, 255, 120] };
for (const p of map.props) {
  const c = PROPC[p.type] || [220, 60, 220];
  const r = Math.max(1, p.r || Math.max(p.hx, p.hz));
  for (let a = -r; a <= r; a += 1) for (let b = -r; b <= r; b += 1) {
    if (p.r) { if (a * a + b * b <= r * r) put(p.x + a, p.z + b, ...c); }
    else { const cs = Math.cos(p.rot), sn = Math.sin(p.rot); if (Math.abs(a) <= p.hx && Math.abs(b) <= p.hz) put(p.x + a * cs + b * sn, p.z - a * sn + b * cs, ...c); }
  }
}
for (const b of map.buildings) {
  const parts = buildingParts(b);
  const cs = Math.cos(b.rot), sn = Math.sin(b.rot);
  const col = b.hq ? [255, 40, 40] : b.team === 0 ? [40, 200, 190] : b.team === 1 ? [240, 120, 40] : b.state === 2 ? [90, 70, 60] : b.state === 1 ? [150, 120, 100] : [230, 220, 200];
  for (const p of parts) {
    if (p.k !== 0 && p.k !== 1 && p.k !== 7) continue;
    for (let a = -p.hx; a <= p.hx; a += 0.7) for (let c = -p.hz; c <= p.hz; c += 0.7) {
      const lx = p.x + a, lz = p.z + c;
      put(b.x + lx * cs + lz * sn, b.z - lx * sn + lz * cs, ...(p.k === 1 ? col.map((v) => v * 0.6) : col));
    }
  }
}
for (const v of map.vehicleSpawns) for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) put(v.x + a, v.z + b, v.team === 0 ? 0 : v.team === 1 ? 255 : 255, v.team === 0 ? 255 : v.team === 1 ? 0 : 255, v.team === 0 ? 255 : 0);
for (const f of map.flags) for (let a = -6; a <= 6; a++) for (let b = -6; b <= 6; b++) if (Math.abs(a) < 2 || Math.abs(b) < 2) put(f.x + a, f.z + b, 255, 255, 255);
writeFileSync(out, Buffer.concat([Buffer.from(`P6 ${S} ${S} 255\n`), Buffer.from(img)]));

// Statistics.
const types = {};
for (const p of map.props) types[p.type] = (types[p.type] || 0) + 1;
const btypes = {};
for (const b of map.buildings) btypes[b.name] = (btypes[b.name] || 0) + 1;
console.log(`generated in ${ms.toFixed(0)} ms; props ${map.props.length}; buildings ${map.buildings.length}; vehicles ${map.vehicleSpawns.length}; lights ${map.lights.length}`);
console.log('props', JSON.stringify(types));
console.log('buildings', JSON.stringify(btypes));
console.log('flags', map.flags.map((f) => `${f.name}(${f.x | 0},${f.z | 0},y${f.y.toFixed(1)})`).join(' '));
console.log('runways', map.runways.map((r) => `t${r.team} len${r.len | 0}`).join(' '), 'fords', map.fords.length, 'bridge', !!map.bridge);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const bases = map.flags.filter((f) => f.base);
for (const f of map.flags.filter((f) => !f.base)) console.log(`${f.name.padEnd(8)} P ${dist(f, bases[0]).toFixed(0).padStart(5)}  T ${dist(f, bases[1]).toFixed(0).padStart(5)}`);
