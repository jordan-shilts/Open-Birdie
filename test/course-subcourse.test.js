'use strict';
// A course mapped only as its holes inside another course's outline (Augusta's Par 3
// Course): its scorecard names the course it is in, and the round takes its own hole
// numbers only, each the hole of its par nearest the card's length.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectRound } = require('../lib/course');
const { parentCourseOf, selectionReference } = require('../lib/course-reference');

// a hole line of a given length (yards) running east from x0
const hole = (ref, par, yd, x0 = 0, y = 0) => ({ ref, par, name: null, line: [[x0, y], [x0 + yd * 0.9144, y]] });

test('the Par 3 Course is played inside Augusta National, keyed to its first hole', () => {
  assert.deepEqual(parentCourseOf({ osmType: 'way', osmId: 1481448305 }), { osmType: 'way', osmId: 871993734 });
  assert.equal(parentCourseOf({ osmType: 'way', osmId: 871993734 }), null, 'the main course is its own');
  const ref = selectionReference({ osmType: 'way', osmId: 1481448305 });
  assert.equal(ref.only, true);
  assert.equal(ref.size, 9);
  assert.equal(selectionReference({ osmType: 'way', osmId: 871993734 }).only, undefined);
});

test('a nine takes its own numbers, each the hole of its par nearest the card', () => {
  const card = new Map([[1, { par: 3, yards: { 'Par 3': 115 } }], [4, { par: 3, yards: { 'Par 3': 70 } }], [6, { par: 3, yards: { 'Par 3': 140 } }]]);
  card.only = true;
  const lines = [
    hole(1, 4, 448, 0, 0), hole(1, 3, 136, 0, 900),        // main 1 (par 4) and the nine's 1 (maps 18% long)
    hole(4, 3, 245, 0, 100), hole(4, 3, 92, 0, 1000),      // both par 3: the nine's is nearer 70
    hole(6, 3, 186, 0, 200), hole(6, 3, 156, 0, 1100),     // both par 3: 156 is nearer 140
    hole(10, 4, 506, 0, 300), hole(18, 4, 474, 0, 400),    // the main course's own numbers
  ];
  const round = selectRound(lines, card);
  assert.deepEqual(round.map((h) => `${h.ref}:${h.par}:${Math.round(h.line[1][0] / 0.9144)}`), ['1:3:136', '4:3:92', '6:3:156']);
});

test('an eighteen with a scorecard keeps every number it maps (no change)', () => {
  const card = new Map([[1, { par: 4, yards: { Blue: 445 } }]]);
  const lines = [hole(1, 4, 448, 0, 0), hole(1, 3, 136, 0, 900), hole(2, 5, 585, 0, 100)];
  const round = selectRound(lines, card);
  assert.deepEqual(round.map((h) => h.ref), [1, 2]);
  assert.equal(round[0].par, 4);
});
