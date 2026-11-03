'use strict';
// Open-Birdie cloud course service on Vercel: the v1 API (cloud/app.js) over a
// Vercel Blob store (cloud/vercel-blob-store.js), each build in its own Vercel
// Sandbox (cloud/sandbox-jobs.js). Deployed from cloud/vercel/ (see README.md,
// "Cloud courses"); every path is rewritten to this function.
//
// Environment (Vercel project settings):
//   BIRDIE_CLOUD_BUILD_TOKEN   bearer token required to start builds (unset = read-only)
//   BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID (+ OIDC)   the connected Blob store
//   BIRDIE_CLOUD_REPO / BIRDIE_CLOUD_REF   the repository + branch builds run (default: the fork's main)
//   BIRDIE_OVERPASS_URLS       extra Overpass mirrors for builds to try first

const { createCloudService } = require('../cloud/app');
const { createSandboxJobs } = require('../cloud/sandbox-jobs');
const { createVercelBlobStore } = require('../cloud/vercel-blob-store');

let service = null;

module.exports = async function handler(req, res) {
  if (!service) {
    const store = createVercelBlobStore();
    service = createCloudService({
      store,
      queue: createSandboxJobs({ store }),
      buildToken: String(process.env.BIRDIE_CLOUD_BUILD_TOKEN || '').trim() || null,
      fileMode: 'redirect',
    });
  }
  return service.handle(req, res);
};
