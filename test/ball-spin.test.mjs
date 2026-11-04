// How the ball turns through a replay (public/render/ball.js): backspin in the air,
// tilted by the spin axis; a true roll on the ground.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ballTurn, MAX_SHOWN_SPIN_RPS } from '../public/render/ball.js';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const close = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test('in the air: backspin, whose Magnus force lifts the ball', () => {
  const t = ballTurn({ x: 0, y: 0 }, { x: 0, y: 1 }, 1 / 60, { air: true, spinRps: 3 });
  assert.ok(close(t.axis, [1, 0, 0]));
  // omega x v points up: lift
  assert.ok(close(cross(t.axis, [0, 1, 0]), [0, 0, 1]));
  assert.ok(Math.abs(t.angle - 2 * Math.PI * 3 / 60) < 1e-12);
});

test("a fade's spin axis tilts the lift to the right of the flight", () => {
  const t = ballTurn({ x: 0, y: 0 }, { x: 0, y: 1 }, 1 / 60, { air: true, spinRps: 3, spinAxisDeg: 20 });
  const f = cross(t.axis, [0, 1, 0]);
  assert.ok(f[0] > 0.3 && f[2] > 0.9, `force ${f}`);   // right (+x) and still up
  assert.ok(Math.abs(Math.hypot(...t.axis) - 1) < 1e-12);
});

test('a real backspin rate is shown capped, so a 60 Hz frame does not strobe it', () => {
  const wedge = ballTurn({ x: 0, y: 0 }, { x: 1, y: 0 }, 1 / 60, { air: true, spinRps: 150 });
  assert.ok(Math.abs(wedge.angle - 2 * Math.PI * MAX_SHOWN_SPIN_RPS / 60) < 1e-12);
});

test('on the ground: a roll without slipping, the top turning forward', () => {
  const r = 0.085;
  const t = ballTurn({ x: 0, y: 0 }, { x: 0.3, y: 0.4 }, 1 / 60, { air: false, radius: r });
  assert.ok(Math.abs(t.angle - 0.5 / r) < 1e-12);
  // the top of the ball (0, 0, r) moves along the roll: omega x r_top is along v
  const v = cross(t.axis, [0, 0, 1]);
  assert.ok(close(v, [0.6, 0.8, 0]), `top moves ${v}`);
});

test('no turn without motion across the ground (or without spin in the air)', () => {
  assert.equal(ballTurn({ x: 1, y: 1 }, { x: 1, y: 1 }, 1 / 60, {}), null);
  assert.equal(ballTurn({ x: 0, y: 0 }, { x: 0, y: 1 }, 1 / 60, { air: true, spinRps: 0 }), null);
  assert.equal(ballTurn({ x: 0, y: 0 }, { x: 0, y: 1 }, 0, { air: false }), null);
});
