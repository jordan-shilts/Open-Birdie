// Pure analysis of an equirectangular HDRI's float pixel data.
// No three.js import so it runs in node tests and the browser alike.
// data: Float32Array RGBA, row-major. Row 0 = zenith, last row = nadir.

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Brightest texel -> { azimuth (rad, 0..2π), altitude (rad, -π/2..π/2) }.
// step samples a subset for speed on large (4K) images.
export function sunSphericalFromEquirect(data, width, height, step = 2) {
  let best = -Infinity, bx = 0, by = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const L = lum(data[i], data[i + 1], data[i + 2]);
      if (L > best) { best = L; bx = x; by = y; }
    }
  }
  const azimuth = ((bx + 0.5) / width) * Math.PI * 2;
  const colatitude = ((by + 0.5) / height) * Math.PI; // 0 = zenith
  const altitude = Math.PI / 2 - colatitude;           // + above horizon
  return { azimuth, altitude };
}

// Spherical (azimuth, altitude in rad) -> unit direction in THREE space.
// Sim axes x=east, y=north, z=up map to THREE as (x, z, -y), so:
//   east -> +X, straight up -> +Y, north -> -Z. (Unit-tested for handedness — D3.)
export function sunDirectionVec(azimuth, altitude) {
  const ca = Math.cos(altitude);
  return { x: ca * Math.sin(azimuth), y: Math.sin(altitude), z: -ca * Math.cos(azimuth) };
}

// Average color of the rows near the horizon (v ≈ 0.5), tone-mapped to 0xRRGGBB.
export function horizonColorFromEquirect(data, width, height) {
  const y0 = Math.floor(height * 0.46), y1 = Math.ceil(height * 0.54);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  r /= n; g /= n; b /= n;
  // simple Reinhard + gamma so the fog tint matches the displayed sky, not raw HDR
  const enc = (c) => Math.min(255, Math.round(Math.pow(c / (1 + c), 1 / 2.2) * 255));
  return (enc(r) << 16) | (enc(g) << 8) | enc(b);
}

// Linear (scene-referred) average of the sky just ABOVE the horizon (~1-10 deg up),
// as {r,g,b}. Fog / horizon haze use this directly so they meet the rendered sky
// exactly after tone mapping (the sRGB/Reinhard hex above is a display-space guess).
export function horizonLinearFromEquirect(data, width, height) {
  const y0 = Math.floor(height * 0.445), y1 = Math.ceil(height * 0.494);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const R = data[i], G = data[i + 1], B = data[i + 2];
      // skip the sun disc so one blazing texel can't tint the whole haze
      if (0.2126 * R + 0.7152 * G + 0.0722 * B > 40) continue;
      r += R; g += G; b += B; n++;
    }
  }
  return n ? { r: r / n, g: g / n, b: b / n } : { r: 0.6, g: 0.7, b: 0.8 };
}


// The largest value a half-float holds is 65504. The renderer prefilters the sky into
// half-float targets (PMREM) and draws it into a half-float frame, and a clear-sky photo's
// sun disc runs past that (the bundled sky peaks near 75,000 in 17 texels). Where the GPU
// stores such a value as +Infinity instead of saturating it, the prefilter's blur turns it
// into NaN, and every sky-lit surface (then, through bloom, the whole frame) goes black.
// Clamp the photo in place before it reaches the GPU; a non-finite texel becomes the cap.
// Returns how many channel values were changed.
export const HALF_FLOAT_SAFE_MAX = 64000;
export function clampEquirectRadiance(data, max = HALF_FLOAT_SAFE_MAX) {
  let changed = 0;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = data[i + c];
      if (v > max || v !== v) { data[i + c] = max; changed++; }
      else if (v < 0) { data[i + c] = 0; changed++; }
    }
  }
  return changed;
}
