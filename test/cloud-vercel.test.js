'use strict';
// The cloud service on Vercel: the Blob store (cloud/vercel-blob-store.js) and
// sandbox build jobs (cloud/sandbox-jobs.js), against in-memory stand-ins for
// @vercel/blob and @vercel/sandbox — no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const { createVercelBlobStore, jobKey, activeJobKey } = require('../cloud/vercel-blob-store');
const { createSandboxJobs, BUILD_SCRIPT } = require('../cloud/sandbox-jobs');
const { createCloudService } = require('../cloud/app');

const BASE = 'https://abc123.public.blob.vercel-storage.com/';
const KEY = 'osm-relation-9892305';
const SHA = 'a'.repeat(64);

function fakeBlob() {
  const objects = new Map();
  class BlobNotFoundError extends Error { constructor() { super('not found'); this.name = 'BlobNotFoundError'; } }
  const calls = [];
  return {
    objects, calls, BlobNotFoundError,
    async put(pathname, body, opts) {
      calls.push({ op: 'put', pathname, opts });
      objects.set(pathname, { bytes: Buffer.from(body), contentType: opts.contentType });
      return { url: BASE + pathname, pathname };
    },
    async head(pathname) {
      if (!objects.has(pathname)) throw new BlobNotFoundError();
      return { url: BASE + pathname, pathname };
    },
    async get(pathname, opts) {
      calls.push({ op: 'get', pathname, opts });
      const o = objects.get(pathname);
      return o ? { statusCode: 200, stream: Readable.from([o.bytes]), blob: { url: BASE + pathname } } : null;
    },
    async del(pathname) { objects.delete(pathname); },
  };
}

function fakeSandboxApi({ failCreate = false } = {}) {
  const created = [], stopped = [], commands = [];
  return {
    created, stopped, commands,
    async create(params) {
      if (failCreate) throw new Error('quota exceeded');
      created.push(params);
      return {
        name: params.name,
        async runCommand(cmd) { commands.push(cmd); return { cmdId: 'c1' }; },
        async stop() { stopped.push(params.name); },
      };
    },
    async get({ name }) { return { async stop() { stopped.push(name); } }; },
  };
}

test('the Blob store keeps manifests, files and job records, with public file URLs', async () => {
  const blob = fakeBlob();
  const store = createVercelBlobStore({ blob });
  const manifestKey = `courses/${KEY}/manifest.json`, fileKey = `courses/${KEY}/blobs/${SHA}`;
  assert.equal(await store.getJson(manifestKey), null);
  await store.putJson(manifestKey, { key: KEY, complete: true });
  assert.deepEqual(await store.getJson(manifestKey), { key: KEY, complete: true });
  assert.equal(await store.hasBlob(fileKey), false);
  assert.equal(await store.blobUrl(fileKey), null);
  await store.putBlob(fileKey, Buffer.from('hello'), { contentType: 'image/jpeg' });
  assert.equal(await store.hasBlob(fileKey), true);
  assert.equal((await store.readBlob(fileKey)).toString(), 'hello');
  assert.equal(await store.blobUrl(fileKey), BASE + fileKey);
  // manifests are read past the CDN and kept briefly; files are cached for good
  const put = (p) => blob.calls.find((c) => c.op === 'put' && c.pathname === p).opts;
  assert.equal(put(manifestKey).cacheControlMaxAge, 60);
  assert.ok(put(fileKey).cacheControlMaxAge >= 365 * 24 * 3600);
  assert.equal(put(fileKey).addRandomSuffix, false);
  assert.ok(blob.calls.some((c) => c.op === 'get' && c.pathname === manifestKey && c.opts.useCache === false));
  // job records have their own namespace; anything else is refused
  const id = '0f5c3a0e-6c1f-4a5e-9b33-1234567890ab';
  await store.putRecord(jobKey(id), { id, status: 'running' });
  assert.equal((await store.getRecord(jobKey(id))).status, 'running');
  await assert.rejects(store.putJson('courses/../secrets.json', {}), /unexpected object key/);
  await assert.rejects(store.putRecord('jobs/whatever.json', {}), /unexpected object key/);
});

test('a build gets its own sandbox running this repository, with the Blob credentials handed over', async () => {
  const store = createVercelBlobStore({ blob: fakeBlob() });
  const sandboxApi = fakeSandboxApi();
  const jobs = createSandboxJobs({
    store, sandboxApi, log: { error() {}, warn() {} },
    env: { BLOB_READ_WRITE_TOKEN: 'rw-token', BIRDIE_CLOUD_REF: 'feat/photoreal-pass', BIRDIE_OVERPASS_URLS: 'https://o.example/api/interpreter' },
  });
  const { job, created } = await jobs.submit(KEY, { key: KEY, courseId: 'osm:relation:9892305', request: {}, force: false });
  assert.equal(created, true);
  assert.equal(job.status, 'running');
  assert.equal(job.sandbox, undefined, 'internal fields stay out of the API');
  assert.equal(job.pollMs, 10_000, 'the desktop is asked to poll gently (each poll is a Blob read)');
  const [params] = sandboxApi.created;
  assert.equal(params.source, undefined, 'the build clones the repository itself, into a known folder');
  assert.equal(params.persistent, false);
  assert.equal(params.image, 'vercel/sandbox/node:22', 'a managed image (runtimes are deprecated)');
  assert.ok(params.timeout <= 45 * 60 * 1000, 'fits a Hobby sandbox session');
  const [cmd] = sandboxApi.commands;
  assert.equal(cmd.detached, true);
  assert.deepEqual(cmd.args, ['-c', BUILD_SCRIPT]);
  assert.equal(cmd.env.BLOB_READ_WRITE_TOKEN, 'rw-token');
  assert.equal(cmd.env.BIRDIE_REPO, 'https://github.com/jordan-shilts/Open-Birdie.git');
  assert.equal(cmd.env.BIRDIE_REF, 'feat/photoreal-pass');
  assert.match(BUILD_SCRIPT, /git clone .*"\$BIRDIE_REF" "\$BIRDIE_REPO" open-birdie\ncd open-birdie\n/);
  assert.equal(cmd.env.JOB_ID, job.id);
  assert.equal(cmd.env.BIRDIE_OVERPASS_URLS, 'https://o.example/api/interpreter');
  assert.deepEqual(JSON.parse(Buffer.from(cmd.env.BUILD_PAYLOAD, 'base64')), { key: KEY, courseId: 'osm:relation:9892305', request: {}, force: false });
  // a second request for the course joins the running build
  const again = await jobs.submit(KEY, { key: KEY });
  assert.equal(again.created, false);
  assert.equal(again.job.id, job.id);
  assert.equal(sandboxApi.created.length, 1);
  assert.equal((await jobs.activeFor(KEY)).id, job.id);
});

test('OIDC credentials are handed over when there is no read-write token', async () => {
  const store = createVercelBlobStore({ blob: fakeBlob() });
  const sandboxApi = fakeSandboxApi();
  const jobs = createSandboxJobs({ store, sandboxApi, env: { BLOB_STORE_ID: 'store_123' }, oidcToken: async () => 'oidc-jwt', log: { error() {}, warn() {} } });
  await jobs.submit(KEY, { key: KEY });
  assert.equal(sandboxApi.commands[0].env.VERCEL_OIDC_TOKEN, 'oidc-jwt');
  assert.equal(sandboxApi.commands[0].env.BLOB_STORE_ID, 'store_123');
});

test('a finished build stops its sandbox once; a silent one is marked failed', async () => {
  let t = Date.parse('2026-11-02T12:00:00Z');
  const store = createVercelBlobStore({ blob: fakeBlob() });
  const sandboxApi = fakeSandboxApi();
  const jobs = createSandboxJobs({ store, sandboxApi, env: { BLOB_READ_WRITE_TOKEN: 'x' }, now: () => t, log: { error() {}, warn() {} } });
  const { job } = await jobs.submit(KEY, { key: KEY });
  // the build (inside the sandbox) reports done
  const record = await store.getRecord(jobKey(job.id));
  await store.putRecord(jobKey(job.id), { ...record, status: 'done', pct: 100 });
  assert.equal((await jobs.get(job.id)).status, 'done');
  await jobs.get(job.id);
  assert.deepEqual(sandboxApi.stopped, [`birdie-build-${job.id.slice(0, 8)}`]);
  assert.equal(await jobs.activeFor(KEY), null);
  // a build that stops writing its record for 10 minutes has died
  const second = (await jobs.submit(KEY, { key: KEY })).job;
  t += 11 * 60 * 1000;
  const stale = await jobs.get(second.id);
  assert.equal(stale.status, 'failed');
  assert.match(stale.message, /stopped responding/);
  assert.equal(await jobs.get('not-a-job-id'), null);
});

test('a sandbox that cannot start fails the job at once', async () => {
  const store = createVercelBlobStore({ blob: fakeBlob() });
  const jobs = createSandboxJobs({ store, sandboxApi: fakeSandboxApi({ failCreate: true }), env: { BLOB_READ_WRITE_TOKEN: 'x' }, log: { error() {}, warn() {} } });
  const { job } = await jobs.submit(KEY, { key: KEY });
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'BUILD_FAILED');
});

test('the v1 API runs over the Blob store and sandbox jobs (async queue, redirects to Blob URLs)', async () => {
  const blob = fakeBlob();
  const store = createVercelBlobStore({ blob });
  const sandboxApi = fakeSandboxApi();
  const queue = createSandboxJobs({ store, sandboxApi, env: { BLOB_READ_WRITE_TOKEN: 'x' }, log: { error() {}, warn() {} } });
  const service = createCloudService({ store, queue, buildToken: 'secret', log: { log() {}, error() {}, warn() {} } });
  const server = http.createServer((req, res) => service.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const missing = await fetch(`${base}/v1/courses/${KEY}`);
    assert.equal(missing.status, 404);
    const started = await fetch(`${base}/v1/courses`, {
      method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { osmType: 'relation', osmId: 9892305 } }),
    });
    assert.equal(started.status, 202);
    const { job } = await started.json();
    assert.equal(job.status, 'running');
    const polled = await (await fetch(`${base}/v1/jobs/${job.id}`)).json();
    assert.equal(polled.id, job.id);
    const pending = await (await fetch(`${base}/v1/courses/${KEY}`)).json();
    assert.equal(pending.job.id, job.id, 'a course being built says so');
    await store.putBlob(`courses/${KEY}/blobs/${SHA}`, Buffer.from('jpeg'));
    const file = await fetch(`${base}/v1/courses/${KEY}/files/${SHA}`, { redirect: 'manual' });
    assert.equal(file.status, 302);
    assert.equal(file.headers.get('location'), `${BASE}courses/${KEY}/blobs/${SHA}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the API entry point and the activeJobKey namespace line up', () => {
  assert.equal(activeJobKey(KEY), `jobs/active/${KEY}.json`);
  assert.equal(typeof require('../api/index.js'), 'function');
});

test('the staged Vercel deployment is self-contained: the API loads from the staged files alone', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { stage } = require('../cloud/vercel/stage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-vercel-stage-'));
  try {
    const files = stage(dir);
    assert.ok(files.includes('package.json') && files.includes('vercel.json'));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(pkg.dependencies['@vercel/blob'] && pkg.dependencies['@vercel/sandbox']);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'vercel.json'), 'utf8'));
    assert.ok(config.functions['api/index.js']);
    // every relative require resolves inside the staged folder (SDKs load lazily)
    assert.equal(typeof require(path.join(dir, 'api', 'index.js')), 'function');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
