'use strict';
// The 1 m HD holes of a cloud build. A hole manifest in the repository that names the
// course (tools/hd-course/manifests, by its OSM course id) is used as reviewed; every
// other hole 1-18 of a course in the contiguous US is auto-pinned to the newest NAIP
// acquisition covering it (tools/hd-course/auto-pin.mjs), unless BIRDIE_CLOUD_AUTO_HD=0.
// Each is re-resolved against the course just built and compiled with the live USGS
// 3DEP + NAIP providers into BIRDIE_DATA_DIR/hd-courses, where the package picks the
// bundles up (lib/hd-bundle.js resolveHdBundles). A hole that fails (no imagery, 3DEP
// down) is skipped: the course still ships, that hole on the course-wide terrain.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const HD_DIR = path.join(__dirname, '..', 'tools', 'hd-course');
const MANIFESTS_DIR = path.join(HD_DIR, 'manifests');

// HD holes stop starting after this long, so a course with many (Chambers Bay has 18)
// still publishes inside a 45-minute Hobby sandbox session; the rest are skipped.
const HD_BUDGET_MS = 20 * 60 * 1000;

// NAIP imagery covers the contiguous US; elsewhere there is nothing to pin.
const CONUS = Object.freeze({ south: 24.4, north: 49.5, west: -125.0, east: -66.9 });
const inConus = (course) => {
  const o = course && course.origin;
  return Boolean(o) && o.lat >= CONUS.south && o.lat <= CONUS.north && o.lon >= CONUS.west && o.lon <= CONUS.east;
};

// The repository's hole manifests for a course id, in hole order ([] when the
// manifests aren't deployed, e.g. in the container image).
function hdManifestsFor(courseId, { dir = MANIFESTS_DIR } = {}) {
  if (!courseId || !fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (manifest && manifest.course && manifest.course.courseId === courseId) out.push(manifest);
    } catch (_) { /* a broken manifest is the HD tool's to report, not the build's */ }
  }
  return out.sort((a, b) => a.hole - b.hole);
}

// The holes a build gives HD, [{ hole, manifest }] in hole order: the committed
// manifests, then (auto) every other hole numbered 1-18 exactly once, with
// manifest: null (pinned when built).
function hdPlanFor(course, { dir = MANIFESTS_DIR, toolsDir = HD_DIR, auto = process.env.BIRDIE_CLOUD_AUTO_HD !== '0' } = {}) {
  if (!fs.existsSync(path.join(toolsDir, 'cli.mjs'))) return [];   // HD tools not deployed
  const committed = hdManifestsFor(course && course.source && course.source.courseId, { dir });
  const plan = committed.map((manifest) => ({ hole: manifest.hole, manifest }));
  if (auto && inConus(course)) {
    const refs = (course.holes || []).map((h) => h.ref);
    const taken = new Set(plan.map((e) => e.hole));
    for (const ref of refs) {
      if (Number.isInteger(ref) && ref >= 1 && ref <= 18 && !taken.has(ref) && refs.indexOf(ref) === refs.lastIndexOf(ref)) {
        plan.push({ hole: ref, manifest: null });
      }
    }
  }
  return plan.sort((a, b) => a.hole - b.hole);
}

async function loadTools() {
  const [cli, autoPin] = await Promise.all([
    import(pathToFileURL(path.join(HD_DIR, 'cli.mjs')).href),
    import(pathToFileURL(path.join(HD_DIR, 'auto-pin.mjs')).href),
  ]);
  return {
    buildHole: cli.discoverAndBuildHole,
    pinHole: ({ course, hole, terrain }) => autoPin.autoPinManifest({ course, hole, terrain }),
    coarseTerrain: autoPin.COARSE_TERRAIN,
  };
}

// Build each planned hole for `course` (in memory): a committed manifest as is, an
// auto hole pinned first, and rebuilt on coarser terrain where 3DEP has no 1 m lidar.
// onHole(hole, index, total) reports progress. Returns
// { built: [{hole, bundleId}], failed: [{hole, code, message}] }.
async function buildHdHoles({
  course, entries, onHole = () => {}, log = console, tools = null,
  budgetMs = HD_BUDGET_MS, now = Date.now,
}) {
  const built = [];
  const failed = [];
  let t = tools;
  if (!t) {
    try { t = await loadTools(); }
    catch (error) {
      log.warn(`[cloud] HD tools unavailable (${error.message}); no HD holes`);
      return { built, failed: entries.map((e) => ({ hole: e.hole, code: 'HD_TOOLS_UNAVAILABLE', message: error.message })) };
    }
  }
  const deadline = now() + budgetMs;
  for (let i = 0; i < entries.length; i++) {
    const { hole } = entries[i];
    if (now() > deadline) {
      failed.push({ hole, code: 'HD_TIME_BUDGET', message: 'out of time for HD holes in this build' });
      continue;
    }
    onHole(hole, i, entries.length);
    try {
      const auto = !entries[i].manifest;
      const manifest = entries[i].manifest || await t.pinHole({ course, hole });
      let result;
      try {
        result = await t.buildHole({ manifest, course });
      } catch (error) {
        if (!auto || error.code !== 'HD_3DEP_COARSE') throw error;
        // no 1 m lidar here: the same hole on the older, coarser lidar
        result = await t.buildHole({ manifest: await t.pinHole({ course, hole, terrain: t.coarseTerrain }), course });
      }
      built.push({ hole, bundleId: result.bundleId });
    } catch (error) {
      const code = (error && error.code) || 'HD_BUILD_FAILED';
      failed.push({ hole, code: String(code), message: String((error && error.message) || error).slice(0, 200) });
      log.warn(`[cloud] HD hole ${hole} skipped: ${code} ${error && error.message}`);
    }
  }
  return { built, failed };
}

module.exports = { CONUS, HD_BUDGET_MS, MANIFESTS_DIR, buildHdHoles, hdManifestsFor, hdPlanFor, inConus };
