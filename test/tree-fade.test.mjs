// Trees in front of the camera are drawn see-through (public/render/tree-fade.js picks
// them; trees.js draws them as an alpha-blended ghost and keeps their shadows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFade, FADE_NEAR_M, FADE_HUG_M, FADE_SHOWN, FADE_AT } from '../public/render/tree-fade.js';

test('a tree squarely in front of the shot fades; one off to the side or far ahead does not', () => {
  // view space: camera at the origin looking down -z
  assert.equal(treeFade(0, -20, 15), 1, 'in the middle, 20 m ahead');
  assert.ok(treeFade(2, -30, 15) > FADE_AT, 'a little off centre, 30 m ahead');
  assert.equal(treeFade(0, -(FADE_NEAR_M + 5), 15), 0, 'past the near distance');
  assert.equal(treeFade(30, -20, 15), 0, 'well off to the side');
  assert.equal(treeFade(0, 40, 15), 0, 'behind the camera');
  // a tree hugging the camera fades wherever it stands, even just behind
  assert.ok(treeFade(FADE_HUG_M * 0.5, 2, 15) > FADE_AT);
  assert.equal(treeFade(FADE_HUG_M * 2, 3, 15), 0);
  // taller trees reach further across the view
  assert.ok(treeFade(7, -25, 25) > treeFade(7, -25, 8));
});

test('the renderer draws faded trees as a blended ghost that keeps its shadow', () => {
  const src = fs.readFileSync(new URL('../public/render/trees.js', import.meta.url), 'utf8');
  assert.ok(FADE_SHOWN > 0.05 && FADE_SHOWN < 0.3);
  assert.match(src, /transparent: true, opacity: FADE_SHOWN/);
  assert.match(src, /alphaTest: 0\.5 \* FADE_SHOWN/);
  assert.match(src, /treeFade\(vx, vz, treeH\) > FADE_AT\) lod = 3/);
  // the ghost bucket casts shadows like the near model
  assert.match(src, /lods\.push\(\[mk\(lods\[0\]\[0\]\.geometry, ghostBark, depthBark, true\), mk\(lods\[0\]\[1\]\.geometry, ghostCard, depthCards, true\)\]\)/);
  // no dithering left in the shaders
  assert.doesNotMatch(src, /gl_FragCoord/);
});
