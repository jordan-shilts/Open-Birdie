// Side-view flight panel + shot-marker maths (public/render/flight-profile.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pointAt, smoothPointAt, flightMarkers, shotProfile, profileUpTo, niceStep, sideViewScale, toPolyline, toAreaPolygon,
  M_TO_YD, M_TO_FT,
} from '../public/render/flight-profile.js';

// A symmetric parabola launched due north from (10, 20, 5): 200 m carry, 30 m apex at
// t = 2 s, lands at t = 4 s, then rolls 20 m along the ground to t = 5 s.
function sampleShot() {
  const pts = [];
  for (let t = 0; t <= 4.0001; t += 0.02) {
    const u = t / 4;
    pts.push({ t: +t.toFixed(2), x: 10, y: 20 + 200 * u, z: 5 + 120 * u * (1 - u) });
  }
  for (let t = 4.02; t <= 5.0001; t += 0.02) pts.push({ t: +t.toFixed(2), x: 10, y: 220 + 20 * (t - 4), z: 5 });
  return pts;
}

test('pointAt interpolates and clamps to the trajectory', () => {
  const pts = sampleShot();
  const mid = pointAt(pts, 2.01);
  assert.ok(Math.abs(mid.y - (20 + 200 * 2.01 / 4)) < 1e-6);
  assert.deepEqual(pointAt(pts, -1), pts[0]);
  assert.deepEqual(pointAt(pts, 99), pts[pts.length - 1]);
  assert.equal(pointAt([], 1), null);
});

test('smoothPointAt runs through the samples on a smooth curve in the air, straight on the ground', () => {
  const pts = sampleShot();
  // through every sample exactly
  for (const p of pts.slice(2, -3)) {
    const q = smoothPointAt(pts, p.t, 4);
    assert.ok(Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < 1e-9, `t=${p.t}`);
  }
  // between them it follows the true parabola, far closer than the straight line does
  const t = 1.01, u = t / 4, trueZ = 5 + 120 * u * (1 - u);
  const lin = Math.abs(pointAt(pts, t).z - trueZ), cub = Math.abs(smoothPointAt(pts, t, 4).z - trueZ);
  assert.ok(cub < lin / 20, `cubic ${cub} vs linear ${lin}`);
  // on the ground (past flightTime) it is the straight line between samples: a bounce
  // stays a corner instead of dipping through the turf
  assert.deepEqual(smoothPointAt(pts, 4.51, 4), pointAt(pts, 4.51));
  // and it clamps like pointAt
  assert.deepEqual(smoothPointAt(pts, -1, 4), pts[0]);
});

test('flightMarkers finds the apex in the air phase and the landing at flightTime', () => {
  const pts = sampleShot();
  const { apex, landing } = flightMarkers(pts, 4);
  assert.ok(Math.abs(apex.t - 2) < 0.021);
  assert.ok(Math.abs(apex.z - 35) < 0.01);
  assert.ok(Math.abs(landing.y - 220) < 1e-6);
  assert.ok(Math.abs(landing.z - 5) < 1e-6);
  // without flightTime: end of descent (first non-decreasing step after the apex)
  const est = flightMarkers(pts);
  assert.ok(Math.abs(est.landing.y - 220) < 1.1);
});

test('shotProfile converts to yards along the ground and feet above the start', () => {
  const prof = shotProfile(sampleShot(), { flightTime: 4 });
  assert.ok(Math.abs(prof.apex.h - 30 * M_TO_FT) < 0.05);       // 98.4 ft
  assert.ok(Math.abs(prof.landing.d - 200 * M_TO_YD) < 1e-6);   // 218.7 yd carry
  assert.ok(Math.abs(prof.maxD - 220 * M_TO_YD) < 0.05);        // includes the roll
  assert.ok(Math.abs(prof.minH) < 1e-6);
  assert.ok(Math.abs(prof.endT - 5) < 1e-6);
});

test('shotProfile keeps a downhill landing below the baseline', () => {
  const pts = [{ t: 0, x: 0, y: 0, z: 10 }, { t: 1, x: 0, y: 50, z: 25 }, { t: 2, x: 0, y: 100, z: 4 }];
  const prof = shotProfile(pts, { flightTime: 2 });
  assert.ok(prof.minH < 0);
  assert.ok(Math.abs(prof.landing.h - (-6 * M_TO_FT)) < 1e-6);
});

test('profileUpTo grows smoothly with an interpolated head and never overshoots', () => {
  const prof = shotProfile(sampleShot(), { flightTime: 4 });
  const part = profileUpTo(prof, 1.005);
  const head = part[part.length - 1];
  assert.equal(head.t, 1.005);
  assert.ok(part.slice(0, -1).every((p) => p.t <= 1.005));
  assert.equal(profileUpTo(prof, 0).length, 1);
  assert.equal(profileUpTo(prof, Infinity).length, prof.pts.length);
});

test('niceStep picks 1-2-2.5-5 steps within the tick budget', () => {
  assert.equal(niceStep(300, 6), 50);
  assert.equal(niceStep(120, 4), 50);
  assert.equal(niceStep(98, 4), 25);
  assert.equal(niceStep(9, 6), 2);
  assert.equal(niceStep(0), 10);
});

test('sideViewScale spans every profile, maps the origin to the plot corner, and has grid ticks', () => {
  const a = shotProfile(sampleShot(), { flightTime: 4 });
  const b = shotProfile([{ t: 0, x: 0, y: 0, z: 0 }, { t: 1, x: 0, y: 60, z: 40 }, { t: 2, x: 0, y: 120, z: 0 }], { flightTime: 2 });
  const sc = sideViewScale([a, b], { width: 360, height: 150, ml: 30, mr: 12, mt: 16, mb: 20 });
  assert.ok(sc.maxD >= a.maxD && sc.maxH >= b.maxH);
  assert.equal(sc.sx(0), 30);
  assert.equal(sc.sx(sc.maxD), 348);
  assert.equal(sc.sy(sc.maxH), 16);
  assert.equal(sc.sy(sc.minH), 130);
  assert.equal(sc.dTicks[0], 0);
  assert.equal(sc.dTicks.at(-1), sc.maxD);
  assert.ok(sc.hTicks.includes(0));
  // a putt-sized profile still gets a sane minimum frame
  const tiny = sideViewScale([], {});
  assert.ok(tiny.maxD >= 50 && tiny.maxH >= 30);
});

test('polyline + area polygon serialise in plot pixels', () => {
  const sc = sideViewScale([], { width: 100, height: 100, ml: 0, mr: 0, mt: 0, mb: 0, minDistYd: 100, minHeightFt: 100 });
  const pts = [{ d: 0, h: 0 }, { d: 50, h: 50 }];
  assert.equal(toPolyline(pts, sc), `0.0,${sc.sy(0).toFixed(1)} 50.0,${sc.sy(50).toFixed(1)}`);
  assert.ok(toAreaPolygon(pts, sc).endsWith(`50.0,${sc.sy(0).toFixed(1)} 0.0,${sc.sy(0).toFixed(1)}`));
  assert.equal(toAreaPolygon([], sc), '');
});
