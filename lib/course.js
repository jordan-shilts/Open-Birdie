'use strict';
// Loads real golf courses from OpenStreetMap (open data).
//  - Nominatim: free geocoder, finds the course by name
//  - Overpass API: fetches golf features (tees, fairways, greens, bunkers,
//    water, hole routing lines) inside the course bounding box
// Results are cached to data/courses/*.json so a course is fetched once.

const fs = require('fs');
const path = require('path');
const { abortableDelay, isAbortError, throwIfAborted, withTimeoutSignal } = require('./abort');
const { fetchElevationGrid, makeTerrain, fetchGreenPatches } = require('./elevation');
const { fetchCourseAerial } = require('./aerial');
const { fetchNdviBands } = require('./ndvi-fetch');
const { classifyToClassmap } = require('./classify-surfaces');
const { fitsHole, selectionReference } = require('./course-reference');
const {
  CourseIdentityError,
  courseCacheStem,
  deriveRequestedOrigin,
  legacyIdentityMatches,
  normalizeCourseSource,
} = require('./course-identity');

const UA = 'Open-Birdie/0.1 (open-source golf sim; personal use)';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Public Overpass mirrors, tried in this order (the one that answered last goes
// first). They come and go and are often at capacity, so BIRDIE_OVERPASS_URLS
// can put your own comma-separated list of interpreter URLs in front.
const PUBLIC_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

function overpassEndpoints(env = process.env) {
  const own = String(env.BIRDIE_OVERPASS_URLS || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
    .filter((url) => {
      let protocol = null;
      try { protocol = new URL(url).protocol; } catch { /* reported below */ }
      if (protocol === 'http:' || protocol === 'https:') return true;
      console.warn(`[course] ignoring BIRDIE_OVERPASS_URLS entry (not an http(s) URL): ${url}`);
      return false;
    });
  return [...new Set([...own, ...PUBLIC_OVERPASS_ENDPOINTS])];
}

const OVERPASS_ENDPOINTS = overpassEndpoints();
// A busy public mirror can accept the connection and then never answer, so
// every request gets its own deadline. A working but loaded mirror can take
// 15-30 s even for a small lookup, so the deadline has to allow that. The
// surface/feature query is the heavy one (server-side [timeout:90]), so it
// gets the full server-side budget plus transfer time.
const OVERPASS_TIMEOUT_MS = 45_000;
const OVERPASS_FEATURES_TIMEOUT_MS = 100_000;
const OVERPASS_ROUNDS = 3;
const OVERPASS_BACKOFF_MS = 2_000; // doubles each round: 2 s, 4 s
// "Busy" answers worth retrying elsewhere / later; any other status is a bad query.
const OVERPASS_RETRY_STATUS = new Set([429, 502, 503, 504]);
const NOMINATIM_TIMEOUT_MS = 15_000;
const NOMINATIM_GAP_MS = 1_100; // Nominatim usage policy: at most 1 request/second
// How far around a golf-related non-course hit (starter hut, clubhouse,
// restaurant, hamlet) to look for the course it belongs to (~1.6 km).
const NEARBY_PAD_DEG = 0.015;
const NEARBY_LOOKUPS = 2;
// Cache lives under data/ by default, overridable via BIRDIE_DATA_DIR so a
// packaged (read-only app.asar) build can redirect it to a writable per-user
// dir. main.js sets this when app.isPackaged; dev + headless keep repo data/.
const DATA_DIR = process.env.BIRDIE_DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'courses');
// Curated, version-controlled surface overrides live in the repo (NOT the
// gitignored data dir) so reconstructed holes travel with the branch. Used as a
// fallback when no machine-local override exists. See loadSurfaceOverride.
const CURATED_DIR = path.join(__dirname, '..', 'data', 'curated');
const CACHE_VERSION = 4; // v4: course-wide 1 m 3DEP base (was ~9.5 m terrarium)
const CACHE_LOCK_STALE_MS = 60_000;
const CACHE_LOCK_WAIT_MS = 30_000;
let tempNonce = 0;

class CourseCacheError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CourseCacheError';
    this.code = code;
  }

  toJSON() {
    return {
      code: this.code,
      stage: 'cache',
      recovery: 'Remove the rejected source-keyed cache entry and select the course again.',
    };
  }
}

// A load refusal whose message is written for the player and built only from
// public OpenStreetMap data, so the activation layer may show it verbatim
// (everything else is reported as a generic failure).
class CourseLoadError extends Error {
  constructor(code, message, recovery) {
    super(message);
    this.name = 'CourseLoadError';
    this.code = code;
    this.recovery = recovery;
    this.userFacing = true;
  }

  toJSON() {
    return { code: this.code, stage: 'load', recovery: this.recovery };
  }
}

function sourceMatches(a, b) {
  return a.courseId === b.courseId && a.osmType === b.osmType && a.osmId === b.osmId;
}

function ownedTempPath(finalPath, nonce = `${process.pid}-${Date.now()}-${++tempNonce}`) {
  const safeNonce = String(nonce).replace(/[^A-Za-z0-9_-]/g, '-');
  return `${finalPath}.tmp.${safeNonce}`;
}

function atomicWriteOwned(finalPath, bytes, { fsImpl = fs, nonce } = {}) {
  const temporary = ownedTempPath(finalPath, nonce);
  try {
    fsImpl.writeFileSync(temporary, bytes);
    fsImpl.renameSync(temporary, finalPath);
  } catch (error) {
    try { fsImpl.rmSync(temporary, { force: true }); } catch (_) { /* owned temporary only */ }
    throw error;
  }
}

function validCacheShape(course) {
  return course && course.version === CACHE_VERSION &&
    Array.isArray(course.holes) && course.holes.length > 0;
}

function readSourceKeyedCache({ cacheDir = CACHE_DIR, source, fsImpl = fs }) {
  const normalized = normalizeCourseSource(source);
  const file = path.join(cacheDir, `${courseCacheStem(normalized)}.json`);
  if (!fsImpl.existsSync(file)) return null;
  let cached;
  try {
    cached = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
  if (!validCacheShape(cached)) return null;
  let embedded;
  try {
    embedded = normalizeCourseSource(cached.source);
  } catch (_) {
    throw new CourseCacheError('CACHE_IDENTITY_MISMATCH', 'Source-keyed cache has invalid identity metadata');
  }
  if (!sourceMatches(embedded, normalized)) {
    throw new CourseCacheError('CACHE_IDENTITY_MISMATCH', 'Source-keyed cache identity does not match its request');
  }
  return cached;
}

function publicationLockPath(cacheDir, source) {
  return path.join(cacheDir, `.${courseCacheStem(source)}.publish.lock`);
}

function removeStalePublicationLock(lockPath, fsImpl) {
  try {
    const stat = fsImpl.statSync(lockPath);
    if (Date.now() - stat.mtimeMs <= CACHE_LOCK_STALE_MS) return false;
    fsImpl.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  }
}

function releasePublicationLock(lockPath, fsImpl) {
  try { fsImpl.rmSync(lockPath, { recursive: true, force: true }); }
  catch (_) { /* a stale-lock recovery can safely remove only this owned path */ }
}

async function acquirePublicationLock({ cacheDir, source, fsImpl = fs, signal }) {
  const lockPath = publicationLockPath(cacheDir, source);
  const deadline = Date.now() + CACHE_LOCK_WAIT_MS;
  while (true) {
    throwIfAborted(signal);
    try {
      fsImpl.mkdirSync(lockPath);
      return { lockPath, winner: null };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const winner = readSourceKeyedCache({ cacheDir, source, fsImpl });
      if (winner) return { lockPath: null, winner };
      if (!removeStalePublicationLock(lockPath, fsImpl) && Date.now() >= deadline) {
        throw new CourseCacheError('CACHE_PUBLICATION_BUSY', 'Course cache publication is busy');
      }
      await abortableDelay(10, signal);
    }
  }
}

async function publishSourceKeyedCourseCache({
  course,
  source,
  artifacts = [],
  cacheDir = CACHE_DIR,
  fsImpl = fs,
  signal,
  nonce = `${process.pid}-${Date.now()}-${++tempNonce}`,
  beforeLock,
} = {}) {
  const normalized = normalizeCourseSource(source);
  const embedded = normalizeCourseSource(course?.source);
  if (!sourceMatches(normalized, embedded) || !validCacheShape(course)) {
    throw new CourseCacheError('CACHE_IDENTITY_MISMATCH', 'Published course cache has invalid identity');
  }
  fsImpl.mkdirSync(cacheDir, { recursive: true });
  const winner = readSourceKeyedCache({ cacheDir, source: normalized, fsImpl });
  if (winner) return { status: 'existing', course: winner };

  const stem = courseCacheStem(normalized);
  const staged = [];
  const seen = new Set();
  const stage = (finalPath, bytes) => {
    const temporary = ownedTempPath(finalPath, nonce);
    staged.push({ temporary, finalPath });
    fsImpl.writeFileSync(temporary, bytes);
  };
  try {
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact.file !== 'string' ||
          path.basename(artifact.file) !== artifact.file ||
          !artifact.file.startsWith(`${stem}.`) ||
          seen.has(artifact.file) ||
          !(Buffer.isBuffer(artifact.bytes) || ArrayBuffer.isView(artifact.bytes))) {
        throw new CourseCacheError('CACHE_PUBLICATION_INVALID', 'Course cache artifact is invalid');
      }
      seen.add(artifact.file);
      stage(path.join(cacheDir, artifact.file), artifact.bytes);
    }
    const finalJson = path.join(cacheDir, `${stem}.json`);
    stage(finalJson, JSON.stringify(course));
    if (typeof beforeLock === 'function') await beforeLock();
    const acquired = await acquirePublicationLock({
      cacheDir,
      source: normalized,
      fsImpl,
      signal,
    });
    if (acquired.winner) return { status: 'existing', course: acquired.winner };
    try {
      const lateWinner = readSourceKeyedCache({ cacheDir, source: normalized, fsImpl });
      if (lateWinner) return { status: 'existing', course: lateWinner };
      throwIfAborted(signal);
      for (const entry of staged.slice(0, -1)) {
        fsImpl.renameSync(entry.temporary, entry.finalPath);
      }
      const jsonEntry = staged.at(-1);
      fsImpl.renameSync(jsonEntry.temporary, jsonEntry.finalPath);
      return { status: 'published', course };
    } finally {
      releasePublicationLock(acquired.lockPath, fsImpl);
    }
  } finally {
    for (const entry of staged) {
      try { fsImpl.rmSync(entry.temporary, { force: true }); }
      catch (_) { /* owned temporary only */ }
    }
  }
}

async function migrateLegacyCourseCache({
  request,
  source,
  cacheDir = CACHE_DIR,
  fsImpl = fs,
  signal,
  nonce = `${process.pid}-${Date.now()}-${++tempNonce}`,
}) {
  throwIfAborted(signal);
  const normalized = normalizeCourseSource(source);
  const legacyFile = path.join(cacheDir, `${slug(request.name || '')}.json`);
  if (!fsImpl.existsSync(legacyFile)) return { status: 'absent' };

  let legacy;
  try {
    legacy = JSON.parse(fsImpl.readFileSync(legacyFile, 'utf8'));
  } catch (_) {
    return { status: 'rejected', code: 'CACHE_LEGACY_MIGRATION_REJECTED' };
  }
  if (!validCacheShape(legacy) || !legacyIdentityMatches({
    requestedName: request.name,
    requestedOrigin: deriveRequestedOrigin(request),
    cachedName: legacy.name,
    cachedOrigin: legacy.origin,
    toleranceM: 250,
  })) {
    return { status: 'rejected', code: 'CACHE_LEGACY_MIGRATION_REJECTED' };
  }

  const stem = courseCacheStem(normalized);
  const course = structuredClone(legacy);
  course.source = normalized;
  const pending = [];
  let acquired = null;
  const stageCopy = (legacyName, suffix) => {
    throwIfAborted(signal);
    if (typeof legacyName !== 'string' || path.basename(legacyName) !== legacyName) {
      throw new CourseCacheError('CACHE_LEGACY_MIGRATION_REJECTED', 'Legacy cache references an unsafe artifact');
    }
    const sourcePath = path.join(cacheDir, legacyName);
    if (!fsImpl.existsSync(sourcePath)) {
      throw new CourseCacheError('CACHE_LEGACY_MIGRATION_REJECTED', 'Legacy cache references a missing artifact');
    }
    const finalPath = path.join(cacheDir, `${stem}${suffix}`);
    const temporary = ownedTempPath(finalPath, nonce);
    pending.push({ temporary, finalPath });
    fsImpl.copyFileSync(sourcePath, temporary);
    return path.basename(finalPath);
  };

  try {
    if (course.aerial && course.aerial.file) {
      course.aerial.file = stageCopy(course.aerial.file, '.aerial.jpg');
    }
    if (course.aerial && course.aerial.classFile) {
      course.aerial.classFile = stageCopy(course.aerial.classFile, '.classmap.png');
    }

    const finalJson = path.join(cacheDir, `${stem}.json`);
    const temporaryJson = ownedTempPath(finalJson, nonce);
    pending.push({ temporary: temporaryJson, finalPath: finalJson });
    fsImpl.writeFileSync(temporaryJson, JSON.stringify(course));
    acquired = await acquirePublicationLock({
      cacheDir,
      source: normalized,
      fsImpl,
      signal,
    });
    if (acquired.winner) return { status: 'migrated', course: acquired.winner };
    const lateWinner = readSourceKeyedCache({
      cacheDir,
      source: normalized,
      fsImpl,
    });
    if (lateWinner) return { status: 'migrated', course: lateWinner };
    throwIfAborted(signal);
    for (const entry of pending.slice(0, -1)) {
      fsImpl.renameSync(entry.temporary, entry.finalPath);
    }
    fsImpl.renameSync(temporaryJson, finalJson);
    return { status: 'migrated', course };
  } finally {
    if (acquired?.lockPath) releasePublicationLock(acquired.lockPath, fsImpl);
    for (const entry of pending) {
      try { fsImpl.rmSync(entry.temporary, { force: true }); } catch (_) { /* owned temporary only */ }
    }
  }
}

function createCourseAcquisitionCoordinator(acquireCourse) {
  const inFlight = new Map();
  return {
    acquire(request, options = {}) {
      const {
        abortDifferent = false,
        source: suppliedSource,
        ...acquireOptions
      } = options;
      const nestedSource = suppliedSource ?? (request && request.source);
      let source;
      if (nestedSource != null) {
        source = normalizeCourseSource(nestedSource);
        if (suppliedSource != null && request?.source != null) {
          const requestSource = normalizeCourseSource(request.source);
          if (!sourceMatches(source, requestSource)) {
            throw new CourseIdentityError('Supplied and requested OpenStreetMap sources disagree');
          }
        }
        const hasTopType = Object.prototype.hasOwnProperty.call(request, 'osmType');
        const hasTopId = Object.prototype.hasOwnProperty.call(request, 'osmId');
        const hasTopCourseId = Object.prototype.hasOwnProperty.call(request, 'courseId');
        if (hasTopType || hasTopId || hasTopCourseId) {
          if (!hasTopType || !hasTopId) {
            throw new CourseIdentityError('Duplicate OpenStreetMap source is incomplete');
          }
          const topLevelSource = normalizeCourseSource({
            osmType: request.osmType,
            osmId: request.osmId,
            ...(hasTopCourseId ? { courseId: request.courseId } : {}),
          });
          if (!sourceMatches(source, topLevelSource)) {
            throw new CourseIdentityError('Duplicate OpenStreetMap source fields disagree');
          }
        }
      } else {
        source = normalizeCourseSource(request);
      }
      const canonicalRequest = {
        ...request,
        source,
        osmType: source.osmType,
        osmId: source.osmId,
      };
      if (abortDifferent) {
        for (const [courseId, entry] of inFlight) {
          if (courseId !== source.courseId) entry.controller.abort();
        }
      }
      const existing = inFlight.get(source.courseId);
      if (existing && !existing.controller.signal.aborted) return existing.promise;
      if (existing && inFlight.get(source.courseId) === existing) {
        inFlight.delete(source.courseId);
      }
      const controller = new AbortController();
      let acquired;
      try {
        acquired = acquireCourse(canonicalRequest, {
          ...acquireOptions,
          source,
          signal: controller.signal,
        });
      } catch (error) {
        acquired = Promise.reject(error);
      }
      const promise = Promise.resolve(acquired).finally(() => {
        if (inFlight.get(source.courseId)?.promise === promise) inFlight.delete(source.courseId);
      });
      inFlight.set(source.courseId, { controller, promise });
      return promise;
    },
    inFlightCount() {
      return inFlight.size;
    },
  };
}

async function nominatim(params, { fetchImpl = fetch, signal } = {}) {
  const query = new URLSearchParams({ format: 'jsonv2', limit: '8', ...params });
  const res = await fetchImpl(`${NOMINATIM}?${query}`, {
    headers: { 'User-Agent': UA },
    signal: withTimeoutSignal(signal, NOMINATIM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({
    name: r.display_name,
    category: r.category,
    type: r.type,
    osmType: r.osm_type,
    osmId: r.osm_id,
    bbox: r.boundingbox.map(Number), // [south, north, west, east]
    lat: +r.lat, lon: +r.lon,
  }));
}

function isGolfCourseResult(r) {
  return r.type === 'golf_course' && (r.category == null || r.category === 'leisure');
}

function inBox(bbox, lat, lon) {
  const [s, n, w, e] = bbox || [];
  return lat >= s && lat <= n && lon >= w && lon <= e;
}

// The query as typed comes first. Extra wording only ever narrows toward a
// course: "<q> golf course" for a bare name ("Pebble Beach" is a hamlet), or the
// name without a trailing "golf" ("Whistling Straits golf" hits a street).
function searchVariants(q) {
  if (!/\bgolf\b/i.test(q)) return [q, `${q} golf course`];
  const stripped = q.replace(/\s+golf\s*$/i, '').trim();
  return stripped && stripped !== q ? [q, stripped] : [q];
}

function viewboxAround({ bbox, lat }) {
  const [s, n, w, e] = bbox;
  const padLon = NEARBY_PAD_DEG / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  return [w - padLon, n + NEARBY_PAD_DEG, e + padLon, s - NEARBY_PAD_DEG]
    .map((v) => v.toFixed(5)).join(',');
}

// Golf courses only, outlines first. A golf_course node inside a polygon
// result's box is that course's map pin (no outline to load), so it is dropped.
// After a nearby lookup, courses whose box holds the anchor hit lead.
function rankCourses(rows, anchor) {
  const polygons = rows.filter((r) => r.osmType !== 'node');
  const pins = rows.filter((r) => r.osmType === 'node' &&
    !polygons.some((p) => inBox(p.bbox, r.lat, r.lon)));
  const holdsAnchor = (r) => (anchor && inBox(r.bbox, anchor.lat, anchor.lon) ? 0 : 1);
  return [...polygons.sort((a, b) => holdsAnchor(a) - holdsAnchor(b)), ...pins];
}

// Nominatim matches words anywhere in an address, so a plain search can return
// the starter hut on "Golf Place" or a restaurant called "... Golf Links"
// instead of the course, and loading one of those makes a building the course.
// Only leisure=golf_course results are returned: the query as typed, then a
// light variant, then a bounded "[golf course]" search around the best
// non-course hits (a hut, clubhouse or hamlet sits on or next to its course).
async function searchCourses(query, { fetchImpl = fetch, signal, gapMs = NOMINATIM_GAP_MS } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const courses = [];
  const others = [];
  const seen = new Set();
  let requests = 0;
  const ask = async (params) => {
    if (requests++) await abortableDelay(gapMs, signal);
    for (const r of await nominatim(params, { fetchImpl, signal })) {
      const key = `${r.osmType}/${r.osmId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (isGolfCourseResult(r) ? courses : others).push(r);
    }
  };

  for (const variant of searchVariants(q)) {
    await ask({ q: variant });
    if (courses.length) return rankCourses(courses, null);
  }
  for (const anchor of others.slice(0, NEARBY_LOOKUPS)) {
    try {
      await ask({ q: '[golf course]', viewbox: viewboxAround(anchor), bounded: '1' });
    } catch (err) {
      if (isAbortError(err, signal)) throw err;
      console.error('[search] nearby golf course lookup failed:', err.message);
    }
    if (courses.length) return rankCourses(courses, anchor);
  }
  return [];
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

const FEATURES = (filter) => `
  way["golf"](${filter});
  relation["golf"](${filter});
  way["natural"="water"](${filter});
  way["natural"="sand"](${filter});
  way["leisure"="golf_course"](${filter});
  relation["leisure"="golf_course"](${filter});
  node["natural"="tree"](${filter});
  way["natural"="wood"](${filter});
  relation["natural"="wood"](${filter});
  way["landuse"="forest"](${filter});`;

// The mirror that answered last is tried first, so when one is down or hung the
// three queries of a course load don't each pay for it again.
let preferredOverpass = null;

const isOverpassRuntimeError = (data) => Boolean(data) && typeof data.remark === 'string' &&
  /runtime error|timed? ?out|too busy|out of memory/i.test(data.remark) &&
  !(Array.isArray(data.elements) && data.elements.length);

async function overpass(q, {
  fetchImpl = fetch,
  signal,
  endpoints = OVERPASS_ENDPOINTS,
  timeoutMs = OVERPASS_TIMEOUT_MS,
  rounds = OVERPASS_ROUNDS,
  backoffMs = OVERPASS_BACKOFF_MS,
} = {}) {
  throwIfAborted(signal);
  const order = endpoints.includes(preferredOverpass)
    ? [preferredOverpass, ...endpoints.filter((e) => e !== preferredOverpass)]
    : [...endpoints];
  const failures = new Map(); // host -> latest reason
  const hung = new Set();
  for (let round = 0; round < rounds && hung.size < order.length; round++) {
    if (round) await abortableDelay(backoffMs * 2 ** (round - 1), signal);
    for (const endpoint of order) {
      if (hung.has(endpoint)) continue;
      const host = new URL(endpoint).host;
      const attempt = withTimeoutSignal(signal, timeoutMs);
      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(q),
          signal: attempt,
        });
        if (res.ok) {
          const data = await res.json();
          // A mirror too busy for this caller (out of slots for its IP, which cloud
          // machines share) still answers 200, with a runtime-error remark and no
          // elements. That is not "nothing here": try the next mirror.
          if (isOverpassRuntimeError(data)) {
            failures.set(host, `busy (${String(data.remark).slice(0, 80)})`);
            continue;
          }
          preferredOverpass = endpoint;
          return data;
        }
        failures.set(host, `HTTP ${res.status}`);
        // 429/502/503/504 = busy mirror: try the next one, then back off.
        // Anything else is most likely a bad query, which no mirror will fix.
        if (!OVERPASS_RETRY_STATUS.has(res.status)) {
          const detail = (await res.text().catch(() => '')).slice(0, 200);
          throw Object.assign(new Error(`Overpass ${res.status} at ${host}: ${detail}`), { fatal: true });
        }
      } catch (err) {
        throwIfAborted(signal); // the caller gave up: stop now
        if (err.fatal) throw err;
        if (attempt.aborted) {
          // Hung mirror: skip it for the rest of this call instead of waiting again.
          hung.add(endpoint);
          failures.set(host, `no reply in ${Math.round(timeoutMs / 1000)} s`);
        } else {
          failures.set(host, err.message);
        }
      }
    }
  }
  const detail = [...failures].map(([host, why]) => `${host}: ${why}`).join('; ');
  throw new CourseLoadError(
    'OVERPASS_UNAVAILABLE',
    `OpenStreetMap's Overpass servers are busy or not responding (${detail || 'no mirrors tried'}).`,
    'Wait a few minutes and pick the course again.',
  );
}

async function loadCourseUncoordinated(request, options = {}) {
  const { name, bbox, lat, lon } = request;
  const source = normalizeCourseSource(options.source || request.source || request);
  const { osmType, osmId } = source;
  const { signal } = options;
  throwIfAborted(signal);
  if (options.preloadedCourse) {
    const preloadedSource = normalizeCourseSource(options.preloadedCourse.source);
    if (!sourceMatches(source, preloadedSource) ||
        !Array.isArray(options.preloadedCourse.holes) ||
        options.preloadedCourse.holes.length === 0) {
      throw new CourseCacheError(
        'CACHE_IDENTITY_MISMATCH',
        'Preloaded course cache has invalid identity',
      );
    }
    return options.preloadedCourse;
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const stem = courseCacheStem(source);
  const cached = readSourceKeyedCache({ source });
  if (cached) return cached;
  const migrated = await migrateLegacyCourseCache({
    request: { name, bbox, lat, lon },
    source,
    signal,
  });
  if (migrated.status === 'migrated') return migrated.course;

  // A prebuilt package from the cloud service (lib/cloud-client.js), installed into
  // this cache, instead of building the course here. null = the cloud cannot
  // supply it (unconfigured, unreachable, failed download): build it here.
  if (typeof options.remote === 'function') {
    const remote = await options.remote({ request, source, signal });
    throwIfAborted(signal);
    if (remote) return remote;
  }

  // The course's own OSM polygon is the ground truth: hole routings are taken
  // strictly inside it (poly filter), so adjacent courses on shared land
  // (e.g. St Andrews Links) don't leak in. Surfaces/trees come from the padded
  // bbox so neighboring fairways still render as scenery.
  // The selected feature must BE the golf course: a search hit can be the
  // starter hut or clubhouse, whose 3 m outline would make every shot OB.
  let outline = null;
  let feature = null;
  try { feature = await fetchSelectedFeature(osmType, osmId, { signal }); }
  catch (err) {
    // Overpass down: the feature query below would fail the same way, and an
    // unverified feature must not be loaded, so stop with the clear message.
    if (isAbortError(err, signal) || err.code === 'OVERPASS_UNAVAILABLE') throw err;
    console.error('[course] outline fetch failed:', err.message);
  }
  if (feature) {
    if (!isGolfCourseTags(feature.tags)) throw notAGolfCourseError(source, feature.tags, name);
    outline = feature.ring;
  }

  const padLat = 0.002, padLon = 0.003;
  let s, n, w, e;
  if (outline) {
    const lats = outline.map((g) => g.lat), lons = outline.map((g) => g.lon);
    s = Math.min(...lats) - padLat; n = Math.max(...lats) + padLat;
    w = Math.min(...lons) - padLon; e = Math.max(...lons) + padLon;
  } else if (bbox) {
    s = bbox[0] - padLat; n = bbox[1] + padLat; w = bbox[2] - padLon; e = bbox[3] + padLon;
  } else {
    throw new Error('course not found (no outline and no bounding box)');
  }
  const osm = await overpass(
    `[out:json][timeout:90];\n(${FEATURES(`${s},${w},${n},${e}`)}\n);\nout tags geom;`,
    { signal, timeoutMs: OVERPASS_FEATURES_TIMEOUT_MS },
  );

  if (outline) {
    const step = Math.ceil(outline.length / 150);
    const polyStr = outline.filter((_, i) => i % step === 0).map((g) => `${g.lat} ${g.lon}`).join(' ');
    try {
      const inPoly = await overpass(
        `[out:json][timeout:60];way["golf"="hole"](poly:"${polyStr}");out tags geom;`,
        { signal },
      );
      if (inPoly.elements.length) {
        osm.elements = osm.elements
          .filter((el) => (el.tags || {}).golf !== 'hole')
          .concat(inPoly.elements);
      }
    } catch (err) {
      if (isAbortError(err, signal)) throw err;
      console.error('[course] poly hole query failed, keeping bbox holes:', err.message);
    }
  }

  const course = parseOsm(osm, name, outline, source);
  const cacheArtifacts = [];

  // real elevation (best effort — flat terrain if the fetch fails)
  try {
    const b = courseBounds(course);
    const mPerLat = 111132.95;
    const mPerLon = 111319.49 * Math.cos(course.origin.lat * Math.PI / 180);
    course.elevation = await fetchElevationGrid({
      lat0: course.origin.lat, lon0: course.origin.lon, mPerLat, mPerLon, ...b,
    }, { signal });
    // High-res LIDAR relief on greens (USGS 3DEP; [] outside the US — a pure
    // enhancement layered on the base grid). A LIDAR hiccup must never drop the
    // working base elevation, so it gets its own guard.
    if (course.elevation) {
      try {
        course.elevation.patches = await fetchGreenPatches({
          lat0: course.origin.lat, lon0: course.origin.lon, mPerLat, mPerLon,
          baseM: course.elevation.baseM,
          greens: course.surfaces.filter((s) => s.kind === 'green'),
          baseH: makeTerrain(course.elevation).h,
        }, { signal });
      } catch (e) {
        if (isAbortError(e, signal)) throw e;
        console.error('[lidar] green patches skipped:', e.message);
        course.elevation.patches = [];
      }
    }
  } catch (err) {
    if (isAbortError(err, signal)) throw err;
    console.error('[elevation] falling back to flat terrain:', err.message);
    course.elevation = null;
  }

  // Course-wide aerial photo (best-effort; failure => procedural turf). One
  // NAIPPlus request — runtime-safe, no image deps. A pre-existing manual/tiled
  // 0.3 m aerial is only reachable on a cache HIT (which returns earlier), so this
  // never clobbers it. Non-fingerprinted scenery, so it never invalidates a bundle.
  try {
    const aer = await fetchCourseAerial({
      origin: course.origin,
      bounds: courseBounds(course),
      signal,
    });
    if (aer) {
      throwIfAborted(signal);
      const aname = `${stem}.aerial.jpg`;
      cacheArtifacts.push({ file: aname, bytes: aer.buf });
      course.aerial = { file: aname, bounds: aer.bounds };
      console.log(`[aerial] ${aname} (${(aer.buf.length / 1024) | 0} KB)`);
    }
  } catch (e) {
    if (isAbortError(e, signal)) throw e;
    console.error('[aerial] skipped:', e.message);
  }

  // Runtime NDVI classmap (best-effort; no-op unless the aerial exists, so it shares
  // the drape's metre bounds). Cache-miss only, exactly like the aerial. Extracted
  // to maybeClassify so the wiring is testable with injected deps; never throws.
  await maybeClassify(course, name, {
    signal,
    writeFile(filePath, bytes) {
      cacheArtifacts.push({
        file: path.basename(filePath),
        bytes: Buffer.from(bytes),
      });
    },
  });

  // Stage every source-keyed artifact, serialize publication across processes,
  // recheck for a late winner, and publish JSON last as the validity marker.
  throwIfAborted(signal);
  const publication = await publishSourceKeyedCourseCache({
    course,
    source,
    artifacts: cacheArtifacts,
    signal,
  });
  return publication.course;
}

const courseAcquisition = createCourseAcquisitionCoordinator(loadCourseUncoordinated);

function loadCourse(request, options = {}) {
  return courseAcquisition.acquire(request, options);
}

// Runtime NDVI surface classmap for a course that already has an aerial. Best-effort
// and MUST NEVER throw out of loadCourse: any failure (NIR fetch null, safeguard
// abort, bad input, disk error) degrades to "no classmap = OSM-only ground". Only
// mutates course.aerial AFTER a successful write, so a failed write never leaves a
// classFile pointing at a file that isn't there. Deps are injected for testing; the
// defaults are the real fetch/classify/fs used at load time.
async function maybeClassify(course, name, {
  fetchBands = fetchNdviBands,
  classify = classifyToClassmap,
  writeFile = (p, buf) => atomicWriteOwned(p, buf),
  signal,
} = {}) {
  throwIfAborted(signal);
  if (!course.aerial) return;
  try {
    const nb = await fetchBands({
      origin: course.origin,
      bounds: courseBounds(course),
      signal,
    });
    if (!nb) { console.log('[classify] skipped: NIR fetch failed'); return; }
    throwIfAborted(signal);
    const { pngBuffer, stats, aborted } = classify({
      bands: nb.bands, width: nb.width, height: nb.height,
      bounds: course.aerial.bounds, boundary: course.boundary, surfaces: course.surfaces,
    });
    if (!pngBuffer) {
      const s = stats && stats.mownPct != null
        ? ` (mown ${(stats.mownPct * 100).toFixed(1)}% sand ${(stats.sandPct * 100).toFixed(1)}%)` : '';
      console.log(`[classify] skipped: ${aborted ? 'safeguard abort' : 'no classmap'}${s}`);
      return;
    }
    const cname = course.source
      ? `${courseCacheStem(course.source)}.classmap.png`
      : `${slug(name)}.classmap.png`;
    throwIfAborted(signal);
    writeFile(path.join(CACHE_DIR, cname), pngBuffer);   // write BEFORE mutating course.aerial
    course.aerial.classFile = cname;
    course.aerial.classBounds = course.aerial.bounds;    // staleness key (see Task 4)
    course.aerial.classStats = stats;
    console.log(`[classify] ${cname} — mown ${(stats.mownPct * 100).toFixed(1)}% sand ${(stats.sandPct * 100).toFixed(1)}%`);
  } catch (e) {
    if (isAbortError(e, signal)) throw e;
    console.error('[classify] skipped:', e.message);
  }
}

function isGolfCourseTags(tags) {
  return Boolean(tags) && tags.leisure === 'golf_course';
}

function notAGolfCourseError(source, tags = {}, requestedName = '') {
  const label = tags.name || String(requestedName || '').split(',')[0].trim() || source.courseId;
  const key = ['building', 'amenity', 'shop', 'tourism', 'highway', 'place', 'leisure', 'golf', 'natural', 'landuse']
    .find((k) => tags[k]);
  const mapped = key ? `is mapped as ${key}=${tags[key]}` : 'is not mapped';
  return new CourseLoadError(
    'COURSE_NOT_GOLF_COURSE',
    `"${label}" (OSM ${source.osmType} ${source.osmId}) ${mapped}, not as a golf course ` +
      '(leisure=golf_course), so it cannot be loaded as one.',
    'Search again and pick a result marked "golf course".',
  );
}

// The selected OSM feature: its tags (to check it IS a golf course) and, for a
// way/relation, its outer ring (the course outline). null if OSM has no such feature.
async function fetchSelectedFeature(osmType, osmId, { signal } = {}) {
  const r = await overpass(
    `[out:json][timeout:25];${osmType}(${osmId});out tags geom;`,
    { signal },
  );
  const el = r.elements && r.elements[0];
  if (!el) return null;
  return { tags: el.tags || {}, ring: outerRing(el) };
}

function outerRing(el) {
  let ring = null;
  if (el.type === 'way') ring = el.geometry;
  else if (el.type === 'relation') {
    let bestLen = 0;
    for (const m of el.members || []) {
      if ((m.role === 'outer' || !m.role) && m.geometry && m.geometry.length > bestLen) {
        bestLen = m.geometry.length; ring = m.geometry;
      }
    }
  }
  return ring && ring.length >= 4 ? ring : null;
}

function courseBounds(course) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (pts) => {
    for (const [x, y] of pts || []) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  };
  for (const s of course.surfaces) eat(s.poly);
  for (const h of course.holes) eat(h.line);
  eat(course.boundary);
  if (!isFinite(minX)) throw new Error('no geometry for bounds');
  return { minX, minY, maxX, maxY };
}

function parseOsm(osm, name, outline, source = null) {
  // collect every coordinate to find the projection origin
  const allCoords = [];
  const collect = (geom) => { for (const g of geom || []) allCoords.push(g); };
  for (const el of osm.elements) {
    if (el.type === 'way') collect(el.geometry);
    else if (el.type === 'relation') for (const m of el.members || []) collect(m.geometry);
  }
  if (!allCoords.length) throw new Error('No OSM data found in this area.');
  let lat0 = 0, lon0 = 0;
  for (const c of allCoords) { lat0 += c.lat; lon0 += c.lon; }
  lat0 /= allCoords.length; lon0 /= allCoords.length;

  const mPerLat = 111132.95;
  const mPerLon = 111319.49 * Math.cos(lat0 * Math.PI / 180);
  const proj = (c) => [
    +((c.lon - lon0) * mPerLon).toFixed(2),
    +((c.lat - lat0) * mPerLat).toFixed(2),
  ];

  const surfaces = [];   // {kind, poly: [[x,y],...]}
  const holeLines = [];  // {ref, par, name, line: [[x,y],...]}
  const trees = [];      // individual trees: [x,y]
  const woods = [];      // wooded-area polygons
  let boundary = outline ? outline.map(proj) : null;

  const addPoly = (kind, geometry) => {
    if (!geometry || geometry.length < 3) return;
    surfaces.push({ kind, poly: geometry.map(proj) });
  };

  const kindOf = (tags) => {
    const g = tags.golf;
    if (g === 'green') return 'green';
    if (g === 'tee') return 'tee';
    if (g === 'fairway') return 'fairway';
    if (g === 'bunker' || tags.natural === 'sand') return 'bunker';
    if (g === 'rough' || g === 'semi_rough') return 'rough';
    if (g === 'water_hazard' || g === 'lateral_water_hazard' || tags.natural === 'water') return 'water';
    if (g === 'driving_range') return 'range';
    return null;
  };

  const isWood = (tags) => tags.natural === 'wood' || tags.landuse === 'forest';

  for (const el of osm.elements) {
    const tags = el.tags || {};
    if (el.type === 'node') {
      if (tags.natural === 'tree' && el.lat != null) trees.push(proj(el));
    } else if (el.type === 'way') {
      if (isWood(tags)) {
        if ((el.geometry || []).length >= 3) woods.push(el.geometry.map(proj));
      } else if (tags.golf === 'hole') {
        holeLines.push({
          ref: parseInt(tags.ref, 10) || null,
          par: parseInt(tags.par, 10) || null,
          name: tags.name || null,
          line: (el.geometry || []).map(proj),
        });
      } else if (tags.leisure === 'golf_course') {
        if (!boundary) boundary = (el.geometry || []).map(proj);
      } else {
        const k = kindOf(tags);
        if (k) addPoly(k, el.geometry);
      }
    } else if (el.type === 'relation') {
      const k = tags.leisure === 'golf_course' ? 'boundary' : isWood(tags) ? 'wood' : kindOf(tags);
      if (!k) continue;
      for (const m of el.members || []) {
        if (m.role === 'outer' || !m.role) {
          if (k === 'boundary') { if (!boundary) boundary = (m.geometry || []).map(proj); }
          else if (k === 'wood') { if ((m.geometry || []).length >= 3) woods.push(m.geometry.map(proj)); }
          else addPoly(k, m.geometry);
        }
      }
    }
  }

  if (!holeLines.length) {
    const kinds = [...new Set(surfaces.map((s) => s.kind))].join(', ') || 'none';
    throw new CourseLoadError(
      'COURSE_NOT_PLAYABLE',
      `This course has no hole routing lines (golf=hole) mapped in OpenStreetMap, so it isn't playable. ` +
      `Features found: ${kinds}.`,
      'Try another course (St Andrews, Pebble Beach, and most famous courses are fully mapped).',
    );
  }

  // Build playable holes: tee = line start, pin = line end (snapped to its green)
  const greens = surfaces.filter((s) => s.kind === 'green');
  const holes = selectRound(holeLines.filter((h) => h.line.length >= 2), selectionReference(source))
    .map((h) => {
      const tee = h.line[0];
      let pin = h.line[h.line.length - 1];
      // keep the mapped pin if it already sits on a green (handles double
      // greens, where the shared green's centroid would be the wrong spot)
      const onGreen = greens.some((g) => pointInPoly(pin[0], pin[1], g.poly));
      if (!onGreen) {
        let best = null, bestD = 80 * 80;
        for (const g of greens) {
          const c = centroid(g.poly);
          const d = (c[0] - pin[0]) ** 2 + (c[1] - pin[1]) ** 2;
          if (d < bestD) { bestD = d; best = c; }
        }
        if (best) pin = best;
      }
      const lenM = polylineLen(h.line);
      const lenYd = lenM / 0.9144;
      const par = h.par || (lenYd < 250 ? 3 : lenYd < 471 ? 4 : 5);
      return { ref: h.ref, par, name: h.name, tee, pin, line: h.line, lengthYd: Math.round(lenYd) };
    });

  // holeLines existed but none survived (all <2 points / selectRound dropped them).
  // A zero-hole course makes get hole() undefined -> state()/handleShot throw, so
  // refuse it here rather than let it become the active course.
  if (!holes.length) {
    throw new CourseLoadError(
      'COURSE_NOT_PLAYABLE',
      'This course has hole routing lines in OpenStreetMap but none are playable (each needs at least 2 points).',
      'Try another course.',
    );
  }

  return {
    version: CACHE_VERSION,
    name,
    ...(source ? { source: normalizeCourseSource(source) } : {}),
    origin: { lat: lat0, lon: lon0 },
    surfaces,
    boundary,
    holes,
    trees,
    woods,
  };
}

// When an area contains several courses (e.g. St Andrews Links), the fetch
// returns holes from all of them, with duplicate ref numbers. A real round
// chains together: hole N's tee is a short walk from hole N-1's green. Pick,
// per ref, the candidate that minimizes total green->next-tee distance.
// With a researched scorecard (lib/course-reference.js, by number), only the
// candidates that could be that hole (its par, a tee's length) are chained, and
// over the whole round rather than greedily, so a resort mapped as one outline
// (Bandon Dunes) doesn't get a mix of its courses.
function selectRound(holeLines, reference = null) {
  const byRef = new Map();
  for (const h of holeLines) {
    const r = h.ref || 0;
    if (!byRef.has(r)) byRef.set(r, []);
    byRef.get(r).push(h);
  }
  const refs = [...byRef.keys()].filter((r) => r > 0).sort((a, b) => a - b);
  if (!refs.length) return holeLines;                    // unnumbered: keep all
  if (refs.every((r) => byRef.get(r).length === 1)) {    // one course: trivial
    return refs.map((r) => byRef.get(r)[0]);
  }
  if (reference) {
    for (const r of refs) {
      const want = reference.get(r);
      if (!want) continue;
      const fits = byRef.get(r).filter((c) => fitsHole({ par: c.par, lengthYd: polylineLen(c.line) / 0.9144 }, want));
      if (fits.length) byRef.set(r, fits);             // none fit: keep them all
    }
    return shortestChain(refs.map((r) => byRef.get(r)));
  }
  let best = null, bestCost = Infinity;
  for (const start of byRef.get(refs[0])) {
    const chain = [start];
    let cost = 0, cur = start;
    for (let i = 1; i < refs.length; i++) {
      const end = cur.line[cur.line.length - 1];
      let pick = null, pd = Infinity;
      for (const c of byRef.get(refs[i])) {
        const d = Math.hypot(c.line[0][0] - end[0], c.line[0][1] - end[1]);
        if (d < pd) { pd = d; pick = c; }
      }
      chain.push(pick); cost += pd; cur = pick;
    }
    if (cost < bestCost) { bestCost = cost; best = chain; }
  }
  return best;
}

// The round with the least walking from each green to the next tee over every
// choice of candidates: per hole number, the cheapest chain ending at each candidate.
function shortestChain(stages) {
  let chains = stages[0].map((c) => ({ cost: 0, path: [c] }));
  for (let i = 1; i < stages.length; i++) {
    chains = stages[i].map((c) => {
      let best = null;
      for (const prev of chains) {
        const line = prev.path[prev.path.length - 1].line;
        const green = line[line.length - 1];
        const cost = prev.cost + Math.hypot(c.line[0][0] - green[0], c.line[0][1] - green[1]);
        if (!best || cost < best.cost) best = { cost, path: [...prev.path, c] };
      }
      return best;
    });
  }
  return chains.reduce((a, b) => (b.cost < a.cost ? b : a)).path;
}

function centroid(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

function polylineLen(line) {
  let d = 0;
  for (let i = 1; i < line.length; i++) {
    d += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  }
  return d;
}

// point-in-polygon (ray cast)
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// shortest distance from a point to a line segment
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// shortest distance from a point to a polygon's edges
function distToPolyEdges(x, y, poly) {
  let min = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = distToSeg(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
    if (d < min) min = d;
  }
  return min;
}

// Surface lookup with priority: water > bunker > green > tee > fairway > rough
const PRIORITY = ['water', 'bunker', 'green', 'tee', 'fairway'];
// A ball is only out of bounds when it's this far OUTSIDE the course outline.
// The OSM leisure=golf_course polygon is a rough property edge, not surveyed OB
// stakes, so a buffer keeps near-misses in play instead of phantom OBs.
const BOUNDARY_BUFFER_M = 15;
// Even a 9-hole pitch-and-putt covers several hectares; an outline smaller
// than this is a mis-selected feature (e.g. a 3 m starter hut), not a course.
const MIN_BOUNDARY_AREA_M2 = 10_000;

function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  }
  return Math.abs(a) / 2;
}

// Why course.boundary can't be trusted as the OB line, or null if it can.
// It must be a real polygon of course size with every tee and pin in bounds:
// otherwise (wrong feature, a neighbouring course's outline, one ring of a
// split course) shots that never left the hole would be penalized as OB.
function boundaryProblem(course) {
  const b = course && course.boundary;
  if (!b) return null;
  if (!Array.isArray(b) || b.length < 3 ||
      !b.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
    return 'not a polygon';
  }
  const area = polygonArea(b);
  if (area < MIN_BOUNDARY_AREA_M2) return `area ${Math.round(area)} m² is too small for a course`;
  const inBounds = (p) => Array.isArray(p) &&
    (pointInPoly(p[0], p[1], b) || distToPolyEdges(p[0], p[1], b) <= BOUNDARY_BUFFER_M);
  for (const h of course.holes || []) {
    if (!inBounds(h.tee)) return `hole ${h.ref ?? '?'} tee lies outside it`;
    if (!inBounds(h.pin)) return `hole ${h.ref ?? '?'} pin lies outside it`;
  }
  return null;
}

// The shore is walked this often to see whether a lake reaches the course.
const SHORE_STEP_M = 5;

const isRing = (p) => Array.isArray(p) && p.length >= 3 &&
  p.every((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]));

function reachesCourse(ring, boundary) {
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / SHORE_STEP_M));
    for (let k = 0; k < n; k++) {
      const x = ax + (bx - ax) * k / n, y = ay + (by - ay) * k / n;
      if (pointInPoly(x, y, boundary) || distToPolyEdges(x, y, boundary) <= BOUNDARY_BUFFER_M) return true;
    }
  }
  return false;
}

// The lakes around the course (the scenery layer, course.scenery.water) that are played
// as water, not just drawn. OSM often leaves a lake the holes run along out of the course
// outline, so a lake that reaches the course (inside course.boundary, or within the
// out-of-bounds buffer of it) is a penalty area, all of it; a pond wholly beyond that,
// across a road, stays out of bounds. With no boundary to go by, every lake is played.
function lakesInPlay(course) {
  const lakes = (course?.scenery?.water || []).filter((w) => w && isRing(w.poly));
  const boundary = course?.boundary && !boundaryProblem(course) ? course.boundary : null;
  return boundary ? lakes.filter((w) => reachesCourse(w.poly, boundary)) : lakes;
}

function makeSurfaceLookup(course) {
  const byKind = {};
  for (const s of course.surfaces) (byKind[s.kind] ||= []).push(s.poly);
  const lakes = lakesInPlay(course).map(({ poly }) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { poly, x0, y0, x1, y1 };
  });
  const problem = boundaryProblem(course);
  if (problem) {
    console.warn(`[course] ignoring the course boundary for out-of-bounds: ${problem}`);
  }
  const boundary = problem ? null : course.boundary;
  return (x, y) => {
    for (const kind of PRIORITY) {
      for (const poly of byKind[kind] || []) {
        if (pointInPoly(x, y, poly)) return kind;
      }
    }
    // a lake in play; the course's own surfaces win where an outline overlaps them (OSM
    // draws lakes looser than fairways and greens), so a lake only ever takes over from
    // the rough, or from out of bounds where it runs past the course outline
    for (const l of lakes) {
      if (x >= l.x0 && x <= l.x1 && y >= l.y0 && y <= l.y1 && pointInPoly(x, y, l.poly)) return 'water';
    }
    if (boundary && !pointInPoly(x, y, boundary) &&
        distToPolyEdges(x, y, boundary) > BOUNDARY_BUFFER_M) return 'ob';
    return 'rough';
  };
}

function listCached() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  const records = fs.readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.surfaces.json'))
    .map((f) => {
    const fp = path.join(CACHE_DIR, f);
    try {
      const course = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!validCacheShape(course)) return null;
      let source = null;
      if (course.source) {
        try { source = normalizeCourseSource(course.source); }
        catch (_) { return null; }
      }
      return { file: f, course, source };
    }
    catch (_) {
      // Don't silently hide a corrupt course forever — quarantine it so the user
      // can re-download instead of it just vanishing from the picker.
      try { fs.renameSync(fp, fp + '.corrupt'); console.error(`[course] quarantined corrupt cache file: ${f}`); } catch (_) { /* ignore */ }
      return null;
    }
  }).filter(Boolean);

  const keyed = new Map();
  for (const record of records.filter((entry) => entry.source)) {
    const expectedFile = `${courseCacheStem(record.source)}.json`;
    const existing = keyed.get(record.source.courseId);
    if (!existing || record.file === expectedFile) keyed.set(record.source.courseId, record);
  }

  const output = [...keyed.values()].map((record) => ({
    file: record.file,
    name: record.course.name,
    courseId: record.source.courseId,
  }));
  for (const record of records.filter((entry) => !entry.source)) {
    const duplicatesKeyed = [...keyed.values()].some((candidate) => legacyIdentityMatches({
      requestedName: candidate.course.name,
      requestedOrigin: candidate.course.origin,
      cachedName: record.course.name,
      cachedOrigin: record.course.origin,
      toleranceM: 250,
    }));
    if (!duplicatesKeyed) output.push({ file: record.file, name: record.course.name });
  }
  return output.sort((a, b) => a.file.localeCompare(b.file));
}

function loadCached(file) {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, path.basename(file)), 'utf8'));
}

// ---- Per-course surface override (data/courses/<stable-id>.surfaces.json) ---
// Hand- or vision-authored vector polygons + relocated pins, applied ONCE at
// load time (server.js activateCourse: AFTER the HD-bundle fingerprint match so
// the immutable bundle still validates, BEFORE makeSurfaceLookup and the geometry
// served to the browser). The OSM surface/hole data is the unreliable layer; this
// is the durable seam for correcting it. Absent sidecar = today's behaviour.
function applySurfaceOverride(course, override) {
  if (!override || typeof override !== 'object') return course;
  if (override.pins) {
    for (const h of course.holes || []) {
      const p = override.pins[h.ref];
      if (Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) h.pin = [p[0], p[1]];
    }
  }
  if (Array.isArray(override.surfaces)) {
    const extra = override.surfaces
      .filter((s) => s && typeof s.kind === 'string' && Array.isArray(s.poly) && s.poly.length >= 3)
      .map((s) => ({ kind: s.kind, poly: s.poly }));
    if (extra.length) course.surfaces = [...(course.surfaces || []), ...extra];
  }
  // Per-hole playing-corridor boundary (local metres). Distinct from the
  // course-wide OB `boundary`: this sets `holes[].boundary` for framing/scoping.
  if (override.holeBoundaries && typeof override.holeBoundaries === 'object') {
    for (const h of course.holes || []) {
      const b = override.holeBoundaries[h.ref];
      if (Array.isArray(b) && b.length >= 3 &&
          b.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) {
        h.boundary = b;
      }
    }
  }
  return course;
}

function loadSurfaceOverride(course, dir = CACHE_DIR, curatedDir = CURATED_DIR) {
  if (!course || !course.name) return null;
  let expectedSource;
  try {
    expectedSource = normalizeCourseSource(course.source);
  } catch {
    return null;
  }
  const stableName = `${courseCacheStem(expectedSource)}.surfaces.json`;
  const legacyName = `${slug(course.name)}.surfaces.json`;
  const candidates = [];
  for (const root of [dir, curatedDir]) {
    candidates.push(
      { file: path.join(root, stableName), legacy: false },
      { file: path.join(root, legacyName), legacy: true },
    );
  }
  // Machine-local override wins; fall back to the committed curated fixture so a
  // reconstructed course's surfaces travel with the branch. Stable-keyed files
  // are exact by construction. Legacy slug files require an embedded stable
  // identity so same-name courses cannot share gameplay. A present-but-corrupt
  // file surfaces the error (returns null) rather than silently falling through.
  for (const { file: fp, legacy } of candidates) {
    if (!fs.existsSync(fp)) continue;
    try {
      const sidecar = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const hasCourseId = typeof sidecar?.courseId === 'string';
      const hasSource = sidecar?.source != null;
      if (legacy && !hasCourseId && !hasSource) {
        throw new CourseIdentityError('Legacy sidecar has no stable identity binding');
      }
      if (hasCourseId && sidecar.courseId !== expectedSource.courseId) {
        throw new CourseIdentityError('Sidecar stable identity does not match the course');
      }
      if (hasSource) {
        const sidecarSource = normalizeCourseSource(sidecar.source);
        if (!sourceMatches(sidecarSource, expectedSource)) {
          throw new CourseIdentityError('Sidecar source identity does not match the course');
        }
      }
      const gameplay = {};
      for (const key of ['pins', 'surfaces', 'holeBoundaries']) {
        if (Object.prototype.hasOwnProperty.call(sidecar, key)) {
          gameplay[key] = sidecar[key];
        }
      }
      return Object.keys(gameplay).length ? gameplay : null;
    }
    catch (e) { console.error(`[override] bad sidecar ${path.basename(fp)}: ${e.message}`); return null; }
  }
  return null;
}

// Compatibility seam for presentation resolution. The caller has already
// verified stable course identity and applies this returned data only to a clone.
// Keep filesystem locations private and never share the parsed object by reference.
function loadLegacyGameplayOverlay({
  course,
  dataDir = CACHE_DIR,
  curatedDir = CURATED_DIR,
} = {}) {
  const override = loadSurfaceOverride(course, dataDir, curatedDir);
  return override == null ? null : structuredClone(override);
}

module.exports = {
  searchCourses, loadCourse, makeSurfaceLookup, lakesInPlay, pointInPoly, listCached, loadCached, parseOsm,
  selectRound, slug, applySurfaceOverride, loadSurfaceOverride, loadLegacyGameplayOverlay, maybeClassify,
  CourseCacheError, atomicWriteOwned, createCourseAcquisitionCoordinator,
  migrateLegacyCourseCache, ownedTempPath, publishSourceKeyedCourseCache,
  readSourceKeyedCache, CourseLoadError, overpass, overpassEndpoints, boundaryProblem, courseBounds,
  CACHE_DIR, isCurrentCourseCache: validCacheShape,
};
