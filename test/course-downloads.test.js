'use strict';
// The course download engine (lib/course-downloads.js): queue order, retries, cancel,
// yielding to a pick, a full cache, progress, and the queue kept across a restart.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CourseLoadError } = require('../lib/course');
const {
  MAX_JOBS,
  createCourseDownloads,
  downloadRequestOf,
} = require('../lib/course-downloads');

const quiet = { log() {}, warn() {}, error() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check, what = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// An acquire whose every call is settled by the test; aborting rejects it.
function fakeAcquire() {
  const calls = [];
  const acquire = (request, { signal }) => new Promise((resolve, reject) => {
    const call = { request, signal, resolve, reject };
    calls.push(call);
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  return { acquire, calls };
}

const req = (osmId, extra = {}) => ({ osmType: 'way', osmId, name: `Course ${osmId}`, ...extra });
const statusOf = (engine, courseId) => engine.snapshot().jobs.find((j) => j.courseId === courseId)?.status;
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-downloads-')), 'course-downloads.json');

function engineWith(options = {}) {
  const fake = fakeAcquire();
  const installed = [];
  const changes = [];
  const engine = createCourseDownloads({
    acquire: fake.acquire,
    onInstalled: (info) => installed.push(info),
    onChange: (snap) => changes.push(snap),
    notifyMs: 0,
    retryBaseMs: 20,
    log: quiet,
    ...options,
  });
  return { engine, ...fake, installed, changes };
}

test('a download request keeps only the course identity, its name, box and position', () => {
  const { source, request } = downloadRequestOf({
    osmType: 'relation', osmId: '9892305', name: `  Hazeltine ${'x'.repeat(400)}`,
    bbox: ['44.8', '44.9', '-93.7', '-93.5'], lat: 44.85, lon: -93.6, cached: 'evil.json', file: '../x',
  });
  assert.equal(source.courseId, 'osm:relation:9892305');
  assert.deepEqual(Object.keys(request).sort(), ['bbox', 'lat', 'lon', 'name', 'osmId', 'osmType']);
  assert.equal(request.name.length, 300);
  assert.deepEqual(request.bbox, [44.8, 44.9, -93.7, -93.5]);
  assert.equal(downloadRequestOf({ source: { osmType: 'way', osmId: 7 } }).source.courseId, 'osm:way:7');
  assert.equal('lat' in downloadRequestOf({ osmType: 'way', osmId: 7, lat: 200, lon: 0 }).request, false);
  for (const bad of [null, [], 'osm:way:1', { cached: 'pebble.json' }, { osmType: 'area', osmId: 1 }, { osmType: 'way', osmId: -4 }]) {
    assert.throws(() => downloadRequestOf(bad), { code: 'DOWNLOAD_INVALID' });
  }
});

test('courses download one at a time in the order they were added, and each finished one is installed', async () => {
  const { engine, calls, installed } = engineWith();
  engine.start();
  const results = engine.add([req(1), req(2), req(3)]);
  assert.deepEqual(results.map((r) => r.status), ['queued', 'queued', 'queued']);
  await until(() => calls.length === 1, 'the first download');
  assert.equal(calls[0].request.osmId, 1);
  assert.equal(statusOf(engine, 'osm:way:1'), 'downloading');
  assert.equal(statusOf(engine, 'osm:way:2'), 'queued');

  calls[0].resolve({ name: 'Course 1' });
  await until(() => calls.length === 2, 'the second download');
  assert.equal(calls[1].request.osmId, 2);
  assert.equal(statusOf(engine, 'osm:way:1'), 'done');
  assert.deepEqual(installed.map((i) => [i.courseId, i.key]), [['osm:way:1', 'osm-way-1']]);
  assert.deepEqual(installed[0].course, { name: 'Course 1' });

  calls[1].resolve({});
  await until(() => calls.length === 3);
  calls[2].resolve({});
  await engine.settled();
  const snap = engine.snapshot();
  assert.equal(snap.done, 3);
  assert.equal(snap.waiting, 0);
  assert.equal(snap.downloading, 0);
  assert.equal(snap.jobs[0].pct, 100);
});

test('concurrency runs that many at once', async () => {
  const { engine, calls } = engineWith({ concurrency: 2 });
  engine.start();
  engine.add([req(1), req(2), req(3)]);
  await until(() => calls.length === 2);
  await tick();
  assert.equal(calls.length, 2);
  calls[0].resolve({});
  await until(() => calls.length === 3);
});

test('a course already in the list is not added twice; a failed or finished one is downloaded again', async () => {
  const { engine, calls } = engineWith({ retries: 0 });
  engine.start();
  engine.add(req(1));
  await until(() => calls.length === 1);
  assert.deepEqual(engine.add(req(1)), [{ courseId: 'osm:way:1', status: 'downloading' }]);
  assert.equal(engine.snapshot().jobs.length, 1);

  calls[0].reject(new Error('network down'));
  await until(() => statusOf(engine, 'osm:way:1') === 'failed');
  assert.deepEqual(engine.add(req(1, { name: 'Renamed' })), [{ courseId: 'osm:way:1', status: 'queued' }]);
  await until(() => calls.length === 2);
  assert.equal(calls[1].request.name, 'Renamed');
  calls[1].resolve({});
  await until(() => statusOf(engine, 'osm:way:1') === 'done');
  engine.add(req(1));
  await until(() => calls.length === 3, 'a finished course downloaded again');
});

test('a failure that may pass is retried later while the next course goes ahead, then fails with the loader\'s words', async () => {
  const { engine, calls } = engineWith({ retries: 2, retryBaseMs: 30 });
  engine.start();
  engine.add([req(1), req(2)]);
  await until(() => calls.length === 1);
  calls[0].reject(new CourseLoadError('OVERPASS_UNAVAILABLE', 'Overpass servers are busy (/home/me/secret)', 'Wait a few minutes.'));
  await until(() => calls.length === 2, 'the next course');
  assert.equal(calls[1].request.osmId, 2, 'the next course goes ahead during the wait');
  let job = engine.snapshot().jobs[0];
  assert.equal(job.status, 'retrying');
  assert.equal(job.attempts, 1);
  assert.ok(job.retryAt > Date.now() - 5);
  assert.match(job.message, /^Trying again in 1 min: Overpass servers are busy/);
  assert.doesNotMatch(job.message, /home\/me/, 'no private path in public text');

  calls[1].resolve({}); // one at a time: the retry waits for the slot
  await until(() => calls.length === 3, 'the first retry');
  assert.equal(calls[2].request.osmId, 1);
  calls[2].reject(new CourseLoadError('OVERPASS_UNAVAILABLE', 'still busy', 'Wait.'));
  await until(() => calls.length === 4, 'the second retry');
  calls[3].reject(new CourseLoadError('OVERPASS_UNAVAILABLE', 'busy for good', 'Wait a few minutes.'));
  await until(() => statusOf(engine, 'osm:way:1') === 'failed');
  job = engine.snapshot().jobs[0];
  assert.equal(job.attempts, 3);
  assert.deepEqual(job.error, { code: 'OVERPASS_UNAVAILABLE', message: 'busy for good', recovery: 'Wait a few minutes.' });
  assert.equal(job.retryAt, null);
});

test('a course that cannot be loaded at all fails at once, with no retry', async () => {
  const { engine, calls } = engineWith({ retries: 2 });
  engine.start();
  engine.add(req(1));
  await until(() => calls.length === 1);
  calls[0].reject(new CourseLoadError('COURSE_NOT_GOLF_COURSE', '"Starter hut" is mapped as building=hut', 'Pick a golf course.'));
  await until(() => statusOf(engine, 'osm:way:1') === 'failed');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 1);
  assert.equal(engine.snapshot().jobs[0].error.code, 'COURSE_NOT_GOLF_COURSE');
});

test('cancel aborts a running download and forgets it; the next one starts', async () => {
  const { engine, calls, installed } = engineWith();
  engine.start();
  engine.add([req(1), req(2), req(3)]);
  await until(() => calls.length === 1);
  assert.equal(engine.cancel('osm:way:3'), true, 'a queued one');
  assert.equal(engine.cancel('osm:way:1'), true, 'the running one');
  assert.equal(calls[0].signal.aborted, true);
  await until(() => calls.length === 2);
  assert.equal(calls[1].request.osmId, 2);
  assert.deepEqual(engine.snapshot().jobs.map((j) => j.courseId), ['osm:way:2']);
  assert.equal(engine.cancel('osm:way:1'), false);
  assert.equal(engine.cancel('not a course'), false);
  assert.equal(engine.cancel('osm-way-2'), true, 'the key form works too');
  await engine.settled();
  assert.equal(installed.length, 0);
});

test('a cancelled download that finishes anyway is not reported as installed', async () => {
  // an acquire that ignores its signal (the coordinator may still be finishing it for a pick)
  const pending = [];
  const installed = [];
  const engine = createCourseDownloads({
    acquire: () => new Promise((resolve) => pending.push(resolve)),
    onInstalled: (i) => installed.push(i),
    notifyMs: 0,
    log: quiet,
  });
  engine.start();
  engine.add(req(1));
  await until(() => pending.length === 1);
  engine.cancel('osm:way:1');
  pending[0]({});
  await engine.settled();
  assert.equal(installed.length, 0);
  assert.equal(engine.snapshot().jobs.length, 0);
});

test('retry puts a failed download back in the queue with fresh retries', async () => {
  const { engine, calls } = engineWith({ retries: 0 });
  engine.start();
  engine.add(req(1));
  await until(() => calls.length === 1);
  calls[0].reject(new Error('timeout'));
  await until(() => statusOf(engine, 'osm:way:1') === 'failed');
  assert.equal(engine.retry('osm:way:2'), false);
  assert.equal(engine.retry('osm:way:1'), true);
  await until(() => calls.length === 2);
  assert.equal(engine.snapshot().jobs[0].attempts, 1);
  assert.equal(engine.retry('osm:way:1'), false, 'not while it downloads');
});

test('nothing new starts while a pick is loading; a download in progress carries on', async () => {
  const { engine, calls } = engineWith();
  engine.start();
  engine.add([req(1), req(2)]);
  await until(() => calls.length === 1);
  let finishPick;
  const pick = engine.yieldTo(() => new Promise((resolve) => { finishPick = resolve; }));
  assert.equal(engine.snapshot().paused, true);
  calls[0].resolve({});
  await until(() => statusOf(engine, 'osm:way:1') === 'done');
  await tick();
  assert.equal(calls.length, 1, 'the second waits for the pick');
  assert.equal(calls[0].signal.aborted, false);
  finishPick('committed');
  assert.equal(await pick, 'committed');
  await until(() => calls.length === 2);
  assert.equal(engine.snapshot().paused, false);
});

test('a pick that fails still lets the downloads go on', async () => {
  const { engine, calls } = engineWith();
  engine.start();
  await assert.rejects(engine.yieldTo(async () => {
    engine.add(req(1));
    await tick();
    assert.equal(calls.length, 0);
    throw new Error('pick failed');
  }), /pick failed/);
  await until(() => calls.length === 1);
});

test('a full course cache holds the queue until there is room again', async () => {
  let room = false;
  const { engine, calls, changes } = engineWith({ hasRoom: () => room });
  engine.start();
  engine.add([req(1), req(2)]);
  await tick();
  assert.equal(calls.length, 0);
  let snap = engine.snapshot();
  assert.equal(snap.blocked.code, 'CACHE_FULL');
  assert.match(snap.blocked.message, /BIRDIE_CACHE_MAX_MB/);
  assert.equal(snap.waiting, 2, 'the jobs keep waiting, they do not fail');
  await until(() => changes.some((c) => c.blocked));

  room = true;
  engine.resume();
  await until(() => calls.length === 1);
  assert.equal(engine.snapshot().blocked, null);

  // full again: cancelling everything that waits clears the notice too
  room = false;
  calls[0].resolve({});
  await until(() => engine.snapshot().blocked !== null);
  engine.cancel('osm:way:2');
  snap = engine.snapshot();
  assert.equal(snap.blocked, null);
  assert.equal(snap.waiting, 0);
});

test('a cache check that throws does not stop the downloads', async () => {
  const { engine, calls } = engineWith({ hasRoom: () => { throw new Error('index unreadable'); } });
  engine.start();
  engine.add(req(1));
  await until(() => calls.length === 1);
});

test('progress shows on the course while it downloads, clamped, with no private path', async () => {
  const { engine, calls } = engineWith();
  engine.start();
  engine.add([req(1), req(2)]);
  await until(() => calls.length === 1);
  engine.report({ courseId: 'osm:way:1', message: 'Downloading the course…', pct: 140 });
  let job = engine.snapshot().jobs[0];
  assert.equal(job.message, 'Downloading the course…');
  assert.equal(job.pct, 100);
  engine.report({ courseId: 'osm:way:1', message: 'Writing C:\\Users\\me\\data', pct: -3 });
  job = engine.snapshot().jobs[0];
  assert.doesNotMatch(job.message, /Users/);
  assert.equal(job.pct, 0);
  engine.report({ courseId: 'osm:way:2', message: 'not downloading yet', pct: 50 });
  assert.equal(engine.snapshot().jobs[1].pct, null, 'a waiting course takes no progress');
  engine.report(null);
  engine.report({ courseId: 'osm:way:9', pct: 1 });
});

test('every change moves the snapshot sequence on, so an older snapshot can be told from a newer one', async () => {
  const { engine, calls, changes } = engineWith();
  const first = engine.snapshot().seq;
  engine.start();
  engine.add(req(1));
  const queued = engine.snapshot().seq;
  assert.ok(queued > first);
  await until(() => calls.length === 1);
  engine.report({ courseId: 'osm:way:1', pct: 50 });
  const progressed = engine.snapshot().seq;
  assert.ok(progressed > queued);
  calls[0].resolve({});
  await until(() => changes.length && changes.at(-1).jobs[0]?.status === 'done');
  assert.ok(changes.at(-1).seq > progressed);
  assert.equal(engine.snapshot().seq, changes.at(-1).seq, 'nothing changed since the last report');
});

test('change reports are coalesced', async () => {
  const { engine, calls, changes } = engineWith({ notifyMs: 30 });
  engine.start();
  engine.add(req(1));
  await until(() => calls.length === 1);
  const before = changes.length;
  for (let i = 0; i <= 100; i++) engine.report({ courseId: 'osm:way:1', pct: i });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(changes.length - before <= 2, `${changes.length - before} reports for 101 updates`);
  assert.equal(changes.at(-1).jobs[0].pct, 100, 'the last report has the latest progress');
});

test('the list holds at most MAX_JOBS courses', () => {
  const { engine } = engineWith();
  const many = Array.from({ length: MAX_JOBS + 2 }, (_, i) => req(i + 1));
  const results = engine.add(many);
  assert.equal(results.filter((r) => r.status === 'queued').length, MAX_JOBS);
  assert.deepEqual(results.at(-1).error.code, 'DOWNLOAD_QUEUE_FULL');
  assert.equal(engine.add({ cached: 'x.json' })[0].error.code, 'DOWNLOAD_INVALID');
});

test('finished and running downloads are protected from cache eviction; clearing finished drops done and failed', async () => {
  const { engine, calls } = engineWith({ retries: 0 });
  engine.start();
  engine.add([req(1), req(2), req(3)]);
  await until(() => calls.length === 1);
  calls[0].resolve({});
  await until(() => calls.length === 2);
  assert.deepEqual(engine.protectedKeys().sort(), ['osm-way-1', 'osm-way-2']);
  calls[1].reject(new Error('nope'));
  await until(() => calls.length === 3);
  assert.equal(engine.clearFinished(), 2);
  assert.deepEqual(engine.snapshot().jobs.map((j) => j.courseId), ['osm:way:3']);
  assert.deepEqual(engine.protectedKeys(), ['osm-way-3']);
  assert.equal(engine.clearFinished(), 0);
});

test('an install hook that throws does not stop the queue', async () => {
  const { engine, calls } = engineWith({ onInstalled: () => { throw new Error('cache index locked'); } });
  engine.start();
  engine.add([req(1), req(2)]);
  await until(() => calls.length === 1);
  calls[0].resolve({});
  await until(() => calls.length === 2);
  assert.equal(statusOf(engine, 'osm:way:1'), 'done');
});

test('the queue outlives a restart: waiting and failed courses come back, finished ones do not', async () => {
  const file = tempFile();
  const first = engineWith({ file, retries: 0 });
  first.engine.start();
  first.engine.add([req(1), req(2, { bbox: [1, 2, 3, 4] }), req(3), req(4)]);
  await until(() => first.calls.length === 1);
  first.calls[0].resolve({});
  await until(() => first.calls.length === 2);
  first.calls[1].reject(new CourseLoadError('COURSE_NOT_PLAYABLE', 'No holes mapped', 'Try another course.'));
  await until(() => first.calls.length === 3);
  // course 3 is downloading when the app closes: it is downloaded again next time
  await first.engine.stop();
  assert.equal(first.calls[2].signal.aborted, true);

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.jobs.map((j) => [j.courseId, j.status]), [
    ['osm:way:2', 'failed'], ['osm:way:3', 'queued'], ['osm:way:4', 'queued'],
  ]);

  const second = engineWith({ file });
  const snap = second.engine.start();
  assert.deepEqual(snap.jobs.map((j) => [j.courseId, j.status]), [
    ['osm:way:2', 'failed'], ['osm:way:3', 'downloading'], ['osm:way:4', 'queued'],
  ]);
  assert.equal(snap.jobs[0].error.code, 'COURSE_NOT_PLAYABLE');
  assert.equal(snap.jobs[0].message, 'No holes mapped');
  await until(() => second.calls.length === 1);
  assert.equal(second.calls[0].request.osmId, 3);
  assert.equal(second.calls[0].request.name, 'Course 3');
  assert.equal(second.engine.retry('osm:way:2'), true);
  second.calls[0].resolve({});
  await until(() => second.calls.length === 2);
  assert.equal(second.calls[1].request.osmId, 2, 'a retried course keeps its place in the queue');
  assert.deepEqual(second.calls[1].request.bbox, [1, 2, 3, 4]);
  second.calls[1].resolve({});
  await until(() => second.calls.length === 3);
  assert.equal(second.calls[2].request.osmId, 4);
  await second.engine.stop();
});

test('a damaged queue file is ignored, and damaged entries are dropped', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{not json');
  const warnings = [];
  const log = { ...quiet, warn: (m) => warnings.push(m) };
  let engine = createCourseDownloads({ acquire: () => new Promise(() => {}), file, log, notifyMs: 0 });
  assert.deepEqual(engine.start().jobs, []);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /birdie-downloads-/, 'no data dir path in the log line');

  fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: [
    { courseId: 'osm:way:9', request: { osmType: 'way', osmId: 8 }, status: 'queued' }, // identity disagrees
    { courseId: 'osm:way:7', request: { cached: 'x.json' }, status: 'queued' },
    null,
    { courseId: 'osm:way:5', request: { osmType: 'way', osmId: 5, name: 'Five' }, status: 'failed', error: { code: 'X', message: 'boom' } },
    { courseId: 'osm:way:5', request: { osmType: 'way', osmId: 5 }, status: 'queued' }, // duplicate
  ] }));
  engine = createCourseDownloads({ acquire: () => new Promise(() => {}), file, log: quiet, notifyMs: 0 });
  const jobs = engine.start().jobs;
  assert.deepEqual(jobs.map((j) => [j.courseId, j.status, j.name]), [['osm:way:5', 'failed', 'Five']]);
  assert.equal(jobs[0].error.message, 'boom');

  fs.writeFileSync(file, JSON.stringify({ version: 2, jobs: [] }));
  assert.deepEqual(createCourseDownloads({ acquire: () => {}, file, log: quiet }).start().jobs, []);
});

test('without a file nothing is written; without start nothing runs', async () => {
  const { engine, calls } = engineWith();
  engine.add(req(1));
  await tick();
  assert.equal(calls.length, 0);
  engine.start();
  await until(() => calls.length === 1);
  assert.throws(() => createCourseDownloads({}), TypeError);
  assert.throws(() => createCourseDownloads({ acquire() {}, concurrency: 0 }), TypeError);
});
