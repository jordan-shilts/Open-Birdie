// Camera grass culling (public/render/grass-field.js): each ring draws only the rect
// of cells the camera can see, and never drops a cell that is on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { heightRanges, visibleCells } from '../public/render/grass-field.js';

const flatRange = () => [0, 0];

function cameraAt(x, y, z, lookX, lookY, lookZ) {
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
  cam.position.set(x, y, z);
  cam.lookAt(lookX, lookY, lookZ);
  cam.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  return { cam, frustum };
}

test('heightRanges: each tile bounds its cells and the shared edge to the next tile', () => {
  const nx = 9, ny = 5;
  const heights = Array.from({ length: nx * ny }, (_, k) => (k % nx) + 10 * Math.floor(k / nx));
  const r = heightRanges(heights, nx, ny);
  assert.equal(r.tx, 3);
  assert.equal(r.ty, 2);
  // tile (0, 0) spans cells i 0..4, j 0..4 (the overlap row/column included)
  assert.equal(r.lo[0], 0);
  assert.equal(r.hi[0], 4 + 40);
  // the last tile column holds only cell 8 (clamped at the grid edge)
  assert.equal(r.lo[2], 8);
});

test('a camera looking along the ground draws the rect ahead of it, not the square around it', () => {
  const reach = 30, spacing = 0.18;
  const { cam, frustum } = cameraAt(0, 1.7, 0, 100, 0, 0);   // looking along +x
  const c = visibleCells(frustum, cam.position, reach, spacing, flatRange);
  assert.ok(c, 'something is visible');
  const full = (2 * reach / spacing) ** 2;
  assert.ok(c.w * c.h < full * 0.6, `rect ${c.w}x${c.h} should be well under the full square`);
  assert.ok(c.i0 * spacing > -6, 'little behind the camera');
  const back = cameraAt(0, 1.7, 0, -100, 0, 0);               // looking along -x
  const cb = visibleCells(back.frustum, back.cam.position, reach, spacing, flatRange);
  assert.ok((cb.i0 + cb.w) * spacing < 6, 'the rect follows the view direction');
});

test('every on-screen spot within reach lies inside the rect', () => {
  const reach = 11, spacing = 0.07;
  const views = [
    cameraAt(5, 1.7, -3, 40, 0, -20),        // along the ground
    cameraAt(0, 4.6, 0, 0, 0, -40),          // address camera, looking down the hole
    cameraAt(2, 6, 2, 3, 0, 1),              // looking steeply down
  ];
  let seen = 0;
  for (const { cam, frustum } of views) {
    const c = visibleCells(frustum, cam.position, reach, spacing, flatRange);
    for (let k = 0; k < 4000; k++) {
      const x = cam.position.x + (Math.random() * 2 - 1) * reach, z = cam.position.z + (Math.random() * 2 - 1) * reach;
      if (Math.hypot(x - cam.position.x, cam.position.y, z - cam.position.z) > reach) continue;
      const ndc = new THREE.Vector3(x, 0, z).project(cam);
      if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z < -1 || ndc.z > 1) continue;
      seen++;
      assert.ok(c, 'a visible spot means a rect');
      const i = Math.floor(x / spacing), j = Math.floor(-z / spacing);
      assert.ok(i >= c.i0 && i < c.i0 + c.w && j >= c.j0 && j < c.j0 + c.h, `spot (${x.toFixed(2)}, ${z.toFixed(2)}) outside the rect`);
    }
  }
  assert.ok(seen > 100, 'the test saw on-screen ground');
});

test('from high above the reach, nothing is drawn', () => {
  const { cam, frustum } = cameraAt(0, 120, 0, 0, 0, -50);
  assert.equal(visibleCells(frustum, cam.position, 30, 0.18, flatRange), null);
});
