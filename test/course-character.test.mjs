// P1b: one manual per-course "dryness" scalar blends the lush palette toward a
// dry tan-links palette. Pure logic — greens/sand/water stay put; courseDry=0
// must be byte-identical to today (no regression to lush courses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { COLORS, DRY_PALETTE, COURSE_DRY, COURSE_FLORA, COURSE_IDS, COURSE_ALIASES, courseDryFor, floraFor, blendPalette, BLEND_KEYS, dormantFor, fescueFor, blendDormant, DORMANT_PALETTE, COURSE_DORMANT, COURSE_FESCUE } from '../public/render/course-character.js';

const require = createRequire(import.meta.url);
const obstacles = require('../lib/tree-obstacles.js');
const { FEATURED: FEATURED_COURSES } = require('../lib/course-library.js');

test('courseDryFor: map lookup, clamp, default 0', () => {
  assert.equal(courseDryFor('TPC Sawgrass'), 0);                 // parkland — no dryness
  assert.ok(courseDryFor('Chambers Bay') > 0.5);                 // links — dry
  assert.equal(courseDryFor('Some Unknown Course'), 0);          // unknown → lush default
  assert.equal(courseDryFor(undefined), 0);                      // missing → 0, never NaN
  assert.ok(!Number.isNaN(courseDryFor(null)));
  // the course's own name, before any address loadCourse carries after a comma (the
  // Bandon entry, keyed by its full address, matched no course and drew it lush)
  assert.equal(courseDryFor('Bandon Dunes Golf Resort'), 0.8);
  assert.equal(courseDryFor('Bandon Dunes Golf Resort, Round Lake Drive, Coos County, Oregon, United States'), 0.8);
  assert.equal(courseDryFor('whistling straits'), 0.75);
});

test('blendPalette at 0 is byte-identical to COLORS (no lush-course regression)', () => {
  assert.deepEqual(blendPalette(COLORS, DRY_PALETTE, 0), COLORS);
});

test('blendPalette at 1 hits the dry targets on grass zones', () => {
  const dry = blendPalette(COLORS, DRY_PALETTE, 1);
  assert.equal(dry.rough, DRY_PALETTE.rough);                    // gold-tan dominant
  assert.equal(dry.fairwayA, DRY_PALETTE.fairwayA);             // cool olive
});

test('greens/sand/water are excluded from the tan blend (greens stay green)', () => {
  for (const t of [0, 0.5, 1]) {
    const p = blendPalette(COLORS, DRY_PALETTE, t);
    assert.equal(p.greenA, COLORS.greenA);                       // putting surfaces never go tan
    assert.equal(p.greenB, COLORS.greenB);
    assert.equal(p.water, COLORS.water);
    assert.equal(p.bunker, COLORS.bunker);
  }
  assert.ok(!BLEND_KEYS.includes('greenA'));
});

test('blendPalette is monotone toward tan (rough R rises, G/B fall)', () => {
  const r = (hex) => parseInt(hex.slice(1, 3), 16);
  const mid = blendPalette(COLORS, DRY_PALETTE, 0.5).rough;
  assert.ok(r(COLORS.rough) < r(mid) && r(mid) < r(DRY_PALETTE.rough)); // warms monotonically
});

test('blendPalette clamps t outside [0,1]', () => {
  assert.deepEqual(blendPalette(COLORS, DRY_PALETTE, 2), blendPalette(COLORS, DRY_PALETTE, 1));
  assert.deepEqual(blendPalette(COLORS, DRY_PALETTE, -1), COLORS);
});

test('a course is itself whatever it was asked for by: the picker, featured.json, or its map id', () => {
  // the picker's names for the two links that drew as lush parkland
  assert.equal(courseDryFor('Old Course at St Andrews'), 0.7);
  assert.equal(courseDryFor('Bandon Dunes'), 0.8);
  // courses/featured.json's names (the part before the comma is the key)
  assert.equal(courseDryFor('Old Course, St Andrews'), 0.7);
  assert.equal(courseDryFor('Bandon Dunes Golf Resort'), 0.8);
  // the map id wins over any name, even one that says nothing
  assert.equal(courseDryFor('Some links, Fife', 'osm:way:1019045811'), 0.7);
  assert.equal(courseDryFor('', 'osm:way:362513477'), 0.8);
  assert.deepEqual(floraFor('whatever', 'osm:way:871993734'), COURSE_FLORA['Augusta National Golf Club']);
  // an id nobody listed falls back to the name; neither known is the lush default
  assert.equal(courseDryFor('Chambers Bay', 'osm:way:1'), 0.85);
  assert.equal(courseDryFor('Nowhere Golf Club', 'osm:way:1'), 0);
  assert.equal(floraFor('Nowhere Golf Club', 'osm:way:1'), null);
});

test('every featured course in the picker resolves by its id and by its picker name alike', () => {
  assert.ok(FEATURED_COURSES.length >= 7);
  for (const f of FEATURED_COURSES) {
    assert.ok(COURSE_IDS[f.courseId], `${f.name} (${f.courseId}) has its id listed`);
    assert.equal(courseDryFor(f.name), courseDryFor('', f.courseId), `${f.name}: dryness by name and by id`);
    assert.deepEqual(floraFor(f.name), floraFor('', f.courseId), `${f.name}: flora by name and by id`);
  }
});

test('ids and other spellings point at courses that exist; the ball\'s trees agree with the drawn ones', () => {
  const known = new Set([...Object.keys(COURSE_DRY), ...Object.keys(COURSE_FLORA)]);
  for (const name of [...Object.values(COURSE_IDS), ...Object.values(COURSE_ALIASES)]) assert.ok(known.has(name), `${name} has a dryness or a flora`);
  assert.deepEqual(obstacles.COURSE_IDS, COURSE_IDS);
  assert.deepEqual(obstacles.COURSE_ALIASES, COURSE_ALIASES);
  assert.deepEqual(obstacles.COURSE_DRY, COURSE_DRY);
  assert.deepEqual(obstacles.COURSE_FLORA, COURSE_FLORA);
  for (const [id, name] of Object.entries(COURSE_IDS)) {
    assert.equal(obstacles.courseDryFor('x', id), courseDryFor('x', id), name);
    assert.deepEqual(obstacles.floraFor('x', id), floraFor('x', id), name);
  }
});

test('dormant fescue turns a links\'s mown ground to straw, and leaves everything else', () => {
  assert.equal(dormantFor('Bandon Dunes'), 0.55);
  assert.equal(dormantFor('', 'osm:way:1019045811'), 0.3);
  assert.equal(dormantFor('Chambers Bay'), 0, 'Chambers keeps the olive measured from its own photos');
  assert.equal(dormantFor('TPC Sawgrass'), 0);
  const dry = blendPalette(COLORS, DRY_PALETTE, 0.8);
  assert.equal(blendDormant(dry, 0), dry, 'no dormancy: the very same palette');
  const half = blendDormant(dry, 0.55), full = blendDormant(dry, 1);
  assert.equal(full.fairwayA, DORMANT_PALETTE.fairwayA);
  const red = (hex) => parseInt(hex.slice(1, 3), 16), green = (hex) => parseInt(hex.slice(3, 5), 16);
  // straw: red rises to meet green
  assert.ok(red(half.fairwayA) / green(half.fairwayA) > red(dry.fairwayA) / green(dry.fairwayA));
  for (const k of ['greenA', 'greenB', 'rough', 'base', 'bunker', 'water', 'wood']) assert.equal(half[k], dry[k], k);
  for (const name of [...Object.keys(COURSE_DORMANT), ...Object.keys(COURSE_FESCUE)]) assert.ok(name in COURSE_DRY, `${name} is a course with a dryness`);
});

test('tall fescue follows dryness, except where the course says otherwise', () => {
  assert.equal(fescueFor('TPC Sawgrass'), 0);
  assert.equal(fescueFor('Chambers Bay'), 1);
  assert.ok(Math.abs(fescueFor('Whistling Straits') - 0.875) < 1e-9);
  // the Old Course is dry but short: far less than its dryness alone would grow
  assert.equal(fescueFor('Old Course at St Andrews'), 0.12);
  assert.ok(fescueFor('', 'osm:way:1019045811') < 0.2);
  assert.equal(fescueFor('Nowhere'), 0);
});
