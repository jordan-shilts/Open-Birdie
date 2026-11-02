'use strict';
// HTTP API of the cloud course service (v1). JSON in, JSON out.
//
//   GET  /healthz
//   GET  /v1/courses/:key                 200 package manifest | 404 {error, job?}
//   POST /v1/courses                      start a build (Authorization: Bearer <BIRDIE_CLOUD_BUILD_TOKEN>)
//        body {source:{osmType,osmId}, name?, bbox?:[s,n,w,e], lat?, lon?, force?}
//        200 {status:'ready', key, manifest} | 202 {status:'queued'|'running', key, job}
//        401 bad token | 503 builds disabled | 429 queue full | 400 bad request
//   GET  /v1/jobs/:id                     200 {id, key, courseId, status, stage, message, pct,
//                                              packageId, complete, error, createdAt, ...} | 404
//   GET  /v1/courses/:key/files/:sha256   302 to a presigned object URL (S3 store) or
//                                         200 bytes (directory store, or BIRDIE_CLOUD_FILES=proxy)
//
// :key is the course cache key, e.g. osm-relation-9892305 (osm:relation:9892305 works too).
// Reads are public (they only expose open data); building needs the token.

const crypto = require('node:crypto');
const { normalizeCourseSource } = require('../lib/course-identity');
const { packageKeyFor, parsePackageKey } = require('../lib/course-key');
const { blobKey, manifestKey } = require('./store');

const MAX_BODY_BYTES = 16 * 1024;
// scenery summary keys a complete package must have (a layer added in a newer
// version is missing from older packages: they are re-enriched on request)
const SCENERY_KEYS = Object.freeze(['buildings', 'water', 'canopyTrees', 'aerial']);
const RETRY_FAILED_LAYERS_MS = 60 * 60 * 1000;
const HEX64 = /^[a-f0-9]{64}$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw new HttpError(400, 'bad_json'); }
}

// The build request a desktop sends: the OSM identity plus the search hit's name
// and box (the box is the fallback extent when OSM has no outline).
function parseBuildRequest(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'bad_request');
  let source;
  try { source = normalizeCourseSource(body.source || body); }
  catch (_) { throw new HttpError(400, 'bad_source', 'source must be {osmType: node|way|relation, osmId}'); }
  const request = {};
  if (body.name != null) {
    if (typeof body.name !== 'string') throw new HttpError(400, 'bad_name');
    request.name = body.name.slice(0, 300);
  }
  if (body.bbox != null) {
    const bbox = Array.isArray(body.bbox) ? body.bbox.map(Number) : [];
    const [s, n, w, e] = bbox;
    if (bbox.length !== 4 || !bbox.every(Number.isFinite) || s < -90 || n > 90 || w < -180 || e > 180 ||
        s >= n || w >= e || n - s > 0.5 || e - w > 0.5) {
      throw new HttpError(400, 'bad_bbox', 'bbox must be [south, north, west, east] around one course');
    }
    request.bbox = bbox;
  }
  if (body.lat != null || body.lon != null) {
    const lat = Number(body.lat), lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new HttpError(400, 'bad_latlon');
    }
    Object.assign(request, { lat, lon });
  }
  return { source, request, force: body.force === true };
}

function createCloudService({
  store,
  queue,
  buildToken = null,
  fileMode = store && (store.kind === 's3' || store.kind === 'vercel-blob') ? 'redirect' : 'proxy',
  presignSeconds = 900,
  now = Date.now,
  log = console,
} = {}) {
  if (!store || !queue) throw new TypeError('Cloud service needs a store and a job queue');

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  function courseKey(raw) {
    try { return packageKeyFor(parsePackageKey(decodeURIComponent(raw))); }
    catch (_) { throw new HttpError(400, 'bad_key', 'course key must look like osm-way-123'); }
  }

  // A complete package is final, except that layers which failed get another try
  // once the package is an hour old, and layers it predates get added.
  function isReady(manifest) {
    if (!manifest || !manifest.complete) return false;
    if (!SCENERY_KEYS.every((key) => manifest.scenery && key in manifest.scenery)) return false;
    const failed = (manifest.scenery && manifest.scenery.failed) || [];
    if (!failed.length) return true;
    return now() - Date.parse(manifest.createdAt) < RETRY_FAILED_LAYERS_MS;
  }

  async function getCourse(res, raw) {
    const key = courseKey(raw);
    const manifest = await store.getJson(manifestKey(key));
    if (manifest) return send(res, 200, manifest, { 'Cache-Control': 'no-cache' });
    const job = await queue.activeFor(key);
    return send(res, 404, { error: 'not_found', key, ...(job ? { job } : {}) });
  }

  async function postCourse(req, res) {
    if (!buildToken) throw new HttpError(503, 'builds_disabled', 'this service has no BIRDIE_CLOUD_BUILD_TOKEN');
    const auth = String(req.headers.authorization || '');
    const given = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    if (!given || !sameSecret(given, buildToken)) throw new HttpError(401, 'unauthorized');
    const { source, request, force } = parseBuildRequest(await readJsonBody(req));
    const key = packageKeyFor(source);
    if (!force) {
      const manifest = await store.getJson(manifestKey(key));
      if (isReady(manifest)) return send(res, 200, { status: 'ready', key, manifest });
    }
    let submitted;
    try {
      submitted = await queue.submit(key, { key, courseId: source.courseId, request, force });
    } catch (error) {
      if (error.code === 'QUEUE_FULL') throw new HttpError(429, 'queue_full', error.message);
      throw error;
    }
    if (submitted.created) log.log(`[cloud] queued ${key}${force ? ' (forced rebuild)' : ''}`);
    return send(res, 202, { status: submitted.job.status, key, job: submitted.job });
  }

  async function getFile(req, res, rawKey, sha256) {
    const key = courseKey(rawKey);
    if (!HEX64.test(sha256)) throw new HttpError(400, 'bad_sha256');
    const objectKey = blobKey(key, sha256);
    if (fileMode === 'redirect' && typeof store.blobUrl === 'function') {
      const url = await store.blobUrl(objectKey, { expiresSec: presignSeconds });
      if (url) {
        res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
        return res.end();
      }
    }
    const bytes = await store.readBlob(objectKey);
    if (!bytes) throw new HttpError(404, 'not_found');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': bytes.length,
      'Cache-Control': 'public, max-age=31536000, immutable', // content-addressed
    });
    return res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://cloud');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    let m;
    try {
      if (req.method === 'GET' && p === '/healthz') {
        return send(res, 200, { ok: true, store: store.kind, builds: Boolean(buildToken), files: fileMode, queue: queue.stats() });
      }
      if (req.method === 'POST' && p === '/v1/courses') return await postCourse(req, res);
      if ((req.method === 'GET' || req.method === 'HEAD') && (m = /^\/v1\/courses\/([^/]+)\/files\/([^/]+)$/.exec(p))) {
        return await getFile(req, res, m[1], m[2]);
      }
      if (req.method === 'GET' && (m = /^\/v1\/courses\/([^/]+)$/.exec(p))) return await getCourse(res, m[1]);
      if (req.method === 'GET' && (m = /^\/v1\/jobs\/([^/]+)$/.exec(p))) {
        const job = await queue.get(decodeURIComponent(m[1]));
        return job ? send(res, 200, job) : send(res, 404, { error: 'not_found' });
      }
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.code, ...(error.message !== error.code ? { message: error.message } : {}) });
      log.error(`[cloud] ${req.method} ${p}: ${error && error.message}`);
      return send(res, 500, { error: 'internal' });
    }
  }

  return Object.freeze({ handle });
}

module.exports = { HttpError, createCloudService, parseBuildRequest };
