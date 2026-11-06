'use strict';
// The download engine wired into the server (server.js) against an in-process fake of
// the cloud course API: download over HTTP, the library and cache index afterwards, a
// background download's progress kept off the in-round status line, a course that
// cannot be loaded, cancel stopping a cloud build's polling, and the saved queue.
// No network.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// lib/course.js fixes its cache dir at first require.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-downloads-server-'));
process.env.BIRDIE_DATA_DIR = DATA;

const test = require('node:test');
const assert = require('node:assert/strict');
const { packageFor, startFakeCloud, testCourse } = require('./cloud-test-support');

async function until(check, what, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Every server-sent event, as { event, data }.
function listen(url) {
  const events = [];
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event) events.push({ event, data: data ? JSON.parse(data) : null });
      }
    }
  })().catch(() => {});
  return { events, close: () => { controller.abort(); return done; } };
}

test('server: courses download ahead of time from the cloud, into the library', async (t) => {
  const builds = new Map(); // osmId -> how the fake cloud answers a build of it
  const cloud = await startFakeCloud({
    token: 'tok',
    onBuild: (body) => builds.get(body.source.osmId) || null,
  });
  t.after(() => cloud.close());
  cloud.publish(packageFor(testCourse(4101)));
  cloud.publish(packageFor(testCourse(4104)));
  // a course the cloud cannot build: no holes mapped
  builds.set(4102, {
    status: 'failed', stage: 'base', message: 'failed',
    error: { code: 'COURSE_NOT_PLAYABLE', message: 'No holes are mapped on this course.', recovery: 'Try another course.' },
  });
  // a build that never finishes (until it is cancelled)
  builds.set(4103, { status: 'running', stage: 'base', message: 'fetching the map and terrain', pct: 10, advance() {} });

  Object.assign(process.env, {
    BIRDIE_PORT: '0', BIRDIE_OC_PORT: '0', BIRDIE_NO_AUTOLOAD: '1', BIRDIE_NO_WATCH: '1', BIRDIE_ENRICH: '0',
    BIRDIE_ART_DIR: path.join(DATA, 'missing-art'), BIRDIE_CLOUD_URL: cloud.url, BIRDIE_CLOUD_BUILD_TOKEN: 'tok',
  });
  const server = require('../server.js');
  t.after(() => server.close());
  const { httpPort } = await server.ready;
  const base = `http://127.0.0.1:${httpPort}`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const sse = listen(`${base}/events`);
  t.after(() => sse.close());
  const job = async (courseId) => (await get('/api/downloads')).jobs.find((j) => j.courseId === courseId);

  // --- a download: one good course, and one request that is not a course
  let reply = await post('/api/downloads', {
    courses: [{ osmType: 'way', osmId: 4101, name: 'Cloud Links 4101' }, { cached: 'pebble.json' }],
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
  assert.deepEqual(reply.body.results[0], { courseId: 'osm:way:4101', status: 'queued' });
  assert.equal(reply.body.results[1].error.code, 'DOWNLOAD_INVALID');
  await until(async () => (await job('osm:way:4101'))?.status === 'done', 'the download');

  const library = await get('/api/courses');
  const card = library.courses.find((c) => c.courseId === 'osm:way:4101');
  assert.ok(card, 'the downloaded course is in the library');
  assert.equal(card.name, 'Cloud Links 4101');
  assert.equal(library.current, null, 'downloading is not playing');
  const index = JSON.parse(fs.readFileSync(path.join(DATA, 'course-cache.json'), 'utf8'));
  assert.equal(index.entries['osm-way-4101'].origin, 'cloud');
  assert.ok(cloud.requests.includes('GET /v1/courses/osm-way-4101'));

  await until(() => sse.events.some((e) => e.event === 'downloads' && e.data.jobs.some((j) => j.status === 'done')), 'a downloads event');
  assert.equal(sse.events[0].event, 'state');
  assert.ok(sse.events.some((e) => e.event === 'downloads' && e.data.jobs.length === 0), 'the list is sent on connect');
  assert.ok(!sse.events.some((e) => e.event === 'course-progress' && e.data.courseId === 'osm:way:4101'),
    'a background download does not report over the course being played');

  // --- one request alone, refused
  reply = await post('/api/downloads', { osmType: 'way' });
  assert.equal(reply.status, 400);
  assert.equal(reply.body.code, 'DOWNLOAD_INVALID');

  // --- a course that cannot be loaded fails at once, and can be tried again
  await post('/api/downloads', { osmType: 'way', osmId: 4102, name: 'Hollow Links' });
  const failed = await until(async () => { const j = await job('osm:way:4102'); return j?.status === 'failed' && j; }, 'the failure');
  assert.equal(failed.error.code, 'COURSE_NOT_PLAYABLE');
  assert.equal(failed.message, 'No holes are mapped on this course.');
  assert.equal(failed.attempts, 1, 'no retry for a course that cannot be loaded');
  reply = await post('/api/downloads/retry', { courseId: 'osm:way:4102' });
  assert.equal(reply.body.ok, true);
  await until(async () => {
    const j = await job('osm:way:4102');
    return j?.status === 'failed' && j.finishedAt > failed.finishedAt;
  }, 'the retry failing again');

  // --- a pick still shows its own progress in the picker
  const picked = await post('/api/load-course', { osmType: 'way', osmId: 4104, name: 'Cloud Links 4104' });
  assert.equal(picked.body.ok, true, JSON.stringify(picked.body));
  await until(() => sse.events.some((e) => e.event === 'course-progress' && e.data.courseId === 'osm:way:4104'), 'the pick\'s progress');

  // --- cancel stops a cloud build's polling, end to end
  await post('/api/downloads', { osmType: 'way', osmId: 4103, name: 'Endless Links' });
  await until(async () => /Building in the cloud/.test((await job('osm:way:4103'))?.message || ''), 'the cloud build');
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'course-downloads.json'), 'utf8'));
  assert.deepEqual(saved.jobs.map((j) => [j.courseId, j.status]), [['osm:way:4102', 'failed'], ['osm:way:4103', 'queued']],
    'waiting and failed downloads are kept for the next start');
  reply = await post('/api/downloads/cancel', { courseId: 'osm:way:4103' });
  assert.equal(reply.body.ok, true);
  assert.equal(await job('osm:way:4103'), undefined);
  const polls = () => cloud.requests.filter((r) => r.startsWith('GET /v1/jobs/')).length;
  const before = polls();
  await new Promise((resolve) => setTimeout(resolve, 2300)); // past one cloud poll interval
  assert.equal(polls(), before, 'nothing polls the cancelled build');
  assert.equal(fs.existsSync(path.join(DATA, 'courses', 'osm-way-4103.json')), false);

  // --- clearing the finished ones
  reply = await post('/api/downloads/clear', {});
  assert.equal(reply.body.cleared, 2);
  assert.deepEqual(reply.body.downloads.jobs, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'course-downloads.json'), 'utf8')).jobs, []);
});
