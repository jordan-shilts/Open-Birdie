import test from 'node:test';
import assert from 'node:assert/strict';
import { aimWords, greenFor, greenFrontBack, hazardsAlong, hazardsInPlay, hazardText, holeSurfaces, yardageMarks, pointInPoly } from '../public/yardages.mjs';

const YD = 0.9144;
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('point in polygon', () => {
  const sq = rect(0, 0, 10, 10);
  assert.equal(pointInPoly(5, 5, sq), true);
  assert.equal(pointInPoly(15, 5, sq), false);
});

test('the green under the pin, or the nearest one when the pin is on the collar', () => {
  const g1 = rect(-10, 90, 10, 110), g2 = rect(200, 0, 220, 20);
  const geo = { surfaces: [{ kind: 'green', poly: g2 }, { kind: 'bunker', poly: rect(-5, 80, 5, 85) }, { kind: 'green', poly: g1 }] };
  assert.equal(greenFor(geo, [0, 100]), g1);
  assert.equal(greenFor(geo, [0, 118]), g1);       // 8 m past the back edge
  assert.equal(greenFor(geo, [0, 140]), null);     // nowhere near a green
});

test('front and back of the green on the line through the pin', () => {
  const green = rect(-10, 90, 10, 110);
  const fb = greenFrontBack({ x: 0, y: 0 }, [0, 100], green);
  near(fb.frontYd, 90 / YD); near(fb.backYd, 110 / YD);
  assert.deepEqual(fb.front.map(Math.round), [0, 90]);
  assert.deepEqual(fb.back.map(Math.round), [0, 110]);
  // from wide of the green the line crosses it on the diagonal: (6, 90) in, (-6, 110) out
  const wide = greenFrontBack({ x: 60, y: 0 }, [0, 100], green);
  near(wide.frontYd, Math.hypot(54, 90) / YD); near(wide.backYd, Math.hypot(66, 110) / YD);
  assert.equal(greenFrontBack({ x: 0, y: 100 }, [3, 104], green), null);   // on the green
});

test('a pin off the green still gets the green\'s nearest and farthest edge', () => {
  const fb = greenFrontBack({ x: 0, y: 0 }, [14, 100], rect(-10, 90, 10, 110));   // the line passes beside it
  near(fb.frontYd, Math.hypot(10, 90) / YD);
  near(fb.backYd, Math.hypot(10, 110) / YD);
});

test('bunkers and water near the line get their front and back along it', () => {
  const geo = {
    surfaces: [
      { kind: 'bunker', poly: rect(10, 200, 20, 215) },     // right of the line, 200-215 m out
      { kind: 'bunker', poly: rect(-80, 100, -60, 110) },   // well wide of the corridor
      { kind: 'bunker', poly: rect(-5, -30, 5, -20) },      // behind the ball
      { kind: 'water', poly: rect(-100, 150, 100, 170) },   // a creek across the fairway
      { kind: 'water', poly: rect(-100, 150, 100, 170) },   // ...mapped twice
      { kind: 'fairway', poly: rect(-30, 0, 30, 300) },
    ],
  };
  const list = hazardsAlong(geo, { x: 0, y: 0 }, 0);
  assert.equal(list.length, 2);
  const [creek, bunker] = list;
  assert.equal(creek.kind, 'water');
  assert.equal(creek.onLine, true);
  near(creek.frontYd, 150 / YD); near(creek.backYd, 170 / YD);   // its carry on this line, not its far corners
  assert.equal(bunker.kind, 'bunker');
  near(bunker.frontYd, 200 / YD); near(bunker.backYd, 215 / YD);
  assert.equal(bunker.side, 1);
  assert.equal(hazardsAlong(geo, { x: 0, y: 0 }, 0, { maxM: 180 }).length, 1);   // the bunker is past the cut-off
});

test('a lake the tee shot crosses and then runs beside the fairway: the carry, then the stretch alongside', () => {
  // water from 40 to 140 m across the line, then a strip down the right side to 350 m
  const lake = [[-60, 40], [100, 40], [100, 350], [20, 350], [20, 140], [-60, 140]];
  const list = hazardsAlong({ surfaces: [{ kind: 'water', poly: lake }] }, { x: 0, y: 0 }, 0);
  assert.equal(list.length, 2);
  const [carry, beside] = list;
  assert.equal(carry.onLine, true);
  near(carry.frontYd, 40 / YD); near(carry.backYd, 140 / YD);
  assert.ok(!beside.onLine);
  assert.equal(beside.side, 1);
  assert.ok(beside.frontYd > 147 / YD && beside.frontYd < 152 / YD, `${beside.frontYd}`);
  near(beside.backYd, 350 / YD);
});

test('lakes around the course that are in play are marked like the course\'s own water', () => {
  // a lake the line crosses: its carry
  const [carry] = hazardsAlong({ sceneryWater: [{ kind: 'water', poly: rect(-50, 150, 50, 170), played: true }] }, { x: 0, y: 0 }, 0);
  assert.equal(carry.kind, 'water');
  assert.equal(carry.onLine, true);
  near(carry.frontYd, 150 / YD); near(carry.backYd, 170 / YD);
  // one beside the fairway: the stretch beside the line
  const [beside] = hazardsAlong({ sceneryWater: [{ kind: 'water', poly: rect(30, 100, 120, 200), played: true }] }, { x: 0, y: 0 }, 0);
  assert.equal(beside.kind, 'water');
  assert.ok(!beside.onLine && beside.side === 1);
  // a pond beyond the course boundary is drawn, not played: no hazard
  assert.deepEqual(hazardsAlong({ sceneryWater: [{ kind: 'water', poly: rect(-50, 150, 50, 170) }] }, { x: 0, y: 0 }, 0), []);
});

test('water still going at the cut-off is open-ended: "400+"', () => {
  const [hz] = hazardsAlong({ surfaces: [{ kind: 'water', poly: rect(-50, 330, 50, 500) }] }, { x: 0, y: 0 }, 0, { maxM: 345 });
  assert.equal(hz.open, true);
  assert.equal(hazardText(hz), `${Math.round(330 / YD)}+`);
  assert.equal(hazardText({ frontYd: 150.4, backYd: 169.6 }), '150–170');
});

test('the line of play turns the corridor with it', () => {
  // playing east: south of the line is to the golfer's right
  const geo = { surfaces: [{ kind: 'bunker', poly: rect(200, -20, 215, -10) }] };
  const [hz] = hazardsAlong(geo, { x: 0, y: 0 }, 90);
  near(hz.frontYd, 200 / YD); near(hz.backYd, 215 / YD);
  assert.equal(hz.side, 1);
});

test('one lie\'s marks: the green and the hazards out to just past the pin', () => {
  const geo = {
    surfaces: [
      { kind: 'green', poly: rect(-10, 290, 10, 310) },
      { kind: 'bunker', poly: rect(12, 285, 20, 300) },     // greenside
      { kind: 'bunker', poly: rect(-6, 400, 6, 410) },      // far past the green
    ],
  };
  const m = yardageMarks(geo, { ball: { x: 0, y: 0 }, pin: [0, 300], baseAimDeg: 0 });
  near(m.green.frontYd, 290 / YD); near(m.green.backYd, 310 / YD);
  assert.equal(m.hazards.length, 1);
  assert.deepEqual(yardageMarks(geo, { ball: { x: 0, y: 0 }, pin: [0, 300], baseAimDeg: 0, practice: true }).hazards, []);
});

test('numbers only for the hazards this shot can finish in: water a short one finds, then nearest where it lands, three at most', () => {
  // the line runs north; the shot comes down 200 m out and stops at 215
  const geo = {
    surfaces: [
      { kind: 'green', poly: rect(-12, 225, 12, 250) },
      { kind: 'water', poly: rect(-60, 160, 60, 172) },    // across the line just short: a short one finds it
      { kind: 'water', poly: rect(-60, 100, 60, 108) },    // across the line well short: carried
      { kind: 'bunker', poly: rect(8, 195, 18, 205) },     // right of where it lands
      { kind: 'bunker', poly: rect(-16, 188, -9, 196) },   // left of where it lands
      { kind: 'bunker', poly: rect(-20, 226, -12, 234) },  // left and long, by the green
      { kind: 'bunker', poly: rect(-6, 120, 6, 130) },     // on the line, 70 m short: carried
      { kind: 'bunker', poly: rect(30, 200, 40, 210) },    // well right of where it can finish
      { kind: 'bunker', poly: rect(-4, 250, 4, 258) },     // past where it can stop
    ],
  };
  const marks = yardageMarks(geo, { ball: { x: 0, y: 0 }, pin: [0, 240], baseAimDeg: 0 });
  assert.equal(marks.hazards.length, 8);
  const ellipse = (cx, cy, rx, ry) => Array.from({ length: 16 }, (_, i) => ({ x: cx + rx * Math.cos(i * Math.PI / 8), y: cy + ry * Math.sin(i * Math.PI / 8) }));
  const pred = { land: { x: 0, y: 200 }, rest: { x: 0, y: 215 }, dispersion: { land: ellipse(0, 200, 12, 15), rest: ellipse(0, 215, 10, 10) } };
  const at = (list) => list.map((hz) => `${hz.kind} ${Math.round(hz.frontYd * YD)}`);
  assert.deepEqual(at(hazardsInPlay(marks, pred, { max: 10 })), ['water 160', 'bunker 195', 'bunker 188', 'bunker 226']);
  assert.deepEqual(at(hazardsInPlay(marks, pred)), ['water 160', 'bunker 195', 'bunker 188']);
  // at the tight spread the long one by the green is out of reach
  const half = (pts, c) => pts.map((q) => ({ x: c.x + (q.x - c.x) / 2, y: c.y + (q.y - c.y) / 2 }));
  const tight = { ...pred, dispersion: { land: half(pred.dispersion.land, pred.land), rest: half(pred.dispersion.rest, pred.rest) } };
  assert.deepEqual(at(hazardsInPlay(marks, tight, { max: 10 })), ['water 160', 'bunker 195', 'bunker 188']);
  // aimed away from the line (round a dogleg, round a bay): the water across it is no carry
  const shift = (pts, dx) => pts.map((q) => ({ x: q.x + dx, y: q.y }));
  const away = { land: { x: 45, y: 200 }, rest: { x: 45, y: 215 }, dispersion: { land: shift(pred.dispersion.land, 45), rest: shift(pred.dispersion.rest, 45) } };
  assert.ok(!hazardsInPlay(marks, away, { max: 10 }).some((hz) => hz.kind === 'water'));
  // none for a putt, or without a prediction
  assert.deepEqual(hazardsInPlay(marks, { ...pred, isPutt: true }), []);
  assert.deepEqual(hazardsInPlay(marks, null), []);
});

// ---- the hole being played (holeSurfaces) and the aim in yards (aimWords) ----

// Two holes side by side, 60 m apart, both running north 300 m: A on x = 0, B on x = 60.
const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
function twoHoles() {
  const s = {
    teeA: { kind: 'tee', poly: box(-5, -10, 5, 0) }, teeB: { kind: 'tee', poly: box(55, -10, 65, 0) },
    greenA: { kind: 'green', poly: box(-12, 290, 12, 312) }, greenB: { kind: 'green', poly: box(48, 290, 72, 312) },
    shared: { kind: 'fairway', poly: box(-15, 100, 75, 250) },      // one outline across both fairways
    fairwayB: { kind: 'fairway', poly: box(45, 60, 75, 280) },
    bunkerA: { kind: 'bunker', poly: box(17, 215, 23, 225) }, bunkerB: { kind: 'bunker', poly: box(42, 215, 48, 225) },
    lakeFar: { kind: 'water', poly: box(-20, 390, 20, 430) },
    range: { kind: 'range', poly: box(-30, -60, 30, -20) },
  };
  const geo = { surfaces: Object.values(s) };
  const lineA = [[0, 0], [0, 300]], lineB = [[60, 0], [60, 300]];
  return { s, geo, lineA, lineB };
}

test('the map focus: this hole\'s tee, green, fairway and hazards, never the neighbour\'s', () => {
  const { s, geo, lineA, lineB } = twoHoles();
  const mine = holeSurfaces(geo, { ball: { x: 0, y: -5 }, pin: [0, 300], line: lineA, others: [lineB] });
  const names = Object.entries(s).filter(([, su]) => mine.has(su)).map(([k]) => k).sort();
  assert.deepEqual(names, ['bunkerA', 'greenA', 'shared', 'teeA']);
  const theirs = holeSurfaces(geo, { ball: { x: 60, y: -5 }, pin: [60, 300], line: lineB, others: [lineA] });
  assert.ok(theirs.has(s.teeB) && theirs.has(s.greenB) && theirs.has(s.fairwayB) && theirs.has(s.bunkerB));
  assert.ok(!theirs.has(s.teeA) && !theirs.has(s.greenA) && !theirs.has(s.bunkerA));
});

test('the map focus in practice: whatever is near the ball-to-flag line', () => {
  const { s, geo } = twoHoles();
  const mine = holeSurfaces(geo, { ball: { x: 0, y: -5 }, pin: [0, 300] });
  assert.ok(mine.has(s.teeA) && mine.has(s.greenA) && mine.has(s.bunkerA));
  assert.ok(!mine.has(s.range) && !mine.has(s.lakeFar) && !mine.has(s.greenB));
});

test('an aim in yards off the pin at the distance played', () => {
  assert.deepEqual(aimWords(0, 250), { yd: 0, side: '', text: 'On the pin' });
  assert.equal(aimWords(1.5, 268).text, '7 yd R');
  assert.equal(aimWords(-1.5, 268).text, '7 yd L');
  assert.equal(aimWords(0.2, 100).text, 'On the pin');   // well under a yard
});

test('the sea, which no polygon outlines: its carry across the line, then its shore alongside', () => {
  const near = (a, b, tol = 2) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
  // playing north; an inlet of the sea across the line from 120 to 180 m, and the open
  // sea west of x = -30 m beside the hole from 220 m on
  const sea = (x, y) => (y >= 120 && y <= 180 && x < 60) || (y >= 220 && x < -30);
  const list = hazardsAlong({ surfaces: [] }, { x: 0, y: 0 }, 0, { maxM: 400, sea });
  const carry = list.find((h) => h.onLine);
  assert.equal(carry.kind, 'water');
  near(carry.frontYd * YD, 120); near(carry.backYd * YD, 180);
  const beside = list.find((h) => !h.onLine);
  assert.equal(beside.kind, 'water');
  assert.ok(beside.uMax < 0, 'on the left');
  near(beside.frontYd * YD, 220, 4); near(beside.backYd * YD, 400, 4);
  // played into it, the line goes on over the sea: open-ended
  const out = hazardsAlong({ surfaces: [] }, { x: 0, y: 250 }, 270, { maxM: 150, sea });
  assert.equal(out[0].onLine, true);
  assert.equal(out[0].open, true);
  near(out[0].frontYd * YD, 30, 3);
  // and no sea, no marks
  assert.deepEqual(hazardsAlong({ surfaces: [] }, { x: 0, y: 0 }, 0, { maxM: 400 }), []);
  // the marks of a lie carry it through
  const marks = yardageMarks({ surfaces: [] }, { ball: { x: 0, y: 0 }, pin: [0, 380], baseAimDeg: 0, sea });
  assert.ok(marks.hazards.some((h) => h.onLine && Math.abs(h.frontYd * YD - 120) <= 2));
});
