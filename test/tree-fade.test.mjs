// Trees in front of the camera are drawn see-through (public/render/trees.js): the
// fade is worked out per tree in the vertex shader and dithered in the fragment
// shader, on leaves and bark alike; shadows (the depth material) are left whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/render/trees.js', import.meta.url), 'utf8');

test('the tree shader fades trees in front and keeps their shadows', () => {
  assert.match(src, /const FADE_NEAR_M = 45;/);
  assert.match(src, /const FADE_HUG_M = 9;/);
  assert.match(src, /const FADE_SHOWN = 0\.12;/);
  // one model-view multiply of the instance's origin per vertex, not a matrix product
  assert.match(src, /modelViewMatrix \* vec4\(instanceMatrix\[3\]\.xyz, 1\.0\)/);
  // the colour shader takes the fade; the depth (shadow) material does not
  const colour = src.slice(src.indexOf('function addTreeShader'), src.indexOf('function makeDepthMat'));
  const depth = src.slice(src.indexOf('function makeDepthMat'), src.indexOf('// ---------------------------------------------------------------- the field'));
  assert.match(colour, /\$\{FADE_VERT\}/);
  assert.match(colour, /\$\{FADE_FRAG\}/);
  assert.doesNotMatch(depth, /FADE_/);
  assert.match(colour, /tree3d-v3-fade-/);
});
