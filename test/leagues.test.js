'use strict';
// Players and leagues (lib/leagues.js): the roster, a league's weeks, one card per
// player per week, weekly points by place (ties share), season standings, and the
// leagues.json file they live in.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLeagues, courseHandicap, initials, cleanHandicap, weekBoard, standings, WEEK_POINTS } = require('../lib/leagues');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-leagues-'));
const quiet = { warn: () => {} };
const course = { cached: 'osm-relation-1.json', name: 'Hazeltine National Golf Club', courseId: 'osm:relation:1' };
// a 9-hole card: par 36, the given total spread over the holes
const card = (gross) => {
  const pars = [4, 4, 3, 5, 4, 4, 3, 5, 4];
  const scores = pars.slice();
  scores[0] += gross - 36;
  return { course: course.name, pars, scores, pickedUp: pars.map(() => false) };
};

function threePlayerLeague(scoring = 'net') {
  const lg = createLeagues({ dataDir: tmpDir(), log: quiet });
  const a = lg.addPlayer({ name: 'Ana', handicap: 0 });
  const b = lg.addPlayer({ name: 'Ben', handicap: 10 });
  const c = lg.addPlayer({ name: 'Cy', handicap: 20 });
  const league = lg.createLeague({ name: 'Tuesday', scoring, playerIds: [a.id, b.id, c.id], weeks: [{ course }, { course }] });
  return { lg, a, b, c, league };
}

test('roster: names are tidied and unique, handicaps clamped, the first player is active', () => {
  const lg = createLeagues({ dataDir: tmpDir(), log: quiet });
  const p = lg.addPlayer({ name: '  Jordan   Shilts ', handicap: '12.44' });
  assert.equal(p.name, 'Jordan Shilts');
  assert.equal(p.handicap, 12.4);
  assert.equal(lg.state().activePlayerId, p.id);
  assert.equal(lg.state().players[0].initials, 'JS');
  assert.throws(() => lg.addPlayer({ name: 'jordan shilts' }), /already on the roster/);
  assert.throws(() => lg.addPlayer({ name: '   ' }), /needs a name/);
  assert.equal(lg.addPlayer({ name: 'Pro', handicap: '+2' }).handicap, -2);
  assert.equal(cleanHandicap(99), 54);
  assert.equal(cleanHandicap('abc'), 0);
  assert.equal(initials('Ana'), 'AN');
});

test('course handicap scales the index to the round: half the strokes over nine holes', () => {
  assert.equal(courseHandicap(12.4, 18), 12);
  assert.equal(courseHandicap(12.4, 9), 6);
  assert.equal(courseHandicap(-2, 18), -2);
  assert.equal(courseHandicap(undefined, 18), 0);
});

test('a league needs a name, a player and a week with a course', () => {
  const lg = createLeagues({ dataDir: tmpDir(), log: quiet });
  const p = lg.addPlayer({ name: 'Ana' });
  assert.throws(() => lg.createLeague({ name: '', playerIds: [p.id], weeks: [{ course }] }), /needs a name/);
  assert.throws(() => lg.createLeague({ name: 'L', playerIds: ['nobody'], weeks: [{ course }] }), /at least one player/);
  assert.throws(() => lg.createLeague({ name: 'L', playerIds: [p.id], weeks: [{ course: { name: 'x' } }] }), /at least one week/);
  const l = lg.createLeague({ name: 'L', scoring: 'bogus', playerIds: [p.id, p.id], weeks: [{ course }, { course }] });
  assert.equal(l.scoring, 'net');
  assert.deepEqual(l.playerIds, [p.id]);
  assert.deepEqual(l.weeks.map((w) => w.n), [1, 2]);
  assert.equal(l.currentWeek, 1);
});

test('the first card a player finishes for a week counts; a second is refused', () => {
  const { lg, a, league } = threePlayerLeague();
  const first = lg.postRound(league.id, 1, a.id, card(40));
  assert.equal(first.posted, true);
  assert.equal(first.round.gross, 40);
  assert.equal(first.round.toPar, 4);
  assert.equal(first.rank, 1);
  assert.deepEqual(lg.postRound(league.id, 1, a.id, card(35)), { posted: false, reason: 'already' });
  assert.throws(() => lg.weekToPlay(league.id, 1, a.id), /already has a card for week 1/);
  assert.equal(lg.weekToPlay(league.id, 2, a.id).week.n, 2);
  assert.throws(() => lg.weekToPlay(league.id, 3, a.id), /No such week/);
});

test('net scoring takes the handicap over the holes played; gross ignores it', () => {
  const { lg, a, b, c, league } = threePlayerLeague('net');
  lg.postRound(league.id, 1, a.id, card(38));   // net 38 (+2)
  lg.postRound(league.id, 1, b.id, card(42));   // 10 index -> 5 over nine: net 37 (+1)
  lg.postRound(league.id, 1, c.id, card(47));   // 20 index -> 10 over nine: net 37 (+1)
  const net = lg.state().leagues[0].weekBoards[1];
  assert.deepEqual(net.map((r) => [r.playerName, r.netToPar, r.rank, r.points]), [
    ['Ben', 1, 1, (WEEK_POINTS[0] + WEEK_POINTS[1]) / 2],   // tied first: they share 10 + 8
    ['Cy', 1, 1, (WEEK_POINTS[0] + WEEK_POINTS[1]) / 2],
    ['Ana', 2, 3, WEEK_POINTS[2]],
  ]);
  assert.ok(net[0].tied && !net[2].tied);
  const gross = weekBoard({ ...lg.state().leagues[0], scoring: 'gross' }, 1);
  assert.deepEqual(gross.map((r) => r.playerName), ['Ana', 'Ben', 'Cy']);
});

test('season standings add up the weeks: points, rounds, average, best and wins', () => {
  const { lg, a, b, c, league } = threePlayerLeague('gross');
  lg.postRound(league.id, 1, a.id, card(36));
  lg.postRound(league.id, 1, b.id, card(40));
  lg.postRound(league.id, 2, b.id, card(35));
  lg.postRound(league.id, 2, a.id, card(39));
  const rows = lg.state().leagues[0].standings;
  assert.deepEqual(rows.map((r) => [r.name, r.points, r.rounds, r.avg, r.best, r.wins, r.rank]), [
    ['Ana', 18, 2, 1.5, 0, 1, 1],
    ['Ben', 18, 2, 1.5, -1, 1, 1],
    ['Cy', 0, 0, null, null, 0, 3],   // in the league, no cards yet
  ]);
  assert.equal(standings({ ...lg.state().leagues[0], rounds: [] }, lg.state().players).every((r) => r.points === 0), true);
  assert.equal(c.name, 'Cy');
});

test('members with cards stay in the league and on the roster', () => {
  const { lg, a, b, league } = threePlayerLeague();
  lg.postRound(league.id, 1, a.id, card(40));
  assert.throws(() => lg.updateLeague(league.id, { playerIds: [b.id] }), /Ana has cards in this league/);
  assert.throws(() => lg.removePlayer(a.id), /Plays in Tuesday/);
  const l = lg.updateLeague(league.id, { name: 'Tuesday Night', addWeek: { course }, currentWeek: 3 });
  assert.equal(l.name, 'Tuesday Night');
  assert.equal(l.weeks.length, 3);
  assert.equal(l.currentWeek, 3);
  assert.throws(() => lg.updateLeague(league.id, { currentWeek: 9 }), /No such week/);
  lg.removeLeague(league.id);
  assert.equal(lg.removePlayer(a.id), true);
  assert.equal(lg.state().leagues.length, 0);
});

test('leagues.json keeps everything across restarts; a broken file is set aside', () => {
  const dir = tmpDir();
  const lg = createLeagues({ dataDir: dir, log: quiet });
  const a = lg.addPlayer({ name: 'Ana', handicap: 5 });
  const l = lg.createLeague({ name: 'Club', playerIds: [a.id], weeks: [{ course }] });
  lg.postRound(l.id, 1, a.id, card(37));
  const again = createLeagues({ dataDir: dir, log: quiet });
  assert.equal(again.state().players[0].name, 'Ana');
  assert.equal(again.state().leagues[0].rounds.length, 1);
  assert.equal(again.activePlayer.id, a.id);

  fs.writeFileSync(path.join(dir, 'leagues.json'), '{ not json');
  const broken = createLeagues({ dataDir: dir, log: quiet });
  assert.deepEqual(broken.state().players, []);
  assert.ok(fs.existsSync(path.join(dir, 'leagues.json.corrupt')));
});

test('standings carry each player\'s movement since last week and their form week by week', () => {
  const { lg, a, b, c, league } = threePlayerLeague('gross');
  lg.postRound(league.id, 1, a.id, card(36));   // week 1: Ana 1st, Ben 2nd
  lg.postRound(league.id, 1, b.id, card(40));
  let rows = lg.state().leagues[0].standings;
  assert.ok(rows.every((r) => r.move === 0), 'no movement after the first week');
  lg.updateLeague(league.id, { currentWeek: 2 });
  lg.postRound(league.id, 2, c.id, card(33));   // week 2: Cy wins and climbs from 3rd
  lg.postRound(league.id, 2, b.id, card(35));
  rows = lg.state().leagues[0].standings;
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.Ben.rank, 1);                  // 8 + 8
  assert.equal(by.Ben.move, 1);                  // was 2nd after week 1
  assert.deepEqual([by.Cy.rank, by.Cy.move], [2, 1]);     // 10 pts, level with Ana: up from 3rd
  assert.deepEqual([by.Ana.rank, by.Ana.move], [2, -1]);  // down from 1st
  assert.deepEqual(by.Ana.form, [{ week: 1, rank: 1, tied: false }, null]);
  assert.deepEqual(by.Cy.form, [null, { week: 2, rank: 1, tied: false }]);
});
