// Build courses in the cloud, ahead of anyone picking them (README "Cloud courses").
// Each course is built there once with everything the cloud adds (USGS lidar terrain,
// the NDVI classmap, OSM buildings, real trees from the canopy map, the max-quality
// aerial, nearby lakes) and kept for every desktop to download when it is picked.
//
//   npm run cloud:build-courses                      the featured courses (courses/featured.json)
//   npm run cloud:build-courses -- "Pebble Beach Golf Links" relation/9892305
//   npm run cloud:build-courses -- --file my-courses.txt   one name or OSM id per line
//
//   --status         only report which courses the cloud has
//   --force          rebuild courses the cloud already has
//   --concurrency N  builds at once (default 1; each build is its own sandbox)
//
// A name is searched on OpenStreetMap like the course picker does; an OSM id is
// relation/123, way/123 or osm:way:123. The cloud and its build token come from
// BIRDIE_CLOUD_URL / BIRDIE_CLOUD_BUILD_TOKEN or data/cloud.json, as for the desktop.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildRequestBody, cloudConfigFromEnv, createCloudClient } = require('../lib/cloud-client');
const { packageKeyFor } = require('../lib/course-key');
const { normalizeCourseSource } = require('../lib/course-identity');
const { hdManifestsFor } = require('../cloud/hd-holes');

// The holes this repository has reviewed 1 m HD manifests for (tools/hd-course/manifests);
// the cloud plans the others of a US course itself (auto-pinned).
const repoHdHoles = (course) => hdManifestsFor(normalizeCourseSource(course).courseId).map((m) => m.hole);
const packageHdHoles = (manifest) => (Array.isArray(manifest.hd) ? manifest.hd.map((h) => h.hole) : []);
const holesText = (holes) => holes.join(', ');
// [{hole, code}] -> "5, 6 (HD_NAIP_NO_COVERAGE); 13 (HD_3DEP_HTTP)"
const missingText = (missing) => {
  const byCode = new Map();
  for (const { hole, code } of missing) byCode.set(code, [...(byCode.get(code) || []), hole]);
  return [...byCode].map(([code, holes]) => `${holesText(holes)} (${code})`).join('; ');
};

// Why an HD hole can't be built that another try won't change: no imagery or lidar
// there, or no such hole.
const PERMANENT_HD = new Set(['HD_NAIP_NO_COVERAGE', 'HD_3DEP_NODATA', 'HD_3DEP_COARSE', 'HD_HOLE_NOT_FOUND', 'HD_NO_GEOMETRY', 'HD_BOUNDS_NONFINITE']);

// What to ask the cloud for a course's HD holes: null when it isn't built (a build
// plans HD itself), true to plan HD for a package from before HD planning, else the
// holes worth another try ([] = nothing to do): a reviewed manifest's hole the package
// lacks, or one that failed for a passing reason (a timeout, a 502, out of time).
export function hdRequestFor(manifest, repoHoles = []) {
  if (!manifest || !manifest.complete) return null;
  if (!Array.isArray(manifest.hdPlanned)) return true;
  const have = packageHdHoles(manifest);
  const retry = (manifest.hdMissing || []).filter((m) => !PERMANENT_HD.has(String(m.code))).map((m) => m.hole);
  return [...new Set([...retry, ...repoHoles.filter((h) => !have.includes(h))])].sort((a, b) => a - b);
}

const BUILD_TIMEOUT_MS = 45 * 60 * 1000;   // a Hobby sandbox session is at most 45 min
const MIN_POLL_MS = 5000;

// "relation/123", "way/123", "osm:way:123", "osm-relation-123" -> { osmType, osmId }; else null.
export function parseOsmRef(text) {
  const m = /^(?:osm[:-])?(node|way|relation)[/:-]([1-9][0-9]{0,15})$/.exec(String(text).trim());
  return m ? { osmType: m[1], osmId: Number(m[2]) } : null;
}

export function readFeatured(file = path.join(ROOT, 'courses', 'featured.json')) {
  const { courses } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return courses.map((c) => ({ name: c.name, ...parseOsmRef(c.osm), bbox: c.bbox || null }));
}

// A name or OSM id -> { name, osmType, osmId, bbox }; names are searched on OSM, and
// an id of a featured course takes its name and box from the featured list.
export async function resolveCourse(entry, { search, featured = [] }) {
  if (typeof entry === 'object' && entry.osmType) return entry;
  const ref = parseOsmRef(entry);
  if (ref) {
    const known = featured.find((c) => c.osmType === ref.osmType && c.osmId === ref.osmId);
    return known || { name: null, ...ref, bbox: null };
  }
  const hits = await search(entry);
  const hit = hits && hits[0];
  if (!hit) throw new Error(`no golf course found for "${entry}"`);
  return { name: hit.name, osmType: hit.osmType, osmId: hit.osmId, bbox: hit.bbox || null };
}

const label = (c) => `${(c.name || `${c.osmType}/${c.osmId}`).split(',')[0]} (${c.osmType}/${c.osmId})`;
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

// One course: skip it when the cloud has the complete package with every HD hole a
// retry could add (unless force); else ask for a build (an HD upgrade resumes from the
// package) and follow the job until it ends. Returns { course, key, status, ... }.
export async function buildOne(client, course, {
  force = false, hdHolesFor = repoHdHoles,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = console.log,
} = {}) {
  const key = packageKeyFor(normalizeCourseSource({ osmType: course.osmType, osmId: course.osmId }));
  const repoHoles = hdHolesFor(course);
  const started = now();
  const settled = (manifest) => {
    const ask = hdRequestFor(manifest, repoHoles);
    return Array.isArray(ask) && !ask.length;
  };
  const skipped = (manifest) => ({
    course, key, status: 'built', skipped: true, bytes: manifest.totalBytes, hd: packageHdHoles(manifest), hdMissing: manifest.hdMissing || [],
  });
  let hd = null;
  if (!force) {
    const manifest = await client.getManifest(key);
    if (settled(manifest)) return skipped(manifest);
    hd = hdRequestFor(manifest, repoHoles);
    if (hd === true) log(`  ${label(course)}: planning its 1 m HD holes`);
    else if (hd) log(`  ${label(course)}: adding the 1 m HD holes ${holesText(hd)}`);
  }
  const body = {
    ...buildRequestBody({ name: course.name, bbox: course.bbox }, course),
    ...(force ? { force: true } : {}),
    ...(hd ? { hd } : {}),
  };
  const reply = await client.requestBuild(body);
  if (reply.status === 'ready' && reply.manifest && reply.manifest.complete) return skipped(reply.manifest);
  let job = reply.job;
  if (!job) return { course, key, status: 'failed', message: 'the cloud started no build' };
  let last = '';
  for (;;) {
    const line = `${job.status} ${job.stage || ''}: ${job.message || ''}${Number.isFinite(job.pct) ? ` (${Math.round(job.pct)}%)` : ''}`;
    if (line !== last) { log(`  ${label(course)}: ${line}`); last = line; }
    if (job.status === 'done') {
      const manifest = await client.getManifest(key);
      return {
        course, key, status: manifest && manifest.complete ? 'built' : 'failed',
        bytes: manifest && manifest.totalBytes, hd: (job.hd && job.hd.packaged) || (manifest ? packageHdHoles(manifest) : []),
        hdMissing: (job.hd && job.hd.skipped) || (manifest && manifest.hdMissing) || [], ms: now() - started,
      };
    }
    if (job.status === 'failed') {
      return { course, key, status: 'failed', message: (job.error && job.error.message) || job.message, ms: now() - started };
    }
    if (now() - started > BUILD_TIMEOUT_MS) return { course, key, status: 'failed', message: 'timed out waiting for the build' };
    await sleep(Math.max(MIN_POLL_MS, Number(job.pollMs) || 10000));
    const next = await client.getJob(job.id);
    if (!next) return { course, key, status: 'failed', message: 'the cloud lost the build' };
    job = next;
  }
}

// Every course, `concurrency` at a time; failures don't stop the rest.
export async function buildCourses(client, courses, { concurrency = 1, ...options } = {}) {
  const results = new Array(courses.length);
  let next = 0;
  async function worker() {
    while (next < courses.length) {
      const i = next++;
      try { results[i] = await buildOne(client, courses[i], options); }
      catch (error) { results[i] = { course: courses[i], status: 'failed', message: error.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, courses.length)) }, worker));
  return results;
}

function parseArgs(argv) {
  const out = { names: [], status: false, force: false, concurrency: 1, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status') out.status = true;
    else if (a === '--force') out.force = true;
    else if (a === '--concurrency') out.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--file') out.file = argv[++i];
    else out.names.push(a);
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  const dataDir = process.env.BIRDIE_DATA_DIR || path.join(ROOT, 'data');
  const config = cloudConfigFromEnv(process.env, console, { file: path.join(dataDir, 'cloud.json') });
  if (!config) {
    console.error('No cloud configured: set BIRDIE_CLOUD_URL (and BIRDIE_CLOUD_BUILD_TOKEN), or write data/cloud.json.');
    process.exit(2);
  }
  const client = createCloudClient(config);
  let entries = args.names;
  if (args.file) {
    entries = entries.concat(fs.readFileSync(args.file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  }
  const featured = readFeatured();
  if (!entries.length) entries = featured;
  // course search (Nominatim) only when a name needs it; lib/course.js is heavy to load
  const search = async (q) => require('../lib/course').searchCourses(q);
  const courses = [];
  for (const entry of entries) {
    try { courses.push(await resolveCourse(entry, { search, featured })); }
    catch (error) { console.error(`skipping ${JSON.stringify(entry)}: ${error.message}`); }
  }

  console.log(`Cloud: ${config.baseUrl} · ${courses.length} course${courses.length === 1 ? '' : 's'}`);
  if (args.status) {
    for (const c of courses) {
      const key = packageKeyFor(normalizeCourseSource(c));
      const m = await client.getManifest(key).catch((e) => ({ error: e.message }));
      const have = m && !m.error ? packageHdHoles(m) : [];
      const hd = !m || m.error || !m.complete ? ''
        : !Array.isArray(m.hdPlanned) ? ', HD not planned yet'
          : `${have.length ? `, HD holes ${holesText(have)}` : ', no HD holes'}${m.hdMissing && m.hdMissing.length ? `; missing ${missingText(m.hdMissing)}` : ''}`;
      const what = !m ? 'not built' : m.error ? `unknown (${m.error})` : m.complete ? `built, ${mb(m.totalBytes)}${hd}` : 'base only (scenery still being added)';
      console.log(`  ${label(c)}: ${what}`);
    }
    return;
  }
  if (!config.buildToken) {
    console.error('No build token: set BIRDIE_CLOUD_BUILD_TOKEN or add "buildToken" to data/cloud.json.');
    process.exit(2);
  }
  const results = await buildCourses(client, courses, { concurrency: args.concurrency, force: args.force });
  console.log('\nSummary');
  for (const r of results) {
    const hd = `${r.hd && r.hd.length ? `, HD holes ${holesText(r.hd)}` : ''}` +
      `${r.hdMissing && r.hdMissing.length ? `; HD missing ${missingText(r.hdMissing)}` : ''}`;
    const what = r.status === 'built'
      ? `${r.skipped ? 'already built' : `built in ${Math.round((r.ms || 0) / 60000)} min`}${r.bytes ? `, ${mb(r.bytes)}` : ''}${hd}`
      : `FAILED: ${r.message}`;
    console.log(`  ${label(r.course)}: ${what}`);
  }
  if (results.some((r) => r.status !== 'built')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.stack || error.message); process.exit(1); });
}
