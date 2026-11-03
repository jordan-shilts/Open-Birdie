'use strict';
// The safe spot AUTO aims a full shot at (lib/safe-spot.js): the middle of the green when
// the club gets there, else the middle of this hole's fairway where the ball finishes,
// else the hole's line of play, else the pin — and the prediction aiming there
// (lib/predict.js aimAssist).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pointInPoly } = require('../lib/course');
const { Game } = require('../lib/game');
const { YD } = require('../lib/physics');
const { predictShot } = require('../lib/predict');
const { safeSpot, greenMiddle, lineAt, fairwayMiddle } = require('../lib/safe-spot');

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const circle = (cx, cy, r, n = 24) => Array.from({ length: n }, (_, k) => [cx + r * Math.cos(2 * Math.PI * k / n), cy + r * Math.sin(2 * Math.PI * k / n)]);
const lookup = (surfaces) => (x, y) => {
  for (const su of surfaces) if (pointInPoly(x, y, su.poly)) return su.kind;
  return 'rough';
};

test('the middle of a green is the point furthest inside it, even on an L-shaped green', () => {
  const ell = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]];   // its centroid is off the green
  const m = greenMiddle(ell);
  assert.ok(pointInPoly(m.x, m.y, ell));
  assert.ok(m.x < 10 && m.y < 10, `in the corner of the L, where it is widest: ${m.x}, ${m.y}`);
  const c = greenMiddle(circle(5, 7, 12));
  assert.ok(Math.hypot(c.x - 5, c.y - 7) < 1);
});

test('the line of play at a distance: the crossing furthest along a dogleg', () => {
  const line = [[0, 0], [0, 200], [100, 300]];
  const p = lineAt(line, { x: 0, y: 0 }, 250);
  assert.ok(p.x > 0 && p.y > 200, 'round the corner');
  assert.ok(Math.abs(Math.hypot(p.x, p.y) - 250) < 1e-6);
  assert.equal(lineAt(line, { x: 0, y: 0 }, 500), null);
});

test('the middle of the fairway at the distance played: this hole\'s, and wide enough', () => {
  const surfaces = [
    { kind: 'fairway', poly: rect(10, 50, 50, 330) },      // this hole's, right of the line
    { kind: 'fairway', poly: rect(130, 50, 170, 330) },    // the next hole's
    { kind: 'fairway', poly: rect(-12, 50, -8, 330) },     // a 4 m strip: too narrow to aim at
  ];
  const line = [[0, 0], [0, 360]];
  const m = fairwayMiddle({ ball: { x: 0, y: 0 }, r: 200, around: { x: 0, y: 200 }, surfaceAt: lookup(surfaces), line });
  assert.ok(m.x > 25 && m.x < 35, `middle of the 10-50 m fairway: ${m.x}`);
  assert.ok(Math.abs(Math.hypot(m.x, m.y) - 200) < 1e-6);
});

test('the safe spot: green when the club gets there, else fairway, else the line, else the pin', () => {
  const surfaces = [
    { kind: 'fairway', poly: rect(-20, 60, 20, 300) },
    { kind: 'green', poly: circle(0, 350, 15) },
  ];
  const course = { surfaces };
  const hole = { line: [[0, 0], [0, 350]] };
  const ball = { x: 0, y: 0 }, pin = { x: 4, y: 356 };   // a back-right pin
  const at = (restM, extra = {}) => safeSpot({ course, hole, ball, pin, restM, surfaceAt: lookup(surfaces), ...extra });
  const green = at(330);                                   // 5 m short of the front: close enough
  assert.equal(green.kind, 'green');
  assert.ok(Math.hypot(green.x, green.y - 350) < 1, 'the middle of the green, not the pin');
  assert.equal(at(250).kind, 'fairway');
  assert.equal(at(320).kind, 'line');                      // past the fairway, short of the green
  assert.equal(at(30).kind, 'line');                       // short of the fairway
  const bare = safeSpot({ course: { surfaces: [] }, hole: null, ball, pin, restM: 200, surfaceAt: () => 'rough' });
  assert.deepEqual(bare, { x: 4, y: 356, kind: 'pin' });
});

test('AUTO aims a crosswind 7-iron at the middle of a fairway that sits right of the pin', () => {
  const PIN = [0, 365];
  const g = new Game();
  g.setCourse({
    name: 'Safe Links',
    surfaces: [
      { kind: 'tee', poly: rect(-4, -4, 4, 4) },
      { kind: 'fairway', poly: rect(5, 40, 55, 330) },    // the fairway runs right of the line to the pin
      { kind: 'green', poly: circle(PIN[0], PIN[1], 16) },
    ],
    boundary: rect(-220, -60, 220, 470),
    holes: [{ ref: 1, par: 4, tee: [0, 0], pin: PIN, lengthYd: 399, line: [[0, 0], [30, 200], PIN] }],
  });
  g.setConditions({ windMph: 12, windFromDeg: 90 });      // from the east: pushes the ball left
  const p = predictShot(g, { club: 'I7' });
  const spot = p.aimAssist.spot;
  assert.equal(spot.kind, 'fairway');
  assert.ok(spot.x > 20 && spot.x < 40, `the fairway's middle: x ${spot.x}`);
  const aimed = predictShot(g, { club: 'I7', aimOffset: p.aimAssist.offsetDeg });
  // the ball comes down on the line to the spot (well inside the fairway)
  const toSpot = Math.atan2(spot.x, spot.y);
  const off = (aimed.land.x * Math.cos(toSpot) - aimed.land.y * Math.sin(toSpot)) / YD;
  assert.ok(Math.abs(off) < 0.5, `${off} yd off the line to the spot`);
  assert.equal(aimed.landSurface, 'fairway');
});
