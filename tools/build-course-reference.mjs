// Compile the researched course data (docs/research/course-data/courses/*.json) into the
// compact file the game reads at runtime, lib/generated/course-reference.json: per course
// its OpenStreetMap id, tees and, per hole, par, handicap, name, yardage per tee and a
// short note. The runtime never reads docs/, which isn't packaged.
//
//   npm run build:course-reference            rewrite lib/generated/course-reference.json
//   npm run build:course-reference -- --check exit 1 if it is out of date
//
// A research file names a course and its location, and may name its OSM id ("osm":
// "way/871993734"); without one it gets the id of the courses/featured.json entry
// nearest its location (within NEAR_KM of that entry's bbox).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEARCH_DIR = path.join(ROOT, 'docs', 'research', 'course-data', 'courses');
const FEATURED = path.join(ROOT, 'courses', 'featured.json');
const OUT = path.join(ROOT, 'lib', 'generated', 'course-reference.json');

export const REFERENCE_VERSION = 1;
const NEAR_KM = 1.5;
const NOTE_MAX = 180;
const GREEN_MAX = 160;

// Tournament setups ("U.S. Open 2019") and blended tees ("Gold/White", "B&W Blended")
// are real scorecard rows, but not the tees a round is matched to or shown with first.
const isEventTee = (name) => /\b(19|20)\d{2}\b/.test(name);
const isComboTee = (name) => /\/|&|blended/i.test(name);

// "Tiny green ringed by six bunkers (S8); an infinity green (Kidd, S10)." -> without the
// source ids: "(S8)" goes, "(Kidd, S10)" becomes "(Kidd)".
const SOURCE_ID = 'S\\d+[a-z]?';
function clean(text) {
  if (!text) return null;
  const out = String(text)
    .replace(/\s*\(([^()]*)\)/g, (whole, inner) => {
      const rest = inner
        .replace(new RegExp(`,?\\s*\\b(?:confirmed by|according to|per|see)\\s+${SOURCE_ID}\\b`, 'g'), '')
        .replace(new RegExp(`(^|[;,/]\\s*)${SOURCE_ID}(?=\\s*([;,/]|$))`, 'g'), '$1')
        .replace(/^[\s;,/]+|[\s;,/]+$/g, '')
        .replace(/\s*([;,/])(\s*[;,/])+/g, '$1');
      return rest ? ` (${rest})` : '';
    })
    .replace(new RegExp(`\\s+per ${SOURCE_ID}\\b`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
  return out || null;
}

// Sentence ends: . ! or ? after a lowercase letter, digit or closing bracket/quote, so
// "U.S. Open" and "Dr. Kidd" don't split.
const sentences = (t) => t.split(/(?<=[a-z0-9)\]'"’][.!?])\s+(?=[A-Z0-9'"‘(])/);
// Scorecard trivia the HUD already shows, or that is about other tees.
const isTrivia = (s) => /^women'?s\b/i.test(s) || /\b(handicaps?|yardages?|scorecards?|card)\b/i.test(s);

// The first sentences that fit in max characters (cut at a word if one sentence is longer).
function brief(text, max, { dropTrivia = false } = {}) {
  const all = clean(text);
  if (!all) return null;
  const kept = sentences(all).filter((s) => !(dropTrivia && isTrivia(s)));
  if (!kept.length) return null;
  let out = '';
  for (const s of kept) {
    if (`${out} ${s}`.trim().length > max) break;
    out = `${out} ${s}`.trim();
  }
  if (out) return out;
  const cut = kept[0].slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length)}…`;
}

function greenNote(green) {
  if (!green) return null;
  const parts = [green.features, green.slope].map(clean).filter(Boolean);
  if (!parts.length && green.size_sqft) parts.push(`About ${green.size_sqft.toLocaleString('en-US')} sq ft.`);
  if (!parts.length) return null;
  return brief(parts.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(' '), GREEN_MAX);
}

// Distance in km from a point to a featured course's bbox ([south, north, west, east]); 0 inside.
function kmToBbox(lat, lon, [south, north, west, east]) {
  const dLat = lat < south ? south - lat : lat > north ? lat - north : 0;
  const dLon = lon < west ? west - lon : lon > east ? lon - east : 0;
  return Math.hypot(dLat * 111.133, dLon * 111.32 * Math.cos((lat * Math.PI) / 180));
}

function featuredFor(location, featured) {
  let best = null;
  for (const entry of featured) {
    const km = kmToBbox(location.lat, location.lon, entry.bbox);
    if (km <= NEAR_KM && (!best || km < best.km)) best = { entry, km };
  }
  return best && best.entry;
}

function compileTees(tees) {
  // A tee is listed once per sex rating; keep one row per name, the men's rating first.
  const byName = new Map();
  for (const t of tees || []) {
    if (!t || !t.name) continue;
    const prev = byName.get(t.name);
    if (prev && !(prev.sex !== 'M' && t.sex === 'M')) continue;
    byName.set(t.name, t);
  }
  return [...byName.values()].map((t) => ({
    name: t.name,
    total: t.total_yards ?? null,
    par: t.par ?? null,
    rating: t.rating ?? null,
    slope: t.slope ?? null,
    ...(isEventTee(t.name) ? { event: true } : {}),
    ...(isComboTee(t.name) ? { combo: true } : {}),
  }));
}

function compileHole(h) {
  const yards = {};
  for (const [tee, yd] of Object.entries(h.yards || {})) if (Number.isFinite(yd)) yards[tee] = yd;
  return {
    number: h.number,
    name: clean(h.name),
    par: h.par ?? null,
    handicap: h.handicap ?? null,
    yards,
    note: brief(h.notes, NOTE_MAX, { dropTrivia: true }),
    green: greenNote(h.green),
    elevationFt: h.elevation?.change_ft ?? null,
  };
}

export function compileCourse(research, featured) {
  const { lat, lon } = research.location || {};
  // the file's own OSM id ("osm": "way/871993734") when it names one, else the nearest
  // courses/featured.json entry's (a course needn't be on the cloud's build list)
  const own = /^(way|relation)\/\d+$/.test(research.osm || '') ? { osm: research.osm, name: research.course } : null;
  const entry = own || (Number.isFinite(lat) && Number.isFinite(lon) ? featuredFor({ lat, lon }, featured) : null);
  const [osmType, osmId] = entry ? entry.osm.split('/') : [];
  // a course mapped only as its holes, inside another course's outline ("within":
  // Augusta's Par 3 Course in Augusta National's): it plays in that outline
  const within = own && /^(way|relation)\/\d+$/.test(research.within || '') ? research.within.split('/') : null;
  return {
    slug: research.slug,
    name: research.course,
    ...(entry ? { courseId: `osm:${osmType}:${osmId}`, osmName: entry.name } : {}),
    ...(within ? { withinId: `osm:${within[0]}:${within[1]}` } : {}),
    lat,
    lon,
    dataAsOf: clean(research.data_as_of),
    tees: compileTees(research.tees),
    greens: research.greens ? { grass: clean(research.greens.grass), stimp: clean(research.greens.typical_stimp) } : null,
    holes: [...(research.holes || [])].sort((a, b) => a.number - b.number).map(compileHole),
  };
}

export function buildCourseReference({ researchDir = RESEARCH_DIR, featuredFile = FEATURED } = {}) {
  const featured = JSON.parse(fs.readFileSync(featuredFile, 'utf8')).courses;
  const courses = fs.readdirSync(researchDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => compileCourse(JSON.parse(fs.readFileSync(path.join(researchDir, f), 'utf8')), featured));
  return {
    version: REFERENCE_VERSION,
    about: 'Generated by tools/build-course-reference.mjs from docs/research/course-data/courses/*.json. Do not edit; rebuild with npm run build:course-reference.',
    courses,
  };
}

export const serialize = (data) => `${JSON.stringify(data, null, 1)}\n`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = serialize(buildCourseReference());
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== text) {
      console.error(`${path.relative(ROOT, OUT)} is out of date: run npm run build:course-reference`);
      process.exit(1);
    }
    console.log(`${path.relative(ROOT, OUT)} is up to date`);
  } else {
    fs.writeFileSync(OUT, text);
    for (const c of JSON.parse(text).courses) {
      console.log(`${c.slug}: ${c.courseId || 'no featured OSM id (location only)'} · ${c.holes.length} holes · tees ${c.tees.map((t) => t.name).join(', ')}`);
    }
    console.log(`wrote ${path.relative(ROOT, OUT)} (${Buffer.byteLength(text)} bytes)`);
  }
}
