'use strict';
// tools/bench-shot.js: the server-side shot benchmark runs anywhere, on its own course.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, syntheticCourse, SHOTS } = require('../tools/bench-shot');
const { Game } = require('../lib/game');

test('the synthetic course is a course a round can be played on', () => {
  const course = syntheticCourse();
  assert.equal(course.holes.length, 18);
  assert.ok(course.surfaces.length > 150, 'about as many polygons as a mapped course');
  const game = new Game();
  game.setCourse(course);
  const result = game.handleShot(SHOTS.driver, null);
  assert.ok(result, 'the drive is played');
  assert.ok(result.sim.carryYd > 200 && result.sim.carryYd < 300, `a drive's carry, got ${result.sim.carryYd}`);
  assert.equal(game.state().strokes, 1);
});

test('the synthetic course is the same every time, so runs can be compared', () => {
  assert.deepEqual(syntheticCourse(), syntheticCourse());
});

test('the report times every kind of shot and the lineup, and says what it ran on', () => {
  const report = run({ synthetic: true, runs: 2 });
  const names = Object.keys(report.stages);
  for (const club of Object.keys(SHOTS)) assert.ok(names.includes(`shot: ${club} from the tee`), club);
  for (const name of ['shot: 20 ft putt', 'lineup: predict one club', 'lineup: carries for the bag']) {
    assert.ok(names.includes(name), name);
  }
  for (const [name, t] of Object.entries(report.stages)) {
    assert.ok(Number.isFinite(t.medianMs) && t.medianMs > 0, `${name} took time`);
    assert.ok(t.medianMs <= t.p95Ms && t.p95Ms <= t.maxMs, `${name}: median <= p95 <= worst`);
  }
  assert.equal(report.course.source, 'synthetic course');
  assert.equal(report.course.holes, 18);
  assert.ok(report.surfaceLookupUs > 0);
  assert.ok(report.shotEventKb > 1, "the driver's shot event was measured");
  assert.ok(report.machine.cpu && report.machine.node);
});

test('the putt it times starts on the green and rolls', () => {
  // the timed putt is taken ~6 m short of the pin on the tee's side: that spot must
  // be green on the synthetic course, or the "putt" would be timing a chip
  const game = new Game();
  game.setCourse(syntheticCourse());
  const { tee, pin } = game.hole;
  const d = Math.hypot(pin[0] - tee[0], pin[1] - tee[1]);
  const spot = [pin[0] - (pin[0] - tee[0]) / d * 6, pin[1] - (pin[1] - tee[1]) / d * 6];
  assert.equal(game.surfaceAt(spot[0], spot[1]), 'green');
  game.ball = { x: spot[0], y: spot[1] };
  game.lie = 'green';
  const result = game.handleShot({ Speed: 6.5, VLA: 0, HLA: 2, TotalSpin: 0, SpinAxis: 0 }, 'PT');
  assert.equal(result.sim.isPutt, true);
  assert.ok(result.sim.totalYd > 3, `the putt rolled, got ${result.sim.totalYd} yd`);
});
