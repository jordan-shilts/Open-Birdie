// tools/cloud-build-courses.mjs: which courses it builds and how it follows each cloud
// build, against a stand-in for the cloud client — no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCourses, buildOne, parseOsmRef, readFeatured, resolveCourse } from '../tools/cloud-build-courses.mjs';

const HAZELTINE = { name: 'Hazeltine National Golf Club', osmType: 'relation', osmId: 9892305, bbox: [44.82, 44.84, -93.59, -93.58] };
const noWait = async () => {};

// jobs: course key -> the job states a build goes through, last one sticking
function fakeClient({ built = {}, jobs = {}, fail = {} } = {}) {
  const calls = [];
  const progress = {};
  return {
    calls,
    async getManifest(key) { calls.push(['manifest', key]); return built[key] || null; },
    async requestBuild(body) {
      const key = `osm-${body.source.osmType}-${body.source.osmId}`;
      calls.push(['build', key, body]);
      if (fail[key]) throw new Error(fail[key]);
      progress[key] = 0;
      return { status: 'running', job: { id: `job-${key}`, ...jobs[key][0] } };
    },
    async getJob(id) {
      const key = id.replace(/^job-/, '');
      const states = jobs[key];
      progress[key] = Math.min(progress[key] + 1, states.length - 1);
      const job = { id, ...states[progress[key]] };
      if (job.status === 'done') built[key] = { complete: true, totalBytes: 11 * 1048576 };
      return job;
    },
  };
}

test('OSM ids in every spelling; names are not ids', () => {
  assert.deepEqual(parseOsmRef('relation/9892305'), { osmType: 'relation', osmId: 9892305 });
  assert.deepEqual(parseOsmRef('osm:way:26787026'), { osmType: 'way', osmId: 26787026 });
  assert.deepEqual(parseOsmRef('osm-way-26787026'), { osmType: 'way', osmId: 26787026 });
  assert.equal(parseOsmRef('Pebble Beach Golf Links'), null);
  assert.equal(parseOsmRef('way/0'), null);
});

test('the featured list resolves; a featured id brings its name and box; names are searched', async () => {
  const featured = readFeatured();
  assert.ok(featured.length >= 7);
  assert.ok(featured.every((c) => c.osmType && c.osmId && Array.isArray(c.bbox) && c.bbox.length === 4));
  const searched = [];
  const search = async (q) => { searched.push(q); return [{ name: 'Pebble Beach Golf Links, CA', osmType: 'relation', osmId: 3741806, bbox: [1, 2, 3, 4] }]; };
  const byId = await resolveCourse('relation/9892305', { search, featured });
  assert.equal(byId.name, 'Hazeltine National Golf Club');
  assert.ok(byId.bbox);
  assert.equal((await resolveCourse('way/123', { search, featured })).bbox, null);
  assert.equal((await resolveCourse('Pebble Beach', { search, featured })).osmId, 3741806);
  assert.deepEqual(searched, ['Pebble Beach']);
  await assert.rejects(resolveCourse('Nowhere Links', { search: async () => [], featured }), /no golf course found/);
});

test('a course the cloud has complete is skipped; otherwise it is built and followed to the end', async () => {
  const key = 'osm-relation-9892305';
  const done = fakeClient({ built: { [key]: { complete: true, totalBytes: 5 } } });
  const skipped = await buildOne(done, HAZELTINE, { sleep: noWait, log: () => {} });
  assert.equal(skipped.status, 'built');
  assert.equal(skipped.skipped, true);
  assert.ok(!done.calls.some(([op]) => op === 'build'));

  const lines = [];
  const client = fakeClient({
    jobs: { [key]: [
      { status: 'running', stage: 'starting', message: 'installing the course builder', pct: 0, pollMs: 10000 },
      { status: 'running', stage: 'base', message: 'fetching the map and terrain', pct: 5 },
      { status: 'running', stage: 'base', message: 'fetching the map and terrain', pct: 5 },
      { status: 'done', stage: 'done', message: 'done', pct: 100 },
    ] },
  });
  const waits = [];
  const result = await buildOne(client, HAZELTINE, { sleep: async (ms) => { waits.push(ms); }, log: (l) => lines.push(l) });
  assert.equal(result.status, 'built');
  assert.equal(result.bytes, 11 * 1048576);
  const [, , body] = client.calls.find(([op]) => op === 'build');
  assert.deepEqual(body.bbox, HAZELTINE.bbox, 'the box goes with the request, as from the course picker');
  assert.equal(body.name, HAZELTINE.name);
  assert.equal(lines.length, 3, 'one line per change, not per poll');
  assert.ok(waits.every((ms) => ms >= 5000), 'polls at the pace the cloud asks for, never hammering it');
});

test('one failure does not stop the rest, and concurrency is respected', async () => {
  const ok = { ...HAZELTINE };
  const bad = { name: 'Broken Links', osmType: 'way', osmId: 7, bbox: null };
  const failing = { name: 'Failing Links', osmType: 'way', osmId: 8, bbox: null };
  const client = fakeClient({
    fail: { 'osm-way-7': 'the cloud refused the build token' },
    jobs: {
      'osm-relation-9892305': [{ status: 'running' }, { status: 'done' }],
      'osm-way-8': [{ status: 'running' }, { status: 'failed', error: { message: 'The course could not be built.' } }],
    },
  });
  const results = await buildCourses(client, [bad, ok, failing], { concurrency: 2, sleep: noWait, log: () => {} });
  assert.deepEqual(results.map((r) => r.status), ['failed', 'built', 'failed']);
  assert.match(results[0].message, /build token/);
  assert.match(results[2].message, /could not be built/);
});
