import test from 'node:test';
import assert from 'node:assert/strict';
import { shotPlan, planClubs, playPath, pointOut, layupSpot, PLAN } from '../public/shot-plan.mjs';

const YD = 0.9144;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const CARRIES = [
  { club: 'DR', totalYd: 262 }, { club: 'W3', totalYd: 235 }, { club: 'I7', totalYd: 164 },
  { club: 'PW', totalYd: 123 }, { club: 'SW', totalYd: 102 },
];
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

test('the clubs a plan uses: the longest but the driver, and a full pitching wedge', () => {
  assert.deepEqual(planClubs(CARRIES), { reachYd: 235, leaveYd: 123 });
  assert.deepEqual(planClubs(null), { reachYd: PLAN.reachYd, leaveYd: PLAN.leaveYd });
  assert.equal(planClubs([{ club: 'H3', totalYd: 220 }]).reachYd, 220, 'no 3 wood: the hybrid');
});

test('a par 3: the target and the pin, no lay-up', () => {
  const p = shotPlan({ ball: { x: 0, y: 0 }, pin: [0, 160], par: 3, rest: { x: 4, y: 140 }, carries: CARRIES });
  assert.equal(p.targets.length, 1);
  assert.equal(p.targets[0].kind, 'shot');
  assert.equal(p.legs.length, 2);
  assert.ok(near(p.legs[1].yd, Math.hypot(4, 20) / YD, 0.01));
});

test('a par 4 in reach from the drive: two legs, the second to the pin', () => {
  const p = shotPlan({ ball: { x: 0, y: 0 }, pin: [0, 400], par: 4, rest: { x: 0, y: 250 }, carries: CARRIES });
  assert.equal(p.targets.length, 1);
  assert.deepEqual(p.legs.map((l) => Math.round(l.yd)), [273, 164]);
});

test('a par 5 out of reach: a lay-up down the line that leaves a full wedge', () => {
  const p = shotPlan({ ball: { x: 0, y: 0 }, pin: [0, 500], par: 5, rest: { x: 0, y: 240 }, carries: CARRIES });
  assert.equal(p.targets.length, 2);
  const lay = p.targets[1];
  assert.equal(lay.kind, 'layup');
  assert.ok(near(lay.x, 0, 1e-6));
  // 284 yd left: lay up 161 (within the 3 wood's 235) to leave the 123 yd pitching wedge
  assert.deepEqual(p.legs.map((l) => Math.round(l.yd)), [262, 161, 123]);
});

test('too far even for a lay-up to a wedge: the lay-up goes as far as the 3 wood', () => {
  const p = shotPlan({ ball: { x: 0, y: 0 }, pin: [0, 650], par: 5, rest: { x: 0, y: 200 }, carries: CARRIES });
  assert.equal(Math.round(p.legs[1].yd), 235);
  assert.ok(p.legs[2].yd > 123);
});

test('the lay-up follows a dogleg', () => {
  // the hole runs north 300 m, then turns north-east to the green
  const line = [[0, 0], [0, 300], [200, 500]];
  const p = shotPlan({ ball: { x: 0, y: 0 }, pin: [200, 500], par: 5, rest: { x: 0, y: 240 }, carries: CARRIES, line });
  const lay = p.targets[1];
  assert.ok(lay.x > 10 && lay.y > 300, `round the corner: ${lay.x.toFixed(1)}, ${lay.y.toFixed(1)}`);
  assert.ok(near(lay.y - lay.x, 300, 0.5), 'on the line of play');
  assert.ok(near(Math.hypot(lay.x, lay.y - 240) / YD, p.legs[1].yd, 0.01));
});

test('the lay-up moves onto the fairway beside the line, and backs off sand', () => {
  const pin = [0, 500];
  // the fairway beside the line where the lay-up lands; a bunker across the line further on
  const geo = {
    surfaces: [
      { kind: 'green', poly: rect(-15, 485, 15, 515) },
      { kind: 'fairway', poly: rect(6, 340, 30, 420) },
    ],
  };
  const lay = layupSpot({ from: { x: 0, y: 240 }, pin: { x: 0, y: 500 }, distM: 147, line: [[0, 0], [0, 500]], geo });
  assert.ok(lay.x >= 6 && lay.x <= 30, `on the fairway: x ${lay.x}`);
  assert.ok(near(lay.y, 387, 1));
  const sand = { surfaces: [...geo.surfaces, { kind: 'bunker', poly: rect(-20, 380, 40, 392) }] };
  const off = layupSpot({ from: { x: 0, y: 240 }, pin: { x: 0, y: 500 }, distM: 147, line: [[0, 0], [0, 500]], geo: sand });
  assert.ok(off.y < 380, `short of the bunker: y ${off.y.toFixed(1)}`);
  assert.ok(off.y >= 387 - PLAN.maxBackM);
  void pin;
});

test('a lay-up the player dragged runs the plan; one that no longer fits gives way', () => {
  const base = { ball: { x: 0, y: 0 }, pin: [0, 500], par: 5, rest: { x: 0, y: 240 }, carries: CARRIES };
  const mine = shotPlan({ ...base, layup: { x: 12, y: 360 } });
  assert.equal(mine.targets[1].manual, true);
  assert.ok(near(mine.legs[1].yd, Math.hypot(12, 120) / YD, 0.01));
  // behind the shot, or past the pin: back to the planned lay-up
  for (const layup of [{ x: 0, y: 150 }, { x: 0, y: 520 }]) {
    const p = shotPlan({ ...base, layup });
    assert.equal(p.targets[1].manual, undefined);
    assert.equal(p.targets[1].kind, 'layup');
  }
});

test('a shot that stops by the pin leaves no last leg', () => {
  const p = shotPlan({ ball: { x: 0, y: 0 }, pin: [0, 380], par: 4, rest: { x: 0, y: 372 }, carries: CARRIES });
  assert.equal(p.legs.length, 1);
});

test('the line of play from a point, and where it leaves a circle', () => {
  const path = playPath([[0, 0], [0, 100], [100, 200]], { x: 30, y: 50 }, { x: 100, y: 200 });
  assert.deepEqual(path[0], { x: 0, y: 50 });
  assert.equal(path.length, 3, 'the pin is the line end: not added twice');
  const p = pointOut(path, { x: 0, y: 50 }, 30);
  assert.ok(near(p.x, 0, 1e-9) && near(p.y, 80, 1e-9) && near(p.dy, 1, 1e-9));
  assert.equal(pointOut(path, { x: 0, y: 50 }, 500), null, 'the whole path within reach');
  assert.deepEqual(playPath(null, { x: 1, y: 2 }, { x: 3, y: 4 }), [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
});
