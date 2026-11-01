'use strict';
// Course selection regressions (St Andrews quick pick loaded the "Old Course
// Starter Hut" building: a 3 m boundary made every shot OB, 3 drives = 6 shots).
// All network is stubbed; no request leaves the process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set BEFORE requiring course.js: CACHE_DIR is a load-time const.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-selection-'));
process.env.BIRDIE_DATA_DIR = dataDir;

const { makeSurfaceLookup, boundaryProblem } = require('../lib/course');
const { Game } = require('../lib/game');

// ---------- boundary sanity guard ----------

// The cached bad load (data/courses/osm-way-1428245318.json): the starter hut's
// 7-point outline as the course boundary, holes 1 and 18 only.
const HUT_BOUNDARY = [
  [419.7, -365.98], [422.22, -365.95], [422.26, -368.88], [419.69, -368.91],
  [419.04, -368.43], [419.03, -366.52], [419.7, -365.98],
];
const HUT_HOLES = [
  { ref: 1, par: 4, tee: [414.58, -389.06], pin: [81.67, -364.61], lengthYd: 365,
    line: [[414.58, -389.06], [200, -380], [81.67, -364.61]] },
  { ref: 18, par: 4, tee: [61.18, -410.32], pin: [395.22, -437.97], lengthYd: 367,
    line: [[61.18, -410.32], [395.22, -437.97]] },
];
const hutCourse = () => ({
  name: 'Old Course Starter Hut', surfaces: [], elevation: null,
  boundary: HUT_BOUNDARY.map((p) => [...p]), holes: structuredClone(HUT_HOLES),
});

test('a 3 m starter-hut boundary is rejected and never makes a shot OB', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.match(boundaryProblem(hutCourse()), /too small/);
  const at = makeSurfaceLookup(hutCourse());
  for (const h of HUT_HOLES) {
    assert.equal(at(h.tee[0], h.tee[1]), 'rough');
    assert.equal(at(h.pin[0], h.pin[1]), 'rough');
  }
  assert.equal(at(250, -200), 'rough');
});

test('replay of the bug: three drives on the hut course cost no penalty strokes', (t) => {
  t.mock.method(console, 'warn', () => {});
  const g = new Game();
  g.setCourse(hutCourse());
  // Aim well right of the pin so no drive can finish the hole early.
  const drive = { Speed: 150, VLA: 12, HLA: 20, TotalSpin: 2600, SpinAxis: 0 };
  for (let i = 1; i <= 3; i++) {
    const r = g.handleShot(drive, 'DR');
    assert.ok(r, `drive ${i} resolves`);
    assert.equal(r.penalty, 0, `drive ${i}: ${r.note}`);
    assert.notEqual(r.lie, 'ob');
  }
  assert.equal(g.holed, false);
  assert.equal(g.strokes, 3, 'before the fix: 6 (every drive +1 OB)');
});

const square = (half) => [[-half, -half], [half, -half], [half, half], [-half, half]];
const plainCourse = (boundary) => ({
  name: 'Square Links', surfaces: [], elevation: null, boundary,
  holes: [{ ref: 1, par: 4, tee: [0, -150], pin: [0, 150], lengthYd: 330, line: [[0, -150], [0, 150]] }],
});

test('a plausible course boundary still defines OB, with the 15 m buffer', () => {
  const course = plainCourse(square(300));
  assert.equal(boundaryProblem(course), null);
  const at = makeSurfaceLookup(course);
  assert.equal(at(0, 0), 'rough');
  assert.equal(at(310, 0), 'rough', 'near miss inside the buffer stays in play');
  assert.equal(at(400, 0), 'ob');
});

test('a boundary that leaves out a tee or pin, or is degenerate, is not used for OB', (t) => {
  t.mock.method(console, 'warn', () => {});
  // e.g. a neighbouring course's outline: big enough, but this hole's tee is outside it
  const shifted = square(300).map(([x, y]) => [x, y + 400]);
  assert.match(boundaryProblem(plainCourse(shifted)), /tee/);
  assert.equal(makeSurfaceLookup(plainCourse(shifted))(0, -150), 'rough');
  assert.match(boundaryProblem(plainCourse(square(300).map(([x, y]) => [x, y - 400]))), /pin/);
  assert.equal(boundaryProblem(plainCourse([[0, 0], [10, 10]])), 'not a polygon');
  assert.equal(boundaryProblem(plainCourse(null)), null, 'no boundary is simply no OB');
});
