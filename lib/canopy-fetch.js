'use strict';
// Every real tree on and around a course, as
// `course.canopy = { source, url, cellM, fetchedAt, trees: [[x, y, heightM, crownRadiusM], ...] }`.
//
// Source: Meta & World Resources Institute "High Resolution Canopy Height Maps"
// (global, ~1 m, CC BY 4.0), streamed from AWS Open Data with HTTP range reads, so
// only the rows covering the course are downloaded (a few MB). Each crown is a local
// maximum of canopy height and closed woods get a fill (lib/canopy-trees.js). Trees
// on greens, tees, fairways, bunkers, water or inside building footprints are
// dropped, so attach buildings first.
//
// Canopy is NON-fingerprinted scenery (not in canonicalCourse), like buildings and
// the aerial. Reading the GeoTIFF tiles needs the `geotiff` package, which is a
// devDependency: it is imported lazily, and when it is missing (the packaged desktop
// app) fetchCanopy throws CANOPY_READER_UNAVAILABLE so the caller can skip canopy
// (the cloud service, which has geotiff, supplies it instead).

const { canopyTrees, mercX, mercY, quadkeysForBox } = require('./canopy-trees');
const { pointInPoly } = require('./course');
const { isAbortError, throwIfAborted } = require('./abort');

const CHM_BASE = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float';
const CANOPY_SOURCE = 'Meta & WRI High Resolution Canopy Height Maps (CC BY 4.0)';
const CELL_M = 1;
const PAD_M = 80; // matches the elevation grid pad, so trees cover the visible apron
const BLOCKING_KINDS = ['fairway', 'green', 'tee', 'bunker', 'water'];
const M_PER_LAT = 111132.95;

class CanopyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CanopyError';
    this.code = code;
  }
}

// The local box trees can stand in: the elevation grid when there is one (so every
// tree has real ground under it), else the course extent plus the usual pad.
function canopyBounds(course) {
  const e = course.elevation;
  if (e && e.nx && e.ny && e.cellM) {
    return { minX: e.minX, minY: e.minY, maxX: e.minX + (e.nx - 1) * e.cellM, maxY: e.minY + (e.ny - 1) * e.cellM };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (pts) => {
    for (const [x, y] of pts || []) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  };
  for (const s of course.surfaces || []) eat(s.poly);
  for (const h of course.holes || []) eat(h.line);
  if (!Number.isFinite(minX)) throw new CanopyError('CANOPY_NO_GEOMETRY', 'Course has no geometry to place trees in');
  return { minX: minX - PAD_M, minY: minY - PAD_M, maxX: maxX + PAD_M, maxY: maxY + PAD_M };
}

// Ground where no tree can stand: playable surfaces, water and building footprints.
function canopyBlocker(course) {
  const blockers = [
    ...(course.surfaces || []).filter((s) => BLOCKING_KINDS.includes(s.kind)).map((s) => s.poly),
    ...(course.buildings || []).map((bd) => bd.poly),
  ].filter((p) => Array.isArray(p) && p.length >= 3).map((poly) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    return { poly, minX, minY, maxX, maxY };
  });
  return (x, y) => blockers.some((p) => x >= p.minX && x <= p.maxX && y >= p.minY && y <= p.maxY && pointInPoly(x, y, p.poly));
}

// Default tile reader: a Cloud-Optimized GeoTIFF over HTTP range reads. Returns
// { bbox, resolution, width, height, readWindow([c0, r0, c1, r1]) -> Float32Array }.
async function openCanopyTile(url, { signal } = {}) {
  let geotiff;
  try {
    geotiff = await import('geotiff');
  } catch (error) {
    throw new CanopyError('CANOPY_READER_UNAVAILABLE', `geotiff is not installed (${error.message})`);
  }
  // 4 MB blocks: a course needs a few thousand compressed strips, and fetching
  // them as separate small requests gets the connection reset by S3.
  const tiff = await geotiff.fromUrl(url, { blockSize: 4 * 1024 * 1024 }, signal);
  const image = await tiff.getImage(0);
  return {
    bbox: image.getBoundingBox(),
    resolution: image.getResolution(),
    width: image.getWidth(),
    height: image.getHeight(),
    async readWindow(window) {
      const [data] = await image.readRasters({ window, signal });
      return data;
    },
  };
}

// Sample every overlapping CHM tile (EPSG:3857, quadkey z9) into a local 1 m grid
// (nearest pixel; the source is ~0.85 m at mid latitudes, so nothing is lost).
async function sampleCanopyHeights(course, {
  openTile = openCanopyTile,
  baseUrl = CHM_BASE,
  signal,
  log = console,
} = {}) {
  const b = canopyBounds(course);
  const { lat: lat0, lon: lon0 } = course.origin;
  const mPerLon = 111319.49 * Math.cos((lat0 * Math.PI) / 180);
  const nx = Math.floor((b.maxX - b.minX) / CELL_M) + 1;
  const ny = Math.floor((b.maxY - b.minY) / CELL_M) + 1;
  const heights = new Float32Array(nx * ny);
  const lonAt = (x) => lon0 + x / mPerLon;
  const latAt = (y) => lat0 + y / M_PER_LAT;

  const box = { west: lonAt(b.minX), east: lonAt(b.maxX), south: latAt(b.minY), north: latAt(b.maxY) };
  const keys = quadkeysForBox(box, 9);
  let tilesRead = 0;
  let lastError = null;
  for (const key of keys) {
    throwIfAborted(signal);
    let image;
    try {
      image = await openTile(`${baseUrl}/chm/${key}.tif`, { signal });
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (error && error.code === 'CANOPY_READER_UNAVAILABLE') throw error;
      lastError = error;
      log.warn(`[canopy] tile ${key} unavailable (${error && error.message}); no canopy there`);
      continue;
    }
    const [ox, , , oy] = image.bbox;
    const [rx, ry] = image.resolution;
    const W = image.width, H = image.height;
    const colOf = (x) => Math.floor((mercX(lonAt(x)) - ox) / rx);
    const rowOf = (y) => Math.floor((mercY(latAt(y)) - oy) / ry);
    const c0 = Math.max(0, colOf(b.minX)), c1 = Math.min(W, colOf(b.maxX) + 1);
    const r0 = Math.max(0, rowOf(b.maxY)), r1 = Math.min(H, rowOf(b.minY) + 1);
    if (c0 >= c1 || r0 >= r1) continue;
    const data = await image.readWindow([c0, r0, c1, r1]);
    throwIfAborted(signal);
    const ww = c1 - c0;
    const cols = new Int32Array(nx);
    for (let i = 0; i < nx; i++) cols[i] = colOf(b.minX + i * CELL_M) - c0;
    for (let j = 0; j < ny; j++) {
      const row = rowOf(b.minY + j * CELL_M) - r0;
      if (row < 0 || row >= r1 - r0) continue;
      for (let i = 0; i < nx; i++) {
        const col = cols[i];
        if (col >= 0 && col < ww) heights[j * nx + i] = data[row * ww + col];
      }
    }
    tilesRead++;
  }
  if (!tilesRead) {
    throw new CanopyError('CANOPY_TILES_UNAVAILABLE',
      `no canopy tile could be read${lastError ? ` (${lastError.message})` : ''}`);
  }
  return { grid: { heights, nx, ny, minX: b.minX, minY: b.minY, cellM: CELL_M }, tilesRead };
}

// course.canopy for a course (its buildings, when attached, mask false crowns).
// Throws CANOPY_READER_UNAVAILABLE without geotiff and CANOPY_TILES_UNAVAILABLE when
// no tile could be read (a network failure: retry later).
async function fetchCanopy(course, {
  openTile = openCanopyTile,
  baseUrl = CHM_BASE,
  signal,
  now = () => new Date(),
  log = console,
} = {}) {
  const { grid, tilesRead } = await sampleCanopyHeights(course, { openTile, baseUrl, signal, log });
  throwIfAborted(signal);
  const { crowns, fill, trees } = canopyTrees(grid, { blocked: canopyBlocker(course) });
  return {
    canopy: {
      source: CANOPY_SOURCE,
      url: baseUrl,
      cellM: CELL_M,
      fetchedAt: now().toISOString(),
      trees,
    },
    stats: { crowns: crowns.length, fill: fill.length, tilesRead, nx: grid.nx, ny: grid.ny },
  };
}

module.exports = {
  CANOPY_SOURCE,
  CHM_BASE,
  CanopyError,
  canopyBlocker,
  canopyBounds,
  fetchCanopy,
  openCanopyTile,
  sampleCanopyHeights,
};
