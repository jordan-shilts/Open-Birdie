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
