// Graphics quality setting resolver + auto-downshift rule (public/render/quality.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUALITY_PRESETS, parseQualitySetting, initialAutoLevel, resolveQuality,
  autoDownshiftVerdict, qualityLabel, nextQualitySetting, renderPixelRatio,
  DYNAMIC_RES, dynamicResolutionStep,
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

test('render pixel ratio honours the device, the cap, and the pixel budget', () => {
  const H = QUALITY_PRESETS.high, L = QUALITY_PRESETS.low;
  // 1080p window on a 1x display: full resolution on High
  assert.equal(renderPixelRatio({ dpr: 1, width: 1920, height: 1080, cap: H.pixelRatioCap, maxPixels: H.maxPixels }), 1);
  // a 4K screen (3840x2160 @1x, or 1920x1080 @2x) gets its full resolution on High:
  // dynamic resolution, not a fixed budget, holds the frame rate
  assert.equal(renderPixelRatio({ dpr: 1, width: 3840, height: 2160, cap: H.pixelRatioCap, maxPixels: H.maxPixels }), 1);
  assert.equal(renderPixelRatio({ dpr: 2, width: 1920, height: 1080, cap: H.pixelRatioCap, maxPixels: H.maxPixels }), 2);
  // past 4K the budget still caps it
  const pr = renderPixelRatio({ dpr: 2, width: 2560, height: 1440, cap: H.pixelRatioCap, maxPixels: H.maxPixels });
  assert.ok(pr > 1 && pr < 2, String(pr));
  assert.ok(2560 * 1440 * pr * pr <= H.maxPixels * 1.01);
  // small window on retina keeps the full 2x
  assert.equal(renderPixelRatio({ dpr: 2, width: 800, height: 500, cap: H.pixelRatioCap, maxPixels: H.maxPixels }), 2);
  // Low renders under 1080p and never below the 0.5 floor
  assert.ok(renderPixelRatio({ dpr: 1, width: 1920, height: 1080, cap: L.pixelRatioCap, maxPixels: L.maxPixels }) < 1);
  assert.equal(renderPixelRatio({ dpr: 1, width: 8000, height: 8000, cap: 1, maxPixels: 1e5 }), 0.5);
  assert.equal(renderPixelRatio({ dpr: NaN, width: 0, height: 0 }), 1);
});

test('dynamic resolution steps down on slow frames and creeps back up when calm', () => {
  const D = DYNAMIC_RES;
  const fast = Array(D.windowFrames).fill(12), slow = Array(D.windowFrames).fill(30);
  // not enough frames yet: no verdict
  assert.deepEqual(dynamicResolutionStep({ scale: 1, intervalsMs: [12, 12] }), { scale: 1, calmWindows: 0, changed: false });
  // a slow window drops the scale at once, never below the floor
  const down = dynamicResolutionStep({ scale: 1, intervalsMs: slow });
  assert.ok(down.changed && down.scale < 1);
  assert.equal(dynamicResolutionStep({ scale: D.min, intervalsMs: slow }).scale, D.min);
  // calm windows rise only after a run of them, and never past full resolution
  let st = { scale: 0.7, calmWindows: 0 };
  for (let k = 0; k < D.calmWindowsToRise - 1; k++) {
    st = dynamicResolutionStep({ ...st, intervalsMs: fast });
    assert.equal(st.changed, false);
  }
  st = dynamicResolutionStep({ ...st, intervalsMs: fast });
  assert.ok(st.changed && st.scale > 0.7);
  assert.equal(dynamicResolutionStep({ scale: 1, intervalsMs: fast, calmWindows: 9 }).scale, 1);
  // a few slow frames under the share neither drop nor build calm
  const mixed = [...Array(D.windowFrames - 2).fill(12), 30, 30];
  assert.deepEqual(dynamicResolutionStep({ scale: 0.8, intervalsMs: mixed, calmWindows: 2 }), { scale: 0.8, calmWindows: 0, changed: false });
});
