'use strict';
// Saved shots (lib/saved-shots.js): the player's favourites, kept to replay.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSavedShots, packPoints } = require('../lib/saved-shots');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-saved-'));
const quiet = { warn() {} };

function shot(n = 0) {
  return {
    launch: { speedMph: 150.04 + n, vla: 12.345, hla: -1.234, totalSpin: 2650.4, spinAxis: -3.21 },
    sim: {
      points: [{ t: 0, x: 1.2345, y: 2.3456, z: 3.4567 }, { t: 0.02004, x: 1.5, y: 3.6, z: 3.9 }, { t: 0.04, x: 1.8, y: 4.9, z: 4.3 }],
      carryYd: 251.26, totalYd: 270.04, offlineYd: -3.21, apexFt: 88.4, flightTime: 6.123, isPutt: false,
    },
    lie: 'fairway', holed: false, penalty: 0, note: '', strokes: 1,
    from: { x: 1.2345, y: 2.3456 }, clubKey: 'DR',
  };
}
const context = (shotId, at = 1000) => ({
  shotId, at, course: 'Test Course, Somewhere', hole: 3, holeRef: 7, practice: null, club: 'DR',
  pin: [10.123, 200.456], tee: [0, 0], aimDeg: 0.5678,
});

test('a saved shot keeps the launch, the result, where it was hit and a packed flight', () => {
  const dataDir = tmpDir();
  const saved = createSavedShots({ dataDir, log: quiet });
  const summary = saved.add(shot(), context(7), 5000);
  assert.equal(summary.points, undefined);               // summaries leave the flight out
  assert.equal(summary.course, 'Test Course, Somewhere');
  assert.equal(summary.holeRef, 7);
  assert.equal(summary.club, 'DR');
  assert.deepEqual(summary.launch, { speedMph: 150, vla: 12.3, hla: -1.2, totalSpin: 2650, spinAxis: -3.2 });
  assert.equal(summary.result.carryYd, 251.3);
  assert.equal(summary.result.flightTime, 6.12);
  assert.deepEqual(summary.replay, { pin: [10.12, 200.46], tee: [0, 0], from: { x: 1.23, y: 2.35 }, aimDeg: 0.57 });
  const full = saved.get(summary.id);
  assert.deepEqual(full.points[0], [0, 1.23, 2.35, 3.46]);
  assert.deepEqual(full.points[1], [0.02, 1.5, 3.6, 3.9]);
  // it's on disk: a fresh store reads it back
  const again = createSavedShots({ dataDir, log: quiet });
  assert.equal(again.count, 1);
  assert.deepEqual(again.get(summary.id).points, full.points);
});

test('the same live shot saved twice is one saved shot', () => {
  const saved = createSavedShots({ dataDir: tmpDir(), log: quiet });
  const a = saved.add(shot(), context(7, 1000));
  const b = saved.add(shot(), context(7, 1000));
  assert.equal(a.id, b.id);
  assert.equal(saved.count, 1);
  // shot ids restart with the server: same id, another moment, another shot
  saved.add(shot(1), context(7, 2000));
  assert.equal(saved.count, 2);
});

test('the newest are kept, newest first', () => {
  const saved = createSavedShots({ dataDir: tmpDir(), max: 3, log: quiet });
  for (let i = 1; i <= 5; i++) saved.add(shot(i), context(i, i * 1000), i * 1000);
  const list = saved.list();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((s) => s.shotId), [5, 4, 3]);
});

test('remove forgets one saved shot', () => {
  const dataDir = tmpDir();
  const saved = createSavedShots({ dataDir, log: quiet });
  const a = saved.add(shot(1), context(1, 1000));
  saved.add(shot(2), context(2, 2000));
  assert.equal(saved.remove(a.id), true);
  assert.equal(saved.remove(a.id), false);
  assert.equal(saved.get(a.id), null);
  assert.equal(createSavedShots({ dataDir, log: quiet }).count, 1);
});

test('a corrupt file is set aside, not fatal', () => {
  const dataDir = tmpDir();
  const file = path.join(dataDir, 'saved-shots.json');
  fs.writeFileSync(file, 'not json');
  const saved = createSavedShots({ dataDir, log: quiet });
  assert.deepEqual(saved.list(), []);
  assert.ok(fs.existsSync(`${file}.corrupt`));
  assert.ok(saved.add(shot(), context(1)));
  assert.equal(createSavedShots({ dataDir, log: quiet }).count, 1);
});

test('a shot with no flight is not saved', () => {
  const dataDir = tmpDir();
  const saved = createSavedShots({ dataDir, log: quiet });
  const flat = shot();
  flat.sim.points = [{ t: 0, x: 0, y: 0, z: 0 }];
  assert.equal(saved.add(flat, context(1)), null);
  assert.equal(saved.add(null, context(2)), null);
  assert.equal(fs.existsSync(path.join(dataDir, 'saved-shots.json')), false);
  assert.deepEqual(packPoints([{ t: 0, x: 1, y: 2, z: NaN }, null, { t: 1, x: 1, y: 2, z: 3 }]), [[1, 1, 2, 3]]);
});
