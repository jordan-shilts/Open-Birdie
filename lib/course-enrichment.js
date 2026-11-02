'use strict';
// Automatic course scenery: real buildings (OSM footprints), real trees (canopy
// height data) and the course-wide aerial photo, for every course that is missing
// them — on a cache miss AND a cache hit.
//
// A course is playable as soon as its base data (holes, surfaces, terrain) is
// ready; scenery runs afterwards in the background, one layer at a time, and each
// finished layer is saved to the course cache and reported (the server then
// refreshes connected clients). Order matters: buildings first, because building
// footprints mask false tree crowns.
//
// Scenery is NON-fingerprinted (course.{buildings, canopy, aerial} are not in
// canonicalCourse), so attaching it never invalidates an HD bundle; this module
// never touches holes, surfaces, elevation or the projection origin.
//
// Where a layer comes from is pluggable ("providers"): the local providers fetch
// from the public sources directly; the cloud client (lib/cloud-client.js) supplies
// providers that download a course package's scenery instead.

const fs = require('node:fs');
const path = require('node:path');
const { isAbortError, throwIfAborted } = require('./abort');
const {
  atomicWriteOwned,
  courseBounds,
  isCurrentCourseCache,
  maybeClassify,
  readSourceKeyedCache,
} = require('./course');
const { courseCacheStem, normalizeCourseSource } = require('./course-identity');

const SCENERY_LAYERS = Object.freeze(['buildings', 'canopy', 'aerial']);
const LAYER_LABELS = Object.freeze({ buildings: 'buildings', canopy: 'real trees', aerial: 'aerial photo' });
// A source that answered "no data here" (e.g. no NAIP imagery outside the US) is
// asked again only after this long.
const NONE_RETRY_MS = 30 * 24 * 3600 * 1000;
// A failed fetch (network, busy server) is retried after this long, per process.
const FAILURE_RETRY_MS = 10 * 60 * 1000;

function sameBounds(a, b) {
  if (!a || !b) return false;
  const eq = (x, y) => Math.abs(x - y) < 1e-6;
  return eq(a.minX, b.minX) && eq(a.minY, b.minY) && eq(a.maxX, b.maxX) && eq(a.maxY, b.maxY);
}

function sameOrigin(a, b) {
  return Boolean(a && b) && a.lat === b.lat && a.lon === b.lon;
}

function isPng(buf) {
  return buf && buf[0] === 0x89 && buf[1] === 0x50;
}

// Does the course already have this layer? An empty list counts ("looked, none
// there"); an aerial is upgraded only when the caller wants the tiled quality.
function hasSceneryLayer(course, layer, { aerialQuality = 'single', now = Date.now() } = {}) {
  if (!course) return false;
  if (layer === 'buildings') return Array.isArray(course.buildings);
  if (layer === 'canopy') return Boolean(course.canopy && Array.isArray(course.canopy.trees));
  if (layer === 'aerial') {
    if (course.aerial && course.aerial.file) {
      return aerialQuality !== 'tiled' || course.aerial.quality === 'tiled';
    }
    const record = course.enrichment && course.enrichment.aerial;
    if (record && record.status === 'none') {
      const at = Date.parse(record.at);
      return Number.isFinite(at) && now - at < NONE_RETRY_MS;
    }
    return false;
  }
  throw new TypeError(`Unknown scenery layer ${layer}`);
}

function missingSceneryLayers(course, options = {}) {
  return SCENERY_LAYERS.filter((layer) => !hasSceneryLayer(course, layer, options));
}

function needsClassmap(course) {
  const a = course.aerial;
  return Boolean(a && a.file) && !(a.classFile && sameBounds(a.classBounds, a.bounds));
}

// Apply one provider result to the course (mutates it) and return the files that
// must be written next to the course JSON: [{ file, bytes }].
function applySceneryResult(course, layer, result, { stem, now = () => new Date() }) {
  const at = now().toISOString();
  const record = (entry) => {
    course.enrichment = { ...(course.enrichment || {}), [layer]: { at, ...entry } };
  };
  const artifacts = [];
  if (layer === 'buildings') {
    course.buildings = result.buildings;
    record({ status: 'ok', count: result.buildings.length, ...(result.via ? { via: result.via } : {}) });
  } else if (layer === 'canopy') {
    course.canopy = result.canopy;
    record({ status: 'ok', count: result.canopy.trees.length, ...(result.via ? { via: result.via } : {}) });
  } else if (layer === 'aerial') {
    if (result.status === 'none') {
      record({ status: 'none' });
      return artifacts;
    }
    const file = `${stem}.aerial.${isPng(result.buf) ? 'png' : 'jpg'}`;
    const previous = course.aerial || {};
    course.aerial = {
      ...previous,
      file,
      bounds: result.bounds,
      quality: result.quality || 'single',
    };
    artifacts.push({ file, bytes: result.buf });
    // a replaced photo under another name (png -> jpg) is this course's own file
    if (previous.file && previous.file !== file && previous.file.startsWith(`${stem}.aerial.`)) {
      artifacts.push({ file: previous.file, remove: true });
    }
    if (result.classmap && result.classmap.buf) {
      const classFile = `${stem}.classmap.png`;
      course.aerial.classFile = classFile;
      course.aerial.classBounds = result.classmap.bounds || result.bounds;
      if (result.classmap.stats) course.aerial.classStats = result.classmap.stats;
      artifacts.push({ file: classFile, bytes: result.classmap.buf });
    }
    record({
      status: 'ok',
      quality: course.aerial.quality,
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.via ? { via: result.via } : {}),
    });
  }
  return artifacts;
}

// Run the missing layers in order. Each provider answers { status: 'ok', ... },
// { status: 'none' } (the source has no data there), { status: 'skipped' } (cannot
// be computed here) or throws / { status: 'failed' } (retry later). After every
// applied layer onLayer({ layer, status, course, artifacts }) persists it.
async function enrichCourseScenery(course, {
  providers = {},
  layers = SCENERY_LAYERS,
  aerialQuality = 'single',
  signal,
  log = console,
  now = () => new Date(),
  shouldAttempt = () => true,
  onStart = () => {},
  onReport = () => {},
  onLayer = async () => {},
  onFailure = () => {},
  onSkip = () => {},
} = {}) {
  const stem = courseCacheStem(course.source);
  const outcome = { applied: [], none: [], skipped: [], failed: [] };
  for (const layer of SCENERY_LAYERS) {
    if (!layers.includes(layer)) continue;
    if (hasSceneryLayer(course, layer, { aerialQuality, now: now().getTime() })) continue;
    const provide = providers[layer];
    if (typeof provide !== 'function' || !shouldAttempt(layer)) {
      outcome.skipped.push(layer);
      continue;
    }
    throwIfAborted(signal);
    onStart(layer);
    let result;
    try {
      result = await provide(course, { signal, log, aerialQuality, report: (message) => onReport(layer, message) });
      if (result && result.status === 'failed') {
        throw new Error(result.reason || `${layer} source failed`);
      }
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      log.warn(`[scenery] ${LAYER_LABELS[layer]} failed: ${error && error.message}`);
      outcome.failed.push(layer);
      onFailure(layer, error);
      continue;
    }
    throwIfAborted(signal);
    if (!result || result.status === 'skipped') {
      if (result && result.reason) log.log(`[scenery] ${LAYER_LABELS[layer]} skipped: ${result.reason}`);
      outcome.skipped.push(layer);
      onSkip(layer);
      continue;
    }
    const artifacts = applySceneryResult(course, layer, result, { stem, now });
    if (layer === 'aerial' && result.status === 'ok' && needsClassmap(course) &&
        typeof providers.classify === 'function') {
      try {
        artifacts.push(...((await providers.classify(course, { signal, log })) || []));
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        log.warn(`[scenery] classmap skipped: ${error && error.message}`);
      }
    }
    (result.status === 'none' ? outcome.none : outcome.applied).push(layer);
    await onLayer({ layer, status: result.status, course, artifacts });
  }
  return outcome;
}

// Write a layer's files, then the course JSON last (the validity marker), each via
// an owned temporary + rename. Files must be plain names owned by this course.
function persistSceneryUpdate({ cacheDir, course, artifacts = [], fsImpl = fs }) {
  const source = normalizeCourseSource(course.source);
  const stem = courseCacheStem(source);
  if (!isCurrentCourseCache(course)) throw new Error('Refusing to save a course that is not a current cache');
  fsImpl.mkdirSync(cacheDir, { recursive: true });
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact.file !== 'string' || path.basename(artifact.file) !== artifact.file ||
        !artifact.file.startsWith(`${stem}.`) || artifact.file.endsWith('.json')) {
      throw new Error('Scenery artifact name is invalid');
    }
  }
  for (const artifact of artifacts) {
    if (!artifact.remove) atomicWriteOwned(path.join(cacheDir, artifact.file), artifact.bytes, { fsImpl });
  }
  atomicWriteOwned(path.join(cacheDir, `${stem}.json`), JSON.stringify(course), { fsImpl });
  for (const artifact of artifacts) {
    if (artifact.remove) {
      try { fsImpl.rmSync(path.join(cacheDir, artifact.file), { force: true }); }
      catch (_) { /* a leftover file is only wasted space */ }
    }
  }
}

// Copy the scenery fields of `from` onto `to` (the live gameplay course) when both
// are the same course in the same projection. Returns true when applied.
function applySceneryUpdate(to, from) {
  if (!to || !from || !sameOrigin(to.origin, from.origin)) return false;
  for (const key of ['buildings', 'canopy', 'aerial', 'enrichment']) {
    if (from[key] !== undefined) to[key] = from[key];
  }
  return true;
}

// Local providers: fetch every layer straight from the public sources.
//  aerialQuality 'tiled' needs `sharp` (cloud / dev); 'single' is runtime-safe.
//  canopy false: never read the canopy tiles here (the desktop with a cloud
//  configured gets canopy from the cloud, so it never imports geotiff).
function localSceneryProviders({
  aerialQuality = 'single',
  sharp = null,
  canopy = true,
  fetchImpl,
  overpassEndpoints,
  openTile,
} = {}) {
  // Required lazily so a test or tool that only needs one layer loads only that.
  const { fetchBuildings } = require('./buildings-fetch');
  const { requestCourseAerial, fetchCourseAerialTiled } = require('./aerial');
  const { fetchNdviBands } = require('./ndvi-fetch');
  return {
    async buildings(course, { signal }) {
      const buildings = await fetchBuildings(course, { signal, fetchImpl, endpoints: overpassEndpoints });
      return { status: 'ok', buildings, via: 'overpass' };
    },
    canopy: canopy ? async (course, { signal, log }) => {
      const { fetchCanopy } = require('./canopy-fetch');
      try {
        const { canopy: value, stats } = await fetchCanopy(course, { signal, log, ...(openTile ? { openTile } : {}) });
        log.log(`[scenery] canopy: ${value.trees.length} trees (${stats.crowns} crowns, ${stats.fill} fill) from ${stats.tilesRead} tile(s)`);
        return { status: 'ok', canopy: value, via: 'chm' };
      } catch (error) {
        if (error && error.code === 'CANOPY_READER_UNAVAILABLE') return { status: 'skipped', reason: error.message };
        throw error;
      }
    } : null,
    async aerial(course, { signal }) {
      const options = { origin: course.origin, bounds: courseBounds(course), signal, ...(fetchImpl ? { fetchImpl } : {}) };
      if (aerialQuality === 'tiled' && sharp) return fetchCourseAerialTiled({ ...options, sharp });
      return requestCourseAerial(options);
    },
    async classify(course, { signal }) {
      const artifacts = [];
      await maybeClassify(course, course.name, {
        signal,
        ...(fetchImpl ? { fetchBands: (o) => fetchNdviBands({ ...o, fetchImpl }) } : {}),
        writeFile(filePath, bytes) {
          artifacts.push({ file: path.basename(filePath), bytes: Buffer.from(bytes) });
        },
      });
      return artifacts;
    },
  };
}

// Background scenery for the active course: one job per course, a newer course
// cancels the others, every finished layer is saved and reported.
function createSceneryEnricher({
  cacheDir,
  providers,
  aerialQuality = 'single',
  onLayer = () => {},
  onProgress = () => {},
  onIdle = () => {},
  log = console,
  failureRetryMs = FAILURE_RETRY_MS,
  clock = Date.now,
  persist = persistSceneryUpdate,
} = {}) {
  if (!cacheDir || !providers) throw new TypeError('Scenery enricher needs a cache dir and providers');
  const jobs = new Map(); // courseId -> { controller, promise }
  const failures = new Map(); // `${courseId}|${layer}` -> when it last failed or was skipped

  function cancelOthers(courseId) {
    for (const [id, job] of jobs) if (id !== courseId) job.controller.abort();
  }

  async function run({ source, course }, controller) {
    const { signal } = controller;
    const { courseId } = source;
    let working = null;
    try { working = readSourceKeyedCache({ cacheDir, source }); }
    catch (_) { working = null; }
    if (!working) working = structuredClone(course);
    if (!isCurrentCourseCache(working) || !working.source) return null;
    const missing = missingSceneryLayers(working, { aerialQuality, now: clock() });
    if (!missing.length) return null;
    log.log(`[scenery] ${working.name ? working.name.split(',')[0] : courseId}: adding ${missing.map((l) => LAYER_LABELS[l]).join(', ')}`);
    const outcome = await enrichCourseScenery(working, {
      providers,
      aerialQuality,
      signal,
      log,
      shouldAttempt: (layer) => !(clock() - (failures.get(`${courseId}|${layer}`) ?? -Infinity) < failureRetryMs),
      onStart: (layer) => onProgress({
        courseId, stage: 'scenery', layer, done: false, message: `Adding ${LAYER_LABELS[layer]}…`,
      }),
      onReport: (layer, message) => onProgress({ courseId, stage: 'scenery', layer, done: false, message }),
      onFailure: (layer) => failures.set(`${courseId}|${layer}`, clock()),
      onSkip: (layer) => failures.set(`${courseId}|${layer}`, clock()),
      onLayer: async ({ layer, status, course: enriched, artifacts }) => {
        throwIfAborted(signal);
        persist({ cacheDir, course: enriched, artifacts });
        failures.delete(`${courseId}|${layer}`);
        if (status === 'ok') await onLayer({ courseId, layer, course: enriched });
      },
    });
    return outcome;
  }

  return Object.freeze({
    // Start (or join) the scenery job for this course. Never rejects.
    schedule({ source, course }) {
      let normalized;
      try { normalized = normalizeCourseSource(source || (course && course.source)); }
      catch (_) { return Promise.resolve(null); }
      const { courseId } = normalized;
      cancelOthers(courseId);
      const existing = jobs.get(courseId);
      if (existing && !existing.controller.signal.aborted) return existing.promise;
      const controller = new AbortController();
      const promise = run({ source: normalized, course }, controller)
        .catch((error) => {
          if (!isAbortError(error, controller.signal)) log.error(`[scenery] ${courseId}: ${error && error.message}`);
          return null;
        })
        .then((outcome) => {
          if (jobs.get(courseId)?.promise === promise) jobs.delete(courseId);
          if (outcome && !controller.signal.aborted) {
            onProgress({ courseId, stage: 'scenery', done: true, outcome, message: '' });
          }
          onIdle(courseId, outcome);
          return outcome;
        });
      jobs.set(courseId, { controller, promise });
      return promise;
    },
    cancel(courseId) {
      const job = jobs.get(courseId);
      if (job) job.controller.abort();
    },
    cancelAll() {
      for (const job of jobs.values()) job.controller.abort();
    },
    pending() {
      return [...jobs.keys()];
    },
    idle() {
      return Promise.all([...jobs.values()].map((job) => job.promise));
    },
  });
}

module.exports = {
  FAILURE_RETRY_MS,
  LAYER_LABELS,
  NONE_RETRY_MS,
  SCENERY_LAYERS,
  applySceneryResult,
  applySceneryUpdate,
  createSceneryEnricher,
  enrichCourseScenery,
  hasSceneryLayer,
  localSceneryProviders,
  missingSceneryLayers,
  needsClassmap,
  persistSceneryUpdate,
  sameOrigin,
};
