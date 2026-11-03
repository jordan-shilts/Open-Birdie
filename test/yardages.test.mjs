import test from 'node:test';
import assert from 'node:assert/strict';
import { greenFor, greenFrontBack, hazardsAlong, hazardText, yardageMarks, pointInPoly } from '../public/yardages.mjs';

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

test('lakes from the scenery layer are drawn, not played: no marks', () => {
  assert.deepEqual(hazardsAlong({ sceneryWater: [{ kind: 'water', poly: rect(-50, 20, 50, 300) }] }, { x: 0, y: 0 }, 0), []);
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
