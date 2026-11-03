'use strict';
// OSM building footprints for a course: `course.buildings = [{ poly, heightM, kind,
// name, clubhouse }]` with the footprint in the course's local metres. Buildings are
// NON-fingerprinted scenery (not in canonicalCourse, like elevation.patches), so
// attaching them never invalidates an HD bundle.
//
// Runtime-safe (one Overpass query through the shared client in lib/course.js: same
// mirror list, deadlines and retries), so it runs on every course load in the
// packaged app. tools/add-buildings.mjs is a thin CLI wrapper over this module.

const { courseBounds, overpass } = require('./course');

const PAD_M = 150;
const M_PER_LAT = 111132.95;
const OVERPASS_BUILDINGS_TIMEOUT_MS = 100_000;

function metresPerDegree(origin) {
  return {
    mPerLat: M_PER_LAT,
    mPerLon: 111319.49 * Math.cos((origin.lat * Math.PI) / 180),
  };
}

// Overpass query for every building in the course extent plus a pad, so the
// clubhouse and the houses lining the holes are included.
function buildingsQuery(course, { padM = PAD_M } = {}) {
  const { lat: lat0, lon: lon0 } = course.origin;
  const { mPerLat, mPerLon } = metresPerDegree(course.origin);
  const b = courseBounds(course);
  const s = lat0 + (b.minY - padM) / mPerLat, n = lat0 + (b.maxY + padM) / mPerLat;
  const w = lon0 + (b.minX - padM) / mPerLon, e = lon0 + (b.maxX + padM) / mPerLon;
  return `[out:json][timeout:90];(way["building"](${s},${w},${n},${e});relation["building"](${s},${w},${n},${e}););out tags geom;`;
}

function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// Overpass JSON -> buildings in local metres. Height: the height tag, else 3.2 m per
// level, else 9 m for a clubhouse and 5 m for anything else.
function parseBuildings(osm, origin) {
  const { lat: lat0, lon: lon0 } = origin;
  const { mPerLat, mPerLon } = metresPerDegree(origin);
  const proj = (c) => [+((c.lon - lon0) * mPerLon).toFixed(2), +((c.lat - lat0) * mPerLat).toFixed(2)];
  const buildings = [];
  for (const el of (osm && osm.elements) || []) {
    const tags = el.tags || {};
    let geom = el.geometry;
    if (!geom && el.members) geom = (el.members.find((m) => m.role === 'outer' || !m.role) || {}).geometry;
    if (!geom || geom.length < 3) continue;
    const levels = parseFloat(tags['building:levels']) || 0;
    const heightTag = parseFloat(tags.height) || 0;
    const bt = (tags.building || '').toLowerCase();
    const clubhouse = bt === 'clubhouse' || tags.golf === 'clubhouse' || tags.amenity === 'clubhouse'
      || /club\s*house|pro\s*shop/i.test(tags.name || '');
    const heightM = heightTag || (levels ? levels * 3.2 : (clubhouse ? 9 : 5));
    buildings.push({
      poly: geom.map(proj),
      heightM: +heightM.toFixed(1),
      kind: bt || 'yes',
      name: tags.name || null,
      clubhouse,
    });
  }
  return buildings;
}

// Largest building, if nothing is tagged clubhouse, is a good hero candidate:
// promote it so every course gets one "feature" building. Mutates and returns.
function promoteHeroBuilding(buildings) {
  if (buildings.length && !buildings.some((b) => b.clubhouse)) {
    let best = null, bestA = 0;
    for (const b of buildings) {
      const a = polygonArea(b.poly);
      if (a > bestA) { bestA = a; best = b; }
    }
    if (best && bestA > 60) { best.clubhouse = true; best.heightM = Math.max(best.heightM, 8); }
  }
  return buildings;
}

// Every building on and around the course ([] when OSM maps none there). Throws when
// Overpass cannot answer (the caller retries later). fetchImpl/endpoints are passed
// to the Overpass client so tests run offline.
async function fetchBuildings(course, {
  signal,
  fetchImpl,
  endpoints,
  overpassImpl = overpass,
  padM = PAD_M,
} = {}) {
  const osm = await overpassImpl(buildingsQuery(course, { padM }), {
    signal,
    fetchImpl,
    endpoints,
    timeoutMs: OVERPASS_BUILDINGS_TIMEOUT_MS,
  });
  return promoteHeroBuilding(parseBuildings(osm, course.origin));
}

module.exports = {
  BUILDINGS_PAD_M: PAD_M,
  buildingsQuery,
  fetchBuildings,
  parseBuildings,
  promoteHeroBuilding,
};
