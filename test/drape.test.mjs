'use strict';
// Pure tests for the surface-drape helpers (public/render/drape.js). These build
// the per-surface "patch" geometry (bunkers/greens/tees) that gives crisp,
// geometry-based boundaries. No three, no DOM — node-importable ESM.

import { test } from 'node:test';
import assert from 'node:assert';
import { densifyRing, drapeRing } from '../public/render/drape.js';

test('densifyRing splits long edges, leaves short ones, drops a closing dup', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.strictEqual(densifyRing(sq, 100).length, 4); // edges shorter than maxLen -> untouched
  const d = densifyRing(sq, 2.5);                      // each 10m edge -> 4 segments
  assert.ok(d.length > 4, `expected densified, got ${d.length}`);
  assert.ok(d.some((p) => p[0] === 0 && p[1] === 0));  // original corner kept
  // closing-duplicate is dropped (OSM polys often repeat the first vertex)
  assert.strictEqual(densifyRing([[0, 0], [10, 0], [0, 0]], 100).length, 2);
});

test('drapeRing: heights from sampler + offset, three coords (x, h, -y)', () => {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const { pos, uv } = drapeRing(ring, (x) => x * 0.1, bounds, 2);
  assert.strictEqual(pos.length, 4 * 3);
  assert.strictEqual(uv.length, 4 * 2);
  // vertex 1 = [10,0]: x=10, h = 10*0.1 + 2 = 3, z = -0
  assert.ok(Math.abs(pos[3] - 10) < 1e-6, `x ${pos[3]}`);
  assert.ok(Math.abs(pos[4] - 3) < 1e-6, `h ${pos[4]}`);
  assert.ok(Math.abs(pos[5] - 0) < 1e-6, `z ${pos[5]}`);
  for (let i = 1; i < pos.length; i += 3) assert.ok(Number.isFinite(pos[i]));
});

test('drapeRing: UV is normalized over bounds (matches the base terrain UV space)', () => {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const { uv } = drapeRing(ring, () => 0, bounds);
  assert.ok(Math.abs(uv[0] - 0) < 1e-6 && Math.abs(uv[1] - 0) < 1e-6); // [0,0] -> (0,0)
  assert.ok(Math.abs(uv[4] - 1) < 1e-6 && Math.abs(uv[5] - 1) < 1e-6); // [10,10] -> (1,1)
});

// ---- conforming patches ----
import { conformTriangles, groundNormal } from '../public/render/drape.js';

const area = (p, t) => Math.abs((p[t[1]][0] - p[t[0]][0]) * (p[t[2]][1] - p[t[0]][1]) - (p[t[2]][0] - p[t[0]][0]) * (p[t[1]][1] - p[t[0]][1])) / 2;
const signed = (p, t) => (p[t[1]][0] - p[t[0]][0]) * (p[t[2]][1] - p[t[0]][1]) - (p[t[2]][0] - p[t[0]][0]) * (p[t[1]][1] - p[t[0]][1]);
const SQ = [[0, 0], [12, 0], [12, 12], [0, 12]];
const SQ_TRIS = [[0, 1, 2], [0, 2, 3]];

test('conformTriangles: flat ground under short edges is left as it came', () => {
  const r = conformTriangles(SQ, SQ_TRIS, () => 5, { maxEdge: 100 });
  assert.strictEqual(r.points.length, 4);
  assert.deepStrictEqual(r.tris, SQ_TRIS);
});

test('conformTriangles: flat ground is still cut down to maxEdge', () => {
  const r = conformTriangles(SQ, SQ_TRIS, () => 0, { maxEdge: 6 });
  for (const [a, b, c] of r.tris) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      assert.ok(Math.hypot(r.points[u][0] - r.points[v][0], r.points[u][1] - r.points[v][1]) <= 6 + 1e-9);
    }
  }
});

test('conformTriangles: a bowl inside the ring is followed, not lidded over', () => {
  // a 1.5 m deep bowl in the middle of a square whose rim is all at height 0
  const bowl = (x, y) => -1.5 * Math.max(0, 1 - Math.hypot(x - 6, y - 6) / 5);
  const lid = conformTriangles(SQ, SQ_TRIS, bowl, { maxEdge: 100, minEdge: 100 });
  assert.strictEqual(lid.points.length, 4, 'with refinement off the patch is the old flat lid');
  const r = conformTriangles(SQ, SQ_TRIS, bowl, { maxEdge: 6, minEdge: 1, tol: 0.03 });
  assert.ok(r.points.length > 40, `the bowl needs interior points, got ${r.points.length}`);
  const lowest = Math.min(...r.points.map((p) => bowl(p[0], p[1])));
  assert.ok(lowest < -1.2, `a point sits near the bottom of the bowl (${lowest})`);
  // the draped surface stays within a few cm of the ground at every triangle's middle
  let worst = 0;
  for (const [a, b, c] of r.tris) {
    const mx = (r.points[a][0] + r.points[b][0] + r.points[c][0]) / 3, my = (r.points[a][1] + r.points[b][1] + r.points[c][1]) / 3;
    const plane = (bowl(...r.points[a]) + bowl(...r.points[b]) + bowl(...r.points[c])) / 3;
    worst = Math.max(worst, Math.abs(bowl(mx, my) - plane));
  }
  assert.ok(worst < 0.12, `worst mid-triangle gap ${worst.toFixed(3)} m`);
});

test('conformTriangles: covers the same area, keeps the winding, opens no cracks', () => {
  const hills = (x, y) => Math.sin(x * 0.9) * Math.cos(y * 0.7) * 0.8;
  const r = conformTriangles(SQ, SQ_TRIS, hills, { maxEdge: 5, minEdge: 1, tol: 0.02 });
  const total = r.tris.reduce((s, t) => s + area(r.points, t), 0);
  assert.ok(Math.abs(total - 144) < 1e-6, `area ${total}`);
  const want = Math.sign(signed(SQ, SQ_TRIS[0]));
  for (const t of r.tris) assert.strictEqual(Math.sign(signed(r.points, t)), want);
  // conforming: every edge inside the square is shared by exactly two triangles, and no
  // point lies in the middle of another triangle's edge (a T-junction is a crack)
  const edges = new Map();
  for (const [a, b, c] of r.tris) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = u < v ? `${u},${v}` : `${v},${u}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  const onRim = (p) => p[0] < 1e-9 || p[1] < 1e-9 || p[0] > 12 - 1e-9 || p[1] > 12 - 1e-9;
  for (const [k, n] of edges) {
    const [u, v] = k.split(',').map(Number);
    const rim = onRim(r.points[u]) && onRim(r.points[v]) &&
      (Math.abs(r.points[u][0] - r.points[v][0]) < 1e-9 || Math.abs(r.points[u][1] - r.points[v][1]) < 1e-9);
    assert.strictEqual(n, rim ? 1 : 2, `edge ${k} used ${n} times`);
  }
});

test('conformTriangles: stops at the triangle cap on ground it can never match', () => {
  const noise = (x, y) => Math.sin(x * 40) * Math.sin(y * 37) * 3;
  const r = conformTriangles(SQ, SQ_TRIS, noise, { maxEdge: 6, minEdge: 0.01, tol: 0.001, maxPasses: 40, maxTris: 500 });
  assert.ok(r.tris.length < 500 * 4, `capped, got ${r.tris.length}`);
});

test('groundNormal: up on the flat, leaning away from a rise, unit length', () => {
  assert.deepStrictEqual(groundNormal(() => 3, 0, 0), [-0, 1, 0]);
  const east = groundNormal((x) => x * 0.5, 0, 0);       // rises to the east
  assert.ok(east[0] < 0 && east[1] > 0 && Math.abs(east[2]) < 1e-12);
  const north = groundNormal((x, y) => y * 0.5, 0, 0);   // rises to the north (three -z)
  assert.ok(north[2] > 0 && Math.abs(north[0]) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...east) - 1) < 1e-12);
});
