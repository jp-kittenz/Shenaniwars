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

## Sixth pass: tactical layer (soldiers, squads, positions)

### What already existed (inspected before changing anything)

Perception with memory and knowledge levels (seen / own last sighting / reported / heard), per-soldier skill
(detection, reaction delay, accuracy), utility-scored actions with hysteresis (advance, engage, suppress, take
cover, bound, flank, ambush, regroup, retreat, investigate, board, heal, repair, screen armour), a cover field,
planned fighting positions for squads holding ground, squad postures (assault, bounding overwatch, flank,
regroup, mounted, hold), a leash that keeps squads under orders from chasing kills, line-of-fire checks before
firing, idle glances, and a straggler wait for leaders.

### Root causes found

| Symptom | Cause | Change |
|---|---|---|
| Defenders pacing back and forth (≈11 post changes per soldier-minute) | "At the objective" meant inside the flag's radius (~20 m) but planned posts reach 34 m: a defender at its post scored ADVANCE, walked in, counted as arrived, walked back out (patrol↔advance was 2/3 of all action flicker) | Inside the squad's planned area counts as at the objective |
| Posts reshuffled | The position plan was recomputed every 9 s with a seed that changed every 30 s, members assigned by index (soldiers crossed the position) | Plans stand until something meaningful changes (task / place, a sustained threat from another direction — at most every 20 s —, a post destroyed, squad size); members prefer posts near where they stand |
| Defenders wandering off | Posted soldiers left to investigate any noise within the 60 m leash; in a fight they did random 3 m sidesteps and drifted toward the enemy | Posted soldiers only investigate noises within 25 m (else they turn to watch); they fight from their post, shifting at most 10 m when the line of fire is blocked |
| Buildings never used | The cover field was built from props only; the planner forced every defender (except AT / spotter) inside the 16 m capture circle, while most villages' houses stand 20–35 m from the flag | Cover nodes behind every ground-floor window (facing out) and at building corners (728 + 580 nodes); in a flag defence three riflemen hold the circle and further ones may overwatch it from windows that look onto the flag |
| Squads strung out on the move (34 % of members > 50 m from the leader) | The leader sprinted to the goal regardless of the squad; members beyond 60 m stopped following the leader and headed for the goal on their own (two groups) | The leader walks while anyone trails by > 30 m; stragglers up to 220 m catch up with the leader |
| Squads stopping for every distant enemy | ENGAGE (0.55+) beat ADVANCE (0.38) for any visible enemy | On a task (attack / move / heading for a flag), an enemy beyond ~100–150 m (by temperament) is engaged on the move (marching fire); close or suppressing threats still stop them |
| Every soldier reacts the same | Only accuracy / reaction differed | A fixed temperament per soldier (leaders and skilled ones bolder) shifts going to ground, pressing on and breaking |
| Infantry in front of moving vehicles | Vehicles slowed for soldiers but soldiers ignored vehicles | Soldiers step off the path of a friendly vehicle heading at them, and look at it |

### Squad intent and explainability

Each squad has an explicit state (traveling, arriving, contesting, defending / moving to defend, holding,
securing, interrupted by contact, regrouping, waiting for stragglers, mounted, unable to reach its objective) and a
log of its last objective changes with the reason. The `?debug` explanation (aim at a soldier) shows the squad
state, operation, leader, members on foot and the furthest from the leader, the recent objective changes, the
soldier's post (window / building corner / cover / open, taken or how far), whether a visible enemy lies outside
the squad's task area (fighting from here, not chasing), and when it is stepping out of a vehicle's way.

### Convoy formation funnel (Part 6)

Every long departure (≥ 350 m) is now followed to "in a convoy" or a recorded reason it went alone. In 8-minute
runs about half the long departures ended in a convoy; the rest had no other vehicle of the side setting out within
20 s (the commonest), were going elsewhere, or were not eligible (artillery / SAM, holding, stuck). A vehicle
setting out just behind a moving convoy to the same place now falls in at its tail.

### Results

Controlled scenarios (same squad, same start, commanders paused; old build → this build). Defend a village flag
for 120 s: members inside a building / at cover / in the open, post changes after settling, actions reverted
within 4 s. Travel ~420 m: members > 50 m from the leader.

| Scenario | Before | After |
|---|---|---|
| Defend ECHO | 1 / 1 / 5; 98 post changes; 73 reverted | 1–4 / 0–3 / 2–4; 39–76; 15–43 (varies with contact) |
| Defend DELTA | 1 / 0 / 7; 115; 14 | 1 / 3 / 4; 13; 10 |
| Defend HOTEL | 0 / 1 / 7; 98; 35 | 2 / 3 / 3; 4; 3 |
| Travel to ALPHA | 29 % far from the leader, spread 14 m, 68 s | 0 %, 12 m, 79 s (the leader paces the squad) |

Full battles (10 seeds × 10 min, 100 v 100, previous build → this build, same seeds):

| Metric | Before | After | Verdict |
|---|---|---|---|
| Action changes per soldier-minute / reverted within 4 s | 6.1 / 43 % | 4.0 / 24 % | improved |
| Abrupt target switches per soldier-minute | 0.48 | 0.34 | improved |
| Defenders in a building / at cover / in the open | 4.7 / 22.5 / 72.9 % | 19.3 / 36.2 / 44.5 % | improved |
| Defenders crowded (< 2.5 m apart) | 6.4 % | 3.1 % | improved |
| Defender post changes per minute | 10.9 | 2.0 | improved |
| Travelling squads: spread / members > 50 m from the leader | 53 m / 34 % | 44 m / 20 % | improved |
| Squad spread 20 s after dismounting | 28.5 m | 25.1 m | slightly better |
| Friendly soldier in a moving vehicle's path | 0.90 % | 0.58 % | improved |
| Soldiers still > 15 s with nothing in sight (of soldier time) | 13.0 % (12.3 holding a post) | 28.0 % (26.4 holding a post) | defenders now stay at their posts; unexplained stillness ≈ 1 % in both |
| Line-of-fire checks blocked | 12.5 % | 12.6 % | unchanged |
| Squad objective flips per run | 2.2 | 1.6 | improved |
| Capture attempts: captured with the squad there / reassigned before arriving | 25.2 / 13.3 | 22.6 / 18.5 | worse / inconclusive |
| Minutes with a capture / operational deadlock (of 100) | 42 / 19 | 51 / 12 | improved |
| Flags held (Pampalona / Torsa) | 5.94 / 4.25 | 5.30 / 4.63 | |
| Operations succeeded / failed per run | 7.6 / 6.0 | 7.2 / 5.2 | unchanged |
| Convoys ≥150 m / arrived together | 60 / 48 | 55 / 33 | worse: more convoy vehicles destroyed on the way (14 vs 4) — not confirmed as caused by this pass |
| Stuck events per km | 1.84 | 1.81 | unchanged |
| Transport trips delivered; fire / CAS / extraction carried out | 180 of 211; 169 / 161 / 32 | 144 of 177; 155 / 128 / 18 | within the run-to-run spread of the *same* previous build (another 10-seed run of it gave 146 of 176; 163 / 130 / 23) |
| AI ms per frame / frame avg / p95 (headless) | 0.86 / 7.0 / 12.1 ms | 0.72 / 5.9 / 9.2 ms | cheaper |

Run-to-run spread is large for support and transport counts even on an identical build (non-deterministic AI time
budgets); differences of 20 % there are not meaningful on 10 seeds.

## Seventh pass: objective commitment, upper floors, dismount cohesion, convoy formation

A completion pass on four specific problems, each traced to its cause before changing anything. No new layer
of command: the commander still assigns tasks, the squad decides how to carry them out, soldiers act.

### 1. Squads that stop short of the capture circle

Measured first: of the attack attempts that reached a flag's area, about a quarter never entered the 16 m capture
radius; squads fought from outside it for 159 squad-minutes per 10 runs (one case 185 s) and "contested
deadlock" was the commonest stalled state.

Causes:
- the **support-by-fire squad** of an operation stayed at its firing position for the whole operation, even
  after the assault squad was already in the circle and needed the numbers to tip the capture;
- attack squads that met defenders near the flag **stayed in bounding overwatch** (each half waiting on the
  other) with nothing to end it; the "rush the last 75 m" rule only applied inside 75 m;
- attackers that did enter took cover or engage goals up to 24 m away and **walked back out of the circle**.

Changes (`squad-convoy.ts` `updateCapture`, `perception-utility.ts`, `commander.ts`):
- each attacking squad has an explicit capture state: approaching → (stalled near it) final assault or pinned →
  in the circle / capturing; and defending for its own flag. A squad stalled for 15 s within 160 m decides from
  its known picture: with at least as many on foot as known defenders it makes a 40 s final assault (marching fire
  into the circle from up to 170 m); outnumbered, it is *pinned*: it holds and its existing support requests carry
  on (no blind rush);
- once the assault is in the circle (operation in EXECUTE), the support-by-fire squad moves in too;
- soldiers of a squad that is in the circle / capturing / in a final assault keep their goals inside the radius
  (cover and engage goals are clamped to the circle edge);
- the state and its reason show in the squad's intent (`?debug`).

### 2. Upper floors

Soldiers could physically climb the stair ramps but nothing ever sent them up: the 2D infantry grid only knows the
ground floor and every building cover node was at a ground-floor window.

`src/ai/floors.ts` adds a lightweight extension instead of a new navigation system. For each building with an upper
level (a second storey, or the flat roof of a one-storey building) it keeps a 0.4 m grid of that level built from
the building's actual parts in its *current* damage state: cells a slab carries, minus walls, parapets, window
sills, the stairwell hole and the foot of the next flight up. The only connection is the first flight of stairs:

    ground grid → approach point inside, beside the stairs → foot → up the ramp → top → level grid → post

and the reverse on the way out. The agent walks every metre with ordinary movement and physics — no teleporting,
nothing passes through a slab. Posts (inside each upper window, or along a roof's parapet) join the cover field
with a floor flag and their storey height; the position planner rates them by their raised line of sight (+0.2
when supporting / defending) and allows a post upstairs above one downstairs. A soldier counts as at such a post
only once actually up there.

Robustness: a level is rebuilt lazily when its building's damage state changes (a damaged building keeps its
floors, so routes are re-cut around the new state; a ruined one has no level, its posts become invalid and squads
re-plan); stairs whose approach cannot be reached from a door on the ground grid (quayside buildings) are left out
at load; a route that makes no progress for 4 s re-plans from where the soldier stands, and after three tries (or
if the soldier never got onto the stairs) that building's upper level is avoided by that soldier for a minute while
the soldier holds its position. Load cost: one grid per building (84 levels, 524 posts on the default map), built once.

### 3. Squads scattering after leaving a vehicle

Measured: average maximum separation within 45 s of a drop 104 m; 237 members left more than 40 m from their
squad; in 95 of 333 drops the vehicle drove off through its own passengers.

Causes (traced drop by drop):
- **partial boarding** — a squad took any carrier with two free seats (a jeep for a squad of six) and the carrier
  left once 75 % of the *reserved* seats were filled, so most drops carried part of a squad while the rest walked;
  the riders then turned round and walked back to the leader left behind;
- carriers left the instant the last passenger was out, driving into soldiers still beside the hull;
- after the drop each soldier headed straight for its own wedge slot or task, with no common point.

Changes (`vehicle-orchestrator.ts`, `perception-utility.ts`):
- a squad (and its own transport coming back for it) only takes a carrier with room for all of it but one;
- a carrier waits for everyone who reserved a seat; it leaves short only once those missing are more than 60 m
  away or it has waited 20 s, and never past its existing timeout; when most of the squad nearby is still on foot
  at that point, the few aboard get out again and the squad walks together (no split ride);
- at the drop the squad gets a rally point beside the vehicle — on the side away from the threat, or toward its
  goal — and the vehicle stands for 3.5 s; members first get clear of the hull, then gather there until 70 % are
  within 12 m, for at most 12 s, then carry on with the squad's task;
- a member dropped further along than a distant leader waits for the leader (up to 40 s after the drop) instead
  of walking back.

### 4. Convoys

Measured: of the long departures, those that went alone were mostly "no other vehicle setting out within 20 s"
(173) or "others setting out were going elsewhere" (161). The second group included vehicles of the *same
operation* bound for firing positions 150–240 m apart, which the 150 m destination rule split.

Changes (`squad-convoy.ts`, hooks in `vehicle-orchestrator.ts`):
- journeys are compatible when the destinations are within 150 m (as before), *or* the vehicles share a task
  (the same operation, the same objective, or a trip home) with destinations within 240 m going the same way;
  being near each other is never enough;
- a partner on the same task that set out up to 45 s earlier and is still within 150 m of its start can still be
  paired; the convoy forms up where that vehicle is (bounded by the existing 40 s assembly limit, so no indefinite
  waits and nothing parks in the base lanes);
- at the end of the journey a follower bound for a nearby position of the same job branches off to it (counted as
  arrived); earlier, before the head is within 150 m of the destination, it stays in the column.

### Transport regression found and fixed during this pass

The first measurement after these changes showed squad transport trips down from 189 to 145 (10 seeds). Two
causes, both fixed:

- the boarding wait was a fixed 15 s while squads are picked up from up to 90 m (≈ 26 s on foot), so carriers
  timed out part-loaded and the new no-split rule then cancelled the ride. The wait now covers the furthest
  member's walk (15–45 s);
- the no-split rule counted squad members 90–100 m away that held no seat and were walking elsewhere, and it
  cancelled rides that carried the leader. It now counts only members holding a seat on that vehicle or already
  beside it, and a ride with the leader aboard goes (those on foot follow the leader to the same goal); only a ride
  of a few without the leader is cancelled.

After the fixes, trips are still about 11 % below the starting build (same seeds: 177 vs 199; delivered 141 vs 160).
The remaining difference is the deliberate one: a squad no longer squeezes part of itself into a carrier too small
for it.

### Results

Scenario tests (`tools/ai-tests.mjs`, 60 checks, plus browser scenarios):

| Scenario | Result |
|---|---|
| Soldier enters a building, climbs to an upper-floor post, comes back down and leaves (20 buildings: houses, apartments, shops, offices, HQs, garages, warehouses, hangars; both sides) | 20 / 20 up, 20 / 20 out; climbing takes 5–20 s, never above the level height (no clipping) |
| Same with a comrade standing on the stairs | 4 / 4 got up (squeezing past or after the comrade moved) |
| Building damaged while the soldier is upstairs / then ruined | level rebuilt and still usable (3 of 4; a flat roof that lost its roof slab is not); ruined: level gone, soldier on the ground |
| Squad stalled near a flag (unit) | approaching → final assault with the numbers / pinned when outnumbered → capturing inside the radius |
| Transported squad drops (unit) | rally point beside the vehicle toward the goal, or away from the threat; vehicle holds 3.5 s |
| Convoy journeys (unit) | same place / same job within 240 m pair; different jobs, opposite directions, 300 m apart do not |
| Browser: convoy forms and completes its journey | APC + truck formed at the gate, travelled 507 m together and arrived together |
| Browser: upper-floor post, one soldier per side | both reached the window post by the stairs (screenshots) |
| Browser: squad dropped by a truck | gathered beside it 7 s later (largest distance from the centroid 12 m) |

Full battles (10 seeds × 10 min, 100 v 100, starting build → this build, same seeds; the dismount and convoy rows
from a paired run of both builds on the same seeds):

| Metric | Before | After | Verdict |
|---|---|---|---|
| Defender time at upper-floor posts | 0.01 % | 12.8 % | confirmed (floor stats: 1,285 climbs, 72 abandoned routes, 2 soldiers stuck upstairs in 100 battle-minutes) |
| Defenders in a building / at cover / in the open | 15.9 / 37.8 / 46.3 % | 26.7 / 29.5 / 43.9 % | confirmed |
| Fighting near a flag with nobody inside the circle | 159 squad-min | 127–157 | inconclusive (varies with seeds) |
| Deadlock minutes (of 100) | 36 | 19–26 over three runs | improved |
| Captures (Pampalona / Torsa) | 83 / 65 | 85 / 72 | unchanged / slightly more |
| Flags held (Pampalona / Torsa) | 5.81 / 4.12 | 5.51 / 4.42 | slightly more even (no faction-specific change) |
| After a drop: largest separation, all members / riders only | 120 / 44 m | 83 / 35 m | confirmed |
| Riders regrouped within 15 m | 98 % in 2.9 s | 99 % in 2.3 s | unchanged (riders were rarely the problem; split rides were) |
| Members left > 40 m from their squad after a drop | 275 | 158 | confirmed |
| Drops with the vehicle moving into its passengers | 64 | 44 | confirmed |
| Drops with the whole squad aboard | 34 % | 42 % | improved |
| Squad transport trips / delivered | 199 / 160 | 177 / 141 | worse by ~11 % (see above) |
| Long departures that went in a convoy | 363 | 365–414 | inconclusive |
| Convoys departed / ≥150 m together / arrived together | 97 / 59 / 44 | 108–115 / 55–58 / 36–39 | departures up; arrivals together not improved (head vehicles re-targeting a nearby point end journeys early — an older behaviour, not changed here) |
| Late partners paired / same-job pairs / rejoined / joined en route | 0 / 0 / 4 / 9 | 3–13 / 6 / 7–9 / 15–25 | new formations happen, but few |
| CAS / fire missions / extractions / MLRS missions | 145 / 159 / 31 / 63 | 132–144 / 150–162 / 32–35 / 55–63 | within run-to-run spread |
| Stuck events per km | 1.78 | 1.57–2.05 | within spread |
| Actions reverted within 4 s | 24 % | 28–30 % | slightly worse (soldiers re-deciding around upper posts and the circle clamp); not yet traced |
| AI ms per frame / frame avg / p95 (headless) | 0.81 / 6.3 / 10.5 ms | 0.74–0.77 / 5.7–5.9 / 8.4–9.4 ms | not worse |
| Browser e2e (mobile viewport): checks / AI ms | 16 pass / 3.5 ms | 16 pass / 3.1 ms | not worse |

Limitations: only the first upper level is used (no routes to a third storey or onto a roof above it); window
glass renders opaque, so a soldier at an intact upper window is hard to see from outside; harbour buildings whose
stairs the ground grid cannot reach are left out (5 on the default map); the dismount metric also counts squads
getting out of static weapons (searchlights, HMG turrets).

## Milestone 0: uniform brain, purpose gate, 5.2 km² island, crews, air

### Stage 1 — one brain everywhere, the four-question purpose gate
- **No cognitive LOD.** Perception and tactics no longer depend on the camera (the old "abstract" tier cut cover
  seeking to 30 % and turned bounding into plain advancing far from the camera, so what a player watched was
  more hesitant than the battle elsewhere). Tactics run in ten round-robin buckets (~166 ms per soldier), the AI
  spatial grid uses 50 m cells. Visual LOD stays in the renderer: skeleton refresh every frame within 60 m,
  25 Hz to 200 m, 10 Hz beyond, fog-distance culling; soldiers were already GPU-instanced and frustum-culled.
- **`src/ai/purpose-gate.ts`** — `evaluatePurposeGate(ctx, candidate, out)`, zero allocation, asks *why /
  necessary / beneficial / what gain* for: a soldier stopping a move (1.5–2 s commitment, broken only by acute
  danger — a blast close by, point-blank fire; committed attackers answer distant fire on the move and stop only
  for real cover), a squad being re-tasked (locked inside the 180 m ring of the flag it is taking unless below
  25 % strength or retreating — used by the commander's operations, garrisons, reserves and the free squads'
  own objective changes), and a final assault.
- **Squad threat memory**: defenders seen in the last 6 s, a remembered peak that fades one per 10 s, and the
  commander's estimate × 0.8 as a floor — the count no longer drops to 0–2 the moment defenders duck. A squad
  with too few for a rush but enough to work forward (≥ 3, at least half the believed defenders) does
  **suppress-and-bound**: the covering fire team smokes the line and suppresses, the other bounds to closer cover.
- **Spacing**: persistent lateral corridors (−12…+12 m, 2–4 m stagger; ±1.8 m double file on streets), 3.5 m
  separation, and moves that would cross a firing squadmate's muzzle line step round behind it.

### Stage 2 — the 2280 m map
Layout positions spread ×1.7 east–west and ×1.25 north–south (the mainland moved 200 m north); every site,
building, street, road width and base stays 1:1. **MIKE**: a multi-storey town around a hall whose roof holds the
flag; capture volume roof −1.5…+4 m while the hall stands, ground level once it is rubble; attackers route up the
stairs, defenders take rooftop posts, air assaults fast-rope onto the roof (`src/world/flag-volume.js`).
**NOVEMBER**: an island 350 m offshore (docks, village, airstrip, helipad); navigation labels landmasses at load
(`mainland`, `island_november`) and refuses cross-water ground paths instantly; ground operations, vehicles,
garrisons and free squads stay on their landmass, the commander goes there by air with an LZ within 90 m. Offshore flags rank first in the air planner and are
judged against the base bar (nothing else can ever take them).
**OSCAR**: a ruined central outpost (breached bunkers, broken walls, craters).
`EnvironmentState` (`src/systems/environment-state.js`): seven times of day, five weathers, blended
transitions, optional day cycle (`?daycycle=N`), `visibilityRangeMeters` capping AI sight (aircraft too, radars
excepted), lit windows, flag beacons, brighter tracers at night.

### Stage 3 — crews and driving
`src/ai/vehicle-crew.js` crew blackboard: HOLD_STABLE (steady platform for a tank-gun / ATGM shot),
ANGLE_FRONT, HULL_DOWN_REVERSE (armour backs off while the gun cycles), SMOKE_AND_EXTRACT (heavy AT hit). Carriers
unload 60–100 m short of AT positions our side has seen. Driving: curvature lookahead over three corners, slow on
bridges and town streets, whisker-triggered reversing / three-point turns. Convoys: third and later vehicles keep
an elastic interval (damped gap control blended with the head's speed); two-vehicle behaviour unchanged.

### Stage 4 — air, fire support, AA
Radar-lock / missile warnings: flares plus a notch turn and a dive for masking. Gunships: 25 m transit, 15 m hide,
70 m pop-up, low fly-bys over contested flags, shallow-dive rocket passes on the lead point, a gimballed 30 mm.
Strike jets: 20–30° dives (CCIP bombs), lead + gravity drop for rockets / cannon, progressive take-off rotation.
Boresight air-to-air IR lock needs a 30° cone. Air insertions: no take-off until the manifest is aboard (or 12 s
after the first boarded); LZ marked (smoke by day, red flares at night / in fog); a hot LZ waves off once to a
secondary LZ inside the 180 m ring; at touchdown the squad gets a direct assault vector and an immediate capture
decision; no air assaults within 650 m of the enemy base (its SAMs). MLRS: 22 m warheads, extra structural damage,
craters, 85 m friendly buffer; batteries displace forward when the front is out of range (on the larger map they
otherwise never fired). AA aim (`src/ai/aa-aim.js`): lagged lead, walk-on dispersion, acquisition delay, limited
shoulder slew — weapon stats unchanged.

### Verification (headless, 100 v 100, 10-minute battles)
| Check | Result |
|---|---|
| Camera parity | No AI code reads the camera. Same seed, camera parked at three places: action sums 92 372 / 93 237 / 93 083, within the spread of two identical runs (93 083 vs 94 918). Interruptions of advances 1.07–1.09× near vs far when the camera follows attackers (seeds 1–2) |
| Frame budget (headless desktop) | simulation step median 7.3–7.6 ms, p95 12.4–13.8 ms; AI 0.8–1.1 ms |
| Assault entry | 29–58 % of capture attempts reaching 180 m enter the volume (seed-dependent); suppress-and-bound used 0–5 times per battle |
| Air insertions | touchdown 151–153 m from the flag, squads reached 9 m and captured (2 of 3 seeds); 1 Mi-8 lost after a wave-off |
| MIKE / NOVEMBER | rooftop: only soldiers on the roof count (3 of 3 on roof, 0 of 3 below); after collapse ground counts; NOVEMBER unreachable on foot (path refused, separate landmass) |
| Environment | all 7 times × 5 weathers cycled live; visibility 191–900 m |
| Convoys of 3+ | 3–7 formed, 4–10 departed, 2–8 arrived together per battle |
| Crews / air / fire | hold-stable 14–62, hull-down 5–50, angle-front 19–78, smoke-and-extract 0–2, notches 23–51, fly-bys 19–64, craters 7–12 |
| Tests | 60 unit, smoke, transport (fixture records from placement), occupants, 16/16 e2e (mobile viewport) |

NOVEMBER air assault (seed 4, natural battle): opened at 19 s, touchdown 46 m from the flag at 115 s, squad entered
the circle and captured it at ~125 s.

Limitations: the island is only attacked by Torsa (Pampalona's roster has no transport helicopter); craters reshape the walking terrain and the rendered mesh but not
the vehicle physics heightfield; frame times were measured headless, not on a Galaxy S25.

## Milestone 1: playtest fixes and the Torsa expansion

**Playtest fixes.** Native resolution (device pixel ratio up to 2×, the governor never sheds below 1×), MSAA on the
medium tier, clear-weather fog starting ≥ 460 m. `EnvironmentState` runs a live day (~18 min) and Markov weather
(menu: LIVE, or pin a value). Window and flag-beacon lights were lifted by the ground height twice; beacons now sit
on the pole top and follow MIKE's pole down when its building falls. Every ground hull has recessed headlight
housings, lenses and beam cones on its interpolated transform (on at dusk / night / storm / fog). Driving: damped,
slew-limited steering, speed-scaled turn braking; the convoy head eases off continuously as the tail lags. Flight:
PD attitude loops on smoothed setpoints (coordinated turns, stall guard, earlier ridge pull-up) for jets, an
acceleration-limited velocity loop and smoothed altitude hold for helicopters. `REBOARD_TRANSPORT` is a purpose-gate
candidate (next objective > 250 m, not pinned, intact carrier with room within 120 m, drivable route). The commander
tasks batteries on its own against observed garrisons and armour clusters (confidence ≥ 0.55, no friendlies
within 85 m); battery cooldowns are shorter; the op threshold allows two or three concurrent pushes; consolidation
and recovery are faster; soldiers without an objective respawn at the frontline flag.

**Torsa vehicles.** Nineteen procedural models built from blueprint references (`src/entities/models/torsa-expansion.js`,
on the shared kit: side / top profiles, lofted fuselages, mirrored parts, rigged turrets, launchers, erectors, rotors
and gear). Roles reuse the AI archetypes: Kurganets-25 IFV, AT-CST KamAZ-44108 (Kornet ATGM mount), CST KamAZ-63501
8×8 (Kord HMG), OST armoured 6×6 (no weapon, armoured cargo box, 24 crate loads), UAZ-469 jeep, Tigr-M (APC
profile), BRDM-2 (amphibious recon, lasing), IMR-2 combat engineer (repairs vehicles within 16 m while halted),
BM-21 Grad and BM-30 Smerch (MLRS), Iskander-type MZKT TEL (strategic missile), 96L6E radar (SAM sensor profile),
Mi-17 gunship (rocket pods, ATGM rails, door gun, cabin seats), Mi-2 recon and Mi-26 heavy transport helicopters,
Yak-130 light attack, Il-112V light transport, Su-27 and MiG-31 fighters. The BMP-2 is the amphibious IFV.

**Glazed cabs, cockpits and interiors.** Trucks and cars are built on a cab kit (`models/cabs.js`, `models/trucks.js`):
hollow cabs with real window openings and transparent glass, hinged doors carrying their own panes, and an interior
fitted to the def's seats (seats, dashboard with dials and console, steering column, pedals, gear lever, door cards,
roof liner). Cab families: KamAZ Mustang (transport, CST, AT-CST, Pantsir), MZKT-7930 (96L6E, Uragan, Iskander),
Ural-4320 bonnet cab (Grad), MAZ-543 twin cabs (Smerch), armoured cabs (OST, Tigr, IMR-2M), UAZ-469 soft top.
Aircraft (`models/cockpits.js`) have their fuselage opened under a transparent canopy (`cutFuselage`) with ejection
seats, MFD panels, HUD and consoles (jets) or two-pilot flight decks (helicopters, Il-112V). The interior, door
panes and crew show from outside within 35 m (glazing within 70 m); the wheel / stick are animated controls.

**Light transport aircraft (Il-112V).** Archetype `TRANSPORT_PLANE`; driven by `ctlTransportPlane` with no scripted
routes — the jobs come from the same sources as other vehicles:
- *Paratroop lift*: the commander's deep-insertion branch books it when no helicopter is free, the target is
  offshore or > 1 km away (`planeMethod`: air-land if a usable strip lies within 450 m of the objective and no
  contacts, otherwise paradrop). A parked UAZ within 250 m is loaded as cargo for paradrops.
- *Run-in*: a point 900 m short of the drop zone on the line from where the aircraft is (clamped to the map), then
  along it at 190 m (troops) / 140 m (supplies); the vehicle goes first on a chute (held while over roofs), then the
  jumpers every 0.35 s.
- *Air-landed lift*: lands on the strip (own runway or a neutral strip whose nearest flag we hold), taxis to the
  middle, unloads, takes off again.
- *Supply airdrop*: idle, it claims ammunition requests that are > 650 m away and unanswered for 20 s; a pallet
  falls on a chute and resupplies soldiers within 12 m for 240 s.
- *Return*: home runway (or a long friendly strip when home is far), traffic pattern — downwind leg 560 m abeam on
  the side with room, base turn by proportional centreline intercept, final on a damped localizer, 3.5° glide to a
  touchdown zone, staged flare, wings held level near the ground; go-around when off the centreline or high close
  in. Roll-out on the brakes, taxi along the centreline to abeam the stand (pivoting on the gear to turn round),
  then to the stand.
Flight model: `fl.assisted` (stick = bank and flight-path angle, coordinated turns, lift balances weight, speed from
thrust, drag and climb), engaged above 4 m and kept to 0.5 m on landing.

Limitations: AI route planning does not use the amphibious hulls' swimming (they float and swim when driven in);
the radar operates under the SAM sensor profile (no counter-battery logic); an airdropped vehicle is left for
whoever claims it (it is not auto-crewed by the jumpers) and is recovered to its pad after 240 s unused;
Pampalona has no counterparts yet by design.
