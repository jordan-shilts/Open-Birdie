// Render-side height-grid border repair (public/render/grid-repair.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairGridEdges } from '../public/render/grid-repair.js';

function grid(nx, ny, f) {
  const heights = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) heights.push(f(i, j));
  return { minX: 0, minY: 0, cellM: 1, nx, ny, heights };
}

test('a detached border column/row (unfilled DEM edge) is replaced by its neighbour', () => {
  // flat -2.69 course with a stale +3.4 west column and +0.75 north row (seen in the wild)
  const g = grid(12, 10, (i, j) => (i === 0 ? 3.4 : j === 9 ? 0.75 : -2.69));
  const { grid: out, repaired } = repairGridEdges(g);
  assert.deepEqual(repaired.sort(), ['north', 'west']);
  for (let j = 0; j < 9; j++) assert.equal(out.heights[j * 12], -2.69);
  for (let i = 1; i < 12; i++) assert.equal(out.heights[9 * 12 + i], -2.69);
  // input untouched
  assert.equal(g.heights[0], 3.4);
});

test('real edge relief (a slope running off the course) is kept', () => {
  const g = grid(12, 10, (i) => i * 2.0);              // steady 2 m/cell ramp
  const { grid: out, repaired } = repairGridEdges(g);
  assert.deepEqual(repaired, []);
  assert.equal(out, g);
});

test('tiny grids pass through unchanged', () => {
  const g = grid(3, 3, () => 0);
  assert.equal(repairGridEdges(g).grid, g);
  assert.equal(repairGridEdges(null).grid, null);
});
