// Tree placement: where trees stand and which species. Pure (no three, no DOM) so
// the woods fill is unit-tested (test/tree-placement.test.mjs).
//
// OSM gives two kinds of tree data: individual `trees` (points) and `woods`
// (polygons). The old renderer dropped a tree every 18 m inside woods — a sparse
// orchard. Woods are now FILLED: a dense tree line along the polygon edge (the
// face the golfer sees), then a jittered interior fill, with species grouped into
// natural stands by low-frequency noise instead of per-tree salt-and-pepper.

export const SPECIES = Object.freeze(['oak', 'pine', 'fir', 'birch']);

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
// lean to pines and birch; parkland to oaks and firs.
export function speciesAt(x, y, courseDry = 0, salt = 0) {
  const n = vnoise(x * 0.011 + 3.3, y * 0.011 - 1.7);
  const j = hash2(x * 0.37 + salt, y * 0.41 - salt) * 0.22 - 0.11;   // a few mixed-in strays
  const v = Math.min(0.999, Math.max(0, n + j));
  const dry = Math.min(1, Math.max(0, courseDry));
  // cumulative weights [oak, pine, fir, birch], blended lush -> dry
  const lush = [0.42, 0.20, 0.28, 0.10];
  const links = [0.22, 0.46, 0.16, 0.16];
  let acc = 0;
  for (let k = 0; k < 4; k++) {
    acc += lush[k] + (links[k] - lush[k]) * dry;
    if (v < acc) return SPECIES[k];
  }
  return SPECIES[3];
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

// All course tree spots, prioritised under a cap: explicit OSM trees, then every
// woods EDGE tree (the visible faces), then interior trees nearest the holes.
// holeLines: [[x,y],...][] used to rank interior trees; courseDry picks species.
export function placeCourseTrees({ trees = [], woods = [], holeLines = [], cap = 9000, density = 1, courseDry = 0, blocked = null } = {}) {
  const spacing = 7.5 / Math.sqrt(Math.max(0.15, density));
  const rnd = mulberry32(1234);
  const explicit = trees.map(([x, y]) => ({ x, y, s: 0.85 + rnd() * 0.5, edge: true }));
  const edge = [], interior = [];
  woods.forEach((w, k) => {
    for (const p of fillWoods(w, { spacing, seed: 7919 * (k + 1), blocked })) (p.edge ? edge : interior).push(p);
  });
  const lineDist = (p) => {
    let d = Infinity;
    for (const line of holeLines) {
      for (let i = 1; i < (line || []).length; i++) {
        d = Math.min(d, distToSegment(p.x, p.y, line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]));
      }
    }
    return d;
  };
  if (interior.length && holeLines.length) {
    for (const p of interior) p.d = lineDist(p);
    interior.sort((a, b) => a.d - b.d);
  }
  const all = [...explicit, ...edge, ...interior].slice(0, Math.max(0, cap));
  for (const p of all) {
    p.species = speciesAt(p.x, p.y, courseDry, 0);
    delete p.d;
  }
  return all;
}
