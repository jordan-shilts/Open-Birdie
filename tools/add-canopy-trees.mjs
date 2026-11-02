// Find every real tree on and around a cached course and attach them as
// `course.canopy = { trees: [[x, y, heightM, crownRadiusM], ...], ... }`.
//
// Source: Meta & World Resources Institute "High Resolution Canopy Height Maps"
// (global, ~1 m, CC BY 4.0), streamed from AWS Open Data with HTTP range reads, so
// only the rows covering the course are downloaded (a few MB). Each crown is a
// local maximum of canopy height, and closed woods with no distinct crowns get a
// fill at canopy height (lib/canopy-trees.js). Trees on greens, tees,
// fairways, bunkers, water or inside OSM buildings are dropped.
//
// Canopy is NON-fingerprinted scenery (not in canonicalCourse), like buildings and
// aerial: safe to attach to a course that already has HD bundles. Run
// add-buildings.mjs first so building footprints can mask false crowns.
//
//   node tools/add-canopy-trees.mjs data/courses/<slug>.json
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fromUrl } from 'geotiff';
import { pointInPoly } from '../public/render/tree-placement.js';

const { canopyTrees, mercX, mercY, quadkeysForBox } = createRequire(import.meta.url)('../lib/canopy-trees.js');

const CHM_BASE = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float';
const CELL_M = 1;
const PAD_M = 80; // matches the elevation grid pad, so trees cover the visible apron
const BLOCKING_KINDS = ['fairway', 'green', 'tee', 'bunker', 'water'];

const file = process.argv[2];
if (!file) { console.error('usage: node tools/add-canopy-trees.mjs <course.json>'); process.exit(1); }
const course = JSON.parse(fs.readFileSync(file, 'utf8'));
const { lat: lat0, lon: lon0 } = course.origin;
const mPerLat = 111132.95;
const mPerLon = 111319.49 * Math.cos((lat0 * Math.PI) / 180);

// The local box trees can stand in: the elevation grid when there is one (so every
// tree has real ground under it), else the course extent plus the usual pad.
function localBounds() {
  const e = course.elevation;
  if (e && e.nx && e.ny && e.cellM) {
    return { minX: e.minX, minY: e.minY, maxX: e.minX + (e.nx - 1) * e.cellM, maxY: e.minY + (e.ny - 1) * e.cellM };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (pts) => { for (const [x, y] of pts || []) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); } };
  for (const s of course.surfaces || []) eat(s.poly);
  for (const h of course.holes || []) eat(h.line);
  return { minX: minX - PAD_M, minY: minY - PAD_M, maxX: maxX + PAD_M, maxY: maxY + PAD_M };
}

const b = localBounds();
const nx = Math.floor((b.maxX - b.minX) / CELL_M) + 1;
const ny = Math.floor((b.maxY - b.minY) / CELL_M) + 1;
const heights = new Float32Array(nx * ny);
const lonAt = (x) => lon0 + x / mPerLon;
const latAt = (y) => lat0 + y / mPerLat;

// Sample each overlapping CHM tile into the local 1 m grid (nearest pixel; the
// source is ~0.85 m at mid latitudes, so nothing is lost).
const box = { west: lonAt(b.minX), east: lonAt(b.maxX), south: latAt(b.minY), north: latAt(b.maxY) };
let tilesRead = 0;
for (const key of quadkeysForBox(box, 9)) {
  let image;
  try {
    // 4 MB blocks: a course needs a few thousand compressed strips, and fetching
    // them as separate small requests gets the connection reset by S3.
    const tiff = await fromUrl(`${CHM_BASE}/chm/${key}.tif`, { blockSize: 4 * 1024 * 1024 });
    image = await tiff.getImage(0);
  } catch (e) {
    console.warn(`[canopy] tile ${key} unavailable (${e.message}); no canopy there`);
    continue;
  }
  const [ox, , , oy] = image.getBoundingBox();
  const [rx, ry] = image.getResolution();
  const W = image.getWidth(), H = image.getHeight();
  const colOf = (x) => Math.floor((mercX(lonAt(x)) - ox) / rx);
  const rowOf = (y) => Math.floor((mercY(latAt(y)) - oy) / ry);
  const c0 = Math.max(0, colOf(b.minX)), c1 = Math.min(W, colOf(b.maxX) + 1);
  const r0 = Math.max(0, rowOf(b.maxY)), r1 = Math.min(H, rowOf(b.minY) + 1);
  if (c0 >= c1 || r0 >= r1) continue;
  const [data] = await image.readRasters({ window: [c0, r0, c1, r1] });
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
if (!tilesRead) { console.error('[canopy] no canopy tiles cover this course; nothing written'); process.exit(1); }

// Ground where no tree can stand: playable surfaces, water and building footprints.
const blockers = [
  ...(course.surfaces || []).filter((s) => BLOCKING_KINDS.includes(s.kind)).map((s) => s.poly),
  ...(course.buildings || []).map((bd) => bd.poly),
].filter((p) => p && p.length >= 3).map((poly) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { poly, minX, minY, maxX, maxY };
});
const blocked = (x, y) => blockers.some((p) => x >= p.minX && x <= p.maxX && y >= p.minY && y <= p.maxY && pointInPoly(x, y, p.poly));

const { crowns, fill, trees } = canopyTrees({ heights, nx, ny, minX: b.minX, minY: b.minY, cellM: CELL_M }, { blocked });
course.canopy = {
  source: 'Meta & WRI High Resolution Canopy Height Maps (CC BY 4.0)',
  url: CHM_BASE,
  cellM: CELL_M,
  fetchedAt: new Date().toISOString(),
  trees,
};
fs.writeFileSync(file, JSON.stringify(course));

const hs = trees.map((t) => t[2]).sort((a, c) => a - c);
const pct = (q) => hs.length ? hs[Math.min(hs.length - 1, Math.floor(q * hs.length))] : 0;
console.log(`injected ${trees.length} real trees into ${file} (${crowns.length} distinct crowns, ${fill.length} filling closed woods)`);
console.log(`  height median ${pct(0.5)} m, 90th ${pct(0.9)} m, max ${pct(1)} m; canopy area ${nx} x ${ny} m from ${tilesRead} tile(s)`);
