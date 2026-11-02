'use strict';
// Course packages in Vercel Blob: the store for the cloud service on Vercel, with
// the same interface as store.js (getJson / putJson / hasBlob / putBlob / readBlob /
// blobUrl), plus build-job records for cloud/sandbox-jobs.js.
//
// Public access: a package is open data (OpenStreetMap, USGS, Meta/WRI), and public
// blob URLs let the desktop download files straight from Vercel's CDN. Manifests and
// job records are rewritten in place, so they are written with a short cache life
// and read past the CDN; package files are content-addressed and cached for good.
// Credentials come from the environment the way @vercel/blob reads them
// (BLOB_READ_WRITE_TOKEN, or a Vercel OIDC token + BLOB_STORE_ID).

const OBJECT_KEY = /^courses\/osm-(node|way|relation)-[1-9][0-9]{0,15}\/(manifest\.json|blobs\/[a-f0-9]{64})$/;
const JOB_KEY = /^jobs\/([0-9a-f-]{36}|active\/osm-(node|way|relation)-[1-9][0-9]{0,15})\.json$/;

const jobKey = (id) => `jobs/${id}.json`;
const activeJobKey = (courseKey) => `jobs/active/${courseKey}.json`;

function check(re, key) {
  if (!re.test(key)) throw new TypeError(`unexpected object key ${key}`);
  return key;
}

async function streamBytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// blob: the @vercel/blob module (injectable for tests).
function createVercelBlobStore({ blob = require('@vercel/blob'), describeAs = 'Vercel Blob' } = {}) {
  const access = 'public';
  const isMissing = (error) => error instanceof blob.BlobNotFoundError || (error && error.name === 'BlobNotFoundError');

  async function readBytes(key, { fresh = false } = {}) {
    const result = await blob.get(key, { access, useCache: !fresh });
    if (!result || result.statusCode !== 200) return null;
    return streamBytes(result.stream);
  }
  async function readJson(key) {
    const bytes = await readBytes(key, { fresh: true });
    return bytes ? JSON.parse(bytes.toString('utf8')) : null;
  }
  async function writeJson(key, value) {
    await blob.put(key, JSON.stringify(value), {
      access, addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60,
    });
  }

  return Object.freeze({
    kind: 'vercel-blob',
    describe: () => describeAs,
    getJson: async (key) => readJson(check(OBJECT_KEY, key)),
    putJson: async (key, value) => writeJson(check(OBJECT_KEY, key), value),
    async hasBlob(key) {
      try { await blob.head(check(OBJECT_KEY, key)); return true; }
      catch (error) { if (isMissing(error)) return false; throw error; }
    },
    async putBlob(key, bytes, { contentType } = {}) {
      await blob.put(check(OBJECT_KEY, key), bytes, {
        access, addRandomSuffix: false, allowOverwrite: true,
        contentType: contentType || 'application/octet-stream',
        cacheControlMaxAge: 365 * 24 * 3600,   // content-addressed: never changes
      });
    },
    readBlob: async (key) => readBytes(check(OBJECT_KEY, key)),
    // The file's public URL (the desktop is redirected there), or null if missing.
    async blobUrl(key) {
      try { return (await blob.head(check(OBJECT_KEY, key))).url; }
      catch (error) { if (isMissing(error)) return null; throw error; }
    },
    // build-job records (cloud/sandbox-jobs.js)
    getRecord: async (key) => readJson(check(JOB_KEY, key)),
    putRecord: async (key, value) => writeJson(check(JOB_KEY, key), value),
    async deleteRecord(key) { await blob.del(check(JOB_KEY, key)); },
  });
}

module.exports = { activeJobKey, createVercelBlobStore, jobKey };
