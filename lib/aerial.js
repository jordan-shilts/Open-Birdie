'use strict';
const { PNG } = require('pngjs');
const { isAbortError, throwIfAborted } = require('./abort');
// Course-wide aerial photo from USGS NAIPPlus (mosaics High-Resolution
// Orthoimagery ~0.3 m over urban areas, NAIP 0.6 m elsewhere — public domain).
//
// Two ways to get it:
//  - fetchCourseAerial: runtime-safe, ONE exportImage request (no tiling, no image
//    deps), so it can run on every course load inside the packaged Electron app
//    where the zero-runtime-dep rule holds. A single request caps at maxPx (4000 px —
//    the service rejects >=4096 with a 400), giving true 0.3 m up to ~1.2 km courses
//    and coarsening to ~0.45 m for a ~1.8 km course.
//  - fetchCourseAerialTiled: the max-quality 0.3 m mosaic. The bbox is TILED and
//    mosaicked with sharp (an injected dependency, so only the cloud service and the
//    dev tools/add-course-aerial.mjs use it); falls back to one NAIP 0.6 m request
//    if a tile fails.
//
// Both register exactly: requests are in EPSG:4326 over the course's padded lat/lon
// box, which maps 1:1 to the course's equirectangular local metres (same frame
// parseOsm uses), so the returned local bounds == the image extent.
//
// Failure never breaks course load: fetchCourseAerial returns null on ANY failure /
// non-US (NAIPPlus returns a tiny error blob over no-data); requestCourseAerial and
// fetchCourseAerialTiled tell the two apart ({status: 'none'} vs 'failed').

const EXPORT = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage';
const NAIP_EXPORT = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
const UA = 'Open-Birdie/0.1 (open-source golf sim; personal use)';
const PAD_M = 60; // manual + auto + tiled all register identically
const TILE_M = 1100;   // ~3700 px/tile at 0.3 m — under the exportImage cap (~4100)
const MAX_DIM = 8192;  // texture/GPU ceiling for the tiled mosaic long axis
const MIN_BYTES = 2000; // USGS error blobs over no-data are tiny

// Padded local box + its lat/lon corners for a course's local bounds.
function aerialFrame(origin, bounds) {
  const lat0 = origin.lat, lon0 = origin.lon;
  const mPerLat = 111132.95, mPerLon = 111319.49 * Math.cos((lat0 * Math.PI) / 180);
  const minX = bounds.minX - PAD_M, minY = bounds.minY - PAD_M, maxX = bounds.maxX + PAD_M, maxY = bounds.maxY + PAD_M;
  return {
    lat0, lon0, mPerLat, mPerLon, minX, minY, maxX, maxY,
    lonAt: (x) => lon0 + x / mPerLon,
    latAt: (y) => lat0 + y / mPerLat,
    localBounds: { minX: +minX.toFixed(2), minY: +minY.toFixed(2), maxX: +maxX.toFixed(2), maxY: +maxY.toFixed(2) },
  };
}

function looksLikeImage(buf) {
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  return buf.length >= MIN_BYTES && (isJpg || isPng);
}

// Outside NAIP coverage (e.g. Scotland) the service answers with a valid, fully
// transparent PNG of the requested size (~5 KB), not an error blob. With
// format=jpgpng, imagery comes back as JPEG unless part of it is no-data, so only
// PNGs need the check. undefined = the PNG does not decode.
function fullyTransparentPng(buf) {
  if (!(buf[0] === 0x89 && buf[1] === 0x50)) return false;
  let png;
  try { png = PNG.sync.read(buf); } catch (_) { return undefined; }
  const d = png.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
  return true;
}

// One exportImage request: { status: 'ok', buf } | { status: 'none' } (the service
// answered with an error blob: no imagery there) | { status: 'failed', reason }.
async function exportImage(url, { fetchImpl, signal }) {
  let buf;
  try {
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal });
    if (!r || !r.ok) return { status: 'failed', reason: `HTTP ${r ? r.status : 'no response'}` };
    buf = Buffer.from(await r.arrayBuffer());
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    return { status: 'failed', reason: error && error.message };
  }
  throwIfAborted(signal);
  if (!looksLikeImage(buf)) return { status: 'none' }; // error blob / no-data
  const transparent = fullyTransparentPng(buf);
  if (transparent === undefined) return { status: 'failed', reason: 'undecodable PNG' };
  if (transparent) return { status: 'none' }; // no imagery anywhere in the box
  return { status: 'ok', buf };
}

async function requestCourseAerial({
  origin,
  bounds,
  fetchImpl = fetch,
  signal,
  gsdM = 0.3,
  maxPx = 4000,
} = {}) {
  throwIfAborted(signal);
  const f = aerialFrame(origin, bounds);
  const w = f.lonAt(f.minX), e = f.lonAt(f.maxX), s = f.latAt(f.minY), n = f.latAt(f.maxY);
  const wm = f.maxX - f.minX, hm = f.maxY - f.minY;
  const sc = Math.min(1 / gsdM, maxPx / Math.max(wm, hm)); // native 0.3 m, capped at maxPx on the long axis
  const W = Math.round(wm * sc), H = Math.round(hm * sc);
  const url = `${EXPORT}?bbox=${w},${s},${e},${n}&bboxSR=4326&imageSR=4326&size=${W},${H}&format=jpgpng&f=image`;
  const result = await exportImage(url, { fetchImpl, signal });
  if (result.status !== 'ok') return result;
  return { status: 'ok', buf: result.buf, bounds: f.localBounds, width: W, height: H, quality: 'single' };
}

async function fetchCourseAerial(options = {}) {
  const result = await requestCourseAerial(options);
  return result.status === 'ok' ? { buf: result.buf, bounds: result.bounds } : null;
}

// Max-quality tiled mosaic. `sharp` is injected (require('sharp') in the caller).
// Returns { status: 'ok', buf (JPEG), bounds, width, height, gsdM, provider,
// quality: 'tiled' } | { status: 'none' } | { status: 'failed', reason }.
async function fetchCourseAerialTiled({
  origin,
  bounds,
  sharp,
  fetchImpl = fetch,
  signal,
  gsdM = 0.3,
  tileM = TILE_M,
  maxDim = MAX_DIM,
  jpegQuality = 88,
} = {}) {
  if (typeof sharp !== 'function') throw new TypeError('fetchCourseAerialTiled needs sharp');
  throwIfAborted(signal);
  const f = aerialFrame(origin, bounds);
  const wm = f.maxX - f.minX, hm = f.maxY - f.minY;
  // Coarsen gsd only if the course is so large the mosaic would exceed maxDim.
  const gsd = Math.max(gsdM, Math.max(wm, hm) / maxDim);
  const W = Math.round(wm / gsd), H = Math.round(hm / gsd);

  const tileUrl = (base, tx0, ty0, tx1, ty1, pw, ph) =>
    `${base}?bbox=${f.lonAt(tx0)},${f.latAt(ty0)},${f.lonAt(tx1)},${f.latAt(ty1)}&bboxSR=4326&imageSR=4326&size=${pw},${ph}&format=jpgpng&f=image`;
  // snap every tile to its exact pixel size so the mosaic aligns
  const fit = (buf, pw, ph) => sharp(buf).resize(pw, ph, { fit: 'fill' }).toBuffer();

  let composites = [];
  let provider = `NAIPPlus ${gsd.toFixed(2)}m`;
  let tileFailure = null;
  for (let ty = f.minY; ty < f.maxY - 1e-6 && !tileFailure; ty += tileM) {
    for (let tx = f.minX; tx < f.maxX - 1e-6; tx += tileM) {
      const tx1 = Math.min(tx + tileM, f.maxX), ty1 = Math.min(ty + tileM, f.maxY);
      const pw = Math.max(1, Math.round((tx1 - tx) / gsd)), ph = Math.max(1, Math.round((ty1 - ty) / gsd));
      const tile = await exportImage(tileUrl(EXPORT, tx, ty, tx1, ty1, pw, ph), { fetchImpl, signal });
      if (tile.status !== 'ok') { tileFailure = tile; break; }
      const left = Math.round((tx - f.minX) / gsd);
      const top = Math.round((f.maxY - ty1) / gsd); // image row 0 = north = maxY
      composites.push({ input: await fit(tile.buf, pw, ph), left, top });
    }
  }
  if (tileFailure) {
    // One plain NAIP 0.6 m request for the whole box instead.
    const sc = Math.min(1 / 0.6, 4000 / Math.max(wm, hm));
    const fw = Math.round(wm * sc), fh = Math.round(hm * sc);
    const single = await exportImage(tileUrl(NAIP_EXPORT, f.minX, f.minY, f.maxX, f.maxY, fw, fh), { fetchImpl, signal });
    if (single.status !== 'ok') {
      return single.status === 'none' && tileFailure.status === 'none'
        ? { status: 'none' }
        : { status: 'failed', reason: single.reason || tileFailure.reason || 'no imagery' };
    }
    composites = [{ input: await fit(single.buf, W, H), left: 0, top: 0 }];
    provider = 'NAIP 0.6m (fallback)';
  }
  throwIfAborted(signal);
  const buf = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 70, g: 95, b: 65 } } })
    .composite(composites).jpeg({ quality: jpegQuality }).toBuffer();
  return { status: 'ok', buf, bounds: f.localBounds, width: W, height: H, gsdM: gsd, provider, quality: 'tiled' };
}

module.exports = {
  AERIAL_PAD_M: PAD_M,
  fetchCourseAerial,
  fetchCourseAerialTiled,
  requestCourseAerial,
};
