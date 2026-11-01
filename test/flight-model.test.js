'use strict';
// Flight-model parity with OpenFlight, the launch monitor that feeds us shots:
// the carry it shows must be where the ball lands here. lib/physics.js ports
// OpenFlight's src/openflight/ballistics.py air phase (Ferguson, McNally &
// McPhee 2022 Cd/Cl polynomials, 4%/s spin decay, RK4 at 500 Hz). If either
// side changes its model, these fail instead of the two apps drifting apart.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { simulateShot, YD } = require('../lib/physics');

const CARRY_TOL_YD = 1;
const APEX_TOL_FT = 2;

// OpenFlight simulate() outputs on flat ground (hla 0, spin axis 0, air
// density 1.225): [label, ball mph, VLA deg, spin rpm, carry yd, apex ft].
const OPENFLIGHT = [
  ['Driver (tour)', 167, 10.9, 2686, 278.8, 101.1],
  ['3-wood (tour)', 158, 9.2, 3655, 249.2, 90.2],
  ['5-iron (tour)', 132, 12.1, 5361, 190.8, 85.6],
  ['7-iron (tour)', 120, 16.3, 7097, 163.5, 92.7],
  ['PW (tour)', 102, 24.2, 9304, 132.7, 90.6],
  ['Driver', 155.7, 11.8, 2500, 257.1, 88.1],
  ['Driver', 145.6, 10.0, 2549, 226.6, 61.4],
  ['Driver', 127.6, 13.0, 2500, 193.9, 58.6],
  ['PW', 82.1, 30.4, 7895, 100.9, 72.5],
  ['mid iron', 127.3, 17.4, 5000, 186.7, 106.4],
  ['mid iron', 134.9, 16.8, 5953, 191.9, 122.0],
];

const fairway = () => 'fairway';
const DRIVER = { speedMph: 167, vla: 10.9, hla: 0, totalSpin: 2686, spinAxis: 0 };
const fly = (launch, opts) => simulateShot(launch, { x: 0, y: 0 }, 0, fairway, opts);
// aim is north (+y), so the first bounce's x is the lateral at carry, + = right
const carryLateralYd = (r) => r.events.find((e) => e.type === 'bounce').x / YD;

for (const [label, speedMph, vla, totalSpin, ofCarry, ofApex] of OPENFLIGHT) {
  test(`matches OpenFlight: ${label} ${speedMph} mph / ${vla} deg / ${totalSpin} rpm`, () => {
    const r = fly({ speedMph, vla, hla: 0, totalSpin, spinAxis: 0 });
    assert.ok(Math.abs(r.carryYd - ofCarry) <= CARRY_TOL_YD,
      `carry ${r.carryYd.toFixed(2)} yd vs OpenFlight ${ofCarry} (±${CARRY_TOL_YD})`);
    assert.ok(Math.abs(r.apexFt - ofApex) <= APEX_TOL_FT,
      `apex ${r.apexFt.toFixed(2)} ft vs OpenFlight ${ofApex} (±${APEX_TOL_FT})`);
  });
}

test('spin axis -12 curves left, +12 curves right, by OpenFlight\'s amount', () => {
  const draw = carryLateralYd(fly({ ...DRIVER, spinAxis: -12 }));
  const fade = carryLateralYd(fly({ ...DRIVER, spinAxis: 12 }));
  // OpenFlight simulate(): lateral -24.9 / +24.9 yd at carry for this shot
  assert.ok(Math.abs(draw - -24.9) <= CARRY_TOL_YD, `draw lateral ${draw.toFixed(2)} yd, want ~-24.9 (left)`);
  assert.ok(Math.abs(fade - 24.9) <= CARRY_TOL_YD, `fade lateral ${fade.toFixed(2)} yd, want ~+24.9 (right)`);
});

test('wind: headwind shortens, tailwind lengthens, crosswind pushes downwind', () => {
  const calm = fly(DRIVER);
  const head = fly(DRIVER, { wind: { speedMps: 5, fromDeg: 0 } });   // from the target
  const tail = fly(DRIVER, { wind: { speedMps: 5, fromDeg: 180 } }); // from behind
  const cross = fly(DRIVER, { wind: { speedMps: 5, fromDeg: 270 } }); // from the left
  assert.ok(head.carryYd < calm.carryYd - 5, `headwind carry ${head.carryYd.toFixed(1)} vs calm ${calm.carryYd.toFixed(1)}`);
  assert.ok(tail.carryYd > calm.carryYd + 5, `tailwind carry ${tail.carryYd.toFixed(1)} vs calm ${calm.carryYd.toFixed(1)}`);
  assert.ok(carryLateralYd(cross) > 5, `left-to-right wind should push right, got ${carryLateralYd(cross).toFixed(1)} yd`);
});
