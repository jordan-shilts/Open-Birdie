'use strict';
// A feature that only passes a course (TPC Scottsdale's 48 km canal, mapped as one
// water polygon) must not stretch the course's area: parseOsm keeps its part near the
// holes, and leaves everything ending within 3 km of them exactly as mapped.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseOsm, courseBounds } = require('../lib/course');

const ring = (lat0, lon0, lat1, lon1) => [
  { lat: lat0, lon: lon0 }, { lat: lat0, lon: lon1 }, { lat: lat1, lon: lon1 }, { lat: lat1, lon: lon0 }, { lat: lat0, lon: lon0 },
];
const way = (tags, geometry) => ({ type: 'way', tags, geometry });

function osm(extra = []) {
  return { elements: [
    way({ golf: 'hole', ref: '1', par: '4' }, [{ lat: 33.640, lon: -111.900 }, { lat: 33.643, lon: -111.900 }]),
    way({ golf: 'hole', ref: '2', par: '4' }, [{ lat: 33.643, lon: -111.902 }, { lat: 33.640, lon: -111.902 }]),
    way({ golf: 'green' }, ring(33.6428, -111.9002, 33.6432, -111.8998)),
    way({ golf: 'green' }, ring(33.6398, -111.9022, 33.6402, -111.9018)),
    // a pond 1.2 km east of the holes: near enough to keep as mapped
    way({ natural: 'water' }, ring(33.641, -111.887, 33.642, -111.886)),
    ...extra,
  ] };
}

// the course's own projection (parseOsm's), to compare a polygon with its mapped points
function projector(course) {
  const mPerLat = 111132.95;
  const mPerLon = 111319.49 * Math.cos(course.origin.lat * Math.PI / 180);
  return (c) => [+((c.lon - course.origin.lon) * mPerLon).toFixed(2), +((c.lat - course.origin.lat) * mPerLat).toFixed(2)];
}

function holesBox(course) {
  const xs = [], ys = [];
  for (const h of course.holes) for (const [x, y] of h.line) { xs.push(x); ys.push(y); }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

test('a canal crossing the course keeps only its part near the holes', () => {
  // 56 km long, 11 m wide, running just north of the greens
  const canal = way({ natural: 'water', name: 'Canal' }, ring(33.6445, -112.2, 33.6446, -111.6));
  const course = parseOsm(osm([canal]), 'Test', null);
  const box = holesBox(course);
  const pond = JSON.stringify(ring(33.641, -111.887, 33.642, -111.886).map(projector(course)));
  const water = course.surfaces.filter((s) => s.kind === 'water');
  assert.equal(water.length, 2, 'the pond and the near part of the canal');
  assert.ok(water.some((s) => JSON.stringify(s.poly) === pond), 'the pond, as mapped');
  const canalPart = water.find((s) => JSON.stringify(s.poly) !== pond).poly;
  for (const [x, y] of canalPart) {
    assert.ok(x >= box.minX - 500.01 && x <= box.maxX + 500.01, `x ${x} within 500 m of the holes`);
    assert.ok(y >= box.minY - 500.01 && y <= box.maxY + 500.01, `y ${y} within 500 m of the holes`);
  }
  const xs = canalPart.map(([x]) => x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 1000, 'still runs right across the course');
  assert.deepEqual(canalPart[0], canalPart[canalPart.length - 1], 'still a closed ring');
  const b = courseBounds(course);
  assert.ok(b.maxX - b.minX < 3000, `course area ${Math.round(b.maxX - b.minX)} m wide`);
});

test('features ending within 3 km of the holes stay exactly as mapped', () => {
  const pondRing = ring(33.641, -111.887, 33.642, -111.886);
  const course = parseOsm(osm(), 'Test', null);
  const proj = projector(course);
  const pond = course.surfaces.find((s) => s.kind === 'water');
  assert.deepEqual(pond.poly, pondRing.map(proj));
});

test('a runaway feature that never comes near the holes is dropped', () => {
  const river = way({ waterway: 'riverbank', natural: 'water' }, ring(33.70, -112.2, 33.701, -111.6)); // 6.5 km north
  const forest = { type: 'relation', tags: { landuse: 'forest' }, members: [{ role: 'outer', geometry: ring(33.60, -112.3, 33.70, -111.5) }] };
  const course = parseOsm(osm([river, forest]), 'Test', null);
  assert.equal(course.surfaces.filter((s) => s.kind === 'water').length, 1, 'only the pond');
  assert.equal(course.woods.length, 1, 'the forest round the course is kept');
  const box = holesBox(course);
  for (const [x, y] of course.woods[0]) {
    assert.ok(x >= box.minX - 500.01 && x <= box.maxX + 500.01 && y >= box.minY - 500.01 && y <= box.maxY + 500.01);
  }
});
