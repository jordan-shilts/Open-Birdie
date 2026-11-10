#!/usr/bin/env node
// Turn the located course photos (docs/research/course-photos/photos.json) into a
// visual-capture suite whose free-camera poses stand where each photographer stood and
// look the way they looked, so a capture can be laid beside the real photo.
//
//   node tools/visual-capture/photo-suite.mjs --data-dir data --out /tmp/photo-match.json
//   npm run visual:capture -- --suite /tmp/photo-match.json --data-dir data
//
//   --data-dir DIR   where the cached courses are (BIRDIE_DATA_DIR, default data/)
//   --photos FILE    the photo list (default docs/research/course-photos/photos.json)
//   --course SLUG    only this course (repeatable)
//   --out FILE       write the suite here (default: print it)
//
// Local coordinates come from each cached course's own projection origin, so the suite
// belongs to the caches it was made from: make it again after a course is re-downloaded.
// Photos without a camera position or heading (aerials, unplaced shots) are skipped, as
// is a course that has no cache in the data directory; both are listed on stderr.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { makeTerrain, flatTerrain } = require('../../lib/elevation');
const { courseCacheStem, normalizeCourseSource } = require('../../lib/course-identity');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_PHOTOS = path.join(ROOT, 'docs', 'research', 'course-photos', 'photos.json');

// lib/course.js parseOsm's equirectangular projection about the course origin
const M_PER_LAT = 111132.95;
const M_PER_LON_EQ = 111319.49;

export const EYE_M = 1.7;
// A photo is taken nearly level; overviews from a rise look down a little more. The
// capture schema wants pitch <= -4.
export const PITCH_BY_ROLE = {
  'hole-overview': -5,
  landing: -5,
  'close-green': -8,
  'close-bunker': -10,
  'high-overview': -10,
  horizon: -4,
};
// The free camera orbits a look point; keeping it a few metres ahead means the look
// point's ground is the camera's ground, so the eye height survives HD terrain that
// differs a little from the base grid this tool samples.
export const LOOK_AHEAD_M = 8;

const round = (v, places = 2) => Number(v.toFixed(places));

export function projectToLocal(origin, lat, lon) {
  const mPerLon = M_PER_LON_EQ * Math.cos((origin.lat * Math.PI) / 180);
  return { x: (lon - origin.lon) * mPerLon, y: (lat - origin.lat) * M_PER_LAT };
}

// A free-camera pose ({tx, ty, dist, pitch, yaw, hOff}, see GolfScene._freeTargets) whose
// camera sits eyeM above the ground at (x, y) and looks along headingDeg (0 = north,
// 90 = east, the same sense as the free camera's yaw).
export function photoPose({ x, y }, headingDeg, groundAt, { eyeM = EYE_M, pitchDeg = -5, distM = LOOK_AHEAD_M } = {}) {
  const pitch = (pitchDeg * Math.PI) / 180;
  const yaw = (headingDeg * Math.PI) / 180;
  const horiz = Math.cos(pitch) * distM;
  const tx = x + Math.sin(yaw) * horiz;
  const ty = y + Math.cos(yaw) * horiz;
  const look = groundAt(x, y) + eyeM + Math.sin(pitch) * distM;   // _freeTargets: camera = look - sin(pitch)·dist
  return {
    tx: round(tx),
    ty: round(ty),
    dist: distM,
    pitch: pitchDeg,
    yaw: round(((headingDeg % 360) + 360) % 360, 1),
    hOff: round(look - groundAt(tx, ty) - 2),             // _freeStep: h = ground(tx, ty) + 2 + hOff
  };
}

export function parseOsmRef(ref) {
  const match = /^(way|relation|node)\/(\d+)$/.exec(String(ref || ''));
  if (!match) throw new Error(`not an OSM id like way/123: ${ref}`);
  return normalizeCourseSource({ osmType: match[1], osmId: match[2] });
}

// The cached course for an OSM id: its source-keyed file, else a legacy (name-keyed)
// cache that records the same source or the same name.
export function findCourseCache(dataDir, osmRef, name) {
  const dir = path.join(path.resolve(dataDir), 'courses');
  if (!fs.existsSync(dir)) return null;
  const source = parseOsmRef(osmRef);
  const read = (file) => {
    try {
      const course = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      return course && Array.isArray(course.holes) && course.origin ? { file, course } : null;
    } catch (_) {
      return null;
    }
  };
  const keyed = read(`${courseCacheStem(source)}.json`);
  if (keyed) return keyed;
  const wanted = String(name || '').trim().toLowerCase();
  for (const file of fs.readdirSync(dir).filter((f) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(f)).sort()) {
    if (/\.(surfaces|hd|aerial)\./.test(file)) continue;
    const hit = read(file);
    if (!hit) continue;
    const id = hit.course.source && hit.course.source.courseId;
    if (id === source.courseId) return hit;
    if (!id && wanted && String(hit.course.name || '').trim().toLowerCase() === wanted) return hit;
  }
  return null;
}

function terrainFor(course) {
  return course.elevation ? makeTerrain(course.elevation, course.elevation.patches || []) : flatTerrain();
}

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function photoFrames(coursePhotos, cachedCourse) {
  const terrain = terrainFor(cachedCourse);
  const frames = [];
  const skipped = [];
  for (const photo of coursePhotos.photos) {
    if (!photo.camera || !photo.heading) {
      skipped.push({ id: photo.id, why: 'no camera position or heading' });
      continue;
    }
    const pitchDeg = PITCH_BY_ROLE[photo.role] ?? -5;
    const pose = photoPose(projectToLocal(cachedCourse.origin, photo.camera.lat, photo.camera.lon),
      photo.heading.deg, (x, y) => terrain.h(x, y), { pitchDeg });
    frames.push({
      id: photo.id,
      role: photo.role,
      target: 'canvas',
      mode: 'free',
      band: photo.band,
      pose,
      judges: [
        clip(`match the photo: ${photo.subject}`),
        clip(`File:${photo.file} on Wikimedia Commons (${photo.license}); camera ±${photo.camera.accuracyM} m, ${photo.camera.source}`),
      ],
    });
  }
  return { frames, skipped };
}

export function buildPhotoSuite(photoList, dataDir, { courses: only = [] } = {}) {
  const courses = [];
  const notes = [];
  for (const entry of photoList.courses) {
    if (only.length && !only.includes(entry.slug)) continue;
    const cache = findCourseCache(dataDir, entry.osm, entry.name);
    if (!cache) {
      notes.push(`${entry.slug}: no cached course for ${entry.osm} in ${path.join(dataDir, 'courses')}; open it once in the app`);
      continue;
    }
    const { frames, skipped } = photoFrames(entry, cache.course);
    for (const s of skipped) notes.push(`${entry.slug}/${s.id}: skipped (${s.why})`);
    if (!frames.length) continue;
    courses.push({
      id: entry.slug,
      cacheFile: cache.file,
      expectedName: cache.course.name,
      hdPolicy: 'optional',
      frames,
    });
  }
  return {
    suite: {
      schemaVersion: 1,
      id: 'photo-match',
      capture: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        qualityProfile: 'current-default',
        readinessTimeoutMs: 120000,
        settleFrames: 3,
        fixedTimeSeconds: 12.5,
      },
      courses,
    },
    notes,
  };
}

function parseArgs(argv) {
  const out = { dataDir: process.env.BIRDIE_DATA_DIR || path.join(ROOT, 'data'), photos: DEFAULT_PHOTOS, courses: [], out: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--data-dir') { out.dataDir = value; i++; }
    else if (flag === '--photos') { out.photos = value; i++; }
    else if (flag === '--course') { out.courses.push(value); i++; }
    else if (flag === '--out') { out.out = value; i++; }
    else throw new Error(`unknown argument: ${flag}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const photoList = JSON.parse(fs.readFileSync(args.photos, 'utf8'));
  const { suite, notes } = buildPhotoSuite(photoList, args.dataDir, { courses: args.courses });
  for (const note of notes) process.stderr.write(`${note}\n`);
  if (!suite.courses.length) {
    process.stderr.write('No course in the data directory has placed photos; nothing to capture.\n');
    process.exitCode = 1;
    return;
  }
  const { validateSuite } = await import('./config.mjs');
  validateSuite(suite);
  const text = `${JSON.stringify(suite, null, 2)}\n`;
  if (args.out) fs.writeFileSync(args.out, text);
  else process.stdout.write(text);
  const frames = suite.courses.reduce((n, c) => n + c.frames.length, 0);
  process.stderr.write(`${frames} photo-matched frames on ${suite.courses.length} course(s)${args.out ? ` -> ${args.out}` : ''}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
