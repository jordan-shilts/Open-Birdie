'use strict';
// Lakes and ponds around a course (lib/water-fetch.js): ring assembly, the same
// projection as parseOsm, de-duplication against course.surfaces, clipping to the
// elevation grid. Offline (Overpass is a fake).

const test = require('node:test');
const assert = require('node:assert/strict');
const { assembleRings, clipToBox, fetchNearbyWater, parseWater, waterQuery } = require('../lib/water-fetch');
const { canopyBlocker } = require('../lib/canopy-fetch');
const { parseOsm } = require('../lib/course');

const M_PER_LAT = 111132.95;

// A course parsed by parseOsm (so its water surface is projected the real way),
// with a 1 km elevation grid around it.
function fixture() {
  const at = (lat, lon) => ({ lat, lon });
  const pondOnCourse = [at(45.0001, -93.0001), at(45.0001, -92.9999), at(45.0003, -92.9999), at(45.0003, -93.0001), at(45.0001, -93.0001)];
  const osm = {
    elements: [
      { type: 'way', id: 1, tags: { golf: 'hole', ref: '1', par: '3' }, geometry: [at(44.999, -93), at(45.0002, -93.0002)] },
      { type: 'way', id: 2, tags: { natural: 'water' }, geometry: pondOnCourse },
    ],
  };
  const course = parseOsm(osm, 'Water Links', null, { osmType: 'way', osmId: 500 });
  course.elevation = { minX: -500, minY: -500, cellM: 10, nx: 101, ny: 101, baseM: 0, heights: [] };
  const mPerLon = 111319.49 * Math.cos((course.origin.lat * Math.PI) / 180);
  const ll = (x, y) => at(course.origin.lat + y / M_PER_LAT, course.origin.lon + x / mPerLon);
  return { course, pondOnCourse, ll };
}

test('ways sharing end nodes become closed rings; open chains are dropped', () => {
  const p = (lat, lon) => ({ lat, lon });
  const a = [p(0, 0), p(0, 1), p(1, 1)];
  const b = [p(0, 0), p(1, 0), p(1, 1)]; // runs the other way round
  const rings = assembleRings([a, b]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 5);
  assert.deepEqual(rings[0][0], rings[0][4]);
  assert.deepEqual(assembleRings([[p(0, 0), p(0, 1), p(1, 1)]]), [], 'an open chain is not a lake');
});

test('clipping keeps a lake to the elevation grid', () => {
  const clipped = clipToBox([[300, -100], [800, -100], [800, 100], [300, 100]], { minX: -500, minY: -500, maxX: 500, maxY: 500 });
  assert.deepEqual(clipped, [[300, -100], [500, -100], [500, 100], [300, 100]]);
  assert.equal(clipToBox([[600, 0], [700, 0], [700, 10]], { minX: -500, minY: -500, maxX: 500, maxY: 500 }), null);
});

test('nearby water: relations assembled from outer ways, ponds kept, course water and open chains dropped', () => {
  const { course, pondOnCourse, ll } = fixture();
  assert.equal(course.surfaces.filter((s) => s.kind === 'water').length, 1);
  const ring = (pts) => [...pts.map(([x, y]) => ll(x, y)), ll(pts[0][0], pts[0][1])];
  const lakeNorth = [ll(300, 100), ll(800, 100), ll(800, -100)];
  const lakeSouth = [ll(800, -100), ll(300, -100), ll(300, 100)];
  const osm = {
    elements: [
      { type: 'way', id: 2, tags: { natural: 'water' }, geometry: pondOnCourse }, // already a course surface
      { type: 'way', id: 20, tags: { natural: 'water', water: 'pond', name: 'Duck Pond' }, geometry: ring([[-200, -200], [-150, -200], [-150, -150], [-200, -150]]) },
      { type: 'way', id: 21, tags: { natural: 'water' }, geometry: [ll(0, 300), ll(50, 300), ll(50, 350)] }, // unclosed
      {
        type: 'relation', id: 30, tags: { type: 'multipolygon', natural: 'water', water: 'lake', name: 'Lake Big' },
        members: [{ type: 'way', ref: 31, role: 'outer' }, { type: 'way', ref: 32, role: 'outer' }, { type: 'way', ref: 33, role: 'inner' }],
      },
      { type: 'way', id: 31, geometry: lakeNorth },
      { type: 'way', id: 32, geometry: lakeSouth },
      {
        type: 'relation', id: 40, tags: { type: 'multipolygon', natural: 'water', name: 'Great Lake' },
        members: [{ type: 'way', ref: 41, role: 'outer' }, { type: 'way', ref: 42, role: 'outer' }],
      },
      { type: 'way', id: 41, geometry: [ll(-450, 400), ll(-400, 450)] }, // only part of its shore near the course
    ],
  };
  const water = parseWater(osm, course);
  assert.deepEqual(water.map((w) => w.name).sort(), ['Duck Pond', 'Lake Big']);
  assert.ok(water.every((w) => w.kind === 'water'));
  const lake = water.find((w) => w.name === 'Lake Big');
  assert.ok(lake.poly.every(([x, y]) => x >= -500 && x <= 500 && y >= -500 && y <= 500), 'clipped to the grid');
  assert.equal(Math.max(...lake.poly.map((p) => p[0])), 500);
  const pond = water.find((w) => w.name === 'Duck Pond');
  assert.deepEqual(pond.poly[0], [-200, -200], 'same projection as parseOsm');
  assert.equal(course.surfaces.filter((s) => s.kind === 'water').length, 1, 'course.surfaces untouched');

  // trees never stand in a lake once it is attached
  course.scenery = { water };
  const blocked = canopyBlocker(course);
  assert.equal(blocked(400, 0), true);
  assert.equal(blocked(-300, -300), false);
});

test('the query covers the grid plus a 1 km pad and fetches only relation outer ways near the course', async () => {
  const { course } = fixture();
  const q = waterQuery(course);
  assert.match(q, /way\["natural"="water"\]\(/);
  assert.match(q, /relation\["water"~"\^\(lake\|pond\|reservoir\)\$"\]\(/);
  assert.match(q, /\.r out body;way\(r\.r:"outer"\)\(/);
  const south = course.origin.lat + (-500 - 1000) / M_PER_LAT;
  assert.ok(q.includes(`(${south},`), 'grid minY minus 1 km');
  let seen = null;
  const water = await fetchNearbyWater(course, {
    overpassImpl: async (query, options) => { seen = { query, options }; return { elements: [] }; },
  });
  assert.deepEqual(water, []);
  assert.equal(seen.query, q);
  assert.equal(seen.options.timeoutMs, 100_000);
});
