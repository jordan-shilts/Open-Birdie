'use strict';
// Web skies kept on this machine (lib/sky-cache.js): fetched once, then served from
// disk, so the sky looks the same with or without the internet.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createSkyCache, webSkyFiles } = require('../lib/sky-cache');

const quiet = { log() {}, warn() {} };
const NAME = 'kloppenheim_06_puresky_4k.hdr';

function fakeFetch(body, { status = 200, calls = [] } = {}) {
  const fn = async (url, opts) => {
    calls.push(url);
    if (body instanceof Error) throw body;
    return new Response(status === 200 ? body : null, { status });
  };
  fn.calls = calls;
  return fn;
}

async function serveOnce(cache, name) {
  const srv = http.createServer((req, res) => cache.serve(req, res, name));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/sky/${name}`);
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  } finally {
    srv.close();
  }
}

function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('first request fetches from Poly Haven and keeps it; the next one is offline-safe', async (t) => {
  const dataDir = tmpDir(t);
  const online = fakeFetch('#?RADIANCE fake hdr bytes');
  const cache = createSkyCache({ dataDir, fetchImpl: online, log: quiet });
  const first = await serveOnce(cache, NAME);
  assert.equal(first.status, 200);
  assert.equal(first.body.toString(), '#?RADIANCE fake hdr bytes');
  assert.deepEqual(online.calls, [`https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/${NAME}`]);

  const offline = createSkyCache({ dataDir, fetchImpl: fakeFetch(new Error('getaddrinfo ENOTFOUND')), log: quiet });
  const again = await serveOnce(offline, NAME);
  assert.equal(again.status, 200);
  assert.equal(again.body.toString(), '#?RADIANCE fake hdr bytes');
  assert.match(again.headers.get('cache-control'), /immutable/);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'sky-cache')), [NAME], 'no partial files left');
});

test('never fetched and offline: fails at once so the page falls back to midday', async (t) => {
  const cache = createSkyCache({ dataDir: tmpDir(t), fetchImpl: fakeFetch(new Error('getaddrinfo ENOTFOUND')), log: quiet });
  const started = Date.now();
  const res = await serveOnce(cache, NAME);
  assert.equal(res.status, 503);
  assert.ok(Date.now() - started < 1000);
});

test('a failed download leaves nothing behind and is retried next time', async (t) => {
  const dataDir = tmpDir(t);
  const bad = createSkyCache({ dataDir, fetchImpl: fakeFetch('', { status: 404 }), log: quiet });
  assert.equal((await serveOnce(bad, NAME)).status, 503);
  assert.equal(bad.isCached(NAME), false);
  const good = createSkyCache({ dataDir, fetchImpl: fakeFetch('sky'), log: quiet });
  assert.equal((await serveOnce(good, NAME)).status, 200);
});

test('only Poly Haven 4k HDR file names are accepted', async (t) => {
  const calls = [];
  const cache = createSkyCache({ dataDir: tmpDir(t), fetchImpl: fakeFetch('x', { calls }), log: quiet });
  for (const name of ['../cloud.json', 'x.hdr', 'evil%2F..%2Fa_4k.hdr', 'A_4k.hdr', `${'a'.repeat(81)}_4k.hdr`]) {
    assert.equal((await serveOnce(cache, name)).status, 404, name);
  }
  assert.deepEqual(calls, []);
});

test('two requests at once share one download', async (t) => {
  const calls = [];
  const cache = createSkyCache({ dataDir: tmpDir(t), fetchImpl: fakeFetch('sky', { calls }), log: quiet });
  const [a, b] = await Promise.all([cache.ensure(NAME), cache.ensure(NAME)]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
});

// ---- every sky kept before the internet goes away (keepAll) ----

const SKIES = ['rustig_koppie_puresky_4k.hdr', 'kloppenheim_06_puresky_4k.hdr', 'kloofendal_overcast_puresky_4k.hdr'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// answers per file name: 'ok', 'fail' (offline), or a function of the call count
function scriptedFetch(plan = {}) {
  const calls = [];
  let active = 0;
  const fn = async (url) => {
    const name = url.split('/').pop();
    calls.push(name);
    active += 1;
    fn.maxActive = Math.max(fn.maxActive, active);
    try {
      await sleep(2);
      const answer = typeof plan[name] === 'function' ? plan[name](calls.filter((n) => n === name).length) : (plan[name] || 'ok');
      if (answer === 'fail') throw new Error('getaddrinfo ENOTFOUND dl.polyhaven.org');
      return new Response(`hdr ${name}`, { status: 200 });
    } finally {
      active -= 1;
    }
  };
  fn.calls = calls;
  fn.maxActive = 0;
  return fn;
}

async function until(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(5);
  }
  return false;
}

test('the sky list comes from sky-presets.js: every web sky the page offers', async () => {
  const { SKY_PRESETS } = await import('../public/render/sky-presets.js');
  const fromPage = Object.values(SKY_PRESETS)
    .map((preset) => preset.hdri)
    .filter((url) => typeof url === 'string' && url.startsWith('/sky/'))
    .map((url) => url.slice('/sky/'.length));
  const files = webSkyFiles(path.join(__dirname, '..', 'public', 'render', 'sky-presets.js'));
  assert.deepEqual([...files].sort(), [...new Set(fromPage)].sort());
  assert.ok(files.length >= 4, 'Morning, Golden hour, Overcast and Fog at least');
});

test('fetchMissing fetches only what is not on disk, one at a time, and reports what is still missing', async (t) => {
  const dataDir = tmpDir(t);
  fs.mkdirSync(path.join(dataDir, 'sky-cache'));
  fs.writeFileSync(path.join(dataDir, 'sky-cache', SKIES[0]), 'kept already');
  const fetchImpl = scriptedFetch({ [SKIES[2]]: 'fail' });
  const cache = createSkyCache({ dataDir, fetchImpl, log: quiet });
  const missing = await cache.fetchMissing(SKIES);
  assert.deepEqual(missing, [SKIES[2]]);
  assert.deepEqual(fetchImpl.calls, [SKIES[1], SKIES[2]]);
  assert.equal(fetchImpl.maxActive, 1, 'never two downloads at once');
  assert.equal(cache.isCached(SKIES[1]), true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'sky-cache', SKIES[0]), 'utf8'), 'kept already');
});

test('keepAll waits before the first pass, then keeps every sky', async (t) => {
  const fetchImpl = scriptedFetch();
  const lines = [];
  const cache = createSkyCache({ dataDir: tmpDir(t), fetchImpl, log: { log: (m) => lines.push(m), warn() {} } });
  const keeper = cache.keepAll(SKIES, { firstDelayMs: 60, retryMs: 20 });
  t.after(() => keeper.stop());
  await sleep(25);
  assert.deepEqual(fetchImpl.calls, [], 'nothing during startup');
  assert.ok(await until(() => SKIES.every((name) => cache.isCached(name))));
  assert.deepEqual(fetchImpl.calls, SKIES);
  await sleep(60);
  assert.deepEqual(fetchImpl.calls, SKIES, 'no more passes once all are kept');
  assert.equal(lines.some((m) => /not kept yet/.test(m)), false, 'nothing to say when all went fine');
});

test('keepAll offline: says so once, tries again later, and fills in when the internet is back', async (t) => {
  let online = false;
  const plan = Object.fromEntries(SKIES.map((name) => [name, () => (online ? 'ok' : 'fail')]));
  const fetchImpl = scriptedFetch(plan);
  const lines = [];
  const cache = createSkyCache({ dataDir: tmpDir(t), fetchImpl, log: { log: (m) => lines.push(m), warn() {} } });
  const keeper = cache.keepAll(SKIES, { firstDelayMs: 5, retryMs: 30 });
  t.after(() => keeper.stop());
  assert.ok(await until(() => fetchImpl.calls.length >= SKIES.length * 2), 'a second pass after the first failed');
  assert.equal(SKIES.some((name) => cache.isCached(name)), false);
  assert.equal(lines.filter((m) => /3 of 3 skies not kept yet/.test(m)).length, 1, 'said once, not every pass');
  online = true;
  assert.ok(await until(() => SKIES.every((name) => cache.isCached(name))));
  assert.ok(await until(() => lines.some((m) => /every sky is now kept/.test(m))));
  const after = fetchImpl.calls.length;
  await sleep(80);
  assert.equal(fetchImpl.calls.length, after, 'stops once all are kept');
});

test('keepAll stop() cancels a pass that has not started and any retry', async (t) => {
  const fetchImpl = scriptedFetch({ [SKIES[0]]: 'fail' });
  const cache = createSkyCache({ dataDir: tmpDir(t), fetchImpl, log: quiet });
  const early = cache.keepAll(SKIES, { firstDelayMs: 30, retryMs: 10 });
  early.stop();
  await sleep(60);
  assert.deepEqual(fetchImpl.calls, []);

  const late = cache.keepAll([SKIES[0]], { firstDelayMs: 1, retryMs: 15 });
  assert.ok(await until(() => fetchImpl.calls.length === 1));
  late.stop();
  await sleep(60);
  assert.equal(fetchImpl.calls.length, 1, 'no retry after stop');
});

test('keepAll ignores names that are not Poly Haven sky files, and an empty list does nothing', async (t) => {
  const fetchImpl = scriptedFetch();
  const cache = createSkyCache({ dataDir: tmpDir(t), fetchImpl, log: quiet });
  const keeper = cache.keepAll(['../cloud.json', 'x.hdr', SKIES[0], SKIES[0]], { firstDelayMs: 1, retryMs: 10 });
  t.after(() => keeper.stop());
  assert.ok(await until(() => cache.isCached(SKIES[0])));
  await sleep(30);
  assert.deepEqual(fetchImpl.calls, [SKIES[0]]);
  const none = cache.keepAll([], { firstDelayMs: 1 });
  none.stop();
});

test('keepAll shares a download the page asked for at the same moment', async (t) => {
  const fetchImpl = scriptedFetch();
  const cache = createSkyCache({ dataDir: tmpDir(t), fetchImpl, log: quiet });
  const keeper = cache.keepAll([SKIES[0]], { firstDelayMs: 0, retryMs: 10 });
  t.after(() => keeper.stop());
  await sleep(1);
  const res = await serveOnce(cache, SKIES[0]);
  assert.equal(res.status, 200);
  assert.ok(await until(() => cache.isCached(SKIES[0])));
  await sleep(20);
  assert.equal(fetchImpl.calls.length, 1, 'one download for both');
});
