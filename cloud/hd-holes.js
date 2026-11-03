'use strict';
// The 1 m HD holes of a cloud build. A hole manifest in the repository that names the
// course (tools/hd-course/manifests, by its OSM course id) is used as reviewed; every
// other hole 1-18 of a course in the contiguous US is auto-pinned to the newest NAIP
// acquisition covering it (tools/hd-course/auto-pin.mjs), unless BIRDIE_CLOUD_AUTO_HD=0.
// Each is re-resolved against the course just built and compiled with the live USGS
// 3DEP + NAIP providers into BIRDIE_DATA_DIR/hd-courses, where the package picks the
// bundles up (lib/hd-bundle.js resolveHdBundles). A hole that fails (no imagery, 3DEP
// down) is skipped: the course still ships, that hole on the course-wide terrain.
// Each hole is built in a process of its own (hd-hole-worker.mjs), so a hole that runs
// the machine out of memory or never comes back costs only itself: the build, and its
// heartbeat, carry on with the next hole.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const HD_DIR = path.join(__dirname, '..', 'tools', 'hd-course');
const MANIFESTS_DIR = path.join(HD_DIR, 'manifests');
const WORKER = path.join(__dirname, 'hd-hole-worker.mjs');

// HD holes stop starting after this long, so a course with many (Chambers Bay has 18)
// still publishes inside a 45-minute Hobby sandbox session; the rest are skipped.
const HD_BUDGET_MS = 20 * 60 * 1000;
// A hole normally takes 3-5 minutes; one that has not answered after this is stuck.
const HOLE_TIMEOUT_MS = 9 * 60 * 1000;

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

// One hole with the HD tools: a committed manifest as is, an auto hole pinned first,
// and pinned again on the older, coarser lidar where 3DEP has no 1 m tiles.
// Returns { bundleId }.
async function buildOneHole(t, { course, hole, manifest }) {
  const auto = !manifest;
  const m = manifest || await t.pinHole({ course, hole });
  try {
    return await t.buildHole({ manifest: m, course });
  } catch (error) {
    if (!auto || error.code !== 'HD_3DEP_COARSE') throw error;
    return t.buildHole({ manifest: await t.pinHole({ course, hole, terrain: t.coarseTerrain }), course });
  }
}

// One hole in a child process (WORKER), reading the course from coursePath: resolves
// { bundleId }, or rejects with the hole's error code. A hole that has not answered in
// timeoutMs is killed (HD_HOLE_TIMEOUT); one whose process dies without answering, out
// of memory most likely, is HD_HOLE_CRASHED. Both are worth another try later.
function runHoleInChild({ coursePath, hole, manifest }, { worker = WORKER, timeoutMs = HOLE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let answer = null;
    const child = fork(worker, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const timer = setTimeout(() => {
      answer = answer || { code: 'HD_HOLE_TIMEOUT', message: `hole ${hole} had not finished after ${Math.round(timeoutMs / 1000)} s` };
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('message', (m) => { answer = answer || m; });
    child.on('error', (error) => { answer = answer || { code: 'HD_HOLE_CRASHED', message: error.message }; });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const a = answer || { code: 'HD_HOLE_CRASHED', message: `hole ${hole}'s process ended (${signal || `exit ${code}`}) without an answer` };
      if (a.bundleId) resolve({ bundleId: a.bundleId });
      else reject(Object.assign(new Error(a.message), { code: a.code }));
    });
    try { child.send({ coursePath, hole, manifest }); } catch (_) { /* it died first: the exit says so */ }
  });
}

// Build each planned hole for `course`. onHole(hole, index, total) reports progress;
// onBuilt({hole, bundleId}) runs as each hole lands, before the next starts, so the
// caller can publish it at once. With `tools` (tests) the holes build in this process,
// else each in its own (runHole, by default runHoleInChild). Returns
// { built: [{hole, bundleId}], failed: [{hole, code, message}] }.
async function buildHdHoles({
  course, entries, onHole = () => {}, onBuilt = async () => {}, log = console, tools = null,
  runHole = runHoleInChild, budgetMs = HD_BUDGET_MS, now = Date.now,
}) {
  const built = [];
  const failed = [];
  let run;
  let cleanup = () => {};
  if (tools) {
    run = (entry) => buildOneHole(tools, { course, ...entry });
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-hd-'));
    const coursePath = path.join(dir, 'course.json');
    fs.writeFileSync(coursePath, JSON.stringify(course));
    cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    run = (entry) => runHole({ coursePath, hole: entry.hole, manifest: entry.manifest || null });
  }
  const deadline = now() + budgetMs;
  try {
    for (let i = 0; i < entries.length; i++) {
      const { hole } = entries[i];
      if (now() > deadline) {
        failed.push({ hole, code: 'HD_TIME_BUDGET', message: 'out of time for HD holes in this build' });
        continue;
      }
      onHole(hole, i, entries.length);
      let result;
      try {
        result = await run(entries[i]);
      } catch (error) {
        const code = (error && error.code) || 'HD_BUILD_FAILED';
        failed.push({ hole, code: String(code), message: String((error && error.message) || error).slice(0, 200) });
        log.warn(`[cloud] HD hole ${hole} skipped: ${code} ${error && error.message}`);
        continue;
      }
      built.push({ hole, bundleId: result.bundleId });
      try { await onBuilt({ hole, bundleId: result.bundleId }); }
      catch (error) { log.warn(`[cloud] HD hole ${hole} built, not yet published: ${error.message}`); }
    }
  } finally {
    cleanup();
  }
  return { built, failed };
}

module.exports = {
  CONUS, HD_BUDGET_MS, HOLE_TIMEOUT_MS, MANIFESTS_DIR,
  buildHdHoles, buildOneHole, hdManifestsFor, hdPlanFor, inConus, loadTools, runHoleInChild,
};
