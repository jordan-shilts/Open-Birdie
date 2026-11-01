// Graphics quality setting resolver + auto-downshift rule (public/render/quality.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUALITY_PRESETS, parseQualitySetting, initialAutoLevel, resolveQuality,
  autoDownshiftVerdict, qualityLabel, nextQualitySetting,
} from '../public/render/quality.js';

test('parseQualitySetting accepts the three settings and defaults to auto', () => {
  assert.equal(parseQualitySetting('High'), 'high');
  assert.equal(parseQualitySetting(' low '), 'low');
  assert.equal(parseQualitySetting('auto'), 'auto');
  assert.equal(parseQualitySetting('ultra'), 'auto');
  assert.equal(parseQualitySetting(null), 'auto');
});

test('explicit settings win over the environment', () => {
  const weak = { gpuRenderer: 'Google SwiftShader', mobile: true };
  assert.equal(resolveQuality('high', weak).level, 'high');
  assert.equal(resolveQuality('low', { gpuRenderer: 'Apple M3 Pro' }).level, 'low');
  assert.equal(resolveQuality('high', weak).preset, QUALITY_PRESETS.high);
});

test('auto starts Low on software / integrated / mobile GPUs and High otherwise', () => {
  assert.equal(initialAutoLevel({ gpuRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)' }).level, 'high');
  assert.equal(initialAutoLevel({ gpuRenderer: 'ANGLE (NVIDIA GeForce RTX 3060)' }).level, 'high');
  assert.equal(initialAutoLevel({ gpuRenderer: 'Google SwiftShader' }).level, 'low');
  assert.equal(initialAutoLevel({ gpuRenderer: 'llvmpipe (LLVM 15.0.7, 256 bits)' }).level, 'low');
  assert.equal(initialAutoLevel({ gpuRenderer: 'ANGLE (Intel(R) UHD Graphics 620)' }).level, 'low');
  assert.equal(initialAutoLevel({ gpuRenderer: 'Apple GPU', mobile: true }).level, 'low');
  assert.equal(initialAutoLevel({ gpuRenderer: '', deviceMemoryGb: 2 }).level, 'low');
  assert.equal(initialAutoLevel({}).level, 'high');
  const r = resolveQuality('auto', { gpuRenderer: 'Apple M3 Pro' });
  assert.equal(r.setting, 'auto');
  assert.match(r.reason, /^auto:/);
});

test('a live auto downshift is sticky', () => {
  const r = resolveQuality('auto', { gpuRenderer: 'Apple M3 Pro', downshifted: true });
  assert.equal(r.level, 'low');
  assert.equal(resolveQuality('high', { downshifted: true }).level, 'high');
});

test('auto-downshift needs a full window, uses the median, and only applies to auto-high', () => {
  const slow = Array(200).fill(40);          // 25 fps
  const fast = Array(200).fill(16.7);        // 60 fps
  assert.equal(autoDownshiftVerdict({ setting: 'auto', level: 'high', intervalsMs: slow }).downshift, true);
  assert.equal(autoDownshiftVerdict({ setting: 'auto', level: 'high', intervalsMs: fast }).downshift, false);
  assert.equal(autoDownshiftVerdict({ setting: 'auto', level: 'high', intervalsMs: slow.slice(0, 40) }).downshift, false);
  assert.equal(autoDownshiftVerdict({ setting: 'high', level: 'high', intervalsMs: slow }).downshift, false);
  assert.equal(autoDownshiftVerdict({ setting: 'auto', level: 'low', intervalsMs: slow }).downshift, false);
  // a few big hitches (shader compile, course load) don't trip it
  const hitchy = Array(200).fill(16.7).map((v, i) => (i % 20 === 0 ? 400 : v));
  assert.equal(autoDownshiftVerdict({ setting: 'auto', level: 'high', intervalsMs: hitchy }).downshift, false);
  // junk samples are ignored
  assert.equal(autoDownshiftVerdict({ setting: 'auto', level: 'high', intervalsMs: [NaN, -1, 0] }).downshift, false);
});

test('Low preset is strictly cheaper than High on every budget', () => {
  const H = QUALITY_PRESETS.high, L = QUALITY_PRESETS.low;
  assert.ok(L.pixelRatioCap <= H.pixelRatioCap);
  assert.ok(L.shadowMapSize < H.shadowMapSize);
  assert.ok(L.treeCap < H.treeCap && L.treeDensity < H.treeDensity && L.treeNearM < H.treeNearM);
  assert.ok(L.grassScale < H.grassScale);
  assert.equal(L.gtao, false);
  assert.ok(Object.isFrozen(H) && Object.isFrozen(L));
});

test('HUD label and cycle order', () => {
  assert.equal(qualityLabel('auto', 'high'), 'Auto · High');
  assert.equal(qualityLabel('low', 'low'), 'Low');
  assert.equal(nextQualitySetting('auto'), 'high');
  assert.equal(nextQualitySetting('high'), 'low');
  assert.equal(nextQualitySetting('low'), 'auto');
  assert.equal(nextQualitySetting('bogus'), 'high');
});
