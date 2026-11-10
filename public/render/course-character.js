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

// Dormant fescue: a links in a dry summer or in winter is not olive but straw-gold on its
// mown ground too (Bandon's fairways in the reference photos, the Old Course's pale
// yellow-green). 0 = the mown ground keeps the dry palette's cool olive (Chambers Bay,
// measured from its own photos), 1 = fully dormant straw. Greens stay green: they are
// watered and a different grass.
export const DORMANT_PALETTE = {
  fairwayA: '#8e8a48', fairwayB: '#827e42',   // straw-olive mown fescue
  tee: '#8a8846',
  range: '#9a9550',
};
export const COURSE_DORMANT = {
  'Bandon Dunes Golf Resort': 0.55,
  'St Andrews Old Course': 0.3,
};

// How much tall fescue the open ground grows, 0..1, where it is not what the course's
// dryness alone says (dry 0.4 -> none, 0.8 -> all of it). The Old Course is dry links
// turf but mown or grazed short almost everywhere between its gorse: at the dryness
// rule's 0.75 the 1st and 18th stood knee-deep in a field of straw.
export const COURSE_FESCUE = {
  'St Andrews Old Course': 0.12,
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
  // Hazeltine is oak country (bur and red oaks, maples between; few conifers, no birch
  // stands), and Pebble Beach is Monterey pine and cypress with coast live oak
  'Hazeltine National Golf Club': [0.62, 0.06, 0.04, 0.02, 0.26],
  'Pebble Beach Golf Links': [0.25, 0.75, 0, 0, 0],
};

// WHICH COURSE IT IS. A course's name is whatever it was asked for by: the picker's
// featured list says "Old Course at St Andrews" and "Bandon Dunes", courses/featured.json
// "Old Course, St Andrews" and "Bandon Dunes Golf Resort", a map search something else
// again. Keyed by name alone, St Andrews and Bandon matched nothing from the picker and
// drew as lush parkland. The course's OpenStreetMap id never changes, so it is tried
// first (geo.courseId / course.source.courseId), then the name and its other spellings.
// Mirrored in lib/tree-obstacles.js (tested).
export const COURSE_IDS = {
  'osm:way:26787026': 'Chambers Bay',
  'osm:relation:1783123': 'TPC Sawgrass',
  'osm:way:1019045811': 'St Andrews Old Course',
  'osm:way:362513477': 'Bandon Dunes Golf Resort',
  'osm:way:205111637': 'Whistling Straits',
  'osm:relation:9892305': 'Hazeltine National Golf Club',
  'osm:relation:3741806': 'Pebble Beach Golf Links',
  'osm:way:35679036': 'Torrey Pines Golf Course (South)',
  'osm:way:78388948': 'TPC Scottsdale (Stadium Course)',
  'osm:relation:17647608': 'Kiawah Island Golf Resort (Ocean Course)',
  'osm:way:871993734': 'Augusta National Golf Club',
  'osm:way:1481448305': 'Augusta National Par 3 Course',
  'osm:way:689056680': 'Shinnecock Hills Golf Club',
  'osm:relation:6174192': 'Oakmont Country Club',
  'osm:relation:4813858': 'Harbour Town Golf Links',
  'osm:way:281477606': 'Spyglass Hill Golf Course',
};
export const COURSE_ALIASES = {
  'Old Course': 'St Andrews Old Course',
  'Old Course at St Andrews': 'St Andrews Old Course',
  'Bandon Dunes': 'Bandon Dunes Golf Resort',
  'Pebble Beach': 'Pebble Beach Golf Links',
  'Hazeltine National': 'Hazeltine National Golf Club',
};

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
const courseKey = (name) => String(name ?? '').split(',')[0].trim().toLowerCase();
const ALIAS_BY_KEY = new Map(Object.entries(COURSE_ALIASES).map(([k, v]) => [courseKey(k), courseKey(v)]));
// the key a course's character is filed under: by id, else by name or one of its spellings
const characterKey = (name, courseId) => {
  const byId = courseId != null ? COURSE_IDS[String(courseId)] : null;
  if (byId) return courseKey(byId);
  const k = courseKey(name);
  return ALIAS_BY_KEY.get(k) || k;
};
const DRY_BY_KEY = new Map(Object.entries(COURSE_DRY).map(([k, v]) => [courseKey(k), v]));

const FLORA_BY_KEY = new Map(Object.entries(COURSE_FLORA).map(([k, v]) => [courseKey(k), v]));
// A course's flora weights, or null for the default mix.
export function floraFor(name, courseId = null) {
  return FLORA_BY_KEY.get(characterKey(name, courseId)) || null;
}

const DORMANT_BY_KEY = new Map(Object.entries(COURSE_DORMANT).map(([k, v]) => [courseKey(k), v]));
const FESCUE_BY_KEY = new Map(Object.entries(COURSE_FESCUE).map(([k, v]) => [courseKey(k), v]));
// How dormant a course's mown fescue is, 0 (none) for unknown/missing.
export function dormantFor(name, courseId = null) {
  return clamp01(DORMANT_BY_KEY.get(characterKey(name, courseId)));
}
// How much of its open ground grows tall fescue: the course's own figure, else by dryness.
export function fescueFor(name, courseId = null) {
  const own = FESCUE_BY_KEY.get(characterKey(name, courseId));
  if (Number.isFinite(own)) return clamp01(own);
  return clamp01((courseDryFor(name, courseId) - 0.4) / 0.4);
}

// Dryness for a course — clamped to [0,1], 0 (lush) for unknown/missing.
export function courseDryFor(name, courseId = null) {
  return clamp01(DRY_BY_KEY.get(characterKey(name, courseId)));
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

// Pull the mown zones of a palette toward dormant straw by t (after blendPalette). t = 0
// returns the palette as it came; greens, rough, sand and water are never touched.
export function blendDormant(pal, t) {
  t = clamp01(t);
  if (t === 0) return pal;
  const out = { ...pal };
  for (const k of Object.keys(DORMANT_PALETTE)) out[k] = lerpHex(pal[k], DORMANT_PALETTE[k], t);
  return out;
}
