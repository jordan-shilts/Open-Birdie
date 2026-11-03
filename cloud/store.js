'use strict';
// Where the cloud service keeps course packages: an S3-compatible bucket (S3_*
// env) or, for local runs and tests, a directory (BIRDIE_CLOUD_STORE_DIR).
//
// Layout (same in both):
//   courses/<key>/manifest.json        the latest package manifest (replaced last)
//   courses/<key>/blobs/<sha256>       package files, content-addressed: a file
//                                      unchanged between package versions (the HD
//                                      bundles, the classmap) is uploaded once

const fs = require('node:fs');
const path = require('node:path');

const OBJECT_KEY = /^courses\/osm-(node|way|relation)-[1-9][0-9]{0,15}\/(manifest\.json|blobs\/[a-f0-9]{64})$/;

function checkKey(key) {
  if (!OBJECT_KEY.test(key)) throw new TypeError(`unexpected object key ${key}`);
  return key;
}

const manifestKey = (courseKey) => `courses/${courseKey}/manifest.json`;
const blobKey = (courseKey, sha256) => `courses/${courseKey}/blobs/${sha256}`;

function createFsStore(root) {
  const resolve = (key) => path.join(root, ...checkKey(key).split('/'));
  let nonce = 0;
  const write = (file, bytes) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp.${process.pid}-${Date.now()}-${++nonce}`;
    try {
      fs.writeFileSync(temporary, bytes);
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  };
  return Object.freeze({
    kind: 'fs',
    describe: () => `directory ${root}`,
    async getJson(key) {
      try { return JSON.parse(fs.readFileSync(resolve(key), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async putJson(key, value) { write(resolve(key), JSON.stringify(value)); },
    async hasBlob(key) { return fs.existsSync(resolve(key)); },
    async putBlob(key, bytes) { write(resolve(key), bytes); },
    async readBlob(key) {
      try { return fs.readFileSync(resolve(key)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    blobUrl: () => null, // served by the service itself
  });
}

function createS3Store(client) {
  return Object.freeze({
    kind: 's3',
    describe: () => `bucket ${client.bucket}`,
    async getJson(key) {
      const bytes = await client.getObject(checkKey(key));
      return bytes ? JSON.parse(bytes.toString('utf8')) : null;
    },
    async putJson(key, value) {
      await client.putObject(checkKey(key), Buffer.from(JSON.stringify(value)), { contentType: 'application/json' });
    },
    async hasBlob(key) { return Boolean(await client.headObject(checkKey(key))); },
    async putBlob(key, bytes, { contentType } = {}) { await client.putObject(checkKey(key), bytes, { contentType }); },
    async readBlob(key) { return client.getObject(checkKey(key)); },
    blobUrl: (key, { expiresSec = 900 } = {}) => client.presignGetObject(checkKey(key), { expiresSec }),
  });
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

// S3 when S3_BUCKET is set (S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID,
// S3_SECRET_ACCESS_KEY, optional S3_FORCE_PATH_STYLE, S3_PUBLIC_ENDPOINT,
// S3_SESSION_TOKEN), else a directory.
function storeFromEnv(env = process.env, { fetchImpl } = {}) {
  if (env.S3_BUCKET) {
    const missing = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((name) => !env[name]);
    if (missing.length) throw new Error(`S3_BUCKET is set but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing`);
    const { createS3Client } = require('./s3');   // not needed by the Vercel deployment
    return createS3Store(createS3Client({
      endpoint: env.S3_ENDPOINT,
      bucket: env.S3_BUCKET,
      region: env.S3_REGION || 'us-east-1',
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      sessionToken: env.S3_SESSION_TOKEN || null,
      forcePathStyle: truthy(env.S3_FORCE_PATH_STYLE),
      publicEndpoint: env.S3_PUBLIC_ENDPOINT || null,
      ...(fetchImpl ? { fetchImpl } : {}),
    }));
  }
  return createFsStore(path.resolve(env.BIRDIE_CLOUD_STORE_DIR || path.join(process.cwd(), 'cloud-store')));
}

module.exports = {
  blobKey,
  createFsStore,
  createS3Store,
  manifestKey,
  storeFromEnv,
};
