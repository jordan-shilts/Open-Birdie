'use strict';
// Canopy-height crown detection (lib/canopy-trees.js): synthetic crowns with known
// positions, heights and radii must come back where they were planted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { canopyTrees, detectTreeCrowns, quadkey, quadkeysForBox, tileXY } = require('../lib/canopy-trees');

// A 1 m grid with dome-shaped crowns: height h at the centre falling to 0 at radius r.
function grid(crowns, { nx = 80, ny = 60, minX = -40, minY = -30 } = {}) {
  const heights = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = minX + i, y = minY + j;
      let v = 0;
      for (const c of crowns) {
        const d = Math.hypot(x - c.x, y - c.y);
        if (d < c.r) v = Math.max(v, c.h * Math.sqrt(1 - (d / c.r) ** 2));
      }
      heights[j * nx + i] = v;
    }
  }
  return { heights, nx, ny, minX, minY, cellM: 1 };
}

const near = (trees, x, y, tol = 1.5) => trees.find((t) => Math.hypot(t[0] - x, t[1] - y) <= tol);

test('each planted crown is found once, at its position, with its height', () => {
  const crowns = [{ x: -20, y: 0, h: 18, r: 7 }, { x: 5, y: 8, h: 10, r: 4 }, { x: 25, y: -12, h: 6, r: 3 }];
  const trees = detectTreeCrowns(grid(crowns));
  assert.equal(trees.length, 3);
  for (const c of crowns) {
    const t = near(trees, c.x, c.y);
    assert.ok(t, `crown at ${c.x},${c.y} found`);
    assert.ok(Math.abs(t[2] - c.h) < 1.2, `height ${t[2]} ~ ${c.h}`);
    // dome reaches half height at r * sqrt(3)/2
    assert.ok(Math.abs(t[3] - c.r * 0.87) < 1.6, `radius ${t[3]} ~ ${c.r * 0.87}`);
  }
});

test('two touching crowns stay two trees; a low shrub is not a tree', () => {
  const trees = detectTreeCrowns(grid([
    { x: -6, y: 0, h: 14, r: 6 }, { x: 5, y: 0, h: 12, r: 6 }, { x: 25, y: 15, h: 2.5, r: 2 },
  ]));
  assert.equal(trees.length, 2);
  assert.ok(near(trees, -6, 0) && near(trees, 5, 0));
});

test('blocked ground (greens, water, buildings) drops the crowns standing on it', () => {
  const g = grid([{ x: -20, y: 0, h: 15, r: 6 }, { x: 20, y: 0, h: 15, r: 6 }]);
  const trees = detectTreeCrowns(g, { blocked: (x) => x > 0 });
  assert.equal(trees.length, 1);
  assert.ok(near(trees, -20, 0));
});

test('a flat-topped crown yields one tree, not one per tied cell', () => {
  const g = grid([]);
  for (let j = 28; j <= 32; j++) for (let i = 38; i <= 42; i++) g.heights[j * g.nx + i] = 12;
  assert.equal(detectTreeCrowns(g, { smoothM: 0 }).length, 1);
});

test('a malformed grid is rejected', () => {
  assert.throws(() => detectTreeCrowns({ heights: new Float32Array(4), nx: 3, ny: 3, minX: 0, minY: 0, cellM: 1 }), /nx\*ny/);
});

test('quadkeys locate the Web-Mercator tiles of a box', () => {
  const { x, y } = tileXY(-93.5821, 44.8295, 9);
  assert.equal(quadkey(x, y, 9), '021333010');
  assert.deepEqual(quadkeysForBox({ west: -93.60, south: 44.81, east: -93.56, north: 44.85 }), ['021333010']);
  assert.equal(quadkeysForBox({ west: -94.0, south: 44.81, east: -93.0, north: 44.85 }, 9).length, 2);
});

test('closed woods with no distinct crowns are filled, never on blocked or open ground', () => {
  const nx = 80, ny = 60;
  const heights = new Float32Array(nx * ny);
  // a 40 x 30 m forest block at a uniform 12 m: one smooth canopy, no distinct peaks
  for (let j = 15; j < 45; j++) for (let i = 20; i < 60; i++) heights[j * nx + i] = 12;
  const g = { heights, nx, ny, minX: 0, minY: 0, cellM: 1 };
  const blocked = (x, y) => x >= 50 && y >= 15 && y < 45; // a green cut into the woods
  const { crowns, fill, trees } = canopyTrees(g, { blocked });
  assert.ok(crowns.length <= 1);
  assert.ok(fill.length >= 15, `fill ${fill.length}`);
  assert.equal(trees.length, crowns.length + fill.length);
  for (const [x, y, h, r] of fill) {
    assert.ok(x >= 19 && x <= 60 && y >= 14 && y <= 45, `inside the woods: ${x},${y}`);
    assert.ok(!blocked(x, y), `not on the green: ${x},${y}`);
    assert.ok(h > 10 && h <= 12.1, `canopy height ${h}`);
    assert.ok(r > 0 && r <= 4.2);
  }
  // the fill covers most of the open (unblocked) woods
  let covered = 0, total = 0;
  for (let y = 15; y < 45; y++) {
    for (let x = 20; x < 50; x++) {
      total++;
      if (trees.some(([tx, ty, , tr]) => Math.hypot(tx - x, ty - y) <= tr)) covered++;
    }
  }
  assert.ok(covered / total > 0.75, `coverage ${(covered / total).toFixed(2)}`);
});

test('no fill where crowns already cover the canopy', () => {
  const crowns = [{ x: -20, y: 0, h: 18, r: 7 }, { x: 5, y: 8, h: 10, r: 4 }];
  const g = grid(crowns);
  const { fill } = canopyTrees(g);
  assert.ok(fill.length <= 2, `fill ${fill.length}`);
});
