// tools/hd-course/auto-pin.mjs: which NAIP acquisition a hole is pinned to, and that
// the manifests it writes are ones the compiler accepts. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_TERRAIN, COARSE_TERRAIN, autoManifestTemplate, pickAcquisition } from '../tools/hd-course/auto-pin.mjs';
import { parseManifest } from '../tools/hd-course/config.mjs';

const bbox = { west: -93.60, south: 44.82, east: -93.58, north: 44.83 };
// a NAIP item covering [w, s, e, n]
const item = (id, date, [w, s, e, n], gsd = 0.3) => ({
  id,
  bbox: [w, s, e, n],
  geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  properties: { datetime: `${date}T16:00:00Z`, gsd, 'proj:epsg': 26915 },
});

test('the newest acquisition that covers the whole hole is pinned', () => {
  const features = [
    item('old-full', '2019-07-01', [-93.7, 44.7, -93.5, 44.9], 0.6),
    item('new-west', '2023-07-31', [-93.7, 44.7, -93.59, 44.9]),          // newer, but only half the hole
    item('mid-a', '2021-08-10', [-93.7, 44.7, -93.59, 44.9]),
    item('mid-b', '2021-08-10', [-93.595, 44.7, -93.5, 44.9]),           // two tiles together cover it
    item('mid-far', '2021-08-10', [-92.0, 44.7, -91.9, 44.9]),            // same flight, nowhere near
  ];
  assert.deepEqual(pickAcquisition(features, bbox), { date: '2021-08-10', gsdM: 0.3, itemIds: ['mid-a', 'mid-b'] });
  // nothing covers it: no pin
  assert.equal(pickAcquisition([features[1]], bbox), null);
  // one date flown at two resolutions can't be pinned as one acquisition
  const mixed = [item('a', '2022-06-01', [-93.7, 44.7, -93.59, 44.9], 0.3), item('b', '2022-06-01', [-93.595, 44.7, -93.5, 44.9], 0.6)];
  assert.equal(pickAcquisition(mixed, bbox), null);
});

test('auto manifests are valid build manifests, 1 m by default and coarse on request', () => {
  const course = { name: 'Auto Links', version: 4, source: { courseId: 'osm:way:77' } };
  const pinned = (m) => ({ ...m, imagery: { collection: 'naip', date: '2023-07-31', gsdM: 0.3, itemIds: ['x'] } });
  const m = autoManifestTemplate(course, 7);
  assert.doesNotThrow(() => parseManifest(pinned(m)));
  assert.equal(m.course.courseId, 'osm:way:77');
  assert.equal(m.course.fingerprint, 'pending');
  assert.equal(m.discovered.state, 'pending');
  assert.deepEqual(m.terrain, AUTO_TERRAIN);
  assert.deepEqual(autoManifestTemplate(course, 7, { terrain: COARSE_TERRAIN }).terrain, COARSE_TERRAIN);
});
