'use strict';
// The desktop cloud client (lib/cloud-client.js) against an in-process fake of the
// cloud API: package download + verification, cloud builds with progress, local
// fallback, cloud scenery for cached courses, and the server wiring. No network.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// lib/course.js fixes its cache dir at first require.
const SERVER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-cloud-desk-'));
process.env.BIRDIE_DATA_DIR = SERVER_DATA;

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRequestBody,
  cloudConfigFromEnv,
  cloudSceneryProviders,
  createCloudClient,
  createCloudCourseSource,
  originTransform,
} = require('../lib/cloud-client');
const { CourseLoadError, loadCourse, readSourceKeyedCache } = require('../lib/course');
const { enrichCourseScenery } = require('../lib/course-enrichment');
const { packageFor, startFakeCloud, tempDir, testCourse } = require('./cloud-test-support');

const quiet = { log() {}, warn() {}, error() {} };
const noWait = async (_ms, signal) => { if (signal && signal.aborted) throw signal.reason; };

test('BIRDIE_CLOUD_URL unset means no cloud; a bad URL is ignored; the token is optional', () => {
  assert.equal(cloudConfigFromEnv({}), null);
  assert.equal(cloudConfigFromEnv({ BIRDIE_CLOUD_URL: '   ' }), null);
  assert.equal(cloudConfigFromEnv({ BIRDIE_CLOUD_URL: 'ftp://files.example.com' }, quiet), null);
  assert.equal(cloudConfigFromEnv({ BIRDIE_CLOUD_URL: 'not a url' }, quiet), null);
  assert.deepEqual(cloudConfigFromEnv({ BIRDIE_CLOUD_URL: 'https://birdie.example.com/' }), { baseUrl: 'https://birdie.example.com', buildToken: null });
  assert.deepEqual(
    cloudConfigFromEnv({ BIRDIE_CLOUD_URL: 'https://birdie.example.com/api/', BIRDIE_CLOUD_BUILD_TOKEN: ' t0k ' }),
    { baseUrl: 'https://birdie.example.com/api', buildToken: 't0k' },
  );
});

test('a build request carries the OSM identity plus the search hit name and box', () => {
  const source = { courseId: 'osm:way:5', osmType: 'way', osmId: 5 };
  assert.deepEqual(buildRequestBody({ name: ' Old Course ', bbox: ['56.3', 56.4, -2.9, -2.8], lat: '56.35', lon: -2.85 }, source), {
    source: { osmType: 'way', osmId: 5 }, name: 'Old Course', bbox: [56.3, 56.4, -2.9, -2.8], lat: 56.35, lon: -2.85,
  });
  assert.deepEqual(buildRequestBody({ bbox: [1, 2], lat: null, lon: '' }, source), { source: { osmType: 'way', osmId: 5 } });
});

test('client: 404 is "not in the cloud", 5xx and a dead host are "unavailable", builds need the token', async (t) => {
  const cloud = await startFakeCloud({ token: 'right' });
  t.after(() => cloud.close());
  const client = createCloudClient({ baseUrl: cloud.url, buildToken: 'wrong' });
  assert.equal(await client.getManifest('osm-way-1'), null);
  await assert.rejects(client.requestBuild({ source: { osmType: 'way', osmId: 1 } }), { code: 'CLOUD_AUTH' });
  await assert.rejects(createCloudClient({ baseUrl: cloud.url }).requestBuild({}), { code: 'CLOUD_AUTH' });
  const down = await startFakeCloud({ failAll: true });
  await assert.rejects(createCloudClient({ baseUrl: down.url }).getManifest('osm-way-1'), { code: 'CLOUD_UNAVAILABLE' });
  await down.close();
  await assert.rejects(createCloudClient({ baseUrl: down.url, timeoutMs: 2000 }).getManifest('osm-way-1'), { code: 'CLOUD_UNAVAILABLE' });
});

test('a cloud package is downloaded through presigned redirects, verified and installed', async (t) => {
  const cloud = await startFakeCloud({ redirectFiles: true });
  t.after(() => cloud.close());
  const pkg = packageFor(testCourse(77));
  cloud.publish(pkg);
  const dataDir = tempDir('birdie-desk-');
  const progress = [];
  const installed = [];
  const source = createCloudCourseSource({
    client: createCloudClient({ baseUrl: cloud.url }),
    dataDir,
    log: quiet,
    onProgress: (p) => progress.push(p),
    onInstalled: (info) => installed.push(info),
  });
  const course = await source.acquire({ request: { name: 'x' }, source: testCourse(77).source });
  assert.equal(course.name, 'Cloud Links 77');
  assert.equal(course.aerial.file, 'osm-way-77.aerial.jpg');
  assert.ok(readSourceKeyedCache({ cacheDir: path.join(dataDir, 'courses'), source: course.source }));
  assert.equal(installed[0].manifest.packageId, pkg.manifest.packageId);
  assert.deepEqual(progress.map((p) => p.stage).filter((s, i, a) => a.indexOf(s) === i), ['cloud', 'download']);
  assert.equal(progress.at(-1).pct, 100);
  const fileGets = cloud.requests.filter((r) => r.startsWith('GET /v1/courses/osm-way-77/files/'));
  assert.equal(fileGets.length, pkg.manifest.files.length);
  assert.equal(cloud.requests.filter((r) => r.startsWith('GET /blob/')).length, pkg.manifest.files.length, 'redirects followed');
  assert.ok(!cloud.requests.some((r) => r.startsWith('POST')), 'no build requested');
});

test('a course the cloud lacks is built there; playable once the base package is published', async (t) => {
  const course = testCourse(88);
  const pkg = packageFor(course, { complete: false });
  let polls = 0;
  const cloud = await startFakeCloud({
    token: 'tok',
    onBuild: () => ({
      advance(job, c) {
        polls++;
        if (polls === 1) Object.assign(job, { status: 'running', stage: 'base', message: 'fetching the map and terrain', pct: 20 });
        else { c.publish(pkg); Object.assign(job, { stage: 'scenery', message: 'adding buildings', pct: 60, packageId: pkg.manifest.packageId }); }
      },
    }),
  });
  t.after(() => cloud.close());
  const progress = [];
  const source = createCloudCourseSource({
    client: createCloudClient({ baseUrl: cloud.url, buildToken: 'tok' }),
    dataDir: tempDir('birdie-desk-'),
    sleep: noWait,
    log: quiet,
    onProgress: (p) => progress.push(p),
  });
  const installed = await source.acquire({ request: { name: 'Cloud Links 88', bbox: [44.9, 45.1, -93.1, -92.9] }, source: course.source });
  assert.equal(installed.name, 'Cloud Links 88');
  assert.deepEqual(cloud.lastBuildBody, { source: { osmType: 'way', osmId: 88 }, name: 'Cloud Links 88', bbox: [44.9, 45.1, -93.1, -92.9] });
  const builds = progress.filter((p) => p.stage === 'build').map((p) => p.message);
  assert.ok(builds.includes('Building in the cloud: fetching the map and terrain'));
  assert.ok(progress.some((p) => p.stage === 'download'));
});

test('a cloud build that proves the course unplayable fails the load; other failures build locally', async (t) => {
  const course = testCourse(99);
  const failing = (error) => startFakeCloud({ token: 'tok', onBuild: () => ({ status: 'failed', error }) });
  const definitive = await failing({ code: 'COURSE_NOT_GOLF_COURSE', message: '"Starter Hut" is mapped as building=hut, not as a golf course', userFacing: true });
  t.after(() => definitive.close());
  const make = (cloud) => createCloudCourseSource({
    client: createCloudClient({ baseUrl: cloud.url, buildToken: 'tok' }), dataDir: tempDir('birdie-desk-'), sleep: noWait, log: quiet,
  });
  await assert.rejects(make(definitive).acquire({ source: course.source }), (error) => {
    assert.ok(error instanceof CourseLoadError);
    assert.equal(error.code, 'COURSE_NOT_GOLF_COURSE');
    return true;
  });
  const internal = await failing({ code: 'BUILD_CRASHED', message: 'out of memory' });
  t.after(() => internal.close());
  assert.equal(await make(internal).acquire({ source: course.source }), null);
});

test('unreachable cloud, no token, or a tampered file: null (build locally), nothing installed', async (t) => {
  const course = testCourse(77);
  const pkg = packageFor(course);
  const down = await startFakeCloud();
  await down.close();
  const progress = [];
  const viaDown = createCloudCourseSource({
    client: createCloudClient({ baseUrl: down.url, timeoutMs: 2000 }), dataDir: tempDir('birdie-desk-'), log: quiet,
    onProgress: (p) => progress.push(p),
  });
  assert.equal(await viaDown.acquire({ source: course.source }), null);
  assert.match(progress.at(-1).message, /building it on this computer/);

  const empty = await startFakeCloud();
  t.after(() => empty.close());
  const noToken = createCloudCourseSource({ client: createCloudClient({ baseUrl: empty.url }), dataDir: tempDir('birdie-desk-'), log: quiet });
  assert.equal(await noToken.acquire({ source: course.source }), null);
  assert.deepEqual(empty.requests, ['GET /v1/courses/osm-way-77'], 'no build without a token');

  const evil = await startFakeCloud({ tamper: (entry, bytes) => (entry.role === 'aerial' ? Buffer.concat([bytes, Buffer.from('!')]) : bytes) });
  t.after(() => evil.close());
  evil.publish(pkg);
  const dataDir = tempDir('birdie-desk-');
  const viaEvil = createCloudCourseSource({ client: createCloudClient({ baseUrl: evil.url }), dataDir, log: quiet });
  assert.equal(await viaEvil.acquire({ source: course.source }), null);
  assert.equal(fs.existsSync(path.join(dataDir, 'courses', 'osm-way-77.json')), false);
});

test('picking another course aborts a cloud build wait', async (t) => {
  const cloud = await startFakeCloud({ token: 'tok', onBuild: () => ({ status: 'running', message: 'slow' }) });
  t.after(() => cloud.close());
  const controller = new AbortController();
  const source = createCloudCourseSource({
    client: createCloudClient({ baseUrl: cloud.url, buildToken: 'tok' }),
    dataDir: tempDir('birdie-desk-'),
    log: quiet,
    pollMs: 50,
  });
  const pending = source.acquire({ source: testCourse(5).source, signal: controller.signal });
  setTimeout(() => controller.abort(), 120);
  await assert.rejects(pending, (error) => error.name === 'AbortError' || controller.signal.aborted);
});

test('loadCourse tries the cloud only on a cache miss, inside the acquisition coordinator', async () => {
  const course = testCourse(4242);
  const calls = [];
  const remote = async ({ source, request }) => {
    calls.push([source.courseId, request.name]);
    fs.mkdirSync(path.join(SERVER_DATA, 'courses'), { recursive: true });
    fs.writeFileSync(path.join(SERVER_DATA, 'courses', 'osm-way-4242.json'), JSON.stringify(course));
    return course;
  };
  const first = await loadCourse({ name: 'Cloud Links 4242', osmType: 'way', osmId: 4242 }, { remote });
  assert.equal(first.name, 'Cloud Links 4242');
  const second = await loadCourse({ name: 'Cloud Links 4242', osmType: 'way', osmId: 4242 }, { remote });
  assert.equal(second.name, 'Cloud Links 4242');
  assert.deepEqual(calls, [['osm:way:4242', 'Cloud Links 4242']], 'a cache hit never asks the cloud');
});

test('origin transform is exact per axis and the identity for one origin', () => {
  const same = originTransform({ lat: 45, lon: -93 }, { lat: 45, lon: -93 });
  assert.deepEqual(same.point([1.234, 5.678, 9]), [1.234, 5.678, 9]);
  const shifted = originTransform({ lat: 45, lon: -93 }, { lat: 45.0001, lon: -93.0002 });
  const mPerLon = 111319.49 * Math.cos((45.0001 * Math.PI) / 180);
  const [x, y] = shifted.point([0, 0]);
  assert.ok(Math.abs(x - 0.0002 * mPerLon) < 0.01, `x ${x}`);
  assert.ok(Math.abs(y - -0.0001 * 111132.95) < 0.01, `y ${y}`);
});

test('cloud scenery fills a cached course, re-projected when its origin differs', async (t) => {
  const cloudCourse = testCourse(77, {
    buildings: [{ poly: [[100, 100], [110, 100], [110, 110]], heightM: 6, kind: 'yes', name: null, clubhouse: true }],
    scenery: { water: [{ kind: 'water', poly: [[200, 0], [260, 0], [260, 50], [200, 50]], name: 'Lake Cloud' }] },
    canopy: { source: 'cloud', trees: [[50, 60, 14, 4]] },
  });
  const pkg = packageFor(cloudCourse);
  const cloud = await startFakeCloud();
  t.after(() => cloud.close());
  cloud.publish(pkg);
  const fallbackCalls = [];
  const providers = cloudSceneryProviders({
    client: createCloudClient({ baseUrl: cloud.url }),
    fallback: { buildings: async () => { fallbackCalls.push('buildings'); return { status: 'skipped' }; } },
    log: quiet,
  });

  // same origin: values pass through untouched; the classmap comes with the aerial
  const local = testCourse(77);
  const outcome = await enrichCourseScenery(local, { providers, log: quiet });
  assert.deepEqual(outcome.applied, ['buildings', 'water', 'canopy', 'aerial']);
  assert.deepEqual(local.buildings, cloudCourse.buildings);
  assert.deepEqual(local.scenery.water, cloudCourse.scenery.water);
  assert.deepEqual(local.canopy.trees, [[50, 60, 14, 4]]);
  assert.equal(local.aerial.quality, 'tiled');
  assert.equal(local.aerial.classFile, 'osm-way-77.classmap.png');
  assert.deepEqual(fallbackCalls, []);

  // a local cache built from a slightly different OSM snapshot (origin 11 m north)
  const moved = testCourse(77, { origin: { lat: 45.0001, lon: -93 } });
  await enrichCourseScenery(moved, { providers, log: quiet });
  const dy = 0.0001 * 111132.95;
  assert.ok(Math.abs(moved.buildings[0].poly[0][1] - (100 - dy)) < 0.02, `y ${moved.buildings[0].poly[0][1]}`);
  assert.ok(Math.abs(moved.canopy.trees[0][1] - (60 - dy)) < 0.02);
  assert.ok(Math.abs(moved.scenery.water[0].poly[2][1] - (50 - dy)) < 0.02);
  assert.ok(Math.abs(moved.aerial.bounds.minY - (-180 - dy)) < 0.02);
  assert.deepEqual(moved.aerial.classBounds, moved.aerial.bounds);
});

test('cloud scenery waits for an incomplete package; an unreachable cloud falls back per layer', async (t) => {
  const course = testCourse(66, { buildings: [], canopy: { trees: [[1, 1, 9, 2]] } });
  const partial = packageFor(testCourse(66), { aerial: false, complete: false });
  const finished = packageFor(course);
  const cloud = await startFakeCloud({ token: 'tok' });
  t.after(() => cloud.close());
  cloud.publish(partial);
  let polls = 0;
  const reports = [];
  const providers = cloudSceneryProviders({
    client: createCloudClient({ baseUrl: cloud.url, buildToken: 'tok' }),
    sleep: async () => { if (++polls === 2) cloud.publish(finished); },
    log: quiet,
  });
  const local = testCourse(66);
  const outcome = await enrichCourseScenery(local, {
    providers, log: quiet, onReport: (layer, message) => reports.push(message),
  });
  assert.deepEqual(outcome.applied, ['buildings', 'canopy', 'aerial']);
  assert.deepEqual(outcome.skipped, ['water'], 'this package predates nearby water and there is no fallback');
  assert.deepEqual(local.canopy.trees, [[1, 1, 9, 2]]);
  assert.ok(cloud.requests.includes('POST /v1/courses'), 'an incomplete package nudges a build');
  assert.ok(reports.includes('Waiting for the cloud to finish this course…'));

  const down = await startFakeCloud();
  await down.close();
  const used = [];
  const offline = cloudSceneryProviders({
    client: createCloudClient({ baseUrl: down.url, timeoutMs: 2000 }),
    fallback: {
      buildings: async () => { used.push('buildings'); return { status: 'ok', buildings: [] }; },
      water: async () => { used.push('water'); return { status: 'ok', water: [] }; },
      aerial: async () => { used.push('aerial'); return { status: 'none' }; },
    },
    log: quiet,
  });
  const lonely = testCourse(67);
  const result = await enrichCourseScenery(lonely, { providers: offline, log: quiet });
  assert.deepEqual(used, ['buildings', 'water', 'aerial']);
  assert.deepEqual(result.skipped, ['canopy'], 'no canopy without the cloud on a cloud desktop');
});

test('server: with BIRDIE_CLOUD_URL a picked course comes from the cloud and is tracked by the cache', async (t) => {
  const course = testCourse(31337);
  const cloud = await startFakeCloud();
  t.after(() => cloud.close());
  cloud.publish(packageFor(course));
  Object.assign(process.env, {
    BIRDIE_PORT: '0', BIRDIE_OC_PORT: '0', BIRDIE_NO_AUTOLOAD: '1', BIRDIE_NO_WATCH: '1', BIRDIE_ENRICH: '0',
    BIRDIE_ART_DIR: path.join(SERVER_DATA, 'missing-art'), BIRDIE_CLOUD_URL: cloud.url,
  });
  const server = require('../server.js');
  t.after(() => server.close());
  const { httpPort } = await server.ready;
  const response = await fetch(`http://127.0.0.1:${httpPort}/api/load-course`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Cloud Links 31337', osmType: 'way', osmId: 31337, bbox: [44.9, 45.1, -93.1, -92.9] }),
  });
  const body = await response.json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.courseId, 'osm:way:31337');
  const geometry = await (await fetch(`http://127.0.0.1:${httpPort}/api/course-geometry`)).json();
  assert.equal(geometry.name, 'Cloud Links 31337');
  assert.deepEqual(geometry.aerial.bounds, { minX: -80, minY: -180, maxX: 70, maxY: 70 });
  const aerial = await fetch(`http://127.0.0.1:${httpPort}/api/course-aerial`);
  assert.equal(aerial.status, 200);
  const index = JSON.parse(fs.readFileSync(path.join(SERVER_DATA, 'course-cache.json'), 'utf8'));
  assert.equal(index.entries['osm-way-31337'].origin, 'cloud');
  assert.ok(cloud.requests.includes('GET /v1/courses/osm-way-31337'));
});
