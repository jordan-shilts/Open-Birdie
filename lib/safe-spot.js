'use strict';
// The safe spot a full shot is aimed at when the player asks for AUTO aim: the middle of
// the green when the club gets there, else the middle of this hole's fairway where the
// ball comes down, else the hole's line of play there, else the pin. lib/predict.js then
// finds the aim that brings the ball down on the line to it, wind and shape allowed for.
//
//   safeSpot({ course, hole, ball, pin, restM, landM, surfaceAt }) -> { x, y, kind }
//     restM / landM: how far from the ball this club finishes / comes down (m; landM
//     defaults to restM); kind: 'green' | 'fairway' | 'line' | 'pin'
// The fairway is read where the ball comes down: that hardly moves with the aim, where
// the finish does (a fairway lets it run further than the rough), so the spot holds
// still once aimed at.
//
// Sim coordinates: metres, x east, y north.

const { pointInPoly } = require('./course');

const DEG = Math.PI / 180;
const GREEN_REACH_M = 9;     // the club gets there: it finishes no more than this short of the green's front
const SWEEP_DEG = 35;        // the fairway is looked for this far either side of the line of play
const STEP_DEG = 0.5;
const CORRIDOR_M = 60;       // fairway this hole can use lies this close to its line of play
const MIN_WIDTH_M = 8;       // ... in a stretch at least this wide

function distToSeg(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}
function distToLine(x, y, line) {
  let d = Infinity;
  for (let i = 1; i < line.length; i++) d = Math.min(d, distToSeg(x, y, line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]));
  return d;
}
function distToEdges(x, y, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, distToSeg(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
  return d;
}

// The middle of a green: the point inside it furthest from its edge (the centroid of a
// kidney-shaped green can sit on the fringe, or off the green altogether).
const middles = new WeakMap();
function greenMiddle(poly) {
  if (middles.has(poly)) return middles.get(poly);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); cx += x; cy += y; }
  let best = { x: cx / poly.length, y: cy / poly.length }, bestD = -1;
  const step = Math.max(0.4, Math.max(x1 - x0, y1 - y0) / 48);
  for (let y = y0 + step / 2; y < y1; y += step) {
    for (let x = x0 + step / 2; x < x1; x += step) {
      if (!pointInPoly(x, y, poly)) continue;
      const d = distToEdges(x, y, poly);
      if (d > bestD) { bestD = d; best = { x, y }; }
    }
  }
  middles.set(poly, best);
  return best;
}

// The green the pin is on, else the nearest within 15 m.
function greenAt(course, pin) {
  let best = null, bestD = 15;
  for (const su of course?.surfaces || []) {
    if (su.kind !== 'green' || !su.poly || su.poly.length < 3) continue;
    if (pointInPoly(pin.x, pin.y, su.poly)) return su.poly;
    const d = distToEdges(pin.x, pin.y, su.poly);
    if (d < bestD) { bestD = d; best = su.poly; }
  }
  return best;
}

// Where the line of play [tee, ..., pin] crosses the circle of radius r round the
// ball: the crossing furthest along the line, or null.
function lineAt(line, ball, r) {
  let best = null, bestS = -1, s0 = 0;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1], [bx, by] = line[i];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    const fx = ax - ball.x, fy = ay - ball.y;
    const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r;
    const disc = b * b - 4 * a * c;
    if (a > 0 && disc >= 0) {
      for (const t of [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)]) {
        if (t >= 0 && t <= 1 && s0 + t * L > bestS) { bestS = s0 + t * L; best = { x: ax + t * dx, y: ay + t * dy }; }
      }
    }
    s0 += L;
  }
  return best;
}

// The middle of the stretch of fairway the ball can finish on: sweep the circle of
// radius r round the ball either side of `around` (on the line of play), keep the
// stretches of fairway this hole can use (near its line, wide enough), and take the
// middle of the one nearest the line.
function fairwayMiddle({ ball, r, around, surfaceAt, line = null }) {
  const base = Math.atan2(around.x - ball.x, around.y - ball.y);
  const at = (deg) => ({ x: ball.x + Math.sin(base + deg * DEG) * r, y: ball.y + Math.cos(base + deg * DEG) * r });
  const usable = (p) => surfaceAt(p.x, p.y) === 'fairway' && (!line || distToLine(p.x, p.y, line) <= CORRIDOR_M);
  const n = Math.round(SWEEP_DEG / STEP_DEG);
  let best = null, start = null;
  const close = (end) => {
    const width = (end - start) * STEP_DEG * DEG * r;
    const mid = ((start + end) / 2) * STEP_DEG;
    if (width >= MIN_WIDTH_M && (!best || Math.abs(mid) < Math.abs(best))) best = mid;
    start = null;
  };
  for (let k = -n; k <= n; k++) {
    if (usable(at(k * STEP_DEG))) { if (start === null) start = k; }
    else if (start !== null) close(k - 1);
  }
  if (start !== null) close(n);
  return best === null ? null : at(best);
}

function safeSpot({ course, hole, ball, pin, restM, landM = restM, surfaceAt }) {
  const green = pin ? greenAt(course, pin) : null;
  if (green) {
    const front = pointInPoly(ball.x, ball.y, green) ? 0 : distToEdges(ball.x, ball.y, green);
    if (restM >= front - GREEN_REACH_M) return { ...greenMiddle(green), kind: 'green' };
  }
  const line = hole && Array.isArray(hole.line) && hole.line.length > 1 ? hole.line : null;
  const onLine = line ? lineAt(line, ball, landM) : null;
  let around = onLine;
  if (!around && pin) {
    const d = Math.hypot(pin.x - ball.x, pin.y - ball.y) || 1;
    around = { x: ball.x + ((pin.x - ball.x) / d) * landM, y: ball.y + ((pin.y - ball.y) / d) * landM };
  }
  const fairway = around ? fairwayMiddle({ ball, r: landM, around, surfaceAt, line }) : null;
  if (fairway) return { ...fairway, kind: 'fairway' };
  if (onLine) return { ...onLine, kind: 'line' };
  return pin ? { x: pin.x, y: pin.y, kind: 'pin' } : null;
}

module.exports = { safeSpot, greenMiddle, greenAt, lineAt, fairwayMiddle, GREEN_REACH_M };
