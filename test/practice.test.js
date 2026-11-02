'use strict';
// Driving range and mini games (lib/practice.js) on a flat test course, and how a
// session sits beside the round in the Game: it borrows the course, never the round.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../lib/game');
const { YD } = require('../lib/physics');
const { PracticeSession, longAxis, practiceGround, targetPoints } = require('../lib/practice');

// A range 60 x 300 m running north from y = 0, its tee end beside hole 1's tee; hole 2
// is a 150 yd par 3, hole 3 a 190 yd par 3.
function course({ range = true } = {}) {
  return {
    name: 'Practice Links',
    boundary: null,
    elevation: null,
    surfaces: range ? [{ kind: 'range', poly: [[-30, 0], [30, 0], [30, 300], [-30, 300]] }] : [],
    holes: [
      { ref: 1, par: 4, tee: [80, -20], pin: [80, 330], lengthYd: 380, line: [[80, -20], [80, 330]] },
      { ref: 2, par: 3, tee: [200, 0], pin: [200, 150 * YD], lengthYd: 150, line: [[200, 0], [200, 150 * YD]] },
      { ref: 3, par: 3, tee: [300, 0], pin: [300, 190 * YD], lengthYd: 190, line: [[300, 0], [300, 190 * YD]] },
    ],
  };
}
const DRIVE = { speedMph: 150, vla: 12, hla: 0, totalSpin: 2600, spinAxis: 0 };
const WEDGE = { speedMph: 90, vla: 26, hla: 0, totalSpin: 9300, spinAxis: 0 };
const session = (mode, options = {}, c = course()) => {
  const g = new Game();
  g.setCourse(c);
  return new PracticeSession({ course: c, surfaceAt: g.surfaceAt, terrain: g.terrain, treeObstacles: g.treeObstacles }, { mode, ...options });
};

test('the long axis of a range is its long side, centred', () => {
  const box = longAxis([[-30, 0], [30, 0], [30, 300], [-30, 300]]);
  assert.ok(Math.abs(Math.abs(box.axis[1]) - 1) < 1e-9);
  assert.ok(Math.abs(box.halfLength - 150) < 1e-9 && Math.abs(box.halfWidth - 30) < 1e-9);
  assert.deepEqual(box.center.map((v) => Math.round(v)), [0, 150]);
});

test('practice is played from the mapped range, from the end by the first tee', () => {
  const g = practiceGround(course());
  assert.equal(g.kind, 'range');
  assert.ok(Math.abs(g.dir[0]) < 1e-9 && Math.abs(g.dir[1] - 1) < 1e-9, 'north, along the long side');
  assert.ok(Math.abs(g.spot[1] - 8) < 1e-6, 'a few metres in from the south end');
  assert.ok(Math.abs(g.lengthYd - 292 / YD) < 1e-6);
  // the far end is used when the first tee is at the north end
  const flipped = course();
  flipped.holes[0].tee = [80, 320];
  const f = practiceGround(flipped);
  assert.ok(f.dir[1] < -0.99 && Math.abs(f.spot[1] - 292) < 1e-6);
  // no range mapped: hole 1's tee, down the hole
  const none = practiceGround(course({ range: false }));
  assert.equal(none.kind, 'hole');
  assert.deepEqual(none.spot, [80, -20]);
});

test('driving range: yardage flags, every ball from the same spot, club averages', () => {
  const s = session('range');
  assert.deepEqual(s.flags.map((f) => f.yd), [50, 100, 150, 200, 250, 300]);
  assert.equal(s.target.yd, 150);
  s.setTarget(210);
  assert.equal(s.target.yd, 200, 'snapped to the nearest flag');
  const first = s.play(DRIVE, 'DRIVER');
  const second = s.play(WEDGE, 'PW');
  assert.deepEqual(first.from, second.from, 'both balls from the range tee');
  assert.equal(s.over, false, 'a range bucket never runs out');
  s.play({ ...WEDGE, speedMph: 80 });   // no club named: 80 mph is put down to a PW, as on the HUD
  const stats = s.state().clubStats;
  assert.deepEqual(stats.map((c) => [c.club, c.n]), [['DRIVER', 1], ['PW', 2]]);
  assert.ok(stats[0].carryYd > stats[1].carryYd);
  assert.ok(first.practice.shot.note.includes('200 yd flag'));
  // the flags stand off the line on alternating sides, so they don't hide each other
  const side = (f) => Math.sign(f.x - s.spot[0]);
  assert.notEqual(side(s.flags[0]), side(s.flags[1]));
});

test('closest to the pin: the shortest par 3, five balls, the best one counts', () => {
  const s = session('closest');
  assert.equal(s.state().holeRef, 2);
  assert.deepEqual(s.state().par3s.map((h) => h.ref), [2, 3]);
  for (let i = 0; i < 5; i++) s.play(WEDGE, 'PW');
  assert.equal(s.over, true);
  assert.equal(s.play(WEDGE), null, 'no sixth ball');
  const best = Math.min(...s.shots.map((x) => x.toTargetYd));
  assert.equal(s.score().yd, best);
  // a ball in the water has no distance, however near the pin it lands
  const wet = course();
  wet.surfaces.push({ kind: 'water', poly: [[180, 40], [220, 40], [220, 130], [180, 130]] });   // short of the green
  const pond = session('closest', {}, wet);
  const splash = pond.play({ ...WEDGE, speedMph: 82 }, 'PW');
  assert.equal(splash.practice.shot.lie, 'water');
  assert.equal(splash.practice.shot.counted, false);
  assert.equal(splash.practice.shot.note, 'In the water');
  assert.equal(pond.score(), null);
  // another par 3 can be picked
  assert.equal(session('closest', { hole: 2 }).state().holeRef, 3);
});

test('long drive: only drives that finish inside the grid count', () => {
  const s = session('longdrive');
  const straight = s.play(DRIVE, 'DR');
  assert.equal(straight.practice.shot.counted, true);
  const hook = s.play({ ...DRIVE, hla: -12 }, 'DR');
  assert.equal(hook.practice.shot.counted, false);
  assert.match(hook.practice.shot.note, /Out of the grid|Out of bounds/);
  assert.equal(s.score().shot, 1);
  assert.equal(s.state().grid.halfWidthYd, 25);
});

test('target challenge: points by distance, a new flag for every ball, ten balls', () => {
  assert.deepEqual([2, 3, 7.9, 12, 24.9, 25.1].map(targetPoints), [10, 10, 5, 3, 1, 0]);
  let r = 0;
  const rolls = [0.5, 0.5, 0.1, 0.9];
  const s = session('targets', { random: () => rolls[r++ % rolls.length] });
  const firstTarget = s.target;
  assert.equal(firstTarget.yd, 130, '60 + 0.5 x (200 - 60)');
  s.play(WEDGE, 'PW');
  assert.notDeepEqual(s.target, firstTarget, 'a new flag after the ball');
  for (let i = 1; i < 10; i++) s.play(WEDGE, 'PW');
  assert.equal(s.over, true);
  assert.equal(s.score().points, s.shots.reduce((sum, x) => sum + x.points, 0));
  assert.equal(s.score().max, 100);
});

test('the game routes shots to practice and leaves the round exactly as it was', () => {
  const g = new Game();
  g.setCourse(course());
  g.strokes = 2;
  g.ball = { x: 81, y: 100 };
  g.setAimOffset(3);
  g.startPractice('range');
  let s = g.state();
  assert.equal(s.practice.mode, 'range');
  assert.deepEqual(s.ball, { x: s.practice.spot[0], y: s.practice.spot[1] });
  g.setAimOffset(-5);
  assert.equal(g.state().aimOffset, -5, 'aim moves the practice line');
  const result = g.handleShot({ Speed: 150, VLA: 12, TotalSpin: 2600 }, 'DRIVER');
  assert.ok(result.practice);
  g.nextHole();   // ignored while practising
  assert.equal(g.holeIndex, 0);
  g.endPractice();
  s = g.state();
  assert.equal(s.practice, undefined);
  assert.equal(s.strokes, 2);
  assert.deepEqual(s.ball, { x: 81, y: 100 });
  assert.equal(s.aimOffset, 3);
  // a new course ends any session
  g.startPractice('targets');
  g.setCourse(course());
  assert.equal(g.practice, null);
  assert.throws(() => g.startPractice('bowling'), /Unknown practice mode/);
});
