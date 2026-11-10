'use strict';
// Web skies kept on this machine (lib/sky-cache.js): fetched once, then served from
// disk, so the sky looks the same with or without the internet.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createSkyCache } = require('../lib/sky-cache');

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
