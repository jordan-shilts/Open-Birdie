'use strict';
// Web skies (Morning, Golden hour, Overcast, Fog) kept on this machine.
//
// The page asks the game server for /sky/<id>_4k.hdr. The first time, the server
// fetches it from Poly Haven (CC0) and keeps it in DATA_DIR/sky-cache; after that
// it is served from disk, so a sky picked once looks the same with or without the
// internet. Never fetched and offline: the request fails at once (no hanging DNS
// lookup in the browser), and the page falls back to the bundled midday sky.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const POLY_HAVEN_HDR_4K = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/';
// Only Poly Haven HDRI file names: no paths, no other hosts.
const FILE_RE = /^[a-z0-9_]{1,80}_4k\.hdr$/;
const CONNECT_TIMEOUT_MS = 8000;   // headers back from Poly Haven
const DOWNLOAD_TIMEOUT_MS = 120000; // the whole ~20 MB file

function createSkyCache({ dataDir, fetchImpl = globalThis.fetch, log = console } = {}) {
  const dir = path.join(dataDir, 'sky-cache');
  const inFlight = new Map();

  const fileFor = (name) => path.join(dir, name);

  function isCached(name) {
    try { return fs.statSync(fileFor(name)).size > 0; } catch (_) { return false; }
  }

  async function download(name) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${fileFor(name)}.${process.pid}.${Date.now()}.part`;
    const controller = new AbortController();
    const headerTimer = setTimeout(() => controller.abort(new Error('no answer from Poly Haven')), CONNECT_TIMEOUT_MS);
    const bodyTimer = setTimeout(() => controller.abort(new Error('sky download took too long')), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetchImpl(POLY_HAVEN_HDR_4K + name, { signal: controller.signal });
      clearTimeout(headerTimer);
      if (!res.ok || !res.body) throw new Error(`Poly Haven answered ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      if (fs.statSync(tmp).size === 0) throw new Error('empty sky file');
      fs.renameSync(tmp, fileFor(name));
      log.log(`[sky] saved ${name} for offline use`);
    } finally {
      clearTimeout(headerTimer);
      clearTimeout(bodyTimer);
      fs.rmSync(tmp, { force: true });
    }
  }

  // Resolves to the file path once the sky is on disk; one download per file at a time.
  function ensure(name) {
    if (!FILE_RE.test(name)) return Promise.reject(Object.assign(new Error('unknown sky'), { status: 404 }));
    if (isCached(name)) return Promise.resolve(fileFor(name));
    if (!inFlight.has(name)) {
      const job = download(name)
        .then(() => fileFor(name))
        .catch((e) => { throw Object.assign(new Error(e?.message || String(e)), { status: 503 }); })
        .finally(() => inFlight.delete(name));
      inFlight.set(name, job);
    }
    return inFlight.get(name);
  }

  async function serve(req, res, name) {
    let file;
    try {
      file = await ensure(name);
    } catch (e) {
      if (e.status !== 404) log.warn(`[sky] ${name} unavailable: ${e.message}`);
      res.writeHead(e.status || 503, { 'Content-Type': 'text/plain' });
      res.end(e.status === 404 ? 'unknown sky' : 'sky unavailable offline');
      return;
    }
    const size = fs.statSync(file).size;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  }

  return { dir, ensure, isCached, serve };
}

module.exports = { createSkyCache, FILE_RE, POLY_HAVEN_HDR_4K };
