'use strict';
// Course packages: one course with everything needed to play it and to show it as
// the real place, as a manifest plus files, so a course can be built once (by the
// cloud service) and downloaded by any desktop.
//
//   manifest.json  { format, formatVersion, key, courseId, source, name, cacheVersion,
//                    fingerprints: { v1, v2 }, complete,
//                    scenery: { buildings, water, canopyTrees, aerial, classmap, failed },
//                    createdAt, generator,
//                    packageId, totalBytes,
//                    files: [{ path, role, contentType, size, sha256 }] }
//   course.json.gz the cached course JSON (gzip: the 1 m terrain shrinks ~4x)
//   aerial.jpg     the course-wide aerial photo (or aerial.png)
//   classmap.png   the NDVI surface classmap registered to the aerial
//   hd/<bundleId>/<file>  every HD hole bundle whose fingerprint matches the course
//
// Every file is checked against its size and sha256 before anything is written, and
// the course JSON is written last (it is the cache's validity marker), so a failed
// or tampered download never leaves a half-installed course. `packageId` hashes the
// file list, so it changes whenever any file does. `complete: false` marks a
// playable package whose scenery is still being added.
//
// Installed layout (the normal cache, so the existing loaders read it unchanged):
//   courses/<key>.json, courses/<key>.aerial.jpg|png, courses/<key>.classmap.png,
//   hd-courses/<key>/bundles/<bundleId>/...

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { throwIfAborted } = require('./abort');
const { atomicWriteOwned, isCurrentCourseCache, readSourceKeyedCache } = require('./course');
const { courseCacheStem, normalizeCourseSource } = require('./course-identity');
const { courseFingerprintV1, courseFingerprintV2 } = require('./course-fingerprint');
const { resolveHdBundles } = require('./hd-bundle');

const PACKAGE_FORMAT = 'open-birdie-course-package';
const PACKAGE_FORMAT_VERSION = 1;
const HEX64 = /^[a-f0-9]{64}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_FILES = 512;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_COURSE_JSON_BYTES = 512 * 1024 * 1024;
const CONTENT_TYPES = Object.freeze({
  '.gz': 'application/gzip',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
});
let installNonce = 0;

class CoursePackageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoursePackageError';
    this.code = code;
  }
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// Package key = the cache stem ("osm-relation-9892305"): URL- and file-safe.
function packageKeyFor(source) {
  return courseCacheStem(source);
}

// "osm-way-123" or "osm:way:123" -> normalized source.
function parsePackageKey(key) {
  const match = /^osm[-:](node|way|relation)[-:]([1-9][0-9]{0,15})$/.exec(String(key || ''));
  if (!match) throw new CoursePackageError('PACKAGE_KEY_INVALID', 'Course key must look like osm-way-123');
  try {
    return normalizeCourseSource({ osmType: match[1], osmId: Number(match[2]) });
  } catch (_) {
    throw new CoursePackageError('PACKAGE_KEY_INVALID', 'Course key must look like osm-way-123');
  }
}

function sceneryOf(course) {
  return {
    buildings: Array.isArray(course.buildings) ? course.buildings.length : null,
    water: course.scenery && Array.isArray(course.scenery.water) ? course.scenery.water.length : null,
    canopyTrees: course.canopy && Array.isArray(course.canopy.trees) ? course.canopy.trees.length : null,
    aerial: course.aerial && course.aerial.file ? (course.aerial.quality || 'single') : null,
    classmap: Boolean(course.aerial && course.aerial.classFile),
  };
}

function listFilesRel(dir) {
  const out = [];
  (function walk(d, prefix) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(d, ent.name), rel);
      else if (ent.isFile()) out.push(rel);
    }
  })(dir, '');
  return out.sort();
}

function packageIdOf(key, files) {
  const list = files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(JSON.stringify({ format: PACKAGE_FORMAT, formatVersion: PACKAGE_FORMAT_VERSION, key, files: list }));
}

// Build the package for a cached course in dataDir. Returns
// { manifest, files: [{ entry, bytes }] } with files in manifest order.
function buildCoursePackage({
  dataDir,
  source,
  course: provided = null,
  complete = true,
  sceneryFailed = [],
  now = () => new Date(),
  generator = 'open-birdie',
  includeHd = true,
} = {}) {
  const normalized = normalizeCourseSource(source || (provided && provided.source));
  const key = packageKeyFor(normalized);
  const cacheDir = path.join(dataDir, 'courses');
  const course = provided ? structuredClone(provided) : readSourceKeyedCache({ cacheDir, source: normalized });
  if (!course || !isCurrentCourseCache(course)) {
    throw new CoursePackageError('PACKAGE_COURSE_MISSING', `No current course cache for ${key}`);
  }
  const files = [];
  const add = (filePath, role, bytes) => {
    files.push({
      entry: { path: filePath, role, contentType: contentTypeFor(filePath), size: bytes.length, sha256: sha256(bytes) },
      bytes,
    });
  };

  // Course-relative names inside the package; the installer maps them back.
  const packaged = structuredClone(course);
  if (packaged.aerial && packaged.aerial.file) {
    const aerialPath = path.join(cacheDir, path.basename(packaged.aerial.file));
    if (fs.existsSync(aerialPath)) {
      const name = `aerial${path.extname(aerialPath).toLowerCase() === '.png' ? '.png' : '.jpg'}`;
      add(name, 'aerial', fs.readFileSync(aerialPath));
      packaged.aerial.file = name;
      const classPath = packaged.aerial.classFile && path.join(cacheDir, path.basename(packaged.aerial.classFile));
      if (classPath && fs.existsSync(classPath)) {
        add('classmap.png', 'classmap', fs.readFileSync(classPath));
        packaged.aerial.classFile = 'classmap.png';
      } else {
        delete packaged.aerial.classFile;
        delete packaged.aerial.classBounds;
        delete packaged.aerial.classStats;
      }
    } else {
      delete packaged.aerial; // a reference to a file that is not there helps nobody
    }
  }

  if (includeHd) {
    const hd = resolveHdBundles(course, { dataDir });
    for (const descriptor of hd.status === 'valid' ? hd.descriptors : []) {
      for (const rel of listFilesRel(descriptor.bundleDir)) {
        add(`hd/${descriptor.bundleId}/${rel}`, 'hd', fs.readFileSync(path.join(descriptor.bundleDir, ...rel.split('/'))));
      }
    }
  }

  add('course.json.gz', 'course', zlib.gzipSync(Buffer.from(JSON.stringify(packaged)), { level: 9 }));
  files.sort((a, b) => (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0));
  const entries = files.map((f) => f.entry);
  const manifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    key,
    courseId: normalized.courseId,
    source: { ...normalized },
    name: course.name || null,
    cacheVersion: course.version,
    fingerprints: { v1: courseFingerprintV1(course), v2: courseFingerprintV2(course) },
    complete: Boolean(complete),
    // failed: layers whose source failed this time (retried by a later build)
    scenery: { ...sceneryOf(course), failed: [...sceneryFailed] },
    createdAt: now().toISOString(),
    generator,
    packageId: packageIdOf(key, entries),
    totalBytes: entries.reduce((sum, e) => sum + e.size, 0),
    files: entries,
  };
  return { manifest, files };
}

function safePackagePath(p, role) {
  if (typeof p !== 'string' || p.length > 512) return false;
  const segments = p.split('/');
  if (!segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) return false;
  if (role === 'course') return p === 'course.json.gz';
  if (role === 'aerial') return p === 'aerial.jpg' || p === 'aerial.png';
  if (role === 'classmap') return p === 'classmap.png';
  if (role === 'hd') return segments.length >= 3 && segments[0] === 'hd' && HEX64.test(segments[1]);
  return false;
}

// Throws CoursePackageError unless the manifest is well formed (and, when given,
// for the expected key). Returns the normalized source.
function validatePackageManifest(manifest, { key: expectedKey } = {}) {
  const bad = (message) => new CoursePackageError('PACKAGE_MANIFEST_INVALID', message);
  if (!manifest || typeof manifest !== 'object') throw bad('Manifest is not an object');
  if (manifest.format !== PACKAGE_FORMAT) throw bad('Not a course package manifest');
  if (manifest.formatVersion !== PACKAGE_FORMAT_VERSION) {
    throw new CoursePackageError('PACKAGE_VERSION_UNSUPPORTED', `Unsupported package version ${manifest.formatVersion}`);
  }
  let source;
  try { source = normalizeCourseSource(manifest.source); } catch (_) { throw bad('Manifest source is invalid'); }
  if (manifest.courseId !== source.courseId || manifest.key !== packageKeyFor(source)) {
    throw bad('Manifest identity fields disagree');
  }
  if (expectedKey != null && manifest.key !== expectedKey) throw bad('Manifest is for another course');
  if (typeof manifest.packageId !== 'string' || !HEX64.test(manifest.packageId)) throw bad('Manifest packageId is invalid');
  const files = manifest.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) throw bad('Manifest file list is invalid');
  const seen = new Set();
  let courses = 0;
  for (const f of files) {
    if (!f || typeof f !== 'object' || !safePackagePath(f.path, f.role) || seen.has(f.path) ||
        typeof f.sha256 !== 'string' || !HEX64.test(f.sha256) ||
        !Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) {
      throw bad(`Manifest file entry is invalid: ${f && typeof f.path === 'string' ? f.path.slice(0, 80) : '?'}`);
    }
    seen.add(f.path);
    if (f.role === 'course') courses++;
  }
  if (courses !== 1) throw bad('Manifest must list exactly one course file');
  if (packageIdOf(manifest.key, files) !== manifest.packageId) throw bad('Manifest packageId does not match its files');
  return source;
}

// Check downloaded bytes against their manifest entry.
function verifyPackageFile(entry, bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new CoursePackageError('PACKAGE_FILE_INVALID', `${entry.path}: no bytes`);
  }
  if (bytes.length !== entry.size) {
    throw new CoursePackageError('PACKAGE_FILE_INVALID', `${entry.path}: ${bytes.length} bytes, expected ${entry.size}`);
  }
  if (sha256(bytes) !== entry.sha256) {
    throw new CoursePackageError('PACKAGE_FILE_INVALID', `${entry.path}: sha256 mismatch`);
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
}

// The course JSON inside a package (gunzip + parse + identity check).
function readPackageCourse(bytes, manifest) {
  let json;
  try {
    json = zlib.gunzipSync(bytes, { maxOutputLength: MAX_COURSE_JSON_BYTES });
  } catch (_) {
    throw new CoursePackageError('PACKAGE_COURSE_INVALID', 'Course JSON does not gunzip');
  }
  let course;
  try { course = JSON.parse(json.toString('utf8')); }
  catch (_) { throw new CoursePackageError('PACKAGE_COURSE_INVALID', 'Course JSON does not parse'); }
  let source;
  try { source = normalizeCourseSource(course && course.source); }
  catch (_) { throw new CoursePackageError('PACKAGE_COURSE_INVALID', 'Course has no valid source'); }
  if (source.courseId !== manifest.courseId) {
    throw new CoursePackageError('PACKAGE_COURSE_INVALID', 'Course identity disagrees with its manifest');
  }
  if (!isCurrentCourseCache(course)) {
    throw new CoursePackageError('PACKAGE_COURSE_INVALID', 'Course cache version is not supported by this app');
  }
  return course;
}

// Fetch every file of `entries` with bounded concurrency, verifying each.
async function fetchVerified(entries, fetchFile, { signal, concurrency = 3, onFile = () => {} } = {}) {
  const out = new Map();
  let next = 0;
  let done = 0;
  let failure = null;
  const worker = async () => {
    while (next < entries.length && !failure) {
      const entry = entries[next++];
      try {
        throwIfAborted(signal);
        out.set(entry.path, verifyPackageFile(entry, await fetchFile(entry, { signal })));
        done++;
        onFile({ entry, done, total: entries.length });
      } catch (error) {
        failure = failure || error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  if (failure) throw failure;
  return out;
}

// Download, verify and install a package into dataDir. fetchFile(entry, {signal})
// -> bytes. Nothing is written until every file has been verified; the course JSON
// is written last. Returns { course, key, files: [paths relative to dataDir] }.
async function installCoursePackage({
  dataDir,
  manifest,
  fetchFile,
  signal,
  concurrency = 3,
  onProgress = () => {},
} = {}) {
  const source = validatePackageManifest(manifest);
  const key = manifest.key;
  const totalBytes = manifest.files.reduce((sum, f) => sum + f.size, 0);
  let fetchedBytes = 0;
  const bytes = await fetchVerified(manifest.files, fetchFile, {
    signal,
    concurrency,
    onFile: ({ entry }) => {
      fetchedBytes += entry.size;
      onProgress({ fetchedBytes, totalBytes });
    },
  });
  throwIfAborted(signal);
  const courseEntry = manifest.files.find((f) => f.role === 'course');
  const course = readPackageCourse(bytes.get(courseEntry.path), manifest);

  const coursesDir = path.join(dataDir, 'courses');
  fs.mkdirSync(coursesDir, { recursive: true });
  const written = [];
  const aerialEntry = manifest.files.find((f) => f.role === 'aerial');
  const classEntry = manifest.files.find((f) => f.role === 'classmap');
  if (course.aerial) {
    if (aerialEntry) {
      const aerialName = `${key}.${aerialEntry.path}`; // osm-way-1.aerial.jpg
      atomicWriteOwned(path.join(coursesDir, aerialName), bytes.get(aerialEntry.path));
      written.push(`courses/${aerialName}`);
      course.aerial.file = aerialName;
      if (classEntry && course.aerial.classFile) {
        const className = `${key}.classmap.png`;
        atomicWriteOwned(path.join(coursesDir, className), bytes.get(classEntry.path));
        written.push(`courses/${className}`);
        course.aerial.classFile = className;
      } else {
        delete course.aerial.classFile;
      }
    } else {
      delete course.aerial;
    }
  }

  // HD bundles are immutable and hash-named: stage each, then rename into place.
  const bundles = new Map();
  for (const f of manifest.files.filter((e) => e.role === 'hd')) {
    const [, bundleId, ...rest] = f.path.split('/');
    if (!bundles.has(bundleId)) bundles.set(bundleId, []);
    bundles.get(bundleId).push({ rel: rest, bytes: bytes.get(f.path) });
  }
  if (bundles.size) {
    const bundlesDir = path.join(dataDir, 'hd-courses', key, 'bundles');
    fs.mkdirSync(bundlesDir, { recursive: true });
    for (const [bundleId, entries] of bundles) {
      const target = path.join(bundlesDir, bundleId);
      if (!fs.existsSync(target)) {
        const staging = path.join(bundlesDir, `.${bundleId}.tmp.${process.pid}-${Date.now()}-${++installNonce}`);
        try {
          for (const { rel, bytes: b } of entries) {
            const dest = path.join(staging, ...rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, b);
          }
          fs.renameSync(staging, target);
        } finally {
          fs.rmSync(staging, { recursive: true, force: true });
        }
      }
      written.push(`hd-courses/${key}/bundles/${bundleId}`);
    }
  }

  throwIfAborted(signal);
  atomicWriteOwned(path.join(coursesDir, `${key}.json`), JSON.stringify(course));
  written.push(`courses/${key}.json`);
  return { course, key, source, files: written, totalBytes };
}

module.exports = {
  CoursePackageError,
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  buildCoursePackage,
  contentTypeFor,
  fetchVerified,
  installCoursePackage,
  packageIdOf,
  packageKeyFor,
  parsePackageKey,
  readPackageCourse,
  sha256,
  validatePackageManifest,
  verifyPackageFile,
};
