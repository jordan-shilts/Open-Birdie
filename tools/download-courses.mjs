// The course download engine: courses we don't have yet, built on this computer the way
// the featured courses were. It runs the cloud service's own build (cloud/builder.js)
// here, so a course comes in with all of it:
//   - its base: OpenStreetMap holes and surfaces, the course-wide 1 m USGS 3DEP lidar
//     terrain and the NDVI surface classmap;
//   - its scenery: OSM buildings and nearby water, every real tree (the Meta/WRI canopy
//     height map, `geotiff`) and the 0.3 m tiled NAIP aerial (`sharp`);
//   - 1 m HD terrain on every hole (cloud/hd-holes.js: the reviewed manifests in
//     tools/hd-course/manifests, and every other hole of a US course auto-pinned), with
//     no time limit (a cloud sandbox stops starting HD holes after 20 minutes).
//
//   npm run download:courses -- "Medinah Country Club" relation/123 way/456
//   npm run download:courses -- --file courses.txt   one name or OSM id per line (# comments)
//   npm run download:courses -- --featured           the course picker's featured courses
//
//   --status      what each course has on this computer; nothing is built
//   --force       build the courses again from scratch
//   --store DIR   where the packages go (default BIRDIE_DATA_DIR/course-store)
//
// A name is searched on OpenStreetMap like the course picker does; an OSM id is
// relation/123, way/123 or osm:way:123.
//
// Each course lands in BIRDIE_DATA_DIR (data/ by default), where the course picker lists
// it under Your courses. Its package (manifest plus sha256-checked files,
// lib/course-package.js) goes to a directory store, as a cloud build's would. The
// manifest records what the build got: each scenery layer, the HD holes, and why any
// hole was skipped. So a run skips a course that is already complete, finishes one that
// is not (a missing layer, an HD hole that failed for a passing reason), and puts back,
// from the store and offline, one the app's course cache deleted. `node cloud/server.js`
// with BIRDIE_CLOUD_STORE_DIR set to the store serves the courses to another computer
// (BIRDIE_CLOUD_URL on that computer).
//
// A course is held to the terrain the featured courses have: in the contiguous US a base
// whose lidar did not come (the loader then keeps the smoothed ~10 m terrain) is thrown
// away and tried again. Courses build one at a time (the public map, lidar and imagery
// services prefer polite clients); one that failed for a reason that may pass is tried
// again after the others, 1 and then 2 minutes later.
//
// It needs what the cloud needs and the desktop app does not ship: sharp, geotiff and
// the HD tools (tools/hd-course, with proj4 and ajv), all installed by `npm ci`. Without
// them it stops rather than build a lesser course.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  hdRequestFor, holesText, label, mb, missingText, packageHdHoles, parseOsmRef, readFeatured, repoHdHoles, resolveCourse,
} from './cloud-build-courses.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CACHE_VERSION, readSourceKeyedCache } = require('../lib/course');
const { cacheLimitBytes, courseFiles, sizeOf } = require('../lib/course-cache');
const { normalizeCourseSource } = require('../lib/course-identity');
const { packageKeyFor } = require('../lib/course-key');
const { GRID_CELL_M } = require('../lib/elevation');
const { createCourseBuilder, removeStaging } = require('../cloud/builder');
const { buildHdHoles, hdPlanFor, inConus, loadTools } = require('../cloud/hd-holes');
const { createFsStore, manifestKey } = require('../cloud/store');

export const STORE_DIR = 'course-store';
export const RETRY_WAITS_MS = Object.freeze([60_000, 120_000]);
// The same course would fail the same way: not tried again.
const DEFINITIVE = new Set(['COURSE_NOT_GOLF_COURSE', 'COURSE_NOT_PLAYABLE', 'COURSE_IDENTITY_INVALID', 'CACHE_IDENTITY_MISMATCH']);

// What is wrong with a course's terrain, or null. No terrain at all is the flat fallback.
// In the contiguous US the base is the 1 m 3DEP lidar (1-4 m cells for any course under
// ~8 km across); a grid of GRID_CELL_M or more is the smoothed one the loader keeps when
// no lidar tile came (lib/elevation.js).
export function terrainProblem(course) {
  const e = course && course.elevation;
  if (!e) return 'no terrain (it would play flat)';
  if (inConus(course) && !(e.cellM < GRID_CELL_M)) return `no lidar terrain (a ${e.cellM} m grid instead of 1 m)`;
  return null;
}

// What a course still needs to be as solid as the featured ones ([] = nothing): each
// { what, fresh } where fresh means its base must be built again.
export function needsOf({ course, manifest, repoHoles = [] }) {
  const needs = [];
  const add = (what, fresh = false) => needs.push({ what, fresh });
  if (!course) add('not on this computer');
  const terrain = course ? terrainProblem(course) : null;
  if (terrain) add(terrain, true);
  if (!manifest) {
    add('not built by the engine yet');
    return needs;
  }
  if (manifest.cacheVersion !== CACHE_VERSION) {
    add('built for an older course format', true);
    return needs;
  }
  if (!manifest.complete) add('scenery not finished');
  const s = manifest.scenery || {};
  if (s.buildings == null) add('no buildings');
  if (s.water == null) add('no nearby water');
  if (s.canopyTrees == null) add('no real trees');
  // NAIP covers the contiguous US: elsewhere there is no aerial to have
  if (s.aerial !== 'tiled' && (!course || inConus(course))) add(s.aerial ? `a ${s.aerial} aerial, not the 0.3 m one` : 'no aerial photo');
  const hd = hdRequestFor(manifest, repoHoles);
  if (hd === true) add('HD holes not planned');
  else if (Array.isArray(hd) && hd.length) add(`HD holes to build: ${holesText(hd)}`);
  return needs;
}

// One line on what a package holds.
export function describe(manifest) {
  const s = manifest.scenery || {};
  const hd = packageHdHoles(manifest);
  return [
    mb(manifest.totalBytes),
    `${s.buildings ?? '-'} buildings`,
    `${s.canopyTrees ?? '-'} trees`,
    `${s.aerial || 'no'} aerial`,
    hd.length ? `HD holes ${holesText(hd)}` : 'no HD holes',
  ].join(', ') + (manifest.hdMissing && manifest.hdMissing.length ? `; HD missing ${missingText(manifest.hdMissing)}` : '');
}

// The builder's base load, held to the terrain a solid course needs: a base whose terrain
// fell back is thrown away (its files removed, so the next try fetches it again) and the
// build fails for a reason that may pass.
export function solidLoad(loadCourse, dataDir) {
  return async (request, options) => {
    const course = await loadCourse(request, options);
    const problem = terrainProblem(course);
    if (problem) {
      removeStaging(dataDir, packageKeyFor(normalizeCourseSource(course.source)));
      throw Object.assign(new Error(`${problem}: the lidar service may be busy`), { code: 'TERRAIN_FELL_BACK' });
    }
    return course;
  };
}

// HD holes as the cloud plans them (reviewed manifests, every other US hole auto-pinned;
// BIRDIE_CLOUD_AUTO_HD=0 keeps to the reviewed ones), each in a process of its own, with
// no time limit: the cloud's 20 minutes is a sandbox's, not this computer's.
export const LOCAL_HD = Object.freeze({
  plan: (course) => hdPlanFor(course),
  build: (args) => buildHdHoles({ ...args, budgetMs: Infinity }),
});

// The cloud's build, run here into dataDir: tiled aerial, canopy trees, HD on every hole,
// the course kept where the app reads it. loadCourse, providers and hd are injectable (tests).
export function createBuild({
  dataDir,
  store,
  sharp = null,
  loadCourse = require('../lib/course').loadCourse,
  providers = null,
  hd = null,
  log = console,
}) {
  const { localSceneryProviders } = require('../lib/course-enrichment');
  return createCourseBuilder({
    dataDir,
    store,
    loadCourse: solidLoad(loadCourse, dataDir),
    providers: providers || localSceneryProviders({ aerialQuality: 'tiled', sharp, canopy: true }),
    aerialQuality: 'tiled',
    hd: hd || LOCAL_HD,
    generator: 'open-birdie-download-engine',
    keepStaging: true,
    log,
  });
}

// What this computer has of a course: { key, source, course, manifest, needs }.
export async function inspect(entry, { store, dataDir, hdHolesFor = repoHdHoles }) {
  const source = normalizeCourseSource({ osmType: entry.osmType, osmId: entry.osmId });
  const key = packageKeyFor(source);
  let course = null;
  try { course = readSourceKeyedCache({ cacheDir: path.join(dataDir, 'courses'), source }); } catch (_) { course = null; }
  const manifest = await store.getJson(manifestKey(key));
  return { key, source, course, manifest, needs: needsOf({ course, manifest, repoHoles: hdHolesFor(source) }) };
}

const requestOf = (entry) => ({
  ...(entry.name ? { name: entry.name } : {}),
  ...(Array.isArray(entry.bbox) ? { bbox: entry.bbox } : {}),
});
const whatOf = (needs) => needs.map((n) => n.what).join('; ');

// One course: skipped when it has everything, else built (from scratch when its base must
// be). Returns { entry, key, status: 'had'|'built'|'incomplete'|'failed', retry, ... }.
export async function downloadOne(entry, {
  build, store, dataDir, force = false, hdHolesFor = repoHdHoles, now = Date.now, log = console.log,
}) {
  const name = label(entry);
  const before = await inspect(entry, { store, dataDir, hdHolesFor });
  const { key } = before;
  if (!force && !before.needs.length) return { entry, key, status: 'had', manifest: before.manifest, retry: false };
  const fresh = force || before.needs.some((n) => n.fresh);
  log(`  ${name}: ${force ? 'building it again from scratch' : whatOf(before.needs)}`);
  const started = now();
  let last = '';
  const update = (fields) => {
    if (!fields || !fields.message) return;
    const line = `${fields.stage}: ${fields.message}${Number.isFinite(fields.pct) ? ` (${Math.round(fields.pct)}%)` : ''}`;
    if (line !== last) log(`  ${name}: ${line}`);
    last = line;
  };
  try {
    await build({ key, request: requestOf(entry), force: fresh }, { update, signal: new AbortController().signal });
  } catch (error) {
    const code = String((error && error.code) || 'BUILD_FAILED');
    const message = String((error && error.message) || error).slice(0, 300);
    log(`  ${name}: failed (${code}): ${message}`);
    return { entry, key, status: 'failed', code, message, retry: !DEFINITIVE.has(code), ms: now() - started };
  }
  const after = await inspect(entry, { store, dataDir, hdHolesFor });
  if (after.needs.length) log(`  ${name}: still missing ${whatOf(after.needs)}`);
  return {
    entry, key, status: after.needs.length ? 'incomplete' : 'built', needs: after.needs,
    manifest: after.manifest, retry: after.needs.length > 0, ms: now() - started,
  };
}

// Every course, one at a time; the ones that may still come are tried again after the
// rest, once per wait in retryWaitsMs. Results in the order of `entries`.
export async function downloadCourses(entries, {
  retryWaitsMs = RETRY_WAITS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
  ...options
}) {
  const results = new Array(entries.length);
  let todo = entries.map((_, i) => i);
  for (let pass = 0; ; pass++) {
    for (const i of todo) {
      try {
        results[i] = await downloadOne(entries[i], { ...options, log });
      } catch (error) {
        results[i] = { entry: entries[i], status: 'failed', code: 'ENGINE_ERROR', message: error.message, retry: true };
      }
    }
    todo = todo.filter((i) => results[i].retry);
    if (!todo.length || pass >= retryWaitsMs.length) break;
    const min = Math.max(1, Math.round(retryWaitsMs[pass] / 60_000));
    log(`\n${todo.length} course${todo.length === 1 ? '' : 's'} to try again in ${min} min: ${todo.map((i) => label(entries[i])).join(', ')}`);
    await sleep(retryWaitsMs[pass]);
  }
  return results;
}

export function resultLine(r) {
  const min = Number.isFinite(r.ms) ? ` in ${Math.max(1, Math.round(r.ms / 60_000))} min` : '';
  if (r.status === 'had') return `already complete: ${describe(r.manifest)}`;
  if (r.status === 'built') return `built${min}: ${describe(r.manifest)}`;
  if (r.status === 'incomplete') return `built${min}, still missing ${whatOf(r.needs)}${r.manifest ? ` (${describe(r.manifest)})` : ''}`;
  return `FAILED (${r.code}): ${r.message}`;
}

// The bytes of every course in dataDir that the app's course cache manages and may delete
// (lib/course-cache.js); HD holes built here are in hd-courses/<course name>/, which it
// never touches.
export function cachedCourseBytes(dataDir) {
  let names = [];
  try { names = fs.readdirSync(path.join(dataDir, 'courses')); } catch (_) { names = []; }
  let total = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    for (const p of courseFiles(dataDir, name.slice(0, -'.json'.length))) total += sizeOf(p, fs);
  }
  return total;
}

export function cacheWarning(dataDir, limitBytes = cacheLimitBytes()) {
  const bytes = cachedCourseBytes(dataDir);
  if (!Number.isFinite(limitBytes) || bytes <= limitBytes) return null;
  return `The courses in ${dataDir} come to ${mb(bytes)}, and the app keeps at most ${mb(limitBytes)} of them ` +
    '(BIRDIE_CACHE_MAX_MB): past that it deletes the least recently played (their HD holes stay). ' +
    'Set BIRDIE_CACHE_MAX_MB=0 where you play them, or run this again to put a deleted one back from the store.';
}

// The tools a solid build needs, or what is missing. { sharp, missing: [text] }
export async function checkTools({
  requireModule = require,
  importModule = (name) => import(name),
  loadHdTools = loadTools,
} = {}) {
  const missing = [];
  const firstLine = (error) => String((error && error.message) || error).split('\n')[0];
  let sharp = null;
  try { sharp = requireModule('sharp'); } catch (error) { missing.push(`sharp, for the 0.3 m aerial (${firstLine(error)})`); }
  try { await importModule('geotiff'); } catch (error) { missing.push(`geotiff, for the real trees (${firstLine(error)})`); }
  try { await loadHdTools(); } catch (error) { missing.push(`the HD tools in tools/hd-course, for 1 m HD holes (${firstLine(error)})`); }
  return { sharp, missing };
}

// The course picker's featured courses (lib/course-library.js), with the search box
// from courses/featured.json where it has one.
export function pickerFeatured({ boxes = readFeatured() } = {}) {
  const { FEATURED } = require('../lib/course-library');
  return FEATURED.map((f) => {
    const ref = parseOsmRef(f.courseId);
    const known = boxes.find((c) => c.osmType === ref.osmType && c.osmId === ref.osmId);
    return { name: f.name, ...ref, bbox: known ? known.bbox : null };
  });
}

export function parseArgs(argv) {
  const out = { names: [], file: null, featured: false, status: false, force: false, store: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status') out.status = true;
    else if (a === '--force') out.force = true;
    else if (a === '--featured') out.featured = true;
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--store') out.store = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out.names.push(a);
  }
  if ((argv.includes('--file') && !out.file) || (argv.includes('--store') && !out.store)) throw new Error('--file and --store each need a path');
  return out;
}

const USAGE = `Build courses on this computer the way the featured courses were built.

  npm run download:courses -- "Course name" relation/123 way/456
  npm run download:courses -- --file courses.txt     one name or OSM id per line
  npm run download:courses -- --featured             the course picker's featured courses

  --status      what each course has here; nothing is built
  --force       build again from scratch
  --store DIR   where the packages go (default BIRDIE_DATA_DIR/course-store)`;

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.help || (!args.names.length && !args.file && !args.featured)) {
    console.log(USAGE);
    if (!args.help) process.exitCode = 2;
    return;
  }
  const dataDir = path.resolve(process.env.BIRDIE_DATA_DIR || path.join(ROOT, 'data'));
  const storeDir = path.resolve(args.store || path.join(dataDir, STORE_DIR));
  const store = createFsStore(storeDir);

  const boxes = readFeatured();
  const featured = pickerFeatured({ boxes });
  let entries = [...args.names];
  if (args.file) {
    entries = entries.concat(fs.readFileSync(args.file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  }
  if (args.featured) entries = entries.concat(featured);
  // course search (Nominatim) only when a name needs it
  const search = async (q) => require('../lib/course').searchCourses(q);
  const courses = [];
  const seen = new Set();
  for (const entry of entries) {
    try {
      const course = await resolveCourse(entry, { search, featured: [...featured, ...boxes] });
      const key = packageKeyFor(normalizeCourseSource(course));
      if (!seen.has(key)) { seen.add(key); courses.push(course); }
    } catch (error) {
      console.error(`skipping ${JSON.stringify(entry.name || entry)}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`Data: ${dataDir} · store: ${storeDir} · ${courses.length} course${courses.length === 1 ? '' : 's'}`);

  if (args.status) {
    for (const c of courses) {
      const { course, manifest, needs } = await inspect(c, { store, dataDir });
      const what = !course && !manifest ? 'not here'
        : !needs.length ? `complete: ${describe(manifest)}`
          : `needs ${whatOf(needs)}${manifest ? ` (${describe(manifest)})` : ''}`;
      console.log(`  ${label(c)}: ${what}`);
    }
  } else {
    const tools = await checkTools();
    if (tools.missing.length) {
      console.error(`Can't build courses as solid as the featured ones without:\n${tools.missing.map((m) => `  - ${m}`).join('\n')}\n` +
        'Run `npm ci` in the repository (they are development dependencies) and try again.');
      process.exitCode = 2;
      return;
    }
    const results = await downloadCourses(courses, {
      build: createBuild({ dataDir, store, sharp: tools.sharp }),
      store,
      dataDir,
      force: args.force,
    });
    console.log('\nSummary');
    for (const r of results) console.log(`  ${label(r.entry)}: ${resultLine(r)}`);
    if (results.some((r) => r.status !== 'had' && r.status !== 'built')) process.exitCode = 1;
  }
  const warning = cacheWarning(dataDir);
  if (warning) console.warn(`\n${warning}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.stack || error.message); process.exit(1); });
}
