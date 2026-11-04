// The sea round a coastal course (public/render/sea.js): read from hydro-flattened
// terrain, flooded in from the grid's edge, kept off the course, carved under.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findSea, carveSea, seaAt, distanceToLand, playPoints, shoreGround } from '../public/render/sea.js';

// 100 x 60 cells of 2 m: sea in the west (x < 60 m) at `sea`, then the shore rising
// 0.4 m per metre to land that rolls about 8 m up.
function coast({ sea = (i, j) => 0, nx = 100, ny = 60 } = {}) {
  const heights = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * 2;
      heights[j * nx + i] = x < 60 ? sea(i, j) : Math.min(8 + Math.sin(j * 0.3) * 0.5, 0.6 + (x - 60) * 0.4);
    }
  }
  return { nx, ny, cellM: 2, minX: 0, minY: 0, heights };
}
const fairway = [{ kind: 'fairway', poly: [[120, 20], [190, 20], [190, 100], [120, 100]] }];

test('a flat sea is found at its level, flooded in from the edge, with the distance to land', () => {
  const g = coast();
  const s = findSea(g, { play: playPoints(fairway) });
  assert.ok(s, 'no sea');
  assert.ok(s.level > 0 && s.level < 0.3, `level ${s.level}`);
  assert.equal(seaAt(s, 10, 50), true);
  assert.equal(seaAt(s, 150, 50), false);
  assert.ok(Math.abs(s.frac - 0.3) < 0.02, `frac ${s.frac}`);
  // the cell 20 m out from the last sea column is 22 m from the first land column
  const k = 30 * g.nx + 19;      // x = 38 m; land starts at x = 60 m
  assert.ok(Math.abs(s.shoreM[k] - 22) < 0.5, `shore ${s.shoreM[k]}`);
  assert.equal(s.shoreM[30 * g.nx + 40], 0);
});

test("a sea the survey left noisy (Bandon's ±0.3 m) still reads as one water line above the noise", () => {
  const g = coast({ sea: (i, j) => Math.sin(i * 1.7 + j * 2.3) * 0.3 });
  const s = findSea(g);
  assert.ok(s, 'no sea');
  assert.ok(s.level >= 0.3 && s.level < 0.6, `level ${s.level}`);
  assert.equal(seaAt(s, 30, 30), true);
  assert.equal(seaAt(s, 70, 30), false);    // the beach stays land
});

test('no sea inland: a lake the course maps as a pond, or rolling land with no flat band', () => {
  // the "sea" here is the course's own pond, which has its own water
  const g = coast();
  const pond = { poly: [[-1, -1], [61, -1], [61, 121], [-1, 121]], minX: -1, minY: -1, maxX: 61, maxY: 121 };
  assert.equal(findSea(g, { ponds: [pond] }), null);
  const hills = { nx: 80, ny: 80, cellM: 2, minX: 0, minY: 0, heights: Float32Array.from({ length: 6400 }, (_, k) => Math.sin(k * 0.37) * 3 + (k % 80) * 0.05) };
  assert.equal(findSea(hills), null);
});

test('a flat grid of no-data under the course is not a sea', () => {
  const g = { nx: 100, ny: 60, cellM: 2, minX: 0, minY: 0, heights: new Float32Array(6000) };
  assert.equal(findSea(g, { play: playPoints(fairway) }), null);
});

test('the sea floor is carved under the water, deeper out from the shore; the land is untouched', () => {
  const g = coast();
  const s = findSea(g);
  const h = carveSea(g.heights, g, s);
  const at = (x) => h[30 * g.nx + x / 2];
  assert.ok(at(58) < s.level - 0.3 + 1e-6 && at(58) > s.level - 1);
  assert.ok(at(0) < at(40) && at(40) < at(58), `${at(0)} ${at(40)} ${at(58)}`);
  assert.equal(at(100), g.heights[30 * g.nx + 50]);
  // a finer patch keeps its own shoreline: a cell above the water line is never carved
  const patch = { nx: 4, ny: 1, cellM: 1, minX: 56, minY: 60, heights: Float32Array.from([0, 0, 0.4, 0.6]) };
  const hp = carveSea(patch.heights, patch, s);
  assert.ok(hp[0] < s.level - 0.3 + 1e-6);
  assert.equal(hp[2], patch.heights[2]);
  assert.equal(hp[3], patch.heights[3]);
});

test('distance to land: zero on land, growing out to sea', () => {
  const mask = Uint8Array.from([0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1]);   // 4 x 3, land in the first column
  const d = distanceToLand(mask, 4, 3, 2);
  assert.deepEqual([d[0], d[1], d[2], d[3]], [0, 2, 4, 6]);
});

test('the shore: sand on a low gentle beach, rock on a cliff, wet at the waterline, grass inland', () => {
  // the sea west of x = 60 m; north of y = 60 m a beach rising 0.05 m per metre, south of
  // it a cliff rising 1.5 m per metre; both level off at 8 m
  const nx = 100, ny = 60, cellM = 2;
  const heights = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * 2, y = j * 2;
      heights[j * nx + i] = x < 60 ? 0 : Math.min(8, 0.4 + (x - 60) * (y >= 60 ? 0.05 : 1.5));
    }
  }
  const g = { nx, ny, cellM, minX: 0, minY: 0, heights };
  const s = findSea(g);
  assert.ok(s, 'no sea');
  const { data } = shoreGround(g, s);
  const px = (x, y) => { const k = (Math.round(y / 2) * nx + Math.round(x / 2)) * 4; return { sand: data[k], rock: data[k + 1], wet: data[k + 2] }; };
  assert.ok(px(76, 90).sand > 200, `beach sand ${px(76, 90).sand}`);   // 1.2 m up, 16 m in
  assert.ok(px(62, 90).wet > 150, 'the waterline is wet');
  assert.ok(px(62, 20).rock > 200, `cliff rock ${px(62, 20).rock}`);
  assert.equal(px(62, 20).sand, 0, 'no sand on a cliff');
  for (const [x, y] of [[180, 90], [180, 20]]) assert.deepEqual(px(x, y), { sand: 0, rock: 0, wet: 0 }, 'inland: grass');
  assert.deepEqual(px(20, 50), { sand: 0, rock: 0, wet: 0 }, 'the sea itself: the water covers it');
});
