'use strict';
// The 1 m HD holes of a cloud build. Every hole manifest in the repository that names
// the course (tools/hd-course/manifests, by its OSM course id) is re-resolved against
// the course just built and compiled with the live USGS 3DEP + NAIP providers into
// BIRDIE_DATA_DIR/hd-courses, where the package picks the bundles up (lib/hd-bundle.js
// resolveHdBundles). A hole that fails (a NAIP tile replaced, 3DEP down) is skipped:
// the course still ships, that hole on the course-wide terrain.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MANIFESTS_DIR = path.join(__dirname, '..', 'tools', 'hd-course', 'manifests');
const HD_CLI = path.join(__dirname, '..', 'tools', 'hd-course', 'cli.mjs');

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

// HD holes stop starting after this long, so a course with many (Chambers Bay has 18)
// still publishes inside a 45-minute Hobby sandbox session; the rest are skipped.
const HD_BUDGET_MS = 20 * 60 * 1000;

// Build each manifest's hole for `course` (in memory). onHole(hole, index, total)
// reports progress. Returns { built: [{hole, bundleId}], failed: [{hole, code, message}] }.
async function buildHdHoles({
  course, manifests, onHole = () => {}, log = console, buildHole = null,
  budgetMs = HD_BUDGET_MS, now = Date.now,
}) {
  const built = [];
  const failed = [];
  let build = buildHole;
  if (!build) {
    try { build = (await import(pathToFileURL(HD_CLI).href)).discoverAndBuildHole; }
    catch (error) {
      log.warn(`[cloud] HD tools unavailable (${error.message}); no HD holes`);
      return { built, failed: manifests.map((m) => ({ hole: m.hole, code: 'HD_TOOLS_UNAVAILABLE', message: error.message })) };
    }
  }
  const deadline = now() + budgetMs;
  for (let i = 0; i < manifests.length; i++) {
    const manifest = manifests[i];
    if (now() > deadline) {
      failed.push({ hole: manifest.hole, code: 'HD_TIME_BUDGET', message: 'out of time for HD holes in this build' });
      continue;
    }
    onHole(manifest.hole, i, manifests.length);
    try {
      const result = await build({ manifest, course });
      built.push({ hole: manifest.hole, bundleId: result.bundleId });
    } catch (error) {
      const code = (error && error.code) || 'HD_BUILD_FAILED';
      failed.push({ hole: manifest.hole, code, message: String((error && error.message) || error).slice(0, 200) });
      log.warn(`[cloud] HD hole ${manifest.hole} skipped: ${code} ${error && error.message}`);
    }
  }
  return { built, failed };
}

module.exports = { HD_BUDGET_MS, MANIFESTS_DIR, buildHdHoles, hdManifestsFor };
