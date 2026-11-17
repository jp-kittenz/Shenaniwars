// Headless simulation smoke test: map generation, physics heightfield
// alignment, navigation, and every vehicle's physics model. Run with `npm test`.
import { generateMap } from '../src/world/map-generator.js';
import { PhysicsSystem, MASK_LOS } from '../src/systems/physics.js';
import { NavigationSystem } from '../src/systems/navigation.js';
import { Vehicle } from '../src/entities/vehicle.js';
import { VEHICLE_DEFS } from '../src/entities/vehicle-defs.js';
import { EventBus } from '../src/core/event-bus.js';
import { CONFIG } from '../src/core/config.js';

let failures = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); if (!ok) failures++; };

let t0 = performance.now();
const map = generateMap();
console.log(`map: ${map.props.length} props, ${map.vehicleSpawns.length} vehicles, ${(performance.now() - t0).toFixed(0)}ms`);
const terrain = map.terrain;
const physics = await PhysicsSystem.create(map);

let maxErr = 0;
for (let i = 0; i < 300; i++) {
  const x = (Math.random() - 0.5) * 700, z = (Math.random() - 0.5) * 700;
  const r = physics.castRay(x, 300, z, 0, -1, 0, 600, MASK_LOS);
  if (!r.hit) { maxErr = 999; break; }
  if (r.target?.kind !== 'terrain') continue;
  maxErr = Math.max(maxErr, Math.abs(300 - r.toi - terrain.height(x, z)));
}
check('heightfield matches terrain sampler', maxErr < 1.2, `maxErr=${maxErr.toFixed(2)}m`);

const nav = new NavigationSystem(map);
const out = new Float32Array(96);
for (const veh of [false, true]) {
  let ok = true;
  for (const [a, b] of map.roads) if (!nav.findPath(map.flags[a].x, map.flags[a].z, map.flags[b].x, map.flags[b].z, veh, out)) ok = false;
  check(`paths between linked flags (${veh ? 'vehicle' : 'infantry'})`, ok);
}
// Every parked ground vehicle must be able to path to the centre flag.
let stranded = [];
for (const s of map.vehicleSpawns) {
  if (VEHICLE_DEFS[s.type].kind !== 'ground') continue;
  if (!nav.findPath(s.x, s.z, map.flags[2].x, map.flags[2].z, true, out)) stranded.push(s.type);
}
check('every ground vehicle can reach the front', stranded.length === 0, stranded.join(','));

const ctx = { physics, terrain, bus: new EventBus(), scene: null, setupMaterial: (m) => m };
const vehicles = map.vehicleSpawns.map((s, i) => new Vehicle(ctx, VEHICLE_DEFS[s.type], s, i));
const dt = CONFIG.fixedDt;
const run = (sec, fn) => {
  for (let i = 0; i < sec / dt; i++) {
    fn && fn(i * dt);
    for (const v of vehicles) v.fixedUpdate(dt);
    physics.step();
    for (const v of vehicles) v.capture();
  }
};
const agl = (v) => v.curPos.y - v.def.ride - terrain.height(v.curPos.x, v.curPos.z);
const upY = (v) => 1 - 2 * (v.curQuat.x ** 2 + v.curQuat.z ** 2);

run(3);
let bad = vehicles.filter((v) => Math.abs(agl(v)) > 0.35 || v.health < v.def.health || upY(v) < 0.95);
check('all vehicles settle on their pads undamaged', bad.length === 0, bad.map((v) => `${v.def.type}:agl=${agl(v).toFixed(2)} hp=${v.health.toFixed(0)} up=${upY(v).toFixed(2)}`).join(' '));

// One of each type gets a crew and a task.
const fake = { team: 1, yaw: 0, pitch: 0, pos: { x: 0, y: 0, z: 0 } };
const sample = {};
for (const v of vehicles) if (!sample[v.def.type]) sample[v.def.type] = v;
const start = {};
for (const type in sample) { sample[type].seats[0] = fake; start[type] = sample[type].curPos.clone(); }
const ground = Object.values(sample).filter((v) => v.def.kind === 'ground');
const top = {};
run(6, (t) => {
  for (const v of ground) { v.controls.throttle = 1; v.controls.steer = t > 4 ? 0.5 : 0; top[v.def.type] = Math.max(top[v.def.type] || 0, v.speed); }
  for (const v of Object.values(sample)) if (v.def.kind === 'heli') { v.controls.collective = 1; v.controls.pitch = t > 3 ? 0.8 : 0; }
});
for (const v of ground) {
  check(`${v.def.type}: drives`, top[v.def.type] > Math.min(5, v.def.maxSpeed * 0.45) && upY(v) > 0.8 && v.alive,
    `top=${top[v.def.type].toFixed(1)} up=${upY(v).toFixed(2)} hp=${v.health.toFixed(0)}/${v.def.health}`);
}
for (const v of Object.values(sample)) if (v.def.kind === 'heli') {
  check(`${v.def.type}: climbs and flies`, agl(v) > 20 && Math.hypot(v.vel.x, v.vel.z) > 6 && v.alive, `agl=${agl(v).toFixed(0)} hs=${Math.hypot(v.vel.x, v.vel.z).toFixed(1)} hp=${v.health.toFixed(0)}`);
}

// Jets: full throttle down the runway, rotate, climb, then bank.
const jets = Object.values(sample).filter((v) => v.def.kind === 'jet');
let rotateAt = {};
run(14, (t) => {
  for (const v of jets) {
    v.controls.throttle = 1;
    const spd = v.vel.length();
    if (spd > v.def.flight.stall * 1.05 && rotateAt[v.def.type] === undefined) rotateAt[v.def.type] = t;
    // Rotate, climb to ~60 m, then hold the nose a little above the horizon.
    const noseY = 2 * (v.curQuat.y * v.curQuat.z - v.curQuat.w * v.curQuat.x);
    v.controls.pitch = v.grounded && spd < v.def.flight.stall * 1.05 ? 0 : Math.max(-1, Math.min(1, (noseY - (agl(v) < 60 ? 0.3 : 0.08)) * 4));
    v.controls.roll = t > 11 ? 0.6 : 0;
    v.controls.yaw = 0;
  }
});
for (const v of jets) {
  const s = start[v.def.type];
  check(`${v.def.type}: takes off and climbs`, v.alive && agl(v) > 25 && v.vel.length() > v.def.flight.stall,
    `agl=${agl(v).toFixed(0)} speed=${v.vel.length().toFixed(0)} rotate@${(rotateAt[v.def.type] ?? -1).toFixed(1)}s run=${Math.hypot(v.curPos.x - s.x, v.curPos.z - s.z).toFixed(0)}m hp=${v.health.toFixed(0)}`);
}

// Turret slewing and muzzle geometry: the muzzle must lie along the mount's direction.
const mbt = sample.mbt;
mbt.aimYaw[0] = mbt.yaw + 1.0; mbt.aimPitch[0] = 0.1;
run(3);
const mp = new (mbt.pos.constructor)(), md = new (mbt.pos.constructor)();
mbt.interpolate(1);
mbt.getMuzzle(0, mp, md);
check('turret slews toward aim', mbt.aimError(0) < 0.05, `err=${mbt.aimError(0).toFixed(3)}`);
check('muzzle sits ahead of the turret', mp.distanceTo(mbt.pos) > 6 && md.y > 0.05, `dist=${mp.distanceTo(mbt.pos).toFixed(2)} dirY=${md.y.toFixed(2)}`);

t0 = performance.now();
run(3);
console.log(`physics cost ${((performance.now() - t0) / (3 / dt)).toFixed(3)}ms/step for ${vehicles.length} vehicles`);
process.exit(failures ? 1 : 0);
