// Optional Google Photorealistic 3D Tiles: config gating (server + page), the course
// rectangle clip, projection scale, alignment sampling and the robust height offset
// (public/render/google-tiles.js, lib/google-tiles-config.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  googleTilesMode, clipRectFromElevation, clipUniformRect, clipKeepFraction, circleInsideRect,
  projectionScale, anchorScale, perimeterSamples, filterOpenGround, median, robustHeightOffset, attributionText,
} from '../public/render/google-tiles.js';
import { RENDER_CONFIG } from '../public/render/config.js';

const require = createRequire(import.meta.url);
const { googleTilesConfig } = require('../lib/google-tiles-config.js');
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (±${eps})`);

// ---------- gating ----------

test('server: no key -> disabled, nothing to hand out', () => {
  assert.deepEqual(googleTilesConfig({ env: {}, loopback: true }), { enabled: false, reason: 'no-key' });
  assert.deepEqual(googleTilesConfig({ env: { GOOGLE_MAPS_API_KEY: '   ' }, loopback: true }), { enabled: false, reason: 'no-key' });
});

test('server: the key only ever reaches loopback clients', () => {
  const env = { GOOGLE_MAPS_API_KEY: ' k-123 ' };
  const lan = googleTilesConfig({ env, loopback: false });
  assert.deepEqual(lan, { enabled: false, reason: 'not-loopback' });
  assert.ok(!JSON.stringify(lan).includes('k-123'));
  assert.deepEqual(googleTilesConfig({ env, loopback: true }), { enabled: true, apiKey: 'k-123' });
});

test('server: optional dev root tileset and installed logo pass through', () => {
  const env = { GOOGLE_MAPS_API_KEY: 'k', BIRDIE_GOOGLE_TILES_ROOT: 'http://127.0.0.1:9/tileset.json' };
  assert.deepEqual(googleTilesConfig({ env, loopback: true, logoUrl: 'assets/x.svg' }),
    { enabled: true, apiKey: 'k', rootUrl: 'http://127.0.0.1:9/tileset.json', logoUrl: 'assets/x.svg' });
});

test('page: off without a server key (zero behaviour change)', () => {
  for (const serverConfig of [null, undefined, {}, { enabled: false, reason: 'no-key' }, { enabled: true }, { enabled: true, apiKey: '  ' }]) {
    assert.equal(googleTilesMode({ serverConfig }).enabled, false);
  }
  assert.equal(googleTilesMode({ serverConfig: { enabled: false, reason: 'not-loopback' } }).reason, 'not-loopback');
});

test('page: on with a key; URL and render-config opt-outs; capture runs need an opt-in', () => {
  const serverConfig = { enabled: true, apiKey: 'k', rootUrl: 'http://x/t.json' };
  assert.deepEqual(googleTilesMode({ serverConfig, search: '?gfx=high' }),
    { enabled: true, reason: 'key', apiKey: 'k', rootUrl: 'http://x/t.json', logoUrl: null });
  assert.equal(googleTilesMode({ serverConfig, search: '?googleTiles=0' }).reason, 'url-off');
  assert.equal(googleTilesMode({ serverConfig, search: '?visualCapture=1' }).reason, 'visual-capture');
  assert.equal(googleTilesMode({ serverConfig, search: '?visualCapture=1&googleTiles=1' }).enabled, true);
  assert.equal(googleTilesMode({ serverConfig, enabledInConfig: false }).reason, 'render-config');
});

test('render config: Google tiles allowed by default with sane budgets', () => {
  assert.equal(RENDER_CONFIG.googleTiles, true);
  assert.ok(RENDER_CONFIG.googleTilesErrorTarget >= 8 && RENDER_CONFIG.googleTilesErrorTarget <= 40);
  assert.ok(RENDER_CONFIG.googleTilesCacheMB >= 64 && RENDER_CONFIG.googleTilesCacheMB <= 1024);
  assert.ok(RENDER_CONFIG.googleTilesClipEdgeM > 0 && RENDER_CONFIG.googleTilesClipEdgeM <= 20);
});

// ---------- course rectangle clip ----------

const ELEV = { minX: -1255.16, minY: -1269.48, cellM: 2, nx: 1043, ny: 1131, baseM: 290.5 };

test('clip rectangle = the rendered terrain grid extent', () => {
  const r = clipRectFromElevation(ELEV);
  assert.deepEqual(r, { minX: -1255.16, minY: -1269.48, maxX: -1255.16 + 1042 * 2, maxY: -1269.48 + 1130 * 2 });
  assert.equal(clipRectFromElevation(null), null);
  assert.equal(clipRectFromElevation({ minX: 0, minY: 0, cellM: 2, nx: 1, ny: 5 }), null);
  assert.equal(clipRectFromElevation({ minX: 0, minY: 0, cellM: 0, nx: 5, ny: 5 }), null);
});

test('clip uniform is the rectangle in three world XZ (z = -north)', () => {
  assert.deepEqual(clipUniformRect({ minX: -10, minY: -20, maxX: 30, maxY: 40 }), [-10, -40, 30, 20]);
});

test('clip keeps all of Google outside, none deep inside, a linear dithered seam between', () => {
  const r = { minX: 0, minY: 0, maxX: 1000, maxY: 800 };
  assert.equal(clipKeepFraction(-5, 400, r, 6), 1);     // outside (west)
  assert.equal(clipKeepFraction(500, 900, r, 6), 1);    // outside (north)
  assert.equal(clipKeepFraction(0, 400, r, 6), 1);      // exactly on the edge
  near(clipKeepFraction(3, 400, r, 6), 0.5, 1e-12);     // half-way across the seam
  near(clipKeepFraction(500, 799, r, 6), 1 - 1 / 6, 1e-12); // nearest edge wins
  assert.equal(clipKeepFraction(6, 400, r, 6), 0);      // a seam-width in
  assert.equal(clipKeepFraction(500, 400, r, 6), 0);    // course interior: ours
});

test('interior mask: only tiles wholly inside (with margin) are skipped', () => {
  const r3 = { minX: 0, minZ: -800, maxX: 1000, maxZ: 0 };
  assert.equal(circleInsideRect(500, -400, 100, r3, 120), true);
  assert.equal(circleInsideRect(500, -400, 300, r3, 120), false); // reaches the edge band
  assert.equal(circleInsideRect(150, -400, 20, r3, 120), true);
  assert.equal(circleInsideRect(130, -400, 20, r3, 120), false);  // inside, but within the margin
  assert.equal(circleInsideRect(-50, -400, 10, r3, 0), false);    // outside
});

// ---------- projection ----------

test('projection scale maps true WGS84 metres onto the course equirectangular metres', () => {
  const eq = projectionScale(0);
  near(eq.sx, 1, 1e-6, 'equator east');
  near(eq.sy, 111132.95 / 110574.27, 2e-5, 'equator north');
  const hz = projectionScale(44.83136845943423); // Hazeltine's origin
  near(hz.sx, 0.998334, 2e-6);                   // ~1.7 m per km east
  near(hz.sy, 1.0000, 1e-4);
  const s = projectionScale(-44.83136845943423);
  near(s.sx, hz.sx, 1e-12); near(s.sy, hz.sy, 1e-12);
  // a point 1 km true-east of the origin lands where the course projection puts it
  const lat0 = 44.83136845943423, a = 6378137, e2 = 6.69437999014e-3;
  const N = a / Math.sqrt(1 - e2 * Math.sin((lat0 * Math.PI) / 180) ** 2);
  const dLonDeg = 1000 / ((Math.PI / 180) * N * Math.cos((lat0 * Math.PI) / 180));
  near(1000 * hz.sx, dLonDeg * 111319.49 * Math.cos((lat0 * Math.PI) / 180), 1e-6);
});

test('the tileset gets one (uniform) scale: the mean, leaving < 1 m per km at 45°N', () => {
  for (const lat of [0, 30, 44.83, 56.34, 70]) {
    const { sx, sy } = projectionScale(lat), s = anchorScale(lat);
    near(s, (sx + sy) / 2, 1e-15);
    assert.ok(Math.abs(sx - s) <= 0.0026 && Math.abs(sy - s) <= 0.0026, `lat ${lat}: residual ${Math.abs(sx - s)}`);
  }
  assert.ok(Math.abs(projectionScale(44.83).sx - anchorScale(44.83)) * 1000 < 1, '< 1 m per km at Hazeltine');
});

// ---------- alignment ----------

test('perimeter samples ring the rectangle just inside its edge', () => {
  const r = { minX: -1000, minY: -1200, maxX: 1100, maxY: 1000 };
  const pts = perimeterSamples(r);
  assert.ok(pts.length > 80 && pts.length < 160, `${pts.length}`);
  for (const [x, y] of pts) {
    const inside = Math.min(x - r.minX, r.maxX - x, y - r.minY, r.maxY - y);
    assert.ok(inside >= 25 - 1e-9 && inside <= 70 + 1e-9, `inset ${inside}`);
  }
  assert.deepEqual(perimeterSamples({ minX: 0, minY: 0, maxX: 30, maxY: 30 }), []); // too small for any ring
});

test('open-ground filter drops samples under our trees and inside our buildings', () => {
  const pts = [[0, 0], [100, 0], [200, 0], [300, 0]];
  const trees = [{ x: 101, y: 1, r: 5 }, { x: 0, y: 30, s: 1 }];
  const buildings = [{ poly: [[190, -10], [210, -10], [210, 10], [190, 10]] }];
  assert.deepEqual(filterOpenGround(pts, { trees, buildings }), [[0, 0], [300, 0]]);
});

test('height offset: the median of the dominant cluster, robust to canopy and roof hits', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  // ground hits around -261.5 m (NAVD88 - ellipsoid - baseM), 35% canopy/roof hits read Google 6-25 m high
  const ground = [-261.9, -261.6, -261.4, -261.5, -261.3, -261.8, -261.2, -261.7, -261.5, -261.6, -261.4, -261.5, -261.45];
  const canopy = [-268, -275, -280, -286, -270, -277, -283];
  near(robustHeightOffset([...ground, ...canopy]), -261.5, 0.05);
  // a hole in the mesh (ray hits something far below) is ignored too
  near(robustHeightOffset([...ground, -200, -190]), -261.5, 0.05);
  // a plain median would be dragged into the canopy
  assert.ok(Math.abs(median([...ground, ...canopy, -290, -292, -295, -300, -284, -279]) + 261.5) > 2);
  near(robustHeightOffset([...ground, ...canopy, -290, -292, -295, -300, -284, -279]), -261.5, 0.05);
});

test('height offset: not enough evidence yet -> null (retry when more tiles load)', () => {
  assert.equal(robustHeightOffset([1, 2, 3]), null);                        // too few
  assert.equal(robustHeightOffset([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]), null); // no cluster
  assert.equal(robustHeightOffset([NaN, Infinity, 1, 1, 1]), null);
  // ties between equal clusters go to the higher one (canopy only ever pulls diffs down)
  near(robustHeightOffset([0, 0.1, 0.2, 0.3, 10, 10.1, 10.2, 10.3], { minSamples: 8 }), 10.15, 1e-9);
});

test('attribution text joins the string attributions in order', () => {
  const list = [{ type: 'image', value: 'logo.svg' }, { type: 'string', value: ' Google; Airbus ' }, { type: 'string', value: '' }, { type: 'string', value: 'Maxar' }];
  assert.equal(attributionText(list), 'Google; Airbus; Maxar');
  assert.equal(attributionText(null), '');
});
