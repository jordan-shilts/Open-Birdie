// Strict 3DEP elevation adapter.
//
// Wraps lib/lidar.js `fetchPatchStrict` (which throws plain stage-coded errors)
// into the compiler's `HdCompileError` world, computes acquisition stats, and
// guards against the service returning data coarser than the pinned native
// spacing — never silently upsampling and labeling it HD.

import lidar from '../../lib/lidar.js';
import { HdCompileError } from './errors.mjs';
import { constants } from './coordinates.mjs';

const isNoData = (v) => !Number.isFinite(v) || v < -1e30;

// Compiling a hole is offline work: 3DEP's 1 m export gets far longer than a course
// load allows (lib/lidar.js: 12 s) and is retried, since the service is often slow
// rather than down (a cloud build lost holes to 12 s timeouts). Only a timeout or an
// HTTP failure is retried; "no lidar here" and a short payload are final.
const HD_3DEP_TIMEOUT_MS = 60_000;
const HD_3DEP_ATTEMPTS = 3;
const transient = (e) => e && (e.name === 'TimeoutError' || e.code === 23 ||
  e.code === 'HD_3DEP_META' || e.code === 'HD_3DEP_HTTP');

export async function acquireElevation(bbox, {
  fetchImpl, targetM = 1, maxPx, nativeSpacingM,
  timeoutMs = HD_3DEP_TIMEOUT_MS, attempts = HD_3DEP_ATTEMPTS, backoffMs = 3000,
}) {
  let patch;
  for (let attempt = 1; ; attempt++) {
    try {
      patch = await lidar.fetchPatchStrict(bbox, { fetchImpl, targetM, maxPx, timeoutMs });
      break;
    } catch (e) {
      if (attempt >= attempts || !transient(e)) {
        throw new HdCompileError('download-elevation', e.code || 'HD_3DEP_FETCH', { bbox, attempts: attempt }, e);
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** (attempt - 1)));
    }
  }

  // Web Mercator metres are inflated by 1/cos(lat); multiply back to ground metres.
  const midLat = (bbox.north + bbox.south) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const mercSpacing = (patch.xmax - patch.xmin) / Math.max(1, patch.width - 1);
  const groundSpacingM = mercSpacing * cosLat;
  if (nativeSpacingM && groundSpacingM > nativeSpacingM * 1.5) {
    throw new HdCompileError('download-elevation', 'HD_3DEP_COARSE', {
      groundSpacingM: +groundSpacingM.toFixed(3), nativeSpacingM,
    });
  }

  let min = Infinity; let max = -Infinity; let valid = 0;
  for (const v of patch.heights) {
    if (isNoData(v)) continue;
    valid += 1;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return {
    patch,
    stats: {
      width: patch.width,
      height: patch.height,
      validRatio: valid / patch.heights.length,
      min: valid ? min : null,
      max: valid ? max : null,
      groundSpacingM: +groundSpacingM.toFixed(3),
      nativeSpacingM: nativeSpacingM ?? null,
    },
  };
}

export { constants };
