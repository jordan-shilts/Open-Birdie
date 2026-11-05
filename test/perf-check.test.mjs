// The in-app Performance check (public/perf-check.mjs) times the live scene by hiding its
// parts one at a time: it must measure each part that is there, skip the ones that
// aren't, and leave the scene, the resolution and the frame loop exactly as it found them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPerfCheck, summarizePerf } from '../public/perf-check.mjs';

function fakeScene() {
  const obj = (name, extra = {}) => ({ name, visible: true, isMesh: false, ...extra });
  const turfMat = { name: 'turf', dispose() {} };
  turfMat.constructor = function Flat() { this.name = 'flat'; this.dispose = () => {}; };
  const trees = obj('trees');
  const ground = obj('terrainLod', { isMesh: true, material: turfMat });
  const hd = obj('hdTerrainLod', { isMesh: true, material: turfMat });
  const grass = obj('grassCells', { isMesh: true, material: { name: 'grass' } });
  const sea = obj('sea', { isMesh: true, material: { name: 'sea', type: 'ShaderMaterial' } });
  const all = [trees, ground, hd, grass, sea];
  // Low's chain: render, AO (on here), bloom (off), SMAA (off), FXAA, sharpening
  const [render, gtao, bloom, smaa, fxaa, cas] = [true, true, false, false, true, true].map((enabled) => ({ enabled }));
  const passes = [render, gtao, bloom, smaa, fxaa, cas];
  let frames = 0, loop = 'live';
  const live = () => {};
  const s = {
    _treeField: { group: trees },
    _turfMat: turfMat,
    _grassField: null,
    _resScale: 0.8, _resPending: null, _liveFrame: live,
    _trackFrameRate: function track() {},
    quality: { level: 'low' },
    clock: { getDelta: () => 0 },
    resizes: [],
    resize() { this.resizes.push(this._resScale); this.renderer.domElement.width = Math.round(1520 * this._resScale); this.renderer.domElement.height = Math.round(855 * this._resScale); },
    _frame() { frames++; },
    scene: { background: { sky: true }, traverse: (f) => all.forEach(f) },
    postfx: { composer: { passes }, gtao, bloom, smaa, fxaa, cas },
    renderer: {
      domElement: { width: 1216, height: 684 },
      shadowMap: { enabled: true, needsUpdate: false },
      setAnimationLoop(f) { loop = f === live ? 'live' : f === null ? 'stopped' : 'other'; },
      resetState() {},
      getContext: () => ({ FRAMEBUFFER: 1, RGBA: 2, UNSIGNED_BYTE: 3, RENDERER: 4, bindFramebuffer() {}, readPixels() {}, getExtension: () => null, getParameter: () => 'Fake GPU' }),
    },
  };
  return { s, all, passes, trees, ground, hd, turfMat, get frames() { return frames; }, get loop() { return loop; } };
}

test('measures the parts that are there and puts the scene back as it was', async () => {
  const f = fakeScene();
  const { s } = f;
  const before = { vis: f.all.map((o) => o.visible), passes: f.passes.map((p) => p.enabled), bg: s.scene.background, track: s._trackFrameRate };
  const progress = [];
  const report = await runPerfCheck(s, { state: { courseName: 'Test, somewhere', holeRef: 3 }, onProgress: (n, total, label) => progress.push([n, total, label]) });
  assert.equal(report.version, 1);
  assert.equal(report.gpu, 'Fake GPU');
  assert.equal(report.level, 'low');
  assert.equal(report.hole, 3);
  assert.deepEqual(report.frames.map((x) => x.scale), [1, 0.5]);
  assert.deepEqual(report.frames.map((x) => x.canvas), ['1520x855', '760x428']);
  const parts = new Set(report.parts.map((p) => p.part));
  for (const p of ['trees', 'ground shading', 'HD ground', 'rough grass', 'water', 'shadows', 'sky', 'antialiasing', 'sharpening', 'ambient occlusion']) assert.ok(parts.has(p), `measured ${p}`);
  assert.ok(!parts.has('bloom'), 'bloom is off at Low: nothing to measure');
  assert.ok(!parts.has('buildings'), 'no buildings in this scene');
  assert.equal(progress.at(-1)[0], progress.at(-1)[1], 'progress reaches the end');
  assert.ok(f.frames > 0);
  // all back: visibility, materials, passes, sky, shadows, resolution, the live loop
  assert.deepEqual(f.all.map((o) => o.visible), before.vis);
  assert.equal(f.ground.material, f.turfMat);
  assert.equal(f.hd.material, f.turfMat);
  assert.deepEqual(f.passes.map((p) => p.enabled), before.passes);
  assert.equal(s.scene.background, before.bg);
  assert.equal(s.renderer.shadowMap.enabled, true);
  assert.equal(s._resScale, 0.8);
  assert.equal(s.resizes.at(-1), 0.8);
  assert.equal(s._trackFrameRate, before.track);
  assert.equal(f.loop, 'live');
});

test('the summary: the frame at each size and the costliest parts at full size', () => {
  const sum = summarizePerf({
    frames: [{ scale: 1, canvas: '1520x855', ms: 25 }, { scale: 0.5, canvas: '760x428', ms: 12.5 }],
    parts: [
      { part: 'trees', canvas: '1520x855', savedMs: 6, ofMs: 25 },
      { part: 'sky', canvas: '1520x855', savedMs: -0.2, ofMs: 25 },
      { part: 'ground shading', canvas: '1520x855', savedMs: 8, ofMs: 25 },
      { part: 'trees', canvas: '760x428', savedMs: 5.5, ofMs: 12.5 },
    ],
  });
  assert.deepEqual(sum.lines, ['1520x855: 25.0 ms a frame (40 fps of GPU time)', '760x428: 12.5 ms a frame (80 fps of GPU time)']);
  assert.deepEqual(sum.top, ['ground shading 8.0 ms (32%)', 'trees 6.0 ms (24%)']);
});
