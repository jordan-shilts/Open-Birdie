'use strict';
// The cloud course service (cloud/): SigV4 against AWS's published examples, the
// S3 client against a signature-checking fake S3, the job queue, the HTTP API with
// the real builder (fake course loader + scenery providers), and the desktop client
// end to end. No network.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STAGING = fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-cloud-staging-'));
process.env.BIRDIE_DATA_DIR = STAGING; // lib/course.js fixes its cache dir at first require

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

const { EMPTY_SHA256, createS3Client, presignUrl, signRequest, uriEncode } = require('../cloud/s3');
const { createFsStore, createS3Store, manifestKey } = require('../cloud/store');
const { createJobQueue, describeFailure } = require('../cloud/jobs');
const { createCourseBuilder } = require('../cloud/builder');
const { startCloudServer } = require('../cloud/server');
const { createCloudClient, createCloudCourseSource, cloudSceneryProviders } = require('../lib/cloud-client');
const { CourseLoadError } = require('../lib/course');
const { enrichCourseScenery } = require('../lib/course-enrichment');
const { testCourse, tempDir } = require('./cloud-test-support');

const quiet = { log() {}, warn() {}, error() {} };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------
// SigV4: AWS's published examples
// ---------------------------------------------------------------------------
test('SigV4 matches the AWS Signature Version 4 test suite (get-vanilla, header and presigned)', () => {
  const creds = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'service',
    date: new Date('2015-08-30T12:36:00Z'),
  };
  const header = signRequest({ method: 'GET', url: 'https://example.amazonaws.com/', ...creds });
  assert.equal(header.canonicalRequest, [
    'GET', '/', '', 'host:example.amazonaws.com', 'x-amz-date:20150830T123600Z', '', 'host;x-amz-date',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n'));
  assert.equal(header.stringToSign, [
    'AWS4-HMAC-SHA256', '20150830T123600Z', '20150830/us-east-1/service/aws4_request',
    'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
  ].join('\n'));
  assert.equal(header.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(header.headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, ' +
    'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  const query = presignUrl({ method: 'GET', url: 'https://example.amazonaws.com/', expiresSec: 3600, payloadHash: EMPTY_SHA256, ...creds });
  assert.equal(query.signature, 'e93c787ed7f371d5c6b165c1b38ede9550f4dce4144713e844b25b7192d3865d');
  assert.match(query.url, /X-Amz-Credential=AKIDEXAMPLE%2F20150830%2Fus-east-1%2Fservice%2Faws4_request/);
});

test('SigV4 matches the Amazon S3 API reference examples (GET Object with Range, presigned GET)', () => {
  const s3 = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
    date: new Date('2013-05-24T00:00:00Z'),
  };
  const get = signRequest({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: { range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256 },
    payloadHash: EMPTY_SHA256,
    ...s3,
  });
  assert.equal(get.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(get.headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
  const presigned = presignUrl({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', expiresSec: 86400, ...s3 });
  assert.equal(presigned.signature, 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('uriEncode and object URLs: virtual-hosted by default, path style when asked or when the endpoint has a path', () => {
  assert.equal(uriEncode('a b/c~d*'), 'a%20b%2Fc~d%2A');
  assert.equal(uriEncode('courses/osm-way-1/blobs/x', { keepSlash: true }), 'courses/osm-way-1/blobs/x');
  const base = { bucket: 'birdie-abc', accessKeyId: 'k', secretAccessKey: 's' };
  assert.equal(createS3Client({ ...base, endpoint: 'https://t3.storageapi.dev' }).objectUrl('courses/osm-way-1/manifest.json'),
    'https://birdie-abc.t3.storageapi.dev/courses/osm-way-1/manifest.json');
  assert.equal(createS3Client({ ...base, endpoint: 'http://minio:9000', forcePathStyle: true }).objectUrl('a/b'),
    'http://minio:9000/birdie-abc/a/b');
  assert.equal(createS3Client({ ...base, endpoint: 'https://p.supabase.co/storage/v1/s3' }).objectUrl('a/b'),
    'https://p.supabase.co/storage/v1/s3/birdie-abc/a/b');
});

// ---------------------------------------------------------------------------
// A fake S3 that checks every signature by recomputing it from what arrived
// ---------------------------------------------------------------------------
async function startFakeS3({ accessKeyId = 'AKTEST', secretAccessKey = 'sekret', region = 'auto', bucket = 'birdie' } = {}) {
  const objects = new Map();
  const log = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const fail = (status, code) => { res.writeHead(status, { 'Content-Type': 'application/xml' }); res.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`); };
    const prefix = `/${bucket}/`;
    if (!url.pathname.startsWith(prefix)) return fail(404, 'NoSuchBucket');
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    if (url.searchParams.has('X-Amz-Signature')) {
      const date = url.searchParams.get('X-Amz-Date');
      const when = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
      const bare = new URL(url);
      for (const k of [...bare.searchParams.keys()]) if (k.startsWith('X-Amz-')) bare.searchParams.delete(k);
      const expected = presignUrl({ method: req.method, url: bare.href, accessKeyId, secretAccessKey, region, date: when, expiresSec: Number(url.searchParams.get('X-Amz-Expires')) });
      if (expected.signature !== url.searchParams.get('X-Amz-Signature')) return fail(403, 'SignatureDoesNotMatch');
    } else {
      const auth = String(req.headers.authorization || '');
      const signedNames = (/SignedHeaders=([^,]+)/.exec(auth) || [])[1] || '';
      const amz = req.headers['x-amz-date'] || '';
      const when = new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`);
      const headers = {};
      for (const name of signedNames.split(';')) if (name && name !== 'host' && name !== 'x-amz-date') headers[name] = req.headers[name];
      const payloadHash = req.headers['x-amz-content-sha256'];
      if (payloadHash !== sha256(body)) return fail(400, 'XAmzContentSHA256Mismatch');
      const expected = signRequest({ method: req.method, url: url.href, headers, payloadHash, accessKeyId, secretAccessKey, region, date: when });
      if (expected.headers.authorization !== auth) return fail(403, 'SignatureDoesNotMatch');
    }
    log.push(`${req.method} ${key}`);
    if (req.method === 'PUT') {
      objects.set(key, { body, type: req.headers['content-type'] || 'application/octet-stream' });
      res.writeHead(200); return res.end();
    }
    const obj = objects.get(key);
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
    if (!obj) return fail(404, 'NoSuchKey');
    res.writeHead(200, { 'Content-Type': obj.type, 'Content-Length': obj.body.length, ETag: `"${sha256(obj.body).slice(0, 32)}"` });
    return res.end(req.method === 'HEAD' ? undefined : obj.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint, objects, log, bucket, accessKeyId, secretAccessKey, region,
    client: (overrides = {}) => createS3Client({ endpoint, bucket, region, accessKeyId, secretAccessKey, forcePathStyle: true, ...overrides }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('S3 client: signed PUT/GET/HEAD/DELETE accepted by a verifying server; wrong secret refused', async (t) => {
  const s3 = await startFakeS3();
  t.after(() => s3.close());
  const client = s3.client();
  await client.putObject('courses/osm-way-1/manifest.json', Buffer.from('{"a":1}'), { contentType: 'application/json' });
  assert.deepEqual(JSON.parse(await client.getObject('courses/osm-way-1/manifest.json')), { a: 1 });
  assert.equal((await client.headObject('courses/osm-way-1/manifest.json')).size, 7);
  assert.equal(await client.getObject('courses/osm-way-1/nope'), null);
  assert.equal(await client.headObject('courses/osm-way-1/nope'), null);
  await client.deleteObject('courses/osm-way-1/manifest.json');
  assert.equal(await client.getObject('courses/osm-way-1/manifest.json'), null);
  await assert.rejects(s3.client({ secretAccessKey: 'wrong' }).putObject('x', Buffer.from('y')), { code: 'SignatureDoesNotMatch' });
  // presigned GET works for a client holding no credentials
  await client.putObject('courses/osm-way-1/blobs/abc', Buffer.from('bytes!'));
  const url = client.presignGetObject('courses/osm-way-1/blobs/abc', { expiresSec: 60 });
  assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKTEST%2F\d{8}%2Fauto%2Fs3%2Faws4_request/);
  assert.equal(await (await fetch(url)).text(), 'bytes!');
  const forged = url.replace(/X-Amz-Expires=60/, 'X-Amz-Expires=600');
  assert.equal((await fetch(forged)).status, 403);
});

test('object stores: same layout in a directory or a bucket; keys outside the layout are refused', async (t) => {
  const s3 = await startFakeS3();
  t.after(() => s3.close());
  const sha = 'a'.repeat(64);
  for (const store of [createFsStore(tempDir('birdie-store-')), createS3Store(s3.client())]) {
    assert.equal(await store.getJson(manifestKey('osm-way-9')), null);
    await store.putJson(manifestKey('osm-way-9'), { hello: 'world' });
    assert.deepEqual(await store.getJson(manifestKey('osm-way-9')), { hello: 'world' });
    assert.equal(await store.hasBlob(`courses/osm-way-9/blobs/${sha}`), false);
    await store.putBlob(`courses/osm-way-9/blobs/${sha}`, Buffer.from('blob'), { contentType: 'image/png' });
    assert.equal(await store.hasBlob(`courses/osm-way-9/blobs/${sha}`), true);
    assert.equal((await store.readBlob(`courses/osm-way-9/blobs/${sha}`)).toString(), 'blob');
    await assert.rejects(store.getJson('courses/../../etc/passwd'), /unexpected object key/);
    await assert.rejects(store.putBlob('courses/osm-way-9/blobs/../x', Buffer.from('x')), /unexpected object key/);
  }
  assert.ok(s3.objects.has(`courses/osm-way-9/blobs/${sha}`));
  assert.equal(s3.objects.get(`courses/osm-way-9/blobs/${sha}`).type, 'image/png');
});

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------
test('job queue: one build per course, bounded waiting list, player-facing errors only', async () => {
  const release = [];
  const queue = createJobQueue({ run: () => new Promise((resolve) => release.push(resolve)), concurrency: 1, maxQueued: 1, log: quiet });
  const a = queue.submit('osm-way-1', { courseId: 'osm:way:1' });
  assert.equal(a.created, true);
  assert.equal(queue.submit('osm-way-1', {}).job.id, a.job.id, 'same course joins the running build');
  assert.equal(queue.get(a.job.id).status, 'running');
  const b = queue.submit('osm-way-2', {});
  assert.equal(b.job.status, 'queued');
  assert.throws(() => queue.submit('osm-way-3', {}), { code: 'QUEUE_FULL' });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  await tick(); // builds start on the next microtask
  release.shift()();
  await tick();
  assert.equal(queue.get(a.job.id).status, 'done');
  assert.equal(queue.get(b.job.id).status, 'running', 'next build starts');
  await tick();
  release.shift()();
  await queue.idle();
  assert.equal(queue.get(b.job.id).status, 'done');
  assert.deepEqual(describeFailure(new CourseLoadError('COURSE_NOT_PLAYABLE', 'No hole lines.', 'Try another.')),
    { code: 'COURSE_NOT_PLAYABLE', message: 'No hole lines.', userFacing: true, recovery: 'Try another.' });
  assert.deepEqual(describeFailure(new Error('ENOSPC /tmp/x')), { code: 'BUILD_FAILED', message: 'The course could not be built.', userFacing: false });
});

// ---------------------------------------------------------------------------
// the service, with the real builder
// ---------------------------------------------------------------------------
// A course loader that "builds" the course into the staging cache like loadCourse,
// and scenery providers that wait for `gate` so a test can see the base package.
function fakePipeline() {
  const loads = [];
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const loadCourse = async (request, { source }) => {
    loads.push(source.courseId);
    if (source.osmId === 13) throw new CourseLoadError('COURSE_NOT_GOLF_COURSE', '"Hut" (OSM way 13) is mapped as building=hut, not as a golf course.', 'Pick a golf course.');
    const course = testCourse(source.osmId, { name: request.name || `Course ${source.osmId}` });
    const key = `osm-${source.osmType}-${source.osmId}`;
    const jpg = crypto.randomBytes(3000); jpg[0] = 0xff; jpg[1] = 0xd8;
    fs.mkdirSync(path.join(STAGING, 'courses'), { recursive: true });
    fs.writeFileSync(path.join(STAGING, 'courses', `${key}.aerial.jpg`), jpg);
    course.aerial = { file: `${key}.aerial.jpg`, bounds: { minX: -80, minY: -180, maxX: 70, maxY: 70 } };
    fs.writeFileSync(path.join(STAGING, 'courses', `${key}.json`), JSON.stringify(course));
    return course;
  };
  const tiled = crypto.randomBytes(6000); tiled[0] = 0xff; tiled[1] = 0xd8;
  const providers = {
    buildings: async () => { await gate; return { status: 'ok', buildings: [{ poly: [[1, 1], [2, 1], [2, 2]], heightM: 5, clubhouse: true }] }; },
    water: async () => ({ status: 'ok', water: [{ kind: 'water', poly: [[30, 30], [50, 30], [50, 45]], name: 'Lake Test' }] }),
    canopy: async () => ({ status: 'ok', canopy: { source: 'test', trees: [[3, 3, 10, 2], [4, 4, 12, 3]] } }),
    aerial: async () => ({ status: 'ok', buf: tiled, bounds: { minX: -80, minY: -180, maxX: 70, maxY: 70 }, quality: 'tiled' }),
  };
  return { loads, loadCourse, providers, open: () => open(), tiled };
}

async function startService({ store = createFsStore(tempDir('birdie-store-')), token = 'tok', pipeline = fakePipeline(), env = {}, port = 0, hd = null } = {}) {
  const build = createCourseBuilder({ dataDir: STAGING, store, loadCourse: (...args) => pipeline.loadCourse(...args), providers: pipeline.providers, hd, log: quiet });
  const running = await startCloudServer({
    env: { BIRDIE_CLOUD_BUILD_TOKEN: token || '', ...env }, port, host: '127.0.0.1', store, build, log: quiet,
  });
  const base = `http://127.0.0.1:${running.port}`;
  const api = async (method, p, { body, auth = token } = {}) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = null; }
    return { status: res.status, json, headers: res.headers };
  };
  return { ...running, base, api, store, pipeline };
}

async function waitFor(check, { tries = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}

test('service: token-gated builds publish a playable package first, then the complete one', async (t) => {
  const svc = await startService();
  t.after(() => svc.close());
  assert.deepEqual((await svc.api('GET', '/healthz')).json.store, 'fs');
  assert.equal((await svc.api('GET', '/v1/courses/osm-way-77')).status, 404);
  assert.equal((await svc.api('GET', '/v1/courses/osm-lake-1')).status, 400);
  assert.equal((await svc.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 77 } }, auth: null })).status, 401);
  assert.equal((await svc.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 77 } }, auth: 'nope' })).status, 401);
  assert.equal((await svc.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 77 }, bbox: [0, 10, 0, 10] } })).status, 400);

  const queued = await svc.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 77 }, name: 'Cloud Links 77' } });
  assert.equal(queued.status, 202);
  const jobId = queued.json.job.id;
  assert.equal((await svc.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 77 } } })).json.job.id, jobId, 'one build per course');

  // base package published while scenery is still running
  const playable = await waitFor(async () => {
    const job = (await svc.api('GET', `/v1/jobs/${jobId}`)).json;
    return job.packageId ? job : null;
  });
  assert.equal(playable.status, 'running');
  assert.equal(playable.complete, false);
  const base = (await svc.api('GET', '/v1/courses/osm-way-77')).json;
  assert.equal(base.complete, false);
  assert.equal(base.packageId, playable.packageId);
  assert.equal(base.scenery.buildings, null);

  svc.pipeline.open();
  const done = await waitFor(async () => {
    const job = (await svc.api('GET', `/v1/jobs/${jobId}`)).json;
    return job.status === 'done' ? job : null;
  });
  assert.equal(done.complete, true);
  const final = (await svc.api('GET', '/v1/courses/osm:way:77')).json;
  assert.equal(final.complete, true);
  assert.deepEqual(final.scenery, { buildings: 1, water: 1, canopyTrees: 2, aerial: 'tiled', classmap: false, failed: [] });
  assert.deepEqual(svc.pipeline.loads, ['osm:way:77']);
  assert.equal(fs.existsSync(path.join(STAGING, 'courses', 'osm-way-77.json')), false, 'staging cleaned up');

  // files are served by content hash
  const aerial = final.files.find((f) => f.role === 'aerial');
  const res = await fetch(`${svc.base}/v1/courses/osm-way-77/files/${aerial.sha256}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(sha256(bytes), aerial.sha256);
  assert.deepEqual(bytes, svc.pipeline.tiled);
  assert.equal((await fetch(`${svc.base}/v1/courses/osm-way-77/files/${'0'.repeat(64)}`)).status, 404);

  const again = await svc.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 77 } } });
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'ready');
  assert.equal((await svc.api('GET', '/v1/jobs/not-a-job')).status, 404);
});

test('service: no token configured means read-only; a full queue answers 429', async (t) => {
  const readOnly = await startService({ token: null });
  t.after(() => readOnly.close());
  assert.equal((await readOnly.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 1 } }, auth: 'x' })).status, 503);
  const busy = await startService({ env: { BIRDIE_CLOUD_MAX_QUEUE: '1' } });
  t.after(() => { busy.pipeline.open(); return busy.close(); });
  for (const id of [101, 102]) {
    assert.equal((await busy.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: id } } })).status, 202);
  }
  assert.equal((await busy.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 103 } } })).status, 429);
});

test('service on S3: files redirect to presigned URLs the desktop follows; integrity still checked', async (t) => {
  const s3 = await startFakeS3();
  t.after(() => s3.close());
  const svc = await startService({ store: createS3Store(s3.client()) });
  t.after(() => svc.close());
  svc.pipeline.open();
  const queued = await svc.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 55 } } });
  await waitFor(async () => (await svc.api('GET', `/v1/jobs/${queued.json.job.id}`)).json.status === 'done');
  const manifest = (await svc.api('GET', '/v1/courses/osm-way-55')).json;
  const file = manifest.files[0];
  const redirect = await svc.api('GET', `/v1/courses/osm-way-55/files/${file.sha256}`);
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.get('location'), new RegExp(`^${s3.endpoint}/birdie/courses/osm-way-55/blobs/${file.sha256}\\?X-Amz-Algorithm=`));
  const desk = tempDir('birdie-desk-');
  const source = createCloudCourseSource({ client: createCloudClient({ baseUrl: svc.base }), dataDir: desk, log: quiet });
  const course = await source.acquire({ source: { courseId: 'osm:way:55', osmType: 'way', osmId: 55 } });
  assert.equal(course.name, 'Course 55');
  assert.equal(course.aerial.quality, 'tiled');
  assert.ok(s3.log.some((line) => line.startsWith('GET courses/osm-way-55/blobs/')), 'bytes came from the bucket');
});

test('end to end: the desktop plays the base package, then the cloud scenery arrives', async (t) => {
  const svc = await startService({ token: 'desk-token' });
  t.after(() => svc.close());
  const client = createCloudClient({ baseUrl: svc.base, buildToken: 'desk-token' });
  const desk = tempDir('birdie-desk-');
  const progress = [];
  const source = createCloudCourseSource({ client, dataDir: desk, pollMs: 10, log: quiet, onProgress: (p) => progress.push(p) });
  const course = await source.acquire({
    request: { name: 'Cloud Links 4', bbox: [44.99, 45.01, -93.01, -92.99] },
    source: { courseId: 'osm:way:4', osmType: 'way', osmId: 4 },
  });
  assert.equal(course.name, 'Cloud Links 4', 'playable before its scenery exists');
  assert.equal(course.buildings, undefined);
  assert.ok(progress.some((p) => p.stage === 'build'));

  assert.notEqual(course.aerial.quality, 'tiled', 'the base package has the quick single-request aerial');

  // the desktop's background scenery waits for the cloud to finish, then swaps in
  // the cloud's tiled aerial (cloud desktops ask for the tiled tier)
  const providers = cloudSceneryProviders({ client, pollMs: 10, log: quiet });
  const enriching = enrichCourseScenery(course, { providers, aerialQuality: 'tiled', log: quiet });
  setTimeout(() => svc.pipeline.open(), 50);
  const outcome = await enriching;
  assert.deepEqual(outcome.applied, ['buildings', 'water', 'canopy', 'aerial']);
  assert.equal(course.scenery.water[0].name, 'Lake Test');
  assert.equal(course.canopy.trees.length, 2);
  assert.equal(course.aerial.quality, 'tiled');
  assert.equal(course.aerial.file, 'osm-way-4.aerial.jpg');

  // nothing better in the cloud: an existing aerial is kept, not re-fetched
  const again = await enrichCourseScenery(course, { providers: cloudSceneryProviders({ client, log: quiet }), aerialQuality: 'tiled', log: quiet });
  assert.deepEqual(again, { applied: [], none: [], skipped: [], failed: [] });
});

test('end to end: a course the cloud proves is not a golf course fails the pick with that reason', async (t) => {
  const svc = await startService();
  t.after(() => svc.close());
  const source = createCloudCourseSource({
    client: createCloudClient({ baseUrl: svc.base, buildToken: 'tok' }), dataDir: tempDir('birdie-desk-'), pollMs: 10, log: quiet,
  });
  await assert.rejects(source.acquire({ source: { courseId: 'osm:way:13', osmType: 'way', osmId: 13 } }), (error) => {
    assert.equal(error.code, 'COURSE_NOT_GOLF_COURSE');
    assert.match(error.message, /not as a golf course/);
    return true;
  });
});

test('a build whose staging is gone resumes from the published package; failed layers are retried later', async (t) => {
  const store = createFsStore(tempDir('birdie-store-'));
  const first = fakePipeline();
  const svc = await startService({ store, pipeline: first });
  t.after(() => svc.close());
  const job = (await svc.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 21 } } })).json.job;
  await waitFor(async () => (await svc.api('GET', `/v1/jobs/${job.id}`)).json.packageId);
  svc.queue.close(); // the service "restarts" before the scenery is added
  first.open();
  await svc.queue.idle();
  fs.rmSync(path.join(STAGING, 'courses', 'osm-way-21.json'), { force: true });
  const base = await store.getJson(manifestKey('osm-way-21'));
  assert.equal(base.complete, false);

  const second = fakePipeline();
  second.providers.canopy = async () => { throw new Error('S3 reset by peer'); };
  second.open();
  const restarted = await startService({ store, pipeline: second });
  t.after(() => restarted.close());
  const resumed = (await restarted.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 21 } } })).json.job;
  await waitFor(async () => (await restarted.api('GET', `/v1/jobs/${resumed.id}`)).json.status === 'done');
  assert.deepEqual(second.loads, [], 'resumed from the package, no rebuild of the base data');
  const final = await store.getJson(manifestKey('osm-way-21'));
  assert.equal(final.complete, true);
  assert.deepEqual(final.scenery.failed, ['canopy']);
  assert.equal((await restarted.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 21 } } })).json.status, 'ready', 'fresh: not retried yet');
  await store.putJson(manifestKey('osm-way-21'), { ...final, createdAt: '2020-01-01T00:00:00.000Z' });
  assert.equal((await restarted.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 21 } } })).status, 202, 'an hour later the failed layer is retried');
});

test('a complete package from before a scenery layer existed is upgraded on the next request', async (t) => {
  const store = createFsStore(tempDir('birdie-store-'));
  const pipeline = fakePipeline();
  pipeline.open();
  const svc = await startService({ store, pipeline });
  t.after(() => svc.close());
  const job = (await svc.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 23 } } })).json.job;
  await waitFor(async () => (await svc.api('GET', `/v1/jobs/${job.id}`)).json.status === 'done');
  const current = await store.getJson(manifestKey('osm-way-23'));
  const { water, ...older } = current.scenery;
  await store.putJson(manifestKey('osm-way-23'), { ...current, scenery: older });
  assert.equal((await svc.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 23 } } })).status, 202);
});

test('HD holes: built after the complete package is out; packages say what is planned and missing; upgrades on request', async (t) => {
  const store = createFsStore(tempDir('birdie-store-'));
  const pipeline = fakePipeline();
  pipeline.open();
  const calls = [];
  const hd = {
    // a reviewed manifest for hole 4, hole 7 auto-pinned
    plan: (course) => (course.source.courseId === 'osm:way:31' ? [{ hole: 4, manifest: { hole: 4 } }, { hole: 7, manifest: null }] : []),
    async build({ course, entries, onHole, onBuilt }) {
      entries.forEach((e, i) => onHole(e.hole, i, entries.length));
      const published = await store.getJson(manifestKey('osm-way-31'));
      await onBuilt({ hole: 4, bundleId: 'x' });   // hole 4 lands before hole 7 is tried
      const afterFirst = await store.getJson(manifestKey('osm-way-31'));
      calls.push({ courseId: course.source.courseId, holes: entries.map((e) => e.hole), buildings: (course.buildings || []).length, published, afterFirst });
      return { built: [{ hole: 4, bundleId: 'x' }], failed: [{ hole: 7, code: 'HD_3DEP_HTTP', message: 'image HTTP 502' }] };
    },
  };
  const svc = await startService({ store, pipeline, hd });
  t.after(() => svc.close());
  const job = (await svc.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 31 } } })).json.job;
  await waitFor(async () => (await svc.api('GET', `/v1/jobs/${job.id}`)).json.status === 'done');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].holes, [4, 7]);
  assert.equal(calls[0].buildings, 1, 'with the scenery already on the course');
  assert.equal(calls[0].published.complete, true, 'the complete package was out before the HD holes started');
  assert.deepEqual(calls[0].published.hdMissing, [{ hole: 4, code: 'HD_PENDING' }, { hole: 7, code: 'HD_PENDING' }]);
  assert.deepEqual(calls[0].afterFirst.hdMissing, [{ hole: 7, code: 'HD_PENDING' }], 'hole 4 was published the moment it landed');
  assert.deepEqual((await svc.api('GET', `/v1/jobs/${job.id}`)).json.hd, {
    built: [4], skipped: [{ hole: 7, code: 'HD_3DEP_HTTP', message: 'image HTTP 502' }], packaged: [],
  }, 'the job says what was built and skipped (the fake builds no real bundles)');
  const final = await store.getJson(manifestKey('osm-way-31'));
  assert.deepEqual(final.hdPlanned, [4, 7]);
  assert.deepEqual(final.hdMissing.map((m) => [m.hole, m.code]), [[7, 'HD_3DEP_HTTP']], 'the package says which planned holes it lacks, and why');
  // nothing planned: no HD step, and the package says so
  const other = (await svc.api('POST', '/v1/courses', { body: { source: { osmType: 'way', osmId: 32 } } })).json.job;
  await waitFor(async () => (await svc.api('GET', `/v1/jobs/${other.id}`)).json.status === 'done');
  assert.equal(calls.length, 1);
  assert.deepEqual((await store.getJson(manifestKey('osm-way-32'))).hdPlanned, []);
  // way 32's complete package carries no HD holes: ready, unless the caller says it should
  const plain = { body: { source: { osmType: 'way', osmId: 32 } } };
  assert.equal((await svc.api('POST', '/v1/courses', plain)).json.status, 'ready');
  assert.equal((await svc.api('POST', '/v1/courses', { body: { ...plain.body, hd: true } })).json.status, 'ready', 'already planned');
  assert.equal((await svc.api('POST', '/v1/courses', { body: { ...plain.body, hd: [0] } })).status, 400);
  assert.equal((await svc.api('POST', '/v1/courses', { body: { ...plain.body, hd: [] } })).json.status, 'ready', 'no holes asked, nothing missing');
  const upgrade = await svc.api('POST', '/v1/courses', { body: { ...plain.body, hd: [4, 7] } });
  assert.equal(upgrade.status, 202, 'an HD upgrade is a build');
  await waitFor(async () => (await svc.api('GET', `/v1/jobs/${upgrade.json.job.id}`)).json.status === 'done');
  assert.equal(pipeline.loads.filter((id) => id === 'osm:way:32').length, 1, 'the upgrade resumed from the package, not from OSM');
  // a package from before HD planning gets planned when asked
  const before = await store.getJson(manifestKey('osm-way-32'));
  const { hdPlanned, hdMissing, ...older } = before;
  await store.putJson(manifestKey('osm-way-32'), older);
  assert.equal((await svc.api('POST', '/v1/courses', { body: { ...plain.body, hd: true } })).status, 202);
});

test('the HD plan: reviewed manifests first, then every other hole 1-18 of a US course; none without the tools', () => {
  const { hdPlanFor, inConus } = require('../cloud/hd-holes');
  const dir = tempDir('birdie-hd-plan-');
  fs.writeFileSync(path.join(dir, 'm-hole-02.json'), JSON.stringify({ course: { courseId: 'osm:way:5' }, hole: 2 }));
  const tools = tempDir('birdie-hd-tools-');
  fs.writeFileSync(path.join(tools, 'cli.mjs'), '');
  const holes = [1, 2, 3, 3, null, 19].map((ref) => ({ ref }));
  const us = { source: { courseId: 'osm:way:5' }, origin: { lat: 44.8, lon: -93.6 }, holes };
  const plan = hdPlanFor(us, { dir, toolsDir: tools, auto: true });
  assert.deepEqual(plan.map((e) => [e.hole, Boolean(e.manifest)]), [[1, false], [2, true]], 'hole 3 twice (ambiguous), no ref and 19 are left out');
  assert.deepEqual(hdPlanFor(us, { dir, toolsDir: tools, auto: false }).map((e) => e.hole), [2], 'auto off: reviewed manifests only');
  const scotland = { ...us, origin: { lat: 56.34, lon: -2.8 } };
  assert.equal(inConus(scotland), false);
  assert.deepEqual(hdPlanFor(scotland, { dir, toolsDir: tools }).map((e) => e.hole), [2]);
  assert.deepEqual(hdPlanFor(us, { dir, toolsDir: path.join(tools, 'missing') }), [], 'no HD tools deployed: no HD');
});

test('the HD step pins auto holes, falls back to coarser lidar, skips a hole that fails and stops when out of time', async () => {
  const { buildHdHoles, hdManifestsFor } = require('../cloud/hd-holes');
  const dir = tempDir('birdie-hd-manifests-');
  const write = (name, m) => fs.writeFileSync(path.join(dir, name), JSON.stringify(m));
  write('b-hole-02.json', { course: { courseId: 'osm:way:5' }, hole: 2 });
  write('a-hole-09.json', { course: { courseId: 'osm:way:5' }, hole: 9 });
  write('other.json', { course: { courseId: 'osm:way:6' }, hole: 1 });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
  assert.deepEqual(hdManifestsFor('osm:way:5', { dir }).map((m) => m.hole), [2, 9]);
  assert.deepEqual(hdManifestsFor('osm:way:5', { dir: path.join(dir, 'missing') }), []);

  const warnings = [];
  const pins = [];
  const tools = {
    coarseTerrain: { targetSpacingM: 3, crs: 'EPSG:3857' },
    pinHole: async ({ hole, terrain }) => { pins.push([hole, terrain ? 'coarse' : '1 m']); return { hole, auto: true, terrain: terrain || { targetSpacingM: 1 } }; },
    buildHole: async ({ manifest }) => {
      if (manifest.hole === 2) throw Object.assign(new Error('tile replaced'), { code: 'HD_COG_DRIFT' });
      if (manifest.hole === 4 && manifest.terrain.targetSpacingM === 1) throw Object.assign(new Error('coarse'), { code: 'HD_3DEP_COARSE' });
      return { bundleId: `b${manifest.hole}` };
    },
  };
  const out = await buildHdHoles({
    course: {},
    entries: [{ hole: 1, manifest: { hole: 1 } }, { hole: 2, manifest: { hole: 2 } }, { hole: 3, manifest: null }, { hole: 4, manifest: null }],
    log: { warn: (m) => warnings.push(m) },
    tools,
  });
  assert.deepEqual(out.built, [{ hole: 1, bundleId: 'b1' }, { hole: 3, bundleId: 'b3' }, { hole: 4, bundleId: 'b4' }]);
  assert.deepEqual(out.failed.map((f) => [f.hole, f.code]), [[2, 'HD_COG_DRIFT']]);
  assert.deepEqual(pins, [[3, '1 m'], [4, '1 m'], [4, 'coarse']], 'auto holes pinned; hole 4 again on coarser lidar');
  assert.equal(warnings.length, 1);

  let t = 0;
  const timed = await buildHdHoles({
    course: {}, entries: [{ hole: 1, manifest: { hole: 1 } }, { hole: 2, manifest: { hole: 2 } }], log: quiet, budgetMs: 100, now: () => t,
    tools: { ...tools, buildHole: async () => { t += 150; return { bundleId: 'b' }; } },
  });
  assert.deepEqual(timed.built.map((b) => b.hole), [1]);
  assert.deepEqual(timed.failed.map((f) => [f.hole, f.code]), [[2, 'HD_TIME_BUDGET']]);
});

test('each HD hole is published as it lands; a hole that hangs or dies costs only itself', async () => {
  const { buildHdHoles, runHoleInChild } = require('../cloud/hd-holes');
  // onBuilt runs after each built hole, before the next one starts
  const order = [];
  const tools = {
    coarseTerrain: {},
    pinHole: async ({ hole }) => ({ hole }),
    buildHole: async ({ manifest }) => {
      order.push(`build ${manifest.hole}`);
      if (manifest.hole === 2) throw Object.assign(new Error('image HTTP 502'), { code: 'HD_3DEP_HTTP' });
      return { bundleId: `b${manifest.hole}` };
    },
  };
  const out = await buildHdHoles({
    course: {}, entries: [1, 2, 3].map((hole) => ({ hole, manifest: { hole } })), log: quiet, tools,
    onBuilt: async ({ hole }) => { order.push(`publish ${hole}`); },
  });
  assert.deepEqual(order, ['build 1', 'publish 1', 'build 2', 'build 3', 'publish 3']);
  assert.deepEqual(out.failed.map((f) => f.code), ['HD_3DEP_HTTP']);

  // the child-process runner, with stand-in workers
  const dir = tempDir('birdie-hd-worker-');
  const worker = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };
  const ok = worker('ok.mjs', "process.once('message', (m) => process.send({ bundleId: `b${m.hole}` }, () => process.exit(0)));");
  const hangs = worker('hangs.mjs', "process.once('message', () => setInterval(() => {}, 1000));");
  const dies = worker('dies.mjs', "process.once('message', () => process.exit(137));");
  const fails = worker('fails.mjs', "process.once('message', () => process.send({ code: 'HD_NAIP_NO_COVERAGE', message: 'no imagery' }, () => process.exit(0)));");
  const job = { coursePath: path.join(dir, 'course.json'), hole: 5, manifest: null };
  assert.deepEqual(await runHoleInChild(job, { worker: ok }), { bundleId: 'b5' });
  await assert.rejects(runHoleInChild(job, { worker: hangs, timeoutMs: 300 }), (e) => e.code === 'HD_HOLE_TIMEOUT');
  await assert.rejects(runHoleInChild(job, { worker: dies }), (e) => e.code === 'HD_HOLE_CRASHED' && /exit 137/.test(e.message));
  await assert.rejects(runHoleInChild(job, { worker: fails }), (e) => e.code === 'HD_NAIP_NO_COVERAGE');

  // the default path: the course goes to a file once, each hole to runHole, and a stuck
  // hole is skipped with its code while the next one still builds
  const seen = [];
  const out2 = await buildHdHoles({
    course: { name: 'c' }, entries: [{ hole: 1, manifest: null }, { hole: 2, manifest: { hole: 2 } }], log: quiet,
    runHole: async ({ coursePath, hole, manifest }) => {
      seen.push([hole, JSON.parse(fs.readFileSync(coursePath, 'utf8')).name, manifest && manifest.hole]);
      if (hole === 1) throw Object.assign(new Error('stuck'), { code: 'HD_HOLE_TIMEOUT' });
      return { bundleId: 'b2' };
    },
  });
  assert.deepEqual(seen, [[1, 'c', null], [2, 'c', 2]]);
  assert.deepEqual(out2.built, [{ hole: 2, bundleId: 'b2' }]);
  assert.deepEqual(out2.failed.map((f) => [f.hole, f.code]), [[1, 'HD_HOLE_TIMEOUT']]);
});

test('a desktop rides out a cloud restart in the middle of a build', async (t) => {
  const store = createFsStore(tempDir('birdie-store-'));
  const stuck = fakePipeline();
  stuck.loadCourse = () => new Promise(() => {}); // the first instance never gets past the base data
  const first = await startService({ store, pipeline: stuck });
  const { port } = first;
  let second = null;
  t.after(() => second && second.close());
  let sleeps = 0;
  const sleep = async () => {
    sleeps++;
    if (sleeps === 2) await first.close(); // the service goes away mid-build ...
    if (sleeps === 3) { // ... and a new instance (same store) is up a moment later
      const fresh = fakePipeline();
      fresh.open();
      second = await startService({ store, pipeline: fresh, port });
    }
  };
  const progress = [];
  const source = createCloudCourseSource({
    client: createCloudClient({ baseUrl: `http://127.0.0.1:${port}`, buildToken: 'tok', timeoutMs: 2000 }),
    dataDir: tempDir('birdie-desk-'),
    sleep,
    pollMs: 1,
    log: quiet,
    onProgress: (p) => progress.push(p),
  });
  const course = await source.acquire({ source: { courseId: 'osm:way:61', osmType: 'way', osmId: 61 } });
  assert.equal(course.name, 'Course 61', 'installed from the restarted service');
  assert.ok(sleeps >= 3);
  assert.ok(!progress.some((p) => /on this computer/.test(p.message)), 'never fell back to a local build');
});
