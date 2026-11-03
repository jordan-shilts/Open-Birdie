'use strict';
// Playing conditions (lib/conditions.js) and how the ball plays them (lib/physics.js):
// air density normalised to the flight model's 1.225, wind by the compass, gusts
// seeded by the shot, firmness and green speed on the ground — and standard
// conditions that leave the physics exactly as it was before conditions existed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { simulateShot, YD, MPH } = require('../lib/physics');
const { Game, CLUB_FULL, clubKey } = require('../lib/game');
const C = require('../lib/conditions');

const fairway = () => 'fairway';
const green = () => 'green';
const preset = (k, extra = {}) => ({ speedMph: CLUB_FULL[k].speedMph, vla: CLUB_FULL[k].vla, hla: 0, totalSpin: CLUB_FULL[k].spin, spinAxis: 0, ...extra });
const DRIVER = preset('DR');
const fly = (launch, opts, surf = fairway, aim = 0) => simulateShot(launch, { x: 0, y: 0 }, aim, surf, opts);
const roll = (r) => r.totalYd - r.carryYd;

function course() {
  return {
    name: 'Conditions Course', surfaces: [], boundary: null, elevation: null,
    holes: [{ ref: 1, par: 4, tee: [0, 0], pin: [0, 400], lengthYd: 437, line: [[0, 0], [0, 400]] }],
  };
}

test('standard conditions: air density exactly 1.225 and physics options that change nothing', () => {
  assert.equal(C.airDensity(C.DEFAULTS), 1.225);
  assert.deepEqual(C.conditionsState(C.DEFAULTS), { ...C.DEFAULTS, presetId: 'calm', airDensity: 1.225 });
  const std = C.physicsOptions(C.DEFAULTS);
  assert.deepEqual(std, { wind: null, airDensity: 1.225, firmness: 0.5, greenStimp: 10.5 });
  const shots = [
    [DRIVER, fairway], [preset('I7', { hla: -2, spinAxis: -7 }), fairway], [preset('PW'), green], [preset('SW'), green],
    [{ speedMph: 6, vla: 0, hla: 0, totalSpin: 0, spinAxis: 0 }, green],
  ];
  for (const [launch, surf] of shots) {
    const plain = fly(launch, {}, surf);
    assert.deepEqual(fly(launch, std, surf), plain);
    assert.deepEqual(fly(launch, C.physicsOptions(C.DEFAULTS, { gust: true }), surf), plain);
  }
});

test('presets are valid conditions, match themselves, and are what they say', () => {
  const ids = C.PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ['calm', 'breezy', 'windy', 'gale', 'hot', 'cold', 'mile-high', 'links']);
  for (const p of C.PRESETS) {
    assert.ok(p.label && p.description, p.id);
    assert.deepEqual(C.normalizeConditions(p.values), { ...p.values }, `${p.id} values are already valid`);
    assert.equal(C.matchPreset(p.values), p.id);
    assert.equal(C.conditionsState(p.values).presetId, p.id);
  }
  const v = Object.fromEntries(C.PRESETS.map((p) => [p.id, p.values]));
  assert.deepEqual(v.calm, C.DEFAULTS);
  assert.equal(v.breezy.windMph, 8);
  assert.equal(v.windy.windMph, 16);
  assert.deepEqual([v.gale.windMph, v.gale.gustMph, v.gale.firmness], [25, 8, 0.8]);
  assert.deepEqual([v.hot.tempF, v.hot.firmness], [95, 0.7]);
  assert.deepEqual([v.cold.tempF, v.cold.firmness], [45, 0.3]);
  assert.equal(v['mile-high'].altitudeFt, 5280);
  assert.deepEqual([v.links.windMph, v.links.tempF, v.links.firmness, v.links.greenStimp], [18, 60, 1, 9.5]);
});

test('conditions are validated, clamped and rounded; unknown fields and bad values are ignored', () => {
  const c = C.normalizeConditions({
    windMph: 99, windFromDeg: -90, gustMph: -3, tempF: 'hot', altitudeFt: '1500.4', humidity: 150,
    firmness: 2, greenStimp: 3, bogus: 1,
  });
  assert.deepEqual(c, { windMph: 40, windFromDeg: 270, gustMph: 0, tempF: 70, altitudeFt: 1500, humidity: 100, firmness: 1, greenStimp: 7 });
  assert.equal(C.normalizeConditions({ windFromDeg: 360 }).windFromDeg, 0);
  assert.equal(C.normalizeConditions({ windFromDeg: 725.2 }).windFromDeg, 5);
  assert.equal(C.normalizeConditions({ windMph: 12.345, firmness: 0.555 }).windMph, 12.3);
  assert.equal(C.normalizeConditions({ firmness: 0.555 }).firmness, 0.56);
  assert.deepEqual(C.normalizeConditions({ windMph: null, tempF: NaN, humidity: '' }), C.DEFAULTS);
  // presets, a preset with changes on top, and a change to what is there
  const windy = C.PRESETS.find((p) => p.id === 'windy').values;
  assert.deepEqual(C.resolveConditions('windy'), windy);
  assert.deepEqual(C.resolveConditions({ preset: 'WINDY', windFromDeg: 90 }), { ...windy, windFromDeg: 90 });
  assert.deepEqual(C.resolveConditions({ tempF: 50 }, windy), { ...windy, tempF: 50 });
  assert.equal(C.conditionsState(C.resolveConditions({ tempF: 50 }, windy)).presetId, null);
  assert.throws(() => C.resolveConditions('tornado'), (e) => e.code === 'UNKNOWN_PRESET');
});

test('the air: thinner air (altitude, heat, humidity) carries farther, denser air shorter', () => {
  const rho = (c) => C.airDensity({ ...C.DEFAULTS, ...c });
  assert.ok(rho({ altitudeFt: 5280 }) < rho({ tempF: 95 }));
  assert.ok(rho({ tempF: 95 }) < 1.225 && rho({ tempF: 45 }) > 1.225);
  assert.ok(rho({ tempF: 90, humidity: 100 }) < rho({ tempF: 90, humidity: 0 }), 'humid air is lighter');
  assert.ok(Math.abs(rho({ altitudeFt: 5280 }) / 1.225 - 0.82) < 0.02, `mile high is ~18 % thinner, got ${rho({ altitudeFt: 5280 })}`);
  const carry = (c) => fly(DRIVER, C.physicsOptions({ ...C.DEFAULTS, ...c })).carryYd;
  const sea = carry({});
  assert.ok(carry({ altitudeFt: 5280 }) > sea + 8, `mile high ${carry({ altitudeFt: 5280 }).toFixed(1)} vs ${sea.toFixed(1)}`);
  assert.ok(carry({ tempF: 95 }) > sea && carry({ tempF: 45 }) < sea);
});

test('wind by the compass: headwind shortens, tailwind lengthens, wind from the left pushes right', () => {
  const wind = (windFromDeg, aim = 0) => fly(DRIVER, C.physicsOptions({ windMph: 15, windFromDeg }), fairway, aim);
  const calm = fly(DRIVER, {});
  // aiming north (0 deg): from 0 is in the face, from 180 behind, from 270 (west) from the left
  assert.ok(wind(0).carryYd < calm.carryYd - 10, `headwind ${wind(0).carryYd.toFixed(1)} vs ${calm.carryYd.toFixed(1)}`);
  assert.ok(wind(180).carryYd > calm.carryYd + 8, `tailwind ${wind(180).carryYd.toFixed(1)}`);
  assert.ok(wind(270).land.x / YD > 10, `from the left lands right, got ${(wind(270).land.x / YD).toFixed(1)} yd`);
  assert.ok(wind(270).offlineYd > 10 && wind(90).offlineYd < -10);
  // aiming east (90 deg): a north wind comes from the left and pushes the ball south (right)
  const east = wind(0, 90);
  assert.ok(east.land.y < -10 && east.offlineYd > 10, `east shot in a north wind: y ${east.land.y.toFixed(1)}`);
  assert.ok(Math.abs(east.windMps - 15 * MPH) < 1e-12 && east.gustMps === 0);
});

test('gusts: every shot meets its own gust, the same swing the same gust; predictions are steady', () => {
  const gusty = C.physicsOptions({ windMph: 10, windFromDeg: 0, gustMph: 8 }, { gust: true });
  const a = fly(DRIVER, gusty);
  assert.deepEqual(fly(DRIVER, gusty), a);
  const gusts = new Set();
  for (let k = 0; k < 12; k++) {
    const r = fly({ ...DRIVER, hla: k * 0.1 }, gusty);
    assert.ok(Math.abs(r.gustMps) <= 8 * MPH + 1e-9);
    assert.ok(Math.abs(r.windMps - (10 * MPH + r.gustMps)) < 1e-9);
    gusts.add(r.gustMps.toFixed(4));
  }
  assert.ok(gusts.size >= 8, `${gusts.size} distinct gusts`);
  const steady = fly(DRIVER, C.physicsOptions({ windMph: 10, windFromDeg: 0, gustMph: 8 }));
  assert.equal(steady.gustMps, 0);
  assert.equal(steady.windMps, 10 * MPH);
});

test('firmness: firm ground runs (+30-40 % for a driver), soft ground stops (about -40 %), carry untouched', () => {
  const at = (firmness) => fly(DRIVER, { firmness });
  const rolls = [0, 0.25, 0.5, 0.75, 1].map((f) => roll(at(f)));
  for (let i = 1; i < rolls.length; i++) assert.ok(rolls[i] > rolls[i - 1], `roll rises with firmness: ${rolls.map((r) => r.toFixed(1))}`);
  const firm = rolls[4] / rolls[2], soft = rolls[0] / rolls[2];
  assert.ok(firm >= 1.25 && firm <= 1.45, `firm x${firm.toFixed(2)}`);
  assert.ok(soft >= 0.5 && soft <= 0.7, `soft x${soft.toFixed(2)}`);
  for (const f of [0, 1]) assert.equal(at(f).carryYd, at(0.5).carryYd);
  // a wedge that zips back on a soft green checks dead on a firm one
  const wedge = (firmness) => roll(fly(preset('SW'), { firmness }, green));
  assert.ok(wedge(0) < wedge(0.5) && wedge(0.5) < 0 && wedge(1) > wedge(0.5), `${wedge(0)} / ${wedge(0.5)} / ${wedge(1)}`);
});

test('green speed: a putt rolls in proportion to the Stimpmeter, the fairway does not care', () => {
  const putt = (greenStimp) => fly({ speedMph: 5, vla: 0, hla: 0, totalSpin: 0, spinAxis: 0 }, { greenStimp }, green).totalYd;
  assert.ok(putt(8) < putt(10.5) && putt(10.5) < putt(13));
  assert.ok(Math.abs(putt(13) / putt(10.5) - 13 / 10.5) < 0.03, `x${(putt(13) / putt(10.5)).toFixed(3)}`);
  assert.deepEqual(fly(DRIVER, { greenStimp: 13 }), fly(DRIVER, { greenStimp: 8 }));
});

test('the game plays every shot in its conditions and shows them in its state', () => {
  const g = new Game();
  assert.deepEqual(g.state(), { loaded: false, conditions: { ...C.DEFAULTS, presetId: 'calm', airDensity: 1.225 }, selectedClub: null });
  g.setCourse(course());
  assert.equal(g.state().conditions.presetId, 'calm');
  const ball = { Speed: 150, VLA: 12, HLA: 0, TotalSpin: 2600, SpinAxis: 0 };
  const calm = g.handleShot(ball);
  assert.deepEqual(calm.wind, { speedMph: 0, fromDeg: 0, gustMph: 0 });

  const state = g.setConditions('windy');
  assert.equal(state.presetId, 'windy');
  g.setCourse(course());   // conditions belong to the day: a new course keeps them
  assert.equal(g.state().conditions.presetId, 'windy');
  const windy = g.handleShot(ball);
  assert.deepEqual(windy.wind, { speedMph: 16, fromDeg: 270, gustMph: 0 });
  assert.ok(windy.sim.offlineYd > calm.sim.offlineYd + 10, 'a west wind pushes a north shot right');
  assert.equal(g.setConditions({ windMph: 3 }).presetId, null);
  assert.throws(() => g.setConditions('tornado'), /Unknown conditions preset/);

  // practice plays in them too
  g.setConditions('gale');
  g.startPractice('range');
  const r = g.handleShot(ball, 'DR');
  assert.ok(r.practice && r.wind.speedMph > 0 && Math.abs(r.wind.gustMph) <= 8);
  assert.equal(g.state().conditions.presetId, 'gale');
});

test('club names from the UI and launch monitors become club keys; the pick is remembered', () => {
  const cases = {
    DR: ['DR', 'DRIVER', 'Driver', '1W', 'W1', 'd'],
    W3: ['W3', '3W', 'WOOD3', '3 Wood', 'FW3', 'W2', '4W'],
    H3: ['H3', '3H', 'HYBRID3', 'U3', '3 Hybrid', 'W5', '5 Wood', '7W', '3i', 'IRON2', 'H2'],
    I4: ['I4', '4i', 'IRON4', 'H4', '4 Hybrid'],
    I7: ['I7', '7i', '7I', 'IRON7', '7 Iron', '7-iron'],
    I9: ['I9', '9i', 'IRON9'],
    PW: ['PW', 'Pitching Wedge', 'GW', 'AW', 'Gap Wedge', '48', '50°'],
    SW: ['SW', 'SAND WEDGE', '52', '56°', 'W54'],
    LW: ['LW', 'Lob Wedge', '58', '60 deg'],
    PT: ['PT', 'PUTTER', 'Putter'],
  };
  for (const [key, names] of Object.entries(cases)) for (const n of names) assert.equal(clubKey(n), key, n);
  for (const n of [null, undefined, '', 'BANANA', 'I12', 'W30', '9']) assert.equal(clubKey(n), null, String(n));

  const g = new Game();
  g.setCourse(course());
  assert.equal(g.setSelectedClub('7i'), 'I7');
  assert.equal(g.setSelectedClub('nonsense'), 'I7', 'an unknown name keeps the pick');
  assert.equal(g.state().selectedClub, 'I7');
  const ball = { Speed: 110, VLA: 19, HLA: 0, TotalSpin: 7000, SpinAxis: 0 };
  assert.equal(g.handleShot(ball).clubKey, 'I7', 'no monitor club: the pick');
  assert.equal(g.handleShot(ball, 'IRON8').clubKey, 'I8', "the monitor's club wins");
  assert.equal(g.handleShot(ball, 'BANANA').clubKey, null, 'an unknown monitor club is not guessed');
});

test('conditions.json: saved and loaded; a missing or bad file is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-conditions-'));
  const file = path.join(dir, 'conditions.json');
  const warnings = [];
  const log = { warn: (m) => warnings.push(m) };
  assert.equal(C.loadConditionsFile(file, log), null);
  assert.equal(warnings.length, 0, 'a missing file is not a problem');
  const links = C.resolveConditions('links');
  C.saveConditionsFile(file, links);
  assert.deepEqual(C.loadConditionsFile(file, log), links);
  fs.writeFileSync(file, '{"conditions": {"windMph": 12, "windFromDeg": 400, "nope": true}}');
  assert.deepEqual(C.loadConditionsFile(file, log), { ...C.DEFAULTS, windMph: 12, windFromDeg: 40 });
  fs.writeFileSync(file, '{not json');
  assert.equal(C.loadConditionsFile(file, log), null);
  fs.writeFileSync(file, '[1, 2]');
  assert.equal(C.loadConditionsFile(file, log), null);
  assert.equal(warnings.length, 2);
});
