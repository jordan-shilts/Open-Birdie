---
name: golf-sim-graphics
description: "Make a golf simulator or golf game look photoreal, benchmarked on EA Sports PGA Tour, PGA Tour 2K25, TrackMan, Foresight FSX Play and GSPro. Covers terrain and turf shaders, greens, bunkers, water, foliage, time-of-day lighting and haze, post-processing, performance budgets, CC0 assets and reference-photo comparison, with full three.js r186 lighting, materials, textures, post-processing and performance references bundled. Use it for any golf sim, golf course rendering, outdoor landscape realism or three.js visual-quality work, even when the request is only 'make it look better' or 'more realistic'."
---

# Golf Sim Graphics

One skill for making a golf sim look as real as the games and simulators golfers already play. The golf method lives in this file. Complete three.js API references (from CloudAI-X/threejs-skills, MIT, targeting three.js r186) sit in `references/` for the code itself.

## Where to look

| Task | Read |
|---|---|
| Decide what to build next, score the build, compare against the leaders | Sections 1 to 3 here, then `references/golf-benchmark.md` |
| Sun, sky, HDRIs, shadows, time of day, haze | Section 4, then `references/threejs-lighting.md` |
| Turf, greens, bunkers, water, foliage materials and shaders | Section 5, then `references/threejs-materials.md` |
| Texture loading, colour spaces, KTX2, tiling, memory | Section 5, then `references/threejs-textures.md` |
| Tone mapping, grade, AO, bloom, anti-aliasing, overlays | Section 6, then `references/threejs-postprocessing.md` |
| Frame rate, draw calls, instancing, GPU memory | Section 7, then `references/threejs-performance.md` |
| Real footage and benchmark frames for each featured course | Section 9, then `references/visual-references.md` |
| A photo-like target image of your own frame (paintover), with free tools only | Section 12 |

Each reference ends with a Common Mistakes list of outdated three.js patterns; check it before writing code.

## 1. The benchmark

Today's bar is set by EA Sports PGA Tour (Frostbite), PGA Tour 2K25 (HB Studios), TrackMan Virtual Golf 3, Foresight FSX Play (Unity), GSPro (Unity, community OPCD courses) and E6 APEX. The full breakdown, with sources, is in `references/golf-benchmark.md`. What they share:

1. **Real-course capture.** EA flew low, slow helicopter LiDAR plus photogrammetry, drones and survey GPS, and turned the point clouds into heightfields and surface masks.
2. **Layered, mask-driven materials** with noise variation. EA composites material layers on the GPU and adds wet-sand and dry-grass noise; GSPro's OPCD pipeline tints GPU grass from a satellite image blended with noise.
3. **Time-of-day and weather presets.** EA: three tee times across four biomes varying light, contrast, clouds and haze. TrackMan: time of day changeable mid-round, adjustable fog and cloud levels. FSX Play: time of day, night play, rain and fog.
4. **Animated, reflective water.** Reviewers knocked PGA Tour 2K25's static water.
5. **Distinct course identity and botanical detail.** Reviewers praise EA's courses for feeling distinct, and Augusta's plants.
6. **Presentation overlays.** TrackMan ships a green grid, aim guides, heatmaps and contour lines.
7. **A firm budget.** RTX 3060 is the common sim minimum; consoles run 4K at 30 fps or about 1440p to 1620p at 60 fps.

## 2. Parity checklist

Score the build line by line; every "no" is backlog, ordered roughly by visual payoff.

- [ ] Terrain from LiDAR at about 1 m where it exists. Coarse terrain reads as paint on paper, and no shader fixes it.
- [ ] Surface masks (green, fringe, fairway, first cut, rough, bunker, water, path, pine straw) driving layered materials with wet, dry and wear noise.
- [ ] Turf tinted by real orthoimagery, so each course carries its real colour patterns.
- [ ] Time-of-day presets (morning, midday, late afternoon, sunset) moving sun, sky, exposure and haze together.
- [ ] Weather or biome presets: haze, cloud cover and contrast per climate; fog and cloud level.
- [ ] Animated water with Fresnel, reflections and wet banks.
- [ ] Course identity: palette, grass, sand colour, tree species and backdrop match the real place.
- [ ] Botanical detail on hero holes: mixed species, flowering shrubs, pine straw, real tree placement.
- [ ] Terrain or a captured panorama to the horizon, with haze matching the sky.
- [ ] Overlays: green grid or contours, slope heatmap, aim guide, shot tracer, readable on any background.
- [ ] 60 fps at 1080p on an RTX 3060-class GPU, with quality presets and dynamic resolution.

## 3. Workflow for every visual change

1. **Pick the viewing band:** address (1.7 m eye height, ball at feet), flight (follow cam), landing (20 to 80 m), green (low, putting) or flyover (elevated). A fix for one band often breaks another.
2. **Line up three images** for that band: your frame, a benchmark game's frame from the same camera type (official screenshots or trailer stills), and a real photo of the course at a similar time of day. Section 9 lists what to collect.
3. **Run the checks** and name the gap in one sentence ("their tree line 300 m out is lighter and bluer; ours is dark and saturated"):
   - **Value:** desaturate all three. Black shadows or an over-bright sky fail first.
   - **Hue:** CG turf skews kelly green and uniform; the benchmarks run olive to yellow-green, warm in sun, cool in shade, links tan-gold.
   - **Frequency:** detail at macro (100 m colour patches), meso (mowing, slope shading) and micro (blades) scale.
   - **Edges:** layered soft transitions: green, collar, first cut, rough; sand, lip, overhang.
   - **Grounding:** contact shadows, AO and litter where objects meet ground.
   - **Atmosphere:** distance lightens, desaturates and shifts toward the horizon sky colour.
   - **Motion:** no shimmering stripes, grass or leaf edges, no popping LODs.
4. **Fix it the way the benchmarks do:** data, a mask layer or lighting first, post-processing last.
5. **Capture the same fixed cameras before and after** through the full post chain. A visual fix without captured frames is not a fix.
6. **Check frame time** against section 7, then record changed knobs and asset licences.

## 4. Lighting: time-of-day presets

Benchmarked on current golf games and sims (details in `references/golf-benchmark.md`): EA Sports PGA Tour ships three tee times across four biomes that vary light, contrast, clouds and haze; TrackMan Virtual Golf 3 changes time of day mid-round with adjustable fog and cloud levels; FSX Play has a time-of-day system with night play, rain and fog. Lighting there is a preset that moves sun, sky, exposure and haze together, never a single fixed rig.

```javascript
import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

// Starting values only: tune each preset against a real photo of the course at that hour.
// sunAzDeg/sunAltDeg must match where the sun sits in that HDRI.
const TIME_OF_DAY = {
  morning: { hdri: "sky_morning_4k.hdr", sunAzDeg: 95, sunAltDeg: 14, sunColor: 0xffd9b0, sun: 2.0, exposure: 0.7, haze: 0x9fb4c8, hazeDensity: 0.0007 },
  midday: { hdri: "sky_midday_4k.hdr", sunAzDeg: 180, sunAltDeg: 58, sunColor: 0xfff4e6, sun: 3.0, exposure: 0.55, haze: 0xb9c8d6, hazeDensity: 0.0003 },
  afternoon: { hdri: "sky_afternoon_4k.hdr", sunAzDeg: 245, sunAltDeg: 28, sunColor: 0xffe8cc, sun: 2.6, exposure: 0.6, haze: 0xb3c0cc, hazeDensity: 0.0004 },
  sunset: { hdri: "sky_sunset_4k.hdr", sunAzDeg: 285, sunAltDeg: 6, sunColor: 0xffb878, sun: 1.6, exposure: 0.8, haze: 0xd9b89a, hazeDensity: 0.0006 },
};

const skies = new Map();
async function loadSky(file) {
  if (!skies.has(file)) {
    const hdr = await new HDRLoader().loadAsync(file);
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    skies.set(file, hdr);
  }
  return skies.get(file);
}

export async function applyTimeOfDay(name, { scene, renderer, sun }) {
  const p = TIME_OF_DAY[name];
  const sky = await loadSky(p.hdri);
  scene.environment = sky; // sky light fills the shadows
  scene.background = sky;

  // phi is measured from straight up, theta around Y from +Z toward +X
  sun.position
    .setFromSphericalCoords(500, THREE.MathUtils.degToRad(90 - p.sunAltDeg), THREE.MathUtils.degToRad(p.sunAzDeg))
    .add(sun.target.position); // keeps the direction when the target follows the current hole
  sun.color.set(p.sunColor);
  sun.intensity = p.sun;

  renderer.toneMappingExposure = p.exposure;
  scene.fog = new THREE.FogExp2(p.haze, p.hazeDensity); // aerial perspective
}
```

- **Use pure-sky HDRIs.** An HDRI with photographed ground or trees puts a fake horizon at infinite distance that slides behind your terrain. Pair a sky-only HDRI with real terrain, tree lines and haze running to the horizon. Poly Haven's pure-sky set is CC0.
- **Match the sun to the sky.** Read the sun position from the HDRI's brightest texels, or author it per preset. If you rotate the sky to fit the course orientation, rotate `scene.environmentRotation`, `scene.backgroundRotation` and the sun by the same angle.
- **Real sun, optional.** Computing sun azimuth and altitude from the course's latitude, longitude and the player's date and time, then picking the nearest sky preset, goes one step past the fixed tee times the big titles ship.
- **Shadows over a hole.** Fit the directional shadow camera to the current hole corridor (tee-to-green bounds plus a margin) each time the hole changes, use a 4096 map with a `normalBias` large enough for terrain, and let only the near tree LOD cast. On a three.js release that ships `SunLight`, its cascades replace the manual fit.
- **Sky fill, not ambient.** Drop AmbientLight and HemisphereLight from outdoor scenes; the environment fills shadows with directional blue sky light. If shadows go black, the environment is missing or `scene.environmentIntensity` is too low.
- **Haze from the horizon.** Set the fog colour from the sky just above the horizon (average a band of HDRI texels) and tune density per preset until tree lines a few hundred metres out read lighter and bluer, as in the reference photo.
- **Test golden hour and midday.** Sun altitudes around 5 to 15 degrees give long shadows that reveal terrain relief, which is why the benchmarks showcase sunsets. Altitudes around 50 to 70 degrees flatten the light and expose material errors.
- **Backlit foliage.** Looking toward the sun, leaves and fescue should glow; see Foliage cards in section 5.
- **Clouds.** Evolving or volumetric clouds are a selling point for TrackMan and FSX Play and one of GSPro's biggest frame costs. Start with cloudy HDRI presets and put volumetrics behind a quality setting.

## 5. Surfaces: turf, greens, bunkers, water, foliage

Benchmarked on current golf games and sims (details in `references/golf-benchmark.md`): EA Sports PGA Tour turns LiDAR point clouds into heightfields and surface masks, composites material layers on the GPU and adds noise layers for wet sand and dry grass; GSPro's OPCD pipeline tints GPU grass from a satellite image blended with noise. Reviewers praise courses that feel distinct and botanically detailed, and knocked PGA Tour 2K25 for static water.

### One terrain material, layered by masks

Bake a course-space mask texture (R fairway and tee, G green, B bunker; rough where all three are zero) and a blurred, low-frequency orthophoto. Each turf type keeps its own tiled colour set; the mask picks between them and the orthophoto adds the real course's colour patches. Extending MeshStandardMaterial keeps lighting, shadows, fog and the environment working:

```javascript
const turf = new THREE.MeshStandardMaterial({ roughness: 0.95 });
turf.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, {
    uMask: { value: maskTex }, // linear data, LinearFilter, feathered edges
    uOrtho: { value: orthoTex }, // sRGB, blurred to low frequency
    uOrthoMean: { value: new THREE.Vector3(0.18, 0.22, 0.12) }, // mean ortho colour over playable turf (linear)
    uFairway: { value: fairwayTex }, // sRGB colour maps, RepeatWrapping
    uGreen: { value: greenTex },
    uRough: { value: roughTex },
    uSand: { value: sandTex },
    uBounds: { value: new THREE.Vector4(minX, minZ, maxX - minX, maxZ - minZ) }, // course extent in world XZ
  });
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
      varying vec3 vWorldPos;
      uniform sampler2D uMask, uOrtho, uFairway, uGreen, uRough, uSand;
      uniform vec3 uOrthoMean;
      uniform vec4 uBounds;`,
    )
    .replace(
      "#include <map_fragment>",
      `vec2 courseUv = (vWorldPos.xz - uBounds.xy) / uBounds.zw;
      vec2 tileUv = vWorldPos.xz * 0.25; // one tile per 4 m
      vec4 m = texture(uMask, courseUv);
      vec3 col = texture(uRough, tileUv).rgb;
      col = mix(col, texture(uFairway, tileUv).rgb, m.r);
      col = mix(col, texture(uGreen, tileUv * 2.0).rgb, m.g);
      col = mix(col, texture(uSand, tileUv).rgb, m.b);
      vec3 tint = texture(uOrtho, courseUv).rgb / max(uOrthoMean, vec3(1e-3));
      col *= mix(vec3(1.0), tint, 0.6); // real colour drift from the course photo
      diffuseColor.rgb *= col;`,
    );
};
```

Under WebGPURenderer, build the same blend in `colorNode` with TSL (see WebGPU and TSL in `references/threejs-materials.md`).

- **Calibrate albedo.** Natural non-metal albedo sits roughly between 30 to 50 sRGB at the darkest and about 240 at the brightest. Turf is mid-dark olive to yellow-green, links fescue tan-gold, bunker sand grey-tan to cream and rarely white. Fix lighting with light, not by brightening albedo.
- **Roughness.** Turf about 0.85 to 1.0, greens slightly lower for a tighter sheen, sand about 0.9 to 1.0, water a separate material near 0.05.
- **Soft, layered edges.** Real courses step from green to collar to first cut to rough, and from sand to lip to grass overhang. Feather masks when baking, sample them with linear filtering, and add a collar band around greens instead of one hard boundary.
- **Mow stripes are sheen, not paint.** Alternate bands across the mow direction and scale their contrast by how closely the view direction runs along the mow direction (`abs(dot(normalize(cameraPosition.xz - vWorldPos.xz), mowDir))`), then fade them with `1.0 - smoothstep(150.0, 300.0, distance(cameraPosition, vWorldPos))` so they never moire at range.
- **Break tiling.** Blend two tile scales, multiply by large-scale noise and the orthophoto tint, and consider stochastic or hex tiling on the most visible surfaces.
- **Bunkers.** Dish-shaped light and shadow comes from real geometry, so sculpt depth rather than painting it. Add a thin grass-overhang band at the lip and noise-driven damp sand (darker, a little smoother) toward the base, as EA does with its wet-sand layers.
- **Water.** Scroll two normal maps against each other, use Fresnel-weighted sky and bank reflections (a Reflector for small ponds, the environment for large water), and darken the banks through the mask. Static water is the flaw reviewers notice.
- **Foliage cards.** `alphaTest` alone leaves crawling, aliased leaf edges; add `alphaToCoverage: true`, which needs a multisampled target (see section 6 and Composer Setup in `references/threejs-postprocessing.md`). Give leaves and fescue a cheap translucency term so they glow when backlit.
- **Course identity.** Drive palette, grass type, stripe strength and sand colour from per-course uniforms, so a links course reads tan and firm and a parkland course lush and striped.

## 6. Post chain

Benchmarked on current golf games and sims (details in `references/golf-benchmark.md`). Their look comes from capture, materials and lighting; post-processing grounds and finishes it. A chain for a sunlit course under WebGLRenderer:

```javascript
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const w = window.innerWidth, h = window.innerHeight;
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 }), // MSAA for alpha-to-coverage foliage
);
composer.setSize(w, h);
composer.addPass(new RenderPass(scene, camera));

const gtao = new GTAOPass(scene, camera, w, h);
gtao.updateGtaoMaterial({ radius: 1.5, scale: 1.2, thickness: 1.0, samples: 12, screenSpaceRadius: false }); // metres: tree bases and bunker lips only
composer.addPass(gtao);

composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.06, 0.4, 1.6)); // threshold above sunlit turf: only water glints bloom
composer.addPass(new SMAAPass());
composer.addPass(new OutputPass()); // tone mapping and exposure from the active time-of-day preset
```

- **Tone mapping.** ACES gives a punchy broadcast look, AgX rolls highlights off more naturally, Neutral keeps colours most faithful. Pick one, then set `renderer.toneMappingExposure` per time-of-day preset so sunlit turf sits in the midtones and the sky does not clip.
- **Grade lightly.** A display-space grade goes after OutputPass as a custom pass (see Custom Passes in `references/threejs-postprocessing.md`): contrast about 1.05 to 1.1, saturation at most about 1.1, warm highlights and cool shadows, a faint vignette. Exposure and white balance belong before OutputPass. Pushing saturation to rescue flat turf hides a material problem; fix the albedo instead.
- **Bloom only on true highlights.** Sunlit greens sit near linear 1.0, so a default 0.85 threshold makes the turf glow. Keep the threshold above turf and sand and the strength low.
- **AO grounds, never haloes.** Use a small world-space radius so AO darkens contacts (trunks, bunker lips, buildings) without haloing kilometres of terrain against the sky. GTAOPass renders its depth and normal pre-pass with one override material that ignores alpha cutouts, so leaf cards and transparent overlays show up as grey card-shaped shards; hide cutout and transparent meshes during that pre-pass.
- **Anti-aliasing.** MSAA on the composer target enables alpha-to-coverage on foliage; SMAA cleans the remaining geometric edges. Shimmering mow stripes, grass and leaves are fixed at the source (mipmaps, distance fades), not with more AA.
- **Depth of field** belongs to flyovers, replays and menus. During play the golfer needs a sharp target.
- **Overlays stay readable.** Green grid, slope heatmap, aim line and shot tracer (the presentation layer TrackMan and others ship) should skip AO, bloom and grading: draw them after the composer or exclude them from those passes, and check them against dark tree lines, a readability complaint raised about EA's swing meter.
- **Budget.** The market bar is 60 fps at 1080p on an RTX 3060-class PC, and 4K at 30 fps or about 1440p to 1620p at 60 fps on consoles. Measure each pass, run AO at reduced resolution, lower `composer.setPixelRatio()` as dynamic resolution on weak GPUs, and expose `pass.enabled` through quality presets.

## 7. Performance budget

- **Targets from the market:** RTX 3060 is the common minimum for sim software (FSX Play, E6 APEX), so hit 60 fps at 1080p there and add higher presets for 3070 Ti and up. Consoles set 4K at 30 fps or about 1440p to 1620p at 60 fps.
- **Where it goes:** GSPro testing shows volumetric clouds and shadows cost the most, while GPU grass is cheap. Measure before you guess (`references/threejs-performance.md`, Measure First).
- **Standard moves:** instance every repeated object (trees, grass, flowers), LOD by distance, frustum-cull, cast shadows from the near LOD only, run AO at reduced resolution, compress textures (KTX2), and cap counts per quality preset.
- **Dynamic resolution:** lower `composer.setPixelRatio()` when frame time climbs; expose expensive passes through `pass.enabled` in Low, High and Auto presets.
- A visual win that blows the budget ships behind a preset or not at all.

## 8. Assets and licences

- **Public or MIT repos:** commit only CC0 or public-domain assets and log the source URL and licence in `ASSETS.md`. Good sources: Poly Haven and ambientCG (CC0 HDRIs, turf, sand, bark, tree scans), USGS 3DEP elevation and USDA NAIP imagery (public domain). Fab, Megascans and marketplace assets stay local. Game screenshots are comparison reference only, never textures.
- **Prep:** power-of-two sizes; check tiling by offsetting 50 percent; sRGB for colour maps, linear for normal, roughness and masks; OpenGL normal convention in three.js (green up; flip DirectX maps or set `normalScale.y = -1`); mipmaps and max anisotropy on ground textures; KTX2 for GPU memory (`references/threejs-textures.md`).
- **Sizing:** 2K is plenty for tiled turf detail; 4K pure-sky HDRIs suit lighting.

## 9. Reference photo kit

Collect a small, labelled set per course before tuning, and keep it beside the renders. `references/visual-references.md` links free real footage and benchmark-game galleries for every course in `courses/featured.json`, says which games carry each course, and explains how to get frames in front of the agent.

- **Per viewing band:** address view down the fairway, a mid-iron approach to the green, a low view across the green surface, a bunker from the lip, a tree line at 100 to 300 m, and an elevated or drone view of the hole.
- **Per condition:** morning, midday and golden hour, plus overcast if you ship it. Match the course's season and grass type (links fescue, bentgrass, bermuda).
- **Real courses worth having on file**, each teaching one thing:
  - Chambers Bay: tan-gold fescue, firm fairways, grey-tan waste sand, haze over water.
  - St Andrews Old Course from above: links colour at overview height, big shared greens, gorse, minimal stripes.
  - Pebble Beach 18: coastal water, waves on rock, cypress silhouettes, sea-haze backdrop.
  - Augusta National in bloom: botanical detail, flowering shrubs against mid-green turf, pine straw.
  - TPC Sawgrass 17: water reflections, a hard bulkhead edge against a soft green collar.
- **Surface close-ups:** fairway mow stripes from both directions, green collar and fringe, raked bunker sand, links fescue, morning mist over a fairway.
- **Benchmark frames:** official screenshots and trailers from EA Sports PGA Tour, PGA Tour 2K25, TrackMan Virtual Golf 3, FSX Play and GSPro, matched to the same camera types as your captures.

## 10. CG tells, most common first

1. Uniform, oversaturated green turf with no imagery-driven colour patches.
2. One fixed lighting setup; no time of day, no haze change.
3. Hard edges between surfaces.
4. Static or mirror-flat water.
5. Black shadows with no sky fill.
6. Visible tiling and repeated identical trees.
7. No aerial perspective; a horizon slab or floating sky.
8. Generic course identity: wrong sand, grass or tree species for the place.
9. Shimmer and LOD pops in motion.
10. Post effects used to hide 1 to 9.

## 11. Open-Birdie specifics

When working in the Open-Birdie repo (three.js r184, so a few r186 APIs in the references, such as `SunLight`, may be missing):

- Knobs live in `public/render/config.js` (`RENDER_CONFIG`). Sky, IBL and sun: `env.js`, with one HDRI today (`hdriFile`), so time-of-day presets are a gap. Post: `postfx.js` (GTAO, bloom, OutputPass with ACES, grade, SMAA). Turf: `turf.js`. Trees: `trees.js`. Atmosphere and horizon: `atmosphere.js`, `horizon.js`. Water: `water.js`. Quality presets: `quality.js`. `volumetricClouds` is off by default.
- Verify with the render loop in `docs/HANDOFF.md` section 6, capturing through the postfx composer.
- Never change `courseFingerprint` inputs (`CACHE_VERSION`, projection origin) for visual work.
- Keep `npm test` green on Node 22 or newer.
- Per-hole yardages, elevation, OB and green data for the featured courses live in `docs/research/course-data/`.

## 12. Paintover targets (free tools only)

A paintover is your own frame restyled into a photo-like target with the same camera and composition, so the gap between render and photo is easy to see. Studio concept artists paint them by hand; a free image-edit model can make a rough one.

- **Tool:** the Hugging Face connector (claude.ai → Settings → Connectors → Hugging Face), with a free Hugging Face account. Its image tools are Gradio Spaces on ZeroGPU: free accounts get about 5 minutes of shared GPU time a day and are never charged. Once connected at claude.ai, the connector also reaches Claude Code on the web.
- **Setup:** at huggingface.co/settings/mcp, add an image-edit Space that shows **Running** and uses an Apache-2.0 model (the Qwen-Image-Edit family works; find Spaces at huggingface.co/spaces?filter=mcp-server). Optionally add `evalstate/flux1_schnell` (FLUX.1-schnell, Apache 2.0) for from-scratch mood images. Leave "Remove Embedded Images" off so results come back into the session.
- **Workflow:**
  1. Capture a fixed frame through the full post chain (section 3, step 5).
  2. Edit it with an instruction that keeps the geometry: "Keep the exact camera, terrain, holes, trees and bunkers. Make it look like a real photograph of <course> at <time of day>: natural turf colour, real haze, soft shadows. Do not add, remove or move anything."
  3. Compare render, paintover and a real photo of the course with the section 3 checks. Trust the paintover only on light, colour and atmosphere, never on layout; discard any result that invents or moves features.
  4. Name the gap, fix it in the renderer, recapture.
- **Free-only rules:**
  - No paid plans, credit packs, PRO upgrades, Inference Endpoints or pay-as-you-go GPU time. When the daily quota runs out, wait for the reset.
  - Higgsfield's MCP needs a paid subscription and charges credits per generation, so it is not used.
  - Paintovers are references only: never textures, never shipped art, never committed to git.

## Credits

The three.js references in `references/threejs-*.md` are taken unmodified (apart from added contents lists) from CloudAI-X/threejs-skills, MIT License, Copyright (c) 2026 CloudAI-X; the full licence is in `LICENSE`. The golf benchmark sources are listed in `references/golf-benchmark.md`.
