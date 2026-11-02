// Optional Google Photorealistic 3D Tiles around the course — the real houses, trees and
// lakes beyond the playing area. OFF unless the server was started with the user's own Map
// Tiles API key (GOOGLE_MAPS_API_KEY); without one this module never contacts Google and
// changes nothing.
//
// How the tiles are fitted to the course:
//   - 3d-tiles-renderer (NASA-AMMOS) loads lazily from /vendor/ through the import map.
//   - ReorientationPlugin puts course.origin at the scene origin, Y up (azimuth π, so +X is
//     east and -Z north like the rest of the scene). A parent "anchor" group scales true
//     WGS84 metres onto the course's equirectangular metres (anchorScale) and carries the
//     vertical offset between Google's ellipsoidal heights and the course's NAVD88 heights
//     (stored relative to elevation.baseM), measured by raycasting Google's mesh around the
//     course edge. The tiles stay hidden until that offset is known.
//   - Inside the course terrain rectangle our terrain, trees and buildings win: tile
//     materials discard fragments there (with a few metres of dithered seam), tiles wholly
//     inside are never loaded or refined, and our countryside apron + horizon band hide while
//     Google's surroundings are on screen. Fog still applies, so far tiles fade into haze.
//   - Attribution: the Google Maps logo + the per-tile data providers, as the Map Tiles API
//     policies require, next to a "Course" credit so it is clear which parts are ours.
//
// The fitting maths is pure and unit-tested (test/google-tiles.test.mjs).
import * as THREE from 'three';
import { RENDER_CONFIG } from './config.js';

const GOOGLE_ROOT_URL = 'https://tile.googleapis.com/v1/3dtiles/root.json';
const DRACO_DECODER_PATH = '/vendor/three/examples/jsm/libs/draco/gltf/';
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Pure helpers

// Should this page load Google tiles? serverConfig is GET /api/google-tiles-config (the
// key only reaches loopback clients); search is location.search. Visual-capture runs stay
// deterministic (no network imagery) unless they opt in with &googleTiles=1.
export function googleTilesMode({ serverConfig = null, search = '', enabledInConfig = true } = {}) {
  if (!enabledInConfig) return { enabled: false, reason: 'render-config' };
  const key = typeof serverConfig?.apiKey === 'string' ? serverConfig.apiKey.trim() : '';
  if (serverConfig?.enabled !== true || !key) return { enabled: false, reason: serverConfig?.reason || 'no-key' };
  const q = new URLSearchParams(search || '');
  if (q.get('googleTiles') === '0') return { enabled: false, reason: 'url-off' };
  if (q.get('visualCapture') === '1' && q.get('googleTiles') !== '1') return { enabled: false, reason: 'visual-capture' };
  return {
    enabled: true,
    reason: 'key',
    apiKey: key,
    rootUrl: typeof serverConfig.rootUrl === 'string' && serverConfig.rootUrl ? serverConfig.rootUrl : null,
    logoUrl: typeof serverConfig.logoUrl === 'string' && serverConfig.logoUrl ? serverConfig.logoUrl : null,
  };
}

// The course terrain rectangle (sim metres) — the same extent GolfScene._bounds renders.
export function clipRectFromElevation(e) {
  if (!e || ![e.minX, e.minY, e.cellM, e.nx, e.ny].every(Number.isFinite) || e.nx < 2 || e.ny < 2 || !(e.cellM > 0)) return null;
  return { minX: e.minX, minY: e.minY, maxX: e.minX + (e.nx - 1) * e.cellM, maxY: e.minY + (e.ny - 1) * e.cellM };
}

// The rectangle in three world XZ (z = -north) as the shader's vec4(minX, minZ, maxX, maxZ).
export function clipUniformRect(rect) {
  return [rect.minX, -rect.maxY, rect.maxX, -rect.minY];
}

// Share of Google fragments kept at sim (x, y) — what the shader's dithered seam does on
// average: all outside the rectangle, none `edgeM` or more inside, linear across the seam.
export function clipKeepFraction(x, y, rect, edgeM) {
  const inside = Math.min(x - rect.minX, rect.maxX - x, y - rect.minY, rect.maxY - y);
  if (!(inside > 0)) return 1;
  return Math.max(0, 1 - inside / Math.max(edgeM, 1e-3));
}

// A tile whose bounding circle (three world XZ) lies wholly inside the rectangle, `marginM`
// in from its edges, can never show a fragment — so it is never loaded or refined.
export function circleInsideRect(cx, cz, r, rect3, marginM = 0) {
  return cx - r >= rect3.minX + marginM && cx + r <= rect3.maxX - marginM
    && cz - r >= rect3.minZ + marginM && cz + r <= rect3.maxZ - marginM;
}

// Course x/y come from an equirectangular projection with spherical constants (lib/course.js:
// 111319.49·cos(lat0) m per degree east, 111132.95 m per degree north); the tiles are true
// WGS84 metres. These factors map true metres east/north onto course metres (unscaled, the
// tiles would drift ~1.7 m per km east at 45°N, ~5 m per km north at the equator).
export function projectionScale(latDeg) {
  const a = 6378137, e2 = 6.69437999014e-3;
  const phi = latDeg * DEG, s = Math.sin(phi);
  const w = Math.sqrt(1 - e2 * s * s);
  const trueEast = DEG * (a / w) * Math.cos(phi);       // metres per degree of longitude
  const trueNorth = DEG * ((a * (1 - e2)) / (w * w * w)); // metres per degree of latitude
  return { sx: (111319.49 * Math.cos(phi)) / trueEast, sy: 111132.95 / trueNorth };
}

// The tileset gets ONE scale factor, the mean of the two: the renderer's screen-space error
// assumes a uniform scale (and warns every frame otherwise). The leftover anisotropy,
// |sx - sy| / 2, is under 0.1% at 45°N and 0.25% at the equator — about 1-3 m at a course edge.
export function anchorScale(latDeg) {
  const { sx, sy } = projectionScale(latDeg);
  return (sx + sy) / 2;
}

// Raycast sample points for the height alignment: rings just inside the course rectangle,
// where tiles are still refined (the deep interior is masked) and the seam is.
export function perimeterSamples(rect, { insets = [25, 70], spacingM = 140 } = {}) {
  const out = [];
  for (const inset of insets) {
    const x0 = rect.minX + inset, x1 = rect.maxX - inset, y0 = rect.minY + inset, y1 = rect.maxY - inset;
    if (!(x1 > x0 && y1 > y0)) continue;
    const w = x1 - x0, h = y1 - y0, per = 2 * (w + h);
    const n = Math.max(4, Math.round(per / spacingM));
    const stagger = (inset * 0.37) % 1; // so the rings' samples don't line up
    for (let i = 0; i < n; i++) {
      let s = ((i + stagger) / n) * per;
      if (s < w) out.push([x0 + s, y0]);
      else if ((s -= w) < h) out.push([x1, y0 + s]);
      else if ((s -= h) < w) out.push([x1 - s, y1]);
      else out.push([x0, y1 - (s - w)]);
    }
  }
  return out;
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Keep samples on open ground in OUR data (no tree crown or building footprint nearby):
// a ray there most likely hits Google's ground too, not a canopy or a roof.
export function filterOpenGround(points, { trees = [], buildings = [], clearM = 4 } = {}) {
  const boxes = (buildings || []).filter((b) => b?.poly?.length >= 3).map((b) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of b.poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    return { poly: b.poly, minX, minY, maxX, maxY };
  });
  return (points || []).filter(([x, y]) => {
    for (const t of trees || []) {
      const r = (t.r || 5 * (t.s || 1)) + clearM;
      if ((t.x - x) ** 2 + (t.y - y) ** 2 < r * r) return false;
    }
    for (const b of boxes) {
      if (x >= b.minX - clearM && x <= b.maxX + clearM && y >= b.minY - clearM && y <= b.maxY + clearM && pointInPoly(x, y, b.poly)) return false;
    }
    return true;
  });
}

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Vertical offset (ours - Google) from raycast samples: the median of the dominant cluster.
// A ray that hits a tree crown or a roof reads Google HIGH (a low diff) and one through a
// hole in the mesh reads it low, so take the densest `windowM` band of diffs (ties go to
// the higher band — canopy hits only ever pull diffs down) and its median. null when there
// are too few samples or no band holds `minShare` of them (try again when more tiles load).
export function robustHeightOffset(diffs, { minSamples = 8, windowM = 2.5, minShare = 0.25 } = {}) {
  const v = (diffs || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < minSamples) return null;
  let bestLo = 0, bestHi = 0, bestCount = 0;
  for (let hi = 0, lo = 0; hi < v.length; hi++) {
    while (v[hi] - v[lo] > windowM) lo++;
    const count = hi - lo + 1;
    if (count >= bestCount) { bestCount = count; bestLo = lo; bestHi = hi; }
  }
  if (bestCount < Math.max(3, Math.ceil(minShare * v.length))) return null;
  return median(v.slice(bestLo, bestHi + 1));
}

// The tile data attributions (TilesRenderer.getAttributions()) as one display line.
export function attributionText(list) {
  return (list || [])
    .filter((a) => a && a.type === 'string' && typeof a.value === 'string' && a.value.trim())
    .map((a) => a.value.trim())
    .join('; ');
}

// ---------------------------------------------------------------------------
// Runtime

// Course-rectangle clip injected into every tile material (shared uniforms, one program).
const CLIP_FRAGMENT_HEAD = /* glsl */`
varying vec3 vBirdieWorld;
uniform vec4 uBirdieClip;      // course terrain rectangle, world XZ: (minX, minZ, maxX, maxZ)
uniform float uBirdieClipEdge; // dithered seam width (m) just inside it
float birdieBayer2(vec2 v) { return mod(3.0 * v.y + 2.0 * v.x, 4.0); }
float birdieBayer4(vec2 v) { return 4.0 * birdieBayer2(mod(v, 2.0)) + birdieBayer2(floor(0.5 * mod(v, 4.0))); }
`;
const CLIP_FRAGMENT_BODY = /* glsl */`
{
  vec2 birdieLo = vBirdieWorld.xz - uBirdieClip.xy;
  vec2 birdieHi = uBirdieClip.zw - vBirdieWorld.xz;
  float birdieIn = min(min(birdieLo.x, birdieLo.y), min(birdieHi.x, birdieHi.y)); // m inside (< 0: outside)
  if (birdieIn > 0.0) {
    float birdieK = birdieIn / max(uBirdieClipEdge, 1e-3); // 0 at the edge .. 1 a seam-width in
    float birdieT = (birdieBayer4(floor(mod(gl_FragCoord.xy, 4.0))) + 0.5) / 16.0;
    if (birdieT < birdieK) discard; // ordered dither: drop more of Google's fragments the deeper in
  }
}
`;

// Tiles whose bounding circle sits this far inside the rectangle are never loaded; keep it
// wider than the outer alignment ring so the samples there still see refined geometry.
const INTERIOR_MASK_MARGIN_M = 120;
const ALIGN_MIN_SAMPLES = 8;
const ALIGN_FINE_ERROR_M = 16;               // prefer hits on tiles at least this fine
const ALIGN_REFINE_AFTER_MS = [4000, 12000]; // re-measure as finer tiles arrive, then stop
const ALIGN_MAX_ATTEMPTS = 40;               // ~1 min of retries before giving up
const ALIGN_BUDGET_MS = 2.5;                 // raycast time per frame
const MAX_TILE_ERRORS = 40;

let tilesModules = null;
function loadTilesModules() {
  tilesModules ??= Promise.all([
    import('3d-tiles-renderer'),
    import('3d-tiles-renderer/plugins'),
    import('three/addons/loaders/DRACOLoader.js'),
  ]).then(([core, plugins, draco]) => ({ ...core, ...plugins, DRACOLoader: draco.DRACOLoader }));
  return tilesModules;
}

const errorText = (e) => String(e?.message || e || 'unknown error').slice(0, 200);

export class GoogleTiles {
  constructor(scene, { fetchConfig = null, search = null } = {}) {
    this.scene = scene;
    this.mode = { enabled: false, reason: 'pending' };
    this._geo = null;
    this._t = null;   // live tileset state for the current course
    this._token = 0;  // bumps on every course change: stale async builds bail out
    this._warned = new Set();
    this._attrib = null;
    this._ray = new THREE.Raycaster();
    this._ray.firstHitOnly = true;
    this._sphere = new THREE.Sphere();
    this._clip = {
      uBirdieClip: { value: new THREE.Vector4() },
      uBirdieClipEdge: { value: RENDER_CONFIG.googleTilesClipEdgeM ?? 6 },
    };
    const clip = this._clip;
    this._clipCompile = (shader) => {
      shader.uniforms.uBirdieClip = clip.uBirdieClip;
      shader.uniforms.uBirdieClipEdge = clip.uBirdieClipEdge;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBirdieWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n\tvBirdieWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${CLIP_FRAGMENT_HEAD}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CLIP_FRAGMENT_BODY}`);
    };
    const getConfig = fetchConfig || (() => fetch('/api/google-tiles-config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)));
    this.ready = Promise.resolve()
      .then(getConfig)
      .catch(() => null)
      .then((serverConfig) => {
        this.mode = googleTilesMode({
          serverConfig,
          search: search ?? globalThis.location?.search ?? '',
          enabledInConfig: RENDER_CONFIG.googleTiles !== false,
        });
        if (this.mode.enabled && this._geo && !this._t) this._build(this._geo);
      });
  }

  get shown() { return !!this._t?.shown; }

  // Course change hook (end of GolfScene.loadCourse). A rebuild of the same course (quality
  // change, HD readiness) keeps the live tileset and its session.
  setCourse(geo) {
    const prev = this._geo;
    this._geo = geo || null;
    if (this._t && geo && prev && sameCourse(prev, geo)) { this._grabOurScenery(this._t); return; }
    this._token += 1;
    this._disposeTiles();
    if (this.mode.enabled && geo) this._build(geo);
  }

  // Per-frame hook (GolfScene._frame, after the camera is placed, before rendering).
  update() {
    const t = this._t;
    if (!t) return;
    const sc = this.scene, now = performance.now();
    this._applyQuality(t);
    t.tiles.setResolutionFromRenderer(sc.camera, sc.renderer);
    sc.camera.updateMatrixWorld();
    t.anchor.updateMatrixWorld(true);
    t.tiles.update();
    if (this._t !== t) return; // a load failure tore it down mid-update
    this._alignStep(t, now);
    this._syncOurScenery(t);
    if (now >= t.nextAttributionAt) { t.nextAttributionAt = now + 250; this._updateAttribution(t); }
  }

  dispose() {
    this._token += 1;
    this._disposeTiles();
    this._attrib?.remove();
    this._attrib = null;
  }

  async _build(geo) {
    const token = this._token;
    const origin = geo.origin, rect = clipRectFromElevation(geo.elevation);
    if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lon) || !rect) {
      this._warnOnce('no-origin', 'Google 3D tiles skipped: this course has no geographic origin or terrain grid');
      return;
    }
    let M;
    try { M = await loadTilesModules(); } catch (e) {
      this._warnOnce('import', `Google 3D tiles off: could not load 3d-tiles-renderer (${errorText(e)})`);
      return;
    }
    if (token !== this._token || this._t) return; // course changed while the modules loaded
    try {
      this._createTileset(M, geo, origin, rect);
    } catch (e) {
      this._warnOnce('create', `Google 3D tiles off: ${errorText(e)}`);
      this._disposeTiles();
    }
  }

  _createTileset(M, geo, origin, rect) {
    const sc = this.scene;
    const tiles = new M.TilesRenderer(this.mode.rootUrl || GOOGLE_ROOT_URL);
    const t = this._t = {
      tiles, rect, anchor: new THREE.Group(), draco: null, level: null, shown: false, tileErrors: 0,
      apron: null, hidOurs: false, nextAttributionAt: 0, circles: new WeakMap(),
      rect3: { minX: rect.minX, minZ: -rect.maxY, maxX: rect.maxX, maxZ: -rect.minY },
      align: { run: null, attempts: 0, runs: 0, nextAt: 0, done: false, offset: null },
      samples: [],
    };
    // An LRU cache of our own (the library default is shared module state) — budgets below.
    const cache = new M.LRUCache();
    cache.unloadPriorityCallback = M.DEFAULT_LRU_CACHE.unloadPriorityCallback;
    tiles.lruCache = cache;

    tiles.registerPlugin(new M.GoogleCloudAuthPlugin({ apiToken: this.mode.apiKey, autoRefreshToken: true }));
    tiles.registerPlugin(new M.ReorientationPlugin({ lat: origin.lat * DEG, lon: origin.lon * DEG, height: 0, azimuth: Math.PI }));
    t.draco = new M.DRACOLoader().setDecoderPath(DRACO_DECODER_PATH);
    tiles.registerPlugin(new M.GLTFExtensionsPlugin({ dracoLoader: t.draco }));
    tiles.registerPlugin(new M.TilesFadePlugin());
    tiles.registerPlugin(this._coursePlugin(t));
    tiles.addEventListener('load-error', (e) => this._onLoadError(t, e));

    t.anchor.name = 'googleTiles';
    t.anchor.scale.setScalar(anchorScale(origin.lat));
    t.anchor.position.y = -(Number(geo.elevation?.baseM) || 0); // first guess; measured before showing
    t.anchor.visible = false;           // shown once lined up with our terrain
    t.anchor.userData.noAO = true;      // keep it out of the GTAO pre-pass (no clip there)
    t.anchor.add(tiles.group);
    sc.scene.add(t.anchor);
    tiles.setCamera(sc.camera);
    tiles.setResolutionFromRenderer(sc.camera, sc.renderer);
    this._clip.uBirdieClip.value.fromArray(clipUniformRect(rect));
    this._clip.uBirdieClipEdge.value = RENDER_CONFIG.googleTilesClipEdgeM ?? 6;
    this._applyQuality(t, true);

    const ring = perimeterSamples(rect);
    const open = filterOpenGround(ring, { trees: sc._placedTrees || [], buildings: geo.buildings || [] });
    t.samples = open.length >= 3 * ALIGN_MIN_SAMPLES ? open : ring;
    this._grabOurScenery(t);
    console.log(`[google-tiles] loading Google Photorealistic 3D Tiles around ${String(geo.name || 'the course').split(',')[0]}`);
    return t;
  }

  // Our own plugin: tile materials, interior masking, and a quiet root failure.
  _coursePlugin(t) {
    const self = this;
    const plugin = {
      name: 'OPEN_BIRDIE_COURSE_FIT',
      // A rejected key fails the root tileset request. Report it once, tear down cleanly and
      // keep rendering our own scenery (instead of the library's console.error).
      loadRootTileset() {
        const pending = t.tiles.invokeOnePlugin((p) => p !== plugin && p.loadRootTileset && p.loadRootTileset());
        return Promise.resolve(pending).catch((error) => {
          self._fail(t, `Google 3D tiles unavailable (${errorText(error)}) — check GOOGLE_MAPS_API_KEY: Map Tiles API enabled, billing on. Continuing without them.`);
          return new Promise(() => {}); // settle never: this tileset is already disposed
        });
      },
      processTileModel(model) {
        const converted = new Map();
        model.traverse((o) => {
          if (!o.isMesh) return;
          o.material = Array.isArray(o.material) ? o.material.map((m) => self._tileMaterial(m, converted)) : self._tileMaterial(o.material, converted);
          o.castShadow = false;
          o.receiveShadow = false;
        });
      },
      // Tiles wholly inside our course would be discarded fragment by fragment: never load them.
      calculateTileViewError(tile, target) {
        const c = self._tileCircle(t, tile);
        if (!c || !circleInsideRect(c.x, c.z, c.r, t.rect3, INTERIOR_MASK_MARGIN_M)) return false;
        target.inView = false;
        return true;
      },
    };
    return plugin;
  }

  // Photogrammetry carries its own baked light: draw it unlit (KHR_materials_unlit tiles
  // arrive as MeshBasicMaterial already), lifted to sit under the scene's ACES exposure,
  // fogged like everything else, and clipped out of the course rectangle.
  _tileMaterial(src, converted) {
    if (!src || src.userData?.openBirdieTile) return src;
    if (converted.has(src)) return converted.get(src);
    let m = src;
    if (!src.isMeshBasicMaterial) {
      m = new THREE.MeshBasicMaterial({
        map: src.map || null, vertexColors: !!src.vertexColors, side: src.side,
        transparent: !!src.transparent, opacity: src.opacity ?? 1, alphaTest: src.alphaTest || 0,
      });
      if (!src.map && src.color) m.color.copy(src.color);
      src.dispose();
    }
    m.color.multiplyScalar(RENDER_CONFIG.googleTilesGain ?? 1);
    m.fog = true;
    m.onBeforeCompile = this._clipCompile;
    m.customProgramCacheKey = () => 'open-birdie-google-tile-clip-v1';
    m.userData.openBirdieTile = true;
    m.needsUpdate = true;
    converted.set(src, m);
    return m;
  }

  // A tile's bounding circle in world XZ (the anchor's XZ transform never changes once the
  // root is placed, so it is cached per tile).
  _tileCircle(t, tile) {
    let c = t.circles.get(tile);
    if (c) return c;
    const bv = tile.engineData?.boundingVolume;
    if (!bv) return null;
    bv.getSphere(this._sphere);
    this._sphere.applyMatrix4(t.tiles.group.matrixWorld);
    c = { x: this._sphere.center.x, z: this._sphere.center.z, r: this._sphere.radius };
    t.circles.set(tile, c);
    return c;
  }

  _applyQuality(t, force = false) {
    const level = this.scene.quality?.level === 'low' ? 'low' : 'high';
    if (!force && level === t.level) return;
    t.level = level;
    const low = level === 'low';
    t.tiles.errorTarget = (RENDER_CONFIG.googleTilesErrorTarget ?? 20) * (low ? 1.5 : 1);
    const bytes = (RENDER_CONFIG.googleTilesCacheMB ?? 320) * (low ? 0.5 : 1) * 2 ** 20;
    const cache = t.tiles.lruCache;
    cache.maxBytesSize = bytes;
    cache.minBytesSize = 0.75 * bytes;
    cache.maxSize = low ? 1200 : 2400;
    cache.minSize = Math.round(0.75 * cache.maxSize);
  }

  // Measure the vertical offset between Google's mesh and our terrain: straight-down rays
  // at the sample points (time-sliced), robust median of (ours - Google). The first good
  // estimate shows the tiles; two later passes refine it as finer tiles load.
  _alignStep(t, now) {
    const a = t.align;
    if (a.done || now < a.nextAt || !t.tiles.root) return;
    if (!a.run) {
      if (!t.tiles.visibleTiles.size) { a.nextAt = now + 500; return; }
      a.run = { i: 0, all: [], fine: [] };
    }
    const run = a.run, ray = this._ray, y0 = t.anchor.position.y, stop = performance.now() + ALIGN_BUDGET_MS;
    while (run.i < t.samples.length && performance.now() < stop) {
      const [x, y] = t.samples[run.i++];
      ray.set(new THREE.Vector3(x, y0 + 9000, -y), new THREE.Vector3(0, -1, 0));
      ray.far = 20000;
      const hit = ray.intersectObject(t.tiles.group, true)[0];
      if (!hit) continue;
      const diff = this.scene.hAt(x, y) - (hit.point.y - y0);
      run.all.push(diff);
      const ge = hit.object?.userData?.tile?.geometricError;
      if (!(ge > ALIGN_FINE_ERROR_M)) run.fine.push(diff);
    }
    if (run.i < t.samples.length) return; // resume next frame
    a.run = null;
    a.attempts += 1;
    const pool = run.fine.length >= ALIGN_MIN_SAMPLES ? run.fine : run.all;
    const offset = robustHeightOffset(pool, { minSamples: ALIGN_MIN_SAMPLES });
    if (offset == null) {
      // too few hits yet (tiles still streaming in); the BVH walk can miss Google's loose
      // bounding volumes, so alternate it with brute-force raycasts
      if (run.all.length < ALIGN_MIN_SAMPLES) t.tiles.accelerateRaycast = !t.tiles.accelerateRaycast;
      if (a.attempts >= ALIGN_MAX_ATTEMPTS) {
        a.done = true;
        this._fail(t, 'could not line Google 3D tiles up with the course terrain — leaving them off for this course');
      } else {
        a.nextAt = now + 1500;
      }
      return;
    }
    t.anchor.position.y = offset;
    t.anchor.updateMatrixWorld(true);
    a.offset = offset;
    a.runs += 1;
    console.log(`[google-tiles] height offset ${offset.toFixed(2)} m from ${pool.length}/${t.samples.length} edge samples${t.shown ? ' (refined)' : ' — showing Google surroundings'}`);
    if (!t.shown) { t.shown = true; t.anchor.visible = true; }
    const delay = ALIGN_REFINE_AFTER_MS[a.runs - 1];
    if (delay == null) a.done = true; else a.nextAt = now + delay;
  }

  _grabOurScenery(t) {
    t.apron = this.scene.courseGroup?.getObjectByName('groundApron') || null;
    t.hidOurs = false; // re-apply to the (possibly rebuilt) apron
  }

  // Our countryside apron + horizon haze band stand in for the surroundings: hide them while
  // Google's real ones are on screen.
  _syncOurScenery(t) {
    const hide = t.shown;
    const haze = this.scene._haze?.mesh;
    if (t.hidOurs === hide && (!haze || haze.visible === !hide)) return;
    if (t.apron) t.apron.visible = !hide;
    if (haze) haze.visible = !hide;
    t.hidOurs = hide;
  }

  _onLoadError(t, e) {
    if (t !== this._t || !e?.tile) return; // root failures are reported by the course plugin
    t.tileErrors += 1;
    if (t.tileErrors === MAX_TILE_ERRORS) this._fail(t, `Google 3D tiles keep failing to load (${MAX_TILE_ERRORS} tile errors, last: ${errorText(e.error)}) — turning them off for this course`);
  }

  _fail(t, message) {
    if (t !== this._t) return;
    this._warnOnce(`fail:${this._token}`, message);
    this._disposeTiles();
  }

  _disposeTiles() {
    const t = this._t;
    this._t = null;
    this._showAttribution(false);
    if (!t) return;
    if (t.hidOurs) {
      if (t.apron) t.apron.visible = true;
      if (this.scene._haze?.mesh) this.scene._haze.mesh.visible = true;
    }
    try { t.tiles.dispose(); } catch (e) { /* already torn down */ }
    try { t.draco?.dispose(); } catch (e) { /* workers already gone */ }
    t.anchor.removeFromParent();
  }

  _updateAttribution(t) {
    if (!t.shown) { this._showAttribution(false); return; }
    this._showAttribution(true, attributionText(t.tiles.getAttributions()));
  }

  // Bottom-right of the 3D view, just above the bottom bar: "Surroundings: [Google Maps]
  // <data providers>" and, separately, our own "Course" credit (Map Tiles API policies:
  // Google logo + full data attribution, and make clear which parts are Google's).
  _showAttribution(on, text = '') {
    if (typeof document === 'undefined') return;
    if (!on) { if (this._attrib) this._attrib.hidden = true; return; }
    if (!this._attrib) {
      const root = document.createElement('div');
      root.className = 'gt-attrib';
      root.setAttribute('role', 'contentinfo');
      root.setAttribute('aria-label', 'Map data attribution');
      root.title = 'Click to show the full data sources';
      const google = Object.assign(document.createElement('span'), { className: 'gt-google' });
      const label = Object.assign(document.createElement('span'), { className: 'gt-label', textContent: 'Surroundings:' });
      let logo;
      if (this.mode.logoUrl) {
        logo = Object.assign(document.createElement('img'), { className: 'gt-logo', src: this.mode.logoUrl, alt: 'Google Maps' });
      } else {
        // the policy allows the words "Google Maps" in place of the logo; drop the official
        // logo at public/assets/attribution/google-maps-logo.svg to use it instead
        logo = Object.assign(document.createElement('span'), { className: 'gt-wordmark', textContent: 'Google Maps' });
        logo.setAttribute('role', 'img');
        logo.setAttribute('aria-label', 'Google Maps');
      }
      const data = Object.assign(document.createElement('span'), { className: 'gt-data' });
      google.append(label, logo, data);
      const ours = Object.assign(document.createElement('span'), { className: 'gt-ours', textContent: 'Course: © OpenStreetMap contributors · USGS' });
      root.append(google, ours);
      root.addEventListener('click', () => root.classList.toggle('expanded'));
      document.body.appendChild(root);
      this._attrib = root;
    }
    const data = this._attrib.querySelector('.gt-data');
    if (data.textContent !== text) { data.textContent = text; data.title = text; }
    this._attrib.hidden = false;
  }

  _warnOnce(key, message) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(`[google-tiles] ${message}`);
  }
}

function sameCourse(a, b) {
  if (a === b) return true;
  const ra = clipRectFromElevation(a.elevation), rb = clipRectFromElevation(b.elevation);
  return a.courseId != null && a.courseId === b.courseId && a.courseRevision === b.courseRevision
    && a.origin?.lat === b.origin?.lat && a.origin?.lon === b.origin?.lon
    && !!ra && !!rb && ra.minX === rb.minX && ra.minY === rb.minY && ra.maxX === rb.maxX && ra.maxY === rb.maxY;
}
