import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BANDS, ROLES, validateSuite } from '../tools/visual-capture/config.mjs';
import {
  DEFAULT_PHOTOS,
  EYE_M,
  buildPhotoSuite,
  findCourseCache,
  parseOsmRef,
  photoPose,
  projectToLocal,
} from '../tools/visual-capture/photo-suite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const photos = JSON.parse(fs.readFileSync(DEFAULT_PHOTOS, 'utf8'));
const featured = JSON.parse(fs.readFileSync(path.join(ROOT, 'courses', 'featured.json'), 'utf8')).courses;

// GolfScene._freeTargets / _freeStep, so a pose can be checked against what the scene does with it
function cameraFromPose(pose, groundAt) {
  const yaw = (pose.yaw * Math.PI) / 180;
  const pitch = (pose.pitch * Math.PI) / 180;
  const h = groundAt(pose.tx, pose.ty) + 2 + pose.hOff;
  const horiz = Math.cos(pitch) * pose.dist;
  return {
    x: pose.tx - Math.sin(yaw) * horiz,
    y: pose.ty - Math.cos(yaw) * horiz,
    z: h - Math.sin(pitch) * pose.dist,
  };
}

test('photo list: ids, roles, bands, licences and positions are usable', () => {
  assert.equal(photos.schemaVersion, 1);
  const ids = new Set();
  const licences = new Set(['CC BY-SA 2.0', 'CC BY-SA 3.0', 'CC BY-SA 4.0', 'CC BY 2.5', 'Public domain']);
  for (const course of photos.courses) {
    const entry = featured.find((f) => f.osm === course.osm);
    assert.ok(entry, `${course.slug}: ${course.osm} is a featured course`);
    assert.equal(course.name, entry.name, `${course.slug}: name matches courses/featured.json`);
    const [south, north, west, east] = entry.bbox;
    const padLat = 300 / 111133;
    const padLon = 300 / (111319 * Math.cos((south * Math.PI) / 180));
    for (const photo of course.photos) {
      assert.match(photo.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
      assert.ok(!ids.has(photo.id), `duplicate photo id ${photo.id}`);
      ids.add(photo.id);
      assert.ok(photo.file && !photo.file.startsWith('File:'), `${photo.id}: bare Commons file name`);
      assert.ok(licences.has(photo.license), `${photo.id}: free licence (${photo.license})`);
      assert.ok(ROLES.includes(photo.role), `${photo.id}: role ${photo.role}`);
      assert.ok(BANDS.includes(photo.band), `${photo.id}: band ${photo.band}`);
      assert.ok(photo.subject.length > 10);
      assert.equal(!photo.camera, !photo.heading, `${photo.id}: camera and heading come together`);
      if (!photo.camera) continue;
      const { lat, lon, source, accuracyM } = photo.camera;
      assert.ok(lat > south - padLat && lat < north + padLat && lon > west - padLon && lon < east + padLon,
        `${photo.id}: camera within 300 m of the course`);
      assert.ok(['photographer', 'geograph', 'derived'].includes(source), `${photo.id}: camera source`);
      assert.ok(accuracyM > 0 && accuracyM <= 100);
      assert.ok(photo.heading.deg >= 0 && photo.heading.deg < 360);
      assert.ok(['photographer', 'geograph', 'description', 'derived', 'estimated'].includes(photo.heading.source));
    }
  }
  assert.ok(ids.size >= 40, 'every featured course has photos');
});

test('projection matches the course loader (equirectangular about the origin)', () => {
  const origin = { lat: 47.2, lon: -122.57 };
  assert.deepEqual(projectToLocal(origin, 47.2, -122.57), { x: 0, y: 0 });
  const p = projectToLocal(origin, 47.201, -122.569);
  assert.ok(Math.abs(p.y - 111.13295) < 1e-6);
  assert.ok(Math.abs(p.x - 111.31949 * Math.cos((47.2 * Math.PI) / 180)) < 1e-6);
});

test('a photo pose puts the free camera where the photographer stood, looking the same way', () => {
  const ground = (x, y) => 0.05 * x - 0.02 * y + 10;   // a tilted plane
  for (const heading of [0, 95, 200, 337]) {
    for (const pitchDeg of [-4, -5, -10]) {
      const pose = photoPose({ x: 120, y: -40 }, heading, ground, { pitchDeg });
      const cam = cameraFromPose(pose, ground);
      assert.ok(Math.abs(cam.x - 120) < 0.02 && Math.abs(cam.y + 40) < 0.02, `camera xy for ${heading}/${pitchDeg}`);
      assert.ok(Math.abs(cam.z - (ground(120, -40) + EYE_M)) < 0.02, `eye height for ${heading}/${pitchDeg}`);
      const bearing = (Math.atan2(pose.tx - cam.x, pose.ty - cam.y) * 180) / Math.PI;
      assert.ok(Math.abs(((bearing - heading + 540) % 360) - 180) < 0.1, `looks along ${heading}`);
      assert.ok(pose.pitch <= -4 && pose.dist >= 4, 'inside the capture schema');
    }
  }
});

function writeCourse(dir, file, course) {
  fs.mkdirSync(path.join(dir, 'courses'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'courses', file), JSON.stringify(course));
}

function fakeCourse(name, source, origin) {
  return {
    version: 1,
    name,
    source,
    origin,
    holes: [{ ref: 1, tee: [0, 0], pin: [0, 300] }],
    elevation: { minX: -2000, minY: -2000, cellM: 1000, nx: 5, ny: 5, heights: Array.from({ length: 25 }, (_, i) => 20 + i) },
  };
}

test('the suite is built from the cached course and passes the capture schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-suite-'));
  try {
    const hz = photos.courses.find((c) => c.slug === 'hazeltine-national');
    const source = parseOsmRef(hz.osm);
    writeCourse(dir, 'osm-relation-9892305.json', fakeCourse('Hazeltine National Golf Club', source, { lat: 44.8308, lon: -93.5838 }));

    const { suite, notes } = buildPhotoSuite(photos, dir);
    validateSuite(suite);
    assert.equal(suite.courses.length, 1);
    const [course] = suite.courses;
    assert.equal(course.cacheFile, 'osm-relation-9892305.json');
    assert.equal(course.expectedName, 'Hazeltine National Golf Club');
    const placed = hz.photos.filter((p) => p.camera);
    assert.deepEqual(course.frames.map((f) => f.id), placed.map((p) => p.id));
    assert.ok(course.frames.every((f) => f.mode === 'free' && f.judges.every((j) => j.length <= 160)));
    assert.ok(notes.some((n) => n.startsWith('hazeltine-national/hz-16-bridge: skipped')), 'unplaced photos are reported');
    assert.ok(notes.some((n) => n.startsWith('pebble-beach: no cached course')), 'missing caches are reported');

    // the 17th tee photo sits on the tee, about 80 m north-west of the origin
    const tee = course.frames.find((f) => f.id === 'hz-17-tee');
    const local = projectToLocal({ lat: 44.8308, lon: -93.5838 }, 44.83395, -93.58512);
    assert.ok(Math.hypot(tee.pose.tx - local.x, tee.pose.ty - local.y) < 9, 'look point is a few metres ahead of the camera');
    assert.equal(tee.pose.yaw, 199);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy name-keyed cache is found when there is no source-keyed one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-suite-'));
  try {
    writeCourse(dir, 'chambers-bay.json', { ...fakeCourse('Chambers Bay', undefined, { lat: 47.2069, lon: -122.5752 }) });
    writeCourse(dir, 'tpc-sawgrass.json', fakeCourse('TPC Sawgrass', parseOsmRef('relation/1783123'), { lat: 30.197, lon: -81.393 }));
    assert.equal(findCourseCache(dir, 'way/26787026', 'Chambers Bay').file, 'chambers-bay.json');
    assert.equal(findCourseCache(dir, 'relation/1783123', 'something else').file, 'tpc-sawgrass.json');
    assert.equal(findCourseCache(dir, 'way/205111637', 'Whistling Straits'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
