# AI architecture: what exists, what this update changes

Inspection of the combined-arms AI before the operations / vehicle-integration
update, and the reasoning behind the changes. Measurements are from
`tools/ai-eval.mjs` (3 seeds × 10 simulated minutes, 100 v 100, bots only) on
the previous build.

## Reused as they are

| System | File | Role |
|---|---|---|
| Director | `src/ai/director.ts` | 60 Hz AI clock, id-modulo perception / tactics slices, LOD gates, global line-of-sight budget, event routing |
| Perception + utility brain | `src/ai/perception-utility.ts` | per-soldier memory, budgeted LoS queue, hysteresis-driven action choice |
| Squad blackboards | `src/ai/squad-convoy.ts` | postures (bound, flank, defend), fighting positions, contact picture, requests |
| Convoys | `src/ai/squad-convoy.ts` | road columns with breadcrumb trails, spacing, contact drills |
| Vehicle orchestrator | `src/ai/vehicle-orchestrator.ts` | atomic seat tickets, class-affinity crewing, 16 archetype controllers, helicopter insertions (land / fast-rope / parachute) |
| Tactical radio | `src/ai/radio-bus.ts` | fire missions, CAS, logistics, claimable tickets, danger-close zones |
| Positions / terrain analysis | `src/ai/positions.ts`, `terrain-analysis.ts` | defilade, fighting and firing positions, cover and foliage fields |
| Navigation | `src/systems/navigation.js` | 2 m grid, region corridors, budgeted A* |

## Behaviours that needed improvement (and the measured symptom)

1. **Operations were generated because a slot was free.** `planOffence` ran
   every think and opened an operation whenever any candidate existed and
   fewer than six were active: ~25 operations per side per 10 minutes, ~30 %
   failing. Free squads never used their own initiative: the commander gave
   every unassigned squad a DEFEND order at some owned flag, so even an empty
   neutral flag next door needed a formal operation.
2. **Operations were tactics, not purposes.** SECURE / ASSAULT / DEFEND /
   AIR ASSAULT / SIEGE described *how*, not *what for*; nothing could express
   "wear this defence down from range" or "take out the battery that keeps
   killing us". DEFEND duplicated the garrison logic.
3. **No physical staging.** Assaults assembled in a field position 165–200 m
   from the objective; friendly facilities (bases, depots, outposts) were
   never used to organise a force.
4. **Unit selection ignored what squads were doing.** The nearest free squad
   was taken even in the middle of a firefight; squads released by one
   operation were grabbed by the next in the same second (≈10 moves straight
   from one operation into another per run, 7 squads leaving an operation
   while in contact).
5. **Vehicles were committed because they existed.** Up to three armoured
   vehicles joined any assault by proximity; transports were not part of
   operations at all.
6. **Transport was opportunistic.** Squads boarded whatever carrier stood
   within 90 m; the drop point was recomputed when the carrier set off and
   again on contact. Only 11 % of passengers got off within 120 m of their
   squad's destination, and ~146 seat reservations expired per run (soldiers
   walking to vehicles they never boarded).
7. **Partial paths looked like arrival.** A path search that ran out of
   budget returned the closest reachable point; the driver treated its end as
   the destination.
8. **Vehicles as shells.** No exterior riders; occupants of closed vehicles
   were simply not drawn; no interiors, seats teleported on entry, no cockpit
   view.
9. **Debug overlay** showed one line per operation and little of the why.

## Design decisions

- **Assessment first, operations second.** Each think builds a situation
  (flag balance and trend, threatened flags, opportunities, enemy assets
  hurting us, free forces) and a short list of priorities. Candidate
  operations are scored against that; a candidate must beat a threshold that
  rises with every active operation, and must be something routine behaviour
  would not achieve anyway. The commander can and usually does decide to do
  nothing. Routine work (garrisons where they are needed, squads taking
  nearby objectives on their own initiative, reinforcing a threatened flag)
  happens without operations.
- **Operation = purpose × medium × method.** Purposes ATTACK, WEAKEN,
  CAPTURE; media REMOTE, ON_SITE, MIXED; the existing tactics become methods
  (direct capture, deliberate assault, air assault, siege, pressure, strike,
  hunt). Each operation keeps its reason, venue and outcome.
- **Staging at friendly facilities.** Major operations pick a venue among
  our own objectives and base (distance to target, facility capacity, safety,
  forces nearby) and assemble there physically before moving to the line of
  departure. Local operations go straight in.
- **Organic participation and no stealing.** Units in contact, recovering
  from a failed operation, or committed elsewhere are not taken; garrisons are
  released only from safe flags, two per think. Failed operations put their
  units into a short recovery at the venue instead of straight into the next
  plan.
- **Vehicles by need.** Armour only against real resistance or enemy armour,
  transport only when the march is long, air defence only when enemy aircraft
  have been about, a supply truck for long major operations.
- **Persistent transport tasks.** A carrier keeps the destination it was
  given at boarding (adapting only if that point becomes unsafe), squads
  remember carriers they failed to board, partial paths are re-planned instead
  of treated as arrival.
- **Riders, interiors, cockpit view.** Exterior seats on armour use the same
  ticket system with explicit positions; interiors and animated controls are
  near-detail meshes; occupants are drawn when the camera can see them.

## What was built

### Commander (`src/ai/commander.ts`)

- `assess()` builds the situation every think (flag balance, two-minute ticket
  trend, threatened flags, flags changing hands, enemy vehicles that keep
  killing us, free forces) and the priority list: SURVIVE, FINISH, HOLD,
  CATCH UP, EXPAND, DEGRADE, BREAK STALEMATE, CONSOLIDATE.
- `decide()` scores CAPTURE (direct capture / deliberate assault), ATTACK by
  PRESSURE and WEAKEN (STRIKE / HUNT) candidates as benefit − cost. Benefit is
  the flag's value × 1.6 if the enemy holds it × urgency from the priorities;
  cost grows with the force required, the distance and failed attempts. The
  best candidate must clear `1 + 0.4 × load` (major operations count double).
  A capture is only a candidate if eligible squads within reach (450 m for a
  local one) can actually form it. Declines are logged with their numbers.
- Routine work without operations: `reinforce()` (threatened flags draw the
  nearest uncommitted squads as garrison), `setBias()` (initiative squads are
  steered toward open, weakly held front flags and away from strongholds,
  flags an operation handles and recently failed targets), garrisons with
  hysteresis (held at least 90 s; released when the threat has passed).
- Operation lifecycle: ASSEMBLE at the venue (readiness = present ÷
  required) → MOVE_UP to the line of departure → PREP fires → EXECUTE →
  CONSOLIDATE; a 30 s `review()` re-justifies (defence grew past what we can
  concentrate → cancel or raise the force); deadlines per method; FAILED and
  CANCELLED squads regroup at the venue for 25 s and are not sent straight
  back at the same target for 150 s.
- `pickVenue()`: own uncontested facilities 150–700 m from the target on our
  side of it, scored by capacity (base 3 … village 1.2), free troops nearby,
  approach distance, safety and other operations staging there.
- `eligible()`: free, not in contact, not recovering, not mounted, not about
  to finish its own capture, not the target it just failed on.
- `commitVehicles()`: armour against a real defence or enemy armour, air
  defence after enemy aircraft were seen in the last two minutes, a supply
  truck for big deliberate operations; vehicles going for repairs are
  released from their operation.
- Endgame: SIEGE stages like any major operation; when the enemy retakes an
  objective the siege force turns on it (`siegeLifted`) instead of
  disbanding. The exposed side's priorities switch to SURVIVE; nothing is
  mass-cancelled (garrisons go only as their flags are lost).

### Vehicles and transport (`src/ai/vehicle-orchestrator.ts`, `squad-convoy.ts`, `systems/navigation.js`)

- Persistent trips: a carrier keeps the destination taken at departure; it
  changes only when the passengers' squad is re-tasked (goal moved > 50 m);
  the drop point is re-planned around the same destination on contact or
  when it lies in a danger zone; a 40 s no-progress watchdog (60 s in a
  convoy) drops the passengers short of the goal instead of circling.
  Outcomes: delivered / blocked / interrupted, with the reason kept per
  vehicle.
- Partial paths are flagged (`NavState.partial`) and searched on from their
  end immediately; the driver no longer brakes at the end of one as if it had
  arrived.
- Squads remember a carrier they failed to board (90 s) and soldiers a
  vehicle they could not reach in time (60 s).
- Convoy members leave a column whose destination drifts more than 160 m
  from their own, or that has stopped bringing them closer for 45 s.
- Maintenance: ground vehicles below half health with no passengers break
  off to the nearest supply truck or service station and return above 90 %.

### Riders, interiors, animations

- Rider positions (`role: 'rider'`, `exterior`, `face`, `pose`) on tanks (6),
  light tanks, IFVs and APCs (4). Tickets cover them like any seat. Carriers
  use them as overflow; squads that fit ride tanks heading their way and get
  off on arrival, contact, the tank turning away, stopping for 10 s or being
  hit hard. Riders are visible and can be shot; a destroyed vehicle throws
  them clear. Players can ride and fire their rifle from the deck.
- Interiors (`models/vehicle-interiors.js`) are generated from each seat
  layout: seats, benches, instrument panels, sights, periscopes, grab rails,
  compartment walls with vision blocks, cab and cockpit frames with open
  windows; built once per vehicle type and drawn only from a seat view.
- Animated parts: steering wheels, tiller bars, cyclic / collective, stick
  and throttle; hatch lids (crews turn out when there is no fight and button
  up for 20 s after a hit or a sighting); cab doors, rear troop doors,
  tailgates and a sliding helicopter door open while people get in or out.
- Climb-in / climb-out transitions (0.55 s / 0.45 s); drivers' and pilots'
  hands follow the wheel, levers and sticks; turret crews ride round with the
  turret.
- Seat view (V key / VIEW button): camera at the occupant's eyes (turned out
  of the hatch for armour crews), easing between seats.

### Evaluation

`tools/ai-eval.mjs` (seeded, headless, any build), `tools/vehicle-occupants-test.mjs`
(browser: riders, hatches, doors, transitions, seat views),
`tools/endgame-test.mjs`, `npm test`, `tools/e2e.mjs`. `?simseed=N` makes a
manual session repeatable.

## Measured results (3 seeds × 10 simulated minutes, 100 v 100, bots only)

`node tools/ai-eval.mjs <dist> 600 1,2,3` on the previous build (git worktree
of 253bd24) and this one, same seeds:

| Metric | Before | After |
|---|---|---|
| Operations opened per side | ~14 | ~8 (plus ~11 logged declines) |
| Moves straight from one operation into another | 0 | 0 |
| Squads leaving an operation while in contact | 0 | 0 |
| Objective ping-pong (back to the previous objective within 60 s) | 0 | 1 |
| Passengers dropped within 120 m of their squad's destination | 11 % | 39–46 % |
| Seat reservations expired | 146 | 85 |
| Vehicles that carried someone | 21 % | 32 % |
| Vehicles that fired | 58 % | 60–65 % |
| Stuck events per km driven | 5.5 | 4.1 |
| Exterior rider boardings per run | 0 | ~5 |
| Average sim frame / AI cost | 6.2 ms / 0.63 ms | 6.0 ms / 0.59 ms |

Carrier trips: ~70 % delivered at the planned point, ~25 % dropped short by
the no-progress watchdog (blocked by traffic or terrain, passengers walk on),
the rest interrupted. Browser checks: `tools/e2e.mjs` (all tiers, draw calls
within budget), `tools/vehicle-occupants-test.mjs` (28 checks),
`tools/endgame-test.mjs` (all pass).

## Failure investigation (second pass)

Method: measure first (`tools/ai-eval.mjs` census, `tools/nav-behaviour-test.mjs`,
probes of individual stuck soldiers and vehicles), fix the cause, re-measure on
the same seeds against the previous build.

### Root causes found

| Symptom | Cause (verified) | Fix |
|---|---|---|
| Soldiers running into building walls | Nav grid only blocked cells whose centre was < 0.6 m from a thin wall; a wall can lie 1 m from every centre, so walls had gaps and all four base hangars were missing from the grid entirely | Blocking distance = half a cell on the wall's dominant axis (no gaps) |
| Paths through walls of rotated buildings | `lineClear` sampled every metre and slipped between diagonally touching wall cells (A* itself forbids that) | Exact cell traversal with the same no-corner-cutting rule |
| Leaks beside interior doorways | Partition doorway carves extended through the outer wall | Carves clipped to the inside of the building |
| Jamming in doorways | Paths went to grid-cell centres, not the real 1.2 m opening | Paths threaded through the true door axis |
| Endless pushing at unreachable goals | No-path fallback walked straight at the goal; "stuck" measured by displacement, so sliding along a wall never counted | Progress toward the goal; re-plan → side step → give up (goal refused 30 s); seat reservations released, squads skip unreachable waypoints |
| Crews never reaching aircraft / expired seat tickets | Same missing hangars | (nav fix) |
| Idle soldiers | Mostly garrisons; a squad left behind as sole garrison was never released after the front moved on | Quiet rear garrisons go back to work after 90 s |
| Convoys falling apart on contact | Any sighting within 220 m made every carrier in the column unload | Column keeps moving; only a carrier itself in danger unloads |
| Base SAM | 760 m range from the island edge, one-hit kills, no lock time | 450 m, 3 s track before launch, two hits to kill |

### Why Torsa loses (measured, not changed by fiat)

Torsa fields 29 vehicles to Pampalona's 8; 34 of its 100 soldiers are crew or
pilots, so it has ~60 soldiers on foot against ~80. Its vehicles kill more
(most Pampalona deaths are vehicle kills) but fight from stand-off positions,
outside the 16 m capture circle. Capturing needs bodies on the objective, so
Torsa takes and holds fewer flags. Changes: armour drives onto a flag once
the defence is light and no AT weapon has been seen near it; carriers deliver
squads; garrisons are freed for operations. Remaining gap is a faction
composition effect.

### Respawn and capture

A defender killed at a contested flag can respawn at that same flag 5 s later
(the spawn chooser only adds a 150 m penalty for "contested"). Measured: 0–4
of ~150–200 spawns per side per 10 minutes land within 40 m of a flag with
enemies in its circle, so this is not the main reason flags are hard to take.
Not changed, per instructions; spawn choice stays in `Game.spawnSoldier`.

### Results (3 seeds × 10 min, same seeds, previous build → this build)

| Metric | Before | After |
|---|---|---|
| Soldiers still 30 s+ with no target | 25.3 % | 14.8 % |
| Building entry / exit / walk-around (real movement, 37 buildings) | 26 / 11 / 27 | 36 / 36 / 35 |
| Time grinding while trying to walk (behaviour test) | 80 % | 19 % |
| Seat reservations expired unused | 77 | 8 |
| Vehicles parked at spawn | 17.6 % | 11.8 % |
| Vehicles that fired | 57 % | 80 % |
| Vehicle stuck events per km | 5.0 | 4.2 |
| Flags held by Torsa (avg) | 3.3 | 3.8 |
| Objective captures per run (P + T) | 8.0 + 4.3 | 8.7 + 5.3 |
| Base SAM kills per run | 8.7 | 4.0 |
| Objective flips per run (worse) | 0.7 | 2.0 |
| Vehicles stopping on contact far from their goal, per min (worse) | 0.27 | 0.60 |
| AI cost per frame (worse) | 0.59 ms | 0.71 ms |

Unresolved: vehicle-park jams (blocked mostly by unmanned parked vehicles),
more objective re-choices since garrisons are released, ~25 % of carrier
trips still end short, AI cost +0.12 ms.
