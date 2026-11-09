// Landing effects (public/render/impact-fx.js): when each one fires and how hard, from
// the server's shot events. The particles themselves need a GPU; this is the pure part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impactSchedule, IMPACT_MIN_TURF_MPS } from '../public/render/impact-fx.js';

// a ball falling at `down` m/s and moving north at `fwd` m/s, landing at (0, landY) at t = landT,
// then (optionally) hopping on
function flight({ landT = 4, landY = 100, down = 14, fwd = 20, after = [] } = {}) {
  const pts = [];
  for (let t = 0; t <= landT + 1e-9; t += 0.02) {
    const back = landT - t;
    pts.push({ t: +t.toFixed(3), x: 0, y: landY - fwd * back, z: down * back });
  }
  let t = landT, y = landY;
  for (const hop of after) {   // { dur, fwd, down }: a hop that comes down at `down` m/s
    for (let k = 1; k <= Math.round(hop.dur / 0.02); k++) {
      const u = k * 0.02;
      const left = hop.dur - u;
      pts.push({ t: +(t + u).toFixed(3), x: 0, y: y + hop.fwd * u, z: Math.max(0, Math.min(u, left) * hop.down) });
    }
    t += hop.dur; y += hop.fwd * hop.dur;
  }
  return pts;
}

test('a ball into water splashes at the end of its carry, harder the faster it arrives', () => {
  const pts = flight({ landT: 4, landY: 100, down: 14, fwd: 20 });
  const [s] = impactSchedule(pts, [{ type: 'water', x: 0, y: 100 }], 4);
  assert.equal(s.kind, 'water');
  assert.equal(s.t, 4);
  assert.ok(s.power > 0.8 && s.power <= 1, `a full shot is a big splash (${s.power})`);
  assert.ok(Math.abs(s.dirY - 1) < 1e-6 && Math.abs(s.dirX) < 1e-6, 'it remembers which way the ball was going');
  const slow = impactSchedule(flight({ down: 1, fwd: 2 }), [{ type: 'water', x: 0, y: 100 }], 4)[0];
  assert.ok(slow.power >= 0.3 && slow.power < s.power, 'a ball that dribbles in still plops');
});

test('a bunker throws sand; a green throws nothing', () => {
  const pts = flight();
  assert.equal(impactSchedule(pts, [{ type: 'bounce', x: 0, y: 100, surface: 'bunker' }], 4)[0].kind, 'sand');
  assert.deepEqual(impactSchedule(pts, [{ type: 'bounce', x: 0, y: 100, surface: 'green' }], 4), []);
});

test('grass throws turf only for a real landing, not for the hops and the roll after it', () => {
  const pts = flight({ down: 14, after: [{ dur: 0.6, fwd: 8, down: 9 }, { dur: 0.3, fwd: 6, down: 2 }] });
  const events = [
    { type: 'bounce', x: 0, y: 100, surface: 'fairway' },
    { type: 'bounce', x: 0, y: 104.8, surface: 'fairway' },
    { type: 'bounce', x: 0, y: 106.6, surface: 'rough' },
  ];
  const s = impactSchedule(pts, events, 4);
  assert.deepEqual(s.map((e) => e.kind), ['turf', 'turf']);
  assert.ok(s[0].power > s[1].power, 'the landing hits harder than the first hop');
  assert.ok(s[1].t > s[0].t + 0.4, 'each is timed where the ball is, in order');
  assert.ok(IMPACT_MIN_TURF_MPS > 2, 'the last 2 m/s hop is under the bar');
});

test('surfaces the scene has no special case for count as grass', () => {
  const s = impactSchedule(flight(), [{ type: 'bounce', x: 0, y: 100, surface: 'path' }], 4);
  assert.equal(s[0].kind, 'turf');
});

test('a tree crown sheds leaves at the height of the hit; a trunk sheds none', () => {
  const pts = flight();
  const s = impactSchedule(pts, [
    { type: 'tree', t: 2, x: 0, y: 60, z: 28, part: 'crown' },
    { type: 'tree', t: 2.5, x: 0, y: 70, z: 5, part: 'trunk' },
  ], 4);
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].kind, s[0].t, s[0].z], ['leaves', 2, 28]);
});

test('a ball that spins back over its pitch mark matches the first pass, not the second', () => {
  // lands at y = 100, hops to 103, then rolls back through 100 to 98
  const pts = flight({ landT: 4, landY: 100, down: 15, fwd: 10 });
  for (let k = 1; k <= 25; k++) pts.push({ t: +(4 + k * 0.02).toFixed(3), x: 0, y: 100 + 0.12 * k, z: 0 });
  for (let k = 1; k <= 100; k++) pts.push({ t: +(4.5 + k * 0.02).toFixed(3), x: 0, y: 103 - 0.05 * k, z: 0 });
  const [s] = impactSchedule(pts, [{ type: 'bounce', x: 0, y: 100, surface: 'bunker' }], 4);
  assert.equal(s.t, 4);
});

test('putts, missing events and broken ones give no effects and no errors', () => {
  const pts = flight();
  assert.deepEqual(impactSchedule(pts, [{ type: 'water', x: 0, y: 100 }], 4, { isPutt: true }), []);
  assert.deepEqual(impactSchedule(pts, undefined, 4), []);
  assert.deepEqual(impactSchedule([], [{ type: 'water', x: 0, y: 0 }], 4), []);
  assert.deepEqual(impactSchedule(pts, [null, { type: 'water' }, { type: 'bounce', x: NaN, y: 1, surface: 'bunker' }, { type: 'holed', x: 0, y: 100 }], 4), []);
});
