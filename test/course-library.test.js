'use strict';
// The course picker's library (lib/course-library.js): every downloaded course with what
// its card shows, last played first, and the featured courses not downloaded yet; each
// course file read once.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCourseLibrary, FEATURED, sketchOf } = require('../lib/course-library');
const REFERENCE = require('../lib/generated/course-reference.json');

const quiet = { warn() {} };
const PEBBLE = REFERENCE.courses.find((c) => c.courseId === 'osm:relation:3741806');

// A cached course file: 18 holes running north, par 4 each unless given.
function course({ name, osmType, osmId, pars = null, lengths = null }) {
  return {
    version: 4, name,
    source: osmType ? { courseId: `osm:${osmType}:${osmId}`, osmType, osmId } : undefined,
    origin: { lat: 45, lon: -93 },
    holes: Array.from({ length: 18 }, (_, i) => ({
      ref: i + 1, par: pars ? pars[i] : 4, lengthYd: lengths ? lengths[i] : 400,
      tee: [i * 50, 0], pin: [i * 50, 360], line: [[i * 50, 0], [i * 50 + 10, 200], [i * 50, 360]],
    })),
  };
}
function dataDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-library-'));
  fs.mkdirSync(path.join(dir, 'courses'));
  for (const [file, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'courses', file), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('downloaded courses: their numbers and layout, the one playing first, then the last played', () => {
  const dir = dataDir({
    'osm-way-1.json': course({ name: 'Alpha Links', osmType: 'way', osmId: 1 }),
    'osm-way-2.json': course({ name: 'Beta Park', osmType: 'way', osmId: 2, pars: Array(18).fill(3), lengths: Array(18).fill(150) }),
    'osm-way-3.json': course({ name: 'Gamma Heath', osmType: 'way', osmId: 3 }),
    'broken.json': '{ not json',
    'old.json': { ...course({ name: 'Old Format' }), version: 1 },
    'osm-way-1.surfaces.json': { surfaces: [] },
  });
  try {
    const lib = createCourseLibrary({ cacheDir: path.join(dir, 'courses'), log: quiet });
    const r = lib.list({
      entries: { 'osm-way-1': { lastUsed: 100 }, 'osm-way-2': { lastUsed: 300 }, 'osm-way-3': { lastUsed: 200 } },
      currentId: 'osm:way:3',
    });
    assert.deepEqual(r.courses.map((c) => c.name), ['Gamma Heath', 'Beta Park', 'Alpha Links']);
    assert.equal(r.courses[0].current, true);
    const beta = r.courses[1];
    assert.equal(beta.holes, 18);
    assert.equal(beta.par, 54);
    assert.equal(beta.yards, 2700);
    assert.equal(beta.file, 'osm-way-2.json');
    assert.equal(beta.lastUsed, 300);
    assert.equal(beta.researched, false);
    assert.equal(beta.sketch.holes.length, 18);
    assert.equal(r.current, 'osm:way:3');
  } finally { cleanup(dir); }
});

test('featured courses that are not downloaded are offered by their OSM id; a downloaded one is not repeated', () => {
  const pars = PEBBLE.holes.map((h) => h.par);
  const blue = PEBBLE.holes.map((h) => h.yards.Blue);
  const dir = dataDir({ 'osm-relation-3741806.json': course({ name: 'Pebble Beach Golf Links', osmType: 'relation', osmId: 3741806, pars, lengths: blue }) });
  try {
    const r = createCourseLibrary({ cacheDir: path.join(dir, 'courses'), log: quiet }).list({});
    assert.equal(r.courses.length, 1);
    assert.ok(!r.featured.some((f) => f.courseId === 'osm:relation:3741806'));
    assert.equal(r.featured.length, FEATURED.length - 1);
    const st = r.featured.find((f) => f.courseId === 'osm:way:1019045811');
    assert.equal(st.osmType, 'way');
    assert.equal(st.osmId, 1019045811);
    assert.equal(st.place, 'St Andrews, Scotland');
    assert.equal(st.researched, true);
    assert.equal(st.holes, 18);
    assert.ok(st.par >= 70 && st.yards > 6000, `${st.par} / ${st.yards}`);
    // the download's researched card fits it: par 72, the play tee's yardage
    const pebble = r.courses[0];
    assert.equal(pebble.researched, true);
    assert.equal(pebble.par, 72);
    assert.equal(pebble.tee, 'Blue');
    assert.equal(pebble.place, 'Pebble Beach, California');
  } finally { cleanup(dir); }
});

test("a download whose holes aren't the researched ones shows its own mapped numbers", () => {
  const dir = dataDir({ 'osm-relation-3741806.json': course({ name: 'Pebble Beach Golf Links', osmType: 'relation', osmId: 3741806, pars: Array(18).fill(3) }) });
  try {
    const [c] = createCourseLibrary({ cacheDir: path.join(dir, 'courses'), log: quiet }).list({}).courses;
    assert.equal(c.researched, false);
    assert.equal(c.par, 54);
    assert.equal(c.tee, null);
  } finally { cleanup(dir); }
});

test('each course file is read once, and again only when it changes', () => {
  const dir = dataDir({ 'osm-way-1.json': course({ name: 'Alpha Links', osmType: 'way', osmId: 1 }) });
  try {
    let reads = 0;
    const fsImpl = { ...fs, readFileSync: (...a) => { reads++; return fs.readFileSync(...a); } };
    const lib = createCourseLibrary({ cacheDir: path.join(dir, 'courses'), fsImpl, log: quiet });
    lib.list({});
    lib.list({});
    assert.equal(reads, 1);
    const file = path.join(dir, 'courses', 'osm-way-1.json');
    fs.writeFileSync(file, JSON.stringify(course({ name: 'Alpha Links (new tees)', osmType: 'way', osmId: 1 })));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(lib.list({}).courses[0].name, 'Alpha Links (new tees)');
    assert.equal(reads, 2);
  } finally { cleanup(dir); }
});

test('HD: a course with HD bundles says so', () => {
  const dir = dataDir({ 'osm-way-1.json': course({ name: 'Alpha Links', osmType: 'way', osmId: 1 }) });
  try {
    const lib = createCourseLibrary({ cacheDir: path.join(dir, 'courses'), log: quiet });
    assert.equal(lib.list({}).courses[0].hd, false);
    fs.mkdirSync(path.join(dir, 'hd-courses', 'osm-way-1', 'bundles', 'b1'), { recursive: true });
    assert.equal(lib.list({}).courses[0].hd, true);
  } finally { cleanup(dir); }
});

test('the layout sketch fits a unit box, north up', () => {
  const sk = sketchOf([{ line: [[0, 0], [0, 100]] }, { line: [[50, 0], [50, 100]] }]);
  assert.deepEqual(sk.holes[0], [[0, 1], [0, 0]]);   // the tee at the bottom, the green at the top
  assert.equal(sk.w, 0.5);
  assert.equal(sk.h, 1);
  assert.equal(sketchOf([{ line: [] }]), null);
});
