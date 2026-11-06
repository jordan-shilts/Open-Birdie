'use strict';
// Course packages (manifest + verified files) and the bounded LRU course cache.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const sharp = require('sharp');

const {
  buildCoursePackage,
  installCoursePackage,
  packageIdOf,
  packageKeyFor,
  parsePackageKey,
  validatePackageManifest,
} = require('../lib/course-package');
const { cacheLimitBytes, createCourseCache, INDEX_FILE } = require('../lib/course-cache');
const { courseFingerprintV1, courseFingerprintV2 } = require('../lib/course-fingerprint');
const { resolveHdBundles } = require('../lib/hd-bundle');
const { readSourceKeyedCache } = require('../lib/course');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const quiet = { log() {}, warn() {}, error() {} };
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function makeCourse(osmId = 77, overrides = {}) {
  return {
    version: 4,
    name: `Package Links ${osmId}`,
    source: { courseId: `osm:way:${osmId}`, osmType: 'way', osmId },
    origin: { lat: 45, lon: -93 },
    surfaces: [{ kind: 'green', poly: [[0, 0], [10, 0], [10, 10], [0, 10]] }],
    boundary: null,
    holes: [{ ref: 1, par: 3, tee: [0, -100], pin: [5, 5], line: [[0, -100], [5, 5]], lengthYd: 115 }],
    trees: [],
    woods: [],
    elevation: { minX: -20, minY: -120, cellM: 5, nx: 9, ny: 30, baseM: 300, heights: Array.from({ length: 270 }, (_, i) => i % 7) },
    buildings: [{ poly: [[20, 20], [30, 20], [30, 30]], heightM: 5, kind: 'yes', name: null, clubhouse: true }],
    canopy: { source: 'test', trees: [[40, 40, 12, 3]] },
    ...overrides,
  };
}

// A cached course with an aerial, a classmap and (optionally) one HD hole bundle
// compiled locally (hd-courses/<course-name>/bundles/<id>/, like the HD compiler).
async function seedCourse(dataDir, course, { hd = true, bytes = 4096 } = {}) {
  const key = packageKeyFor(course.source);
  const coursesDir = path.join(dataDir, 'courses');
  fs.mkdirSync(coursesDir, { recursive: true });
  const aerial = crypto.randomBytes(bytes);
  aerial[0] = 0xff; aerial[1] = 0xd8;
  const classmap = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  const bounds = { minX: -80, minY: -180, maxX: 70, maxY: 70 };
  course.aerial = { file: `${key}.aerial.jpg`, bounds, quality: 'single', classFile: `${key}.classmap.png`, classBounds: bounds };
  fs.writeFileSync(path.join(coursesDir, `${key}.aerial.jpg`), aerial);
  fs.writeFileSync(path.join(coursesDir, `${key}.classmap.png`), classmap);
  fs.writeFileSync(path.join(coursesDir, `${key}.json`), JSON.stringify(course));
  if (hd) {
    const dir = path.join(dataDir, 'hd-courses', 'package-links', 'bundles', 'local-build');
    const holeDir = path.join(dir, 'holes', '01');
    fs.mkdirSync(holeDir, { recursive: true });
    const nx = 4, ny = 4, cellM = 5;
    const f32 = Buffer.alloc(nx * ny * 4);
    for (let i = 0; i < nx * ny; i++) f32.writeFloatLE(i * 0.25, i * 4);
    const ortho = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 120, b: 40 } } }).webp().toBuffer();
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    fs.writeFileSync(path.join(holeDir, 'terrain.f32'), f32);
    fs.writeFileSync(path.join(holeDir, 'orthophoto.webp'), ortho);
    fs.writeFileSync(path.join(holeDir, 'surfaces.png'), png);
    fs.writeFileSync(path.join(holeDir, 'coverage.png'), png);
    fs.writeFileSync(path.join(dir, 'provenance.json'), JSON.stringify({ source: 'synthetic-test' }));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      compilerVersion: '0.1.0',
      course: { name: course.name, fingerprint: courseFingerprintV1(course) },
      hole: 1,
      bounds: { minX: 0, minY: 0, maxX: (nx - 1) * cellM, maxY: (ny - 1) * cellM },
      terrain: { file: 'holes/01/terrain.f32', nx, ny, cellM, baseM: 300, byteOrder: 'LE', sha256: sha256(f32), bytes: f32.length },
      image: { file: 'holes/01/orthophoto.webp', width: 8, height: 8, colorSpace: 'srgb', sha256: sha256(ortho), bytes: ortho.length },
      surfaces: { file: 'holes/01/surfaces.png', width: 4, height: 4, sha256: sha256(png), bytes: png.length },
      coverage: { file: 'holes/01/coverage.png', width: 4, height: 4, sha256: sha256(png), bytes: png.length },
    }));
  }
  return { key, aerial, classmap };
}

const fetchFrom = (files) => {
  const byPath = new Map(files.map((f) => [f.entry.path, f.bytes]));
  return async (entry) => byPath.get(entry.path);
};

test('package keys are the cache stem; both key spellings parse, junk does not', () => {
  assert.equal(packageKeyFor({ osmType: 'relation', osmId: 9892305 }), 'osm-relation-9892305');
  assert.equal(parsePackageKey('osm-relation-9892305').courseId, 'osm:relation:9892305');
  assert.equal(parsePackageKey('osm:way:12').courseId, 'osm:way:12');
  for (const bad of ['osm-way-0', 'osm-area-1', '../osm-way-1', 'osm-way-1/x', '', null]) {
    assert.throws(() => parsePackageKey(bad), { code: 'PACKAGE_KEY_INVALID' });
  }
});

test('a package carries the course (gzip), aerial, classmap and matching HD bundles with sha256 + size', async () => {
  const dataDir = tempDir('birdie-pkg-');
  const course = makeCourse();
  await seedCourse(dataDir, course);
  const { manifest, files } = buildCoursePackage({ dataDir, source: course.source, complete: false, now: () => new Date('2026-11-02T00:00:00Z') });
  assert.equal(manifest.format, 'open-birdie-course-package');
  assert.equal(manifest.key, 'osm-way-77');
  assert.equal(manifest.courseId, 'osm:way:77');
  assert.equal(manifest.complete, false);
  assert.deepEqual(manifest.fingerprints, { v1: courseFingerprintV1(course), v2: courseFingerprintV2(course) });
  assert.deepEqual(manifest.scenery, { buildings: 1, water: null, canopyTrees: 1, aerial: 'single', classmap: true, failed: [] });
  const paths = manifest.files.map((f) => f.path);
  assert.deepEqual(paths.filter((p) => !p.startsWith('hd/')), ['aerial.jpg', 'classmap.png', 'course.json.gz']);
  const hdPaths = paths.filter((p) => p.startsWith('hd/'));
  assert.equal(hdPaths.length, 6, 'manifest, provenance and the four assets of the one bundle');
  assert.ok(hdPaths.every((p) => /^hd\/[a-f0-9]{64}\//.test(p)));
  assert.equal(manifest.hd.length, 1, 'the manifest says which HD holes it carries');
  assert.equal(manifest.hd[0].hole, 1);
  assert.equal(`hd/${manifest.hd[0].bundleId}/manifest.json`, hdPaths.find((p) => p.endsWith('/manifest.json')));
  for (const { entry, bytes } of files) {
    assert.equal(entry.size, bytes.length);
    assert.equal(entry.sha256, sha256(bytes));
  }
  assert.equal(manifest.totalBytes, files.reduce((s, f) => s + f.bytes.length, 0));
  const packaged = JSON.parse(zlib.gunzipSync(files.find((f) => f.entry.role === 'course').bytes));
  assert.equal(packaged.aerial.file, 'aerial.jpg', 'package-relative names');
  assert.equal(packaged.aerial.classFile, 'classmap.png');
  assert.doesNotThrow(() => validatePackageManifest(manifest, { key: 'osm-way-77' }));
  const again = buildCoursePackage({ dataDir, source: course.source, complete: false, now: () => new Date('2027-01-01T00:00:00Z') });
  assert.equal(again.manifest.packageId, manifest.packageId, 'packageId depends on the files only');
});

test('installing a package verifies every file first, then lands a playable cache with its HD bundle', async () => {
  const builder = tempDir('birdie-pkg-');
  const course = makeCourse();
  const { aerial } = await seedCourse(builder, course);
  const { manifest, files } = buildCoursePackage({ dataDir: builder, source: course.source });

  const desk = tempDir('birdie-desk-');
  const progress = [];
  const installed = await installCoursePackage({
    dataDir: desk, manifest, fetchFile: fetchFrom(files), onProgress: (p) => progress.push(p),
  });
  assert.equal(installed.key, 'osm-way-77');
  const cached = readSourceKeyedCache({ cacheDir: path.join(desk, 'courses'), source: course.source });
  assert.ok(cached, 'loads through the normal cache reader');
  assert.equal(cached.aerial.file, 'osm-way-77.aerial.jpg');
  assert.equal(cached.aerial.classFile, 'osm-way-77.classmap.png');
  assert.deepEqual(fs.readFileSync(path.join(desk, 'courses', 'osm-way-77.aerial.jpg')), aerial);
  assert.equal(courseFingerprintV1(cached), courseFingerprintV1(course), 'same course, same fingerprint');
  const hd = resolveHdBundles(cached, { dataDir: desk });
  assert.equal(hd.status, 'valid', 'the HD bundle validates and matches after install');
  assert.equal(hd.descriptors.length, 1);
  assert.ok(hd.descriptors[0].bundleDir.includes(path.join('hd-courses', 'osm-way-77', 'bundles')));
  assert.equal(progress.at(-1).fetchedBytes, manifest.totalBytes);
  assert.deepEqual(installed.files.at(-1), 'courses/osm-way-77.json', 'course JSON last');
});

test('a tampered or truncated file aborts the install before anything is written', async () => {
  const builder = tempDir('birdie-pkg-');
  const course = makeCourse();
  await seedCourse(builder, course);
  const { manifest, files } = buildCoursePackage({ dataDir: builder, source: course.source });
  for (const mutate of [
    (b) => { const c = Buffer.from(b); c[c.length - 1] ^= 0xff; return c; },
    (b) => b.subarray(0, b.length - 1),
  ]) {
    const desk = tempDir('birdie-desk-');
    const honest = fetchFrom(files);
    await assert.rejects(
      installCoursePackage({
        dataDir: desk,
        manifest,
        fetchFile: async (entry) => (entry.role === 'aerial' ? mutate(await honest(entry)) : honest(entry)),
      }),
      { code: 'PACKAGE_FILE_INVALID' },
    );
    assert.deepEqual(fs.readdirSync(desk), [], 'nothing written');
  }
});

test('manifest validation rejects traversal, role mismatches, a forged packageId and a foreign course', async () => {
  const builder = tempDir('birdie-pkg-');
  const course = makeCourse();
  await seedCourse(builder, course, { hd: false });
  const { manifest, files } = buildCoursePackage({ dataDir: builder, source: course.source });
  const withFiles = (mutate) => {
    const m = structuredClone(manifest);
    mutate(m);
    m.packageId = packageIdOf(m.key, m.files);
    return m;
  };
  const invalid = { code: 'PACKAGE_MANIFEST_INVALID' };
  assert.throws(() => validatePackageManifest(withFiles((m) => { m.files[0].path = '../aerial.jpg'; })), invalid);
  assert.throws(() => validatePackageManifest(withFiles((m) => { m.files.push({ ...m.files[0], path: `hd/${'a'.repeat(64)}/../../x`, role: 'hd' }); })), invalid);
  assert.throws(() => validatePackageManifest(withFiles((m) => { m.files[0].role = 'course'; })), invalid);
  assert.throws(() => validatePackageManifest(withFiles((m) => { m.files = m.files.filter((f) => f.role !== 'course'); })), invalid);
  assert.throws(() => validatePackageManifest({ ...manifest, packageId: 'f'.repeat(64) }), invalid);
  assert.throws(() => validatePackageManifest(manifest, { key: 'osm-way-78' }), invalid);
  assert.throws(() => validatePackageManifest({ ...manifest, formatVersion: 2 }), { code: 'PACKAGE_VERSION_UNSUPPORTED' });
  // a manifest that claims another course but ships this course's JSON
  const foreign = withFiles((m) => {
    m.source = { courseId: 'osm:way:78', osmType: 'way', osmId: 78 };
    m.courseId = 'osm:way:78';
    m.key = 'osm-way-78';
  });
  const desk = tempDir('birdie-desk-');
  await assert.rejects(installCoursePackage({ dataDir: desk, manifest: foreign, fetchFile: fetchFrom(files) }), { code: 'PACKAGE_COURSE_INVALID' });
  assert.deepEqual(fs.readdirSync(desk), []);
});

test('BIRDIE_CACHE_MAX_MB: default 1024 MB, 0 means no cap, junk falls back', () => {
  assert.equal(cacheLimitBytes({}), 1024 * 1024 * 1024);
  assert.equal(cacheLimitBytes({ BIRDIE_CACHE_MAX_MB: '0' }), Infinity);
  assert.equal(cacheLimitBytes({ BIRDIE_CACHE_MAX_MB: '50' }), 50 * 1024 * 1024);
  assert.equal(cacheLimitBytes({ BIRDIE_CACHE_MAX_MB: 'lots' }, quiet), 1024 * 1024 * 1024);
});

test('the LRU cache evicts least recently played courses past the cap, never a protected one', async () => {
  const dataDir = tempDir('birdie-lru-');
  const courses = [makeCourse(1), makeCourse(2), makeCourse(3)];
  for (const c of courses) await seedCourse(dataDir, c, { hd: false, bytes: 400 * 1024 });
  // Cloud-installed HD bundle under the course key belongs to course 2.
  fs.mkdirSync(path.join(dataDir, 'hd-courses', 'osm-way-2', 'bundles', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'hd-courses', 'osm-way-2', 'bundles', 'x', 'terrain.f32'), Buffer.alloc(1000));
  // Never managed: a hand-authored override, a legacy cache and a locally compiled HD bundle.
  fs.writeFileSync(path.join(dataDir, 'courses', 'osm-way-2.surfaces.json'), '{"pins":{}}');
  fs.writeFileSync(path.join(dataDir, 'courses', 'old-name.json'), '{}');
  fs.mkdirSync(path.join(dataDir, 'hd-courses', 'package-links-2', 'bundles'), { recursive: true });

  let clock = 1000;
  const cache = createCourseCache({ dataDir, maxBytes: 1024 * 1024, now: () => clock, log: quiet });
  const usage = cache.scan();
  assert.equal(usage.courses, 3);
  clock = 2000; cache.touch('osm-way-1'); // the active course, played longest ago
  clock = 3000; cache.touch('osm-way-2');
  clock = 4000; cache.touch('osm-way-3');
  assert.ok(cache.usage().bytes > 1024 * 1024);
  const evicted = cache.enforce({ protect: ['osm-way-1'] });
  assert.deepEqual(evicted, ['osm-way-2'], 'oldest unprotected course goes first, and only as many as needed');
  assert.ok(cache.usage().bytes <= 1024 * 1024);
  const left = fs.readdirSync(path.join(dataDir, 'courses')).sort();
  assert.ok(left.includes('osm-way-1.json') && left.includes('osm-way-3.json'));
  assert.ok(!left.some((f) => f.startsWith('osm-way-2.') && f !== 'osm-way-2.surfaces.json'), 'all of course 2 deleted');
  assert.ok(left.includes('osm-way-2.surfaces.json') && left.includes('old-name.json'), 'unmanaged files kept');
  assert.equal(fs.existsSync(path.join(dataDir, 'hd-courses', 'osm-way-2')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'hd-courses', 'package-links-2')), true);

  // the index survives a restart
  const reopened = createCourseCache({ dataDir, maxBytes: 1024 * 1024, now: () => clock, log: quiet });
  assert.deepEqual(Object.keys(reopened.entries()).sort(), ['osm-way-1', 'osm-way-3']);
  assert.equal(reopened.entries()['osm-way-3'].lastUsed, 4000);

  // a cap smaller than the active course alone empties everything else
  const tiny = createCourseCache({ dataDir, maxBytes: 1, now: () => clock, log: quiet });
  assert.deepEqual(tiny.enforce({ protect: ['osm-way-1'] }), ['osm-way-3']);
  assert.ok(fs.existsSync(path.join(dataDir, 'courses', 'osm-way-1.json')));
  assert.deepEqual(createCourseCache({ dataDir, maxBytes: Infinity, log: quiet }).enforce(), [], 'no cap: nothing evicted');
});

test('the cache index knows a course downloaded ahead of time has not been played', async () => {
  const dataDir = tempDir('birdie-played-');
  for (const c of [makeCourse(1), makeCourse(2)]) await seedCourse(dataDir, c, { hd: false, bytes: 1000 });
  let clock = 1000;
  const cache = createCourseCache({ dataDir, now: () => clock, log: quiet });
  // course 1 is downloaded, then played; course 2 is only downloaded
  assert.equal(cache.record('osm-way-1', { lastUsed: clock }).played, false);
  assert.equal(cache.record('osm-way-2', { lastUsed: clock }).played, false);
  clock = 2000;
  assert.equal(cache.touch('osm-way-1').played, true);
  clock = 3000;
  assert.equal(cache.record('osm-way-1', { lastUsed: clock }).played, true, 'downloading it again keeps it played');
  const reopened = createCourseCache({ dataDir, now: () => clock, log: quiet });
  assert.deepEqual(
    Object.fromEntries(Object.entries(reopened.entries()).map(([k, e]) => [k, [e.lastUsed, e.played]])),
    { 'osm-way-1': [3000, true], 'osm-way-2': [1000, false] },
  );
  // an index entry written before the field existed counts as played; so does a course found by scanning
  const index = JSON.parse(fs.readFileSync(path.join(dataDir, INDEX_FILE), 'utf8'));
  delete index.entries['osm-way-2'].played;
  fs.writeFileSync(path.join(dataDir, INDEX_FILE), JSON.stringify(index));
  const legacy = createCourseCache({ dataDir, now: () => clock, log: quiet });
  assert.equal(legacy.record('osm-way-2').played, true);
  const fresh = tempDir('birdie-played-scan-');
  await seedCourse(fresh, makeCourse(3), { hd: false, bytes: 1000 });
  const scanned = createCourseCache({ dataDir: fresh, log: quiet });
  scanned.scan();
  assert.equal(scanned.entries()['osm-way-3'].played, true);
});

test('scanning an empty data dir writes nothing', () => {
  const dataDir = tempDir('birdie-lru-');
  const cache = createCourseCache({ dataDir, log: quiet });
  assert.deepEqual(cache.scan(), { bytes: 0, courses: 0, limitBytes: 1024 * 1024 * 1024 });
  assert.equal(fs.existsSync(path.join(dataDir, INDEX_FILE)), false);
});
