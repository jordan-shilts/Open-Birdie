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
// The server does this automatically for every course without canopy data
// (lib/course-enrichment.js, when geotiff is installed or the cloud supplies it);
// this tool runs the same code (lib/canopy-fetch.js) by hand.
//
//   node tools/add-canopy-trees.mjs data/courses/<slug>.json
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fetchCanopy } = require('../lib/canopy-fetch.js');
const { atomicWriteOwned } = require('../lib/course.js');

const file = process.argv[2];
if (!file) { console.error('usage: node tools/add-canopy-trees.mjs <course.json>'); process.exit(1); }
const course = JSON.parse(fs.readFileSync(file, 'utf8'));

let result;
try {
  result = await fetchCanopy(course);
} catch (error) {
  if (error.code === 'CANOPY_TILES_UNAVAILABLE') {
    console.error(`[canopy] no canopy tiles cover this course (${error.message}); nothing written`);
    process.exit(1);
  }
  throw error;
}
const { canopy, stats } = result;
course.canopy = canopy;
atomicWriteOwned(file, JSON.stringify(course));

const hs = canopy.trees.map((t) => t[2]).sort((a, c) => a - c);
const pct = (q) => hs.length ? hs[Math.min(hs.length - 1, Math.floor(q * hs.length))] : 0;
console.log(`injected ${canopy.trees.length} real trees into ${file} (${stats.crowns} distinct crowns, ${stats.fill} filling closed woods)`);
console.log(`  height median ${pct(0.5)} m, 90th ${pct(0.9)} m, max ${pct(1)} m; canopy area ${stats.nx} x ${stats.ny} m from ${stats.tilesRead} tile(s)`);
