// Smoothed terrain shading normals (public/render/terrain-grid.js smoothGridNormals).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoothGridNormals } from '../public/render/terrain-grid.js';

const grid = (nx, ny, f) => {
  const h = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = f(i, j);
  return h;
};
const at = (n, nx, i, j) => [n[(j * nx + i) * 3], n[(j * nx + i) * 3 + 1], n[(j * nx + i) * 3 + 2]];

test('flat ground faces straight up', () => {
  const n = smoothGridNormals(grid(10, 10, () => 5), 10, 10, 2);
  for (let k = 0; k < 100; k++) assert.deepEqual([n[k * 3], n[k * 3 + 1], n[k * 3 + 2]].map((v) => +v.toFixed(6)), [0, 1, 0]);
});

test('a real slope keeps its tilt and direction (east-rising ground leans its normal west)', () => {
  // rises 0.1 m per metre to the east (x), 2 m cells
  const n = smoothGridNormals(grid(20, 20, (i) => i * 0.2), 20, 20, 2, 2);
  const [x, y, z] = at(n, 20, 10, 10);
  assert.ok(Math.abs(x - -0.1 / Math.hypot(0.1, 1)) < 1e-4, `x ${x}`);
  assert.ok(Math.abs(y - 1 / Math.hypot(0.1, 1)) < 1e-4);
  assert.ok(Math.abs(z) < 1e-6);
  // north-rising ground (+j) leans toward -north, which is +z in three.js
  const m = smoothGridNormals(grid(20, 20, (i, j) => j * 0.2), 20, 20, 2, 2);
  assert.ok(at(m, 20, 10, 10)[2] > 0.09);
});

test('cell-to-cell lidar noise is smoothed out of the shading', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const noisy = grid(40, 40, () => (rnd() - 0.5) * 0.3); // +-15 cm noise on flat ground
  const tilt = (n) => {
    let worst = 0;
    for (let j = 5; j < 35; j++) for (let i = 5; i < 35; i++) worst = Math.max(worst, Math.acos(at(n, 40, i, j)[1]));
    return (worst * 180) / Math.PI;
  };
  const raw = tilt(smoothGridNormals(noisy, 40, 40, 1, 0));
  const smooth = tilt(smoothGridNormals(noisy, 40, 40, 1, 2));
  assert.ok(raw > 5, `raw noise tilts normals by ${raw.toFixed(1)} deg`);
  assert.ok(smooth < raw / 4, `smoothed ${smooth.toFixed(1)} deg vs raw ${raw.toFixed(1)} deg`);
});
