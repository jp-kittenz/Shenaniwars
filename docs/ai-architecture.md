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

## Third pass: coherence, vehicles, perception, requests

### Confirmed root causes

| Symptom | Cause found | Change |
|---|---|---|
| Firing into walls | 65 % of bot rifle fire was suppression at a last-known point with no check that the line of fire was clear; a "visible" flag could be a perception cycle stale; enemies known only from a comrade's report were shot at like sighted ones | Knowledge level per target (in sight / own last sighting / reported / suspected); suppression only on own sightings; a one-ray line-of-fire check per burst; three blocked bursts → stop firing from there and move |
| Transport and squad forget each other | Unloading cleared both links (`man.squadId`, `q.vehicle`); nothing persisted after the drop | Explicit relationship on both sides (boarding → riding → escort / standby → pickup → released / lost, each with a reason); IFVs escort, trucks / APCs wait out of the way while the squad is on a task, the squad's own transport comes back for a long move or an extraction, release conditions (squad gone, reassigned, repairs, not needed 4 min) |
| No convincing support requests | Requests existed (fire, CAS, logistics, extraction) but outcomes were invisible; Pampalona has no artillery so its fire missions vanished; Torsa's artillery aborted claimed missions 22× in 6 min (danger close) | Requests nobody can answer are turned down at once; artillery walks the aim point beyond the enemy instead of aborting; extraction is followed by the squad (requested → coming / denied → done), ground carriers answer it, a denied squad breaks off on foot |
| Most infantry sitting in garrisons | With no enemy flag open to initiative, every free squad became a garrison at a quiet front flag; garrisoned squads do not count as available, so operations could not form | A quiet front flag gets one squad; surplus squads wait in reserve at the nearest own flag and stay available to operations |
| Artillery never leaves base | It does not need to: ranges are 950–1000 m, the base covers most objectives. Idle time was mostly missions aborted or unanswered (above) | No forced movement |

### Not fixed / partial

- Vehicle stuck events (~4 per km) and base congestion: classified by phase (base departure, open travel, arrival, return) and by stationary reason, not solved.
- Convoys are still formed opportunistically (vehicles heading the same way); now instrumented: genuine convoys (≥30 s and ≥150 m together), arrivals and breakup reasons.
- CAS requests: mostly claimed but lapse before completion.

### Results (3 seeds × 10 min, previous build → this build, same seeds)

| Metric | Before | After |
|---|---|---|
| Point-blank blocked suppressive shots (5 min, seed 1) | 2,559 | 39 |
| Aimed shots at "visible" targets actually blocked (5 min, seed 1) | 1,076 | 271 |
| Soldiers with 15+ blocked shots in a row (5 min, seed 1) | 57 | 0 |
| Fire missions claimed / carried out per run (accepted requests) | not instrumented | 17–23 claimed of 17–23 / 6–11 done |
| Danger-close aborts of claimed fire missions | 22 per 6 min | 2–5 per 10 min |
| Extraction requests answered / delivered per run | not instrumented | 4–11 of 9–16 / 3–9 |
| Genuine convoys (≥30 s, ≥150 m together) that arrived | not instrumented | 25 of 40 |
| Vehicle contact stops far from destination, per min | 0.87 | 0.60 |
| Passengers dropped within 120 m of destination | 45.5 % | 50.5 % |
| Vehicles that carried someone | 27.9 % | 33.3 % |
| Soldiers in garrisons per side (avg) | ~40–50 (2-seed census) | 33–53 (unchanged within noise) |
| Vehicle stuck events per km (worse / noise) | 3.5 | 4.2 |
| Objective flips per run (worse) | 2.3 | 4.0 |
| AI cost per frame | 0.72 ms | 0.69 ms |

## Fourth pass: driving, vehicle parks, planned convoys, specialized vehicles, request lifecycle

### Causes found (measured before changing anything)

| Symptom | Cause found | Change |
|---|---|---|
| Vehicles stuck 3.6× per km | Classified 226 stuck events (2 seeds): 29 % drove into cells the vehicle grid marks blocked (corner cutting: waypoints were "reached" 8–10 m early and paths skimmed obstacles at the minimum margin), 18 % sharp turns (waypoint 70–180° off, wheeled vehicles circling), 9 % stationary friendly vehicles ahead (not in the route planner at all), the Torsa vehicle park (slots packed 1.8 m apart along the departure side) | Clearance-aware vehicle routes (cost by distance to obstacles, shortcuts never closer than the searched route); stationary vehicles, wrecks and fresh jam spots stamped into a dynamic vehicle layer the planner routes around (a vehicle ignores its own footprint); pure-pursuit path following with corner speed limits; three-point turns for wheeled vehicles; a jam spot is marked and routed around instead of retried; parked vehicles do not start up to shuffle a few metres (settle) |
| Base congestion, failed returns | Vehicles returned to their exact spawn point, often taken; spawn slots formed a wall across the gate side | Marked parking slots in two rows with a departure lane and an aisle that stay clear; returning vehicles reserve a free slot that fits (own first), give up a slot they cannot reach; rebuilt / recovered vehicles appear in a free slot; nothing parks in the lanes |
| MLRS inactive (player's hypothesis: launcher traverse) | Confirmed: the launcher traverses only ±46° and needs ≥0.2 rad elevation (≈370 m minimum range); after each mission it "scooted" **away** from the target and then faced away from the front, so later missions behind it could never be laid, while it held the ticket until it lapsed | Missions are claimed only within the launcher's range band; the vehicle turns to bring the launcher to bear (tracks pivot, wheels shuffle back and forth), hands the mission back after 40 s if it cannot, faces the front while idle; artillery lobs when the low arc is below the minimum elevation; every battery states why it is (not) firing |
| CAS accepted, then expired | The gunship completed a ticket only if the designated target died; point targets never completed; tickets were not kept alive while the aircraft was en route (45 s life); claims reopened silently | Tickets carry the provider's progress and a final outcome; providers keep a ticket alive while visibly working on it, capped (gunship 150 s, jet 120 s, artillery 90 s); the gunship completes after two attack passes with weapons fired (or reports "no target found" after four); a run aborted twice for danger close is called off with the reason; damaged / destroyed providers hand back with a reason |
| Squads did not know what happened to requests | No feedback except for extraction | Each squad follows its fire, air-support and resupply requests: requested → accepted (provider status) → done / denied (why) / failed (accepted, not carried out) / unanswered; no new request on top of a pending one |
| Convoys were coincidental | Any vehicles within 70 m heading within 120 m of each other became a "convoy" | Convoys are planned at departure: vehicles setting out on a ≥350 m trip within 20 s of each other from the same place to the same area; stated purpose (operation role, troop lift, move-up, return); form up outside the gate (or where the first vehicle is), move off when all are there (≤40 s), followers keep station on the leader's track, separated / stuck / lagging members drop out, the convoy dissolves on arrival or when members' tasks change; team pennant on every member (low while forming up), linked on the minimap, listed in the ops panel |
| Repeated pickups into fire | A destroyed pickup vehicle was replaced by the next one sent to the same spot | No pickup / extraction for that squad for 90 s after a transport is destroyed on the way (the squad is told) |
| Garrisons | A quiet front flag always took a full squad, wherever the enemy was | Garrison need scales with the distance to the nearest hostile objective (5 / 4 / 3 soldiers), threatened flags as before; defensive squads go first where a garrison is short and change post at most every 45 s |

### Investigated, not changed

- Torsa's smaller infantry: the crew rule is the same for both sides (one crewman per ground vehicle, two for tanks / half-tracks / scout cars, one pilot per aircraft, at most 40 % of the side). Torsa's roster has 29 vehicles to Pampalona's 8, so 34 of its 100 are crew. Crews spend ~94 % of their time in vehicles (not idle), so this is a roster decision, not an AI fault.
- Objective switching: 2.3–2.7 flips per run on the previous build with these seeds (not the 4.0 seen earlier); after this pass 1.3–2.3.

### Results (3 seeds × 10 min, 100 v 100, previous build → this build, same seeds)

| Metric | Before | After |
|---|---|---|
| Vehicle stuck events per km | 3.62 | 1.82 |
| Stuck events while returning to base (3 runs) | 151 | 37 |
| Stuck events while leaving base (3 runs) | 123 | 94 |
| Vehicles standing ≥10 s in base lanes (avg) | 2.54 | 0.21 |
| Returns that ended parked at base (per run) / avg time | 6 / 54 s | 23 / 23 s |
| Destination flip-flops (goal jumps away and back within 15 s, per run) | 119 | 37 |
| Speed while travelling (% of max) | 38 % | 46 % |
| MLRS fire missions (3 runs) | 1 | 22 |
| Howitzer fire missions (3 runs) | 14 | 37 |
| Fire missions: accepted / carried out / lapsed after acceptance (3 runs) | 71 / 15 / 51 | 69 / 59 / 1 |
| CAS: accepted / carried out / lapsed after acceptance (3 runs) | 79 / 15 / 54 | 70 / 45 / 17 |
| CAS never answered (no aircraft free in time) | 72 | 78 |
| Extraction: accepted / delivered (3 runs) | 14 / 10 | 14 / 9 |
| Convoys formed / moved off together / ≥150 m / arrived together (3 runs) | 174 coincidental / – / 40 / 22 | 36 planned / 32 / 20 / 13 |
| Garrison soldiers per side (avg, Pampalona / Torsa) | 42 / 37 | 40 / 33 |
| AI cost per frame | 0.52 ms | 0.57 ms |
| Frame time (headless, avg / p95) | 4.75 / 7.27 ms | 4.68 / 7.33 ms |

Not solved / caveats:
- Leaving the base is still the worst phase for stuck events (vehicles squeezing past each other in the lane and gates).
- About 75 CAS requests per 3 runs go unanswered because no aircraft is free in time; squads are told so.
- Fewer convoys than before by design (only planned ones count); about one in three still breaks up, mostly because members' destinations change (commander re-tasking).
- Torsa held fewer flags on average in these runs (3.85 → 3.26, 3 seeds; its end tickets were not lower). Not confirmed as a regression at this sample size; the rules changed are identical for both sides.
- The convoy pennant and squad-waiting behaviour have no earlier baseline.

## Fifth pass: operational reliability, convoy cohesion, deadlocks

Measured first on the starting build (5 seeds × 10 min, then 5 more), with new evaluation metrics that read only
generic game state, so every build is measured the same way: convoy gaps, separations and rejoins, vehicle returns
and idle time, capture attempts followed to their outcome, free infantry, and each minute classified as fluid
(a flag changed hands), contested (both sides in a capture circle), operational deadlock (operations running, no
squad reached a target), attacks that reached targets without a contest, resource deadlock (a side with almost no
free infantry), or passive.

### Causes found

| Symptom | Cause found | Change |
|---|---|---|
| Convoys dissolve, no visible column | Members were re-sorted every second (leaders swapped, vehicles jostled); the journey's destination was the leader's own goal at every tick, so when it flickered (standoff points, re-tasking) followers "diverged" and left (66 departures per 5 runs); followers aimed at fixed slots behind the leader, not behind the vehicle ahead; any lag or stall removed a member for good; assembly slots ran back through the gate | Order fixed while forming up and frozen at departure (front-most first, nobody overtakes); the journey destination is the convoy's (refined only when the head's own goal moves within 250 m; a bigger change must last 8 s, then the convoy re-routes if most members share it, else the head drops out); followers keep an interval behind the vehicle ahead along the leader's track, sized by both hulls and speed; the leader slows for a gap and waits for a straggler, which is separated after 25 s and may rejoin within 75 s; forming up two ranks abreast outside the gate; badly damaged members may leave for repairs; convoy waits do not count as a blocked transport |
| Armour "busy" all the time, rarely returning | Commander-tasked vehicles were given a new firing position every 20 s (8 s in an assault) whether or not the old one worked; vehicles without an operation re-chose the flag to watch every tick; both made them drive constantly (mode flips transit↔overwatch↔hold ≈ 200 per 10 min) | A firing position is kept until the crew has seen nothing from it for 15 s (assault) / 60 s, or it is taking hits; the watched flag keeps a margin; a quiet own base is never watched (armour had been parking in the park aisle) |
| Squad objectives abandoned | Squads on their way to take a flag were turned into garrisons for quiet flags (31–35 per run) or recruited by operations elsewhere; squads toggled between reserve and initiative when an objective flickered open | Only a threatened flag pulls a committed squad off its attack; an operation does not recruit a squad closing on another objective (unless it is on the way); a squad in reserve stays at least 25 s |
| Operations stall for 80–150 s before failing | Nothing between "stalled" and "failed" | Mid-assault review after 40 s without progress: enough force → more fire and the nearest free squad joins; clearly outnumbered → pulled back early with the diagnosis |
| Hard to tell what a unit is doing | — | Vehicle assignment record (operation / carrying a squad / supporting a squad / radio request / repairs / going home / own initiative / idle), how long, why it changed; convoy position and phase; squad objective, distance, time on it and why it was assigned (`?debug`, aim at a unit) |

### Torsa's flags (Part 5)

Over 10 seeds the starting build held 3.75 flags for Torsa on average; the build before the previous pass held
4.19 (5 seeds). The previous pass's changes did cost Torsa about 0.4 flags. Per-seed spread is large (±1 flag), so
anything under ~0.4 on 5 seeds is noise. Rosters, crew rules and decision rules are unchanged and identical for
both sides.
| Transport trips blocked short of the drop point | After the changes above, trucks were repeatedly blocked at the same spots (one spot four times in a run): the 25 s jam mark expired and the next trip drove into the same trap | A blocked drop marks the spot for route planning for 2 min, for every vehicle (blocked drops 22 → 7 per 10 runs) |

### Results (10 seeds × 10 min, 100 v 100, starting build → this build, same seeds)

| Area | Metric | Before | After | Verdict |
|---|---|---|---|---|
| Convoys | formed / moved off together / travelled ≥150 m / arrived together | 129 / 126 / 70 / 41 | 113 / 111 / 59 / 47 | improved (arrival 59 % → 80 % of longer journeys) |
| | members leaving because their destination "diverged" | 126 | 40 | improved |
| | breakups of longer journeys | 29 | 12 | improved |
| | gap between consecutive members: avg / max; share 8–45 m | 42 m / 233 m; 68 % | 35 m / 211 m; 72 % | improved (max still large) |
| | separated members that rejoined | – (no rejoin) | 9 of 24 separated | new |
| Vehicles | returns ending parked at base, per run / avg time | 16.5 / 22 s | 20.9 / 22 s | improved |
| | returns interrupted, per run (mostly picked up a new squad) | 6.7 | 6.1 | unchanged |
| | crewed vehicles idle in the field with no task (avg) | 0.49 | 0.22 | improved |
| | vehicle goal jumps >60 m / flip-flops, per run | 438 / 46 | 314 / 31 | improved |
| | stationary vehicles in base lanes (avg) | 0.42 | 0.36 | unchanged |
| Squads | objective flips per run | 2.8 | 2.4 | inconclusive |
| | capture attempts per run / captured with the squad there | 90 / 21.6 | 87 / 23.9 | slightly better |
| | attempts reassigned within 20 s / before arriving | 15.9 / 19.8 | 14.0 / 19.0 | unchanged |
| | squads stalled short of their objective (% of 10 s samples) | 8.1 % | 11.6 % | worse |
| Objectives | flags held (Pampalona / Torsa) | 6.01 / 3.75 | 5.55 / 4.62 | Torsa recovered (all 10 seeds ≥ 4.26) |
| | captures per run (P / T) | 8.3 / 5.1 | 7.6 / 6.8 | |
| | free infantry (P / T) / garrison soldiers (P / T) | 23.7 / 10.7; 41.8 / 33.3 | 22.6 / 13.6; 40.3 / 32.2 | small shift to free infantry |
| Operations | planned / succeeded / failed / cancelled per run | 20.0 / 8.2 / 5.5 / 0.8 | 21.6 / 8.7 / 5.5 / 2.1 | unchanged; more early pull-backs |
| | mid-assault reviews / reinforced / pulled back early (10 runs) | – | 64 / 24 / 6 | new |
| | failure causes (10 runs) | underestimated 26, reinforced 12, held up 10, route 4, force 2 | underestimated 27, held up 13, reinforced 10, route 6, force 5 | unchanged |
| Deadlocks | minutes: fluid / contested / operational / reached-no-contest / resource / passive (of 100) | 54 / 11 / 16 / 2 / 3 / 4 | 49 / 9 / 12 / 14 / 6 / 0 | operational deadlock down; more minutes where attacks reach targets without a contest |
| Driving | stuck events per km | 1.84 | 1.92 | unchanged (noise) |
| Transport | trips / delivered | 204 / 176 (86 %) | 176 / 146 (83 %) | slightly worse / inconclusive |
| Support | fire missions / CAS / extraction carried out; MLRS missions | 163 / 136 / 29; 68 | 163 / 130 / 23; 64 | unchanged within noise (extraction slightly down) |
| Performance | AI ms per frame / frame avg / p95 (headless) | 0.70 / 5.77 / 8.80 ms | 0.69 / 5.84 / 8.90 ms | unchanged |

Not solved: the largest convoy gaps still reach ~200 m (a member held up at a junction); squads that reach a
flag but do not contest it (fighting from 100–180 m) are now the most common non-fluid minute; operations still
fail mostly from stale intelligence (defenders underestimated); transport delivery is a few points lower.
