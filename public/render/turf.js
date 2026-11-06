// Terrain turf material. Keeps the painted splat (per-surface zones) as the base
// color, overlays a tiled CC0 PBR grass set (real normal + roughness + blade-detail
// albedo), adds shader mowing stripes gated to a fairway/green mask, and swaps in
// bright CC0 sand on a bunker mask — all on the single terrain mesh.
import * as THREE from 'three';
import { ASSETS } from './assets.js';
import { RENDER_CONFIG } from './config.js';
import { DIVOT_GLSL } from './divots.js';

const loader = new THREE.TextureLoader();

// The fairway mow direction (sim x/y, unit): the line of the hole being played, set by
// scene.setHole. One uniform shared by every turf material (the base ground and the
// green patches), so the stripes on a fairway always run down the hole.
export const turfMowDir = { value: new THREE.Vector2(-0.57, 0.82) };

// Value-noise lattice for the turf shader (2026-11 perf pass): the shader evaluates
// ~65 noise samples a pixel (grain, patches, rolls, rough clumps, meso relief), and
// each procedural one cost four sin() hashes — the turf was ~10 ms of a 23 ms frame.
// A random lattice in a texture gives the same smoothstep value noise in ONE tap
// (tNoise below). No mipmaps or sRGB: the shader addresses exact texels.
const NOISE_N = 256;
let noiseTex = null;
function turfNoiseTexture() {
  if (noiseTex) return noiseTex;
  const data = new Uint8Array(NOISE_N * NOISE_N * 4);
  let h = 0x2545f491;
  for (let i = 0; i < data.length; i++) {        // xorshift32: fixed seed, same lattice every load
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    data[i] = (h >>> 0) & 255;
  }
  noiseTex = new THREE.DataTexture(data, NOISE_N, NOISE_N, THREE.RGBAFormat);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = noiseTex.minFilter = THREE.LinearFilter;
  noiseTex.generateMipmaps = false;
  noiseTex.needsUpdate = true;
  return noiseTex;
}
function tiled(url, srgb, repX, repY, aniso) {
  const t = loader.load(url);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repX, repY);
  t.anisotropy = aniso;
  return t;
}

// Dedicated sand material for crisp bunker meshes (Tier 1). A plain
// MeshStandardMaterial — no onBeforeCompile — so it stays GTAO-safe and cheap.
// Uses the full CC0 sand PBR set (color + normal + roughness), brightened toward
// bunker-white. polygonOffset so the bunker mesh wins over the base + green collar.
// aux (optional): the soft AUX surface mask (B = bunker, ~1.8 m blur) — darkens the
// steep sand face just inside the edge so bunkers read as dished hazards with a
// grass lip, not flat decals.
export function makeSandMaterial(bounds, aniso, aux = null, sunDir = null, courseDry = 1) {
  const extX = bounds.maxX - bounds.minX, extY = bounds.maxY - bounds.minY;
  const tileM = 2.0, repX = extX / tileM, repY = extY / tileM;
  const map = tiled(ASSETS.turf.sand, true, repX, repY, aniso);
  const normalMap = tiled(ASSETS.turf.sandNormal, false, repX, repY, aniso);
  const roughnessMap = tiled(ASSETS.turf.sandRough, false, repX, repY, aniso);
  const mat = new THREE.MeshStandardMaterial({
    map, normalMap, normalScale: new THREE.Vector2(1.0, 1.0),
    roughnessMap, roughness: 1.0, metalness: 0,
    envMapIntensity: 0.5,
    polygonOffset: true, polygonOffsetFactor: -1.2, polygonOffsetUnits: -1.2,
  });
  // muted greige native sand on links (real links/waste sand is a grey-tan crushed
  // material ~#b7a98b, NOT bright white — verified vs Chambers Bay photos), but bright
  // white silica on parkland courses (Hazeltine, Augusta) — blended by courseDry
  const dry = Math.min(1, Math.max(0, courseDry));
  mat.color = new THREE.Color(1.62, 1.60, 1.52).lerp(new THREE.Color(1.02, 0.97, 0.84), dry);
  mat.userData.disposeTextures = [map, normalMap, roughnessMap];
  if (aux) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uAux = { value: aux };
      shader.uniforms.uAuxExt = { value: new THREE.Vector2(extX, extY) };
      shader.uniforms.uSunDir3 = { value: sunDir || new THREE.Vector3(0.4, 0.8, -0.4) };
      shader.uniforms.uSandWhite = { value: 1 - dry };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vCourseUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvCourseUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uAux; uniform vec2 uAuxExt; uniform vec3 uSunDir3; uniform float uSandWhite;\nvarying vec2 vCourseUv;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          {
            // parkland silica sand is near-white: drain most of the tan texture hue
            float sL = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(sL) * vec3(1.03, 1.02, 0.97), 0.75 * uSandWhite);
            // 1 at the sand edge -> 0 about a metre in: the steep face under the lip.
            // DIRECTIONAL so the hazard reads as a dish, not a mound: the edge nearest
            // the sun is shadowed by its lip, the far face (tilted at the sun) is lit.
            float bIn = texture2D(uAux, vCourseUv).b;
            float face = 1.0 - smoothstep(0.55, 0.97, bIn);
            vec2 e = vec2(0.9) / uAuxExt;
            float gx = texture2D(uAux, vCourseUv + vec2(e.x, 0.0)).b - texture2D(uAux, vCourseUv - vec2(e.x, 0.0)).b;
            float gy = texture2D(uAux, vCourseUv + vec2(0.0, e.y)).b - texture2D(uAux, vCourseUv - vec2(0.0, e.y)).b;
            vec2 inward = normalize(vec2(gx, gy) + 1e-5);
            vec2 sunH = normalize(vec2(uSunDir3.x, -uSunDir3.z) + 1e-5);
            float facing = dot(inward, sunH);
            float shade = face * clamp(0.45 - 0.8 * facing, 0.12, 1.0);
            float lit = face * clamp(facing, 0.0, 1.0);
            diffuseColor.rgb *= mix(1.0, 0.58, shade);
            diffuseColor.rgb *= 1.0 + 0.20 * lit;
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.92, 0.95, 0.88), shade * 0.5);
            // THE HOLLOW, AS THE PLAYER SEES IT. Looking across a bunker, its near lip hides
            // the face under it and holds it in shadow (a dark crescent inside the near
            // edge); the far face rises toward the eye, full of light, under a thin line of
            // shadow from the grass lip overhanging it. Across the whole bowl the sand runs
            // from dim near to bright far: a blurred mip of the mask gives the bowl's inward
            // direction, so the cue still reads 150 m off, where the edge bands are a pixel.
            // Gone looking down from above, where nothing hides anything.
            vec3 toCamW = normalize((vec4(vViewPosition, 0.0) * viewMatrix).xyz);
            vec2 toCamH = normalize(vec2(toCamW.x, -toCamW.z) + 1e-5);
            float graze = 1.0 - smoothstep(0.3, 0.8, toCamW.y);
            float towardEye = dot(inward, toCamH);        // -1 under the near lip, +1 on the far face
            float hidden = (1.0 - smoothstep(0.5, 0.75, bIn)) * clamp(-towardEye, 0.0, 1.0);
            float rises = face * clamp(towardEye, 0.0, 1.0);
            float overhang = (1.0 - smoothstep(0.5, 0.6, bIn)) * clamp(towardEye, 0.0, 1.0);
            vec2 eW = vec2(6.0) / uAuxExt;
            float wgx = textureLod(uAux, vCourseUv + vec2(eW.x, 0.0), 3.5).b - textureLod(uAux, vCourseUv - vec2(eW.x, 0.0), 3.5).b;
            float wgy = textureLod(uAux, vCourseUv + vec2(0.0, eW.y), 3.5).b - textureLod(uAux, vCourseUv - vec2(0.0, eW.y), 3.5).b;
            float bowl = clamp(dot(vec2(wgx, wgy), toCamH) * 2.5, -1.0, 1.0);   // + far side, - near side
            diffuseColor.rgb *= (1.0 - 0.32 * hidden * graze) * (1.0 + 0.14 * rises * graze) * (1.0 - 0.3 * overhang * graze);
            diffuseColor.rgb *= 1.0 + (0.12 * max(bowl, 0.0) - 0.04 * max(-bowl, 0.0)) * graze;
          }`);
    };
    mat.customProgramCacheKey = () => 'sand-lip-v4';
  }
  return mat;
}

// bunkerMask doubles as the AUX surface mask since the 2026-11 material pass:
// R = tee, G = water, B = bunker, each softly blurred (~1.8 m) — tee cut, wet banks,
// bunker lips. (Its old single-channel bunker gate was superseded by the raw mask.)
// hq = false (Low graphics) skips the extra rough/first-cut taps.
// shore (optional, a coastal course): { tex, offset: [x, y], size: [w, h] }, the ground
// the sea meets (sea.js shoreGround) as a texture over the terrain grid; offset is the
// grid texture's corner from bounds' (m), size its extent.
export function makeTurfMaterial({ baseMap, mownMask, bunkerMask, bounds, anisotropy, macro = null, courseDry = 0, surfaceMaskRaw = null, pal = null, hq = true, sunDir = null, shore = null }) {
  const splatTex = baseMap, maskTex = mownMask, bunkerMaskTex = bunkerMask, aniso = anisotropy;
  // P2a: a RAW (unblurred) mask for the crisp fwidth edge. Falls back to the blurred
  // mask so the headless material test (no raw mask supplied) still builds.
  const maskRawTex = surfaceMaskRaw || mownMask;
  const extX = bounds.maxX - bounds.minX, extY = bounds.maxY - bounds.minY;
  const tileM = 2.0; // grass texture repeats ~every 2m
  const repX = extX / tileM, repY = extY / tileM;

  const normalMap = tiled(ASSETS.turf.normal, false, repX, repY, aniso);
  const detail = tiled(ASSETS.turf.color, true, repX, repY, aniso);
  const sand = tiled(ASSETS.turf.sand, true, repX, repY, aniso);
  maskTex.wrapS = maskTex.wrapT = THREE.ClampToEdgeWrapping;
  bunkerMaskTex.wrapS = bunkerMaskTex.wrapT = THREE.ClampToEdgeWrapping;
  maskRawTex.wrapS = maskRawTex.wrapT = THREE.ClampToEdgeWrapping;

  const mat = new THREE.MeshStandardMaterial({
    map: splatTex,
    normalMap, normalScale: new THREE.Vector2(0.8, 0.8),
    // no roughness map: the turf one (grass_rough.jpg, every texel under 0.9) only ever
    // fed the 0.9 floor below, and the shader is at WebGL's 16 texture units without it
    roughness: 0.9, metalness: 0,
    envMapIntensity: 0.2, // turf is matte — keep sky/sun reflection low so lit slopes don't blow out white
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: detail };
    shader.uniforms.uTurfNoise = { value: turfNoiseTexture() };
    shader.uniforms.uDetailRepeat = { value: new THREE.Vector2(repX, repY) };
    shader.uniforms.uMask = { value: maskTex };
    shader.uniforms.uBunker = { value: bunkerMaskTex };
    shader.uniforms.uSand = { value: sand };
    shader.uniforms.uExt = { value: new THREE.Vector2(extX, extY) };
    shader.uniforms.uStripeM = { value: RENDER_CONFIG.mowStripeM ?? 7.0 }; // mow-band width (m)
    shader.uniforms.uMowDir = turfMowDir;
    shader.uniforms.uCourseDry = { value: courseDry }; // P1b: 0 lush parkland .. 1 dry links
    // Clean manicured turf (2026-11): how far parkland turf drops the stacked noise,
    // straw patches, near photo tint and desaturation. Scaled by (1 - courseDry), so
    // links keep their tuned tan character. 0 = the previous look.
    shader.uniforms.uTurfClean = { value: (RENDER_CONFIG.turfClean ?? 1) * (1 - courseDry) };
    // P2a: crisp-edge inputs — the RAW mask + per-surface palette (linear). The shader
    // composites the surface BASE COLOUR per-fragment gated by a fwidth mask so the
    // green/tan boundary is a crisp ~1px mow line, not the soft splat/tint/collar sum.
    shader.uniforms.uMaskRaw = { value: maskRawTex };
    shader.uniforms.uSunDir3 = { value: sunDir || new THREE.Vector3(0.4, 0.8, -0.4) }; // live ref: follows the HDRI sun
    const PV = (a, d) => new THREE.Vector3(...(Array.isArray(a) ? a : d));
    const P = pal || {};
    shader.uniforms.uPalGreenA = { value: PV(P.greenA, [0.072, 0.275, 0.055]) };
    if (shore) {
      shader.uniforms.uShore = { value: shore.tex };
      shader.uniforms.uShoreRect = { value: new THREE.Vector4(shore.offset[0], shore.offset[1], 1 / shore.size[0], 1 / shore.size[1]) };
      // the ground's height, for the beds in a cliff face
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vShoreH;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShoreH = (modelMatrix * vec4(transformed, 1.0)).y;');
    }
    // Aerial macro layer (optional) — MATERIAL-FIRST since v24: the photo no longer
    // replaces the lit turf. Its blurred low-frequency copy (uMacroLow / uMacroAvg)
    // TINTS the material's hue/value, and the raw photo only crossfades in at TRUE
    // far range where 0.3 m/px beats screen texel density. The tiled PBR detail,
    // mow stripes, grain, and light response all survive at play distance.
    const macroDecl = macro ? `
        uniform sampler2D uMacro; uniform sampler2D uMacroSurfaces; uniform sampler2D uMacroCoverage;
        uniform sampler2D uMacroLow; uniform vec3 uMacroAvg; uniform float uMacroPhotoFar;
        uniform vec2 uMacroMin; uniform vec2 uMacroSize; uniform vec2 uMacroWeights; uniform vec2 uCourseMin;` : '';
    // NDVI class-map union (runtime NDVI classification). The class-map rides the
    // AERIAL bounds (uMacroMin/uMacroSize), NOT the terrain bounds the OSM masks use,
    // so it's sampled at clsUv (course-world → aerial-UV), never vMapUv. R = NDVI-
    // detected mown fairway (OSM may have missed), B = NDVI-detected sand. We union
    // (max) these INTO the existing gates so it can only ADD surface, never remove —
    // the _blackTex default (course with no classmap) makes cls.r=cls.b=0 → clean
    // no-op → OSM-only behavior preserved. Sampled BEFORE the stripe block on purpose:
    // the stripes key off `m`, so widening the mown gate here is what puts stripes on
    // NDVI-detected fairway. When there's no macro, `cls` is a zero vec4 so the later
    // sand-union line references a defined symbol in BOTH program variants.
    const macroPre = macro ? `
          vec2 clsUv = (uCourseMin + vMapUv * uExt - uMacroMin) / uMacroSize;
          vec4 cls = (clsUv.x >= 0.0 && clsUv.x <= 1.0 && clsUv.y >= 0.0 && clsUv.y <= 1.0)
            ? texture2D(uMacroSurfaces, clsUv) : vec4(0.0);
          // P2a-T4: the classmap is blurred smooth at load (kills the per-pixel dot-screen);
          // threshold here so only CONFIDENT (contiguous) coverage adds surface — blurred
          // isolated noise sits at low amplitude and is dropped, real regions stay high.
          cls.r = smoothstep(0.45, 0.75, cls.r);
          cls.b = smoothstep(0.45, 0.75, cls.b);
          // P2a-T3: reconcile the crisp OSM edge with the feathered NDVI classmap — where OSM
          // authored a surface within ~5 m (osmNear), suppress the NDVI feather so the crisp
          // OSM edge owns the boundary (no crisp-line + soft-halo double edge, e.g. the pale
          // sand halo around bunkers). NDVI still fills genuine OSM gaps (osmNear==0).
          cls.r *= 1.0 - osmNear;
          cls.b *= 1.0 - osmNear;
          m = max(m, cls.r);        // extend the mown gate onto NDVI fairway OSM missed` : `
          vec4 cls = vec4(0.0);`;
    const macroBlend = macro ? `
          { vec2 wXY = uCourseMin + vMapUv * uExt;
            vec2 mUv = (wXY - uMacroMin) / uMacroSize;
            if (mUv.x >= 0.0 && mUv.x <= 1.0 && mUv.y >= 0.0 && mUv.y <= 1.0) {
              // Feather across the rect edge so the layer dissolves into procedural
              // turf instead of clipping at a hard rectangle.
              vec2 edgeM = min(mUv, 1.0 - mUv) * uMacroSize;
              float edgeW = smoothstep(0.0, 7.0, min(edgeM.x, edgeM.y) + (tNoise(wXY * 0.15) - 0.5) * 5.0);
              float mvalid = texture2D(uMacroCoverage, mUv).r;
              // Two separate distance curves: the tint ramps over the mid-range and owns
              // it; the RAW photo only crossfades in past the aiming corridor (at the
              // default framing the player reads the ground at ~25-150 m, so the photo
              // band starts at 60 m — 0.3 m/px only beats screen texels ~100 m+ out).
              float tintFar  = smoothstep(20.0, 60.0, length(vViewPosition));
              float photoFar = smoothstep(60.0, 150.0, length(vViewPosition));
              // CHROMATIC TRANSFER — the photo's low-frequency hue/value modulates the
              // LIT turf instead of replacing it. uMacroLow is a blurred copy (baked
              // capture-day shadows and sub-30cm detail are gone), normalized by the
              // playable-ground mean so the tint averages ~1.0; the material keeps its
              // own value structure, stripes, and light response.
              vec3 tRaw = texture2D(uMacroLow, mUv).rgb / max(uMacroAvg, vec3(0.03));
              // CHROMA-LIMITED LUMA-LEAN: take the photo's VALUE fully, but its HUE only
              // in proportion to how far it strays from neutral. OSM-unmapped water /
              // cart paths / roofs print their saturated colour straight onto the grass
              // (a teal 'lake' painted on turf, white 'fog' smears in the corridor); they
              // are HIGH-chroma outliers, so a soft limiter crushes them to value shifts
              // while normal fairway-vs-dune tan/green drift (LOW chroma) passes through.
              float tL = dot(tRaw, vec3(0.299, 0.587, 0.114));
              vec3 chroma = tRaw - tL;
              float keep = 0.62 / (1.0 + 2.4 * length(chroma));
              vec3 tint = clamp(tL + chroma * keep, 0.62, 1.32);
              float tw = mvalid * edgeW * mix(uMacroWeights.x, uMacroWeights.y, tintFar);
              // clean turf: the 2.5 m/px tint carries capture-day tree shadows and smears
              // them as dark blotches near the player; keep it for the mid/far colour drift
              tw *= mix(1.0, mix(0.3, 0.85, tintFar), uTurfClean);
              // Greens keep their authored colour; mown fairway keeps its mow structure —
              // pull the tint back on BOTH so the manicured signal (stripes, green
              // treatment) isn't washed flat by the photo. The photo PLACES the surface;
              // the material grooms it. P2a: suppress the tint across the green VICINITY
              // (gVic, a ~4 m dilation) not just on-green — the low-freq aerial otherwise
              // smears a soft green halo just OUTSIDE the crisp mow line the base composite
              // made. gVic fades out so the tint returns to full on the open fescue.
              // v42: and over the ~2 m of rough round a tee box (the soft aux tee band
              // outside the crisp mow line), or the photo's lighter cut glows past the
              // tee's edge into the rough
              // v44: and almost none on mown fairway — its blotches were capture-day tree
              // shadows and dry patches; a clean fairway is one even tone plus its stripes
              tw *= clamp(1.0 - 0.9 * gVic - 0.95 * max(m, mCrisp) - 0.7 * smoothstep(0.05, 0.4, aux.r) * (1.0 - mCrisp), 0.0, 1.0);
              grass *= mix(vec3(1.0), tint, tw);
              // FAR PHOTO CROSSFADE — keeps the shipped "real place" overview (raw RGB;
              // a global de-light flattens real fairway/dune/sand albedo into milky grey
              // — tried, reverted). A sliver of blade grain (dl) for micro-texture.
              vec3 photo = texture2D(uMacro, mUv).rgb * (0.86 + 0.30 * dl);
              // P1b: on dry courses lower the far-photo weight so the lit TAN turf carries
              // the overview instead of the green summer aerial washing back over it.
              // clean turf: the capture-day aerial (dry patches, baked tree blobs the 3D trees
              // now duplicate) reads as dirt at range, so parkland keeps about half of it
              // v44: not on fairways and greens — the masks place them exactly, and the photo's
              // shadows and wear printed on a mown fairway read as dirt from the tee
              grass = mix(grass, photo, mvalid * edgeW * uMacroPhotoFar * photoFar * (1.0 - 0.7 * uCourseDry) * mix(1.0, 0.5, uTurfClean) * (1.0 - 0.9 * max(mCrisp, gCrisp)));
            } }` : '';
    if (macro) {
      shader.uniforms.uMacro = { value: macro.albedo };
      shader.uniforms.uMacroSurfaces = { value: macro.surfaces };
      shader.uniforms.uMacroCoverage = { value: macro.coverage };
      // HD-bundle macros have no low/avg — fall back to the ortho itself + a neutral
      // grey mean so the vec3 uniform upload never dereferences undefined (a per-frame
      // TypeError that kills the scene on HD courses whose course aerial failed).
      shader.uniforms.uMacroLow = { value: macro.low ?? macro.albedo };
      shader.uniforms.uMacroAvg = { value: macro.avg ?? new THREE.Vector3(0.2159, 0.2159, 0.2159) };
      shader.uniforms.uMacroPhotoFar = { value: macro.photoFar ?? 0.88 };
      shader.uniforms.uMacroMin = { value: new THREE.Vector2(macro.bounds.minX, macro.bounds.minY) };
      shader.uniforms.uMacroSize = { value: new THREE.Vector2(macro.bounds.maxX - macro.bounds.minX, macro.bounds.maxY - macro.bounds.minY) };
      shader.uniforms.uMacroWeights = { value: new THREE.Vector2(macro.closeWeight ?? 0.25, macro.farWeight ?? 0.6) };
      shader.uniforms.uCourseMin = { value: new THREE.Vector2(bounds.minX, bounds.minY) };
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${hq ? '#define TURF_HQ' : ''}
        ${shore ? '#define TURF_SHORE\nuniform sampler2D uShore; uniform vec4 uShoreRect; varying float vShoreH;' : ''}
        uniform sampler2D uDetail; uniform vec2 uDetailRepeat;
        uniform sampler2D uMask; uniform sampler2D uBunker; uniform sampler2D uSand;
        uniform sampler2D uMaskRaw; uniform vec3 uPalGreenA; uniform vec3 uSunDir3;
        uniform vec2 uExt; uniform vec2 uMowDir; uniform float uStripeM; uniform float uCourseDry; uniform float uTurfClean;
        // Procedural turf grain — evaluated from world XZ so it stays crisp at ANY
        // zoom. A tiled grass photo mip-blurs to a flat average from the elevated
        // orbit camera (the "Minecraft" smoothness); world-space value noise doesn't.
        uniform sampler2D uTurfNoise;
        // value noise: a random value per lattice cell, smoothstep-blended. The lattice
        // lives in uTurfNoise (256 cells a repeat) and the bilinear tap does the blend:
        // sampling at cell + smoothstep(fract) + half a texel weights the four corner
        // values exactly like mix(mix(a, b, f.x), mix(c, d, f.x), f.y) — one tap, no sin().
        float tNoise(vec2 p){
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return texture2D(uTurfNoise, (i + f + 0.5) / 256.0).r;
        }
        float tFbm2(vec2 p){ return 0.5 * tNoise(p) + 0.25 * tNoise(p * 2.03); }
        float tFbm(vec2 p){
          float s = 0.0, a = 0.5;
          for (int k = 0; k < 4; k++){ s += a * tNoise(p); p *= 2.03; a *= 0.5; }
          return s;
        }${DIVOT_GLSL}${macroDecl}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        #ifdef USE_MAP
        {
          // grass path: splat zone color modulated by tiled blade detail + mow stripes
          vec3 gd = texture2D(uDetail, vMapUv * uDetailRepeat).rgb;
          float dl = dot(gd, vec3(0.299, 0.587, 0.114));
          // P2a CRISP EDGES: the visible surface->surface boundary is the SUM of three
          // soft layers (soft splat base, ~1.8 m collar dilation, low-freq aerial tint).
          // Override the BASE COLOUR at the boundary with the palette colour, gated by a
          // fwidth-AA mask off the RAW (unblurred) mask channels. fwidth collapses the
          // mask's ramp to a ~1px mow line AT the polygon edge regardless of the mask's
          // 0.45 m/px resolution, so the boundary reads crisp instead of airbrushed.
          // One additive raw-mask sample: R=mown, G=green, B=bunker. Green overrides
          // the base colour, fairway only gates mowing structure, and bunker uses raw B.
          vec4 mkRaw = texture2D(uMaskRaw, vMapUv);
          float gRaw = mkRaw.g, mRaw = mkRaw.r, bRaw = mkRaw.b;
          float gAA = max(fwidth(gRaw), 1e-5);
          float gCrisp = smoothstep(0.5 - gAA, 0.5 + gAA, gRaw);
          float mAA = max(fwidth(mRaw), 1e-5);
          float mCrisp = smoothstep(0.5 - mAA, 0.5 + mAA, mRaw); // crisp mown (fairway) edge
          float bAA = max(fwidth(bRaw), 1e-5);
          float bCrisp = smoothstep(0.5 - bAA, 0.5 + bAA, bRaw); // crisp bunker edge
          // P2a Task 2 — GREEN COLLAR/FRINGE: a ~0.8 m apron ring just OUTSIDE the crisp
          // putting-surface edge. An 8-tap dilation of the RAW green mask is a soft ramp
          // (the collar's soft OUTER edge into the rough); (1-gCrisp) gives the crisp INNER
          // mow line; distance-faded (a play/mid feature — the far photo owns past ~60 m).
          float gDistFade = 1.0 - smoothstep(45.0, 70.0, length(vViewPosition));
          vec2 co = vec2(0.8) / uExt;
          float gDil = gRaw;
          if (gDistFade > 0.0) {   // v41: the collar's 8 taps only where it can show (< 70 m); explicit LOD, as in any branch
            gDil = (gRaw
              + textureLod(uMaskRaw, vMapUv + vec2(co.x, 0.0), 0.0).g + textureLod(uMaskRaw, vMapUv - vec2(co.x, 0.0), 0.0).g
              + textureLod(uMaskRaw, vMapUv + vec2(0.0, co.y), 0.0).g + textureLod(uMaskRaw, vMapUv - vec2(0.0, co.y), 0.0).g
              + textureLod(uMaskRaw, vMapUv + co, 0.0).g + textureLod(uMaskRaw, vMapUv - co, 0.0).g
              + textureLod(uMaskRaw, vMapUv + vec2(co.x, -co.y), 0.0).g + textureLod(uMaskRaw, vMapUv + vec2(-co.x, co.y), 0.0).g) * (1.0 / 9.0);
          }
          float collarBand = clamp(gDil, 0.0, 1.0) * (1.0 - gCrisp) * gDistFade;
          // Base-colour stack: rough(splat) -> collar apron -> putting surface. The green
          // gets a full crisp override (a distinct putting colour); the collar an apron green
          // (lighter + warmer) UNDER it; the fairway gets NO base override (splat is already
          // ~crisp; forcing dry-olive recolours + darkens shaded slopes — its soft cue is the
          // STRIPE fade, crisped below via mCrisp). Compositing the collar in baseCol means
          // the downstream grain / warm-mix / sun-rake / desat all apply to it, so it reads
          // as real mown grass, not a flat decal.
          vec3 collarCol = clamp(uPalGreenA * vec3(1.25, 1.15, 0.90), 0.0, 1.0);
          vec3 baseCol = mix(diffuseColor.rgb, collarCol, collarBand);
          baseCol = mix(baseCol, uPalGreenA, gCrisp);
          // v44 CLEAN MOWN SURFACES: fairways and greens (crisp masks) are manicured — one even
          // tone carrying only their mow pattern, the way the pro sims show them. cleanK
          // takes the mottling, the photo tint and the far photo off them below.
          float cleanK = max(mCrisp, gCrisp);
          // clean turf: the blade photo adds fine tooth, not a blotchy value swing
          vec3 grass = baseCol * mix(mix(0.72 + 0.48 * dl, 0.88 + 0.24 * dl, uTurfClean), 0.94 + 0.12 * dl, cleanK);
          // inject a little of the blade's own chroma so a zone isn't one flat tint
          // (green/yellow flecks); clamped so dark blade pixels can't blow up the hue
          grass *= mix(vec3(1.0), clamp(gd / max(dl, 0.1), 0.6, 1.5), mix(0.16, 0.07, uTurfClean) * (1.0 - 0.6 * cleanK));
          vec4 mk = texture2D(uMask, vMapUv);
          float m = mk.r;                 // mown gate — semantics unchanged
          float g = mk.g;                 // green gate — packed channel (.g = greens only)
          // P2a: a GREEN-VICINITY membership (soft ~4 m dilation of the crisp green) used
          // ONLY to suppress the low-freq aerial tint near greens. uMacroLow is blurred
          // ~5 m, so the green oval smears a soft GREEN halo just OUTSIDE the crisp mow
          // line — knocking the tint down in the vicinity is what keeps the boundary crisp.
          vec2 vo = vec2(4.0) / uExt;
          float gVic = (texture2D(uMaskRaw, vMapUv + vec2(vo.x, 0.0)).g + texture2D(uMaskRaw, vMapUv - vec2(vo.x, 0.0)).g
                      + texture2D(uMaskRaw, vMapUv + vec2(0.0, vo.y)).g + texture2D(uMaskRaw, vMapUv - vec2(0.0, vo.y)).g) * 0.25;
          gVic = max(gVic, gCrisp);
          // P2a-T3: OSM-VICINITY — is an OSM-authored surface (mown .r or bunker .b) within
          // ~5 m? A 4-tap MAX dilation of the RAW OSM mask. Used in macroPre to suppress the
          // feathered NDVI classmap where OSM already authored the boundary crisply, so we
          // don't stack a crisp OSM edge + a soft NDVI halo (the double edge). NDVI survives
          // only in genuine OSM gaps (osmNear==0).
          vec2 no = vec2(5.0) / uExt;
          vec4 no1 = texture2D(uMaskRaw, vMapUv + vec2(no.x, 0.0));
          vec4 no2 = texture2D(uMaskRaw, vMapUv - vec2(no.x, 0.0));
          vec4 no3 = texture2D(uMaskRaw, vMapUv + vec2(0.0, no.y));
          vec4 no4 = texture2D(uMaskRaw, vMapUv - vec2(0.0, no.y));
          float osmNear = max(max(mkRaw.r, mkRaw.b),
            max(max(max(no1.r, no1.b), max(no2.r, no2.b)), max(max(no3.r, no3.b), max(no4.r, no4.b))));
          // Union the NDVI class-map into the mown gate BEFORE the stripe block (see
          // macroPre): widens the mown gate onto NDVI-detected fairway OSM missed; cls is
          // also reused by the sand union below (kept inside #ifdef USE_MAP, GTAO-safe).${macroPre}
          // P2a: the green CHARACTER (checker/contour/sheen roll below) rides the CRISP
          // membership so it stops at the same mow line as the base colour. (v29 checker +
          // contour still apply INSIDE where gCrisp==1, just with a sharp edge.) The collar
          // apron is composited above in baseCol (gDil / collarBand computed there).
          float gEdge = gCrisp;                                  // crisp green membership
          float wx = vMapUv.x * uExt.x, wy = vMapUv.y * uExt.y;
          // the ground a pixel steps across, per screen axis (divot edge AA, below; taken
          // here, outside any branch, where screen derivatives are defined)
          vec2 wdx = dFdx(vec2(wx, wy)), wdy = dFdy(vec2(wx, wy));
          // procedural grain: fine "tooth" (~0.5-4m) + broad patches (~8-20m), so the
          // turf reads as real grass at the orbit camera instead of a flat plastic
          // sheet. Strong on purpose — this is the fix for the "Minecraft" look.
          // Multi-scale variation so the field is never the same twice (real grass
          // isn't). fbm clusters near its mean, so use a big gain (re-center ~0.47).
          #ifdef TURF_HQ
          float fine  = tFbm(vec2(wx, wy) * 0.40) - 0.47;        // ~0.7-3m blade grain
          float broad = tFbm(vec2(wy, wx) * 0.10 + 11.3) - 0.47; // ~8-15m growth/wear patches
          float zone  = tFbm(vec2(wx, wy) * 0.026 + 3.7) - 0.47; // ~30-80m big regions
          #else
          // Low: two octaves each, half the taps (the finer two are under a pixel at Low's
          // resolution a few metres out, where they only shimmered)
          float fine  = tFbm2(vec2(wx, wy) * 0.40) - 0.375;
          float broad = tFbm2(vec2(wy, wx) * 0.10 + 11.3) - 0.375;
          float zone  = tFbm2(vec2(wx, wy) * 0.026 + 3.7) - 0.375;
          #endif
          // Manicured rebalance (Phase 2): the loud mid-scale grain read as blotch/wear
          // and BURIED the mow stripes — the opposite of manicured. Tame fine+broad,
          // keep the large zone (it survives the orbit-cam mip-collapse and carries the
          // lush/dry character below). Clean base + bold stripes = the "pro sim" read.
          // clean turf keeps a quarter: manicured parkland grass is even, and the
          // stacked mottling read as dirty felt at the hitting view
          grass *= 1.0 + (0.26 * fine + 0.12 * broad + 0.20 * zone) * mix(1.0, 0.1, uTurfClean) * (1.0 - 0.85 * cleanK); // GENTLE — stacked mottling read as churned "warzone" mud on hilly holes
          // big regions also shift the grass CHARACTER — lush deep-green <-> dry
          // yellow-green — so different parts of the course read as different grass,
          // not one uniform tone stamped edge to edge.
          // P1b: on dry/links courses the tan comes from the base palette, so pull the
          // noise warm-endpoint toward neutral by uCourseDry — else the tan base x warm
          // multiplier double-counts and overshoots past the target gold-tan.
          vec3 warmEnd = mix(vec3(1.13, 1.03, 0.74), vec3(1.0, 1.0, 0.96), uCourseDry * 0.7);
          grass *= mix(vec3(1.0), mix(vec3(0.93, 1.0, 0.9), warmEnd,
                       clamp(zone * 1.7 + 0.5, 0.0, 1.0)), mix(1.0, 0.15, uTurfClean) * (1.0 - 0.85 * cleanK)); // lush green <-> golden tan-fescue patches
          grass.r *= 1.0 + 0.10 * broad * mix(1.0, 0.3, uTurfClean) * (1.0 - 0.85 * cleanK); // finer warm/cool drift on top
          grass.b *= 1.0 - 0.07 * broad * mix(1.0, 0.3, uTurfClean) * (1.0 - 0.85 * cleanK);
          // Mowing stripes — the dominant "manicured" signal, fairway/green only.
          // Softer smoothstep ramps give the mower-sheen gradient (not hard bars). A
          // BOLD primary set reads as light/dark bands from the orbit camera; a fainter,
          // wider cross set keeps the pattern alive when you sight straight down the
          // primary axis (a single direction vanishes when you look along it).
          // v44: the bands run DOWN the hole being played (uMowDir), the way fairways are
          // cut for play: from the tee or the fairway you look along the passes, light and
          // dark, converging on the green. The fainter cross set runs at right angles.
          vec2 mowN = vec2(-uMowDir.y, uMowDir.x);
          float band = sin(dot(vec2(wx, wy), mowN) * (3.14159265 / uStripeM));
          float stripe = smoothstep(-0.42, 0.42, band) * 2.0 - 1.0;
          float band2 = sin(dot(vec2(wx, wy), uMowDir) * (3.14159265 / (uStripeM * 1.7)));
          float stripe2 = smoothstep(-0.5, 0.5, band2) * 2.0 - 1.0;
          // Bolder primary set — the photo tint no longer washes it flat (pulled back on
          // mown ground above), so the grooming cue can carry. Fairway only (green +
          // collar suppressed; the green has its own tighter checker below).
          // DISTANCE-FADE (v30): mow stripes are a PLAY-scale grooming cue — full near the
          // player, gone by survey/overview range. Without this the grid over-reads as an
          // artificial pattern at altitude now that the lowered courseAerialPhotoFar lets
          // the lit relief (and the stripes) show through instead of a flat far photo.
          // v44: carried further (the stripes are what make a fairway read mown down its length)
          float sFade = 1.0 - smoothstep(200.0, 420.0, length(vViewPosition));
          // World-space unit vector from this fragment to the camera (the view-space vector
          // turned back by the transpose of the view rotation) and its part on the ground
          // plane in sim XY (sim y = -three z). Drives the view-dependent turf terms below.
          vec3 toCamW = normalize((vec4(vViewPosition, 0.0) * viewMatrix).xyz);
          vec2 toCamH = vec2(toCamW.x, -toCamW.z);
          // P1b: links are lightly mown — scale stripe strength down (to a low, non-zero
          // floor) by uCourseDry; parkland (0) keeps the bold set.
          // P2a: gate the stripes on the CRISP mown edge (mCrisp) so they stop at the mow
          // line instead of the soft ~1 m fade; keep the NDVI union (cls.r) for coverage
          // OSM lacks (its feather is reconciled in Task 3).
          // AUX surfaces (soft ~1.8 m): R = tee, G = water, B = bunker.
          vec4 aux = texture2D(uBunker, vMapUv);
          // v42: full strength right up to the crisp mow line (the soft aux band is ~0.5 AT
          // the tee's edge, so the old 0.35-0.65 ramp left a lighter rim inside the box)
          float teeK = smoothstep(0.15, 0.35, aux.r) * mCrisp;
          // Tees are cut short and cross-mown, not striped like a fairway: drop the bold
          // fairway bands there and lay a fine checker instead (below).
          // clean turf: real stripes are a sheen, not paint — with a sun-dominant key the
          // bold set read as glaring pale bars, so parkland runs them at ~45%
          // v39: the bands are a SHEEN, not paint. Each mower pass lays its blades one way,
          // so a band reads light looking down its grain and dark looking against it: sign
          // each band by how far the view runs along its mow line. The bands swap as you
          // walk round a hole and fade looking straight across them; a small static share
          // keeps the pattern from the air (toCamH shrinks toward an overhead view).
          // v44: signed by the view along the mow line, with a small static share for views
          // across it or from overhead (the old 0.45 + 0.55 x cancelled to nothing looking
          // back up the hole — the bands swap, they don't vanish)
          float vd1 = dot(toCamH, uMowDir), vd2 = dot(toCamH, mowN);
          float sheen1 = stripe * (0.25 * (1.0 - abs(vd1)) + 0.85 * vd1);
          float sheen2 = stripe2 * (0.25 * (1.0 - abs(vd2)) + 0.85 * vd2);
          grass *= 1.0 + (0.38 * sheen1 + 0.17 * sheen2) * mix(1.0, 0.6, uTurfClean) * max(mCrisp, cls.r) * (1.0 - 0.85 * g - 0.6 * collarBand) * (1.0 - 0.92 * teeK) * sFade * (1.0 - 0.7 * uCourseDry);
          {
            float tb1 = sin((wx * 0.71 + wy * 0.71) * (3.14159265 / 1.6));
            float tb2 = sin((wx * -0.71 + wy * 0.71) * (3.14159265 / 1.6));
            grass *= 1.0 + 0.05 * ((smoothstep(-0.5, 0.5, tb1) - 0.5) + (smoothstep(-0.5, 0.5, tb2) - 0.5)) * teeK * sFade;
            grass *= mix(1.0, mix(0.86, 0.91, uTurfClean), teeK); // the tee palette reads hot next to the darker rough (a lit pad in the sun-dominant key); v42: less, now the photo's glow round it is gone
          }
          // GREEN (v29): calm fine grain + a SUBTLE checker mow + a gentle contour roll,
          // all gated by the SOFT edge (gEdge) so the putting-surface character fades
          // across the collar instead of at a hard line. Checker dropped 0.15 -> 0.09 (the
          // bold grid read as a blocky checkerboard from the orbit cam); a low-freq value
          // roll gives the green a shaped, non-uniform read instead of a flat disc.
          vec3 gdF = texture2D(uDetail, vMapUv * uDetailRepeat * 3.0).rgb;
          float dlF = dot(gdF, vec3(0.299, 0.587, 0.114));
          grass = mix(grass, grass * (0.92 + 0.16 * dlF), gEdge);
          float gb1 = sin((wx * 0.94 + wy * 0.34) * (3.14159265 / (uStripeM * 0.30)));
          float gb2 = sin((wx * -0.34 + wy * 0.94) * (3.14159265 / (uStripeM * 0.30)));
          // v39: the checker is a sheen too (two passes at right angles), same rule as the fairway
          float gs1 = (smoothstep(-0.6, 0.6, gb1) - 0.5) * (0.3 + 0.7 * dot(toCamH, vec2(-0.34, 0.94)));
          float gs2 = (smoothstep(-0.6, 0.6, gb2) - 0.5) * (0.3 + 0.7 * dot(toCamH, vec2(-0.94, -0.34)));
          grass *= 1.0 + 0.11 * (gs1 + gs2) * gEdge * sFade;
          if (gEdge > 0.0) {   // greens only: four noise taps nothing else needs
            float gRoll = tFbm(vec2(wx, wy) * 0.06 + 7.0) - 0.5;   // ~16 m gentle undulation
            grass *= 1.0 + 0.05 * gRoll * gEdge;                  // shaped green, not a flat disc
          }
          // Procedural sun-play — directional shading from a low-frequency undulation
          // field so the sun visibly rakes across gentle rolls instead of lighting a
          // flat sheet. The DIRECTIONAL gradient (one flank of a roll lit, the other
          // shaded) is what reads as a lit 3D surface; the isotropic grain above only
          // reads as texture. Faked in albedo — cheap, GTAO-safe, turf normal is ~flat.
          vec2 sp = vec2(wx, wy) * 0.085;                  // ~12m roll wavelength (survives distance)
          // v41: the broad ~12 m roll only needs two octaves (half the taps; gain doubled below)
          #ifdef TURF_HQ
          float gx = tFbm2(sp + vec2(0.07, 0.0)) - tFbm2(sp - vec2(0.07, 0.0));
          float gy = tFbm2(sp + vec2(0.0, 0.07)) - tFbm2(sp - vec2(0.0, 0.07));
          #else
          float r0 = tFbm2(sp);   // Low: one-sided differences, three evaluations instead of four
          float gx = 2.0 * (tFbm2(sp + vec2(0.07, 0.0)) - r0);
          float gy = 2.0 * (tFbm2(sp + vec2(0.0, 0.07)) - r0);
          #endif
          vec2 sunDir = normalize(vec2(0.55, -0.84));      // HDRI sun's horizontal bearing
          float rake = clamp((gx * sunDir.x + gy * sunDir.y) * 14.0, -0.6, 0.6);
          grass *= 1.0 + 0.09 * rake * mix(1.0, 0.25, uTurfClean); // GENTLE — 0.22 was carving dark shade-bands into the hills
          // v39 BLADE LIGHT: turf is a forest of thin blades, not a sheet. Looking down-sun
          // you see their lit faces and none of their shadows (the bright hot spot around
          // the antisolar point); looking into the sun you see their shaded sides. Soft
          // and view-dependent, so the same slope changes with the camera like real grass.
          float hot = dot(toCamW, uSunDir3);
          grass *= 1.0 + 0.10 * pow(max(hot, 0.0), 3.0) - 0.10 * pow(max(-hot, 0.0), 1.5) * (1.0 - 0.5 * gEdge);
          // v39 NEAR TOOTH: the blade photo carries real tooth close to the player; it read
          // as felt only because the clean pass kept it faint everywhere. The far field keeps
          // the calm look (it mip-collapses to the average anyway); greens stay smoother.
          float nearT = 1.0 - smoothstep(20.0, 60.0, length(vViewPosition));
          grass *= mix(1.0, 0.78 + 0.55 * dl, 0.55 * nearT * (1.0 - 0.6 * gEdge));
          // ---- ROUGH / FIRST CUT / BANKS / LIPS (2026-11 material pass) ----------------
          // Everything not mown, not green, not sand is ROUGH (physics agrees: unlabelled
          // ground plays as rough). It was the same flat tint as the mown corridor; now it
          // reads coarser and darker: tussock clumps near the camera, straw/olive patches
          // at 6-25 m, and broad 60-200 m macro drift that survives to the horizon.
          {
            float viewD = length(vViewPosition);
            float mownAll = max(max(mCrisp, cls.r), gCrisp);
            float roughK = clamp(1.0 - max(mownAll, collarBand) - bCrisp, 0.0, 1.0);
            float firstCut = 0.0;
            #ifdef TURF_HQ
            // first cut / intermediate rough: a ~2.2 m band hugging every mown or green edge
            // (v41: only on rough — a distance cut-off drew a visible ring at its range)
            if (roughK > 0.0) {
              vec2 fo = vec2(2.2) / uExt;
              vec4 f1 = textureLod(uMaskRaw, vMapUv + vec2(fo.x, 0.0), 0.0), f2 = textureLod(uMaskRaw, vMapUv - vec2(fo.x, 0.0), 0.0);
              vec4 f3 = textureLod(uMaskRaw, vMapUv + vec2(0.0, fo.y), 0.0), f4 = textureLod(uMaskRaw, vMapUv - vec2(0.0, fo.y), 0.0);
              float near4 = max(max(max(f1.r, f1.g), max(f2.r, f2.g)), max(max(f3.r, f3.g), max(f4.r, f4.g)));
              firstCut = clamp(near4, 0.0, 1.0) * roughK;
            }
            // tussocks: clumpy value at ~0.7 m, faded out before it can alias
            float clumpFade = 1.0 - smoothstep(18.0, 55.0, viewD);
            if (clumpFade > 0.0 && roughK > 0.0) {   // coherent branch: skip the fbm far out
              float tuft = smoothstep(0.30, 0.78, tFbm(vec2(wx, wy) * 1.45 + 4.1));
              grass *= 1.0 + (0.30 * tuft - 0.12) * roughK * (1.0 - firstCut) * clumpFade * mix(1.0, 0.3, uTurfClean);
            }
            #endif
            float roughOnly = roughK * (1.0 - firstCut);
            if (roughK > 0.0) {   // v41: the rough's own patches (12 noise taps) skip mown ground and greens
              float straw = smoothstep(0.50, 0.80, tFbm(vec2(wy, wx) * 0.065 + 21.0));
              #ifdef TURF_HQ
              float macroR = tFbm(vec2(wx, wy) * 0.0075 + 9.0) - 0.47;
              float macroR2 = tFbm(vec2(wy, wx) * 0.021 + 2.0) - 0.47;
              #else
              float macroR = tFbm2(vec2(wx, wy) * 0.0075 + 9.0) - 0.375;    // Low: the broad drift's two big octaves
              float macroR2 = tFbm2(vec2(wy, wx) * 0.021 + 2.0) - 0.375;
              #endif
              vec3 dryTint = mix(vec3(1.20, 1.08, 0.70), vec3(1.06, 1.03, 0.92), uCourseDry);
              grass *= mix(vec3(1.0), dryTint, straw * 0.55 * roughOnly * mix(1.0, 0.05, uTurfClean)); // straw / olive patches (links; watered parkland rough stays green)
              grass *= 1.0 + (0.34 * macroR + 0.18 * macroR2) * roughK * mix(1.0, 0.2, uTurfClean); // broad drift, to the horizon
              // v42: rough is mown too, in wider passes than the fairway: a faint sheen band
              // (~5 m, the fairway's direction; light along the grain, dark against it) and
              // 3-7 m lush/thin patches give the slopes the meso-scale structure whose lack
              // read as felt from the address view
              float rbd = sin((wx * 0.82 + wy * 0.57) * (3.14159265 / 5.0));
              float rSheen = (smoothstep(-0.55, 0.55, rbd) * 2.0 - 1.0) * (0.35 + 0.65 * dot(toCamH, vec2(-0.57, 0.82)));
              float rPatch = tFbm2(vec2(wy, wx) * 0.14 + 6.1) - 0.375;
              grass *= 1.0 + (0.085 * rSheen * sFade + 0.32 * rPatch) * roughOnly;   // half the fairway's: rough must not read as fairway
              grass *= mix(vec3(1.0), vec3(1.03, 1.02, 0.93), clamp(rPatch * 3.0, 0.0, 1.0) * 0.5 * roughOnly);   // thin patches a touch yellower
            }
            grass *= mix(1.0, 0.86, roughOnly);                                   // rough sits darker than the cut
            grass *= mix(1.0, 1.06, firstCut);                                    // first cut: a step lighter, cleaner
            // wet banks: darker, cooler, lusher grass within ~2 m of water
            float bank = clamp(aux.g * 2.2, 0.0, 1.0) * (1.0 - gCrisp);
            grass *= mix(vec3(1.0), vec3(0.74, 0.84, 0.80), bank * 0.85);
            // the pond bed (carved under the water, seen through the shallows) is silt
            grass = mix(grass, vec3(0.085, 0.075, 0.045), smoothstep(0.6, 0.92, aux.g));
            // bunker lips: the grass face just outside the crisp sand edge, shaded on the
            // edge nearest the sun (it slopes away from it) and lit on the far edge
            float lip = clamp(aux.b * 2.0, 0.0, 1.0) * (1.0 - bCrisp);
            #ifdef TURF_HQ
            vec2 le = vec2(1.0) / uExt;
            float lgx = texture2D(uBunker, vMapUv + vec2(le.x, 0.0)).b - texture2D(uBunker, vMapUv - vec2(le.x, 0.0)).b;
            float lgy = texture2D(uBunker, vMapUv + vec2(0.0, le.y)).b - texture2D(uBunker, vMapUv - vec2(0.0, le.y)).b;
            float lipFacing = dot(normalize(vec2(lgx, lgy) + 1e-5), normalize(vec2(uSunDir3.x, -uSunDir3.z) + 1e-5));
            grass *= 1.0 - 0.26 * lip * clamp(0.55 - 0.8 * lipFacing, 0.1, 1.0);
            grass *= 1.0 + 0.12 * lip * clamp(lipFacing, 0.0, 1.0);
            #else
            grass *= 1.0 - 0.18 * lip;
            #endif
          }
          // Pull the radioactive kelly-green toward muted, warm tan-green fescue (Bandon
          // links is firm golden-tan, not astroturf emerald). Desaturate + warm.
          float gLum = dot(grass, vec3(0.299, 0.587, 0.114));
          // clean parkland turf keeps its colour: the 40% pull is a links tan-fescue tune
          grass = mix(grass, vec3(gLum * mix(0.85, 0.92, uTurfClean)) * vec3(1.1, 1.0, 0.8), mix(0.4, 0.22, uTurfClean)); // *0.85 darkens so desaturating doesn't LIGHTEN the green to pale
          #ifdef TURF_SHORE
          // THE SHORE (sea.js shoreGround): where the ground meets the sea, beach sand on the
          // low, gentle ground, rock on the cliffs and a steep waterline, wet and dark in the
          // last metre above the water. Only on the rough: the course's surfaces keep theirs.
          // Before the aerial: its tint shades the shore like the turf, its far photo owns it.
          {
            vec4 sh = texture2D(uShore, (vMapUv * uExt + uShoreRect.xy) * uShoreRect.zw);
            if (sh.r + sh.g > 0.004) {
              float onShore = clamp(1.0 - max(max(mCrisp, cls.r), gCrisp) - bCrisp, 0.0, 1.0);
              // the grid's smooth contours broken up into a ragged line where the grass
              // stops: tongues of sand, outcrops of rock, tufts at the edge
              float brk = tFbm(vec2(wx, wy) * 0.21 + 5.3) - 0.47 + 0.35 * (tNoise(vec2(wx, wy) * 1.1) - 0.5);
              float sandK = smoothstep(0.42, 0.58, sh.r + brk * 0.6) * onShore;
              float rockK = smoothstep(0.38, 0.6, sh.g - brk * 0.5) * onShore;
              // beach sand: the bunker sand's grain, toned down to a grey-tan shore sand,
              // darker and cooler where the sea wets it
              vec3 beach = texture2D(uSand, vMapUv * uDetailRepeat * 0.5).rgb * 0.62;
              beach = mix(beach, vec3(0.34, 0.30, 0.235), 0.5) * (0.92 + 0.16 * tNoise(vec2(wx, wy) * 1.3));
              beach *= mix(vec3(1.0), vec3(0.55, 0.56, 0.6), sh.b);
              // grey-brown stone in beds along the face, blocky, cracked close up, darker
              // and wet low down
              float beds = tNoise(vec2(vShoreH * 1.3 + 4.0 * tNoise(vec2(wx, wy) * 0.15), 7.7));
              float blocks = tFbm(vec2(wx, wy) * 0.45 + vShoreH * 0.3);
              float crag = tFbm(vec2(wx, wy) * 1.9 + vShoreH * 1.1);
              vec3 rock = mix(vec3(0.062, 0.058, 0.054), vec3(0.20, 0.182, 0.155), smoothstep(0.3, 0.7, blocks));
              rock = mix(rock, vec3(0.27, 0.235, 0.185), 0.35 * smoothstep(0.55, 0.8, beds));   // paler sandstone beds
              rock *= (0.8 + 0.4 * beds) * (0.62 + 0.76 * smoothstep(0.25, 0.7, crag)) * mix(1.0, 0.55, sh.b);
              grass = mix(grass, beach, sandK);
              grass = mix(grass, rock, rockK);
            }
          }
          #endif
          ${macroBlend}
          // v42 DIVOTS (divots.js): sand-and-seed scars on tees and fairways, inside ~45 m
          // (a 10 cm scar is under a pixel past that); the grass field grows no blades in them.
          // High quality only, like the other close-range extras
          #ifdef TURF_HQ
          float dvFade = 1.0 - smoothstep(25.0, 45.0, length(vViewPosition));
          vec2 dvC; mat2 dvRot; vec2 dvR; float dvLook;
          if (dvFade > 0.0 && divotCell(vec2(wx, wy), uExt, uMask, uBunker, dvC, dvRot, dvR, dvLook)) {
            // edge AA from the distance one pixel over on each screen axis (finite
            // differences: no derivatives needed in this branch); a divot under a pixel
            // fades with its share of the pixel instead of smearing to full strength
            float e0 = divotE(vec2(wx, wy), dvC, dvRot, dvR);
            float dvAA = clamp(abs(divotE(vec2(wx, wy) + wdx, dvC, dvRot, dvR) - e0) + abs(divotE(vec2(wx, wy) + wdy, dvC, dvRot, dvR) - e0), 0.02, 3.0);
            float cov = (1.0 - smoothstep(1.0 - dvAA, 1.0 + dvAA, e0)) / max(1.0, dvAA);
            if (cov > 0.0) {
              vec3 fill = mix(vec3(0.36, 0.29, 0.16), vec3(0.16, 0.20, 0.07), smoothstep(0.6, 0.95, dvLook)); // fresh sand-seed .. healing
              fill *= 0.82 + 0.36 * tNoise(vec2(wx, wy) * 40.0);                        // grains and seed
              fill *= mix(1.0, 0.6, smoothstep(0.45, 0.95, divotAlong(vec2(wx, wy), dvC, dvRot, dvR))); // torn front edge
              fill *= mix(1.0, 0.72, smoothstep(0.7, 1.0, e0));                         // the cut wall
              grass = mix(grass, fill, cov * dvFade);
            }
          }
          #endif
          // Soft highlight rolloff: light mown/aerial areas + mow-stripe peaks were
          // washing out to pale rectangles. Compress grass values above ~0.66.
          grass = grass / (1.0 + 0.5 * max(vec3(0.0), grass - 0.66));
          // sand path: real tiled sand toned to muted GREIGE native sand (was brightened
          // toward bunker-white *1.28 — real links/waste sand is grey-tan ~#b7a98b, verified
          // vs Chambers Bay photos; white sand read as manufactured/wrong).
          vec3 sand = texture2D(uSand, vMapUv * uDetailRepeat).rgb;
          sand = mix(sand, vec3(0.72, 0.68, 0.58), 0.18) * 1.04;
          // Union NDVI-detected sand (cls.b) into the OSM bunker mask, but only OUTSIDE
          // mown ground — m is post-union here, so "no sand where OSM- or NDVI-mown".
          // P2a: crisp the OSM bunker edge with fwidth AA so the sand->grass boundary is a
          // ~1px line, killing the soft desaturated "sand halo" band the blurred mask left
          // around each bunker. (The NDVI cls.b feather stays; Task 3 reconciles it.)
          float bm = max(bCrisp, cls.b * (1.0 - m));
          diffuseColor.rgb = mix(grass, sand, bm);
        }
        #endif`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        // Turf is near-Lambertian — force it MATTE everywhere. The old mown-surface
        // roughness reduction + sky reflection produced the wet-plastic specular blowout
        // on sunlit slopes (the big white smear). A high roughness floor kills it.
        roughnessFactor = clamp(roughnessFactor, 0.9, 1.0);
        // GREEN sheen: putting surfaces are the one turf with a real (subtle) specular
        // read. Explicit USE_MAP guard — this chunk has none of its own, and GTAO's
        // normal-pass recompile must never see vMapUv unguarded.
        #ifdef USE_MAP
        roughnessFactor = mix(roughnessFactor, 0.84, texture2D(uMask, vMapUv).g);
        #endif`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // Specular sheen: tilt the shading normal by a low-frequency undulation field so
        // the sun glint + sky reflection ROLL across the turf as the camera moves (the
        // wet-lush pro-sim sheen). World XZ from the splat UV; nudge the view-space
        // normal toward the undulation downslope. vMapUv is defined (USE_MAP) so this
        // stays GTAO-safe; the tilt is gentle so distant turf doesn't shimmer.
        {
          float snwx = vMapUv.x * uExt.x, snwy = vMapUv.y * uExt.y;
          // SMOOTH single-octave noise (not fbm): broad rolls only, no fine facets —
          // fine facets + a sharp specular lobe are what glitter without TAA. Broad
          // rolls give soft sheen BANDS on the flanks, so we can afford a lower
          // roughness (below) for a sheen that actually reads.
          vec2 snp = vec2(snwx, snwy) * 0.045;   // ~22m smooth rolls
          float sgx = tNoise(snp + vec2(0.12, 0.0)) - tNoise(snp - vec2(0.12, 0.0));
          float sgy = tNoise(snp + vec2(0.0, 0.12)) - tNoise(snp - vec2(0.0, 0.12));
          vec3 tiltV = (viewMatrix * vec4(-sgx, 0.0, -sgy, 0.0)).xyz;
          normal = normalize(normal + tiltV * 0.12); // tiny: gentle form only — strong tilt + low roughness was the wet-plastic glare
          // Meso-relief (lever 3): procedural ~1.8 m hummocks BETWEEN the blade normalMap and
          // the 22 m sheen rolls, so turf reads as an undulating surface, not a flat sheet.
          // Distance-faded past ~18 m (no shimmer); modulates DIFFUSE only (roughness floor 0.9
          // kills the specular sparkle that would otherwise glitter without TAA).
          float mFade = 1.0 - smoothstep(18.0, 55.0, length(vViewPosition));
          if (mFade > 0.0) {   // coherent branch: three fbm evaluations only where they show
            float me = 0.35, mh0 = tFbm(vec2(snwx, snwy) * 0.55);
            float mhx = tFbm((vec2(snwx, snwy) + vec2(me, 0.0)) * 0.55);
            float mhy = tFbm((vec2(snwx, snwy) + vec2(0.0, me)) * 0.55);
            vec3 mTilt = (viewMatrix * vec4(-(mhx - mh0) / me, 0.0, -(mhy - mh0) / me, 0.0)).xyz;
            normal = normalize(normal + mTilt * (0.18 * mFade));
          }
        }`);
  };
  mat.customProgramCacheKey = () => `turf-grain-v44${macro ? '-macro' : ''}${hq ? '' : '-lq'}${shore ? '-shore' : ''}`; // v44: clean fairways/greens, stripes down the hole (v43: Low's lighter grain; v42: divots, crisp tee box, rough sheen; v41: distance/surface-gated taps; v40: texture value noise)
  // textures injected via onBeforeCompile (+ the canvas masks) aren't reachable from
  // the standard material slots, so register them for disposal on course reload.
  mat.userData.disposeTextures = [detail, sand, maskTex, bunkerMaskTex, ...(surfaceMaskRaw ? [maskRawTex] : []), ...(shore ? [shore.tex] : [])];
  return mat;
}
