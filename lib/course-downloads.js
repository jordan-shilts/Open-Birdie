'use strict';
// The course download engine: courses downloaded ahead of time, so they are in the
// library (and play offline) before anyone picks them.
//
// A download takes the same path as a pick (`acquire`: the local cache, then the cloud
// package when a cloud is set up, else a build on this computer from open data), so a
// downloaded course is exactly the course a pick would have loaded, and a pick of a
// course while it downloads joins the download instead of starting it again
// (lib/course.js createCourseAcquisitionCoordinator).
//
// Jobs run one at a time by default (the public OpenStreetMap servers are shared), in
// the order they were added. A failure that might pass (a busy server, the network) is
// retried twice, 1 then 2 minutes later, while the next course goes ahead; a course
// that cannot be loaded at all (not a golf course, no holes) fails at once. Nothing new
// starts while a pick is loading (yieldTo), or while the course cache is full
// (hasRoom); a download in progress carries on.
//
// The queue outlives a restart: every waiting and failed job is kept in `file`
// (BIRDIE_DATA_DIR/course-downloads.json) and picked up again by start(). Finished
// downloads stay in the list (and are protected from cache eviction, protectedKeys)
// until clearFinished() or a restart.

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteOwned } = require('./course');
const { sanitizePublicText } = require('./course-diagnostics');
const { courseCacheStem, normalizeCourseSource } = require('./course-identity');
const { parsePackageKey } = require('./course-key');

const QUEUE_FILE = 'course-downloads.json';
const FILE_VERSION = 1;
const MAX_JOBS = 200;
const RETRIES = 2;
const RETRY_BASE_MS = 60_000;
const NOTIFY_MS = 250;
const MAX_NAME = 300;
const MAX_MESSAGE = 160;
// The same request would fail the same way: no retry.
const DEFINITIVE_ERRORS = new Set([
  'COURSE_NOT_GOLF_COURSE',
  'COURSE_NOT_PLAYABLE',
  'COURSE_IDENTITY_INVALID',
  'CACHE_IDENTITY_MISMATCH',
]);

class CourseDownloadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CourseDownloadError';
    this.code = code;
  }
}

const finite = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);

// The parts of a course request worth keeping (what a pick sends: its OSM identity, and
// the search hit's name and box, the box being the extent when OSM has no outline).
// Throws CourseDownloadError for anything that is not an OSM course.
function downloadRequestOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CourseDownloadError('DOWNLOAD_INVALID', 'A download needs a course from the map (osmType and osmId)');
  }
  let source;
  try {
    source = normalizeCourseSource(input.source || {
      osmType: input.osmType,
      osmId: input.osmId,
      ...(input.courseId != null ? { courseId: input.courseId } : {}),
    });
  } catch (_) {
    throw new CourseDownloadError('DOWNLOAD_INVALID', 'A download needs a course from the map (osmType and osmId)');
  }
  const request = { osmType: source.osmType, osmId: source.osmId };
  if (typeof input.name === 'string' && input.name.trim()) request.name = input.name.trim().slice(0, MAX_NAME);
  const bbox = Array.isArray(input.bbox) && input.bbox.length === 4 ? input.bbox.map(finite) : null;
  if (bbox && bbox.every(Number.isFinite)) request.bbox = bbox;
  const lat = finite(input.lat), lon = finite(input.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    request.lat = lat;
    request.lon = lon;
  }
  return { source, request };
}

// What a failure tells the player: the loader's own words when it has them.
function describeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code.slice(0, 64) : 'DOWNLOAD_FAILED',
    message: sanitizePublicText(error?.message, 'The download failed.'),
    ...(typeof error?.recovery === 'string' ? { recovery: sanitizePublicText(error.recovery) } : {}),
  };
}

function createCourseDownloads({
  acquire,
  onInstalled = () => {},
  hasRoom = () => true,
  onChange = () => {},
  file = null,
  concurrency = 1,
  retries = RETRIES,
  retryBaseMs = RETRY_BASE_MS,
  notifyMs = NOTIFY_MS,
  now = Date.now,
  log = console,
} = {}) {
  if (typeof acquire !== 'function') throw new TypeError('The download engine needs an acquire function');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('Download concurrency must be a positive integer');

  const jobs = new Map(); // courseId -> job, in queue order
  const running = new Map(); // courseId -> { controller, promise }
  let holds = 0;
  let started = false;
  let stopped = false;
  let blocked = null; // { code, message } while the cache has no room
  let retryTimer = null;
  let notifyTimer = null;
  // bumped on every change, so a reader can tell an older snapshot from a newer one
  // (an HTTP reply and the change event can arrive in either order)
  let seq = 0;

  function publicJob(job) {
    return {
      courseId: job.courseId,
      name: job.request.name || job.courseId,
      status: job.status,
      message: job.message,
      pct: job.pct,
      attempts: job.attempts,
      error: job.error,
      retryAt: job.retryAt,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  function snapshot() {
    const list = [...jobs.values()];
    const count = (...statuses) => list.filter((j) => statuses.includes(j.status)).length;
    return {
      seq,
      jobs: list.map(publicJob),
      downloading: count('downloading'),
      waiting: count('queued', 'retrying'),
      done: count('done'),
      failed: count('failed'),
      paused: holds > 0,
      blocked,
    };
  }

  // Coalesce change reports (progress can arrive per file) into one per notifyMs.
  function changed() {
    seq += 1;
    if (notifyTimer || stopped) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      try { onChange(snapshot()); } catch (error) { log.warn(`[downloads] change report failed: ${error.message}`); }
    }, notifyMs);
    if (notifyTimer.unref) notifyTimer.unref();
  }

  function persist() {
    if (!file) return;
    const kept = [...jobs.values()].filter((j) => j.status !== 'done').map((j) => ({
      courseId: j.courseId,
      request: j.request,
      status: j.status === 'failed' ? 'failed' : 'queued',
      attempts: j.status === 'failed' ? j.attempts : 0,
      error: j.status === 'failed' ? j.error : null,
      queuedAt: j.queuedAt,
    }));
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteOwned(file, JSON.stringify({ version: FILE_VERSION, jobs: kept }));
    } catch (error) {
      log.warn(`[downloads] could not save the download queue: ${error.message}`);
    }
  }

  function load() {
    if (!file) return;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn(`[downloads] ignoring ${path.basename(file)} (${error.message})`);
      return;
    }
    if (!saved || saved.version !== FILE_VERSION || !Array.isArray(saved.jobs)) {
      log.warn(`[downloads] ignoring ${path.basename(file)} (not a download queue)`);
      return;
    }
    for (const entry of saved.jobs.slice(0, MAX_JOBS)) {
      try {
        const { source, request } = downloadRequestOf(entry && entry.request);
        if (entry.courseId !== source.courseId || jobs.has(source.courseId)) continue;
        const job = newJob(source, request, Number.isFinite(entry.queuedAt) ? entry.queuedAt : now());
        if (entry.status === 'failed') {
          job.status = 'failed';
          job.attempts = Number.isInteger(entry.attempts) && entry.attempts > 0 ? entry.attempts : 1;
          job.error = entry.error && typeof entry.error.message === 'string'
            ? describeError(entry.error) : describeError(null);
          job.message = job.error.message;
        }
        jobs.set(job.courseId, job);
      } catch (_) { /* a damaged entry is dropped */ }
    }
  }

  function newJob(source, request, queuedAt = now()) {
    return {
      courseId: source.courseId,
      key: courseCacheStem(source),
      request,
      status: 'queued',
      message: 'Waiting to download',
      pct: null,
      attempts: 0,
      error: null,
      retryAt: null,
      queuedAt,
      startedAt: null,
      finishedAt: null,
    };
  }

  function requeue(job) {
    Object.assign(job, {
      status: 'queued', message: 'Waiting to download', pct: null, attempts: 0,
      error: null, retryAt: null, startedAt: null, finishedAt: null,
    });
  }

  function nextReady() {
    const t = now();
    for (const job of jobs.values()) {
      if (job.status === 'queued' || (job.status === 'retrying' && job.retryAt <= t)) return job;
    }
    return null;
  }

  function scheduleRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (stopped) return;
    const due = [...jobs.values()].filter((j) => j.status === 'retrying').map((j) => j.retryAt);
    if (!due.length) return;
    retryTimer = setTimeout(() => { retryTimer = null; pump(); }, Math.max(0, Math.min(...due) - now()));
    if (retryTimer.unref) retryTimer.unref();
  }

  function roomLeft() {
    try { return hasRoom() !== false; } catch (error) {
      log.warn(`[downloads] cache check failed: ${error.message}`);
      return true;
    }
  }

  function pump() {
    if (!started || stopped) return;
    if (holds === 0) {
      while (running.size < concurrency) {
        const job = nextReady();
        if (!job) break;
        if (!roomLeft()) {
          if (!blocked) {
            blocked = {
              code: 'CACHE_FULL',
              message: 'The course cache is full, so the other downloads are waiting. ' +
                'Raise BIRDIE_CACHE_MAX_MB, or clear finished downloads so older courses can make room.',
            };
            log.warn('[downloads] the course cache is full; downloads are waiting');
            changed();
          }
          break;
        }
        if (blocked) { blocked = null; changed(); }
        run(job);
      }
    }
    // nothing left waiting: nothing is held up by the cache either
    if (blocked && ![...jobs.values()].some((j) => j.status === 'queued' || j.status === 'retrying')) {
      blocked = null;
      changed();
    }
    scheduleRetry();
  }

  function run(job) {
    const controller = new AbortController();
    Object.assign(job, {
      status: 'downloading', message: 'Downloading…', pct: null, error: null, retryAt: null,
      startedAt: now(), finishedAt: null,
    });
    job.attempts += 1;
    const attempt = job.attempts;
    const promise = Promise.resolve()
      .then(() => acquire({ ...job.request }, { signal: controller.signal }))
      .then((course) => {
        if (controller.signal.aborted || jobs.get(job.courseId) !== job) return;
        Object.assign(job, { status: 'done', message: 'Downloaded', pct: 100, finishedAt: now() });
        log.log(`[downloads] ${job.request.name || job.courseId}: downloaded`);
        try { onInstalled({ courseId: job.courseId, key: job.key, course }); }
        catch (error) { log.warn(`[downloads] after ${job.courseId}: ${error.message}`); }
      }, (error) => {
        // cancelled (the job is gone) or the engine stopped (the job waits for the next start)
        if (controller.signal.aborted || jobs.get(job.courseId) !== job) return;
        const reason = describeError(error);
        const definitive = DEFINITIVE_ERRORS.has(reason.code);
        if (!definitive && attempt <= retries) {
          const delay = retryBaseMs * 2 ** (attempt - 1);
          Object.assign(job, {
            status: 'retrying', error: reason, pct: null, retryAt: now() + delay, finishedAt: null,
            message: `Trying again in ${Math.max(1, Math.round(delay / 60_000))} min: ${reason.message}`.slice(0, MAX_MESSAGE),
          });
          log.warn(`[downloads] ${job.courseId}: ${reason.message}; retrying in ${Math.round(delay / 1000)} s`);
        } else {
          Object.assign(job, { status: 'failed', error: reason, pct: null, retryAt: null, finishedAt: now(), message: reason.message });
          log.warn(`[downloads] ${job.courseId}: failed (${reason.code}) ${reason.message}`);
        }
      })
      .finally(() => {
        if (running.get(job.courseId)?.controller === controller) running.delete(job.courseId);
        persist();
        changed();
        pump();
      });
    running.set(job.courseId, { controller, promise });
    persist();
    changed();
  }

  // Add one course or several. Each result is { courseId, status } (the job's status
  // after adding), or { error } for a request that is not a course.
  function add(input) {
    const inputs = Array.isArray(input) ? input : [input];
    const results = [];
    let touched = false;
    for (const one of inputs) {
      let parsed;
      try { parsed = downloadRequestOf(one); } catch (error) {
        results.push({ error: { code: error.code || 'DOWNLOAD_INVALID', message: error.message } });
        continue;
      }
      const { source, request } = parsed;
      const existing = jobs.get(source.courseId);
      if (existing) {
        // a failed or finished one is downloaded again (it may have been evicted since)
        if (existing.status === 'failed' || existing.status === 'done') {
          existing.request = { ...existing.request, ...request };
          requeue(existing);
          touched = true;
        }
        results.push({ courseId: source.courseId, status: existing.status });
        continue;
      }
      if (jobs.size >= MAX_JOBS) {
        results.push({
          courseId: source.courseId,
          error: { code: 'DOWNLOAD_QUEUE_FULL', message: `At most ${MAX_JOBS} downloads at a time: clear the finished ones first.` },
        });
        continue;
      }
      const job = newJob(source, request);
      jobs.set(job.courseId, job);
      touched = true;
      results.push({ courseId: job.courseId, status: job.status });
    }
    if (touched) {
      persist();
      changed();
      pump();
    }
    return results;
  }

  // "osm:way:123" (or the key form "osm-way-123") -> "osm:way:123", else null
  function idOf(courseId) {
    try { return parsePackageKey(courseId).courseId; } catch (_) { return null; }
  }

  return Object.freeze({
    // Load the saved queue and begin. Call once.
    start() {
      if (started) return snapshot();
      started = true;
      load();
      changed();
      pump();
      return snapshot();
    },
    add,
    // Stop and forget a download (a running one is aborted). True if there was one.
    cancel(courseId) {
      const id = idOf(courseId);
      const job = id && jobs.get(id);
      if (!job) return false;
      jobs.delete(id);
      const active = running.get(id);
      if (active) active.controller.abort();
      persist();
      changed();
      pump();
      return true;
    },
    // Try a failed (or waiting-to-retry) download again now, with fresh retries.
    retry(courseId) {
      const id = idOf(courseId);
      const job = id && jobs.get(id);
      if (!job || (job.status !== 'failed' && job.status !== 'retrying')) return false;
      requeue(job);
      persist();
      changed();
      pump();
      return true;
    },
    // Drop finished and failed downloads from the list. Returns how many.
    clearFinished() {
      let n = 0;
      for (const [id, job] of jobs) {
        if (job.status === 'done' || job.status === 'failed') { jobs.delete(id); n++; }
      }
      if (n) {
        persist();
        changed();
        pump();
      }
      return n;
    },
    // Progress of a course being loaded ({ courseId, message, pct }, the cloud client's
    // reports): shown on its job while it downloads.
    report(progress) {
      const job = progress && jobs.get(progress.courseId);
      if (!job || job.status !== 'downloading') return;
      if (typeof progress.message === 'string' && progress.message) {
        job.message = sanitizePublicText(progress.message, job.message).slice(0, MAX_MESSAGE);
      }
      if (Number.isFinite(progress.pct)) job.pct = Math.max(0, Math.min(100, progress.pct));
      changed();
    },
    // Run fn (a course pick) with nothing new starting until it settles.
    async yieldTo(fn) {
      holds += 1;
      changed();
      try {
        return await fn();
      } finally {
        holds -= 1;
        changed();
        pump();
      }
    },
    // Re-check the cache: call when room may have been made outside the engine.
    resume() {
      pump();
    },
    snapshot,
    // Cache keys the engine needs kept: finished downloads and those in progress.
    protectedKeys() {
      return [...jobs.values()].filter((j) => j.status === 'done' || j.status === 'downloading').map((j) => j.key);
    },
    // Abort what is running (it is downloaded again on the next start) and stop.
    async stop() {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (notifyTimer) clearTimeout(notifyTimer);
      retryTimer = notifyTimer = null;
      const pending = [...running.values()];
      for (const { controller } of pending) controller.abort();
      for (const job of jobs.values()) {
        if (job.status === 'downloading' || job.status === 'retrying') requeue(job);
      }
      persist();
      await Promise.allSettled(pending.map((r) => r.promise));
    },
    // Resolves once nothing is downloading (tests, shutdown).
    async settled() {
      while (running.size) await Promise.allSettled([...running.values()].map((r) => r.promise));
    },
  });
}

module.exports = {
  CourseDownloadError,
  MAX_JOBS,
  QUEUE_FILE,
  createCourseDownloads,
  downloadRequestOf,
};
