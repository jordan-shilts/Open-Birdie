'use strict';
// Build jobs on Vercel. A Vercel Function can't run a 5-10 minute course build, so
// each build gets its own Vercel Sandbox (a microVM with no request time limit). It
// clones this repository from GitHub (BIRDIE_CLOUD_REPO at BIRDIE_CLOUD_REF),
// installs the cloud dependencies and runs cloud/sandbox-build.js, which publishes
// the package to the Blob store and writes its progress into the job record
// (jobs/<id>.json; jobs/active/<course key>.json points at a course's live job).
// The API serves those records. Once a record says the build is over, the API stops
// that build's sandbox; the sandbox's session timeout is the backstop.
//
// Same interface as the in-memory queue (cloud/jobs.js) — submit / activeFor / get /
// stats / close — but async, since the records live in the store.

const crypto = require('node:crypto');
const { activeJobKey, jobKey } = require('./vercel-blob-store');

const DEFAULT_REPO = 'https://github.com/jordan-shilts/Open-Birdie.git';
const DEFAULT_REF = 'main';
const SESSION_MS = 40 * 60 * 1000;   // Hobby sandbox sessions cap at 45 min
const STALE_MS = 10 * 60 * 1000;     // a live build rewrites its record every 60 s
// Asked of the desktop (a job's pollMs): every poll is a Blob read (10,000 a month on
// Hobby), and the record changes at most every 15 s anyway.
const POLL_MS = 10 * 1000;
const RUNNING = new Set(['queued', 'running']);
const JOB_ID = /^[0-9a-f-]{36}$/;

// Inside the sandbox: only the service's own dependencies (cloud/package.json), not
// the desktop app's Electron toolchain — then the build.
const BUILD_SCRIPT = [
  'set -e',
  'cd /vercel/sandbox',
  'cp cloud/package.json package.json',
  'rm -f package-lock.json',
  'npm install --omit=dev --no-audit --no-fund --loglevel=error',
  'exec node cloud/sandbox-build.js',
].join('\n');

function failure(message) {
  return { code: 'BUILD_FAILED', message, userFacing: false };
}

// store: cloud/vercel-blob-store.js. sandboxApi: @vercel/sandbox's Sandbox (create /
// get), oidcToken: () => token|null — both injectable for tests.
function createSandboxJobs({
  store,
  env = process.env,
  sandboxApi = null,
  oidcToken = async () => {
    try { return await require('@vercel/oidc').getVercelOidcToken(); } catch (_) { return null; }
  },
  now = Date.now,
  log = console,
} = {}) {
  if (!store || typeof store.getRecord !== 'function') throw new TypeError('Sandbox jobs need a Vercel Blob store');
  // import(), not require(): the SDK's CommonJS build requires an ES-module-only
  // dependency, which Node 22 on Vercel refuses ("require() of ES Module").
  const api = async () => sandboxApi || (await import('@vercel/sandbox')).Sandbox;
  const iso = () => new Date(now()).toISOString();
  const view = (job) => {
    const { sandbox, sandboxStopped, ...rest } = job;
    return { ...rest, pollMs: POLL_MS };
  };

  // What the build inside the VM publishes with: a read-write token, else this
  // deployment's OIDC token and store id (good for ~12 h, far longer than a build).
  async function blobCredentials() {
    if (env.BLOB_READ_WRITE_TOKEN) return { BLOB_READ_WRITE_TOKEN: env.BLOB_READ_WRITE_TOKEN };
    const token = await oidcToken();
    if (token && env.BLOB_STORE_ID) return { VERCEL_OIDC_TOKEN: token, BLOB_STORE_ID: env.BLOB_STORE_ID };
    throw new Error('no Blob credentials to hand the build (BLOB_READ_WRITE_TOKEN, or OIDC with BLOB_STORE_ID)');
  }

  async function get(id) {
    if (!JOB_ID.test(String(id))) return null;
    const job = await store.getRecord(jobKey(id));
    if (!job) return null;
    if (RUNNING.has(job.status) && now() - Date.parse(job.updatedAt) > STALE_MS) {
      Object.assign(job, {
        status: 'failed', stage: 'failed', message: 'The course build stopped responding.',
        error: failure('The course build stopped responding.'), finishedAt: iso(), updatedAt: iso(),
      });
      await store.putRecord(jobKey(id), job);
    }
    if (!RUNNING.has(job.status) && job.sandbox && !job.sandboxStopped) {
      // the build is over: stop its machine now, not at the session timeout
      try { await (await (await api()).get({ name: job.sandbox, resume: false })).stop(); }
      catch (error) { log.warn(`[cloud] could not stop sandbox ${job.sandbox}: ${error.message}`); }
      job.sandboxStopped = true;
      await store.putRecord(jobKey(id), job);
    }
    return view(job);
  }

  async function activeFor(key) {
    const pointer = await store.getRecord(activeJobKey(key));
    if (!pointer || !pointer.id) return null;
    const job = await get(pointer.id);
    return job && RUNNING.has(job.status) ? job : null;
  }

  // Queue a build for a course key, or join the one already running.
  async function submit(key, payload) {
    const active = await activeFor(key);
    if (active) return { job: active, created: false };
    const job = {
      id: crypto.randomUUID(),
      key,
      courseId: payload && payload.courseId,
      status: 'queued',
      stage: 'starting',
      message: 'starting a build machine',
      pct: 0,
      packageId: null,
      complete: false,
      createdAt: iso(),
      startedAt: null,
      finishedAt: null,
      updatedAt: iso(),
      error: null,
      sandbox: null,
    };
    await store.putRecord(jobKey(job.id), job);
    await store.putRecord(activeJobKey(key), { id: job.id });
    let sandbox = null;
    try {
      const credentials = await blobCredentials();
      const name = `birdie-build-${job.id.slice(0, 8)}`;
      sandbox = await (await api()).create({
        name,
        source: { type: 'git', url: env.BIRDIE_CLOUD_REPO || DEFAULT_REPO, revision: env.BIRDIE_CLOUD_REF || DEFAULT_REF, depth: 1 },
        image: 'vercel/sandbox/node:22',
        resources: { vcpus: 4 },
        timeout: SESSION_MS,
        persistent: false,
      });
      // record the machine before the build can start writing its own progress
      Object.assign(job, {
        status: 'running', stage: 'starting', message: 'installing the course builder',
        sandbox: name, startedAt: iso(), updatedAt: iso(),
      });
      await store.putRecord(jobKey(job.id), job);
      await sandbox.runCommand({
        cmd: 'bash',
        args: ['-c', BUILD_SCRIPT],
        env: {
          ...credentials,
          JOB_ID: job.id,
          BUILD_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString('base64'),
          ...(env.BIRDIE_OVERPASS_URLS ? { BIRDIE_OVERPASS_URLS: env.BIRDIE_OVERPASS_URLS } : {}),
        },
        detached: true,
      });
    } catch (error) {
      log.error(`[cloud] ${key}: could not start a build sandbox: ${error.message}`);
      Object.assign(job, {
        status: 'failed', stage: 'failed', message: 'The course builder could not start.',
        error: failure('The course builder could not start.'), finishedAt: iso(), updatedAt: iso(),
      });
      await store.putRecord(jobKey(job.id), job);
      if (sandbox) { try { await sandbox.stop(); } catch (_) { /* gone */ } job.sandboxStopped = true; }
    }
    return { job: view(job), created: true };
  }

  return Object.freeze({
    submit,
    activeFor,
    get,
    stats: () => ({ runner: 'vercel-sandbox' }),
    close() {},
  });
}

module.exports = { BUILD_SCRIPT, createSandboxJobs };
