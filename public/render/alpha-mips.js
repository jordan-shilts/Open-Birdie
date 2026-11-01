// Coverage-preserving mipmaps for alpha-tested foliage. Plain box-filtered mips
// average leaf coverage toward grey, so at distance an alpha test either eats the
// canopy (alpha < cutoff everywhere) or — with a distance boost — turns whole
// cards into opaque shards. Here each mip level is box-downsampled, then its alpha
// is re-contrasted around the cutoff so the FRACTION of texels passing the test
// matches the full-resolution level, per atlas tile (Castaño, "Computing alpha
// mipmaps"). Pure: works on Uint8 alpha arrays; unit-tested.

// alpha: Uint8Array (w*h), returns the w/2 x h/2 box-filtered level
export function downsample(alpha, w, h) {
  const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
      const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
      out[y * W + x] = (alpha[y0 * w + x0] + alpha[y0 * w + x1] + alpha[y1 * w + x0] + alpha[y1 * w + x1] + 2) >> 2;
    }
  }
  return { alpha: out, w: W, h: H };
}

// fraction of texels in a rect with alpha >= cutoff
export function coverage(alpha, w, rect, cutoff) {
  let n = 0, pass = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) { n++; if (alpha[y * w + x] >= cutoff) pass++; }
  }
  return n ? pass / n : 0;
}

// Remap alpha inside rect so its coverage at `cutoff` matches `target`: find the
// source threshold p that passes exactly `target` of the texels, then map p ->
// cutoff piecewise-linearly (0 stays 0, 255 stays 255) — monotone, so texel order
// (the leaf shapes) is preserved.
export function matchCoverage(alpha, w, rect, target, cutoff) {
  let pLo = 0, pHi = 255;
  for (let it = 0; it < 12; it++) {
    const p = (pLo + pHi) / 2;
    if (coverage(alpha, w, rect, p) > target) pLo = p; else pHi = p;
  }
  // coverage is a step function on discrete alphas: take whichever side is closer
  const p = Math.abs(coverage(alpha, w, rect, pLo) - target) <= Math.abs(coverage(alpha, w, rect, pHi) - target) ? pLo : pHi;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const a = alpha[y * w + x];
      const v = a >= p
        ? cutoff + ((a - p) / Math.max(1e-6, 255 - p)) * (255 - cutoff)
        : Math.min(cutoff - 1, (a / Math.max(1e-6, p)) * cutoff);
      alpha[y * w + x] = Math.max(0, Math.min(255, a >= p ? Math.ceil(v) : Math.floor(v)));
    }
  }
}

// Build the whole chain. tiles: number of atlas tiles per side (2 = 2x2 atlas).
// Returns [{alpha, w, h}] from level 0 (the input) down to 1x1.
export function coverageMipChain(alpha0, w, h, { tiles = 2, cutoff = 128 } = {}) {
  const tileRect = (W, H, tx, ty) => {
    const tw = Math.max(1, Math.floor(W / tiles)), th = Math.max(1, Math.floor(H / tiles));
    return { x: tx * tw, y: ty * th, w: tw, h: th };
  };
  const targets = [];
  for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) targets.push(coverage(alpha0, w, tileRect(w, h, tx, ty), cutoff));
  const chain = [{ alpha: alpha0, w, h }];
  let cur = chain[0];
  while (cur.w > 1 || cur.h > 1) {
    const next = downsample(cur.alpha, cur.w, cur.h);
    if (next.w >= tiles * 2 && next.h >= tiles * 2) {
      let k = 0;
      for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) matchCoverage(next.alpha, next.w, tileRect(next.w, next.h, tx, ty), targets[k++], cutoff);
    }
    chain.push(next);
    cur = next;
  }
  return chain;
}
