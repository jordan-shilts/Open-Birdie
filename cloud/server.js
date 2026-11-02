'use strict';
// Open-Birdie cloud course service: builds each course once — OpenStreetMap
// holes and buildings, USGS 3DEP lidar terrain, the max-quality USGS NAIP aerial,
// Meta/WRI canopy trees — packages it, keeps it in object storage and serves it
// to every desktop app (BIRDIE_CLOUD_URL). API: cloud/app.js. Deployment: the
// "Cloud courses" section of README.md.
//
//   node cloud/server.js
//
// Environment:
//   PORT / BIRDIE_CLOUD_PORT     listen port (default 8080; Railway sets PORT)
//   BIRDIE_CLOUD_BUILD_TOKEN     bearer token required to start builds (unset = read-only)
//   S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
//                                object storage (S3_FORCE_PATH_STYLE=1 for MinIO and
//                                older Railway buckets; S3_PUBLIC_ENDPOINT when clients
//                                must reach the store under another URL)
//   BIRDIE_CLOUD_STORE_DIR       directory store when S3_BUCKET is unset (default ./cloud-store)
//   BIRDIE_CLOUD_FILES           redirect (presigned URLs, default with S3) | proxy
//   BIRDIE_CLOUD_CONCURRENCY     builds at once (default 1)
//   BIRDIE_CLOUD_MAX_QUEUE       builds waiting (default 16)
//   BIRDIE_DATA_DIR              build scratch dir (default <tmp>/birdie-cloud-staging)
//   BIRDIE_OVERPASS_URLS         extra Overpass mirrors to try first (as on the desktop)

const os = require('node:os');
const path = require('node:path');

// lib/course.js fixes its cache dir when first required: builds stage there.
if (!process.env.BIRDIE_DATA_DIR) process.env.BIRDIE_DATA_DIR = path.join(os.tmpdir(), 'birdie-cloud-staging');

const http = require('node:http');
const { createCloudService } = require('./app');
const { createCourseBuilder } = require('./builder');
const { buildHdHoles, hdManifestsFor } = require('./hd-holes');
const { createJobQueue } = require('./jobs');
const { storeFromEnv } = require('./store');

const positiveInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

function optionalSharp(log) {
  try { return require('sharp'); }
  catch (error) {
    log.warn(`[cloud] sharp is not installed (${error.message}); aerials will be the single-request kind`);
    return null;
  }
}

// Start the service. store/build are injectable (tests); by default they come
// from the environment and the real course pipeline.
async function startCloudServer({
  env = process.env,
  port = positiveInt(env.PORT || env.BIRDIE_CLOUD_PORT, 8080),
  host = env.BIRDIE_CLOUD_HOST || '0.0.0.0',
  store = storeFromEnv(env),
  build = null,
  log = console,
} = {}) {
  let run = build;
  if (!run) {
    const { loadCourse } = require('../lib/course');
    const { localSceneryProviders } = require('../lib/course-enrichment');
    const sharp = optionalSharp(log);
    run = createCourseBuilder({
      dataDir: env.BIRDIE_DATA_DIR || process.env.BIRDIE_DATA_DIR,
      store,
      loadCourse,
      providers: localSceneryProviders({ aerialQuality: sharp ? 'tiled' : 'single', sharp, canopy: true }),
      aerialQuality: sharp ? 'tiled' : 'single',
      // HD holes need tools/hd-course in the deployment (the container image leaves it
      // out, so there are no manifests and no HD step)
      hd: { manifestsFor: hdManifestsFor, build: buildHdHoles },
      log,
    });
  }
  const queue = createJobQueue({
    run,
    concurrency: positiveInt(env.BIRDIE_CLOUD_CONCURRENCY, 1),
    maxQueued: positiveInt(env.BIRDIE_CLOUD_MAX_QUEUE, 16),
    log,
  });
  const fileMode = env.BIRDIE_CLOUD_FILES === 'proxy' || env.BIRDIE_CLOUD_FILES === 'redirect'
    ? env.BIRDIE_CLOUD_FILES
    : (store.kind === 's3' ? 'redirect' : 'proxy');
  const buildToken = String(env.BIRDIE_CLOUD_BUILD_TOKEN || '').trim() || null;
  const service = createCloudService({ store, queue, buildToken, fileMode, log });
  const server = http.createServer((req, res) => { service.handle(req, res); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const actualPort = server.address().port;
  log.log(`[cloud] Open-Birdie cloud courses on :${actualPort} — store: ${store.describe()}, files: ${fileMode}, ` +
    `builds: ${buildToken ? 'enabled' : 'disabled (no BIRDIE_CLOUD_BUILD_TOKEN)'}`);
  return {
    server,
    port: actualPort,
    queue,
    close() {
      queue.close();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        // keep-alive clients must not hold a redeploy up
        setTimeout(() => server.closeAllConnections(), 2000).unref();
      });
    },
  };
}

if (require.main === module) {
  startCloudServer().then((running) => {
    const stop = () => { running.close().then(() => process.exit(0)); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }, (error) => {
    console.error(`[cloud] failed to start: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { startCloudServer };
