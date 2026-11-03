'use strict';
// Practice on the loaded course: a driving range and mini games. A session uses the
// course's physics (surfaces, terrain, trees) but never touches the round: the ball,
// hole and scores of the round in progress are exactly as they were when practice
// ends. No penalties and no gimmes; every ball is hit from the session's spot.
//
//   range      Driving range: from the course's mapped range (OSM golf=driving_range)
//              toward yardage flags every 50 yd, else from hole 1's tee down its first
//              leg. Unlimited balls, a shot table and per-club averages.
//   closest    Closest to the pin: 5 balls at a par 3 (the shortest unless one is
//              picked). Score: the best finish; a hole-in-one ends the game.
//   longdrive  Long drive: 6 balls on the range; a drive counts when it finishes in
//              the grid (25 yd either side of the line, not in water or out of
//              bounds). Score: the longest counted drive.
//   targets    Target challenge: 10 balls, a new flag 60-200 yd out for each;
//              10 / 5 / 3 / 1 points inside 3 / 8 / 15 / 25 yd.

const { simulateShot, YD } = require('./physics');
const { physicsOptions, shotWind } = require('./conditions');

const MODES = Object.freeze({
  range: { label: 'Driving range', balls: null },
  closest: { label: 'Closest to the pin', balls: 5 },
  longdrive: { label: 'Long drive', balls: 6 },
  targets: { label: 'Target challenge', balls: 10 },
});
const FLAG_STEP_YD = 50;
const MAX_FLAG_YD = 300;
// yardage flags stand a few yards off the line, alternating sides like a range's
// target greens, so from the tee they don't hide behind each other
const FLAG_LATERAL_YD = Object.freeze([-5, 6, -4, 8, -7, 5]);
const GRID_HALF_YD = 25;
const TARGET_RINGS = Object.freeze([[3, 10], [8, 5], [15, 3], [25, 1]]); // [inside yd, points]
const TARGET_MIN_YD = 60;
const TARGET_MAX_YD = 200;
const TEE_INSET_M = 8;

const r1 = (v) => Math.round(v * 10) / 10;

function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a) / 2;
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Minimum-area enclosing rectangle (rotating calipers over the hull): its centre, the
// unit vector along its long side, and the half length and half width.
function longAxis(poly) {
  const hull = convexHull(poly);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i];
    const [bx, by] = hull[(i + 1) % hull.length];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-9) continue;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [px, py] of hull) {
      const u = px * ux + py * uy, v = -px * uy + py * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, ux, uy, minU, maxU, minV, maxV };
  }
  if (!best) return null;
  const cu = (best.minU + best.maxU) / 2, cv = (best.minV + best.maxV) / 2;
  const center = [cu * best.ux - cv * best.uy, cu * best.uy + cv * best.ux];
  const lenU = best.maxU - best.minU, lenV = best.maxV - best.minV;
  const axis = lenU >= lenV ? [best.ux, best.uy] : [-best.uy, best.ux];
  return { center, axis, halfLength: Math.max(lenU, lenV) / 2, halfWidth: Math.min(lenU, lenV) / 2 };
}

const centroid = (poly) => [
  poly.reduce((s, p) => s + p[0], 0) / poly.length,
  poly.reduce((s, p) => s + p[1], 0) / poly.length,
];

// Where to practise: the largest mapped driving range, played along its long axis
// from the end where a mapped tee sits (else the end nearest hole 1's tee — first tee,
// clubhouse and range tee are usually together). Without a range: hole 1's tee, down
// the hole's first leg. Returns { kind, spot, dir, lengthYd }.
function practiceGround(course) {
  const holes = course.holes || [];
  const firstTee = holes[0] && holes[0].tee;
  const ranges = (course.surfaces || []).filter((s) => s.kind === 'range' && Array.isArray(s.poly) && s.poly.length >= 3);
  if (ranges.length) {
    const range = ranges.reduce((a, b) => (polygonArea(b.poly) > polygonArea(a.poly) ? b : a));
    const box = longAxis(range.poly);
    if (box && box.halfLength >= 40) {
      const [cx, cy] = box.center;
      const [ax, ay] = box.axis;
      const ends = [[cx - ax * box.halfLength, cy - ay * box.halfLength], [cx + ax * box.halfLength, cy + ay * box.halfLength]];
      const near = (pt) => (e) => Math.hypot(e[0] - pt[0], e[1] - pt[1]);
      let anchor = null;
      const tees = (course.surfaces || []).filter((s) => s.kind === 'tee' && s.poly && s.poly.length >= 3).map((s) => centroid(s.poly));
      const onRange = tees.filter((t) => Math.abs((t[0] - cx) * ay - (t[1] - cy) * ax) <= box.halfWidth + 15 &&
        Math.abs((t[0] - cx) * ax + (t[1] - cy) * ay) <= box.halfLength + 15);
      if (onRange.length) {
        anchor = onRange.reduce((a, b) => (Math.min(...ends.map(near(b))) < Math.min(...ends.map(near(a))) ? b : a));
      } else if (firstTee) {
        anchor = firstTee;
      }
      const startEnd = anchor && near(anchor)(ends[1]) < near(anchor)(ends[0]) ? 1 : 0;
      const sign = startEnd === 0 ? 1 : -1;
      const dir = [ax * sign, ay * sign];
      const [ex, ey] = ends[startEnd];
      return {
        kind: 'range',
        spot: [ex + dir[0] * TEE_INSET_M, ey + dir[1] * TEE_INSET_M],
        dir,
        lengthYd: (box.halfLength * 2 - TEE_INSET_M) / YD,
      };
    }
  }
  const hole = holes[0];
  const via = (hole.line && hole.line.length >= 2 ? hole.line[1] : hole.pin);
  let dx = via[0] - hole.tee[0], dy = via[1] - hole.tee[1];
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  return { kind: 'hole', spot: [hole.tee[0], hole.tee[1]], dir: [dx, dy], lengthYd: Math.max(len / YD, 250) };
}

function par3Holes(course) {
  return (course.holes || [])
    .map((h, index) => ({ index, ref: h.ref ?? index + 1, par: h.par, lengthYd: h.lengthYd, tee: h.tee, pin: h.pin }))
    .filter((h) => h.par === 3 && Array.isArray(h.tee) && Array.isArray(h.pin));
}

// The club a ball was most likely hit with, from its speed (as the HUD guesses it),
// for balls whose launch monitor or practice panel names no club.
const CLUB_BY_SPEED = Object.freeze([[158, 'DR'], [147, '3W'], [138, '3H'], [130, '4i'], [123, '5i'],
  [115, '6i'], [107, '7i'], [99, '8i'], [88, '9i'], [70, 'PW'], [50, 'SW']]);
function clubFromSpeed(speedMph) {
  for (const [min, club] of CLUB_BY_SPEED) if (speedMph >= min) return club;
  return 'LW';
}

function targetPoints(distYd) {
  for (const [inside, points] of TARGET_RINGS) if (distYd <= inside) return points;
  return 0;
}

class PracticeSession {
  // course context: { course, surfaceAt, terrain, treeObstacles, conditions } from the
  // game (conditions: lib/conditions.js; absent = standard conditions).
  // options: { mode, targetYd, hole (par-3 index for closest), random }
  constructor(ctx, { mode = 'range', targetYd = null, hole = null, random = Math.random } = {}) {
    if (!MODES[mode]) throw new Error(`Unknown practice mode: ${mode}`);
    if (!ctx || !ctx.course) throw new Error('Practice needs a loaded course');
    this.ctx = ctx;
    this.mode = mode;
    this.random = random;
    this.shots = [];
    this.aimOffset = 0;
    this.ground = practiceGround(ctx.course);
    this.flags = [];
    for (let yd = FLAG_STEP_YD, i = 0; yd <= Math.min(MAX_FLAG_YD, this.ground.lengthYd + 20); yd += FLAG_STEP_YD, i++) {
      this.flags.push({ ...this._along(yd, FLAG_LATERAL_YD[i % FLAG_LATERAL_YD.length]), yd });
    }

    if (mode === 'closest') {
      const par3s = par3Holes(ctx.course);
      this.par3s = par3s;
      const picked = par3s.find((h) => h.index === hole) ||
        par3s.reduce((a, b) => (!a || (b.lengthYd || 1e9) < (a.lengthYd || 1e9) ? b : a), null);
      if (picked) {
        this.holeIndex = picked.index;
        this.spot = [...picked.tee];
        this.target = { x: picked.pin[0], y: picked.pin[1], yd: picked.lengthYd, ref: picked.ref };
      } else {
        this.holeIndex = null;   // no par 3: a 150 yd flag on the practice ground
        this.spot = [...this.ground.spot];
        this.target = { ...this._along(150), yd: 150 };
      }
    } else {
      this.spot = [...this.ground.spot];
      if (mode === 'targets') this.target = this._randomTarget();
      else this.setTarget(targetYd || (mode === 'longdrive' ? 250 : 150));
    }
  }

  get label() { return MODES[this.mode].label; }
  get ballsTotal() { return MODES[this.mode].balls; }
  get ballsHit() { return this.shots.length; }
  get over() {
    if (this.ballsTotal != null && this.ballsHit >= this.ballsTotal) return true;
    return this.mode === 'closest' && this.shots.some((s) => s.holed);
  }

  _along(yd, lateralYd = 0) {
    const [sx, sy] = this.ground.spot;
    const [dx, dy] = this.ground.dir;
    const d = yd * YD, l = lateralYd * YD;
    return { x: sx + dx * d + dy * l, y: sy + dy * d - dx * l };
  }

  _randomTarget() {
    const maxYd = Math.max(TARGET_MIN_YD, Math.min(TARGET_MAX_YD, this.ground.lengthYd - 10));
    const yd = Math.round((TARGET_MIN_YD + this.random() * (maxYd - TARGET_MIN_YD)) / 5) * 5;
    const lateral = Math.round((this.random() - 0.5) * 24);   // up to 12 yd either side
    return { ...this._along(yd, lateral), yd };
  }

  // Range and long drive: aim at a yardage flag (snapped to the nearest one).
  setTarget(yd) {
    if (this.mode === 'closest' || this.mode === 'targets') return;
    const want = Math.max(FLAG_STEP_YD, Math.min(MAX_FLAG_YD, Number(yd) || 150));
    const flag = this.flags.length
      ? this.flags.reduce((a, b) => (Math.abs(b.yd - want) < Math.abs(a.yd - want) ? b : a))
      : { ...this._along(want), yd: want };
    this.target = { x: flag.x, y: flag.y, yd: flag.yd };
  }

  setAim(offset) { this.aimOffset = Math.max(-45, Math.min(45, Number(offset) || 0)); }

  get aimDeg() {
    const dx = this.target.x - this.spot[0], dy = this.target.y - this.spot[1];
    return (Math.atan2(dx, dy) * 180 / Math.PI) + this.aimOffset;
  }

  play(launch, clubName = null) {
    if (this.over) return null;
    const { surfaceAt, terrain, treeObstacles, conditions } = this.ctx;
    const from = { x: this.spot[0], y: this.spot[1] };
    const sim = simulateShot(launch, from, this.aimDeg, surfaceAt, {
      terrain,
      trees: treeObstacles,
      ...(this.mode === 'closest' && this.holeIndex != null ? { pin: { x: this.target.x, y: this.target.y } } : {}),
      ...physicsOptions(conditions, { gust: true }),
    });
    const end = sim.end;
    const [dx, dy] = [this.target.x - from.x, this.target.y - from.y];
    const lineLen = Math.hypot(dx, dy) || 1;
    const ux = dx / lineLen, uy = dy / lineLen;
    const alongYd = ((end.x - from.x) * ux + (end.y - from.y) * uy) / YD;
    const lineOfflineYd = ((end.x - from.x) * uy - (end.y - from.y) * ux) / YD;   // + = right of the line
    const toTargetYd = Math.hypot(this.target.x - end.x, this.target.y - end.y) / YD;
    const lie = sim.endSurface;
    const shot = {
      n: this.shots.length + 1,
      club: clubName || clubFromSpeed(launch.speedMph),
      clubGuessed: !clubName,
      carryYd: r1(sim.carryYd),
      totalYd: r1(sim.totalYd),
      offlineYd: r1(sim.offlineYd),
      toTargetYd: r1(toTargetYd),
      targetYd: this.target.yd,
      lie,
      holed: Boolean(sim.holed),
      counted: true,
      points: null,
      note: '',
    };

    if (this.mode === 'closest') {
      // a ball in the water or out of bounds has no distance, however near the pin
      shot.counted = shot.holed || (lie !== 'water' && lie !== 'ob');
      shot.note = shot.holed ? 'Hole in one!'
        : !shot.counted ? (lie === 'water' ? 'In the water' : 'Out of bounds')
          : `${Math.round(toTargetYd * 3)} ft from the pin`;
    } else if (this.mode === 'longdrive') {
      shot.distanceYd = r1(alongYd);
      shot.counted = Math.abs(lineOfflineYd) <= GRID_HALF_YD && lie !== 'water' && lie !== 'ob';
      shot.note = shot.counted ? `${Math.round(alongYd)} yd in the grid`
        : lie === 'water' ? 'In the water' : lie === 'ob' ? 'Out of bounds' : `Out of the grid (${Math.round(Math.abs(lineOfflineYd))} yd ${lineOfflineYd > 0 ? 'right' : 'left'})`;
    } else if (this.mode === 'targets') {
      shot.points = targetPoints(toTargetYd);
      shot.note = `${Math.round(toTargetYd)} yd from the ${this.target.yd} yd flag: ${shot.points} point${shot.points === 1 ? '' : 's'}`;
    } else {
      shot.note = `${Math.round(toTargetYd)} yd from the ${this.target.yd} yd flag`;
    }
    this.shots.push(shot);
    const result = {
      practice: { mode: this.mode, shot, over: this.over, score: this.score() },
      hole: null,
      strokes: this.shots.length,
      launch,
      club: clubName || null,
      sim: {
        points: sim.points,
        carryYd: r1(sim.carryYd),
        totalYd: r1(sim.totalYd),
        offlineYd: r1(sim.offlineYd),
        apexFt: Math.round(sim.apexFt),
        flightTime: +sim.flightTime.toFixed(2),
        isPutt: sim.isPutt,
        events: sim.events,
      },
      from,
      end: { x: end.x, y: end.y },
      lie,
      distToPinYd: r1(toTargetYd),
      penalty: 0,
      holed: shot.holed,
      note: shot.note,
      wind: shotWind(sim, conditions),
    };
    // the next target challenge flag appears once this ball has been scored
    if (this.mode === 'targets' && !this.over) this.target = this._randomTarget();
    return result;
  }

  score() {
    const shots = this.shots;
    if (this.mode === 'closest') {
      const best = shots.filter((s) => s.counted).reduce((a, s) => (a == null || s.toTargetYd < a.toTargetYd ? s : a), null);
      return best ? { label: 'Best', value: best.holed ? 'Ace' : `${Math.round(best.toTargetYd * 3)} ft`, yd: best.toTargetYd, shot: best.n } : null;
    }
    if (this.mode === 'longdrive') {
      const best = shots.filter((s) => s.counted).reduce((a, s) => (a == null || s.distanceYd > a.distanceYd ? s : a), null);
      return best ? { label: 'Longest', value: `${Math.round(best.distanceYd)} yd`, yd: best.distanceYd, shot: best.n } : null;
    }
    if (this.mode === 'targets') {
      const points = shots.reduce((sum, s) => sum + (s.points || 0), 0);
      return { label: 'Points', value: `${points}`, points, max: this.ballsTotal * TARGET_RINGS[0][1] };
    }
    return null;
  }

  // Range: per-club averages (a ball without a club name is put down to the club its
  // speed suggests).
  clubStats() {
    const by = new Map();
    for (const s of this.shots) {
      const k = s.club || '—';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(s);
    }
    const avg = (list, f) => r1(list.reduce((sum, s) => sum + f(s), 0) / list.length);
    return [...by].map(([club, list]) => ({
      club,
      n: list.length,
      carryYd: avg(list, (s) => s.carryYd),
      totalYd: avg(list, (s) => s.totalYd),
      offlineYd: avg(list, (s) => Math.abs(s.offlineYd)),
    }));
  }

  state() {
    return {
      mode: this.mode,
      label: this.label,
      ground: this.ground.kind,
      spot: this.spot,
      target: this.target,
      flags: this.mode === 'closest' ? [] : this.flags,
      grid: this.mode === 'longdrive' ? { halfWidthYd: GRID_HALF_YD } : null,
      holeRef: this.mode === 'closest' && this.holeIndex != null ? this.target.ref : null,
      par3s: this.mode === 'closest' ? (this.par3s || []).map((h) => ({ index: h.index, ref: h.ref, lengthYd: h.lengthYd })) : null,
      ballsTotal: this.ballsTotal,
      ballsHit: this.ballsHit,
      over: this.over,
      aimOffset: this.aimOffset,
      score: this.score(),
      shots: this.shots.slice(-50),
      clubStats: this.mode === 'range' ? this.clubStats() : null,
    };
  }
}

module.exports = { MODES, PracticeSession, longAxis, practiceGround, targetPoints };
