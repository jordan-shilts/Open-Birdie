// Re-fetch the terrain of an already-cached course (the course-wide USGS 3DEP lidar
// base plus the per-green patches) and replace course.elevation. Use it when a load
// hit a slow lidar service and part of the course fell back to the smoothed ~10 m
// terrain; [elevation] warnings in the server log say when that happened.
//
// Elevation IS fingerprinted (unlike buildings, aerial or canopy): this changes the
// course fingerprint, so rebuild any HD bundles for the course afterwards.
//
//   node tools/refresh-elevation.mjs data/courses/<slug>.json
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fetchElevationGrid, fetchGreenPatches, makeTerrain } = require('../lib/elevation.js');
const { courseBounds } = require('../lib/course.js');

const file = process.argv[2];
if (!file) { console.error('usage: node tools/refresh-elevation.mjs <course.json>'); process.exit(1); }
const course = JSON.parse(fs.readFileSync(file, 'utf8'));

// Share of 100 m blocks with almost no fine relief: smoothed fallback terrain (or
// open water) scores near zero, real lidar does not.
function flatShare(e) {
  if (!e || !e.heights) return null;
  const { nx, ny, cellM, heights } = e;
  const B = Math.max(2, Math.round(100 / cellM));
  let flat = 0, blocks = 0;
  for (let bj = 1; bj + B < ny; bj += B) {
    for (let bi = 1; bi + B < nx; bi += B) {
      let sum = 0;
      for (let j = bj; j < bj + B; j++) {
        for (let i = bi; i < bi + B; i++) {
          const k = j * nx + i;
          sum += Math.abs(4 * heights[k] - heights[k - 1] - heights[k + 1] - heights[k - nx] - heights[k + nx]);
        }
      }
      blocks++;
      if (sum / (B * B) < 0.004) flat++;
    }
  }
  return blocks ? flat / blocks : null;
}

const { lat, lon } = course.origin;
const mPerLat = 111132.95;
const mPerLon = 111319.49 * Math.cos((lat * Math.PI) / 180);
const before = flatShare(course.elevation);
const elevation = await fetchElevationGrid({ lat0: lat, lon0: lon, mPerLat, mPerLon, ...courseBounds(course) });
if (!elevation) { console.error('[elevation] fetch failed; the cached terrain is unchanged'); process.exit(1); }
elevation.patches = await fetchGreenPatches({
  lat0: lat, lon0: lon, mPerLat, mPerLon,
  baseM: elevation.baseM,
  greens: (course.surfaces || []).filter((s) => s.kind === 'green'),
  baseH: makeTerrain(elevation).h,
});
const after = flatShare(elevation);
course.elevation = elevation;
fs.writeFileSync(file, JSON.stringify(course));
const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
console.log(`refreshed terrain in ${file}: ${elevation.nx} x ${elevation.ny} @ ${elevation.cellM} m, ${elevation.patches.length} green patches`);
console.log(`  100 m blocks with no fine relief (smoothed fallback or water): ${pct(before)} before, ${pct(after)} now`);
