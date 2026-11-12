'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toOpenConnectClub } = require('../lib/openconnect');

test('UI labels become GSPro Open Connect codes', () => {
  assert.equal(toOpenConnectClub('5i'), 'I5');
  assert.equal(toOpenConnectClub('5I'), 'I5');
  assert.equal(toOpenConnectClub('3W'), 'W3');
  assert.equal(toOpenConnectClub('3h'), 'H3');
});

test('codes that are already Open Connect pass through', () => {
  for (const c of ['DR', 'I7', 'W5', 'H4', 'PW', 'GW', 'SW', 'LW', 'PT']) assert.equal(toOpenConnectClub(c), c);
});

test('missing club defaults to driver', () => {
  assert.equal(toOpenConnectClub(undefined), 'DR');
  assert.equal(toOpenConnectClub(''), 'DR');
});

// ---- the club a launch monitor names on a shot ----
// OpenFlight puts the club each shot was hit with in ClubName, as the same Open Connect
// code this server sends it in Player.Club (its src/openflight/gspro/state.py club map),
// and only to a simulator that names itself Open-Birdie. A club changed on the launch
// monitor's own screen is then the club the shot is filed under here.
const { clubKey, shotClubKey, CLUB_FULL, Game } = require('../lib/game');
const { Bag } = require('../lib/bag');

const OPENFLIGHT_CLUB_CODES = [
  'DR', 'W3', 'W5', 'W7', 'H3', 'H5', 'H7', 'H9', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9',
  'PW', 'GW', 'SW', 'LW', 'PT',
];

test('every club code OpenFlight can name a shot with is a club in the bag', () => {
  for (const code of OPENFLIGHT_CLUB_CODES) {
    assert.ok(CLUB_FULL[clubKey(code)], `${code} -> ${clubKey(code)}`);
  }
});

test('a code this bag has a club for keeps that club; the rest go to the nearest', () => {
  for (const code of OPENFLIGHT_CLUB_CODES.filter((c) => CLUB_FULL[c])) assert.equal(clubKey(code), code);
  assert.equal(clubKey('W5'), 'H3');
  assert.equal(clubKey('GW'), 'PW');
  assert.equal(clubKey('H7'), 'I7');
});

test("the monitor's club wins over the club picked in the game", () => {
  assert.equal(shotClubKey('I7', 'DR'), 'I7');
  assert.equal(shotClubKey(null, 'DR'), 'DR', 'no club named: the pick stands');
  assert.equal(shotClubKey('', 'DR'), 'DR');
});

test('a shot that names its club is played and filed under it', () => {
  const game = new Game();
  game.setCourse({
    name: 'Test Course', surfaces: [], boundary: null, elevation: null,
    holes: [{ par: 4, tee: [0, 0], pin: [0, 300], lengthYd: 330, line: [[0, 0], [0, 300]] }],
  });
  game.setSelectedClub('DR');
  const ball = { Speed: 118, VLA: 17.5, HLA: 0, TotalSpin: 6800, SpinAxis: 0 };
  assert.equal(game.handleShot(ball, 'I7').clubKey, 'I7');

  const bag = new Bag();   // no store: nothing is written
  const filed = bag.recordShot({ ball, clubName: 'I7', selectedClub: 'DR' });
  assert.equal(filed.recorded, true);
  assert.equal(filed.club, 'I7');
  assert.equal(bag.shots('I7').length, 1);
  assert.equal(bag.shots('DR').length, 0, 'nothing filed under the club picked in the game');
});
