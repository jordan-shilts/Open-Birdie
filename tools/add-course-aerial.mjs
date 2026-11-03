// Fetch ONE course-wide aerial covering the whole course and attach it as
// `course.aerial = { file, bounds }`. This becomes the ground texture for the
// ENTIRE course, so surfaces (greens / sand / bunkers / paths) read as the real
// photo over the 1 m relief instead of a smooth green sheet.
//
// Source: USGS NAIPPlus (public domain) — mosaics High-Resolution Orthoimagery
// (~0.3 m over urban areas like Tacoma) over NAIP (0.6 m) elsewhere. 0.3 m is 2x
// sharper than plain NAIP. A full course at 0.3 m exceeds the service's single-
// request pixel cap, so the bbox is TILED and mosaicked with sharp. Falls back to
// a single NAIP 0.6 m request if a tile fails. (lib/aerial.js fetchCourseAerialTiled
// does the work; the cloud service runs the same code for every course, while the
// desktop app auto-fetches the single-request aerial, which needs no sharp.)
//
// Registration is linear: tiles are requested in EPSG:4326 over the course's
// lat/lon bbox, which maps 1:1 to the course's equirectangular local metres (same
// frame parseOsm uses), so local bounds == the image extent.
//
// Aerial is non-fingerprinted scenery (not in canonicalCourse), like buildings /
// elevation.patches — safe to attach to a course that already has an HD bundle.
//
//   node tools/add-course-aerial.mjs data/courses/<slug>.json
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { fetchCourseAerialTiled } = require('../lib/aerial.js');
const { atomicWriteOwned, courseBounds } = require('../lib/course.js');

const file = process.argv[2];
if (!file) { console.error('usage: node tools/add-course-aerial.mjs <course.json>'); process.exit(1); }
const course = JSON.parse(fs.readFileSync(file, 'utf8'));

const result = await fetchCourseAerialTiled({ origin: course.origin, bounds: courseBounds(course), sharp });
if (result.status !== 'ok') {
  console.error(result.status === 'none'
    ? 'no NAIP imagery covers this course (outside the US?); nothing written'
    : `aerial fetch failed (${result.reason}); nothing written`);
  process.exit(1);
}

const slug = path.basename(file).replace(/\.json$/i, '');
const aerialName = `${slug}.aerial.jpg`;
atomicWriteOwned(path.join(path.dirname(file), aerialName), result.buf);

// The NDVI classmap (if any) was built for these same padded bounds, so it stays.
course.aerial = { ...(course.aerial || {}), file: aerialName, bounds: result.bounds, quality: 'tiled' };
atomicWriteOwned(file, JSON.stringify(course));
const { minX, minY, maxX, maxY } = result.bounds;
console.log(`saved ${aerialName} (${result.width}x${result.height}, ${(result.buf.length / 1024 | 0)} KB, ${result.provider}) covering ${(maxX - minX).toFixed(0)}x${(maxY - minY).toFixed(0)} m @ ${result.gsdM.toFixed(2)} m/px`);
console.log(`course.aerial.bounds = ${JSON.stringify(course.aerial.bounds)}`);
