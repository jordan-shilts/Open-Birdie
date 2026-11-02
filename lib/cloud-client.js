'use strict';
// The desktop side of the cloud course service (cloud/server.js).
//
// With BIRDIE_CLOUD_URL set, a course that is not in the local cache is downloaded
// from the cloud as a package (lib/course-package.js: every file checked against
// its sha256) and installed into the bounded local cache instead of being built
// here. If the cloud does not have it yet, the cloud is asked to build it (needs
// BIRDIE_CLOUD_BUILD_TOKEN) and its progress is reported; the course becomes
// playable as soon as the cloud publishes the base package, and its scenery
// (buildings, trees, aerial) follows through cloudSceneryProviders. If the cloud
// cannot be reached, or the download fails verification, the course is built on
// this computer exactly as without a cloud.
//
// Nothing here is constructed, and no request is made, when BIRDIE_CLOUD_URL is
// unset (cloudConfigFromEnv returns null).
//
// Cloud API v1 (see cloud/README section in README.md):
//   GET  /v1/courses/:key                 200 package manifest | 404
//   POST /v1/courses  (Bearer token)      200 {status:'ready', manifest} | 202 {status, job}
//   GET  /v1/jobs/:id                     200 job {status, stage, message, pct, packageId, error} | 404
//   GET  /v1/courses/:key/files/:sha256   200 bytes | 302 to a presigned object URL

const fs = require('node:fs');
const { abortableDelay, isAbortError, throwIfAborted, withTimeoutSignal } = require('./abort');
const { CourseLoadError } = require('./course');
const { sanitizePublicText } = require('./course-diagnostics');
const {
  installCoursePackage,
  packageKeyFor,
  readPackageCourse,
  validatePackageManifest,
  verifyPackageFile,
} = require('./course-package');

const UA = 'Open-Birdie desktop (cloud course client)';
const REQUEST_TIMEOUT_MS = 20_000;
const FILE_TIMEOUT_MS = 10 * 60_000;
const BUILD_POLL_MS = 2_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const SCENERY_POLL_MS = 10_000;
const SCENERY_WAIT_MS = 20 * 60_000;
const M_PER_LAT = 111132.95;
// A cloud build that failed on these would fail the same way here.
const DEFINITIVE_LOAD_ERRORS = new Set(['COURSE_NOT_GOLF_COURSE', 'COURSE_NOT_PLAYABLE']);

class CloudError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
  }
}

// { baseUrl, buildToken } from BIRDIE_CLOUD_URL / BIRDIE_CLOUD_BUILD_TOKEN, else
// from `file` (cloud.json in the data dir: {"url": ..., "buildToken": ...}, so the
// desktop app keeps its cloud without environment variables), or null.
function cloudConfigFromEnv(env = process.env, log = console, { file = null } = {}) {
  let raw = String(env.BIRDIE_CLOUD_URL || '').trim();
  let token = String(env.BIRDIE_CLOUD_BUILD_TOKEN || '').trim();
  if (!raw && file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw = String(saved.url || '').trim();
      token = token || String(saved.buildToken || '').trim();
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn(`[cloud] ignoring ${file} (${error.message})`);
    }
  }
  if (!raw) return null;
  let url = null;
  try { url = new URL(raw); } catch (_) { url = null; }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    log.warn('[cloud] ignoring BIRDIE_CLOUD_URL (not an http(s) URL)');
    return null;
  }
  return { baseUrl: url.href.replace(/\/+$/, ''), buildToken: token || null };
}

function createCloudClient({
  baseUrl,
  buildToken = null,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  fileTimeoutMs = FILE_TIMEOUT_MS,
} = {}) {
  if (!baseUrl) throw new TypeError('Cloud client needs a base URL');

  async function send(pathname, { method = 'GET', body, auth = false, json = true, signal, timeout = timeoutMs } = {}) {
    throwIfAborted(signal);
    const headers = { 'User-Agent': UA };
    if (json) headers.Accept = 'application/json';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = `Bearer ${buildToken}`;
    try {
      return await fetchImpl(`${baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: withTimeoutSignal(signal, timeout),
      });
    } catch (error) {
      throwIfAborted(signal);
      throw new CloudError('CLOUD_UNAVAILABLE', `cloud unreachable (${error && error.message})`);
    }
  }

  async function readJson(res) {
    try { return await res.json(); }
    catch (_) { throw new CloudError('CLOUD_PROTOCOL', `cloud sent malformed JSON (HTTP ${res.status})`); }
  }

  function unavailable(res) {
    return new CloudError('CLOUD_UNAVAILABLE', `cloud answered HTTP ${res.status}`);
  }

  return Object.freeze({
    baseUrl,
    canBuild: Boolean(buildToken),
    // The course's package manifest, or null when the cloud has none.
    async getManifest(key, { signal } = {}) {
      const res = await send(`/v1/courses/${encodeURIComponent(key)}`, { signal });
      if (res.status === 404) return null;
      if (!res.ok) throw unavailable(res);
      const manifest = await readJson(res);
      validatePackageManifest(manifest, { key });
      return manifest;
    },
    async requestBuild(body, { signal } = {}) {
      if (!buildToken) throw new CloudError('CLOUD_AUTH', 'no BIRDIE_CLOUD_BUILD_TOKEN configured');
      const res = await send('/v1/courses', { method: 'POST', body, auth: true, signal });
      if (res.status === 401 || res.status === 403) throw new CloudError('CLOUD_AUTH', 'the cloud refused the build token');
      if (res.status === 429) throw new CloudError('CLOUD_BUSY', 'the cloud build queue is full');
      if (!res.ok) throw unavailable(res);
      return readJson(res);
    },
    async getJob(id, { signal } = {}) {
      const res = await send(`/v1/jobs/${encodeURIComponent(id)}`, { signal });
      if (res.status === 404) return null;
      if (!res.ok) throw unavailable(res);
      return readJson(res);
    },
    // Raw bytes of one package file (the caller verifies them). A 302 to a
    // presigned object-store URL is followed; no credentials are sent anywhere.
    async getFile(manifest, entry, { signal } = {}) {
      const res = await send(`/v1/courses/${encodeURIComponent(manifest.key)}/files/${entry.sha256}`, {
        json: false, signal, timeout: fileTimeoutMs,
      });
      if (!res.ok) throw new CloudError('CLOUD_UNAVAILABLE', `${entry.path}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  });
}

// While polling, a short outage (the service redeploying) is ridden out: an
// "unreachable" answer is retried with a growing pause (~40 s in all at the 2 s
// build poll) before the caller gives up on the cloud.
const POLL_RETRIES = 6;
async function withRetries(call, { signal, sleep, pollMs, retries = POLL_RETRIES }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (isAbortError(error, signal) || !error || error.code !== 'CLOUD_UNAVAILABLE' || attempt >= retries) throw error;
      await sleep(pollMs * (attempt + 1), signal);
    }
  }
}

const toNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);

// What the cloud needs to build a course: its OSM identity plus the search hit's
// name and box (the box is the fallback extent when OSM has no outline).
function buildRequestBody(request = {}, source) {
  const body = { source: { osmType: source.osmType, osmId: source.osmId } };
  if (typeof request.name === 'string' && request.name.trim()) body.name = request.name.trim().slice(0, 300);
  const bbox = Array.isArray(request.bbox) ? request.bbox.map(toNumber) : null;
  if (bbox && bbox.length === 4 && bbox.every(Number.isFinite)) body.bbox = bbox;
  const lat = toNumber(request.lat), lon = toNumber(request.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) { body.lat = lat; body.lon = lon; }
  return body;
}

// A service may ask for slower polling (a job's pollMs; on Vercel every poll is a
// metered storage read): honoured up to 30 s, never faster than this client's pace.
function pollInterval(job, pollMs) {
  const asked = Number(job && job.pollMs);
  return Number.isFinite(asked) && asked > pollMs ? Math.min(asked, 30_000) : pollMs;
}

// loadCourse's `remote` hook: (request, source, signal) -> installed course | null.
function createCloudCourseSource({
  client,
  dataDir,
  onProgress = () => {},
  onInstalled = () => {},
  pollMs = BUILD_POLL_MS,
  buildTimeoutMs = BUILD_TIMEOUT_MS,
  sleep = abortableDelay,
  now = Date.now,
  log = console,
} = {}) {
  if (!client || !dataDir) throw new TypeError('Cloud course source needs a client and a data dir');
  const report = (courseId, stage, message, extra = {}) => {
    try { onProgress({ courseId, stage, message, done: false, ...extra }); } catch (_) { /* reporting only */ }
  };

  async function waitForBuild({ key, courseId, request, source, signal }) {
    const retrying = (call) => withRetries(call, { signal, sleep, pollMs });
    const ask = () => retrying(() => client.requestBuild(buildRequestBody(request, source), { signal }));
    let reply = await ask();
    let lostOnce = false;
    const deadline = now() + buildTimeoutMs;
    for (;;) {
      if (reply && reply.status === 'ready' && reply.manifest) {
        validatePackageManifest(reply.manifest, { key });
        return reply.manifest;
      }
      let job = reply && reply.job;
      if (!job || typeof job.id !== 'string') throw new CloudError('CLOUD_PROTOCOL', 'the build request returned no job');
      for (;;) {
        const step = sanitizePublicText(job.message, job.status || 'queued').slice(0, 120);
        report(courseId, 'build', `Building in the cloud: ${step}`, Number.isFinite(job.pct) ? { pct: job.pct } : {});
        if (job.status === 'failed') {
          const e = job.error || {};
          if (DEFINITIVE_LOAD_ERRORS.has(e.code) && typeof e.message === 'string') {
            throw new CourseLoadError(e.code, e.message, typeof e.recovery === 'string' ? e.recovery : 'Try another course.');
          }
          throw new CloudError('CLOUD_BUILD_FAILED', `the cloud build failed (${e.code || 'unknown'})`);
        }
        // packageId: the playable base package is published (scenery may follow).
        if (job.status === 'done' || job.packageId) {
          const manifest = await retrying(() => client.getManifest(key, { signal }));
          if (manifest) return manifest;
          if (job.status === 'done') throw new CloudError('CLOUD_PROTOCOL', 'the build finished but its package is missing');
        }
        if (now() > deadline) throw new CloudError('CLOUD_TIMEOUT', 'the cloud build is taking too long');
        await sleep(pollInterval(job, pollMs), signal);
        // 'interrupted' (a restarting service) just keeps polling: the new
        // instance answers 404 for the job and the build is requested again.
        const next = await retrying(() => client.getJob(job.id, { signal }));
        if (!next) break; // the service restarted and forgot the job
        job = next;
      }
      const manifest = await retrying(() => client.getManifest(key, { signal }));
      if (manifest) return manifest;
      if (lostOnce) throw new CloudError('CLOUD_BUILD_FAILED', 'the cloud lost the build twice');
      lostOnce = true;
      reply = await ask();
    }
  }

  async function acquire({ request = {}, source, signal } = {}) {
    const key = packageKeyFor(source);
    const { courseId } = source;
    const buildHere = (why) => {
      log.warn(`[cloud] ${courseId}: ${why}; building it on this computer`);
      report(courseId, 'cloud', 'Cloud unavailable for this course — building it on this computer…');
      return null;
    };
    report(courseId, 'cloud', 'Looking for this course in the cloud…');
    let manifest;
    try {
      manifest = await client.getManifest(key, { signal });
      if (!manifest) {
        if (!client.canBuild) return buildHere('not in the cloud, and no build token is configured');
        report(courseId, 'build', 'Asking the cloud to build this course…');
        manifest = await waitForBuild({ key, courseId, request, source, signal });
      }
    } catch (error) {
      if (isAbortError(error, signal) || error instanceof CourseLoadError) throw error;
      return buildHere(error && error.message);
    }
    try {
      report(courseId, 'download', 'Downloading the course…', { pct: 0 });
      const installed = await installCoursePackage({
        dataDir,
        manifest,
        signal,
        fetchFile: (entry, options) => client.getFile(manifest, entry, options),
        onProgress: ({ fetchedBytes, totalBytes }) => report(courseId, 'download', 'Downloading the course…', {
          pct: totalBytes ? (100 * fetchedBytes) / totalBytes : 100,
        }),
      });
      log.log(`[cloud] installed ${key} (${(manifest.totalBytes / 1048576).toFixed(1)} MB${manifest.complete ? '' : ', scenery still coming'})`);
      try { onInstalled({ key, manifest, installed }); } catch (error) { log.warn(`[cloud] after install: ${error.message}`); }
      return installed.course;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      return buildHere(`download failed (${error && error.message})`);
    }
  }

  return Object.freeze({ acquire });
}

// Map local metres between two course origins (parseOsm's equirectangular frame).
// Exact per axis, so an axis-aligned box stays one.
function originTransform(from, to) {
  const same = from.lat === to.lat && from.lon === to.lon;
  const mPerLonFrom = 111319.49 * Math.cos((from.lat * Math.PI) / 180);
  const mPerLonTo = 111319.49 * Math.cos((to.lat * Math.PI) / 180);
  const x = (v) => (same ? v : +(((from.lon + v / mPerLonFrom) - to.lon) * mPerLonTo).toFixed(2));
  const y = (v) => (same ? v : +(((from.lat + v / M_PER_LAT) - to.lat) * M_PER_LAT).toFixed(2));
  return {
    same,
    point: ([px, py, ...rest]) => [x(px), y(py), ...rest],
    bounds: (b) => b && ({ minX: x(b.minX), minY: y(b.minY), maxX: x(b.maxX), maxY: y(b.maxY) }),
  };
}

// Scenery providers (lib/course-enrichment.js) that take each layer from the
// course's cloud package, re-projected onto the local course when the two were
// built from different OSM snapshots. An incomplete package (the cloud is still
// adding scenery) is polled until complete. The manifest's scenery summary says
// what the package holds, so the course JSON is downloaded only when needed.
// Whatever the cloud cannot supply goes to `fallback` (local providers without
// canopy: no geotiff on a cloud desktop). Use with aerialQuality 'tiled' so a
// course installed from a base package picks up the cloud's max-quality aerial.
function cloudSceneryProviders({
  client,
  fallback = {},
  pollMs = SCENERY_POLL_MS,
  waitMs = SCENERY_WAIT_MS,
  sleep = abortableDelay,
  now = Date.now,
  log = console,
} = {}) {
  const runs = new WeakMap(); // the course object of one enrichment run -> remote package

  async function fetchRemote(course, { signal, report }) {
    const key = packageKeyFor(course.source);
    let manifest = await client.getManifest(key, { signal });
    let askedToBuild = false;
    if ((!manifest || !manifest.complete) && client.canBuild) {
      askedToBuild = true;
      try { await client.requestBuild(buildRequestBody({ name: course.name }, course.source), { signal }); }
      catch (error) { if (isAbortError(error, signal)) throw error; log.warn(`[cloud] build request for ${key}: ${error.message}`); }
    }
    const deadline = now() + waitMs;
    while ((!manifest || !manifest.complete) && askedToBuild && now() < deadline) {
      if (report) report('Waiting for the cloud to finish this course…');
      await sleep(pollMs, signal);
      manifest = await withRetries(() => client.getManifest(key, { signal }), { signal, sleep, pollMs });
    }
    if (!manifest) return null;
    let packaged = null;
    return {
      manifest,
      scenery: manifest.scenery || {},
      course() {
        if (!packaged) {
          const entry = manifest.files.find((f) => f.role === 'course');
          packaged = client.getFile(manifest, entry, { signal })
            .then((bytes) => readPackageCourse(verifyPackageFile(entry, bytes), manifest));
        }
        return packaged;
      },
    };
  }

  function remoteFor(course, ctx) {
    if (!runs.has(course)) {
      runs.set(course, fetchRemote(course, ctx).catch((error) => {
        if (isAbortError(error, ctx.signal)) throw error;
        log.warn(`[cloud] scenery from the cloud unavailable: ${error && error.message}`);
        return null;
      }));
    }
    return runs.get(course);
  }

  async function fileOf(remote, role, signal) {
    const entry = remote.manifest.files.find((f) => f.role === role);
    return entry ? verifyPackageFile(entry, await client.getFile(remote.manifest, entry, { signal })) : null;
  }

  async function layerFrom(layer, remote, course, signal) {
    const has = {
      buildings: remote.scenery.buildings != null,
      water: remote.scenery.water != null,
      canopy: remote.scenery.canopyTrees != null,
      aerial: Boolean(remote.scenery.aerial),
    };
    if (!has[layer]) return null;
    const pkg = await remote.course();
    const t = originTransform(pkg.origin, course.origin);
    if (layer === 'buildings' && Array.isArray(pkg.buildings)) {
      return {
        status: 'ok', via: 'cloud',
        buildings: t.same ? pkg.buildings : pkg.buildings.map((b) => ({ ...b, poly: (b.poly || []).map(t.point) })),
      };
    }
    if (layer === 'water' && pkg.scenery && Array.isArray(pkg.scenery.water)) {
      return {
        status: 'ok', via: 'cloud',
        water: t.same ? pkg.scenery.water : pkg.scenery.water.map((w) => ({ ...w, poly: (w.poly || []).map(t.point) })),
      };
    }
    if (layer === 'canopy' && pkg.canopy && Array.isArray(pkg.canopy.trees)) {
      return { status: 'ok', via: 'cloud', canopy: { ...pkg.canopy, trees: t.same ? pkg.canopy.trees : pkg.canopy.trees.map(t.point) } };
    }
    if (layer === 'aerial' && pkg.aerial && pkg.aerial.file) {
      const buf = await fileOf(remote, 'aerial', signal);
      if (!buf) return null;
      const classBuf = pkg.aerial.classFile ? await fileOf(remote, 'classmap', signal) : null;
      return {
        status: 'ok', via: 'cloud', buf,
        bounds: t.bounds(pkg.aerial.bounds),
        quality: pkg.aerial.quality || 'single',
        classmap: classBuf ? {
          buf: classBuf,
          bounds: t.bounds(pkg.aerial.classBounds || pkg.aerial.bounds),
          stats: pkg.aerial.classStats || null,
        } : null,
      };
    }
    return null;
  }

  const provide = (layer) => async (course, ctx = {}) => {
    const remote = await remoteFor(course, ctx);
    // An aerial is only ever replaced by a better one: the cloud's tiled mosaic.
    const localAerial = layer === 'aerial' && course.aerial && course.aerial.file ? (course.aerial.quality || 'single') : null;
    if (remote && !(localAerial && remote.scenery.aerial !== 'tiled')) {
      const result = await layerFrom(layer, remote, course, ctx.signal);
      if (result) return result;
    }
    if (localAerial) return { status: 'skipped', reason: 'no better aerial in the cloud yet' };
    if (typeof fallback[layer] === 'function') return fallback[layer](course, ctx);
    return { status: 'skipped', reason: remote ? 'not in the cloud package' : 'cloud unavailable' };
  };

  return {
    buildings: provide('buildings'),
    water: provide('water'),
    canopy: provide('canopy'),
    aerial: provide('aerial'),
    classify: fallback.classify || null,
  };
}

module.exports = {
  CloudError,
  buildRequestBody,
  cloudConfigFromEnv,
  cloudSceneryProviders,
  createCloudClient,
  createCloudCourseSource,
  originTransform,
};
