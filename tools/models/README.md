# Imported vehicle models

Pipeline that turns the HD source models (USDZ) into the low-poly rigged parts in
`src/entities/models/torsa-models.bin`, loaded by `src/entities/models/imported.js`.

Requirements: `pip install usd-core numpy scipy pillow matplotlib trimesh embreex fast-simplification scikit-image`.

1. `extract.py <in.usdz> raw/<name>.npz` — world-space triangles, mesh / material names and a base colour
   (and alpha) sampled from each face's texture.
2. `normalize.py <dir> [keys…]` — per `cfg.py`: forward axis to +Z (+X left, y = 0 on the ground), scaled to the
   vehicle's real length, stray geometry dropped.
3. `rig.py [keys…]` — per model: wheels (from the tyres around the given axle stations), turret / launcher /
   erector / gun, radar, main and tail rotor, landing gear; hidden faces removed by ray visibility from 42
   directions (winding made consistent at the same time); each part quadric-decimated as one welded surface to
   its share of a 1.5–4.5 k triangle budget; paint classes (camo paint, dark metal, rubber, glass), baked AO and
   panel shading per vertex; parts stored relative to their pivots; everything packed into `torsa-models.bin`.
4. `rig.py v2 [keys…]` (current build) — instead of decimating the source soup directly, every part is rebuilt as a
   watertight solid: its surface is voxelised (4 cm for ground vehicles, 6.5–9 cm for aircraft), small gaps closed,
   the inside filled, cabs filled slice by slice to their convex cross-section, thin underbody clutter removed,
   then re-surfaced (marching cubes), smoothed and quadric-decimated. Paint class and shading come from the nearest
   visible source face; dark texture areas stay only on small detail faces. Wheels, gun barrels, the Smerch tube
   bank, rotor blades, tail rotors, the chin gun and landing gear are procedural in `imported.js`, sized from the
   measurements stored with each model.
5. `nview.py` / `preview.py` / `preview2.py` + `shaded.py` — check renders (normalised, part highlights, shaded 3/4 views).

Source → slot: Kurganets-25 → `ifv2`, Kamaz-4310 → `atcst`, UAZ-469 → `uaz`, GAZ Tigr → `tigr`, BRDM-2 → `brdm`,
BM-21 → `grad`, BM-30 → `smerch`, 96L6E → `radar`, Iskander-M → `tel`, Mi-24 → `gunship`, Mi-17 → `utilheli`,
Mi-2 → `reconheli`, Mi-26 → `heavyheli`, Yak-130 → `lightattack`, Su-35 → `fighter2`, MiG-31 → `fighter3`.
The engineer vehicle (`cev`, from the BMR-3M reference drawing) and the Il-112V transport (`transportplane`, from
its general-arrangement drawing) have no source model and are built procedurally in `imported.js`.
