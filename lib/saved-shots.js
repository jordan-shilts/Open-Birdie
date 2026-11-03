'use strict';
// Saved shots: the player's favourites. Each keeps what it takes to show the shot again
// and replay its flight on the course it was hit on — the launch, the result, where it
// was hit from and aimed, and the trajectory — in DATA_DIR/saved-shots.json, newest
// MAX_SAVED kept, written whole (temp file + rename) like the bag.
//
//   saved.list()             -> summaries, newest first (no trajectory)
//   saved.get(id)            -> one saved shot with its trajectory, or null
//   saved.add(shot, context) -> its summary (the same live shot saved twice: the first)
//   saved.remove(id)         -> true when it was there
//
// `shot` is a shot result as the server broadcasts it (lib/game.js, lib/practice.js);
// `context` is where it was hit: { shotId, at, course, hole, holeRef, practice, club,
// pin, tee, aimDeg }.

const fs = require('fs');
const path = require('path');

const MAX_SAVED = 200;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const r = (v, d) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const pair = (p) => (Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1]) ? [r(p[0], 2), r(p[1], 2)] : null);
const point = (p) => (p && finite(p.x) && finite(p.y) ? { x: r(p.x, 2), y: r(p.y, 2) } : null);
const text = (v, max = 80) => (v === null || v === undefined ? null : String(v).slice(0, max));

// The trajectory as [t, x, y, z] rows: centimetres and milliseconds are plenty to
// replay it, and a drive is ~500 samples (~12 KB) instead of ~30 KB of objects.
function packPoints(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const p of points) {
    if (p && finite(p.t) && finite(p.x) && finite(p.y) && finite(p.z)) out.push([r(p.t, 3), r(p.x, 2), r(p.y, 2), r(p.z, 2)]);
  }
  return out;
}

// A saved record from a live shot result and where it was hit, or null when the shot
// has no flight to keep.
function recordFrom(shot, context = {}, now = Date.now()) {
  const sim = shot && shot.sim;
  const launch = shot && shot.launch;
  if (!sim || !launch || !finite(launch.speedMph)) return null;
  const points = packPoints(sim.points);
  if (points.length < 2) return null;
  return {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    shotId: context.shotId ?? null,
    at: finite(context.at) ? context.at : now,
    savedAt: now,
    course: text(context.course, 160),
    hole: Number.isInteger(context.hole) ? context.hole : null,
    holeRef: context.holeRef ?? null,
    practice: text(context.practice, 20),
    club: text(context.club ?? shot.clubKey ?? shot.club, 20),
    launch: {
      speedMph: r(launch.speedMph, 1), vla: r(launch.vla, 1), hla: r(launch.hla, 1),
      totalSpin: r(launch.totalSpin, 0), spinAxis: r(launch.spinAxis, 1),
    },
    result: {
      carryYd: r(sim.carryYd, 1), totalYd: r(sim.totalYd, 1), offlineYd: r(sim.offlineYd, 1),
      apexFt: r(sim.apexFt, 0), flightTime: r(sim.flightTime, 2), isPutt: Boolean(sim.isPutt),
      lie: text(shot.lie, 20), holed: Boolean(shot.holed), penalty: finite(shot.penalty) ? shot.penalty : 0,
      note: text(shot.note, 120), strokes: finite(shot.strokes) ? shot.strokes : null,
    },
    replay: {
      pin: pair(context.pin), tee: pair(context.tee), from: point(shot.from),
      aimDeg: r(context.aimDeg, 2),
    },
    points,
  };
}

function summary(rec) {
  const { points, ...rest } = rec;
  return rest;
}

function createSavedShots({ dataDir, file = path.join(dataDir, 'saved-shots.json'), max = MAX_SAVED, log = console } = {}) {
  let shots = null;   // newest last
  const read = () => {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`[saved] cannot read ${path.basename(file)}: ${err.message}`);
      return [];
    }
    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.shots)) throw new Error('no shots list');
      return data.shots.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.points));
    } catch (err) {
      log.warn(`[saved] ignoring ${path.basename(file)}: ${err.message}`);
      try { fs.renameSync(file, `${file}.corrupt`); } catch (_) { /* leave it */ }
      return [];
    }
  };
  const all = () => { if (!shots) shots = read(); return shots; };
  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, shots }));
    fs.renameSync(tmp, file);
  };
  return {
    file,
    get count() { return all().length; },
    list() { return all().map(summary).reverse(); },
    get(id) { return all().find((s) => s.id === id) || null; },
    add(shot, context = {}, now = Date.now()) {
      const list = all();
      if (context.shotId != null) {
        const same = list.find((s) => s.shotId === context.shotId && s.at === context.at);
        if (same) return summary(same);
      }
      const rec = recordFrom(shot, context, now);
      if (!rec) return null;
      list.push(rec);
      if (list.length > max) list.splice(0, list.length - max);
      write();
      return summary(rec);
    },
    remove(id) {
      const list = all();
      const i = list.findIndex((s) => s.id === id);
      if (i < 0) return false;
      list.splice(i, 1);
      write();
      return true;
    },
  };
}

module.exports = { createSavedShots, recordFrom, packPoints, MAX_SAVED };
