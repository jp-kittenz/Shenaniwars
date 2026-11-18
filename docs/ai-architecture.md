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
