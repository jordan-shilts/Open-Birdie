'use strict';
// Optional Google Photorealistic 3D Tiles around the course (public/render/google-tiles.js).
// OFF unless the app is started with the user's own Map Tiles API key in
// GOOGLE_MAPS_API_KEY — then GET /api/google-tiles-config hands it to the page. The key is a
// billing credential: it only ever goes to loopback clients (the local window / browser,
// never a LAN mirror), is never logged, and the response is not cached.
//
// BIRDIE_GOOGLE_TILES_ROOT (development/testing only) points the page at another root
// tileset URL instead of Google's, e.g. a local synthetic tileset.

function googleTilesConfig({ env = process.env, loopback = false, logoUrl = null } = {}) {
  const apiKey = String(env.GOOGLE_MAPS_API_KEY || '').trim();
  if (!apiKey) return { enabled: false, reason: 'no-key' };
  if (!loopback) return { enabled: false, reason: 'not-loopback' };
  const config = { enabled: true, apiKey };
  const rootUrl = String(env.BIRDIE_GOOGLE_TILES_ROOT || '').trim();
  if (rootUrl) config.rootUrl = rootUrl;
  if (logoUrl) config.logoUrl = logoUrl;
  return config;
}

module.exports = { googleTilesConfig };
