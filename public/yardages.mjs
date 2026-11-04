// Yardage-book numbers for the lineup, from the course plan (sim metres, x east, y north):
// the front and back of the green on the line from the ball through the pin, and the
// front and back of every bunker and water hazard near the line of play; which of the
// course's surfaces belong to the hole being played; and an aim in yards off the pin.
// Shared by the overhead map (aim-map.js), the lineup (lineup.js) and the 3D view
// (render/lineup-fx.js); pure, so Node tests it.
const YD = 0.9144;
const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToPoly(x, y, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / L2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + t * ex), y - (ay + t * ey)));
  }
  return best;
}

// The pin's green: the green polygon holding the pin, else the nearest one within 15 m
// (a pin cut on the collar), else null.
export function greenFor(geo, pin) {
  let best = null, bestD = 15;
  for (const su of geo?.surfaces || []) {
    if (su.kind !== 'green' || !su.poly || su.poly.length < 3) continue;
    if (pointInPoly(pin[0], pin[1], su.poly)) return su.poly;
    const d = distToPoly(pin[0], pin[1], su.poly);
    if (d < bestD) { bestD = d; best = su.poly; }
  }
  return best;
}

// Front and back of the green from the ball: where the line through the pin first enters
// the green and last leaves it, in yards, with those points. If the line misses the green
// (a pin on the collar), its nearest and farthest edge points stand in. null when the
// ball is on the green.
export function greenFrontBack(ball, pin, poly) {
  if (!poly || poly.length < 3 || pointInPoly(ball.x, ball.y, poly)) return null;
  const dx = pin[0] - ball.x, dy = pin[1] - ball.y, L = Math.hypot(dx, dy);
  if (L < 1) return null;
  const ux = dx / L, uy = dy / L;
  let t0 = Infinity, t1 = -Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const ex = bx - ax, ey = by - ay, den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = ax - ball.x, wy = ay - ball.y;
    const t = (wx * ey - wy * ex) / den, s = (wx * uy - wy * ux) / den;
    if (t <= 0 || s < 0 || s > 1) continue;
    t0 = Math.min(t0, t); t1 = Math.max(t1, t);
  }
  if (t1 > t0) {
    return { frontYd: t0 / YD, backYd: t1 / YD, front: [ball.x + ux * t0, ball.y + uy * t0], back: [ball.x + ux * t1, ball.y + uy * t1] };
  }
  let near = null, far = null;
  for (const [x, y] of poly) {
    const d = Math.hypot(x - ball.x, y - ball.y);
    if (!near || d < near.d) near = { d, x, y };
    if (!far || d > far.d) far = { d, x, y };
  }
  return { frontYd: near.d / YD, backYd: far.d / YD, front: [near.x, near.y], back: [far.x, far.y] };
}

// Where a ray from the ball along (fx, fy) runs inside a polygon: [[in, out]] in metres.
function raySpans(poly, ball, fx, fy) {
  const ts = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const ex = bx - ax, ey = by - ay, den = fx * ey - fy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = ax - ball.x, wy = ay - ball.y;
    const t = (wx * ey - wy * ex) / den, s = (wx * fy - wy * fx) / den;
    if (t > 0 && s >= 0 && s < 1) ts.push(t);
  }
  ts.sort((p, q) => p - q);
  const spans = [];
  let from = pointInPoly(ball.x, ball.y, poly) ? 0 : null;
  for (const t of ts) {
    if (from === null) { from = t; continue; }
    if (t - from > 1) spans.push([from, t]);
    from = null;
  }
  return spans;
}

// "150–170", or "400+" for water that runs on past the end of what was measured
export const hazardText = (hz) => (hz.open ? `${Math.round(hz.frontYd)}+` : `${Math.round(hz.frontYd)}–${Math.round(hz.backYd)}`);

// Bunkers and water near the line of play (compass heading aimDeg from the ball), each
// with its front and back in yards along the line, and those points: the course's own
// bunkers and water, and the lakes around it that are in play (geo.sceneryWater with
// `played`, lib/course.js lakesInPlay); a pond beyond the boundary is no hazard.
// - Water the line itself crosses is a carry: where the line goes in and comes out
//   (onLine). A creek across the fairway reads 150–170, not its far corners. Water still
//   going at maxM is open: its back is unknown.
// - The rest, and every bunker, counts only inside a corridor that widens with
//   distance, from 35 m out to maxM along the line: the nearest and farthest of its edge
//   there. A pond that runs along the fairway splits where its shore leaves the corridor
//   for a while, so it reads as the stretch beside you, not one span from tee to green.
// Edges are sampled every few metres so a long straight shore still has points in the
// corridor. Nearest first.
export function hazardsAlong(geo, ball, aimDeg, { maxM = Infinity, step = 3 } = {}) {
  const a = aimDeg * DEG;
  const fx = Math.sin(a), fy = Math.cos(a);     // along the line
  const rx = Math.cos(a), ry = -Math.sin(a);    // to its right
  const onLine = (v) => [ball.x + fx * v, ball.y + fy * v];
  const out = [];
  const add = (hz) => {
    // the same pond can come twice when OpenStreetMap maps it twice
    if (!out.some((o) => o.kind === hz.kind && Math.abs(o.frontYd - hz.frontYd) < 3 && Math.abs(o.backYd - hz.backYd) < 3)) out.push(hz);
  };
  // one mark from edge samples: the nearest and farthest of them along the line
  const mark = (kind, pts) => {
    let f = pts[0], b = pts[0], uMin = Infinity, uMax = -Infinity, sx = 0, sy = 0;
    for (const p of pts) {
      if (p.v < f.v) f = p;
      if (p.v > b.v) b = p;
      uMin = Math.min(uMin, p.u); uMax = Math.max(uMax, p.u);
      sx += p.x; sy += p.y;
    }
    return {
      kind, frontYd: f.v / YD, backYd: b.v / YD, front: [f.x, f.y], back: [b.x, b.y],
      at: [sx / pts.length, sy / pts.length], uMin, uMax, side: uMin + uMax >= 0 ? 1 : -1,
    };
  };
  const lakes = (geo?.sceneryWater || []).filter((w) => w && w.played).map((w) => ({ kind: 'water', poly: w.poly }));
  for (const su of [...(geo?.surfaces || []), ...lakes]) {
    if ((su.kind !== 'bunker' && su.kind !== 'water') || !su.poly || su.poly.length < 3) continue;
    const water = su.kind === 'water';
    const carries = [];
    if (water) {
      for (const [v0, v1] of raySpans(su.poly, ball, fx, fy)) {
        if (v1 < 5 || v0 > maxM) continue;
        const f = v0, b = Math.min(v1, maxM);
        carries.push([f, b]);
        add({ kind: 'water', frontYd: f / YD, backYd: b / YD, front: onLine(f), back: onLine(b), at: onLine((f + b) / 2), uMin: 0, uMax: 0, side: 1, onLine: true, open: v1 > maxM });
      }
    }
    const pts = [];
    const P = su.poly;
    for (let i = 0; i < P.length; i++) {
      const [x0, y0] = P[i], [x1, y1] = P[(i + 1) % P.length];
      const k = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let j = 0; j < k; j++) {
        const x = x0 + ((x1 - x0) * j) / k, y = y0 + ((y1 - y0) * j) / k;
        const dx = x - ball.x, dy = y - ball.y;
        const v = dx * fx + dy * fy, u = dx * rx + dy * ry;
        if (v < 35 || v > maxM || Math.abs(u) > 24 + 0.09 * v) continue;
        if (carries.some(([v0, v1]) => v > v0 - 8 && v < v1 + 8)) continue;   // its banks there are the carry
        pts.push({ x, y, u, v });
      }
    }
    if (!pts.length) continue;
    if (!water) {
      const m = mark('bunker', pts);
      if (m.backYd - m.frontYd >= 2 / YD) add(m);
      continue;
    }
    pts.sort((p, q) => p.v - q.v);
    let run = [pts[0]];
    const flush = () => { const m = mark('water', run); if (m.backYd - m.frontYd >= 4 / YD) add(m); };
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].v - pts[i - 1].v > 20) { flush(); run = []; }
      run.push(pts[i]);
    }
    flush();
  }
  return out.sort((p, q) => p.frontYd - q.frontYd);
}

// Everything the lineup marks for one lie: the green's front and back, the hazards out
// to just past the pin, and the line they are measured along (frame). baseAimDeg is the
// default line of play.
export function yardageMarks(geo, { ball, pin, baseAimDeg, practice = false }) {
  if (!geo || !ball || !pin || practice) return { green: null, greenPoly: null, hazards: [], frame: null };
  const greenPoly = greenFor(geo, pin);
  const a = baseAimDeg * DEG;
  const pinV = (pin[0] - ball.x) * Math.sin(a) + (pin[1] - ball.y) * Math.cos(a);
  return {
    green: greenPoly ? greenFrontBack(ball, pin, greenPoly) : null,
    greenPoly,
    hazards: hazardsAlong(geo, ball, baseAimDeg, { maxM: pinV + 25 }),
    frame: { ball: { x: ball.x, y: ball.y }, aimDeg: baseAimDeg },
  };
}

// The hazards this shot can find, the only ones the 3D view tags and the map numbers:
// bunkers and water reaching into where it can come down and roll out (the prediction's
// landing and resting areas as drawn, at the spread chosen, spareM to spare), and water
// across the line short of there that a short one finds (within shortM). Water first,
// then nearest where the ball comes down; max at most. None for a putt or without a
// prediction.
export function hazardsInPlay(marks, pred, { max = 3, spareM = 5, shortM = 27 } = {}) {
  const list = marks?.hazards || [];
  if (!list.length || !marks.frame || !pred || pred.isPutt || !pred.land) return [];
  const { ball, aimDeg } = marks.frame;
  const a = aimDeg * DEG;
  const fx = Math.sin(a), fy = Math.cos(a), rx = Math.cos(a), ry = -Math.sin(a);
  // a point along the line (v) and to its right (u), in metres, as hazardsAlong measures
  const vu = (q) => { const dx = q.x - ball.x, dy = q.y - ball.y; return [dx * fx + dy * fy, dx * rx + dy * ry]; };
  const d = pred.dispersion || {};
  const area = [...(d.land?.length ? d.land : [pred.land]), ...(d.rest?.length ? d.rest : pred.rest ? [pred.rest] : [])];
  let v0 = Infinity, v1 = -Infinity, u0 = Infinity, u1 = -Infinity;
  for (const q of area) {
    const [v, u] = vu(q);
    v0 = Math.min(v0, v); v1 = Math.max(v1, v); u0 = Math.min(u0, u); u1 = Math.max(u1, u);
  }
  const front = (hz) => hz.frontYd * YD, back = (hz) => hz.backYd * YD;
  const inPlay = (hz) => front(hz) <= v1 + spareM && (hz.onLine
    ? back(hz) >= v0 - shortM
    : back(hz) >= v0 - spareM && hz.uMin <= u1 + spareM && hz.uMax >= u0 - spareM);
  const [lv, lu] = vu(pred.land);
  const gap = (hz) => Math.hypot(Math.max(0, front(hz) - lv, lv - back(hz)), hz.onLine ? 0 : Math.max(0, hz.uMin - lu, lu - hz.uMax));
  return list.filter(inPlay)
    .sort((p, q) => ((p.kind === 'water') !== (q.kind === 'water') ? (p.kind === 'water' ? -1 : 1) : gap(p) - gap(q)))
    .slice(0, max);
}

// how far from this hole's line a surface of each kind can be and still be this hole's
const FOCUS_LIMIT_M = { tee: 45, fairway: 70, rough: 70, bunker: 60, water: 80, green: 0, range: -1 };

// distance (m) from (x, y) to a polyline [[x, y], ...]
export function distToLine(x, y, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1], [bx, by] = line[i];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1);
    best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
  }
  return best;
}

// The surfaces of the hole being played, as a Set of geo.surfaces entries. line: this
// hole's line of play (null in practice: then everything near the ball-to-flag line);
// others: every other hole's line. A tee, bunker or patch of water is this hole's when
// it lies near this hole's line and no nearer another's; a fairway or rough, which can
// run alongside two holes in one outline, when most of its outline is; the green is
// the one the pin is on.
export function holeSurfaces(geo, { ball, pin, line = null, others = [] }) {
  const own = line && line.length > 1 ? line : [[ball.x, ball.y], pin];
  const green = greenFor(geo, pin);
  const out = new Set();
  for (const su of geo?.surfaces || []) {
    if (!su.poly || su.poly.length < 3) continue;
    if (su.kind === 'green') { if (su.poly === green) out.add(su); continue; }
    const limit = FOCUS_LIMIT_M[su.kind] ?? 60;
    if (limit < 0) continue;
    const ours = ([x, y]) => {
      const d = distToLine(x, y, own);
      if (d > limit) return false;
      for (const o of others) if (distToLine(x, y, o) < d - 2) return false;
      return true;
    };
    if (su.kind === 'fairway' || su.kind === 'rough') {
      const step = Math.max(1, Math.floor(su.poly.length / 40));
      let n = 0, k = 0;
      for (let i = 0; i < su.poly.length; i += step, n++) if (ours(su.poly[i])) k++;
      if (k / n >= 0.35) out.add(su);
    } else {
      let cx = 0, cy = 0;
      for (const [x, y] of su.poly) { cx += x; cy += y; }
      if (ours([cx / su.poly.length, cy / su.poly.length])) out.add(su);
    }
  }
  return out;
}

// An aim in a golfer's words: how far left or right of the pin the target sits at the
// distance the ball is played to (yd), e.g. { yd: 4, side: 'R', text: '4 yd R' }.
export function aimWords(offsetDeg, distYd) {
  const yd = Math.round(Math.abs(Math.tan((offsetDeg || 0) * Math.PI / 180) * (distYd || 0)));
  if (!yd) return { yd: 0, side: '', text: 'On the pin' };
  const side = offsetDeg > 0 ? 'R' : 'L';
  return { yd, side, text: `${yd} yd ${side}` };
}
