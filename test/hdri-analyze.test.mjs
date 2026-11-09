import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunSphericalFromEquirect, sunDirectionVec, horizonColorFromEquirect, clampEquirectRadiance, HALF_FLOAT_SAFE_MAX } from '../public/render/hdri-analyze.js';

// Build a tiny equirect: dark everywhere, one very bright texel.
function makeEquirect(w, h, brightX, brightY, rgb = [50, 50, 50]) {
  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 0.2; data[i * 4 + 1] = 0.2; data[i * 4 + 2] = 0.2; data[i * 4 + 3] = 1;
  }
  const idx = (brightY * w + brightX) * 4;
  data[idx] = rgb[0]; data[idx + 1] = rgb[1]; data[idx + 2] = rgb[2]; data[idx + 3] = 1;
  return { data, width: w, height: h };
}

test('sun azimuth/altitude derive from the brightest texel', () => {
  // bright texel at u = 1/4 width (az = π/2), v = 1/4 height (high in the sky)
  const { data, width, height } = makeEquirect(16, 8, 4, 2);
  const s = sunSphericalFromEquirect(data, width, height);
  assert.ok(Math.abs(s.azimuth - Math.PI / 2) < 0.5, `az ${s.azimuth}`);
  assert.ok(s.altitude > 0.4, `alt should be well above horizon, got ${s.altitude}`);
});

test('a texel on the bottom half yields a below-or-near-horizon altitude', () => {
  const { data, width, height } = makeEquirect(16, 8, 8, 6); // v = 6/8, below mid
  const s = sunSphericalFromEquirect(data, width, height);
  assert.ok(s.altitude < 0.3, `alt ${s.altitude}`);
});

test('horizon color samples the mid rows and returns a 0xRRGGBB int', () => {
  const c = horizonColorFromEquirect(new Float32Array(16 * 8 * 4).fill(0.5), 16, 8);
  assert.equal(typeof c, 'number');
  assert.ok(c >= 0 && c <= 0xffffff);
});

test('sunDirectionVec maps spherical to THREE axes with correct handedness', () => {
  const up = sunDirectionVec(0, Math.PI / 2);
  assert.ok(Math.abs(up.y - 1) < 1e-9 && Math.abs(up.x) < 1e-9 && Math.abs(up.z) < 1e-9, 'straight up -> +Y');
  const east = sunDirectionVec(Math.PI / 2, 0);
  assert.ok(Math.abs(east.x - 1) < 1e-9 && Math.abs(east.z) < 1e-9, 'east -> +X');
  const north = sunDirectionVec(0, 0);
  assert.ok(Math.abs(north.z + 1) < 1e-9 && Math.abs(north.x) < 1e-9, 'north -> -Z');
});

test('a sun disc past half-float range is clamped; the rest of the sky is untouched', () => {
  const { data } = makeEquirect(16, 8, 4, 2, [75559, 70000, 3]);
  const before = Float32Array.from(data);
  const changed = clampEquirectRadiance(data);
  assert.equal(changed, 2, 'only the two channels over the cap change');
  const idx = (2 * 16 + 4) * 4;
  assert.equal(data[idx], HALF_FLOAT_SAFE_MAX);
  assert.equal(data[idx + 1], HALF_FLOAT_SAFE_MAX);
  assert.equal(data[idx + 2], 3);
  for (let i = 0; i < data.length; i++) if (i !== idx && i !== idx + 1) assert.equal(data[i], before[i]);
  assert.ok(HALF_FLOAT_SAFE_MAX < 65504, 'the cap fits a half-float');
});

test('non-finite and negative radiance cannot reach the GPU', () => {
  const data = new Float32Array([NaN, Infinity, -1, 1, 0.5, 2, 3, 1]);
  assert.equal(clampEquirectRadiance(data), 3);
  assert.deepEqual([...data], [HALF_FLOAT_SAFE_MAX, HALF_FLOAT_SAFE_MAX, 0, 1, 0.5, 2, 3, 1]);
});

test('a sky already in range is left alone (no re-upload)', () => {
  const data = new Float32Array(16 * 8 * 4).fill(0.5);
  assert.equal(clampEquirectRadiance(data), 0);
});

test('the sun is still found after the clamp flattens its disc', () => {
  const { data, width, height } = makeEquirect(16, 8, 4, 2, [75559, 75559, 75559]);
  const raw = sunSphericalFromEquirect(data, width, height);
  clampEquirectRadiance(data);
  const clamped = sunSphericalFromEquirect(data, width, height);
  assert.deepEqual(clamped, raw);
});
