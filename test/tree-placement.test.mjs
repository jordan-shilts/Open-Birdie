// Woods fill + species stands (public/render/tree-placement.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillWoods, placeCourseTrees, speciesAt, pointInPoly, distToPolyEdge, SPECIES } from '../public/render/tree-placement.js';

const square = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];

test('fillWoods fills a polygon densely, all inside, with a tree line along the edge', () => {
  const poly = square(0, 0, 100);
  const pts = fillWoods(poly, { spacing: 7.5, seed: 3 });
  assert.ok(pts.every((p) => pointInPoly(p.x, p.y, poly)));
  // ~1 tree per 7.5^2 m^2 (old renderer: 1 per 18^2) — at least 120 in 1 ha
  assert.ok(pts.length > 120, `only ${pts.length}`);
  const edge = pts.filter((p) => p.edge);
  assert.ok(edge.length > 40);
  assert.ok(edge.every((p) => distToPolyEdge(p.x, p.y, poly) <= 3.6));
  const inner = pts.filter((p) => !p.edge);
  assert.ok(inner.every((p) => distToPolyEdge(p.x, p.y, poly) >= 7.5 * 0.55 - 1e-9));
});

test('fillWoods is deterministic and respects blocked ground', () => {
  const poly = square(0, 0, 60);
  assert.deepEqual(fillWoods(poly, { seed: 9 }), fillWoods(poly, { seed: 9 }));
  const blocked = (x) => x < 30;
  assert.ok(fillWoods(poly, { seed: 9, blocked }).every((p) => p.x >= 30));
  assert.deepEqual(fillWoods([[0, 0], [1, 1]]), []);
});

test('placeCourseTrees keeps explicit + edge trees first under the cap, then interior nearest the hole', () => {
  const woods = [square(0, 0, 200)];
  const holeLines = [[[0, 300], [200, 300]]];               // hole runs along the north side
  const all = placeCourseTrees({ trees: [[500, 500], [510, 510]], woods, holeLines, cap: 100000 });
  const capped = placeCourseTrees({ trees: [[500, 500], [510, 510]], woods, holeLines, cap: 400 });
  assert.equal(capped.length, 400);
  assert.deepEqual([capped[0].x, capped[0].y], [500, 500]);  // explicit first
  const edgeCount = all.filter((p) => p.edge).length;
  assert.ok(capped.slice(0, edgeCount).every((p) => p.edge));
  // the interior trees that survived the cap are the ones nearest the hole (north)
  const kept = capped.filter((p) => !p.edge);
  const dropped = all.filter((p) => !p.edge).slice(kept.length);
  const meanY = (xs) => xs.reduce((a, p) => a + p.y, 0) / xs.length;
  assert.ok(meanY(kept) > meanY(dropped));
  assert.ok(all.every((p) => SPECIES.includes(p.species)));
});

test('density scales the fill', () => {
  const woods = [square(0, 0, 150)];
  const hi = placeCourseTrees({ woods, density: 1 }).length;
  const lo = placeCourseTrees({ woods, density: 0.55 }).length;
  assert.ok(lo < hi * 0.75, `${lo} vs ${hi}`);
});

test('species form stands (neighbours mostly agree) and links courses lean to pines', () => {
  let same = 0, n = 0;
  for (let x = 0; x < 400; x += 10) for (let y = 0; y < 400; y += 10) {
    n++; if (speciesAt(x, y) === speciesAt(x + 3, y + 3)) same++;
  }
  assert.ok(same / n > 0.7, `neighbour agreement ${same / n}`);
  const count = (dry, sp) => { let c = 0; for (let x = 0; x < 2000; x += 13) for (let y = 0; y < 2000; y += 17) if (speciesAt(x, y, dry) === sp) c++; return c; };
  assert.ok(count(1, 'pine') > count(0, 'pine') * 1.4);
});
