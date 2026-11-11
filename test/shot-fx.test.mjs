// The shot tracer and landing ring (public/render/shot-fx.js): the sums that keep them
// from covering the ball. The drawing itself needs a GPU; this is the pure part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tracerVisibility, landingRingAlpha, TRACER_FRESH_S, TRACER_TAIL, TRACER_THIN, TRACER_NEAR_M, TRACER_WIDTH_PX,
  LAND_RING_REST, LAND_RING_SETTLE_S,
} from '../public/render/shot-fx.js';
import { FOLLOW_BACK_M } from '../public/render/flight-camera.js';

test('tracer: full strength and width right behind the ball, a faint thin line further back', () => {
  const far = 60;
  assert.deepEqual(tracerVisibility(0, far), { strength: 1, width: 1 });
  const old = tracerVisibility(TRACER_FRESH_S * 2, far);
  assert.equal(old.strength, TRACER_TAIL);
  assert.equal(old.width, TRACER_THIN);
  assert.ok(TRACER_TAIL <= 0.35 && TRACER_THIN <= 0.6, 'the older trail stays out of the way');
  // it only ever fades with age
  let prev = tracerVisibility(0, far);
  for (let age = 0.05; age < 3; age += 0.05) {
    const v = tracerVisibility(age, far);
    assert.ok(v.strength <= prev.strength + 1e-12 && v.width <= prev.width + 1e-12, `age ${age.toFixed(2)}`);
    prev = v;
  }
});

test('tracer: fades out toward the camera, and is whole by the time it reaches the ball', () => {
  assert.equal(tracerVisibility(0, TRACER_NEAR_M[0]).strength, 0);
  assert.equal(tracerVisibility(0, 1).strength, 0);
  assert.equal(tracerVisibility(0, TRACER_NEAR_M[1]).strength, 1);
  // the follow camera rides FOLLOW_BACK_M behind the ball: the ball's own comet is not dimmed
  assert.ok(TRACER_NEAR_M[1] <= FOLLOW_BACK_M);
  let prev = 0;
  for (let d = 0; d <= 20; d += 0.5) {
    const s = tracerVisibility(0.2, d).strength;
    assert.ok(s >= prev - 1e-12, `distance ${d}`);
    prev = s;
  }
});

test('tracer: a slim ribbon', () => {
  assert.ok(TRACER_WIDTH_PX <= 6);
});

test('landing ring: bright as the ball comes down, then out of the way of the roll', () => {
  assert.equal(landingRingAlpha(0), 1);
  assert.equal(landingRingAlpha(LAND_RING_SETTLE_S[0]), 1);
  assert.equal(landingRingAlpha(LAND_RING_SETTLE_S[1]), LAND_RING_REST);
  assert.equal(landingRingAlpha(Infinity), LAND_RING_REST);   // the replay is over
  assert.ok(LAND_RING_REST < 0.5);
});
