'use strict';
// One cloud build, with the same code the desktop runs:
//  1. the course's base data — OSM holes and surfaces, the course-wide 1 m USGS
//     3DEP terrain, the aerial and NDVI classmap (lib/course.js loadCourse) —
//     published at once as a playable package (complete: false), so a desktop
//     waiting on this build can start playing;
//  2. its scenery — OSM buildings, Meta/WRI canopy trees (geotiff) and the
//     max-quality tiled NAIP aerial (sharp), buildings first (lib/course-enrichment.js);
//  3. its 1 m HD holes, when the repository has hole manifests for the course
//     (`hd`, cloud/hd-holes.js);
//  4. published again as the complete package.
// The course is staged in BIRDIE_DATA_DIR (a scratch dir) and removed afterwards.
// A build whose staging is gone (restart) resumes from the published package.

const fs = require('node:fs');
const path = require('node:path');
const { readSourceKeyedCache } = require('../lib/course');
const { LAYER_LABELS, enrichCourseScenery, persistSceneryUpdate } = require('../lib/course-enrichment');
const { buildCoursePackage, installCoursePackage, parsePackageKey } = require('../lib/course-package');
const { resolveHdBundles } = require('../lib/hd-bundle');
const { blobKey, manifestKey } = require('./store');

const LAYER_PCT = Object.freeze({ buildings: 50, canopy: 65, aerial: 80 });

// Upload the files the store does not have yet, then the manifest (last, so a
// reader never sees a manifest whose files are missing).
async function publishPackage(store, { manifest, files }) {
  for (const { entry, bytes } of files) {
    const key = blobKey(manifest.key, entry.sha256);
    if (!(await store.hasBlob(key))) await store.putBlob(key, bytes, { contentType: entry.contentType });
  }
  await store.putJson(manifestKey(manifest.key), manifest);
  return manifest;
}

function removeStaging(dataDir, key) {
  for (const suffix of ['.json', '.aerial.jpg', '.aerial.png', '.classmap.png']) {
    fs.rmSync(path.join(dataDir, 'courses', `${key}${suffix}`), { force: true });
  }
  fs.rmSync(path.join(dataDir, 'hd-courses', key), { recursive: true, force: true });
}

function createCourseBuilder({
  dataDir,
  store,
  loadCourse,
  providers,
  aerialQuality = 'tiled',
  // { manifestsFor(courseId) -> hole manifests, build({course, manifests, onHole, log})
  //   -> {built, failed} } (cloud/hd-holes.js), or null for no HD holes
  hd = null,
  generator = 'open-birdie-cloud',
  keepStaging = false,
  now = () => new Date(),
  log = console,
} = {}) {
  if (!dataDir || !store || typeof loadCourse !== 'function' || !providers) {
    throw new TypeError('Course builder needs a data dir, a store, loadCourse and scenery providers');
  }
  const cacheDir = path.join(dataDir, 'courses');

  return async function buildCourse({ key, request = {}, force = false }, { update, signal }) {
    const source = parsePackageKey(key);
    const progress = (stage, message, pct) => update({ stage, message, pct });
    if (force) removeStaging(dataDir, key);

    let course = null;
    try { course = readSourceKeyedCache({ cacheDir, source }); } catch (_) { course = null; }
    let manifest = force ? null : await store.getJson(manifestKey(key));
    if (!course && manifest) {
      progress('resume', 'resuming from the published package', 5);
      course = (await installCoursePackage({
        dataDir,
        manifest,
        signal,
        fetchFile: async (entry) => store.readBlob(blobKey(key, entry.sha256)),
      })).course;
    }
    if (!course) {
      progress('base', 'fetching the map and terrain', 5);
      course = await loadCourse({ ...request, source, osmType: source.osmType, osmId: source.osmId }, { source, signal });
    }
    // Nothing published yet (a fresh build, or one resumed from staging after a
    // crash): make the course playable before the slow scenery.
    if (!manifest) {
      progress('publish', 'publishing the playable course', 40);
      manifest = await publishPackage(store, buildCoursePackage({ dataDir, source, complete: false, now, generator }));
      log.log(`[cloud] ${key}: base package ${manifest.packageId.slice(0, 12)} (${(manifest.totalBytes / 1048576).toFixed(1)} MB)`);
    }
    update({ packageId: manifest.packageId, complete: Boolean(manifest.complete) });

    const outcome = await enrichCourseScenery(course, {
      providers,
      aerialQuality,
      signal,
      log,
      onStart: (layer) => progress('scenery', `adding ${LAYER_LABELS[layer]}`, LAYER_PCT[layer]),
      onLayer: async ({ course: enriched, artifacts }) => persistSceneryUpdate({ cacheDir, course: enriched, artifacts }),
    });

    // 1 m HD holes go into dataDir/hd-courses, where the package below picks them up;
    // holes the published package already carries (installed on resume) are kept
    let hdManifests = hd ? hd.manifestsFor(source.courseId) : [];
    if (hdManifests.length) {
      const present = resolveHdBundles(course, { dataDir });
      const have = new Set(present.status === 'valid' ? present.descriptors.map((d) => d.hole) : []);
      hdManifests = hdManifests.filter((m) => !have.has(m.hole));
    }
    if (hdManifests.length) {
      const hdOutcome = await hd.build({
        course,
        manifests: hdManifests,
        log,
        onHole: (hole, i, total) => progress('hd', `adding 1 m terrain: hole ${hole} (${i + 1} of ${total})`, 85 + Math.round((i / total) * 9)),
      });
      log.log(`[cloud] ${key}: HD holes ${hdOutcome.built.map((b) => b.hole).join(', ') || 'none'}` +
        `${hdOutcome.failed.length ? `, skipped ${hdOutcome.failed.map((f) => `${f.hole} (${f.code})`).join(', ')}` : ''}`);
      // in the job record, so whoever asked can see what was skipped and why
      update({
        hd: {
          built: hdOutcome.built.map((b) => b.hole),
          skipped: hdOutcome.failed.map((f) => ({ hole: f.hole, code: f.code, message: String(f.message || '').slice(0, 160) })),
        },
      });
    }

    progress('publish', 'publishing the complete course', 95);
    const final = await publishPackage(store, buildCoursePackage({
      dataDir, source, complete: true, sceneryFailed: outcome.failed, now, generator,
    }));
    update({ packageId: final.packageId, complete: true });
    log.log(`[cloud] ${key}: complete package ${final.packageId.slice(0, 12)} — ` +
      `buildings ${final.scenery.buildings ?? '-'}, trees ${final.scenery.canopyTrees ?? '-'}, aerial ${final.scenery.aerial ?? '-'}` +
      `${outcome.failed.length ? `, failed: ${outcome.failed.join(', ')}` : ''}`);
    if (!keepStaging) removeStaging(dataDir, key);
    return { packageId: final.packageId };
  };
}

module.exports = { createCourseBuilder, publishPackage, removeStaging };
