'use strict';
// Shot prediction for the lineup (lib/predict.js) on a synthetic hole: the same
// simulateShot path as a real shot, each condition's effect against the standard
// shot, the dispersion ellipses, the aim assist, carries club by club, putts — and
// the exact, faster surface lookup the predictions run on.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { simulateShot, YD } = require('../lib/physics');
const { Game, CLUB_FULL } = require('../lib/game');
const { physicsOptions, resolveConditions } = require('../lib/conditions');
const { Bag } = require('../lib/bag');
const { PredictError, cellSurfaceLookup, predictCarries, predictShot } = require('../lib/predict');

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const circle = (cx, cy, r, n = 24) => Array.from({ length: n }, (_, k) => [cx + r * Math.cos(2 * Math.PI * k / n), cy + r * Math.sin(2 * Math.PI * k / n)]);
const PIN = [0, 365];

// A 400 yd par 4 running north from (0, 0), falling `slope` m per 100 m, inside a
// course boundary (out of bounds 15 m beyond it), with `bunkers` extra bunkers off to
// the left so the surface lookup has a real course's polygon count; with `lakes`, a
// lake across the boundary (in play, past the outline too) and a pond well beyond it.
function lineupCourse({ slope = 0, bunkers = 0, boundary = true, lakes = false } = {}) {
  const surfaces = [
    { kind: 'tee', poly: rect(-4, -4, 4, 4) },
    { kind: 'fairway', poly: rect(-25, 40, 25, 330) },
    { kind: 'green', poly: circle(PIN[0], PIN[1], 16) },
    { kind: 'bunker', poly: circle(20, 345, 5) },
    { kind: 'water', poly: rect(45, 120, 90, 240) },
    { kind: 'rough', poly: rect(-60, 20, 60, 340) },     // never tested by the lookup
  ];
  for (let k = 0; k < bunkers; k++) surfaces.push({ kind: 'bunker', poly: circle(-190 + (k % 10) * 13, 10 + Math.floor(k / 10) * 14, 5) });
  const nx = 61, ny = 81, cellM = 10, minX = -300, minY = -150;
  const heights = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) heights.push(-slope * (minY + j * cellM) / 100 + 0.4 * Math.sin(i * 0.37) * Math.cos(j * 0.21));
  }
  return {
    name: 'Lineup Links',
    surfaces,
    boundary: boundary ? rect(-220, -60, 220, 470) : null,
    elevation: { minX, minY, cellM, nx, ny, heights },
    holes: [{ ref: 1, par: 4, tee: [0, 0], pin: PIN, lengthYd: 399, line: [[0, 0], PIN] }],
    ...(lakes ? { scenery: { water: [{ kind: 'water', poly: circle(200, 150, 45) }, { kind: 'water', poly: circle(-320, 300, 30) }] } } : {}),
  };
}

function lineupGame(options = {}) {
  const g = new Game();
  g.setCourse(lineupCourse(options));
  return g;
}

const typical = (club) => ({ speedMph: CLUB_FULL[club].speedMph, vla: CLUB_FULL[club].vla, hla: 0, totalSpin: CLUB_FULL[club].spin, spinAxis: 0 });
const r1 = (v) => Math.round(v * 10) / 10 || 0;
const r2 = (v) => Math.round(v * 100) / 100 || 0;
const direct = (g, launch, opts = {}) => simulateShot(launch, g.ball, g.aimDeg, g.surfaceAt, {
  terrain: g.terrain, pin: { x: g.hole.pin[0], y: g.hole.pin[1] }, trees: g.treeObstacles, ...physicsOptions(g.conditions), ...opts,
});

test('the cell lookup answers exactly as the course lookup, everywhere', () => {
  for (const options of [{ bunkers: 120 }, { bunkers: 40, boundary: false }, { bunkers: 40, lakes: true }]) {
    const g = lineupGame(options);
    const fast = cellSurfaceLookup(g.course, g.surfaceAt);
    assert.notEqual(fast, g.surfaceAt);
    let seed = 99;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let checked = 0;
    const same = (x, y) => { checked++; assert.equal(fast(x, y), g.surfaceAt(x, y), `(${x}, ${y})`); };
    for (let k = 0; k < 20000; k++) same(-500 + rnd() * 1000, -400 + rnd() * 1300);   // in, near and far out of bounds
    const lakes = g.course.scenery?.water || [];
    if (lakes.length) {   // the lake plays as water past the outline; the pond beyond it is out of bounds
      assert.equal(g.surfaceAt(240, 150), 'water');
      assert.equal(g.surfaceAt(-320, 300), 'ob');
    }
    for (const s of [...g.course.surfaces, ...lakes, { poly: g.course.boundary || [] }]) {
      for (const [x, y] of s.poly) for (let k = 0; k < 6; k++) same(x + (rnd() - 0.5) * 2, y + (rnd() - 0.5) * 2);
    }
    if (g.course.boundary) {   // across the out-of-bounds buffer, 15 m outside the boundary
      for (let d = 10; d <= 20; d += 0.25) { same(220 + d, 200); same(-30, -60 - d); }
    }
    for (let k = 0; k < 5; k++) same(0.37 + k, 41.2);   // a second look at a cell uses its stored answer
    assert.ok(checked > 20000);
    assert.equal(fast(NaN, 3), g.surfaceAt(NaN, 3));
  }
});

test('in standard conditions the prediction is the direct simulateShot of the same launch', () => {
  const g = lineupGame({ slope: 1.5, bunkers: 60 });
  for (const club of ['DR', 'I7', 'PW']) {
    const p = predictShot(g, { club });
    const d = direct(g, typical(club));
    assert.equal(p.club, club);
    assert.equal(p.source, 'typical');
    assert.deepEqual(p.launch, typical(club));
    assert.equal(p.carryYd, r1(d.carryYd), club);
    assert.equal(p.totalYd, r1(d.totalYd), club);
    assert.equal(p.offlineYd, r1(d.offlineYd), club);
    assert.equal(p.apexFt, r1(d.apexFt), club);
    assert.equal(p.flightTime, r2(d.flightTime), club);
    assert.deepEqual(p.land, { x: r2(d.land.x), y: r2(d.land.y), z: r2(d.land.z) });
    assert.deepEqual(p.rest, { x: r2(d.end.x), y: r2(d.end.y), z: r2(d.endZ) });
    assert.equal(p.restSurface, d.endSurface);
    assert.equal(p.elevationFt, r1((d.land.z - d.startZ) * 3.28084));
    // the path: flight then roll, from the ball to where it stops, at most 120 points
    assert.ok(p.path.length <= 120 && p.path.length > 20);
    assert.deepEqual(p.path[0], { x: r2(g.ball.x), y: r2(g.ball.y), z: r2(d.startZ), t: 0 });
    const last = d.points[d.points.length - 1];
    assert.deepEqual(p.path[p.path.length - 1], { x: r2(last.x), y: r2(last.y), z: r2(last.z), t: Math.round(last.t * 1000) / 1000 });
    for (let i = 1; i < p.path.length; i++) assert.ok(p.path[i].t > p.path[i - 1].t);
    // standard day: the standard shot is the shot, no condition has an effect
    assert.deepEqual(p.standard, { carryYd: p.carryYd, totalYd: p.totalYd, offlineYd: p.offlineYd, flightTime: p.flightTime, path: p.path });
    assert.deepEqual({ ...p.effects, elevationYd: 0 }, { windCarryYd: 0, windOfflineYd: 0, airCarryYd: 0, firmnessRollYd: 0, elevationYd: 0 });
    assert.ok(p.effects.elevationYd > 0, `downhill carries farther: ${p.effects.elevationYd}`);
  }
  // in any conditions it is the direct shot in the steady wind
  g.setConditions('gale');
  const p = predictShot(g, { club: 'I7' });
  const d = direct(g, typical('I7'));
  assert.equal(p.carryYd, r1(d.carryYd));
  assert.equal(p.totalYd, r1(d.totalYd));
});

test('each condition alone against the standard shot, and how far the pin plays', () => {
  const g = lineupGame();
  const calm = predictShot(g, { club: 'I7' });
  g.setConditions({ windMph: 15, windFromDeg: 0 });           // in the face on a north hole
  const head = predictShot(g, { club: 'I7' });
  assert.deepEqual(head.standard, calm.standard, 'the standard shot does not depend on the day');
  assert.ok(head.effects.windCarryYd < -8, `headwind ${head.effects.windCarryYd}`);
  assert.ok(head.playsLikeYd > calm.playsLikeYd + 10, `plays longer into the wind: ${head.playsLikeYd} vs ${calm.playsLikeYd}`);
  assert.equal(head.effects.airCarryYd, 0);
  g.setConditions({ preset: 'mile-high' });
  const high = predictShot(g, { club: 'I7' });
  assert.ok(high.effects.airCarryYd > 4 && high.playsLikeYd < calm.playsLikeYd, `${high.effects.airCarryYd} / ${high.playsLikeYd}`);
  g.setConditions({ firmness: 1 });
  assert.ok(predictShot(g, { club: 'I7' }).effects.firmnessRollYd > 1);
  g.setConditions({ firmness: 0 });
  assert.ok(predictShot(g, { club: 'I7' }).effects.firmnessRollYd < -1);
  // plays-like: the pin distance scaled by standard / current carry, plus the rise to the pin
  const hill = lineupGame({ slope: -2 });   // uphill to the green
  const up = predictShot(hill, { club: 'I7' });
  const rise = hill.terrain.h(...PIN) - hill.terrain.h(0, 0);
  assert.ok(rise > 5);
  assert.equal(up.playsLikeYd, r1(Math.hypot(PIN[0], PIN[1]) / YD * 1 + rise / YD));   // standard day: ratio 1
  assert.equal(up.pinElevationFt, r1(rise * 3.28084));
  assert.ok(up.effects.elevationYd < 0, 'uphill carries shorter');
});

test('aim assist puts the landing on the ball-to-pin line in a crosswind', () => {
  const g = lineupGame();
  g.setConditions({ windMph: 18, windFromDeg: 270 });   // from the west: the left, on a north hole
  const p = predictShot(g, { club: 'I7' });
  const lateral = (pt) => (pt.x - g.ball.x) / YD;       // the pin line runs north: x is the offline
  assert.ok(lateral(p.land) > 8, `the wind pushes it right: ${lateral(p.land)}`);
  assert.ok(p.effects.windOfflineYd > 8);
  assert.ok(p.aimAssist.offsetDeg < -2, `aim left: ${p.aimAssist.offsetDeg}`);
  assert.ok(Math.abs(p.aimAssist.landOfflineYd) <= 0.2, `${p.aimAssist.landOfflineYd}`);
  const aimed = predictShot(g, { club: 'I7', aimOffset: p.aimAssist.offsetDeg });
  assert.equal(aimed.aimOffset, p.aimAssist.offsetDeg);
  assert.ok(Math.abs(lateral(aimed.land)) < 0.3, `aimed landing ${lateral(aimed.land)} yd off the line`);
  assert.equal(g.aimOffset, 0, 'previewing an aim does not move the game\'s aim');
  assert.equal(predictShot(g, { club: 'I7', aimOffset: 99 }).aimOffset, 45);
});

test('dispersion: 16-point ~2-sigma ellipses around the landing and the resting spot', () => {
  const g = lineupGame();
  const dr = predictShot(g, { club: 'DR' });
  const pw = predictShot(g, { club: 'PW' });
  for (const p of [dr, pw]) {
    const d = p.dispersion;
    assert.equal(d.land.length, 16);
    assert.equal(d.rest.length, 16);
    assert.equal(d.sigma, 2);
    assert.ok(d.majorYd >= d.minorYd && d.minorYd > 0, `${d.majorYd} x ${d.minorYd}`);
    assert.ok(d.angleDeg >= 0 && d.angleDeg < 180);
    const cx = d.land.reduce((a, q) => a + q.x, 0) / 16, cy = d.land.reduce((a, q) => a + q.y, 0) / 16;
    assert.ok(Math.hypot(cx - p.land.x, cy - p.land.y) < 0.05, 'centred on the landing');
    // the outline's widest span is the major axis
    let span = 0;
    for (const a of d.land) for (const b of d.land) span = Math.max(span, Math.hypot(a.x - b.x, a.y - b.y));
    assert.ok(Math.abs(span / YD - d.majorYd) < 0.2, `${span / YD} vs ${d.majorYd}`);
  }
  assert.ok(dr.dispersion.majorYd > pw.dispersion.majorYd * 1.5, `${dr.dispersion.majorYd} vs ${pw.dispersion.majorYd}`);
  // a straight shot on a north hole spreads wider than long: the long axis runs east-west
  assert.ok(Math.abs(dr.dispersion.angleDeg - 90) < 30, `driver ellipse at ${dr.dispersion.angleDeg} deg`);
  // a tighter player has a tighter ellipse
  const bag = new Bag();
  for (let k = 0; k < 6; k++) bag.record('DR', { ...typical('DR'), speedMph: 152 + (k % 2), hla: (k % 3) * 0.2, spinAxis: (k % 2) * 0.5 });
  const tight = predictShot(g, { club: 'DR', bag });
  assert.equal(tight.source, 'player');
  assert.ok(tight.dispersion.majorYd < dr.dispersion.majorYd / 3);
  // gusts widen it
  g.setConditions({ windMph: 10, windFromDeg: 270 });
  const steady = predictShot(g, { club: 'I7' }).dispersion;
  g.setConditions({ windMph: 10, windFromDeg: 270, gustMph: 15 });
  const gusty = predictShot(g, { club: 'I7' }).dispersion;
  assert.ok(gusty.majorYd > steady.majorYd, `${gusty.majorYd} vs ${steady.majorYd}`);
});

test('carries fall club by club, and the club for the pin', () => {
  const g = lineupGame();
  const c = predictCarries(g);
  assert.deepEqual(c.clubs.map((x) => x.club), ['DR', 'W3', 'H3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'PW', 'SW', 'LW']);
  for (let i = 1; i < c.clubs.length; i++) {
    assert.ok(c.clubs[i].carryYd < c.clubs[i - 1].carryYd, `${c.clubs[i].club} ${c.clubs[i].carryYd} < ${c.clubs[i - 1].club} ${c.clubs[i - 1].carryYd}`);
  }
  assert.ok(c.clubs.every((x) => x.source === 'typical' && x.totalYd >= x.carryYd - 5));
  assert.equal(c.recommended, 'DR');
  assert.equal(c.lie, 'tee');
  const nearest = (list, key, yd) => list.reduce((a, b) => (Math.abs(b[key] - yd) < Math.abs(a[key] - yd) ? b : a)).club;
  g.ball = { x: 0, y: PIN[1] - 150 * YD };   // 150 yd out: by total
  const mid = predictCarries(g);
  assert.equal(mid.recommended, nearest(mid.clubs, 'totalYd', 150));
  g.ball = { x: 0, y: PIN[1] - 95 * YD };    // under 120 yd: by carry
  const short = predictCarries(g);
  assert.equal(short.recommended, nearest(short.clubs, 'carryYd', 95));
  assert.equal(predictShot(g, {}).club, short.recommended, 'no club picked: the recommended one');
  g.setSelectedClub('9i');
  assert.equal(predictShot(g, {}).club, 'I9', 'the picked club');
  // the player's speed scales every club
  const bag = new Bag();
  for (let k = 0; k < 3; k++) bag.record('I7', { ...typical('I7'), speedMph: 100 });
  g.ball = { x: 0, y: 0 };
  const slow = predictCarries(g, { bag });
  assert.equal(slow.clubs.find((x) => x.club === 'I7').source, 'player');
  assert.equal(slow.clubs.find((x) => x.club === 'DR').source, 'scaled');
  assert.ok(slow.clubs[0].carryYd < c.clubs[0].carryYd - 10);
});

test('inside the shortest full shot, a club is predicted as the partial swing that finishes at the pin', () => {
  const g = lineupGame();
  const near = { x: 0, y: PIN[1] - 45 * YD };   // 45 yd out, on the fairway
  g.ball = near;
  const fullLw = predictCarries(g).clubs.find((x) => x.club === 'LW');
  assert.ok(fullLw.carryYd > 60, `a full lob wedge carries ${fullLw.carryYd}`);
  const at45 = {};
  for (const club of ['LW', 'SW', 'I7']) {
    const p = at45[club] = predictShot(g, { club });
    assert.ok(p.partial, `${club}: a partial swing`);
    assert.ok(p.partial.share > 0.2 && p.partial.share < 0.95, `${club}: ${p.partial.share} of full speed`);
    const miss = Math.hypot(p.rest.x - PIN[0], p.rest.y - PIN[1]);
    assert.ok(p.holed || miss <= 0.6, `${club} stops ${miss.toFixed(2)} m from the pin`);
    assert.ok(p.carryYd < 47 && p.carryYd < p.partial.fullCarryYd);
    assert.ok(Math.abs(p.launch.speedMph - typical(club).speedMph * p.partial.share) < 1, 'the club\'s launch, slower');
    assert.ok(p.launch.totalSpin < typical(club).totalSpin && p.launch.vla === typical(club).vla);
  }
  assert.equal(at45.LW.partial.fullCarryYd, fullLw.carryYd, 'what a full one does, as the club bar has it');
  assert.ok(at45.I7.partial.share < at45.SW.partial.share && at45.SW.partial.share < at45.LW.partial.share);
  assert.ok(at45.I7.carryYd < at45.LW.carryYd, 'the 7-iron chips and runs, the lob wedge flies');
  // closer in, a smaller swing; its spread shrinks with it
  g.ball = { x: 0, y: PIN[1] - 20 * YD };
  const at20 = predictShot(g, { club: 'LW' });
  assert.ok(at20.partial.share < at45.LW.partial.share);
  assert.ok(at20.dispersion.majorYd < at45.LW.dispersion.majorYd);
  // past the lob wedge's full carry every club is swung in full, even one that flies the green
  g.ball = { x: 0, y: PIN[1] - 95 * YD };
  for (const club of ['LW', 'I7']) {
    const p = predictShot(g, { club });
    assert.equal(p.partial, null, club);
    assert.deepEqual(p.launch, { speedMph: typical(club).speedMph, vla: typical(club).vla, hla: 0, totalSpin: typical(club).totalSpin, spinAxis: 0 });
  }
  assert.ok(predictShot(g, { club: 'I7' }).carryYd > 120);
  g.ball = { x: 0, y: 0 };
  assert.equal(predictShot(g, { club: 'DR' }).partial, null);
});

test('putts: on the green the prediction is a putt at a pace to finish just past the hole', () => {
  const g = lineupGame();
  g.ball = { x: 1.5, y: PIN[1] - 9 };
  g.lie = 'green';
  const p = predictShot(g, { club: 'DR' });   // on the green it is a putt whatever is asked
  assert.equal(p.club, 'PT');
  assert.equal(p.isPutt, true);
  assert.equal(p.dispersion, null);
  assert.equal(p.carryYd, 0);
  assert.ok(p.launch.speedMph > 2 && p.launch.speedMph < 15);
  const miss = Math.hypot(p.rest.x - PIN[0], p.rest.y - PIN[1]);
  assert.ok(p.holed || miss < 1.5, `stops ${miss.toFixed(2)} m from the hole`);
  assert.ok(p.path.length > 10 && p.path.length <= 120);
  assert.ok(Math.abs(p.aimAssist.restOfflineYd) <= 0.1);
  assert.deepEqual([p.standard.carryYd, p.standard.flightTime], [0, 0]);
  assert.ok(p.standard.path.length > 10 && p.standard.path.length <= 120);
  assert.equal(predictShot(g, {}).club, 'PT');
  // a faster green: a softer stroke for the same putt
  g.setConditions({ greenStimp: 13 });
  const fast = predictShot(g, {});
  assert.ok(fast.launch.speedMph < p.launch.speedMph);
  assert.ok(fast.playsLikeYd < p.playsLikeYd);
});

test('practice: the prediction plays from the session\'s spot at its target', () => {
  const g = lineupGame();
  g.startPractice('range', { targetYd: 150 });
  const p = predictShot(g, { club: 'I7' });
  assert.deepEqual([p.path[0].x, p.path[0].y], [r2(g.practice.spot[0]), r2(g.practice.spot[1])]);
  assert.equal(p.distToPinYd, r1(Math.hypot(g.practice.target.x - g.practice.spot[0], g.practice.target.y - g.practice.spot[1]) / YD));
  // the putting challenge: a putt read from the session's spot drops into the real cup
  g.startPractice('putting', { random: () => 0 });
  const putt = predictShot(g, {});
  assert.equal(putt.isPutt, true);
  assert.deepEqual([putt.path[0].x, putt.path[0].y], [r2(g.practice.spot[0]), r2(g.practice.spot[1])]);
  assert.equal(putt.holed, true);
  // a practice green mapped under the range's spot: it still plays as a tee
  const mapped = lineupCourse();
  mapped.surfaces.unshift({ kind: 'green', poly: rect(-6, -6, 6, 6) });
  const range = new Game();
  range.setCourse(mapped);
  range.startPractice('range', { targetYd: 150 });
  assert.equal(range.surfaceAt(range.practice.spot[0], range.practice.spot[1]), 'green');
  const full = predictShot(range, { club: 'I7' });
  assert.equal(full.isPutt, false);
  assert.equal(full.lie, 'tee');
  assert.notEqual(predictCarries(range).recommended, 'PT');
});

test('errors: no course, not ready, an unknown club or aim, a finished hole', () => {
  const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof PredictError); return [e.code, e.status]; } return null; };
  assert.deepEqual(code(() => predictShot(new Game(), { club: 'I7' })), ['NO_COURSE', 409]);
  assert.deepEqual(code(() => predictCarries(new Game())), ['NO_COURSE', 409]);
  const g = lineupGame();
  g.runtimeReady = false;
  assert.deepEqual(code(() => predictShot(g, { club: 'I7' })), ['NOT_READY', 409]);
  g.runtimeReady = true;
  assert.deepEqual(code(() => predictShot(g, { club: 'BANANA' })), ['BAD_CLUB', 400]);
  assert.deepEqual(code(() => predictShot(g, { club: 'I7', aimOffset: 'left' })), ['BAD_AIM', 400]);
  g.holed = true;
  assert.deepEqual(code(() => predictShot(g, { club: 'I7' })), ['HOLE_DONE', 409]);
});

test('a prediction stays fast: a few dozen simulated shots in a few tens of milliseconds', (t) => {
  const g = lineupGame({ slope: 1, bunkers: 300 });
  const time = (fn) => {
    fn();
    const ms = [];
    for (let k = 0; k < 5; k++) { const a = performance.now(); fn(); ms.push(performance.now() - a); }
    return ms.sort((a, b) => a - b)[2];
  };
  const results = {};
  for (const preset of ['calm', 'gale']) {
    g.setConditions(resolveConditions(preset));
    for (const club of ['DR', 'I7']) results[`${preset} ${club}`] = time(() => predictShot(g, { club }));
  }
  results.carries = time(() => predictCarries(g));
  g.ball = { x: 2, y: PIN[1] - 10 };
  results.putt = time(() => predictShot(g, {}));
  t.diagnostic(Object.entries(results).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', '));
  for (const [k, v] of Object.entries(results)) assert.ok(v < 120, `${k}: ${v.toFixed(1)} ms`);
});
