'use strict';
// Mulligans: taking the hole's latest shot back (lib/game.js mulligan).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../lib/game');

// Minimal playable course: empty surfaces, flat terrain, the pin 100 m north of the tee.
function course(holeCount, par = 4) {
  return {
    name: 'Test Course',
    surfaces: [{ kind: 'range', poly: [[-30, 0], [30, 0], [30, 300], [-30, 300]] }],
    boundary: null,
    elevation: null,
    holes: Array.from({ length: holeCount }, () => ({
      par, tee: [0, 0], pin: [0, 100], lengthYd: 400, line: [[0, 0], [0, 100]],
    })),
  };
}
const iron = { Speed: 110, VLA: 18, HLA: 0, TotalSpin: 6500, SpinAxis: 0 };
const wedge = { Speed: 70, VLA: 30, HLA: 2, TotalSpin: 9000, SpinAxis: 0 };

test('a mulligan puts the ball, strokes, lie and aim back and counts on the card', () => {
  const g = new Game();
  g.setCourse(course(2));
  g.setAimOffset(3);
  const tee = { ...g.ball };
  assert.equal(g.state().canMulligan, false);           // nothing hit yet
  const r = g.handleShot(iron);
  assert.ok(r && g.strokes === 1 && g.ball.y > 50);
  assert.equal(g.state().canMulligan, true);
  g.setAimOffset(-5);                                   // re-aimed for the next one
  assert.equal(g.mulligan(), true);
  assert.deepEqual(g.ball, tee);
  assert.equal(g.strokes, 0);
  assert.equal(g.lie, 'tee');
  assert.equal(g.aimOffset, 3);
  assert.deepEqual(g.state().mulligans, [1, 0]);
  assert.equal(g.state().canMulligan, false);
  assert.equal(g.mulligan(), false);                    // one shot back, not two
  assert.deepEqual(g.shotLog, []);
});

test('only the latest shot comes back', () => {
  const g = new Game();
  g.setCourse(course(1));
  g.handleShot(iron);
  const after1 = { ball: { ...g.ball }, lie: g.lie, strokes: g.strokes };
  g.handleShot(wedge);
  assert.equal(g.strokes, 2);
  assert.equal(g.mulligan(), true);
  assert.deepEqual({ ball: g.ball, lie: g.lie, strokes: g.strokes }, after1);
  assert.equal(g.shotLog.length, 1);
  // the hole's count goes up with every mulligan
  g.handleShot(wedge);
  assert.equal(g.mulligan(), true);
  assert.deepEqual(g.state().mulligans, [2]);
});

test('a holed final hole can be taken back: score, holed and round-over undone', () => {
  const g = new Game();
  g.setCourse(course(1));
  g.handleShot(iron);
  // as if that ball had dropped: holed, scored, the round over
  g.holed = true;
  g._scoreHole(g.strokes, false);
  assert.equal(g.over, true);
  assert.equal(g.mulligan(), true);
  assert.equal(g.over, false);
  assert.equal(g.holed, false);
  assert.deepEqual(g.scores, [null]);
  assert.deepEqual(g.pickedUp, [false]);
  assert.equal(g.strokes, 0);
});

test('no mulligan after moving on, in practice, or after a reset or a new course', () => {
  const g = new Game();
  g.setCourse(course(2));
  g.handleShot(iron);
  g.nextHole();                                          // picked up hole 1
  assert.equal(g.state().hole, 2);
  assert.equal(g.mulligan(), false);
  assert.equal(g.scores[0], 2);

  g.handleShot(iron);
  g.startPractice('range');
  assert.equal(g.state().canMulligan, false);
  assert.equal(g.mulligan(), false);                     // practice never touches the round
  g.handleShot(iron);                                    // a range ball
  assert.equal(g.mulligan(), false);
  g.endPractice();
  assert.equal(g.state().canMulligan, true);             // the round's last shot is still there
  assert.equal(g.mulligan(), true);

  g.handleShot(iron);
  g.reset();
  assert.equal(g.mulligan(), false);
  assert.deepEqual(g.state().mulligans, [0, 0]);

  g.handleShot(iron);
  g.setCourse(course(3));
  assert.equal(g.mulligan(), false);
  assert.deepEqual(g.state().mulligans, [0, 0, 0]);
});

test('no mulligans in a league round: its card is a competition\'s', () => {
  const g = new Game();
  g.setCourse(course(2));
  g.leagueRound = { leagueId: 'l1', leagueName: 'Tuesday', week: 1, playerId: 'p1', playerName: 'Ana' };
  assert.ok(g.handleShot(iron));
  assert.equal(g.state().canMulligan, false);
  assert.equal(g.mulligan(), false);
  assert.equal(g.strokes, 1);
  g.leagueRound = null;                                 // left the league round: back to a casual one
  assert.equal(g.state().canMulligan, true);
});
