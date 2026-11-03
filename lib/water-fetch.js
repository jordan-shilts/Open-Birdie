'use strict';
// Lakes, ponds and reservoirs AROUND a course, as
// `course.scenery.water = [{ kind: 'water', poly: [[x, y], ...], name }]`.
//
// The course load only carries water mapped as ways near the course itself, so a
// lake beside the closing holes that OSM maps as a multipolygon (Lake Hazeltine,
// beside 16-18) was missing — and 3DEP lidar is hydro-flattened there, so it showed
// as flat ground. This fetches every water area intersecting the elevation grid,
// assembles relation outlines from their outer ways, projects them exactly like
// parseOsm (same origin), clips them to the grid and drops any outline the course
// already has in course.surfaces.
//
// NON-fingerprinted scenery: never part of course.surfaces, so it does not change the
// HD fingerprint. Every lake is drawn; one that reaches the course is played as water
// too (lib/course.js lakesInPlay).

const { overpass, pointInPoly } = require('./course');
const { canopyBounds } = require('./canopy-fetch');

const M_PER_LAT = 111132.95;
const QUERY_PAD_M = 1000; // fetch whole outlines of lakes that reach past the grid
const MIN_AREA_M2 = 25;
const FILTERS = Object.freeze(['["natural"="water"]', '["water"~"^(lake|pond|reservoir)$"]', '["landuse"="reservoir"]']);
const OVERPASS_WATER_TIMEOUT_MS = 100_000;

function isWaterTags(tags = {}) {
  return tags.natural === 'water' || ['lake', 'pond', 'reservoir'].includes(tags.water) || tags.landuse === 'reservoir';
}

function frame(course) {
  const { lat: lat0, lon: lon0 } = course.origin;
  const mPerLon = 111319.49 * Math.cos((lat0 * Math.PI) / 180);
  return {
    // identical to parseOsm's projection, so outlines line up with course.surfaces
    proj: (c) => [+((c.lon - lon0) * mPerLon).toFixed(2), +((c.lat - lat0) * M_PER_LAT).toFixed(2)],
    lat: (y) => lat0 + y / M_PER_LAT,
    lon: (x) => lon0 + x / mPerLon,
  };
}

function waterQuery(course, { padM = QUERY_PAD_M } = {}) {
  const b = canopyBounds(course); // the elevation grid (else the course + 80 m)
  const f = frame(course);
  const box = `${f.lat(b.minY - padM)},${f.lon(b.minX - padM)},${f.lat(b.maxY + padM)},${f.lon(b.maxX + padM)}`;
  const ways = FILTERS.map((x) => `way${x}(${box});`).join('');
  const relations = FILTERS.map((x) => `relation${x}(${box});`).join('');
  // Relations: their member list, then only their outer ways near the course
  // (a lake the size of a Great Lake would otherwise be megabytes of shoreline).
  return `[out:json][timeout:90];(${ways})->.w;(${relations})->.r;.w out tags geom;.r out body;way(r.r:"outer")(${box});out geom;`;
}

const keyOf = (p) => `${p.lat},${p.lon}`;

// Join ways that share end nodes into closed rings; open chains are dropped.
function assembleRings(parts) {
  const pending = parts.filter((g) => Array.isArray(g) && g.length >= 2).map((g) => g.slice());
  const rings = [];
  while (pending.length) {
    let ring = pending.shift();
    let joined = true;
    while (keyOf(ring[0]) !== keyOf(ring[ring.length - 1]) && joined) {
      joined = false;
      for (let i = 0; i < pending.length; i++) {
        const seg = pending[i];
        const head = keyOf(ring[0]), tail = keyOf(ring[ring.length - 1]);
        const s0 = keyOf(seg[0]), s1 = keyOf(seg[seg.length - 1]);
        if (s0 === tail) ring = ring.concat(seg.slice(1));
        else if (s1 === tail) ring = ring.concat(seg.slice(0, -1).reverse());
        else if (s1 === head) ring = seg.concat(ring.slice(1));
        else if (s0 === head) ring = seg.slice().reverse().concat(ring.slice(1));
        else continue;
        pending.splice(i, 1);
        joined = true;
        break;
      }
    }
    if (ring.length >= 4 && keyOf(ring[0]) === keyOf(ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

function area(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a) / 2;
}

function centroid(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

// Sutherland–Hodgman against the axis-aligned grid box (convex clip region, so any
// simple outline clips correctly).
function clipToBox(poly, { minX, minY, maxX, maxY }) {
  const edges = [
    [(p) => p[0] >= minX, (a, b) => { const t = (minX - a[0]) / (b[0] - a[0]); return [minX, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[0] <= maxX, (a, b) => { const t = (maxX - a[0]) / (b[0] - a[0]); return [maxX, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[1] >= minY, (a, b) => { const t = (minY - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), minY]; }],
    [(p) => p[1] <= maxY, (a, b) => { const t = (maxY - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), maxY]; }],
  ];
  let out = poly;
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cut(prev, cur));
      }
    }
    if (!out.length) return null;
  }
  return out.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]);
}

const outlineKey = (poly) => JSON.stringify(poly);

// Overpass JSON -> course.scenery.water for this course.
function parseWater(osm, course) {
  const f = frame(course);
  const ways = new Map();
  const relations = [];
  for (const el of (osm && osm.elements) || []) {
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      const prev = ways.get(el.id);
      ways.set(el.id, { geometry: el.geometry, tags: { ...(prev ? prev.tags : {}), ...(el.tags || {}) } });
    } else if (el.type === 'relation') {
      relations.push(el);
    }
  }
  const rings = [];
  const outerMembers = new Set();
  for (const rel of relations) {
    if (!isWaterTags(rel.tags)) continue;
    const outer = (rel.members || []).filter((m) => m.type === 'way' && (m.role === 'outer' || !m.role));
    for (const m of outer) outerMembers.add(m.ref);
    const parts = outer.map((m) => ways.get(m.ref)).filter(Boolean).map((w) => w.geometry);
    for (const ring of assembleRings(parts)) rings.push({ ring, name: (rel.tags && rel.tags.name) || null });
  }
  for (const [id, way] of ways) {
    if (outerMembers.has(id) || !isWaterTags(way.tags)) continue;
    for (const ring of assembleRings([way.geometry])) rings.push({ ring, name: way.tags.name || null });
  }

  // What the course already has (course.surfaces water, same projection).
  const known = (course.surfaces || []).filter((s) => s.kind === 'water' && Array.isArray(s.poly) && s.poly.length >= 3)
    .map((s) => {
      const poly = outlineKey(s.poly[0]) === outlineKey(s.poly[s.poly.length - 1]) ? s.poly.slice(0, -1) : s.poly;
      return { poly, key: outlineKey(poly), area: area(poly) };
    });
  const duplicate = (poly) => {
    const key = outlineKey(poly);
    const [cx, cy] = centroid(poly);
    const a = area(poly);
    return known.some((k) => k.key === key ||
      (pointInPoly(cx, cy, k.poly) && Math.min(a, k.area) / Math.max(a, k.area) > 0.8));
  };

  const box = canopyBounds(course);
  const out = [];
  const seen = new Set();
  for (const { ring, name } of rings) {
    const poly = ring.slice(0, -1).map(f.proj); // drop the closing repeat
    if (poly.length < 3 || duplicate(poly)) continue;
    const clipped = clipToBox(poly, box);
    if (!clipped || clipped.length < 3 || area(clipped) < MIN_AREA_M2) continue;
    const key = outlineKey(clipped);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: 'water', poly: clipped, name });
  }
  return out;
}

// Every lake/pond/reservoir around the course ([] when there is none). Throws
// when Overpass cannot answer (retried later).
async function fetchNearbyWater(course, { signal, fetchImpl, endpoints, overpassImpl = overpass } = {}) {
  const osm = await overpassImpl(waterQuery(course), {
    signal,
    fetchImpl,
    endpoints,
    timeoutMs: OVERPASS_WATER_TIMEOUT_MS,
  });
  return parseWater(osm, course);
}

module.exports = {
  assembleRings,
  clipToBox,
  fetchNearbyWater,
  parseWater,
  waterQuery,
};
