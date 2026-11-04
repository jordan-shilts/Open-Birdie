'use strict';
// Researched scorecards for the courses a round plays: par, handicap, yardage per tee,
// hole names and short notes (docs/research/course-data, compiled into
// lib/generated/course-reference.json by tools/build-course-reference.mjs).
//
// They are laid over the GAMEPLAY clone of a course only. Hole par and lengthYd are part
// of the course fingerprint HD bundles are matched by, so cached and packaged courses
// never change. And they are only laid over a course whose holes really are the
// researched ones: most pars agree and most lengths are near a researched tee.

const { normalizeCourseSource } = require('./course-identity');
const DATA = require('./generated/course-reference.json');

const LENGTH_TOLERANCE = 0.15; // a hole's mapped length within 15% of a researched tee
const AGREEMENT = 0.75;        // share of holes whose par, and whose length, must agree
const MIN_HOLES = 9;           // holes in common with the scorecard (a nine, or all if fewer)
const NEAR_M = 2000;           // a course without a known OSM id: research this close
const SHOWN_TEES = 4;          // scorecard rows: the play tee and the next longest

const isRegularTee = (t) => !t.event && !t.combo;

function courseIdOf(source) {
  if (!source) return null;
  try { return normalizeCourseSource(source).courseId; } catch (_) { return null; }
}

function referenceById(courseId, courses = DATA.courses) {
  return (courseId && courses.find((c) => c.courseId === courseId)) || null;
}

function referenceNear(origin, courses = DATA.courses) {
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lon)) return null;
  let best = null, bestM = NEAR_M;
  for (const c of courses) {
    const m = Math.hypot((c.lat - origin.lat) * 111133, (c.lon - origin.lon) * 111320 * Math.cos((origin.lat * Math.PI) / 180));
    if (m <= bestM) { bestM = m; best = c; }
  }
  return best;
}

// The research for a course: by its OSM id, else by location (the same course mapped as
// another feature). The correspondence check below is what rejects a neighbour.
function findReference(course, { courses = DATA.courses } = {}) {
  const byId = referenceById(courseIdOf(course && course.source), courses);
  if (byId) return { reference: byId, matchedBy: 'osm' };
  const near = referenceNear(course && course.origin, courses);
  return near ? { reference: near, matchedBy: 'location' } : null;
}

// How far (as a fraction) a mapped length is from the nearest researched tee's yardage.
function teeDeviation(lengthYd, yards) {
  let best = Infinity;
  for (const yd of Object.values(yards || {})) {
    if (yd > 0) best = Math.min(best, Math.abs(lengthYd - yd) / yd);
  }
  return best;
}

// Could a mapped hole (raw OSM par, or null when untagged) be this researched hole?
function fitsHole({ par, lengthYd }, want) {
  return teeDeviation(lengthYd, want.yards) <= LENGTH_TOLERANCE && (par == null || par === want.par);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The tee the mapped hole lengths are closest to (median relative difference), among the
// regular tees when there are any: what the HUD and scorecard show first.
function pickPlayTee(pairs, tees) {
  const pool = tees.some(isRegularTee) ? tees.filter(isRegularTee) : tees;
  let best = null, bestDev = Infinity;
  for (const tee of pool) {
    const devs = [];
    for (const { hole, want } of pairs) {
      const yd = want.yards[tee.name];
      if (yd > 0) devs.push(Math.abs(hole.lengthYd - yd) / yd);
    }
    if (devs.length < pairs.length / 2) continue;
    const dev = median(devs);
    if (dev < bestDev - 1e-9 || (Math.abs(dev - bestDev) <= 1e-9 && (tee.total || 0) > (best.total || 0))) {
      best = tee; bestDev = dev;
    }
  }
  return best;
}

// Do the course's holes correspond to the research? Holes pair up by number (OSM ref).
function correspondence(course, reference) {
  const byNumber = new Map(reference.holes.map((h) => [h.number, h]));
  const pairs = [];
  (course.holes || []).forEach((hole, index) => {
    const want = byNumber.get(hole.ref);
    if (want) pairs.push({ hole, want, index });
  });
  if (pairs.length < Math.min(MIN_HOLES, reference.holes.length)) {
    return { ok: false, few: true, reason: `only ${pairs.length} hole numbers in common with the scorecard`, pairs, matched: pairs.length };
  }
  const parMisses = pairs.filter(({ hole, want }) => hole.par !== want.par);
  const lengthMisses = pairs.filter(({ hole, want }) => teeDeviation(hole.lengthYd, want.yards) > LENGTH_TOLERANCE);
  const parAgree = 1 - parMisses.length / pairs.length;
  const lengthAgree = 1 - lengthMisses.length / pairs.length;
  const playTee = pickPlayTee(pairs, reference.tees || []);
  const result = { pairs, matched: pairs.length, parAgree, lengthAgree, playTee };
  const example = (p) => `hole ${p.hole.ref}: mapped par ${p.hole.par}, ${p.hole.lengthYd} yd vs scorecard par ${p.want.par}` +
    `${playTee && p.want.yards[playTee.name] ? `, ${p.want.yards[playTee.name]} yd` : ''}`;
  if (parAgree < AGREEMENT) {
    return { ...result, ok: false, reason: `${parMisses.length} of ${pairs.length} pars disagree (${example(parMisses[0])})` };
  }
  if (lengthAgree < AGREEMENT) {
    return { ...result, ok: false, reason: `${lengthMisses.length} of ${pairs.length} lengths are more than 15% off every tee (${example(lengthMisses[0])})` };
  }
  return { ...result, ok: true, reason: null };
}

// The tees the scorecard lists: the play tee, then the longest other regular tees.
function shownTees(reference, playTee) {
  const tees = reference.tees || [];
  const rest = tees.filter((t) => t !== playTee && isRegularTee(t)).sort((a, b) => (b.total || 0) - (a.total || 0));
  return [playTee, ...rest].filter(Boolean).slice(0, SHOWN_TEES);
}

// Lay the research over a course a round plays (mutates it: pass the gameplay clone).
// Returns { applied, reason, revision }; revision feeds the package's content revision.
function applyCourseReference(course, { courses = DATA.courses, log = console } = {}) {
  const found = findReference(course, { courses });
  if (!found) return { applied: false, reason: 'no researched scorecard', revision: null };
  const { reference, matchedBy } = found;
  const label = `[course] scorecard ${reference.name}`;
  const check = correspondence(course, reference);
  if (!check.ok) {
    // a course with a handful of holes isn't this one; one whose holes disagree is worth a line
    if (!check.few) log.warn(`${label}: skipped for ${course.name}: ${check.reason}`);
    return { applied: false, reason: check.reason, revision: null };
  }
  const playTee = check.playTee;
  for (const { hole, want } of check.pairs) {
    hole.par = want.par;
    if (want.handicap != null) hole.handicap = want.handicap;
    if (want.name) hole.name = want.name;
    hole.yards = { ...want.yards };
    hole.scorecardYd = playTee ? want.yards[playTee.name] ?? null : null;
    if (want.note) hole.note = want.note;
    if (want.green) hole.greenNote = want.green;
  }
  course.reference = {
    slug: reference.slug,
    name: reference.name,
    matchedBy,
    playTee: playTee ? playTee.name : null,
    tees: shownTees(reference, playTee).map(({ name, total, par, rating, slope }) => ({ name, total, par, rating, slope })),
    dataAsOf: reference.dataAsOf,
  };
  log.log(`${label}: applied to ${course.name} (${check.matched}/${course.holes.length} holes, ` +
    `${playTee ? `${playTee.name} tees` : 'no tee match'}, matched by ${matchedBy === 'osm' ? 'OSM id' : 'location'})`);
  return {
    applied: true,
    reason: null,
    revision: { version: DATA.version, slug: reference.slug, playTee: course.reference.playTee },
  };
}

// For round selection while a course is parsed: the researched holes by number, but
// only for an exact OSM id match (a guess by location must never change which holes
// a course is built with).
function selectionReference(source, { courses = DATA.courses } = {}) {
  const reference = referenceById(courseIdOf(source), courses);
  return reference ? new Map(reference.holes.map((h) => [h.number, h])) : null;
}

module.exports = {
  AGREEMENT,
  LENGTH_TOLERANCE,
  applyCourseReference,
  correspondence,
  findReference,
  fitsHole,
  selectionReference,
  teeDeviation,
};
