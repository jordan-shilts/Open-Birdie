'use strict';
// Club delivery for the shot panel (lib/club-delivery.js): measured club data passes
// through; what a monitor doesn't measure comes from the ball by the D-plane, marked est.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clubDelivery, strikeQuality } = require('../lib/club-delivery');

const ball = (o = {}) => ({ Speed: 112, VLA: 24.1, HLA: 1.5, SpinAxis: 0, TotalSpin: 7537, ...o });

test('a monitor that measures everything: the numbers pass through (a TrackMan 9 iron)', () => {
  const d = clubDelivery({ Speed: 84.5, Path: 1.9, FaceToTarget: 1.4, AngleOfAttack: -2.9, Loft: 28.9, HorizontalFaceImpact: 4.2, VerticalFaceImpact: -3 }, ball(), 'I9');
  assert.deepEqual(d.path, { v: 1.9, est: false });
  assert.deepEqual(d.face, { v: 1.4, est: false });
  assert.deepEqual(d.faceToPath, { v: -0.5, est: false });
  assert.deepEqual(d.attack, { v: -2.9, est: false });
  assert.deepEqual(d.dynamicLoft, { v: 28.9, est: false });
  assert.deepEqual(d.spinLoft, { v: 31.8, est: false });
  assert.deepEqual(d.impact, { x: 4.2, y: -3 });
  assert.equal(d.clubSpeed, 84.5);
  assert.equal(d.smash, 1.33);
});

test('OpenFlight (club speed and path): the face comes from the start line, marked est', () => {
  const d = clubDelivery({ Speed: 84.5, Path: 1.9 }, ball({ HLA: 1.5 }), 'I9');
  assert.deepEqual(d.path, { v: 1.9, est: false });
  assert.equal(d.face.est, true);
  // start = 0.72 face + 0.28 path
  assert.ok(Math.abs(d.face.v - (1.5 - 0.28 * 1.9) / 0.72) < 0.06);
  assert.ok(Math.abs(d.faceToPath.v - (d.face.v - 1.9)) < 0.11);
  assert.equal(d.attack, null, 'not measured: no attack angle');
  assert.equal(d.dynamicLoft, null, 'no loft without an attack angle or a measured loft');
  assert.equal(d.impact, null);
});

test('ball data only: face to path from the spin axis, face and path from the start line', () => {
  const straight = clubDelivery(null, ball({ HLA: 2, SpinAxis: 0 }), 'I7');
  assert.equal(straight.faceToPath.v, 0);
  assert.equal(straight.face.v, 2);
  assert.equal(straight.path.v, 2);
  const fade = clubDelivery(null, ball({ HLA: 0, SpinAxis: 10, VLA: 12 }), 'DR');
  assert.ok(fade.faceToPath.v > 1 && fade.faceToPath.v < 5, `driver fade face to path ${fade.faceToPath.v}`);
  assert.ok(fade.face.v > fade.path.v, 'a fade: face open to the path');
  assert.ok(fade.face.est && fade.path.est && fade.faceToPath.est);
  const draw = clubDelivery(null, ball({ HLA: 0, SpinAxis: -10, VLA: 12 }), 'DR');
  assert.equal(draw.faceToPath.v, -fade.faceToPath.v);
});

test('a measured attack angle gives the dynamic and spin loft from the launch', () => {
  const d = clubDelivery({ Speed: 90, Path: 0.5, AngleOfAttack: -4 }, ball({ VLA: 20 }), 'I7');
  assert.equal(d.attack.v, -4);
  assert.equal(d.dynamicLoft.est, true);
  assert.ok(Math.abs(d.dynamicLoft.v - (20 + 0.6) / 0.85) < 0.06);
  assert.ok(Math.abs(d.spinLoft.v - (d.dynamicLoft.v + 4)) < 0.11);
});

test('a field left at 0 is not measured; putts and empty shots have no club card', () => {
  const d = clubDelivery({ Speed: 0, Path: 0, FaceToTarget: 0, AngleOfAttack: 0, Loft: 0 }, ball(), 'I7');
  assert.equal(d.clubSpeed, null);
  assert.equal(d.smash, null);
  assert.equal(d.strike, null);
  assert.equal(d.path.est, true);
  assert.equal(d.attack, null);
  assert.equal(clubDelivery({ Speed: 10 }, ball({ Speed: 8 }), null, { isPutt: true }), null);
  assert.equal(clubDelivery(null, null), null);
  assert.equal(clubDelivery(null, { Speed: 0, VLA: 10 }), null);
});

test('strike quality from the smash factor against the club best', () => {
  assert.equal(strikeQuality(1.49, 1.5), 'centered');
  assert.equal(strikeQuality(1.42, 1.5), 'slightly off');
  assert.equal(strikeQuality(1.3, 1.5), 'off-center');
  assert.equal(strikeQuality(null, 1.5), null);
  const d = clubDelivery({ Speed: 100 }, ball({ Speed: 149, VLA: 12 }), 'DR');
  assert.equal(d.smash, 1.49);
  assert.equal(d.strike, 'centered');
});
