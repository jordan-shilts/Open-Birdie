'use strict';
// A minimal S3 client for the cloud course service: AWS Signature Version 4 with
// node:crypto (no AWS SDK), enough for any S3-compatible store — Railway Buckets,
// Cloudflare R2, Supabase Storage, MinIO, AWS S3:
//   PUT / GET / HEAD / DELETE object, and presigned GET URLs.
//
// Path style (https://endpoint/bucket/key) or virtual-hosted style
// (https://bucket.endpoint/key) — Railway's current buckets and AWS use virtual
// hosting, MinIO and older Railway buckets path style.

const crypto = require('node:crypto');

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 3986 percent-encoding as SigV4 requires: only A-Z a-z 0-9 - . _ ~ stay
// (and '/' when encoding an object key path), hex digits upper case.
function uriEncode(value, { keepSlash = false } = {}) {
  let out = '';
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const isUnreserved = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e;
    if (isUnreserved || (keepSlash && byte === 0x2f)) out += String.fromCharCode(byte);
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

// 2015-08-30T12:36:00.000Z -> 20150830T123600Z
function amzDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function canonicalQueryString(pairs) {
  return pairs
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function canonicalHeaders(headers) {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase().trim(), String(value).trim().replace(/\s+/g, ' ')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    block: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
    signed: entries.map(([name]) => name).join(';'),
  };
}

// The URL's path must already be SigV4-encoded (build it with uriEncode); S3 does
// not normalize or double-encode it.
function signingParts(url) {
  const u = new URL(url);
  return { u, canonicalUri: u.pathname || '/', query: [...u.searchParams.entries()] };
}

// Sign a request in the Authorization header. Returns the headers to send (host is
// left to the HTTP client, which sends the same value) plus the intermediate
// strings for debugging/tests.
function signRequest({
  method,
  url,
  headers = {},
  payloadHash = EMPTY_SHA256,
  accessKeyId,
  secretAccessKey,
  sessionToken = null,
  region,
  service = 's3',
  date = new Date(),
}) {
  const { u, canonicalUri, query } = signingParts(url);
  const datetime = amzDate(date);
  const day = datetime.slice(0, 8);
  const toSign = { ...headers, host: u.host, 'x-amz-date': datetime };
  if (sessionToken) toSign['x-amz-security-token'] = sessionToken;
  const { block, signed } = canonicalHeaders(toSign);
  const canonicalRequest = [method, canonicalUri, canonicalQueryString(query), block, signed, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, datetime, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(secretAccessKey, day, region, service), stringToSign).toString('hex');
  const sendHeaders = {};
  for (const [name, value] of Object.entries(toSign)) if (name.toLowerCase() !== 'host') sendHeaders[name] = value;
  sendHeaders.authorization = `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  return { headers: sendHeaders, canonicalRequest, stringToSign, signature };
}

// A presigned URL (query-string auth): anyone holding it may `method` the object
// until it expires. S3 signs it with an UNSIGNED-PAYLOAD body hash.
function presignUrl({
  method = 'GET',
  url,
  accessKeyId,
  secretAccessKey,
  sessionToken = null,
  region,
  service = 's3',
  expiresSec = 900,
  date = new Date(),
  payloadHash = UNSIGNED_PAYLOAD,
}) {
  const { u, canonicalUri, query } = signingParts(url);
  const datetime = amzDate(date);
  const day = datetime.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const { block, signed } = canonicalHeaders({ host: u.host });
  const params = [
    ...query,
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', datetime],
    ['X-Amz-Expires', String(Math.max(1, Math.min(604800, Math.round(expiresSec))))],
    ...(sessionToken ? [['X-Amz-Security-Token', sessionToken]] : []),
    ['X-Amz-SignedHeaders', signed],
  ];
  const canonicalQuery = canonicalQueryString(params);
  const canonicalRequest = [method, canonicalUri, canonicalQuery, block, signed, payloadHash].join('\n');
  const stringToSign = [ALGORITHM, datetime, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(secretAccessKey, day, region, service), stringToSign).toString('hex');
  return { url: `${u.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`, canonicalRequest, signature };
}

class S3Error extends Error {
  constructor(status, code, message) {
    super(`S3 ${status} ${code}${message ? `: ${message}` : ''}`);
    this.name = 'S3Error';
    this.status = status;
    this.code = code;
  }
}

async function s3Error(res) {
  const text = await res.text().catch(() => '');
  const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1] || `HTTP_${res.status}`;
  const message = (/<Message>([^<]+)<\/Message>/.exec(text) || [])[1] || '';
  return new S3Error(res.status, code, message);
}

function createS3Client({
  endpoint,
  bucket,
  region = 'us-east-1',
  accessKeyId,
  secretAccessKey,
  sessionToken = null,
  forcePathStyle = false,
  publicEndpoint = null, // presigned URLs for clients outside the service's network
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new TypeError('S3 client needs an endpoint, a bucket and credentials');
  }
  const signer = { accessKeyId, secretAccessKey, sessionToken, region: region || 'us-east-1', service: 's3' };

  function objectUrl(key, base = endpoint) {
    const e = new URL(base);
    const prefix = e.pathname.replace(/\/+$/, '');
    const encodedKey = uriEncode(key, { keepSlash: true });
    // an endpoint with a path (Supabase: .../storage/v1/s3) only works path style
    if (forcePathStyle || prefix) return `${e.origin}${prefix}/${uriEncode(bucket)}/${encodedKey}`;
    return `${e.protocol}//${bucket}.${e.host}/${encodedKey}`;
  }

  async function send(method, key, { body = null, contentType = null, signal } = {}) {
    const url = objectUrl(key);
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
    const headers = { 'x-amz-content-sha256': payloadHash };
    if (contentType) headers['content-type'] = contentType;
    const signed = signRequest({ method, url, headers, payloadHash, date: now(), ...signer });
    return fetchImpl(url, { method, headers: signed.headers, body: body || undefined, signal });
  }

  return Object.freeze({
    bucket,
    objectUrl,
    async getObject(key, { signal } = {}) {
      const res = await send('GET', key, { signal });
      if (res.status === 404) return null;
      if (!res.ok) throw await s3Error(res);
      return Buffer.from(await res.arrayBuffer());
    },
    async headObject(key, { signal } = {}) {
      const res = await send('HEAD', key, { signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new S3Error(res.status, `HTTP_${res.status}`, '');
      return { size: Number(res.headers.get('content-length')), contentType: res.headers.get('content-type'), etag: res.headers.get('etag') };
    },
    async putObject(key, bytes, { contentType = 'application/octet-stream', signal } = {}) {
      const res = await send('PUT', key, { body: Buffer.from(bytes), contentType, signal });
      if (!res.ok) throw await s3Error(res);
      await res.arrayBuffer().catch(() => null);
    },
    async deleteObject(key, { signal } = {}) {
      const res = await send('DELETE', key, { signal });
      if (!res.ok && res.status !== 404) throw await s3Error(res);
      await res.arrayBuffer().catch(() => null);
    },
    presignGetObject(key, { expiresSec = 900 } = {}) {
      return presignUrl({ method: 'GET', url: objectUrl(key, publicEndpoint || endpoint), expiresSec, date: now(), ...signer }).url;
    },
  });
}

module.exports = {
  EMPTY_SHA256,
  S3Error,
  UNSIGNED_PAYLOAD,
  amzDate,
  createS3Client,
  presignUrl,
  signRequest,
  signingKey,
  uriEncode,
};
