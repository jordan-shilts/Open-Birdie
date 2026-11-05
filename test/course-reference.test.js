'use strict';
// Researched scorecards (lib/course-reference.js): the generated data stays current, the
// overlay lands only on courses whose holes really are the researched ones (and only on
// the gameplay clone), and a resort mapped as one outline (Bandon Dunes) is built with
// its own holes. Fixtures: the raw golf=hole ways inside each course's OSM outline.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseOsm, selectRound } = require('../lib/course');
const {
  applyCourseReference,
  correspondence,
  findReference,
  selectionReference,
  teeDeviation,
} = require('../lib/course-reference');
const { prepareCourseCandidate } = require('../lib/resolved-course-package');
const { Game } = require('../lib/game');
const REFERENCE = require('../lib/generated/course-reference.json');

const ROOT = path.join(__dirname, '..');
const research = (slug) => REFERENCE.courses.find((c) => c.slug === slug);
const fixture = (slug) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'course-reference', `${slug}-holes.json`), 'utf8'));
// The course as loadCourse builds it from these hole lines; `source` null = no OSM id known.
const parsed = (slug, { withSource = true } = {}) => {
  const fx = fixture(slug);
  return parseOsm({ elements: fx.elements }, fx.name, null, withSource ? fx.source : null);
};
const quiet = () => {
  const lines = [];
  return { lines, log: { log: (m) => lines.push(['log', m]), warn: (m) => lines.push(['warn', m]) } };
};

test('the generated reference file is current with docs/research/course-data', async () => {
  const { buildCourseReference, serialize } = await import('../tools/build-course-reference.mjs');
  const committed = fs.readFileSync(path.join(ROOT, 'lib', 'generated', 'course-reference.json'), 'utf8');
  assert.equal(committed, serialize(buildCourseReference()), 'run npm run build:course-reference');
});

test('every researched course maps to its featured OSM course, with 18 holes and clean notes', () => {
  const ids = Object.fromEntries(REFERENCE.courses.map((c) => [c.slug, c.courseId]));
  assert.deepEqual(ids, {
    // its file names its own OSM id: Augusta isn't on courses/featured.json (the cloud's build list)
    'augusta-national': 'osm:way:871993734',
    // keyed to its first hole's way: the Par 3 Course has no outline of its own
    'augusta-national-par-3': 'osm:way:1481448305',
    'bandon-dunes': 'osm:way:362513477',
    'chambers-bay': 'osm:way:26787026',
    'pebble-beach': 'osm:relation:3741806',
    'st-andrews-old': 'osm:way:1019045811',
    'tpc-sawgrass': 'osm:relation:1783123',
    'whistling-straits': 'osm:way:205111637',
  });
  for (const c of REFERENCE.courses) {
    const n = c.withinId ? 9 : 18;   // a nine inside another course (Augusta's Par 3 Course)
    assert.deepEqual(c.holes.map((h) => h.number), Array.from({ length: n }, (_, i) => i + 1), c.slug);
    assert.equal(new Set(c.tees.map((t) => t.name)).size, c.tees.length, `${c.slug}: one row per tee`);
    for (const h of c.holes) {
      // a handicap the scorecard doesn't publish (Augusta's Masters card) stays null
      assert.ok(h.par >= 3 && h.par <= 5 && (h.handicap == null || (h.handicap >= 1 && h.handicap <= 18)), `${c.slug} #${h.number}`);
      for (const text of [h.note, h.green]) {
        if (text) assert.doesNotMatch(text, /\(S\d+|\bper S\d+/, `${c.slug} #${h.number}: source ids stripped`);
      }
    }
  }
});

test('a course finds its research by OSM id, a same-place course by location, others none', () => {
  assert.equal(findReference({ source: { osmType: 'way', osmId: 362513477 } }).reference.slug, 'bandon-dunes');
  const elsewhere = findReference({ source: { osmType: 'way', osmId: 1 }, origin: { lat: 36.5675, lon: -121.948 } });
  assert.equal(elsewhere.reference.slug, 'pebble-beach');
  assert.equal(elsewhere.matchedBy, 'location');
  assert.equal(findReference({ source: { osmType: 'relation', osmId: 9892305 }, origin: { lat: 44.83, lon: -93.59 } }), null);
});

test('round selection uses research only for an exact OSM id match', () => {
  assert.ok(selectionReference({ osmType: 'way', osmId: 362513477 }) instanceof Map);
  assert.equal(selectionReference({ osmType: 'way', osmId: 1 }), null);
  assert.equal(selectionReference(null), null);
});

test('Bandon Dunes, mapped as the whole resort, is built from its own 18 holes', () => {
  const bandon = research('bandon-dunes');
  const course = parsed('bandon-dunes');
  assert.equal(course.holes.length, 18);
  for (const hole of course.holes) {
    const want = bandon.holes.find((h) => h.number === hole.ref);
    assert.equal(hole.par, want.par, `hole ${hole.ref} par`);
    assert.ok(teeDeviation(hole.lengthYd, want.yards) <= 0.15, `hole ${hole.ref}: ${hole.lengthYd} yd`);
    assert.match(hole.name, new RegExp(`^Bandon Dunes Hole ${hole.ref}$`), 'the mapped way of this course, not a neighbour');
  }
  // the walk from each green to the next tee stays short
  const walks = course.holes.slice(1).map((h, i) => {
    const prev = course.holes[i].line;
    const green = prev[prev.length - 1];
    return Math.hypot(h.line[0][0] - green[0], h.line[0][1] - green[1]);
  });
  assert.ok(Math.max(...walks) < 200, `longest walk ${Math.round(Math.max(...walks))} m`);
});

test('without research the resort round is the old mix (9 of 18 pars wrong)', () => {
  const bandon = research('bandon-dunes');
  const course = parsed('bandon-dunes', { withSource: false });
  const wrong = course.holes.filter((h) => bandon.holes.find((x) => x.number === h.ref).par !== h.par);
  assert.deepEqual(wrong.map((h) => h.ref), [3, 5, 6, 8, 9, 13, 15, 17, 18]);
});

// Whistling Straits is mapped as one 36-hole outline holding the Straits and the Irish
// courses; the Irish holes are the way ids 1569896170-87.
const irishWay = (id) => id >= 1569896170 && id <= 1569896187;
const straitsNames = () => new Set(fixture('whistling-straits').elements.filter((e) => !irishWay(e.id)).map((e) => e.tags.name));

test('Whistling Straits, mapped with both its courses, is built from the Straits Course', () => {
  const straits = research('whistling-straits');
  const course = parsed('whistling-straits');
  const names = straitsNames();
  assert.equal(course.holes.length, 18);
  for (const hole of course.holes) {
    const want = straits.holes.find((h) => h.number === hole.ref);
    assert.equal(hole.par, want.par, `hole ${hole.ref} par`);
    assert.ok(teeDeviation(hole.lengthYd, want.yards) <= 0.15, `hole ${hole.ref}: ${hole.lengthYd} yd`);
    assert.ok(names.has(hole.name), `hole ${hole.ref} is the Straits Course's, not the Irish: ${hole.name}`);
  }
  assert.equal(course.holes[16].name, 'Pinched Nerve');
  assert.equal(course.holes[16].par, 3);
});

test('without research the Whistling Straits outline gives the Irish course, the old mix-up', () => {
  const course = parsed('whistling-straits', { withSource: false });
  assert.ok(course.holes.every((h) => !straitsNames().has(h.name)), 'every hole the Irish course\'s');
  assert.equal(course.holes[16].name, 'Irish Mist');
});

test('single-course outlines pick exactly the same holes with or without research', () => {
  for (const slug of ['pebble-beach', 'chambers-bay', 'st-andrews-old']) {
    assert.deepEqual(parsed(slug).holes, parsed(slug, { withSource: false }).holes, slug);
  }
});

test('selectRound keeps every candidate of a hole number none of which fits the scorecard', () => {
  const line = (x0, y0, x1, y1) => [[x0, y0], [x1, y1]];
  const holes = [
    { ref: 1, par: 4, line: line(0, 0, 0, 360) },
    { ref: 2, par: 4, line: line(0, 380, 0, 760) },
    { ref: 2, par: 4, line: line(900, 0, 900, 380) },
  ];
  const reference = new Map([[1, { par: 4, yards: { Blue: 390 } }], [2, { par: 5, yards: { Blue: 560 } }]]);
  const round = selectRound(holes, reference);
  assert.deepEqual(round.map((h) => h.line[0]), [[0, 0], [0, 380]], 'no fit: chained among all, nearest tee wins');
});

test('the overlay lands on a corresponding course: researched par, handicap, play tee and yardage', () => {
  const pebble = research('pebble-beach');
  const course = parsed('pebble-beach');
  const check = correspondence(course, pebble);
  assert.equal(check.ok, true);
  assert.equal(check.playTee.name, 'Blue', 'the mapped lengths sit closest to the back regular tee');

  const { lines, log } = quiet();
  const result = applyCourseReference(course, { log });
  assert.equal(result.applied, true);
  assert.deepEqual(result.revision, { version: REFERENCE.version, slug: 'pebble-beach', playTee: 'Blue' });
  assert.match(lines[0][1], /^\[course\] scorecard Pebble Beach Golf Links: applied to .*\(17\/17 holes, Blue tees, matched by OSM id\)$/);
  const h18 = course.holes.find((h) => h.ref === 18);
  const want18 = pebble.holes.find((h) => h.number === 18);
  assert.equal(h18.par, 5);
  assert.equal(h18.handicap, want18.handicap);
  assert.equal(h18.scorecardYd, want18.yards.Blue);
  assert.deepEqual(h18.yards, want18.yards);
  assert.equal(course.reference.playTee, 'Blue');
  assert.ok(course.reference.tees.length <= 4 && course.reference.tees[0].name === 'Blue');
  assert.ok(course.reference.tees.every((t) => !/\/|&|\d{4}/.test(t.name)), 'regular tees on the card');
});

test('the overlay skips a course whose holes disagree, says why, and leaves it untouched', () => {
  const course = parsed('bandon-dunes', { withSource: false });
  course.source = { osmType: 'way', osmId: 362513477 }; // the cached resort course: right id, mixed holes
  const before = JSON.stringify(course);
  const { lines, log } = quiet();
  const result = applyCourseReference(course, { log });
  assert.equal(result.applied, false);
  assert.match(result.reason, /^9 of 18 pars disagree \(hole 3: mapped par 4, \d+ yd vs scorecard par 5, 563 yd\)$/);
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], 'warn');
  assert.equal(JSON.stringify(course), before);
});

test('a course with only a few holes in common is skipped quietly', () => {
  const course = {
    name: 'Chambers Bay',
    source: { osmType: 'way', osmId: 26787026 },
    holes: [{ ref: 1, par: 4, lengthYd: 400 }],
  };
  const { lines, log } = quiet();
  assert.equal(applyCourseReference(course, { log }).applied, false);
  assert.deepEqual(lines, []);
  assert.equal(course.holes[0].handicap, undefined);
});

test('package preparation overlays the gameplay clone only and tracks it in the content revision', async () => {
  const base = { ...parsed('pebble-beach'), elevation: null };
  const before = JSON.stringify(base);
  const prepare = (extra = {}) => prepareCourseCandidate({
    baseCourse: base,
    requestedIdentity: { ...base.source, displayName: base.name, origin: base.origin },
    dataDir: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ob-ref-')),
    resolveHd: () => ({ status: 'absent' }),
    loadRuntimePack: () => ({ status: 'absent', runtimePack: null, diagnostics: [] }),
    loadLegacyOverride: () => null,
    prepareGame: (gameplayCourse) => ({ gameplayCourse }),
    ...extra,
  });
  const quietApply = (course) => applyCourseReference(course, { log: quiet().log });
  const withRef = await prepare({ applyReference: quietApply });
  const withoutRef = await prepare({ applyReference: () => ({ applied: false, reason: 'off', revision: null }) });

  assert.equal(JSON.stringify(base), before, 'the acquired course is untouched');
  assert.equal(withRef.baseCourse.reference, undefined);
  assert.equal(withRef.baseCourse.holes.find((h) => h.ref === 1).handicap, undefined, 'base course keeps OSM data');
  assert.equal(withRef.gameplayCourse.reference.slug, 'pebble-beach');
  assert.ok(withRef.gameplayCourse.holes.every((h) => h.handicap >= 1));
  assert.notEqual(withRef.contentRevision, withoutRef.contentRevision);
});

test('round state carries the researched scorecard; a plain course carries none', () => {
  const course = parsed('pebble-beach');
  for (const h of course.holes) Object.assign(h, { tee: h.line[0], pin: h.line[h.line.length - 1] });
  applyCourseReference(course, { log: quiet().log });
  Object.assign(course, { surfaces: [], boundary: null, elevation: null });
  const game = new Game();
  game.setCourse(course);
  const s = game.state();
  const pebble = research('pebble-beach');
  assert.equal(s.playTee, 'Blue');
  assert.equal(s.handicap, pebble.holes[0].handicap);
  assert.equal(s.scorecardYd, pebble.holes[0].yards.Blue);
  assert.equal(s.holeName, null, 'Pebble Beach holes have no names');
  assert.equal(s.handicaps.length, course.holes.length);
  assert.equal(s.tees[0].name, 'Blue');
  assert.equal(s.tees[0].yards.length, course.holes.length);
  assert.equal(s.tees[0].yards[0], pebble.holes[0].yards.Blue);
  assert.ok(s.holeNote, 'a short researched note');

  const plain = new Game();
  plain.setCourse({
    name: 'Plain', surfaces: [], boundary: null, elevation: null,
    holes: [
      { ref: 1, par: 4, name: 'Bandon Dunes Hole 1', tee: [0, 0], pin: [0, 100], lengthYd: 400, line: [[0, 0], [0, 100]] },
      { ref: 2, par: 3, name: 'Road', tee: [0, 0], pin: [0, 100], lengthYd: 150, line: [[0, 0], [0, 100]] },
    ],
  });
  const p = plain.state();
  assert.deepEqual([p.playTee, p.scorecardYd, p.handicap, p.tees], [null, null, null, []]);
  assert.deepEqual(p.holeNames, [null, 'Road'], "a mapper's \"… Hole 1\" is not a hole name");
});
