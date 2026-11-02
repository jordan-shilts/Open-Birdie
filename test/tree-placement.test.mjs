// Woods fill + species stands (public/render/tree-placement.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillWoods, placeCourseTrees, speciesAt, pointInPoly, distToPolyEdge, SPECIES, speciesForCrown, realTreeSize } from '../public/render/tree-placement.js';

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

// ---------- real trees from canopy height data ----------

const holeLine = [[0, 0], [0, 400]];

test('real canopy trees replace the woods guesswork and keep their measured size', () => {
  const canopy = [[30, 100, 18, 6], [-25, 200, 9, 3.5], [40, 300, 14, 2.5]];
  const spots = placeCourseTrees({ canopy, woods: [square(100, 100, 200)], holeLines: [holeLine] });
  assert.equal(spots.length, 3, 'no woods fill when real trees exist');
  for (const [x, y, h, r] of canopy) {
    const p = spots.find((s) => s.x === x && s.y === y);
    assert.ok(p, `${x},${y} placed`);
    assert.equal(p.h, h);
    assert.equal(p.r, r);
    assert.ok(SPECIES.includes(p.species));
  }
});

test('an OSM tree on top of a real tree is dropped; a separate one is kept', () => {
  const spots = placeCourseTrees({
    canopy: [[10, 50, 12, 4]], trees: [[11.5, 50.5], [60, 80]], holeLines: [holeLine],
  });
  assert.equal(spots.length, 2);
  assert.ok(spots.some((p) => p.x === 60 && p.y === 80 && !p.h), 'the separate OSM tree');
  assert.ok(!spots.some((p) => p.x === 11.5), 'the duplicate OSM tree');
});

test('under the quality cap the trees nearest the holes win; near ones get grounding', () => {
  const canopy = [[500, 100, 10, 4], [20, 100, 10, 4], [150, 100, 10, 4], [5, 300, 10, 4]];
  const spots = placeCourseTrees({ canopy, holeLines: [holeLine], cap: 3 });
  assert.deepEqual(spots.map((p) => p.x), [5, 20, 150]);
  assert.deepEqual(spots.map((p) => p.edge), [true, true, false]);
});

test('real trees on greens, water or sand are dropped', () => {
  const spots = placeCourseTrees({
    canopy: [[10, 10, 12, 4], [50, 50, 12, 4]], holeLines: [holeLine], blocked: (x) => x > 30,
  });
  assert.deepEqual(spots.map((p) => p.x), [10]);
});

test('crown shape picks the tree type: narrow crowns are conifers, broad ones broadleaf', () => {
  for (let i = 0; i < 40; i++) {
    const x = i * 37, y = i * 53;
    assert.ok(['fir', 'pine'].includes(speciesForCrown(x, y, 16, 2.5)), 'spruce-like crown');
    assert.ok(['oak', 'birch'].includes(speciesForCrown(x, y, 12, 6)), 'oak-like crown');
  }
});

test('a real tree is scaled to its measured height, with the crown width kept plausible', () => {
  const { w, ht } = realTreeSize({ h: 26, r: 7 }, 13, 7);
  assert.ok(ht > 1.9 && ht < 2.1, `height scale ${ht}`);
  assert.ok(w >= ht * 0.55 * 0.94 && w <= ht * 1.6 * 1.06, `width ${w} within the ratio band`);
  // a noisy tiny radius cannot squash the model to a pole
  const thin = realTreeSize({ h: 13, r: 0.5 }, 13, 7);
  assert.ok(thin.w >= thin.ht * 0.55 * 0.94);
  // no radius: width follows height
  const noR = realTreeSize({ h: 13 }, 13, 7);
  assert.ok(Math.abs(noR.w - noR.ht) < 0.15);
});
