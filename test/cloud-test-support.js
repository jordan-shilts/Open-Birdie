'use strict';
// Test support: a scriptable in-process fake of the cloud course API (v1), plus a
// helper that seeds a cached course and builds its package. Not a test file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { buildCoursePackage, packageKeyFor } = require('../lib/course-package');

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function testCourse(osmId = 77, overrides = {}) {
  return {
    version: 4,
    name: `Cloud Links ${osmId}`,
    source: { courseId: `osm:way:${osmId}`, osmType: 'way', osmId },
    origin: { lat: 45, lon: -93 },
    surfaces: [{ kind: 'green', poly: [[0, 0], [10, 0], [10, 10], [0, 10]] }],
    boundary: null,
    holes: [{ ref: 1, par: 3, tee: [0, -100], pin: [5, 5], line: [[0, -100], [5, 5]], lengthYd: 115 }],
    trees: [],
    woods: [],
    elevation: { minX: -20, minY: -120, cellM: 5, nx: 9, ny: 30, baseM: 300, heights: Array.from({ length: 270 }, (_, i) => i % 5) },
    ...overrides,
  };
}

// Cache a course (with an aerial + classmap when `aerial`) in a fresh data dir and
// build its package.
function packageFor(course, { aerial = true, complete = true } = {}) {
  const dataDir = tempDir('birdie-cloud-src-');
  const key = packageKeyFor(course.source);
  const coursesDir = path.join(dataDir, 'courses');
  fs.mkdirSync(coursesDir, { recursive: true });
  const c = structuredClone(course);
  if (aerial) {
    const bounds = { minX: -80, minY: -180, maxX: 70, maxY: 70 };
    const jpg = crypto.randomBytes(5000); jpg[0] = 0xff; jpg[1] = 0xd8;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(300)]);
    fs.writeFileSync(path.join(coursesDir, `${key}.aerial.jpg`), jpg);
    fs.writeFileSync(path.join(coursesDir, `${key}.classmap.png`), png);
    c.aerial = { file: `${key}.aerial.jpg`, bounds, quality: 'tiled', classFile: `${key}.classmap.png`, classBounds: bounds, classStats: { mownPct: 0.4 } };
  }
  fs.writeFileSync(path.join(coursesDir, `${key}.json`), JSON.stringify(c));
  return buildCoursePackage({ dataDir, source: c.source, complete });
}

// A fake cloud. `packages` maps key -> { manifest, files }. `onBuild(body, cloud)`
// returns the job to create (or a reply object); jobs can be mutated by the test.
async function startFakeCloud({
  token = 'secret-token',
  redirectFiles = false,
  tamper = null,
  failAll = false,
  onBuild = null,
} = {}) {
  const cloud = {
    packages: new Map(),
    blobs: new Map(),
    jobs: new Map(),
    requests: [],
    publish(pkg) {
      this.packages.set(pkg.manifest.key, pkg.manifest);
      for (const { entry, bytes } of pkg.files) this.blobs.set(entry.sha256, { bytes, entry });
    },
  };
  let jobCount = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    cloud.requests.push(`${req.method} ${url.pathname}`);
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (failAll) return send(503, { error: 'unavailable' });
    let m;
    if (req.method === 'GET' && (m = /^\/v1\/courses\/([^/]+)$/.exec(url.pathname))) {
      const manifest = cloud.packages.get(decodeURIComponent(m[1]));
      return manifest ? send(200, manifest) : send(404, { error: 'not_found' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/courses') {
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      cloud.lastBuildBody = body;
      const made = onBuild ? onBuild(body, cloud) : null;
      if (made && made.reply) return send(made.code || 200, made.reply);
      const job = { id: `job-${++jobCount}`, status: 'queued', stage: 'queued', message: 'queued', pct: 0, packageId: null, ...(made || {}) };
      cloud.jobs.set(job.id, job);
      return send(202, { status: job.status, job });
    }
    if (req.method === 'GET' && (m = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname))) {
      const job = cloud.jobs.get(decodeURIComponent(m[1]));
      if (job && typeof job.advance === 'function') job.advance(job, cloud);
      if (!job) return send(404, { error: 'not_found' });
      const { advance, ...publicJob } = job;
      return send(200, publicJob);
    }
    if (req.method === 'GET' && (m = /^\/v1\/courses\/([^/]+)\/files\/([a-f0-9]{64})$/.exec(url.pathname))) {
      if (!cloud.blobs.has(m[2])) return send(404, { error: 'not_found' });
      if (redirectFiles) return send(302, undefined, { Location: `/blob/${m[2]}` });
      return serveBlob(m[2]);
    }
    if (req.method === 'GET' && (m = /^\/blob\/([a-f0-9]{64})$/.exec(url.pathname))) return serveBlob(m[1]);
    return send(404, { error: 'not_found' });

    function serveBlob(sha) {
      const blob = cloud.blobs.get(sha);
      if (!blob) return send(404, { error: 'not_found' });
      const bytes = tamper ? tamper(blob.entry, blob.bytes) : blob.bytes;
      res.writeHead(200, { 'Content-Type': blob.entry.contentType, 'Content-Length': bytes.length });
      return res.end(bytes);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cloud.url = `http://127.0.0.1:${server.address().port}`;
  cloud.close = () => new Promise((resolve) => server.close(resolve));
  return cloud;
}

module.exports = { packageFor, startFakeCloud, tempDir, testCourse };
