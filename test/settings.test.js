'use strict';
// Round settings (lib/settings.js): the gimme distance the player picks, kept across
// restarts, and how the round concedes a short putt with it (lib/game.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Game } = require('../lib/game');
const S = require('../lib/settings');

const quiet = { warn() {} };

test('defaults: an 8 ft gimme in yards, whatever the patch is not', () => {
  assert.deepEqual(S.normalizeSettings(null), { gimmeFt: 8, units: 'yd' });
  assert.deepEqual(S.normalizeSettings([]), { gimmeFt: 8, units: 'yd' });
  assert.deepEqual(new Game().settings, { gimmeFt: 8, units: 'yd' });
});

test('the gimme: clamped to 0..10 ft, to the half foot, from a number or a numeric string', () => {
  assert.equal(S.normalizeSettings({ gimmeFt: 3 }).gimmeFt, 3);
  assert.equal(S.normalizeSettings({ gimmeFt: '5' }).gimmeFt, 5);
  assert.equal(S.normalizeSettings({ gimmeFt: 2.3 }).gimmeFt, 2.5);
  assert.equal(S.normalizeSettings({ gimmeFt: -4 }).gimmeFt, 0);
  assert.equal(S.normalizeSettings({ gimmeFt: 40 }).gimmeFt, S.GIMME_MAX_FT);
  // the old key held feet too
  assert.equal(S.normalizeSettings({ gimmeYd: 2 }).gimmeFt, 2);
  // a patch keeps what it doesn't name
  assert.deepEqual(S.normalizeSettings({}, { gimmeFt: 3, units: 'yd' }), { gimmeFt: 3, units: 'yd' });
  assert.equal('gimmeYd' in S.normalizeSettings({ gimmeYd: 2 }, { gimmeYd: 5, units: 'yd' }), false);
});

test('a value it cannot use is refused with BAD_SETTING', () => {
  for (const patch of [{ gimmeFt: 'close' }, { gimmeFt: null }, { gimmeFt: '' }, { gimmeFt: Infinity }, { units: 'm' }]) {
    assert.throws(() => S.normalizeSettings(patch), (e) => e.code === 'BAD_SETTING', JSON.stringify(patch));
  }
});

test('settings.json: saved and read back; a missing or broken file is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    assert.equal(S.loadSettingsFile(file, quiet), null);
    S.saveSettingsFile(file, { gimmeFt: 3, units: 'yd' });
    assert.deepEqual(S.loadSettingsFile(file, quiet), { gimmeFt: 3, units: 'yd' });
    fs.writeFileSync(file, '{ not json');
    assert.equal(S.loadSettingsFile(file, quiet), null);
    fs.writeFileSync(file, JSON.stringify({ settings: { gimmeFt: 'far' } }));
    assert.equal(S.loadSettingsFile(file, quiet), null);
    // a file written before the rename
    fs.writeFileSync(file, JSON.stringify({ gimmeYd: 5, units: 'yd' }));
    assert.deepEqual(S.loadSettingsFile(file, quiet), { gimmeFt: 5, units: 'yd' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A green the size of the hole, the ball 2 m (6.6 ft) short of the cup, and a putt so
// soft it barely moves: whether it is conceded is the gimme setting's call.
function puttFromSixFeet(gimmeFt) {
  const g = new Game();
  g.setCourse({
    name: 'Gimme Green', boundary: null, elevation: null,
    surfaces: [{ kind: 'green', poly: [[-60, -20], [60, -20], [60, 160], [-60, 160]] }],
    holes: [{ par: 4, tee: [0, 0], pin: [0, 100], lengthYd: 110, line: [[0, 0], [0, 100]] }],
  });
  g.settings = S.normalizeSettings({ gimmeFt }, g.settings);
  g.ball = { x: 0, y: 98 };
  g.lie = 'green';
  const r = g.handleShot({ Speed: 0.2, VLA: 0, HLA: 0, TotalSpin: 0 });
  return { g, r };
}

test('the gimme setting decides whether a short putt is conceded', () => {
  const eight = puttFromSixFeet(8);
  assert.equal(eight.g.holed, true);
  assert.equal(eight.g.strokes, 2, 'the putt and the conceded tap-in');
  assert.match(eight.r.note, /Gimme inside 8 ft/);

  const three = puttFromSixFeet(3);
  assert.equal(three.g.holed, false);
  assert.equal(three.g.strokes, 1);

  const off = puttFromSixFeet(0);
  assert.equal(off.g.holed, false, 'gimme off: every putt is holed out');
});
