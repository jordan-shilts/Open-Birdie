// Course character: one manual per-course "dryness" scalar (0 = lush green
// parkland, 1 = firm tan-gold links) that drives the turf palette + shader.
//
// WHY a client-side map (not a course-JSON field): a courseDry field on the
// course object is silently dropped in transit — courseGeometry() (server.js)
// and loadCourse() (lib/course.js) both return fixed field allow-lists, and old
// caches would lack it until re-fetch. A map keyed by course name lives entirely
// client-side, never touches the cache / server payload / courseFingerprint.
//
// The palette (COLORS) lives here — not in scene.js — so both scene.js and this
// module's blender share one source of truth with no circular import.

// Surfaces separated by VALUE (dark rough -> light fairway -> lighter green) so
// the hole reads as a golf hole, not one flat carpet, while staying muted enough
// that the regraded lighting doesn't push them neon. THIS IS THE LUSH PALETTE.
// 2026-11 visual pass: real turf albedo sits olive to yellow-green (green about twice the
// red in linear light, not four times), so the old kelly/lime values read as astroturf
// and made the tee boxes glow. Same value ladder, pulled toward olive; tees are cut
// fairway grass, so they now sit in the fairway family instead of above it.
export const COLORS = {
  base: '#3e5f2d',  // lusher corridor/base (much of the visible play ground is unlabeled base)
  rough: '#476d31', // lush green rough (Augusta second cut) — deeper than the fairway
  wood: '#2b4124',
  range: '#4f7c37',
  fairwayA: '#5a8c3b', fairwayB: '#518236', // lush fairway (mow stripes added in shader)
  // Greens: muted since material-first (v25) — the splat is the ACTUAL albedo, not a
  // 10% residue under the photo drape. The color stays in the fairway family.
  greenA: '#4f8a3c', greenB: '#477f36',
  tee: '#558539',
  bunker: '#cbb583',
  water: '#2f6d97',
};

// Dry tan-links targets (from reference/chambers-bay/CATALOG.md). Only the GRASS
// zones get a dry target — greens stay green, sand is greige via makeSandMaterial,
// water/wood are unchanged. Non-grass keys are omitted (pinned to lush by the blend).
export const DRY_PALETTE = {
  base: '#a2914f',     // dry fescue base — tan, the dominant off-fairway ground
  rough: '#c0a666',    // gold-tan fescue rough — should DOMINATE the frame
  range: '#8f9a54',
  fairwayA: '#5e7d3d', fairwayB: '#54703a', // cool olive mown fairway
  tee: '#6a8544',
};

// Only these palette keys blend toward DRY_PALETTE. Everything else (greenA/B,
// wood, bunker, water) stays at the lush value at every courseDry.
export const BLEND_KEYS = ['base', 'rough', 'range', 'fairwayA', 'fairwayB', 'tee'];

// Manual per-course dryness, keyed by the course's own name: the part of `name` before
// its first comma (loadCourse can carry a full address after it). Auto-detection was
// tried from the aerial's colour (dry grass reflects little blue), but the photos'
// season decides it as much as the grass: Hazeltine's HD photos read as yellow as
// Bandon's.
export const COURSE_DRY = {
  'Chambers Bay': 0.85,
  'TPC Sawgrass': 0.0,
  'St Andrews Old Course': 0.7,
  'Bandon Dunes Golf Resort': 0.8,
  'Whistling Straits': 0.75,
  // added with the courses built 2026-11-04: links and sandy seaside courses lean tan,
  // desert target golf half way (green corridors, desert round them), parkland lush
  'Torrey Pines Golf Course (South)': 0.3,
  'TPC Scottsdale (Stadium Course)': 0.5,
  'Kiawah Island Golf Resort (Ocean Course)': 0.55,
  'Augusta National Golf Club': 0.0,
  'Shinnecock Hills Golf Club': 0.75,
  'Oakmont Country Club': 0.1,
  'Harbour Town Golf Links': 0.0,
  'Spyglass Hill Golf Course': 0.25,
};

// Course flora: the tree species that stand on a course, as weights over
// tree-placement.js SPECIES [oak, pine, fir, birch, maple]. Courses not listed use the
// default mix (Upper-Midwest parkland blended toward links pines by dryness). Listed
// courses are the ones whose trees are part of the place: Augusta's tall loblolly
// pines (no birch or spruce in Georgia), Lowcountry live oaks and pines, Monterey
// pines and coast live oaks, Torrey pines. Mirrored in lib/tree-obstacles.js (tested).
export const COURSE_FLORA = {
  'Augusta National Golf Club': [0.24, 0.68, 0, 0, 0.08],
  'Augusta National Par 3 Course': [0.24, 0.68, 0, 0, 0.08],
  'Harbour Town Golf Links': [0.62, 0.38, 0, 0, 0],
  'Kiawah Island Golf Resort (Ocean Course)': [0.55, 0.45, 0, 0, 0],
  'Spyglass Hill Golf Course': [0.2, 0.8, 0, 0, 0],
  'Torrey Pines Golf Course (South)': [0.3, 0.7, 0, 0, 0],
  'TPC Scottsdale (Stadium Course)': [0.8, 0.2, 0, 0, 0],
  'TPC Sawgrass': [0.45, 0.55, 0, 0, 0],
  'Oakmont Country Club': [0.5, 0.15, 0.05, 0, 0.3],
  'Shinnecock Hills Golf Club': [0.55, 0.4, 0, 0, 0.05],
};

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
const courseKey = (name) => String(name ?? '').split(',')[0].trim().toLowerCase();
const DRY_BY_KEY = new Map(Object.entries(COURSE_DRY).map(([k, v]) => [courseKey(k), v]));

const FLORA_BY_KEY = new Map(Object.entries(COURSE_FLORA).map(([k, v]) => [String(k).split(',')[0].trim().toLowerCase(), v]));
// A course's flora weights, or null for the default mix.
export function floraFor(name) {
  return FLORA_BY_KEY.get(String(name ?? '').split(',')[0].trim().toLowerCase()) || null;
}

// Dryness for a course name — clamped to [0,1], 0 (lush) for unknown/missing.
export function courseDryFor(name) {
  return clamp01(DRY_BY_KEY.get(courseKey(name)));
}

const H = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const hex2 = (n) => Math.round(n).toString(16).padStart(2, '0');
const lerpHex = (a, b, t) => { const A = H(a), B = H(b); return '#' + hex2(A[0] + (B[0] - A[0]) * t) + hex2(A[1] + (B[1] - A[1]) * t) + hex2(A[2] + (B[2] - A[2]) * t); };

// Blend the lush palette toward the dry one by t. Grass zones (BLEND_KEYS)
// interpolate; all other keys stay lush. t=0 returns a byte-identical copy of
// lush (no lush-course regression); t=1 returns the exact dry targets.
export function blendPalette(lush, dry, t) {
  t = clamp01(t);
  const out = { ...lush };
  if (t === 0) return out;
  for (const k of BLEND_KEYS) out[k] = (t === 1) ? dry[k] : lerpHex(lush[k], dry[k], t);
  return out;
}
