# Golf Sim Visual Benchmark

What today's leading golf games and simulators do to look real, and how to measure a build against them. Read this when planning a visual feature for a golf sim, scoring a build, or deciding what to fix next.

## Contents

1. What each leader does
2. The shared recipe
3. Parity checklist
4. Three-way comparison workflow
5. Diagnostic checks
6. Performance targets
7. CG tells, most common first
8. Sources

## 1. What each leader does

| Product | Engine / stack | What sells the look |
|---|---|---|
| **EA Sports PGA Tour** | Frostbite | Custom low, slow helicopter LiDAR plus photogrammetry, drones and survey GPS. Point clouds become heightfield maps and surface masks. A GPU layer-compositing system drives material choice, terrain shape, object blending and scattering, non-destructively. Noise layers add wet sand and dry grass. Three tee times across four biomes vary light, contrast, clouds and haze. Reviewers single out distinct-feeling courses, a sun that sets across the round, crashing waves and Augusta's botanical detail. Weak spot: 30 fps on console. |
| **PGA Tour 2K25** | HB Studios, current-gen only | Courses rescanned at higher resolution and a large resolution jump (4K at 30 fps quality, about 1440p to 1620p at 60 fps performance on PS5 and Series X). A course designer with new surfaces, items and cameras. Reviewers knocked its static water textures and crowds. |
| **TrackMan Virtual Golf 3** | New graphics engine (unnamed) | Time of day changeable mid-round, featured sunsets, dynamic weather with evolving clouds, adjustable fog and cloud levels, moving seas. Green grid, aim guides, heatmaps and contour lines as overlays. |
| **Foresight FSX Play** | Unity | DLSS upscaling, a time-of-day system with night play, rain and fog. RTX 3060 minimum; 3070 Ti and up recommended. |
| **GSPro** | Unity, community OPCD courses | LiDAR courses built in Blender, Inkscape and Unity. The OPCD tutorial pipeline colours GPU grass from a satellite image blended with noise, carves terrain for water and uses planar reflections. The OPCD author's rule: the artist matters more than the engine. Volumetric clouds and shadows are the big frame costs; 3D grass is cheap. |
| **E6 APEX** | Next-gen TruGolf | Positioned as a big visual step over E6 Connect; RTX 3060 12 GB minimum. |

## 2. The shared recipe

1. Real-course capture (LiDAR, photogrammetry) to a heightfield plus surface masks.
2. Layered, mask-driven materials with noise variation.
3. Grass tinted by real imagery.
4. Time-of-day and weather presets that change sun, sky, shadows, haze and contrast together.
5. Animated, reflective water.
6. A distinct identity per course: palette, grass type, sand colour, tree species, backdrop.
7. A firm frame budget on mid-range RTX hardware, with upscaling.

## 3. Parity checklist

Score the build line by line. Every "no" is backlog, ordered roughly by visual payoff.

- [ ] Terrain from LiDAR at about 1 m where it exists. Coarse terrain reads as paint on paper, and no shader fixes it.
- [ ] Surface masks (green, fringe, fairway, first cut, rough, bunker, water, path, pine straw) driving layered materials, with noise layers for wet and dry, wear and colour drift.
- [ ] Grass tinted by real orthoimagery blended with noise, so each course carries its real colour patterns.
- [ ] Time-of-day presets: at least morning, midday and late afternoon, ideally sunset.
- [ ] Weather or biome presets: haze, cloud cover and contrast per climate (links, parkland, desert, coastal); fog and cloud level; optionally rain.
- [ ] Animated water with Fresnel, sky and bank reflections and shoreline wetness.
- [ ] Distinct course identity matching the real place.
- [ ] Botanical detail on hero holes: mixed species, flowering shrubs, pine straw, real tree placement.
- [ ] Backdrop to the horizon (real terrain or captured panorama) with haze matching the sky.
- [ ] Presentation overlays: green grid or contours, slope heatmap, aim guide, shot tracer, readable against trees and dark backgrounds.
- [ ] 60 fps at 1080p on an RTX 3060-class GPU, quality presets, an upscaling or dynamic-resolution path.
- [ ] Course authoring cameras and surface tools.

## 4. Three-way comparison workflow

1. Pick the viewing band: address (1.7 m eye height, ball at feet), flight (follow cam), landing (20 to 80 m), green (low, putting) or flyover (elevated). A fix for one band often breaks another.
2. Line up three images for that band: your frame, a benchmark game's frame from the same camera type (official screenshots or trailer stills), and a real photo of the course at a similar time of day.
3. Name the gap in one sentence, for example "their tree line 300 m out is lighter and bluer; ours is dark and saturated".
4. Fix it the way the benchmark does: data, a mask layer or lighting first, post-processing last.
5. Capture the same fixed cameras before and after through the full post chain. A visual fix without captured frames is not a fix.
6. Check frame time against the budget, then record changed knobs and asset licences.

## 5. Diagnostic checks

- **Value:** desaturate all three images. Black shadows or an over-bright sky fail first.
- **Hue:** CG turf skews kelly green and uniform; the benchmarks run olive to yellow-green, warm in sun, cool in shade, links tan-gold.
- **Frequency:** detail at macro (100 m colour patches), meso (mowing, slope shading) and micro (blades) scale.
- **Edges:** layered soft transitions: green, collar, first cut, rough; sand, lip, overhang.
- **Grounding:** contact shadows, AO and litter where objects meet ground.
- **Atmosphere:** distance lightens, desaturates and shifts toward the horizon sky colour.
- **Motion:** stripes, grass and leaf edges must not shimmer; LODs must not pop.

## 6. Performance targets

- Sim PCs: RTX 3060 is the common minimum (FSX Play, E6 APEX). Target 60 fps at 1080p there; higher presets for 3070 Ti and up.
- Consoles: 4K at 30 fps quality and about 1440p to 1620p at 60 fps performance is the current bar.
- GSPro testing shows volumetric clouds and shadows cost the most, while GPU grass is cheap.
- Instance repeated objects, LOD by distance, cast shadows from the near LOD only, run AO at reduced resolution, and gate expensive effects behind quality presets.

## 7. CG tells, most common first

1. Uniform, oversaturated green turf with no imagery-driven colour patches.
2. One fixed lighting setup; no time of day, no haze change.
3. Hard edges between surfaces.
4. Static or mirror-flat water.
5. Black shadows with no sky fill.
6. Visible tiling and repeated identical trees.
7. No aerial perspective; horizon slab or floating sky.
8. Generic course identity: wrong sand, grass or tree species for the place.
9. Shimmer and LOD pops in motion.
10. Post effects used to hide 1 to 9.

## 8. Sources

- EA: [courses overview](https://www.ea.com/news/ea-sports-pga-tour-courses-overview), [procedural terrain](https://www.ea.com/fr/news/procedural-terrain-in-ea-sports-pga-tour), [Frostbite at GDC 2023](https://www.ea.com/de/news/frostbite-presents-at-gdc-2023), [Push Square review](https://pushsquare.com/reviews/ps5/ea-sports-pga-tour)
- PGA Tour 2K25: [Shacknews review](https://www.shacknews.com/article/143226/pga-tour-2k25-review-score), [GamingBolt interview](https://gamingbolt.com/pga-tour-2k25-interview-post-launch-content-mycareer-mode-console-performance-and-more), [Player2 developer Q&A](https://www.player2.net.au/2025/02/pga-2k25-developer-qa/)
- TrackMan: [Virtual Golf 3](https://www.trackman.com/blog/golf/virtual-golf-3-and-tps-10), [support article](https://support.trackmangolf.com/hc/en-us/articles/29476947436059-VG-Virtual-Golf-3)
- Foresight: [FSX Play support](https://support.foresightsports.com/support/software/fsx-play)
- GSPro: [OPCD course creation](https://zerosandonesgcd.com/opcd-course-creation/), [performance tests](https://surfthing.com/blogs/gspro/gspro-v3-1-6-13-pc-performance-test-results)
- TruGolf: [E6 APEX](https://trugolf.com/pages/e6-apex), [E6 APEX review](https://www.carlofet.com/blog/trugolf-e6-apex-review)
