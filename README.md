# Shenaniwars

A mobile-first, landscape, combined-arms sandbox shooter for the browser: **100 vs 100**
soldiers of **Pampalona** and **Torsa** fight over seven capture points on a 768 m island
with armour, artillery, air defence, helicopters and jets. Three.js (WebGL 2) for rendering,
Rapier (WASM) for rigid bodies; terrain, models, animation, audio and AI are all procedural,
so there are no art or sound assets to download.

```
npm install
npm run dev        # dev server (open on a phone via the printed network URL)
npm run build      # production bundle in dist/
npm test           # headless map / navigation / every-vehicle physics checks + AI unit tests
npm run typecheck  # strict TypeScript check of the AI core (src/ai/*.ts)
npm run battle     # build + accelerated bots-only battle with a strategy report (node tools/battle-report.mjs [secs] [step])
npm run e2e        # build + headless-Chromium gameplay run (needs a global Playwright)
```

URL options: `?debug` (FPS / draw calls / chunks overlay), `?q=low|medium|high` (quality tier),
`?bots=N` (soldiers per side, for testing). Dev previews (serve the repo root, e.g. with
`npx vite`): `/tools/gallery.html` renders every vehicle model, `/tools/soldiers.html` renders
both factions' soldiers in a set of poses and reload frames.

## Factions

| | Pampalona (placeholder kit) | Torsa |
|---|---|---|
| Rifles | carbine | AK-12 (60%), AK-47 (40%) |
| Anti-tank | launcher | RPG-7 |
| Ground | scout cars ×4, battle tanks ×2 | T-90 MBT ×3, T-80U heavy tank ×2, Sprut-SD light tank ×2, BTR-90 APC ×3, BMP-2 IFV ×3, KamAZ transport ×3, KamAZ supply ×2 |
| Support | — | Uragan-1M MLRS, Msta-S howitzer ×2, Pantsir-S1 SAM, Shilka SPAAG |
| Air | gunships ×2 | Ka-52 attack helicopter ×2, Mi-8 transport helicopter ×2, Su-25 strike jet, Su-30 fighter |

Every fourth soldier in a fire team carries the anti-tank weapon. Vehicles of either side can
be taken by anyone when empty. Pampalona keeps its original placeholder kit until its own
roster is designed.

## Controls

| | Touch (landscape) | Keyboard / mouse |
|---|---|---|
| Move | left thumb (floating stick; push to the rim to sprint) | WASD, Shift |
| Aim | right thumb drag — every button also works as a look pad while held | mouse |
| Fire / aim down sights | FIRE / AIM | LMB / RMB |
| Jump, reload, swap weapon | JUMP / RELOAD / SWAP | Space / R / Q |
| Enter / exit vehicle, change seat | ENTER·EXIT / SEAT (shown only when relevant) | E / F |
| Drive | left thumb = throttle + steer, right thumb aims the turret, JUMP = brake, SWAP = next weapon | WASD, mouse, Space, Q |
| Helicopter | left thumb = cyclic (pitch / roll), right thumb = yaw + climb | WASD, ←/→, Space / C |
| Jet | left thumb = pitch / roll, right thumb = rudder + throttle (push up to open the throttle) | WASD, ←/→, Space / C |

Artillery aims by range: point the crosshair at the ground and the gun lobs onto that spot
(the HUD shows the range). Air-to-air and surface-to-air missiles need a lock: keep an enemy
aircraft near the crosshair until the HUD reads LOCKED. Bailing out of an aircraft deploys a
parachute. Supply trucks re-arm infantry and repair vehicles parked next to them.

## Project layout

```
index.html                  page shell: canvas, HUD, touch layer, menus (side picker), rotate prompt
src/
  main.js                   bootstrap: quality tier, loading, menus, fullscreen + landscape lock
  core/                     config, deterministic event bus, state store, pools, math
  world/
    terrain.js              heightmap sampling (height / normal / slope / road / runway masks)
    map-generator.js        island, roads, flag plateaus, runways, footprint-aware vehicle parks, props
    geo.js, prop-geometry.js  static prop batching with LODs
  systems/
    game.js                 composition root + the one authoritative frame order
    renderer.js             WebGL renderer, CSM shadows, HDR post chain, dynamic resolution
    chunk-manager.js        streamed terrain/prop chunks with two LODs, destructibles, flags
    physics.js              Rapier world, heightfield, ray queries, soldier push-out
    navigation.js           nav grid (infantry + vehicle layers), time-budgeted A*
    vehicles.js             fleet: fixed step, interpolation, wrecks, respawn, supply aura
    combat.js               hitscan (+ explosive splash), shells, rockets, guided/homing missiles, bombs
    soldier-renderer.js     GPU-skinned soldiers (bone texture), culling, LOD, verlet ragdolls
    capture.js, particles.js, audio.js, input.js
  entities/
    soldier.js, player.js   infantry model; player controller, cameras, first-person view model
    soldier-rig.js          skeleton, gait, two-bone arm IK, carries, reload choreography
    ai-agent.js             per-bot actuator: intent -> movement, stance, aim, fire, vehicle controls
    vehicle.js              rigid body, raycast suspension, seats, multi-weapon mounts, damage
    vehicle-defs.js         every vehicle's data (dimensions, physics, seats, weapons)
    vehicle-visual.js       model spec -> meshes (hull, turrets, instanced wheels, rotors, radars)
    helicopter.js, aircraft.js  helicopter and fixed-wing flight models
    factions.js, weapons.js loadouts, palettes, rosters; weapon data + ballistic solver
    models/                 lofting kit, vehicle models, weapon models, soldier model
  ai/                       combined-arms AI core (TypeScript, zero-GC hot loops):
    director.ts             scheduler: 60 Hz AI clock, id-modulo slices, LOD, LoS budget, event routing
    commander.ts            theater commander per side: intel, flag values, operations, force allocation
    positions.ts            fighting positions, terrain line of sight, vehicle firing positions
    perception-utility.ts   perception memory + LoS queue; infantry utility brain with hysteresis
    squad-convoy.ts         squad blackboards (forming, merging, postures), convoys and drills
    vehicle-orchestrator.ts seat tickets, squad-sync boarding, dismount, bailout, 15 archetype controllers
    radio-bus.ts            typed tactical radio: cooldowns, claimable request tickets, danger-close zones
    spatial-grid.ts, terrain-analysis.ts, smoke.ts, agent-state.ts, types.ts
    vehicle-pilot.js        low-level ground driver, gunner, helicopter and jet autopilots
  shaders/, ui/             post-processing GLSL; HUD and styles
tools/                      smoke-sim.mjs, ai-tests.mjs, e2e.mjs, battle-report.mjs, gallery.html, soldiers.html
```

## How it works

**Frame order** (`Game._simulate`): input → AI director (grid, perception, tactics, squads,
convoys, crews, actuators) → path queue →
fixed-step vehicles + Rapier (60 Hz, accumulator) → interpolate vehicles → kinematic
soldiers → combat → capture rules → event queue flush → camera / streaming / instancing →
render.

**Rendering.** Scene renders into an HDR target; a three-pass bloom and one composite pass
(crease SSAO from depth, ACES, split-tone grade, vignette, sRGB) follow. Shadows are
cascaded shadow maps (2 cascades on medium, 3 on high, off on low). A frame-time governor
scales render resolution between per-tier bounds to hold ~60 FPS.

**Draw-call budget.** Each chunk is one terrain draw + one batched prop draw (a single draw at
far LOD). All soldiers of a team are one draw per detail level: each body part, weapon and
magazine is a bone whose matrix the vertex shader reads from a float texture, and only
soldiers inside the view frustum are drawn (the nearest 20 with the detailed body). Particles
and tracers are one draw each. A vehicle is 2–8 meshes, with wheels instanced, small parts
dropped beyond 110 m and shadows beyond 140 m.

**Streaming.** The map is a 12×12 grid of 64 m chunks. Chunk geometry is built lazily (one
build per frame), swapped between hi/lo LOD with hysteresis, and disposed when it falls
out of range.

**Vehicles.** Ground vehicles are Rapier rigid bodies on a custom raycast suspension: each wheel
is a spring-damper ray whose normal load caps the tyre's friction budget (weight transfer,
traction loss on slopes). Tracked vehicles use rows of rays and skid steering, with turrets,
coaxial guns and roof weapons slewing independently. Helicopters use an attitude-servo model
(sticks command tilt and rates). Jets use an arcade fixed-wing model: thrust, drag sized to top
speed, lift growing with airspeed, a flight path pulled toward the nose, stalls, and the same
suspension as landing gear for take-off from the runways.

**Soldiers.** An original chunky, rounded soldier design wearing helmets with a team-coloured
band, plate carriers, pouches, knee pads and packs (Torsa: green camo, balaclava and goggles;
Pampalona: coyote tan, glasses and headset). The rig poses gait (walk, run, strafe), a bladed
rifle stance with two-bone arm IK onto each weapon's grips, sprint and low-ready carries,
slung weapons, seated and parachute poses, and reloads (cant, magazine out, pouch, new
magazine, rack the bolt when empty; rockets fetched from the back for launchers). The
first-person view model uses the same rig and weapon models.

**AI.** A TypeScript director (`src/ai/director.ts`) owns all decisions; `AIAgent` only
actuates. Every frame it rebuilds a flat uniform grid, then runs a fixed 60 Hz clock where
soldier `o` perceives on `frame % 12 == o % 12` (5 Hz) and thinks on `frame % 15 == o % 15`
(4 Hz), halved beyond 160 m and cut to 1 Hz beyond 320 m from the camera. Line-of-sight
raycasts go through one prioritised queue with a fixed per-frame budget. Detection builds up
over time (view cone, stance, movement, muzzle flash, foliage, thermal / radar), and memory
keeps decaying last-known positions. Utility scoring with hysteresis and commit times picks
among 18 actions: advance, engage, suppress, cover, bound, flank, retreat, resupply, board,
investigate, ambush, screen, hold, regroup, repair, heal, crew. Cover is scored against every
known sightline. Squads (leader, riflemen, one AT gunner, engineer, spotter) share a
blackboard, bound and flank, merge when broken, and request fire missions, CAS, logistics and
extraction over a cooldown-gated radio. Vehicles are crewed through atomic seat tickets by
class affinity, carry squads with synchronised boarding and safe dismount points, bail out
only when the outside is safer, travel in role-ordered convoys that shift to a wedge on
contact, and run one controller per archetype (15 of them).

**Strategy.** Each side has a theater commander (`src/ai/commander.ts`) that thinks once a
second from what its troops actually know: contact reports, contested flags, where its own
soldiers die. Every decision carries a reason (`?debug` overlay, `npm run battle`). Operations:
*secure* an empty flag with a detachment; *assault* a defended one by concentrating ~3:1 in a
defiladed assembly area, preparing it with artillery, CAS and smoke, then attacking on a main
and a flanking axis with a support-by-fire element and armour in firing positions; *defend* a
threatened flag; *air assault* by helicopter (land, fast-rope or parachute, chosen by enemy air
defence and how hot the drop zone is) onto a weak flag behind the line or into an assault
objective's rear. Failed assaults raise the objective's estimated hardness, so the next plan
bypasses it for flags it can take or returns with more force. Squads under orders take planned
fighting positions (cover against the threat axis, inside the capture circle, AT on the
approaches, spotters high), do not chase kills away from their task, and close on the flag with
fire and movement. Vehicles steer around props, other vehicles and friendly infantry
(context steering), and gunners keep searching where a target was last seen before settling into
a natural sector scan. Owned flags are ammunition caches; each fire team's engineer carries spares.

**State.** Every stateful system registers a `serialize`/`deserialize` pair with the
`StateStore`; pause → SAVE / LOAD round-trips flags, tickets, soldiers, vehicles and
destroyed props through `localStorage`.

## Known limits

- Performance has only been measured in headless software rendering, not on phones. 100 v 100
  with 37 vehicles is heavy for low-end devices; `?bots=50` halves the head count, and the
  quality tiers / resolution governor are the other knobs (`src/core/config.js`).
- Pampalona still uses the original placeholder vehicles and weapons, so the sides are not
  balanced yet: Torsa's armour, artillery and aircraft dominate.
- Aircraft are scaled to about 75 % of real size to fit the 768 m island.
- No occlusion culling (frustum + distance culling and LOD only) and no KTX2/Basis pipeline,
  because the game ships no textures.
- Static prop colliders are all resident in Rapier's broad phase (bots need them for
  line-of-sight far from the player); streaming applies to render data.
- Rapier's compat build embeds its WASM, so the physics chunk is ~1.7 MB gzipped.
- Single-player only; the interpolation layer is local fixed-step smoothing, not netcode.
