// Graphics quality setting resolver + auto-downshift rule (public/render/quality.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUALITY_PRESETS, parseQualitySetting, initialAutoLevel, resolveQuality,
  autoDownshiftVerdict, qualityLabel, nextQualitySetting, renderPixelRatio,
  DYNAMIC_RES, dynamicResolutionStep,
  RESOLUTION_SETTINGS, RESOLUTION_LINES, parseResolutionSetting, heldPixelRatio, resolutionNote,
  waterMirrorSize, MIRROR_MIN_PX, MIRROR_MAX_PX,
} from '../public/render/quality.js';

test('parseQualitySetting accepts the four settings and defaults to auto', () => {
  assert.equal(parseQualitySetting('High'), 'high');
  assert.equal(parseQualitySetting(' low '), 'low');
  assert.equal(parseQualitySetting('auto'), 'auto');
  assert.equal(parseQualitySetting('Ultra'), 'ultra');
  assert.equal(parseQualitySetting('extreme'), 'auto');
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
  assert.equal(qualityLabel('ultra', 'ultra'), 'Ultra');
  assert.equal(nextQualitySetting('auto'), 'ultra');
  assert.equal(nextQualitySetting('ultra'), 'high');
  assert.equal(nextQualitySetting('high'), 'low');
  assert.equal(nextQualitySetting('low'), 'auto');
  assert.equal(nextQualitySetting('bogus'), 'ultra');
});

test('Ultra is picked by hand only, and never costs less than High on any budget', () => {
  const U = QUALITY_PRESETS.ultra, H = QUALITY_PRESETS.high;
  const strong = { gpuRenderer: 'ANGLE (NVIDIA GeForce RTX 5090)' };
  assert.equal(resolveQuality('ultra', strong).level, 'ultra');
  assert.equal(resolveQuality('ultra', strong).preset, U);
  assert.equal(resolveQuality('ultra', { gpuRenderer: 'Google SwiftShader' }).level, 'ultra', 'a hand pick wins on any GPU');
  assert.equal(resolveQuality('auto', strong).level, 'high', 'Auto tops out at High');
  // nothing steps Ultra down but dynamic resolution: the auto monitor leaves it alone
  const slow = Array.from({ length: 200 }, () => 40);
  assert.equal(autoDownshiftVerdict({ setting: 'ultra', level: 'ultra', intervalsMs: slow }).downshift, false);
  // every knob High has, Ultra has, at least as far out / as fine
  assert.deepEqual(Object.keys(U).sort(), Object.keys(H).sort());
  for (const k of ['pixelRatioCap', 'maxPixels', 'aoScale', 'shadowMapSize', 'treeDensity', 'treeCap', 'treeNearM', 'treeMidM', 'terrainLodScale', 'grassScale', 'grassDrawM']) {
    assert.ok(U[k] >= H[k], `${k}: ${U[k]} >= ${H[k]}`);
  }
  assert.ok(U.patchDetailM <= H.patchDetailM, 'finer bunker meshes');
  assert.ok(U.treeMidM > U.treeNearM);
  for (const k of ['gtao', 'bloom', 'waterReflect', 'waterFoam', 'flowers', 'aa', 'foregroundGrass']) assert.equal(U[k], H[k], k);
  assert.ok(Object.isFrozen(U));
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

// ---- a held resolution (Menu -> View -> Resolution) ----
test('resolution setting: Auto by default, 4K by its other names', () => {
  assert.deepEqual([...RESOLUTION_SETTINGS], ['auto', '1080p', '1440p', '4k']);
  assert.equal(parseResolutionSetting(undefined), 'auto');
  assert.equal(parseResolutionSetting('nonsense'), 'auto');
  assert.equal(parseResolutionSetting(' 4K '), '4k');
  assert.equal(parseResolutionSetting('2160p'), '4k');
  assert.equal(parseResolutionSetting('UHD'), '4k');
  assert.equal(parseResolutionSetting('1440P'), '1440p');
  assert.equal(RESOLUTION_LINES['4k'], 2160);
});

test('held resolution: Auto holds nothing', () => {
  assert.equal(heldPixelRatio({ setting: 'auto', dpr: 2, width: 1920, height: 1080 }), null);
  assert.equal(heldPixelRatio({ setting: '4k', dpr: 1, width: 0, height: 0 }), null);   // no window yet
});

test('held resolution: 4K is the whole of a 4K screen, at device scale 1 or 2', () => {
  // a 4K projector or TV at 100% scaling
  assert.equal(heldPixelRatio({ setting: '4k', dpr: 1, width: 3840, height: 2160 }), 1);
  // the same panel at 200% scaling (a Mac's "looks like 1920 x 1080")
  assert.equal(heldPixelRatio({ setting: '4k', dpr: 2, width: 1920, height: 1080 }), 2);
  // ...and at 150%
  const pr = heldPixelRatio({ setting: '4k', dpr: 1.5, width: 2560, height: 1440 });
  assert.equal(pr, 1.5);
  assert.equal(Math.round(1440 * pr), 2160);
});

test('held resolution: never more than the screen has', () => {
  // 4K asked for on a 1080p panel: 1080p is all there is
  assert.equal(heldPixelRatio({ setting: '4k', dpr: 1, width: 1920, height: 1080 }), 1);
  assert.equal(heldPixelRatio({ setting: '1440p', dpr: 1, width: 1920, height: 1080 }), 1);
});

test('held resolution: fewer lines than the screen are upscaled from that many', () => {
  // 1080p and 1440p held on a 4K screen
  assert.equal(heldPixelRatio({ setting: '1080p', dpr: 1, width: 3840, height: 2160 }), 0.5);
  assert.equal(heldPixelRatio({ setting: '1440p', dpr: 1, width: 3840, height: 2160 }), 0.67);
  assert.equal(heldPixelRatio({ setting: '1440p', dpr: 2, width: 1920, height: 1080 }), 1.33);
  // an ultrawide window gets the same pixel count as 16:9, not more
  const pr = heldPixelRatio({ setting: '4k', dpr: 1, width: 5120, height: 2160 });
  assert.ok(5120 * 2160 * pr * pr <= 3840 * 2160 * 1.02, `${(5120 * 2160 * pr * pr / 1e6).toFixed(2)} MP`);
});

test('held resolution: it overrides the graphics level, which Auto still obeys', () => {
  // Low's budget is ~1.3 MP; a player who picks 4K on Low gets 4K
  const L = QUALITY_PRESETS.low;
  const auto = renderPixelRatio({ dpr: 1, width: 3840, height: 2160, cap: L.pixelRatioCap, maxPixels: L.maxPixels });
  assert.ok(auto < 0.5 + 1e-9);
  assert.equal(heldPixelRatio({ setting: '4k', dpr: 1, width: 3840, height: 2160 }), 1);
});

test('resolution note: says what is drawn, and when the screen is the limit', () => {
  assert.match(resolutionNote({ setting: '4k', bufferW: 3840, bufferH: 2160, dpr: 1, height: 2160 }), /^Rendering 3840 × 2160, held\.$/);
  const small = resolutionNote({ setting: '4k', bufferW: 1920, bufferH: 1080, dpr: 1, height: 1080 });
  assert.match(small, /1920 × 1080/);
  assert.match(small, /this screen has 1080 lines/);
  assert.match(resolutionNote({ setting: 'auto', bufferW: 2112, bufferH: 1188, dpr: 1, height: 2160 }), /Rendering 2112 × 1188 now/);
});

// ---- pond mirrors follow the picture ----
test('water mirror: at 1080p on High it is the 512 px mirror it always was', () => {
  const H = QUALITY_PRESETS.high;
  assert.deepEqual(waterMirrorSize({ bufferW: 1920, bufferH: 1080, share: H.mirrorShare }), { width: 512, height: 512 });
  // ...and at the visual-capture baseline's 1280 x 720, so its frames do not move
  assert.deepEqual(waterMirrorSize({ bufferW: 1280, bufferH: 720, share: H.mirrorShare }), { width: 512, height: 512 });
  assert.equal(MIRROR_MIN_PX, 512);
});

test('water mirror: at 4K it grows with the picture', () => {
  const H = QUALITY_PRESETS.high, U = QUALITY_PRESETS.ultra;
  assert.deepEqual(waterMirrorSize({ bufferW: 3840, bufferH: 2160, share: H.mirrorShare }), { width: 960, height: 540 });
  assert.deepEqual(waterMirrorSize({ bufferW: 3840, bufferH: 2160, share: U.mirrorShare }), { width: 1920, height: 1080 });
  assert.deepEqual(waterMirrorSize({ bufferW: 1920, bufferH: 1080, share: U.mirrorShare }), { width: 960, height: 540 });
});

test('water mirror: bounded, even, and safe with no size or share yet', () => {
  assert.deepEqual(waterMirrorSize({ bufferW: 7680, bufferH: 4320, share: 0.5 }), { width: MIRROR_MAX_PX[0], height: MIRROR_MAX_PX[1] });
  assert.deepEqual(waterMirrorSize({}), { width: 512, height: 512 });
  assert.deepEqual(waterMirrorSize({ bufferW: 3840, bufferH: 2160, share: undefined }), { width: 960, height: 540 });
  for (const [w, h] of [[2731, 1537], [3001, 1689], [2222, 1250]]) {
    const m = waterMirrorSize({ bufferW: w, bufferH: h, share: 0.5 });
    assert.equal(m.width % 2, 0); assert.equal(m.height % 2, 0);
  }
  assert.equal(QUALITY_PRESETS.low.waterReflect, false);   // Low has no live mirror to size
});
