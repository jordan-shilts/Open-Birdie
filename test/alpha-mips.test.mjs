// Coverage-preserving foliage alpha mipmaps (public/render/alpha-mips.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downsample, coverage, coverageMipChain } from '../public/render/alpha-mips.js';

// 64x64 alpha: scattered opaque leaf texels (~30%) over transparent — box filtering
// averages them toward ~76/255, so an alpha test at 128 erases the canopy.
function leaves(w = 64, h = 64) {
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const a = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = rnd() < 0.3 ? 255 : 0;
  return a;
}

test('downsample is a 2x2 box filter', () => {
  const a = new Uint8Array([0, 255, 255, 255]);
  const d = downsample(a, 2, 2);
  assert.equal(d.w, 1); assert.equal(d.h, 1);
  assert.equal(d.alpha[0], 191);
});

test('plain box mips lose coverage; the coverage chain keeps it per tile', () => {
  const a0 = leaves();
  const full = { x: 0, y: 0, w: 64, h: 64 };
  const target = coverage(a0, 64, full, 128);
  // naive: two box levels down, thin leaves fall under the cutoff
  const naive = downsample(downsample(a0, 64, 64).alpha, 32, 32);
  const naiveCov = coverage(naive.alpha, 16, { x: 0, y: 0, w: 16, h: 16 }, 128);
  assert.ok(Math.abs(naiveCov - target) > 0.15, `naive ${naiveCov} vs ${target}`);
  const chain = coverageMipChain(a0, 64, 64, { tiles: 2, cutoff: 128 });
  assert.equal(chain.at(-1).w, 1);
  assert.equal(chain.length, 7);                       // 64,32,16,8,4,2,1
  for (const lvl of chain.slice(1, 4)) {
    const cov = coverage(lvl.alpha, lvl.w, { x: 0, y: 0, w: lvl.w, h: lvl.h }, 128);
    assert.ok(Math.abs(cov - target) < 0.12, `level ${lvl.w}: ${cov} vs ${target}`);
  }
});

test('an empty tile stays empty (no opaque shards at distance)', () => {
  const w = 64, a0 = new Uint8Array(w * w);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) a0[y * w + x] = (x * 7 + y * 3) % 5 === 0 ? 255 : 0; // tile 0 only
  const chain = coverageMipChain(a0, w, w, { tiles: 2, cutoff: 128 });
  const l = chain[2];                                  // 16x16
  assert.equal(coverage(l.alpha, l.w, { x: 8, y: 8, w: 8, h: 8 }, 128), 0);
});
