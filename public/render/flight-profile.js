// Shot-trajectory maths shared by the 3D shot presentation (apex / landing markers)
// and the HUD side-view flight panel. Pure — no DOM, no three — unit-tested in
// test/flight-profile.test.mjs.
//
// Input is the server's `shot.sim.points`: [{ t (s), x (m east), y (m north),
// z (m, absolute terrain-frame height) }], sampled every ~20 ms through flight AND
// the bounce/roll that follows, plus `sim.flightTime` (s at first ground contact).

export const M_TO_YD = 1 / 0.9144;
export const M_TO_FT = 3.28084;

const lerp = (a, b, f) => a + (b - a) * f;

// Interpolate a sim point at time t (clamped to the trajectory).
export function pointAt(points, t) {
  if (!points || !points.length) return null;
  if (t <= points[0].t) return { ...points[0] };
  const last = points[points.length - 1];
  if (t >= last.t) return { ...last };
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const f = (t - a.t) / Math.max(1e-9, b.t - a.t);
  return { t, x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f) };
}

// The same, smooth: in the air, a cubic (Hermite) through the samples with tangents from
// their neighbours, so the ball's path and speed carry on smoothly from one 20 ms sample
// to the next instead of turning a corner at each; on the ground (after airEnd, where
// bounces are real corners) and across an uneven gap (a deflection kept crisp), the
// straight line between samples.
export function smoothPointAt(points, t, airEnd = Infinity) {
  if (!points || points.length < 4) return pointAt(points, t);
  const last = points[points.length - 1];
  if (t <= points[0].t || t >= last.t) return pointAt(points, t);
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  if (lo < 1 || hi > points.length - 2) return pointAt(points, t);
  const p0 = points[lo - 1], p1 = points[lo], p2 = points[hi], p3 = points[hi + 1];
  const h = p2.t - p1.t;
  if (p3.t > airEnd || !(h > 1e-6)) return pointAt(points, t);
  // a gap much shorter or longer than its neighbours: an event sample, leave it straight
  const even = (a, b) => b > 1e-6 && Math.abs(a - b) <= 0.35 * Math.max(a, b);
  if (!even(h, p1.t - p0.t) || !even(h, p3.t - p2.t)) return pointAt(points, t);
  const s = (t - p1.t) / h, s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const m = (k) => {
    const m1 = (p2[k] - p0[k]) / (p2.t - p0.t), m2 = (p3[k] - p1[k]) / (p3.t - p1.t);
    return h00 * p1[k] + h10 * h * m1 + h01 * p2[k] + h11 * h * m2;
  };
  return { t, x: m('x'), y: m('y'), z: m('z') };
}

// Apex (highest point of the AIR phase) and landing (first ground contact) in sim
// coordinates. flightTime is optional; without it the landing is the end of the
// descent (the first local minimum after the apex), falling back to the last point.
export function flightMarkers(points, flightTime = null) {
  if (!points || points.length < 2) return { apex: null, landing: null };
  const airEnd = Number.isFinite(flightTime) && flightTime > 0 ? flightTime : points[points.length - 1].t;
  let apex = points[0];
  for (const p of points) {
    if (p.t > airEnd) break;
    if (p.z > apex.z) apex = p;
  }
  let landing;
  if (Number.isFinite(flightTime) && flightTime > 0) {
    landing = pointAt(points, flightTime);
  } else {
    landing = points[points.length - 1];
    for (let i = points.indexOf(apex) + 1; i < points.length - 1; i++) {
      if (points[i + 1].z >= points[i].z) { landing = points[i]; break; }
    }
  }
  return { apex: { ...apex }, landing: { ...landing } };
}

// Side-view profile: horizontal distance from the start (yd) vs height above the
// start (ft), one entry per sim point. Heights may go negative (downhill landing).
export function shotProfile(points, { flightTime = null } = {}) {
  if (!points || !points.length) return null;
  const o = points[0];
  const pts = points.map((p) => ({
    t: p.t,
    d: Math.hypot(p.x - o.x, p.y - o.y) * M_TO_YD,
    h: (p.z - o.z) * M_TO_FT,
  }));
  const toProf = (p) => (p ? {
    t: p.t, d: Math.hypot(p.x - o.x, p.y - o.y) * M_TO_YD, h: (p.z - o.z) * M_TO_FT,
  } : null);
  const { apex, landing } = flightMarkers(points, flightTime);
  let maxD = 0, maxH = 0, minH = 0;
  for (const p of pts) {
    if (p.d > maxD) maxD = p.d;
    if (p.h > maxH) maxH = p.h;
    if (p.h < minH) minH = p.h;
  }
  return {
    pts,
    apex: toProf(apex),
    landing: toProf(landing),
    endT: pts[pts.length - 1].t,
    maxD, maxH, minH,
  };
}

// The part of a profile drawn by time t (sim seconds), ending exactly at t with an
// interpolated head so the line grows smoothly between 20 ms samples.
export function profileUpTo(profile, t) {
  if (!profile || !profile.pts.length) return [];
  const pts = profile.pts;
  if (!Number.isFinite(t) || t >= profile.endT) return pts.slice();
  if (t <= pts[0].t) return [pts[0]];
  const out = [];
  let i = 0;
  for (; i < pts.length && pts[i].t <= t; i++) out.push(pts[i]);
  if (i < pts.length) {
    const a = pts[i - 1], b = pts[i];
    const f = (t - a.t) / Math.max(1e-9, b.t - a.t);
    out.push({ t, d: lerp(a.d, b.d, f), h: lerp(a.h, b.h, f) });
  }
  return out;
}

// A "nice" grid step (1-2-2.5-5 x 10^n) giving at most maxTicks intervals over span.
export function niceStep(span, maxTicks = 6) {
  if (!(span > 0)) return 10;
  const raw = span / Math.max(1, maxTicks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * mag >= raw) return m * mag;
  }
  return 10 * mag;
}

// Axis scale for one or more profiles (the live shot + earlier ghosts) inside a
// width x height box with margins. Distance axis starts at 0, height axis covers
// [min(0,minH) .. maxH] rounded out to the grid step. Returns pixel mappers.
export function sideViewScale(profiles, {
  width = 360, height = 160, ml = 30, mr = 10, mt = 14, mb = 20,
  minDistYd = 50, minHeightFt = 30,
} = {}) {
  let maxD = minDistYd, maxH = minHeightFt, minH = 0;
  for (const p of profiles || []) {
    if (!p) continue;
    maxD = Math.max(maxD, p.maxD);
    maxH = Math.max(maxH, p.maxH);
    minH = Math.min(minH, p.minH);
  }
  const dStep = niceStep(maxD, 6);
  const hStep = niceStep(maxH - minH, 4);
  maxD = Math.ceil(maxD / dStep) * dStep;
  maxH = Math.ceil((maxH * 1.08) / hStep) * hStep; // headroom for the apex label
  minH = Math.floor(minH / hStep) * hStep;
  const plotW = width - ml - mr, plotH = height - mt - mb;
  const sx = (d) => ml + (d / maxD) * plotW;
  const sy = (h) => mt + (1 - (h - minH) / (maxH - minH)) * plotH;
  const dTicks = [], hTicks = [];
  for (let d = 0; d <= maxD + 1e-6; d += dStep) dTicks.push(Number(d.toFixed(6)));
  for (let h = minH; h <= maxH + 1e-6; h += hStep) hTicks.push(Number(h.toFixed(6)));
  return { width, height, ml, mr, mt, mb, maxD, maxH, minH, dStep, hStep, sx, sy, dTicks, hTicks };
}

// SVG polyline "x,y x,y ..." for profile points under a scale.
export function toPolyline(pts, scale) {
  return pts.map((p) => `${scale.sx(p.d).toFixed(1)},${scale.sy(p.h).toFixed(1)}`).join(' ');
}

// Closed SVG polygon for the soft area under the drawn line (down to the h=0 baseline).
export function toAreaPolygon(pts, scale) {
  if (!pts.length) return '';
  const base = scale.sy(Math.max(scale.minH, 0));
  const first = pts[0], last = pts[pts.length - 1];
  return `${toPolyline(pts, scale)} ${scale.sx(last.d).toFixed(1)},${base.toFixed(1)} ${scale.sx(first.d).toFixed(1)},${base.toFixed(1)}`;
}
