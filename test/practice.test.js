'use strict';
// Driving range and mini games (lib/practice.js) on a flat test course, and how a
// session sits beside the round in the Game: it borrows the course, never the round.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../lib/game');
const { MPH, YD, simulateShot } = require('../lib/physics');
const { physicsOptions } = require('../lib/conditions');
const { PracticeSession, chipPoints, longAxis, practiceGround, targetPoints } = require('../lib/practice');

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

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const circle = (cx, cy, r, n = 48) => Array.from({ length: n }, (_, k) => [cx + r * Math.cos(2 * Math.PI * k / n), cy + r * Math.sin(2 * Math.PI * k / n)]);
// The same links with greens: hole 1's a 15 m circle round the pin, a pond eating into
// its west side, a bunker into its east side, the fairway coming in from the south and
// the course boundary 1 m short of the pin (out of bounds 15 m past it: right behind
// the green); hole 2's green a 4 m circle; hole 3 has none mapped.
function greenCourse() {
  const c = course();
  const [px, py] = c.holes[0].pin;
  c.surfaces.push(
    { kind: 'green', poly: circle(px, py, 15) },
    { kind: 'water', poly: rect(px - 40, py - 8, px - 12, py + 8) },
    { kind: 'bunker', poly: rect(px + 14, py - 8, px + 30, py + 8) },
    { kind: 'fairway', poly: rect(px - 10, py - 60, px + 10, py - 5) },
    { kind: 'green', poly: circle(c.holes[1].pin[0], c.holes[1].pin[1], 4) },
  );
  c.boundary = rect(-100, -100, 400, py - 1);
  return c;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const headingOf = (p, cup) => Math.round(((Math.atan2(p.x - cup.x, p.y - cup.y) * 180 / Math.PI) + 360) % 360);
// A putt struck straight at the cup to finish `pastM` beyond it on a flat 10.5 green.
const puttFor = (s, pastM = 0.45) => ({ speedMph: Math.sqrt(2 * 0.6 * (dist({ x: s.spot[0], y: s.spot[1] }, s.target) + pastM)) / MPH, vla: 0.5, hla: 0, totalSpin: 0, spinAxis: 0 });
// A wedge struck to finish `yd` down the line at the session's target (bisection on speed).
function wedgeTo(s, yd) {
  const from = { x: s.spot[0], y: s.spot[1] };
  let lo = 10, hi = 170;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const sim = simulateShot({ ...WEDGE, speedMph: mid }, from, s.aimDeg, s.ctx.surfaceAt, { terrain: s.ctx.terrain, ...physicsOptions(undefined, { gust: true }) });
    if (sim.totalYd < yd) lo = mid; else hi = mid;
  }
  return { ...WEDGE, speedMph: (lo + hi) / 2 };
}

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

test('putting challenge: nine putts on the green, 3 to 40 ft, each from its own side of the cup', () => {
  const s = session('putting', { random: () => 0.25 }, greenCourse());
  const st = s.state();
  assert.equal(st.holeRef, 1, 'no hole asked for: hole 1');
  assert.equal(st.lie, 'green');
  assert.deepEqual(st.flags, [], 'no yardage flags on a green');
  assert.deepEqual(s.cup, { x: s.target.x, y: s.target.y }, 'a real cup the ball can drop into');
  const cup = s.target;
  assert.deepEqual(s.spots.map((p) => Math.round(dist(p, cup) / YD * 3)), [3, 5, 8, 12, 16, 20, 25, 30, 40]);
  assert.equal(new Set(s.spots.map((p) => headingOf(p, cup))).size, 9, 'nine sides of the cup');
  for (const p of s.spots) {   // the green all the way to the cup, round the pond and the bunker
    for (let f = 0; f <= 1; f += 0.05) assert.equal(s.ctx.surfaceAt(cup.x + (p.x - cup.x) * f, cup.y + (p.y - cup.y) * f), 'green');
  }
  assert.deepEqual(st.spot, [s.spots[0].x, s.spots[0].y], 'the first ball at the first spot');
  // a green too small for the long putts: they come in, still on the green and apart
  const small = session('putting', { hole: 1 }, greenCourse());
  assert.equal(small.state().holeRef, 2);
  const lens = small.spots.map((p) => dist(p, small.target) / YD * 3);
  assert.deepEqual(lens.slice(0, 3).map(Math.round), [3, 5, 8]);
  assert.ok(Math.max(...lens) < 4 / YD * 3, 'inside the 4 m green');
  assert.ok(small.spots.every((p) => small.ctx.surfaceAt(p.x, p.y) === 'green'));
  assert.equal(new Set(small.spots.map((p) => headingOf(p, small.target))).size, 9);
  // a hole without a mapped green: hole 1's; a course without any: no game
  assert.equal(session('putting', { hole: 2 }, greenCourse()).state().holeRef, 1);
  assert.throws(() => session('putting'), /No green/);
});

test('putting challenge: holed putts count, feet left break the tie, a new spot every ball, nine and done', () => {
  const s = session('putting', { random: () => 0.6 }, greenCourse());
  s.setAim(20);
  const pushed = s.play(puttFor(s), 'PUTTER');   // 20 deg right of a 3 footer: by the hole
  assert.equal(pushed.sim.isPutt, true);
  assert.equal(pushed.practice.shot.holed, false);
  assert.ok(pushed.practice.shot.leftFt > 0);
  assert.equal(s.aimOffset, 0, 'a new ball, a new read: the aim is straight at the cup again');
  assert.deepEqual(s.spot, [s.spots[1].x, s.spots[1].y], 'the second ball waits at the second spot');
  const made = s.play(puttFor(s), 'PUTTER');
  assert.equal(made.practice.shot.holed, true);
  assert.equal(made.practice.shot.note, 'Holed from 5 ft');
  assert.equal(made.practice.shot.leftFt, 0);
  const short = s.play(puttFor(s, -1.2), 'PUTTER');   // 8 ft putt dies 4 ft short
  assert.equal(short.practice.shot.holed, false);
  assert.match(short.practice.shot.note, /^3\.\d ft short$/);
  while (!s.over) s.play(puttFor(s), 'PUTTER');
  assert.equal(s.ballsHit, 9);
  assert.equal(s.play(puttFor(s)), null, 'no tenth putt');
  const score = s.score();
  assert.equal(score.made, s.shots.filter((x) => x.holed).length);
  assert.equal(score.made, 7, 'every putt struck at the cup with pace drops');
  assert.equal(score.value, '7 / 9');
  assert.equal(score.feetLeft, Math.round((s.shots[0].leftFt + s.shots[2].leftFt) * 10) / 10);
  assert.deepEqual(s.shots.map((x) => x.puttFt).map(Math.round), [3, 5, 8, 12, 16, 20, 25, 30, 40]);
});

test('up and down: six chips 8-30 yd out, just off the green, never from sand, water or out of bounds', () => {
  assert.deepEqual([0, 2.9, 3, 3.1, 6, 9.9, 10, 20, 20.1].map((ft) => chipPoints(ft)), [5, 5, 5, 3, 3, 2, 2, 1, 0]);
  assert.equal(chipPoints(40, true), 10, 'a chip-in');
  // the first chip asks for the bunker's side (east), the second the pond's (west),
  // the fourth the side out of bounds behind the green (north-west)
  const s = session('chipping', { random: () => 0.25 }, greenCourse());
  const cup = s.target;
  assert.equal(s.spots.length, 6);
  for (const p of s.spots) {
    const lie = s.ctx.surfaceAt(p.x, p.y);
    assert.ok(lie === 'fairway' || lie === 'rough', `chip from ${lie}`);
    assert.equal(p.lie, lie);
    assert.ok(dist(p, cup) / YD >= 8 && dist(p, cup) / YD <= 30, `${dist(p, cup) / YD} yd out`);
    // just off the green: 1-9 m back toward the cup it is green
    const back = 9.5 / dist(p, cup);
    assert.equal(s.ctx.surfaceAt(p.x + (cup.x - p.x) * back, p.y + (cup.y - p.y) * back), 'green');
  }
  assert.equal(new Set(s.spots.map((p) => headingOf(p, cup))).size, 6, 'all round the green');
  assert.ok(Math.abs(headingOf(s.spots[0], cup) - 90) >= 20, 'beside the bunker, not over it');
  assert.ok(Math.abs(headingOf(s.spots[1], cup) - 270) >= 20, 'beside the pond, not over it');
  assert.equal(s.state().lie, s.spots[0].lie);
  assert.equal(s.state().holeRef, 1);
  // the approach: asked for straight up the fairway (heading 180), a chip from it
  assert.equal(session('chipping', { random: () => 0.5 }, greenCourse()).spots[0].lie, 'fairway');
});

test('up and down: each chip scores where it finishes, six and done', () => {
  const s = session('chipping', { random: () => 0.5 }, greenCourse());
  const totals = [];
  while (!s.over) {
    const from = [...s.spot];
    const r = s.play({ speedMph: 30, vla: 30, hla: 0, totalSpin: 6000, spinAxis: 0 }, 'SW');
    const ft = Math.round(dist(r.end, s.target) / YD * 3 * 10) / 10;   // scored as shown, to the tenth
    assert.deepEqual(r.from, { x: from[0], y: from[1] });
    assert.equal(r.practice.shot.leftFt, ft);
    assert.equal(r.practice.shot.points, r.practice.shot.counted ? chipPoints(ft, r.practice.shot.holed) : 0);
    if (!r.practice.shot.holed) assert.ok(r.practice.shot.note.startsWith(`${ft < 20 ? ft : Math.round(ft)} ft from the cup: `), r.practice.shot.note);
    totals.push(r.practice.score.points);
  }
  assert.equal(s.ballsHit, 6);
  assert.equal(s.score().points, s.shots.reduce((sum, x) => sum + x.points, 0));
  assert.equal(s.score().max, 60);
  assert.equal(s.play(WEDGE), null);
  assert.deepEqual(totals, [...totals].sort((a, b) => a - b), 'points only add up');
});

test('distance ladder: rungs 50 to 175 yd, within 7 yd climbs, all six end it early', () => {
  const s = session('ladder');
  assert.deepEqual(s.flags.map((f) => f.yd), [50, 75, 100, 125, 150, 175]);
  assert.equal(s.target.yd, 50);
  assert.equal(s.cup, null, 'a yardage flag is no hole');
  s.setTarget(150);
  assert.equal(s.target.yd, 50, 'the ladder picks the flag, not the player');
  const long = s.play(DRIVE, 'DR');
  assert.equal(long.practice.shot.climbed, false);
  assert.match(long.practice.shot.note, /^\d+ yd from the 50 yd flag: get inside 7 yd to climb$/);
  assert.equal(s.target.yd, 50, 'still on the first rung');
  for (const yd of [50, 75, 100, 125, 150, 175]) {
    assert.equal(s.target.yd, yd);
    const r = s.play(wedgeTo(s, dist({ x: s.spot[0], y: s.spot[1] }, s.target) / YD), 'PW');
    assert.ok(r.practice.shot.toTargetYd <= 7);
    assert.equal(r.practice.shot.climbed, true);
    if (yd < 175) assert.match(r.practice.shot.note, new RegExp(`from the ${yd} yd flag: next rung ${yd + 25} yd$`));
  }
  assert.match(s.shots[s.shots.length - 1].note, /175 yd flag: ladder cleared!$/);
  assert.equal(s.over, true, 'all six rungs: over before the twelfth ball');
  assert.equal(s.ballsHit, 7);
  assert.deepEqual(s.score(), { label: 'Rungs cleared', value: '6 / 6', cleared: 6 });
  assert.equal(s.play(WEDGE), null);
  // twelve balls that never climb end it too
  const t = session('ladder');
  for (let i = 0; i < 12; i++) t.play(DRIVE, 'DR');
  assert.equal(t.over, true);
  assert.equal(t.score().cleared, 0);
});

test('the green games play on the round\'s hole, with no tee and the real lie', () => {
  const g = new Game();
  g.setCourse(greenCourse());
  g.nextHole();   // the round moves on to hole 2
  g.startPractice('putting');
  let s = g.state();
  assert.equal(s.practice.holeRef, 2);
  assert.equal(s.practice.holeIndex, 1);
  assert.equal(s.tee, null, 'no tee markers on a green');
  assert.equal(s.lie, 'green');
  assert.deepEqual(s.ball, { x: s.practice.spot[0], y: s.practice.spot[1] });
  assert.deepEqual(s.pin, [g.course.holes[1].pin[0], g.course.holes[1].pin[1]]);
  const first = s.ball;
  g.handleShot({ Speed: 1, VLA: 0.5, TotalSpin: 0 }, 'PUTTER');
  s = g.state();
  assert.notDeepEqual(s.ball, first, 'the state moves to the next ball\'s spot');
  assert.equal(s.practice.ballsHit, 1);
  // chipping too; a hole picked on the board wins over the round's
  g.startPractice('chipping', { hole: 0 });
  s = g.state();
  assert.equal(s.practice.holeRef, 1);
  assert.ok(s.lie === 'fairway' || s.lie === 'rough');
  g.startPractice('ladder');
  assert.deepEqual(g.state().tee, g.state().practice.spot, 'the range games tee off');
  assert.equal(g.state().practice.flags.length, 6);
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
