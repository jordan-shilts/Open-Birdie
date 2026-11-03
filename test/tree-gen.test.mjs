// Procedural tree models (public/render/tree-gen.js): real branch skeletons with
// leaf/needle cards, sized like the species and cheap enough to build at load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTree, thinCards, TREE_SPECIES, TREE_SPECIES_NAMES } from '../public/render/tree-gen.js';

const hyp = (p) => Math.hypot(p[0], p[2]);

test('every species builds a full-height tree with a trunk, limbs and a leaf budget', () => {
  for (const name of TREE_SPECIES_NAMES) {
    const sp = TREE_SPECIES[name];
    const m = generateTree(name, 3);
    assert.equal(m.species, name);
    const top = Math.max(...m.cards.map((c) => c.p[1] + Math.abs(c.up[1])));
    assert.ok(top > sp.H * 0.85 && top < sp.H * 1.2, `${name} top ${top.toFixed(1)} vs H ${sp.H}`);
    assert.ok(m.branches.length >= 8, `${name} branches ${m.branches.length}`);
    // the trunk starts at the ground and is (to rounding) the thickest piece
    const maxR = Math.max(...m.branches.map((b) => b.ra));
    // (a clump birch has several stems; the stoutest one starts at the ground)
    const feet = m.branches.filter((b) => b.a[1] < 0.5);
    assert.ok(feet.length && Math.max(...feet.map((b) => b.ra)) > maxR * 0.95, `${name} trunk starts at the ground`);
    assert.ok(maxR > 0.12 && maxR < 0.6, `${name} trunk radius ${maxR.toFixed(2)}`);
    assert.ok(m.cards.length >= sp.leaves * 0.6 && m.cards.length <= sp.leaves * 1.5, `${name} cards ${m.cards.length}`);
    assert.ok(m.crownR > 1.5 && m.crownR < sp.H * 0.7, `${name} crownR ${m.crownR.toFixed(1)}`);
    for (const c of m.cards) {
      assert.ok(c.ao >= 0 && c.ao <= 1);
      assert.ok(Number.isFinite(c.p[0] + c.p[1] + c.p[2] + c.right[0] + c.up[1]));
    }
  }
});

test('the same seed gives the same tree; different seeds give different crowns', () => {
  const a = generateTree('oak', 11), b = generateTree('oak', 11), c = generateTree('oak', 12);
  assert.deepEqual(a.cards.slice(0, 5), b.cards.slice(0, 5));
  assert.equal(a.branches.length, b.branches.length);
  assert.notDeepEqual(a.cards.slice(0, 5), c.cards.slice(0, 5));
});

test('broadleaves are broad, conifers narrow; woods-grown trees lift their crowns', () => {
  const oak = generateTree('oak', 5), fir = generateTree('fir', 5), oakWoods = generateTree('oak', 5, { forest: true });
  assert.ok(oak.crownR / oak.H > fir.crownR / fir.H, 'oak crown wider for its height than a spruce');
  assert.ok(oakWoods.crownBase > oak.crownBase + 2, `crown base ${oak.crownBase.toFixed(1)} -> ${oakWoods.crownBase.toFixed(1)}`);
  // a spruce keeps foliage nearly to the ground; a pine's bole is bare to mid-height
  const lowest = (m) => Math.min(...m.cards.map((c) => c.p[1]));
  assert.ok(lowest(fir) < 2.5, `spruce lowest card ${lowest(fir).toFixed(1)}`);
  assert.ok(lowest(generateTree('pine', 5)) > 6, 'pine crown sits high');
});

test('branches fork and thin outward (pipe model), and cards sit in the crown', () => {
  const m = generateTree('maple', 2);
  const outer = m.branches.filter((b) => hyp(b.b) > m.crownR * 0.6);
  const inner = m.branches.filter((b) => hyp(b.b) < m.crownR * 0.2 && b.a[1] < m.crownBase);
  const mean = (l, f) => l.reduce((s, x) => s + f(x), 0) / Math.max(1, l.length);
  assert.ok(outer.length && inner.length);
  assert.ok(mean(outer, (b) => b.rb) < mean(inner, (b) => b.ra) * 0.3, 'outer twigs much thinner than the bole');
  const inCrown = m.cards.filter((c) => c.p[1] > m.crownBase - 1.5).length;
  assert.ok(inCrown / m.cards.length > 0.95);
});

test('lower levels of detail keep the silhouette with far fewer cards', () => {
  const m = generateTree('oak', 9);
  const mid = thinCards(m.cards, 4, 1), far = thinCards(m.cards, 14, 1);
  assert.ok(Math.abs(mid.length - m.cards.length / 4) <= 1);
  assert.ok(far.length < m.cards.length / 10);
  const area = (cs) => cs.reduce((s, c) => s + Math.hypot(...c.right) * Math.hypot(...c.up) * 4, 0);
  const ratio = area(mid) / area(m.cards);
  assert.ok(ratio > 0.5 && ratio < 1.2, `coverage ratio ${ratio.toFixed(2)}`);
  const reach = (cs) => Math.max(...cs.map((c) => hyp(c.p)));
  assert.ok(reach(far) > reach(m.cards) * 0.7, 'far LOD still spans the crown');
});

test('building every species variant stays fast enough for course load', () => {
  const t0 = performance.now();
  for (const name of TREE_SPECIES_NAMES) for (let v = 0; v < 3; v++) generateTree(name, 100 + v, { forest: v === 2 });
  const ms = performance.now() - t0;
  assert.ok(ms < 2500, `15 models in ${ms.toFixed(0)} ms`);
});
