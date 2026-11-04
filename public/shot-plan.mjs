// The shots to the green, planned the way a GPS card lays out a hole: this shot to where
// it is predicted to stop (the target), then, on a par 4 or 5 whose pin is out of reach
// from there, a lay-up down the hole's line of play that leaves a full wedge in, then the
// pin. Each leg carries its length for the overhead map's bubbles (aim-map.js). The
// player can drag the lay-up somewhere else; the plan then runs through it. Pure (no
// DOM, no three): unit-tested (test/shot-plan.test.mjs).
//
// Sim coordinates: metres, x east, y north.
import { pointInPoly, holeSurfaces } from './yardages.mjs';

const YD = 0.9144;

export const PLAN = Object.freeze({
  reachYd: 230,     // how far a lay-up goes without the player's numbers (a 3 wood)
  leaveYd: 100,     // ... and the wedge it leaves in
  minLegYd: 15,     // a leg shorter than this isn't drawn as one
  sideM: [4, 8, 12, 16, 20, 25, 30],   // looking for fairway either side of the line
  backStepM: 5,     // and backing off sand and water, toward the shot, this far a step
  maxBackM: 40,
});

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// From the player's clubs today (/api/carries: [{ club, totalYd }]): how far a lay-up can
// go (the longest club but the driver) and the full wedge it should leave (the pitching
// wedge), in yards.
export function planClubs(carries) {
  const total = (key) => {
    const c = Array.isArray(carries) ? carries.find((x) => x && x.club === key) : null;
    return c && c.totalYd > 0 ? c.totalYd : null;
  };
  const reach = ['W3', 'H3', 'I4', 'I5'].map(total).find((v) => v != null) ?? PLAN.reachYd;
  const leave = total('PW') ?? PLAN.leaveYd;
  return { reachYd: reach, leaveYd: Math.min(leave, reach) };
}

// The line of play from `from` on: from its nearest point on the hole's line to the end,
// then the pin; with no line, straight at the pin. [{x, y}]
export function playPath(line, from, pin) {
  if (!Array.isArray(line) || line.length < 2) return [{ ...from }, { ...pin }];
  let best = Infinity, at = null, seg = 0;
  for (let i = 1; i < line.length; i++) {
    const ax = line[i - 1][0], ay = line[i - 1][1], dx = line[i][0] - ax, dy = line[i][1] - ay;
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((from.x - ax) * dx + (from.y - ay) * dy) / L2));
    const p = { x: ax + dx * t, y: ay + dy * t };
    const d = dist(p, from);
    if (d < best) { best = d; at = p; seg = i; }
  }
  const out = [at];
  for (let i = seg; i < line.length; i++) out.push({ x: line[i][0], y: line[i][1] });
  if (dist(out[out.length - 1], pin) > 1) out.push({ ...pin });
  return out;
}

// The first point on the path at straight-line distance r from c, with the path's heading
// there ({ x, y, dx, dy }), or null when the whole path lies within r of c.
export function pointOut(path, c, r) {
  for (let i = 1; i < path.length; i++) {
    const A = path[i - 1], B = path[i];
    const dx = B.x - A.x, dy = B.y - A.y, a = dx * dx + dy * dy;
    if (a < 1e-9) continue;
    const mx = A.x - c.x, my = A.y - c.y;
    const b = mx * dx + my * dy, cc = mx * mx + my * my - r * r;
    const disc = b * b - a * cc;
    if (disc < 0) continue;
    const u = (-b + Math.sqrt(disc)) / a;   // where the segment leaves the circle
    if (u < 0 || u > 1) continue;
    const L = Math.sqrt(a);
    return { x: A.x + dx * u, y: A.y + dy * u, dx: dx / L, dy: dy / L };
  }
  return null;
}

// Where to lay up: about `distM` from `from` along the line of play, on this hole's
// fairway when there is fairway a few steps either side, and out of its sand and water
// (backing off toward the shot). { x, y } or null.
export function layupSpot({ from, pin, distM, line = null, geo = null, ball = from, others = [] }) {
  const path = playPath(line, from, pin);
  const first = pointOut(path, from, distM);
  if (!first) return null;
  const surf = geo ? holeSurfaces(geo, { ball, pin: [pin.x, pin.y], line, others }) : new Set();
  const fairways = [], hazards = [];
  for (const s of surf) {
    if (s.kind === 'fairway') fairways.push(s.poly);
    else if (s.kind === 'bunker' || s.kind === 'water') hazards.push(s.poly);
  }
  const inAny = (p, polys) => polys.some((poly) => pointInPoly(p.x, p.y, poly));
  const onFairway = (p) => {
    if (!fairways.length || inAny(p, fairways)) return p;
    for (const m of PLAN.sideM) {
      for (const side of [1, -1]) {
        const q = { x: p.x + p.dy * m * side, y: p.y - p.dx * m * side, dx: p.dx, dy: p.dy };
        if (inAny(q, fairways) && !inAny(q, hazards)) return q;
      }
    }
    return p;
  };
  for (let back = 0; back <= PLAN.maxBackM; back += PLAN.backStepM) {
    const p = back ? pointOut(path, from, distM - back) : first;
    if (!p) continue;
    const q = onFairway(p);
    if (!inAny(q, hazards)) return { x: q.x, y: q.y };
  }
  return { x: first.x, y: first.y };
}

// ball {x, y}; pin [x, y]; par; rest {x, y}: where this shot is predicted to stop (the
// target); carries: /api/carries clubs; line: the hole's line of play [[x, y]] (tee to
// green) or null; others: the other holes' lines; geo: the course (its fairways and
// hazards); layup: a lay-up the player dragged ({x, y}) or null.
// -> { targets: [{ x, y, kind: 'shot' | 'layup', manual? }], legs: [{ from, to, yd }], pin }
export function shotPlan({ ball, pin, par, rest, carries = null, line = null, others = [], geo = null, layup = null }) {
  if (!ball || !pin || !rest) return null;
  const P = { x: pin[0], y: pin[1] };
  const targets = [{ x: rest.x, y: rest.y, kind: 'shot' }];
  if (par >= 4) {
    const leftYd = dist(rest, P) / YD;
    let lay = null;
    // the player's own lay-up, while it still lies between this shot and the pin
    if (layup) {
      const vx = P.x - rest.x, vy = P.y - rest.y, L2 = vx * vx + vy * vy || 1;
      const t = ((layup.x - rest.x) * vx + (layup.y - rest.y) * vy) / L2;
      const room = PLAN.minLegYd * YD;
      if (t > 0 && t < 1 && dist(rest, layup) >= room && dist(layup, P) >= room) {
        lay = { x: layup.x, y: layup.y, kind: 'layup', manual: true };
      }
    }
    const { reachYd, leaveYd } = planClubs(carries);
    if (!lay && leftYd > reachYd + 5) {
      const goYd = Math.min(reachYd, leftYd - leaveYd);
      const spot = goYd >= PLAN.minLegYd ? layupSpot({ from: rest, pin: P, distM: goYd * YD, line, geo, ball, others }) : null;
      if (spot) lay = { ...spot, kind: 'layup' };
    }
    if (lay) targets.push(lay);
  }
  const pts = [ball, ...targets, P];
  const legs = [];
  for (let i = 1; i < pts.length; i++) {
    const yd = dist(pts[i - 1], pts[i]) / YD;
    if (i === pts.length - 1 && yd < PLAN.minLegYd) break;   // the last leg, when it's a tap-in
    legs.push({ from: { x: pts[i - 1].x, y: pts[i - 1].y }, to: { x: pts[i].x, y: pts[i].y }, yd });
  }
  return { targets, legs, pin: P };
}
