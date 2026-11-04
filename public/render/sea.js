// The sea, or a great lake, round a coastal course, read from the terrain itself.
// OpenStreetMap draws a coast as a line, not an area, so no course file carries the
// sea, and the game drew Carmel Bay and Lake Michigan as grass under haze. But lidar
// elevation (USGS 3DEP and the like) is hydro-flattened: open water is stored as one
// level, or a thin band of survey noise round it where the scan met the surf, so the
// lowest dense band of heights is the water line. The sea is everything at or below
// it that the edge of the grid reaches, outside the course's own ponds (they have
// their own water); and only when it is big, its band narrow, and none of the course's
// tees, fairways or greens lie under it (a grid of flat no-data is not a sea).
// The carved floor is render-only, like the pond beds: physics keeps the lidar surface.
// But the sea itself plays as water (lib/course.js makeSurfaceLookup requires this file,
// and grid-repair.js, so it finds the same sea). Pure (no three, no DOM): unit-tested
// (test/sea.test.mjs), and nothing here may import the browser's modules.
import { pointInPoly } from './water-shore.js';

const BIN_M = 0.1;    // height histogram bins
const SCAN_M = 6;     // how far above the grid's lowest point the water line can be

// The cells of a grid inside any pond's outline.
function pondCells({ nx, ny, minX, minY, cellM }, ponds) {
  const out = new Uint8Array(nx * ny);
  for (const p of ponds) {
    const i0 = Math.max(0, Math.floor((p.minX - minX) / cellM)), i1 = Math.min(nx - 1, Math.ceil((p.maxX - minX) / cellM));
    const j0 = Math.max(0, Math.floor((p.minY - minY) / cellM)), j1 = Math.min(ny - 1, Math.ceil((p.maxY - minY) / cellM));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) if (pointInPoly(minX + i * cellM, minY + j * cellM, p.poly)) out[j * nx + i] = 1;
    }
  }
  return out;
}

// Metres from each sea cell's centre to the nearest land cell's (0 on land): a two-pass
// chamfer distance, within a few percent of the straight-line one.
export function distanceToLand(mask, nx, ny, cellM) {
  const INF = 1e9, D = Math.SQRT2;
  const d = new Float32Array(nx * ny);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] ? INF : 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!d[k]) continue;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + 1);
      if (j > 0) {
        v = Math.min(v, d[k - nx] + 1);
        if (i > 0) v = Math.min(v, d[k - nx - 1] + D);
        if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + D);
      }
      d[k] = v;
    }
  }
  for (let j = ny - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (!d[k]) continue;
      let v = d[k];
      if (i < nx - 1) v = Math.min(v, d[k + 1] + 1);
      if (j < ny - 1) {
        v = Math.min(v, d[k + nx] + 1);
        if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + D);
        if (i > 0) v = Math.min(v, d[k + nx - 1] + D);
      }
      d[k] = v;
    }
  }
  for (let k = 0; k < d.length; k++) if (d[k]) d[k] = d[k] >= INF ? INF : d[k] * cellM;
  return d;
}

// The points findSea keeps the sea off: every vertex of the tees, fairways and greens.
export function playPoints(surfaces) {
  const out = [];
  for (const s of surfaces || []) {
    if ((s.kind === 'tee' || s.kind === 'fairway' || s.kind === 'green') && Array.isArray(s.poly)) out.push(...s.poly);
  }
  return out;
}

// grid: { nx, ny, cellM, minX, minY, heights } (the elevation grid; row j at
// y = minY + j * cellM); ponds: water-shore.js coursePonds; play: playPoints.
// -> { level, mask (Uint8Array, 1 = sea), shoreM (Float32Array: metres to land), frac,
//      nx, ny, minX, minY, cellM } or null when there is no sea.
export function findSea(grid, {
  ponds = [], play = [], minFrac = 0.02, denseFrac = 0.003, maxBandM = 2, marginM = 0.05, maxPlayFrac = 0.03,
} = {}) {
  const { nx, ny, cellM, minX, minY, heights: H } = grid || {};
  const n = nx * ny;
  if (!H || !(n >= 16) || H.length < n) return null;
  const pond = pondCells(grid, ponds);
  let lo = Infinity;
  for (let k = 0; k < n; k++) if (!pond[k] && H[k] < lo) lo = H[k];
  if (!Number.isFinite(lo)) return null;
  // the water line: the top of the lowest dense band of heights (a thin bin allowed
  // inside it), and the band is narrow: water, not a flat stretch of land
  const bins = new Uint32Array(Math.ceil(SCAN_M / BIN_M));
  for (let k = 0; k < n; k++) {
    if (pond[k]) continue;
    const b = Math.floor((H[k] - lo) / BIN_M);
    if (b < bins.length) bins[b]++;
  }
  const dense = Math.max(1, denseFrac * n);
  let b0 = 0;
  while (b0 < bins.length && bins[b0] < dense) b0++;
  if (b0 >= bins.length) return null;
  let b1 = b0;
  while (b1 + 1 < bins.length && (bins[b1 + 1] >= dense || (b1 + 2 < bins.length && bins[b1 + 2] >= dense))) b1++;
  if ((b1 - b0 + 1) * BIN_M > maxBandM + 1e-9) return null;
  const level = lo + (b1 + 1) * BIN_M + marginM;
  // everything at or below it that the edge of the grid reaches
  const mask = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qn = 0;
  const seed = (k) => { if (!mask[k] && !pond[k] && H[k] <= level) { mask[k] = 1; queue[qn++] = k; } };
  for (let i = 0; i < nx; i++) { seed(i); seed((ny - 1) * nx + i); }
  for (let j = 1; j < ny - 1; j++) { seed(j * nx); seed(j * nx + nx - 1); }
  for (let q = 0; q < qn; q++) {
    const k = queue[q], i = k % nx;
    if (i > 0) seed(k - 1);
    if (i < nx - 1) seed(k + 1);
    if (k >= nx) seed(k - nx);
    if (k < n - nx) seed(k + nx);
  }
  const frac = qn / n;
  if (frac < minFrac) return null;
  // a sea never covers the course
  let under = 0;
  for (const [x, y] of play) {
    const i = Math.round((x - minX) / cellM), j = Math.round((y - minY) / cellM);
    if (i >= 0 && i < nx && j >= 0 && j < ny && mask[j * nx + i]) under++;
  }
  if (play.length && under > maxPlayFrac * play.length) return null;
  return { level, mask, shoreM: distanceToLand(mask, nx, ny, cellM), frac, nx, ny, minX, minY, cellM };
}

// The ground the sea meets, for the terrain shader to paint (turf.js): per cell of the
// grid, an RGBA texel of R = sand (a beach: low, gentle ground by the water), G = rock (a
// cliff or bluff dropping to it, and boulders at a steep waterline), B = wet (the last
// metre above the water line), A = 255. Only near the sea: the grass runs on inland,
// and the shader keeps all of it to the rough, off the course's own surfaces.
// grid: the grid findSea read; sea: its result.
export function shoreGround(grid, sea, { beachM = 60, beachHighM = 3, cliffM = 70 } = {}) {
  const { nx, ny, cellM, heights: H } = grid;
  const n = nx * ny;
  const land = new Uint8Array(n);
  for (let k = 0; k < n; k++) land[k] = sea.mask[k] ? 0 : 1;
  const toSea = distanceToLand(land, nx, ny, cellM);   // on land: metres to the nearest sea cell
  const ramp = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const out = new Uint8Array(n * 4);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      out[k * 4 + 3] = 255;
      const d = toSea[k];
      if (sea.mask[k] || d > Math.max(beachM, cliffM)) continue;
      const h = H[k] - sea.level;
      const gx = (H[j * nx + Math.min(nx - 1, i + 1)] - H[j * nx + Math.max(0, i - 1)]) / (2 * cellM);
      const gy = (H[Math.min(ny - 1, j + 1) * nx + i] - H[Math.max(0, j - 1) * nx + i]) / (2 * cellM);
      const tan = Math.hypot(gx, gy);
      const sand = (1 - ramp(beachM * 0.6, beachM, d)) * (1 - ramp(beachHighM * 0.5, beachHighM, h)) * (1 - ramp(0.35, 0.6, tan));
      const cliff = (1 - ramp(cliffM * 0.6, cliffM, d)) * ramp(0.55, 0.9, tan);
      const boulders = (1 - ramp(0.8, 2, h)) * ramp(0.2, 0.4, tan) * (1 - ramp(10, 25, d));
      const wet = (1 - ramp(0.3, 1.2, h)) * (1 - ramp(10, 25, d));
      out[k * 4] = Math.round(255 * sand);
      out[k * 4 + 1] = Math.round(255 * Math.max(cliff, boulders));
      out[k * 4 + 2] = Math.round(255 * wet);
    }
  }
  return { data: out, nx, ny, minX: grid.minX, minY: grid.minY, cellM };
}

// Is (x, y) sea? The nearest cell of the grid, and past its edge the edge's.
export function seaAt(sea, x, y) {
  const i = Math.min(sea.nx - 1, Math.max(0, Math.round((x - sea.minX) / sea.cellM)));
  const j = Math.min(sea.ny - 1, Math.max(0, Math.round((y - sea.minY) / sea.cellM)));
  return sea.mask[j * sea.nx + i] === 1;
}

// A copy of a height grid (the course's own, or a 1 m HD patch) with the sea floor
// carved under the water: lipM below the water line at the shore, deepening slope m
// per metre out to maxDepthM, so the water plane never lies on the ground it covers.
// Only cells at or under the water line where the sea is: a 1 m patch keeps its own,
// finer shoreline.
export function carveSea(heights, { nx, ny, minX, minY, cellM }, sea, { lipM = 0.3, slope = 0.08, maxDepthM = 10 } = {}) {
  const out = Float32Array.from(heights);
  for (let j = 0; j < ny; j++) {
    const sj = Math.round((minY + j * cellM - sea.minY) / sea.cellM);
    if (sj < 0 || sj >= sea.ny) continue;
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (out[k] > sea.level) continue;
      const si = Math.round((minX + i * cellM - sea.minX) / sea.cellM);
      if (si < 0 || si >= sea.nx) continue;
      const s = sj * sea.nx + si;
      if (sea.mask[s]) out[k] = Math.min(out[k], sea.level - Math.min(maxDepthM, lipM + sea.shoreM[s] * slope));
    }
  }
  return out;
}
