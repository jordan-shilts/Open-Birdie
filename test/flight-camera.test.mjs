// Shot-replay follow camera framing (public/render/flight-camera.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flightCameraPlan, flightCameraAt, CAM_CLEARANCE_M } from '../public/render/flight-camera.js';

// 200 m drive due north, 30 m apex, lands at t = 4 s, rolls to t = 5 s, drifting right.
function drive() {
  const pts = [];
  for (let i = 0; i <= 250; i++) {
    const t = i * 0.02;
    const air = Math.min(t, 4) / 4;
    const roll = Math.max(0, t - 4);
    pts.push({ t, x: 12 * air * air + 2 * roll, y: 200 * air + 18 * roll, z: t < 4 ? 120 * air * (1 - air) : 0 });
  }
  return pts;
}
const flat = () => 0;
const startCam = { x: 0, y: -14, z: 4.6 };

test('camera starts exactly at the address camera (no cut at impact)', () => {
  const pts = drive();
  const plan = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4 });
  const c = flightCameraAt(plan, 0, pts);
  assert.deepEqual(c.pos, startCam);
  assert.ok(Math.hypot(c.look.x - pts[0].x, c.look.y - pts[0].y) < 1e-9);
});

test('camera holds the tee vantage through launch, then glides to the landing vantage', () => {
  const pts = drive();
  const plan = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4 });
  assert.ok(plan.moves);
  const early = flightCameraAt(plan, 1.0, pts);
  assert.ok(Math.hypot(early.pos.x - startCam.x, early.pos.y - startCam.y) < 1e-9);
  const end = flightCameraAt(plan, 4.5, pts);
  // behind (short of) the landing spot, beside the line, above the ground
  assert.ok(end.pos.y < plan.land.y && end.pos.y > plan.land.y - 75);
  assert.ok(Math.abs(end.pos.x - plan.land.x) >= 5);
  assert.ok(end.pos.z >= 6);
  // the camera sits on the side the ball curves away from (ball drifts +x here)
  assert.ok(end.pos.x < plan.land.x);
});

test('camera path is continuous (no frame-to-frame jumps)', () => {
  const pts = drive();
  const plan = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4 });
  let prev = flightCameraAt(plan, 0, pts).pos;
  for (let t = 1 / 60; t <= 5; t += 1 / 60) {
    const p = flightCameraAt(plan, t, pts).pos;
    assert.ok(Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z) < 3.5, `jump at t=${t.toFixed(2)}`);
    prev = p;
  }
});

test('look target leads the ball toward the landing while airborne, then sits on the ball', () => {
  const pts = drive();
  const plan = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4 });
  const mid = flightCameraAt(plan, 2, pts);
  const ballY = 100;
  assert.ok(mid.look.y > ballY && mid.look.y < plan.land.y);
  const rolling = flightCameraAt(plan, 4.6, pts);
  const ball = pts.find((p) => Math.abs(p.t - 4.6) < 1e-6);
  assert.ok(Math.abs(rolling.look.x - ball.x) < 1e-6 && Math.abs(rolling.look.y - ball.y) < 1e-6);
});

test('camera never dips below the clearance over rising terrain', () => {
  const pts = drive();
  const hill = (x, y) => (y > 100 ? 40 : 0);
  const plan = flightCameraPlan(pts, { startCam, groundAt: hill, flightTime: 4 });
  for (let t = 0; t <= 5; t += 0.05) {
    const p = flightCameraAt(plan, t, pts).pos;
    assert.ok(p.z >= hill(p.x, p.y) + CAM_CLEARANCE_M - 1e-9);
  }
});

test('putts and short chips keep the camera still', () => {
  const pts = drive();
  const putt = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4, isPutt: true });
  assert.equal(putt.moves, false);
  assert.deepEqual(flightCameraAt(putt, 4.5, pts).pos, startCam);
  const chip = [{ t: 0, x: 0, y: 0, z: 0 }, { t: 1, x: 0, y: 15, z: 5 }, { t: 2, x: 0, y: 30, z: 0 }];
  const plan = flightCameraPlan(chip, { startCam, groundAt: flat, flightTime: 2 });
  assert.equal(plan.moves, false);
});
