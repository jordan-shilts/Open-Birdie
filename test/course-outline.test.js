'use strict';
// A course's outline from its OpenStreetMap feature (lib/course.js outerRing). A course
// mapped as a multipolygon relation often has its outer boundary split over several
// ways (Oakmont's over two): the outline is them joined into one ring, never the
// longest piece alone (the outline is the out-of-bounds line).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { outerRing, outerRings } = require('../lib/course');

const P = (lat, lon) => ({ lat, lon });
const A = P(0, 0), B = P(0, 2), C = P(1, 2), D = P(1, 0);

test('a way is its own outline', () => {
  assert.deepEqual(outerRing({ type: 'way', geometry: [A, B, C, D, A] }), [A, B, C, D, A]);
  assert.equal(outerRing({ type: 'way', geometry: [A, B] }), null);
});

test('outer pieces are joined end to end, one of them running backwards', () => {
  const ring = outerRing({ type: 'relation', members: [
    { type: 'way', role: 'outer', geometry: [A, B, C] },
    { type: 'way', role: 'outer', geometry: [A, D, C] },   // runs the other way round
    { type: 'way', role: 'inner', geometry: [P(0.4, 0.4), P(0.4, 0.6), P(0.6, 0.6), P(0.4, 0.4)] },
  ] });
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[ring.length - 1], 'closed');
  for (const corner of [A, B, C, D]) assert.ok(ring.some((p) => p.lat === corner.lat && p.lon === corner.lon));
});

test('of two separate outer rings the bigger is the outline; members without geometry are skipped', () => {
  const small = [P(5, 5), P(5, 5.1), P(5.1, 5.1), P(5, 5)];
  const ring = outerRing({ type: 'relation', members: [
    { type: 'way', role: 'outer', geometry: small },
    { type: 'way', role: '', geometry: [A, B, C, D, A] },
    { type: 'node', role: 'label' },
  ] });
  assert.deepEqual(ring, [A, B, C, D, A]);
});

test('a relation with no members (the old tags-only answer) has no outline', () => {
  assert.equal(outerRing({ type: 'relation', tags: { leisure: 'golf_course' } }), null);
});

test('a course mapped as two areas side by side has both, the bigger first', () => {
  // Kiawah's Ocean Course: two closed outer rings sharing an edge, nine holes in each
  const west = [P(0, 0), P(0, 2), P(1, 2), P(1, 0), P(0, 0)];
  const east = [P(0, 2), P(0, 3), P(1, 3), P(1, 2), P(0, 2)];
  const rel = { type: 'relation', members: [
    { type: 'way', role: 'outer', geometry: east },
    { type: 'way', role: 'outer', geometry: west },
  ] };
  assert.deepEqual(outerRings(rel), [west, east]);
  assert.deepEqual(outerRing(rel), west);
  assert.deepEqual(outerRings({ type: 'way', geometry: west }), [west]);
  assert.deepEqual(outerRings({ type: 'node' }), []);
});

// ---- surfaces mapped as multipolygon relations (lib/course.js parseOsm) ----
const { parseOsm } = require('../lib/course');

const hole = { type: 'way', tags: { golf: 'hole', ref: '1', par: '4' }, geometry: [P(33.5, -82.02), P(33.502, -82.02)] };
const greenWay = { type: 'way', tags: { golf: 'green' }, geometry: [P(33.5019, -82.0201), P(33.5019, -82.0199), P(33.5021, -82.0199), P(33.5019, -82.0201)] };

test('a fairway mapped as a multipolygon relation is a fairway surface, its pieces joined', () => {
  const fairway = { type: 'relation', tags: { golf: 'fairway', type: 'multipolygon' }, members: [
    { type: 'way', role: 'outer', geometry: [P(33.5005, -82.0203), P(33.5005, -82.0197), P(33.5015, -82.0197)] },
    { type: 'way', role: 'outer', geometry: [P(33.5005, -82.0203), P(33.5015, -82.0203), P(33.5015, -82.0197)] },
    { type: 'way', role: 'inner', geometry: [P(33.501, -82.0201), P(33.501, -82.0200), P(33.5011, -82.0200), P(33.501, -82.0201)] },
  ] };
  const c = parseOsm({ elements: [hole, greenWay, fairway] }, 'Test', null);
  const fw = c.surfaces.filter((x) => x.kind === 'fairway');
  assert.equal(fw.length, 1, 'one fairway from the two outer pieces (the inner ring is not a fairway)');
  assert.equal(fw[0].poly.length, 5);
  assert.deepEqual(fw[0].poly[0], fw[0].poly[4], 'closed');
});

test('relation members do not move the projection origin: a course without them is unchanged', () => {
  const fairway = { type: 'relation', tags: { golf: 'fairway' }, members: [
    { type: 'way', role: 'outer', geometry: [P(34, -81), P(34, -80.9), P(34.1, -80.9), P(34, -81)] },
  ] };
  const bare = parseOsm({ elements: [hole, greenWay] }, 'Test', null);
  const withRel = parseOsm({ elements: [hole, greenWay, fairway] }, 'Test', null);
  assert.deepEqual(withRel.surfaces.find((x) => x.kind === 'green').poly, bare.surfaces.find((x) => x.kind === 'green').poly);
});
