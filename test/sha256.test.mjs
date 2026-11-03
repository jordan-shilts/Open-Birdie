import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256Hex } from '../public/render/sha256.js';

const node = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('matches the published SHA-256 test vectors', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(sha256Hex(enc('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(enc('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('matches node:crypto at every padding boundary and on large inputs', () => {
  for (const n of [1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 65543, 1 << 20]) {
    const bytes = new Uint8Array(randomBytes(n));
    assert.equal(sha256Hex(bytes), node(bytes), `length ${n}`);
  }
});

test('hashes only the bytes a view covers', () => {
  const buf = new Uint8Array(randomBytes(300));
  const view = buf.subarray(17, 250);
  assert.equal(sha256Hex(view), node(view));
  const floats = new Float32Array([1.5, -2, 3.25]);
  assert.equal(sha256Hex(new Uint8Array(floats.buffer)), node(new Uint8Array(floats.buffer)));
});
