// Single source of feature flags + quality knobs for the renderer.
// Toggle a system off here to isolate regressions or hit a perf budget.
export const RENDER_CONFIG = {
  // Tier 0 (foundation) — on by default
  hdriEnv: true,
  groundedSky: false, // off with a puresky HDRI (it has no ground detail to project — was a white band)
  aerialFog: true,
  // Tier 0 tunables (rebalanced empirically in Task 7)
  // Sun-dominant daylight (2026-11): the sky dome was the main light (env 1.0 vs sun
  // 2.0), which flattened the course into soft, shadowless haze and turned every
  // undulation into a blotch. A real clear day is lit by the sun: crisp tree shadows,
  // bright even turf. Sky stays as fill.
  toneMappingExposure: 0.7,
  environmentIntensity: 0.4,
  sunIntensity: 5.0,
  fogDensity: 0.00042, // aerial-perspective fog (atmosphere.js curve: linear + quadratic) to the HDRI horizon; each time-of-day preset sets its own (sky-presets.js)
  groundApron: true,   // countryside ring past the course edge + horizon haze band (horizon.js)
  // Google Photorealistic 3D Tiles around the course (google-tiles.js). Only ever loads when
  // the server has the user's GOOGLE_MAPS_API_KEY; false = never, even with a key. While they
  // show, the apron + haze band above hide.
  googleTiles: true,
  googleTilesErrorTarget: 20,  // screen-space error (px) to refine to — Google's recommended 20; Low graphics x1.5
  googleTilesCacheMB: 320,     // loaded-tile memory budget (LRU); Low graphics halves it
  googleTilesClipEdgeM: 6,     // dithered seam width just inside the course rectangle, where our terrain takes over
  googleTilesGain: 1.5,        // lift for the unlit photogrammetry under ACES at exposure 0.7 (untuned: no key to test with)
  skyboxHeight: 30, // GroundedSkybox projection height (world meters); tuned in Task 7
  // Sun direction: null = auto-estimate from the HDRI's brightest texel.
  // Set BOTH (degrees) to override when the estimate is wrong on a diffuse HDRI (D2).
  sunAzimuthDeg: null,
  sunAltitudeDeg: 36, // either axis can be set alone; 36 deg gives long, readable tree shadows
  hdriFile: 'puresky_4k.hdr',
  // Material-first ground (2026-07-04 plan): the aerial TINTS the lit turf instead of
  // replacing it; the raw photo only crossfades in at TRUE far range. Weights are the
  // mix factors for each layer (0 = pure procedural turf, 1 = full effect).
  courseAerialTintClose: 0.85, // low-freq photo tint weight near the camera
  courseAerialTintFar: 0.92,   // ... at far range
  courseAerialPhotoFar: 0.62,  // RAW photo weight at TRUE far range. Was 0.88 = a flat "satellite
                               // photo" overview (it drowned the lit HD relief). Task-0 diagnostic
                               // proved the far-photo WEIGHT is the dominant overview-realism lever
                               // (terrain cast-shadows added ~nothing); 0.62 lets the diffuse-lit dune
                               // relief read as 3D while keeping enough real albedo. Keeps the shipped
                               // overview look near-intact (diff-gated); tint owns mid-range
  macroTintMPerPx: 2.5,        // tint copy resolution: fixed metres/px (course-size-independent), px cap 1024.
                               // Sharper than the eye-of-address material band needs, but it fills the
                               // 20-80m ball-flight band with real low-freq ground structure (fairway/dune
                               // shapes) instead of watercolour mush. Luma-lean tint keeps ghosts out.
  macroTintBlurPx: 2,          // canvas blur applied when downsampling the tint copy
  // Tier 1
  foliageTrees: true, // trees on (trees3d picks the renderer)
  trees3d: true,      // instanced 3D trees, near/mid/far LODs, woods filled (trees.js); false = legacy cards (tree-cards.js)
  treeDensity: 1.0,   // woods fill density (quality.js scales it; 1 = ~7.5 m pitch)
  treeNearM: 200,     // full leaf-card LOD inside this camera distance (quality.js scales it)
  grounding: true,    // contact-shadow decal blobs under trees (see grounding.js)
  pineStraw: true,    // warm pine-straw litter mat under on-course trees (see vegetation.js)
  flowers: true,      // azalea-style flowering bushes clustered at the tree lines
  flowerCap: 2000,    // max instanced flower bushes (perf)
  props: true,        // course props — bunker rakes (see props.js)
  windStrength: 0.5,  // canopy sway amount
  treeScale: 1.0,     // base scale on the 12m reference card-tree (~12m trees)
  treeCap: 9000,     // max instanced trees (quality.js sets it); explicit + woods-edge trees prioritized
  horizonTrees: true, // jittered tree band around the course perimeter (distant tree-line)
  buildings: true,    // extrude OSM building footprints (clubhouse + structures) — see scene.js _addBuildings
  // Later tiers / stretch — off until their tier lands
  pbrTurf: false,
  crispBunkers: true, // bunkers as their own crisp polygon meshes (sharp sand edges, real sand PBR)
  groundGrass: true,
  grassCap: 55000,  // max fescue tufts on the rough (× blades-per-tuft; perf)
  grassHeight: 0.85, // base blade height (m), jittered per instance
  // Foreground grass-OBJECT layer: a camera-anchored patch of SHORT, dense, per-instance
  // zone-tinted blades on the mown corridor (fairway/tee/base — NOT greens, NOT the rough
  // which has its own fescue). The vertex shader collapses blades past the fade radius, so a
  // patch placed around the address point reads as real foreground grass at the orbit camera
  // without re-triggering the sub-pixel smear in the mid/far field (reality-tested out there).
  grassField: true, // real blades around the camera on every mown + rough surface (grass-field.js); replaces the ball patch below
  foregroundGrass: true,
  foregroundGrassRadius: 18,    // m — patch radius around the ball/address point (tight = dense)
  foregroundGrassCap: 24000,    // spot clumps (× ~4 blades); the fade culls everything far
  foregroundGrassHeight: 0.08,  // m — short fairway-cut blade (exaggerated to read at distance)
  foregroundGrassFadeNear: 12,  // m from camera: full size nearer than this
  foregroundGrassFadeFar: 22,   // m from camera: collapsed to nothing past this
  terrainShadeSmoothM: 2.5, // shade the terrain from heights smoothed this much (m); 0 = raw lidar normals (noisy blotches on mown turf)
  mowStripeM: 4.5, // fairway mow-band width (m): a fairway triplex cuts ~2.5-3 m passes, read as ~4-5 m light/dark bands
  turfClean: 1.0, // 0..1: clean manicured parkland turf (less stacked noise/straw/near photo tint); links scale it out via courseDry
  gtao: true, // contact AO (grounding). If the turf goes black, GTAO's normal pass recompiled the onBeforeCompile shader without vMapUv — fall back to SSAO via a material-override prepass.
  colorGrade: true, // cinematic grade + vignette pass (after OutputPass)
  water: true, // animated water: analytic ripples + fresnel + sun glitter (else static plane)
  waterFoam: true, // shoreline foam via a depth pre-pass (wet line where water meets terrain)
  waterReflect: true, // per-pond planar reflection (trees/banks mirror in the water; frustum-culled)
  dof: false,
  volumetricClouds: false,
};
