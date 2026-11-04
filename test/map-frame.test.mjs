// The overhead aim map's framing (public/map-frame.mjs): a full shot keeps the ball at
// the bottom; round the green the green fills the map, ball and cup inside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameMap, isNearGreen, NEAR_YD } from '../public/map-frame.mjs';

const W = 348, H = 470;
const px = (f, [u, v]) => [f.ox + u * f.s, f.oy - v * f.s];
const inside = ([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H;
// a 30 x 24 m green whose middle is `d` m up the line
const green = (d) => [[-15, d - 12], [15, d - 12], [15, d + 12], [-15, d + 12]];

test('near the green: a putt, or the pin inside NEAR_YD', () => {
  assert.equal(isNearGreen(NEAR_YD - 1), true);
  assert.equal(isNearGreen(NEAR_YD + 1), false);
  assert.equal(isNearGreen(150, true), true);
});

test('a full shot: the ball bottom centre, the pin in view, the scale as before', () => {
  const f = frameMap(W, H, { pinUV: [6, 200], greenUV: green(200) });
  assert.equal(f.near, false);
  assert.deepEqual([f.ox, f.oy], [W / 2, H - 30]);
  assert.ok(inside(px(f, [6, 200])));
  assert.equal(f.s, Math.min((H - 48) / 222, (W / 2 - 10) / 42));
});

test('a chip: the green fills the map with the ball and the cup on it', () => {
  const pin = [2, 11];
  const g = green(12).map(([u, v]) => [u, v + 4]);   // ball just short of the front edge
  const f = frameMap(W, H, { pinUV: pin, greenUV: g, restUV: [1, 12] });
  assert.equal(f.near, true);
  for (const p of [[0, 0], pin, ...g]) assert.ok(inside(px(f, p)), `in view: ${p}`);
  // far closer than the full-shot view's 70 m minimum reach
  const full = frameMap(W, H, { pinUV: [2, 60] });
  assert.ok(f.s > full.s * 2, `${f.s} vs ${full.s}`);
  // the green's 30 m fills most of the width
  assert.ok(30 * f.s > W * 0.7);
});

test('a tap-in still shows the green round the cup, not a few metres of it', () => {
  const f = frameMap(W, H, { pinUV: [0, 0.6], greenUV: [], putt: true });
  assert.equal(f.near, true);
  assert.ok(W / f.s >= 18 - 1e-9, `${(W / f.s).toFixed(1)} m across`);
  assert.ok(inside(px(f, [0, 0])) && inside(px(f, [0, 0.6])));
});
