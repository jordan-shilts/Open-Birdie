'use strict';
// A course's outline from its OpenStreetMap feature (lib/course.js outerRing). A course
// mapped as a multipolygon relation often has its outer boundary split over several
// ways (Oakmont's over two): the outline is them joined into one ring, never the
// longest piece alone (the outline is the out-of-bounds line).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { outerRing } = require('../lib/course');

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
