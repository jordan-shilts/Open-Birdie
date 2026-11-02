'use strict';
// The cloud's build queue, in memory: one build per course at a time (a second
// request for the same course joins the running job), a bounded waiting list, and
// a fixed number of builds running at once (BIRDIE_CLOUD_CONCURRENCY, default 1 —
// the public map, lidar and imagery services prefer polite clients). Finished jobs
// are kept for an hour so clients can read the outcome. A restart forgets jobs;
// clients then re-request the build, and any package already published survives
// in the object store.

const crypto = require('node:crypto');

class QueueFullError extends Error {
  constructor(max) {
    super(`the build queue is full (${max} waiting)`);
    this.name = 'QueueFullError';
    this.code = 'QUEUE_FULL';
  }
}

// Only errors written for players (CourseLoadError: not a golf course, no hole
// lines, map servers busy) are passed on verbatim; anything else stays generic.
function describeFailure(error) {
  if (error && error.userFacing === true && typeof error.code === 'string' && typeof error.message === 'string') {
    return {
      code: error.code,
      message: error.message.slice(0, 300),
      userFacing: true,
      ...(typeof error.recovery === 'string' ? { recovery: error.recovery.slice(0, 300) } : {}),
    };
  }
  return { code: 'BUILD_FAILED', message: 'The course could not be built.', userFacing: false };
}

function createJobQueue({
  run,
  concurrency = 1,
  maxQueued = 16,
  keepMs = 60 * 60 * 1000,
  maxJobs = 500,
  now = Date.now,
  log = console,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('Job queue needs a run function');
  const jobs = new Map(); // id -> job
  const activeByKey = new Map(); // course key -> job id (queued or running)
  const waiting = [];
  const settling = new Map(); // id -> promise
  const controllers = new Map();
  let running = 0;
  let closed = false;
  const iso = (t) => new Date(t).toISOString();

  function view(job) {
    const { payload, ...rest } = job;
    return structuredClone(rest);
  }

  function prune() {
    const cutoff = now() - keepMs;
    for (const [id, job] of jobs) {
      if (job.finishedAt && (Date.parse(job.finishedAt) < cutoff || jobs.size > maxJobs)) jobs.delete(id);
    }
  }

  function start(job) {
    running++;
    Object.assign(job, { status: 'running', stage: 'starting', message: 'starting', startedAt: iso(now()) });
    const controller = new AbortController();
    controllers.set(job.id, controller);
    const update = (fields = {}) => {
      for (const key of ['stage', 'message', 'pct', 'packageId', 'complete', 'hd']) {
        if (fields[key] !== undefined) job[key] = fields[key];
      }
    };
    const settled = Promise.resolve()
      .then(() => run(job.payload, { update, signal: controller.signal, job: view(job) }))
      .then(() => {
        Object.assign(job, { status: 'done', stage: 'done', message: 'done', pct: 100 });
      }, (error) => {
        if (closed) {
          // Shutting down (a redeploy): not the course's fault. Clients keep
          // polling, find the job gone on the new instance and ask again.
          Object.assign(job, { status: 'interrupted', stage: 'interrupted', message: 'the service is restarting' });
          return;
        }
        job.error = describeFailure(error);
        Object.assign(job, { status: 'failed', stage: 'failed', message: job.error.message });
        log.error(`[cloud] build ${job.key} failed: ${error && (error.code || '')} ${error && error.message}`);
      })
      .finally(() => {
        job.finishedAt = iso(now());
        running--;
        controllers.delete(job.id);
        settling.delete(job.id);
        if (activeByKey.get(job.key) === job.id) activeByKey.delete(job.key);
        prune();
        pump();
      });
    settling.set(job.id, settled);
  }

  function pump() {
    while (!closed && running < concurrency && waiting.length) start(waiting.shift());
  }

  return Object.freeze({
    // Queue a build for a course key, or join the one already queued/running.
    submit(key, payload) {
      const activeId = activeByKey.get(key);
      if (activeId && jobs.has(activeId)) return { job: view(jobs.get(activeId)), created: false };
      if (closed) throw new Error('the build queue is closed');
      if (waiting.length >= maxQueued) throw new QueueFullError(maxQueued);
      const job = {
        id: crypto.randomUUID(),
        key,
        courseId: payload && payload.courseId,
        status: 'queued',
        stage: 'queued',
        message: 'waiting for a build slot',
        pct: 0,
        packageId: null,
        complete: false,
        createdAt: iso(now()),
        startedAt: null,
        finishedAt: null,
        error: null,
        payload,
      };
      jobs.set(job.id, job);
      activeByKey.set(key, job.id);
      waiting.push(job);
      pump();
      return { job: view(job), created: true };
    },
    get(id) {
      const job = jobs.get(id);
      return job ? view(job) : null;
    },
    activeFor(key) {
      const id = activeByKey.get(key);
      return id && jobs.has(id) ? view(jobs.get(id)) : null;
    },
    stats() {
      return { running, waiting: waiting.length, kept: jobs.size, concurrency, maxQueued };
    },
    // Resolves when nothing is running or waiting (tests, shutdown).
    async idle() {
      while (settling.size || waiting.length) await Promise.all([...settling.values()]);
    },
    close() {
      closed = true;
      waiting.length = 0;
      for (const controller of controllers.values()) controller.abort();
    },
  });
}

module.exports = { QueueFullError, createJobQueue, describeFailure };
