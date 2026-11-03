'use strict';
// One course build inside a Vercel Sandbox (started by cloud/sandbox-jobs.js): the
// same builder as the long-running service (cloud/builder.js), publishing to the
// Vercel Blob store and reporting progress into the job record the API serves.
//
//   JOB_ID=<uuid> BUILD_PAYLOAD=<base64 JSON {key, courseId, request, force}> node cloud/sandbox-build.js
//
// Blob credentials come from the environment (BLOB_READ_WRITE_TOKEN, or
// VERCEL_OIDC_TOKEN + BLOB_STORE_ID), handed over by the API that started the build.

const os = require('node:os');
const path = require('node:path');

// lib/course.js fixes its cache dir when first required: builds stage here.
if (!process.env.BIRDIE_DATA_DIR) process.env.BIRDIE_DATA_DIR = path.join(os.tmpdir(), 'birdie-cloud-staging');

const { createCourseBuilder } = require('./builder');
const { buildHdHoles, hdPlanFor } = require('./hd-holes');
const { describeFailure } = require('./jobs');
const { activeJobKey, createVercelBlobStore, jobKey } = require('./vercel-blob-store');

// Every record write is a Blob upload, and Hobby includes 2,000 a month: progress is
// saved at most every 15 s (a 10-minute build writes ~50 records, not ~250).
const SAVE_EVERY_MS = 15 * 1000;
const HEARTBEAT_MS = 60 * 1000;

// The last warnings and errors, kept for a failed build's record: the sandbox and its
// logs are gone once the API stops it, and the cause is often logged a step earlier
// than the error that ends the build (an Overpass mirror refusing, say).
const recentLog = [];
for (const level of ['warn', 'error']) {
  const write = console[level].bind(console);
  console[level] = (...args) => {
    recentLog.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ').slice(0, 300));
    if (recentLog.length > 12) recentLog.shift();
    write(...args);
  };
}

async function main() {
  const id = process.env.JOB_ID;
  const payload = JSON.parse(Buffer.from(process.env.BUILD_PAYLOAD || '', 'base64').toString('utf8'));
  const store = createVercelBlobStore();
  const job = (await store.getRecord(jobKey(id))) || { id, key: payload.key, courseId: payload.courseId };

  // Progress lands in the job record at most every few seconds; status changes at once.
  let lastSave = 0, timer = null;
  const write = () => store.putRecord(jobKey(id), job).catch((error) => console.warn(`[cloud] job record not saved: ${error.message}`));
  const save = (fields = {}, immediately = false) => {
    Object.assign(job, fields, { updatedAt: new Date().toISOString() });
    if (!immediately && Date.now() - lastSave < SAVE_EVERY_MS) {
      timer = timer || setTimeout(() => { timer = null; lastSave = Date.now(); write(); }, SAVE_EVERY_MS);
      return Promise.resolve();
    }
    lastSave = Date.now();
    return write();
  };
  // The heartbeat carries the machine's memory too (the build's own and what is left for
  // the HD hole processes), so a build that goes quiet shows whether it ran out.
  const memory = () => ({ rssMb: Math.round(process.memoryUsage().rss / 1048576), freeMb: Math.round(os.freemem() / 1048576) });
  const heartbeat = setInterval(() => save({ memory: memory() }, true), HEARTBEAT_MS);

  const { loadCourse } = require('../lib/course');
  const { localSceneryProviders } = require('../lib/course-enrichment');
  let sharp = null;
  try { sharp = require('sharp'); }
  catch (error) { console.warn(`[cloud] sharp unavailable (${error.message}); single-request aerial`); }
  const aerialQuality = sharp ? 'tiled' : 'single';
  const build = createCourseBuilder({
    dataDir: process.env.BIRDIE_DATA_DIR,
    store,
    loadCourse,
    providers: localSceneryProviders({ aerialQuality, sharp, canopy: true }),
    aerialQuality,
    hd: { plan: (course) => hdPlanFor(course), build: buildHdHoles },
  });

  await save({ status: 'running', stage: 'starting', message: 'building the course', startedAt: job.startedAt || new Date().toISOString() }, true);
  try {
    await build(payload, { update: (fields) => { save({ status: 'running', ...fields }); }, signal: new AbortController().signal });
    await save({ status: 'done', stage: 'done', message: 'done', pct: 100, finishedAt: new Date().toISOString() }, true);
  } catch (error) {
    console.error(`[cloud] build ${job.key} failed: ${error && (error.code || '')} ${error && error.message}`);
    const described = describeFailure(error);
    // `internal` never leaves the store through the API (sandbox-jobs.js view()); the
    // API logs it once, so the cause is in the function logs after the sandbox is gone
    const internal = {
      code: String((error && (error.code || error.name)) || 'ERROR').slice(0, 80),
      message: String((error && error.message) || error).slice(0, 500),
      at: String((error && error.stack) || '').split('\n').slice(1, 4).map((l) => l.trim()).join(' | ').slice(0, 400),
      log: recentLog.slice(0, -1),   // what led up to it (the last line is the failure itself)
    };
    await save({ status: 'failed', stage: 'failed', message: described.message, error: described, internal, finishedAt: new Date().toISOString() }, true);
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
    try {
      const pointer = await store.getRecord(activeJobKey(job.key));
      if (pointer && pointer.id === id) await store.deleteRecord(activeJobKey(job.key));
    } catch (_) { /* a stale pointer is harmless: the API checks the job it names */ }
  }
}

main().catch((error) => {
  console.error(`[cloud] sandbox build crashed: ${error && error.stack}`);
  process.exit(1);
});
