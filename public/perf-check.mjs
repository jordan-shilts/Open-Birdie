// Performance check (Menu -> View -> Performance check, or a page opened with ?perfcheck):
// where this computer's frame time goes, measured on the computer itself, so the sim PC's
// own GPU says what to make cheaper. Frames are drawn back to back at the graphics level
// in use and timed by throughput (a 1-pixel read-back makes the GPU finish them; GPU
// timers mislead on some systems), at the level's full resolution and at dynamic
// resolution's floor, then again with one part of the scene hidden at a time. The live
// frame loop, the resolution and every part are put back afterwards.

import { DYNAMIC_RES } from './render/quality.js';

// [name, hide(scene) -> applies?]. A part that isn't in the scene (no bloom at Low, no
// water on the hole) is skipped.
const PARTS = [
  ['trees', (s) => hideAll(s, (o) => o === s._treeField?.group)],
  ['ground shading', (s) => {
    if (!s._turfMat) return false;
    const flat = new s._turfMat.constructor({ color: 0x557733 });
    let any = false;
    s.scene.traverse((o) => { if (o.isMesh && o.material === s._turfMat) { o.material = flat; any = true; } });
    return any;
  }],
  ['HD ground', (s) => hideAll(s, (o) => o.name === 'hdTerrainLod')],
  ['rough grass', (s) => hideAll(s, (o) => o.name === 'grassCells' || o === s._grassField?.group)],
  ['water', (s) => hideAll(s, (o) => o.name === 'sea' || /water|pond/i.test(`${o.material?.name || ''} ${o.material?.type || ''}`))],
  ['buildings', (s) => hideAll(s, (o) => o.name === 'buildingWalls' || o.name === 'buildingRoofs')],
  ['shadows', (s) => { if (!s.renderer.shadowMap.enabled) return false; s.renderer.shadowMap.enabled = false; return true; }],
  ['sky', (s) => { if (!s.scene.background) return false; s.scene.background = null; return true; }],
  ['antialiasing', (s) => passOff(s, s.postfx?.smaa) | passOff(s, s.postfx?.fxaa)],
  ['sharpening', (s) => passOff(s, s.postfx?.cas)],
  ['bloom', (s) => passOff(s, s.postfx?.bloom)],
  ['ambient occlusion', (s) => passOff(s, s.postfx?.gtao)],
];

function hideAll(s, pick) {
  let any = false;
  s.scene.traverse((o) => { if (o.visible && pick(o)) { o.visible = false; any = true; } });
  return any;
}
function passOff(s, pass) {
  if (!pass || !pass.enabled) return false;
  pass.enabled = false;
  return true;
}

// what a part's hiding changes, to put it all back
function snapshot(s) {
  const vis = new Map(), mat = new Map();
  s.scene.traverse((o) => { vis.set(o, o.visible); if (o.isMesh) mat.set(o, o.material); });
  const passes = s.postfx ? s.postfx.composer.passes.map((p) => p.enabled) : [];
  return { vis, mat, passes, bg: s.scene.background, shadows: s.renderer.shadowMap.enabled };
}
function restore(s, st) {
  for (const [o, v] of st.vis) o.visible = v;
  for (const [o, m] of st.mat) {
    if (o.material !== m) { o.material.dispose?.(); o.material = m; }
  }
  if (s.postfx) s.postfx.composer.passes.forEach((p, i) => { p.enabled = st.passes[i]; });
  s.scene.background = st.bg;
  s.renderer.shadowMap.enabled = st.shadows;
  s.renderer.shadowMap.needsUpdate = true;
}

// ms a frame: frames back to back, then a 1-pixel read-back so the GPU has finished
// them; the best of a few runs, each about `budgetMs` long
async function timeFrames(s, { budgetMs = 450, runs = 3 } = {}) {
  const r = s.renderer, gl = r.getContext(), px = new Uint8Array(4);
  const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); r.resetState(); };
  let t0 = performance.now();
  for (let i = 0; i < 3; i++) s._frame();
  sync();
  const n = Math.max(6, Math.min(60, Math.round(budgetMs / Math.max(1, (performance.now() - t0) / 3))));
  let best = Infinity;
  for (let k = 0; k < runs; k++) {
    t0 = performance.now();
    for (let i = 0; i < n; i++) s._frame();
    sync();
    best = Math.min(best, (performance.now() - t0) / n);
    await new Promise((q) => setTimeout(q, 20));   // let the page breathe (and the progress paint)
  }
  return Math.round(best * 100) / 100;
}

function gpuName(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  } catch { return ''; }
}

// Runs the check on a GolfScene. onProgress(done, total, label). Returns the report.
export async function runPerfCheck(scene, { state = null, onProgress = () => {} } = {}) {
  const s = scene, r = s.renderer;
  const scales = [1, DYNAMIC_RES.min];
  const steps = scales.length * (1 + PARTS.length);
  let done = 0;
  const step = (label) => onProgress(++done, steps, label);
  // hold the scene still: no live loop, no dynamic resolution, no camera motion
  const track = s._trackFrameRate, resScale = s._resScale, resPending = s._resPending;
  r.setAnimationLoop(null);
  s._trackFrameRate = () => {};
  s._resPending = null;
  const report = {
    version: 1,
    at: new Date().toISOString(),
    gpu: gpuName(r.getContext()),
    userAgent: globalThis.navigator?.userAgent || '',
    window: [globalThis.innerWidth ?? null, globalThis.innerHeight ?? null],
    devicePixelRatio: globalThis.devicePixelRatio || 1,
    level: s.quality?.level || null,
    course: state?.courseName || null,
    hole: state?.holeRef ?? state?.hole ?? null,
    frames: [],
    parts: [],
  };
  try {
    for (const scale of scales) {
      s._resScale = scale;
      s.resize();
      const canvas = `${r.domElement.width}x${r.domElement.height}`;
      const base = await timeFrames(s);
      report.frames.push({ scale, canvas, ms: base });
      step(`whole frame at ${canvas}`);
      for (const [part, hide] of PARTS) {
        const st = snapshot(s);
        let ms = null;
        try {
          if (hide(s)) ms = await timeFrames(s);
        } finally { restore(s, st); }
        if (ms != null) report.parts.push({ part, canvas, savedMs: Math.round((base - ms) * 100) / 100, ofMs: base });
        step(part);
      }
    }
  } finally {
    s._resScale = resScale;
    s._resPending = resPending;
    s.resize();
    s._trackFrameRate = track;
    s.clock?.getDelta?.();   // no catch-up jump in the first live frame
    r.setAnimationLoop(s._liveFrame);
  }
  return report;
}

// The report in a few lines a player can read: the frame at each size, and the parts
// that cost the most at full size.
export function summarizePerf(report) {
  const fps = (ms) => (ms > 0 ? Math.round(1000 / ms) : 0);
  const lines = report.frames.map((f) => `${f.canvas}: ${f.ms.toFixed(1)} ms a frame (${fps(f.ms)} fps of GPU time)`);
  const full = report.frames[0]?.canvas;
  const top = report.parts.filter((p) => p.canvas === full && p.savedMs > 0)
    .sort((a, b) => b.savedMs - a.savedMs).slice(0, 5)
    .map((p) => `${p.part} ${p.savedMs.toFixed(1)} ms (${Math.round((p.savedMs / p.ofMs) * 100)}%)`);
  return { lines, top };
}
