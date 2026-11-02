# Bundled CC0 Assets

All assets below are CC0 (public domain) unless noted. No attribution is legally
required for CC0; recorded here for provenance.

## HD compiler — external data sources (build-time, NOT bundled)

The HD hole compiler (`tools/hd-course/`, `npm run build:hd-hole`) fetches public open data
at build time and compiles it into local hole bundles under `data/hd-courses/` (git-ignored —
regenerable, too large for history). None of this data is committed to the repo.

- **OpenStreetMap course geometry** — © OpenStreetMap contributors, licensed **ODbL**. Cached
  under `data/courses/`; used for hole routing + surface polygons. Anything published from a
  bundle must credit "© OpenStreetMap contributors" and honor ODbL share-alike.
- **USDA NAIP aerial imagery** — **U.S. public domain**. Read by pinned, range-limited COG
  windows from the Microsoft Planetary Computer STAC catalog (never a full-object download).
  The build manifest pins item IDs, acquisition date, and asset ETags for reproducibility.
- **USGS 3DEP elevation** — **U.S. public domain**, from the 3DEP ImageServer. Native source
  resolution is recorded in each bundle's `provenance.json` (≈3.4 m 1/9 arc-second lidar at
  Bandon per Gate 1.5) and is never presented as native 1 m.
- **Generated hole bundles** — each `data/hd-courses/<course>/bundles/<id>/provenance.json`
  records source organizations, dataset/item identifiers, access date, licenses, and the
  compiler tool versions used. Bundles are immutable and git-ignored.

## HDRIs
- `public/assets/hdri/puresky_4k.hdr` — "Kloofendal 48d Partly Cloudy (Pure Sky)" by
  Poly Haven (CC0). Source: https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky
  Environment map (image-based lighting) + sky background (Tier 0). A pure-sky HDRI so
  the backdrop reads as real sky, not a photographed tree-line; GroundedSkybox is
  disabled with it (it has no ground detail to project).

### Time-of-day skies (fetched on first use, not bundled)
- **Morning** — "Rustig Koppie (Pure Sky)" by Poly Haven (CC0).
  https://polyhaven.com/a/rustig_koppie_puresky
- **Golden hour** — "Kloppenheim 06 (Pure Sky)" by Poly Haven (CC0).
  https://polyhaven.com/a/kloppenheim_06_puresky
- Both are loaded from Poly Haven's CDN (4K .hdr, ~15-17 MB each) the first time the Sky button
  picks them (`public/render/sky-presets.js`); Midday is the bundled sky above and the fallback when
  a download fails.

## Trees (Tier 1)
- `public/assets/trees/foliage_diff.jpg`, `foliage_alpha.jpg`, `bark_diff.jpg` — from
  "Fir Tree 01" by Poly Haven (CC0). Source: https://polyhaven.com/a/fir_tree_01
  The original is a ~7M-triangle film model whose foliage is millions of geometric
  needles — decimating that to an instanceable budget collapses the needles into bare
  sticks. Instead we reuse the model's **needle-sprig atlas** (`twig_diff` color +
  `twig_alpha` cutout) and **bark** (`bark_diff`) on procedurally-built foliage cards:
  a tapered bark trunk + a conical canopy of cross-fan cards (`public/render/tree-cards.js`).
  Lush and cheap to instance (~800 tris/tree vs ~80k for the decimated model).
- `public/assets/trees/broadleaf_{diff,alpha,bark}.jpg` — from "Jacaranda Tree" by Poly
  Haven (CC0). Source: https://polyhaven.com/a/jacaranda_tree
  Its `leaves_diff`/`leaves_alpha` is a true leaf-CLUSTER atlas (3 bipinnate fronds) and
  `branches_diff` is the bark. Used the same card technique for a feathery deciduous
  canopy (rounded), mixed ~30% into the conifer stand for an Augusta-style mixed tree line.

## 3D trees v2 (2026-11 photoreal pass)
- `public/assets/trees/leaves_{diff,alpha}.jpg` — the scanned single-leaf atlas of
  "Island Tree 01" by Poly Haven (CC0). Source: https://polyhaven.com/a/island_tree_01
- `public/assets/trees/oak_bark.jpg` — that model's `branches_diff`, downsized to 512 px.
- `public/assets/trees/pine_twig_{diff,alpha}.jpg` — the two needle sprays of "Pine Tree
  01" by Poly Haven (CC0), cropped onto one 512 px sheet. Source:
  https://polyhaven.com/a/pine_tree_01
- `public/assets/trees/pine_bark.jpg` — that model's `bark_diff`, downsized to 512 px.
- `public/render/leaf-atlas.js` composes these (plus the fir sprigs above) into the
  runtime leaf-cluster / sprig atlas; the branch skeletons are generated in code
  (`public/render/tree-gen.js`). Birch bark is drawn on a canvas.

## 3D trees (2026-11 graphics upgrade) — no new files
- The instanced 3D trees (`public/render/trees.js`) draw their leaf-cluster and
  needle-spray atlases **procedurally on a canvas at load** (no downloaded imagery),
  with coverage-preserving alpha mipmaps (`public/render/alpha-mips.js`). Trunks reuse
  the CC0 `public/assets/trees/bark_diff.jpg` above. The Poly Haven foliage atlases stay
  for the legacy card-tree renderer (`RENDER_CONFIG.trees3d = false`).
- Flag, pole, tee-marker and tracer textures are also canvas-generated at runtime.

## Turf textures (Tier 2)
- `public/assets/turf/grass_{color,normal,rough}.jpg` — "Grass 004" by ambientCG (CC0).
  Source: https://ambientcg.com/view?id=Grass004
  Tiled PBR grass: albedo blade detail, normal, and roughness, blended under the painted
  surface splat and modulated by shader mowing stripes (`public/render/turf.js`).
- `public/assets/turf/sand_{color,normal,rough}.jpg` — "Coast Sand 02" by Poly Haven (CC0).
  Source: https://polyhaven.com/a/coast_sand_02
  Tiled bunker sand, brightened in-shader and mixed in on the bunker mask.
