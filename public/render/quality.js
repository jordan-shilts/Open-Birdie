// Graphics quality: one user setting ('auto' | 'high' | 'low') resolved to a concrete
// preset the renderer reads. Pure (no DOM / no three) so the resolver and the
// auto-downshift rule are unit-tested (test/quality.test.mjs).
//
//   setting  — what the user picked (persisted by the UI; 'auto' by default)
//   level    — what is actually running ('high' | 'low')
//
// 'auto' starts from a GPU heuristic (software rasterizers, integrated/mobile parts
// start Low) and then lets the live frame-time monitor drop High -> Low once if the
// game can't hold a playable frame rate. It never flips back up on its own: a
// downshift that then upshifts again would oscillate every few seconds.

export const QUALITY_SETTINGS = Object.freeze(['auto', 'high', 'low']);

// Everything the renderer varies by level. Course-content knobs (trees, grass)
// need a course rebuild to apply; the rest apply live (see GolfScene.setQuality).
export const QUALITY_PRESETS = Object.freeze({
  high: Object.freeze({
    level: 'high',
    pixelRatioCap: 2,       // retina where available ...
    maxPixels: 8.4e6,       // ... up to native 4K: dynamic resolution (below) holds 60 fps
    aoScale: 0.5,           // GTAO buffers at half resolution (AO is low-frequency)
    shadowMapSize: 4096,
    shadowRadius: 3,        // PCF kernel scale -> soft penumbra
    gtao: true,             // ambient occlusion pass
    bloom: true,
    waterReflect: true,
    waterFoam: true,
    treeDensity: 1.0,       // woods fill spacing multiplier (1 = dense)
    treeCap: 9000,          // instanced trees across the course
    treeNearM: 200,         // trees nearer than this draw the full leaf-card LOD
    grassScale: 0.5,        // fescue / foreground-grass instance budgets (55k tufts was ~4.5 ms at 1080p)
    foregroundGrass: false, // blade patches read as fuzz at the play cameras (config.js grassField)
    flowers: true,
  }),
  low: Object.freeze({
    level: 'low',
    pixelRatioCap: 1,
    maxPixels: 1.3e6,       // ~1520x855 internal, upscaled + SMAA on a 1080p window
    aoScale: 0.5,
    shadowMapSize: 2048,
    shadowRadius: 1.5,
    gtao: false,
    bloom: true,
    waterReflect: false,
    waterFoam: false,
    treeDensity: 0.55,
    treeCap: 2600,
    treeNearM: 110,
    grassScale: 0.25,
    foregroundGrass: false,
    flowers: false,
  }),
});

export function parseQualitySetting(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return QUALITY_SETTINGS.includes(v) ? v : 'auto';
}

// GPU-string heuristic for the 'auto' starting level. Conservative: only parts we
// know struggle with a full-course shadowed scene start Low; anything unknown starts
// High and relies on the frame-time monitor.
const WEAK_GPU = /swiftshader|llvmpipe|softpipe|software|microsoft basic|mali|adreno|powervr|intel\(r\) (hd|uhd)|intel hd|intel uhd|gma/i;

export function initialAutoLevel({ gpuRenderer = '', mobile = false, deviceMemoryGb = null } = {}) {
  if (mobile) return { level: 'low', reason: 'mobile device' };
  if (WEAK_GPU.test(String(gpuRenderer))) return { level: 'low', reason: `weak GPU (${gpuRenderer})` };
  if (deviceMemoryGb != null && deviceMemoryGb > 0 && deviceMemoryGb < 4) {
    return { level: 'low', reason: `${deviceMemoryGb} GB device memory` };
  }
  return { level: 'high', reason: 'capable GPU' };
}

// setting + environment -> { setting, level, reason, preset }
// env: { gpuRenderer, mobile, deviceMemoryGb, downshifted }
export function resolveQuality(setting, env = {}) {
  const s = parseQualitySetting(setting);
  if (s === 'high' || s === 'low') {
    return { setting: s, level: s, reason: 'user setting', preset: QUALITY_PRESETS[s] };
  }
  // A live downshift (autoDownshiftVerdict) is sticky for the session.
  if (env.downshifted) {
    return { setting: 'auto', level: 'low', reason: 'auto: dropped to Low to hold frame rate', preset: QUALITY_PRESETS.low };
  }
  const { level, reason } = initialAutoLevel(env);
  return { setting: 'auto', level, reason: `auto: ${reason}`, preset: QUALITY_PRESETS[level] };
}

// Live auto-downshift verdict from recent frame intervals (ms). Only 'auto' at
// 'high' can downshift; it needs a full window of samples so a hitch (course load,
// shader compile) can't trip it. Uses the median interval — robust to spikes.
export const AUTO_DOWNSHIFT = Object.freeze({ minSamples: 150, belowFps: 42 });

export function autoDownshiftVerdict({ setting, level, intervalsMs, minSamples = AUTO_DOWNSHIFT.minSamples, belowFps = AUTO_DOWNSHIFT.belowFps }) {
  if (parseQualitySetting(setting) !== 'auto' || level !== 'high') return { downshift: false, reason: 'not auto-high' };
  const xs = (intervalsMs || []).filter((v) => Number.isFinite(v) && v > 0);
  if (xs.length < minSamples) return { downshift: false, reason: 'warming up' };
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const fps = 1000 / median;
  return fps < belowFps
    ? { downshift: true, fps, reason: `median ${fps.toFixed(0)} fps < ${belowFps}` }
    : { downshift: false, fps, reason: 'holding frame rate' };
}

// Label for the HUD button: "Auto · High", "High", "Low".
export function qualityLabel(setting, level) {
  const cap = (v) => v.charAt(0).toUpperCase() + v.slice(1);
  return parseQualitySetting(setting) === 'auto' ? `Auto · ${cap(level)}` : cap(level);
}

export function nextQualitySetting(setting) {
  const i = QUALITY_SETTINGS.indexOf(parseQualitySetting(setting));
  return QUALITY_SETTINGS[(i + 1) % QUALITY_SETTINGS.length];
}

// Render pixel ratio under a pixel budget: the device ratio, capped by the preset,
// then lowered so width*height*ratio^2 stays under maxPixels. A retina laptop at a
// 1512x982 window would otherwise shade ~3 MP per pass; High holds ~1080p, Low less.
export function renderPixelRatio({ dpr = 1, width = 0, height = 0, cap = 2, maxPixels = Infinity } = {}) {
  let pr = Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, cap);
  const px = width * height;
  if (px > 0 && Number.isFinite(maxPixels) && maxPixels > 0) pr = Math.min(pr, Math.sqrt(maxPixels / px));
  return Math.max(0.5, Math.round(pr * 100) / 100);
}

// Dynamic resolution: hold 60 fps by scaling the render resolution under the preset's
// budget, the way consoles reach "4K at 60" — full resolution when the GPU has room,
// down to half (per axis) when it doesn't. Judged per window of frames: too many slow
// frames step the scale down at once; a run of calm windows creeps it back up. (Frame
// intervals are vsync-quantised, so a window with no slow frame is the only headroom
// signal there is.) Pure, so the rule is unit-tested.
export const DYNAMIC_RES = Object.freeze({
  min: 0.5, max: 1, slowMs: 1000 / 54, windowFrames: 45, slowShare: 0.12,
  down: 0.86, up: 1.06, calmWindowsToRise: 3,
});

export function dynamicResolutionStep({ scale = 1, intervalsMs = [], calmWindows = 0, opts = DYNAMIC_RES } = {}) {
  const xs = intervalsMs.filter((v) => Number.isFinite(v) && v > 0 && v < 250);
  if (xs.length < opts.windowFrames) return { scale, calmWindows, changed: false };
  const slow = xs.filter((v) => v > opts.slowMs).length / xs.length;
  if (slow > opts.slowShare && scale > opts.min) {
    return { scale: Math.max(opts.min, Math.round(scale * opts.down * 100) / 100), calmWindows: 0, changed: true };
  }
  if (slow === 0) {
    const calm = calmWindows + 1;
    if (calm >= opts.calmWindowsToRise && scale < opts.max) {
      return { scale: Math.min(opts.max, Math.round(scale * opts.up * 100) / 100), calmWindows: 0, changed: true };
    }
    return { scale, calmWindows: calm, changed: false };
  }
  return { scale, calmWindows: 0, changed: false };
}
