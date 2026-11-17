# Shenaniwars

A mobile-first, landscape, combined-arms sandbox shooter for the browser: squad-based
bots fight over seven capture points on a 768 m island with scout cars, battle tanks and
gunships. Three.js (WebGL 2) for rendering, Rapier (WASM) for rigid bodies, everything
else — terrain, models, audio, AI — is procedural, so there are no art or sound assets to
download.

```
npm install
npm run dev        # dev server (open on a phone via the printed network URL)
npm run build      # production bundle in dist/
npm test           # headless physics / navigation / vehicle simulation checks
node tools/e2e.mjs [low|medium|high] [screenshotDir]   # browser end-to-end run (needs a global Playwright)
```

Append `?debug` for an FPS / draw-call / chunk overlay and `?q=low|medium|high` to force a tier.

## Controls

| | Touch (landscape) | Keyboard / mouse |
|---|---|---|
| Move | left thumb (floating stick; push to the rim to sprint) | WASD, Shift |
| Aim | right thumb drag — every button also works as a look pad while held | mouse |
| Fire / aim down sights | FIRE / AIM | LMB / RMB |
| Jump, reload, swap weapon | JUMP / RELOAD / SWAP | Space / R / Q |
| Enter / exit vehicle, change seat | ENTER·EXIT / SEAT (shown only when relevant) | E / F |
| Drive | left thumb = throttle + steer, right thumb aims the turret, JUMP = brake | WASD, mouse, Space |
| Fly | left thumb = cyclic (pitch / roll), right thumb = yaw + climb | WASD, ←/→, Space / C |

## Project layout

```
index.html                  page shell: canvas, HUD, touch layer, menus, rotate prompt
src/
  main.js                   bootstrap: quality tier, loading, menus, fullscreen + landscape lock
  core/
    config.js               every tunable + quality tiers + device heuristics
    event-bus.js            deterministic, allocation-free event bus (sync emit + FIFO queue)
    state-store.js          serialisable state tokens -> snapshot / restore / save slots
    pool.js                 fixed-capacity object pool
    math.js                 seeded RNG, noise, angle helpers
  world/
    terrain.js              heightmap sampling (height / normal / slope / road mask)
    map-generator.js        seeded island, roads, flag plateaus, forests, fortifications, vehicle parks
    geo.js, prop-geometry.js  vertex-coloured primitives; per-chunk prop batching with LODs
  systems/
    game.js                 composition root + the one authoritative frame order
    renderer.js             WebGL renderer, CSM shadows, HDR post chain, dynamic resolution
    chunk-manager.js        streamed terrain/prop chunks with two LODs, destructibles, flags
    physics.js              Rapier world, heightfield, ray queries, soldier push-out
    navigation.js           auto-generated nav grid (infantry + vehicle layers), budgeted A*
    vehicles.js             vehicle fleet: fixed step, interpolation, wrecks, respawn
    combat.js               hitscan, pooled projectiles, blasts, destructible props, kills
    capture.js              conquest rules: flags, tickets, bleed, match end
    squad.js                fire teams: objectives, shared contacts, flank orders
    ai-system.js            bot scheduling + hearing
    particles.js            pooled point-sprite particles and tracers (two draw calls)
    soldier-renderer.js     all soldiers in one instanced draw call + pooled ragdolls
    audio.js                procedural WebAudio with a voice budget
    input.js                dual-stick touch controls + keyboard/mouse
  entities/
    soldier.js, player.js   shared infantry model; player controller and cameras
    ai-agent.js             perception + behavior tree leaves + per-frame execution
    vehicle.js              rigid body, raycast suspension, drivetrain, seats, weapon mounts
    helicopter.js           assisted 6-DOF flight model
    vehicle-types.js        jeep / tank / gunship definitions and meshes
    weapons.js              weapon definitions and state
  ai/
    behavior-tree.js        selector / sequence / condition / action
    vehicle-pilot.js        ground driver, mount gunner, helicopter autopilot
  shaders/                  post-processing (bloom, SSAO, grade) and sky GLSL
  ui/                       HUD (DOM, value-cached) and styles
tools/
  smoke-sim.mjs             headless simulation test (npm test)
  e2e.mjs                   headless-Chromium gameplay test
```

## How it works

**Frame order** (`Game._simulate`): input → squad orders → bot brains → path queue →
fixed-step vehicles + Rapier (60 Hz, accumulator) → interpolate vehicles → kinematic
soldiers → combat → capture rules → event queue flush → camera / streaming / instancing →
render.

**Rendering.** Scene renders into an HDR target; a three-pass bloom and one composite pass
(crease SSAO from depth, ACES, split-tone grade, vignette, sRGB) follow. Shadows are
cascaded shadow maps (2 cascades on medium, 3 on high, off on low). A frame-time governor
scales render resolution between per-tier bounds to hold ~60 FPS.

**Draw-call budget.** Each chunk is one terrain draw + one batched prop draw (a single
draw at far LOD); all soldiers and ragdolls are one instanced mesh; particles and tracers
are one draw each; a vehicle is 3–7 meshes and sheds wheels/guns beyond 95 m.

**Streaming.** The map is a 12×12 grid of 64 m chunks. Chunk geometry is built lazily (one
build per frame), swapped between hi/lo LOD with hysteresis, and disposed when it falls
out of range.

**Vehicles.** Ground vehicles are Rapier rigid bodies on a custom raycast suspension:
each wheel is a spring-damper ray whose normal load caps the tyre's friction budget, which
yields weight transfer and slope traction loss. Tanks use six rays with skid steering and a
turret decoupled from the hull. The gunship uses an attitude-servo flight model (sticks
command tilt and rates) so it hovers hands-off but still flies by tilting the rotor disc.

**AI.** One shared, stateless behavior tree: crew duties → retreat → (take cover → flank →
engage) → investigate noise → board vehicle → advance to flag → patrol. Perception is a
view cone + line-of-sight rays + hearing; squads share contacts and split into suppress /
flank roles. Bots drive, crew guns, fly, and bail out of critically damaged vehicles.

**State.** Every stateful system registers a `serialize`/`deserialize` pair with the
`StateStore`; pause → SAVE / LOAD round-trips flags, tickets, soldiers, vehicles and
destroyed props through `localStorage`.

## Known limits

- Performance has only been measured in headless software rendering, not on phones; the
  tiers and resolution governor are the tuning knobs (`src/core/config.js`).
- No occlusion culling (frustum + distance culling and LOD only) and no KTX2/Basis
  pipeline, because the game ships no textures.
- Static prop colliders are all resident in Rapier's broad phase (bots need them for
  line-of-sight far from the player); streaming applies to render data.
- Rapier's compat build embeds its WASM, so the physics chunk is ~1.7 MB gzipped.
- Single-player only; the interpolation layer is local fixed-step smoothing, not netcode.
