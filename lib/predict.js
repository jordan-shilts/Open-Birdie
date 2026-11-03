'use strict';
// Shot prediction for the lineup: what a club does from where the ball lies, on this
// hole, in today's conditions. Every prediction runs the same lib/physics.js
// simulateShot path as a real shot (terrain, surfaces, trees, the cup, wind, air,
// firmness, green speed) with the player's launch for the club (lib/bag.js) and the
// STEADY wind (a real shot also meets a gust).
//
//   predictShot(game, { club, aimOffset, bag })   one club, in full (GET /api/predict)
//   predictCarries(game, { bag })                 every full club, centre launch only,
//                                                 and the club for the pin (GET /api/carries)
//
// The bag defaults to game.bag (server.js attaches the player's); without one every
// club is the typical CLUB_FULL preset.

const { simulateShot, groundModel, YD, MPH } = require('./physics');
const { clubKey } = require('./game');
const { DEFAULTS, isStandard, normalizeConditions, physicsOptions } = require('./conditions');
const { FULL_CLUBS, modelFor } = require('./bag');
const { makeSurfaceLookup } = require('./course');
const { safeSpot } = require('./safe-spot');

const FT = 3.28084;
const G = 9.81;
const ROLL_INERTIA = 5 / 7;
const MAX_PATH_POINTS = 120;
const OUTLINE_POINTS = 16;
const SIGMA = 2;                 // dispersion outlines are ~2-sigma ellipses
const AIM_LIMIT_DEG = 45;        // Game.setAimOffset's range
const AIM_TOL_M = 0.09;          // aim assist: landing within ~0.1 yd of the line
const CARRY_PREFERRED_YD = 120;  // shorter than this, the club is chosen by carry
const PUTT_PAST_M = 0.4;         // a putt read for pace: ~16 in past the hole

class PredictError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 || 0 : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 || 0 : null);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 || 0 : null);
const xy = (p) => ({ x: r2(p.x), y: r2(p.y) });
const xyz = (p) => ({ x: r2(p.x), y: r2(p.y), z: r2(p.z) });

// ---------- an exact, faster surface lookup for prediction batches ----------
// The course lookup (lib/course.js makeSurfaceLookup) tests the point against every
// surface polygon: ~20 us a call on a real course, and the roll phase asks every
// 2 ms of ball time, so one long putt costs tens of milliseconds. Here the course is
// gridded: a cell that no polygon edge comes near holds a single surface throughout,
// so the real lookup answers once for the cell and the answer is reused. A 4 m cell
// that an edge does cross is split, when first played, into 0.5 m sub-cells treated
// the same way; only sub-cells an edge passes through ask the real lookup each time.
// Out of bounds is a distance from the boundary (lib/course.js: 15 m outside it), so
// outside the boundary everything within BOUNDARY_BAND_M of it always asks the real
// lookup. Same answers, point for point (test/predict.test.js checks it against the
// real lookup).
const CELL_M = 4;
const SUB = 8;                   // sub-cells per cell side: 0.5 m
const EDGE_MARGIN_M = 0.05;
const BOUNDARY_BAND_M = 60;      // well beyond the out-of-bounds buffer
const MAX_CELLS = 4e6;
const fastLookups = new WeakMap();

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const validRing = (ring) => Array.isArray(ring) && ring.length >= 3 &&
  ring.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));

const UNKNOWN = 0, MIXED = -1, BAND = -2;   // cell states; k > 0: values[k - 1]

function cellSurfaceLookup(course, real, { cellM = CELL_M, bandM = BOUNDARY_BAND_M, marginM = EDGE_MARGIN_M } = {}) {
  const rings = (course.surfaces || []).map((s) => s && s.poly).filter(validRing);
  const boundary = validRing(course.boundary) ? course.boundary : null;
  if (!rings.length && !boundary) return real;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of boundary ? [...rings, boundary] : rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const pad = bandM + 2 * cellM;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const nx = Math.ceil((maxX - minX) / cellM), ny = Math.ceil((maxY - minY) / cellM);
  if (!(nx > 0 && ny > 0) || nx * ny > MAX_CELLS) return real;
  const state = new Int16Array(nx * ny);
  const halfDiag = cellM * Math.SQRT1_2;

  // every edge (surface polygons and the boundary), and per crossed cell the edges near it
  const segs = [];
  const cellSegs = new Map();
  const near = (ax, ay, bx, by, reach, visit) => {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - minX) / cellM));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + reach - minX) / cellM));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - minY) / cellM));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + reach - minY) / cellM));
    for (let j = j0; j <= j1; j++) {
      const cy = minY + (j + 0.5) * cellM;
      for (let i = i0; i <= i1; i++) {
        if (segDist(minX + (i + 0.5) * cellM, cy, ax, ay, bx, by) <= reach) visit(j * nx + i);
      }
    }
  };
  const addRing = (ring) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const s = segs.push([ring[j][0], ring[j][1], ring[i][0], ring[i][1]]) - 1;
      near(ring[j][0], ring[j][1], ring[i][0], ring[i][1], halfDiag + marginM, (k) => {
        if (state[k] !== BAND) state[k] = MIXED;
        let list = cellSegs.get(k);
        if (!list) cellSegs.set(k, (list = []));
        list.push(s);
      });
    }
  };
  for (const ring of rings) addRing(ring);
  if (boundary) {
    const firstBoundarySeg = segs.length;
    addRing(boundary);
    const nearBoundary = (k) => (cellSegs.get(k) || []).some((s) => s >= firstBoundarySeg);
    // inside / outside the boundary by cell centre (even-odd scanlines); only cells
    // outside it can be out of bounds, so only they get the band
    const inside = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const y = minY + (j + 0.5) * cellM;
      const xs = [];
      for (let a = 0, b = boundary.length - 1; a < boundary.length; b = a++) {
        const [xa, ya] = boundary[a], [xb, yb] = boundary[b];
        if ((ya > y) !== (yb > y)) xs.push(xa + (y - ya) * (xb - xa) / (yb - ya));
      }
      xs.sort((p, q) => p - q);
      for (let t = 0; t + 1 < xs.length; t += 2) {
        const i0 = Math.max(0, Math.ceil((xs[t] - minX) / cellM - 0.5));
        const i1 = Math.min(nx - 1, Math.floor((xs[t + 1] - minX) / cellM - 0.5));
        for (let i = i0; i <= i1; i++) inside[j * nx + i] = 1;
      }
    }
    for (let a = 0, b = boundary.length - 1; a < boundary.length; b = a++) {
      near(boundary[b][0], boundary[b][1], boundary[a][0], boundary[a][1], halfDiag + marginM + bandM, (k) => {
        if (state[k] !== BAND && (!inside[k] || nearBoundary(k))) state[k] = BAND;
      });
    }
  }

  const values = [];
  const valueIndex = (v) => {
    let idx = values.indexOf(v);
    if (idx < 0 && values.length < 30000) idx = values.push(v) - 1;
    return idx;
  };
  const subCell = cellM / SUB;
  const subReach = subCell * Math.SQRT1_2 + marginM;
  const subs = new Map();   // crossed cell -> its sub-cell states, made when first played
  const subStates = (k) => {
    let sub = subs.get(k);
    if (sub) return sub;
    sub = new Int16Array(SUB * SUB);
    const ci = k % nx, cj = (k - ci) / nx;
    const list = cellSegs.get(k) || [];
    for (let sj = 0; sj < SUB; sj++) {
      const cy = minY + cj * cellM + (sj + 0.5) * subCell;
      for (let si = 0; si < SUB; si++) {
        const cx = minX + ci * cellM + (si + 0.5) * subCell;
        for (const s of list) {
          const [ax, ay, bx, by] = segs[s];
          if (segDist(cx, cy, ax, ay, bx, by) <= subReach) { sub[sj * SUB + si] = MIXED; break; }
        }
      }
    }
    subs.set(k, sub);
    return sub;
  };

  let outside;   // beyond the grid nothing changes: no edge comes within bandM of it
  return function cellSurfaceAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return real(x, y);
    const fx = (x - minX) / cellM, fy = (y - minY) / cellM;
    const i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || i >= nx || j < 0 || j >= ny) {
      if (outside === undefined) outside = real(x, y);
      return outside;
    }
    const k = j * nx + i;
    const s = state[k];
    if (s > 0) return values[s - 1];
    if (s === BAND) return real(x, y);
    if (s === UNKNOWN) {
      const v = real(x, y);
      const idx = valueIndex(v);
      if (idx >= 0) state[k] = idx + 1;
      return v;
    }
    // a crossed cell: by its sub-cell
    const si = Math.min(SUB - 1, Math.floor((fx - i) * SUB)), sj = Math.min(SUB - 1, Math.floor((fy - j) * SUB));
    const sub = subStates(k);
    const q = sj * SUB + si;
    const ss = sub[q];
    if (ss > 0) return values[ss - 1];
    const v = real(x, y);
    if (ss === UNKNOWN) {
      const idx = valueIndex(v);
      if (idx >= 0) sub[q] = idx + 1;
    }
    return v;
  };
}

// The game's surface lookup, made faster when it is the course's polygon lookup.
function fastSurfaceAt(game) {
  const real = game.surfaceAt;
  if (typeof real !== 'function' || !game.course) return real;
  if (!game._courseFactories || game._courseFactories.surfaceLookupFactory !== makeSurfaceLookup) return real;
  let fast = fastLookups.get(real);
  if (!fast) {
    fast = cellSurfaceLookup(game.course, real);
    fastLookups.set(real, fast);
  }
  return fast;
}

// ---------- where the shot is played from ----------
function shotContext(game, aimOffset) {
  if (!game || !game.course) throw new PredictError('NO_COURSE', 'Load a course first', 409);
  if (!game.runtimeReady) throw new PredictError('NOT_READY', 'The course is still getting ready', 409);
  const p = game.practice;
  let ball, target, offset, pin, lie = null;
  if (p) {
    // as PracticeSession.play: from the session's spot at its target, into its cup when
    // it plays to a real one (closest to the pin on a par 3, putting, chipping). The
    // range's spot plays as a tee, even where a practice green is mapped under it.
    ball = { x: p.spot[0], y: p.spot[1] };
    target = { x: p.target.x, y: p.target.y };
    offset = p.aimOffset;
    pin = p.cup;
    lie = p.lie;
  } else {
    if (game.holed || game.over) throw new PredictError('HOLE_DONE', 'The ball is in the hole', 409);
    ball = { x: game.ball.x, y: game.ball.y };
    target = { x: game.hole.pin[0], y: game.hole.pin[1] };
    offset = game.aimOffset;
    pin = { x: target.x, y: target.y };
  }
  if (aimOffset !== undefined && aimOffset !== null && aimOffset !== '') {
    const a = Number(aimOffset);
    if (!Number.isFinite(a)) throw new PredictError('BAD_AIM', 'aim must be a number of degrees');
    offset = Math.max(-AIM_LIMIT_DEG, Math.min(AIM_LIMIT_DEG, a));
  }
  const dx = target.x - ball.x, dy = target.y - ball.y;
  const lineDeg = Math.atan2(dx, dy) * 180 / Math.PI;   // as Game.aimDeg, so the same bits
  const lineRad = lineDeg * Math.PI / 180;
  const terrain = game.terrain;
  const surfaceAt = fastSurfaceAt(game);
  const z0 = terrain.h(ball.x, ball.y);
  return {
    game, ball, target, pin, offset, lineDeg,
    aimDeg: lineDeg + offset,
    // unit vectors along the ball -> pin line and to its right (compass headings)
    lineDir: { x: Math.sin(lineRad), y: Math.cos(lineRad) },
    lineRight: { x: Math.cos(lineRad), y: -Math.sin(lineRad) },
    distM: Math.hypot(dx, dy),
    terrain,
    trees: game.treeObstacles || null,
    surfaceAt,
    lie: lie || surfaceAt(ball.x, ball.y),
    z0,
    zPin: terrain.h(target.x, target.y),
    conditions: normalizeConditions(game.conditions),
  };
}

function makeRunner(ctx) {
  return (launch, { aimDeg = ctx.aimDeg, opts = {} } = {}) => simulateShot(launch, ctx.ball, aimDeg, ctx.surfaceAt, {
    terrain: ctx.terrain, pin: ctx.pin, trees: ctx.trees, ...opts,
  });
}

// Lateral offset (m, + right) of a point from the line through the ball along `right`.
const lateral = (ctx, p, right = ctx.lineRight) => (p.x - ctx.ball.x) * right.x + (p.y - ctx.ball.y) * right.y;
const along = (ctx, p) => (p.x - ctx.ball.x) * ctx.lineDir.x + (p.y - ctx.ball.y) * ctx.lineDir.y;
const rightOf = (deg) => ({ x: Math.cos(deg * Math.PI / 180), y: -Math.sin(deg * Math.PI / 180) });

// ---------- output helpers ----------
// <= max points: the first, the landing, tree hits and the last always; the rest
// spread over the flight (80 %) and the roll (20 %), or all over a putt's roll.
function decimatePath(points, flightTime, max = MAX_PATH_POINTS, events = []) {
  const round = (p) => ({ x: r2(p.x), y: r2(p.y), z: r2(p.z), t: r3(p.t) });
  if (points.length <= max) return points.map(round);
  const last = points.length - 1;
  let landing = points.findIndex((p) => p.t >= flightTime - 1e-9);
  if (landing < 0) landing = last;
  const keep = new Set([0, landing, last]);
  for (const e of events) {
    if (e.type !== 'tree' || keep.size >= max / 4) continue;
    const i = points.findIndex((p) => p.t === e.t);
    if (i >= 0) keep.add(i);
  }
  const spread = (from, to, n) => {   // n - 1 points strictly between from and to
    for (let k = 1; k < n; k++) keep.add(from + Math.round(k * (to - from) / n));
  };
  const free = max - keep.size;
  const rollShare = landing === last ? 0 : landing === 0 ? free : Math.max(1, Math.round(free * 0.2));
  spread(0, landing, free - rollShare + 1);
  if (rollShare) spread(landing, last, rollShare + 1);
  return [...keep].sort((a, b) => a - b).map((i) => round(points[i]));
}

// The events a lineup draws: water, trees, the cup, and out of bounds (where the ball
// first crossed into it, when it finished there).
function shotEvents(ctx, sim) {
  const out = [];
  for (const e of sim.events) {
    if (e.type === 'water') out.push({ type: 'water', ...xy(e) });
    else if (e.type === 'tree') out.push({ type: 'tree', t: r3(e.t), ...xyz(e), part: e.part });
    else if (e.type === 'holed') out.push({ type: 'holed', ...xy(e) });
  }
  if (sim.endSurface === 'ob') {
    const p = sim.points.find((q) => ctx.surfaceAt(q.x, q.y) === 'ob') || sim.end;
    out.push({ type: 'ob', ...xy(p) });
  }
  return out;
}

// 2x2 covariance -> its 2-sigma ellipse: 16-point outline, full axis lengths (yd) and
// the compass bearing of the long axis (0..180).
function ellipse(centre, cov) {
  const [a, b, d] = cov;   // [[a, b], [b, d]]
  const mid = (a + d) / 2, rad = Math.hypot((a - d) / 2, b);
  const l1 = Math.max(0, mid + rad), l2 = Math.max(0, mid - rad);
  const theta = rad > 1e-12 ? 0.5 * Math.atan2(2 * b, a - d) : 0;   // from +x
  const e1 = { x: Math.cos(theta), y: Math.sin(theta) }, e2 = { x: -Math.sin(theta), y: Math.cos(theta) };
  const s1 = SIGMA * Math.sqrt(l1), s2 = SIGMA * Math.sqrt(l2);
  const outline = [];
  for (let k = 0; k < OUTLINE_POINTS; k++) {
    const phi = 2 * Math.PI * k / OUTLINE_POINTS;
    const c = Math.cos(phi) * s1, s = Math.sin(phi) * s2;
    outline.push(xy({ x: centre.x + c * e1.x + s * e2.x, y: centre.y + c * e1.y + s * e2.y }));
  }
  let bearing = Math.atan2(e1.x, e1.y) * 180 / Math.PI;
  bearing = ((bearing % 180) + 180) % 180;
  return { outline, majorYd: r1(2 * s1 / YD), minorYd: r1(2 * s2 / YD), angleDeg: r1(bearing) % 180 };
}

// Covariance of where the ball ends up, from launches one sigma either side in each
// of speed, start line and spin axis: each pair's half-difference is how far one
// sigma moves the ball, and independent errors add as c c^T (the delta method; its
// eigen-decomposition is the PCA of the spread). `extra`: more one-sigma moves (the
// gusts). The two compounding misses (start right AND curve right, start left AND
// curve left) catch what that linear picture misses — a kick off a slope, the water —
// and add half their departure from it.
// A launch that meets a tree the shot itself flies clear of (or clears one the shot
// hits) is a different shot, not a measure of a one-sigma miss: one dropped by a tree
// 35 yd out once stretched a drive's landing area to 615 yd. Such a launch (`odd`)
// gives way to its clean twin, mirrored, and no one launch moves the ball more than
// `capM` in this picture.
function spreadCov(centre, pairs, combos, pick, extra = [], { odd = () => false, capM = Infinity } = {}) {
  const capped = (c) => {
    const L = Math.hypot(c.x, c.y);
    return L > capM ? { x: (c.x * capM) / L, y: (c.y * capM) / L } : c;
  };
  let a = 0, b = 0, d = 0;
  const half = pairs.map(([plus, minus]) => {
    const p = pick(plus), m = pick(minus);
    let c;
    if (odd(plus) && !odd(minus)) c = { x: centre.x - m.x, y: centre.y - m.y };
    else if (odd(minus) && !odd(plus)) c = { x: p.x - centre.x, y: p.y - centre.y };
    else c = { x: (p.x - m.x) / 2, y: (p.y - m.y) / 2 };
    c = capped(c);
    a += c.x * c.x; b += c.x * c.y; d += c.y * c.y;
    return c;
  });
  for (const c of extra) { a += c.x * c.x; b += c.x * c.y; d += c.y * c.y; }
  // combos: [[sim, sign]] for (+hla, +axis) and (-hla, -axis); pairs[1], pairs[2] are hla, axis
  for (const [sim, sign] of combos) {
    if (odd(sim)) continue;
    const p = pick(sim);
    const r = capped({
      x: p.x - centre.x - sign * (half[1].x + half[2].x),
      y: p.y - centre.y - sign * (half[1].y + half[2].y),
    });
    a += r.x * r.x / 2; b += r.x * r.y / 2; d += r.y * r.y / 2;
  }
  return [a, b, d];
}

// The cap on one launch's move in the dispersion: a fifth of the way the ball goes.
const SPREAD_CAP_SHARE = 0.2;
const SPREAD_CAP_MIN_M = 12;

function simSummary(ctx, sim) {
  return {
    carryYd: r1(sim.carryYd),
    totalYd: r1(sim.totalYd),
    offlineYd: r1(sim.offlineYd),
    flightTime: r2(sim.flightTime),   // where its path turns from flight to roll
    path: decimatePath(sim.points, sim.flightTime, MAX_PATH_POINTS, sim.events),
  };
}

// ---------- full shots ----------
function predictFull(ctx, key, bag) {
  const model = modelFor(bag, key);
  const launch = model.launch;
  const run = makeRunner(ctx);
  const cur = physicsOptions(ctx.conditions);              // steady wind
  const std = physicsOptions(DEFAULTS);
  const standardDay = isStandard(ctx.conditions);
  const aimRight = rightOf(ctx.aimDeg);

  const main = run(launch, { opts: cur });
  const standard = standardDay ? main : run(launch, { opts: std });

  // Each condition alone, from the standard shot.
  const effects = { windCarryYd: 0, windOfflineYd: 0, airCarryYd: 0, firmnessRollYd: 0, elevationYd: 0 };
  let w = null;   // the standard shot in the steady wind (carry only)
  if (cur.wind) {
    w = run(launch, { opts: { ...std, wind: cur.wind, carryOnly: true } });
    effects.windCarryYd = r1(w.carryYd - standard.carryYd);
    effects.windOfflineYd = r1((lateral(ctx, w.land, aimRight) - lateral(ctx, standard.land, aimRight)) / YD);
  }
  if (cur.airDensity !== std.airDensity) {
    const a = run(launch, { opts: { ...std, airDensity: cur.airDensity, carryOnly: true } });
    effects.airCarryYd = r1(a.carryYd - standard.carryYd);
  }
  if (cur.firmness !== std.firmness || cur.greenStimp !== std.greenStimp) {
    const f = run(launch, { opts: { ...std, firmness: cur.firmness, greenStimp: cur.greenStimp } });
    effects.firmnessRollYd = r1((f.totalYd - f.carryYd) - (standard.totalYd - standard.carryYd));
  }
  // the ground falling away or rising: the standard carry over the real terrain against
  // the same flight over level ground at the ball's height (both clear of trees)
  {
    const level = { flat: true, h: () => ctx.z0, grad: () => ({ dx: 0, dy: 0 }) };
    const flat = run(launch, { opts: { ...std, terrain: level, trees: null, carryOnly: true } });
    const treeHit = standard.events.some((e) => e.type === 'tree');
    const real = treeHit ? run(launch, { opts: { ...std, trees: null, carryOnly: true } }) : standard;
    effects.elevationYd = r1(real.carryYd - flat.carryYd);
  }

  // Dispersion: one sigma either side in speed, start line and spin axis, the two
  // compounding misses, and the gusts' sigma when it gusts (the wind's own push scaled
  // to it: a wind's effect grows about linearly with its speed).
  const sd = model.sd;
  const vary = (patch) => run({ ...launch, ...patch }, { opts: cur });
  const pairs = [
    [vary({ speedMph: launch.speedMph + sd.speedMph }), vary({ speedMph: Math.max(1, launch.speedMph - sd.speedMph) })],
    [vary({ hla: launch.hla + sd.hla }), vary({ hla: launch.hla - sd.hla })],
    [vary({ spinAxis: launch.spinAxis + sd.spinAxis }), vary({ spinAxis: launch.spinAxis - sd.spinAxis })],
  ];
  const combos = [
    [vary({ hla: launch.hla + sd.hla, spinAxis: launch.spinAxis + sd.spinAxis }), 1],
    [vary({ hla: launch.hla - sd.hla, spinAxis: launch.spinAxis - sd.spinAxis }), -1],
  ];
  const extra = [];
  if (ctx.conditions.gustMph > 0) {
    const gustSd = ctx.conditions.gustMph * MPH / Math.sqrt(3);   // a uniform gust's sigma
    let push;
    if (w) {
      const k = gustSd / cur.wind.speedMps;
      push = { x: (w.land.x - standard.land.x) * k, y: (w.land.y - standard.land.y) * k };
    } else {
      const g = run(launch, { opts: { ...cur, wind: { speedMps: gustSd, fromDeg: ctx.conditions.windFromDeg }, carryOnly: true } });
      push = { x: g.land.x - main.land.x, y: g.land.y - main.land.y };
    }
    extra.push(push);
  }
  const landCentre = main.land, restCentre = { x: main.end.x, y: main.end.y };
  const hitsTree = (sim) => sim.events.some((e) => e.type === 'tree');
  const mainTree = hitsTree(main);
  const odd = (sim) => hitsTree(sim) !== mainTree;
  const cap = (p) => Math.max(SPREAD_CAP_MIN_M, SPREAD_CAP_SHARE * Math.hypot(p.x - ctx.ball.x, p.y - ctx.ball.y));
  const landE = ellipse(landCentre, spreadCov(landCentre, pairs, combos, (s) => s.land, extra, { odd, capM: cap(landCentre) }));
  const restE = ellipse(restCentre, spreadCov(restCentre, pairs, combos, (s) => s.end, extra, { odd, capM: cap(restCentre) }));

  // Aim assist (AUTO): the aim offset that brings the ball down on the line to the safe
  // spot (lib/safe-spot.js: the middle of the green when this club gets there, else the
  // middle of the fairway where it finishes), found by the secant method with the wind
  // and the shape in it. Practice aims at its own flag, down the ball -> flag line.
  const spot = ctx.game.practice ? null : safeSpot({
    course: ctx.game.course, hole: ctx.game.hole, ball: ctx.ball, pin: ctx.pin,
    restM: Math.hypot(main.end.x - ctx.ball.x, main.end.y - ctx.ball.y),
    landM: Math.hypot(main.land.x - ctx.ball.x, main.land.y - ctx.ball.y), surfaceAt: ctx.surfaceAt,
  });
  const spotRight = spot ? rightOf(Math.atan2(spot.x - ctx.ball.x, spot.y - ctx.ball.y) * 180 / Math.PI) : ctx.lineRight;
  const landLateral = (sim) => lateral(ctx, sim.land, spotRight);
  let a0 = ctx.offset, f0 = landLateral(main);
  let best = { a: a0, f: f0 };
  if (Math.abs(f0) > AIM_TOL_M) {
    const reach = Math.hypot(main.land.x - ctx.ball.x, main.land.y - ctx.ball.y) || 1;
    let a1 = Math.max(-AIM_LIMIT_DEG, Math.min(AIM_LIMIT_DEG, a0 - Math.atan2(f0, reach) * 180 / Math.PI));
    for (let iter = 0; iter < 4; iter++) {
      const f1 = landLateral(run(launch, { aimDeg: ctx.lineDeg + a1, opts: { ...cur, carryOnly: true } }));
      if (Math.abs(f1) < Math.abs(best.f)) best = { a: a1, f: f1 };
      if (Math.abs(f1) <= AIM_TOL_M || f1 === f0) break;
      const a2 = Math.max(-AIM_LIMIT_DEG, Math.min(AIM_LIMIT_DEG, a1 - f1 * (a1 - a0) / (f1 - f0)));
      a0 = a1; f0 = f1; a1 = a2;
      if (a1 === a0) break;
    }
  }

  const pinYd = ctx.distM / YD;
  const ratio = main.carryYd > 1 && standard.carryYd > 1 ? standard.carryYd / main.carryYd : 1;
  return {
    club: key,
    isPutt: false,
    source: model.source,
    n: model.n,
    launch,
    sd: model.sd,
    lie: ctx.lie,
    aimDeg: r2(ctx.aimDeg),
    aimOffset: r2(ctx.offset),
    distToPinYd: r1(pinYd),
    pinElevationFt: r1((ctx.zPin - ctx.z0) * FT),
    carryYd: r1(main.carryYd),
    totalYd: r1(main.totalYd),
    rollYd: r1(main.totalYd - main.carryYd),
    apexFt: r1(main.apexFt),
    offlineYd: r1(main.offlineYd),
    pinOfflineYd: r1(lateral(ctx, main.end) / YD),
    flightTime: r2(main.flightTime),
    elevationFt: r1((main.land.z - ctx.z0) * FT),
    path: decimatePath(main.points, main.flightTime, MAX_PATH_POINTS, main.events),
    land: xyz(main.land),
    rest: xyz({ x: main.end.x, y: main.end.y, z: main.endZ }),
    landSurface: ctx.surfaceAt(main.land.x, main.land.y),
    restSurface: main.endSurface,
    holed: Boolean(main.holed),
    events: shotEvents(ctx, main),
    dispersion: {
      land: landE.outline,
      rest: restE.outline,
      majorYd: landE.majorYd,
      minorYd: landE.minorYd,
      angleDeg: landE.angleDeg,
      restMajorYd: restE.majorYd,
      restMinorYd: restE.minorYd,
      restAngleDeg: restE.angleDeg,
      sigma: SIGMA,
    },
    standard: simSummary(ctx, standard),
    effects,
    playsLikeYd: r1(pinYd * ratio + (ctx.zPin - ctx.z0) / YD),
    aimAssist: {
      offsetDeg: r2(best.a), landOfflineYd: r1(best.f / YD),
      spot: spot ? { x: r2(spot.x), y: r2(spot.y), kind: spot.kind } : null,
    },
  };
}

// ---------- putts ----------
// A putt at the pace that would finish ~16 in past the hole (a few calibration rolls
// without the cup), from the current aim, and the read: the aim offset that finishes
// it on the ball -> hole line.
function predictPutt(ctx) {
  const run = makeRunner(ctx);
  const cur = physicsOptions(ctx.conditions);
  const std = physicsOptions(DEFAULTS);
  const decel = (opts) => {
    const s = groundModel(opts.firmness, opts.greenStimp).s;
    return (s[ctx.lie] || s.rough).roll;
  };
  const a = decel(cur), aStd = groundModel(std.firmness, std.greenStimp).s.green.roll;
  const dh = ctx.zPin - ctx.z0;
  const want = ctx.distM + PUTT_PAST_M;
  let v2 = Math.max(0.04, 2 * a * want + 2 * ROLL_INERTIA * G * dh);
  const putt = () => ({ speedMph: Math.min(39, Math.sqrt(v2) / MPH), vla: 0, hla: 0, totalSpin: 0, spinAxis: 0 });
  const noCup = { ...cur, pin: null };
  for (let iter = 0; iter < 3; iter++) {
    const got = along(ctx, run(putt(), { aimDeg: ctx.lineDeg, opts: noCup }).end);
    if (Math.abs(got - want) < 0.05) break;
    v2 *= Math.min(4, Math.max(0.25, want / Math.max(0.1, got)));
  }
  const launch = putt();
  const main = run(launch, { opts: cur });
  const standard = run(launch, { opts: std });

  // the read: finish on the line (rolls without the cup, so the miss can be measured)
  const restLateral = (aOff) => lateral(ctx, run(launch, { aimDeg: ctx.lineDeg + aOff, opts: noCup }).end);
  let a0 = 0, f0 = restLateral(0);
  let best = { a: a0, f: f0 };
  if (Math.abs(f0) > 0.02) {
    let a1 = Math.max(-AIM_LIMIT_DEG, Math.min(AIM_LIMIT_DEG, -Math.atan2(f0, Math.max(0.5, want)) * 180 / Math.PI));
    for (let iter = 0; iter < 3; iter++) {
      const f1 = restLateral(a1);
      if (Math.abs(f1) < Math.abs(best.f)) best = { a: a1, f: f1 };
      if (Math.abs(f1) <= 0.02 || f1 === f0) break;
      const a2 = Math.max(-AIM_LIMIT_DEG, Math.min(AIM_LIMIT_DEG, a1 - f1 * (a1 - a0) / (f1 - f0)));
      a0 = a1; f0 = f1; a1 = a2;
    }
  }

  const pinYd = ctx.distM / YD;
  const start = { x: ctx.ball.x, y: ctx.ball.y, z: ctx.z0 };
  return {
    club: 'PT',
    isPutt: true,
    source: 'putt',
    n: 0,
    launch: { speedMph: r1(launch.speedMph), vla: 0, hla: 0, totalSpin: 0, spinAxis: 0 },
    sd: null,
    lie: ctx.lie,
    aimDeg: r2(ctx.aimDeg),
    aimOffset: r2(ctx.offset),
    distToPinYd: r1(pinYd),
    pinElevationFt: r1(dh * FT),
    carryYd: 0,
    totalYd: r1(main.totalYd),
    rollYd: r1(main.totalYd),
    apexFt: 0,
    offlineYd: r1(main.offlineYd),
    pinOfflineYd: r1(lateral(ctx, main.end) / YD),
    flightTime: 0,
    elevationFt: r1(dh * FT),             // putts: the hole's height above the ball
    path: decimatePath(main.points, 0, MAX_PATH_POINTS, main.events),
    land: xyz(start),
    rest: xyz({ x: main.end.x, y: main.end.y, z: main.endZ }),
    landSurface: ctx.lie,
    restSurface: main.endSurface,
    holed: Boolean(main.holed),
    events: shotEvents(ctx, main),
    dispersion: null,
    standard: { ...simSummary(ctx, standard), carryYd: 0, flightTime: 0 },
    effects: {
      windCarryYd: 0,
      windOfflineYd: 0,
      airCarryYd: 0,
      firmnessRollYd: r1(main.totalYd - standard.totalYd),     // today's green speed, same stroke
      elevationYd: r1(-ROLL_INERTIA * G * dh / a / YD),          // the slope: - uphill, + downhill
    },
    // the flat, standard-speed putt that needs the same stroke
    playsLikeYd: r1(Math.max(0, a * ctx.distM + ROLL_INERTIA * G * dh) / aStd / YD),
    aimAssist: { offsetDeg: r2(best.a), landOfflineYd: r1(best.f / YD), restOfflineYd: r1(best.f / YD) },
  };
}

function bagOf(game, bag) {
  return bag === undefined ? game && game.bag || null : bag;
}

/**
 * Predict a shot with `club` (a CLUB_FULL key or any club name; default: the club the
 * player picked, else the recommended one) from the current ball, hole, lie and
 * conditions. aimOffset (deg, + right, like Game.aimOffset) overrides the current
 * aim. On the green (or with the putter) the prediction is a putt.
 */
function predictShot(game, { club = null, aimOffset = null, bag } = {}) {
  const ctx = shotContext(game, aimOffset);
  const theBag = bagOf(game, bag);
  let key = null;
  if (club !== null && club !== undefined && String(club).trim() !== '') {
    key = clubKey(club);
    if (!key) throw new PredictError('BAD_CLUB', `Unknown club: ${String(club).slice(0, 20)}`);
  }
  if (ctx.lie === 'green' || key === 'PT') return predictPutt(ctx);
  if (!key) key = clubKey(game.selectedClub);
  if (!key || key === 'PT') key = carriesFor(ctx, theBag).recommended;
  if (key === 'PT') return predictPutt(ctx);
  return predictFull(ctx, key, theBag);
}

function carriesFor(ctx, bag) {
  const run = makeRunner(ctx);
  const cur = physicsOptions(ctx.conditions);
  const clubs = FULL_CLUBS.map((club) => {
    const model = modelFor(bag, club);
    const sim = run(model.launch, { opts: cur });
    return { club, carryYd: r1(sim.carryYd), totalYd: r1(sim.totalYd), source: model.source };
  });
  const pinYd = ctx.distM / YD;
  let recommended = 'PT';
  if (ctx.lie !== 'green') {
    const by = pinYd < CARRY_PREFERRED_YD ? 'carryYd' : 'totalYd';
    recommended = clubs.reduce((a, b) => (Math.abs(b[by] - pinYd) < Math.abs(a[by] - pinYd) ? b : a)).club;
  }
  return { clubs, recommended, distToPinYd: r1(pinYd), lie: ctx.lie };
}

/**
 * Carry and total of every full club (centre launch, current aim and conditions) and
 * the club for the pin: the one whose total is nearest the pin, or whose carry is
 * under ~120 yd; the putter on the green.
 */
function predictCarries(game, { bag } = {}) {
  return carriesFor(shotContext(game, null), bagOf(game, bag));
}

module.exports = { PredictError, cellSurfaceLookup, predictCarries, predictShot };
