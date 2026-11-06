// Tree placement: where trees stand and which species. Pure (no three, no DOM) so
// the woods fill is unit-tested (test/tree-placement.test.mjs).
//
// OSM gives two kinds of tree data: individual `trees` (points) and `woods`
// (polygons). The old renderer dropped a tree every 18 m inside woods — a sparse
// orchard. Woods are now FILLED: a dense tree line along the polygon edge (the
// face the golfer sees), then a jittered interior fill, with species grouped into
// natural stands by low-frequency noise instead of per-tree salt-and-pepper.

export const SPECIES = Object.freeze(['oak', 'pine', 'fir', 'birch', 'maple']);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distToPolyEdge(x, y, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    d = Math.min(d, distToSegment(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
  }
  return d;
}

// smooth 2D value noise for species stands
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// Species for a spot: stands of ~60-120 m share a species. Links (dry) courses
// lean to pines and birch; parkland to oaks, maples and firs. A course with its own
// flora (course-character.js COURSE_FLORA: weights over SPECIES) draws from that.
export function speciesAt(x, y, courseDry = 0, salt = 0, flora = null) {
  const n = vnoise(x * 0.011 + 3.3, y * 0.011 - 1.7);
  const j = hash2(x * 0.37 + salt, y * 0.41 - salt) * 0.14 - 0.07;   // a few mixed-in strays
  const v = Math.min(0.999, Math.max(0, n + j));
  if (flora) {
    const tot = flora.reduce((a, b) => a + b, 0) || 1;
    let acc = 0, last = SPECIES[0];
    for (let k = 0; k < SPECIES.length; k++) {
      if (!(flora[k] > 0)) continue;
      acc += flora[k] / tot; last = SPECIES[k];
      if (v < acc) return SPECIES[k];
    }
    return last;
  }
  const dry = Math.min(1, Math.max(0, courseDry));
  // cumulative weights [oak, pine, fir, birch, maple], blended lush -> dry
  const lush = [0.32, 0.16, 0.22, 0.06, 0.24];
  const links = [0.2, 0.44, 0.14, 0.14, 0.08];
  let acc = 0;
  for (let k = 0; k < SPECIES.length; k++) {
    acc += lush[k] + (links[k] - lush[k]) * dry;
    if (v < acc) return SPECIES[k];
  }
  return SPECIES[SPECIES.length - 1];
}

// Fill one woods polygon. spacing (m) is the interior grid pitch; the edge line is
// ~0.7x denser. Returns [{x, y, s, edge}] (s = size multiplier).
export function fillWoods(poly, { spacing = 7.5, seed = 1, blocked = null } = {}) {
  if (!poly || poly.length < 3) return [];
  const rnd = mulberry32(seed);
  const out = [];
  const ok = (x, y) => !(blocked && blocked(x, y));
  // 1) edge tree line: walk the boundary, stepping ~0.7*spacing, set 1-3.5 m inside
  const edgeStep = spacing * 0.7;
  let cx = 0, cy = 0;
  for (const [x, y] of poly) { cx += x; cy += y; }
  cx /= poly.length; cy /= poly.length;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], ay = poly[j][1], bx = poly[i][0], by = poly[i][1];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    const n = Math.max(1, Math.round(L / edgeStep));
    // inward normal: whichever side the polygon interior is on
    let nx = -(by - ay) / L, ny = (bx - ax) / L;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    if (!pointInPoly(mx + nx * 0.5, my + ny * 0.5, poly)) { nx = -nx; ny = -ny; }
    for (let k = 0; k < n; k++) {
      const t = (k + 0.2 + rnd() * 0.6) / n;
      const inset = 1.0 + rnd() * 2.5;
      const x = ax + (bx - ax) * t + nx * inset, y = ay + (by - ay) * t + ny * inset;
      if (pointInPoly(x, y, poly) && ok(x, y)) out.push({ x, y, s: 0.95 + rnd() * 0.45, edge: true });
    }
  }
  // 2) interior: jittered grid, skipping the band the edge line already occupies
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let gy = minY + spacing * 0.5; gy < maxY; gy += spacing) {
    for (let gx = minX + spacing * 0.5; gx < maxX; gx += spacing) {
      const x = gx + (rnd() - 0.5) * spacing * 0.9, y = gy + (rnd() - 0.5) * spacing * 0.9;
      if (!pointInPoly(x, y, poly) || !ok(x, y)) continue;
      if (distToPolyEdge(x, y, poly) < spacing * 0.55) continue;
      out.push({ x, y, s: 0.8 + rnd() * 0.6, edge: false });
    }
  }
  return out;
}

// Species from a real crown's shape: narrow, tall crowns read as conifers and broad
// ones as broadleaves. Within each, stands still cluster by the same noise as
// speciesAt, so neighbours mostly match.
// On a course with its own flora the stand decides: measured crown radii are coarse
// (most read ~4 m), and an open-grown loblolly is as broad as an oak; only a crown
// much narrower than its height is taken for the course's conifer.
export function speciesForCrown(x, y, h, r, courseDry = 0, flora = null) {
  const ratio = r / Math.max(1, h);
  const stand = speciesAt(x, y, courseDry, 0, flora);
  if (flora) {
    if (ratio < 0.18 && stand !== 'pine' && stand !== 'fir' && (flora[1] > 0 || flora[2] > 0)) return flora[1] >= flora[2] ? 'pine' : 'fir';
    return stand;
  }
  if (ratio < 0.22) return courseDry > 0.5 || stand === 'pine' ? 'pine' : 'fir';
  if (ratio < 0.3) return stand === 'pine' || stand === 'fir' || stand === 'maple' ? stand : 'oak';
  return stand === 'birch' || stand === 'maple' ? stand : 'oak';
}

// Meta & WRI's canopy height map (course.canopy) is learned from satellite photos and
// regresses toward the middle: it runs low on tall trees, so Augusta's 30 m pines
// come out ~22 m and a tree line reads as hedge. Heights over 8 m are stretched by
// CANOPY_TALL_STRETCH (a 20 m reading -> 24 m). Mirrored in lib/tree-obstacles.js.
export const CANOPY_TALL_STRETCH = 0.35;
export function canopyHeight(h) {
  return h > 8 ? 8 + (h - 8) * (1 + CANOPY_TALL_STRETCH) : h;
}

// Instance scale for a real tree of height h and crown radius r, given the species
// model's height and crown radius at scale 1. Width follows the crown but stays
// within a plausible ratio of the height so a noisy radius never squashes a model.
// a, b in [0, 1) add a few percent of variation.
export function realTreeSize({ h, r }, modelH, modelCrownR, a = 0.5, b = 0.5) {
  const ht = (h / modelH) * (0.95 + a * 0.1);
  const fromCrown = r > 0 && modelCrownR > 0 ? r / modelCrownR : ht;
  const w = Math.min(ht * 1.6, Math.max(ht * 0.55, fromCrown)) * (0.94 + b * 0.12);
  return { w, ht };
}

// Real trees within this distance of a hole line are the ones a golfer walks past:
// they get contact shadows and litter, like OSM trees and woods edges.
const NEAR_PLAY_M = 60;
const PAR3_CLEAR_M = 3;      // par3LineBlock: a crown this close to a par 3's tee-to-pin line
const OSM_CROWN_M = 3;       // the crown a point tree (no measured crown) is taken to have

// A par 3's shot is the line from the tee to the pin, and no tree stands in it: a tree
// whose crown comes within PAR3_CLEAR_M of that line is not drawn and not an obstacle
// (public/render/tree-placement.js par3LineBlock and lib/tree-obstacles.js, kept the
// same by a test). Canopy data can predate a hole: Augusta's Par 3 Course re-routed
// holes 1-5 in 2023, and a tree stood a few metres in front of the 4th tee, stopping
// every wedge. Fairways already keep trees off longer holes' lines.
export function par3LineBlock(holes) {
  const lines = (holes || []).filter((h) => h && h.par === 3 && Array.isArray(h.tee) && Array.isArray(h.pin))
    .map((h) => [h.tee[0], h.tee[1], h.pin[0], h.pin[1]]);
  return (x, y, r = OSM_CROWN_M) => {
    const reach = PAR3_CLEAR_M + (r > 0 ? r : OSM_CROWN_M);
    for (const [ax, ay, bx, by] of lines) if (distToSegment(x, y, ax, ay, bx, by) < reach) return true;
    return false;
  };
}

// All course tree spots, prioritised under a cap: explicit OSM trees, then every
// woods EDGE tree (the visible faces), then interior trees nearest the holes.
// holeLines: [[x,y],...][] used to rank interior trees; courseDry picks species.
// canopy: real trees [[x, y, heightM, crownRadiusM], ...] (course.canopy, from canopy
// height data). When present they replace the woods fill, which only guesses where
// trees stand; OSM tree points are kept only where no real tree is within 3 m.
export function placeCourseTrees({ trees = [], woods = [], holeLines = [], cap = 9000, density = 1, courseDry = 0, blocked = null, canopy = null, flora = null } = {}) {
  const spacing = 7.5 / Math.sqrt(Math.max(0.15, density));
  const rnd = mulberry32(1234);
  const lineDist = (p) => {
    let d = Infinity;
    for (const line of holeLines) {
      for (let i = 1; i < (line || []).length; i++) {
        d = Math.min(d, distToSegment(p.x, p.y, line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]));
      }
    }
    return d;
  };
  if (canopy && canopy.length) return placeRealTrees({ canopy, trees, holeLines, cap, courseDry, blocked, rnd, lineDist, flora });
  const explicit = trees.map(([x, y]) => ({ x, y, s: 0.85 + rnd() * 0.5, edge: true }));
  const edge = [], interior = [];
  woods.forEach((w, k) => {
    for (const p of fillWoods(w, { spacing, seed: 7919 * (k + 1), blocked })) (p.edge ? edge : interior).push(p);
  });
  if (interior.length && holeLines.length) {
    for (const p of interior) p.d = lineDist(p);
    interior.sort((a, b) => a.d - b.d);
  }
  const all = [...explicit, ...edge, ...interior].slice(0, Math.max(0, cap));
  for (const p of all) {
    p.species = speciesAt(p.x, p.y, courseDry, 0, flora);
    delete p.d;
  }
  return all;
}

function placeRealTrees({ canopy, trees, holeLines, cap, courseDry, blocked, rnd, lineDist, flora }) {
  const real = [];
  const cells = new Map(); // 3 m hash grid for the OSM de-duplication
  const cellKey = (cx, cy) => `${cx},${cy}`;
  for (const [x, y, h, r] of canopy) {
    if (!(h > 0) || (blocked && blocked(x, y, r))) continue;
    const p = { x, y, h: canopyHeight(h), r, s: 1 };
    real.push(p);
    const k = cellKey(Math.floor(x / 3), Math.floor(y / 3));
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(p);
  }
  const nearReal = (x, y) => {
    const cx = Math.floor(x / 3), cy = Math.floor(y / 3);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const p of cells.get(cellKey(cx + dx, cy + dy)) || []) if (Math.hypot(p.x - x, p.y - y) < 3) return true;
      }
    }
    return false;
  };
  const explicit = trees
    .filter(([x, y]) => !nearReal(x, y) && !(blocked && blocked(x, y)))
    .map(([x, y]) => ({ x, y, s: 0.85 + rnd() * 0.5 }));
  const all = [...real, ...explicit];
  for (const p of all) p.d = holeLines.length ? lineDist(p) : 0;
  all.sort((a, b) => a.d - b.d);
  const kept = all.slice(0, Math.max(0, cap));
  for (const p of kept) {
    p.edge = p.d <= NEAR_PLAY_M;
    p.species = p.h ? speciesForCrown(p.x, p.y, p.h, p.r, courseDry, flora) : speciesAt(p.x, p.y, courseDry, 0, flora);
    delete p.d;
  }
  return kept;
}
