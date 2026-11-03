'use strict';
// The player's bag (lib/bag.js): which launch-monitor shots it keeps, the last 30 per
// club, the launch model per club (typical -> scaled -> the player's own), and its
// storage — the JSON file by default, or any store with the same three async calls.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CLUB_FULL } = require('../lib/game');
const { Bag, FULL_CLUBS, createBag, createFileStore, modelFor } = require('../lib/bag');

const launch = (speedMph, extra = {}) => ({ speedMph, vla: 19, hla: 0, totalSpin: 7000, spinAxis: 0, ...extra });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-bag-'));
const quiet = { warn: () => {} };

test('records full shots by club; putts, mishits, unknown clubs and bad data are skipped', () => {
  const bag = new Bag();
  assert.deepEqual(bag.record('I7', launch(110)), { recorded: true, club: 'I7', n: 1 });
  assert.deepEqual(bag.record('7i', launch(108)), { recorded: true, club: 'I7', n: 2 });
  assert.equal(bag.record('PT', launch(8)).reason, 'putt');
  assert.equal(bag.record('I7', launch(0.5 * CLUB_FULL.I7.speedMph)).reason, 'mishit', 'under 55 % of the 7-iron speed');
  assert.equal(bag.record('I7', launch(0.56 * CLUB_FULL.I7.speedMph)).recorded, true);
  assert.equal(bag.record('BANANA', launch(110)).reason, 'unknown-club');
  assert.equal(bag.record('I7', launch(NaN)).reason, 'invalid');
  assert.equal(bag.shots('I7').length, 3);

  // launch-monitor shots: the monitor's club name, else the player's pick, never a guess
  const ball = { Speed: 150, VLA: 12, HLA: 1, TotalSpin: 2600, SpinAxis: 4 };
  assert.equal(bag.recordShot({ ball, clubName: 'DRIVER' }).club, 'DR');
  assert.equal(bag.recordShot({ ball, clubName: null, selectedClub: 'DR' }).club, 'DR');
  assert.deepEqual(bag.recordShot({ ball, clubName: 'BANANA', selectedClub: 'DR' }), { recorded: false, club: null, reason: 'unknown-club' });
  assert.equal(bag.recordShot({ ball, clubName: null, selectedClub: null }).reason, 'unknown-club');
  assert.equal(bag.recordShot({ ball, clubName: 'DRIVER', isPutt: true }).reason, 'putt');
  assert.equal(bag.recordShot({ ball: { Speed: 'fast' }, clubName: 'DRIVER' }).reason, 'invalid');
  assert.equal(bag.recordShot({ ball: { Speed: 95, VLA: 25, TotalSpin: 9000 }, clubName: 'GW' }).club, 'PW', 'gap wedge: the nearest wedge');
  const [first] = bag.shots('DR');
  assert.deepEqual({ ...first, at: 0 }, { club: 'DR', speedMph: 150, vla: 12, hla: 1, totalSpin: 2600, spinAxis: 4, at: 0, clubName: 'DRIVER' });
});

test('keeps the last 30 shots of each club', () => {
  const bag = new Bag();
  for (let k = 0; k < 35; k++) bag.record('I7', launch(100 + k));
  bag.record('PW', launch(90));
  const shots = bag.shots('I7');
  assert.equal(shots.length, 30);
  assert.equal(shots[0].speedMph, 105, 'the five oldest went');
  assert.equal(shots[29].speedMph, 134);
  assert.equal(bag.total, 31);
});

test('model sources: typical with no shots, scaled from other clubs, the player\'s own from 3 shots', () => {
  const bag = new Bag();
  const typical = bag.model('DR');
  assert.deepEqual(typical, {
    club: 'DR', source: 'typical', n: 0,
    launch: { speedMph: 152, vla: 13, hla: 0, totalSpin: 2600, spinAxis: 0 },
    sd: { speedMph: 4.56, vla: 1.5, hla: 2.5, spinAxis: 6 },
  });
  assert.deepEqual(bag.model('PW').sd, { speedMph: 2.28, vla: 1.5, hla: 1.5, spinAxis: 3 });
  assert.deepEqual(modelFor(null, 'I7'), new Bag().model('I7'), 'no bag: typical');

  // two 7-irons at 115.44 mph (104 % of typical): the 7-iron and the driver are scaled
  bag.record('I7', launch(115.44, { hla: 2, spinAxis: 6 }));
  bag.record('I7', launch(115.44, { hla: 2, spinAxis: 6 }));
  for (const club of ['I7', 'DR']) {
    const m = bag.model(club);
    assert.equal(m.source, 'scaled', club);
    assert.equal(m.launch.speedMph, Math.round(CLUB_FULL[club].speedMph * 1.04 * 10) / 10, club);
    assert.equal(m.launch.vla, CLUB_FULL[club].vla);
    assert.deepEqual([m.launch.hla, m.launch.spinAxis], [0, 0]);
  }
  assert.equal(bag.model('I7').n, 2);

  // the third: the player's own — medians for speed, launch, spin; means for line and curve
  bag.record('I7', launch(105, { vla: 21, totalSpin: 6400, hla: -1, spinAxis: 0 }));
  const own = bag.model('I7');
  assert.equal(own.source, 'player');
  assert.deepEqual(own.launch, { speedMph: 115.4, vla: 19, hla: 1, totalSpin: 7000, spinAxis: 4 });
  assert.deepEqual(own.sd, { speedMph: 3.0, vla: 1.5, hla: 1.8, spinAxis: 4 }, 'typical spread under 5 shots');

  // five or more: the spread comes from the shots (sample SD, with a floor)
  bag.record('I7', launch(110, { hla: 0, spinAxis: 2 }));
  bag.record('I7', launch(112, { hla: 1, spinAxis: 3 }));
  const sd = bag.model('I7').sd;
  const speeds = [115.44, 115.44, 105, 110, 112];
  const m = speeds.reduce((a, b) => a + b) / 5;
  assert.equal(sd.speedMph, Math.round(Math.sqrt(speeds.reduce((a, s) => a + (s - m) ** 2, 0) / 4) * 100) / 100);
  for (let k = 0; k < 5; k++) bag.record('LW', launch(68, { vla: 32, totalSpin: 10500 }));
  assert.deepEqual(bag.model('LW').sd, { speedMph: 0.34, vla: 0.3, hla: 0.3, spinAxis: 0.5 }, 'identical shots: the floor');
});

test('summary lists every full club in bag order', () => {
  const bag = new Bag();
  bag.record('DR', launch(150, { vla: 12, totalSpin: 2600 }), { at: 1234 });
  const s = bag.summary();
  assert.deepEqual(s.clubs.map((c) => c.club), FULL_CLUBS);
  assert.deepEqual(FULL_CLUBS, ['DR', 'W3', 'H3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'PW', 'SW', 'LW']);
  assert.equal(s.total, 1);
  assert.deepEqual(s.clubs[0], { ...s.clubs[0], club: 'DR', n: 1, source: 'scaled', lastAt: 1234 });
  assert.equal(s.clubs[1].lastAt, null);
});

test('the file store: the history survives a restart, keeps 30 per club, a corrupt file is set aside', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'bag.json');
  const bag = createBag({ dataDir: dir, log: quiet });
  await bag.ready;
  assert.equal(bag.total, 0);
  const meta = { at: 1700000000000, course: 'Lineup Links', hole: 7, lie: 'fairway', practice: null };
  bag.record('I7', launch(111), meta);
  bag.record('DR', launch(150, { vla: 12, totalSpin: 2600 }), { ...meta, lie: 'tee' });
  for (let k = 0; k < 32; k++) bag.record('PW', launch(90 + k * 0.1, { vla: 25, totalSpin: 9300 }), { ...meta, at: meta.at + k });
  await bag.flush();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.shots.length, 32, '1 + 1 + the last 30 wedges');
  assert.deepEqual(saved.shots[0], { club: 'I7', speedMph: 111, vla: 19, hla: 0, totalSpin: 7000, spinAxis: 0, at: 1700000000000, course: 'Lineup Links', lie: 'fairway', hole: 7 });

  const again = createBag({ dataDir: dir, log: quiet });
  await again.ready;
  assert.equal(again.total, 32);
  assert.deepEqual(again.model('I7'), bag.model('I7'));
  assert.deepEqual(again.shots('PW'), bag.shots('PW'));

  await again.reset();
  assert.equal(again.total, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).shots, []);

  fs.writeFileSync(file, '{"shots": [oops');
  const fresh = createBag({ dataDir: dir, log: quiet });
  await fresh.ready;
  assert.equal(fresh.total, 0);
  assert.ok(fs.existsSync(`${file}.corrupt`), 'the unreadable history is kept aside');
});

test('any async store with load / append / reset can replace the file', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const store = {
    kind: 'memory',
    async load() {
      calls.push(['load']);
      await gate;
      return [
        { club: 'I7', speedMph: 109, vla: 19, hla: 0, totalSpin: 7000, spinAxis: 0, at: 2 },
        { club: 'I7', speedMph: 111, vla: 19, hla: 0, totalSpin: 7000, spinAxis: 0, at: 1 },
        { club: 'XX', speedMph: 111, vla: 19, hla: 0, totalSpin: 7000, spinAxis: 0, at: 3 },   // dropped
      ];
    },
    async append(club, l, meta) { calls.push(['append', club, l, meta]); },
    async reset() { calls.push(['reset']); },
  };
  const bag = new Bag({ store, log: quiet });
  const ready = bag.load();
  // a shot while the history is still loading is kept, after the stored ones
  bag.record('I7', launch(113), { at: 5, course: 'Lineup Links', hole: 3, lie: 'rough' });
  release();
  await ready;
  assert.deepEqual(bag.shots('I7').map((s) => s.speedMph), [111, 109, 113]);
  assert.equal(bag.model('I7').source, 'player');
  await bag.flush();
  assert.deepEqual(calls[0], ['load']);
  assert.deepEqual(calls[1], ['append', 'I7',
    { speedMph: 113, vla: 19, hla: 0, totalSpin: 7000, spinAxis: 0 },
    { at: 5, course: 'Lineup Links', hole: 3, lie: 'rough' }]);
  await bag.reset();
  assert.deepEqual(calls[2], ['reset']);
  assert.equal(bag.summary().store, 'memory');

  // a store that fails never breaks recording
  const broken = new Bag({ store: { load: async () => { throw new Error('offline'); }, append: async () => { throw new Error('offline'); } }, log: quiet });
  await broken.load();
  assert.equal(broken.record('DR', launch(150, { vla: 12, totalSpin: 2600 })).recorded, true);
  await broken.flush();
  assert.equal(broken.total, 1);
});

test('createFileStore can be used on its own', async () => {
  const file = path.join(tmpDir(), 'nested', 'bag.json');
  const store = createFileStore(file, { maxPerClub: 2, log: quiet });
  assert.deepEqual(await store.load(), []);
  for (const s of [101, 102, 103]) await store.append('I8', launch(s), { at: s });
  assert.deepEqual((await store.load()).map((s) => s.speedMph), [102, 103]);
  await store.append('PT', launch(8));   // not a full club: ignored
  assert.equal((await store.load()).length, 2);
});
