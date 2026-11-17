// Headless simulation smoke test: map generation, physics heightfield
// alignment, navigation and all three vehicle models. Run with `npm test`.
import { generateMap } from '../src/world/map-generator.js';
import { PhysicsSystem, MASK_LOS } from '../src/systems/physics.js';
import { NavigationSystem } from '../src/systems/navigation.js';
import { Vehicle } from '../src/entities/vehicle.js';
import { VEHICLE_DEFS } from '../src/entities/vehicle-types.js';
import { EventBus } from '../src/core/event-bus.js';
import { CONFIG } from '../src/core/config.js';

let failures = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); if (!ok) failures++; };

let t0 = performance.now();
const map = generateMap();
console.log(`map: ${map.props.length} props, ${(performance.now() - t0).toFixed(0)}ms`);
const terrain = map.terrain;
let water = 0;
for (const h of terrain.heights) if (h < CONFIG.world.waterLevel) water++;
console.log(`water coverage ${(100 * water / terrain.heights.length).toFixed(1)}%`);

t0 = performance.now();
const physics = await PhysicsSystem.create(map);
console.log(`physics build ${(performance.now() - t0).toFixed(0)}ms`);

// Heightfield orientation / alignment.
let maxErr = 0;
for (let i = 0; i < 300; i++) {
  const x = (Math.random() - 0.5) * 700, z = (Math.random() - 0.5) * 700;
  const r = physics.castRay(x, 300, z, 0, -1, 0, 600, MASK_LOS);
  if (!r.hit) { maxErr = 999; break; }
  if (r.target?.kind !== 'terrain') continue;
  maxErr = Math.max(maxErr, Math.abs(300 - r.toi - terrain.height(x, z)));
}
check('heightfield matches terrain sampler', maxErr < 1.2, `maxErr=${maxErr.toFixed(2)}m`);

t0 = performance.now();
const nav = new NavigationSystem(map);
console.log(`nav build ${(performance.now() - t0).toFixed(0)}ms`);
const out = new Float32Array(96);
for (const veh of [false, true]) {
  let worst = 0, ok = true;
  for (const [a, b] of map.roads) {
    const s = performance.now();
    const len = nav.findPath(map.flags[a].x, map.flags[a].z, map.flags[b].x, map.flags[b].z, veh, out);
    worst = Math.max(worst, performance.now() - s);
    if (!len) { ok = false; console.log('  no path', map.flags[a].name, map.flags[b].name); }
  }
  check(`paths between linked flags (${veh ? 'vehicle' : 'infantry'})`, ok, `worst ${worst.toFixed(1)}ms`);
}
{
  const s = performance.now();
  const len = nav.findPath(map.flags[0].x, map.flags[0].z, map.flags[4].x, map.flags[4].z, true, out);
  check('cross-map vehicle path', len > 0, `${len} pts ${(performance.now() - s).toFixed(1)}ms`);
}

const ctx = { physics, terrain, bus: new EventBus(), scene: null, setupMaterial: (m) => m };
const mk = (type, i) => new Vehicle(ctx, VEHICLE_DEFS[type], map.vehicleSpawns.find((s) => s.type === type), i);
const jeep = mk('jeep', 0), tank = mk('tank', 1), heli = mk('heli', 2);
const all = [jeep, tank, heli];
const dt = CONFIG.fixedDt;
const run = (sec, fn) => {
  for (let i = 0; i < sec / dt; i++) {
    fn && fn(i * dt);
    for (const v of all) v.fixedUpdate(dt);
    physics.step();
    for (const v of all) v.capture();
  }
};
const agl = (v) => v.curPos.y - terrain.height(v.curPos.x, v.curPos.z);
const fake = { team: 0, yaw: 0, pitch: 0, pos: { x: 0, y: 0, z: 0 } };

run(3);
check('jeep rests on suspension', Math.abs(agl(jeep) - 0.92) < 0.25 && jeep.health === jeep.def.health, `agl=${agl(jeep).toFixed(2)} hp=${jeep.health}`);
check('tank rests on suspension', Math.abs(agl(tank) - 1.11) < 0.25 && tank.health === tank.def.health, `agl=${agl(tank).toFixed(2)}`);
check('heli rests on skids', Math.abs(agl(heli) - 0.9) < 0.3 && heli.health === heli.def.health, `agl=${agl(heli).toFixed(2)} hp=${heli.health}`);

for (const v of all) v.seats[0] = fake;
const j0 = jeep.curPos.clone(), tYaw0 = Math.atan2(2 * (tank.curQuat.w * tank.curQuat.y), 1 - 2 * tank.curQuat.y ** 2);
let maxJeep = 0;
run(6, (t) => {
  jeep.controls.throttle = 1; jeep.controls.steer = t > 3 ? 0.4 : 0;
  tank.controls.throttle = t < 3 ? 1 : 0; tank.controls.steer = t >= 3 ? 1 : 0;
  heli.controls.collective = 1; heli.controls.pitch = t > 2.5 ? 1 : 0;
  maxJeep = Math.max(maxJeep, jeep.speed);
});
check('jeep accelerates', maxJeep > 9, `top=${maxJeep.toFixed(1)}m/s moved=${j0.distanceTo(jeep.curPos).toFixed(0)}m hp=${jeep.health.toFixed(0)}`);
const up = { x: 0, y: 1, z: 0 };
const upY = (v) => 1 - 2 * (v.curQuat.x ** 2 + v.curQuat.z ** 2);
check('jeep upright', upY(jeep) > 0.7, `upY=${upY(jeep).toFixed(2)}`);
const tv = tank.body.angvel();
check('tank pivots (skid steer)', Math.abs(tv.y) > 0.4, `yawRate=${tv.y.toFixed(2)} speed=${tank.speed.toFixed(1)}`);
const hv = heli.body.linvel();
check('heli climbs and flies forward', agl(heli) > 25 && Math.hypot(hv.x, hv.z) > 8, `agl=${agl(heli).toFixed(0)} hspeed=${Math.hypot(hv.x, hv.z).toFixed(1)} hp=${heli.health.toFixed(0)}`);
run(4, () => { heli.controls.pitch = 0; heli.controls.collective = 0; jeep.controls.throttle = 0; jeep.controls.brake = true; });
const hv2 = heli.body.linvel();
check('heli hover-stabilises', Math.abs(hv2.y) < 1 && upY(heli) > 0.97, `vy=${hv2.y.toFixed(2)} upY=${upY(heli).toFixed(3)} hs=${Math.hypot(hv2.x, hv2.z).toFixed(1)}`);
check('jeep brakes to a stop', Math.abs(jeep.speed) < 0.6, `speed=${jeep.speed.toFixed(2)}`);

t0 = performance.now();
run(5);
console.log(`physics cost ${((performance.now() - t0) / (5 / dt)).toFixed(3)}ms/step`);
process.exit(failures ? 1 : 0);
