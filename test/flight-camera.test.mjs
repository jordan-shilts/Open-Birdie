// Shot-replay follow camera framing (public/render/flight-camera.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flightCameraPlan, flightCameraAt, CAM_CLEARANCE_M, DROP_ZOOM, MAX_CLIMB_ZOOM, FOLLOW_BACK_M, SETTLE_BACK_M,
} from '../public/render/flight-camera.js';
import { pointAt } from '../public/render/flight-profile.js';

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

// ---- the follow camera: it flies with the ball ----
const follow = (pts, extra = {}) => flightCameraPlan(pts, {
  startCam, startLook: { x: 0, y: 58, z: 2 }, groundAt: flat, flightTime: 4, mode: 'follow', ...extra,
});
// the drive again, but the roll slows to a stop (18 m/s to rest over 2 s), then a second at rest
function driveStops() {
  const pts = [];
  for (let i = 0; i <= 350; i++) {
    const t = i * 0.02, air = Math.min(t, 4) / 4, r = Math.min(Math.max(0, t - 4), 2);
    pts.push({ t, x: 12 * air * air + 2 * r - 0.5 * r * r, y: 200 * air + 18 * r - 4.5 * r * r, z: t < 4 ? 120 * air * (1 - air) : 0 });
  }
  return pts;
}
// a wedge: 110 m carry, 30 m apex, down at 5 s, checking up in 0.6 s
function wedgeChecks() {
  const pts = [];
  for (let i = 0; i <= 300; i++) {
    const t = i * 0.02, air = Math.min(t, 5) / 5, r = Math.min(Math.max(0, t - 5), 0.6);
    pts.push({ t, x: 0, y: 110 * air + 6 * r - 5 * r * r, z: t < 5 ? 120 * air * (1 - air) : 0 });
  }
  return pts;
}
const lastT = (plan, pts) => pts[pts.length - 1].t + (plan.tail || 0);

test('follow: leaves exactly from the address camera, looking where it looked', () => {
  const pts = drive();
  const c = flightCameraAt(follow(pts), 0, pts);
  assert.ok(Math.hypot(c.pos.x - startCam.x, c.pos.y - startCam.y, c.pos.z - startCam.z) < 1e-9);
  assert.ok(Math.hypot(c.look.x - 0, c.look.y - 58, c.look.z - 2) < 1e-9);
  assert.equal(c.zoom, 1);
});

test('follow: the ball gets away, then the camera catches it up and rides with it', () => {
  const pts = drive();
  const plan = follow(pts);
  const at = (t) => flightCameraAt(plan, t, pts).pos;
  const gap = (t) => { const c = at(t), b = pointAt(pts, t); return Math.hypot(b.x - c.x, b.y - c.y, b.z - c.z); };
  for (let t = 1; t < 4; t += 0.25) assert.ok(gap(t) > FOLLOW_BACK_M && gap(t) < 35, `t=${t}: ${gap(t).toFixed(1)} m behind`);
  assert.ok(gap(3.5) < gap(1) - 5, 'closes in as the flight goes on');
  // from two seconds on it moves with the ball: the same way, near the same speed
  for (let t = 2; t < 3.9; t += 0.25) {
    const c0 = at(t - 0.05), c1 = at(t + 0.05), b0 = pointAt(pts, t - 0.05), b1 = pointAt(pts, t + 0.05);
    const cv = [c1.x - c0.x, c1.y - c0.y, c1.z - c0.z], bv = [b1.x - b0.x, b1.y - b0.y, b1.z - b0.z];
    const cs = Math.hypot(...cv), bs = Math.hypot(...bv);
    const cos = (cv[0] * bv[0] + cv[1] * bv[1] + cv[2] * bv[2]) / (cs * bs);
    assert.ok(cos > 0.9 && cs / bs > 0.8 && cs / bs < 1.4, `t=${t}: cos ${cos.toFixed(2)}, speed ${(cs / bs).toFixed(2)} of the ball's`);
  }
});

test('follow: it never passes the ball, through the flight, the bounces and the roll', () => {
  for (const [pts, ft] of [[driveStops(), 4], [wedgeChecks(), 5]]) {
    const plan = follow(pts, { flightTime: ft });
    for (let t = 0.3; t <= lastT(plan, pts); t += 1 / 60) {
      const c = flightCameraAt(plan, t, pts).pos, b = pointAt(pts, t);
      assert.ok(b.y - c.y > 5, `t=${t.toFixed(2)}: ${(b.y - c.y).toFixed(1)} m behind`);
    }
  }
});

test('follow: no jolts, from impact to rest: its push changes smoothly frame to frame', () => {
  for (const [pts, ft] of [[driveStops(), 4], [wedgeChecks(), 5]]) {
    const plan = follow(pts, { flightTime: ft });
    const h = 1 / 60, at = (t) => flightCameraAt(plan, t, pts);
    const dir = (c) => { const v = [c.look.x - c.pos.x, c.look.y - c.pos.y, c.look.z - c.pos.z]; const l = Math.hypot(...v); return v.map((x) => x / l); };
    let prevAcc = null, prevSpeed = 0;
    for (let t = h; t <= lastT(plan, pts) - h; t += h) {
      const a = at(t - h).pos, b = at(t).pos, c = at(t + h).pos;
      assert.ok(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) < 1.6, `jump at t=${t.toFixed(2)}`);
      if (t < 0.5) {   // it sets off forward only, from standing
        assert.ok(b.y - a.y >= -1e-6, `backs up at t=${t.toFixed(2)}`);
        const speed = Math.hypot(c.x - b.x, c.y - b.y, c.z - b.z) / h;
        assert.ok(speed >= prevSpeed - 0.5, `stalls at t=${t.toFixed(2)}`);
        prevSpeed = speed;
      }
      const acc = [c.x - 2 * b.x + a.x, c.y - 2 * b.y + a.y, c.z - 2 * b.z + a.z].map((v) => v / (h * h));
      if (prevAcc) {
        const jolt = Math.hypot(acc[0] - prevAcc[0], acc[1] - prevAcc[1], acc[2] - prevAcc[2]);
        assert.ok(jolt < 30, `a jolt of ${jolt.toFixed(1)} m/s2 in one frame at t=${t.toFixed(2)}`);
      }
      prevAcc = acc;
      const d0 = dir(at(t - h)), d1 = dir(at(t));
      const turn = Math.acos(Math.min(1, d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2])) * 180 / Math.PI;
      assert.ok(turn < 2.5, `the view swung ${turn.toFixed(2)} deg at t=${t.toFixed(2)}`);
    }
  }
});

test('follow: the ball stays near the middle of the frame through the replay', () => {
  for (const [pts, ft] of [[driveStops(), 4], [wedgeChecks(), 5]]) {
    const plan = follow(pts, { flightTime: ft });
    for (let t = 0.5; t <= lastT(plan, pts); t += 1 / 30) {
      const p = ndc(flightCameraAt(plan, t, pts), pointAt(pts, t));
      assert.ok(p.depth > 0 && Math.abs(p.x) < 0.5 && Math.abs(p.y) < 0.6, `t=${t.toFixed(2)} ndc (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
    }
  }
});

test('follow: once the ball stops the camera comes to rest behind it, over a short tail', () => {
  for (const [pts, ft] of [[driveStops(), 4], [wedgeChecks(), 5]]) {
    const plan = follow(pts, { flightTime: ft });
    assert.ok(plan.tail > 0 && plan.tail <= 1);
    const last = pts[pts.length - 1], T = lastT(plan, pts);
    const end = flightCameraAt(plan, T, pts).pos, before = flightCameraAt(plan, T - 0.2, pts).pos;
    const back = Math.hypot(last.x - end.x, last.y - end.y);
    assert.ok(Math.abs(back - SETTLE_BACK_M) < 1, `${back.toFixed(1)} m back`);
    assert.ok(last.y - end.y > 0, 'behind the ball');
    assert.ok(Math.hypot(end.x - before.x, end.y - before.y, end.z - before.z) < 0.1, 'at rest');
  }
});

test('follow: over rising ground and through trees the camera keeps its clearance', () => {
  const pts = drive();
  const hill = (x, y) => (y > 100 ? 40 : 0);
  const plan = follow(pts, { groundAt: hill });
  for (let t = 0.6; t <= lastT(plan, pts); t += 0.05) {
    const p = flightCameraAt(plan, t, pts).pos;
    assert.ok(p.z >= hill(p.x, p.y) + CAM_CLEARANCE_M - 1e-6, `t=${t.toFixed(2)} z ${p.z.toFixed(2)}`);
  }
  // a wood just behind the landing: the camera lifts over its crowns, smoothly
  const crowns = (x, y) => (y > 150 && y < 200 ? 18 : -Infinity);
  const wood = follow(pts, { treeTopAt: crowns });
  let prev = null;
  for (let t = 0.6; t <= lastT(wood, pts); t += 1 / 60) {
    const p = flightCameraAt(wood, t, pts).pos;
    assert.ok(p.z >= Math.max(crowns(p.x, p.y), CAM_CLEARANCE_M) - 1e-6, `t=${t.toFixed(2)} in the trees`);
    if (prev) assert.ok(Math.abs(p.z - prev) < 1.2, `t=${t.toFixed(2)} jumped up`);
    prev = p.z;
  }
});

test('follow: putts and short chips keep the address camera', () => {
  const pts = drive();
  const putt = follow(pts, { isPutt: true });
  assert.notEqual(putt.mode, 'follow');
  assert.deepEqual(flightCameraAt(putt, 4.5, pts).pos, startCam);
  const chip = [{ t: 0, x: 0, y: 0, z: 0 }, { t: 1, x: 0, y: 15, z: 5 }, { t: 2, x: 0, y: 30, z: 0 }];
  assert.equal(follow(chip, { flightTime: 2 }).moves, false);
});

// The approach: a wedge comes down at about 45 degrees. A camera riding its flight path
// looks down its trail at a frame full of turf; this one drops in level behind the ball.
test('follow: as the ball comes down the horizon and the landing spot stay in the frame', () => {
  const half = 29;   // half the 58 degree lens
  for (const [pts, ft] of [[wedgeChecks(), 5], [driveStops(), 4]]) {
    const plan = follow(pts, { flightTime: ft });
    const land = pointAt(pts, ft);
    for (let t = ft * 0.6; t <= ft; t += 1 / 30) {
      const c = flightCameraAt(plan, t, pts);
      const pitch = Math.atan2(c.look.z - c.pos.z, Math.hypot(c.look.x - c.pos.x, c.look.y - c.pos.y)) * 180 / Math.PI;
      assert.ok(pitch > -(half - 3), `t=${t.toFixed(2)}: looking ${(-pitch).toFixed(0)} deg down, the horizon is out of the frame`);
    }
    // over the last second and a half of the flight the landing spot is in the picture, ahead of the ball
    for (let t = ft - 1.5; t <= ft; t += 1 / 30) {
      const c = flightCameraAt(plan, t, pts);
      const p = ndc(c, land);
      assert.ok(p.depth > 0 && Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.95, `t=${t.toFixed(2)}: landing spot at ndc (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
    }
  }
});

test('follow: on the way up nothing changes, the camera still rides the flight path', () => {
  const pts = wedgeChecks();
  const plan = follow(pts, { flightTime: 5 });
  // 2 s in (climbing at ~14 degrees and more): the camera is below the ball, looking up at it
  const c = flightCameraAt(plan, 1.5, pts), b = pointAt(pts, 1.5);
  assert.ok(c.pos.z < b.z, 'behind and below a climbing ball');
  assert.ok(c.look.z > c.pos.z, 'looking up');
});
