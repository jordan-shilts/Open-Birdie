'use strict';
// Real trees from a canopy height model (CHM): a regular grid of vegetation height
// above the ground, in metres. Each crown is a local height maximum, and its radius
// is how far the canopy stays above half that height. Pure (no I/O) so it is unit-
// tested; tools/add-canopy-trees.mjs fetches the raster and writes course.canopy.
//
// Output trees are [x, y, heightM, crownRadiusM] in the course's local metres.

// Separable gaussian blur of a row-major nx*ny grid. sigma is in cells.
function gaussianBlur(src, nx, ny, sigma) {
  if (!(sigma > 0)) return Float32Array.from(src);
  const rad = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(rad * 2 + 1);
  let sum = 0;
  for (let k = -rad; k <= rad; k++) { kernel[k + rad] = Math.exp(-(k * k) / (2 * sigma * sigma)); sum += kernel[k + rad]; }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
  const tmp = new Float32Array(nx * ny), out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      let v = 0;
      for (let k = -rad; k <= rad; k++) v += src[row + Math.min(nx - 1, Math.max(0, i + k))] * kernel[k + rad];
      tmp[row + i] = v;
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let v = 0;
      for (let k = -rad; k <= rad; k++) v += tmp[Math.min(ny - 1, Math.max(0, j + k)) * nx + i] * kernel[k + rad];
      out[j * nx + i] = v;
    }
  }
  return out;
}

// Search window (m) for a crown of height h: taller trees have wider crowns, so a
// smaller bump within this distance is a branch of the same tree, not a new one.
const windowRadiusM = (h) => 1.0 + 0.1 * h;
// Crown radius bounds (m) for height h: open-grown deciduous crowns reach ~0.45 h.
const maxCrownM = (h) => 2 + 0.5 * h;

const RAYS = [[1, 0], [-1, 0], [0, 1], [0, -1], [Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]];

// Median distance (m) along 8 rays until the canopy drops below half the crown
// height or starts climbing into a neighbouring crown.
function crownRadius(h, nx, ny, i0, j0, peak, cellM) {
  const limit = maxCrownM(peak) / cellM;
  const dists = [];
  for (const [dx, dy] of RAYS) {
    let prev = peak, d = limit;
    for (let step = 1; step <= limit; step++) {
      const i = Math.round(i0 + dx * step), j = Math.round(j0 + dy * step);
      if (i < 0 || j < 0 || i >= nx || j >= ny) { d = step; break; }
      const v = h[j * nx + i];
      if (v < peak * 0.5 || v > prev + 0.3) { d = step; break; }
      prev = v;
    }
    dists.push(d * cellM);
  }
  dists.sort((a, b) => a - b);
  const median = (dists[3] + dists[4]) / 2;
  return Math.min(maxCrownM(peak), Math.max(1, median));
}

// grid: { heights, nx, ny, minX, minY, cellM } — heights row-major, row j at
// y = minY + j * cellM, column i at x = minX + i * cellM.
// blocked(x, y) -> true drops a crown standing there (greens, water, buildings...).
function checkGrid(grid) {
  const { nx, ny, cellM } = grid;
  if (!(nx > 0 && ny > 0 && cellM > 0) || !grid.heights || grid.heights.length < nx * ny) {
    throw new Error('Canopy grid must have nx*ny heights and a positive cell size');
  }
}

function detectTreeCrowns(grid, { minHeightM = 4, maxHeightM = 60, smoothM = 1, blocked = null } = {}) {
  checkGrid(grid);
  const h = gaussianBlur(grid.heights, grid.nx, grid.ny, smoothM / grid.cellM);
  return crownsOnSmoothed(h, grid, { minHeightM, maxHeightM, blocked });
}

function crownsOnSmoothed(h, grid, { minHeightM, maxHeightM, blocked }) {
  const { nx, ny, minX, minY, cellM } = grid;
  const trees = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = h[j * nx + i];
      if (v < minHeightM || v > maxHeightM) continue;
      const r = Math.max(1, Math.round(windowRadiusM(v) / cellM));
      let isMax = true;
      for (let dj = -r; dj <= r && isMax; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        for (let di = -r; di <= r; di++) {
          if ((di === 0 && dj === 0) || di * di + dj * dj > r * r) continue;
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue;
          const w = h[jj * nx + ii];
          // ties: the first cell in scan order wins, so a flat top yields one tree
          if (w > v || (w === v && (dj < 0 || (dj === 0 && di < 0)))) { isMax = false; break; }
        }
      }
      if (!isMax) continue;
      const x = minX + i * cellM, y = minY + j * cellM;
      if (blocked && blocked(x, y)) continue;
      const radius = crownRadius(h, nx, ny, i, j, v, cellM);
      trees.push([+x.toFixed(1), +y.toFixed(1), +v.toFixed(1), +radius.toFixed(1)]);
    }
  }
  return trees;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mark the cells within `reach` metres of (x, y) as covered.
function cover(covered, grid, x, y, reach) {
  const { nx, ny, minX, minY, cellM } = grid;
  const i0 = (x - minX) / cellM, j0 = (y - minY) / cellM, r = reach / cellM;
  for (let j = Math.max(0, Math.floor(j0 - r)); j <= Math.min(ny - 1, Math.ceil(j0 + r)); j++) {
    for (let i = Math.max(0, Math.floor(i0 - r)); i <= Math.min(nx - 1, Math.ceil(i0 + r)); i++) {
      if ((i - i0) ** 2 + (j - j0) ** 2 <= r * r) covered[j * nx + i] = 1;
    }
  }
}

// Every tree the canopy shows: distinct crowns first, then a fill for closed woods.
// Dense woods read as one smooth canopy with few distinct peaks, so crowns alone
// leave most of a forest empty (Hazeltine: crowns covered 42% of the canopy).
// Canopy still uncovered gets trees on a jittered grid of fillSpacingM, each as
// tall as the canopy there. Returns { crowns, fill, trees } of [x, y, h, r].
function canopyTrees(grid, { minHeightM = 4, maxHeightM = 60, smoothM = 1, fillSpacingM = 7, blocked = null, seed = 1 } = {}) {
  checkGrid(grid);
  const { nx, ny, minX, minY, cellM } = grid;
  const h = gaussianBlur(grid.heights, nx, ny, smoothM / cellM);
  const crowns = crownsOnSmoothed(h, grid, { minHeightM, maxHeightM, blocked });
  const covered = new Uint8Array(nx * ny);
  for (const [x, y, , r] of crowns) cover(covered, grid, x, y, r * 0.85);
  const fill = [];
  if (fillSpacingM > 0) {
    const rnd = mulberry32(seed);
    const maxX = minX + (nx - 1) * cellM, maxY = minY + (ny - 1) * cellM;
    for (let gy = minY + fillSpacingM / 2; gy <= maxY; gy += fillSpacingM) {
      for (let gx = minX + fillSpacingM / 2; gx <= maxX; gx += fillSpacingM) {
        const x = gx + (rnd() - 0.5) * fillSpacingM * 0.8, y = gy + (rnd() - 0.5) * fillSpacingM * 0.8;
        const i = Math.round((x - minX) / cellM), j = Math.round((y - minY) / cellM);
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const v = h[j * nx + i];
        if (v < minHeightM || v > maxHeightM || covered[j * nx + i]) continue;
        if (blocked && blocked(x, y)) continue;
        // height from the raw canopy around the spot: the blur pulls heights down
        // near a woods edge, which would stunt every edge tree
        const reach = Math.max(1, Math.round(2 / cellM));
        let top = 0;
        for (let jj = Math.max(0, j - reach); jj <= Math.min(ny - 1, j + reach); jj++) {
          for (let ii = Math.max(0, i - reach); ii <= Math.min(nx - 1, i + reach); ii++) top = Math.max(top, grid.heights[jj * nx + ii]);
        }
        const ht = Math.min(maxHeightM, Math.max(v, top));
        const r = Math.min(maxCrownM(ht), fillSpacingM * 0.6);
        fill.push([+x.toFixed(1), +y.toFixed(1), +ht.toFixed(1), +r.toFixed(1)]);
        cover(covered, grid, x, y, r * 0.85);
      }
    }
  }
  return { crowns, fill, trees: [...crowns, ...fill] };
}

// Web-Mercator helpers for locating CHM tiles (EPSG:3857, quadkey tiles).
const EARTH_R = 6378137;
const mercX = (lon) => (lon * Math.PI) / 180 * EARTH_R;
const mercY = (lat) => EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

function tileXY(lon, lat, z) {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
  };
}

function quadkey(x, y, z) {
  let key = '';
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    key += String((x & mask ? 1 : 0) + (y & mask ? 2 : 0));
  }
  return key;
}

// Quadkeys of every zoom-z tile touching the lon/lat box.
function quadkeysForBox({ west, south, east, north }, z = 9) {
  const a = tileXY(west, north, z), b = tileXY(east, south, z);
  const keys = [];
  for (let y = a.y; y <= b.y; y++) for (let x = a.x; x <= b.x; x++) keys.push(quadkey(x, y, z));
  return keys;
}

module.exports = { canopyTrees, detectTreeCrowns, gaussianBlur, mercX, mercY, quadkey, quadkeysForBox, tileXY };
