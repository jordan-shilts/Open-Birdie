// Shot-replay follow camera framing (public/render/flight-camera.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flightCameraPlan, flightCameraAt, CAM_CLEARANCE_M, DROP_ZOOM, MAX_CLIMB_ZOOM } from '../public/render/flight-camera.js';

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

test('landing vantage steps around trees', () => {
  const pts = drive();
  const free = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4 });
  // a tree right on the preferred vantage: the camera must pick another spot
  const tree = { x: free.end.x, y: free.end.y };
  const isClear = (x, y) => Math.hypot(x - tree.x, y - tree.y) > 8;
  const plan = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4, isClear });
  assert.ok(Math.hypot(plan.end.x - tree.x, plan.end.y - tree.y) > 8);
  assert.ok(plan.end.y < plan.land.y);                    // still behind the landing spot
});

test('lens closes in on the climb, runs straight to the drop zoom, eases out on the roll', () => {
  const pts = drive();
  const plan = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4 });
  assert.equal(flightCameraAt(plan, 0, pts).zoom, 1);                  // the address lens at impact
  let prev = 1;
  for (let t = 0; t <= plan.glideStart; t += 1 / 60) {                 // telephoto as the ball leaves
    const z = flightCameraAt(plan, t, pts).zoom;
    assert.ok(z >= prev - 1e-9 && z <= MAX_CLIMB_ZOOM, `climb t=${t.toFixed(2)} zoom ${z}`);
    prev = z;
  }
  assert.ok(prev > 1.5, `a drive's climb is shot telephoto (zoom ${prev})`);
  // through the glide the lens heads straight for DROP_ZOOM: no breathing back and forth
  prev = flightCameraAt(plan, plan.glideStart, pts).zoom;
  let dir = 0;
  for (let t = plan.glideStart + 1 / 60; t <= 4; t += 1 / 60) {
    const z = flightCameraAt(plan, t, pts).zoom;
    const s = Math.sign(z - prev);
    if (s) { assert.ok(!dir || s === dir, `lens turned at t=${t.toFixed(2)}`); dir = s; }
    prev = z;
  }
  const touchdown = flightCameraAt(plan, 4, pts).zoom;
  assert.ok(Math.abs(touchdown - DROP_ZOOM) < 1e-9);
  const rolledOut = flightCameraAt(plan, 6.5, pts).zoom;               // eased partly back out
  assert.ok(rolledOut > 1 && rolledOut < touchdown);
});

test('a high wedge closes the lens less, keeping the horizon in frame', () => {
  const wedge = [];
  for (let i = 0; i <= 230; i++) {
    const t = i * 0.02, air = Math.min(t, 4.6) / 4.6;
    wedge.push({ t, x: 0, y: 80 * air, z: t < 4.6 ? 84 * air * (1 - air) : 0 });   // 80 m carry, 21 m apex
  }
  const high = flightCameraPlan(wedge, { startCam, groundAt: flat, flightTime: 4.6 });
  const low = flightCameraPlan(drive(), { startCam, groundAt: flat, flightTime: 4 });
  assert.ok(high.climbZoomMax < low.climbZoomMax && high.climbZoomMax < 2, `wedge ${high.climbZoomMax}, drive ${low.climbZoomMax}`);
});

// Where the ball sits in the frame (NDC, ±1 at the edges) for a camera pose and lens.
function ndc(cam, ball, { fovDeg = 58, aspect = 16 / 9 } = {}) {
  const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const f = norm(sub(cam.look, cam.pos));
  const r = norm(cross(f, [0, 0, 1]));
  const u = cross(r, f);
  const b = sub(ball, cam.pos);
  const tanHalf = Math.tan((fovDeg / 2) * Math.PI / 180) / cam.zoom;
  const depth = dot(b, f);
  return { x: dot(b, r) / depth / (tanHalf * aspect), y: dot(b, u) / depth / tanHalf, depth };
}

test('the ball stays in frame through the whole replay, from the address framing on', () => {
  const pts = drive();
  const startLook = { x: 0, y: 58, z: 2 };   // the address camera looks down the hole
  const plan = flightCameraPlan(pts, { startCam, startLook, groundAt: flat, flightTime: 4 });
  for (let t = 0; t <= 5; t += 1 / 60) {
    const cam = flightCameraAt(plan, t, pts);
    const ball = pts.reduce((a, p) => (Math.abs(p.t - t) < Math.abs(a.t - t) ? p : a), pts[0]);
    const p = ndc(cam, ball);
    assert.ok(p.depth > 0 && Math.abs(p.x) < 0.85 && Math.abs(p.y) < 0.85, `t=${t.toFixed(2)} ndc (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
  }
  // no jolt at impact: the first frame looks exactly where the address camera looked
  const c0 = flightCameraAt(plan, 0, pts);
  const a = [c0.look.x - startCam.x, c0.look.y - startCam.y, c0.look.z - startCam.z];
  const b = [startLook.x - startCam.x, startLook.y - startCam.y, startLook.z - startCam.z];
  const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
  assert.ok(cos > 1 - 1e-9);
  // through the climb the ball rides above the middle of the frame, over the horizon
  const climbing = ndc(flightCameraAt(plan, 1.0, pts), pts[50]);
  assert.ok(climbing.y > 0.2 && climbing.y < 0.45, `climb ndc y ${climbing.y}`);
});

test('the camera stays under the ball once it glides, until the ball drops past it', () => {
  const pts = drive();
  const plan = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4 });
  for (const p of pts) {
    if (p.t < plan.glideStart || p.t > 4 || p.z < plan.end.z + 2) continue;
    const cam = flightCameraAt(plan, p.t, pts);
    assert.ok(cam.pos.z < p.z, `t=${p.t.toFixed(2)} camera ${cam.pos.z.toFixed(1)} m, ball ${p.z.toFixed(1)} m`);
  }
  assert.ok(plan.end.z <= 8 && plan.end.z >= 3);                      // a low vantage, not a crane shot
});

// a tree line (crowns up to 20 m) on the left of the fairway, from 100 m to 180 m out
const leftTrees = (x, y) => (x > -40 && x < -8 && y > 100 && y < 180 ? 20 : -Infinity);

test('the landing vantage takes the open side when the glide to the other crosses a tree line', () => {
  const pts = drive();   // drifts right, so the preferred vantage is on the left
  const open = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4 });
  assert.ok(open.end.x < open.land.x);
  const plan = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4, treeTopAt: leftTrees });
  assert.ok(plan.end.x > plan.land.x, 'switched to the open right side');
  assert.equal(plan.lift, null);                                         // and flies it low
});

test('the glide rises smoothly over tree crowns it cannot avoid, never at impact', () => {
  const pts = drive();
  const everywhere = (x, y) => (y > 60 && y < 160 ? 20 : -Infinity);   // trees across the whole hole
  const aroundTee = (x, y) => (y < 0 ? 12 : everywhere(x, y));          // and round the tee
  const plan = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4, treeTopAt: aroundTee });
  assert.deepEqual(flightCameraAt(plan, 0, pts).pos, startCam);          // leaves from the address camera
  let prev = flightCameraAt(plan, 0, pts).pos;
  for (let t = 1 / 60; t <= 5; t += 1 / 60) {
    const c = flightCameraAt(plan, t, pts).pos;
    assert.ok(Math.abs(c.z - prev.z) < 1.5, `height jump at t=${t.toFixed(2)}`);
    const u = (t - plan.glideStart) / (plan.glideEnd - plan.glideStart);
    if (u >= 0.2) assert.ok(c.z >= everywhere(c.x, c.y) - 1e-6, `in a crown at t=${t.toFixed(2)}`);
    prev = c;
  }
});

test('putts keep the base lens', () => {
  const pts = drive();
  const putt = flightCameraPlan(pts, { startCam, groundAt: flat, flightTime: 4, isPutt: true });
  for (const t of [0, 2, 4, 5]) assert.equal(flightCameraAt(putt, t, pts).zoom, 1);
});
