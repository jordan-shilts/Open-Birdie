// Hole flyover path maths (public/render/flyover.js): easing, centripetal Catmull-Rom,
// arc-length sampling, the flight profile, and the free-camera pose used for captures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flyoverDuration, easeCruise, catmullRomChain, arcLengthTable, sampleAtLength, dedupePoints,
  holePath, flyoverLineForHole, buildFlyoverPath, flyoverPoseAt, freeCamPose, treeCeiling,
  FLYOVER_DEFAULTS,
} from '../public/render/flyover.js';
import { isPlayFraming, ballReadScale } from '../public/render/framing.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (±${eps})`);
const flat = () => 0;
// a 420 m par 4 with a dogleg right, and some rolling ground with a crest mid-hole
const DOGLEG = [[0, 0], [10, 250], [120, 400]];
const rolling = (x, y) => 8 * Math.sin(x / 90) + 6 * Math.cos(y / 70) + (Math.abs(y - 200) < 40 ? 25 : 0);

test('duration scales with hole length within 8-14 s', () => {
  assert.equal(flyoverDuration(0), 8);
  assert.equal(flyoverDuration(150), 8);       // short par 3: floor
  assert.equal(flyoverDuration(550), 14);      // long par 5: ceiling
  assert.equal(flyoverDuration(1000), 14);
  near(flyoverDuration(400), 11.75, 1e-9);
  let prev = 0;
  for (let L = 0; L <= 800; L += 25) { const d = flyoverDuration(L); assert.ok(d >= prev); prev = d; }
});

test('easeCruise starts and ends at rest, is monotonic and C1 across its phases', () => {
  assert.equal(easeCruise(0), 0);
  near(easeCruise(1), 1, 1e-12);
  assert.equal(easeCruise(-1), 0);
  assert.equal(easeCruise(2), 1);
  const h = 1e-4, v = (t) => (easeCruise(t + h) - easeCruise(t - h)) / (2 * h);
  near(v(h), 0, 0.01, 'start velocity');
  near(v(1 - h), 0, 0.01, 'end velocity');
  // constant-speed cruise in the middle, peak = 1 / (1 - (a+b)/2)
  near(v(0.5), 1 / (1 - (0.2 + 0.25) / 2), 1e-3, 'cruise speed');
  near(v(0.3), v(0.7), 1e-3, 'flat cruise');
  let prev = -1;
  for (let i = 0; i <= 1000; i++) {
    const s = easeCruise(i / 1000);
    assert.ok(s >= prev - 1e-12, `monotonic at ${i}`);
    prev = s;
  }
  // velocity continuous at the phase joins (no jerk-free guarantee needed, but no jumps)
  for (const t of [0.2, 0.75]) near(v(t - 3 * h), v(t + 3 * h), 0.01, `velocity jump at ${t}`);
});

test('centripetal Catmull-Rom passes through every key and ends exactly on the last', () => {
  const keys = [[0, 0, 0], [10, 0, 5], [30, 10, 5], [31, 40, 0]];
  const per = 16;
  const pts = catmullRomChain(keys, { perSeg: per });
  assert.equal(pts.length, (keys.length - 1) * per + 1);
  keys.forEach((k, i) => assert.deepEqual(pts[i * per].map((v) => +v.toFixed(9)), k));
  assert.deepEqual(pts[pts.length - 1], keys[keys.length - 1]);
});

test('centripetal spacing does not overshoot on very uneven key spacing', () => {
  // collinear keys, wildly uneven gaps: x must stay monotonic (uniform CR would loop back)
  const keys = [[0, 0, 0], [1, 0, 0], [100, 0, 0], [101, 0, 0], [300, 0, 0]];
  const pts = catmullRomChain(keys, { perSeg: 30 });
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i][0] >= pts[i - 1][0] - 1e-9, `x went back at ${i}`);
  for (const p of pts) near(p[1], 0, 1e-9);
});

test('extra components ride along the spline (along-hole distance)', () => {
  const keys = [[0, 0, 0, -30], [0, 100, 40, 70], [0, 200, 40, 170], [0, 300, 10, 270]];
  const pts = catmullRomChain(keys, { perSeg: 20, spaceDims: 3 });
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i][3] > pts[i - 1][3], 'distance increases');
});

test('arc-length table samples at true distances', () => {
  const t = arcLengthTable([[0, 0], [3, 4], [3, 14]], 2);
  assert.equal(t.total, 15);
  assert.deepEqual(sampleAtLength(t, 0), [0, 0]);
  assert.deepEqual(sampleAtLength(t, 5), [3, 4]);
  assert.deepEqual(sampleAtLength(t, 10), [3, 9]);
  assert.deepEqual(sampleAtLength(t, 99), [3, 14]);
});

test('dedupePoints drops repeated / invalid points', () => {
  assert.deepEqual(dedupePoints([[0, 0], [0.1, 0], [5, 5], [5, 5.2], [NaN, 1], [9, 9]]), [[0, 0], [5, 5], [9, 9]]);
});

test('holePath: smooth hole line with straight extrapolation past both ends', () => {
  const h = holePath([[0, 0], [0, 100]]);
  near(h.length, 100, 1e-9);
  assert.deepEqual(h.at(-30), [0, -30]);   // behind the tee, along the first leg
  assert.deepEqual(h.at(130), [0, 130]);   // past the pin, along the last leg
  near(h.at(50)[1], 50, 1e-9);
  const dog = holePath(DOGLEG);
  assert.ok(dog.length > Math.hypot(10, 250) + Math.hypot(110, 150) - 1, 'smoothed dogleg ~ polyline length');
  assert.deepEqual(dog.at(0), [0, 0]);
  const end = dog.at(dog.length);
  near(end[0], 120, 1e-6); near(end[1], 400, 1e-6);
  assert.equal(holePath([[1, 1]]), null);
  assert.equal(holePath([[1, 1], [1, 1.2]]), null);
});

test('flyoverLineForHole uses the matching OSM line with its ends pinned to tee and pin', () => {
  const holes = [
    { tee: [500, 500], pin: [600, 900], line: [[500, 500], [600, 900]] },
    { tee: [0, 0], pin: [120, 400], line: [[0, 0], [10, 250], [118, 402]] },
  ];
  assert.deepEqual(flyoverLineForHole(holes, { tee: [0.5, 0], pin: [120, 400] }), [[0.5, 0], [10, 250], [120, 400]]);
  // no matching line -> straight tee -> pin
  assert.deepEqual(flyoverLineForHole(holes, { tee: [-300, 0], pin: [-300, 200] }), [[-300, 0], [-300, 200]]);
  assert.equal(flyoverLineForHole(holes, null), null);
});

test('flight: low behind the tee, 40-60 m cruise, descends short of the pin, looking at it', () => {
  const path = buildFlyoverPath({ line: DOGLEG, groundAt: rolling });
  const L = holePath(DOGLEG).length;
  assert.ok(path.duration >= 8 && path.duration <= 14);
  near(path.duration, flyoverDuration(L), 1e-9);
  assert.ok(path.cruiseAgl >= 40 && path.cruiseAgl <= 60);

  const start = flyoverPoseAt(path, 0);
  const startD = path.cam.pts[0][3];
  near(startD, -FLYOVER_DEFAULTS.startBackM, 1e-6, 'starts behind the tee');
  assert.ok(start.pos[1] < 0, 'south of the tee (hole runs north)');
  near(start.pos[2] - rolling(start.pos[0], start.pos[1]), FLYOVER_DEFAULTS.startAglM, 6, 'starts low');

  const mid = flyoverPoseAt(path, path.duration / 2);
  const midAgl = mid.pos[2] - rolling(mid.pos[0], mid.pos[1]);
  assert.ok(midAgl >= 30 && midAgl <= 75, `cruise height ${midAgl}`);
  // look target is ahead along the hole and below the camera
  assert.ok(mid.look[2] < mid.pos[2] - 20);
  assert.ok(Math.hypot(mid.look[0] - mid.pos[0], mid.look[1] - mid.pos[1]) > 60);

  const end = flyoverPoseAt(path, path.duration);
  const endAgl = end.pos[2] - rolling(end.pos[0], end.pos[1]);
  assert.ok(endAgl < midAgl, 'descends toward the green');
  near(Math.hypot(end.pos[0] - 120, end.pos[1] - 400), FLYOVER_DEFAULTS.endBackM, 12, 'stops short of the pin');
  near(end.look[0], 120, 1e-6); near(end.look[1], 400, 1e-6); // looking at the flag
  assert.deepEqual(flyoverPoseAt(path, 999), end, 'clamped past the end');
});

test('flight never dips below the terrain clearance and moves smoothly', () => {
  const path = buildFlyoverPath({ line: DOGLEG, groundAt: rolling });
  for (const p of path.cam.pts) assert.ok(p[2] >= rolling(p[0], p[1]) + FLYOVER_DEFAULTS.minClearM - 1e-6);
  // 60 fps steps: no jumps, speed bounded, and the view direction turns gently
  const dt = 1 / 60;
  let prev = flyoverPoseAt(path, 0), prevDir = null, maxStep = 0, maxTurn = 0;
  for (let t = dt; t <= path.duration + 1e-9; t += dt) {
    const p = flyoverPoseAt(path, t);
    maxStep = Math.max(maxStep, Math.hypot(p.pos[0] - prev.pos[0], p.pos[1] - prev.pos[1], p.pos[2] - prev.pos[2]));
    const d = [p.look[0] - p.pos[0], p.look[1] - p.pos[1], p.look[2] - p.pos[2]];
    const n = Math.hypot(...d);
    const dir = d.map((v) => v / n);
    if (prevDir) maxTurn = Math.max(maxTurn, Math.acos(Math.min(1, dir[0] * prevDir[0] + dir[1] * prevDir[1] + dir[2] * prevDir[2])));
    prev = p; prevDir = dir;
  }
  assert.ok(maxStep < 1.2, `max step per frame ${maxStep} m (< 72 m/s)`);
  assert.ok(maxTurn < (1.5 * Math.PI) / 180, `max view turn per frame ${(maxTurn * 180) / Math.PI}°`);
});

test('a short straight par 3 still climbs to at least 40 m', () => {
  const path = buildFlyoverPath({ line: [[0, 0], [0, 160]], groundAt: flat });
  near(path.duration, 8.15, 1e-9);
  const top = Math.max(...path.cam.pts.map((p) => p[2]));
  assert.ok(top >= 38, `peak ${top}`);
});

test('tree ceiling: the highest crown (plus margin) over a point, open ground is unbounded', () => {
  const trees = [{ x: 0, y: 0, h: 20, r: 6 }, { x: 4, y: 0, h: 30, r: 4 }, { x: 100, y: 0, s: 1 }];
  const top = treeCeiling(trees, (x) => (x > 50 ? 10 : 0), { marginM: 3 });
  assert.equal(top(1, 0), 33);        // both crowns cover it: the taller wins
  assert.equal(top(-7, 0), 23);       // only the wide one (r 6 + 3)
  assert.equal(top(-12, 0), -Infinity);
  assert.equal(top(100, 0), 10 + 14 + 3); // default crown from the spot scale, on raised ground
  assert.equal(treeCeiling([], flat), null);
});

test('the flight is lifted smoothly over tree crowns it would clip', () => {
  // a tall stand right where the flight starts low, and one under the descent to the green
  const trees = [{ x: 0, y: -32, h: 24, r: 8 }, { x: 0, y: 356, h: 28, r: 10 }];
  const treeTopAt = treeCeiling(trees, flat);
  const path = buildFlyoverPath({ line: [[0, 0], [0, 400]], groundAt: flat, treeTopAt });
  for (const p of path.cam.pts) assert.ok(p[2] >= treeTopAt(p[0], p[1]) - 1e-9, `clips a crown at ${p.map((v) => v.toFixed(1))}`);
  assert.ok(path.cam.pts[0][2] >= 24 + 3);
  // and stays smooth: no vertical step larger than the slope of the climb allows
  for (let i = 1; i < path.cam.pts.length; i++) {
    const a = path.cam.pts[i - 1], b = path.cam.pts[i];
    assert.ok(Math.abs(b[2] - a[2]) <= 1.2 * Math.hypot(b[0] - a[0], b[1] - a[1]) + 0.05, `step at ${i}`);
  }
  const bare = buildFlyoverPath({ line: [[0, 0], [0, 400]], groundAt: flat });
  assert.ok(bare.cam.pts[0][2] < 24, 'without trees it starts lower');
});

test('degenerate lines produce no flight', () => {
  assert.equal(buildFlyoverPath({ line: [[0, 0]] }), null);
  assert.equal(buildFlyoverPath({ line: [] }), null);
});

test('freeCamPose reproduces the flyover camera through the free-camera maths', () => {
  const pos = [10, -20, 45], look = [60, 90, 3];
  const ground = (x, y) => 0.5 + 0.01 * x;
  const f = freeCamPose(pos, look, ground);
  // GolfScene._freeStep then _freeTargets:
  const h = ground(f.tx, f.ty) + 2 + f.hOff;
  const yaw = (f.yaw * Math.PI) / 180, pitch = (f.pitch * Math.PI) / 180;
  const horiz = Math.cos(pitch) * f.dist, up = -Math.sin(pitch) * f.dist;
  const cam = [f.tx - Math.sin(yaw) * horiz, f.ty - Math.cos(yaw) * horiz, h + up];
  cam.forEach((v, i) => near(v, pos[i], 1e-9, `axis ${i}`));
  near(h, look[2], 1e-9);
  assert.ok(f.pitch < 0, 'looking down');
});

test("'flyover' is not a play framing (no aim line, no inflated ball)", () => {
  assert.equal(isPlayFraming('flyover', null), false);
  assert.equal(ballReadScale(500, 'flyover', null), 1);
});
