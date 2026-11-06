'use strict';
// The bounded local course cache. Courses live where the loaders already look
// (BIRDIE_DATA_DIR/courses/<key>.* and hd-courses/<key>/), and an index
// (BIRDIE_DATA_DIR/course-cache.json) remembers each course's size, when it was last
// used (played, or downloaded ahead of time) and whether it has ever been played. When the total passes the cap (BIRDIE_CACHE_MAX_MB, default 1024;
// 0 = no cap) the least recently used courses are deleted — never a protected one
// (the active course, one being installed). A deleted course is simply downloaded
// (or rebuilt) again the next time it is picked.
//
// Only files named by the course key are managed: <key>.json, <key>.aerial.jpg|png,
// <key>.classmap.png and hd-courses/<key>/ (where cloud packages install HD
// bundles). Hand-authored surface overrides (<key>.surfaces.json), legacy slug-named
// caches and locally compiled HD bundles (hd-courses/<course-name>/) are never
// touched.

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteOwned } = require('./course');

const MB = 1024 * 1024;
const DEFAULT_MAX_MB = 1024;
const INDEX_FILE = 'course-cache.json';
const KEY = /^osm-(node|way|relation)-[1-9][0-9]{0,15}$/;
const MANAGED_SUFFIXES = Object.freeze(['.json', '.aerial.jpg', '.aerial.png', '.classmap.png']);

function cacheLimitBytes(env = process.env, log = console) {
  const raw = env.BIRDIE_CACHE_MAX_MB;
  if (raw == null || String(raw).trim() === '') return DEFAULT_MAX_MB * MB;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb < 0) {
    log.warn(`[cache] ignoring BIRDIE_CACHE_MAX_MB=${raw} (not a number of MB); using ${DEFAULT_MAX_MB}`);
    return DEFAULT_MAX_MB * MB;
  }
  return mb === 0 ? Infinity : Math.round(mb * MB);
}

function sizeOf(target, fsImpl) {
  let stat;
  try { stat = fsImpl.lstatSync(target); } catch (_) { return 0; }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const name of fsImpl.readdirSync(target)) total += sizeOf(path.join(target, name), fsImpl);
  return total;
}

// The paths a course key owns that exist on disk.
function courseFiles(dataDir, key, fsImpl = fs) {
  if (!KEY.test(key)) return [];
  const out = [];
  for (const suffix of MANAGED_SUFFIXES) {
    const p = path.join(dataDir, 'courses', `${key}${suffix}`);
    if (fsImpl.existsSync(p)) out.push(p);
  }
  const hd = path.join(dataDir, 'hd-courses', key);
  if (fsImpl.existsSync(hd)) out.push(hd);
  return out;
}

function createCourseCache({
  dataDir,
  maxBytes = cacheLimitBytes(),
  now = Date.now,
  log = console,
  fsImpl = fs,
} = {}) {
  if (!dataDir) throw new TypeError('Course cache needs a data dir');
  const indexPath = path.join(dataDir, INDEX_FILE);
  let index = load();

  function load() {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(indexPath, 'utf8'));
      if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        for (const key of Object.keys(parsed.entries)) if (!KEY.test(key)) delete parsed.entries[key];
        return parsed;
      }
    } catch (_) { /* missing or corrupt: rebuilt by scan() */ }
    return { version: 1, entries: {} };
  }

  function save() {
    try {
      fsImpl.mkdirSync(dataDir, { recursive: true });
      atomicWriteOwned(indexPath, JSON.stringify(index), { fsImpl });
    } catch (error) {
      log.warn(`[cache] could not save the cache index: ${error.message}`);
    }
  }

  function measure(key) {
    return courseFiles(dataDir, key, fsImpl).reduce((sum, p) => sum + sizeOf(p, fsImpl), 0);
  }

  // (Re)measure a course; drops the entry when its files are gone. `played`: has it ever
  // been played here (a course downloaded ahead of time has not; an entry written before
  // the field existed has).
  function record(key, { origin, packageId, lastUsed, played } = {}, { persist = true } = {}) {
    if (!KEY.test(key)) return null;
    const bytes = measure(key);
    const previous = index.entries[key];
    if (!bytes || !fsImpl.existsSync(path.join(dataDir, 'courses', `${key}.json`))) {
      if (previous) {
        delete index.entries[key];
        if (persist) save();
      }
      return null;
    }
    const entry = {
      bytes,
      lastUsed: lastUsed ?? previous?.lastUsed ?? now(),
      origin: origin ?? previous?.origin ?? 'local',
      packageId: packageId ?? previous?.packageId ?? null,
      played: played ?? (previous ? previous.played !== false : false),
    };
    index.entries[key] = entry;
    if (persist) save();
    return { key, ...entry };
  }

  function usage() {
    const entries = Object.values(index.entries);
    return { bytes: entries.reduce((sum, e) => sum + e.bytes, 0), courses: entries.length, limitBytes: maxBytes };
  }

  function remove(key) {
    let freed = 0;
    for (const p of courseFiles(dataDir, key, fsImpl)) {
      const size = sizeOf(p, fsImpl);
      try {
        fsImpl.rmSync(p, { recursive: true, force: true });
        freed += size;
      } catch (error) {
        log.warn(`[cache] could not delete ${path.basename(p)}: ${error.message}`);
      }
    }
    delete index.entries[key];
    return freed;
  }

  return Object.freeze({
    limitBytes: maxBytes,
    indexPath,
    record,
    // A course was just played: most recently used now.
    touch(key, extra = {}) {
      return record(key, { ...extra, lastUsed: now(), played: true });
    },
    // Index every key-named course on disk (first run, or courses written by an
    // older version); a course never seen before counts as used at its mtime.
    scan() {
      const coursesDir = path.join(dataDir, 'courses');
      let names = [];
      try { names = fsImpl.readdirSync(coursesDir); } catch (_) { names = []; }
      let changed = false;
      for (const name of names) {
        const key = name.endsWith('.json') ? name.slice(0, -'.json'.length) : null;
        if (!key || !KEY.test(key) || index.entries[key]) continue;
        let mtimeMs = now();
        try { mtimeMs = fsImpl.statSync(path.join(coursesDir, name)).mtimeMs; } catch (_) { /* keep now */ }
        if (record(key, { lastUsed: Math.round(mtimeMs), played: true }, { persist: false })) changed = true;
      }
      for (const key of Object.keys(index.entries)) {
        if (!fsImpl.existsSync(path.join(coursesDir, `${key}.json`))) {
          delete index.entries[key];
          changed = true;
        }
      }
      if (changed) save(); // nothing to index: leave the data dir untouched
      return usage();
    },
    usage,
    entries() {
      return structuredClone(index.entries);
    },
    // Delete least-recently-used courses until the cache fits the cap.
    // Returns the evicted keys.
    enforce({ protect = [] } = {}) {
      if (!Number.isFinite(maxBytes)) return [];
      const keep = new Set(protect.filter(Boolean));
      let total = Object.values(index.entries).reduce((sum, e) => sum + e.bytes, 0);
      if (total <= maxBytes) return [];
      const victims = Object.entries(index.entries)
        .filter(([key]) => !keep.has(key))
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const evicted = [];
      for (const [key, entry] of victims) {
        if (total <= maxBytes) break;
        remove(key);
        total -= entry.bytes;
        evicted.push(key);
      }
      if (evicted.length) {
        save();
        log.log(`[cache] evicted ${evicted.length} course(s) to stay under ${Math.round(maxBytes / MB)} MB: ${evicted.join(', ')}`);
      }
      return evicted;
    },
    remove(key) {
      const freed = remove(key);
      save();
      return freed;
    },
  });
}

module.exports = {
  DEFAULT_MAX_MB,
  INDEX_FILE,
  cacheLimitBytes,
  courseFiles,
  createCourseCache,
};
