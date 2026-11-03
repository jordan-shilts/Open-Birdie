// Pond water lines and beds (public/render/water-shore.js): the water sits ON the
// hydro-flattened interior, the terrain is carved under it, and the plane reaches
// past the hand-traced outline to the real bank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pondLevel, growPolygon, coursePonds, carveBeds, pointInPoly } from '../public/render/water-shore.js';

// A 40 x 30 m pond whose interior is flattened at -3.66 m inside banks rising from
// -3.64 m at the outline (the Hazeltine case: the lowest outline vertex sits above
// most of the interior).
const pond = [[0, 0], [40, 0], [40, 30], [0, 30]];
const hAt = (x, y) => (pointInPoly(x, y, pond) && x > 1 && x < 39 && y > 1 && y < 29 ? -3.66 : -3.64 + 0.05 * Math.max(0, Math.min(x, y, 40 - x, 30 - y, 0) * -1));

test('the water line is the flattened interior, not the lowest outline vertex', () => {
  assert.ok(Math.abs(pondLevel(pond, hAt) - -3.66) < 1e-9);
  const minVertex = Math.min(...pond.map(([x, y]) => hAt(x, y)));
  assert.ok(minVertex > pondLevel(pond, hAt), 'the old level sat above the interior');
});

test('a tiny pond with no interior samples falls back to its lowest outline height', () => {
  const tiny = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.equal(pondLevel(tiny, (x, y) => x + y, 2), 0);
});

test('the grown outline encloses the original, about d out on every side', () => {
  for (const poly of [pond, pond.slice().reverse()]) {
    const g = growPolygon(poly, 2);
    for (const [x, y] of poly) assert.ok(pointInPoly(x, y, g), 'every original vertex inside the grown one');
    assert.ok(pointInPoly(-1.5, 15, g) && pointInPoly(41.5, 15, g) && !pointInPoly(-3, 15, g));
  }
});

test('the bed is carved below the water line and deepens away from the shore', () => {
  const nx = 61, ny = 51, minX = -10, minY = -10, cellM = 1;
  const heights = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = hAt(minX + i, minY + j);
  const ponds = coursePonds([{ kind: 'water', poly: pond }, { kind: 'fairway', poly: [[50, 0], [60, 0], [60, 10]] }], hAt);
  assert.equal(ponds.length, 1);
  const out = carveBeds(heights, { nx, ny, minX, minY, cellM }, ponds);
  const at = (x, y) => out[(y - minY) * nx + (x - minX)];
  const level = ponds[0].level;
  assert.ok(at(20, 15) < level - 1.5, `centre ${at(20, 15)}`);
  assert.ok(at(2, 15) < level && at(2, 15) > at(10, 15), 'shallow near the shore, deeper inside');
  assert.ok(at(20, 15) >= level - 1.8 - 1e-6, 'capped depth');
  assert.equal(at(-5, 15), heights[(15 - minY) * nx + (-5 - minX)], 'outside the pond untouched');
  assert.notEqual(out, heights, 'a copy, the input grid stays as is');
});
