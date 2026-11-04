'use strict';
// The course library behind the course picker: every course this install has downloaded
// (instant to load), with what its card shows (holes, par, yardage, the layout as a
// sketch, when it was last played, whether it has HD terrain and a researched scorecard),
// and the featured courses not downloaded yet (one click fetches one). A course file is
// read once and remembered by its size and modification time, so the picker opens at once
// however many courses there are.

const fs = require('fs');
const path = require('path');
const { CACHE_DIR, isCurrentCourseCache, slug } = require('./course');
const { normalizeCourseSource } = require('./course-identity');
const { correspondence } = require('./course-reference');
const REFERENCE = require('./generated/course-reference.json');

// Offered before they are downloaded: the courses with researched scorecards, and
// Hazeltine. place: where it is, for the card.
const FEATURED = Object.freeze([
  { courseId: 'osm:relation:3741806', name: 'Pebble Beach Golf Links', place: 'Pebble Beach, California' },
  { courseId: 'osm:way:1019045811', name: 'Old Course at St Andrews', place: 'St Andrews, Scotland' },
  { courseId: 'osm:relation:1783123', name: 'TPC Sawgrass, Stadium Course', place: 'Ponte Vedra Beach, Florida' },
  { courseId: 'osm:way:26787026', name: 'Chambers Bay', place: 'University Place, Washington' },
  { courseId: 'osm:way:362513477', name: 'Bandon Dunes', place: 'Bandon, Oregon' },
  { courseId: 'osm:relation:9892305', name: 'Hazeltine National Golf Club', place: 'Chaska, Minnesota' },
]);
const SKETCH_DIGITS = 3;

const keyOf = (courseId) => String(courseId).replace(/:/g, '-');
const referenceFor = (courseId, reference = REFERENCE) => (courseId && reference.courses.find((c) => c.courseId === courseId)) || null;

// A researched scorecard's numbers: 18 holes, par, and the longest everyday tee's total.
function researchedNumbers(ref) {
  const tees = (ref.tees || []).filter((t) => !t.event && !t.combo && Number.isFinite(t.total));
  const longest = tees.reduce((a, t) => (!a || t.total > a.total ? t : a), null);
  return {
    holes: (ref.holes || []).length,
    par: (ref.holes || []).reduce((s, h) => s + (Number(h.par) || 0), 0) || null,
    yards: longest ? longest.total : null,
    tee: longest ? longest.name : null,
  };
}

// The holes as a sketch for the card: each hole's line of play (tee to green), fitted into
// a unit box with north up (x right, y down), and how wide and tall the box is used.
function sketchOf(holes) {
  const lines = holes.map((h) => (Array.isArray(h.line) && h.line.length > 1 ? h.line : [h.tee, h.pin]))
    .map((l) => l.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])))
    .filter((l) => l.length > 1);
  if (!lines.length) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const l of lines) for (const [x, y] of l) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const r = (v) => +v.toFixed(SKETCH_DIGITS);
  return {
    w: r((x1 - x0) / span), h: r((y1 - y0) / span),
    holes: lines.map((l) => l.map(([x, y]) => [r((x - x0) / span), r((y1 - y) / span)])),
  };
}

// What a downloaded course's card shows, from its file: its researched scorecard's par
// and the yardage of the tee the round will play when the research fits its holes (the
// same check the game lays it over with, lib/course-reference.js), else the mapped holes'.
function cardOf(course, file, { reference = REFERENCE } = {}) {
  let courseId = null;
  try { courseId = course.source ? normalizeCourseSource(course.source).courseId : null; } catch (_) { courseId = null; }
  const holes = course.holes || [];
  const ref = referenceFor(courseId, reference);
  const fit = ref ? correspondence(course, ref) : null;
  const numbers = fit && fit.ok
    ? { ...researchedNumbers(ref), ...(fit.playTee && Number.isFinite(fit.playTee.total) ? { yards: fit.playTee.total, tee: fit.playTee.name } : {}) }
    : {
      holes: holes.length,
      par: holes.reduce((s, h) => s + (Number(h.par) || 0), 0) || null,
      yards: Math.round(holes.reduce((s, h) => s + (Number(h.lengthYd) || 0), 0)) || null,
      tee: null,
    };
  const featured = FEATURED.find((f) => f.courseId === courseId);
  return {
    file, courseId, name: course.name,
    place: featured ? featured.place : null,
    ...numbers,
    researched: !!(fit && fit.ok),
    lat: course.origin?.lat ?? null, lon: course.origin?.lon ?? null,
    sketch: sketchOf(holes),
  };
}

function createCourseLibrary({ cacheDir = CACHE_DIR, fsImpl = fs, reference = REFERENCE, log = console } = {}) {
  const memo = new Map();   // file -> { stamp, card }
  const hdDir = path.join(path.dirname(cacheDir), 'hd-courses');

  function readCard(file) {
    const fp = path.join(cacheDir, file);
    let st;
    try { st = fsImpl.statSync(fp); } catch (_) { memo.delete(file); return null; }
    const stamp = `${st.size}:${st.mtimeMs}`;
    const hit = memo.get(file);
    if (hit && hit.stamp === stamp) return hit.card;
    let card = null;
    try {
      const course = JSON.parse(fsImpl.readFileSync(fp, 'utf8'));
      if (isCurrentCourseCache(course)) card = cardOf(course, file, { reference });
    } catch (error) {
      log.warn(`[library] skipping ${file}: ${error.message}`);
    }
    memo.set(file, { stamp, card });
    return card;
  }

  const hasHd = (card) => [card.courseId && keyOf(card.courseId), slug(card.name || '')]
    .filter(Boolean)
    .some((dir) => { try { return fsImpl.readdirSync(path.join(hdDir, dir, 'bundles')).length > 0; } catch (_) { return false; } });

  // { current, courses: downloaded, most recently played first; featured: not downloaded }
  function list({ entries = {}, currentId = null } = {}) {
    let names = [];
    try { names = fsImpl.readdirSync(cacheDir); } catch (_) { names = []; }
    const byId = new Map(), legacy = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.surfaces.json')) continue;
      const card = readCard(name);
      if (!card) continue;
      if (!card.courseId) { legacy.push(card); continue; }
      // the key-named file wins over an older copy of the same course
      const prev = byId.get(card.courseId);
      if (!prev || name === `${keyOf(card.courseId)}.json`) byId.set(card.courseId, card);
    }
    for (const name of memo.keys()) if (!names.includes(name)) memo.delete(name);
    const courses = [...byId.values(), ...legacy].map((card) => {
      const e = card.courseId ? entries[keyOf(card.courseId)] : null;
      return { ...card, lastUsed: e?.lastUsed ?? null, hd: hasHd(card), current: !!currentId && card.courseId === currentId };
    }).sort((a, b) => (b.current - a.current) || ((b.lastUsed ?? 0) - (a.lastUsed ?? 0)) || a.name.localeCompare(b.name));
    const have = new Set(courses.map((c) => c.courseId).filter(Boolean));
    const featured = FEATURED.filter((f) => !have.has(f.courseId)).map((f) => {
      const { osmType, osmId } = normalizeCourseSource({ osmType: f.courseId.split(':')[1], osmId: f.courseId.split(':')[2] });
      const ref = referenceFor(f.courseId, reference);
      return {
        courseId: f.courseId, osmType, osmId, name: f.name, place: f.place,
        ...(ref ? researchedNumbers(ref) : { holes: null, par: null, yards: null, tee: null }),
        researched: !!ref, lat: ref?.lat ?? null, lon: ref?.lon ?? null,
      };
    });
    return { current: currentId, courses, featured };
  }

  return { list };
}

module.exports = { FEATURED, createCourseLibrary, cardOf, sketchOf };
