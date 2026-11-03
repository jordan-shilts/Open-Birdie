// Building shapes (public/render/building-shapes.js): roof types, insets and the
// merged vertex data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { minAreaRect, insetPolygon, roofPlan, triangulate, signedArea, buildingMeshData, cleanPolygon, simplifyPolygon } from '../public/render/building-shapes.js';

const rect = (cx, cy, L, W, deg) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [[-L / 2, -W / 2], [L / 2, -W / 2], [L / 2, W / 2], [-L / 2, W / 2]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
};
const L_SHAPE = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 25], [0, 25]];

test('the minimum-area rectangle finds a rotated house\'s axis and size', () => {
  const r = minAreaRect(rect(50, -20, 16, 9, 33));
  assert.ok(Math.abs(r.L - 16) < 1e-6 && Math.abs(r.W - 9) < 1e-6);
  assert.ok(Math.abs(Math.abs(r.ux * Math.cos(0.5760) + r.uy * Math.sin(0.5760)) - 1) < 1e-6, 'long axis along 33 deg');
  assert.ok(Math.abs(r.cx - 50) < 1e-6 && Math.abs(r.cy + 20) < 1e-6);
});

test('insets shrink cleanly, and fold-overs are refused', () => {
  const r = insetPolygon(rect(0, 0, 20, 10, 0), 2);
  assert.ok(r && Math.abs(signedArea(r) - 16 * 6) < 1e-6);
  const l = insetPolygon(L_SHAPE, 3);
  assert.ok(l && signedArea(l) > 0 && signedArea(l) < signedArea(L_SHAPE));
  assert.equal(insetPolygon(L_SHAPE, 6), null, 'a 10 m arm cannot inset 6 m');
  const grown = insetPolygon(rect(0, 0, 20, 10, 0), -1);
  assert.ok(Math.abs(signedArea(grown) - 22 * 12) < 1e-6, 'negative inset grows (eave overhang)');
});

test('ear clipping covers a concave footprint exactly', () => {
  const { poly, tris } = triangulate(L_SHAPE);
  assert.equal(tris.length, L_SHAPE.length - 2);
  const area = tris.reduce((s, [i, j, k]) => s + Math.abs(signedArea([poly[i], poly[j], poly[k]])), 0);
  assert.ok(Math.abs(area - signedArea(L_SHAPE)) < 1e-6);
});

test('roof types follow the footprint and use', () => {
  const plans = [];
  for (let i = 0; i < 20; i++) plans.push(roofPlan({ poly: rect(i * 40, 7, 15, 9, i * 7), kind: 'house' }).type);
  assert.ok(plans.every((t) => t === 'gable' || t === 'hip'));
  assert.ok(plans.includes('gable') && plans.includes('hip'), 'a street mixes gables and hips');
  assert.equal(roofPlan({ poly: L_SHAPE, kind: 'house' }).type, 'inset');
  assert.equal(roofPlan({ poly: rect(0, 0, 60, 40, 0), kind: 'commercial' }).type, 'flat');
  assert.equal(roofPlan({ poly: rect(0, 0, 80, 45, 0), kind: 'yes', clubhouse: true }).type, 'inset');
  assert.equal(roofPlan({ poly: rect(0, 0, 6, 5, 0), kind: 'roof' }).type, 'canopy');
});

test('mesh data: walls stand on the ground, roofs face up, a gable rises to its ridge', () => {
  const hAt = () => 10;
  const d = buildingMeshData([
    { poly: rect(0, 0, 14, 8, 0), kind: 'house', heightM: 5 },
    { poly: L_SHAPE.map(([x, y]) => [x + 100, y]), kind: 'house', heightM: 6.4 },
    { poly: rect(300, 0, 60, 40, 0), kind: 'commercial', heightM: 9 },
  ], hAt);
  assert.equal(d.count, 3);
  const ys = (arr) => arr.filter((_, i) => i % 3 === 1);
  assert.ok(Math.min(...ys(d.walls.pos)) < 10, 'walls sunk into the ground');
  assert.ok(Math.max(...ys(d.roofs.pos)) > 15 && Math.max(...ys(d.roofs.pos)) < 22);
  for (let i = 1; i < d.roofs.nor.length; i += 3) assert.ok(d.roofs.nor[i] >= -1e-6, 'roof normals face up');
  assert.equal(d.walls.wall.length / 4, d.walls.pos.length / 3, 'every wall vertex has facade coordinates');
  assert.equal(d.walls.col.length, d.walls.pos.length);
});

test('OSM outline quirks (closing duplicate, collinear points, small jogs) still get a pitched roof', () => {
  // a repeated first point (zero-length edge) used to make every inset fail
  const messy = [[0, 0], [20, 0], [20, 0.1], [40, 0], [40, 18], [21, 18], [21, 19.2], [19, 19.2], [19, 18], [0, 18], [0, 0]];
  const clean = cleanPolygon(messy);
  assert.ok(clean.length < messy.length && Math.hypot(clean[0][0] - clean.at(-1)[0], clean[0][1] - clean.at(-1)[1]) > 0.25);
  const mass = simplifyPolygon(clean, 2);
  assert.ok(mass.length <= 5, 'the 1.2 m porch jog is smoothed off the roof outline');
  assert.ok(insetPolygon(mass, 5));
  const d = buildingMeshData([{ poly: messy, kind: 'yes', clubhouse: true, heightM: 9 }], () => 0);
  const roofTop = Math.max(...d.roofs.pos.filter((_, i) => i % 3 === 1));
  assert.ok(roofTop > 10, `pitched, not flat (top ${roofTop.toFixed(1)} m)`);
});
