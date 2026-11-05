// No tree stands in a par 3's shot: a crown within 3 m of the tee-to-pin line is neither
// drawn (public/render/tree-placement.js) nor an obstacle (lib/tree-obstacles.js), and
// the two sides agree tree for tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { par3LineBlock as drawn, placeCourseTrees } from '../public/render/tree-placement.js';
const require = createRequire(import.meta.url);
const { par3LineBlock: played, buildTreeObstacles } = require('../lib/tree-obstacles.js');

const holes = [
  { ref: 4, par: 3, tee: [0, 0], pin: [0, 80], line: [[0, 0], [0, 80]] },
  { ref: 5, par: 4, tee: [50, 0], pin: [50, 350], line: [[50, 0], [50, 350]] },
];

test('the drawn and the played trees clear the same par-3 line', () => {
  const a = drawn(holes), b = played(holes);
  for (let i = 0; i < 400; i++) {
    const x = -20 + (i % 20) * 4.1, y = -10 + Math.floor(i / 20) * 6.3, r = (i % 7);
    assert.equal(a(x, y, r), b(x, y, r), `${x},${y},${r}`);
  }
  assert.equal(a(2, 30, 4), true, 'a crown over the line');
  assert.equal(a(9, 30, 4), false, '9 m off with a 4 m crown: clear');
  assert.equal(a(50, 30, 4), false, 'a par 4 line is left to its fairway');
  assert.equal(a(0, 95, 4), false, 'past the pin');
});

test('a canopy tree in front of a par-3 tee is neither drawn nor hit; one beside it stays', () => {
  const course = {
    name: 'Test', holes, surfaces: [], trees: [],
    canopy: { trees: [[1, 6, 12, 4], [12, 40, 14, 4], [48, 100, 15, 4]] },
  };
  const placed = placeCourseTrees({ holeLines: holes.map((h) => h.line), canopy: course.canopy.trees, blocked: drawn(holes) });
  assert.deepEqual(placed.map((p) => [p.x, p.y]).sort(), [[12, 40], [48, 100]]);
  const obstacles = buildTreeObstacles(course);
  assert.equal(obstacles.count, 2);
  const at = Array.from({ length: obstacles.count }, (_, i) => [obstacles.x[i], obstacles.y[i]]).sort();
  assert.deepEqual(at, [[12, 40], [48, 100]], 'the tee tree is not an obstacle');
});
