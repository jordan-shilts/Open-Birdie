// Fetch OSM building footprints for an already-cached course and attach them as
// `course.buildings` (footprint polygon in local metres + estimated height +
// clubhouse flag). Buildings are a NON-fingerprinted scenery layer (not in
// canonicalCourse, like elevation.patches), so this is safe to run on a course
// that already has a built HD bundle — the fingerprint is unchanged.
//
// The server does this automatically in the background for every course that has
// no buildings yet (lib/course-enrichment.js); this tool runs the same code
// (lib/buildings-fetch.js) by hand, e.g. to refresh a course after OSM edits.
//
//   node tools/add-buildings.mjs data/courses/<slug>.json
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fetchBuildings } = require('../lib/buildings-fetch.js');
const { atomicWriteOwned } = require('../lib/course.js');

const file = process.argv[2];
if (!file) { console.error('usage: node tools/add-buildings.mjs <course.json>'); process.exit(1); }
const course = JSON.parse(fs.readFileSync(file, 'utf8'));

const buildings = await fetchBuildings(course);
course.buildings = buildings;
atomicWriteOwned(file, JSON.stringify(course));
const ch = buildings.filter((b) => b.clubhouse).length;
console.log(`injected ${buildings.length} buildings (${ch} hero/clubhouse) into ${file}`);
for (const b of buildings.filter((x) => x.clubhouse).slice(0, 4)) console.log(`  hero: ${b.name || b.kind} ~${b.heightM}m, ${b.poly.length}pts`);
