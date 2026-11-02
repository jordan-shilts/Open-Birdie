'use strict';
// Pure/offline tests for the LIDAR patch sampler, and fetchPatch's retry rules
// against a fake 3DEP service (injected fetchImpl) — npm test stays offline and
// deterministic. The live service is verified separately.

const { test } = require('node:test');
const assert = require('node:assert');
const { fetchPatch, makePatchSampler } = require('../lib/lidar');

// 2x2 patch over a 100x100 mercator square. Row 0 is the top (y = ymax).
//   top row    (y=ymax): [TL=0,  TR=10]
//   bottom row (y=ymin): [BL=20, BR=30]
const patch = {
  xmin: 0, ymin: 0, xmax: 100, ymax: 100, width: 2, height: 2,
  heights: new Float32Array([0, 10, 20, 30]),
};
const sample = makePatchSampler(patch);

test('corners return their exact pixel values', () => {
  assert.strictEqual(sample(0, 100), 0);   // top-left
  assert.strictEqual(sample(100, 100), 10); // top-right
  assert.strictEqual(sample(0, 0), 20);     // bottom-left
  assert.strictEqual(sample(100, 0), 30);   // bottom-right
});

test('center is the bilinear average of all four corners', () => {
  assert.strictEqual(sample(50, 50), 15); // (0+10+20+30)/4
});

test('returns null outside the patch extent', () => {
  assert.strictEqual(sample(150, 50), null);
  assert.strictEqual(sample(50, -1), null);
});

test('returns null when any corner is NoData', () => {
  const nd = makePatchSampler({
    xmin: 0, ymin: 0, xmax: 1, ymax: 1, width: 2, height: 2,
    heights: new Float32Array([-3.5e38, 5, 6, 7]),
  });
  assert.strictEqual(nd(0.5, 0.5), null);
});

// ---------- fetchPatch retries ----------

const bbox = { west: -93.6, south: 44.8, east: -93.59, north: 44.81 };
const meta = { width: 2, height: 2, extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } };
function fake3dep(script) {
  const calls = [];
  const fetchImpl = async (url) => {
    const kind = url.includes('f=json') ? 'meta' : 'image';
    calls.push(kind);
    const step = script(kind, calls.filter((k) => k === kind).length);
    if (step instanceof Error) throw step;
    if (typeof step === 'number') return { ok: false, status: step };
    return kind === 'meta'
      ? { ok: true, json: async () => meta }
      : { ok: true, arrayBuffer: async () => new Float32Array(step).buffer };
  };
  return { calls, fetchImpl };
}

test('a slow or dropped 3DEP request is retried and the patch returned', async () => {
  const { calls, fetchImpl } = fake3dep((kind, n) => (kind === 'meta' && n === 1 ? new Error('socket hang up') : [1, 2, 3, 4]));
  const patch = await fetchPatch(bbox, { fetchImpl, attempts: 3, backoffMs: 1 });
  assert.ok(patch);
  assert.deepStrictEqual(Array.from(patch.heights), [1, 2, 3, 4]);
  assert.deepStrictEqual(calls, ['meta', 'meta', 'image']);
});

test('after the last attempt it gives up with null, never throws', async () => {
  const { calls, fetchImpl } = fake3dep(() => 503);
  assert.strictEqual(await fetchPatch(bbox, { fetchImpl, attempts: 3, backoffMs: 1 }), null);
  assert.strictEqual(calls.length, 3);
});

test('no lidar there (all NoData) is final: not retried', async () => {
  const { calls, fetchImpl } = fake3dep(() => [-3.5e38, -3.5e38, -3.5e38, -3.5e38]);
  assert.strictEqual(await fetchPatch(bbox, { fetchImpl, attempts: 3, backoffMs: 1 }), null);
  assert.deepStrictEqual(calls, ['meta', 'image']);
});

test('one attempt by default (the original best-effort contract)', async () => {
  const { calls, fetchImpl } = fake3dep(() => 503);
  assert.strictEqual(await fetchPatch(bbox, { fetchImpl }), null);
  assert.strictEqual(calls.length, 1);
});
